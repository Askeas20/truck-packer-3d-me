/**
 * @file ui-components.js
 * @description UI primitives (modal, toast, dropdown) used across the application.
 * @module ui/ui-components
 * @created Unknown
 * @updated 01/22/2026
 * @author Truck Packer 3D Team
 */

// ============================================================================
// SECTION: IMPORTS AND DEPENDENCIES
// ============================================================================

import { createModalFocus } from './modal-focus.js';

let activeUIComponents = null;
const pointerFocusDocuments = new WeakSet();

function installPointerFocusModality(doc) {
  if (pointerFocusDocuments.has(doc)) return;
  pointerFocusDocuments.add(doc);
  let pointerPending = false;
  let pointerFocused = null;
  const clearPointerFocus = () => {
    pointerFocused?.classList.remove('tp3d-pointer-focus');
    pointerFocused = null;
  };
  const markPointerFocus = element => {
    if (!element?.classList || element === doc.body || element === doc.documentElement) return;
    if (pointerFocused !== element) clearPointerFocus();
    element.classList.add('tp3d-pointer-focus');
    pointerFocused = element;
  };
  doc.addEventListener('pointerdown', () => {
    pointerPending = true;
    markPointerFocus(doc.activeElement);
  }, true);
  doc.addEventListener('focusin', event => {
    if (pointerPending) markPointerFocus(event.target);
  }, true);
  // The click fires after pointerup and after target handlers that may move
  // focus into a modal. Clearing here also avoids leaving a pending timer.
  doc.addEventListener('click', () => { pointerPending = false; });
  doc.addEventListener('pointercancel', () => { pointerPending = false; }, true);
  doc.addEventListener('dragend', () => { pointerPending = false; }, true);
  doc.addEventListener('contextmenu', () => { pointerPending = false; }, true);
  doc.addEventListener('focusout', event => {
    if (pointerFocused === event.target) clearPointerFocus();
  }, true);
  doc.addEventListener('keydown', event => {
    pointerPending = false;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key) || pointerFocused?.id === 'viewport') return;
    clearPointerFocus();
  }, true);
}

// Table footers are created by screens that do not receive the UIComponents
// instance. The app creates that instance before it renders either table.
export function createSharedSelect(options) {
  if (!activeUIComponents) throw new Error('UIComponents must be initialized before a select is created');
  return activeUIComponents.createSelect(options);
}

const AUTOPACK_LOADING_IMAGE_SRC = 'media/autopack-loading-truck-480w.gif?v=20260703';
// One-time notice only: AutoPack status lifetime follows the engine's run
// cleanup, so this never closes the surface or implies completion.
const AUTOPACK_STATUS_LONG_RUNNING_MS = 90000;
const AUTOPACK_STATUS_LONG_RUNNING_MESSAGE =
  'AutoPack is still working. Large or complex loads can take longer.';

