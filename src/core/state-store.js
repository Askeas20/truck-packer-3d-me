/**
 * @file state-store.js
 * @description Global state store with snapshot and history support.
 * @module core/state-store
 * @created Unknown
 * @updated 01/22/2026
 * @author Truck Packer 3D Team
 */

// ============================================================================
// SECTION: IMPORTS AND DEPENDENCIES
// ============================================================================

import { deepClone } from './utils/index.js';

const MAX_HISTORY = 50;

let state = null;
let history = [];
let historyPointer = -1;
const subscribers = [];
// Pack fields that describe the current view, not the authored history: Undo/Redo keeps the current value
// (a stale camera must never come back with an old entry).
const CURRENT_PACK_FIELDS = Object.freeze(['editorView']);
// A derived preview depicts the cargo of the history entry it was captured for, so Undo/Redo restore the
// preview that entry holds. Automatic captures add no step: set() carries them into the entry that is current.
const PREVIEW_PACK_FIELDS = Object.freeze([
  'thumbnail', 'thumbnailRenderVersion', 'thumbnailUpdatedAt', 'thumbnailSource',
  'thumbnailVisualSignature', 'thumbnailViewSignature',
]);

function historySlice(s) {
  return deepClone({
    caseLibrary: s.caseLibrary,
    packLibrary: s.packLibrary,
    folderLibrary: s.folderLibrary,
    preferences: s.preferences,
  });
}

function withWorkspaceDefaults(nextState) {
  const next = nextState && typeof nextState === 'object' ? nextState : {};
  return {
    ...next,
    folderLibrary: Array.isArray(next.folderLibrary) ? next.folderLibrary : [],
  };
}

function init(initialState) {
  state = deepClone(withWorkspaceDefaults(initialState));
  history = [historySlice(state)];
  historyPointer = 0;
}

function get(key) {
  if (!state) return key ? undefined : null;
  if (!key) return state;
  return state[key];
}

function set(patch, options = {}) {
  const next = withWorkspaceDefaults({ ...state, ...patch });
  const significant = options.skipHistory ? false : isSignificantChange(patch);
  // Clear Preview is one user step. Its undo base must include the latest
  // derived image (capture deliberately skipped history), without adding a step
  // or changing Redo for automatic preview writes.
  if (significant && options.notification?.type === 'pack-preview') {
    history[historyPointer] = historySlice(state);
  }
  state = next;
  if (significant) pushHistory(historySlice(next));
  else carryPreviewIntoCurrentEntry(next, options.notification);
  if (!options.skipNotify) notify(patch, state, options.notification);
}

// A derived preview write (automatic capture, no history step) belongs to the state it was captured for, which
// is the entry that is current when it lands. Only that Pack's preview fields go into that one entry, so no
// step is added, Redo is untouched, and Undo/Redo later bring back the image that matches the restored cargo.
// The write is trusted only when it is the exact Pack object this set() just placed in the state.
function carryPreviewIntoCurrentEntry(nextState, notification) {
  if (notification?.type !== 'pack-preview') return;
  const written = notification.pack;
  if (!written || typeof written !== 'object' || !written.id) return;
  if (!(nextState.packLibrary || []).includes(written)) return;
  const entryPack = (history[historyPointer]?.packLibrary || []).find(pack => pack && pack.id === written.id);
  if (!entryPack) return;
  PREVIEW_PACK_FIELDS.forEach(key => {
    if (Object.hasOwn(written, key)) entryPack[key] = deepClone(written[key]);
  });
}

function replace(nextState, options = {}) {
  state = deepClone(withWorkspaceDefaults(nextState));
  if (options.resetHistory) {
    history = [historySlice(state)];
    historyPointer = 0;
  } else if (!options.skipHistory) {
    pushHistory(historySlice(state));
  }
  notify({ _replace: true }, state);
}

function snapshot() {
  return deepClone(state);
}

function resetHistory() {
  history = [historySlice(state)];
  historyPointer = 0;
}

function pushHistory(entry) {
  history = history.slice(0, historyPointer + 1);
  history.push(deepClone(entry));
  if (history.length > MAX_HISTORY) history.shift();
  historyPointer = history.length - 1;
}

function restoreCargoHistory(entry) {
  const restored = deepClone(entry);
  const currentPacks = new Map((state.packLibrary || []).filter(pack => pack && pack.id).map(pack => [pack.id, pack]));
  restored.packLibrary = (restored.packLibrary || []).map(pack => {
    if (!pack || typeof pack !== 'object') return pack;
    const current = currentPacks.get(pack.id);
    if (!current) return pack;
    // The whole recorded Pack comes from the entry (cargo, measurements, annotations, lastEdited, preview).
    // Only the camera stays current.
    const next = { ...pack };
    CURRENT_PACK_FIELDS.forEach(key => {
      if (Object.hasOwn(current, key)) next[key] = deepClone(current[key]);
    });
    return next;
  });
  return restored;
}

/** How many steps Undo can take back right now (read-only: the state is not touched). */
function undoDepth() {
  return historyPointer;
}

function undo() {
  if (historyPointer <= 0) return false;
  historyPointer--;
  state = { ...state, ...restoreCargoHistory(history[historyPointer]) };
  notify({ _undo: true }, state);
  return true;
}

function redo() {
  if (historyPointer >= history.length - 1) return false;
  historyPointer++;
  state = { ...state, ...restoreCargoHistory(history[historyPointer]) };
  notify({ _redo: true }, state);
  return true;
}

function subscribe(fn) {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx > -1) subscribers.splice(idx, 1);
  };
}

function notify(changes, nextState, notification = undefined) {
  subscribers.forEach(fn => {
    try {
      fn(changes, nextState, notification);
    } catch (err) {
      console.error('Subscriber error', err);
    }
  });
}

function isSignificantChange(patch) {
  const keys = Object.keys(patch || {});
  const significant = ['caseLibrary', 'packLibrary', 'folderLibrary', 'preferences'];
  return keys.some(k => significant.includes(k));
}

export { init, get, set, replace, snapshot, resetHistory, undoDepth, undo, redo, subscribe };
