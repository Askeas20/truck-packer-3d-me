import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { createUIComponents } from '../../src/ui/ui-components.js';
import { createHelpModal } from '../../src/ui/overlays/help-modal.js';
import { openNotesOverlay } from '../../src/ui/overlays/notes-overlay.js';
import { createKeyboardManager } from '../../src/ui/keyboard-manager.js';
import { createInteractionManager } from '../../src/screens/editor-screen.js';
import { normalizeRightAngleRotation } from '../../src/core/oriented-dims.js';
import { createSettingsOverlay, getKeyboardShortcutReference } from '../../src/ui/overlays/settings-overlay.js';
import { createAuthOverlay } from '../../src/ui/overlays/auth-overlay.js';
import { createSystemOverlay } from '../../src/ui/system-overlay.js';
import { createErrorOverlay } from '../../src/ui/error-overlay.js';

const PACKS_SCREEN_PATH = new URL('../../src/screens/packs-screen.js', import.meta.url);
const SETTINGS_OVERLAY_PATH = new URL('../../src/ui/overlays/settings-overlay.js', import.meta.url);

// Deterministic lifecycle/listener fixture, not a browser propagation proof.
// Real capture -> target -> bubble is additionally exercised in authenticated
// Chrome QA using Settings, nested dialogs, popups and Editor selection.
class Surface {
  listeners = [];
  addEventListener(type, fn, capture = false) {
    this.listeners.push({ type, fn, capture: Boolean(capture) });
  }
  removeEventListener(type, fn, capture = false) {
    this.listeners = this.listeners.filter(item =>
      item.type !== type || item.fn !== fn || item.capture !== Boolean(capture));
  }
  emit(type, event, capture = false) {
    for (const item of [...this.listeners]) {
      if (item.type === type && item.capture === capture) item.fn(event);
    }
  }
}

function mockStateStore(state) {
  const subscribers = new Set();
  return {
    get: key => state[key],
    set(patch) {
      Object.assign(state, patch);
      for (const subscriber of subscribers) subscriber(patch, state);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

function installDom(t) {
  const original = new Map(['window', 'document', 'HTMLElement', 'THREE', 'requestAnimationFrame']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const doc = new Surface();
  class Element extends Surface {
    constructor(tag = 'div') {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.className = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, on) => { this.classList[on ? 'add' : 'remove'](name); },
      };
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; return child; }
    remove() { this.parentElement?.removeChild(this); }
    contains(other) { return other === this || this.children.some(child => child.contains(other)); }
    get isConnected() { return this === doc.body || Boolean(this.parentElement?.isConnected); }
    getBoundingClientRect() { return { left: 100, top: 100, right: 200, bottom: 140, width: 100, height: 40 }; }
    get firstChild() { return this.children[0] || null; }
    set innerHTML(value) { this.html = value; for (const child of [...this.children]) child.remove(); }
    get innerHTML() { return this.html || ''; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    matches(selector) {
      return selector.split(',').some(part => {
        const key = part.trim();
        if (key === '[data-dropdown="1"]') return this.dataset.dropdown === '1';
        if (/^\[[\w-]+\]$/.test(key)) return this.hasAttribute(key.slice(1, -1));
        return key.toUpperCase() === this.tagName;
      });
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    focus() { doc.activeElement = this; }
    dispatchEvent(event) { this.emit(event.type, event); return true; }
  }
  doc.body = new Element('body');
  doc.activeElement = doc.body;
  const roots = new Map(['modal-root', 'toast-container', 'system-overlay', 'system-title',
    'system-message', 'system-list', 'system-retry', 'error-overlay', 'error-title',
    'error-body', 'error-actions', 'error-icon'].map(id => [id, doc.body.appendChild(new Element())]));
  doc.getElementById = id => roots.get(id) || null;
  doc.createElement = tag => new Element(tag);
  doc.createTextNode = text => Object.assign(new Element('span'), { textContent: text });
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  doc.querySelector = selector => doc.body.querySelector(selector);
  const win = Object.assign(new Surface(), {
    setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 1200, innerHeight: 800,
    location: { reload() { throw new Error('Unexpected reload'); } },
  });
  Object.assign(globalThis, {
    window: win, document: doc, HTMLElement: Element, THREE,
    requestAnimationFrame: fn => { fn(); return 1; },
  });
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const UI = createUIComponents();
  function key(keyName, target = doc.body, extra = {}) {
    const event = Object.assign({
      key: keyName, target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    }, extra);
    return event;
  }
  function dispatch(event) {
    win.emit('keydown', event, true);
    if (!event.stopped) doc.emit('keydown', event, true);
    if (!event.stopped) event.target.emit('keydown', event);
    if (!event.stopped) doc.emit('keydown', event);
    if (!event.stopped) win.emit('keydown', event);
    return event;
  }
  return { doc, win, UI, roots, key, dispatch };
}

function installKeyboard(dom) {
  const state = { currentScreen: 'editor', currentPackId: 'pack', selectedInstanceIds: ['cargo'] };
  const calls = { deselect: 0, selectAll: 0 };
  const pack = { id: 'pack', cases: [{ id: 'cargo' }] };
  createKeyboardManager({
    UIComponents: dom.UI,
    StateStore: { get: key => state[key], set: patch => Object.assign(state, patch) },
    PackLibrary: { getById: id => (id === pack.id ? pack : null) },
    CaseScene: { setSelected: () => { calls.deselect++; } },
    InteractionManager: { selectAllInPack: () => { calls.selectAll++; } },
  }).init();
  return { state, calls };
}

test('P0-SM-OF-2 registry supports identity, precedence, nesting and independent release', t => {
  const { UI, doc, key } = installDom(t);
  const registry = UI.modalOwnership;
  assert.equal(registry.getActiveOwner(), null);
  assert.equal(registry.blocksKeyboardEvent(key('Escape')), false);
  const element = doc.body.appendChild(doc.createElement('div'));
  const button = element.appendChild(doc.createElement('button'));
  const parent = registry.register({ element, kind: 'settings' });
  assert.equal(registry.getActiveOwner(), parent);
  button.focus();
  const child = registry.register();
  assert.equal(child.parentId, parent.id);
  assert.ok(child.order > parent.order);
  const explicit = registry.register({ parentId: child.id });
  assert.equal(explicit.parentId, child.id);
  parent.release();
  parent.release();
  assert.equal(registry.getOwners().length, 2);
  assert.equal(child.parentId, parent.id, 'parent identity survives out-of-order release');
  child.release();
  assert.equal(registry.getActiveOwner(), explicit);
  const recovery = registry.register({ priority: 1, parentId: null });
  const ordinary = registry.register();
  assert.equal(registry.getActiveOwner(), recovery, 'recovery takes precedence over later ordinary owners');
  recovery.release();
  assert.equal(registry.getActiveOwner(), ordinary);
  explicit.release();
  ordinary.release();
  assert.deepEqual(registry.getOwners(), []);
});

test('P0-SM-OF-2 entry ownership survives release, stays event-local and refreshes on redispatch', t => {
  const { UI, win, key } = installDom(t);
  const registry = UI.modalOwnership;
  const unowned = key('Escape');
  win.emit('keydown', unowned, true);
  assert.equal(registry.blocksKeyboardEvent(unowned), false);
  const owner = registry.register();
  const owned = key('Escape');
  win.emit('keydown', owned, true);
  owner.release();
  assert.equal(registry.blocksKeyboardEvent(owned), true);
  assert.equal(owned.defaultPrevented, true, 'protected owner consumes Escape');
  assert.equal(owned.stopped, true);
  const next = key('Escape');
  win.emit('keydown', next, true);
  assert.equal(registry.blocksKeyboardEvent(next), false);
  win.emit('keydown', owned, true);
  assert.equal(registry.blocksKeyboardEvent(owned), false, 'a fresh dispatch replaces its snapshot');
  const lateOwner = registry.register();
  assert.equal(registry.blocksKeyboardEvent(next), true, 'current ownership also blocks a late-arriving key');
  lateOwner.release();
});

test('P0-SM-OF-2 generic lifecycle registers once, supports reentrancy and leaves no stale owners', t => {
  const { UI, roots, key, dispatch } = installDom(t);
  let closes = 0;
  let replacement;
  const modal = UI.showModal({ onClose() {
    closes++;
    modal.close();
    assert.equal(UI.modalOwnership.getActiveOwner(), null, 'released before callback');
    replacement = UI.showModal({});
  } });
  assert.equal(UI.modalOwnership.getActiveOwner(), modal.owner);
  dispatch(key('Escape', modal.modal));
  assert.equal(UI.modalOwnership.getActiveOwner(), replacement.owner, 'Escape dismisses exactly one owner');
  modal.close();
  modal.close();
  assert.equal(closes, 1);
  assert.equal(UI.modalOwnership.getOwners().length, 1);
  replacement.close();
  for (let i = 0; i < 10; i++) {
    const next = UI.showModal({});
    next.close();
    next.close();
  }
  assert.deepEqual(UI.modalOwnership.getOwners(), []);
  assert.equal(roots.get('modal-root').children.length, 0);
});

test('P0-SM-OF-2 KeyboardManager preserves unowned shortcuts and typing, blocks owned and consumed keys', t => {
  const dom = installDom(t);
  const { calls, state } = installKeyboard(dom);
  dom.dispatch(dom.key('a', dom.doc.body, { metaKey: true }));
  assert.equal(calls.selectAll, 1);
  for (const tag of ['input', 'textarea', 'select']) dom.dispatch(dom.key('Escape', dom.doc.createElement(tag)));
  dom.dispatch(dom.key('Escape', Object.assign(dom.doc.createElement('div'), { isContentEditable: true })));
  assert.equal(calls.deselect, 0);
  dom.dispatch(dom.key('Escape', dom.doc.body, { defaultPrevented: true }));
  assert.equal(calls.deselect, 0);
  const modal = dom.UI.showModal({});
  dom.dispatch(dom.key('a', modal.modal, { ctrlKey: true }));
  dom.dispatch(dom.key('Escape', modal.modal));
  assert.equal(calls.deselect, 0);
  assert.equal(calls.selectAll, 1);
  assert.deepEqual(state.selectedInstanceIds, ['cargo']);
  modal.close();
  dom.dispatch(dom.key('Escape'));
  assert.equal(calls.deselect, 1);
  assert.deepEqual(state.selectedInstanceIds, []);
  dom.dispatch(dom.key('a', dom.doc.body, { ctrlKey: true }));
  assert.equal(calls.selectAll, 2);
});

// The real KeyboardManager over stub collaborators: every call is recorded so a
// test can tell an owned key (acted + prevented) from a pass-through (neither).
function installOwnedKeyboard(dom) {
  const viewport = dom.doc.body.appendChild(dom.doc.createElement('div'));
  const getRoot = dom.doc.getElementById;
  dom.doc.getElementById = id => (id === 'viewport' ? viewport : getRoot(id));
  const pack = { id: 'pack', cases: [{ id: 'cargo', caseId: 'case' }, { id: 'other', caseId: 'case' }] };
  const state = { currentScreen: 'editor', currentPackId: 'pack', selectedInstanceIds: ['cargo'] };
  const calls = { undo: 0, redo: 0, selectAll: 0, delete: 0, duplicate: [], grid: 0, shadows: 0, toasts: [] };
  let busy = false;
  let copyIndex = 0;
  createKeyboardManager({
    UIComponents: { ...dom.UI, showToast: message => calls.toasts.push(message) },
    StateStore: {
      get: key => state[key], set: patch => Object.assign(state, patch),
      undo: () => { calls.undo++; return true; }, redo: () => { calls.redo++; return true; },
    },
    PackLibrary: {
      getById: id => (id === pack.id ? pack : null),
      duplicateInstancesSafely: (_packId, source) => {
        calls.duplicate.push(source.map(inst => inst.id));
        const copies = source.map(inst => ({ ...inst, id: `copy-${++copyIndex}` }));
        pack.cases.push(...copies);
        return { newIds: copies.map(inst => inst.id), placement: 'packed' };
      },
    },
    CaseLibrary: { getCases: () => [] },
    CaseScene: { setSelected() {} },
    SceneManager: { toggleGrid: () => { calls.grid++; return true; }, toggleShadows: () => { calls.shadows++; return true; } },
    InteractionManager: {
      selectAllInPack: () => { calls.selectAll++; }, deleteSelection: () => { calls.delete++; },
    },
    OperationLifecycle: { isBusy: () => busy },
    Utils: { deepClone: value => JSON.parse(JSON.stringify(value)) },
  }).init();
  const cmd = { metaKey: true };
  const ctrl = { ctrlKey: true };
  const press = (key, target = dom.doc.body, extra = {}) => dom.dispatch(dom.key(key, target, extra));
  return { viewport, state, calls, cmd, ctrl, press, setBusy: value => { busy = value; } };
}

test('Shortcut contract: removed Cmd/Ctrl+O, Cmd/Ctrl+S and Cmd/Ctrl+Shift+A stay with the browser', t => {
  const dom = installDom(t);
  const kb = installOwnedKeyboard(dom);
  for (const screen of ['editor', 'packs']) {
    kb.state.currentScreen = screen;
    for (const modifier of [kb.cmd, kb.ctrl]) {
      for (const [key, extra] of [['o', {}], ['s', {}], ['a', { shiftKey: true }], ['A', { shiftKey: true }]]) {
        const event = kb.press(key, dom.doc.body, { ...modifier, ...extra });
        assert.equal(event.defaultPrevented, false, `${screen} ${JSON.stringify(modifier)} ${key}: not intercepted`);
      }
    }
  }
  assert.deepEqual(kb.state.selectedInstanceIds, ['cargo'], 'Cmd/Ctrl+Shift+A no longer deselects');
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), null, 'Cmd/Ctrl+O opens no Load Plan dialog');
  assert.deepEqual(kb.calls.toasts, [], 'Cmd/Ctrl+S shows no save feedback');
});

test('Shortcut contract: Cmd/Ctrl+D duplicates only in a valid Editor context, once per press', t => {
  const dom = installDom(t);
  const kb = installOwnedKeyboard(dom);
  for (const modifier of [kb.cmd, kb.ctrl]) {
    const owned = kb.press('d', dom.doc.body, modifier);
    assert.equal(owned.defaultPrevented, true, 'Editor + selected cargo owns Duplicate');
  }
  assert.equal(kb.calls.duplicate.length, 2);
  assert.deepEqual(kb.calls.duplicate[0], ['cargo']);
  const held = kb.press('d', dom.doc.body, { ...kb.ctrl, repeat: true });
  assert.equal(held.defaultPrevented, true, 'an auto-repeat stays owned so Bookmark cannot open mid-hold');
  assert.equal(kb.calls.duplicate.length, 2, 'auto-repeat never duplicates again');

  const passes = label => {
    const before = kb.calls.duplicate.length;
    for (const modifier of [kb.cmd, kb.ctrl]) {
      assert.equal(kb.press('d', dom.doc.body, modifier).defaultPrevented, false, `${label}: Bookmark stays available`);
    }
    assert.equal(kb.calls.duplicate.length, before, `${label}: nothing is duplicated`);
  };
  kb.setBusy(true);
  passes('busy operation');
  kb.setBusy(false);
  kb.state.selectedInstanceIds = ['missing'];
  passes('stale selection');
  kb.state.selectedInstanceIds = [];
  passes('empty selection');
  kb.state.selectedInstanceIds = ['cargo'];
  kb.state.currentScreen = 'packs';
  passes('Load Plans screen');
  kb.state.currentScreen = 'editor';
  const modal = dom.UI.showModal({});
  passes('modal owner');
  modal.close();
  assert.equal(kb.press('d', dom.doc.createElement('input'), kb.cmd).defaultPrevented, false, 'text fields keep native keys');
});

test('Shortcut contract: Copy, Paste and Select All are owned only when they act', t => {
  const dom = installDom(t);
  const kb = installOwnedKeyboard(dom);
  // Paste with an empty app clipboard is native Paste.
  assert.equal(kb.press('v', dom.doc.body, kb.cmd).defaultPrevented, false);
  assert.equal(kb.calls.duplicate.length, 0);
  // Copy with selected cargo is the app's.
  assert.equal(kb.press('c', dom.doc.body, kb.cmd).defaultPrevented, true);
  assert.match(kb.calls.toasts.at(-1), /Copied 1 case/);
  assert.equal(kb.press('c', dom.doc.body, { ...kb.ctrl, repeat: true }).defaultPrevented, true);
  assert.equal(kb.calls.toasts.filter(message => /Copied/.test(message)).length, 1, 'held Copy does not repeat its toast');
  // Paste with a usable app clipboard is the app's, once per press.
  assert.equal(kb.press('v', dom.doc.body, kb.ctrl).defaultPrevented, true);
  assert.deepEqual(kb.calls.duplicate, [['cargo']]);
  assert.equal(kb.press('v', dom.doc.body, { ...kb.cmd, repeat: true }).defaultPrevented, true);
  assert.equal(kb.calls.duplicate.length, 1, 'auto-repeat never pastes again');
  // Without selected cargo, off-Editor or in a text field, Copy is native.
  kb.state.selectedInstanceIds = [];
  assert.equal(kb.press('c', dom.doc.body, kb.cmd).defaultPrevented, false, 'nothing selected: native text Copy');
  kb.state.selectedInstanceIds = ['cargo'];
  assert.equal(kb.press('c', dom.doc.createElement('textarea'), kb.cmd).defaultPrevented, false);
  kb.state.currentScreen = 'cases';
  for (const key of ['c', 'v', 'a']) {
    assert.equal(kb.press(key, dom.doc.body, kb.cmd).defaultPrevented, false, `off-Editor ${key}: native behavior`);
  }
  // Select All is the app's only in the Editor with Pack cargo.
  kb.state.currentScreen = 'editor';
  assert.equal(kb.press('a', dom.doc.body, kb.ctrl).defaultPrevented, true);
  assert.equal(kb.calls.selectAll, 1);
  assert.equal(kb.press('a', dom.doc.body, { ...kb.cmd, repeat: true }).defaultPrevented, true);
  assert.equal(kb.calls.selectAll, 1, 'held Select All does not repeat');
  assert.equal(kb.press('a', dom.doc.createElement('input'), kb.cmd).defaultPrevented, false, 'text Select All stays native');
  kb.state.currentPackId = 'none';
  assert.equal(kb.press('a', dom.doc.body, kb.cmd).defaultPrevented, false, 'no Pack cargo: native Select All');
  assert.equal(kb.calls.selectAll, 1);
});

test('Shortcut contract: Undo/Redo are Editor-only, text-safe, and reach checkboxes', t => {
  const dom = installDom(t);
  const kb = installOwnedKeyboard(dom);
  assert.equal(kb.press('z', dom.doc.body, kb.cmd).defaultPrevented, true);
  assert.equal(kb.press('z', dom.doc.body, { ...kb.ctrl, shiftKey: true }).defaultPrevented, true);
  assert.deepEqual([kb.calls.undo, kb.calls.redo], [1, 1]);
  for (const tag of ['input', 'textarea']) {
    assert.equal(kb.press('z', dom.doc.createElement(tag), kb.cmd).defaultPrevented, false, `${tag}: native text Undo`);
  }
  const checkbox = Object.assign(dom.doc.createElement('input'), { type: 'checkbox' });
  const radio = Object.assign(dom.doc.createElement('input'), { type: 'radio' });
  assert.equal(kb.press('z', checkbox, kb.ctrl).defaultPrevented, true, 'a checkbox is not a text field');
  assert.equal(kb.press('Escape', radio).defaultPrevented, true, 'Escape still deselects from a radio');
  assert.deepEqual(kb.state.selectedInstanceIds, []);
  assert.equal(kb.press(' ', checkbox).defaultPrevented, false, 'Space toggling stays native');
  assert.deepEqual([kb.calls.undo, kb.calls.redo], [2, 1]);
  kb.state.currentScreen = 'packs';
  assert.equal(kb.press('z', dom.doc.body, kb.cmd).defaultPrevented, false, 'outside the Editor: browser Undo');
  assert.equal(kb.press('z', dom.doc.body, { ...kb.cmd, shiftKey: true }).defaultPrevented, false);
  assert.deepEqual([kb.calls.undo, kb.calls.redo], [2, 1]);
});

test('Shortcut contract: G/S and Delete are bare, viewport-owned Editor keys; Escape owns only a selection', t => {
  const dom = installDom(t);
  const kb = installOwnedKeyboard(dom);
  assert.equal(kb.press('g', kb.viewport).defaultPrevented, true);
  assert.equal(kb.press('s', kb.viewport).defaultPrevented, true);
  assert.equal(kb.press('g', kb.viewport, { repeat: true }).defaultPrevented, true);
  assert.deepEqual([kb.calls.grid, kb.calls.shadows], [1, 1], 'auto-repeat never toggles again');
  for (const extra of [kb.cmd, kb.ctrl, { altKey: true }, { shiftKey: true }]) {
    assert.equal(kb.press('g', kb.viewport, extra).defaultPrevented, false, `G with ${JSON.stringify(extra)}`);
    assert.equal(kb.press('s', kb.viewport, extra).defaultPrevented, false, `S with ${JSON.stringify(extra)}`);
  }
  assert.equal(kb.press('g', dom.doc.body).defaultPrevented, false, 'G off the viewport is not a shortcut');
  assert.equal(kb.press('Delete', dom.doc.body).defaultPrevented, false);
  assert.equal(kb.press('Backspace', kb.viewport).defaultPrevented, true);
  assert.equal(kb.calls.delete, 1);
  kb.state.currentScreen = 'packs';
  for (const key of ['g', 's', 'Delete', 'Backspace']) {
    assert.equal(kb.press(key, kb.viewport).defaultPrevented, false, `off-Editor ${key}: not intercepted`);
  }
  assert.deepEqual([kb.calls.grid, kb.calls.shadows, kb.calls.delete], [1, 1, 1]);
  assert.equal(kb.press('Escape').defaultPrevented, false, 'off-Editor Escape is free for the next owner');
  assert.deepEqual(kb.state.selectedInstanceIds, ['cargo']);
  kb.state.currentScreen = 'editor';
  assert.equal(kb.press('Escape').defaultPrevented, true, 'Escape owns an Editor selection');
  assert.deepEqual(kb.state.selectedInstanceIds, []);
  assert.equal(kb.press('Escape').defaultPrevented, false, 'with nothing selected, Escape passes on');
});

test('P0-SM-OF-2 actual document and Editor window listeners share the entry snapshot after capture closure', t => {
  const dom = installDom(t);
  const { calls } = installKeyboard(dom);
  let editorMutatingAttempts = 0;
  createInteractionManager({
    UIComponents: { ...dom.UI, showToast() {} },
    StateStore: mockStateStore({ currentScreen: 'editor', selectedInstanceIds: [] }),
    CaseScene: {},
    OperationLifecycle: { isBusy() { editorMutatingAttempts++; return true; } },
  }).init(dom.doc.body.appendChild(dom.doc.createElement('div')).appendChild(dom.doc.createElement('canvas')));
  const owner = dom.UI.modalOwnership.register({ onDismiss: () => owner.release() });
  const escape = dom.dispatch(dom.key('Escape'));
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), null);
  assert.equal(dom.UI.modalOwnership.blocksKeyboardEvent(escape), true);
  assert.equal(calls.deselect, 0);
  const rotationOwner = dom.UI.modalOwnership.register();
  dom.doc.addEventListener('keydown', () => rotationOwner.release(), true);
  const rotation = dom.dispatch(dom.key('r'));
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), null);
  assert.equal(editorMutatingAttempts, 0);
  assert.equal(rotation.defaultPrevented, false);
  dom.dispatch(dom.key('r', dom.doc.body, { defaultPrevented: true }));
  assert.equal(editorMutatingAttempts, 0);
  dom.dispatch(dom.key('r', dom.doc.createElement('input')));
  assert.equal(editorMutatingAttempts, 0);
  assert.equal(dom.dispatch(dom.key('r')).defaultPrevented, false, 'unfocused Editor key does not rotate');
  const viewport = dom.doc.body.children.at(-1);
  assert.equal(dom.dispatch(dom.key('r', viewport)).defaultPrevented, true);
  assert.equal(editorMutatingAttempts, 1, 'focused viewport dispatch resumes');
  dom.dispatch(dom.key('Escape'));
  assert.equal(calls.deselect, 1);
});

