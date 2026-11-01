import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Measurement Tool V1 interaction contract (docs/product/TP3D-MASTER-TODO-V6.md Section 4.1).
//
// Drives the REAL Editor runtime in Chromium, the way autopack-editor-interaction.spec.mjs does:
// index.html markup, main.css, three r185 + OrbitControls, SceneManager, CaseScene, the real
// InteractionManager/EditorUI/KeyboardManager wired with the real MeasurementTool, and app.js's own
// StateStore render subscriber extracted verbatim. Disposable in-memory data only: every non-local
// request is aborted and auth, billing, storage scope and persistence are not involved.
// Pins G5 (capture exclusion), G6 (pointer/keyboard ownership), the passive-capture rule, single-click
// delete, endpoint repositioning and the movable panel.

const ORIGIN = 'http://localhost:5598';
const repo = new URL('../../', import.meta.url);
const read = (path, encoding = 'utf8') => readFile(new URL(path, repo), encoding);

const appSource = await read('src/app.js');
const subscriberAnchor = appSource.indexOf("let prevScreen = StateStore.get('currentScreen');");
const subscriberStart = appSource.indexOf('StateStore.subscribe(', subscriberAnchor);
const subscriberEnd = appSource.indexOf('\n      });\n\n      try {\n        Router.init(', subscriberStart);
assert.ok(subscriberAnchor >= 0 && subscriberStart > subscriberAnchor && subscriberEnd > subscriberStart,
  'app.js StateStore render subscriber is extractable');
const appSubscriber = appSource.slice(subscriberStart + 'StateStore.subscribe('.length, subscriberEnd + '\n      }'.length);
assert.match(appSubscriber, /notification\?\.type === 'pack-measurements'\) \{\s*PacksUI\.render\(\);\s*EditorUI\.syncMeasurements\(\);\s*AutoPackPreviewScheduler\.schedule\(\);\s*return;/,
  'a measurement-only write refreshes the card and the overlay without a scene or Inspector render, and re-requests the preview freshness check');

const importMap = JSON.stringify({
  imports: { three: '/node_modules/three/build/three.module.js', 'three/addons/': '/node_modules/three/examples/jsm/' },
});
const rawIndex = await read('index.html');
assert.ok(rawIndex.includes('<head>'), 'index.html head is present');
const indexHtml = rawIndex.replace('<head>', `<head><script type="importmap">${importMap}</script>`);

const bootstrap = `
import { createUIComponents } from '/src/ui/ui-components.js';
import { createKeyboardManager } from '/src/ui/keyboard-manager.js';
import { createAppShell } from '/src/ui/app-shell.js';
import { createOperationLifecycle } from '/src/core/operation-lifecycle.js';
import { TrailerPresets } from '/src/data/trailer-presets.js';
import { createSceneRuntime } from '/src/editor/scene-runtime.js';
import { createTrailerGeometry } from '/src/editor/trailer-geometry.js';
import { createMeasurementTool } from '/src/editor/measurement-tool.js';
import { createCaseScene, createInteractionManager, createEditorScreen } from '/src/screens/editor-screen.js';
import { createTruckChangeController } from '/src/ui/truck-change-controller.js';
import * as CoreUtils from '/src/core/utils/index.js';
import * as BrowserUtils from '/src/core/browser.js';
import * as Defaults from '/src/core/defaults.js';
import * as CoreStateStore from '/src/core/state-store.js';
import * as CategoryService from '/src/services/category-service.js';
import * as CaseLibrary from '/src/services/case-library.js';
import * as PackLibrary from '/src/services/pack-library.js';
import { createAutoPackEngine } from '/src/services/autopack-engine.js';
import * as PreferencesManager from '/src/services/preferences-manager.js';
import * as M from '/src/core/measurements.js';

const APP_SUBSCRIBER = ${JSON.stringify(appSubscriber)};

await window.__TP3D_BOOT.threeReady;
const UIComponents = createUIComponents();
const Utils = { ...CoreUtils, ...BrowserUtils };
const StateStore = {
  init: CoreStateStore.init, get: CoreStateStore.get, set: CoreStateStore.set, replace: CoreStateStore.replace,
  snapshot: CoreStateStore.snapshot, resetHistory: CoreStateStore.resetHistory, undo: CoreStateStore.undo,
  redo: CoreStateStore.redo, subscribe: CoreStateStore.subscribe,
};

const cases = Defaults.seedCases().slice(0, 2);
cases.forEach(c => { c.volume = Utils.volumeInCubicInches(c.dimensions); });
const packId = 'fixture-pack';
const packed = (id, caseData, x, z) => ({
  id, caseId: caseData.id, hidden: false, groupId: null, placement: 'packed',
  transform: { position: { x, y: caseData.dimensions.height / 2, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});
StateStore.init({
  currentScreen: 'editor', currentPackId: packId, selectedInstanceIds: [], caseLibrary: cases,
  packLibrary: [{ id: packId, title: 'Fixture', truck: { length: 636, width: 102, height: 110, shapeMode: 'rect' },
    cases: [packed('cargo-a', cases[0], 70, -20), packed('cargo-b', cases[1], 300, 20)], groups: [], createdAt: 1, lastEdited: 1 }],
  folderLibrary: [], preferences: Defaults.defaultPreferences,
});

let SceneManager = null;
const TrailerGeometry = createTrailerGeometry({ Utils, CorePackLibrary: PackLibrary, getSceneManager: () => SceneManager });
const AppShell = createAppShell({ StateStore, PackLibrary, Utils });
SceneManager = createSceneRuntime({ Utils, UIComponents, PreferencesManager, TrailerGeometry, StateStore });
const CaseScene = createCaseScene({ SceneManager, CaseLibrary, CategoryService, PackLibrary, StateStore, TrailerGeometry, Utils, PreferencesManager });
const OperationLifecycle = createOperationLifecycle();
const MeasurementTool = createMeasurementTool({ SceneManager, CaseScene, CaseLibrary, PackLibrary, StateStore, PreferencesManager, UIComponents, OperationLifecycle });
const InteractionManager = createInteractionManager({ SceneManager, CaseScene, StateStore, PackLibrary, CaseLibrary, PreferencesManager, UIComponents, OperationLifecycle, MeasurementTool });
const ExportService = { captureScreenshot() {}, generatePDF() {}, capturePackPreview: () => false, clearPackPreview: () => false };
window.__TP3D_BILLING = { getBillingState: () => ({ ok: true, orgId: '' }) };
const AutoPackEngine = createAutoPackEngine({
  CaseLibrary, CaseScene, OperationLifecycle, capturePackPreview: () => false,
  getActiveOrgIdForBilling: () => '', getOrgRoleHydrationState: () => 'ready',
  getProRuleSet: () => ({ canUseProFeature: true }), getWorkspaceSwitchState: () => null,
  maybeScheduleBillingRefresh() {}, normalizeOrgIdForBilling: value => value, openSettingsOverlay() {},
  PackLibrary, runtimeWindow: window, SceneManager, StateStore, toast: (...args) => UIComponents.showToast(...args),
  TrailerGeometry, UIComponents, Utils,
});
const TruckChangeController = createTruckChangeController({ PackLibrary, CaseLibrary, UIComponents, documentRef: document });
const EditorUI = createEditorScreen({
  StateStore, PackLibrary, CaseLibrary, PreferencesManager, UIComponents, Utils, TrailerGeometry, CategoryService,
  AutoPackEngine, ExportService, SystemOverlay: { show() {}, hide() {} }, TrailerPresets, AppShell, SceneManager,
  CaseScene, InteractionManager, TruckChangeController, OperationLifecycle, MeasurementTool,
});
const Storage = { saveSoon() {}, saveNow() {} };
const KeyboardManager = createKeyboardManager({
  StateStore, PackLibrary, CaseLibrary, CaseScene, SceneManager, InteractionManager, AutoPackEngine,
  OperationLifecycle, UIComponents, AppShell, Storage, Utils,
});

document.body.dataset.auth = 'signed_in';
AppShell.init();
EditorUI.init();
KeyboardManager.init();
const createAppSubscriber = new Function('deps', \`
  const { Storage, StateStore, PreferencesManager, SceneManager, EditorUI, AutoPackPreviewScheduler,
    PackLibrary, ExportService, AppShell, PacksUI, CasesUI, RecoverableErrorOverlay } = deps;
  const suspendAutoSave = false;
  let prevScreen = StateStore.get('currentScreen');
  return (\${APP_SUBSCRIBER});
\`);
StateStore.subscribe(createAppSubscriber({
  Storage, StateStore, PreferencesManager, SceneManager, EditorUI,
  AutoPackPreviewScheduler: { schedule() {} }, PackLibrary, ExportService, AppShell,
  PacksUI: { render() {} }, CasesUI: { render() {} }, RecoverableErrorOverlay: { syncRecoverableErrorOverlay() {} },
}));
AppShell.navigate('editor');
EditorUI.render();

const THREE = window.THREE;
const canvas = () => SceneManager.getRenderer().domElement;
const livePack = () => PackLibrary.getById(packId);
const hintEl = () => document.querySelector('.tp3d-measure-panel__hint');
window.probe = {
  StateStore, OperationLifecycle, SceneManager, CaseScene, PackLibrary, InteractionManager, MeasurementTool, PreferencesManager, M,
  modalOwner: () => (UIComponents.modalOwnership.getActiveOwner() || {}).kind || null,
  measurements: () => PackLibrary.getMeasurements(packId),
  resolved: () => PackLibrary.resolveMeasurements(packId),
  hint: () => (hintEl() ? hintEl().textContent : ''),
  selection: () => (StateStore.get('selectedInstanceIds') || []).slice(),
  casesJson: () => JSON.stringify(livePack().cases),
  camera() { const p = SceneManager.getCamera().position; return [p.x, p.y, p.z].map(n => +n.toFixed(4)).join(','); },
  // Screen point (client px) of a point given in Load Plan inches.
  screenOf(x, y, z) {
    const rect = canvas().getBoundingClientRect();
    const v = SceneManager.vecInchesToWorld({ x, y, z }).project(SceneManager.getCamera());
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  },
  // Screen point of a cargo's centre: the ray through it meets that cargo's own surface first.
  cargoPoint(id) {
    const rect = canvas().getBoundingClientRect();
    const v = CaseScene.getObject(id).position.clone().project(SceneManager.getCamera());
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  },
  sceneObjectCount() { let n = 0; SceneManager.getScene().traverse(() => { n += 1; }); return n; },
  canvasData() {
    const r = SceneManager.getRenderer();
    r.render(SceneManager.getScene(), SceneManager.getCamera());
    return canvas().toDataURL();
  },
  box: selector => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom };
  },
};
window.__EDITOR_READY = true;
`;

