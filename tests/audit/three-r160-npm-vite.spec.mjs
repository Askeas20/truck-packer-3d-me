import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as installedThree from 'three';
import { OrbitControls as InstalledOrbitControls } from 'three/addons/controls/OrbitControls.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = relativePath => readFileSync(join(repoRoot, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const indexHtml = read('index.html');
const bootstrapSource = read('src/bootstrap/three-runtime.js');
const viteSource = read('vite.config.js');
const readme = read('README.md');
const appSource = read('src/app.js');
const browserSource = read('src/core/browser.js');
const sceneRuntimeSource = read('src/editor/scene-runtime.js');

function git(args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function runtimeBuildSources() {
  const distRoot = join(repoRoot, 'dist');
  if (!existsSync(distRoot)) return [];
  const paths = [];
  const visit = directory => {
    readdirSync(directory).forEach(name => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(?:html|js|mjs)$/u.test(name)) paths.push(readFileSync(path, 'utf8'));
    });
  };
  visit(distRoot);
  return paths;
}

function getThreeRuntimeGuardSource() {
  const match = appSource.match(
    /  async function ensureThreeRuntimeReady\(\) \{([\s\S]*?)\n  \}\n\n  if \(!\(await ensureThreeRuntimeReady\(\)\)\) return;/u
  );
  assert.ok(match, 'expected the Three.js startup guard before application initialization');
  return `async function ensureThreeRuntimeReady() {${match[1]}\n}`;
}

async function runThreeRuntimeGuard({ readiness = true, includeThree = true, includeOrbitControls = true } = {}) {
  const overlayCalls = [];
  const errorCalls = [];
  const bootState = {
    threeReady: Promise.resolve(readiness),
    showAppStatusOverlay(...args) {
      overlayCalls.push(args);
    },
  };
  const windowRef = { __TP3D_BOOT: bootState };
  if (includeThree) {
    windowRef.THREE = includeOrbitControls ? { OrbitControls() {} } : {};
  }
  const result = await runInNewContext(`(${getThreeRuntimeGuardSource()})()`, {
    console: {
      error(...args) {
        errorCalls.push(args);
      },
    },
    window: windowRef,
  });
  return { errorCalls, overlayCalls, result };
}

test('package.json pins Three.js exactly to 0.185.1', () => {
  assert.equal(packageJson.dependencies.three, '0.185.1');
});

test('package.json pins Vite exactly to 8.2.1', () => {
  assert.equal(packageJson.devDependencies.vite, '8.2.1');
  assert.match(packageJson.devDependencies.vite, /^\d+\.\d+\.\d+$/u);
  assert.equal(packageJson.engines.node, '^20.19.0 || >=22.12.0');
});

test('package-lock is present and eligible to be tracked', () => {
  assert.ok(existsSync(join(repoRoot, 'package-lock.json')));
  assert.notEqual(git(['check-ignore', '-q', 'package-lock.json']).status, 0);
  assert.equal(packageLock.packages[''].dependencies.three, '0.185.1');
  assert.equal(packageLock.packages[''].devDependencies.vite, '8.2.1');
});

test('Three.js core and OrbitControls originate from the same npm package', () => {
  assert.match(bootstrapSource, /import \* as THREE from 'three';/u);
  assert.match(bootstrapSource, /from 'three\/addons\/controls\/OrbitControls\.js';/u);
});

test('the temporary window.THREE compatibility object remains', () => {
  assert.match(bootstrapSource, /window\.THREE = \{ \.\.\.THREE, OrbitControls \};/u);
});

test('the bootstrap and installed package enforce Three.js revision 185', () => {
  assert.match(bootstrapSource, /THREE\.REVISION !== '185'/u);
  assert.equal(installedThree.REVISION, '185');
  assert.equal(typeof InstalledOrbitControls, 'function');
});

test('r185 compatibility uses the supported soft PCF shadow mode and environment defaults', () => {
  assert.match(sceneRuntimeSource, /renderer\.shadowMap\.type = THREE\.PCFShadowMap;/u);
  assert.doesNotMatch(sceneRuntimeSource, /PCFSoftShadowMap/u);
  assert.match(sceneRuntimeSource, /scene\.environment = envRT\.texture;/u);
  assert.equal(new installedThree.Scene().environmentIntensity, 1);
});

test('OrbitControls remains exposed through window.THREE', () => {
  assert.match(bootstrapSource, /\{ \.\.\.THREE, OrbitControls \}/u);
  assert.match(bootstrapSource, /vendorReady\('three'\)/u);
});

test('application boot keeps the existing Three.js readiness promise as its sole contract', () => {
  assert.match(indexHtml, /__TP3D_BOOT\.threeReady = import\('\.\/src\/bootstrap\/three-runtime\.js'\)/u);
  assert.match(appSource, /bootState\.threeReady \? await bootState\.threeReady : false/u);
  assert.equal((indexHtml.match(/__TP3D_BOOT\.threeReady\s*=/gu) || []).length, 1);
  assert.doesNotMatch(appSource, /threeReady\s*=/u);
});