test('P0-SM-OF-2 unowned Escape still cancels a live gizmo drag after KeyboardManager consumes it', t => {
  const dom = installDom(t);
  const { calls } = installKeyboard(dom);
  const controls = { enabled: true };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const handle = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  handle.userData.gizmoHandle = 'y';
  handle.updateMatrixWorld();
  t.after(() => { handle.geometry.dispose(); handle.material.dispose(); });
  const cargo = { position: new THREE.Vector3() };
  const canvas = dom.doc.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  canvas.setPointerCapture = () => {};
  createInteractionManager({
    UIComponents: dom.UI,
    StateStore: mockStateStore({ currentScreen: 'editor', selectedInstanceIds: ['cargo'] }),
    SceneManager: { getCamera: () => camera, getControls: () => controls },
    CaseScene: {
      getGizmoHandleMeshes: () => [handle], getGizmoTargetId: () => 'cargo',
      getObject: () => cargo, setDragging() {}, setGizmoActive() {},
      updateGizmoTransform() {}, setCollision() {}, refreshGizmo() {}, setHover() {},
    },
  }).init(canvas);
  canvas.emit('pointerdown', { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
  assert.equal(controls.enabled, false, 'actual pointer handler began a gizmo drag');
  cargo.position.y = 5;
  const owner = dom.UI.modalOwnership.register({ onDismiss: () => owner.release() });
  dom.dispatch(dom.key('Escape', canvas));
  assert.equal(controls.enabled, false, 'owned Escape cannot reach drag cancellation, even after capture close');
  assert.equal(cargo.position.y, 5);
  assert.equal(calls.deselect, 0);
  const nextEscape = dom.dispatch(dom.key('Escape', canvas));
  assert.equal(nextEscape.defaultPrevented, true);
  assert.equal(calls.deselect, 1, 'KeyboardManager handled ordinary Escape first');
  assert.equal(controls.enabled, true, 'Editor continuation releases camera controls');
  assert.equal(cargo.position.y, 0, 'Editor continuation restores the drag start');
});

test('Editor pointer cancellation restores gizmo pose and camera without committing', t => {
  const dom = installDom(t);
  const controls = { enabled: true };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const handle = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  handle.userData.gizmoHandle = 'y';
  handle.updateMatrixWorld();
  t.after(() => { handle.geometry.dispose(); handle.material.dispose(); });
  const cargo = { position: new THREE.Vector3() };
  const selection = ['cargo'];
  const canvas = dom.doc.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  canvas.setPointerCapture = () => {};
  createInteractionManager({
    UIComponents: dom.UI,
    StateStore: mockStateStore({ currentScreen: 'editor', selectedInstanceIds: selection }),
    SceneManager: { getCamera: () => camera, getControls: () => controls },
    CaseScene: {
      getGizmoHandleMeshes: () => [handle], getGizmoTargetId: () => 'cargo',
      getObject: () => cargo, setDragging() {}, setGizmoActive() {},
      updateGizmoTransform() {}, setCollision() {}, refreshGizmo() {}, setHover() {},
    },
  }).init(canvas);
  canvas.emit('pointerdown', { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
  assert.equal(controls.enabled, false);
  cargo.position.y = 5;
  canvas.emit('pointercancel', { pointerId: 1 });
  assert.equal(cargo.position.y, 0);
  assert.equal(controls.enabled, true);
  assert.deepEqual(selection, ['cargo']);
  canvas.emit('lostpointercapture', { pointerId: 1 });
  assert.equal(cargo.position.y, 0, 'a following lost-capture event is harmless');
});

// Real InteractionManager over stub collaborators: the gizmo stroke and its
// not-directly-valid release run the production pointer handlers, so a held
// (scene-only) pose and a live drag are the genuine Editor states.
function installProvisionalEditor(t, dom) {
  const controls = { enabled: true };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const handle = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  handle.userData.gizmoHandle = 'y';
  handle.updateMatrixWorld();
  t.after(() => { handle.geometry.dispose(); handle.material.dispose(); });
  const cargo = new THREE.Object3D();
  cargo.userData.halfWorld = { x: 0.5, y: 0.5, z: 0.5 };
  const inst = { id: 'cargo', caseId: 'case', placement: 'packed',
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } };
  const pack = { id: 'pack', cases: [inst] };
  const state = { currentScreen: 'editor', currentPackId: 'pack', selectedInstanceIds: ['cargo'] };
  const commits = [];
  const toasts = [];
  let placement = { ok: false, code: 'support-rules', reason: 'Needs support below.' };
  const viewport = dom.doc.body.appendChild(dom.doc.createElement('div'));
  const canvas = viewport.appendChild(dom.doc.createElement('canvas'));
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  canvas.setPointerCapture = () => {};
  const interaction = createInteractionManager({
    UIComponents: { ...dom.UI, showToast: message => toasts.push(message) },
    StateStore: mockStateStore(state),
    SceneManager: {
      getCamera: () => camera, getControls: () => controls, toWorld: value => value,
      vecWorldToInches: v => ({ x: v.x, y: v.y, z: v.z }),
      vecInchesToWorld: p => new THREE.Vector3(p.x, p.y, p.z),
    },
    CaseScene: {
      getGizmoHandleMeshes: () => [handle], getGizmoTargetId: () => 'cargo', getGizmoTargetMode: () => 'packed',
      getObject: () => cargo, setDragging() {}, setGizmoActive() {}, updateGizmoTransform() {},
      setCollision() {}, refreshGizmo() {}, setHover() {}, setSelected() {}, applyOOGHighlights() {}, sync() {},
      checkCollision: () => ({ collides: false, insideTruck: true }), settleY: () => null,
    },
    PackLibrary: {
      getById: () => pack,
      normalizeRightAngleRotation,
      isOrientationAllowedByCasePolicy: () => true,
      findManualVerticalPlacement: (_pack, _cases, _id, options) => ({ ...placement, mode: options.mode }),
      updateCasesWithManualRevalidation: (...args) => { commits.push(args); return { pack, stagedIds: [] }; },
    },
    CaseLibrary: { getById: () => ({ id: 'case', orientationLock: 'any', dimensions: { length: 1, width: 1, height: 1 } }), getCases: () => [] },
    OperationLifecycle: { isBusy: () => false },
  });
  interaction.init(canvas);
  const press = (key, extra) => dom.dispatch(dom.key(key, viewport, extra));
  const beginStroke = () => canvas.emit('pointerdown', { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
  const endStroke = () => dom.win.emit('pointerup', { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
  return { cargo, controls, commits, toasts, press, beginStroke, endStroke, interaction,
    allowPlacement: position => { placement = { ok: true, position }; } };
}

test('C3 UI01 refuses exact-constraint edits during live and held temporary poses', t => {
  const dom = installDom(t);
  const editor = installProvisionalEditor(t, dom);
  editor.beginStroke();
  assert.equal(editor.interaction.setSelectionOrientationConstraint(true), false);
  assert.equal(editor.interaction.setSelectionOrientationConstraint(false), false);
  editor.cargo.position.y = 3;
  editor.endStroke();
  assert.equal(editor.interaction.hasProvisionalPose(), true);
  assert.equal(editor.interaction.setSelectionOrientationConstraint(true), false);
  assert.equal(editor.interaction.setSelectionOrientationConstraint(false), false);
  assert.equal(editor.commits.length, 0);
  assert.equal(editor.cargo.position.y, 3, 'refusal preserves the held scene pose');
  assert.match(editor.toasts.at(-1), /Place or cancel the held case first/);
});

test('Editor provisional pose owns R/T/E/F and arrow keys until it is placed or cancelled', t => {
  const dom = installDom(t);
  const editor = installProvisionalEditor(t, dom);
  editor.beginStroke();
  editor.cargo.position.y = 3;
  editor.endStroke();
  assert.equal(editor.commits.length, 0, 'a not-directly-valid release holds a scene-only pose');
  assert.match(editor.toasts.at(-1), /Case held above the load/);
  for (const key of ['r', 'T', 'e', 'F', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    const event = editor.press(key);
    assert.equal(event.defaultPrevented, true, `${key}: the viewport still owns the key`);
    assert.equal(editor.commits.length, 0, `${key}: a held pose never commits through a transform or nudge`);
  }
  assert.equal(editor.cargo.position.y, 3, 'the held scene pose is untouched');
  assert.equal(editor.cargo.rotation.x, 0, 'no rotation was applied to the held case');
  editor.allowPlacement({ x: 0, y: 3, z: 0 });
  editor.press('Enter');
  assert.equal(editor.commits.length, 1, 'Enter still places the held case through the validated resolve');
  editor.press('r');
  assert.equal(editor.commits.length, 2, 'once placed, R turns the case normally');
});

// Settings → Resources → Keyboard Shortcuts must document exactly the runtime
// contract. Forward: every documented combo (Command and Ctrl forms) is owned by
// the real KeyboardManager / InteractionManager. Reverse: every key those handlers
// bind appears in the reference, so neither side can drift silently.
test('Resources Keyboard Shortcuts reference documents exactly the runtime shortcut contract', t => {
  const dom = installDom(t);
  const kb = installOwnedKeyboard(dom);
  const editor = installProvisionalEditor(t, dom);
  // A held Case makes Enter placeable; every other documented key is owned regardless.
  editor.beginStroke();
  editor.cargo.position.y = 3;
  editor.endStroke();

  const reference = getKeyboardShortcutReference({ apple: false });
  const arrowKeys = { arrows: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], up: ['ArrowUp'], down: ['ArrowDown'] };
  const namedKeys = { enter: 'Enter', escape: 'Escape', delete: 'Delete', backspace: 'Backspace' };
  const editorViewportKeys = new Set(['r', 't', 'e', 'f', 'arrows', 'up', 'down', 'enter']);
  const managerViewportKeys = new Set(['delete', 'backspace', 'g', 's']);
  const documented = new Set();
  for (const section of reference) {
    for (const row of section.rows) {
      for (const { tokens } of row.combos) {
        const base = tokens.at(-1);
        const shift = tokens.includes('shift');
        const modifierSets = tokens.includes('mod') ? [{ metaKey: true }, { ctrlKey: true }] : [{}];
        const keyNames = arrowKeys[base] || [namedKeys[base] || (shift ? base.toUpperCase() : base)];
        documented.add(tokens.map(token => (token === 'up' || token === 'down' ? 'arrows' : token)).join('+'));
        for (const modifiers of modifierSets) {
          for (const key of keyNames) {
            const extra = { ...modifiers, shiftKey: shift, altKey: tokens.includes('alt') };
            const target = editorViewportKeys.has(base) ? null : managerViewportKeys.has(base) ? kb.viewport : dom.doc.body;
            const event = target ? kb.press(key, target, extra) : editor.press(key, extra);
            assert.equal(event.defaultPrevented, true,
              `"${row.action}" (${JSON.stringify(extra)} ${key}) is owned by the runtime shortcut handlers`);
          }
        }
      }
    }
  }

  // Runtime keys in the reference's vocabulary: Cmd/Ctrl → mod, any arrow → arrows.
  const normalize = key => key.toLowerCase().split('+')
    .map(part => (part === 'meta' || part === 'ctrl' ? 'mod' : /^arrow/.test(part) ? 'arrows' : part)).join('+');
  const managerSrc = readFileSync(new URL('../../src/ui/keyboard-manager.js', import.meta.url), 'utf8');
  const mapBlock = managerSrc.slice(managerSrc.indexOf('\n    shortcuts = {\n'), managerSrc.indexOf('\n    };', managerSrc.indexOf('\n    shortcuts = {\n')));
  const managerKeys = [...mapBlock.matchAll(/^\s*'?([\w+]+)'?\s*:/gm)].map(match => normalize(match[1]));
  const editorSrc = readFileSync(new URL('../../src/screens/editor-screen.js', import.meta.url), 'utf8');
  const keyBlock = editorSrc.slice(editorSrc.indexOf('function onKeyDown(ev)'), editorSrc.indexOf('function onMove(ev)'));
  const editorKeys = [...keyBlock.matchAll(/case '([^']+)':/g)].map(match => normalize(match[1]));
  assert.ok(managerKeys.length >= 10 && editorKeys.length >= 10, 'both runtime key maps were read');
  for (const key of [...managerKeys, ...editorKeys]) {
    assert.ok(documented.has(key), `runtime binding "${key}" appears in the Resources reference`);
  }

  // Removed and browser-owned combinations never appear in the reference.
  for (const removed of ['mod+o', 'mod+s', 'mod+shift+a', 'mod+p', 'p', 'shift+f', 'mod+f', 'mod+r', 'mod+y']) {
    assert.equal(documented.has(removed), false, `"${removed}" is not documented`);
  }
});

test('Editor live drag owns R/T/E/F and arrow keys; Escape still cancels it', t => {
  const dom = installDom(t);
  const editor = installProvisionalEditor(t, dom);
  editor.beginStroke();
  assert.equal(editor.controls.enabled, false, 'a live gizmo stroke is active');
  editor.cargo.position.y = 2;
  for (const key of ['R', 't', 'E', 'f', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    editor.press(key);
    assert.equal(editor.commits.length, 0, `${key}: a live drag never commits through a transform or nudge`);
  }
  for (const key of ['ArrowUp', 'ArrowDown']) {
    editor.press(key, { altKey: true });
    assert.equal(editor.commits.length, 0, `Alt+${key}: a live drag never commits a vertical move`);
  }
  assert.equal(editor.cargo.position.y, 2);
  editor.press('Escape');
  assert.equal(editor.controls.enabled, true, 'Escape still cancels the live stroke');
  assert.equal(editor.cargo.position.y, 0, 'the stroke returns to its start pose');
  assert.equal(editor.commits.length, 0);
});

test('P0-SM-OF-2 Settings reuses, closes, reopens and cleans disconnected ownership', t => {
  const dom = installDom(t);
  const { calls } = installKeyboard(dom);
  const settings = createSettingsOverlay({
    UIComponents: dom.UI, documentRef: dom.doc,
    PreferencesManager: { get: () => ({}) }, Utils: {},
  });
  for (let i = 0; i < 3; i++) {
    const unrelated = dom.UI.showModal({});
    unrelated.modal.focus();
    settings.open('resources');
    const owner = dom.UI.modalOwnership.getActiveOwner();
    assert.equal(owner.kind, 'settings');
    assert.equal(owner.parentId, null, 'Settings remains a root even when another modal had focus');
    unrelated.close();
    settings.open('resources');
    assert.equal(dom.UI.modalOwnership.getActiveOwner(), owner);
    dom.dispatch(dom.key('Escape', owner.element));
    assert.equal(settings.isOpen(), false);
    assert.equal(dom.UI.modalOwnership.getActiveOwner(), null);
    assert.equal(calls.deselect, 0, 'legacy capture close must not expose this event');
    settings.close();
  }
  settings.open('resources');
  const stale = dom.UI.modalOwnership.getActiveOwner();
  stale.element.remove();
  settings.open('resources');
  const next = dom.UI.modalOwnership.getActiveOwner();
  assert.notEqual(next.id, stale.id);
  assert.deepEqual(dom.UI.modalOwnership.getOwners(), [next]);
  stale.element._tp3dCleanup();
  assert.deepEqual(dom.UI.modalOwnership.getOwners(), [next]);
  dom.dispatch(dom.key('Escape', next.element));
  assert.equal(settings.isOpen(), false, 'stale cleanup cannot remove the new capture handler');
  dom.dispatch(dom.key('Escape'));
  assert.equal(calls.deselect, 1);
});

test('P0-SM-OF-2 Auth and recovery register presence idempotently without new dismissal', t => {
  const dom = installDom(t);
  const system = createSystemOverlay({ UIComponents: dom.UI });
  const error = createErrorOverlay({ UIComponents: dom.UI });
  const auth = createAuthOverlay({ UIComponents: dom.UI });
  system.show({});
  const systemOwner = dom.UI.modalOwnership.getActiveOwner();
  assert.equal(dom.doc.body.classList.contains('modal-open'), true);
  system.show({ title: 'Updated' });
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), systemOwner);
  error.showNotFound();
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), systemOwner, 'recoverable error stays under terminal System');
  error.showFatal();
  const errorOwner = dom.UI.modalOwnership.getActiveOwner();
  assert.equal(errorOwner.kind, 'error', 'fatal replaces the recoverable owner at terminal precedence');
  error.showMaintenance();
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), errorOwner);
  const ordinary = dom.UI.showModal({});
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), errorOwner);
  auth.show();
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), errorOwner, 'terminal error supersedes Auth');
  const authOwner = dom.UI.modalOwnership.getOwners().find(owner => owner.kind === 'auth');
  assert.equal(authOwner.parentId, null);
  assert.equal(dom.doc.body.classList.contains('modal-open'), true);
  auth.show();
  assert.equal(dom.UI.modalOwnership.getOwners().length, 4);
  dom.dispatch(dom.key('Escape'));
  assert.equal(auth.isOpen(), true);
  auth.hide();
  auth.hide();
  assert.equal(dom.doc.body.classList.contains('modal-open'), true, 'Auth release keeps recovery and ordinary locks');
  dom.dispatch(dom.key('Escape'));
  assert.equal(error.isVisible(), true);
  assert.equal(dom.roots.get('system-overlay').classList.contains('active'), true);
  error.hide();
  assert.equal(error.isVisible(), true, 'recovery cleanup cannot hide a terminal error');
  error.hide({ includeTerminal: true });
  error.hide({ includeTerminal: true });
  assert.equal(dom.doc.body.classList.contains('modal-open'), true, 'Error release keeps System and ordinary locks');
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), systemOwner);
  system.hide();
  system.hide();
  assert.equal(dom.doc.body.classList.contains('modal-open'), true, 'System release keeps the ordinary lock');
  ordinary.close();
  assert.deepEqual(dom.UI.modalOwnership.getOwners(), []);
  assert.equal(dom.doc.body.classList.contains('modal-open'), false);
});