const CONTENT_TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json',
};
const SERVED = ['/src/', '/styles/', '/vendor/', '/media/', '/node_modules/three/'];

async function openEditor(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: indexHtml });
    if (url.pathname === '/src/app.js') return route.fulfill({ contentType: 'text/javascript', body: bootstrap });
    const ext = url.pathname.slice(url.pathname.lastIndexOf('.'));
    if (!SERVED.some(prefix => url.pathname.startsWith(prefix)) || !CONTENT_TYPES[ext]) {
      return route.fulfill({ status: 404, body: '' });
    }
    const text = /^\.(js|mjs|css|svg|json)$/.test(ext);
    const body = await read(url.pathname.slice(1), text ? 'utf8' : undefined).catch(() => null);
    return body === null
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: CONTENT_TYPES[ext], body });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => window.__EDITOR_READY === true);
  return { page, errors };
}

const launch = () => chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

// Measurements is a manager (toolbar button) and creation is its own control (New measurement): creating needs both.
async function startMeasuring(page) {
  const managerOpen = await page.evaluate(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  if (!managerOpen) await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  await page.click('#editor-measure-new');
  await page.waitForFunction(() => document.getElementById('editor-measure-new').getAttribute('aria-pressed') === 'true');
}

// A page already showing Measurement Mode with the camera settled (hover/pick need a rendered frame).
async function openMeasuring(browser) {
  const { page, errors } = await openEditor(browser);
  await page.waitForFunction(() => document.querySelector('#viewport canvas') && window.probe.SceneManager.getCamera());
  const rect = await page.evaluate(() => window.probe.box('#viewport canvas'));
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h - 30);
  await startMeasuring(page);
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  return { page, errors, rect };
}

const point = (page, x, y, z) => page.evaluate(([px, py, pz]) => window.probe.screenOf(px, py, pz), [x, y, z]);
const count = page => page.evaluate(() => window.probe.measurements().length);
const click = async (page, p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); };
async function measure(page, a, b) {
  const before = await count(page);
  await click(page, a);
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await click(page, b);
  await page.waitForFunction(n => window.probe.measurements().length === n + 1, before);
}
const GROUND_A = [100, 0, 70];
const GROUND_B = [260, 0, 80];
// The one step a committed write made: Undo reverts exactly that write and Redo restores exactly its result.
const oneStepRoundTrip = async (page, label) => {
  const packs = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('packLibrary')));
  const after = await packs();
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, `${label}: one Undo step`);
  assert.notEqual(await packs(), after, `${label}: Undo reverts it`);
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, `${label}: Redo replays it`);
  assert.equal(await packs(), after, `${label}: Redo restores the result`);
};

test('G6 two clicks save one measurement, return to Ready and leave cargo, selection, camera and Undo untouched', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));

  // Point A on cargo (any shape is measurable), Point B on the ground outside the truck.
  const badge = () => page.evaluate(() => { const c = document.querySelector('.tp3d-measure-panel__count'); return { text: c.textContent, shown: getComputedStyle(c).display !== 'none' }; });
  assert.deepEqual(await badge(), { text: '', shown: false }, 'no count badge while there are no measurements');
  const a = await page.evaluate(() => window.probe.cargoPoint('cargo-a'));
  await click(page, a);
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  const hintTone =() => page.evaluate(() => document.querySelector('.tp3d-measure-panel__hint').dataset.tone || null);
  assert.equal(await hintTone(), 'active', 'the guidance dot is orange while the second point is awaited');
  await click(page, await point(page, ...GROUND_B));
  await page.waitForFunction(() => window.probe.measurements().length === 1);
  assert.equal(await hintTone(), 'success', 'and green right after the measurement is saved');
  assert.deepEqual(await badge(), { text: '1', shown: true }, 'the count badge appears with the first measurement');
  const [first] = await page.evaluate(() => window.probe.measurements());
  assert.equal(first.start.kind, 'cargo', 'a cargo surface anchors to the cargo instance');
  assert.equal(first.start.instanceId, 'cargo-a');
  assert.equal(first.end.kind, 'space');
  assert.equal(first.end.surface, 'ground', 'the ground outside the truck is measurable');

  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'a click on cargo in the mode never selects it');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is never moved');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'clicking never orbits the camera');
  assert.ok(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited) > before.edited, 'lastEdited is updated');
  await oneStepRoundTrip(page, 'the measurement creation');
  assert.doesNotMatch(await page.evaluate(() => window.probe.hint()), /second point/i, 'back to Ready for Point A');

  // Consecutive, independent measurements.
  await measure(page, await point(page, 120, 0, 90), await point(page, 300, 0, 95));
  await measure(page, await point(page, 140, 0, -70), await point(page, 340, 0, -75));
  assert.equal(await count(page), 3);
  const ids = await page.evaluate(() => window.probe.measurements().map(m => m.id));
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(errors, []);
});

test('G6 orbit stays available in the mode, a drag never places a point, and turning the mode off restores cargo selection', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, rect } = await openMeasuring(browser);
  const cam = await page.evaluate(() => window.probe.camera());
  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 25, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(c => window.probe.camera() !== c, cam);
  assert.equal(await count(page), 0, 'an orbit drag is not a click: no point is placed');
  assert.doesNotMatch(await page.evaluate(() => window.probe.hint()), /second point/i);

  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'cargo is not selected while measuring');

  await page.click('#btn-editor-measure'); // off
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.evaluate(() => document.getElementById('editor-measure-panel').hidden), true);
  await page.mouse.move(cx, cy); // settle hover, then pick cargo as the Editor normally does
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().includes('cargo-b'));
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-b'], 'with the mode off, a click selects cargo exactly as before');
});

test('a background thumbnail capture never blocks or cancels a measurement, while real operations do and are named', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page } = await openMeasuring(browser);
  const a = await point(page, ...GROUND_A);
  const b = await point(page, ...GROUND_B);

  await click(page, a);
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await page.evaluate(() => { window.__capture = window.probe.OperationLifecycle.beginOperation('capturingPreview'); });
  await page.waitForTimeout(250); // a few frames and lifecycle notifications
  assert.match(await page.evaluate(() => window.probe.hint()), /second point/i, 'Point A survives a passive capture');
  await click(page, b);
  await page.waitForFunction(() => window.probe.measurements().length === 1);
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__capture));

  await click(page, a);
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('autopacking'); });
  await page.waitForFunction(() => /read-only while AutoPack is running/.test(window.probe.hint()));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-row__delete')].every(btn => btn.disabled)), true,
    'rename and delete are unavailable while AutoPack runs');
  await click(page, b);
  assert.equal(await count(page), 1, 'nothing is created while AutoPack runs, and Point A was cancelled by it');
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
  await page.waitForFunction(() => !/read-only/.test(window.probe.hint()));
  await measure(page, a, b);
  assert.equal(await count(page), 2, 'editing resumes when the operation ends');
});

// Creation armed = the New measurement control is pressed (the toolbar button only shows the manager).
const modeIsOff = () => document.getElementById('editor-measure-new').getAttribute('aria-pressed') === 'false';
// What the measurement overlay is drawing right now: segment kinds, visible labels, visible markers.
const overlayState = page => page.evaluate(() => ({
  segments: [...document.querySelectorAll('.tp3d-measure-svg__segment')]
    .map(group => group.getAttribute('class').replace('tp3d-measure-svg__segment', '').trim()),
  labels: [...document.querySelectorAll('.tp3d-measure-label')].filter(label => !label.hidden).length,
  markers: [...document.querySelectorAll('.tp3d-measure-svg__marker')].filter(marker => marker.style.display !== 'none').length,
}));
const modeIsOn = () => document.getElementById('editor-measure-new').getAttribute('aria-pressed') === 'true';

test('one Escape fully exits Measurement Mode: unfinished work is dropped, saved measurements stay, and no other Escape owner sees the key', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  // Select cargo with the mode off, then measure: the selection survives and Escape has two candidate owners.
  await page.click('#btn-editor-measure');
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().includes('cargo-b'));
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);

  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  const saved = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  const edited = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);

  // Point A is pending: one Escape drops it, leaves the mode and writes nothing.
  await click(page, await point(page, 120, 0, 90));
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);
  assert.equal(await page.evaluate(() => document.getElementById('editor-measure-panel').hidden), false, 'Escape ends creation only: the Measurements manager stays open');
  assert.equal(await page.evaluate(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed')), 'true');
  assert.deepEqual(await overlayState(page), { segments: ['is-saved'], labels: 1, markers: 0 },
    'only the saved line and its label stay (view only): the unfinished point, preview, ghost, markers and grips are gone');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved, 'saved measurements are preserved and the unfinished one never appears');
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), edited, 'nothing was written');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-b'],
    'the consumed Escape did not also deselect cargo');
  assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'btn-editor-measure');

  // A second Escape has no Measurement Tool effect: it is the ordinary Escape (deselect) again.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probe.selection().length === 0);
  assert.equal(await page.evaluate(modeIsOff), true);
  assert.equal(await count(page), 1);

  // Turning the mode back on shows the saved measurement again.
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-row').length === 1 &&
    document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);

  // A bare selection is not a reason to stay: Escape leaves the mode there too.
  await page.click('.tp3d-measure-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-selected').length === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);
  assert.equal(await count(page), 1);

  // Undo with an unfinished Point A cancels only that point; cargo history is untouched.
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  await click(page, await point(page, ...GROUND_A));
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  const cases = await page.evaluate(() => window.probe.casesJson());
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !/second point/i.test(window.probe.hint()));
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cases);
  assert.equal(await page.evaluate(modeIsOn), true, 'Undo cancels the gesture and leaves the mode on');
  assert.deepEqual(errors, []);
});

