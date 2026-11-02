// editor mutation safety: contract tests from the former security suite.

import {
  appPath,
  assert,
  assertPackImportNoOverlaps,
  cardDisplayOverlayPath,
  caseLibraryPath,
  caseModalPath,
  casesScreenPath,
  categoryServicePath,
  coreUtilsIndexPath,
  coreUtilsPath,
  createPackPreviewSchedulerHarness,
  editorScreenPath,
  fs,
  importCasesDialogPath,
  importPackDialogPath,
  indexHtmlPath,
  keyboardManagerPath,
  makePackImportInstance,
  makePackImportSafeCase,
  normalizerPath,
  notesOverlayPath,
  operationLifecyclePath,
  packLibraryPath,
  packsScreenPath,
  previewHarnessViewSignature,
  previewHarnessVisualSignature,
  readAppSource,
  recoverableErrorOverlayPath,
  settingsOverlayPath,
  stateStorePath,
  stylesMainPath,
  test,
  vendorThreePath,
  vm,
} from '../fixtures/security-invariants-support.mjs';
import * as THREE from 'three';
import { createInteractionManager } from '../../src/screens/editor-screen.js';
import { buildAutoPackResultSignature } from '../../src/services/autopack-engine.js';

async function c3Interaction(t, { permission = 'any', rotation = { x: 0, y: 0, z: 0 }, instance = {} } = {}) {
  const previousThree = globalThis.THREE;
  globalThis.THREE = THREE;
  t.after(() => { globalThis.THREE = previousThree; });
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(packLibraryPath.href);
  const CaseLibrary = await import(caseLibraryPath.href);
  const caseData = makePackImportSafeCase({ id: 'c3-case', orientationLock: permission,
    dimensions: { length: 20, width: 10, height: 6 }, weight: 12 });
  const cargo = { id: 'c3-item', caseId: caseData.id, hidden: false, placement: 'staged',
    orientationLocked: false, lockedRotation: null,
    transform: { position: { x: -80, y: 3, z: 90 }, rotation },
    orientedDims: { length: 20, width: 10, height: 6 }, ...instance };
  StateStore.init({ currentScreen: 'editor', currentPackId: 'c3-pack', selectedInstanceIds: [cargo.id],
    caseLibrary: [caseData], packLibrary: [{ id: 'c3-pack', truck: { length: 120, width: 80, height: 80 },
      cases: [cargo], groups: [], lastEdited: 1 }], folderLibrary: [], preferences: {} });
  let preview = false, busy = false;
  const toasts = [];
  const manager = createInteractionManager({ StateStore, PackLibrary, CaseLibrary,
    SceneManager: {}, PreferencesManager: { get: () => ({}) },
    CaseScene: { getObject: () => null, applyOOGHighlights() {}, isTransientPreview: () => preview },
    UIComponents: { showToast: message => toasts.push(message) },
    OperationLifecycle: { isBusy: () => busy },
  });
  return { manager, StateStore, PackLibrary, CaseLibrary, toasts,
    current: () => PackLibrary.getById('c3-pack').cases[0],
    setPreview: value => { preview = value; }, setBusy: value => { busy = value; } };
}

test('C3 manual rotation keeps unlocked planning inactive and derives dimensions from actual pose', async t => {
  const h = await c3Interaction(t);
  h.manager.rotateSelection('y', Math.PI / 2);
  assert.deepEqual(h.current().transform.rotation, { x: 0, y: Math.PI / 2, z: 0 });
  assert.equal(h.current().orientationLocked, false);
  assert.equal(h.current().lockedRotation, null);
  assert.deepEqual(h.current().orientedDims, { length: 10, width: 20, height: 6 });
  h.manager.rotateSelection('x', Math.PI / 2);
  assert.equal(h.current().orientationLocked, false, 'allowed tipping never activates AutoPack planning');
  assert.equal(h.current().lockedRotation, null);
});

test('C3 locked manual rotation updates pose and target in one Undo action; forbidden rotation is inert', async t => {
  const initial = { x: 0, y: 0, z: 0 };
  const h = await c3Interaction(t, { permission: 'upright',
    instance: { orientationLocked: true, lockedRotation: initial } });
  const before = structuredClone(h.current());
  h.manager.rotateSelection('x', Math.PI);
  assert.deepEqual(h.current(), before, 'upside-down rotation is forbidden by signed upright permission');
  h.manager.rotateSelection('y', Math.PI / 2);
  const rotated = structuredClone(h.current());
  assert.equal(rotated.orientationLocked, true);
  assert.deepEqual(rotated.lockedRotation, rotated.transform.rotation);
  assert.deepEqual(rotated.orientedDims, { length: 10, width: 20, height: 6 });
  assert.equal(h.StateStore.undo(), true);
  assert.deepEqual(h.current(), before);
  assert.equal(h.StateStore.redo(), true);
  assert.deepEqual(h.current(), rotated);
  h.manager.rotateSelection('z', Math.PI / 2);
  assert.deepEqual(h.current(), rotated, 'rejected locked rotation changes neither pose nor target');
});

test('C3 manual onSide accepts a side face and refuses authored top or bottom without repairing saved pose', async t => {
  const h = await c3Interaction(t, { permission: 'onSide' });
  const saved = structuredClone(h.current());
  assert.equal(h.manager.setSelectionOrientationConstraint(true), false);
  assert.deepEqual(h.current(), saved, 'forbidden saved pose is preserved');
  h.manager.rotateSelection('x', Math.PI / 2);
  const side = structuredClone(h.current());
  assert.deepEqual(side.transform.rotation, { x: Math.PI / 2, y: 0, z: 0 });
  assert.equal(side.orientationLocked, false);
  assert.equal(side.lockedRotation, null);
  h.manager.rotateSelection('x', Math.PI / 2);
  assert.deepEqual(h.current(), side, 'top or bottom down is refused for onSide');
});

test('C3 UI01 captures only committed single-instance pose and changes planning fields only', async t => {
  const h = await c3Interaction(t, { rotation: { x: 0, y: Math.PI / 2, z: 0 },
    instance: { hidden: true, packedProfile: 'max-capacity',
      orientedDims: { length: 97, width: 98, height: 99 } } });
  const before = structuredClone(h.current());
  const beforeSignature = buildAutoPackResultSignature(h.PackLibrary.getById('c3-pack'));
  for (const guarded of ['preview', 'busy']) {
    h[guarded === 'preview' ? 'setPreview' : 'setBusy'](true);
    assert.equal(h.manager.setSelectionOrientationConstraint(true), false);
    assert.deepEqual(h.current(), before);
    h[guarded === 'preview' ? 'setPreview' : 'setBusy'](false);
  }
  h.StateStore.set({ selectedInstanceIds: ['c3-item', 'another'] }, { skipHistory: true });
  assert.equal(h.manager.setSelectionOrientationConstraint(true), false, 'no bulk activation');
  h.StateStore.set({ selectedInstanceIds: ['c3-item'] }, { skipHistory: true });
  assert.equal(h.manager.setSelectionOrientationConstraint(true, 'stale-selection'), false);
  assert.equal(h.manager.setSelectionOrientationConstraint(true, 'c3-item'), true);
  assert.deepEqual(h.current(), { ...before, orientationLocked: true, lockedRotation: before.transform.rotation });
  assert.notEqual(buildAutoPackResultSignature(h.PackLibrary.getById('c3-pack')), beforeSignature,
    'exact target changes stale the Results signature for staged cargo');
  assert.equal(h.manager.setSelectionOrientationConstraint(false), true);
  assert.deepEqual(h.current(), before, 'release preserves staged position, hidden state, profile and even stored dimensions');
});

test('C3 UI01 refuses forbidden or malformed activation, but releases conflicting and malformed targets', async t => {
  const h = await c3Interaction(t, { permission: 'upright', rotation: { x: Math.PI, y: 0, z: 0 } });
  const before = structuredClone(h.current());
  assert.equal(h.manager.setSelectionOrientationConstraint(true), false);
  assert.deepEqual(h.current(), before);
  for (const target of [{ x: Math.PI, y: 0, z: 0 }, { x: 'bad', y: 0, z: 0 }]) {
    const active = { ...before, orientationLocked: true, lockedRotation: target, placement: 'packed', hidden: true };
    h.PackLibrary.update('c3-pack', { cases: [active] });
    assert.equal(h.manager.setSelectionOrientationConstraint(false), true);
    assert.deepEqual(h.current(), { ...active, orientationLocked: false, lockedRotation: null });
  }
  const malformed = { ...before, transform: { ...before.transform, rotation: { x: 0.17, y: 0, z: 0 } } };
  h.PackLibrary.update('c3-pack', { cases: [malformed] });
  assert.equal(h.manager.setSelectionOrientationConstraint(true), false);
  assert.deepEqual(h.current(), malformed);
});

test('KEYBOARD-DUPLICATE-SAFE Cmd/Ctrl+D duplicate near occupied packed cases does not overlap', async () => {
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(`${packLibraryPath.href}?t=${Date.now()}-${Math.random()}`);
  const caseData = makePackImportSafeCase({ id: 'case-keyboard-duplicate', dimensions: { length: 12, width: 12, height: 12 } });
  const pack = {
    id: 'pack-keyboard-duplicate',
    title: 'Keyboard Duplicate',
    truck: { length: 72, width: 48, height: 48 },
    cases: [
      makePackImportInstance(caseData.id, { id: 'source', transform: { position: { x: 6, y: 6, z: -12 } }, placement: 'packed' }),
      makePackImportInstance(caseData.id, { id: 'occupied', transform: { position: { x: 18, y: 6, z: -12 } }, placement: 'packed' }),
    ],
  };

  StateStore.init({ caseLibrary: [caseData], packLibrary: [pack], folderLibrary: [], preferences: {} });
  const result = PackLibrary.duplicateInstancesSafely(pack.id, [pack.cases[0]], [caseData]);
  const updated = PackLibrary.getById(pack.id);

  assert.equal(result.placement, 'packed', 'duplicate should remain packed when a safe truck position exists');
  assert.equal(updated.cases.length, 3);
  assertPackImportNoOverlaps(updated.cases, caseData);
});

test('F05 Duplicate treats hidden packed cargo as physical while staged cargo stays outside truck authority', async () => {
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(`${packLibraryPath.href}?t=${Date.now()}-${Math.random()}`);
  const caseData = makePackImportSafeCase({ id: 'case-hidden-duplicate', dimensions: { length: 12, width: 12, height: 12 } });
  const truck = { length: 24, width: 12, height: 12, shapeMode: 'rect' };
  const instance = (id, x, hidden = false, placement = 'packed') =>
    makePackImportInstance(caseData.id, {
      id, hidden, placement, transform: { position: { x, y: 6, z: 0 } },
    });
  const source = instance('source', 6);
  const packWith = obstacle => ({ id: 'duplicate-hidden', truck,
    cases: obstacle ? [source, obstacle] : [source] });
  const visible = PackLibrary.buildSafeDuplicateInstances(
    packWith(instance('obstacle', 18)), [source], [caseData]);
  const hidden = PackLibrary.buildSafeDuplicateInstances(
    packWith(instance('obstacle', 18, true)), [source], [caseData]);
  assert.equal(visible.placement, 'staged', 'visible packed obstacle blocks the only open offset');
  assert.equal(hidden.placement, 'staged', 'hidden packed obstacle blocks the same physical offset');
  const staged = PackLibrary.buildSafeDuplicateInstances(
    packWith(instance('obstacle', 18, true, 'staged')), [source], [caseData]);
  assert.equal(staged.placement, 'packed', 'hidden staged row with stale truck pose is not a truck obstacle');
  assert.equal(staged.newInstances[0].transform.position.x, 18);
  const empty = PackLibrary.buildSafeDuplicateInstances(packWith(), [source], [caseData]);
  assert.equal(empty.placement, 'packed', 'genuinely empty truck space still accepts Duplicate');
  assert.equal(empty.newInstances[0].transform.position.x, 18);

  StateStore.init({ caseLibrary: [caseData], packLibrary: [packWith(instance('obstacle', 18, true))],
    folderLibrary: [], preferences: {} });
  const committed = PackLibrary.duplicateInstancesSafely('duplicate-hidden', [source], [caseData]);
  assert.equal(committed.placement, 'staged');
  const after = PackLibrary.getById('duplicate-hidden');
  assert.equal(after.cases.length, 3);
  assert.equal(after.cases[2].placement, 'staged', 'no overlapping packed placement is committed');
  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('duplicate-hidden').cases.length, 2, 'one Undo removes the duplicate');
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(PackLibrary.getById('duplicate-hidden').cases, after.cases,
    'one Redo restores the same safe duplicate');
});

test('KEYBOARD-DUPLICATE-SAFE Cmd/Ctrl+C then Cmd/Ctrl+V paste near occupied packed cases does not overlap', async () => {
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(`${packLibraryPath.href}?t=${Date.now()}-${Math.random()}`);
  const caseData = makePackImportSafeCase({ id: 'case-keyboard-paste', dimensions: { length: 12, width: 12, height: 12 } });
  const pack = {
    id: 'pack-keyboard-paste',
    title: 'Keyboard Paste',
    truck: { length: 72, width: 48, height: 48 },
    cases: [
      makePackImportInstance(caseData.id, { id: 'source', transform: { position: { x: 6, y: 6, z: -12 } }, placement: 'packed' }),
      makePackImportInstance(caseData.id, { id: 'occupied', transform: { position: { x: 18, y: 6, z: -12 } }, placement: 'packed' }),
    ],
  };
  const clipboard = [JSON.parse(JSON.stringify(pack.cases[0]))];

  StateStore.init({ caseLibrary: [caseData], packLibrary: [pack], folderLibrary: [], preferences: {} });
  const result = PackLibrary.duplicateInstancesSafely(pack.id, clipboard, [caseData]);
  const updated = PackLibrary.getById(pack.id);

  assert.equal(result.placement, 'packed', 'paste should remain packed when a safe truck position exists');
  assert.equal(updated.cases.length, 3);
  assertPackImportNoOverlaps(updated.cases, caseData);
});

test('KEYBOARD-DUPLICATE-SAFE duplicate and paste use staged fallback when no safe packed offset exists', async () => {
  const StateStore = await import(stateStorePath.href);
  const PackLibrary = await import(`${packLibraryPath.href}?t=${Date.now()}-${Math.random()}`);
  const caseData = makePackImportSafeCase({ id: 'case-keyboard-staged-fallback', dimensions: { length: 24, width: 24, height: 24 } });
  const pack = {
    id: 'pack-keyboard-staged-fallback',
    title: 'Keyboard Staged Fallback',
    truck: { length: 24, width: 24, height: 24 },
    cases: [
      makePackImportInstance(caseData.id, { id: 'source', transform: { position: { x: 12, y: 12, z: 0 } }, placement: 'packed' }),
    ],
  };

  StateStore.init({ caseLibrary: [caseData], packLibrary: [pack], folderLibrary: [], preferences: {} });
  const result = PackLibrary.duplicateInstancesSafely(pack.id, [pack.cases[0]], [caseData]);
  const updated = PackLibrary.getById(pack.id);
  const created = updated.cases.find(inst => result.newIds.includes(inst.id));

  assert.equal(result.placement, 'staged', 'a full truck must stage the duplicate instead of overlapping in place');
  assert.equal(created.placement, 'staged');
  assert.ok(created.transform.position.z > pack.truck.width / 2, 'staged fallback must be outside the trailer width');
  assertPackImportNoOverlaps(updated.cases, caseData);
});

test('DELETE-REVALIDATION editor delete paths report staged dependents and clear stale selection', async () => {
  const editorSrc = await fs.readFile(editorScreenPath, 'utf8');
  assert.match(editorSrc, /function formatDeleteResultMessage\(result, fallbackDeletedIds = \[\]\)/,
    'editor must centralize delete feedback formatting');
  assert.match(editorSrc, /dependent \$\{caseCountText\(dependentCount\)\} \$\{dependentCount === 1 \? 'was' : 'were'\} moved to staging because their support changed/,
    'delete feedback must explain staged dependents');

  const interactionStart = editorSrc.indexOf('function deleteSelection()');
  const interactionBlock = editorSrc.slice(interactionStart, interactionStart + 650);
  assert.match(interactionBlock, /const result = PackLibrary\.removeInstances\(packId, ids\)/,
    'keyboard Delete/Backspace path must receive the removeInstances mutation result');
  assert.match(interactionBlock, /setSelection\(getDeleteFinalSelection\(result\)\)/,
    'keyboard Delete/Backspace path must clear or rebuild selection from the mutation result');
  assert.match(interactionBlock, /formatDeleteResultMessage\(result, ids\)/,
    'keyboard Delete/Backspace path must report staged dependents');

  const helperStart = editorSrc.indexOf('function deleteInstancesWithFeedback(packId, instanceIds)');
  const helperBlock = editorSrc.slice(helperStart, helperStart + 700);
  assert.match(helperBlock, /const result = PackLibrary\.removeInstances\(packId, ids\)/,
    'inspector Delete helper must receive the removeInstances mutation result');
  assert.match(helperBlock, /setSelectionFromDeleteResult\(result\)/,
    'inspector Delete helper must clear or rebuild selection from the mutation result');
  assert.match(helperBlock, /formatDeleteResultMessage\(result, ids\)/,
    'inspector Delete helper must report staged dependents');
});

