/**
 * @file annotation-core.spec.mjs
 * @description Pins the pure Annotations V1 model (src/core/annotations.js) and its screen-space layout
 *   (src/core/annotation-layout.js): schema and caps, strict versus never-destructive lenient handling of
 *   stored data, derived validity (Valid / Needs Review / Unresolved without fabricated positions),
 *   instance-ID remapping, and the card placement rules. How annotations live inside a Load Plan
 *   (history, duplicate, import, export, backup) is pinned in annotation-lifecycle.spec.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/core/measurements.js';
import * as A from '../../src/core/annotations.js';
import * as L from '../../src/core/annotation-layout.js';

const CASE = {
  id: 'case-1', name: 'Crate', shape: 'box',
  dimensions: { length: 48, width: 24, height: 32 },
};
const instance = (overrides = {}) => ({
  id: 'inst-1', caseId: 'case-1', placement: 'packed',
  transform: { position: { x: 60, y: 100, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  ...overrides,
});
const ground = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
const onCargo = (instanceId, local = { x: 24, y: 2, z: 3 }) => M.buildCargoAnchor({ instanceId, local, caseData: CASE });
const callout = (id, anchor = ground(5, 5), extra = {}) => A.createCalloutRecord({ id, anchor, title: 'Fragile', now: 1000, ...extra });
const FLOORS = M.buildFloorSurfaces({ shapeMode: 'rect' }, [{ min: { x: 0, y: 0, z: -50 }, max: { x: 600, y: 90, z: 50 } }]);
const context = (overrides = {}) => ({
  getInstance: id => (id === 'inst-1' ? instance() : null),
  getCase: id => (id === 'case-1' ? CASE : null),
  floors: FLOORS,
  ...overrides,
});

// ============================================================================
// SECTION: SCHEMA, CAPS AND TEXT
// ============================================================================

test('the proposed caps and the record shape are exactly the ones the contract names', () => {
  assert.equal(A.MAX_ANNOTATIONS_PER_PACK, 200);
  assert.equal(A.MAX_CALLOUT_TITLE_LENGTH, 48);
  assert.equal(A.MAX_CALLOUT_DESCRIPTION_LENGTH, 140);
  assert.equal(A.MAX_CARD_OFFSET_PX, 2000);
  assert.deepEqual([...A.ANNOTATION_COLORS], ['ink', 'blue', 'green', 'red', 'violet']);
  const created = callout('c1', ground(0, 0), { description: '  Handle   with care ', color: 'red', keepExpanded: true });
  assert.deepEqual(Object.keys(created).sort(),
    ['anchor', 'color', 'createdAt', 'description', 'hidden', 'id', 'keepExpanded', 'offset', 'schemaVersion', 'title', 'type', 'updatedAt']);
  assert.deepEqual([created.type, created.schemaVersion, created.description, created.hidden, created.offset], ['callout', 1, 'Handle with care', false, null]);
  assert.equal(A.validateCalloutRecord(created), null);
  assert.equal(Object.hasOwn(created, 'author'), false, 'no author identity is invented');
  assert.equal(Object.hasOwn(created, 'status'), false, 'nothing derived is stored');
});

test('titles and descriptions are one normalized line within their caps; an unknown color falls back to Ink', () => {
  assert.equal(A.normalizeCalloutTitle('  UNLOAD \n FIRST  '), 'UNLOAD FIRST');
  assert.equal(A.normalizeCalloutTitle('x'.repeat(80)).length, 48);
  assert.equal(A.normalizeCalloutTitle('   '), '');
  assert.equal(A.normalizeCalloutDescription('   '), null);
  assert.equal(A.normalizeCalloutDescription('y'.repeat(300)).length, 140);
  assert.equal(A.normalizeAnnotationColor('magenta'), 'ink');
  assert.equal(A.normalizeAnnotationColor('violet'), 'violet');
  assert.deepEqual(A.normalizeCardOffset({ dx: 10.04, dy: -3.06 }), { dx: 10, dy: -3.1 });
  assert.equal(A.normalizeCardOffset({ dx: 2001, dy: 0 }), null, 'an offset beyond the bound is not stored');
  assert.equal(A.normalizeCardOffset({ dx: NaN, dy: 0 }), null);
  assert.equal(A.normalizeCardOffset(null), null);
});

test('presets only fill editable text: five fixed texts that fit the caps and are never part of a record', () => {
  assert.deepEqual(A.CALLOUT_PRESETS.map(p => p.key), ['Fragile', 'Unload First', 'This Side Up', 'Heavy', 'Customer Pickup']);
  for (const preset of A.CALLOUT_PRESETS) {
    assert.ok(preset.title.length <= A.MAX_CALLOUT_TITLE_LENGTH, preset.key);
    assert.ok(preset.description.length <= A.MAX_CALLOUT_DESCRIPTION_LENGTH, preset.key);
    assert.equal(A.validateCalloutRecord(callout('p', ground(1, 1), { title: preset.title, description: preset.description })), null);
  }
  assert.equal(Object.keys(callout('p')).includes('preset'), false);
});

test('colors: the five built-in names stay valid and a custom color is exactly #RRGGBB, stored lower-case, never replaced', () => {
  for (const name of A.ANNOTATION_COLORS) assert.equal(A.validateCalloutRecord(callout('n', ground(1, 1), { color: name })), null, name);
  const custom = callout('c', ground(1, 1), { color: '#A1b2C3' });
  assert.equal(custom.color, '#a1b2c3', 'canonical lower-case #rrggbb');
  assert.equal(A.validateCalloutRecord(custom), null);
  assert.deepEqual(Object.keys(custom).sort(), Object.keys(callout('d')).sort(), 'no second color field is added');
  // Unsafe or malformed values are refused by the validation gate, not swapped for the default.
  for (const value of ['#fff', '#12345', '#1234567', 'a1b2c3', '#gggggg', 'rgb(0,0,0)', 'url(javascript:alert(1))', '#a1b2c3;x', ' #a1b2c3', 'red;', '', null, 7]) {
    const made = callout('x', ground(1, 1), { color: value });
    assert.notEqual(A.validateCalloutRecord(made), null, `refused: ${String(value)}`);
    assert.equal(A.validateAnnotationCollection([made]).ok, false, `collection refuses ${String(value)}`);
    assert.equal(A.editCalloutRecord(callout('e'), { color: value }, 2000), null, `an edit refuses ${String(value)}`);
  }
  assert.equal(A.editCalloutRecord(callout('e'), { color: '#00FF7F' }, 2000).color, '#00ff7f');
  assert.equal(A.editCalloutRecord(callout('e'), { color: 'violet' }, 2000).color, 'violet');
  assert.equal(A.validateCalloutRecord({ ...callout('s'), color: '#ABCDEF' }), null, 'upper-case hex is a valid stored value and is canonicalised on write');
  assert.equal(A.normalizeAnnotations([{ ...callout('s'), color: '#ABCDEF' }])[0].color, '#abcdef');
  // A stored record with a malformed color is kept verbatim as a recovery record, never defaulted.
  const malformed = { ...callout('m'), color: 'pink' };
  const [kept] = A.normalizeAnnotations([malformed]);
  assert.equal(kept.type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(kept.original, malformed);
  // Display helpers: an unknown value draws as the default, and the foreground contrasts with a custom color.
  assert.equal(A.normalizeAnnotationColor('#12AB34'), '#12ab34');
  assert.equal(A.normalizeAnnotationColor('nope'), 'ink');
  assert.equal(A.annotationForegroundFor('ink'), null);
  const ratio = (a, b) => {
    const lum = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const color of ['#000000', '#ffffff', '#ffff00', '#fde68a', '#0b1020', '#7f7f7f', '#ff9f1c', '#2f6fed', '#f5f5f5', '#101010']) {
    assert.ok(ratio(color, A.annotationForegroundFor(color)) >= 4.5, `readable number on ${color}`);
  }
});

const luminanceOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrastOf = (a, b) => { const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('every accepted marker number reaches 4.5:1: custom colors around the foreground switch and every built-in color in both themes', async () => {
  // Threshold cases: mid-tones neither white nor the near-black text can serve get pure black.
  for (const color of ['#7a7a7a', '#767676', '#777777', '#808080', '#757575', '#6e6e6e', '#8a8a8a', '#959595', '#8b8b8b', '#ff0000', '#00ff00', '#0000ff', '#ffa500', '#808000', '#008080', '#800080']) {
    assert.ok(contrastOf(color, A.annotationForegroundFor(color)) >= 4.5, `${color} -> ${A.annotationForegroundFor(color)} ${contrastOf(color, A.annotationForegroundFor(color)).toFixed(2)}`);
  }
  // A sweep of the whole gray ramp and of saturated hues.
  for (let v = 0; v < 256; v += 3) {
    const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
    assert.ok(contrastOf(hex, A.annotationForegroundFor(hex)) >= 4.5, hex);
  }
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    assert.ok(contrastOf(hex, A.annotationForegroundFor(hex)) >= 4.5, hex);
  }
  // The built-in colors are stylesheet tokens: check what is actually shipped, in both themes.
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../../styles/main.css', import.meta.url), 'utf8');
  const block = (start, end) => css.slice(css.indexOf(start), css.indexOf(end, css.indexOf(start)));
  const themes = { light: block(':root {', '/* ================================\n  Dark Theme Tokens'), dark: block("[data-theme='dark'] {", '/* ================================\n  Base Reset') };
  for (const [name, text] of Object.entries(themes)) {
    const token = key => (text.match(new RegExp(`--annot-${key}:\\s*(#[0-9a-fA-F]{6});`)) || [])[1];
    for (const color of ['ink', 'blue', 'green', 'red', 'violet']) {
      const foreground = color === 'ink' ? token('on-ink') : token('on-color');
      assert.ok(token(color) && foreground, `${name} ${color} tokens exist`);
      assert.ok(contrastOf(token(color), foreground) >= 4.5, `${name} ${color}: ${contrastOf(token(color), foreground).toFixed(2)}`);
    }
  }
});

test('validation names the first problem in a stored callout', () => {
  const ok = callout('v');
  assert.equal(A.validateCalloutRecord(ok), null);
  const bad = (patch, pattern) => assert.match(A.validateCalloutRecord({ ...ok, ...patch }) || '', pattern, JSON.stringify(patch).slice(0, 60));
  bad({ id: '' }, /id/);
  bad({ id: 'x'.repeat(65) }, /id/);
  bad({ type: 'arrow' }, /type/);
  bad({ schemaVersion: 2 }, /schemaVersion/);
  bad({ title: '' }, /title/);
  bad({ title: '   ' }, /title/);
  bad({ title: 'x'.repeat(49) }, /title/);
  bad({ title: 7 }, /title/);
  bad({ description: 'y'.repeat(141) }, /description/);
  bad({ description: 5 }, /description/);
  bad({ color: 'pink' }, /color/);
  bad({ keepExpanded: 'yes' }, /flags/);
  bad({ hidden: 1 }, /flags/);
  bad({ offset: { dx: 5000, dy: 0 } }, /offset/);
  bad({ offset: { dx: 'a', dy: 0 } }, /offset/);
  bad({ createdAt: 'now' }, /timestamps/);
  bad({ anchor: null }, /anchor/);
  bad({ anchor: { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } } }, /surface/);
  // A cargo point must lie on the saved cargo surface, exactly as for measurements.
  bad({ anchor: { ...onCargo('inst-1'), local: { x: 0, y: 0, z: 0 } } }, /not on the surface/);
  assert.equal(A.validateCalloutRecord({ ...ok, description: null, offset: { dx: -2000, dy: 2000 } }), null, 'the bounds themselves are allowed');
});

// ============================================================================
// SECTION: STORED DATA (lenient, never destructive) AND IMPORT (strict)
// ============================================================================

test('lenient normalization never drops, coerces or truncates what it cannot read', () => {
  assert.deepEqual(A.normalizeAnnotations(undefined), []);
  assert.deepEqual(A.normalizeAnnotations(null), []);
  const good = callout('good');
  const malformed = { id: 'bad', type: 'callout', title: '', anchor: { kind: 'mystery' } };
  const future = { id: 'sk', type: 'sketch', schemaVersion: 1, points: [] };
  const newer = { ...good, id: 'newer', schemaVersion: 9 };
  const list = [good, malformed, 'garbage', 42, null, future, newer];
  const frozen = JSON.stringify(list);
  const out = A.normalizeAnnotations(list);
  assert.equal(JSON.stringify(list), frozen, 'the stored input is not mutated');
  assert.equal(out.length, list.length, 'nothing is dropped');
  assert.deepEqual(out[0], good);
  assert.equal(out[1].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(out[1].original, malformed, 'the original is kept verbatim for recovery');
  assert.deepEqual(out[2].original, 'garbage');
  assert.deepEqual(out[4].original, null);
  assert.equal(out[5].reason, 'The saved annotation could not be read.', 'a record of a type this version does not know is preserved and explained');
  assert.deepEqual(out[5].original, future);
  assert.equal(out[6].reason, 'Saved by a newer version of the app.', 'a later schemaVersion is a newer version');
  assert.equal(new Set(out.map(r => r.id)).size, out.length, 'recovery IDs are unique');
  // The wrapper is itself stable: normalizing normalized data changes nothing.
  assert.equal(A.normalizeAnnotations(out), out);
  assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify(out))), out);
});

test('a non-list container and a duplicate ID are preserved as recovery records', () => {
  const wrapped = A.normalizeAnnotations({ not: 'a list' });
  assert.equal(wrapped.length, 1);
  assert.deepEqual(wrapped[0].original, { not: 'a list' });
  const twin = callout('twin');
  const out = A.normalizeAnnotations([twin, { ...twin, title: 'Second' }]);
  assert.equal(out[0].type, A.ANNOTATION_TYPE_CALLOUT);
  assert.equal(out[1].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.equal(out[1].reason, 'Duplicate annotation ID in this Load Plan.');
  assert.equal(out[1].original.title, 'Second');
});

test('strict validation rejects the whole collection and never truncates or repairs', () => {
  const good = callout('g');
  assert.deepEqual(A.validateAnnotationCollection(undefined), { ok: true, annotations: [] });
  assert.deepEqual(A.validateAnnotationCollection([good]).annotations, [good]);
  assert.match(A.validateAnnotationCollection('nope').error, /expected an array/);
  assert.match(A.validateAnnotationCollection([good, { ...good, anchor: { kind: 'cargo' } }]).error, /annotations\[1\]/);
  assert.match(A.validateAnnotationCollection([good, good]).error, /duplicate annotation id "g"/);
  const many = n => Array.from({ length: n }, (_, i) => callout(`c${i}`, ground(i, 1)));
  assert.equal(A.validateAnnotationCollection(many(200)).annotations.length, 200, 'exactly 200 is allowed');
  assert.match(A.validateAnnotationCollection(many(201)).error, /too many annotations \(201; maximum 200\)/);
  // A reference to cargo that no longer exists is structurally valid: retained, resolved as Unresolved later.
  assert.equal(A.validateAnnotationCollection([callout('dangling', onCargo('gone'))]).ok, true);
  // An explicit recovery record is accepted and returned canonical.
  const recovery = A.normalizeAnnotations([{ id: 'x' }])[0];
  assert.deepEqual(A.validateAnnotationCollection([recovery]).annotations, [recovery]);
  const withoutOriginal = Object.fromEntries(Object.entries(recovery).filter(([key]) => key !== 'original'));
  assert.match(A.validateAnnotationCollection([withoutOriginal]).error, /annotations\[0\]/, 'a recovery record must carry what it recovers');
});

// ============================================================================
// SECTION: PURE EDITS
// ============================================================================

test('editing text and presentation preserves the anchor, identity and creation time; an empty title is refused', () => {
  const base = callout('e', onCargo('inst-1'), { description: 'old' });
  const edited = A.editCalloutRecord(base, { title: '  New   title ', description: '', color: 'green', keepExpanded: true, hidden: true, id: 'hijack', anchor: ground(9, 9) }, 5000);
  assert.deepEqual([edited.title, edited.description, edited.color, edited.keepExpanded, edited.hidden], ['New title', null, 'green', true, true]);
  assert.deepEqual([edited.id, edited.createdAt, edited.updatedAt], ['e', 1000, 5000]);
  assert.deepEqual(edited.anchor, base.anchor, 'unknown patch keys (id, anchor) are ignored');
  assert.equal(A.editCalloutRecord(base, { title: '   ' }, 5000), null);
  assert.equal(A.editCalloutRecord({ ...base, type: 'arrow' }, { title: 'x' }, 5000), null);
  assert.equal(A.editCalloutRecord(base, { title: 'x' }, NaN), null);
});

test('moving the marker re-attaches to a validated anchor and keeps the card offset; moving the card keeps the anchor', () => {
  const base = callout('m', ground(5, 5), { offset: { dx: 40, dy: -30 } });
  const target = onCargo('inst-1');
  const moved = A.reattachCalloutRecord(base, target, 7000);
  assert.deepEqual(moved.anchor, target);
  assert.deepEqual(moved.offset, { dx: 40, dy: -30 }, 'the card travels with the marker');
  assert.deepEqual([moved.title, moved.createdAt, moved.updatedAt], ['Fragile', 1000, 7000]);
  assert.equal(A.reattachCalloutRecord(base, { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } }, 7000), null);
  assert.equal(A.reattachCalloutRecord(base, { ...target, local: { x: 0, y: 0, z: 0 } }, 7000), null, 'a point off the cargo surface is refused');

  const dragged = A.offsetCalloutRecord(base, { dx: 12.34, dy: 5 }, 8000);
  assert.deepEqual(dragged.offset, { dx: 12.3, dy: 5 });
  assert.deepEqual(dragged.anchor, base.anchor, 'dragging a card never changes the anchor');
  assert.equal(A.offsetCalloutRecord(base, null, 8000).offset, null, 'null returns the card to automatic placement');
  assert.equal(A.offsetCalloutRecord(base, { dx: 9999, dy: 0 }, 8000), null);
});

// ============================================================================
// SECTION: DERIVED VALIDITY (no fabricated positions)
// ============================================================================

test('Valid carries a position; Needs Review and Unresolved never do and explain themselves', () => {
  const onGround = A.resolveAnnotation(callout('g', ground(10, 20)), context());
  assert.deepEqual([onGround.status, onGround.reason, onGround.point], ['valid', null, { x: 10, y: 0, z: 20 }]);

  const cargo = A.resolveAnnotation(callout('c', onCargo('inst-1')), context());
  assert.equal(cargo.status, 'valid');
  assert.deepEqual(cargo.point, { x: 84, y: 102, z: 3 }, 'cargo-local point + committed pose');

  const resized = A.resolveAnnotation(callout('c', onCargo('inst-1')), context({ getCase: () => ({ ...CASE, dimensions: { ...CASE.dimensions, length: 60 } }) }));
  assert.deepEqual([resized.status, resized.reason, resized.point], ['needs-review', 'case-changed', null]);
  assert.match(A.describeAnnotationReason(resized.reason), /Re-attach/);

  const missing = A.resolveAnnotation(callout('c', onCargo('inst-1')), context({ getInstance: () => null }));
  assert.deepEqual([missing.status, missing.reason, missing.point], ['unresolved', 'cargo-missing', null]);

  const ambiguous = A.resolveAnnotation(callout('c', onCargo('inst-1')), context({ isInstanceAmbiguous: () => true }));
  assert.deepEqual([ambiguous.status, ambiguous.reason], ['unresolved', 'cargo-ambiguous']);

  const noCase = A.resolveAnnotation(callout('c', onCargo('inst-1')), context({ getCase: () => null }));
  assert.deepEqual([noCase.status, noCase.reason], ['unresolved', 'case-missing'], 'a missing Case definition cannot verify the point');

  const floor = M.buildFloorAnchor({ surface: 'main', point: { x: 100, y: 0, z: 0 } });
  assert.equal(A.resolveAnnotation(callout('f', floor), context()).status, 'valid');
  assert.deepEqual(
    [A.resolveAnnotation(callout('f', floor), context({ floors: [] })).status, A.resolveAnnotation(callout('f', floor), context({ floors: [] })).reason],
    ['unresolved', 'floor-missing']);

  const unreadable = A.resolveAnnotation(A.normalizeAnnotations([{ id: 'u' }])[0], context());
  assert.deepEqual([unreadable.status, unreadable.reason, unreadable.point], ['unresolved', 'unreadable', null]);

  for (const reason of ['cargo-missing', 'cargo-ambiguous', 'case-missing', 'case-changed', 'pose-invalid', 'floor-missing', 'floor-changed', 'truck-changed', 'truck-unverified', 'point-invalid', 'unreadable']) {
    assert.ok(A.describeAnnotationReason(reason).length > 20, `${reason} is explained`);
  }
  assert.equal(A.describeAnnotationReason('nonsense'), '');
  assert.deepEqual([A.annotationStatusLabel('valid'), A.annotationStatusLabel('needs-review'), A.annotationStatusLabel('unresolved')], ['Valid', 'Needs review', 'Unresolved']);
});

test('a non-finite resolved position is Unresolved, never a number', () => {
  const overflow = { ...instance(), transform: { position: { x: Number.MAX_VALUE, y: Number.MAX_VALUE, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
  // 24 + MAX_VALUE is still finite, so force the guard through a rotation that overflows the sum.
  const huge = { ...overflow, transform: { ...overflow.transform, rotation: { x: 0, y: 0, z: Math.PI / 2 } } };
  const resolved = A.resolveAnnotation(callout('h', onCargo('inst-1', { x: 24, y: 2, z: 3 })), context({ getInstance: () => huge }));
  assert.ok(resolved.status === 'valid' ? Number.isFinite(resolved.point.x) && Number.isFinite(resolved.point.y) : resolved.point === null);
  assert.deepEqual(A.resolveAnnotationList([callout('a'), { id: 'junk' }], context()).map(r => r.status), ['valid', 'unresolved']);
});

// ============================================================================
// SECTION: CARGO IDENTITY (duplicate, import, normalization)
// ============================================================================

test('remapping follows the one identity policy and leaves everything else untouched', () => {
  const list = [callout('a', onCargo(' old-1 ')), callout('b', onCargo('stranger')), callout('c', ground(1, 1))];
  const remapped = A.remapAnnotationInstanceIds(list, new Map([['old-1', 'new-1']]));
  assert.equal(remapped[0].anchor.instanceId, 'new-1', 'a trimmed-equal ID follows the map');
  assert.equal(remapped[1].anchor.instanceId, 'stranger', 'an anchor the map does not know stays as it is (Unresolved), never guessed');
  assert.equal(remapped[2], A.normalizeAnnotations(list)[2]);
  const untouched = A.remapAnnotationInstanceIds(list, new Map());
  assert.equal(untouched, A.normalizeAnnotations(list), 'nothing changed: the normalized list itself is returned');
  assert.equal(A.remapAnnotationInstanceIds(undefined, new Map([['a', 'b']])).length, 0);
  assert.equal(A.remapAnnotationInstanceIds(list, { 'old-1': 'plain-object' })[0].anchor.instanceId, 'plain-object');
});

test('an annotation on a contested ID is withheld whole and verbatim, so the survivor never inherits it', () => {
  const identity = M.canonicalizeInstanceIds(['cargo', ' cargo '], () => 'minted', [true, false]);
  assert.deepEqual([...identity.contestedKeys], ['cargo']);
  const raw = [callout('contested', onCargo(' cargo ')), callout('fine', ground(2, 2)), callout('other', onCargo('elsewhere'))];
  const carried = A.carryAnnotationsThroughIdentity(raw, identity);
  assert.equal(carried[0].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(carried[0].original, raw[0], 'the original record is preserved verbatim');
  assert.equal(carried[1].type, A.ANNOTATION_TYPE_CALLOUT);
  assert.equal(carried[2].anchor.instanceId, 'elsewhere', 'a dangling reference is left as it is');
  assert.equal(A.carryAnnotationsThroughIdentity(carried, identity)[0].type, A.ANNOTATION_TYPE_UNREADABLE, 'idempotent');
  const clean = M.canonicalizeInstanceIds(['a', 'b'], () => 'minted');
  assert.equal(A.carryAnnotationsThroughIdentity(raw, clean), A.remapAnnotationInstanceIds(raw, clean.idMap));
});

// ============================================================================
// SECTION: ARROWS (V1B.1) — record, gates, identity, resolution
// ============================================================================

const FLOOR_ANCHOR = M.buildFloorAnchor({ surface: 'main', point: { x: 100, y: 0, z: 0 } });
const arrow = (id, start = ground(5, 5), end = ground(40, 5), extra = {}) => A.createArrowRecord({ id, start, end, now: 1000, ...extra });
const ARROW_KEYS = ['color', 'createdAt', 'end', 'hidden', 'id', 'schemaVersion', 'start', 'type', 'updatedAt', 'width'];

test('an arrow is exactly the contracted record: two independent anchors, presentation only, nothing derived', () => {
  const made = arrow('a1', onCargo('inst-1'), FLOOR_ANCHOR, { color: '#A1B2C3', width: 'bold' });
  assert.deepEqual(Object.keys(made).sort(), ARROW_KEYS);
  assert.deepEqual([made.type, made.schemaVersion, made.color, made.width, made.hidden, made.createdAt, made.updatedAt], ['arrow', 1, '#a1b2c3', 'bold', false, 1000, 1000]);
  assert.equal(A.ANNOTATION_SCHEMA_VERSION, 1, 'the schema version is unchanged');
  const defaults = arrow('a2');
  assert.deepEqual([defaults.color, defaults.width, defaults.hidden], ['ink', 'regular', false]);
  assert.deepEqual([...A.ARROW_WIDTHS], ['thin', 'regular', 'bold']);
  assert.equal(A.validateArrowRecord(made), null);
  for (const key of ['label', 'title', 'offset', 'status', 'length', 'anchor']) assert.equal(Object.hasOwn(made, key), false, `no ${key}`);
  assert.deepEqual(A.normalizeAnnotations([made]), [made], 'canonical form is the record itself');
  assert.deepEqual(A.validateAnnotationCollection([made]).annotations, [made]);
  assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify([made]))), [made], 'survives a JSON round trip exactly');
  // An invalid value is kept as given so the gate refuses the write; it is never replaced by a default.
  assert.notEqual(A.validateArrowRecord(arrow('w', ground(1, 1), ground(9, 9), { width: 'huge' })), null);
  assert.notEqual(A.validateArrowRecord(arrow('c', ground(1, 1), ground(9, 9), { color: 'pink' })), null);
});

test('arrow validation names the first problem, rejects unknown top-level keys and leaves callout validation alone', () => {
  const ok = arrow('v', onCargo('inst-1'), ground(40, 5));
  const bad = (patch, pattern) => assert.match(A.validateArrowRecord({ ...ok, ...patch }) || '', pattern, JSON.stringify(patch).slice(0, 60));
  bad({ id: '' }, /id/);
  bad({ id: 'x'.repeat(65) }, /id/);
  bad({ type: 'callout' }, /type/);
  bad({ schemaVersion: 2 }, /schemaVersion/);
  bad({ color: 'pink' }, /color/);
  bad({ color: '#12' }, /color/);
  bad({ width: 'huge' }, /width/);
  bad({ width: undefined }, /width/);
  bad({ width: 3 }, /width/);
  bad({ hidden: 1 }, /flags/);
  bad({ createdAt: 'now' }, /timestamps/);
  bad({ updatedAt: NaN }, /timestamps/);
  bad({ start: null }, /start/);
  bad({ end: { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } } }, /end\.surface/);
  bad({ start: { ...onCargo('inst-1'), local: { x: 0, y: 0, z: 0 } } }, /start is not on the surface/);
  bad({ label: 'Door' }, /unsupported field/);
  bad({ title: 'x' }, /unsupported field/);
  bad({ anchor: ground(1, 1) }, /unsupported field/);
  bad({ end: ok.start }, /same point/);
  bad({ end: { ...ok.start, junk: 1 } }, /same point/);
  assert.match(A.validateArrowRecord(JSON.parse('{"__proto__": {"x": 1}, "id": "p", "type": "arrow", "schemaVersion": 1}')) || '', /unsupported field/, 'a __proto__ key is just an unknown key');
  assert.match(A.validateArrowRecord(null), /object/);
  // Callouts: the V1A validator is unchanged and still refuses an arrow as "not a callout".
  assert.match(A.validateCalloutRecord(ok), /type/);
  assert.match(A.validateArrowRecord(callout('c')), /type/);
});

test('lenient normalization keeps a valid arrow, wraps every unreadable one verbatim and never converts a wrapper', () => {
  const good = arrow('good', onCargo('inst-1'), FLOOR_ANCHOR);
  const malformed = { ...arrow('bad'), width: 'huge' };
  const extra = { ...arrow('extra'), label: 'Door', note: { nested: true } };
  const newer = { ...arrow('newer'), schemaVersion: 9 };
  const sameEnds = { ...arrow('same'), end: ground(5, 5) };
  const legacy = { id: 'arrow-1', type: 'arrow', schemaVersion: 1 };
  const draw = { id: 'drw', type: 'draw', schemaVersion: 1, points: [1, 2] };
  const list = [good, malformed, extra, newer, sameEnds, legacy, draw, callout('c')];
  const frozen = JSON.stringify(list);
  const out = A.normalizeAnnotations(list);
  assert.equal(JSON.stringify(list), frozen, 'the stored input is not mutated');
  assert.equal(out.length, list.length, 'nothing is dropped');
  assert.deepEqual(out[0], good);
  assert.deepEqual(out.slice(1, 7).map(r => r.type), Array(6).fill(A.ANNOTATION_TYPE_UNREADABLE));
  assert.deepEqual([malformed, extra, newer, sameEnds, legacy, draw].map((original, i) => out[i + 1].original), [malformed, extra, newer, sameEnds, legacy, draw],
    'every original is preserved verbatim, including an unknown key');
  assert.equal(out[2].original.note.nested, true);
  assert.equal(out[1].reason, 'The saved annotation could not be read.', 'a malformed arrow is damaged, not "from a newer version"');
  assert.equal(out[2].reason, 'The saved annotation could not be read.');
  assert.equal(out[3].reason, 'Saved by a newer version of the app.', 'a later schemaVersion is');
  assert.equal(out[6].reason, 'The saved annotation could not be read.', 'a malformed draw is damaged, and no longer a reserved future type');
  assert.equal(out[7].type, A.ANNOTATION_TYPE_CALLOUT);
  assert.equal(new Set(out.map(r => r.id)).size, out.length);
  assert.equal(A.normalizeAnnotations(out), out, 'idempotent');
  assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify(out))), out);
  // Arrow and callout share one ID space.
  const twin = A.normalizeAnnotations([callout('same-id'), arrow('same-id')]);
  assert.deepEqual([twin[0].type, twin[1].type, twin[1].reason], ['callout', 'unreadable', 'Duplicate annotation ID in this Load Plan.']);
  assert.deepEqual(twin[1].original, arrow('same-id'));
});

test('an unreadable wrapper stays inert even when its original is a valid arrow with a unique current holder', () => {
  const inner = arrow('inner', onCargo('inst-1'), FLOOR_ANCHOR);
  const wrapper = { id: 'w', type: 'unreadable', schemaVersion: 1, reason: 'Saved by a newer version of the app.', original: inner };
  const ctx = context();
  assert.equal(A.resolveAnnotation(A.normalizeAnnotations([wrapper])[0], ctx).status, 'unresolved', 'the wrapped arrow is not drawable');
  assert.equal(A.resolveAnnotation(inner, ctx).status, 'valid', 'control: the same arrow outside a wrapper resolves');
  const normalized = A.normalizeAnnotations([wrapper]);
  assert.deepEqual(normalized, [wrapper], 'not converted');
  assert.deepEqual(A.validateAnnotationCollection([wrapper]).annotations, [wrapper], 'import and restore accept it verbatim');
  const identity = M.canonicalizeInstanceIds(['inst-1'], () => 'minted');
  assert.deepEqual(A.carryAnnotationsThroughIdentity([wrapper], identity), [wrapper], 'identity decisions never reach inside a wrapper');
  assert.deepEqual(A.remapAnnotationInstanceIds([wrapper], new Map([['inst-1', 'other']])), [wrapper], 'nor does a duplicate or import remap');
  const contested = M.canonicalizeInstanceIds(['inst-1', ' inst-1 '], () => 'minted', [true, false]);
  assert.deepEqual(A.carryAnnotationsThroughIdentity([wrapper], contested), [wrapper], 'a contested key does not re-wrap or unwrap it either');
  // A wrapper whose original is a callout is just as inert.
  const calloutWrapper = { id: 'cw', type: 'unreadable', schemaVersion: 1, reason: 'x', original: callout('inner-c', onCargo('inst-1')) };
  assert.deepEqual(A.normalizeAnnotations([calloutWrapper]), [calloutWrapper]);
});

test('strict validation accepts arrows and wrappers, rejects anything unreadable or of an unknown type, and shares the 200 cap', () => {
  const good = arrow('g', onCargo('inst-1'), ground(40, 5));
  const dangling = arrow('d', onCargo('gone'), FLOOR_ANCHOR);
  const wrapper = A.normalizeAnnotations([{ id: 'x' }])[0];
  const mixed = A.validateAnnotationCollection([callout('c'), good, dangling, wrapper]);
  assert.equal(mixed.ok, true, 'a reference to missing cargo is valid, resolved as Unresolved later');
  assert.deepEqual(mixed.annotations, [callout('c'), good, dangling, wrapper]);
  const err = entry => A.validateAnnotationCollection([callout('c'), entry]).error || '';
  assert.match(err({ ...good, width: 'huge' }), /annotations\[1\] width is invalid/);
  assert.match(err({ ...good, label: 'x' }), /annotations\[1\] record has an unsupported field/);
  assert.match(err({ ...good, schemaVersion: 2 }), /annotations\[1\] schemaVersion/);
  assert.match(err({ ...good, end: good.start }), /annotations\[1\] start and end are the same point/);
  assert.match(err({ id: 'drw', type: 'draw', schemaVersion: 1, points: [] }), /annotations\[1\] color is invalid/, 'a malformed draw is refused by the draw rules');
  assert.match(err({ id: 'sk', type: 'sketch', schemaVersion: 1, points: [] }), /annotations\[1\] type is not supported/, 'a type this version does not know is refused');
  assert.match(A.validateAnnotationCollection([callout('c'), { ...good, id: 'c' }]).error, /duplicate annotation id "c"/);
  const callouts = n => Array.from({ length: n }, (_, i) => callout(`c${i}`, ground(i, 1)));
  assert.equal(A.validateAnnotationCollection([...callouts(199), good]).annotations.length, 200, 'callouts and arrows share one cap');
  assert.match(A.validateAnnotationCollection([...callouts(200), good]).error, /too many annotations \(201; maximum 200\)/);
  assert.match(A.validateAnnotationCollection([good, ...callouts(199), wrapper]).error, /too many annotations/, 'recovery records count too');
});

test('editing an arrow changes only presentation; moving an endpoint changes only that endpoint', () => {
  const base = arrow('e', onCargo('inst-1'), ground(40, 5));
  const edited = A.editArrowRecord(base, { color: '#00FF7F', width: 'thin', hidden: true, id: 'hijack', start: FLOOR_ANCHOR, type: 'callout' }, 5000);
  assert.deepEqual([edited.color, edited.width, edited.hidden], ['#00ff7f', 'thin', true]);
  assert.deepEqual([edited.id, edited.type, edited.createdAt, edited.updatedAt], ['e', 'arrow', 1000, 5000]);
  assert.deepEqual([edited.start, edited.end], [base.start, base.end], 'unknown patch keys (id, start, type) are ignored');
  assert.equal(A.editArrowRecord(base, { width: 'huge' }, 5000), null);
  assert.equal(A.editArrowRecord(base, { color: 'url(x)' }, 5000), null);
  assert.equal(A.editArrowRecord(base, { color: 'violet' }, 5000).color, 'violet');
  assert.equal(A.editArrowRecord(base, { width: 'bold' }, NaN), null);
  assert.equal(A.editArrowRecord(callout('c'), { width: 'bold' }, 5000), null, 'only an arrow can be edited as one');
  assert.equal(A.editArrowRecord(base, null, 5000), null);

  const moved = A.replaceArrowEndpoint(base, 'end', FLOOR_ANCHOR, 7000);
  assert.deepEqual([moved.start, moved.end], [base.start, FLOOR_ANCHOR]);
  assert.deepEqual([moved.color, moved.width, moved.id, moved.createdAt, moved.updatedAt], [base.color, base.width, 'e', 1000, 7000]);
  assert.deepEqual(A.replaceArrowEndpoint(base, 'start', ground(9, 9), 7000).end, base.end, 'the other end is untouched');
  assert.equal(A.replaceArrowEndpoint(base, 'middle', FLOOR_ANCHOR, 7000), null);
  assert.equal(A.replaceArrowEndpoint(base, 'end', { kind: 'space', surface: 'sky', position: { x: 0, y: 0, z: 0 } }, 7000), null);
  assert.equal(A.replaceArrowEndpoint(base, 'end', { ...onCargo('inst-1'), local: { x: 0, y: 0, z: 0 } }, 7000), null, 'a point off the cargo surface is refused');
  assert.equal(A.replaceArrowEndpoint(base, 'end', base.start, 7000), null, 'both ends cannot name the same point');
  assert.equal(A.replaceArrowEndpoint(callout('c'), 'end', FLOOR_ANCHOR, 7000), null);
  assert.equal(A.replaceArrowEndpoint(base, 'end', FLOOR_ANCHOR, NaN), null);
});

test('arrow resolution is the worst of its two ends and carries positions only when both are Valid', () => {
  const resolve = (record, overrides) => A.resolveAnnotation(record, context(overrides));
  const ok = resolve(arrow('a', onCargo('inst-1'), ground(10, 20)));
  assert.deepEqual([ok.status, ok.reason, ok.point, ok.start, ok.end], ['valid', null, null, { x: 84, y: 102, z: 3 }, { x: 10, y: 0, z: 20 }]);
  assert.deepEqual([ok.startStatus, ok.endStatus, ok.startReason, ok.endReason], ['valid', 'valid', null, null]);
  assert.equal(resolve(arrow('a', onCargo('inst-1'), FLOOR_ANCHOR)).status, 'valid', 'cargo to floor');
  const surface = M.buildSpaceAnchor({ surface: 'ground', point: { x: 3, y: 0, z: 3 } });
  assert.equal(resolve(arrow('a', surface, onCargo('inst-1'))).status, 'valid', 'space to cargo');

  const missing = resolve(arrow('a', onCargo('inst-1'), ground(10, 20)), { getInstance: () => null });
  assert.deepEqual([missing.status, missing.reason, missing.start, missing.end], ['unresolved', 'cargo-missing', null, null], 'no half arrow');
  assert.deepEqual([missing.startStatus, missing.startReason, missing.endStatus, missing.endReason], ['unresolved', 'cargo-missing', 'valid', null], 'the broken end is named');
  const resized = resolve(arrow('a', ground(10, 20), onCargo('inst-1')), { getCase: () => ({ ...CASE, dimensions: { ...CASE.dimensions, length: 60 } }) });
  assert.deepEqual([resized.status, resized.reason, resized.start, resized.endStatus, resized.endReason], ['needs-review', 'case-changed', null, 'needs-review', 'case-changed']);
  const bothWays = resolve(arrow('a', onCargo('inst-1'), onCargo('inst-2')), {
    getInstance: id => (id === 'inst-1' ? instance() : null), getCase: () => ({ ...CASE, dimensions: { ...CASE.dimensions, length: 60 } }),
  });
  assert.deepEqual([bothWays.status, bothWays.startStatus, bothWays.endStatus, bothWays.reason], ['unresolved', 'needs-review', 'unresolved', 'cargo-missing'], 'Unresolved dominates Needs Review');
  const ambiguous = resolve(arrow('a', onCargo('inst-1'), ground(10, 20)), { isInstanceAmbiguous: () => true });
  assert.deepEqual([ambiguous.status, ambiguous.reason], ['unresolved', 'cargo-ambiguous']);
  const noFloor = resolve(arrow('a', ground(10, 20), FLOOR_ANCHOR), { floors: [] });
  assert.deepEqual([noFloor.status, noFloor.reason, noFloor.endReason], ['unresolved', 'floor-missing', 'floor-missing']);
  assert.deepEqual(A.resolveAnnotationList([arrow('a'), callout('c'), { id: 'junk' }], context()).map(r => r.status), ['valid', 'valid', 'unresolved']);
  assert.deepEqual(A.resolveAnnotation(callout('c'), context()).point, { x: 5, y: 0, z: 5 }, 'a callout resolves exactly as before');
});

test('each arrow end follows its own cargo through remapping; an unmapped end is never guessed', () => {
  const both = arrow('both', onCargo(' old-1 '), onCargo('old-2'));
  const mixed = arrow('mixed', onCargo('old-1'), FLOOR_ANCHOR);
  const space = arrow('space', ground(1, 1), onCargo(' old-2 '));
  const partial = arrow('partial', onCargo('old-1'), onCargo('stranger'));
  const map = new Map([['old-1', 'new-1'], ['old-2', 'new-2']]);
  const out = A.remapAnnotationInstanceIds([both, mixed, space, partial, callout('c', onCargo('old-1'))], map);
  assert.deepEqual([out[0].start.instanceId, out[0].end.instanceId], ['new-1', 'new-2'], 'both ends, independently');
  assert.deepEqual([out[1].start.instanceId, out[1].end], ['new-1', FLOOR_ANCHOR], 'cargo to floor: the floor end is untouched');
  assert.deepEqual([out[2].start, out[2].end.instanceId], [ground(1, 1), 'new-2'], 'space to cargo');
  assert.deepEqual([out[3].start.instanceId, out[3].end.instanceId], ['new-1', 'stranger'], 'an end the map does not know stays exactly as it is');
  assert.equal(out[4].anchor.instanceId, 'new-1', 'callouts remap as before');
  assert.deepEqual(out[0].start.local, both.start.local, 'only the instance ID changes');
  const unchanged = [mixed, space];
  assert.equal(A.remapAnnotationInstanceIds(unchanged, new Map()), A.normalizeAnnotations(unchanged), 'nothing changed: the normalized list itself is returned');
  const swapped = A.remapAnnotationInstanceIds([both], new Map([['old-1', 'old-2'], ['old-2', 'old-1']]))[0];
  assert.deepEqual([swapped.start.instanceId, swapped.end.instanceId], ['old-2', 'old-1'], 'a swap is applied once, never chained');
});

test('an arrow with either end on a contested ID is withheld whole and verbatim; ambiguous and missing cargo stay arrows', () => {
  const identity = M.canonicalizeInstanceIds(['cargo', ' cargo ', 'other'], () => 'minted', [true, false, true]);
  assert.deepEqual([...identity.contestedKeys], ['cargo']);
  const carryIdentity = { idMap: new Map([['other', 'other-2']]), contestedKeys: identity.contestedKeys };
  const raw = [
    arrow('start-contested', onCargo(' cargo '), ground(40, 5)),
    arrow('end-contested', ground(40, 5), onCargo('cargo')),
    arrow('half-remap', onCargo('other'), onCargo(' cargo ')),
    arrow('fine', onCargo('other'), ground(40, 5)),
    arrow('dangling', onCargo('elsewhere'), FLOOR_ANCHOR),
  ];
  const carried = A.carryAnnotationsThroughIdentity(raw, carryIdentity);
  assert.deepEqual(carried.slice(0, 3).map(r => r.type), Array(3).fill(A.ANNOTATION_TYPE_UNREADABLE));
  assert.deepEqual(carried.slice(0, 3).map(r => r.original), raw.slice(0, 3), 'the pre-remap record is preserved, including the end that did map');
  assert.equal(carried[2].original.start.instanceId, 'other', 'the end that would have been remapped was not');
  assert.match(carried[0].reason, /shared its ID with another cargo item/);
  assert.equal(carried[3].type, A.ANNOTATION_TYPE_ARROW);
  assert.equal(carried[3].start.instanceId, 'other-2', 'an unaffected arrow still follows the map');
  assert.equal(carried[4].start.instanceId, 'elsewhere', 'a dangling reference is left as it is');
  assert.equal(new Set(carried.map(r => r.id)).size, carried.length);
  assert.deepEqual(A.carryAnnotationsThroughIdentity(carried, carryIdentity), carried, 'idempotent');
  const clean = M.canonicalizeInstanceIds(['a', 'b'], () => 'minted');
  assert.equal(A.carryAnnotationsThroughIdentity(raw, clean), A.remapAnnotationInstanceIds(raw, clean.idMap), 'no contested key: the plain remap');
  // Survivors that share an ID are neither mapped nor contested: the arrow is kept and resolves as ambiguous.
  const shared = M.canonicalizeInstanceIds(['dup', 'dup'], () => 'minted');
  assert.equal(shared.idMap.size, 0);
  assert.equal(shared.contestedKeys.size, 0);
  const kept = A.carryAnnotationsThroughIdentity([arrow('amb', onCargo('dup'), ground(40, 5))], shared)[0];
  assert.equal(kept.type, A.ANNOTATION_TYPE_ARROW);
  assert.deepEqual(A.resolveAnnotation(kept, context({ isInstanceAmbiguous: () => true })).reason, 'cargo-ambiguous');
  // Missing cargo is derived, never a reason to wrap or reassign.
  assert.equal(A.resolveAnnotation(carried[4], context({ getInstance: () => null })).startReason, 'cargo-missing');
});

test('an arrow may be written only against ends that resolve and, when both do, at least half an inch apart', () => {
  const problem = (record, overrides, moved) => A.arrowPlacementProblem(record, context(overrides), moved);
  assert.equal(A.MIN_ARROW_LENGTH_INCHES, 0.5);
  assert.equal(problem(arrow('a', ground(5, 5), ground(40, 5))), null);
  assert.equal(problem(arrow('a', ground(5, 5), ground(5.5, 5))), null, 'exactly half an inch is long enough');
  assert.equal(problem(arrow('a', ground(5, 5), ground(5.4, 5))), 'too-short');
  assert.equal(problem(arrow('a', ground(5, 5), ground(5, 5.49))), 'too-short');
  const nearCargo = M.buildSpaceAnchor({ surface: 'free', point: { x: 84, y: 102.3, z: 3 } });
  assert.equal(problem(arrow('a', onCargo('inst-1'), nearCargo)), 'too-short', 'measured between the resolved points, whatever the anchor kinds');
  assert.equal(problem(arrow('a', onCargo('inst-1'), ground(10, 20)), { getInstance: () => null }), 'unresolved');
  assert.equal(problem(arrow('a', onCargo('inst-1'), ground(10, 20)), { isInstanceAmbiguous: () => true }), 'unresolved');
  assert.equal(problem(arrow('a', ground(10, 20), onCargo('inst-1')), { getCase: () => ({ ...CASE, shape: 'cylinder' }) }), 'unresolved', 'Needs Review is refused too');
  assert.equal(problem(arrow('a', ground(10, 20), FLOOR_ANCHOR), { floors: [] }), 'unresolved');
  // Moving one end: that end must resolve; a broken other end only means the length cannot be checked.
  const broken = arrow('m', onCargo('inst-1'), ground(40, 5));
  const gone = { getInstance: () => null };
  assert.equal(problem(arrow('m', ground(9, 9), ground(40, 5)), gone, 'start'), null);
  assert.equal(problem(broken, gone, 'start'), 'unresolved');
  assert.equal(problem(broken, gone, 'end'), null, 'repairing the healthy end of a broken arrow is allowed');
  assert.equal(problem(arrow('m', ground(9, 9), ground(9.2, 9)), {}, 'end'), 'too-short');
  assert.equal(problem(arrow('m', ground(9, 9), onCargo('inst-1')), gone, 'start'), null, 'the broken end is not the one being placed');
});

// ============================================================================
// SECTION: DISPLAY HELPERS
// ============================================================================

test('callouts are numbered in stored order and the attached-to line names the surface', () => {
  const list = A.normalizeAnnotations([callout('a'), { id: 'junk' }, callout('b'), callout('c')]);
  assert.deepEqual([...A.calloutNumbers(list)], [['a', 1], ['b', 2], ['c', 3]], 'unreadable records take no number');
  assert.equal(A.describeAnchorTarget(onCargo('i'), 'Amp Rack 02'), 'Amp Rack 02');
  assert.equal(A.describeAnchorTarget(onCargo('i')), 'Cargo');
  const surfaces = { main: 'Truck floor', 'well-top': 'Wheel Well top', deck: 'Over-cab deck' };
  for (const [surface, label] of Object.entries(surfaces)) assert.equal(A.describeAnchorTarget({ kind: 'floor', surface }), label);
  for (const surface of M.SPACE_SURFACES) assert.ok(A.describeAnchorTarget({ kind: 'space', surface }).length > 2, surface);
  assert.equal(A.describeAnchorTarget(null), '');
});

// ============================================================================
// SECTION: LAYOUT
// ============================================================================

const VIEW = { width: 848, height: 778 };

test('the card budget follows the viewport area: about nine on a desktop, two on a phone', () => {
  assert.equal(L.cardBudget(848, 778), 9);
  assert.equal(L.cardBudget(1200, 900), 9, 'capped');
  assert.equal(L.cardBudget(366, 718), 2);
  assert.equal(L.cardBudget(300, 200), 2, 'never below two');
  assert.equal(L.cardBudget(0, 0), 2);
  assert.equal(L.cardBudget(640, 300), 2);
  assert.equal(L.cardBudget(900, 400), 5);
  assert.deepEqual([L.isCompactViewport(499), L.isCompactViewport(500), L.cardWidth(390), L.cardWidth(800)], [true, false, 176, 208]);
});

test('a stored offset puts the card at marker + offset, clamped for display only', () => {
  const marker = { x: 400, y: 300 };
  const size = { w: 208, h: 90 };
  assert.deepEqual(L.rectFromOffset(marker, { dx: 30, dy: -120 }, size, VIEW), { x: 430, y: 180, w: 208, h: 90 });
  // Near the right edge the card is pushed back inside; the stored offset is not rewritten.
  const edge = L.rectFromOffset({ x: 800, y: 300 }, { dx: 30, dy: 0 }, size, VIEW);
  assert.equal(edge.x + edge.w, VIEW.width - L.VIEWPORT_MARGIN);
  const top = L.rectFromOffset({ x: 400, y: 20 }, { dx: 0, dy: -200 }, size, VIEW);
  assert.equal(top.y, L.VIEWPORT_MARGIN);
  // Round trip: the offset that reproduces a rect is the one stored.
  const rect = { x: 430, y: 180, w: 208, h: 90 };
  assert.deepEqual(L.rectFromOffset(marker, L.offsetFromRect(marker, rect), size, VIEW), rect);
  assert.deepEqual(L.offsetFromRect({ x: 10.04, y: 20 }, { x: 20, y: 10, w: 1, h: 1 }), { dx: 10, dy: -10 });
  // A viewport smaller than the card pins it to the top-left margin instead of producing negatives.
  assert.deepEqual(L.clampRect({ x: 300, y: 300, w: 400, h: 400 }, { width: 200, height: 200 }), { x: 8, y: 8, w: 400, h: 400 });
  // A camera move shifts the marker and the card follows with the same offset.
  const moved = L.rectFromOffset({ x: 410, y: 310 }, { dx: 30, dy: -120 }, size, VIEW);
  assert.deepEqual([moved.x - 430, moved.y - 180], [10, 10]);
});

test('automatic placement avoids other cards and markers, stays inside the viewport and is stable until it must move', () => {
  const marker = { x: 400, y: 300 };
  const size = { w: 208, h: 70 };
  const first = L.autoPlace({ marker, size, viewport: VIEW });
  assert.equal(first.slot, 0, 'up and to the right of the marker when nothing is in the way');
  assert.ok(first.x >= marker.x && first.y + first.h <= marker.y, 'above-right');
  assert.ok(first.x >= L.VIEWPORT_MARGIN && first.x + first.w <= VIEW.width - L.VIEWPORT_MARGIN);
  // Another card there pushes this one to a different slot with no overlap.
  const second = L.autoPlace({ marker, size, viewport: VIEW, occupied: [first] });
  assert.notEqual(second.slot, first.slot);
  assert.equal(L.overlapArea(second, first), 0);
  // Stability: a previous slot that is still clean is kept even if an earlier slot is now free.
  const kept = L.autoPlace({ marker, size, viewport: VIEW, previousSlot: second.slot });
  assert.equal(kept.slot, second.slot);
  // ... and abandoned when it collides.
  const moved = L.autoPlace({ marker, size, viewport: VIEW, previousSlot: second.slot, occupied: [second] });
  assert.notEqual(moved.slot, second.slot);
  assert.equal(L.overlapArea(moved, second), 0);
  // Never sits on its own marker, even in a corner.
  const corner = L.autoPlace({ marker: { x: 20, y: 20 }, size, viewport: VIEW });
  assert.ok(!(corner.x - 4 < 20 && 20 < corner.x + corner.w + 4 && corner.y - 4 < 20 && 20 < corner.y + corner.h + 4));
  // Out-of-range or non-integer previous slots are ignored.
  for (const previousSlot of [-1, 99, 1.5, null, 'x']) assert.equal(L.autoPlace({ marker, size, viewport: VIEW, previousSlot }).slot, 0);
  // With every slot crowded the least bad one is returned, still inside the viewport.
  const crowd = Array.from({ length: 30 }, (_, i) => ({ x: (i % 6) * 140, y: Math.floor(i / 6) * 150, w: 140, h: 150 }));
  const worst = L.autoPlace({ marker, size, viewport: VIEW, occupied: crowd });
  assert.ok(worst.x >= L.VIEWPORT_MARGIN && worst.y >= L.VIEWPORT_MARGIN);
  assert.equal(typeof worst.slot, 'number');
});

test('the editor card keeps clear of the AutoPack Results card wherever it is, never rewrites its position and gives up height before it hides a button', () => {
  const view = { width: 1200, height: 800 };
  const card = { x: 400, y: 380, w: 336, h: 404 };
  const results = { x: 390, y: 520, w: 420, h: 270 }; // the expanded card, bottom centre
  const gap = L.OBSTACLE_GAP;
  const sits = (rect, other) => L.overlapArea(rect, { x: other.x - gap, y: other.y - gap, w: other.w + 2 * gap, h: other.h + 2 * gap });
  // Nothing in the way: the same rect comes back untouched and nothing is limited.
  const alone = L.clearOfBlockers(card, [], view);
  assert.deepEqual([alone.x, alone.y, alone.w, alone.h, alone.shrunk, alone.clear], [400, 380, 336, 404, false, true]);
  assert.deepEqual(L.clearOfBlockers(card, [{ x: 1000, y: 10, w: 100, h: 40 }], view).y, 380, 'a distant obstacle changes nothing');
  // Covered by Results: the card moves the shortest way to a spot that overlaps nothing, full size.
  const pushed = L.clearOfBlockers(card, [results], view);
  assert.equal(pushed.clear, true);
  assert.equal(pushed.shrunk, false);
  assert.equal(sits(pushed, results), 0, 'no overlap with Results, with breathing room');
  assert.deepEqual([pushed.w, pushed.h], [336, 404], 'full size');
  assert.ok(pushed.x >= L.VIEWPORT_MARGIN && pushed.y >= L.VIEWPORT_MARGIN && pushed.x + pushed.w <= view.width - L.VIEWPORT_MARGIN && pushed.y + pushed.h <= view.height - L.VIEWPORT_MARGIN, 'and inside the viewport');
  // The input is never mutated, so a stored position survives the obstacle moving away.
  assert.deepEqual(card, { x: 400, y: 380, w: 336, h: 404 });
  assert.deepEqual(L.clearOfBlockers(card, [{ ...results, y: 790 }], view).y, 380, 'moving Results away leaves the stored place as it was');
  // A minimized chip and the restore button are obstacles too, wherever they are dragged.
  for (const spot of [{ x: 420, y: 400, w: 190, h: 44 }, { x: 8, y: 700, w: 36, h: 36 }, { x: 600, y: 8, w: 420, h: 270 }]) {
    const placed = L.clearOfBlockers({ x: spot.x - 20, y: spot.y - 20, w: 336, h: 404 }, [spot], view);
    assert.equal(placed.clear && sits(placed, spot), 0);
  }
  // Results dragged onto the card from either side keeps pushing it clear.
  for (const x of [0, 200, 500, 780]) {
    const placed = L.clearOfBlockers(card, [{ ...results, x }], view);
    assert.equal(sits(placed, { ...results, x }), 0, `Results at x=${x}`);
  }
  // No full-size spot: a viewport 560px wide cannot fit the card beside or below Results, so it keeps its width
  // and gives up height above it. The buttons live outside the scrolling body, so a shorter card loses no button.
  const short = { width: 560, height: 700 };
  const wide = { x: 70, y: 380, w: 420, h: 300 };
  const squeezed = L.clearOfBlockers({ x: 100, y: 250, w: 336, h: 404 }, [wide], short);
  assert.equal(squeezed.clear, true);
  assert.equal(squeezed.shrunk, true);
  assert.ok(squeezed.h >= L.MIN_EDITOR_HEIGHT && squeezed.h < 404, 'shorter, not unusably short');
  assert.equal(sits(squeezed, wide), 0);
  assert.equal(squeezed.w, 336, 'the width is kept');
  // Truly nowhere to go: reported as not clear so the caller can use the sheet instead of covering controls.
  const nowhere = L.clearOfBlockers({ x: 100, y: 100, w: 336, h: 404 }, [{ x: 0, y: 0, w: 560, h: 700 }], short);
  assert.equal(nowhere.clear, false);
  // Garbage obstacles (zero size, NaN) are ignored rather than trusted.
  assert.equal(L.clearOfBlockers(card, [{ x: 1, y: 1, w: 0, h: 0 }, { x: NaN, y: 0, w: 5, h: 5 }, null], view).y, 380);
});

test('the desktop editor never lands under the Annotations panel: it keeps clear while there is room, relaxes its marker first, and otherwise the panel yields', () => {
  const touches = (a, b) => L.overlapArea(a, b) > 0;
  // N01: 1100x620 with both sidebars open (a 556x538 canvas), expanded Results at its default spot and a 213px panel above it.
  const view = { width: 556, height: 538 };
  const panel = { x: 197, y: 65, w: 300, h: 213 };
  const results = { x: 68, y: 284, w: 420, h: 237 };
  const preferred = { x: 211, y: 9, w: 336, h: 269 };
  const marker = { x: 260, y: 150, w: 22, h: 22 };
  const stack = { x: 508, y: 180, w: 36, h: 180 }; // the viewport control stack down the right-hand edge
  const tight = L.fitEditorClear({ rect: preferred, viewport: view, panel: [panel], results: [results], marker: [marker], controls: [stack] });
  assert.equal(tight.fit.clear, true, 'there is a spot clear of Results');
  assert.equal(touches(tight.fit, results), false, 'Results never covers the card');
  assert.equal(tight.coversPanel, true, 'with no room beside the panel the panel is the one that yields, and the caller is told');
  assert.equal(touches(tight.fit, panel), true, '(and that is a real overlap: the previous placement hid the card under the panel)');
  assert.equal(touches(tight.fit, stack), false, 'once the panel yields the end of Save is not left under the viewport controls either');
  assert.equal(tight.fit.y, preferred.y, 'it only slides sideways, staying at its preferred height');
  assert.equal(L.fitEditorClear({ rect: preferred, viewport: view, panel: [panel], results: [results], marker: [marker] }).fit.x, preferred.x, 'with no controls to avoid it keeps its preferred place');

  // Room beside the panel: the card goes there and the panel is untouched.
  const roomy = L.fitEditorClear({ rect: { x: 400, y: 70, w: 336, h: 269 }, viewport: { width: 1200, height: 800 }, panel: [{ x: 850, y: 64, w: 300, h: 213 }], results: [{ x: 300, y: 560, w: 420, h: 237 }], marker: [marker], controls: [{ x: 1152, y: 300, w: 36, h: 180 }] });
  assert.equal(roomy.fit.clear, true);
  assert.equal(roomy.coversPanel, false, 'where it fits beside the panel it never hides it');
  assert.equal(touches(roomy.fit, { x: 850, y: 64, w: 300, h: 213 }), false);

  // The marker is relaxed before the panel: no spot is clear of both, so the card sits on its marker rather than hide the panel.
  const wideMarker = { x: 20, y: 100, w: 40, h: 22 };
  const sidePanel = { x: 392, y: 64, w: 300, h: 213 };
  const squeezed = L.fitEditorClear({ rect: { x: 8, y: 8, w: 336, h: 269 }, viewport: { width: 700, height: 330 }, panel: [sidePanel], marker: [wideMarker] });
  assert.equal(squeezed.fit.clear, true);
  assert.equal(squeezed.coversPanel, false, 'the panel stays');
  assert.equal(touches(squeezed.fit, sidePanel), false);
  assert.equal(touches(squeezed.fit, wideMarker), true, 'the marker is what was given up');

  // A card the owner placed keeps its spot over the panel (the panel yields); it moves only for Results.
  const dragged = { x: 600, y: 70, w: 336, h: 269 };
  const ownerOnPanel = L.fitEditorClear({ rect: dragged, viewport: { width: 1000, height: 700 }, panel: [{ x: 640, y: 64, w: 300, h: 213 }], ownerPlaced: true });
  assert.deepEqual([ownerOnPanel.fit.x, ownerOnPanel.fit.y], [dragged.x, dragged.y], 'the owner placement is respected');
  assert.equal(ownerOnPanel.coversPanel, true);
  const ownerOnResults = L.fitEditorClear({ rect: dragged, viewport: { width: 1000, height: 700 }, panel: [{ x: 640, y: 64, w: 300, h: 213 }], results: [{ x: 560, y: 120, w: 420, h: 237 }], ownerPlaced: true });
  assert.equal(ownerOnResults.fit.clear, true);
  assert.equal(touches(ownerOnResults.fit, { x: 560, y: 120, w: 420, h: 237 }), false, 'Results still wins over the owner placement');

  // Nowhere clear of Results: no spot, and nothing is claimed about the panel (the caller shows the sheet).
  const none = L.fitEditorClear({ rect: { x: 8, y: 8, w: 336, h: 269 }, viewport: { width: 400, height: 330 }, panel: [{ x: 90, y: 64, w: 300, h: 213 }], results: [{ x: 8, y: 40, w: 384, h: 270 }] });
  assert.equal(none.fit.clear, false);
  assert.equal(none.coversPanel, false);

  // Unusable rectangles are ignored, a missing panel is never "covered", and the inputs are never rewritten.
  assert.equal(L.fitEditorClear({ rect: preferred, viewport: view, panel: [null, { x: NaN, y: 0, w: 5, h: 5 }, { x: 0, y: 0, w: 0, h: 9 }], results: 'nope' }).coversPanel, false);
  assert.equal(L.fitEditorClear({ rect: preferred, viewport: view }).coversPanel, false);
  const inputs = { rect: { ...preferred }, viewport: { ...view }, panel: [{ ...panel }], results: [{ ...results }], marker: [{ ...marker }] };
  const frozen = JSON.parse(JSON.stringify(inputs));
  L.fitEditorClear(inputs);
  assert.deepEqual(inputs, frozen, 'pure: nothing it was given changes');
});

test('the narrow-viewport sheet sits above the AutoPack Results card, however it is moved, and limits its height instead of hiding a button', () => {
  const view = { width: 420, height: 800 };
  const natural = 440;
  const baseline = L.fitSheet({ viewport: view, blockers: [], height: natural });
  assert.deepEqual(baseline, { moved: false, bottom: L.SHEET_INSETS.bottom, maxHeight: Math.floor(800 * 0.84) }, 'no obstacle: the stylesheet placement stands');
  // Results across the bottom (its default): the sheet rides up above it.
  const bottomResults = { x: 16, y: 520, w: 388, h: 264 };
  const above = L.fitSheet({ viewport: view, blockers: [bottomResults], height: natural });
  assert.equal(above.moved, true);
  const aboveTop = view.height - above.bottom - Math.min(natural, above.maxHeight);
  assert.ok(view.height - above.bottom <= bottomResults.y - L.OBSTACLE_GAP + 1, 'the sheet ends above Results');
  assert.ok(aboveTop >= L.VIEWPORT_MARGIN, 'and starts inside the viewport');
  assert.ok(above.maxHeight >= L.MIN_EDITOR_HEIGHT, 'with room for the fields and the buttons');
  // Results dragged to the top: the default bottom placement is clear, so nothing moves.
  assert.equal(L.fitSheet({ viewport: view, blockers: [{ x: 16, y: 20, w: 388, h: 240 }], height: natural }).moved, false);
  // Results in the middle: the larger free stretch (below) wins when it is taller.
  const middle = L.fitSheet({ viewport: view, blockers: [{ x: 16, y: 120, w: 388, h: 300 }], height: natural });
  assert.equal(middle.moved, true);
  assert.ok(view.height - middle.bottom - middle.maxHeight >= 120 + 300 + L.OBSTACLE_GAP - 1 || view.height - middle.bottom <= 120 - L.OBSTACLE_GAP + 1, 'never overlaps Results');
  // Something that does not reach the sheet's band (the viewport controls column on the right) is ignored.
  assert.equal(L.fitSheet({ viewport: view, blockers: [{ x: 380, y: 700, w: 30, h: 60 }], height: natural }).moved, false);
  // Always the tallest stretch there is, even when it is shorter than a comfortable card.
  const cramped = L.fitSheet({ viewport: { width: 420, height: 500 }, blockers: [{ x: 16, y: 150, w: 388, h: 330 }], height: natural });
  assert.equal(cramped.moved, true);
  assert.ok(500 - cramped.bottom <= 150 - L.OBSTACLE_GAP + 1 && cramped.maxHeight >= 1);
});

test('the desktop panel stays clear of the AutoPack Results card wherever either was dragged: it shifts, or gives up height, inside its region', () => {
  const view = { width: 800, height: 650 };
  const I = L.PANEL_REGION_INSETS;
  const panel = { x: view.width - I.right - 300, y: I.top, w: 300, h: 436 }; // the stylesheet's own spot
  const clearOf = (fit, blocker) => {
    const placed = { x: panel.x + fit.dx, y: panel.y + fit.dy, w: panel.w, h: fit.maxHeight ?? panel.h };
    return placed.x + placed.w + L.OBSTACLE_GAP <= blocker.x || blocker.x + blocker.w + L.OBSTACLE_GAP <= placed.x
      || placed.y + placed.h + L.OBSTACLE_GAP <= blocker.y || blocker.y + blocker.h + L.OBSTACLE_GAP <= placed.y;
  };
  const inRegion = fit => {
    const x = panel.x + fit.dx;
    const y = panel.y + fit.dy;
    return x >= I.left && y >= I.top && x + panel.w <= view.width - I.right && y + (fit.maxHeight ?? panel.h) <= view.height - I.bottom;
  };
  assert.deepEqual(L.fitPanelClear({ panel, blockers: [], viewport: view }), { dx: 0, dy: 0, maxHeight: null, clear: true }, 'nothing in the way: it stays');
  assert.deepEqual(L.fitPanelClear({ panel, blockers: [{ x: 20, y: 500, w: 420, h: 100 }], viewport: view }).dx, 0, 'Results elsewhere: it stays');

  // Results across the bottom (its default) over the panel's lower rows: the panel keeps its place and gives up height.
  const bottom = { x: 190, y: 380, w: 420, h: 237 };
  const below = L.fitPanelClear({ panel, blockers: [bottom], viewport: view });
  assert.equal(below.clear, true);
  assert.deepEqual([below.dx, below.dy], [0, 0], 'it does not move');
  assert.equal(below.maxHeight, bottom.y - L.OBSTACLE_GAP - panel.y, 'it ends one gap above Results');
  assert.ok(below.maxHeight >= L.MIN_PANEL_HEIGHT, 'with its header and part of a row still showing');
  // Room beside the card does not change that: a docked panel is not thrown across the view for a card over its lower rows.
  const wideView = { width: 1500, height: 650 };
  const widePanel = { ...panel, x: wideView.width - I.right - 300 };
  const stillDocked = L.fitPanelClear({ panel: widePanel, blockers: [{ x: widePanel.x - 130, y: 380, w: 420, h: 237 }], viewport: wideView });
  assert.deepEqual([stillDocked.dx, stillDocked.dy], [0, 0], 'it stays docked');
  assert.ok(stillDocked.maxHeight >= L.MIN_PANEL_HEIGHT);

  // Results dragged over the panel's header: the panel moves to the nearest clear spot, whole, inside its region.
  const overHeader = { x: 300, y: 20, w: 420, h: 237 };
  const moved = L.fitPanelClear({ panel, blockers: [overHeader], viewport: view });
  assert.equal(moved.clear, true);
  assert.ok(moved.dx !== 0 || moved.dy !== 0, 'it moves');
  assert.ok(clearOf(moved, overHeader), 'and no longer touches Results');
  assert.ok(inRegion(moved), 'inside the space between the toolbar and the viewport controls');

  // The minimized card, an even smaller obstacle, over the header: still clear.
  const chip = { x: 330, y: 60, w: 420, h: 52 };
  const aside = L.fitPanelClear({ panel, blockers: [chip], viewport: view });
  assert.ok(aside.clear && clearOf(aside, chip) && inRegion(aside));

  // The owner's own spot is only a starting point: a dragged panel is moved from where it is.
  const dragged = { x: 40, y: 150, w: 300, h: 300 };
  const lowCard = { x: 100, y: 330, w: 420, h: 237 };
  const fromDragged = L.fitPanelClear({ panel: dragged, blockers: [lowCard], viewport: view });
  assert.ok(fromDragged.clear && clearOf({ ...fromDragged, dx: fromDragged.dx + dragged.x - panel.x, dy: fromDragged.dy + dragged.y - panel.y }, lowCard), 'a dragged panel is moved from where it was dragged, clear of Results');
  assert.equal(L.fitPanelClear({ panel: dragged, blockers: [{ x: 600, y: 500, w: 100, h: 60 }], viewport: view }).dx, 0, 'a dragged panel nothing touches stays where it was dragged');

  // Unusable rectangles are ignored; a region too small for the panel gives up (the caller leaves it alone).
  assert.deepEqual(L.fitPanelClear({ panel, blockers: [null, { x: NaN, y: 0, w: 1, h: 1 }], viewport: view }), { dx: 0, dy: 0, maxHeight: null, clear: true });
  assert.equal(L.fitPanelClear({ panel, blockers: [overHeader], viewport: { width: 300, height: 300 } }).clear, false);
  // No spot of at least the minimum height anywhere: clear is false and nothing is shifted.
  const crammed = L.fitPanelClear({ panel: { ...panel, h: 260 }, blockers: [{ x: 0, y: 70, w: 800, h: 560 }], viewport: view });
  assert.deepEqual(crammed, { dx: 0, dy: 0, maxHeight: null, clear: false });
});

test('the desktop panel has no cliff above AutoPack Results: short of its preferred minimum it keeps giving up height down to a floor, and only below the floor is it left where it is', () => {
  const view = { width: 800, height: 650 };
  const I = L.PANEL_REGION_INSETS;
  const panel = { x: view.width - I.right - 300, y: I.top, w: 300, h: 436 };
  assert.ok(L.PANEL_FLOOR_HEIGHT < L.MIN_PANEL_HEIGHT, 'a floor under the preferred minimum');
  // A card across the whole region, `room` px below the panel's top plus the gap it must keep (so there is no spot beside or
  // below it): the panel can be exactly `room` tall, docked where it is.
  const withRoom = room => L.fitPanelClear({ panel, blockers: [{ x: 0, y: panel.y + room + L.OBSTACLE_GAP, w: view.width, h: 600 }], viewport: view });
  let previous = Infinity;
  for (const room of [300, 260, 213, 201, 200, 199, 198, 180, 160, 151, 150]) {
    const fit = withRoom(room);
    assert.deepEqual([fit.clear, fit.dx, fit.dy, fit.maxHeight], [true, 0, 0, room], `${room} px of room: it stays docked and is exactly as tall as the room`);
    assert.ok(fit.maxHeight <= previous, 'never taller as the room shrinks');
    previous = fit.maxHeight;
  }
  assert.deepEqual(withRoom(L.PANEL_FLOOR_HEIGHT - 1), { dx: 0, dy: 0, maxHeight: null, clear: false }, 'below the floor nothing useful fits: the caller leaves it alone');
  // The preferred minimum still wins where it can: a card over the header moves the panel whole rather than squeezing it.
  const overHeader = { x: 300, y: 20, w: 420, h: 237 };
  const moved = L.fitPanelClear({ panel, blockers: [overHeader], viewport: view });
  assert.ok(moved.clear && (moved.maxHeight === null || moved.maxHeight >= L.MIN_PANEL_HEIGHT), 'moved to a spot with at least the preferred minimum');
  // The floor is only a fallback: with the floor raised to the minimum the old cliff is back.
  assert.equal(L.fitPanelClear({ panel, blockers: [{ x: 0, y: panel.y + 198 + L.OBSTACLE_GAP, w: view.width, h: 600 }], viewport: view, floorHeight: L.MIN_PANEL_HEIGHT }).clear, false);
});

test('a height-limited panel scrolls as a whole instead of pinning controls over its rows', () => {
  const head = 43;
  const arrowFooter = 104;
  const flows = input => L.panelBodyFlows({ headHeight: head, ...input });
  // Everything fits: nothing scrolls, so the choice is moot.
  assert.equal(flows({ panelHeight: 300, contentHeight: 300, footerHeight: arrowFooter }), false);
  assert.equal(flows({ panelHeight: 150, contentHeight: 151 }), false, 'a 1 px overflow is a rounding difference, not a scroll');
  // With the look controls showing, they stay pinned only while at least PANEL_PIN_MIN_SCROLL px of scrolling room remains beside them.
  const pinnedAt = height => !flows({ panelHeight: height, contentHeight: 520, footerHeight: arrowFooter });
  const smallestPinned = [...Array(400).keys()].map(n => 150 + n).find(pinnedAt);
  assert.equal(smallestPinned, head + arrowFooter + L.PANEL_PIN_MIN_SCROLL, 'pinned from exactly the height that leaves the minimum scrolling room');
  assert.ok([smallestPinned, smallestPinned + 100, 520].every(pinnedAt) && ![smallestPinned - 1, 213, 198, 150].some(pinnedAt), 'monotonic: no height pins, un-pins and pins again');
  // Without them, the fixed tool/Show/Callouts rows need the preferred minimum to leave a list: below it everything scrolls.
  assert.equal(flows({ panelHeight: L.MIN_PANEL_HEIGHT, contentHeight: 520 }), false);
  assert.equal(flows({ panelHeight: L.MIN_PANEL_HEIGHT - 1, contentHeight: 520 }), true);
  assert.equal(flows({ panelHeight: L.PANEL_FLOOR_HEIGHT, contentHeight: 520 }), true);
  // Unusable measurements never switch layouts.
  assert.equal(flows({ panelHeight: NaN, contentHeight: 520, footerHeight: arrowFooter }), false);
  assert.equal(flows({ panelHeight: 100, contentHeight: undefined }), false);
});

test('in a crowded view a label is dropped rather than covering another label or marker; the marker itself is never dropped', () => {
  const pinAt = (id, x, y) => ({ id, x: x - 12, y: y - 12, w: 24, h: 24 });
  const label = (id, x, y, text = 'FRAGILE') => ({ id, marker: { x, y }, text });
  // Alone, a label sits beside its marker (the right side, or the left near the right-hand edge) and is kept.
  const right = L.labelRect({ x: 100, y: 100 }, 'FRAGILE', 800);
  assert.ok(right.x > 100 && right.y < 100 && right.y + right.h > 100);
  const left = L.labelRect({ x: 700, y: 100 }, 'FRAGILE', 800);
  assert.ok(left.x + left.w < 700, 'flips to the left near the right-hand edge');
  assert.ok(L.labelRect({ x: 100, y: 100 }, 'x'.repeat(200), 800).w <= 150, 'a long title is capped like the chip');
  assert.deepEqual([...L.fitLabels([label('a', 100, 100)], [pinAt('a', 100, 100)], 800)], ['a']);
  // Two labels that would overlap each other (neither covers the other's marker): the first in priority order wins.
  const crowded = L.fitLabels([label('a', 100, 100), label('b', 90, 112)], [pinAt('a', 100, 100), pinAt('b', 90, 112)], 800);
  assert.deepEqual([...crowded], ['a'], 'priority order wins and the other label is dropped');
  // Markers 20px apart: a's label would sit on b's marker, so it is dropped; b's label is clear and kept.
  assert.deepEqual([...L.fitLabels([label('a', 100, 100), label('b', 120, 100)], [pinAt('a', 100, 100), pinAt('b', 120, 100)], 800)], ['b']);
  // A label that would sit on another marker is dropped even when no other label is there.
  assert.equal(L.fitLabels([label('a', 100, 100)], [pinAt('a', 100, 100), pinAt('b', 130, 100)], 800).size, 0);
  // Well-separated markers all keep their labels, and a dense field keeps only non-overlapping ones.
  const apart = [0, 1, 2, 3].map(i => label(`p${i}`, 100 + i * 300, 100));
  assert.equal(L.fitLabels(apart, apart.map(l => pinAt(l.id, l.marker.x, l.marker.y)), 1400).size, 4);
  const dense = Array.from({ length: 200 }, (_, i) => label(`d${i}`, 20 + (i % 40) * 14, 50 + Math.floor(i / 40) * 16));
  const kept = L.fitLabels(dense, dense.map(l => pinAt(l.id, l.marker.x, l.marker.y)), 1400);
  assert.ok(kept.size < 200);
  const rects = dense.filter(l => kept.has(l.id)).map(l => L.labelRect(l.marker, l.text, 1400));
  rects.forEach((a, i) => rects.slice(i + 1).forEach(b => assert.equal(L.overlapArea(a, b), 0, 'kept labels never overlap')));
});

test('the leader line joins marker and card, starts clear of the marker and vanishes when they touch', () => {
  const marker = { x: 100, y: 100 };
  const line = L.leaderLine(marker, { x: 200, y: 60, w: 208, h: 70 });
  assert.deepEqual([line.x2, line.y2], [200, 100], 'ends on the nearest point of the card');
  assert.ok(Math.abs(Math.hypot(line.x1 - 100, line.y1 - 100) - L.LEADER_START_GAP) < 1e-9);
  assert.equal(L.leaderLine(marker, { x: 104, y: 80, w: 208, h: 70 }), null, 'a card right beside the marker needs no line');
  assert.equal(L.leaderLine(marker, { x: 60, y: 60, w: 208, h: 70 }), null, 'a card over the marker needs none either');
  assert.equal(L.estimateCardHeight(null), 58);
  assert.ok(L.estimateCardHeight('x'.repeat(140)) > L.estimateCardHeight('x'.repeat(10)));
});

// ============================================================================
// SECTION: ARROW GEOMETRY (screen space, pure)
// ============================================================================
const ARROW_VIEW = { width: 800, height: 600 };
const closeTo = (actual, expected, tolerance = 0.06) => Math.abs(actual - expected) <= tolerance;
// Where the head's base sits (the midpoint of its two back corners) and how wide the base is.
const headBase = shape => ({ x: (shape.head[1].x + shape.head[2].x) / 2, y: (shape.head[1].y + shape.head[2].y) / 2, span: Math.hypot(shape.head[1].x - shape.head[2].x, shape.head[1].y - shape.head[2].y) });

test('near-plane clipping keeps the part of an arrow in front of the camera, flags the cut end and refuses what it cannot project', () => {
  const NEAR = -1; // camera space looks down -Z: in front is z <= NEAR
  const a = { x: 0, y: 0, z: -5 };
  const b = { x: 4, y: 2, z: -9 };
  const both = L.clipSegmentToNear(a, b, NEAR);
  assert.deepEqual(both, { a, b, aClipped: false, bClipped: false }, 'both ends in front: nothing is cut');
  assert.notEqual(both.a, a, 'the result is a copy, never the caller\'s point');
  assert.equal(L.clipSegmentToNear({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 3 }, NEAR), null, 'both ends behind the plane: nothing to draw');
  // Tail behind, head in front: the tail is cut where the segment crosses the plane (t = 0.2 here).
  const tail = L.clipSegmentToNear({ x: 10, y: 0, z: 1 }, { x: 0, y: 5, z: -9 }, NEAR);
  assert.deepEqual([tail.aClipped, tail.bClipped], [true, false], 'the tail was cut');
  assert.deepEqual(tail.b, { x: 0, y: 5, z: -9 }, 'the head end is untouched');
  assert.ok(closeTo(tail.a.x, 8, 1e-9) && closeTo(tail.a.y, 1, 1e-9) && tail.a.z === NEAR, 'cut on the plane, along the original line');
  // Head behind, tail in front: the mirror case cuts the head and lands on the same point.
  const head = L.clipSegmentToNear({ x: 0, y: 5, z: -9 }, { x: 10, y: 0, z: 1 }, NEAR);
  assert.deepEqual([head.aClipped, head.bClipped], [false, true], 'the head was cut');
  assert.ok(closeTo(head.b.x, 8, 1e-9) && closeTo(head.b.y, 1, 1e-9) && head.b.z === NEAR);
  // An end exactly on the plane counts as in front; the other end is then cut onto it.
  const onPlane = L.clipSegmentToNear({ x: 3, y: 4, z: NEAR }, { x: 0, y: 0, z: 3 }, NEAR);
  assert.deepEqual([onPlane.aClipped, onPlane.bClipped, onPlane.b], [false, true, { x: 3, y: 4, z: NEAR }]);
  // Anything that is not a finite point or plane is refused, never half-clipped.
  for (const [p, q, near] of [
    [{ x: NaN, y: 0, z: -5 }, b, NEAR], [a, { x: 0, y: Infinity, z: -5 }, NEAR], [a, { x: 0, y: 0, z: undefined }, NEAR],
    [null, b, NEAR], [a, undefined, NEAR], [a, b, NaN], [a, b, undefined],
  ]) assert.equal(L.clipSegmentToNear(p, q, near), null);
});

test('an arrow is a shaft and a head that points at the head end, scales down on short arrows and is shaft-only where its head end is not a real point', () => {
  const horizontal = L.arrowShape({ tail: { x: 100, y: 300 }, head: { x: 400, y: 300 }, width: 'thin', viewport: ARROW_VIEW });
  assert.deepEqual(horizontal, {
    shaft: { x1: 100, y1: 300, x2: 389.8, y2: 300 },
    head: [{ x: 400, y: 300 }, { x: 388, y: 305 }, { x: 388, y: 295 }],
    tip: { x: 400, y: 300 }, length: 300, shaftWidth: 2,
  });
  // Every width keeps its own shaft stroke and head size, in every direction: the tip is the head end and the base lies toward the tail.
  for (const width of ['thin', 'regular', 'bold']) {
    for (const [tail, head] of [[{ x: 100, y: 300 }, { x: 500, y: 300 }], [{ x: 500, y: 300 }, { x: 100, y: 300 }], [{ x: 100, y: 100 }, { x: 400, y: 500 }], [{ x: 400, y: 500 }, { x: 100, y: 100 }], [{ x: 300, y: 500 }, { x: 300, y: 80 }]]) {
      const shape = L.arrowShape({ tail, head, width, viewport: ARROW_VIEW });
      const length = Math.hypot(head.x - tail.x, head.y - tail.y);
      const base = headBase(shape);
      const size = L.ARROW_HEAD_PX[width];
      assert.equal(shape.shaftWidth, L.ARROW_SHAFT_PX[width]);
      assert.deepEqual(shape.tip, head, `${width}: the tip is the head end`);
      assert.ok(closeTo(Math.hypot(head.x - base.x, head.y - base.y), size.length, 0.1) && closeTo(base.span, size.width, 0.1), `${width}: full-size head`);
      // The base lies on the tail side of the tip: moving from the tip toward the base moves toward the tail.
      const toTail = { x: (tail.x - head.x) / length, y: (tail.y - head.y) / length };
      assert.ok(closeTo((base.x - head.x) * toTail.x + (base.y - head.y) * toTail.y, size.length, 0.1), `${width}: the head points away from the tail`);
      assert.ok(closeTo(Math.hypot(shape.shaft.x2 - head.x, shape.shaft.y2 - head.y), size.length * 0.85, 0.2), `${width}: the shaft ends a little inside the head`);
    }
  }
  assert.equal(L.arrowShape({ tail: { x: 100, y: 300 }, head: { x: 400, y: 300 }, width: 'huge', viewport: ARROW_VIEW }).shaftWidth, L.ARROW_SHAFT_PX.regular, 'an unknown width falls back to regular');

  // Short arrows: nothing under the minimum length; above it the head shrinks so it never takes more than 60% of the arrow.
  const at = length => L.arrowShape({ tail: { x: 100, y: 100 }, head: { x: 100 + length, y: 100 }, width: 'regular', viewport: ARROW_VIEW });
  assert.equal(at(L.ARROW_MIN_SCREEN_PX - 0.01), null, 'just under the minimum length is not drawn');
  assert.equal(at(0), null, 'a zero-length arrow is not drawn');
  for (const length of [12, 15, 20, 24.9]) {
    const base = headBase(at(length));
    assert.ok(Math.hypot(100 + length - base.x, 100 - base.y) <= length * 0.6 + 0.1, `${length}px: the head is at most 60% of the arrow`);
  }
  assert.ok(closeTo(Math.hypot(125 - headBase(at(25)).x, 100 - headBase(at(25)).y), 15, 0.1), 'at 25px the head is full size');

  // A head end cut by the near plane, or beyond the viewport margin, leaves a shaft only: no head, no tip.
  const cut = L.arrowShape({ tail: { x: 100, y: 300 }, head: { x: 400, y: 300 }, viewport: ARROW_VIEW, headClipped: true });
  assert.deepEqual([cut.head, cut.tip, cut.shaft], [null, null, { x1: 100, y1: 300, x2: 400, y2: 300 }]);
  const far = L.arrowShape({ tail: { x: 100, y: 300 }, head: { x: 900, y: 300 }, viewport: ARROW_VIEW });
  assert.deepEqual([far.head, far.tip, far.shaft.x2], [null, null, 830], 'a head beyond the margin is cut at the margin edge');
  const edge = L.arrowShape({ tail: { x: 100, y: 300 }, head: { x: 820, y: 300 }, viewport: ARROW_VIEW });
  assert.deepEqual(edge.tip, { x: 820, y: 300 }, 'a head half outside the viewport but inside the margin is drawn whole');
});

test('an arrow outside the viewport is not drawn, one crossing its edge is cut there, and no input ever yields an invalid path', () => {
  const shape = (tail, head, extra = {}) => L.arrowShape({ tail, head, width: 'regular', viewport: ARROW_VIEW, ...extra });
  assert.equal(shape({ x: -200, y: -200 }, { x: -100, y: -100 }), null, 'entirely off the top-left');
  assert.equal(shape({ x: 100, y: -100 }, { x: 500, y: -100 }), null, 'entirely above');
  assert.equal(shape({ x: 900, y: 100 }, { x: 900, y: 500 }), null, 'entirely to the right of the margin');
  assert.equal(shape({ x: -60, y: 300 }, { x: -27, y: 300 }), null, 'only 3 px of it is inside the margin: below the visible minimum');
  const crossing = shape({ x: -100, y: 300 }, { x: 200, y: 300 });
  assert.deepEqual([crossing.shaft.x1, crossing.shaft.y1, crossing.tip], [-30, 300, { x: 200, y: 300 }], 'the tail end is cut at the margin; the head is real and whole');
  const through = shape({ x: -200, y: 300 }, { x: 1000, y: 300 });
  assert.deepEqual([through.shaft.x1, through.shaft.x2, through.head], [-30, 830, null], 'crossing the whole viewport: both ends cut, shaft only');

  // Not finite, missing or degenerate input draws nothing.
  const good = { tail: { x: 100, y: 300 }, head: { x: 400, y: 300 }, viewport: ARROW_VIEW };
  for (const bad of [
    { tail: { x: NaN, y: 0 } }, { head: { x: 0, y: Infinity } }, { tail: null }, { head: undefined }, { viewport: undefined },
    { viewport: { width: NaN, height: 600 } }, { viewport: { width: 800, height: -Infinity } }, { head: { x: 100, y: 300 } },
  ]) assert.equal(L.arrowShape({ ...good, ...bad }), null);
  assert.deepEqual(L.arrowPathData(null), { shaft: '', head: '' });
  assert.deepEqual(L.arrowPathData(undefined), { shaft: '', head: '' });
  const full = L.arrowPathData(L.arrowShape({ ...good, width: 'thin' }));
  assert.deepEqual(full, { shaft: 'M100 300L389.8 300', head: 'M400 300L388 305L388 295Z' }, 'shaft and head are separate, closed paths');
  assert.deepEqual(L.arrowPathData(L.arrowShape({ ...good, headClipped: true })), { shaft: 'M100 300L400 300', head: '' }, 'a shaft-only arrow has no head path');

  // A sweep through ordinary, edge and absurd screen coordinates: whatever is drawn is finite and stays near the viewport.
  const ordinates = [0, 1, 400, 799, 800, -29, -31, 1e6, -1e6, 1e12, -1e12, 1e308, -1e308]; // the last pair overflows a difference to Infinity
  const SLACK = 60; // the 30 px margin plus the largest head
  let drawn = 0;
  for (const tx of ordinates) for (const ty of ordinates) for (const hx of ordinates) for (const hy of ordinates) {
    const result = shape({ x: tx, y: ty }, { x: hx, y: hy });
    const paths = L.arrowPathData(result);
    assert.equal(/NaN|Infinity|undefined/.test(paths.shaft + paths.head), false, `no invalid path for ${tx},${ty} -> ${hx},${hy}`);
    if (!result) { assert.deepEqual(paths, { shaft: '', head: '' }); continue; }
    drawn += 1;
    const points = [[result.shaft.x1, result.shaft.y1], [result.shaft.x2, result.shaft.y2], ...(result.head || []).map(p => [p.x, p.y])];
    for (const [x, y] of points) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), 'finite coordinates');
      assert.ok(x >= -SLACK && x <= ARROW_VIEW.width + SLACK && y >= -SLACK && y <= ARROW_VIEW.height + SLACK, `inside the viewport and margin: ${x},${y}`);
    }
    assert.equal(Boolean(result.head), Boolean(result.tip), 'a head and its tip come together');
    assert.equal(Boolean(result.head), paths.head !== '');
  }
  assert.ok(drawn > 1000, 'the sweep draws plenty of arrows, so the checks above are not vacuous');
});

// ============================================================================
// SECTION: FREEHAND STROKES (V1B.2) — surfaces, record, gates, identity, resolution
// ============================================================================

const BOX = { id: 'box', name: 'Box', shape: 'box', dimensions: { length: 48, width: 40, height: 30 } };
const DRUM = { id: 'drum', name: 'Drum', shape: 'cylinder', dimensions: { length: 60, width: 24, height: 24 } };
const placedAt = (id, caseId, position = { x: 100, y: 50, z: 10 }, rotation = { x: 0, y: 0, z: 0 }) => ({
  id, caseId, placement: 'packed', transform: { position, rotation, scale: { x: 1, y: 1, z: 1 } },
});
const zoneOf = ([x0, y0, z0, x1, y1, z1]) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
const RECT_TRUCK = { length: 636, width: 102, height: 98, shapeMode: 'rect' };
const RECT_ZONES = [zoneOf([0, 0, -51, 636, 98, 51])];
const WELL_TRUCK = { length: 636, width: 102, height: 98, shapeMode: 'wheelWells' };
const WELL_ZONES = [[0, 0, -51, 150, 98, 51], [150, 0, -36, 400, 98, 36], [150, 34, -51, 400, 98, -36], [150, 34, 36, 400, 98, 51], [400, 0, -51, 636, 98, 51]].map(zoneOf);
const DECK_TRUCK = { length: 636, width: 102, height: 98, shapeMode: 'frontBonus' };
const DECK_ZONES = [[0, 0, -51, 500, 98, 51], [500, 66, -51, 636, 98, 51]].map(zoneOf);
const lcg = seed => {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
};

/** The real resolution context for the fixtures: cargo `b1` (a box) and `d1` (a cylinder) on a truck. */
const drawContext = ({ truck = RECT_TRUCK, zones = RECT_ZONES, instances = {}, ...overrides } = {}) => {
  const cases = new Map([[BOX.id, BOX], [DRUM.id, DRUM]]);
  const placed = new Map([['b1', placedAt('b1', 'box')], ['d1', placedAt('d1', 'drum')], ...Object.entries(instances)]);
  return {
    getInstance: id => placed.get(id) ?? null, getCase: id => cases.get(id) ?? null,
    floors: M.buildFloorSurfaces(truck, zones), truck, zones, ...overrides,
  };
};
const boxAnchor = local => M.buildCargoAnchor({ instanceId: 'b1', local, caseData: BOX });
const drumAnchor = local => M.buildCargoAnchor({ instanceId: 'd1', local, caseData: DRUM });
const floorAt = (x, z, surface = 'main', y = 0) => M.buildFloorAnchor({ surface, point: { x, y, z } });
const wallAt = (surface, point, truck = RECT_TRUCK, zones = RECT_ZONES) => M.buildSpaceAnchor({ surface, point, truck, zones });
const draw = (id, anchor, points, extra = {}) => A.createDrawRecord({ id, anchor, points, now: 1000, ...extra });
// The verified contract examples.
const TOP_STROKE = () => draw('top', boxAnchor({ x: -14.25, y: 15, z: -6.5 }), [-10.4, -6.1, -6.8, -5.2, -2.1, -3.9, 3.35, -1.2, 9.8, 0.75], { face: '+y' });
const SIDE_STROKE = () => draw('side', boxAnchor({ x: -18, y: -5.5, z: 20 }), [-12.5, -3.25, -6, 0.5, 0, 3.75, 7.25, 6.5], { face: '+z' });
const CAP_STROKE = () => draw('cap', drumAnchor({ x: 30, y: 3.5, z: -4.25 }), [-2.1, 5.2, 0.6, 6.4, 3.25, 5.9, 5.75, 3.1], { face: '+x' });
const FLOOR_STROKE = () => draw('floor', floorAt(120.5, -20.25), [130.1, -18.4, 140.75, -12.2, 152, -9.9]);
const WALL_STROKE = () => draw('wall', wallAt('wall-left', { x: 200, y: 40, z: 51 }), [215.5, 42.25, 230, 47.5]);
const statusOf = (record, context = drawContext()) => {
  const r = A.resolveAnnotation(record, context);
  return `${r.status}${r.reason ? `:${r.reason}` : ''}`;
};
const without = (record, key) => { const { [key]: _gone, ...rest } = record; return rest; };

