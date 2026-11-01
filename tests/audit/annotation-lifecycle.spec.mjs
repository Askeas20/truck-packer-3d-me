/**
 * @file annotation-lifecycle.spec.mjs
 * @description Pins how Annotations V1 data lives inside a Load Plan: the normalizer whitelist, writes that
 *   are Undo/Redo steps in the same chronological history as cargo edits and restore their exact
 *   `lastEdited`, derived validity when cargo, Cases or the truck change, duplicate and import instance-ID
 *   remapping, and export/backup projection plus strict restore validation. The pure model and layout are
 *   pinned in annotation-core.spec.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// import-export.js reads the browser storage globals while it loads (as in measurement-tool-lifecycle.spec.mjs).
const memoryStorage = new Map();
globalThis.window ??= {
  localStorage: {
    getItem: key => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
    setItem: (key, value) => memoryStorage.set(key, String(value)),
    removeItem: key => memoryStorage.delete(key),
    key: index => Array.from(memoryStorage.keys())[index] || null,
    get length() { return memoryStorage.size; },
  },
  setTimeout, clearTimeout,
};
import * as StateStore from '../../src/core/state-store.js';
import * as PackLibrary from '../../src/services/pack-library.js';
import * as ImportExport from '../../src/services/import-export.js';
import * as M from '../../src/core/measurements.js';
import * as A from '../../src/core/annotations.js';
import { normalizeAppData, normalizePack } from '../../src/core/normalizer.js';
import { projectPortablePack, projectPortableWorkspacePack, validateWorkspaceGraph } from '../../src/core/import-schema.js';
import * as CoreStorage from '../../src/core/storage.js';

const CASE = {
  id: 'case-1', name: 'Crate', itemCode: 'C-1', manufacturer: 'Test', category: 'audio',
  dimensions: { length: 48, width: 24, height: 32 }, weight: 50, shape: 'box',
  stackable: true, maxStackCount: 2, orientationLock: 'upright', color: '#111111',
};
const caseMap = new Map([[CASE.id, CASE]]);
const makePack = (id, extra = {}) => ({
  id, title: id, loadPlanNumber: `LP-${id}`, truck: { length: 240, width: 96, height: 100 },
  cases: [], groups: [], stats: { totalCases: 0 }, lastEdited: 123,
  editorView: null, thumbnail: null, thumbnailVisualSignature: null, thumbnailViewSignature: null,
  ...extra,
});
const solidInstance = id => ({
  id, caseId: CASE.id, placement: 'packed', hidden: false, groupId: null,
  transform: { position: { x: 60, y: 16, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});
const seed = (packs = [makePack('A'), makePack('B')]) => StateStore.init({
  currentScreen: 'editor', currentPackId: packs[0].id, caseLibrary: [CASE],
  folderLibrary: [], preferences: {}, packLibrary: packs,
});
const ground = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
const onCargo = (instanceId, local = { x: 24, y: 2, z: 3 }) => M.buildCargoAnchor({ instanceId, local, caseData: CASE });
const note = (title = 'Fragile', anchor = ground(0, 60), extra = {}) => ({ anchor, title, ...extra });
const callout = (id, anchor = ground(0, 60), extra = {}) => A.createCalloutRecord({ id, anchor, title: 'Fragile', now: 1, ...extra });
const stored = id => PackLibrary.getById(id);
const statuses = id => PackLibrary.resolveAnnotations(id).map(r => `${r.status}${r.reason ? `:${r.reason}` : ''}`);
const snapshotOf = () => JSON.stringify([StateStore.get('packLibrary'), StateStore.get('caseLibrary')]);
const emptyDestination = () => StateStore.init({
  currentScreen: 'packs', currentPackId: null, caseLibrary: [CASE], folderLibrary: [], preferences: {}, packLibrary: [],
});
// A strictly increasing clock: every write gets its own, later `lastEdited`, so each step's exact time can be asserted.
const tickingClock = t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => (now += 10));
};

// ============================================================================
// SECTION: NORMALIZATION (G1) AND RECOVERY
// ============================================================================

// The one step that the last committed write made: Undo reverts exactly that write, and Redo restores exactly its result.
function oneStepRoundTrip(label) {
  const after = JSON.stringify(StateStore.get('packLibrary'));
  assert.equal(StateStore.undo(), true, `${label}: one Undo step`);
  assert.notEqual(JSON.stringify(StateStore.get('packLibrary')), after, `${label}: Undo reverts it`);
  assert.equal(StateStore.redo(), true, `${label}: Redo replays it`);
  assert.equal(JSON.stringify(StateStore.get('packLibrary')), after, `${label}: Redo restores the result`);
}

test('normalizePack whitelists annotations: legacy plans get [], valid ones persist, malformed ones are kept as recovery records', () => {
  assert.deepEqual(normalizePack(makePack('A')).annotations, [], 'a plan saved before the feature has none');
  const good = callout('g');
  assert.deepEqual(normalizePack(makePack('A', { annotations: [good] })).annotations, A.normalizeAnnotations([good]));
  const malformed = { id: 'bad', type: 'callout', anchor: { kind: 'mystery' } };
  const kept = normalizePack(makePack('A', { annotations: [good, malformed] })).annotations;
  assert.equal(kept.length, 2, 'nothing is dropped');
  assert.equal(kept[1].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(kept[1].original, malformed, 'the original record is preserved verbatim for recovery');
  assert.deepEqual(normalizePack(makePack('A', { annotations: 'oops' })).annotations[0].original, 'oops');
  assert.deepEqual(normalizePack(makePack('A', { measurements: [{ id: 'x' }] })).annotations, [], 'measurements and annotations are separate collections');
});

test('a write keeps unreadable originals verbatim and an unrelated edit never touches stored annotations', () => {
  const rawBad = [{ id: 'bad-1', type: 'callout', title: '' }, 'garbage', { id: 'arrow-1', type: 'arrow', schemaVersion: 1 }];
  seed([makePack('A', { annotations: rawBad })]);
  assert.deepEqual(stored('A').annotations, rawBad, 'hydration keeps the raw stored value');
  PackLibrary.update('A', { notes: 'unrelated edit' });
  assert.deepEqual(stored('A').annotations, rawBad, 'an unrelated autosaved edit leaves malformed data verbatim');
  const added = PackLibrary.addCallout('A', note());
  assert.equal(added.ok, true);
  const unreadable = stored('A').annotations.filter(r => r.type === A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(unreadable.map(r => r.original), rawBad, 'writing a callout wraps, never discards, what could not be read');
  assert.deepEqual(PackLibrary.resolveAnnotations('A').filter(r => r.reason === 'unreadable').length, 3);
  assert.equal(PackLibrary.updateCallout('A', unreadable[0].id, { title: 'x' }).reason, 'not-found', 'an unreadable record cannot be edited as a callout');
  assert.equal(PackLibrary.deleteAnnotation('A', added.annotation.id).ok, true);
  assert.equal(stored('A').annotations.length, 3, 'only the deliberately deleted record is gone');
  assert.equal(PackLibrary.deleteAnnotation('A', unreadable[1].id).ok, true, 'an unreadable record can be deleted deliberately');
  assert.equal(stored('A').annotations.length, 2);
});

// ============================================================================
// SECTION: WRITES (G2) — annotation-only edits
// ============================================================================

test('create, edit, move, hide and delete are undoable steps: lastEdited moves, and each step reverts exactly once', () => {
  seed();
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => {
    if (notification) notifications.push(notification.type);
  });
  try {
    const before = stored('A');
    const cargoBefore = JSON.stringify(before.cases);
    const added = PackLibrary.addCallout('A', note('  Unload   first ', ground(10, 10), { description: 'Rear doors', color: 'blue', keepExpanded: true }));
    assert.equal(added.ok, true);
    assert.equal(notifications.at(-1), 'pack-annotations', 'derived notification: the app refreshes only the overlay and list');
    assert.ok(stored('A').lastEdited > before.lastEdited, 'creating a callout updates lastEdited');
    oneStepRoundTrip('the write');
    assert.equal(stored('B').annotations, undefined, 'another Load Plan is untouched');
    assert.equal(JSON.stringify(stored('A').cases), cargoBefore, 'cargo is untouched');
    const [record] = PackLibrary.getAnnotations('A');
    assert.deepEqual([record.title, record.description, record.color, record.keepExpanded, record.hidden, record.offset], ['Unload first', 'Rear doors', 'blue', true, false, null]);

    const id = added.annotation.id;
    const edited = PackLibrary.updateCallout('A', id, { title: 'Unload last', description: '', color: 'red' });
    assert.equal(edited.ok, true);
    assert.deepEqual([PackLibrary.getAnnotations('A')[0].title, PackLibrary.getAnnotations('A')[0].description], ['Unload last', null]);
    const lastEdited = stored('A').lastEdited;
    const same = PackLibrary.updateCallout('A', id, { title: 'Unload last' });
    assert.equal(same.unchanged, true, 'an unchanged edit writes nothing');
    assert.equal(stored('A').lastEdited, lastEdited);
    assert.equal(PackLibrary.updateCallout('A', id, { title: '   ' }).reason, 'invalid', 'an empty title is refused');
    assert.equal(PackLibrary.updateCallout('A', 'nope', { title: 'x' }).reason, 'not-found');
    assert.equal(PackLibrary.updateCallout('missing', id, { title: 'x' }).reason, 'pack-not-found');

    assert.equal(PackLibrary.setCalloutOffset('A', id, { dx: 44.44, dy: -30 }).ok, true);
    assert.deepEqual(PackLibrary.getAnnotations('A')[0].offset, { dx: 44.4, dy: -30 });
    assert.deepEqual(PackLibrary.getAnnotations('A')[0].anchor, added.annotation.anchor, 'moving a card never moves the anchor');
    assert.equal(PackLibrary.setCalloutOffset('A', id, { dx: 99999, dy: 0 }).reason, 'invalid');
    assert.deepEqual(PackLibrary.getAnnotations('A')[0].offset, { dx: 44.4, dy: -30 }, 'a refused offset changes nothing');
    assert.equal(PackLibrary.setCalloutOffset('A', id, null).ok, true);
    assert.equal(PackLibrary.getAnnotations('A')[0].offset, null);

    assert.equal(PackLibrary.updateCallout('A', id, { hidden: true }).ok, true);
    assert.equal(PackLibrary.getAnnotations('A')[0].hidden, true, 'visibility is preserved with the Load Plan');

    const cargoAnchor = onCargo('inst-x');
    assert.equal(PackLibrary.reattachCallout('A', id, cargoAnchor).ok, true);
    const moved = PackLibrary.getAnnotations('A')[0];
    assert.equal(moved.anchor.kind, 'cargo', 'the anchor kind may change when the owner moves the marker');
    assert.equal(moved.createdAt, added.annotation.createdAt);
    assert.equal(moved.title, 'Unload last');
    assert.equal(PackLibrary.reattachCallout('A', id, { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } }).reason, 'invalid');
    assert.equal(PackLibrary.reattachCallout('A', id, { ...cargoAnchor, local: { x: 0, y: 0, z: 0 } }).reason, 'invalid', 'a point off the cargo surface is refused');
    assert.equal(PackLibrary.getAnnotations('A')[0].anchor.kind, 'cargo', 'refused moves change nothing');
    oneStepRoundTrip('the last edit');

    assert.equal(PackLibrary.deleteAnnotation('A', 'nope').reason, 'not-found');
    assert.equal(PackLibrary.deleteAnnotation('A', id).ok, true);
    assert.equal(PackLibrary.getAnnotations('A').length, 0);
    assert.equal(JSON.stringify(stored('A').cases), cargoBefore);
  } finally { unsubscribe(); }
});

test('the per-plan maximum of 200 is enforced on creation and a malformed callout is refused', () => {
  seed();
  for (let i = 0; i < 200; i++) assert.equal(PackLibrary.addCallout('A', note(`N${i}`, ground(i, 1))).ok, true);
  assert.equal(PackLibrary.getAnnotations('A').length, 200);
  const over = PackLibrary.addCallout('A', note('one too many'));
  assert.deepEqual([over.ok, over.reason], [false, 'limit']);
  assert.equal(PackLibrary.getAnnotations('A').length, 200, 'nothing is truncated or replaced');
  assert.equal(PackLibrary.addCallout('B', { anchor: null, title: 'x' }).reason, 'invalid');
  assert.equal(PackLibrary.addCallout('B', note('   ')).reason, 'invalid', 'a callout needs a title');
  assert.equal(PackLibrary.addCallout('missing', note()).reason, 'pack-not-found');
  assert.equal(PackLibrary.restoreAnnotation('A', callout('late'), 0).reason, 'limit');
});

test('cargo and callout edits undo and redo in order, each restoring its exact lastEdited', t => {
  tickingClock(t);
  seed();
  PackLibrary.addCallout('A', note('First'));
  const afterFirst = stored('A').lastEdited;
  StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'A' ? { ...p, notes: 'cargo edit' } : p)) });
  const second = PackLibrary.addCallout('A', note('Second', ground(5, 5)));
  assert.equal(second.ok, true);
  const afterSecond = stored('A').lastEdited;
  PackLibrary.setCalloutOffset('A', second.annotation.id, { dx: 20, dy: 20 });
  const afterMove = stored('A').lastEdited;
  assert.ok(123 < afterFirst && afterFirst < afterSecond && afterSecond < afterMove, 'each callout edit has its own, later time');
  // Newest first: the card move, then the second callout, then the cargo edit.
  assert.equal(StateStore.undo(), true, 'the card move is undone first');
  assert.equal(PackLibrary.getAnnotations('A')[1].offset, null, 'the card is back where it was');
  assert.equal(stored('A').lastEdited, afterSecond, 'with the time the Pack had before the move');
  assert.equal(StateStore.undo(), true, 'then the second callout');
  assert.equal(PackLibrary.getAnnotations('A').length, 1);
  assert.equal(stored('A').lastEdited, afterFirst, 'with the time the Pack had before the second callout');
  assert.equal(StateStore.undo(), true, 'then the cargo edit');
  assert.equal(stored('A').notes, undefined);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'the earlier callout is kept');
  assert.equal(stored('A').lastEdited, afterFirst, 'the cargo edit never touched lastEdited');
  assert.equal(StateStore.redo(), true);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').lastEdited, afterSecond);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').notes, 'cargo edit');
  assert.equal(PackLibrary.getAnnotations('A').length, 2);
  assert.deepEqual(PackLibrary.getAnnotations('A')[1].offset, { dx: 20, dy: 20 }, 'the latest card position is restored');
  assert.equal(stored('A').lastEdited, afterMove, 'Redo restores the time of the move');
});

test('measurements and annotations are independent collections: neither edit touches the other', () => {
  seed();
  const measured = PackLibrary.addMeasurement('A', { start: ground(0, 60), end: ground(40, 60) });
  const noted = PackLibrary.addCallout('A', note('Beside the ruler'));
  assert.equal(measured.ok && noted.ok, true);
  assert.equal(PackLibrary.deleteMeasurement('A', measured.measurement.id).ok, true);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'deleting a measurement keeps the callout');
  PackLibrary.addMeasurement('A', { start: ground(1, 1), end: ground(9, 9) });
  assert.equal(PackLibrary.deleteAnnotation('A', noted.annotation.id).ok, true);
  assert.equal(PackLibrary.getMeasurements('A').length, 1, 'deleting a callout keeps the measurement');
});

test('deleting a callout can be put back once, with the same ID and position, and only while that is still right', () => {
  seed();
  const [one, two, three] = ['One', 'Two', 'Three'].map((title, i) => PackLibrary.addCallout('A', note(title, ground(i, 1))).annotation);
  const removed = PackLibrary.deleteAnnotation('A', two.id);
  assert.deepEqual([removed.ok, removed.index, removed.removed.id], [true, 1, two.id]);
  assert.deepEqual(PackLibrary.getAnnotations('A').map(r => r.title), ['One', 'Three']);
  const restored = PackLibrary.restoreAnnotation('A', removed.removed, removed.index);
  assert.equal(restored.ok, true);
  assert.deepEqual(PackLibrary.getAnnotations('A').map(r => r.id), [one.id, two.id, three.id], 'back in its place with its ID');
  assert.equal(PackLibrary.restoreAnnotation('A', removed.removed, 1).reason, 'exists', 'never duplicated');
  assert.equal(PackLibrary.restoreAnnotation('A', { id: 'x', type: 'callout' }, 0).reason, 'invalid');
  assert.equal(PackLibrary.restoreAnnotation('A', callout('tail'), 99).ok, true, 'an out-of-range position appends');
  assert.equal(PackLibrary.getAnnotations('A').at(-1).id, 'tail');
  oneStepRoundTrip('putting it back');
});

// ============================================================================
// SECTION: DERIVED VALIDITY FOLLOWS THE LOAD PLAN
// ============================================================================

test('deleting cargo leaves its callout stored as Unresolved and undoing the delete resolves it again', () => {
  seed();
  const inst = PackLibrary.addInstance('A', CASE.id, { x: 60, y: 16, z: 0 });
  assert.ok(inst && inst.id, 'a real instance is placed');
  PackLibrary.addCallout('A', note('On the crate', onCargo(inst.id, { x: 0, y: 16, z: 0 })));
  assert.deepEqual(statuses('A'), ['valid']);
  PackLibrary.removeInstances('A', [inst.id]);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'editing cargo never deletes an annotation');
  const gone = PackLibrary.resolveAnnotations('A')[0];
  assert.deepEqual([gone.status, gone.reason, gone.point], ['unresolved', 'cargo-missing', null], 'no fabricated position');
  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('A').cases.some(c => c.id === inst.id), true, 'Undo restores the same instance ID');
  assert.deepEqual(statuses('A'), ['valid'], 'the anchor resolves again; nothing was relocated');
});

test('cargo movement, rotation and staging carry the callout with the cargo and never edit the annotation', () => {
  seed();
  const inst = PackLibrary.addInstance('A', CASE.id, { x: 60, y: 16, z: 0 });
  PackLibrary.addCallout('A', note('Follows', onCargo(inst.id, { x: 24, y: 2, z: 3 })));
  const record = JSON.stringify(PackLibrary.getAnnotations('A'));
  const point = () => PackLibrary.resolveAnnotations('A')[0].point;
  const start = point();
  const pose = (position, rotation = { x: 0, y: 0, z: 0 }) => ({ transform: { position, rotation, scale: { x: 1, y: 1, z: 1 } } });
  assert.ok(PackLibrary.updateInstance('A', inst.id, pose({ x: 100, y: 16, z: 10 })));
  assert.deepEqual([point().x - start.x, point().z - start.z], [40, 10], 'moving the cargo moves the point with it');
  assert.ok(PackLibrary.updateInstance('A', inst.id, pose({ x: 100, y: 16, z: 10 }, { x: 0, y: Math.PI / 2, z: 0 })));
  assert.notDeepEqual(point(), { x: start.x + 40, y: start.y, z: start.z + 10 }, 'rotating the cargo rotates the point about it');
  assert.ok(PackLibrary.updateInstance('A', inst.id, { ...pose({ x: 500, y: 16, z: 200 }), placement: 'staged' }));
  assert.equal(PackLibrary.resolveAnnotations('A')[0].status, 'valid', 'a staged case keeps its callout');
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), record, 'the stored annotation never changed');
});

test('a Case size or shape change asks for review, restoring it recovers, and nothing is rewritten or relocated', () => {
  seed();
  const inst = PackLibrary.addInstance('A', CASE.id, { x: 60, y: 16, z: 0 });
  PackLibrary.addCallout('A', note('Sized', onCargo(inst.id)));
  const record = JSON.stringify(PackLibrary.getAnnotations('A'));
  const setCase = patch => StateStore.set({ caseLibrary: [{ ...CASE, ...patch }] }, { skipHistory: true });
  setCase({ dimensions: { ...CASE.dimensions, length: 60 } });
  assert.deepEqual(statuses('A'), ['needs-review:case-changed']);
  assert.equal(PackLibrary.resolveAnnotations('A')[0].point, null);
  setCase({ shape: 'cylinder' });
  assert.deepEqual(statuses('A'), ['needs-review:case-changed'], 'a shape change is a change too');
  setCase({});
  assert.deepEqual(statuses('A'), ['valid'], 'restoring the original definition returns it to Valid');
  setCase({ id: 'case-1', dimensions: undefined });
  assert.notEqual(statuses('A')[0], 'valid');
  setCase({});
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), record);
});

test('through the real zone calculation: a Front Overhang change flags a wall callout, restoring it makes it Valid again', () => {
  const truck = { length: 600, width: 100, height: 90, shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 30 } };
  seed([makePack('F', { truck })]);
  const withConfig = shapeConfig => StateStore.set({
    packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'F' ? { ...p, truck: { ...p.truck, shapeConfig } } : p)),
  }, { skipHistory: true });
  const zones = PackLibrary.getMeasurementZones(stored('F'));
  const front = M.buildSpaceAnchor({ surface: 'wall-front', point: { x: 700, y: 60, z: 0 }, truck: stored('F').truck, zones });
  assert.ok(front, 'the front wall of the Front Overhang truck stands at x = 700');
  assert.equal(PackLibrary.addCallout('F', note('Cab wall', front)).ok, true);
  assert.deepEqual(statuses('F'), ['valid']);
  withConfig({ bonusLength: 150, bonusHeight: 30 });
  assert.deepEqual(statuses('F'), ['needs-review:truck-changed'], 'the wall moved: the callout is flagged, not relocated');
  assert.deepEqual(PackLibrary.getAnnotations('F')[0].anchor, front);
  withConfig({ bonusLength: 100, bonusHeight: 30 });
  assert.deepEqual(statuses('F'), ['valid']);
  // Ground and open-space callouts never depend on the truck.
  PackLibrary.addCallout('F', note('Yard', ground(900, 0)));
  withConfig({ bonusLength: 150, bonusHeight: 30 });
  assert.deepEqual(statuses('F'), ['needs-review:truck-changed', 'valid']);
});

// ============================================================================
// SECTION: DUPLICATE AND IMPORT (G3)
// ============================================================================

test('duplicating a Load Plan re-targets cargo anchors to the copy and leaves the original alone', () => {
  seed();
  const inst = PackLibrary.addInstance('A', CASE.id, { x: 60, y: 16, z: 0 });
  const cargo = onCargo(inst.id, { x: 3, y: 16, z: 1 });
  const floor = M.buildFloorAnchor({ surface: 'main', point: { x: 120, y: 0, z: 0 } });
  PackLibrary.addCallout('A', note('On cargo', cargo, { offset: { dx: 30, dy: -20 }, keepExpanded: true }));
  PackLibrary.addCallout('A', note('On floor', floor));
  PackLibrary.addCallout('A', note('Yard', ground(3, 3)));
  const original = JSON.stringify(PackLibrary.getAnnotations('A'));
  const copy = PackLibrary.duplicate('A');
  const copyIds = new Set(copy.cases.map(c => c.id));
  assert.equal(copyIds.has(inst.id), false, 'the copy has its own instance IDs');
  const [first, second, third] = PackLibrary.getAnnotations(copy.id);
  assert.equal(copyIds.has(first.anchor.instanceId), true, 'the cargo anchor follows its cargo into the copy');
  assert.deepEqual(first.anchor.local, cargo.local);
  assert.deepEqual([first.offset, first.keepExpanded], [{ dx: 30, dy: -20 }, true], 'presentation travels with it');
  assert.deepEqual(second.anchor, floor);
  assert.deepEqual(third.anchor, ground(3, 3));
  assert.deepEqual(statuses(copy.id), ['valid', 'valid', 'valid']);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), original, 'the original plan keeps its anchors');
});

const importPayload = (annotations, cases = []) => ({
  pack: { id: 'incoming', title: 'Incoming', loadPlanNumber: 'LP-IMPORT', truck: { length: 240, width: 96, height: 100 }, cases, annotations },
  bundledCases: [],
});

test('importing a Load Plan remaps cargo anchors through the regenerated instance IDs', () => {
  seed([makePack('A')]);
  const list = [
    callout('c1', onCargo('old-1', { x: 1, y: 16, z: 2 })),
    callout('c2', onCargo('never-existed', { x: 0, y: 16, z: 0 })),
    callout('c3', ground(9, 9)),
  ];
  const plan = PackLibrary.planPackImport(importPayload(list, [solidInstance('old-1')]));
  const newId = plan.pack.cases[0].id;
  assert.notEqual(newId, 'old-1', 'imports regenerate instance IDs');
  assert.equal(plan.pack.annotations[0].anchor.instanceId, newId, 'the anchor is re-targeted through the same old-to-new map');
  assert.deepEqual(plan.pack.annotations[0].anchor.local, list[0].anchor.local);
  assert.equal(plan.pack.annotations[1].anchor.instanceId, 'never-existed', 'a valid reference to missing cargo is retained, never guessed');
  assert.deepEqual(plan.pack.annotations[2].anchor, list[2].anchor);
  assert.deepEqual(PackLibrary.planPackImport(importPayload(undefined)).pack.annotations, [], 'a file without annotations imports none');
});

test('a malformed, duplicated or over-limit annotation list rejects the whole Load Plan import', () => {
  seed([makePack('A')]);
  const valid = callout('ok');
  assert.doesNotThrow(() => PackLibrary.planPackImport(importPayload([valid])));
  const blocked = /Pack import blocked: the annotations are not valid/;
  assert.throws(() => PackLibrary.planPackImport(importPayload([{ ...valid, anchor: { kind: 'cargo' } }])), blocked);
  assert.throws(() => PackLibrary.planPackImport(importPayload([{ ...valid, title: '' }])), blocked);
  assert.throws(() => PackLibrary.planPackImport(importPayload([valid, valid])), /duplicate/);
  assert.throws(() => PackLibrary.planPackImport(importPayload('not a list')), blocked);
  const many = Array.from({ length: 201 }, (_, i) => callout(`c${i}`, ground(i, 1)));
  assert.throws(() => PackLibrary.planPackImport(importPayload(many)), /too many/);
  assert.equal(PackLibrary.planPackImport(importPayload(many.slice(0, 200))).pack.annotations.length, 200, 'exactly 200 is fine; nothing is truncated');
});

// ============================================================================
// SECTION: EXPORT, BACKUP AND RESTORE (G4)
// ============================================================================

test('export and backup project annotations explicitly and restore validation is strict', () => {
  const list = [
    callout('a', ground(0, 60), { title: 'Kept', description: 'Rear doors', color: 'green' }),
    callout('b', onCargo('gone'), { offset: { dx: 10, dy: 10 } }),
  ];
  const withList = makePack('A', { annotations: list });
  for (const project of [projectPortablePack, projectPortableWorkspacePack]) {
    assert.deepEqual(project(withList).annotations, A.normalizeAnnotations(list), `${project.name} carries annotations`);
    assert.equal(Object.hasOwn(project(makePack('A')), 'annotations'), false, 'a plan without any exports no empty field');
    assert.equal(project(makePack('A', { annotations: [{ id: 'x' }] })).annotations[0].type, A.ANNOTATION_TYPE_UNREADABLE,
      'an unreadable record is exported, not dropped');
  }
  const graph = packs => ({ caseLibrary: [], packLibrary: packs, folderLibrary: [] });
  assert.doesNotThrow(() => validateWorkspaceGraph(graph([withList])), 'a dangling cargo reference is accepted (Unresolved)');
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { annotations: [{ ...list[0], anchor: { kind: 'x' } }] })])), /annotations/);
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { annotations: [list[0], list[0]] })])), /duplicate/);
  const many = Array.from({ length: 201 }, (_, i) => callout(`m${i}`, ground(i, 1)));
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { annotations: many })])), /too many/);
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { annotations: 'nope' })])), /annotations/);
});

test('export self-preflight applies the importer\'s annotation rules to the exact artifact', () => {
  const many = Array.from({ length: 201 }, (_, i) => callout(`m${i}`, ground(i, 1)));
  const fine = [callout('a', ground(0, 60), { title: 'Kept' }), callout('b', onCargo('gone'))];
  const unreadable = { id: 'x', type: 'callout', anchor: { kind: 'mystery' } };
  seed([
    makePack('OVER', { cases: [solidInstance('o1')], annotations: many }),
    makePack('FINE', { cases: [solidInstance('f1')], annotations: fine }),
    makePack('ODD', { cases: [solidInstance('d1')], annotations: [unreadable] }),
  ]);
  const over = PackLibrary.getById('OVER');
  const overBefore = JSON.stringify(over);
  const refused = error => error.code === 'EXPORT_PREFLIGHT_FAILED' && /annotations are not valid \(too many annotations \(201; maximum 200\)\)/.test(error.message);
  assert.throws(() => ImportExport.buildRestorablePackExportJSON(over), refused, 'single export refuses an over-cap collection');
  assert.throws(() => ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('FINE'), over]), refused, 'batch export refuses it too');
  assert.equal(JSON.stringify(PackLibrary.getById('OVER')), overBefore, 'nothing is truncated, repaired or rewritten in the saved plan');

  const json = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('FINE'));
  const tampered = JSON.parse(json);
  tampered.data.pack.annotations = [{ ...fine[0], anchor: { kind: 'cargo' } }];
  assert.throws(() => ImportExport.assertRestorablePackExportJSON(JSON.stringify(tampered)), /annotations are not valid/);
  tampered.data.pack.annotations = [fine[0], fine[0]];
  assert.throws(() => ImportExport.assertRestorablePackExportJSON(JSON.stringify(tampered)), /duplicate annotation id/);

  assert.doesNotThrow(() => ImportExport.buildRestorablePackExportJSON({ ...PackLibrary.getById('FINE'), annotations: many.slice(0, 200) }));
  const oddJson = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('ODD'));
  const batchJson = ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('FINE'), PackLibrary.getById('ODD')]);
  emptyDestination();
  const roundTrip = payload => PackLibrary.planPackImport(ImportExport.parsePackImportJSON(payload)).pack.annotations;
  assert.deepEqual(roundTrip(json).map(r => r.id), ['a', 'b']);
  assert.deepEqual(roundTrip(json)[0], fine[0], 'a callout round-trips exactly');
  const odd = roundTrip(oddJson);
  assert.equal(odd[0].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(odd[0].original, unreadable, 'a record the app could not read is exported and restored untouched');
  const batch = ImportExport.parsePackBatchImportJSON(batchJson);
  assert.deepEqual(batch.map(entry => entry.pack.annotations.length), [2, 1]);
});

test('Workspace Backup and Active Workspace Backup carry annotations and restore them with their cargo', () => {
  const plan = makePack('S', {
    loadPlanNumber: 'LP-S', cases: [solidInstance(' cargo ')],
    annotations: [callout('a', onCargo(' cargo '), { offset: { dx: 12, dy: -8 }, keepExpanded: true, hidden: true }), callout('b', ground(4, 4))],
  });
  seed([plan]);
  assert.deepEqual(statuses('S'), ['valid', 'valid'], 'control: before backup both spell the same identity');
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const appJson = ImportExport.buildAppExportJSON();
  const check = (cases, annotations, label) => {
    assert.equal(cases[0].id, 'cargo', `${label}: the cargo ID is canonical`);
    assert.equal(annotations[0].anchor.instanceId, 'cargo', `${label}: the anchor followed it`);
    assert.deepEqual([annotations[0].offset, annotations[0].keepExpanded, annotations[0].hidden], [{ dx: 12, dy: -8 }, true, true], `${label}: presentation survives`);
    assert.equal(annotations.length, 2, `${label}: nothing dropped`);
  };
  const imported = ImportExport.parseWorkspaceImportJSON(workspaceJson);
  const restore = ImportExport.planWorkspaceRestore(imported, { currentState: StateStore.snapshot() });
  check(restore.packLibrary[0].cases, restore.packLibrary[0].annotations, 'Workspace Backup');
  StateStore.init({ currentScreen: 'editor', currentPackId: 'S', caseLibrary: restore.caseLibrary, folderLibrary: [], preferences: {}, packLibrary: restore.packLibrary });
  assert.deepEqual(statuses('S'), ['valid', 'valid'], 'and they resolve after the restore');
  const again = normalizeAppData({ caseLibrary: restore.caseLibrary, packLibrary: restore.packLibrary, folderLibrary: [], preferences: {} });
  assert.deepEqual(again.packLibrary[0].annotations, restore.packLibrary[0].annotations, 'restoring restored data changes nothing');

  const app = ImportExport.parseAppImportJSON(appJson);
  check(app.packLibrary[0].cases, app.packLibrary[0].annotations, 'Active Workspace Backup');
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(workspaceJson));
  // Legacy full export projects the same way.
  assert.deepEqual(JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary[0].annotations.map(r => r.id), ['a', 'b']);
  seed([makePack('Z')]);
  assert.equal(Object.hasOwn(JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary[0], 'annotations'), false, 'no annotations, no field');
});

test('custom colors survive save, duplicate, Load Plan import/export, Workspace Backup and restore; a malformed color is never silently replaced', () => {
  seed();
  const added = PackLibrary.addCallout('A', note('Custom', ground(10, 10), { color: '#FFA500' }));
  assert.equal(added.ok, true);
  assert.equal(PackLibrary.getAnnotations('A')[0].color, '#ffa500', 'stored canonical');
  assert.equal(PackLibrary.addCallout('A', note('Bad', ground(11, 11), { color: 'orange' })).reason, 'invalid', 'a malformed color is refused at write');
  assert.equal(PackLibrary.addCallout('A', note('Bad', ground(11, 11), { color: '#12' })).reason, 'invalid');
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'refused writes store nothing');
  assert.equal(PackLibrary.updateCallout('A', added.annotation.id, { color: 'javascript:1' }).reason, 'invalid');
  assert.equal(PackLibrary.getAnnotations('A')[0].color, '#ffa500', 'and the stored color is unchanged');
  assert.equal(PackLibrary.updateCallout('A', added.annotation.id, { color: '#00ff7f' }).ok, true);
  assert.equal(PackLibrary.updateCallout('A', added.annotation.id, { color: 'red' }).ok, true, 'back to a built-in name');
  assert.equal(PackLibrary.updateCallout('A', added.annotation.id, { color: '#00FF7F' }).ok, true);
  assert.equal(PackLibrary.getAnnotations('A')[0].color, '#00ff7f');

  const copy = PackLibrary.duplicate('A');
  assert.equal(PackLibrary.getAnnotations(copy.id)[0].color, '#00ff7f', 'duplicate');

  const exported = JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary.find(p => p.id === 'A').annotations;
  assert.equal(exported[0].color, '#00ff7f', 'export');
  assert.equal(PackLibrary.planPackImport(importPayload(exported)).pack.annotations[0].color, '#00ff7f', 'Load Plan import');
  const blocked = /Pack import blocked: the annotations are not valid/;
  for (const color of ['#00ff7', 'teal', '#00ff7fff', 'url(x)']) {
    assert.throws(() => PackLibrary.planPackImport(importPayload([{ ...exported[0], color }])), blocked, `import refuses ${color}`);
  }

  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const restore = ImportExport.planWorkspaceRestore(ImportExport.parseWorkspaceImportJSON(workspaceJson), { currentState: StateStore.snapshot() });
  assert.deepEqual(restore.packLibrary.find(p => p.id === 'A').annotations.map(r => r.color), ['#00ff7f'], 'Workspace Backup and restore');
  const tampered = JSON.parse(workspaceJson);
  tampered.data.packLibrary.find(p => p.id === 'A').annotations[0].color = 'not-a-color';
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(JSON.stringify(tampered)), /color|annotation/i, 'restore validation is strict');

  // A stored record with a malformed color is preserved verbatim for recovery, not defaulted to Ink.
  const stored = { ...exported[0], color: 'not-a-color' };
  const kept = normalizePack(makePack('R', { annotations: [stored] })).annotations;
  assert.equal(kept[0].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(kept[0].original, stored);
});

test('the generic Pack update cannot write annotations: invalid, over-cap or any other patch leaves state, lastEdited, notifications and history alone', () => {
  seed();
  PackLibrary.addCallout('A', note('Keep', ground(10, 10)));
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => { if (notification) notifications.push(notification.type); });
  try {
    const before = JSON.stringify(stored('A'));
    const edited = stored('A').lastEdited;
    const stateBefore = JSON.stringify(StateStore.snapshot().packLibrary);
    const valid = n => Array.from({ length: n }, (_, i) => callout(`g${i}`, ground(i, 1)));
    assert.equal(PackLibrary.update('A', { annotations: valid(201) }), null, 'over the cap');
    assert.equal(PackLibrary.update('A', { annotations: [callout('bad', ground(1, 1), { color: 'url(x)' })] }), null, 'an invalid color');
    assert.equal(PackLibrary.update('A', { annotations: [] }), null, 'even an empty list: the dedicated writers own deletion');
    assert.equal(PackLibrary.update('A', { annotations: valid(2), title: 'Sneaky' }), null, 'a mixed patch is refused as a whole');
    assert.equal(JSON.stringify(stored('A')), before, 'the Pack is untouched');
    assert.equal(stored('A').lastEdited, edited);
    assert.equal(JSON.stringify(StateStore.snapshot().packLibrary), stateBefore);
    assert.deepEqual(notifications, [], 'no notification');
    assert.equal(StateStore.undo(), true, 'the only step is the Keep callout creation');
    assert.equal(PackLibrary.getAnnotations('A').length, 0, 'the refused writes added no step above it');
    assert.equal(StateStore.redo(), true);
    assert.equal(PackLibrary.getAnnotations('A').length, 1);
    // Legacy updates and whole-Pack patches that merely repeat the stored annotations still work.
    assert.ok(PackLibrary.update('A', { title: 'Renamed' }), 'an ordinary update');
    assert.equal(stored('A').title, 'Renamed');
    assert.deepEqual(PackLibrary.getAnnotations('A').map(r => r.title), ['Keep'], 'annotations survive');
    assert.ok(PackLibrary.update('A', { ...stored('A'), title: 'Whole-Pack patch' }), 'a whole-Pack patch repeating the same annotations');
    assert.equal(stored('A').title, 'Whole-Pack patch');
    assert.equal(PackLibrary.getAnnotations('A').length, 1);
  } finally {
    unsubscribe();
  }
});

// ============================================================================
// SECTION: CARGO IDENTITY SURVIVES NORMALIZATION
// ============================================================================

test('normalization canonicalizes a cargo ID, carries its annotation with it and is idempotent', () => {
  const raw = makePack('S', {
    loadPlanNumber: 'LP-S', cases: [solidInstance(' cargo ')],
    annotations: [callout('a', onCargo(' cargo '))],
  });
  const normalized = normalizePack(raw, caseMap, 1);
  assert.equal(normalized.cases[0].id, 'cargo');
  assert.equal(normalized.annotations[0].anchor.instanceId, 'cargo', 'the anchor follows it through an explicit map');
  assert.deepEqual(normalized.annotations[0].anchor.local, raw.annotations[0].anchor.local);
  assert.equal(raw.annotations[0].anchor.instanceId, ' cargo ', 'the raw input was not mutated');
  const twice = normalizePack(normalized, caseMap, 1);
  const thrice = normalizePack(twice, caseMap, 1);
  assert.deepEqual(twice, normalized);
  assert.deepEqual(thrice, normalized);
  assert.equal(thrice.annotations, twice.annotations, 'an unchanged list is returned as is, not rebuilt');
  seed([normalized]);
  assert.deepEqual(statuses('S'), ['valid']);
});

test('an annotation on cargo whose ID another item shares is never resolved onto an arbitrary item', () => {
  const noCase = id => ({ ...solidInstance(id), caseId: '' }); // normalization discards an instance with no Case reference
  const raw = makePack('X', { loadPlanNumber: 'LP-X', cases: [solidInstance('cargo'), noCase(' cargo ')], annotations: [callout('a', onCargo(' cargo '))] });
  // The stored plan as written is ambiguous: Unresolved, nothing rewritten.
  seed([{ ...raw, cases: raw.cases.map(c => ({ ...c, caseId: CASE.id })) }]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous']);
  // Normalization must not let the survivor inherit the reference.
  const normalized = normalizePack(raw, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['cargo']);
  assert.equal(normalized.annotations[0].type, A.ANNOTATION_TYPE_UNREADABLE, 'the annotation is withheld into the recovery record');
  assert.deepEqual(normalized.annotations[0].original, raw.annotations[0], 'verbatim');
  seed([normalized]);
  assert.deepEqual(statuses('X'), ['unresolved:unreadable'], 'never Valid on the surviving cargo');
  assert.deepEqual(normalizePack(normalized, caseMap, 1), normalized);
  // A damaged stored plan is kept as is, and duplicating it never guesses the ambiguous anchor.
  seed([{ ...raw, cases: [solidInstance('dup'), solidInstance('dup'), solidInstance('solo')], annotations: [callout('amb', onCargo('dup')), callout('ok', onCargo('solo'))] }]);
  const copy = PackLibrary.duplicate('X');
  const ids = new Set(copy.cases.map(c => c.id));
  const [ambiguous, clear] = PackLibrary.getAnnotations(copy.id);
  assert.equal(ambiguous.anchor.instanceId, 'dup', 'the ambiguous anchor is left exactly as it was');
  assert.equal(ids.has(clear.anchor.instanceId), true, 'the unambiguous anchor follows its cargo');
  assert.deepEqual(statuses(copy.id), ['unresolved:cargo-ambiguous', 'valid'].map(s => (s === 'unresolved:cargo-ambiguous' ? 'unresolved:cargo-missing' : s)),
    'in the copy the ambiguous anchor names no cargo at all');
});

// ============================================================================
// SECTION: ARROWS (V1B.1) — writers, derived validity, duplicate, import, backup, identity
// ============================================================================

const floorAnchor = (x = 120) => M.buildFloorAnchor({ surface: 'main', point: { x, y: 0, z: 0 } });
const arrowRecord = (id, start = ground(0, 60), end = ground(40, 60), extra = {}) => A.createArrowRecord({ id, start, end, now: 1, ...extra });
const top = instanceId => onCargo(instanceId, { x: 0, y: 16, z: 0 });
const solidAt = (id, x) => ({ ...solidInstance(id), transform: { ...solidInstance(id).transform, position: { x, y: 16, z: 0 } } });
const twoCrates = packId => ['first', 'second'].map((_, i) => PackLibrary.addInstance(packId, CASE.id, { x: 60 + i * 100, y: 16, z: 0 }));
const wrapperOf = (id, original, reason = 'Saved by a newer version of the app.') => ({ id, type: 'unreadable', schemaVersion: 1, reason, original });
const setLastEdited = (packId, value) => StateStore.set({
  packLibrary: StateStore.get('packLibrary').map(p => (p.id === packId ? { ...p, lastEdited: value } : p)),
}, { skipHistory: true });

test('arrow writers are undoable steps: lastEdited moves, and each step reverts exactly once, cargo and callouts stay untouched', () => {
  seed();
  const [a, b] = twoCrates('A');
  const callout1 = PackLibrary.addCallout('A', note('Beside', ground(3, 3))).annotation;
  StateStore.resetHistory();
  setLastEdited('A', 123);
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => { if (notification) notifications.push(notification.type); });
  try {
    const cargoBefore = JSON.stringify(stored('A').cases);
    const calloutBefore = JSON.stringify(PackLibrary.getAnnotations('A')[0]);
    const added = PackLibrary.addArrow('A', { start: top(a.id), end: top(b.id), color: '#FFA500', width: 'bold' });
    assert.equal(added.ok, true);
    assert.deepEqual([added.annotation.type, added.annotation.color, added.annotation.width, added.annotation.hidden], ['arrow', '#ffa500', 'bold', false]);
    assert.equal(notifications.at(-1), 'pack-annotations', 'the derived notification: only the overlay and list refresh');
    assert.ok(stored('A').lastEdited > 123, 'creating an arrow updates lastEdited');
    oneStepRoundTrip('the write');
    assert.equal(stored('B').annotations, undefined, 'another Load Plan is untouched');
    const id = added.annotation.id;

    assert.equal(PackLibrary.updateArrow('A', id, { color: 'red', width: 'thin', hidden: true }).ok, true);
    const edited = PackLibrary.getAnnotations('A')[1];
    assert.deepEqual([edited.color, edited.width, edited.hidden], ['red', 'thin', true]);
    assert.deepEqual([edited.start, edited.end, edited.createdAt], [added.annotation.start, added.annotation.end, added.annotation.createdAt]);
    const editedAt = stored('A').lastEdited;
    assert.equal(PackLibrary.updateArrow('A', id, { width: 'thin' }).unchanged, true, 'an unchanged edit writes nothing');
    assert.equal(stored('A').lastEdited, editedAt);
    assert.equal(PackLibrary.updateArrow('A', id, { width: 'huge' }).reason, 'invalid');
    assert.equal(PackLibrary.updateArrow('A', id, { color: 'javascript:1' }).reason, 'invalid');
    assert.equal(PackLibrary.updateArrow('A', 'nope', { width: 'bold' }).reason, 'not-found');
    assert.equal(PackLibrary.updateArrow('missing', id, { width: 'bold' }).reason, 'pack-not-found');
    assert.equal(PackLibrary.updateArrow('A', callout1.id, { width: 'bold' }).reason, 'not-found', 'a callout is not an arrow');
    assert.equal(PackLibrary.updateCallout('A', id, { title: 'x' }).reason, 'not-found', 'nor an arrow a callout');
    assert.equal(PackLibrary.reattachCallout('A', id, ground(1, 1)).reason, 'not-found');

    const toFloor = floorAnchor(100);
    assert.equal(PackLibrary.moveArrowEndpoint('A', id, 'end', toFloor).ok, true);
    const moved = PackLibrary.getAnnotations('A')[1];
    assert.deepEqual([moved.start, moved.end, moved.createdAt, moved.width], [added.annotation.start, toFloor, added.annotation.createdAt, 'thin'], 'only that end moved');
    assert.equal(PackLibrary.moveArrowEndpoint('A', id, 'end', toFloor).unchanged, true);
    const refused = JSON.stringify(PackLibrary.getAnnotations('A'));
    assert.equal(PackLibrary.moveArrowEndpoint('A', id, 'middle', ground(9, 9)).reason, 'invalid');
    assert.equal(PackLibrary.moveArrowEndpoint('A', id, 'end', { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } }).reason, 'invalid');
    assert.equal(PackLibrary.moveArrowEndpoint('A', id, 'end', { ...top(a.id), local: { x: 0, y: 0, z: 0 } }).reason, 'invalid', 'a point off the cargo surface');
    assert.equal(PackLibrary.moveArrowEndpoint('A', id, 'end', added.annotation.start).reason, 'invalid', 'both ends on the same point');
    assert.equal(PackLibrary.moveArrowEndpoint('A', callout1.id, 'end', ground(9, 9)).reason, 'not-found');
    assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), refused, 'refused moves change nothing');

    const removed = PackLibrary.deleteAnnotation('A', id);
    assert.deepEqual([removed.ok, removed.index, removed.removed.type], [true, 1, 'arrow']);
    assert.equal(PackLibrary.restoreAnnotation('A', removed.removed, removed.index).ok, true, 'the type-agnostic Undo puts an arrow back');
    assert.deepEqual(PackLibrary.getAnnotations('A').map(r => r.id), [callout1.id, id]);
    assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')[0]), calloutBefore, 'the callout is byte-identical');
    assert.equal(JSON.stringify(stored('A').cases), cargoBefore, 'cargo is untouched');
    oneStepRoundTrip('the last arrow edit');
  } finally { unsubscribe(); }
});

test('an arrow is only written against ends that resolve now and sit at least half an inch apart; a refused write changes nothing', () => {
  seed([makePack('A'), makePack('D', { cases: [solidInstance('dup'), solidInstance('dup')] })]);
  const [a, b] = twoCrates('A');
  StateStore.resetHistory();
  const before = snapshotOf();
  const refuse = (input, reason, packId = 'A') => {
    assert.equal(PackLibrary.addArrow(packId, input).reason, reason, JSON.stringify(Object.keys(input)));
    assert.equal(snapshotOf(), before, 'nothing was written');
  };
  refuse({ start: top('gone'), end: top(b.id) }, 'unresolved');
  refuse({ start: top(a.id), end: floorAnchor(1000) }, 'unresolved');
  refuse({ start: onCargo('dup'), end: ground(40, 60) }, 'unresolved', 'D');
  refuse({ start: ground(10, 10), end: ground(10.4, 10) }, 'too-short');
  refuse({ start: ground(10, 10), end: ground(10, 10) }, 'invalid');
  refuse({ start: ground(10, 10), end: ground(40, 10), width: 'huge' }, 'invalid');
  refuse({ start: ground(10, 10), end: ground(40, 10), color: 'url(x)' }, 'invalid');
  refuse({ start: null, end: ground(40, 10) }, 'invalid');
  assert.equal(PackLibrary.addArrow('missing', { start: ground(1, 1), end: ground(9, 9) }).reason, 'pack-not-found');
  StateStore.set({ caseLibrary: [{ ...CASE, dimensions: { ...CASE.dimensions, length: 60 } }] }, { skipHistory: true });
  const resized = snapshotOf();
  assert.equal(PackLibrary.addArrow('A', { start: top(a.id), end: ground(40, 60) }).reason, 'unresolved', 'Needs Review is refused too');
  assert.equal(snapshotOf(), resized);
  StateStore.set({ caseLibrary: [CASE] }, { skipHistory: true });

  assert.equal(PackLibrary.addArrow('A', { start: ground(10, 10), end: ground(10.5, 10) }).ok, true, 'exactly half an inch is long enough');
  for (const [start, end] of [[top(a.id), top(b.id)], [top(a.id), floorAnchor()], [floorAnchor(), ground(2, 2)], [ground(2, 2), top(b.id)]]) {
    assert.equal(PackLibrary.addArrow('A', { start, end }).ok, true, `${start.kind} to ${end.kind}`);
  }

  // Moving an end: the new anchor must resolve; a broken other end only means the length is not checked.
  const arrow = PackLibrary.addArrow('A', { start: top(a.id), end: ground(40, 60) }).annotation;
  assert.equal(PackLibrary.moveArrowEndpoint('A', arrow.id, 'end', top('gone')).reason, 'unresolved');
  assert.equal(PackLibrary.moveArrowEndpoint('A', arrow.id, 'end', M.buildSpaceAnchor({ surface: 'free', point: { x: 60, y: 32.2, z: 0 } })).reason, 'too-short', 'it would end on top of its tail');
  PackLibrary.removeInstances('A', [a.id]);
  assert.equal(PackLibrary.resolveAnnotations('A').at(-1).startReason, 'cargo-missing');
  assert.equal(PackLibrary.moveArrowEndpoint('A', arrow.id, 'end', ground(40, 20)).ok, true, 'the healthy end of a broken arrow can still move');
  assert.equal(PackLibrary.moveArrowEndpoint('A', arrow.id, 'start', onCargo(a.id, { x: 5, y: 16, z: 0 })).reason, 'unresolved', 'but not onto cargo that is gone');
  assert.equal(PackLibrary.moveArrowEndpoint('A', arrow.id, 'start', top(a.id)).unchanged, true, 'naming the very anchor it already has writes nothing');
  assert.equal(PackLibrary.moveArrowEndpoint('A', arrow.id, 'start', ground(3, 3)).ok, true, 'repairing the broken end');
  assert.equal(PackLibrary.resolveAnnotations('A').at(-1).status, 'valid');
});

test('arrows share the per-plan maximum of 200 with callouts and recovery records, and the generic Pack update cannot write them', () => {
  seed([makePack('A', { annotations: [{ id: 'junk' }] }), makePack('B')]);
  for (let i = 0; i < 198; i++) assert.equal(PackLibrary.addCallout('A', note(`N${i}`, ground(i, 1))).ok, true);
  const last = PackLibrary.addArrow('A', { start: ground(0, 60), end: ground(40, 60) });
  assert.equal(last.ok, true);
  assert.equal(PackLibrary.getAnnotations('A').length, 200, '198 callouts + 1 recovery record + 1 arrow');
  const before = JSON.stringify(PackLibrary.getAnnotations('A'));
  assert.equal(PackLibrary.addArrow('A', { start: ground(1, 60), end: ground(41, 60) }).reason, 'limit');
  assert.equal(PackLibrary.addCallout('A', note('over')).reason, 'limit');
  assert.equal(PackLibrary.restoreAnnotation('A', arrowRecord('late'), 0).reason, 'limit');
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), before, 'nothing is truncated or replaced');

  PackLibrary.deleteAnnotation('A', last.annotation.id);
  const written = stored('A');
  assert.equal(PackLibrary.update('A', { annotations: [arrowRecord('sneak')] }), null, 'the generic writer refuses arrows');
  assert.equal(PackLibrary.update('A', { annotations: [] }), null);
  assert.equal(PackLibrary.update('A', { annotations: [arrowRecord('sneak')], title: 'Sneaky' }), null, 'a mixed patch is refused whole');
  assert.equal(stored('A'), written, 'the Pack is untouched');
  PackLibrary.addArrow('B', { start: ground(0, 60), end: ground(40, 60) });
  assert.ok(PackLibrary.update('B', { ...stored('B'), title: 'Whole-Pack patch' }), 'a whole-Pack patch repeating the same annotations still works');
  assert.equal(PackLibrary.getAnnotations('B').length, 1);
});

test('cargo and arrow edits undo and redo in order, each restoring its exact lastEdited', t => {
  tickingClock(t);
  seed();
  PackLibrary.addArrow('A', { start: ground(0, 60), end: ground(40, 60) });
  const afterFirst = stored('A').lastEdited;
  StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'A' ? { ...p, notes: 'cargo edit' } : p)) });
  const second = PackLibrary.addArrow('A', { start: ground(5, 5), end: floorAnchor(50) });
  const afterSecond = stored('A').lastEdited;
  PackLibrary.updateArrow('A', second.annotation.id, { width: 'bold', hidden: true });
  const afterLook = stored('A').lastEdited;
  assert.ok(123 < afterFirst && afterFirst < afterSecond && afterSecond < afterLook, 'each arrow edit has its own, later time');
  // Newest first: the arrow's look, then the second arrow, then the cargo edit.
  assert.equal(StateStore.undo(), true, 'the look edit is undone first');
  assert.notEqual(PackLibrary.getAnnotations('A')[1].width, 'bold');
  assert.equal(stored('A').lastEdited, afterSecond, 'with the time the Pack had before the look edit');
  assert.equal(StateStore.undo(), true, 'then the second arrow');
  assert.equal(PackLibrary.getAnnotations('A').length, 1);
  assert.equal(stored('A').lastEdited, afterFirst, 'with the time the Pack had before the second arrow');
  assert.equal(StateStore.undo(), true, 'then the cargo edit');
  assert.equal(stored('A').notes, undefined);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'the earlier arrow is kept');
  assert.equal(stored('A').lastEdited, afterFirst, 'the cargo edit never touched lastEdited');
  assert.equal(StateStore.redo(), true);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').lastEdited, afterSecond);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').notes, 'cargo edit');
  assert.equal(PackLibrary.getAnnotations('A').length, 2);
  assert.deepEqual([PackLibrary.getAnnotations('A')[1].width, PackLibrary.getAnnotations('A')[1].hidden], ['bold', true], 'the latest edit is restored');
  assert.equal(stored('A').lastEdited, afterLook, 'Redo restores the time of the look edit');
});

test('each arrow end follows its own cargo: moving, deleting or resizing one flags the arrow, never edits or relocates it', () => {
  seed();
  const [a, b] = twoCrates('A');
  PackLibrary.addArrow('A', { start: top(a.id), end: top(b.id) });
  const record = JSON.stringify(PackLibrary.getAnnotations('A'));
  const resolved = () => PackLibrary.resolveAnnotations('A')[0];
  const first = resolved();
  assert.deepEqual([first.status, first.start.x, first.end.x], ['valid', 60, 160]);
  const pose = (position, rotation = { x: 0, y: 0, z: 0 }) => ({ transform: { position, rotation, scale: { x: 1, y: 1, z: 1 } } });
  assert.ok(PackLibrary.updateInstance('A', b.id, pose({ x: 200, y: 16, z: 10 })));
  assert.deepEqual([resolved().start, resolved().end.x, resolved().end.z], [first.start, 200, 10], 'only the end on the moved cargo moved');
  assert.ok(PackLibrary.updateInstance('A', a.id, { ...pose({ x: 500, y: 16, z: 200 }), placement: 'staged' }));
  assert.equal(resolved().status, 'valid', 'a staged case keeps its arrow');
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), record, 'the stored arrow never changed');

  PackLibrary.removeInstances('A', [b.id]);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'editing cargo never deletes an arrow');
  const gone = resolved();
  assert.deepEqual([gone.status, gone.reason, gone.start, gone.end], ['unresolved', 'cargo-missing', null, null], 'no half arrow, no fabricated position');
  assert.deepEqual([gone.startStatus, gone.endStatus, gone.endReason], ['valid', 'unresolved', 'cargo-missing'], 'the broken end is named');
  assert.equal(StateStore.undo(), true);
  assert.equal(resolved().status, 'valid', 'Undo restores the same instance ID and the arrow resolves again');
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), record);

  const setCase = patch => StateStore.set({ caseLibrary: [{ ...CASE, ...patch }] }, { skipHistory: true });
  setCase({ dimensions: { ...CASE.dimensions, length: 60 } });
  assert.deepEqual([resolved().status, resolved().reason, resolved().start, resolved().end], ['needs-review', 'case-changed', null, null]);
  setCase({});
  assert.equal(resolved().status, 'valid', 'restoring the definition recovers it');
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), record, 'nothing was rewritten or relocated');
});

test('duplicating a Load Plan re-targets each arrow end to its own copied cargo; unmapped ends stay exact and wrappers are copied verbatim', () => {
  seed();
  const [a, b] = twoCrates('A');
  assert.deepEqual(stored('A').cases.map(c => c.id), [a.id, b.id]);
  PackLibrary.addArrow('A', { start: top(a.id), end: top(b.id), color: 'blue', width: 'bold' });
  PackLibrary.addArrow('A', { start: top(b.id), end: floorAnchor() });
  PackLibrary.addArrow('A', { start: ground(2, 2), end: top(a.id) });
  PackLibrary.addCallout('A', note('On a', top(a.id)));
  const original = JSON.stringify(PackLibrary.getAnnotations('A'));
  const copy = PackLibrary.duplicate('A');
  const [copyA, copyB] = copy.cases.map(c => c.id);
  assert.equal(new Set([a.id, b.id, copyA, copyB]).size, 4);
  const [one, two, three, note1] = PackLibrary.getAnnotations(copy.id);
  assert.deepEqual([one.start.instanceId, one.end.instanceId], [copyA, copyB], 'each end follows its own cargo, not swapped');
  assert.deepEqual([one.color, one.width], ['blue', 'bold'], 'presentation travels with it');
  assert.deepEqual([two.start.instanceId, two.end], [copyB, floorAnchor()], 'cargo to floor');
  assert.deepEqual([three.start, three.end.instanceId], [ground(2, 2), copyA], 'space to cargo');
  assert.equal(note1.anchor.instanceId, copyA);
  assert.deepEqual(statuses(copy.id), ['valid', 'valid', 'valid', 'valid']);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), original, 'the original plan keeps its anchors');

  // A damaged plan: an ambiguous ID is never mapped, an unknown ID stays exact, a wrapper is not touched.
  const inner = arrowRecord('inner', onCargo('solo'), ground(1, 1));
  seed([makePack('X', {
    loadPlanNumber: 'LP-X', cases: [solidInstance('dup'), solidInstance('dup'), solidAt('solo', 160)],
    annotations: [arrowRecord('amb', onCargo('dup'), onCargo('solo')), arrowRecord('mix', onCargo('solo'), onCargo('stranger')), wrapperOf('w', inner)],
  })]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous', 'unresolved:cargo-missing', 'unresolved:unreadable']);
  const damaged = PackLibrary.duplicate('X');
  const soloCopy = damaged.cases[2].id;
  const [amb, mix, wrapper] = PackLibrary.getAnnotations(damaged.id);
  assert.deepEqual([amb.start.instanceId, amb.end.instanceId], ['dup', soloCopy], 'the ambiguous end is left exactly as it was');
  assert.deepEqual([mix.start.instanceId, mix.end.instanceId], [soloCopy, 'stranger'], 'an unknown end is left exactly as it was');
  assert.deepEqual(wrapper, wrapperOf('w', inner), 'a wrapper is copied verbatim, its contents never remapped');
  assert.deepEqual(statuses(damaged.id), ['unresolved:cargo-missing', 'unresolved:cargo-missing', 'unresolved:unreadable'], 'in the copy neither dangling end names any cargo');
});

test('importing a Load Plan remaps both arrow ends through the regenerated IDs; a damaged or unsupported record rejects the whole import', () => {
  seed([makePack('A')]);
  const inner = arrowRecord('inner', onCargo('old-1', { x: 1, y: 16, z: 2 }), ground(1, 1));
  const list = [
    arrowRecord('a1', onCargo('old-1', { x: 1, y: 16, z: 2 }), onCargo('old-2', { x: 3, y: 16, z: 0 })),
    arrowRecord('a2', onCargo('never-existed', { x: 0, y: 16, z: 0 }), ground(9, 9)),
    arrowRecord('a3', onCargo(' old-2 ', { x: 0, y: 16, z: 0 }), floorAnchor()),
    wrapperOf('w', inner),
  ];
  const plan = PackLibrary.planPackImport(importPayload(list, [solidInstance('old-1'), solidAt('old-2', 160)]));
  const [new1, new2] = plan.pack.cases.map(c => c.id);
  assert.equal(new1 !== 'old-1' && new2 !== 'old-2', true, 'imports regenerate instance IDs');
  const out = plan.pack.annotations;
  assert.deepEqual([out[0].start.instanceId, out[0].end.instanceId], [new1, new2], 'each end through the same old-to-new map');
  assert.deepEqual([out[0].start.local, out[0].end.local], [list[0].start.local, list[0].end.local]);
  assert.deepEqual([out[1].start.instanceId, out[1].end], ['never-existed', ground(9, 9)], 'a valid reference to missing cargo is retained, never guessed');
  assert.equal(out[2].start.instanceId, new2, 'a trimmed-equal ID follows the map too');
  assert.deepEqual(out[3], list[3], 'a wrapper is accepted verbatim: not remapped, not converted');
  assert.equal(out[3].original.start.instanceId, 'old-1');

  const blocked = /Pack import blocked: the annotations are not valid/;
  const good = list[1];
  const rejected = [
    ['unknown width', { ...good, width: 'huge' }], ['unknown key', { ...good, label: 'Door' }], ['same point', { ...good, end: good.start }],
    ['later schema', { ...good, schemaVersion: 2 }], ['malformed draw', { id: 'd', type: 'draw', schemaVersion: 1, points: [1, 2] }], ['unknown type', { id: 's', type: 'sketch', schemaVersion: 1 }], ['missing end', { ...good, end: undefined }],
  ];
  for (const [label, record] of rejected) assert.throws(() => PackLibrary.planPackImport(importPayload([good, record])), blocked, label);
  assert.throws(() => PackLibrary.planPackImport(importPayload([good, { ...good }])), /duplicate/);
  assert.equal(PackLibrary.planPackImport(importPayload(Array.from({ length: 200 }, (_, i) => arrowRecord(`r${i}`, ground(i, 1), ground(i, 40))))).pack.annotations.length, 200);
  assert.throws(() => PackLibrary.planPackImport(importPayload(Array.from({ length: 201 }, (_, i) => arrowRecord(`r${i}`, ground(i, 1), ground(i, 40))))), /too many/);
});

test('arrows survive export, Load Plan import/export, Workspace Backup and restore; a tampered arrow or a malformed draw is refused', () => {
  const inner = arrowRecord('inner', onCargo(' c1 '), ground(1, 1));
  const list = [
    arrowRecord('a', onCargo(' c1 '), onCargo('c2'), { color: '#ABCDEF', width: 'thin', hidden: true }),
    arrowRecord('b', ground(4, 4), floorAnchor()),
    callout('c', ground(1, 1)),
    wrapperOf('w', inner),
  ];
  const plan = makePack('S', { loadPlanNumber: 'LP-S', cases: [solidAt(' c1 ', 60), solidAt('c2', 160)], annotations: list });
  seed([plan]);
  assert.deepEqual(statuses('S'), ['valid', 'valid', 'valid', 'unresolved:unreadable']);
  for (const project of [projectPortablePack, projectPortableWorkspacePack]) {
    assert.deepEqual(project(plan).annotations, A.normalizeAnnotations(list), `${project.name} carries arrows`);
  }
  const check = (cases, annotations, label) => {
    assert.deepEqual(cases.map(c => c.id), ['c1', 'c2'], `${label}: the cargo IDs are canonical`);
    assert.deepEqual([annotations[0].start.instanceId, annotations[0].end.instanceId], ['c1', 'c2'], `${label}: both ends followed`);
    assert.deepEqual([annotations[0].color, annotations[0].width, annotations[0].hidden], ['#abcdef', 'thin', true], `${label}: presentation survives`);
    assert.deepEqual(annotations[1], list[1], `${label}: an arrow between non-cargo anchors is exact`);
    assert.deepEqual(annotations[3], list[3], `${label}: the wrapper is exact, its ' c1 ' untouched`);
    assert.equal(annotations.length, 4, `${label}: nothing dropped`);
  };
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const restore = ImportExport.planWorkspaceRestore(ImportExport.parseWorkspaceImportJSON(workspaceJson), { currentState: StateStore.snapshot() });
  check(restore.packLibrary[0].cases, restore.packLibrary[0].annotations, 'Workspace Backup');
  StateStore.init({ currentScreen: 'editor', currentPackId: 'S', caseLibrary: restore.caseLibrary, folderLibrary: [], preferences: {}, packLibrary: restore.packLibrary });
  assert.deepEqual(statuses('S'), ['valid', 'valid', 'valid', 'unresolved:unreadable'], 'and they resolve after the restore');
  const again = normalizeAppData({ caseLibrary: restore.caseLibrary, packLibrary: restore.packLibrary, folderLibrary: [], preferences: {} });
  assert.deepEqual(again.packLibrary[0].annotations, restore.packLibrary[0].annotations, 'restoring restored data changes nothing');
  const app = ImportExport.parseAppImportJSON(ImportExport.buildAppExportJSON());
  check(app.packLibrary[0].cases, app.packLibrary[0].annotations, 'Active Workspace Backup');
  assert.deepEqual(JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary[0].annotations.map(r => r.id), ['a', 'b', 'c', 'w']);
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(workspaceJson));

  const tamper = mutate => {
    const copy = JSON.parse(workspaceJson);
    mutate(copy.data.packLibrary[0].annotations);
    return JSON.stringify(copy);
  };
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(tamper(l => { l[0].width = 'huge'; })), /annotation/i);
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(tamper(l => { l[0].label = 'x'; })), /annotation/i);
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(tamper(l => { l[0].end = l[0].start; })), /annotation/i);
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(tamper(l => { l.push({ id: 'd', type: 'draw', schemaVersion: 1, points: [] }); })), /annotation/i, 'a malformed draw is refused');
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(tamper(l => { l[1].id = 'a'; })), /duplicate/i);

  // A single Load Plan exported and imported again: ends follow the regenerated IDs, nothing else changes.
  seed([makePack('P', { loadPlanNumber: 'LP-P', cases: [solidAt('p1', 60), solidAt('p2', 160)], annotations: [arrowRecord('a', top('p1'), top('p2'), { width: 'bold' })] })]);
  const exported = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('P'));
  emptyDestination();
  const imported = PackLibrary.planPackImport(ImportExport.parsePackImportJSON(exported)).pack;
  const [n1, n2] = imported.cases.map(c => c.id);
  assert.deepEqual([imported.annotations[0].start.instanceId, imported.annotations[0].end.instanceId, imported.annotations[0].width], [n1, n2, 'bold']);
  assert.equal(n1 !== 'p1' && n2 !== 'p2', true);
});

test('normalization canonicalizes both arrow ends, withholds an arrow on a contested ID and never converts a wrapper', () => {
  const inner = arrowRecord('inner', onCargo(' c1 '), ground(1, 1));
  const raw = makePack('S', {
    loadPlanNumber: 'LP-S', cases: [solidAt(' c1 ', 60), solidAt(' c2 ', 160)],
    annotations: [arrowRecord('a', onCargo(' c1 '), onCargo(' c2 ')), wrapperOf('w', inner)],
  });
  const normalized = normalizePack(raw, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['c1', 'c2']);
  assert.deepEqual([normalized.annotations[0].start.instanceId, normalized.annotations[0].end.instanceId], ['c1', 'c2']);
  assert.deepEqual(normalized.annotations[1], raw.annotations[1], 'the wrapper keeps its original ID spelling: nothing reached inside it');
  assert.equal(raw.annotations[0].start.instanceId, ' c1 ', 'the raw input was not mutated');
  const twice = normalizePack(normalized, caseMap, 1);
  assert.deepEqual(twice, normalized);
  assert.deepEqual(normalizePack(twice, caseMap, 1), normalized);
  assert.equal(normalizePack(twice, caseMap, 1).annotations, twice.annotations, 'an unchanged list is returned as is');
  seed([normalized]);
  assert.deepEqual(statuses('S'), ['valid', 'unresolved:unreadable'], 'the wrapper has a unique holder to resolve onto, and still does not');

  const noCase = id => ({ ...solidInstance(id), caseId: '' }); // normalization discards an instance with no Case reference
  const rawX = makePack('X', {
    loadPlanNumber: 'LP-X', cases: [solidInstance('cargo'), noCase(' cargo '), solidAt('other', 160)],
    annotations: [
      arrowRecord('on-start', onCargo(' cargo '), onCargo('other')), arrowRecord('on-end', onCargo('other'), onCargo(' cargo ')),
      arrowRecord('fine', onCargo('other'), ground(1, 1)),
    ],
  });
  seed([{ ...rawX, cases: rawX.cases.map(c => ({ ...c, caseId: CASE.id })) }]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous', 'unresolved:cargo-ambiguous', 'valid'], 'as written, the plan is ambiguous: nothing rewritten');
  const normalizedX = normalizePack(rawX, caseMap, 1);
  assert.deepEqual(normalizedX.cases.map(c => c.id), ['cargo', 'other']);
  assert.deepEqual(normalizedX.annotations.slice(0, 2).map(r => r.type), [A.ANNOTATION_TYPE_UNREADABLE, A.ANNOTATION_TYPE_UNREADABLE], 'either end contested withholds the whole arrow');
  assert.deepEqual(normalizedX.annotations.slice(0, 2).map(r => r.original), rawX.annotations.slice(0, 2), 'verbatim');
  assert.equal(normalizedX.annotations[2].type, A.ANNOTATION_TYPE_ARROW);
  seed([normalizedX]);
  assert.deepEqual(statuses('X'), ['unresolved:unreadable', 'unresolved:unreadable', 'valid'], 'never Valid on the surviving cargo');
  assert.deepEqual(normalizePack(normalizedX, caseMap, 1), normalizedX, 'idempotent');
});

test('an older unreadable wrapper holding a valid arrow stays inert through every write; a malformed draw is kept and never written back', () => {
  const inner = arrowRecord('inner', onCargo('c1'), ground(40, 60));
  const wrapper = wrapperOf('w', inner);
  const drawRaw = { id: 'drw', type: 'draw', schemaVersion: 1, points: [1, 2] };
  seed([makePack('A', { loadPlanNumber: 'LP-A', cases: [solidInstance('c1')], annotations: [wrapper, drawRaw] })]);
  assert.deepEqual(statuses('A'), ['unresolved:unreadable', 'unresolved:unreadable'], 'c1 exists and the arrow validates, but the wrapper is not resurrected');
  const added = PackLibrary.addArrow('A', { start: ground(0, 60), end: ground(40, 60) });
  assert.equal(added.ok, true);
  const kept = stored('A').annotations;
  assert.deepEqual(kept[0], wrapper, 'a write wraps, never converts or discards');
  assert.deepEqual([kept[1].type, kept[1].reason, kept[1].original], ['unreadable', 'The saved annotation could not be read.', drawRaw], 'a malformed draw is kept and explained');
  assert.equal(PackLibrary.updateArrow('A', 'w', { width: 'bold' }).reason, 'not-found', 'a wrapper cannot be edited as an arrow');
  assert.equal(PackLibrary.moveArrowEndpoint('A', 'w', 'end', ground(9, 9)).reason, 'not-found');
  assert.equal(PackLibrary.restoreAnnotation('A', drawRaw, 0).reason, 'invalid', 'a malformed draw cannot be written');
  assert.equal(PackLibrary.restoreAnnotation('A', { ...inner, id: 'fresh' }, 0).ok, true, 'while a real arrow can');
  const copy = PackLibrary.duplicate('A');
  assert.deepEqual(PackLibrary.getAnnotations(copy.id).filter(r => r.type === 'unreadable').map(r => r.original), [inner, drawRaw], 'duplicate copies wrappers verbatim');
  assert.deepEqual(JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary.find(p => p.id === 'A').annotations.filter(r => r.id === 'w'), [wrapper], 'and exports it verbatim');
  assert.equal(PackLibrary.deleteAnnotation('A', 'w').ok, true, 'the owner can still delete it deliberately');
  assert.equal(PackLibrary.getAnnotations('A').some(r => r.id === 'w'), false);
});

// ============================================================================
// SECTION: FREEHAND STROKES (V1B.2) — writers, derived validity, duplicate, import, backup, identity
// ============================================================================
// The crate's top face (CASE is 48 x 24 x 32) is the '+y' face at local y = 16: u runs along its length (+-24)
// and v along its width (+-12). Truck: 240 x 96 x 100, so the main floor is x 0..240, z -48..48.

const cratePoint = (instanceId, local = { x: -14, y: 16, z: -6 }) => onCargo(instanceId, local);
const drawRecord = (id, anchor, points, extra = {}) => A.createDrawRecord({ id, anchor, points, now: 1, ...extra });
const topDraw = (id, instanceId, extra = {}) => drawRecord(id, cratePoint(instanceId), [-10, -4, -4, 0, 2, 3, 10, 5], { face: '+y', ...extra });
const floorPoint = (x = 20, z = -10) => M.buildFloorAnchor({ surface: 'main', point: { x, y: 0, z } });
const floorDraw = (id, x = 20) => drawRecord(id, floorPoint(x), [x + 20, -8, x + 40, 0, x + 60, 6]);
const wallDraw = (id) => {
  const pack = makePack('Z');
  const anchor = M.buildSpaceAnchor({ surface: 'wall-left', point: { x: 100, y: 40, z: 48 }, truck: pack.truck, zones: PackLibrary.getMeasurementZones(pack) });
  return drawRecord(id, anchor, [120, 45, 140, 60]);
};
const floorGesture = (extra = {}) => ({ anchor: floorPoint(), rawPoints: [40, -8, 60, 0, 80, 6], ...extra });
const crateGesture = (instanceId, extra = {}) => ({ anchor: cratePoint(instanceId), face: '+y', rawPoints: [-10, -4, -4, 0, 2, 3, 10, 5], ...extra });
/** A stored floor stroke of exactly `vertices` vertices (the anchor counts), written directly rather than through a writer. */
const bigStroke = (id, vertices) => drawRecord(id, floorPoint(100, 0),
  Array.from({ length: (vertices - 1) * 2 }, (_, i) => (i % 2 ? ((i >> 1) % 2 ? 4 : -4) : Math.round((101 + (i >> 1) * 0.2) * 100) / 100)));
