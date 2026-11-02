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
  const start = src.indexOf('export function saveNow(');
  const end = src.indexOf('\nexport function clearAll', start + 1);
  const fn = start >= 0 && end > start ? src.slice(start, end) : '';
  const userPayloadStart = fn.indexOf('const userPayload = {');
  const workspacePayloadStart = fn.indexOf('const workspacePayload = {');
  const userPayload = userPayloadStart >= 0 && workspacePayloadStart > userPayloadStart
    ? fn.slice(userPayloadStart, workspacePayloadStart)
    : '';

  assert.ok(loadFn, 'load must be extractable');
  assert.match(loadFn, /loadedFolderLibrary =[\s\S]{0,140}effectiveWorkspacePayload\.folderLibrary/,
    'load must take folderLibrary from the effective workspace payload');
  assert.match(loadFn, /folderLibrary: loadedFolderLibrary,/,
    'load must return that same folderLibrary, loaded as stored');
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
  const filterStart = src.indexOf('if (activeFolderId === null && activeSpecialFilter === null) return true;');
  const filterEnd = src.indexOf('if (activeSpecialFilter === FILTER_UNFILED)', filterStart);
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
  // Stage 1 F-05: Unfiled is a filter kind that lives beside activeFolderId, never a Folder id value, so a real
  // Folder (a Workspace Backup may carry any id) can never collide with it.
  assert.match(src, /const FILTER_UNFILED = ['"]unfiled['"]/,
    'folder filter must support a distinct Unfiled filter kind');
  assert.match(src, /let activeSpecialFilter = null/,
    'special filters must live in their own state, not inside activeFolderId');
  assert.doesNotMatch(src, /__unfiled__|UNFILED_FOLDER_ID/,
    'no Folder id value may stand for the Unfiled filter');
  assert.match(src, /newDatasetKey = `\$\{q\}::\$\{sortKey\}::\$\{activeSpecialFilter \? `special:\$\{activeSpecialFilter\}` : activeFolderId \? `folder:\$\{activeFolderId\}` : 'all'\}::/,
    'activeFolderId must be included in dataset key');
  assert.match(resetBlock, /activeFolderId = null/,
    'workspace reset must clear the active folder filter');
  assert.match(resetBlock, /activeSpecialFilter = null/,
    'workspace reset must clear the special filter');
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

  assert.match(block, /active:\s*activeFolderId === null && activeSpecialFilter === null/,
    'All Packs row must be active when neither a Folder nor a special filter is selected');
  assert.match(block, /rightIcon:\s*activeFolderId === null && activeSpecialFilter === null \? ['"]fa-solid fa-check['"]/,
    'All Packs row must show active check icon when selected');
  assert.match(block, /active:\s*activeSpecialFilter === FILTER_UNFILED/,
    'Unfiled row must be active when the Unfiled filter kind is selected');
  assert.match(block, /rightIcon:\s*activeSpecialFilter === FILTER_UNFILED \? ['"]fa-solid fa-check['"]/,
    'Unfiled row must show active check icon when selected');
  assert.match(block, /active:\s*activeFolderId === folderId/,
    'Folder rows must be active by exact folder id match');
  assert.match(block, /rightIcon:\s*activeFolderId === folderId \? ['"]fa-solid fa-check['"]/,
    'Folder rows must show active check icon by exact folder id match');
});

test('phase 0.7C-1B folder filtering still uses folderId state and reset behavior', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const filterStart = src.indexOf('if (activeFolderId === null && activeSpecialFilter === null) return true;');
  const filterEnd = src.indexOf('if (activeSpecialFilter === FILTER_UNFILED)', filterStart);
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
  assert.match(src, /newDatasetKey = `\$\{q\}::\$\{sortKey\}::\$\{activeSpecialFilter \? `special:\$\{activeSpecialFilter\}` : activeFolderId \? `folder:\$\{activeFolderId\}` : 'all'\}::/,
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
  // Stage 1 name policy: the shared text field with an inline error replaces the bare field, and the service
  // validates (trim, 1-100 code points, no case-insensitive duplicate, 2,000 Folder cap) before it writes.
  assert.match(block, /identityField\(['"]Folder name['"], ['"]e\.g\. Client A['"]/,
    'Create Folder modal must use the shared text field that can show a validation message');
  assert.match(block, /FolderLibrary\.createFolderResult\(name\.input\.value\)/,
    'Create Folder modal must call FolderLibrary.createFolderResult() with the typed name');
  assert.match(block, /if \(!result\.ok\) \{[\s\S]{0,160}setIdentityFieldError\(name, result\.message\);[\s\S]{0,80}return false;/,
    'a refused name shows its message and keeps the dialog open');
});

test('phase 0.7C-2 create folder selects created folder and refreshes packs', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const start = src.indexOf('function openCreateFolderModal()');
  const end = src.indexOf('\n    function openFoldersDropdown()', start + 1);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';

  assert.match(block, /if \(!result\.ok\)/,
    'Create Folder must only select a Folder that was actually created');
  assert.match(block, /activeFolderId = String\(result\.folder\.id\)/,
    'Create Folder must select the newly created folder');
  assert.match(block, /packsListState\.pageIndex = 0/,
    'Create Folder must reset pack pagination when selecting the new folder');
  assert.match(block, /\brender\(\)/,
    'Create Folder must re-render the Packs screen');
  // Stage 1 F-04: the success toast is announced through announceFolderSave, which shows it only after the
  // browser acknowledged the write (see the F-04 test below).
  assert.match(block, /announceFolderSave\(saved, ['"]Folder created['"]/,
    'Create Folder must announce its outcome after the save result is known');
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
  const filterStart = src.indexOf('if (activeFolderId === null && activeSpecialFilter === null) return true;');
  const filterEnd = src.indexOf('if (activeSpecialFilter === FILTER_UNFILED)', filterStart);
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
  assert.match(src, /newDatasetKey = `\$\{q\}::\$\{sortKey\}::\$\{activeSpecialFilter \? `special:\$\{activeSpecialFilter\}` : activeFolderId \? `folder:\$\{activeFolderId\}` : 'all'\}::/,
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
  assert.match(block, /FolderLibrary\.movePackToFolderResult\(pack\.id, folderIdOrNull\)/,
    'move helper must call FolderLibrary.movePackToFolderResult with pack id and target folder id');
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

  assert.match(block, /if \(!result\.ok\)[\s\S]{0,120}UIComponents\.showToast\(['"]Could not move load plan to folder['"], ['"]warning['"]\)/,
    'failed move must show a warning toast and not throw');
  assert.match(block, /packsListState\.pageIndex = 0/,
    'successful move must reset pack pagination');
  assert.match(block, /\brender\(\)/,
    'successful move must re-render Packs screen');
  assert.match(block, /announceFolderSave\(saved, [\s\S]{0,120}Load plan moved to/,
    'successful move must announce its outcome after the save result is known');
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
  assert.match(block, /identityField\(['"]Folder name['"], ['"]e\.g\. Client A['"]/,
    'Rename Folder modal must use the shared text field that can show a validation message');
  assert.match(block, /name\.input\.value = folder\.name \|\| ['"]/,
    'Rename Folder modal must pre-fill the current folder name');
  assert.match(block, /FolderLibrary\.renameFolderResult\(folderId, name\.input\.value\)/,
    'Rename Folder must call FolderLibrary.renameFolderResult with folder id and input value');
  assert.match(block, /\brender\(\)/,
    'Rename Folder must refresh the Packs screen through render()');
  assert.match(block, /announceFolderSave\(saved, ['"]Folder renamed['"]/,
    'Rename Folder must announce its outcome after the save result is known');
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
  assert.match(block, /announceFolderSave\(saved, ['"]Folder deleted['"]/,
    'Deleting a folder must announce its outcome after the save result is known');
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

  assert.match(appSrc, /persistNow:\s*\(\) => \{[\s\S]{0,40}Storage\.cancelPendingSave\(\);[\s\S]{0,40}return Storage\.saveNow\(\{ report: false \}\);/,
    'app.js must pass an immediate workspace save callback that returns the save outcome into the Packs screen');
  assert.match(packsSrc, /function persistFolderStateNow\(\)[\s\S]{0,180}persistNow\(\)/,
    'Packs screen must expose a narrow immediate persistence helper');
  assert.match(createBlock, /FolderLibrary\.createFolderResult\(name\.input\.value\)[\s\S]{0,400}persistFolderStateNow\(\)/,
    'Create Folder must flush persistence immediately after StateStore mutation');
  assert.match(renameBlock, /FolderLibrary\.renameFolderResult\(folderId, name\.input\.value\)[\s\S]{0,700}persistFolderStateNow\(\)/,
    'Rename Folder must flush persistence immediately after StateStore mutation');
  assert.match(deleteBlock, /FolderLibrary\.deleteFolder\(folderId\)[\s\S]{0,180}persistFolderStateNow\(\)/,
    'Delete Folder must flush persistence immediately after StateStore mutation');
  assert.match(moveBlock, /FolderLibrary\.movePackToFolderResult\(pack\.id, folderIdOrNull\)[\s\S]{0,420}persistFolderStateNow\(\)/,
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
  const { stdout } = await execFileAsync('git', ['grep', '-n', 'FolderLibrary.movePackToFolderResult(', '--', 'src']);
  const callers = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  assert.ok(callers.length >= 1,
    'FolderLibrary.movePackToFolderResult must be called from source');
  assert.ok(callers.every(line => line.startsWith('src/screens/packs-screen.js:')),
    'FolderLibrary.movePackToFolderResult must only be called by the Packs screen UI');
  assert.match(src, /FolderLibrary\.createFolderResult\(name\.input\.value\)/,
    'Create Folder must remain wired');
  assert.match(src, /FolderLibrary\.renameFolderResult\(folderId, name\.input\.value\)/,
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
    ['create', 'function openCreateFolderModal()', 'FolderLibrary.createFolderResult('],
    ['rename', 'function openRenameFolderModal(folder)', 'FolderLibrary.renameFolderResult('],
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
  assert.match(src, /if \(changes && changes\._replace\) folderStateEpoch \+= 1;[\s\S]{0,600}dismissFolderDialogs\(\);/,
    'a whole-state replacement invalidates and dismisses open dialogs');
  assert.match(src, /function resetWorkspaceState\(\) \{\s*dismissFolderDialogs\(\{ all: true \}\);/,
    'a workspace reset dismisses every open Folder dialog');
});

function makeFlakyLocalStorage() {
  const values = new Map();
  const storage = {
    failWrites: false,
    get length() { return values.size; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (storage.failWrites) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    key(index) { return Array.from(values.keys())[index] || null; },
  };
  return storage;
}

test('Stage 1 F-04 saveNow reports whether the browser accepted the write and keeps unsaved state for a retry', async () => {
  const Storage = await import(`${storagePath.href}?f04=${Date.now()}-${Math.random()}`);
  const StateStore = await import(stateStorePath.href);
  const Events = await import(new URL('../../src/core/events.js', import.meta.url).href);
  const originalWindow = globalThis.window;
  const localStorage = makeFlakyLocalStorage();
  const saveErrors = [];
  const off = Events.on('storage:save_error', payload => saveErrors.push(payload));
  const workspaceKey = 'truckPacker3d:v1:user-f04:workspace:org-f04';

  try {
    globalThis.window = { localStorage };
    Storage.setStorageScope('user-f04');
    Storage.setWorkspaceScope('org-f04');
    StateStore.init({
      caseLibrary: [],
      packLibrary: [],
      folderLibrary: [{ id: 'f-1', name: 'Client A', scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
      preferences: {},
    });

    const accepted = Storage.saveNow({ report: false });
    assert.equal(accepted.ok, true, 'an accepted write reports ok');
    assert.equal(typeof accepted.savedAt, 'number');
    assert.equal(JSON.parse(localStorage.getItem(workspaceKey)).folderLibrary[0].id, 'f-1');

    // A failed write that the caller reports itself raises no second, generic message.
    localStorage.failWrites = true;
    StateStore.set({ folderLibrary: [...StateStore.get('folderLibrary'), { id: 'f-2', name: 'Client B', scope: 'pack', parentFolderId: null, sortOrder: 1, createdAt: 2, updatedAt: 2 }] });
    const refused = Storage.saveNow({ report: false });
    assert.equal(refused.ok, false, 'a refused write is not reported as saved');
    assert.equal(saveErrors.length, 0, 'the caller that passed report:false is the only one to speak');
    assert.equal(JSON.parse(localStorage.getItem(workspaceKey)).folderLibrary.length, 1,
      'the durable copy still holds the last accepted state');
    assert.equal(StateStore.get('folderLibrary').length, 2, 'the unsaved change stays in memory for the retry');

    // The default call keeps the global failure message for every unrelated save (autosave and others).
    const defaultFail = Storage.saveNow();
    assert.equal(defaultFail.ok, false);
    assert.equal(saveErrors.length, 1, 'autosave and other callers keep their existing failure message');

    // The retry writes the kept state and reports success.
    localStorage.failWrites = false;
    const retried = Storage.saveNow({ report: false });
    assert.equal(retried.ok, true, 'a later retry reports success');
    assert.deepEqual(JSON.parse(localStorage.getItem(workspaceKey)).folderLibrary.map(f => f.id), ['f-1', 'f-2']);
    assert.equal(saveErrors.length, 1, 'the successful retry raises no failure message');
  } finally {
    off();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('Stage 1 F-04 the Folder UI announces success only after an acknowledged save and fails closed otherwise', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const persist = functionBlock(src, 'function persistFolderStateNow()', '\n    // A Folder dialog');
  const announce = functionBlock(src, 'function announceFolderSave(', '\n    function getFolderFilterModel');

  assert.match(persist, /return result && result\.ok === true \? result : \{ ok: false \}/,
    'anything but an explicit acknowledgement counts as not saved');
  assert.match(persist, /typeof persistNow !== 'function'\) return \{ ok: false \}/,
    'a missing save callback cannot claim success');
  assert.match(persist, /catch \(error\) \{\s*return \{ ok: false, error \};/,
    'a throwing save is a failed save');
  const successAt = announce.indexOf("showToast(successMessage, 'success')");
  const guardAt = announce.indexOf('if (saved && saved.ok)');
  const failureAt = announce.indexOf("'error'");
  assert.ok(guardAt >= 0 && successAt > guardAt && failureAt > successAt,
    'the success toast sits only inside the acknowledged branch; the failure is one error toast');
  assert.match(announce, /label: 'Retry'[\s\S]*?folderDialogIsCurrent\(guard\)[\s\S]*?persistFolderStateNow\(\)/,
    'Retry is bound to the workspace it was raised in and saves again');
  ['Folder created', 'Folder renamed', 'Folder deleted'].forEach(label => {
    assert.doesNotMatch(src, new RegExp(`showToast\\('${label}', 'success'\\)`),
      `${label} is announced through announceFolderSave, never straight after the mutation`);
  });
});

function damagedFolderGraphFixture() {
  const folder = (id, name, extra = {}) => ({ id, name, scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...extra });
  return {
    folderLibrary: [
      folder('f-good', 'Good'),
      folder('f-dup', 'Dup first'),
      folder('f-dup', 'Dup second'),
      null,
      folder(' padded', 'Padded id'),
      folder('f-nested', 'Nested', { parentFolderId: 'f-good' }),
    ],
    packLibrary: [
      { id: 'p-ok', title: 'OK', folderId: 'f-good', lastEdited: 5 },
      { id: 'p-unfiled', title: 'Unfiled', folderId: null, lastEdited: 5 },
      { id: 'p-ghost', title: 'Ghost', folderId: 'f-gone', lastEdited: 5 },
      { id: 'p-dup', title: 'Dup', folderId: 'f-dup', lastEdited: 5 },
      { id: 'p-typed', title: 'Typed', folderId: 42, lastEdited: 5 },
      { id: 'p-nested', title: 'Nested', folderId: 'f-nested', lastEdited: 5 },
    ],
  };
}

test('Stage 1 F-03 inspectFolderGraph reports damage with the strict validator rules and changes nothing', async () => {
  const { inspectFolderGraph } = await import(`${normalizerPath.href}?f03=${Date.now()}-${Math.random()}`);
  const fixture = damagedFolderGraphFixture();
  const before = JSON.stringify(fixture);
  const graph = inspectFolderGraph(fixture.folderLibrary, fixture.packLibrary);

  assert.equal(JSON.stringify(fixture), before, 'inspection is read-only');
  assert.deepEqual(graph.folders.map(f => f.id), ['f-good', 'f-nested'],
    'only unique, valid ids are usable (a nested record stays usable and is reported)');
  assert.deepEqual(graph.issues.map(i => i.kind).sort(), ['duplicate-id', 'duplicate-id', 'invalid-id', 'nested', 'not-a-record'].sort());
  assert.deepEqual(graph.ambiguousIds, ['f-dup']);
  assert.deepEqual(
    graph.unresolved.map(u => [u.packId, u.reason]),
    [['p-ghost', 'missing'], ['p-dup', 'ambiguous'], ['p-typed', 'invalid']],
    'every Load Plan whose Folder cannot be used is listed with its reason'
  );
  assert.equal(graph.clean, false);
  assert.equal(inspectFolderGraph(
    [{ id: 'a', name: 'A', scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
    [{ id: 'p', folderId: 'a' }, { id: 'q', folderId: null }, { id: 'r' }, { id: 's', folderId: '' }]
  ).clean, true, 'a valid graph, including blank and missing folderId, is clean');
});

test('Stage 1 F-03 Folder operations refuse ambiguous targets, keep every record and keep valid Folders usable', async () => {
  const StateStore = await import(stateStorePath.href);
  const FolderLibrary = await import(`${folderLibraryPath.href}?f03=${Date.now()}-${Math.random()}`);
  const fixture = damagedFolderGraphFixture();
  StateStore.init({ caseLibrary: [], packLibrary: fixture.packLibrary, folderLibrary: fixture.folderLibrary, preferences: {} });
  const stored = () => JSON.stringify([StateStore.get('folderLibrary'), StateStore.get('packLibrary')]);
  const before = stored();

  assert.deepEqual(FolderLibrary.listFolders().map(f => f.id), ['f-good', 'f-nested'],
    'the Folder list shows usable Folders only');
  assert.equal(FolderLibrary.renameFolder('f-dup', 'Renamed'), null, 'an ambiguous Folder cannot be renamed');
  assert.equal(FolderLibrary.deleteFolder('f-dup'), false, 'an ambiguous Folder cannot be deleted');
  assert.equal(FolderLibrary.movePackToFolder('p-ok', 'f-dup'), null, 'a Load Plan cannot be moved into an ambiguous Folder');
  assert.equal(FolderLibrary.movePackToFolder('p-ok', 'f-gone'), null, 'nor into a Folder that does not exist');
  assert.equal(stored(), before, 'a refused operation changes nothing and writes no history');

  const renamed = FolderLibrary.renameFolder('f-good', 'Good renamed');
  assert.equal(renamed.name, 'Good renamed', 'a valid Folder stays fully usable beside the damaged ones');
  const moved = FolderLibrary.movePackToFolder('p-ghost', null);
  assert.equal(moved.folderId, null, 'an unresolved Load Plan can be moved to Unfiled explicitly');
  assert.equal(StateStore.get('folderLibrary').filter(f => f && f.id === 'f-dup').length, 2,
    'both records that share an id are still stored');
  assert.equal(StateStore.get('packLibrary').find(p => p.id === 'p-dup').folderId, 'f-dup',
    'a Load Plan that points at an ambiguous id keeps it until the explicit repair');
});

test('Stage 1 F-03 the explicit repair keeps Load Plans and cargo, uses the restore rules and is one history step', async () => {
  const StateStore = await import(stateStorePath.href);
  const originalWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto };
  try {
    const FolderLibrary = await import(`${folderLibraryPath.href}?f03r=${Date.now()}-${Math.random()}`);
    const fixture = damagedFolderGraphFixture();
    fixture.packLibrary[0].cases = [{ id: 'i1', caseId: 'c1' }];
    StateStore.init({ caseLibrary: [], packLibrary: fixture.packLibrary, folderLibrary: fixture.folderLibrary, preferences: {} });
    const depth = StateStore.undoDepth();

    const repaired = FolderLibrary.repairFolderGraph();
    assert.ok(repaired, 'a damaged graph is repaired');
    assert.equal(StateStore.undoDepth() - depth, 1, 'one history step');
    const graph = FolderLibrary.getFolderGraph();
    assert.equal(graph.clean, true, 'the repaired graph passes the same inspection');
    const packs = StateStore.get('packLibrary');
    assert.equal(packs.length, fixture.packLibrary.length, 'no Load Plan is removed');
    assert.deepEqual(packs.find(p => p.id === 'p-ok').cases, [{ id: 'i1', caseId: 'c1' }], 'cargo is untouched');
    assert.ok(packs.every(p => p.lastEdited === 5), 'a repair is not an edit: lastEdited is unchanged');
    assert.equal(packs.find(p => p.id === 'p-ghost').folderId, null, 'a Load Plan that pointed nowhere is Unfiled');
    assert.equal(packs.find(p => p.id === 'p-ok').folderId, 'f-good', 'a valid assignment is untouched');
    assert.equal(packs.find(p => p.id === 'p-dup').folderId, 'f-dup', 'the first holder of a repeated id keeps its Load Plans');
    const names = StateStore.get('folderLibrary').map(f => f.name);
    assert.ok(names.includes('Dup first') && names.includes('Dup second'), 'both records that shared an id survive');
    assert.equal(new Set(StateStore.get('folderLibrary').map(f => f.id)).size, StateStore.get('folderLibrary').length,
      'every Folder id is unique afterwards');
    assert.equal(FolderLibrary.repairFolderGraph(), null, 'a clean graph needs no repair');

    StateStore.undo();
    assert.equal(FolderLibrary.getFolderGraph().clean, false, 'Undo returns the original graph');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('Stage 1 F-03 load keeps a damaged Folder graph as stored and preserves the original once', async () => {
  const Storage = await import(`${storagePath.href}?f03=${Date.now()}-${Math.random()}`);
  const originalWindow = globalThis.window;
  const localStorage = makeFlakyLocalStorage();
  const fixture = damagedFolderGraphFixture();
  const workspaceKey = 'truckPacker3d:v1:user-f03:workspace:org-f03';
  const evidenceKey = `${workspaceKey}:folder-graph-evidence`;
  const writeErrors = [];
  const Events = await import(new URL('../../src/core/events.js', import.meta.url).href);
  const off = Events.on('storage:write_error', payload => writeErrors.push(payload));
  const payload = extra => JSON.stringify({
    version: 'test', savedAt: 1, caseLibrary: [], packLibrary: fixture.packLibrary, folderLibrary: fixture.folderLibrary,
    currentPackId: null, ...extra,
  });

  try {
    globalThis.window = { localStorage };
    Storage.setStorageScope('user-f03');
    Storage.setWorkspaceScope('org-f03');
    localStorage.setItem('truckPacker3d:v1:user-f03', JSON.stringify({ version: 'test', savedAt: 1, preferences: {} }));
    localStorage.setItem(workspaceKey, payload());

    const loaded = Storage.load();
    assert.deepEqual(loaded.folderLibrary, fixture.folderLibrary, 'the damaged Folder records load exactly as stored');
    assert.deepEqual(loaded.packLibrary.map(p => p.folderId), fixture.packLibrary.map(p => p.folderId),
      'every Load Plan keeps its stored folderId');
    const evidence = JSON.parse(localStorage.getItem(evidenceKey));
    assert.deepEqual(evidence.folderLibrary, fixture.folderLibrary, 'the original Folder records are kept');
    assert.deepEqual(evidence.packFolderRefs.map(r => r.id), ['p-ok', 'p-ghost', 'p-dup', 'p-typed', 'p-nested'],
      'the original assignments are kept');
    const firstRaw = localStorage.getItem(evidenceKey);

    localStorage.setItem(workspaceKey, payload({ folderLibrary: [] }));
    Storage.load();
    assert.equal(localStorage.getItem(evidenceKey), firstRaw, 'the first copy is never overwritten');

    const cleanKey = 'truckPacker3d:v1:user-f03:workspace:org-clean';
    Storage.setWorkspaceScope('org-clean');
    localStorage.setItem(cleanKey, payload({ folderLibrary: [], packLibrary: [] }));
    Storage.load();
    assert.equal(localStorage.getItem(`${cleanKey}:folder-graph-evidence`), null, 'a clean workspace writes no evidence');

    // A refused evidence write is reported, never swallowed, and does not stop the load.
    Storage.setWorkspaceScope('org-full');
    localStorage.setItem('truckPacker3d:v1:user-f03:workspace:org-full', payload());
    localStorage.failWrites = true;
    const stillLoaded = Storage.load();
    assert.equal(stillLoaded.folderLibrary.length, fixture.folderLibrary.length, 'the load still succeeds');
    assert.equal(writeErrors.filter(e => /damaged Folder data/.test(e.message)).length, 1,
      'the missing evidence copy is reported');
  } finally {
    off();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('Stage 1 F-03 F-05 strict Workspace Backup parsing is unchanged: a real Folder id looks fine, a damaged graph is refused', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto };
  try {
    const ImportExport = await import(`${importExportPath.href}?f03=${Date.now()}-${Math.random()}`);
    const folder = (id) => ({ id, name: `F ${id}`, scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 });
    const pack = (id, folderId) => ({ id, title: id, folderId, cases: [], truck: { length: 100, width: 80, height: 80, shapeMode: 'rect' }, createdAt: 1, lastEdited: 1 });
    const make = (folders, packs) => JSON.stringify({ exportType: 'workspace', data: { caseLibrary: [], packLibrary: packs, folderLibrary: folders } });

    const parsed = ImportExport.parseWorkspaceImportJSON(make([folder('__unfiled__')], [pack('p1', '__unfiled__')]));
    assert.deepEqual(parsed.folderLibrary.map(f => f.id), ['__unfiled__'], 'a Folder id that looks like the Unfiled token imports as a real Folder');
    assert.deepEqual(parsed.packLibrary.map(p => p.folderId), ['__unfiled__'], 'its assignment survives');
    assert.throws(() => ImportExport.parseWorkspaceImportJSON(make([folder('a'), folder('a')], [pack('p1', 'a')])),
      /duplicate id/, 'a repeated Folder id is still refused on import');
    assert.throws(() => ImportExport.parseWorkspaceImportJSON(make([folder('a')], [pack('p1', 'gone')])),
      /referenced folder does not exist/, 'a dangling folderId is still refused on import');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

async function freshFolderService(state) {
  const StateStore = await import(stateStorePath.href);
  const FolderLibrary = await import(`${folderLibraryPath.href}?c=${Date.now()}-${Math.random()}`);
  StateStore.init({ caseLibrary: [], packLibrary: [], folderLibrary: [], preferences: {}, ...state });
  return { StateStore, FolderLibrary };
}

const folderRecord = (id, name, extra = {}) => ({
  id, name, scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...extra,
});

test('Stage 1 name policy: one rule set for creation and rename, enforced by the service', async () => {
  const { StateStore, FolderLibrary } = await freshFolderService({
    folderLibrary: [folderRecord('f1', 'Client A'), folderRecord('f2', 'Café')],
  });
  const refused = (name, reason, excludeFolderId) => {
    const result = FolderLibrary.validateFolderName(name, { excludeFolderId });
    assert.equal(result.ok, false, `${JSON.stringify(name)} is refused`);
    assert.equal(result.reason, reason);
    assert.ok(result.message.length > 0, 'a refusal always carries a message');
  };

  assert.equal(FolderLibrary.validateFolderName('  Client B  ').name, 'Client B', 'names are trimmed');
  refused('', 'empty');
  refused('   \t ', 'empty');
  refused(null, 'empty');
  assert.equal(FolderLibrary.validateFolderName('\u{1F600}'.repeat(100)).ok, true, '100 code points is allowed');
  refused('\u{1F600}'.repeat(101), 'too-long');
  refused('x'.repeat(101), 'too-long');
  refused('client a', 'duplicate');
  refused('  CLIENT A ', 'duplicate');
  refused('Café', 'duplicate'); // precomposed and decomposed spellings are the same name
  assert.equal(FolderLibrary.validateFolderName('client a', { excludeFolderId: 'f1' }).ok, true,
    'a Folder may change only the case of its own name');
  ['<img src=x onerror=alert(1)>', 'Q4 / "East" & West', '客户 — Ångström', '#1: 50% off!'].forEach(name => {
    assert.equal(FolderLibrary.validateFolderName(name).name, name, `${name} is allowed and stored as typed`);
  });

  const before = JSON.stringify(StateStore.get('folderLibrary'));
  const depth = StateStore.undoDepth();
  assert.equal(FolderLibrary.createFolder('client a'), null, 'creation applies the same rules');
  assert.equal(FolderLibrary.renameFolderResult('f2', 'Client A').ok, false, 'rename applies the same rules');
  assert.equal(JSON.stringify(StateStore.get('folderLibrary')), before, 'a refused name changes nothing');
  assert.equal(StateStore.undoDepth(), depth, 'and writes no history');
  const html = FolderLibrary.createFolder('<b>x</b>');
  assert.equal(html.name, '<b>x</b>', 'markup-looking text is data, kept exactly');
});

test('Stage 1 name policy: historical records that break the policy are never rewritten', async () => {
  const longName = 'L'.repeat(150);
  const { StateStore, FolderLibrary } = await freshFolderService({
    folderLibrary: [folderRecord('f-long', longName), folderRecord('f-a', 'Same'), folderRecord('f-b', 'same')],
  });
  const depth = StateStore.undoDepth();
  const unchanged = FolderLibrary.renameFolderResult('f-long', longName);
  assert.deepEqual([unchanged.ok, unchanged.changed], [true, false], 'saving a historical name as it is is not an error and not a change');
  assert.equal(FolderLibrary.renameFolderResult('f-a', 'Same').changed, false);
  assert.equal(StateStore.undoDepth(), depth);
  assert.deepEqual(StateStore.get('folderLibrary').map(f => f.name), [longName, 'Same', 'same'],
    'long and case-duplicate historical names are kept exactly');
  assert.equal(FolderLibrary.renameFolderResult('f-long', 'x'.repeat(101)).reason, 'too-long',
    'a new name for a historical record must follow the policy');
});

test('Stage 1 F-06 a rename or move that changes nothing writes nothing', async () => {
  const { StateStore, FolderLibrary } = await freshFolderService({
    folderLibrary: [folderRecord('f1', 'Client A', { updatedAt: 111 }), folderRecord('f2', 'Other')],
    packLibrary: [
      { id: 'p-in', title: 'In', folderId: 'f1', lastEdited: 500, thumbnail: 'data:keep', cases: [{ id: 'i1' }] },
      { id: 'p-free', title: 'Free', folderId: null, lastEdited: 600 },
      { id: 'p-none', title: 'None', lastEdited: 650 },
      { id: 'p-stale', title: 'Stale', folderId: 'f-gone', lastEdited: 700 },
    ],
  });
  const snapshot = () => JSON.stringify([StateStore.get('folderLibrary'), StateStore.get('packLibrary')]);
  const before = snapshot();
  const depth = StateStore.undoDepth();

  const sameRename = FolderLibrary.renameFolderResult('f1', '  Client A ');
  assert.deepEqual([sameRename.ok, sameRename.changed], [true, false], 'the same name after trimming is not a change');
  assert.equal(sameRename.folder.updatedAt, 111, 'updatedAt is untouched');
  const sameMove = FolderLibrary.movePackToFolderResult('p-in', 'f1');
  assert.deepEqual([sameMove.ok, sameMove.changed], [true, false], 'moving to the current Folder is not a change');
  assert.equal(FolderLibrary.movePackToFolderResult('p-free', null).changed, false, 'null to null is not a change');
  assert.equal(FolderLibrary.movePackToFolderResult('p-none', '').changed, false, 'a missing folderId is already Unfiled');
  assert.equal(snapshot(), before, 'nothing was written: no lastEdited, no preview field, no cargo change');
  assert.equal(StateStore.undoDepth(), depth, 'no history step, so Redo is not invalidated');
  StateStore.undo();
  StateStore.redo(); // would be impossible if a no-op had pushed a step over the redo tail

  const caseOnly = FolderLibrary.renameFolderResult('f1', 'client a');
  assert.deepEqual([caseOnly.ok, caseOnly.changed], [true, true], 'a case-only rename is a real change');
  assert.equal(StateStore.undoDepth() - depth, 1);

  const realMove = FolderLibrary.movePackToFolderResult('p-in', 'f2');
  assert.equal(realMove.changed, true);
  assert.ok(realMove.pack.lastEdited > 500, 'a real move keeps the existing lastEdited behaviour');
  assert.equal(realMove.pack.thumbnail, 'data:keep', 'a move does not touch the preview');
  assert.deepEqual(realMove.pack.cases, [{ id: 'i1' }], 'a move does not touch cargo');
  const staleToUnfiled = FolderLibrary.movePackToFolderResult('p-stale', null);
  assert.equal(staleToUnfiled.changed, true, 'a stale reference is not "already Unfiled": moving it is a real repair');
});

test('Stage 1 Folder cap and ids: the 2,000 limit matches Workspace Backup and ids stay unique', async () => {
  const { WORKSPACE_BACKUP_LIMITS } = await import(`${importExportPath.href}?cap=${Date.now()}`);
  const { StateStore, FolderLibrary } = await freshFolderService({
    folderLibrary: Array.from({ length: 1999 }, (_, i) => folderRecord(`f-${i}`, `Folder ${i}`)),
  });
  assert.equal(FolderLibrary.MAX_FOLDERS, WORKSPACE_BACKUP_LIMITS.maxFolders, 'one limit, so a backup of a full workspace still works');
  const last = FolderLibrary.createFolderResult('Folder 1999');
  assert.equal(last.ok, true, 'the 2,000th Folder is allowed');
  const over = FolderLibrary.createFolderResult('One too many');
  assert.deepEqual([over.ok, over.reason], [false, 'limit']);
  assert.match(over.message, /2,000 Folders/);
  assert.equal(StateStore.get('folderLibrary').length, 2000, 'the refused Folder was not added');

  const fresh = await freshFolderService({ folderLibrary: [folderRecord('__unfiled__', 'Looks like a token'), folderRecord(' x', 'Damaged id')] });
  const ids = Array.from({ length: 40 }, (_, i) => fresh.FolderLibrary.createFolder(`New ${i}`).id);
  assert.equal(new Set(ids).size, 40, 'minted ids are unique');
  assert.ok(ids.every(id => id === id.trim() && id.length > 0 && id !== '__unfiled__'), 'and valid');
  const src = await fs.readFile(folderLibraryPath, 'utf8');
  assert.match(src, /function mintFolderId\(folders\)[\s\S]*?!taken\.has\(id\)[\s\S]*?return null;/,
    'minting retries against every stored id and fails closed instead of reusing one');
});

test('Stage 1 F-08 Editor Undo and Redo are unchanged; Load Plans reaches only the Packs screen Folder steps', async () => {
  const keyboardSrc = await fs.readFile(new URL('../../src/ui/keyboard-manager.js', import.meta.url), 'utf8');
  const appSrc = await readAppSource();
  const packsSrc = await fs.readFile(packsScreenPath, 'utf8');
  const undoFn = functionBlock(keyboardSrc, 'function undo()', '\n    function redo()');
  const redoFn = functionBlock(keyboardSrc, 'function redo()', '\n    // Escape clears');

  assert.match(undoFn, /if \(!inEditor\(\)\) return Boolean\(folderHistory && folderHistory\.undo\(\)\);\s*if \(mutationBlockedWhileBusy\(\)\) return true;\s*const ok = StateStore\.undo\(\);/,
    'in the Editor Undo is exactly what it was; elsewhere only the Folder provider may act');
  assert.match(redoFn, /if \(!inEditor\(\)\) return Boolean\(folderHistory && folderHistory\.redo\(\)\);\s*if \(mutationBlockedWhileBusy\(\)\) return true;\s*const ok = StateStore\.redo\(\);/,
    'the same holds for Redo');
  assert.match(keyboardSrc, /if \(event\.defaultPrevented \|\| UIComponents\.modalOwnership\?\.blocksKeyboardEvent\(event\)\) return;\s*if \(isTypingContext\(event\)\) return;/,
    'dialogs and text fields still own the key before any shortcut runs');
  assert.match(appSrc, /folderHistory: \{\s*undo: \(\) => Boolean\(PacksUI && PacksUI\.undoFolderStep\(\)\),\s*redo: \(\) => Boolean\(PacksUI && PacksUI\.redoFolderStep\(\)\),/,
    'app.js hands the keyboard manager the Packs screen provider and nothing else');
  const step = functionBlock(packsSrc, 'function stepFolderHistory(direction)', '\n    // The stored Folder graph');
  assert.match(step, /isScopeContextCurrent\(run\.scope\)/, 'the run is bound to the user and workspace it was made in');
  assert.match(step, /StateStore\.get\('currentScreen'\) !== 'packs'\) return false/, 'only on the Load Plans screen');
  assert.match(step, /StateStore\.undo\(\)[\s\S]*StateStore\.redo\(\)/, 'it uses the shared history, not a second stack');
  assert.doesNotMatch(packsSrc, /const folderHistory(Stack|Entries)|undoStack|redoStack/, 'no second history stack exists');
});