test('a stroke is exactly the contracted record: one anchor, a face for cargo only, grid vertices and nothing derived', () => {
  assert.deepEqual([A.MAX_DRAW_VERTICES_PER_STROKE, A.MAX_DRAW_VERTICES_PER_PACK, A.MAX_DRAW_RECORD_BYTES, A.MIN_DRAW_LENGTH_INCHES, A.DRAW_MAX_RAW_VERTICES],
    [256, 3000, 8192, 1, 1024]);
  assert.equal(A.DRAW_QUANTUM_INCHES, 0.01);
  assert.equal(1 / A.DRAW_QUANTUM_INCHES, 100, 'the grid constant and its integer form agree');
  assert.deepEqual([...A.DRAW_SIMPLIFY_TOLERANCES], [0.1, 0.2, 0.4], 'the loosest simplification is 0.4 in');
  assert.deepEqual([A.ANNOTATION_SCHEMA_VERSION, A.MAX_ANNOTATIONS_PER_PACK], [1, 200], 'the schema version and the shared cap are unchanged');
  assert.ok(M.DRAW_FOOTPRINT_TOLERANCE_INCHES >= A.DRAW_QUANTUM_INCHES / Math.SQRT2, 'an honest vertex quantized onto a patch edge is never rejected');
  const cargo = TOP_STROKE();
  const world = FLOOR_STROKE();
  assert.deepEqual(Object.keys(cargo), ['id', 'type', 'schemaVersion', 'color', 'width', 'hidden', 'anchor', 'face', 'points', 'createdAt', 'updatedAt']);
  assert.deepEqual(Object.keys(world), ['id', 'type', 'schemaVersion', 'color', 'width', 'hidden', 'anchor', 'points', 'createdAt', 'updatedAt'], 'no face off cargo');
  assert.deepEqual([cargo.type, cargo.schemaVersion, cargo.color, cargo.width, cargo.hidden], ['draw', 1, 'ink', 'regular', false]);
  assert.deepEqual([...A.DRAW_WIDTHS], ['thin', 'regular', 'bold']);
  for (const record of [cargo, SIDE_STROKE(), CAP_STROKE(), world, WALL_STROKE()]) {
    assert.equal(A.validateDrawRecord(record), null, record.id);
    const [stored] = A.normalizeAnnotations([record]);
    assert.deepEqual(stored, record, `${record.id}: normalizing keeps every field`);
    assert.deepEqual(Object.keys(stored), Object.keys(record), `${record.id}: and the record's own key order`);
    assert.equal(JSON.stringify(A.normalizeAnnotations([stored])[0]), JSON.stringify(stored), `${record.id}: the stored spelling is a fixed point`);
    for (const derived of ['status', 'point', 'vertices', 'length', 'bounds', 'number']) assert.equal(Object.hasOwn(record, derived), false, derived);
  }
  assert.equal(A.drawVertexCount(cargo), 6, 'the anchor is vertex 0');
});

