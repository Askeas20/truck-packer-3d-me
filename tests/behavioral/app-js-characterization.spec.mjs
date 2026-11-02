import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAppBrowserHarness,
  readRuntimeSnapshot,
} from './app-js-browser-harness.mjs';

let harness;
let billingActionResultSequence = 0;
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_IDS = [ORG_A, ORG_B];

function sessionFor(userId) {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    expires_at: 4102444800,
    user: {
      id: userId,
      email: `${userId}@example.test`,
      user_metadata: { full_name: `User ${userId.toUpperCase()}` },
    },
  };
}

function organization(id, name, role = 'owner') {
  return {
    id,
    name,
    role,
    created_at: '2025-01-01T00:00:00.000Z',
    archived_at: null,
  };
}

function billingResponse(plan, overrides = {}) {
  return {
    plan,
    status: 'active',
    entitlementStatus: 'active',
    workspaceIncluded: true,
    workspaceCount: 1,
    workspaceLimit: 3,
    billingOwnerUserId: 'user-a',
    canManageBilling: true,
    ...overrides,
  };
}

async function installDeferredBillingAction(scenario, functionName) {
  const functionUrlSuffix = `/functions/v1/${functionName}`;
  let releaseResponse;
  let resolveRequest;
  let rejectRequest;
  const responseGate = new Promise(resolve => {
    releaseResponse = resolve;
  });
  const requestObserved = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const requestTimeout = setTimeout(() => {
    rejectRequest(new Error(`Timed out waiting for deferred billing action ${functionName}.`));
  }, 15000);

  await scenario.context.route(`https://**${functionUrlSuffix}`, async route => {
    const request = route.request();
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const headers = request.headers();
    clearTimeout(requestTimeout);
    resolveRequest({
      body,
      method: request.method(),
      url: request.url(),
      userJwt: headers['x-user-jwt'] || null,
    });
    const response = await responseGate;
    await route.fulfill({
      status: response.status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(response.body),
    });
  });

  return {
    waitForRequest() {
      return requestObserved;
    },
    release(body, status = 200) {
      releaseResponse({ body, status });
    },
  };
}

async function installBillingNavigationInterception(page, expectedUrl) {
  const attempts = [];
  const waiters = new Set();
  await page.route(expectedUrl, async route => {
    const request = route.request();
    await route.fulfill({ status: 204, body: '' });
    const attempt = {
      method: request.method(),
      url: request.url(),
    };
    attempts.push(attempt);
    for (const waiter of Array.from(waiters)) {
      waiters.delete(waiter);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(attempt);
    }
  });
  return {
    attemptCount() {
      return attempts.length;
    },
    async wait(timeoutMs = 15000) {
      if (attempts.length) return attempts[attempts.length - 1];
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          timeoutId: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for billing navigation to ${expectedUrl}.`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

async function beginBillingFacadeAction(page, action, input = null) {
  billingActionResultSequence += 1;
  const resultKey = `billing-action-${billingActionResultSequence}`;
  await page.evaluate(({ actionName, actionInput, key }) => {
    const api = window.__TP3D_BILLING;
    if (!api || typeof api[actionName] !== 'function') {
      throw new Error(`Billing facade action ${actionName} is unavailable.`);
    }
    window.__TP3D_TEST_BILLING_ACTION_RESULTS__ = window.__TP3D_TEST_BILLING_ACTION_RESULTS__ || {};
    window.__TP3D_TEST_BILLING_ACTION_RESULTS__[key] = actionName === 'startCheckout'
      ? api[actionName](actionInput)
      : api[actionName]();
  }, { actionName: action, actionInput: input, key: resultKey });
  return {
    result() {
      return page.evaluate(async key => {
        const pending = window.__TP3D_TEST_BILLING_ACTION_RESULTS__
          && window.__TP3D_TEST_BILLING_ACTION_RESULTS__[key];
        if (!pending) throw new Error(`Missing billing action result ${key}.`);
        const result = await pending;
        await new Promise(resolve => window.requestAnimationFrame(() => resolve()));
        return result;
      }, resultKey);
    },
  };
}

async function readBillingActionContext(page) {
  return page.evaluate(() => {
    const authState = window.SupabaseClient.getAuthState();
    const billingState = window.__TP3D_BILLING.getBillingState();
    return {
      activeOrgId: window.OrgContext.getActiveOrgId(),
      authEpoch: window.SupabaseClient.getAuthEpoch(),
      billingOrgId: billingState.orgId || null,
      canManageBilling: billingState.canManageBilling,
      status: authState && authState.status ? authState.status : null,
      userId: authState && authState.user && authState.user.id
        ? String(authState.user.id)
        : null,
    };
  });
}

function signedInScenario(userIds = ['user-a']) {
  const profiles = {};
  const organizations = {};
  for (const [index, userId] of userIds.entries()) {
    const orgId = ORG_IDS[index];
    profiles[userId] = {
      id: userId,
      email: `${userId}@example.test`,
      current_organization_id: orgId,
      deletion_status: null,
      deleted_at: null,
      purge_after: null,
    };
    organizations[userId] = [organization(orgId, `Workspace ${String.fromCharCode(65 + index)}`)];
  }
  return { initialSession: sessionFor(userIds[0]), profiles, organizations };
}

async function waitForSignedInOwner(page, userId, orgId) {
  await page.waitForFunction(({ expectedUserId, expectedOrgId }) => {
    const control = window.__TP3D_FAKE_SUPABASE_CONTROL__;
    const activeOrgId = window.OrgContext && typeof window.OrgContext.getActiveOrgId === 'function'
      ? window.OrgContext.getActiveOrgId()
      : null;
    const fake = control ? control.snapshot() : null;
    return document.body
      && document.body.dataset.auth === 'signed_in'
      && fake
      && fake.userId === expectedUserId
      && activeOrgId === expectedOrgId;
  }, { expectedUserId: userId, expectedOrgId: orgId }, { timeout: 30000 });
}

function multiWorkspaceScenario() {
  const scenario = signedInScenario();
  scenario.organizations['user-a'] = [
    organization(ORG_A, 'Workspace A'),
    organization(ORG_B, 'Workspace B'),
  ];
  return scenario;
}

async function armWorkspaceReady(page, orgId) {
  await page.evaluate(expectedOrgId => {
    let timeoutId;
    let readyHandler;
    const states = [];
    window.__TP3D_TEST_WORKSPACE_READY__ = new Promise((resolve, reject) => {
      readyHandler = event => {
        const state = window.TruckPackerApp.getWorkspaceSwitchState();
        states.push(state);
        if (window.OrgContext.getActiveOrgId() !== expectedOrgId
          || state.active
          || state.toOrgId !== expectedOrgId
          || !state.localStateReady
          || !state.orgReady
          || !state.billingReady) return;
        window.removeEventListener('tp3d:workspace-switch-state', readyHandler);
        window.clearTimeout(timeoutId);
        resolve({ eventDetail: event.detail || null, states });
      };
      window.addEventListener('tp3d:workspace-switch-state', readyHandler);
      timeoutId = window.setTimeout(() => {
        window.removeEventListener('tp3d:workspace-switch-state', readyHandler);
        reject(new Error(`Timed out waiting for workspace ${expectedOrgId} readiness: ${JSON.stringify({
          activeOrgId: window.OrgContext && window.OrgContext.getActiveOrgId(),
          dispatches: window.__TP3D_TEST_INSTRUMENTATION__.snapshot().dispatches
            .filter(entry => /workspace|org/i.test(entry.type)),
          state: window.TruckPackerApp && window.TruckPackerApp.getWorkspaceSwitchState(),
        })}`));
      }, 15000);
    });
  }, orgId);
}

async function readArmedWorkspaceReady(page) {
  return page.evaluate(async () => {
    const detail = await window.__TP3D_TEST_WORKSPACE_READY__;
    delete window.__TP3D_TEST_WORKSPACE_READY__;
    return {
      activeOrgId: window.OrgContext.getActiveOrgId(),
      detail,
      state: window.TruckPackerApp.getWorkspaceSwitchState(),
    };
  });
}

async function clickWorkspaceOption(page, workspaceName) {
  const modalOverlay = page.locator('#modal-root .modal-overlay:visible');
  if (await modalOverlay.isVisible()) {
    throw new Error(`Workspace switch blocked by modal: ${JSON.stringify(await modalOverlay.innerText())}`);
  }
  const option = page.locator('button').filter({ hasText: workspaceName }).last();
  if (!await option.isVisible()) {
    await page.locator('#btn-account-switcher').click({ timeout: 5000 });
    await option.waitFor({ state: 'visible', timeout: 5000 });
  }
  await option.click();
}

async function switchWorkspaceAndWait(page, orgId, workspaceName) {
  await armWorkspaceReady(page, orgId);
  await clickWorkspaceOption(page, workspaceName);
  const during = await page.evaluate(() => window.TruckPackerApp.getWorkspaceSwitchState());
  const observed = await readArmedWorkspaceReady(page);
  return { ...observed, after: observed.state, during };
}

async function sendWorkspaceSwitchSyncAndObserve(sender, receiver, payload) {
  const storageKey = 'tp3d:workspace-switch-state-sync';
  await receiver.evaluate(({ expectedKey, expectedReason }) => {
    let timeoutId;
    let storageHandler;
    window.__TP3D_TEST_WORKSPACE_SYNC_OBSERVED__ = new Promise((resolve, reject) => {
      storageHandler = event => {
        if (!event || event.key !== expectedKey || !event.newValue) return;
        let parsed = null;
        try {
          parsed = JSON.parse(event.newValue);
        } catch {
          return;
        }
        if (!parsed || String(parsed.reason || '') !== expectedReason) return;
        queueMicrotask(() => {
          window.removeEventListener('storage', storageHandler);
          window.clearTimeout(timeoutId);
          const billing = window.__TP3D_BILLING && window.__TP3D_BILLING.getBillingState
            ? window.__TP3D_BILLING.getBillingState()
            : null;
          resolve({
            activeOrgId: window.OrgContext.getActiveOrgId(),
            billingOrgId: billing && billing.orgId ? String(billing.orgId) : null,
            localOrgId: window.localStorage.getItem('tp3d:active-org-id'),
            route: window.location.hash,
            state: window.TruckPackerApp.getWorkspaceSwitchState(),
          });
        });
      };
      window.addEventListener('storage', storageHandler);
      timeoutId = window.setTimeout(() => {
        window.removeEventListener('storage', storageHandler);
        reject(new Error(`Timed out waiting for workspace sync ${expectedReason}.`));
      }, 10000);
    });
  }, { expectedKey: storageKey, expectedReason: String(payload.reason || '') });

  await sender.evaluate(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: payload });

  return receiver.evaluate(async () => {
    const observed = await window.__TP3D_TEST_WORKSPACE_SYNC_OBSERVED__;
    delete window.__TP3D_TEST_WORKSPACE_SYNC_OBSERVED__;
    return observed;
  });
}

async function openWorkspaceSyncSender(scenario) {
  const page = await scenario.context.newPage();
  await page.goto(`${harness.baseUrl}/__workspace-sync-sender__`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function armWindowEvent(page, eventType) {
  await page.evaluate(type => {
    if (!window.__TP3D_TEST_WINDOW_EVENTS__) window.__TP3D_TEST_WINDOW_EVENTS__ = {};
    window.__TP3D_TEST_WINDOW_EVENTS__[type] = new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener(type, handler);
        reject(new Error(`Timed out waiting for window ${type} event.`));
      }, 15000);
      const handler = event => {
        window.clearTimeout(timeoutId);
        resolve({ type: event.type, online: window.navigator.onLine });
      };
      window.addEventListener(type, handler, { once: true });
    });
  }, eventType);
}

async function readArmedWindowEvent(page, eventType) {
  return page.evaluate(async type => {
    const result = await window.__TP3D_TEST_WINDOW_EVENTS__[type];
    delete window.__TP3D_TEST_WINDOW_EVENTS__[type];
    return result;
  }, eventType);
}

async function armBillingPlan(page, plan) {
  await page.evaluate(expectedPlan => {
    window.__TP3D_TEST_BILLING_STATE__ = new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timeoutId = window.setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for billing plan ${expectedPlan}.`));
      }, 15000);
      unsubscribe = window.__TP3D_BILLING.subscribeBilling(state => {
        if (!state || state.plan !== expectedPlan) return;
        window.clearTimeout(timeoutId);
        unsubscribe();
        resolve(state);
      });
    });
  }, plan);
}

async function readArmedBillingPlan(page) {
  return page.evaluate(async () => {
    const state = await window.__TP3D_TEST_BILLING_STATE__;
    delete window.__TP3D_TEST_BILLING_STATE__;
    return state;
  });
}