/** Shared resources for blocking owners registered in the interaction registry. */
function createModalIsolation({ documentRef, getOwners }) {
  const locks = new Map();
  const isolated = new Map();
  const body = documentRef.body;
  const sharedLockClass = 'tp3d-shared-modal-lock';
  let hadModalOpen = null;

  function restore(element, previous) {
    if (previous === null) element.removeAttribute('inert');
    else element.setAttribute('inert', previous);
  }

  function update() {
    const active = [...locks.values()].filter(owner => owner.isActive() && owner.element?.isConnected)
      .sort((a, b) => b.priority - a.priority || b.order - a.order)[0];

    if (active) {
      if (hadModalOpen === null) {
        hadModalOpen = body.classList.contains('modal-open');
        body.classList.add('modal-open');
      }
      // Legacy overlays may change modal-open; only this registry owns the
      // shared marker that keeps scroll isolation in force.
      body.classList.add(sharedLockClass);
    } else if (hadModalOpen !== null) {
      body.classList.remove(sharedLockClass);
      body.classList.toggle('modal-open', hadModalOpen);
      hadModalOpen = null;
    }

    const targets = new Set();
    if (active) {
      const owners = getOwners();
      const byId = new Map(owners.map(owner => [owner.id, owner]));
      const roots = [active.element];
      for (const owner of owners) {
        if (owner.kind !== 'popup' || !owner.element?.isConnected || !owner.isActive() ||
            active.element.contains(owner.element)) continue;
        let parent = byId.get(owner.parentId);
        while (parent && parent.kind === 'popup') parent = byId.get(parent.parentId);
        if (parent === active) roots.push(owner.element);
      }

      // Isolate siblings along the path to each allowed surface, never an
      // ancestor of that surface or anything inside its own subtree.
      const keep = new Set(roots);
      const parents = new Set();
      for (const root of roots) {
        for (let parent = root.parentElement; parent; parent = parent.parentElement) {
          keep.add(parent);
          parents.add(parent);
          if (parent === body) break;
        }
      }
      for (const parent of parents) {
        for (const child of parent.children) {
          if (keep.has(child) || child.id === 'toast-container' ||
              ['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName)) continue;
          targets.add(child);
        }
      }
    }

    for (const [element, previous] of isolated) {
      if (targets.has(element)) continue;
      restore(element, previous);
      isolated.delete(element);
    }
    for (const element of targets) {
      if (isolated.has(element)) continue;
      isolated.set(element, element.getAttribute('inert'));
      element.setAttribute('inert', '');
    }
  }

  function acquire(owner) {
    const token = Symbol('modal-isolation');
    locks.set(token, owner);
    update();
    let released = false;
    return Object.freeze({ release() {
      if (released) return;
      released = true;
      locks.delete(token);
      update();
    } });
  }

  return { acquire, update };
}

/**
 * Logical interaction ownership and Escape assignment. Surface callbacks retain
 * their close/cancel behavior. Install before application keyboard listeners.
 */
export function createModalOwnership({ windowRef = window, documentRef = document } = {}) {
  const owners = new Map();
  const eventOwners = new WeakMap();
  const escapeClaims = new WeakMap();
  let order = 0;
  const modalFocus = createModalFocus({ windowRef, documentRef, getActiveOwner,
    getOwners: () => [...owners.values()] });
  const modalIsolation = createModalIsolation({ documentRef,
    getOwners: () => [...owners.values()] });

  function getActiveOwner() {
    let active = null;
    for (const owner of owners.values()) {
      if (!owner.isActive()) continue;
      if (!active || owner.priority > active.priority ||
          (owner.priority === active.priority && owner.order > active.order)) {
        active = owner;
      }
    }
    return active;
  }

  function getOwnerForElement(element) {
    return [...owners.values()].reverse().find(owner =>
      owner.isActive() && element && owner.element?.contains(element)) || null;
  }

  /** @param {{ kind?: string, element?: Element, parentId?: symbol | null, priority?: number,
   * isActive?: () => boolean, canDismiss?: (source: string) => boolean,
   * onDismiss?: (source: string) => void, onParentClose?: () => void,
   * focusRoot?: HTMLElement, initialFocus?: HTMLElement | (() => HTMLElement | null),
   * restoreFocus?: boolean,
   * restoreFocusResolver?: (context: { source: Element, isValidTarget: (target: any) => boolean }) => Element | null }} [options] */
  function register({ kind = 'modal', element = null, parentId, priority = 0,
    isActive = () => true, canDismiss = () => true, onDismiss, onParentClose,
    focusRoot = null, initialFocus = null, restoreFocus = Boolean(focusRoot),
    restoreFocusResolver = null } = {}) {
    if (parentId === undefined) {
      // Infer ancestry only from an already registered owner's focused content.
      // DOM classes, visibility and ARIA never establish ownership.
      let parent = getOwnerForElement(documentRef.activeElement);
      // A transient popup is not the lifetime owner of a dialog it launches.
      while (parent?.kind === 'popup') parent = owners.get(parent.parentId);
      parentId = parent?.id || null;
    }
    const id = Symbol(kind);
    let isolationLock = null;
    const owner = Object.freeze({
      id, kind, element, parentId, priority, order: ++order, isActive, onParentClose,
      focusRoot, initialFocus,
      ensureFocus() { modalFocus.enter(owner); },
      requestDismiss(source) {
        if (!owners.has(id) || !canDismiss(source) || !onDismiss) return false;
        onDismiss(source);
        return true;
      },
      release({ restoreFocus: restoreOnRelease = true } = {}) {
        let active = getActiveOwner();
        while (active && active !== owner) active = owners.get(active.parentId);
        const ownedFocus = active === owner;
        if (!owners.delete(id)) return;
        for (const child of [...owners.values()]) {
          if (child.parentId === id) child.onParentClose?.();
        }
        isolationLock?.release();
        if (!isolationLock) modalIsolation.update();
        windowRef.dispatchEvent?.(new Event('tp3d-modal-ownership-change'));
        if (restoreFocus && restoreOnRelease && ownedFocus) {
          const releasedOrder = order;
          queueMicrotask(() => {
            // Run after removal, onClose cleanup and synchronous rerenders.
            if (order === releasedOrder) modalFocus.restore(owner);
          });
        }
      },
    });
    if (restoreFocus) modalFocus.capture(owner, restoreFocusResolver);
    owners.set(id, owner);
    if (kind !== 'popup' && element) isolationLock = modalIsolation.acquire(owner);
    else modalIsolation.update();
    windowRef.dispatchEvent?.(new Event('tp3d-modal-ownership-change'));
    if (focusRoot) queueMicrotask(() => modalFocus.enter(owner, true));
    return owner;
  }

  windowRef.addEventListener('keydown', event => {
    // Window capture precedes legacy document capture handlers which can close
    // an owner. Keep that entry snapshot even after its registration is released.
    const owner = getActiveOwner();
    eventOwners.set(event, owner?.id || null);
    escapeClaims.delete(event);
    modalFocus.handleTab(event, owner);
    if (event.key !== 'Escape' || !owner) return;
    // Claim before invoking a callback: it may release this owner or open another.
    // The same event cannot be reassigned to that new owner or to the Editor.
    escapeClaims.set(event, owner.id);
    event.preventDefault();
    event.stopPropagation();
    owner.requestDismiss('escape');
  }, true);

  function blocksKeyboardEvent(event) {
    return Boolean(eventOwners.get(event) || getActiveOwner());
  }

  return { register, getActiveOwner, getOwnerForElement,
    getOwners: () => [...owners.values()], blocksKeyboardEvent,
    getEscapeClaim: event => escapeClaims.get(event) || null };
}

export function createUIComponents() {
  installPointerFocusModality(document);
  const modalOwnership = createModalOwnership();
  const modalRoot = document.getElementById('modal-root');
  const toastContainer = document.getElementById('toast-container');
  // Deterministic, incrementing (not random/time-based) so title IDs stay
  // stable and unique across every generic dialog for the app's lifetime,
  // including multiple dialogs open/created in the same tick.
  let modalTitleIdCounter = 0;
  let dropdownKeyDownListener = null;
  let dropdownRepositionListener = null;
  let dropdownDocClickListener = null;
  let dropdownDocClickTimer = null;
  let dropdownActiveAnchorEl = null;
  let dropdownActiveAnchorClasses = [];
  let dropdownSemanticAnchorEl = null;
  const registeredDropdownSurfaces = new Map();
  let dropdownOwner = null;
  let dropdownHost = null;
  let dropdownActionParentId;
  let closingDropdowns = false;
  let selectIdCounter = 0;

  const toastTypes = {
    success: { title: 'Success', color: 'var(--success)', icon: '✓' },
    error: { title: 'Error', color: 'var(--error)', icon: '✕' },
    warning: { title: 'Warning', color: 'var(--warning)', icon: '⚠' },
    info: { title: 'Info', color: 'var(--info)', icon: 'ℹ' },
  };

  function showToast(message, type = 'info', options = {}) {
    const cfg = toastTypes[type] || toastTypes.info;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.style.background = cfg.color;
    icon.textContent = cfg.icon;

    const body = document.createElement('div');
    body.className = 'toast-body';

    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = options.title || cfg.title;

    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = String(message || '');

    body.appendChild(title);
    body.appendChild(msg);

    if (Array.isArray(options.actions) && options.actions.length) {
      const actions = document.createElement('div');
      actions.className = 'toast-actions';
      options.actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = 'toast-btn';
        btn.type = 'button';
        btn.textContent = action.label || 'Action';
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          try {
            action.onClick && action.onClick();
          } catch (_) {
            // Ignore errors from action handlers
          }
          removeToast(toast);
        });
        actions.appendChild(btn);
      });
      body.appendChild(actions);
    }

    toast.appendChild(icon);
    toast.appendChild(body);

    // An actionable toast keeps its action until it expires: an ordinary click on its body does not remove it.
    if (!(Array.isArray(options.actions) && options.actions.length)) toast.addEventListener('click', () => removeToast(toast));
    toastContainer.appendChild(toast);

    // Over the limit, plain toasts leave first, so an actionable toast (an Undo offer) is not evicted while it is still valid.
    while (toastContainer.children.length > 3) {
      const plain = [...toastContainer.children].find(el => !el.querySelector('.toast-actions'));
      toastContainer.removeChild(plain || toastContainer.firstChild);
    }

    const duration = Number.isFinite(options.duration) ? options.duration : 3200;
    if (duration > 0) window.setTimeout(() => removeToast(toast), duration);
  }

  function removeToast(toast) {
    if (!toast || !toast.parentElement) return;
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(12px)';
    window.setTimeout(() => {
      if (toast.parentElement) toast.parentElement.removeChild(toast);
    }, 180);
  }

  // Ordinary dialogs restore on final close by default. A single resolver can
  // select a current target via { source, isValidTarget }; invalid results use
  // the surviving parent's normal focus region. Specialized callers can opt
  // out with restoreFocus: false, either here or for one close({ restoreFocus }).
  function showModal(config) {
    let owner = null;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    // Semantic dialog root + stable accessible name. `titleId` is deterministic
    // (incrementing counter, not random/time-based) so it stays unique across
    // every dialog and remains deterministic-test-friendly. Callers that
    // restructure the title element in place (custom headings) keep this same
    // id and therefore keep a correct, live-computed accessible name; callers
    // that need a different scheme (e.g. Notes) already overwrite both the id
    // and aria-labelledby themselves after this returns.
    const titleId = `tp3d-modal-title-${++modalTitleIdCounter}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('tabindex', '-1');
    modal.setAttribute('aria-labelledby', titleId);

    const showCloseButton = !(config && (config.hideClose === true || config.showCloseButton === false));

    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.id = titleId;
    title.textContent = config.title || 'Dialog';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-ghost';
    closeBtn.type = 'button';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.setAttribute('aria-label', `Close ${config.title || 'Dialog'}`);
    closeBtn.addEventListener('click', () => owner.requestDismiss('close-button'));

    header.appendChild(title);
    if (showCloseButton) {
      header.appendChild(closeBtn);
    }

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof config.content === 'string') {
      // SECURITY: Treat string content as trusted HTML only. For user-provided text, pass an HTMLElement and set textContent.
      const div = document.createElement('div');
      div.innerHTML = config.content;
      body.appendChild(div);
    } else if (config.content instanceof HTMLElement) {
      body.appendChild(config.content);
    }

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    (config.actions || [{ label: 'Close' }]).forEach(action => {
      const btn = document.createElement('button');
      btn.className =
        `btn ${action.variant === 'primary' ? 'btn-primary' : ''} ${action.variant === 'danger' ? 'btn-danger' : ''} ${action.variant === 'ghost' ? 'btn-ghost' : ''}`
          .trim()
          .replace(/\s+/g, ' ');
      btn.type = 'button';
      btn.textContent = action.label || 'OK';
      btn.addEventListener('click', () => {
        try {
          const res = action.onClick ? action.onClick() : undefined;
          if (res === false) return;
        } catch (_) {
          // Ignore errors from modal actions
        }
        close();
      });
      footer.appendChild(btn);
    });

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    overlay.addEventListener('click', ev => {
      if (ev.target === overlay && config.dismissible !== false) owner.requestDismiss('backdrop');
    });

    let closed = false;
    function close({ restoreFocus = true } = {}) {
      if (closed) return;
      closed = true;
      owner.release({ restoreFocus });
      if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
      try {
        config.onClose && config.onClose();
      } catch (_) {
        // Ignore errors from onClose callback
      }
    }

    modalRoot.appendChild(overlay);
    owner = modalOwnership.register({
      element: overlay,
      focusRoot: modal,
      initialFocus: config.initialFocus,
      restoreFocus: config.restoreFocus !== false,
      restoreFocusResolver: config.restoreFocusResolver,
      parentId: config.parentOwnerId === undefined ? dropdownActionParentId : config.parentOwnerId,
      canDismiss: source =>
        (source !== 'escape' || config.dismissible !== false) &&
        (!config.canDismiss || config.canDismiss(source) !== false),
      onDismiss: () => close(),
      onParentClose: () => close(),
    });
    return { close, requestDismiss: owner.requestDismiss, overlay, modal, body, owner };
  }

  function showAutoPackLoadingOverlay(options = {}) {
    // Non-modal status surface: it registers no modal owner, takes no focus,
    // acquires no isolation/scroll lock and has no controls. Only the card itself
    // absorbs pointer input; the Editor around it stays usable, OperationLifecycle
    // blocks conflicting mutations, and selection changes during the run do not
    // re-sync the animating scene (EditorUI.renderSelection).
    const root = modalRoot || document.body;
    const imageSrc = String(options.imageSrc || AUTOPACK_LOADING_IMAGE_SRC || '').trim();
    const resolvedImageSrc = imageSrc
      ? (() => {
          try {
            return new URL(imageSrc, document.baseURI).href;
          } catch {
            return imageSrc;
          }
        })()
      : '';
    const titleText = String(options.title || 'Building your load plan');
    const titleId = `autopack-loading-title-${Date.now()}`;
    let closed = false;
    let longRunningTimerId = null;

    const overlay = document.createElement('div');
    overlay.className = 'autopack-loading-overlay';
    overlay.dataset.tp3dAutopackLoading = '1';

    const modal = document.createElement('section');
    modal.className = 'autopack-loading-modal';
    modal.setAttribute('aria-labelledby', titleId);

    const body = document.createElement('div');
    body.className = 'autopack-loading-body';

    const visual = document.createElement('div');
    visual.className = 'autopack-loading-visual';
    visual.setAttribute('aria-hidden', 'true');

    const fallback = document.createElement('div');
    fallback.className = 'autopack-loading-fallback';
    fallback.hidden = true;
    fallback.innerHTML = '<i class="fa-solid fa-truck-ramp-box"></i><i class="fa-solid fa-spinner fa-spin"></i>';

    if (resolvedImageSrc) {
      const img = document.createElement('img');
      img.className = 'autopack-loading-image';
      img.src = resolvedImageSrc;
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'eager';
      img.addEventListener('load', () => {
        visual.classList.add('has-image');
      }, { once: true });
      img.addEventListener('error', () => {
        img.hidden = true;
        fallback.hidden = false;
        visual.classList.add('is-fallback');
      }, { once: true });
      visual.appendChild(img);
    } else {
      fallback.hidden = false;
      visual.classList.add('is-fallback');
    }
    visual.appendChild(fallback);

    const title = document.createElement('h3');
    title.className = 'autopack-loading-title';
    title.id = titleId;
    title.textContent = titleText;

    const message = document.createElement('p');
    message.className = 'autopack-loading-message';
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');

    const progress = document.createElement('div');
    progress.className = 'autopack-loading-progress';
    progress.setAttribute('aria-hidden', 'true');
    progress.appendChild(document.createElement('span'));

    body.appendChild(visual);
    body.appendChild(title);
    body.appendChild(message);
    body.appendChild(progress);
    modal.appendChild(body);
    overlay.appendChild(modal);
    root.appendChild(overlay);

    // Stage text changes only when the engine reports a real stage; an
    // unchanged message is not rewritten so it is not re-announced.
    const setMessage = nextMessage => {
      if (closed) return;
      const text = String(nextMessage || '').trim();
      if (text && message.textContent !== text) message.textContent = text;
    };
    setMessage(options.initialMessage || 'Checking fit, stacking, and safety rules...');

    longRunningTimerId = window.setTimeout(() => {
      longRunningTimerId = null;
      setMessage(AUTOPACK_STATUS_LONG_RUNNING_MESSAGE);
    }, Number.isFinite(options.longRunningMs) ? options.longRunningMs : AUTOPACK_STATUS_LONG_RUNNING_MS);

    function close() {
      if (closed) return;
      closed = true;
      if (longRunningTimerId !== null) window.clearTimeout(longRunningTimerId);
      longRunningTimerId = null;
      if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    }

    return { close, setMessage, overlay, modal };
  }

  function confirm(options) {
    return new Promise(resolve => {
      // Guarded settlement: the Confirm/Cancel actions settle explicitly (true/false)
      // before the primitive auto-closes; X/backdrop/other primitive closes settle
      // false via onClose as a fallback. The guard makes whichever settles first win
      // and every later attempt (including the onClose fallback after an explicit
      // settlement) a no-op, so the Promise always settles exactly once.
      let settled = false;
      const settle = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      showModal({
        title: options.title || 'Confirm',
        content: options.message || 'Are you sure?',
        actions: [
          { label: options.cancelLabel || 'Cancel', onClick: () => settle(false) },
          {
            label: options.okLabel || 'Confirm',
            variant: options.danger ? 'danger' : 'primary',
            onClick: () => settle(true),
          },
        ],
        onClose: () => settle(false),
      });
    });
  }

  function openDropdown(anchorEl, items, options = {}) {
    const parent = modalOwnership.getOwnerForElement(anchorEl);
    const invokeAction = (callback, ...args) => {
      const previousParentId = dropdownActionParentId;
      dropdownActionParentId = parent?.id || null;
      try { return callback?.(...args); }
      finally { dropdownActionParentId = previousParentId; }
    };
    const anchorKey = options.anchorKey ? String(options.anchorKey) : '';
    const fallbackAnchorId = anchorEl && anchorEl.id ? String(anchorEl.id) : '';
    const resolvedAnchorId = anchorKey || fallbackAnchorId;
    const role = options.role ? String(options.role) : '';
    const existing = Array.from(document.querySelectorAll('[data-dropdown="1"]')).find(candidate => {
      const candidateEl = /** @type {HTMLElement} */ (candidate);
      return candidateEl.dataset.anchorId === resolvedAnchorId && candidateEl.dataset.role === role;
    });
    const shouldToggleClosed = options.toggle === true && Boolean(existing);
    closeAllDropdowns();
    const menuSemantics = options.menuSemantics === true;
    const selectSemantics = options.selectSemantics === true;
    const manageTriggerState = menuSemantics || selectSemantics || options.manageTriggerState === true;
    if (shouldToggleClosed) return null;
    if (manageTriggerState && anchorEl) {
      dropdownSemanticAnchorEl = anchorEl;
      anchorEl.setAttribute('aria-haspopup', selectSemantics ? 'listbox' : 'menu');
      anchorEl.setAttribute('aria-expanded', 'true');
    }
    const activeAnchorClass = String(options.activeAnchorClass || '').trim();
    if (activeAnchorClass && anchorEl && anchorEl.classList) {
      dropdownActiveAnchorEl = anchorEl;
      dropdownActiveAnchorClasses = activeAnchorClass.split(/\s+/).filter(Boolean);
      dropdownActiveAnchorClasses.forEach(className => anchorEl.classList.add(className));
    }
    const wrap = document.createElement('div');
    wrap.className = selectSemantics ? 'dropdown-menu tp3d-select-menu' : 'dropdown-menu';
    if (selectSemantics) {
      wrap.id = `${resolvedAnchorId}-listbox`;
      wrap.setAttribute('role', 'listbox');
      wrap.setAttribute('aria-label', String(options.selectLabel || 'Options'));
      anchorEl.setAttribute('aria-controls', wrap.id);
    }
    // The stylesheet defines `.dropdown-menu` as `position:absolute` for inline dropdowns.
    // For floating viewport-clamped dropdowns we keep it absolute but hide it while measuring.
    wrap.style.top = '0';
    wrap.style.left = '0';
    wrap.style.right = 'auto';
    wrap.style.visibility = 'hidden';

    const selectOptions = [];
    let radioGroup = null;
    let radioGroupName = '';
    const activateSelectOption = item => {
      if (item.disabled) return;
      closeAllDropdowns();
      if (anchorEl?.isConnected && typeof anchorEl.focus === 'function') anchorEl.focus();
      invokeAction(item.onClick);
    };
    items.forEach((item, index) => {
      if (selectSemantics) {
        const option = document.createElement('div');
        option.id = `${wrap.id}-option-${index}`;
        option.className = 'tp3d-select-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', item.selected ? 'true' : 'false');
        option.setAttribute('aria-disabled', item.disabled ? 'true' : 'false');
        option.title = String(item.label || '');
        if (item.selected) option.classList.add('is-selected');
        const label = document.createElement('span');
        label.className = 'tp3d-select-option__label';
        label.textContent = String(item.label || '');
        option.appendChild(label);
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check tp3d-select-option__check';
        check.setAttribute('aria-hidden', 'true');
        option.appendChild(check);
        option.addEventListener('click', ev => {
          ev.stopPropagation();
          activateSelectOption(item);
        });
        wrap.appendChild(option);
        selectOptions.push({ element: option, item });
        return;
      }
      if (item && item.type === 'header') {
        const header = document.createElement('div');
        header.style.padding = '10px 12px';
        header.style.fontWeight = 'var(--font-semibold)';
        header.style.borderBottom = '1px solid var(--border-subtle)';
        header.style.position = 'sticky';
        header.style.top = '0';
        header.style.background = 'var(--bg-secondary)';
        header.style.zIndex = '1';
        if (item.fontSize) header.style.fontSize = item.fontSize;
        header.textContent = String(item.label || '');
        wrap.appendChild(header);
        return;
      }

      if (item && (item.type === 'divider' || item.divider === true)) {
        radioGroup = null;
        radioGroupName = '';
        const divider = document.createElement('div');
        divider.setAttribute('role', 'separator');
        divider.style.height = '1px';
        divider.style.margin = `${8}px ${6}px`;
        divider.style.background = 'var(--border-subtle)';
        wrap.appendChild(divider);
        return;
      }

      // Add divider before this item if requested
      if (item && item.dividerBefore) {
        const divider = document.createElement('div');
        divider.setAttribute('role', 'separator');
        divider.style.height = '1px';
        divider.style.margin = `${8}px ${6}px`;
        divider.style.background = 'var(--border-subtle)';
        wrap.appendChild(divider);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dropdown-item';
      if (menuSemantics) {
        btn.setAttribute('role', item.radio === true ? 'menuitemradio' : 'menuitem');
        if (item.radio === true) btn.setAttribute('aria-checked', item.checked ? 'true' : 'false');
      }

      // Apply variant (e.g., danger for delete actions)
      if (item && item.variant) {
        btn.dataset.variant = item.variant;
      }

      if (item && item.disabled) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
      }
      if (item && item.status === true) {
        btn.dataset.status = '1';
        btn.tabIndex = -1;
        btn.setAttribute('aria-disabled', 'true');
      }
      if (item && item.active) {
        btn.style.background = 'var(--bg-hover)';
      }
      if (item.icon) {
        const icon = document.createElement('i');
        icon.className = item.icon;
        icon.setAttribute('aria-hidden', 'true');
        if (item.iconColor) icon.style.color = String(item.iconColor);
        btn.appendChild(icon);
      }
      const text = document.createElement('span');
      text.textContent = String(item.label || '');
      text.style.flex = '1';
      btn.appendChild(text);

      if (item.checkbox === true) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(item.checked);
        cb.disabled = Boolean(item.disabled);
        cb.style.marginLeft = 'auto';
        cb.setAttribute('aria-label', item.checkboxLabel || text.textContent || 'Toggle');
        cb.addEventListener('click', ev => ev.stopPropagation());
        cb.addEventListener('change', ev => {
          if (btn.disabled) return;
          try {
            const handler = item.onCheckboxChange || item.onClick;
            const target = /** @type {HTMLInputElement|null} */ (ev.target);
            invokeAction(handler, Boolean(target && target.checked));
          } finally {
            if (options.closeOnCheckboxChange !== false) closeAllDropdowns();
          }
        });
        btn.appendChild(cb);
      } else if (item.rightIcon) {
        const iconRight = document.createElement('i');
        iconRight.className = item.rightIcon;
        iconRight.setAttribute('aria-hidden', 'true');
        iconRight.style.color = item.rightIconColor || 'var(--accent-primary)';
        if (item.rightOnClick) {
          iconRight.style.cursor = 'pointer';
          // Wrap in a span for the tooltip: putting data-tooltip directly on <i> triggers
          // [data-tooltip]::before{content:""} in main.css which wipes the Font Awesome glyph.
          const iconWrap = document.createElement('span');
          iconWrap.style.marginLeft = 'auto';
          iconWrap.style.display = 'inline-flex';
          iconWrap.style.alignItems = 'center';
          if (item.rightTitle) iconWrap.setAttribute('data-tooltip', String(item.rightTitle));
          iconWrap.addEventListener('click', ev => {
            ev.stopPropagation();
            if (btn.disabled) return;
            closeAllDropdowns();
            invokeAction(item.rightOnClick);
          });
          iconWrap.appendChild(iconRight);
          btn.appendChild(iconWrap);
        } else {
          iconRight.style.marginLeft = 'auto';
          btn.appendChild(iconRight);
        }
      }
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (btn.disabled || (item && item.status === true)) return;
        closeAllDropdowns();
        invokeAction(item.onClick);
        if (manageTriggerState && anchorEl && typeof anchorEl.focus === 'function') anchorEl.focus();
      });
      if (menuSemantics && item.radio === true && item.radioGroup) {
        const name = String(item.radioGroup);
        if (!radioGroup || radioGroupName !== name) {
          radioGroup = document.createElement('div');
          radioGroup.setAttribute('role', 'group');
          radioGroup.setAttribute('aria-label', name);
          wrap.appendChild(radioGroup);
          radioGroupName = name;
        }
        radioGroup.appendChild(btn);
      } else {
        radioGroup = null;
        radioGroupName = '';
        wrap.appendChild(btn);
      }
    });

    const dropdown = document.createElement('div');
    dropdown.className = selectSemantics ? 'dropdown tp3d-select-dropdown' : 'dropdown';
    if (options.dropdownClass) {
      String(options.dropdownClass)
        .split(/\s+/)
        .filter(Boolean)
        .forEach(className => dropdown.classList.add(className));
    }
    dropdown.dataset.dropdown = '1';
    if (menuSemantics) dropdown.setAttribute('role', 'menu');
    dropdown.dataset.anchorId = resolvedAnchorId;
    if (role) dropdown.dataset.role = role;
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '16000';
    dropdown.style.visibility = 'hidden';

    const preferredWidth = selectSemantics
      ? Math.max(180, anchorEl.getBoundingClientRect().width)
      : Math.max(Number(options.minWidth) || 180, Number(options.width) || 220);
    dropdown.style.minWidth = `${preferredWidth}px`;
    dropdown.appendChild(wrap);

    // A sibling of the modal panel escapes its scrolling/clipped content, while
    // remaining inside the owner's stacking context below a later child dialog.
    if (parent?.element) {
      dropdownHost = document.createElement('div');
      dropdownHost.className = 'modal-popup-host';
      parent.element.appendChild(dropdownHost);
      dropdownHost.appendChild(dropdown);
    } else {
      document.body.appendChild(dropdown);
    }
    dropdownOwner = modalOwnership.register({
      kind: 'popup', element: dropdown, parentId: parent?.id || null,
      priority: parent?.priority || 0,
      onDismiss: () => {
        const focusTarget = dropdownSemanticAnchorEl;
        closeAllDropdowns();
        if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
      },
      onParentClose: closeAllDropdowns,
    });

    const positionDropdown = () => {
      if (!dropdown.isConnected) return;
      const pad = 8;
      const gap = 6;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const rect = anchorEl.getBoundingClientRect();

      dropdown.style.maxWidth = `${Math.max(0, vw - pad * 2)}px`;
      dropdown.style.maxHeight = `${Math.max(0, vh - pad * 2)}px`;
      dropdown.style.overflowY = 'auto';

      // Measure after maxWidth/minWidth are applied.
      const menuRect = wrap.getBoundingClientRect();
      const menuW = Math.min(Math.max(menuRect.width, wrap.scrollWidth || 0, preferredWidth), Math.max(0, vw - pad * 2));
      const menuH = Math.min(Math.max(menuRect.height, wrap.scrollHeight || 0, 0), Math.max(0, vh - pad * 2));
      dropdown.style.width = `${Math.ceil(menuW)}px`;
      dropdown.style.height = `${Math.ceil(menuH)}px`;

      // Default: open below the trigger.
      let top = rect.bottom + gap;
      if (top + menuH > vh - pad) top = rect.top - gap - menuH;
      top = Math.max(pad, Math.min(top, Math.max(pad, vh - pad - menuH)));

      // Backwards-compatible default: align dropdown's right edge with trigger's right edge.
      let left = rect.right - menuW;
      if (options.align === 'left') left = rect.left;
      // Opt-in side placement (floating controls on the right edge): open beside the
      // trigger, to its left, top-aligned (raised by the optional placementLift px) and
      // kept inside the viewport. With no room on that side the default below/above
      // placement above is kept.
      if (options.placement === 'left' && rect.left - gap - menuW >= pad) {
        left = rect.left - gap - menuW;
        const lift = Number.isFinite(options.placementLift) ? Math.max(0, options.placementLift) : 0;
        top = Math.max(pad, Math.min(rect.top - lift, Math.max(pad, vh - pad - menuH)));
      }
      left = Math.max(pad, Math.min(left, Math.max(pad, vw - pad - menuW)));

      dropdown.style.left = `${Math.round(left)}px`;
      dropdown.style.top = `${Math.round(top)}px`;
    };

    positionDropdown();
    wrap.style.visibility = 'visible';
    dropdown.style.visibility = 'visible';
    if (selectSemantics) {
      const active = selectOptions.find(entry => entry.item.selected && !entry.item.disabled) ||
        selectOptions.find(entry => !entry.item.disabled);
      if (active) {
        active.element.classList.add('is-active');
        anchorEl.setAttribute('aria-activedescendant', active.element.id);
        active.element.scrollIntoView?.({ block: 'nearest' });
      }
    }
    if (menuSemantics) {
      const firstItem = /** @type {HTMLElement | null} */ (
        Array.from(wrap.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
          .find(item => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true') || null
      );
      if (firstItem) firstItem.focus();
    }
    if (dropdownDocClickTimer) {
      window.clearTimeout(dropdownDocClickTimer);
      dropdownDocClickTimer = null;
    }
    if (dropdownDocClickListener) {
      document.removeEventListener('click', dropdownDocClickListener);
      dropdownDocClickListener = null;
    }
    dropdownDocClickTimer = window.setTimeout(() => {
      dropdownDocClickListener = () => closeAllDropdowns();
      document.addEventListener('click', dropdownDocClickListener, { once: true });
      dropdownDocClickTimer = null;
    }, 0);

    dropdownKeyDownListener = ev => {
      if (selectSemantics && document.activeElement === anchorEl) {
        const enabled = selectOptions.filter(entry => !entry.item.disabled);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key) && enabled.length) {
          ev.preventDefault();
          const currentIndex = enabled.findIndex(entry => entry.element.classList.contains('is-active'));
          const nextIndex = ev.key === 'Home' ? 0 : ev.key === 'End' ? enabled.length - 1
            : ev.key === 'ArrowDown' ? (currentIndex + 1) % enabled.length
              : (currentIndex <= 0 ? enabled.length : currentIndex) - 1;
          selectOptions.forEach(entry => entry.element.classList.remove('is-active'));
          const next = enabled[nextIndex];
          next.element.classList.add('is-active');
          anchorEl.setAttribute('aria-activedescendant', next.element.id);
          next.element.scrollIntoView?.({ block: 'nearest' });
          return;
        }
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          const active = enabled.find(entry => entry.element.classList.contains('is-active'));
          if (active) activateSelectOption(active.item);
          return;
        }
        if (ev.key === 'Tab') closeAllDropdowns();
      }
      if (menuSemantics && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
        const menuItems = /** @type {HTMLElement[]} */ (
          Array.from(wrap.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
            .filter(item => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true')
        );
        if (!menuItems.length) return;
        ev.preventDefault();
        const activeElement = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        const currentIndex = activeElement ? menuItems.indexOf(activeElement) : -1;
        let nextIndex;
        if (ev.key === 'Home') nextIndex = 0;
        else if (ev.key === 'End') nextIndex = menuItems.length - 1;
        else if (ev.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % menuItems.length;
        else nextIndex = currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1;
        const nextItem = menuItems[nextIndex];
        if (nextItem) nextItem.focus();
      }
    };
    document.addEventListener('keydown', dropdownKeyDownListener);

    dropdownRepositionListener = () => positionDropdown();
    window.addEventListener('resize', dropdownRepositionListener);
    // Capture scroll events from nested scroll containers too.
    window.addEventListener('scroll', dropdownRepositionListener, true);
    return dropdown;
  }

  function closeAllDropdowns() {
    if (closingDropdowns) return;
    closingDropdowns = true;
    try {
      dropdownOwner?.release();
      dropdownOwner = null;
      document.querySelectorAll('[data-dropdown="1"]').forEach(el => el.remove());
      dropdownHost?.remove();
      dropdownHost = null;
      if (dropdownActiveAnchorEl && dropdownActiveAnchorClasses.length) {
        dropdownActiveAnchorClasses.forEach(className => dropdownActiveAnchorEl.classList.remove(className));
      }
      dropdownActiveAnchorEl = null;
      dropdownActiveAnchorClasses = [];
      if (dropdownSemanticAnchorEl) dropdownSemanticAnchorEl.setAttribute('aria-expanded', 'false');
      if (dropdownSemanticAnchorEl) {
        dropdownSemanticAnchorEl.removeAttribute('aria-controls');
        dropdownSemanticAnchorEl.removeAttribute('aria-activedescendant');
      }
      dropdownSemanticAnchorEl = null;
      if (dropdownDocClickTimer) {
        window.clearTimeout(dropdownDocClickTimer);
        dropdownDocClickTimer = null;
      }
      if (dropdownDocClickListener) {
        document.removeEventListener('click', dropdownDocClickListener);
        dropdownDocClickListener = null;
      }
      if (dropdownKeyDownListener) {
        document.removeEventListener('keydown', dropdownKeyDownListener);
        dropdownKeyDownListener = null;
      }
      if (dropdownRepositionListener) {
        window.removeEventListener('resize', dropdownRepositionListener);
        window.removeEventListener('scroll', dropdownRepositionListener, true);
        dropdownRepositionListener = null;
      }
      registeredDropdownSurfaces.forEach((_unregister, surface) => {
        if (surface && typeof surface.isOpen === 'function' && surface.isOpen()) surface.close();
      });
    } finally {
      closingDropdowns = false;
    }
  }

  function registerDropdownSurface(surface) {
    if (!surface || typeof surface.isOpen !== 'function' || typeof surface.close !== 'function') {
      return () => {};
    }
    const existing = registeredDropdownSurfaces.get(surface);
    if (existing) return existing;
    // Persistent page filters expose their existing open state explicitly. They
    // join the same arbiter, below modal owners, without a second Escape listener.
    const owner = modalOwnership.register({
      kind: 'popup', parentId: null, priority: -1, isActive: () => surface.isOpen(),
      onDismiss: () => {
        const focusTarget = surface.getAnchor?.();
        closeAllDropdowns();
        if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
      },
    });
    const unregister = () => {
      if (registeredDropdownSurfaces.get(surface) !== unregister) return;
      owner.release();
      registeredDropdownSurfaces.delete(surface);
    };
    registeredDropdownSurfaces.set(surface, unregister);
    return unregister;
  }

  /**
   * Select-only combobox. Programmatic value changes stay silent, matching a
   * native select; user selection emits one bubbling change event.
   * @param {{label: string, options: Array<{value: string, label: string, disabled?: boolean}>,
   *   value?: string, disabled?: boolean, className?: string, id?: string}} config
   * @returns {HTMLDivElement & {value: string, disabled: boolean,
   *   setOptions: (options: Array<{value: string, label: string, disabled?: boolean}>) => void}}
   */
  function createSelect(config) {
    const trigger = document.createElement('div');
    trigger.id = config.id || `tp3d-select-${++selectIdCounter}`;
    trigger.className = `tp3d-select ${config.className || ''}`.trim();
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    let selectedValue = '';
    let disabled = false;
    let optionList = [];
    const valueEl = document.createElement('span');
    valueEl.className = 'tp3d-select__value';
    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-down tp3d-select__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.appendChild(valueEl);
    trigger.appendChild(chevron);

    const syncLabel = () => {
      const selected = optionList.find(option => option.value === selectedValue);
      const label = selected?.label || '';
      valueEl.textContent = label;
      valueEl.title = label;
      trigger.setAttribute('aria-label', `${config.label}: ${label}`);
    };
    const setValue = value => {
      const next = String(value ?? '');
      selectedValue = optionList.some(option => option.value === next) ? next : '';
      syncLabel();
    };
    const setOptions = options => {
      optionList = (Array.isArray(options) ? options : []).map(option => ({
        value: String(option.value), label: String(option.label), disabled: Boolean(option.disabled),
      }));
      if (!optionList.some(option => option.value === selectedValue)) {
        selectedValue = optionList[0]?.value || '';
      }
      syncLabel();
      if (trigger.getAttribute('aria-expanded') === 'true') closeAllDropdowns();
    };
    Object.defineProperties(trigger, {
      value: { get: () => selectedValue, set: setValue },
      disabled: {
        get: () => disabled,
        set: value => {
          disabled = Boolean(value);
          trigger.setAttribute('aria-disabled', String(disabled));
          trigger.tabIndex = disabled ? -1 : 0;
          if (disabled && trigger.getAttribute('aria-expanded') === 'true') closeAllDropdowns();
        },
      },
    });
    const control = /** @type {HTMLDivElement & {value: string, disabled: boolean,
     * setOptions: (options: Array<{value: string, label: string, disabled?: boolean}>) => void}} */ (trigger);
    control.setOptions = setOptions;
    setOptions(config.options);
    if (config.value !== undefined) setValue(config.value);
    control.disabled = Boolean(config.disabled);

    const open = () => {
      if (control.disabled) return;
      const items = optionList.map(option => ({
        ...option,
        selected: option.value === selectedValue,
        onClick: () => {
          if (option.value === selectedValue) return;
          setValue(option.value);
          control.dispatchEvent(new Event('change', { bubbles: true }));
        },
      }));
      openDropdown(control, items, { toggle: true, selectSemantics: true, selectLabel: config.label });
    };
    control.addEventListener('click', () => {
      control.focus();
      open();
    });
    control.addEventListener('keydown', ev => {
      if (control.disabled || control.getAttribute('aria-expanded') === 'true') return;
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
        ev.preventDefault();
        ev.stopPropagation();
        open();
      }
    });
    return control;
  }

  const components = {
    modalOwnership,
    showToast,
    showModal,
    showAutoPackLoadingOverlay,
    confirm,
    openDropdown,
    createSelect,
    closeAllDropdowns,
    registerDropdownSurface,
  };
  activeUIComponents = components;
  return components;
}
