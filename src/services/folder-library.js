/**
 * @file folder-library.js
 * @description UI-free service module for workspace-scoped pack folders.
 * @module services/folder-library
 * @created 05/08/2026
 * @updated 05/08/2026
 * @author Truck Packer 3D Team
 */

import * as StateStore from '../core/state-store.js';
import * as Utils from '../core/utils/index.js';
import { inspectFolderGraph, repairFolderGraph as repairGraph } from '../core/normalizer.js';

// Mirrors WORKSPACE_BACKUP_LIMITS.maxFolders (import-export.js): a workspace that holds more Folders than this
// could not be exported as a Workspace Backup. A test keeps the two numbers equal.
export const MAX_FOLDERS = 2000;
export const MAX_FOLDER_NAME_LENGTH = 100;

function trimmedName(name) {
  return String(name == null ? '' : name).trim();
}

// Case-insensitive, Unicode-normalized comparison key for duplicate detection.
function nameKey(name) {
  return trimmedName(name).normalize('NFC').toLowerCase();
}

function getFolders() {
  return StateStore.get('folderLibrary') || [];
}

function getPacks() {
  return StateStore.get('packLibrary') || [];
}

function nextSortOrder(folders) {
  return (folders || []).reduce((max, folder) => Math.max(max, Number(folder && folder.sortOrder) || 0), -100) + 100;
}

// Only Folders with a unique, valid id are acted on: a damaged or repeated id could point at the wrong record.
function usableFolders() {
  return inspectFolderGraph(getFolders(), getPacks()).folders;
}

function folderExists(folderId) {
  if (folderId == null) return true;
  return usableFolders().some(folder => folder.id === folderId);
}

/** The Folder graph as stored: usable Folders, damaged records and Load Plans whose Folder cannot be found. */
export function getFolderGraph() {
  return inspectFolderGraph(getFolders(), getPacks());
}

/**
 * The explicit recovery for a damaged Folder graph, one history step. The caller must have preserved the
 * original first. Returns null when there is nothing to repair.
 */
export function repairFolderGraph() {
  if (getFolderGraph().clean) return null;
  const repaired = repairGraph(getFolders(), getPacks());
  StateStore.set({ folderLibrary: repaired.folderLibrary, packLibrary: repaired.packLibrary });
  return repaired;
}

export function listFolders() {
  return [...usableFolders()].sort((a, b) => {
    const aOrder = Number(a && a.sortOrder) || 0;
    const bOrder = Number(b && b.sortOrder) || 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a && a.name || '').localeCompare(String(b && b.name || ''));
  });
}

/**
 * The rules for a new Folder name (creation and rename share them): trimmed, not empty, at most
 * MAX_FOLDER_NAME_LENGTH Unicode code points, and not already used (case-insensitively) by another Folder of
 * this workspace. Any other text is allowed; it is always rendered as text, never as markup.
 * @returns {{ ok: true, name: string } | { ok: false, reason: string, message: string }}
 */
export function validateFolderName(name, { excludeFolderId = null } = {}) {
  const value = trimmedName(name);
  if (!value) return { ok: false, reason: 'empty', message: 'Enter a Folder name.' };
  if (Array.from(value).length > MAX_FOLDER_NAME_LENGTH) {
    return { ok: false, reason: 'too-long', message: `Folder names can have up to ${MAX_FOLDER_NAME_LENGTH} characters.` };
  }
  const key = nameKey(value);
  if (usableFolders().some(folder => folder.id !== excludeFolderId && nameKey(folder.name) === key)) {
    return { ok: false, reason: 'duplicate', message: 'A Folder with this name already exists.' };
  }
  return { ok: true, name: value };
}

// A fresh id that no stored record (usable or damaged) already holds.
function mintFolderId(folders) {
  const taken = new Set(folders.map(folder => (folder && typeof folder.id === 'string' ? folder.id : null)));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = Utils.uuid();
    if (typeof id === 'string' && id && id === id.trim() && !taken.has(id)) return id;
  }
  return null;
}

/**
 * Create a Folder: `{ ok: true, folder }`, or `{ ok: false, reason, message }` with nothing written.
 * @returns {{ ok: boolean, folder?: any, reason?: string, message?: string }}
 */