/** Raw samples that all survive simplification: a zigzag of `vertices - 1` samples after the anchor at (20, -10). */
const zigzagSamples = vertices => Array.from({ length: (vertices - 1) * 2 }, (_, i) => (i % 2 ? -10 + ((i >> 1) % 2 ? 3 : -3) : 20 + ((i >> 1) + 1) * 0.5));
const DRUM = { ...CASE, shape: 'cylinder', dimensions: { length: 60, width: 24, height: 24 } };
const placeCrate = (packId = 'A', x = 60) => PackLibrary.addInstance(packId, CASE.id, { x, y: 16, z: 0 });

test('freehand writers are undoable steps: lastEdited moves, and each step reverts exactly once, and a style edit never moves a stroke', () => {
  seed();
  const crate = placeCrate();
  const callout1 = PackLibrary.addCallout('A', note('Beside', ground(3, 3))).annotation;
  StateStore.resetHistory();
  setLastEdited('A', 123);
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => { if (notification) notifications.push(notification.type); });
  try {
    const cargoBefore = JSON.stringify(stored('A').cases);
    const calloutBefore = JSON.stringify(PackLibrary.getAnnotations('A')[0]);
    const added = PackLibrary.addDraw('A', crateGesture(crate.id, { color: '#FFA500', width: 'bold' }));
    assert.equal(added.ok, true);
    assert.equal(added.tolerance, 0.1);
    assert.equal(notifications.at(-1), 'pack-annotations', 'derived notification: the app refreshes only the overlay and list');
    assert.ok(stored('A').lastEdited > 123, 'creating a stroke updates lastEdited');
    oneStepRoundTrip('the write');
    assert.equal(stored('B').annotations, undefined, 'another Load Plan is untouched');
    assert.equal(JSON.stringify(stored('A').cases), cargoBefore, 'cargo is untouched');
    assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')[0]), calloutBefore, 'so is the callout');
    const record = PackLibrary.getAnnotations('A')[1];
    assert.deepEqual(record, added.annotation);
    assert.deepEqual([record.type, record.face, record.color, record.width, record.hidden], ['draw', '+y', '#ffa500', 'bold', false]);
    assert.deepEqual(record.points, [-10, -4, -4, 0, 2, 3, 10, 5], 'the samples are already on the grid and none can be dropped');
    assert.ok(record.points.every(v => Math.round(v * 100) / 100 === v));
    assert.deepEqual(statuses('A'), ['valid', 'valid']);
    const resolved = PackLibrary.resolveAnnotations('A')[1];
    assert.equal(resolved.vertices.length, 5);
    assert.deepEqual(resolved.vertices[0], M.cargoLocalToWorld({ center: { x: 60, y: 16, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, { x: -14, y: 16, z: -6 }), 'vertex 0 is the picked point on the crate');
    assert.ok(resolved.vertices.every(v => v.y === 32), 'every vertex lies on the crate\'s top face');

    // A style edit changes presentation only; the stroke itself is carried over byte for byte.
    const shape = JSON.stringify([record.anchor, record.face, record.points, record.id, record.createdAt]);
    const edited = PackLibrary.updateDraw('A', record.id, { color: '#00FF7F', width: 'thin', hidden: true, points: [1, 2], anchor: ground(1, 1), face: '+z' });
    assert.equal(edited.ok, true);
    const after = PackLibrary.getAnnotations('A')[1];
    assert.deepEqual([after.color, after.width, after.hidden], ['#00ff7f', 'thin', true]);
    assert.equal(JSON.stringify([after.anchor, after.face, after.points, after.id, after.createdAt]), shape, 'surface, face, vertices, ID and creation time are unchanged');
    const lastEdited = stored('A').lastEdited;
    assert.equal(PackLibrary.updateDraw('A', record.id, { hidden: true }).unchanged, true, 'an unchanged edit writes nothing');
    assert.equal(stored('A').lastEdited, lastEdited);
    assert.equal(PackLibrary.updateDraw('A', record.id, { width: 'huge' }).reason, 'invalid');
    assert.equal(PackLibrary.updateDraw('A', record.id, { color: 'url(x)' }).reason, 'invalid');
    assert.equal(PackLibrary.updateDraw('A', callout1.id, { hidden: true }).reason, 'not-found', 'a callout is not a stroke');
    assert.equal(PackLibrary.updateCallout('A', record.id, { title: 'x' }).reason, 'not-found', 'and a stroke is not a callout');
    assert.equal(PackLibrary.updateDraw('A', 'nope', { hidden: true }).reason, 'not-found');
    assert.equal(PackLibrary.updateDraw('missing', record.id, { hidden: true }).reason, 'pack-not-found');
    oneStepRoundTrip('the last edit');

    // A stroke that needs review can still be restyled or hidden: no layout is consulted.
    StateStore.set({ caseLibrary: [{ ...CASE, dimensions: { ...CASE.dimensions, height: 40 } }] }, { skipHistory: true });
    assert.deepEqual(statuses('A'), ['valid', 'needs-review:case-changed']);
    assert.equal(PackLibrary.updateDraw('A', record.id, { hidden: false }).ok, true);
    assert.equal(JSON.stringify([PackLibrary.getAnnotations('A')[1].anchor, PackLibrary.getAnnotations('A')[1].points]), JSON.stringify([record.anchor, record.points]), 'and was not moved');
    assert.equal(PackLibrary.deleteAnnotation('A', record.id).ok, true);
    assert.equal(JSON.stringify(stored('A').cases), cargoBefore);
  } finally { unsubscribe(); }
});

test('a stroke is refused, with nothing written, unless it is complete, fits and resolves now', () => {
  seed();
  const crate = placeCrate();
  const stateBefore = snapshotOf();
  const lastEdited = stored('A').lastEdited;
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => { if (notification) notifications.push(notification.type); });
  try {
    const sawtooth = Array.from({ length: 1200 }, (_, i) => (i % 2 ? -10 + ((i >> 1) % 2 ? 3 : -3) : 20 + ((i >> 1) + 1) * 0.05));
    const refusals = [
      ['pack-not-found', 'missing', floorGesture()],
      ['invalid', 'A', { ...floorGesture(), anchor: null }],
      ['invalid', 'A', floorGesture({ color: 'url(x)' })],
      ['invalid', 'A', floorGesture({ width: 'huge' })],
      ['invalid', 'A', floorGesture({ rawPoints: [40, NaN] })],
      ['invalid', 'A', floorGesture({ rawPoints: [] })],
      ['invalid', 'A', { anchor: M.buildSpaceAnchor({ surface: 'free', point: { x: 1, y: 1, z: 1 } }), rawPoints: [4, 4] }],
      ['invalid', 'A', crateGesture(crate.id, { face: 'up' })],
      ['invalid', 'A', crateGesture(crate.id, { face: '+z' })],
      ['invalid', 'A', crateGesture(crate.id, { rawPoints: [-10, -4, 30, 0] })],
      ['too-short', 'A', floorGesture({ rawPoints: [20.002, -10.003] })],
      ['too-short', 'A', floorGesture({ rawPoints: [20.5, -10.5] })],
      ['too-complex', 'A', floorGesture({ rawPoints: sawtooth })],
      ['too-complex', 'A', floorGesture({ rawPoints: Array.from({ length: 2050 }, (_, i) => i) })],
      ['unresolved', 'A', floorGesture({ rawPoints: [230, 0, 250, 0] })],
      ['unresolved', 'A', { anchor: cratePoint('never-existed'), face: '+y', rawPoints: [-10, -4, 2, 3] }],
      ['unresolved', 'A', { anchor: M.buildFloorAnchor({ surface: 'main', point: { x: 20, y: 0, z: -60 } }), rawPoints: [40, -8] }],
    ];
    for (const [reason, packId, input] of refusals) {
      assert.deepEqual(PackLibrary.addDraw(packId, input), { ok: false, reason }, `${reason}: ${JSON.stringify(input).slice(0, 60)}`);
    }
    assert.equal(snapshotOf(), stateBefore, 'a refused stroke changes nothing');
    assert.equal(stored('A').lastEdited, lastEdited);
    assert.deepEqual(notifications, [], 'no notification');
    assert.equal(PackLibrary.addDraw('A').reason, 'invalid', 'no input at all');
    // The same gestures, made valid, are accepted: the refusals above are about the stroke, not the plan.
    assert.equal(PackLibrary.addDraw('A', floorGesture()).ok, true);
    assert.equal(PackLibrary.addDraw('A', floorGesture({ rawPoints: [21, -10] })).ok, true, 'exactly one inch is long enough');
  } finally { unsubscribe(); }
});