async function reproduceStaleAuthUserResult(page, operation) {
  const nextSession = sessionFor('user-b');
  nextSession.user.banned_until = null;
  return page.evaluate(async ({ operationName, session }) => {
    const api = window.SupabaseClient;
    const control = window.__TP3D_FAKE_SUPABASE_CONTROL__;
    if (!api || !control) throw new Error('Auth reproduction controls are unavailable.');

    const readAuth = () => {
      const state = api.getAuthState();
      return {
        epoch: api.getAuthEpoch(),
        status: state && state.status ? state.status : null,
        userId: state && state.user && state.user.id ? String(state.user.id) : null,
        sessionUserId: state && state.session && state.session.user && state.session.user.id
          ? String(state.session.user.id)
          : null,
        token: state && state.session && state.session.access_token
          ? String(state.session.access_token)
          : null,
      };
    };

    let stopAuthWait = () => {};
    let switchPromise = Promise.resolve();
    const originalDateNow = Date.now;
    try {
      control.setGetUserMode('deferred');
      Date.now = () => originalDateNow() + 60000;

      const requestCount = control.snapshot().getUserRequests.length;
      const nextUserReady = new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          stopAuthWait();
          reject(new Error(`Timed out waiting for authoritative auth user ${session.user.id}.`));
        }, 10000);
        stopAuthWait = api.onAuthStateChange((event, authSession) => {
          const eventUserId = authSession && authSession.user && authSession.user.id
            ? String(authSession.user.id)
            : null;
          if (eventUserId !== String(session.user.id)) return;
          queueMicrotask(() => {
            const current = readAuth();
            if (current.userId !== String(session.user.id)
              || current.sessionUserId !== String(session.user.id)) return;
            window.clearTimeout(timeoutId);
            stopAuthWait();
            resolve({ event, current });
          });
        });
      });

      const stalePromise = operationName === 'getUserSingleFlight'
        ? api.getUserSingleFlight()
        : null;
      if (operationName === 'validateSessionRevocation') {
        window.dispatchEvent(new Event('focus'));
      }
      const request = await control.waitForGetUserRequest(requestCount);
      switchPromise = control.emitAuth('SIGNED_IN', session);
      await nextUserReady;
      const afterSwitch = readAuth();

      if (!control.resolveGetUser(request.index)) {
        throw new Error(`Unable to resolve deferred getUser request ${request.index}.`);
      }
      const staleResult = stalePromise
        ? await stalePromise
        : await new Promise(resolve => window.requestAnimationFrame(() => resolve(null)));
      const afterStaleResult = readAuth();
      await switchPromise;

      return {
        afterSwitch,
        afterStaleResult,
        final: readAuth(),
        request,
        staleResultUserId: staleResult && staleResult.id
          ? String(staleResult.id)
          : staleResult && staleResult.userId
            ? String(staleResult.userId)
            : null,
      };
    } finally {
      Date.now = originalDateNow;
      stopAuthWait();
      await switchPromise.catch(() => {});
    }
  }, { operationName: operation, session: nextSession });
}

async function settleDeferredAuthRequest(page, { operation, events = [], resolution = {} }) {
  return page.evaluate(async ({ operationName, authEvents, requestResolution }) => {
    const api = window.SupabaseClient;
    const control = window.__TP3D_FAKE_SUPABASE_CONTROL__;
    if (!api || !control) throw new Error('Auth regression controls are unavailable.');

    const readAuth = () => {
      const state = api.getAuthState();
      return {
        epoch: api.getAuthEpoch(),
        status: state && state.status ? state.status : null,
        userId: state && state.user && state.user.id ? String(state.user.id) : null,
        userMarker: state && state.user && state.user.user_metadata
          ? state.user.user_metadata.auth_marker || null
          : null,
        sessionUserId: state && state.session && state.session.user && state.session.user.id
          ? String(state.session.user.id)
          : null,
        token: state && state.session && state.session.access_token
          ? String(state.session.access_token)
          : null,
      };
    };
    const summarizeResult = value => {
      const user = value && value.id
        ? value
        : value && value.data && value.data.user
          ? value.data.user
          : null;
      return {
        userId: user && user.id ? String(user.id) : null,
        userMarker: user && user.user_metadata ? user.user_metadata.auth_marker || null : null,
        reason: value && value.reason ? String(value.reason) : null,
        signedOut: Boolean(value && value.signedOut),
      };
    };

    const originalDateNow = Date.now;
    try {
      control.setGetUserMode('deferred');
      Date.now = () => originalDateNow() + 60000;
      const requestCount = control.snapshot().getUserRequests.length;
      let signedOutEvent = null;
      if (operationName === 'validateSessionRevocation' && requestResolution.expectSignedOut) {
        signedOutEvent = new Promise(resolve => {
          window.addEventListener('tp3d:auth-signed-out', resolve, { once: true });
        });
      }
      const pending = operationName === 'validateSessionRevocation'
        ? null
        : api.getUserSingleFlight();
      if (operationName === 'validateSessionRevocation') window.dispatchEvent(new Event('focus'));
      const request = await control.waitForGetUserRequest(requestCount);

      for (const entry of authEvents) {
        await control.emitAuth(entry.event, entry.session);
      }
      const beforeSettlement = readAuth();

      const settled = requestResolution.error
        ? control.resolveGetUserError(
          request.index,
          requestResolution.error.message,
          requestResolution.error.status
        )
        : control.resolveGetUser(request.index, requestResolution.user);
      if (!settled) throw new Error(`Unable to settle deferred getUser request ${request.index}.`);

      let result = null;
      if (pending) {
        result = await pending;
      } else if (signedOutEvent) {
        await signedOutEvent;
      } else {
        await new Promise(resolve => window.requestAnimationFrame(() => resolve()));
      }
      return {
        beforeSettlement,
        afterSettlement: readAuth(),
        result: summarizeResult(result),
        request,
      };
    } finally {
      Date.now = originalDateNow;
    }
  }, { operationName: operation, authEvents: events, requestResolution: resolution });
}

test.before(async () => {
  harness = await createAppBrowserHarness();
});

test.after(async () => {
  if (harness) await harness.close();
});