test('Escape yields to a dropdown or a text field that owns it, and the next Escape exits', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));

  // A dropdown owns Escape: it closes, the mode stays.
  await page.click('#btn-editor-view');
  await page.waitForFunction(() => window.probe.modalOwner() === 'popup');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probe.modalOwner() === null);
  assert.equal(await page.evaluate(modeIsOn), true, 'the first Escape only closed the dropdown');
  assert.equal(await count(page), 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);

  // The load-status popover owns Escape the same way.
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  await page.evaluate(() => document.getElementById('editor-validation-status-btn').click());
  await page.waitForFunction(() => !document.getElementById('editor-validation-popover').hidden);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('editor-validation-popover').hidden);
  assert.equal(await page.evaluate(modeIsOn), true, 'the first Escape only closed the popover');
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);

  // A rename field owns Escape: it cancels the edit, the mode stays.
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  const name = await page.evaluate(() => window.probe.measurements()[0].label);
  await page.click('.tp3d-measure-row__rename');
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('tp3d-measure-row__input'));
  await page.keyboard.type('Draft');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.tp3d-measure-row__input').hidden);
  assert.equal(await page.evaluate(modeIsOn), true, 'the first Escape only cancelled the rename');
  assert.equal(await page.evaluate(() => window.probe.measurements()[0].label), name, 'and the draft was discarded');
  assert.deepEqual(errors, []);
});

test('Escape never sends focus to the ruler: it returns to the 3D viewport from the ruler or the panel', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  // A click on New measurement leaves focus on that control.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'editor-measure-new');
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'viewport', 'focus moved to the viewport, not kept on or sent to the ruler');
  const ring = () => page.evaluate(() => getComputedStyle(document.getElementById('viewport')).outlineStyle);
  assert.equal(await ring(), 'none', 'after mouse use the Escape press paints no focus frame around the 3D view');

  // Focus inside the manager: Escape ends creation, the manager stays open, and focus still returns to the viewport.
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  await page.click('.tp3d-measure-panel__toggle');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#editor-measure-panel')), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'viewport', 'focus returns to the 3D viewport, not to the ruler');
  assert.equal(await ring(), 'none', 'and none from the panel either');

  // Keyboard use keeps its visible focus: the ring shows, and its marker never lingers once focus moves on.
  // The manager is still open (its earlier collapse is undone), so the keyboard arms creation from its New measurement control.
  if (await page.evaluate(() => document.querySelector('.tp3d-measure-panel__body').hidden)) await page.click('.tp3d-measure-panel__toggle');
  await page.focus('#editor-measure-new');
  await page.keyboard.press('Enter');
  await page.waitForFunction(modeIsOn);
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'viewport');
  assert.equal(await ring(), 'solid', 'a keyboard user still sees where focus went');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('viewport').classList.contains('tp3d-pointer-focus')), false);
  assert.deepEqual(errors, []);
});

test('cargo keys stay available in the mode; a pending point that loses its cargo is cancelled and no measurement is lost', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  // Select cargo-b with the mode off, then measure from it.
  await page.click('#btn-editor-measure');
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().includes('cargo-b'));
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  await measure(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')), await point(page, ...GROUND_B));
  const saved = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  assert.equal(JSON.parse(saved)[0].start.instanceId, 'cargo-b');

  // Point A on the selected cargo, then Delete (a cargo key on the viewport) removes that cargo.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await page.focus('#viewport');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => !window.probe.PackLibrary.getById('fixture-pack').cases.some(c => c.id === 'cargo-b'));
  await page.waitForFunction(() => !/second point/i.test(window.probe.hint()));
  assert.equal(await page.evaluate(modeIsOn), true, 'the mode itself is unaffected');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved,
    'the stored measurement is kept untouched (it is flagged, never deleted or rewritten) and the cancelled point wrote nothing');
  assert.equal(await count(page), 1);

  // Undoing the cargo deletion makes the measurement usable again.
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.probe.PackLibrary.getById('fixture-pack').cases.some(c => c.id === 'cargo-b'));
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved, 'Undo restores the cargo and keeps the measurement as it was');
  await page.waitForFunction(() => !document.querySelector('.tp3d-measure-row__issue:not([hidden])'));
  assert.deepEqual(errors, []);
});

test('one click on the trash icon deletes immediately and never leaves a focus ring behind', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  await measure(page, await point(page, 120, 0, 90), await point(page, 300, 0, 95));
  const [first, second] = await page.evaluate(() => window.probe.measurements().map(m => m.id));
  await page.click(`[data-measurement-id="${first}"] .tp3d-measure-row__delete`);
  await page.waitForFunction(() => window.probe.measurements().length === 1);
  assert.equal(await page.evaluate(() => window.probe.measurements()[0].id), second);
  // A concise toast says so; a measurement has no Undo, because no verified restore path exists.
  assert.equal(await page.locator('.toast-message').last().textContent(), 'Measurement deleted.');
  assert.equal(await page.locator('.toast-btn', { hasText: 'Undo' }).count(), 0, 'the notification offers no Undo of its own');
  // The shared history brings the measurement back from the keyboard, and Redo removes it again.
  await page.focus('#viewport');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.probe.measurements().length === 2);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => window.probe.measurements().length === 1);
  assert.equal(await page.evaluate(id => !document.querySelector(`[data-measurement-id="${id}"]`), first), true, 'the row left the panel');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#editor-measure-panel')), false,
    'a mouse delete leaves no focus (and so no focus ring) in the panel');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-row__delete')].every(b => /^Delete /.test(b.getAttribute('aria-label')))), true,
    'every action has a clear accessible name');
  // Keyboard activation is a single press too and keeps focus in the panel.
  await page.focus('.tp3d-measure-row__delete');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.measurements().length === 0);
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#editor-measure-panel')), true);
  assert.deepEqual(errors, []);
});

test('endpoint repositioning: a grip drag re-anchors, Escape restores, and cargo, camera and selection never change', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page } = await openMeasuring(browser);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  const [original] = await page.evaluate(() => window.probe.measurements());
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), selection: window.probe.selection() }));
  // A just-saved measurement is selected, so its grips are already offered.
  await page.waitForFunction(() => {
    const grips = document.querySelector('.tp3d-measure-svg__segment.is-selected .tp3d-measure-svg__grips');
    return !!grips && (grips.getAttribute('d') || '').length > 5 && document.querySelectorAll('.tp3d-measure-row.is-selected').length === 1;
  });

  // Drag the start grip onto cargo: the anchor kind changes and stays cargo-local.
  const grip = await point(page, ...GROUND_A);
  const cargo = await page.evaluate(() => window.probe.cargoPoint('cargo-b'));
  await page.mouse.move(grip.x, grip.y);
  await page.waitForFunction(() => document.querySelector('#viewport canvas').style.cursor === 'grab');
  await page.mouse.down();
  await page.mouse.move((grip.x + cargo.x) / 2, (grip.y + cargo.y) / 2, { steps: 6 });
  await page.mouse.move(cargo.x, cargo.y, { steps: 6 });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-ghost').length === 1);
  assert.match(await page.evaluate(() => window.probe.hint()), /Drag to a new position/);
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.measurements()[0].start.kind === 'cargo');
  const [moved] = await page.evaluate(() => window.probe.measurements());
  assert.equal(moved.start.instanceId, 'cargo-b');
  assert.deepEqual(moved.end, original.end, 'the other endpoint is untouched');
  assert.equal(moved.id, original.id);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is never moved by an endpoint drag');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'the drag never orbits the camera');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), before.selection, 'and never selects cargo');
  await oneStepRoundTrip(page, 'the endpoint move');

  // Escape mid-drag drops the drag, leaves the mode and writes nothing.
  const snapshot = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  const edited = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  const end = await point(page, ...GROUND_B);
  await page.mouse.move(end.x, end.y);
  await page.waitForFunction(() => document.querySelector('#viewport canvas').style.cursor === 'grab');
  await page.mouse.down();
  await page.mouse.move(end.x + 50, end.y - 30, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(modeIsOff);
  await page.mouse.move(end.x + 60, end.y - 40, { steps: 3 });
  await page.mouse.up();
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), snapshot, 'Escape left the endpoint where it was');
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), edited, 'and nothing was written');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is still untouched');

  // Back in the mode the measurement is still there, and its list row selects it (grips come back).
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-selected').length === 0);
  await page.click('.tp3d-measure-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-selected').length === 1 &&
    document.querySelector('.tp3d-measure-row__select').getAttribute('aria-pressed') === 'true');
});

test('G5 the overlay is SVG/DOM above the canvas: no scene objects are added and canvas pixels are unchanged', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page } = await openEditor(browser);
  await page.waitForFunction(() => window.probe.SceneManager.getCamera());
  const baseline = await page.evaluate(() => ({ objects: window.probe.sceneObjectCount(), pixels: window.probe.canvasData() }));
  await page.evaluate(() => window.probe.measurements()); // read path only
  const rect = await page.evaluate(() => window.probe.box('#viewport canvas'));
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h - 30);
  await startMeasuring(page);
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-measure-label')].some(label => !label.hidden));
  const shown = await page.evaluate(() => ({
    objects: window.probe.sceneObjectCount(),
    pixels: window.probe.canvasData(),
    svgInLayer: !!document.querySelector('#editor-measure-labels > svg.tp3d-measure-svg'),
    lines: document.querySelectorAll('.tp3d-measure-svg__line').length,
    canvasContainsOverlay: document.querySelector('#viewport canvas').contains(document.querySelector('.tp3d-measure-svg')),
    layerIsPassive: getComputedStyle(document.getElementById('editor-measure-labels')).pointerEvents,
  }));
  assert.equal(shown.svgInLayer, true);
  assert.ok(shown.lines >= 1, 'the dimension line is drawn');
  assert.equal(shown.canvasContainsOverlay, false);
  assert.equal(shown.layerIsPassive, 'none', 'the layer never intercepts pointer events meant for the canvas');
  assert.equal(shown.objects, baseline.objects, 'the tool adds nothing to the 3D scene, so no capture can include it');
  assert.equal(shown.pixels, baseline.pixels, 'canvas pixels (what Screenshot, PDF views and thumbnails read) are identical with measurements shown');
  // Leaving the mode keeps the saved line on screen as a plain overlay: still nothing in the scene, same pixels.
  await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') !== 'true');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1 && [...document.querySelectorAll('.tp3d-measure-label')].some(label => !label.hidden));
  const viewOnly = await page.evaluate(() => ({
    objects: window.probe.sceneObjectCount(),
    pixels: window.probe.canvasData(),
    svgInLayer: !!document.querySelector('#editor-measure-labels > svg.tp3d-measure-svg'),
    layerIsPassive: getComputedStyle(document.getElementById('editor-measure-labels')).pointerEvents,
  }));
  assert.equal(viewOnly.svgInLayer, true);
  assert.equal(viewOnly.layerIsPassive, 'none');
  assert.equal(viewOnly.objects, baseline.objects, 'view only adds nothing to the 3D scene');
  assert.equal(viewOnly.pixels, baseline.pixels, 'and canvas pixels (Screenshot, PDF views, thumbnails) are identical with the saved line shown');
  assert.deepEqual(await overlayState(page), { segments: ['is-saved'], labels: 1, markers: 0 });
});