test('strokes share the 200-record cap, are limited to 256 vertices each and 3,000 per plan, and a refusal never truncates', () => {
  seed([makePack('A'), makePack('B')]);
  for (let i = 0; i < 199; i++) assert.equal(PackLibrary.addCallout('A', note(`N${i}`, ground(i, 1))).ok, true);
  assert.equal(PackLibrary.addDraw('A', floorGesture()).ok, true, 'the 200th record may be a stroke');
  assert.deepEqual(PackLibrary.addDraw('A', floorGesture()), { ok: false, reason: 'limit' });
  assert.deepEqual(PackLibrary.addCallout('A', note('one too many')), { ok: false, reason: 'limit' });
  assert.equal(PackLibrary.getAnnotations('A').length, 200, 'nothing is truncated or replaced');

  // One stroke may have 256 vertices; a gesture that cannot be simplified into that is too complex.
  const max = PackLibrary.addDraw('B', floorGesture({ rawPoints: zigzagSamples(256) }));
  assert.equal(max.ok, true);
  assert.equal(A.drawVertexCount(max.annotation), 256);
  assert.deepEqual(PackLibrary.addDraw('B', floorGesture({ rawPoints: zigzagSamples(257) })), { ok: false, reason: 'too-complex' });

  // 3,000 vertices per plan: stored strokes may already be there (a lenient read keeps them all), but no more are written.
  const full = Array.from({ length: 11 }, (_, i) => bigStroke(`full${i}`, 256));
  seed([makePack('P', { annotations: [...full, bigStroke('rest', 184)] })]);
  assert.equal(A.drawVertexTotal(PackLibrary.getAnnotations('P')), 3000);
  const lastEdited = stored('P').lastEdited;
  assert.deepEqual(PackLibrary.addDraw('P', floorGesture()), { ok: false, reason: 'points-limit' });
  assert.equal(PackLibrary.getAnnotations('P').length, 12);
  assert.equal(stored('P').lastEdited, lastEdited);
  assert.equal(PackLibrary.addCallout('P', note('Notes need no vertices')).ok, true, 'other annotations are not limited by the vertex total');
  // A stroke has at least two vertices, so room for exactly two more is room for the smallest stroke.
  const removed = PackLibrary.deleteAnnotation('P', 'rest');
  assert.equal(PackLibrary.addDraw('P', floorGesture({ rawPoints: zigzagSamples(182) })).ok, true, '2,816 + 182 = 2,998');
  assert.equal(PackLibrary.addDraw('P', floorGesture({ rawPoints: [41, -10] })).ok, true, '2,998 + 2 = exactly 3,000');
  assert.equal(A.drawVertexTotal(PackLibrary.getAnnotations('P')), 3000);
  assert.deepEqual(PackLibrary.addDraw('P', floorGesture({ rawPoints: [41, -10] })), { ok: false, reason: 'points-limit' });
  // Putting a deleted stroke back obeys the same total.
  assert.deepEqual(PackLibrary.restoreAnnotation('P', removed.removed, removed.index), { ok: false, reason: 'points-limit' });
  assert.equal(PackLibrary.deleteAnnotation('P', 'full0').ok, true);
  assert.equal(PackLibrary.restoreAnnotation('P', removed.removed, removed.index).ok, true, 'room again');
});

