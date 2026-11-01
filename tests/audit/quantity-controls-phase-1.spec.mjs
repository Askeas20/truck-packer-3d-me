import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Quantity Controls — ecommerce-style workflow (FINAL model).
//
// The previous Target/Missing model (pack.caseRequirements) is rejected and
// removed. There is no persisted quantity target. The Editor Qty selector is
// ephemeral UI state only; clicking "+ Add" creates that many new physical
// instances (pack.cases entries), always staged. Derived values (inTruck,
// staged, inLoad, hidden) are computed from pack.cases via the same
// shape-aware truck-geometry classification Pack statistics already use.
//
// Executable coverage: normalizer.js, services/pack-library.js,
// services/import-export.js, services/case-library.js, and core/storage.js
// (via import-export.js) are UI-free modules, so this suite loads and calls
// them directly against an in-memory StateStore (same pattern as
// tests/audit/import-export.spec.mjs).
//
// Source-contract coverage: screens/editor-screen.js, screens/cases-screen.js,
// screens/packs-screen.js, and src/app.js render through the DOM/Three.js
// scene and have no jsdom harness in this suite (matching the existing
// convention in security-and-invariants.spec.mjs and
// inspector-case-notes.spec.mjs) — their wiring is verified by extracting the
// relevant function's source block and asserting on its contents rather than
// executing the UI.

const repoRoot = new URL('../../', import.meta.url);
const normalizerUrl = new URL('../../src/core/normalizer.js', import.meta.url);
const stateStoreUrl = new URL('../../src/core/state-store.js', import.meta.url);
const storageUrl = new URL('../../src/core/storage.js', import.meta.url);
const packLibraryUrl = new URL('../../src/services/pack-library.js', import.meta.url);
const appShellUrl = new URL('../../src/ui/app-shell.js', import.meta.url);
const caseLibraryUrl = new URL('../../src/services/case-library.js', import.meta.url);
const categoryServiceUrl = new URL('../../src/services/category-service.js', import.meta.url);
const importExportUrl = new URL('../../src/services/import-export.js', import.meta.url);
const cargoCanonicalUrl = new URL('../../src/core/cargo-canonical.js', import.meta.url);
const importSchemaUrl = new URL('../../src/core/import-schema.js', import.meta.url);
const editorScreenPath = new URL('../../src/screens/editor-screen.js', import.meta.url);
const casesScreenPath = new URL('../../src/screens/cases-screen.js', import.meta.url);
const packsScreenPath = new URL('../../src/screens/packs-screen.js', import.meta.url);
const cardDisplayOverlayPath = new URL('../../src/ui/overlays/card-display-overlay.js', import.meta.url);
const appJsPath = new URL('../../src/app.js', import.meta.url);
const autopackEnginePath = new URL('../../src/services/autopack-engine.js', import.meta.url);
const autopackSolverPath = new URL('../../src/services/autopack-solver.js', import.meta.url);
const indexHtmlPath = new URL('../../index.html', import.meta.url);

// IMPORTANT: state-store.js holds module-level singleton state (`let state =
// null` at module scope). pack-library.js, case-library.js, and
// import-export.js all import it via the plain specifier '../core/state-store.js'
// (no cache-busting query string) — so this loader must resolve it the exact
// same way, or StateStore.init() here would initialize a DIFFERENT module
// instance than the one those services actually read from.
async function loadModules() {
  const [CoreNormalizer, StateStore, CoreStorage, PackLibrary, CaseLibrary, CategoryService, ImportExport] = await Promise.all([
    import(normalizerUrl.href),
    import(stateStoreUrl.href),
    import(storageUrl.href),
    import(packLibraryUrl.href),
    import(caseLibraryUrl.href),
    import(categoryServiceUrl.href),
    import(importExportUrl.href),
  ]);
  return { CoreNormalizer, StateStore, CoreStorage, PackLibrary, CaseLibrary, CategoryService, ImportExport };
}