test('the Measurements panel drags by its grip like AutoPack Results, stays inside the viewport and still collapses on a click', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page } = await openMeasuring(browser);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  const grip = await page.evaluate(() => {
    const g = document.querySelector('.tp3d-measure-panel__grip');
    const cs = getComputedStyle(g);
    const dot = getComputedStyle(g.querySelector('.tp3d-measure-panel__grip-dot'));
    return { dots: g.querySelectorAll('.tp3d-measure-panel__grip-dot').length, display: cs.display, cols: cs.gridTemplateColumns, gap: cs.columnGap, dot: dot.width, opacity: dot.opacity, cursor: cs.cursor };
  });
  assert.deepEqual(grip, { dots: 6, display: 'grid', cols: '3px 3px', gap: '3px', dot: '3px', opacity: '0.5', cursor: 'grab' }, 'the same 2x3 dot grip as the AutoPack Results panel');

  const start = await page.evaluate(() => window.probe.box('#editor-measure-panel'));
  const g = await page.evaluate(() => window.probe.box('.tp3d-measure-panel__grip'));
  const camera = await page.evaluate(() => window.probe.camera());
  await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2);
  await page.mouse.down();
  // Right and down: the panel starts at the viewport's left edge (the layout has a left sidebar), so a leftward drag would only clamp.
  await page.mouse.move(g.x + g.w / 2 + 200, g.y + g.h / 2 + 160, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.probe.box('#editor-measure-panel'));
  assert.ok(Math.abs(moved.x - (start.x + 200)) < 1 && Math.abs(moved.y - (start.y + 160)) < 1, 'the panel follows the drag exactly');
  assert.equal(await page.evaluate(() => window.probe.camera()), camera, 'dragging the panel does not orbit the scene');
  assert.equal(await count(page), 1, 'and places no point');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-measure-panel__toggle').getAttribute('aria-expanded')), 'true', 'a drag does not collapse it');

  // Far past the corner: stays inside the viewport.
  const g2 = await page.evaluate(() => window.probe.box('.tp3d-measure-panel__grip'));
  await page.mouse.move(g2.x + 3, g2.y + 3);
  await page.mouse.down();
  await page.mouse.move(5000, 5000, { steps: 10 });
  await page.mouse.up();
  const corner = await page.evaluate(() => ({ p: window.probe.box('#editor-measure-panel'), v: window.probe.box('#viewport') }));
  assert.ok(corner.p.r <= corner.v.r && corner.p.b <= corner.v.b && corner.p.x >= corner.v.x && corner.p.y >= corner.v.y, 'clamped inside the viewport');

  // A plain click on the chevron collapses it; the grip stays visible; the chevron points down like Results.
  await page.click('.tp3d-measure-panel__chevron');
  await page.waitForFunction(() => document.querySelector('.tp3d-measure-panel__toggle').getAttribute('aria-expanded') === 'false');
  const collapsed = await page.evaluate(() => ({
    gripVisible: window.probe.box('.tp3d-measure-panel__grip').w > 0,
    down: document.querySelector('.tp3d-measure-panel__chevron').classList.contains('fa-chevron-down'),
    listHidden: document.querySelector('.tp3d-measure-panel__body').hidden,
    inside: (() => { const p = window.probe.box('#editor-measure-panel'); const v = window.probe.box('#viewport'); return p.r <= v.r && p.b <= v.b; })(),
  }));
  assert.deepEqual(collapsed, { gripVisible: true, down: true, listHidden: true, inside: true });
});

// ============================================================================
// Audit remediation: gestures against committed cargo poses (P2-6) and provisional poses (P2-7)
// ============================================================================
const viewportKey = async (page, key) => { await page.focus('#viewport'); await page.keyboard.press(key); };
const selectCargo = async (page, rect, id) => {
  await page.click('#btn-editor-measure'); // off
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await click(page, await page.evaluate(cargoId => window.probe.cargoPoint(cargoId), id));
  await page.waitForFunction(cargoId => window.probe.selection().includes(cargoId), id);
  await startMeasuring(page); // on
  await page.waitForFunction(modeIsOn);
};
const pending = page => page.evaluate(() => /second point/i.test(window.probe.hint()));

// Scene readiness, not a guess at how long a runner needs: the view (camera pose, projection and zoom) has not
// changed for several consecutive animation frames, so the overlay is drawn for the pose the next click will see.
const cameraSettled = async (page, frames = 6) => {
  await page.evaluate(() => { window.__viewSettle = { key: null, stable: 0 }; });
  await page.waitForFunction(required => {
    const camera = window.probe.SceneManager.getCamera();
    const key = [camera.isOrthographicCamera, camera.zoom, ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements].join();
    const state = window.__viewSettle;
    state.stable = key === state.key ? state.stable + 1 : 0;
    state.key = key;
    return state.stable >= required;
  }, frames, { polling: 'raf' });
};
// Everything that decides what a click at `target` does, so a failed step explains itself.
const clickDiagnostics = (page, target) => page.evaluate(([x, y]) => {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); };
  const hit = document.elementFromPoint(x, y);
  return {
    target: [Math.round(x), Math.round(y)],
    elementAtTarget: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
    hint: window.probe.hint(),
    selectedRows: document.querySelectorAll('.tp3d-measure-row.is-selected').length,
    measurements: window.probe.measurements().length,
    segments: [...document.querySelectorAll('.tp3d-measure-svg__segment')].map(group => ({
      selected: group.classList.contains('is-selected'),
      paths: [...group.querySelectorAll('path')].map(path => (path.getAttribute('d') || '').slice(0, 70)),
    })),
    labels: [...document.querySelectorAll('#editor-measure-labels > *')].map(box),
    canvas: box(document.querySelector('#viewport canvas')),
    panel: box(document.getElementById('editor-measure-panel')),
    camera: window.probe.camera(),
    selection: window.probe.selection(),
    provisionalPose: window.probe.InteractionManager.hasProvisionalPose(),
    operation: window.probe.OperationLifecycle.currentOperation().kind,
  };
}, [target.x, target.y]);
// Start a measurement on a cargo the way a user does: once the view is settled, click the cargo and require Point A.
async function startPointA(page, cargoId, label) {
  await cameraSettled(page);
  const target = await page.evaluate(id => window.probe.cargoPoint(id), cargoId);
  await click(page, target);
  try {
    await page.waitForFunction(() => /second point/i.test(window.probe.hint()), null, { timeout: 15000 });
  } catch (error) {
    throw new Error(`${label}: clicking ${cargoId} did not start Point A.\n${JSON.stringify(await clickDiagnostics(page, target), null, 1)}\n${error.message}`);
  }
}

test('P2-6 an unfinished Point A is cancelled when its cargo is nudged or rotated, but camera moves leave it alone', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  await selectCargo(page, rect, 'cargo-b');
  await measure(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')), await point(page, ...GROUND_B));
  const [saved] = await page.evaluate(() => window.probe.measurements());
  const startBefore = await page.evaluate(() => window.probe.resolved()[0].start);

  // Point A on the selected cargo; orbit, zoom and a projection change are camera work, not cargo work.
  await startPointA(page, 'cargo-b', 'first Point A');
  const camera = await page.evaluate(() => window.probe.camera());
  await page.mouse.move(rect.x + rect.w * 0.5, rect.y + rect.h * 0.3);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.w * 0.5 + 60, rect.y + rect.h * 0.3 + 20, { steps: 6 });
  await page.mouse.up();
  await page.mouse.wheel(0, -240);
  await page.waitForFunction(c => window.probe.camera() !== c, camera);
  await page.evaluate(() => { const v = window.probe.SceneManager.getEditorView(); window.probe.SceneManager.applyEditorView({ ...v, projection: v.projection === 'orthographic' ? 'perspective' : 'orthographic' }); });
  await cameraSettled(page);
  assert.equal(await pending(page), true, 'camera orbit, zoom and projection never cancel Point A');

  // A committed nudge moves the cargo Point A was picked on: the unfinished measurement is dropped.
  await viewportKey(page, 'ArrowRight');
  await page.waitForFunction(() => !/second point/i.test(window.probe.hint()));
  assert.match(await page.evaluate(() => window.probe.hint()), /cargo for Point A changed/i);
  assert.equal(await count(page), 1, 'nothing was created from the stale Point A');
  assert.equal(await page.evaluate(() => window.probe.modalOwner()), null);
  // The completed measurement keeps its anchors and simply follows the cargo.
  const [after] = await page.evaluate(() => window.probe.measurements());
  assert.deepEqual(after.start, saved.start, 'the stored anchor is untouched');
  const startAfter = await page.evaluate(() => window.probe.resolved()[0].start);
  assert.ok(Math.abs(startAfter.z - startBefore.z - 1) < 1e-6 && Math.abs(startAfter.x - startBefore.x) < 1e-6, 'a saved measurement follows the nudged cargo normally');

  // A rotation does the same.
  await startPointA(page, 'cargo-b', 'Point A after the nudge');
  await viewportKey(page, 'r');
  await page.waitForFunction(() => !/second point/i.test(window.probe.hint()));
  assert.equal(await count(page), 1);

  // With nothing changed, a fresh Point A completes as usual.
  // (Cargo-a: a click on a drawn measurement's line selects it, and cargo-b's rotated start now lies across its centre.)
  await measure(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')), await point(page, ...GROUND_A));
  assert.equal(await count(page), 2);
  assert.deepEqual(errors, []);
});