test('cargo and stroke edits undo and redo in order, each restoring its exact lastEdited; delete can be put back once', t => {
  tickingClock(t);
  seed();
  const crate = placeCrate();
  PackLibrary.addDraw('A', crateGesture(crate.id));
  const afterFirst = stored('A').lastEdited;
  StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'A' ? { ...p, notes: 'cargo edit' } : p)) });
  const second = PackLibrary.addDraw('A', floorGesture({ color: 'blue' }));
  assert.equal(second.ok, true);
  const afterSecond = stored('A').lastEdited;
  PackLibrary.updateDraw('A', second.annotation.id, { width: 'bold' });
  const afterStyle = stored('A').lastEdited;
  assert.ok(123 < afterFirst && afterFirst < afterSecond && afterSecond < afterStyle, 'each stroke edit has its own, later time');
  const strokes = JSON.stringify(PackLibrary.getAnnotations('A'));
  // Newest first: the stroke's style, then the second stroke, then the cargo edit.
  assert.equal(StateStore.undo(), true, 'the style edit is undone first');
  assert.equal(stored('A').lastEdited, afterSecond, 'with the time the Pack had before the style edit');
  assert.equal(StateStore.undo(), true, 'then the second stroke');
  assert.equal(PackLibrary.getAnnotations('A').length, 1);
  assert.equal(stored('A').lastEdited, afterFirst, 'with the time the Pack had before the second stroke');
  assert.equal(StateStore.undo(), true, 'then the cargo edit');
  assert.equal(stored('A').notes, undefined);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'the earlier stroke is kept');
  assert.equal(stored('A').lastEdited, afterFirst, 'the cargo edit never touched lastEdited');
  assert.equal(StateStore.redo(), true);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').lastEdited, afterSecond);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').notes, 'cargo edit');
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), strokes, 'the strokes and their style are restored exactly');
  assert.equal(stored('A').lastEdited, afterStyle, 'Redo restores the time of the style edit');
  // Deleting is deliberate and individual; putting it back keeps the ID, the position and every vertex.
  const removed = PackLibrary.deleteAnnotation('A', second.annotation.id);
  assert.deepEqual(PackLibrary.getAnnotations('A').map(r => r.type), ['draw']);
  assert.equal(PackLibrary.restoreAnnotation('A', removed.removed, removed.index).ok, true);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), strokes, 'back exactly as it was');
  assert.equal(PackLibrary.restoreAnnotation('A', removed.removed, 0).reason, 'exists', 'never duplicated');
  assert.equal(PackLibrary.restoreAnnotation('A', { ...removed.removed, points: [1, 2, 3] }, 0).reason, 'invalid', 'a damaged copy cannot be put back');
});