test('stroke validation names the first problem: record, display flags, surface, face and every vertex rule', () => {
  const cargo = TOP_STROKE();
  const floor = FLOOR_STROKE();
  const cap = CAP_STROKE();
  const wall = WALL_STROKE();
  const problem = record => A.validateDrawRecord(record) || '';
  const cases = [
    ['not an object', null, /record must be an object/],
    ['id', { ...cargo, id: '' }, /id is invalid/],
    ['type', { ...cargo, type: 'sketch' }, /type is not supported/],
    ['schemaVersion', { ...cargo, schemaVersion: 2 }, /schemaVersion is not supported/],
    ['unknown key', { ...cargo, label: 'x' }, /unsupported field/],
    ['color', { ...cargo, color: 'magenta' }, /color is invalid/],
    ['width', { ...cargo, width: 'huge' }, /width is invalid/],
    ['hidden', { ...cargo, hidden: 'no' }, /display flags/],
    ['timestamps', { ...cargo, updatedAt: NaN }, /timestamps/],
    ['anchor', { ...cargo, anchor: { kind: 'mystery' } }, /anchor\.kind/],
    ['cargo without a face', without(cargo, 'face'), /face is not supported/],
    ['unknown face', { ...cargo, face: 'up' }, /face is not supported/],
    ['prototype name as a face', { ...cargo, face: 'constructor' }, /face is not supported/],
    ['face off the anchor plane', { ...cargo, face: '+z' }, /not on the plane of its face/],
    ['legacy face + (u, v) cargo anchor', { ...cargo, anchor: { kind: 'cargo', instanceId: 'b1', face: '+y', u: 0.5, v: 0.5, signature: cargo.anchor.signature } }, /cargo-local point/],
    ['face on a floor stroke', { ...floor, face: '+y' }, /only allowed on cargo/],
    ['face on a wall stroke', { ...wall, face: '+z' }, /only allowed on cargo/],
    ['cylinder side face', { ...cap, face: '+y', anchor: drumAnchor({ x: 0, y: 12, z: 0 }) }, /face is not supported/],
    ['cylinder cap on the other cap plane', { ...cap, face: '-x' }, /not on the plane of its face/],
    ['open space', draw('free', M.buildSpaceAnchor({ surface: 'free', point: { x: 1, y: 2, z: 3 } }), [2, 2, 3, 3]), /open space/],
    ['ground off the ground plane', draw('g', M.buildSpaceAnchor({ surface: 'ground', point: { x: 1, y: 5, z: 3 } }), [2, 2, 3, 3]), /not on the ground/],
    ['wall that does not remember its zones', { ...wall, anchor: { ...wall.anchor, truck: { length: 636, width: 102, height: 98, shapeMode: 'rect' } } }, /truck\.zones is required/],
    ['no vertices after the anchor', { ...floor, points: [] }, /points is invalid/],
    ['points not a list', { ...floor, points: 'abc' }, /points is invalid/],
    ['half a vertex', { ...floor, points: [1, 2, 3] }, /points is invalid/],
    ['non-finite vertex', { ...floor, points: [1, NaN] }, /grid/],
    ['infinite vertex', { ...floor, points: [1, Infinity] }, /grid/],
    ['string vertex', { ...floor, points: [1, '2'] }, /grid/],
    ['vertex beyond the coordinate bound', { ...floor, points: [1000000.01, 2] }, /grid/],
    ['vertex off the 0.01 grid', { ...floor, points: [10.005, 2] }, /grid/],
    ['repeated vertex', { ...floor, points: [130.1, -18.4, 130.1, -18.4] }, /repeat a vertex/],
    ['first vertex equal to the anchor', { ...floor, points: [120.5, -20.25, 130, 5] }, /repeat a vertex/],
    ['too many vertices', { ...floor, points: Array.from({ length: 512 }, (_, i) => (i % 2 ? 1 : i + 1)) }, /too many vertices/],
    ['vertex off the box face', { ...cargo, points: [-10.4, -6.1, 24.5, 0] }, /leave the face/],
    ['vertex inside the cap circle but off its polygon', { ...cap, points: [11.85, 1.56] }, /leave the face/],
  ];
  for (const [label, record, expected] of cases) assert.match(A.validateDrawRecord(record) || '', expected, label);
  assert.equal(problem(cargo), '');
  // Edges: a vertex exactly on a face edge and one within the footprint tolerance are on the face; one past it is not.
  const edge = u => ({ ...cargo, points: [u, 0] });
  assert.equal(A.validateDrawRecord(edge(24)), null, 'on the edge');
  assert.equal(A.validateDrawRecord(edge(24.01)), null, 'within the 0.01 in footprint tolerance');
  assert.match(A.validateDrawRecord(edge(24.02)), /leave the face/);
  assert.equal(A.validateDrawRecord({ ...cap, points: [11.78, 1.55] }), null, 'inside the polygon at radius 11.88');
  assert.equal(A.validateDrawRecord({ ...cap, points: [12, 0, 11.9, 0.5] }), null, 'a polygon vertex is on the cap');
  assert.match(A.validateDrawRecord({ ...cap, points: [12, 0, 11.99, 0.5] }), /leave the face/, 'but a point just outside the edge next to it is not');
  assert.equal(A.validateDrawRecord({ ...floor, points: Array.from({ length: 510 }, (_, i) => (i % 2 ? 0 : (i / 2 + 1) / 10)) }), null, '256 vertices is the most');
});

