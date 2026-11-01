/**
 * @file measurement-tool-lifecycle.spec.mjs
 * @description Pins how Measurement Tool V1 data lives inside a Load Plan: the normalizer whitelist
 *   (G1), writes that are one step each in the same chronological Undo/Redo history as cargo edits
 *   and restore their exact `lastEdited` (G2), duplicate and import instance-ID remapping (G3), and
 *   export/backup projection plus strict restore validation (G4). The pure model is pinned in
 *   measurement-tool-core.spec.mjs.
 *   Contract: docs/product/TP3D-MASTER-TODO-V6.md Section 4.1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// import-export.js reads the browser storage globals while it loads (as in export-integrity-c.spec.mjs).
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
import * as PreferencesManager from '../../src/services/preferences-manager.js';
import * as ImportExport from '../../src/services/import-export.js';
import * as M from '../../src/core/measurements.js';
import { normalizeAppData, normalizePack, normalizePreferences } from '../../src/core/normalizer.js';
import * as CoreStorage from '../../src/core/storage.js';
import { projectPortablePack, projectPortableWorkspacePack, validateWorkspaceGraph } from '../../src/core/import-schema.js';

const CASE = {
  id: 'case-1', name: 'Crate', itemCode: 'C-1', manufacturer: 'Test', category: 'audio',
  dimensions: { length: 48, width: 24, height: 32 }, weight: 50, shape: 'box',
  stackable: true, maxStackCount: 2, orientationLock: 'upright', color: '#111111',
};
const makePack = (id, extra = {}) => ({
  id, title: id, loadPlanNumber: `LP-${id}`, truck: { length: 240, width: 96, height: 100 },
  cases: [], groups: [], stats: { totalCases: 0 }, lastEdited: 123,
  editorView: null, thumbnail: null, thumbnailVisualSignature: null, thumbnailViewSignature: null,
  ...extra,
});
const seed = (packs = [makePack('A'), makePack('B')]) => StateStore.init({
  currentScreen: 'editor', currentPackId: packs[0].id, caseLibrary: [CASE],
  folderLibrary: [], preferences: {}, packLibrary: packs,
});
const ground = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
const pair = (n = 1) => ({ start: ground(0, 60), end: ground(10 * n, 60) });
const stored = id => PackLibrary.getById(id);

test('G1 normalizePack whitelists measurements: legacy plans get [], valid ones persist, malformed ones are kept as recovery records', () => {
  assert.deepEqual(normalizePack(makePack('A')).measurements, [], 'a plan saved before the feature has none');
  const good = M.createMeasurementRecord({ id: 'g', ...pair(), now: 1 });
  assert.deepEqual(normalizePack(makePack('A', { measurements: [good] })).measurements, M.normalizeMeasurements([good]));
  const malformed = { id: 'bad', type: 'point-to-point', start: { kind: 'mystery' } };
  const kept = normalizePack(makePack('A', { measurements: [good, malformed] })).measurements;
  assert.equal(kept.length, 2, 'nothing is dropped');
  assert.equal(kept[1].type, M.MEASUREMENT_TYPE_UNREADABLE);
  assert.deepEqual(kept[1].original, malformed, 'the original record is preserved verbatim for recovery');
});

test('G1 a write keeps unreadable originals verbatim and an unrelated edit never touches stored measurements', () => {
  const rawBad = [{ id: 'bad-1', type: 'point-to-point', start: { kind: 'mystery' } }, 'garbage'];
  seed([makePack('A', { measurements: rawBad })]);
  assert.deepEqual(stored('A').measurements, rawBad, 'hydration keeps the raw stored value');
  PackLibrary.update('A', { notes: 'unrelated edit' });
  assert.deepEqual(stored('A').measurements, rawBad, 'an unrelated autosaved edit leaves malformed data verbatim');
  const added = PackLibrary.addMeasurement('A', pair());
  assert.equal(added.ok, true);
  const unreadable = stored('A').measurements.filter(r => r.type === M.MEASUREMENT_TYPE_UNREADABLE);
  assert.deepEqual(unreadable.map(r => r.original), rawBad, 'writing a measurement wraps, never discards, what could not be read');
  assert.equal(PackLibrary.resolveMeasurements('A').filter(r => r.reason === 'unreadable').length, 2);
  const removed = PackLibrary.deleteMeasurement('A', added.measurement.id);
  assert.equal(removed.ok, true);
  assert.equal(stored('A').measurements.length, 2, 'only the deliberately deleted record is gone');
});

test('showMeasurementTool defaults On, is a boolean preference and takes the lightweight visibility route', () => {
  assert.equal(normalizePreferences({}).showMeasurementTool, true);
  assert.equal(normalizePreferences({ showMeasurementTool: false }).showMeasurementTool, false);
  seed();
  const routes = [];
  const unsubscribe = StateStore.subscribe((changes, _state, notification) => {
    if (changes.preferences) routes.push(notification?.type ?? null);
  });
  try {
    const current = () => PreferencesManager.get();
    assert.equal(current().showMeasurementTool, true, 'a record without the field shows the ruler');
    PreferencesManager.set({ ...current(), showMeasurementTool: false });
    PreferencesManager.set({ ...current(), showMeasurementTool: true });
    assert.deepEqual(routes, ['viewport-controls-preference', 'viewport-controls-preference'],
      'toggling the ruler is visibility-only: no Editor render is requested');
    PreferencesManager.set({ ...current(), showMeasurementTool: false, labelFontSize: 20 });
    assert.equal(routes.at(-1), null, 'saved together with another preference it uses the normal route');
    assert.equal(current().showMeasurementTool, false);
    assert.equal(current().labelFontSize, 20);
  } finally { unsubscribe(); }
});

test('G2 add, rename, move and delete are each one Undo/Redo step; no-ops, refusals and other Load Plans write nothing', () => {
  seed();
  const notifications = [];
  const unsubscribe = StateStore.subscribe((_changes, _state, notification) => {
    if (notification) notifications.push(notification.type);
  });
  try {
    const depth = StateStore.undoDepth();
    const before = stored('A');
    const added = PackLibrary.addMeasurement('A', pair());
    assert.equal(added.ok, true);
    assert.equal(notifications.at(-1), 'pack-measurements', 'derived notification: the app refreshes only the overlay and list');
    assert.ok(stored('A').lastEdited > before.lastEdited, 'creating a measurement updates lastEdited');
    assert.equal(StateStore.undoDepth(), depth + 1, 'a completed creation is exactly one Undo step');
    assert.equal(stored('B').measurements, undefined, 'another Load Plan is untouched');

    const id = added.measurement.id;
    const renamed = PackLibrary.renameMeasurement('A', id, '  Door   gap ');
    assert.equal(renamed.ok, true);
    assert.equal(PackLibrary.getMeasurements('A')[0].label, 'Door gap');
    assert.equal(StateStore.undoDepth(), depth + 2, 'a rename is exactly one more step');
    const same = PackLibrary.renameMeasurement('A', id, 'Door gap');
    assert.equal(same.unchanged, true, 'an unchanged name writes nothing');
    assert.equal(PackLibrary.renameMeasurement('A', 'nope', 'x').reason, 'not-found');
    assert.equal(StateStore.undoDepth(), depth + 2, 'an unchanged or refused rename adds no step');

    const edited = stored('A').lastEdited;
    const cargoAnchor = M.buildCargoAnchor({ instanceId: 'inst-x', local: { x: 24, y: 2, z: 3 }, caseData: CASE });
    const moved = PackLibrary.moveMeasurementEndpoint('A', id, 'end', cargoAnchor);
    assert.equal(moved.ok, true);
    const record = PackLibrary.getMeasurements('A')[0];
    assert.equal(record.end.kind, 'cargo', 'the anchor kind may change when an endpoint is dragged onto another surface');
    assert.deepEqual(record.start, added.measurement.start, 'the other endpoint is untouched');
    assert.equal(record.label, 'Door gap');
    assert.equal(record.createdAt, added.measurement.createdAt);
    assert.ok(stored('A').lastEdited >= edited);
    assert.equal(notifications.at(-1), 'pack-measurements');
    assert.equal(StateStore.undoDepth(), depth + 3, 'a completed endpoint move is exactly one more step');
    const unchanged = PackLibrary.moveMeasurementEndpoint('A', id, 'end', cargoAnchor);
    assert.deepEqual([unchanged.ok, unchanged.unchanged], [true, true], 'the same content at the same place is no edit');
    assert.equal(PackLibrary.moveMeasurementEndpoint('A', id, 'end', { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } }).reason, 'invalid');
    assert.equal(PackLibrary.moveMeasurementEndpoint('A', 'nope', 'end', cargoAnchor).reason, 'not-found');
    assert.equal(PackLibrary.moveMeasurementEndpoint('missing', id, 'end', cargoAnchor).reason, 'pack-not-found');
    assert.equal(PackLibrary.getMeasurements('A')[0].end.kind, 'cargo', 'a refused move changes nothing');
    assert.equal(StateStore.undoDepth(), depth + 3, 'a no-op or refused move adds no step');

    assert.equal(PackLibrary.deleteMeasurement('A', 'nope').reason, 'not-found');
    assert.equal(StateStore.undoDepth(), depth + 3, 'a refused deletion adds no step');
    assert.equal(PackLibrary.deleteMeasurement('A', id).ok, true);
    assert.equal(PackLibrary.getMeasurements('A').length, 0);
    assert.equal(StateStore.undoDepth(), depth + 4, 'a deletion is exactly one step');
  } finally { unsubscribe(); }
});

test('the per-plan maximum of 100 is enforced on creation and a malformed record is refused', () => {
  seed();
  for (let i = 0; i < 100; i++) assert.equal(PackLibrary.addMeasurement('A', pair(i + 1)).ok, true);
  assert.equal(PackLibrary.getMeasurements('A').length, 100);
  const over = PackLibrary.addMeasurement('A', pair(101));
  assert.deepEqual([over.ok, over.reason], [false, 'limit']);
  assert.equal(PackLibrary.getMeasurements('A').length, 100, 'nothing is truncated or replaced');
  assert.equal(PackLibrary.addMeasurement('B', { start: null, end: ground(1, 1) }).reason, 'invalid');
  assert.equal(PackLibrary.addMeasurement('missing', pair()).reason, 'pack-not-found');
});

test("G2 Undo/Redo walks measurement and cargo edits in the order they were made, restoring each step's exact lastEdited", t => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => (clock += 10)); // every write gets its own, later time
  seed();
  const otherPlan = JSON.stringify(stored('B'));
  const first = PackLibrary.addMeasurement('A', pair());
  assert.equal(first.ok, true);
  const afterFirst = stored('A').lastEdited;
  PackLibrary.update('A', { notes: 'cargo edit' });
  const afterCargo = stored('A').lastEdited;
  const second = PackLibrary.addMeasurement('A', pair(2));
  assert.equal(second.ok, true);
  const afterSecond = stored('A').lastEdited;
  const both = JSON.stringify(PackLibrary.getMeasurements('A'));
  assert.equal(PackLibrary.getMeasurements('A').length, 2);
  assert.ok(123 < afterFirst && afterFirst < afterCargo && afterCargo < afterSecond, 'each edit has its own, later time');

  assert.equal(StateStore.undo(), true, 'the most recent edit, the second measurement, is undone first');
  assert.equal(stored('A').notes, 'cargo edit', 'the cargo edit made before it is still in place');
  assert.deepEqual(PackLibrary.getMeasurements('A').map(r => r.id), [first.measurement.id]);
  assert.equal(stored('A').lastEdited, afterCargo, 'Undo restores the time the Pack had in that state');
  assert.equal(StateStore.undo(), true, 'then the cargo edit');
  assert.equal(stored('A').notes, undefined);
  assert.deepEqual(PackLibrary.getMeasurements('A').map(r => r.id), [first.measurement.id], 'the earlier measurement is still there');
  assert.equal(stored('A').lastEdited, afterFirst);
  assert.equal(StateStore.undo(), true, 'then the first measurement');
  assert.equal(PackLibrary.getMeasurements('A').length, 0);
  assert.equal(stored('A').lastEdited, 123, 'back to the time the Pack was created with');
  assert.equal(StateStore.undo(), false, 'and nothing more');

  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').lastEdited, afterFirst);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').notes, 'cargo edit');
  assert.equal(stored('A').lastEdited, afterCargo);
  assert.equal(StateStore.redo(), true);
  assert.equal(stored('A').lastEdited, afterSecond);
  assert.equal(JSON.stringify(PackLibrary.getMeasurements('A')), both, 'Redo restores both records with identical ids, anchors, labels and timestamps');
  assert.equal(StateStore.redo(), false);
  assert.equal(JSON.stringify(stored('B')), otherPlan, 'the other Load Plan never changed');
});

test('deleting cargo leaves its measurement stored as Unresolved and undoing the delete resolves it again', () => {
  seed();
  const inst = PackLibrary.addInstance('A', CASE.id, { x: 60, y: 16, z: 0 });
  assert.ok(inst && inst.id, 'a real instance is placed');
  const anchor = M.buildCargoAnchor({ instanceId: inst.id, local: { x: 0, y: 16, z: 0 }, caseData: CASE });
  PackLibrary.addMeasurement('A', { start: anchor, end: ground(100, 0) });
  assert.equal(PackLibrary.resolveMeasurements('A')[0].status, 'valid');
  PackLibrary.removeInstances('A', [inst.id]);
  assert.equal(PackLibrary.getMeasurements('A').length, 1, 'editing cargo never deletes a measurement');
  const gone = PackLibrary.resolveMeasurements('A')[0];
  assert.deepEqual([gone.status, gone.reason, gone.distance], ['unresolved', 'cargo-missing', null]);
  assert.equal(StateStore.undo(), true);
  assert.equal(PackLibrary.getById('A').cases.some(c => c.id === inst.id), true, 'Undo restores the same instance ID');
  assert.equal(PackLibrary.resolveMeasurements('A')[0].status, 'valid', 'the anchor resolves again; nothing was relocated');
});

test('G3 duplicating a Load Plan re-targets cargo anchors to the copy and leaves the original alone', () => {
  seed();
  const inst = PackLibrary.addInstance('A', CASE.id, { x: 60, y: 16, z: 0 });
  const cargo = M.buildCargoAnchor({ instanceId: inst.id, local: { x: 3, y: 16, z: 1 }, caseData: CASE });
  const floor = M.buildFloorAnchor({ surface: 'main', point: { x: 120, y: 0, z: 0 } });
  PackLibrary.addMeasurement('A', { start: cargo, end: floor });
  PackLibrary.addMeasurement('A', pair(3));
  const original = JSON.stringify(PackLibrary.getMeasurements('A'));
  const copy = PackLibrary.duplicate('A');
  const copyIds = new Set(copy.cases.map(c => c.id));
  assert.equal(copyIds.has(inst.id), false, 'the copy has its own instance IDs');
  const [first, second] = PackLibrary.getMeasurements(copy.id);
  assert.equal(copyIds.has(first.start.instanceId), true, 'the cargo anchor follows its cargo into the copy');
  assert.deepEqual(first.start.local, cargo.local);
  assert.deepEqual(first.end, floor, 'floor anchors are carried unchanged');
  assert.deepEqual(second.start, pair(3).start, 'ground anchors are carried unchanged');
  assert.deepEqual(PackLibrary.resolveMeasurements(copy.id).map(r => r.status), ['valid', 'valid']);
  assert.equal(JSON.stringify(PackLibrary.getMeasurements('A')), original, 'the original plan keeps its anchors');
});

const importPayload = (measurements, cases = []) => ({
  pack: { id: 'incoming', title: 'Incoming', loadPlanNumber: 'LP-IMPORT', truck: { length: 240, width: 96, height: 100 }, cases, measurements },
  bundledCases: [],
});
const importedInstance = id => ({
  id, caseId: CASE.id, placement: 'packed',
  transform: { position: { x: 60, y: 16, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});

test('G3 importing a Load Plan remaps cargo anchors through the regenerated instance IDs', () => {
  seed([makePack('A')]);
  const anchor = M.buildCargoAnchor({ instanceId: 'old-1', local: { x: 1, y: 16, z: 2 }, caseData: CASE });
  const ghost = M.buildCargoAnchor({ instanceId: 'never-existed', local: { x: 0, y: 16, z: 0 }, caseData: CASE });
  const list = [
    M.createMeasurementRecord({ id: 'm1', start: anchor, end: ground(90, 0), now: 1 }),
    M.createMeasurementRecord({ id: 'm2', start: ghost, end: ground(95, 0), now: 1 }),
  ];
  const plan = PackLibrary.planPackImport(importPayload(list, [importedInstance('old-1')]));
  const newId = plan.pack.cases[0].id;
  assert.notEqual(newId, 'old-1', 'imports regenerate instance IDs');
  assert.equal(plan.pack.measurements[0].start.instanceId, newId, 'the anchor is re-targeted through the same old-to-new map');
  assert.deepEqual(plan.pack.measurements[0].start.local, anchor.local);
  assert.equal(plan.pack.measurements[1].start.instanceId, 'never-existed',
    'a structurally valid reference to missing cargo is retained, never guessed (it resolves as Unresolved)');
});

test('G4 a malformed, duplicated or over-limit measurement list rejects the whole Load Plan import', () => {
  seed([makePack('A')]);
  const valid = M.createMeasurementRecord({ id: 'ok', ...pair(), now: 1 });
  assert.doesNotThrow(() => PackLibrary.planPackImport(importPayload([valid])));
  const blocked = /Pack import blocked: the measurements are not valid/;
  assert.throws(() => PackLibrary.planPackImport(importPayload([{ ...valid, end: { kind: 'cargo' } }])), blocked);
  assert.throws(() => PackLibrary.planPackImport(importPayload([valid, valid])), /duplicate/);
  assert.throws(() => PackLibrary.planPackImport(importPayload('not a list')), blocked);
  const many = Array.from({ length: 101 }, (_, i) => M.createMeasurementRecord({ id: `m${i}`, ...pair(i + 1), now: 1 }));
  assert.throws(() => PackLibrary.planPackImport(importPayload(many)), /too many/);
  assert.equal(PackLibrary.planPackImport(importPayload(many.slice(0, 100))).pack.measurements.length, 100, 'exactly 100 is fine; nothing is truncated');
});

test('G4 export and backup project measurements explicitly and restore validation is strict', () => {
  const list = [
    M.createMeasurementRecord({ id: 'a', ...pair(), now: 1, label: 'Kept' }),
    M.createMeasurementRecord({ id: 'b', start: M.buildCargoAnchor({ instanceId: 'gone', local: { x: 24, y: 2, z: 3 }, caseData: CASE }), end: ground(5, 5), now: 1 }),
  ];
  const withList = makePack('A', { measurements: list });
  for (const project of [projectPortablePack, projectPortableWorkspacePack]) {
    assert.deepEqual(project(withList).measurements, M.normalizeMeasurements(list), `${project.name} carries measurements`);
    assert.equal(Object.hasOwn(project(makePack('A')), 'measurements'), false, 'a plan without any exports no empty field');
    const recovery = project(makePack('A', { measurements: [{ id: 'x' }] })).measurements;
    assert.equal(recovery[0].type, M.MEASUREMENT_TYPE_UNREADABLE, 'an unreadable record is exported, not dropped');
  }
  const graph = packs => ({ caseLibrary: [], packLibrary: packs, folderLibrary: [] });
  assert.doesNotThrow(() => validateWorkspaceGraph(graph([withList])), 'a dangling cargo reference is accepted (Unresolved)');
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { measurements: [{ ...list[0], start: { kind: 'x' } }] })])), /measurements/);
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { measurements: [list[0], list[0]] })])), /duplicate/);
  const many = Array.from({ length: 101 }, (_, i) => M.createMeasurementRecord({ id: `m${i}`, ...pair(i + 1), now: 1 }));
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { measurements: many })])), /too many/);
  assert.throws(() => validateWorkspaceGraph(graph([makePack('A', { measurements: 'nope' })])), /measurements/);
});

// ============================================================================
// Audit remediation: ambiguous source IDs (P1-1) and export self-preflight (P2-5)
// ============================================================================

const solidInstance = id => ({
  id, caseId: CASE.id, placement: 'packed', hidden: false, groupId: null,
  transform: { position: { x: 60, y: 16, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});
const onCargo = (instanceId, local = { x: 24, y: 2, z: 3 }) => M.buildCargoAnchor({ instanceId, local, caseData: CASE });
const snapshotOf = () => JSON.stringify([StateStore.get('packLibrary'), StateStore.get('caseLibrary')]);
// A fresh destination workspace (same Case library, no Load Plans) so imports never collide on business identity.
const emptyDestination = () => StateStore.init({
  currentScreen: 'packs', currentPackId: null, caseLibrary: [CASE], folderLibrary: [], preferences: {}, packLibrary: [],
});

test('P1-1 a source cargo ID shared by several items rejects the whole import before anything is generated or changed', () => {
  seed([makePack('A')]);
  const list = [
    M.createMeasurementRecord({ id: 'm1', start: onCargo('duplicate'), end: ground(90, 0), now: 1 }),
    M.createMeasurementRecord({ id: 'm2', start: onCargo('unique'), end: ground(95, 0), now: 1 }),
  ];
  const ambiguous = importPayload(list, [solidInstance('duplicate'), solidInstance('duplicate'), solidInstance('unique')]);
  const before = snapshotOf();
  const refusal = /Pack import blocked: 1 cargo instance ID\(s\) are used by more than one item \("duplicate"\)/;
  assert.throws(() => PackLibrary.validatePackImportPayload(ambiguous), refusal, 'the shared structural preflight refuses it');
  assert.throws(() => PackLibrary.planPackImport(ambiguous), refusal);
  assert.throws(() => PackLibrary.importPackPayload(ambiguous), refusal);
  assert.equal(snapshotOf(), before, 'atomic: no Load Plan or Case was added');
  // Two copies of the same plan are also refused even when no measurement points at the shared ID.
  assert.throws(() => PackLibrary.planPackImport(importPayload([], [solidInstance('x'), solidInstance('x')])), /more than one item/);
  // Valid source IDs still remap exactly through the explicit old-to-new map.
  const good = PackLibrary.planPackImport(importPayload(list, [solidInstance('duplicate'), solidInstance('other'), solidInstance('unique')]));
  const byOld = new Map(['duplicate', 'other', 'unique'].map((old, i) => [old, good.pack.cases[i].id]));
  assert.equal(good.pack.measurements[0].start.instanceId, byOld.get('duplicate'));
  assert.equal(good.pack.measurements[1].start.instanceId, byOld.get('unique'));
  assert.equal(new Set(byOld.values()).size, 3);
});

test('P1-1 batch import and export share the same ambiguity gate', () => {
  const damaged = makePack('D', {
    cases: [solidInstance('dup'), solidInstance('dup'), solidInstance('solo')],
    measurements: [M.createMeasurementRecord({ id: 'm', start: onCargo('dup'), end: ground(5, 5), now: 1 })],
  });
  seed([damaged, makePack('E', { cases: [solidInstance('only')] })]);
  const stored = PackLibrary.getById('D');
  // The diagnostic builder still serializes it (that contract is unchanged) ...
  const batch = ImportExport.buildPackBatchExportJSON([stored, PackLibrary.getById('E')]);
  const entries = ImportExport.parsePackBatchImportJSON(batch);
  assert.equal(entries.length, 2);
  // ... but neither batch import nor the user-facing export accepts it.
  const before = snapshotOf();
  assert.throws(() => ImportExport.buildRestorablePackBatchExportJSON([stored, PackLibrary.getById('E')]),
    error => error.code === 'EXPORT_PREFLIGHT_FAILED' && /more than one item/.test(error.message));
  assert.throws(() => ImportExport.buildRestorablePackExportJSON(stored),
    error => error.code === 'EXPORT_PREFLIGHT_FAILED' && /more than one item/.test(error.message));
  assert.equal(snapshotOf(), before, 'a refused export never changes the workspace');
  emptyDestination();
  const emptied = snapshotOf();
  assert.throws(() => PackLibrary.importPackPayload(entries[0]), /more than one item/);
  assert.equal(snapshotOf(), emptied, 'a refused import adds nothing');
  assert.doesNotThrow(() => PackLibrary.planPackImport(entries[1]), 'a clean entry of the same batch is unaffected');
});

test('P1-1 duplicating a damaged plan never guesses an ambiguous anchor and still re-targets the unambiguous ones', () => {
  seed([makePack('D', {
    cases: [solidInstance('dup'), solidInstance('dup'), solidInstance('solo')],
    measurements: [
      M.createMeasurementRecord({ id: 'ambiguous', start: onCargo('dup'), end: ground(5, 5), now: 1 }),
      M.createMeasurementRecord({ id: 'clear', start: onCargo('solo'), end: ground(6, 6), now: 1 }),
    ],
  })]);
  const original = JSON.stringify(PackLibrary.getById('D').measurements);
  const copy = PackLibrary.duplicate('D');
  const ids = new Set(copy.cases.map(c => c.id));
  const [ambiguous, clear] = PackLibrary.getMeasurements(copy.id);
  assert.equal(ambiguous.start.instanceId, 'dup', 'the ambiguous anchor is left exactly as it was');
  assert.equal(ids.has('dup'), false, 'so it points at nothing in the copy');
  assert.equal(ids.has(clear.start.instanceId), true, 'the unambiguous anchor follows its cargo');
  assert.deepEqual(PackLibrary.resolveMeasurements(copy.id).map(r => r.status), ['unresolved', 'valid']);
  assert.equal(JSON.stringify(PackLibrary.getById('D').measurements), original, 'the source plan is untouched');
});

test('P2-5 export self-preflight applies the importer\'s measurement rules to the exact artifact', () => {
  const many = Array.from({ length: 101 }, (_, i) => M.createMeasurementRecord({ id: `m${i}`, ...pair(i + 1), now: 1 }));
  const fine = [
    M.createMeasurementRecord({ id: 'a', ...pair(), now: 1, label: 'Kept' }),
    M.createMeasurementRecord({ id: 'b', start: onCargo('gone'), end: ground(5, 5), now: 1 }),
  ];
  const unreadable = { id: 'x', type: 'point-to-point', start: { kind: 'mystery' } };
  seed([
    makePack('OVER', { cases: [solidInstance('o1')], measurements: many }),
    makePack('FINE', { cases: [solidInstance('f1')], measurements: fine }),
    makePack('ODD', { cases: [solidInstance('d1')], measurements: [unreadable] }),
  ]);
  const over = PackLibrary.getById('OVER');
  const overBefore = JSON.stringify(over);
  const refused = error => error.code === 'EXPORT_PREFLIGHT_FAILED' &&
    /would not pass import/.test(error.message) && /measurements are not valid \(too many measurements \(101; maximum 100\)\)/.test(error.message);
  assert.throws(() => ImportExport.buildRestorablePackExportJSON(over), refused, 'single export refuses an over-cap collection');
  assert.throws(() => ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('FINE'), over]), refused, 'batch export refuses it too');
  assert.equal(JSON.stringify(PackLibrary.getById('OVER')), overBefore, 'nothing is truncated, repaired or rewritten in the saved plan');
  assert.equal(PackLibrary.getById('OVER'), over, 'and it is the very same stored object');

  // The artifact itself is what is checked: a malformed measurement in the serialized file is refused.
  const json = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('FINE'));
  const tampered = JSON.parse(json);
  tampered.data.pack.measurements = [{ ...fine[0], end: { kind: 'cargo' } }];
  assert.throws(() => ImportExport.assertRestorablePackExportJSON(JSON.stringify(tampered)), /measurements are not valid/);
  tampered.data.pack.measurements = [fine[0], fine[0]];
  assert.throws(() => ImportExport.assertRestorablePackExportJSON(JSON.stringify(tampered)), /duplicate measurement id/);

  // Valid exports round-trip: exactly 100 is fine, and unreadable stored data travels verbatim.
  assert.doesNotThrow(() => ImportExport.buildRestorablePackExportJSON({ ...PackLibrary.getById('FINE'), measurements: many.slice(0, 100) }));
  const oddJson = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('ODD'));
  const batchJson = ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('FINE'), PackLibrary.getById('ODD')]);
  emptyDestination();
  const roundTrip = payload => PackLibrary.planPackImport(ImportExport.parsePackImportJSON(payload)).pack.measurements;
  assert.deepEqual(roundTrip(json).map(m => m.id), ['a', 'b']);
  const odd = roundTrip(oddJson);
  assert.equal(odd[0].type, M.MEASUREMENT_TYPE_UNREADABLE);
  assert.deepEqual(odd[0].original, unreadable, 'a record the app could not read is exported and restored untouched');
  const batch = ImportExport.parsePackBatchImportJSON(batchJson);
  assert.deepEqual(batch.map(entry => entry.pack.measurements.length), [2, 1]);
});

test('P1-2 through the real zone calculation: a Front Overhang change flags a wall point, and restoring it makes the point Valid again', () => {
  const truck = { length: 600, width: 100, height: 90, shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 30 } };
  seed([makePack('F', { truck })]);
  const withConfig = shapeConfig => StateStore.set({
    packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'F' ? { ...p, truck: { ...p.truck, shapeConfig } } : p)),
  }, { skipHistory: true });
  const pack = () => PackLibrary.getById('F');
  const zones = PackLibrary.getMeasurementZones(pack());
  assert.equal(zones.length, 2, 'the over-cab deck is its own usable zone');
  // The front wall of the Front Overhang truck stands at x = 700; the point sits on it.
  const front = M.buildSpaceAnchor({ surface: 'wall-front', point: { x: 700, y: 60, z: 0 }, truck: pack().truck, zones });
  const added = PackLibrary.addMeasurement('F', { start: front, end: ground(650, 0) });
  assert.equal(added.ok, true);
  const status = () => PackLibrary.resolveMeasurements('F')[0];
  assert.equal(status().status, 'valid');
  assert.ok(status().distance > 0);

  withConfig({ bonusLength: 150, bonusHeight: 30 }); // length, width, height and shape mode are unchanged
  assert.deepEqual([pack().truck.length, pack().truck.width, pack().truck.height, pack().truck.shapeMode], [600, 100, 90, 'frontBonus']);
  const review = status();
  assert.deepEqual([review.status, review.reason, review.distance], ['needs-review', 'truck-changed', null], 'no stale distance for a wall that moved');
  assert.deepEqual(PackLibrary.getMeasurements('F')[0].start, added.measurement.start, 'the anchor is kept exactly: it is never moved to the new wall');

  withConfig({ bonusLength: 100, bonusHeight: 30 });
  assert.equal(status().status, 'valid', 'restoring the original configuration returns the measurement to Valid');
  // An equivalent configuration (an explicit value equal to the default) is the same truck.
  withConfig({ bonusLength: 100, bonusHeight: 30, someUnrelatedKey: true });
  assert.equal(status().status, 'valid', 'only the effective geometry matters, not unrelated keys');
});

// ============================================================================
// Second audit: cargo instance IDs are unique within a Load Plan (owner-approved strengthening of the
// data contract, superseding the earlier EXPORT-C-LP-3 expectation that Load Plan import regenerated
// duplicate source IDs). Every identity boundary: creation, duplication, import, backup, restore.
// ============================================================================

const idsOf = pack => pack.cases.map(c => c.id);
const noDuplicates = ids => new Set(ids.map(id => id.trim())).size === ids.length;
const refusal = /Pack import blocked: \d+ cargo instance ID\(s\) are used by more than one item/;

test('ID-1 import refuses a repeated cargo ID whether or not any measurement references it', () => {
  seed([makePack('A')]);
  const referencing = M.createMeasurementRecord({ id: 'ref', start: onCargo('dup'), end: ground(90, 0), now: 1 });
  const unrelated = M.createMeasurementRecord({ id: 'other', start: onCargo('solo'), end: ground(80, 0), now: 1 });
  const groundOnly = M.createMeasurementRecord({ id: 'flat', ...pair(), now: 1 });
  const scenarios = [
    ['no measurements at all', [], ['dup', 'dup']],
    ['a measurement that references the repeated ID', [referencing], ['dup', 'dup', 'solo']],
    ['only measurements on other cargo', [unrelated], ['dup', 'dup', 'solo']],
    ['only ground measurements', [groundOnly], ['dup', 'dup']],
    ['IDs that differ only by surrounding space', [], ['dup', ' dup ']],
    ['an ID used three times', [referencing], ['dup', 'dup', 'dup']],
    ['two different IDs each used twice', [unrelated], ['a', 'b', 'a', 'b']],
  ];
  for (const [name, measurements, ids] of scenarios) {
    const payload = importPayload(measurements, ids.map(solidInstance));
    const before = snapshotOf();
    for (const attempt of [PackLibrary.validatePackImportPayload, PackLibrary.planPackImport, PackLibrary.importPackPayload]) {
      assert.throws(() => attempt(payload), refusal, `${name} (${attempt.name})`);
    }
    assert.equal(snapshotOf(), before, `${name}: atomic, nothing was added or changed`);
  }
  // Control: the very same measurements over unique IDs import, and the old-to-new map is exact.
  const unique = PackLibrary.planPackImport(importPayload([referencing, unrelated, groundOnly], ['dup', 'second', 'solo'].map(solidInstance)));
  assert.ok(noDuplicates(idsOf(unique.pack)));
  const byOld = new Map(['dup', 'second', 'solo'].map((old, i) => [old, unique.pack.cases[i].id]));
  assert.equal(unique.pack.measurements[0].start.instanceId, byOld.get('dup'));
  assert.equal(unique.pack.measurements[1].start.instanceId, byOld.get('solo'));
  assert.equal(unique.pack.measurements[2].start.kind, 'space');
  assert.deepEqual(unique.pack.measurements.map(m => m.id), ['ref', 'other', 'flat']);
});

test('ID-1 the exported Load Plan file and the batch file are refused by the real parsers and the export preflight', () => {
  const clean = n => makePack(`P${n}`, {
    loadPlanNumber: `LP-P${n}`, cases: [solidInstance(`a${n}`), solidInstance(`b${n}`)],
    measurements: [M.createMeasurementRecord({ id: 'm', start: onCargo(`a${n}`), end: ground(5, 5), now: 1 })],
  });
  seed([clean(1), clean(2)]);
  const single = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('P1'));
  const batch = ImportExport.buildRestorablePackBatchExportJSON([PackLibrary.getById('P1'), PackLibrary.getById('P2')]);
  const repeat = (json, packOf) => {
    const file = JSON.parse(json);
    const pack = packOf(file);
    pack.cases[1].id = pack.cases[0].id;
    return JSON.stringify(file);
  };

  // Single file: the artifact itself is what the preflight and the importer judge.
  const damagedSingle = repeat(single, file => file.data.pack);
  assert.throws(() => ImportExport.assertRestorablePackExportJSON(damagedSingle), /would not pass import.*more than one item/);
  emptyDestination();
  const emptied = snapshotOf();
  assert.throws(() => PackLibrary.importPackPayload(ImportExport.parsePackImportJSON(damagedSingle)), refusal);
  assert.equal(snapshotOf(), emptied);
  assert.equal(PackLibrary.importPackPayload(ImportExport.parsePackImportJSON(single)).cases.length, 2, 'the intact file imports');

  // Batch file: the preflight refuses it as a whole; the import dialog's per-Load-Plan boundary keeps the clean entry.
  const damagedBatch = repeat(batch, file => file.data.packs[0].pack || file.data.packs[0]);
  assert.throws(() => ImportExport.assertRestorablePackBatchExportJSON(damagedBatch, 2), /would not pass import.*more than one item/);
  emptyDestination();
  const entries = ImportExport.parsePackBatchImportJSON(damagedBatch);
  assert.throws(() => PackLibrary.importPackPayload(entries[0]), refusal, 'the damaged entry is refused');
  assert.equal(StateStore.get('packLibrary').length, 0, 'and adds nothing');
  assert.equal(PackLibrary.importPackPayload(entries[1]).cases.length, 2, 'the clean entry of the same file still imports');
  assert.equal(StateStore.get('packLibrary').length, 1);
});

test('ID-1 Workspace Backup and Active Workspace Backup refuse a repeated cargo ID in every shape', () => {
  const plan = (id, ids, measurements) => makePack(id, { loadPlanNumber: `LP-${id}`, cases: ids.map(solidInstance), measurements });
  const referencing = [M.createMeasurementRecord({ id: 'r', start: onCargo('x'), end: ground(5, 5), now: 1 })];
  const unrelated = [M.createMeasurementRecord({ id: 'u', start: onCargo('y'), end: ground(5, 5), now: 1 })];
  seed([plan('A', ['x', 'y'], referencing), plan('B', ['z'], undefined)]);
  const app = ImportExport.buildAppExportJSON();
  const workspace = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  // Control: intact backups parse and carry the measurement exactly.
  assert.deepEqual(ImportExport.parseAppImportJSON(app).packLibrary[0].measurements.map(m => m.id), ['r']);
  assert.deepEqual(ImportExport.parseWorkspaceImportJSON(workspace).packLibrary[0].measurements.map(m => m.id), ['r']);

  const tamper = (json, edit) => { const file = JSON.parse(json); edit(file.data.packLibrary); return JSON.stringify(file); };
  const damage = [
    ['repeated inside one plan, referenced by a measurement', p => { p[0].cases[1].id = 'x'; }],
    ['repeated inside one plan, only unrelated measurements', p => { p[0].cases[1].id = 'x'; p[0].measurements = unrelated; }],
    ['repeated inside one plan, no measurements', p => { p[0].cases[1].id = 'x'; delete p[0].measurements; }],
    ['differing only by surrounding space', p => { p[0].cases[1].id = ' x '; }],
    ['shared by two Load Plans', p => { p[1].cases[0].id = 'x'; }],
  ];
  for (const [name, edit] of damage) {
    assert.throws(() => ImportExport.parseAppImportJSON(tamper(app, edit)), /duplicate id/i, `Active Workspace Backup: ${name}`);
    assert.throws(() => ImportExport.parseWorkspaceImportJSON(tamper(workspace, edit)), /duplicate id/i, `Workspace Backup: ${name}`);
  }
});

test('ID-1 duplication and creation mint IDs that no Load Plan in the workspace already uses', () => {
  // A generator that keeps handing back IDs already in use: creation must skip them.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const realRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const stubUuid = queue => {
    const pending = [...queue];
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true, writable: true,
      value: { randomUUID: () => (pending.length ? pending.shift() : realRandomUUID()), getRandomValues: array => array },
    });
  };
  try {
    seed([makePack('A', { cases: [solidInstance('taken-1'), solidInstance('taken-2')] }), makePack('B', { cases: [solidInstance('elsewhere')] })]);
    const allIds = () => StateStore.get('packLibrary').flatMap(idsOf);

    stubUuid(['taken-1', 'elsewhere', 'taken-2', 'fresh-1']);
    const added = PackLibrary.addInstance('A', CASE.id, { x: 120, y: 16, z: 0 });
    assert.equal(added.id, 'fresh-1', 'an ID used by this plan or by any other plan is never reissued');

    stubUuid(['taken-1', 'fresh-2', 'fresh-2', 'fresh-3']);
    const staged = PackLibrary.addInstancesToStaging('A', CASE.id, 2);
    assert.equal(staged.reason, 'ok');
    assert.deepEqual(staged.createdInstanceIds, ['fresh-2', 'fresh-3'], 'the same generator value is not reused within one operation either');

    stubUuid(['taken-2', 'elsewhere', 'fresh-4']);
    const duplicated = PackLibrary.duplicateInstancesSafely('A', [PackLibrary.getById('A').cases[0]]);
    assert.deepEqual(duplicated.newIds, ['fresh-4'], 'duplicating cargo mints a unique ID too');

    stubUuid(['taken-1', 'fresh-5', 'fresh-6', 'fresh-7', 'fresh-8', 'fresh-9', 'fresh-10', 'fresh-11', 'fresh-12']);
    const copy = PackLibrary.duplicate('A');
    assert.ok(copy.cases.every(c => !['taken-1', 'taken-2', 'elsewhere', 'fresh-1'].includes(c.id)), 'a duplicated Load Plan never reuses a source or workspace ID');
    assert.ok(noDuplicates(idsOf(copy)));
    assert.ok(noDuplicates(allIds()), 'every cargo ID in the workspace is unique after all of it');

    // An import mints against the workspace as well.
    stubUuid(['elsewhere', 'taken-1', 'fresh-20', 'fresh-21']);
    const imported = PackLibrary.planPackImport(importPayload([], ['s1', 's2'].map(solidInstance)));
    assert.deepEqual(idsOf(imported.pack), ['fresh-20', 'fresh-21']);

    // A generator that can only repeat itself fails loudly rather than reusing an ID.
    stubUuid(Array.from({ length: 2000 }, () => 'taken-1'));
    assert.throws(() => PackLibrary.addInstance('A', CASE.id, { x: 200, y: 16, z: 0 }), /unique cargo instance ID/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
});

test('ID-1 duplicating an intact Load Plan gives every cargo item an ID of its own and follows each measurement', () => {
  const plan = makePack('A', {
    cases: [solidInstance('c1'), solidInstance('c2'), solidInstance('c3')],
    measurements: ['c1', 'c2', 'c3'].map((id, n) => M.createMeasurementRecord({ id: `m${n}`, start: onCargo(id), end: ground(5 + n, 5), now: 1 })),
  });
  seed([plan]);
  const copy = PackLibrary.duplicate('A');
  assert.ok(noDuplicates(idsOf(copy)));
  assert.equal(idsOf(copy).some(id => ['c1', 'c2', 'c3'].includes(id)), false);
  copy.measurements.forEach((m, n) => assert.equal(m.start.instanceId, copy.cases[n].id, `measurement ${n} follows its own cargo item`));
  assert.deepEqual(PackLibrary.resolveMeasurements(copy.id).map(r => r.status), ['valid', 'valid', 'valid']);
});

test('ID-1 a stored plan that already holds a repeated ID is kept as it is and never resolves a measurement to one of the items', () => {
  const raw = makePack('D', {
    cases: [solidInstance('dup'), solidInstance('dup'), solidInstance('solo')],
    measurements: [
      M.createMeasurementRecord({ id: 'ambiguous', start: onCargo('dup'), end: ground(5, 5), now: 1 }),
      M.createMeasurementRecord({ id: 'clear', start: onCargo('solo'), end: ground(6, 6), now: 1 }),
      M.createMeasurementRecord({ id: 'flat', ...pair(), now: 1 }),
    ],
  });
  const loaded = normalizePack(raw);
  assert.deepEqual(idsOf(loaded), ['dup', 'dup', 'solo'], 'loading never rewrites or drops the cargo to satisfy normalization');
  assert.deepEqual(loaded.measurements.map(m => m.id), ['ambiguous', 'clear', 'flat']);
  seed([loaded]);
  const before = JSON.stringify(PackLibrary.getById('D'));
  const [ambiguous, clear, flat] = PackLibrary.resolveMeasurements('D');
  assert.deepEqual([ambiguous.status, ambiguous.reason, ambiguous.distance], ['unresolved', 'cargo-ambiguous', null], 'never attached to either duplicate');
  assert.equal(clear.status, 'valid');
  assert.equal(flat.status, 'valid');
  assert.equal(JSON.stringify(PackLibrary.getById('D')), before, 'resolving changes nothing');
  assert.equal(PackLibrary.addMeasurement('D', pair(4)).ok, true, 'the plan stays editable');
  assert.deepEqual(idsOf(PackLibrary.getById('D')), ['dup', 'dup', 'solo']);
  assert.deepEqual(PackLibrary.getMeasurements('D').slice(0, 3).map(m => m.start), loaded.measurements.map(m => m.start), 'the original anchors are retained exactly');
});

// ============================================================================
// Second audit: truck-anchor provenance, judged only by the effective geometry
// ============================================================================

test('P1-2 provenance through the real zone calculation: deck height, Wheel Wells, equivalence, older records, restoration', () => {
  const overhang = (bonusLength, bonusHeight, extra = {}) => ({
    length: 600, width: 100, height: 90, shapeMode: 'frontBonus', shapeConfig: { bonusLength, bonusHeight, ...extra },
  });
  const wells = wellHeight => ({ length: 600, width: 100, height: 90, shapeMode: 'wheelWells', shapeConfig: { wellHeight, wellWidth: 20, wellLength: 100, wellOffsetFromRear: 100 } });
  const rect = { length: 600, width: 100, height: 90, shapeMode: 'rect', shapeConfig: {} };
  seed([makePack('T', { truck: overhang(100, 30) })]);
  const setTruck = truck => StateStore.set({
    packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'T' ? { ...p, truck } : p)),
  }, { skipHistory: true });
  const zonesNow = () => PackLibrary.getMeasurementZones(PackLibrary.getById('T'));
  const anchorOn = (surface, point) => M.buildSpaceAnchor({ surface, point, truck: PackLibrary.getById('T').truck, zones: zonesNow() });
  const statusOf = (...anchors) => {
    const ids = anchors.map(anchor => PackLibrary.addMeasurement('T', { start: anchor, end: ground(650, 0) }).measurement.id);
    const out = PackLibrary.resolveMeasurements('T').filter(r => ids.includes(r.id)).map(r => r.status + (r.reason ? `:${r.reason}` : ''));
    ids.forEach(id => PackLibrary.deleteMeasurement('T', id));
    return out.length === 1 ? out[0] : out;
  };

  // Standard rectangular truck record: the real calculation's rect box is what the core rebuilds from dimensions.
  for (const dims of [{ length: 600, width: 100, height: 90 }, { length: 636, width: 102, height: 98 }, { length: 12.5, width: 3.25, height: 7 }]) {
    const real = M.getTruckSignature({ ...dims, shapeMode: 'rect' }, PackLibrary.getMeasurementZones({ truck: { ...dims, shapeMode: 'rect', shapeConfig: {} } })).zones;
    assert.deepEqual(M.rectangularTruckZones(dims), real, `rebuilt rect geometry equals the real zone calculation for ${JSON.stringify(dims)}`);
  }
  assert.equal(M.rectangularTruckZones({ length: 0, width: 100, height: 90 }), null);

  // Front Overhang: length AND deck height are real geometry.
  const front = anchorOn('wall-front', { x: 700, y: 60, z: 0 });
  assert.equal(statusOf(front), 'valid');
  setTruck(overhang(100, 70)); // raised deck now swallows the point at y = 60
  assert.equal(statusOf(front), 'needs-review:truck-changed', 'a changed deck height is flagged although L, W, H and the shape mode are unchanged');
  setTruck(overhang(150, 30));
  assert.equal(statusOf(front), 'needs-review:truck-changed', 'and so is a longer overhang');
  setTruck(overhang(100, 30));
  assert.equal(statusOf(front), 'valid', 'restoring the original geometry restores Valid');
  setTruck(overhang(100, 30, { bonusWidth: 55, anything: 'else' }));
  assert.equal(statusOf(front), 'valid', 'settings that do not change the geometry are the same truck');

  // Wheel Wells.
  setTruck(wells(30));
  const ceiling = anchorOn('ceiling', { x: 300, y: 90, z: 0 });
  assert.equal(statusOf(ceiling), 'valid');
  setTruck(wells(40));
  assert.equal(statusOf(ceiling), 'needs-review:truck-changed');
  setTruck(wells(30));
  assert.equal(statusOf(ceiling), 'valid');

  // Equivalent physical configurations: an overhang of length 0 is a standard truck, in either direction.
  setTruck(rect);
  const rectCeiling = anchorOn('ceiling', { x: 300, y: 90, z: 0 });
  assert.equal(statusOf(rectCeiling), 'valid');
  setTruck(overhang(0, 30));
  assert.equal(statusOf(rectCeiling), 'valid', 'a Front Overhang of length 0 is the same physical truck as a standard one');
  setTruck(overhang(100, 30));
  assert.equal(statusOf(rectCeiling), 'needs-review:truck-changed', 'a real overhang is not');
  setTruck(rect);
  assert.equal(statusOf(rectCeiling), 'valid');

  // Older records (saved before the zones were remembered): provable only for a standard rectangular truck.
  const legacyOf = anchor => { const old = JSON.parse(JSON.stringify(anchor)); delete old.truck.zones; return old; };
  setTruck(overhang(100, 30));
  const legacyFront = legacyOf(anchorOn('wall-front', { x: 700, y: 60, z: 0 }));
  setTruck(rect);
  const legacyRect = legacyOf(anchorOn('wall-right', { x: 300, y: 40, z: -50 }));
  const before = [PackLibrary.addMeasurement('T', { start: legacyFront, end: ground(1, 1) }), PackLibrary.addMeasurement('T', { start: legacyRect, end: ground(2, 2) })];
  const snapshot = JSON.stringify(PackLibrary.getMeasurements('T'));
  assert.deepEqual(PackLibrary.resolveMeasurements('T').map(r => r.status + (r.reason ? `:${r.reason}` : '')),
    ['needs-review:truck-unverified', 'valid'], 'with the truck unchanged, the Front Overhang record is still unprovable and the rectangular one is Valid');
  setTruck(overhang(100, 30));
  assert.equal(PackLibrary.resolveMeasurements('T')[0].status, 'needs-review', 'the same overhang it was placed on is still not provable');
  assert.equal(PackLibrary.resolveMeasurements('T')[1].reason, 'truck-changed');
  setTruck(rect);
  assert.equal(JSON.stringify(PackLibrary.getMeasurements('T')), snapshot, 'neither record was rewritten, relocated or given invented geometry');
  assert.equal(before.every(r => r.ok), true);
});


// ============================================================================
// Final correction 1 through the real zone calculation: only real faces are measurable
// ============================================================================

test('P1-3 through the real zone calculation: the Front Overhang cab void has no wall, the real faces do', () => {
  const truck = { length: 600, width: 100, height: 90, shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 30 } };
  seed([makePack('V', { truck })]);
  const pack = () => PackLibrary.getById('V');
  const setTruck = next => StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'V' ? { ...p, truck: next } : p)) }, { skipHistory: true });
  const faces = () => PackLibrary.getMeasurementShellFaces(pack());
  const zones = () => PackLibrary.getMeasurementZones(pack());
  const build = (surface, x, y, z) => M.buildSpaceAnchor({ surface, point: { x, y, z }, truck: pack().truck, zones: zones() });

  assert.equal(build('wall-front', 700, 10, 0), null, 'the confirmed defect: (700, 10, 0) is in the cab void');
  assert.equal(M.pointOnTruckShell('wall-front', { x: 700, y: 10, z: 0 }, faces()), false);
  const real = build('wall-front', 700, 60, 0);
  assert.ok(real, 'the real front wall above the deck');
  const added = PackLibrary.addMeasurement('V', { start: real, end: ground(650, 0) });
  assert.equal(added.ok, true);
  assert.equal(PackLibrary.resolveMeasurements('V')[0].status, 'valid');

  // The same wall with the deck raised past the point: the surface it was on no longer exists there.
  setTruck({ ...truck, shapeConfig: { bonusLength: 100, bonusHeight: 70 } });
  assert.equal(M.pointOnTruckShell('wall-front', { x: 700, y: 60, z: 0 }, faces()), false, 'now under the deck');
  assert.deepEqual([PackLibrary.resolveMeasurements('V')[0].status, PackLibrary.resolveMeasurements('V')[0].reason], ['needs-review', 'truck-changed']);
  setTruck(truck);
  assert.equal(PackLibrary.resolveMeasurements('V')[0].status, 'valid', 'restored geometry, valid again');

  // Equivalent physical trucks: an overhang of length 0 draws exactly the standard truck's faces.
  setTruck({ ...truck, shapeConfig: { bonusLength: 0, bonusHeight: 30 } });
  const flat = faces().map(f => `${f.surface}|${f.min}|${f.max}`).sort().join(';');
  setTruck({ length: 600, width: 100, height: 90, shapeMode: 'rect', shapeConfig: {} });
  assert.equal(faces().map(f => `${f.surface}|${f.min}|${f.max}`).sort().join(';'), flat);
  assert.equal(faces().length, 5);

  // Wheel Wells draw the full outer box; their blocked bodies are guide volumes, not walls.
  setTruck({ length: 600, width: 100, height: 90, shapeMode: 'wheelWells', shapeConfig: { wellHeight: 30, wellWidth: 20, wellLength: 100, wellOffsetFromRear: 100 } });
  assert.equal(faces().length, 5);
  assert.ok(build('wall-left', 150, 10, 50), 'the side wall behind a wheel well is the one the Editor draws');
  assert.equal(build('wall-front', 100, 60, 0), null, 'a wheel well\'s zone boundary is not a wall');
});

// ============================================================================
// Final correction 2: cargo identity survives normalization
// ============================================================================

const SPACED = ' cargo ';
const caseMap = new Map([[CASE.id, CASE]]);
const spacedPlan = (extra = {}) => makePack('S', {
  loadPlanNumber: 'LP-S', cases: [solidInstance(SPACED)],
  measurements: [M.createMeasurementRecord({ id: 'm', start: onCargo(SPACED), end: ground(5, 5), now: 1 })], ...extra,
});
const statusOfPack = id => PackLibrary.resolveMeasurements(id).map(r => `${r.status}${r.reason ? `:${r.reason}` : ''}`);

test('ID-2 normalization canonicalizes a cargo ID and carries its measurement anchors with it', () => {
  const raw = spacedPlan();
  seed([raw]);
  assert.deepEqual(statusOfPack('S'), ['valid'], 'control: before normalization both spell the same identity');
  const normalized = normalizePack(raw, caseMap, 1);
  assert.equal(normalized.cases[0].id, 'cargo', 'the cargo ID is canonical (trimmed)');
  assert.equal(normalized.measurements[0].start.instanceId, 'cargo', 'and the anchor follows it through an explicit map');
  assert.deepEqual(normalized.measurements[0].start.local, raw.measurements[0].start.local, 'nothing else about the anchor changes');
  assert.deepEqual(normalized.measurements[0].start.signature, raw.measurements[0].start.signature);
  assert.equal(normalized.measurements[0].end.kind, 'space');
  seed([normalized]);
  assert.deepEqual(statusOfPack('S'), ['valid'], 'the measurement still resolves after normalization');
  // The raw input was not mutated.
  assert.equal(raw.cases[0].id, SPACED);
  assert.equal(raw.measurements[0].start.instanceId, SPACED);
});

test('ID-2 normalization is idempotent: repeated passes change nothing and rewrite no identity', () => {
  const once = normalizePack(spacedPlan(), caseMap, 1);
  const twice = normalizePack(once, caseMap, 1);
  const thrice = normalizePack(twice, caseMap, 1);
  assert.deepEqual(twice, once);
  assert.deepEqual(thrice, once);
  assert.equal(thrice.measurements, twice.measurements, 'an unchanged list is returned as is, not rebuilt');
  assert.equal(twice.cases[0].id, 'cargo');
  // App-level normalization too (what restore runs), twice.
  const state = { caseLibrary: [CASE], packLibrary: [spacedPlan()], folderLibrary: [], preferences: {} };
  const first = normalizeAppData(state);
  const second = normalizeAppData({ ...first });
  assert.deepEqual(second.packLibrary[0].cases, first.packLibrary[0].cases);
  assert.deepEqual(second.packLibrary[0].measurements, first.packLibrary[0].measurements);
});

test('ID-2 identities that need no canonicalization are left exactly as they are', () => {
  const clean = makePack('C', {
    loadPlanNumber: 'LP-C', cases: [solidInstance('a'), solidInstance('b')],
    measurements: [M.createMeasurementRecord({ id: 'm', start: onCargo('a'), end: ground(5, 5), now: 1 }),
      M.createMeasurementRecord({ id: 'n', start: onCargo('b'), end: ground(6, 6), now: 1 })],
  });
  const normalized = normalizePack(clean, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['a', 'b']);
  assert.deepEqual(normalized.measurements.map(m => m.start.instanceId), ['a', 'b']);
  assert.equal(normalized.measurements, M.normalizeMeasurements(clean.measurements), 'the very same normalized list: nothing was rebuilt');
  // groupId refers to groups, not cargo: untouched by instance canonicalization.
  const grouped = normalizePack({ ...spacedPlan(), cases: [{ ...solidInstance(SPACED), groupId: ' g-1 ' }] }, caseMap, 1);
  assert.equal(grouped.cases[0].groupId, ' g-1 ');
});

test('ID-2 different source IDs never collapse into one identity, and trimmed-equal IDs stay ambiguous and refused', () => {
  const anchorA = M.createMeasurementRecord({ id: 'ma', start: onCargo('a'), end: ground(5, 5), now: 1 });
  const anchorSpaced = M.createMeasurementRecord({ id: 'mb', start: onCargo(' a '), end: ground(6, 6), now: 1 });
  const damaged = makePack('D', { loadPlanNumber: 'LP-D', cases: [solidInstance('a'), solidInstance(' a ')], measurements: [anchorA, anchorSpaced] });
  const normalized = normalizePack(damaged, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['a', ' a '], 'both source strings are preserved, not collapsed into two identical IDs');
  assert.deepEqual(normalized.measurements.map(m => m.start.instanceId), ['a', ' a '], 'and no anchor is guessed onto either');
  seed([normalized]);
  assert.deepEqual(statusOfPack('D'), ['unresolved:cargo-ambiguous', 'unresolved:cargo-ambiguous']);
  assert.deepEqual(normalizePack(normalized, caseMap, 1), normalized, 'repeating it changes nothing');
  // The owner-approved strict contract still refuses such a plan wherever it enters.
  emptyDestination();
  assert.throws(() => PackLibrary.validatePackImportPayload(importPayload([], [solidInstance('a'), solidInstance(' a ')]), new Set([CASE.id])), refusal);
  assert.throws(() => validateWorkspaceGraph({ caseLibrary: [CASE], packLibrary: [damaged], folderLibrary: [] }), /duplicate id/i);
  // Truly identical IDs (damaged local data) are kept as they are, too.
  const same = normalizePack(makePack('E', { cases: [solidInstance('x'), solidInstance('x')] }), caseMap, 1);
  assert.deepEqual(same.cases.map(c => c.id), ['x', 'x']);
});

test('ID-2 a measurement on cargo that really is missing stays Unresolved and is never attached elsewhere', () => {
  const ghost = M.createMeasurementRecord({ id: 'g', start: onCargo(' ghost '), end: ground(5, 5), now: 1 });
  const plan = makePack('G', { loadPlanNumber: 'LP-G', cases: [solidInstance('other')], measurements: [ghost] });
  const normalized = normalizePack(plan, caseMap, 1);
  assert.equal(normalized.measurements[0].start.instanceId, ' ghost ', 'a dangling reference is not rewritten: there is nothing to map it to');
  seed([normalized]);
  assert.deepEqual(statusOfPack('G'), ['unresolved:cargo-missing']);
});

test('ID-2 damaged records stay recoverable: unreadable measurements and repeated IDs survive normalization verbatim', () => {
  const unreadable = { id: 'bad', type: 'point-to-point', start: { kind: 'mystery', instanceId: ' cargo ' } };
  const plan = spacedPlan({ measurements: [unreadable, M.createMeasurementRecord({ id: 'm', start: onCargo(SPACED), end: ground(5, 5), now: 1 })] });
  const normalized = normalizePack(plan, caseMap, 1);
  assert.equal(normalized.measurements[0].type, M.MEASUREMENT_TYPE_UNREADABLE);
  assert.deepEqual(normalized.measurements[0].original, unreadable, 'the unreadable original is kept verbatim, spaces and all');
  assert.equal(normalized.measurements[1].start.instanceId, 'cargo', 'while the readable one follows its cargo');
  assert.deepEqual(normalizePack(normalized, caseMap, 1).measurements, normalized.measurements);
});

test('ID-2 stored hydration keeps working: a raw spaced ID, and a mixed spelling, still resolve by identity', () => {
  // Storage.load() returns stored Load Plans without normalizing them: the identity rule must work on raw data.
  seed([spacedPlan()]);
  CoreStorage.saveNow();
  const loaded = CoreStorage.load();
  assert.ok(loaded && loaded.packLibrary.length === 1);
  assert.equal(loaded.packLibrary[0].cases[0].id, SPACED, 'hydration does not rewrite the stored ID');
  StateStore.init({ currentScreen: 'editor', currentPackId: 'S', caseLibrary: loaded.caseLibrary, folderLibrary: [], preferences: {}, packLibrary: loaded.packLibrary });
  assert.deepEqual(statusOfPack('S'), ['valid']);
  const mixed = spacedPlan({ measurements: [M.createMeasurementRecord({ id: 'm', start: onCargo('cargo'), end: ground(5, 5), now: 1 })] });
  seed([mixed]);
  assert.deepEqual(statusOfPack('S'), ['valid'], 'an anchor spelled "cargo" finds the cargo stored as " cargo "');
});

test('ID-2 export and reimport, single and batch, follow a spaced identity to the new cargo', () => {
  seed([spacedPlan()]);
  const pack = PackLibrary.getById('S');
  const single = ImportExport.buildRestorablePackExportJSON(pack);
  const batch = ImportExport.buildRestorablePackBatchExportJSON([pack]);
  emptyDestination();
  const imported = PackLibrary.importPackPayload(ImportExport.parsePackImportJSON(single));
  assert.notEqual(imported.cases[0].id, SPACED);
  assert.equal(imported.measurements[0].start.instanceId, imported.cases[0].id, 'single import: the anchor follows the regenerated ID');
  assert.deepEqual(statusOfPack(imported.id), ['valid']);
  emptyDestination();
  const [entry] = ImportExport.parsePackBatchImportJSON(batch);
  const fromBatch = PackLibrary.importPackPayload(entry);
  assert.equal(fromBatch.measurements[0].start.instanceId, fromBatch.cases[0].id, 'batch import: the same');
  assert.deepEqual(statusOfPack(fromBatch.id), ['valid']);
  // A mixed spelling in the file (anchor "cargo", cargo " cargo ") is the same identity.
  const file = JSON.parse(single);
  file.data.pack.measurements[0].start.instanceId = 'cargo';
  emptyDestination();
  const mixed = PackLibrary.importPackPayload(ImportExport.parsePackImportJSON(JSON.stringify(file)));
  assert.equal(mixed.measurements[0].start.instanceId, mixed.cases[0].id);
});

test('ID-2 Workspace Backup and Active Workspace Backup restore a spaced identity with its measurements intact', () => {
  seed([spacedPlan()]);
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const appJson = ImportExport.buildAppExportJSON();
  const check = (cases, measurements, label) => {
    assert.equal(cases[0].id, 'cargo', `${label}: the cargo ID is canonical`);
    assert.equal(measurements[0].start.instanceId, 'cargo', `${label}: the anchor followed it`);
  };

  const imported = ImportExport.parseWorkspaceImportJSON(workspaceJson);
  const plan = ImportExport.planWorkspaceRestore(imported, { currentState: StateStore.snapshot() });
  check(plan.packLibrary[0].cases, plan.packLibrary[0].measurements, 'Workspace Backup');
  StateStore.init({ currentScreen: 'editor', currentPackId: 'S', caseLibrary: plan.caseLibrary, folderLibrary: [], preferences: {}, packLibrary: plan.packLibrary });
  assert.deepEqual(statusOfPack('S'), ['valid'], 'and it resolves after the restore');
  // Restoring the restored data again changes nothing (no repeated rewrite).
  const again = normalizeAppData({ caseLibrary: plan.caseLibrary, packLibrary: plan.packLibrary, folderLibrary: [], preferences: {} });
  assert.deepEqual(again.packLibrary[0].cases, plan.packLibrary[0].cases);
  assert.deepEqual(again.packLibrary[0].measurements, plan.packLibrary[0].measurements);

  const app = ImportExport.parseAppImportJSON(appJson);
  check(app.packLibrary[0].cases, app.packLibrary[0].measurements, 'Active Workspace Backup');
  StateStore.init({ currentScreen: 'editor', currentPackId: 'S', caseLibrary: app.caseLibrary, folderLibrary: [], preferences: {}, packLibrary: app.packLibrary });
  assert.deepEqual(statusOfPack('S'), ['valid']);
  // Self-preflight of the backup file agrees (it runs the same restore plan).
  assert.doesNotThrow(() => ImportExport.assertRestorableWorkspaceBackup(workspaceJson));
});

test('ID-2 duplication, Undo/Redo and cargo editing keep the relationship for a spaced identity', () => {
  seed([normalizePack(spacedPlan(), caseMap, 1)]);
  const copy = PackLibrary.duplicate('S');
  assert.equal(copy.measurements[0].start.instanceId, copy.cases[0].id, 'duplication re-targets through the identity map');
  assert.deepEqual(statusOfPack(copy.id), ['valid']);
  // Raw (un-normalized) spaced data duplicates correctly too.
  seed([spacedPlan()]);
  const rawCopy = PackLibrary.duplicate('S');
  assert.equal(rawCopy.measurements[0].start.instanceId, rawCopy.cases[0].id);
  assert.deepEqual(statusOfPack(rawCopy.id), ['valid']);
  // Cargo Undo/Redo never touches the measurement relationship.
  const moved = PackLibrary.updateInstance('S', SPACED, { transform: { position: { x: 80, y: 16, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
  assert.ok(moved);
  assert.equal(StateStore.undo(), true);
  assert.deepEqual(statusOfPack('S'), ['valid']);
  assert.equal(StateStore.redo(), true);
  assert.deepEqual(statusOfPack('S'), ['valid']);
});

// ============================================================================
// Final identity correction: a discarded instance can never make an ambiguous reference resolve on another cargo
// ============================================================================
const noCase = id => ({ ...solidInstance(id), caseId: '' }); // normalization discards an instance with no Case reference
const refTo = (id, name = 'm') => M.createMeasurementRecord({ id: name, start: onCargo(id), end: ground(5, 5), now: 1 });
const contestedPlan = (cases, measurements, id = 'X') => makePack(id, { loadPlanNumber: `LP-${id}`, cases, measurements });
const statuses = id => PackLibrary.resolveMeasurements(id).map(r => `${r.status}${r.reason ? `:${r.reason}` : ''}`);

test('ID-3 the audited case: filtering a conflicting instance never makes the reference Valid on the survivor', () => {
  const variants = [
    ['"cargo" + " cargo " (no Case), anchor " cargo "', [solidInstance('cargo'), noCase(' cargo ')], ' cargo '],
    ['the same, instance order reversed', [noCase(' cargo '), solidInstance('cargo')], ' cargo '],
    ['the same, anchor spelled "cargo"', [solidInstance('cargo'), noCase(' cargo ')], 'cargo'],
    ['three holders, two discarded', [solidInstance('cargo'), noCase(' cargo '), noCase('cargo ')], ' cargo '],
    ['the surviving holder is the spaced one', [solidInstance(' cargo '), noCase('cargo')], 'cargo'],
  ];
  for (const [name, cases, anchorId] of variants) {
    const raw = contestedPlan(cases, [refTo(anchorId)]);
    // The source, as written, is ambiguous (and stays Unresolved with every instance present).
    seed([{ ...raw, cases: cases.map(c => ({ ...c, caseId: CASE.id })) }]);
    assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous'], `${name}: the source verdict`);

    const normalized = normalizePack(raw, caseMap, 1);
    assert.deepEqual(normalized.cases.map(c => c.id), ['cargo'], `${name}: exactly one survivor, canonical`);
    assert.equal(normalized.measurements.length, 1, `${name}: nothing is dropped`);
    assert.equal(normalized.measurements[0].type, M.MEASUREMENT_TYPE_UNREADABLE, `${name}: the measurement is withheld into the recovery record`);
    assert.deepEqual(normalized.measurements[0].original, raw.measurements[0], `${name}: the original is preserved verbatim`);
    seed([normalized]);
    const [only] = PackLibrary.resolveMeasurements('X');
    assert.notEqual(only.status, 'valid', `${name}: NEVER Valid on the surviving cargo`);
    assert.deepEqual([only.status, only.reason, only.distance, only.start], ['unresolved', 'unreadable', null, null], name);
    assert.deepEqual(normalizePack(normalized, caseMap, 1), normalized, `${name}: normalizing again changes nothing`);
  }
});

test('ID-3 ambiguity that is still visible among the survivors stays visible, and trimmed-equivalent valid IDs are never merged', () => {
  // Both conflicting instances survive: the existing mechanism flags it, nothing is withheld or merged.
  const both = normalizePack(contestedPlan([solidInstance('cargo'), solidInstance(' cargo ')], [refTo(' cargo ')]), caseMap, 1);
  assert.deepEqual(both.cases.map(c => c.id), ['cargo', ' cargo '], 'two distinct source strings stay distinct');
  assert.equal(both.measurements[0].type, 'point-to-point');
  assert.equal(both.measurements[0].start.instanceId, ' cargo ', 'the anchor is not guessed onto either');
  seed([both]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous']);
  assert.deepEqual(normalizePack(both, caseMap, 1), both);
  // Three holders, two survive, one is discarded: still ambiguous among the survivors.
  const three = normalizePack(contestedPlan([solidInstance('a'), solidInstance(' a '), noCase('a ')], [refTo('a')]), caseMap, 1);
  assert.deepEqual(three.cases.map(c => c.id), ['a', ' a ']);
  seed([three]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-ambiguous']);
  // Entering through the strict gates, such a plan is refused before normalization ever runs.
  emptyDestination();
  assert.throws(() => PackLibrary.validatePackImportPayload(importPayload([], [solidInstance('cargo'), solidInstance(' cargo ')]), new Set([CASE.id])), refusal);
});

test('ID-3 legitimate identities are untouched: valid plans acquire no new status', () => {
  // A single spaced ID with its anchor still canonicalizes together, even beside an unrelated discarded instance.
  const raw = contestedPlan([solidInstance(' cargo '), noCase('unrelated')], [refTo(' cargo ')]);
  const normalized = normalizePack(raw, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['cargo']);
  assert.equal(normalized.measurements[0].type, 'point-to-point');
  assert.equal(normalized.measurements[0].start.instanceId, 'cargo');
  seed([normalized]);
  assert.deepEqual(statuses('X'), ['valid']);
  // Cargo that needs no canonicalization keeps the very same measurement list.
  const clean = contestedPlan([solidInstance('a'), solidInstance('b'), noCase('c')], [refTo('a', 'ma'), refTo('b', 'mb')]);
  const out = normalizePack(clean, caseMap, 1);
  assert.equal(out.measurements, M.normalizeMeasurements(clean.measurements), 'nothing was rebuilt');
  seed([out]);
  assert.deepEqual(statuses('X'), ['valid', 'valid']);
});

test('ID-3 a dangling reference stays Unresolved and is never withheld, rewritten or attached elsewhere', () => {
  // The only holder of the ID is discarded: nothing survives to mistake for it.
  const onlyDiscarded = normalizePack(contestedPlan([solidInstance('other'), noCase(' ghost ')], [refTo(' ghost ')]), caseMap, 1);
  assert.equal(onlyDiscarded.measurements[0].type, 'point-to-point');
  assert.equal(onlyDiscarded.measurements[0].start.instanceId, ' ghost ', 'left exactly as it is');
  seed([onlyDiscarded]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-missing']);
  // Several discarded holders and no survivor: same.
  const allDiscarded = normalizePack(contestedPlan([noCase('g'), noCase(' g ')], [refTo('g')]), caseMap, 1);
  seed([allDiscarded]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-missing']);
  // A reference to an ID no instance ever had.
  const never = normalizePack(contestedPlan([solidInstance('x')], [refTo(' never ')]), caseMap, 1);
  seed([never]);
  assert.deepEqual(statuses('X'), ['unresolved:cargo-missing']);
});

test('ID-3 several measurements, ambiguous and unambiguous, are each decided on their own identity', () => {
  const records = [
    refTo(' cargo ', 'contested'),
    refTo(' solo ', 'solo'),
    M.createMeasurementRecord({ id: 'mixed', start: onCargo('cargo'), end: onCargo(' solo '), now: 1 }),
    M.createMeasurementRecord({ id: 'flat', ...pair(), now: 1 }),
    refTo(' ghost ', 'ghost'),
  ];
  const raw = contestedPlan([solidInstance('cargo'), noCase(' cargo '), solidInstance(' solo '), solidInstance('other')], records);
  const normalized = normalizePack(raw, caseMap, 1);
  assert.deepEqual(normalized.cases.map(c => c.id), ['cargo', 'solo', 'other']);
  assert.deepEqual(normalized.measurements.map(m => `${m.id}:${m.type}`), [
    'contested:unreadable', 'solo:point-to-point', 'mixed:unreadable', 'flat:point-to-point', 'ghost:point-to-point',
  ], 'only the references that were ambiguous in the source are withheld, in place');
  assert.deepEqual(normalized.measurements[0].original, records[0]);
  assert.deepEqual(normalized.measurements[2].original, records[2], 'the other endpoint of a withheld record stays recoverable');
  assert.equal(normalized.measurements[1].start.instanceId, 'solo', 'the unambiguous reference canonicalized with its cargo');
  seed([normalized]);
  assert.deepEqual(statuses('X'), ['unresolved:unreadable', 'valid', 'unresolved:unreadable', 'valid', 'unresolved:cargo-missing']);
  assert.deepEqual(normalizePack(normalized, caseMap, 1), normalized, 'repeat normalization is a no-op');
  assert.deepEqual(normalizePack(normalizePack(normalized, caseMap, 1), caseMap, 1), normalized);
  // App-level normalization (what restore runs) decides the same way, twice.
  const app = normalizeAppData({ caseLibrary: [CASE], packLibrary: [raw], folderLibrary: [], preferences: {} });
  assert.deepEqual(app.packLibrary[0].measurements.map(m => m.type), normalized.measurements.map(m => m.type));
  assert.deepEqual(normalizeAppData({ ...app }).packLibrary[0].measurements, app.packLibrary[0].measurements);
});

test('ID-3 import, backup and restore: the strict gates refuse the source, and a withheld record travels intact', () => {
  const cases = [solidInstance('cargo'), noCase(' cargo ')];
  const source = contestedPlan(cases, [refTo(' cargo ')], 'S');

  // The supported entry points reject this source before normalization can see it.
  emptyDestination();
  assert.throws(() => PackLibrary.validatePackImportPayload(importPayload(source.measurements, cases), new Set([CASE.id])), /blank or missing case reference|more than one item/);
  assert.throws(() => validateWorkspaceGraph({ caseLibrary: [CASE], packLibrary: [source], folderLibrary: [] }), /caseId|duplicate id/i);
  seed([contestedPlan([solidInstance('cargo')], [refTo(' cargo ')], 'S')]);
  const workspaceJson = ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1');
  const appJson = ImportExport.buildAppExportJSON();
  const tamper = json => {
    const file = JSON.parse(json);
    file.data.packLibrary[0].cases.push({ ...solidInstance(' cargo '), caseId: '' });
    return JSON.stringify(file);
  };
  assert.throws(() => ImportExport.parseWorkspaceImportJSON(tamper(workspaceJson)), /caseId|duplicate id/i, 'Workspace Backup restore');
  assert.throws(() => ImportExport.parseAppImportJSON(tamper(appJson)), /caseId|duplicate id/i, 'Active Workspace Backup restore');

  // The withheld record itself is ordinary recovery data: it exports, restores and re-imports verbatim.
  const withheld = normalizePack(source, caseMap, 1);
  assert.equal(withheld.measurements[0].type, M.MEASUREMENT_TYPE_UNREADABLE);
  seed([withheld]);
  const single = ImportExport.buildRestorablePackExportJSON(PackLibrary.getById('S'));
  const workspace = ImportExport.parseWorkspaceImportJSON(ImportExport.buildWorkspaceExportJSON('Probe', 'ws-1'));
  const app = ImportExport.parseAppImportJSON(ImportExport.buildAppExportJSON());
  for (const [label, list] of [['workspace backup', workspace.packLibrary[0].measurements], ['app backup', app.packLibrary[0].measurements]]) {
    assert.equal(list[0].type, M.MEASUREMENT_TYPE_UNREADABLE, label);
    assert.deepEqual(list[0].original, source.measurements[0], `${label}: the source record survives the round trip verbatim`);
  }
  emptyDestination();
  const imported = PackLibrary.importPackPayload(ImportExport.parsePackImportJSON(single));
  assert.equal(imported.measurements[0].type, M.MEASUREMENT_TYPE_UNREADABLE, 'Load Plan import');
  assert.deepEqual(imported.measurements[0].original, source.measurements[0]);
  assert.deepEqual(statuses(imported.id), ['unresolved:unreadable'], 'and it is Unresolved after every step, never Valid');
  // Hydration of a stored plan does not run the normalizer: the raw plan keeps its ambiguity as it was.
  seed([source]);
  assert.deepEqual(statuses('S'), ['unresolved:cargo-ambiguous']);
});
