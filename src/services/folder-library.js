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

function cleanName(name) {
  return String(name || '').trim() || 'Untitled Folder';
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

export function createFolder(name) {
  const folders = getFolders();
  const now = Date.now();
  const folder = {
    id: Utils.uuid(),
    name: cleanName(name),
    scope: 'pack',
    parentFolderId: null,
    sortOrder: nextSortOrder(folders),
    createdAt: now,
    updatedAt: now,
  };
  StateStore.set({ folderLibrary: [...folders, folder] });
  return folder;
}

export function renameFolder(folderId, name) {
  const folders = getFolders();
  if (!folderExists(folderId)) return null;
  const idx = folders.findIndex(folder => folder && folder.id === folderId);
  if (idx === -1) return null;
  const now = Date.now();
  const nextFolder = {
    ...folders[idx],
    name: cleanName(name),
    updatedAt: now,
  };
  StateStore.set({ folderLibrary: folders.map((folder, i) => (i === idx ? nextFolder : folder)) });
  return nextFolder;
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

export function movePackToFolder(packId, folderIdOrNull) {
  const folderId = folderIdOrNull == null || folderIdOrNull === '' ? null : String(folderIdOrNull);
  if (!folderExists(folderId)) return null;

  const packs = getPacks();
  const idx = packs.findIndex(pack => pack && pack.id === packId);
  if (idx === -1) return null;

  const nextPack = {
    ...packs[idx],
    folderId,
    lastEdited: Date.now(),
  };
  StateStore.set({ packLibrary: packs.map((pack, i) => (i === idx ? nextPack : pack)) });
  return nextPack;
}

export function getPacksInFolder(folderId) {
  const targetFolderId = folderId == null || folderId === '' ? null : String(folderId);
  return getPacks().filter(pack => (pack && pack.folderId ? pack.folderId : null) === targetFolderId);
}