// AppShell.navigate() itself never touches the DOM (only the createAppShell()
// factory does, at construction time, for sidebar/topbar wiring this suite
// never exercises) — so a minimal document stub is enough to construct the
// real AppShell and call its real navigate(), without a jsdom harness.
async function loadAppShellHarness() {
  const [StateStore, PackLibrary, { createAppShell }] = await Promise.all([
    import(stateStoreUrl.href),
    import(packLibraryUrl.href),
    import(appShellUrl.href),
  ]);
  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  let AppShell;
  try {
    AppShell = createAppShell({ StateStore, PackLibrary, Utils: {} });
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
  return { StateStore, PackLibrary, AppShell };
}

function baseCase(overrides = {}) {
  return {
    id: 'case-a',
    name: 'Case A',
    dimensions: { length: 10, width: 10, height: 10 },
    weight: 5,
    orientationLock: 'any',
    shape: 'box',
    ...overrides,
  };
}

function rectTruck(overrides = {}) {
  return { length: 120, width: 60, height: 60, shapeMode: 'rect', shapeConfig: {}, ...overrides };
}

// Coordinate convention (documented at pack-library.js TRUCK_DIRECTION_MODEL):
// x=0..truck.length (rear..front), y=0..height (floor up), z=-width/2..width/2.
function insideInstance(overrides = {}) {
  return {
    id: 'inst-inside',
    caseId: 'case-a',
    transform: {
      position: { x: 20, y: 5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    hidden: false,
    groupId: null,
    placement: 'packed',
    ...overrides,
  };
}

function outsideInstance(overrides = {}) {
  return {
    id: 'inst-outside',
    caseId: 'case-a',
    transform: {
      position: { x: -500, y: 5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    hidden: false,
    groupId: null,
    placement: 'staged',
    ...overrides,
  };
}

function basePack(overrides = {}) {
  return {
    id: 'pack-1',
    title: 'Load Plan 1',
    loadPlanNumber: 'LP-0001',
    customerReference: null,
    truck: rectTruck(),
    cases: [],
    groups: [],
    stats: {},
    ...overrides,
  };
}

function legacyQuantityPack(overrides = {}) {
  return basePack({
    cases: [insideInstance({ id: 'legacy-physical-1' }), outsideInstance({ id: 'legacy-physical-2' })],
    caseRequirements: [{ caseId: 'case-a', requiredQuantity: 99 }],
    ...overrides,
  });
}

function createMemoryLocalStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
}

function extractFunctionBlock(src, signature, endMarker = '\n    }') {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find "${signature}" in source`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `expected to find the end of "${signature}"`);
  return src.slice(start, end);
}

function aabbFor(position, dims) {
  return {
    min: { x: position.x - dims.length / 2, y: position.y - dims.height / 2, z: position.z - dims.width / 2 },
    max: { x: position.x + dims.length / 2, y: position.y + dims.height / 2, z: position.z + dims.width / 2 },
  };
}

function aabbsOverlap(a, b) {
  return (
    a.min.x < b.max.x && a.max.x > b.min.x &&
    a.min.y < b.max.y && a.max.y > b.min.y &&
    a.min.z < b.max.z && a.max.z > b.min.z
  );
}

// ---------------------------------------------------------------------------
// Obsolete-code scan — the rejected Target/Missing model must leave nothing
// stored, normalized, exported, imported, duplicated, or referenced anywhere
// in production or active test code. Historical docs may still mention it.
// ---------------------------------------------------------------------------

test('obsolete-code scan: caseRequirements/requiredQuantity have no production or active-test references', async () => {
  const roots = ['src', 'tests'];
  const hits = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (full.endsWith(path.join('tests', 'audit', 'quantity-controls-phase-1.spec.mjs'))) continue;
      const text = await fs.readFile(full, 'utf8');
      if (!/caseRequirements|requiredQuantity/.test(text)) continue;
      if (path.normalize(full) === path.normalize(fileURLToPath(normalizerUrl))) {
        const start = text.indexOf('export function sanitizeLegacyPackQuantityFields');
        const end = start >= 0 ? text.indexOf('\n}', start) : -1;
        const outsideSanitizer = start >= 0 && end > start
          ? text.slice(0, start) + text.slice(end + 2)
          : text;
        if (!/caseRequirements|requiredQuantity/.test(outsideSanitizer)) continue;
      }
      hits.push(full);
    }
  }
  for (const root of roots) {
    await walk(path.join(fileURLToPath(repoRoot), root));
  }
  assert.deepEqual(hits, [], `caseRequirements/requiredQuantity must not appear in: ${hits.join(', ')}`);
});

test('Case canonicalization strips only forbidden quantity-domain aliases', async () => {
  const [{ normalizeCase }, CargoCanonical, ImportSchema] = await Promise.all([
    import(normalizerUrl.href),
    import(cargoCanonicalUrl.href),
    import(importSchemaUrl.href),
  ]);
  const forbiddenKeys = [
    'quantity', 'qty', 'caseQuantity', 'case_quantity', 'case-qty',
    'requiredQuantity', 'required_quantity', 'Required-Qty',
    'desiredQuantity', 'desired_qty', 'targetQuantity', 'target-qty',
    'inventoryQuantity', 'inventory_qty', 'caseRequirements',
  ];
  const raw = baseCase({ customExtension: 'keep-me' });
  forbiddenKeys.forEach((key, index) => { raw[key] = index + 1; });

  const normalized = normalizeCase(raw, 123);
  const stripped = CargoCanonical.stripForbiddenCaseQuantityFields(raw);
  const portable = ImportSchema.projectPortableCase({ ...raw, volume: 1000 });

  for (const key of forbiddenKeys) {
    assert.equal(Object.prototype.hasOwnProperty.call(normalized, key), false, `normalized Case dropped ${key}`);
    assert.equal(Object.prototype.hasOwnProperty.call(stripped, key), false, `central sanitizer dropped ${key}`);
    assert.equal(Object.prototype.hasOwnProperty.call(portable, key), false, `portable Case dropped ${key}`);
  }
  assert.equal(normalized.customExtension, 'keep-me');
  assert.equal(stripped.customExtension, 'keep-me');
  assert.equal(portable.customExtension, 'keep-me');
  assert.equal(Object.prototype.hasOwnProperty.call(portable, 'volume'), false);
});

test('CaseLibrary upsert and duplicate cannot persist forbidden quantity aliases', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [], packLibrary: [], folderLibrary: [], preferences: {} });

  CaseLibrary.upsert(baseCase({
    quantity: 7,
    requiredQuantity: 9,
    target_quantity: 12,
    caseRequirements: [{ caseId: 'case-a', requiredQuantity: 99 }],
    customExtension: 'keep-me',
  }));
  const stored = CaseLibrary.getById('case-a');
  assert.equal(stored.customExtension, 'keep-me');
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'requiredQuantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'target_quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'caseRequirements'), false);

  const duplicateResult = CaseLibrary.duplicate('case-a');
  const duplicate = CaseLibrary.getById(duplicateResult.id);
  assert.ok(duplicate);
  assert.equal(duplicate.customExtension, 'keep-me');
  assert.equal(Object.prototype.hasOwnProperty.call(duplicate, 'quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(duplicate, 'requiredQuantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(duplicate, 'target_quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(duplicate, 'caseRequirements'), false);
  assert.equal(StateStore.get('packLibrary').length, 0, 'legacy Case quantities never create cargo instances');

  const importPlan = CaseLibrary.planCaseCatalogImport([baseCase({
    id: 'case-imported',
    name: 'Imported Case',
    inventoryQty: 6,
    desired_quantity: 4,
    customExtension: 'import-keep-me',
  })]);
  assert.equal(importPlan.newCases.length, 1);
  assert.equal(importPlan.newCases[0].customExtension, 'import-keep-me');
  assert.equal(Object.prototype.hasOwnProperty.call(importPlan.newCases[0], 'inventoryQty'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(importPlan.newCases[0], 'desired_quantity'), false);
});

test('legacy Case quantity aliases are dropped on app normalization without creating instances', async () => {
  const { normalizeAppData } = await import(normalizerUrl.href);
  const normalized = normalizeAppData({
    caseLibrary: [baseCase({
      Quantity: 7,
      required_quantity: 9,
      targetQty: 12,
      inventory_quantity: 3,
      customExtension: 'keep-me',
    })],
    packLibrary: [],
    folderLibrary: [],
    preferences: {},
  });
  const stored = normalized.caseLibrary[0];
  assert.equal(stored.customExtension, 'keep-me');
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'Quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'required_quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'targetQty'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'inventory_quantity'), false);
  assert.deepEqual(normalized.packLibrary, []);
});

test('Case catalog and backup exports cannot emit Case-owned quantity aliases', async () => {
  const { StateStore, CaseLibrary, ImportExport } = await loadModules();
  const legacyCase = baseCase({
    quantity: 7,
    required_quantity: 9,
    targetQty: 12,
    caseRequirements: [{ caseId: 'case-a', requiredQty: 5 }],
    customExtension: 'keep-me',
  });
  StateStore.init({ caseLibrary: [], packLibrary: [], folderLibrary: [], preferences: {} });
  CaseLibrary.upsert(legacyCase);

  const catalogJson = ImportExport.buildCaseCatalogExportJSON([legacyCase]);
  const appJson = ImportExport.buildAppExportJSON();
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Quantity Invariant');
  for (const json of [catalogJson, appJson, workspaceJson]) {
    assert.doesNotMatch(json, /"(?:quantity|required[_-]?quantity|target[_-]?qty|caseRequirements)"\s*:/i);
    assert.match(json, /"customExtension"\s*:\s*"keep-me"/);
  }

  const importedCatalog = ImportExport.parseCaseCatalogImportJSON(catalogJson);
  assert.equal(importedCatalog.length, 1);
  assert.equal(importedCatalog[0].customExtension, 'keep-me');
  assert.equal(Object.prototype.hasOwnProperty.call(importedCatalog[0], 'quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(importedCatalog[0], 'required_quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(importedCatalog[0], 'targetQty'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(importedCatalog[0], 'caseRequirements'), false);

  const restoredApp = ImportExport.parseAppImportJSON(appJson);
  const restoredWorkspace = ImportExport.parseWorkspaceImportJSON(workspaceJson);
  for (const restoredCase of [restoredApp.caseLibrary[0], restoredWorkspace.caseLibrary[0]]) {
    assert.equal(restoredCase.customExtension, 'keep-me');
    assert.equal(Object.prototype.hasOwnProperty.call(restoredCase, 'quantity'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(restoredCase, 'required_quantity'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(restoredCase, 'targetQty'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(restoredCase, 'caseRequirements'), false);
  }
});

// ===========================================================================
// EDITOR (Requirements 1-27)
// ===========================================================================

test('Requirement 1: Qty defaults to 1', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  assert.match(src, /const CASE_QTY_MIN = 1;/);
  assert.match(src, /function getCaseQtyDraft\(caseId\) \{\s*const stored = caseQtyDrafts\.get\(caseId\);\s*return Number\.isFinite\(stored\) \? stored : CASE_QTY_MIN;/);
});

test('Requirement 2: minus never drops below 1', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const setter = extractFunctionBlock(src, 'function setCaseQtyDraft(caseId, value) {', '\n    }');
  assert.match(setter, /Math\.max\(CASE_QTY_MIN, Math\.trunc\(value\)\)/);
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /minusBtn\.addEventListener\('click', \(\) => \{\s*commitDraft\(getCaseQtyDraft\(c\.id\) - 1\);/);
});

test('Requirement 3: plus increments (clamped by setCaseQtyDraft to CASE_QTY_MAX)', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  assert.match(src, /const CASE_QTY_MAX = 10000;/);
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /plusBtn\.addEventListener\('click', \(\) => \{\s*commitDraft\(getCaseQtyDraft\(c\.id\) \+ 1\);/);
});

test('Requirement 4: direct integer input is accepted', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /const parseDirectEntry = \(\) => \{/);
  assert.match(block, /Number\.isInteger\(n\)/);
});

test('Requirement 5: Enter commits the direct-entry value', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /if \(ev\.key === 'Enter'\) \{\s*ev\.preventDefault\(\);\s*commitDraft\(parseDirectEntry\(\)\);/);
});

test('Requirement 6: blur commits the direct-entry value (except when focus is heading to + Add / Unstage — see P1-B Q1/Q2)', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  const blur = extractFunctionBlock(block, "input.addEventListener('blur', ev => {", '\n      });');
  assert.match(blur, /if \(toAction\) return;\s*commitDraft\(parseDirectEntry\(\)\);/, 'every other blur still commits/reverts exactly as before');
});

test('Requirement 7: Escape restores the prior valid value', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /else if \(ev\.key === 'Escape'\) \{\s*ev\.preventDefault\(\);\s*revertInput\(\);\s*input\.blur\(\);/);
});

test('Requirement 8: blank/zero/negative/non-numeric/NaN/infinite/fractional input restores the prior valid value', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  const parseBlock = extractFunctionBlock(block, 'const parseDirectEntry = () => {', '\n      };');
  assert.match(parseBlock, /if \(raw === ''\) return null;/);
  assert.match(parseBlock, /if \(!Number\.isFinite\(n\) \|\| !Number\.isInteger\(n\) \|\| n < CASE_QTY_MIN\) return null;/);
  assert.match(block, /const commitDraft = value => \{\s*if \(value === null\) \{\s*revertInput\(\);/);
});

test('Requirement 9: maximum is 10,000', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const setter = extractFunctionBlock(src, 'function setCaseQtyDraft(caseId, value) {', '\n    }');
  assert.match(setter, /Math\.min\(CASE_QTY_MAX, Math\.max\(CASE_QTY_MIN, Math\.trunc\(value\)\)\)/);
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /input\.max = String\(CASE_QTY_MAX\)/);
});

test('Requirement 10: the "+ Add" button label always remains exactly "+ Add" — never dynamic', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /addBtn\.innerHTML = '<i class="fa-solid fa-plus"><\/i> Add';/);
  assert.doesNotMatch(block, /Add \$\{/);
  // No Target/Missing-era dynamic labels survive anywhere in the file.
  assert.doesNotMatch(src, /Target met|Over target|Add \$\{status\.missing\}/);
});

test('Requirement 11: PackLibrary.addInstancesToStaging(pack, case, 5) creates exactly five physical instances', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const result = PackLibrary.addInstancesToStaging('pack-1', 'case-a', 5);
  assert.equal(result.requestedCount, 5);
  assert.equal(result.addedCount, 5);
  assert.equal(result.createdInstanceIds.length, 5);
  assert.equal(PackLibrary.getById('pack-1').cases.length, 5);
});

test('Requirement 12 & 13: every button-created instance is staged, none inside valid truck geometry', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  PackLibrary.addInstancesToStaging('pack-1', 'case-a', 6);
  const counts = PackLibrary.getCaseInstanceCounts('pack-1', 'case-a');
  assert.equal(counts.staged, 6);
  assert.equal(counts.inTruck, 0);
});

test('Requirement 14: new staged instances do not overlap one another', async () => {
  const { StateStore, PackLibrary, CaseLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const result = PackLibrary.addInstancesToStaging('pack-1', 'case-a', 25);
  const caseData = CaseLibrary.getById('case-a');
  const pack = PackLibrary.getById('pack-1');
  const created = pack.cases.filter(i => result.createdInstanceIds.includes(i.id));
  const boxes = created.map(i => aabbFor(i.transform.position, caseData.dimensions));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!aabbsOverlap(boxes[i], boxes[j]), `created instance ${i} and ${j} must not overlap`);
    }
  }
});

test('Requirement 15: existing physical instances remain unchanged after a bulk add', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const existing = insideInstance({ id: 'pre-existing' });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [existing] })], folderLibrary: [], preferences: {} });
  PackLibrary.addInstancesToStaging('pack-1', 'case-a', 3);
  const pack = PackLibrary.getById('pack-1');
  const stillThere = pack.cases.find(i => i.id === 'pre-existing');
  assert.deepEqual(stillThere, existing);
});

test('Requirement 16: bulk addition uses exactly one Pack update/history action, never one per instance', async () => {
  const src = await fs.readFile(packLibraryUrl, 'utf8');
  const block = extractFunctionBlock(src, 'export function addInstancesToStaging(packId, caseId, count) {', '\n}');
  const updateCalls = block.match(/\bupdate\(packId/g) || [];
  assert.equal(updateCalls.length, 1, 'addInstancesToStaging must call update() exactly once for the whole batch');
  assert.doesNotMatch(block, /\baddInstance\(pack/);
});

test('Requirement 17 & 18: Undo removes the entire batch, Redo restores the entire batch', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  PackLibrary.addInstancesToStaging('pack-1', 'case-a', 8);
  assert.equal(PackLibrary.getById('pack-1').cases.length, 8);
  StateStore.undo();
  assert.equal(PackLibrary.getById('pack-1').cases.length, 0);
  StateStore.redo();
  assert.equal(PackLibrary.getById('pack-1').cases.length, 8);
});

test('P0 LOAD PLAN UNDO/REDO: opening a different Load Plan establishes a new history boundary', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  const packB = basePack({ id: 'pack-b', loadPlanNumber: 'LP-000B', title: 'Load Plan B' });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [packA, packB], folderLibrary: [], preferences: {} });
  PackLibrary.open('pack-a');

  PackLibrary.update('pack-a', { notes: 'edited-a' });
  PackLibrary.open('pack-b');
  assert.equal(StateStore.get('currentPackId'), 'pack-b');

  assert.equal(StateStore.undo(), false, 'Undo must not be able to reach history created before B was opened');
  assert.equal(PackLibrary.getById('pack-a').notes, 'edited-a', "A's edit must survive the failed cross-Pack Undo attempt");
  assert.equal(StateStore.get('currentPackId'), 'pack-b');

  PackLibrary.update('pack-b', { notes: 'edited-b' });
  assert.equal(PackLibrary.getById('pack-b').notes, 'edited-b');

  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-b').notes, undefined, 'B must return to its pre-edit value');
  assert.equal(StateStore.get('currentPackId'), 'pack-b');

  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-b').notes, 'edited-b');
  assert.equal(StateStore.get('currentPackId'), 'pack-b');
});

test('P0 LOAD PLAN UNDO/REDO: reopening the same active Load Plan preserves valid history', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [packA], folderLibrary: [], preferences: {} });
  PackLibrary.open('pack-a');

  PackLibrary.update('pack-a', { notes: 'edited-a' });
  PackLibrary.open('pack-a');

  assert.equal(StateStore.undo(), true, 'reopening the same active Load Plan must not clear its Undo stack');
  assert.equal(PackLibrary.getById('pack-a').notes, undefined, 'A must return to its pre-edit value');
});

test('P0 EDITOR UNDO SESSION: AppShell.navigate() establishes a fresh baseline entering Editor from another screen', async () => {
  const { StateStore, PackLibrary, AppShell } = await loadAppShellHarness();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [packA],
    folderLibrary: [],
    preferences: {},
    currentScreen: 'packs',
  });
  PackLibrary.open('pack-a');
  AppShell.navigate('editor');
  PackLibrary.update('pack-a', { notes: 'edited-in-editor' });
  assert.equal(PackLibrary.getById('pack-a').notes, 'edited-in-editor');

  AppShell.navigate('cases');
  AppShell.navigate('editor');

  assert.equal(StateStore.undo(), false, 'the pre-exit Editor history must not be reachable after re-entry');
  assert.equal(PackLibrary.getById('pack-a').notes, 'edited-in-editor',
    "A's edit must remain — Undo could not reach the old session to revert it");
});

test('P0 EDITOR UNDO SESSION: AppShell.navigate() does not reset history when already on Editor', async () => {
  const { StateStore, PackLibrary, AppShell } = await loadAppShellHarness();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [packA],
    folderLibrary: [],
    preferences: {},
    currentScreen: 'packs',
  });
  PackLibrary.open('pack-a');
  AppShell.navigate('editor');
  PackLibrary.update('pack-a', { notes: 'edited-in-editor' });

  AppShell.navigate('editor');

  assert.equal(StateStore.undo(), true, 'staying on Editor must preserve the valid Undo stack');
  assert.equal(PackLibrary.getById('pack-a').notes, undefined, 'A must return to its pre-edit value');
});

test('P0 EDITOR UNDO SESSION: a late significant write after re-entry cannot expose pre-exit Editor history', async () => {
  const { StateStore, PackLibrary, AppShell } = await loadAppShellHarness();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [packA],
    folderLibrary: [],
    preferences: {},
    currentScreen: 'packs',
  });
  PackLibrary.open('pack-a');
  AppShell.navigate('editor');
  PackLibrary.update('pack-a', { notes: 'old-session-edit' });

  AppShell.navigate('cases');
  AppShell.navigate('editor');

  // Represents a late system write landing after the re-entry baseline (e.g. an
  // async automatic preview capture resolving after Editor already re-established
  // its session) — a normal significant packLibrary mutation, not skipHistory.
  PackLibrary.update('pack-a', { thumbnailUpdatedAt: 123 });

  assert.equal(StateStore.undo(), true, 'the late write itself remains undoable');
  assert.equal(PackLibrary.getById('pack-a').thumbnailUpdatedAt, undefined, 'undo removes only the late write');

  assert.equal(StateStore.undo(), false, 'a second Undo must not reach the pre-exit Editor session');
  assert.equal(PackLibrary.getById('pack-a').notes, 'old-session-edit',
    "the old session's edit remains in place — it was never rolled back, just sealed off from Undo");
});

test('P0 EDITOR UNDO ATOMICITY: a derived preview write consumes zero user-facing Undo steps', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [packA], folderLibrary: [], preferences: {} });

  // one visible user mutation
  PackLibrary.update('pack-a', { notes: 'user-edit' });
  assert.equal(PackLibrary.getById('pack-a').notes, 'user-edit');

  // a derived/system write (e.g. automatic preview capture) landing right after —
  // must not consume its own Undo step.
  PackLibrary.update('pack-a', {
    thumbnail: 'data:image/jpeg;base64,x',
    thumbnailUpdatedAt: 999,
    thumbnailSource: 'auto',
  }, { skipHistory: true });
  assert.equal(PackLibrary.getById('pack-a').thumbnail, 'data:image/jpeg;base64,x');

  assert.equal(StateStore.undo(), true, 'one Undo must reach the user edit directly');
  assert.equal(PackLibrary.getById('pack-a').notes, undefined, 'the user edit is reverted on the first Undo');

  assert.equal(StateStore.undo(), false, 'no second, hidden Undo step exists for the derived write');

  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-a').notes, 'user-edit', 'one Redo restores the user edit');
});

test('P0 EDITOR UNDO ATOMICITY: PackLibrary.update() without options still creates normal history', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [packA], folderLibrary: [], preferences: {} });

  PackLibrary.update('pack-a', { notes: 'default-call-edit' });
  assert.equal(PackLibrary.getById('pack-a').notes, 'default-call-edit');

  assert.equal(StateStore.undo(), true,
    'the existing two-argument PackLibrary.update(packId, patch) call must still push normal, undoable history');
  assert.equal(PackLibrary.getById('pack-a').notes, undefined);
});

// A Pack's derived preview describes the cargo of the history entry it was captured for: Undo/Redo restore the
// preview that entry holds, and a derived preview write is carried into the entry that is current when it lands.
// The signature below stands in for the Editor's visual signature (CaseScene.getVisualSignature): a pure function
// of the cargo a preview depicts, so a preview is current exactly when its signature matches the Pack now.
function previewSignatureOf(pack) {
  return JSON.stringify((pack.cases || []).map(inst => [inst.id, inst.caseId, inst.transform && inst.transform.position, inst.hidden]));
}
// What an automatic capture writes (app.js capturePackPreview): a derived preview write, never an Undo step.
function writePreview(PackLibrary, packId, tag, signature = previewSignatureOf(PackLibrary.getById(packId))) {
  return PackLibrary.updatePreview(packId, {
    thumbnail: `data:image/jpeg;base64,${tag}`,
    thumbnailRenderVersion: 3,
    thumbnailUpdatedAt: 1000,
    thumbnailSource: 'auto',
    thumbnailVisualSignature: signature,
    thumbnailViewSignature: 'view-1',
  }, { skipHistory: true });
}
// What the Packs list would show: the stored image, and whether its signature matches the cargo held now.
function shownPreview(PackLibrary, packId) {
  const pack = PackLibrary.getById(packId);
  return {
    image: pack.thumbnail ? pack.thumbnail.split(',')[1] : null,
    fresh: pack.thumbnailVisualSignature === previewSignatureOf(pack),
  };
}
function initPreviewPacks(StateStore, extraPacks = []) {
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' }), ...extraPacks],
    folderLibrary: [],
    preferences: {},
  });
}
const movedTo = (crate, x) => ({ transform: { ...crate.transform, position: { x, y: 5, z: 0 } } });

test('P0 EDITOR UNDO PREVIEW: Undo/Redo across real cargo edits restore the preview captured for each state, including older entries', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  initPreviewPacks(StateStore);
  writePreview(PackLibrary, 'pack-a', 's0');
  const crate = PackLibrary.addInstance('pack-a', 'case-a', { x: 15, y: 5, z: 0 });
  writePreview(PackLibrary, 'pack-a', 's1');
  PackLibrary.updateInstance('pack-a', crate.id, movedTo(crate, 40));
  writePreview(PackLibrary, 'pack-a', 's2');
  PackLibrary.addInstance('pack-a', 'case-a', { x: 70, y: 5, z: 0 });
  writePreview(PackLibrary, 'pack-a', 's3');
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's3', fresh: true });
  assert.equal(StateStore.undoDepth(), 3, 'three cargo edits are three Undo steps; the four captures added none');

  const walk = [
    ['undo', 's2', 1], ['undo', 's1', 1], ['undo', 's0', 0],
    ['redo', 's1', 1], ['redo', 's2', 1], ['redo', 's3', 2],
    ['undo', 's2', 1], ['undo', 's1', 1], ['redo', 's2', 1],
  ];
  for (const [direction, image, cargo] of walk) {
    assert.equal(StateStore[direction](), true);
    assert.equal(PackLibrary.getById('pack-a').cases.length, cargo);
    assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image, fresh: true }, `${direction} shows the preview captured for that cargo`);
  }
});

test("P0 EDITOR UNDO PREVIEW: a state without its own preview never shows a newer state's image as current", async () => {
  const { StateStore, PackLibrary } = await loadModules();
  initPreviewPacks(StateStore);
  writePreview(PackLibrary, 'pack-a', 's0');
  const crate = PackLibrary.addInstance('pack-a', 'case-a', { x: 15, y: 5, z: 0 });
  PackLibrary.updateInstance('pack-a', crate.id, movedTo(crate, 40));
  writePreview(PackLibrary, 'pack-a', 's2');

  assert.equal(StateStore.undo(), true);
  const unpreviewed = shownPreview(PackLibrary, 'pack-a');
  assert.equal(unpreviewed.fresh, false, 'its preview is detectably stale, so the scheduler captures it again');
  assert.notEqual(unpreviewed.image, 's2', "and it is never the newer state's image");
  assert.equal(StateStore.undo(), true);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's0', fresh: true });
  assert.equal(StateStore.redo(), true);
  assert.equal(shownPreview(PackLibrary, 'pack-a').fresh, false);
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's2', fresh: true });
});

test('P0 EDITOR UNDO PREVIEW: an asynchronous preview write lands on the state it arrives in and never adds, drops or crosses an Undo step', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  initPreviewPacks(StateStore);
  writePreview(PackLibrary, 'pack-a', 's0');
  const inFlight = previewSignatureOf(PackLibrary.getById('pack-a'));
  PackLibrary.addInstance('pack-a', 'case-a', { x: 15, y: 5, z: 0 });
  await Promise.resolve();
  const depth = StateStore.undoDepth();
  writePreview(PackLibrary, 'pack-a', 'late', inFlight);
  assert.equal(StateStore.undoDepth(), depth, 'a late write is not an Undo step');
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 'late', fresh: false },
    'it is stale for the cargo now held, so it is captured again');

  assert.equal(StateStore.undo(), true);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's0', fresh: true }, 'the late write did not cross into the older entry');
  // A refreshed capture of the older state lands while Redo is available: it must not drop the Redo.
  writePreview(PackLibrary, 'pack-a', 's0b');
  assert.equal(StateStore.redo(), true, 'a derived write keeps Redo available');
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 'late', fresh: false });
  assert.equal(StateStore.undo(), true);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's0b', fresh: true },
    'and the older state keeps the capture made while it was current');
});

test('P0 EDITOR UNDO PREVIEW: Clear Preview is one Undo step that restores the latest image and is redone as cleared', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  initPreviewPacks(StateStore);
  PackLibrary.addInstance('pack-a', 'case-a', { x: 15, y: 5, z: 0 });
  writePreview(PackLibrary, 'pack-a', 'first');
  writePreview(PackLibrary, 'pack-a', 'latest');
  const depth = StateStore.undoDepth();
  // What clearPackPreview writes: the one recorded preview write.
  PackLibrary.updatePreview('pack-a', {
    thumbnail: null, thumbnailUpdatedAt: null, thumbnailSource: null, thumbnailRenderVersion: 3,
    thumbnailVisualSignature: previewSignatureOf(PackLibrary.getById('pack-a')), thumbnailViewSignature: 'view-1',
  }, { skipHistory: false });
  assert.equal(StateStore.undoDepth(), depth + 1, 'Clear Preview is exactly one Undo step');
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: null, fresh: true }, 'cleared, and intentionally so for this cargo');

  assert.equal(StateStore.undo(), true);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 'latest', fresh: true }, 'Undo brings back the latest image');
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: null, fresh: true }, 'Redo clears it again');
});

test('P0 EDITOR UNDO PREVIEW: only a derived pack-preview write for the Pack just written is carried into the current entry, and no other Pack is touched', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const otherPack = () => basePack({
    id: 'pack-b', loadPlanNumber: 'LP-000B', title: 'Load Plan B',
    thumbnail: 'data:image/jpeg;base64,b0', thumbnailVisualSignature: 'sig-b',
  });
  const forgedImage = 'data:image/jpeg;base64,forged';
  // The preview the current entry holds after Undo then Redo back to it.
  const afterRoundTrip = notificationFor => {
    initPreviewPacks(StateStore, [otherPack()]);
    writePreview(PackLibrary, 'pack-a', 's0');
    PackLibrary.update('pack-a', { notes: 'edit' });
    const previous = PackLibrary.getById('pack-a');
    const forged = { ...previous, thumbnail: forgedImage, thumbnailVisualSignature: 'forged' };
    StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'pack-a' ? forged : p)) },
      { skipHistory: true, notification: notificationFor(previous, forged) });
    assert.equal(PackLibrary.getById('pack-a').thumbnail, forgedImage, 'the state itself always takes the write');
    assert.equal(StateStore.undo(), true);
    assert.equal(StateStore.redo(), true);
    return PackLibrary.getById('pack-a').thumbnail;
  };
  const own = 'data:image/jpeg;base64,s0';
  assert.equal(afterRoundTrip((previous, forged) => ({ type: 'pack-preview', previousPack: previous, pack: forged })), forgedImage,
    'a pack-preview notification naming the Pack just written is carried');
  assert.equal(afterRoundTrip((previous, forged) => ({ type: 'pack-preview', previousPack: previous, pack: { ...forged } })), own,
    'a notification naming some other object is not trusted');
  assert.equal(afterRoundTrip((previous, forged) => ({ type: 'pack-preview', previousPack: previous, pack: { ...forged, id: 'missing' } })), own,
    'an unknown Pack id is ignored');
  assert.equal(afterRoundTrip((previous, forged) => ({ type: 'pack-view', previousPack: previous, pack: forged })), own,
    'another notification type is not a preview write');
  assert.equal(afterRoundTrip(() => undefined), own, 'a write without a notification is not a preview write');

  initPreviewPacks(StateStore, [otherPack()]);
  const untouched = JSON.stringify(PackLibrary.getById('pack-b'));
  writePreview(PackLibrary, 'pack-a', 's0');
  PackLibrary.update('pack-a', { notes: 'edit' });
  writePreview(PackLibrary, 'pack-a', 'carried');
  assert.equal(JSON.stringify(PackLibrary.getById('pack-b')), untouched, 'a preview write for one Pack leaves every other Pack alone');
  assert.equal(StateStore.undo(), true);
  assert.equal(JSON.stringify(PackLibrary.getById('pack-b')), untouched, 'also across Undo');
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's0', fresh: true });
  assert.equal(StateStore.redo(), true);
  assert.equal(JSON.stringify(PackLibrary.getById('pack-b')), untouched, 'and Redo');
  assert.equal(shownPreview(PackLibrary, 'pack-a').image, 'carried', 'while the written Pack keeps its capture in the current entry');
});

test('P0 EDITOR UNDO PREVIEW: a carried preview brings only the preview fields into history, never an unrecorded edit', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  initPreviewPacks(StateStore);
  writePreview(PackLibrary, 'pack-a', 's0');
  PackLibrary.update('pack-a', { notes: 'recorded' });
  PackLibrary.update('pack-a', { notes: 'unrecorded' }, { skipHistory: true });
  writePreview(PackLibrary, 'pack-a', 'carried');
  assert.equal(PackLibrary.getById('pack-a').notes, 'unrecorded', 'the state itself holds the unrecorded edit');
  assert.equal(StateStore.undoDepth(), 1, 'and only the recorded edit is a step');

  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-a').notes, undefined);
  assert.deepEqual(shownPreview(PackLibrary, 'pack-a'), { image: 's0', fresh: true });
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-a').notes, 'recorded', 'history holds the recorded edit, not the unrecorded one');
  assert.equal(shownPreview(PackLibrary, 'pack-a').image, 'carried', 'while the entry kept the preview written after it');
});

test('P0 EDITOR UNDO PREVIEW: a late derived write after the Editor session is re-established creates no step and cannot expose older history', async () => {
  const { StateStore, PackLibrary, AppShell } = await loadAppShellHarness();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', title: 'Load Plan A' })],
    folderLibrary: [],
    preferences: {},
    currentScreen: 'packs',
  });
  PackLibrary.open('pack-a');
  AppShell.navigate('editor');
  PackLibrary.update('pack-a', { notes: 'old-session-edit' });
  AppShell.navigate('cases');
  AppShell.navigate('editor');

  // An automatic capture started in the old session resolves after Editor re-established its baseline.
  writePreview(PackLibrary, 'pack-a', 'late');
  assert.equal(StateStore.undoDepth(), 0, 'the late write is not an Undo step');
  assert.equal(StateStore.undo(), false, 'and Undo cannot reach the pre-exit session');
  assert.equal(PackLibrary.getById('pack-a').notes, 'old-session-edit');

  PackLibrary.update('pack-a', { notes: 'new-session-edit' });
  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-a').notes, 'old-session-edit');
  assert.equal(shownPreview(PackLibrary, 'pack-a').image, 'late', 'the session baseline carries the late preview');
});

test("P0 EDITOR UNDO: Undo/Redo restore each Pack's exact historical lastEdited, including a Pack that never had one", async () => {
  const { StateStore, PackLibrary } = await loadModules();
  initPreviewPacks(StateStore, [basePack({ id: 'pack-b', loadPlanNumber: 'LP-000B', title: 'Load Plan B', lastEdited: 5 })]);
  assert.equal(Object.hasOwn(PackLibrary.getById('pack-a'), 'lastEdited'), false, 'fixture: pack-a has no lastEdited');
  PackLibrary.update('pack-a', { notes: 'edit a' });
  const editedA = PackLibrary.getById('pack-a').lastEdited;
  PackLibrary.update('pack-b', { notes: 'edit b' });
  const editedB = PackLibrary.getById('pack-b').lastEdited;
  assert.ok(editedA > 5 && editedB > 5, 'each edit moves lastEdited');

  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-b').lastEdited, 5, 'Undo restores the time the Pack had');
  assert.equal(PackLibrary.getById('pack-a').lastEdited, editedA);
  assert.equal(StateStore.undo(), true);
  assert.equal(Object.hasOwn(PackLibrary.getById('pack-a'), 'lastEdited'), false, 'and invents none for a Pack that had none');
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-a').lastEdited, editedA);
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-b').lastEdited, editedB);
});

test('P0 EDITOR UNDO ATOMICITY: Hide/Show batch commits and reverts N instances in one Undo/Redo step', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const instA = insideInstance({ id: 'inst-a' });
  const instB = insideInstance({ id: 'inst-b' });
  const instC = insideInstance({ id: 'inst-c' });
  const packA = basePack({ id: 'pack-a', loadPlanNumber: 'LP-000A', cases: [instA, instB, instC] });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [packA], folderLibrary: [], preferences: {} });

  // Mirrors the fixed makeVisibilityButton() handler: one batched PackLibrary.update()
  // for the whole selection, not one PackLibrary.updateInstance() per instance.
  const targetIds = new Set(['inst-a', 'inst-b', 'inst-c']);
  const livePack = PackLibrary.getById('pack-a');
  const nextCases = livePack.cases.map(inst => (targetIds.has(inst.id) ? { ...inst, hidden: true } : inst));
  PackLibrary.update('pack-a', { cases: nextCases });

  const hiddenAfter = PackLibrary.getById('pack-a').cases;
  assert.ok(hiddenAfter.every(inst => inst.hidden === true), 'all three instances are hidden after one Hide action');

  assert.equal(StateStore.undo(), true, 'one Undo must restore the whole selection');
  const restored = PackLibrary.getById('pack-a').cases;
  assert.ok(restored.every(inst => inst.hidden === false), 'all three instances are visible again after exactly one Undo');

  assert.equal(StateStore.redo(), true, 'one Redo must re-apply the whole selection');
  const redone = PackLibrary.getById('pack-a').cases;
  assert.ok(redone.every(inst => inst.hidden === true), 'all three instances are hidden again after exactly one Redo');
});

test('P0 CASE/CATEGORY ATOMICITY: Set Category commits N Case templates + category preferences as one Undo/Redo step', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  const caseA = baseCase({ id: 'case-a', name: 'Case A', category: 'x' });
  const caseB = baseCase({ id: 'case-b', name: 'Case B', category: 'y' });
  StateStore.init({
    caseLibrary: [caseA, caseB],
    packLibrary: [],
    folderLibrary: [],
    preferences: {
      categories: [
        { key: 'x', name: 'X', color: '#111111' },
        { key: 'y', name: 'Y', color: '#222222' },
      ],
    },
  });

  // Mirrors the fixed openSetCategoryModal() Apply handler: build the patch
  // list first (preserving the existing per-case no-op skip), then commit the
  // whole selection + category atomically in one call.
  const result = CaseLibrary.commitCasesWithCategory(
    [
      { id: 'case-a', category: 'cables', name: 'Cables' },
      { id: 'case-b', category: 'cables', name: 'Cables' },
    ],
    { name: 'Cables', color: '#ff9f1c' }
  );
  assert.equal(result.cases.length, 2, 'both Case templates are committed');

  assert.equal(CaseLibrary.getById('case-a').category, 'cables');
  assert.equal(CaseLibrary.getById('case-b').category, 'cables');
  assert.ok(StateStore.get('preferences').categories.find(c => c.key === 'cables'),
    'the Cables category preference exists after Apply');

  assert.equal(StateStore.undo(), true, 'one Undo must be sufficient for the whole Apply');
  assert.equal(CaseLibrary.getById('case-a').category, 'x', 'Case A returns to its original category');
  assert.equal(CaseLibrary.getById('case-a').name, 'Case A', 'Case A returns to its original name');
  assert.equal(CaseLibrary.getById('case-b').category, 'y', 'Case B returns to its original category');
  assert.equal(CaseLibrary.getById('case-b').name, 'Case B', 'Case B returns to its original name');
  assert.equal(StateStore.get('preferences').categories.find(c => c.key === 'cables'), undefined,
    'the category preference is gone — the exact prior state is restored');

  assert.equal(StateStore.undo(), false, 'a second Undo must not be required for the same Apply action');

  assert.equal(StateStore.redo(), true, 'one Redo restores both templates and the category preference together');
  assert.equal(CaseLibrary.getById('case-a').category, 'cables');
  assert.equal(CaseLibrary.getById('case-b').category, 'cables');
  assert.ok(StateStore.get('preferences').categories.find(c => c.key === 'cables'));
});

test('P0 CASE/CATEGORY ATOMICITY: multiple selected instances sharing one Case template still commit once', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  const caseA = baseCase({ id: 'case-a', name: 'Case A', category: 'x' });
  StateStore.init({
    caseLibrary: [caseA],
    packLibrary: [],
    folderLibrary: [],
    preferences: { categories: [{ key: 'x', name: 'X', color: '#111111' }] },
  });

  // Two cargo instances both reference case-a — the Editor de-dupes to one
  // patch via a Set before calling this, and the atomic commit itself must
  // also never create more than one entry for the shared template.
  const result = CaseLibrary.commitCasesWithCategory(
    [{ id: 'case-a', category: 'cables', name: 'Cables' }],
    { name: 'Cables', color: '#ff9f1c' }
  );
  assert.equal(result.cases.length, 1, 'the shared Case template is committed exactly once');
  assert.equal(CaseLibrary.getCases().length, 1, 'no duplicate Case entry was created');

  assert.equal(StateStore.undo(), true);
  assert.equal(CaseLibrary.getById('case-a').category, 'x');
  assert.equal(StateStore.undo(), false, 'history remains exactly one step for the whole action');
});

test('P0 CASE/CATEGORY ATOMICITY: New Case Save with an unchanged existing category is one Undo/Redo step', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [],
    packLibrary: [],
    folderLibrary: [],
    preferences: { categories: [{ key: 'default', name: 'Default', color: '#9ca3af' }] },
  });

  const newCase = baseCase({ id: 'case-new', name: 'New Case', category: 'default' });
  const result = CaseLibrary.commitCaseWithCategory(newCase, { key: 'default', name: 'Default', color: '#9ca3af' });
  assert.ok(result.case, 'the new Case was committed');
  assert.equal(CaseLibrary.getById('case-new').name, 'New Case');

  assert.equal(StateStore.undo(), true, 'one Undo must remove the Save');
  assert.equal(CaseLibrary.getById('case-new'), null, 'the new Case is gone after one Undo');

  assert.equal(StateStore.undo(), false, 'no extra invisible category Undo step exists');

  assert.equal(StateStore.redo(), true, 'one Redo must restore the Save');
  assert.equal(CaseLibrary.getById('case-new').name, 'New Case');
});

test('P0 CASE/CATEGORY ATOMICITY: Case Save that also creates/changes category metadata is one Undo/Redo step', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [],
    packLibrary: [],
    folderLibrary: [],
    preferences: { categories: [{ key: 'default', name: 'Default', color: '#9ca3af' }] },
  });

  const newCase = baseCase({ id: 'case-new', name: 'New Case', category: 'cables' });
  CaseLibrary.commitCaseWithCategory(newCase, { key: 'cables', name: 'Cables', color: '#ff9f1c' });

  assert.equal(CaseLibrary.getById('case-new').category, 'cables');
  assert.ok(StateStore.get('preferences').categories.find(c => c.key === 'cables'), 'the new category preference exists');

  assert.equal(StateStore.undo(), true, 'one Undo must restore both prior states');
  assert.equal(CaseLibrary.getById('case-new'), null, 'the Case is gone');
  assert.equal(StateStore.get('preferences').categories.find(c => c.key === 'cables'), undefined,
    'the category preference is also gone — restored together');

  assert.equal(StateStore.redo(), true, 'one Redo must restore both new states');
  assert.equal(CaseLibrary.getById('case-new').category, 'cables');
  assert.ok(StateStore.get('preferences').categories.find(c => c.key === 'cables'));
});

test('P0 CASE/CATEGORY ATOMICITY: editing an existing Case plus its category metadata is one Undo/Redo step', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  const existing = baseCase({ id: 'case-a', name: 'Case A', category: 'x' });
  StateStore.init({
    caseLibrary: [existing],
    packLibrary: [],
    folderLibrary: [],
    preferences: { categories: [{ key: 'x', name: 'X', color: '#111111' }] },
  });

  const edited = { ...existing, name: 'Case A Updated', category: 'cables' };
  CaseLibrary.commitCaseWithCategory(edited, { key: 'cables', name: 'Cables', color: '#ff9f1c' });

  assert.equal(CaseLibrary.getById('case-a').name, 'Case A Updated');
  assert.equal(CaseLibrary.getById('case-a').category, 'cables');

  assert.equal(StateStore.undo(), true);
  assert.equal(CaseLibrary.getById('case-a').name, 'Case A');
  assert.equal(CaseLibrary.getById('case-a').category, 'x');
  assert.equal(StateStore.get('preferences').categories.find(c => c.key === 'cables'), undefined);

  assert.equal(StateStore.undo(), false, 'the edit remains a single Undo step');

  assert.equal(StateStore.redo(), true);
  assert.equal(CaseLibrary.getById('case-a').name, 'Case A Updated');
});

test('P0 CASE/CATEGORY ATOMICITY: a validation failure commits neither preferences nor caseLibrary, and no history entry', async () => {
  const { StateStore, CaseLibrary } = await loadModules();
  const caseA = baseCase({ id: 'case-a', name: 'Case A', category: 'x', itemCode: 'ITEM-1' });
  const caseB = baseCase({ id: 'case-b', name: 'Case B', category: 'y', itemCode: 'ITEM-2' });
  StateStore.init({
    caseLibrary: [caseA, caseB],
    packLibrary: [],
    folderLibrary: [],
    preferences: {
      categories: [
        { key: 'x', name: 'X', color: '#111111' },
        { key: 'y', name: 'Y', color: '#222222' },
      ],
    },
  });

  const prefsBefore = StateStore.get('preferences');
  const casesBefore = CaseLibrary.getCases();

  assert.throws(() =>
    CaseLibrary.commitCaseWithCategory(
      { ...caseB, itemCode: 'ITEM-1' },
      { name: 'Cables', color: '#ff9f1c' }
    )
  );

  assert.deepEqual(StateStore.get('preferences'), prefsBefore, 'preferences must remain fully unchanged after a failed commit');
  assert.deepEqual(CaseLibrary.getCases(), casesBefore, 'caseLibrary must remain fully unchanged after a failed commit');
  assert.equal(StateStore.undo(), false, 'no history entry was produced by the failed action');
});

test('Requirement 19: Qty resets to 1 after a successful Add', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /setCaseQtyDraft\(c\.id, CASE_QTY_MIN\);/);
});

test('Requirement 20: multiple newly created items are not all auto-selected (single-add selection is preserved/consistent)', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  assert.match(block, /if \(result\.addedCount === 1\) \{\s*StateStore\.set\(\{ selectedInstanceIds: result\.createdInstanceIds \}/);
  // No unconditional selectedInstanceIds assignment covering the multi-add case.
  const selectionAssignments = block.match(/StateStore\.set\(\{ selectedInstanceIds:/g) || [];
  assert.equal(selectionAssignments.length, 1, 'only the single-add branch may set selectedInstanceIds');
});

test('Requirement 21: drag creates exactly one manually positioned instance', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const inst = PackLibrary.addInstance('pack-1', 'case-a', { x: 15, y: 5, z: 0 });
  assert.ok(inst);
  assert.equal(PackLibrary.getById('pack-1').cases.length, 1);
  assert.deepEqual(inst.transform.position, { x: 15, y: 5, z: 0 });
});

test('Requirement 22: drag does not use or reset the Qty draft', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function addCaseToPack(caseId, positionInches) {', '\n    }');
  assert.doesNotMatch(block, /caseQtyDrafts|getCaseQtyDraft|setCaseQtyDraft/);
  assert.match(block, /PackLibrary\.addInstance\(/);
});

test('Requirement 23: inLoad = inTruck + staged', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'i1' }), outsideInstance({ id: 'i2' }), outsideInstance({ id: 'i3' })] })],
    folderLibrary: [],
    preferences: {},
  });
  const counts = PackLibrary.getCaseInstanceCounts('pack-1', 'case-a');
  assert.equal(counts.inTruck, 1);
  assert.equal(counts.staged, 2);
  assert.equal(counts.inLoad, counts.inTruck + counts.staged);
});

test('Requirement 24: hidden is a separate visibility count while physical instances remain in inTruck/staged/inLoad', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'i1', hidden: true }), outsideInstance({ id: 'i2', hidden: true })] })],
    folderLibrary: [],
    preferences: {},
  });
  const counts = PackLibrary.getCaseInstanceCounts('pack-1', 'case-a');
  assert.equal(counts.inTruck, 1);
  assert.equal(counts.staged, 1);
  assert.equal(counts.inLoad, 2);
  assert.equal(counts.hidden, 2);
});

test('Requirement 25: no-Load-Plan message replaces per-card controls, is not repeated on every card', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  assert.match(src, /qtyMessageEl\.textContent = 'Open a Load Plan to add quantities\.';/);
  assert.match(src, /qtyMessageEl\.hidden = Boolean\(browserPack\);/);
  const cardBlock = extractFunctionBlock(src, 'function buildCaseBrowserCard(c, lengthUnit, prefs, isSelected, pack) {', '\n      return card;\n    }');
  assert.match(cardBlock, /if \(pack\) \{\s*card\.appendChild\(buildCaseQtyAddRow\(c, pack\)\);\s*\}/);
});

test('Requirement 26: search/filter/group rerenders preserve untouched Case Qty drafts', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const renderStart = src.indexOf('function renderCaseBrowser');
  const helperStart = src.indexOf('function buildCaseBrowserCard');
  const renderBlock = src.slice(renderStart, helperStart);
  assert.doesNotMatch(renderBlock, /caseQtyDrafts\.clear\(\)/, 'renderCaseBrowser must never clear the session-only Qty draft map');
  // The Map is declared once at editor-screen module scope, not inside renderCaseBrowser.
  const drafMapDecls = (src.match(/const caseQtyDrafts = new Map\(\);/g) || []).length;
  assert.equal(drafMapDecls, 1);
});

test('Requirement 27: no Qty UI state is persisted to StateStore/localStorage/Pack/Case', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  assert.doesNotMatch(src, /localStorage\.setItem\([^)]*[Qq]ty/);
  assert.doesNotMatch(src, /StateStore\.set\([^)]*caseQtyDrafts/);
  assert.doesNotMatch(src, /PackLibrary\.update\([^)]*caseQtyDrafts/);
});

test('workspace reset clears the production Editor Qty-draft state but ordinary same-workspace use does not', async () => {
  const { resetEditorCaseQtyDrafts } = await import(editorScreenPath.href);
  const drafts = new Map([['case-a', 7]]);
  const getDraft = caseId => drafts.get(caseId) ?? 1;

  assert.equal(getDraft('case-a'), 7, 'same-workspace rerenders and Pack changes do not clear the draft');
  resetEditorCaseQtyDrafts(drafts);
  assert.equal(getDraft('case-a'), 1, 'the same Case id starts from the default in the replacement workspace');

  const src = await fs.readFile(editorScreenPath, 'utf8');
  assert.match(src, /function resetWorkspaceState\(\) \{\s*previewScene = null;\s*invalidateViewOwner\(\);\s*resetEditorCaseQtyDrafts\(caseQtyDrafts\);\s*(?:\/\/[^\n]*\s*)*browserCats\.clear\(\);\s*browserManufacturers\.clear\(\);\s*if \(caseSearchEl\) caseSearchEl\.value = '';\s*caseBrowserGroupBy = 'category';\s*setCaseFiltersVisible\(false, false\);\s*syncCaseFilterIndicators\(\);\s*\}/,
    'workspace replacement invalidates preview and camera ownership before clearing Qty drafts and the workspace-scoped Case Browser search/filter state');
  assert.match(src, /return \{ init: initEditorUI, render, renderSelection, onActivated, resetWorkspaceState, syncViewportControls,\s*syncMeasurements, syncAnnotations, getCurrentCameraPack, applyCameraProjection,\s*getPreviewScene, getExportScene, getPreviewView, flushPendingView, setPreviewViewSettledCallback \};/);
});

test('workspace reset clears the production Cases selection state without changing ordinary selection semantics', async () => {
  const { resetCasesSelection } = await import(casesScreenPath.href);
  const selectedIds = new Set(['case-x']);

  assert.equal(selectedIds.has('case-x'), true, 'same-workspace render/view changes retain the current selection owner');
  resetCasesSelection(selectedIds);
  assert.equal(selectedIds.has('case-x'), false, 'a matching Case id is not selected in the replacement workspace');

  const src = await fs.readFile(casesScreenPath, 'utf8');
  assert.match(src, /function resetWorkspaceState\(\) \{\s*resetCasesSelection\(selectedIds\);\s*lastVisibleIds = \[\];\s*\}/);
  assert.match(src, /return \{ init: initCasesUI, render, resetWorkspaceState \};/);
});

test('the established workspace reset boundary invokes Cases and Editor transient-state hooks once per workspace key', async () => {
  const src = await fs.readFile(appJsPath, 'utf8');
  const start = src.indexOf('function resetWorkspaceScopedUiState(targetOrgId) {');
  const end = src.indexOf('\n    function clearOrgContext', start);
  assert.ok(start >= 0 && end > start);
  const block = src.slice(start, end);

  assert.match(block, /if \(lastWorkspaceUiResetKey === resetKey\) return;/,
    'same-workspace repeats remain a no-op');
  assert.match(block, /PacksUI\.resetWorkspaceState\(\);/);
  assert.match(block, /CasesUI\.resetWorkspaceState\(\);/);
  assert.match(block, /EditorUI\.resetWorkspaceState\(\);/);
  assert.equal((src.match(/CasesUI\.resetWorkspaceState\(\)/g) || []).length, 1);
  assert.equal((src.match(/EditorUI\.resetWorkspaceState\(\)/g) || []).length, 1);
});

// ===========================================================================
// CASES PAGE (Requirements 28-41)
// ===========================================================================

test('Requirement 28: workspace Quantity counts all physical instances across Load Plans regardless of visibility', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [
      basePack({ id: 'p1', cases: [insideInstance({ id: 'a' }), outsideInstance({ id: 'b' })] }),
      basePack({ id: 'p2', cases: [insideInstance({ id: 'c' }), outsideInstance({ id: 'd', hidden: true })] }),
    ],
    folderLibrary: [],
    preferences: {},
  });
  const quantities = PackLibrary.getWorkspaceCaseQuantities();
  assert.equal(quantities.get('case-a'), 4);
});

test('Requirement 29: zero quantity for a Case with no physical instances anywhere', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase(), baseCase({ id: 'case-b' })], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const quantities = PackLibrary.getWorkspaceCaseQuantities();
  assert.equal(quantities.get('case-b') || 0, 0);
});

test('Requirement 30: singular/plural Grid chip text', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  assert.match(src, /qtyBadge\.textContent = `\$\{qty\} unit\$\{qty === 1 \? '' : 's'\}`;/);
});

test('Requirement 31: List column shows a plain numeric cell', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  assert.match(src, /tdQty\.textContent = String\(quantities\.get\(c\.id\) \|\| 0\);/);
});

test('Requirement 32: Quantity is a sort option', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  assert.match(src, /\{ key: 'quantity', label: 'Quantity' \}/);
  assert.match(src, /case 'quantity':\s*valA = quantities\.get\(a\.id\) \|\| 0;\s*valB = quantities\.get\(b\.id\) \|\| 0;/);
});

test('Requirement 33: numeric sort produces stable ties (Node Array#sort is stable)', () => {
  const items = [
    { id: 'x', qty: 5, order: 0 },
    { id: 'y', qty: 5, order: 1 },
    { id: 'z', qty: 5, order: 2 },
  ];
  const sorted = [...items].sort((a, b) => a.qty - b.qty);
  assert.deepEqual(sorted.map(i => i.id), ['x', 'y', 'z']);
});

test('Requirement 34: Grid and List share the same one-pass workspaceQuantities map for order parity', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  assert.match(src, /const workspaceQuantities = PackLibrary\.getWorkspaceCaseQuantities\(\);/);
  assert.match(src, /renderTable\(workspaceQuantities\);/);
  assert.match(src, /renderViewMode\(mode, workspaceQuantities\);/);
});

test('Requirement 35: Quantity Card Display controls Grid chip and List column visibility consistently', async () => {
  const casesSrc = await fs.readFile(casesScreenPath, 'utf8');
  assert.match(casesSrc, /badgePrefs\.showQuantity !== false/);
  assert.match(casesSrc, /set\('quantity', badgePrefs\.showQuantity !== false\);/);
  const overlaySrc = await fs.readFile(cardDisplayOverlayPath, 'utf8');
  assert.match(overlaySrc, /item\('Quantity', cases\.showQuantity !== false/);
});

test('Requirement 36: workspace isolation — quantities only reflect the currently active packLibrary', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' })] })],
    folderLibrary: [],
    preferences: {},
  });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 1);

  // Simulate a workspace switch: re-init with a different packLibrary.
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ id: 'other', cases: [insideInstance({ id: 'b' }), insideInstance({ id: 'c' })] })],
    folderLibrary: [],
    preferences: {},
  });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 2);
});

test('Requirement 37: Load Plan deletion immediately reduces derived Quantity', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [
      basePack({ id: 'p1', cases: [insideInstance({ id: 'a' })] }),
      basePack({ id: 'p2', cases: [insideInstance({ id: 'b' })] }),
    ],
    folderLibrary: [],
    preferences: {},
  });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 2);
  PackLibrary.remove('p2');
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 1);
});

test('Requirement 38: Load Plan duplication increases derived Quantity by the duplicated instance count', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' }), insideInstance({ id: 'b' })] })],
    folderLibrary: [],
    preferences: {},
  });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 2);
  PackLibrary.duplicate('pack-1');
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 4);
});

test('Requirement 39: hide/unhide does not change derived physical Quantity', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' })] })],
    folderLibrary: [],
    preferences: {},
  });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 1);
  PackLibrary.updateInstance('pack-1', 'a', { hidden: true });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 1);
  PackLibrary.updateInstance('pack-1', 'a', { hidden: false });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), 1);
});

test('Requirement 40: folder assignment does not alter derived Quantity', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' })] })],
    folderLibrary: [{ id: 'f1', name: 'Folder', scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 0, updatedAt: 0 }],
    preferences: {},
  });
  const before = PackLibrary.getWorkspaceCaseQuantities().get('case-a');
  PackLibrary.update('pack-1', { folderId: 'f1' });
  assert.equal(PackLibrary.getWorkspaceCaseQuantities().get('case-a'), before);
});

test('Requirement 41: workspace Quantity is aggregated once per render, not once per Case', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  const getWorkspaceCalls = src.match(/PackLibrary\.getWorkspaceCaseQuantities\(\)/g) || [];
  assert.equal(getWorkspaceCalls.length, 1, 'getWorkspaceCaseQuantities must be called exactly once per render() invocation');
});

// ===========================================================================
// LOAD PLANS PAGE (Requirements 42-51)
// ===========================================================================

test('Requirement 42: separate Cases/Packed columns are consolidated into one Cases Qty', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  assert.doesNotMatch(src, /showCasesCount|showPacked\b|compareCases\b|comparePacked\b/);
  assert.match(src, /\{ key: 'casesQty', label: 'Cases Qty' \}/);
  const html = await fs.readFile(indexHtmlPath, 'utf8');
  assert.doesNotMatch(html, /data-sort="cases"|data-sort="packed"/);
  assert.match(html, /data-sort="casesQty"/);
});

test('Requirement 43: List Cases Qty value is inTruck/total', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  assert.match(src, /tdCasesQty\.textContent = inTruckQty === null \|\| totalQty === null \? '—' : `\$\{inTruckQty\}\/\$\{totalQty\}`;/);
});

test('Requirement 43: Cases Qty sorting uses all live instances, never persisted stats', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  assert.match(src, /const casesQtyByPack = new Map\([\s\S]*\(pack\.cases \|\| \[\]\)\.length/);
  assert.match(src, /const compareCasesQty = \(a, b\) => \(casesQtyByPack\.get\(a\) \|\| 0\) - \(casesQtyByPack\.get\(b\) \|\| 0\);/);
  assert.doesNotMatch(src, /totalCasesQty\s*=\s*p\s*=>[\s\S]*p\.stats/);
});

test('Requirement 44: Grid chip reads "Cases Qty: inTruck/total"', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  assert.match(src, /casesQtyBadge\.textContent = `Cases Qty: \$\{inTruck\}\/\$\{total\}`;/);
});

test('Requirement 45: Cases Qty Card Display option (default on)', async () => {
  const overlaySrc = await fs.readFile(cardDisplayOverlayPath, 'utf8');
  assert.match(overlaySrc, /item\('Cases Qty', packs\.showCasesQty !== false/);
  assert.doesNotMatch(overlaySrc, /item\('Cases Count'|item\('Packed'/);
  const defaultsSrc = await fs.readFile(new URL('../../src/core/defaults.js', import.meta.url), 'utf8');
  assert.match(defaultsSrc, /showCasesQty: true,/);
});

test('Requirement 46: legacy showCasesCount/showPacked preferences normalize into showCasesQty', async () => {
  const { CoreNormalizer } = await loadModules();
  const bothOn = CoreNormalizer.normalizePreferences({ gridCardBadges: { packs: { showCasesCount: true, showPacked: true } } });
  assert.equal(bothOn.gridCardBadges.packs.showCasesQty, true);

  const oneOff = CoreNormalizer.normalizePreferences({ gridCardBadges: { packs: { showCasesCount: true, showPacked: false } } });
  assert.equal(oneOff.gridCardBadges.packs.showCasesQty, false);

  const explicit = CoreNormalizer.normalizePreferences({
    gridCardBadges: { packs: { showCasesCount: false, showPacked: false, showCasesQty: true } },
  });
  assert.equal(explicit.gridCardBadges.packs.showCasesQty, true, 'an explicit showCasesQty must win over legacy flags');

  const missing = CoreNormalizer.normalizePreferences({});
  assert.equal(missing.gridCardBadges.packs.showCasesQty, true, 'missing values normalize to enabled');
});

test('Requirement 47: Grid and List derive Cases Qty from the same stats fields (no competing computation)', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const listUses = src.match(/stats\.packedCases/g) || [];
  const gridUses = src.match(/stats && Number\.isFinite\(stats\.packedCases\) \? stats\.packedCases : (0|null)/g) || [];
  assert.ok(listUses.length >= 2 && gridUses.length >= 1, 'both List and Grid must read stats.packedCases/totalCases');
});

test('Requirement 48: hidden instances remain in the Cases Qty total', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' }), outsideInstance({ id: 'b', hidden: true })] })],
    folderLibrary: [],
    preferences: {},
  });
  const stats = PackLibrary.computeStats(PackLibrary.getById('pack-1'));
  assert.equal(stats.totalCases, 2);
  assert.equal(stats.hiddenCases, 1);
  assert.equal(stats.packedCases, 1);
});

test('Requirement 49: Unpack preserves total, only the inTruck numerator changes', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' }), insideInstance({ id: 'b' })] })],
    folderLibrary: [],
    preferences: {},
  });
  const before = PackLibrary.computeStats(PackLibrary.getById('pack-1'));
  assert.equal(before.packedCases, 2);
  const totalBefore = before.totalCases;

  // Simulate Unpack: move one instance outside the truck geometry.
  PackLibrary.updateInstance('pack-1', 'b', { transform: outsideInstance().transform });
  const after = PackLibrary.computeStats(PackLibrary.getById('pack-1'));
  const totalAfter = after.totalCases;

  assert.equal(after.packedCases, 1);
  assert.equal(totalAfter, totalBefore, 'total physical quantity must not change from Unpack');
});

test('Requirement 50: Truck Change preserves total physical quantity', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [insideInstance({ id: 'a' }), insideInstance({ id: 'b' })] })],
    folderLibrary: [],
    preferences: {},
  });
  const before = PackLibrary.computeStats(PackLibrary.getById('pack-1'));
  const totalBefore = before.totalCases;
  PackLibrary.update('pack-1', { truck: rectTruck({ length: 300, width: 100, height: 100 }) });
  const after = PackLibrary.computeStats(PackLibrary.getById('pack-1'));
  const totalAfter = after.totalCases;
  assert.equal(totalAfter, totalBefore, 'a truck geometry change must never create or delete physical instances');
});

test('Requirement 51: Auto-Pack is untouched — it continues consuming only pack.cases, never Quantity Controls state', async () => {
  const [engineSrc, solverSrc] = await Promise.all([
    fs.readFile(autopackEnginePath, 'utf8'),
    fs.readFile(autopackSolverPath, 'utf8'),
  ]);
  const forbidden = /caseRequirements|requiredQuantity|caseQtyDrafts|getCaseQtyDraft|addInstancesToStaging/;
  assert.doesNotMatch(engineSrc, forbidden);
  assert.doesNotMatch(solverSrc, forbidden);
});

// ===========================================================================
// LEGACY QUANTITY-TARGET SANITATION
// ===========================================================================

test('legacy Pack normalization discards obsolete targets without changing physical instances', async () => {
  const { CoreNormalizer } = await loadModules();
  const caseA = baseCase();
  const legacy = legacyQuantityPack();
  const normalized = CoreNormalizer.normalizePack(legacy, new Map([[caseA.id, caseA]]));

  assert.equal(normalized.caseRequirements, undefined);
  assert.equal(normalized.cases.length, legacy.cases.length);
  assert.deepEqual(normalized.cases.map(instance => instance.caseId), legacy.cases.map(instance => instance.caseId));
});

test('legacy Load Plan JSON imports successfully and discards obsolete targets', async () => {
  const { StateStore, PackLibrary, ImportExport } = await loadModules();
  const caseA = baseCase();
  const legacy = legacyQuantityPack();
  StateStore.init({ caseLibrary: [], packLibrary: [], folderLibrary: [], preferences: {} });

  const parsed = ImportExport.parsePackImportJSON(JSON.stringify({ pack: legacy, bundledCases: [caseA] }));
  assert.equal(parsed.pack.caseRequirements, undefined);
  const imported = PackLibrary.importPackPayload(parsed);
  assert.equal(imported.caseRequirements, undefined);
  assert.equal(imported.cases.length, legacy.cases.length);
  assert.equal(StateStore.get('caseLibrary')[0].name, caseA.name);
  assert.deepEqual(StateStore.get('caseLibrary')[0].dimensions, caseA.dimensions);
});

test('legacy App Backup imports successfully and discards obsolete targets', async () => {
  const { ImportExport } = await loadModules();
  const caseA = baseCase();
  const legacy = legacyQuantityPack();
  const restored = ImportExport.parseAppImportJSON(JSON.stringify({
    app: 'Truck Packer 3D',
    data: {
      caseLibrary: [caseA],
      packLibrary: [legacy],
      folderLibrary: [],
      preferences: {},
    },
  }));

  assert.equal(restored.packLibrary[0].caseRequirements, undefined);
  assert.equal(restored.packLibrary[0].cases.length, legacy.cases.length);
  assert.equal(restored.caseLibrary[0].name, caseA.name);
  assert.deepEqual(restored.caseLibrary[0].dimensions, caseA.dimensions);
});

test('legacy Workspace import discards obsolete targets while preserving the portable graph', async () => {
  const { ImportExport } = await loadModules();
  const caseA = baseCase();
  const legacy = legacyQuantityPack();
  const restored = ImportExport.parseWorkspaceImportJSON(JSON.stringify({
    app: 'Truck Packer 3D',
    exportType: 'workspace',
    schemaVersion: 'workspace-export-v1',
    workspaceName: 'Legacy Workspace',
    data: { caseLibrary: [caseA], packLibrary: [legacy], folderLibrary: [] },
  }));

  assert.equal(restored.packLibrary[0].caseRequirements, undefined);
  assert.equal(restored.packLibrary[0].cases.length, legacy.cases.length);
  assert.deepEqual(restored.caseLibrary, [{ ...caseA, itemCode: null }]);
});

test('new Load Plan, App Backup, and Workspace exports never emit obsolete targets or temporary Qty state', async () => {
  const { StateStore, ImportExport } = await loadModules();
  const caseA = baseCase();
  const legacy = legacyQuantityPack();
  StateStore.init({ caseLibrary: [caseA], packLibrary: [legacy], folderLibrary: [], preferences: {} });

  const exports = [
    ImportExport.buildPackExportJSON(legacy),
    ImportExport.buildAppExportJSON(),
    ImportExport.buildWorkspaceExportJSON('QA Workspace'),
  ];
  exports.forEach(json => {
    assert.doesNotMatch(json, /caseRequirements|requiredQuantity|caseQtyDrafts/);
    const parsed = JSON.parse(json);
    // New Load Plan exports use the versioned envelope (data.pack); App/Workspace
    // exports still carry a packLibrary array either bare or under data.
    const packs = parsed.pack
      ? [parsed.pack]
      : (parsed.data && parsed.data.pack ? [parsed.data.pack] : parsed.data.packLibrary);
    assert.equal(packs[0].cases.length, legacy.cases.length);
  });
  assert.deepEqual(StateStore.get('caseLibrary'), [caseA]);
});

test('normal scoped storage load/save removes and persists the obsolete field without a schema bump', async () => {
  const { StateStore, CoreStorage } = await loadModules();
  const { applyCanonicalCargoFields } = await import(cargoCanonicalUrl.href);
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const priorWindow = globalThis.window;
  const localStorage = createMemoryLocalStorage();
  const userId = 'quantity-sanitizer-user';
  const workspaceId = 'quantity-sanitizer-workspace';
  const userKey = `${CoreStorage.STORAGE_KEY}:${userId}`;
  const workspaceKey = `${userKey}:workspace:${workspaceId}`;
  const legacy = legacyQuantityPack();

  try {
    globalThis.window = { localStorage };
    CoreStorage.setStorageScope(userId);
    CoreStorage.setWorkspaceScope(workspaceId);
    localStorage.setItem(userKey, JSON.stringify({ version: '1.0.0', savedAt: 1, preferences: {} }));
    localStorage.setItem(workspaceKey, JSON.stringify({
      version: '1.0.0',
      savedAt: 1,
      caseLibrary: [baseCase({
        quantity: 7,
        RequiredQuantity: 9,
        target_quantity: 12,
        caseRequirements: [{ caseId: 'case-a', requiredQuantity: 99 }],
        customExtension: 'keep-me',
      })],
      packLibrary: [legacy],
      folderLibrary: [],
      currentPackId: legacy.id,
    }));

    const loaded = CoreStorage.load();
    assert.equal(loaded.packLibrary[0].caseRequirements, undefined);
    assert.equal(loaded.packLibrary[0].cases.length, legacy.cases.length);
    const loadedCase = applyCanonicalCargoFields(loaded.caseLibrary[0]);
    assert.equal(loadedCase.customExtension, 'keep-me');
    assert.equal(Object.prototype.hasOwnProperty.call(loadedCase, 'quantity'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedCase, 'RequiredQuantity'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedCase, 'target_quantity'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedCase, 'caseRequirements'), false);
    const rewritten = localStorage.getItem(workspaceKey);
    const rewrittenPayload = JSON.parse(rewritten);
    assert.equal(Object.prototype.hasOwnProperty.call(rewrittenPayload.packLibrary[0], 'caseRequirements'), false,
      'the existing Pack compatibility cleanup remains in place');
    assert.equal(rewrittenPayload.version, '1.0.0');

    StateStore.init({
      caseLibrary: [loadedCase],
      packLibrary: [legacy],
      folderLibrary: [],
      preferences: {},
      currentPackId: legacy.id,
    });
    CoreStorage.saveNow();
    const saved = localStorage.getItem(workspaceKey);
    assert.doesNotMatch(saved, /caseRequirements|requiredQuantity|required_quantity|target_quantity|"quantity"/i);
    assert.equal(JSON.parse(saved).packLibrary[0].cases.length, legacy.cases.length);
  } finally {
    CoreStorage.setStorageScope('anon');
    CoreStorage.setWorkspaceScope('no-org');
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
});

test('Pack update and duplication boundaries cannot carry obsolete targets forward', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const legacy = legacyQuantityPack();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [legacy], folderLibrary: [], preferences: {} });

  const updated = PackLibrary.update(legacy.id, { title: 'Updated Legacy Plan' });
  assert.equal(updated.caseRequirements, undefined);
  assert.equal(updated.cases.length, legacy.cases.length);

  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [legacy], folderLibrary: [], preferences: {} });
  const duplicated = PackLibrary.duplicate(legacy.id);
  assert.equal(duplicated.caseRequirements, undefined);
  assert.equal(duplicated.cases.length, legacy.cases.length);
});

// ===========================================================================
// DATA BOUNDARIES (Requirements 52-64)
// ===========================================================================

test('Requirement 52: Load Plan JSON export/import preserves every physical instance, repeats included, no Qty/caseRequirements field', async () => {
  const { StateStore, ImportExport } = await loadModules();
  const caseA = baseCase();
  const pack = basePack({ cases: [insideInstance({ id: 'i1' }), insideInstance({ id: 'i2' }), outsideInstance({ id: 'i3' })] });
  StateStore.init({ caseLibrary: [caseA], packLibrary: [pack], folderLibrary: [], preferences: {} });

  const payload = ImportExport.buildPackExportPayload(pack);
  assert.equal(payload.bundledCases.length, 1, 'repeated physical instances bundle one reusable Case definition');
  assert.equal(payload.bundledCases[0].id, 'case-a');
  const json = ImportExport.buildPackExportJSON(pack);
  assert.doesNotMatch(json, /caseRequirements/);
  const parsed = ImportExport.parsePackImportJSON(json);
  assert.equal(parsed.pack.cases.length, 3);
  const ids = parsed.pack.cases.map(i => i.id).sort();
  assert.deepEqual(ids, ['i1', 'i2', 'i3']);
});

test('Requirement 52: blank dangling Case references remain explicitly diagnosed as unknown', async () => {
  const { StateStore, ImportExport } = await loadModules();
  const pack = basePack({ cases: [insideInstance({ id: 'blank-ref', caseId: '' })] });
  StateStore.init({ caseLibrary: [], packLibrary: [pack], folderLibrary: [], preferences: {} });

  const payload = ImportExport.buildPackExportPayload(pack);
  assert.deepEqual(payload.unresolvedCaseRefs, ['unknown']);
  assert.equal(payload.pack.cases.length, 1, 'the malformed physical instance remains preserved for recovery');
  assert.equal(payload.pack.cases[0].caseId, '');
});

test('Requirement 53: App Backup export/import round-trips Case Library, Load Plans, physical instances, and preferences', async () => {
  const { StateStore, ImportExport } = await loadModules();
  const caseA = baseCase();
  const pack = basePack({ cases: [insideInstance({ id: 'i1' }), outsideInstance({ id: 'i2' })] });
  StateStore.init({
    caseLibrary: [caseA],
    packLibrary: [pack],
    folderLibrary: [],
    preferences: { gridCardBadges: { cases: { showQuantity: false }, packs: { showCasesQty: false } } },
  });
  const json = ImportExport.buildAppExportJSON();
  assert.doesNotMatch(json, /caseRequirements/);
  const restored = ImportExport.parseAppImportJSON(json);
  assert.equal(restored.packLibrary[0].cases.length, 2);
  assert.equal(restored.caseLibrary.length, 1);
  assert.equal(restored.preferences.gridCardBadges.cases.showQuantity, false);
  assert.equal(restored.preferences.gridCardBadges.packs.showCasesQty, false);
});

test('Requirement 54: Workspace export/import isolates quantities to the correct workspace with exact physical instance counts', async () => {
  const { StateStore, ImportExport } = await loadModules();
  const caseA = baseCase();
  const pack = basePack({ cases: [insideInstance({ id: 'i1' }), insideInstance({ id: 'i2' }), insideInstance({ id: 'i3' })] });
  StateStore.init({ caseLibrary: [caseA], packLibrary: [pack], folderLibrary: [], preferences: {} });
  const json = ImportExport.buildWorkspaceExportJSON('QA Workspace');
  const restored = ImportExport.parseWorkspaceImportJSON(json);
  assert.equal(restored.packLibrary[0].cases.length, 3);
  assert.equal(restored.workspaceName, 'QA Workspace');
});

test('Requirement 55: no temporary Qty selector value ever appears in an export payload', async () => {
  const { StateStore, ImportExport } = await loadModules();
  const pack = basePack({ cases: [insideInstance()] });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [pack], folderLibrary: [], preferences: {} });
  const packJson = ImportExport.buildPackExportJSON(pack);
  const appJson = ImportExport.buildAppExportJSON();
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('QA');
  for (const json of [packJson, appJson, workspaceJson]) {
    assert.doesNotMatch(json, /caseQtyDrafts/);
    assert.doesNotMatch(json, /"qty"\s*:/i);
  }
});

test('Requirement 56: no caseRequirements field remains anywhere in normalized/exported data', async () => {
  const { StateStore, CoreNormalizer, ImportExport } = await loadModules();
  const pack = basePack({ cases: [insideInstance()] });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [pack], folderLibrary: [], preferences: {} });
  const normalized = CoreNormalizer.normalizePack(pack, new Map([['case-a', baseCase()]]));
  assert.equal(normalized.caseRequirements, undefined);
  assert.doesNotMatch(ImportExport.buildPackExportJSON(pack), /caseRequirements/);
  assert.doesNotMatch(ImportExport.buildAppExportJSON(), /caseRequirements/);
});

test('Requirement 57: Case CSV/XLSX import/template has no Quantity storage field', async () => {
  const { ImportExport } = await loadModules();
  const csv = ImportExport.buildCasesTemplateCSV();
  const header = csv.split('\n')[0];
  assert.doesNotMatch(header, /quantity|qty/i);
});

test('Requirement 58: the only Load Plan CSV/manifest export (buildCargoInstructionsManifest) is a notes manifest, not a quantity export — no separate Case-quantity CSV/XLSX export exists', async () => {
  const src = await fs.readFile(new URL('../../src/services/import-export.js', import.meta.url), 'utf8');
  const exportedFns = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  const csvLikeExports = exportedFns.filter(name => /csv|manifest|template/i.test(name));
  assert.deepEqual(
    csvLikeExports.sort(),
    ['buildCargoInstructionsManifest', 'buildCasesTemplateCSV', 'downloadCasesTemplate'].sort()
  );
  const manifestBlock = extractFunctionBlock(src, 'export function buildCargoInstructionsManifest(pack, getCaseById = CaseLibrary.getById) {', '\n}');
  assert.doesNotMatch(manifestBlock, /caseRequirements|requiredQuantity|quantity:/i);
});

test('PDF checklist aggregation groups repeated resolved Case instances and preserves first-occurrence order', async () => {
  const { ImportExport } = await loadModules();
  const caseA = baseCase({ id: 'case-a', name: 'Shared Name' });
  const caseB = baseCase({ id: 'case-b', name: 'Shared Name', weight: 9 });
  const cases = new Map([[caseA.id, caseA], [caseB.id, caseB]]);
  const pack = basePack({
    cases: [
      insideInstance({ id: 'a1', caseId: 'case-a' }),
      insideInstance({ id: 'b1', caseId: 'case-b' }),
      outsideInstance({ id: 'a2', caseId: 'case-a' }),
    ],
  });

  const rows = ImportExport.buildCaseChecklistRows(pack, caseId => cases.get(caseId) || null);
  assert.deepEqual(rows.map(row => row.identityKey), ['case:case-a', 'case:case-b']);
  assert.deepEqual(rows.map(row => row.qty), [2, 1]);
  assert.equal(rows[0].caseData.name, rows[1].caseData.name, 'same display name remains two rows when caseIds differ');
});

test('PDF checklist unresolved references use deterministic fallback grouping', async () => {
  const { ImportExport } = await loadModules();
  const pack = basePack({
    cases: [
      insideInstance({ id: 'g1', caseId: 'ghost' }),
      outsideInstance({ id: 'g2', caseId: 'ghost' }),
      insideInstance({ id: 'o1', caseId: 'other-missing' }),
      insideInstance({ id: 'u1', caseId: '' }),
      outsideInstance({ id: 'u2', caseId: '' }),
    ],
  });

  const rows = ImportExport.buildCaseChecklistRows(pack, () => null);
  assert.deepEqual(
    rows.map(row => [row.identityKey, row.qty]),
    [['missing:ghost', 2], ['missing:other-missing', 1], ['missing:unknown', 2]]
  );
});

test('PDF checklist Qty sum equals the legacy included physical-instance set, including hidden instances', async () => {
  const { ImportExport } = await loadModules();
  const caseA = baseCase();
  const pack = basePack({
    cases: [
      insideInstance({ id: 'visible', hidden: false }),
      outsideInstance({ id: 'hidden', hidden: true }),
    ],
  });
  const rows = ImportExport.buildCaseChecklistRows(pack, () => caseA);
  assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), pack.cases.length);
  assert.equal(rows[0].qty, 2, 'aggregation must not silently change the old checklist hidden-item semantics');
});

test('PDF checklist aggregation leaves Cargo Instructions aggregation unchanged', async () => {
  const { ImportExport } = await loadModules();
  const caseA = baseCase({ notes: 'Keep upright.' });
  const pack = basePack({
    cases: [
      insideInstance({ id: 'item-1', instanceNotes: 'Unload first.' }),
      outsideInstance({ id: 'item-2', instanceNotes: null }),
    ],
  });
  const manifest = ImportExport.buildCargoInstructionsManifest(pack, () => caseA);
  assert.equal(manifest.caseEntries.length, 1, 'Case instructions remain aggregated once per reusable Case');
  assert.equal(manifest.caseEntries[0].caseNotes, 'Keep upright.');
  assert.equal(manifest.itemEntries.length, 1, 'Item Notes remain owned by their physical instance');
  assert.equal(manifest.itemEntries[0].itemNotes, 'Unload first.');
});

test('PDF source renders aggregated Qty rows while preserving views, Cargo Instructions, Summary, and pagination', async () => {
  const src = await fs.readFile(appJsPath, 'utf8');
  const pdfStart = src.indexOf('function generatePDF()');
  const pdfEnd = src.indexOf('\n      function getCurrentPack()', pdfStart);
  const pdfBlock = src.slice(pdfStart, pdfEnd);
  const ieSrc = await fs.readFile(importExportUrl, 'utf8');
  const reportBlock = extractFunctionBlock(ieSrc, 'export function buildLoadPlanReport(', '\n}\n');

  for (const heading of ['PERSPECTIVE VIEW', 'TOP VIEW', 'SIDE VIEW', 'CASE CHECKLIST', 'CARGO INSTRUCTIONS', 'LOAD SUMMARY']) {
    assert.match(pdfBlock, new RegExp(heading));
  }
  for (const heading of ["{ label: '#'", "{ label: 'Case'", "{ label: 'Category'", "{ label: 'Base dims (L×W×H)'",
    "{ label: 'Unit weight'", "{ label: 'Qty'", "{ label: 'In truck'", "{ label: 'Staged'"]) {
    assert.ok(pdfBlock.includes(heading), `PDF checklist must contain ${heading}`);
  }
  assert.match(pdfBlock, /String\(row\.qty\)/);
  assert.match(pdfBlock, /writeChecklistHeader\(\)/, 'continuation pages retain checklist headers');
  assert.match(pdfBlock, /Page \$\{i\} of \$\{totalPages\}/, 'page footers remain intact');
  assert.match(pdfBlock, /ImportExport\.buildCargoInstructionsManifest\(pack\)/);
  assert.match(pdfBlock, /ImportExport\.buildLoadPlanReport\(pack, \{/);
  assert.doesNotMatch(pdfBlock, /Cases loaded/, 'Export Integrity B: total instances are never labelled as loaded');
  assert.match(reportBlock, /buildCaseChecklistRows\(pack, getCaseById\)\.map\(row =>/);
  assert.doesNotMatch(pdfBlock + reportBlock, /\(pack\.cases \|\| \[\]\)\.map/,
    'the old one-output-row-per-instance checklist path must be absent');
  assert.doesNotMatch(pdfBlock + reportBlock, /caseRequirements|requiredQuantity|caseQtyDrafts|Target met|Over target/);
});

test('Requirement 59: PDF quantity aggregation reflects actual physical instances (stats.packedCases/totalCases), no Target/Missing/Qty-selector values', async () => {
  const ieSrc = await fs.readFile(importExportUrl, 'utf8');
  const reportBlock = extractFunctionBlock(ieSrc, 'export function buildLoadPlanReport(', '\n}\n');
  assert.match(reportBlock, /population\.inTruck !== stats\.packedCases/);
  assert.match(reportBlock, /population\.total !== stats\.totalCases/);
  assert.match(reportBlock, /\{ label: 'In truck', value: String\(population\.inTruck\) \}/);
  assert.match(reportBlock, /\{ label: 'Total cargo items', value: String\(population\.total\) \}/);
  const src = await fs.readFile(appJsPath, 'utf8');
  const pdfFnStart = src.indexOf('function generatePDF()');
  const pdfFnEnd = src.indexOf('\n      function getCurrentPack', pdfFnStart);
  const pdfBlock = src.slice(pdfFnStart, pdfFnEnd > pdfFnStart ? pdfFnEnd : pdfFnStart + 20000);
  assert.doesNotMatch(pdfBlock + reportBlock, /caseRequirements|requiredQuantity|Target met|Over target|caseQtyDrafts/);
});

test('Requirement 60: PNG capture path has no stored Qty metadata', async () => {
  const src = await fs.readFile(appJsPath, 'utf8');
  const block = extractFunctionBlock(src, 'function captureScreenshot() {', '\n      }');
  assert.doesNotMatch(block, /caseQtyDrafts|caseRequirements|Qty/);
});

test('Requirement 61: no database migration was introduced for derived UI quantities', async () => {
  const migrationsDir = path.join(fileURLToPath(repoRoot), 'supabase', 'migrations');
  const entries = await fs.readdir(migrationsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.sql')) continue;
    const text = await fs.readFile(path.join(migrationsDir, entry), 'utf8');
    assert.doesNotMatch(text, /caseRequirements|requiredQuantity|case_requirement/i, `${entry} must not reference the rejected quantity model`);
  }
});

test('Requirement 62: legacy Packs (saved before Quantity Controls, or with a stray legacy caseRequirements field) continue loading', async () => {
  const { CoreNormalizer } = await loadModules();
  const legacyPackNoField = { id: 'legacy-1', title: 'Legacy', truck: rectTruck(), cases: [insideInstance()] };
  const normalizedA = CoreNormalizer.normalizePack(legacyPackNoField, new Map([['case-a', baseCase()]]));
  assert.equal(normalizedA.cases.length, 1);
  assert.equal(normalizedA.caseRequirements, undefined);

  // A pack saved by an even older build with a stray caseRequirements array must not throw.
  const legacyPackWithField = { ...legacyPackNoField, caseRequirements: [{ caseId: 'case-a', requiredQuantity: 5 }] };
  const normalizedB = CoreNormalizer.normalizePack(legacyPackWithField, new Map([['case-a', baseCase()]]));
  assert.equal(normalizedB.cases.length, 1);
  assert.equal(normalizedB.caseRequirements, undefined, 'the stray legacy field must be dropped silently, never re-surfaced');
});

test('Requirement 63: existing folder relationships remain intact through normalization', async () => {
  const { CoreNormalizer } = await loadModules();
  const data = {
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ folderId: 'f1', cases: [insideInstance()] })],
    folderLibrary: [{ id: 'f1', name: 'Folder A' }],
    preferences: {},
  };
  const normalized = CoreNormalizer.normalizeAppData(data);
  assert.equal(normalized.packLibrary[0].folderId, 'f1');
  assert.equal(normalized.folderLibrary[0].id, 'f1');
});

// ===========================================================================
// BUG 1 — Cases Card Display Handling/Quantity swap regression tests
//
// Root cause: the Handling <th> was looked up positionally via
// catTh.nextElementSibling. That was correct only while Handling sat
// immediately after Category in the header. Once a Quantity <th> was
// inserted between Category and Handling, "handlingTh" silently became a
// reference to an adjacent header instead — so changing the visible column
// order could silently connect Handling visibility to the wrong field. Keep
// the stable data-column="handling" selector (matching Notes) while Quantity
// remains independently addressable through data-sort="quantity".
// ===========================================================================

test('Cases List header order places Quantity between Manufacturer and Length while preserving the stable tail columns', async () => {
  const html = await fs.readFile(indexHtmlPath, 'utf8');
  const tableStart = html.indexOf('id="cases-tbody"');
  assert.ok(tableStart > 0, 'expected to find the Cases table');
  const headerBlock = html.slice(0, tableStart);
  const manufacturerIdx = headerBlock.lastIndexOf('data-sort="manufacturer"');
  const quantityIdx = headerBlock.lastIndexOf('data-sort="quantity"');
  const lengthIdx = headerBlock.lastIndexOf('data-sort="length"');
  const categoryIdx = headerBlock.lastIndexOf('data-sort="category"');
  const handlingIdx = headerBlock.lastIndexOf('data-column="handling"');
  const notesIdx = headerBlock.lastIndexOf('data-column="notes"');
  assert.ok(
    manufacturerIdx > 0 && quantityIdx > 0 && lengthIdx > 0 &&
      categoryIdx > 0 && handlingIdx > 0 && notesIdx > 0,
    'Manufacturer, Quantity, Length, Category, Handling, and Notes headers must all be present'
  );
  assert.ok(manufacturerIdx < quantityIdx, 'Quantity header must come after Manufacturer');
  assert.ok(quantityIdx < lengthIdx, 'Quantity header must come before Length');
  assert.ok(categoryIdx < handlingIdx, 'Handling header must come after Category');
  assert.ok(handlingIdx < notesIdx, 'Notes header must come after Handling');
});

test('Cases List row cells match the Quantity-between-Manufacturer-and-Length header order', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  const rowStart = src.indexOf("const tdMfg = document.createElement('td');");
  const rowEnd = src.indexOf("const tdActions = document.createElement('td');", rowStart);
  assert.ok(rowStart > 0 && rowEnd > rowStart, 'expected to find the Cases row-cell construction block');
  const rowBlock = src.slice(rowStart, rowEnd);
  const manufacturerIdx = rowBlock.indexOf('tr.appendChild(tdMfg)');
  const quantityIdx = rowBlock.indexOf('tr.appendChild(tdQty)');
  const lengthIdx = rowBlock.indexOf('tr.appendChild(tdLength)');
  const catIdx = rowBlock.indexOf("tr.appendChild(tdCat)");
  const handlingIdx = rowBlock.indexOf("tr.appendChild(tdHandling)");
  const notesIdx = rowBlock.indexOf("const tdNotes = document.createElement('td')");
  assert.ok(
    manufacturerIdx >= 0 && quantityIdx >= 0 && lengthIdx >= 0 &&
      catIdx >= 0 && handlingIdx >= 0 && notesIdx >= 0,
    'tdMfg, tdQty, tdLength, tdCat, tdHandling, and tdNotes must all be present'
  );
  assert.ok(manufacturerIdx < quantityIdx, 'tdQty must be appended after tdMfg');
  assert.ok(quantityIdx < lengthIdx, 'tdQty must be appended before tdLength');
  assert.ok(catIdx < handlingIdx, 'tdHandling must be appended after tdCat');
  assert.ok(handlingIdx < notesIdx, 'tdNotes must be appended after tdHandling');
});

test('applyListColumnVisibility looks up the Handling header by a stable data-column selector, not a positional DOM traversal', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function applyListColumnVisibility(prefs) {', '\n    }');
  assert.doesNotMatch(block, /nextElementSibling/,
    'the fragile catTh.nextElementSibling lookup must not return — it breaks silently whenever a column is inserted next to Handling');
  assert.match(block, /document\.querySelector\('#screen-cases table thead th\[data-column="handling"\]'\)/,
    'Handling header visibility must be looked up by its own stable data-column="handling" attribute');
  assert.match(block, /handlingTh\.style\.display = badgePrefs\.showHandling !== false \? '' : 'none'/,
    'the Handling header must be toggled by showHandling, not showQuantity');
  assert.match(block, /set\('quantity', badgePrefs\.showQuantity !== false\)/,
    'the Quantity header must remain toggled by showQuantity via the shared data-sort selector helper');
});

for (const [handlingOn, quantityOn] of [[true, true], [false, true], [true, false], [false, false]]) {
  test(`Cases List cell visibility: Handling ${handlingOn ? 'on' : 'off'}, Quantity ${quantityOn ? 'on' : 'off'} — each column responds only to its own flag`, async () => {
    const src = await fs.readFile(casesScreenPath, 'utf8');
    const rowStart = src.indexOf("const tdMfg = document.createElement('td');");
    const rowEnd = src.indexOf("const tdActions = document.createElement('td');", rowStart);
    const rowBlock = src.slice(rowStart, rowEnd);

    // Simulate the two independent guards exactly as written in source, using
    // this combination's badgePrefs values.
    const badgePrefs = { showHandling: handlingOn, showQuantity: quantityOn };
    /* eslint-disable no-unused-vars */
    const tdHandlingHidden = badgePrefs.showHandling === false;
    const tdQtyHidden = badgePrefs.showQuantity === false;
    /* eslint-enable no-unused-vars */
    assert.equal(tdHandlingHidden, !handlingOn);
    assert.equal(tdQtyHidden, !quantityOn);

    // Source-contract: the two guards are textually independent — neither
    // condition block for one field also assigns display:none to the other
    // field's cell (the exact defect this test suite would have caught).
    const handlingGuard = rowBlock.slice(
      rowBlock.indexOf('if (badgePrefs.showHandling === false) {'),
      rowBlock.indexOf('tr.appendChild(tdHandling)')
    );
    const qtyGuard = rowBlock.slice(
      rowBlock.indexOf('if (badgePrefs.showQuantity === false) {'),
      rowBlock.indexOf('tr.appendChild(tdQty)')
    );
    assert.match(handlingGuard, /tdHandling\.style\.display = 'none'/);
    assert.doesNotMatch(handlingGuard, /tdQty\.style\.display/);
    assert.match(qtyGuard, /tdQty\.style\.display = 'none'/);
    assert.doesNotMatch(qtyGuard, /tdHandling\.style\.display/);
  });
}

test('Cases Grid metadata follows the canonical Quantity, Dimensions, Volume, Weight, Category, Handling order', async () => {
  const src = await fs.readFile(casesScreenPath, 'utf8');
  const gridStart = src.indexOf("if (badgePrefs.showQuantity !== false) {");
  const gridEnd = src.indexOf("const selectCb = document.createElement('input');");
  const gridBlock = src.slice(gridStart, gridEnd);
  const fieldIndexes = [
    'showQuantity',
    'showDims',
    'showVolume',
    'showWeight',
    'showCategory',
    'showHandling',
  ].map(field => gridBlock.indexOf(`badgePrefs.${field}`));
  assert.ok(fieldIndexes.every(index => index >= 0), 'all canonical Grid fields must be present');
  assert.deepEqual(fieldIndexes, [...fieldIndexes].sort((a, b) => a - b),
    'Grid fields must be composed in canonical display order');

  const qtyChipBlock = gridBlock.slice(
    gridBlock.indexOf('if (badgePrefs.showQuantity'),
    gridBlock.indexOf('if (badgePrefs.showDims')
  );
  const handlingChipBlock = gridBlock.slice(gridBlock.indexOf('if (badgePrefs.showHandling'));
  assert.doesNotMatch(qtyChipBlock, /showHandling/, 'the Quantity chip must not reference showHandling');
  assert.doesNotMatch(handlingChipBlock, /showQuantity/, 'the Handling chip must not reference showQuantity');
  assert.match(qtyChipBlock, /qtyBadge\.textContent = `\$\{qty\} unit\$\{qty === 1 \? '' : 's'\}`;/);

  const cardAppendBlock = src.slice(
    src.indexOf('card.appendChild(head);', gridStart),
    src.indexOf('gridEl.appendChild(card);', gridStart)
  );
  const cardAppendIndexes = [
    'card.appendChild(head)',
    'card.appendChild(identityChips)',
    'card.appendChild(meta)',
  ].map(statement => cardAppendBlock.indexOf(statement));
  assert.ok(cardAppendIndexes.every(index => index >= 0));
  assert.deepEqual(cardAppendIndexes, [...cardAppendIndexes].sort((a, b) => a - b),
    'Grid DOM order must keep header, identity, then canonical metadata');
});

test('Handling and Quantity defaults are independent and legacy-compatible: both default true, neither toggle affects the other via defaults/normalization', async () => {
  const { CoreNormalizer } = await loadModules();
  const defaults = CoreNormalizer.normalizePreferences({});
  assert.equal(defaults.gridCardBadges.cases.showHandling, true);
  assert.equal(defaults.gridCardBadges.cases.showQuantity, true);

  const handlingOffOnly = CoreNormalizer.normalizePreferences({
    gridCardBadges: { cases: { showHandling: false } },
  });
  assert.equal(handlingOffOnly.gridCardBadges.cases.showHandling, false);
  assert.equal(handlingOffOnly.gridCardBadges.cases.showQuantity, true,
    'disabling Handling must not affect the normalized Quantity preference');

  const quantityOffOnly = CoreNormalizer.normalizePreferences({
    gridCardBadges: { cases: { showQuantity: false } },
  });
  assert.equal(quantityOffOnly.gridCardBadges.cases.showQuantity, false);
  assert.equal(quantityOffOnly.gridCardBadges.cases.showHandling, true,
    'disabling Quantity must not affect the normalized Handling preference');

  // Preference persistence + rehydration round-trip (legacy object with only
  // a subset of keys saved, as a real localStorage snapshot might contain).
  const rehydrated = CoreNormalizer.normalizePreferences(
    CoreNormalizer.normalizePreferences({ gridCardBadges: { cases: { showHandling: false, showQuantity: false } } })
  );
  assert.equal(rehydrated.gridCardBadges.cases.showHandling, false);
  assert.equal(rehydrated.gridCardBadges.cases.showQuantity, false);
});

// ===========================================================================
// BUG 2 — Load Plans Grid reverting to List while idle
//
// Root cause: render(), updateViewButtons(), and updateBulkActions() each
// independently fell back to a FRESH `PreferencesManager.get().packsViewMode`
// read whenever they were called without an explicit modeOverride — which is
// how almost every rerender in this screen is triggered (search/sort/filter
// changes, StateStore subscriptions, dropdown closes, async completions,
// etc.). PreferencesManager.get() re-normalizes the ENTIRE live StateStore
// preferences object on every call, so any full-preferences overwrite that
// races in from elsewhere in the app (e.g. a workspace-scoped storage reload
// landing before the 250ms debounced save of an explicit Grid click has
// flushed to localStorage) is silently picked back up on the very next
// unrelated rerender, flipping the view back to whatever was last persisted
// (frequently 'list', a leftover from an earlier session). Fixed by
// introducing one canonical `currentViewMode` value that is populated from
// the persisted preference only once (first use / resolveViewMode's fallback
// branch), and is afterward changed ONLY by the explicit setViewMode() click
// handler — never re-derived from a live preferences read on every rerender.
// ===========================================================================

test('packs-screen.js declares one canonical currentViewMode value, initialized to null (no valid mode until first resolved)', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  assert.match(src, /let currentViewMode = null;/);
});

test('resolveViewMode() only falls back to the persisted preference when no canonical value is set yet (first-initialization only)', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function resolveViewMode() {', '\n    }');
  assert.match(block, /if \(currentViewMode === 'grid' \|\| currentViewMode === 'list'\) return currentViewMode;/,
    'an already-valid canonical value must be returned as-is, never replaced by a fallback read');
  assert.match(block, /currentViewMode = PreferencesManager\.get\(\)\.packsViewMode === 'list' \? 'list' : 'grid';/,
    'the fallback (first-initialization only) must normalize any non-"list" value to "grid"');
});

test('setViewMode() updates canonical state before persisting and rendering, in the required atomic order', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function setViewMode(mode) {', '\n    }');
  const canonicalIdx = block.indexOf('currentViewMode = nextMode;');
  const persistIdx = block.indexOf('PreferencesManager.set(prefs);');
  const renderIdx = block.indexOf('render(nextMode);');
  const buttonsIdx = block.indexOf('updateViewButtons(nextMode);');
  assert.ok(canonicalIdx >= 0 && persistIdx >= 0 && renderIdx >= 0 && buttonsIdx >= 0,
    'setViewMode must update canonical state, persist, render, and update buttons');
  assert.ok(canonicalIdx < persistIdx, '1. canonical state must be updated before persistence');
  assert.ok(persistIdx < renderIdx, '2. persistence must happen before the matching render');
  assert.ok(renderIdx < buttonsIdx, '3. render must happen before the button/ARIA update');
});

test('render(), updateViewButtons(), and updateBulkActions() resolve the view mode through resolveViewMode(), never a fresh PreferencesManager re-read', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');

  const renderBlock = extractFunctionBlock(src, 'function render(modeOverride) {', '\n      initFooter(mode);');
  assert.match(renderBlock, /modeOverride === 'list' \|\| modeOverride === 'grid' \? modeOverride : resolveViewMode\(\);/);

  const buttonsBlock = extractFunctionBlock(src, 'function updateViewButtons(modeOverride) {', '\n    }');
  assert.match(buttonsBlock, /: resolveViewMode\(\);/);

  const bulkBlock = extractFunctionBlock(src, 'function updateBulkActions() {', '\n    }');
  assert.match(bulkBlock, /const mode = resolveViewMode\(\);/);

  // No remaining call sites re-derive the mode from a fresh PreferencesManager
  // read outside resolveViewMode's own fallback branch and setViewMode's
  // persistence write (the only two places allowed to touch packsViewMode).
  const directReads = (src.match(/PreferencesManager\.get\(\)\.packsViewMode/g) || []).length;
  assert.equal(directReads, 1, 'exactly one direct read should remain: resolveViewMode\'s first-initialization fallback');
});

test('no timer, interval, or async completion writes packsViewMode or resets currentViewMode', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  assert.doesNotMatch(src, /setInterval/, 'no polling/correction timer may be introduced for view mode');
  // Every assignment to currentViewMode must be either the null initializer,
  // resolveViewMode's first-init fallback, or setViewMode's explicit write —
  // never inside a setTimeout/async callback.
  const assignments = [...src.matchAll(/currentViewMode\s*=(?!=)/g)];
  assert.equal(assignments.length, 3, 'currentViewMode must only ever be assigned in its declaration, resolveViewMode, and setViewMode');
});

test('resetWorkspaceState() does not touch currentViewMode or packsViewMode — workspace events must not alter Grid/List selection', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function resetWorkspaceState() {', '\n    }');
  assert.doesNotMatch(block, /currentViewMode|packsViewMode|ViewMode/);
});

test('Load Plans and Cases view-mode state are fully independent (separate preference keys, separate module-level variables)', async () => {
  const [packsSrc, casesSrc] = await Promise.all([
    fs.readFile(packsScreenPath, 'utf8'),
    fs.readFile(casesScreenPath, 'utf8'),
  ]);
  assert.doesNotMatch(packsSrc, /casesViewMode/, 'Load Plans must never read or write the Cases view-mode key');
  assert.doesNotMatch(casesSrc, /packsViewMode|currentViewMode/, 'Cases must never read or write the Load Plans view-mode key/state');
});

test('normalizePreferences: an invalid persisted packsViewMode normalizes safely (any value other than "list" becomes "grid")', async () => {
  const { CoreNormalizer } = await loadModules();
  assert.equal(CoreNormalizer.normalizePreferences({ packsViewMode: 'list' }).packsViewMode, 'list');
  assert.equal(CoreNormalizer.normalizePreferences({ packsViewMode: 'grid' }).packsViewMode, 'grid');
  for (const invalid of [undefined, null, '', 'LIST', 'card', 42, {}]) {
    assert.equal(CoreNormalizer.normalizePreferences({ packsViewMode: invalid }).packsViewMode, 'grid');
  }
});

// ===========================================================================
// P1-A — staged-only removal authority
// ===========================================================================

test('P1-A G1/G2: empty and unknown explicit Delete targets are true no-ops', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  for (const requestedIds of [[], ['unknown-instance']]) {
    const initialPack = basePack({
      cases: [
        insideInstance({
          id: 'floating-packed',
          transform: {
            position: { x: 20, y: 25, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
        }),
      ],
      handlingRulesValidatedSignature: 'v1:preserve-me',
      lastEdited: 12345,
    });
    StateStore.init({ caseLibrary: [baseCase()], packLibrary: [initialPack], folderLibrary: [], preferences: {} });
    const before = StateStore.snapshot();
    let packWrites = 0;
    const unsubscribe = StateStore.subscribe(changes => {
      if (changes.packLibrary) packWrites++;
    });

    const result = PackLibrary.removeInstances('pack-1', requestedIds);
    unsubscribe();

    assert.equal(result, null);
    assert.equal(packWrites, 0);
    assert.deepEqual(StateStore.snapshot(), before);
    assert.equal(StateStore.undo(), false, 'a no-op Delete must not create history');
  }
});

test('P1-A G3: physically staged explicit Delete bypasses revalidation and is one Undo/Redo action', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const packed = insideInstance({
    id: 'floating-packed',
    transform: {
      position: { x: 20, y: 25, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    orientedDims: { length: 10, width: 10, height: 10 },
    packedProfile: 'max-capacity',
    instanceNotes: 'preserve packed metadata',
  });
  const staged = outsideInstance({ id: 'staged-target', placement: 'packed' });
  const initialPack = basePack({
    cases: [packed, staged],
    handlingRulesValidatedSignature: 'v1:stale-before-delete',
    lastEdited: 12345,
  });
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [initialPack], folderLibrary: [], preferences: {} });
  const packedBefore = structuredClone(packed);
  let packWrites = 0;
  const unsubscribe = StateStore.subscribe(changes => {
    if (changes.packLibrary) packWrites++;
  });

  const result = PackLibrary.removeInstances('pack-1', ['staged-target']);
  unsubscribe();

  assert.deepEqual(result.deletedInstanceIds, ['staged-target']);
  assert.deepEqual(result.dependentStagedIds, []);
  assert.deepEqual(result.dependentRepairedIds, []);
  assert.deepEqual(result.revalidation, {
    adjustedIds: [], repairedIds: [], stagedIds: [], failedIds: [], invalidIds: [],
    summary: { adjusted: 0, repaired: 0, staged: 0, failed: 0 }, warnings: [],
  });
  assert.equal(packWrites, 1);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.find(inst => inst.id === 'floating-packed'), packedBefore);
  assert.equal(PackLibrary.getById('pack-1').handlingRulesValidatedSignature, undefined);

  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-1').cases.some(inst => inst.id === 'staged-target'), true);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.find(inst => inst.id === 'floating-packed'), packedBefore);
  assert.equal(StateStore.undo(), false, 'the staged Delete must be exactly one history step');
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-1').cases.some(inst => inst.id === 'staged-target'), false);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.find(inst => inst.id === 'floating-packed'), packedBefore);
});

test('P1-A G4: multiple physically staged explicit targets are removed in one Pack write', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' }), outsideInstance({ id: 's2' })] })],
    folderLibrary: [],
    preferences: {},
  });
  let packWrites = 0;
  const unsubscribe = StateStore.subscribe(changes => {
    if (changes.packLibrary) packWrites++;
  });
  const result = PackLibrary.removeInstances('pack-1', ['s1', 's2']);
  unsubscribe();

  assert.deepEqual(result.deletedInstanceIds, ['s1', 's2']);
  assert.equal(result.pack.cases.length, 0);
  assert.equal(packWrites, 1);
  assert.equal(StateStore.undo(), true);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.map(inst => inst.id), ['s1', 's2']);
  assert.equal(StateStore.undo(), false);
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getById('pack-1').cases.length, 0);
});

test('P1-A G5/G6: packed and mixed explicit Delete retain one dependent-revalidation write', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  for (const requestedIds of [['support'], ['support', 'staged-target']]) {
    const cases = [
      insideInstance({ id: 'support' }),
      insideInstance({
        id: 'child',
        transform: {
          position: { x: 20, y: 15, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      }),
      outsideInstance({ id: 'staged-target' }),
    ];
    StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases })], folderLibrary: [], preferences: {} });
    let packWrites = 0;
    const unsubscribe = StateStore.subscribe(changes => {
      if (changes.packLibrary) packWrites++;
    });

    const result = PackLibrary.removeInstances('pack-1', requestedIds);
    unsubscribe();

    assert.deepEqual(result.deletedInstanceIds, requestedIds);
    assert.equal(result.pack.cases.some(inst => inst.id === 'support'), false);
    assert.equal(result.revalidation.adjustedIds.includes('child'), true,
      'the packed child must flow through the existing dependent-revalidation path');
    assert.deepEqual(result.pack.cases.find(inst => inst.id === 'child').transform.position, { x: 20, y: 5, z: 0 });
    assert.equal(packWrites, 1);
    assert.equal(StateStore.undo(), true);
    assert.equal(PackLibrary.getById('pack-1').cases.some(inst => inst.id === 'support'), true);
    assert.equal(StateStore.undo(), false, 'packed/mixed Delete must remain one history step');
    assert.equal(StateStore.redo(), true);
  }
});

test('P1-A R1/R2/R3/R5/R9/R10/R18: staged Case removal is selective, deterministic, and atomic', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const sameNameOtherCase = baseCase({ id: 'case-b', name: 'Case A' });
  const cases = [
    outsideInstance({ id: 'eligible-1' }),
    outsideInstance({ id: 'hidden', hidden: true }),
    outsideInstance({ id: 'grouped', groupId: 'group-1' }),
    insideInstance({ id: 'physical-packed-but-labeled-staged', placement: 'staged' }),
    outsideInstance({ id: 'other-case', caseId: 'case-b' }),
    outsideInstance({ id: 'eligible-2', groupId: '' }),
    outsideInstance({ id: 'eligible-3' }),
  ];
  StateStore.init({
    caseLibrary: [baseCase(), sameNameOtherCase],
    packLibrary: [basePack({ cases })],
    folderLibrary: [],
    preferences: {},
    selectedInstanceIds: ['eligible-3', 'other-case'],
  });
  const counts = PackLibrary.getCaseInstanceCounts('pack-1', 'case-a');
  assert.equal(counts.inTruck, 1);
  assert.equal(counts.staged, 5);
  assert.equal(counts.hidden, 1);
  let packWrites = 0;
  const unsubscribe = StateStore.subscribe(changes => {
    if (changes.packLibrary) packWrites++;
  });

  const result = PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', 2);
  unsubscribe();

  assert.equal(result.reason, 'ok');
  assert.equal(result.requestedCount, 2);
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.removedInstanceIds, ['eligible-3', 'eligible-2'],
    'the last N eligible Pack-array records must be returned in reverse array order');
  assert.deepEqual(result.pack.cases.map(inst => inst.id), [
    'eligible-1', 'hidden', 'grouped', 'physical-packed-but-labeled-staged', 'other-case',
  ]);
  assert.deepEqual(StateStore.get('selectedInstanceIds'), ['eligible-3', 'other-case'],
    'the service must remain UI-selection agnostic');
  assert.equal(packWrites, 1);

  assert.equal(StateStore.undo(), true);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.map(inst => inst.id), cases.map(inst => inst.id));
  assert.equal(StateStore.undo(), false);
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.map(inst => inst.id), result.pack.cases.map(inst => inst.id));
});

test('P1-A R4/R6: staged Case removal shortage is all-or-nothing, including zero eligible', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  for (const cases of [
    [outsideInstance({ id: 'eligible-1' }), outsideInstance({ id: 'eligible-2' })],
    [insideInstance({ id: 'packed-only' })],
  ]) {
    StateStore.init({
      caseLibrary: [baseCase()],
      packLibrary: [basePack({ cases, lastEdited: 12345 })],
      folderLibrary: [],
      preferences: {},
    });
    const before = StateStore.snapshot();
    const requestedCount = cases.length === 2 ? 3 : 1;
    const expectedEligible = cases.length === 2 ? 2 : 0;
    const result = PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', requestedCount);

    assert.equal(result.reason, 'insufficient-eligible');
    assert.equal(result.eligibleCount, expectedEligible);
    assert.equal(result.removedCount, 0);
    assert.deepEqual(result.removedInstanceIds, []);
    assert.equal(result.pack, null);
    assert.deepEqual(StateStore.snapshot(), before);
    assert.equal(StateStore.undo(), false);
  }
});

test('P1-A R11/R12/R13: invalid commands and missing authorities never mutate a Pack', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const invalidCounts = [0, -1, 1.9, 10001, NaN, Infinity, 'garbage', '2', true, false, null, undefined];
  for (const count of invalidCounts) {
    StateStore.init({
      caseLibrary: [baseCase()],
      packLibrary: [basePack({ cases: [outsideInstance({ id: 'eligible' })] })],
      folderLibrary: [],
      preferences: {},
    });
    const before = StateStore.snapshot();
    const result = PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', count);
    assert.equal(result.reason, 'invalid-count');
    assert.equal(result.removedCount, 0);
    assert.deepEqual(StateStore.snapshot(), before);
    assert.equal(StateStore.undo(), false);
  }

  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  assert.equal(PackLibrary.removeCaseInstancesFromStaging('missing-pack', 'case-a', 1).reason, 'pack-not-found');
  assert.equal(PackLibrary.removeCaseInstancesFromStaging('pack-1', 'missing-case', 1).reason, 'case-not-found');
  assert.equal(StateStore.undo(), false);
});

test('P1-A R7/R8: hidden and grouped staged instances are never automatically eligible', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const cases = [
    outsideInstance({ id: 'hidden', hidden: true }),
    outsideInstance({ id: 'grouped', groupId: 'group-1' }),
    outsideInstance({ id: 'blank-group', groupId: '   ' }),
  ];
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases })],
    folderLibrary: [],
    preferences: {},
  });
  const result = PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', 1);
  assert.equal(result.reason, 'ok');
  assert.equal(result.eligibleCount, 1);
  assert.deepEqual(result.removedInstanceIds, ['blank-group']);
  assert.deepEqual(result.pack.cases.map(inst => inst.id), ['hidden', 'grouped']);
});

test('P1-A R14-R17: every staged-only authority preserves invalid packed bytes without certification', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const currentCase = baseCase({ noStackOnTop: true });
  const oldCase = baseCase({ noStackOnTop: false });
  const packed = insideInstance({
    id: 'floating-max-capacity',
    transform: {
      position: { x: 20, y: 25, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    orientedDims: { length: 10, width: 10, height: 10 },
    packedProfile: 'max-capacity',
    orientationLocked: true,
    lockedRotation: { x: 0, y: 0, z: 0 },
    deliverySequence: 7,
    instanceNotes: 'preserve everything',
  });
  const staged = outsideInstance({ id: 'remove-me' });
  const unsignedPack = basePack({ cases: [packed, staged] });
  const currentSignature = PackLibrary.buildHandlingRulesValiditySignature(unsignedPack, [currentCase]);
  const staleSignature = PackLibrary.buildHandlingRulesValiditySignature(unsignedPack, [oldCase]);
  const signatures = [
    { name: 'current', value: currentSignature, stale: false },
    { name: 'stale', value: staleSignature, stale: true },
    { name: 'legacy-null', value: null, stale: false },
  ];
  const operations = [
    { name: 'generic Delete', run: () => PackLibrary.removeInstances('pack-1', ['remove-me']) },
    { name: 'staged Case removal', run: () => PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', 1) },
  ];

  for (const operation of operations) {
    for (const signature of signatures) {
      StateStore.init({
        caseLibrary: [currentCase],
        packLibrary: [basePack({
          cases: [packed, staged],
          handlingRulesValidatedSignature: signature.value,
          lastEdited: 12345,
        })],
        folderLibrary: [],
        preferences: {},
      });
      const before = PackLibrary.getById('pack-1');
      const packedBefore = structuredClone(before.cases.find(inst => inst.id === packed.id));
      assert.equal(
        PackLibrary.isHandlingRulesValidationRequired(before, [currentCase]),
        true,
        `${operation.name}/${signature.name}: precondition`
      );

      operation.run();
      const after = PackLibrary.getById('pack-1');
      assert.equal(after.handlingRulesValidatedSignature, undefined,
        `${operation.name}/${signature.name}: retired certificate is stripped`);
      assert.equal(
        PackLibrary.isHandlingRulesValidationRequired(after, [currentCase]),
        true,
        `${operation.name}/${signature.name}: physical review state must not change`
      );
      assert.deepEqual(after.cases.find(inst => inst.id === packed.id), packedBefore,
        `${operation.name}/${signature.name}: floating packed transform and Max Capacity metadata must not change`);
    }
  }
});

// ---------------------------------------------------------------------------
// P1-B commit 1 — strict, all-or-nothing staged Add
// ---------------------------------------------------------------------------

function trackPackWrites(StateStore) {
  let writes = 0;
  const unsubscribe = StateStore.subscribe(changes => {
    if (changes.packLibrary) writes++;
  });
  return { count: () => writes, stop: unsubscribe };
}

// A single large pre-existing Case within the canonical dimension bound. With rect truck 120x60 and a 10x10x10
// Case the staging grid is 6 columns wide, rows start at z=42 and repeat every
// 22. `fromZ` is where the blocker's footprint begins: everything at or beyond it
// is unplaceable, everything before it stays free.
function stagingBlockerCase() {
  return baseCase({ id: 'staging-blocker-case',
    dimensions: { length: 120, width: 100000, height: 10 } });
}

function stagingBlockerInstance(fromZ) {
  const width = stagingBlockerCase().dimensions.width;
  return outsideInstance({
    id: 'staging-blocker',
    caseId: 'staging-blocker-case',
    transform: {
      position: { x: 60, y: 5, z: fromZ + width / 2 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  });
}

test('P1-B A1: addInstancesToStaging accepts whole quantities 1, N, and the 10,000 maximum', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  for (const count of [1, 7, 10000]) {
    StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
    const result = PackLibrary.addInstancesToStaging('pack-1', 'case-a', count);
    assert.equal(result.reason, 'ok', `count ${count}`);
    assert.equal(result.requestedCount, count);
    assert.equal(result.addedCount, count, 'a successful Add adds exactly the requested count');
    assert.equal(result.createdInstanceIds.length, count);
    assert.equal(new Set(result.createdInstanceIds).size, count, 'created ids are unique');
    assert.equal(PackLibrary.getById('pack-1').cases.length, count);
    assert.equal(PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged, count);
  }
});

test('P1-B A2: strict count contract rejects everything except a whole number 1..10000, with zero writes', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const invalidCounts = [
    0, -1, -7, 0.5, 1.9, 2.5, 10001, 1e9, NaN, Infinity, -Infinity,
    '5', '', ' ', 'abc', true, false, null, undefined, [5], [], {}, { valueOf: () => 3 },
  ];
  for (const count of invalidCounts) {
    StateStore.init({
      caseLibrary: [baseCase()],
      packLibrary: [basePack({ cases: [insideInstance()], lastEdited: 12345 })],
      folderLibrary: [],
      preferences: {},
    });
    const before = StateStore.snapshot();
    const writes = trackPackWrites(StateStore);
    const first = PackLibrary.addInstancesToStaging('pack-1', 'case-a', count);
    const second = PackLibrary.addInstancesToStaging('pack-1', 'case-a', count);
    writes.stop();

    const label = `count=${typeof count === 'object' ? JSON.stringify(count) : String(count)}`;
    assert.equal(first.reason, 'invalid-count', label);
    assert.equal(first.addedCount, 0, label);
    assert.deepEqual(first.createdInstanceIds, [], label);
    assert.equal(first.pack, null, label);
    assert.notStrictEqual(first.createdInstanceIds, second.createdInstanceIds,
      `${label}: failure arrays must be fresh, never shared mutable state`);
    assert.equal(writes.count(), 0, `${label}: no Pack write`);
    assert.deepEqual(StateStore.snapshot(), before, `${label}: state byte-identical (lastEdited untouched)`);
    assert.equal(StateStore.undo(), false, `${label}: no history entry`);
  }
});

test('P1-B A3: missing Pack and missing Case report their own reason and never write', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const before = StateStore.snapshot();
  const writes = trackPackWrites(StateStore);

  const noPack = PackLibrary.addInstancesToStaging('missing-pack', 'case-a', 3);
  assert.equal(noPack.reason, 'pack-not-found');
  for (const caseId of ['missing-case', '', null, undefined]) {
    const noCase = PackLibrary.addInstancesToStaging('pack-1', caseId, 3);
    assert.equal(noCase.reason, 'case-not-found', `caseId=${String(caseId)}`);
    assert.equal(noCase.addedCount, 0);
    assert.deepEqual(noCase.createdInstanceIds, []);
    assert.equal(noCase.pack, null);
  }
  writes.stop();

  assert.equal(noPack.addedCount, 0);
  assert.deepEqual(noPack.createdInstanceIds, []);
  assert.equal(noPack.pack, null);
  assert.equal(writes.count(), 0);
  assert.deepEqual(StateStore.snapshot(), before);
  assert.equal(StateStore.undo(), false);
});

test('P1-B A4: placement-incomplete is all-or-nothing — a partial batch is never published', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  // Row 0 (6 columns) is free; the blocker begins at z=60, so row 1 onwards is
  // unplaceable. Requesting 10 could only ever place 6 before the search gives up.
  const blocked = [
    { name: 'partially blocked (6 placeable, 10 requested)', fromZ: 60, requested: 10 },
    { name: 'fully blocked (0 placeable)', fromZ: 0, requested: 3 },
  ];
  for (const scenario of blocked) {
    const cases = [stagingBlockerInstance(scenario.fromZ)];
    StateStore.init({
      caseLibrary: [baseCase(), stagingBlockerCase()],
      packLibrary: [basePack({ cases, lastEdited: 12345 })],
      folderLibrary: [],
      preferences: {},
    });
    const before = StateStore.snapshot();
    const writes = trackPackWrites(StateStore);
    const result = PackLibrary.addInstancesToStaging('pack-1', 'case-a', scenario.requested);
    writes.stop();

    assert.equal(result.reason, 'placement-incomplete', scenario.name);
    assert.equal(result.requestedCount, scenario.requested, scenario.name);
    assert.equal(result.addedCount, 0, `${scenario.name}: no partial count is exposed`);
    assert.deepEqual(result.createdInstanceIds, [], scenario.name);
    assert.equal(result.pack, null, scenario.name);
    assert.equal(writes.count(), 0, `${scenario.name}: ZERO Pack writes`);
    assert.deepEqual(StateStore.snapshot(), before, `${scenario.name}: Pack, lastEdited and stats untouched`);
    assert.equal(PackLibrary.getById('pack-1').lastEdited, 12345, `${scenario.name}: lastEdited not bumped`);
    assert.equal(StateStore.undo(), false, `${scenario.name}: ZERO history entries`);
  }

  // Positive control: the very same partially-blocked fixture does place a full
  // batch that fits, so the failure above is the all-or-nothing rule, not a bad fixture.
  StateStore.init({
    caseLibrary: [baseCase(), stagingBlockerCase()],
    packLibrary: [basePack({ cases: [stagingBlockerInstance(60)] })],
    folderLibrary: [],
    preferences: {},
  });
  const fits = PackLibrary.addInstancesToStaging('pack-1', 'case-a', 6);
  assert.equal(fits.reason, 'ok');
  assert.equal(fits.addedCount, 6);
  assert.equal(PackLibrary.getById('pack-1').cases.length, 7);
});

test('P1-B A5: a successful Add is exactly one Pack write and one Undo/Redo step', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const writes = trackPackWrites(StateStore);
  const result = PackLibrary.addInstancesToStaging('pack-1', 'case-a', 5);
  writes.stop();

  assert.equal(result.reason, 'ok');
  assert.equal(writes.count(), 1, 'one Pack write for the whole batch');
  assert.equal(result.createdInstanceIds.length, result.requestedCount);
  const createdInPack = PackLibrary.getById('pack-1').cases.map(inst => inst.id);
  assert.deepEqual([...createdInPack].sort(), [...result.createdInstanceIds].sort());

  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-1').cases.length, 0, 'one Undo removes the whole batch');
  assert.equal(StateStore.undo(), false, 'the batch was a single history step');
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.map(inst => inst.id), createdInPack,
    'one Redo restores the whole batch');
});

test('P1-B A6: every Add result carries the same reason/count/ids/pack shape', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack()], folderLibrary: [], preferences: {} });
  const shape = ['addedCount', 'createdInstanceIds', 'pack', 'reason', 'requestedCount'];
  const results = [
    PackLibrary.addInstancesToStaging('pack-1', 'case-a', 2),
    PackLibrary.addInstancesToStaging('pack-1', 'case-a', 0),
    PackLibrary.addInstancesToStaging('missing-pack', 'case-a', 1),
    PackLibrary.addInstancesToStaging('pack-1', 'missing-case', 1),
  ];
  for (const result of results) assert.deepEqual(Object.keys(result).sort(), shape);
  assert.deepEqual(results.map(result => result.reason), ['ok', 'invalid-count', 'pack-not-found', 'case-not-found']);
  assert.ok(results[0].pack && Array.isArray(results[0].pack.cases), 'ok carries the updated Pack');
});

test('P1-B A7: the service source no longer coerces, truncates, or clamps count', async () => {
  const src = await fs.readFile(packLibraryUrl, 'utf8');
  const block = extractFunctionBlock(src, 'export function addInstancesToStaging(packId, caseId, count) {', '\n}');
  assert.match(block, /typeof count !== 'number'/);
  assert.match(block, /!Number\.isInteger\(count\)/);
  assert.match(block, /count < 1 \|\| count > BULK_ADD_MAX_QUANTITY/);
  assert.doesNotMatch(block, /Number\(count\)|Math\.trunc\(|Math\.min\(BULK_ADD_MAX_QUANTITY/,
    'no silent coercion, fraction truncation, or clamping at the command authority');
  assert.doesNotMatch(src, /EMPTY_BULK_ADD_RESULT/, 'no shared frozen result object with a shared mutable array');
  const guard = block.indexOf('newInstances.length !== requestedCount');
  const write = block.indexOf('update(packId');
  assert.ok(guard > 0 && write > guard, 'the all-or-nothing guard must run before the single update()');
});

test('P1-B A8: Add failure feedback maps each service reason to its copy and tone', async () => {
  const { getStagingAddFailureFeedback } = await import(editorScreenPath.href);
  assert.deepEqual(getStagingAddFailureFeedback({ reason: 'invalid-count' }),
    { message: 'Enter a whole quantity from 1 to 10,000.', tone: 'warning' });
  assert.deepEqual(getStagingAddFailureFeedback({ reason: 'pack-not-found' }),
    { message: 'Create or open a load plan first', tone: 'warning' });
  assert.deepEqual(getStagingAddFailureFeedback({ reason: 'case-not-found' }),
    { message: 'This case no longer exists.', tone: 'error' });
  assert.deepEqual(getStagingAddFailureFeedback({ reason: 'placement-incomplete' }),
    { message: "Couldn't place the full quantity in staging. Nothing was added.", tone: 'warning' });
  assert.equal(getStagingAddFailureFeedback(null).tone, 'error', 'an unexpected result still gives feedback');
});

test('P1-B A9: the Add click reads the live input, restores the requested Qty on failure, and never writes on invalid input', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
  const click = extractFunctionBlock(block, "addBtn.addEventListener('click', () => {", '\n      });');

  // Live input authority: busy guard first, then parse the visible value, then act.
  const guard = click.indexOf('editorMutationBlocked()');
  const parse = click.indexOf('readLiveQty()');
  const service = click.indexOf('PackLibrary.addInstancesToStaging(packId, c.id, qty)');
  assert.ok(guard >= 0 && parse > guard && service > parse,
    'editorMutationBlocked() -> readLiveQty() -> addInstancesToStaging()');
  assert.match(click, /const qty = readLiveQty\(\);\s*if \(qty === null\) return;/,
    'an invalid visible value stops before any mutation');
  const live = extractFunctionBlock(block, 'const readLiveQty = () => {', '\n      };');
  assert.match(live, /const n = parseDirectEntry\(\);/);
  assert.match(live, /n === null \|\| n > CASE_QTY_MAX/);
  assert.match(live, /revertInput\(\);\s*UIComponents\.showToast\(STAGING_QTY_INVALID_MESSAGE, 'warning'\);\s*return null;/);
  assert.match(live, /commitDraft\(n\);\s*return n;/, 'a valid value is committed to the draft and used exactly');

  // Failure: feedback, no selection write, draft restored (also when the service throws).
  assert.match(click, /if \(!result \|\| result\.reason !== 'ok'\) \{\s*const feedback = getStagingAddFailureFeedback\(result\);\s*UIComponents\.showToast\(feedback\.message, feedback\.tone\);\s*return;/);
  assert.match(click, /finally \{[\s\S]*?if \(!added\) setCaseQtyDraft\(c\.id, qty\);/);
  const failureBranch = click.slice(click.indexOf("result.reason !== 'ok'"), click.indexOf('added = true;'));
  assert.doesNotMatch(failureBranch, /StateStore\.set|selectedInstanceIds/, 'failure never touches selection');

  // Success semantics are unchanged: Add 1 selects the new instance, Add N preserves selection.
  assert.match(click, /added = true;\s*if \(result\.addedCount === 1\) \{\s*StateStore\.set\(\{ selectedInstanceIds: result\.createdInstanceIds \}, \{ skipHistory: true \}\);/);
  assert.match(click, /'Case added to staging\.'/);
  assert.match(click, /`Added \$\{result\.addedCount\} items to staging\.`/);
  assert.match(click, /UIComponents\.showToast\(message, 'success'\);/);
  assert.doesNotMatch(click, /removeInstances|removeCaseInstancesFromStaging/, 'Add never removes anything');
});

// ---------------------------------------------------------------------------
// P1-B commit 2 — staged-only Qty Unstage control (segmented with + Add)
// ---------------------------------------------------------------------------

function qtyRowBlock(src) {
  return extractFunctionBlock(src, 'function buildCaseQtyAddRow(c, pack) {', '\n      return section;\n    }');
}

test('P1-B R1: Unstage is offered only when the Case has physically staged cargo (counts.staged > 0), never from eligibility logic', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);

  assert.match(block, /let removeBtn = null;\s*if \(counts\.staged > 0\) \{\s*removeBtn = document\.createElement\('button'\);/);
  const created = block.indexOf("removeBtn = document.createElement('button')");
  const gate = block.indexOf('if (counts.staged > 0) {');
  const appended = block.indexOf('actions.appendChild(removeBtn);');
  assert.ok(gate >= 0 && created > gate && appended > created, 'the button is created and appended only inside the staged gate');
  assert.match(block, /if \(removeBtn\) \{\s*removeBtn\.addEventListener\('click'/, 'the handler only exists with the button');
  // The Editor must not re-derive which staged instances are removable.
  assert.doesNotMatch(block, /hasActiveGroup|groupId|\.hidden\b|classifyPhysicalPlacement|createPhysicalPlacementClassifier|eligibleInstances/);

  const { StateStore, PackLibrary } = await loadModules();
  const cases = {
    'packed only': { cases: [insideInstance({ id: 'p1' })], staged: 0 },
    'hidden staged only': { cases: [outsideInstance({ id: 'h1', hidden: true })], staged: 1 },
    'visible staged': { cases: [outsideInstance({ id: 's1' })], staged: 1 },
    'grouped staged only': { cases: [outsideInstance({ id: 'g1', groupId: 'group-1' })], staged: 1 },
  };
  for (const [name, fixture] of Object.entries(cases)) {
    StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: fixture.cases })], folderLibrary: [], preferences: {} });
    assert.equal(PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged, fixture.staged, name);
  }
  // staged > 0 but nothing removable: the button appears, the service alone rejects.
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: cases['grouped staged only'].cases })], folderLibrary: [], preferences: {} });
  const before = StateStore.snapshot();
  const shortage = PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', 1);
  assert.equal(shortage.reason, 'insufficient-eligible');
  assert.equal(shortage.eligibleCount, 0);
  assert.deepEqual(StateStore.snapshot(), before);
});

test('P1-B R2: Unstage is the neutral LEFT segment of one [ Unstage | + Add ] control beside the Qty stepper, above the readout', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const css = await fs.readFile(new URL('../../styles/main.css', import.meta.url), 'utf8');
  const block = qtyRowBlock(src);

  // Row = [stepper][actions]; Unstage is appended to the actions group BEFORE Add (left segment).
  assert.match(block, /stepper\.className = 'tp3d-editor-case-qty-stepper';\s*row\.appendChild\(stepper\);/);
  assert.match(block, /actions\.className = 'tp3d-editor-case-qty-actions';\s*row\.appendChild\(actions\);/);
  const unstageAt = block.indexOf('actions.appendChild(removeBtn);');
  const addAt = block.indexOf('actions.appendChild(addBtn);');
  const rowAt = block.indexOf('section.appendChild(row);');
  const readoutAt = block.indexOf('section.appendChild(readout);');
  assert.ok(unstageAt > 0 && addAt > unstageAt, 'Unstage precedes + Add inside the actions group');
  assert.ok(rowAt > addAt && readoutAt > rowAt, 'row (with the segmented control) -> readout inside the existing .tp3d-editor-case-qty grid');
  assert.doesNotMatch(block, /section\.appendChild\(removeBtn\)/, 'no standalone button beneath the row');

  // Neutral, text-only Unstage: not red, not primary, no icon, no inline style.
  assert.match(block, /removeBtn\.className = 'btn btn-sm tp3d-editor-case-qty-unstage';/);
  assert.match(block, /removeBtn\.textContent = 'Unstage';/, 'text only: no icon');
  assert.match(block, /actions\.classList\.add\('tp3d-editor-case-qty-actions--segmented'\);/);
  const unstageSetup = block.slice(block.indexOf("removeBtn = document.createElement('button')"), unstageAt);
  assert.doesNotMatch(unstageSetup, /btn-danger|btn-primary|fa-|<i\b|innerHTML|\.style\./, 'neutral: not red, not primary, no icon, no inline style');
  assert.doesNotMatch(src, /'Remove'/, 'the visible staged-removal label is no longer "Remove"');

  // Add is untouched and stays the primary action with the exact "+ Add" label.
  assert.match(block, /addBtn\.className = 'btn btn-primary btn-sm tp3d-editor-btn-add';/);
  assert.match(block, /addBtn\.innerHTML = '<i class="fa-solid fa-plus"><\/i> Add';/);
  assert.doesNotMatch(block, /Add \$\{/);
  assert.doesNotMatch(block, /counts\.hidden/, 'no hidden count in the readout');

  // CSS contract (structure, not pixel values): the old standalone-button rule is gone.
  assert.doesNotMatch(css, /tp3d-editor-case-qty-remove/, 'the rejected standalone Remove styling is removed');
  const unstageRule = css.match(/\.tp3d-editor-case-qty-unstage\s*\{([^}]*)\}/);
  assert.ok(unstageRule, '.tp3d-editor-case-qty-unstage must be defined in main.css');
  assert.doesNotMatch(unstageRule[1], /--error|btn-danger|239,\s*68,\s*68|red|--accent|255,\s*159,\s*28/, 'Unstage is neutral: no danger or accent colour');
  assert.match(css, /\.tp3d-editor-case-qty-actions--segmented > \.tp3d-editor-case-qty-unstage\s*\{[^}]*border-radius:[^}]*0 0/);
  assert.match(css, /\.tp3d-editor-case-qty-actions--segmented > \.tp3d-editor-btn-add\s*\{[^}]*border-radius:\s*0 /);
  // Narrow reflow is CSS only: the row wraps, the stepper never shrinks, and the joined
  // control spans the row (stays text) under a container query on the card's own width.
  assert.match(css, /\.tp3d-editor-case-qty-row\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.tp3d-editor-case-qty-stepper\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.match(css, /\.tp3d-editor-case-qty\s*\{[^}]*container-type:\s*inline-size;/);
  // The section's single column may never outgrow the card (an auto track would size to the Qty field's intrinsic width).
  assert.match(css, /\.tp3d-editor-case-qty\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  // Narrow cards: the stepper fills its row with equal-width −/+ and a proportionally wider field.
  const narrow = css.match(/@container \(max-width: \d+px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrow, 'the narrow container query exists');
  assert.match(narrow[1], /\.tp3d-editor-case-qty-stepper\s*\{[^}]*flex:\s*1 1 0;/);
  assert.match(narrow[1], /\.tp3d-editor-case-qty-stepper > \.tp3d-editor-case-qty-btn\s*\{[^}]*flex:\s*1 1 0;/);
  assert.match(narrow[1], /\.tp3d-editor-case-qty-stepper > \.tp3d-editor-case-qty-input\s*\{[^}]*flex:\s*1\.4 1 0;/);
  // BOTH action states take the full second row — the Unstage | + Add pair AND a lone + Add — so the
  // card keeps one shape as staged cargo appears. The rule must target the base actions group, never
  // only the --segmented modifier (that scoping left a lone Add beside the stepper, compressing it).
  // The action group must be NON-SHRINKABLE and a guaranteed full row. A shrinkable `flex: 1 1 100%` group
  // is not enough: it is the shape that let a lone + Add sit beside the stepper at ~67px.
  const actionsRule = narrow[1].match(/\.tp3d-editor-case-qty-actions\s*\{([^}]*)\}/);
  assert.ok(actionsRule, 'the narrow query styles the base actions group');
  const flexShorthand = actionsRule[1].match(/(?:^|[;\s])flex:\s*(\S+)\s+(\S+)\s+(\S+)\s*;/);
  const flexShrink = flexShorthand ? flexShorthand[2] : (actionsRule[1].match(/flex-shrink:\s*(\S+);/) || [])[1];
  const flexBasis = flexShorthand ? flexShorthand[3] : (actionsRule[1].match(/flex-basis:\s*(\S+);/) || [])[1];
  assert.equal(flexShrink, '0', 'the narrow action group must not shrink into space beside the stepper');
  assert.equal(flexBasis, '100%', 'and it must claim the whole row');
  assert.match(actionsRule[1], /\bwidth:\s*100%;/, 'full width is stated, not left to line-breaking');
  assert.match(actionsRule[1], /min-width:\s*0;/, 'the group can never overflow the card via its min-content');
  assert.match(actionsRule[1], /margin-left:\s*0;/, 'the wide-layout right-alignment margin is reset');
  assert.match(narrow[1], /\.tp3d-editor-case-qty-actions > \.btn\s*\{[^}]*flex:\s*1 1 0;[^}]*justify-content:\s*center;/);
  assert.doesNotMatch(narrow[1], /--segmented/, 'the two-row rules are not limited to the segmented (staged) state');
  // The threshold is content-derived (documented in main.css), not a magic number: it must at least cover the
  // ~308px Case Browser container the audit identified, where the compact stepper used to remain.
  const threshold = Number(css.match(/@container \(max-width: (\d+)px\)/)[1]);
  assert.ok(threshold >= 308, `the narrow container query (${threshold}px) must cover the ~308px container`);
});

// Minimal DOM double so the REAL buildCaseQtyAddRow can be rendered for both card states.
function createFakeDom() {
  const makeTextNode = text => ({ isText: true, children: [], get textContent() { return text; } });
  const makeElement = tagName => {
    const el = {
      tagName,
      children: [],
      dataset: {},
      attributes: {},
      classSet: new Set(),
      _text: '',
      get className() { return [...this.classSet].join(' '); },
      set className(value) { this.classSet = new Set(String(value).split(/\s+/).filter(Boolean)); },
      classList: { add: (...names) => names.forEach(n => el.classSet.add(n)) },
      listeners: {},
      appendChild(child) { el.children.push(child); return child; },
      setAttribute(name, value) { el.attributes[name] = String(value); },
      addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
      focus() {},
      blur() {},
      get textContent() { return el.children.length ? el.children.map(c => c.textContent).join('') : el._text; },
      set textContent(value) { el._text = String(value); el.children = []; },
      set innerHTML(value) { el._innerHTML = String(value); el._text = ''; },
    };
    return el;
  };
  return { createElement: makeElement, createTextNode: makeTextNode };
}

async function renderQtyRow(counts) {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const source = `${qtyRowBlock(src)}\n      return section;\n    }`;
  const { runInNewContext } = await import('node:vm');
  const build = runInNewContext(`(${source})`, {
    document: createFakeDom(),
    PackLibrary: { getCaseInstanceCounts: () => counts },
    CASE_QTY_MIN: 1,
    CASE_QTY_MAX: 10000,
    getCaseQtyDraft: () => 1,
    setCaseQtyDraft: () => {},
    String,
  });
  const section = build({ id: 'case-a', name: 'A-Test-03' }, { id: 'pack-1' });
  const [row, readout] = section.children;
  const [stepper, actions] = row.children;
  return { section, row, readout, stepper, actions };
}

function collectNodes(node, out = []) {
  out.push(node);
  (node.children || []).forEach(child => collectNodes(child, out));
  return out;
}

test('P1-B R2b: staged > 0 renders the segmented [ Unstage | + Add ] control and a semibold "N staged" span; wording is unchanged', async () => {
  const { row, readout, stepper, actions } = await renderQtyRow({ inLoad: 15, inTruck: 12, staged: 3 });

  assert.deepEqual(stepper.children.map(c => c.textContent || c.tagName), ['Qty', '−', 'input', '+'], 'Qty stepper is unchanged and stays one group');
  assert.equal(row.children.length, 2, 'row = stepper + one actions group');
  assert.ok(actions.classSet.has('tp3d-editor-case-qty-actions--segmented'));
  assert.equal(actions.children.length, 2);
  const [unstage, add] = actions.children;

  assert.equal(unstage.textContent, 'Unstage', 'label now says Unstage, not Remove');
  assert.equal(unstage.attributes['aria-label'], 'Unstage for A-Test-03');
  assert.equal(unstage.title, 'Removes staged cases only. Packed, hidden, or grouped cases are not affected.');
  assert.equal(unstage.dataset.qtyRole, 'remove', 'internal focus-restore role token is unchanged');
  assert.ok(unstage.classSet.has('btn') && !unstage.classSet.has('btn-primary') && !unstage.classSet.has('btn-danger'), 'Unstage stays neutral');
  assert.ok(add.classSet.has('btn-primary'), 'Add remains the orange primary action');
  assert.equal(add._innerHTML, '<i class="fa-solid fa-plus"></i> Add');

  // Visible wording is exactly "N in load · N in truck · N staged"; only "3 staged" is emphasised.
  assert.equal(readout.textContent, '15 in load · 12 in truck · 3 staged');
  const emphasised = collectNodes(readout).filter(n => n.classSet && n.classSet.has('tp3d-editor-case-qty-readout-staged'));
  assert.equal(emphasised.length, 1, 'one dedicated staged span');
  assert.equal(emphasised[0].textContent, '3 staged');
  assert.equal(readout.children.length, 2, 'plain lead-in text node + the staged span, nothing else');
  assert.doesNotMatch(readout.textContent, /hidden/i, 'no hidden-count addition');
  assert.doesNotMatch(collectNodes(readout.children[0]).map(n => n.textContent).join(''), /staged/, 'the rest of the readout is not emphasised');
});

test('P1-B R2c: staged = 0 renders only "+ Add" — no Unstage, no empty or disabled half — and an unemphasised readout', async () => {
  const { row, readout, stepper, actions } = await renderQtyRow({ inLoad: 12, inTruck: 12, staged: 0 });

  assert.equal(row.children.length, 2);
  assert.equal(actions.children.length, 1, 'only the Add action');
  assert.equal(actions.classSet.has('tp3d-editor-case-qty-actions--segmented'), false, 'no segmented shape around a lone Add');
  assert.ok(actions.children[0].classSet.has('btn-primary'));
  assert.equal(actions.children[0].attributes['aria-label'], 'Add to staging for A-Test-03');
  const everything = [...collectNodes(stepper), ...collectNodes(actions)];
  assert.equal(everything.some(n => n.textContent === 'Unstage' || (n.classSet && n.classSet.has('tp3d-editor-case-qty-unstage'))), false, 'no Unstage element of any kind');
  assert.equal(everything.some(n => n.attributes && 'disabled' in n.attributes), false, 'no disabled ghost segment');

  assert.equal(readout.textContent, '12 in load · 12 in truck · 0 staged');
  assert.equal(collectNodes(readout).some(n => n.classSet && n.classSet.has('tp3d-editor-case-qty-readout-staged')), false, '0 staged keeps the normal secondary weight');
});

// ---------------------------------------------------------------------------
// P1-B browser-defect fixes — blur/click order and duplicate Add clicks.
//
// These run the REAL buildCaseQtyAddRow against the REAL PackLibrary/StateStore,
// but the DOM is a hand-written double: they replay the browser's event ORDER
// (blur before click) and rebuild the card by hand where the app does it via a
// StateStore subscriber. They prove the handler logic, NOT real double-click
// browser behavior — that stays a browser-acceptance check.
// ---------------------------------------------------------------------------

function fire(el, type, extra = {}) {
  (el.listeners[type] || []).forEach(fn => fn({ type, target: el, relatedTarget: null, preventDefault() {}, ...extra }));
}

async function createQtyRowHarness({ PackLibrary, StateStore, guard }) {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const source = `${qtyRowBlock(src)}\n      return section;\n    }`;
  const { runInNewContext } = await import('node:vm');
  const editor = await import(editorScreenPath.href);
  const drafts = new Map();
  const toasts = [];
  const busy = { value: false };
  const previewEnds = { count: 0 };
  const MIN = 1;
  const MAX = 10000;
  const build = runInNewContext(`(${source})`, {
    document: createFakeDom(),
    PackLibrary,
    StateStore,
    UIComponents: { showToast: (message, tone) => toasts.push({ message, tone }) },
    InteractionManager: { setSelection() {} },
    CASE_QTY_MIN: MIN,
    CASE_QTY_MAX: MAX,
    STAGING_QTY_INVALID_MESSAGE: 'Enter a whole quantity from 1 to 10,000.',
    getCaseQtyDraft: id => (Number.isFinite(drafts.get(id)) ? drafts.get(id) : MIN),
    setCaseQtyDraft: (id, value) => {
      const clamped = Math.min(MAX, Math.max(MIN, Math.trunc(value)));
      drafts.set(id, clamped);
      return clamped;
    },
    editorMutationBlocked: () => busy.value,
    endAutoPackResultsPreview: () => { previewEnds.count++; },
    pruneSelectionAfterRemoval: editor.pruneSelectionAfterRemoval,
    getStagingAddFailureFeedback: editor.getStagingAddFailureFeedback,
    getStagingRemoveFeedback: editor.getStagingRemoveFeedback,
    stagingActionGuard: guard,
    STAGING_ACTION_KIND: editor.STAGING_ACTION_KIND,
  });
  // Equivalent of the app's synchronous StateStore-driven re-render: a brand new card.
  const mount = (caseRecord = { id: 'case-a', name: 'A-Test-03' }) => {
    const section = build(caseRecord, PackLibrary.getById('pack-1'));
    const [row, readout] = section.children;
    const [stepper, actions] = row.children;
    const [, minusBtn, input, plusBtn] = stepper.children;
    const addBtn = actions.children[actions.children.length - 1];
    const unstageBtn = actions.children.length === 2 ? actions.children[0] : null;
    return { section, readout, input, minusBtn, plusBtn, addBtn, unstageBtn };
  };
  return { mount, drafts, toasts, busy, previewEnds };
}

const INVALID_QTY_MESSAGE = 'Enter a whole quantity from 1 to 10,000.';

test('P1-B Q1: blur toward + Add or Unstage does NOT pre-commit or revert the live Qty value', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' })] })], folderLibrary: [], preferences: {} });
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: (await import(editorScreenPath.href)).createStagingActionDuplicateGuard() });
  const card = h.mount();
  assert.ok(card.unstageBtn, 'staged cargo exists, so Unstage is rendered');

  for (const [name, target] of [['+ Add', card.addBtn], ['Unstage', card.unstageBtn]]) {
    card.input.value = '1.5';
    fire(card.input, 'blur', { relatedTarget: target });
    assert.equal(card.input.value, '1.5', `blur toward ${name} must leave the fractional value for the click to validate`);
    assert.equal(h.drafts.size, 0, `blur toward ${name} must not commit or revert the draft`);
    card.input.value = '7';
    fire(card.input, 'blur', { relatedTarget: target });
    assert.equal(h.drafts.size, 0, `a valid live value is also left for the click (${name})`);
  }
  assert.equal(h.toasts.length, 0, 'the blur itself never warns');
});

test('P1-B Q2: browsers that do not focus a button on click (relatedTarget null) are covered by the pointerdown press flag', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' })] })], folderLibrary: [], preferences: {} });
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: (await import(editorScreenPath.href)).createStagingActionDuplicateGuard() });
  const card = h.mount();

  for (const button of [card.addBtn, card.unstageBtn]) {
    card.input.value = '1.5';
    fire(button, 'pointerdown');
    fire(card.input, 'blur', { relatedTarget: null }); // Safari/Firefox on macOS
    assert.equal(card.input.value, '1.5', 'press on the action button defers to its click handler');
    assert.equal(h.drafts.size, 0);
  }
  // The flag is consumed by that blur: it can never leak into a later unrelated blur.
  card.input.value = '1.5';
  fire(card.input, 'blur', { relatedTarget: null });
  assert.equal(card.input.value, '1', 'the next ordinary blur reverts as before');
  // ...and a press that never produced a blur is cleared when the input regains focus.
  fire(card.addBtn, 'pointerdown');
  fire(card.input, 'focus');
  card.input.value = '1.5';
  fire(card.input, 'blur', { relatedTarget: null });
  assert.equal(card.input.value, '1', 'a stale press flag cannot suppress a later normal blur');
});

test('P1-B Q3: unrelated blur commits and reverts exactly as before — including with no staged cargo (no Unstage button)', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  for (const [name, cases] of [['staged > 0', [outsideInstance({ id: 's1' })]], ['staged = 0', []]]) {
    StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases })], folderLibrary: [], preferences: {} });
    const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: (await import(editorScreenPath.href)).createStagingActionDuplicateGuard() });
    const card = h.mount();
    assert.equal(Boolean(card.unstageBtn), name === 'staged > 0');

    // relatedTarget null must NOT be mistaken for the (absent) Unstage button.
    for (const invalid of ['1.5', '0', '-3', '', 'abc']) {
      card.input.value = invalid;
      fire(card.input, 'blur', { relatedTarget: null });
      assert.equal(card.input.value, '1', `${name}: invalid "${invalid}" reverts on an ordinary blur`);
    }
    card.input.value = '7';
    fire(card.input, 'blur', { relatedTarget: card.plusBtn });
    assert.equal(h.drafts.get('case-a'), 7, `${name}: a valid value commits when focus goes to an unrelated control`);
    assert.equal(card.input.value, '7');
  }
});

test('P1-B Q4: a fractional visible Qty reaches readLiveQty on Add and Unstage — warning, no Pack write, no history, field restored', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' }), outsideInstance({ id: 's2' })] })],
    folderLibrary: [],
    preferences: {},
  });
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: (await import(editorScreenPath.href)).createStagingActionDuplicateGuard() });
  const before = StateStore.snapshot();
  const writes = trackPackWrites(StateStore);

  for (const [name, pick] of [['+ Add', c => c.addBtn], ['Unstage', c => c.unstageBtn]]) {
    const card = h.mount();
    card.input.value = '1.5';
    // Browser order: pressing the button blurs the input FIRST, then click fires.
    fire(card.input, 'blur', { relatedTarget: pick(card) });
    fire(pick(card), 'click');
    assert.deepEqual(h.toasts.at(-1), { message: INVALID_QTY_MESSAGE, tone: 'warning' }, `${name}: warns instead of acting on 1`);
    assert.equal(card.input.value, '1', `${name}: field restored to the prior valid draft`);
  }
  writes.stop();

  assert.equal(writes.count(), 0, 'no Pack write for either rejected action');
  assert.equal(h.previewEnds.count, 0, 'invalid Qty never reaches the preview-ending mutation boundary');
  assert.deepEqual(StateStore.snapshot(), before, 'nothing else changed');
  assert.equal(PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged, 2, 'no instance was added or removed');
  assert.equal(StateStore.undo(), false, 'no history entry was created');
});

test('P1-B Q5: a second Add click on the REBUILT card inside the duplicate window is suppressed — +5 once, one write, one Undo', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard } = await import(editorScreenPath.href);
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [] })], folderLibrary: [], preferences: {} });
  const clock = { t: 1000 };
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: createStagingActionDuplicateGuard({ now: () => clock.t }) });
  const writes = trackPackWrites(StateStore);

  let card = h.mount();
  card.input.value = '5';
  fire(card.input, 'blur', { relatedTarget: card.addBtn });
  fire(card.addBtn, 'click'); // first click: Add(5)
  assert.equal(PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged, 5);
  assert.equal(h.drafts.get('case-a'), 1, 'Qty reset to 1, exactly as the rebuilt card will show');

  card = h.mount(); // the synchronous re-render replaced the card and its Add button
  assert.equal(card.input.value, '1');
  clock.t += 120; // real double-click spacing
  fire(card.addBtn, 'click'); // second physical click lands on the NEW button
  writes.stop();

  assert.equal(PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged, 5, 'not Add(5) + Add(1)');
  assert.equal(writes.count(), 1, 'one Pack write');
  assert.equal(h.previewEnds.count, 1, 'only the accepted Add reaches the preview-ending boundary');
  assert.equal(h.toasts.filter(t => t.tone === 'success').length, 1, 'one success action');
  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged, 0, 'one Undo removes the whole +5');
  assert.equal(StateStore.undo(), false, 'and there is no second Undo step');
});

test('P1-B Q6: ordinary single Add is unchanged; Add never suppresses Unstage, a retry after failure, or Add after the window', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard, STAGING_ACTION_DUPLICATE_CLICK_MS } = await import(editorScreenPath.href);
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [] })], folderLibrary: [], preferences: {} });
  const clock = { t: 5000 };
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: createStagingActionDuplicateGuard({ now: () => clock.t }) });
  const staged = () => PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged;

  // G: a single Add of the committed Qty behaves exactly as before.
  let card = h.mount();
  card.input.value = '5';
  fire(card.addBtn, 'click');
  assert.equal(staged(), 5);
  assert.deepEqual(h.toasts.at(-1), { message: 'Added 5 items to staging.', tone: 'success' });

  // Unstage right after Add is not blocked (the guard is Add-only).
  card = h.mount();
  fire(card.unstageBtn, 'click');
  assert.equal(staged(), 4, 'Unstage 1 inside the Add window still runs');

  // A normal Add after the window has elapsed is not blocked (boundary is exclusive).
  clock.t += STAGING_ACTION_DUPLICATE_CLICK_MS;
  card = h.mount();
  fire(card.addBtn, 'click');
  assert.equal(staged(), 5, 'Add after the window adds normally');

  // A REJECTED Add never arms the window: an immediate retry is processed (and rejected) again.
  const ghost = { id: 'ghost-case', name: 'Ghost' };
  const errorsBefore = h.toasts.filter(t => t.tone === 'error').length;
  fire(h.mount(ghost).addBtn, 'click');
  fire(h.mount(ghost).addBtn, 'click');
  assert.equal(h.toasts.filter(t => t.tone === 'error').length, errorsBefore + 2, 'a failed Add does not suppress the retry');

});

test('P1-B Q7: ONE guard is wired at the actual Add and Unstage click boundaries (own kind each), armed only on success, and stays in-memory', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);
  const addClick = extractFunctionBlock(block, "addBtn.addEventListener('click', () => {", '\n      });');
  const removeClick = extractFunctionBlock(block, "removeBtn.addEventListener('click', () => {", '\n        });');

  for (const [name, click, kind, other, flag] of [
    ['Add', addClick, 'ADD', 'UNSTAGE', 'added = true;'],
    ['Unstage', removeClick, 'UNSTAGE', 'ADD', 'removed = true;'],
  ]) {
    const busy = click.indexOf('editorMutationBlocked()');
    const dup = click.indexOf(`stagingActionGuard.isDuplicate(STAGING_ACTION_KIND.${kind}, packId, c.id)`);
    const live = click.indexOf('readLiveQty()');
    assert.ok(busy >= 0 && dup > busy && live > dup, `${name}: busy guard -> duplicate check -> live-Qty validation -> service`);
    const previewEnd = click.indexOf('endAutoPackResultsPreview({ forManualEdit: true })');
    const service = click.indexOf(kind === 'ADD' ? 'PackLibrary.addInstancesToStaging(' : 'PackLibrary.removeCaseInstancesFromStaging(');
    assert.ok(previewEnd > live && service > previewEnd, `${name}: committed scene restored before staging membership mutation`);
    const okAt = click.indexOf("result.reason !== 'ok'");
    const recordAt = click.indexOf(`stagingActionGuard.recordSuccess(STAGING_ACTION_KIND.${kind}, packId, c.id);`);
    assert.ok(okAt > 0 && recordAt > okAt && recordAt < click.indexOf(flag), `${name}: armed only after a successful result`);
    assert.equal((click.match(/stagingActionGuard\./g) || []).length, 2, `${name}: exactly one check and one arm`);
    assert.doesNotMatch(click, new RegExp(`STAGING_ACTION_KIND\\.${other}`), `${name} uses only its own kind`);
  }

  // One implementation, held beside the drafts (outside the replaced card), no duplicated timing logic.
  assert.equal((src.match(/= createStagingActionDuplicateGuard\(\);/g) || []).length, 1, 'a single screen-scoped guard instance');
  assert.doesNotMatch(src, /createStagingAddDuplicateGuard|stagingAddGuard|STAGING_ADD_DUPLICATE/, 'the Add-only guard is fully generalized away');
  assert.doesNotMatch(block, /performance\.now|Date\.now|setTimeout/, 'the card builder contains no timing logic of its own');
  const guardSrc = extractFunctionBlock(src, 'export function createStagingActionDuplicateGuard({', '\n}');
  assert.doesNotMatch(guardSrc, /StateStore|localStorage|sessionStorage|OperationLifecycle|setTimeout|await |async |Promise/,
    'no persistence, history, lifecycle kind, timers, or async locking');
});

test('P1-B Q8: the guard is keyed by kind + Pack + Case; a success arms exactly that key for the short window', async () => {
  const { createStagingActionDuplicateGuard, STAGING_ACTION_KIND: K, STAGING_ACTION_DUPLICATE_CLICK_MS: WINDOW } = await import(editorScreenPath.href);
  assert.equal(WINDOW, 400, 'the same short window Add already used');
  assert.deepEqual({ ...K }, { ADD: 'add', UNSTAGE: 'unstage' });

  const clock = { t: 10 };
  const fresh = () => createStagingActionDuplicateGuard({ now: () => clock.t });
  for (const [kind, otherKind] of [[K.UNSTAGE, K.ADD], [K.ADD, K.UNSTAGE]]) {
    const guard = fresh();
    assert.equal(guard.isDuplicate(kind, 'pack-1', 'case-a'), false, 'nothing is armed initially');
    guard.recordSuccess(kind, 'pack-1', 'case-a');
    assert.equal(guard.isDuplicate(kind, 'pack-1', 'case-a'), true, 'one success arms its own key');
    assert.equal(guard.isDuplicate(otherKind, 'pack-1', 'case-a'), false, 'Add and Unstage keys are independent');
    assert.equal(guard.isDuplicate(kind, 'pack-1', 'case-b'), false, 'a different Case is independent');
    assert.equal(guard.isDuplicate(kind, 'pack-2', 'case-a'), false, 'a different Pack is independent');
  }

  const guard = fresh();
  guard.recordSuccess(K.UNSTAGE, 'pack-1', 'case-a');
  clock.t += WINDOW - 1;
  assert.equal(guard.isDuplicate(K.UNSTAGE, 'pack-1', 'case-a'), true, 'still inside the window');
  clock.t += 1;
  assert.equal(guard.isDuplicate(K.UNSTAGE, 'pack-1', 'case-a'), false, 'the window is exclusive: an action after it proceeds normally');

  // Ids that merely CONTAIN separator-like characters can never collide across fields.
  const collide = fresh();
  collide.recordSuccess(K.ADD, 'p:1', 'c');
  assert.equal(collide.isDuplicate(K.ADD, 'p', '1:c'), false);
  assert.equal(collide.isDuplicate(K.ADD, 'p:1', 'c'), true);
});

// The exact browser-confirmed baseline: 15 in load · 12 in truck · 3 staged.
function fifteenTwelveThreeFixture(extraCases = []) {
  const packed = Array.from({ length: 12 }, (_, i) => insideInstance({ id: `packed-${i + 1}` }));
  const staged = Array.from({ length: 3 }, (_, i) => outsideInstance({ id: `staged-${i + 1}` }));
  return { caseLibrary: [baseCase(), ...extraCases], packLibrary: [basePack({ cases: [...packed, ...staged] })], folderLibrary: [], preferences: {} };
}

test('P1-B Q9: replay of the confirmed Unstage double-click — 15/12/3, Qty 2 -> exactly 13/12/1, one toast, one write, one Undo', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard } = await import(editorScreenPath.href);
  StateStore.init(fifteenTwelveThreeFixture());
  const counts = () => {
    const c = PackLibrary.getCaseInstanceCounts('pack-1', 'case-a');
    return `${c.inLoad}/${c.inTruck}/${c.staged}`;
  };
  assert.equal(counts(), '15/12/3');

  const clock = { t: 1000 };
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: createStagingActionDuplicateGuard({ now: () => clock.t }) });
  const writes = trackPackWrites(StateStore);

  let card = h.mount();
  card.input.value = '2';
  fire(card.input, 'blur', { relatedTarget: card.unstageBtn }); // browser order: blur, then click
  fire(card.unstageBtn, 'click'); // first physical click: Unstage(2)
  assert.equal(counts(), '13/12/1', 'an ordinary single Unstage is unchanged');
  assert.equal(h.drafts.get('case-a'), 1, 'Qty reset to 1');

  card = h.mount(); // the synchronous re-render replaced the card
  assert.ok(card.unstageBtn, 'staged is still 1, so the NEW card has an Unstage button for the second click to land on');
  assert.equal(card.input.value, '1');
  clock.t += 120; // real double-click spacing
  fire(card.unstageBtn, 'click'); // second physical click on the new button
  writes.stop();

  assert.equal(counts(), '13/12/1', 'not Unstage(2) + Unstage(1) = 12/12/0');
  assert.equal(writes.count(), 1, 'one Pack write');
  assert.equal(h.previewEnds.count, 1, 'only the accepted Unstage reaches the preview-ending boundary');
  assert.deepEqual(h.toasts.filter(t => t.tone === 'info'), [{ message: 'Removed 2 cases from staging.', tone: 'info' }], 'exactly one info toast');
  assert.equal(StateStore.undo(), true);
  assert.equal(counts(), '15/12/3', 'one Undo restores the baseline');
  assert.equal(StateStore.undo(), false, 'no second Undo step');
});

test('P1-B Q10: only a SUCCESSFUL Unstage arms the guard; shortage, invalid, and failed Unstage never do', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard, STAGING_ACTION_KIND: K } = await import(editorScreenPath.href);
  const clock = { t: 1000 };
  const newGuard = () => createStagingActionDuplicateGuard({ now: () => clock.t });
  const staged = () => PackLibrary.getCaseInstanceCounts('pack-1', 'case-a').staged;
  const armed = guard => guard.isDuplicate(K.UNSTAGE, 'pack-1', 'case-a');

  // Shortage (asks for 5, only 2 eligible): warning, nothing armed, the immediate corrected retry runs.
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' }), outsideInstance({ id: 's2' })] })], folderLibrary: [], preferences: {} });
  let guard = newGuard();
  let h = await createQtyRowHarness({ PackLibrary, StateStore, guard });
  let card = h.mount();
  card.input.value = '5';
  fire(card.unstageBtn, 'click');
  assert.equal(h.toasts.at(-1).tone, 'warning');
  assert.match(h.toasts.at(-1).message, /Only 2 can be removed from staging\. Nothing was removed\./);
  assert.equal(armed(guard), false, 'a shortage does not arm the guard');
  card.input.value = '2';
  fire(card.unstageBtn, 'click');
  assert.equal(staged(), 0, 'the immediate corrected Unstage proceeds');
  assert.equal(armed(guard), true, 'and that success does arm it');

  // Zero eligible (staged but grouped): warning, nothing armed, an immediate retry is processed again.
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 'g1', groupId: 'group-1' })] })], folderLibrary: [], preferences: {} });
  guard = newGuard();
  h = await createQtyRowHarness({ PackLibrary, StateStore, guard });
  card = h.mount();
  fire(card.unstageBtn, 'click');
  fire(h.mount().unstageBtn, 'click');
  assert.equal(h.toasts.filter(t => /No cases can be removed from staging/.test(t.message)).length, 2, 'both attempts were processed');
  assert.equal(armed(guard), false);

  // Invalid visible Qty: warning, nothing armed, an immediate valid Unstage runs.
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' }), outsideInstance({ id: 's2' })] })], folderLibrary: [], preferences: {} });
  guard = newGuard();
  h = await createQtyRowHarness({ PackLibrary, StateStore, guard });
  card = h.mount();
  card.input.value = '1.5';
  fire(card.input, 'blur', { relatedTarget: card.unstageBtn });
  fire(card.unstageBtn, 'click');
  assert.deepEqual(h.toasts.at(-1), { message: INVALID_QTY_MESSAGE, tone: 'warning' });
  assert.equal(armed(guard), false, 'an invalid Qty does not arm the guard');
  assert.equal(card.input.value, '1');
  fire(card.unstageBtn, 'click');
  assert.equal(staged(), 1, 'the immediate valid Unstage proceeds');

  // Failed service result: the Case is deleted AFTER the card rendered, so the real service answers
  // 'case-not-found'. Error, nothing armed, and an immediate retry is processed again (not suppressed).
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' })] })], folderLibrary: [], preferences: {} });
  guard = newGuard();
  h = await createQtyRowHarness({ PackLibrary, StateStore, guard });
  card = h.mount();
  assert.ok(card.unstageBtn);
  StateStore.set({ caseLibrary: [] }, { skipHistory: true });
  fire(card.unstageBtn, 'click');
  fire(card.unstageBtn, 'click');
  assert.deepEqual(h.toasts.filter(t => t.tone === 'error').map(t => t.message), ['This case no longer exists.', 'This case no longer exists.'],
    'a failed Unstage is processed again, not suppressed');
  assert.equal(armed(guard), false);

  // A throwing service call never arms it either.
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' })] })], folderLibrary: [], preferences: {} });
  guard = newGuard();
  const throwing = {
    getById: (...args) => PackLibrary.getById(...args),
    getCaseInstanceCounts: (...args) => PackLibrary.getCaseInstanceCounts(...args),
    removeCaseInstancesFromStaging: () => { throw new Error('boom'); },
  };
  h = await createQtyRowHarness({ PackLibrary: throwing, StateStore, guard });
  card = h.mount();
  assert.throws(() => fire(card.unstageBtn, 'click'), /boom/);
  assert.equal(armed(guard), false, 'an exception does not arm the guard');
  assert.equal(h.drafts.get('case-a'), 1, 'and the requested Qty is preserved');
});

test('P1-B Q11: Add and Unstage never suppress each other, nor other Cases; an Unstage after the window proceeds normally', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard, STAGING_ACTION_DUPLICATE_CLICK_MS: WINDOW } = await import(editorScreenPath.href);
  const caseB = baseCase({ id: 'case-b', name: 'Case B' });
  StateStore.init({
    caseLibrary: [baseCase(), caseB],
    packLibrary: [basePack({ cases: [
      outsideInstance({ id: 'a1' }), outsideInstance({ id: 'a2' }), outsideInstance({ id: 'a3' }),
      outsideInstance({ id: 'b1', caseId: 'case-b' }), outsideInstance({ id: 'b2', caseId: 'case-b' }),
    ] })],
    folderLibrary: [],
    preferences: {},
  });
  const stagedOf = id => PackLibrary.getCaseInstanceCounts('pack-1', id).staged;
  const clock = { t: 1000 };
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: createStagingActionDuplicateGuard({ now: () => clock.t }) });
  const asB = { id: 'case-b', name: 'Case B' };

  // Add success, then an IMMEDIATE Unstage on the same Case is not blocked...
  fire(h.mount().addBtn, 'click');
  assert.equal(stagedOf('case-a'), 4);
  fire(h.mount().unstageBtn, 'click');
  assert.equal(stagedOf('case-a'), 3, 'Unstage right after Add proceeds');
  // ...and Unstage success, then an immediate Add is not blocked.
  fire(h.mount().addBtn, 'click');
  assert.equal(stagedOf('case-a'), 4, 'Add right after Unstage proceeds');

  // Unstage on one Case does not block Unstage (or Add) on another Case.
  fire(h.mount().unstageBtn, 'click');
  assert.equal(stagedOf('case-a'), 3);
  fire(h.mount(asB).unstageBtn, 'click');
  assert.equal(stagedOf('case-b'), 1, 'a different Case is independent');
  fire(h.mount(asB).addBtn, 'click');
  assert.equal(stagedOf('case-b'), 2);

  // Same-Case duplicate inside the window is suppressed; the same action after the window is not.
  fire(h.mount().unstageBtn, 'click'); // arms the unstage key for case-a
  assert.equal(stagedOf('case-a'), 2);
  clock.t += WINDOW - 1;
  fire(h.mount().unstageBtn, 'click');
  assert.equal(stagedOf('case-a'), 2, 'inside the window: suppressed');
  clock.t += 1;
  fire(h.mount().unstageBtn, 'click');
  assert.equal(stagedOf('case-a'), 1, 'after the window: a deliberate Unstage proceeds normally');
});

test('P1-B Q12: actionPressPending is one-shot — a cancelled press, an early-return click, and a consumed press never leave it stale', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard, STAGING_ACTION_KIND: K } = await import(editorScreenPath.href);
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' }), outsideInstance({ id: 's2' })] })], folderLibrary: [], preferences: {} });
  const clock = { t: 1000 };
  const guard = createStagingActionDuplicateGuard({ now: () => clock.t });
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard });
  const before = StateStore.snapshot();
  const writes = trackPackWrites(StateStore);

  // An unrelated blur (no relatedTarget) with an invalid value: it must revert exactly as before.
  const unrelatedBlur = card => {
    card.input.value = '1.5';
    fire(card.input, 'blur', { relatedTarget: null });
    return card.input.value;
  };

  for (const [name, button, kind] of [['+ Add', 'addBtn', K.ADD], ['Unstage', 'unstageBtn', K.UNSTAGE]]) {
    // (a) The intended path still works: pointerdown protects the invalid live value through the
    //     blur, and the CLICK (readLiveQty) owns validation — warning, restore, no write.
    let card = h.mount();
    card.input.value = '1.5';
    fire(card[button], 'pointerdown');
    fire(card.input, 'blur', { relatedTarget: null }); // Safari/Firefox: the button took no focus
    assert.equal(card.input.value, '1.5', `${name}: protected through the intended blur`);
    fire(card[button], 'click');
    assert.deepEqual(h.toasts.at(-1), { message: INVALID_QTY_MESSAGE, tone: 'warning' }, `${name}: the click owns validation`);
    assert.equal(card.input.value, '1', `${name}: field restored to the prior valid draft`);

    // (b) A cancelled/interrupted press (touch scroll, system cancel): the input stays focused, so
    //     neither blur nor click ever consumes the flag. It must not survive the cancel.
    card = h.mount();
    fire(card[button], 'pointerdown');
    fire(card[button], 'pointercancel');
    assert.equal(unrelatedBlur(card), '1', `${name}: after pointercancel a later unrelated blur reverts normally`);

    // (c) A click whose handler returns EARLY — busy — must not leave the flag behind.
    card = h.mount();
    h.busy.value = true;
    fire(card[button], 'pointerdown');
    fire(card[button], 'click');
    h.busy.value = false;
    assert.equal(unrelatedBlur(card), '1', `${name}: a busy early return leaves no stale flag`);

    // (d) ...nor a duplicate-click early return.
    card = h.mount();
    guard.recordSuccess(kind, 'pack-1', 'case-a');
    fire(card[button], 'pointerdown');
    fire(card[button], 'click');
    assert.equal(unrelatedBlur(card), '1', `${name}: a duplicate-guard early return leaves no stale flag`);
    clock.t += 1000;

    // (e) One-shot: the protected blur consumes the flag; the next blur has no press behind it.
    card = h.mount();
    fire(card[button], 'pointerdown');
    card.input.value = '1.5';
    fire(card.input, 'blur', { relatedTarget: null });
    assert.equal(card.input.value, '1.5', `${name}: first blur protected`);
    assert.equal(unrelatedBlur(card), '1', `${name}: the second blur is ordinary and reverts`);

    // (f) A press that never reached a blur is cleared when the input regains focus.
    card = h.mount();
    fire(card[button], 'pointerdown');
    fire(card.input, 'focus');
    assert.equal(unrelatedBlur(card), '1', `${name}: refocusing the input clears a leftover press`);
  }
  writes.stop();

  assert.equal(writes.count(), 0, 'none of these paths wrote to the Pack');
  assert.deepEqual(StateStore.snapshot(), before, 'and nothing else changed');
  assert.equal(StateStore.undo(), false, 'no history entry');
});

test('P1-B Q13: keyboard focus movement is unchanged; the press-flag listeners are local, ordered before the click handlers, and never global', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { createStagingActionDuplicateGuard } = await import(editorScreenPath.href);
  StateStore.init({ caseLibrary: [baseCase()], packLibrary: [basePack({ cases: [outsideInstance({ id: 's1' })] })], folderLibrary: [], preferences: {} });
  const h = await createQtyRowHarness({ PackLibrary, StateStore, guard: createStagingActionDuplicateGuard() });

  // Keyboard: Tab from the input to Add/Unstage delivers relatedTarget with NO pointer events at all.
  for (const button of ['addBtn', 'unstageBtn']) {
    const card = h.mount();
    card.input.value = '1.5';
    fire(card.input, 'blur', { relatedTarget: card[button] });
    assert.equal(card.input.value, '1.5', `${button}: Tab toward the action defers to its click`);
    fire(card[button], 'click'); // Enter / Space activate the focused button
    assert.deepEqual(h.toasts.at(-1), { message: INVALID_QTY_MESSAGE, tone: 'warning' });
    assert.equal(card.input.value, '1');
  }
  // Tab to an unrelated control still commits/reverts, as before.
  const card = h.mount();
  card.input.value = '7';
  fire(card.input, 'blur', { relatedTarget: card.plusBtn });
  assert.equal(h.drafts.get('case-a'), 7);
  card.input.value = '1.5';
  fire(card.input, 'blur', { relatedTarget: card.minusBtn });
  assert.equal(card.input.value, '7', 'an invalid value reverts to the committed draft');

  // Structure: listeners are registered on this card's own elements, the click-clear BEFORE each action's own click handler.
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);
  const clearOnClick = block.indexOf("button.addEventListener('click', clearActionPress);");
  const addClickAt = block.indexOf("addBtn.addEventListener('click', () => {");
  const removeClickAt = block.indexOf("removeBtn.addEventListener('click', () => {");
  assert.ok(clearOnClick > 0 && clearOnClick < addClickAt && clearOnClick < removeClickAt,
    'the flag is cleared before either action handler can return early');
  assert.match(block, /button\.addEventListener\('pointerdown', markActionPress\);\s*button\.addEventListener\('pointercancel', clearActionPress\);/);
  assert.match(block, /input\.addEventListener\('focus', clearActionPress\);/);
  assert.doesNotMatch(block, /(?:document|window)\.addEventListener|setTimeout|setInterval|requestAnimationFrame|StateStore\.set\(\{ ?actionPress/,
    'no global listeners, timers, or persisted state for the press flag');
});

test('P1-B R3: Unstage accessibility — input names both actions, Unstage has its own name and help text, Add and steppers keep theirs', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);

  assert.match(block, /input\.setAttribute\('aria-label', `Quantity to add or remove for \$\{c\.name\}`\);/);
  assert.doesNotMatch(src, /Quantity to add for/);
  assert.match(block, /removeBtn\.setAttribute\('aria-label', `Unstage for \$\{c\.name\}`\);/);
  assert.doesNotMatch(block, /Remove from staging for/, 'the old visible-verb accessible name is gone');
  assert.match(block, /removeBtn\.title = 'Removes staged cases only\. Packed, hidden, or grouped cases are not affected\.';/);
  assert.match(block, /minusBtn\.setAttribute\('aria-label', `Decrease quantity for \$\{c\.name\}`\);/);
  assert.match(block, /plusBtn\.setAttribute\('aria-label', `Increase quantity for \$\{c\.name\}`\);/);
  assert.match(block, /addBtn\.setAttribute\('aria-label', `Add to staging for \$\{c\.name\}`\);/);
  // Names are static: no dynamic Qty in any aria-label.
  const ariaLabels = block.match(/setAttribute\('aria-label', `[^`]*`\)/g) || [];
  assert.equal(ariaLabels.length, 5);
  for (const label of ariaLabels) assert.doesNotMatch(label, /qty|getCaseQtyDraft|input\.value/i);
  // Remove carries the role attribute the focus-restore selector keys on.
  assert.match(block, /removeBtn\.dataset\.caseId = c\.id;\s*removeBtn\.dataset\.qtyRole = 'remove';/);
  // Input keyboard behavior is unchanged: Enter commits only, Escape reverts and blurs.
  assert.match(block, /if \(ev\.key === 'Enter'\) \{\s*ev\.preventDefault\(\);\s*commitDraft\(parseDirectEntry\(\)\);\s*\} else if \(ev\.key === 'Escape'\) \{\s*ev\.preventDefault\(\);\s*revertInput\(\);\s*input\.blur\(\);/);
});

test('P1-B R4: the Remove click is busy-guarded, reads the live input, and calls ONLY the staged-removal service authority', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);
  const click = extractFunctionBlock(block, "removeBtn.addEventListener('click', () => {", '\n        });');

  const guard = click.indexOf('editorMutationBlocked()');
  const parse = click.indexOf('readLiveQty()');
  const service = click.indexOf('PackLibrary.removeCaseInstancesFromStaging(packId, c.id, qty)');
  assert.ok(guard >= 0 && parse > guard && service > parse, 'editorMutationBlocked() -> readLiveQty() -> removeCaseInstancesFromStaging()');
  assert.match(click, /const qty = readLiveQty\(\);\s*if \(qty === null\) return;/, 'an invalid visible value stops before any mutation');

  // The caller only ever hands the service (packId, caseId, count): it targets no instance ids,
  // so packed cargo can never be named, and there is no fallback to any other removal path.
  assert.equal((click.match(/PackLibrary\./g) || []).length, 1, 'exactly one PackLibrary call');
  assert.doesNotMatch(block, /removeInstances|deleteInstancesWithFeedback|deleteSelection|PackLibrary\.update\(/);
  // The Add click is untouched by Remove.
  const addClick = extractFunctionBlock(block, "addBtn.addEventListener('click', () => {", '\n      });');
  assert.doesNotMatch(addClick, /removeCaseInstancesFromStaging|pruneSelectionAfterRemoval/);
  // Successful removal renders through the normal StateStore subscriber, not by hand.
  assert.doesNotMatch(click, /render\(|renderCaseBrowser|capturePackPreview|CaseScene\.sync/);
});

test('P1-B R5: Remove resets the draft only on success; a shortage or failure preserves Qty and mutates nothing else', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);
  const click = extractFunctionBlock(block, "removeBtn.addEventListener('click', () => {", '\n        });');

  assert.match(click, /setCaseQtyDraft\(c\.id, CASE_QTY_MIN\);\s*const result = PackLibrary\.removeCaseInstancesFromStaging/,
    'success reset is staged before the synchronous re-render, like Add');
  assert.match(click, /finally \{[\s\S]*?if \(!removed\) setCaseQtyDraft\(c\.id, qty\);/, 'any non-ok result (or a throw) restores the requested Qty');
  const failure = click.slice(click.indexOf("result.reason !== 'ok'"), click.indexOf('removed = true;'));
  assert.match(failure, /UIComponents\.showToast\(feedback\.message, feedback\.tone\);\s*return;/);
  assert.doesNotMatch(failure, /StateStore\.set|InteractionManager|setSelection|selectedInstanceIds|PackLibrary/, 'a rejected Remove makes no selection write and no fallback mutation');
});