test('a stroke follows its cargo and the truck: movement and rotation carry it, resizing or deleting flags it, nothing is rewritten', () => {
  seed();
  const crate = placeCrate();
  PackLibrary.addDraw('A', crateGesture(crate.id));
  const record = JSON.stringify(PackLibrary.getAnnotations('A'));
  const vertices = () => PackLibrary.resolveAnnotations('A')[0].vertices;
  const start = vertices();
  const pose = (position, rotation = { x: 0, y: 0, z: 0 }) => ({ transform: { position, rotation, scale: { x: 1, y: 1, z: 1 } } });
  assert.ok(PackLibrary.updateInstance('A', crate.id, pose({ x: 100, y: 16, z: 10 })));
  assert.deepEqual(vertices().map((v, i) => [v.x - start[i].x, v.y - start[i].y, v.z - start[i].z]), Array(5).fill([40, 0, 10]), 'every vertex moves with the cargo');
  assert.ok(PackLibrary.updateInstance('A', crate.id, pose({ x: 100, y: 16, z: 10 }, { x: 0, y: Math.PI / 2, z: 0 })));
  const turned = vertices();
  assert.equal(statuses('A')[0], 'valid');
  assert.ok(Math.abs(Math.hypot(turned[1].x - turned[0].x, turned[1].z - turned[0].z) - Math.hypot(start[1].x - start[0].x, start[1].z - start[0].z)) < 1e-9, 'rotation keeps the shape');
  assert.notEqual(turned[1].x - turned[0].x, start[1].x - start[0].x, 'but turns it with the cargo');
  assert.ok(PackLibrary.updateInstance('A', crate.id, { ...pose({ x: 500, y: 16, z: 200 }), placement: 'staged' }));
  assert.equal(statuses('A')[0], 'valid', 'a staged case keeps its stroke');
  const setCase = patch => StateStore.set({ caseLibrary: [{ ...CASE, ...patch }] }, { skipHistory: true });
  setCase({ dimensions: { ...CASE.dimensions, length: 60 } });
  assert.deepEqual([statuses('A')[0], PackLibrary.resolveAnnotations('A')[0].vertices], ['needs-review:case-changed', null], 'no vertices are offered, none are relocated');
  setCase({});
  assert.equal(statuses('A')[0], 'valid', 'restoring the Case recovers it');
  PackLibrary.removeInstances('A', [crate.id]);
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'editing cargo never deletes a stroke');
  assert.deepEqual([statuses('A')[0], PackLibrary.resolveAnnotations('A')[0].vertices], ['unresolved:cargo-missing', null]);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), record, 'the stored stroke never changed');
});

