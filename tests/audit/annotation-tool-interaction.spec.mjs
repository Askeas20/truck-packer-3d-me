import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Annotations V1A interaction contract.
//
// Drives the REAL Editor runtime in Chromium, the way measurement-tool-interaction.spec.mjs does:
// index.html markup, main.css, three r185 + OrbitControls, SceneManager, CaseScene, the real
// InteractionManager/EditorUI/KeyboardManager wired with the real AnnotationTool, and app.js's own
// StateStore render subscriber extracted verbatim. Disposable in-memory data only: every non-local
// request is aborted and auth, billing, storage scope and persistence are not involved.

const ORIGIN = 'http://localhost:5597';
const repo = new URL('../../', import.meta.url);
const read = (path, encoding = 'utf8') => readFile(new URL(path, repo), encoding);

const appSource = await read('src/app.js');
const subscriberAnchor = appSource.indexOf("let prevScreen = StateStore.get('currentScreen');");
const subscriberStart = appSource.indexOf('StateStore.subscribe(', subscriberAnchor);
const subscriberEnd = appSource.indexOf('\n      });\n\n      try {\n        Router.init(', subscriberStart);
assert.ok(subscriberAnchor >= 0 && subscriberStart > subscriberAnchor && subscriberEnd > subscriberStart,
  'app.js StateStore render subscriber is extractable');
const appSubscriber = appSource.slice(subscriberStart + 'StateStore.subscribe('.length, subscriberEnd + '\n      }'.length);
assert.match(appSubscriber, /notification\?\.type === 'pack-annotations'\) \{\s*PacksUI\.render\(\);\s*EditorUI\.syncAnnotations\(\);\s*AutoPackPreviewScheduler\.schedule\(\);\s*return;/,
  'an annotation-only write refreshes the card and the overlay without a scene or Inspector render, and re-requests the preview freshness check');

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
import { createAnnotationTool } from '/src/editor/annotation-tool.js';
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
import * as A from '/src/core/annotations.js';

const APP_SUBSCRIBER = ${JSON.stringify(appSubscriber)};

await window.__TP3D_BOOT.threeReady;
const UIComponents = createUIComponents();
const Utils = { ...CoreUtils, ...BrowserUtils };
const StateStore = {
  init: CoreStateStore.init, get: CoreStateStore.get, set: CoreStateStore.set, replace: CoreStateStore.replace,
  snapshot: CoreStateStore.snapshot, resetHistory: CoreStateStore.resetHistory, undo: CoreStateStore.undo,
  redo: CoreStateStore.redo, subscribe: CoreStateStore.subscribe, undoDepth: CoreStateStore.undoDepth,
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
  folderLibrary: [], preferences: { ...Defaults.defaultPreferences, ...(window.__TEST_PREFERENCES || {}) },
});

let SceneManager = null;
const TrailerGeometry = createTrailerGeometry({ Utils, CorePackLibrary: PackLibrary, getSceneManager: () => SceneManager });
const AppShell = createAppShell({ StateStore, PackLibrary, Utils });
SceneManager = createSceneRuntime({ Utils, UIComponents, PreferencesManager, TrailerGeometry, StateStore });
const CaseScene = createCaseScene({ SceneManager, CaseLibrary, CategoryService, PackLibrary, StateStore, TrailerGeometry, Utils, PreferencesManager });
const OperationLifecycle = createOperationLifecycle();
const MeasurementTool = createMeasurementTool({ SceneManager, CaseScene, CaseLibrary, PackLibrary, StateStore, PreferencesManager, UIComponents, OperationLifecycle });
const AnnotationTool = createAnnotationTool({ SceneManager, CaseScene, CaseLibrary, PackLibrary, StateStore, PreferencesManager, UIComponents, OperationLifecycle });
const InteractionManager = createInteractionManager({ SceneManager, CaseScene, StateStore, PackLibrary, CaseLibrary, PreferencesManager, UIComponents, OperationLifecycle, MeasurementTool, AnnotationTool });
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
  CaseScene, InteractionManager, TruckChangeController, OperationLifecycle, MeasurementTool, AnnotationTool,
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

const canvas = () => SceneManager.getRenderer().domElement;
const livePack = () => PackLibrary.getById(packId);
window.probe = {
  StateStore, OperationLifecycle, SceneManager, CaseScene, PackLibrary, CaseLibrary, InteractionManager, MeasurementTool, AnnotationTool, EditorUI, PreferencesManager, M, A, UIComponents,
  annotations: () => PackLibrary.getAnnotations(packId),
  resolved: () => PackLibrary.resolveAnnotations(packId),
  hint: () => { const el = document.querySelector('.tp3d-annot-panel__hint'); return el ? el.textContent : ''; },
  selection: () => (StateStore.get('selectedInstanceIds') || []).slice(),
  casesJson: () => JSON.stringify(livePack().cases),
  cargoIds: () => livePack().cases.map(c => c.id),
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

async function openEditor(browser, viewport = { width: 1400, height: 900 }, { preferences = null } = {}) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(30000);
  // Preferences as they would have been stored before this boot (a "reload" with a saved choice).
  if (preferences) await page.addInitScript(stored => { window.__TEST_PREFERENCES = stored; }, preferences);
  const errors = [];
  page.on('pageerror', error => errors.push(`${error.message}\n${error.stack}`));
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
  await page.waitForFunction(() => document.querySelector('#viewport canvas') && window.probe.SceneManager.getCamera());
  return { page, errors };
}

// Measurements is a manager (toolbar button) and creation is its own control (New measurement): creating needs both.
const startMeasuring = async page => {
  const managerOpen = await page.evaluate(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  if (!managerOpen) await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  await page.click('#editor-measure-new');
  await page.waitForFunction(() => document.getElementById('editor-measure-new').getAttribute('aria-pressed') === 'true');
};
const launch = () => chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const point = (page, x, y, z) => page.evaluate(([px, py, pz]) => window.probe.screenOf(px, py, pz), [x, y, z]);
const count = page => page.evaluate(() => window.probe.annotations().length);
const click = async (page, p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); };
const GROUND_A = [100, 0, 70];
const GROUND_B = [260, 0, 80];

// Seed callouts through the real PackLibrary write path (not the creation UI): `{ title, ground: [x, z] }` or
// `{ title, cargo: id, local }`. Returns the stored records.
const seed = (page, specs) => page.evaluate(list => list.map(spec => {
  const { M, PackLibrary, CaseLibrary } = window.probe;
  const pack = PackLibrary.getById('fixture-pack');
  let anchor;
  if (spec.ground) {
    anchor = M.buildSpaceAnchor({ surface: 'ground', point: { x: spec.ground[0], y: 0, z: spec.ground[1] } });
  } else {
    const inst = pack.cases.find(c => c.id === spec.cargo);
    anchor = M.buildCargoAnchor({ instanceId: inst.id, local: spec.local, caseData: CaseLibrary.getById(inst.caseId) });
  }
  const outcome = PackLibrary.addCallout('fixture-pack', { anchor, title: spec.title, description: spec.description || null, color: spec.color, keepExpanded: Boolean(spec.keepExpanded), offset: spec.offset || null });
  if (!outcome.ok) throw new Error(`seed failed: ${outcome.reason}`);
  return outcome.annotation;
}), specs);
const TOP_OF_A = { cargo: 'cargo-a', local: { x: 0, y: 16, z: 0 } };
// Off-centre, so a click at the cargo's centre reaches the canvas and not this marker.
const TOP_OF_B = { cargo: 'cargo-b', local: { x: 14, y: 12, z: -14 } };

// A page with the Annotations panel open and no tool armed.
async function openPanel(browser, viewport) {
  const opened = await openEditor(browser, viewport);
  await opened.page.click('#btn-editor-annotations');
  await opened.page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  return opened;
}
// The editor card is created the first time it is needed.
const editorClosed = page => page.evaluate(() => { const el = document.querySelector('.tp3d-annot-editor'); return !el || el.hidden; });
const escapeConsumed = page => page.evaluate(() => {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.getElementById('viewport').dispatchEvent(ev);
  return ev.defaultPrevented;
});
// The first candidate ground point whose screen position is the canvas itself (not a card, the editor or the panel).
async function freePoint(page, candidates) {
  for (const candidate of candidates) {
    const at = await point(page, ...candidate);
    const free = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), at);
    if (free) return at;
  }
  throw new Error('no uncovered point');
}
const pinCentreOf = (page, selector = '.tp3d-annot-pin:not(.is-draft)') => page.evaluate(sel => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, selector);

// A page with the Annotations panel open and the Callout tool armed (the camera is settled so picks work).
async function openArmed(browser, viewport) {
  const opened = await openEditor(browser, viewport);
  const { page } = opened;
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.waitForFunction(() => /place a callout/i.test(window.probe.hint()));
  return opened;
}

// Click the scene to start a callout, fill the editor card and save it. Returns the saved record.
async function addCallout(page, at, title, extra = {}) {
  const before = await count(page);
  await click(page, at);
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', title);
  if (extra.description) await page.fill('.tp3d-annot-editor__textarea', extra.description);
  if (extra.color) await page.click(`.tp3d-annot-swatch[data-color="${extra.color}"]`);
  if (extra.keepExpanded) await page.check('.tp3d-annot-editor__keep input');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(n => window.probe.annotations().length === n + 1, before);
  return page.evaluate(() => window.probe.annotations().at(-1));
}

test('the Annotations control is the first button of the stack and opens a compact panel with the three tool slots', { timeout: 90000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const stack = await page.locator('#editor-zoom-controls > button').evaluateAll(buttons => buttons.map(b => b.id));
  assert.deepEqual(stack, ['btn-editor-annotations', 'btn-editor-measure', 'btn-editor-view', 'btn-editor-zoom-in', 'btn-editor-zoom-out']);
  assert.equal(await page.locator('#btn-editor-annotations i').getAttribute('class'), 'fa-solid fa-marker');
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), true, 'closed until asked for');

  await page.click('#btn-editor-annotations');
  assert.equal(await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed')), 'true');
  const panel = await page.evaluate(() => ({
    hidden: document.getElementById('editor-annotation-panel').hidden,
    title: document.querySelector('.tp3d-annot-panel__title').textContent,
    badgeShown: getComputedStyle(document.querySelector('.tp3d-annot-panel__count')).display !== 'none',
    tools: [...document.querySelectorAll('.tp3d-annot-seg--tools .tp3d-annot-seg__btn')].map(b => ({ tool: b.dataset.tool, disabled: b.disabled, pressed: b.getAttribute('aria-pressed') })),
    show: [...document.querySelectorAll('.tp3d-annot-seg--show .tp3d-annot-seg__btn')].map(b => [b.textContent, b.getAttribute('aria-pressed')]),
    display: [...document.querySelectorAll('.tp3d-annot-seg--display .tp3d-annot-seg__btn')].map(b => [b.textContent, b.getAttribute('aria-pressed')]),
    empty: !document.querySelector('.tp3d-annot-panel__empty').hidden,
  }));
  assert.equal(panel.hidden, false);
  assert.equal(panel.title, 'Annotations');
  assert.equal(panel.badgeShown, false, 'no count badge while there are no annotations');
  assert.deepEqual(panel.tools.map(t => t.tool), ['callout', 'arrow', 'draw']);
  assert.deepEqual(panel.tools.map(t => t.disabled), [false, false, false], 'Callout, Arrow and Draw are all available');
  assert.deepEqual(panel.show, [['All', 'true'], ['Selected', 'false'], ['Off', 'false']]);
  assert.deepEqual(panel.display, [['Markers', 'true'], ['Labels', 'false'], ['Cards', 'false']]);
  assert.equal(panel.empty, true);
  assert.deepEqual(errors, []);
});

test('creating a callout: a click opens the editor, Cancel writes nothing, Save writes exactly one record and cargo, camera and Undo are untouched', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));

  // A click on the ground starts a callout: the editor opens with focus in the title, Save needs a title.
  await click(page, await point(page, ...GROUND_A));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tp3d-annot-editor__input')), true, 'focus starts in the title');
  assert.equal(await page.locator('.tp3d-annot-btn--primary').isDisabled(), true, 'Save needs a title');
  assert.match(await page.locator('.tp3d-annot-editor__target-text').textContent(), /Attached to Ground/);
  assert.equal(await page.evaluate(() => !document.querySelector('.tp3d-annot-pin.is-draft').hidden), true, 'a temporary marker shows where it will attach');
  assert.equal(await count(page), 0, 'nothing is stored while the card is open');

  // Cancel (Escape from the title field) writes nothing and leaves the Load Plan exactly as it was.
  await page.keyboard.type('Draft');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.tp3d-annot-editor', { state: 'hidden' });
  assert.equal(await count(page), 0);
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), before.edited, 'cancelling never edits the Load Plan');
  assert.equal(await page.evaluate(() => !!document.querySelector('.tp3d-annot-pin.is-draft') && document.querySelector('.tp3d-annot-pin.is-draft').hidden), true);
  assert.match(await page.evaluate(() => window.probe.hint()), /place a callout/i, 'the tool stays armed');

  // Save creates exactly one persistent annotation.
  const saved = await addCallout(page, await point(page, ...GROUND_A), '  Unload   first ', { description: 'Rear doors', color: 'blue', keepExpanded: true });
  assert.equal(await count(page), 1);
  assert.deepEqual([saved.type, saved.title, saved.description, saved.color, saved.keepExpanded, saved.hidden, saved.offset], ['callout', 'Unload first', 'Rear doors', 'blue', true, false, null]);
  assert.deepEqual([saved.anchor.kind, saved.anchor.surface], ['space', 'ground'], 'the ground outside any cargo is a supported anchor');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is never moved');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'placing never orbits the camera');
  assert.ok(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited) > before.edited, 'lastEdited is updated');
  assert.equal(await page.evaluate(() => window.probe.hint()), 'Callout saved to Ground.', 'the save confirms itself');
  await oneStepRoundTrip(page, 'the callout save');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'cargo selection is untouched');

  // Selection is not part of the history: after the Redo the saved callout is selected again from its row.
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  // The saved callout is selected: its card is expanded, the marker numbered, the list row present.
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  const view = await page.evaluate(() => ({
    card: document.querySelector('.tp3d-annot-card.is-selected .tp3d-annot-card__title').textContent,
    desc: document.querySelector('.tp3d-annot-card.is-selected .tp3d-annot-card__desc').textContent,
    target: document.querySelector('.tp3d-annot-card.is-selected .tp3d-annot-card__target').textContent,
    pin: document.querySelector('.tp3d-annot-pin.is-selected .tp3d-annot-pin__badge').textContent,
    rows: document.querySelectorAll('.tp3d-annot-row').length,
    badge: document.querySelector('.tp3d-annot-panel__count').textContent,
    hint: window.probe.hint(),
  }));
  assert.deepEqual(view, { card: 'Unload first', desc: 'Rear doors', target: 'Ground', pin: '1', rows: 1, badge: '1', hint: '' });
  assert.deepEqual(errors, []);
});

test('presets only fill editable text, and the card can be reopened to change it', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  await click(page, await point(page, ...GROUND_A));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.click('.tp3d-annot-chip:has-text("Heavy")');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'HEAVY');
  assert.match(await page.inputValue('.tp3d-annot-editor__textarea'), /Use two people or a lift/);
  assert.equal(await page.getAttribute('.tp3d-annot-chip:has-text("Heavy")', 'aria-pressed'), 'true');
  await page.fill('.tp3d-annot-editor__input', 'HEAVY — LEFT SIDE');
  assert.equal(await page.getAttribute('.tp3d-annot-chip:has-text("Heavy")', 'aria-pressed'), 'false', 'editing the title detaches it from the preset');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const [saved] = await page.evaluate(() => window.probe.annotations());
  assert.equal(saved.title, 'HEAVY — LEFT SIDE');
  assert.equal(Object.keys(saved).includes('preset'), false, 'the preset is never stored');

  // Edit from the card: the same record changes, the anchor does not.
  await page.click('.tp3d-annot-card.is-selected [data-act="edit"]');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'HEAVY — LEFT SIDE');
  assert.equal(await page.locator('.tp3d-annot-editor__heading').textContent(), 'Edit callout');
  await page.fill('.tp3d-annot-editor__input', 'HEAVY');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations()[0].title === 'HEAVY');
  const [edited] = await page.evaluate(() => window.probe.annotations());
  assert.deepEqual([edited.id, edited.anchor, edited.createdAt], [saved.id, saved.anchor, saved.createdAt]);
  assert.equal(await count(page), 1);
  assert.deepEqual(errors, []);
});

test('a callout on cargo is anchored to that instance and follows it when the cargo moves; the record never changes', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  const saved = await addCallout(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')), 'On the case');
  assert.equal(saved.anchor.kind, 'cargo');
  assert.equal(saved.anchor.instanceId, 'cargo-a', 'the instance ID, never the Case ID');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'a click on cargo with the tool armed never selects it');

  const pinCentre = () => page.evaluate(() => {
    const r = document.querySelector('.tp3d-annot-pin:not(.is-draft)').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const expected = () => page.evaluate(() => {
    const [r] = window.probe.resolved();
    return window.probe.screenOf(r.point.x, r.point.y, r.point.z);
  });
  const near = (a, b, tol = 2.5) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
  await page.waitForSelector('.tp3d-annot-pin.is-selected:not(.is-draft)');
  assert.ok(near(await pinCentre(), await expected()), 'the marker sits on the picked surface point');

  const record = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  const firstPin = await pinCentre();
  await page.evaluate(() => {
    const inst = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
    window.probe.PackLibrary.updateInstance('fixture-pack', 'cargo-a', {
      transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x + 120, z: inst.transform.position.z + 20 } },
    });
  });
  await page.waitForFunction(old => {
    const r = document.querySelector('.tp3d-annot-pin:not(.is-draft)').getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - old.x) > 20;
  }, firstPin);
  assert.ok(near(await pinCentre(), await expected()), 'after the cargo moved the marker is on the same spot of the cargo');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), record, 'the stored annotation is unchanged by cargo movement');
  assert.equal((await page.evaluate(() => window.probe.resolved()))[0].status, 'valid');
  assert.deepEqual(errors, []);
});

test('selecting an annotation clears the cargo selection, selecting cargo clears the annotation, and Delete acts only on its owner', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const [first] = await seed(page, [{ title: 'On the ground', ground: [520, 10] }, { title: 'On case B', ...TOP_OF_B }]);
  await page.waitForSelector('.tp3d-annot-row >> nth=1');

  // Cargo selected, then an annotation picked from the list: the cargo selection is cleared.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().includes('cargo-b'));
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'annotation selection clears the cargo selection');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  assert.equal(await page.getAttribute('.tp3d-annot-row:first-child .tp3d-annot-row__select', 'aria-pressed'), 'true');

  // Delete removes the annotation only; cargo is never deleted as a side effect.
  const cargoBefore = await page.evaluate(() => window.probe.casesJson());
  await page.focus('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore, 'no cargo was deleted');
  await oneStepRoundTrip(page, 'the deletion');
  assert.match(await page.locator('.toast-message').last().textContent(), /Callout deleted\./);

  // The panel's one-level Undo brings back the same record in the same place, independent of cargo history.
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  const restored = await page.evaluate(() => window.probe.annotations());
  assert.deepEqual([restored[0].id, restored[0].title], [first.id, 'On the ground']);
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-panel__undo')), null, 'no inline undo row remains in the panel');

  // Cargo clicked: the annotation is deselected.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  await page.waitForFunction(() => window.probe.selection().includes('cargo-a'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-row.is-selected, .tp3d-annot-card.is-selected').length), 0, 'selecting cargo deselects the annotation');

  // Delete with the cargo selection acts on cargo exactly as before and never on an annotation.
  await page.focus('#viewport');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => !window.probe.cargoIds().includes('cargo-a'));
  assert.equal(await count(page), 2, 'annotations are untouched by a cargo delete');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'cargo Delete stays undoable through cargo history');
  assert.equal(await count(page), 2, 'and Undo never touches annotations');
  assert.deepEqual(errors, []);
});

test('one Escape closes one owner: an open card, then the armed tool, then the selection; the rest is left to the Editor', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  await seed(page, [{ title: 'Seeded', ground: [260, 80] }]);
  const toolOn = () => page.evaluate(() => document.querySelector('.tp3d-annot-seg__btn[data-tool="callout"]').getAttribute('aria-pressed') === 'true');
  const cardOpen = () => page.evaluate(() => !document.querySelector('.tp3d-annot-editor').hidden);

  await click(page, await point(page, ...GROUND_A));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.focus('#viewport'); // focus outside the text field: the global owner handles the key
  await page.keyboard.press('Escape');
  assert.equal(await cardOpen(), false, '1: the open card closes first');
  assert.equal(await toolOn(), true, 'the tool is still armed');
  assert.equal(await count(page), 1, 'and nothing was written');
  await page.keyboard.press('Escape');
  assert.equal(await toolOn(), false, '2: the next Escape disarms the tool');
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), false, 'the panel stays open');

  await page.click('.tp3d-annot-pin:not(.is-draft)');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-card.is-selected').length), 0, '3: then the annotation selection');

  // With cargo selected and nothing of ours to close, the existing handler keeps Escape.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  await page.waitForFunction(() => window.probe.selection().includes('cargo-a'));
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], '4: cargo is deselected by the Editor, as before');
  assert.equal(await escapeConsumed(page), false, 'with nothing to close the key is not consumed');

  // A text field that owns Escape keeps it.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  assert.deepEqual(errors, []);
});

test('dragging a card changes only its screen offset: the anchor, the marker and cargo stay put, and the card follows the marker', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const [saved] = await seed(page, [{ title: 'Movable', ...TOP_OF_A }]);
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));
  const markerBefore = await pinCentreOf(page);
  const head = await page.locator('.tp3d-annot-card.is-selected .tp3d-annot-card__head').boundingBox();
  const grab = { x: head.x + 40, y: head.y + head.height / 2 };

  // Escape mid-drag restores the card and writes nothing.
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 120, grab.y + 90, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal((await page.evaluate(() => window.probe.annotations()))[0].offset, null, 'a cancelled drag writes nothing');
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), before.edited);

  // A real drag stores one offset.
  const cardBefore = await page.locator('.tp3d-annot-card.is-selected').boundingBox();
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 70, grab.y + 50, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations()[0].offset !== null);
  const [dragged] = await page.evaluate(() => window.probe.annotations());
  assert.deepEqual(dragged.anchor, saved.anchor, 'the anchor never changes');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is never moved');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera);
  await oneStepRoundTrip(page, 'the card move');
  const markerAfter = await pinCentreOf(page);
  assert.ok(Math.abs(markerAfter.x - markerBefore.x) < 1 && Math.abs(markerAfter.y - markerBefore.y) < 1, 'the marker did not move');
  const cardAfter = await page.locator('.tp3d-annot-card.is-selected').boundingBox();
  assert.ok(Math.abs(cardAfter.x - cardBefore.x - 70) < 2 && Math.abs(cardAfter.y - cardBefore.y - 50) < 2, 'the card moved with the pointer');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-card.is-selected').length), 1, 'a drag does not deselect it');
  const offsetOf = async () => {
    const card = await page.locator('.tp3d-annot-card.is-selected').boundingBox();
    const pin = await pinCentreOf(page);
    return { dx: card.x - pin.x, dy: card.y - pin.y };
  };
  const stored = await offsetOf();
  assert.ok(Math.abs(stored.dx - dragged.offset.dx) < 2 && Math.abs(stored.dy - dragged.offset.dy) < 2, 'the stored offset is marker-relative');

  // Orbit the camera: the marker moves with the cargo and the card keeps its offset from it.
  const box = await page.evaluate(() => window.probe.box('#viewport canvas'));
  await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.3 + 80, box.y + box.h * 0.8 + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(c => window.probe.camera() !== c, before.camera);
  await page.waitForTimeout(400);
  const movedMarker = await pinCentreOf(page);
  assert.ok(Math.abs(movedMarker.x - markerAfter.x) + Math.abs(movedMarker.y - markerAfter.y) > 5, 'the marker followed the cargo through the orbit');
  const after = await offsetOf();
  assert.ok(Math.abs(after.dx - stored.dx) < 2 && Math.abs(after.dy - stored.dy) < 2, 'the card kept its offset from the marker');
  assert.deepEqual(errors, []);
});

test('annotations pause while an operation owns the Editor: graphics and editing are gone, records are untouched, and the pause ends by itself', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'First', ground: [520, 10], keepExpanded: true }, { title: 'Second', ...TOP_OF_B }]);
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  const paused = () => page.evaluate(() => (/paused/.test(window.probe.hint()) ? window.probe.hint() : ''));
  const controls = () => page.evaluate(() => ({
    tool: document.querySelector('.tp3d-annot-seg__btn[data-tool="callout"]').disabled,
    rows: [...document.querySelectorAll('.tp3d-annot-row__select, .tp3d-annot-row__eye, .tp3d-annot-row__edit, .tp3d-annot-row__delete')].map(b => b.disabled),
  }));
  const graphics = () => page.evaluate(() => ({
    pins: document.querySelectorAll('.tp3d-annot-pin:not([hidden])').length,
    cards: document.querySelectorAll('.tp3d-annot-card:not([hidden])').length,
    leaders: [...document.querySelectorAll('.tp3d-annot-svg__leader, .tp3d-annot-svg__under')].filter(el => el.getAttribute('d')).length,
    chips: [...document.querySelectorAll('.tp3d-annot-pin__chip')].filter(el => !el.hidden).length,
  }));
  const before = await page.evaluate(() => ({ json: JSON.stringify(window.probe.annotations()), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));
  assert.equal((await graphics()).pins, 2);

  // A background thumbnail capture only reads pixels back: nothing pauses.
  await page.evaluate(() => { window.__capture = window.probe.OperationLifecycle.beginOperation('capturingPreview'); });
  await page.waitForTimeout(300);
  assert.equal(await paused(), '', 'a passive capture is not a pause');
  assert.equal((await graphics()).pins, 2);
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__capture));

  // AutoPack running: a short status, no graphics of any kind, no editing, no selection.
  await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('autopacking'); });
  await page.waitForFunction(() => /paused/.test(window.probe.hint()));
  assert.equal(await paused(), 'Annotations paused during AutoPack.');
  assert.deepEqual(await graphics(), { pins: 0, cards: 0, leaders: 0, chips: 0 }, 'the cargo scene is clean');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-panel__blocked').length), 0, 'no banner, only the compact status line');
  assert.deepEqual(await controls(), { tool: true, rows: Array(8).fill(true) }, 'creation, selection and editing are refused');
  await page.focus('#viewport');
  await page.keyboard.press('Delete');
  assert.equal(await count(page), 2, 'Delete is refused too');
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  assert.equal((await graphics()).pins, 2, 'the pins come back from the unchanged records');
  assert.deepEqual(await controls(), { tool: false, rows: Array(8).fill(false) }, 'editing resumes when the operation ends');
  assert.deepEqual(await page.evaluate(() => ({ json: JSON.stringify(window.probe.annotations()), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited })), before, 'records and lastEdited never changed');

  // An unfinished editor does not survive a pause, and nothing it held is written.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Unsaved');
  await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('unpacking'); });
  await page.waitForFunction(() => /paused during Unpack/.test(window.probe.hint()));
  assert.equal(await editorClosed(page), true);
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
  assert.equal((await page.evaluate(() => window.probe.annotations()))[1].title, 'Second');
  assert.deepEqual(errors, []);
});

test('the overlay is DOM above the canvas: no scene objects are added and the canvas pixels are unchanged', { timeout: 120000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const base = await page.evaluate(() => ({ pixels: window.probe.canvasData(), objects: window.probe.sceneObjectCount() }));
  await seed(page, [{ title: 'One', ground: [520, 10], keepExpanded: true }, { title: 'Two', ...TOP_OF_B }, { title: 'Three', ...TOP_OF_A }]);
  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Cards")');
  await page.waitForSelector('.tp3d-annot-card:not([hidden])');
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 3);
  const drawn = await page.evaluate(() => ({ pixels: window.probe.canvasData(), objects: window.probe.sceneObjectCount() }));
  assert.equal(drawn.objects, base.objects, 'no scene object is added');
  assert.equal(drawn.pixels, base.pixels, 'markers, cards and leaders never reach the canvas pixels (and so never a Screenshot, PDF view or thumbnail)');
  const placement = await page.evaluate(() => ({
    insideViewport: Boolean(document.querySelector('#viewport .tp3d-annot-pin, #viewport .tp3d-annot-card, #viewport .tp3d-annot-svg')),
    layerParent: document.getElementById('editor-annotation-layer').parentElement.classList.contains('canvas-wrap'),
    clickThrough: getComputedStyle(document.getElementById('editor-annotation-layer')).pointerEvents,
  }));
  assert.deepEqual(placement, { insideViewport: false, layerParent: true, clickThrough: 'none' });
  assert.deepEqual(errors, []);
});

test('Needs Review and Unresolved callouts stay stored and flagged, are never drawn, and Re-attach is the owner\'s deliberate remedy', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'On case A', cargo: 'cargo-a', local: { x: 12, y: 16, z: 8 } }, { title: 'On case B', ...TOP_OF_B }, { title: 'On ground', ground: [520, 10] }]);
  const drawnPins = () => page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 3);
  const stored = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  const row = n => page.evaluate(i => {
    const el = document.querySelectorAll('.tp3d-annot-row')[i];
    return { sub: el.querySelector('.tp3d-annot-row__sub').textContent, issue: el.querySelector('.tp3d-annot-row__issue').hidden ? '' : el.querySelector('.tp3d-annot-row__issue').textContent.trim(), reattach: !el.querySelector('.tp3d-annot-row__issue .tp3d-annot-btn').hidden, flagged: el.querySelector('.tp3d-annot-row__badge').classList.contains('is-flagged') };
  }, n);

  // A Case size change asks for review: no number position is invented and the record is untouched.
  await page.evaluate(() => {
    const { StateStore } = window.probe;
    const caseId = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-b').caseId;
    window.__caseB = StateStore.get('caseLibrary').find(c => c.id === caseId);
    StateStore.set({ caseLibrary: StateStore.get('caseLibrary').map(c => (c.id === caseId ? { ...c, dimensions: { ...c.dimensions, length: c.dimensions.length + 6 } } : c)) }, { skipHistory: true });
  });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2);
  const review = await row(1);
  assert.equal(review.sub, 'Needs review');
  assert.match(review.issue, /size or shape changed/i);
  assert.equal(review.reattach, true);
  assert.equal(review.flagged, true, 'a dashed ring, never a placed dot');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), stored, 'nothing is rewritten or relocated');

  // Deleting the cargo leaves its callout Unresolved with an explanation.
  await page.evaluate(() => window.probe.PackLibrary.removeInstances('fixture-pack', ['cargo-a']));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1);
  const gone = await row(0);
  assert.equal(gone.sub, 'Unresolved');
  assert.match(gone.issue, /no longer in this Load Plan/);
  assert.equal(await count(page), 3, 'editing cargo never deletes an annotation');
  assert.equal(await drawnPins(), 1);

  // Re-attach: Escape cancels without writing; a click on a surface moves only the marker.
  const edited = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__issue .tp3d-annot-btn');
  await page.waitForFunction(() => /re-attach this callout/i.test(window.probe.hint()));
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await page.evaluate(() => window.probe.hint()), /re-attach this callout/i);
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), edited, 'a cancelled re-attach writes nothing');
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__issue .tp3d-annot-btn');
  await page.waitForFunction(() => /re-attach this callout/i.test(window.probe.hint()));
  const cargoBefore = await page.evaluate(() => window.probe.casesJson());
  await click(page, await point(page, ...GROUND_A));
  await page.waitForFunction(() => window.probe.resolved()[0].status === 'valid');
  const [reattached] = await page.evaluate(() => window.probe.annotations());
  assert.deepEqual([reattached.anchor.kind, reattached.anchor.surface, reattached.title], ['space', 'ground', 'On case A'], 'the same callout, on its new surface');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore, 'cargo is never touched');
  // Newest first: the re-attach, then the cargo removal that made the callout need review.
  const afterReattach = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'the re-attach is undone first');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'then the cargo removal');
  await page.waitForFunction(() => window.probe.resolved().every(r => r.status === 'valid'));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 3);
  assert.deepEqual((await page.evaluate(() => window.probe.annotations()))[1], JSON.parse(stored)[1], 'the callout is Valid again, exactly as it was stored');
  // Redo replays the cargo removal and then the re-attach, to exactly the state that was saved.
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true);
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, 'Redo replays the removal, then the re-attach');
  await page.waitForFunction(() => window.probe.resolved()[0].status === 'valid');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), afterReattach, 'Redo restores the re-attached callout exactly');
  assert.deepEqual(errors, []);
});

test('Markers, Labels and Cards are view-level, kept-expanded and Hide are saved with the Load Plan', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'Kept', ground: [520, 10], keepExpanded: true }, { title: 'Plain B', ...TOP_OF_B }, { title: 'Plain C', ground: [200, -30] }]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 3);
  const visible = (selector) => page.evaluate(sel => [...document.querySelectorAll(sel)].filter(el => !el.hidden).length, selector);
  assert.equal(await visible('.tp3d-annot-card'), 1, 'Markers: only the kept-expanded callout shows a card');
  assert.equal(await visible('.tp3d-annot-pin__chip'), 0, 'and no labels');
  const stored = JSON.stringify(await page.evaluate(() => window.probe.annotations()));

  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Labels")');
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-annot-pin__chip')].some(el => !el.hidden));
  const labels = await page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-pin__chip')].filter(el => !el.hidden).map(el => el.textContent).sort());
  assert.ok(labels.length >= 1 && labels.every(text => ['Plain B', 'Plain C'].includes(text)), 'Labels: a title beside each marker without a card');
  assert.equal(await visible('.tp3d-annot-card'), 1);

  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Cards")');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-card:not([hidden])').length >= 3);
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-seg--display [aria-pressed="true"]').textContent), 'Cards');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), stored, 'the display mode is a view setting: nothing was written');

  // Hide / Show is saved with the Load Plan.
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye');
  await page.waitForFunction(() => window.probe.annotations()[2].hidden === true);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2);
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__sub').textContent), 'Ground · Hidden');
  assert.equal(await page.getAttribute('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye', 'aria-label'), 'Show Plain C');
  await oneStepRoundTrip(page, 'the hide');
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye');
  await page.waitForFunction(() => window.probe.annotations()[2].hidden === false);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 3);
  assert.deepEqual(errors, []);
});

test('a callout folds to its header and opens again: selection, hidden flag and saved records never change, and a folded card stays in Markers, Labels and Cards', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'Folded', ...TOP_OF_A, description: 'A long description that the header hides' }, { title: 'Other', ...TOP_OF_B }]);
  await page.waitForSelector('.tp3d-annot-row >> nth=1');
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  const stored = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  const foldButton = '.tp3d-annot-card.is-selected .tp3d-annot-card__btn[data-act="collapse"]';

  await page.click(foldButton);
  await page.waitForSelector('.tp3d-annot-card.is-collapsed');
  const folded = await page.evaluate(() => {
    const card = document.querySelector('.tp3d-annot-card.is-collapsed');
    const visibleOf = sel => { const el = card.querySelector(sel); return el && !el.hidden && getComputedStyle(el).display !== 'none'; };
    return {
      cardShown: !card.hidden && card.getBoundingClientRect().height > 0,
      title: card.querySelector('.tp3d-annot-card__title').textContent,
      desc: visibleOf('.tp3d-annot-card__desc'),
      foot: visibleOf('.tp3d-annot-card__foot'),
      selected: card.classList.contains('is-selected'),
      expanded: card.querySelector('[data-act="collapse"]').getAttribute('aria-expanded'),
    };
  });
  assert.deepEqual(folded, { cardShown: true, title: 'Folded', desc: false, foot: false, selected: true, expanded: 'false' });
  assert.equal(await page.getAttribute('.tp3d-annot-row:first-child .tp3d-annot-row__select', 'aria-pressed'), 'true', 'folding keeps the record selected');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), stored, 'folding writes nothing and changes no hidden flag or anchor');

  // Selecting the other record in Markers leaves the folded one as its header, not gone.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select[aria-pressed="true"]');
  for (const mode of ['Markers', 'Labels', 'Cards']) {
    await page.click(`.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("${mode}")`);
    await page.waitForFunction(() => document.querySelector('.tp3d-annot-card.is-collapsed:not([hidden])'));
    assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-card.is-collapsed').classList.contains('is-selected')), false, `${mode}: the folded card is no longer selected`);
  }

  // Opening it again restores the body; nothing was written.
  await page.click('.tp3d-annot-card.is-collapsed .tp3d-annot-card__btn[data-act="collapse"]');
  await page.waitForFunction(() => !document.querySelector('.tp3d-annot-card.is-collapsed'));
  assert.equal(await page.evaluate(() => {
    const card = [...document.querySelectorAll('.tp3d-annot-card')].find(el => el.querySelector('.tp3d-annot-card__title').textContent === 'Folded');
    return Boolean(card) && !card.querySelector('.tp3d-annot-card__desc').hidden && !card.querySelector('.tp3d-annot-card__foot').hidden;
  }), true, 'the body and footer come back');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), stored, 'opening again writes nothing');
  assert.deepEqual(errors, []);
});

test('Labels mode in a crowded view draws only labels that cover no other label or marker; every marker stays',{ timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // Four markers a few pixels apart on one case: their labels would pile up.
  await seed(page, [-17, -6, 5, 16].map((x, i) => ({ title: `Latch number ${i + 1}`, cargo: 'cargo-a', local: { x, y: 16, z: i % 2 ? 6 : -6 } })));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 4);
  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Labels")');
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-annot-pin__chip')].some(el => !el.hidden));
  const shown = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const pins = [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])')].map(el => ({ el, rect: rect(el) }));
    const chips = pins.filter(({ el }) => !el.querySelector('.tp3d-annot-pin__chip').hidden).map(({ el }) => ({ own: el, rect: rect(el.querySelector('.tp3d-annot-pin__chip')) }));
    const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
    const badge = el => rect(el.querySelector('.tp3d-annot-pin__badge') || el);
    return {
      pins: pins.length,
      chips: chips.length,
      chipOverChip: chips.some((a, i) => chips.slice(i + 1).some(b => overlap(a.rect, b.rect))),
      chipOverMarker: chips.some(c => pins.some(p => p.el !== c.own && overlap(c.rect, badge(p.el)))),
    };
  });
  assert.equal(shown.pins, 4, 'every marker stays drawn');
  assert.ok(shown.chips >= 1 && shown.chips < 4, `crowded labels are dropped, not piled up (${shown.chips} of 4 drawn)`);
  assert.equal(shown.chipOverChip, false, 'no label covers another label');
  assert.equal(shown.chipOverMarker, false, 'and no label covers another marker');
  assert.equal(await count(page), 4, 'nothing was written or removed');
  assert.deepEqual(errors, []);
});

test('automatically placed cards and labels keep clear of the open panel and of every marker', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [
    { title: 'FRAGILE', description: 'Check packaging condition before loading.', ...TOP_OF_A },
    { title: 'THIS SIDE UP', description: 'Keep upright during loading.', ground: [330, 25] },
    { title: 'HEAVY', description: 'Use two people or a lift.', ground: [400, 60] },
    { title: 'CUSTOMER PICKUP', description: 'Keep accessible for scheduled collection.', ...TOP_OF_B },
    { title: 'Rear doors', ground: [470, 20] },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 5);
  const overlapsPanel = () => page.evaluate(() => {
    const panel = document.getElementById('editor-annotation-panel').getBoundingClientRect();
    const hit = r => Math.min(r.right, panel.right) > Math.max(r.left, panel.left) && Math.min(r.bottom, panel.bottom) > Math.max(r.top, panel.top);
    const shown = selector => [...document.querySelectorAll(selector)].filter(el => !el.hidden && el.getClientRects().length).map(el => el.getBoundingClientRect());
    return {
      pinsNearPanel: shown('.tp3d-annot-pin:not(.is-draft)').filter(r => r.left < panel.left && r.right > panel.left - 215 && r.top < panel.bottom && r.bottom > panel.top).length,
      cards: shown('.tp3d-annot-card').length,
      cardsOnPanel: shown('.tp3d-annot-card').filter(hit).length,
      chips: shown('.tp3d-annot-pin__chip').length,
      chipsOnPanel: shown('.tp3d-annot-pin__chip').filter(hit).length,
    };
  });
  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Cards")');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-card:not([hidden])').length === 5);
  const cards = await overlapsPanel();
  assert.ok(cards.pinsNearPanel >= 1, 'the scene has a marker whose right-hand card slot would sit under the panel');
  assert.equal(cards.cards, 5);
  assert.equal(cards.cardsOnPanel, 0, 'no automatically placed card is hidden under the panel');
  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Labels")');
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-annot-pin__chip')].some(el => !el.hidden));
  const labels = await overlapsPanel();
  assert.ok(labels.chips >= 1);
  assert.equal(labels.chipsOnPanel, 0, 'and no label is hidden under it');
  assert.deepEqual(errors, []);
});

const livePins = page => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft)')].filter(el => !el.hidden).map(el => el.querySelector('.tp3d-annot-pin__badge').textContent));
const liveCards = page => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-card')].filter(el => !el.hidden).map(el => el.getAttribute('aria-label')));
const showButton = (page, label) => page.locator(`.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("${label}")`);
const displayButton = (page, label) => page.locator(`.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("${label}")`);
const dialogButton = (page, name) => page.locator('.modal-overlay, .modal').getByRole('button', { name });
const editorInside = page => page.evaluate(() => { const ed = document.querySelector('.tp3d-annot-editor'); return Boolean(ed && !ed.hidden && ed.contains(document.activeElement)); });

test('hiding the callout being edited closes its editor; unsaved changes need an explicit decision; unrelated hides leave it open', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'First', ground: [520, 10] }, { title: 'Second', ...TOP_OF_B }]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2);
  const record = n => page.evaluate(i => window.probe.annotations()[i], n);
  const eye = n => page.click(`.tp3d-annot-row:nth-child(${n}) .tp3d-annot-row__eye`);

  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  // Hiding another callout does not touch the open editor.
  await eye(2);
  await page.waitForFunction(() => window.probe.annotations()[1].hidden === true);
  assert.equal(await editorClosed(page), false, 'an unrelated hide leaves the editor open');
  await eye(2);
  await page.waitForFunction(() => window.probe.annotations()[1].hidden === false);
  assert.equal(await editorClosed(page), false);

  // Hiding the one being edited (nothing unsaved) closes the editor, with no dialog and nothing committed.
  const before = JSON.stringify(await record(0));
  await eye(1);
  await page.waitForFunction(() => window.probe.annotations()[0].hidden === true);
  assert.equal(await editorClosed(page), true, 'the editor closed');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.modal-overlay, .modal').length), 0, 'no dialog for a clean editor');
  assert.equal(await page.evaluate(() => { const el = document.querySelector('.tp3d-annot-pin.is-draft'); return !el || el.hidden; }), true, 'no marker preview is left');
  assert.equal(await editorInside(page), false, 'focus is not stranded in the closed editor');
  const hidden = await record(0);
  assert.deepEqual([hidden.title, hidden.hidden], ['First', true]);
  assert.equal(JSON.stringify({ ...hidden, hidden: false, updatedAt: 0 }), JSON.stringify({ ...JSON.parse(before), updatedAt: 0 }), 'only the hidden flag changed');
  // Show restores it normally; Escape and the keyboard still work afterwards.
  await eye(1);
  await page.waitForFunction(() => window.probe.annotations()[0].hidden === false);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2);
  await page.focus('#viewport');
  await page.keyboard.press('Escape');

  // With unsaved changes: Keep editing changes nothing; Discard and hide closes without saving them.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Unsaved title');
  await eye(1);
  await dialogButton(page, 'Keep editing').click();
  assert.equal(await editorClosed(page), false, 'declining leaves the editor open');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'Unsaved title', 'with its unsaved text');
  assert.deepEqual([(await record(0)).hidden, (await record(0)).title], [false, 'First'], 'and the visibility and record unchanged');
  await eye(1);
  await dialogButton(page, 'Discard and hide').click();
  await page.waitForFunction(() => window.probe.annotations()[0].hidden === true);
  assert.equal(await editorClosed(page), true);
  assert.equal((await record(0)).title, 'First', 'the unsaved text was never committed');
  assert.equal(await count(page), 2);
  await eye(1);
  await page.waitForFunction(() => window.probe.annotations()[0].hidden === false);
  assert.deepEqual(errors, []);
});

test('Show All / Selected / Off is view state: it filters the overlay, never writes, never overrides Hide, and Off ends invisible gestures', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'One', ground: [520, 10], keepExpanded: true }, { title: 'Two', ...TOP_OF_B }, { title: 'Three', ground: [200, -30] }]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 3);
  const pressed = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-seg--show .tp3d-annot-seg__btn')].map(b => `${b.textContent}:${b.getAttribute('aria-pressed')}`));
  assert.deepEqual(await pressed(), ['All:true', 'Selected:false', 'Off:false'], 'All is the default');
  const snapshot = () => page.evaluate(() => ({ json: JSON.stringify(window.probe.annotations()), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited, cases: window.probe.casesJson() }));
  const base = await snapshot();
  assert.deepEqual(await livePins(page), ['1', '2', '3']);

  // Selected: only the selected callout (and its card) is drawn; the list stays complete.
  await showButton(page, 'Selected').click();
  assert.deepEqual(await livePins(page), [], 'nothing selected: no graphics (the kept-expanded card too)');
  assert.deepEqual(await liveCards(page), []);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-row').length), 3, 'the list is still available');
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  assert.deepEqual(await livePins(page), ['2']);
  assert.equal((await liveCards(page)).length, 1, 'only the selected card');
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-row:nth-child(3)').classList.contains('is-selected'));
  assert.deepEqual(await livePins(page), ['3'], 'selecting another callout moves the view to it');

  // A callout's own Hide always wins over the global mode.
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye');
  await page.waitForFunction(() => window.probe.annotations()[2].hidden === true);
  assert.deepEqual(await livePins(page), [], 'a hidden callout is not drawn even when selected');
  await showButton(page, 'All').click();
  assert.deepEqual(await livePins(page), ['1', '2']);
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye');
  await page.waitForFunction(() => window.probe.annotations()[2].hidden === false);
  const afterHide = await snapshot();

  // Off: no pins, labels, cards or leader lines; the panel stays; creation and gestures are unavailable.
  await showButton(page, 'Off').click();
  assert.deepEqual(await livePins(page), []);
  const graphics = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.tp3d-annot-card')].filter(el => !el.hidden).length,
    chips: [...document.querySelectorAll('.tp3d-annot-pin__chip')].filter(el => !el.hidden && el.closest('.tp3d-annot-pin') && !el.closest('.tp3d-annot-pin').hidden).length,
    leaders: [...document.querySelectorAll('.tp3d-annot-svg__leader, .tp3d-annot-svg__under')].filter(el => el.getAttribute('d')).length,
    panelShown: !document.getElementById('editor-annotation-panel').hidden,
    tool: document.querySelector('.tp3d-annot-seg__btn[data-tool="callout"]').disabled,
    rows: [...document.querySelectorAll('.tp3d-annot-row__select, .tp3d-annot-row__edit')].every(b => b.disabled),
    hint: window.probe.hint(),
  }));
  assert.deepEqual([graphics.cards, graphics.chips, graphics.leaders, graphics.panelShown, graphics.tool, graphics.rows], [0, 0, 0, true, true, true]);
  assert.match(graphics.hint, /hidden in the view/i);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'cargo selection untouched');
  await click(page, await point(page, ...GROUND_A));
  assert.equal(await count(page), 3, 'a click on the scene creates nothing while Off');
  assert.equal(await editorClosed(page), true);
  await page.focus('#viewport');
  await page.keyboard.press('Delete');
  assert.equal(await count(page), 3, 'Delete cannot remove an annotation that cannot be seen');

  // None of the mode changes wrote anything, bumped lastEdited or became a cargo Undo step.
  assert.deepEqual(await snapshot(), afterHide);
  assert.equal(afterHide.cases, base.cases);
  // The newest step is the Hide itself: no mode change added one, so Undo reverts the Hide and Redo restores it.
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'the Hide is the newest step');
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true);

  // Back to All (the kept-expanded callout shows its card again).
  await showButton(page, 'All').click();
  assert.deepEqual(await livePins(page), ['1', '2', '3']);
  assert.equal((await liveCards(page)).length, 1);

  // Off with an unfinished new callout: nothing happens until the owner decides; a clean one just closes.
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await click(page, await freePoint(page, [GROUND_A, GROUND_B, [60, 0, 60]]));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await showButton(page, 'Off').click();
  assert.equal(await editorClosed(page), true, 'a new callout with nothing typed has nothing to lose: it closes');
  assert.deepEqual(await pressed(), ['All:false', 'Selected:false', 'Off:true']);
  await showButton(page, 'All').click();
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await click(page, await freePoint(page, [GROUND_A, GROUND_B, [60, 0, 60]]));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Typed draft');
  await showButton(page, 'Off').click();
  await dialogButton(page, 'Keep editing').click();
  assert.equal(await editorClosed(page), false, 'declining keeps the editor');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'Typed draft');
  assert.deepEqual(await pressed(), ['All:true', 'Selected:false', 'Off:false'], 'and the mode is unchanged');
  await showButton(page, 'Off').click();
  await dialogButton(page, 'Discard and turn off').click();
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-seg--show [aria-pressed="true"]').textContent === 'Off');
  assert.equal(await editorClosed(page), true);
  assert.equal(await count(page), 3, 'the unsaved callout was never written');
  assert.deepEqual(await page.evaluate(() => document.querySelector('.tp3d-annot-seg__btn[data-tool="callout"]').getAttribute('aria-pressed')), 'false', 'the tool is disarmed');

  // The view controls stay usable while an operation makes editing read-only.
  await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('autopacking'); });
  await page.waitForFunction(() => /paused/.test(window.probe.hint()));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-seg--show .tp3d-annot-seg__btn, .tp3d-annot-seg--display .tp3d-annot-seg__btn')].every(b => !b.disabled)), true);
  await showButton(page, 'Selected').click();
  assert.deepEqual(await pressed(), ['All:false', 'Selected:true', 'Off:false']);
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
  assert.deepEqual(await snapshot(), afterHide, 'still nothing written');

  // The mode belongs to the Load Plan session, not to the panel: closing, collapsing and reopening keep it.
  await showButton(page, 'Off').click();
  await page.click('#btn-editor-annotations');
  await page.click('#btn-editor-annotations');
  await page.waitForSelector('.tp3d-annot-seg--show');
  assert.deepEqual(await pressed(), ['All:false', 'Selected:false', 'Off:true'], 'Off survives closing and reopening the panel');
  assert.deepEqual(await livePins(page), [], 'and the graphics stay off while the panel is closed');
  await page.click('#btn-editor-annotations');
  assert.deepEqual(await livePins(page), [], 'closed panel, still off');
  await page.click('#btn-editor-annotations');
  await page.click('.tp3d-annot-panel__toggle');
  await page.click('.tp3d-annot-panel__toggle');
  assert.deepEqual(await pressed(), ['All:false', 'Selected:false', 'Off:true'], 'and collapsing');
  // It ends with the session: another Load Plan starts at All.
  await page.evaluate(() => {
    const copy = window.probe.PackLibrary.duplicate('fixture-pack');
    window.__otherPack = copy.id;
    window.probe.StateStore.set({ currentPackId: copy.id }, { skipHistory: true });
  });
  await page.click('#btn-editor-annotations');
  await page.waitForSelector('.tp3d-annot-seg--show');
  assert.deepEqual(await pressed(), ['All:true', 'Selected:false', 'Off:false'], 'another Load Plan starts at All');
  assert.equal((await livePins(page)).length, 3);
  assert.deepEqual(errors, []);
});

test('Markers / Labels / Cards switch cleanly in every state: identity, numbering, selection and the saved data never change', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // No annotations: switching is harmless.
  for (const label of ['Labels', 'Cards', 'Markers', 'Cards', 'Labels', 'Markers']) await displayButton(page, label).click();
  assert.deepEqual(await livePins(page), []);

  await seed(page, [
    { title: 'Selected one', description: 'Chosen', ...TOP_OF_A },
    { title: 'Kept open', description: 'Always expanded', ground: [520, 10], keepExpanded: true },
    { title: 'Hidden one', ground: [200, -30] },
    { title: 'Behind', cargo: 'cargo-b', local: { x: 10, y: -12, z: 10 } },
    { title: 'Plain', ground: [330, 25] },
  ]);
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye');
  await page.waitForFunction(() => window.probe.annotations()[2].hidden === true);
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  await page.waitForTimeout(300);
  const base = await page.evaluate(() => ({ json: JSON.stringify(window.probe.annotations()), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));
  const depthBefore = await historyDepth(page);
  const state = async () => page.evaluate(() => {
    const visible = sel => [...document.querySelectorAll(sel)].filter(el => !el.hidden);
    const pins = visible('.tp3d-annot-pin:not(.is-draft)');
    return {
      pins: pins.map(el => el.querySelector('.tp3d-annot-pin__badge').textContent),
      cards: visible('.tp3d-annot-card').map(el => el.getAttribute('aria-label')),
      chips: pins.filter(el => !el.querySelector('.tp3d-annot-pin__chip').hidden).map(el => el.querySelector('.tp3d-annot-pin__chip').textContent),
      selected: [...document.querySelectorAll('.tp3d-annot-row.is-selected')].map(el => el.dataset.annotId),
      numbers: [...document.querySelectorAll('.tp3d-annot-row__badge')].map(el => el.textContent),
      selectedCards: visible('.tp3d-annot-card.is-selected').length,
      data: JSON.stringify(window.probe.annotations()),
      edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited,
    };
  });
  const check = async (mode, label) => {
    await displayButton(page, mode).click();
    await page.waitForFunction(m => [...document.querySelectorAll('.tp3d-annot-seg--display .tp3d-annot-seg__btn')].find(b => b.textContent === m).getAttribute('aria-pressed') === 'true', mode);
    const now = await state();
    assert.deepEqual(now.pins.sort(), ['1', '2', '4', '5'], `${label}: every visible callout keeps its marker (the hidden one stays hidden)`);
    assert.deepEqual(now.numbers, ['1', '2', '3', '4', '5'], `${label}: numbering is stable`);
    assert.equal(new Set(now.cards).size, now.cards.length, `${label}: no duplicate cards`);
    assert.equal(now.selectedCards, 1, `${label}: the selected callout keeps its expanded card`);
    assert.ok(now.cards.some(text => /Kept open/.test(text)), `${label}: the kept-expanded callout keeps its card`);
    assert.equal(now.selected.length, 1, `${label}: the selection survives`);
    assert.equal(now.data, base.json, `${label}: nothing was written`);
    assert.equal(now.edited, base.edited, `${label}: lastEdited is untouched`);
    if (mode === 'Markers') {
      assert.deepEqual(now.chips, [], 'Markers: no labels');
      assert.equal(now.cards.length, 2, 'Markers: only the selected and kept-expanded cards');
    } else if (mode === 'Labels') {
      assert.ok(now.chips.length >= 1, `Labels: titles beside markers (chips ${JSON.stringify(now.chips)}, cards ${now.cards.length})`);
      assert.equal(now.cards.length, 2, 'Labels: the selected and kept-expanded cards only');
      assert.ok(!now.chips.some(text => /Selected one|Kept open/.test(text)), 'Labels: a callout with a card has no duplicate label');
    } else {
      assert.ok(now.cards.length >= 3, 'Cards: every eligible callout within the budget');
      assert.ok(now.cards.length <= 4, 'Cards: never the hidden one');
      assert.deepEqual(now.chips, [], 'Cards: no stray labels');
    }
    return now;
  };
  for (const mode of ['Labels', 'Cards', 'Markers', 'Cards', 'Labels', 'Markers', 'Labels', 'Cards']) await check(mode, `switch to ${mode}`);

  // After orbiting and zooming the camera, and in Cards mode again.
  const box = await page.evaluate(() => window.probe.box('#viewport canvas'));
  await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.85);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.3 + 120, box.y + box.h * 0.85 + 30, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.w * 0.4, box.y + box.h * 0.8);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);
  for (const mode of ['Markers', 'Labels', 'Cards', 'Markers']) await displayButton(page, mode).click();
  const afterCamera = await state();
  assert.equal(afterCamera.data, base.json);
  assert.equal(afterCamera.edited, base.edited);
  assert.equal(new Set(afterCamera.cards).size, afterCamera.cards.length);
  assert.equal(afterCamera.selectedCards, 1);
  assert.deepEqual(afterCamera.numbers, ['1', '2', '3', '4', '5']);
  assert.equal(await historyDepth(page), depthBefore, 'display switching and camera moves add no history step');
  assert.deepEqual(errors, []);
});

test('a crowded scene falls back to labels and markers without losing any marker, and keeps the selected and kept-expanded cards first', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, Array.from({ length: 40 }, (_, i) => ({
    title: `Callout ${i + 1}`, description: 'Dense', ground: [20 + (i % 10) * 20, -40 + Math.floor(i / 10) * 20], keepExpanded: i === 31,
  })));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 40);
  await page.click('.tp3d-annot-row:nth-child(7) .tp3d-annot-row__select');
  await displayButton(page, 'Cards').click();
  await page.waitForTimeout(400);
  const now = await page.evaluate(() => ({
    pins: [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft)')].filter(el => !el.hidden).length,
    cards: [...document.querySelectorAll('.tp3d-annot-card')].filter(el => !el.hidden).map(el => el.getAttribute('aria-label')),
    notice: [...document.querySelectorAll('.tp3d-annot-overflow')].filter(el => !el.hidden).length,
  }));
  assert.equal(now.pins, 40, 'no marker is ever hidden by the card budget');
  assert.ok(now.cards.length >= 2 && now.cards.length < 40, `the budget caps the cards (${now.cards.length})`);
  assert.ok(now.cards.some(text => /^Callout 7:/.test(text)), 'the selected callout has its card');
  assert.ok(now.cards.some(text => /^Callout 32:/.test(text)), 'and so does the kept-expanded one');
  assert.equal(now.notice, 1, 'the overflow is explained');
  assert.deepEqual(errors, []);
});

test('custom colors: one native color swatch beside the five names; the color is applied everywhere, readable, and saved as #rrggbb', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  const style = selector => page.evaluate(sel => { const el = document.querySelector(sel); const cs = getComputedStyle(el); return { bg: cs.backgroundColor, fg: cs.color }; }, selector);
  await click(page, await freePoint(page, [GROUND_A, GROUND_B]));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-swatches .tp3d-annot-swatch').length), 6, 'five names plus one custom');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-swatch__input').type), 'color', 'a native, accessible color input');
  assert.equal(await page.getAttribute('.tp3d-annot-swatch__input', 'aria-label'), 'Custom color');
  await page.fill('.tp3d-annot-editor__input', 'Yellow note');
  await page.fill('.tp3d-annot-swatch__input', '#ffff00');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-swatch--custom').classList.contains('is-selected')), true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-swatch[aria-pressed="true"]').length), 0, 'no built-in swatch stays selected');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const [first] = await page.evaluate(() => window.probe.annotations());
  assert.equal(first.color, '#ffff00', 'stored as canonical #rrggbb in the one existing color field');
  assert.deepEqual(Object.keys(first).sort(), ['anchor', 'color', 'createdAt', 'description', 'hidden', 'id', 'keepExpanded', 'offset', 'schemaVersion', 'title', 'type', 'updatedAt']);
  await page.waitForSelector('.tp3d-annot-pin:not(.is-draft):not([hidden])');
  assert.deepEqual(await style('.tp3d-annot-pin:not(.is-draft) .tp3d-annot-pin__badge'), { bg: 'rgb(255, 255, 0)', fg: 'rgb(17, 19, 24)' }, 'marker and number: dark text on a light color');
  assert.deepEqual(await style('.tp3d-annot-row__badge'), { bg: 'rgb(255, 255, 0)', fg: 'rgb(17, 19, 24)' }, 'list swatch');
  assert.deepEqual(await style('.tp3d-annot-card.is-selected .tp3d-annot-card__swatch'), { bg: 'rgb(255, 255, 0)', fg: 'rgb(17, 19, 24)' }, 'card accent');

  // A very dark custom color gets a white number; dark theme does not change a chosen color.
  if ((await page.getAttribute('.tp3d-annot-seg__btn[data-tool="callout"]', 'aria-pressed')) !== 'true') await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await click(page, await freePoint(page, [GROUND_B, GROUND_A, [60, 0, 60]]));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Dark note');
  await page.fill('.tp3d-annot-swatch__input', '#000000');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  assert.deepEqual(await style('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__badge'), { bg: 'rgb(0, 0, 0)', fg: 'rgb(255, 255, 255)' });
  assert.equal((await page.evaluate(() => window.probe.annotations()))[1].color, '#000000');

  // Editing: reopen shows the custom color selected; a built-in name replaces it with no leftover styling.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await page.inputValue('.tp3d-annot-swatch__input'), '#ffff00');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-swatch--custom').classList.contains('is-selected')), true);
  await page.click('.tp3d-annot-swatch[data-color="red"]');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-swatch--custom').classList.contains('is-selected')), false);
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations()[0].color === 'red');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__badge').style.getPropertyValue('--annot-color')), '', 'no leftover inline color');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__badge').dataset.color), 'red');

  // Choosing the custom swatch again brings back the color picked earlier.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.click('.tp3d-annot-swatch__input');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-swatch--custom').classList.contains('is-selected')), true);
  await page.click('.tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)');
  // A color is information only: cargo and assessment are untouched.
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------------------
// Stabilization: security, selection ownership, AutoPack/Unpack isolation, offscreen markers, stale dialogs
// ---------------------------------------------------------------------------------------------------------
const HTML_TITLE = '<img src=x onerror=window.__xss=1>';

test('user-authored titles are always literal text: a saved or imported HTML-looking title never becomes DOM or runs script', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: HTML_TITLE, description: '<b onmouseover=window.__xss=2>bold</b>', ...TOP_OF_B }]);
  const inspect = async label => {
    await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
    await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
    await page.fill('.tp3d-annot-editor__input', `${HTML_TITLE}!`);
    await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__eye');
    await page.waitForSelector('.modal');
    const dialog = await page.evaluate(() => ({
      text: document.querySelector('.modal-body').textContent,
      elements: document.querySelectorAll('.modal-body img, .modal-body script, .modal-body b, .modal-body [onerror]').length,
      xss: window.__xss === undefined ? null : window.__xss,
    }));
    assert.match(dialog.text, /<img src=x onerror=window\.__xss=1>/, `${label}: the title is shown literally`);
    assert.equal(dialog.elements, 0, `${label}: no element was created from it`);
    assert.equal(dialog.xss, null, `${label}: no script ran`);
    await dialogButton(page, 'Keep editing').click();
    await page.click('.tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)');
  };
  await inspect('saved');
  // Everywhere else the title and description are drawn: rows, cards, labels, accessible names.
  await page.waitForSelector('.tp3d-annot-card.is-selected'); // editing it selected it
  const drawn = await page.evaluate(() => ({
    injected: document.querySelectorAll('.tp3d-annot-layer img, #editor-annotation-panel img, .tp3d-annot-card b, #editor-annotation-panel b, #editor-annotation-layer img').length,
    rowName: document.querySelector('.tp3d-annot-row__name').textContent,
    cardTitle: document.querySelector('.tp3d-annot-card__title').textContent,
    xss: window.__xss === undefined ? null : window.__xss,
  }));
  assert.deepEqual([drawn.injected, drawn.rowName, drawn.cardTitle, drawn.xss], [0, HTML_TITLE, HTML_TITLE, null]);

  // An imported Load Plan carries the same text through the import gate and the same dialog.
  await page.evaluate(title => {
    const { A, M, PackLibrary, StateStore } = window.probe;
    const record = A.createCalloutRecord({ id: 'imp', anchor: M.buildSpaceAnchor({ surface: 'ground', point: { x: 300, y: 0, z: 40 } }), title, now: 5 });
    const plan = PackLibrary.planPackImport({ pack: { id: 'incoming', title: 'Incoming', loadPlanNumber: 'LP-IMPORTED', truck: { length: 636, width: 102, height: 110 }, cases: [], annotations: [record] }, bundledCases: [] });
    StateStore.set({ packLibrary: [...StateStore.get('packLibrary'), plan.pack], currentPackId: plan.pack.id }, { skipHistory: true });
  }, HTML_TITLE);
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 1);
  await inspect('imported');
  assert.deepEqual(errors, []);
});

test('selecting an annotation by marker drag or by deletion Undo always clears the cargo selection, and a held pose is respected', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'Movable', ground: [520, 10] }, { title: 'Second', ground: [200, -30] }]);
  const cargoJson = () => page.evaluate(() => window.probe.casesJson());
  const selectCargo = () => page.evaluate(() => { window.probe.InteractionManager.setSelection(['cargo-a']); });
  const isSelected = () => page.evaluate(() => document.querySelector('.tp3d-annot-row.is-selected') && document.querySelector('.tp3d-annot-row.is-selected').dataset.annotId);
  const base = await cargoJson();

  // Cargo selected, then drag an initially unselected marker onto another surface.
  await selectCargo();
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-a']);
  const firstAnchor = await page.evaluate(() => JSON.stringify(window.probe.annotations()[0].anchor));
  const start = await pinCentreOf(page, '.tp3d-annot-pin:not(.is-draft)[data-annot-id]');
  const to = await point(page, ...GROUND_A);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + to.x) / 2, (start.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(first => JSON.stringify(window.probe.annotations()[0].anchor) !== first, firstAnchor);
  assert.ok(await isSelected(), 'the dragged callout is selected');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'and the cargo is no longer selected');
  await page.focus('#viewport');
  await page.keyboard.press('ArrowRight');
  assert.equal(await cargoJson(), base, 'an arrow key cannot move cargo while a callout is selected');

  // Cargo selected, then delete and Undo an annotation.
  await selectCargo();
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__delete');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-a'], 'deleting alone leaves the cargo selection');
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.equal(await isSelected(), null, 'Undo restores the data, not the selection (selection is not part of the history)');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-a'], 'Undo leaves the cargo selection as it was');
  // Picking the restored callout from its row takes the selection from the cargo: arrow keys then cannot reach the cargo.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'selecting the callout clears the cargo selection');
  await page.focus('#viewport');
  await page.keyboard.press('ArrowRight');
  assert.equal(await cargoJson(), base, 'arrow keys do not reach cargo');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.deepEqual(await page.evaluate(() => window.probe.cargoIds().length), 2, 'Delete acts on the annotation only');
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 2);

  // Deselecting either owner leaves nothing selected.
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  assert.equal(await isSelected(), null);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), []);
  await selectCargo();
  assert.equal(await isSelected(), null, 'selecting cargo deselects the annotation');

  // A held pose is never abandoned: the Undo restores the callout but does not take the selection.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__delete');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  await page.evaluate(() => { window.__hold = window.probe.InteractionManager.hasProvisionalPose; window.probe.InteractionManager.hasProvisionalPose = () => true; });
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-a'], 'the held pose keeps its cargo selection');
  assert.equal(await isSelected(), null, 'and the callout is not selected beside it');
  await page.evaluate(() => { window.probe.InteractionManager.hasProvisionalPose = window.__hold; });
  assert.deepEqual(errors, []);
});

// The editor card's controls are reachable by an ordinary click: each one is the topmost element at its own centre.
const editorControls = page => page.evaluate(() => {
  const editor = document.querySelector('.tp3d-annot-editor');
  if (!editor || editor.hidden) return null;
  const cancelSelector = '.tp3d-annot-editor__foot .tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)';
  return Object.fromEntries([['title', '.tp3d-annot-editor__input'], ['save', '.tp3d-annot-btn--primary'], ['cancel', cancelSelector]].map(([name, selector]) => {
    const el = editor.querySelector(selector);
    if (!el) return [name, false];
    // The fields live in a scrolling body that gives up height before any button is hidden; a field the card is
    // too short to show is reached by scrolling (the wheel, or the focus a Tab brings). Save and Cancel never scroll.
    if (name === 'title') el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // `true` when the control is topmost at its centre, otherwise what covers it (so a failure names the culprit).
    return [name, hit === el || el.contains(hit) ? true : `${hit ? `${hit.tagName}.${hit.className}` : 'nothing'}`];
  }));
});
const REACHABLE = { title: true, save: true, cancel: true };
// The topmost element at five points across a control's width: a control only partly covered fails, not just one covered at its centre.
// `true` when it is topmost at every point, otherwise what covers it (so a failure names the culprit).
const unobstructed = (page, selector) => page.evaluate(sel => {
  const el = document.querySelector(sel);
  if (!el) return 'missing';
  const r = el.getBoundingClientRect();
  for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const hit = document.elementFromPoint(r.left + r.width * fraction, r.top + r.height / 2);
    if (hit !== el && !el.contains(hit)) return `${hit ? `${hit.tagName}.${hit.className}` : 'nothing'} at ${Math.round(fraction * 100)}% of ${Math.round(r.width)}px`;
  }
  return true;
}, selector);
const boxOf = (page, selector) => page.evaluate(sel => window.probe.box(sel), selector);
// Toasts are transient (about 3 s) and paint above the editor, so on a slow runner one can still be up when a reachability check
// runs. Wait for them to expire (no sleeps, nothing removed or hidden). One that never goes away is a finding: fail with its
// text and box, never pass over it. A toast that was waited out is named in the test's diagnostics.
const toastsOnScreen = page => page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(el => {
  const r = el.getBoundingClientRect();
  return { text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
}));
// How many Undo steps are available (read-only: the state, selection included, is not touched).
const historyDepth = page => page.evaluate(() => window.probe.StateStore.undoDepth());
// The one step a committed write made: Undo reverts exactly that write and Redo restores exactly its result.
const oneStepRoundTrip = async (page, label) => {
  const packs = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('packLibrary')));
  const after = await packs();
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, `${label}: one Undo step`);
  assert.notEqual(await packs(), after, `${label}: Undo reverts it`);
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, `${label}: Redo replays it`);
  assert.equal(await packs(), after, `${label}: Redo restores the result`);
};
// Undo and Redo are the shared history's keyboard commands. They run from the viewport, never from a text field.
const undoByKeyboard = async page => { await page.focus('#viewport'); await page.keyboard.press('Control+z'); };
const redoByKeyboard = async page => { await page.focus('#viewport'); await page.keyboard.press('Control+Shift+z'); };
const quietToasts = async (page, message, t) => {
  const seen = await toastsOnScreen(page);
  if (!seen.length) return;
  t.diagnostic(`${message}: waited for ${seen.length} toast(s) to expire: ${JSON.stringify(seen)}`);
  try {
    await page.waitForFunction(() => !document.querySelector('#toast-container .toast'), null, { timeout: 15000 });
  } catch {
    assert.fail(`${message}: a toast is still on screen after 15 s: ${JSON.stringify(await toastsOnScreen(page))}`);
  }
};
// Two animation frames: the overlays redraw on their own frame loops, so a state change is settled only after one.
const frames = (page, n = 2) => page.evaluate(count => new Promise(resolve => {
  const step = left => (left <= 0 ? resolve() : window.requestAnimationFrame(() => step(left - 1)));
  step(count);
}), n);
const overlaps = (a, b) => Boolean(a && b) && !(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y);

test('real AutoPack: clean while it runs or previews; on the applied committed layout annotations are visible and editable beside Results (expanded, minimized or dragged) and Results never changes', { timeout: 480000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'On cargo', ...TOP_OF_A, keepExpanded: true }, { title: 'On ground', ground: [520, 10] }, { title: 'Hidden one', ground: [300, 30] }]);
  await page.click('.tp3d-annot-row:nth-child(3) .tp3d-annot-row__eye');
  await page.waitForFunction(() => window.probe.annotations()[2].hidden === true);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2);
  // A saved measurement beside the callouts: both kinds of saved graphics follow the same committed-scene rule.
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 70), end: at(260, 80) }).ok) throw new Error('measurement seed failed');
  });
  // A segment group exists before it is first drawn (display none): only a drawn line counts.
  const segments = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(group => group.style.display !== 'none').length);
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(group => group.style.display !== 'none').length === 1);
  const records = () => page.evaluate(() => JSON.stringify(window.probe.annotations()));
  const measurementsNow = () => page.evaluate(() => JSON.stringify(window.probe.PackLibrary.getMeasurements('fixture-pack')));
  const resultsState = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('autoPackResults')));
  const cargoNow = () => page.evaluate(() => window.probe.casesJson());
  const before = await records();
  const measurementsBefore = await measurementsNow();
  // Sample every frame: a pin, card, editor, line or label drawn while an operation is running would show up here.
  await page.evaluate(() => {
    window.__samples = [];
    // After every callback of the frame has run: what is sampled is what the frame paints.
    const tick = () => window.requestAnimationFrame(() => window.setTimeout(() => {
      window.__samples.push({
        busy: window.probe.OperationLifecycle.isBusy(),
        drawn: document.querySelectorAll('.tp3d-annot-pin:not([hidden]), .tp3d-annot-card:not([hidden]), .tp3d-annot-editor:not([hidden]), .tp3d-measure-label:not([hidden])').length
          + [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(group => group.style.display !== 'none').length,
      });
      tick();
    }, 0));
    tick();
  });
  // An editor left open when AutoPack starts is closed, and what it held is not written.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Unsaved during AutoPack');
  await page.click('#btn-autopack');
  await page.waitForFunction(() => window.probe.OperationLifecycle.isBusy());
  await page.waitForFunction(() => /paused during AutoPack/.test(window.probe.hint()));
  assert.equal(await editorClosed(page), true, 'the editor cannot stay open over AutoPack');
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults') && !window.probe.OperationLifecycle.isBusy(), null, { timeout: 120000 });
  assert.equal(await records(), before, 'AutoPack never rewrote an annotation; the unsaved text was not saved');
  assert.equal(await measurementsNow(), measurementsBefore, 'nor a measurement');

  const samples = await page.evaluate(() => window.__samples);
  assert.ok(samples.some(sample => sample.busy), 'the run was observed');
  assert.equal(samples.filter(sample => sample.busy && sample.drawn > 0).length, 0, 'no marker, card, editor, line or label is ever drawn while AutoPack runs');

  // Results open over the committed layout: the saved graphics are back and nothing waits for Results to close.
  const drawable = () => page.evaluate(() => window.probe.annotations().filter((r, i) => !r.hidden && window.probe.resolved()[i].status === 'valid').length);
  const pinsNow = () => page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length);
  const graphics = () => page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not([hidden]), .tp3d-annot-card:not([hidden]), .tp3d-annot-editor:not([hidden]), .tp3d-measure-label:not([hidden])').length
    + [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(group => group.style.display !== 'none').length);
  const editingControls = () => page.evaluate(() => ({ tool: document.querySelector('.tp3d-annot-seg__btn[data-tool="callout"]').disabled, edit: document.querySelector('.tp3d-annot-row__edit').disabled }));
  const resultsBox = () => boxOf(page, '[data-role="autopack-results-panel"]');
  const toggle = page.locator('[data-focus-key="results-toggle"]');
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false, 'the committed layout is displayed');
  assert.equal(await page.evaluate(() => /Annotation editing paused/.test(document.body.textContent)), false, 'no "editing paused" message anywhere');
  assert.equal(await pinsNow(), await drawable(), 'every eligible annotation is drawn again, the individually hidden one is not');
  assert.ok(await pinsNow() >= 1);
  assert.equal(await segments(), 1, 'and so is the saved measurement');
  assert.deepEqual(await editingControls(), { tool: false, edit: false }, 'creating and editing are available with Results open');
  assert.equal(await page.evaluate(() => ![...document.querySelectorAll('.tp3d-annot-panel button')].some(b => /return|apply|preview|autopack/i.test(b.textContent))), true, 'no Annotations control touches AutoPack Results');
  if (await page.evaluate(() => window.probe.StateStore.get('autoPackResults').minimized)) await toggle.click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === false);
  assert.ok(await resultsBox(), 'Results is expanded');
  const results = await resultsState();
  const cargo = await cargoNow();
  const appliedPill = () => page.evaluate(() => Boolean(document.querySelector('.tp3d-autopack-results__current-pill')));
  const stale = () => page.evaluate(() => Boolean(document.querySelector('.tp3d-autopack-results__stale-badge')));
  const wasApplied = await appliedPill();
  assert.equal(await stale(), false);
  const untouched = async message => {
    assert.equal(await resultsState(), results, `${message}: AutoPack Results state is unchanged`);
    assert.equal(await cargoNow(), cargo, `${message}: cargo is unchanged`);
    assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false, `${message}: still the committed layout`);
    assert.equal(await appliedPill(), wasApplied, `${message}: the Applied marker is as it was`);
    assert.equal(await stale(), false, `${message}: Results did not go stale`);
    assert.equal(await measurementsNow(), measurementsBefore, `${message}: measurements are unchanged`);
  };

  // 1. Editing with Results expanded: every control is reachable and the card keeps clear of Results.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.waitForTimeout(250);
  assert.deepEqual(await editorControls(page), REACHABLE, 'Save, Cancel and the title field are reachable with Results expanded');
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await resultsBox()), false, 'the editor does not sit under Results');
  await page.fill('.tp3d-annot-editor__input', 'Edited beside Results');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations()[1].title === 'Edited beside Results');
  assert.equal(await editorClosed(page), true);
  await untouched('after an edit with Results expanded');
  assert.ok(await resultsBox(), 'Results is still showing');

  // 2. Creating a callout with Results open: the Callout tool works and the new record is saved.
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.waitForFunction(() => /place a callout/i.test(window.probe.hint()));
  const free = await freePoint(page, [GROUND_A, GROUND_B, [140, 0, 60], [200, 0, 75], [60, 0, 40]]);
  const countBefore = await count(page);
  await click(page, free);
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.waitForTimeout(250);
  assert.deepEqual(await editorControls(page), REACHABLE, 'a new callout editor is reachable with Results expanded');
  await page.fill('.tp3d-annot-editor__input', 'New beside Results');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(n => window.probe.annotations().length === n + 1, countBefore);
  await untouched('after creating a callout with Results expanded');
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]'); // disarm

  // 3. Results minimized over the committed layout: still editable.
  await toggle.click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === true);
  const minimizedResults = await resultsState();
  assert.deepEqual(await editingControls(), { tool: false, edit: false }, 'editing is available with Results minimized');
  assert.equal(await pinsNow(), await drawable());
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.waitForTimeout(250);
  assert.deepEqual(await editorControls(page), REACHABLE, 'reachable with Results minimized');
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await resultsBox()), false);
  await page.fill('.tp3d-annot-editor__input', 'Edited while minimized');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations()[0].title === 'Edited while minimized');
  assert.equal(await resultsState(), minimizedResults, 'Results stayed minimized and unchanged');
  assert.equal(await cargoNow(), cargo);
  await toggle.click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === false);
  assert.equal(await resultsState(), results, 'back to the exact expanded state');

  // 4. Results dragged onto the open editor, then elsewhere, then the viewport resized: the editor keeps clear.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  const dragResultsTo = async (cx, cy) => {
    const head = await boxOf(page, '[data-role="autopack-results-drag"]');
    const startX = head.x + 40;
    const startY = head.y + head.h / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(cx, cy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  let editorBox = await boxOf(page, '.tp3d-annot-editor');
  await dragResultsTo(editorBox.x + editorBox.w / 2, editorBox.y + 40);
  const dragged = JSON.parse(await resultsState());
  assert.ok(dragged.position, 'Results was moved by its owner');
  for (let step = 0; step < 3; step++) {
    editorBox = await boxOf(page, '.tp3d-annot-editor');
    const card = await resultsBox();
    assert.equal(overlaps(editorBox, card), false, `step ${step}: the editor is not under the dragged Results card`);
    assert.deepEqual(await editorControls(page), REACHABLE, `step ${step}: Save, Cancel and the title field stay reachable`);
    if (step === 0) await dragResultsTo(editorBox.x + 20, editorBox.y + editorBox.h - 40);
    if (step === 1) await dragResultsTo(120, 180);
  }
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(400);
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await resultsBox()), false, 'still clear after the viewport shrinks');
  assert.deepEqual(await editorControls(page), REACHABLE, 'and reachable');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(400);
  assert.deepEqual(await editorControls(page), REACHABLE, 'and reachable after it grows back');
  // The keyboard reaches Save from the title field and Enter on the title saves.
  await page.focus('.tp3d-annot-editor__input');
  let reachedSave = false;
  for (let i = 0; i < 16 && !reachedSave; i++) {
    await page.keyboard.press('Tab');
    reachedSave = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tp3d-annot-btn--primary'));
  }
  assert.equal(reachedSave, true, 'Tab reaches Save inside the editor');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-editor').hidden);
  const afterDrag = JSON.parse(await resultsState());
  assert.deepEqual({ ...afterDrag, position: null }, { ...JSON.parse(results), position: null }, 'moving Results changed only its position');
  assert.equal(await cargoNow(), cargo);
  assert.equal(await measurementsNow(), measurementsBefore);
  assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false);
  const savedSoFar = await records();
  assert.notEqual(savedSoFar, before, 'the owner edits were written');
  // Put Results back where it was for the preview checks below.
  await dragResultsTo(700, 700);

  // 5. An unapplied option is a transient layout: everything is hidden, editing is refused, and closing Results does not reveal it.
  await page.click('[aria-label="Next AutoPack option"]');
  await page.waitForFunction(() => window.probe.CaseScene.isTransientPreview());
  await page.waitForFunction(() => /paused during AutoPack preview/.test(window.probe.hint()));
  await frames(page);
  assert.equal(await graphics(), 0, 'unapplied preview: no annotation or measurement graphics');
  assert.deepEqual(await editingControls(), { tool: true, edit: true }, 'and no editing');
  await page.click('[aria-label="Close AutoPack results"]');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), true, 'the preview is not ended by closing Results (existing behavior)');
  assert.equal(await graphics(), 0, 'closing Results during an unapplied preview must not reveal graphics on transient poses');
  assert.deepEqual(await editingControls(), { tool: true, edit: true });
  // Back to the applied option: committed again, and editing needs nothing else.
  await page.click('#btn-autopack-results-reopen');
  await page.click('[aria-label="Previous AutoPack option"]');
  await page.waitForFunction(() => !window.probe.CaseScene.isTransientPreview());
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  await frames(page);
  assert.equal(await pinsNow(), await drawable(), 'committed layout again: drawn');
  assert.equal(await segments(), 1);
  assert.deepEqual(await editingControls(), { tool: false, edit: false }, 'and editable straight away, with Results still open');

  // 6. Reopening Results with an editor open keeps the editor open, clear of the card.
  await page.click('[aria-label="Close AutoPack results"]');
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').closed === true);
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.click('#btn-autopack-results-reopen');
  await page.waitForSelector('[data-role="autopack-results-panel"]');
  await page.waitForTimeout(300);
  assert.equal(await editorClosed(page), false, 'reopening Results does not close the editor');
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await resultsBox()), false);
  assert.deepEqual(await editorControls(page), REACHABLE);
  await page.click('.tp3d-annot-editor__foot .tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)'); // Cancel

  // 7. Applying an option (the owner's own action): the committed layout shows, annotations return, editing is available.
  await page.click('[aria-label="Next AutoPack option"]');
  await page.waitForFunction(() => window.probe.CaseScene.isTransientPreview());
  await frames(page);
  assert.equal(await graphics(), 0);
  await page.getByRole('button', { name: 'Apply this option' }).click();
  await page.waitForFunction(() => !window.probe.CaseScene.isTransientPreview() && !window.probe.OperationLifecycle.isBusy());
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  await frames(page);
  assert.equal(await pinsNow(), await drawable(), 'after Apply the committed layout shows its annotations again');
  assert.equal(await segments(), 1, 'and its measurement');
  assert.deepEqual(await editingControls(), { tool: false, edit: false });
  const lastEditedAfterApply = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Edited after Apply');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations()[1].title === 'Edited after Apply');
  assert.ok(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited) >= lastEditedAfterApply);
  assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.tp3d-autopack-results__current-pill'))), true, 'the applied option is still marked Applied after an annotation edit');
  assert.equal(await stale(), false, 'and an informational edit does not make Results stale');
  await page.click('[aria-label="Close AutoPack results"]');
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').closed === true);
  assert.deepEqual(await editingControls(), { tool: false, edit: false }, 'editing is unchanged once Results closes');
  assert.deepEqual(errors, []);
});

test('an editor whose marker is out of view still keeps clear of AutoPack Results, and returns to its corner when Results moves away', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // The cargo a callout sits on can be out of view (AutoPack moved it, the camera left it): no marker to place the card by.
  await seed(page, [{ title: 'Out of view', ground: [100000, 100000] }]);
  await page.click('.tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await frames(page, 4);
  const corner = await boxOf(page, '.tp3d-annot-editor');
  // A stand-in for the Results card (the editor reads the card's rectangle from the DOM, wherever it is).
  const placeCard = (left, top) => page.evaluate(([x, y]) => {
    let card = document.querySelector('[data-role="autopack-results-panel"]');
    if (!card) {
      card = document.createElement('section');
      card.setAttribute('data-role', 'autopack-results-panel');
      card.style.cssText = 'position:absolute;width:420px;height:236px;z-index:12;background:#fff;border:1px solid #888';
      document.querySelector('.canvas-wrap').appendChild(card);
    }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }, [left, top]);
  const card = () => boxOf(page, '[data-role="autopack-results-panel"]');
  await placeCard(corner.x - 300 + 20, 20); // over the editor's corner (card position is relative to .canvas-wrap)
  await frames(page, 6);
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await card()), false, 'the editor leaves the corner Results covers');
  assert.deepEqual(await editorControls(page), REACHABLE, 'and Save, Cancel and the title field are reachable');
  await placeCard(160, 300);
  await frames(page, 6);
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await card()), false, 'it follows Results to a new spot');
  assert.deepEqual(await editorControls(page), REACHABLE);
  await page.evaluate(() => document.querySelector('[data-role="autopack-results-panel"]').remove());
  await frames(page, 6);
  const back = await boxOf(page, '.tp3d-annot-editor');
  assert.deepEqual([back.x, back.y], [corner.x, corner.y], 'with Results gone the editor is back in its corner (the display-only shift left no trace)');
  assert.equal(await page.evaluate(() => window.probe.annotations()[0].title), 'Out of view', 'nothing was written');
  assert.deepEqual(errors, []);
});

test('the desktop panel stays clear of AutoPack Results wherever either is dragged (below, over its header, minimized, resized) and returns exactly when Results moves away', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, Array.from({ length: 6 }, (_, index) => ({ title: `Callout ${index + 1}`, ground: [100 + index * 30, 10] })));
  await frames(page, 4);
  const panel = () => boxOf(page, '#editor-annotation-panel');
  const card = () => boxOf(page, '[data-role="autopack-results-panel"]');
  const wrap = () => boxOf(page, '.canvas-wrap');
  const fitState = () => page.evaluate(() => {
    const style = document.getElementById('editor-annotation-panel').style;
    return { transform: style.transform, limit: style.getPropertyValue('--tp3d-annot-panel-limit'), maxHeight: style.maxHeight };
  });
  // Buttons the panel shows (inside its box and, for rows, inside the scrolled list) that something else is drawn over.
  const covered = () => page.evaluate(() => {
    const root = document.getElementById('editor-annotation-panel');
    const panelRect = root.getBoundingClientRect();
    const listRect = root.querySelector('.tp3d-annot-panel__list').getBoundingClientRect();
    return [...root.querySelectorAll('button')].filter(button => {
      const r = button.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const inPanel = x >= panelRect.left && x <= panelRect.right && y >= panelRect.top && y <= panelRect.bottom;
      const inList = !button.closest('.tp3d-annot-panel__list') || (y >= listRect.top && y <= listRect.bottom);
      return r.width > 0 && r.height > 0 && inPanel && inList;
    }).filter(button => {
      const r = button.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(top && (top === button || button.contains(top)));
    }).length;
  });
  // A stand-in for the Results card (the panel reads its rectangle from the DOM), placed in viewport coordinates.
  const placeCard = ({ x, y, w = 420, h = 236 }) => page.evaluate(([left, top, width, height]) => {
    const host = document.querySelector('.canvas-wrap');
    const origin = host.getBoundingClientRect();
    let stand = document.querySelector('[data-role="autopack-results-panel"]');
    if (!stand) {
      stand = document.createElement('section');
      stand.setAttribute('data-role', 'autopack-results-panel');
      stand.style.cssText = 'position:absolute;z-index:12;background:#fff;border:1px solid #888;box-sizing:border-box';
      host.appendChild(stand);
    }
    Object.assign(stand.style, { left: `${left - origin.left}px`, top: `${top - origin.top}px`, width: `${width}px`, height: `${height}px` });
  }, [x, y, w, h]);
  const removeCard = () => page.evaluate(() => document.querySelector('[data-role="autopack-results-panel"]')?.remove());
  const settled = async () => { await frames(page, 6); return panel(); };
  // Clear of the card, inside the space between the toolbar and the viewport controls, every shown control reachable.
  const assertClear = async (label, expectedBox = null) => {
    const shown = expectedBox || await panel();
    const stand = await card();
    const host = await wrap();
    assert.equal(overlaps(shown, stand), false, `${label}: the panel does not touch Results`);
    assert.equal(await covered(), 0, `${label}: every control it shows is reachable`);
    assert.ok(shown.x >= host.x + 9 && shown.r <= host.r - 57 && shown.y >= host.y + 63 && shown.b <= host.b - 9, `${label}: it stays between the toolbar and the viewport controls`);
  };
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').classList.contains('is-compact')), false, 'a desktop-width viewport');
  const full = await panel();
  assert.equal(await covered(), 0);
  assert.deepEqual(await fitState(), { transform: '', limit: '', maxHeight: '' }, 'no Results, no override');

  // 1. Results over the lower rows (its default place): the panel gives up height and its list scrolls.
  await placeCard({ x: full.x - 120, y: full.y + 260 });
  const below = await settled();
  assert.ok(below.h < full.h, 'the panel gives up height instead of running under Results');
  await assertClear('below');
  assert.equal(await page.evaluate(() => { const list = document.querySelector('#editor-annotation-panel .tp3d-annot-panel__list'); return list.scrollHeight > list.clientHeight; }), true, 'the rows that no longer fit scroll');
  await page.evaluate(() => { const rows = document.querySelectorAll('#editor-annotation-panel .tp3d-annot-row'); rows[rows.length - 1].scrollIntoView({ block: 'nearest' }); });
  await frames(page, 2);
  assert.equal(await covered(), 0, 'the last row is reachable once scrolled to');

  // 2. Results dragged over the panel's own header: the panel moves to the nearest clear spot.
  await placeCard({ x: full.x - 160, y: full.y - 30 });
  const aside = await settled();
  assert.notDeepEqual([aside.x, aside.y], [full.x, full.y], 'the panel moves out from under Results');
  await assertClear('over the header');

  // 3. Minimized Results (a 52 px chip) over the header: clear as well.
  await placeCard({ x: full.x - 160, y: full.y - 10, h: 52 });
  await settled();
  await assertClear('minimized chip');

  // 4. Results gone: the stylesheet's own spot, exactly, and nothing is left behind.
  await removeCard();
  const back = await settled();
  assert.deepEqual([back.x, back.y, back.h], [full.x, full.y, full.h], 'with Results gone the panel is exactly where it was');
  assert.deepEqual(await fitState(), { transform: '', limit: '', maxHeight: '' }, 'and no override is left behind');

  // 5. The owner drags the panel somewhere else; Results then covers it. The dragged place is only a preference.
  const grip = async () => page.evaluate(() => { const r = document.querySelector('#editor-annotation-panel .tp3d-annot-grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const dragBy = async (dx, dy) => {
    const from = await grip();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    return { release: () => page.mouse.up() };
  };
  const owner = await dragBy(-300, 120);
  await owner.release();
  const dropped = await settled();
  assert.ok(dropped.x < full.x - 100, 'the owner moved the panel');
  await placeCard({ x: dropped.x - 40, y: dropped.y + 40 });
  await settled();
  await assertClear('dragged panel');
  await removeCard();
  const home = await settled();
  assert.deepEqual([home.x, home.y, home.h], [dropped.x, dropped.y, dropped.h], 'with Results gone it returns to where the owner dropped it');

  // 6. Dragging a panel that is currently shown aside starts from where it is shown, and settles clear on release.
  await placeCard({ x: dropped.x - 40, y: dropped.y + 40 });
  const shown = await settled();
  const second = await dragBy(30, -30); // up: a panel shown aside near the bottom edge cannot go further down
  const during = await panel();
  assert.ok(Math.abs(during.x - (shown.x + 30)) <= 1 && Math.abs(during.y - (shown.y - 30)) <= 1, 'no jump when a drag starts from the shifted panel');
  await second.release();
  await settled();
  await assertClear('after dragging from the shifted spot');
  await removeCard();
  await settled();

  // 7. The window resizes while Results sits over the panel: it re-fits.
  const spot = await panel();
  await placeCard({ x: spot.x - 100, y: spot.y + 60 });
  await settled();
  await page.setViewportSize({ width: 1150, height: 720 });
  await frames(page, 8);
  await assertClear('after a resize');
  await removeCard();
  await frames(page, 6);
  assert.deepEqual(await fitState(), { transform: '', limit: '', maxHeight: '' });

  assert.equal(await page.evaluate(() => window.probe.annotations().length), 6, 'nothing was written');
  assert.deepEqual(errors, []);
});

test('N01: at 1100x620 with both sidebars open, 24 callouts and applied AutoPack Results, the callout editor is never under the Annotations panel: every control takes an ordinary click, the panel yields only while the editor is open, and nothing else changes', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1100, height: 620 });
  await seed(page, Array.from({ length: 24 }, (_, index) => ({ title: `Callout ${index + 1}`, ground: [20 + (index % 8) * 60, -40 + Math.floor(index / 8) * 40] })));
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 70), end: at(260, 80) }).ok) throw new Error('measurement seed failed');
  });

  // A real AutoPack, then the applied committed layout with Results expanded at its default spot.
  await page.click('#btn-autopack');
  await page.waitForFunction(() => window.probe.OperationLifecycle.isBusy());
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults') && !window.probe.OperationLifecycle.isBusy(), null, { timeout: 120000 });
  await page.waitForFunction(() => !window.probe.CaseScene.isTransientPreview());
  const toggle = page.locator('[data-focus-key="results-toggle"]');
  if (await page.evaluate(() => window.probe.StateStore.get('autoPackResults').minimized)) await toggle.click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === false);
  // The "Packed N of N cases" toast sits over the top of the panel for a few seconds: start from a quiet screen.
  const toastsGone = () => page.waitForFunction(() => !document.querySelector('#toast-container .toast'), null, { timeout: 30000 });
  await toastsGone();
  await frames(page, 3);

  const SAVE = '.tp3d-annot-editor .tp3d-annot-btn--primary';
  const CANCEL = '.tp3d-annot-editor__foot .tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)';
  const TITLE = '.tp3d-annot-editor__input';
  const PANEL = '#editor-annotation-panel';
  const resultsBox = () => boxOf(page, '[data-role="autopack-results-panel"]');
  const panelState = () => page.evaluate(sel => { const el = document.querySelector(sel); const style = getComputedStyle(el); return { visibility: style.visibility, pointer: style.pointerEvents, display: style.display }; }, PANEL);
  const sweep = async message => {
    assert.deepEqual(await editorControls(page), REACHABLE, `${message}: Title, Save and Cancel are the topmost elements at their centres`);
    assert.equal(await unobstructed(page, SAVE), true, `${message}: Save is clear along its whole width`);
    assert.equal(await unobstructed(page, CANCEL), true, `${message}: Cancel is clear along its whole width`);
    const editor = await boxOf(page, '.tp3d-annot-editor');
    assert.equal(overlaps(editor, await resultsBox()), false, `${message}: Results does not cover the editor`);
    assert.equal(overlaps(editor, await boxOf(page, '#editor-zoom-controls')), false, `${message}: nor do the viewport controls`);
    return editor;
  };
  const stable = async message => {
    const seen = await page.evaluate(() => new Promise(resolve => {
      const rects = new Set();
      let left = 6;
      const step = () => {
        const el = document.querySelector('.tp3d-annot-editor:not([hidden])');
        if (el) { const r = el.getBoundingClientRect(); rects.add([r.left, r.top, r.width, r.height].map(n => n.toFixed(1)).join(',')); }
        left -= 1;
        if (left > 0) window.requestAnimationFrame(step); else resolve([...rects]);
      };
      window.requestAnimationFrame(step);
    }));
    assert.equal(seen.length, 1, `${message}: the editor does not jitter (one rectangle over 6 frames)`);
  };
  const resultsState = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('autoPackResults')));
  const records = () => page.evaluate(() => window.probe.annotations());
  const measurementsNow = () => page.evaluate(() => JSON.stringify(window.probe.PackLibrary.getMeasurements('fixture-pack')));
  const appliedPill = () => page.evaluate(() => Boolean(document.querySelector('.tp3d-autopack-results__current-pill')));
  const results0 = await resultsState();
  const cargo0 = await page.evaluate(() => window.probe.casesJson());
  const measurements0 = await measurementsNow();
  const records0 = await records();
  const applied0 = await appliedPill();
  assert.equal(records0.length, 24);
  assert.ok((await resultsBox()).h > 150, 'Results is expanded');
  const panelHome = await boxOf(page, PANEL);
  assert.equal((await panelState()).visibility, 'visible');
  assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false, 'the applied committed layout is shown');

  // 1. Edit the first callout.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await frames(page, 3);
  const editor = await sweep('with Results expanded');
  // The scenario is the tight one: the panel and the editor genuinely share space, and the panel is the one that gives way.
  assert.equal(overlaps(await boxOf(page, PANEL), editor), true, 'precondition: there is no room for the panel beside the editor');
  assert.deepEqual(await panelState(), { visibility: 'hidden', pointer: 'none', display: 'flex' }, 'the panel yields (kept in place, not painted, not clickable) while the editor is open');
  assert.deepEqual(await boxOf(page, PANEL), panelHome, 'and it never moves or resizes');
  const titleFocused = () => page.evaluate(() => Boolean(document.activeElement && document.activeElement.classList.contains('tp3d-annot-editor__input')));
  assert.equal(await titleFocused(), true, 'keyboard focus is in the editor title');
  await stable('with Results expanded');

  // 2. The title takes a real pointer click, the edit is typed, and Save takes an ordinary click.
  await page.click(TITLE);
  assert.equal(await titleFocused(), true, 'the title field has the focus after a pointer click');
  assert.equal(await page.inputValue(TITLE), 'Callout 1', 'the title is readable');
  await page.fill(TITLE, 'Edited under pressure');
  await page.click(SAVE, { timeout: 5000 });
  await page.waitForFunction(() => window.probe.annotations()[0].title === 'Edited under pressure');
  assert.equal(await editorClosed(page), true);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('editor-annotation-panel')).visibility === 'visible');
  assert.deepEqual(await boxOf(page, PANEL), panelHome, 'with the editor closed the panel is exactly where it was');
  await toastsGone();
  assert.equal(await unobstructed(page, '.tp3d-annot-seg__btn[data-tool="callout"]'), true, 'and its controls are reachable again');
  const after = await records();
  assert.deepEqual(after.slice(1), records0.slice(1), 'no other callout changed');
  assert.deepEqual(after[0].anchor, records0[0].anchor, 'the edited callout keeps its anchor');

  // 3. Reopen, change the text and Cancel with an ordinary click: nothing is saved.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await frames(page, 3);
  await sweep('after reopening');
  await page.fill(TITLE, 'Discard me');
  await page.click(CANCEL, { timeout: 5000 });
  await page.waitForFunction(() => { const el = document.querySelector('.tp3d-annot-editor'); return !el || el.hidden; });
  assert.equal((await records())[0].title, 'Edited under pressure', 'Cancel left the saved text');

  // 4. Results minimized: the editor is still clear of the panel's takeover and Save still takes a click.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await toggle.click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === true);
  await frames(page, 3);
  await sweep('with Results minimized');
  await stable('with Results minimized');
  await toggle.click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === false);
  await frames(page, 3);
  await sweep('with Results expanded again');

  // 5. A larger window leaves room for both; a return to 1100x620 takes the panel back out of the way again, with no jitter.
  for (const [width, height] of [[1400, 900], [1100, 620]]) {
    await page.setViewportSize({ width, height });
    await frames(page, 3);
    const laidOut = await sweep(`after resizing to ${width}x${height}`);
    await stable(`at ${width}x${height}`);
    const hidden = (await panelState()).visibility === 'hidden';
    assert.equal(hidden, overlaps(await boxOf(page, PANEL), laidOut), `at ${width}x${height} the panel yields exactly when the editor needs its space`);
    if (width === 1400) assert.equal(hidden, false, 'with room for both, the panel stays visible beside the editor');
  }
  await page.click(CANCEL, { timeout: 5000 });
  await page.waitForFunction(() => { const el = document.querySelector('.tp3d-annot-editor'); return !el || el.hidden; });
  await page.setViewportSize({ width: 1100, height: 620 });
  await frames(page, 3);
  assert.deepEqual(await boxOf(page, PANEL), panelHome, 'after every transition the panel is where the owner had it');

  // 6. Nothing but the one edited title changed.
  assert.equal(await resultsState(), results0, 'AutoPack Results: run, options, selection and applied option are unchanged');
  assert.equal(await appliedPill(), applied0, 'the Applied marker is as it was');
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.tp3d-autopack-results__stale-badge'))), false, 'Results did not go stale');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargo0, 'cargo positions and quantities are unchanged');
  assert.equal(await measurementsNow(), measurements0, 'measurements are unchanged');
  assert.deepEqual((await records()).slice(1), records0.slice(1));
  assert.deepEqual(errors, []);
});

test('N01: the panel yields to an open editor only while they share space: an editor dragged over it, a panel dragged over the editor and a resize leave the panel\'s own position and every record untouched', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser); // 1400x900: room for both
  await seed(page, [{ title: 'One', ground: [100, 10] }, { title: 'Two', ground: [200, 30] }, { title: 'Three', ground: [300, -20] }]);
  const PANEL = '#editor-annotation-panel';
  const EDITOR = '.tp3d-annot-editor:not([hidden])';
  const SAVE = '.tp3d-annot-editor .tp3d-annot-btn--primary';
  const CANCEL = '.tp3d-annot-editor__foot .tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)';
  const records0 = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
  const cargo0 = await page.evaluate(() => window.probe.casesJson());
  const panelVisible = () => page.evaluate(sel => getComputedStyle(document.querySelector(sel)).visibility === 'visible', PANEL);
  const sweep = async message => {
    await quietToasts(page, message, t);
    const controls = await editorControls(page);
    // A failure names what covers the control; the toasts on screen at that moment (text and box) are added to it.
    const toasts = JSON.stringify(controls) === JSON.stringify(REACHABLE) ? '' : ` (toasts on screen: ${JSON.stringify(await toastsOnScreen(page))})`;
    assert.deepEqual(controls, REACHABLE, `${message}: Title, Save and Cancel are reachable${toasts}`);
    assert.equal(await unobstructed(page, SAVE), true, `${message}: Save is clear along its whole width`);
    assert.equal(await unobstructed(page, CANCEL), true, `${message}: Cancel is clear along its whole width`);
  };
  const dragFrom = async (grab, to) => {
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move((grab.x + to.x) / 2, (grab.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await frames(page, 3);
  };
  const centre = box => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
  // The editor drags by its header (a press on a button there does not start a drag); the heading text is the plain part of it.
  const headPoint = async () => { const b = await boxOf(page, '.tp3d-annot-editor__heading'); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  const gripPoint = async () => { const b = await boxOf(page, `${PANEL} .tp3d-annot-grip`); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  const editorOpen = async () => {
    await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
    await page.waitForSelector(EDITOR);
    await frames(page, 3);
  };
  const editorClose = async () => {
    await page.click(CANCEL, { timeout: 5000 });
    await page.waitForFunction(() => { const el = document.querySelector('.tp3d-annot-editor'); return !el || el.hidden; });
    await frames(page, 3);
  };

  // Room for both: nothing yields and nothing overlaps.
  await editorOpen();
  assert.equal(await panelVisible(), true, 'with room for both the panel stays');
  assert.equal(overlaps(await boxOf(page, EDITOR), await boxOf(page, PANEL)), false);
  // The panel's "Editing callout" hint is shown while an editor is open, so the box to hold steady is the one with the editor open.
  const panelBeside = await boxOf(page, PANEL);
  await sweep('beside the panel');

  // The owner drags the editor over the panel: the panel yields, in place, and the editor stays usable.
  await dragFrom(await headPoint(), centre(await boxOf(page, PANEL)));
  assert.equal(overlaps(await boxOf(page, EDITOR), await boxOf(page, PANEL)), true, 'precondition: the owner put the editor over the panel');
  assert.equal(await panelVisible(), false, 'the panel yields to the editor the owner placed');
  assert.deepEqual(await boxOf(page, PANEL), panelBeside, 'without moving or resizing');
  await sweep('over the panel');

  // Dragged away again, the panel is back at once and exactly where it was.
  await dragFrom(await headPoint(), { x: 400, y: 450 });
  assert.equal(overlaps(await boxOf(page, EDITOR), await boxOf(page, PANEL)), false, 'precondition: the editor is clear of the panel again');
  assert.equal(await panelVisible(), true, 'the panel returns when the editor leaves');
  assert.deepEqual(await boxOf(page, PANEL), panelBeside);
  await sweep('after moving away');

  // The owner drags the panel over the open editor and drops it there: the editor wins, the panel's dropped position is kept.
  await dragFrom(await gripPoint(), centre(await boxOf(page, EDITOR)));
  const dropped = await boxOf(page, PANEL);
  assert.notDeepEqual([dropped.x, dropped.y], [panelBeside.x, panelBeside.y], 'precondition: the panel was moved');
  assert.equal(overlaps(await boxOf(page, EDITOR), dropped), true, 'precondition: the panel was dropped over the editor');
  assert.equal(await panelVisible(), false, 'the panel yields once it is dropped over the editor');
  await sweep('with the panel dropped over it');
  await editorClose();
  assert.equal(await panelVisible(), true, 'closing the editor restores the panel');
  const restored = await boxOf(page, PANEL);
  assert.deepEqual([restored.x, restored.y], [dropped.x, dropped.y], "at the position the owner dropped it, not a position the editor chose");

  // A smaller window: the editor is placed for it and stays usable; the panel yields only if they share space.
  await page.setViewportSize({ width: 1100, height: 620 });
  await frames(page, 4);
  await editorOpen();
  await sweep('at 1100x620');
  assert.equal(await panelVisible(), !overlaps(await boxOf(page, EDITOR), await boxOf(page, PANEL)), 'the panel yields exactly when it shares space with the editor');
  await editorClose();
  assert.equal(await panelVisible(), true);

  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), records0, 'no record changed');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargo0, 'cargo is unchanged');
  assert.deepEqual(errors, []);
});

test('real Unpack: the overlay is hidden for the whole animation and returns afterwards from unchanged records', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'On cargo', ...TOP_OF_A, keepExpanded: true }, { title: 'On ground', ground: [520, 10] }]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2);
  const before = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
  await page.evaluate(() => {
    window.__samples = [];
    const tick = () => {
      window.__samples.push({
        busy: window.probe.OperationLifecycle.isBusy(),
        drawn: document.querySelectorAll('.tp3d-annot-pin:not([hidden]), .tp3d-annot-card:not([hidden])').length,
      });
      window.requestAnimationFrame(tick);
    };
    tick();
  });
  await page.click('#btn-unpack');
  await page.waitForFunction(() => window.__samples.some(sample => sample.busy));
  await page.waitForFunction(() => !window.probe.OperationLifecycle.isBusy());
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length >= 1);
  const samples = await page.evaluate(() => window.__samples);
  assert.equal(samples.filter(sample => sample.busy && sample.drawn > 0).length, 0, 'nothing drawn during Unpack');
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), before, 'records unchanged');
  assert.equal(await page.evaluate(() => /paused/.test(window.probe.hint())), false);
  assert.deepEqual(errors, []);
});

test('initially offscreen or behind-camera callouts leave no ghost marker, then appear when the camera reaches them', { timeout: 200000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const opened = await openEditor(browser);
  const { page, errors } = opened;
  await seed(page, [
    { title: 'Far east', ground: [100000, 100000] },
    { title: 'Far west', ground: [-100000, -100000] },
    { title: 'Far north', ground: [100000, -100000] },
    { title: 'Far south', ground: [-100000, 100000] },
  ]);
  await page.click('#btn-editor-annotations');
  await page.waitForTimeout(600);
  const pins = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft)')].map(el => ({
    hidden: el.hidden, label: el.getAttribute('aria-label'), transform: el.style.transform, focusable: !el.hidden && el.tabIndex >= 0,
  })));
  let state = await pins();
  assert.ok(state.length >= 1);
  assert.equal(state.filter(p => !p.hidden).length, 0, 'nothing is shown for positions that are offscreen or behind the camera');
  assert.equal(state.filter(p => p.focusable).length, 0, 'and no keyboard target is left behind');
  assert.ok(state.filter(p => !p.hidden).every(p => p.label), 'nothing visible lacks an accessible name');
  // Bring one into view.
  await page.evaluate(() => {
    const { SceneManager } = window.probe;
    const controls = SceneManager.getControls(); const cam = SceneManager.getCamera();
    const target = SceneManager.vecInchesToWorld({ x: 100000, y: 0, z: 100000 });
    controls.target.copy(target);
    cam.position.copy(target.clone().add(cam.position.clone().sub(SceneManager.vecInchesToWorld({ x: 300, y: 0, z: 0 })).setLength(3000)));
    controls.update();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft)')].some(el => !el.hidden && el.style.transform), null, { timeout: 20000 });
  state = await pins();
  const shown = state.filter(p => !p.hidden);
  assert.ok(shown.length >= 1 && shown.every(p => p.transform && p.label), 'a marker that comes into view is placed and named');
  assert.deepEqual(errors, []);
});

test('a pending Show Off confirmation only ever applies to the session that asked: Load Plan change, A to B to A and workspace replacement void it', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'Kept', ground: [520, 10] }]);
  const ask = async () => {
    await page.click('#btn-editor-annotations').catch(() => {});
    if (await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden)) await page.click('#btn-editor-annotations');
    await page.waitForSelector('.tp3d-annot-seg--show');
    await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__edit');
    await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
    await page.fill('.tp3d-annot-editor__input', 'Typed');
    await showButton(page, 'Off').click();
    await page.waitForSelector('.modal');
  };
  const answer = async () => { await dialogButton(page, 'Discard and turn off').click(); await page.waitForTimeout(300); };
  const recordsOf = id => page.evaluate(pid => JSON.stringify(window.probe.PackLibrary.getAnnotations(pid)), id);
  const drawn = () => page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length);

  // Pack A -> Pack B while pending.
  await ask();
  const packB = await page.evaluate(() => { const copy = window.probe.PackLibrary.duplicate('fixture-pack'); window.probe.StateStore.set({ currentPackId: copy.id }, { skipHistory: true }); return copy.id; });
  await page.waitForFunction(() => document.getElementById('editor-annotation-panel').hidden);
  assert.equal(await drawn(), 1, 'the new Load Plan shows its annotation');
  const storedA = await recordsOf('fixture-pack');
  await answer();
  assert.equal(await drawn(), 1, 'a stale answer does not hide the new Load Plan');
  assert.equal(await recordsOf('fixture-pack'), storedA);
  await page.click('#btn-editor-annotations');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-seg--show [aria-pressed="true"]').textContent), 'All');
  await page.click('#btn-editor-annotations');

  // A -> B -> A while pending.
  await page.evaluate(() => window.probe.StateStore.set({ currentPackId: 'fixture-pack' }, { skipHistory: true }));
  await ask();
  await page.evaluate(id => window.probe.StateStore.set({ currentPackId: id }, { skipHistory: true }), packB);
  await page.evaluate(() => window.probe.StateStore.set({ currentPackId: 'fixture-pack' }, { skipHistory: true }));
  await page.waitForFunction(() => document.getElementById('editor-annotation-panel').hidden);
  await answer();
  assert.equal(await drawn(), 1, 'coming back to the same plan does not resurrect the old answer');
  assert.equal(await recordsOf('fixture-pack'), storedA);

  // Workspace / session replacement while pending.
  await ask();
  await page.evaluate(() => window.probe.StateStore.replace(window.probe.StateStore.snapshot()));
  await page.waitForFunction(() => document.getElementById('editor-annotation-panel').hidden);
  await answer();
  assert.equal(await drawn(), 1, 'a replaced workspace is not affected');
  assert.equal(await recordsOf('fixture-pack'), storedA, 'and no record changed');

  // In the same session the answer still works.
  await ask();
  await answer();
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-seg--show [aria-pressed="true"]').textContent === 'Off');
  assert.equal(await drawn(), 0);
  assert.deepEqual(errors, []);
});

test('unreadable stored annotations are preserved, flagged and deletable; writing a callout never discards them', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const raw = [{ id: 'bad', type: 'callout', title: '' }, { id: 'arrow-1', type: 'arrow', schemaVersion: 1, a: {}, b: {} }];
  await page.evaluate(list => {
    const { StateStore } = window.probe;
    StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => ({ ...p, annotations: list })) }, { skipHistory: true });
  }, raw);
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 2);
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-panel__notice').hidden), false, 'the recovery condition is surfaced');
  assert.match(await page.locator('.tp3d-annot-panel__notice').textContent(), /couldn't be read\. The original data is kept/);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-row')].map(el => ({
    name: el.querySelector('.tp3d-annot-row__name').textContent, selectable: !el.querySelector('.tp3d-annot-row__select').disabled,
    editable: !el.querySelector('.tp3d-annot-row__edit').hidden, issue: el.querySelector('.tp3d-annot-row__issue').textContent,
  })));
  assert.deepEqual(rows.map(r => [r.name, r.selectable, r.editable]), [['Unreadable annotation', false, false], ['Unreadable annotation', false, false]]);
  assert.match(rows[0].issue, /could not be read\. The original is kept until you delete it/);

  const [added] = await seed(page, [{ title: 'New', ground: [520, 10] }]);
  const after = await page.evaluate(() => window.probe.annotations());
  assert.equal(after.length, 3);
  assert.deepEqual(after.filter(r => r.type === 'unreadable').map(r => r.original), raw, 'writing a callout keeps the originals verbatim');
  assert.equal(after.at(-1).id, added.id);
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__delete');
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.match(await page.locator('.toast-message').last().textContent(), /Unreadable annotation deleted/);
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  assert.deepEqual((await page.evaluate(() => window.probe.annotations())).filter(r => r.type === 'unreadable').map(r => r.original), raw, 'Undo restores it verbatim');
  assert.deepEqual(errors, []);
});

test('Annotations and Measurement never own the scene together, and saved callouts stay drawn while Measurement is on', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  await seed(page, [{ title: 'Drawn', ground: [520, 10] }]);
  await page.waitForSelector('.tp3d-annot-pin:not(.is-draft):not([hidden])');
  // Opening the Measurements manager leaves the Annotations panel open and the Callout tool armed: no creation starts.
  await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed')), 'true', 'both managers can be open');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false, 'opening the manager starts no measurement');
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), true, 'the Callout tool is still armed');
  // New measurement ends the armed Callout tool (no write) and arms creation.
  await page.click('#editor-measure-new');
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), false, 'and disarms the Callout tool');
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), false, 'the Annotations manager stays open');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length), 1, 'saved callouts stay drawn');
  await click(page, await point(page, ...GROUND_A));
  await page.waitForFunction(() => /second point/i.test(document.querySelector('.tp3d-measure-panel__hint').textContent));
  assert.equal(await count(page), 1, 'a click in Measurement Mode never starts a callout');
  assert.equal(await editorClosed(page), true);

  // Closing the Annotations manager does not end a measurement that is being placed.
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), true, 'the measurement tool is unaffected by closing Annotations');
  assert.deepEqual(errors, []);
});

// A drawn measurement line's centre in client px (the overlay is passive, so this is where the canvas is hit).
const lineCentre = page => page.evaluate(() => {
  const group = [...document.querySelectorAll('.tp3d-measure-svg__segment')].find(g => g.style.display !== 'none');
  if (!group) return null;
  const n = group.querySelector('.tp3d-measure-svg__line').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
  const origin = document.getElementById('editor-measure-labels').getBoundingClientRect();
  return { x: origin.left + (n[0] + n[2]) / 2, y: origin.top + (n[1] + n[3]) / 2 };
});

test('Measurements and Annotations open side by side without covering each other, in either order, at desktop, constrained and narrow sizes; the New measurement control is reachable', { timeout: 420000 }, async t => {
  const rectsOf = page => page.evaluate(() => {
    const box = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom }; };
    return { measure: box('editor-measure-panel'), annot: box('editor-annotation-panel') };
  });
  const apart = (a, b) => a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
  for (const viewport of [{ width: 1400, height: 900 }, { width: 1100, height: 620 }, { width: 640, height: 700 }]) {
    for (const order of ['measurements-first', 'annotations-first']) {
      const label = `${viewport.width}x${viewport.height} ${order}`;
      const browser = await launch();
      try {
        const { page, errors } = await openEditor(browser, viewport);
        await cameraSettled(page);
        const clickMeasure = () => page.click('#btn-editor-measure');
        const clickAnnotations = () => page.click('#btn-editor-annotations');
        if (order === 'measurements-first') { await clickMeasure(); await clickAnnotations(); } else { await clickAnnotations(); await clickMeasure(); }
        await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true' && document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
        const rects = await rectsOf(page);
        assert.equal(apart(rects.measure, rects.annot), true, `${label}: the two panels do not overlap (${JSON.stringify(rects)})`);
        // Callout, Arrow and Draw are each fully inside the Annotations panel (none clipped at its edge).
        const tools = await page.evaluate(() => {
          const panel = document.getElementById('editor-annotation-panel').getBoundingClientRect();
          return [...document.querySelectorAll('.tp3d-annot-seg--tools .tp3d-annot-seg__btn')].map(b => { const r = b.getBoundingClientRect(); return { name: b.textContent.trim(), inside: r.left >= panel.left && r.right <= panel.right, visible: r.width > 0 }; });
        });
        assert.deepEqual(tools.map(tool => [tool.name, tool.inside, tool.visible]), [['Callout', true, true], ['Arrow', true, true], ['Draw', true, true]], `${label}: all three tools fit in the panel`);
        assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false, `${label}: opening managers starts no measurement`);
        // Trusted clicks: Playwright would report an interception here if another panel covered the control.
        await page.click('#editor-measure-new');
        await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
        await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
        await page.waitForFunction(() => window.probe.AnnotationTool.isActive() && !window.probe.MeasurementTool.isActive());
        assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), false, `${label}: the Annotations manager stays open`);
        assert.deepEqual(errors, [], label);
      } finally {
        await browser.close();
      }
    }
  }
});

test('a Measurements panel dragged onto Annotations settles in a clear spot, and a resize keeps both managers reachable', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await page.click('#btn-editor-annotations');
  await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true' && document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  const rects = () => page.evaluate(() => {
    const box = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom }; };
    return { measure: box('editor-measure-panel'), annot: box('editor-annotation-panel') };
  });
  const apart = (a, b) => a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
  // Drag the Measurements grip so the panel is released over the Annotations panel's tool row.
  const grip = await page.locator('#editor-measure-panel .tp3d-measure-panel__grip').boundingBox();
  const annot = await page.locator('#editor-annotation-panel').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(annot.x + annot.width * 0.5, annot.y + 150, { steps: 12 });
  await page.mouse.up();
  await frames(page, 3);
  let r = await rects();
  assert.equal(apart(r.measure, r.annot), true, `after the drag the panels are apart (${JSON.stringify(r)})`);
  await page.click('#editor-measure-new'); // a trusted click: nothing covers the control
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.probe.MeasurementTool.isActive());

  // A narrower window: the managers re-settle without losing either one, and the Annotations tools stay clickable.
  await page.setViewportSize({ width: 1100, height: 620 });
  await frames(page, 6);
  r = await rects();
  assert.equal(apart(r.measure, r.annot), true, `after the resize the panels are apart (${JSON.stringify(r)})`);
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.isActive());
  assert.deepEqual(errors, []);
});

test('a dirty callout draft survives a passive manager and a declined switch; confirming discards it and starts the measurement without a write', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  const before = await count(page);
  await click(page, await point(page, ...GROUND_A));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Keep me');
  // Opening Measurements (a passive manager) does not discard the draft.
  await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'Keep me', 'the draft is untouched by opening the manager');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false, 'and no measurement is started');
  // New measurement asks first. Declining keeps the draft and the armed Callout tool.
  await page.click('#editor-measure-new');
  await dialogButton(page, 'Keep editing').click();
  await frames(page, 3);
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'Keep me', 'declining keeps the draft');
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), true, 'the Callout tool stays armed');
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false);
  assert.equal(await count(page), before, 'nothing was written');
  // Confirming discards the draft, ends the Callout tool and starts the measurement.
  await page.click('#editor-measure-new');
  await dialogButton(page, 'Discard and measure').click();
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), false, 'the Callout tool yields');
  assert.equal(await page.evaluate(() => !document.querySelector('.tp3d-annot-editor') || document.querySelector('.tp3d-annot-editor').hidden), true, 'the draft closed');
  assert.equal(await count(page), before, 'discarding wrote no callout');
  assert.deepEqual(errors, []);
});

test('Annotations and a saved measurement are on screen together, and only the tool that owns the scene receives input', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'On cargo', ...TOP_OF_A }, { title: 'On ground', ground: [520, 10] }]);
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 70), end: at(260, 80) }).ok) throw new Error('measurement seed failed');
  });
  const drawnPins = () => page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length);
  const drawnLines = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(g => g.style.display !== 'none').length);
  const ruler = () => page.evaluate(() => window.probe.MeasurementTool.isActive());
  const layerState = () => page.evaluate(() => {
    const layer = document.querySelector('.tp3d-annot-layer');
    return { viewOnly: layer.classList.contains('is-view-only'), inert: layer.inert };
  });
  // Saved lines are an inert view beneath the callout layer (so they never cross an expanded card or the editor); while the
  // ruler owns the scene its live lines, labels and grips are above the (then view-only) callouts.
  const stacking = () => page.evaluate(() => ({
    lines: Number(getComputedStyle(document.getElementById('editor-measure-labels')).zIndex),
    callouts: Number(getComputedStyle(document.querySelector('.tp3d-annot-layer')).zIndex),
  }));
  const savedRecords = () => page.evaluate(() => JSON.stringify([window.probe.annotations(), window.probe.PackLibrary.getMeasurements('fixture-pack'), window.probe.casesJson()]));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 2 && [...document.querySelectorAll('.tp3d-measure-svg__segment')].some(g => g.style.display !== 'none'));
  const before = await savedRecords();

  // 1. Annotations open, ruler off: both are drawn, and the passive line does not get in the callouts' way.
  assert.equal(await ruler(), false);
  assert.deepEqual([await drawnPins(), await drawnLines()], [2, 1], 'callouts and the saved line are drawn together');
  const passive = await stacking();
  assert.ok(passive.lines < passive.callouts, 'the saved line is drawn beneath the callouts');
  assert.deepEqual(await layerState(), { viewOnly: false, inert: false }, 'callouts are interactive while Annotations owns the scene');
  const centre = await lineCentre(page);
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), centre), true, 'the line never catches the pointer');
  await click(page, await pinCentreOf(page));
  await page.waitForSelector('.tp3d-annot-card.is-selected, .tp3d-annot-pin.is-selected');

  // 2. The ruler takes the scene: callouts stay drawn but cannot be touched; the ruler gets the click, Delete and Escape.
  await startMeasuring(page);
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  await frames(page);
  assert.equal(await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed')), 'true', 'the Annotations manager stays open beside the ruler; only the scene is handed over');
  assert.deepEqual([await drawnPins(), await drawnLines()], [2, 1], 'both stay drawn while the ruler is on');
  assert.deepEqual(await layerState(), { viewOnly: true, inert: true }, 'callouts are view only while the ruler owns the scene');
  const live = await stacking();
  assert.ok(live.lines > live.callouts, 'while the ruler owns the scene its lines, labels and grips are above the callouts');
  const pin = await pinCentreOf(page);
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), pin), true, 'a marker does not intercept the ruler\'s click');
  await click(page, pin);
  await page.waitForFunction(() => /second point/i.test(document.querySelector('.tp3d-measure-panel__hint').textContent));
  assert.equal(await editorClosed(page), true, 'the click started a measurement, not a callout editor');
  await page.keyboard.press('Delete');
  await frames(page, 4);
  assert.equal(await count(page), 2, 'Delete never removes a callout while the ruler owns the scene');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.probe.MeasurementTool.isActive());
  assert.equal(await count(page), 2, 'Escape ended the ruler and nothing else');
  assert.equal(await savedRecords(), before, 'neither tool wrote anything');

  // 3. Ruler off again: the line stays as a view, callouts are interactive again (no stale selection or focus trap).
  await frames(page);
  assert.deepEqual([await drawnPins(), await drawnLines()], [2, 1]);
  assert.deepEqual(await layerState(), { viewOnly: false, inert: false });
  assert.deepEqual(await stacking(), passive, 'with the ruler off the saved line goes back beneath the callouts');
  const selectedPinIndex = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])')].findIndex(pin => pin.classList.contains('is-selected')));
  assert.equal(await selectedPinIndex(), 0, 'the callout selected before the ruler is still selected (the ruler never changed it)');
  await click(page, await pinCentreOf(page, '.tp3d-annot-pin:not(.is-draft):not([hidden]):not(.is-selected)'));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin.is-selected').length === 1 && !document.querySelector('.tp3d-annot-pin:not(.is-draft):not([hidden])').classList.contains('is-selected'));
  assert.equal(await selectedPinIndex(), 1, 'a click on another marker selects that callout');
  assert.equal(await ruler(), false, 'selecting a callout never starts the ruler');

  // 4. Opening Annotations from the ruler leaves the ruler: both remain on screen and the Callout tool owns clicks.
  await startMeasuring(page);
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'false');
  await frames(page);
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), true, 'closing Annotations does not end a measurement under way');
  assert.deepEqual([await drawnPins(), await drawnLines()], [2, 1]);
  // The ruler owns the scene while its creation is armed, so the callouts are view-only even with their manager open.
  assert.deepEqual(await layerState(), { viewOnly: true, inert: true }, 'callouts are view only while the ruler owns the scene');
  if (await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'false')) await page.click('#btn-editor-annotations');
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.waitForFunction(() => /place a callout/i.test(window.probe.hint()));
  const onLine = await lineCentre(page);
  await click(page, onLine);
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await ruler(), false);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__marker')].filter(marker => marker.style.display !== 'none').length), 0, 'the line shows no ruler marker');
  assert.deepEqual(await stacking(), passive, 'while a callout is being written the saved line is drawn beneath its editor');
  await page.keyboard.press('Escape'); // closes the editor (one owner per Escape)
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-editor').hidden);
  assert.deepEqual(await stacking(), passive, 'and it stays beneath the callouts once the editor closes');
  assert.equal(await savedRecords(), before, 'a cancelled draft on top of the line wrote nothing');
  assert.deepEqual(errors, []);
});

test('a marker facing away from the camera or hidden behind cargo is hollow and dashed; a visible one is solid', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // Top of a case (faces up, in view), the underside of a case (faces down, away from the camera) and the ground
  // directly under another case (seen only through the cargo).
  await seed(page, [
    { title: 'Top', ...TOP_OF_A },
    { title: 'Underside', cargo: 'cargo-b', local: { x: 10, y: -12, z: 10 } },
    { title: 'Under the case', ground: [300, 20] },
    { title: 'Clear ground', ground: [520, 10] },
  ]);
  // A marker is measured before it is first drawn: there is no solid-then-hollow flash to wait out.
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 4);
  const classes = await page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-pin:not(.is-draft)')].map(el => ({ title: el.title, hollow: el.classList.contains('is-hollow') })));
  const byTitle = Object.fromEntries(classes.map(c => [c.title, c.hollow]));
  assert.equal(byTitle.Top, false, 'faces the camera');
  assert.equal(byTitle['Clear ground'], false, 'nothing in front of it');
  assert.equal(byTitle.Underside, true, 'faces away from the camera');
  assert.equal(byTitle['Under the case'], true, 'seen only through the cargo that stands on it');
  assert.deepEqual(errors, []);
});

test('dragging a marker onto another surface re-attaches that callout only: Escape and a refused drop change nothing, cargo never moves', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const [saved] = await seed(page, [{ title: 'Marker', ground: [520, 10], offset: { dx: 60, dy: -50 } }]);
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));
  const start = await pinCentreOf(page);
  const drag = async (to, { escape = false } = {}) => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move((start.x + to.x) / 2, (start.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    if (escape) await page.keyboard.press('Escape');
    await page.mouse.up();
  };

  // Escape mid-drag, and a drop that is refused: the original anchor stays and nothing is written.
  await drag(await point(page, ...GROUND_A), { escape: true });
  assert.deepEqual((await page.evaluate(() => window.probe.annotations()))[0].anchor, saved.anchor, 'Escape restores the marker');
  // A drop on cargo is refused while the Editor holds a scene-only pose (the mesh is not where the plan says).
  await page.evaluate(() => { window.__hold = window.probe.InteractionManager.hasProvisionalPose; window.probe.InteractionManager.hasProvisionalPose = () => true; });
  await drag(await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  assert.deepEqual((await page.evaluate(() => window.probe.annotations()))[0].anchor, saved.anchor, 'a refused drop leaves it where it was');
  assert.match(await page.evaluate(() => window.probe.hint()), /held case/i, 'and says why');
  await page.evaluate(() => { window.probe.InteractionManager.hasProvisionalPose = window.__hold; });
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), before.edited, 'neither wrote anything');
  assert.deepEqual(await pinCentreOf(page), start, 'the marker is back where it was');

  // A drop on cargo re-attaches to that instance; the card offset is kept, so the card travels with the marker.
  await drag(await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.annotations()[0].anchor.kind === 'cargo');
  const [moved] = await page.evaluate(() => window.probe.annotations());
  assert.equal(moved.anchor.instanceId, 'cargo-b');
  assert.deepEqual([moved.id, moved.title, moved.offset, moved.createdAt], [saved.id, 'Marker', { dx: 60, dy: -50 }, saved.createdAt]);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is never moved');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'and never selected');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'a marker drag never orbits');
  await oneStepRoundTrip(page, 'the re-attach');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-card.is-selected').length), 1, 'the callout stays selected');
  assert.deepEqual(errors, []);
});

test('the marker of a new callout can be moved before saving, so the card never attaches to the wrong place', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  await click(page, await point(page, ...GROUND_A));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.match(await page.locator('.tp3d-annot-editor__target-text').textContent(), /Attached to Ground/);
  // Clicking elsewhere with the tool armed moves the temporary marker.
  await page.fill('.tp3d-annot-editor__input', 'Moved before saving');
  const first = await pinCentreOf(page, '.tp3d-annot-pin.is-draft');
  await click(page, await freePoint(page, [[520, 0, 10], [440, 0, -40], [200, 0, -60]]));
  await page.waitForFunction(() => /Marker moved/.test(window.probe.hint()));
  const second = await pinCentreOf(page, '.tp3d-annot-pin.is-draft');
  assert.ok(Math.abs(second.x - first.x) + Math.abs(second.y - first.y) > 20, 'the temporary marker moved');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'Moved before saving', 'typed text survives moving the marker');
  assert.equal(await count(page), 0, 'nothing is stored until Save');
  // Dragging the temporary marker moves it too: onto cargo, which renames what it is attached to.
  const to = await freePoint(page, [[300, 16, 20], [300, 24, 20], [300, 8, 20]].map(([x, , z]) => [x, 0, z]).concat([[60, 0, 80]]));
  const target = await page.evaluate(() => window.probe.cargoPoint('cargo-b'));
  const dropOn = (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), target)) ? target : to;
  await page.mouse.move(second.x, second.y);
  await page.mouse.down();
  await page.mouse.move(dropOn.x, dropOn.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => /Marker moved/.test(window.probe.hint()) && !document.querySelector('.tp3d-annot-pin.is-draft').classList.contains('is-dragging'));
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'cargo is never selected by it');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const [saved] = await page.evaluate(() => window.probe.annotations());
  assert.equal(saved.title, 'Moved before saving');
  assert.ok(['cargo', 'space'].includes(saved.anchor.kind), 'attached where the marker was last dropped');
  if (saved.anchor.kind === 'cargo') assert.equal(saved.anchor.instanceId, 'cargo-b');
  assert.deepEqual(errors, []);
});

test('the panel and its callouts work from the keyboard, and a callout is named for assistive technology', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'UNLOAD FIRST', ground: [520, 10] }]);
  await page.waitForSelector('.tp3d-annot-pin:not(.is-draft):not([hidden])');
  const label = await page.getAttribute('.tp3d-annot-pin:not(.is-draft)', 'aria-label');
  assert.equal(label, 'Callout 1: UNLOAD FIRST');
  await page.focus('.tp3d-annot-pin:not(.is-draft)');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  assert.equal(await page.getAttribute('.tp3d-annot-pin:not(.is-draft)', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.tp3d-annot-card.is-selected', 'aria-label'), 'Callout 1: UNLOAD FIRST');
  // Edit from the card with the keyboard, Enter in the title saves.
  await page.focus('.tp3d-annot-card.is-selected [data-act="edit"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tp3d-annot-editor__input')), true);
  await page.keyboard.press('End');
  await page.keyboard.type(' — REAR');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.annotations()[0].title === 'UNLOAD FIRST — REAR');
  assert.equal(await editorClosed(page), true);
  // The tool buttons and display modes are real buttons with pressed state.
  await page.focus('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.keyboard.press('Enter');
  assert.equal(await page.getAttribute('.tp3d-annot-seg__btn[data-tool="callout"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.tp3d-annot-seg__btn[data-tool="draw"]', 'aria-label'), null, 'Draw is a real, named tool now');
  assert.equal(await page.getAttribute('.tp3d-annot-seg__btn[data-tool="arrow"]', 'aria-label'), null, 'Arrow is a real, named tool now');
  assert.deepEqual(errors, []);
});

test('cargo Undo/Redo never erases or resurrects annotations, and a cargo Undo during an unfinished marker drag cancels only the drag', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const [saved] = await seed(page, [{ title: 'Stays', ground: [520, 10] }]);
  const annotationEditedAt = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  await page.evaluate(() => {
    const inst = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-b');
    window.probe.PackLibrary.updateInstance('fixture-pack', 'cargo-b', { transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x + 60 } } });
  });
  await page.focus('#viewport');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.probe.casesJson().includes('"x":300'));
  assert.equal(await count(page), 1, 'Undo keeps the annotation');
  assert.ok(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited) >= annotationEditedAt, 'and never rolls lastEdited back past the annotation edit');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => window.probe.casesJson().includes('"x":360'));
  assert.equal(await count(page), 1, 'Redo keeps it too');

  // Ctrl+Z mid-drag cancels the drag and leaves cargo history alone.
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-pin.is-selected');
  const start = await pinCentreOf(page);
  const to = await point(page, ...GROUND_A);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.keyboard.press('Control+z');
  await page.mouse.up();
  assert.deepEqual((await page.evaluate(() => window.probe.annotations()))[0].anchor, saved.anchor, 'the drag was cancelled');
  assert.ok((await page.evaluate(() => window.probe.casesJson())).includes('"x":360'), 'cargo history was not touched');
  assert.deepEqual(errors, []);
});

test('leaving the Load Plan or swapping the workspace closes the panel and drops every unsaved gesture', { timeout: 150000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openArmed(browser);
  await seed(page, [{ title: 'Kept', ground: [520, 10] }]);
  await click(page, await point(page, ...GROUND_A));
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Unsaved');
  // A workspace swap replaces the whole state: nothing from the old one may linger.
  await page.evaluate(() => window.probe.StateStore.replace(window.probe.StateStore.snapshot()));
  await page.waitForFunction(() => document.getElementById('editor-annotation-panel').hidden);
  assert.equal(await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed')), 'false');
  assert.equal(await editorClosed(page), true, 'the unsaved card is gone');
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), false);
  assert.equal(await count(page), 1, 'the saved callout stays; the unsaved one wrote nothing');
  assert.equal(await page.evaluate(() => document.getElementById('viewport').style.cursor || getComputedStyle(document.querySelector('#viewport canvas')).cursor !== 'crosshair'), true);
  // Reopening shows it again.
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 1);
  assert.deepEqual(errors, []);
});

test('on a narrow viewport with AutoPack Results open the editor sheet stays clear of Results, opens on its title and keeps Save and Cancel reachable', { timeout: 480000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'UNLOAD FIRST', ground: [520, 10] }]);
  await page.click('#btn-autopack');
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults') && !window.probe.OperationLifecycle.isBusy(), null, { timeout: 120000 });
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 30000 }); // the "Packed N cases" toast is transient and not part of this layout
  if (await page.evaluate(() => window.probe.StateStore.get('autoPackResults').minimized)) await page.locator('[data-focus-key="results-toggle"]').click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === false);
  // A laptop-sized window with both side panels open leaves a canvas narrower than 500px: the editor becomes a sheet.
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-layer').classList.contains('is-compact'));
  const resultsState = () => page.evaluate(() => JSON.stringify(window.probe.StateStore.get('autoPackResults')));
  const resultsBox = () => boxOf(page, '[data-role="autopack-results-panel"]');
  const cargo = await page.evaluate(() => window.probe.casesJson());
  const results = await resultsState();
  assert.equal(overlaps(await boxOf(page, '#editor-annotation-panel'), await resultsBox()), false, 'the compact panel rides clear of Results, so its rows and tools stay clickable');
  // The first thing the owner sees is the title field: not scrolled out of a short card.
  const titleInView = () => page.evaluate(() => {
    const input = document.querySelector('.tp3d-annot-editor__input').getBoundingClientRect();
    const body = document.querySelector('.tp3d-annot-editor__body').getBoundingClientRect();
    return input.top >= body.top - 0.5 && input.bottom <= body.bottom + 0.5;
  });
  const openEditorFromRow = async () => {
    await page.click('.tp3d-annot-row__edit'); // an ordinary click: it fails if Results covers the row
    await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
    await frames(page, 4);
  };
  const checkSheet = async label => {
    const editor = await boxOf(page, '.tp3d-annot-editor');
    assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-editor').classList.contains('is-sheet')), true, `${label}: the sheet`);
    assert.equal(overlaps(editor, await resultsBox()), false, `${label}: the sheet does not sit under Results`);
    assert.deepEqual(await editorControls(page), REACHABLE, `${label}: Save, Cancel and the title field are reachable`);
    assert.equal(await titleInView(), true, `${label}: the title field is in view when the sheet opens`);
    assert.equal(await resultsState(), results, `${label}: Results is exactly as it was`);
    assert.equal(await page.evaluate(() => window.probe.casesJson()), cargo, `${label}: cargo is unchanged`);
  };
  const dismiss = async () => {
    await page.click('.tp3d-annot-editor__foot .tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)');
    await page.waitForFunction(() => document.querySelector('.tp3d-annot-editor').hidden);
  };

  // Results expanded, wherever it sits: bottom (default), then dragged to the top.
  await openEditorFromRow();
  await checkSheet('Results at the bottom');
  await dismiss();
  const head = await boxOf(page, '[data-role="autopack-results-drag"]');
  await page.mouse.move(head.x + 40, head.y + head.h / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 40, 150, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = JSON.parse(await resultsState());
  assert.ok(afterDrag.position, 'Results was moved by its owner');
  const movedResults = await resultsState();
  await openEditorFromRow();
  const editor = await boxOf(page, '.tp3d-annot-editor');
  assert.equal(overlaps(editor, await resultsBox()), false, 'Results at the top: the sheet is clear');
  assert.deepEqual(await editorControls(page), REACHABLE);
  assert.equal(await titleInView(), true);
  assert.equal(await resultsState(), movedResults);

  // Moving Results while the editor is open: the sheet follows it out of the way.
  const head2 = await boxOf(page, '[data-role="autopack-results-drag"]');
  await page.mouse.move(head2.x + 40, head2.y + head2.h / 2);
  await page.mouse.down();
  await page.mouse.move(head2.x + 40, 430, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await resultsBox()), false, 'the open sheet keeps clear of Results moved over it');
  assert.deepEqual(await editorControls(page), REACHABLE);
  await dismiss();

  // Minimized: the chip is the obstacle.
  await page.locator('[data-focus-key="results-toggle"]').click();
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults').minimized === true);
  await openEditorFromRow();
  assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await resultsBox()), false, 'minimized Results: the sheet is clear');
  assert.deepEqual(await editorControls(page), REACHABLE);
  assert.equal(await titleInView(), true);
  await dismiss();
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargo, 'cargo never changed');
  assert.deepEqual(errors, []);
});

test('on a narrow viewport the panel is a bottom sheet clear of the controls and the status button, cards are narrower and the editor is a sheet', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 390, height: 800 });
  await seed(page, [{ title: 'UNLOAD FIRST', description: 'Place near the rear doors.', ground: [520, 10] }]);
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  const geometry = await page.evaluate(() => {
    const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width }; };
    return { wrap: { l: wrap.left, t: wrap.top, r: wrap.right, b: wrap.bottom }, panel: rect('#editor-annotation-panel'), controls: rect('#editor-zoom-controls'), card: rect('.tp3d-annot-card.is-selected'), compact: document.getElementById('editor-annotation-panel').classList.contains('is-compact') };
  });
  assert.equal(geometry.compact, true);
  const inside = r => r.l >= geometry.wrap.l - 0.5 && r.r <= geometry.wrap.r + 0.5 && r.t >= geometry.wrap.t - 0.5 && r.b <= geometry.wrap.b + 0.5;
  assert.ok(inside(geometry.panel), 'the panel stays inside the viewport');
  assert.ok(geometry.panel.r <= geometry.controls.l + 0.5, 'and leaves the right-hand controls reachable');
  assert.ok(geometry.panel.b <= geometry.wrap.b - 46, 'and sits above the Load plan status button (14px inset, 32px high)');
  assert.ok(inside(geometry.card), 'the card is clamped inside the viewport');
  assert.equal(Math.round(geometry.card.w), 176, 'cards use the narrower width');

  // The editor replaces the panel as a bottom sheet.
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  const aim = await point(page, 300, 0, 10);
  await click(page, aim);
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  const sheet = await page.evaluate(() => {
    const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
    const r = document.querySelector('.tp3d-annot-editor').getBoundingClientRect();
    return { sheet: document.querySelector('.tp3d-annot-editor').classList.contains('is-sheet'), inside: r.left >= wrap.left && r.right <= document.getElementById('editor-zoom-controls').getBoundingClientRect().left + 0.5 && r.bottom <= wrap.bottom - 46 && r.top >= wrap.top, panelShown: getComputedStyle(document.getElementById('editor-annotation-panel')).display !== 'none' };
  });
  assert.deepEqual(sheet, { sheet: true, inside: true, panelShown: false });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('editor-annotation-panel')).display !== 'none');
  assert.deepEqual(errors, []);
});

// ============================================================================
// Annotations V1B.1: directional arrows. A shaft and a solid head drawn as SVG in the same overlay (never a scene
// object), placed with two clicks (tail, then head), moved one end at a time by two end handles.
// ============================================================================
const armArrow = async page => {
  await page.click('.tp3d-annot-seg__btn[data-tool="arrow"]');
  await page.waitForFunction(() => /arrow tail/i.test(window.probe.hint()));
};
const tailShown = page => page.evaluate(() => {
  const dot = document.querySelector('.tp3d-annot-arrow__tail');
  return Boolean(dot) && dot.style.display !== 'none';
});
// The camera keeps easing for a moment after a drag: wait until it has been still for several frames, so the same
// pixel picks the same scene point again.
const cameraSettled = page => page.evaluate(() => new Promise(resolve => {
  let last = window.probe.camera();
  let still = 0;
  const step = () => {
    const now = window.probe.camera();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 12) resolve();
    else window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}));
// A drag that orbits the camera: press, move well past the click threshold, release, then let the camera settle.
const orbit = async (page, from, dx = 40, dy = 0) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
  await cameraSettled(page);
};
// Only arrows that actually have a shape: a hidden or unresolved arrow keeps an empty group.
const arrowGraphics = page => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow:not(.is-preview)')]
  .filter(group => group.querySelector('.tp3d-annot-arrow__shaft').getAttribute('d'))
  .map(group => ({
    id: group.dataset.annotId,
    occluded: group.classList.contains('is-occluded'),
    selected: group.classList.contains('is-selected'),
    head: Boolean(group.querySelector('.tp3d-annot-arrow__head').getAttribute('d')),
  })));
// An arrow saved through the real writer (not the creation UI). Each end is `[x, z]` on the ground or `{ cargo, local }`.
const seedArrow = (page, from, to, extra = {}) => page.evaluate(({ from, to, extra }) => {
  const { M, PackLibrary, CaseLibrary } = window.probe;
  const pack = PackLibrary.getById('fixture-pack');
  const anchorOf = spec => {
    if (Array.isArray(spec)) return M.buildSpaceAnchor({ surface: 'ground', point: { x: spec[0], y: 0, z: spec[1] } });
    const inst = pack.cases.find(c => c.id === spec.cargo);
    return M.buildCargoAnchor({ instanceId: inst.id, local: spec.local, caseData: CaseLibrary.getById(inst.caseId) });
  };
  const outcome = PackLibrary.addArrow('fixture-pack', { start: anchorOf(from), end: anchorOf(to), ...extra });
  if (!outcome.ok) throw new Error(`arrow seed failed: ${outcome.reason}`);
  return outcome.annotation;
}, { from, to, extra });
const gripsShown = page => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-handle:not([hidden])')].map(el => ({ end: el.dataset.end, label: el.getAttribute('aria-label'), tag: el.tagName })));
const gripCentre = (page, end) => page.evaluate(which => {
  const el = document.querySelector(`.tp3d-annot-handle[data-end="${which}"]:not([hidden])`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, end);
const rowOf = (page, index) => page.evaluate(i => {
  const el = document.querySelectorAll('.tp3d-annot-row')[i];
  const ends = [...el.querySelectorAll('.tp3d-annot-row__end')].filter(line => !line.hidden).map(line => ({ text: line.firstChild.textContent, button: line.querySelector('button').textContent }));
  return {
    name: el.querySelector('.tp3d-annot-row__name').textContent, sub: el.querySelector('.tp3d-annot-row__sub').textContent,
    selected: el.classList.contains('is-selected'), flagged: el.querySelector('.tp3d-annot-row__badge').classList.contains('is-flagged'),
    issueShown: !el.querySelector('.tp3d-annot-row__issue').hidden, ends, selectDisabled: el.querySelector('.tp3d-annot-row__select').disabled,
  };
}, index);
const endButton = (id, end) => `.tp3d-annot-row[data-annot-id="${id}"] .tp3d-annot-row__end button[data-end="${end}"]`;
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

test('creating an arrow: two clicks save exactly one record, orbiting never creates or cancels one, a head too close writes nothing, and the tool stays armed', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited }));
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-seg--tools .tp3d-annot-seg__btn')].map(b => b.disabled)), [false, false, false], 'Callout, Arrow and Draw are all available');
  await armArrow(page);
  assert.equal(await page.getAttribute('.tp3d-annot-seg__btn[data-tool="arrow"]', 'aria-pressed'), 'true');
  assert.equal(await page.locator('.tp3d-annot-panel__arrow-title').textContent(), 'New Arrow — Defaults', 'the look controls are for the next arrow while none is selected');

  // A drag that orbits the camera is not a click: it places nothing.
  const cameraBefore = await page.evaluate(() => window.probe.camera());
  await orbit(page, await freePoint(page, [GROUND_A, GROUND_B]));
  assert.notEqual(await page.evaluate(() => window.probe.camera()), cameraBefore, 'the camera orbited');
  assert.equal(await tailShown(page), false, 'a camera drag never places a tail');
  assert.equal(await count(page), 0);
  assert.match(await page.evaluate(() => window.probe.hint()), /arrow tail/i);

  // First click: the tail exists on screen only.
  const tailAt = await freePoint(page, [GROUND_A]);
  await click(page, tailAt);
  await page.waitForFunction(() => /arrow should point/i.test(window.probe.hint()));
  assert.equal(await tailShown(page), true, 'a dot marks the tail');
  assert.equal(await count(page), 0, 'nothing is stored after the first click');
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), before.edited);

  // A head on top of the tail (the same pixel) is refused: nothing is written and the tail stays for another try.
  await click(page, tailAt);
  await page.waitForFunction(() => /too close to the tail/i.test(window.probe.hint()));
  assert.equal(await count(page), 0, 'no partial or zero-length record');
  assert.equal(await tailShown(page), true);

  // Orbiting between the clicks keeps the pending tail on the scene point it was placed on.
  await orbit(page, await freePoint(page, [GROUND_B]));
  assert.equal(await tailShown(page), true, 'a camera drag never cancels the pending arrow');
  assert.equal(await count(page), 0);
  assert.match(await page.evaluate(() => window.probe.hint()), /arrow should point|too close/i);

  // The head: exactly one record, the tool stays armed, the new arrow is selected and drawn.
  await click(page, await freePoint(page, [GROUND_B]));
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const [saved] = await page.evaluate(() => window.probe.annotations());
  assert.deepEqual([saved.type, saved.schemaVersion, saved.color, saved.width, saved.hidden], ['arrow', 1, 'ink', 'regular', false]);
  assert.deepEqual([saved.start.kind, saved.start.surface, saved.end.kind, saved.end.surface], ['space', 'ground', 'space', 'ground']);
  assert.ok(near(saved.start.position.x, GROUND_A[0], 1.5) && near(saved.start.position.z, GROUND_A[2], 1.5), 'the tail is where the first click was');
  assert.ok(near(saved.end.position.x, GROUND_B[0], 1.5) && near(saved.end.position.z, GROUND_B[2], 1.5), 'the head is where the second click was');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is never moved');
  assert.ok(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited) > before.edited, 'lastEdited is updated');
  await oneStepRoundTrip(page, 'the arrow creation');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'cargo selection is untouched');
  assert.equal(await tailShown(page), false);
  assert.equal(await page.getAttribute('.tp3d-annot-seg__btn[data-tool="arrow"]', 'aria-pressed'), 'true', 'the tool stays armed for the next arrow');
  assert.match(await page.evaluate(() => window.probe.hint()), /Arrow saved/);
  // The saved arrow is drawn but not selected: the next click starts another one, and nothing offers its handles yet.
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 1);
  assert.deepEqual((await arrowGraphics(page)).map(({ occluded, selected, head }) => ({ occluded, selected, head })), [{ occluded: false, selected: false, head: true }]);
  assert.deepEqual(await gripsShown(page), [], 'no end handles while a tool owns the scene');
  const row = await rowOf(page, 0);
  assert.deepEqual([row.name, row.sub, row.selected, row.flagged], ['Arrow 1', 'Ground → Ground', false, false], 'the row is named, numbered and says where it is attached');
  assert.equal(await page.locator('.tp3d-annot-panel__count').textContent(), '1');
  assert.equal(await page.locator('.tp3d-annot-panel__arrow-title').textContent(), 'New Arrow — Defaults', 'with no arrow selected the look controls are for the next arrows');
  const stored = () => page.evaluate(() => JSON.stringify(window.probe.annotations()));
  const edited = () => page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  const placeArrow = async (from, to) => {
    const count = await page.evaluate(() => window.probe.annotations().length);
    // Arming ends the grips of a picked arrow on the next render: wait until the start point is clear of them.
    const start = await point(page, ...from);
    await page.waitForFunction(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), start);
    await click(page, await freePoint(page, [from]));
    await page.waitForFunction(() => /arrow should point/i.test(window.probe.hint()));
    await click(page, await freePoint(page, [to]));
    await page.waitForFunction(n => window.probe.annotations().length === n + 1, count);
    assert.equal(await page.evaluate(() => window.probe.annotations().length), count + 1, 'exactly one record per arrow');
    return page.evaluate(() => window.probe.annotations().at(-1));
  };
  const selectedRows = () => page.evaluate(() => document.querySelectorAll('.tp3d-annot-row.is-selected').length);

  // With none selected, the look sets what the next arrows start with: it writes nothing, and every new arrow gets it.
  const beforeDefaults = { json: await stored(), edited: await edited() };
  await page.click('.tp3d-annot-panel__arrow .tp3d-annot-swatch[data-color="red"]');
  await page.click('.tp3d-annot-seg--width .tp3d-annot-seg__btn[data-width="bold"]');
  await frames(page, 3);
  assert.deepEqual({ json: await stored(), edited: await edited() }, beforeDefaults, 'choosing defaults writes nothing');
  const second = await placeArrow(GROUND_B, GROUND_A);
  assert.deepEqual([second.color, second.width], ['red', 'bold'], 'the next arrow starts with the defaults just chosen');
  assert.ok(near(second.start.position.x, GROUND_B[0], 1.5) && near(second.end.position.x, GROUND_A[0], 1.5), 'tail first, head second');
  assert.deepEqual((await page.evaluate(() => window.probe.annotations()))[0], saved, 'the first arrow is untouched');
  assert.deepEqual([await selectedRows(), (await rowOf(page, 1)).name, await page.getAttribute('.tp3d-annot-seg__btn[data-tool="arrow"]', 'aria-pressed')], [0, 'Arrow 2', 'true'], 'saving again selects nothing and keeps the tool armed');
  const third = await placeArrow(GROUND_A, GROUND_B);
  assert.deepEqual([third.color, third.width], ['red', 'bold'], 'repeated creation keeps the defaults');

  // A selected arrow is edited on its own: one record changes, the others and the defaults do not.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-panel__arrow-title').textContent === 'Arrow: Arrow 1 — Selected');
  const beforeEdit = await page.evaluate(() => window.probe.annotations());
  await page.click('.tp3d-annot-panel__arrow .tp3d-annot-swatch[data-color="blue"]');
  await page.click('.tp3d-annot-seg--width .tp3d-annot-seg__btn[data-width="thin"]');
  await page.waitForFunction(() => window.probe.annotations()[0].color === 'blue' && window.probe.annotations()[0].width === 'thin');
  const afterEdit = await page.evaluate(() => window.probe.annotations());
  assert.deepEqual([afterEdit[0].id, afterEdit[0].start, afterEdit[0].end, afterEdit[0].createdAt], [saved.id, saved.start, saved.end, saved.createdAt], 'only the look changed; the ends are untouched');
  assert.deepEqual(afterEdit.slice(1), beforeEdit.slice(1), 'no other arrow is written');
  assert.equal(afterEdit.length, 3, 'editing never adds or removes a record');
  // Picking an arrow ended the Arrow tool: creation resumes only by arming it again.
  await armArrow(page);
  const fourth = await placeArrow(GROUND_B, GROUND_A);
  assert.deepEqual([fourth.color, fourth.width], ['red', 'bold'], 'editing an arrow did not change what new arrows start with');
  assert.equal(await selectedRows(), 0, 'starting an arrow ends the selection');
  assert.deepEqual((await page.evaluate(() => window.probe.annotations())).slice(0, 3).map(({ color, width }) => [color, width]), [['blue', 'thin'], ['red', 'bold'], ['red', 'bold']]);

  // A custom color is one more color: stored as #rrggbb, drawn with it, and again only for the arrow being edited.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-panel__arrow-title').textContent === 'Arrow: Arrow 2 — Selected');
  await page.fill('.tp3d-annot-panel__arrow .tp3d-annot-swatch__input', '#12ab34');
  await page.waitForFunction(() => window.probe.annotations()[1].color === '#12ab34');
  await frames(page, 3);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tp3d-annot-arrow.is-selected .tp3d-annot-arrow__shaft')).stroke), 'rgb(18, 171, 52)');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tp3d-annot-arrow.is-selected .tp3d-annot-arrow__shaft')).strokeWidth), '5px', 'bold is a constant 5 screen pixels');
  await armArrow(page);
  const fifth = await placeArrow(GROUND_A, GROUND_B);
  assert.deepEqual([fifth.color, fifth.width], ['red', 'bold'], 'a custom color on one arrow is not a new default');
  assert.deepEqual(errors, []);
});

test('an arrow joins two surfaces, follows cargo that moves, and its end handles move one end at a time: Escape and a refused drop change nothing', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const saved = await seedArrow(page, TOP_OF_A, GROUND_B.length ? [GROUND_B[0], GROUND_B[2]] : [0, 0]);
  assert.equal(saved.start.kind, 'cargo');
  assert.equal(saved.start.instanceId, 'cargo-a', 'the instance ID, never the Case ID');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length >= 1);
  assert.match((await rowOf(page, 0)).sub, /^.+ → Ground$/, 'the row says where each end is attached');

  // The tail sits on the picked point of the cargo's top, and follows the cargo when it moves; the record never changes.
  const layerOrigin = () => page.evaluate(() => { const r = document.getElementById('editor-annotation-layer').getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const tailOnScreen = () => page.evaluate(() => { const n = document.querySelector('.tp3d-annot-arrow:not(.is-preview) .tp3d-annot-arrow__shaft').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number); return { x: n[0], y: n[1] }; });
  const expectedTail = async () => {
    const at = await page.evaluate(() => { const [r] = window.probe.resolved(); return window.probe.screenOf(r.start.x, r.start.y, r.start.z); });
    const origin = await layerOrigin();
    return { x: at.x - origin.x, y: at.y - origin.y };
  };
  const first = await tailOnScreen();
  const expected = await expectedTail();
  assert.ok(near(first.x, expected.x, 2.5) && near(first.y, expected.y, 2.5), 'the tail is on the picked surface point');
  const record = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  await page.evaluate(() => {
    const inst = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
    window.probe.PackLibrary.updateInstance('fixture-pack', 'cargo-a', {
      transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x + 120, z: inst.transform.position.z + 20 } },
    });
  });
  await page.waitForFunction(old => {
    const n = document.querySelector('.tp3d-annot-arrow:not(.is-preview) .tp3d-annot-arrow__shaft').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    return Math.abs(n[0] - old.x) > 20;
  }, first);
  const moved = await tailOnScreen();
  const expectedMoved = await expectedTail();
  assert.ok(near(moved.x, expectedMoved.x, 2.5) && near(moved.y, expectedMoved.y, 2.5), 'after the cargo moved the tail is on the same spot of the cargo');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), record, 'the stored arrow is unchanged by cargo movement');

  // Select it from the list: two named, focusable end handles appear and the cargo stays unselected.
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length === 2);
  assert.deepEqual(await gripsShown(page), [
    { end: 'start', label: 'Arrow 1 tail handle. Drag it, or press Enter and click the scene.', tag: 'BUTTON' },
    { end: 'end', label: 'Arrow 1 head handle. Drag it, or press Enter and click the scene.', tag: 'BUTTON' },
  ]);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), []);
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited, json: JSON.stringify(window.probe.annotations()) }));
  const head = await gripCentre(page, 'end');
  const drag = async (to, { escape = false } = {}) => {
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move((head.x + to.x) / 2, (head.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    if (escape) await page.keyboard.press('Escape');
    await page.mouse.up();
  };

  // Escape mid-drag, and a drop that is refused: the head stays where it was and nothing is written.
  await drag(await page.evaluate(() => window.probe.cargoPoint('cargo-b')), { escape: true });
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), before.json, 'Escape restores the end');
  await page.evaluate(() => { window.__hold = window.probe.InteractionManager.hasProvisionalPose; window.probe.InteractionManager.hasProvisionalPose = () => true; });
  await drag(await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), before.json, 'a refused drop leaves it where it was');
  assert.match(await page.evaluate(() => window.probe.hint()), /held case/i, 'and says why');
  await page.evaluate(() => { window.probe.InteractionManager.hasProvisionalPose = window.__hold; });
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), before.edited, 'neither wrote anything');

  // A drop on other cargo moves the head only: same arrow, same tail, cargo untouched, no cargo Undo step.
  await drag(await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.annotations()[0].end.kind === 'cargo');
  const [after] = await page.evaluate(() => window.probe.annotations());
  const [original] = JSON.parse(before.json);
  assert.equal(after.end.instanceId, 'cargo-b');
  assert.deepEqual([after.id, after.start, after.color, after.width, after.createdAt], [original.id, original.start, original.color, original.width, original.createdAt], 'only the head moved');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo never moves');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'and is never selected');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'a handle drag never orbits');
  // Newest first: the handle drag (one arrow edit), then the cargo move above. Redo replays both, to the arrow as moved.
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'the handle drag is the newest step');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'then the cargo move');
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true);
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true);
  assert.equal((await page.evaluate(() => window.probe.annotations()))[0].end.instanceId, 'cargo-b', 'Redo restores the arrow edit');
  assert.match(await page.evaluate(() => window.probe.hint()), /Arrow head moved/);
  assert.equal((await arrowGraphics(page)).length, 1);
  assert.equal((await gripsShown(page)).length, 2, 'the arrow stays selected');

  // The keyboard route: Enter on a handle waits for a click on the scene, which sets that end. (A click right after
  // a drag is deliberately swallowed for one tick, so let that tick pass: timers of equal delay fire in order.)
  await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 0)));
  await page.focus('.tp3d-annot-handle[data-end="start"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /set the arrow tail/i.test(window.probe.hint()));
  await click(page, await freePoint(page, [GROUND_A]));
  await page.waitForFunction(() => window.probe.annotations()[0].start.kind === 'space');
  assert.equal((await page.evaluate(() => window.probe.annotations()))[0].end.instanceId, 'cargo-b', 'the head is untouched');
  assert.deepEqual(errors, []);
});

test('Valid, Needs Review and Unresolved arrows: only a Valid one is drawn, each broken end is explained on its own, and Re-attach repairs one end at a time', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const ids = [
    (await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]])).id,
    (await seedArrow(page, TOP_OF_B, [520, 10])).id,
    (await seedArrow(page, { cargo: 'cargo-a', local: { x: -10, y: 16, z: 0 } }, { cargo: 'cargo-a', local: { x: 10, y: 16, z: 0 } })).id,
  ];
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 3);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 3);
  const stored = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  assert.deepEqual((await arrowGraphics(page)).map(g => g.id).sort(), [...ids].sort(), 'all three are Valid and drawn');

  // A Case size change asks for review of the arrow on that Case: nothing is drawn or relocated, and the record is untouched.
  await page.evaluate(() => {
    const { StateStore } = window.probe;
    const caseId = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-b').caseId;
    StateStore.set({ caseLibrary: StateStore.get('caseLibrary').map(c => (c.id === caseId ? { ...c, dimensions: { ...c.dimensions, length: c.dimensions.length + 6 } } : c)) }, { skipHistory: true });
  });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 2);
  const review = await rowOf(page, 1);
  assert.equal(review.sub, 'Needs review');
  assert.equal(review.flagged, true, 'a dashed ring, never a placed glyph');
  assert.deepEqual(review.ends.map(e => [e.button, /size or shape changed/i.test(e.text)]), [['Re-attach tail', true]], 'only the tail needs attention, with its own reason and action');
  assert.match(review.ends[0].text, /^Tail: /);
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored, 'nothing is rewritten or relocated');

  // Deleting the cargo both ends sit on leaves that arrow Unresolved, with a reason for each end and a Re-attach for each.
  await page.evaluate(() => window.probe.PackLibrary.removeInstances('fixture-pack', ['cargo-a']));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 1);
  const gone = await rowOf(page, 2);
  assert.equal(gone.sub, 'Unresolved');
  assert.deepEqual(gone.ends.map(e => e.button), ['Re-attach tail', 'Re-attach head']);
  assert.ok(gone.ends.every(e => /no longer in this Load Plan/.test(e.text)));
  assert.equal(await count(page), 3, 'editing cargo never deletes an annotation');
  assert.deepEqual((await arrowGraphics(page)).map(g => g.id), [ids[0]], 'no partial or invalid arrow is drawn');

  // Re-attach the tail: Escape cancels without writing; a click on a surface moves only that end.
  const edited = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  await page.click(endButton(ids[2], 'start'));
  await page.waitForFunction(() => /set the arrow tail/i.test(window.probe.hint()));
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await page.evaluate(() => window.probe.hint()), /set the arrow tail/i);
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited), edited, 'a cancelled re-attach writes nothing');
  await page.click(endButton(ids[2], 'start'));
  await page.waitForFunction(() => /set the arrow tail/i.test(window.probe.hint()));
  await click(page, await freePoint(page, [GROUND_A]));
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).start.kind === 'space', ids[2]);
  assert.deepEqual((await rowOf(page, 2)).ends.map(e => e.button), ['Re-attach head'], 'the repaired end is no longer listed');
  assert.equal((await rowOf(page, 2)).sub, 'Unresolved', 'the arrow stays broken until both ends resolve');
  assert.equal((await arrowGraphics(page)).length, 1, 'and is still not drawn');
  await page.click(endButton(ids[2], 'end'));
  await page.waitForFunction(() => /set the arrow head/i.test(window.probe.hint()));
  await click(page, await freePoint(page, [GROUND_B]));
  await page.waitForFunction(id => window.probe.resolved().find(r => r.id === id).status === 'valid', ids[2]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 2);
  const [, , repaired] = await page.evaluate(() => window.probe.annotations());
  assert.equal(repaired.id, ids[2], 'the same arrow, repaired');
  assert.deepEqual([repaired.start.kind, repaired.end.kind], ['space', 'space']);
  assert.deepEqual(errors, []);
});

test('an unfinished arrow is dropped without writing by Escape (one owner per press), closing the panel, Show Off, Measurement Mode, an operation, a preview, a cargo move, a pointer cancel and a Load Plan change', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const edited = () => page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  const before = await edited();
  const armed = () => page.evaluate(() => document.querySelector('.tp3d-annot-seg__btn[data-tool="arrow"]').getAttribute('aria-pressed') === 'true');
  const startArrow = async (at = GROUND_A) => {
    if (!(await armed())) await armArrow(page);
    await click(page, at.length === 3 ? await freePoint(page, [at]) : at);
    await page.waitForFunction(() => /arrow should point/i.test(window.probe.hint()));
    assert.equal(await tailShown(page), true);
  };
  const nothingWritten = async message => {
    await page.waitForFunction(() => { const dot = document.querySelector('.tp3d-annot-arrow__tail'); return !dot || dot.style.display === 'none'; });
    assert.equal(await tailShown(page), false, `${message}: the tail is gone`);
    assert.equal(await count(page), 0, `${message}: nothing was stored`);
    assert.equal(await edited(), before, `${message}: the Load Plan was not edited`);
  };

  // Escape: the unfinished arrow first, then the armed tool (one owner per press).
  await startArrow();
  assert.equal(await escapeConsumed(page), true);
  await page.waitForFunction(() => !/arrow should point/i.test(window.probe.hint()));
  await nothingWritten('Escape');
  assert.equal(await armed(), true, 'the first Escape ends only the unfinished arrow');
  assert.equal(await escapeConsumed(page), true);
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-seg__btn[data-tool="arrow"]').getAttribute('aria-pressed') === 'false');
  assert.equal(await escapeConsumed(page), false, 'with nothing left to close the Editor handles Escape');

  // Switching tool, closing the panel and Show Off.
  await startArrow();
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await nothingWritten('switching tool');
  await armArrow(page);
  await startArrow();
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('editor-annotation-panel').hidden);
  await nothingWritten('closing the panel');
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => !document.getElementById('editor-annotation-panel').hidden);
  await startArrow();
  await page.click('.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("Off")');
  await page.waitForFunction(() => /hidden in the view/i.test(window.probe.hint()));
  await nothingWritten('Show Off');
  assert.equal(await armed(), false, 'Show Off also disarms the tool');
  await page.click('.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("All")');

  // An operation that owns the Editor, a transient preview, and Measurement Mode.
  await startArrow();
  await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('autopacking'); });
  await page.waitForFunction(() => /paused during AutoPack/.test(window.probe.hint()));
  await nothingWritten('AutoPack');
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  await startArrow();
  await page.evaluate(() => { window.__preview = window.probe.CaseScene.isTransientPreview; window.probe.CaseScene.isTransientPreview = () => true; });
  await page.waitForFunction(() => /paused during AutoPack preview/.test(window.probe.hint()));
  await nothingWritten('an AutoPack preview');
  await page.evaluate(() => { window.probe.CaseScene.isTransientPreview = window.__preview; });
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  await startArrow();
  await startMeasuring(page);
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  await page.waitForFunction(() => { const dot = document.querySelector('.tp3d-annot-arrow__tail'); return !dot || dot.style.display === 'none'; });
  assert.equal(await tailShown(page), false, 'Measurement Mode takes the scene: the tail is gone');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.probe.MeasurementTool.isActive());
  // Measurement Mode leaves the Annotations panel open beside it (Phase 1), so nothing needs reopening here.
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), false, 'the Annotations panel stays open beside Measurement Mode');
  await nothingWritten('Measurement Mode');

  // A cargo pose change under the tail, and a pointer interaction that is cancelled.
  await armArrow(page);
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-a')));
  await page.waitForFunction(() => /arrow should point/i.test(window.probe.hint()));
  await page.evaluate(() => {
    const inst = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
    window.probe.PackLibrary.updateInstance('fixture-pack', 'cargo-a', { transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x + 30 } } });
  });
  await page.waitForFunction(() => /cargo changed/i.test(window.probe.hint()));
  assert.equal(await tailShown(page), false, 'cargo moved under the tail');
  assert.equal(await count(page), 0);
  const moved = await page.evaluate(() => window.probe.PackLibrary.getById('fixture-pack').lastEdited);
  await startArrow(GROUND_A);
  const at = await freePoint(page, [GROUND_B]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.evaluate(() => document.querySelector('#viewport canvas').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
  await page.mouse.up();
  await page.waitForFunction(() => /Placement cancelled/.test(window.probe.hint()));
  assert.equal(await tailShown(page), false, 'a cancelled pointer interaction drops the unfinished arrow');
  assert.equal(await count(page), 0);
  assert.equal(await edited(), moved);

  // A Load Plan change ends the session: nothing from the old one lingers.
  await startArrow();
  await page.evaluate(() => window.probe.StateStore.replace(window.probe.StateStore.snapshot()));
  await page.waitForFunction(() => document.getElementById('editor-annotation-panel').hidden);
  assert.equal(await tailShown(page), false);
  assert.equal(await count(page), 0);
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), false);
  assert.deepEqual(errors, []);
});

test('an arrow hidden by cargo is dashed with a hollow head even when selected; a clear one is solid, and it is measured before it is first drawn', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // A clear ground arrow, and one whose middle runs under cargo-a (seen only through the cargo that stands on it).
  const clear = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  const hidden = await seedArrow(page, [20, -20], [120, -20]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 2);
  const byId = async () => Object.fromEntries((await arrowGraphics(page)).map(g => [g.id, g]));
  let state = await byId();
  assert.equal(state[clear.id].occluded, false, 'nothing in front of it');
  assert.equal(state[hidden.id].occluded, true, 'part of it is behind cargo');
  const look = id => page.evaluate(arrowId => {
    const group = document.querySelector(`.tp3d-annot-arrow[data-annot-id="${arrowId}"]`);
    return { shaftDash: getComputedStyle(group.querySelector('.tp3d-annot-arrow__shaft')).strokeDasharray, headDash: getComputedStyle(group.querySelector('.tp3d-annot-arrow__head')).strokeDasharray };
  }, id);
  assert.deepEqual(await look(clear.id), { shaftDash: 'none', headDash: 'none' });
  assert.notEqual((await look(hidden.id)).shaftDash, 'none', 'a dashed shaft');
  assert.notEqual((await look(hidden.id)).headDash, 'none', 'and a hollow, dashed head');

  // Selecting it changes the halo and shows the handles, and never makes it look unobstructed.
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow.is-selected').length === 1);
  state = await byId();
  assert.deepEqual([state[hidden.id].selected, state[hidden.id].occluded], [true, true], 'selected and still marked as hidden');
  assert.notEqual((await look(hidden.id)).shaftDash, 'none');
  assert.equal((await gripsShown(page)).length, 2);
  // When the cargo moves off it, the arrow is in the clear again: the state follows the scene and nothing is stored.
  const stored = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
  await page.evaluate(() => {
    const inst = window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
    window.probe.PackLibrary.updateInstance('fixture-pack', 'cargo-a', { transform: { ...inst.transform, position: { ...inst.transform.position, z: inst.transform.position.z + 200 } } });
  });
  await page.waitForFunction(id => !document.querySelector(`.tp3d-annot-arrow[data-annot-id="${id}"]`).classList.contains('is-occluded'), hidden.id);
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored, 'occlusion is derived, never saved');
  assert.deepEqual(errors, []);
});

test('a selected arrow stays one slim arrow: every width keeps its stroke with at most a hairline edge, a hidden one stays one dashed arrow, and the end grips never cover the arrowhead', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // One clear ground arrow per width, and one whose middle runs under cargo-a.
  const arrows = [
    await seedArrow(page, [100, 62], [260, 66], { color: 'blue', width: 'thin' }),
    await seedArrow(page, [100, 76], [260, 80], { color: 'green', width: 'regular' }),
    await seedArrow(page, [100, 90], [260, 94], { color: 'red', width: 'bold' }),
    await seedArrow(page, [20, -20], [120, -20], { color: 'violet', width: 'regular' }),
  ];
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 4);
  const stored = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
  const looks = id => page.evaluate(arrowId => {
    const group = document.querySelector(`.tp3d-annot-arrow[data-annot-id="${arrowId}"]`);
    const css = selector => getComputedStyle(group.querySelector(selector));
    const accentProbe = document.createElement('i');
    accentProbe.style.color = 'var(--accent-primary)';
    document.body.append(accentProbe);
    const accent = getComputedStyle(accentProbe).color;
    accentProbe.remove();
    const read = selector => ({ stroke: css(selector).stroke, width: parseFloat(css(selector).strokeWidth), dash: css(selector).strokeDasharray });
    return { accent, shaft: read('.tp3d-annot-arrow__shaft'), under: read('.tp3d-annot-arrow__under'), underHead: read('.tp3d-annot-arrow__under-head'), head: read('.tp3d-annot-arrow__head') };
  }, id);
  const gripRing = end => page.evaluate(which => {
    const el = document.querySelector(`.tp3d-annot-handle[data-end="${which}"]:not([hidden])`);
    const ring = getComputedStyle(el, '::before');
    return { diameter: parseFloat(ring.width), fill: ring.backgroundColor };
  }, end);
  const select = async index => {
    await page.click(`.tp3d-annot-row:nth-child(${index + 1}) .tp3d-annot-row__select`);
    await page.waitForFunction(id => document.querySelector(`.tp3d-annot-arrow[data-annot-id="${id}"]`).classList.contains('is-selected'), arrows[index].id);
    await frames(page, 3);
  };
  const SHAFT = { thin: 2, regular: 3, bold: 5 };
  const unselected = [];
  for (const arrow of arrows) unselected.push(await looks(arrow.id));

  for (const [index, width] of ['thin', 'regular', 'bold'].entries()) {
    await select(index);
    const own = await looks(arrows[index].id);
    assert.equal(own.shaft.width, SHAFT[width], `${width}: the selected shaft keeps its preset width`);
    assert.equal(own.shaft.stroke, unselected[index].shaft.stroke, `${width}: the authored color is untouched by selection`);
    assert.notEqual(own.shaft.stroke, own.accent, `${width}: the shaft is never recolored to the selection color`);
    assert.equal(unselected[index].under.width, SHAFT[width] + 4, `${width}: an unselected arrow keeps a neutral halo`);
    assert.notEqual(unselected[index].under.stroke, own.accent);
    // The selection edge is a hairline: one pixel a side, never wider than the neutral halo it replaces.
    assert.equal(own.under.stroke, own.accent, `${width}: the edge uses the selection color`);
    assert.equal(own.under.width, SHAFT[width] + 2, `${width}: one pixel a side, so a selected Thin arrow is still thin`);
    assert.equal(own.underHead.width, 2, `${width}: the head edge is a hairline too`);
    assert.equal(own.under.dash, 'none');
    // Every other arrow is left exactly as it was.
    for (const other of arrows.filter((_, i) => i !== index)) {
      const now = await looks(other.id);
      const was = unselected[arrows.indexOf(other)];
      assert.deepEqual([now.under.width, now.under.stroke, now.shaft.width], [was.under.width, was.under.stroke, was.shaft.width], 'an unselected arrow does not change');
    }
    // The grips: a filled tail ring and a hollow head ring no larger than the smallest arrowhead, so direction stays readable.
    assert.equal((await gripsShown(page)).length, 2, `${width}: both end grips`);
    const [tail, head] = [await gripRing('start'), await gripRing('end')];
    assert.ok(head.diameter <= 12 && tail.diameter <= 12, `${width}: grips are no larger than the smallest arrowhead (12 px)`);
    assert.equal(head.fill, 'rgba(0, 0, 0, 0)', `${width}: the head grip is hollow, so the arrowhead shows through it`);
    assert.notEqual(tail.fill, 'rgba(0, 0, 0, 0)', `${width}: the tail grip is filled`);
  }

  // Hidden by cargo and selected: one dashed arrow. The halo follows the shaft's dashes in the same neutral tone as before
  // selection, so no continuous line (and no solid orange sheath) shows through the gaps.
  await select(3);
  const hidden = await looks(arrows[3].id);
  assert.equal((await arrowGraphics(page)).find(g => g.id === arrows[3].id).occluded, true, 'it is behind cargo');
  assert.notEqual(hidden.shaft.dash, 'none', 'a dashed shaft');
  assert.equal(hidden.under.dash, hidden.shaft.dash, 'the halo is dashed with the same pattern, on the same path');
  assert.notEqual(hidden.under.stroke, hidden.accent, 'no orange sheath behind the dashes');
  assert.notEqual(hidden.underHead.stroke, hidden.accent, 'nor around the hollow head');
  assert.equal(hidden.under.width, SHAFT.regular + 4, 'the halo is as wide as an unselected one');
  assert.notEqual(hidden.head.dash, 'none', 'the head stays hollow and dashed');
  assert.equal((await gripsShown(page)).length, 2, 'the grips and the list row still mark the selection');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-row.is-selected').length), 1);

  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored, 'styling never writes a record');
  assert.deepEqual(errors, []);
});
test('occlusion follows the synchronized scene: cargo moved off or onto a ground arrow or marker re-measures it, also when the meshes synchronize after the first measurement, and an unchanged scene is never re-measured', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // An arrow whose middle runs under cargo-a, and a callout on the ground under cargo-b (each seen only through that cargo).
  const arrow = await seedArrow(page, [20, -20], [120, -20]);
  await seed(page, [{ title: 'Under the case', ground: [300, 20] }]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 1 && document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1);
  // Count every occlusion measurement (each reads the scene's raycast meshes) and note when the last one ran.
  await page.evaluate(() => {
    const { CaseScene } = window.probe;
    const real = CaseScene.getRaycastMeshes.bind(CaseScene);
    window.__rays = 0;
    window.__rayAt = performance.now();
    CaseScene.getRaycastMeshes = () => { window.__rays += 1; window.__rayAt = performance.now(); return real(); };
  });
  const looks = () => page.evaluate(id => ({
    arrow: document.querySelector(`.tp3d-annot-arrow[data-annot-id="${id}"]`).classList.contains('is-occluded'),
    marker: document.querySelector('.tp3d-annot-pin:not(.is-draft)').classList.contains('is-hollow'),
  }), arrow.id);
  const becomes = async (expected, label) => {
    await page.waitForFunction(([id, want]) => {
      const a = document.querySelector(`.tp3d-annot-arrow[data-annot-id="${id}"]`).classList.contains('is-occluded');
      const m = document.querySelector('.tp3d-annot-pin:not(.is-draft)').classList.contains('is-hollow');
      return a === want.arrow && m === want.marker;
    }, [arrow.id, expected]);
    assert.deepEqual(await looks(), expected, label);
  };
  // No measurement has run for a moment: the next change meets a refresh that is due, which is the ordinary case. One
  // cargo moves per step, as in a single Load Plan edit (a second change right behind it would re-measure by itself).
  const quiet = () => page.waitForFunction(() => performance.now() - window.__rayAt > 150);
  const moveCargo = (id, delta) => page.evaluate(([cargo, by]) => {
    const { PackLibrary } = window.probe;
    const inst = PackLibrary.getById('fixture-pack').cases.find(c => c.id === cargo);
    PackLibrary.updateInstance('fixture-pack', cargo, { transform: { ...inst.transform, position: { ...inst.transform.position, z: inst.transform.position.z + by } } });
  }, [id, delta]);
  const rays = () => page.evaluate(() => window.__rays);
  const sceneZ = id => page.evaluate(cargo => window.probe.CaseScene.getObject(cargo).position.z, id);
  const committedZ = id => page.evaluate(cargo => window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === cargo).transform.position.z, id);
  await becomes({ arrow: true, marker: true }, 'both start behind cargo');
  const stored = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
  const camera = await page.evaluate(() => window.probe.camera());

  // 1. The ordinary Editor path, both ways: a Load Plan edit moves one cargo (no drag) and the view never moves.
  await quiet();
  await moveCargo('cargo-a', 200);
  await becomes({ arrow: false, marker: true }, 'cargo-a moved off the arrow: only the arrow is in the clear');
  await quiet();
  await moveCargo('cargo-b', 200);
  await becomes({ arrow: false, marker: false }, 'cargo-b moved off the marker: both are in the clear');
  await quiet();
  await moveCargo('cargo-a', -200);
  await becomes({ arrow: true, marker: false }, 'cargo-a moved back onto the arrow');
  await quiet();
  await moveCargo('cargo-b', -200);
  await becomes({ arrow: true, marker: true }, 'cargo-b moved back onto the marker');

  // 2. The meshes synchronize AFTER the tool measured: the scene sync is held, the change is measured against the old layout,
  //    then the sync completes and the new layout is measured from the synchronized scene with no camera move.
  for (const [id, hiddenAfter] of [['cargo-a', { arrow: false, marker: true }], ['cargo-b', { arrow: false, marker: false }]]) {
    await quiet();
    await page.evaluate(() => {
      const { CaseScene } = window.probe;
      window.__realSync = CaseScene.sync;
      CaseScene.sync = () => {}; // the Editor's render reaches the tool, but the scene does not synchronize yet
    });
    const before = await rays();
    const heldZ = await sceneZ(id);
    await moveCargo(id, 200);
    await page.waitForFunction(count => window.__rays > count, before);
    await quiet();
    assert.equal(await sceneZ(id), heldZ, `${id}: the scene still holds the old layout`);
    assert.notEqual(await committedZ(id), heldZ, `${id}: while the committed layout has moved`);
    assert.notDeepEqual(await looks(), hiddenAfter, `${id}: measured against the old layout while the scene had not synchronized`);
    await page.evaluate(() => {
      const { CaseScene, PackLibrary } = window.probe;
      CaseScene.sync = window.__realSync;
      CaseScene.sync(PackLibrary.getById('fixture-pack'));
    });
    await becomes(hiddenAfter, `${id}: the completed sync re-measures the new layout`);
    assert.notEqual(await sceneZ(id), heldZ, `${id}: the scene now shows the committed layout`);
  }
  assert.equal(await page.evaluate(() => window.probe.camera()), camera, 'no camera move was needed');

  // 3. An unchanged scene is never re-measured: re-syncing the same layout, and frames passing, run no more rays.
  await quiet();
  const settledRays = await rays();
  const revision = await page.evaluate(() => window.probe.CaseScene.getGeometryRevision());
  await page.evaluate(() => window.probe.CaseScene.sync(window.probe.PackLibrary.getById('fixture-pack')));
  await frames(page, 12);
  assert.equal(await page.evaluate(() => window.probe.CaseScene.getGeometryRevision()), revision, 'syncing the same layout is not a change');
  assert.equal(await rays(), settledRays, 'nothing moved, so nothing was measured again');
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored, 'occlusion is derived, never saved');
  assert.deepEqual(errors, []);
});

test('arrows and a saved measurement are on screen together; while Measurement Mode owns the scene the arrows stay drawn but take no input', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 90), end: at(260, 100) }).ok) throw new Error('measurement seed failed');
  });
  const drawnLines = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(g => g.style.display !== 'none').length);
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].some(g => g.style.display !== 'none'));
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length === 2);
  const saved = () => page.evaluate(() => JSON.stringify([window.probe.annotations(), window.probe.PackLibrary.getMeasurements('fixture-pack'), window.probe.casesJson()]));
  const before = await saved();
  assert.deepEqual([(await arrowGraphics(page)).length, await drawnLines()], [1, 1], 'the arrow and the saved line are drawn together');
  const stacking = await page.evaluate(() => ({ lines: Number(getComputedStyle(document.getElementById('editor-measure-labels')).zIndex), annotations: Number(getComputedStyle(document.querySelector('.tp3d-annot-layer')).zIndex) }));
  assert.ok(stacking.lines < stacking.annotations, 'the saved line is drawn beneath the arrow layer');

  // Measurement Mode takes the scene: the arrow stays drawn as a view, its handles take no input, Delete and Escape are the ruler's.
  await startMeasuring(page);
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  await frames(page, 3);
  assert.deepEqual([(await arrowGraphics(page)).length, await drawnLines()], [1, 1], 'both stay drawn while the ruler is on');
  assert.deepEqual(await page.evaluate(() => ({ viewOnly: document.querySelector('.tp3d-annot-layer').classList.contains('is-view-only'), inert: document.querySelector('.tp3d-annot-layer').inert })), { viewOnly: true, inert: true });
  assert.deepEqual(await gripsShown(page), [], 'no handle is offered while another tool owns the scene');
  await page.keyboard.press('Delete');
  await frames(page, 3);
  assert.equal(await count(page), 1, 'Delete never removes the arrow while the ruler owns the scene');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.probe.MeasurementTool.isActive());
  assert.equal(await saved(), before, 'neither tool wrote anything');
  await page.waitForFunction(() => !document.querySelector('.tp3d-annot-layer').classList.contains('is-view-only'));
  assert.equal((await arrowGraphics(page))[0].id, arrow.id);
  assert.deepEqual(errors, []);
});

test('arrows are DOM and SVG above the canvas: no scene objects are added, the canvas pixels are unchanged, and unreadable recovery records stay inert', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const base = await page.evaluate(() => ({ pixels: window.probe.canvasData(), objects: window.probe.sceneObjectCount() }));
  const first = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]], { color: 'blue', width: 'thin' });
  await seedArrow(page, TOP_OF_B, TOP_OF_A, { color: 'green', width: 'bold' });
  await page.click('.tp3d-annot-row:nth-child(2) .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 2);
  const drawn = await page.evaluate(() => ({ pixels: window.probe.canvasData(), objects: window.probe.sceneObjectCount() }));
  assert.equal(drawn.objects, base.objects, 'no scene object is added');
  assert.equal(drawn.pixels, base.pixels, 'arrows never reach the canvas pixels (and so never a Screenshot, PDF view or thumbnail)');
  assert.deepEqual(await page.evaluate(() => ({
    insideViewport: Boolean(document.querySelector('#viewport .tp3d-annot-arrow, #viewport .tp3d-annot-handle')),
    svgInLayer: document.getElementById('editor-annotation-layer').contains(document.querySelector('.tp3d-annot-svg .tp3d-annot-arrow')),
    clickThrough: getComputedStyle(document.querySelector('.tp3d-annot-svg')).pointerEvents,
    label: document.getElementById('editor-annotation-layer').getAttribute('aria-label'),
  })), { insideViewport: false, svgInLayer: true, clickThrough: 'none', label: 'Annotations' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tp3d-annot-arrow[data-annot-id] .tp3d-annot-arrow__shaft')).strokeWidth), '2px', 'thin is a constant 2 screen pixels');

  // A recovery record that merely wraps a perfectly valid arrow stays inert: not listed as an arrow, never drawn, never edited.
  const original = JSON.parse(JSON.stringify(first));
  await page.evaluate(({ original }) => {
    const { StateStore, PackLibrary } = window.probe;
    PackLibrary.deleteAnnotation('fixture-pack', original.id);
    const pack = PackLibrary.getById('fixture-pack');
    StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === pack.id ? { ...p, annotations: [{ id: 'wrapped', type: 'unreadable', schemaVersion: 1, reason: 'Saved by a newer version of the app.', original }, ...p.annotations] } : p)) }, { skipHistory: true });
  }, { original });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 2);
  const wrapper = await rowOf(page, 0);
  assert.deepEqual([wrapper.name, wrapper.selectDisabled, wrapper.flagged], ['Unreadable annotation', true, true]);
  assert.equal((await arrowGraphics(page)).length, 1, 'only the real arrow is drawn');
  await seedArrow(page, [GROUND_B[0], GROUND_B[2]], [GROUND_A[0], GROUND_A[2]]);
  assert.deepEqual((await page.evaluate(() => window.probe.annotations())).find(r => r.id === 'wrapped').original, original, 'writing an arrow keeps the wrapped original verbatim');
  assert.deepEqual(errors, []);
});

test('real AutoPack: arrows are clean while it runs, and on the applied layout they are drawn and editable beside Results, which never changes', { timeout: 480000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 90), end: at(260, 100) }).ok) throw new Error('measurement seed failed');
  });
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length === 2);
  const segments = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(g => g.style.display !== 'none').length);
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].some(g => g.style.display !== 'none'));
  const records = () => page.evaluate(() => JSON.stringify(window.probe.annotations()));
  const before = await records();
  await page.evaluate(() => {
    window.__samples = [];
    const tick = () => window.requestAnimationFrame(() => window.setTimeout(() => {
      window.__samples.push({
        busy: window.probe.OperationLifecycle.isBusy(),
        drawn: [...document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft, .tp3d-annot-svg .tp3d-annot-arrow__head')].filter(el => el.getAttribute('d')).length
          + document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length,
      });
      tick();
    }, 0));
    tick();
  });
  await page.click('#btn-autopack');
  await page.waitForFunction(() => window.probe.OperationLifecycle.isBusy());
  await page.waitForFunction(() => /paused during AutoPack/.test(window.probe.hint()));
  await page.waitForFunction(() => window.probe.StateStore.get('autoPackResults') && !window.probe.OperationLifecycle.isBusy(), null, { timeout: 120000 });
  assert.equal(await records(), before, 'AutoPack never rewrote an arrow');
  const samples = await page.evaluate(() => window.__samples);
  assert.ok(samples.some(s => s.busy), 'the run was observed');
  assert.equal(samples.filter(s => s.busy && s.drawn > 0).length, 0, 'no arrow, head or handle is ever drawn while AutoPack runs');

  // Results open over the committed layout: the arrow, its handles and the saved measurement are back; editing is available.
  await page.waitForFunction(() => !/paused/.test(window.probe.hint()));
  assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false, 'the committed layout is displayed');
  await page.waitForFunction(id => document.querySelector(`.tp3d-annot-arrow[data-annot-id="${id}"] .tp3d-annot-arrow__shaft`).getAttribute('d'), arrow.id);
  assert.equal(await segments(), 1, 'the saved measurement is back too');
  // AutoPack replaces the cargo selection, which also ends an annotation selection (as it does for a callout):
  // picking the arrow from the list offers its handles again beside Results.
  assert.equal((await rowOf(page, 0)).selected, false);
  await page.click('.tp3d-annot-row .tp3d-annot-row__select');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length === 2);
  assert.deepEqual(await page.evaluate(() => [document.querySelector('.tp3d-annot-seg__btn[data-tool="arrow"]').disabled, document.querySelector('.tp3d-annot-row__eye').disabled]), [false, false], 'creating and editing are available with Results open');
  const results = await page.evaluate(() => JSON.stringify(window.probe.StateStore.get('autoPackResults')));
  const cargo = await page.evaluate(() => window.probe.casesJson());
  const pill = () => page.evaluate(() => Boolean(document.querySelector('.tp3d-autopack-results__current-pill')));
  const wasApplied = await pill();
  const untouched = async message => {
    assert.equal(await page.evaluate(() => JSON.stringify(window.probe.StateStore.get('autoPackResults'))), results, `${message}: AutoPack Results state is unchanged`);
    assert.equal(await page.evaluate(() => window.probe.casesJson()), cargo, `${message}: cargo is unchanged`);
    assert.equal(await page.evaluate(() => window.probe.CaseScene.isTransientPreview()), false, `${message}: still the committed layout`);
    assert.equal(await pill(), wasApplied, `${message}: the Applied marker is as it was`);
  };
  await page.click('.tp3d-annot-panel__arrow .tp3d-annot-swatch[data-color="violet"]');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).color === 'violet', arrow.id);
  await untouched('editing an arrow');
  await page.click('.tp3d-annot-row .tp3d-annot-row__eye');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).hidden === true, arrow.id);
  await frames(page, 3);
  assert.equal((await arrowGraphics(page)).length, 0, 'Hide takes it off the view');
  await page.click('.tp3d-annot-row .tp3d-annot-row__eye');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).hidden === false, arrow.id);
  await untouched('hiding and showing an arrow');
  await armArrow(page);
  const tail = await freePoint(page, [[300, 0, 70], [200, 0, 40], GROUND_A]);
  const head = await freePoint(page, [[420, 0, 80], [480, 0, 60], GROUND_B]);
  await click(page, tail);
  await click(page, head);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  await untouched('placing an arrow');
  assert.deepEqual(errors, []);
});

test('the arrow look controls never push the rows out of reach beside Results: the panel stays clear, every row and control is reachable by scrolling, and it grows back when Results moves away', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'Callout 1', ground: [100, 10] }, { title: 'Callout 2', ground: [140, 10] }]);
  for (const [from, to] of [[[60, -20], [180, -20]], [[10, -30], [10, 40]], [[250, -30], [330, 10]], [[300, 30], [420, 30]]]) await seedArrow(page, from, to);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 6);
  const panel = () => boxOf(page, '#editor-annotation-panel');
  // Every button the panel has, once scrolled into view (the rows scroll, and so does the body while the look controls show), takes the click.
  const unreachable = () => page.evaluate(() => [...document.querySelectorAll('#editor-annotation-panel button')].filter(button => {
    const r = button.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).filter(button => {
    button.scrollIntoView({ block: 'nearest' });
    const r = button.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top && (top === button || button.contains(top)));
  }).map(button => button.getAttribute('aria-label') || button.textContent.trim()));
  // A stand-in for the Results card (the panel reads its rectangle from the DOM), below the panel.
  const placeCard = ({ x, y, w = 420, h = 236 }) => page.evaluate(([left, top, width, height]) => {
    const host = document.querySelector('.canvas-wrap');
    const origin = host.getBoundingClientRect();
    let stand = document.querySelector('[data-role="autopack-results-panel"]');
    if (!stand) {
      stand = document.createElement('section');
      stand.setAttribute('data-role', 'autopack-results-panel');
      stand.style.cssText = 'position:absolute;z-index:12;background:#fff;border:1px solid #888;box-sizing:border-box';
      host.appendChild(stand);
    }
    Object.assign(stand.style, { left: `${left - origin.left}px`, top: `${top - origin.top}px`, width: `${width}px`, height: `${height}px` });
  }, [x, y, w, h]);
  const removeCard = () => page.evaluate(() => document.querySelector('[data-role="autopack-results-panel"]')?.remove());
  const lookShown = () => page.evaluate(() => { const el = document.querySelector('.tp3d-annot-panel__arrow'); return Boolean(el) && !el.hidden; });
  const check = async label => {
    const shown = await panel();
    const stand = await boxOf(page, '[data-role="autopack-results-panel"]');
    assert.equal(overlaps(shown, stand), false, `${label}: the panel does not touch Results`);
    assert.deepEqual(await unreachable(), [], `${label}: every row and control can be reached`);
    assert.ok(await lookShown(), `${label}: the arrow look controls are showing`);
  };
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select');
  await page.waitForFunction(() => !document.querySelector('.tp3d-annot-panel__arrow')?.hidden);
  await frames(page, 4);
  const full = await panel();
  assert.deepEqual(await unreachable(), [], 'no Results: everything is reachable');

  // Results below the panel's top part: the panel gives up height, the rows and the look controls scroll together.
  await placeCard({ x: full.x - 120, y: full.y + 230 });
  await frames(page, 8);
  const limited = await panel();
  assert.ok(limited.h < full.h, 'the panel gives up height instead of running under Results');
  await check('arrow selected');

  // The same with only the Arrow tool armed (the look controls are for the next arrow).
  await page.evaluate(() => window.probe.AnnotationTool.isActive());
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row.is-selected').length === 0);
  await armArrow(page);
  await frames(page, 8);
  await check('arrow tool armed');

  // Results away: the panel returns to exactly its full size (a limited panel can grow back).
  await removeCard();
  await frames(page, 8);
  assert.ok(near((await panel()).h, full.h, 1), 'the panel is back to its full height');
  assert.deepEqual(errors, []);
});

test('beside expanded Results the panel never runs under the card and never loses its rows to the look controls: at 1100x620 (also with the Outdated header), at every height down to its floor and compact, Show, the tools, every row, Re-attach and the look controls stay reachable', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1100, height: 620 });
  // Two callouts, three Valid arrows and an arrow whose tail sat on cargo that is now gone (Unresolved, with Re-attach).
  await seed(page, [{ title: 'Callout 1', ground: [100, 10] }, { title: 'Callout 2', ground: [140, 10] }]);
  for (const [from, to] of [[[60, -20], [180, -20]], [[10, -30], [10, 40]], [[250, -30], [330, 10]]]) await seedArrow(page, from, to);
  const broken = await seedArrow(page, TOP_OF_B, [520, 10]);
  await page.evaluate(() => window.probe.PackLibrary.removeInstances('fixture-pack', ['cargo-b']));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 6);
  const panel = () => boxOf(page, '#editor-annotation-panel');
  const card = () => boxOf(page, '[data-role="autopack-results-panel"]');
  const flows = () => page.evaluate(() => document.querySelector('#editor-annotation-panel .tp3d-annot-panel__body').classList.contains('is-flow'));
  // A stand-in for the Results card (the panel reads its rectangle from the DOM), placed in viewport coordinates.
  const placeCard = ({ x, y, w = 420, h = 237 }) => page.evaluate(([left, top, width, height]) => {
    const host = document.querySelector('.canvas-wrap');
    const origin = host.getBoundingClientRect();
    let stand = document.querySelector('[data-role="autopack-results-panel"]');
    if (!stand) {
      stand = document.createElement('section');
      stand.setAttribute('data-role', 'autopack-results-panel');
      stand.style.cssText = 'position:absolute;z-index:12;background:#fff;border:1px solid #888;box-sizing:border-box';
      host.appendChild(stand);
      // The Editor's own render drops a Results card it did not create when a row is selected: put the stand-in back in
      // the same task, so it stays where the real card would stay through every click below.
      window.__standInObserver = new MutationObserver(() => { if (!stand.isConnected) host.appendChild(stand); });
      window.__standInObserver.observe(host, { childList: true });
    }
    Object.assign(stand.style, { left: `${left - origin.left}px`, top: `${top - origin.top}px`, width: `${width}px`, height: `${height}px` });
  }, [x, y, w, h]);
  const removeCard = () => page.evaluate(() => {
    if (window.__standInObserver) window.__standInObserver.disconnect();
    window.__standInObserver = null;
    document.querySelector('[data-role="autopack-results-panel"]')?.remove();
  });
  // Every visible button the panel has, once scrolled into view, takes the click (nothing is drawn over it).
  const unreachable = () => page.evaluate(() => [...document.querySelectorAll('#editor-annotation-panel button')].filter(button => {
    const r = button.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).filter(button => {
    button.scrollIntoView({ block: 'nearest' });
    const r = button.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top && (top === button || button.contains(top)));
  }).map(button => button.getAttribute('aria-label') || button.textContent.trim()));
  const inventory = () => page.evaluate(() => {
    const visible = el => el.getClientRects().length > 0;
    const root = document.getElementById('editor-annotation-panel');
    return {
      show: [...root.querySelectorAll('.tp3d-annot-seg--show .tp3d-annot-seg__btn')].filter(visible).length,
      tools: [...root.querySelectorAll('.tp3d-annot-seg--tools .tp3d-annot-seg__btn')].filter(visible).length,
      rows: [...root.querySelectorAll('.tp3d-annot-row__select')].filter(visible).length,
      reattach: [...root.querySelectorAll('button')].filter(b => /^Re-attach/.test(b.textContent.trim()) && visible(b)).length,
      look: [...root.querySelectorAll('.tp3d-annot-panel__arrow .tp3d-annot-seg__btn, .tp3d-annot-panel__arrow .tp3d-annot-swatch')].filter(visible).length,
    };
  });
  // At the top of the body, with no scrolling: do the tool and Show buttons (and the first row) take a click, or does a pinned
  // footer sit over them?
  const hittableAtTop = () => page.evaluate(() => {
    document.querySelector('#editor-annotation-panel .tp3d-annot-panel__body').scrollTop = 0;
    const hit = selector => {
      const el = document.querySelector(`#editor-annotation-panel ${selector}`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(top && (top === el || el.contains(top)));
    };
    return { tools: hit('.tp3d-annot-seg--tools .tp3d-annot-seg__btn'), show: hit('.tp3d-annot-seg--show .tp3d-annot-seg__btn'), row: hit('.tp3d-annot-row__select') };
  });
  const assertUsable = async (label, { look = true, rowAtTop = true } = {}) => {
    const shown = await panel();
    const stand = await card();
    assert.equal(overlaps(shown, stand), false, `${label}: the panel does not touch Results`);
    const top = await hittableAtTop();
    assert.deepEqual([top.tools, top.show], [true, true], `${label}: the tool and Show buttons are in reach without scrolling`);
    if (rowAtTop) assert.equal(top.row, true, `${label}: so is the first row`);
    assert.deepEqual(await unreachable(), [], `${label}: every control it has can be reached`);
    const have = await inventory();
    assert.deepEqual([have.show, have.tools, have.rows, have.reattach > 0, look ? have.look > 0 : true], [3, 3, 6, true, true], `${label}: Show, the tools, every row, Re-attach and the look controls are all there`);
  };

  // An arrow is selected, so its look controls are showing. With no card the panel is at its full size and pins them.
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select');
  await page.waitForFunction(() => !document.querySelector('.tp3d-annot-panel__arrow')?.hidden);
  await frames(page, 6);
  const full = await panel();
  assert.equal(await flows(), false, 'room enough: the look controls stay pinned under the scrolling rows');
  assert.deepEqual(await unreachable(), [], 'no Results: everything is reachable');

  // 1. Normal expanded Results at 1100x620 (the geometry of the real card): 213 px above it.
  await placeCard({ x: full.x - 129, y: full.y + 219, h: 237 });
  await frames(page, 8);
  const normal = await panel();
  assert.ok(near(normal.h, 213, 1.5) && normal.y === full.y, 'it gives up height and keeps its place');
  assert.equal(await flows(), true, 'too short for pinned controls: everything scrolls under the header');
  await assertUsable('normal Results');

  // 2. The Outdated header makes the card taller: 198 px above it, two short of the preferred minimum. No cliff.
  await placeCard({ x: full.x - 129, y: full.y + 204, h: 252 });
  await frames(page, 8);
  const outdated = await panel();
  const outdatedCard = await card();
  assert.ok(near(outdated.h, 198, 1.5) && outdated.y === full.y, 'still docked above the card, a little shorter');
  await assertUsable('Outdated Results');
  // Show, selecting a row and Re-attach take real clicks (they are scrolled to and must not be covered).
  await page.click('.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("Selected")');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-seg--show .tp3d-annot-seg__btn[aria-pressed="true"]').textContent.trim() === 'Selected');
  await page.click('.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("All")');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-seg--show .tp3d-annot-seg__btn[aria-pressed="true"]').textContent.trim() === 'All');
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select >> nth=1');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row.is-selected').length === 1);
  await page.click(endButton(broken.id, 'start'));
  await page.waitForFunction(() => /set the arrow tail/i.test(window.probe.hint()));
  await page.focus('#viewport');
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await page.evaluate(() => window.probe.hint()), /set the arrow tail/i, 'Re-attach was reachable and Escape cancels it');
  assert.deepEqual(await card(), outdatedCard, 'Results never moved');
  await page.waitForFunction(() => window.probe.hint() === ''); // the status line is gone: the rows sit where they settle

  // 3. Every height from plenty of room down to the floor: the panel is exactly as tall as the room, never under the card.
  for (const room of [260, 236, 213, 200, 199, 198, 190, 175, 160, 150]) {
    await placeCard({ x: full.x - 129, y: full.y + room + 6, h: 237 });
    await frames(page, 6);
    const shown = await panel();
    assert.ok(near(shown.h, Math.min(full.h, room), 1.5), `${room} px of room: the panel is ${Math.round(shown.h)} px (the room, not a cliff)`);
    await assertUsable(`${room} px of room`, { rowAtTop: room >= 198 });
  }
  // Below the floor nothing useful fits: V1A's rule applies (the panel is left where it is and the card stays on top).
  await placeCard({ x: full.x - 129, y: full.y + 140 + 6, h: 237 });
  await frames(page, 6);
  assert.ok(near((await panel()).h, full.h, 1), 'under the floor the panel is not squeezed into a sliver');

  // 4. The owner's dragged place is a preference: the fit is temporary and ends when Results moves away.
  await removeCard();
  await frames(page, 6);
  const home = await panel();
  assert.deepEqual([home.x, home.y, home.h], [full.x, full.y, full.h], 'with Results gone the panel is back exactly');
  assert.equal(await flows(), false, 'and its look controls are pinned again');
  const grip = () => page.evaluate(() => { const r = document.querySelector('#editor-annotation-panel .tp3d-annot-grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const from = await grip();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 120, from.y - 20, { steps: 6 });
  await page.mouse.up();
  await frames(page, 6);
  const dropped = await panel();
  assert.ok(dropped.x < full.x - 80, 'the owner moved the panel');
  await placeCard({ x: dropped.x - 129, y: dropped.y + 204, h: 252 });
  await frames(page, 8);
  assert.ok(near((await panel()).h, 198, 1.5), 'the dragged panel is fitted above the card too');
  await assertUsable('dragged panel beside Outdated Results');
  await removeCard();
  await frames(page, 6);
  const back = await panel();
  assert.deepEqual([back.x, back.y, back.h], [dropped.x, dropped.y, dropped.h], 'with Results gone it returns to where the owner dropped it');

  // 5. Compact: the bottom sheet rides above the card and scrolls as a whole.
  await page.setViewportSize({ width: 500, height: 740 });
  await frames(page, 8);
  const wrap = await boxOf(page, '.canvas-wrap');
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').classList.contains('is-compact')), true);
  await placeCard({ x: wrap.x + 60, y: wrap.b - 280, w: 380, h: 250 });
  await frames(page, 10);
  assert.equal(await flows(), true, 'compact: the sheet scrolls as a whole');
  await assertUsable('compact');
  assert.equal(await page.evaluate(() => window.probe.annotations().length), 6, 'nothing was written');
  assert.deepEqual(errors, []);
});

// ============================================================================
// Settings > Show Annotations: a visibility switch like Show Camera Controls, Show Zoom Controls and Show
// Measurement Tool. Off hides the button and every graphic and ends whatever was unfinished; the records
// (and their own hidden flags) are never touched; On draws them again from those records.
// ============================================================================
// The same PreferencesManager.set the Settings overlay's Save changes calls.
const setShowAnnotations = (page, show) => page.evaluate(value => {
  const { PreferencesManager } = window.probe;
  PreferencesManager.set({ ...PreferencesManager.get(), showAnnotations: value });
}, show);
const annotationsButtonShown = page => page.evaluate(() => {
  const button = document.getElementById('btn-editor-annotations');
  return !button.hidden && getComputedStyle(button).display !== 'none';
});
const layerGraphics = page => page.evaluate(() => {
  const shown = selector => [...document.querySelectorAll(selector)].filter(el => !el.hidden).length;
  return {
    hidden: document.getElementById('editor-annotation-layer').hidden,
    pins: shown('.tp3d-annot-pin:not(.is-draft)'),
    cards: shown('.tp3d-annot-card'),
    arrows: document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow:not(.is-preview) .tp3d-annot-arrow__shaft[d]:not([d=""])').length,
    grips: shown('.tp3d-annot-handle'),
  };
});
const annotationState = page => page.evaluate(() => ({
  json: JSON.stringify(window.probe.annotations()),
  edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited,
  cases: window.probe.casesJson(),
  camera: window.probe.camera(),
}));
const nothingUnderway = page => page.evaluate(() => {
  const tool = window.probe.AnnotationTool;
  return !tool.isActive() && !tool.hasDraft() && tool.selectedId() === null;
});

test('Show Annotations Off hides the button and every saved callout and arrow, ends each unfinished gesture without writing and keeps every record; On draws them again from the unchanged records, with no gesture or selection brought back', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const [, hiddenOne] = await seed(page, [{ title: 'Kept', ...TOP_OF_B }, { title: 'Hidden one', ground: [200, -30] }]);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.evaluate(id => {
    if (!window.probe.PackLibrary.updateCallout('fixture-pack', id, { hidden: true }).ok) throw new Error('hide failed');
  }, hiddenOne.id);
  const drawnAsSaved = () => page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1 &&
    document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow:not(.is-preview) .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 1);
  await drawnAsSaved();
  await cameraSettled(page);
  const base = await annotationState(page);
  assert.equal(JSON.parse(base.json).length, 3);
  assert.equal(JSON.parse(base.json)[1].hidden, true, 'one callout carries its own Hide');

  const expectOff = async label => {
    assert.equal(await annotationsButtonShown(page), false, `${label}: the button is gone`);
    assert.deepEqual(await layerGraphics(page), { hidden: true, pins: 0, cards: 0, arrows: 0, grips: 0 }, `${label}: no callout, card, arrow or end handle is drawn`);
    assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), true, `${label}: the panel is closed`);
    assert.equal(await nothingUnderway(page), true, `${label}: no armed tool, re-attach, editor or selection is left`);
    assert.equal(await tailShown(page), false, `${label}: no arrow tail is left`);
    assert.equal(await editorClosed(page), true, `${label}: no editor card is left`);
    assert.deepEqual(await annotationState(page), base, `${label}: nothing was written and the view did not move`);
  };
  // Back On: drawn from the saved records and each one's own Hide; the panel stays closed and nothing resumes.
  const turnOnAndReopen = async label => {
    await setShowAnnotations(page, true);
    await drawnAsSaved();
    assert.equal(await annotationsButtonShown(page), true, `${label}: the button is back`);
    assert.equal(await page.getAttribute('#btn-editor-annotations', 'aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), true, `${label}: the panel is not reopened for the owner`);
    assert.equal(await nothingUnderway(page), true, `${label}: no gesture or selection comes back`);
    assert.deepEqual(await livePins(page), ['1'], `${label}: only the callout without its own Hide is drawn`);
    assert.deepEqual(await annotationState(page), base, `${label}: the records are exactly as saved`);
    await page.click('#btn-editor-annotations');
    await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
    assert.deepEqual(
      await page.evaluate(() => ['callout', 'arrow'].map(tool => document.querySelector(`.tp3d-annot-seg__btn[data-tool="${tool}"]`).getAttribute('aria-pressed'))),
      ['false', 'false'], `${label}: no tool is armed again`
    );
  };

  // 1. An unsaved callout in its editor card.
  const groundFree = await freePoint(page, [[150, 0, -10], [470, 0, -5], [380, 0, 60]]);
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.waitForFunction(() => /place a callout/i.test(window.probe.hint()));
  await click(page, groundFree);
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  await page.fill('.tp3d-annot-editor__input', 'Unsaved');
  await setShowAnnotations(page, false);
  await expectOff('an unsaved callout');
  await turnOnAndReopen('an unsaved callout');

  // 2. The first click of a new arrow.
  await armArrow(page);
  await click(page, await freePoint(page, [[150, 0, -10], [470, 0, -5], [380, 0, 60]]));
  await page.waitForFunction(() => /arrow should point/i.test(window.probe.hint()));
  assert.equal(await tailShown(page), true);
  await setShowAnnotations(page, false);
  await expectOff('an unfinished arrow');
  await turnOnAndReopen('an unfinished arrow');

  // 3. A pending Re-attach of an arrow end (a click on its end handle), with the arrow selected.
  await page.click(`.tp3d-annot-row[data-annot-id="${arrow.id}"] .tp3d-annot-row__select`);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length === 2);
  const grip = await gripCentre(page, 'end');
  await click(page, grip);
  await page.waitForFunction(() => window.probe.AnnotationTool.isActive());
  await setShowAnnotations(page, false);
  await expectOff('a pending re-attach');
  await turnOnAndReopen('a pending re-attach');

  // 4. A marker drag still in progress (the button is still held down), then the release after Off.
  const marker = await pinCentreOf(page);
  await page.mouse.move(marker.x, marker.y);
  await page.mouse.down();
  await page.mouse.move(marker.x + 40, marker.y + 25, { steps: 4 });
  await page.mouse.move(marker.x + 80, marker.y + 50, { steps: 4 });
  await page.waitForFunction(() => { const ring = document.querySelector('.tp3d-annot-svg__ghost'); return Boolean(ring) && ring.style.display !== 'none'; });
  await setShowAnnotations(page, false);
  await page.mouse.up();
  await expectOff('a marker drag');
  await turnOnAndReopen('a marker drag');

  // 5. A selected annotation is deselected, never restored by turning the setting back On.
  await page.click('.tp3d-annot-row:nth-child(1) .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  await setShowAnnotations(page, false);
  await expectOff('a selection');
  await turnOnAndReopen('a selection');

  // While Off nothing answers: the marker's old position is just the 3D view, and the tool cannot be opened.
  await setShowAnnotations(page, false);
  assert.equal(await escapeConsumed(page), false, 'Escape belongs to the Editor again');
  await click(page, marker);
  assert.equal(await nothingUnderway(page), true, 'a click where the marker was selects no annotation');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-b'], 'it reaches the 3D view and selects the cargo under it');
  await page.evaluate(() => window.probe.InteractionManager.setSelection([]));
  assert.deepEqual(await page.evaluate(() => [window.probe.AnnotationTool.openPanel(), window.probe.AnnotationTool.togglePanel()]), [false, false], 'the panel cannot be opened');
  assert.equal(await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden), true);
  const stack = await page.locator('#editor-zoom-controls > button:not([hidden])').evaluateAll(buttons => buttons.map(b => b.id));
  assert.deepEqual(stack, ['btn-editor-measure', 'btn-editor-view', 'btn-editor-zoom-in', 'btn-editor-zoom-out'], 'the other controls keep their order and their own preferences');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('btn-editor-measure')).borderTopWidth), '0px', 'the first visible button carries no stray separator');
  await expectOff('while Off');

  // The view mode is independent: Show Off set before the setting went Off is still Off afterwards.
  await setShowAnnotations(page, true);
  await drawnAsSaved();
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  await showButton(page, 'Off').click();
  await page.waitForFunction(() => /hidden in the view/i.test(window.probe.hint()));
  await setShowAnnotations(page, false);
  await setShowAnnotations(page, true);
  assert.deepEqual(await layerGraphics(page), { hidden: false, pins: 0, cards: 0, arrows: 0, grips: 0 }, 'the Show Off view mode is kept: nothing is drawn');
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  await showButton(page, 'All').click();
  await drawnAsSaved();

  // Ordinary use resumes: a callout is placed and saved the usual way, as exactly one record.
  await page.click('.tp3d-annot-seg__btn[data-tool="callout"]');
  await page.waitForFunction(() => /place a callout/i.test(window.probe.hint()));
  const saved = await addCallout(page, await freePoint(page, [[150, 0, -10], [470, 0, -5], [380, 0, 60]]), 'After re-enable');
  assert.equal(saved.title, 'After re-enable');
  assert.equal(await count(page), 4);
  assert.equal(JSON.parse(base.json)[1].hidden, true);
  assert.equal(await page.evaluate(() => window.probe.annotations()[1].hidden), true, 'the callout that was hidden by its owner is still hidden');
  assert.deepEqual(errors, []);
});

test('Show Annotations is a visibility-only change: no Editor render, scene sync, theme refresh, camera or selection change; it follows the other three switches in the group; a saved Off holds after a workspace replacement and a fresh start', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  await cameraSettled(page);
  await seed(page, [{ title: 'Kept', ...TOP_OF_B }]);
  await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1 &&
    document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 1);
  await cameraSettled(page);
  const base = await annotationState(page);

  // Count every heavy Editor path, and record which store keys each preference write touches.
  await page.evaluate(() => {
    const { EditorUI, CaseScene, SceneManager, StateStore } = window.probe;
    const spy = { render: 0, sync: 0, theme: 0, writes: [], results: StateStore.get('autoPackResults') };
    for (const [owner, name, key] of [[EditorUI, 'render', 'render'], [CaseScene, 'sync', 'sync'], [SceneManager, 'refreshTheme', 'theme']]) {
      const original = owner[name];
      owner[name] = (...args) => { spy[key] += 1; return original.apply(owner, args); };
    }
    StateStore.subscribe((changes, _state, notification) => spy.writes.push({ keys: Object.keys(changes).sort().join(','), route: notification?.type ?? null }));
    window.__spy = spy;
  });
  const spyNow = () => page.evaluate(() => ({ render: window.__spy.render, sync: window.__spy.sync, theme: window.__spy.theme, writes: window.__spy.writes.slice() }));
  const scene = () => page.evaluate(() => ({ objects: window.probe.sceneObjectCount(), selection: window.probe.selection(), camera: window.probe.camera() }));
  const sceneBefore = await scene();

  await setShowAnnotations(page, false);
  assert.equal(await annotationsButtonShown(page), false);
  assert.deepEqual((await layerGraphics(page)).arrows + (await layerGraphics(page)).pins, 0, 'every saved callout and arrow is off the view');
  await setShowAnnotations(page, true);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1);
  const light = await spyNow();
  assert.deepEqual([light.render, light.sync, light.theme], [0, 0, 0], 'no Editor render, no scene sync and no theme refresh');
  assert.deepEqual(light.writes, [
    { keys: 'preferences', route: 'viewport-controls-preference' },
    { keys: 'preferences', route: 'viewport-controls-preference' },
  ], 'only the preference changed, on the lightweight route: no Pack, cargo, selection or AutoPack Results state');
  assert.deepEqual(await scene(), sceneBefore, 'scene objects, selection and camera are untouched');
  assert.equal(await page.evaluate(() => window.probe.StateStore.get('autoPackResults') === window.__spy.results), true, 'AutoPack Results state is the same object');
  assert.deepEqual(await annotationState(page), base, 'no record, Load Plan timestamp or cargo changed');

  // Saved together with another preference it takes the ordinary route and still ends up applied.
  await page.evaluate(() => {
    const { PreferencesManager } = window.probe;
    PreferencesManager.set({ ...PreferencesManager.get(), showAnnotations: false, labelFontSize: 16 });
  });
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').hidden);
  assert.ok((await spyNow()).render > 0, 'a mixed save renders the Editor');
  assert.equal(await annotationsButtonShown(page), false, 'and Annotations is still hidden by it');
  assert.deepEqual(await layerGraphics(page), { hidden: true, pins: 0, cards: 0, arrows: 0, grips: 0 });
  await page.evaluate(() => {
    const { PreferencesManager } = window.probe;
    PreferencesManager.set({ ...PreferencesManager.get(), showAnnotations: true, labelFontSize: 12 });
  });
  await page.waitForFunction(() => !document.getElementById('btn-editor-annotations').hidden &&
    document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1);

  // The four switches are independent, and the floating group stays only while one is On.
  const setPref = (key, value) => page.evaluate(([name, on]) => {
    const { PreferencesManager } = window.probe;
    PreferencesManager.set({ ...PreferencesManager.get(), [name]: on });
  }, [key, value]);
  const groupShown = () => page.evaluate(() => getComputedStyle(document.getElementById('editor-zoom-controls')).display !== 'none');
  const visibleButtons = () => page.locator('#editor-zoom-controls > button:not([hidden])').evaluateAll(buttons => buttons.map(b => b.id));
  await setPref('showMeasurementTool', false);
  assert.deepEqual(await visibleButtons(), ['btn-editor-annotations', 'btn-editor-view', 'btn-editor-zoom-in', 'btn-editor-zoom-out'], 'the ruler alone is hidden');
  await setPref('showCameraControls', false);
  await setPref('showZoomControls', false);
  assert.deepEqual(await visibleButtons(), ['btn-editor-annotations']);
  assert.equal(await groupShown(), true, 'Annotations alone keeps the group');
  await setPref('showAnnotations', false);
  assert.deepEqual(await visibleButtons(), []);
  assert.equal(await groupShown(), false, 'all four Off: the group disappears and leaves no empty frame');
  await setPref('showAnnotations', true);
  assert.deepEqual(await visibleButtons(), ['btn-editor-annotations'], 'turning Annotations back On brings the group back with only that button');
  assert.equal(await groupShown(), true);
  assert.equal(await page.evaluate(() => window.probe.PreferencesManager.get().showMeasurementTool), false, 'the other switches were not touched');
  await setPref('showMeasurementTool', true);
  await setPref('showCameraControls', true);
  await setPref('showZoomControls', true);
  assert.deepEqual(await visibleButtons(), ['btn-editor-annotations', 'btn-editor-measure', 'btn-editor-view', 'btn-editor-zoom-in', 'btn-editor-zoom-out']);

  // Hiding the button while it holds keyboard focus hands focus back to the 3D view.
  await page.focus('#btn-editor-annotations');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-editor-annotations');
  await setPref('showAnnotations', false);
  assert.equal(await page.evaluate(() => { const active = document.activeElement; return active.isConnected && active.id !== 'btn-editor-annotations' && active !== document.body; }), true, 'focus did not fall into the page background');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#viewport'))), true, 'it returned to the 3D view');

  // A workspace replacement (a restore or import) keeps the saved Off.
  await page.evaluate(() => window.probe.StateStore.replace(window.probe.StateStore.snapshot()));
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').hidden);
  assert.deepEqual(await layerGraphics(page), { hidden: true, pins: 0, cards: 0, arrows: 0, grips: 0 });
  assert.equal(await page.evaluate(() => window.probe.PreferencesManager.get().showAnnotations), false);
  assert.equal(await count(page), 2, 'the saved callout and arrow are still stored');
  assert.deepEqual(errors, []);

  // A fresh start with Off already stored: no button and no graphics from the first paint; On draws what was saved.
  const reloaded = await openEditor(browser, undefined, { preferences: { showAnnotations: false } });
  await cameraSettled(reloaded.page);
  assert.equal(await annotationsButtonShown(reloaded.page), false, 'a saved Off is still Off after reload');
  await seed(reloaded.page, [{ title: 'Saved earlier', ...TOP_OF_B }]);
  await seedArrow(reloaded.page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await frames(reloaded.page, 4);
  assert.deepEqual(await layerGraphics(reloaded.page), { hidden: true, pins: 0, cards: 0, arrows: 0, grips: 0 }, 'saved records are not drawn while Off');
  assert.equal(await count(reloaded.page), 2);
  await setShowAnnotations(reloaded.page, true);
  await reloaded.page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length === 1 &&
    document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow:not(.is-preview) .tp3d-annot-arrow__shaft[d]:not([d=""])').length === 1);
  assert.equal(await annotationsButtonShown(reloaded.page), true);
  assert.deepEqual(reloaded.errors, []);
});

// ============================================================================
// Annotations V1B.2 Gate B: freehand drawing interaction and rendering
// ============================================================================
const armDraw = async page => {
  await page.click('.tp3d-annot-seg__btn[data-tool="draw"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
};
const drawState = page => page.evaluate(() => window.probe.AnnotationTool.drawingState());
const rotateEnabled = page => page.evaluate(() => window.probe.SceneManager.getControls().enableRotate);
const draws = page => page.evaluate(() => window.probe.annotations().filter(record => record.type === 'draw'));
const drawGroups = page => page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draws .tp3d-annot-draw')]
  .filter(group => group.querySelector('.tp3d-annot-draw__line').getAttribute('d'))
  .map(group => ({
    id: group.dataset.annotId,
    d: group.querySelector('.tp3d-annot-draw__line').getAttribute('d'),
    occluded: group.classList.contains('is-occluded'),
    selected: group.classList.contains('is-selected'),
    color: group.dataset.color,
    width: group.querySelector('.tp3d-annot-draw__line').style.strokeWidth,
  })));
const previewPath = page => page.evaluate(() => document.querySelector('.tp3d-annot-draw.is-preview .tp3d-annot-draw__line')?.getAttribute('d') || '');
// Screen points of inch positions, each checked to be canvas (not the panel, a card or a control).
async function screenPoints(page, inches) {
  const points = [];
  for (const position of inches) {
    const at = await point(page, ...position);
    const covering = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el === document.querySelector('#viewport canvas') ? '' : `${Math.round(x)},${Math.round(y)} under ${el ? `${el.tagName}.${String((el.className && el.className.baseVal) ?? el.className)}` : 'nothing'}${el && el.closest && el.closest('.error-card') ? ` [${el.closest('.error-card').textContent.slice(0, 240)}]` : ''}`;
    }, at);
    assert.equal(covering, '', `${position.join(',')} is on the canvas, not covered`);
    points.push(at);
  }
  return points;
}
// Press at the first point, move through the others and (by default) release.
async function dragThrough(page, inches, { steps = 4, release = true } = {}) {
  const points = await screenPoints(page, inches);
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const next of points.slice(1)) await page.mouse.move(next.x, next.y, { steps });
  if (release) await page.mouse.up();
  return points;
}
// A page with the Annotations panel open and the Draw tool armed, the camera settled.
async function openDrawing(browser, viewport) {
  const opened = await openEditor(browser, viewport);
  await opened.page.click('#btn-editor-annotations');
  await opened.page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  await armDraw(opened.page);
  return opened;
}
const TOP_STROKE_A = [[52, 32, -28], [70, 32, -14], [88, 32, -26]]; // across the top of cargo-a (x 46..94, z -32..-8)
const FLOOR_STROKE = [[150, 0, -30], [190, 0, 10], [230, 0, -20]]; // open truck floor between the two cargo items
const GROUND_STROKE = [[100, 0, 62], [140, 0, 78], [180, 0, 66]]; // beside the truck

test('freehand Draw mode: a primary drag draws one stroke on a cargo face without orbiting, selecting or moving cargo, and release writes exactly one record', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson(), camera: window.probe.camera(), objects: window.probe.sceneObjectCount(), selection: window.probe.selection(), pixels: window.probe.canvasData() }));
  assert.equal(await rotateEnabled(page), true, 'OrbitControls rotates until Draw is armed');

  // Arming Draw: the three tools exist, Draw is pressed, Draw / Move View appears in Draw mode, and the camera cannot rotate.
  await page.click('.tp3d-annot-seg__btn[data-tool="draw"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
  const panel = await page.evaluate(() => ({
    pressed: document.querySelector('.tp3d-annot-seg__btn[data-tool="draw"]').getAttribute('aria-pressed'),
    mode: [...document.querySelectorAll('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn')].map(b => [b.textContent, b.getAttribute('aria-pressed')]),
    modeShown: !document.querySelector('.tp3d-annot-panel__drawmode').hidden,
    look: document.querySelector('.tp3d-annot-panel__draw-title')?.textContent,
    lookShown: !document.querySelector('.tp3d-annot-panel__draw').hidden,
    arrowLookShown: Boolean(document.querySelector('.tp3d-annot-panel__arrow')) && !document.querySelector('.tp3d-annot-panel__arrow').hidden,
    cursor: document.querySelector('#viewport canvas').style.cursor,
  }));
  assert.equal(panel.pressed, 'true');
  assert.deepEqual(panel.mode, [['Draw', 'true'], ['Move View', 'false']]);
  assert.equal(panel.modeShown, true);
  assert.equal(panel.look, 'New Drawing — Defaults');
  assert.equal(panel.lookShown, true);
  assert.equal(panel.arrowLookShown, false, 'the arrow look controls stay out of the way');
  assert.equal(panel.cursor, 'crosshair');
  assert.equal(await rotateEnabled(page), false, 'a primary drag does not rotate the camera while drawing');
  assert.match(await page.evaluate(() => window.probe.hint()), /drag across cargo/i);

  // An unfinished stroke is only on screen, and a repaint is one path; releasing writes exactly one record.
  const points = await dragThrough(page, TOP_STROKE_A, { release: false });
  assert.equal(await drawState(page), 'stroking');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-draw.is-preview .tp3d-annot-draw__line')?.getAttribute('d'));
  assert.match(await previewPath(page), /^M[-\d.]+ [-\d.]+(L[-\d.]+ [-\d.]+)+$/, 'the stroke so far is one finite path');
  assert.equal(await count(page), 0, 'nothing is stored while the button is down');
  assert.equal(await page.evaluate(() => window.probe.sceneObjectCount()), before.objects, 'the stroke is SVG: no scene object is added');
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await drawState(page), 'armed', 'the tool stays armed after a save');
  const [saved] = await draws(page);
  assert.equal(saved.type, 'draw');
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.face, '+y', 'the top of the cargo, read from the hit triangle');
  assert.equal(saved.anchor.kind, 'cargo');
  assert.equal(saved.anchor.instanceId, 'cargo-a');
  assert.equal(saved.color, 'ink');
  assert.equal(saved.width, 'regular');
  assert.ok(saved.points.length >= 2 && saved.points.length % 2 === 0, 'vertices after the anchor, as u, v pairs');
  for (let i = 0; i < saved.points.length; i += 2) {
    assert.ok(Math.abs(saved.points[i]) <= 24.011 && Math.abs(saved.points[i + 1]) <= 12.011, `vertex ${i / 2 + 1} is on the 48 x 24 in face`);
    assert.equal(Math.round(saved.points[i] * 100) / 100, saved.points[i], 'on the 0.01 in grid');
  }
  assert.ok(Math.abs(saved.anchor.local.x - -18) < 1.5 && Math.abs(saved.anchor.local.z - -8) < 1.5, 'the first vertex is where the button went down');
  // The camera did not orbit, cargo did not move or get selected, and the path of the saved stroke is on screen.
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'no orbit');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is untouched');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), before.selection, 'cargo was not selected');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 1);
  const groups = await drawGroups(page);
  assert.equal(groups.length, 1);
  assert.match(groups[0].d, /^M[-\d.]+ [-\d.]+(L[-\d.]+ [-\d.]+)+$/);
  assert.equal(groups[0].selected, false, 'a saved stroke is not selected');
  assert.equal(await previewPath(page), '', 'the preview is gone');
  assert.equal(await page.evaluate(() => window.probe.sceneObjectCount()), before.objects, 'still no scene object');
  // The stroke is in the DOM / SVG overlay only, so nothing that reads the canvas (screenshot, PDF, thumbnail, AutoPack preview) sees it.
  assert.equal(await page.evaluate(() => window.probe.canvasData()), before.pixels, 'the canvas pixels are exactly as they were before the stroke');
  assert.match(await page.evaluate(() => window.probe.hint()), /drawing saved/i);
  const row = await rowOf(page, 0);
  assert.equal(row.name, 'Drawing 1');
  assert.equal(row.selected, false);
  assert.equal(row.flagged, false);

  // Another drag adds another record: the tool is still armed.
  await dragThrough(page, [[56, 32, -12], [84, 32, -20]]);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.equal((await draws(page)).length, 2);
  assert.deepEqual(await page.evaluate(() => window.probe.annotations().map(r => r.type)), ['draw', 'draw']);
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera);

  // Escape: the armed tool ends, the camera can rotate again, the records stay.
  assert.equal(await escapeConsumed(page), true);
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal(await rotateEnabled(page), true, 'rotation is back exactly as it was');
  assert.equal(await count(page), 2);
  assert.deepEqual(errors, []);
});

test('Phase 0: opening a callout for editing while Draw is armed ends Draw, restores the camera, writes no stroke, and a later deliberate Drawing still works', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  await seed(page, [{ title: 'Edit while drawing', ground: [260, 80] }]);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 1);
  const before = await page.evaluate(() => ({ cases: window.probe.casesJson() }));

  // Draw is armed (the camera gate is on), then the saved callout is selected and its editor opened.
  await armDraw(page);
  assert.equal(await rotateEnabled(page), false, 'Draw armed: a primary drag draws, so the camera gate is on');
  await page.click('.tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected [data-act="edit"]');
  await page.click('.tp3d-annot-card.is-selected [data-act="edit"]');
  await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
  assert.equal(await drawState(page), 'off', 'opening the callout editor ends the armed Draw tool');
  assert.equal(await rotateEnabled(page), true, 'the camera gate is released through the existing mechanism');
  assert.equal(await page.inputValue('.tp3d-annot-editor__input'), 'Edit while drawing');

  // A drag over open ground while the editor is open never creates a Drawing (a drag on cargo would be ordinary cargo movement).
  await dragThrough(page, GROUND_STROKE);
  assert.equal(await count(page), 1, 'a drag while editing a callout writes no record');
  assert.equal(await page.evaluate(() => window.probe.annotations().some(r => r.type === 'draw')), false);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is untouched');

  // The draft is intact: saving changes only the callout's title.
  await page.fill('.tp3d-annot-editor__input', 'Edited after Draw');
  await page.click('.tp3d-annot-btn--primary');
  await page.waitForFunction(() => window.probe.annotations()[0].title === 'Edited after Draw');
  assert.equal(await count(page), 1, 'saving the edit does not create another annotation');
  assert.equal(await page.evaluate(() => window.probe.annotations()[0].type), 'callout');

  // A deliberate Drawing afterwards works.
  await armDraw(page);
  await dragThrough(page, TOP_STROKE_A);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.deepEqual(await page.evaluate(() => window.probe.annotations().map(r => r.type)), ['callout', 'draw']);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is untouched');
  assert.deepEqual(errors, []);
});

test('freehand Move View, modified drags, the wheel and the other buttons keep navigating, and none of them starts a stroke', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  const start = await page.evaluate(() => window.probe.camera());
  const at = await screenPoints(page, [[70, 32, -20]]).then(list => list[0]);
  const settledCamera = async () => { await cameraSettled(page); return page.evaluate(() => window.probe.camera()); };

  // Draw mode: a plain drag draws (no orbit); with Shift, Ctrl or Cmd it pans instead and never draws.
  for (const [name, key] of [['Shift', 'Shift'], ['Ctrl', 'Control'], ['Cmd', 'Meta']]) {
    const camera = await settledCamera();
    await page.keyboard.down(key);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    assert.equal(await drawState(page), 'armed', `${name} + press does not start a stroke`);
    await page.mouse.move(at.x + 50, at.y + 30, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up(key);
    assert.notEqual(await settledCamera(), camera, `${name} + drag navigates the camera`);
    assert.equal(await count(page), 0, `${name} + drag wrote nothing`);
    assert.equal(await rotateEnabled(page), false, 'Draw mode is unchanged by a modified drag');
  }

  // The wheel still zooms, and the right button still pans, in Draw mode.
  const zoomFrom = await settledCamera();
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -240);
  assert.notEqual(await settledCamera(), zoomFrom, 'the wheel zooms while Draw is armed');
  const panFrom = await settledCamera();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(at.x + 40, at.y + 20, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  assert.notEqual(await settledCamera(), panFrom, 'the right button pans while Draw is armed');
  assert.equal(await count(page), 0);
  assert.equal(await drawState(page), 'armed');

  // Move View: rotation is back, a plain drag orbits, no stroke can start, the saved strokes would stay drawn.
  await page.click('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="move"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'move');
  assert.equal(await rotateEnabled(page), true, 'Move View restores rotation');
  assert.match(await page.evaluate(() => window.probe.hint()), /Move View/);
  assert.notEqual(await page.evaluate(() => document.querySelector('#viewport canvas').style.cursor), 'crosshair');
  const orbitFrom = await settledCamera();
  const moved = await screenPoints(page, [[70, 32, -20]]).then(list => list[0]);
  await page.mouse.move(moved.x, moved.y);
  await page.mouse.down();
  assert.equal(await drawState(page), 'move', 'a press in Move View starts nothing');
  await page.mouse.move(moved.x + 60, moved.y + 10, { steps: 8 });
  await page.mouse.up();
  assert.notEqual(await settledCamera(), orbitFrom, 'a plain drag orbits in Move View');
  assert.equal(await count(page), 0);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'Move View does not select cargo either');

  // Back to Draw: rotation off again; the tool owner is one control, not two.
  await page.click('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="draw"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
  assert.equal(await rotateEnabled(page), false);
  assert.notEqual(start, await page.evaluate(() => window.probe.camera()));
  assert.deepEqual(errors, []);
});

test('freehand rotation gate: it changes only enableRotate, restores exactly what it found on every exit, and a replaced controls instance never keeps a disabled state', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const controlsState = () => page.evaluate(() => {
    const c = window.probe.SceneManager.getControls();
    return { rotate: c.enableRotate, zoom: c.enableZoom, pan: c.enablePan, enabled: c.enabled, damping: c.enableDamping, mouse: JSON.stringify(c.mouseButtons), touches: JSON.stringify(c.touches) };
  });
  const untouched = await controlsState();
  assert.equal(untouched.rotate, true);

  // Arming changes enableRotate and nothing else; every way out of Draw ownership puts it back.
  const exits = {
    'Escape': async () => { assert.equal(await escapeConsumed(page), true); },
    'another tool': async () => { await page.click('.tp3d-annot-seg__btn[data-tool="callout"]'); },
    'Move View': async () => { await page.click('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="move"]'); },
    'closing the panel': async () => { await page.click('#btn-editor-annotations'); },
  };
  for (const [name, exit] of Object.entries(exits)) {
    if (await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden)) await page.click('#btn-editor-annotations');
    await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
    // Move View leaves the tool armed (a button press would now disarm it): start every round from "no tool".
    if (await drawState(page) !== 'off') {
      assert.equal(await escapeConsumed(page), true);
      await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
    }
    await armDraw(page);
    const armed = await controlsState();
    assert.equal(armed.rotate, false, `${name}: rotation is off while Draw is armed`);
    assert.deepEqual({ ...armed, rotate: true }, untouched, `${name}: nothing but enableRotate changed`);
    await exit();
    await page.waitForFunction(() => window.probe.SceneManager.getControls().enableRotate === true);
    assert.deepEqual(await controlsState(), untouched, `${name}: everything is exactly as it was found`);
  }

  // Show Annotations Off through the real segmented control.
  if (await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden)) await page.click('#btn-editor-annotations');
  await armDraw(page);
  assert.equal(await rotateEnabled(page), false);
  await page.click('.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("Off")');
  await page.waitForFunction(() => window.probe.SceneManager.getControls().enableRotate === true);
  assert.equal(await drawState(page), 'off', 'Show Off ends the tool');
  await page.click('.tp3d-annot-seg--show .tp3d-annot-seg__btn:has-text("All")');

  // A rotation that was already off stays off: the gate never restores a blind `true`.
  await page.evaluate(() => { window.probe.SceneManager.getControls().enableRotate = false; });
  await armDraw(page);
  assert.equal(await rotateEnabled(page), false);
  assert.equal(await escapeConsumed(page), true);
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal(await rotateEnabled(page), false, 'the earlier value (off) is the one restored');
  await page.evaluate(() => { window.probe.SceneManager.getControls().enableRotate = true; });

  // A value another owner set after the gate closed is theirs; the gate does not touch it.
  await armDraw(page);
  await page.evaluate(() => {
    window.probe.SceneManager.getControls().enableRotate = true; // another owner turns rotation on
    document.getElementById('viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal(await rotateEnabled(page), true);

  // A replaced controls instance: the old one is released at once, the new one is gated, neither is left disabled.
  await armDraw(page);
  await page.evaluate(() => {
    const { SceneManager } = window.probe;
    const original = SceneManager.getControls;
    const first = original.call(SceneManager);
    const replacement = { enableRotate: true, marker: 'replacement' };
    window.__controlsSwap = { original, first, replacement };
    SceneManager.getControls = () => replacement;
  });
  await page.waitForFunction(() => window.__controlsSwap.replacement.enableRotate === false);
  assert.equal(await page.evaluate(() => window.__controlsSwap.first.enableRotate), true, 'the instance that went away was released');
  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await page.waitForFunction(() => window.__controlsSwap.replacement.enableRotate === true);
  await page.evaluate(() => { window.probe.SceneManager.getControls = window.__controlsSwap.original; });
  assert.equal(await rotateEnabled(page), true, 'the real controls rotate again');
  assert.deepEqual(await controlsState(), untouched);
  assert.deepEqual(errors, []);
});

// Frame the camera on a world point from a world-inch offset, the way a user would orbit and zoom there.
const aimCamera = async (page, target, offset, { settle = true } = {}) => {
  await page.evaluate(({ target, offset }) => {
    const { SceneManager } = window.probe;
    const controls = SceneManager.getControls();
    const camera = SceneManager.getCamera();
    const at = SceneManager.vecInchesToWorld({ x: target[0], y: target[1], z: target[2] });
    const from = SceneManager.vecInchesToWorld({ x: target[0] + offset[0], y: target[1] + offset[1], z: target[2] + offset[2] });
    controls.target.copy(at);
    camera.position.copy(from);
    camera.lookAt(at);
    controls.update();
  }, { target, offset });
  if (settle) await cameraSettled(page);
};
// Steps small enough that no two consecutive pointer samples are further apart than a stroke may jump.
const stepsFor = (from, to) => Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 14));
async function dragSmooth(page, inches, { release = true } = {}) {
  const points = await screenPoints(page, inches);
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i += 1) await page.mouse.move(points[i].x, points[i].y, { steps: stepsFor(points[i - 1], points[i]) });
  if (release) await page.mouse.up();
  return points;
}
const lastDraw = async page => (await draws(page)).at(-1);
const quiet = page => page.waitForTimeout(250);

test('freehand surfaces: the truck floor, the ground and a truck wall take a stroke on their own surface, and every record stays on the surface it started on', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  const cargoBefore = await page.evaluate(() => window.probe.casesJson());
  const objects = await page.evaluate(() => window.probe.sceneObjectCount());

  // The truck floor.
  await dragSmooth(page, FLOOR_STROKE);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const floor = await lastDraw(page);
  assert.equal(floor.type, 'draw');
  assert.equal(floor.anchor.kind, 'floor', 'the truck floor is a floor surface');
  assert.ok(floor.points.length >= 2);
  assert.ok(Math.hypot(floor.anchor.position.x - FLOOR_STROKE[0][0], floor.anchor.position.z - FLOOR_STROKE[0][2]) < 4, 'the stroke starts where the button went down');
  assert.equal(floor.anchor.position.y, 0);
  const last = [floor.points.at(-2), floor.points.at(-1)];
  assert.ok(Math.hypot(last[0] - FLOOR_STROKE.at(-1)[0], last[1] - FLOOR_STROKE.at(-1)[2]) < 6, 'and ends where it was released');

  // The ground beside the truck.
  await dragSmooth(page, GROUND_STROKE);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  const ground = await lastDraw(page);
  assert.equal(ground.anchor.kind, 'space');
  assert.equal(ground.anchor.surface, 'ground');

  // A truck wall: the far side wall seen from the default view.
  const wall = [[150, 20, -51], [190, 50, -51], [230, 30, -51]];
  await dragSmooth(page, wall);
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  const side = await lastDraw(page);
  assert.equal(side.anchor.kind, 'space');
  assert.match(side.anchor.surface, /^wall-/);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore, 'no cargo was touched');
  assert.equal(await page.evaluate(() => window.probe.sceneObjectCount()), objects, 'no scene object was added');
  assert.deepEqual(await page.evaluate(() => window.probe.annotations().map(r => r.type)), ['draw', 'draw', 'draw']);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 3);

  // A stroke that is dragged from the floor onto cargo stops where the cargo is: it is never moved onto that cargo's face.
  const before = (await draws(page)).length;
  const cargoTop = await point(page, 70, 32, -20);
  const start = await point(page, 70, 0, 14);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(cargoTop.x, cargoTop.y, { steps: stepsFor(start, cargoTop) });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'frozen');
  assert.match(await page.evaluate(() => window.probe.hint()), /in the way|edge/i);
  await page.mouse.move(start.x + 30, start.y + 6, { steps: 4 });
  assert.equal(await drawState(page), 'frozen', 'a frozen stroke never resumes');
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
  const dragged = (await draws(page));
  assert.equal(dragged.length, before + 1);
  assert.equal(dragged.at(-1).anchor.kind, 'floor', 'it stayed on the floor');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore);
  assert.deepEqual(errors, []);
});

test('freehand cylinder and drum cargo take a stroke on an end cap, refuse the curved side, and a cap stroke ends on the 24-sided rim', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  // Cargo A becomes a drum: axis along its length (x), end caps at x = 70 +/- 24, radius half the smaller of width and height.
  await page.evaluate(() => {
    const { StateStore, PackLibrary } = window.probe;
    const caseId = PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a').caseId;
    StateStore.set({ caseLibrary: StateStore.get('caseLibrary').map(c => (c.id === caseId ? { ...c, shape: 'drum' } : c)) }, { skipHistory: true });
  });
  await armDraw(page);
  await aimCamera(page, [94, 16, -20], [150, 40, 30]);
  const info = await page.evaluate(() => {
    const { PackLibrary, CaseLibrary } = window.probe;
    const inst = PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
    const c = CaseLibrary.getById(inst.caseId);
    return { shape: c.shape, length: c.dimensions.length, width: c.dimensions.width, height: c.dimensions.height };
  });
  const radius = Math.min(info.width, info.height) / 2;
  assert.equal(info.shape, 'drum');
  const capX = 70 + info.length / 2;
  const centre = [capX, info.height / 2, -20];

  // The curved side: refused, nothing stored, the tool stays armed.
  const sideAt = await screenPoints(page, [[70, info.height / 2 + radius - 0.5, -20]]).then(list => list[0]);
  await page.mouse.move(sideAt.x, sideAt.y);
  await page.mouse.down();
  assert.equal(await drawState(page), 'armed', 'a press on the curved side starts nothing');
  await page.mouse.move(sideAt.x + 40, sideAt.y + 10, { steps: 5 });
  await page.mouse.up();
  assert.equal(await count(page), 0);
  assert.match(await page.evaluate(() => document.querySelector('.tp3d-annot-panel__hint, .tp3d-annot-panel__status')?.textContent || window.probe.hint()), /curved|end cap|cannot take/i);

  // The end cap: a stroke inside the rim is saved on the cap's own face.
  const inside = [[capX, centre[1] - 3, centre[2] - 6], [capX, centre[1] + 3, centre[2] - 1], [capX, centre[1] + 1, centre[2] + 6]];
  await dragSmooth(page, inside);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const cap = await lastDraw(page);
  assert.equal(cap.face, '+x', 'the +x end cap');
  assert.equal(cap.anchor.kind, 'cargo');
  assert.equal(cap.anchor.instanceId, 'cargo-a');
  for (let i = 0; i < cap.points.length; i += 2) {
    assert.ok(Math.hypot(cap.points[i], cap.points[i + 1]) <= radius + 0.011, 'every vertex is inside the cap');
  }

  // Running off the rim: the stroke stops exactly on the rim (the 24-gon, not the bounding box) and stays stopped.
  const toRim = [[capX, centre[1], centre[2]], [capX, centre[1], centre[2] + radius + 8]];
  const pts = await screenPoints(page, toRim);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  await page.mouse.move(pts[1].x, pts[1].y, { steps: stepsFor(pts[0], pts[1]) });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'frozen');
  assert.match(await page.evaluate(() => window.probe.hint()), /edge/i);
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  const rim = await lastDraw(page);
  const end = [rim.points.at(-2), rim.points.at(-1)];
  const apothem = radius * Math.cos(Math.PI / 24);
  const reach = Math.hypot(end[0], end[1]);
  assert.ok(reach <= radius + 0.011 && reach >= apothem - 0.05, `the last vertex is on the rim (${reach.toFixed(2)} in from the axis, rim ${apothem.toFixed(2)}..${radius.toFixed(2)})`);
  assert.deepEqual(errors, []);
});

// Count every annotation write while a gesture runs: a stroke must be one write, or none. (Camera saves and cargo edits are
// other writes and are not counted.)
const watchWrites = page => page.evaluate(() => {
  window.__writes = 0;
  if (window.__unwatchWrites) window.__unwatchWrites();
  window.__unwatchWrites = window.probe.StateStore.subscribe((changes, next, notification) => {
    if (notification && notification.type === 'pack-annotations') window.__writes += 1;
  });
});
const writes = page => page.evaluate(() => window.__writes);
// The id of the mouse pointer as the page sees it (Playwright's mouse is one pointer).
const watchPointer = page => page.evaluate(() => {
  window.__pointerId = null;
  window.addEventListener('pointerdown', ev => { window.__pointerId = ev.pointerId; }, true);
});
const pointerId = page => page.evaluate(() => window.__pointerId);

test('freehand freezes: the stroke ends where the surface ends, where something stands in front, or where the pointer jumped, and it never resumes; too-short strokes write nothing', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  await watchWrites(page);

  // Edge: dragging across the +x edge of the top face (local x = 24) ends the stroke exactly on that edge, and coming back does not resume it.
  const edge = await screenPoints(page, [[56, 32, -22], [84, 32, -22], [108, 32, -22]]);
  await page.mouse.move(edge[0].x, edge[0].y);
  await page.mouse.down();
  await page.mouse.move(edge[1].x, edge[1].y, { steps: stepsFor(edge[0], edge[1]) });
  await page.mouse.move(edge[2].x, edge[2].y, { steps: stepsFor(edge[1], edge[2]) });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'frozen');
  assert.match(await page.evaluate(() => window.probe.hint()), /edge of the surface/i);
  const frozenPreview = await previewPath(page);
  await page.mouse.move(edge[0].x, edge[0].y, { steps: stepsFor(edge[2], edge[0]) });
  assert.equal(await drawState(page), 'frozen', 'it does not resume when the pointer comes back onto the face');
  assert.equal(await previewPath(page), frozenPreview, 'and the preview does not grow');
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await writes(page), 1, 'one write for the whole gesture');
  const edgeStroke = await lastDraw(page);
  assert.equal(edgeStroke.face, '+y');
  assert.ok(Math.abs(edgeStroke.points.at(-2) - 24) <= 0.011, `the last vertex is on the edge (u ${edgeStroke.points.at(-2)})`);
  assert.ok(Math.abs(edgeStroke.points.at(-1) - -2) <= 1.5, 'and on the line that was drawn');
  assert.equal(await drawState(page), 'armed');

  // Occluder: a floor stroke dragged under cargo stops where the cargo begins.
  const floorStart = await point(page, 70, 0, 20);
  const underCargo = await point(page, 70, 32, -20);
  await page.mouse.move(floorStart.x, floorStart.y);
  await page.mouse.down();
  await page.mouse.move(underCargo.x, underCargo.y, { steps: stepsFor(floorStart, underCargo) });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'frozen');
  assert.match(await page.evaluate(() => window.probe.hint()), /in the way/i);
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.equal(await writes(page), 2);
  const floorStroke = await lastDraw(page);
  assert.equal(floorStroke.anchor.kind, 'floor');
  assert.equal(floorStroke.anchor.position.y, 0);

  // Excessive gap: a jump of well over 160 px freezes the stroke at the last verified sample.
  const gapStart = await screenPoints(page, [[150, 0, -30], [162, 0, -22]]);
  let jump = null;
  for (const candidate of [[400, 0, 40], [450, 0, 30], [500, 0, -20], [330, 0, 45], [250, 0, 45]]) {
    const at = await point(page, ...candidate);
    const clear = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), at);
    if (clear && Math.hypot(at.x - gapStart[1].x, at.y - gapStart[1].y) > 180) { jump = at; break; }
  }
  assert.ok(jump, 'a floor point wider than a stroke may cross is on the canvas');
  const gap = [gapStart[0], gapStart[1], jump];
  await page.mouse.move(gap[0].x, gap[0].y);
  await page.mouse.down();
  await page.mouse.move(gap[1].x, gap[1].y, { steps: stepsFor(gap[0], gap[1]) });
  await page.mouse.move(gap[2].x, gap[2].y, { steps: 1 });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'frozen');
  assert.match(await page.evaluate(() => window.probe.hint()), /too fast/i);
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  const gapStroke = await lastDraw(page);
  assert.ok(Math.hypot(gapStroke.points.at(-2) - 162, gapStroke.points.at(-1) - -22) < 4, 'it ends before the jump');
  assert.equal(await writes(page), 3);

  // Leaving the view freezes a stroke too (the pointer goes off the canvas).
  const inView = await screenPoints(page, [[150, 0, -10], [190, 0, 0]]);
  const box = await page.evaluate(() => window.probe.box('#viewport canvas'));
  await page.mouse.move(inView[0].x, inView[0].y);
  await page.mouse.down();
  await page.mouse.move(inView[1].x, inView[1].y, { steps: stepsFor(inView[0], inView[1]) });
  await page.mouse.move(box.x + box.w * 0.5, box.y - 40, { steps: 12 });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'frozen');
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 4);
  assert.equal(await writes(page), 4);
  assert.deepEqual(errors, []);
});

test('freehand minimum length and taps: a click or a drag shorter than an inch writes nothing, a stroke past it writes one record', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await watchWrites(page);
  // Close in on the top of cargo A: an inch is about twenty pixels here, so a few pixels is far under the minimum length.
  await aimCamera(page, [70, 32, -20], [0, 40, 40]);
  const perInch = await page.evaluate(() => {
    const a = window.probe.screenOf(60, 32, -20);
    const b = window.probe.screenOf(70, 32, -20);
    return Math.hypot(a.x - b.x, a.y - b.y) / 10;
  });
  assert.ok(perInch > 6, `an inch is ${perInch.toFixed(1)} px: close enough for a 5 px drag to be under an inch`);
  const at = await screenPoints(page, [[66, 32, -20]]).then(list => list[0]);

  // A click: no sample at all.
  await click(page, at);
  assert.equal(await count(page), 0);
  assert.equal(await writes(page), 0, 'a tap writes nothing');
  assert.equal(await drawState(page), 'armed');

  // A few pixels: one sample, shorter than the minimum length, refused by the writer without a record.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 5, at.y, { steps: 2 });
  await page.mouse.up();
  await page.waitForFunction(() => /too short/i.test(window.probe.hint()) || document.querySelector('.tp3d-toast, .toast'));
  assert.equal(await count(page), 0, 'a stroke under the minimum length is not stored');
  assert.equal(await writes(page), 0);
  assert.equal(await drawState(page), 'armed', 'and the tool stays armed');

  // Past the minimum: stored.
  await dragSmooth(page, [[58, 32, -28], [66, 32, -26]]);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await writes(page), 1);
  assert.deepEqual(errors, []);
});

test('freehand cancellation: every interruption ends the unfinished stroke without a write, none can bring it back, and a normal camera move does not cancel one', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  await watchWrites(page);
  await watchPointer(page);
  let hold = await screenPoints(page, TOP_STROKE_A);
  const toolButtonClick = selector => page.evaluate(sel => document.querySelector(sel).click(), selector);
  // Start a stroke and keep the button down, with a visible preview.
  const begin = async () => {
    hold = await screenPoints(page, TOP_STROKE_A);
    await page.mouse.move(hold[0].x, hold[0].y);
    await page.mouse.down();
    await page.mouse.move(hold[1].x, hold[1].y, { steps: 4 });
    await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'stroking');
    await page.waitForFunction(() => document.querySelector('.tp3d-annot-draw.is-preview .tp3d-annot-draw__line')?.getAttribute('d'));
  };
  // After the interruption: nothing stored, nothing on screen, the rest of the gesture (more moves, the release) does nothing.
  const afterwards = async (name, expected) => {
    await page.waitForFunction(want => window.probe.AnnotationTool.drawingState() === want, expected);
    assert.equal(await previewPath(page), '', `${name}: no preview is left`);
    // Writes the trigger itself made (moving cargo, another Load Plan) are not the stroke's: count from here.
    const base = await writes(page);
    await page.mouse.move(hold[2].x, hold[2].y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await count(page), 0, `${name}: nothing was written`);
    assert.equal(await writes(page), base, `${name}: the stroke wrote nothing, not even an empty record`);
    assert.equal(await previewPath(page), '', `${name}: the rest of the gesture brought nothing back`);
    assert.equal(await drawState(page), expected, `${name}: the state is unchanged by the rest of the gesture`);
  };
  // Back to an armed Draw tool in an open panel.
  const rearm = async () => {
    if (await page.evaluate(() => document.getElementById('editor-annotation-panel').hidden)) await page.click('#btn-editor-annotations');
    await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
    if (await drawState(page) === 'move') await toolButtonClick('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="draw"]');
    if (await drawState(page) === 'off') await armDraw(page);
    await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
  };
  const cases = [
    ['Escape (the stroke goes before the tool)', async () => { assert.equal(await escapeConsumed(page), true); }, 'armed'],
    ['pointercancel', async () => { await page.evaluate(() => document.querySelector('#viewport canvas').dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__pointerId, bubbles: true }))); }, 'armed'],
    ['a lost pointer capture', async () => { await page.evaluate(() => document.querySelector('#viewport canvas').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: window.__pointerId, bubbles: true }))); }, 'armed'],
    ['a second touch', async () => {
      // Sent to the window, where the stroke listens: OrbitControls tracks real pointers only and is not fed a fake finger.
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: window.__pointerId + 7, pointerType: 'touch', isPrimary: false, bubbles: true, clientX: 300, clientY: 300, button: 0, buttons: 1 }));
      });
    }, 'armed'],
    ['window blur', async () => { await page.evaluate(() => window.dispatchEvent(new Event('blur'))); }, 'armed'],
    ['a hidden document', async () => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }, 'armed', async () => { await page.evaluate(() => { delete document.visibilityState; }); }],
    ['switching tool', async () => { await toolButtonClick('.tp3d-annot-seg__btn[data-tool="callout"]'); }, 'off'],
    ['Move View', async () => { await toolButtonClick('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="move"]'); }, 'move'],
    ['closing the panel', async () => { await toolButtonClick('#btn-editor-annotations'); }, 'off'],
    ['Show Off', async () => { await toolButtonClick('.tp3d-annot-seg--show .tp3d-annot-seg__btn:nth-child(3)'); }, 'off', async () => { await toolButtonClick('.tp3d-annot-seg--show .tp3d-annot-seg__btn:nth-child(1)'); }],
    ['Settings Show Annotations off', async () => { await setShowAnnotations(page, false); }, 'off', async () => { await setShowAnnotations(page, true); }],
    // Since Phase 1 the Measure button only opens the manager; starting a measurement (New) is what takes the scene. These are
    // DOM clicks, like the other toolbar rows: the stroke above holds the pointer down, so a pointer click cannot complete here.
    ['Measurement Mode', async () => {
      if (!(await page.evaluate(() => window.probe.MeasurementTool.isManagerOpen()))) await toolButtonClick('#btn-editor-measure');
      await toolButtonClick('#editor-measure-new');
    }, 'off', async () => { await toolButtonClick('#editor-measure-new'); }],
    ['an AutoPack operation', async () => { await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('autopacking'); }); }, 'off', async () => { await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op)); }],
    ['a transient preview', async () => { await page.evaluate(() => { window.__tp = window.probe.CaseScene.isTransientPreview; window.probe.CaseScene.isTransientPreview = () => true; }); }, 'off', async () => { await page.evaluate(() => { window.probe.CaseScene.isTransientPreview = window.__tp; }); }],
    ['a held cargo pose', async () => { await page.evaluate(() => { window.__hold = window.probe.InteractionManager.hasProvisionalPose; window.probe.InteractionManager.hasProvisionalPose = () => true; }); }, 'armed', async () => { await page.evaluate(() => { window.probe.InteractionManager.hasProvisionalPose = window.__hold; }); }],
    ['cargo moving', async () => {
      await page.evaluate(() => {
        const { PackLibrary } = window.probe;
        const inst = PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
        PackLibrary.updateInstance('fixture-pack', 'cargo-a', { transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x + 30 } } });
      });
    }, 'armed', async () => {
      await page.evaluate(() => {
        const { PackLibrary } = window.probe;
        const inst = PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
        PackLibrary.updateInstance('fixture-pack', 'cargo-a', { transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x - 30 } } });
      });
      await cameraSettled(page);
    }],
    ['a cargo Undo', async () => { await page.evaluate(() => { window.probe.StateStore.set({ selectedInstanceIds: [] }); window.probe.StateStore.undo(); }); }, 'armed'],
    ['another Load Plan', async () => {
      await page.evaluate(() => { const copy = window.probe.PackLibrary.duplicate('fixture-pack'); window.__otherPack = copy.id; window.probe.StateStore.set({ currentPackId: copy.id }, { skipHistory: true }); });
    }, 'off', async () => { await page.evaluate(() => window.probe.StateStore.set({ currentPackId: 'fixture-pack' }, { skipHistory: true })); }],
  ];
  for (const [name, trigger, expected, restore] of cases) {
    try {
      await rearm();
      await cameraSettled(page);
      await begin();
      await trigger();
      await afterwards(name, expected);
      if (restore) await restore();
      await page.evaluate(() => { window.__writes = 0; });
    } catch (error) {
      throw new Error(`[${name}] ${error.message}${errors.length ? `\npage errors: ${errors.join(' || ')}` : ''}`, { cause: error });
    }
  }

  // A normal camera move during a stroke (the wheel) does not cancel it: the stroke is still saved, once.
  await rearm();
  await cameraSettled(page);
  await watchWrites(page);
  await page.mouse.move(hold[0].x, hold[0].y);
  await page.mouse.down();
  await page.mouse.move(hold[1].x, hold[1].y, { steps: 4 });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'stroking');
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);
  assert.equal(await drawState(page), 'stroking', 'a wheel zoom during a stroke does not cancel it');
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await writes(page), 1);

  // Another pointer's moves and release are ignored, and a trailing lost-capture after the save is harmless.
  await cameraSettled(page);
  const again = await screenPoints(page, TOP_STROKE_A);
  await page.mouse.move(again[0].x, again[0].y);
  await page.mouse.down();
  await page.mouse.move(again[1].x, again[1].y, { steps: 4 });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'stroking');
  await page.evaluate(() => {
    const id = window.__pointerId + 5;
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, pointerType: 'touch', isPrimary: false, bubbles: true, clientX: 200, clientY: 200, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, pointerType: 'touch', isPrimary: false, bubbles: true, clientX: 200, clientY: 200 }));
  });
  assert.equal(await drawState(page), 'stroking', "another pointer's move and release do not touch the stroke");
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  await page.evaluate(() => document.querySelector('#viewport canvas').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: window.__pointerId, bubbles: true })));
  await page.evaluate(() => document.querySelector('#viewport canvas').dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__pointerId, bubbles: true })));
  await page.waitForTimeout(150);
  assert.equal(await count(page), 2, 'trailing events after the save change nothing and bring nothing back');
  assert.equal(await writes(page), 2, 'exactly one write per saved stroke');
  assert.equal(await drawState(page), 'armed');
  assert.deepEqual(errors, []);
});

// A drawing saved through the real writer (not the gesture). `local` is the first vertex on the top of cargo A; `rest` are (x, z) pairs.
const seedDraw = (page, { cargo = 'cargo-a', local = { x: -18, y: 16, z: -8 }, face = '+y', rest = [-6, 0, 10, -6, 18, 4], color = 'ink', width = 'regular', style = undefined, ground = null } = {}) => page.evaluate(spec => {
  const { M, PackLibrary, CaseLibrary } = window.probe;
  const pack = PackLibrary.getById('fixture-pack');
  let anchor;
  if (spec.ground) {
    anchor = M.buildSpaceAnchor({ surface: 'ground', point: { x: spec.ground[0], y: 0, z: spec.ground[1] } });
  } else {
    const inst = pack.cases.find(c => c.id === spec.cargo);
    anchor = M.buildCargoAnchor({ instanceId: inst.id, local: spec.local, caseData: CaseLibrary.getById(inst.caseId) });
  }
  const outcome = PackLibrary.addDraw('fixture-pack', { anchor, face: spec.ground ? undefined : spec.face, rawPoints: spec.rest, color: spec.color, width: spec.width, style: spec.style });
  if (!outcome.ok) throw new Error(`draw seed failed: ${outcome.reason}`);
  return outcome.annotation;
}, { cargo, local, face, rest, color, width, style, ground });
const moveCargoA = (page, dx) => page.evaluate(delta => {
  const { PackLibrary } = window.probe;
  const inst = PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a');
  PackLibrary.updateInstance('fixture-pack', 'cargo-a', { transform: { ...inst.transform, position: { ...inst.transform.position, x: inst.transform.position.x + delta } } });
}, dx);
const rowFor = id => `.tp3d-annot-row[data-annot-id="${id}"]`;
const groupFor = (page, id) => drawGroups(page).then(list => list.find(group => group.id === id) || null);
// How many times each stroke's path or its look was written while `action` ran (a drawing is only repainted when it changed).
const watchDrawPaint = page => page.evaluate(() => {
  window.__paint = { d: 0, style: 0 };
  window.__paintObserver?.disconnect();
  window.__paintObserver = new MutationObserver(records => records.forEach(record => {
    if (record.attributeName === 'd') window.__paint.d += 1;
    else window.__paint.style += 1;
  }));
  document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line, .tp3d-annot-draws .tp3d-annot-draw__under').forEach(el => window.__paintObserver.observe(el, { attributes: true }));
});
const paintCount = page => page.evaluate(() => ({ ...window.__paint }));

test('freehand saved strokes: they persist across tool exit and re-entry, follow their cargo, hide with Settings and per stroke, and are managed from the panel without touching cargo or the stroke geometry', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const [onCargo, onGround] = [await seedDraw(page), await seedDraw(page, { ground: [100, 70], rest: [140, 78, 180, 66], color: 'blue', width: 'bold' })];
  const [callout] = await seed(page, [{ title: 'A callout', ground: [520, 10] }]);
  const arrow = await seedArrow(page, [GROUND_B[0], GROUND_B[2]], [GROUND_A[0], GROUND_A[2]]);
  const casesBefore = await page.evaluate(() => window.probe.casesJson());
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 2);

  // Rendering: both drawn from their records, one SVG path each, in the right colors; rows are drawings, not "Unreadable".
  let groups = await drawGroups(page);
  assert.deepEqual(groups.map(g => g.id).sort(), [onCargo.id, onGround.id].sort());
  groups.forEach(g => assert.match(g.d, /^M[-\d.]+ [-\d.]+(L[-\d.]+ [-\d.]+)+$/));
  assert.equal((await groupFor(page, onCargo.id)).color, 'ink');
  assert.equal((await groupFor(page, onGround.id)).color, 'blue');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tp3d-annot-row__name')].map(el => el.textContent)), ['Drawing 1', 'Drawing 2', 'A callout', 'Arrow 1']);
  assert.equal((await arrowGraphics(page)).length, 1, 'the arrow is still drawn');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tp3d-annot-pin:not(.is-draft):not([hidden])').length), 1, 'and so is the callout marker');
  const rowOne = await rowOf(page, 0);
  assert.deepEqual([rowOne.name, rowOne.flagged, rowOne.issueShown, rowOne.selected], ['Drawing 1', false, false, false]);
  assert.doesNotMatch(await page.evaluate(() => document.querySelector('.tp3d-annot-list, .tp3d-annot-panel__list').textContent), /Unreadable|could not be read/);

  // Tool exit and re-entry leave them as they were.
  const drawn = groups.map(g => g.d);
  await armDraw(page);
  assert.deepEqual((await drawGroups(page)).map(g => g.d), drawn);
  assert.equal(await escapeConsumed(page), true);
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.deepEqual((await drawGroups(page)).map(g => g.d), drawn);

  // A stroke on cargo follows it; the record never changes; a stroke on the ground does not move.
  const recordsBefore = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
  await moveCargoA(page, 40);
  await page.waitForFunction(({ id, was }) => [...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id).querySelector('.tp3d-annot-draw__line').getAttribute('d') !== was, { id: onCargo.id, was: drawn[0] });
  assert.equal((await groupFor(page, onGround.id)).d, drawn[1], 'the ground stroke stays put');
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), recordsBefore, 'the records are untouched by a cargo move');
  await moveCargoA(page, -40);
  await page.waitForFunction(({ id, was }) => [...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id).querySelector('.tp3d-annot-draw__line').getAttribute('d') === was, { id: onCargo.id, was: drawn[0] });

  // Settings > Show Annotations Off hides every stroke and On brings them back from the unchanged records.
  await setShowAnnotations(page, false);
  await page.waitForFunction(() => document.getElementById('editor-annotation-layer').hidden);
  assert.equal((await drawGroups(page)).length, 0, 'Off draws nothing');
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), recordsBefore);
  await setShowAnnotations(page, true);
  await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 2);
  assert.deepEqual((await drawGroups(page)).map(g => g.d), drawn, 'back from the unchanged records');
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), recordsBefore);

  // An individual Hide is respected and saved; Show brings it back.
  await page.click(`${rowFor(onGround.id)} .tp3d-annot-row__eye`);
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).hidden === true, onGround.id);
  assert.equal((await groupFor(page, onGround.id)), null, 'a hidden stroke is not drawn');
  assert.equal((await groupFor(page, onCargo.id)).d, drawn[0], 'and the other is untouched');
  await page.click(`${rowFor(onGround.id)} .tp3d-annot-row__eye`);
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).hidden === false, onGround.id);
  assert.equal((await groupFor(page, onGround.id)).d, drawn[1]);

  // Selecting a drawing: its row and its stroke are marked, the look controls are for that drawing, cargo is not selected.
  await page.click(`${rowFor(onCargo.id)} .tp3d-annot-row__select`);
  await page.waitForSelector(`${rowFor(onCargo.id)}.is-selected`);
  assert.equal((await groupFor(page, onCargo.id)).selected, true);
  assert.equal((await groupFor(page, onGround.id)).selected, false);
  assert.equal(await page.locator('.tp3d-annot-panel__draw-title').textContent(), 'Drawing: Drawing 1 — Selected');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'a drawing never selects cargo');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-panel__arrow')?.hidden ?? true), true, 'the arrow look controls stay out of the way');

  // Color and width edit only that stroke and never its geometry: the path is not rewritten and the vertices are identical.
  const otherBefore = await page.evaluate(id => JSON.stringify(window.probe.annotations().find(r => r.id === id)), onGround.id);
  const geometryBefore = await page.evaluate(id => JSON.stringify(window.probe.annotations().find(r => r.id === id).points), onCargo.id);
  await watchDrawPaint(page);
  await page.click('.tp3d-annot-panel__draw-colors .tp3d-annot-swatch[data-color="red"]');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).color === 'red', onCargo.id);
  await page.click('.tp3d-annot-seg--draw-width .tp3d-annot-seg__btn[data-draw-width="bold"]');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).width === 'bold', onCargo.id);
  await page.waitForFunction(id => [...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id).dataset.color === 'red', onCargo.id);
  await page.waitForTimeout(250);
  assert.equal((await paintCount(page)).d, 0, 'a color or width edit does not rebuild the path');
  assert.equal(await page.evaluate(id => JSON.stringify(window.probe.annotations().find(r => r.id === id).points), onCargo.id), geometryBefore, 'the vertices are identical');
  assert.equal(await page.evaluate(id => JSON.stringify(window.probe.annotations().find(r => r.id === id)), onGround.id), otherBefore, 'the other stroke was not touched');
  const styled = await groupFor(page, onCargo.id);
  assert.deepEqual([styled.color, styled.d], ['red', drawn[0]]);
  assert.ok(Number.parseFloat(styled.width) > Number.parseFloat((await groupFor(page, onGround.id)).width) - 0.01, 'bold is at least as heavy as the other stroke');

  // Delete: the record goes, cargo stays, one Undo restores the identical record (and selects it again).
  const deletedJson = await page.evaluate(id => JSON.stringify(window.probe.annotations().find(r => r.id === id)), onCargo.id);
  await page.click(`${rowFor(onCargo.id)} .tp3d-annot-row__delete`);
  await page.waitForFunction(id => !window.probe.annotations().some(r => r.id === id), onCargo.id);
  assert.equal(await groupFor(page, onCargo.id), null);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), casesBefore, 'Delete never touches cargo');
  assert.match(await page.locator('.toast-message').last().textContent(), /Drawing deleted\./);
  await undoByKeyboard(page);
  await page.waitForFunction(id => window.probe.annotations().some(r => r.id === id), onCargo.id);
  assert.equal(await page.evaluate(id => JSON.stringify(window.probe.annotations().find(r => r.id === id)), onCargo.id), deletedJson, 'the identical record is back');
  assert.deepEqual(await page.evaluate(() => window.probe.annotations().map(r => r.type)), ['draw', 'draw', 'callout', 'arrow'], 'in its place');
  await page.waitForFunction(id => [...document.querySelectorAll('.tp3d-annot-draw')].some(g => g.dataset.annotId === id && g.querySelector('.tp3d-annot-draw__line').getAttribute('d')), onCargo.id);

  // The Delete key acts on the selected drawing and never on cargo.
  await page.click(`${rowFor(onGround.id)} .tp3d-annot-row__select`);
  await page.waitForSelector(`${rowFor(onGround.id)}.is-selected`);
  await page.evaluate(() => document.getElementById('viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  await page.waitForFunction(id => !window.probe.annotations().some(r => r.id === id), onGround.id);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), casesBefore, 'the Delete key deleted the drawing, not cargo');
  assert.equal(await page.evaluate(() => window.probe.annotations().length), 3);

  // The callout and the arrow were never disturbed.
  assert.equal((await arrowGraphics(page)).length, 1);
  assert.equal(await page.evaluate(id => window.probe.annotations().find(r => r.id === id).title, callout.id), 'A callout');
  assert.equal(await page.evaluate(id => window.probe.annotations().find(r => r.id === id).type, arrow.id), 'arrow');
  assert.deepEqual(errors, []);
});

test('freehand Needs Review and Unresolved strokes stay in the panel with a reason and are never drawn as valid geometry; the stroke returns when its cargo does', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const stroke = await seedDraw(page);
  const ground = await seedDraw(page, { ground: [100, 70], rest: [140, 78, 180, 66] });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 2);
  const stored = await page.evaluate(() => JSON.stringify(window.probe.annotations()));

  // The cargo leaves the Load Plan: the stroke is kept and listed with a reason, not drawn.
  const withCargo = await page.evaluate(() => JSON.stringify(window.probe.StateStore.get('packLibrary')));
  await page.evaluate(() => {
    const { StateStore } = window.probe;
    StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => (p.id === 'fixture-pack' ? { ...p, cases: p.cases.filter(c => c.id !== 'cargo-a') } : p)) }, { skipHistory: true });
  });
  await page.waitForFunction(id => !([...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id)?.querySelector('.tp3d-annot-draw__line').getAttribute('d')), stroke.id);
  const flagged = await rowOf(page, 0);
  assert.deepEqual([flagged.name, flagged.flagged, flagged.issueShown], ['Drawing 1', true, true]);
  assert.match(await page.evaluate(id => document.querySelector(`.tp3d-annot-row[data-annot-id="${id}"] .tp3d-annot-row__issue`).textContent, stroke.id), /no longer in this Load Plan|kept as drawn/i);
  assert.equal(await page.evaluate(id => window.probe.resolved().find(r => r.id === id).status !== 'valid', stroke.id), true);
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored, 'the record is kept verbatim');
  assert.equal((await groupFor(page, ground.id)).color, 'ink', 'the valid ground stroke is still drawn');
  assert.equal(await page.evaluate(id => document.querySelector(`.tp3d-annot-row[data-annot-id="${id}"] .tp3d-annot-row__edit`)?.hidden ?? true, stroke.id), true, 'a drawing has no text editor');

  // The cargo returns and the stroke is drawn again from the same record.
  await page.evaluate(plan => { const { StateStore } = window.probe; StateStore.set({ packLibrary: JSON.parse(plan) }, { skipHistory: true }); }, withCargo);
  await page.waitForFunction(id => [...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id)?.querySelector('.tp3d-annot-draw__line').getAttribute('d'), stroke.id);
  assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored);
  assert.deepEqual(errors, []);
});

test('freehand creation defaults are separate for Drawings and Arrows, are session-only, and new strokes use the Drawing default', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  const lookState = () => page.evaluate(() => ({
    drawTitle: document.querySelector('.tp3d-annot-panel__draw-title')?.textContent || '',
    drawShown: Boolean(document.querySelector('.tp3d-annot-panel__draw')) && !document.querySelector('.tp3d-annot-panel__draw').hidden,
    drawColor: document.querySelector('.tp3d-annot-panel__draw-colors .tp3d-annot-swatch[aria-pressed="true"]')?.dataset.color || '',
    drawWidth: document.querySelector('.tp3d-annot-seg--draw-width .tp3d-annot-seg__btn[aria-pressed="true"]')?.dataset.drawWidth || '',
    arrowShown: Boolean(document.querySelector('.tp3d-annot-panel__arrow')) && !document.querySelector('.tp3d-annot-panel__arrow').hidden,
    arrowColor: document.querySelector('.tp3d-annot-panel__arrow-colors .tp3d-annot-swatch[aria-pressed="true"]')?.dataset.color || '',
    arrowWidth: document.querySelector('.tp3d-annot-seg--width .tp3d-annot-seg__btn[aria-pressed="true"]')?.dataset.width || '',
  }));
  assert.deepEqual(await lookState(), { drawTitle: 'New Drawing — Defaults', drawShown: true, drawColor: 'ink', drawWidth: 'regular', arrowShown: false, arrowColor: '', arrowWidth: '' });
  await page.click('.tp3d-annot-panel__draw-colors .tp3d-annot-swatch[data-color="green"]');
  await page.click('.tp3d-annot-seg--draw-width .tp3d-annot-seg__btn[data-draw-width="thin"]');
  assert.deepEqual([(await lookState()).drawColor, (await lookState()).drawWidth], ['green', 'thin']);
  assert.equal(await count(page), 0, 'a default is not a record');

  // The arrow defaults are their own and untouched.
  await armArrow(page);
  assert.deepEqual(await lookState(), { drawTitle: (await lookState()).drawTitle, drawShown: false, drawColor: (await lookState()).drawColor, drawWidth: (await lookState()).drawWidth, arrowShown: true, arrowColor: 'ink', arrowWidth: 'regular' });
  await page.click('.tp3d-annot-panel__arrow-colors .tp3d-annot-swatch[data-color="red"]');
  await armDraw(page);
  const back = await lookState();
  assert.deepEqual([back.drawShown, back.drawColor, back.drawWidth, back.arrowShown], [true, 'green', 'thin', false], 'the Drawing default survived and the arrow color did not leak into it');

  // The next stroke takes the Drawing default.
  await dragSmooth(page, TOP_STROKE_A);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const [saved] = await draws(page);
  assert.deepEqual([saved.color, saved.width], ['green', 'thin']);
  await watchDrawPaint(page);
  assert.equal((await groupFor(page, saved.id)).color, 'green');
  assert.deepEqual(errors, []);
});

test('freehand and the ruler: a saved measurement and a stroke are on screen together, only the tool that owns the scene gets input, and an operation or a preview pauses drawing', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const stroke = await seedDraw(page);
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 70), end: at(260, 80) }).ok) throw new Error('measurement seed failed');
  });
  await watchWrites(page);
  const lines = () => page.evaluate(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].filter(g => g.style.display !== 'none').length);
  await page.waitForFunction(() => [...document.querySelectorAll('.tp3d-measure-svg__segment')].some(g => g.style.display !== 'none') && document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 1);
  const saved = () => page.evaluate(() => JSON.stringify([window.probe.annotations(), window.probe.PackLibrary.getMeasurements('fixture-pack'), window.probe.casesJson()]));
  const before = await saved();

  // Draw armed: the stroke and the saved line are both drawn.
  await armDraw(page);
  assert.equal(await lines(), 1);
  assert.equal((await drawGroups(page)).length, 1);
  assert.equal(await rotateEnabled(page), false);

  // The ruler takes the scene: Draw ends and rotation returns, the Annotations manager stays open, and the stroke stays drawn but cannot take input.
  await startMeasuring(page);
  await page.waitForFunction(() => window.probe.MeasurementTool.isActive());
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal(await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed')), 'true', 'the Annotations manager stays open');
  assert.equal(await rotateEnabled(page), true, 'the ruler gets a normal camera');
  await frames(page, 4);
  assert.equal(await lines(), 1);
  assert.equal((await drawGroups(page)).length, 1, 'the saved stroke stays drawn while the ruler is on');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-layer').inert), true, 'and takes no input');
  const topPoint = await point(page, 70, 32, -20);
  await page.mouse.move(topPoint.x, topPoint.y);
  await page.mouse.down();
  await page.mouse.move(topPoint.x + 40, topPoint.y + 8, { steps: 5 });
  await page.mouse.up();
  assert.equal(await count(page), 1, 'a drag with the ruler on draws nothing');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.probe.MeasurementTool.isActive());
  assert.equal(await saved(), before, 'neither tool wrote anything');

  // Back to Annotations: Draw can be armed again and the ruler's saved line is still there. Its manager stayed open through the ruler.
  if (await page.evaluate(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'false')) await page.click('#btn-editor-annotations');
  await page.waitForFunction(() => document.getElementById('btn-editor-annotations').getAttribute('aria-pressed') === 'true');
  await armDraw(page);
  assert.equal(await lines(), 1);
  assert.equal(await page.evaluate(() => window.probe.MeasurementTool.isActive()), false);

  // An operation owns the Editor: strokes are not drawn, the Draw tool is unavailable and a drag starts nothing.
  await page.evaluate(() => { window.__op = window.probe.OperationLifecycle.beginOperation('autopacking'); });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal((await drawGroups(page)).length, 0, 'paused: no stroke is drawn');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-seg__btn[data-tool="draw"]').disabled), true, 'and Draw cannot be armed');
  assert.equal(await rotateEnabled(page), true);
  await page.evaluate(() => window.probe.OperationLifecycle.finishOperation(window.__op));
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 1);
  assert.equal(await saved(), before, 'the operation changed nothing about the strokes');

  // A transient preview pauses them the same way.
  await armDraw(page);
  await page.evaluate(() => { window.__tp = window.probe.CaseScene.isTransientPreview; window.probe.CaseScene.isTransientPreview = () => true; });
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal((await drawGroups(page)).length, 0);
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-seg__btn[data-tool="draw"]').disabled), true);
  await page.evaluate(() => { window.probe.CaseScene.isTransientPreview = window.__tp; });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === 1);
  assert.equal(await writes(page), 0, 'no stroke was written by any of this');
  assert.deepEqual(errors, []);
});

test('freehand refuses to start on a held pose, on cargo whose ID is shared, and in Show Off; the tool stays armed and nothing is written', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  await watchWrites(page);
  const top = await screenPoints(page, TOP_STROKE_A);
  const tryStroke = async () => {
    await page.mouse.move(top[0].x, top[0].y);
    await page.mouse.down();
    const state = await drawState(page);
    await page.mouse.move(top[1].x, top[1].y, { steps: 4 });
    await page.mouse.move(top[2].x, top[2].y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    return state;
  };

  // A cargo pose that is still being held (a drag or a gizmo not finished): no stroke starts.
  await page.evaluate(() => { window.__hold = window.probe.InteractionManager.hasProvisionalPose; window.probe.InteractionManager.hasProvisionalPose = () => true; });
  assert.equal(await tryStroke(), 'armed', 'no stroke started on a held pose');
  assert.equal(await count(page), 0);
  await page.evaluate(() => { window.probe.InteractionManager.hasProvisionalPose = window.__hold; });

  // Two cargo items with the same ID: it is not known which one a stroke belongs to, so none is drawn on either.
  const plan = await page.evaluate(() => JSON.stringify(window.probe.StateStore.get('packLibrary')));
  await page.evaluate(() => {
    const { StateStore } = window.probe;
    StateStore.set({ packLibrary: StateStore.get('packLibrary').map(p => {
      if (p.id !== 'fixture-pack') return p;
      const twin = p.cases.find(c => c.id === 'cargo-b');
      return { ...p, cases: [...p.cases, { ...twin, id: 'cargo-a', transform: { ...twin.transform, position: { ...twin.transform.position, x: 500 } } }] };
    }) }, { skipHistory: true });
  });
  await cameraSettled(page);
  // The scene keys cargo by ID, so one mesh remains for the shared ID: press on that mesh, wherever it now stands.
  const shared = await page.evaluate(() => window.probe.cargoPoint('cargo-a'));
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), shared), true, 'the shared cargo is on the canvas');
  await page.mouse.move(shared.x, shared.y);
  await page.mouse.down();
  assert.equal(await drawState(page), 'armed', 'no stroke started on cargo that shares its ID');
  await page.mouse.move(shared.x + 40, shared.y + 6, { steps: 5 });
  await page.mouse.up();
  assert.equal(await count(page), 0);
  assert.match(await page.evaluate(() => window.probe.hint()), /shares its ID/i);
  await page.evaluate(plan => window.probe.StateStore.set({ packLibrary: JSON.parse(plan) }, { skipHistory: true }), plan);
  await cameraSettled(page);

  // Show Off: the tool is gone, so a drag orbits and writes nothing.
  await page.evaluate(() => document.querySelector('.tp3d-annot-seg--show .tp3d-annot-seg__btn:nth-child(3)').click());
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal(await rotateEnabled(page), true);
  assert.equal(await count(page), 0);
  assert.equal(await writes(page), 0);
  assert.deepEqual(errors, []);
});

test('freehand rendering follows the camera in perspective and orthographic views, clips at the view, dims behind cargo and never writes a non-finite coordinate', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  const finite = page_ => page_.evaluate(() => [...document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line, .tp3d-annot-draw.is-preview .tp3d-annot-draw__line')]
    .every(el => !/NaN|Infinity/.test(el.getAttribute('d') || '')));

  // Perspective: draw on the cargo, then switch to orthographic and back; the same record is drawn in both.
  await dragSmooth(page, TOP_STROKE_A);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  const [record] = await draws(page);
  const perspective = (await groupFor(page, record.id)).d;
  await page.evaluate(() => window.probe.SceneManager.switchProjection('orthographic'));
  await cameraSettled(page);
  await page.waitForFunction(() => window.probe.SceneManager.getCamera().isOrthographicCamera === true);
  await page.waitForFunction(({ id, was }) => [...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id)?.querySelector('.tp3d-annot-draw__line').getAttribute('d') !== was, { id: record.id, was: perspective });
  const ortho = await groupFor(page, record.id);
  assert.match(ortho.d, /^M[-\d.]+ [-\d.]+(L[-\d.]+ [-\d.]+)+$/, 'drawn in the orthographic view');
  assert.equal(await finite(page), true);

  // A stroke can be drawn in the orthographic view too (the camera does not rotate on the drag, the record is on the surface).
  const cameraOrtho = await page.evaluate(() => window.probe.camera());
  await dragSmooth(page, [[56, 32, -12], [84, 32, -20]]);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.equal(await page.evaluate(() => window.probe.camera()), cameraOrtho, 'no orbit while drawing in the orthographic view');
  const second = (await draws(page)).at(-1);
  assert.equal(second.face, '+y');
  assert.equal(second.anchor.instanceId, 'cargo-a');
  for (let i = 0; i < second.points.length; i += 2) assert.ok(Math.abs(second.points[i]) <= 24.011 && Math.abs(second.points[i + 1]) <= 12.011);
  assert.equal(await finite(page), true);

  await page.evaluate(() => window.probe.SceneManager.switchProjection('perspective'));
  await cameraSettled(page);
  await page.waitForFunction(() => !window.probe.SceneManager.getCamera().isOrthographicCamera);
  await page.waitForFunction(({ id, was }) => [...document.querySelectorAll('.tp3d-annot-draw')].find(g => g.dataset.annotId === id)?.querySelector('.tp3d-annot-draw__line').getAttribute('d') === was, { id: record.id, was: perspective }).catch(() => {});
  assert.equal((await drawGroups(page)).length, 2);
  assert.equal(await finite(page), true);

  // Behind cargo: a floor stroke seen through cargo A is dimmed (occluded) and is solid again when the view is clear.
  const behind = [[130, 0, -24], [160, 0, -18]];
  let aimed = null;
  for (const target of [[145, 0, -21], [260, 0, -21], [20, 0, -21], [145, 0, 30]]) {
    await aimCamera(page, target, [-1, 260, 1]);
    const covered = await page.evaluate(list => list.some(([x, y, z]) => {
      const at = window.probe.screenOf(x, y, z);
      return document.elementFromPoint(at.x, at.y) !== document.querySelector('#viewport canvas');
    }), behind);
    if (!covered) { aimed = target; break; }
  }
  assert.ok(aimed, 'a view from above where the stroke is on the canvas');
  await dragSmooth(page, behind);
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  const floor = (await draws(page)).at(-1);
  assert.equal(floor.anchor.kind, 'floor');
  await page.waitForFunction(id => { const g = [...document.querySelectorAll('.tp3d-annot-draw')].find(x => x.dataset.annotId === id); return g && g.querySelector('.tp3d-annot-draw__line').getAttribute('d') && !g.classList.contains('is-occluded'); }, floor.id);
  await aimCamera(page, [145, 0, -21], [-195, 12, 1]);
  await page.waitForFunction(id => [...document.querySelectorAll('.tp3d-annot-draw')].find(x => x.dataset.annotId === id)?.classList.contains('is-occluded'), floor.id, { timeout: 20000 });
  assert.equal((await groupFor(page, floor.id)).occluded, true, 'dimmed behind cargo');
  await aimCamera(page, aimed, [-1, 260, 1]);
  await page.waitForFunction(id => !([...document.querySelectorAll('.tp3d-annot-draw')].find(x => x.dataset.annotId === id)?.classList.contains('is-occluded')), floor.id, { timeout: 20000 });

  // Zoomed in until the stroke runs off the view: the path is clipped to the view, stays finite and is not dropped.
  await aimCamera(page, [145, 0, -21], [0, 6, 6]);
  await page.waitForFunction(id => [...document.querySelectorAll('.tp3d-annot-draw')].find(x => x.dataset.annotId === id)?.querySelector('.tp3d-annot-draw__line').getAttribute('d'), floor.id);
  assert.equal(await finite(page), true);
  // Looking away entirely: nothing is drawn for it and nothing is non-finite.
  await aimCamera(page, [600, 0, 40], [0, 6, 6]);
  await page.waitForFunction(id => !([...document.querySelectorAll('.tp3d-annot-draw')].find(x => x.dataset.annotId === id)?.querySelector('.tp3d-annot-draw__line').getAttribute('d')), floor.id);
  assert.equal(await finite(page), true);
  assert.deepEqual(errors, []);
});

test('freehand every visible box face of cargo takes a stroke, and the face saved is the one that was hit', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openDrawing(browser);
  await cameraSettled(page);
  // Cargo A is 48 long (x), 24 wide (z), 32 high (y) around (70, 16, -20). Each face is looked at from inside the truck.
  const faces = [
    ['+x', [94, 16, -20], [110, 12, 0], [[94, 12, -26], [94, 20, -14]]],
    ['-x', [46, 16, -20], [-34, 14, 0], [[46, 12, -26], [46, 20, -14]]],
    ['+z', [70, 16, -8], [0, 14, 100], [[58, 12, -8], [82, 20, -8]]],
    ['-z', [70, 16, -32], [0, 14, -14], [[58, 12, -32], [82, 20, -32]]],
  ];
  const seen = [];
  for (const [face, target, offset, stroke] of faces) {
    // Slide the view sideways (camera and target together) until the stroke is on the canvas, not under the panel.
    const across = face.endsWith('x') ? 2 : 0;
    let clear = false;
    const tried = [];
    for (const shift of [0, -10, 10, -20, 20, -30, 30, -40, 40]) {
      const shifted = [...target];
      shifted[across] += shift;
      await aimCamera(page, shifted, offset, { settle: false });
      const report = await page.evaluate(list => list.map(([x, y, z]) => {
        const at = window.probe.screenOf(x, y, z);
        const el = document.elementFromPoint(at.x, at.y);
        return el === document.querySelector('#viewport canvas') ? 'ok' : `${Math.round(at.x)},${Math.round(at.y)} ${el ? el.className : 'nothing'}`;
      }), stroke);
      tried.push(`${shift}: ${report.join(' / ')}`);
      clear = report.every(entry => entry === 'ok');
      if (clear) break;
    }
    assert.equal(clear, true, `${face}: a view where the stroke is on the canvas (${tried.join(' | ')})`);
    await cameraSettled(page);
    const before = await count(page);
    await dragSmooth(page, stroke);
    await page.waitForFunction(n => window.probe.annotations().length === n + 1, before);
    const saved = (await draws(page)).at(-1);
    assert.equal(saved.face, face, `a stroke on the ${face} face is saved on ${face}`);
    assert.equal(saved.anchor.kind, 'cargo');
    assert.equal(saved.anchor.instanceId, 'cargo-a');
    const half = face.endsWith('x') ? [12, 16] : [24, 16];
    for (let i = 0; i < saved.points.length; i += 2) {
      assert.ok(Math.abs(saved.points[i]) <= half[0] + 0.011 && Math.abs(saved.points[i + 1]) <= half[1] + 0.011, `${face}: vertex ${i / 2 + 1} is on the face`);
    }
    seen.push(saved.face);
    assert.equal(await drawState(page), 'armed');
  }
  assert.deepEqual(seen, ['+x', '-x', '+z', '-z']);
  assert.deepEqual(errors, []);
});

test('freehand the panel is operable from the keyboard: arm Draw, switch Draw and Move View, select a stroke, change its look and delete it', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  const stroke = await seedDraw(page);
  await page.waitForSelector(rowFor(stroke.id));

  // The tool button, the mode buttons, the row, the look controls and Delete are real focusable buttons with pressed state.
  await page.focus('.tp3d-annot-seg__btn[data-tool="draw"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
  assert.equal(await page.getAttribute('.tp3d-annot-seg__btn[data-tool="draw"]', 'aria-pressed'), 'true');
  assert.equal(await rotateEnabled(page), false);
  await page.focus('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="move"]');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'move');
  assert.equal(await page.getAttribute('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="move"]', 'aria-pressed'), 'true');
  assert.equal(await rotateEnabled(page), true);
  await page.focus('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="draw"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');

  // Select the stroke from its row with the keyboard; its look can be changed with the keyboard too.
  await page.focus(`${rowFor(stroke.id)} .tp3d-annot-row__select`);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${rowFor(stroke.id)}.is-selected`);
  assert.equal(await page.getAttribute(`${rowFor(stroke.id)} .tp3d-annot-row__select`, 'title'), 'Select to edit its color and width');
  await page.focus('.tp3d-annot-seg--draw-width .tp3d-annot-seg__btn[data-draw-width="thin"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).width === 'thin', stroke.id);
  await page.focus('.tp3d-annot-panel__draw-colors .tp3d-annot-swatch[data-color="blue"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).color === 'blue', stroke.id);
  assert.equal(await page.getAttribute('.tp3d-annot-panel__draw-colors .tp3d-annot-swatch[data-color="blue"]', 'aria-pressed'), 'true');
  const casesBefore = await page.evaluate(() => window.probe.casesJson());

  // Hide, Show and Delete from the row buttons; Undo from its button; none of it reaches cargo.
  await page.focus(`${rowFor(stroke.id)} .tp3d-annot-row__eye`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).hidden === true, stroke.id);
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).hidden === false, stroke.id);
  await page.focus(`${rowFor(stroke.id)} .tp3d-annot-row__delete`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.annotations().length === 0);
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), casesBefore, 'cargo is untouched by any of it');
  assert.deepEqual(errors, []);
});

test('freehand in a compact viewport: with Draw armed the panel still reaches Draw / Move View, every saved stroke row and the look controls', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 500, height: 740 });
  await cameraSettled(page);
  const strokes = [await seedDraw(page), await seedDraw(page, { color: 'red' }), await seedDraw(page, { ground: [100, 70], rest: [140, 78, 180, 66] })];
  await armDraw(page);
  const panelBox = () => page.evaluate(() => { const r = document.getElementById('editor-annotation-panel').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; });
  const box = await panelBox();
  assert.ok(box.width <= 500 && box.top >= 0 && box.bottom <= 740, 'the panel is inside the viewport');
  // Each control takes an ordinary click (Playwright refuses a covered target), in the order a person would use them.
  await page.click('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="move"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'move');
  await page.click('.tp3d-annot-seg--drawmode .tp3d-annot-seg__btn[data-draw-view="draw"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'armed');
  for (const stroke of strokes) {
    await page.click(`${rowFor(stroke.id)} .tp3d-annot-row__select`);
    await page.waitForSelector(`${rowFor(stroke.id)}.is-selected`);
    // The selected stroke's look controls are on screen and clickable.
    await page.click('.tp3d-annot-seg--draw-width .tp3d-annot-seg__btn[data-draw-width="thin"]');
    await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).width === 'thin', stroke.id);
  }
  assert.deepEqual(errors, []);
});

// ============================================================================
// Annotations V1B.2 Gate B.1: the callout editor keeps clear of the floating Editor toolbar (drawn above the annotation layer),
// and in a window too short for it the body scrolls to its last row (Color, Keep expanded) above the footer, never under it.
// ============================================================================
test('callout editor in a short window keeps its header clear of the toolbar and scrolls every option, Color included, above the footer', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  // The reported window (a card on a 556x398 canvas with the toolbar across its top), then the narrow sheet under the two-row toolbar.
  for (const [width, height, sheet] of [[1100, 480, false], [1000, 600, true], [1000, 520, true]]) {
    const label = `${width}x${height}`;
    const { page, errors } = await openPanel(browser, { width, height });
    await seed(page, [{ title: 'UNLOAD FIRST', description: 'Place near rear doors. Required at first delivery stop.', ground: [520, 10] }]);
    const stored = await page.evaluate(() => JSON.stringify(window.probe.annotations()));
    await page.click('.tp3d-annot-row__edit');
    await page.waitForSelector('.tp3d-annot-editor:not([hidden])');
    await frames(page, 6);
    assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-editor').classList.contains('is-sheet')), sheet, `${label}: ${sheet ? 'the sheet' : 'the card'}`);
    assert.equal(overlaps(await boxOf(page, '.tp3d-annot-editor'), await boxOf(page, '#viewport-toolbar')), false, `${label}: the editor is not under the toolbar`);
    assert.equal(await unobstructed(page, '.tp3d-annot-editor__head'), true, `${label}: the header is not covered`);
    assert.deepEqual(await editorControls(page), REACHABLE, `${label}: Save, Cancel and the title field are reachable`);
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.tp3d-annot-editor__body')).backgroundImage), /linear-gradient/, `${label}: a scrolling body shows where more lies beyond the fold`);
    // Scrolled to its end, every option sits whole above the footer and is topmost at its own centre.
    const problems = await page.evaluate(() => {
      const editor = document.querySelector('.tp3d-annot-editor');
      const body = editor.querySelector('.tp3d-annot-editor__body');
      body.scrollTop = body.scrollHeight;
      const view = body.getBoundingClientRect();
      const floor = Math.min(view.bottom, editor.querySelector('.tp3d-annot-editor__foot').getBoundingClientRect().top);
      const found = [];
      const controls = [...editor.querySelectorAll('.tp3d-annot-swatch, .tp3d-annot-editor__keep input')];
      if (controls.length < 7) found.push(`only ${controls.length} option controls`);
      controls.forEach((el, index) => {
        const r = el.getBoundingClientRect();
        if (r.top < view.top - 0.5 || r.bottom > floor + 0.5) found.push(`control ${index} is cut off (${Math.round(r.top)}..${Math.round(r.bottom)} within ${Math.round(view.top)}..${Math.round(floor)})`);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit !== el && !el.contains(hit)) found.push(`control ${index} is covered by ${hit ? `${hit.tagName}.${hit.className}` : 'nothing'}`);
      });
      return found;
    });
    assert.deepEqual(problems, [], `${label}: every option is reachable above the footer`);
    await page.click('.tp3d-annot-editor__foot .tp3d-annot-btn:not(.tp3d-annot-btn--primary):not(.tp3d-annot-btn--danger)');
    await page.waitForFunction(() => document.querySelector('.tp3d-annot-editor').hidden);
    assert.equal(await page.evaluate(() => JSON.stringify(window.probe.annotations())), stored, `${label}: the stored annotation is exactly as it was`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// ============================================================================
const chromeOf = page => page.evaluate(() => ({
  handles: document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length,
  selected: document.querySelectorAll('.tp3d-annot-pin.is-selected, .tp3d-annot-card.is-selected, .tp3d-annot-arrow.is-selected, .tp3d-annot-draw.is-selected').length,
  cardButtons: [...document.querySelectorAll('.tp3d-annot-card__btn')].filter(el => !el.hidden && el.closest('.tp3d-annot-card') && !el.closest('.tp3d-annot-card').hidden).length,
}));

const dataOf = page => page.evaluate(() => ({
  records: JSON.stringify(window.probe.annotations()),
  cases: window.probe.casesJson(),
  edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited,
  selected: window.probe.AnnotationTool.selectedId(),
}));

// Annotations V1B.2 Gate B.3: Weight and Style (Solid / Dashed / Dotted) for arrows and drawings
// ============================================================================
// The Weight and Style rows of the look controls (`kind` is 'arrow' or 'draw'): their labels, which button is pressed, and the
// title that says whether they are for one record or for the next ones.
const lookControls = (page, kind) => page.evaluate(which => {
  const root = document.querySelector(`.tp3d-annot-panel__${which}`);
  const pressed = selector => root.querySelector(`${selector} .tp3d-annot-seg__btn[aria-pressed="true"]`);
  const weightGroup = which === 'arrow' ? '.tp3d-annot-seg--width' : '.tp3d-annot-seg--draw-width';
  const styleGroup = which === 'arrow' ? '.tp3d-annot-seg--line' : '.tp3d-annot-seg--draw-line';
  return {
    shown: !root.hidden,
    title: root.querySelector(`.tp3d-annot-panel__${which}-title`).textContent,
    labels: [...root.querySelectorAll('.tp3d-annot-panel__view-label')].map(el => el.textContent),
    weights: [...root.querySelectorAll(`${weightGroup} .tp3d-annot-seg__btn`)].map(el => el.textContent),
    styles: [...root.querySelectorAll(`${styleGroup} .tp3d-annot-seg__btn`)].map(el => el.textContent),
    weight: pressed(weightGroup)?.textContent || '',
    style: pressed(styleGroup)?.textContent || '',
  };
}, kind);
// What each arrow and drawing is painted with: its style attribute, the dash pattern, caps, weight, opacity and edge color of
// the line and of its halo, and of an arrow's head.
const lineLook = page => page.evaluate(() => {
  const read = el => {
    const css = getComputedStyle(el);
    return { dash: css.strokeDasharray, cap: css.strokeLinecap, width: parseFloat(css.strokeWidth), opacity: parseFloat(css.opacity), stroke: css.stroke };
  };
  const groups = document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow:not(.is-preview), .tp3d-annot-svg .tp3d-annot-draws .tp3d-annot-draw:not(.is-preview)');
  return Object.fromEntries([...groups].filter(group => group.dataset.lineStyle).map(group => {
    const arrow = group.classList.contains('tp3d-annot-arrow');
    return [group.dataset.annotId, {
      style: group.dataset.lineStyle,
      occluded: group.classList.contains('is-occluded'),
      selected: group.classList.contains('is-selected'),
      line: read(group.querySelector(arrow ? '.tp3d-annot-arrow__shaft' : '.tp3d-annot-draw__line')),
      halo: read(group.querySelector(arrow ? '.tp3d-annot-arrow__under' : '.tp3d-annot-draw__under')),
      head: arrow ? read(group.querySelector('.tp3d-annot-arrow__head')) : null,
    }];
  }));
});
const dashes = pattern => (pattern === 'none' ? [] : pattern.split(/[ ,]+/).map(parseFloat));

test('annotation line style: Arrows and Drawings offer Weight and Style, a record shows and changes only its own style, new ones start from separate session defaults, and each style paints its own pattern', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await cameraSettled(page);
  // Saved before line styles existed (no key), then styled ones; two arrows run under cargo A to be hidden by it.
  const [callout] = await seed(page, [{ title: 'A callout', ground: [520, 10] }]);
  const legacy = await seedArrow(page, [100, 62], [180, 62]);
  const dashed = await seedArrow(page, [100, 68], [180, 68], { style: 'dashed', width: 'bold' });
  const dotted = await seedArrow(page, [100, 74], [180, 74], { style: 'dotted', width: 'thin' });
  const hiddenSolid = await seedArrow(page, [20, -14], [120, -14]);
  const hiddenDashed = await seedArrow(page, [20, -24], [120, -24], { style: 'dashed' });
  const drawSolid = await seedDraw(page, { ground: [200, 62], rest: [240, 70, 280, 62] });
  const drawDotted = await seedDraw(page, { ground: [200, 68], rest: [240, 76, 280, 68], style: 'dotted' });
  const drawDashed = await seedDraw(page, { ground: [200, 74], rest: [240, 82, 280, 74], style: 'dashed', width: 'bold' });
  assert.equal(Object.hasOwn(legacy, 'style') || Object.hasOwn(drawSolid, 'style'), false, 'a record with no style is stored with no style');
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg [data-line-style]').length === 8);
  await watchWrites(page);
  const stored = () => page.evaluate(() => window.probe.annotations());
  const others = async id => (await stored()).filter(record => record.id !== id);
  const select = async id => {
    await page.click(`${rowFor(id)} .tp3d-annot-row__select`);
    await page.waitForFunction(selected => window.probe.AnnotationTool.selectedId() === selected, id);
  };

  // Every style paints a pattern of its own, scaled by the weight; the halo repeats it and the arrowhead stays solid.
  let look = await lineLook(page);
  assert.deepEqual([legacy, dashed, dotted, drawSolid, drawDotted, drawDashed].map(r => look[r.id].style), ['solid', 'dashed', 'dotted', 'solid', 'dotted', 'dashed']);
  assert.deepEqual([look[legacy.id].line.dash, look[drawSolid.id].line.dash], ['none', 'none'], 'Solid is a continuous line');
  assert.deepEqual([look[legacy.id].line.cap, look[drawSolid.id].line.cap], ['butt', 'round'], 'and keeps the caps it always had');
  const [bolDash, bolGap] = dashes(look[dashed.id].line.dash);
  assert.equal(look[dashed.id].line.width, 5, 'Bold is 5 px');
  assert.ok(bolDash >= look[dashed.id].line.width * 3 && bolGap >= 5 && bolGap < bolDash, `a Dashed line has long dashes with clear gaps (${bolDash} ${bolGap})`);
  assert.equal(look[dashed.id].line.cap, 'butt', 'dashes are cut square');
  const [dot, dotGap] = dashes(look[dotted.id].line.dash);
  assert.equal(look[dotted.id].line.width, 2, 'Thin is 2 px');
  assert.ok(dot < 0.5 && dotGap >= look[dotted.id].line.width * 2.5, `a Dotted line is round dots, well apart (${dot} ${dotGap})`);
  assert.equal(look[dotted.id].line.cap, 'round');
  for (const record of [dashed, dotted, drawDotted, drawDashed]) assert.equal(look[record.id].halo.dash, look[record.id].line.dash, `${record.id}: the halo repeats the line's pattern`);
  assert.deepEqual([look[dashed.id].head.dash, look[dotted.id].head.dash], ['none', 'none'], 'arrowheads are solid whatever the shaft is');
  assert.deepEqual([look[drawDotted.id].line.cap, look[drawDashed.id].line.cap, look[drawDotted.id].line.width, look[drawDashed.id].line.width], ['round', 'butt', 3, 5]);
  assert.ok(dashes(look[drawDashed.id].line.dash)[0] > dashes(look[hiddenDashed.id].line.dash)[0], 'a Bold dash is longer than a Regular one: the pattern scales with the weight');
  const dashedPattern = look[dashed.id].line.dash;

  // Hidden behind cargo: a Solid line keeps its established dashed cue; a styled one keeps its own pattern and is dimmed instead.
  assert.deepEqual([look[hiddenSolid.id].occluded, look[hiddenDashed.id].occluded], [true, true], 'both run under cargo A');
  assert.deepEqual(dashes(look[hiddenSolid.id].line.dash), [7, 5], 'a hidden Solid arrow is dashed 7 5');
  assert.notEqual(look[hiddenSolid.id].head.dash, 'none', 'with a hollow, dashed head');
  assert.deepEqual(dashes(look[hiddenDashed.id].line.dash), [12, 7.5], 'a hidden Dashed arrow keeps its own Regular pattern, not the behind-cargo dash');
  assert.ok(look[hiddenDashed.id].line.opacity <= 0.45 && look[dashed.id].line.opacity === 1, 'and is dimmed where a clear one is not');
  assert.equal(look[hiddenDashed.id].head.dash, 'none', 'its head stays solid');

  // Selecting a legacy arrow shows it as Solid and writes nothing; selecting a styled one shows its own Weight and Style.
  await select(legacy.id);
  assert.deepEqual(await lookControls(page, 'arrow'), {
    shown: true, title: 'Arrow: Arrow 1 — Selected', labels: ['Weight', 'Style'], weights: ['Thin', 'Regular', 'Bold'], styles: ['Solid', 'Dashed', 'Dotted'], weight: 'Regular', style: 'Solid',
  });
  await select(dashed.id);
  assert.deepEqual([(await lookControls(page, 'arrow')).weight, (await lookControls(page, 'arrow')).style], ['Bold', 'Dashed']);
  await select(dotted.id);
  assert.deepEqual([(await lookControls(page, 'arrow')).weight, (await lookControls(page, 'arrow')).style], ['Thin', 'Dotted']);
  await select(drawDotted.id);
  assert.deepEqual(await lookControls(page, 'draw'), {
    shown: true, title: 'Drawing: Drawing 2 — Selected', labels: ['Weight', 'Style'], weights: ['Thin', 'Regular', 'Bold'], styles: ['Solid', 'Dashed', 'Dotted'], weight: 'Regular', style: 'Dotted',
  });
  assert.equal(await writes(page), 0, 'looking at records writes nothing');
  // The selection edge follows the line's own pattern and stays apart from a plain one.
  look = await lineLook(page);
  assert.equal(look[drawDotted.id].selected, true);
  assert.equal(look[drawDotted.id].halo.dash, look[drawDotted.id].line.dash);
  assert.notEqual(look[drawDotted.id].halo.stroke, look[drawDashed.id].halo.stroke, 'a selected line has its own edge color');

  // Changing a saved record's Style is one annotation write that moves nothing else; choosing the same Style again writes nothing.
  await select(legacy.id);
  const before = { others: await others(legacy.id), cases: await page.evaluate(() => window.probe.casesJson()), camera: await page.evaluate(() => window.probe.camera()), record: (await stored()).find(r => r.id === legacy.id) };
  await page.focus('.tp3d-annot-seg--line .tp3d-annot-seg__btn[data-line-style="dotted"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).style === 'dotted', legacy.id);
  assert.equal(await writes(page), 1, 'one annotation write');
  assert.equal(JSON.stringify(await others(legacy.id)), JSON.stringify(before.others), 'no other annotation is written');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), before.cases, 'cargo is untouched');
  assert.equal(await page.evaluate(() => window.probe.camera()), before.camera, 'and so is the camera');
  const changed = (await stored()).find(r => r.id === legacy.id);
  assert.deepEqual([changed.start, changed.end, changed.id, changed.createdAt, changed.color, changed.width], [before.record.start, before.record.end, before.record.id, before.record.createdAt, before.record.color, before.record.width]);
  assert.equal((await lookControls(page, 'arrow')).style, 'Dotted');
  await page.waitForFunction(id => document.querySelector(`.tp3d-annot-arrow[data-annot-id="${id}"]`).dataset.lineStyle === 'dotted', legacy.id);
  await page.click('.tp3d-annot-seg--line .tp3d-annot-seg__btn[data-line-style="dotted"]');
  assert.equal(await writes(page), 1, 'choosing what it already is writes nothing');
  await page.click('.tp3d-annot-seg--line .tp3d-annot-seg__btn[data-line-style="solid"]');
  await page.waitForFunction(id => !Object.hasOwn(window.probe.annotations().find(r => r.id === id), 'style'), legacy.id);
  assert.equal(await writes(page), 2);
  assert.equal(JSON.stringify({ ...(await stored()).find(r => r.id === legacy.id), updatedAt: 0 }), JSON.stringify({ ...before.record, updatedAt: 0 }), 'back to Solid, the record is the legacy record again');
  await select(drawSolid.id);
  await page.click('.tp3d-annot-seg--draw-line .tp3d-annot-seg__btn[data-draw-line-style="dashed"]');
  await page.waitForFunction(id => window.probe.annotations().find(r => r.id === id).style === 'dashed', drawSolid.id);
  assert.equal(await writes(page), 3);
  await page.click('.tp3d-annot-seg--draw-line .tp3d-annot-seg__btn[data-draw-line-style="solid"]');
  await page.waitForFunction(id => !Object.hasOwn(window.probe.annotations().find(r => r.id === id), 'style'), drawSolid.id);
  assert.equal(await writes(page), 4);
  assert.equal(JSON.stringify((await stored()).find(r => r.id === callout.id)), JSON.stringify(callout), 'a callout is never touched');

  // New arrows and new drawings have their own session defaults, apart from each other and from any record: choosing one writes nothing.
  await armArrow(page);
  assert.deepEqual([(await lookControls(page, 'arrow')).title, (await lookControls(page, 'arrow')).style], ['New Arrow — Defaults', 'Solid'], 'new arrows start Solid');
  await page.click('.tp3d-annot-seg--line .tp3d-annot-seg__btn[data-line-style="dashed"]');
  assert.equal(await writes(page), 4, 'choosing a default writes nothing');
  const placeArrow = async (from, to) => {
    const count = (await stored()).length;
    await click(page, await freePoint(page, [from]));
    await page.waitForFunction(() => /arrow should point/i.test(window.probe.hint()));
    await click(page, await freePoint(page, [to]));
    await page.waitForFunction(n => window.probe.annotations().length === n + 1, count);
    return (await stored()).at(-1);
  };
  const created = await placeArrow(GROUND_B, GROUND_A);
  assert.deepEqual([created.type, created.style], ['arrow', 'dashed'], 'the next arrow takes the chosen Style');
  assert.equal(await writes(page), 5, 'and costs one write');
  await armDraw(page);
  assert.deepEqual([(await lookControls(page, 'draw')).title, (await lookControls(page, 'draw')).style], ['New Drawing — Defaults', 'Solid'], 'drawings keep their own default: the arrow choice did not leak');
  await page.click('.tp3d-annot-seg--draw-line .tp3d-annot-seg__btn[data-draw-line-style="dotted"]');
  assert.equal(await writes(page), 5);
  await dragThrough(page, FLOOR_STROKE);
  await page.waitForFunction(() => window.probe.annotations().filter(r => r.type === 'draw').length === 4);
  const drawn = (await stored()).at(-1);
  assert.deepEqual([drawn.type, drawn.style], ['draw', 'dotted']);
  assert.equal(await writes(page), 6);
  await page.click('.tp3d-annot-seg__btn[data-tool="arrow"]');
  assert.equal((await lookControls(page, 'arrow')).style, 'Dashed', 'the arrow default is remembered while drawing');
  assert.equal(JSON.stringify(await others(created.id)).includes('"style":"dashed"'), true);
  await page.keyboard.press('Escape');


  // Show Off hides the lines and their controls; Show All brings them back.
  await showButton(page, 'Off').click();
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""]), .tp3d-annot-svg .tp3d-annot-draw__line[d]:not([d=""])').length === 0);
  assert.equal((await lookControls(page, 'arrow')).shown, false);
  await showButton(page, 'All').click();
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-arrow__shaft[d]:not([d=""])').length >= 5);
  assert.equal(await writes(page), 6, 'display choices write nothing');
  assert.deepEqual(errors, []);
});

// ============================================================================
// SECTION: DIRECT DRAWING SELECTION + MOVEMENT (V1B.2 Gate B.4)
// ============================================================================
// Strokes take no pointer of their own: the overlay stays click-through and the Editor's canvas asks the tool at press time.
// What the pointer would reach at a screen point: the canvas, or whatever else is there.
const reachAt = (page, at) => page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'nothing';
  return el === document.querySelector('#viewport canvas') ? 'canvas' : `${el.tagName}.${String((el.className && el.className.baseVal) ?? el.className)}`;
}, at);
const moveLook = (page, id) => page.evaluate(sel => {
  const group = document.querySelector(`.tp3d-annot-draws .tp3d-annot-draw[data-annot-id="${sel}"]`);
  return group ? {
    d: group.querySelector('.tp3d-annot-draw__line').getAttribute('d'),
    moving: group.classList.contains('is-moving'),
    invalid: group.classList.contains('is-move-invalid'),
    selected: group.classList.contains('is-selected'),
  } : null;
}, id);
const moveState = page => page.evaluate(() => window.probe.AnnotationTool.moveState());
// The pointer-ownership classes the SVG layer used to carry: none may ever appear again.
const layerClasses = page => page.evaluate(() => [...document.querySelector('.tp3d-annot-layer').classList].filter(name => /^is-(draw-hit|draw-moving|view-only)$/.test(name)));
const waitDrawn = (page, id) => page.waitForFunction(sel => document.querySelector(`.tp3d-annot-draws .tp3d-annot-draw[data-annot-id="${sel}"] .tp3d-annot-draw__line`)?.getAttribute('d'), id);
// Whether the tool would take a plain mouse press at a screen point: the test the Editor's canvas asks at press time (a pure query).
const lineUnder = (page, at, pointerType = 'mouse') => page.evaluate(({ x, y, pointerType }) => window.probe.AnnotationTool.hoverDrawing({ clientX: x, clientY: y, pointerType, buttons: 0 }), { x: at.x, y: at.y, pointerType });
// The camera's own state: OrbitControls' rotation switch (held off only for a press the stroke took) and its gesture state (-1 = none).
const rotationEnabled = page => page.evaluate(() => window.probe.SceneManager.getControls().enableRotate);
const controlsState = page => page.evaluate(() => window.probe.SceneManager.getControls().state);
const seedFloorDraw = (page, from, rest) => page.evaluate(({ from, rest }) => {
  const { M, PackLibrary } = window.probe;
  const anchor = M.buildFloorAnchor({ surface: 'main', point: { x: from[0], y: 0, z: from[1] } });
  const outcome = PackLibrary.addDraw('fixture-pack', { anchor, rawPoints: rest });
  if (!outcome.ok) throw new Error(`floor draw seed failed: ${outcome.reason}`);
  return outcome.annotation;
}, { from, rest });

test('annotation drawing move: a saved drawing is selected by clicking its line and carried rigidly along its own surface, one write on a valid release and none for a click, a cancel or a position it cannot take', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await watchWrites(page);
  await watchPointer(page);
  const TOP_AIM = [[70, 32, -20], [0, 70, 70]]; // close enough that an inch is several pixels
  await aimCamera(page, ...TOP_AIM);
  const top = await seedDraw(page); // across the top of cargo-a: world (52,32,-28) -> (64,32,-20) -> (80,32,-26) -> (88,32,-24)
  const floor = await seedFloorDraw(page, [150, -30], [190, 10, 230, -20]); // open truck floor
  await waitDrawn(page, top.id); // the floor drawing is out of this view until the camera goes there
  await watchWrites(page); // the seeds are not part of what is counted
  const onTop = await point(page, 58, 32, -24); // the middle of the stroke's first segment
  const aside = await point(page, 82, 32, -10); // cargo-a's top, well away from the stroke
  const camera = await page.evaluate(() => window.probe.camera());
  const start = await dataOf(page);

  // Nothing in the overlay takes the pointer: a stroke is no DOM target, so every press lands on the canvas and the Editor asks the tool.
  assert.deepEqual(await layerClasses(page), [], 'the layer carries no pointer-ownership state');
  assert.equal(await page.locator('.tp3d-annot-draw__hit').count(), 0, 'and no stroke has a hit element of its own');
  assert.equal(await page.locator('.tp3d-annot-draws .tp3d-annot-draw').first().locator('path').count(), 2, 'only a halo and the line are drawn');
  assert.equal(await reachAt(page, onTop), 'canvas', 'the pointer reaches the canvas over the stroke');
  assert.equal(await reachAt(page, aside), 'canvas');
  assert.equal(await page.evaluate(sel => getComputedStyle(document.querySelector(sel)).pointerEvents, '.tp3d-annot-svg'), 'none', 'the SVG itself stays click-through');
  assert.equal(await lineUnder(page, onTop), true, 'the tool takes a press on the line');
  assert.equal(await lineUnder(page, aside), false, 'and not one on the cargo beside it');
  assert.equal(await rotationEnabled(page), true);

  // A click selects it like its row does and writes nothing; cargo is not selected and the camera does not move.
  await click(page, onTop);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, top.id);
  assert.equal((await moveLook(page, top.id)).selected, true, 'the selected edge is the existing one');
  assert.match(await page.locator(`${rowFor(top.id)}`).getAttribute('class'), /is-selected/);
  assert.equal((await lookControls(page, 'draw')).title, 'Drawing: Drawing 1 — Selected');
  assert.deepEqual({ ...await dataOf(page), selected: null }, { ...start, selected: null }, 'selecting wrote nothing and moved nothing');
  assert.equal(await writes(page), 0);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'cargo was not selected');
  assert.equal(await page.evaluate(() => window.probe.camera()), camera, 'the camera did not move for a click on the line');
  assert.equal(await rotationEnabled(page), true, 'and the camera is free again');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() === null);

  // A press that stays under the drag threshold is a click: nothing moves, nothing is written.
  await page.mouse.move(onTop.x, onTop.y);
  await page.mouse.down();
  await page.mouse.move(onTop.x + 2, onTop.y + 2, { steps: 3 });
  assert.equal(await moveState(page), 'pressed');
  await page.mouse.up();
  assert.equal(await moveState(page), 'idle');
  assert.equal(await writes(page), 0);

  // A drag carries the whole stroke: the record is untouched while it moves, and the preview is the stroke shifted.
  const before = (await page.evaluate(() => window.probe.annotations())).find(r => r.id === top.id);
  const original = await moveLook(page, top.id);
  const target = await point(page, 62, 32, -21); // +4 along the face's u (world x), +3 along its v (world z)
  await page.mouse.move(onTop.x, onTop.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'moving');
  const carried = await moveLook(page, top.id);
  assert.equal(carried.moving, true);
  assert.equal(carried.invalid, false);
  assert.notEqual(carried.d, original.d, 'the preview follows the pointer');
  assert.deepEqual(await layerClasses(page), [], 'no pointer-ownership state is put on the layer');
  assert.equal(await page.evaluate(() => window.probe.camera()), camera, 'the camera does not turn while the line is carried');
  assert.equal(await rotationEnabled(page), false, 'rotation is held off for this press');
  assert.match(await page.evaluate(() => window.probe.hint()), /release to move the drawing here/i);
  assert.equal(await writes(page), 0, 'nothing is written while it moves');
  assert.equal(JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === top.id)), JSON.stringify(before), 'and the stored drawing is exactly as it was');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), start.cases);
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'idle');
  await page.waitForFunction(count => window.probe.annotations().length === count && window.__writes === 1, 2);
  assert.equal(await rotationEnabled(page), true, 'rotation is back once the press ends');
  const after = (await page.evaluate(() => window.probe.annotations())).find(r => r.id === top.id);
  const delta = [after.anchor.local.x - before.anchor.local.x, after.anchor.local.z - before.anchor.local.z];
  assert.ok(Math.abs(delta[0] - 4) < 0.25 && Math.abs(delta[1] - 3) < 0.25, `moved by about (4, 3) in (${delta.map(v => v.toFixed(2)).join(', ')})`);
  assert.equal(after.anchor.local.y, before.anchor.local.y, 'still on the face plane');
  after.points.forEach((value, i) => {
    const moved = value - before.points[i];
    assert.ok(Math.abs(moved - delta[i % 2]) < 1e-9, `vertex ${Math.floor(i / 2) + 1} moved by the same offset as the anchor (${moved} vs ${delta[i % 2]})`);
  });
  assert.equal(Math.round(delta[0] * 100) / 100, delta[0], 'the offset is on the 0.01 in grid');
  const keep = record => JSON.stringify({ ...record, anchor: { ...record.anchor, local: undefined }, points: undefined, updatedAt: undefined });
  assert.equal(keep(after), keep(before), 'ID, cargo, face, signature, color, weight, style and createdAt are unchanged');
  assert.ok(after.updatedAt >= before.updatedAt);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), start.cases, 'cargo is untouched');
  assert.equal(await page.evaluate(() => window.probe.camera()), camera, 'and so is the camera');
  assert.equal(JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === floor.id)), JSON.stringify(floor), 'other drawings are untouched');
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), top.id, 'the moved drawing is the selection');
  assert.match(await page.evaluate(() => window.probe.hint()), /drawing moved/i);
  assert.equal((await moveLook(page, top.id)).moving, false);
  assert.notEqual((await moveLook(page, top.id)).d, original.d, 'it is drawn in its new place');
  await watchWrites(page);

  // Dragging and coming back to where the press began is not an edit: nothing is written and lastEdited stays.
  const edited = (await dataOf(page)).edited;
  const here = await point(page, 62, 32, -21);
  const out = await point(page, 54, 32, -21);
  await waitDrawn(page, top.id);
  assert.equal(await lineUnder(page, here), true, 'the moved line is under the pointer in its new place');
  await page.mouse.move(here.x, here.y);
  await page.mouse.down();
  await page.mouse.move(out.x, out.y, { steps: 6 });
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'moving');
  await page.mouse.move(here.x, here.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'idle');
  assert.equal(await rotationEnabled(page), true, 'rotation is back once the move ended');
  assert.equal(await lineUnder(page, here), true, 'and the stroke can be grabbed again');
  assert.equal(await writes(page), 0, 'a no-op move is not a write');
  assert.equal((await dataOf(page)).edited, edited, 'and does not touch lastEdited');
  assert.match(await page.evaluate(() => window.probe.hint()), /left where it was/i);

  // A position the whole drawing cannot take: past the edge of its cargo face, past the truck wall. It is shown, then refused
  // whole - no clamping, no partial move - and the drawing returns to where it was.
  const refusals = [
    ['cargo face', top.id, [[62, 32, -21], [76, 32, -21]], null],
    ['truck floor', floor.id, [[170, 0, -10], [170, 0, 62]], [[170, 0, -10], [0, 90, 120]]],
  ];
  for (const [label, id, [from, to], aim] of refusals) {
    if (aim) {
      await aimCamera(page, ...aim);
      await waitDrawn(page, id);
    }
    const [a, b] = [await point(page, ...from), await point(page, ...to)];
    const record = JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === id));
    const rest = await moveLook(page, id);
    assert.equal(await lineUnder(page, a), true, `${label}: the line is under the pointer`);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'blocked');
    const refused = await moveLook(page, id);
    assert.deepEqual([refused.moving, refused.invalid], [true, true], `${label}: the position is shown as one it cannot take`);
    assert.match(await page.evaluate(() => window.probe.hint()), /would leave its surface/i);
    assert.equal(JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === id)), record, `${label}: the stored drawing is untouched while it is shown there`);
    await page.mouse.up();
    await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'idle');
    assert.equal(await writes(page), 0, `${label}: refused, nothing written`);
    assert.equal(JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === id)), record, `${label}: stored exactly as it was`);
    assert.deepEqual(await moveLook(page, id), { ...rest, selected: refused.selected || rest.selected }, `${label}: drawn exactly where it was`);
    assert.match(await page.evaluate(() => window.probe.hint()), /left where it was/i);
  }
  assert.equal(await page.evaluate(() => window.probe.casesJson()), start.cases);
  await aimCamera(page, ...TOP_AIM);
  await waitDrawn(page, top.id);

  // Escape and a cancelled pointer end the move without writing, and the drawing is where it was. A press the stroke took stays the
  // stroke's until it lifts (the camera has already read it): ending the move early never lets that press turn the camera.
  const pointer = await pointerId(page);
  for (const [label, cancel, stillDown] of [
    ['Escape', () => page.keyboard.press('Escape'), true],
    ['pointercancel', () => page.evaluate(id => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, bubbles: true })), pointer), false],
    ['window blur', () => page.evaluate(() => window.dispatchEvent(new Event('blur'))), true],
  ]) {
    const rest = await moveLook(page, top.id);
    const resting = await page.evaluate(() => window.probe.camera());
    const [a, b] = [await point(page, 62, 32, -21), await point(page, 54, 32, -25)];
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'moving');
    await cancel();
    await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'idle');
    assert.equal(await writes(page), 0, `${label}: nothing written`);
    assert.match(await page.evaluate(() => window.probe.hint()), /move cancelled/i, label);
    if (stillDown) {
      await page.mouse.move(b.x + 40, b.y + 30, { steps: 6 });
      assert.equal(await rotationEnabled(page), false, `${label}: the button is still down on the stroke's press, so rotation stays off`);
      assert.equal(await page.evaluate(() => window.probe.camera()), resting, `${label}: and the camera does not turn under it`);
    }
    await page.mouse.up();
    assert.equal(await rotationEnabled(page), true, `${label}: rotation is back once the pointer lifted`);
    assert.equal(await page.evaluate(() => window.probe.camera()), resting, `${label}: the camera is where it was`);
    assert.deepEqual(await moveLook(page, top.id), rest, `${label}: drawn where it was, no longer carried`);
    assert.equal(await writes(page), 0, `${label}: releasing afterwards writes nothing`);
  }

  // The cargo the drawing is on moving mid-drag ends the move: the drawing follows its cargo, the move is not applied to it.
  const [c, d] = [await point(page, 62, 32, -21), await point(page, 54, 32, -25)];
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 8 });
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'moving');
  await moveCargoA(page, 6);
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'idle');
  await page.mouse.up();
  assert.equal(await rotationEnabled(page), true, 'rotation is back after the pointer lifted');
  assert.equal(await writes(page), 0, 'a cargo change cancelled the move without writing');
  assert.equal(JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === top.id).points), JSON.stringify(after.points), 'the drawing itself was not changed');
  await moveCargoA(page, -6);
  await cameraSettled(page);
  await waitDrawn(page, top.id);

  // Nothing else may take a press meant for a tool that owns the pointer: an armed tool and Measurement keep it, and the
  // stroke under it is out of reach (the tool's own gestures, then the scene, see the press exactly as without a stroke).
  const reach = await point(page, 62, 32, -21);
  assert.equal(await lineUnder(page, reach), true);
  for (const tool of ['callout', 'arrow', 'draw']) {
    await page.click(`.tp3d-annot-seg__btn[data-tool="${tool}"]`);
    await page.waitForFunction(() => window.probe.AnnotationTool.isActive());
    assert.equal(await lineUnder(page, reach), false, `${tool}: the tool owns the press, so the line is out of reach`);
    await page.mouse.move(reach.x, reach.y);
    await page.mouse.down();
    assert.equal(await moveState(page), 'idle', `${tool}: a press on the line starts no move`);
    assert.equal(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), null, `${tool}: and selects no stroke`);
    await page.mouse.up();
    for (let i = 0; i < 3 && await page.evaluate(() => window.probe.AnnotationTool.isActive()); i += 1) await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.probe.AnnotationTool.isActive());
    assert.equal(await writes(page), 0, `${tool}: nothing was written`);
    await page.evaluate(() => window.probe.StateStore.set({ selectedInstanceIds: [] }, { skipHistory: true }));
  }
  await startMeasuring(page);
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'true');
  assert.equal(await lineUnder(page, reach), false, 'Measurement owns the pointer');
  await page.mouse.move(reach.x, reach.y);
  await page.mouse.down();
  assert.equal(await moveState(page), 'idle', 'Measurement: a press on the line starts no move');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), null, 'Measurement: and selects no stroke');
  await page.click('#btn-editor-measure');
  await page.waitForFunction(() => document.getElementById('btn-editor-measure').getAttribute('aria-pressed') === 'false');
  await waitDrawn(page, top.id);
  assert.equal(await lineUnder(page, reach), true, 'the line is back in reach once the owner is gone');
  assert.equal(await writes(page), 0, 'none of that wrote anything');

  // A callout marker sitting on the line keeps the click: markers are above the overlay's SVG.
  const [marker] = await seed(page, [{ title: 'On the line', cargo: 'cargo-a', local: { x: -6, y: 16, z: 0 } }]);
  await page.waitForSelector(`.tp3d-annot-pin[data-annot-id="${marker.id}"]`);
  const pin = await pinCentreOf(page, `.tp3d-annot-pin[data-annot-id="${marker.id}"]`);
  await click(page, pin);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, marker.id);

  // Reload: the moved position is what the record says, and a fresh overlay draws it there.
  const stored = (await page.evaluate(() => window.probe.annotations())).find(r => r.id === top.id);
  assert.equal(JSON.stringify(await page.evaluate(record => window.probe.A.normalizeAnnotations([JSON.parse(JSON.stringify(record))])[0], stored)), JSON.stringify(stored), 'the saved record round-trips unchanged');
  const drawn = (await moveLook(page, top.id)).d;
  await page.evaluate(() => { window.probe.AnnotationTool.closePanel(); window.probe.AnnotationTool.openPanel(); });
  await page.waitForFunction(({ id, d }) => document.querySelector(`.tp3d-annot-draws .tp3d-annot-draw[data-annot-id="${id}"] .tp3d-annot-draw__line`)?.getAttribute('d') === d, { id: top.id, d: drawn });
  assert.deepEqual(errors, []);
});

// ============================================================================
// SECTION: DRAWING HIT-TESTING THROUGH THE CANVAS (V1B.2 Gate B.4.3)
// ============================================================================
const FLOOR_AIM = [[170, 0, -10], [0, 90, 120]]; // the open truck floor: no cargo stands under a stroke there
const TOP_FACE_AIM = [[90, 32, -20], [0, 70, 70]]; // cargo-a's top face, left of the panel
// Everything a gesture must not touch unless it is meant to: camera, cargo, both selections, the stored drawing and the write count.
const gestureLook = (page, id) => page.evaluate(sel => ({
  camera: window.probe.camera(),
  cases: window.probe.casesJson(),
  cargoSelection: JSON.stringify(window.probe.selection()),
  selected: window.probe.AnnotationTool.selectedId(),
  record: JSON.stringify(window.probe.annotations().find(r => r.id === sel) || null),
  writes: window.__writes,
}), id);
const changedBy = (before, after) => Object.keys(before).filter(key => before[key] !== after[key]);
const freshDrawing = async (page, previous, make) => {
  if (previous) await page.evaluate(id => window.probe.PackLibrary.deleteAnnotation('fixture-pack', id), previous.id);
  const record = await make();
  await waitDrawn(page, record.id);
  await watchWrites(page);
  return record;
};
// aimCamera, then the camera's damping residue (left by an earlier gesture) is run out, so a camera that is "unchanged" is exactly so.
const aimStill = async (page, ...aim) => {
  await aimCamera(page, ...aim);
  await page.evaluate(() => { const controls = window.probe.SceneManager.getControls(); for (let i = 0; i < 400; i += 1) controls.update(); });
  await cameraSettled(page);
};
const moving = () => window.probe.AnnotationTool.moveState() === 'moving';
const idle = () => window.probe.AnnotationTool.moveState() === 'idle';

test('annotation drawing gestures: the canvas decides who owns a press - a plain primary press on a line is the drawing\'s and the camera never turns under it, every other button, key and wheel over the line is camera navigation', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await watchWrites(page);
  await watchPointer(page);
  await aimStill(page, ...FLOOR_AIM);
  const makeFloor = () => seedFloorDraw(page, [150, -30], [190, 10, 230, -20]);
  let line = await freshDrawing(page, null, makeFloor);
  const onLine = await point(page, 170, 0, -10); // the middle of the stroke's first segment
  const along = await point(page, 190, 0, 0);
  const open = { x: onLine.x - 170, y: onLine.y + 60 }; // bare canvas: the same press with no line under it
  const ends = [await point(page, 150, 0, -30), await point(page, 190, 0, 10)];
  const run = Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y);
  const normal = { x: -(ends[1].y - ends[0].y) / run, y: (ends[1].x - ends[0].x) / run };
  const off = px => ({ x: onLine.x + normal.x * px, y: onLine.y + normal.y * px });

  // The hit area is the line's own screen geometry plus a small reach: close beside the line is on it, a finger-width away is not.
  assert.equal(await page.locator('.tp3d-annot-draw__hit').count(), 0, 'no stroke has a hit element of its own');
  assert.equal(await reachAt(page, onLine), 'canvas');
  assert.equal(await lineUnder(page, onLine), true);
  assert.equal(await lineUnder(page, off(5)), true, '5 px beside the line is on it for a mouse');
  assert.equal(await lineUnder(page, off(-5)), true);
  assert.equal(await lineUnder(page, off(14)), false, '14 px away is not');
  assert.equal(await lineUnder(page, open), false);
  await page.mouse.move(onLine.x, onLine.y);
  await page.waitForFunction(() => document.querySelector('#viewport canvas').style.cursor === 'grab');
  await page.mouse.move(open.x, open.y, { steps: 6 }); // the Editor's hover is throttled: it follows a stream of moves, not one jump
  await page.waitForFunction(() => document.querySelector('#viewport canvas').style.cursor === 'default');

  // A plain click selects and changes nothing else: not the camera, not the cargo, not a write.
  let before = await gestureLook(page, line.id);
  await click(page, off(3));
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, line.id);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), ['selected'], 'a click beside the line selects it and nothing else');
  assert.equal(await rotationEnabled(page), true);
  assert.equal(await controlsState(page), -1, 'the camera has no gesture left running');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() === null);

  // A plain drag carries the line: nothing else changes while it moves, and one write is all that follows the release.
  before = await gestureLook(page, line.id);
  await page.mouse.move(onLine.x, onLine.y);
  await page.mouse.down();
  await page.mouse.move(along.x, along.y, { steps: 10 });
  await page.waitForFunction(moving);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], 'while it is carried the camera, the cargo, the selections and the record are as they were');
  assert.equal(await rotationEnabled(page), false);
  await page.mouse.up();
  await page.waitForFunction(idle);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).sort(), ['record', 'selected', 'writes'], 'the release moves the drawing, selects it and writes - and the camera and cargo are untouched');
  assert.equal(await writes(page), 1, 'exactly one write');
  assert.equal(await rotationEnabled(page), true);
  assert.equal(await controlsState(page), -1);

  // Cancellations that arrive after a good release leave that commit alone and add nothing.
  const committed = JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === line.id));
  const lastPointer = await pointerId(page);
  await page.evaluate(id => {
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, bubbles: true }));
    document.querySelector('#viewport canvas').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: id, bubbles: true }));
    window.dispatchEvent(new Event('blur'));
  }, lastPointer);
  await page.keyboard.press('Escape');
  assert.equal(await writes(page), 1, 'a trailing cancellation adds no write');
  assert.equal(JSON.stringify((await page.evaluate(() => window.probe.annotations())).find(r => r.id === line.id)), committed, 'and does not undo the move');

  // Every other button, key and the wheel over the line is camera navigation, exactly as beside it: the line is not selected, moved or
  // written, no move starts, and nothing holds the camera back.
  line = await freshDrawing(page, line, makeFloor);
  const navigated = {};
  for (const [label, button, key] of [['right button', 'right', null], ['middle button', 'middle', null], ['Shift', 'left', 'Shift'], ['Ctrl', 'left', 'Control'], ['Cmd', 'left', 'Meta']]) {
    for (const [where, from] of [['on the line', onLine], ['beside it', open]]) {
      await aimStill(page, ...FLOOR_AIM);
      before = await gestureLook(page, line.id);
      if (key) await page.keyboard.down(key);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button });
      await page.mouse.move(from.x + 50, from.y + 30, { steps: 8 });
      assert.equal(await moveState(page), 'idle', `${label} ${where}: no move starts`);
      assert.equal(await rotationEnabled(page), true, `${label} ${where}: the camera is not held back`);
      await page.mouse.up({ button });
      if (key) await page.keyboard.up(key);
      await cameraSettled(page);
      navigated[`${label} ${where}`] = changedBy(before, await gestureLook(page, line.id));
    }
    assert.deepEqual(navigated[`${label} on the line`], ['camera'], `${label}: over the line it navigates and changes nothing else`);
    assert.deepEqual(navigated[`${label} on the line`], navigated[`${label} beside it`], `${label}: exactly as beside the line`);
  }
  await aimStill(page, ...FLOOR_AIM);
  before = await gestureLook(page, line.id);
  await page.mouse.move(onLine.x, onLine.y);
  await page.mouse.wheel(0, -240);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), ['camera'], 'the wheel zooms over the line');
  await aimStill(page, ...FLOOR_AIM);
  before = await gestureLook(page, line.id);
  await page.keyboard.down('Shift');
  await click(page, onLine);
  await page.keyboard.up('Shift');
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], 'a Shift click on the line selects and writes nothing');

  // Ending a move early never lets the press that began it turn the camera: the button is still down on the line's press.
  for (const [label, cancel] of [['Escape', () => page.keyboard.press('Escape')], ['window blur', () => page.evaluate(() => window.dispatchEvent(new Event('blur')))]]) {
    line = await freshDrawing(page, line, makeFloor);
    await aimStill(page, ...FLOOR_AIM);
    before = await gestureLook(page, line.id);
    await page.mouse.move(onLine.x, onLine.y);
    await page.mouse.down();
    await page.mouse.move(along.x, along.y, { steps: 8 });
    await page.waitForFunction(moving);
    await cancel();
    await page.waitForFunction(idle);
    await page.mouse.move(along.x + 60, along.y + 40, { steps: 8 });
    assert.equal(await rotationEnabled(page), false, `${label}: rotation stays off while the stroke's press is down`);
    await page.mouse.up();
    await cameraSettled(page);
    assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], `${label}: nothing turned, moved or was written`);
    assert.equal(await rotationEnabled(page), true, `${label}: and rotation is back`);
  }
  // The camera is whole afterwards: a drag on bare canvas turns it.
  before = await gestureLook(page, line.id);
  await page.mouse.move(open.x, open.y);
  await page.mouse.down();
  await page.mouse.move(open.x + 60, open.y + 20, { steps: 8 });
  await page.mouse.up();
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), ['camera'], 'a plain drag on bare canvas still orbits');

  // A pen is a primary pointer: its plain press carries the line (real pen input through the browser's own pipeline, not a claim about
  // any device), its barrel button is not a move - not at press time and not when it joins a press.
  const cdp = await page.context().newCDPSession(page);
  const pen = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, pointerType: 'pen', ...extra });
  await page.evaluate(() => { window.__penTypes = new Set(); window.addEventListener('pointerdown', ev => window.__penTypes.add(ev.pointerType), true); });
  line = await freshDrawing(page, line, makeFloor);
  await aimStill(page, ...FLOOR_AIM);
  before = await gestureLook(page, line.id);
  await pen('mouseMoved', onLine);
  await pen('mousePressed', onLine, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) await pen('mouseMoved', { x: onLine.x + (along.x - onLine.x) * i / 8, y: onLine.y + (along.y - onLine.y) * i / 8 }, { buttons: 1 });
  await page.waitForFunction(moving);
  assert.deepEqual(await page.evaluate(() => [...window.__penTypes]), ['pen'], 'the press really was a pen');
  await pen('mouseReleased', along, { button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForFunction(idle);
  assert.equal(await writes(page), 1, 'a pen drag writes once');
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).sort(), ['record', 'selected', 'writes']);
  line = await freshDrawing(page, line, makeFloor);
  await aimStill(page, ...FLOOR_AIM);
  before = await gestureLook(page, line.id);
  await pen('mouseMoved', onLine);
  await pen('mousePressed', onLine, { button: 'left', buttons: 1, clickCount: 1 });
  await pen('mouseMoved', { x: onLine.x + 30, y: onLine.y + 10 }, { buttons: 1 });
  await pen('mouseMoved', { x: onLine.x + 50, y: onLine.y + 18 }, { buttons: 1 });
  await page.waitForFunction(moving);
  await pen('mouseMoved', { x: onLine.x + 60, y: onLine.y + 24 }, { buttons: 3 }); // the barrel button joins
  await page.waitForFunction(idle);
  await pen('mouseReleased', { x: onLine.x + 60, y: onLine.y + 24 }, { button: 'left', buttons: 0, clickCount: 1 });
  await cameraSettled(page);
  assert.equal(await writes(page), 0, 'a barrel button joining the press ends the move without a write');
  assert.equal((await gestureLook(page, line.id)).record, before.record);
  assert.equal(await rotationEnabled(page), true);
  await pen('mouseMoved', onLine);
  await pen('mousePressed', onLine, { button: 'right', buttons: 2, clickCount: 1 });
  assert.equal(await moveState(page), 'idle', 'a press with the barrel button starts no move');
  await pen('mouseReleased', onLine, { button: 'right', buttons: 0, clickCount: 1 });
  assert.equal(await writes(page), 0);
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), null);

  // On cargo the same press is the stroke's when it lands on the line and the Editor's own cargo gesture when it lands beside it.
  await aimStill(page, ...TOP_FACE_AIM);
  line = await freshDrawing(page, line, () => seedDraw(page));
  const on = await point(page, 58, 32, -24);
  const beside = await point(page, 70, 32, -14);
  const target = await point(page, 62, 32, -20);
  assert.equal(await lineUnder(page, on), true);
  assert.equal(await lineUnder(page, beside), false);
  const home = await page.evaluate(() => JSON.stringify(window.probe.PackLibrary.getById('fixture-pack').cases.find(c => c.id === 'cargo-a').transform));
  const restore = async () => {
    await page.evaluate(saved => {
      window.probe.PackLibrary.updateInstance('fixture-pack', 'cargo-a', { transform: JSON.parse(saved) });
      window.probe.StateStore.set({ selectedInstanceIds: [] }, { skipHistory: true });
    }, home);
    await aimStill(page, ...TOP_FACE_AIM);
    await watchWrites(page);
  };
  const outcomes = {};
  for (const [label, button, key] of [['right button', 'right', null], ['middle button', 'middle', null], ['Shift', 'left', 'Shift'], ['Ctrl', 'left', 'Control'], ['Cmd', 'left', 'Meta']]) {
    for (const [where, from] of [['on', on], ['beside', beside]]) {
      await restore();
      before = await gestureLook(page, line.id);
      if (key) await page.keyboard.down(key);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button });
      await page.mouse.move(from.x + 40, from.y + 25, { steps: 8 });
      await page.mouse.up({ button });
      if (key) await page.keyboard.up(key);
      await cameraSettled(page);
      outcomes[`${label} ${where}`] = changedBy(before, await gestureLook(page, line.id));
    }
    assert.deepEqual(outcomes[`${label} on`], outcomes[`${label} beside`], `${label}: a press on the line does what the same press beside it does`);
    assert.ok(!outcomes[`${label} on`].some(key => ['record', 'selected', 'writes'].includes(key)), `${label}: the drawing is not selected, moved or written`);
  }
  // A double click on a line is not the camera's focus gesture: beside the line, on the cargo, it is.
  for (const [where, from, focuses] of [['beside the line', beside, true], ['on the line', on, false]]) {
    await restore();
    before = await gestureLook(page, line.id);
    await page.mouse.dblclick(from.x, from.y);
    await page.waitForTimeout(1000); // the focus animation runs 700 ms
    await cameraSettled(page);
    assert.equal((await gestureLook(page, line.id)).camera !== before.camera, focuses, `a double click ${where} ${focuses ? 'focuses' : 'does not refocus'} the camera`);
    await page.keyboard.press('Escape');
  }
  await restore();
  before = await gestureLook(page, line.id);
  await page.mouse.move(beside.x, beside.y);
  await page.mouse.down();
  await page.mouse.move(beside.x + 40, beside.y + 25, { steps: 8 });
  await page.mouse.up();
  await cameraSettled(page);
  assert.ok(changedBy(before, await gestureLook(page, line.id)).includes('cases'), 'beside the line a plain drag still moves the cargo - the Editor\'s own gesture');
  await restore();
  before = await gestureLook(page, line.id);
  await page.mouse.move(on.x, on.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.waitForFunction(moving);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], 'on the line it carries the stroke: no cargo, selection or camera moves meanwhile');
  await page.mouse.up();
  await page.waitForFunction(() => window.__writes === 1);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).sort(), ['record', 'selected', 'writes'], 'and the release writes the stroke once and nothing else');
  assert.deepEqual(errors, []);
});

test('annotation drawing reach: only a drawing that is shown, valid and the topmost under the pointer takes a press', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await watchWrites(page);
  await aimStill(page, ...FLOOR_AIM);
  // Two strokes cross at one place; the second is painted on top. A third lies on its own.
  const first = await seedFloorDraw(page, [150, -30], [230, 10]);
  const second = await seedFloorDraw(page, [150, 10], [230, -30]);
  await waitDrawn(page, first.id);
  await waitDrawn(page, second.id);
  const crossing = await point(page, 190, 0, -10);
  const onFirst = await point(page, 160, 0, -25);
  const onSecond = await point(page, 160, 0, 5);
  assert.equal(await lineUnder(page, crossing), true);

  // Where lines cross the one painted on top is the one that is taken, as it looks.
  await watchWrites(page);
  await click(page, crossing);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, second.id);
  await page.keyboard.press('Escape');
  await click(page, onFirst);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, first.id);
  await page.keyboard.press('Escape');
  await click(page, onSecond);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, second.id);
  await page.keyboard.press('Escape');

  // Show Selected keeps the selected drawing in reach and the other out; Show Off leaves both out.
  await click(page, onFirst);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, first.id);
  await showButton(page, 'Selected').click();
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draw__line[d]:not([d=""])').length === 1);
  assert.equal(await lineUnder(page, onFirst), true, 'Show Selected: the selected drawing is in reach');
  assert.equal(await lineUnder(page, onSecond), false, 'Show Selected: the other one is not');
  await showButton(page, 'Off').click();
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draw__line[d]:not([d=""])').length === 0);
  assert.equal(await lineUnder(page, onFirst), false, 'Show Off: neither is');
  assert.equal(await lineUnder(page, onSecond), false);
  await showButton(page, 'All').click();
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draw__line[d]:not([d=""])').length === 2);
  assert.equal(await lineUnder(page, onSecond), true, 'Show All: both are back');
  await page.keyboard.press('Escape');

  // A hidden drawing is neither drawn nor in reach, and the one it overlaps is.
  await page.evaluate(id => { if (!window.probe.PackLibrary.updateDraw('fixture-pack', id, { hidden: true }).ok) throw new Error('hide failed'); }, second.id);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draw__line[d]:not([d=""])').length === 1);
  assert.equal(await lineUnder(page, onSecond), false, 'a hidden drawing is out of reach');
  assert.equal(await lineUnder(page, crossing), true, 'and the other drawing at the crossing is in reach');
  await click(page, crossing);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, first.id);
  await page.keyboard.press('Escape');
  assert.equal(await writes(page), 1, 'only the hide itself was written');

  // A stroke the cargo hides is drawn faintly but is not in reach: only what is drawn as clear can be taken. Seen from the far side it is.
  await aimStill(page, [70, 16, -20], [90, 30, 0]);
  const hidden = await seedDraw(page, { local: { x: -24, y: 8, z: -8 }, face: '-x', rest: [-7.5, 8, 6, 8] }); // cargo-a's far (-x) face
  await waitDrawn(page, hidden.id);
  await cameraSettled(page);
  const behind = await point(page, 46, 24, -20);
  assert.equal(await lineUnder(page, behind), false, 'a stroke behind the cargo is out of reach');
  await aimStill(page, [70, 16, -20], [-90, 30, 0]);
  await waitDrawn(page, hidden.id);
  const facing = await point(page, 46, 24, -20);
  assert.equal(await lineUnder(page, facing), true, 'and in reach once it faces the camera');
  assert.deepEqual(errors, []);
});

test('annotation drawing touch: one finger on a line selects and carries it, a second finger ends the move without a write and the two are a native pinch, and a cancelled finger never turns the camera or drags cargo', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await watchWrites(page);
  // Real touch input through the browser's own pipeline (Chrome's touch emulation); it is not a claim about any particular device.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const down = new Map();
  const send = type => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down].map(([id, p]) => ({ x: p.x, y: p.y, id })) });
  const finger = {
    async press(id, p) { down.set(id, p); await send('touchStart'); },
    async move(id, p) { down.set(id, p); await send('touchMove'); },
    async lift(id) { down.delete(id); await send('touchEnd'); },
    async cancel() { down.clear(); await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); },
    async drag(id, from, to, steps = 8) { for (let i = 1; i <= steps; i += 1) await finger.move(id, { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }); },
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 250));
  const distance = () => page.evaluate(() => window.probe.SceneManager.getControls().getDistance());

  await aimStill(page, ...FLOOR_AIM);
  const makeFloor = () => seedFloorDraw(page, [150, -30], [190, 10, 230, -20]);
  let line = await freshDrawing(page, null, makeFloor);
  const onLine = await point(page, 170, 0, -10);
  const along = await point(page, 190, 0, 0);
  const open = { x: onLine.x - 170, y: onLine.y + 60 }; // bare canvas
  const ends = [await point(page, 150, 0, -30), await point(page, 190, 0, 10)];
  const run = Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y);
  const normal = { x: -(ends[1].y - ends[0].y) / run, y: (ends[1].x - ends[0].x) / run };
  const off = px => ({ x: onLine.x + normal.x * px, y: onLine.y + normal.y * px });
  assert.equal(await lineUnder(page, onLine), true);
  assert.equal(await lineUnder(page, open), false);

  // One finger: a tap selects and changes nothing else; a finger a little off the line still counts, one clearly away does not.
  let before = await gestureLook(page, line.id);
  await finger.press(1, off(10));
  await finger.lift(1);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, line.id);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), ['selected'], 'a tap 10 px off the line selects it and nothing else');
  assert.equal(await rotationEnabled(page), true);
  assert.equal(await controlsState(page), -1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() === null);
  await finger.press(1, off(26));
  await finger.lift(1);
  await settle();
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), null, 'a tap 26 px away selects nothing');

  // One finger carries the line: the camera and cargo stay put meanwhile, the release writes once.
  before = await gestureLook(page, line.id);
  await finger.press(2, onLine);
  await finger.drag(2, onLine, along);
  await page.waitForFunction(moving);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], 'while it is carried nothing else changes');
  assert.equal(await rotationEnabled(page), false);
  await finger.lift(2);
  await page.waitForFunction(() => window.probe.AnnotationTool.moveState() === 'idle' && window.__writes === 1);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).sort(), ['record', 'selected', 'writes'], 'one finger moved the line, once, and nothing else');
  assert.equal(await rotationEnabled(page), true);
  assert.equal(await controlsState(page), -1);

  // A second finger while the first carries the line: the move ends without a write and the two fingers are a pinch the camera takes natively.
  for (const lifted of ['the set-aside finger first', 'the second finger first']) {
    await aimStill(page, ...FLOOR_AIM);
    line = await freshDrawing(page, line, makeFloor);
    const drawn = (await moveLook(page, line.id)).d;
    before = await gestureLook(page, line.id);
    const [first, second] = lifted.startsWith('the set') ? [3, 4] : [5, 6];
    await finger.press(first, onLine);
    await finger.drag(first, onLine, along, 6);
    await page.waitForFunction(moving);
    await finger.press(second, open);
    await page.waitForFunction(idle);
    assert.match(await page.evaluate(() => window.probe.hint()), /move cancelled/i, lifted);
    assert.equal((await moveLook(page, line.id)).d, drawn, `${lifted}: the line is drawn where it was`);
    assert.equal(await rotationEnabled(page), true, `${lifted}: the camera is handed back for the pinch`);
    assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], `${lifted}: no write and no change so far`);
    const apart = await distance();
    for (let i = 1; i <= 10; i += 1) {
      await finger.move(first, { x: along.x - 8 * i, y: along.y - 2 * i });
      await finger.move(second, { x: open.x + 8 * i, y: open.y + 2 * i });
    }
    await settle();
    assert.equal(await controlsState(page), 5, `${lifted}: OrbitControls is in its own two-finger dolly/pan`);
    assert.ok(await distance() > apart + 1, `${lifted}: bringing the fingers together zooms out (${apart} -> ${await distance()})`);
    const [early, late] = lifted.startsWith('the set') ? [first, second] : [second, first];
    await finger.lift(early);
    await finger.drag(late, down.get(late), { x: down.get(late).x + 50, y: down.get(late).y + 30 }, 6);
    await settle();
    await finger.lift(late);
    await cameraSettled(page);
    const after = await gestureLook(page, line.id);
    assert.deepEqual(changedBy(before, after).filter(key => key !== 'camera'), [], `${lifted}: the pinch wrote, selected and moved nothing`);
    assert.notEqual(after.camera, before.camera, `${lifted}: the camera moved`);
    assert.equal(await controlsState(page), -1, `${lifted}: no camera gesture is left running`);
    assert.equal(await rotationEnabled(page), true, `${lifted}: rotation is on`);
  }

  // A cancelled touch (a browser pointercancel) ends the move without a write; the next finger is an ordinary camera finger.
  await aimStill(page, ...FLOOR_AIM);
  line = await freshDrawing(page, line, makeFloor);
  before = await gestureLook(page, line.id);
  await finger.press(7, onLine);
  await finger.drag(7, onLine, along, 6);
  await page.waitForFunction(moving);
  await finger.cancel();
  await page.waitForFunction(idle);
  assert.match(await page.evaluate(() => window.probe.hint()), /move cancelled/i);
  assert.equal(await rotationEnabled(page), true, 'the cancelled finger holds nothing');
  assert.equal(await controlsState(page), -1);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), [], 'a cancelled touch wrote and changed nothing');
  await finger.press(8, open);
  await finger.drag(8, open, { x: open.x - 70, y: open.y + 20 }, 8);
  await settle();
  await finger.lift(8);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), ['camera'], 'the next finger orbits the camera');

  // A pinch on bare canvas is untouched, and so is a second finger that lands on a line: it joins the pinch, it selects and moves nothing.
  await aimStill(page, ...FLOOR_AIM);
  before = await gestureLook(page, line.id);
  await finger.press(9, { x: open.x - 40, y: open.y });
  await finger.press(10, { x: open.x + 40, y: open.y });
  for (let i = 1; i <= 8; i += 1) {
    await finger.move(9, { x: open.x - 40 - 6 * i, y: open.y });
    await finger.move(10, { x: open.x + 40 + 6 * i, y: open.y });
  }
  await finger.lift(9);
  await finger.lift(10);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)), ['camera'], 'a pinch away from any line zooms');
  await aimStill(page, ...FLOOR_AIM);
  before = await gestureLook(page, line.id);
  await finger.press(11, open);
  await finger.press(12, onLine);
  assert.equal(await moveState(page), 'idle', 'a second finger on a line starts no move');
  await finger.drag(12, onLine, along, 10);
  await settle();
  await finger.lift(12);
  await finger.lift(11);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).filter(key => key !== 'camera'), [], 'a finger sliding on a line while another is down selects, moves and writes nothing');
  assert.equal(await controlsState(page), -1);

  // On cargo: the second finger lands on the cargo face while the first, set aside, keeps moving. Neither starts a cargo drag.
  await aimStill(page, ...TOP_FACE_AIM);
  line = await freshDrawing(page, line, () => seedDraw(page));
  const stroke = await point(page, 58, 32, -24);
  const face = await point(page, 70, 32, -14);
  assert.equal(await lineUnder(page, stroke), true);
  assert.equal(await lineUnder(page, face), false);
  before = await gestureLook(page, line.id);
  await finger.press(13, stroke);
  await finger.drag(13, stroke, { x: stroke.x - 40, y: stroke.y - 15 }, 6);
  await page.waitForFunction(moving);
  await finger.press(14, face);
  await page.waitForFunction(idle);
  await finger.drag(13, { x: stroke.x - 40, y: stroke.y - 15 }, { x: stroke.x - 160, y: stroke.y + 30 }, 10);
  await finger.drag(14, face, { x: face.x + 60, y: face.y + 10 }, 6);
  await settle();
  const held = await gestureLook(page, line.id);
  assert.equal(held.cases, before.cases, 'neither finger drags cargo');
  assert.equal(held.cargoSelection, before.cargoSelection, 'or selects any');
  assert.equal(held.record, before.record);
  assert.equal(held.writes, 0);
  await finger.lift(14);
  await finger.drag(13, { x: stroke.x - 160, y: stroke.y + 30 }, { x: stroke.x - 90, y: stroke.y + 70 }, 6); // the set-aside finger alone, still no cargo drag
  await finger.lift(13);
  await cameraSettled(page);
  const end = await gestureLook(page, line.id);
  assert.equal(end.cases, before.cases, 'nor does the finger left alone');
  assert.equal(end.cargoSelection, before.cargoSelection);
  assert.equal(end.writes, 0);
  assert.equal(await controlsState(page), -1);
  assert.equal(await rotationEnabled(page), true);
  assert.deepEqual(errors, []);
});

test('annotation drawing mixed pointers: a different kind of pointer pressing during a drawing press ends that move without a write and hands the camera on, whichever came first, and two fingers stay a pinch', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  // Real touch through the browser's own pipeline (Chrome's touch emulation) beside the real mouse; it is not a claim about any device.
  const fingersOn = async target => {
    const cdp = await target.context().newCDPSession(target);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const down = new Map();
    const send = type => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down].map(([id, p]) => ({ x: p.x, y: p.y, id })) });
    const finger = {
      async press(id, p) { down.set(id, p); await send('touchStart'); },
      async move(id, p) { down.set(id, p); await send('touchMove'); },
      async lift(id) { down.delete(id); await send('touchEnd'); },
      async drag(id, from, to, steps = 8) { for (let i = 1; i <= steps; i += 1) await finger.move(id, { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }); },
    };
    return finger;
  };
  const fatalOverlay = target => target.evaluate(() => Boolean(document.querySelector('.system-overlay.active .error-card')));
  const held = (target, id) => target.evaluate(pid => window.probe.AnnotationTool.ownsPointer({ pointerId: pid }), id);

  // The same two pairs of pointers on bare canvas with no drawing at all: what OrbitControls does by itself. A finger landing while a
  // mouse button is down is an OrbitControls error of its own (r185.1 reads a second pointer it never tracked) and the app answers any
  // uncaught error with its fatal-error overlay, so that pair is the yardstick for the one sequence that cannot be clean.
  const ref = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(ref.page);
  await aimStill(ref.page, ...FLOOR_AIM);
  const open = await point(ref.page, 170, 0, -10).then(p => ({ x: p.x - 170, y: p.y + 60 })); // bare canvas
  const refFinger = await fingersOn(ref.page);
  let seen = ref.errors.length;
  await refFinger.press(1, open);
  await ref.page.mouse.move(open.x + 40, open.y);
  await ref.page.mouse.down();
  await ref.page.mouse.move(open.x + 100, open.y + 20, { steps: 6 });
  await ref.page.mouse.up();
  await refFinger.lift(1);
  const fingerThenMouse = ref.errors.length - seen;
  seen = ref.errors.length;
  await ref.page.mouse.move(open.x, open.y);
  await ref.page.mouse.down();
  await ref.page.mouse.move(open.x + 30, open.y + 10, { steps: 4 });
  await refFinger.press(2, { x: open.x + 100, y: open.y });
  await refFinger.lift(2);
  await ref.page.mouse.up();
  const mouseThenFinger = ref.errors.length - seen;
  const fatalWithoutDrawing = await fatalOverlay(ref.page);
  assert.equal(fingerThenMouse, 0, 'reference: a mouse press after a finger is no error');
  assert.ok(mouseThenFinger > 0 && fatalWithoutDrawing, 'reference: a finger after a mouse press is an OrbitControls error and the fatal overlay with no drawing present');
  await ref.page.close();

  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await watchWrites(page);
  await watchPointer(page);
  const finger = await fingersOn(page);
  await aimStill(page, ...FLOOR_AIM);
  const makeFloor = () => seedFloorDraw(page, [150, -30], [190, 10, 230, -20]);
  let line = await freshDrawing(page, null, makeFloor);
  const onLine = await point(page, 170, 0, -10);
  const along = await point(page, 190, 0, 0);
  assert.equal(await lineUnder(page, onLine), true);
  const carry = async (id, from, to) => { // the line is being carried by this finger
    await finger.press(id, from);
    await finger.drag(id, from, to, 6);
    await page.waitForFunction(moving);
    const pointer = await pointerId(page);
    assert.equal(await held(page, pointer), true, 'the press is held');
    assert.equal(await rotationEnabled(page), false, 'and rotation is off for it');
    return pointer;
  };
  const endedWithoutWrite = async (pointer, drawn, label, { said = true } = {}) => {
    await page.waitForFunction(idle);
    if (said) assert.match(await page.evaluate(() => window.probe.hint()), /move cancelled/i, label);
    assert.equal(await held(page, pointer), false, `${label}: the hold ended`);
    assert.equal((await moveLook(page, line.id)).d, drawn, `${label}: the line is drawn where it was`);
    assert.equal(await writes(page), 0, `${label}: nothing written`);
  };

  // 1. A finger carries the line, then the mouse presses elsewhere: a fresh gesture that orbits natively.
  let drawn = (await moveLook(page, line.id)).d;
  let before = await gestureLook(page, line.id);
  seen = errors.length;
  let pointer = await carry(1, onLine, along);
  await page.mouse.move(open.x, open.y);
  await page.mouse.down();
  await endedWithoutWrite(pointer, drawn, 'finger then mouse');
  assert.equal(await rotationEnabled(page), true, 'finger then mouse: rotation is handed back');
  await page.mouse.move(open.x + 60, open.y + 20, { steps: 8 });
  await page.mouse.up();
  await cameraSettled(page);
  assert.notEqual(await page.evaluate(() => window.probe.camera()), before.camera, 'finger then mouse: the mouse orbits');
  await finger.drag(1, along, { x: along.x + 30, y: along.y + 20 }, 4); // the original finger is still down: its later moves and its release commit nothing
  await finger.lift(1);
  await page.waitForTimeout(150);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).filter(key => key !== 'camera'), [], 'finger then mouse: nothing but the camera changed, and nothing was written later');
  assert.equal(errors.length - seen, fingerThenMouse, 'finger then mouse: no error beyond the reference');

  // 1b. The claim gives back what it found: a rotation another owner had off stays off, and an armed Draw keeps its own restriction.
  line = await freshDrawing(page, line, makeFloor);
  await aimStill(page, ...FLOOR_AIM);
  drawn = (await moveLook(page, line.id)).d;
  await page.evaluate(() => { window.probe.SceneManager.getControls().enableRotate = false; });
  pointer = await carry(2, onLine, along);
  await page.mouse.move(open.x, open.y);
  await page.mouse.down();
  await endedWithoutWrite(pointer, drawn, 'prior value');
  assert.equal(await rotationEnabled(page), false, 'prior value: a rotation that was already off stays off');
  await page.mouse.up();
  await finger.lift(2);
  await page.evaluate(() => { window.probe.SceneManager.getControls().enableRotate = true; });
  line = await freshDrawing(page, line, makeFloor);
  await aimStill(page, ...FLOOR_AIM);
  drawn = (await moveLook(page, line.id)).d;
  pointer = await carry(3, onLine, along);
  await page.click('.tp3d-annot-seg__btn[data-tool="draw"]'); // a mouse press on the panel while the finger holds the line, then Draw is armed
  await endedWithoutWrite(pointer, drawn, 'Draw armed', { said: false }); // arming Draw replaces the status line with its own hint
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() !== 'off');
  assert.equal(await rotationEnabled(page), false, 'Draw armed: its own restriction holds');
  assert.equal(await escapeConsumed(page), true);
  await page.waitForFunction(() => window.probe.AnnotationTool.drawingState() === 'off');
  assert.equal(await rotationEnabled(page), true, 'Draw ended: rotation is back');
  await finger.lift(3);
  await page.waitForTimeout(150);
  assert.equal(await writes(page), 0);

  // 2. Two fingers stay a pinch: the move ends, the camera takes both natively, and nothing is written.
  line = await freshDrawing(page, line, makeFloor);
  await aimStill(page, ...FLOOR_AIM);
  drawn = (await moveLook(page, line.id)).d;
  before = await gestureLook(page, line.id);
  pointer = await carry(4, onLine, along);
  await finger.press(5, open);
  await endedWithoutWrite(pointer, drawn, 'two fingers');
  for (let i = 1; i <= 8; i += 1) {
    await finger.move(4, { x: along.x - 8 * i, y: along.y - 2 * i });
    await finger.move(5, { x: open.x + 8 * i, y: open.y + 2 * i });
  }
  assert.equal(await controlsState(page), 5, 'two fingers: OrbitControls is in its own two-finger gesture');
  await finger.lift(5);
  await finger.lift(4);
  await cameraSettled(page);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).filter(key => key !== 'camera'), [], 'two fingers: nothing but the camera changed');
  assert.equal(await controlsState(page), -1);

  // The drawing itself is whole afterwards.
  await aimStill(page, ...FLOOR_AIM);
  await watchWrites(page);
  await page.mouse.move(onLine.x, onLine.y);
  await page.mouse.down();
  await page.mouse.move(along.x, along.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__writes === 1);

  // 3. The mouse carries the line, then a finger presses elsewhere. That pair is OrbitControls' own error (and the app's fatal overlay)
  // with or without a drawing, so it comes last; what the drawing does about it is still checked: it lets go and writes nothing.
  line = await freshDrawing(page, line, makeFloor);
  await aimStill(page, ...FLOOR_AIM);
  drawn = (await moveLook(page, line.id)).d;
  before = await gestureLook(page, line.id);
  seen = errors.length;
  await page.mouse.move(onLine.x, onLine.y);
  await page.mouse.down();
  await page.mouse.move(along.x, along.y, { steps: 8 });
  await page.waitForFunction(moving);
  pointer = await pointerId(page);
  assert.equal(await held(page, pointer), true);
  assert.equal(await rotationEnabled(page), false);
  await finger.press(6, open);
  await endedWithoutWrite(pointer, drawn, 'mouse then finger');
  assert.equal(await rotationEnabled(page), true, 'mouse then finger: rotation is handed back');
  await finger.lift(6);
  await page.mouse.move(along.x + 40, along.y + 30, { steps: 4 }); // the mouse is still down: its later moves and its release commit nothing
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).filter(key => key !== 'camera'), [], 'mouse then finger: nothing but the camera changed, and nothing was written later');
  assert.equal(errors.length - seen, mouseThenFinger, 'mouse then finger: exactly the errors the same pointers raise with no drawing (OrbitControls, not the drawing)');
  assert.equal(await fatalOverlay(page), fatalWithoutDrawing, 'and the same fatal overlay');
  assert.ok(errors.every(message => /reading 'x'/.test(message)), `no error but OrbitControls' own: ${errors.join(' | ')}`);
});

// ============================================================================
// SECTION: DRAWING LINE AND SELECTION APPEARANCE (V1B.2 Gate B.4.2)
// ============================================================================
// What a drawing's line and the edge under it are painted with, read from the page: widths, pattern, colors and the edge's opacity.
const drawLook = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.tp3d-annot-svg .tp3d-annot-draws .tp3d-annot-draw:not(.is-preview)')]
  .filter(group => group.dataset.lineStyle)
  .map(group => {
    const line = getComputedStyle(group.querySelector('.tp3d-annot-draw__line'));
    const edge = getComputedStyle(group.querySelector('.tp3d-annot-draw__under'));
    return [group.dataset.annotId, {
      style: group.dataset.lineStyle,
      selected: group.classList.contains('is-selected'),
      occluded: group.classList.contains('is-occluded'),
      dash: line.strokeDasharray,
      lineWidth: parseFloat(line.strokeWidth),
      lineStroke: line.stroke,
      edgeWidth: parseFloat(edge.strokeWidth),
      edgeStroke: edge.stroke,
      edgeOpacity: parseFloat(edge.strokeOpacity),
    }];
  })));

test('annotation drawing missed release: a press that reuses the id of a press whose end was never heard abandons that move, so the later release writes nothing, the camera is free and the next drawing gesture is a normal one', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  // Events the page never hears: this capture listener is added before the drawing's own window listeners (those come with the press), so
  // it stops each one first. Between the last move of the old press and the new press nothing reaches the page, as when a release is lost.
  await page.evaluate(() => {
    window.__lose = false;
    for (const type of ['pointerup', 'pointercancel', 'pointermove', 'lostpointercapture']) window.addEventListener(type, ev => { if (window.__lose) ev.stopImmediatePropagation(); }, true);
  });
  await watchWrites(page);
  await watchPointer(page);
  await aimStill(page, ...FLOOR_AIM);
  const line = await freshDrawing(page, null, () => seedFloorDraw(page, [150, -30], [190, 10, 230, -20]));
  const onLine = await point(page, 170, 0, -10);
  const along = await point(page, 190, 0, 0);
  const open = { x: onLine.x - 170, y: onLine.y + 60 }; // bare canvas
  const state = () => page.evaluate(() => ({ stored: JSON.stringify(window.probe.annotations()), edited: window.probe.PackLibrary.getById('fixture-pack').lastEdited, cases: window.probe.casesJson() }));
  const held = id => page.evaluate(pid => window.probe.AnnotationTool.ownsPointer({ pointerId: pid }), id);
  const seeded = await state();

  await page.mouse.move(onLine.x, onLine.y);
  await page.mouse.down();
  await page.mouse.move(along.x, along.y, { steps: 8 });
  await page.waitForFunction(moving);
  const id = await pointerId(page);
  assert.equal(await held(id), true, 'the press is held');
  assert.equal(await rotationEnabled(page), false, 'and the camera cannot turn under it');
  // Its release, the capture that ends with it and every move after are never heard.
  await page.evaluate(() => { window.__lose = true; });
  await page.mouse.up();
  await page.mouse.move(open.x, open.y);
  assert.equal(await moveState(page), 'moving', 'nothing was heard, so the move is still open');
  assert.equal(await held(id), true, 'and so is the hold');
  const camBefore = await page.evaluate(() => window.probe.camera());
  // The id comes round again on a press elsewhere, on bare canvas.
  await page.evaluate(() => { window.__lose = false; });
  await page.mouse.down();
  assert.equal(await pointerId(page), id, 'the same pointer id');
  assert.equal(await moveState(page), 'idle', 'the abandoned move ended at that press, it was not left to be finished by it');
  assert.equal(await held(id), false, 'and its hold with it');
  assert.equal(await rotationEnabled(page), true, 'the camera is handed back before it reads this press');
  await page.mouse.move(open.x + 60, open.y + 20, { steps: 8 });
  await page.mouse.up();
  await cameraSettled(page);
  assert.notEqual(await page.evaluate(() => window.probe.camera()), camBefore, 'the fresh press is an ordinary orbit');
  assert.deepEqual(await state(), seeded, 'the abandoned move wrote nothing: the record, lastEdited and the cargo are exactly as seeded');
  assert.equal(await writes(page), 0, 'no write at all');
  assert.equal(await moveState(page), 'idle');
  assert.equal(await held(id), false, 'no pointer is still owned');
  assert.equal(await rotationEnabled(page), true);
  // The next drawing gesture is an ordinary one: it goes through the usual checks and writes once.
  await aimStill(page, ...FLOOR_AIM);
  const before = await gestureLook(page, line.id);
  await page.mouse.move(onLine.x, onLine.y);
  await page.mouse.down();
  await page.mouse.move(along.x, along.y, { steps: 8 });
  await page.waitForFunction(moving);
  await page.mouse.up();
  await page.waitForFunction(() => window.__writes === 1);
  assert.deepEqual(changedBy(before, await gestureLook(page, line.id)).sort(), ['record', 'selected', 'writes'], 'the next drag moves the line, once');
  assert.equal(await held(id), false);
  assert.equal(await rotationEnabled(page), true);
  assert.equal(await moveState(page), 'idle');
  assert.deepEqual(errors, []);
});

test('annotation drawing clipped: a stroke whose segment crosses the view with both vertices outside it is measured from the part that is drawn, is out of reach while cargo hides it and in reach when it is clear', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await watchWrites(page);
  // Every ray the page casts is counted per frame; no mouse is used while a window is read, so these are the strokes' own rays.
  await page.evaluate(() => {
    const proto = window.THREE.Raycaster.prototype;
    const original = proto.intersectObjects;
    window.__rays = 0;
    window.__perFrame = [];
    proto.intersectObjects = function counted(...args) { window.__rays += 1; return original.apply(this, args); };
    let last = 0;
    const tick = () => { window.__perFrame.push(window.__rays - last); last = window.__rays; window.requestAnimationFrame(tick); };
    window.requestAnimationFrame(tick);
  });
  const raysSince = async action => {
    const from = await page.evaluate(() => window.__perFrame.length);
    await action();
    await page.waitForTimeout(700);
    return page.evaluate(start => { const frames = window.__perFrame.slice(start); return { total: frames.reduce((n, v) => n + v, 0), max: Math.max(0, ...frames) }; }, from);
  };
  const offScreen = async p => page.evaluate(({ x, y }) => { const r = document.querySelector('#viewport canvas').getBoundingClientRect(); return x < r.left || x > r.right || y < r.top || y > r.bottom; }, p);
  const drawnPath = id => page.evaluate(sel => document.querySelector(`.tp3d-annot-draws .tp3d-annot-draw[data-annot-id="${sel}"] .tp3d-annot-draw__line`)?.getAttribute('d') || '', id);
  const HIDDEN_AIM = [[70, 0, -20], [0, 40, 45]]; // cargo-a stands between the camera and the middle of the floor line
  await aimStill(page, ...HIDDEN_AIM);
  const line = await seedFloorDraw(page, [2, -20], [630, -20]); // a 628 inch segment: both vertices far outside the view
  await watchWrites(page);
  await waitDrawn(page, line.id);
  const left = await point(page, 2, 0, -20);
  const right = await point(page, 630, 0, -20);
  const middle = await point(page, 70, 0, -20);
  assert.equal(await offScreen(left), true, 'the first vertex is outside the view');
  assert.equal(await offScreen(right), true, 'and so is the last');
  assert.equal(await offScreen(middle), false, 'while the segment itself crosses it');

  // 1. Hidden by cargo: drawn, finite, and measured from what is drawn - not clear, not reachable, and it takes no input from the cargo.
  await page.waitForTimeout(700);
  await frames(page, 2);
  const path = await drawnPath(line.id);
  const numbers = (path.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  assert.ok(numbers.length === 4 && numbers.every(Number.isFinite), `the clipped path is one finite segment (${path})`);
  const viewWidth = await page.evaluate(() => document.querySelector('canvas').getBoundingClientRect().width);
  assert.ok(numbers[0] <= 0 && numbers[2] >= viewWidth && Math.abs(numbers[1] - numbers[3]) < 1, `and runs across the whole view (${path}, ${viewWidth}px)`);
  assert.equal(await reachAt(page, middle), 'canvas');
  assert.equal(await lineUnder(page, middle), false, 'cargo hides the visible part: the stroke is not reachable there');
  const casesBefore = await page.evaluate(() => window.probe.casesJson());
  await click(page, middle);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), ['cargo-a'], 'the press is the cargo\'s');
  assert.notEqual(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), line.id, 'and selects no stroke');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), casesBefore);
  assert.equal(await writes(page), 0);
  await page.keyboard.press('Escape');

  // 2. The camera moves to bare floor: the old evidence is replaced, rays were really cast, and the stroke can be selected.
  let clearAt = null;
  const camRays = [];
  for (const x of [330, 450, 560]) {
    camRays.push(await raysSince(() => aimStill(page, [x, 0, -20], [0, 40, 45])));
    const p = await point(page, x, 0, -20);
    if (await lineUnder(page, p)) { clearAt = { x, p }; break; }
  }
  assert.ok(clearAt, 'with nothing in the way the visible part is shown clear and reachable');
  assert.equal(await offScreen(await point(page, 2, 0, -20)), true, 'still with both vertices outside the view');
  assert.ok(camRays.at(-1).total >= 1, 'a ray was really cast for it: clear is a measurement, not an absence of samples');
  await click(page, clearAt.p);
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.selectedId()), line.id, 'its visible part selects it');
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'and selects no cargo');
  assert.equal(await writes(page), 0);
  await page.keyboard.press('Escape');

  // 3. Back behind the cargo: the clear evidence of the other view is gone.
  await aimStill(page, ...HIDDEN_AIM);
  await page.waitForFunction(({ x, y }) => !window.probe.AnnotationTool.hoverDrawing({ clientX: x, clientY: y, pointerType: 'mouse', buttons: 0 }), await point(page, 70, 0, -20), { timeout: 8000 });
  assert.equal(await lineUnder(page, await point(page, 70, 0, -20)), false, 'moving the camera back hides it again');

  // 4. The budget: a stroke of many long segments, all crossing the view, never costs more than five rays a measurement.
  await page.evaluate(id => window.probe.PackLibrary.deleteAnnotation('fixture-pack', id), line.id);
  const zig = await seedFloorDraw(page, [2, -48], [630, -44, 2, -40, 630, -36, 2, -32, 630, -28, 2, -24, 630, -20, 2, -16, 630, -12]);
  await waitDrawn(page, zig.id);
  const zigRays = await raysSince(() => aimStill(page, ...HIDDEN_AIM));
  assert.ok(zigRays.total >= 1, 'it was measured');
  assert.ok(zigRays.max <= 5, `at most five rays in any frame for one stroke (saw ${zigRays.max})`);

  // 5. An ordinary stroke with vertices in view is unchanged: measured, clear on open floor, reachable.
  await page.evaluate(id => window.probe.PackLibrary.deleteAnnotation('fixture-pack', id), zig.id);
  await aimStill(page, ...FLOOR_AIM);
  const plain = await seedFloorDraw(page, [150, -30], [190, 10, 230, -20]);
  await waitDrawn(page, plain.id);
  const plainRays = await raysSince(async () => { await frames(page, 2); });
  const plainAt = await point(page, 170, 0, -10);
  await page.waitForFunction(({ x, y }) => window.probe.AnnotationTool.hoverDrawing({ clientX: x, clientY: y, pointerType: 'mouse', buttons: 0 }), plainAt, { timeout: 8000 });
  assert.equal(await lineUnder(page, plainAt), true, 'an in-view stroke on open floor is reachable');
  assert.ok(plainRays.max <= 5);
  assert.deepEqual(errors, []);
});

test('annotation drawing look: a Dotted line is clean dots with no ring, a Dashed one keeps clear gaps, the selection is a restrained accent edge that keeps the line\'s color and weight, the pattern follows the stroke\'s size on screen, and Arrows are untouched', { timeout: 420000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 1400, height: 900 });
  await cameraSettled(page);
  await aimCamera(page, ...TOP_FACE_AIM);
  // One row per look on cargo A's top face (its own small face), each a gentle wave: every weight Dotted, two Dashed, one Solid.
  const wave = (v, count = 27) => Array.from({ length: count }, (_, i) => [-19.5 + i * 1.5, +(v + 1.6 * Math.sin(i * 0.55)).toFixed(2)]).flat();
  const row = (v, width, style, color) => seedDraw(page, { local: { x: -20, y: 16, z: v }, rest: wave(v), width, style, color });
  const thinDot = await row(-9, 'thin', 'dotted', 'ink');
  const regDot = await row(-5, 'regular', 'dotted', 'blue');
  const bolDot = await row(-1, 'bold', 'dotted', 'red');
  const regDash = await row(3, 'regular', 'dashed', 'blue');
  const bolDash = await row(6.5, 'bold', 'dashed', 'violet');
  const solid = await row(10, 'regular', undefined, 'green');
  const arrowDot = await seedArrow(page, [100, 62], [180, 62], { style: 'dotted' });
  const arrowDash = await seedArrow(page, [100, 74], [180, 74], { style: 'dashed', width: 'bold' });
  const everyDrawing = [thinDot, regDot, bolDot, regDash, bolDash, solid];
  await page.waitForFunction(n => document.querySelectorAll('.tp3d-annot-draws .tp3d-annot-draw__line[d]:not([d=""])').length === n, everyDrawing.length);
  await cameraSettled(page);
  await watchWrites(page);
  const select = async id => {
    await page.click(`${rowFor(id)} .tp3d-annot-row__select`);
    await page.waitForFunction(selected => window.probe.AnnotationTool.selectedId() === selected, id);
    await cameraSettled(page);
  };
  const clearSelection = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.probe.AnnotationTool.selectedId());
  };

  // Unselected, at a normal distance. The edge of a Dotted line is a hairline that never reads as a ring, and the dots stay apart.
  let look = await drawLook(page);
  const plain = Object.fromEntries(everyDrawing.map(record => [record.id, look[record.id]]));
  assert.ok(everyDrawing.every(record => plain[record.id] && plain[record.id].selected === false), 'every drawing is painted, none selected');
  assert.deepEqual([thinDot, regDot, bolDot].map(r => plain[r.id].lineWidth), [2, 3, 5], 'Thin, Regular and Bold keep their weights');
  for (const record of [thinDot, regDot, bolDot]) {
    const info = plain[record.id];
    const [dot, gap] = dashes(info.dash);
    assert.ok(dot < 0.5 && info.edgeWidth - info.lineWidth <= 2 && info.edgeOpacity <= 0.5, `${record.id}: a dot's edge is a faint hairline, not a ring (${info.edgeWidth - info.lineWidth} px at ${info.edgeOpacity})`);
    assert.ok(gap - info.edgeWidth >= 3, `${record.id}: neighbouring dots keep clear space between their edges (${gap} apart, ${info.edgeWidth} wide)`);
  }
  for (const record of [regDash, bolDash]) {
    const info = plain[record.id];
    const [dash, gap] = dashes(info.dash);
    assert.ok(dash >= info.lineWidth * 2.5 && gap >= 4 && gap < dash, `${record.id}: long dashes with clear gaps (${dash} ${gap})`);
  }
  assert.ok(dashes(plain[bolDash.id].dash)[0] > dashes(plain[regDash.id].dash)[0], 'a Bold dash is longer than a Regular one');
  assert.deepEqual([plain[solid.id].dash, plain[solid.id].edgeWidth - plain[solid.id].lineWidth, plain[solid.id].edgeOpacity], ['none', 3, 0.72], 'a Solid line keeps its continuous line and its neutral edge');

  // Selected: an accent edge that keeps the line's own color and weight, a little wider than its plain one, never a doubling of the line.
  const selectedWidths = [];
  for (const record of [thinDot, regDot, bolDot, bolDash]) {
    await select(record.id);
    look = await drawLook(page);
    const was = plain[record.id];
    const now = look[record.id];
    assert.equal(now.selected, true);
    assert.equal(now.lineWidth, was.lineWidth, `${record.id}: selecting does not change the line's weight`);
    assert.equal(now.lineStroke, was.lineStroke, `${record.id}: the line keeps the color the user chose`);
    assert.notEqual(now.edgeStroke, was.edgeStroke, `${record.id}: the edge is the accent`);
    assert.ok(now.edgeOpacity >= 0.9, `${record.id}: and it is clearly visible (${now.edgeOpacity})`);
    assert.ok(now.edgeWidth - now.lineWidth >= 1.5 && now.edgeWidth <= now.lineWidth * 2.1, `${record.id}: restrained, under twice the line (${now.edgeWidth} for ${now.lineWidth})`);
    assert.ok(now.edgeWidth - was.edgeWidth <= 2, `${record.id}: no heavier than its plain edge by more than 2 px (${was.edgeWidth} -> ${now.edgeWidth})`);
    assert.equal(now.dash, was.dash, `${record.id}: the pattern does not change when selected`);
    if (now.style === 'dotted') assert.ok(dashes(now.dash)[1] - now.edgeWidth >= 3, `${record.id}: selected dots still do not touch`);
    selectedWidths.push(now.edgeWidth);
    // Every other drawing is untouched by this selection.
    for (const other of everyDrawing.filter(r => r.id !== record.id)) assert.deepEqual(look[other.id], plain[other.id], `${other.id}: another selection leaves it alone`);
  }
  assert.ok(selectedWidths[0] < selectedWidths[1] && selectedWidths[1] < selectedWidths[2], `selected Thin, Regular and Bold stay distinguishable (${selectedWidths.slice(0, 3)})`);
  assert.equal(await writes(page), 0, 'looking at the selection writes nothing');
  await clearSelection();

  // The same saved strokes from farther away: the line's weight is the same, the pattern follows the smaller stroke and keeps its gaps.
  await aimCamera(page, [104, 32, -20], [0, 300, 300]); // a 40 in stroke is then about 105 px across, under the 140 px that gets the full pattern
  await page.waitForFunction(({ id, dash }) => {
    const group = document.querySelector(`.tp3d-annot-draws .tp3d-annot-draw[data-annot-id="${id}"] .tp3d-annot-draw__line`);
    return group && getComputedStyle(group).strokeDasharray !== dash;
  }, { id: bolDash.id, dash: plain[bolDash.id].dash });
  look = await drawLook(page);
  assert.deepEqual(everyDrawing.map(r => look[r.id].lineWidth), everyDrawing.map(r => plain[r.id].lineWidth), 'zooming out never changes a line\'s weight');
  const [nearDash, nearGap] = dashes(plain[bolDash.id].dash);
  const [farDash, farGap] = dashes(look[bolDash.id].dash);
  assert.ok(farDash < nearDash && farGap < nearGap && farGap >= 4, `a Dashed line fits its smaller stroke and keeps a clear gap (${nearDash} ${nearGap} -> ${farDash} ${farGap})`);
  for (const record of [thinDot, regDot, bolDot]) {
    const info = look[record.id];
    assert.ok(dashes(info.dash)[1] < dashes(plain[record.id].dash)[1], `${record.id}: dots sit closer on a smaller stroke`);
    assert.ok(dashes(info.dash)[1] - info.edgeWidth >= 2, `${record.id}: but never touch (${dashes(info.dash)[1]} apart, ${info.edgeWidth} wide)`);
  }
  const farPlain = look[bolDash.id];
  await select(bolDash.id);
  const farSelected = (await drawLook(page))[bolDash.id];
  assert.ok(farSelected.edgeWidth <= farSelected.lineWidth * 2.1 && farSelected.edgeWidth - farPlain.edgeWidth <= 2, `a selected stroke far away is still a restrained edge (${farPlain.edgeWidth} -> ${farSelected.edgeWidth} for ${farSelected.lineWidth})`);
  await clearSelection();

  // Dark theme: the neutral edge follows the theme, the selection edge stays the accent and the line its own color.
  const lightEdge = look[solid.id].edgeStroke;
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.waitForFunction(({ id, stroke }) => getComputedStyle(document.querySelector(`.tp3d-annot-draws .tp3d-annot-draw[data-annot-id="${id}"] .tp3d-annot-draw__under`)).stroke !== stroke, { id: solid.id, stroke: lightEdge });
  const darkPlain = await drawLook(page);
  await select(regDot.id);
  const dark = await drawLook(page);
  assert.equal(dark[regDot.id].lineStroke, darkPlain[regDot.id].lineStroke, 'the line keeps its own color when selected in the dark theme');
  assert.notEqual(dark[regDot.id].edgeStroke, dark[regDash.id].edgeStroke, 'and the selection edge still differs from a plain one');
  assert.ok(dark[regDot.id].edgeOpacity >= 0.9);
  await clearSelection();
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });

  // Arrows share the line patterns but not a drawing's look, and this change leaves them exactly as they were.
  const arrows = await lineLook(page);
  assert.deepEqual([arrows[arrowDot.id].line.width, arrows[arrowDot.id].halo.width, dashes(arrows[arrowDot.id].line.dash), arrows[arrowDot.id].halo.cap], [3, 7, [0.01, 10], 'round'], 'a Regular Dotted arrow keeps its ring and spacing');
  assert.deepEqual([arrows[arrowDash.id].line.width, arrows[arrowDash.id].halo.width, dashes(arrows[arrowDash.id].line.dash)], [5, 9, [20, 12.5]], 'a Bold Dashed arrow keeps its pattern and edge');
  assert.equal(await writes(page), 0, 'nothing here wrote a record');
  assert.deepEqual(errors, []);
});

test('an arrow and a drawing are renamed in their own row: Enter saves one name, Escape and a blank name are handled, the cargo and the geometry never change and typing never reaches the scene', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await seedDraw(page);
  await page.waitForSelector('.tp3d-annot-row[data-type="arrow"]');
  await page.waitForSelector('.tp3d-annot-row[data-type="draw"]');
  const rowName = type => page.evaluate(t2 => document.querySelector(`.tp3d-annot-row[data-type="${t2}"] .tp3d-annot-row__name`).textContent, type);
  const stored = type => page.evaluate(t2 => window.probe.annotations().find(record => record.type === t2), type);
  const casesBefore = await page.evaluate(() => window.probe.casesJson());
  const arrowBefore = await stored('arrow');
  const drawBefore = await stored('draw');
  assert.equal(await rowName('arrow'), 'Arrow 1');
  assert.equal(await rowName('draw'), 'Drawing 1');

  // Enter saves one name; focus returns to the row's Rename control; nothing else changes.
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__rename:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tp3d-annot-row__rename')), true, 'the name field takes focus');
  await page.keyboard.type('Left pallet');
  await page.keyboard.press('Delete');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.annotations().find(record => record.type === 'arrow').name === 'Left pallet');
  assert.equal(await rowName('arrow'), 'Left pallet');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tp3d-annot-row__edit')), true, 'Enter returns focus to the Rename control');
  const arrowAfter = await stored('arrow');
  assert.deepEqual({ ...arrowAfter, name: undefined, updatedAt: undefined }, { ...arrowBefore, name: undefined, updatedAt: undefined }, 'only the name and its edit time changed');
  assert.equal(await page.evaluate(() => window.probe.annotations().length), 2, 'Delete while typing removed nothing');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.casesJson())), JSON.stringify(casesBefore), 'cargo is untouched');

  // Escape cancels a rename without writing.
  await page.click('.tp3d-annot-row[data-type="draw"] .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-row[data-type="draw"] .tp3d-annot-row__rename:not([hidden])');
  await page.keyboard.type('Not saved');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.tp3d-annot-row[data-type="draw"] .tp3d-annot-row__rename').hidden);
  assert.equal(await rowName('draw'), 'Drawing 1', 'Escape keeps the generated name');
  assert.deepEqual(await stored('draw'), drawBefore, 'Escape writes nothing');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tp3d-annot-row__edit')), true);

  // A blank name removes the custom one, so the generated name comes back.
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__edit');
  await page.waitForSelector('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__rename:not([hidden])');
  await page.fill('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__rename', '   ');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.probe.annotations().find(record => record.type === 'arrow').name === undefined);
  assert.equal(await rowName('arrow'), 'Arrow 1', 'a blank name restores the generated name');

  await oneStepRoundTrip(page, 'the rename');
  assert.deepEqual(errors, []);
});

test('a record picked in the scene is revealed in a scrolled list once, the user scroll is otherwise kept, and a list pick ends a pending arrow tail and the armed tool, without writing', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const specs = Array.from({ length: 12 }, (_, i) => ({ title: `Note ${i + 1}`, cargo: 'cargo-a', local: { x: -18 + (i % 4) * 10, y: 16, z: -8 + Math.floor(i / 4) * 8 } }));
  const saved = await seed(page, specs);
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-row').length === 12);
  const list = '.tp3d-annot-panel__list';
  assert.equal(await page.evaluate(sel => { const el = document.querySelector(sel); return el.scrollHeight > el.clientHeight; }, list), true, 'the list scrolls');

  // A pick in the scene scrolls the last row into the list, from the top.
  await page.evaluate(sel => { document.querySelector(sel).scrollTop = 0; }, list);
  const last = saved[saved.length - 1].id;
  await page.waitForFunction(id => { const pin = document.querySelector(`.tp3d-annot-pin[data-annot-id="${id}"]`); return pin && !pin.hidden; }, last);
  await page.click(`.tp3d-annot-pin[data-annot-id="${last}"]`);
  await page.waitForSelector(`.tp3d-annot-row[data-annot-id="${last}"] .tp3d-annot-row__select[aria-pressed="true"]`);
  const shown = await page.evaluate(id => {
    const list2 = document.querySelector('.tp3d-annot-panel__list').getBoundingClientRect();
    const row = document.querySelector(`.tp3d-annot-row[data-annot-id="${id}"]`).getBoundingClientRect();
    return row.top >= list2.top - 1 && row.bottom <= list2.bottom + 1;
  }, last);
  assert.equal(shown, true, 'the selected row is revealed in the list');

  // The user's own scroll is kept: nothing scrolls the list back while nothing changes.
  await page.evaluate(sel => { document.querySelector(sel).scrollTop = 0; }, list);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(sel => document.querySelector(sel).scrollTop, list), 0, 'a manual scroll is not overridden');

  // A pending arrow tail is ended by a list pick; the Arrow tool stays armed and nothing is written.
  const before = (await page.evaluate(() => window.probe.annotations())).length;
  await page.click('.tp3d-annot-seg__btn[data-tool="arrow"]');
  await page.waitForFunction(() => /arrow tail/i.test(window.probe.hint()));
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.hint() !== '' && /arrow head|where the arrow/i.test(window.probe.hint()));
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  await page.waitForFunction(() => !/arrow tail/i.test(window.probe.hint()));
  assert.equal(await tailShown(page), false, 'the pending tail is ended');
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), false, 'picking an existing record ends the armed Arrow tool');
  assert.equal((await page.evaluate(() => window.probe.annotations())).length, before, 'nothing was written');
  assert.deepEqual(errors, []);
});

test('appearance contexts: new Arrow and Drawing defaults never change a saved record, a selected record changes only itself, and Callout display never changes a look', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const arrowSeed = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  const drawSeed = await seedDraw(page);
  await page.evaluate(([a, d]) => {
    const pack = window.probe.PackLibrary.getById('fixture-pack');
    window.probe.PackLibrary.updateArrow(pack.id, a, { name: 'Left pallet' });
    window.probe.PackLibrary.updateDraw(pack.id, d, { name: 'Floor mark' });
  }, [arrowSeed.id, drawSeed.id]);
  await page.waitForFunction(() => window.probe.annotations().some(r => r.name === 'Floor mark'));
  const record = type => page.evaluate(t2 => window.probe.annotations().find(r => r.type === t2), type);
  const pressed = sel => page.evaluate(s2 => document.querySelector(s2).getAttribute('aria-pressed'), sel);
  const title = sel => page.evaluate(s2 => document.querySelector(s2).textContent, sel);
  const arrowBefore = await record('arrow');
  const drawBefore = await record('draw');

  // New Arrow defaults: only the next arrow changes.
  await page.click('.tp3d-annot-seg__btn[data-tool="arrow"]');
  await page.waitForSelector('.tp3d-annot-panel__arrow:not([hidden])');
  assert.equal(await title('.tp3d-annot-panel__arrow-title'), 'New Arrow — Defaults');
  await page.click('.tp3d-annot-panel__arrow .tp3d-annot-seg__btn[data-width="bold"]');
  assert.equal(await pressed('.tp3d-annot-panel__arrow .tp3d-annot-seg__btn[data-width="bold"]'), 'true');
  assert.deepEqual(await record('arrow'), arrowBefore, 'a default never edits a saved arrow');
  await page.click('.tp3d-annot-seg__btn[data-tool="arrow"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.isActive() === false);

  // Selected Arrow: its own controls, and only that arrow changes.
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-panel__arrow:not([hidden])');
  assert.equal(await title('.tp3d-annot-panel__arrow-title'), 'Arrow: Left pallet — Selected');
  assert.equal(await pressed('.tp3d-annot-panel__arrow .tp3d-annot-seg__btn[data-width="regular"]'), 'true', 'the selected arrow shows its own weight');
  await page.click('.tp3d-annot-panel__arrow .tp3d-annot-seg__btn[data-width="thin"]');
  await page.waitForFunction(() => window.probe.annotations().find(r => r.type === 'arrow').width === 'thin');
  assert.equal((await record('draw')).width, drawBefore.width, 'the drawing is untouched');

  // New Drawing defaults: separate from arrows, and they never edit a saved drawing.
  await page.click('.tp3d-annot-row[data-type="draw"] .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-panel__draw:not([hidden])');
  assert.equal(await title('.tp3d-annot-panel__draw-title'), 'Drawing: Floor mark — Selected');
  await page.click('.tp3d-annot-seg__btn[data-tool="draw"]');
  await page.waitForSelector('.tp3d-annot-panel__draw:not([hidden])');
  assert.equal(await title('.tp3d-annot-panel__draw-title'), 'New Drawing — Defaults', 'arming Draw starts from the defaults, not the selected drawing');
  await page.click('.tp3d-annot-panel__draw .tp3d-annot-seg__btn[data-draw-line-style="dotted"]');
  assert.equal(await pressed('.tp3d-annot-panel__draw .tp3d-annot-seg__btn[data-draw-line-style="dotted"]'), 'true');
  assert.equal((await record('draw')).style, drawBefore.style, 'a drawing default never edits a saved drawing');
  await page.click('.tp3d-annot-seg__btn[data-tool="draw"]');
  await page.waitForFunction(() => window.probe.AnnotationTool.isActive() === false);
  assert.equal(await page.isVisible('.tp3d-annot-panel__drawmode'), false, 'Draw / Move View appears only while Draw is armed');

  // Selected Drawing: its own style, and the arrow keeps its own look.
  await page.click('.tp3d-annot-row[data-type="draw"] .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-panel__draw:not([hidden])');
  await page.click('.tp3d-annot-panel__draw .tp3d-annot-seg__btn[data-draw-line-style="dashed"]');
  await page.waitForFunction(() => window.probe.annotations().find(r => r.type === 'draw').style === 'dashed');
  assert.equal((await record('arrow')).width, 'thin', 'the arrow keeps the look it was given');

  // Callout display is a view setting: switching it never changes a saved look.
  const looksBefore = JSON.stringify([await record('arrow'), await record('draw')]);
  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Labels")');
  await page.click('.tp3d-annot-seg--display .tp3d-annot-seg__btn:has-text("Markers")');
  assert.equal(JSON.stringify([await record('arrow'), await record('draw')]), looksBefore, 'Callout display changes no arrow or drawing');
  assert.equal(await page.getAttribute('.tp3d-annot-seg--display', 'aria-label'), 'Callout display', 'the display group is named for what it controls');
  assert.deepEqual(errors, []);
});

test('a Dotted arrow has the same neutral edge as a Dotted drawing, and its hit regions and saved geometry are unchanged', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  const drawing = await seedDraw(page, { ground: [100, 70], rest: [140, 78, 180, 66] });
  await page.evaluate(([a, d]) => {
    const pack = window.probe.PackLibrary.getById('fixture-pack');
    window.probe.PackLibrary.updateArrow(pack.id, a, { style: 'dotted' });
    window.probe.PackLibrary.updateDraw(pack.id, d, { style: 'dotted' });
  }, [arrow.id, drawing.id]);
  await page.waitForFunction(() => window.probe.annotations().filter(r => r.style === 'dotted').length === 2);
  await frames(page, 3);
  const widths = await page.evaluate(() => {
    const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]);
    const arrowEl = document.querySelector('.tp3d-annot-arrow[data-line-style="dotted"]');
    const drawEl = document.querySelector('.tp3d-annot-draw[data-line-style="dotted"]') || document.querySelector('.tp3d-annot-draw__under')?.closest('[data-line-style]');
    const arrowHalo = px(arrowEl.querySelector('.tp3d-annot-arrow__under'), 'strokeWidth') - px(arrowEl.querySelector('.tp3d-annot-arrow__shaft'), 'strokeWidth');
    const drawHalo = drawEl ? px(drawEl.querySelector('.tp3d-annot-draw__under'), 'strokeWidth') - px(drawEl.querySelector('.tp3d-annot-draw__line'), 'strokeWidth') : null;
    return { arrowHalo, drawHalo, hit: getComputedStyle(arrowEl.querySelector('.tp3d-annot-arrow__shaft')).pointerEvents };
  });
  assert.ok(Math.abs(widths.arrowHalo - 1.5) < 0.01, `a Dotted arrow shaft edge is 1.5 px in total (${widths.arrowHalo})`);
  assert.notEqual(widths.drawHalo, null, 'the Dotted drawing is found');
  assert.ok(Math.abs(widths.arrowHalo - widths.drawHalo) < 0.01, 'the same edge as a Dotted drawing');
  assert.equal(widths.hit, 'none', 'the arrow is never a pointer target: its hit regions are unchanged');
  assert.deepEqual(errors, []);
});

test('a selected arrow with a long name at 640x700 keeps its look controls inside the panel: the name ends in an ellipsis and every weight, style and color control is reachable', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser, { width: 640, height: 700 });
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.evaluate(id => {
    const pack = window.probe.PackLibrary.getById('fixture-pack');
    window.probe.PackLibrary.updateArrow(pack.id, id, { name: 'A very long arrow name that must not push the controls out of the panel' });
  }, arrow.id);
  await page.waitForFunction(() => window.probe.annotations().some(r => r.name && r.name.startsWith('A very long')));
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-panel__arrow:not([hidden])');
  await frames(page, 3);
  const fit = await page.evaluate(() => {
    const panel = document.getElementById('editor-annotation-panel').getBoundingClientRect();
    const title = document.querySelector('.tp3d-annot-panel__arrow-title');
    const controls = [...document.querySelectorAll('.tp3d-annot-panel__arrow .tp3d-annot-seg__btn, .tp3d-annot-panel__arrow .tp3d-annot-swatch')];
    const inside = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= panel.left - 1 && r.right <= panel.right + 1; };
    return {
      truncated: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis',
      controls: controls.length,
      outside: controls.filter(el => !inside(el)).length,
    };
  });
  assert.equal(fit.truncated, true, 'the long name ends in an ellipsis');
  assert.equal(fit.controls, 12, 'three weights, three styles and six color swatches are shown');
  assert.equal(fit.outside, 0, 'no weight, style or color control overflows the panel');
  assert.deepEqual(errors, []);
});

test('annotation deletion is feedback only and Undo/Redo is the shared history: the toast has no Undo, the keyboard restores the exact record and Redo deletes it again, and cargo never changes', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  const [first, second] = await seed(page, [{ title: 'First', ...TOP_OF_A }, { title: 'Second', ground: [520, 10] }]);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  const drawing = await seedDraw(page);
  await page.waitForFunction(() => window.probe.annotations().length === 4);
  const cargoBefore = await page.evaluate(() => window.probe.casesJson());
  const before = await page.evaluate(() => window.probe.annotations());
  const deleteRow = id => page.click(`.tp3d-annot-row[data-annot-id="${id}"] .tp3d-annot-row__delete`);
  const lastToast = () => page.locator('.toast-message').last().textContent();
  const count = () => page.evaluate(() => window.probe.annotations().length);

  // Drawing: a plain notification, no Undo button and no inline row; the keyboard Undo restores exactly that record and place.
  await deleteRow(drawing.id);
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  assert.equal(await lastToast(), 'Drawing deleted.');
  assert.equal(await page.locator('.toast-btn', { hasText: 'Undo' }).count(), 0, 'the notification offers no Undo of its own');
  assert.equal(await page.evaluate(() => document.querySelector('.tp3d-annot-panel__undo') === null), true, 'no inline row either');
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 4);
  assert.deepEqual(await page.evaluate(() => window.probe.annotations()), before, 'Undo restores the same record, ID and place');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore, 'Undo never changes cargo');
  await redoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  assert.equal(await page.evaluate(id => window.probe.annotations().some(r => r.id === id), drawing.id), false, 'Redo deletes it again');

  // Mixed chronology: arrow deletion, callout deletion; Undo walks back newest first; Redo replays in order.
  await deleteRow(arrow.id);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.equal(await lastToast(), 'Arrow deleted.');
  await deleteRow(second.id);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await lastToast(), 'Callout deleted.');
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  assert.equal(await page.evaluate(id => window.probe.annotations().some(r => r.id === id), second.id), true, 'the Callout comes back first');
  await undoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 3);
  assert.equal(await page.evaluate(id => window.probe.annotations().some(r => r.id === id), arrow.id), true, 'then the Arrow');
  await redoByKeyboard(page);
  await redoByKeyboard(page);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore, 'cargo is still unchanged');
  assert.equal(await count(), 1);
  assert.deepEqual(errors, []);
});

test('a stale Arrow grip cannot edit before the next render: arming a creation tool hides the grips at once, and a pointer already aimed at the old grip writes nothing and starts nothing', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select');
  await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() !== null);
  const before = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  const cargoBefore = await page.evaluate(() => window.probe.casesJson());
  // All in one task: the tool is armed and the old grip is pointed at before any animation frame can run.
  const result = await page.evaluate(() => {
    const grip = document.querySelector('.tp3d-annot-handle[data-end="end"]');
    const rect = grip.getBoundingClientRect();
    document.querySelector('.tp3d-annot-seg__btn[data-tool="arrow"]').click();
    const hiddenNow = getComputedStyle(grip).display === 'none' || grip.hidden || !grip.isConnected;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 91, pointerType: 'mouse', isPrimary: true };
    grip.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x + 60, clientY: y + 30 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: x + 60, clientY: y + 30 }));
    return { hiddenNow };
  });
  assert.equal(result.hiddenNow, true, 'arming Arrow hides the grips at once, not on the next frame');
  await page.waitForFunction(() => window.probe.AnnotationTool.isActive() === true);
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), before, 'the stale grip wrote nothing');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), cargoBefore, 'cargo is untouched');
  assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), true, 'and nothing else was created');
  assert.deepEqual(errors, []);
});

test('an automatically placed callout card keeps its Edit and Collapse buttons clear of the camera and zoom controls, so an ordinary click reaches them', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seed(page, [{ title: 'Folded', ...TOP_OF_A, description: 'A card that could land under the camera controls' }]);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  await page.click('.tp3d-annot-row:first-child .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-card.is-selected');
  await frames(page, 3);
  for (const act of ['edit', 'collapse']) {
    const reached = await page.evaluate(sel => {
      const button = document.querySelector(`.tp3d-annot-card.is-selected [data-act="${sel}"]`);
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit) && (hit === button || button.contains(hit));
    }, act);
    assert.equal(reached, true, `the card's ${act} button is the element under its own centre`);
  }
  await page.click('.tp3d-annot-card.is-selected [data-act="collapse"]');
  await page.waitForSelector('.tp3d-annot-card.is-collapsed');
  assert.deepEqual(errors, []);
});

test('a custom arrow color is one undo step: input events only preview, one change is one step, an unchanged or cancelled choice is none, and Undo and Redo restore the color', { timeout: 180000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openPanel(browser);
  await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  await page.click('.tp3d-annot-row[data-type="arrow"] .tp3d-annot-row__select');
  await page.waitForSelector('.tp3d-annot-panel__arrow:not([hidden])');
  const color = () => page.evaluate(() => window.probe.annotations()[0].color);
  const original = await color();
  const picker = '.tp3d-annot-panel__arrow input[type="color"]';
  // Several native input events, then one change: the preview moves, the record moves once.
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    for (const value of ['#111111', '#222222', '#12ab34']) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, picker);
  await page.waitForFunction(() => window.probe.annotations()[0].color === '#12ab34');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true, 'the chosen color is one step');
  assert.equal(await color(), original, 'Undo restores the previous color');
  assert.equal(await page.evaluate(() => window.probe.annotations().length), 1, 'and the arrow itself is still there: the color was one step, not several');
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true);
  assert.equal(await color(), '#12ab34', 'Redo restores the chosen color');
  // A change that leaves the color as it is is no step at all.
  await page.evaluate(sel => { const el = document.querySelector(sel); el.value = '#12ab34'; el.dispatchEvent(new Event('change', { bubbles: true })); }, picker);
  await frames(page, 2);
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), false, 'an unchanged choice added no step (nothing was undone to redo)');
  // A cancelled choice (input, then the picker closes without a change) writes nothing and leaves no preview.
  await page.evaluate(sel => { const el = document.querySelector(sel); el.value = '#abcdef'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('blur')); }, picker);
  await frames(page, 2);
  assert.equal(await color(), '#12ab34', 'a cancelled choice never reaches the record');
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);
  assert.equal(await page.evaluate(() => window.probe.annotations().length), 1, 'the undo that follows is the color step, not the cancelled one');
  assert.deepEqual(errors, []);
});

// ---- Scene selection parity: a saved Arrow is selected by clicking its visible shaft -------------------------------
// Real pointer input only (no synthetic pointer IDs). The shaft stays a non-target in the DOM (`pointer-events: none`):
// the Editor hit-tests the projected line itself and only a plain click selects, so a drag still orbits or moves cargo.
const ARROW_MID = [180, 0, 75];
const shaftMid = page => point(page, ...ARROW_MID);
const arrowSelected = page => page.evaluate(() => window.probe.AnnotationTool.selectedId());
const undoDepth = page => page.evaluate(() => window.probe.StateStore.undoDepth());
// The two managers are independent toggles; this puts them in the wanted state and lets the camera and layout settle.
const setManagers = async (page, { annotations, measurements }) => {
  for (const [id, want] of [['btn-editor-annotations', annotations], ['btn-editor-measure', measurements]]) {
    const open = await page.evaluate(sel => document.getElementById(sel).getAttribute('aria-pressed') === 'true', id);
    if (open !== want) await page.click(`#${id}`);
    await page.waitForFunction(([sel, wanted]) => (document.getElementById(sel).getAttribute('aria-pressed') === 'true') === wanted, [id, want]);
  }
  await cameraSettled(page);
  await frames(page, 3);
};
const reachedCanvas = (page, at) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#viewport canvas'), at);
// A point `distance` screen pixels from the middle of the Arrow, straight across it.
const offShaft = async (page, distance) => {
  const a = await point(page, GROUND_A[0], 0, GROUND_A[2]);
  const b = await point(page, GROUND_B[0], 0, GROUND_B[2]);
  const mid = await shaftMid(page);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: mid.x + (-(b.y - a.y) / length) * distance, y: mid.y + ((b.x - a.x) / length) * distance };
};

test('a click on the saved Arrow shaft selects it with the managers closed, with either one open and with both open, while a drag from it still orbits: selection writes no history, keeps Redo, and shows both end grips', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  // Redo must survive every selection below: one real edit, undone, leaves one step to redo.
  await page.evaluate(id => window.probe.PackLibrary.updateArrow('fixture-pack', id, { style: 'dotted' }), arrow.id);
  assert.equal(await page.evaluate(() => window.probe.StateStore.undo()), true);
  const recordBefore = JSON.stringify(await page.evaluate(() => window.probe.annotations()));
  const casesBefore = await page.evaluate(() => window.probe.casesJson());
  const depthBefore = await undoDepth(page);

  // A drag that starts on the shaft of an unselected Arrow is the ordinary camera drag: nothing is selected or moved.
  const cameraBefore = await page.evaluate(() => window.probe.camera());
  await orbit(page, await shaftMid(page), 0, 60);
  assert.notEqual(await page.evaluate(() => window.probe.camera()), cameraBefore, 'the camera orbited');
  assert.equal(await arrowSelected(page), null, 'a drag from the shaft selects nothing');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), recordBefore, 'and moves nothing');

  for (const [label, managers] of [
    ['both managers closed', { annotations: false, measurements: false }],
    ['the Annotations panel open', { annotations: true, measurements: false }],
    ['the Measurements manager open', { annotations: false, measurements: true }],
    ['both managers open', { annotations: true, measurements: true }],
  ]) {
    await setManagers(page, managers);
    const at = await shaftMid(page);
    assert.equal(await reachedCanvas(page, at), true, `${label}: the shaft is over the canvas, not a panel`);
    assert.equal(await arrowSelected(page), null, `${label}: nothing is selected yet`);
    await click(page, at);
    await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
    await page.waitForFunction(() => document.querySelectorAll('.tp3d-annot-handle:not([hidden])').length === 2);
    assert.deepEqual((await gripsShown(page)).map(grip => grip.end), ['start', 'end'], `${label}: both end grips are shown`);
    assert.equal(await page.evaluate(() => window.probe.AnnotationTool.isActive()), false, `${label}: selecting arms nothing`);
    assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], `${label}: cargo is not selected`);
    assert.equal(await undoDepth(page), depthBefore, `${label}: selecting is not a history step`);
    assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), recordBefore, `${label}: the record is untouched`);
    assert.equal(await page.evaluate(() => window.probe.casesJson()), casesBefore, `${label}: cargo is untouched`);
    // Escape clears it; the next state starts from nothing again.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() === null);
  }
  assert.equal(await page.evaluate(() => window.probe.StateStore.redo()), true, 'Redo survived every selection');
  assert.equal((await page.evaluate(() => window.probe.annotations()))[0].style, 'dotted', 'and replays the undone edit');
  assert.deepEqual(errors, []);
});

test('an Arrow lying on cargo: a click on the shaft selects the Arrow and not the cargo, while a drag from the same spot still moves the cargo and selects nothing; a creation tool keeps the click for itself', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const arrow = await seedArrow(page, { cargo: 'cargo-a', local: { x: -12, y: 16, z: 0 } }, { cargo: 'cargo-a', local: { x: 12, y: 16, z: 0 } });
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  await cameraSettled(page);
  await frames(page, 3);
  // The middle of the drawn shaft, from the path the overlay itself draws (layer pixels, offset by the layer's own position).
  const drawnMid = () => page.evaluate(() => {
    const path = document.querySelector('.tp3d-annot-arrow:not(.is-preview) .tp3d-annot-arrow__shaft');
    const n = path.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    const layer = document.querySelector('.tp3d-annot-svg').getBoundingClientRect();
    return { x: layer.left + (n[0] + n[n.length - 2]) / 2, y: layer.top + (n[1] + n[n.length - 1]) / 2 };
  });
  const at = await drawnMid();
  assert.equal(await reachedCanvas(page, at), true, 'the shaft is over the canvas');
  const casesBefore = await page.evaluate(() => window.probe.casesJson());
  const depth = await undoDepth(page);

  await click(page, at);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'the cargo underneath is not selected');
  assert.equal(await page.evaluate(() => window.probe.casesJson()), casesBefore);
  assert.equal(await undoDepth(page), depth);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() === null);

  // The same press, moved: that is the cargo drag it always was.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 50, at.y + 30, { steps: 8 });
  await page.mouse.up();
  await cameraSettled(page);
  assert.notEqual(await page.evaluate(() => window.probe.casesJson()), casesBefore, 'the drag moved the cargo');
  assert.equal(await arrowSelected(page), null, 'and did not select the Arrow');
  assert.equal(await undoDepth(page), depth + 1, 'as one step');

  // With a creation tool armed, a click belongs to that tool and is never a selection.
  await setManagers(page, { annotations: true, measurements: false });
  await armArrow(page);
  await cameraSettled(page);
  const armedAt = await drawnMid();
  assert.equal(await reachedCanvas(page, armedAt), true);
  await click(page, armedAt);
  assert.equal(await arrowSelected(page), null, 'an armed tool never selects a saved Arrow');
  assert.equal(await tailShown(page), true, 'the click placed the new Arrow tail instead');
  assert.deepEqual(errors, []);
});

test('Arrow selection is exclusive and Delete-safe: it replaces a cargo selection, a Drawing selection replaces it, a cargo click clears it, and Delete removes only the selected Arrow', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  const drawing = await seedDraw(page, { ground: [300, 70], rest: [330, 74, 360, 80, 390, 72] });
  await page.waitForFunction(() => window.probe.annotations().length === 2);
  await cameraSettled(page);
  const cargoIds = await page.evaluate(() => window.probe.cargoIds());

  // Cargo selected, then the Arrow: one selection only, and it is the Arrow.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().join() === 'cargo-b');
  await click(page, await shaftMid(page));
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'selecting the Arrow clears the cargo selection');
  // A Drawing selected next replaces the Arrow.
  await click(page, await point(page, 315, 0, 72));
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, drawing.id);
  assert.equal((await gripsShown(page)).length, 0, 'the Arrow lost its grips');
  // And a click on the Arrow replaces the Drawing.
  await click(page, await shaftMid(page));
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
  // Cargo clicked: the Arrow is deselected.
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().join() === 'cargo-b');
  assert.equal(await arrowSelected(page), null, 'a cargo click deselects the Arrow');

  // Delete with the Arrow selected removes the Arrow and never a cargo.
  await click(page, await shaftMid(page));
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
  await page.focus('#viewport');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  assert.equal(await page.evaluate(id => window.probe.annotations().some(r => r.id === id), arrow.id), false, 'the Arrow was deleted');
  assert.deepEqual(await page.evaluate(() => window.probe.cargoIds()), cargoIds, 'no cargo was deleted');
  assert.deepEqual(errors, []);
});

test('a touch tap on the saved Arrow shaft selects it, with the wider touch reach', { timeout: 300000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const touch = { newPage: async options => (await browser.newContext({ ...options, hasTouch: true })).newPage() };
  const { page, errors } = await openEditor(touch);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.waitForFunction(() => window.probe.annotations().length === 1);
  await cameraSettled(page);
  const depth = await undoDepth(page);
  const record = JSON.stringify(await page.evaluate(() => window.probe.annotations()));

  const far = await offShaft(page, 30);
  await page.touchscreen.tap(far.x, far.y);
  await frames(page, 3);
  assert.equal(await arrowSelected(page), null, 'a tap 30 px away selects nothing');
  const near10 = await offShaft(page, 10);
  await page.touchscreen.tap(near10.x, near10.y);
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
  assert.deepEqual((await gripsShown(page)).map(grip => grip.end), ['start', 'end'], 'a tap 10 px away is inside the touch reach');
  assert.equal(await undoDepth(page), depth, 'a tap is not a history step');
  assert.equal(JSON.stringify(await page.evaluate(() => window.probe.annotations())), record);
  await click(page, await point(page, 400, 0, 130));
  await page.waitForFunction(() => window.probe.AnnotationTool.selectedId() === null);
  assert.deepEqual(errors, []);
});

test('a saved Measurement selected from the scene and the Arrow, cargo and Annotation selections replace each other, and Delete never reaches cargo through the Measurement', { timeout: 240000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const { page, errors } = await openEditor(browser);
  const arrow = await seedArrow(page, [GROUND_A[0], GROUND_A[2]], [GROUND_B[0], GROUND_B[2]]);
  await page.evaluate(() => {
    const { M, PackLibrary } = window.probe;
    const at = (x, z) => M.buildSpaceAnchor({ surface: 'ground', point: { x, y: 0, z } });
    if (!PackLibrary.addMeasurement('fixture-pack', { start: at(100, 110), end: at(260, 120) }).ok) throw new Error('measurement seed failed');
  });
  await page.waitForFunction(() => document.querySelectorAll('.tp3d-measure-svg__segment').length === 1);
  await cameraSettled(page);
  const measSelected = () => page.evaluate(() => window.probe.MeasurementTool.selectedId());
  const measAt = () => point(page, 180, 0, 115);
  const cargoIds = await page.evaluate(() => window.probe.cargoIds());

  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().join() === 'cargo-b');
  await click(page, await measAt());
  await page.waitForFunction(() => window.probe.MeasurementTool.selectedId() !== null);
  assert.deepEqual(await page.evaluate(() => window.probe.selection()), [], 'selecting the Measurement cleared the cargo selection');
  await page.focus('#viewport');
  await page.keyboard.press('Delete');
  await frames(page, 4);
  assert.deepEqual(await page.evaluate(() => window.probe.cargoIds()), cargoIds, 'Delete did not remove cargo');
  assert.equal(await page.evaluate(() => window.probe.PackLibrary.getMeasurements('fixture-pack').length), 1, 'nor the Measurement');

  await click(page, await shaftMid(page));
  await page.waitForFunction(id => window.probe.AnnotationTool.selectedId() === id, arrow.id);
  assert.equal(await measSelected(), null, 'selecting the Arrow dropped the Measurement selection');
  await click(page, await measAt());
  await page.waitForFunction(() => window.probe.MeasurementTool.selectedId() !== null);
  assert.equal(await arrowSelected(page), null, 'selecting the Measurement dropped the Arrow selection');
  await click(page, await page.evaluate(() => window.probe.cargoPoint('cargo-b')));
  await page.waitForFunction(() => window.probe.selection().join() === 'cargo-b');
  assert.equal(await measSelected(), null, 'selecting cargo dropped the Measurement selection');
  assert.deepEqual(errors, []);
});