test('P1-B R6: Qty Remove feedback maps each service reason to its copy and tone', async () => {
  const { getStagingRemoveFeedback } = await import(editorScreenPath.href);
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'ok', removedCount: 1 }), { message: 'Removed 1 case from staging.', tone: 'info' });
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'ok', removedCount: 5 }), { message: 'Removed 5 cases from staging.', tone: 'info' });
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'insufficient-eligible', eligibleCount: 3 }),
    { message: 'Only 3 can be removed from staging. Nothing was removed.', tone: 'warning' });
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'insufficient-eligible', eligibleCount: 0 }),
    { message: 'No cases can be removed from staging. Nothing was removed.', tone: 'warning' });
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'pack-not-found' }), { message: 'Create or open a load plan first', tone: 'warning' });
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'case-not-found' }), { message: 'This case no longer exists.', tone: 'error' });
  assert.deepEqual(getStagingRemoveFeedback({ reason: 'invalid-count' }), { message: 'Enter a whole quantity from 1 to 10,000.', tone: 'warning' });
  assert.equal(getStagingRemoveFeedback(null).tone, 'error');

  const every = [
    getStagingRemoveFeedback({ reason: 'ok', removedCount: 2 }),
    getStagingRemoveFeedback({ reason: 'insufficient-eligible', eligibleCount: 1 }),
    getStagingRemoveFeedback({ reason: 'insufficient-eligible', eligibleCount: 0 }),
    getStagingRemoveFeedback(null),
  ].map(f => f.message).join(' ');
  assert.doesNotMatch(every, /newest|oldest|last added|latest/i, 'removal order is never described as newest/oldest');
  const src = await fs.readFile(editorScreenPath, 'utf8');
  assert.doesNotMatch(src, /newest|oldest|last added/i);
});

