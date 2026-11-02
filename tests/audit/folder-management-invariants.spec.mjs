// folder management invariants: contract tests from the former security suite.

import {
  assert,
  execFileAsync,
  folderLibraryPath,
  fs,
  importExportPath,
  indexHtmlPath,
  makePackImportInstance,
  makePackImportPayload,
  makePackImportSafeCase,
  normalizerPath,
  packLibraryPath,
  packsScreenPath,
  readAppSource,
  stateStorePath,
  storagePath,
  stylesMainPath,
  test,
} from '../fixtures/security-invariants-support.mjs';

test('phase 0.7B-1B folderLibrary is a significant state key and history slice', async () => {
  const src = await fs.readFile(stateStorePath, 'utf8');
  const historyStart = src.indexOf('function historySlice(');
  const historyEnd = src.indexOf('\nfunction withWorkspaceDefaults', historyStart + 1);
  const historyFn = historyStart >= 0 && historyEnd > historyStart ? src.slice(historyStart, historyEnd) : '';
  const start = src.indexOf('function isSignificantChange(');
  const end = src.indexOf('\nexport {', start + 1);
  const fn = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(historyFn, 'historySlice must be extractable');
  assert.match(historyFn, /folderLibrary:\s*s\.folderLibrary/,
    'folderLibrary must participate in StateStore history snapshots');
  assert.ok(fn, 'isSignificantChange must be extractable');
  assert.match(fn, /'folderLibrary'/,
    'folderLibrary must be a significant state key');
});

test('phase 0.7B-1B normalizer defines pack folders and clears stale folderId', async () => {
  const src = await fs.readFile(normalizerPath, 'utf8');
  const folderStart = src.indexOf('export function normalizeFolder(');
  const folderEnd = src.indexOf('\nexport function normalizePack', folderStart + 1);
  const folderFn = folderStart >= 0 && folderEnd > folderStart ? src.slice(folderStart, folderEnd) : '';
  const start = src.indexOf('export function normalizePack(');
  const end = src.indexOf('\nexport function normalizeAppData', start + 1);
  const fn = start >= 0 && end > start ? src.slice(start, end) : '';
  const appStart = src.indexOf('export function normalizeAppData(');
  const appFn = appStart >= 0 ? src.slice(appStart) : '';

  assert.ok(folderFn, 'normalizeFolder must be extractable');
  assert.match(folderFn, /scope:\s*'pack'/,
    'normalizeFolder must keep folders pack-scoped');
  assert.match(folderFn, /parentFolderId:\s*null/,
    'normalizeFolder must keep parentFolderId null in this phase');
  assert.ok(fn, 'normalizePack must be extractable');
  assert.match(fn, /const folderId = safeString\(p && p\.folderId, ''\) \|\| null/,
    'normalizePack must default folderId to null');
  assert.match(fn, /folderId,/,
    'normalizePack must include folderId in normalized packs');
  assert.match(appFn, /folderLibrary:\s*folders/,
    'normalizeAppData must return normalized folderLibrary');
  assert.match(appFn, /if \(pack\.folderId && !folderIds\.has\(pack\.folderId\)\) pack\.folderId = null;/,
    'normalizeAppData must clear stale pack folderId references');
});

test('phase 0.7B-1B normalizer returns safe pack-only folder shape and nulls stale folderId at runtime', async () => {
  const Normalizer = await import(`${normalizerPath.href}?t=${Date.now()}-${Math.random()}`);

  const folder = Normalizer.normalizeFolder({
    id: 'folder-1',
    name: ' Client Work ',
    scope: 'case',
    parentFolderId: 'nested-folder',
    sortOrder: '12',
    createdAt: 100,
    updatedAt: 200,
    unexpected: 'drop-me',
  }, 1);

  assert.deepEqual(Object.keys(folder), ['id', 'name', 'scope', 'parentFolderId', 'sortOrder', 'createdAt', 'updatedAt'],
    'normalizeFolder must return only the approved folder fields');
  assert.equal(folder.name, 'Client Work',
    'normalizeFolder must trim names');
  assert.equal(folder.scope, 'pack',
    'normalizeFolder must force pack-only scope');
  assert.equal(folder.parentFolderId, null,
    'normalizeFolder must keep nesting disabled in this phase');

  const normalized = Normalizer.normalizeAppData({
    caseLibrary: [],
    folderLibrary: [folder],
    packLibrary: [
      { id: 'pack-1', title: 'Known', folderId: 'folder-1', cases: [] },
      { id: 'pack-2', title: 'Stale', folderId: 'missing-folder', cases: [] },
      { id: 'pack-3', title: 'Empty', cases: [] },
    ],
    preferences: {},
  });

  assert.equal(normalized.packLibrary[0].folderId, 'folder-1',
    'normalizeAppData must preserve valid pack folderId');
  assert.equal(normalized.packLibrary[1].folderId, null,
    'normalizeAppData must null stale pack folderId');
  assert.equal(normalized.packLibrary[2].folderId, null,
    'normalizePack must default missing folderId to null');
});

test('phase 0.7B-1B storage saves and loads folderLibrary only in workspace payload', async () => {
  const src = await fs.readFile(storagePath, 'utf8');
  const loadStart = src.indexOf('export function load()');
  const loadEnd = src.indexOf('\nexport function saveSoon', loadStart + 1);
  const loadFn = loadStart >= 0 && loadEnd > loadStart ? src.slice(loadStart, loadEnd) : '';
  const start = src.indexOf('export function saveNow()');
  const end = src.indexOf('\nexport function clearAll', start + 1);
  const fn = start >= 0 && end > start ? src.slice(start, end) : '';
  const userPayloadStart = fn.indexOf('const userPayload = {');
  const workspacePayloadStart = fn.indexOf('const workspacePayload = {');
  const userPayload = userPayloadStart >= 0 && workspacePayloadStart > userPayloadStart
    ? fn.slice(userPayloadStart, workspacePayloadStart)
    : '';

  assert.ok(loadFn, 'load must be extractable');
  assert.match(loadFn, /folderLibrary:[\s\S]{0,140}effectiveWorkspacePayload\.folderLibrary/,
    'load must return folderLibrary from the effective workspace payload');
  assert.ok(fn, 'saveNow must be extractable');
  assert.doesNotMatch(userPayload, /folderLibrary/,
    'folderLibrary must not be saved in user-scoped preferences payload');
  assert.match(fn, /folderLibrary:\s*Array\.isArray\(state\.folderLibrary\)/,
    'saveNow workspace payload must include folderLibrary');
});