test('P0-SM-OF-3 Settings popup and child consume one Escape at a time without background effects', async t => {
  const dom = installDom(t);
  const { calls, state } = installKeyboard(dom);
  const settings = createSettingsOverlay({
    UIComponents: dom.UI, documentRef: dom.doc,
    PreferencesManager: { get: () => ({}) }, Utils: {},
  });
  const registry = dom.UI.modalOwnership;
  for (let i = 0; i < 3; i++) {
    settings.open('resources');
    const parent = registry.getActiveOwner();
    const anchor = parent.element.appendChild(dom.doc.createElement('button'));
    const popup = dom.UI.openDropdown(anchor, []);
    const popupOwner = registry.getActiveOwner();
    assert.equal(popupOwner.parentId, parent.id);
    assert.equal(popup.parentElement.className, 'modal-popup-host');
    assert.equal(popup.parentElement.parentElement, parent.element);
    const escape = dom.dispatch(dom.key('Escape', anchor));
    assert.equal(registry.getEscapeClaim(escape), popupOwner.id);
    assert.equal(registry.blocksKeyboardEvent(escape), true);
    assert.equal(popup.isConnected, false);
    assert.equal(settings.isOpen(), true);
    popupOwner.release();
    assert.deepEqual(registry.getOwners(), [parent]);
    anchor.focus();
    let settlements = 0;
    const result = dom.UI.confirm({ title: 'Child' }).then(value => { settlements++; return value; });
    const child = registry.getActiveOwner();
    assert.equal(child.parentId, parent.id);
    dom.dispatch(dom.key('Escape', anchor));
    assert.equal(await result, false);
    assert.equal(settlements, 1);
    assert.equal(settings.isOpen(), true);
    assert.equal(child.element.isConnected, false);
    assert.deepEqual(registry.getOwners(), [parent]);
    dom.dispatch(dom.key('Escape', anchor));
    assert.equal(settings.isOpen(), false);
    assert.deepEqual(registry.getOwners(), []);
    assert.deepEqual(state.selectedInstanceIds, ['cargo']);
    assert.equal(calls.deselect, 0);
  }
  dom.dispatch(dom.key('Escape'));
  assert.equal(calls.deselect, 1);
});