test('through the real zone calculation a stroke stops at a seam: wheel-well tops and floor zones are separate patches', () => {
  const truck = { length: 600, width: 100, height: 90, shapeMode: 'wheelWells', shapeConfig: {} };
  seed([makePack('W', { truck })]);
  const rear = (x, z = 0) => M.buildFloorAnchor({ surface: 'main', point: { x, y: 0, z } });
  assert.equal(PackLibrary.addDraw('W', { anchor: rear(100), rawPoints: [120, 10, 140, -10] }).ok, true, 'inside the rear floor zone');
  assert.equal(PackLibrary.addDraw('W', { anchor: rear(200), rawPoints: [250, 20, 300, -20] }).ok, true, 'inside the corridor between the wheel wells');
  assert.deepEqual(PackLibrary.addDraw('W', { anchor: rear(140), rawPoints: [160, 0] }), { ok: false, reason: 'unresolved' }, 'across the seam into the next zone');
  assert.deepEqual(PackLibrary.addDraw('W', { anchor: rear(200), rawPoints: [250, 40] }), { ok: false, reason: 'unresolved' }, 'off the corridor onto the wheel-well side');
  const wellTop = M.buildFloorAnchor({ surface: 'well-top', point: { x: 200, y: 31.5, z: 42 } });
  assert.equal(PackLibrary.addDraw('W', { anchor: wellTop, rawPoints: [250, 48, 300, 40] }).ok, true, 'on top of one wheel well');
  assert.deepEqual(PackLibrary.addDraw('W', { anchor: wellTop, rawPoints: [250, 30] }), { ok: false, reason: 'unresolved' }, 'down from the wheel well to the floor');
  assert.deepEqual(statuses('W'), ['valid', 'valid', 'valid']);
  // A stored stroke is never clipped: if the truck shape changes under it, it is flagged as drawn.
  const withShape = shapeMode => StateStore.set({
    packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'W' ? { ...p, truck: { ...p.truck, shapeMode } } : p)),
  }, { skipHistory: true });
  const before = JSON.stringify(PackLibrary.getAnnotations('W'));
  withShape('rect');
  assert.deepEqual(statuses('W'), ['valid', 'valid', 'needs-review:floor-changed'], 'the wheel-well top no longer exists; the floor strokes follow the plain floor');
  withShape('wheelWells');
  assert.deepEqual(statuses('W'), ['valid', 'valid', 'valid']);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('W')), before, 'nothing was rewritten');
  // A wall stroke on a Front Overhang truck: the wall moving flags it.
  const frontTruck = { length: 600, width: 100, height: 90, shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 30 } };
  seed([makePack('F', { truck: frontTruck })]);
  const zones = PackLibrary.getMeasurementZones(stored('F'));
  const wall = M.buildSpaceAnchor({ surface: 'wall-front', point: { x: 700, y: 60, z: 0 }, truck: frontTruck, zones });
  assert.equal(PackLibrary.addDraw('F', { anchor: wall, rawPoints: [10, 70, 30, 50] }).ok, true);
  const withConfig = shapeConfig => StateStore.set({
    packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'F' ? { ...p, truck: { ...p.truck, shapeConfig } } : p)),
  }, { skipHistory: true });
  withConfig({ bonusLength: 150, bonusHeight: 30 });
  assert.deepEqual(statuses('F'), ['needs-review:truck-changed'], 'the wall moved: the stroke is flagged, not relocated');
  withConfig({ bonusLength: 100, bonusHeight: 30 });
  assert.deepEqual(statuses('F'), ['valid']);
});

test('duplicating a Load Plan re-targets each stroke to its own copied cargo; world strokes stay exact and wrappers are copied verbatim', () => {
  seed();
  const [a, b] = twoCrates('A');
  PackLibrary.addDraw('A', crateGesture(a.id));
  PackLibrary.addDraw('A', crateGesture(b.id, { anchor: cratePoint(b.id, { x: 5, y: 16, z: 3 }), rawPoints: [8, 5, 12, 8] }));
  PackLibrary.addDraw('A', floorGesture());
  const wall = wallDraw('wall');
  PackLibrary.restoreAnnotation('A', wall, 99);
  PackLibrary.addCallout('A', note('On a', top(a.id)));
  const original = JSON.stringify(PackLibrary.getAnnotations('A'));
  const copy = PackLibrary.duplicate('A');
  const [copyA, copyB] = copy.cases.map(c => c.id);
  assert.equal(new Set([a.id, b.id, copyA, copyB]).size, 4);
  const [one, two, three, four, five] = PackLibrary.getAnnotations(copy.id);
  assert.deepEqual([one.anchor.instanceId, two.anchor.instanceId], [copyA, copyB], 'each stroke follows its own cargo, not swapped');
  assert.deepEqual([one.face, two.face], ['+y', '+y'], 'the face is of the cargo\'s own frame and does not change');
  assert.deepEqual([one.points, two.points], [[-10, -4, -4, 0, 2, 3, 10, 5], [8, 5, 12, 8]]);
  assert.deepEqual([three.anchor, three.points], [PackLibrary.getAnnotations('A')[2].anchor, PackLibrary.getAnnotations('A')[2].points], 'a floor stroke is exact');
  assert.deepEqual(four, wall, 'and so is a wall stroke');
  assert.equal(five.anchor.instanceId, copyA);
  assert.deepEqual(statuses(copy.id), ['valid', 'valid', 'valid', 'valid', 'valid']);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), original, 'the original plan keeps its anchors');

  // A damaged plan: an ambiguous ID is never mapped, an unknown ID stays exact, a wrapper holding a valid stroke is not touched.
  const inner = topDraw('inner', 'solo');
  seed([makePack('X', {
    loadPlanNumber: 'LP-X', cases: [solidInstance('dup'), solidInstance('dup'), solidAt('solo', 160)],
    annotations: [topDraw('amb', 'dup'), topDraw('mix', 'solo'), topDraw('stranger', 'stranger'), wrapperOf('w', inner)],
  })]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous', 'valid', 'unresolved:cargo-missing', 'unresolved:unreadable']);
  const damaged = PackLibrary.duplicate('X');
  const soloCopy = damaged.cases[2].id;
  const [amb, mix, stranger, wrapper] = PackLibrary.getAnnotations(damaged.id);
  assert.equal(amb.anchor.instanceId, 'dup', 'the ambiguous anchor is left exactly as it was');
  assert.equal(mix.anchor.instanceId, soloCopy);
  assert.equal(stranger.anchor.instanceId, 'stranger', 'an unknown anchor is left exactly as it was');
  assert.deepEqual(wrapper, wrapperOf('w', inner), 'a wrapper is copied verbatim, its contents never remapped');
  assert.deepEqual(statuses(damaged.id), ['unresolved:cargo-missing', 'valid', 'unresolved:cargo-missing', 'unresolved:unreadable'], 'in the copy neither dangling anchor names any cargo');
});

test('duplicating cargo does not copy or share its strokes: they stay on the original item', () => {
  seed();
  const crate = placeCrate();
  PackLibrary.addDraw('A', crateGesture(crate.id));
  const before = JSON.stringify(PackLibrary.getAnnotations('A'));
  const result = PackLibrary.duplicateInstancesSafely('A', [stored('A').cases[0]]);
  assert.equal(result.newIds.length, 1);
  assert.notEqual(result.newIds[0], crate.id);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), before, 'the stroke list is untouched');
  assert.equal(PackLibrary.getAnnotations('A')[0].anchor.instanceId, crate.id, 'still attached to the original');
  assert.deepEqual(statuses('A'), ['valid']);
  assert.equal(PackLibrary.resolveAnnotations('A')[0].vertices.every(v => v.x < 100), true, 'and drawn on the original');
});

test('importing a Load Plan remaps each stroke through the regenerated IDs; a damaged, over-long or over-total list rejects the whole import', () => {
  seed([makePack('A')]);
  const inner = topDraw('inner', 'old-1');
  const list = [topDraw('s1', 'old-1'), topDraw('s2', 'never-existed'), floorDraw('s3'), topDraw('s4', ' old-2 '), wallDraw('s5'), wrapperOf('w', inner)];
  const plan = PackLibrary.planPackImport(importPayload(list, [solidInstance('old-1'), solidAt('old-2', 160)]));
  const [new1, new2] = plan.pack.cases.map(c => c.id);
  assert.equal(new1 !== 'old-1' && new2 !== 'old-2', true, 'imports regenerate instance IDs');
  const out = plan.pack.annotations;
  assert.equal(out[0].anchor.instanceId, new1);
  assert.deepEqual([out[0].face, out[0].points, out[0].anchor.local], [list[0].face, list[0].points, list[0].anchor.local]);
  assert.equal(out[1].anchor.instanceId, 'never-existed', 'a valid reference to missing cargo is retained, never guessed');
  assert.deepEqual(out[2], A.normalizeAnnotations([list[2]])[0]);
  assert.equal(out[3].anchor.instanceId, new2, 'a trimmed-equal ID follows the map too');
  assert.deepEqual(out[4], A.normalizeAnnotations([list[4]])[0]);
  assert.deepEqual(out[5], list[5], 'a wrapper is accepted verbatim: not remapped, not converted');
  assert.equal(out[5].original.anchor.instanceId, 'old-1');

  const blocked = /Pack import blocked: the annotations are not valid/;
  const good = floorDraw('good');
  const rejected = [
    ['no face on cargo', (({ face: _face, ...rest }) => rest)(list[0])], ['face on a floor stroke', { ...good, face: '+y' }],
    ['unknown key', { ...good, label: 'x' }], ['later schema', { ...good, schemaVersion: 2 }], ['unknown width', { ...good, width: 'huge' }],
    ['off-grid vertex', { ...good, points: [40.005, -8] }], ['repeated vertex', { ...good, points: [40, -8, 40, -8] }], ['no vertices', { ...good, points: [] }],
    ['odd vertex list', { ...good, points: [40, -8, 50] }], ['vertex off the cargo face', { ...list[0], points: [-10, -4, 30, 0] }],
    ['cylinder side wall', drawRecord('drum', M.buildCargoAnchor({ instanceId: 'old-1', local: { x: 0, y: 12, z: 0 }, caseData: DRUM }), [1, 2], { face: '+y' })],
    ['too many vertices', bigStroke('big', 257)], ['open space', drawRecord('free', M.buildSpaceAnchor({ surface: 'free', point: { x: 1, y: 1, z: 1 } }), [2, 2])],
    ['unknown type', { id: 's', type: 'sketch', schemaVersion: 1 }],
  ];
  for (const [label, record] of rejected) assert.throws(() => PackLibrary.planPackImport(importPayload([good, record], [solidInstance('old-1')])), blocked, label);
  assert.throws(() => PackLibrary.planPackImport(importPayload([good, { ...good }])), /duplicate/);
  const full = Array.from({ length: 11 }, (_, i) => bigStroke(`full${i}`, 256));
  assert.equal(PackLibrary.planPackImport(importPayload([...full, bigStroke('rest', 184)])).pack.annotations.length, 12, 'exactly 3,000 vertices is fine');
  assert.throws(() => PackLibrary.planPackImport(importPayload([...full, bigStroke('rest', 185)])), /too many drawing vertices \(3001; maximum 3000\)/);
  assert.equal(PackLibrary.planPackImport(importPayload([...full, bigStroke('rest', 184), wrapperOf('w', bigStroke('inner', 256))])).pack.annotations.length, 13, 'a wrapper\'s original is not counted');
  assert.equal(PackLibrary.planPackImport(importPayload(Array.from({ length: 200 }, (_, i) => floorDraw(`r${i}`, i % 100)))).pack.annotations.length, 200);
  assert.throws(() => PackLibrary.planPackImport(importPayload(Array.from({ length: 201 }, (_, i) => floorDraw(`r${i}`, i % 100)))), /too many/);
});