test('successful Three.js readiness permits application initialization', async () => {
  const outcome = await runThreeRuntimeGuard();
  assert.equal(outcome.result, true);
  assert.deepEqual(outcome.overlayCalls, []);
  assert.deepEqual(outcome.errorCalls, []);
});

test('false Three.js readiness stops initialization and requests the fatal startup overlay', async () => {
  const outcome = await runThreeRuntimeGuard({ readiness: false });
  assert.equal(outcome.result, false);
  assert.equal(outcome.errorCalls.length, 1);
  assert.equal(outcome.overlayCalls.length, 1);
  assert.equal(outcome.overlayCalls[0][0], 'fatal');
  assert.equal(
    outcome.overlayCalls[0][1].message,
    'Cargo Planner could not load its 3D rendering runtime. Start the application through the supported npm/Vite development or production build and reload.'
  );
});

test('rejected Three.js readiness stops initialization without a secondary startup path', async () => {
  const outcome = await runThreeRuntimeGuard({ readiness: Promise.reject(new Error('bootstrap failed')) });
  assert.equal(outcome.result, false);
  assert.equal(outcome.errorCalls.length, 1);
  assert.equal(outcome.overlayCalls.length, 1);
});

test('missing window.THREE stops initialization', async () => {
  const outcome = await runThreeRuntimeGuard({ includeThree: false });
  assert.equal(outcome.result, false);
  assert.equal(outcome.errorCalls.length, 1);
  assert.equal(outcome.overlayCalls.length, 1);
});

test('missing OrbitControls stops initialization', async () => {
  const outcome = await runThreeRuntimeGuard({ includeOrbitControls: false });
  assert.equal(outcome.result, false);
  assert.equal(outcome.errorCalls.length, 1);
  assert.equal(outcome.overlayCalls.length, 1);
});

test('the Three.js readiness guard runs before application systems are constructed', () => {
  const guardIndex = appSource.indexOf('if (!(await ensureThreeRuntimeReady())) return;');
  const uiConstructionIndex = appSource.indexOf('const UIComponents = createUIComponents();');
  assert.ok(guardIndex >= 0);
  assert.ok(uiConstructionIndex > guardIndex);
});

test('active runtime markup contains no Three.js CDN URL', () => {
  assert.doesNotMatch(indexHtml, /esm\.sh|cdn\.skypack\.dev|https?:\/\/[^'"\s>]*three/iu);
});

test('active runtime sources and build contain no old Three.js vendor dependency', () => {
  const activeSources = [indexHtml, bootstrapSource, ...runtimeBuildSources()].join('\n');
  assert.doesNotMatch(
    activeSources,
    /vendor\/(?:three(?:\.module|\.min)?\.js|OrbitControls(?:\.module)?\.js)|OrbitControls\.module\.js/iu
  );
});

test('Vite development port remains 5500', () => {
  assert.match(viteSource, /server:\s*\{[\s\S]*?port:\s*5500/u);
});

test('Vite uses strict ports for development and preview', () => {
  assert.equal((viteSource.match(/strictPort:\s*true/gu) || []).length, 2);
  assert.match(viteSource, /preview:\s*\{[\s\S]*?port:\s*5500/u);
});

test('generated build output remains ignored', () => {
  assert.equal(git(['check-ignore', '-q', 'dist/phase-1a-probe']).status, 0);
});

test('node_modules remains ignored', () => {
  assert.equal(git(['check-ignore', '-q', 'node_modules/phase-1a-probe']).status, 0);
});

test('the supported Three.js runtime does not load WebGPU', () => {
  assert.doesNotMatch([indexHtml, bootstrapSource, viteSource].join('\n'), /WebGPU/iu);
});

test('the r185 runtime requires WebGL 2 without changing Vite output targets', () => {
  assert.match(readme, /Chrome 90\+/u);
  assert.match(readme, /Firefox 103\+/u);
  assert.match(readme, /Safari 15\+/u);
  assert.match(readme, /Edge 90\+/u);
  assert.match(readme, /WebGL 2/u);
  assert.match(browserSource, /canvas\.getContext\('webgl2'\)/u);
  assert.doesNotMatch(browserSource, /experimental-webgl/u);
  assert.match(viteSource, /target: \['chrome90', 'edge90', 'firefox103', 'safari13\.1'\]/u);
});

// ============================================================================
// CI lane integrity. The PR Quality Gate is deliberately FAST (a small Chromium smoke set); the complete Chromium
// suite is `npm run test:regression`. These checks keep both lanes honest: no spec can fall out of every lane, a
// renamed test cannot silently leave the smoke set, and the workflow stays one cheap job with its stable identity.
// ============================================================================
const auditSpecs = () => readdirSync(join(repoRoot, 'tests/audit')).filter(name => name.endsWith('.spec.mjs')).sort();
const specsIn = command => [...command.matchAll(/tests\/audit\/([\w.-]+\.spec\.mjs)/gu)].map(match => match[1]);
const topLevelTitles = name => [...read(`tests/audit/${name}`).matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)+)\1\s*,/gmu)].map(match => match[2]);

test('CI lanes: every audit spec runs in the Node lane or the full browser regression, and the smoke specs are part of that regression', () => {
  const regression = specsIn(packageJson.scripts['test:regression:browser']);
  const excludedFromNode = [...packageJson.scripts['test:ci:node'].matchAll(/! -name '([^']+\.spec\.mjs)'/gu)].map(match => match[1]);
  assert.deepEqual([...excludedFromNode].sort(), [...regression].sort(), 'the Node lane excludes exactly the Chromium specs, and the full regression runs exactly those');
  const present = auditSpecs();
  regression.forEach(name => assert.ok(present.includes(name), `${name} exists`));
  assert.equal(new Set(regression).size, regression.length, 'no spec is listed twice');
  // Everything that is not a Chromium spec is picked up by the Node lane's `find`, so no spec is orphaned.
  const nodeLane = present.filter(name => !excludedFromNode.includes(name));
  assert.ok(nodeLane.length > 30, `the Node lane runs ${nodeLane.length} specs`);
  specsIn(packageJson.scripts['test:ci:browser']).forEach(name => assert.ok(regression.includes(name), `smoke spec ${name} is in the full regression`));
  assert.equal(packageJson.scripts['test:regression'], 'npm run test:ci:node && npm run test:regression:browser');
  assert.equal(packageJson.scripts['test:ci'], 'npm run test:ci:node && npm run test:ci:browser', 'the CI command pair is the fast gate');
});

test('CI lanes: the browser smoke selection names real tests, each exactly once', () => {
  const [wholeFiles, patterned] = packageJson.scripts['test:ci:browser'].split(' && ');
  const patternText = patterned.match(/--test-name-pattern="([^"]+)"/u)[1];
  assert.match(patternText, /^\^\(\?:.+\)$/u, 'one anchored alternation');
  const alternatives = patternText.slice('^(?:'.length, -1).split('|');
  const titles = specsIn(patterned).flatMap(topLevelTitles);
  assert.ok(titles.length > 50, `${titles.length} top-level titles were found in the selected specs`);
  alternatives.forEach(alternative => {
    const hits = titles.filter(title => new RegExp(`^${alternative}`, 'u').test(title));
    assert.equal(hits.length, 1, `"${alternative}" must select exactly one test (selects ${hits.length}); a renamed test would silently leave the smoke set`);
  });
  assert.equal(new Set(alternatives).size, alternatives.length);
  assert.ok(alternatives.length >= 15 && alternatives.length <= 25, `${alternatives.length} selected tests: the smoke set stays small`);
  // The smoke specs run whole (no pattern) are the small ones, and none is also patterned.
  const whole = specsIn(wholeFiles);
  assert.ok(whole.length >= 1 && whole.every(name => !specsIn(patterned).includes(name)));
});