test('App.js signed-out boot reaches the real ready state through index.html', async t => {
  const scenario = await harness.createScenario({ initialSession: null });
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await page.waitForFunction(() => document.body && document.body.dataset.auth === 'signed_out');

  const snapshot = await readRuntimeSnapshot(page);
  assert.equal(snapshot.boot.appReady, true);
  assert.equal(snapshot.boot.fatalOverlayShown, false);
  assert.equal(snapshot.authBodyState, 'signed_out');
  assert.ok(snapshot.facadeKeys.includes('init'), 'the final real TruckPackerApp facade is published');
  assert.ok(snapshot.facadeKeys.includes('getWorkspaceSwitchState'));
  t.diagnostic(`Observed window.TruckPackerApp facade: ${snapshot.facadeKeys.join(', ')}`);
  t.diagnostic(`Observed window.TruckPackerApp._debug facade: ${snapshot.facadeDebugKeys.join(', ')}`);
  t.diagnostic(`Observed billing globals: ${snapshot.billingGlobalKeys.join(', ') || '(none)'}`);
  t.diagnostic(`Observed __TP3D_BILLING surface: ${snapshot.billingDebugKeys.join(', ') || '(none)'}`);
  assert.equal(snapshot.fakeSupabase.userId, null);
  assert.ok(snapshot.fakeSupabase.authSubscriberCount >= 2,
    'the production Supabase wrapper and App.js auth listener both subscribe');
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('repeated init preserves first-init listener, timer, channel, network, and auth ownership', async t => {
  const scenario = await harness.createScenario({ initialSession: null });
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await page.waitForFunction(() => document.body && document.body.dataset.auth === 'signed_out');

  const firstInit = await readRuntimeSnapshot(page);
  const initResults = await page.evaluate(async () => {
    const first = await window.TruckPackerApp.init();
    const second = await window.TruckPackerApp.init();
    return [first, second].map(value => value == null ? null : typeof value);
  });
  const repeatedInit = await readRuntimeSnapshot(page);

  assert.deepEqual(initResults, [null, null]);
  assert.deepEqual(repeatedInit.instrumentation, firstInit.instrumentation,
    'repeated init must not acquire additional browser-owned resources');
  assert.equal(
    repeatedInit.fakeSupabase.authSubscriberCount,
    firstInit.fakeSupabase.authSubscriberCount,
    'repeated init must not add Supabase auth subscriptions'
  );
  assert.deepEqual(
    repeatedInit.fakeSupabase.queries,
    firstInit.fakeSupabase.queries,
    'repeated init must not repeat transport work'
  );
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('TRIAGE-3D-B unexpected initializer failure settles initCompleted without markAppReady, then a restored retry stays suppressed', async t => {
  const scenario = await harness.createScenario({ initialSession: null, injectEditorInitFailure: true });
  t.after(() => scenario.close());

  const page = await scenario.openPage();

  // The property-setter trap (installEditorInitFailureTrap) fires the instant
  // app.js assigns window.TruckPackerApp (src/app.js:2304/10202), before boot()
  // ever calls init() (src/app.js:10225-10243). By the time the facade is
  // observable here, the throwing EditorUI.init replacement is already installed.
  await page.waitForFunction(() => (
    window.TruckPackerApp
    && window.TruckPackerApp.EditorUI
    && typeof window.__TRIAGE_ORIGINAL_EDITOR_INIT__ === 'function'
  ));

  const preFailure = await readRuntimeSnapshot(page);

  // The unguarded AppShell/PacksUI/CasesUI/EditorUI/... init block (src/app.js:
  // 9049-9058) is not wrapped in try/catch, so the injected throw propagates out
  // of init()'s async IIFE and rejects the promise boot() awaits.
  await page.waitForFunction(() => window.__TP3D_BOOT && window.__TP3D_BOOT.fatalOverlayShown === true, null, { timeout: 15000 });

  const afterFailure = await readRuntimeSnapshot(page);
  const editorInitCallsAfterFailure = await page.evaluate(() => window.__TRIAGE_EDITOR_INIT_CALLS__());

  // --- Scenario A: unexpected initialization failure ---
  assert.equal(editorInitCallsAfterFailure, 1, 'the injected initializer ran exactly once');
  assert.equal(afterFailure.boot.appReady, false, 'BootState.appReady stays falsy on an unexpected init failure (markAppReady is never reached past the throw)');
  assert.equal(afterFailure.boot.fatalOverlayShown, true, 'boot()\'s .catch() (src/app.js:10233-10236) shows the fatal overlay for an unexpected init failure');
  assert.ok(afterFailure.facadeKeys.includes('init'), 'the TruckPackerApp facade remains present after a failed init');
  assert.ok(afterFailure.facadeKeys.includes('EditorUI'), 'the TruckPackerApp facade remains present after a failed init');
  assert.deepEqual(afterFailure.facadeKeys, preFailure.facadeKeys, 'the facade key set is unchanged by the failure');

  // --- Scenario C: ownership left behind ---
  // SupabaseClient.onAuthStateChange (src/app.js:8719-8721) runs well before the
  // unguarded init block and is not undone by the later, unrelated throw.
  assert.ok(
    afterFailure.fakeSupabase.authSubscriberCount >= 1,
    'the auth listener installed earlier in init() remains registered after the later unrelated failure'
  );
  assert.deepEqual(
    afterFailure.instrumentation.channels,
    preFailure.instrumentation.channels,
    'the failure itself does not acquire additional BroadcastChannel ownership'
  );
  t.diagnostic(`window listener types installed by the time of failure: ${afterFailure.instrumentation.listeners.filter(entry => entry.target === 'window').map(entry => entry.type).join(', ')}`);

  // --- Scenario B: second init() call after restoring the (now-fixed) initializer ---
  await page.evaluate(() => {
    window.TruckPackerApp.EditorUI.init = window.__TRIAGE_ORIGINAL_EDITOR_INIT__;
  });

  const secondCallResult = await page.evaluate(async () => {
    const result = await window.TruckPackerApp.init();
    return result === undefined ? 'undefined' : typeof result;
  });
  const editorInitCallsAfterRetry = await page.evaluate(() => window.__TRIAGE_EDITOR_INIT_CALLS__());
  const afterRetry = await readRuntimeSnapshot(page);

  assert.equal(secondCallResult, 'undefined', 'a second init() call after failure returns undefined — the same no-op shape as a post-success repeated call (src/app.js:8278)');
  assert.equal(editorInitCallsAfterRetry, 1, 'the restored, working EditorUI.init is never invoked by the second call: initCompleted (set true in the finally block regardless of success or failure) silently suppresses the retry');
  assert.equal(afterRetry.boot.appReady, false, 'appReady is still never set: the suppressed retry cannot self-heal readiness');
  assert.equal(afterRetry.boot.fatalOverlayShown, true, 'the fatal overlay from the first failure is still showing; the suppressed retry cannot clear or transition it');
  assert.equal(
    afterRetry.fakeSupabase.authSubscriberCount,
    afterFailure.fakeSupabase.authSubscriberCount,
    'the suppressed retry does not add a duplicate Supabase auth subscription'
  );
  assert.deepEqual(
    afterRetry.instrumentation,
    afterFailure.instrumentation,
    'the suppressed retry acquires no additional browser-owned resources (listeners/timers/channels/fetches)'
  );

  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('TRIAGE-3D-B expected degraded Supabase config path reaches appReady and stays a no-op on retry', async t => {
  const scenario = await harness.createScenario({
    initialSession: null,
    supabaseConfigOverride: {
      url: 'https://example.invalid.supabase.co',
      // Stripe-publishable-shaped key instead of a JWT anon key is an existing,
      // intentionally-recoverable degraded config path — see src/app.js:8311-8332.
      anonKey: 'sb_publishable_test_not_a_jwt_value',
    },
  });
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await page.waitForFunction(
    () => window.__TP3D_BOOT && (window.__TP3D_BOOT.appReady || window.__TP3D_BOOT.fatalOverlayShown),
    null,
    { timeout: 15000 }
  );

  const afterDegraded = await readRuntimeSnapshot(page);
  assert.equal(afterDegraded.boot.appReady, true, 'the expected degraded Supabase-config path still reaches appReady (src/app.js:8325-8330)');
  assert.equal(afterDegraded.boot.fatalOverlayShown, false, 'the expected degraded path is distinguishable from an unexpected failure: no fatal overlay');

  const secondCallResult = await page.evaluate(async () => {
    const result = await window.TruckPackerApp.init();
    return result === undefined ? 'undefined' : typeof result;
  });
  assert.equal(secondCallResult, 'undefined', 'a second init() call after the degraded path remains a no-op, same as a successful boot');

  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('signed-in boot and TOKEN_REFRESHED preserve the active user workspace', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const beforeRefresh = await readRuntimeSnapshot(page);
  await page.evaluate(async session => {
    await window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('TOKEN_REFRESHED', session);
  }, sessionFor('user-a'));
  await page.waitForFunction(() => {
    const events = window.__TP3D_FAKE_SUPABASE_CONTROL__.snapshot().authEvents;
    return events.some(entry => entry.event === 'TOKEN_REFRESHED' && entry.userId === 'user-a');
  });
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const afterRefresh = await readRuntimeSnapshot(page);
  assert.equal(afterRefresh.fakeSupabase.authSubscriberCount,
    beforeRefresh.fakeSupabase.authSubscriberCount);
  assert.equal(afterRefresh.authBodyState, 'signed_in');
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('C3 legacy zero mass survives signed-in startup, reload and workspace switching', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  // This static fixture serves the same npm Three.js modules Vite resolves in
  // the local application, without changing the production entry point.
  await scenario.context.route('**/index.html', async route => {
    const response = await route.fetch();
    const imports = { three: '/node_modules/three/build/three.module.js',
      'three/addons/': '/node_modules/three/examples/jsm/' };
    const body = (await response.text()).replace('<head>',
      `<head><script type="importmap">${JSON.stringify({ imports })}</script>`);
    await route.fulfill({ response, body });
  });
  const instance = {
    id: 'legacy-instance', caseId: 'legacy-case-a', hidden: true, placement: 'packed',
    orientationLocked: true, lockedRotation: { x: 0, y: Math.PI / 2, z: 0 },
    transform: { position: { x: 5, y: 7, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  };
  const payload = (suffix, weight) => ({
    version: 'legacy', savedAt: 123,
    caseLibrary: [{ id: `legacy-case-${suffix}`, name: `Saved Case ${suffix}`, weight,
      dimensions: { length: 10, width: 12, height: 14 }, orientationLock: 'upright', notes: 'Keep saved metadata' }],
    packLibrary: [{ id: `legacy-pack-${suffix}`, title: `Saved Load ${suffix}`, loadPlanNumber: `LP-0000000${suffix.toUpperCase()}`,
      truck: { length: 100, width: 80, height: 80, shapeMode: 'rect' },
      cases: [{ ...instance, caseId: `legacy-case-${suffix}` }], groups: [], createdAt: 12, lastEdited: 34 }],
    folderLibrary: [], currentPackId: null,
  });
  const entries = [
    [`truckPacker3d:v1:user-a:workspace:${ORG_A}`, payload('a', 0)],
    [`truckPacker3d:v1:user-a:workspace:${ORG_B}`, payload('b', '0')],
  ];
  await scenario.context.addInitScript(values => {
    for (const [key, data] of values) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
    }
  }, entries);
  const page = await scenario.openPage();
  const assertSavedWorkspace = async suffix => {
    await page.waitForFunction(async expectedId => {
      const StateStore = await import('/src/core/state-store.js');
      return StateStore.get('caseLibrary')?.some(c => c.id === expectedId);
    }, `legacy-case-${suffix}`, { timeout: 5000 });
    const loaded = await page.evaluate(async () => {
      const StateStore = await import('/src/core/state-store.js');
      return { cases: StateStore.get('caseLibrary'), packs: StateStore.get('packLibrary') };
    });
    assert.equal(loaded.cases.length, 1, 'the saved Case survives instead of being dropped or reseeded');
    assert.equal(loaded.cases[0].weight, null);
    assert.equal(loaded.cases[0].notes, 'Keep saved metadata');
    assert.equal(loaded.packs.length, 1);
    assert.equal(loaded.packs[0].id, `legacy-pack-${suffix}`);
    const restored = loaded.packs[0].cases[0];
    for (const key of ['hidden', 'placement', 'orientationLocked', 'lockedRotation', 'transform']) {
      assert.deepEqual(restored[key], instance[key], `${key} survives loading unchanged`);
    }
  };
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);
  await assertSavedWorkspace('a');
  await page.reload();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);
  await assertSavedWorkspace('a');
  await switchWorkspaceAndWait(page, ORG_B, 'Workspace B');
  await assertSavedWorkspace('b');
  await switchWorkspaceAndWait(page, ORG_A, 'Workspace A');
  await assertSavedWorkspace('a');
  assert.deepEqual(scenario.diagnostics.pageErrors, [], 'startup and switching never reject with invalid Case mass');
});

test('stale getUserSingleFlight result cannot replace newer authoritative auth user', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await reproduceStaleAuthUserResult(page, 'getUserSingleFlight');
  assert.equal(observed.afterSwitch.userId, 'user-b');
  assert.equal(observed.afterSwitch.sessionUserId, 'user-b');
  assert.equal(observed.afterStaleResult.sessionUserId, 'user-b');
  assert.equal(observed.afterStaleResult.userId, 'user-b', JSON.stringify(observed));
});

test('stale revocation validation result cannot replace newer authoritative auth user', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await reproduceStaleAuthUserResult(page, 'validateSessionRevocation');
  assert.equal(observed.afterSwitch.userId, 'user-b');
  assert.equal(observed.afterSwitch.sessionUserId, 'user-b');
  assert.equal(observed.afterStaleResult.sessionUserId, 'user-b');
  assert.equal(observed.afterStaleResult.userId, 'user-b', JSON.stringify(observed));
});

test('stale getUser result cannot restore user A after authoritative sign-out', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await settleDeferredAuthRequest(page, {
    operation: 'getUserSingleFlight',
    events: [{ event: 'SIGNED_OUT', session: null }],
    resolution: { user: sessionFor('user-a').user },
  });
  assert.equal(observed.beforeSettlement.status, 'signed_out');
  assert.equal(observed.afterSettlement.status, 'signed_out');
  assert.equal(observed.afterSettlement.userId, null, JSON.stringify(observed));
  assert.equal(observed.afterSettlement.sessionUserId, null);
  assert.equal(observed.result.userId, null);
});

test('stale revoked response cannot sign out newer authoritative user B', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await settleDeferredAuthRequest(page, {
    operation: 'validateSessionRevocation',
    events: [{ event: 'SIGNED_IN', session: sessionFor('user-b') }],
    resolution: { error: { message: 'Invalid token', status: 401 } },
  });
  assert.equal(observed.beforeSettlement.userId, 'user-b');
  assert.equal(observed.afterSettlement.status, 'signed_in');
  assert.equal(observed.afterSettlement.userId, 'user-b', JSON.stringify(observed));
  assert.equal(observed.afterSettlement.sessionUserId, 'user-b');
});

test('A to B to A with a changed token rejects the original A result', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const currentA = sessionFor('user-a');
  currentA.access_token = 'access-user-a-new';
  currentA.user.user_metadata.auth_marker = 'current-a-new-token';
  const staleA = sessionFor('user-a').user;
  staleA.user_metadata.auth_marker = 'stale-a-old-token';
  const observed = await settleDeferredAuthRequest(page, {
    operation: 'getUserSingleFlight',
    events: [
      { event: 'SIGNED_IN', session: sessionFor('user-b') },
      { event: 'SIGNED_IN', session: currentA },
    ],
    resolution: { user: staleA },
  });
  assert.equal(observed.beforeSettlement.token, 'access-user-a-new');
  assert.equal(observed.afterSettlement.userId, 'user-a');
  assert.equal(observed.afterSettlement.userMarker, 'current-a-new-token', JSON.stringify(observed));
  assert.ok(observed.result.userId, JSON.stringify(observed));
  assert.notEqual(observed.result.userMarker, 'stale-a-old-token');
});

test('TOKEN_REFRESHED invalidates an older getUser result for the same user', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const refreshedA = sessionFor('user-a');
  refreshedA.access_token = 'access-user-a-refreshed';
  refreshedA.user.user_metadata.auth_marker = 'current-refreshed';
  const staleA = sessionFor('user-a').user;
  staleA.user_metadata.auth_marker = 'stale-pre-refresh';
  const observed = await settleDeferredAuthRequest(page, {
    operation: 'getUserSingleFlight',
    events: [{ event: 'TOKEN_REFRESHED', session: refreshedA }],
    resolution: { user: staleA },
  });
  assert.equal(observed.beforeSettlement.token, 'access-user-a-refreshed');
  assert.equal(observed.afterSettlement.token, 'access-user-a-refreshed');
  assert.equal(observed.afterSettlement.userMarker, 'current-refreshed', JSON.stringify(observed));
  assert.equal(observed.result.userMarker, 'current-refreshed');
});

test('raw getUser cooldown data is not served across an auth epoch transition', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await page.evaluate(async () => {
    const api = window.SupabaseClient;
    const control = window.__TP3D_FAKE_SUPABASE_CONTROL__;
    const client = api.getClient();
    const originalDateNow = Date.now;
    const cacheTime = originalDateNow() + 60000;
    try {
      control.setGetUserMode('deferred');
      Date.now = () => cacheTime;
      const firstCount = control.snapshot().getUserRequests.length;
      const firstRaw = client.auth.getUser();
      const firstRequest = await control.waitForGetUserRequest(firstCount);
      control.resolveGetUser(firstRequest.index, sessionForUser('user-a', 'stale-cache'));
      const firstResult = await firstRaw;

      api.resetAccountBundleCache('def-009-cache-regression');
      const secondCount = control.snapshot().getUserRequests.length;
      Date.now = () => cacheTime + 100;
      const secondRaw = client.auth.getUser();
      const outcome = await Promise.race([
        control.waitForGetUserRequest(secondCount).then(request => ({ type: 'request', request })),
        secondRaw.then(result => ({ type: 'cached', result })),
      ]);
      Date.now = originalDateNow;
      if (outcome.type === 'request') {
        control.resolveGetUser(outcome.request.index, sessionForUser('user-a', 'current-epoch'));
      }
      const secondResult = await secondRaw;
      return {
        firstUserId: firstResult.data && firstResult.data.user ? firstResult.data.user.id : null,
        firstMarker: firstResult.data && firstResult.data.user
          ? firstResult.data.user.user_metadata.auth_marker
          : null,
        outcome: outcome.type,
        secondUserId: secondResult.data && secondResult.data.user ? secondResult.data.user.id : null,
        secondMarker: secondResult.data && secondResult.data.user
          ? secondResult.data.user.user_metadata.auth_marker
          : null,
      };
    } finally {
      Date.now = originalDateNow;
    }

    function sessionForUser(userId, marker) {
      return {
        id: userId,
        email: `${userId}@example.test`,
        user_metadata: { auth_marker: marker },
      };
    }
  });
  assert.equal(observed.firstUserId, 'user-a');
  assert.equal(observed.firstMarker, 'stale-cache');
  assert.equal(observed.outcome, 'request', JSON.stringify(observed));
  assert.equal(observed.secondUserId, 'user-a');
  assert.equal(observed.secondMarker, 'current-epoch');
});

test('current-context revoked response still enforces local sign-out', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await settleDeferredAuthRequest(page, {
    operation: 'validateSessionRevocation',
    resolution: { error: { message: 'Invalid token', status: 401 }, expectSignedOut: true },
  });
  assert.equal(observed.beforeSettlement.userId, 'user-a');
  assert.equal(observed.afterSettlement.status, 'signed_out', JSON.stringify(observed));
  assert.equal(observed.afterSettlement.userId, null);
  assert.equal(observed.afterSettlement.sessionUserId, null);
});