test('EDITOR selection Actions cards stay minimal, ordered, and bound to existing workflows', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const selectAllStart = src.indexOf('function selectAllCases(pack)');
  const selectAllEnd = src.indexOf('function makeSelectAllButton(pack', selectAllStart);
  const selectAllBlock = selectAllStart >= 0 && selectAllEnd > selectAllStart
    ? src.slice(selectAllStart, selectAllEnd)
    : '';
  const makeSelectStart = src.indexOf('function makeSelectAllButton(pack');
  const makeSelectEnd = src.indexOf('function renderTruckInspector(pack, prefs)', makeSelectStart);
  const makeSelectBlock = makeSelectStart >= 0 && makeSelectEnd > makeSelectStart
    ? src.slice(makeSelectStart, makeSelectEnd)
    : '';
  const truckStart = src.indexOf('function renderTruckInspector(pack, prefs)');
  const truckEnd = src.indexOf('function renderMultiInspector(pack, selected)', truckStart);
  const truckBlock = truckStart >= 0 && truckEnd > truckStart ? src.slice(truckStart, truckEnd) : '';
  const multiStart = src.indexOf('function renderMultiInspector(pack, selected)');
  const multiEnd = src.indexOf('function renderSingleInspector(pack, inst, caseData, prefs)', multiStart);
  const multiBlock = multiStart >= 0 && multiEnd > multiStart ? src.slice(multiStart, multiEnd) : '';
  const singleStart = src.indexOf('function renderSingleInspector(pack, inst, caseData, prefs)');
  const singleEnd = src.indexOf('\n    /**\n     * Creates a card header row', singleStart);
  const singleBlock = singleStart >= 0 && singleEnd > singleStart ? src.slice(singleStart, singleEnd) : '';

  assert.match(selectAllBlock, /InteractionManager\.selectAllInPack\(\)/,
    'Actions Select All must reuse the existing InteractionManager selection path');
  assert.match(makeSelectBlock, /label: 'Select All'[\s\S]*iconHtml: selectAllIconSvg\(\)/,
    'multi-select Actions card must render the custom stacked-select icon with Select All');
  assert.match(makeSelectBlock, /selectedCount\s*>=\s*totalCount/,
    'Select All should disable itself once the full pack is already selected');
  assert.match(makeSelectBlock, /function makeActionButton\(\{ label,/,
    'Actions buttons must share one equal-width button helper');
  const css = await fs.readFile(stylesMainPath, 'utf8');
  assert.match(css, /\.tp3d-editor-action-grid \.btn\s*\{[\s\S]*width: 100%[\s\S]*justify-content: center[\s\S]*min-width: 0[\s\S]*\}/,
    'Actions buttons must be equal-width and centered via the shared tp3d-editor-action-grid .btn rule');
  assert.match(css, /\.tp3d-editor-action-grid\s*\{[\s\S]*display: grid[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[\s\S]*\}/,
    'Actions cards must use an equal two-column layout via the shared tp3d-editor-action-grid rule');
  assert.match(multiBlock, /actRow\.className = 'tp3d-editor-action-grid'/,
    'multi-select Actions card must apply the tp3d-editor-action-grid layout class');
  assert.match(singleBlock, /actRow\.className = 'tp3d-editor-action-grid'/,
    'single-item Actions card must apply the tp3d-editor-action-grid layout class');
  assert.match(makeSelectBlock, /function makeVisibilityButton\(pack, selectedIds\)[\s\S]*instances\.every\(inst => inst\.hidden === true\)[\s\S]*label: showSelection \? 'Show' : 'Hide'[\s\S]*hidden: !showSelection/,
    'Actions cards must use one consistent Show/Hide toggle based on selected hidden state');
  assert.match(makeSelectBlock, /function duplicateSelection\(pack,\s*selectedIds\)[\s\S]*PackLibrary\.duplicateInstancesSafely\(pack\.id,\s*source,\s*CaseLibrary\.getCases\(\)\)/,
    'Actions Duplicate must use the shared safe duplicate helper before saving clones');
  const packLibSrc = await fs.readFile(packLibraryPath, 'utf8');
  assert.match(packLibSrc, /function duplicateAabbIsInsideTruckGeometry\(pack,\s*aabb\)[\s\S]*aabbIntersectsWheelWellBlockedBody\(aabb,\s*pack && pack\.truck\)[\s\S]*isAabbInsideTruckGeometry\(aabb,\s*zones,\s*getWheelWellGeometry\(pack && pack\.truck\)\)/,
    'shared Duplicate helper must reject blocked wheel-well bodies and require valid truck geometry for packed placements');
  assert.match(packLibSrc, /function buildDuplicateAcceptedSupportEntries\(pack,\s*caseLibrary\)[\s\S]*aabbIsFullyValid\(/,
    'shared Duplicate helper must build accepted support entries from physically valid packed cargo');
  assert.match(packLibSrc, /function duplicatePackedGroupIsFullyValid\(pack,\s*records,\s*caseLibrary\)[\s\S]*aabbIsFullyValid\(/,
    'shared Duplicate helper must validate duplicated packed groups bottom-up against full physical rules');
  assert.match(packLibSrc, /function findDuplicateOffset\(pack,\s*payload,\s*existingAabbs,\s*caseLibrary\)[\s\S]*duplicateOffsetIsSafe\(pack,\s*payload,\s*existingAabbs,\s*offset,\s*true,\s*caseLibrary\)[\s\S]*duplicateOffsetIsSafe\(pack,\s*payload,\s*existingAabbs,\s*stagedOffset,\s*false,\s*caseLibrary\)/,
    'shared Duplicate helper must try fully valid in-truck placement first, then collision-free staging');
  assert.doesNotMatch(makeSelectBlock, /position:\s*\{\s*x:\s*pos\.x \+ 12,\s*y:\s*pos\.y,\s*z:\s*pos\.z \+ 12/,
    'Actions Duplicate must not use the old fixed +12 inch offset that can overlap selected boxes');
  assert.doesNotMatch(src, /function deleteAllCases|Delete All|renderPackActionsCard/,
    'editor must not add a separate Delete All path or no-selection Actions card');
  assert.doesNotMatch(truckBlock, /makeSelectAllButton|Actions/,
    'truck inspector must stay focused on truck editing and stats');
  assert.match(multiBlock, /const btnSelectAll = makeSelectAllButton\(pack,\s*selected\.length\)/,
    'multi-select Actions card must include Select All');
  assert.match(multiBlock, /InteractionManager\.deleteSelection\(\)/,
    'multi-select Delete must keep using the existing selected-delete binding');
  assert.match(multiBlock, /const btnDuplicate = makeActionButton\(\{[\s\S]*onClick: \(\) => duplicateSelection\(pack,\s*selected\)/,
    'multi-select Duplicate must use the shared duplicate helper');
  assert.match(multiBlock, /const btnClear = makeActionButton\(\{[\s\S]*onClick: \(\) => InteractionManager\.setSelection\(\[\]\)/,
    'multi-select Deselect must clear both state and scene selection through InteractionManager');
  assert.doesNotMatch(multiBlock, /const btnShow|const btnHide/,
    'multi-select Actions must use one visibility toggle instead of separate Show and Hide buttons');
  assert.match(multiBlock,
    /actRow\.appendChild\(btnSetCategory\);[\s\S]*actRow\.appendChild\(btnVisibility\);[\s\S]*actRow\.appendChild\(btnSelectAll\);[\s\S]*actRow\.appendChild\(btnClear\);[\s\S]*actRow\.appendChild\(btnDuplicate\);[\s\S]*actRow\.appendChild\(btnDelete\);/,
    'multi-select Actions order must be Set Category, Show/Hide, Select All, Deselect, Duplicate, Delete');
  assert.match(singleBlock, /const selectAll = makeSelectAllButton\(pack,\s*1\)/,
    'single-item Actions card must include Select All through the shared helper');
  assert.match(singleBlock, /const setCategory = makeActionButton\(\{[\s\S]*onClick: \(\) => openSetCategoryModal\(pack,\s*\[inst\.id\]\)/,
    'single-item Set Category must reuse the shared category modal');
  assert.match(singleBlock, /const visibility = makeVisibilityButton\(pack,\s*\[inst\.id\]\)/,
    'single-item Actions must use the same Show/Hide toggle helper as multi-select');
  assert.match(singleBlock, /const duplicate = makeActionButton\(\{[\s\S]*onClick: \(\) => duplicateSelection\(pack,\s*\[inst\.id\]\)/,
    'single-item Duplicate must use the shared duplicate helper');
  assert.doesNotMatch(singleBlock, /const show|const hide/,
    'single-item Actions must use one visibility toggle instead of separate Show and Hide buttons');
  assert.match(singleBlock,
    /actRow\.appendChild\(setCategory\);[\s\S]*actRow\.appendChild\(visibility\);[\s\S]*actRow\.appendChild\(selectAll\);[\s\S]*actRow\.appendChild\(clear\);[\s\S]*actRow\.appendChild\(duplicate\);[\s\S]*actRow\.appendChild\(deleteButton\);/,
    'single-item Actions order must be Set Category, Show/Hide, Select All, Deselect, Duplicate, Delete');
  assert.doesNotMatch(singleBlock, /Unhide|Remove/,
    'single-item Actions must avoid ambiguous Unhide/Remove labels');
});

test('EDITOR inspector unit labels follow preferences and repaint on preference changes', async () => {
  const [editorSrc, appSrc] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(appPath, 'utf8'),
  ]);
  const truckStart = editorSrc.indexOf('function renderTruckInspector(pack, prefs)');
  const truckEnd = editorSrc.indexOf('function renderMultiInspector(pack, selected)', truckStart);
  const truckBlock = truckStart >= 0 && truckEnd > truckStart ? editorSrc.slice(truckStart, truckEnd) : '';
  const singleStart = editorSrc.indexOf('function renderSingleInspector(pack, inst, caseData, prefs)');
  const singleEnd = editorSrc.indexOf('\n    /**\n     * Creates a card header row', singleStart);
  const singleBlock = singleStart >= 0 && singleEnd > singleStart ? editorSrc.slice(singleStart, singleEnd) : '';
  const prefStart = appSrc.indexOf('if (changes.preferences || changes._undo || changes._redo || changes._replace)');
  const prefEnd = appSrc.indexOf('if (changes.currentScreen || changes._replace)', prefStart);
  const prefBlock = prefStart >= 0 && prefEnd > prefStart ? appSrc.slice(prefStart, prefEnd) : '';

  assert.match(editorSrc, /function getLengthUnit\(prefs\)[\s\S]*return prefs && prefs\.units && prefs\.units\.length \? prefs\.units\.length : 'in'/,
    'editor inspector must use a safe length-unit helper');
  assert.match(editorSrc, /function displayLengthToInches\(value,\s*fallbackInches,\s*unit\)[\s\S]*Utils\.unitToInches\(n,\s*unit \|\| 'in'\)/,
    'editor inspector must convert displayed values back to internal inches before save');
  assert.match(truckBlock, /const lengthUnit = getLengthUnit\(prefs\)/,
    'truck inspector must derive its display unit from preferences');
  assert.match(truckBlock, /smallField\(`Length \(\$\{lengthUnit\}\)`,\s*Utils\.inchesToUnit\((?:pack\.truck|effectiveTruck)\.length,\s*lengthUnit\),\s*'truck-length'\)/,
    'truck length field must display the active length unit');
  assert.match(truckBlock, /length:\s*Math\.max\(24,\s*displayLengthToInches\(fL\.input\.value,\s*(?:pack\.truck|effectiveTruck)\.length,\s*lengthUnit\)\)/,
    'truck length save must convert the displayed unit back to inches');
  assert.match(truckBlock, /smallField\(`Length \(\$\{lengthUnit\}\)`,\s*Utils\.inchesToUnit\(bonusLength,\s*lengthUnit\),\s*'overhang-length'\)/,
    'front overhang config fields must display the active length unit');
  assert.match(truckBlock, /wellOffsetFromRear:\s*Utils\.clamp\(displayLengthToInches\(fWO\.input\.value,\s*wellOffset,\s*lengthUnit\)/,
    'wheel well config fields must save active-unit values back to inches');
  assert.doesNotMatch(truckBlock, /smallField\('Length \(in\)'|smallField\('Width \(in\)'|smallField\('Height \(in\)'/,
    'truck inspector must not hardcode inch labels');
  assert.match(singleBlock, /addMetaChip\(Utils\.formatDims\(d,\s*lengthUnit\)\)/,
    'selected case dimensions pill must use the active length unit');
  assert.match(singleBlock, /inlinePositionField\('X',\s*lengthUnit,\s*Utils\.inchesToUnit\(pos\.x,\s*lengthUnit\)\)/,
    'position inputs must use compact inline fields with active-unit values');
  assert.match(prefBlock, /if \(StateStore\.get\('currentScreen'\) === 'editor'\) EditorUI\.render\(\);/,
    'preference changes must immediately re-render the editor inspector');
});

test('PREFERENCES remove millimeter selection and use hidden-opacity slider', async () => {
  const [settingsSrc, utilsSrc, utilsIndexSrc] = await Promise.all([
    fs.readFile(settingsOverlayPath, 'utf8'),
    fs.readFile(coreUtilsPath, 'utf8'),
    fs.readFile(coreUtilsIndexPath, 'utf8'),
  ]);
  const { normalizePreferences } = await import(
    `${normalizerPath.href}?t=${Date.now()}-${Math.random()}`
  );
  const normalized = normalizePreferences({ units: { length: 'mm', weight: 'lb' } });

  assert.doesNotMatch(settingsSrc, /Millimeters|value="mm"|value='mm'/,
    'active settings overlay must not offer millimeters as a length preference');
  assert.match(utilsSrc, /export const lengthUnits = \['in', 'ft', 'cm', 'm'\]/,
    'primary utility length units must exclude mm from selectable preferences');
  assert.match(utilsIndexSrc, /export const lengthUnits = \['in', 'ft', 'cm', 'm'\]/,
    'stable utility index length units must exclude mm from selectable preferences');
  assert.match(utilsSrc, /case 'mm':[\s\S]*inches \* 25\.4[\s\S]*case 'mm':[\s\S]*value \/ 25\.4/,
    'mm conversion support must remain for old imported or persisted values');
  assert.notEqual(normalized.units.length, 'mm',
    'normalization must not preserve mm as an active preference');
  assert.match(settingsSrc, /hiddenOpacity\.type = 'range'[\s\S]*hiddenOpacity\.min = '0'[\s\S]*hiddenOpacity\.max = '1'[\s\S]*hiddenOpacity\.step = '0\.05'/,
    'active settings overlay must render hidden opacity as a 0-1 range slider');
  assert.match(settingsSrc, /hiddenOpacityValue\.textContent = Number\(hiddenOpacity\.value\)\.toFixed\(2\)/,
    'hidden opacity slider must show its current numeric value');
  assert.match(settingsSrc, /hiddenOpacity\.addEventListener\('input', \(\) => \{\s*hiddenOpacityValue\.textContent = Number\(hiddenOpacity\.value\)\.toFixed\(2\)/,
    'hidden opacity readout must update while the slider moves');
});

test('EDITOR Case Browser New Case shortcut uses shared modal without adding to pack', async () => {
  const [editorSrc, casesSrc, modalSrc, stylesSrc] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(casesScreenPath, 'utf8'),
    fs.readFile(caseModalPath, 'utf8'),
    fs.readFile(stylesMainPath, 'utf8'),
  ]);
  const editorModalStart = editorSrc.indexOf('function openEditorNewCaseModal()');
  const editorModalEnd = editorSrc.indexOf('function setCaseFiltersVisible', editorModalStart);
  const editorModalBlock = editorModalStart >= 0 && editorModalEnd > editorModalStart
    ? editorSrc.slice(editorModalStart, editorModalEnd)
    : '';

  assert.match(casesSrc, /import \{ openCaseModal as openSharedCaseModal \} from '\.\.\/ui\/overlays\/case-modal\.js'/,
    'Cases page must use the shared Case modal implementation');
  assert.match(editorSrc, /import \{ openCaseModal as openSharedCaseModal \} from '\.\.\/ui\/overlays\/case-modal\.js'/,
    'Editor Case Browser shortcut must use the shared Case modal implementation');
  assert.match(editorSrc, /btnNewCase\.setAttribute\('data-role', 'editor-new-case'\)[\s\S]*openEditorNewCaseModal\(\)/,
    'Editor Case Browser must expose a New Case shortcut button');
  assert.match(editorSrc, /const browserControlsHost = caseSearchEl \? caseSearchEl\.closest\('\.tp3d-editor-case-search'\) : null/,
    'Editor Case Browser tabs must be anchored in the sticky search block');
  assert.doesNotMatch(editorSrc, /caseListEl\.parentElement\.insertBefore\(tabsEl, caseListEl\)/,
    'Editor Case Browser tabs must not be injected into the scrollable case list');
  assert.match(editorSrc, /btnNewCase\.setAttribute\('aria-label', 'New case'\)[\s\S]*btnNewCase\.innerHTML = '<i class="fa-solid fa-plus"><\/i>'/,
    'Editor New Case shortcut must remain icon-only with an accessible label');
  assert.doesNotMatch(editorSrc, /tp3d-editor-browser-tabs-spacer/,
    'Editor Case Browser toolbar must not include a spacer that pushes the New Case button away');
  assert.doesNotMatch(stylesSrc, /\.tp3d-editor-browser-tabs-spacer/,
    'stale Case Browser toolbar spacer CSS must be removed');
  assert.match(stylesSrc, /\.tp3d-editor-new-case-btn \{[\s\S]*display: inline-flex;[\s\S]*align-items: center;[\s\S]*justify-content: center;/,
    'Editor New Case icon-only button must be visually centered');
  assert.match(editorModalBlock, /openSharedCaseModal\(\{[\s\S]*onSaved: \(\) => \{[\s\S]*caseSearchEl\.value = ''[\s\S]*browserCats\.clear\(\)[\s\S]*caseBrowserGroupBy = 'category'[\s\S]*renderCaseBrowser\(\)/,
    'saving a case from the editor must refresh and reveal it in the Case Browser');
  assert.doesNotMatch(editorModalBlock, /addCaseToPack|PackLibrary\.add|PackLibrary\.update\(/,
    'Editor New Case shortcut must not add the new case to the current pack');
  const { formatCaseModalNumber } = await import(caseModalPath.href);
  assert.equal(formatCaseModalNumber(1.23456, 'm'), '1.2346',
    'shared Case modal keeps four-decimal meter input precision');
  assert.match(modalSrc, /import \{ formatCaseModalNumber, formatCaseModalWeightNumber \} from '\.\.\/\.\.\/core\/utils\/index\.js'/,
    'modal and physical-change authority share numeric presentation formatting');
  assert.match(modalSrc, /fL\.input\.value = formatCaseModalNumber\(Utils\.inchesToUnit\(initial\.dimensions\.length, lengthUnit\), lengthUnit\)/,
    'Case modal length input must avoid raw floating-point conversion strings');
  assert.doesNotMatch(modalSrc, /String\(Utils\.inchesToUnit/,
    'Case modal must not write raw conversion values directly into number inputs');
  assert.match(modalSrc, /CategoryService\.listWithCounts\(CaseLibrary\.getCases\(\)\)/,
    'shared Case modal must load project-aware categories from the case library, including imported categories');
  assert.doesNotMatch(modalSrc, /const catOptions = CategoryService\.all\(\)/,
    'shared Case modal must not be limited to default or preference-only categories');
  assert.match(modalSrc, /catSelect\.value = catOptions\.some\(c => c\.key === desiredKey\) \? desiredKey : 'default'/,
    'shared Case modal must preserve a current category when it exists in project categories');
  assert.match(modalSrc, /catColorInput\.type = 'color'[\s\S]*catColorInput\.setAttribute\('aria-label', 'Category color'\)/,
    'shared Case modal category swatch must expose a real color input');
  // HANDLING-RULES-P0A: the Save handler now commits through PackLibrary's
  // atomic orchestration (Case + category + any actively-displayed-Pack
  // revalidation as one StateStore write) instead of calling
  // CaseLibrary.commitCaseWithCategory directly — still exactly one commit,
  // still atomic with the category color.
  assert.match(modalSrc, /PackLibrary\.commitCaseHandlingRuleChange\(\s*caseData,\s*\{ key: categoryKey, name: catMeta\.name, color: categoryColor \},\s*\{ lengthUnit, weightUnit \}\s*\)/,
    'shared Case modal must persist edited category colors atomically with the Case commit');
  assert.match(modalSrc, /color: categoryColor/,
    'saved case data must use the edited category color');
  // P1 fix/cases-category-ui (2026-09): superseded the always-visible creator
  // this file previously guarded ("must not render a redundant New category
  // toggle above the add row", commit b48ddaf) — the always-visible row was
  // found to consume too much modal space, so the creator is now collapsed by
  // default behind an explicit, accessible "+ New" disclosure trigger. Full
  // expand/collapse/Cancel/Add/duplicate behavior is covered in
  // business-identity-phase-1.spec.mjs (CASES-CATEGORY-UI tests).
  assert.match(modalSrc, /newCatToggle\.setAttribute\('aria-label', 'Add new category'\)/,
    'shared Case modal must expose an accessible + New disclosure trigger for the category creator');
  assert.match(modalSrc, /catCreateRow\.hidden = true/,
    'the new-category creator must be collapsed by default');
  assert.match(modalSrc, /newCatName\.placeholder = 'Category name'/,
    'shared Case modal new category row uses restrained placeholder copy now that the row is opt-in');
  assert.match(modalSrc, /newCatSave\.innerHTML = '<i class="fa-solid fa-plus"><\/i> Add'/,
    'shared Case modal new category row must keep a single explicit + Add action');
  assert.match(modalSrc, /newCatColorSwatch\.classList\.add\('tp3d-cases-cat-swatch'\)[\s\S]*newCatColor\.className = 'tp3d-cases-cat-color-input'/,
    'shared Case modal new category color must reuse the standard category swatch style');
  assert.doesNotMatch(stylesSrc, /tp3d-cases-new-category-toggle|tp3d-cases-color-btn/,
    'stale category toggle and raw color button CSS must be removed');
  assert.match(modalSrc, /findDuplicateCategory\(nextName\)[\s\S]*Category "\$\{duplicate\.name\}" already exists/,
    'shared Case modal must warn instead of creating duplicate categories');
  assert.match(casesSrc, /function findDuplicateCategoryName\(name, excludeKey = ''\)/,
    'Cases screen category editing must share an explicit duplicate-category guard');
  assert.match(casesSrc, /colorWrap\.classList\.add\('tp3d-cases-cat-swatch'\)[\s\S]*color\.className = 'tp3d-cases-cat-color-input'/,
    'category edit modal must reuse the standard category swatch style');
  assert.match(editorSrc, /colorWrap\.classList\.add\('tp3d-cases-cat-swatch'\)[\s\S]*colorInput\.className = 'tp3d-cases-cat-color-input'/,
    'editor Set Category color picker must reuse the standard category swatch style');
  assert.match(casesSrc, /findDuplicateCategoryName\(nextName, initial\.key\)[\s\S]*Category "\$\{duplicate\.name\}" already exists/,
    'category edit modal must block duplicate renames with a warning');
});

test('CASE filters normalize imported category keys before matching cases', async () => {
  const src = await fs.readFile(caseLibraryPath, 'utf8');

  assert.match(src, /function normalizeCategoryFilterKey\(value\)/,
    'case library must centralize category key normalization');
  assert.match(src, /const cats = \(categoryKeys \|\| \[\]\)[\s\S]*\.map\(normalizeCategoryFilterKey\)[\s\S]*\.filter\(k => k && k !== 'all'\)/,
    'case search must normalize selected category filter keys');
  assert.match(src, /const caseCategory = normalizeCategoryFilterKey\(c\.category \|\| 'default'\) \|\| 'default'/,
    'case search must normalize raw case category values before filtering');
  assert.doesNotMatch(src, /cats\.includes\(c\.category\)/,
    'case search must not compare normalized chip keys against raw category names');
  assert.match(src, /function countsByCategory\(\)[\s\S]*normalizeCategoryFilterKey\(c\.category \|\| 'default'\)/,
    'category counts should use the same normalized category keys as filters');
});

test('CASE and editor filter panels render as bounded vertical lists', async () => {
  const src = await fs.readFile(stylesMainPath, 'utf8');
  const casesSrc = await fs.readFile(casesScreenPath, 'utf8');
  const editorSrc = await fs.readFile(editorScreenPath, 'utf8');
  const packsSrc = await fs.readFile(packsScreenPath, 'utf8');
  const uiSrc = await fs.readFile(new URL('../../src/ui/ui-components.js', import.meta.url), 'utf8');
  const cardDisplaySrc = await fs.readFile(cardDisplayOverlayPath, 'utf8');
  const indexSrc = await fs.readFile(indexHtmlPath, 'utf8');
  const categorySrc = await fs.readFile(categoryServicePath, 'utf8');

  assert.match(src, /\.tp3d-cases-filter-anchor,[\s\S]*\.tp3d-packs-filter-anchor \{[\s\S]*position: relative;/,
    'Cases screen filters must be anchored to the search toolbar');
  assert.match(src, /#cases-filters,[\s\S]*#packs-filters \{[\s\S]*position: absolute;[\s\S]*top: 35px;[\s\S]*right: 0;/,
    'Cases and Packs filters must overlay below the toolbar instead of pushing page content down');
  assert.match(src, /\.tp3d-filter-popover-title \{[\s\S]*position: sticky;[\s\S]*border-bottom: 1px solid var\(--border-subtle\);/,
    'Cases and Packs filter popups must use a consistent sticky title with a divider');
  assert.match(src, /\.tp3d-filter-popover-title \{[\s\S]*margin: calc\(var\(--space-3\) \* -1\) calc\(var\(--space-3\) \* -1\) 10px;/,
    'Cases and Packs filter popups must leave breathing room below the title divider');
  assert.match(src, /#cases-filters \.tp3d-filter-popover-title \+ \.chip,[\s\S]*#packs-filters \.tp3d-filter-popover-title \+ \.chip \{[\s\S]*margin-top: 8px;/,
    'Cases and Packs filter popups must keep the first chip below the title divider');
  assert.match(casesSrc, /filterHeader\.className = 'tp3d-filter-popover-title'/,
    'Cases filter popup must render the shared title class');
  assert.match(indexSrc, /id="packs-filters"[\s\S]*class="tp3d-filter-popover-title">Filters<\/div>/,
    'Packs filter popup must render the shared title class');
  assert.match(casesSrc, /let filtersOutsideClickHandler = null;/,
    'Cases filter popup must track the outside-click listener like Packs');
  assert.match(casesSrc, /const shouldOpen = PreferencesManager\.get\(\)\.casesFiltersVisible !== true;[\s\S]*UIComponents\.closeAllDropdowns\(\);[\s\S]*setFiltersVisible\(true\);/,
    'Cases filter popup must toggle through the shared one-open coordinator');
  assert.match(casesSrc, /document\.addEventListener\('click', filtersOutsideClickHandler\)/,
    'Cases filter popup must close from a document outside-click handler');
  assert.match(casesSrc, /function setFiltersVisible\(visible\)[\s\S]*PreferencesManager\.set\(prefs\);[\s\S]*applyFiltersVisibility\(\);/);
  assert.match(casesSrc, /if \(!anchor \|\| !anchor\.contains[\s\S]*setFiltersVisible\(false\);/,
    'Cases filter outside click must persist the closed state');
  assert.match(src, /#cases-filters,[\s\S]*#packs-filters \{[\s\S]*flex-direction: column;/,
    'Cases and Packs filters must render as vertical lists');
  assert.match(src, /#cases-filters,[\s\S]*#packs-filters \{[\s\S]*width: min\(220px, 100%\);/,
    'Cases and Packs filters must stay compact while overlaying page content');
  assert.match(src, /#cases-filters \.chip,[\s\S]*#packs-filters \.chip,[\s\S]*#editor-case-chips \.chip \{[\s\S]*width: 100%;[\s\S]*min-width: 0;[\s\S]*justify-content: flex-start;/,
    'Cases, Packs, and editor filter chips must use full-width list rows');
  assert.match(src, /#cases-filters \.chip span:last-child,[\s\S]*#packs-filters \.chip span:last-child,[\s\S]*#editor-case-chips \.chip span:last-child \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/,
    'filter chip labels must truncate instead of overflowing or clipping the side panel');
  assert.match(src, /\.dropdown\[data-role='categories'\] \{[\s\S]*top: 195px !important;[\s\S]*width: min\(240px, calc\(100vw - 16px\)\) !important;/,
    'Cases category management dropdown must sit lower and stay compact');
  assert.match(casesSrc, /items\.push\(\{ type: 'header', label: 'Categories' \}\);[\s\S]*label: 'New Category'[\s\S]*variant: 'primary'[\s\S]*items\.push\(\{ type: 'divider' \}\);/,
    'Cases category management dropdown must keep the New Category action above the category list');
  assert.match(src, /\.dropdown\[data-role='categories'\] \.dropdown-menu > div:first-child \{[\s\S]*z-index: 4;/,
    'Cases category management dropdown must keep the title fixed above the category list');
  assert.match(src, /\.dropdown\[data-role='categories'\] \.dropdown-item\[data-variant='primary'\] \{[\s\S]*position: sticky;[\s\S]*top: 45px;[\s\S]*justify-content: center;/,
    'Cases category dropdown New Category action must stay sticky and use the primary yellow action styling');
  assert.match(src, /#editor-case-chips \{[\s\S]*left: var\(--space-3\);/,
    'Editor Case Browser filters must be bounded by the fixed search block');
  assert.match(src, /#editor-case-chips \{[\s\S]*right: var\(--space-3\);/,
    'Editor Case Browser filters must be bounded by the fixed search block');
  assert.match(src, /#editor-case-chips \{[\s\S]*width: auto;/,
    'Editor Case Browser filters must be bounded by the fixed search block');
  assert.match(src, /#editor-case-chips \{[\s\S]*flex-direction: column;[\s\S]*flex-wrap: nowrap;/,
    'Editor Case Browser filters must not wrap into clipped side-by-side columns');
  assert.match(src, /#editor-case-chips \{[\s\S]*z-index: 80;/,
    'Editor Case Browser filters must layer above the case list');
  assert.match(src, /#editor-case-chips \{[\s\S]*?max-height: var\(--tp3d-case-chips-max-height, min\(48vh, 320px\)\);/,
    'Editor Case Browser filters must use the measured available height, with the old cap only as fallback');
  assert.match(src, /#editor-left \.panel-body \{\s*position: relative;\s*flex: 1 1 auto;\s*min-height: 0;/,
    'the Case Browser body must fill its panel so a short result list cannot clip the filter popup');
  assert.doesNotMatch(indexSrc, /id="(?:cases|editor-case)-filters-toggle"[\s\S]{0,180}data-tooltip="Toggle filters"/,
    'filter toggle buttons must not render a tooltip over the open filter panel');
  assert.match(uiSrc, /const activeAnchorClass = String\(options\.activeAnchorClass \|\| ''\)\.trim\(\)/,
    'shared dropdowns must support opt-in active styling for popup trigger buttons');
  assert.match(uiSrc, /dropdownActiveAnchorClasses\.forEach\(className => anchorEl\.classList\.add\(className\)\)/,
    'shared dropdowns must apply the active styling class while open');
  assert.match(uiSrc, /dropdownActiveAnchorClasses\.forEach\(className => dropdownActiveAnchorEl\.classList\.remove\(className\)\)/,
    'shared dropdowns must remove active styling when closed');
  assert.match(cardDisplaySrc, /role:\s*'card-display'[\s\S]*activeAnchorClass:\s*'btn-primary'/,
    'Packs and Cases card display popup buttons must be yellow while their popup is open');
  assert.match(casesSrc, /role:\s*'categories'[\s\S]*activeAnchorClass:\s*'btn-primary'/,
    'Cases category management popup button must be yellow while its popup is open');
  assert.match(packsSrc, /role:\s*'trailer-presets'[\s\S]*activeAnchorClass:\s*'btn-primary'/,
    'Packs trailer preset popup button must be yellow while its popup is open');
  assert.match(categorySrc, /export function resetToDefaultIfNoCases\(cases\)/,
    'Category service must expose an explicit empty-library reset path');
  assert.match(categorySrc, /export function calculateResetToDefaultIfNoCases\(cases\)/,
    'Category service must expose the pure empty-library reset for atomic transitions');
  assert.match(casesSrc, /if \(!cases\.length\) activeCategories\.clear\(\);/,
    'Cases filters must clear stale category selections when the case library is empty');
  assert.match(editorSrc, /if \(!allCases\.length\) \{\s*browserCats\.clear\(\);\s*browserManufacturers\.clear\(\);/,
    'Editor Case Browser filters must clear stale category and manufacturer selections when the case library is empty');
  assert.doesNotMatch(`${casesSrc}\n${editorSrc}`, /resetToDefaultIfNoCases/,
    'rendering the Cases screen or the Editor Case Browser never writes Preferences/history');
});

test('EDITOR and Packs filter popups include total All counts', async () => {
  const editorSrc = await fs.readFile(editorScreenPath, 'utf8');
  const packsSrc = await fs.readFile(packsScreenPath, 'utf8');
  const indexSrc = await fs.readFile(indexHtmlPath, 'utf8');

  assert.match(editorSrc, /const allFilterCount = allCases\.length/,
    'Editor Case Browser filter popup must compute the total case count');
  assert.match(editorSrc, /makeBrowserChip\(\s*'All',\s*allFilterCount,/,
    'Editor Case Browser All filter must display its count');
  assert.match(editorSrc, /const fullLabel = `\$\{name\}: \$\{count\}`;/,
    'Editor Case Browser chips must keep the "Name: count" label');
  assert.match(indexSrc, /id=["']packs-filter-chip-all["']/,
    'Packs status filter popup must include an All chip');
  assert.match(packsSrc, /function updateStatusFilterChips\(packs\)/,
    'Packs status filter popup must refresh status counts');
  assert.match(packsSrc, /setChip\(chipAll, ['"]All['"], counts\.all, !anyActive\)/,
    'Packs All status chip must display the total pack count');
});

test('EDITOR Case Browser filter popup supports manufacturer grouping', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  assert.match(src, /const browserManufacturers = new Set\(\)/,
    'editor Case Browser must track manufacturer filters separately from category filters');
  assert.match(src, /function getManufacturerFilterOptions\(cases\)/,
    'editor Case Browser must build manufacturer filter options');
  assert.match(src, /function getManufacturerFilterColor\(value\)/,
    'editor Case Browser manufacturer chips must use deterministic colors instead of neutral gray only');
  assert.match(src, /color: getManufacturerFilterColor\(label\)/,
    'manufacturer filter options must carry a display color');
  assert.match(src, /caseBrowserGroupBy === 'manufacturer' && browserManufacturers\.size[\s\S]*cases = cases\.filter\(c => browserManufacturers\.has\(getManufacturerFilterKey\(c && c\.manufacturer\)\)\)/,
    'manufacturer tab must filter visible cases by selected manufacturer chips');
  assert.match(src, /const activeBrowserFilters = caseBrowserGroupBy === 'manufacturer' \? browserManufacturers : browserCats/,
    'filter chip state must switch between manufacturer and category mode');
  assert.match(src, /caseBrowserGroupBy === 'manufacturer'[\s\S]*getManufacturerFilterOptions\(allCases\)[\s\S]*CategoryService\.listWithCounts\(allCases\)/,
    'filter popup must render manufacturer options in manufacturer mode and category options otherwise');
  assert.doesNotMatch(src, /caseChipsEl\.hidden = true; caseChipsEl\.style\.display = 'none'/,
    'manufacturer mode must not disable the filter popup');
  assert.match(src, /browserManufacturers\.clear\(\)[\s\S]*caseBrowserGroupBy = 'category'/,
    'saving a new case from the editor must clear stale manufacturer filters');
  assert.match(src, /const path = ev\.composedPath\(\);[\s\S]{0,120}path\.includes\(caseFilterToggleEl\)[\s\S]{0,80}path\.includes\(caseChipsEl\)/,
    'a chip click that rebuilds (detaches) the chip must still count as inside the filter popup');
  assert.doesNotMatch(src, /caseChipsEl\.contains\(ev\.target\)/,
    'outside-click detection must not use the possibly-detached event target');
  assert.match(src, /function resetWorkspaceState\(\) \{[\s\S]*?browserCats\.clear\(\);\s*browserManufacturers\.clear\(\);\s*if \(caseSearchEl\) caseSearchEl\.value = '';\s*caseBrowserGroupBy = 'category';\s*setCaseFiltersVisible\(false, false\);/,
    'Case Browser search/filter/group-by state is workspace-scoped');
});

test('EDITOR multi-select summary removes shortcut helper copy', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');
  const multiStart = src.indexOf('function renderMultiInspector(pack, selected)');
  const multiEnd = src.indexOf('function renderSingleInspector(pack, inst, caseData, prefs)', multiStart);
  const multiBlock = multiStart >= 0 && multiEnd > multiStart ? src.slice(multiStart, multiEnd) : '';

  assert.doesNotMatch(multiBlock, /Shift\+Click to add\/remove\. Ctrl\/Cmd\+A select all\. Delete to remove\./,
    'multi-select inspector summary must not duplicate the future shortcuts area');
});

test('EDITOR-VISUAL-RESOURCE shared CanvasTextures live until the final CaseScene owner releases them', async () => {
  const previousThree = globalThis.THREE;
  const previousDocument = globalThis.document;
  const THREE = await import(`${vendorThreePath.href}?t=${Date.now()}-${Math.random()}`);
  globalThis.THREE = THREE;
  const drawnLabels = [];
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
          fillText(text) { drawnLabels.push(text); },
        }),
      };
    },
  };

  try {
    const Editor = await import(`${editorScreenPath.href}?t=${Date.now()}-${Math.random()}`);
    const scene = new THREE.Scene();
    const caseData = {
      id: 'case-shared',
      name: 'Shared Case',
      dimensions: { length: 20, width: 18, height: 16 },
      weight: 10,
      color: '#8844aa',
      category: 'default',
      canFlip: true,
      orientationLock: 'any',
      shape: 'box',
    };
    const categoryColors = { priority: '#2255aa' };
    const CaseScene = Editor.createCaseScene({
      SceneManager: {
        getScene: () => scene,
        toWorld: value => Number(value) || 0,
        vecInchesToWorld: position => new THREE.Vector3(position.x, position.y, position.z),
      },
      CaseLibrary: { getById: id => (id === caseData.id ? caseData : null) },
      CategoryService: { meta: category => ({ color: categoryColors[category] || null }) },
      PackLibrary: {}, StateStore: {}, TrailerGeometry: {},
      Utils: {
        clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
        getCssVar: () => '#ff9f1c',
      },
      PreferencesManager: { get: () => ({ hiddenCaseOpacity: 0.3 }) },
    });
    const makeInstance = (id, x = 10) => ({
      id,
      caseId: caseData.id,
      transform: {
        position: { x, y: 8, z: 10 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      placement: 'packed',
    });
    const textureFor = id => CaseScene.getObject(id).userData.mesh.material[0].map;

    const first = makeInstance('instance-a');
    const second = makeInstance('instance-b', 40);
    CaseScene.sync({ id: 'pack', cases: [first] });
    const sharedTexture = textureFor(first.id);
    assert.ok(!drawnLabels.includes('⇧⇧'), 'unrestricted Case has no upright arrows');
    delete caseData.canFlip;
    first.orientationLocked = true;
    first.lockedRotation = { x: Math.PI / 2, y: 0, z: 0 };
    first.orientedDims = { length: 999, width: 999, height: 999 };
    first.packedProfile = 'max-capacity';
    CaseScene.sync({ id: 'pack', cases: [first] });
    assert.strictEqual(textureFor(first.id), sharedTexture,
      'retired flipping, exact target and Max profile have no visual cue authority');
    assert.deepEqual(CaseScene.getObject(first.id).userData.halfWorld, { x: 10, y: 8, z: 9 },
      'geometry ignores planning targets and stale cached dimensions');
    first.transform.rotation = { x: 0, y: Math.PI / 2, z: 0 };
    CaseScene.sync({ id: 'pack', cases: [first] });
    assert.deepEqual(CaseScene.getObject(first.id).userData.halfWorld, { x: 9, y: 8, z: 10 },
      'geometry follows actual rotation');
    let sharedDisposeCount = 0;
    sharedTexture.addEventListener('dispose', () => { sharedDisposeCount += 1; });

    CaseScene.sync({ id: 'pack', cases: [first, second] });
    assert.strictEqual(textureFor(second.id), sharedTexture,
      'a second case with the same visual signature acquires the cached CanvasTexture');

    CaseScene.sync({ id: 'pack', cases: [second] });
    assert.strictEqual(textureFor(second.id), sharedTexture,
      'the surviving case keeps referencing the shared cached CanvasTexture');
    assert.equal(sharedDisposeCount, 0,
      'removing one shared owner must not dispose the surviving case texture');

    CaseScene.sync({ id: 'pack', cases: [] });
    assert.equal(sharedDisposeCount, 1,
      'the cache disposes the shared CanvasTexture exactly once after the final owner releases it');

    CaseScene.sync({ id: 'pack', cases: [first] });
    const recreatedTexture = textureFor(first.id);
    assert.notStrictEqual(recreatedTexture, sharedTexture,
      'acquiring after final release creates a valid new CanvasTexture');
    let recreatedDisposeCount = 0;
    recreatedTexture.addEventListener('dispose', () => { recreatedDisposeCount += 1; });

    caseData.name = 'Changed Label';
    CaseScene.sync({ id: 'pack', cases: [first] });
    const changedSignatureTexture = textureFor(first.id);
    assert.notStrictEqual(changedSignatureTexture, recreatedTexture,
      'changing generated label content releases the old signature and acquires a new texture');
    assert.equal(recreatedDisposeCount, 1,
      'a signature change disposes the old texture exactly once after its final release');

    let activeTexture = changedSignatureTexture;
    let activeDisposeCount = 0;
    activeTexture.addEventListener('dispose', () => { activeDisposeCount += 1; });
    const identityChanges = [
      ['weight label', () => { caseData.weight = 11; }],
      ['unknown mass label', () => { caseData.weight = null; }],
      ['handling arrows', () => { caseData.orientationLock = 'upright'; }],
      ['side orientation', () => { caseData.orientationLock = 'onSide'; }],
      ['body color', () => { caseData.color = '#1188cc'; }],
      ['texture fallback color', () => { caseData.color = null; }],
      ['explicit default edge color', () => { caseData.color = '#ff9f1c'; }],
      ['category color', () => { caseData.category = 'priority'; }],
      ['dimensions', () => { caseData.dimensions = { length: 21, width: 18, height: 16 }; }],
      ['visual geometry shape', () => { caseData.shape = 'cylinder'; }],
      ['pallet rendering', () => { caseData.isPallet = true; }],
      ['pallet warning label', () => { caseData.maxPalletWeight = 50; }],
    ];
    for (const [label, mutate] of identityChanges) {
      drawnLabels.length = 0;
      mutate();
      CaseScene.sync({ id: 'pack', cases: [first] });
      const nextTexture = textureFor(first.id);
      assert.notStrictEqual(nextTexture, activeTexture,
        `${label} changes the current visual-resource signature`);
      assert.equal(activeDisposeCount, 1,
        `${label} releases the prior signature exactly once`);
      if (label === 'unknown mass label') {
        assert.ok(drawnLabels.includes('—'));
        assert.ok(!drawnLabels.includes('0 lb'));
      }
      if (label === 'handling arrows') assert.ok(drawnLabels.includes('⇧⇧'));
      if (label === 'side orientation') assert.ok(!drawnLabels.includes('⇧⇧'));
      activeTexture = nextTexture;
      activeDisposeCount = 0;
      activeTexture.addEventListener('dispose', () => { activeDisposeCount += 1; });
    }

    CaseScene.clear();
    assert.equal(activeDisposeCount, 1,
      'clear releases and disposes the final signature exactly once');
  } finally {
    if (previousThree === undefined) delete globalThis.THREE;
    else globalThis.THREE = previousThree;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('EDITOR keyboard shortcut ownership keeps F (any case) for Flip only', async () => {
  const keyboardSrc = await fs.readFile(keyboardManagerPath, 'utf8');
  const editorSrc = await fs.readFile(editorScreenPath, 'utf8');

  const shortcutsStart = keyboardSrc.indexOf('\n    shortcuts = {\n');
  const shortcutsEnd = keyboardSrc.indexOf('\n    };', shortcutsStart);
  assert.ok(shortcutsStart >= 0 && shortcutsEnd > shortcutsStart, 'KeyboardManager shortcuts block must exist');
  const shortcutsBlock = keyboardSrc.slice(shortcutsStart, shortcutsEnd);
  assert.doesNotMatch(shortcutsBlock, /(^|\n)\s*'?(shift\+)?f'?\s*:/,
    'app-level KeyboardManager must not bind F or Shift+F; the viewport owns F as Flip');
  assert.doesNotMatch(keyboardSrc, /focusSelected/,
    'there is no Focus Selected keyboard shortcut (Tab reaches the viewport instead)');

  const keyStart = editorSrc.indexOf('function onKeyDown(ev)');
  const keyEnd = editorSrc.indexOf('function onMove(ev)', keyStart);
  assert.ok(keyStart >= 0 && keyEnd > keyStart, 'editor onKeyDown block must exist');
  const keyBlock = editorSrc.slice(keyStart, keyEnd);
  assert.match(keyBlock, /case 'f':\s*\n\s*case 'F':\s*\n\s*rotateSelection\('x', Math\.PI\);/,
    'editor InteractionManager must keep bare F/F as Flip');
});

test('G1.2B-CASE-BROWSER-POLISH Case Browser cards are built by one shared helper, not duplicated per grouping', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  assert.match(src, /function buildCaseBrowserCard\(c, lengthUnit, prefs, isSelected, pack\)/,
    'a shared buildCaseBrowserCard(c, lengthUnit, prefs, isSelected, pack) helper must exist ' +
      '(pack added to gate the per-card Qty/Add row)');

  // Quantity Controls: the Add button now always routes through
  // PackLibrary.addInstancesToStaging() (never addCaseToPack) once a Load Plan
  // is open, and no Add control renders at all when it is not. addCaseToPack
  // remains the drag-to-pack path only.
  const qtyAddRowCalls = src.match(/card\.appendChild\(buildCaseQtyAddRow\(c, pack\)\)/g) || [];
  assert.equal(qtyAddRowCalls.length, 1,
    'card.appendChild(buildCaseQtyAddRow(c, pack)) must appear exactly once now that Category and Manufacturer card bodies share one helper');
});

test('G1.2B-CASE-BROWSER-POLISH selected-case cue is derived from selectedInstanceIds and the current pack', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const renderStart = src.indexOf('function renderCaseBrowser');
  const helperStart = src.indexOf('function buildCaseBrowserCard');
  assert.ok(renderStart >= 0 && helperStart > renderStart,
    'renderCaseBrowser and buildCaseBrowserCard must both be present in order');
  const renderBlock = src.slice(renderStart, helperStart);

  assert.match(renderBlock, /StateStore\.get\('selectedInstanceIds'\)/,
    'renderCaseBrowser must read selectedInstanceIds from StateStore');
  assert.match(renderBlock, /PackLibrary\.getById\(StateStore\.get\('currentPackId'\)\)/,
    'renderCaseBrowser must resolve the current pack via PackLibrary.getById(StateStore.get(\'currentPackId\'))');
  assert.match(renderBlock, /selectedCaseIds\.add\(inst\.caseId\)/,
    'renderCaseBrowser must map selected instance ids to their case ids via inst.caseId');
});

test('G1.2B-CASE-BROWSER-POLISH selected cue is applied per-card via selectedCaseIds.has(c.id)', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  assert.match(src, /card\.classList\.toggle\('tp3d-editor-case-browser-card--selected', Boolean\(isSelected\)\)/,
    'buildCaseBrowserCard must toggle the selected modifier class based on isSelected');

  const callSites = src.match(/buildCaseBrowserCard\(c, lengthUnit, prefs, selectedCaseIds\.has\(c\.id\), browserPack\)/g) || [];
  assert.equal(callSites.length, 2,
    'both the Category and Manufacturer grouped branches must call buildCaseBrowserCard with ' +
      'selectedCaseIds.has(c.id) and browserPack (the latter added by Quantity Controls Phase 1)');
});

test('G1.2B-CASE-BROWSER-POLISH Case Browser cards add no staged/packed badges or thumbnails', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const helperStart = src.indexOf('function buildCaseBrowserCard');
  // Bounded to buildCaseBrowserCard's own body only, ending at its own
  // `return card;` (not the next function's declaration) so the JSDoc comment
  // above the sibling buildCaseQtyAddRow — whose own "N in load · N in truck ·
  // N staged" readout is an approved, separately-scoped addition, not a
  // staged/packed badge on the catalog card itself — is excluded too.
  const helperEnd = src.indexOf('\n      return card;', helperStart);
  const helperBlock = helperStart >= 0 && helperEnd > helperStart
    ? src.slice(helperStart, helperEnd)
    : '';
  assert.ok(helperBlock, 'buildCaseBrowserCard helper body must be locatable');

  assert.doesNotMatch(helperBlock, /staged|packed|Staged|Packed/,
    'buildCaseBrowserCard must not introduce staged/packed badges');
  assert.doesNotMatch(helperBlock, /<img|thumbnail|placeholder/i,
    'buildCaseBrowserCard must not introduce thumbnails or placeholder images');
});

test('G1.2B-CASE-BROWSER-POLISH manufacturer group header no longer uses inline style.cssText', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  assert.doesNotMatch(src, /hdr\.style\.cssText/,
    'the manufacturer group header must not use hdr.style.cssText for layout/typography');
  assert.match(src, /hdr\.className = 'tp3d-editor-mfg-group-header'/,
    'the manufacturer group header must use the new tp3d-editor-mfg-group-header class');
});

test('G1.2B-CASE-BROWSER-POLISH Case Browser block introduces no new inline CSS beyond the existing category-dot color', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const renderStart = src.indexOf('function renderCaseBrowser');
  const helperStart = src.indexOf('function buildCaseBrowserCard');
  const helperEnd = src.indexOf('\n    function openEditorNewCaseModal', helperStart);
  const block = src.slice(renderStart, helperEnd);

  const styleAssignments = block.match(/\.style\.\w+\s*=/g) || [];
  assert.deepEqual(styleAssignments, ['.style.background ='],
    'the only inline style assignment in the Case Browser block must be the pre-existing catDot.style.background = catMeta.color pattern');
});

test('G1.2B-CASE-BROWSER-POLISH Add and drag-to-pack behavior is preserved in the shared card helper', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const helperStart = src.indexOf('function buildCaseBrowserCard');
  const helperEnd = src.indexOf('\n    function openEditorNewCaseModal', helperStart);
  const helperBlock = src.slice(helperStart, helperEnd);

  assert.match(helperBlock, /card\.draggable = true/,
    'cards must remain draggable');
  assert.match(helperBlock, /ev\.dataTransfer\.setData\('text\/plain', c\.id\)/,
    'dragstart must still set text/plain to the case id');
  // Quantity Controls: the "+ Add" button now commits the ephemeral Qty draft
  // through PackLibrary.addInstancesToStaging() instead of addCaseToPack.
  assert.match(helperBlock, /PackLibrary\.addInstancesToStaging\(packId, c\.id, qty\)/,
    'the Add button must commit the drafted Qty via PackLibrary.addInstancesToStaging');
});

test('G1.2B-CASE-BROWSER-POLISH new CSS classes use existing design tokens only', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');

  const selectedMatch = css.match(/\.tp3d-editor-case-browser-card--selected\s*\{([^}]*)\}/);
  assert.ok(selectedMatch, '.tp3d-editor-case-browser-card--selected must be defined in main.css');
  assert.match(selectedMatch[1], /var\(--accent-primary-25\)/,
    'the selected card border must use var(--accent-primary-25)');
  assert.match(selectedMatch[1], /var\(--accent-primary-12\)/,
    'the selected card background must use var(--accent-primary-12)');

  const headerMatch = css.match(/\.tp3d-editor-mfg-group-header\s*\{([^}]*)\}/);
  assert.ok(headerMatch, '.tp3d-editor-mfg-group-header must be defined in main.css');
  assert.match(headerMatch[1], /color: var\(--text-primary\);/,
    'the manufacturer group header color must use the theme-aware var(--text-primary)');
  assert.match(headerMatch[1], /var\(--text-xs\)/,
    'the manufacturer group header font-size must use var(--text-xs)');
  assert.match(headerMatch[1], /var\(--font-semibold\)/,
    'the manufacturer group header font-weight must use var(--font-semibold)');
});

test('G1.2C-INSPECTOR-CARD-POLISH Load Summary uses the approved neutral label/value rows', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const statsStart = src.indexOf('const statsEl = document.createElement');
  const statsEnd = src.indexOf('card.appendChild(shapeRow)', statsStart);
  assert.ok(statsStart >= 0 && statsEnd > statsStart, 'the Stats card block must be locatable');
  const statsBlock = src.slice(statsStart, statsEnd);

  const labelValueRows = statsBlock.match(/<div class="row space-between">/g) || [];
  assert.equal(labelValueRows.length, 3, 'Load Summary renders exactly three neutral rows');
  assert.match(statsBlock, /Load Summary/);

  ['In truck', 'Staged', 'Total weight'].forEach(label => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(statsBlock, new RegExp(`<span class="muted tp3d-editor-fs-sm">${escapedLabel}</span>`),
      `Stats card must keep the "${label}" label`);
  });

  assert.match(statsBlock, /\$\{utilization\.loadedCount \|\| 0\}/);
  assert.match(statsBlock, /\$\{utilization\.stagedCount \|\| 0\}/);
  assert.match(statsBlock, /\$\{Utils\.formatWeight\(stats\.totalWeight, prefs\.units\.weight\)\}/,
    'Stats card must keep using Utils.formatWeight(stats.totalWeight, ...)');

  // "capacity" alone is excluded from this check when it is part of the approved
  // "Max Capacity" AutoPack profile name, its "maxCapacity…" identifiers, or its
  // "max-capacity-…" doc/file references (Phase C, Contract C) - the invented-stat
  // patterns this guards against are the ft³/cubicFt/packedVolume forms.
  assert.doesNotMatch(statsBlock, /ft³|ft3|(?<!max[ -])(?<!max)capacity|cubicFt|packedVolume/i,
    'Stats card must not invent packed/capacity ft³ values');
});

test('G1.2C-INSPECTOR-CARD-POLISH Inspector keeps one canonical stats calculation for the viewed Pack', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const calls = src.match(/PackLibrary\.computeStats\(viewedPack\)/g) || [];
  assert.equal(calls.length, 1, 'renderTruckInspector must compute canonical viewed-Pack stats exactly once');
});

test('G1.2C-INSPECTOR-CARD-POLISH Rotate/Flip buttons keep the same axes/deltas and InteractionManager.rotateSelection routing', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const rotateCalls = src.match(/InteractionManager\.rotateSelection\(axis, delta\)/g) || [];
  assert.equal(rotateCalls.length, 2,
    'both the multi-selection and single-selection Rotate/Flip buttons must call InteractionManager.rotateSelection(axis, delta)');

  assert.match(src, /\{ label: 'Turn', icon: 'fa-rotate', tone: 'turn', axis: 'y', delta: halfPI \}/,
    'multi-selection Rotate All must keep the Turn/Y 90° axis/delta');
  assert.match(src, /\{ label: 'Tip', icon: 'fa-rotate-left', tone: 'tip', axis: 'x', delta: halfPI \}/,
    'multi-selection Rotate All must keep the Tip/X 90° axis/delta');
  assert.match(src, /\{ label: 'Roll', icon: 'fa-rotate-right', tone: 'roll', axis: 'z', delta: halfPI \}/,
    'multi-selection Rotate All must keep the Roll/Z 90° axis/delta');
  assert.match(src, /\{ label: 'Flip', icon: 'fa-arrows-up-down', tone: 'flip', axis: 'x', delta: Math\.PI \}/,
    'multi-selection Rotate All must keep the Flip axis/delta');

  assert.match(src, /\{ label: 'Turn', icon: 'fa-rotate', tone: 'turn', axis: 'y', delta: halfPI \}/,
    'single-selection Rotate / Flip must keep the Turn/Y 90° icon/axis/delta');
  assert.match(src, /\{ label: 'Tip', icon: 'fa-rotate-left', tone: 'tip', axis: 'x', delta: halfPI \}/,
    'single-selection Rotate / Flip must keep the Tip/X 90° icon/axis/delta');
  assert.match(src, /\{ label: 'Roll', icon: 'fa-rotate-right', tone: 'roll', axis: 'z', delta: halfPI \}/,
    'single-selection Rotate / Flip must keep the Roll/Z 90° icon/axis/delta');
  assert.match(src, /\{ label: 'Flip', icon: 'fa-arrows-up-down', tone: 'flip', axis: 'x', delta: Math\.PI \}/,
    'single-selection Rotate / Flip must keep the Flip icon/axis/delta');
});

test('G1.2C-INSPECTOR-CARD-POLISH Rotate/Flip icons remain FontAwesome (no SVG/emoji/custom icons) and have no stray leading-space text nodes', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const rotButtonMarkup = src.match(/<i class="fa-solid [^"]+"><\/i><span>\$\{label\}<\/span>/g) || [];
  assert.equal(rotButtonMarkup.length, 2,
    'both Rotate/Flip button blocks must render a FontAwesome <i> icon followed by a <span> label with no stray leading space');

  assert.doesNotMatch(src, /<\/i> \$\{label\}/,
    'Rotate/Flip button markup must not contain a stray leading-space text node before the label');

  const rotCardStart = src.indexOf('// === Batch Rotation Card ===');
  const rotCardEnd = src.indexOf('inspectorEl.appendChild(rotCard)');
  const singleRotCardStart = src.indexOf('// === Rotate / Flip Card ===');
  const singleRotCardEnd = src.indexOf('// === Actions Card ===', singleRotCardStart);
  const rotBlocks = src.slice(rotCardStart, rotCardEnd) + src.slice(singleRotCardStart, singleRotCardEnd);

  assert.doesNotMatch(rotBlocks, /<svg/i, 'Rotate/Flip controls must not introduce custom SVG icons');
  assert.doesNotMatch(rotBlocks, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    'Rotate/Flip controls must not introduce emoji icons');
});

test('G1.2C-INSPECTOR-CARD-POLISH Actions card preserves all six actions and Delete danger styling', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const multiStart = src.indexOf('function renderMultiInspector');
  const multiEnd = src.indexOf('function renderSingleInspector');
  const singleStart = multiEnd;
  const singleEnd = src.indexOf('function cardHeaderWithInfo');
  const multiBlock = src.slice(multiStart, multiEnd);
  const singleBlock = src.slice(singleStart, singleEnd);

  [multiBlock, singleBlock].forEach((block, idx) => {
    const label = idx === 0 ? 'multi-selection' : 'single-selection';
    assert.match(block, /label: 'Set Category'/, `${label} Actions card must keep Set Category`);
    assert.match(block, /makeVisibilityButton\(pack, /, `${label} Actions card must keep the Hide/Show visibility button`);
    assert.match(block, /makeSelectAllButton\(pack, /, `${label} Actions card must keep Select All`);
    assert.match(block, /label: 'Deselect'/, `${label} Actions card must keep Deselect`);
    assert.match(block, /label: 'Duplicate'/, `${label} Actions card must keep Duplicate`);
    assert.match(block, /danger: true/, `${label} Actions card must keep danger styling on Delete`);
  });

  assert.match(multiBlock, /onClick: \(\) => InteractionManager\.deleteSelection\(\)/,
    'multi-selection Delete must keep calling InteractionManager.deleteSelection()');
  assert.match(singleBlock, /deleteInstancesWithFeedback\(pack\.id, \[inst\.id\]\)/,
    'single-selection Delete must use the shared delete feedback helper');
});

test('G1.2C-INSPECTOR-CARD-POLISH Actions card layout has no inline layout CSS', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  assert.doesNotMatch(src, /configureActionGrid/,
    'configureActionGrid must be removed in favor of a CSS class');
  assert.doesNotMatch(src, /btn\.style\.(width|justifyContent|minWidth|whiteSpace)/,
    'makeActionButton must not set layout via inline styles');

  const actionGridAssignments = src.match(/actRow\.className = 'tp3d-editor-action-grid';/g) || [];
  assert.equal(actionGridAssignments.length, 2,
    'both the multi-selection and single-selection Actions cards must use the tp3d-editor-action-grid class');
});

test('G1.2C-INSPECTOR-CARD-POLISH new CSS additions reuse existing tokens and layout primitives', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');

  const rotIconMatch = css.match(/\.tp3d-editor-rot-btn i\s*\{([^}]*)\}/);
  assert.ok(rotIconMatch, '.tp3d-editor-rot-btn i must be defined to give rotate/flip icons a fixed-width box');
  assert.doesNotMatch(rotIconMatch[1], /#[0-9a-fA-F]{3,6}/, '.tp3d-editor-rot-btn i must not introduce hard-coded colors');

  const actionGridMatch = css.match(/\.tp3d-editor-action-grid\s*\{([^}]*)\}/);
  assert.ok(actionGridMatch, '.tp3d-editor-action-grid must be defined');
  assert.match(actionGridMatch[1], /display:\s*grid/, '.tp3d-editor-action-grid must be a grid container');
  assert.match(actionGridMatch[1], /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    '.tp3d-editor-action-grid must keep the existing 2-column action layout');

  const actionGridBtnMatch = css.match(/\.tp3d-editor-action-grid \.btn\s*\{([^}]*)\}/);
  assert.ok(actionGridBtnMatch, '.tp3d-editor-action-grid .btn must be defined to replace the removed inline button styles');
  assert.doesNotMatch(actionGridBtnMatch[1], /#[0-9a-fA-F]{3,6}/,
    '.tp3d-editor-action-grid .btn must not introduce hard-coded colors');
});

test('G1.2C-INSPECTOR-CARD-POLISH Front Overhang usable-height hint is display-only and reuses existing values', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const overhangStart = src.indexOf("currentMode === 'frontBonus'");
  const overhangEnd = src.indexOf('cfgCard.appendChild(cfgHint)');
  assert.ok(overhangStart >= 0 && overhangEnd > overhangStart, 'the Front Overhang config block must be locatable');
  const overhangBlock = src.slice(overhangStart, overhangEnd);

  assert.match(overhangBlock, /const usableOverhangHeight = Math\.max\(0, tH - bonusHeight\)/,
    'usable overhang height must be derived from the existing tH and bonusHeight values only');
  assert.match(overhangBlock, /Utils\.inchesToUnit\(usableOverhangHeight, lengthUnit\)/,
    'usable overhang height must be formatted with the existing Utils.inchesToUnit helper');
  assert.doesNotMatch(overhangBlock, /TrailerGeometry\./,
    'usable overhang height must not call into TrailerGeometry geometry helpers');
});

test('G1.2C-INSPECTOR-CARD-POLISH G1.2B Case Browser polish remains intact', async () => {
  const [src, css] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(stylesMainPath, 'utf8'),
  ]);

  assert.match(src, /function buildCaseBrowserCard\(c, lengthUnit, prefs, isSelected, pack\)/,
    'the G1.2B shared buildCaseBrowserCard helper must remain intact (Quantity Controls Phase 1 added a ' +
      'trailing pack parameter to gate the per-card target section, otherwise unchanged)');
  assert.match(src, /card\.classList\.toggle\('tp3d-editor-case-browser-card--selected', Boolean\(isSelected\)\)/,
    'the G1.2B selected-case cue toggle must remain unchanged');
  assert.match(css, /\.tp3d-editor-case-browser-card--selected/,
    'the G1.2B selected-case CSS class must remain defined');
  assert.match(css, /\.tp3d-editor-mfg-group-header/,
    'the G1.2B manufacturer group header CSS class must remain defined');
});

test('G1.2C-INSPECTOR-CARD-POLISH Inspector help tooltip is anchored to its triggering icon, not a card-height offset', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');

  assert.doesNotMatch(css, /top:\s*calc\(100% - \d+px\)/,
    'no Inspector tooltip rule may use a fragile card-height-based "top: calc(100% - Npx)" offset');
  assert.doesNotMatch(css, /tp3d-editor-transform-card>\.row\.space-between \.tp3d-editor-info-icon\s*\{[^}]*position:\s*absolute/s,
    'the old absolutely-positioned Transform-card info-icon override must be removed');

  const afterMatch = css.match(/#screen-editor \.tp3d-editor-info-icon\[data-tooltip\]::after\s*\{([^}]*)\}/);
  assert.ok(afterMatch, '#screen-editor .tp3d-editor-info-icon[data-tooltip]::after must define the anchored tooltip box');
  assert.match(afterMatch[1], /right:\s*calc\(100% \+ \d+px\)/,
    'the tooltip box must be anchored beside the triggering icon using right: calc(100% + Npx)');
  assert.match(afterMatch[1], /top:\s*50%/,
    'the tooltip box must be vertically anchored to the triggering icon');
  assert.match(afterMatch[1], /transform:\s*translateY\(-50%\)/,
    'the tooltip box must stay centered beside the triggering icon');

  const beforeMatch = css.match(/#screen-editor \.tp3d-editor-info-icon\[data-tooltip\]::before\s*\{([^}]*)\}/);
  assert.ok(beforeMatch, '#screen-editor .tp3d-editor-info-icon[data-tooltip]::before must define the tooltip arrow');
  assert.match(beforeMatch[1], /right:\s*calc\(100% \+ \d+px\)/,
    'the tooltip arrow must be anchored beside the triggering icon using right: calc(100% + Npx)');
  assert.match(beforeMatch[1], /border-left-color:\s*var\(--text-primary\)/,
    'the tooltip arrow must point from the tooltip box back toward the triggering icon');
});

test('G1.2C-INSPECTOR-CARD-POLISH Inspector help tooltip is compact and CSS-only', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');

  const afterMatch = css.match(/#screen-editor \.tp3d-editor-info-icon\[data-tooltip\]::after\s*\{([^}]*)\}/);
  assert.ok(afterMatch, '#screen-editor .tp3d-editor-info-icon[data-tooltip]::after must define the tooltip box');
  assert.match(afterMatch[1], /max-width:\s*min\(220px, calc\(100vw - 48px\)\)/,
    'the tooltip box must keep a responsive max-width that shrinks on narrow viewports');
  assert.match(afterMatch[1], /white-space:\s*normal/,
    'the tooltip text must wrap naturally instead of forcing a single line');
  assert.doesNotMatch(css, /tp3d-editor-info-icon--tooltip-below/,
    'the rejected tooltip-below placement class must not remain in CSS');
});

test('G1.2C-INSPECTOR-CARD-POLISH Inspector help tooltip placement has no JavaScript measurement or inline styles', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  assert.doesNotMatch(src, /function positionInfoTooltip/,
    'the rejected positionInfoTooltip JavaScript placement helper must be removed');
  assert.doesNotMatch(src, /tp3d-editor-info-icon--tooltip-below/,
    'the rejected tooltip-below placement class must not remain in editor-screen.js');

  const cardHeaderStart = src.indexOf('function cardHeaderWithInfo(titleText, tooltipText)');
  const cardHeaderEnd = src.indexOf('\n    }\n', cardHeaderStart);
  const cardHeaderBody = src.slice(cardHeaderStart, cardHeaderEnd);
  assert.doesNotMatch(cardHeaderBody, /getBoundingClientRect\(\)/,
    'Inspector help tooltip placement must not depend on runtime DOM measurement inside cardHeaderWithInfo');
  assert.doesNotMatch(cardHeaderBody, /addEventListener\('mouseenter'/,
    'cardHeaderWithInfo must not attach tooltip placement listeners on hover');
  assert.doesNotMatch(cardHeaderBody, /addEventListener\('focus'/,
    'cardHeaderWithInfo must not attach tooltip placement listeners on focus');
  assert.doesNotMatch(cardHeaderBody, /\.style\./,
    'cardHeaderWithInfo must not introduce inline layout/positioning styles for the tooltip');
});

test('G1.2C-INSPECTOR-CARD-POLISH remaining Inspector help copy is concise and Reset buttons have no tooltip', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  [
    'Adds a raised deck above the cab. Length controls how far it extends. Deck Height controls cab clearance; the space below is blocked.',
    'Defines matching blocked zones on both sides of the truck. Offset is measured from the rear/loading door.',
    'Position uses the selected display units. Changes are checked against collisions and usable truck zones.',
    'Turn: Y axis. Tip: X axis. Roll: Z axis. Flip: 180°.',
  ].forEach(copy => {
    const escapedCopy = copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(src, new RegExp(escapedCopy), `Inspector help tooltip copy must include: ${copy}`);
  });

  assert.doesNotMatch(src, /Display units follow Settings\. Dimensions are stored internally in inches\./,
    'the removed Truck-header question-mark must not leave its tooltip copy behind');
  assert.doesNotMatch(src, /Reset to defaults for this truck size/,
    'Reset buttons must not keep the rejected tooltip copy');
  assert.doesNotMatch(src, /cfgReset\.setAttribute\('data-tooltip'/,
    'Front Overhang and Wheel Wells Reset buttons must not have data-tooltip attributes');
});

test('G1.2C-INSPECTOR-CARD-POLISH Inspector help tooltips keep keyboard accessibility and use a single shared helper', async () => {
  const [src, css] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(stylesMainPath, 'utf8'),
  ]);

  const cardHeaderCalls = src.match(/cardHeaderWithInfo\(/g) || [];
  assert.equal(cardHeaderCalls.length, 7,
    'the helper definition plus Category Selection, Front Overhang, Wheel Wells, Rotate All, Transform, and Rotate / Flip must remain');

  assert.match(css, /\.tp3d-editor-info-icon\[data-tooltip\]:focus::before,/,
    'keyboard :focus tooltip visibility must be preserved');
  assert.match(css, /\.tp3d-editor-info-icon\[data-tooltip\]:focus-visible::before,/,
    'keyboard :focus-visible tooltip visibility must be preserved');
  assert.match(css, /\.tp3d-editor-info-icon\[data-tooltip\]:focus-within::before,/,
    'keyboard :focus-within tooltip visibility must be preserved');

  assert.doesNotMatch(src, /new\s+(Tooltip|Popper|Popover)\(/,
    'the tooltip fix must not introduce a tooltip/positioning library');
  assert.doesNotMatch(src, /createElement\('div'\)\.className = 'tp3d-tooltip-overlay'/,
    'the tooltip fix must not introduce a new global overlay element');
});

test('G1.2D-INSPECTOR-FINAL-POLISH single selection separates Rotate / Flip without changing handlers', async () => {
  const src = await fs.readFile(editorScreenPath, 'utf8');

  const singleStart = src.indexOf('function renderSingleInspector(pack, inst, caseData, prefs)');
  const singleEnd = src.indexOf('function cardHeaderWithInfo', singleStart);
  assert.ok(singleStart >= 0 && singleEnd > singleStart, 'renderSingleInspector must be locatable');
  const singleBlock = src.slice(singleStart, singleEnd);

  assert.match(singleBlock, /inspectorEl\.appendChild\(transformCard\);[\s\S]*\/\/ === Rotate \/ Flip Card ===/,
    'single-selection Rotate / Flip must render as its own card after the Transform card');
  assert.match(singleBlock, /rotCard\.appendChild\(cardHeaderWithInfo\('Rotate \/ Flip', rotateFlipHelp\)\)/,
    'single-selection Rotate / Flip card must keep the shared help header');
  assert.doesNotMatch(singleBlock, /tp3d-editor-transform-divider/,
    'the old in-card Transform divider must not remain after the visual split');

  const rotateCalls = singleBlock.match(/InteractionManager\.rotateSelection\(axis, delta\)/g) || [];
  assert.equal(rotateCalls.length, 1,
    'single-selection Rotate / Flip card must keep routing through InteractionManager.rotateSelection(axis, delta)');
});

test('G1.2D-INSPECTOR-FINAL-POLISH Front Overhang uses a true two-column field row', async () => {
  const [src, css] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(stylesMainPath, 'utf8'),
  ]);

  assert.match(src, /cfgRow\.className = 'tp3d-editor-dims-row tp3d-editor-dims-row--two'/,
    'Front Overhang Length and Deck Height fields must share a two-column row class');
  assert.match(css, /\.tp3d-editor-dims-row--two\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s,
    'the Front Overhang two-column row must use equal-width grid columns');
});

test('G1.2D-INSPECTOR-FINAL-POLISH visual CSS is scoped, tokenized, and keeps tooltip/reset constraints', async () => {
  const [src, css] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(stylesMainPath, 'utf8'),
  ]);

  assert.match(css, /#inspector-body \.card \.label\s*\{[^}]*font-size:\s*var\(--text-xs\)[^}]*font-weight:\s*var\(--font-medium\)/s,
    'general Inspector labels must remain 12px and medium weight');
  assert.match(css, /#inspector-body \.card > \.field\.tp3d-editor-field-wrap-full \.label,\n#inspector-body \.card \.tp3d-editor-inline-position-field \.label\s*\{[^}]*font-size:\s*var\(--text-sm\)[^}]*font-weight:\s*var\(--font-medium\)/s,
    'full-width offset and X/Y/Z position labels must use 14px and medium weight through specific structural selectors');
  // Superseded by the Editor UI/UX refinement pass: Length/Width/Height are unit
  // labels, not primary field labels, and now render smaller/lighter (~11px) so
  // the values carry the visual weight instead of the unit text.
  assert.match(css, /#inspector-body \.card \.tp3d-editor-dims-row \.field \.label\s*\{[^}]*font-size:\s*11px/s,
    'Length/Width/Height unit labels must render at the smaller, subtle unit-label scale');
  assert.match(css, /#inspector-body \.card \.input,\n#inspector-body \.card \.tp3d-select\s*\{[^}]*min-height:\s*36px[^}]*border-radius:\s*var\(--radius-sm\)[^}]*font-size:\s*var\(--text-sm\)/s,
    'Inspector inputs/selects must use the compact 14px scale and shared 6px radius under #inspector-body');
  assert.match(css, /#inspector-body \.card \.btn\s*\{[^}]*min-height:\s*36px[^}]*border-radius:\s*var\(--radius-sm\)[^}]*font-weight:\s*var\(--font-medium\)/s,
    'Inspector buttons must use the shared 6px radius and medium weight under #inspector-body');
  // Superseded by the Editor UI regression hotfix: the selected-case category is a
  // compact metadata pill beside the dimensions, no longer a full-width field.
  assert.doesNotMatch(css, /\.tp3d-editor-chip-mini/,
    'the selected-case category must not return to a full-width field');
  assert.match(css, /\.tp3d-editor-inline-position-field\s*\{[^}]*display:\s*grid/s,
    'X/Y/Z position fields must stack label over input so narrow Inspector widths do not clip values');
  assert.match(css, /\.tp3d-editor-dims-row \.tp3d-editor-minw-90\s*\{[^}]*min-width:\s*0/s,
    'dimension fields inside grid rows must be allowed to shrink without overflowing');
  assert.match(css, /\.tp3d-editor-info-icon\s*\{[^}]*color:\s*inherit/s,
    'Inspector help icons must keep the inherited dark header color instead of a muted override');
  assert.match(src, /cfgHint\.className = 'muted tp3d-editor-fs-xs'/,
    'Front Overhang usable-height helper must use the existing 12px tp3d-editor-fs-xs utility');
  assert.doesNotMatch(src, /cfgHint\.className = 'muted tp3d-editor-fs-sm'/,
    'Front Overhang usable-height helper must not keep the 14px tp3d-editor-fs-sm utility');

  const statsCardMatch = css.match(/\.tp3d-editor-stats-card\s*\{([^}]*)\}/);
  assert.ok(statsCardMatch, 'Stats card CSS block must remain defined');
  assert.match(statsCardMatch[1], /background:\s*var\(--bg-primary\)/,
    'Stats card must use the theme-driven bg-primary token');
  assert.doesNotMatch(statsCardMatch[1], /#f6f7fb|#F6F7FB/,
    'Stats card must not hard-code the light theme #F6F7FB value');
  assert.match(css, /:root\s*\{[\s\S]*--bg-primary:\s*#f6f7fb/i,
    'light theme bg-primary must continue to provide the requested #F6F7FB value');
  assert.match(css, /\[data-theme='dark'\]\s*\{[\s\S]*--bg-primary:/,
    'dark mode must continue to override bg-primary through existing theme tokens');
  assert.doesNotMatch(css, /\[data-theme='dark'\]\s+\.tp3d-editor-stats-card/,
    'Stats card must not need a special dark-mode override');

  [
    ['turn', 'success'],
    ['tip', 'error'],
    ['roll', 'info'],
    ['flip', 'text-secondary'],
  ].forEach(([tone, token]) => {
    const toneMatch = css.match(new RegExp(`\\.tp3d-editor-rot-btn--${tone} i\\s*\\{([^}]*)\\}`));
    assert.ok(toneMatch, `Rotate / Flip ${tone} tone class must be defined`);
    assert.match(toneMatch[1], new RegExp(`var\\(--${token}\\)`),
      `Rotate / Flip ${tone} icon color must use var(--${token})`);
    assert.doesNotMatch(toneMatch[1], /#[0-9a-fA-F]{3,6}/,
      `Rotate / Flip ${tone} icon color must not hard-code a hex value`);
  });

  assert.doesNotMatch(src, /cfgReset\.setAttribute\('data-tooltip'/,
    'Reset buttons must remain tooltip-free');
  assert.doesNotMatch(src, /function positionInfoTooltip|tp3d-editor-info-icon--tooltip-below/,
    'the approved CSS-only tooltip system must not regain JS placement or below-class logic');
});

test('PACK-PREVIEW-SCHEDULER rapid Pack edits coalesce into one capture', async () => {
  const runtime = await createPackPreviewSchedulerHarness();
  const pack = runtime.packs.get('pack-a');
  const initialLastEdited = pack.lastEdited;
  runtime.scheduler.schedule();
  pack.cases[0].transform = { position: { x: 1, y: 0, z: 0 } };
  runtime.scheduler.schedule();
  pack.cases[0].transform = { position: { x: 2, y: 0, z: 0 } };
  runtime.scheduler.schedule();

  assert.equal(pack.lastEdited, initialLastEdited, 'visual freshness does not require a lastEdited change');
  assert.equal(runtime.timers.size, 1, 'only the latest debounce remains scheduled');
  runtime.runTimers();
  assert.equal(runtime.captures.length, 1);
});

test('PACK-PREVIEW-SCHEDULER thumbnail writes do not recurse and fresh Packs do not schedule', async () => {
  const runtime = await createPackPreviewSchedulerHarness({
    onCapture: ({ packId, packs }) => {
      const pack = packs.get(packId);
      pack.thumbnailVisualSignature = previewHarnessVisualSignature(pack);
      pack.thumbnailViewSignature = previewHarnessViewSignature(pack);
      return true;
    },
  });
  runtime.scheduler.schedule();
  runtime.runTimers();
  assert.equal(runtime.captures.length, 1);

  assert.equal(runtime.scheduler.schedule(), false, 'thumbnail-only notification sees a fresh Pack');
  assert.equal(runtime.timers.size, 0, 'fresh thumbnail does not create a recursive timer');
  runtime.runTimers();
  assert.equal(runtime.captures.length, 1);

  const freshPack = { id: 'pack-a', cases: [{ id: 'instance-a' }], lastEdited: 200, thumbnailUpdatedAt: 100 };
  freshPack.thumbnailVisualSignature = previewHarnessVisualSignature(freshPack);
  freshPack.thumbnailViewSignature = previewHarnessViewSignature(freshPack);
  const alreadyFresh = await createPackPreviewSchedulerHarness({ pack: freshPack });
  assert.equal(alreadyFresh.scheduler.schedule(), false);
  assert.equal(alreadyFresh.timers.size, 0);
});

test('PACK-PREVIEW-SCHEDULER wiring uses pre-navigation flush and shared manual preparation', async () => {
  const [appSrc, packsSrc, shellSrc] = await Promise.all([
    fs.readFile(appPath, 'utf8'), fs.readFile(packsScreenPath, 'utf8'),
    fs.readFile(new URL('../../src/ui/app-shell.js', import.meta.url), 'utf8'),
  ]);
  const subscriberStart = appSrc.indexOf('StateStore.subscribe((changes, _state, notification) => {');
  const subscriberEnd = appSrc.indexOf('\n      });\n\n      try {\n        Router.init(', subscriberStart);
  assert.ok(subscriberStart >= 0 && subscriberEnd > subscriberStart, 'render subscriber is extractable');
  const subscriber = appSrc.slice(subscriberStart, subscriberEnd);
  assert.match(subscriber, /if \(notification\?\.type === 'pack-preview'\) \{\s*PacksUI\.render\(\);\s*return;/,
    'preview-only writes refresh Packs and do not schedule another capture');
  assert.match(subscriber, /if \(previewContextChanged \|\| changes\.packLibrary \|\| changes\.caseLibrary \|\|\s*changes\.preferences \|\| changes\._undo \|\| changes\._redo\) AutoPackPreviewScheduler\.schedule\(\);/,
    'one producer evaluates freshness for context and visual dependencies');
  assert.match(subscriber, /if \(notification\?\.type === 'pack-view'\) \{\s*AutoPackPreviewScheduler\.schedule\(\);\s*return;/,
    'settled camera metadata schedules preview freshness without reconstructing Editor');
  // A measurement-only write replaces the Pack object and so aborts an in-flight capture: it re-requests
  // freshness (a current thumbnail yields no candidate) without reconstructing the Editor.
  assert.match(subscriber, /if \(notification\?\.type === 'pack-measurements'\) \{\s*PacksUI\.render\(\);\s*EditorUI\.syncMeasurements\(\);\s*AutoPackPreviewScheduler\.schedule\(\);\s*return;/,
    'a measurement-only write schedules preview freshness without reconstructing Editor');
  // An annotation-only write is the same kind of authored-collection write: it replaces the Pack object, so it
  // re-requests freshness and refreshes the overlay without reconstructing the Editor or the scene.
  assert.match(subscriber, /if \(notification\?\.type === 'pack-annotations'\) \{\s*PacksUI\.render\(\);\s*EditorUI\.syncAnnotations\(\);\s*AutoPackPreviewScheduler\.schedule\(\);\s*return;/,
    'an annotation-only write schedules preview freshness without reconstructing Editor');
  assert.equal((subscriber.match(/AutoPackPreviewScheduler\.schedule\(\)/g) || []).length, 4,
    'the subscriber schedules freshness for Pack view metadata, after a measurement-only write, after an annotation-only write, and for normal visual dependencies');
  assert.ok(subscriber.indexOf('EditorUI.render();') < subscriber.indexOf('if (previewContextChanged'),
    'Pack activation synchronizes Editor before preview freshness is scheduled');
  assert.ok(shellSrc.indexOf('beforeNavigate(previousScreen, screenKey)') < shellSrc.indexOf('StateStore.set({ currentScreen: screenKey }'));
  assert.equal((packsSrc.match(/ExportService\.capturePackPreviewFromLibrary\(pack\.id, openPack\)/g) || []).length, 2);
  // Ordering and pixel identity are exercised by preview-identity-context.spec.mjs.
});

test('P0 EDITOR-ONLY UNDO/REDO: keyboard Undo does not reach StateStore.undo() outside Editor', async () => {
  const keyboardSrc = await fs.readFile(keyboardManagerPath, 'utf8');
  const start = keyboardSrc.indexOf('function undo()');
  assert.ok(start >= 0, 'function undo() must exist');
  const block = keyboardSrc.slice(start, start + 520);
  // Outside Editor the only reachable path is the Load Plans Folder provider (F-08), never StateStore directly.
  const guardLine = 'if (!inEditor()) return Boolean(folderHistory && folderHistory.undo());';
  const guardIdx = block.indexOf(guardLine);
  const busyGuardIdx = block.indexOf('if (mutationBlockedWhileBusy()) return true;');
  const storeCallIdx = block.indexOf('StateStore.undo()');
  assert.ok(guardIdx >= 0, 'undo() must check inEditor() before mutating StateStore and route only to folderHistory outside Editor');
  assert.ok(busyGuardIdx > guardIdx, 'undo() must still preserve the existing busy guard inside Editor');
  assert.ok(storeCallIdx > busyGuardIdx, 'undo() must still call StateStore.undo() inside Editor after both guards');
  assert.equal(block.match(/StateStore\.undo\(\)/g).length, 1,
    'undo() must reach StateStore.undo() exactly once, on the Editor path only');
  assert.match(block, /UIComponents\.showToast\(ok \? 'Undone' : 'Nothing to undo'/,
    'undo() must preserve its existing toast behavior inside Editor');
});

test('P0 EDITOR-ONLY UNDO/REDO: keyboard Redo does not reach StateStore.redo() outside Editor', async () => {
  const keyboardSrc = await fs.readFile(keyboardManagerPath, 'utf8');
  const start = keyboardSrc.indexOf('function redo()');
  assert.ok(start >= 0, 'function redo() must exist');
  const block = keyboardSrc.slice(start, start + 520);
  // Outside Editor the only reachable path is the Load Plans Folder provider (F-08), never StateStore directly.
  const guardLine = 'if (!inEditor()) return Boolean(folderHistory && folderHistory.redo());';
  const guardIdx = block.indexOf(guardLine);
  const busyGuardIdx = block.indexOf('if (mutationBlockedWhileBusy()) return true;');
  const storeCallIdx = block.indexOf('StateStore.redo()');
  assert.ok(guardIdx >= 0, 'redo() must check inEditor() before mutating StateStore and route only to folderHistory outside Editor');
  assert.ok(busyGuardIdx > guardIdx, 'redo() must still preserve the existing busy guard inside Editor');
  assert.ok(storeCallIdx > busyGuardIdx, 'redo() must still call StateStore.redo() inside Editor after both guards');
  assert.equal(block.match(/StateStore\.redo\(\)/g).length, 1,
    'redo() must reach StateStore.redo() exactly once, on the Editor path only');
  assert.match(block, /UIComponents\.showToast\(ok \? 'Redone' : 'Nothing to redo'/,
    'redo() must preserve its existing toast behavior inside Editor');
});

test('P0 EDITOR UNDO ATOMICITY: Hide/Show commits the whole selection in one PackLibrary.update() call', async () => {
  const editorSrc = await fs.readFile(editorScreenPath, 'utf8');

  const start = editorSrc.indexOf('function makeVisibilityButton(pack, selectedIds) {');
  assert.ok(start >= 0, 'makeVisibilityButton() must exist');
  const end = editorSrc.indexOf('\n    }', start);
  assert.ok(end > start, 'makeVisibilityButton() must close');
  const block = editorSrc.slice(start, end);

  assert.doesNotMatch(block, /PackLibrary\.updateInstance\(/,
    'Hide/Show must not loop PackLibrary.updateInstance() once per selected instance');
  const updateCalls = block.match(/PackLibrary\.update\(pack\.id/g) || [];
  assert.equal(updateCalls.length, 1, 'Hide/Show must call PackLibrary.update() exactly once for the whole selection');
  assert.match(block, /if \(editorMutationBlocked\(\{ endPreview: true \}\)\) return;/,
    'Hide/Show must refuse busy state and end transient preview before its atomic write');
  assert.ok(block.indexOf('editorMutationBlocked({ endPreview: true })') < block.indexOf('PackLibrary.update(pack.id'),
    'the authority guard precedes the one Pack write');
});

test('P0 CASE/CATEGORY ATOMICITY: Editor Set Category wiring uses the atomic commit, not per-case upsert', async () => {
  const editorSrc = await fs.readFile(editorScreenPath, 'utf8');

  const start = editorSrc.indexOf('function openSetCategoryModal(pack, selectedIds) {');
  assert.ok(start >= 0, 'openSetCategoryModal() must exist');
  const end = editorSrc.indexOf('\n    }', start);
  assert.ok(end > start, 'openSetCategoryModal() must close');
  const block = editorSrc.slice(start, end);

  assert.doesNotMatch(block, /CaseLibrary\.upsert\(/,
    'Set Category must not loop CaseLibrary.upsert() once per selected Case template');
  assert.doesNotMatch(block, /CategoryService\.upsert\(/,
    'Set Category must not publish the category separately from the Case commit');
  const commitCalls = block.match(/CaseLibrary\.commitCasesWithCategory\(/g) || [];
  assert.equal(commitCalls.length, 1,
    'Set Category must call the atomic Case+category commit exactly once for the whole Apply');
});

test('P0 CASE/CATEGORY ATOMICITY: Case modal Save wiring uses the atomic commit, not two separate publishes', async () => {
  const src = await fs.readFile(caseModalPath, 'utf8');

  const saveStart = src.indexOf("label: 'Save'", src.indexOf('UIComponents.showModal({'));
  assert.ok(saveStart >= 0, 'the shared Case modal Save action must exist');
  const saveBlock = src.slice(saveStart, saveStart + 4200);

  assert.doesNotMatch(saveBlock, /CategoryService\.upsert\(/,
    'Save must not publish the category separately from the Case commit');
  assert.doesNotMatch(saveBlock, /CaseLibrary\.upsert\(caseData\)/,
    'Save must not publish the Case separately from the category commit');
  // HANDLING-RULES-P0A: PackLibrary.commitCaseHandlingRuleChange() is the one
  // atomic commit now — it still publishes the Case and category together
  // (plus, when applicable, the actively-displayed Pack's revalidation) in a
  // single StateStore write; see PACK VALIDITY SIGNATURE atomicity coverage.
  assert.doesNotMatch(saveBlock, /CaseLibrary\.commitCaseWithCategory\(/,
    'Save must route through the atomic PackLibrary orchestration, not call CaseLibrary.commitCaseWithCategory directly');
  assert.match(saveBlock, /PackLibrary\.commitCaseHandlingRuleChange\(\s*caseData,/,
    'Save must commit the Case and category atomically in one call');
  // The inline "+Add" category button remains a separate, category-only,
  // already-atomic action and must keep using CategoryService.upsert().
  const addCategoryStart = src.indexOf("newCatSave.addEventListener('click'");
  const addCategoryEnd = src.indexOf('catWrap.appendChild(catCreateRow)');
  const addCategoryBlock = src.slice(addCategoryStart, addCategoryEnd);
  assert.match(addCategoryBlock, /CategoryService\.upsert\(/,
    'the standalone Add Category action is unaffected by the Save atomicity fix');
});

test('HARDEN-P1A post-boot unhandledrejection handler shows toast for any non-abort rejection', async () => {
  const src = await readAppSource();

  // Locate the handler body between its declaration and the subsequent addEventListener calls
  const handlerDecl = src.indexOf('const handleRuntimeUnhandledRejection = ev =>');
  const addListenerAnchor = src.indexOf("window.addEventListener('error', handleRuntimeError", handlerDecl);
  assert.ok(handlerDecl >= 0, 'handleRuntimeUnhandledRejection declaration found');
  assert.ok(addListenerAnchor > handlerDecl, 'addEventListener anchor found after handler declaration');
  const handlerBlock = src.slice(handlerDecl, addListenerAnchor);

  // console.error must be retained
  assert.match(handlerBlock, /console\.error/, 'console.error retained in rejection handler');

  // Old message-gated condition must be gone — messageless rejections must also surface
  assert.doesNotMatch(
    handlerBlock,
    /if\s*\(\s*message\s*&&\s*!isAbortLike\s*\)/,
    'message-gated toast condition must be removed so messageless rejections also show a toast',
  );

  // New condition: guard only on isAbortLike
  assert.match(
    handlerBlock,
    /if\s*\(\s*!isAbortLike\s*\)/,
    'toast must fire for any non-AbortError rejection, checked via !isAbortLike only',
  );

  // Throttle variable must exist at module level
  assert.match(src, /_postBootRejectionToastAt/, 'module-level throttle timestamp variable must exist');

  // Toast message must use the spec wording
  assert.match(handlerBlock, /feels stuck/, 'toast message must include "feels stuck" per spec');
});

test('HARDEN-P1B queueOrgScopedRender calls syncRecoverableErrorOverlay after EditorUI.render', async () => {
  const src = await readAppSource();

  const fnStart = src.indexOf('function queueOrgScopedRender(');
  assert.ok(fnStart >= 0, 'queueOrgScopedRender function found');

  // Extract function body by brace depth
  let depth = 0;
  let bodyEnd = -1;
  for (let i = fnStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { bodyEnd = i + 1; break; }
    }
  }
  assert.ok(bodyEnd > fnStart, 'queueOrgScopedRender body extracted');
  const fnBody = src.slice(fnStart, bodyEnd);

  assert.match(fnBody, /EditorUI\.render/, 'EditorUI.render present in queueOrgScopedRender');
  assert.match(fnBody, /syncRecoverableErrorOverlay/, 'syncRecoverableErrorOverlay called in queueOrgScopedRender');

  // syncRecoverableErrorOverlay must be called AFTER EditorUI.render
  const editorRenderPos = fnBody.indexOf('EditorUI.render');
  const syncPos = fnBody.indexOf('syncRecoverableErrorOverlay');
  assert.ok(syncPos > editorRenderPos, 'syncRecoverableErrorOverlay must follow EditorUI.render in queueOrgScopedRender');
});

test('HARDEN-P1B hasMissingEditorPack and syncRecoverableErrorOverlay implement pack-not-found path', async () => {
  const src = await fs.readFile(recoverableErrorOverlayPath, 'utf8');

  // Both functions must be present
  assert.match(src, /function hasMissingEditorPack\(\)/, 'hasMissingEditorPack function present');
  assert.match(src, /function syncRecoverableErrorOverlay\(\)/, 'syncRecoverableErrorOverlay function present');

  // hasMissingEditorPack must check screen, packId, and PackLibrary.getById
  const missingStart = src.indexOf('function hasMissingEditorPack()');
  const missingEnd = src.indexOf('\n    function syncRecoverableErrorOverlay', missingStart);
  const missingFn = missingStart >= 0 && missingEnd > missingStart
    ? src.slice(missingStart, missingEnd)
    : src.slice(missingStart, missingStart + 400);
  assert.match(missingFn, /editor/, 'hasMissingEditorPack checks for editor screen');
  assert.match(missingFn, /currentPackId/, 'hasMissingEditorPack reads currentPackId');
  assert.match(missingFn, /PackLibrary\.getById/, 'hasMissingEditorPack calls PackLibrary.getById');

  // syncRecoverableErrorOverlay must call hasMissingEditorPack and show pack overlay
  const syncStart = src.indexOf('function syncRecoverableErrorOverlay()');
  const syncEnd = src.indexOf('\n    // ===', syncStart);
  const syncFn = syncStart >= 0 && syncEnd > syncStart
    ? src.slice(syncStart, syncEnd)
    : src.slice(syncStart, syncStart + 500);
  assert.match(syncFn, /hasMissingEditorPack/, 'syncRecoverableErrorOverlay calls hasMissingEditorPack');
  assert.match(syncFn, /kind.*pack|pack.*kind/, "syncRecoverableErrorOverlay shows overlay with kind:'pack'");
});

test('BUG-07-A updateSidebarNotice clears stale markup on every hide path', async () => {
  const src = await readAppSource();

  const fnStart = src.indexOf('const updateSidebarNotice = (s) => {');
  assert.ok(fnStart >= 0, 'updateSidebarNotice found');
  const fnEnd = src.indexOf('BillingService.setBillingGateApplier(updateSidebarNotice)', fnStart);
  assert.ok(fnEnd > fnStart, 'updateSidebarNotice span resolved');
  const fn = src.slice(fnStart, fnEnd);

  // 5 hide paths + 1 rebuild-on-show path all wipe innerHTML.
  const wipes = fn.split("upgradeEl.innerHTML = ''").length - 1;
  assert.ok(wipes >= 6, `expected >= 6 innerHTML wipes (5 hide paths + rebuild), found ${wipes}`);

  // Named hide branches each wipe before hiding.
  for (const marker of [
    "// Card wasn't visible — keep it hidden until we have resolved data.",
    'if (!s.ok) {',
    'if (isIncludedInPlan || (isEntitled && !isTrial)) {',
    'if (!canManageBilling && !showInfoOnlyCard) {',
    'if (!isTrial && !needsUpgrade) {',
  ]) {
    const idx = fn.indexOf(marker);
    assert.ok(idx >= 0, `hide branch marker present: ${marker}`);
    const region = fn.slice(idx, idx + 420);
    assert.match(region, /upgradeEl\.innerHTML = ''/, `hide branch wipes markup: ${marker}`);
    assert.match(region, /hidden = true/, `hide branch hides the card: ${marker}`);
  }

  // Payment banner hide path wipes its text too.
  const payHideIdx = fn.indexOf('} else if (payBanner) {');
  assert.ok(payHideIdx >= 0, 'payment banner hide branch present');
  const payRegion = fn.slice(payHideIdx, payHideIdx + 260);
  assert.match(payRegion, /payBanner\.textContent = ''/, 'payment banner text cleared on hide');

  // The show path fully rebuilds markup from scratch.
  const showIdx = fn.indexOf('upgradeWrap.hidden = false');
  assert.ok(showIdx >= 0, 'show path present');
  const showRegion = fn.slice(showIdx, showIdx + 700);
  assert.match(showRegion, /upgradeEl\.innerHTML = ''/, 'show path rebuilds from empty');
});

test('BUG-07-B synthetic: the hide contract leaves no stale child markup', () => {
  // Emulates the per-branch hide contract now used by updateSidebarNotice.
  const upgradeEl = { innerHTML: '<div>User A — Trial ends in 3 days</div>', hidden: false };
  const upgradeWrap = { hidden: false };

  upgradeEl.innerHTML = '';
  if (upgradeWrap) upgradeWrap.hidden = true;
  else upgradeEl.hidden = true;

  assert.strictEqual(upgradeEl.innerHTML, '', 'stale prior-identity markup removed at the source');
  assert.strictEqual(upgradeWrap.hidden, true, 'card hidden');
});

test('APP-STABILIZATION-PHASE3 app shares one lifecycle with screens, dialogs, editor, and preview clearing', async () => {
  const src = await readAppSource();
  const constructionStart = src.indexOf('const ImportPackDialog = createImportPackDialog({');
  const constructionEnd = src.indexOf('// SECTION: SCREEN UI (UPDATES)', constructionStart);
  const construction = src.slice(constructionStart, constructionEnd);
  assert.ok(construction, 'screen and dialog construction block is extractable');
  for (const factory of [
    'createImportPackDialog',
    'createImportCasesDialog',
    'createPacksScreen',
    'createCasesScreen',
    'createEditorScreen',
  ]) {
    const start = construction.indexOf(`${factory}({`);
    const end = construction.indexOf('\n    });', start);
    assert.ok(start >= 0 && end > start, `${factory} construction is extractable`);
    assert.match(construction.slice(start, end), /OperationLifecycle/,
      `${factory} receives the single authoritative lifecycle`);
  }

  const clearStart = src.indexOf('function clearPackPreview(');
  const clearEnd = src.indexOf('\n      function captureScreenshot(', clearStart);
  const clearFn = src.slice(clearStart, clearEnd);
  assert.ok(clearFn.indexOf('OperationLifecycle.isBusy()') < clearFn.indexOf('PackLibrary.getById(packId)'),
    'preview clearing rejects busy state before reading or mutating the pack');
  const previewWriteIndex = clearFn.indexOf('PackLibrary.updatePreview(packId');
  assert.ok(previewWriteIndex >= 0 && clearFn.indexOf('OperationLifecycle.isBusy()') < previewWriteIndex,
    'preview clearing cannot race an active capture or editor operation');
});

test('APP-STABILIZATION-PHASE3 Packs truck preview owns and releases the lifecycle token at every terminal', async () => {
  const src = await fs.readFile(packsScreenPath, 'utf8');
  const requestStart = src.indexOf('function requestTruckChange(');
  const requestEnd = src.indexOf('\n    function formatTruckDims(', requestStart);
  const requestSource = src.slice(requestStart, requestEnd);
  assert.ok(requestSource, 'Packs truck lifecycle wrapper is extractable');

  const { createOperationLifecycle } = await import(
    `${operationLifecyclePath.href}?phase3-packs=${Date.now()}-${Math.random()}`
  );
  const OperationLifecycle = createOperationLifecycle({ now: () => 123 });
  const context = {
    OperationLifecycle,
    __controllerCalls: 0,
    __lastOptions: null,
    __status: 'preview',
    __busyNotices: 0,
  };
  vm.createContext(context);
  vm.runInContext(`
    const mutationBlockedWhileBusy = () => {
      const blocked = OperationLifecycle.isBusy();
      if (blocked) globalThis.__busyNotices += 1;
      return blocked;
    };
    const TruckChangeController = {
      request(options) {
        globalThis.__controllerCalls += 1;
        globalThis.__lastOptions = options;
        return { status: globalThis.__status };
      },
    };
    ${requestSource}
    globalThis.__requestTruckChange = requestTruckChange;
  `, context);

  const pack = { id: 'pack-1' };
  assert.equal(context.__requestTruckChange({ pack }).status, 'preview');
  assert.equal(OperationLifecycle.currentOperation().kind, 'changingTruck',
    'preview keeps the lifecycle slot for its full modal lifetime');
  assert.equal(context.__requestTruckChange({ pack }).status, 'busy',
    'a second truck mutation is rejected while preview owns the slot');
  assert.equal(context.__controllerCalls, 1, 'busy request never reaches the controller');

  context.__lastOptions.restoreControls();
  assert.equal(OperationLifecycle.isBusy(), false, 'cancel/close restoration releases the token');

  context.__status = 'committed';
  context.__requestTruckChange({ pack });
  assert.equal(OperationLifecycle.isBusy(), false, 'non-preview terminal releases immediately');

  context.__status = 'preview';
  context.__requestTruckChange({ pack });
  assert.equal(OperationLifecycle.isBusy(), true);
  context.__lastOptions.onCommitted({ id: pack.id });
  assert.equal(OperationLifecycle.isBusy(), false, 'preview commit callback releases the token');
});

test('APP-STABILIZATION-PHASE3 Packs and Cases re-check guarded mutation commit edges', async () => {
  const [packsSrc, casesSrc, transferSrc, packDialogSrc, casesDialogSrc] = await Promise.all([
    fs.readFile(packsScreenPath, 'utf8'),
    fs.readFile(casesScreenPath, 'utf8'),
    fs.readFile(new URL('../../src/screens/import-export-screen.js', import.meta.url), 'utf8'),
    fs.readFile(importPackDialogPath, 'utf8'),
    fs.readFile(importCasesDialogPath, 'utf8'),
  ]);

  assert.match(packsSrc, /function openPack\(packId\) \{\s*if \(mutationBlockedWhileBusy\(\)\) return;\s*const pack = PackLibrary\.open/,
    'active pack switching is guarded at the mutation edge');
  assert.match(packsSrc, /function openNewPackModal\(\) \{\s*if \(mutationBlockedWhileBusy\(\)\) return;/,
    'new-pack entry is guarded');
  assert.match(packsSrc, /async function handleBulkDelete\([\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*await UIComponents\.confirm[\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*PackLibrary\.remove/,
    'bulk pack delete checks both before and after confirmation');
  assert.match(packsSrc, /async function deletePack\([\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*await UIComponents\.confirm[\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*PackLibrary\.remove/,
    'single pack delete checks both before and after confirmation');
  assert.match(transferSrc, /if \(OperationLifecycle && OperationLifecycle\.isBusy\(\)\)[\s\S]*?const controller = kind === 'cases' \? ImportCasesDialog : ImportPackDialog;[\s\S]*?activeReview = controller\.open\(\{/,
    'both imports reject an active operation before opening the review');
  assert.match(transferSrc, /beforeMutate: \(\) => \{[\s\S]*?StateStore\.get\('currentScreen'\) !== 'import-export'[\s\S]*?Storage\.isScopeContextCurrent\(activeScope\)/,
    'both imports receive a commit-time screen and workspace callback');
  for (const [name, dialogSrc] of [['load plan', packDialogSrc], ['case', casesDialogSrc]]) {
    assert.match(dialogSrc, /function mutationAllowed\(\) \{[\s\S]*?guard\(\) === false[\s\S]*?OperationLifecycle\.isBusy\(\)/,
      `${name} import rechecks the callback and lifecycle at commit`);
  }
  assert.match(packDialogSrc, /if \(!mutationAllowed\(\)\) return;\s*const result = PackLibrary\.importPackPayload/,
    'single load plan import checks the guard immediately before writing');
  assert.match(packDialogSrc, /for \(const payload of parsedPayload\.payloads \|\| \[\]\) \{\s*if \(!mutationAllowed\(\)\)/,
    'batch load plan import checks the guard before each write');
  for (const mutation of [
    'FolderLibrary.createFolder',
    'FolderLibrary.renameFolder',
    'FolderLibrary.deleteFolder',
    'FolderLibrary.movePackToFolder',
    'PackLibrary.duplicate',
  ]) {
    const index = packsSrc.indexOf(mutation);
    assert.ok(index >= 0, `${mutation} remains wired`);
    assert.match(packsSrc.slice(Math.max(0, index - 260), index), /mutationBlockedWhileBusy\(\)/,
      `${mutation} is preceded by the shared busy guard`);
  }

  assert.match(casesSrc, /function openCaseModal\(existing\) \{\s*if \(mutationBlockedWhileBusy\(\)\) return;[\s\S]*beforeMutate/,
    'case create/edit entry and modal commit share the guard');
  assert.match(casesDialogSrc, /function doImport\(\) \{\s*if \(!hasImportableChanges\(\)\) return;\s*if \(!mutationAllowed\(\)\) return;/,
    'case import checks the guard before either commit path');
  assert.match(casesDialogSrc, /ImportExport\.importCaseRows\(parsedResult\.valid\);\s*if \(!mutationAllowed\(\)\) return;\s*StateStore\.set/,
    'spreadsheet case import rechecks the guard immediately before state mutation');
  assert.match(casesSrc, /async function bulkDeleteSelected\([\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*await UIComponents\.confirm[\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*PackLibrary\.commitCaseDeletion/,
    'bulk case delete checks both before and after confirmation');
  assert.match(casesSrc, /async function deleteCase\([\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*await UIComponents\.confirm[\s\S]*mutationBlockedWhileBusy\(\)[\s\S]*PackLibrary\.commitCaseDeletion/,
    'single case delete checks both before and after confirmation');
  assert.doesNotMatch(casesSrc, /CategoryService\.resetToDefaultIfNoCases/,
    'the Cases screen render never normalizes categories; the guarded Case deletion transition owns that write');
});

test('APP-STABILIZATION-PHASE3 dialog guards sit immediately before import, category, and case commits', async () => {
  const [packDialog, casesDialog, caseModal] = await Promise.all([
    fs.readFile(importPackDialogPath, 'utf8'),
    fs.readFile(importCasesDialogPath, 'utf8'),
    fs.readFile(caseModalPath, 'utf8'),
  ]);

  assert.match(packDialog, /if \(!mutationAllowed\(\)\) return;\s*const result = PackLibrary\.importPackPayload/,
    'single pack import re-checks immediately before commit');
  assert.match(packDialog, /for \(const payload[\s\S]*if \(!mutationAllowed\(\)\)[\s\S]*PackLibrary\.importPackPayload\(payload\)/,
    'each batch pack import row re-checks before commit');
  assert.match(casesDialog, /const result = ImportExport\.importCaseRows\(parsedResult\.valid\);\s*if \(!mutationAllowed\(\)\) return;\s*StateStore\.set/,
    'case import computes a pure plan then checks immediately before state commit');

  const addCategory = caseModal.slice(
    caseModal.indexOf("newCatSave.addEventListener('click'"),
    caseModal.indexOf('catWrap.appendChild(catCreateRow)'),
  );
  assert.ok(addCategory.indexOf('beforeMutate() === false') < addCategory.indexOf('CategoryService.upsert'),
    'shared modal checks before adding a category');
  const saveStart = caseModal.indexOf("label: 'Save'", caseModal.indexOf('UIComponents.showModal({'));
  const saveBlock = caseModal.slice(saveStart, saveStart + 4200);
  const saveGuard = saveBlock.indexOf('beforeMutate() === false');
  assert.ok(saveGuard >= 0, 'shared modal Save has a lifecycle guard');
  // HANDLING-RULES-P0A: the atomic commit is now PackLibrary.commitCaseHandlingRuleChange().
  const commitIndex = saveBlock.indexOf('PackLibrary.commitCaseHandlingRuleChange');
  assert.ok(commitIndex >= 0, 'Save must call the atomic PackLibrary orchestration');
  assert.ok(saveGuard < commitIndex,
    'Save guards the atomic Case + category commit');
});

test('APP-STABILIZATION-PHASE3 remaining editor mutation commits reuse editorMutationBlocked', async () => {
  const [src, notesOverlay] = await Promise.all([
    fs.readFile(editorScreenPath, 'utf8'),
    fs.readFile(notesOverlayPath, 'utf8'),
  ]);
  const newCase = src.slice(
    src.indexOf('function openEditorNewCaseModal()'),
    src.indexOf('function setCaseFiltersVisible', src.indexOf('function openEditorNewCaseModal()')),
  );
  assert.match(newCase, /editorMutationBlocked\(\)[\s\S]*beforeMutate: \(\) => !editorMutationBlocked\(\)/,
    'editor New Case checks both modal entry and Save/Add Category commits');

  const visibility = src.slice(
    src.indexOf('function makeVisibilityButton('),
    src.indexOf('function duplicateSelection(', src.indexOf('function makeVisibilityButton(')),
  );
  const visibilityGuard = visibility.indexOf('editorMutationBlocked({ endPreview: true })');
  assert.ok(visibilityGuard >= 0 && visibilityGuard < visibility.indexOf('PackLibrary.update(pack.id'),
    'visibility mutation is guarded before any instance write');

  const category = src.slice(
    src.indexOf('function openSetCategoryModal('),
    src.indexOf('// Load Plan Notes is', src.indexOf('function openSetCategoryModal(')),
  );
  assert.match(category, /function openSetCategoryModal[\s\S]*editorMutationBlocked\(\)/,
    'Set Category entry is guarded');
  assert.ok(category.lastIndexOf('editorMutationBlocked()') < category.indexOf('CaseLibrary.commitCasesWithCategory'),
    'Set Category Apply re-checks before its atomic Case + category commit');
  assert.doesNotMatch(category, /endPreview: true|endAutoPackResultsPreview\(/,
    'category presentation edits do not end Results preview');

  const notesSave = src.slice(
    src.indexOf("label: 'Save'", src.indexOf('function openNotesModal(')),
    src.indexOf('// Every editor truck writer', src.indexOf('function openNotesModal(')),
  );
  assert.ok(notesSave.indexOf('editorMutationBlocked()') < notesSave.indexOf('PackLibrary.updateInstance'),
    'Item Notes Save re-checks before the instance write');
  assert.doesNotMatch(notesSave, /endPreview: true|endAutoPackResultsPreview\(/,
    'Item Notes edits do not end Results preview');

  const packNotesAdapter = src.slice(
    src.indexOf('function openPackNotesModal('),
    src.indexOf('// Single Notes modal', src.indexOf('function openPackNotesModal(')),
  );
  assert.match(packNotesAdapter, /mutationGuard: \(\) => !editorMutationBlocked\(\)/,
    'Editor Load Plan Notes delegates its lifecycle guard to the shared overlay');
  assert.ok(notesOverlay.indexOf('await config.mutationGuard()') < notesOverlay.indexOf('await config.saveNote({'),
    'the shared Notes overlay evaluates the mutation guard before invoking the owner write adapter');

  const applyPosition = src.slice(
    src.indexOf("savePos.addEventListener('click'"),
    src.indexOf('transformCard.appendChild(savePos)', src.indexOf("savePos.addEventListener('click'")),
  );
  assert.match(applyPosition, /savePos\.addEventListener\('click', \(\) => \{\s*if \(editorMutationBlocked\(\{ endPreview: true \}\)\) return;/,
    'manual position Apply rejects busy state before scene or pack mutation');
});

test('EDIT-CASE-MODAL-SCROLL-CLIPPING shared .modal shell is height-constrained and scrollable at all widths, not only under the mobile media query', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');

  const modalMatch = css.match(/(?<!-)\.modal\s*\{([^}]*)\}/);
  assert.ok(modalMatch, 'base .modal rule must be locatable');
  const modalRule = modalMatch[1];
  assert.match(modalRule, /max-height:\s*90vh/,
    'base .modal must cap its own height so it never exceeds the viewport, regardless of viewport width');
  assert.match(modalRule, /display:\s*flex/,
    'base .modal must lay out header/body/footer as a flex column so the footer can stay pinned');
  assert.match(modalRule, /flex-direction:\s*column/,
    'base .modal must stack header/body/footer vertically');

  const modalBodyMatch = css.match(/\.modal-body\s*\{([^}]*)\}/);
  assert.ok(modalBodyMatch, '.modal-body rule must be locatable');
  const modalBodyRule = modalBodyMatch[1];
  assert.match(modalBodyRule, /overflow-y:\s*auto/,
    '.modal-body must scroll internally when content is taller than the modal, keeping header/footer visible');
  assert.match(modalBodyRule, /flex:\s*1/,
    '.modal-body must be the flexible (growing/shrinking) region between the fixed header and footer');
  assert.match(modalBodyRule, /min-height:\s*0/,
    '.modal-body must allow shrinking below its content size so overflow-y: auto can take effect inside a flex column');

  const mobileModalBlockMatch = css.match(/\/\* Modal mobile improvements \*\/\s*@media \(max-width: 768px\) \{([\s\S]*?)\n\}/);
  assert.ok(mobileModalBlockMatch, 'the modal mobile-improvements media query must still exist');
  const mobileBlock = mobileModalBlockMatch[1];
  assert.doesNotMatch(mobileBlock, /\.modal\s*\{/,
    'height containment must not be re-declared as a width-gated .modal override — it must live in the base rule');
  assert.doesNotMatch(mobileBlock, /\.modal-body\s*\{/,
    'scrolling must not be re-declared as a width-gated .modal-body override — it must live in the base rule');
});

test('EDIT-CASE-MODAL-SCROLL-CLIPPING mobile modal-footer stacking is unchanged by the height-containment fix', async () => {
  const css = await fs.readFile(stylesMainPath, 'utf8');

  const mobileModalBlockMatch = css.match(/\/\* Modal mobile improvements \*\/\s*@media \(max-width: 768px\) \{([\s\S]*?)\n\}/);
  assert.ok(mobileModalBlockMatch, 'the modal mobile-improvements media query must still exist');
  const mobileBlock = mobileModalBlockMatch[1];

  const footerMatch = mobileBlock.match(/\.modal-footer\s*\{([^}]*)\}/);
  assert.ok(footerMatch, 'mobile .modal-footer override must remain');
  assert.match(footerMatch[1], /flex-direction:\s*column-reverse/,
    'mobile footer buttons must remain stacked column-reverse (primary action on top)');
  assert.match(footerMatch[1], /padding-bottom:\s*calc\(var\(--space-4\) \+ env\(safe-area-inset-bottom\)\)/,
    'mobile footer must keep its safe-area bottom padding');

  const footerBtnMatch = mobileBlock.match(/\.modal-footer \.btn\s*\{([^}]*)\}/);
  assert.ok(footerBtnMatch, 'mobile .modal-footer .btn override must remain');
  assert.match(footerBtnMatch[1], /width:\s*100%/,
    'mobile footer buttons must remain full-width');
});