test('P0-SM-OF-3 later child supersedes popup; parent teardown removes children and popup exactly once', t => {
  const { UI, doc, dispatch, key } = installDom(t);
  const parent = UI.showModal({});
  const anchor = parent.body.appendChild(doc.createElement('button'));
  const popup = UI.openDropdown(anchor, []);
  const popupOwner = UI.modalOwnership.getActiveOwner();
  let closes = 0;
  const child = UI.showModal({ parentOwnerId: parent.owner.id, onClose: () => { closes++; } });
  dispatch(key('Escape'));
  assert.equal(closes, 1);
  assert.equal(UI.modalOwnership.getActiveOwner(), popupOwner);
  assert.equal(popup.isConnected, true);
  assert.equal(child.overlay.isConnected, false);
  const other = UI.showModal({ parentOwnerId: parent.owner.id, onClose: () => { closes++; } });
  parent.close();
  parent.close();
  assert.equal(popup.isConnected, false);
  assert.equal(other.overlay.isConnected, false);
  assert.equal(closes, 2);
  assert.deepEqual(UI.modalOwnership.getOwners(), []);
  UI.closeAllDropdowns();
});

test('P0-SM-OF-3 user dismissal can be vetoed dynamically; programmatic close remains independent', t => {
  const { UI, dispatch, key } = installDom(t);
  let busy = true;
  let closes = 0;
  const modal = UI.showModal({ canDismiss: () => !busy, onClose: () => { closes++; } });
  assert.equal(dispatch(key('Escape')).defaultPrevented, true);
  modal.modal.children[0].children[1].emit('click', {});
  modal.overlay.emit('click', { target: modal.overlay });
  assert.equal(closes, 0);
  busy = false;
  assert.equal(modal.requestDismiss('escape'), true);
  assert.equal(closes, 1);
  const protectedModal = UI.showModal({ dismissible: false, canDismiss: () => false });
  dispatch(key('Escape'));
  assert.equal(protectedModal.overlay.isConnected, true);
  protectedModal.close();
  assert.deepEqual(UI.modalOwnership.getOwners(), []);
});

test('P0-SM-OF-3 page dropdowns retain body mounting and the shared Escape path', t => {
  const { UI, doc, dispatch, key } = installDom(t);
  const anchor = doc.body.appendChild(doc.createElement('button'));
  const popup = UI.openDropdown(anchor, []);
  assert.equal(popup.parentElement, doc.body);
  assert.equal(popup.style.zIndex, '16000');
  assert.equal(UI.modalOwnership.getActiveOwner().parentId, null);
  dispatch(key('Escape', anchor));
  assert.equal(popup.isConnected, false);
  assert.equal(UI.modalOwnership.getActiveOwner(), null);
});

test('shared select uses one popup lifecycle, preserves value semantics, and skips disabled options', async t => {
  const { UI, doc, win, dispatch, key } = installDom(t);
  const select = doc.body.appendChild(UI.createSelect({
    label: 'Test choice', value: 'a',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Blocked', disabled: true },
      { value: 'c', label: 'Charlie' },
    ],
  }));
  let changes = 0;
  select.addEventListener('change', () => { changes++; });
  assert.equal(select.value, 'a');
  assert.equal(select.getAttribute('role'), 'combobox');
  assert.equal(select.getAttribute('aria-expanded'), 'false');
  assert.match(select.getAttribute('aria-label'), /Test choice: Alpha/);
  select.value = 'c';
  assert.equal(changes, 0, 'programmatic assignments stay silent');
  assert.match(select.getAttribute('aria-label'), /Charlie/);
  select.value = 'a';

  select.disabled = true;
  select.emit('click', {});
  assert.equal(doc.querySelector('[data-dropdown="1"]'), null);
  assert.equal(select.getAttribute('aria-disabled'), 'true');
  select.disabled = false;
  select.focus();
  dispatch(key('Enter', select));
  let popup = doc.querySelector('[data-dropdown="1"]');
  assert.ok(popup);
  assert.equal(select.getAttribute('aria-expanded'), 'true');
  assert.equal(select.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(popup.children[0].getAttribute('role'), 'listbox');
  assert.equal(select.getAttribute('aria-controls'), popup.children[0].id);
  const options = popup.children[0].children;
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.equal(options[1].getAttribute('aria-disabled'), 'true');
  options[1].emit('click', { stopPropagation() {} });
  assert.equal(select.value, 'a', 'disabled option cannot commit');
  assert.equal(changes, 0);
  dispatch(key('ArrowDown', select));
  assert.equal(select.getAttribute('aria-activedescendant'), options[2].id);
  dispatch(key('Home', select));
  assert.equal(select.getAttribute('aria-activedescendant'), options[0].id);
  dispatch(key('End', select));
  assert.equal(select.getAttribute('aria-activedescendant'), options[2].id);
  dispatch(key('ArrowUp', select));
  assert.equal(select.getAttribute('aria-activedescendant'), options[0].id);
  dispatch(key('ArrowDown', select));
  dispatch(key(' ', select));
  assert.equal(select.value, 'c');
  assert.equal(changes, 1);
  assert.equal(select.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, select);

  dispatch(key(' ', select));
  popup = doc.querySelector('[data-dropdown="1"]');
  assert.ok(popup, 'Space reopens the same primitive');
  dispatch(key('Escape', select));
  assert.equal(popup.isConnected, false);
  assert.equal(doc.activeElement, select);
  assert.equal(select.getAttribute('aria-controls'), null);

  select.emit('click', {});
  popup = doc.querySelector('[data-dropdown="1"]');
  assert.ok(popup, 'click opens');
  await new Promise(resolve => setTimeout(resolve, 0));
  doc.emit('click', {}, true);
  assert.equal(popup.isConnected, false, 'outside click closes');

  select.setOptions([{ value: 'd', label: 'Delta' }]);
  assert.equal(select.value, 'd');
  assert.match(select.getAttribute('aria-label'), /Delta/);
  win.innerWidth = 220;
  select.getBoundingClientRect = () => ({ left: 175, top: 100, right: 215, bottom: 140, width: 40, height: 40 });
  select.emit('click', {});
  popup = doc.querySelector('[data-dropdown="1"]');
  assert.ok(Number.parseInt(popup.style.width, 10) <= 204, 'popup width is viewport-clamped');
  assert.ok(Number.parseInt(popup.style.left, 10) >= 8, 'popup stays in the viewport');
  UI.closeAllDropdowns();
});

test('shared select popup belongs to its modal and closes with the parent', t => {
  const { UI, doc, dispatch, key } = installDom(t);
  const parent = UI.showModal({});
  const select = parent.body.appendChild(UI.createSelect({
    label: 'Modal choice', options: [{ value: 'a', label: 'Alpha' }],
  }));
  select.focus();
  select.emit('click', {});
  const popup = doc.querySelector('[data-dropdown="1"]');
  assert.equal(popup.parentElement.parentElement, parent.overlay);
  assert.equal(UI.modalOwnership.getActiveOwner().parentId, parent.owner.id);
  dispatch(key('Escape', select));
  assert.equal(popup.isConnected, false);
  assert.equal(parent.overlay.isConnected, true);
  select.emit('click', {});
  const reopened = doc.querySelector('[data-dropdown="1"]');
  parent.close();
  assert.equal(reopened.isConnected, false);
  assert.deepEqual(UI.modalOwnership.getOwners(), []);
});

test('P0-SM-OF-3 persistent surface registration and cleanup are idempotent across re-registration', t => {
  const { UI, dispatch, key } = installDom(t);
  let open = false;
  let closes = 0;
  const surface = { isOpen: () => open, close: () => { open = false; closes++; } };
  const release = UI.registerDropdownSurface(surface);
  assert.equal(UI.registerDropdownSurface(surface), release);
  assert.equal(UI.modalOwnership.getOwners().length, 1);
  assert.equal(UI.modalOwnership.blocksKeyboardEvent(key('a')), false, 'inactive surfaces do not block shortcuts');
  open = true;
  dispatch(key('Escape'));
  assert.equal(closes, 1);
  release();
  release();
  assert.deepEqual(UI.modalOwnership.getOwners(), []);
  const nextRelease = UI.registerDropdownSurface(surface);
  release();
  assert.equal(UI.modalOwnership.getOwners().length, 1, 'stale cleanup cannot unregister a new registration');
  nextRelease();
  open = true;
  assert.equal(UI.modalOwnership.blocksKeyboardEvent(key('Escape')), false, 'no orphaned active owner remains');
});

test('P0-SM-OF-3 dropdown-launched dialogs retain their modal parent after popup teardown', t => {
  const { UI, doc, dispatch, key } = installDom(t);
  const parent = UI.showModal({});
  const anchor = parent.body.appendChild(doc.createElement('button'));
  let child;
  const popup = UI.openDropdown(anchor, [{ label: 'Child', onClick: () => { child = UI.showModal({}); } }]);
  const item = popup.querySelector('button');
  item.focus();
  item.emit('click', { stopPropagation() {} });
  assert.equal(popup.isConnected, false);
  assert.equal(child.owner.parentId, parent.owner.id);
  assert.equal(child.overlay.isConnected, true);
  dispatch(key('Escape'));
  assert.equal(child.overlay.isConnected, false);
  assert.equal(parent.overlay.isConnected, true);
  parent.close();
});

test('P0-SM-OF-3 protected import-style modal consumes Escape and preserves existing X and Cancel', t => {
  const { UI, dispatch, key } = installDom(t);
  let closes = 0;
  const config = { dismissible: false, actions: [{ label: 'Cancel' }], onClose: () => { closes++; } };
  const first = UI.showModal(config);
  dispatch(key('Escape'));
  assert.equal(closes, 0);
  first.modal.children[0].children[1].emit('click', {});
  assert.equal(closes, 1);
  const second = UI.showModal(config);
  dispatch(key('Escape'));
  second.modal.children[2].children[0].emit('click', {});
  assert.equal(closes, 2);
  assert.equal(UI.modalOwnership.getActiveOwner(), null);
});

test('P0-SM-OF-2 pre-boot error renderer publishes presence only when shown', t => {
  const dom = installDom(t);
  const error = createErrorOverlay({ UIComponents: dom.UI });
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('boot.showAppStatusOverlay ='));
  assert.ok(script);
  vm.runInNewContext(script, { window: dom.win, document: dom.doc });
  dom.win.__TP3D_BOOT.onAppStatusOverlayShown = error.registerPresence;
  dom.win.__TP3D_BOOT.showAppStatusOverlay('fatal');
  assert.equal(dom.UI.modalOwnership.getActiveOwner().kind, 'error');
  error.hide({ includeTerminal: true });
  dom.win.__TP3D_BOOT.showAppStatusOverlay('fatal');
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), null, 'ignored duplicate fatal must not claim a hidden root');
  dom.win.__TP3D_BOOT.showAppStatusOverlay('maintenance');
  assert.equal(dom.UI.modalOwnership.getActiveOwner().kind, 'error');
  error.hide({ includeTerminal: true });
  assert.equal(dom.UI.modalOwnership.getActiveOwner(), null);
});