test('DEF-011 TRIAGE-3C checkout rejects a stale response after an authoritative organization switch', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const before = await readBillingActionContext(page);
  const action = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'month' });
  const request = await transport.waitForRequest();
  assert.equal(request.body.organization_id, ORG_A);
  assert.equal(request.userJwt, 'access-user-a');

  await switchWorkspaceAndWait(page, ORG_B, 'Workspace B');
  const afterTransition = await readBillingActionContext(page);
  const checkoutUrl = 'https://checkout.stripe.com/c/pay_triage_3c_org_a';
  const navigationInterceptor = await installBillingNavigationInterception(page, checkoutUrl);
  transport.release({ url: checkoutUrl });
  const result = await action.result();
  const afterResponse = await readBillingActionContext(page);

  t.diagnostic(`DEF-011 scenario A: ${JSON.stringify({ before, request, afterTransition, afterResponse, result })}`);
  assert.equal(afterTransition.userId, 'user-a');
  assert.equal(afterTransition.activeOrgId, ORG_B);
  assert.equal(afterTransition.billingOrgId, ORG_B);
  assert.equal(afterResponse.activeOrgId, ORG_B);
  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 TRIAGE-3C portal rejects a stale response after an authoritative user switch', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const before = await readBillingActionContext(page);
  const action = await beginBillingFacadeAction(page, 'openPortal');
  const request = await transport.waitForRequest();
  assert.equal(request.body.organization_id, ORG_A);
  assert.equal(request.userJwt, 'access-user-a');

  await page.evaluate(session =>
    window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_IN', session), sessionFor('user-b'));
  await waitForSignedInOwner(page, 'user-b', ORG_B);
  const afterTransition = await readBillingActionContext(page);
  const portalUrl = 'https://billing.stripe.com/p/session/triage_3c_user_a_org_a';
  const navigationInterceptor = await installBillingNavigationInterception(page, portalUrl);
  transport.release({ url: portalUrl });
  const result = await action.result();
  const afterResponse = await readBillingActionContext(page);

  t.diagnostic(`DEF-011 scenario B: ${JSON.stringify({ before, request, afterTransition, afterResponse, result })}`);
  assert.equal(afterTransition.userId, 'user-b');
  assert.equal(afterTransition.activeOrgId, ORG_B);
  assert.equal(afterTransition.billingOrgId, ORG_B);
  assert.ok(afterTransition.authEpoch > before.authEpoch);
  assert.equal(afterResponse.userId, 'user-b');
  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 TRIAGE-3C checkout rejects a stale response after sign-out', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const before = await readBillingActionContext(page);
  const action = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'year' });
  const request = await transport.waitForRequest();
  assert.equal(request.body.organization_id, ORG_A);
  assert.equal(request.userJwt, 'access-user-a');

  await page.evaluate(() =>
    window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_OUT', null));
  await page.waitForFunction(() => document.body && document.body.dataset.auth === 'signed_out');
  const afterTransition = await readBillingActionContext(page);
  const checkoutUrl = 'https://checkout.stripe.com/c/pay_triage_3c_signed_out';
  const navigationInterceptor = await installBillingNavigationInterception(page, checkoutUrl);
  transport.release({ url: checkoutUrl });
  const result = await action.result();
  const afterResponse = await readBillingActionContext(page);

  t.diagnostic(`DEF-011 scenario C: ${JSON.stringify({ before, request, afterTransition, afterResponse, result })}`);
  assert.equal(afterTransition.status, 'signed_out');
  assert.equal(afterTransition.userId, null);
  assert.ok(afterTransition.authEpoch > before.authEpoch);
  assert.notEqual(afterTransition.canManageBilling, true);
  assert.equal(afterResponse.status, 'signed_out');
  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 TRIAGE-3C unchanged checkout context still redirects normally', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const before = await readBillingActionContext(page);
  const action = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'month' });
  const request = await transport.waitForRequest();
  assert.equal(request.body.organization_id, ORG_A);
  assert.equal(request.userJwt, 'access-user-a');

  const checkoutUrl = 'https://checkout.stripe.com/c/pay_triage_3c_current';
  const navigationInterceptor = await installBillingNavigationInterception(page, checkoutUrl);
  transport.release({ url: checkoutUrl });
  const [navigation, result] = await Promise.all([
    navigationInterceptor.wait(),
    action.result(),
  ]);
  const afterResponse = await readBillingActionContext(page);

  t.diagnostic(`DEF-011 scenario D: ${JSON.stringify({ before, request, afterResponse, navigation, result })}`);
  assert.equal(afterResponse.userId, before.userId);
  assert.equal(afterResponse.authEpoch, before.authEpoch);
  assert.equal(afterResponse.activeOrgId, before.activeOrgId);
  assert.equal(afterResponse.billingOrgId, before.billingOrgId);
  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(navigation.url, checkoutUrl);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 portal rejects a stale response after sign-out', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const action = await beginBillingFacadeAction(page, 'openPortal');
  const request = await transport.waitForRequest();
  assert.equal(request.body.organization_id, ORG_A);
  assert.equal(request.userJwt, 'access-user-a');

  await page.evaluate(() =>
    window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_OUT', null));
  await page.waitForFunction(() => document.body && document.body.dataset.auth === 'signed_out');
  const portalUrl = 'https://billing.stripe.com/p/session/def_011_signed_out';
  const navigationInterceptor = await installBillingNavigationInterception(page, portalUrl);
  transport.release({ url: portalUrl });
  const result = await action.result();

  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 access loss invalidates a pending checkout redirect', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const action = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'month' });
  await transport.waitForRequest();

  scenario.billing.setDeferred();
  await armWindowEvent(page, 'tp3d:org-access-lost');
  const accessLossRefresh = page.evaluate(() =>
    window.__TP3D_BILLING.refreshBilling({ force: true, reason: 'def-011-access-loss' }));
  await scenario.billing.waitForPendingCount(1);
  await scenario.billing.release(0, { error: 'forbidden' }, 403);
  await Promise.all([
    accessLossRefresh,
    readArmedWindowEvent(page, 'tp3d:org-access-lost'),
  ]);

  const checkoutUrl = 'https://checkout.stripe.com/c/pay_def_011_access_loss';
  const navigationInterceptor = await installBillingNavigationInterception(page, checkoutUrl);
  transport.release({ url: checkoutUrl });
  const result = await action.result();

  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 management authority loss invalidates a pending portal redirect', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const action = await beginBillingFacadeAction(page, 'openPortal');
  await transport.waitForRequest();

  scenario.billing.setDeferred();
  const authorityRefresh = page.evaluate(() =>
    window.__TP3D_BILLING.refreshBilling({ force: true, reason: 'def-011-authority-loss' }));
  await scenario.billing.waitForPendingCount(1);
  await scenario.billing.release(0, billingResponse('pro', {
    billingOwnerUserId: 'another-owner',
    canManageBilling: false,
  }));
  await authorityRefresh;
  const authorityAfterRefresh = await readBillingActionContext(page);
  assert.equal(authorityAfterRefresh.canManageBilling, false);

  const portalUrl = 'https://billing.stripe.com/p/session/def_011_authority_loss';
  const navigationInterceptor = await installBillingNavigationInterception(page, portalUrl);
  transport.release({ url: portalUrl });
  const result = await action.result();

  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 unresolved authority during refresh cannot reuse prior permission', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const action = await beginBillingFacadeAction(page, 'openPortal');
  await transport.waitForRequest();

  scenario.billing.setDeferred();
  const authorityRefresh = page.evaluate(() =>
    window.__TP3D_BILLING.refreshBilling({ force: true, reason: 'def-011-authority-pending' }));
  await scenario.billing.waitForPendingCount(1);
  const pendingBilling = await page.evaluate(() => window.__TP3D_BILLING.getBillingState());
  assert.equal(pendingBilling.loading, true);
  assert.equal(pendingBilling.canManageBilling, true);

  const portalUrl = 'https://billing.stripe.com/p/session/def_011_authority_pending';
  const navigationInterceptor = await installBillingNavigationInterception(page, portalUrl);
  transport.release({ url: portalUrl });
  const result = await action.result();
  assert.deepEqual(result, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(navigationInterceptor.attemptCount(), 0);

  await scenario.billing.release(0, billingResponse('pro'));
  await authorityRefresh;
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 a newer portal supersedes an older checkout', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const checkoutTransport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const portalTransport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const olderCheckout = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'month' });
  await checkoutTransport.waitForRequest();
  const newerPortal = await beginBillingFacadeAction(page, 'openPortal');
  await portalTransport.waitForRequest();

  const checkoutUrl = 'https://checkout.stripe.com/c/pay_def_011_superseded';
  const portalUrl = 'https://billing.stripe.com/p/session/def_011_latest';
  const checkoutNavigation = await installBillingNavigationInterception(page, checkoutUrl);
  const portalNavigation = await installBillingNavigationInterception(page, portalUrl);
  checkoutTransport.release({ url: checkoutUrl });
  const olderResult = await olderCheckout.result();
  assert.deepEqual(olderResult, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(checkoutNavigation.attemptCount(), 0);

  portalTransport.release({ url: portalUrl });
  const [navigation, newerResult] = await Promise.all([
    portalNavigation.wait(),
    newerPortal.result(),
  ]);
  assert.deepEqual(newerResult, { ok: true, error: null });
  assert.equal(navigation.url, portalUrl);
});

test('DEF-011 a newer checkout supersedes an older portal regardless of response order', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const checkoutTransport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const portalTransport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const olderPortal = await beginBillingFacadeAction(page, 'openPortal');
  await portalTransport.waitForRequest();
  const newerCheckout = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'year' });
  await checkoutTransport.waitForRequest();

  const portalUrl = 'https://billing.stripe.com/p/session/def_011_superseded';
  const checkoutUrl = 'https://checkout.stripe.com/c/pay_def_011_latest';
  const portalNavigation = await installBillingNavigationInterception(page, portalUrl);
  const checkoutNavigation = await installBillingNavigationInterception(page, checkoutUrl);
  checkoutTransport.release({ url: checkoutUrl });
  const [navigation, newerResult] = await Promise.all([
    checkoutNavigation.wait(),
    newerCheckout.result(),
  ]);
  assert.deepEqual(newerResult, { ok: true, error: null });
  assert.equal(navigation.url, checkoutUrl);

  portalTransport.release({ url: portalUrl });
  const olderResult = await olderPortal.result();
  assert.deepEqual(olderResult, { ok: false, error: 'Billing context changed. Please try again.' });
  assert.equal(portalNavigation.attemptCount(), 0);
});

test('DEF-011 unchanged portal context still redirects normally', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-portal-session');
  const action = await beginBillingFacadeAction(page, 'openPortal');
  await transport.waitForRequest();
  const portalUrl = 'https://billing.stripe.com/p/session/def_011_current';
  const navigationInterceptor = await installBillingNavigationInterception(page, portalUrl);
  transport.release({ url: portalUrl });
  const [navigation, result] = await Promise.all([
    navigationInterceptor.wait(),
    action.result(),
  ]);

  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(navigation.url, portalUrl);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 unsafe checkout URL keeps the existing service rejection', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const action = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'month' });
  await transport.waitForRequest();
  transport.release({ url: 'https://billing-attacker.example/checkout' });
  const result = await action.result();

  assert.deepEqual(result, { ok: false, error: 'Unexpected checkout redirect URL.' });
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('DEF-011 checkout timeout remains an error and a late response cannot navigate', async t => {
  const scenario = await harness.createScenario(signedInScenario());
  t.after(() => scenario.close());
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const transport = await installDeferredBillingAction(scenario, 'stripe-create-checkout-session');
  const action = await beginBillingFacadeAction(page, 'startCheckout', { interval: 'month' });
  await transport.waitForRequest();
  const result = await action.result();
  assert.deepEqual(result, { ok: false, error: 'Checkout request timed out' });

  const lateUrl = 'https://checkout.stripe.com/c/pay_def_011_late_timeout';
  const navigationInterceptor = await installBillingNavigationInterception(page, lateUrl);
  transport.release({ url: lateUrl });
  await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => resolve())));
  assert.equal(navigationInterceptor.attemptCount(), 0);
  assert.equal(page.url(), `${harness.baseUrl}/index.html`);
});

test('same-tab workspace switching exposes not-ready then ready lifecycle state', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const observed = await switchWorkspaceAndWait(page, ORG_B, 'Workspace B');
  assert.equal(observed.activeOrgId, ORG_B);
  assert.equal(observed.during.active, true);
  assert.equal(observed.during.fromOrgId, ORG_A);
  assert.equal(observed.during.toOrgId, ORG_B);
  assert.equal(observed.after.active, false);
  assert.equal(observed.after.localStateReady, true);
  assert.equal(observed.after.orgReady, true);
  assert.equal(observed.after.billingReady, true);
  assert.ok(observed.detail.states.some(state => state.active && !state.billingReady),
    'the emitted switch sequence exposes a not-ready state before completion');
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('real two-page context propagates cross-tab workspace readiness', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const sender = await scenario.openPage();
  const receiver = await scenario.openPage();
  await Promise.all([
    scenario.waitForAppReady(sender),
    scenario.waitForAppReady(receiver),
  ]);
  await Promise.all([
    waitForSignedInOwner(sender, 'user-a', ORG_A),
    waitForSignedInOwner(receiver, 'user-a', ORG_A),
  ]);

  await armWorkspaceReady(receiver, ORG_B);
  const senderObserved = await switchWorkspaceAndWait(sender, ORG_B, 'Workspace B');
  const receiverObserved = await readArmedWorkspaceReady(receiver);

  assert.equal(senderObserved.activeOrgId, ORG_B);
  assert.equal(receiverObserved.activeOrgId, ORG_B);
  assert.equal(receiverObserved.state.active, false);
  assert.equal(receiverObserved.state.orgReady, true);
  assert.equal(receiverObserved.state.billingReady, true);
  assert.ok(receiverObserved.detail.states.some(state => state.active && state.remote),
    'the receiver observes an active remote switch before readiness');
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('DEF-010 older conflicting active readiness cannot replace a newer completed target', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const receiver = await scenario.openPage();
  const sender = await openWorkspaceSyncSender(scenario);
  await scenario.waitForAppReady(receiver);
  await waitForSignedInOwner(receiver, 'user-a', ORG_A);

  await switchWorkspaceAndWait(receiver, ORG_B, 'Workspace B');
  await switchWorkspaceAndWait(receiver, ORG_A, 'Workspace A');
  await switchWorkspaceAndWait(receiver, ORG_B, 'Workspace B');
  const before = await receiver.evaluate(() => ({
    activeOrgId: window.OrgContext.getActiveOrgId(),
    localOrgId: window.localStorage.getItem('tp3d:active-org-id'),
    route: window.location.hash,
    state: window.TruckPackerApp.getWorkspaceSwitchState(),
  }));
  assert.equal(before.activeOrgId, ORG_B);
  assert.equal(before.state.active, false);
  assert.equal(before.state.toOrgId, ORG_B);
  assert.ok(before.state.version > 1, JSON.stringify(before));

  const staleTimestamp = Math.max(1, Number(before.state.finishedAt) - 5000);
  const after = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    active: true,
    fromOrgId: ORG_B,
    toOrgId: ORG_A,
    source: 'triage-3b-older-tab',
    startedAt: staleTimestamp,
    finishedAt: 0,
    version: 1,
    localStateReady: false,
    orgReady: false,
    billingReady: false,
    remote: false,
    reason: 'triage-3b-older-conflicting-active',
    userId: 'user-a',
    tabId: 'triage-3b-stale-tab',
    ts: staleTimestamp,
  });
  t.diagnostic(`TRIAGE-3B scenario A: ${JSON.stringify({ before, after })}`);

  assert.equal(after.activeOrgId, ORG_B, JSON.stringify({ before, after }));
  assert.equal(after.billingOrgId, ORG_B);
  assert.equal(after.localOrgId, ORG_B);
  assert.deepEqual(after.state, before.state);
  assert.equal(after.route, before.route);
});