test('normalization of a stroke is canonical and idempotent: key order, color case, negative zero, JSON round trip', () => {
  const base = TOP_STROKE();
  const scrambled = {
    updatedAt: 1000, points: [-0, -6.1, 5, 5], face: '+y', anchor: base.anchor, hidden: false, width: 'thin', color: '#ABCDEF', schemaVersion: 1, type: 'draw', id: 'scrambled', createdAt: 1000,
  };
  const [out] = A.normalizeAnnotations([scrambled]);
  assert.deepEqual(Object.keys(out), ['id', 'type', 'schemaVersion', 'color', 'width', 'hidden', 'anchor', 'face', 'points', 'createdAt', 'updatedAt']);
  assert.equal(out.color, '#abcdef');
  assert.equal(Object.is(out.points[0], 0), true, 'negative zero becomes zero');
  assert.equal(Object.is(scrambled.points[0], -0), true, 'the stored input is not mutated');
  const again = A.normalizeAnnotations([out]);
  assert.deepEqual(again, [out]);
  assert.equal(A.normalizeAnnotations(again), again, 'the normalized list is its own normalization');
  assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify(again))), again, 'a JSON round trip changes nothing');
  assert.equal(JSON.stringify(A.normalizeAnnotations(JSON.parse(JSON.stringify(again)))), JSON.stringify(again), 'byte for byte');
  // A non-canonical anchor spelling (a legacy key order) is written canonically but never changes meaning.
  const reordered = { ...base, anchor: { local: base.anchor.local, signature: base.anchor.signature, instanceId: 'b1', kind: 'cargo' } };
  assert.equal(JSON.stringify(A.normalizeAnnotations([reordered])[0].anchor), JSON.stringify(A.normalizeAnnotations([base])[0].anchor));
});