test('P2-6 an endpoint drag is cancelled when the cargo either endpoint refers to is moved, and writes nothing', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  await selectCargo(page, rect, 'cargo-b');
  await measure(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')), await point(page, ...GROUND_B));
  const snapshot = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  // A just-saved measurement is selected, so its grips are offered once the overlay has drawn them.
  await page.waitForFunction(() => {
    const grips = document.querySelector('.tp3d-measure-svg__segment.is-selected .tp3d-measure-svg__grips');
    return !!grips && (grips.getAttribute('d') || '').length > 5;
  });
  const end = await point(page, ...GROUND_B);
  await page.mouse.move(end.x + 8, end.y + 8);
  await page.mouse.move(end.x, end.y);
  await page.waitForFunction(() => document.querySelector('#viewport canvas').style.cursor === 'grab');
  await page.mouse.down();
  await page.mouse.move(end.x + 50, end.y - 30, { steps: 6 });
  await page.waitForFunction(() => /Drag to a new position/.test(window.probe.hint()));

  await viewportKey(page, 'ArrowRight'); // the cargo of the OTHER endpoint moves mid-drag
  await page.waitForFunction(() => !/Drag to a new position/.test(window.probe.hint()));
  assert.match(await page.evaluate(() => window.probe.hint()), /cargo.*changed.*cancelled/i);
  await page.mouse.move(end.x + 70, end.y - 40, { steps: 3 });
  await page.mouse.up();
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), snapshot, 'the measurement was not edited by the cancelled drag');
  assert.deepEqual(errors, []);
});

// A REAL held case, made the way a person makes one: select cargo, grab the gizmo's vertical arrow and pull
// it up into mid-air. The Editor keeps the pose scene-only ("Case held above the load. ... Esc cancels.") and
// reports it through its own InteractionManager.hasProvisionalPose(); nothing is stubbed here.
async function holdCaseWithGizmo(page, rect, id) {
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await click(page, await page.evaluate(cargoId => window.probe.cargoPoint(cargoId), id));
  await page.waitForFunction(cargoId => window.probe.selection().includes(cargoId) && window.probe.CaseScene.getGizmoHandleMeshes().length > 0, id);
  // The tip of the vertical arrow: only that arrow's grab area reaches it.
  const tip = await page.evaluate(() => {
    const q = window.probe;
    const handle = q.CaseScene.getGizmoHandleMeshes().find(mesh => mesh.userData.gizmoHandle === 'y');
    const v = handle.localToWorld(new window.THREE.Vector3(0, 1.0, 0)).project(q.SceneManager.getCamera());
    const r = document.querySelector('#viewport canvas').getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  });
  await page.mouse.move(tip.x, tip.y);
  await page.mouse.down();
  await page.mouse.move(tip.x, tip.y - 110, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.InteractionManager.hasProvisionalPose());
}
const heldState = (page, id) => page.evaluate(cargoId => {
  const q = window.probe;
  const committed = q.PackLibrary.getById('fixture-pack').cases.find(c => c.id === cargoId).transform.position;
  return {
    provisional: q.InteractionManager.hasProvisionalPose(),
    sceneY: q.CaseScene.getObject(cargoId).position.y / 0.05,
    committedY: committed.y,
    mode: document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true',
  };
}, id);
const modeOn = page => page.waitForFunction(() => document.getElementById('editor-measure-new').getAttribute('aria-pressed') === 'true');
const cargoBounds = (page, id) => page.evaluate(cargoId => {
  const q = window.probe;
  const inst = q.PackLibrary.getById('fixture-pack').cases.find(c => c.id === cargoId);
  const dims = q.StateStore.get('caseLibrary').find(c => c.id === inst.caseId).dimensions;
  const p = inst.transform.position;
  return { min: { x: p.x - dims.length / 2, y: p.y - dims.height / 2, z: p.z - dims.width / 2 }, max: { x: p.x + dims.length / 2, y: p.y + dims.height / 2, z: p.z + dims.width / 2 } };
}, id);
const onBox = (point, box, slack = 0.05) => ['x', 'y', 'z'].every(axis => point[axis] >= box.min[axis] - slack && point[axis] <= box.max[axis] + slack);

test('P2-7 a real held case (gizmo stroke) is never measured from its transient pose; Esc cancels it and the ruler resumes on the committed pose', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  const original = await page.evaluate(() => window.probe.casesJson());
  assert.equal(await page.evaluate(() => window.probe.InteractionManager.hasProvisionalPose()), false, 'nothing is held at the start');

  await page.click('#btn-editor-measure'); // off: a stroke on cargo needs the ordinary pointer
  await holdCaseWithGizmo(page, rect, 'cargo-a');
  const held = await heldState(page, 'cargo-a');
  assert.equal(held.provisional, true, 'the production signal reports the held pose');
  assert.ok(held.sceneY > held.committedY + 50, `the mesh is shown away from its committed pose (${held.sceneY} vs ${held.committedY})`);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), original, 'the held pose is scene-only: the Load Plan still stores the committed pose');

  // Measurement Mode on top of the hold: cargo picks are refused, other surfaces still work.
  await startMeasuring(page);
  await modeOn(page);
  const heldPoint = await page.evaluate(() => window.probe.cargoPoint('cargo-a'));
  await click(page, heldPoint);
  await page.waitForFunction(() => /held case/i.test(window.probe.hint()));
  assert.match(await page.evaluate(() => window.probe.hint()), /Place or cancel the held case before measuring on cargo/);
  assert.equal(await count(page), 0, 'no Point A was taken from the transient pose');
  await click(page, await point(page, ...GROUND_A));
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await click(page, heldPoint);
  await page.waitForFunction(() => /held case/i.test(window.probe.hint()));
  assert.equal(await count(page), 0, 'and no measurement is saved against the held pose either');
  assert.equal((await heldState(page, 'cargo-a')).provisional, true, 'refusing a pick never settles the hold');

  // The first Esc belongs to Measurement Mode; the hold is untouched. The second cancels the hold.
  await viewportKey(page, 'Escape');
  await page.waitForFunction(modeIsOff);
  const afterFirst = await heldState(page, 'cargo-a');
  assert.deepEqual([afterFirst.provisional, afterFirst.sceneY > afterFirst.committedY + 50], [true, true], 'leaving the mode does not touch the held case');
  await viewportKey(page, 'Escape');
  await page.waitForFunction(() => !window.probe.InteractionManager.hasProvisionalPose());
  const cancelled = await heldState(page, 'cargo-a');
  assert.ok(Math.abs(cancelled.sceneY - cancelled.committedY) < 1e-6, 'the mesh is back on its committed pose');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), original, 'cargo geometry is exactly what it was');
  assert.equal(await count(page), 0);
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), false, 'a cancelled hold leaves no Undo step');

  // Normal measurement creation resumes, anchored to the committed surface.
  await startMeasuring(page);
  await modeOn(page);
  await measure(page, await point(page, ...GROUND_A), await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  const [saved] = await page.evaluate(() => window.probe.measurements());
  assert.deepEqual([saved.end.kind, saved.end.instanceId], ['cargo', 'cargo-a']);
  const resolved = await page.evaluate(() => window.probe.resolved()[0]);
  assert.equal(resolved.status, 'valid');
  assert.ok(onBox(resolved.end, await cargoBounds(page, 'cargo-a')), `the point is on the committed cargo surface, not the transient pose: ${JSON.stringify(resolved.end)}`);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), original, 'measuring never changes the cargo');
  await oneStepRoundTrip(page, 'the measurement');
  assert.deepEqual(errors, []);
});

test('P2-7 a real held case placed with Enter while the ruler is on: picks resume, and cargo Undo/Redo keeps the measurement', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  const original = await page.evaluate(() => window.probe.casesJson());
  await page.click('#btn-editor-measure');
  await holdCaseWithGizmo(page, rect, 'cargo-a');
  await startMeasuring(page);
  await modeOn(page);
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  await page.waitForFunction(() => /held case/i.test(window.probe.hint()));
  assert.equal(await count(page), 0);

  // The Editor's own placement (Enter) settles the hold through its validated release; the mode stays on.
  await viewportKey(page, 'Enter');
  await page.waitForFunction(() => !window.probe.InteractionManager.hasProvisionalPose());
  const settled = await heldState(page, 'cargo-a');
  assert.equal(settled.mode, true, 'placing the case does not leave Measurement Mode');
  assert.ok(Math.abs(settled.sceneY - settled.committedY) < 1e-6, 'the mesh and the committed pose agree again');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), original, 'the supported drop is the pose it started from');

  await measure(page, await point(page, ...GROUND_A), await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  const [saved] = await page.evaluate(() => window.probe.measurements());
  assert.deepEqual([saved.end.kind, saved.end.instanceId], ['cargo', 'cargo-a'], 'picking on the settled cargo works as usual');
  assert.ok(onBox((await page.evaluate(() => window.probe.resolved()[0])).end, await cargoBounds(page, 'cargo-a')));

  // Cargo Undo/Redo is a cargo operation: it never erases or resurrects the measurement.
  // Newest first: the measurement itself, then placing the case. Undo and Redo walk those steps in order.
  const history = await page.evaluate(() => {
    const store = window.probe.StateStore;
    const measure = () => ({ measurements: window.probe.measurements().length, status: window.probe.resolved()[0]?.status ?? null });
    const undoneMeasurement = store.undo();
    const undoneCase = store.undo();
    const afterUndo = measure();
    const redone = [store.redo(), store.redo()];
    return { undoneMeasurement, undoneCase, afterUndo, redone, afterRedo: measure() };
  });
  assert.deepEqual([history.undoneMeasurement, history.undoneCase], [true, true], 'the measurement, then placing the case, were two steps');
  assert.deepEqual(history.afterUndo, { measurements: 0, status: null }, 'Undo back past the measurement removes it');
  assert.deepEqual(history.redone, [true, true]);
  assert.deepEqual(history.afterRedo, { measurements: 1, status: 'valid' }, 'Redo restores it, valid on the placed case');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), original);
  assert.deepEqual(errors, []);
});