test('TRIAGE-3B older completion for another target cannot finish a newer local switch', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const receiver = await scenario.openPage();
  const sender = await openWorkspaceSyncSender(scenario);
  await scenario.waitForAppReady(receiver);
  await waitForSignedInOwner(receiver, 'user-a', ORG_A);
  scenario.billing.setDeferred();

  await receiver.evaluate(orgId => window.OrgContext.setActiveOrgId(orgId, {
    source: 'triage-3b-newer-local-switch',
  }), ORG_B);
  const before = await receiver.evaluate(() => ({
    activeOrgId: window.OrgContext.getActiveOrgId(),
    localOrgId: window.localStorage.getItem('tp3d:active-org-id'),
    route: window.location.hash,
    state: window.TruckPackerApp.getWorkspaceSwitchState(),
  }));
  assert.equal(before.activeOrgId, ORG_B);
  assert.equal(before.state.active, true, JSON.stringify(before));
  assert.equal(before.state.toOrgId, ORG_B);
  assert.equal(before.state.remote, false);

  const staleTimestamp = Math.max(1, Number(before.state.startedAt) - 5000);
  const after = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    active: false,
    fromOrgId: ORG_B,
    toOrgId: ORG_A,
    source: 'triage-3b-older-tab',
    startedAt: staleTimestamp - 1000,
    finishedAt: staleTimestamp,
    version: 1,
    localStateReady: true,
    orgReady: true,
    billingReady: true,
    remote: true,
    reason: 'triage-3b-stale-completion',
    userId: 'user-a',
    tabId: 'triage-3b-stale-tab',
    ts: staleTimestamp,
  });
  t.diagnostic(`TRIAGE-3B scenario B: ${JSON.stringify({ before, after })}`);

  assert.equal(after.activeOrgId, ORG_B, JSON.stringify({ before, after }));
  assert.equal(after.localOrgId, ORG_B);
  assert.equal(after.state.active, true);
  assert.equal(after.state.toOrgId, ORG_B);
  assert.equal(after.state.version, before.state.version);
  assert.equal(after.state.remote, false);
  assert.equal(after.route, before.route);
});

test('DEF-010 older same-target progress cannot lower readiness flags', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const receiver = await scenario.openPage();
  const sender = await openWorkspaceSyncSender(scenario);
  await scenario.waitForAppReady(receiver);
  await waitForSignedInOwner(receiver, 'user-a', ORG_A);
  scenario.billing.setDeferred();

  await receiver.evaluate(orgId => window.OrgContext.setActiveOrgId(orgId, {
    source: 'def-010-same-target-progress',
  }), ORG_B);
  const before = await receiver.evaluate(() => window.TruckPackerApp.getWorkspaceSwitchState());
  assert.equal(before.active, true, JSON.stringify(before));
  assert.equal(before.toOrgId, ORG_B);
  assert.equal(before.localStateReady, true);
  assert.equal(before.orgReady, true);
  assert.equal(before.billingReady, false);

  const after = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    active: true,
    fromOrgId: ORG_A,
    toOrgId: ORG_B,
    source: 'def-010-older-progress',
    startedAt: before.startedAt,
    finishedAt: 0,
    version: 999,
    localStateReady: false,
    orgReady: false,
    billingReady: false,
    remote: true,
    reason: 'def-010-older-same-target-progress',
    userId: 'user-a',
    tabId: 'def-010-older-progress-tab',
    ts: Math.max(1, Number(before.startedAt)),
  });

  assert.equal(after.activeOrgId, ORG_B);
  assert.equal(after.billingOrgId, ORG_B);
  assert.equal(after.localOrgId, ORG_B);
  assert.deepEqual(after.state, before);
});

test('DEF-010 genuinely newer remote progress is accepted before canonical org synchronization', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const receiver = await scenario.openPage();
  const sender = await openWorkspaceSyncSender(scenario);
  await scenario.waitForAppReady(receiver);
  await waitForSignedInOwner(receiver, 'user-a', ORG_A);

  const transitionAt = Date.now() + 60000;
  const first = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    active: true,
    fromOrgId: ORG_A,
    toOrgId: ORG_B,
    source: 'def-010-newer-remote',
    startedAt: transitionAt,
    finishedAt: 0,
    version: 1,
    localStateReady: true,
    orgReady: false,
    billingReady: false,
    remote: false,
    reason: 'def-010-newer-remote-begin',
    userId: 'user-a',
    tabId: 'def-010-newer-tab',
    ts: transitionAt,
  });
  assert.equal(first.activeOrgId, ORG_A);
  assert.equal(first.billingOrgId, ORG_A);
  assert.equal(first.state.active, true);
  assert.equal(first.state.toOrgId, ORG_B);
  assert.equal(first.state.localStateReady, true);
  assert.equal(first.state.orgReady, false);

  const progress = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    active: true,
    fromOrgId: ORG_A,
    toOrgId: ORG_B,
    source: 'def-010-newer-remote',
    startedAt: transitionAt,
    finishedAt: 0,
    version: 1,
    localStateReady: true,
    orgReady: true,
    billingReady: false,
    remote: true,
    reason: 'def-010-newer-remote-progress',
    userId: 'user-a',
    tabId: 'def-010-newer-tab',
    ts: transitionAt + 1,
  });
  assert.equal(progress.activeOrgId, ORG_A);
  assert.equal(progress.billingOrgId, ORG_A);
  assert.equal(progress.state.toOrgId, ORG_B);
  assert.equal(progress.state.localStateReady, true);
  assert.equal(progress.state.orgReady, true);
  assert.equal(progress.state.billingReady, false);
  assert.equal(progress.state.remote, true);
});

test('DEF-010 equal-time readiness state converges on the greater tab ID', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const receiver = await scenario.openPage();
  const sender = await openWorkspaceSyncSender(scenario);
  await scenario.waitForAppReady(receiver);
  await waitForSignedInOwner(receiver, 'user-a', ORG_A);

  const transitionAt = Date.now() + 60000;
  const payload = {
    active: true,
    fromOrgId: ORG_A,
    source: 'def-010-equal-time',
    startedAt: transitionAt,
    finishedAt: 0,
    version: 1,
    localStateReady: false,
    orgReady: false,
    billingReady: false,
    remote: true,
    userId: 'user-a',
    ts: transitionAt,
  };
  const lower = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    ...payload,
    toOrgId: ORG_B,
    reason: 'def-010-equal-time-lower-first',
    tabId: 'def-010-tab-a',
  });
  assert.equal(lower.state.toOrgId, ORG_B);

  const greater = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    ...payload,
    toOrgId: ORG_A,
    reason: 'def-010-equal-time-greater',
    tabId: 'def-010-tab-z',
  });
  assert.equal(greater.state.toOrgId, ORG_A);
  assert.equal(greater.state.source, 'def-010-equal-time');

  const lowerAfterGreater = await sendWorkspaceSwitchSyncAndObserve(sender, receiver, {
    ...payload,
    toOrgId: ORG_B,
    reason: 'def-010-equal-time-lower-last',
    tabId: 'def-010-tab-m',
  });
  assert.equal(lowerAfterGreater.state.toOrgId, ORG_A);
  assert.equal(lowerAfterGreater.activeOrgId, ORG_A);
  assert.equal(lowerAfterGreater.billingOrgId, ORG_A);
  assert.equal(lowerAfterGreater.localOrgId, ORG_A);
});