test('phase 0.7B-1B storage load defaults missing folderLibrary to empty workspace array', async () => {
  const Storage = await import(`${storagePath.href}?t=${Date.now()}-${Math.random()}`);
  const originalWindow = globalThis.window;
  const values = new Map();
  const localStorage = {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    key(index) {
      return Array.from(values.keys())[index] || null;
    },
  };

  try {
    globalThis.window = { localStorage };
    Storage.setStorageScope('user-1');
    Storage.setWorkspaceScope('org-1');
    localStorage.setItem('truckPacker3d:v1:user-1', JSON.stringify({
      version: 'test',
      savedAt: 1,
      preferences: {},
    }));
    localStorage.setItem('truckPacker3d:v1:user-1:workspace:org-1', JSON.stringify({
      version: 'test',
      savedAt: 2,
      caseLibrary: [],
      packLibrary: [],
      currentPackId: null,
    }));

    const loaded = Storage.load();
    assert.deepEqual(loaded.folderLibrary, [],
      'load must default old workspace payloads without folderLibrary to []');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('phase 0.7B-1B exportWorkspaceJSON includes folderLibrary and preserves pack folderId', async () => {
  const src = await fs.readFile(storagePath, 'utf8');
  const start = src.indexOf('export function exportWorkspaceJSON(');
  const end = src.indexOf('\nexport function importAppJSON', start + 1);
  const fn = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(fn, 'exportWorkspaceJSON must be extractable');
  assert.match(fn, /folderLibrary:[\s\S]*?\.map\(projectPortableFolder\)/,
    'workspace export must include folderLibrary');
  assert.doesNotMatch(fn, /folderId:\s*null/,
    'workspace export must not strip pack folderId');
  assert.match(fn, /portablePacks\.map\(projectPortableWorkspacePack\)/,
    'workspace export must keep thumbnail stripping through the portable Pack projection');
});

test('phase 0.7B-1B parseWorkspaceImportJSON keeps legacy folderless support but requires folders in v1', async () => {
  const ImportExport = await import(`${importExportPath.href}?t=${Date.now()}-${Math.random()}`);
  assert.throws(() => ImportExport.parseWorkspaceImportJSON(JSON.stringify({
    format: 'cargo-planner',
    kind: 'workspace-backup',
    schemaVersion: 1,
    createdAt: '2026-09-11T12:00:00.000Z',
    appVersion: 'test',
    units: { length: 'in', weight: 'lb' },
    data: { caseLibrary: [], packLibrary: [] },
  })), /folderLibrary.*array/i,
  'new v1 workspace backups must contain an explicit folderLibrary array');

  const legacy = ImportExport.parseWorkspaceImportJSON(JSON.stringify({
    exportType: 'workspace',
    data: { caseLibrary: [], packLibrary: [] },
  }));
  assert.deepEqual(legacy.folderLibrary, []);
  assert.match(legacy.warnings.join(' '), /Legacy backup had no folder library/,
    'legacy folderless workspace backups must retain their compatibility warning');
});

test('phase 0.7B-1B workspace import parser accepts old exports and rejects malformed folderLibrary at runtime', async () => {
  const ImportExport = await import(`${importExportPath.href}?t=${Date.now()}-${Math.random()}`);
  const oldExport = JSON.stringify({
    app: 'Truck Packer 3D',
    exportType: 'workspace',
    data: {
      caseLibrary: [],
      packLibrary: [],
    },
  });
  const parsed = ImportExport.parseWorkspaceImportJSON(oldExport);

  assert.deepEqual(parsed.folderLibrary, [],
    'workspace import parser must default missing folderLibrary to []');
  assert.throws(() => ImportExport.parseWorkspaceImportJSON(JSON.stringify({
    exportType: 'workspace',
    data: {
      caseLibrary: [],
      packLibrary: [],
      folderLibrary: {},
    },
  })), /Invalid folderLibrary/,
    'workspace import parser must reject non-array folderLibrary');
});

test('phase 0.7B-1B app export includes and imports normalized folderLibrary as full local backup', async () => {
  const StateStore = await import(stateStorePath.href);
  const Storage = await import(`${storagePath.href}?t=${Date.now()}-${Math.random()}`);

  StateStore.init({
    caseLibrary: [],
    packLibrary: [
      { id: 'pack-1', title: 'Known', folderId: 'folder-1', cases: [] },
      { id: 'pack-2', title: 'Stale', folderId: 'missing-folder', cases: [] },
    ],
    folderLibrary: [
      {
        id: 'folder-1',
        name: 'Folder 1',
        scope: 'pack',
        parentFolderId: null,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    preferences: {},
  });

  const exported = JSON.parse(Storage.exportAppJSON());
  assert.equal(exported.data.folderLibrary.length, 1,
    'App Export is the full local backup path and must include folderLibrary');

  const imported = Storage.importAppJSON(JSON.stringify({
    app: 'Truck Packer 3D',
    data: {
      caseLibrary: [],
      packLibrary: [exported.data.packLibrary[0]],
      folderLibrary: exported.data.folderLibrary,
      preferences: {},
    },
  }));
  assert.equal(imported.packLibrary[0].folderId, 'folder-1',
    'App Import must preserve valid folderId references');
  assert.throws(() => Storage.importAppJSON(JSON.stringify({
    app: 'Truck Packer 3D',
    data: exported.data,
  })), /folderId.*does not exist/i,
  'destructive App Import must reject stale folder references before lossy normalization');
});

test('phase 0.7B-1B single pack export does not carry folder assignments', async () => {
  const src = await fs.readFile(importExportPath, 'utf8');
  const start = src.indexOf('export function buildPackExportPayload(');
  const end = src.indexOf('\nexport function buildPackExportJSON', start + 1);
  const fn = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(fn, 'buildPackExportPayload must be extractable');
  assert.match(fn, /folderId:\s*null/,
    'single pack export must clear folderId until single-pack folder import exists');
});

test('phase 0.7B-1B single pack import clears folderId to null', async () => {
  // Runtime behavior: a single pack import must drop any incoming folderId because
  // folder import is workspace-level only (replaces a brittle source-slice check).
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(`${packLibraryPath.href}?t=${Date.now()}-${Math.random()}`);
  StateStore.init({ caseLibrary: [], packLibrary: [], folderLibrary: [], preferences: {} });
  const imported = PackLibrary.importPackPayload(makePackImportPayload(
    makePackImportSafeCase({ id: 'c-folder', name: 'Folder Case' }),
    [makePackImportInstance('c-folder', { id: 'i-folder', transform: { position: { x: 5, y: 5, z: 0 } } })],
    { folderId: 'some-folder-id' }
  ));
  assert.equal(imported.folderId, null,
    'single pack import must clear folderId because folder import is workspace-level only');
});

test('phase 0.7B-1B folder-library service is local StateStore only', async () => {
  const src = await fs.readFile(folderLibraryPath, 'utf8');

  assert.match(src, /from '\.\.\/core\/state-store\.js'/,
    'folder service must use StateStore');
  assert.match(src, /from '\.\.\/core\/utils\/index\.js'/,
    'folder service may use local utilities for UUIDs');
  assert.doesNotMatch(src, /supabase|functions\.invoke|serviceClient|createClient|EdgeFunction/i,
    'folder service must not use Supabase or Edge Functions');
  assert.doesNotMatch(src, /stripe|billing|billing-status|checkout|portal|webhook/i,
    'folder service must not touch Stripe or billing');
  assert.doesNotMatch(src, /localStorage|window\.localStorage|signOut|location\.reload/i,
    'folder service must not read raw storage, sign out, or reload');
  assert.doesNotMatch(src, /organization_id|owner_id|user_id|auth\.users|organization_members/i,
    'folder service must not use server identity or membership fields');
});

test('phase 0.7B-1B folder-library create list rename move use StateStore data only', async () => {
  const StateStore = await import(stateStorePath.href);
  const FolderLibrary = await import(`${folderLibraryPath.href}?t=${Date.now()}-${Math.random()}`);

  StateStore.init({
    caseLibrary: [],
    packLibrary: [{ id: 'pack-1', title: 'Pack 1', folderId: null }],
    folderLibrary: [],
    preferences: {},
  });

  const a = FolderLibrary.createFolder('Beta');
  const b = FolderLibrary.createFolder('Alpha');
  assert.equal(a.scope, 'pack',
    'createFolder must create pack-scoped folders');
  assert.equal(a.parentFolderId, null,
    'createFolder must not create nested folders in this phase');
  assert.deepEqual(FolderLibrary.listFolders().map(folder => folder.name), ['Beta', 'Alpha'],
    'listFolders must return StateStore folders in sort order');

  const renamed = FolderLibrary.renameFolder(b.id, 'Alpha Renamed');
  assert.equal(renamed.name, 'Alpha Renamed',
    'renameFolder must update by id, not by name');
  assert.equal(FolderLibrary.movePackToFolder('pack-1', b.id).folderId, b.id,
    'movePackToFolder must assign a valid folder id');
});

test('phase 0.7B-1B deleteFolder nulls pack folder references without deleting packs or cases', async () => {
  const StateStore = await import(stateStorePath.href);
  const FolderLibrary = await import(`${folderLibraryPath.href}?t=${Date.now()}-${Math.random()}`);

  StateStore.init({
    caseLibrary: [{ id: 'case-1', name: 'Case 1' }],
    packLibrary: [
      { id: 'pack-1', title: 'Pack 1', folderId: 'folder-1', cases: [{ id: 'inst-1', caseId: 'case-1' }], thumbnail: 'preview' },
      { id: 'pack-2', title: 'Pack 2', folderId: 'folder-1' },
      { id: 'pack-3', title: 'Pack 3', folderId: null },
    ],
    folderLibrary: [
      {
        id: 'folder-1',
        name: 'Folder 1',
        scope: 'pack',
        parentFolderId: null,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    preferences: {},
  });

  assert.equal(FolderLibrary.deleteFolder('folder-1'), true);
  const state = StateStore.get();

  assert.equal(state.folderLibrary.length, 0,
    'deleteFolder must remove the folder');
  assert.equal(state.packLibrary.length, 3,
    'deleteFolder must not delete packs');
  assert.deepEqual(state.packLibrary.map(pack => pack.folderId), [null, null, null],
    'deleteFolder must null affected pack folderId values');
  assert.equal(state.caseLibrary.length, 1,
    'deleteFolder must not touch cases');
  assert.deepEqual(state.packLibrary[0].cases, [{ id: 'inst-1', caseId: 'case-1' }],
    'deleteFolder must not delete pack contents');
  assert.equal(state.packLibrary[0].thumbnail, 'preview',
    'deleteFolder must not delete pack previews');
});

test('phase 0.7B-1B pack delete does not mutate folderLibrary', async () => {
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(`${new URL('../../src/services/pack-library.js', import.meta.url).href}?t=${Date.now()}-${Math.random()}`);

  StateStore.init({
    caseLibrary: [],
    packLibrary: [{ id: 'pack-1', title: 'Pack 1', folderId: 'folder-1' }],
    folderLibrary: [
      {
        id: 'folder-1',
        name: 'Folder 1',
        scope: 'pack',
        parentFolderId: null,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    preferences: {},
    currentPackId: 'pack-1',
  });

  PackLibrary.remove('pack-1');
  const state = StateStore.get();

  assert.equal(state.packLibrary.length, 0,
    'PackLibrary.remove must delete the pack');
  assert.equal(state.folderLibrary.length, 1,
    'PackLibrary.remove must not mutate folderLibrary');
  assert.equal(state.folderLibrary[0].id, 'folder-1',
    'folder identity must survive pack deletion');
});

test('phase 0.7B-1B movePackToFolder requires existing folder identity and allows null', async () => {
  const StateStore = await import(stateStorePath.href);
  const FolderLibrary = await import(`${folderLibraryPath.href}?t=${Date.now()}-${Math.random()}`);

  StateStore.init({
    caseLibrary: [],
    packLibrary: [{ id: 'pack-1', title: 'Pack 1', folderId: null, lastEdited: 1 }],
    folderLibrary: [
      {
        id: 'folder-1',
        name: 'Folder 1',
        scope: 'pack',
        parentFolderId: null,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    preferences: {},
  });

  const moved = FolderLibrary.movePackToFolder('pack-1', 'folder-1');
  assert.equal(moved.folderId, 'folder-1',
    'movePackToFolder must assign an existing folder id');
  assert.equal(FolderLibrary.movePackToFolder('pack-1', 'missing-folder'), null,
    'movePackToFolder must reject unknown folder ids');
  const removed = FolderLibrary.movePackToFolder('pack-1', null);
  assert.equal(removed.folderId, null,
    'movePackToFolder must allow moving a pack back to uncategorized');
});

test('phase 0.7B-1B partial StateStore updates preserve existing folderLibrary', async () => {
  const StateStore = await import(stateStorePath.href);

  StateStore.init({
    caseLibrary: [],
    packLibrary: [{ id: 'pack-1', title: 'Pack 1', folderId: 'folder-1' }],
    folderLibrary: [{ id: 'folder-1', name: 'Folder 1' }],
    preferences: {},
  });

  StateStore.set({ packLibrary: [{ id: 'pack-2', title: 'Pack 2', folderId: null }] });
  assert.deepEqual(StateStore.get('folderLibrary'), [{ id: 'folder-1', name: 'Folder 1' }],
    'StateStore.set partial updates must not wipe folderLibrary');

  StateStore.set({ folderLibrary: [] });
  assert.deepEqual(StateStore.get('folderLibrary'), [],
    'StateStore.set must update folderLibrary only when explicitly provided');
});

test('phase 0.7B-1B workspace export runtime payload includes folderLibrary', async () => {
  const StateStore = await import(stateStorePath.href);
  const Storage = await import(`${storagePath.href}?t=${Date.now()}-${Math.random()}`);

  StateStore.init({
    caseLibrary: [],
    packLibrary: [{ id: 'pack-1', title: 'Pack 1', folderId: 'folder-1', thumbnail: 'data:image/jpeg;base64,x' }],
    folderLibrary: [
      {
        id: 'folder-1',
        name: 'Folder 1',
        scope: 'pack',
        parentFolderId: null,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    preferences: {},
  });

  const payload = JSON.parse(Storage.exportWorkspaceJSON('Workspace A'));
  assert.equal(payload.data.folderLibrary.length, 1,
    'workspace export must include folderLibrary');
  assert.equal(payload.data.packLibrary[0].folderId, 'folder-1',
    'workspace export must preserve pack folderId');
  assert.equal(Object.prototype.hasOwnProperty.call(payload.data.packLibrary[0], 'thumbnail'), false,
    'workspace export must omit thumbnail data entirely');
});

test('phase 0.7C-pre folderLibrary changes participate in autosave with packLibrary changes', async () => {
  const src = await readAppSource();
  const saveCall = 'Storage.saveSoon();';
  const saveCallIndex = src.indexOf(saveCall);
  const conditionStart = src.lastIndexOf('if (', saveCallIndex);
  const autosaveBlock = conditionStart >= 0 && saveCallIndex > conditionStart
    ? src.slice(conditionStart, saveCallIndex + saveCall.length)
    : '';

  assert.ok(autosaveBlock.length > 0,
    'app StateStore autosave block must be extractable');
  assert.match(autosaveBlock, /changes\.packLibrary/,
    'autosave block must still include packLibrary');
  assert.match(autosaveBlock, /changes\.folderLibrary/,
    'folderLibrary changes must trigger the same autosave path as packLibrary');
  assert.match(autosaveBlock, /!suspendAutoSave/,
    'folderLibrary autosave must preserve existing suspendAutoSave guard');
});

test('phase 0.7C-pre folderLibrary changes trigger Packs screen render with packLibrary changes', async () => {
  const src = await readAppSource();
  const subscriberStart = src.indexOf("let prevScreen = StateStore.get('currentScreen');");
  const conditionStart = src.indexOf('if (changes.caseLibrary || changes.packLibrary || changes.folderLibrary', subscriberStart);
  const renderCallIndex = src.indexOf('PacksUI.render();', conditionStart);
  const renderBlock = conditionStart >= 0 && renderCallIndex > conditionStart
    ? src.slice(conditionStart, renderCallIndex + 'PacksUI.render();'.length)
    : '';

  assert.ok(renderBlock.length > 0,
    'app StateStore packs render block must be extractable');
  assert.match(renderBlock, /changes\.packLibrary/,
    'packs render block must still include packLibrary');
  assert.match(renderBlock, /changes\.folderLibrary/,
    'folderLibrary changes must trigger the same PacksUI.render path as packLibrary');
});

test('phase 0.7C-pre persistence render guard does not import folder UI or touch forbidden scope', async () => {
  const appSrc = await readAppSource();

  assert.doesNotMatch(appSrc, /import\s+\*\s+as\s+FolderLibrary|from ['"]\.\/services\/folder-library\.js['"]/,
    'Phase 0.7C-pre must not import FolderLibrary into app.js');
  assert.doesNotMatch(appSrc, /createFolder|renameFolder|deleteFolder|movePackToFolder|getPacksInFolder/,
    'Phase 0.7C-pre must not wire folder UI or folder CRUD actions in app.js');
});

test('phase 0.7C-1A packs screen uses FolderLibrary listFolders for dropdown options', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  assert.match(src, /import\s+\*\s+as\s+FolderLibrary\s+from ['"]\.\.\/services\/folder-library\.js['"]/,
    'packs screen must import the existing folder-library service');
  assert.match(src, /FolderLibrary\.listFolders\(\)/,
    'folder dropdown options must come from FolderLibrary.listFolders()');
  assert.match(src, /UIComponents\.openDropdown\(button, items/,
    'folder control must use the existing openDropdown pattern');
});

test('phase 0.7C-1A rejected folder chip row pattern is not present', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  assert.doesNotMatch(src, /function renderFolderBar|folderBarEl/,
    'the rejected always-visible folder bar must not be present');
  assert.doesNotMatch(src, /filtersRowEl\.nextSibling|insertBefore\([^)]*filtersRowEl/,
    'folder UI must not be mounted under the Empty Partial Full filter chip row');
  assert.doesNotMatch(src, /aria-label['"], ['"]Pack folder filters|label\.textContent = ['"]Folders['"]/,
    'folder UI must not add a visible Folders label under status filters');
});

test('phase 0.7C-1A folder filtering uses pack folderId identity not folder names', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const filterStart = src.indexOf('if (activeFolderId === null) return true;');
  const filterEnd = src.indexOf('if (activeFolderId === UNFILED_FOLDER_ID)', filterStart);
  const filterBlock = filterStart >= 0 && filterEnd > filterStart
    ? src.slice(filterStart, filterEnd + 140)
    : '';

  assert.ok(filterBlock.length > 0,
    'folder filter block must be extractable');
  assert.match(filterBlock, /p && p\.folderId/,
    'folder filtering must read pack.folderId');
  assert.doesNotMatch(filterBlock, /folder\.name|name === activeFolderId|activeFolderId === .*name/,
    'folder filtering must not use folder names as identity');
});

test('phase 0.7C-1A active folder state updates dataset key button label and workspace reset', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const resetStart = src.indexOf('function resetWorkspaceState()');
  const resetEnd = src.indexOf('\n    function ', resetStart + 1);
  const resetBlock = resetStart >= 0 && resetEnd > resetStart ? src.slice(resetStart, resetEnd) : '';

  assert.match(src, /let activeFolderId = null/,
    'folder filter state must default to All Packs');
  assert.match(src, /const UNFILED_FOLDER_ID = ['"]__unfiled__['"]/,
    'folder filter must support the unfiled sentinel');
  assert.match(src, /newDatasetKey = `\$\{q\}::\$\{sortKey\}::\$\{activeFolderId \|\| 'all'\}::/,
    'activeFolderId must be included in dataset key');
  assert.match(resetBlock, /activeFolderId = null/,
    'workspace reset must clear the active folder filter');
  assert.match(src, /foldersButtonLabelEl\.textContent = label/,
    'Folders button label must reflect active folder state');
  assert.match(src, /label = ['"]Unfiled['"]/,
    'Folders button must show Unfiled when unfiled is active');
  assert.match(src, /label = model\.activeFolder\.name/,
    'Folders button must show the folder name when a real folder is active');
});

test('phase 0.7C-1A existing search and status filters remain present', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  assert.match(src, /\.filter\(p => packMatchesSearch\(p, q\)\)/,
    'the normalized Load Plan search filter must remain');
  assert.match(
    src,
    /\[pack && pack\.title, pack && pack\.client, pack && pack\.loadPlanNumber, pack && pack\.customerReference\]/,
    'Title and Client search remain alongside Load Plan Number and Customer Reference'
  );
  assert.match(src, /filters\.empty[\s\S]{0,80}filters\.partial[\s\S]{0,80}filters\.full/,
    'existing Empty/Partial/Full filter state must remain');
  assert.match(src, /if \(filters\.empty && isEmpty\) return true;/,
    'Empty status filter must remain');
  assert.match(src, /if \(filters\.partial && isPartial\) return true;/,
    'Partial status filter must remain');
  assert.match(src, /if \(filters\.full && isFull\) return true;/,
    'Full status filter must remain');
});

test('phase 0.7C-1A folder dropdown is filter only and avoids CRUD move UI', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openFoldersDropdown()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const dropdownBlock = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(src, /defaultActionsEl\.insertBefore\(foldersButtonEl, defaultActionsEl\.firstChild\)/,
    'Folders button must remain first in the Load Plans top action area');
  assert.match(dropdownBlock, /label: `All Load Plans \(\$\{model\.totalCount\}\)`/,
    'Folders dropdown must include All Load Plans with count');
  assert.match(dropdownBlock, /label: `Unfiled \(\$\{model\.unfiledCount\}\)`/,
    'Folders dropdown must include Unfiled with count');
  assert.match(dropdownBlock, /label: ['"]No folders yet['"][\s\S]{0,100}disabled: true/,
    'Folders dropdown must show disabled No folders yet row');
  assert.doesNotMatch(dropdownBlock, /\b(renameFolder|deleteFolder|movePackToFolder|getPacksInFolder)\s*\(/,
    'Folders filter dropdown must not add rename, delete, move, or bulk folder UI');
});

test('phase 0.7C-1A folder dropdown avoids forbidden backend billing auth css router scope', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openFoldersDropdown()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const dropdownBlock = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(start >= 0 && end > start,
    'the folder dropdown source region must remain discoverable');
  assert.doesNotMatch(dropdownBlock, /supabase|stripe|billing-status|billing_customers|subscriptions|entitlement|auth\.|migrations|\.css|router/i,
    'folder dropdown must stay frontend-local and avoid backend, billing, auth, CSS, and router references');
  assert.doesNotMatch(dropdownBlock, /window\./,
    'folder dropdown must not add global window state');
});

test('phase 0.7C-1B preserves Empty Partial Full filter chips', async () => {
  const indexSrc = await fs.readFile(indexHtmlPath, 'utf8');
  const packsSrc = await fs.readFile(packsScreenPath, 'utf8');

  assert.match(indexSrc, /id=["']packs-filter-chip-all["']/,
    'All filter chip must remain in index.html');
  assert.match(indexSrc, /id=["']packs-filter-chip-empty["']/,
    'Empty filter chip must remain in index.html');
  assert.match(indexSrc, /id=["']packs-filter-chip-partial["']/,
    'Partial filter chip must remain in index.html');
  assert.match(indexSrc, /id=["']packs-filter-chip-full["']/,
    'Full filter chip must remain in index.html');
  assert.match(packsSrc, /wireChip\(chipAll, ['"]all['"]\)/,
    'All filter chip wiring must remain');
  assert.match(packsSrc, /wireChip\(chipEmpty, ['"]empty['"]\)/,
    'Empty filter chip wiring must remain');
  assert.match(packsSrc, /wireChip\(chipPartial, ['"]partial['"]\)/,
    'Partial filter chip wiring must remain');
  assert.match(packsSrc, /wireChip\(chipFull, ['"]full['"]\)/,
    'Full filter chip wiring must remain');
  assert.match(packsSrc, /filters\.empty = false;[\s\S]*filters\.partial = false;[\s\S]*filters\.full = false;/,
    'All filter chip must clear the status filters');
});

test('phase 0.7C-1B folders button uses scoped structure without tooltip or ghost style', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function ensureFoldersButton()');
  const end = src.indexOf('\n    function getOpenFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(block.length > 0,
    'Folders button/dropdown block must be extractable');
  assert.match(block, /className = ['"]btn tp3d-packs-folder-btn['"]/,
    'Folders button must use btn plus scoped class');
  assert.doesNotMatch(block, /btn-ghost/,
    'Folders button must not use btn-ghost');
  assert.doesNotMatch(block, /data-tooltip/,
    'Folders button must not set data-tooltip');
  assert.match(block, /tp3d-packs-folder-btn__icon/,
    'Folders button must include scoped icon span');
  assert.match(block, /tp3d-packs-folder-btn__label/,
    'Folders button must include scoped label span');
  assert.doesNotMatch(block, /tp3d-packs-folder-btn__caret/,
    'Folders button must not include caret span (caret intentionally removed in 0.7C-1B)');
  assert.doesNotMatch(block, /fa-chevron-down/,
    'Folders button must not include fa-chevron-down (caret intentionally removed in 0.7C-1B)');
  assert.match(block, /tp3d-packs-folder-btn--active/,
    'Folders button must use scoped active class');
  assert.doesNotMatch(block, /btn-primary/,
    'Folders button active state must not use solid primary button styling');
});

test('phase 0.7C-1B folders button has ARIA state and same-button dropdown toggle', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function ensureFoldersButton()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(src, /const FOLDERS_DROPDOWN_ROLE = ['"]packs-folders['"]/,
    'Folders dropdown role constant must be packs-folders');
  assert.match(src, /const FOLDERS_DROPDOWN_ANCHOR_KEY = ['"]packs-folders-button['"]/,
    'Folders dropdown anchor key constant must be packs-folders-button');
  assert.match(block, /aria-haspopup['"], ['"]menu['"]/,
    'Folders button must declare menu popup semantics');
  assert.match(block, /aria-expanded['"], ['"]false['"]/,
    'Folders button must default aria-expanded to false');
  assert.match(block, /aria-expanded[\s\S]{0,120}expanded \? ['"]true['"] : ['"]false['"]/,
    'Folders button must update aria-expanded from dropdown state');
  assert.match(block, /\[data-dropdown="1"\]\[data-role="\$\{FOLDERS_DROPDOWN_ROLE\}"\]\[data-anchor-id="\$\{FOLDERS_DROPDOWN_ANCHOR_KEY\}"\]/,
    'same-button toggle must query by data-dropdown, data-role, and data-anchor-id');
  assert.match(block, /if \(existing\)[\s\S]{0,120}UIComponents\.closeAllDropdowns\(\)/,
    'clicking the same Folders button while open must close the existing dropdown');
  assert.match(block, /role:\s*FOLDERS_DROPDOWN_ROLE/,
    'openDropdown must receive the scoped role');
  assert.match(block, /anchorKey:\s*FOLDERS_DROPDOWN_ANCHOR_KEY/,
    'openDropdown must receive the scoped anchor key');
  assert.match(block, /align:\s*['"]left['"]/,
    'Folders dropdown must align left under the button');
  assert.match(block, /width:\s*260/,
    'Folders dropdown must use the polished width');
});

test('phase 0.7C-1B dropdown active rows match active folder filter state', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openFoldersDropdown()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /active:\s*activeFolderId === null/,
    'All Packs row must be active when activeFolderId is null');
  assert.match(block, /rightIcon:\s*activeFolderId === null \? ['"]fa-solid fa-check['"]/,
    'All Packs row must show active check icon when selected');
  assert.match(block, /active:\s*activeFolderId === UNFILED_FOLDER_ID/,
    'Unfiled row must be active when the unfiled sentinel is selected');
  assert.match(block, /rightIcon:\s*activeFolderId === UNFILED_FOLDER_ID \? ['"]fa-solid fa-check['"]/,
    'Unfiled row must show active check icon when selected');
  assert.match(block, /active:\s*activeFolderId === folderId/,
    'Folder rows must be active by exact folder id match');
  assert.match(block, /rightIcon:\s*activeFolderId === folderId \? ['"]fa-solid fa-check['"]/,
    'Folder rows must show active check icon by exact folder id match');
});

test('phase 0.7C-1B folder filtering still uses folderId state and reset behavior', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const filterStart = src.indexOf('if (activeFolderId === null) return true;');
  const filterEnd = src.indexOf('if (activeFolderId === UNFILED_FOLDER_ID)', filterStart);
  const filterBlock = filterStart >= 0 && filterEnd > filterStart
    ? src.slice(filterStart, filterEnd + 140)
    : '';
  const resetStart = src.indexOf('function resetWorkspaceState()');
  const resetEnd = src.indexOf('\n    function ', resetStart + 1);
  const resetBlock = resetStart >= 0 && resetEnd > resetStart ? src.slice(resetStart, resetEnd) : '';

  assert.match(src, /FolderLibrary\.listFolders\(\)/,
    'Folders dropdown options must still come from FolderLibrary.listFolders()');
  assert.match(filterBlock, /p && p\.folderId/,
    'folder filtering must still use pack.folderId');
  assert.doesNotMatch(filterBlock, /folder\.name|name === activeFolderId|activeFolderId === .*name/,
    'folder filtering must not use folder names as identity');
  assert.match(src, /newDatasetKey = `\$\{q\}::\$\{sortKey\}::\$\{activeFolderId \|\| 'all'\}::/,
    'activeFolderId must remain in dataset key');
  assert.match(resetBlock, /activeFolderId = null/,
    'workspace reset must clear activeFolderId');
});

test('phase 0.7C-1B avoids rejected folder UI and bulk folder actions', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  assert.doesNotMatch(src, /function renderFolderBar|folderBarEl/,
    'the rejected always-visible folder bar must not be present');
  assert.doesNotMatch(src, /filtersRowEl\.nextSibling|insertBefore\([^)]*filtersRowEl/,
    'folder UI must not be mounted under the Empty Partial Full filter chip row');
  assert.doesNotMatch(src, /folder side(panel|bar)|folderPanel|foldersSidebar/i,
    'Phase 0.7C-1B must not add a sidebar folder panel');
  assert.doesNotMatch(src, /bulk.*folder|folder.*bulk/i,
    'Phase 0.7C-1B must not add bulk folder actions');
});

test('phase 0.7C-1B scoped CSS styles only the packs folder button', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');
  const start = css.indexOf('.tp3d-packs-folder-btn {');
  const end = css.indexOf('.tp3d-packs-titlewrap', start + 1);
  const block = start >= 0 && end > start ? css.slice(start, end) : '';

  assert.ok(block.length > 0,
    'scoped packs folder button CSS block must exist');
  assert.match(block, /\.tp3d-packs-folder-btn \{/,
    'base packs folder button style must be scoped');
  assert.match(block, /\.tp3d-packs-folder-btn:hover/,
    'hover style must be scoped');
  assert.match(block, /\.tp3d-packs-folder-btn:focus-visible/,
    'focus-visible style must be scoped');
  assert.match(block, /\.tp3d-packs-folder-btn--active/,
    'active style must be scoped');
  assert.match(block, /\.tp3d-packs-folder-btn__icon/,
    'icon style must be scoped');
  assert.match(block, /\.tp3d-packs-folder-btn__label[\s\S]{0,220}text-overflow:\s*ellipsis/,
    'label style must truncate long folder names');
  assert.doesNotMatch(block, /\.tp3d-packs-folder-btn__caret/,
    'caret CSS must stay removed because the Folders button no longer renders a caret');
  assert.match(block, /\.tp3d-packs-folder-option-btn \{/,
    'Move to Folder modal rows must use scoped folder option button styles');
  assert.match(block, /\.tp3d-packs-folder-option-btn__label[\s\S]{0,220}text-overflow:\s*ellipsis/,
    'Move to Folder modal row labels must truncate long folder names');
  assert.doesNotMatch(block, /\.btn\b|\.dropdown-menu|\.dropdown-item/,
    'Phase 0.7C-1B CSS must not style global buttons or dropdowns');
});

test('phase 0.7C-2 create folder uses existing modal and folder library create API', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openCreateFolderModal()');
  const end = src.indexOf('\n    function openFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(block.length > 0,
    'openCreateFolderModal must exist inside PacksUI');
  assert.match(block, /UIComponents\.showModal\(/,
    'Create Folder must use the existing modal path');
  assert.match(block, /title:\s*['"]New Folder['"]/,
    'Create Folder modal title must be New Folder');
  assert.match(block, /field\(['"]Folder name['"], ['"]text['"], ['"]e\.g\. Client A['"], false\)/,
    'Create Folder modal must use field() for optional folder name input');
  assert.match(block, /FolderLibrary\.createFolder\(folderName\)/,
    'Create Folder modal must call FolderLibrary.createFolder()');
});

test('phase 0.7C-2 create folder selects created folder and refreshes packs', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openCreateFolderModal()');
  const end = src.indexOf('\n    function openFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /if \(created && created\.id\)/,
    'Create Folder must guard created folder id before selecting it');
  assert.match(block, /activeFolderId = String\(created\.id\)/,
    'Create Folder must select the newly created folder when an id is returned');
  assert.match(block, /packsListState\.pageIndex = 0/,
    'Create Folder must reset pack pagination when selecting the new folder');
  assert.match(block, /\brender\(\)/,
    'Create Folder must re-render the Packs screen');
  assert.match(block, /UIComponents\.showToast\(['"]Folder created['"], ['"]success['"]\)/,
    'Create Folder must show a success toast');
});

test('phase 0.7C-2 folder dropdown includes New Folder action after filter rows', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openFoldersDropdown()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /label:\s*['"]New Folder['"]/,
    'Folders dropdown must include New Folder action');
  assert.match(block, /icon:\s*['"]fa-solid fa-folder-plus['"]/,
    'New Folder action must use folder-plus icon');
  assert.match(block, /UIComponents\.closeAllDropdowns\(\)[\s\S]{0,120}setFoldersButtonExpanded\(false\)[\s\S]{0,120}openCreateFolderModal\(\)/,
    'New Folder action must close the dropdown, clear aria-expanded, and open the modal');
  assert.ok(block.indexOf("label: 'No folders yet'") < block.indexOf("label: 'New Folder'"),
    'New Folder action must come after No folders yet when no folders exist');
});

test('phase 0.7C-2 create folder avoids native dialogs', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  assert.doesNotMatch(src, /window\.prompt|window\.alert|window\.confirm/,
    'Packs screen must not use window prompt alert or confirm APIs');
  assert.doesNotMatch(src, /(^|[^\w.])prompt\s*\(|(^|[^\w.])alert\s*\(|(^|[^\w.])confirm\s*\(/,
    'Packs screen must not use native prompt(), alert(), or confirm() calls');
});

test('phase 0.7C-2 preserves no-caret Folders button contract', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function ensureFoldersButton()');
  const end = src.indexOf('\n    function renderFoldersButton(', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.doesNotMatch(block, /tp3d-packs-folder-btn__caret/,
    'Folders button must not reintroduce caret span');
  assert.doesNotMatch(block, /fa-chevron-down/,
    'Folders button must not reintroduce chevron icon');
  assert.doesNotMatch(block, /data-tooltip/,
    'Folders button must not reintroduce tooltip behavior');
  assert.doesNotMatch(block, /btn-ghost/,
    'Folders button must not reintroduce btn-ghost');
});

test('phase 0.7C-2 does not add bulk sidebar or chip-row folder UI', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  assert.doesNotMatch(src, /bulk.*folder|folder.*bulk/i,
    'Phase 0.7C-2 must not add bulk folder actions');
  assert.doesNotMatch(src, /function renderFolderBar|folderBarEl|folder side(panel|bar)|folderPanel|foldersSidebar/i,
    'Phase 0.7C-2 must not add folder bar, chip row, or sidebar panel');
});

test('phase 0.7C-2 preserves folder filtering identity and reset behavior', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const filterStart = src.indexOf('if (activeFolderId === null) return true;');
  const filterEnd = src.indexOf('if (activeFolderId === UNFILED_FOLDER_ID)', filterStart);
  const filterBlock = filterStart >= 0 && filterEnd > filterStart
    ? src.slice(filterStart, filterEnd + 140)
    : '';
  const resetStart = src.indexOf('function resetWorkspaceState()');
  const resetEnd = src.indexOf('\n    function ', resetStart + 1);
  const resetBlock = resetStart >= 0 && resetEnd > resetStart ? src.slice(resetStart, resetEnd) : '';

  assert.match(filterBlock, /p && p\.folderId/,
    'folder filtering must still use pack.folderId');
  assert.doesNotMatch(filterBlock, /folder\.name|name === activeFolderId|activeFolderId === .*name/,
    'folder filtering must not use folder names as identity');
  assert.match(src, /newDatasetKey = `\$\{q\}::\$\{sortKey\}::\$\{activeFolderId \|\| 'all'\}::/,
    'activeFolderId must remain in dataset key');
  assert.match(resetBlock, /activeFolderId = null/,
    'workspace reset must clear activeFolderId');
});

test('phase 0.7C-3 move modal uses folder library move API', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function movePackToFolder(');
  const end = src.indexOf('\n    function openFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(block.length > 0,
    'movePackToFolder and openMoveToFolderModal helpers must be extractable');
  assert.match(block, /function openMoveToFolderModal\(pack\)/,
    'openMoveToFolderModal(pack) helper must exist');
  assert.match(block, /UIComponents\.showModal\(/,
    'Move to Folder must use the existing modal path');
  assert.match(block, /FolderLibrary\.movePackToFolder\(pack\.id, folderIdOrNull\)/,
    'move helper must call FolderLibrary.movePackToFolder with pack id and target folder id');
  assert.match(block, /const folders = getSafeFolders\(\)/,
    'move helper must use folder options from the existing safe folder list');
  assert.match(src, /FolderLibrary\.listFolders\(\)/,
    'folder options must ultimately come from FolderLibrary.listFolders()');
  assert.doesNotMatch(src, /function buildMoveFolderItems\(pack\)/,
    'inline expanded buildMoveFolderItems helper must be removed');
});

test('phase 0.7C-3 move modal includes Unfiled folders and current state marker', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openMoveToFolderModal(pack)');
  const end = src.indexOf('\n    function openFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /addMoveRow\(['"]Unfiled['"], ['"]fa-solid fa-folder-open['"], null, currentFolderId === null\)/,
    'Move modal must include an Unfiled option that passes null');
  assert.match(block, /folders\.forEach\(folder =>[\s\S]{0,220}addMoveRow\(folder\.name \|\| ['"]Untitled Folder['"], ['"]fa-solid fa-folder['"], folderId, currentFolderId === folderId\)/,
    'Move modal must include real folder options from getSafeFolders');
  assert.match(block, /empty\.textContent = ['"]No folders yet['"]/,
    'Move modal must show No folders yet when no real folders exist');
  assert.match(block, /currentEl\.className = ['"]tp3d-packs-folder-option-btn__meta['"][\s\S]{0,120}currentEl\.textContent = ['"]Current['"]/,
    'Move modal must visibly mark the current location');
  assert.match(block, /if \(moved && modalRef && typeof modalRef\.close === ['"]function['"]\) modalRef\.close\(\)/,
    'successful move must close the modal');
});

test('phase 0.7C-3 move helper handles success and failed moves safely', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function movePackToFolder(');
  const end = src.indexOf('\n    function openMoveToFolderModal(pack)', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /if \(!moved\)[\s\S]{0,120}UIComponents\.showToast\(['"]Could not move load plan to folder['"], ['"]warning['"]\)/,
    'failed move must show a warning toast and not throw');
  assert.match(block, /packsListState\.pageIndex = 0/,
    'successful move must reset pack pagination');
  assert.match(block, /\brender\(\)/,
    'successful move must re-render Packs screen');
  assert.match(block, /UIComponents\.showToast\([\s\S]{0,120}['"]success['"]\)/,
    'successful move must show success toast');
  assert.match(block, /return true/,
    'successful move must report success to modal row handlers');
});

test('phase 0.7C-3 list and grid pack menus include compact move action between export and delete', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const listStart = src.indexOf('function renderListView(packs)');
  const listEnd = src.indexOf('\n    function renderGridView(packs)', listStart + 1);
  const listBlock = listStart >= 0 && listEnd > listStart ? src.slice(listStart, listEnd) : '';
  const gridStart = src.indexOf('function renderGridView(packs)');
  const gridEnd = src.indexOf('\n    function buildPreview(', gridStart + 1);
  const gridBlock = gridStart >= 0 && gridEnd > gridStart ? src.slice(gridStart, gridEnd) : '';

  assert.match(listBlock, /label:\s*['"]Export Load Plan JSON['"][\s\S]{0,220}label:\s*['"]Move to Folder['"][\s\S]{0,220}openMoveToFolderModal\(pack\)[\s\S]{0,220}label:\s*['"]Delete['"]/,
    'list view load plan menu must insert one Move to Folder action after Export Load Plan JSON and before Delete');
  assert.match(gridBlock, /label:\s*['"]Export Load Plan JSON['"][\s\S]{0,220}label:\s*['"]Move to Folder['"][\s\S]{0,220}openMoveToFolderModal\(pack\)[\s\S]{0,220}label:\s*['"]Delete['"]/,
    'grid view load plan menu must insert one Move to Folder action after Export Load Plan JSON and before Delete');
  assert.doesNotMatch(listBlock, /\.\.\.buildMoveFolderItems\(pack\)|type:\s*['"]header['"], label:\s*['"]Move to folder['"]/,
    'list view pack menu must not inline every folder choice');
  assert.doesNotMatch(gridBlock, /\.\.\.buildMoveFolderItems\(pack\)|type:\s*['"]header['"], label:\s*['"]Move to folder['"]/,
    'grid view pack menu must not inline every folder choice');
});

test('phase 0.7C-3 move helper does not touch pack delete or case library code', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function movePackToFolder(');
  const end = src.indexOf('\n    function openFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.doesNotMatch(block, /PackLibrary\.remove|CaseLibrary\./,
    'move helper must not delete packs or touch case library');
  assert.doesNotMatch(block, /FolderLibrary\.renameFolder\(|FolderLibrary\.deleteFolder\(/,
    'move helper must not add rename or delete folder behavior');
  assert.doesNotMatch(block, /bulk.*folder|folder.*bulk/i,
    'move helper must not add bulk folder behavior');
});

test('phase 0.7C-3 avoids native dialogs and preserves no-caret folder button', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function ensureFoldersButton()');
  const end = src.indexOf('\n    function renderFoldersButton(', start + 1);
  const buttonBlock = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.doesNotMatch(src, /window\.prompt|window\.alert|window\.confirm/,
    'Packs screen must not use window prompt alert or confirm APIs');
  assert.doesNotMatch(src, /(^|[^\w.])prompt\s*\(|(^|[^\w.])alert\s*\(|(^|[^\w.])confirm\s*\(/,
    'Packs screen must not use native prompt(), alert(), or confirm() calls');
  assert.doesNotMatch(buttonBlock, /tp3d-packs-folder-btn__caret|fa-chevron-down/,
    'Folders button must remain no-caret');
});

test('phase 0.7C-4 rename folder uses existing modal and folder library rename API', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openRenameFolderModal(folder)');
  const end = src.indexOf('\n    async function deleteFolderWithConfirm', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(block.length > 0,
    'openRenameFolderModal(folder) must exist');
  assert.match(block, /UIComponents\.showModal\(/,
    'Rename Folder must use the existing modal path');
  assert.match(block, /title:\s*['"]Rename Folder['"]/,
    'Rename Folder modal title must be Rename Folder');
  assert.match(block, /field\(['"]Folder name['"], ['"]text['"], ['"]e\.g\. Client A['"], false\)/,
    'Rename Folder modal must use field() for optional folder name input');
  assert.match(block, /name\.input\.value = folder\.name \|\| ['"]/,
    'Rename Folder modal must pre-fill the current folder name');
  assert.match(block, /FolderLibrary\.renameFolder\(folderId, name\.input\.value\)/,
    'Rename Folder must call FolderLibrary.renameFolder with folder id and input value');
  assert.match(block, /\brender\(\)/,
    'Rename Folder must refresh the Packs screen through render()');
  assert.match(block, /UIComponents\.showToast\(['"]Folder renamed['"], ['"]success['"]\)/,
    'Rename Folder must show a success toast');
});

test('phase 0.7C-4 delete folder uses confirm and preserves packs', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('async function deleteFolderWithConfirm(folder)');
  const end = src.indexOf('\n    function movePackToFolder(', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.ok(block.length > 0,
    'deleteFolderWithConfirm(folder) must exist');
  assert.match(block, /UIComponents\.confirm\(/,
    'Delete Folder must use the existing confirm path');
  assert.match(block, /title:\s*['"]Delete folder\?['"]/,
    'Delete Folder confirm title must be explicit');
  assert.match(block, /will move to Unfiled/,
    'Delete Folder confirm must state assigned packs move to Unfiled');
  assert.match(block, /Load plans will not be deleted/,
    'Delete Folder confirm must state packs are not deleted');
  assert.match(block, /PackLibrary\.getPacks\(\)\.filter/,
    'Delete Folder must count affected packs without deleting them');
  assert.match(block, /FolderLibrary\.deleteFolder\(folderId\)/,
    'Delete Folder must call FolderLibrary.deleteFolder');
  assert.doesNotMatch(block, /PackLibrary\.remove|CaseLibrary\.remove|CaseLibrary\./,
    'Delete Folder path must not delete packs or touch cases');
});

test('phase 0.7C-4 delete active folder clears active filter and resets pagination', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('async function deleteFolderWithConfirm(folder)');
  const end = src.indexOf('\n    function movePackToFolder(', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /if \(activeFolderId === folderId\)[\s\S]{0,120}activeFolderId = null/,
    'Deleting the active folder must clear activeFolderId to All Packs');
  assert.match(block, /if \(activeFolderId === folderId\)[\s\S]{0,160}packsListState\.pageIndex = 0/,
    'Deleting the active folder must reset pack pagination');
  assert.match(block, /\brender\(\)/,
    'Deleting a folder must refresh the Packs screen');
  assert.match(block, /UIComponents\.showToast\(['"]Folder deleted['"], ['"]success['"]\)/,
    'Deleting a folder must show a success toast');
});

test('phase 0.7C-4 Folders dropdown exposes rename delete only for active real folder', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openFoldersDropdown()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';
  const allStart = block.indexOf('label: `All Load Plans');
  const allEnd = block.indexOf('label: `Unfiled', allStart + 1);
  const allBlock = allStart >= 0 && allEnd > allStart ? block.slice(allStart, allEnd) : '';
  const unfiledStart = block.indexOf('label: `Unfiled');
  const unfiledEnd = block.indexOf('if (model.folders.length)', unfiledStart + 1);
  const unfiledBlock = unfiledStart >= 0 && unfiledEnd > unfiledStart ? block.slice(unfiledStart, unfiledEnd) : '';
  const actionsStart = block.indexOf('if (model.activeFolder && activeFolderId)');
  const actionsEnd = block.indexOf("label: 'New Folder'", actionsStart + 1);
  const actionsBlock = actionsStart >= 0 && actionsEnd > actionsStart ? block.slice(actionsStart, actionsEnd) : '';

  assert.doesNotMatch(allBlock, /Rename Folder|Delete Folder|openRenameFolderModal|deleteFolderWithConfirm/,
    'All Packs row must not expose folder rename or delete');
  assert.doesNotMatch(unfiledBlock, /Rename Folder|Delete Folder|openRenameFolderModal|deleteFolderWithConfirm/,
    'Unfiled row must not expose folder rename or delete');
  assert.match(actionsBlock, /if \(model\.activeFolder && activeFolderId\)/,
    'Rename and delete folder actions must be gated to an active real folder');
  assert.match(actionsBlock, /label:\s*['"]Rename Folder['"][\s\S]{0,180}openRenameFolderModal\(model\.activeFolder\)/,
    'Active real folder actions must include Rename Folder');
  assert.match(actionsBlock, /label:\s*['"]Delete Folder['"][\s\S]{0,220}deleteFolderWithConfirm\(model\.activeFolder\)/,
    'Active real folder actions must include Delete Folder');
});

test('phase 0.7C-4B app local state reload and reset paths preserve folderLibrary', async () => {
  const src = await readAppSource();
  const seedStart = src.indexOf('function seedIfEmpty()');
  const resetStart = src.indexOf('function resetAppStateToEmpty()');
  const loadStart = src.indexOf('function loadScopedStateOrSeed');
  const end = src.indexOf('\n    // ============================================================================', loadStart + 1);
  const seedBlock = seedStart >= 0 && resetStart > seedStart ? src.slice(seedStart, resetStart) : '';
  const resetBlock = resetStart >= 0 && loadStart > resetStart ? src.slice(resetStart, loadStart) : '';
  const loadBlock = loadStart >= 0 && end > loadStart ? src.slice(loadStart, end) : '';

  assert.match(seedBlock, /folderLibrary:\s*Array\.isArray\(stored\.folderLibrary\) \? stored\.folderLibrary : \[\]/,
    'seedIfEmpty stored load path must initialize StateStore with stored folderLibrary');
  assert.match(loadBlock, /folderLibrary:\s*Array\.isArray\(stored\.folderLibrary\) \? stored\.folderLibrary : \[\]/,
    'loadScopedStateOrSeed stored load path must initialize StateStore with stored folderLibrary');
  assert.match(resetBlock, /folderLibrary:\s*\[\]/,
    'resetAppStateToEmpty must clear folderLibrary explicitly');
  const fallbackCount = (src.match(/folderLibrary:\s*\[\]/g) || []).length;
  assert.ok(fallbackCount >= 4,
    'empty seed reset and no-workspace fallback state shapes must include folderLibrary: []');
});

test('phase 0.7C-4B folder mutations flush workspace persistence immediately', async () => {
  const appSrc = await readAppSource();
  const packsSrc = await fs.readFile(packsScreenPath, 'utf8');
  const createStart = packsSrc.indexOf('function openCreateFolderModal()');
  const createEnd = packsSrc.indexOf('\n    function openRenameFolderModal', createStart + 1);
  const createBlock = createStart >= 0 && createEnd > createStart ? packsSrc.slice(createStart, createEnd) : '';
  const renameStart = packsSrc.indexOf('function openRenameFolderModal(folder)');
  const renameEnd = packsSrc.indexOf('\n    async function deleteFolderWithConfirm', renameStart + 1);
  const renameBlock = renameStart >= 0 && renameEnd > renameStart ? packsSrc.slice(renameStart, renameEnd) : '';
  const deleteStart = packsSrc.indexOf('async function deleteFolderWithConfirm(folder)');
  const deleteEnd = packsSrc.indexOf('\n    function movePackToFolder(', deleteStart + 1);
  const deleteBlock = deleteStart >= 0 && deleteEnd > deleteStart ? packsSrc.slice(deleteStart, deleteEnd) : '';
  const moveStart = packsSrc.indexOf('function movePackToFolder(');
  const moveEnd = packsSrc.indexOf('\n    function openMoveToFolderModal(pack)', moveStart + 1);
  const moveBlock = moveStart >= 0 && moveEnd > moveStart ? packsSrc.slice(moveStart, moveEnd) : '';

  assert.match(appSrc, /persistNow:\s*\(\) => Storage\.saveNow\(\)/,
    'app.js must pass an immediate workspace save callback into the Packs screen');
  assert.match(packsSrc, /function persistFolderStateNow\(\)[\s\S]{0,180}persistNow\(\)/,
    'Packs screen must expose a narrow immediate persistence helper');
  assert.match(createBlock, /FolderLibrary\.createFolder\(folderName\)[\s\S]{0,80}persistFolderStateNow\(\)/,
    'Create Folder must flush persistence immediately after StateStore mutation');
  assert.match(renameBlock, /FolderLibrary\.renameFolder\(folderId, name\.input\.value\)[\s\S]{0,180}persistFolderStateNow\(\)/,
    'Rename Folder must flush persistence immediately after StateStore mutation');
  assert.match(deleteBlock, /FolderLibrary\.deleteFolder\(folderId\)[\s\S]{0,180}persistFolderStateNow\(\)/,
    'Delete Folder must flush persistence immediately after StateStore mutation');
  assert.match(moveBlock, /FolderLibrary\.movePackToFolder\(pack\.id, folderIdOrNull\)[\s\S]{0,180}persistFolderStateNow\(\)/,
    'Move Pack to Folder must flush persistence immediately after StateStore mutation');
});

test('phase 0.7C-4B compact move modal replaces inline folder menu section', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const modalStart = src.indexOf('function openMoveToFolderModal(pack)');
  const modalEnd = src.indexOf('\n    function openFoldersDropdown()', modalStart + 1);
  const modalBlock = modalStart >= 0 && modalEnd > modalStart ? src.slice(modalStart, modalEnd) : '';

  assert.ok(modalBlock.length > 0,
    'openMoveToFolderModal(pack) must exist');
  assert.match(modalBlock, /UIComponents\.showModal\(/,
    'Move to Folder choices must be shown in a modal');
  assert.match(modalBlock, /addMoveRow\(['"]Unfiled['"], ['"]fa-solid fa-folder-open['"], null/,
    'Move modal must include Unfiled target');
  assert.match(modalBlock, /folders\.forEach\(folder =>/,
    'Move modal must list real folders inside the modal');
  assert.match(modalBlock, /empty\.textContent = ['"]No folders yet['"]/,
    'Move modal must show disabled empty state when no folders exist');
  assert.doesNotMatch(src, /function buildMoveFolderItems\(pack\)|\.\.\.buildMoveFolderItems\(pack\)/,
    'main pack menus must no longer inline every folder through buildMoveFolderItems');
});

test('phase 0.7C-4B both pack menus contain one compact Move to Folder action', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const listStart = src.indexOf('function renderListView(packs)');
  const listEnd = src.indexOf('\n    function renderGridView(packs)', listStart + 1);
  const listBlock = listStart >= 0 && listEnd > listStart ? src.slice(listStart, listEnd) : '';
  const gridStart = src.indexOf('function renderGridView(packs)');
  const gridEnd = src.indexOf('\n    function buildPreview(', gridStart + 1);
  const gridBlock = gridStart >= 0 && gridEnd > gridStart ? src.slice(gridStart, gridEnd) : '';

  assert.equal((listBlock.match(/label:\s*['"]Move to Folder['"]/g) || []).length, 1,
    'list menu must contain exactly one Move to Folder action');
  assert.equal((gridBlock.match(/label:\s*['"]Move to Folder['"]/g) || []).length, 1,
    'grid menu must contain exactly one Move to Folder action');
  assert.match(listBlock, /label:\s*['"]Move to Folder['"][\s\S]{0,160}icon:\s*['"]fa-solid fa-folder-open['"][\s\S]{0,160}openMoveToFolderModal\(pack\)/,
    'list Move to Folder action must open the modal helper');
  assert.match(gridBlock, /label:\s*['"]Move to Folder['"][\s\S]{0,160}icon:\s*['"]fa-solid fa-folder-open['"][\s\S]{0,160}openMoveToFolderModal\(pack\)/,
    'grid Move to Folder action must open the modal helper');
  assert.doesNotMatch(listBlock + gridBlock, /type:\s*['"]header['"], label:\s*['"]Move to folder['"]|rightIcon:\s*active \? ['"]fa-solid fa-check['"]/,
    'main pack menus must not contain inline folder choices');
});

test('phase 0.7C-4B folder CRUD and move APIs remain wired from Packs screen only', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const { stdout } = await execFileAsync('git', ['grep', '-n', 'FolderLibrary.movePackToFolder(', '--', 'src']);
  const callers = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  assert.ok(callers.length >= 1,
    'FolderLibrary.movePackToFolder must be called from source');
  assert.ok(callers.every(line => line.startsWith('src/screens/packs-screen.js:')),
    'FolderLibrary.movePackToFolder must only be called by the Packs screen UI');
  assert.match(src, /FolderLibrary\.createFolder\(folderName\)/,
    'Create Folder must remain wired');
  assert.match(src, /FolderLibrary\.renameFolder\(folderId, name\.input\.value\)/,
    'Rename Folder must remain wired');
  assert.match(src, /FolderLibrary\.deleteFolder\(folderId\)/,
    'Delete Folder must remain wired');
});

test('phase 0.7C-4B rename delete stay guarded to active real folders only', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openFoldersDropdown()');
  const end = src.indexOf('\n    function initListHeaderSort()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';
  const actionsStart = block.indexOf('if (model.activeFolder && activeFolderId)');
  const actionsEnd = block.indexOf("label: 'New Folder'", actionsStart + 1);
  const actionsBlock = actionsStart >= 0 && actionsEnd > actionsStart ? block.slice(actionsStart, actionsEnd) : '';

  assert.match(actionsBlock, /if \(model\.activeFolder && activeFolderId\)/,
    'folder management actions must require a resolved active real folder');
  assert.match(actionsBlock, /openRenameFolderModal\(model\.activeFolder\)/,
    'Rename Folder action must target the active real folder');
  assert.match(actionsBlock, /deleteFolderWithConfirm\(model\.activeFolder\)/,
    'Delete Folder action must target the active real folder');
});

// ── Folder Foundation Stage 1 ───────────────────────────────────────────────────────────────
const uiComponentsPath = new URL('../../src/ui/ui-components.js', import.meta.url);

function functionBlock(src, header, nextHeader) {
  const start = src.indexOf(header);
  const end = src.indexOf(nextHeader, start + header.length);
  return start >= 0 && end > start ? src.slice(start, end) : '';
}

test('Stage 1 F-01 the delete confirmation shows the Folder name through textContent, not an HTML string', async () => {
  const packsSrc = await fs.readFile(packsScreenPath, 'utf8');
  const uiSrc = await fs.readFile(uiComponentsPath, 'utf8');
  const block = functionBlock(packsSrc, 'async function deleteFolderWithConfirm(folder)', '\n    function movePackToFolder(');

  assert.ok(block.length > 0, 'the delete confirmation must stay discoverable');
  assert.match(block, /const message = document\.createElement\('div'\);\s*message\.textContent =/,
    'the message must be an element filled through textContent');
  assert.match(block, /UIComponents\.confirm\(\{[\s\S]*?\n\s+message,\n/,
    'confirm must receive the element, not a template string');
  assert.doesNotMatch(block, /message:\s*`/,
    'a Folder name must never be interpolated into a string message (the modal treats strings as HTML)');
  assert.match(uiSrc, /SECURITY: Treat string content as trusted HTML only/,
    'the shared modal string contract stays unchanged for its trusted-markup callers');
});

test('Stage 1 F-02 every Folder dialog binds to its scope and re-checks it before it writes', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const cases = [
    ['create', 'function openCreateFolderModal()', 'FolderLibrary.createFolder('],
    ['rename', 'function openRenameFolderModal(folder)', 'FolderLibrary.renameFolder('],
    ['delete', 'async function deleteFolderWithConfirm(folder)', 'FolderLibrary.deleteFolder('],
    ['move', 'function openMoveToFolderModal(pack)', 'movePackToFolder(pack, folderIdOrNull)'],
  ];
  cases.forEach(([name, header, write]) => {
    const start = src.indexOf(header);
    const body = src.slice(start, src.indexOf('\n    function ', start + header.length) > 0
      ? src.indexOf('\n    function ', start + header.length) : undefined);
    assert.ok(start >= 0, `${name} dialog must exist`);
    assert.match(body, /beginFolderDialog\(\)/, `${name} dialog must capture its scope when it opens`);
    const guardAt = body.search(/folderDialogIsCurrent\(guard\)/);
    const writeAt = body.indexOf(write);
    assert.ok(guardAt >= 0 && writeAt >= 0 && guardAt < writeAt,
      `${name} dialog must re-validate its scope before it writes`);
  });
  assert.match(src, /isCurrent: \(\) => isScopeContextCurrent\(scope\) && epoch === folderStateEpoch/,
    'the guard uses the storage scope generation, so A to B to A is a different identity');
  assert.match(src, /if \(changes && changes\._replace\) folderStateEpoch \+= 1;\s*dismissFolderDialogs\(\);/,
    'a whole-state replacement invalidates and dismisses open dialogs');
  assert.match(src, /function resetWorkspaceState\(\) \{\s*dismissFolderDialogs\(\{ all: true \}\);/,
    'a workspace reset dismisses every open Folder dialog');
});