test('strokes survive export, Load Plan import/export, batch export, Workspace Backup and Active Workspace Backup; a tampered stroke is refused', () => {
  const inner = topDraw('inner', ' c1 ');
  const list = [
    topDraw('a', ' c1 ', { color: '#ABCDEF', width: 'thin', hidden: true }),
    topDraw('b', 'c2'),
    floorDraw('c'),
    wallDraw('d'),
    callout('e', ground(1, 1)),
    wrapperOf('w', inner),
  ];
  const plan = makePack('S', { loadPlanNumber: 'LP-S', cases: [solidAt(' c1 ', 60), solidAt('c2', 160)], annotations: list });
  seed([plan]);
  const expectedStatuses = ['valid', 'valid', 'valid', 'valid', 'valid', 'unresolved:unreadable'];
  assert.deepEqual(statuses('S'), expectedStatuses);
  for (const project of [projectPortablePack, projectPortableWorkspacePack]) {
    assert.deepEqual(project(plan).annotations, A.normalizeAnnotations(list), `${project.name} carries strokes`);
  }
  const check = (cases, annotations, label) => {
    assert.deepEqual(cases.map(c => c.id), ['c1', 'c2'], `${label}: the cargo IDs are canonical`);
    assert.deepEqual([annotations[0].anchor.instanceId, annotations[1].anchor.instanceId], ['c1', 'c2'], `${label}: each stroke followed its cargo`);
    assert.deepEqual([annotations[0].color, annotations[0].width, annotations[0].hidden], ['#abcdef', 'thin', true], `${label}: presentation survives`);
    assert.deepEqual([annotations[0].face, annotations[0].points], ['+y', [-10, -4, -4, 0, 2, 3, 10, 5]], `${label}: face and vertices are exact`);
    assert.deepEqual(annotations[2], A.normalizeAnnotations([list[2]])[0], `${label}: a floor stroke is exact`);
    assert.deepEqual(annotations[3], A.normalizeAnnotations([list[3]])[0], `${label}: a wall stroke is exact`);
    assert.deepEqual(annotations[5], list[5], `${label}: the wrapper is exact, its ' c1 ' untouched`);
    assert.equal(annotations.length, 6, `${label}: nothing dropped`);
  };
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const restore = ImportExport.planWorkspaceRestore(ImportExport.parseWorkspaceImportJSON(workspaceJson), { currentState: StateStore.snapshot() });
  check(restore.packLibrary[0].cases, restore.packLibrary[0].annotations, 'Workspace Backup');
  StateStore.init({ currentScreen: 'editor', currentPackId: 'S', caseLibrary: restore.caseLibrary, folderLibrary: [], preferences: {}, packLibrary: restore.packLibrary });
  assert.deepEqual(statuses('S'), expectedStatuses, 'and they resolve after the restore');
  const again = normalizeAppData({ caseLibrary: restore.caseLibrary, packLibrary: restore.packLibrary, folderLibrary: [], preferences: {} });
  assert.deepEqual(again.packLibrary[0].annotations, restore.packLibrary[0].annotations, 'restoring restored data changes nothing');
  const app = ImportExport.parseAppImportJSON(ImportExport.buildAppExportJSON());
  check(app.packLibrary[0].cases, app.packLibrary[0].annotations, 'Active Workspace Backup');
  assert.deepEqual(JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary[0].annotations.map(r => r.id), ['a', 'b', 'c', 'd', 'e', 'w']);
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(workspaceJson));
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(ImportExport.buildRestorableWorkspaceExportJSON('Probe', 'ws-1')));

  const tamper = mutate => {
    const copy = JSON.parse(workspaceJson);
    mutate(copy.data.packLibrary[0].annotations);
    return JSON.stringify(copy);
  };
  const refusals = [
    ['unknown width', l => { l[0].width = 'huge'; }], ['unknown key', l => { l[0].label = 'x'; }], ['no face', l => { delete l[0].face; }],
    ['face on a floor stroke', l => { l[2].face = '+y'; }], ['off-grid vertex', l => { l[0].points[0] = 10.005; }],
    ['non-finite vertex', l => { l[0].points[0] = '5'; }], ['odd vertex list', l => { l[0].points.push(1); }],
    ['repeated vertex', l => { l[0].points.push(l[0].points.at(-2), l[0].points.at(-1)); }], ['vertex off the face', l => { l[0].points[0] = 40; }],
    ['too many vertices', l => { l[2].points = bigStroke('x', 257).points; }], ['a stroke attached to open space', l => { l[3].anchor = { kind: 'space', surface: 'free', position: { x: 1, y: 1, z: 1 } }; }],
    ['aggregate over 3,000', l => { l.push(...Array.from({ length: 12 }, (_, i) => bigStroke(`extra${i}`, 256))); }],
    ['duplicate ID', l => { l[1].id = 'a'; }],
  ];
  for (const [label, mutate] of refusals) assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(tamper(mutate)), /annotation|duplicate/i, label);

  // A single Load Plan and a batch: the stroke follows the regenerated IDs, nothing else changes.
  seed([makePack('P', { loadPlanNumber: 'LP-P', cases: [solidAt('p1', 60), solidAt('p2', 160)], annotations: [topDraw('a', 'p1', { width: 'bold' }), topDraw('b', 'p2'), floorDraw('c')] }),
    makePack('Q', { loadPlanNumber: 'LP-Q', cases: [solidAt('q1', 60)], annotations: [wallDraw('d')] })]);
  const exported = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('P'));
  const batchJson = ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('P'), PackLibrary.getById('Q')]);
  emptyDestination();
  const imported = PackLibrary.planPackImport(ImportExport.parsePackImportJSON(exported)).pack;
  const [n1, n2] = imported.cases.map(c => c.id);
  assert.deepEqual([imported.annotations[0].anchor.instanceId, imported.annotations[1].anchor.instanceId, imported.annotations[0].width], [n1, n2, 'bold']);
  assert.equal(n1 !== 'p1' && n2 !== 'p2', true);
  assert.deepEqual([imported.annotations[0].points, imported.annotations[0].face], [[-10, -4, -4, 0, 2, 3, 10, 5], '+y']);
  assert.deepEqual(imported.annotations[2], A.normalizeAnnotations([floorDraw('c')])[0]);
  const batch = ImportExport.parsePackBatchImportJSON(batchJson);
  assert.deepEqual(batch.map(entry => entry.pack.annotations.map(r => r.type)), [['draw', 'draw', 'draw'], ['draw']]);
  const strictBatch = JSON.parse(batchJson);
  strictBatch.data.packs[0].pack.annotations[0].points[0] = 10.005;
  assert.throws(() => ImportExport.assertRestorablePackBatchExportJSON(JSON.stringify(strictBatch), 2), /annotation/i, 'the batch check applies the same rules');
  const single = JSON.parse(exported);
  single.data.pack.annotations[0].points = [];
  assert.throws(() => ImportExport.assertRestorablePackExportJSON(JSON.stringify(single)), /annotations are not valid/);
  assert.throws(() => PackLibrary.planPackImport(ImportExport.parsePackImportJSON(JSON.stringify(single))), /not valid|annotation/i, 'and so does the importer');
});

test('an aggregate over 3,000 vertices is refused at export and backup, never repaired; the Workspace Backup limits are unchanged and still enforced', () => {
  const full = Array.from({ length: 11 }, (_, i) => bigStroke(`full${i}`, 256));
  seed([makePack('OVER', { annotations: [...full, bigStroke('rest', 185)] }), makePack('FINE', { annotations: [...full, bigStroke('rest', 184)] })]);
  const over = PackLibrary.getById('OVER');
  const before = JSON.stringify(over);
  assert.equal(A.normalizeAnnotations(over.annotations).every(r => r.type === 'draw'), true, 'a lenient read keeps every valid stroke');
  const refused = error => error.code === 'EXPORT_PREFLIGHT_FAILED' && /too many drawing vertices \(3001; maximum 3000\)/.test(error.message);
  assert.throws(() => ImportExport.buildRestorablePackExportJSON(over), refused);
  assert.throws(() => ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('FINE'), over]), refused);
  assert.equal(JSON.stringify(PackLibrary.getById('OVER')), before, 'nothing is truncated, repaired or rewritten in the saved plan');
  assert.doesNotThrow(() => ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('FINE')));
  assert.throws(() => ImportExport.buildRestorableWorkspaceExportJSON('Probe', 'ws-1'), /annotation|drawing/i, 'Workspace Backup refuses it too');
  assert.throws(() => ImportExport.buildRestorableAppExportJSON(), /annotation|drawing/i, 'and so does Active Workspace Backup');

  // The backup ceilings are the ones that shipped with the Workspace Backup, and strokes count toward them.
  assert.deepEqual({ ...ImportExport.WORKSPACE_BACKUP_LIMITS }, {
    maxBytes: 25 * 1024 * 1024, maxDepth: 32, maxJsonNodes: 500000, maxStringChars: 1000000, maxCases: 5000, maxPacks: 1000, maxFolders: 2000, maxCategories: 1000, maxInstances: 100000,
  });
  const fullPack = id => makePack(id, { loadPlanNumber: `LP-${id}`, annotations: [...full, bigStroke('rest', 184)] });
  seed(Array.from({ length: 3 }, (_, i) => fullPack(`F${i}`)));
  assert.doesNotThrow(() => ImportExport.buildRestorableWorkspaceExportJSON('Probe', 'ws-1'), 'three fully drawn plans are well inside the limits');
  const nodes = value => (value && typeof value === 'object' ? 1 + Object.values(value).reduce((sum, v) => sum + nodes(v), 0) : 1);
  const perPlan = nodes(JSON.parse(ImportExport.buildRestorableWorkspaceExportJSON('Probe', 'ws-1')).data.packLibrary[0].annotations);
  assert.ok(perPlan > 6000 && perPlan < 8000, `a fully drawn plan is about ${perPlan} JSON values`);
  seed(Array.from({ length: 90 }, (_, i) => fullPack(`F${i}`)));
  assert.throws(() => ImportExport.buildRestorableWorkspaceExportJSON('Probe', 'ws-1'),
    error => error.code === 'WORKSPACE_BACKUP_LIMIT_EXCEEDED' && /too many JSON values/.test(error.message),
    'ninety fully drawn plans exceed the 500,000 JSON-value ceiling, which is neither raised nor bypassed');
});

test('normalization canonicalizes a stroke\'s cargo ID, withholds a stroke on a contested ID and never converts a wrapper', () => {
  const inner = topDraw('inner', ' c1 ');
  const raw = makePack('S', {
    loadPlanNumber: 'LP-S', cases: [solidAt(' c1 ', 60), solidAt(' c2 ', 160)],
    annotations: [topDraw('a', ' c1 '), topDraw('b', ' c2 '), wrapperOf('w', inner)],
  });
  const normalized = normalizePack(raw, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['c1', 'c2']);
  assert.deepEqual([normalized.annotations[0].anchor.instanceId, normalized.annotations[1].anchor.instanceId], ['c1', 'c2']);
  assert.deepEqual([normalized.annotations[0].face, normalized.annotations[0].points], ['+y', [-10, -4, -4, 0, 2, 3, 10, 5]]);
  assert.deepEqual(normalized.annotations[2], raw.annotations[2], 'the wrapper keeps its original ID spelling: nothing reached inside it');
  assert.equal(raw.annotations[0].anchor.instanceId, ' c1 ', 'the raw input was not mutated');
  const twice = normalizePack(normalized, caseMap, 1);
  assert.deepEqual(twice, normalized);
  assert.deepEqual(normalizePack(twice, caseMap, 1), normalized);
  assert.equal(normalizePack(twice, caseMap, 1).annotations, twice.annotations, 'an unchanged list is returned as is');
  seed([normalized]);
  assert.deepEqual(statuses('S'), ['valid', 'valid', 'unresolved:unreadable'], 'the wrapper has a unique holder to resolve onto, and still does not');

  const noCase = id => ({ ...solidInstance(id), caseId: '' }); // normalization discards an instance with no Case reference
  const rawX = makePack('X', {
    loadPlanNumber: 'LP-X', cases: [solidInstance('cargo'), noCase(' cargo '), solidAt('other', 160)],
    annotations: [topDraw('on-cargo', ' cargo '), topDraw('on-other', 'other'), floorDraw('fine')],
  });
  seed([{ ...rawX, cases: rawX.cases.map(c => ({ ...c, caseId: CASE.id })) }]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous', 'valid', 'valid'], 'as written, the plan is ambiguous: nothing rewritten');
  const normalizedX = normalizePack(rawX, caseMap, 1);
  assert.deepEqual(normalizedX.cases.map(c => c.id), ['cargo', 'other']);
  assert.equal(normalizedX.annotations[0].type, A.ANNOTATION_TYPE_UNREADABLE, 'a stroke on a contested key is withheld whole');
  assert.deepEqual(normalizedX.annotations[0].original, rawX.annotations[0], 'verbatim');
  assert.deepEqual(normalizedX.annotations.slice(1).map(r => r.type), ['draw', 'draw']);
  seed([normalizedX]);
  assert.deepEqual(statuses('X'), ['unresolved:unreadable', 'valid', 'valid'], 'never Valid on the surviving cargo');
  assert.deepEqual(normalizePack(normalizedX, caseMap, 1), normalizedX, 'idempotent');
});

test('the generic Pack update cannot write strokes, and an older wrapper holding a valid stroke stays inert through every write', () => {
  seed();
  const crate = placeCrate();
  PackLibrary.addDraw('A', crateGesture(crate.id));
  const stateBefore = JSON.stringify(StateStore.snapshot().packLibrary);
  const edited = stored('A').lastEdited;
  assert.equal(PackLibrary.update('A', { annotations: [floorDraw('sneak')] }), null, 'a stroke cannot be slipped in');
  assert.equal(PackLibrary.update('A', { annotations: [{ ...PackLibrary.getAnnotations('A')[0], points: [1, 2] }] }), null, 'nor can a stroke be rewritten');
  assert.equal(PackLibrary.update('A', { annotations: [], title: 'Sneaky' }), null);
  assert.equal(JSON.stringify(StateStore.snapshot().packLibrary), stateBefore);
  assert.equal(stored('A').lastEdited, edited);
  assert.ok(PackLibrary.update('A', { title: 'Renamed' }), 'an ordinary update still works');
  assert.equal(PackLibrary.getAnnotations('A').length, 1);

  const inner = topDraw('inner', 'c1');
  const wrapper = wrapperOf('w', inner);
  seed([makePack('B', { loadPlanNumber: 'LP-B', cases: [solidInstance('c1')], annotations: [wrapper] })]);
  assert.deepEqual(statuses('B'), ['unresolved:unreadable'], 'c1 exists and the stroke validates, but the wrapper is not resurrected');
  assert.equal(PackLibrary.addDraw('B', floorGesture()).ok, true);
  assert.deepEqual(stored('B').annotations[0], wrapper, 'a write wraps, never converts or discards');
  assert.equal(PackLibrary.updateDraw('B', 'w', { hidden: true }).reason, 'not-found', 'a wrapper cannot be edited as a stroke');
  const copy = PackLibrary.duplicate('B');
  assert.deepEqual(PackLibrary.getAnnotations(copy.id).filter(r => r.type === 'unreadable').map(r => r.original), [inner], 'duplicate copies the wrapper verbatim');
  assert.deepEqual(JSON.parse(CoreStorage.exportAppJSON()).data.packLibrary.find(p => p.id === 'B').annotations.filter(r => r.id === 'w'), [wrapper], 'and exports it verbatim');
  assert.equal(PackLibrary.deleteAnnotation('B', 'w').ok, true, 'the owner can still delete it deliberately');
});

// ============================================================================
// SECTION: LINE STYLES (V1B.2 Gate B.3) — writers, no-op edits, export, backup and restore
// ============================================================================

test('line style: the writers store Dashed and Dotted only, an unchanged choice writes nothing, and styled records survive every export and restore', () => {
  seed();
  const crate = placeCrate();
  StateStore.resetHistory();
  setLastEdited('A', 123);
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => { if (notification) notifications.push(notification.type); });
  try {
    const legacyArrow = PackLibrary.addArrow('A', { start: ground(0, 60), end: ground(40, 60) }).annotation;
    const solidArrow = PackLibrary.addArrow('A', { start: ground(0, 70), end: ground(40, 70), style: 'solid' }).annotation;
    const dashedArrow = PackLibrary.addArrow('A', { start: ground(0, 80), end: ground(40, 80), style: 'dashed', width: 'bold' }).annotation;
    const dottedStroke = PackLibrary.addDraw('A', crateGesture(crate.id, { style: 'dotted' })).annotation;
    const solidStroke = PackLibrary.addDraw('A', floorGesture({ style: 'solid' })).annotation;
    assert.deepEqual([legacyArrow, solidArrow, solidStroke].map(record => Object.hasOwn(record, 'style')), [false, false, false], 'Solid is never stored');
    assert.deepEqual([dashedArrow.style, dottedStroke.style], ['dashed', 'dotted']);
    assert.equal(PackLibrary.addArrow('A', { start: ground(0, 90), end: ground(40, 90), style: 'wavy' }).reason, 'invalid');
    assert.equal(PackLibrary.addDraw('A', crateGesture(crate.id, { style: 'Dashed' })).reason, 'invalid');
    assert.equal(PackLibrary.getAnnotations('A').length, 5, 'a refused style writes nothing');
    oneStepRoundTrip('the last of these edits');

    // A saved record changes with exactly one annotation write; the same choice again writes nothing.
    notifications.length = 0;
    const edited = PackLibrary.updateArrow('A', legacyArrow.id, { style: 'dotted' });
    assert.equal(edited.ok, true);
    assert.deepEqual(notifications, ['pack-annotations'], 'one annotation-only write');
    const find = id => PackLibrary.getAnnotations('A').find(record => record.id === id);
    assert.equal(find(legacyArrow.id).style, 'dotted');
    assert.deepEqual([find(legacyArrow.id).start, find(legacyArrow.id).end, find(legacyArrow.id).createdAt], [legacyArrow.start, legacyArrow.end, legacyArrow.createdAt]);
    const editedAt = stored('A').lastEdited;
    notifications.length = 0;
    assert.equal(PackLibrary.updateArrow('A', legacyArrow.id, { style: 'dotted' }).unchanged, true);
    assert.equal(PackLibrary.updateArrow('A', solidArrow.id, { style: 'solid' }).unchanged, true, 'choosing Solid on a Solid arrow is not an edit');
    assert.equal(PackLibrary.updateDraw('A', solidStroke.id, { style: 'solid' }).unchanged, true);
    assert.deepEqual(notifications, [], 'no write, no notification');
    assert.equal(stored('A').lastEdited, editedAt);
    assert.equal(PackLibrary.updateArrow('A', dashedArrow.id, { style: 'solid' }).ok, true);
    assert.equal(Object.hasOwn(find(dashedArrow.id), 'style'), false, 'back to Solid removes the key');
    assert.equal(PackLibrary.updateDraw('A', dottedStroke.id, { style: 'dashed' }).ok, true);
    assert.equal(find(dottedStroke.id).style, 'dashed');
    assert.equal(PackLibrary.updateArrow('A', legacyArrow.id, { style: 'wavy' }).reason, 'invalid');
    assert.equal(PackLibrary.updateDraw('A', dottedStroke.id, { style: null }).reason, 'invalid');
    assert.equal(find(legacyArrow.id).style, 'dotted', 'a refused edit changes nothing');
    oneStepRoundTrip('the style edit');
  } finally {
    unsubscribe();
  }

  // Styled records are carried by every export and restore path without any change to them.
  const plan = stored('A');
  const expected = A.normalizeAnnotations(plan.annotations);
  assert.deepEqual(expected.map(record => record.style ?? 'solid'), ['dotted', 'solid', 'solid', 'dashed', 'solid']);
  for (const project of [projectPortablePack, projectPortableWorkspacePack]) assert.deepEqual(project(plan).annotations, expected, `${project.name} carries line styles`);
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const restore = ImportExport.planWorkspaceRestore(ImportExport.parseWorkspaceImportJSON(workspaceJson), { currentState: StateStore.snapshot() });
  assert.deepEqual(restore.packLibrary.find(pack => pack.id === 'A').annotations.map(record => record.style ?? 'solid'), ['dotted', 'solid', 'solid', 'dashed', 'solid']);
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(workspaceJson));
  const single = ImportExport.buildRestorablePackExportJSON(plan);
  emptyDestination();
  const imported = PackLibrary.planPackImport(ImportExport.parsePackImportJSON(single)).pack;
  assert.deepEqual(imported.annotations.map(record => record.style ?? 'solid'), ['dotted', 'solid', 'solid', 'dashed', 'solid']);
  // A backup naming a style this build does not know is refused whole, like any other malformed annotation.
  const tampered = JSON.parse(workspaceJson);
  tampered.data.packLibrary.find(pack => pack.id === 'A').annotations[0].style = 'wavy';
  assert.throws(() => ImportExport.assertRestorableWorkspaceBackup(JSON.stringify(tampered)), /annotation/i);
  // A record saved before line styles reads back as Solid with no style key and no rewrite.
  const legacy = JSON.parse(JSON.stringify(A.normalizeAnnotations([arrowRecord('old')])[0]));
  assert.equal(Object.hasOwn(legacy, 'style'), false);
  seed([makePack('L', { annotations: [legacy] })]);
  assert.equal(JSON.stringify(PackLibrary.getAnnotations('L')[0]), JSON.stringify(legacy), 'a legacy arrow is not rewritten by loading it');
  assert.deepEqual(statuses('L'), ['valid']);
});