test('CI lanes: the browser smoke lane also runs the Folder Stage 1 real-app tests, and selects exactly those', () => {
  const clauses = packageJson.scripts['test:ci:browser'].split(' && ');
  assert.equal(clauses.length, 3, 'whole smoke specs, the patterned smoke set, then the Folder Stage 1 selection');
  assert.equal(
    clauses[2],
    'node --test --test-concurrency=1 --test-name-pattern="^Folder Stage 1" tests/behavioral/app-js-characterization.spec.mjs'
  );
  const titles = [...read('tests/behavioral/app-js-characterization.spec.mjs')
    .matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)+)\1\s*,/gmu)].map(match => match[2]);
  const selected = titles.filter(title => /^Folder Stage 1/u.test(title));
  assert.equal(selected.length, 10, `the pattern selects ${selected.length} tests; a renamed or added Stage 1 test must be reviewed here`);
});

test('CI lanes: the Quality Gate workflow keeps its identity and stays one fast job', () => {
  const workflow = read('.github/workflows/quality-gate.yml');
  const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.match(code, /^name: Quality Gate$/mu, 'workflow name');
  assert.match(code, /^  quality-gate:$/mu, 'job id: the check name branch protection matches');
  assert.deepEqual(code.match(/^ {2}[\w-]+:\s*$/gmu).filter(line => !/^ {2}(pull_request|push|workflow_dispatch):/u.test(line)).map(line => line.trim()), ['quality-gate:'], 'exactly one job');
  assert.match(code, /pull_request:\s*\n\s+branches:\s*\n\s+- main/u);
  assert.match(code, /workflow_dispatch:/u);
  assert.match(code, /run: npm run test:ci:browser/u, 'the PR gate runs the fast browser lane');
  assert.doesNotMatch(code, /test:regression/u, 'the full Chromium regression is not part of the PR gate');
  assert.doesNotMatch(code, /^\s*(strategy|schedule):|cron:/mu, 'no matrix, no scheduled run');
  const timeout = Number(code.match(/timeout-minutes: (\d+)/u)?.[1]);
  assert.ok(timeout >= 8 && timeout <= 15, `fail-safe timeout is ${timeout} minutes`);
  for (const step of ['npm run lint', 'npm run -s typecheck', 'npm run test:ci:node', 'npm run build', 'npm audit --omit=dev', 'git diff --check']) {
    assert.ok(code.includes(step), `the fast gate still runs: ${step}`);
  }
});