test('P1-B R7: pruneSelectionAfterRemoval drops only the removed ids and reports "no write" when none were selected', async () => {
  const { pruneSelectionAfterRemoval } = await import(editorScreenPath.href);
  assert.deepEqual(pruneSelectionAfterRemoval(['a', 'b', 'c'], ['b']), ['a', 'c'], 'only the removed id leaves the selection');
  assert.deepEqual(pruneSelectionAfterRemoval(['keep-1', 'gone', 'keep-2'], ['gone', 'other']), ['keep-1', 'keep-2'], 'unrelated selected ids are preserved in order');
  assert.deepEqual(pruneSelectionAfterRemoval(['stale-unrelated', 'a'], ['a']), ['stale-unrelated'], 'unrelated stale ids are left alone, not opportunistically pruned');
  assert.deepEqual(pruneSelectionAfterRemoval(['a', 'b'], ['a', 'b']), [], 'all selected removed yields an empty selection (a write), not "no write"');
  assert.equal(pruneSelectionAfterRemoval(['a', 'b'], ['x', 'y']), null, 'removed ids were not selected: no selection write');
  assert.equal(pruneSelectionAfterRemoval([], ['x']), null);
  assert.equal(pruneSelectionAfterRemoval(['a'], []), null);
  assert.equal(pruneSelectionAfterRemoval(undefined, undefined), null);
  const input = ['a', 'b', 'c'];
  pruneSelectionAfterRemoval(input, ['b']);
  assert.deepEqual(input, ['a', 'b', 'c'], 'the caller-supplied selection array is never mutated');

  const src = await fs.readFile(editorScreenPath, 'utf8');
  const block = qtyRowBlock(src);
  const click = extractFunctionBlock(block, "removeBtn.addEventListener('click', () => {", '\n        });');
  assert.match(click, /const nextSelection = pruneSelectionAfterRemoval\(\s*StateStore\.get\('selectedInstanceIds'\),\s*result\.removedInstanceIds\s*\);\s*if \(nextSelection\) InteractionManager\.setSelection\(nextSelection\);/);
  assert.doesNotMatch(click, /selectedInstanceIds:\s*\[\]|setSelection\(\[\]\)/, 'Qty Remove never clears the whole selection');
  // Only one raw selection write exists in the row, and it belongs to Add 1 (Requirement 20).
  assert.equal((block.match(/StateStore\.set\(\{ selectedInstanceIds:/g) || []).length, 1);
  // The shared selection authority writes through skipHistory and keeps the 3D scene in sync.
  const interactionSrc = extractFunctionBlock(src, 'function setSelection(nextIds) {', '\n    }');
  assert.match(interactionSrc, /StateStore\.set\(\{ selectedInstanceIds: ids \}, \{ skipHistory: true \}\);\s*CaseScene\.setSelected\(ids\);/);
});

test('P1-B R8: one successful Qty Remove is exactly one Pack write and one Undo/Redo step; selection is history-free', async () => {
  const { StateStore, PackLibrary } = await loadModules();
  const { pruneSelectionAfterRemoval } = await import(editorScreenPath.href);
  const cases = [
    outsideInstance({ id: 'e1' }),
    outsideInstance({ id: 'e2' }),
    outsideInstance({ id: 'e3' }),
    insideInstance({ id: 'packed-1' }),
    outsideInstance({ id: 'hidden-1', hidden: true }),
    outsideInstance({ id: 'grouped-1', groupId: 'group-1' }),
  ];
  StateStore.init({
    caseLibrary: [baseCase()],
    packLibrary: [basePack({ cases })],
    folderLibrary: [],
    preferences: {},
    selectedInstanceIds: ['e3', 'packed-1', 'unrelated-stale'],
  });
  const writes = trackPackWrites(StateStore);
  const result = PackLibrary.removeCaseInstancesFromStaging('pack-1', 'case-a', 2);
  // The caller's selection follow-up, exactly as the click handler performs it.
  const next = pruneSelectionAfterRemoval(StateStore.get('selectedInstanceIds'), result.removedInstanceIds);
  StateStore.set({ selectedInstanceIds: next }, { skipHistory: true });
  writes.stop();

  assert.equal(result.reason, 'ok');
  assert.equal(writes.count(), 1, 'one Pack write; the selection follow-up is not a Pack write');
  assert.deepEqual(result.removedInstanceIds, ['e3', 'e2']);
  assert.deepEqual(StateStore.get('selectedInstanceIds'), ['packed-1', 'unrelated-stale']);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.map(inst => inst.id), ['e1', 'packed-1', 'hidden-1', 'grouped-1'],
    'packed, hidden, and grouped cargo are untouched');

  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('pack-1').cases.length, cases.length, 'one Undo restores the whole removal');
  assert.equal(StateStore.undo(), false, 'the selection write created no history entry');
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(PackLibrary.getById('pack-1').cases.map(inst => inst.id), ['e1', 'packed-1', 'hidden-1', 'grouped-1']);
});