test('callout and arrow canonical output is byte-for-byte what V1B.1 wrote', () => {
  const truck = RECT_TRUCK;
  const cargo = M.buildCargoAnchor({ instanceId: 'inst-1', local: { x: 24, y: 2, z: 3 }, caseData: CASE });
  const wall = M.buildSpaceAnchor({ surface: 'wall-left', point: { x: 200, y: 40, z: 51 }, truck, zones: RECT_ZONES });
  const callout1 = A.createCalloutRecord({ id: 'c1', anchor: cargo, title: 'Fragile', description: 'Handle with care', color: '#ABCDEF', keepExpanded: true, offset: { dx: 12.34, dy: -5 }, now: 1000 });
  const arrow1 = A.createArrowRecord({ id: 'a1', start: wall, end: M.buildFloorAnchor({ surface: 'main', point: { x: 120.5, y: 0, z: -20.25 } }), color: 'red', width: 'bold', now: 2000 });
  const callout2 = A.createCalloutRecord({ id: 'c2', anchor: ground(5, 5), title: 'Ground', now: 3 });
  // Captured from the V1B.1 implementation (main at df4d7f8) before the drawing foundation was added.
  assert.equal(JSON.stringify(A.normalizeAnnotations([callout1, arrow1, callout2])), '[{"id":"c1","type":"callout","title":"Fragile","description":"Handle with care","color":"#abcdef","keepExpanded":true,"hidden":false,"anchor":{"kind":"cargo","instanceId":"inst-1","signature":{"shape":"box","length":48,"width":24,"height":32},"local":{"x":24,"y":2,"z":3}},"offset":{"dx":12.3,"dy":-5},"createdAt":1000,"updatedAt":1000,"schemaVersion":1},{"id":"a1","type":"arrow","schemaVersion":1,"color":"red","width":"bold","hidden":false,"start":{"kind":"space","surface":"wall-left","position":{"x":200,"y":40,"z":51},"truck":{"length":636,"width":102,"height":98,"shapeMode":"rect","zones":[[0,0,-51,636,98,51]]}},"end":{"kind":"floor","surface":"main","position":{"x":120.5,"y":0,"z":-20.25}},"createdAt":2000,"updatedAt":2000},{"id":"c2","type":"callout","title":"Ground","description":null,"color":"ink","keepExpanded":false,"hidden":false,"anchor":{"kind":"space","surface":"ground","position":{"x":5,"y":0,"z":5}},"offset":null,"createdAt":3,"updatedAt":3,"schemaVersion":1}]');
});

// ----------------------------------------------------------------------------
// Geometry: cargo faces and caps
// ----------------------------------------------------------------------------

test('all six box faces: the signed plane, the in-plane axes and the exact rectangle, and a stroke lands on each one', () => {
  const signature = M.getCargoGeometrySignature(BOX);
  // Half extents: x 24 (length), y 15 (height), z 20 (width). u and v are the face's two in-plane axes.
  const table = [
    ['+x', 24, [-20, 20, -15, 15], (u, v) => ({ x: 24, y: v, z: u })],
    ['-x', -24, [-20, 20, -15, 15], (u, v) => ({ x: -24, y: v, z: u })],
    ['+y', 15, [-24, 24, -20, 20], (u, v) => ({ x: u, y: 15, z: v })],
    ['-y', -15, [-24, 24, -20, 20], (u, v) => ({ x: u, y: -15, z: v })],
    ['+z', 20, [-24, 24, -15, 15], (u, v) => ({ x: u, y: v, z: 20 })],
    ['-z', -20, [-24, 24, -15, 15], (u, v) => ({ x: u, y: v, z: -20 })],
  ];
  assert.equal(M.cargoFacePatch('up', signature), null);
  assert.equal(M.cargoFaceFrame('toString'), null, 'a prototype name is not a face');
  const pose = M.resolveCargoPose(placedAt('b1', 'box', { x: 100, y: 50, z: 10 }, { x: 0.3, y: 1.1, z: -0.4 }), BOX);
  for (const [face, plane, [uMin, uMax, vMin, vMax], local] of table) {
    assert.deepEqual(M.cargoFacePatch(face, signature), { kind: 'rect', uMin, uMax, vMin, vMax, plane }, face);
    assert.equal(M.isCargoFaceSupported(face, signature), true);
    assert.equal(M.isCargoPointOnFacePlane(face, local(1, 2), signature), true);
    assert.equal(M.isCargoPointOnFacePlane(face, local(1, 2).x === 24 ? { x: 23, y: 2, z: 1 } : { ...local(1, 2), [M.cargoFaceFrame(face).normal]: plane * 0.9 }, signature), false, `${face}: a point inside the cargo is not on the plane`);
    const stroke = draw(`face${face}`, boxAnchor(local(1.5, -2.25)), [3.25, 4.5, 6, 1.75, uMax, vMax], { face });
    assert.equal(A.validateDrawRecord(stroke), null, face);
    const rotated = placedAt('b1', 'box', { x: 100, y: 50, z: 10 }, { x: 0.3, y: 1.1, z: -0.4 });
    const resolved = A.resolveAnnotation(stroke, drawContext({ instances: { b1: rotated } }));
    assert.equal(resolved.status, 'valid', face);
    const expected = [[1.5, -2.25], [3.25, 4.5], [6, 1.75], [uMax, vMax]].map(([u, v]) => M.cargoLocalToWorld(pose, local(u, v)));
    assert.deepEqual(resolved.vertices, expected, `${face}: every vertex is the face point carried by the committed pose`);
    assert.deepEqual(resolved.vertices[0], M.resolveAnchor(stroke.anchor, drawContext({ instances: { b1: rotated } })).point, `${face}: vertex 0 is the anchor exactly`);
    const outline = M.patchOutline(M.cargoFacePatch(face, signature));
    assert.deepEqual(outline, [uMin, vMin, uMax, vMin, uMax, vMax, uMin, vMax], `${face}: counter-clockwise rectangle`);
  }
});

test('cylinder and drum end caps are the real 24-sided footprint; the curved side wall and free choices of face are refused', () => {
  const signature = M.getCargoGeometrySignature(DRUM);
  const drum = M.getCargoGeometrySignature({ ...DRUM, shape: 'drum' });
  for (const sig of [signature, drum]) {
    assert.deepEqual(M.cargoFacePatch('+x', sig), { kind: 'ngon', radius: 12, plane: 30 });
    assert.deepEqual(M.cargoFacePatch('-x', sig), { kind: 'ngon', radius: 12, plane: -30 });
    for (const face of ['+y', '-y', '+z', '-z']) assert.deepEqual([M.isCargoFaceSupported(face, sig), M.cargoFacePatch(face, sig)], [false, null], face);
  }
  const wide = M.getCargoGeometrySignature({ ...DRUM, dimensions: { length: 60, width: 30, height: 20 } });
  assert.equal(M.cargoFacePatch('+x', wide).radius, 10, 'the radius is half of the smaller of width and height');
  const outline = M.patchOutline(M.cargoFacePatch('+x', signature));
  assert.equal(outline.length, 48, 'the 24 vertices the Editor builds');
  assert.deepEqual([outline[0], outline[1]], [12, 0], 'a vertex lies on the +u axis');
  // Parity with the surface test every cargo anchor already uses: on a cap's plane the two agree everywhere.
  const patch = M.cargoFacePatch('+x', signature);
  let compared = 0;
  for (let degrees = 0; degrees < 360; degrees += 1.7) {
    for (let r = 10.5; r <= 13; r += 0.0137) {
      const [u, v] = [r * Math.cos(degrees * Math.PI / 180), r * Math.sin(degrees * Math.PI / 180)];
      const onSurface = M.distanceToCargoSurface({ x: 30, y: v, z: u }, signature) <= M.DRAW_FOOTPRINT_TOLERANCE_INCHES;
      assert.equal(M.patchContains(patch, u, v), onSurface, `r=${r.toFixed(3)} at ${degrees.toFixed(1)} degrees`);
      compared++;
    }
  }
  assert.ok(compared > 20000);
  // The facet middle is at the apothem (12 cos 7.5 degrees), the vertex at the circumradius.
  const apothem = 12 * Math.cos(Math.PI / 24);
  const facet = r => [r * Math.cos(Math.PI / 24), r * Math.sin(Math.PI / 24)];
  assert.equal(M.patchContains(patch, ...facet(apothem + 0.009)), true, 'within the footprint tolerance of the facet');
  assert.equal(M.patchContains(patch, ...facet(apothem + 0.011)), false, 'just outside it');
  assert.equal(M.patchContains(patch, ...facet(11.95)), false, 'inside the circle, outside the polygon (0.05 in)');
  assert.equal(M.patchContains(patch, ...facet(11.88)), true);
  assert.equal(M.patchContains(patch, 12, 0), true, 'a polygon vertex');
  assert.equal(M.patchContains(patch, 12.2, 0), false);
  // Both caps carry strokes, and a stroke on one cap cannot be moved to the other face of the drum.
  const capMinus = draw('cap-', drumAnchor({ x: -30, y: -2, z: 5 }), [4, -1, 1, -4], { face: '-x' });
  assert.equal(A.validateDrawRecord(capMinus), null);
  assert.equal(A.validateDrawRecord(CAP_STROKE()), null);
  assert.equal(statusOf(CAP_STROKE()), 'valid');
  assert.equal(statusOf(capMinus), 'valid');
  const [cap] = [CAP_STROKE()];
  const resolved = A.resolveAnnotation(cap, drawContext());
  assert.deepEqual(resolved.vertices.map(v => v.x), Array(5).fill(130), 'all on the cap plane x = 100 + 30');
  assert.match(A.validateDrawRecord({ ...cap, anchor: drumAnchor({ x: 0, y: 12, z: 0 }), face: '+x' }), /not on the plane of its face/);
  assert.equal(M.drawAnchorUV(cap.anchor, '+x').u, -4.25, 'a cap is drawn in (z, y)');
});