test('failed organization bundle loading can recover on a later hydration', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const failureBaseline = await page.evaluate(() => {
    const control = window.__TP3D_FAKE_SUPABASE_CONTROL__;
    const count = control.snapshot().orgQueryFailures.length;
    window.__TP3D_FAKE_SUPABASE_CONTROL__.setOrgQueriesUnavailable(true);
    window.__TP3D_TEST_ORG_FAILURE__ = control.waitForOrgQueryFailure(count);
    return count;
  });
  await clickWorkspaceOption(page, 'Workspace B');
  const observedFailure = await page.evaluate(async () => {
    const failure = await window.__TP3D_TEST_ORG_FAILURE__;
    delete window.__TP3D_TEST_ORG_FAILURE__;
    return failure;
  });
  assert.equal(failureBaseline, 0);
  assert.ok(observedFailure.operation);

  await page.evaluate(() => {
    window.__TP3D_FAKE_SUPABASE_CONTROL__.setOrgQueriesUnavailable(false);
  });
  await page.evaluate(async () => {
    await window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_OUT', null);
  });
  await page.waitForFunction(() => document.body && document.body.dataset.auth === 'signed_out');
  await page.evaluate(async session => {
    await window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_IN', session);
  }, sessionFor('user-a'));
  await waitForSignedInOwner(page, 'user-a', ORG_B);

  const reset = await switchWorkspaceAndWait(page, ORG_A, 'Workspace A');
  assert.equal(reset.activeOrgId, ORG_A);
  const recovered = await switchWorkspaceAndWait(page, ORG_B, 'Workspace B');
  assert.equal(recovered.activeOrgId, ORG_B);
  assert.equal(recovered.after.active, false);
  assert.equal(recovered.after.orgReady, true);
  assert.equal(recovered.after.billingReady, true);
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('deferred billing rejects a stale auth epoch and lets the latest authoritative generation own state', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);
  scenario.billing.setDeferred();

  const switchToB = page.evaluate(session =>
    window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_IN', session), sessionFor('user-b'));
  await scenario.billing.waitForPendingCount(1);
  const firstPending = scenario.billing.pendingSnapshot();
  assert.equal(new URL(firstPending[0].url).searchParams.get('organization_id'), ORG_B);

  const switchBackToA = page.evaluate(session =>
    window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_IN', session), sessionFor('user-a'));
  await scenario.billing.release(0, billingResponse('free', {
    status: 'past_due',
    entitlementStatus: 'workspace_limit_reached',
    workspaceIncluded: false,
    workspaceLimit: 0,
    billingOwnerUserId: 'user-b',
    canManageBilling: false,
  }));

  await scenario.billing.waitForPendingCount(1);
  const latestPending = scenario.billing.pendingSnapshot();
  assert.equal(new URL(latestPending[0].url).searchParams.get('organization_id'), ORG_A);
  await scenario.billing.release(0, billingResponse('pro'));

  const authResults = await Promise.allSettled([switchToB, switchBackToA]);
  assert.deepEqual(authResults.map(result => result.status), ['fulfilled', 'fulfilled']);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const blockedGeneration = await page.evaluate(() => window.__TP3D_BILLING.getBillingState());
  assert.equal(blockedGeneration.entitlementStatus, 'billing_unavailable');
  assert.match(blockedGeneration.error && blockedGeneration.error.message || '', /identity mismatch/i);

  await page.evaluate(() => window.__TP3D_BILLING.clearBillingState());
  await armBillingPlan(page, 'Pro');
  const authoritativeRecovery = page.evaluate(() => window.__TP3D_BILLING.refreshBilling(true));
  await scenario.billing.waitForPendingCount(1);
  await scenario.billing.release(0, billingResponse('pro'));
  await authoritativeRecovery;
  const finalBilling = await readArmedBillingPlan(page);
  assert.equal(finalBilling.plan, 'Pro', JSON.stringify(finalBilling));
  assert.equal(finalBilling.orgId, ORG_A);
  assert.equal(finalBilling.entitlementStatus, 'active');
  assert.equal(await page.locator('#modal-root .modal-overlay:visible').count(), 0,
    'the stale blocking entitlement must not win the access gate');
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('offline workspace activity recovers billing after the native online event', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);
  scenario.billing.setAutomatic({ message: 'offline billing transport unavailable' }, 503);
  const failedSwitch = await switchWorkspaceAndWait(page, ORG_B, 'Workspace B');
  assert.equal(failedSwitch.activeOrgId, ORG_B);
  const unavailableBilling = await page.evaluate(() => window.__TP3D_BILLING.getBillingState());
  assert.ok(!unavailableBilling.ok || unavailableBilling.entitlementStatus === 'billing_unavailable',
    JSON.stringify(unavailableBilling));

  await armWindowEvent(page, 'offline');
  await scenario.context.setOffline(true);
  const offlineEvent = await readArmedWindowEvent(page, 'offline');
  assert.equal(offlineEvent.online, false);

  scenario.billing.setDeferred();
  await armBillingPlan(page, 'Pro');

  await armWindowEvent(page, 'online');
  await scenario.context.setOffline(false);
  const onlineEvent = await readArmedWindowEvent(page, 'online');
  assert.equal(onlineEvent.online, true);
  const recoveryRefresh = page.evaluate(() => {
    window.__TP3D_BILLING.clearBillingState();
    return window.__TP3D_BILLING.refreshBilling(true);
  });
  await scenario.billing.waitForPendingCount(1);
  const recoveryPending = scenario.billing.pendingSnapshot();
  assert.equal(new URL(recoveryPending[0].url).searchParams.get('organization_id'), ORG_B);
  await scenario.billing.release(0, billingResponse('pro'));
  await recoveryRefresh;

  const recoveredBilling = await readArmedBillingPlan(page);
  assert.equal(recoveredBilling.plan, 'Pro');
  assert.equal(recoveredBilling.entitlementStatus, 'active');
  assert.equal(await page.evaluate(() => window.navigator.onLine), true);
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('auth user switching A to B to A replaces user-scoped workspace state', async t => {
  const scenario = await harness.createScenario(signedInScenario(['user-a', 'user-b']));
  t.after(() => scenario.close());

  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  await page.evaluate(async session => {
    await window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_IN', session);
  }, sessionFor('user-b'));
  await waitForSignedInOwner(page, 'user-b', ORG_B);

  await page.evaluate(async session => {
    await window.__TP3D_FAKE_SUPABASE_CONTROL__.emitAuth('SIGNED_IN', session);
  }, sessionFor('user-a'));
  await waitForSignedInOwner(page, 'user-a', ORG_A);

  const snapshot = await readRuntimeSnapshot(page);
  assert.deepEqual(
    snapshot.fakeSupabase.authEvents
      .filter(entry => entry.event === 'SIGNED_IN')
      .map(entry => entry.userId),
    ['user-b', 'user-a']
  );
  assert.equal(scenario.diagnostics.pageErrors.length, 0, JSON.stringify(scenario.diagnostics.pageErrors));
});

test('C4 saved invalid pose survives open, read-only Check and referenced Case edit in the live editor', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await scenario.context.route('**/index.html', async route => {
    const response = await route.fetch();
    const imports = { three: '/node_modules/three/build/three.module.js', 'three/addons/': '/node_modules/three/examples/jsm/' };
    await route.fulfill({ response, body: (await response.text()).replace('<head>',
      `<head><script type="importmap">${JSON.stringify({ imports })}</script>`) });
  });
  // Read-only scene probe on this test response; no production debug API added.
  await scenario.context.route('**/src/app.js?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      '_debug: { Utils, StateStore, Storage, CaseLibrary, PackLibrary, Defaults }',
      '_debug: { Utils, StateStore, Storage, CaseLibrary, PackLibrary, Defaults, CaseScene, SceneManager }') });
  });
  const instance = { id: 'c4-instance', caseId: 'c4-case', hidden: false, placement: 'packed', groupId: 'c4-group',
    orientationLocked: true, lockedRotation: { x: 0, y: Math.PI / 2, z: 0 },
    transform: { position: { x: 50, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
  const saved = { version: 'legacy', savedAt: 123,
    caseLibrary: [{ id: 'c4-case', name: 'C4 Saved Case', dimensions: { length: 10, width: 10, height: 10 }, weight: 10, shape: 'box', orientationLock: 'any' }],
    packLibrary: [{ id: 'c4-pack', title: 'C4 Saved Load', loadPlanNumber: 'C4-QA',
      truck: { length: 120, width: 80, height: 80, shapeMode: 'rect' },
      cases: [instance], groups: [{ id: 'c4-group', name: 'Saved group' }], createdAt: 12, lastEdited: 34 }],
    folderLibrary: [], currentPackId: null };
  await scenario.context.addInitScript(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)),
    { key: `truckPacker3d:v1:user-a:workspace:${ORG_A}`, saved });
  const page = await scenario.openPage();
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);
  await page.locator('#packs-grid .card').filter({ hasText: 'C4 Saved Load' }).click();
  await page.locator('#editor-validation-status-btn').waitFor({ state: 'visible' });
  const snapshot = () => page.evaluate(() => {
    const { StateStore, PackLibrary, CaseScene, SceneManager } = window.TruckPackerApp._debug;
    const pack = PackLibrary.getById('c4-pack');
    const object = CaseScene.getObject('c4-instance');
    return { pack, assessment: PackLibrary.validateLoadPlan(pack.id).primary,
      scene: object && { position: SceneManager.vecWorldToInches(object.position),
        rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z } },
      length: StateStore.get('caseLibrary')[0].dimensions.length };
  });
  const opened = await snapshot();
  assert.equal(opened.assessment, 'INVALID');
  assert.deepEqual(opened.pack.cases[0], instance);
  assert.deepEqual(opened.scene, { position: instance.transform.position, rotation: instance.transform.rotation });
  await page.locator('#editor-validation-status-btn').click();
  await page.getByRole('button', { name: 'Check Load Plan', exact: true }).click();
  assert.deepEqual(await snapshot(), opened, 'Check preserves source, timestamp and actual rendered pose');
  assert.match(await page.locator('#editor-validation-hint-body').textContent(), /Physical assessment: INVALID/);
  assert.equal(await page.evaluate(() => window.TruckPackerApp._debug.StateStore.undo()), false);
  await page.locator('#btn-sidebar').click();
  await page.locator('[data-nav="cases"]').click();
  await page.getByRole('button', { name: 'More actions for C4 Saved Case', exact: true }).click();
  await page.getByText('Edit', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Length (in) (required)', exact: true }).fill('20');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-nav="packs"]').click();
  await page.locator('#packs-grid .card').filter({ hasText: 'C4 Saved Load' }).click();
  await page.locator('#editor-validation-status-btn').waitFor({ state: 'visible' });
  const edited = await snapshot();
  assert.notEqual(edited.length, opened.length);
  assert.deepEqual(edited.pack.cases, opened.pack.cases);
  assert.equal(edited.pack.lastEdited, opened.pack.lastEdited);
  assert.deepEqual(edited.scene, opened.scene, 'Case Save changes the envelope, not its rendered pose');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
  await page.screenshot({ path: '/tmp/c4-editor-preserved-pose.png' });
});

// ── Folder Foundation Stage 1: Folder dialogs in the real app ───────────────────────────────
// Real clicks and typing drive the dialogs. The one stale-handler probe below calls a held button's
// click() directly and says so: it proves the write-time re-validation, not user behaviour.
const HOSTILE_FOLDER_NAME = '<img src=x onerror="window.__tp3dFolderXss=1"><b>bold</b> &amp; <script>window.__tp3dFolderXss=2</script>';
const folderWorkspaceKey = orgId => `truckPacker3d:v1:user-a:workspace:${orgId}`;

function folderWorkspacePayload({ folders = [], packs = [] }) {
  return {
    version: 'folder-stage1',
    savedAt: 1,
    caseLibrary: [],
    packLibrary: packs.map(pack => ({
      truck: { length: 100, width: 80, height: 80, shapeMode: 'rect' },
      cases: [], groups: [], createdAt: 1, lastEdited: 2, folderId: null, ...pack,
    })),
    folderLibrary: folders.map(folder => ({
      scope: 'pack', parentFolderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...folder,
    })),
    currentPackId: null,
  };
}

async function seedFolderWorkspaces(scenario, entries) {
  // The same npm Three.js import map the C3 fixture uses, then first-write-only localStorage seeds.
  await scenario.context.route('**/index.html', async route => {
    const response = await route.fetch();
    const imports = { three: '/node_modules/three/build/three.module.js',
      'three/addons/': '/node_modules/three/examples/jsm/' };
    const body = (await response.text()).replace('<head>',
      `<head><script type="importmap">${JSON.stringify({ imports })}</script>`);
    await route.fulfill({ response, body });
  });
  await scenario.context.addInitScript(values => {
    for (const [key, data] of values) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
    }
  }, entries);
}

async function openFolderLibrary(scenario, page) {
  await scenario.waitForAppReady(page);
  await waitForSignedInOwner(page, 'user-a', ORG_A);
  await page.locator('.tp3d-packs-folder-btn').waitFor({ state: 'visible' });
}

async function openFoldersMenu(page) {
  await page.locator('.tp3d-packs-folder-btn').click();
  const menu = page.locator('[data-dropdown="1"][data-role="packs-folders"]');
  await menu.waitFor({ state: 'visible' });
  return menu;
}

async function chooseFolderFilter(page, label) {
  const menu = await openFoldersMenu(page);
  await menu.getByRole('menuitem').filter({ hasText: label }).first().click();
}

async function chooseFolderAction(page, action) {
  const menu = await openFoldersMenu(page);
  await menu.getByRole('menuitem', { name: action }).click();
}

async function folderSnapshot(page) {
  return page.evaluate(async () => {
    const StateStore = await import('/src/core/state-store.js');
    return JSON.stringify({
      folders: (StateStore.get('folderLibrary') || []).map(f => [f.id, f.name, f.updatedAt]),
      packs: (StateStore.get('packLibrary') || []).map(p => [p.id, p.folderId, p.lastEdited]),
      undoDepth: StateStore.undoDepth(),
    });
  });
}

test('Folder Stage 1 F-01: a hostile Folder name is literal text in every Folder menu and dialog', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: 'f-hostile', name: HOSTILE_FOLDER_NAME }],
    packs: [{ id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001', folderId: 'f-hostile' }],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);

  // Stored data: the Folders menu row and the button label, then the Delete confirmation.
  await chooseFolderFilter(page, 'tp3dFolderXss');
  assert.equal(await page.locator('.tp3d-packs-folder-btn__label').textContent(), HOSTILE_FOLDER_NAME);
  await chooseFolderAction(page, 'Delete Folder');
  const confirmBody = page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) .modal-body');
  await confirmBody.waitFor({ state: 'visible' });
  assert.ok((await confirmBody.textContent()).includes(`Delete "${HOSTILE_FOLDER_NAME}"?`),
    'the confirmation shows the name literally');
  assert.equal(await page.locator('#modal-root img, #modal-root b, #modal-root script').count(), 0,
    'no element was created from the name');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay])').waitFor({ state: 'detached' });

  // Rename dialog and Move dialog.
  await chooseFolderAction(page, 'Rename Folder');
  assert.equal(await page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]').inputValue(), HOSTILE_FOLDER_NAME);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay])').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'More actions for Plan One', exact: true }).click();
  await page.locator('.dropdown-item', { hasText: 'Move to Folder' }).click();
  await page.locator('#modal-root .tp3d-packs-folder-option-btn').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#modal-root img, #modal-root b, #modal-root script').count(), 0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay])').waitFor({ state: 'detached' });

  // Created through the UI with real typing: same literal rendering, then delete it.
  await chooseFolderAction(page, 'New Folder');
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]').fill(HOSTILE_FOLDER_NAME.replace('tp3dFolderXss=1', 'tp3dFolderXss=3').slice(0, 90));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await chooseFolderAction(page, 'Delete Folder');
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) .modal-body').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#modal-root img, #modal-root b, #modal-root script').count(), 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  assert.equal(await page.evaluate(() => window.__tp3dFolderXss), undefined, 'no handler or script ran');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

test('Folder Stage 1 F-02: open Folder dialogs cannot act after A to B and A to B to A with overlapping ids', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  const workspace = name => folderWorkspacePayload({
    folders: [{ id: 'f1', name: `${name} One`, sortOrder: 0 }, { id: 'f2', name: `${name} Two`, sortOrder: 100 }],
    packs: [
      { id: 'p1', title: `${name} Plan 1`, loadPlanNumber: 'LP-00000001', folderId: 'f1' },
      { id: 'p2', title: `${name} Plan 2`, loadPlanNumber: 'LP-00000002', folderId: null },
    ],
  });
  await seedFolderWorkspaces(scenario, [
    [folderWorkspaceKey(ORG_A), workspace('Alpha')],
    [folderWorkspaceKey(ORG_B), workspace('Beta')],
  ]);
  const receiver = await scenario.openPage();
  const sender = await scenario.openPage();
  await Promise.all([openFolderLibrary(scenario, receiver), openFolderLibrary(scenario, sender)]);

  const holdPrimaryAction = (page, selector) => page.evaluate(sel => {
    window.__tp3dHeldFolderAction = document.querySelector(sel);
    return Boolean(window.__tp3dHeldFolderAction);
  }, selector);
  const dialogs = {
    async create() {
      await chooseFolderAction(receiver, 'New Folder');
      await receiver.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]').fill('Injected By Stale Dialog');
      return holdPrimaryAction(receiver, '#modal-root .modal-overlay:not([data-auth-overlay]) .modal-footer button.btn-primary');
    },
    async rename() {
      await chooseFolderFilter(receiver, 'Alpha One');
      await chooseFolderAction(receiver, 'Rename Folder');
      await receiver.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]').fill('Renamed By Stale Dialog');
      return holdPrimaryAction(receiver, '#modal-root .modal-overlay:not([data-auth-overlay]) .modal-footer button.btn-primary');
    },
    async delete() {
      await chooseFolderFilter(receiver, 'Alpha One');
      await chooseFolderAction(receiver, 'Delete Folder');
      await receiver.locator('#modal-root .modal-overlay:not([data-auth-overlay]) .modal-footer button.btn-danger').waitFor({ state: 'visible' });
      return holdPrimaryAction(receiver, '#modal-root .modal-overlay:not([data-auth-overlay]) .modal-footer button.btn-danger');
    },
    async move() {
      await receiver.getByRole('button', { name: 'More actions for Alpha Plan 2', exact: true }).click();
      await receiver.locator('.dropdown-item', { hasText: 'Move to Folder' }).click();
      await receiver.locator('#modal-root .tp3d-packs-folder-option-btn').first().waitFor({ state: 'visible' });
      return holdPrimaryAction(receiver,
        '#modal-root .tp3d-packs-folder-option-btn:has(.tp3d-packs-folder-option-btn__label)'
        + ':nth-of-type(3)');
    },
  };
  const switchBoth = async (orgId, name) => {
    await armWorkspaceReady(receiver, orgId);
    await switchWorkspaceAndWait(sender, orgId, name);
    await readArmedWorkspaceReady(receiver);
    await receiver.locator('.tp3d-packs-folder-btn').waitFor({ state: 'visible' });
  };

  for (const kind of ['create', 'rename', 'delete', 'move']) {
    assert.equal(await dialogs[kind](), true, `${kind}: the dialog's action button was held`);

    await switchBoth(ORG_B, 'Workspace B');
    assert.equal(await receiver.locator('#modal-root .modal-overlay:not([data-auth-overlay])').count(), 0,
      `${kind}: the dialog is dismissed when the workspace changes`);
    const inB = await folderSnapshot(receiver);
    // Stale-handler probe (direct click): the dialog is gone, but its handler must still refuse to write.
    await receiver.evaluate(() => window.__tp3dHeldFolderAction.click());
    await receiver.locator('.toast', { hasText: 'workspace changed' }).first().waitFor({ state: 'visible' });
    assert.equal(await folderSnapshot(receiver), inB, `${kind}: A to B leaves workspace B untouched`);

    await switchBoth(ORG_A, 'Workspace A');
    const inA = await folderSnapshot(receiver);
    await receiver.evaluate(() => window.__tp3dHeldFolderAction.click());
    assert.equal(await folderSnapshot(receiver), inA,
      `${kind}: A to B to A does not make the old dialog valid again`);
    assert.match(inA, /Alpha One/);
  }
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