test('ID-1 cargo whose ID another item shares is never measured or resolved onto an arbitrary item, and nothing stored is rewritten', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  await measure(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')), await point(page, ...GROUND_B));
  const stored = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  assert.equal(await page.evaluate(() => window.probe.resolved()[0].status), 'valid');

  // Damaged stored data: two cargo items carry the same ID (the app never creates this; it is kept, not repaired).
  const setCargoBId = id => page.evaluate(newId => {
    const q = window.probe;
    const pack = q.PackLibrary.getById('fixture-pack');
    q.StateStore.set({ packLibrary: [{ ...pack, cases: pack.cases.map((c, index) => (index === 1 ? { ...c, id: newId } : c)) }] }, { skipHistory: true });
  }, id);
  await setCargoBId('cargo-a');
  await page.waitForFunction(() => window.probe.PackLibrary.getById('fixture-pack').cases.every(c => c.id === 'cargo-a'));
  const resolved = await page.evaluate(() => window.probe.resolved()[0]);
  assert.deepEqual([resolved.status, resolved.reason, resolved.distance], ['unresolved', 'cargo-ambiguous', null], 'the stored measurement is not attached to either item');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), stored, 'the stored measurement is untouched');

  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  await page.waitForFunction(() => /shares its ID/i.test(window.probe.hint()));
  assert.equal(await count(page), 1, 'a pick on that cargo is refused with its own message and creates nothing');
  assert.match(await page.evaluate(() => document.getElementById('editor-measure-panel').innerText), /More than one cargo item in this Load Plan has the same ID/);
  // Other surfaces still measure normally in the same plan.
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  assert.equal(await count(page), 2);

  // Restoring a unique ID resolves the original measurement again: nothing was lost.
  await setCargoBId('cargo-b');
  await page.waitForFunction(() => window.probe.resolved()[0].status === 'valid');
  assert.deepEqual(errors, []);
});

test('P1-2 a truck wall picked with the real tool remembers the effective zones: equivalent trucks stay Valid, a real change needs review, restoring recovers', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  // The rear wall (x = 0) seen from the camera side: the ray leaves the truck through it.
  await measure(page, await point(page, 0, 55, 0), await point(page, ...GROUND_B));
  const [saved] = await page.evaluate(() => window.probe.measurements());
  assert.deepEqual([saved.start.kind, saved.start.surface], ['space', 'wall-rear'], 'a real pick on the truck shell');
  const zones = await page.evaluate(() => window.probe.M.getTruckSignature(window.probe.PackLibrary.getById('fixture-pack').truck,
    window.probe.PackLibrary.getMeasurementZones(window.probe.PackLibrary.getById('fixture-pack'))).zones);
  assert.deepEqual(saved.start.truck.zones, zones, 'the anchor remembers the effective usable zones of the truck it was placed on');
  const status = () => page.evaluate(() => { const r = window.probe.resolved()[0]; return [r.status, r.reason, r.distance === null ? null : typeof r.distance]; });
  assert.deepEqual(await status(), ['valid', null, 'number']);

  const setTruck = shape => page.evaluate(next => {
    const q = window.probe;
    const pack = q.PackLibrary.getById('fixture-pack');
    q.StateStore.set({ packLibrary: [{ ...pack, truck: { ...pack.truck, ...next } }] }, { skipHistory: true });
  }, shape);
  await setTruck({ shapeMode: 'frontBonus', shapeConfig: { bonusLength: 0, bonusHeight: 40 } });
  assert.deepEqual(await status(), ['valid', null, 'number'], 'a Front Overhang of length 0 is the same physical truck');
  await setTruck({ shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 40 } });
  await page.waitForFunction(() => window.probe.resolved()[0].status === 'needs-review');
  assert.deepEqual(await status(), ['needs-review', 'truck-changed', null], 'a real overhang changes the truck: no number is offered');
  assert.match(await page.evaluate(() => document.getElementById('editor-measure-panel').innerText), /Needs review[\s\S]*truck changed after this point was placed/i);
  assert.deepEqual((await page.evaluate(() => window.probe.measurements()))[0].start, saved.start, 'the stored anchor is never moved to the new wall');
  await setTruck({ shapeMode: 'rect', shapeConfig: {} });
  await page.waitForFunction(() => window.probe.resolved()[0].status === 'valid');
  assert.deepEqual(await status(), ['valid', null, 'number'], 'restoring the original geometry recovers the measurement');
  assert.deepEqual(errors, []);
});

// ============================================================================
// Final correction 1: only physically present truck surfaces are measurable (real Editor)
// ============================================================================
const setTruckShape = (page, next) => page.evaluate(shape => {
  const q = window.probe;
  const pack = q.PackLibrary.getById('fixture-pack');
  q.StateStore.set({ packLibrary: [{ ...pack, truck: { ...pack.truck, ...shape } }] }, { skipHistory: true });
}, next);

test('P1-3 parity: the faces the Measurement Tool can use are exactly the wall and ceiling planes the scene draws', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  const configs = {
    'standard truck': { shapeMode: 'rect', shapeConfig: {} },
    'Front Overhang': { shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 40 } },
    'Front Overhang with a high deck': { shapeMode: 'frontBonus', shapeConfig: { bonusLength: 60, bonusHeight: 90 } },
    'Front Overhang of length 0': { shapeMode: 'frontBonus', shapeConfig: { bonusLength: 0, bonusHeight: 40 } },
    'Wheel Wells': { shapeMode: 'wheelWells', shapeConfig: { wellHeight: 30, wellWidth: 20, wellLength: 100, wellOffsetFromRear: 100 } },
  };
  for (const [name, shape] of Object.entries(configs)) {
    await setTruckShape(page, shape);
    const { rendered, model } = await page.evaluate(() => {
      const q = window.probe;
      const truck = q.SceneManager.getScene().getObjectByName('truck');
      const rendered = [];
      truck.traverse(obj => {
        // Walls and ceiling are the double-sided planes; the floor plane is front-sided and the guides are boxes.
        if (obj.isMesh && obj.geometry.type === 'PlaneGeometry' && obj.material.side === window.THREE.DoubleSide) {
          obj.updateWorldMatrix(true, false);
          const box = new window.THREE.Box3().setFromObject(obj);
          rendered.push([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].map(v => v / 0.05));
        }
      });
      const model = q.PackLibrary.getMeasurementShellFaces(q.PackLibrary.getById('fixture-pack')).map(f => [...f.min, ...f.max]);
      return { rendered, model };
    });
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
    assert.equal(rendered.length, model.length, `${name}: ${rendered.length} planes drawn, ${model.length} faces modelled`);
    for (const plane of rendered) assert.ok(model.some(face => same(face, plane)), `${name}: drawn plane ${JSON.stringify(plane)} is a measurable face`);
    for (const face of model) assert.ok(rendered.some(plane => same(face, plane)), `${name}: measurable face ${JSON.stringify(face)} is drawn`);
  }
  assert.deepEqual(errors, []);
});

test('P1-3 real pointer: a click in the Front Overhang cab void never creates a truck wall; the real wall above the deck does', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  await setTruckShape(page, { shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 40 } }); // main box 636 in, deck from x = 636 to 736 at y >= 40
  await page.waitForFunction(() => window.probe.PackLibrary.getMeasurementShellFaces(window.probe.PackLibrary.getById('fixture-pack')).length === 8);
  const placeFirst = async target => {
    const before = await count(page);
    await click(page, await point(page, ...target));
    await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
    await click(page, await point(page, ...GROUND_B));
    await page.waitForFunction(n => window.probe.measurements().length === n + 1, before);
    const all = await page.evaluate(() => window.probe.measurements());
    const record = all[all.length - 1];
    await page.evaluate(id => window.probe.PackLibrary.deleteMeasurement('fixture-pack', id), record.id);
    await page.waitForFunction(n => window.probe.measurements().length === n, before);
    return record.start;
  };

  // Default view, looking down at the front: a ray under the deck meets the real deck floor, identified as such.
  const deckFloor = await placeFirst([686, 20, 0]);
  assert.deepEqual([deckFloor.kind, deckFloor.surface], ['floor', 'deck'], 'the first real surface the ray meets is the deck floor, not a wall');

  // From behind the truck at deck height, the rays through the void pass beneath the deck to the open ground beyond.
  await page.evaluate(() => {
    const q = window.probe;
    const camera = q.SceneManager.getCamera();
    camera.position.set(-500 * 0.05, 60 * 0.05, 0);
    q.SceneManager.getControls().target.set(400 * 0.05, 60 * 0.05, 0);
    q.SceneManager.getControls().update();
    camera.updateMatrixWorld(true);
  });
  await page.waitForTimeout(300);
  for (const y of [1, 10, 20, 39]) {
    const start = await placeFirst([736, y, 0]);
    assert.equal(String(start.surface).startsWith('wall-') || start.surface === 'ceiling', false, `(736, ${y}, 0) in the cab void: no wall point was created (${JSON.stringify(start)})`);
    // Whatever real surface the ray meets first is what the anchor says it is: the ground beyond the truck or,
    // for a ray that dips onto the deck just before the void, the deck floor.
    assert.ok(['ground', 'deck'].includes(start.surface), `(736, ${y}, 0): identified as the real surface it is (${JSON.stringify(start)})`);
    if (y <= 20) assert.equal(start.surface, 'ground', `(736, ${y}, 0): the ray passes beneath the deck to the open ground beyond`);
  }

  // The real front wall above the deck is still picked from the same view, exactly where it is, and stays Valid.
  const wall = await placeFirst([736, 75, 0]);
  assert.deepEqual([wall.kind, wall.surface], ['space', 'wall-front']);
  assert.ok(Math.abs(wall.position.x - 736) < 0.05 && Math.abs(wall.position.y - 75) < 0.5 && Math.abs(wall.position.z) < 0.5, JSON.stringify(wall.position));
  assert.equal(wall.truck.zones.length, 2, 'it remembers the main box and the deck');
  await click(page, await point(page, 736, 75, 0));
  await page.waitForFunction(() => /second point/i.test(window.probe.hint()));
  await click(page, await point(page, ...GROUND_B));
  await page.waitForFunction(() => window.probe.measurements().length === 1);
  assert.equal(await page.evaluate(() => window.probe.resolved()[0].status), 'valid');
  // Raising the deck past the point removes the wall there: the measurement needs review, nothing moves.
  const stored = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  await setTruckShape(page, { shapeMode: 'frontBonus', shapeConfig: { bonusLength: 100, bonusHeight: 80 } });
  await page.waitForFunction(() => window.probe.resolved()[0].status === 'needs-review');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), stored, 'the stored anchor is untouched');
  assert.deepEqual(errors, []);
});