export function createFolderResult(name) {
  const checked = validateFolderName(name);
  if (!checked.ok) return checked;
  const folders = getFolders();
  if (folders.length >= MAX_FOLDERS) {
    return {
      ok: false,
      reason: 'limit',
      message: `A workspace can hold up to ${MAX_FOLDERS.toLocaleString('en-US')} Folders. Delete one to create another.`,
    };
  }
  const id = mintFolderId(folders);
  if (!id) return { ok: false, reason: 'id', message: 'Could not create a unique Folder ID. Try again.' };
  const now = Date.now();
  const folder = {
    id,
    name: checked.name,
    scope: 'pack',
    parentFolderId: null,
    sortOrder: nextSortOrder(folders),
    createdAt: now,
    updatedAt: now,
  };
  StateStore.set({ folderLibrary: [...folders, folder] });
  return { ok: true, folder };
}

export function createFolder(name) {
  const result = createFolderResult(name);
  return result.ok ? result.folder : null;
}

/**
 * Rename a Folder: `{ ok: true, changed, folder }` or `{ ok: false, reason, message }`. The same name (after
 * trimming) is not a change: it writes nothing, adds no history and does not touch `updatedAt`. A stored name
 * that already breaks the naming rules is left as it is until the user actually chooses a new one.
 * @returns {{ ok: boolean, changed?: boolean, folder?: any, reason?: string, message?: string }}
 */
export function renameFolderResult(folderId, name) {
  const existing = usableFolders().find(folder => folder.id === folderId);
  if (!existing) return { ok: false, reason: 'missing', message: 'This Folder is no longer available.' };
  const nextName = trimmedName(name);
  // Trimmed on both sides: a stored name with surrounding spaces is the same name, and stays exactly as stored.
  if (nextName && nextName === trimmedName(existing.name)) return { ok: true, changed: false, folder: existing };
  const checked = validateFolderName(name, { excludeFolderId: folderId });
  if (!checked.ok) return checked;
  const folders = getFolders();
  const idx = folders.findIndex(folder => folder && folder.id === folderId);
  const nextFolder = { ...folders[idx], name: checked.name, updatedAt: Date.now() };
  StateStore.set({ folderLibrary: folders.map((folder, i) => (i === idx ? nextFolder : folder)) });
  return { ok: true, changed: true, folder: nextFolder };
}

export function renameFolder(folderId, name) {
  const result = renameFolderResult(folderId, name);
  return result.ok ? result.folder : null;
}

export function deleteFolder(folderId) {
  const folders = getFolders();
  const existing = usableFolders().find(folder => folder.id === folderId);
  if (!existing) return false;

  const nextFolders = folders.filter(folder => folder && folder.id !== folderId);
  const nextPacks = getPacks().map(pack => {
    if (!pack || pack.folderId !== folderId) return pack;
    return { ...pack, folderId: null };
  });

  StateStore.set({
    folderLibrary: nextFolders,
    packLibrary: nextPacks,
  });
  return true;
}

/**
 * Move a Load Plan: `{ ok: true, changed, pack }` or `{ ok: false, reason }`. Moving to the Folder it is already
 * in is not a change: nothing is written (no history step, no `lastEdited`, no preview change). A stale or
 * invalid stored reference is not "already in" anything, so moving it to Unfiled is a real change.
 * @returns {{ ok: boolean, changed?: boolean, pack?: any, reason?: string }}
 */
export function movePackToFolderResult(packId, folderIdOrNull) {
  const folderId = folderIdOrNull == null || folderIdOrNull === '' ? null : String(folderIdOrNull);
  if (!folderExists(folderId)) return { ok: false, reason: 'folder-missing' };

  const packs = getPacks();
  const idx = packs.findIndex(pack => pack && pack.id === packId);
  if (idx === -1) return { ok: false, reason: 'pack-missing' };

  const current = packs[idx].folderId;
  if (current === folderId || (folderId === null && (current == null || current === ''))) {
    return { ok: true, changed: false, pack: packs[idx] };
  }

  const nextPack = {
    ...packs[idx],
    folderId,
    lastEdited: Date.now(),
  };
  StateStore.set({ packLibrary: packs.map((pack, i) => (i === idx ? nextPack : pack)) });
  return { ok: true, changed: true, pack: nextPack };
}

export function movePackToFolder(packId, folderIdOrNull) {
  const result = movePackToFolderResult(packId, folderIdOrNull);
  return result.ok ? result.pack : null;
}

export function getPacksInFolder(folderId) {
  const targetFolderId = folderId == null || folderId === '' ? null : String(folderId);
  return getPacks().filter(pack => (pack && pack.folderId ? pack.folderId : null) === targetFolderId);
}