test('Settings Preferences saves the AutoPack loading screen and Results starting view as named preferences', async t => {
  const dom = installDom(t);
  const { normalizePreferences } = await import('../../src/core/normalizer.js');
  let prefs = normalizePreferences({ theme: 'light', units: { length: 'ft', weight: 'kg' } }); // legacy record
  const saved = [];
  const toasts = [];
  // The saved toast would outlive this fake DOM; record it instead.
  const settings = createSettingsOverlay({
    UIComponents: { ...dom.UI, showToast: (...args) => toasts.push(args) }, documentRef: dom.doc,
    PreferencesManager: {
      get: () => prefs,
      set: next => { prefs = normalizePreferences(next); saved.push(prefs); },
      applyTheme() {},
    },
    Utils: { deepClone: value => structuredClone(value), clamp: (value, min, max) => Math.min(max, Math.max(min, value)) },
  });
  settings.open('preferences');
  const walk = el => [el, ...el.children.flatMap(walk)];
  const find = predicate => walk(dom.doc.body).find(predicate);
  const rowFor = label => find(el => el.className.split(' ').includes('tp3d-settings-row') &&
    el.children[0]?.textContent === label);

  assert.ok(find(el => el.className === 'tp3d-prefs-heading' && el.textContent === 'AutoPack'), 'AutoPack section heading');
  const loadingRow = rowFor('Show AutoPack loading screen');
  const startRow = rowFor('AutoPack Results starting view');
  const cameraRow = rowFor('Show Camera Controls');
  assert.ok(cameraRow, 'camera visibility belongs to Editor Display preferences');
  const cameraVisibility = walk(cameraRow).find(el => el.dataset.role === 'camera-controls-visibility');
  const cameraHelper = walk(cameraRow).find(el => el.className === 'tp3d-prefs-helper');
  assert.equal(cameraVisibility.getAttribute('role'), 'switch');
  assert.equal(cameraVisibility.getAttribute('aria-label'), 'Show Camera Controls');
  assert.equal(cameraVisibility.getAttribute('aria-checked'), 'true', 'legacy preferences show camera controls');
  assert.equal(cameraVisibility.getAttribute('aria-describedby'), cameraHelper.id);
  assert.equal(cameraHelper.textContent,
    'Show or hide the Camera Views button in the 3D Editor. Camera navigation remains available.');
  const zoomRow = rowFor('Show Zoom Controls');
  assert.ok(zoomRow, 'zoom visibility belongs to Editor Display preferences');
  const zoomVisibility = walk(zoomRow).find(el => el.dataset.role === 'zoom-controls-visibility');
  const zoomHelper = walk(zoomRow).find(el => el.className === 'tp3d-prefs-helper');
  assert.equal(zoomVisibility.getAttribute('role'), 'switch');
  assert.equal(zoomVisibility.getAttribute('aria-checked'), 'true', 'legacy preferences show zoom controls');
  assert.equal(zoomVisibility.getAttribute('aria-describedby'), zoomHelper.id);
  assert.equal(zoomHelper.textContent,
    'Show or hide the Zoom In and Zoom Out buttons in the 3D Editor. Mouse and trackpad zoom will remain available.');
  assert.ok(loadingRow && startRow, 'both AutoPack controls render as Preferences rows');
  const loading = walk(loadingRow).find(el => el.dataset.role === 'autopack-loading-visibility');
  const helper = walk(loadingRow).find(el => el.className === 'tp3d-prefs-helper');
  const startView = walk(startRow).find(el => el.dataset.role === 'autopack-results-start-view');
  assert.equal(helper.textContent, 'Show the loading card while AutoPack is working.');
  assert.equal(loading.getAttribute('role'), 'switch');
  assert.equal(loading.getAttribute('aria-describedby'), helper.id);
  assert.equal(loading.getAttribute('aria-checked'), 'true', 'a legacy user sees the loading screen ON');
  assert.equal(startView.getAttribute('role'), 'combobox', 'the starting view uses the shared Professional Dropdown');
  assert.equal(startView.value, 'first', 'a legacy user starts on First option');
  assert.equal(startView.getAttribute('aria-label'), 'AutoPack Results starting view: First option');
  for (const [value, label] of [['applied', 'Applied option'], ['recommended', 'Recommended option'], ['first', 'First option']]) {
    startView.value = value;
    assert.equal(startView.value, value);
    assert.equal(startView.getAttribute('aria-label'), `AutoPack Results starting view: ${label}`);
  }
  startView.value = '1';
  assert.equal(startView.value, '', 'a raw option index is not a choice');

  loading.dispatchEvent({ type: 'click' });
  zoomVisibility.dispatchEvent({ type: 'click' });
  cameraVisibility.dispatchEvent({ type: 'click' });
  assert.equal(loading.getAttribute('aria-checked'), 'false');
  assert.equal(zoomVisibility.getAttribute('aria-checked'), 'false');
  assert.equal(cameraVisibility.getAttribute('aria-checked'), 'false');
  startView.value = 'recommended';
  assert.equal(saved.length, 0, 'controls do not save until Save changes');
  find(el => el.tagName === 'BUTTON' && el.textContent === 'Save changes').dispatchEvent({ type: 'click' });
  assert.equal(saved.length, 1);
  assert.deepEqual(toasts, [['Preferences saved', 'success']]);
  assert.equal(saved[0].showAutoPackLoadingOverlay, false);
  assert.equal(saved[0].showZoomControls, false);
  assert.equal(saved[0].showCameraControls, false);
  assert.equal(saved[0].autoPackResultsStartView, 'recommended', 'the named value is stored, never an index');
  assert.deepEqual(saved[0].units, { length: 'ft', weight: 'kg' }, 'unrelated preferences are preserved');

  settings.open('preferences');
  const reopened = walk(dom.doc.body).filter(el => el.dataset.role === 'autopack-results-start-view').at(-1);
  assert.equal(reopened.value, 'recommended', 'the saved starting view is shown again');
  assert.equal(walk(dom.doc.body).filter(el => el.dataset.role === 'zoom-controls-visibility').at(-1).getAttribute('aria-checked'),
    'false', 'the saved zoom visibility is shown again');
  assert.equal(walk(dom.doc.body).filter(el => el.dataset.role === 'camera-controls-visibility').at(-1).getAttribute('aria-checked'),
    'false', 'the saved camera visibility is shown again');
  walk(dom.doc.body).filter(el => el.dataset.role === 'zoom-controls-visibility').at(-1).dispatchEvent({ type: 'click' });
  walk(dom.doc.body).filter(el => el.dataset.role === 'camera-controls-visibility').at(-1).dispatchEvent({ type: 'click' });
  settings.close();
  settings.open('preferences');
  assert.equal(walk(dom.doc.body).filter(el => el.dataset.role === 'zoom-controls-visibility').at(-1).getAttribute('aria-checked'),
    'false', 'closing without Save discards the pending zoom choice');
  assert.equal(walk(dom.doc.body).filter(el => el.dataset.role === 'camera-controls-visibility').at(-1).getAttribute('aria-checked'),
    'false', 'closing without Save discards the pending camera choice');
  settings.close();
});

test('Show Camera Controls, Show Zoom Controls, Show Annotations and Show Measurement Tool save independently and the Editor Display rows share one layout', async t => {
  const dom = installDom(t);
  const { normalizePreferences } = await import('../../src/core/normalizer.js');
  let prefs = normalizePreferences({ theme: 'light', labelFontSize: 18, units: { length: 'ft', weight: 'kg' } });
  const saved = [];
  const settings = createSettingsOverlay({
    UIComponents: { ...dom.UI, showToast() {} }, documentRef: dom.doc,
    getCurrentCameraPack: () => ({ id: 'A', title: 'Fixture' }),
    applyCameraProjectionToPack: () => { throw new Error('saving visibility must never touch the open Load Plan'); },
    PreferencesManager: {
      get: () => prefs,
      set: next => { prefs = normalizePreferences(next); saved.push(prefs); },
      applyTheme() {},
    },
    Utils: { deepClone: value => structuredClone(value), clamp: (value, min, max) => Math.min(max, Math.max(min, value)) },
  });
  const walk = el => [el, ...el.children.flatMap(walk)];
  const latest = role => walk(dom.doc.body).filter(el => el.dataset.role === role).at(-1);
  const save = () => walk(dom.doc.body).filter(el => el.tagName === 'BUTTON' && el.textContent === 'Save changes').at(-1)
    .dispatchEvent({ type: 'click' });
  const switchState = role => latest(role).getAttribute('aria-checked');

  settings.open('preferences');
  const card = walk(dom.doc.body).find(el => el.className.split(' ').includes('tp3d-prefs-card'));
  const rows = card.children;
  const labelOf = row => row.children?.[0]?.textContent;
  const headingIndex = rows.findIndex(el => el.className === 'tp3d-prefs-heading' && el.textContent === 'Editor Display');
  const order = ['Default Camera Projection', 'Apply to current Load Plan', 'Show Camera Controls', 'Show Zoom Controls', 'Show Annotations', 'Show Measurement Tool', 'Hidden Case Opacity', 'Label Font Size'];
  assert.deepEqual(rows.slice(headingIndex + 1, headingIndex + 1 + order.length).map(labelOf), order,
    'camera, zoom, annotations and measurement switches sit together under Editor Display, after the projection rows');
  for (const label of order.slice(0, 6)) {
    const row = rows.find(el => labelOf(el) === label);
    assert.ok(row.className.split(' ').includes('tp3d-prefs-row--stacked'), `${label} uses the shared stacked-row alignment`);
  }
  const projectionRow = rows.find(el => labelOf(el) === 'Default Camera Projection');
  assert.equal(projectionRow.children[1].getAttribute('role'), 'combobox', 'the select stays the row control');
  assert.equal(projectionRow.children[2].className, 'tp3d-prefs-helper', 'its helper is a row item beneath the select');
  assert.equal(projectionRow.children[1].getAttribute('aria-describedby'), projectionRow.children[2].id);
  assert.equal(switchState('camera-controls-visibility'), 'true');
  assert.equal(switchState('zoom-controls-visibility'), 'true');
  assert.equal(switchState('measurement-tool-visibility'), 'true', 'the Measurement Tool is shown by default');
  assert.equal(switchState('annotations-visibility'), 'true', 'Annotations are shown by default, also for a record without the field');
  const annotationsSwitch = latest('annotations-visibility');
  const annotationsRow = rows.find(el => labelOf(el) === 'Show Annotations');
  assert.equal(annotationsSwitch.getAttribute('role'), 'switch');
  assert.equal(annotationsSwitch.getAttribute('aria-label'), 'Show Annotations');
  assert.equal(annotationsSwitch.dataset.value, 'on');
  assert.equal(walk(annotationsSwitch).find(el => el.className === 'tp3d-pref-switch__value').textContent, 'On',
    'the switch shows its state as text, like the other three');
  const annotationsHelper = walk(annotationsRow).find(el => el.className === 'tp3d-prefs-helper');
  assert.equal(annotationsSwitch.getAttribute('aria-describedby'), annotationsHelper.id);
  assert.equal(annotationsHelper.textContent,
    'Show or hide the Annotations button and graphics in the 3D Editor. Saved callouts and arrows are kept either way.');
  assert.equal(annotationsSwitch.className, latest('measurement-tool-visibility').className, 'same switch component as the other three');
  settings.close();

  // [camera, zoom, annotations, measurement] -> each preference changes without moving the others.
  const combos = [
    [false, true, true, true], [true, false, true, true], [true, true, false, true], [true, true, true, false],
    [false, false, false, false], [true, true, false, true], [true, true, true, true],
  ];
  let before = saved.length;
  for (const [camera, zoom, annotations, measure] of combos) {
    settings.open('preferences');
    for (const [role, want] of [['camera-controls-visibility', camera], ['zoom-controls-visibility', zoom], ['annotations-visibility', annotations], ['measurement-tool-visibility', measure]]) {
      if ((switchState(role) === 'true') !== want) latest(role).dispatchEvent({ type: 'click' });
    }
    assert.equal(saved.length, before, 'toggling does not save until Save changes');
    save();
    before++;
    assert.equal(saved.length, before);
    assert.equal(prefs.showCameraControls, camera, `camera ${camera}`);
    assert.equal(prefs.showZoomControls, zoom, `zoom ${zoom}`);
    assert.equal(prefs.showAnnotations, annotations, `annotations ${annotations}`);
    assert.equal(prefs.showMeasurementTool, measure, `measurement ${measure}`);
    assert.equal(prefs.labelFontSize, 18, 'unrelated preferences are preserved');
    assert.equal(prefs.camera.defaultView, 'perspective', 'default projection is untouched by a visibility save');
    settings.close();
  }
  settings.open('preferences');
  assert.equal(switchState('camera-controls-visibility'), 'true');
  assert.equal(switchState('zoom-controls-visibility'), 'true');
  assert.equal(switchState('annotations-visibility'), 'true');
  settings.close();

  // A saved Off is shown again, and closing without Save discards a pending change.
  settings.open('preferences');
  latest('annotations-visibility').dispatchEvent({ type: 'click' });
  save();
  settings.close();
  assert.equal(prefs.showAnnotations, false);
  settings.open('preferences');
  assert.equal(switchState('annotations-visibility'), 'false', 'the saved Annotations choice is shown again');
  latest('annotations-visibility').dispatchEvent({ type: 'click' });
  settings.close();
  assert.equal(prefs.showAnnotations, false, 'a pending change that is not saved never reaches the preference');
  settings.open('preferences');
  assert.equal(switchState('annotations-visibility'), 'false', 'closing without Save discards the pending Annotations choice');
  settings.close();
});

test('Camera Views opens beside its trigger only when asked, and falls back to the default placement', async t => {
  const dom = installDom(t);
  const place = (anchorRect, placement, viewport = { w: 1280, h: 800 }, extra = {}) => {
    dom.win.innerWidth = viewport.w;
    dom.win.innerHeight = viewport.h;
    const anchor = dom.doc.createElement('button');
    anchor.id = `anchor-${Math.random()}`;
    anchor.getBoundingClientRect = () => ({ ...anchorRect, right: anchorRect.left + anchorRect.width, bottom: anchorRect.top + anchorRect.height });
    dom.doc.body.appendChild(anchor);
    const menu = dom.UI.openDropdown(anchor, [{ label: 'Front' }, { label: 'Top' }],
      { width: 156, minWidth: 156, role: 'placement-test', menuSemantics: true, ...(placement ? { placement } : {}), ...extra });
    const style = menu.style;
    const result = { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top), width: Number.parseFloat(style.width) };
    dom.UI.closeAllDropdowns();
    return result;
  };
  const anchor = { left: 1180, top: 300, width: 36, height: 36 };
  const side = place(anchor, 'left');
  assert.ok(side.left + side.width <= anchor.left, 'the menu sits entirely to the left of the trigger');
  assert.equal(side.top, 300, 'and is top-aligned with it');
  const lifted = place(anchor, 'left', undefined, { placementLift: 32 });
  assert.equal(lifted.top, 268, 'placementLift raises the side menu above its trigger by that many pixels');
  assert.ok(lifted.left + lifted.width <= anchor.left, 'and it still opens to the left');
  assert.equal(place({ ...anchor, top: 20 }, 'left', undefined, { placementLift: 32 }).top, 8,
    'a raised menu never leaves the top of the viewport');
  assert.equal(place(anchor, 'left', undefined, { placementLift: -50 }).top, 300, 'a negative lift is ignored');
  const standard = place(anchor);
  assert.equal(standard.top, 342, 'without the option the menu keeps opening below its trigger');
  assert.equal(place(anchor, undefined, undefined, { placementLift: 32 }).top, 342,
    'placementLift does nothing without the side placement, so other dropdowns are unaffected');
  const lowTrigger = place({ ...anchor, top: 790 }, 'left', { w: 1280, h: 800 });
  assert.ok(lowTrigger.top + 0 <= 800 - 8, 'the side menu stays inside the viewport vertically');
  const tight = place({ left: 100, top: 300, width: 36, height: 36 }, 'left', { w: 320, h: 800 });
  assert.ok(tight.left >= 8, 'with no room on the left it falls back to a clamped default placement');
});