// ==============================================================================================================
// View only: a saved Valid measurement stays drawn while the ruler is off, and is purely passive.
// ==============================================================================================================
// Two animation frames: the overlay redraws on its own frame loop, so a state change is settled only after one.
const frames = (page, n = 2) => page.evaluate(count => new Promise(resolve => {
  const step = left => (left <= 0 ? resolve() : window.requestAnimationFrame(() => step(left - 1)));
  step(count);
}), n);
const EMPTY_OVERLAY = { segments: [], labels: 0, markers: 0 };
const SAVED_ONLY = { segments: ['is-saved'], labels: 1, markers: 0 };
// The drawn line's endpoints in client pixels next to where the saved anchors project right now.
const lineEnds = page => page.evaluate(() => {
  const group = [...document.querySelectorAll('.tp3d-measure-svg__segment')].find(g => g.style.display !== 'none');
  if (!group) return null;
  const numbers = group.querySelector('.tp3d-measure-svg__line').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
  const origin = document.getElementById('editor-measure-labels').getBoundingClientRect();
  const [result] = window.probe.resolved();
  const a = window.probe.screenOf(result.start.x, result.start.y, result.start.z);
  const b = window.probe.screenOf(result.end.x, result.end.y, result.end.z);
  return { drawn: [numbers[0] + origin.left, numbers[1] + origin.top, numbers[2] + origin.left, numbers[3] + origin.top], expected: [a.x, a.y, b.x, b.y] };
});
// The saved line sits on its anchors for the current camera, projection, viewport and cargo poses (1.5 px).
async function assertFollows(page, message) {
  await page.waitForFunction(() => {
    const group = [...document.querySelectorAll('.tp3d-measure-svg__segment')].find(g => g.style.display !== 'none');
    if (!group) return false;
    const numbers = group.querySelector('.tp3d-measure-svg__line').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    const origin = document.getElementById('editor-measure-labels').getBoundingClientRect();
    const [result] = window.probe.resolved();
    const a = window.probe.screenOf(result.start.x, result.start.y, result.start.z);
    const b = window.probe.screenOf(result.end.x, result.end.y, result.end.z);
    return [a.x - origin.left, a.y - origin.top, b.x - origin.left, b.y - origin.top].every((value, i) => Math.abs(value - numbers[i]) <= 1.5);
  }, null, { polling: 'raf' }).catch(async error => {
    throw new Error(`${message}: ${JSON.stringify(await lineEnds(page))}\n${error.message}`);
  });
  const ends = await lineEnds(page);
  ends.drawn.forEach((value, i) => assert.ok(Math.abs(value - ends.expected[i]) <= 1.5, `${message}: ${JSON.stringify(ends)}`));
}
const exitMode = async page => {
  await page.click('#btn-editor-measure');
  await page.waitForFunction(modeIsOff);
};

test('view only: a saved line stays after the ruler is turned off and is passive until it is clicked', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  const saved = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  const edited = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  // Track what the overlay must not hold on to once the mode is off: listeners on the global input targets.
  await page.evaluate(() => {
    const entries = [];
    const nameOf = target => (target === window ? 'window' : target === document ? 'document' : target === document.body ? 'body'
      : target && target.id === 'viewport' ? 'viewport' : target && target.tagName === 'CANVAS' ? 'canvas' : null);
    const captureOf = options => (typeof options === 'boolean' ? options : Boolean(options && options.capture));
    const same = (e, target, type, listener, options) => e.target === target && e.type === type && e.listener === listener && e.capture === captureOf(options);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
      const name = nameOf(this);
      if (name && listener && !entries.some(e => same(e, this, type, listener, options))) entries.push({ target: this, name, type, listener, capture: captureOf(options) });
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function patchedRemove(type, listener, options) {
      const index = entries.findIndex(e => same(e, this, type, listener, options));
      if (index >= 0) entries.splice(index, 1);
      return remove.call(this, type, listener, options);
    };
    window.__liveListeners = () => entries.map(e => `${e.name}:${e.type}`).sort();
    window.__notes = 0;
    window.probe.StateStore.subscribe(() => { window.__notes += 1; });
  });

  await exitMode(page);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);
  assert.deepEqual(await overlayState(page), SAVED_ONLY, 'the saved Valid line and its label stay; no preview, ghost, marker or draft');
  assert.equal(await page.evaluate(() => document.getElementById('editor-measure-panel').hidden), true, 'the panel stays closed');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__grips')].every(path => !path.getAttribute('d'))), true, 'no grips');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-selected, .tp3d-measure-label.is-selected').length), 0, 'nothing is selected');
  assert.deepEqual(await page.evaluate(() => window.__liveListeners()), [], 'no pointer, keyboard or capture listener is left on window, document, the viewport or the canvas');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false);

  // Idle redraws are not store traffic and not writes.
  const idle = await page.evaluate(() => window.__notes);
  await frames(page, 30);
  assert.equal(await page.evaluate(() => window.__notes), idle, 'redrawing the saved line notifies nobody and writes nothing');

  // Pointer: the line and its label never catch the pointer, show no hover marker and select nothing.
  const { drawn } = await lineEnds(page);
  const mid = { x: (drawn[0] + drawn[2]) / 2, y: (drawn[1] + drawn[3]) / 2 };
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), mid), true,
    'the canvas, not the overlay, is under the line');
  await page.mouse.move(mid.x, mid.y, { steps: 4 });
  await frames(page, 4);
  assert.deepEqual(await overlayState(page), SAVED_ONLY, 'hovering the line adds no marker or emphasis');
  assert.equal(await page.evaluate(() => document.body.style.cursor || document.getElementById('viewport').style.cursor), '', 'no ruler cursor');
  await click(page, mid);
  await frames(page, 4);
  // Saved-record editing needs no creation mode: the click selects the line (grips appear) and places or writes nothing.
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-selected').length), 1, 'a click on the line selects it');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false, 'and arms nothing');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.hasPending()), false, 'and starts no measurement');
  assert.equal(await page.evaluate(() => document.getElementById('editor-measure-panel').hidden), true);
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved, 'nothing was written');
  // Escape deselects it; with nothing selected the view is purely passive again and holds no listener.
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  await frames(page, 4);
  assert.deepEqual(await overlayState(page), SAVED_ONLY, 'Escape deselects the line');
  assert.deepEqual(await page.evaluate(() => window.__liveListeners()), [], 'and the capture listeners go with the selection');

  // Keyboard: nothing here belongs to the ruler.
  await page.focus('#viewport');
  const escape = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.getElementById('viewport').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert.equal(escape, false, 'Escape is not consumed by a view-only line');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await frames(page, 4);
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved, 'Delete and Backspace cannot remove a view-only line');
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), edited, 'nothing was written');
  assert.deepEqual(await overlayState(page), SAVED_ONLY);
  assert.deepEqual(await page.evaluate(() => window.__liveListeners()), []);

  // Turning the ruler back on finds the same line and lets it be edited again.
  await startMeasuring(page);
  await page.waitForFunction(modeIsOn);
  assert.deepEqual(await overlayState(page), SAVED_ONLY);
  assert.equal(await page.evaluate(() => window.probe.measurements().length), 1);
  assert.deepEqual(errors, []);
});

test('view only: the saved line follows camera orbit and zoom, projection, a nudged or rotated cargo and a resized viewport', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors, rect } = await openMeasuring(browser);
  await selectCargo(page, rect, 'cargo-b');
  await measure(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')), await point(page, ...GROUND_B));
  await exitMode(page);
  await cameraSettled(page);
  await assertFollows(page, 'at rest');
  const edited = () => page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  const editedBefore = await edited();
  const notes = () => page.evaluate(() => window.__notes);
  await page.evaluate(() => { window.__notes = 0; });

  // Orbit and zoom (camera work).
  await page.mouse.move(rect.x + rect.w * 0.5, rect.y + rect.h * 0.2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.w * 0.5 + 90, rect.y + rect.h * 0.2 + 30, { steps: 8 });
  await page.mouse.up();
  await cameraSettled(page);
  await assertFollows(page, 'after an orbit');
  await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.mouse.wheel(0, -200);
  await cameraSettled(page);
  await assertFollows(page, 'after a zoom');

  // Projection.
  for (const projection of ['orthographic', 'perspective']) {
    await page.evaluate(next => { const v = window.probe.SceneManager.getEditorView(); window.probe.SceneManager.applyEditorView({ ...v, projection: next }); }, projection);
    await cameraSettled(page);
    await assertFollows(page, `in ${projection}`);
  }
  assert.equal(await edited(), editedBefore, 'camera work and redraws wrote nothing');

  // Viewport resize.
  await page.setViewportSize({ width: 1180, height: 760 });
  await cameraSettled(page);
  await assertFollows(page, 'after the viewport shrinks');
  await page.setViewportSize({ width: 1400, height: 900 });
  await cameraSettled(page);
  await assertFollows(page, 'after it grows back');
  assert.equal(await edited(), editedBefore);

  // A committed nudge and rotation of the cargo an endpoint sits on: the line follows its new pose.
  assert.ok((await page.evaluate(() => window.probe.selection())).includes('cargo-b'), 'cargo-b is still selected');
  const startBefore = await page.evaluate(() => window.probe.resolved()[0].start);
  await viewportKey(page, 'ArrowRight');
  await page.waitForFunction(before => { const now = window.probe.resolved()[0].start; return Math.hypot(now.x - before.x, now.z - before.z) > 0.5; }, startBefore);
  await cameraSettled(page);
  await assertFollows(page, 'after a nudge');
  const startNudged = await page.evaluate(() => window.probe.resolved()[0].start);
  await viewportKey(page, 'r');
  await page.waitForFunction(before => { const now = window.probe.resolved()[0].start; return Math.hypot(now.x - before.x, now.z - before.z) > 0.5; }, startNudged);
  await cameraSettled(page);
  await assertFollows(page, 'after a rotation');
  assert.deepEqual(await overlayState(page), SAVED_ONLY);
  assert.deepEqual(errors, []);
});