test('drawing move: moveDraw is one undoable write, a refused move writes nothing, and the new position survives every export and restore', () => {
  seed();
  const crate = placeCrate();
  const top = PackLibrary.addDraw('A', crateGesture(crate.id, { color: 'blue', width: 'bold', style: 'dashed' })).annotation;
  const floor = PackLibrary.addDraw('A', floorGesture()).annotation;
  const callout1 = PackLibrary.addCallout('A', note('Beside', ground(3, 3))).annotation;
  StateStore.resetHistory();
  setLastEdited('A', 123);
  const cargoBefore = JSON.stringify(stored('A').cases);
  const find = id => PackLibrary.getAnnotations('A').find(record => record.id === id);
  const flat = record => [M.drawAnchorUV(record.anchor, record.face), record.points];
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => { if (notification) notifications.push(notification.type); });
  try {
    const before = JSON.stringify(PackLibrary.getAnnotations('A'));
    const moved = PackLibrary.moveDraw('A', top.id, 3.5, 2);
    assert.equal(moved.ok, true);
    assert.deepEqual(notifications, ['pack-annotations'], 'exactly one annotation-only write');
    const after = find(top.id);
    assert.deepEqual(after.points, top.points.map((value, i) => Math.round((value + (i % 2 ? 2 : 3.5)) * 100) / 100), 'every vertex moved by the same offset');
    assert.ok(Math.abs(M.drawAnchorUV(after.anchor, after.face).u - M.drawAnchorUV(top.anchor, top.face).u - 3.5) < 1e-9, 'the anchor moved with it');
    assert.equal(after.anchor.local.y, top.anchor.local.y, 'and stayed on its face plane');
    assert.deepEqual([after.id, after.anchor.instanceId, after.face, after.color, after.width, after.style, after.hidden, after.createdAt],
      [top.id, top.anchor.instanceId, top.face, top.color, top.width, top.style, top.hidden, top.createdAt], 'identity, surface and presentation are preserved');
    assert.equal(JSON.stringify(stored('A').cases), cargoBefore, 'cargo is never touched');
    assert.equal(JSON.stringify(PackLibrary.getAnnotations('A').filter(r => r.id !== top.id)), JSON.stringify(JSON.parse(before).filter(r => r.id !== top.id)), 'no other annotation changed');
    assert.ok(stored('A').lastEdited > 123, 'a real move updates lastEdited');
    oneStepRoundTrip('the write');
    assert.deepEqual(statuses('A'), ['valid', 'valid', 'valid'], 'the moved stroke still resolves');

    // The same position again, or an offset below the grid, is not an edit.
    const editedAt = stored('A').lastEdited;
    notifications.length = 0;
    assert.equal(PackLibrary.moveDraw('A', top.id, 0, 0).unchanged, true);
    assert.equal(PackLibrary.moveDraw('A', floor.id, 0.004, -0.004).unchanged, true);
    assert.deepEqual(notifications, [], 'no write, no notification');
    assert.equal(stored('A').lastEdited, editedAt, 'lastEdited is not touched');

    // A refused move changes nothing, and the dry run gives the same verdict without writing.
    const steady = JSON.stringify(PackLibrary.getAnnotations('A'));
    const refusals = [
      ['invalid', 'A', top.id, 40, 0], // past the end of the crate top
      ['invalid', 'A', top.id, 0, -30],
      ['unresolved', 'A', floor.id, 0, 80], // through the truck wall
      ['unresolved', 'A', floor.id, -30, 0], // behind the truck
      ['invalid', 'A', top.id, NaN, 0],
      ['not-found', 'A', callout1.id, 1, 1],
      ['not-found', 'A', 'nope', 1, 1],
      ['pack-not-found', 'missing', top.id, 1, 1],
    ];
    for (const [reason, packId, id, du, dv] of refusals) {
      assert.equal(PackLibrary.moveDraw(packId, id, du, dv).reason, reason, `moveDraw ${id} ${du},${dv}`);
      assert.equal(PackLibrary.checkDrawMove(packId, id, du, dv).reason, reason, `checkDrawMove ${id} ${du},${dv}`);
    }
    assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), steady, 'nothing was written');
    assert.deepEqual(notifications, []);
    assert.equal(stored('A').lastEdited, editedAt);
    const dry = PackLibrary.checkDrawMove('A', floor.id, 5, 5);
    assert.deepEqual([dry.ok, dry.dryRun, dry.annotation.points[0]], [true, true, floor.points[0] + 5]);
    assert.equal(JSON.stringify(PackLibrary.getAnnotations('A')), steady, 'a passing dry run writes nothing either');
    assert.deepEqual(notifications, []);

    // A stroke whose surface no longer resolves cannot be moved; it can still be restyled or deleted.
    StateStore.set({ caseLibrary: [{ ...CASE, dimensions: { ...CASE.dimensions, height: 40 } }] }, { skipHistory: true });
    assert.deepEqual(statuses('A'), ['needs-review:case-changed', 'valid', 'valid']);
    assert.equal(PackLibrary.moveDraw('A', top.id, 1, 1).reason, 'unresolved');
    assert.equal(PackLibrary.moveDraw('A', floor.id, 1, 1).ok, true, 'a world stroke does not depend on the crate');
    StateStore.set({ caseLibrary: [CASE] }, { skipHistory: true });
    assert.equal(PackLibrary.moveDraw('A', floor.id, -1, -1).ok, true);
  } finally {
    unsubscribe();
  }

  // The saved position is what every export and restore path carries.
  const plan = stored('A');
  const expected = A.normalizeAnnotations(plan.annotations);
  assert.deepEqual(flat(expected.find(r => r.id === top.id)), flat(find(top.id)));
  for (const project of [projectPortablePack, projectPortableWorkspacePack]) assert.deepEqual(project(plan).annotations, expected, `${project.name} carries the moved stroke`);
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const restore = ImportExport.planWorkspaceRestore(ImportExport.parseWorkspaceImportJSON(workspaceJson), { currentState: StateStore.snapshot() });
  assert.deepEqual(restore.packLibrary.find(pack => pack.id === 'A').annotations, expected, 'a restore brings the moved stroke back where it was put');
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(workspaceJson));
});

test('an unchanged measurement endpoint writes nothing: no history step and lastEdited stays put', () => {
  seed();
  const measured = PackLibrary.addMeasurement('A', { start: ground(0, 60), end: ground(40, 60) });
  assert.equal(measured.ok, true);
  const edited = stored('A').lastEdited;
  const same = PackLibrary.moveMeasurementEndpoint('A', measured.measurement.id, 'start', measured.measurement.start);
  assert.deepEqual([same.ok, same.unchanged], [true, true], 'the same content at the same place is no edit');
  assert.equal(stored('A').lastEdited, edited);
  assert.equal(StateStore.undo(), true, 'the only step is the measurement creation');
  assert.equal(PackLibrary.getMeasurements('A').length, 0, 'and it was not followed by an empty step');
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getMeasurements('A').length, 1);
});

test('Undo and Redo keep the current view and thumbnail, and history never crosses a Load Plan switch', () => {
  seed();
  PackLibrary.updatePreview('A', { thumbnail: 'data:current', thumbnailRenderVersion: 2 });
  PackLibrary.updateEditorView('A', { cameraPosition: { x: 30, y: 18, z: 20 }, target: { x: 14, y: 2, z: 0 } });
  const view = stored('A').editorView;
  const added = PackLibrary.addCallout('A', note('Written after the preview'));
  assert.equal(added.ok, true);
  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getAnnotations('A').length, 0);
  assert.equal(stored('A').thumbnail, 'data:current', 'Undo keeps the current thumbnail');
  assert.deepEqual(stored('A').editorView, view, 'and the current view');
  assert.equal(StateStore.redo(), true);
  assert.equal(PackLibrary.getAnnotations('A').length, 1);

  // A -> B -> A: switching Load Plans starts a fresh history, so nothing from A can be replayed through B.
  PackLibrary.open('B');
  assert.equal(StateStore.undo(), false, 'Load Plan B starts with no history to replay');
  PackLibrary.open('A');
  assert.equal(StateStore.undo(), false, 'and returning to A does not revive the earlier steps');
  assert.equal(PackLibrary.getAnnotations('A').length, 1, 'A keeps its saved content');
});

test('whole-object move: an Arrow or Measurement is carried rigidly along ONE surface as one undoable write, and anything else is refused', () => {
  seed([makePack('A', { cases: [solidInstance('i1'), { ...solidInstance('i2'), transform: { ...solidInstance('i2').transform, position: { x: 120, y: 16, z: 0 } } }] })]);
  const top = (id, x, z) => onCargo(id, { x, y: 16, z });
  const arrow = PackLibrary.addArrow('A', { start: ground(0, 60), end: ground(40, 60), color: 'ink', width: 'bold', style: 'dashed' });
  const meas = PackLibrary.addMeasurement('A', { start: top('i1', -12, -6), end: top('i1', 12, 6), label: 'Top run' });
  assert.deepEqual([arrow.ok, meas.ok], [true, true]);
  const shape = record => JSON.stringify({ ...record, start: null, end: null, updatedAt: 0 });
  const reach = (start, end) => Math.hypot(...['x', 'y', 'z'].map(axis => (end.position || end.local)[axis] - (start.position || start.local)[axis]));

  // A ground Arrow: both ends shift by the same snapped offset, everything else (including length) is kept.
  const arrowMoved = PackLibrary.moveArrow('A', arrow.annotation.id, 5.004, -3);
  assert.equal(arrowMoved.ok, true);
  const arrowNow = PackLibrary.getAnnotations('A').find(record => record.id === arrow.annotation.id);
  assert.deepEqual([arrowNow.start.position, arrowNow.end.position], [{ x: 5, y: 0, z: 57 }, { x: 45, y: 0, z: 57 }]);
  assert.equal(shape(arrowNow), shape(arrow.annotation), 'name, color, width, style and identity are untouched');
  assert.equal(reach(arrowNow.start, arrowNow.end), reach(arrow.annotation.start, arrow.annotation.end));
  assert.equal(StateStore.undo(), true);
  assert.deepEqual(PackLibrary.getAnnotations('A').find(record => record.id === arrow.annotation.id).start, arrow.annotation.start, 'one Undo step restores it');
  assert.equal(StateStore.redo(), true);

  // A Measurement on one cargo face: both ends move inside that face, the label and the surface stay.
  const measMoved = PackLibrary.moveMeasurement('A', meas.measurement.id, 2, 1);
  assert.equal(measMoved.ok, true);
  const measNow = PackLibrary.getMeasurements('A').find(record => record.id === meas.measurement.id);
  assert.deepEqual([measNow.start.local, measNow.end.local], [{ x: -10, y: 16, z: -5 }, { x: 14, y: 16, z: 7 }]);
  assert.deepEqual([measNow.label, measNow.start.instanceId], ['Top run', 'i1']);

  // A refused move writes nothing and keeps Redo: off the face, an unchanged offset, a pair that does not share one surface.
  const before = snapshotOf();
  const refusals = [
    PackLibrary.moveMeasurement('A', meas.measurement.id, 40, 0), // leaves the cargo face
    PackLibrary.moveMeasurement('A', meas.measurement.id, Number.NaN, 0),
    PackLibrary.moveArrow('A', arrow.annotation.id, Number.POSITIVE_INFINITY, 0),
  ];
  assert.deepEqual(refusals.map(outcome => outcome.ok), [false, false, false]);
  assert.equal(snapshotOf(), before, 'a refused move writes nothing');
  assert.equal(PackLibrary.moveArrow('A', arrow.annotation.id, 0.004, 0).unchanged, true, 'an offset that snaps to zero is no edit');
  assert.equal(PackLibrary.checkMeasurementMove('A', meas.measurement.id, 1, 0).dryRun, true);
  assert.equal(snapshotOf(), before, 'and a dry-run verdict writes nothing');

  const mixed = PackLibrary.addMeasurement('A', { start: top('i1', 0, 0), end: ground(100, 40) });
  assert.equal(mixed.ok, true);
  assert.equal(PackLibrary.moveMeasurement('A', mixed.measurement.id, 1, 1).reason, 'invalid', 'cargo and ground are not one surface');
  const otherCargo = PackLibrary.addMeasurement('A', { start: top('i1', 0, 0), end: top('i2', 0, 0) });
  assert.equal(PackLibrary.moveMeasurement('A', otherCargo.measurement.id, 1, 1).reason, 'invalid', 'two cargo items are not one surface');
  const edge = PackLibrary.addArrow('A', { start: onCargo('i1', { x: -10, y: 16, z: 12 }), end: onCargo('i1', { x: 10, y: 16, z: 12 }) });
  assert.equal(PackLibrary.moveArrow('A', edge.annotation.id, 0, 1).reason, 'invalid', 'two points on a shared edge could be on either face, so the move is ambiguous');
});