test('Settings Preferences owns Snapping and Export preferences now that the legacy Settings screen is retired', async t => {
  const dom = installDom(t);
  const { normalizePreferences } = await import('../../src/core/normalizer.js');
  let prefs = normalizePreferences({ theme: 'light', units: { length: 'ft', weight: 'kg' } });
  const saved = [];
  const toasts = [];
  const projectionChanges = [];
  let activeCameraPack = { id: 'A', title: 'Fixture' };
  let allowProjectionApply = true;
  const settings = createSettingsOverlay({
    UIComponents: { ...dom.UI, showToast: (...args) => toasts.push(args) }, documentRef: dom.doc,
    getCurrentCameraPack: () => activeCameraPack,
    applyCameraProjectionToPack: (id, projection) => {
      projectionChanges.push([id, projection]);
      return allowProjectionApply;
    },
    PreferencesManager: {
      get: () => prefs,
      set: next => { prefs = normalizePreferences(next); saved.push(prefs); },
      applyTheme() {},
    },
    Utils: { deepClone: value => structuredClone(value), clamp: (value, min, max) => Math.min(max, Math.max(min, value)) },
  });
  settings.open('preferences');
  const walk = el => [el, ...el.children.flatMap(walk)];
  const find = predicate => walk(dom.doc.body).find(predicate);
  const rowFor = label => find(el => el.className.split(' ').includes('tp3d-settings-row') &&
    el.children[0]?.textContent === label);
  const control = label => rowFor(label).children[1];
  const heading = text => find(el => el.className === 'tp3d-prefs-heading' && el.textContent === text);

  assert.ok(heading('Editor Snapping') && heading('Export'), 'Snapping and Export sections render in Preferences');
  for (const label of ['Default Camera Projection', 'Snapping', 'Grid Size (in)', 'Screenshot Resolution', 'Include Stats in PDF']) {
    assert.ok(rowFor(label), `${label} renders as a Preferences row`);
  }
  const before = structuredClone(prefs);
  assert.equal(control('Snapping').value, String(before.snapping.enabled));
  assert.equal(control('Default Camera Projection').value, 'perspective');
  assert.equal(control('Default Camera Projection').getAttribute('role'), 'combobox');
  assert.ok(find(el => el.className === 'tp3d-prefs-helper' &&
    el.textContent === 'Used when a Load Plan opens without a saved camera view. Existing plans keep their projection.'));
  const applySwitch = walk(rowFor('Apply to current Load Plan')).find(el => el.dataset.role === 'apply-current-camera-projection');
  assert.equal(applySwitch.getAttribute('role'), 'switch');
  assert.equal(applySwitch.getAttribute('aria-checked'), 'false');
  assert.equal(applySwitch.getAttribute('aria-describedby'), 'tp3d-prefs-apply-current-camera-help');
  assert.equal(control('Grid Size (in)').value, String(before.snapping.gridSize));
  assert.equal(control('Screenshot Resolution').value, before.export.screenshotResolution);
  assert.equal(control('Include Stats in PDF').value, String(before.export.pdfIncludeStats));

  control('Snapping').value = String(!before.snapping.enabled);
  control('Default Camera Projection').value = 'orthographic';
  control('Grid Size (in)').value = '0.1'; // below the 0.25 in floor
  control('Screenshot Resolution').value = '2560x1440';
  control('Include Stats in PDF').value = String(!before.export.pdfIncludeStats);
  assert.equal(saved.length, 0, 'controls do not save until Save changes');
  find(el => el.tagName === 'BUTTON' && el.textContent === 'Save changes').dispatchEvent({ type: 'click' });
  assert.equal(saved.length, 1);
  assert.deepEqual(toasts, [['Preferences saved. The current Load Plan kept its projection.', 'success']]);
  assert.deepEqual(projectionChanges, [], 'saving the default alone does not apply to the current Pack');
  assert.equal(saved[0].snapping.enabled, !before.snapping.enabled);
  assert.equal(saved[0].camera.defaultView, 'orthographic');
  assert.equal(saved[0].snapping.gridSize, 0.25, 'grid size keeps its 0.25 in floor');
  assert.equal(saved[0].export.screenshotResolution, '2560x1440');
  assert.equal(saved[0].export.pdfIncludeStats, !before.export.pdfIncludeStats);
  assert.deepEqual(saved[0].units, { length: 'ft', weight: 'kg' }, 'unrelated preferences are preserved');
  assert.equal(saved[0].hiddenCaseOpacity, before.hiddenCaseOpacity, 'unrelated preferences are preserved');
  applySwitch.dispatchEvent({ type: 'click' });
  assert.equal(applySwitch.getAttribute('aria-checked'), 'true');
  find(el => el.tagName === 'BUTTON' && el.textContent === 'Save changes').dispatchEvent({ type: 'click' });
  assert.deepEqual(projectionChanges, [['A', 'orthographic']]);
  assert.equal(saved.length, 2);
  assert.deepEqual(toasts.at(-1), ['Preferences saved. Projection applied to the current Load Plan.', 'success']);
  allowProjectionApply = false;
  control('Default Camera Projection').value = 'perspective';
  find(el => el.tagName === 'BUTTON' && el.textContent === 'Save changes').dispatchEvent({ type: 'click' });
  assert.equal(saved.length, 2, 'failed Apply does not save a partial default change');
  assert.deepEqual(toasts.at(-1),
    ['Could not apply projection to the current Load Plan. Preferences were not saved.', 'warning']);
  settings.close();
  activeCameraPack = null;
  settings.open('preferences');
  assert.equal(rowFor('Apply to current Load Plan'), undefined, 'Apply is hidden without an active Load Plan');
  settings.close();
});