test('view only: nothing is drawn while an operation runs, for another Load Plan or with the tool hidden, and the line returns from the saved records', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openMeasuring(browser);
  await measure(page, await point(page, ...GROUND_A), await point(page, ...GROUND_B));
  await exitMode(page);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);
  const saved = JSON.stringify(await page.evaluate(() => window.probe.measurements()));
  const drawn = async expected => {
    await frames(page, 3);
    assert.deepEqual(await overlayState(page), expected);
  };

  // A passive thumbnail capture only reads pixels: the line stays.
  await page.evaluate(() => { window.__capture = window.probe.OperationLifecycle.beginOperation('capturingPreview'); });
  await drawn(SAVED_ONLY);
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__capture));

  // Real operations show poses the Load Plan does not hold: no line, no label, no node left over.
  for (const kind of ['autopacking', 'unpacking', 'changingTruck']) {
    await page.evaluate(k => { window.__op = window.probe.OperationLifecycle.beginOperation(k); }, kind);
    await drawn(EMPTY_OVERLAY);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-measure-svg__segment, .tp3d-measure-label').length), 0, `${kind}: the overlay nodes are gone`);
    await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
    await drawn(SAVED_ONLY);
  }
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved, 'the records never changed');

  // Another Load Plan has its own (here: no) measurements; switching back restores this one's line.
  const other = await page.evaluate(() => {
    const pack = window.probe.PackLibrary.create({ title: 'Other plan' });
    window.probe.StateStore.set({ currentPackId: pack.id });
    return pack.id;
  });
  await drawn(EMPTY_OVERLAY);
  await page.evaluate(() => window.probe.StateStore.set({ currentPackId: 'fixture-pack' }));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);
  await drawn(SAVED_ONLY);
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved);
  assert.ok(other);

  // The Settings toggle hides the ruler button and with it the saved lines (they could not be edited or deleted otherwise).
  await page.evaluate(() => window.probe.PreferencesManager.set({ ...window.probe.PreferencesManager.get(), showMeasurementTool: false }));
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').hidden === true);
  await drawn(EMPTY_OVERLAY);
  await page.evaluate(() => window.probe.PreferencesManager.set({ ...window.probe.PreferencesManager.get(), showMeasurementTool: true }));
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').hidden === false);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);
  await drawn(SAVED_ONLY);
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.measurements())), saved, 'the preference never touched the records');
  assert.deepEqual(errors, []);
});

test('a saved measurement is selected and edited without creation mode: a click selects, a grip drag is one step, a still grip press does nothing, an off-canvas release cancels, closing the manager keeps the selection and Escape clears it', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  await page.evaluate(([a, b]) => {
    const { M, PackLibrary } = window.probe;
    const at = ([x, y, z]) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(a), end: at(b) }).ok) throw new Error('measurement seed failed');
  }, [GROUND_A, GROUND_B]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);
  const settle = () => page.evaluate(() => new Promise(resolve => { let n = 0; const step = () => (++n > 12 ? resolve() : window.requestAnimationFrame(step)); window.requestAnimationFrame(step); }));
  const ends = () => page.evaluate(() => JSON.stringify(window.probe.measurements().map(m => [m.start, m.end])));
  const packs = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('packLibrary')));
  const selected = () => page.evaluate(() => document.querySelectorAll('.tp3d-measure-svg__segment.is-selected').length);
  const flags = () => page.evaluate(() => ({ armed: window.probe.MeasurementTool.isActive(), pending: window.probe.MeasurementTool.hasPending() }));
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await settle();
  };
  await settle();
  const original = await ends();
  const startPacks = await packs();

  // A click on the saved line selects it: no manager, no New measurement, no history.
  const mid = await point(page, 180, 0, 75);
  await click(page, mid);
  await settle();
  assert.equal(await selected(), 1, 'the click selected the line');
  assert.deepEqual(await flags(), { armed: false, pending: false });
  assert.equal(await packs(), startPacks, 'selecting wrote nothing');

  // A grip press that never moves begins nothing and writes nothing.
  const gripAt = await point(page, ...GROUND_B);
  await click(page, gripAt);
  await settle();
  assert.deepEqual(await flags(), { armed: false, pending: false }, 'a still grip press does not begin Point A');
  assert.equal(await ends(), original);

  // Released outside the canvas: cancelled, nothing written, and a prior Undo stays redoable.
  await drag(gripAt, { x: 700, y: 20 });
  assert.equal(await ends(), original, 'an off-canvas release changes nothing');
  assert.equal(await packs(), startPacks, 'and writes nothing');

  // A real drag onto the ground moves the endpoint as one history step.
  await drag(gripAt, await point(page, 330, 0, 140));
  assert.notEqual(await ends(), original, 'the endpoint moved');
  assert.deepEqual(await flags(), { armed: false, pending: false });
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);
  assert.equal(await ends(), original, 'one Undo restores it: the drag was one step');
  // The cancelled and still presses above left Redo intact: this Undo is redoable.
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, 'Redo replays the move');

  // Closing the manager keeps the selection (and its editable grips); Escape clears it.
  await page.click('#btn-editor-measure');
  await page.click('#btn-editor-measure');
  await settle();
  assert.equal(await selected(), 1, 'closing the manager kept the selection');
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  await settle();
  assert.equal(await selected(), 0, 'Escape deselected it');
  assert.deepEqual(errors, []);
});

test('the body of a SELECTED saved measurement carries the whole measurement with the real mouse: one Undo step, both ends shift together and the length is kept, a grip still moves one end, Escape or an off-canvas release writes nothing, and a measurement across two surfaces refuses', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const seeded = await page.evaluate(([a, b]) => {
    const { M, PackLibrary, StateStore } = window.probe;
    const at = ([x, y, z]) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y, z } });
    const inst = PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
    const caseData = StateStore.get('caseLibrary').find(c => c.id === inst.caseId);
    const top = M.buildCargoAnchor({ instanceId: inst.id, local: { x: 0, y: 16, z: 0 }, caseData });
    const flat = PackLibrary.addMeasurement('fixture-pack', { start: at(a), end: at(b), label: 'Dock run' });
    const mixed = PackLibrary.addMeasurement('fixture-pack', { start: top, end: at([120, 0, 20]) });
    if (!flat.ok || !mixed.ok) throw new Error('measurement seed failed');
    return { flat: flat.measurement.id, mixed: mixed.measurement.id };
  }, [GROUND_A, GROUND_B]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 2);
  const settle = () => page.evaluate(() => new Promise(resolve => { let n = 0; const step = () => (++n > 12 ? resolve() : window.requestAnimationFrame(step)); window.requestAnimationFrame(step); }));
  const stored = id => page.evaluate(which => JSON.stringify(window.probe.measurements().find(m => m.id === which)), id);
  const packs = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('packLibrary')));
  const labels = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-label')].filter(l => !l.hidden).map(l => l.textContent.trim()).sort());
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await settle();
    await page.mouse.up();
    await settle();
  };
  await settle();
  const mid = await point(page, 180, 0, 75);
  await click(page, mid);
  await settle();
  const before = JSON.parse(await stored(seeded.flat));
  const startPacks = await packs();
  const labelsBefore = await labels();
  const cameraBefore = await page.evaluate(() => window.probe.camera());

  // Dragging the selected body carries both ends by one offset, as one history step, on the ground it is on.
  await drag(mid, { x: mid.x + 50, y: mid.y + 40 });
  const moved = JSON.parse(await stored(seeded.flat));
  const shift = which => ['x', 'y', 'z'].map(axis => +(moved[which].position[axis] - before[which].position[axis]).toFixed(4));
  assert.notDeepEqual(shift('start'), [0, 0, 0], 'the measurement moved');
  assert.deepEqual(shift('end'), shift('start'), 'both ends moved by the same offset');
  assert.equal(shift('start')[1], 0, 'it stayed on the ground');
  assert.deepEqual([moved.id, moved.label, moved.start.surface], [before.id, before.label, before.start.surface]);
  assert.deepEqual(await labels(), labelsBefore, 'the length is unchanged');
  assert.equal(await page.evaluate(() => window.probe.camera()), cameraBefore, 'the camera did not orbit');
  assert.deepEqual(await page.evaluate(() => ({ armed: window.probe.MeasurementTool.isActive(), pending: window.probe.MeasurementTool.hasPending() })), { armed: false, pending: false });
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);
  assert.equal(await packs(), startPacks, 'one Undo restores the whole Pack: the move was one step');
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, 'and Redo replays it');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);

  // Escape and an off-canvas release write nothing and leave Redo alone.
  await click(page, mid);
  await settle();
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 40, mid.y + 20, { steps: 8 });
  await settle();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await settle();
  assert.equal(await packs(), startPacks, 'Escape cancelled the move');
  await click(page, mid);
  await settle();
  await drag(mid, { x: 700, y: 20 });
  assert.equal(await packs(), startPacks, 'a release off the 3D view is cancelled');
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, 'Redo survived the cancelled moves');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);

  // A grip still moves one end only.
  await click(page, mid);
  await settle();
  await drag(await point(page, ...GROUND_B), await point(page, 330, 0, 140));
  const gripped = JSON.parse(await stored(seeded.flat));
  assert.deepEqual([gripped.start, JSON.stringify(gripped.end) !== JSON.stringify(before.end)], [before.start, true], 'a grip drag moves that end only');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);

  // Cargo top to ground is two surfaces: the whole move is refused and the ends stay individually movable.
  const topOfA = await point(page, 70, 32, -20);
  const ground = await point(page, 120, 0, 20);
  const across = { x: (topOfA.x + ground.x) / 2, y: (topOfA.y + ground.y) / 2 };
  await click(page, across);
  await settle();
  const mixedBefore = await packs();
  await drag(across, { x: across.x + 40, y: across.y + 20 });
  assert.equal(await packs(), mixedBefore, 'a measurement across two surfaces was left where it was');
  assert.deepEqual(errors, []);
});