// ----------------------------------------------------------------------------
// Geometry: truck floor, walls, ceiling and ground
// ----------------------------------------------------------------------------

test('a world stroke is Valid only while ONE current patch holds every vertex: floor, wall, ceiling and ground examples', () => {
  const ctx = drawContext();
  const record = FLOOR_STROKE();
  assert.equal(statusOf(record, ctx), 'valid');
  assert.deepEqual(A.resolveAnnotation(record, ctx).vertices[0], { x: 120.5, y: 0, z: -20.25 });
  assert.equal(statusOf(WALL_STROKE(), ctx), 'valid');
  assert.deepEqual(A.resolveAnnotation(WALL_STROKE(), ctx).vertices.map(v => v.z), [51, 51, 51], 'on the wall plane');
  // A stroke that leaves its patch is flagged, never clipped or moved.
  const offFloor = draw('off', floorAt(620, 0), [630, 5, 640, 10]);
  assert.equal(A.validateDrawRecord(offFloor), null, 'structurally valid: patch membership needs the truck');
  const flagged = A.resolveAnnotation(offFloor, ctx);
  assert.deepEqual([flagged.status, flagged.reason, flagged.vertices, flagged.point], ['needs-review', 'stroke-off-surface', null, null]);
  assert.equal(statusOf(draw('high', wallAt('wall-left', { x: 200, y: 90, z: 51 }), [210, 97, 220, 99]), ctx), 'needs-review:stroke-off-surface', 'past the ceiling');
  // Ceiling and the two end walls use their own frames.
  const ceiling = draw('ceiling', wallAt('ceiling', { x: 300, y: 98, z: 10 }), [320, 20, 340, -30]);
  assert.equal(statusOf(ceiling, ctx), 'valid');
  assert.deepEqual(A.resolveAnnotation(ceiling, ctx).vertices.map(v => v.y), [98, 98, 98]);
  assert.equal(statusOf(draw('r', wallAt('wall-rear', { x: 0, y: 30, z: 10 }), [20, 40, -30, 60]), ctx), 'valid');
  assert.deepEqual(A.resolveAnnotation(draw('r', wallAt('wall-rear', { x: 0, y: 30, z: 10 }), [20, 40, -30, 60]), ctx).vertices.map(v => [v.x, v.z, v.y]), [[0, 10, 30], [0, 20, 40], [0, -30, 60]]);
  assert.equal(statusOf(draw('f', wallAt('wall-front', { x: 636, y: 30, z: 10 }), [20, 40, -30, 60]), ctx), 'valid');
  assert.equal(statusOf(draw('rt', wallAt('wall-right', { x: 200, y: 30, z: -51 }), [250, 60]), ctx), 'valid');
  // Ground is a separate surface from the truck floor: its own plane, far larger than the truck.
  const onGround = draw('gr', M.buildSpaceAnchor({ surface: 'ground', point: { x: -50, y: 0, z: 200 } }), [-20, 150, 300, 40, 700, -300]);
  assert.equal(statusOf(onGround, ctx), 'valid', 'ground reaches far past the truck');
  assert.equal(statusOf(draw('cross', floorAt(10, 0), [-20, 0]), ctx), 'needs-review:stroke-off-surface', 'a floor stroke does not continue onto the ground');
  assert.equal(statusOf(draw('cross2', M.buildSpaceAnchor({ surface: 'ground', point: { x: -10, y: 0, z: 0 } }), [10, 0]), ctx), 'valid', 'and a ground stroke is not limited to the truck footprint');
  assert.deepEqual(M.drawSurfacePatches(onGround.anchor, ctx), [{ kind: 'rect', uMin: -1e6, uMax: 1e6, vMin: -1e6, vMax: 1e6, plane: 0 }]);
});

test('same patch versus crossed patch: seams between zones, wheel-well tops and deck pieces split a stroke, whatever the zone order', () => {
  const ctx = drawContext({ truck: WELL_TRUCK, zones: WELL_ZONES });
  const reversed = drawContext({ truck: WELL_TRUCK, zones: [...WELL_ZONES].reverse() });
  const shuffled = drawContext({ truck: WELL_TRUCK, zones: [WELL_ZONES[3], WELL_ZONES[0], WELL_ZONES[4], WELL_ZONES[2], WELL_ZONES[1]] });
  const anchorMain = floorAt(100, 0);
  const patches = M.drawSurfacePatches(anchorMain, ctx);
  assert.equal(patches.length, 3, 'three separate main-floor rectangles: rear, corridor and front');
  assert.deepEqual(patches.map(p => [p.uMin, p.uMax, p.vMin, p.vMax, p.plane]).sort((a, b) => a[0] - b[0]),
    [[0, 150, -51, 51, 0], [150, 400, -36, 36, 0], [400, 636, -51, 51, 0]]);
  const cases = [
    ['inside the rear patch', draw('s1', anchorMain, [120, 10, 140, -30]), 'valid'],
    ['across the seam into the corridor', draw('s2', anchorMain, [140, 0, 160, 0]), 'needs-review:stroke-off-surface'],
    ['a corridor stroke', draw('s3', floorAt(200, 0), [250, 20, 300, -20]), 'valid'],
    ['a corridor stroke into the wheel-well side', draw('s4', floorAt(200, 0), [250, 20, 260, 45]), 'needs-review:stroke-off-surface'],
    ['inside one wheel-well top', draw('s5', floorAt(200, 43, 'well-top', 34), [250, 48, 300, 40]), 'valid'],
    ['from a wheel-well top down to the floor beside it', draw('s6', floorAt(200, 43, 'well-top', 34), [250, 30]), 'needs-review:stroke-off-surface'],
    ['a well-top stroke onto the other well-top', draw('s7', floorAt(200, 43, 'well-top', 34), [250, -40]), 'needs-review:stroke-off-surface'],
  ];
  for (const [label, record, expected] of cases) {
    assert.equal(A.validateDrawRecord(record), null, label);
    for (const [name, context] of [['zones', ctx], ['reversed', reversed], ['shuffled', shuffled]]) {
      assert.equal(statusOf(record, context), expected, `${label} (${name})`);
    }
  }
  // Front Overhang: the main floor and the raised deck are separate; so are the wall pieces above and beside them.
  const deck = drawContext({ truck: DECK_TRUCK, zones: DECK_ZONES });
  assert.equal(statusOf(draw('d1', floorAt(550, 0, 'deck', 66), [600, 20]), deck), 'valid');
  assert.equal(statusOf(draw('d2', floorAt(550, 0, 'deck', 66), [480, 20]), deck), 'needs-review:stroke-off-surface', 'off the deck onto the main floor');
  assert.equal(statusOf(draw('d3', wallAt('wall-left', { x: 300, y: 40, z: 51 }, DECK_TRUCK, DECK_ZONES), [350, 60]), deck), 'valid');
  assert.equal(statusOf(draw('d4', wallAt('wall-left', { x: 490, y: 80, z: 51 }, DECK_TRUCK, DECK_ZONES), [510, 85]), deck), 'needs-review:stroke-off-surface', 'across the seam between the main wall and the deck wall');
  assert.equal(statusOf(draw('d5', wallAt('wall-left', { x: 520, y: 80, z: 51 }, DECK_TRUCK, DECK_ZONES), [600, 90]), deck), 'valid', 'within the deck wall piece');
  // No patch is identified by its position in a list.
  assert.deepEqual(M.drawSurfacePatches(anchorMain, reversed).map(p => p.uMin).sort((a, b) => a - b), patches.map(p => p.uMin).sort((a, b) => a - b));
});

test('a stroke follows every anchor decision first: cargo, Case, truck and floor changes pass through and offer no vertices', () => {
  const stroke = TOP_STROKE();
  const cases = [
    ['cargo removed', drawContext({ getInstance: () => null }), 'unresolved:cargo-missing'],
    ['Case removed', drawContext({ getCase: () => null }), 'unresolved:case-missing'],
    ['Case resized', drawContext({ getCase: () => ({ ...BOX, dimensions: { ...BOX.dimensions, height: 31 } }) }), 'needs-review:case-changed'],
    ['Case reshaped', drawContext({ getCase: () => ({ ...BOX, shape: 'cylinder' }) }), 'needs-review:case-changed'],
    ['pose unreadable', drawContext({ getInstance: () => placedAt('b1', 'box', { x: NaN, y: 0, z: 0 }) }), 'unresolved:pose-invalid'],
    ['ambiguous cargo ID', drawContext({ isInstanceAmbiguous: id => id === 'b1' }), 'unresolved:cargo-ambiguous'],
  ];
  for (const [label, ctx, expected] of cases) {
    assert.equal(statusOf(stroke, ctx), expected, label);
    assert.equal(A.resolveAnnotation(stroke, ctx).vertices, null, `${label}: no vertices are offered`);
  }
  assert.equal(statusOf(stroke), 'valid', 'control');
  // Wall strokes: a changed truck is flagged, not relocated.
  const longer = drawContext({ truck: { ...RECT_TRUCK, length: 600 }, zones: [zoneOf([0, 0, -51, 600, 98, 51])] });
  assert.equal(statusOf(WALL_STROKE(), longer), 'needs-review:truck-changed');
  assert.equal(statusOf(WALL_STROKE(), drawContext({ truck: WELL_TRUCK, zones: WELL_ZONES })), 'needs-review:truck-changed');
  // Floor strokes: a floor that is no longer there, or no longer the same kind, is flagged; a floor that only moved within its tolerance is not.
  assert.equal(statusOf(FLOOR_STROKE(), drawContext({ zones: [zoneOf([0, 40, -51, 636, 98, 51])] })), 'needs-review:floor-changed');
  assert.equal(statusOf(FLOOR_STROKE(), drawContext({ floors: [] })), 'unresolved:floor-missing');
  // The floor may disappear under the LATER vertices while the anchor is still on it: that is a stroke problem, not an anchor problem.
  const narrower = drawContext({ zones: [zoneOf([0, 0, -51, 140, 98, 51])] });
  assert.equal(statusOf(FLOOR_STROKE(), narrower), 'needs-review:stroke-off-surface');
  // Never fabricated: Needs Review and Unresolved carry no position at all.
  for (const [record, ctx] of [[FLOOR_STROKE(), narrower], [TOP_STROKE(), drawContext({ getInstance: () => null })]]) {
    const r = A.resolveAnnotation(record, ctx);
    assert.deepEqual([r.point, r.vertices], [null, null]);
  }
  for (const reason of ['stroke-off-surface', 'surface-unsupported']) assert.ok(A.describeAnnotationReason(reason).length > 30, reason);
  // Defensive: a face this cargo cannot carry (which validation already refuses) never resolves onto the cylinder wall.
  const forged = { ...CAP_STROKE(), face: '+y' };
  const forgedResult = A.resolveAnnotation(forged, drawContext());
  assert.deepEqual([forgedResult.status, forgedResult.vertices], ['unresolved', null]);
});

// ----------------------------------------------------------------------------
// The drawing pipeline: simplification, quantization, limits
// ----------------------------------------------------------------------------

const jitterLine = (count, amplitude, seed = 7) => {
  const rand = lcg(seed);
  const raw = [];
  for (let i = 1; i <= count; i++) raw.push(-14.25 + i * 0.04, -6.5 + (rand() * 2 - 1) * amplitude);
  return raw;
};
const TOP_ANCHOR = () => boxAnchor({ x: -14.25, y: 15, z: -6.5 });

test('prepareDrawStroke: vertex 0 is the anchor, vertices are rounded from their own absolute value and a repeat after rounding is dropped', () => {
  const prepared = A.prepareDrawStroke({ anchor: TOP_ANCHOR(), face: '+y', rawPoints: [-10.404, -6.096, -6.8, -5.2, -2.1, -3.9, 3.349, -1.2, 9.8, 0.754] });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.tolerance, 0.1, 'the smallest tolerance is tried first');
  assert.ok(prepared.points.every(value => Math.round(value * 100) / 100 === value), 'every vertex sits on the 0.01 in grid');
  assert.deepEqual(prepared.points.slice(-2), [9.8, 0.75], 'the last sample is kept and rounded');
  assert.equal(prepared.vertexCount, 1 + prepared.points.length / 2);
  // Rounding never drifts: the error of every kept vertex is at most half a quantum, however long the stroke.
  const zig = [];
  for (let i = 1; i <= 200; i++) zig.push(-14.25 + i * 0.0123, -6.5 + (i % 2 ? 1.7 : -1.7));
  const long = A.prepareDrawStroke({ anchor: TOP_ANCHOR(), face: '+y', rawPoints: zig });
  assert.equal(long.ok, true);
  assert.equal(long.points.length / 2, 200, 'a zigzag keeps every vertex at this tolerance');
  long.points.forEach((value, i) => {
    assert.equal(value, Math.round(zig[i] * 100) / 100 + 0, `vertex ${Math.floor(i / 2) + 1}`);
    assert.ok(Math.abs(value - zig[i]) <= 0.005 + 1e-9, 'no cumulative error');
  });
  // Consecutive duplicates after rounding go; a later return to an earlier point stays (a closed shape is fine).
  const dup = A.prepareDrawStroke({ anchor: TOP_ANCHOR(), face: '+y', rawPoints: [-14.2501, -6.5001, -10, -6, -10.001, -6.003, -14.25, -6.5] });
  assert.deepEqual(dup, { ok: true, points: [-10, -6, -14.25, -6.5], tolerance: 0.1, vertexCount: 3 });
  assert.equal(A.validateDrawRecord(draw('closed', TOP_ANCHOR(), dup.points, { face: '+y' })), null, 'the loop closes on the anchor');
  assert.deepEqual(A.prepareDrawStroke({ anchor: TOP_ANCHOR(), face: '+y', rawPoints: [-14.2501, -6.4999, -14.25, -6.5] }), { ok: false, reason: 'too-short' }, 'nothing but the anchor remains');
});

test('the 0.01 in grid check accepts every two-decimal value and rounding always lands on it, within half a quantum', () => {
  const offGrid = value => /grid/.test(A.validateDrawRecord({ ...FLOOR_STROKE(), points: [value, 7] }) || '');
  for (let k = -100000000; k <= 100000000; k += 97) assert.equal(offGrid(k / 100), false, `${k / 100} is on the grid`);
  assert.equal(offGrid(0.005), true);
  assert.equal(offGrid(1.005), true);
  const rand = lcg(5);
  const anchor = TOP_ANCHOR();
  for (let i = 0; i < 20000; i++) {
    const raw = (rand() - 0.5) * 2e6;
    const prepared = A.prepareDrawStroke({ anchor, face: '+y', rawPoints: [raw, 3] });
    assert.equal(prepared.ok, true);
    assert.equal(offGrid(prepared.points[0]), false, `${prepared.points[0]} from ${raw}`);
    assert.ok(Math.abs(prepared.points[0] - raw) <= 0.005 + 1e-9);
  }
});

test('simplification only loosens when the stroke does not fit, never past 0.4 in, and never truncates', () => {
  const anchor = TOP_ANCHOR();
  const run = rawPoints => A.prepareDrawStroke({ anchor, face: '+y', rawPoints });
  const within = (raw, out, tolerance) => {
    const polyline = [-14.25, -6.5, ...out.points];
    for (let i = 0; i < raw.length; i += 2) assert.ok(L.distanceToPolyline(polyline, raw[i], raw[i + 1]) <= tolerance + 0.0071, `sample ${i / 2}`);
  };
  const easy = jitterLine(600, 0.15);
  const first = run(easy);
  assert.deepEqual([first.ok, first.tolerance], [true, 0.1]);
  assert.ok(first.vertexCount <= 256);
  within(easy, first, 0.1);
  const second = jitterLine(900, 0.15);
  const out2 = run(second);
  assert.deepEqual([out2.ok, out2.tolerance], [true, 0.2], '337 vertices at 0.1 in does not fit, 131 at 0.2 in does');
  within(second, out2, 0.2);
  const third = jitterLine(900, 0.35);
  const out3 = run(third);
  assert.deepEqual([out3.ok, out3.tolerance], [true, 0.4], 'the loosest step, and the most a drawn line ever moves');
  within(third, out3, 0.4);
  assert.ok(out3.vertexCount <= A.MAX_DRAW_VERTICES_PER_STROKE);
  // Past that the answer is explicit: no record, no points, no partial result.
  const saw = [];
  for (let i = 1; i <= 600; i++) saw.push(-14.25 + i * 0.05, -6.5 + (i % 2 ? 3 : -3));
  const refused = run(saw);
  assert.deepEqual(refused, { ok: false, reason: 'too-complex' });
  assert.equal(Object.hasOwn(refused, 'points'), false);
  // The raw cap: 1,024 samples are accepted for simplification, one more is refused outright.
  const atCap = run(jitterLine(1024, 0.15));
  assert.equal(atCap.ok, true);
  assert.deepEqual(run(jitterLine(1025, 0.15)), { ok: false, reason: 'too-complex' });
  // Exactly at the vertex limit: 255 samples that all survive make a 256-vertex stroke; one more cannot.
  const survive = n => { const raw = []; for (let i = 1; i <= n; i++) raw.push(-14.25 + i * 0.12, -6.5 + (i % 2 ? 1.5 : -1.5)); return raw; };
  assert.equal(run(survive(255)).vertexCount, 256);
  assert.deepEqual(run(survive(256)), { ok: false, reason: 'too-complex' });
});

test('prepareDrawStroke refuses malformed gestures and unusable surfaces without a record', () => {
  const anchor = TOP_ANCHOR();
  const bad = [
    ['no points', { anchor, face: '+y' }], ['not a list', { anchor, face: '+y', rawPoints: 'abc' }], ['empty', { anchor, face: '+y', rawPoints: [] }],
    ['half a vertex', { anchor, face: '+y', rawPoints: [1, 2, 3] }], ['NaN', { anchor, face: '+y', rawPoints: [1, NaN] }],
    ['Infinity', { anchor, face: '+y', rawPoints: [1, Infinity] }], ['beyond the bound', { anchor, face: '+y', rawPoints: [1, 1e6 + 1] }],
    ['no anchor', { face: '+y', rawPoints: [1, 2] }], ['unknown face', { anchor, face: 'up', rawPoints: [1, 2] }],
    ['open space', { anchor: M.buildSpaceAnchor({ surface: 'free', point: { x: 1, y: 1, z: 1 } }), rawPoints: [1, 2] }],
  ];
  for (const [label, input] of bad) assert.deepEqual(A.prepareDrawStroke(input), { ok: false, reason: 'invalid' }, label);
  assert.deepEqual(A.prepareDrawStroke(), { ok: false, reason: 'invalid' });
});