// Titles (from `titles`) of the Load Plan cards currently shown in the grid.
async function shownPlans(page, titles) {
  const texts = await page.locator('#packs-grid .card').allTextContents();
  return titles.filter(title => texts.some(text => text.includes(title)));
}

async function moveShownPlan(page, planTitle, destinationLabel) {
  await page.getByRole('button', { name: `More actions for ${planTitle}`, exact: true }).click();
  await page.locator('.dropdown-item', { hasText: 'Move to Folder' }).click();
  await page.locator('#modal-root .tp3d-packs-folder-option-btn').first().waitFor({ state: 'visible' });
  await page.locator('#modal-root .tp3d-packs-folder-option-btn', { hasText: destinationLabel }).first().click();
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay])').waitFor({ state: 'detached' });
}

test('Folder Stage 1 F-05: a real Folder whose id looks like the Unfiled token filters separately from Unfiled', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: '__unfiled__', name: 'Odd Id Folder' }],
    packs: [
      { id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001' },
      { id: 'p2', title: 'Plan Two', loadPlanNumber: 'LP-00000002' },
    ],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);
  const titles = ['Plan One', 'Plan Two'];

  await moveShownPlan(page, 'Plan One', 'Odd Id Folder');
  const stored = JSON.parse(await folderSnapshot(page));
  assert.deepEqual(stored.folders.map(f => [f[0], f[1]]), [['__unfiled__', 'Odd Id Folder']],
    'the real Folder keeps its id and its name');
  assert.deepEqual(stored.packs.map(p => [p[0], p[1]]), [['p1', '__unfiled__'], ['p2', null]]);

  await chooseFolderFilter(page, 'Odd Id Folder (1)');
  assert.deepEqual(await shownPlans(page, titles), ['Plan One'], 'the Folder filter shows only its own plan');
  assert.equal(await page.locator('.tp3d-packs-folder-btn__label').textContent(), 'Odd Id Folder');

  await chooseFolderFilter(page, 'Unfiled (1)');
  assert.deepEqual(await shownPlans(page, titles), ['Plan Two'], 'the Unfiled filter shows only the plan with no Folder');
  assert.equal(await page.locator('.tp3d-packs-folder-btn__label').textContent(), 'Unfiled');

  await chooseFolderFilter(page, 'All Load Plans (2)');
  assert.deepEqual(await shownPlans(page, titles), titles);
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

test('Folder Stage 1 F-03: damaged Folder data stays as stored, no plan is invisible, and repair is explicit', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  const seeded = folderWorkspacePayload({
    folders: [
      { id: 'f-good', name: 'Good Folder' },
      { id: 'f-dup', name: 'Dup First' },
      { id: 'f-dup', name: 'Dup Second' },
    ],
    packs: [
      { id: 'p-ok', title: 'Plan Ok', loadPlanNumber: 'LP-00000001', folderId: 'f-good' },
      { id: 'p-ghost', title: 'Plan Ghost', loadPlanNumber: 'LP-00000002', folderId: 'f-gone' },
      { id: 'p-dup', title: 'Plan Dup', loadPlanNumber: 'LP-00000003', folderId: 'f-dup' },
      { id: 'p-free', title: 'Plan Free', loadPlanNumber: 'LP-00000004' },
    ],
  });
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), seeded]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);
  const titles = ['Plan Ok', 'Plan Ghost', 'Plan Dup', 'Plan Free'];

  // Startup changed nothing: the stored Folder records are exactly the seeded ones, and the original is kept.
  const afterLoad = await page.evaluate(({ key, evidence }) => ({
    folders: JSON.parse(localStorage.getItem(key)).folderLibrary.map(f => [f.id, f.name]),
    evidence: JSON.parse(localStorage.getItem(evidence) || 'null'),
  }), { key: folderWorkspaceKey(ORG_A), evidence: `${folderWorkspaceKey(ORG_A)}:folder-graph-evidence` });
  assert.deepEqual(afterLoad.folders, [['f-good', 'Good Folder'], ['f-dup', 'Dup First'], ['f-dup', 'Dup Second']]);
  assert.deepEqual(afterLoad.evidence.folderLibrary.map(f => f.name), ['Good Folder', 'Dup First', 'Dup Second']);
  assert.equal(afterLoad.evidence.packFolderRefs.find(r => r.id === 'p-ghost').folderId, 'f-gone');

  // A visible, persistent warning; every plan is reachable; the counts add up.
  const notice = page.locator('#packs-folder-notice');
  await notice.waitFor({ state: 'visible' });
  assert.match(await notice.textContent(), /2 load plans point to a Folder that cannot be found or used safely/);
  assert.match(await notice.textContent(), /Nothing was changed or deleted/);
  assert.deepEqual(await shownPlans(page, titles), titles, 'All shows every plan, including the unresolved ones');
  const menu = await openFoldersMenu(page);
  const rows = await menu.getByRole('menuitem').allTextContents();
  assert.ok(rows.some(r => r.includes('All Load Plans (4)')));
  assert.ok(rows.some(r => r.includes('Unfiled (1)')));
  assert.ok(rows.some(r => r.includes('Needs attention (2)')));
  assert.ok(rows.some(r => r.includes('Good Folder (1)')));
  assert.ok(!rows.some(r => r.includes('Dup First') || r.includes('Dup Second')),
    'a Folder whose id is shared is not offered as a target');
  await page.keyboard.press('Escape');

  await chooseFolderFilter(page, 'Needs attention (2)');
  assert.deepEqual(await shownPlans(page, titles), ['Plan Ghost', 'Plan Dup']);
  assert.equal(await page.locator('.tp3d-packs-folder-btn__label').textContent(), 'Needs attention');
  await chooseFolderFilter(page, 'Unfiled (1)');
  assert.deepEqual(await shownPlans(page, titles), ['Plan Free'], 'unresolved plans do not hide inside Unfiled');

  // An explicit move resolves one plan; the damaged records are still stored untouched.
  await chooseFolderFilter(page, 'Needs attention (2)');
  await moveShownPlan(page, 'Plan Ghost', 'Unfiled');
  assert.match(await notice.textContent(), /1 load plan points to a Folder/);
  const mid = JSON.parse(await folderSnapshot(page));
  assert.deepEqual(mid.folders.map(f => f[1]), ['Good Folder', 'Dup First', 'Dup Second']);
  assert.equal(mid.packs.find(p => p[0] === 'p-dup')[1], 'f-dup', 'the other plan keeps its stored reference');

  // Explicit repair: confirmed, original kept, nothing lost.
  await page.locator('#packs-folder-notice-repair').click();
  const dialog = page.locator('#modal-root .modal-overlay:not([data-auth-overlay])');
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.textContent(), /A copy of the current Folder data is kept in this browser first/);
  await page.getByRole('button', { name: 'Repair', exact: true }).click();
  await notice.waitFor({ state: 'hidden' });
  const repaired = JSON.parse(await folderSnapshot(page));
  assert.equal(repaired.packs.length, 4, 'no Load Plan is lost');
  assert.deepEqual(repaired.folders.map(f => f[1]).sort(), ['Dup First', 'Dup Second', 'Good Folder']);
  assert.equal(new Set(repaired.folders.map(f => f[0])).size, 3, 'every Folder id is unique again');
  assert.equal(repaired.packs.find(p => p[0] === 'p-dup')[1], 'f-dup', 'the first holder of the shared id keeps its plan');
  assert.deepEqual(await shownPlans(page, titles), titles);
  const evidenceStill = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).folderLibrary.length,
    `${folderWorkspaceKey(ORG_A)}:folder-graph-evidence`);
  assert.equal(evidenceStill, 3, 'the original copy is still there after the repair');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

test('Folder Stage 1 F-04: a refused save never shows success, shows one message, and a retry reports correctly', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: 'f1', name: 'Existing' }],
    packs: [{ id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001' }],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);
  // Isolated test browser only: the workspace payload write is refused the way a full browser store refuses it.
  await page.evaluate(() => {
    window.__tp3dRefuseWrites = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (window.__tp3dRefuseWrites && String(key).includes(':workspace:')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  const toasts = page.locator('.toast');
  // Only toasts about saving or Folders count; the app's own startup "Ready" toast is unrelated.
  const toastTexts = async () => (await toasts.locator('.toast-message').allTextContents())
    .filter(text => /save|Folder/i.test(text));

  await chooseFolderAction(page, 'New Folder');
  await page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]').fill('Retry Me');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await toasts.filter({ hasText: 'Not saved' }).first().waitFor({ state: 'visible' });
  await page.waitForTimeout(700); // beyond the 250 ms autosave debounce: no second, generic failure may follow
  const failed = await toastTexts();
  assert.equal(failed.length, 1, `exactly one message, got: ${JSON.stringify(failed)}`);
  assert.match(failed[0], /Not saved: the new Folder exists only on screen/);
  assert.ok(!failed.some(text => /Folder created|Save failed/.test(text)), 'no success and no contradicting generic failure');
  const unsaved = await page.evaluate(key => localStorage.getItem(key), folderWorkspaceKey(ORG_A));
  assert.ok(!unsaved.includes('Retry Me'), 'the durable copy does not have the Folder');
  assert.ok((await folderSnapshot(page)).includes('Retry Me'), 'the unsaved Folder stays on screen and in memory');

  // Storage recovers; Retry saves the kept state and only now reports success.
  await page.evaluate(() => { window.__tp3dRefuseWrites = false; });
  await toasts.getByRole('button', { name: 'Retry', exact: true }).click();
  await toasts.filter({ hasText: 'Folder created' }).first().waitFor({ state: 'visible' });
  const saved = await page.evaluate(key => localStorage.getItem(key), folderWorkspaceKey(ORG_A));
  assert.ok(saved.includes('Retry Me'), 'the retry reached localStorage');
  await toasts.filter({ hasText: 'Not saved' }).first().waitFor({ state: 'detached' });
  assert.ok(!(await toastTexts()).some(text => /Not saved|Save failed/.test(text)), 'the failure message is gone after the retry');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

async function plainFolderState(page) {
  const snapshot = JSON.parse(await folderSnapshot(page));
  return JSON.stringify({ folders: snapshot.folders, packs: snapshot.packs });
}

async function modalOf(page) {
  const modal = page.locator('#modal-root .modal-overlay:not([data-auth-overlay])');
  await modal.waitFor({ state: 'visible' });
  return modal;
}

test('Folder Stage 1 F-09 and name policy: accessible filter name, keyboard menu, inline validation, no-op rename', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: 'f1', name: 'Client A', sortOrder: 0 }, { id: 'f2', name: 'Other', sortOrder: 100 }],
    packs: [
      { id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001', folderId: 'f1' },
      { id: 'p2', title: 'Plan Two', loadPlanNumber: 'LP-00000002' },
    ],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);
  const button = page.locator('.tp3d-packs-folder-btn');

  // F-09: the accessible name says which filter is on, and aria-expanded follows the menu.
  assert.equal(await button.getAttribute('aria-label'), 'Folders filter. Current: All load plans');
  await chooseFolderFilter(page, 'Client A (1)');
  assert.equal(await button.getAttribute('aria-label'), 'Folders filter. Current: Client A');
  await chooseFolderFilter(page, 'Unfiled (1)');
  assert.equal(await button.getAttribute('aria-label'), 'Folders filter. Current: Unfiled');
  assert.ok((await button.getAttribute('aria-label')).includes(await button.textContent()), 'the visible label is inside the accessible name');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');

  // Keyboard: Enter opens, Escape closes and returns focus, an item chosen from the keyboard filters.
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('[data-dropdown="1"][data-role="packs-folders"]');
  await menu.waitFor({ state: 'visible' });
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.className.includes('tp3d-packs-folder-btn')), true,
    'focus returns to the Folders button');
  await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitem').filter({ hasText: 'All Load Plans' }).focus();
  await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await button.getAttribute('aria-label'), 'Folders filter. Current: All load plans');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');

  // Name policy in the real dialog: the message appears inline and the dialog stays open.
  await chooseFolderAction(page, 'New Folder');
  let dialog = await modalOf(page);
  const input = dialog.locator('input[type="text"]');
  const error = dialog.locator('.tp3d-field-error');
  const before = await plainFolderState(page);
  for (const [typed, expected] of [
    ['', 'Enter a Folder name.'],
    ['   ', 'Enter a Folder name.'],
    ['client a', 'A Folder with this name already exists.'],
    ['x'.repeat(101), 'Folder names can have up to 100 characters.'],
  ]) {
    await input.fill(typed);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await error.waitFor({ state: 'visible' });
    assert.equal((await error.textContent()).trim(), expected);
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.equal(await dialog.count(), 1, 'the dialog stays open');
  }
  assert.equal(await plainFolderState(page), before, 'a refused name writes nothing');
  await input.fill('  Brand <New> Folder  ');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.tp3d-packs-folder-btn__label').textContent(), 'Brand <New> Folder', 'trimmed, stored as typed, shown as text');

  // No-op rename: same name, no history step, no timestamp change, no success claim.
  await chooseFolderAction(page, 'Rename Folder');
  dialog = await modalOf(page);
  const beforeNoop = await folderSnapshot(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await folderSnapshot(page), beforeNoop, 'unchanged name: no write, no history, no updatedAt');
  await page.locator('.toast', { hasText: 'Folder name unchanged' }).first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.toast', { hasText: 'Folder renamed' }).count(), 0);
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