test('#/settings is a compatibility entry that settles on a stable screen and opens Settings Preferences without a loop', async () => {
  const appSrc = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
  const start = appSrc.indexOf('let settingsRouteOpenPending = false;');
  const end = appSrc.indexOf('// SECTION: 3D ENGINE (SCENE)', start);
  assert.ok(start > 0 && end > start, 'the route compatibility helpers must be extractable');
  const build = new Function('deps', `
    const { StateStore, Router, AppShell, BootState, openSettingsOverlay, document } = deps;
    ${appSrc.slice(start, end)}
    return { openSettingsFromRoute, flushPendingSettingsRoute };
  `);
  const harness = ({ screen = 'packs', ready = false, locked = false } = {}) => {
    const calls = [];
    const boot = { appReady: ready };
    const api = build({
      StateStore: { get: key => (key === 'currentScreen' ? screen : undefined) },
      Router: { replaceScreen: s => calls.push(['replaceScreen', s]), setScreen: s => calls.push(['setScreen', s]) },
      AppShell: { navigate: s => calls.push(['navigate', s]) },
      BootState: boot,
      openSettingsOverlay: tab => calls.push(['openSettingsOverlay', tab]),
      document: { body: { classList: { contains: name => locked && name === 'tp3d-shared-modal-lock' } } },
    });
    return { api, calls, boot };
  };
  const everyCall = [];

  // Boot: the hash settles on Load Plans first; the overlay waits for the auth gate.
  const boot = harness();
  boot.api.openSettingsFromRoute();
  assert.deepEqual(boot.calls, [['replaceScreen', 'packs'], ['navigate', 'packs']], 'no overlay before the app is ready');
  boot.boot.appReady = true;
  boot.api.flushPendingSettingsRoute();
  boot.api.flushPendingSettingsRoute();
  assert.deepEqual(boot.calls.slice(2), [['openSettingsOverlay', 'preferences']], 'opens once, on Preferences');
  everyCall.push(...boot.calls);

  // Boot while another modal (e.g. the Auth overlay) owns the screen: nothing competes with it.
  const gated = harness({ locked: true });
  gated.api.openSettingsFromRoute();
  gated.boot.appReady = true;
  gated.api.flushPendingSettingsRoute();
  assert.deepEqual(gated.calls.map(call => call[0]), ['replaceScreen', 'navigate']);
  everyCall.push(...gated.calls);

  // After boot: an in-app hash change keeps the current screen and opens the overlay immediately.
  const live = harness({ screen: 'editor', ready: true });
  live.api.openSettingsFromRoute();
  assert.deepEqual(live.calls, [
    ['replaceScreen', 'editor'], ['navigate', 'editor'], ['openSettingsOverlay', 'preferences'],
  ]);
  everyCall.push(...live.calls);

  const transfer = harness({ screen: 'import-export', ready: true });
  transfer.api.openSettingsFromRoute();
  assert.deepEqual(transfer.calls, [
    ['replaceScreen', 'import-export'], ['navigate', 'import-export'], ['openSettingsOverlay', 'preferences'],
  ], 'Settings keeps the Import / Export route underneath its overlay');
  everyCall.push(...transfer.calls);

  // A retired or unknown current screen falls back to Load Plans.
  const fallback = harness({ screen: 'settings', ready: true });
  fallback.api.openSettingsFromRoute();
  assert.deepEqual(fallback.calls[0], ['replaceScreen', 'packs']);
  everyCall.push(...fallback.calls);

  assert.equal(everyCall.some(call => call[0] === 'setScreen'), false, 'never re-enters #/settings, so no redirect loop');
  assert.equal(everyCall.some(call => call[0] === 'navigate' && call[1] === 'settings'), false, 'settings is never a current screen');

  // The Router still accepts the hash (no NotFound) and the app routes it to the overlay.
  const { Router } = await import('../../src/router.js');
  const priorWindow = globalThis.window;
  globalThis.window = { location: { hash: '#/settings' } };
  try {
    assert.deepEqual(Router.parseHash(), { screen: 'settings', isNotFound: false });
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
  assert.match(appSrc, /if \(screen === 'settings'\) openSettingsFromRoute\(\);\s*else AppShell\.navigate\(screen, \{ fromRoute: true \}\);/);

  // The legacy screen and its destructive Reset are gone.
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /screen-settings|btn-reset-demo|Reset demo data|btn-save-prefs/);
  assert.doesNotMatch(appSrc, /createSettingsScreen|SettingsUI|settings-screen/);
  assert.doesNotMatch(appSrc, /clearAll\(/, 'app wiring has no Storage.clearAll path');
  assert.throws(() => readFileSync(new URL('../../src/screens/settings-screen.js', import.meta.url)), /ENOENT/);
  const shell = readFileSync(new URL('../../src/ui/app-shell.js', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /settings:\s*\{ title/);
});

test('Import / Export hash route survives direct entry and return navigation', async () => {
  const { Router } = await import('../../src/router.js');
  const priorWindow = globalThis.window;
  let onHashChange = null;
  const seen = [];
  globalThis.window = {
    location: { hash: '#/import-export' },
    addEventListener: (_type, listener) => { onHashChange = listener; },
    removeEventListener: () => { onHashChange = null; },
  };
  try {
    assert.deepEqual(Router.parseHash(), { screen: 'import-export', isNotFound: false });
    const stop = Router.init({ onScreen: screen => seen.push(screen) });
    globalThis.window.location.hash = '#/cases';
    onHashChange();
    globalThis.window.location.hash = '#/import-export';
    onHashChange();
    assert.deepEqual(seen, ['import-export', 'cases', 'import-export']);
    stop();
    assert.equal(onHashChange, null);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

// P0-SM-OF-1: minimal fake DOM sufficient to actually run createUIComponents()'s
// showModal/confirm and createHelpModal() (no jsdom harness in this suite — see
// e.g. tests/audit/inspector-case-notes.spec.mjs). Real element tree, real
// addEventListener/dispatch, so lifecycle behavior (close idempotence, confirm
// settlement, Help wrapper state) is exercised for real, not asserted from source.
class FakeModalElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.parentElement = null;
    this._listeners = new Map();
    this._classSet = new Set();
    this.type = '';
    this.dataset = {};
    this.style = {};
    this._innerHTML = '';
    this._textContent = '';
    this._attributes = new Map();
    const classSet = this._classSet;
    this.classList = {
      add: (...names) => names.forEach(n => classSet.add(n)),
      remove: (...names) => names.forEach(n => classSet.delete(n)),
      contains: name => classSet.has(name),
      toggle: name => (classSet.has(name) ? (classSet.delete(name), false) : (classSet.add(name), true)),
    };
  }
  // className and classList share the same backing set (as in real DOM), so
  // code that sets one (e.g. `el.className = 'btn btn-ghost'`) is visible to
  // code that queries the other (e.g. a `.btn` querySelector from elsewhere).
  get className() {
    return Array.from(this._classSet).join(' ');
  }
  set className(value) {
    this._classSet.clear();
    String(value || '').split(/\s+/).filter(Boolean).forEach(c => this._classSet.add(c));
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentElement = null;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }
  dispatch(type, evt = {}) {
    const list = this._listeners.get(type) || [];
    list.slice().forEach(handler => handler({ target: this, ...evt }));
  }
  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this._attributes.has(name);
  }
  removeAttribute(name) {
    this._attributes.delete(name);
  }
  // Minimal real selector support: class selectors ('.foo') and simple
  // tag-name selectors ('button'), optionally chained with the descendant
  // combinator ('.modal-header .btn', 'footer button'). That's the full
  // vocabulary actually used against these elements in production code
  // (case-modal.js, notes-overlay.js, import-*-dialog.js, etc. — including
  // notes-overlay.js's footer.querySelectorAll('button') to enable/disable
  // all footer buttons while writing) — no attribute/id/child-combinator
  // selectors are needed here.
  _descendants() {
    const out = [];
    const walk = el => el.children.forEach(child => { out.push(child); walk(child); });
    walk(this);
    return out;
  }
  querySelectorAll(selectorText) {
    const parts = String(selectorText || '').trim().split(/\s+/).filter(Boolean).map(raw =>
      raw.startsWith('.') ? { kind: 'class', name: raw.slice(1) } : { kind: 'tag', name: raw.toLowerCase() }
    );
    if (!parts.length) return [];
    const matchesPart = (el, part) => {
      if (!(el instanceof FakeModalElement)) return false;
      return part.kind === 'class' ? el._classSet.has(part.name) : el.tagName.toLowerCase() === part.name;
    };
    const matchesChain = el => {
      if (!matchesPart(el, parts[parts.length - 1])) return false;
      let ancestor = el.parentElement;
      let partIdx = parts.length - 2;
      while (ancestor && partIdx >= 0) {
        if (matchesPart(ancestor, parts[partIdx])) partIdx -= 1;
        ancestor = ancestor.parentElement;
      }
      return partIdx < 0;
    };
    return this._descendants().filter(matchesChain);
  }
  querySelector(selectorText) {
    return this.querySelectorAll(selectorText)[0] || null;
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = v;
  }
  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this._textContent = v;
  }
}

function installFakeModalDom() {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalHTMLElement = globalThis.HTMLElement;
  const modalRoot = new FakeModalElement('div');
  const toastContainer = new FakeModalElement('div');
  // showModal() does `config.content instanceof HTMLElement`, which throws
  // ReferenceError in plain Node without a global HTMLElement — not just when
  // content actually is one. FakeModalElement stands in for it.
  globalThis.HTMLElement = FakeModalElement;
  globalThis.document = {
    getElementById(id) {
      if (id === 'modal-root') return modalRoot;
      if (id === 'toast-container') return toastContainer;
      return null;
    },
    createElement(tag) {
      return new FakeModalElement(tag);
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1024,
    innerHeight: 768,
  };
  return {
    modalRoot,
    toastContainer,
    restore() {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
      if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
      else globalThis.HTMLElement = originalHTMLElement;
    },
  };
}

test('P0-SM-OF-1 showModal close() is idempotent: first close tears down once, later/reentrant/detached closes are safe no-ops', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();

    // First close removes the overlay and fires onClose exactly once.
    let onCloseCount = 0;
    const first = ui.showModal({ title: 'One', actions: [], onClose: () => { onCloseCount += 1; } });
    assert.ok(dom.modalRoot.children.includes(first.overlay), 'overlay is attached on open');
    first.close();
    assert.equal(onCloseCount, 1);
    assert.equal(first.overlay.parentElement, null, 'overlay removed from the DOM');
    assert.ok(!dom.modalRoot.children.includes(first.overlay));

    // Second (and further) close() calls are immediate no-ops: no DOM work, no
    // second onClose, no error.
    assert.doesNotThrow(() => first.close());
    assert.equal(onCloseCount, 1, 'onClose does not fire a second time');
    first.close();
    assert.equal(onCloseCount, 1);

    // Reentrant close() called from inside onClose/cleanup must also be harmless
    // (the `closed` guard is set before onClose runs).
    let reentrantOnCloseCount = 0;
    const second = ui.showModal({
      title: 'Two',
      actions: [],
      onClose: () => {
        reentrantOnCloseCount += 1;
        second.close(); // reentrant
      },
    });
    assert.doesNotThrow(() => second.close());
    assert.equal(reentrantOnCloseCount, 1, 'reentrant close from onClose does not re-fire onClose');

    // A modal whose DOM was already detached by something else must still close
    // safely (guard, not the parentElement check, prevents double work/errors).
    let thirdOnCloseCount = 0;
    const third = ui.showModal({ title: 'Three', actions: [], onClose: () => { thirdOnCloseCount += 1; } });
    dom.modalRoot.removeChild(third.overlay); // out-of-band removal
    assert.equal(third.overlay.parentElement, null);
    assert.doesNotThrow(() => third.close());
    assert.equal(thirdOnCloseCount, 1, 'onClose still fires exactly once for an already-detached modal');
    third.close();
    assert.equal(thirdOnCloseCount, 1);
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-1 showModal close() idempotence prevents double-fire across X / backdrop / action auto-close followed by a manual close', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();

    // X (header close button) then a manual close() does not double-fire onClose.
    let xCloseCount = 0;
    const xModal = ui.showModal({ title: 'X', actions: [], onClose: () => { xCloseCount += 1; } });
    const header = xModal.modal.children[0];
    const closeBtn = header.children[1];
    closeBtn.dispatch('click');
    assert.equal(xCloseCount, 1);
    assert.equal(xModal.overlay.parentElement, null);
    xModal.close();
    assert.equal(xCloseCount, 1, 'manual close after X does not re-fire onClose');

    // Backdrop click then a manual close() does not double-fire onClose.
    let backdropCloseCount = 0;
    const backdropModal = ui.showModal({
      title: 'Backdrop',
      actions: [],
      onClose: () => { backdropCloseCount += 1; },
    });
    backdropModal.overlay.dispatch('click', { target: backdropModal.overlay });
    assert.equal(backdropCloseCount, 1);
    backdropModal.close();
    assert.equal(backdropCloseCount, 1, 'manual close after backdrop does not re-fire onClose');

    // dismissible: false must still allow the manual close() to work, and still
    // not double-fire — backdrop dismissal itself remains blocked (unchanged
    // dismissal contract; not reinterpreted by this phase).
    let nonDismissibleBackdropAttempts = 0;
    const nonDismissible = ui.showModal({
      title: 'Locked',
      dismissible: false,
      actions: [],
      onClose: () => { nonDismissibleBackdropAttempts += 1; },
    });
    nonDismissible.overlay.dispatch('click', { target: nonDismissible.overlay });
    assert.equal(nonDismissibleBackdropAttempts, 0, 'dismissible:false still blocks backdrop close (unchanged)');
    nonDismissible.close();
    assert.equal(nonDismissibleBackdropAttempts, 1);

    // An action's normal-return auto-close, followed by a manual close(), does
    // not double-fire onClose.
    let actionCloseCount = 0;
    const actionModal = ui.showModal({
      title: 'Action',
      actions: [{ label: 'OK', onClick: () => {} }],
      onClose: () => { actionCloseCount += 1; },
    });
    const footer = actionModal.modal.children[2];
    footer.children[0].dispatch('click');
    assert.equal(actionCloseCount, 1);
    actionModal.close();
    assert.equal(actionCloseCount, 1, 'manual close after action auto-close does not re-fire onClose');
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-1 showModal action contract is unchanged by the idempotent close()', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();

    // Synchronous `return false` keeps the modal open (no auto-close).
    const keepOpen = ui.showModal({ title: 'Keep open', actions: [{ label: 'A', onClick: () => false }] });
    keepOpen.modal.children[2].children[0].dispatch('click');
    assert.ok(dom.modalRoot.children.includes(keepOpen.overlay), 'return false keeps the modal open');
    keepOpen.close();

    // Any other synchronous return value auto-closes as before.
    const closesNormally = ui.showModal({ title: 'Closes', actions: [{ label: 'A', onClick: () => true }] });
    closesNormally.modal.children[2].children[0].dispatch('click');
    assert.equal(closesNormally.overlay.parentElement, null, 'non-false return auto-closes');

    // Manually calling modalRef.close() from inside an action remains safe, and
    // the subsequent primitive auto-close (since the handler didn't return
    // false) does not re-fire onClose.
    let manualCloseOnCloseCount = 0;
    let manualCloseRef = null;
    manualCloseRef = ui.showModal({
      title: 'Manual close from action',
      actions: [{ label: 'A', onClick: () => { manualCloseRef.close(); } }],
      onClose: () => { manualCloseOnCloseCount += 1; },
    });
    assert.doesNotThrow(() => manualCloseRef.modal.children[2].children[0].dispatch('click'));
    assert.equal(manualCloseOnCloseCount, 1, 'manual close from an action + auto-close fires onClose once');

    // A returned Promise is NOT newly awaited: since a Promise !== false, the
    // primitive still auto-closes synchronously, before the Promise settles.
    let resolvePromise = null;
    let promiseOnCloseCount = 0;
    const promiseModal = ui.showModal({
      title: 'Promise',
      actions: [{
        label: 'A',
        onClick: () => new Promise(resolve => { resolvePromise = resolve; }),
      }],
      onClose: () => { promiseOnCloseCount += 1; },
    });
    promiseModal.modal.children[2].children[0].dispatch('click');
    assert.equal(promiseModal.overlay.parentElement, null, 'Promise return auto-closes synchronously, unawaited');
    assert.equal(promiseOnCloseCount, 1, 'onClose already fired before the action promise settles');
    // The action promise settling later has no bearing on the already-closed
    // modal: idempotent close() means this is a harmless no-op, not a second
    // teardown/onClose.
    assert.doesNotThrow(() => resolvePromise(true));
    assert.equal(promiseOnCloseCount, 1);

    // A thrown action error retains current handling: swallowed, modal still closes.
    const throwingModal = ui.showModal({
      title: 'Throws',
      actions: [{ label: 'A', onClick: () => { throw new Error('boom'); } }],
    });
    assert.doesNotThrow(() => throwingModal.modal.children[2].children[0].dispatch('click'));
    assert.equal(throwingModal.overlay.parentElement, null, 'modal still closes after a thrown action error');
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-1 UIComponents.confirm() settles exactly once for Confirm/Cancel/X/backdrop, explicit settlement beating the onClose(false) fallback', async () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();

    // Confirm -> true, exactly once, and the modal actually closes (primitive
    // auto-close runs onClose(false) afterward, which must be a no-op fallback).
    const confirmPromise = ui.confirm({ title: 'Sure?' });
    const confirmOverlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];
    const confirmFooter = confirmOverlay.children[0].children[2];
    assert.equal(confirmFooter.children.length, 2, 'Cancel + Confirm actions');
    confirmFooter.children[1].dispatch('click'); // Confirm
    assert.equal(await confirmPromise, true, 'Confirm settles true, surviving the onClose(false) fallback');
    assert.equal(confirmOverlay.parentElement, null, 'modal actually closed');

    // Cancel -> false, exactly once. Cancel must NOT return boolean `false` from
    // the action itself (which would keep the modal open) — it settles false and
    // then allows ordinary closure.
    const cancelPromise = ui.confirm({ title: 'Sure?' });
    const cancelOverlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];
    const cancelFooter = cancelOverlay.children[0].children[2];
    cancelFooter.children[0].dispatch('click'); // Cancel
    assert.equal(await cancelPromise, false);
    assert.equal(cancelOverlay.parentElement, null, 'Cancel does not leave the modal open');

    // X -> false, exactly once (was previously left pending).
    const xPromise = ui.confirm({ title: 'Sure?' });
    const xOverlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];
    const xCloseBtn = xOverlay.children[0].children[0].children[1]; // overlay -> modal -> header -> closeBtn
    xCloseBtn.dispatch('click');
    assert.equal(await xPromise, false);

    // Backdrop -> false, exactly once (was previously left pending).
    const backdropPromise = ui.confirm({ title: 'Sure?' });
    const backdropOverlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];
    backdropOverlay.dispatch('click', { target: backdropOverlay });
    assert.equal(await backdropPromise, false);

    // Repeated primitive close cannot settle twice (idempotent close() means the
    // onClose fallback can only ever run once regardless of how many times
    // close() is invoked afterward).
    let settleAttempts = 0;
    const repeatedPromise = ui.confirm({ title: 'Sure?' }).then(v => { settleAttempts += 1; return v; });
    const repeatedOverlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];
    repeatedOverlay.children[0].children[0].children[1].dispatch('click'); // X
    repeatedOverlay.dispatch('click', { target: repeatedOverlay }); // backdrop, already detached — no-op
    assert.equal(await repeatedPromise, false);
    assert.equal(settleAttempts, 1, '.then() runs exactly once no matter how many dismissal paths fire');
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-1 UIComponents.confirm() whose onOpen throws closes its own modal and settles false once, and later confirmations behave normally', async t => {
  const { UI, doc, roots, key, dispatch } = installDom(t);
  const modalRoot = roots.get('modal-root');
  const opener = doc.body.appendChild(doc.createElement('button'));
  opener.focus();
  const footerButton = (modal, index) => modal.modal.children[2].children[index];

  let handed = null;
  let settlements = 0;
  const failing = UI.confirm({
    title: 'Delete?',
    onOpen: modal => { handed = modal; throw new Error('caller bug'); },
  }).then(value => { settlements += 1; return value; });
  assert.equal(await failing, false, 'a throwing onOpen settles false, never rejects');
  assert.equal(settlements, 1, 'and settles exactly once');
  assert.ok(handed && handed.overlay, 'the caller was handed the modal before it threw');
  assert.equal(handed.overlay.isConnected, false, 'the modal was removed, not orphaned');
  assert.equal(modalRoot.children.length, 0, 'nothing is left in the modal root');
  assert.deepEqual(UI.modalOwnership.getOwners(), [], 'no modal owner is left behind');
  assert.equal(doc.activeElement, opener, 'focus returned to where it was');

  // Confirm still resolves true, exactly once, with a well-behaved onOpen.
  let confirmSettlements = 0;
  const confirmed = UI.confirm({ title: 'Sure?', onOpen: modal => { handed = modal; } })
    .then(value => { confirmSettlements += 1; return value; });
  assert.equal(handed.overlay.isConnected, true, 'a well-behaved onOpen leaves the question open');
  footerButton(handed, 1).emit('click');
  assert.equal(await confirmed, true);
  assert.equal(confirmSettlements, 1);
  assert.equal(handed.overlay.isConnected, false);
  assert.equal(doc.activeElement, opener, 'focus restored after Confirm');

  // Cancel, Escape and the backdrop still settle false once.
  const cancelled = UI.confirm({ title: 'Sure?', onOpen: modal => { handed = modal; } });
  footerButton(handed, 0).emit('click');
  assert.equal(await cancelled, false, 'Cancel');
  const escaped = UI.confirm({ title: 'Sure?', onOpen: modal => { handed = modal; } });
  dispatch(key('Escape'));
  assert.equal(await escaped, false, 'Escape');
  assert.equal(handed.overlay.isConnected, false);
  const dismissed = UI.confirm({ title: 'Sure?', onOpen: modal => { handed = modal; } });
  handed.overlay.emit('click', { target: handed.overlay });
  assert.equal(await dismissed, false, 'backdrop');
  assert.equal(doc.activeElement, opener, 'focus restored after every dismissal');

  // The intended use: onOpen withdraws the question itself.
  const withdrawn = UI.confirm({ title: 'Gone?', onOpen: modal => modal.close() });
  assert.equal(await withdrawn, false, 'a withdrawn question settles false');
  assert.equal(modalRoot.children.length, 0);
  assert.deepEqual(UI.modalOwnership.getOwners(), []);
});