test('stroke vertex limits: 256 per stroke, 3,000 per Load Plan in strict checks only, recovery records excluded, 200 records shared', () => {
  const floorStroke = (id, vertices) => draw(id, floorAt(100, 0), Array.from({ length: (vertices - 1) * 2 }, (_, i) => (i % 2 ? ((i >> 1) % 2 ? 4 : -4) : 101 + (i >> 1) * 0.2)));
  assert.equal(A.drawVertexCount(floorStroke('v256', 256)), 256);
  assert.equal(A.validateDrawRecord(floorStroke('v256', 256)), null);
  assert.match(A.validateDrawRecord(floorStroke('v257', 257)), /too many vertices/);
  // Too long a stroke is kept whole as a recovery record: its vertices are never truncated to fit.
  const oversized = floorStroke('v257', 257);
  const [wrapped] = A.normalizeAnnotations([oversized]);
  assert.equal(wrapped.type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(wrapped.original, oversized);
  assert.equal(wrapped.original.points.length, 512);
  const full = Array.from({ length: 11 }, (_, i) => floorStroke(`full${i}`, 256)); // 2,816
  const exact = A.validateAnnotationCollection([...full, floorStroke('rest', 184)]);
  assert.equal(exact.ok, true, '3,000 vertices exactly');
  assert.equal(A.drawVertexTotal(exact.annotations), 3000);
  const over = A.validateAnnotationCollection([...full, floorStroke('rest', 185)]);
  assert.equal(over.ok, false);
  assert.match(over.error, /too many drawing vertices \(3001; maximum 3000\)/);
  // Lenient handling never turns a valid stroke into a recovery record for a collection-level reason.
  const lenient = A.normalizeAnnotations([...full, floorStroke('rest', 185)]);
  assert.deepEqual(lenient.map(r => r.type), Array(12).fill('draw'));
  assert.equal(A.normalizeAnnotations(lenient), lenient);
  // A recovery record's original does not count: only valid strokes do.
  const wrapper = A.normalizeAnnotations([{ id: 'x', type: 'draw' }])[0];
  const bigWrapper = { id: 'w', type: 'unreadable', schemaVersion: 1, reason: 'x', original: floorStroke('inner', 256) };
  assert.equal(A.validateAnnotationCollection([...full, floorStroke('rest', 184), wrapper, bigWrapper]).ok, true);
  assert.equal(A.drawVertexTotal([...full, bigWrapper, null, 'x']), 2816);
  // The 200-record cap is shared with every other type.
  const callouts = n => Array.from({ length: n }, (_, i) => callout(`k${i}`, ground(i, 1)));
  assert.equal(A.validateAnnotationCollection([...callouts(199), floorStroke('s', 2)]).annotations.length, 200);
  assert.match(A.validateAnnotationCollection([...callouts(200), floorStroke('s', 2)]).error, /too many annotations \(201; maximum 200\)/);
});

test('the record byte limit counts UTF-8 bytes of the canonical record, not characters, and a record that exceeds it is unreadable', () => {
  const bytes = record => Buffer.byteLength(JSON.stringify(A.normalizeAnnotations([record])[0]), 'utf8');
  const multibyte = { ...TOP_STROKE(), anchor: { ...TOP_STROKE().anchor, instanceId: 'é中😀-b1' } };
  assert.equal(A.validateDrawRecord(multibyte), null);
  const exact = bytes(multibyte);
  assert.ok(exact > JSON.stringify(multibyte).length - 5, 'sanity: the canonical form is what is measured');
  assert.ok(JSON.stringify(A.normalizeAnnotations([multibyte])[0]).length < exact, 'characters and bytes differ for this record');
  assert.equal(A.validateDrawRecord(multibyte, { maxBytes: exact }), null, 'exactly at the limit');
  assert.match(A.validateDrawRecord(multibyte, { maxBytes: exact - 1 }), /larger than/);
  const ascii = { ...TOP_STROKE() };
  const asciiBytes = bytes(ascii);
  assert.equal(A.validateDrawRecord(ascii, { maxBytes: asciiBytes }), null);
  assert.match(A.validateDrawRecord(ascii, { maxBytes: asciiBytes - 1 }), /larger than/);
  // The measured form is the canonical one: a record stored with extra whitespace in its color or scrambled keys is judged by its stored shape.
  assert.equal(A.validateDrawRecord({ ...ascii, color: '#ABCDEF' }, { maxBytes: asciiBytes + 8 }), null);
  // The default is 8,192 bytes, and no valid 256-vertex stroke comes near it: the rule is a backstop.
  const wall = wallAt('ceiling', { x: 300, y: 98, z: 10 });
  const maximal = draw('x'.repeat(64), wall, Array.from({ length: 510 }, (_, i) => (i % 2 ? 999999.99 - (i >> 1) : -999999.99 + (i >> 1))), { color: '#ABCDEF' });
  assert.equal(A.validateDrawRecord(maximal), null);
  assert.ok(bytes(maximal) < A.MAX_DRAW_RECORD_BYTES, `${bytes(maximal)} bytes`);
  // An oversized or malformed record is kept verbatim, never shortened, and strict checks refuse it.
  const tiny = { ...ascii };
  const original = JSON.parse(JSON.stringify(tiny));
  const wrapped = A.normalizeAnnotations([{ ...tiny, points: [...tiny.points, 5000000, 1] }])[0];
  assert.equal(wrapped.type, 'unreadable');
  assert.deepEqual(wrapped.original.points.slice(-2), [5000000, 1], 'the out-of-range vertex is preserved, not clamped');
  assert.deepEqual(tiny, original);
});

test('malformed and duplicate strokes are kept verbatim as recovery records and never converted back', () => {
  const good = TOP_STROKE();
  const broken = { ...good, id: 'broken', points: [1, 2, 3] };
  const offFace = { ...good, id: 'off', points: [-10.4, -6.1, 24.5, 0] };
  const twin = { ...good };
  const newer = { ...good, id: 'newer', schemaVersion: 2 };
  const list = [good, broken, offFace, twin, newer, { ...good, id: 'extra', label: 'x' }];
  const frozen = JSON.stringify(list);
  const out = A.normalizeAnnotations(list);
  assert.equal(JSON.stringify(list), frozen, 'the stored input is not mutated');
  assert.deepEqual(out.map(r => r.type), ['draw', 'unreadable', 'unreadable', 'unreadable', 'unreadable', 'unreadable']);
  assert.deepEqual(out.slice(1).map((r, i) => r.original), list.slice(1), 'every original is preserved verbatim');
  assert.deepEqual(out.slice(1).map(r => r.reason), [
    'The saved annotation could not be read.', 'The saved annotation could not be read.', 'Duplicate annotation ID in this Load Plan.',
    'Saved by a newer version of the app.', 'The saved annotation could not be read.']);
  assert.equal(new Set(out.map(r => r.id)).size, out.length);
  assert.equal(A.validateAnnotationCollection(list).ok, false);
  assert.deepEqual(A.validateAnnotationCollection(out).annotations, out, 'the wrappers themselves are accepted verbatim');
  assert.match(A.validateAnnotationCollection([good, twin]).error, /duplicate annotation id "top"/);
  // A wrapper an older build made around a perfectly valid stroke stays inert.
  const wrapper = { id: 'w', type: 'unreadable', schemaVersion: 1, reason: 'Saved by a newer version of the app.', original: good };
  assert.deepEqual(A.normalizeAnnotations([wrapper]), [wrapper]);
  assert.equal(A.resolveAnnotation(A.normalizeAnnotations([wrapper])[0], drawContext()).reason, 'unreadable');
  assert.equal(statusOf(good), 'valid', 'control');
});

// ----------------------------------------------------------------------------
// Presentation edits and write-time placement
// ----------------------------------------------------------------------------

test('a style edit changes only color, width, visibility and the update time; the surface, face and vertices are carried over byte for byte', () => {
  const base = SIDE_STROKE();
  const edited = A.editDrawRecord(base, { color: '#ABCDEF', width: 'bold', hidden: true, anchor: ground(1, 1), face: '+y', points: [1, 2], id: 'other', createdAt: 5 }, 2000);
  assert.deepEqual([edited.color, edited.width, edited.hidden, edited.updatedAt], ['#abcdef', 'bold', true, 2000]);
  const stored = A.normalizeAnnotations([base])[0];
  assert.equal(JSON.stringify(edited.anchor), JSON.stringify(stored.anchor));
  assert.equal(JSON.stringify([edited.face, edited.points, edited.id, edited.createdAt]), JSON.stringify([stored.face, stored.points, stored.id, stored.createdAt]), 'a patch cannot move or re-attach a stroke');
  assert.equal(A.validateDrawRecord(edited), null);
  assert.equal(A.editDrawRecord(base, { width: 'huge' }, 2000), null);
  assert.equal(A.editDrawRecord(base, { color: 'magenta' }, 2000), null);
  assert.equal(A.editDrawRecord(base, {}, NaN), null);
  assert.equal(A.editDrawRecord({ ...base, type: 'arrow' }, { hidden: true }, 1), null);
  assert.deepEqual(A.editDrawRecord(base, {}, 1000), stored, 'an empty patch changes nothing');
  // A stroke that needs review, or whose cargo is gone, can still be restyled: nothing about the layout is consulted.
  assert.equal(statusOf(edited, drawContext({ getInstance: () => null })), 'unresolved:cargo-missing');
  assert.equal(A.editDrawRecord(edited, { hidden: false }, 3000).hidden, false);
});

test('a stroke may be written only when it resolves now and runs at least an inch along its resolved path', () => {
  const ctx = drawContext();
  assert.equal(A.drawPlacementProblem(TOP_STROKE(), ctx), null);
  assert.equal(A.drawPlacementProblem(FLOOR_STROKE(), ctx), null);
  assert.equal(A.drawPlacementProblem(draw('short', floorAt(100, 0), [100.5, 0.5]), ctx), 'too-short', 'a 0.71 in stroke');
  assert.equal(A.drawPlacementProblem(draw('edge', floorAt(100, 0), [101, 0]), ctx), null, 'exactly one inch');
  assert.equal(A.drawPlacementProblem(draw('away2', floorAt(100, 0), [100.9, 0, 100, 0]), ctx), null, 'path length, not displacement: out and back is 1.8 in of line');
  assert.equal(A.drawPlacementProblem(draw('off', floorAt(620, 0), [630, 5, 640, 10]), ctx), 'unresolved');
  assert.equal(A.drawPlacementProblem(TOP_STROKE(), drawContext({ getInstance: () => null })), 'unresolved');
  assert.equal(A.drawPlacementProblem(WALL_STROKE(), drawContext({ truck: WELL_TRUCK, zones: WELL_ZONES })), 'unresolved');
});

// ----------------------------------------------------------------------------
// Cargo identity
// ----------------------------------------------------------------------------

test('a stroke follows its cargo through remapping by its anchor alone; the face and vertices never change', () => {
  const stroke = draw('s', boxAnchor({ x: -18, y: -5.5, z: 20 }), [-12.5, -3.25, -6, 0.5], { face: '+z' });
  const padded = { ...stroke, anchor: { ...stroke.anchor, instanceId: ' b1 ' } };
  const list = [padded, FLOOR_STROKE(), draw('far', drumAnchor({ x: 30, y: 3.5, z: -4.25 }), [-2.1, 5.2], { face: '+x' })];
  const remapped = A.remapAnnotationInstanceIds(list, new Map([['b1', 'new-1']]));
  assert.equal(remapped[0].anchor.instanceId, 'new-1', 'a trimmed-equal ID follows the map');
  assert.deepEqual([remapped[0].face, remapped[0].points], ['+z', [-12.5, -3.25, -6, 0.5]], 'the stroke is otherwise untouched');
  assert.equal(JSON.stringify({ ...remapped[0].anchor, instanceId: 'x' }), JSON.stringify({ ...A.normalizeAnnotations([padded])[0].anchor, instanceId: 'x' }), 'only the instance changed');
  assert.equal(remapped[1], A.normalizeAnnotations(list)[1], 'a floor stroke has no instance to change');
  assert.equal(remapped[2].anchor.instanceId, 'd1', 'an unmapped anchor is never guessed');
  assert.equal(A.remapAnnotationInstanceIds(list, new Map()), A.normalizeAnnotations(list), 'nothing changed: the normalized list itself');
  assert.equal(A.validateAnnotationCollection(remapped).ok, true, 'and the result is still a valid collection');
  // Never attached to the wrong cargo: the stroke is resolved only through its own anchor's identity.
  const ctx = drawContext({ instances: { 'new-1': placedAt('new-1', 'box', { x: 400, y: 50, z: 0 }) } });
  assert.equal(A.resolveAnnotation(remapped[0], ctx).vertices[0].x, 400 - 18);
  assert.equal(statusOf(remapped[0], drawContext({ isInstanceAmbiguous: id => id === 'new-1', instances: { 'new-1': placedAt('new-1', 'box') } })), 'unresolved:cargo-ambiguous');
});

test('a stroke on a contested ID is withheld whole and verbatim, a wrapper is never reached, and the survivor inherits nothing', () => {
  const identity = M.canonicalizeInstanceIds(['cargo', ' cargo '], () => 'minted', [true, false]);
  assert.deepEqual([...identity.contestedKeys], ['cargo']);
  const contested = draw('contested', M.buildCargoAnchor({ instanceId: ' cargo ', local: { x: 1, y: 15, z: 2 }, caseData: BOX }), [3, 4, 5, 6], { face: '+y' });
  const fine = FLOOR_STROKE();
  const elsewhere = draw('else', M.buildCargoAnchor({ instanceId: 'elsewhere', local: { x: 1, y: 15, z: 2 }, caseData: BOX }), [3, 4, 5, 6], { face: '+y' });
  const wrapper = { id: 'w', type: 'unreadable', schemaVersion: 1, reason: 'x', original: contested };
  const raw = [contested, fine, elsewhere, wrapper];
  const carried = A.carryAnnotationsThroughIdentity(raw, identity);
  assert.equal(carried[0].type, A.ANNOTATION_TYPE_UNREADABLE);
  assert.deepEqual(carried[0].original, contested, 'the original record is preserved verbatim');
  assert.deepEqual(carried.slice(1).map(r => r.type), ['draw', 'draw', 'unreadable']);
  assert.equal(carried[2].anchor.instanceId, 'elsewhere', 'a dangling reference is left as it is');
  assert.deepEqual(carried[3], wrapper, 'an existing wrapper is not inspected');
  assert.equal(A.carryAnnotationsThroughIdentity(carried, identity)[0].type, A.ANNOTATION_TYPE_UNREADABLE, 'idempotent');
  assert.equal(A.resolveAnnotation(carried[0], drawContext()).reason, 'unreadable', 'never Valid on the surviving cargo');
  const clean = M.canonicalizeInstanceIds(['a', 'b'], () => 'minted');
  assert.equal(A.carryAnnotationsThroughIdentity(raw, clean), A.remapAnnotationInstanceIds(raw, clean.idMap));
});

// ----------------------------------------------------------------------------
// Pure helpers in annotation-layout.js
// ----------------------------------------------------------------------------

const SQUARE = [-12, -12, 12, -12, 12, 12, -12, 12];

test('simplifyPolyline: every dropped vertex is within the tolerance of the result, the result is a deterministic subset and the ends stay', () => {
  const rand = lcg(42);
  for (let trial = 0; trial < 60; trial++) {
    const count = 3 + Math.floor(rand() * 400);
    const flat = [];
    let [x, y] = [rand() * 100 - 50, rand() * 100 - 50];
    for (let i = 0; i < count; i++) {
      x += (rand() - 0.5) * 2;
      y += (rand() - 0.5) * 2;
      flat.push(x, y);
    }
    for (const tolerance of [0, 0.05, 0.1, 0.4, 3]) {
      const out = L.simplifyPolyline(flat, tolerance);
      assert.deepEqual(out, L.simplifyPolyline(flat, tolerance), 'deterministic');
      assert.deepEqual(out.slice(0, 2), flat.slice(0, 2));
      assert.deepEqual(out.slice(-2), flat.slice(-2));
      const kept = new Set();
      for (let i = 0; i < out.length; i += 2) kept.add(`${out[i]},${out[i + 1]}`);
      for (let i = 0; i < flat.length; i += 2) {
        if (!kept.has(`${flat[i]},${flat[i + 1]}`)) assert.ok(L.distanceToPolyline(out, flat[i], flat[i + 1]) <= tolerance + 1e-9, `trial ${trial} tolerance ${tolerance}`);
      }
      assert.ok(out.length <= flat.length);
      if (tolerance > 0 && tolerance < 3) assert.ok(L.simplifyPolyline(flat, 3).length <= out.length, 'a looser tolerance never keeps more of these walks');
    }
  }
});

test('simplifyPolyline handles degenerate and extreme input without NaN, recursion or a changed shape', () => {
  assert.deepEqual(L.simplifyPolyline([], 0.1), []);
  assert.deepEqual(L.simplifyPolyline([1, 2], 0.1), [1, 2]);
  assert.deepEqual(L.simplifyPolyline([1, 2, 1, 2], 0.1), [1, 2, 1, 2], 'two identical points stay two points');
  assert.deepEqual(L.simplifyPolyline([0, 0, 1, 0, 2, 0, 3, 0, 4, 0], 0), [0, 0, 4, 0], 'collinear points go even at zero tolerance');
  assert.deepEqual(L.simplifyPolyline([5, 5, 5, 5, 5, 5, 5, 5], 0.1), [5, 5, 5, 5], 'a stroke that never moved collapses to its ends');
  assert.deepEqual(L.simplifyPolyline([0, 0, 10, 0, 10, 10, 0, 10, 0, 0], 0.1), [0, 0, 10, 0, 10, 10, 0, 10, 0, 0], 'a closed loop keeps its far corners');
  assert.deepEqual(L.simplifyPolyline([0, 0, 5, 3, 0, 0], 0.1), [0, 0, 5, 3, 0, 0], 'out and back keeps the turn');
  assert.deepEqual(L.simplifyPolyline([0, 0, 5, 0.05, 10, 0], 0.1), [0, 0, 10, 0]);
  // Large coordinates and a small tolerance: relative arithmetic keeps a 0.3 in bump at one million inches.
  const far = L.simplifyPolyline([999000, 999000, 999500, 999000.3, 1000000, 999000], 0.1);
  assert.equal(far.length, 6);
  assert.equal(L.simplifyPolyline([999000, 999000, 999500, 999000.05, 1000000, 999000], 0.1).length, 4);
  assert.equal(L.simplifyPolyline([0, 0, 1, 1e9, 2, 0], 0.1), null, 'beyond the coordinate bound');
  for (const bad of [null, 'abc', [1], [1, NaN], [1, Infinity], [1, '2', 3, 4], {}]) assert.equal(L.simplifyPolyline(bad, 0.1), null, String(bad));
  for (const tolerance of [-1, NaN, Infinity, '0.1', undefined]) assert.equal(L.simplifyPolyline([0, 0, 1, 1, 2, 0], tolerance), null, String(tolerance));
  const many = Array.from({ length: (L.SIMPLIFY_MAX_INPUT_VERTICES + 1) * 2 }, (_, i) => i);
  assert.equal(L.simplifyPolyline(many, 0.1), null, 'more than the input cap is refused, not sampled');
  const long = [];
  for (let i = 0; i < L.SIMPLIFY_MAX_INPUT_VERTICES; i++) long.push(i * 0.5, (i % 2) * 5);
  assert.equal(L.simplifyPolyline(long, 0.1).length, long.length, 'the longest accepted input keeps a full zigzag (and recurses without a stack)');
  assert.equal(L.distanceToPolyline([], 1, 1), Infinity);
  assert.equal(L.distanceToPolyline([0, 0], 3, 4), 5);
  assert.equal(L.distanceToPolyline([0, 0, 10, 0], 5, 3), 3);
  assert.equal(L.distanceToPolyline([0, 0, 10, 0], 13, 4), 5, 'beyond the end it is the distance to the end');
  assert.equal(L.distanceToPolyline([0, 0, 10, 0], NaN, 0), Infinity);
});

test('simplifyPolylineToBudget tries the stated tolerances in order and says too-complex instead of truncating or loosening further', () => {
  const noisy = [-14.25, -6.5, ...jitterLine(900, 0.35)];
  const fit = L.simplifyPolylineToBudget(noisy, { maxVertices: 256, tolerances: [0.1, 0.2, 0.4] });
  assert.deepEqual([fit.ok, fit.tolerance], [true, 0.4]);
  assert.ok(fit.vertexCount <= 256 && fit.points.length === fit.vertexCount * 2);
  const stingy = L.simplifyPolylineToBudget(noisy, { maxVertices: 256, tolerances: [0.1, 0.2] });
  assert.deepEqual(stingy, { ok: false, reason: 'too-complex' }, 'the largest tolerance offered is the limit');
  assert.deepEqual(L.simplifyPolylineToBudget([0, 0, 1, 1], { maxVertices: 256, tolerances: [0.1] }).points, [0, 0, 1, 1]);
  assert.equal(L.simplifyPolylineToBudget([0, 0, 1, 1, 2, 5], { maxVertices: 2, tolerances: [0.1, 0.4] }).reason, 'too-complex');
  for (const budget of [{}, { maxVertices: 1, tolerances: [0.1] }, { maxVertices: 256, tolerances: [] }, { maxVertices: 256, tolerances: [-1] }, { maxVertices: 2.5, tolerances: [0.1] }, undefined]) {
    assert.deepEqual(L.simplifyPolylineToBudget([0, 0, 1, 1], budget), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(L.simplifyPolylineToBudget([0, NaN], { maxVertices: 256, tolerances: [0.1] }), { ok: false, reason: 'invalid' });
});

test('clipSegmentToConvex returns the exact boundary point for a rectangle and for the 24-sided cap, in either winding', () => {
  const point = (x, y) => ({ x, y });
  const clip = (a, b, outline = SQUARE) => L.clipSegmentToConvex(a, b, outline);
  assert.deepEqual(clip(point(0, 0), point(24, 0)), { t0: 0, t1: 0.5, a: point(0, 0), b: point(12, 0) }, 'leaves through the right edge');
  assert.deepEqual(clip(point(0, 0), point(6, 6)), { t0: 0, t1: 1, a: point(0, 0), b: point(6, 6) }, 'wholly inside is returned unchanged');
  assert.deepEqual(clip(point(-30, 4), point(30, 4)), { t0: 0.3, t1: 0.7, a: point(-12, 4), b: point(12, 4) }, 'crosses the whole shape');
  const into = clip(point(-20, 0), point(0, 0));
  assert.deepEqual([into.t0, into.a], [0.4, point(-12, 0)], 'enters from outside');
  assert.equal(clip(point(-20, 20), point(20, 20)), null, 'misses it, parallel to an edge');
  assert.equal(clip(point(13, -20), point(13, 20)), null, 'parallel and just outside');
  assert.equal(clip(point(30, 30), point(40, 31)), null);
  assert.equal(clip(point(-20, -20), point(-20, 20)), null);
  assert.deepEqual(clip(point(12, -20), point(12, 20)).a, point(12, -12), 'along an edge is inside it');
  const corner = clip(point(-24, 0), point(0, -24));
  assert.deepEqual([corner.t0 === corner.t1, corner.a], [true, point(-12, -12)], 'a diagonal that only touches a corner is a single point');
  const reversed = SQUARE.map((_, i) => SQUARE[(SQUARE.length - 2 - (i & ~1)) + (i & 1)]);
  assert.deepEqual(clip(point(0, 0), point(24, 0), reversed), clip(point(0, 0), point(24, 0)), 'clockwise gives the same answer');
  assert.deepEqual(clip(point(0, 0), point(0, 0)), { t0: 0, t1: 1, a: point(0, 0), b: point(0, 0) }, 'a zero-length segment inside');
  assert.equal(clip(point(40, 0), point(40, 0)), null, 'and outside');
  for (const bad of [null, [], [0, 0, 1, 1], [0, 0, 1, 1, 2, 2], [0, 0, NaN, 1, 1, 0], 'abc']) assert.equal(L.clipSegmentToConvex(point(0, 0), point(1, 1), bad), null, String(bad));
  assert.equal(L.clipSegmentToConvex(point(0, 0), point(NaN, 1), SQUARE), null);
  assert.equal(L.clipSegmentToConvex(null, point(1, 1), SQUARE), null);
  // The cap polygon: along the vertex axis it ends at the circumradius, along a facet normal at the apothem.
  const cap = M.patchOutline({ kind: 'ngon', radius: 12, plane: 30 });
  const axis = L.clipSegmentToConvex(point(0, 0), point(20, 0), cap);
  assert.ok(Math.abs(axis.t1 - 0.6) < 1e-12 && Math.abs(axis.b.x - 12) < 1e-12);
  const direction = [Math.cos(Math.PI / 24), Math.sin(Math.PI / 24)];
  const facet = L.clipSegmentToConvex(point(0, 0), point(20 * direction[0], 20 * direction[1]), cap);
  assert.ok(Math.abs(Math.hypot(facet.b.x, facet.b.y) - 11.8973) < 1e-4, `${Math.hypot(facet.b.x, facet.b.y)}`);
  assert.ok(Math.abs(Math.hypot(facet.b.x, facet.b.y) - 12 * Math.cos(Math.PI / 24)) < 1e-12);
  // Every clipped end lies on the patch boundary: on the patch, and any step further is off it.
  const patch = M.cargoFacePatch('+x', M.getCargoGeometrySignature(DRUM));
  const rand = lcg(11);
  let hits = 0;
  for (let i = 0; i < 400; i++) {
    const a = point((rand() - 0.5) * 40, (rand() - 0.5) * 40);
    const b = point((rand() - 0.5) * 40, (rand() - 0.5) * 40);
    const r = L.clipSegmentToConvex(a, b, cap);
    if (!r) continue;
    hits++;
    assert.ok(M.patchContains(patch, r.a.x, r.a.y, 1e-9) && M.patchContains(patch, r.b.x, r.b.y, 1e-9), 'both ends are on the patch');
    if (r.t1 < 1) assert.equal(M.patchContains(patch, a.x + (b.x - a.x) * (r.t1 + 1e-4), a.y + (b.y - a.y) * (r.t1 + 1e-4), 1e-9), false, 'just past the exit is off it');
    if (r.t0 > 0) assert.equal(M.patchContains(patch, a.x + (b.x - a.x) * (r.t0 - 1e-4), a.y + (b.y - a.y) * (r.t0 - 1e-4), 1e-9), false, 'just before the entry is off it');
  }
  assert.ok(hits > 100);
});

// ============================================================================
// SECTION: LINE STYLES (V1B.2 Gate B.3) — an optional `style` on arrows and strokes; absent means Solid
// ============================================================================

const STYLED_TOP = (style, id = `top-${style}`) => draw(id, boxAnchor({ x: -14.25, y: 15, z: -6.5 }), [-10.4, -6.1, -6.8, -5.2, -2.1, -3.9], { face: '+y', style });
const STYLE_ARROW_KEYS = ['id', 'type', 'schemaVersion', 'color', 'width', 'style', 'hidden', 'start', 'end', 'createdAt', 'updatedAt'];
const STYLE_DRAW_KEYS = ['id', 'type', 'schemaVersion', 'color', 'width', 'style', 'hidden', 'anchor', 'face', 'points', 'createdAt', 'updatedAt'];

test('line style: Solid is the absence of the key, so a record saved before line styles stays byte for byte what it was', () => {
  assert.deepEqual([...A.LINE_STYLES], ['solid', 'dashed', 'dotted']);
  assert.equal(A.DEFAULT_LINE_STYLE, 'solid');
  assert.equal(A.ANNOTATION_SCHEMA_VERSION, 1, 'the schema version is not bumped');
  // The exact stored spelling a V1B.1 arrow has: key order and all.
  const legacyArrow = {
    id: 'a1', type: 'arrow', schemaVersion: 1, color: 'ink', width: 'regular', hidden: false,
    start: ground(5, 5), end: ground(40, 5), createdAt: 1000, updatedAt: 1000,
  };
  const legacyText = JSON.stringify(legacyArrow);
  assert.equal(A.validateArrowRecord(legacyArrow), null);
  assert.equal(JSON.stringify(A.normalizeAnnotations([legacyArrow])[0]), legacyText, 'a legacy arrow is unchanged by normalization');
  assert.equal(JSON.stringify(A.normalizeAnnotations(JSON.parse(`[${legacyText}]`))[0]), legacyText, 'and by a JSON round trip');
  assert.equal(JSON.stringify(arrow('a1')), legacyText, 'a new Solid arrow with no style is that same record');
  assert.equal(JSON.stringify(arrow('a1', ground(5, 5), ground(40, 5), { style: undefined })), legacyText, 'an unspecified style adds no key');
  assert.deepEqual(Object.keys(TOP_STROKE()), STYLE_DRAW_KEYS.filter(key => key !== 'style'), 'nor does a stroke');
  // Naming Solid explicitly is accepted and stored as nothing, never as `style: "solid"`.
  for (const explicit of [arrow('a1', ground(5, 5), ground(40, 5), { style: 'solid' }), { ...TOP_STROKE(), style: 'solid' }, STYLED_TOP('solid', 'top')]) {
    assert.equal(A.validateAnnotationCollection([explicit]).ok, true, explicit.id);
    const [stored] = A.normalizeAnnotations([explicit]);
    assert.equal(Object.hasOwn(stored, 'style'), false, `${explicit.id}: canonical Solid omits the key`);
  }
  assert.equal(JSON.stringify(A.normalizeAnnotations([arrow('a1', ground(5, 5), ground(40, 5), { style: 'solid' })])[0]), legacyText);
  assert.equal(JSON.stringify(A.normalizeAnnotations([STYLED_TOP('solid', 'top')])[0]), JSON.stringify(A.normalizeAnnotations([{ ...without(STYLED_TOP('solid', 'top'), 'style') }])[0]));
});

test('line style: Dashed and Dotted validate, keep their place in the record, round-trip and change nothing but themselves when edited', () => {
  for (const style of ['dashed', 'dotted']) {
    const styledArrow = arrow(`a-${style}`, onCargo('inst-1'), FLOOR_ANCHOR, { style, width: 'bold', color: '#A1B2C3' });
    const styledStroke = STYLED_TOP(style);
    assert.deepEqual(Object.keys(styledArrow), STYLE_ARROW_KEYS);
    assert.deepEqual(Object.keys(styledStroke), STYLE_DRAW_KEYS);
    for (const record of [styledArrow, styledStroke]) {
      assert.equal(record.style, style);
      assert.equal(record.type === 'arrow' ? A.validateArrowRecord(record) : A.validateDrawRecord(record), null, `${record.id} is valid`);
      const [stored] = A.normalizeAnnotations([record]);
      assert.deepEqual(stored, record, `${record.id}: stored as given`);
      assert.deepEqual(Object.keys(stored), Object.keys(record), `${record.id}: with the style beside the width`);
      assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify([record]))), [stored], `${record.id}: survives a JSON round trip`);
      assert.deepEqual(A.validateAnnotationCollection([record]).annotations, [stored]);
    }
    // Editing the style moves nothing else: endpoints, anchor, face, vertices, identity, creation time and presentation stay.
    const plain = arrow('p', onCargo('inst-1'), FLOOR_ANCHOR, { width: 'thin', color: 'red' });
    const restyled = A.editArrowRecord(plain, { style }, 2000);
    assert.equal(restyled.style, style);
    assert.deepEqual(Object.keys(restyled), STYLE_ARROW_KEYS);
    const [plainStored] = A.normalizeAnnotations([plain]);
    assert.equal(JSON.stringify({ ...restyled, style: undefined, updatedAt: 0 }), JSON.stringify({ ...plainStored, style: undefined, updatedAt: 0 }), 'the arrow differs by its style (and update time) alone');
    assert.equal(restyled.updatedAt, 2000);
    const back = A.editArrowRecord(restyled, { style: 'solid' }, 3000);
    assert.equal(JSON.stringify(back), JSON.stringify({ ...plainStored, updatedAt: 3000 }), 'back to Solid, the key is gone again');
    const base = A.normalizeAnnotations([TOP_STROKE()])[0];
    const strokeRestyled = A.editDrawRecord(base, { style }, 2000);
    assert.equal(strokeRestyled.style, style);
    assert.equal(JSON.stringify([strokeRestyled.anchor, strokeRestyled.face, strokeRestyled.points, strokeRestyled.id, strokeRestyled.createdAt, strokeRestyled.color, strokeRestyled.width, strokeRestyled.hidden]),
      JSON.stringify([base.anchor, base.face, base.points, base.id, base.createdAt, base.color, base.width, base.hidden]), 'a style edit cannot move or re-attach a stroke');
    assert.equal(JSON.stringify(A.editDrawRecord(strokeRestyled, { style: 'solid' }, 3000)), JSON.stringify({ ...base, updatedAt: 3000 }));
    // The other presentation edits keep the style they find.
    assert.equal(A.editArrowRecord(restyled, { width: 'bold', hidden: true }, 4000).style, style);
    assert.equal(A.editDrawRecord(strokeRestyled, { color: 'blue', hidden: true }, 4000).style, style);
  }
  const bytes = record => new TextEncoder().encode(JSON.stringify(A.normalizeAnnotations([record])[0])).length;
  assert.ok(bytes(STYLED_TOP('dotted')) > bytes(without(STYLED_TOP('dotted'), 'style')), 'a stored style counts toward the record size');
});