test('Folder Stage 1 Rename and Delete are reachable for every Folder from the Folders menu', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: 'f1', name: 'Client A', sortOrder: 0 }, { id: 'f2', name: 'Other', sortOrder: 100 }],
    packs: [
      { id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001', folderId: 'f2' },
      { id: 'p2', title: 'Plan Two', loadPlanNumber: 'LP-00000002' },
    ],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);

  // No Folder filter is on, yet each Folder can be managed; Unfiled is not listed.
  await chooseFolderAction(page, /Manage Folders/);
  let dialog = await modalOf(page);
  assert.equal(await dialog.getByRole('button', { name: /^Rename Folder / }).count(), 2);
  assert.equal(await dialog.getByRole('button', { name: /^Delete Folder / }).count(), 2);
  assert.ok(!(await dialog.textContent()).includes('Unfiled'), 'Unfiled has no Rename or Delete');

  // Keyboard: focus the Rename button of "Other" and press Enter. The dialog that opens is for that Folder.
  const renameInput = page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]');
  await dialog.getByRole('button', { name: 'Rename Folder Other', exact: true }).focus();
  await page.keyboard.press('Enter');
  await renameInput.waitFor({ state: 'visible' });
  assert.equal(await renameInput.inputValue(), 'Other', 'the target is the Folder whose row was used');
  await renameInput.fill('Other renamed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await renameInput.waitFor({ state: 'detached' });
  assert.deepEqual(JSON.parse(await folderSnapshot(page)).folders.map(f => f[1]), ['Client A', 'Other renamed']);

  // Delete from the same place: the Load Plan in it moves to Unfiled and nothing else is lost.
  await chooseFolderAction(page, /Manage Folders/);
  dialog = await modalOf(page);
  await dialog.getByRole('button', { name: 'Delete Folder Other renamed', exact: true }).click();
  const confirm = page.locator('#modal-root .modal-body', { hasText: 'Delete "Other renamed"?' });
  await confirm.waitFor({ state: 'visible' });
  assert.match(await confirm.textContent(), /Delete "Other renamed"\? 1 load plan\(s\)/);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.toast', { hasText: 'Folder deleted' }).first().waitFor({ state: 'visible' });
  const after = JSON.parse(await folderSnapshot(page));
  assert.deepEqual(after.folders.map(f => f[1]), ['Client A']);
  assert.deepEqual(after.packs.map(p => [p[0], p[1]]), [['p1', null], ['p2', null]], 'both Load Plans remain; the affected one is Unfiled');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

test('Folder Stage 1 F-07: an empty Folder and a no-match search say different things, in Grid and List, with a way back', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: 'f-empty', name: 'Empty Folder', sortOrder: 0 }, { id: 'f-full', name: 'Full Folder', sortOrder: 100 }],
    packs: [
      { id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001', folderId: 'f-full' },
      { id: 'p2', title: 'Plan Two', loadPlanNumber: 'LP-00000002' },
    ],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);
  const empty = page.locator('#packs-filter-empty');
  const titles = ['Plan One', 'Plan Two'];

  for (const view of ['grid', 'list']) {
    await page.locator(`#packs-view-${view}`).click();
    await chooseFolderFilter(page, 'Empty Folder (0)');
    await empty.waitFor({ state: 'visible' });
    assert.equal((await page.locator('#packs-filter-empty-msg').textContent()).trim(), 'This Folder is empty', `${view}: a Folder that holds nothing says so`);
    assert.equal((await page.locator('#packs-filter-empty-clear').textContent()).trim(), 'Show all load plans');
    assert.equal(await empty.isVisible(), true, `${view}: the message is actually on screen`);
    assert.ok((await empty.boundingBox()).height > 0);

    // A search that matches nothing inside a Folder that has plans is a different message.
    await chooseFolderFilter(page, 'Full Folder (1)');
    await page.locator('#packs-search').fill('zzz-nothing');
    await empty.waitFor({ state: 'visible' });
    assert.equal((await page.locator('#packs-filter-empty-msg').textContent()).trim(), 'No matching load plans for "zzz-nothing"');
    assert.equal((await page.locator('#packs-filter-empty-clear').textContent()).trim(), 'Clear filters');

    await page.locator('#packs-filter-empty-clear').click();
    await empty.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#packs-search').inputValue(), '');
    assert.equal(await page.locator('.tp3d-packs-folder-btn__label').textContent(), 'Folders', 'back to All');
    const visible = view === 'grid'
      ? await shownPlans(page, titles)
      : titles.filter(async () => true);
    if (view === 'grid') assert.deepEqual(visible, titles);
    else assert.equal(await page.locator('#packs-tbody tr').count(), 2, 'list: both rows are back');
  }

  // Unfiled with nothing in it.
  await moveShownPlan(page, 'Plan Two', 'Full Folder');
  await chooseFolderFilter(page, 'Unfiled (0)');
  await empty.waitFor({ state: 'visible' });
  assert.equal((await page.locator('#packs-filter-empty-msg').textContent()).trim(), 'No unfiled load plans');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

const undoKey = page => page.keyboard.press('Control+z');
const redoKey = page => page.keyboard.press('Control+Shift+z');

async function createFolderThroughDialog(page, name) {
  await chooseFolderAction(page, 'New Folder');
  const input = page.locator('#modal-root .modal-overlay:not([data-auth-overlay]) input[type="text"]');
  await input.fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await input.waitFor({ state: 'detached' });
}

async function preferencesJson(page) {
  return page.evaluate(async () => (await import('/src/core/state-store.js')).get('preferences') && JSON.stringify((await import('/src/core/state-store.js')).get('preferences')));
}

test('Folder Stage 1 F-08: Load Plans Undo and Redo step through the Folder steps made there, and nothing older', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  await seedFolderWorkspaces(scenario, [[folderWorkspaceKey(ORG_A), folderWorkspacePayload({
    folders: [{ id: 'f0', name: 'Existing' }],
    packs: [
      { id: 'p1', title: 'Plan One', loadPlanNumber: 'LP-00000001', cases: [{ id: 'inst-1', caseId: 'c-1' }] },
      { id: 'p2', title: 'Plan Two', loadPlanNumber: 'LP-00000002' },
    ],
  })]]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);

  // An earlier, unrelated history step (a preference): Load Plans Undo must never reach it.
  await page.locator('#packs-view-list').click();
  await page.locator('#packs-tbody').waitFor({ state: 'visible' });
  await page.locator('#packs-view-grid').click();
  await page.locator('#packs-grid .card').first().waitFor({ state: 'visible' });
  const prefsBefore = await preferencesJson(page);
  const s0 = await plainFolderState(page);

  await createFolderThroughDialog(page, 'First');
  const s1 = await plainFolderState(page);
  await createFolderThroughDialog(page, 'Second');
  const s2 = await plainFolderState(page);
  await chooseFolderFilter(page, 'All Load Plans'); // creating a Folder selected it; the plan to move is under All
  await moveShownPlan(page, 'Plan One', 'First');
  const s3 = await plainFolderState(page);
  assert.notEqual(s3, s2);

  await undoKey(page);
  assert.equal(await plainFolderState(page), s2, 'Undo takes back the move only');
  await undoKey(page);
  assert.equal(await plainFolderState(page), s1, 'then the second Folder');
  await undoKey(page);
  assert.equal(await plainFolderState(page), s0, 'then the first Folder');
  await undoKey(page);
  assert.equal(await plainFolderState(page), s0, 'a further Undo does nothing here');
  assert.equal(await preferencesJson(page), prefsBefore, 'the earlier preference step was not undone');
  const cargo = await page.evaluate(async () => (await import('/src/core/state-store.js')).get('packLibrary').find(p => p.id === 'p1').cases);
  assert.deepEqual(cargo, [{ id: 'inst-1', caseId: 'c-1' }], 'cargo and identities are untouched throughout');

  await redoKey(page);
  assert.equal(await plainFolderState(page), s1);
  await redoKey(page);
  assert.equal(await plainFolderState(page), s2);
  await redoKey(page);
  assert.equal(await plainFolderState(page), s3, 'Redo replays the same steps in order');
  await redoKey(page);
  assert.equal(await plainFolderState(page), s3);
  assert.equal(await preferencesJson(page), prefsBefore);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).folderLibrary.map(f => f.name), folderWorkspaceKey(ORG_A));
  assert.deepEqual(stored, ['Existing', 'First', 'Second'], 'every undone or redone state is also what is saved');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});

test('Folder Stage 1 F-08: Folder history is dropped by anything else, and never crosses screens, inputs or workspaces', async t => {
  const scenario = await harness.createScenario(multiWorkspaceScenario());
  t.after(() => scenario.close());
  const workspace = name => folderWorkspacePayload({
    folders: [{ id: 'f1', name: `${name} One` }],
    packs: [{ id: 'p1', title: `${name} Plan`, loadPlanNumber: 'LP-00000001' }],
  });
  await seedFolderWorkspaces(scenario, [
    [folderWorkspaceKey(ORG_A), workspace('Alpha')],
    [folderWorkspaceKey(ORG_B), workspace('Beta')],
  ]);
  const page = await scenario.openPage();
  await openFolderLibrary(scenario, page);

  // Typing context: Undo inside a text input stays native; the Folder step is still undoable afterwards.
  await createFolderThroughDialog(page, 'Typed Around');
  const afterCreate = await plainFolderState(page);
  await page.locator('#packs-search').focus();
  await undoKey(page);
  assert.equal(await plainFolderState(page), afterCreate, 'Undo in a text field does not touch Folders');
  await page.locator('#packs-search').blur();
  await undoKey(page);
  assert.notEqual(await plainFolderState(page), afterCreate, 'from the page it undoes the Folder step');
  assert.ok(!(await plainFolderState(page)).includes('Typed Around'));

  // Switching screens ends the run.
  await createFolderThroughDialog(page, 'Across Screens');
  const afterSecond = await plainFolderState(page);
  await page.locator('[data-nav="cases"]').click();
  await page.locator('[data-nav="packs"]').click();
  await page.locator('.tp3d-packs-folder-btn').waitFor({ state: 'visible' });
  await undoKey(page);
  assert.equal(await plainFolderState(page), afterSecond, 'after leaving and returning, an older Folder step is not replayed');

  // A different change ends the run too (view mode is a preference step).
  await createFolderThroughDialog(page, 'Then A Preference');
  const afterThird = await plainFolderState(page);
  await page.locator('#packs-view-list').click();
  await undoKey(page);
  assert.equal(await plainFolderState(page), afterThird, 'once something else changed, Load Plans Undo stays out of it');

  // Workspace A -> B -> A: the run belongs to the workspace it was made in.
  await createFolderThroughDialog(page, 'Before Switching');
  const inAlpha = await plainFolderState(page);
  await switchWorkspaceAndWait(page, ORG_B, 'Workspace B');
  await page.locator('.tp3d-packs-folder-btn').waitFor({ state: 'visible' });
  const inBeta = await plainFolderState(page);
  await undoKey(page);
  assert.equal(await plainFolderState(page), inBeta, 'Undo in workspace B does not touch B');
  await switchWorkspaceAndWait(page, ORG_A, 'Workspace A');
  await page.locator('.tp3d-packs-folder-btn').waitFor({ state: 'visible' });
  assert.equal(await plainFolderState(page), inAlpha);
  await undoKey(page);
  assert.equal(await plainFolderState(page), inAlpha, 'A to B to A: the old Folder step is gone');
  assert.deepEqual(scenario.diagnostics.pageErrors, []);
});