test('P0-SM-OF-1 Help modal wrapper clears its modal reference on every primitive dismissal path and reopens normally', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();
    const help = createHelpModal({ UIComponents: ui });

    assert.equal(help.isOpen(), false);

    // X clears wrapper state.
    help.open();
    assert.equal(help.isOpen(), true);
    let overlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];
    overlay.children[0].children[0].children[1].dispatch('click'); // overlay -> modal -> header -> closeBtn (X)
    assert.equal(help.isOpen(), false, 'isOpen() is false after X close');
    assert.equal(overlay.parentElement, null);

    // Reopen after X.
    help.open();
    assert.equal(help.isOpen(), true);
    overlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];

    // Backdrop clears wrapper state.
    overlay.dispatch('click', { target: overlay });
    assert.equal(help.isOpen(), false, 'isOpen() is false after backdrop close');

    // Reopen after backdrop.
    help.open();
    assert.equal(help.isOpen(), true);
    overlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];

    // Footer close clears wrapper state and does not double-close the primitive.
    const footer = overlay.children[0].children[2]; // overlay -> modal -> footer
    assert.equal(footer.children.length, 1, 'single Close footer action');
    assert.doesNotThrow(() => footer.children[0].dispatch('click'));
    assert.equal(help.isOpen(), false, 'isOpen() is false after footer close');
    assert.equal(overlay.parentElement, null);

    // Reopen after footer close.
    help.open();
    assert.equal(help.isOpen(), true);
    overlay = dom.modalRoot.children[dom.modalRoot.children.length - 1];

    // Calling the wrapper's own close() (e.g. programmatic primitive closure
    // from elsewhere) also clears state and remains reopenable.
    help.close();
    assert.equal(help.isOpen(), false);
    help.open();
    assert.equal(help.isOpen(), true);
  } finally {
    dom.restore();
  }
});

// packs-screen.js's New/Rename Load Plan modals are built inside the closure
// createPacksScreen() returns, which queries ~25 document.getElementById() ids
// at construction time — there is no jsdom harness in this suite for that (same
// constraint documented for editor-screen.js / cases-screen.js elsewhere in this
// repo's tests), so these are precise source-contract checks against the actual
// onClick handlers rather than a full screen instantiation.
test('P0-SM-OF-1 New Load Plan empty/whitespace title keeps the modal open, preserving the existing warning and focus behavior', async () => {
  const packsSource = await fs.readFile(PACKS_SCREEN_PATH, 'utf8');
  const newPlanBlock = packsSource.slice(
    packsSource.indexOf('function openNewPackModal'),
    packsSource.indexOf('function openEditPackModal')
  );
  assert.ok(newPlanBlock, 'openNewPackModal block found');

  // Invalid branch: trimmed-empty title (covers both empty and whitespace-only,
  // since the check is on the trimmed value) keeps the modal open.
  assert.match(
    newPlanBlock,
    /const t = String\(title\.input\.value \|\| ''\)\.trim\(\);\s*\n\s*if \(!t\) \{\s*\n\s*UIComponents\.showToast\('Title is required', 'warning'\);\s*\n\s*title\.input\.focus\(\);\s*\n\s*return false;\s*\n\s*\}/,
    'empty/whitespace title still warns, still focuses the title input, and now keeps the modal open (return false)'
  );
  assert.doesNotMatch(newPlanBlock, /title\.input\.focus\(\);\s*\n\s*return true;/,
    'the invalid branch no longer returns the value that allows the generic modal to close');

  // Valid path is unchanged: still creates the pack and closes normally (returns
  // true) after the required identity/other validation.
  assert.match(newPlanBlock, /const pack = PackLibrary\.create\(\{/);
  assert.match(newPlanBlock, /PackLibrary\.open\(pack\.id\);\s*\n\s*AppShell\.navigate\('editor'\);\s*\n\s*return true;/);
});

test('P0-SM-OF-1 Rename Load Plan empty/whitespace title keeps the modal open and performs no update', async () => {
  const packsSource = await fs.readFile(PACKS_SCREEN_PATH, 'utf8');
  const renameBlock = packsSource.slice(
    packsSource.indexOf('function openRename'),
    packsSource.indexOf('function exportPack')
  );
  assert.ok(renameBlock, 'openRename block found');

  // Invalid branch (trimmed-empty, so empty and whitespace-only both hit it)
  // now keeps the modal open instead of allowing it to close.
  assert.match(
    renameBlock,
    /const nextTitle = String\(f\.input\.value \|\| ''\)\.trim\(\);\s*\n\s*if \(!nextTitle\) return false;/,
    'empty/whitespace title keeps the modal open (return false)'
  );
  assert.doesNotMatch(renameBlock, /if \(!nextTitle\) return true;/,
    'the invalid branch no longer returns the value that allows the generic modal to close');

  // No update occurs for the invalid branch: PackLibrary.update only appears
  // after (textually later than) the invalid-title guard.
  const guardIndex = renameBlock.indexOf('if (!nextTitle) return false;');
  const updateIndex = renameBlock.indexOf('PackLibrary.update(packId, { title: nextTitle });');
  assert.ok(guardIndex >= 0 && updateIndex > guardIndex, 'the invalid-title guard runs before any update call');

  // Valid Rename behavior is unchanged: still busy-gated, still updates and
  // toasts, still closes (returns true).
  assert.match(renameBlock, /if \(mutationBlockedWhileBusy\(\)\) return false;\s*\n\s*PackLibrary\.update\(packId, \{ title: nextTitle \}\);\s*\n\s*UIComponents\.showToast\('Renamed', 'success'\);\s*\n\s*return true;/);
});

// P0-SM-OF-4/7: accessible dialog names and ordinary modal semantics.
test('P0-SM-OF-4/7 generic showModal has one named modal dialog and a labeled close button', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();
    const m = ui.showModal({ title: 'Example Dialog', actions: [] });

    assert.equal(m.modal.getAttribute('role'), 'dialog', 'exactly one semantic dialog root, on .modal');
    assert.equal(m.overlay.getAttribute('role'), null, 'the backdrop itself is not a second dialog root');

    const header = m.modal.children[0];
    const title = header.children[0];
    const labelledBy = m.modal.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'modal has a non-empty accessible name via aria-labelledby');
    assert.equal(title.id, labelledBy, 'aria-labelledby correctly references the visible title element');
    assert.equal(title.textContent, 'Example Dialog', 'the visible title is the one being referenced');

    const closeBtn = header.children[1];
    const closeLabel = closeBtn.getAttribute('aria-label');
    assert.ok(closeLabel, 'icon-only close button has an accessible label');
    assert.match(closeLabel, /Example Dialog/, 'the close label is specific, not a bare generic "Close"');

    assert.equal(m.modal.getAttribute('aria-modal'), 'true', 'ordinary shared dialogs are modal');
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-4 title IDs are unique across multiple simultaneously-open (nested) generic dialogs', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();
    // Neither is closed before the next opens, matching a real nested
    // confirmation stacked on top of a primary dialog.
    const a = ui.showModal({ title: 'Dialog A', actions: [] });
    const b = ui.showModal({ title: 'Dialog B', actions: [] });
    const c = ui.showModal({ title: 'Dialog A' }); // same visible title text as `a`, different instance

    const titleIdOf = ref => ref.modal.children[0].children[0].id;
    const idA = titleIdOf(a);
    const idB = titleIdOf(b);
    const idC = titleIdOf(c);

    assert.notEqual(idA, idB);
    assert.notEqual(idA, idC);
    assert.notEqual(idB, idC);
    assert.equal(a.modal.getAttribute('aria-labelledby'), idA);
    assert.equal(b.modal.getAttribute('aria-labelledby'), idB);
    assert.equal(c.modal.getAttribute('aria-labelledby'), idC);
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-4 a custom-title caller that restructures the heading in place keeps a correct, non-stale accessible name', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();
    // Mirrors src/screens/editor-screen.js's Item Notes showNotesModal(): the
    // generic title element is kept (not replaced) and its children rebuilt.
    const config = { title: 'Case A17 — Notes', actions: [] };
    const m = ui.showModal(config);
    const header = m.modal.children[0];
    const heading = header.children[0];
    const idBeforeRestructure = heading.id;
    const labelledByBeforeRestructure = m.modal.getAttribute('aria-labelledby');

    heading.textContent = '';
    const headingTitle = { textContent: config.title }; // stand-in child span
    heading.children.push(headingTitle); // heading now has custom structure, not plain text

    assert.equal(heading.id, idBeforeRestructure, 'the id is not disturbed by restructuring its children');
    assert.equal(
      m.modal.getAttribute('aria-labelledby'),
      labelledByBeforeRestructure,
      'aria-labelledby still points at the same (still-present) element — never stale'
    );
    assert.equal(m.modal.getAttribute('aria-labelledby'), heading.id);

    // The close button's accessible label was computed from the caller's
    // original title, matching the restructured visible heading's content.
    const closeLabel = header.children[1].getAttribute('aria-label');
    assert.match(closeLabel, /Case A17 — Notes/);
  } finally {
    dom.restore();
  }
});

test('P0-SM-OF-4 Notes overlay (a real custom-title caller) sets one dialog role and a correctly-referenced accessible name', () => {
  const dom = installFakeModalDom();
  try {
    const ui = createUIComponents();
    const entity = { id: 'case-1', notes: '' };
    const overlayRef = openNotesOverlay({
      UIComponents: ui,
      entityType: 'case',
      entityId: 'case-1',
      resolveEntity: () => entity,
      readNote: current => current.notes,
      saveNote: ({ value }) => { entity.notes = value; },
      title: 'Case Notes',
    });

    assert.ok(overlayRef, 'overlay opened');
    const modal = overlayRef.modal;
    assert.equal(modal.getAttribute('role'), 'dialog');
    const labelledBy = modal.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'has a non-empty accessible name');

    const header = modal.children[0];
    const heading = header.children[0];
    assert.equal(heading.id, labelledBy, 'aria-labelledby references the actual (restructured) heading element');

    const closeButton = header.children[1];
    assert.match(closeButton.getAttribute('aria-label') || '', /Case Notes/, 'close button has a specific label');

    // This surface's own id scheme must not collide with the generic
    // primitive's counter-based scheme used by ordinary dialogs.
    const other = ui.showModal({ title: 'Unrelated dialog', actions: [] });
    assert.notEqual(other.modal.children[0].children[0].id, heading.id);
  } finally {
    dom.restore();
  }
});

// Settings builds its own modal directly (doc.createElement, not the generic
// showModal()) and createSettingsOverlay() carries a very large live-service
// dependency graph (Supabase, billing, org/account data) with no jsdom
// harness in this suite to drive open()/render() behaviorally — same
// constraint documented for packs-screen.js's New/Rename Load Plan coverage
// above. These are precise source-contract checks against the actual naming
// wiring instead.
test('P0-SM-OF-4 Settings dialog gets aria-labelledby wired to the same id its title element sets, close button gets a label, and the existing specialized aria-modal is preserved', async () => {
  const settingsSource = await fs.readFile(SETTINGS_OVERLAY_PATH, 'utf8');

  assert.match(
    settingsSource,
    /const SETTINGS_MODAL_TITLE_ID = '([^']+)';/,
    'a stable title-id constant is defined'
  );
  const idConstantValue = settingsSource.match(/const SETTINGS_MODAL_TITLE_ID = '([^']+)';/)[1];
  assert.ok(idConstantValue, 'the constant has a non-empty value');

  // The dialog root: role/aria-modal (pre-existing, specialized — untouched)
  // plus the new aria-labelledby, all referencing the same constant.
  assert.match(
    settingsSource,
    /settingsModal\.setAttribute\('role', 'dialog'\);\s*\n\s*settingsModal\.setAttribute\('aria-modal', 'true'\);\s*\n\s*settingsModal\.setAttribute\('aria-labelledby', SETTINGS_MODAL_TITLE_ID\);/,
    'existing role/aria-modal are preserved and aria-labelledby is added referencing the shared constant, not a duplicated literal'
  );

  // The visible per-tab title element gets that exact same constant as its id.
  assert.match(
    settingsSource,
    /const title = doc\.createElement\('div'\);\s*\n\s*title\.classList\.add\('tp3d-settings-right-title'\);\s*\n[\s\S]{0,200}?title\.id = SETTINGS_MODAL_TITLE_ID;\s*\n\s*title\.textContent = meta\.title;/,
    'the title element that renders meta.title (the visible heading) carries the same id referenced by aria-labelledby'
  );

  // The icon-only close button gets a real accessible label.
  assert.match(
    settingsSource,
    /closeBtn\.innerHTML = '<i class="fa-solid fa-xmark"><\/i>';\s*\n\s*closeBtn\.setAttribute\('aria-label', 'Close Settings'\);/,
    'the icon-only close button has a non-empty accessible label'
  );

  // Only one such id constant/definition exists (no duplicate title roots).
  const constantDefCount = (settingsSource.match(/const SETTINGS_MODAL_TITLE_ID = /g) || []).length;
  assert.equal(constantDefCount, 1, 'exactly one title-id definition, not a duplicated scheme');
});