test('line style: an unknown style makes the record unreadable and is kept verbatim, and callouts do not take one', () => {
  for (const bad of ['wavy', 'Dashed', 'DOTTED', ' dashed', '', null, 0, true, ['dashed'], { value: 'dashed' }]) {
    const label = JSON.stringify(bad);
    const badArrow = { ...arrow('x'), style: bad };
    const badStroke = { ...TOP_STROKE(), style: bad };
    assert.match(A.validateArrowRecord(badArrow) || '', /style/, `arrow ${label}`);
    assert.match(A.validateDrawRecord(badStroke) || '', /style/, `stroke ${label}`);
    assert.equal(A.validateAnnotationCollection([badArrow]).ok, false, `the strict gate refuses an arrow with ${label}`);
    const [wrapped, wrappedStroke] = A.normalizeAnnotations([badArrow, badStroke]);
    assert.equal(wrapped.type, A.ANNOTATION_TYPE_UNREADABLE, `arrow ${label}`);
    assert.equal(wrappedStroke.type, A.ANNOTATION_TYPE_UNREADABLE, `stroke ${label}`);
    assert.deepEqual([wrapped.original, wrappedStroke.original], [badArrow, badStroke], 'the original is kept verbatim, never repaired to Solid');
  }
  assert.equal(A.editArrowRecord(arrow('e'), { style: 'wavy' }, 2000), null);
  assert.equal(A.editArrowRecord(arrow('e'), { style: undefined }, 2000), null);
  assert.equal(A.editDrawRecord(TOP_STROKE(), { style: 'Dashed' }, 2000), null);
  // The create helpers keep an invalid style as given, so the write gate refuses it instead of storing another value.
  assert.equal(arrow('k', ground(1, 1), ground(9, 9), { style: 'wavy' }).style, 'wavy');
  assert.equal(A.validateAnnotationCollection([arrow('k', ground(1, 1), ground(9, 9), { style: 'wavy' })]).ok, false);
  // Callouts have no style: they neither take one nor change their stored form.
  const plainCallout = callout('c');
  assert.equal(Object.hasOwn(A.createCalloutRecord({ id: 'c', anchor: ground(5, 5), title: 'Fragile', now: 1000, style: 'dashed' }), 'style'), false);
  assert.equal(Object.hasOwn(A.normalizeAnnotations([{ ...plainCallout, style: 'dashed' }])[0], 'style'), false, 'a stray style is never stored on a callout');
  assert.equal(JSON.stringify(A.normalizeAnnotations([plainCallout])[0]), JSON.stringify(plainCallout), 'a callout is stored exactly as before');
});

// ============================================================================
// SECTION: FREEHAND STROKES (V1B.2 Gate B.4) — rigid move of a whole stroke on its own surface
// ============================================================================

/** Every vertex of a stroke as `[u, v]` in its own surface frame, anchor first. */
const strokeUV = record => {
  const first = M.drawAnchorUV(record.anchor, record.face);
  const flat = [first.u, first.v, ...record.points];
  return Array.from({ length: flat.length / 2 }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]);
};
const MOVE_FIXTURES = [
  ['box top', TOP_STROKE], ['box side', SIDE_STROKE], ['cylinder cap', CAP_STROKE], ['floor', FLOOR_STROKE], ['wall', WALL_STROKE],
];

test('drawing move: every vertex, anchor included, moves by one identical surface-local offset and nothing else changes', () => {
  for (const [label, make] of MOVE_FIXTURES) {
    const before = make();
    const frozen = JSON.parse(JSON.stringify(before));
    const moved = A.translateDrawRecord(before, 3.25, -2.5, 5000);
    assert.ok(moved, `${label}: the move is valid`);
    assert.deepEqual(before, frozen, `${label}: the input record is never mutated`);
    assert.equal(A.validateDrawRecord(moved), null, `${label}: the moved stroke is a valid record`);
    assert.equal(JSON.stringify(A.normalizeAnnotations([moved])[0]), JSON.stringify(moved), `${label}: the result is already canonical`);
    const [old, now] = [strokeUV(before), strokeUV(moved)];
    assert.equal(now.length, old.length, `${label}: same vertex count`);
    now.forEach(([u, v], i) => {
      assert.ok(Math.abs(u - old[i][0] - 3.25) < 1e-9 && Math.abs(v - old[i][1] + 2.5) < 1e-9, `${label}: vertex ${i} moved by exactly (3.25, -2.5)`);
    });
    assert.ok(moved.points.every(value => Math.round(value * 100) / 100 === value), `${label}: stored vertices stay on the 0.01 in grid`);
    // Everything but the geometry is carried over exactly.
    const keep = record => ({ ...record, anchor: undefined, points: undefined, updatedAt: undefined });
    assert.deepEqual(keep(moved), keep(before), `${label}: id, type, color, width, hidden, face and createdAt are preserved`);
    assert.equal(moved.updatedAt, 5000, `${label}: updatedAt is the time of the move`);
    assert.equal(moved.createdAt, before.createdAt);
    // The anchor keeps its kind, identity, signature and truck evidence, and its coordinate along the normal.
    const home = before.anchor.kind === 'cargo' ? 'local' : 'position';
    const frame = M.cargoFaceFrame(M.drawFrameKey(before.anchor, before.face));
    assert.deepEqual({ ...moved.anchor, [home]: undefined }, { ...before.anchor, [home]: undefined }, `${label}: anchor identity is preserved`);
    assert.equal(moved.anchor[home][frame.normal], before.anchor[home][frame.normal], `${label}: the plane coordinate is untouched`);
  }
});

test('drawing move: the offset snaps to the grid, and a zero or sub-grid offset is a no-op that keeps updatedAt', () => {
  const stroke = TOP_STROKE();
  const snapped = A.translateDrawRecord(stroke, 3.2549, -0.0051, 5000);
  assert.deepEqual(strokeUV(snapped).map(([u, v], i) => [u - strokeUV(stroke)[i][0], v - strokeUV(stroke)[i][1]].map(x => Math.round(x * 1e6) / 1e6)),
    strokeUV(stroke).map(() => [3.25, -0.01]), 'the offset is snapped to 0.01 before it is applied to every vertex');
  for (const [du, dv] of [[0, 0], [0.004, -0.004], [-0, 0], [0.0049, 0.0049]]) {
    const same = A.translateDrawRecord(stroke, du, dv, 5000);
    assert.equal(JSON.stringify(same), JSON.stringify(A.normalizeAnnotations([stroke])[0]), `(${du}, ${dv}) changes nothing, not even updatedAt`);
  }
  // Bad input is refused, never repaired.
  for (const [du, dv] of [[NaN, 0], [0, Infinity], ['1', 0], [null, 1], [undefined, 1]]) {
    assert.equal(A.translateDrawRecord(stroke, du, dv, 5000), null, `(${du}, ${dv}) is refused`);
  }
  assert.equal(A.translateDrawRecord(stroke, 1, 1, NaN), null);
  assert.equal(A.translateDrawRecord({ ...stroke, type: 'arrow' }, 1, 1, 5000), null);
  assert.equal(A.translateDrawRecord({ ...stroke, color: 'plaid' }, 1, 1, 5000), null, 'an invalid source stroke is not moved');
  assert.equal(A.translateDrawRecord(null, 1, 1, 5000), null);
});

test('drawing move: a move that leaves its cargo face, cap polygon, floor or wall is refused whole', () => {
  // Box top: x spans -24..24 and the stroke reaches x = 9.8, so +14.2 lands exactly on the edge and +14.25 is over it.
  const top = TOP_STROKE();
  assert.ok(A.translateDrawRecord(top, 14.2, 0, 5000), 'a stroke that ends exactly on the face edge is kept');
  assert.equal(A.translateDrawRecord(top, 14.25, 0, 5000), null, 'one vertex past the edge refuses the whole move');
  assert.ok(A.translateDrawRecord(top, -9.75, 0, 5000), 'the other edge: the anchor reaches u = -24');
  assert.equal(A.translateDrawRecord(top, -9.8, 0, 5000), null);
  assert.equal(A.translateDrawRecord(top, 0, 20.1, 5000), null, 'past the far edge on the other axis');
  assert.equal(A.translateDrawRecord(top, 1000, 1000, 5000), null, 'a huge move is refused, not clamped');
  assert.equal(A.translateDrawRecord(top, 1e9, 0, 5000), null, 'a move beyond the stored coordinate bound is refused');
  // Cylinder cap: a real 24-gon of circumradius 12, apothem 11.897 — the circle around it is NOT the boundary.
  const cap = draw('cap-edge', drumAnchor({ x: 30, y: 5, z: 0 }), [0.5, 5.4], { face: '+x' });
  assert.ok(A.translateDrawRecord(cap, 0, 6.4, 5000), 'a vertex inside the polygon is kept');
  assert.equal(A.translateDrawRecord(cap, 0, 6.55, 5000), null, 'a vertex at radius 11.96 is inside the circle but outside the polygon');
  assert.equal(A.translateDrawRecord(CAP_STROKE(), 0, 6, 5000), null, 'above the cap');
  assert.equal(A.translateDrawRecord(CAP_STROKE(), 20, 0, 5000), null, 'beside the cap');
  // A floor or wall stroke is judged against the layout at write time: the pure result is valid, the placement is not.
  const ctx = drawContext();
  const floor = FLOOR_STROKE();
  const verdict = (record, du, dv, context = ctx) => {
    const moved = A.translateDrawRecord(record, du, dv, 5000);
    return moved ? A.drawPlacementProblem(moved, context) : 'refused';
  };
  assert.equal(verdict(floor, 0, 60.9), null, 'a stroke ending on the wall line is placed');
  assert.equal(verdict(floor, 0, 61.1), 'unresolved', 'one vertex past the truck wall refuses the whole move');
  assert.equal(verdict(floor, -120.5, 0), null);
  assert.equal(verdict(floor, -120.6, 0), 'unresolved', 'behind the rear of the truck');
  const wall = WALL_STROKE();
  assert.equal(verdict(wall, 0, 50.5), null, 'up to the ceiling line');
  assert.equal(verdict(wall, 0, 50.6), 'unresolved', 'through the ceiling');
  assert.equal(verdict(wall, 0, -41), 'refused', 'below the floor the anchor itself is off the wall, so even the pure helper refuses');
  // A wheel well splits the floor: a stroke on the main floor cannot be carried across the well edge.
  const well = drawContext({ truck: WELL_TRUCK, zones: WELL_ZONES });
  const lane = draw('lane', floorAt(100, 45), [110, 45, 120, 45]);
  assert.equal(A.drawPlacementProblem(lane, well), null, 'the fixture sits on the full-width floor in front of the wells');
  assert.equal(verdict(lane, 0, -45, well), null, 'moved along the same floor');
  assert.equal(verdict(lane, 100, 0, well), 'unresolved', 'carried onto the raised wheel well it is refused whole');
  assert.equal(verdict(lane, 100, -45, well), null, 'and the same distance along the open floor between the wells is fine');
});

test('drawing move: quantization corner cases — rigid for any offset, and a tie that would repeat a vertex is refused, not repaired', () => {
  // Fuzz: for every offset that is accepted the move is exactly rigid at the stored precision; otherwise it is refused.
  const next = lcg(20260826);
  let accepted = 0;
  for (let n = 0; n < 400; n++) {
    const make = MOVE_FIXTURES[n % MOVE_FIXTURES.length][1];
    const before = make();
    const du = (next() - 0.5) * 30;
    const dv = (next() - 0.5) * 30;
    const moved = A.translateDrawRecord(before, du, dv, 5000);
    if (!moved) continue;
    accepted += 1;
    const snapped = [Math.round(du * 100) / 100, Math.round(dv * 100) / 100];
    const [old, now] = [strokeUV(before), strokeUV(moved)];
    now.forEach(([u, v], i) => {
      assert.ok(Math.abs(u - old[i][0] - snapped[0]) < 1e-9 && Math.abs(v - old[i][1] - snapped[1]) < 1e-9, `fuzz ${n}: vertex ${i} is rigid`);
    });
    assert.equal(A.validateDrawRecord(moved), null, `fuzz ${n}: valid`);
  }
  assert.ok(accepted > 40, 'the fuzz exercises plenty of accepted moves, so the checks above are not vacuous');
  // The anchor is stored at 4 decimals and compared on the 0.01 grid with the first stored vertex. Anchor 10.075 (which
  // rounds down on the grid) and a vertex at 10.08 are distinct there; shifted by 0.5 the anchor rounds up onto 10.58 and
  // the stroke would repeat a vertex.
  const tie = draw('tie', floorAt(10.075, 5), [10.08, 5, 12, 6]);
  assert.equal(A.validateDrawRecord(tie), null, 'the fixture is a valid stroke');
  assert.equal(A.translateDrawRecord(tie, 0.5, 0, 5000), null, 'the tie is refused (nothing is nudged or dropped)');
  assert.ok(A.translateDrawRecord(tie, -1.5, 0, 5000), 'an offset that does not flip the anchor onto the vertex moves it');
  // Precision: the anchor keeps its own 4-decimal precision after the move.
  const precise = draw('precise', boxAnchor({ x: -14.2537, y: 15, z: -6.5123 }), [-10.4, -6.1, -6.8, -5.2], { face: '+y' });
  const moved = A.translateDrawRecord(precise, 0.07, 0.03, 5000);
  assert.deepEqual(moved.anchor.local, { x: -14.1837, y: 15, z: -6.4823 }, 'anchor offsets add exactly at 4 decimals');
});

test('arrows and drawings take an optional name: a legacy record keeps its exact stored form, a name round-trips, a blank name clears it and an invalid stored name is unreadable', () => {
  const legacyArrow = arrow('a-legacy');
  assert.equal(Object.hasOwn(legacyArrow, 'name'), false, 'a record that was never named has no name key');
  const named = A.editArrowRecord(legacyArrow, { name: '  Left   pallet ' }, 5000);
  assert.equal(named.name, 'Left pallet', 'a custom name is one normalized line');
  assert.equal(named.id, legacyArrow.id);
  assert.equal(named.createdAt, legacyArrow.createdAt);
  assert.deepEqual(named.start, legacyArrow.start, 'renaming never changes the anchors');
  assert.deepEqual(named.end, legacyArrow.end);
  assert.equal(named.hidden, legacyArrow.hidden);
  assert.equal(named.width, legacyArrow.width);
  assert.equal(named.color, legacyArrow.color);
  assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify([named]))), [named], 'the name survives save and reload');
  assert.equal(A.editArrowRecord(named, { name: '   ' }, 6000).name, undefined, 'a blank name removes the custom name');
  assert.equal(A.editArrowRecord(named, { name: '' }, 6000).name, undefined);
  assert.equal(A.editArrowRecord(legacyArrow, { name: 'x'.repeat(A.MAX_ANNOTATION_NAME_LENGTH + 5) }, 5000).name.length, A.MAX_ANNOTATION_NAME_LENGTH);
  assert.equal(A.validateArrowRecord({ ...legacyArrow, name: '' }), 'name is invalid', 'a stored blank name is not a silent legacy record');
  assert.equal(A.validateArrowRecord({ ...legacyArrow, name: 7 }), 'name is invalid');
  assert.equal(A.validateArrowRecord({ ...legacyArrow, name: 'x'.repeat(A.MAX_ANNOTATION_NAME_LENGTH + 1) }), 'name is invalid');
  assert.equal(A.validateArrowRecord({ ...legacyArrow, label: 'Left' }), 'record has an unsupported field', 'only the name key is new');

  const legacyDraw = FLOOR_STROKE();
  assert.equal(Object.hasOwn(legacyDraw, 'name'), false);
  const namedDraw = A.editDrawRecord(legacyDraw, { name: 'Floor mark' }, 5000);
  assert.equal(namedDraw.name, 'Floor mark');
  assert.deepEqual(namedDraw.points, legacyDraw.points, 'renaming a drawing keeps its geometry');
  assert.deepEqual(namedDraw.anchor, legacyDraw.anchor);
  assert.equal(namedDraw.createdAt, legacyDraw.createdAt);
  assert.deepEqual(A.normalizeAnnotations(JSON.parse(JSON.stringify([namedDraw]))), [namedDraw]);
  assert.equal(A.validateDrawRecord({ ...legacyDraw, name: '' }), 'name is invalid');
  assert.equal(A.validateDrawRecord({ ...legacyDraw, title: 'Floor' }), 'record has an unsupported field');
  assert.equal(A.editDrawRecord(legacyDraw, { name: '   ' }, 5000).name, undefined);
});
