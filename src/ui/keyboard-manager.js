/**
 * @file keyboard-manager.js
 * @description App-wide keyboard shortcut manager: global keydown handling, shortcut map, and clipboard state.
 * @module ui/keyboard-manager
 * @created 07/23/2026
 * @author Truck Packer 3D Team
 */

// Keyboard manager (extracted from src/app.js; behavior preserved).
// Side-effect-free factory: all collaborators are injected; the single
// document keydown listener is installed only when init() is called.

/** @param {Record<string, any>} deps Injected collaborators; any it does not use are ignored. */
export function createKeyboardManager({
  StateStore,
  PackLibrary,
  CaseLibrary,
  CaseScene,
  SceneManager,
  InteractionManager,
  OperationLifecycle,
  UIComponents,
  Utils,
}) {
  let shortcuts = {};
  const KeyboardManager = (() => {
    let clipboard = null;

    function clearClipboard() {
      clipboard = null;
    }

    function initKeyboardManager() {
      document.addEventListener('keydown', handleKeyDown);
    }

    // A handler returns true when the app owns the key in the current context
    // (it acted, or deliberately consumed it) and false when it does not, leaving
    // the browser/OS default (text Copy, Select All, Bookmark…) untouched.
    function handleKeyDown(event) {
      if (event.defaultPrevented || UIComponents.modalOwnership?.blocksKeyboardEvent(event)) return;
      if (isTypingContext(event)) return;
      const key = buildKeyString(event);
      const interactionSurface = document.getElementById('viewport');
      const spatialKey = ['delete', 'backspace', 'g', 's'].includes(key);
      if (spatialKey && (!inEditor() || event.target !== interactionSurface)) return;
      const handler = shortcuts[key];
      if (!handler) return;
      const handled = handler(event);
      if (handled === false) return;
      event.preventDefault();
    }

    // Text editing keeps its native keys. A checkbox or radio is not a text field:
    // Escape and Undo still reach the app there (Space toggling stays native).
    function isTypingContext(event) {
      const el = event.target;
      if (!el) return false;
      if (el.isContentEditable) return true;
      if (!el.matches || !el.matches('input, textarea, select')) return false;
      const type = String(el.type || '').toLowerCase();
      return !(el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio'));
    }

    function buildKeyString(event) {
      const parts = [];
      if (event.metaKey) parts.push('meta');
      if (event.ctrlKey && !event.metaKey) parts.push('ctrl');
      if (event.shiftKey) parts.push('shift');
      if (event.altKey) parts.push('alt');
      parts.push(String(event.key || '').toLowerCase());
      return parts.join('+');
    }

    function inEditor() {
      return StateStore.get('currentScreen') === 'editor';
    }

    function operationBusy() {
      return Boolean(OperationLifecycle && OperationLifecycle.isBusy());
    }

    // Block pack-mutating keyboard shortcuts while a mutating editor operation
    // (AutoPack / Unpack / Truck Change / preview capture) owns the editor. Returns
    // true (and toasts) when blocked. Read-only shortcuts (copy, select, camera,
    // grid/shadow toggles) are intentionally NOT gated.
    function mutationBlockedWhileBusy() {
      if (OperationLifecycle && OperationLifecycle.isBusy()) {
        UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Editor' });
        return true;
      }
      return false;
    }

    function selectedInstances(pack) {
      const selected = StateStore.get('selectedInstanceIds') || [];
      return selected
        .map(id => (pack.cases || []).find(inst => inst && inst.id === id))
        .filter(Boolean);
    }

    function undo() {
      if (!inEditor()) return false;
      if (mutationBlockedWhileBusy()) return true;
      const ok = StateStore.undo();
      UIComponents.showToast(ok ? 'Undone' : 'Nothing to undo', ok ? 'info' : 'warning', { title: 'Edit' });
      return true;
    }

    function redo() {
      if (!inEditor()) return false;
      if (mutationBlockedWhileBusy()) return true;
      const ok = StateStore.redo();
      UIComponents.showToast(ok ? 'Redone' : 'Nothing to redo', ok ? 'info' : 'warning', { title: 'Edit' });
      return true;
    }

    // Escape clears an Editor selection; with nothing selected (or off-Editor)
    // it stays free for the next Escape owner, such as a mobile drawer.
    function deselectAll() {
      if (!inEditor() || !(StateStore.get('selectedInstanceIds') || []).length) return false;
      StateStore.set({ selectedInstanceIds: [] }, { skipHistory: true });
      CaseScene.setSelected([]);
      return true;
    }

    function selectAll(event) {
      if (!inEditor()) return false;
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      if (!pack || !(pack.cases || []).length) return false;
      if (event.repeat) return true;
      InteractionManager.selectAllInPack();
      return true;
    }

    function deleteSelected() {
      if (!inEditor()) return false;
      InteractionManager.deleteSelection();
      return true;
    }

    // Owned only when it can duplicate: Editor, selected cargo and no mutating
    // operation. Anywhere else Cmd/Ctrl+D stays the browser's Bookmark.
    function duplicateSelected(event) {
      if (!inEditor() || operationBusy()) return false;
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack) return false;

      const source = selectedInstances(pack);
      if (!source.length) return false;
      if (event.repeat) return true;
      const result = PackLibrary.duplicateInstancesSafely(packId, source, CaseLibrary.getCases());
      if (!result || !result.newIds.length) {
        UIComponents.showToast('No collision-free duplicate position found', 'warning', { title: 'Edit' });
        return true;
      }
      StateStore.set({ selectedInstanceIds: result.newIds }, { skipHistory: true });
      CaseScene.setSelected(result.newIds);
      UIComponents.showToast(
        result.placement === 'staged'
          ? `Duplicated ${result.newIds.length} case(s) to staging`
          : `Duplicated ${result.newIds.length} case(s)`,
        'success',
        { title: 'Edit' }
      );
      return true;
    }

    // Owned only with selected cargo; otherwise native text Copy proceeds.
    function copySelected(event) {
      if (!inEditor()) return false;
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      const source = pack ? selectedInstances(pack) : [];
      if (!source.length) return false;
      if (event.repeat) return true;
      clipboard = source.map(i => Utils.deepClone(i));
      UIComponents.showToast(`Copied ${clipboard.length} case(s)`, 'info', { title: 'Clipboard' });
      return true;
    }

    // Owned only with copied cargo to paste; otherwise native Paste proceeds.
    function pasteClipboard(event) {
      if (!inEditor()) return false;
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack || !clipboard || !clipboard.length) return false;
      if (event.repeat) return true;
      if (mutationBlockedWhileBusy()) return true;

      const result = PackLibrary.duplicateInstancesSafely(packId, clipboard, CaseLibrary.getCases());
      if (!result || !result.newIds.length) {
        UIComponents.showToast('No collision-free paste position found', 'warning', { title: 'Clipboard' });
        return true;
      }
      StateStore.set({ selectedInstanceIds: result.newIds }, { skipHistory: true });
      CaseScene.setSelected(result.newIds);
      UIComponents.showToast(
        result.placement === 'staged'
          ? `Pasted ${result.newIds.length} case(s) to staging`
          : `Pasted ${result.newIds.length} case(s)`,
        'success',
        { title: 'Clipboard' }
      );
      return true;
    }

    function toggleGrid(event) {
      if (!inEditor()) return false;
      if (event.repeat) return true;
      const visible = SceneManager.toggleGrid();
      UIComponents.showToast(visible ? 'Grid shown' : 'Grid hidden', 'info', { title: 'View', duration: 1200 });
      return true;
    }

    function toggleShadows(event) {
      if (!inEditor()) return false;
      if (event.repeat) return true;
      const enabled = SceneManager.toggleShadows();
      UIComponents.showToast(enabled ? 'Shadows enabled' : 'Shadows disabled', 'info', {
        title: 'View',
        duration: 1200,
      });
      return true;
    }

    shortcuts = {
      'meta+z': undo,
      'ctrl+z': undo,
      'meta+shift+z': redo,
      'ctrl+shift+z': redo,
      'meta+a': selectAll,
      'ctrl+a': selectAll,
      escape: deselectAll,
      delete: deleteSelected,
      backspace: deleteSelected,
      'meta+d': duplicateSelected,
      'ctrl+d': duplicateSelected,
      'meta+c': copySelected,
      'ctrl+c': copySelected,
      'meta+v': pasteClipboard,
      'ctrl+v': pasteClipboard,
      g: toggleGrid,
      s: toggleShadows,
    };

    return { init: initKeyboardManager, clearClipboard };
  })();

  return KeyboardManager;
}
