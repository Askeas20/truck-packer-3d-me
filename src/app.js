/**
 * @file app.js
 * @description Main browser entrypoint that bootstraps Truck Packer 3D, wires services/screens, and installs minimal global helpers.
 * @module app
 * @created Unknown
          function closeDropdowns() {
            try {
              UIComponents.closeAllDropdowns && UIComponents.closeAllDropdowns();
            } catch {
              // ignore
            }
          }

          function openSettingsOverlay(tab = 'preferences') {
            closeDropdowns();
            try {
              if (AccountOverlay && typeof AccountOverlay.close === 'function') AccountOverlay.close();
            } catch {
              // ignore
            }
            SettingsOverlay.open(tab);
          }

          function openAccountOverlay() {
            closeDropdowns();
            try {
              if (SettingsOverlay && typeof SettingsOverlay.close === 'function') SettingsOverlay.close();
            } catch {
              // ignore
            }
            AccountOverlay.open();
          }

 * @updated 01/22/2026
 * @author Truck Packer 3D Team
 */

/*
  RUNTIME CORE (v1) - DO NOT MIX WITH LEGACY/V2 MODULES WITHOUT RECONCILING APIS
  - State:    ./core/state-store.js
  - Events:   ./core/events.js
  - Version:  ./core/version.js (APP_VERSION)
  - Storage:  ./core/storage.js (STORAGE_KEY = 'truckPacker3d:v1')
  - Session:  ./core/session.js (SESSION_KEY = 'truckPacker3d:session:v1')
*/

// ============================================================================
// SECTION: IMPORTS AND DEPENDENCIES
// ============================================================================

import { initTP3DDebugger } from './debugger.js';
import { createSystemOverlay } from './ui/system-overlay.js';
import { createErrorOverlay } from './ui/error-overlay.js';
import { Router } from './router.js';
import { createUIComponents } from './ui/ui-components.js';
import { createTruckChangeController } from './ui/truck-change-controller.js';
import { createKeyboardManager } from './ui/keyboard-manager.js';
import { createAppShell } from './ui/app-shell.js';
import { createRecoverableErrorOverlay } from './ui/recoverable-error-overlay.js';
import { createOperationLifecycle } from './core/operation-lifecycle.js';
import { createTableFooter } from './ui/table-footer.js';
import { TrailerPresets } from './data/trailer-presets.js';
import { createSceneRuntime } from './editor/scene-runtime.js';
import { createTrailerGeometry } from './editor/trailer-geometry.js';
import { createMeasurementTool } from './editor/measurement-tool.js';
import { createAnnotationTool } from './editor/annotation-tool.js';
import { createCaseScene, createInteractionManager, createEditorScreen } from './screens/editor-screen.js';
import { createPacksScreen } from './screens/packs-screen.js';
import { createCasesScreen } from './screens/cases-screen.js';
import { createImportExportScreen } from './screens/import-export-screen.js';
import { createUpdatesScreen } from './screens/updates-screen.js';
import { createRoadmapScreen } from './screens/roadmap-screen.js';
import * as CoreUtils from './core/utils/index.js';
import * as BrowserUtils from './core/browser.js';
import * as CoreDefaults from './core/defaults.js';
import * as CoreStateStore from './core/state-store.js';
import * as CoreStorage from './core/storage.js';
import { editorViewSignature, normalizeEditorView } from './core/normalizer.js';
import * as CoreSession from './core/session.js';
import * as CategoryService from './services/category-service.js';
import * as CoreCaseLibrary from './services/case-library.js';
import * as CorePackLibrary from './services/pack-library.js';
import * as ImportExport from './services/import-export.js';
import { createAutoPackEngine } from './services/autopack-engine.js';
import * as CorePreferencesManager from './services/preferences-manager.js';
import { createSettingsOverlay } from './ui/overlays/settings-overlay.js';
import { createAccountOverlay } from './ui/overlays/account-overlay.js';
import { createCardDisplayOverlay } from './ui/overlays/card-display-overlay.js';
import { createHelpModal } from './ui/overlays/help-modal.js';
import { createImportAppDialog } from './ui/overlays/import-app-dialog.js';
import { createImportPackDialog } from './ui/overlays/import-pack-dialog.js';
import { createImportCasesDialog } from './ui/overlays/import-cases-dialog.js';
import { createAppHelpers } from './core/app-helpers.js';
import { applyCanonicalCargoFields } from './core/cargo-canonical.js';
import { installDevHelpers } from './core/dev/dev-helpers.js';
import * as SupabaseClient from './core/supabase-client.js';
import { createAuthOverlay } from './ui/overlays/auth-overlay.js';
import { on, emit } from './core/events.js';
import { APP_VERSION } from './core/version.js';
import {
  fetchBillingStatus,
  createCheckoutSession,
  createPortalSession,
  acceptOrgInvite,
} from './data/services/billing.service.js';
import { createBillingService } from './services/billing-service.js';
import { createOrganizationService } from './services/organization-service.js';
import { createAuthService } from './services/auth-service.js';
import { createAccountSwitcher } from './account-switcher.js';

// ============================================================================
// SECTION: INITIALIZATION
// ============================================================================

initTP3DDebugger();

// ============================================================================
// SECTION: BILLING STATE (edge function)
// ============================================================================

const BILLING_ENTITLEMENT_STATUSES = new Set([
  'active',
  'trialing',
  'trial_expired',
  'included_in_plan',
  'workspace_limit_reached',
  'owner_subscription_required',
  'billing_unavailable',
]);
const BILLING_FOCUS_REFRESH_COOLDOWN_MS = 300000; // 5 minutes — do not spam refresh on every focus
const AUTH_REVOCATION_VISIBLE_CHECK_INTERVAL_MS = 5000;
const AUTH_REVOCATION_MIN_CHECK_GAP_MS = 2000;
let _authRevocationCheckTimer = null;
let _authRevocationCheckInFlight = false;
let _authRevocationCheckLastAt = 0;
let _authRevocationCheckInstalled = false;
const _bootStartedAtMs = Date.now();
const _orgAccessLossLastAt = new Map();
const ORG_ACCESS_LOSS_COOLDOWN_MS = 30000;
function normalizeBillingEntitlementStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  return BILLING_ENTITLEMENT_STATUSES.has(raw) ? raw : null;
}
const _BILLING_SHARED_FRESH_MS = 90000;   // shared result considered fresh for 90s (cross-tab window)
function isTp3dDebugEnabled() {
  try {
    if (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('tp3dDebug') === '1') return true;
  } catch (_) { /* ignore */ }
  try {
    if (typeof URLSearchParams !== 'undefined' && new URLSearchParams(window.location.search).get('tp3dDebug') === '1') return true;
  } catch (_) { /* ignore */ }
  try {
    if (typeof window !== 'undefined' && window.sessionStorage && window.sessionStorage.getItem('tp3dDebug') === '1') return true;
  } catch (_) { /* ignore */ }
  return false;
}

function billingDebugLog(step, details) {
  if (!isTp3dDebugEnabled()) return;
  if (typeof details === 'undefined') {
    console.info('[Billing][App]', step);
    return;
  }
  console.info('[Billing][App]', step, details);
}
function isVisibleAuthRevocationCheckSignedIn() {
  try {
    const authState =
      SupabaseClient && typeof SupabaseClient.getAuthState === 'function' ? SupabaseClient.getAuthState() : null;
    const status = authState && authState.status ? authState.status : 'unknown';
    const session = authState && authState.session ? authState.session : null;
    const user = authState && authState.user ? authState.user : session && session.user ? session.user : null;
    return Boolean(status === 'signed_in' && session && user && user.id);
  } catch {
    return false;
  }
}

function isVisibleAuthRevocationCheckAllowed() {
  try {
    if (typeof document !== 'undefined' && document.hidden) return false;
  } catch {
    // ignore
  }
  return isVisibleAuthRevocationCheckSignedIn();
}

function requestVisibleAuthRevocationCheck(reason = 'interval') {
  if (_authRevocationCheckInFlight) return;
  if (!isVisibleAuthRevocationCheckAllowed()) return;
  if (!SupabaseClient || typeof SupabaseClient.validateSessionRevocation !== 'function') return;
  const now = Date.now();
  if (_authRevocationCheckLastAt && (now - _authRevocationCheckLastAt) < AUTH_REVOCATION_MIN_CHECK_GAP_MS) return;
  _authRevocationCheckLastAt = now;
  _authRevocationCheckInFlight = true;
  void SupabaseClient.validateSessionRevocation({ source: `app-visible:${reason}` })
    .catch(() => { /* ignore */ })
    .finally(() => {
      _authRevocationCheckInFlight = false;
    });
}

function startVisibleAuthRevocationCheck() {
  if (!isVisibleAuthRevocationCheckSignedIn()) return;
  if (_authRevocationCheckTimer) return;
  _authRevocationCheckTimer = window.setInterval(() => {
    requestVisibleAuthRevocationCheck('interval');
  }, AUTH_REVOCATION_VISIBLE_CHECK_INTERVAL_MS);
  requestVisibleAuthRevocationCheck('start');
}

function stopVisibleAuthRevocationCheck() {
  if (_authRevocationCheckTimer) {
    try { window.clearInterval(_authRevocationCheckTimer); } catch { /* ignore */ }
  }
  _authRevocationCheckTimer = null;
  _authRevocationCheckInFlight = false;
  _authRevocationCheckLastAt = 0;
}

function installVisibleAuthRevocationCheck() {
  if (_authRevocationCheckInstalled) return;
  _authRevocationCheckInstalled = true;
  try {
    window.addEventListener('focus', () => {
      requestVisibleAuthRevocationCheck('window-focus');
      startVisibleAuthRevocationCheck();
    }, { passive: true });
  } catch {
    // ignore
  }
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      requestVisibleAuthRevocationCheck('tab-visible');
      startVisibleAuthRevocationCheck();
    }, { passive: true });
  } catch {
    // ignore
  }
}
const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeOrgIdForBilling(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase() === 'personal') return '';
  return ORG_UUID_RE.test(raw) ? raw : '';
}
let _workspaceReadyInflight = false;
/** @type {() => boolean} Module-level accessor, set by IIFE once auth gate is initialized. */
let _authGateIsSettledAccessor = () => false;
/** @type {() => {status:string,userId:string|null,hasToken:boolean,isSignedIn:boolean}|null} */
let _authTruthSnapshotAccessor = () => null;
/** @type {(orgId:string) => 'hydrated'|'inflight'|'unknown'} Module-level accessor for org role hydration state */
let _getOrgRoleHydrationStateAccessor = () => 'unknown';
async function ensureWorkspaceReadyForUI({ timeoutMs = 2500, pollMs = 80, forceFirst = true } = {}) {
  try {
    const mod = await import('./core/supabase-client.js');
    const start = Date.now();
    const authTruth = typeof _authTruthSnapshotAccessor === 'function' ? _authTruthSnapshotAccessor() : null;
    if (authTruth && authTruth.status === 'signed_out' && _authGateIsSettledAccessor()) {
      return { ok: false, reason: 'signed-out' };
    }

    // Optional: first try with force=true to prime caches quickly
    if (forceFirst) {
      try {
        const b0 = await mod.getAccountBundleSingleFlight({ force: true });
        const active0 = b0 && b0.activeOrgId ? String(b0.activeOrgId) : null;
        const orgCount0 = b0 && Number.isFinite(b0.orgCount) ? b0.orgCount : (b0 && b0.orgs ? b0.orgs.length : 0);
        if (active0) return { ok: true, activeOrgId: active0, orgCount: orgCount0, bundle: b0, source: 'force-first' };
        // Only return no-org when bundle is definitive (non-null) AND auth is settled.
        // A null bundle means "couldn't fetch" — NOT "user has no org."
        if (b0 && !b0.partial && orgCount0 === 0 && _authGateIsSettledAccessor()) {
          return { ok: false, reason: 'no-org', orgCount: 0, bundle: b0, source: 'force-first' };
        }
        // Auth not settled OR bundle null → do NOT return no-org yet, fall through to polling
        if (orgCount0 === 0) {
          if (typeof isTp3dDebugEnabled === 'function' && isTp3dDebugEnabled()) {
            console.info('[workspaceReady] defer-no-org:auth-not-settled (force-first)', {
              bundle: b0 ? 'present' : 'null', settled: _authGateIsSettledAccessor(),
            });
          }
        }
      } catch {
        // ignore and fall through to polling
      }
    }

    while (Date.now() - start < timeoutMs) {
      const b = await mod.getAccountBundleSingleFlight({ force: false });
      const loopAuthTruth = typeof _authTruthSnapshotAccessor === 'function' ? _authTruthSnapshotAccessor() : null;
      if (loopAuthTruth && loopAuthTruth.status === 'signed_out' && _authGateIsSettledAccessor()) {
        return { ok: false, reason: 'signed-out' };
      }
      const activeOrgId = b && b.activeOrgId ? String(b.activeOrgId) : null;
      const orgCount = b && Number.isFinite(b.orgCount) ? b.orgCount : (b && b.orgs ? b.orgs.length : 0);

      if (activeOrgId) return { ok: true, activeOrgId, orgCount, bundle: b, source: 'poll' };
      // Only return no-org when bundle is definitive (non-null) AND auth is settled.
      if (b && !b.partial && orgCount === 0 && _authGateIsSettledAccessor()) {
        return { ok: false, reason: 'no-org', orgCount: 0, bundle: b, source: 'poll' };
      }
      if (orgCount === 0) {
        if (typeof isTp3dDebugEnabled === 'function' && isTp3dDebugEnabled()) {
          console.info('[workspaceReady] defer-no-org:auth-not-settled (poll)', {
            bundle: b ? 'present' : 'null', settled: _authGateIsSettledAccessor(),
          });
        }
      }

      await new Promise(r => setTimeout(r, pollMs));
    }

    return { ok: false, reason: 'timeout' };
  } catch (e) {
    return { ok: false, reason: 'error', error: e };
  }
}

// Billing domain (Stage 1 extraction from the former inline billing region).
// Constructed here — before the facade and the IIFE — so the cross-tab channel and
// storage listeners keep their module-eval timing and every injected dependency
// (defined above) is in scope. Root/IIFE orchestration calls BillingService.* .
const BillingService = createBillingService({
  SupabaseClient,
  fetchBillingStatus,
  createCheckoutSession,
  createPortalSession,
  isTp3dDebugEnabled,
  normalizeOrgIdForBilling,
  normalizeBillingEntitlementStatus,
  billingDebugLog,
  ORG_UUID_RE,
  bootStartedAtMs: _bootStartedAtMs,
  BILLING_SHARED_FRESH_MS: _BILLING_SHARED_FRESH_MS,
});

// Expose for settings overlay and dev console
try {
  window.__TP3D_BILLING = {
    getBillingState: BillingService.getBillingState,
    subscribeBilling: BillingService.subscribeBilling,
    refreshBilling: BillingService.refreshBilling,
    clearBillingState: BillingService.clearBillingState,
    canUseProFeatures: BillingService.canUseProFeatures,
    getProRuleSet: BillingService.getProRuleSet,
    getCheckoutPlanOptions: BillingService.getCheckoutPlanOptions,
    startCheckout: BillingService.startCheckout,
    openPortal: BillingService.openPortal,
    selfTest: () => {
      if (!isTp3dDebugEnabled()) {
        return { ok: false, error: 'Enable tp3dDebug=1 to use billing self-test.' };
      }
      const snapshot = BillingService.getBillingState();
      const activeOrganizationId = BillingService.getActiveOrgIdForBilling() || null;
      const proAllowed = BillingService.canUseProFeatures(snapshot);
      const payload = {
        ok: true,
        activeOrganizationId,
        entitlementStatus: snapshot.entitlementStatus || null,
        workspaceIncluded: snapshot.workspaceIncluded === true,
        workspaceCount: snapshot.workspaceCount,
        workspaceLimit: snapshot.workspaceLimit,
        canManageBilling: snapshot.canManageBilling,
        billingSnapshot: snapshot,
        proAllowed,
      };
      console.info('[Billing][SelfTest]', payload);
      return payload;
    },
  };
} catch (_) { /* ignore */ }

// tp3dDebug-only: expose getBillingState on window for console diagnostics
try {
  if (isTp3dDebugEnabled()) {
    window['getBillingState'] = () => (window.__TP3D_BILLING && typeof window.__TP3D_BILLING.getBillingState === 'function')
      ? window.__TP3D_BILLING.getBillingState()
      : null;
  }
} catch (_) { /* ignore */ }

const PREVIEW_RENDER_VERSION = 2;

/**
 * Coalesce automatic Pack preview requests without retaining workspace or Pack
 * objects across the debounce window.
 *
 * @param {{
 *   StateStore: { get: (key: string) => any },
 *   PackLibrary: { getById: (packId: string) => any },
 *   OperationLifecycle: { isBusy: () => boolean, subscribe: (fn: (state: { busy: boolean }) => void) => (() => void) },
 *   capturePackPreview: (packId: string, options: { source: string, quiet: boolean }) => (boolean | Promise<boolean>),
 *   getActiveWorkspaceKey: () => string,
 *   getVisualSignature: (pack: any) => string,
 *   getViewSignature: (pack: any) => string | null,
 *   delayMs?: number,
 *   setTimer?: (fn: () => void, delay: number) => any,
 *   clearTimer?: (timer: any) => void,
 * }} dependencies
 */
function createPackPreviewScheduler({
  StateStore,
  PackLibrary,
  OperationLifecycle,
  capturePackPreview,
  getActiveWorkspaceKey,
  getVisualSignature,
  getViewSignature,
  delayMs = 300,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
}) {
  /** @type {{ packId: string, workspaceKey: string } | null} */
  let pending = null;
  let debounceTimer = null;
  let captureInFlight = false;

  function clearPending() {
    if (debounceTimer !== null) clearTimer(debounceTimer);
    debounceTimer = null;
    pending = null;
  }

  function resolveCurrentCandidate() {
    if (StateStore.get('currentScreen') !== 'editor') return null;
    const packId = StateStore.get('currentPackId');
    if (!packId) return null;
    const pack = PackLibrary.getById(packId);
    if (!pack) return null;
    // Unknown empty Packs without an image need neither a readback nor a write.
    if (!pack.cases?.length && !pack.thumbnail) return null;
    const viewSignature = getViewSignature(pack);
    if (!viewSignature) return null;
    if (pack.thumbnailVisualSignature === getVisualSignature(pack) &&
        pack.thumbnailViewSignature === viewSignature &&
        (!pack.thumbnail || pack.thumbnailRenderVersion === PREVIEW_RENDER_VERSION)) return null;
    return { packId, workspaceKey: String(getActiveWorkspaceKey()) };
  }

  function runPending() {
    if (!pending || captureInFlight) return false;
    const candidate = resolveCurrentCandidate();
    if (
      !candidate ||
      candidate.packId !== pending.packId ||
      candidate.workspaceKey !== pending.workspaceKey
    ) {
      clearPending();
      return false;
    }
    if (OperationLifecycle.isBusy()) return false;

    pending = null;
    captureInFlight = true;
    Promise.resolve(capturePackPreview(candidate.packId, { source: 'auto', quiet: true }))
      .catch(() => false)
      .finally(() => {
        captureInFlight = false;
        if (pending && debounceTimer === null && !OperationLifecycle.isBusy()) runPending();
      });
    return true;
  }

  function schedule() {
    const candidate = resolveCurrentCandidate();
    if (!candidate) {
      clearPending();
      return false;
    }
    if (debounceTimer !== null) clearTimer(debounceTimer);
    pending = candidate;
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      runPending();
    }, delayMs);
    return true;
  }

  const unsubscribe = OperationLifecycle.subscribe(state => {
    if (!state.busy && pending && debounceTimer === null && !captureInFlight) runPending();
  });

  function dispose() {
    clearPending();
    unsubscribe();
  }

  return { schedule, dispose };
}

const TP3D_BUILD_STAMP = Object.freeze({
  gitCommitShort: '52aa4de',
  buildTimeISO: '2026-02-18T03:32:00Z',
});

(async function () {
  async function ensureThreeRuntimeReady() {
    const failureMessage =
      'Cargo Planner could not load its 3D rendering runtime. Start the application through the supported npm/Vite development or production build and reload.';
    try {
      const bootState = window.__TP3D_BOOT;
      const readinessResult = bootState && bootState.threeReady ? await bootState.threeReady : false;
      if (readinessResult !== true || !window.THREE || !window.THREE.OrbitControls) {
        throw new Error(failureMessage);
      }
      return true;
    } catch (error) {
      console.error(`[TruckPackerApp] ${failureMessage}`, error);
      const bootState = window.__TP3D_BOOT;
      if (bootState && typeof bootState.showAppStatusOverlay === 'function') {
        bootState.showAppStatusOverlay('fatal', { message: failureMessage });
      }
      return false;
    }
  }

  if (!(await ensureThreeRuntimeReady())) return;

  const UIComponents = createUIComponents();
  try { window.__TP3D_UI = UIComponents; } catch (_) { /* ignore */ }
  const SystemOverlay = createSystemOverlay({ UIComponents });
  const ErrorOverlay = createErrorOverlay({ UIComponents });
  const BootState = (() => {
    window.__TP3D_BOOT = window.__TP3D_BOOT || {};
    return window.__TP3D_BOOT;
  })();

  BootState.onAppStatusOverlayShown = ErrorOverlay.registerPresence;
  if (BootState.fatalOverlayShown || BootState.maintenanceMode) ErrorOverlay.registerPresence();

  function markAppReady() {
    try {
      BootState.appReady = true;
    } catch (_) {
      // ignore
    }
  }

  function showFatalOverlay(opts = {}) {
    /** @type {{ message?: string } | null} */
    const config = opts && typeof opts === 'object' ? opts : null;
    const message = config && typeof config.message === 'string' ? config.message : '';
    if (BootState.maintenanceMode) return;
    BootState.fatalOverlayShown = true;
    ErrorOverlay.showFatal({ message });
  }

  function isResourceLoadErrorEvent(ev) {
    const target = ev && ev.target ? ev.target : null;
    const tagName =
      target && typeof target.tagName === 'string'
        ? String(target.tagName).toUpperCase()
        : '';
    return Boolean(
      target &&
      target !== window &&
      (tagName === 'SCRIPT' ||
        tagName === 'LINK' ||
        tagName === 'IMG' ||
        tagName === 'IMAGE' ||
        tagName === 'VIDEO' ||
        tagName === 'AUDIO' ||
        tagName === 'SOURCE')
    );
  }

  function normalizeFatalMessage(value) {
    let message = '';
    if (typeof value === 'string') {
      message = value;
    } else if (value instanceof Error) {
      message = typeof value.message === 'string' ? value.message : '';
    } else if (value && typeof value === 'object') {
      const isEventLike =
        'isTrusted' in value &&
        (typeof value.type === 'string' || 'target' in value || 'currentTarget' in value);
      if (isEventLike) {
        message = '';
      } else if (typeof value.message === 'string') {
        message = value.message;
      } else {
        try {
          const json = JSON.stringify(value);
          if (json && json !== '{}') message = json;
        } catch (_) {
          message = '';
        }
      }
    } else if (value != null) {
      message = String(value);
    }
    message = String(message || '').trim();
    if (!message) return '';
    return message.length > 240 ? `${message.slice(0, 239)}…` : message;
  }

  let _postBootRejectionToastAt = 0;

  function installRuntimeFatalHandlers() {
    if (BootState.runtimeFatalHandlersInstalled) return;
    BootState.runtimeFatalHandlersInstalled = true;

    const handleRuntimeError = ev => {
      if (isResourceLoadErrorEvent(ev)) return;
      const underlyingError =
        ev && typeof ev === 'object' && 'error' in ev && ev.error
          ? ev.error
          : ev && typeof ev === 'object' && 'message' in ev
            ? ev.message
            : ev;
      const message = normalizeFatalMessage(underlyingError);
      console.error('[TruckPackerApp] runtime fatal error:', underlyingError || ev);
      if (BootState.fatalOverlayShown || BootState.maintenanceMode) return;
      showFatalOverlay({ message });
    };

    const handleRuntimeUnhandledRejection = ev => {
      const reason =
        ev && typeof ev === 'object' && 'reason' in ev
          ? ev.reason
          : ev;
      const message = normalizeFatalMessage(reason);
      console.error('[TruckPackerApp] runtime unhandled rejection:', reason);
      if (BootState.appReady === true && ev && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
      if (BootState.fatalOverlayShown || BootState.maintenanceMode) return;
      if (BootState.appReady === true) {
        const isAbortLike = reason instanceof DOMException && reason.name === 'AbortError';
        if (!isAbortLike) {
          const _now = Date.now();
          if (_now - _postBootRejectionToastAt > 8000) {
            _postBootRejectionToastAt = _now;
            try {
              if (UIComponents && typeof UIComponents.showToast === 'function') {
                UIComponents.showToast(
                  'Something went wrong in the background. If the app feels stuck, reload and try again.',
                  'warning',
                  { title: 'Error', duration: 8000 },
                );
              }
            } catch (_) { /* toast must not throw from error handler */ }
          }
        }
        return;
      }
      showFatalOverlay({ message });
    };

    window.addEventListener('error', handleRuntimeError, true);
    window.addEventListener('unhandledrejection', handleRuntimeUnhandledRejection);
  }

  installRuntimeFatalHandlers();

  // ============================================================================
  // SECTION: APP BOOTSTRAP ENTRY
  // ============================================================================
  console.info('[TruckPackerApp] threeReady resolved, bootstrapping app');
  try {
    const debugBuild =
      typeof window !== 'undefined' &&
      window.localStorage &&
      window.localStorage.getItem('tp3dDebug') === '1';
    if (debugBuild && !window.__TP3D_BUILD_STAMP_LOGGED__) {
      window.__TP3D_BUILD_STAMP_LOGGED__ = true;
      console.info('[TP3D BUILD]', TP3D_BUILD_STAMP);
    }
  } catch (_) {
    // ignore
  }

  window.TruckPackerApp = (function () {
    'use strict';

    const featureFlags = { trailerPresetsEnabled: true };
    let AccountSwitcher = null;
    let CasesUI = null;
    let PacksUI = null;
    let ImportExportUI = null;
    let SceneManager = null;
    let ExportService = null;
    let EditorUI = null;
    let bootstrapAuthGate = null;

    // ============================================================================
    // SECTION: FOUNDATION / UTILS
    // ============================================================================
    const Utils = (() => {
      function cssHexToInt(hex) {
        const s = String(hex || '').trim();
        const m = s.match(/^#([0-9a-f]{6})$/i);
        if (!m) return 0x000000;
        return parseInt(m[1], 16);
      }

      return {
        APP_VERSION,
        ...CoreUtils,
        ...BrowserUtils,
        cssHexToInt,
      };
    })();

    // ============================================================================
    // SECTION: STATE STORE (UNDO/REDO)
    // ============================================================================
    const StateStore = {
      init: CoreStateStore.init,
      get: CoreStateStore.get,
      set: CoreStateStore.set,
      replace: CoreStateStore.replace,
      snapshot: CoreStateStore.snapshot,
      resetHistory: CoreStateStore.resetHistory,
      undo: CoreStateStore.undo,
      redo: CoreStateStore.redo,
      subscribe: CoreStateStore.subscribe,
    };

    function toAscii(msg) {
      return String(msg || '')
        .replace(/[^\x20-\x7E]+/g, '')
        .trim();
    }

    const rawShowToast = UIComponents.showToast.bind(UIComponents);

    function toast(message, variant, options) {
      const safeMessage = toAscii(message);
      let safeOptions = options;
      if (options && typeof options === 'object') {
        safeOptions = { ...options };
        if (safeOptions.title) safeOptions.title = toAscii(safeOptions.title);
        if (Array.isArray(safeOptions.actions)) {
          safeOptions.actions = safeOptions.actions.map(a => ({
            ...a,
            label: toAscii(a && a.label),
          }));
        }
      }
      rawShowToast(safeMessage, variant, safeOptions);
    }

    UIComponents.showToast = toast;

    on('app:error', p => {
      const msg = p && typeof p === 'object' ? p.message : '';
      toast('Error: ' + toAscii(msg), 'error', { title: 'App' });
    });

    on('theme:apply', p => {
      const theme = p && p.theme === 'dark' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', theme);
    });

    const Storage = CoreStorage;
    on('storage:save_error', p => {
      toast('Save failed: ' + toAscii(p && p.message), 'error', { title: 'Storage' });
    });
    on('storage:load_error', p => {
      toast('Load failed: ' + toAscii(p && p.message), 'error', { title: 'Storage' });
    });
    // ============================================================================
    // SECTION: SESSION (LOCALSTORAGE)
    // ============================================================================
    const SessionManager = {
      get: CoreSession.get,
      clear: CoreSession.clear,
      subscribe: CoreSession.subscribe,
    };

    // ============================================================================
    // SECTION: DEFAULTS / PREFERENCES
    // ============================================================================
    const Defaults = CoreDefaults;
    const PreferencesManager = CorePreferencesManager;

    const Helpers = createAppHelpers({
      APP_VERSION,
      emit,
      getState: StateStore.get,
      getSession: SessionManager.get,
      isDev: Boolean(
        window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ),
    });
    Helpers.installGlobals();

    // ============================================================================
    // SECTION: DEBUG GLOBALS (opt-in via localStorage.tp3dDebug = "1")
    // ============================================================================

    (function installWrapperDetective() {
      let enabled;
      try {
        enabled = Boolean(window && window.localStorage && window.localStorage.getItem('tp3dDebug') === '1');
      } catch {
        enabled = false;
      }
      if (!enabled) return;

      // Avoid re-installing
      if (
        globalThis.__TP3D_WRAPPER_DETECTIVE__ &&
        typeof globalThis.__TP3D_WRAPPER_DETECTIVE__.getWrapperUsage === 'function'
      ) {
        return;
      }

      function safeFnInfo(fn) {
        if (typeof fn !== 'function') return null;
        const name = fn.name || '(anonymous)';
        const src = Function.prototype.toString.call(fn);
        return {
          name,
          length: fn.length,
          // Keep this short to avoid dumping large source into the console
          snippet: String(src).slice(0, 180),
          looksWrapped:
            String(src).includes('getSessionRawSingleFlight') ||
            String(src).includes('getUserRawSingleFlight') ||
            String(src).includes('signOut(options') ||
            String(src).includes('getSession timeout') ||
            String(src).includes('[SupabaseClient]'),
        };
      }

      function getSupabaseClient() {
        try {
          if (globalThis.__TP3D_SUPABASE_CLIENT) return globalThis.__TP3D_SUPABASE_CLIENT;
        } catch {
          // ignore
        }
        try {
          if (SupabaseClient && typeof SupabaseClient.getClient === 'function') return SupabaseClient.getClient();
        } catch {
          // ignore
        }
        return null;
      }

      globalThis.__TP3D_WRAPPER_DETECTIVE__ = {
        getWrapperUsage() {
          const client = getSupabaseClient();
          const auth = client && client.auth ? client.auth : null;

          const out = {
            hasClient: Boolean(client),
            hasAuth: Boolean(auth),
            authWrappedFlag: Boolean(client && client.__tp3dAuthWrapped),
            clientKeys: client ? Object.keys(client).slice(0, 30) : [],
            authKeys: auth ? Object.keys(auth).slice(0, 30) : [],
            getSession: auth ? safeFnInfo(auth.getSession) : null,
            getUser: auth ? safeFnInfo(auth.getUser) : null,
            signOut: auth ? safeFnInfo(auth.signOut) : null,
            signInWithPassword: auth ? safeFnInfo(auth.signInWithPassword) : null,
          };

          try {
            console.groupCollapsed('[TP3D] Wrapper detective');
            console.log(out);
            console.groupEnd();
          } catch {
            // ignore
          }

          return out;
        },

        // Quick health check for auth wrapper wiring
        async smokeTest({ timeoutMs = 2500 } = {}) {
          const client = getSupabaseClient();
          if (!client || !client.auth) return { ok: false, reason: 'no-client' };

          const startedAt = Date.now();
          const withTimeout = (p, ms) =>
            Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

          try {
            const r1 = await withTimeout(client.auth.getSession(), timeoutMs);
            const r2 = await withTimeout(client.auth.getUser(), timeoutMs);
            return {
              ok: true,
              ms: Date.now() - startedAt,
              hasSession: Boolean(r1 && r1.data && r1.data.session),
              hasUser: Boolean(r2 && r2.data && r2.data.user),
            };
          } catch (err) {
            return { ok: false, ms: Date.now() - startedAt, error: String(err && err.message ? err.message : err) };
          }
        },
      };

      try {
        console.info('[TP3D] __TP3D_WRAPPER_DETECTIVE__ installed (tp3dDebug=1)');
      } catch {
        // ignore
      }
    })();

    // ============================================================================
    // SECTION: OVERLAYS (SETTINGS + CARD DISPLAY)
    // ============================================================================
    const SettingsOverlay = createSettingsOverlay({
      documentRef: document,
      UIComponents,
      SessionManager,
      PreferencesManager,
      Defaults,
      Utils,
      getSceneManager: () => SceneManager,
      getCurrentCameraPack: () => EditorUI?.getCurrentCameraPack(),
      applyCameraProjectionToPack: (packId, projection) => EditorUI?.applyCameraProjection(projection, packId),
      getAccountSwitcher: () => AccountSwitcher,
      SupabaseClient,
      onExportApp: openExportAppModal,
      onExportWorkspace: openExportWorkspaceModal,
      onImportApp: openImportAppDialog,
      pauseAutoSaveForAppRestore,
      onHelp: openHelpModal,
      onUpdates: openUpdatesScreen,
      onRoadmap: openRoadmapScreen,
    });
    const AccountOverlay = createAccountOverlay({
      documentRef: document,
      SupabaseClient,
      UIComponents,
    });
    const CardDisplayOverlay = createCardDisplayOverlay({
      documentRef: document,
      UIComponents,
      PreferencesManager,
      Defaults,
      Utils,
      getCasesUI: () => CasesUI,
      getPacksUI: () => PacksUI,
    });
    const AuthOverlay = createAuthOverlay({ UIComponents, SupabaseClient, tp3dDebugKey: 'tp3dDebug' });

    let logoutActionPromise = null;
    let logoutInProgress = false;
    let logoutStartedAt = 0;
    let signedOutFinalized = false;
    let signedOutFinalizationInFlight = false;
    let applyPostLogoutLocalStateReset = () => {
      SessionManager.clear();
      StateStore.set({ currentScreen: 'packs' }, { skipHistory: true });
    };

    function isLogoutInProgress() {
      return logoutInProgress;
    }

    function setLogoutInProgress(next, { source = 'unknown', reason = '' } = {}) {
      const active = Boolean(next);
      if (logoutInProgress === active) return;
      logoutInProgress = active;
      logoutStartedAt = active ? Date.now() : 0;
      if (isTp3dDebugEnabled()) {
        console.info('[authLogout] latch', { active, source, reason, startedAt: logoutStartedAt || null });
      }
    }

    function finalizeSignedOutLocally({
      source = 'auth',
      event = 'SIGNED_OUT',
      treatAsSignedOut = true,
      userInitiatedSignOut = false,
      onRetry = bootstrapAuthGate,
    } = {}) {
      if (signedOutFinalized || signedOutFinalizationInFlight) {
        if (signedOutFinalized && isLogoutInProgress()) {
          setLogoutInProgress(false, { source, reason: 'signed-out-already-finalized' });
        }
        return false;
      }
      signedOutFinalizationInFlight = true;
      try {
        applyPostLogoutLocalStateReset();
        _executeSignedOutCleanup({
          event,
          treatAsSignedOut,
          userInitiatedSignOut: Boolean(userInitiatedSignOut),
          onRetry,
        });
        signedOutFinalized = true;
      } finally {
        signedOutFinalizationInFlight = false;
        if (isLogoutInProgress()) {
          setLogoutInProgress(false, { source, reason: 'signed-out-finalized' });
        }
      }
      return true;
    }

    async function performUserInitiatedLogout({ source = 'logout' } = {}) {
      if (logoutActionPromise) return logoutActionPromise;
      logoutActionPromise = (async () => {
        signedOutFinalized = false;
        setLogoutInProgress(true, { source, reason: 'start' });
        try {
          UIComponents.closeAllDropdowns();
          SettingsOverlay.close();
          AccountOverlay.close();
        } catch {
          // ignore
        }

        try {
          if (SupabaseClient && typeof SupabaseClient.signOut === 'function') {
            if (SupabaseClient.setAuthIntent) SupabaseClient.setAuthIntent('signOut');
            const result = await SupabaseClient.signOut({ global: true, allowOffline: true, userInitiated: true });
            if (isTp3dDebugEnabled()) {
              console.info('[authLogout] signOut:completed', {
                source,
                ok: Boolean(result && result.ok),
                offline: Boolean(result && result.offline),
              });
            }
          }
        } catch (err) {
          if (isTp3dDebugEnabled()) {
            console.info('[authLogout] signOut:error', {
              source,
              message: err && err.message ? String(err.message) : String(err),
            });
          }
        }

        finalizeSignedOutLocally({ source, userInitiatedSignOut: true });
      })().finally(() => {
        logoutActionPromise = null;
      });
      return logoutActionPromise;
    }

    // Listen for auth signed-out events (including offline logout and cross-tab)
    window.addEventListener('tp3d:auth-signed-out', event => {
      const detail = /** @type {CustomEvent} */ (event).detail || {};
      const isCrossTab = detail.crossTab === true;

      if (window.localStorage && window.localStorage.getItem('tp3dDebug') === '1') {
        console.log('[TruckPackerApp] Auth signed out', {
          tab: SupabaseClient && typeof SupabaseClient.getTabId === 'function' ? SupabaseClient.getTabId() : null,
          crossTab: isCrossTab,
          source: detail.source,
          offline: detail.offline,
        });
      }

      const userInitiatedSignOut = isLogoutInProgress();
      finalizeSignedOutLocally({
        source: 'tp3d:auth-signed-out',
        userInitiatedSignOut,
      });
    });

    // Show small toasts on connectivity changes to improve UX
    try {
      window.addEventListener(
        'online',
        () => {
          try {
            UIComponents.showToast('Back online', 'info');
          } catch {
            // ignore
          }
        },
        { passive: true }
      );

      window.addEventListener(
        'offline',
        () => {
          try {
            UIComponents.showToast('You are offline', 'warning');
          } catch {
            // ignore
          }
        },
        { passive: true }
      );
    } catch {
      // ignore
    }

    // Persistent offline indicator — small non-blocking chip shown while navigator.onLine === false
    try {
      (function () {
        const _offlineEl = document.createElement('div');
        _offlineEl.id = 'tp3d-offline-indicator';
        _offlineEl.setAttribute('role', 'status');
        _offlineEl.setAttribute('aria-live', 'polite');
        _offlineEl.innerHTML = '<i class="fa-solid fa-wifi tp3d-offline-icon" aria-hidden="true"></i> You\'re Offline';
        document.body.appendChild(_offlineEl);

        function _syncOfflineIndicator() {
          try {
            const _isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
            _offlineEl.classList.toggle('active', _isOffline);
          } catch { /* ignore */ }
        }

        _syncOfflineIndicator(); // sync on boot
        window.addEventListener('online', _syncOfflineIndicator, { passive: true });
        window.addEventListener('offline', _syncOfflineIndicator, { passive: true });
      })();
    } catch {
      // ignore
    }

    const HelpModal = createHelpModal({ UIComponents });
    const ImportAppDialog = createImportAppDialog({
      documentRef: document,
      UIComponents,
      ImportExport,
      StateStore,
      Storage,
      pauseAutoSaveForAppRestore,
      PreferencesManager,
      applyCaseDefaultColor,
      Utils,
    });

    function closeDropdowns() {
      try {
        UIComponents.closeAllDropdowns && UIComponents.closeAllDropdowns();
      } catch {
        // ignore
      }
    }

    function openSettingsOverlay(tab) {
      closeDropdowns();
      try {
        if (AccountOverlay && typeof AccountOverlay.close === 'function') AccountOverlay.close();
      } catch {
        // ignore
      }
      try {
        SettingsOverlay.open(tab);
      } catch {
        // ignore
      }
      requestAuthRefresh('settings-open');
    }

    function syncWorkspaceUiAfterOrgRefresh(source = 'workspace-refresh') {
      ImportExportUI?.syncWorkspace();
      try {
        if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
          AccountSwitcher.refresh();
        }
      } catch {
        // ignore
      }
      try {
        if (SettingsOverlay && typeof SettingsOverlay.isOpen === 'function' && SettingsOverlay.isOpen()) {
          if (typeof SettingsOverlay.requestRefreshAccountUI === 'function') {
            SettingsOverlay.requestRefreshAccountUI(source);
          } else if (typeof SettingsOverlay.render === 'function') {
            SettingsOverlay.render({ source });
          }
        }
      } catch {
        // ignore
      }
    }

    function getWorkspaceCreationLimitBlock() {
      let snapshot;
      try {
        snapshot = (window.__TP3D_BILLING && typeof window.__TP3D_BILLING.getBillingState === 'function')
          ? window.__TP3D_BILLING.getBillingState()
          : BillingService.getBillingState();
      } catch {
        snapshot = BillingService.getBillingState();
      }
      if (!snapshot || snapshot.ok !== true || snapshot.loading || snapshot.pending) return null;

      const activeOrgId = BillingService.getActiveOrgIdForBilling();
      const billingOrgId = snapshot.orgId ? String(snapshot.orgId) : '';
      if (activeOrgId && billingOrgId && String(activeOrgId) !== billingOrgId) return null;

      const workspaceCount = Number(snapshot.workspaceCount);
      const workspaceLimit = Number(snapshot.workspaceLimit);
      if (!Number.isFinite(workspaceCount) || !Number.isFinite(workspaceLimit)) return null;
      if (workspaceLimit <= 0 || workspaceCount < workspaceLimit) return null;

      const canManageBilling = snapshot.canManageBilling === true;
      return {
        canManageBilling,
        portalAvailable: snapshot.portalAvailable === true,
        message: canManageBilling
          ? `Workspace limit reached. Your current plan includes ${workspaceLimit} workspaces. Upgrade your plan or free a workspace slot before creating another workspace.`
          : `Workspace limit reached. This owner's plan includes ${workspaceLimit} workspaces. Ask the workspace owner to upgrade or free a workspace slot before creating another workspace.`,
      };
    }

    function showWorkspaceCreationLimitBlock(block) {
      if (!block) return;
      const content = document.createElement('div');
      content.className = 'grid';

      const messageEl = document.createElement('div');
      messageEl.className = 'muted';
      messageEl.textContent = block.message;
      content.appendChild(messageEl);

      const actions = [{ label: 'Close', variant: 'ghost' }];
      if (block.canManageBilling) {
        actions.push({
          label: block.portalAvailable ? 'Manage Billing' : 'Open Billing',
          variant: 'primary',
          onClick: () => {
            if (block.portalAvailable) {
              BillingService.openPortal().then(result => {
                if (!result || !result.ok) {
                  UIComponents.showToast(
                    result && result.error ? result.error : 'Portal session failed',
                    'error',
                    { title: 'Billing' },
                  );
                }
              }).catch(() => {
                UIComponents.showToast('Portal session failed', 'error', { title: 'Billing' });
              });
              return false;
            }
            openSettingsOverlay('billing');
            return true;
          },
        });
      }

      UIComponents.showModal({
        title: 'Workspace Limit Reached',
        content,
        actions,
      });
    }

    function openCreateWorkspaceFlow({ source = 'workspace-create' } = {}) {
      closeDropdowns();

      const initialLimitBlock = getWorkspaceCreationLimitBlock();
      if (initialLimitBlock) {
        showWorkspaceCreationLimitBlock(initialLimitBlock);
        return;
      }

      const content = document.createElement('div');
      content.className = 'grid';

      const intro = document.createElement('div');
      intro.className = 'muted';
      intro.textContent = 'Create a workspace to organize load plans, cases, and billing for that workspace.';

      const nameLabel = document.createElement('label');
      nameLabel.className = 'muted';
      nameLabel.textContent = 'Workspace name';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'input';
      nameInput.placeholder = 'Enter workspace name';
      nameInput.autocomplete = 'organization';
      nameInput.maxLength = 120;

      const errorEl = document.createElement('div');
      errorEl.className = 'muted';
      errorEl.textContent = '';

      content.appendChild(intro);
      content.appendChild(nameLabel);
      content.appendChild(nameInput);
      content.appendChild(errorEl);

      let modalRef = null;

      const setBusy = busy => {
        const createBtn = modalRef && modalRef.overlay
          ? modalRef.overlay.querySelector('.modal-footer button.btn-primary')
          : null;
        if (createBtn) {
          createBtn.disabled = busy;
          createBtn.textContent = busy ? 'Creating…' : 'Create Workspace';
        }
        nameInput.disabled = busy;
      };

      const readName = () => String(nameInput.value || '').trim();
      const validate = () => {
        const name = readName();
        if (!name) {
          errorEl.textContent = 'Workspace name is required.';
          return '';
        }
        errorEl.textContent = '';
        return name;
      };

      const runCreate = () => {
        if (!modalRef || modalRef._tp3dCreateWorkspaceInFlight) return false;
        const submitLimitBlock = getWorkspaceCreationLimitBlock();
        if (submitLimitBlock) {
          errorEl.textContent = submitLimitBlock.message;
          UIComponents.showToast(submitLimitBlock.message, 'warning', { title: 'Workspace' });
          return false;
        }
        const name = validate();
        if (!name) return false;

        modalRef._tp3dCreateWorkspaceInFlight = true;
        setBusy(true);

        (async () => {
          try {
            UIComponents.showToast('Creating workspace…', 'info');
            const { org } = await SupabaseClient.createOrganization({ name });
            if (SupabaseClient.invalidateAccountCache) SupabaseClient.invalidateAccountCache();
            await setActiveOrgId(org.id, { source: 'create-workspace' });
            await refreshOrgContext('create-workspace', { force: true, forceEmit: true });
            await BillingService.refreshBilling({ force: true, reason: 'create-workspace' });
            syncWorkspaceUiAfterOrgRefresh(source);
            UIComponents.showToast(`Workspace "${org && org.name ? org.name : name}" created!`, 'success');
            if (modalRef && typeof modalRef.close === 'function') modalRef.close();
          } catch (err) {
            const msg = err && err.message ? String(err.message) : 'Failed to create workspace.';
            errorEl.textContent = msg;
            setBusy(false);
            if (modalRef) modalRef._tp3dCreateWorkspaceInFlight = false;
            try {
              nameInput.focus();
              nameInput.select();
            } catch {
              // ignore
            }
          }
        })();

        return false;
      };

      modalRef = UIComponents.showModal({
        title: 'Create Workspace',
        content,
        actions: [
          { label: 'Cancel', variant: 'ghost' },
          {
            label: 'Create Workspace',
            variant: 'primary',
            onClick: runCreate,
          },
        ],
      });

      nameInput.addEventListener('input', () => {
        if (errorEl.textContent) validate();
      });
      nameInput.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        runCreate();
      });

      setTimeout(() => {
        try {
          nameInput.focus();
        } catch {
          // ignore
        }
      }, 0);
    }

    function getSidebarAvatarView() {
      let user;
      try {
        user = SupabaseClient && typeof SupabaseClient.getUser === 'function' ? SupabaseClient.getUser() : null;
      } catch {
        user = null;
      }

      let sessionUser;
      try {
        const s = SessionManager.get();
        sessionUser = s && s.user ? s.user : null;
      } catch {
        sessionUser = null;
      }

      return Utils.getUserAvatarView({ user, sessionUser });
    }

    function getActiveWorkspaceInitials() {
      // eslint-disable-next-line no-use-before-define -- orgContext is initialized later in the app bootstrap closure.
      const activeOrg = orgContext && orgContext.activeOrg ? orgContext.activeOrg : null;
      const name = activeOrg && activeOrg.name ? String(activeOrg.name).trim() : '';
      return name ? name.charAt(0).toUpperCase() : '';
    }

    function renderSidebarBrandMarks() {
      const initials = getActiveWorkspaceInitials();
      const switcherMark = document.querySelector('#btn-account-switcher .brand-mark');
      if (switcherMark) switcherMark.textContent = initials;
    }

    // ============================================================================
    // SECTION: UI WIDGET (ACCOUNT SWITCHER)
    // ============================================================================
    AccountSwitcher = createAccountSwitcher({
      documentRef: document,
      UIComponents,
      SessionManager,
      getOrgContext: () => orgContext,
      isOrgContextResolved: () => orgContextResolved,
      isOrgContextInFlight: () => orgContextInFlight,
      getAuthRehydratePromise: () => authRehydratePromise,
      getSidebarAvatarView,
      getActiveWorkspaceInitials,
      renderSidebarBrandMarks,
      closeDropdowns,
      openSettingsOverlay,
      openCreateWorkspaceFlow,
      setActiveOrgId,
      performUserInitiatedLogout,
    });

    // CategoryService extracted to src/services/category-service.js

    function applyCaseDefaultColor(caseObj) {
      const next = { ...(caseObj || {}) };
      const existing = String(next.color || '').trim();
      if (existing) return next;
      const key =
        String(next.category || 'default')
          .trim()
          .toLowerCase() || 'default';
      const cats = Defaults.categories || [];
      const found = cats.find(c => c.key === key) || cats.find(c => c.key === 'default');
      next.color = (found && found.color) || '#9ca3af';
      return next;
    }

    // ============================================================================
    // SECTION: DOMAIN DATA (CASES)
    // ============================================================================
    const CaseLibrary = CoreCaseLibrary;

    // ============================================================================
    // SECTION: GEOMETRY / DIMENSIONS
    // ============================================================================
    const TrailerGeometry = createTrailerGeometry({
      Utils,
      CorePackLibrary,
      getSceneManager: () => SceneManager,
    });

    // ============================================================================
    // SECTION: DOMAIN DATA (PACKS)
    // ============================================================================
    const PackLibrary = CorePackLibrary;

    // ============================================================================
    // SECTION: STATIC CONTENT (UPDATES/ROADMAP)
    // ============================================================================
    const Data = (() => {
      const updates = [
        {
          version: '1.0.0',
          date: '2026-01-15',
          features: [
            'Multi-screen workspace (Packs, Cases, Editor, Release Notes, Roadmap, Settings)',
            'Three.js 3D editor with drag placement',
            'CSV/XLSX import, PNG + PDF export',
          ],
          bugFixes: [],
          breakingChanges: [],
        },
      ];

      const roadmap = [
        {
          quarter: 'Future',
          items: [
            {
              title: 'AR view',
              status: 'Idea',
              badge: '💡',
              color: 'var(--text-muted)',
              details: 'Preview a load-out in real space on mobile.',
            },
          ],
        },
      ];

      return { updates, roadmap };
    })();

    // ============================================================================
    // SECTION: APP SHELL / NAVIGATION
    // ============================================================================
    const AppShell = createAppShell({
      StateStore,
      PackLibrary,
      Utils,
      Router,
      beforeNavigate: (from, to) => ExportService?.flushPackPreviewBeforeNavigation(from, to),
    });

    // '#/settings' is a compatibility entry: the legacy Settings screen is retired,
    // so the hash settles on a stable screen and opens the Settings overlay on
    // Preferences. replaceScreen() uses replaceState, so there is no hashchange
    // loop and Back does not return to '#/settings'. At boot the open waits for the
    // auth gate so it cannot compete with the Auth overlay.
    let settingsRouteOpenPending = false;

    function openSettingsFromRoute() {
      const current = StateStore.get('currentScreen');
      const stable = ['packs', 'cases', 'editor', 'import-export', 'updates', 'roadmap'].includes(current) ? current : 'packs';
      Router.replaceScreen(stable);
      AppShell.navigate(stable);
      if (!BootState.appReady) {
        settingsRouteOpenPending = true;
        return;
      }
      openSettingsOverlay('preferences');
    }

    function flushPendingSettingsRoute() {
      if (!settingsRouteOpenPending) return;
      settingsRouteOpenPending = false;
      if (document.body.classList.contains('tp3d-shared-modal-lock')) return;
      openSettingsOverlay('preferences');
    }

    // ============================================================================
    // SECTION: 3D ENGINE (SCENE)
    // ============================================================================
    SceneManager = createSceneRuntime({ Utils, UIComponents, PreferencesManager, TrailerGeometry, StateStore });

    // ============================================================================
    // SECTION: 3D SCENE (INSTANCES)
    // ============================================================================
    const CaseScene = createCaseScene({
      SceneManager,
      CaseLibrary,
      CategoryService,
      PackLibrary,
      StateStore,
      TrailerGeometry,
      Utils,
      PreferencesManager,
    });

    // ============================================================================
    // SECTION: 3D INTERACTION (SELECT/DRAG)
    // ============================================================================
    // Single authoritative "one mutating editor operation at a time" controller,
    // shared by AutoPack, Unpack, Truck Change, preview capture AND the direct scene
    // mutations (drag/rotate/nudge/delete) so they can no longer overlap or commit
    // stale results over one another. Created before InteractionManager so it can be
    // injected at construction (no late-binding race).
    const OperationLifecycle = createOperationLifecycle();

    // Measurement Tool V1: an informational ruler. It shares the Editor's pointer and keyboard
    // ownership but never mutates cargo. Its lines, handles and labels are an SVG/DOM layer above
    // the canvas, so no canvas capture (Screenshot, PDF views, thumbnails, previews) can include them.
    const MeasurementTool = createMeasurementTool({
      SceneManager,
      CaseScene,
      CaseLibrary,
      PackLibrary,
      StateStore,
      PreferencesManager,
      UIComponents,
      OperationLifecycle,
    });

    // Annotations V1: informational callouts attached to cargo, the truck or the ground. Like the ruler, a
    // DOM/SVG layer above the canvas (so no canvas capture includes it) that never mutates cargo. Only one
    // scene tool owns the pointer at a time; the Editor keeps Annotations and Measurement mutually exclusive.
    const AnnotationTool = createAnnotationTool({
      SceneManager,
      CaseScene,
      CaseLibrary,
      PackLibrary,
      StateStore,
      PreferencesManager,
      UIComponents,
      OperationLifecycle,
    });

    const InteractionManager = createInteractionManager({
      SceneManager,
      CaseScene,
      StateStore,
      PackLibrary,
      CaseLibrary,
      PreferencesManager,
      UIComponents,
      OperationLifecycle,
      MeasurementTool,
      AnnotationTool,
    });

    // ============================================================================
    // SECTION: ENGINE (AUTOPACK)
    // ============================================================================
    const AutoPackEngine = createAutoPackEngine({
      CaseLibrary,
      CaseScene,
      OperationLifecycle,
      getActiveOrgIdForBilling: BillingService.getActiveOrgIdForBilling,
      getOrgRoleHydrationState: orgId => _getOrgRoleHydrationStateAccessor(orgId),
      getProRuleSet: BillingService.getProRuleSet,
      getWorkspaceSwitchState,
      maybeScheduleBillingRefresh,
      normalizeOrgIdForBilling,
      openSettingsOverlay,
      PackLibrary,
      runtimeWindow: window,
      SceneManager,
      StateStore,
      toast,
      TrailerGeometry,
      UIComponents,
      Utils,
    });

    // ============================================================================
    // SECTION: EXPORT (PNG/PDF)
    // ============================================================================
    const getActiveWorkspaceKey = () => (
      `${CoreStorage.getStorageScope ? CoreStorage.getStorageScope() : 'anon'}|${CoreStorage.getWorkspaceScope ? CoreStorage.getWorkspaceScope() : 'no-org'}`
    );

    ExportService = (() => {
      function estimateDataUrlBytes(dataUrl) {
        const str = String(dataUrl || '');
        const comma = str.indexOf(',');
        if (comma === -1) return 0;
        const b64 = str.slice(comma + 1);
        const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
        return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
      }

      async function capturePackPreview(packId, { source = 'auto', quiet = false, beforeDeparture = false } = {}) {
        quiet = quiet || source !== 'manual';
        if (OperationLifecycle.isBusy()) {
          if (!quiet && source === 'manual') {
            UIComponents.showToast('Finish the current operation before capturing a preview.', 'info', { title: 'Preview' });
          }
          return false;
        }
        const captureToken = OperationLifecycle.beginOperation('capturingPreview', { packId, source });
        if (!captureToken) return false;
        let unsubscribeCaptureContext = null;
        try {
          const captureScope = CoreStorage.captureScopeContext();
          const captureScene = EditorUI.getPreviewScene();
          const captureView = EditorUI.getPreviewView();
          const visualSignature = captureScene?.visualSignature;
          const viewSignature = captureView?.signature;
          const viewRevision = captureView?.revision;
          let contextInvalidated = false;
          const isCurrentContext = () => (
            !contextInvalidated &&
            CoreStorage.isScopeContextCurrent(captureScope) &&
            OperationLifecycle.isCurrent(captureToken) &&
            StateStore.get('currentScreen') === 'editor' &&
            StateStore.get('currentPackId') === packId &&
            captureScene && captureScene.pack.id === packId &&
            PackLibrary.getById(packId) === captureScene.pack &&
            EditorUI.getPreviewScene() === captureScene &&
            viewSignature &&
            EditorUI.getPreviewView()?.signature === viewSignature &&
            EditorUI.getPreviewView()?.revision === viewRevision &&
            CaseScene.getVisualSignature(captureScene.pack) === visualSignature
          );
          const validateContext = () => {
            if (isCurrentContext()) return true;
            if (!quiet && source === 'manual') {
              UIComponents.showToast('The load plan or preview scene changed. Try again.', 'info', { title: 'Preview' });
            }
            return false;
          };
          if (!validateContext()) return false;
          // Shared by manual and automatic capture. Returning to the same IDs
          // cannot revive a frame wait invalidated by replacement or departure.
          unsubscribeCaptureContext = StateStore.subscribe(changes => {
            if (changes._replace || !isCurrentContext()) contextInvalidated = true;
          });
          if (!captureScene.pack.cases?.length) {
            if (source !== 'manual') {
              return Boolean(PackLibrary.updatePreview(packId, {
                thumbnail: null, thumbnailUpdatedAt: null, thumbnailSource: null,
                thumbnailVisualSignature: visualSignature,
                thumbnailViewSignature: viewSignature,
                thumbnailRenderVersion: PREVIEW_RENDER_VERSION,
              }));
            }
            if (!quiet && source === 'manual') {
              UIComponents.showToast('There are no cases to preview.', 'info', { title: 'Preview' });
            }
            return false;
          }

          // The pre-navigation hook uses only an already synchronized stable
          // scene. With no await on that path, readback/write/release finish
          // synchronously before AppShell changes currentScreen.
          if (!beforeDeparture) {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }
          if (!validateContext()) return false;
          const dataUrl = renderPreviewToDataUrl(SceneManager.getCamera(), 640, 360);
          const bytes = estimateDataUrlBytes(dataUrl);
          if (bytes > 150 * 1024) throw new Error(`Preview too large (${Math.round(bytes / 1024)}KB)`);

          if (!validateContext()) return false;
          const updated = PackLibrary.updatePreview(packId, {
            thumbnail: dataUrl,
            thumbnailUpdatedAt: Date.now(),
            thumbnailSource: source === 'manual' ? 'manual' : 'auto',
            thumbnailVisualSignature: visualSignature,
            thumbnailViewSignature: viewSignature,
            thumbnailRenderVersion: PREVIEW_RENDER_VERSION,
          }, { skipHistory: true });
          if (!updated) throw new Error('Load plan not found');
          if (!quiet) UIComponents.showToast('Preview captured', 'success', { title: 'Preview' });
          return true;
        } catch (err) {
          if (!quiet) UIComponents.showToast(`Preview failed: ${err.message || err}`, 'warning', { title: 'Preview' });
          return false;
        } finally {
          if (unsubscribeCaptureContext) unsubscribeCaptureContext();
          OperationLifecycle.finishOperation(captureToken);
        }
      }

      function capturePackPreviewFromLibrary(packId, openPack) {
        if (OperationLifecycle.isBusy()) {
          UIComponents.showToast('Finish the current operation before capturing a preview.', 'info', { title: 'Preview' });
          return false;
        }
        const scope = CoreStorage.captureScopeContext();
        let replaced = false;
        const unsubscribe = StateStore.subscribe(changes => { if (changes._replace) replaced = true; });
        try {
          if (!PackLibrary.getById(packId)) throw new Error('Load plan not found');
          if (EditorUI.getPreviewScene()?.pack.id !== packId) openPack(packId);
          if (replaced || !CoreStorage.isScopeContextCurrent(scope) || !PackLibrary.getById(packId)) {
            throw new Error('The load plan or workspace changed. Try again.');
          }
          return capturePackPreview(packId, { source: 'manual' });
        } catch (err) {
          UIComponents.showToast(`Preview failed: ${err.message || err}`, 'warning', { title: 'Preview' });
          return false;
        } finally {
          unsubscribe();
        }
      }

      function flushPackPreviewBeforeNavigation(previousScreen, nextScreen) {
        if (previousScreen !== 'editor' || nextScreen === 'editor') return;
        EditorUI.flushPendingView();
        if (OperationLifecycle.isBusy()) return;
        const identity = EditorUI.getPreviewScene();
        const view = EditorUI.getPreviewView();
        const pack = identity && identity.pack;
        if (pack && view && (pack.cases?.length > 0 || pack.thumbnail) &&
            (pack.thumbnailVisualSignature !== identity.visualSignature ||
             pack.thumbnailViewSignature !== view.signature ||
             (pack.thumbnail && pack.thumbnailRenderVersion !== PREVIEW_RENDER_VERSION))) {
          void capturePackPreview(pack.id, { source: 'auto', quiet: true, beforeDeparture: true });
        }
      }

      function clearPackPreview(packId) {
        if (OperationLifecycle.isBusy()) {
          UIComponents.showToast('Finish the current operation before clearing a preview.', 'info', { title: 'Preview' });
          return false;
        }
        const pack = PackLibrary.getById(packId);
        if (!pack) return false;
        if (!pack.thumbnail) return false;
        PackLibrary.updatePreview(packId, {
          thumbnail: null, thumbnailUpdatedAt: null, thumbnailSource: null,
          thumbnailRenderVersion: PREVIEW_RENDER_VERSION,
          thumbnailVisualSignature: CaseScene.getVisualSignature(pack),
          thumbnailViewSignature: editorViewSignature(normalizeEditorView(pack.editorView) ||
            SceneManager.getDefaultEditorView(pack.truck, PreferencesManager.get().camera.defaultView)),
        }, { skipHistory: false });
        UIComponents.showToast('Preview cleared', 'info', { title: 'Preview' });
        return true;
      }

      // Screenshot sizes are the Settings choices only; any other stored value
      // (e.g. from an imported backup) falls back to the product default.
      const SCREENSHOT_RESOLUTIONS = Object.freeze(['1920x1080', '2560x1440', '3840x2160']);
      const DEFAULT_SCREENSHOT_RESOLUTION = '1920x1080';
      const MAX_CAPTURE_WIDTH = 3840;
      const MAX_CAPTURE_HEIGHT = 2160;
      // PDF views print on paper: a light neutral background, independent of the
      // UI theme, under the same ACES/exposure/sRGB pipeline as the Editor.
      const PDF_PRINT_BACKGROUND = '#ffffff';
      // PDF views print at >= 180 pixels per inch at their placed width;
      // aspect ratios (width, height) for Perspective, Top and Side.
      const PDF_VIEW_PPI = 192;
      const PDF_VIEW_ASPECTS = Object.freeze([[16, 9], [24, 13], [16, 7]]);
      // A double click cannot start a second identical Screenshot or PDF.
      const exportDownloadGuard = Utils.createDownloadActionGuard();

      function captureScreenshot() {
        return exportDownloadGuard.run('screenshot', exportScreenshot);
      }

      function exportScreenshot() {
        try {
          const authority = resolveVisualExportAuthority();
          if (!authority) return false;
          const prefs = PreferencesManager.get();
          const res = resolveScreenshotResolution(prefs.export && prefs.export.screenshotResolution);
          // The Screenshot keeps the Editor's current theme background.
          const [dataUrl] = captureExportViews(authority, [{
            camera: SceneManager.getCamera(),
            width: res.width,
            height: res.height,
            mimeType: 'image/png',
          }]);
          Utils.downloadDataUrl(dataUrl, Utils.buildLoadPlanFilename(authority.pack, 'png'));
          UIComponents.showToast('Screenshot download started', 'success', { title: 'Export' });
          return true;
        } catch (err) {
          console.error(err);
          UIComponents.showToast('Screenshot failed: ' + err.message, 'error', { title: 'Export' });
          return false;
        }
      }

      function resolveScreenshotResolution(value) {
        return Utils.parseResolution(SCREENSHOT_RESOLUTIONS.includes(value) ? value : DEFAULT_SCREENSHOT_RESOLUTION);
      }

      // Visual exports render only the committed, synchronized scene of the
      // current Pack (EditorUI.getExportScene). The toolbar being enabled is not
      // authority: the lifecycle and scene are re-checked here, at execution time.
      function resolveVisualExportAuthority() {
        const pack = getCurrentPack();
        if (!pack) {
          UIComponents.showToast('Open a load plan first', 'warning', { title: 'Export' });
          return null;
        }
        if (OperationLifecycle.isBusy()) {
          UIComponents.showToast('Finish the current operation before exporting.', 'info', { title: 'Export' });
          return null;
        }
        const scene = EditorUI.getExportScene();
        if (!scene || scene.pack !== pack) {
          UIComponents.showToast('The load plan is still changing. Try again when the scene settles.', 'info', { title: 'Export' });
          return null;
        }
        return { pack, scene };
      }

      // Each view renders the committed scene without interaction emphasis or
      // hidden cargo (plus any view-specific exclusions), then scene state is
      // restored and the live Editor repainted, on success and on failure.
      // Authority is re-checked afterwards so an image can never be attributed
      // to a scene that changed underneath it.
      function captureExportViews(authority, views) {
        const scene = SceneManager.getScene();
        if (!scene) throw new Error('3D viewport not ready');
        const images = [];
        try {
          views.forEach(view => {
            const restoreScene = CaseScene.beginExportCapture({ excludeIds: view.excludeIds || null });
            const background = scene.background;
            try {
              if (view.background) scene.background = new THREE.Color(view.background);
              images.push(renderCameraToDataUrl(view.camera, view.width, view.height, {
                mimeType: view.mimeType,
                quality: view.quality,
              }));
            } finally {
              scene.background = background;
              restoreScene();
            }
          });
        } finally {
          SceneManager.render();
        }
        if (EditorUI.getExportScene() !== authority.scene) {
          throw new Error('The load plan changed during export. Try again.');
        }
        return images;
      }

      function generatePDF() {
        return exportDownloadGuard.run('pdf', exportPDF);
      }

      function exportPDF() {
        // Billing gate: PDF export requires active Pro subscription
        try {
          const _bs = window.__TP3D_BILLING && typeof window.__TP3D_BILLING.getBillingState === 'function'
            ? window.__TP3D_BILLING.getBillingState() : null;
          if (!_bs || !_bs.ok) {
            UIComponents.showToast('Billing unavailable. Please try again.', 'warning', { title: 'Export' });
            return false;
          }
          const _rules = BillingService.getProRuleSet(_bs, window.OrgContext && typeof window.OrgContext.getActiveRole === 'function' ? window.OrgContext.getActiveRole() : null);
          if (!_rules.canUseProFeature) {
            UIComponents.showToast(_rules.uxMessage, 'info', { title: 'Export' });
            if (_rules.isOwner && (_rules.blockReason === 'trial_expired' || _rules.blockReason === 'payment_failed')) {
              try { openSettingsOverlay('billing'); } catch (_) { /* ignore */ }
            }
            return false;
          }
        } catch (_) {
          UIComponents.showToast('Billing unavailable. Please try again.', 'warning', { title: 'Export' });
          return false;
        }

        try {
          if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF not available');
          const authority = resolveVisualExportAuthority();
          if (!authority) return false;
          const pack = authority.pack;

          // One content model from the canonical statistics. Integrity content
          // (cargo status, review warnings, truck) always prints; the statistics
          // preference only adds optional analytics.
          const prefs = PreferencesManager.get();
          const includeStats = Boolean(prefs.export && prefs.export.pdfIncludeStats);
          const report = ImportExport.buildLoadPlanReport(pack, {
            stats: PackLibrary.computeStats(pack),
            validationRequired: PackLibrary.isHandlingRulesValidationRequired(pack, CaseLibrary.getCases()),
            units: prefs.units,
            getCategoryName: category => CategoryService.meta(category).name,
          });

          const { jsPDF } = window.jspdf;
          const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
          const pdf = createPdfWriter(doc);
          const { margin, pageWidth, pageHeight, contentWidth } = pdf;

          // Views: the committed scene on a print-safe background, rastered for
          // their printed width. Top/Side are truck-centric, so staged or
          // truck-external cargo cannot project over the trailer silhouette;
          // hidden cargo is omitted from every view.
          const [perspectiveSize, topSize, sideSize] = PDF_VIEW_ASPECTS.map(aspect => pdfViewRasterSize(contentWidth, aspect));
          const truckCentricExclusions = getTruckCentricExclusions(pack);
          const { topCam, sideCam } = buildOrthoCameras(pack, truckCentricExclusions, {
            top: topSize,
            side: sideSize,
          });
          const [perspective, topView, sideView] = captureExportViews(authority, [
            {
              camera: SceneManager.getCamera(), width: perspectiveSize[0], height: perspectiveSize[1],
              mimeType: 'image/jpeg', quality: 0.92, background: PDF_PRINT_BACKGROUND,
            },
            {
              camera: topCam, width: topSize[0], height: topSize[1], mimeType: 'image/jpeg', quality: 0.9,
              background: PDF_PRINT_BACKGROUND, excludeIds: truckCentricExclusions,
            },
            {
              camera: sideCam, width: sideSize[0], height: sideSize[1], mimeType: 'image/jpeg', quality: 0.9,
              background: PDF_PRINT_BACKGROUND, excludeIds: truckCentricExclusions,
            },
          ]);

          // Header: title and the Pack's business identity (absent fields are omitted).
          pdf.font(22, 'bold');
          pdf.split(report.title, contentWidth).forEach(line => pdf.line(line, margin, 26));
          report.identity.forEach(field => pdf.field(field.label, field.value));
          pdf.field('Generated', formatPdfDateTime(Date.now()));
          if (report.lastEdited) pdf.field('Last edited', formatPdfDateTime(report.lastEdited));
          pdf.gap(10);

          // Transport-review context. Never optional, never a certification.
          if (report.review.length) {
            pdf.heading('LOAD PLAN REVIEW');
            report.review.forEach(entry => {
              pdf.ensureSpace(13 * 3);
              pdf.paragraph(entry.title, { style: 'bold' });
              if (entry.text) pdf.paragraph(entry.text, { x: margin + 12, width: contentWidth - 12 });
              (entry.items || []).forEach(item => pdf.paragraph(`• ${item}`, { x: margin + 12, width: contentWidth - 12 }));
              pdf.gap(5);
            });
            pdf.gap(8);
          }

          pdf.heading('LOAD SUMMARY');
          report.summary.forEach(field => pdf.field(field.label, field.value));
          if (includeStats) report.optionalStats.forEach(field => pdf.field(field.label, field.value));
          report.summaryNotes.forEach(note => pdf.paragraph(note, { size: 9, lineHeight: 12 }));
          pdf.gap(12);

          pdf.heading('TRUCK');
          report.truck.fields.forEach(field => pdf.field(field.label, field.value));
          pdf.gap(12);

          // Notes
          if (pack.notes) {
            pdf.heading('Load Plan Notes');
            pdf.paragraph(pack.notes);
            pdf.gap(12);
          }

          pdf.image(SceneManager.getCamera().isOrthographicCamera ? 'ORTHOGRAPHIC VIEW' : 'PERSPECTIVE VIEW',
            perspective, perspectiveSize);
          pdf.image('TOP VIEW', topView, topSize);
          pdf.image('SIDE VIEW', sideView, sideSize);

          // Checklist page: one row per reusable Case with its status quantities.
          pdf.newPage();
          pdf.heading('CASE CHECKLIST', { size: 16, lineHeight: 22, gapAfter: 0 });
          const { hidden, unresolved } = report.population;
          const statusParts = ['In truck', 'Staged', unresolved > 0 && 'Unresolved'].filter(Boolean);
          pdf.paragraph(
            `Qty counts every item of the Case in this load plan (${statusParts.join(' + ')} = Qty). ` +
            (hidden > 0 ? 'Hidden is a separate visibility count. ' : '') +
            'Base dims are the Case’s catalog dimensions (L×W×H), not the placed orientation of each item.',
            { size: 8, lineHeight: 11 }
          );
          pdf.gap(8);

          const checklistColumns = [
            { label: '#', width: 18 },
            { label: 'Case', width: 0 },
            { label: 'Category', width: 70 },
            { label: 'Base dims (L×W×H)', width: 92 },
            { label: 'Unit weight', width: 54 },
            { label: 'Qty', width: 26 },
            { label: 'In truck', width: 36 },
            { label: 'Staged', width: 34 },
            ...(hidden > 0 ? [{ label: 'Hidden', width: 34 }] : []),
            ...(unresolved > 0 ? [{ label: 'Unresolved', width: 50 }] : []),
          ];
          checklistColumns[1].width = contentWidth - checklistColumns.reduce((sum, col) => sum + col.width, 0);
          checklistColumns.reduce((x, col) => { col.x = x; return x + col.width; }, margin);
          const writeChecklistHeader = () => {
            pdf.font(8, 'bold');
            pdf.tableRow(checklistColumns, checklistColumns.map(col => col.label), { lineHeight: 10, gapAfter: 0 });
            doc.line(margin, pdf.y - 6, pageWidth - margin, pdf.y - 6);
            pdf.y += 8;
            pdf.font(8, 'normal');
          };
          writeChecklistHeader();
          pdf.pageTop = pdf.y;
          // Continuation pages repeat the column header.
          pdf.onPageBreak = () => {
            pdf.font(10, 'bold');
            pdf.line('CASE CHECKLIST (continued)', margin, 18);
            writeChecklistHeader();
          };
          report.rows.forEach((row, index) => {
            pdf.tableRow(checklistColumns, [
              String(index + 1),
              row.itemCode ? `${row.name}\nItem Code: ${row.itemCode}` : row.name,
              row.category,
              row.baseDims,
              row.unitWeight,
              String(row.qty),
              String(row.counts.inTruck),
              String(row.counts.staged),
              ...(hidden > 0 ? [String(row.counts.hidden)] : []),
              ...(unresolved > 0 ? [String(row.counts.unresolved)] : []),
            ]);
          });
          pdf.onPageBreak = null;

          // Handling rules supplement (never replace) the user-authored notes below.
          if (report.handling.length) {
            pdf.gap(16);
            pdf.heading('HANDLING RULES', { size: 16, lineHeight: 22, gapAfter: 2 });
            report.handling.forEach(entry => {
              pdf.ensureSpace(13 * 3);
              pdf.paragraph(entry.itemCode ? `${entry.name} (Item Code: ${entry.itemCode})` : entry.name, { style: 'bold' });
              pdf.paragraph(entry.rules.join(' · '), { x: margin + 12, width: contentWidth - 12 });
              pdf.gap(6);
            });
          }

          // Cargo Instructions manifest. Standard Case Instructions are
          // rendered once per referenced Case; Item Notes are rendered once
          // for their owning Pack instance. Empty values are omitted.
          const cargoInstructions = ImportExport.buildCargoInstructionsManifest(pack);
          if (cargoInstructions.caseEntries.length || cargoInstructions.itemEntries.length) {
            const writeInstructionField = (label, value) => {
              pdf.font(10, 'bold');
              pdf.ensureSpace(40);
              pdf.line(`${label}:`, margin, 13);
              pdf.paragraph(value, { x: margin + 12, width: contentWidth - 12 });
              pdf.y += 5;
            };
            const writeInstructionEntry = (heading, fields) => {
              pdf.font(10, 'bold');
              pdf.ensureSpace(60);
              pdf.split(heading, contentWidth).forEach(line => pdf.line(line, margin, 17));
              fields.forEach(([label, value]) => writeInstructionField(label, value));
              pdf.y += 8;
            };

            pdf.gap(16);
            pdf.heading('CARGO INSTRUCTIONS', { size: 16, lineHeight: 24, gapAfter: 0, keepWith: 60 });

            cargoInstructions.caseEntries.forEach(entry => {
              writeInstructionEntry('CASE INFORMATION', [
                ['Case', entry.caseName],
                ['Case Instructions/Notes', entry.caseNotes],
              ]);
            });
            cargoInstructions.itemEntries.forEach(entry => {
              writeInstructionEntry('ITEM DETAILS', [
                ['Instance', entry.instanceName],
                ['Item Notes', entry.itemNotes],
              ]);
            });
          }

          const totalPages = doc.getNumberOfPages();
          for (let i = 1; i <= totalPages; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.text(`Page ${i} of ${totalPages}`, pageWidth / 2, pageHeight - 20, { align: 'center' });
          }
          doc.save(Utils.buildLoadPlanFilename(pack, 'pdf'));
          UIComponents.showToast('PDF download started', 'success', { title: 'Export' });
          return true;
        } catch (err) {
          console.error(err);
          UIComponents.showToast('PDF export failed: ' + err.message, 'error', { title: 'Export' });
          return false;
        }
      }

      // Page-aware layout for the PDF load plan. Every text baseline and image
      // stays inside the margins: a block that does not fit starts a new page,
      // and long text continues line by line onto following pages (never cut).
      // Text is mapped by ImportExport.toPdfText for the built-in font only.
      function createPdfWriter(doc) {
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 40;
        const bottom = pageHeight - margin;
        let font = { size: 10, style: 'normal' };
        const pdf = {
          pageWidth, pageHeight, margin, bottom, contentWidth: pageWidth - margin * 2,
          y: margin, pageTop: margin, onPageBreak: null,
        };
        pdf.font = (size, style = 'normal') => {
          font = { size, style };
          doc.setFontSize(size);
          doc.setFont('helvetica', style);
        };
        pdf.newPage = () => {
          const current = font;
          doc.addPage();
          pdf.y = margin;
          pdf.pageTop = margin;
          if (pdf.onPageBreak) pdf.onPageBreak();
          pdf.pageTop = pdf.y;
          pdf.font(current.size, current.style);
        };
        // A new page unless `height` more points fit or the page is still empty.
        pdf.ensureSpace = height => {
          if (pdf.y > pdf.pageTop && pdf.y + height > bottom) pdf.newPage();
        };
        pdf.gap = height => {
          if (pdf.y > pdf.pageTop) pdf.y += height;
        };
        pdf.split = (text, width) => {
          const lines = doc.splitTextToSize(ImportExport.toPdfText(text), width);
          return lines.length ? lines : [''];
        };
        pdf.line = (text, x, lineHeight) => {
          if (pdf.y > bottom) pdf.newPage();
          doc.text(text, x, pdf.y);
          pdf.y += lineHeight;
        };
        pdf.paragraph = (text, { x = margin, width = pdf.contentWidth, size = 10, style = 'normal', lineHeight = 13 } = {}) => {
          pdf.font(size, style);
          const lines = pdf.split(text, width);
          pdf.ensureSpace(Math.min(lines.length, 2) * lineHeight);
          lines.forEach(line => pdf.line(line, x, lineHeight));
        };
        pdf.heading = (text, { size = 12, lineHeight = size + 4, gapAfter = 2, keepWith = 30 } = {}) => {
          pdf.font(size, 'bold');
          const lines = pdf.split(text, pdf.contentWidth);
          pdf.ensureSpace(lines.length * lineHeight + keepWith);
          lines.forEach(line => pdf.line(line, margin, lineHeight));
          pdf.y += gapAfter;
        };
        // "Label: value" with the value wrapping beside its bold label.
        pdf.field = (label, value, { size = 10, lineHeight = 13 } = {}) => {
          pdf.font(size, 'bold');
          const labelText = `${ImportExport.toPdfText(label)}: `;
          const labelWidth = doc.getTextWidth(labelText);
          pdf.font(size, 'normal');
          const lines = pdf.split(value, pdf.contentWidth - labelWidth);
          pdf.ensureSpace(Math.min(lines.length, 2) * lineHeight);
          lines.forEach((line, index) => {
            if (pdf.y > bottom) pdf.newPage();
            if (index === 0) {
              pdf.font(size, 'bold');
              doc.text(labelText, margin, pdf.y);
              pdf.font(size, 'normal');
            }
            doc.text(line, margin + labelWidth, pdf.y);
            pdf.y += lineHeight;
          });
        };
        // A view heading plus its image, placed only where both fit in full.
        pdf.image = (heading, dataUrl, [pxWidth, pxHeight]) => {
          const headingGap = 16;
          const after = 16;
          let width = pdf.contentWidth;
          let height = (width * pxHeight) / pxWidth;
          const maxHeight = bottom - margin - headingGap - after;
          if (height > maxHeight) {
            height = maxHeight;
            width = (height * pxWidth) / pxHeight;
          }
          pdf.font(12, 'bold');
          pdf.ensureSpace(headingGap + height + after);
          doc.text(heading, margin, pdf.y);
          pdf.y += headingGap;
          doc.addImage(dataUrl, 'JPEG', margin, pdf.y, width, height);
          pdf.y += height + after;
        };
        // One table row; cells wrap within their columns. A row that does not
        // fit moves to a new page; a row taller than a page continues there.
        pdf.tableRow = (columns, cells, { lineHeight = 11, gapAfter = 4 } = {}) => {
          const cellLines = columns.map((col, i) => pdf.split(cells[i], col.width - 6));
          const count = Math.max(...cellLines.map(lines => lines.length));
          if (pdf.y > pdf.pageTop && pdf.y + (count - 1) * lineHeight > bottom) pdf.newPage();
          for (let i = 0; i < count; i++) {
            if (pdf.y > bottom) pdf.newPage();
            cellLines.forEach((lines, c) => {
              if (lines[i]) doc.text(lines[i], columns[c].x, pdf.y);
            });
            pdf.y += lineHeight;
          }
          pdf.y += gapAfter;
        };
        return pdf;
      }

      // PDF views are rastered for their printed width (the letter content
      // width, ~7.4 in, gives ~1420 px) within the capture bounds.
      function pdfViewRasterSize(widthPt, aspect) {
        const [aspectWidth, aspectHeight] = aspect;
        let width = Math.ceil((widthPt / 72) * PDF_VIEW_PPI);
        let height = Math.round((width * aspectHeight) / aspectWidth);
        const scale = Math.min(1, MAX_CAPTURE_WIDTH / width, MAX_CAPTURE_HEIGHT / height);
        if (scale < 1) {
          width = Math.floor(width * scale);
          height = Math.floor(height * scale);
        }
        return [width, height];
      }

      // Absolute local date and time with its time zone, so a printed plan's
      // timestamps stay meaningful away from the app.
      function formatPdfDateTime(timestamp) {
        return new Date(timestamp).toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
      }

      function getCurrentPack() {
        const packId = StateStore.get('currentPackId');
        return packId ? PackLibrary.getById(packId) : null;
      }

      // Truck-centric views show cargo that occupies the truck body. Staged
      // cargo, and any cargo wholly outside the truck footprint, would otherwise
      // project over the trailer silhouette in an orthographic view and read as
      // loaded. Excluded from Top/Side only; cargo is never repositioned.
      function getTruckCentricExclusions(pack) {
        const truck = SceneManager.getTruckBoundsWorld();
        const excluded = new Set();
        (pack.cases || []).forEach(inst => {
          if (!inst) return;
          if (inst.placement === 'staged') {
            excluded.add(inst.id);
            return;
          }
          const aabb = CaseScene.getAabbWorld(inst.id);
          if (!aabb || !truck) return;
          const overlapsTruck = aabb.max.x > truck.min.x && aabb.min.x < truck.max.x &&
            aabb.max.z > truck.min.z && aabb.min.z < truck.max.z;
          if (!overlapsTruck) excluded.add(inst.id);
        });
        return excluded;
      }

      // Authoritative scene truck bounds (full length including any Front
      // Overhang; Wheel Wells lie inside them) grown by every cargo box the
      // truck-centric views show, so out-of-gauge cargo is never cropped.
      function getTruckCentricBounds(pack, excludeIds) {
        const truck = SceneManager.getTruckBoundsWorld();
        if (!truck) throw new Error('3D viewport not ready');
        const bounds = truck.clone();
        (pack.cases || []).forEach(inst => {
          if (!inst || inst.hidden || excludeIds.has(inst.id)) return;
          const aabb = CaseScene.getAabbWorld(inst.id);
          if (!aabb) return;
          bounds.expandByPoint(new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.min.z));
          bounds.expandByPoint(new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.max.z));
        });
        return bounds;
      }

      // One world scale per view: the frustum is the truck-centric bounds plus a
      // margin, widened on one axis to the raster aspect. Proportions stay
      // physical (no stretch) and nothing inside the bounds is cropped.
      function buildOrthoCameras(pack, excludeIds, sizes) {
        const bounds = getTruckCentricBounds(pack, excludeIds);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const margin = Math.max(SceneManager.toWorld(12), 0.05 * Math.max(size.x, size.y, size.z));
        const fit = (spanH, spanV, [width, height]) => {
          const aspect = width / height;
          let halfH = spanH / 2 + margin;
          let halfV = spanV / 2 + margin;
          if (halfH / halfV > aspect) halfV = halfH / aspect;
          else halfH = halfV * aspect;
          return { halfH, halfV };
        };

        const top = fit(size.x, size.z, sizes.top);
        const topCam = new THREE.OrthographicCamera(-top.halfH, top.halfH, top.halfV, -top.halfV, 0.1, size.y + 20);
        topCam.position.set(center.x, bounds.max.y + 10, center.z);
        topCam.up.set(0, 0, -1);
        topCam.lookAt(center.x, bounds.min.y, center.z);
        topCam.updateProjectionMatrix();

        const side = fit(size.x, size.y, sizes.side);
        const sideCam = new THREE.OrthographicCamera(-side.halfH, side.halfH, side.halfV, -side.halfV, 0.1, size.z + 20);
        sideCam.position.set(center.x, center.y, bounds.max.z + 10);
        sideCam.lookAt(center.x, center.y, bounds.min.z);
        sideCam.updateProjectionMatrix();

        return { topCam, sideCam };
      }

      // Screenshot/PDF capture at an exact, bounded size through the same display
      // framebuffer as Preview, so exports keep the live ACES tone mapping,
      // exposure, sRGB output and framebuffer antialiasing. A browser-clamped
      // buffer or an unusable encoding fails the export instead of downloading.
      function renderCameraToDataUrl(camera, width, height, options = {}) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
            width > MAX_CAPTURE_WIDTH || height > MAX_CAPTURE_HEIGHT) {
          throw new Error(`Unsupported image size ${width}×${height}`);
        }
        const mimeType = options.mimeType || 'image/png';
        const quality = Number.isFinite(options.quality) ? options.quality : 0.92;
        const dataUrl = renderDisplayCapture(camera, width, height, { mimeType, quality, exactBuffer: true });
        const prefix = `data:${mimeType};base64,`;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length <= prefix.length) {
          throw new Error('The image could not be encoded');
        }
        return dataUrl;
      }

      // Preview and Screenshot/PDF share the display framebuffer: ordinary render
      // targets omit the live ACES/exposure/sRGB pipeline.
      function renderPreviewToDataUrl(camera, width, height) {
        return renderDisplayCapture(camera, width, height, { mimeType: 'image/jpeg', quality: 0.80 });
      }

      function renderDisplayCapture(camera, width, height, { mimeType, quality, exactBuffer = false }) {
        const renderer = SceneManager.getRenderer();
        const scene = SceneManager.getScene();
        if (!renderer || !scene || !camera) throw new Error('3D viewport not ready');

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
        if (!ctx) throw new Error('Image canvas not available');

        const size = renderer.getSize(new THREE.Vector2());
        const pixelRatio = renderer.getPixelRatio();
        const target = renderer.getRenderTarget();
        const cubeFace = renderer.getActiveCubeFace();
        const mipLevel = renderer.getActiveMipmapLevel();
        const viewport = renderer.getViewport(new THREE.Vector4());
        const scissor = renderer.getScissor(new THREE.Vector4());
        const scissorTest = renderer.getScissorTest();
        const autoClear = renderer.autoClear;
        const autoClearColor = renderer.autoClearColor;
        const autoClearDepth = renderer.autoClearDepth;
        const aspect = camera.aspect;
        const orthoBounds = camera.isOrthographicCamera
          ? { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom, zoom: camera.zoom }
          : null;
        const projection = camera.projectionMatrix.clone();
        const projectionInverse = camera.projectionMatrixInverse.clone();
        const grid = scene.getObjectByName('grid');
        const gridVisible = grid?.visible;

        try {
          if (grid) grid.visible = false;
          renderer.setRenderTarget(null);
          // r185 sets only the backing buffer and DPR, never canvas CSS size.
          renderer.setDrawingBufferSize(width, height, 1);
          if (exactBuffer) {
            const gl = renderer.getContext();
            if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
              throw new Error(`This device cannot capture ${width}×${height} images`);
            }
          }
          renderer.setScissorTest(false);
          if (camera.isPerspectiveCamera) {
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
          } else if (camera.isOrthographicCamera) {
            camera.left = -camera.top * width / height;
            camera.right = camera.top * width / height;
            camera.updateProjectionMatrix();
          }
          renderer.render(scene, camera);
          // No await: the browser may clear the WebGL buffer after this task.
          // Render only the main scene here, omitting the separate axis widget.
          ctx.drawImage(renderer.domElement, 0, 0);
          return canvas.toDataURL(mimeType, quality);
        } finally {
          if (grid) grid.visible = gridVisible;
          if (camera.isPerspectiveCamera) camera.aspect = aspect;
          if (orthoBounds) Object.assign(camera, orthoBounds);
          camera.projectionMatrix.copy(projection);
          camera.projectionMatrixInverse.copy(projectionInverse);
          renderer.setDrawingBufferSize(size.x, size.y, pixelRatio);
          try {
            renderer.setRenderTarget(null);
            SceneManager.render();
          } finally {
            // Repaint also uses viewport/scissor and clear flags for the axis.
            // Restore these even if the normal repaint itself fails.
            renderer.autoClear = autoClear;
            renderer.autoClearColor = autoClearColor;
            renderer.autoClearDepth = autoClearDepth;
            renderer.setRenderTarget(target, cubeFace, mipLevel);
            renderer.setViewport(viewport);
            renderer.setScissor(scissor);
            renderer.setScissorTest(scissorTest);
          }
        }
      }

      return { captureScreenshot, generatePDF, capturePackPreview, capturePackPreviewFromLibrary, flushPackPreviewBeforeNavigation, clearPackPreview };
    })();

    const AutoPackPreviewScheduler = createPackPreviewScheduler({
      StateStore,
      PackLibrary,
      OperationLifecycle,
      capturePackPreview: (packId, options) => ExportService.capturePackPreview(packId, options),
      getActiveWorkspaceKey: () => `${getActiveWorkspaceKey()}|${CoreStorage.captureScopeContext().generation}`,
      getVisualSignature: pack => CaseScene.getVisualSignature(pack),
      // Saved Pack views remain the preview authority across opening resets.
      // Without one, use the live view so a Settings default change does not
      // re-capture the open Pack until it is reopened with that default.
      getViewSignature: pack => editorViewSignature(normalizeEditorView(pack.editorView)) ||
        EditorUI.getPreviewView()?.signature ||
        editorViewSignature(SceneManager.getDefaultEditorView(pack.truck, PreferencesManager.get().camera.defaultView)),
    });

    // ==== UI: Packs Screen ====
    // ============================================================================
    // SECTION: SCREEN UI (PACKS)
    // ============================================================================
    const ImportPackDialog = createImportPackDialog({
      documentRef: document,
      UIComponents,
      ImportExport,
      PackLibrary,
      OperationLifecycle,
      Utils,
    });
    const ImportCasesDialog = createImportCasesDialog({
      documentRef: document,
      UIComponents,
      ImportExport,
      CaseLibrary,
      StateStore,
      OperationLifecycle,
      Utils,
    });
    const TruckChangeController = createTruckChangeController({
      PackLibrary,
      CaseLibrary,
      UIComponents,
      documentRef: document,
    });
    PacksUI = createPacksScreen({
      Utils,
      UIComponents,
      PreferencesManager,
      PackLibrary,
      CaseLibrary,
      StateStore,
      TrailerPresets,
      ImportExport,
      createTableFooter,
      AppShell,
      ExportService,
      CardDisplayOverlay,
      TruckChangeController,
      OperationLifecycle,
      featureFlags,
      // An immediate save that reports its own outcome: the caller shows the one success or failure message, and the
      // queued autosave is dropped because this write carries the same whole state.
      persistNow: () => {
        Storage.cancelPendingSave();
        return Storage.saveNow({ report: false });
      },
      // The original of a damaged Folder graph, kept before the explicit repair may change it.
      preserveFolderEvidence: () =>
        Storage.preserveFolderGraphEvidence(StateStore.get('folderLibrary'), StateStore.get('packLibrary')),
      toast,
      toAscii,
    });

    // ============================================================================
    // SECTION: SCREEN UI (CASES)
    // ============================================================================
    CasesUI = createCasesScreen({
      Utils,
      UIComponents,
      PreferencesManager,
      CaseLibrary,
      PackLibrary,
      CategoryService,
      StateStore,
      createTableFooter,
      CardDisplayOverlay,
      OperationLifecycle,
    });

    // ============================================================================
    // SECTION: SCREEN UI (EDITOR)
    // ============================================================================
    EditorUI = createEditorScreen({
      StateStore,
      PackLibrary,
      CaseLibrary,
      PreferencesManager,
      UIComponents,
      Utils,
      TrailerGeometry,
      CategoryService,
      AutoPackEngine,
      ExportService,
      SystemOverlay,
      TrailerPresets,
      AppShell,
      SceneManager,
      CaseScene,
      InteractionManager,
      TruckChangeController,
      OperationLifecycle,
      MeasurementTool,
      AnnotationTool,
    });
    EditorUI.setPreviewViewSettledCallback(() => AutoPackPreviewScheduler.schedule());

    // ============================================================================
    // SECTION: SCREEN UI (UPDATES)
    // ============================================================================
    const UpdatesUI = createUpdatesScreen({
      Data,
    });

    // ============================================================================
    // SECTION: SCREEN UI (ROADMAP)
    // ============================================================================
    const RoadmapUI = createRoadmapScreen({
      Data,
      UIComponents,
    });

    // ============================================================================
    // SECTION: GLOBAL INPUT (KEYBOARD)
    // ============================================================================
    const KeyboardManager = createKeyboardManager({
      StateStore,
      PackLibrary,
      CaseLibrary,
      CaseScene,
      SceneManager,
      InteractionManager,
      OperationLifecycle,
      UIComponents,
      AppShell,
      Storage,
      Utils,
    });

    function openExportAppModal() {
      const content = document.createElement('div');
      content.style.display = 'grid';
      content.style.gap = '12px';

      const blurb = document.createElement('div');
      blurb.className = 'muted';
      blurb.style.fontSize = 'var(--text-sm)';
      blurb.innerHTML =
        '<div>Download the active workspace\'s local load plans, cases, and folders together with local user preferences. Other account workspaces, login, membership, billing, and payment data are not included.</div>';

      const filename = Utils.buildExportFilename('truck-packer-app-backup', 'json');
      const meta = document.createElement('div');
      meta.className = 'card';
      meta.innerHTML = `
              <div style="font-weight:var(--font-semibold);margin-bottom:6px">Export details</div>
              <div class="muted" style="font-size:var(--text-sm)">File: ${Utils.escapeHtml(filename)}</div>
            `;

      content.appendChild(blurb);
      content.appendChild(meta);

      UIComponents.showModal({
        title: 'Export App Backup',
        content,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Download App Backup',
            variant: 'primary',
            onClick: () => {
              Utils.downloadActionGuard.run('app-backup', () => {
                try {
                  const json = ImportExport.buildRestorableAppExportJSON();
                  Utils.downloadText(filename, json);
                  UIComponents.showToast('App Backup download started', 'success');
                  return true;
                } catch (err) {
                  console.error(err);
                  UIComponents.showToast('Export failed: ' + (err && err.message), 'error');
                  return false;
                }
              });
            },
          },
        ],
      });
    }

    function openExportWorkspaceModal(workspaceName, workspaceId = '') {
      // The dialog belongs to the workspace it was opened for. A later switch,
      // including A→B→A (new scope generation), must never export another
      // scope's libraries under this workspace's name and id.
      const openedScope = CoreStorage.captureScopeContext();
      const isOpenedWorkspace = () => CoreStorage.isScopeContextCurrent(openedScope) &&
        String(workspaceId || 'no-org').trim().toLowerCase() === String(CoreStorage.getWorkspaceScope()).toLowerCase();
      if (!isOpenedWorkspace()) {
        UIComponents.showToast('This workspace is no longer active. Reopen Settings and try again.', 'warning');
        return;
      }
      const safeName = workspaceName ? String(workspaceName).trim() : 'workspace';
      const filename = Utils.buildExportFilename(['workspace-backup', safeName], 'json');
      const content = document.createElement('div');
      content.style.display = 'grid';
      content.style.gap = '12px';

      const blurb = document.createElement('div');
      blurb.className = 'muted';
      blurb.style.fontSize = 'var(--text-sm)';
      blurb.innerHTML =
        '<div>Download this workspace\'s load plans, cases, and folder structure. App preferences, members, billing, payment data, and thumbnails are not included.</div>';

      const meta = document.createElement('div');
      meta.className = 'card';
      meta.innerHTML = `
              <div style="font-weight:var(--font-semibold);margin-bottom:6px">Export details</div>
              <div class="muted" style="font-size:var(--text-sm)">File: ${Utils.escapeHtml(filename)}</div>
            `;

      content.appendChild(blurb);
      content.appendChild(meta);

      UIComponents.showModal({
        title: 'Export Workspace Backup',
        content,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Export Workspace Backup',
            variant: 'primary',
            onClick: () => {
              if (!isOpenedWorkspace()) {
                UIComponents.showToast('The active workspace changed. Nothing was exported.', 'warning');
                return;
              }
              Utils.downloadActionGuard.run('workspace-backup', () => {
                try {
                  const json = ImportExport.buildRestorableWorkspaceExportJSON(safeName, workspaceId);
                  Utils.downloadText(filename, json);
                  UIComponents.showToast('Workspace Backup download started', 'success');
                  return true;
                } catch (err) {
                  console.error(err);
                  UIComponents.showToast('Export failed: ' + (err && err.message), 'error', { duration: 7000 });
                  return false;
                }
              });
            },
          },
        ],
      });
    }

    function openImportAppDialog() {
      ImportAppDialog.open();
    }

    function openHelpModal() {
      HelpModal.open();
    }

    function openUpdatesScreen() {
      SettingsOverlay.close();
      AppShell.navigate('updates');
    }

    function openRoadmapScreen() {
      SettingsOverlay.close();
      AppShell.navigate('roadmap');
    }

    function wireGlobalButtons() {
      const btnExport = document.getElementById('btn-export-app');
      const btnImport = document.getElementById('btn-import-app');
      const btnHelp = document.getElementById('btn-help');

      if (btnExport) btnExport.addEventListener('click', openExportAppModal);
      if (btnImport) btnImport.addEventListener('click', openImportAppDialog);
      if (btnHelp) btnHelp.addEventListener('click', openHelpModal);
    }

    // ============================================================================
    // SECTION: BOOT HELPERS (SEED)
    // ============================================================================

    // P0.9 – Autosave pause guard.  Set to true while swapping storage scope
    // so the StateStore subscriber doesn't re-persist stale data.
    let suspendAutoSave = false;

    // P0.9 – Tracks whether we have loaded the scoped storage at least once
    // after auth identity was known.  Needed because seedIfEmpty() runs at
    // boot before auth resolves, using the 'anon' scope.
    let hasLoadedScopedState = false;
    let lastLoadedWorkspaceStorageKey = '';
    let lastWorkspaceUiResetKey = '';

    function getWorkspaceStorageScope(targetOrgId) {
      const orgId = targetOrgId ? String(targetOrgId).trim() : '';
      return orgId || 'no-org';
    }

    function getWorkspaceStorageKey(targetOrgId) {
      const userScope =
        Storage && typeof Storage.getStorageScope === 'function'
          ? Storage.getStorageScope()
          : 'anon';
      return `${userScope}|${getWorkspaceStorageScope(targetOrgId)}`;
    }

    function captureLiveWorkspaceUiState() {
      const currentScreen = StateStore.get('currentScreen');
      if (!['editor', 'cases', 'import-export', 'updates', 'roadmap'].includes(currentScreen)) return null;
      return {
        currentScreen,
        currentPackId: StateStore.get('currentPackId') || null,
      };
    }

    function restoreLiveWorkspaceUiState(liveUiState) {
      if (!liveUiState) return false;
      if (liveUiState.currentScreen === 'editor') {
        const loadedPacks = StateStore.get('packLibrary') || [];
        const currentPackId = liveUiState.currentPackId;
        if (!currentPackId || !loadedPacks.some(pack => pack && pack.id === currentPackId)) {
          return false;
        }
        StateStore.set({
          currentScreen: 'editor',
          currentPackId,
        }, { skipHistory: true });
        return true;
      }
      StateStore.set({ currentScreen: liveUiState.currentScreen }, { skipHistory: true });
      return true;
    }

    function flushPendingStorageSave() {
      if (Storage && typeof Storage.flushPendingSave === 'function') {
        Storage.flushPendingSave();
      }
    }

    function pauseAutoSaveForAppRestore() {
      const previousSuspendAutoSave = suspendAutoSave;
      suspendAutoSave = true;
      try {
        if (Storage && typeof Storage.cancelPendingSave === 'function') {
          Storage.cancelPendingSave();
        }
      } catch (error) {
        suspendAutoSave = previousSuspendAutoSave;
        throw error;
      }

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        suspendAutoSave = previousSuspendAutoSave;
      };
    }

    function setWorkspaceStorageScope(targetOrgId) {
      const scope = getWorkspaceStorageScope(targetOrgId);
      if (Storage && typeof Storage.setWorkspaceScope === 'function') {
        const currentScope = typeof Storage.getWorkspaceScope === 'function'
          ? Storage.getWorkspaceScope()
          : null;
        if (currentScope !== null && currentScope !== scope) flushPendingStorageSave();
        Storage.setWorkspaceScope(scope);
      }
      return scope;
    }

    function applyWorkspaceScopedLocalState(
      targetOrgId,
      { seedIfMissing = true, force = false, preserveLiveUi = false } = {}
    ) {
      const nextStorageKey = getWorkspaceStorageKey(targetOrgId);
      const workspaceChanged = lastLoadedWorkspaceStorageKey !== nextStorageKey;
      if (!force && !workspaceChanged) return false;
      if (force && !workspaceChanged) flushPendingStorageSave();
      const liveUiState = preserveLiveUi ? captureLiveWorkspaceUiState() : null;
      setWorkspaceStorageScope(targetOrgId);
      if (workspaceChanged) {
        try {
          if (KeyboardManager && typeof KeyboardManager.clearClipboard === 'function') {
            KeyboardManager.clearClipboard();
          }
        } catch {
          // ignore
        }
        try {
          if (AutoPackEngine && typeof AutoPackEngine.bumpWorkspaceGeneration === 'function') {
            AutoPackEngine.bumpWorkspaceGeneration();
          }
        } catch {
          // ignore
        }
      }

      suspendAutoSave = true;
      try {
        if (targetOrgId || seedIfMissing) {
          loadScopedStateOrSeed({ seedIfMissing });
        } else {
          resetAppStateToEmpty();
        }
        restoreLiveWorkspaceUiState(liveUiState);
      } finally {
        suspendAutoSave = false;
      }

      hasLoadedScopedState = true;
      lastLoadedWorkspaceStorageKey = nextStorageKey;
      return true;
    }

    applyPostLogoutLocalStateReset = () => {
      SessionManager.clear();
      // P0.9 – Don't wipe user-scoped storage (data should survive for next login).
      // Instead, pause autosave → reset in-memory state → set scope to anon.
      flushPendingStorageSave();
      suspendAutoSave = true;
      try {
        resetAppStateToEmpty();
        Storage.setStorageScope('anon');
        setWorkspaceStorageScope(null);
        hasLoadedScopedState = false;
        lastLoadedWorkspaceStorageKey = '';
      } finally {
        suspendAutoSave = false;
      }
      StateStore.set({ currentScreen: 'packs' }, { skipHistory: true });
    };

    function seedIfEmpty() {
      const stored = Storage.load();
      if (stored && Array.isArray(stored.caseLibrary) && Array.isArray(stored.packLibrary)) {
        const storedCases = (stored.caseLibrary || [])
          .map(applyCanonicalCargoFields)
          .map(applyCaseDefaultColor);
        const storedPacks = stored.packLibrary;
        const storedPrefs = stored.preferences || Defaults.defaultPreferences;
        const storedCurrentPackId =
          stored.currentPackId && storedPacks.some(p => p && p.id === stored.currentPackId)
            ? stored.currentPackId
            : null;
        const initialState = {
          currentScreen: 'packs',
          currentPackId: storedCurrentPackId,
          selectedInstanceIds: [],
          caseLibrary: storedCases,
          packLibrary: storedPacks,
          folderLibrary: Array.isArray(stored.folderLibrary) ? stored.folderLibrary : [],
          preferences: storedPrefs,
        };
        StateStore.init(initialState);
        return;
      }

      const fallbackPreferences = stored && stored.preferences ? stored.preferences : Defaults.defaultPreferences;
      const cases = Defaults.seedCases();
      cases.forEach(c => {
        c.volume = Utils.volumeInCubicInches(c.dimensions);
      });
      const demoPack = Defaults.seedPack(cases);
      demoPack.stats = PackLibrary.computeStats(demoPack, cases);
      const initialState = {
        currentScreen: 'packs',
        currentPackId: demoPack.id,
        selectedInstanceIds: [],
        caseLibrary: cases,
        packLibrary: [demoPack],
        folderLibrary: [],
        preferences: fallbackPreferences,
      };
      StateStore.init(initialState);
      Storage.saveNow();
    }

    /**
     * P0.9 – Reset in-memory state to a safe empty shape so autosave can't
     * re-persist stale (other-user) data.  Uses StateStore.replace so
     * subscribers fire a full re-render.
     */
    function resetAppStateToEmpty() {
      const emptyState = {
        currentScreen: 'packs',
        currentPackId: null,
        selectedInstanceIds: [],
        caseLibrary: [],
        packLibrary: [],
        folderLibrary: [],
        preferences: Defaults.defaultPreferences,
      };
      StateStore.replace(emptyState, { skipHistory: true, resetHistory: true });
    }

    /**
     * P0.9 – Load the scoped localStorage into StateStore (or seed demo data
     * if no saved state exists for this scope).  Mirrors the logic in
     * seedIfEmpty but can be called at any time after scope changes.
     */
    function loadScopedStateOrSeed({ seedIfMissing = true } = {}) {
      const stored = Storage.load();
      if (stored && Array.isArray(stored.caseLibrary) && Array.isArray(stored.packLibrary)) {
        const storedCases = (stored.caseLibrary || [])
          .map(applyCanonicalCargoFields)
          .map(applyCaseDefaultColor);
        const storedPacks = stored.packLibrary;
        const storedPrefs = stored.preferences || Defaults.defaultPreferences;
        const storedCurrentPackId =
          stored.currentPackId && storedPacks.some(p => p && p.id === stored.currentPackId)
            ? stored.currentPackId
            : null;
        StateStore.replace({
          currentScreen: 'packs',
          currentPackId: storedCurrentPackId,
          selectedInstanceIds: [],
          caseLibrary: storedCases,
          packLibrary: storedPacks,
          folderLibrary: Array.isArray(stored.folderLibrary) ? stored.folderLibrary : [],
          preferences: storedPrefs,
        }, { skipHistory: true, resetHistory: true });
      } else if (seedIfMissing) {
        // No saved data for this user – seed with demo data (same as initial boot).
        const fallbackPreferences = stored && stored.preferences ? stored.preferences : Defaults.defaultPreferences;
        const cases = Defaults.seedCases();
        cases.forEach(c => { c.volume = Utils.volumeInCubicInches(c.dimensions); });
        const demoPack = Defaults.seedPack(cases);
        demoPack.stats = PackLibrary.computeStats(demoPack, cases);
        StateStore.replace({
          currentScreen: 'packs',
          currentPackId: demoPack.id,
          selectedInstanceIds: [],
          caseLibrary: cases,
          packLibrary: [demoPack],
          folderLibrary: [],
          preferences: fallbackPreferences,
        }, { skipHistory: true, resetHistory: true });
        Storage.saveNow();
      } else {
        StateStore.replace({
          currentScreen: 'packs',
          currentPackId: null,
          selectedInstanceIds: [],
          caseLibrary: [],
          packLibrary: [],
          folderLibrary: [],
          preferences: (stored && stored.preferences) || Defaults.defaultPreferences,
        }, { skipHistory: true, resetHistory: true });
      }
    }

    // ============================================================================
    // SECTION: BOOT HELPERS (RUNTIME VALIDATION)
    // ============================================================================
    async function validateRuntime() {
      if (!Utils.hasWebGL()) {
        SystemOverlay.show({
          title: 'WebGL required',
          message: 'This app requires WebGL. Please update your browser or enable hardware acceleration.',
          items: ['Chrome/Edge: Settings → System → Use hardware acceleration', 'Safari: Update to Safari 14+'],
        });
        return false;
      }

      // Wait for vendor scripts (CDN → fallback CDN → local) to finish loading.
      // This handles slow/offline connections where fallback scripts need time.
      if (typeof window.__tp3dVendorAllReady === 'function') {
        try {
          await Promise.race([
            window.__tp3dVendorAllReady(),
            new Promise(r => setTimeout(r, 12000)), // 12s max wait
          ]);
        } catch {
          // continue — we'll check globals below
        }
      }

      // Log any CDN failures to console for developers
      const failures = window.__TP3D_BOOT && window.__TP3D_BOOT.cdnFailures ? window.__TP3D_BOOT.cdnFailures : [];
      if (failures.length) {
        console.warn('[TruckPackerApp] CDN failures:', failures.map(f => `${f.name} (${f.url})`).join(', '));
      }

      // Check if critical libraries are available
      const missing = [];
      if (!window.THREE) missing.push('3D rendering engine');
      if (!window.THREE || !window.THREE.OrbitControls) missing.push('Camera controls');
      if (!window.TWEEN) missing.push('Animation library');
      if (!window.XLSX) missing.push('Spreadsheet support');
      if (!window.jspdf) missing.push('PDF generation');

      if (missing.length) {
        // Log technical details to console — not shown to users
        console.error('[TruckPackerApp] Missing libraries:', missing);

        SystemOverlay.show({
          title: 'Some app files could not load',
          message: 'Check your connection, disable blocking extensions, or reload.',
          items: [
            'Make sure you are connected to the internet',
            'Disable ad blockers or script-blocking browser extensions',
            'Click "Try Again" to reload',
          ],
        });
        return false;
      }

      return true;
    }

    function renderAll() {
      AppShell.renderShell();
      PacksUI.render();
      CasesUI.render();
      EditorUI.render();
      UpdatesUI.render();
      RoadmapUI.render();
      RecoverableErrorOverlay.syncRecoverableErrorOverlay();
    }

    let routeNotFoundActive = false;

    const RecoverableErrorOverlay = createRecoverableErrorOverlay({
      StateStore,
      PackLibrary,
      ErrorOverlay,
      BootState,
      getRouteNotFound: () => routeNotFoundActive,
    });

    // ============================================================================
    // SECTION: APP INIT (ORDER CRITICAL)
    // ============================================================================
    let authListenerInstalled = false;
    let authUiBound = false;
    let lastAuthUserId = null;
    let lastOrgChangeAt = 0;
    let lastOrgIdNotified = null;
    const ORG_CONTEXT_LS_KEY = 'tp3d:active-org-id';
    const ORG_CONTEXT_SYNC_KEY = 'tp3d:org-context-sync';
    const WORKSPACE_SWITCH_SYNC_KEY = 'tp3d:workspace-switch-state-sync';
    const ORG_CONTEXT_DEDUP_MS = 500;
    const ORG_PERSIST_COOLDOWN_MS = 2000;
    const orgContextMetrics = {
      orgChangedEmitted: 0,
      orgChangedHandled: 0,
      orgChangedIgnoredSameId: 0,
      orgChangedIgnoredSignedOut: 0,
      orgChangedQueuedWhileHidden: 0,
    };
    let orgContext = {
      activeOrgId: null,
      activeOrg: null,
      orgs: [],
      role: null,
      updatedAt: 0,
    };
    ImportExportUI = createImportExportScreen({
      StateStore,
      CaseLibrary,
      ImportExport,
      ImportCasesDialog,
      ImportPackDialog,
      UIComponents,
      Utils,
      OperationLifecycle,
      getWorkspaceName: () => {
        const active = orgContext.activeOrg;
        return active && String(active.id) === String(orgContext.activeOrgId)
          ? (active.name || active.display_name || '')
          : '';
      },
    });
    const orgContextTabId = (() => {
      try {
        const existing = window.sessionStorage.getItem('tp3d:org-context-tab-id');
        if (existing) return String(existing);
      } catch {
        // ignore
      }
      const generated = `orgtab_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
      try {
        window.sessionStorage.setItem('tp3d:org-context-tab-id', generated);
      } catch {
        // ignore
      }
      return generated;
    })();

    let lastOrgPersistAt = 0;
    let orgContextInFlight = null;
    let orgContextResolved = false;
    let orgContextQueued = false;
    let _orgBundleFetchInflightForOrg = null;
    /** @type {Map<string, number>} orgId -> grace-until timestamp */
    const _orgRoleHydrationGraceUntilByOrg = new Map();
    const _ORG_ROLE_GRACE_MS = 1500;
    const AUTH_REFRESH_DEBOUNCE_MS = 350;
    const AUTH_REFRESH_AUTO_REASONS = new Set(['tab-visible', 'storage', 'org-changed']);
    const toastDeduper = new Map();
    let authRehydratePromise = null;
    let authRefreshTimer = null;
    let authRefreshInFlight = null;
    let authRefreshQueued = false;
    let authMissingSessionShown = false;
    const authRefreshReasons = new Set();
    let authRefreshPending = {
      force: false,
      forceBundle: false,
      sessionHint: null,
    };
    // Used to prevent mixed-user UI when another tab signs in as a different user.
    const authReloadKey = 'tp3d:auth-user-switch-reload';
    // Latch used to temporarily hold a forced account-disabled message so
    // normal signed-out flows don't overwrite it while we show the disabled UI.

    // P0.7 – Cache the last *real* auth event so we can fall back to it when
    // SupabaseClient.getAuthState() briefly returns status:'unknown' / hasToken:false
    // immediately after a genuine SIGNED_IN or TOKEN_REFRESHED event.
    let lastAuthEventSnapshot = null;
    const FALLBACK_AUTH_TTL_MS = 8000;

    // ── Authentication runtime (Stage 3) ──────────────────────────────────
    // AuthService owns the auth truth-snapshot + stability gate. Constructed before
    // OrganizationService (which needs getSignedInUserIdStrict). readLocalOrgId is
    // wired late (after Org) to break the Auth<->Org construction cycle.
    const AuthService = createAuthService({
      SupabaseClient,
      isTp3dDebugEnabled,
      isLogoutInProgress,
      getLastAuthEventSnapshot: () => lastAuthEventSnapshot,
    });

    // ── Auth Stability Gate ──────────────────────────────────────────────
    // Prevents transient INITIAL_SESSION(null) → SIGNED_OUT → SIGNED_IN boot
    // sequences from triggering org-clearing and "no-org" banner flashes.
    const NO_ORG_BANNER_SIGNED_IN_GRACE_MS = 2500;

    // ── end Auth Stability Gate ──────────────────────────────────────────
    // Expose to module-level ensureWorkspaceReadyForUI
    _authGateIsSettledAccessor = AuthService.authGateIsSettled;

    let readyToastShown = false;

    try {
      window.__TP3D_ORG_METRICS__ = orgContextMetrics;
    } catch {
      // ignore
    }

    function showReadyOnce() {
      if (readyToastShown) return;
      readyToastShown = true;
      UIComponents.showToast('Ready', 'success', { title: 'Truck Packer 3D' });
    }

    function canShowToast(key) {
      const now = Date.now();
      const last = toastDeduper.get(key) || 0;
      if (now - last < 2500) return false;
      toastDeduper.set(key, now);
      return true;
    }

    function getOverlayOpen() {
      try {
        if (window.SettingsOverlay?.isOpen?.() === true) return true;
      } catch {
        // ignore
      }
      try {
        if (window.AccountOverlay?.isOpen?.() === true) return true;
      } catch {
        // ignore
      }
      try {
        if (window.SettingsOverlay?.state?.isOpen === true) return true;
      } catch {
        // ignore
      }
      try {
        if (window.AccountOverlay?.state?.isOpen === true) return true;
      } catch {
        // ignore
      }
      try {
        if (SettingsOverlay && typeof SettingsOverlay.isOpen === 'function') {
          return Boolean(SettingsOverlay.isOpen());
        }
      } catch {
        // ignore
      }
      try {
        if (AccountOverlay && typeof AccountOverlay.isOpen === 'function') {
          return Boolean(AccountOverlay.isOpen());
        }
      } catch {
        // ignore
      }
      try {
        return Boolean(document.querySelector('[data-tp3d-settings-modal="1"]'));
      } catch {
        return false;
      }
    }

    _authTruthSnapshotAccessor = AuthService.authTruthAccessor;
    // Stage 1: mirror the same auth-truth accessor into Billing at its existing wiring
    // point. Root retains _authTruthSnapshotAccessor (ensureWorkspaceReadyForUI reads it);
    // Billing's getCurrentBillingAuthUserId reads its private copy set here.
    BillingService.setAuthTruthSnapshotAccessor(_authTruthSnapshotAccessor);

    // ── Organization / Workspace domain (Stage 2) ──────────────────────────
    // CP1: authoritative workspace-switch state machine lives in OrganizationService.
    // app.js remains authoritative for orgContext during CP1; reads bridge through
    // getOrgContextSnapshot. Auth stays in app.js (getSignedInUserIdStrict injected);
    // Billing (Stage 1) is frozen and only reached via injected BillingService.
    const OrganizationService = createOrganizationService({
      normalizeOrgIdForBilling,
      normalizeBillingEntitlementStatus,
      getSignedInUserIdStrict: AuthService.getSignedInUserIdStrict,
      BillingService,
      getOrgContextSnapshot: () => orgContext,
      getOrgContextTabId: () => orgContextTabId,
      ORG_UUID_RE,
    });
    // Break the Auth<->Org cycle: the gate reads local org id at runtime.
    AuthService.setReadLocalOrgIdAccessor(OrganizationService.readLocalOrgId);
    // Thin delegator (no state) retained so the early AutoPackEngine injection
    // (constructed before OrganizationService) and the TruckPackerApp facade keep a
    // stable getWorkspaceSwitchState reference. The single switch-state machine is
    // in OrganizationService.
    function getWorkspaceSwitchState() {
      return OrganizationService.getWorkspaceSwitchState();
    }

    function getCurrentAuthSnapshot() {
      const truth = AuthService.getAuthTruthSnapshot();
      let status = truth.status;
      let session = truth.session;
      let user;
      let userId = truth.userId;
      let hasToken = truth.hasToken;
      let hintOnly = false;

      // P0.7 – If the wrapper reports unknown/no-token but we have a recent real
      // auth event, trust the event snapshot instead (transient race window).
      if ((status !== 'signed_in' || !hasToken) && AuthService.shouldUseSignedInHint()) {
        if (lastAuthEventSnapshot && lastAuthEventSnapshot.session) {
          status = lastAuthEventSnapshot.status;
          session = lastAuthEventSnapshot.session;
          user = session && session.user ? session.user : null;
          userId = user && user.id ? String(user.id) : null;
          hasToken = true;
          hintOnly = true;
        }
      }

      return {
        status,
        userId,
        hasToken,
        session,
        authProof: Boolean(truth.isSignedIn),
        hintOnly,
        activeOrgId: orgContext.activeOrgId,
        activeOrg: orgContext.activeOrg,
        role: orgContext.role,
      };
    }

    async function hydrateActiveOrgId() {
      return refreshOrgContext('org-hydrate', { force: true, forceEmit: true });
    }

    async function persistActiveOrgSelection(nextId) {
      if (!nextId) return null;
      if (!SupabaseClient || typeof SupabaseClient.updateProfile !== 'function') {
        throw new Error('Active workspace persistence is unavailable.');
      }

      try {
        await SupabaseClient.updateProfile({ current_organization_id: nextId });
        if (typeof SupabaseClient.invalidateAccountCache === 'function') {
          SupabaseClient.invalidateAccountCache();
        }
        return nextId;
      } catch (err) {
        console.error('[orgContext] Failed to persist active workspace:', {
          nextOrgId: nextId,
          error: err,
        });
        throw err;
      }
    }

    async function setActiveOrgId(nextOrgId, { source = 'org-switch' } = {}) {
      const nextId = nextOrgId ? String(nextOrgId).trim() : '';
      if (!nextId) return null;

      const truth = AuthService.getAuthTruthSnapshot();
      if (!truth.isSignedIn) return null;

      const prevId = orgContext.activeOrgId ? String(orgContext.activeOrgId) : null;
      if (prevId && prevId === nextId) return prevId;

      const previousOrgContext = {
        ...orgContext,
        orgs: Array.isArray(orgContext.orgs) ? [...orgContext.orgs] : [],
      };
      const previousLocalOrgId = OrganizationService.readLocalOrgId();
      const previousWorkspaceOrgId = prevId || previousLocalOrgId || null;
      const previousWorkspaceUiResetKey = lastWorkspaceUiResetKey;

      const orgs = Array.isArray(orgContext.orgs) ? orgContext.orgs : [];
      const activeOrg = orgs.find(o => o && String(o.id) === nextId) || null;
      OrganizationService.beginWorkspaceSwitch(nextId, source);

      const applyLocalWorkspaceSelection = nextActiveOrg => {
        orgContext = {
          ...orgContext,
          activeOrgId: nextId,
          activeOrg: nextActiveOrg,
          role: nextActiveOrg ? (nextActiveOrg.role || orgContext.role || null) : orgContext.role,
          updatedAt: Date.now(),
        };
        applyWorkspaceScopedLocalState(nextId, { seedIfMissing: false });
        resetWorkspaceScopedUiState(nextId);
        OrganizationService.writeLocalOrgId(nextId);
        BillingService.reconcileBillingStateForActiveOrg('org-set');
        syncWorkspaceUiAfterOrgRefresh(source);
        maybeScheduleBillingRefresh('org-changed');
        queueOrgScopedRender('org-set');
        OrganizationService.markWorkspaceSwitchReady({ localStateReady: true }, 'local-state-ready');
        OrganizationService.markWorkspaceSwitchOrgReadyIfResolved('org-ready');
        OrganizationService.markWorkspaceSwitchBillingReadyIfSettled(BillingService.getBillingState(), 'billing-current');
      };

      const rollbackLocalWorkspaceSelection = () => {
        orgContext = previousOrgContext;
        lastWorkspaceUiResetKey = previousWorkspaceUiResetKey;
        OrganizationService.writeLocalOrgId(previousLocalOrgId);
        applyWorkspaceScopedLocalState(previousWorkspaceOrgId, {
          seedIfMissing: false,
          force: true,
        });
        syncWorkspaceUiAfterOrgRefresh(`${source}:rollback`);
        OrganizationService.finishWorkspaceSwitch('rollback');
      };

      if (!activeOrg) {
        applyLocalWorkspaceSelection(null);
        try {
          await persistActiveOrgSelection(nextId);
        } catch (err) {
          rollbackLocalWorkspaceSelection();
          throw err;
        }
        OrganizationService.dispatchOrgContextChanged({
          orgId: nextId,
          reason: source,
          broadcast: true,
          source: 'set-active-org',
          userId: truth.userId,
        });
        await refreshOrgContext(source, { force: true, forceEmit: true });
        OrganizationService.markWorkspaceSwitchOrgReadyIfResolved('org-context-refreshed');
        OrganizationService.markWorkspaceSwitchBillingReadyIfSettled(BillingService.getBillingState(), 'billing-after-org-refresh');
        return nextId;
      }

      applyLocalWorkspaceSelection(activeOrg);
      try {
        await persistActiveOrgSelection(nextId);
      } catch (err) {
        rollbackLocalWorkspaceSelection();
        throw err;
      }

      try {
        OrganizationService.dispatchOrgContextChanged({
          orgId: nextId,
          reason: source,
          broadcast: true,
          source: 'set-active-org',
          userId: truth.userId,
        });
        orgContextMetrics.orgChangedEmitted += 1;
      } catch {
        // ignore
      }
      return nextId;
    }

    const OrgContext = {
      getActiveOrgId: OrganizationService.getActiveOrgId,
      setActiveOrgId,
      hydrateActiveOrgId,
      getActiveRole: OrganizationService.getActiveRole,
    };

    try {
      window.OrgContext = OrgContext;
    } catch {
      // ignore
    }

    function handleIncomingOrgContextSync(payload, { source = 'org-sync-storage' } = {}) {
      if (!payload || typeof payload !== 'object') return false;
      const incomingOrgId = payload.orgId ? String(payload.orgId).trim() : '';
      if (!incomingOrgId || !ORG_UUID_RE.test(incomingOrgId)) return false;

      const payloadUserId = payload.userId ? String(payload.userId) : '';
      const currentUserId = AuthService.getSignedInUserIdStrict();
      if (!currentUserId || !payloadUserId || payloadUserId !== currentUserId) return false;

      const incomingTabId = payload.tabId ? String(payload.tabId) : '';
      if (incomingTabId && incomingTabId === orgContextTabId) return false;

      const incomingVersion = OrganizationService.getOrgContextEffectiveVersion(payload);
      if (!incomingVersion) return false;
      if (OrganizationService.compareOrgContextOrder(incomingVersion, incomingTabId) <= 0) {
        if (isTp3dDebugEnabled()) {
          console.info('[orgContext] ignore-stale-sync', {
            source,
            incomingVersion,
            lastAppliedOrgContextVersion: OrganizationService.getOrgContextVersionState().lastAppliedOrgContextVersion,
          });
        }
        return false;
      }

      if (isTp3dDebugEnabled()) {
        console.info('[orgContext] sync-version', {
          source,
          incomingVersion,
          lastAppliedVersion: OrganizationService.getOrgContextVersionState().lastAppliedOrgContextVersion,
          applied: true,
          incomingOrgId,
          incomingUserId: payloadUserId,
        });
      }

      OrganizationService.markOrgContextVersion(incomingVersion, incomingTabId);

      const currentOrgId = orgContext.activeOrgId ? String(orgContext.activeOrgId) : null;
      const isSwitchingOrg = !currentOrgId || currentOrgId !== incomingOrgId;
      if (isSwitchingOrg) {
        OrganizationService.beginWorkspaceSwitch(incomingOrgId, source);
      }
      OrganizationService.writeLocalOrgId(incomingOrgId);
      if (!currentOrgId || currentOrgId !== incomingOrgId) {
        const knownOrgs = Array.isArray(orgContext.orgs) ? orgContext.orgs : [];
        const incomingOrg = knownOrgs.find(o => o && String(o.id) === incomingOrgId) || null;
        orgContext = {
          ...orgContext,
          activeOrgId: incomingOrgId,
          activeOrg: incomingOrg || null,
          role: incomingOrg && incomingOrg.role ? incomingOrg.role : orgContext.role,
          updatedAt: Date.now(),
        };
      }
      applyWorkspaceScopedLocalState(incomingOrgId, { seedIfMissing: false });
      resetWorkspaceScopedUiState(incomingOrgId);
      BillingService.reconcileBillingStateForActiveOrg('org-sync');
      if (isSwitchingOrg) {
        OrganizationService.markWorkspaceSwitchReady({ localStateReady: true }, 'org-sync:local-state-ready');
        OrganizationService.markWorkspaceSwitchOrgReadyIfResolved('org-sync:org-ready');
        OrganizationService.markWorkspaceSwitchBillingReadyIfSettled(BillingService.getBillingState(), 'org-sync:billing-current');
      }

      OrganizationService.dispatchOrgContextChanged({
        orgId: incomingOrgId,
        reason: payload.reason || source,
        version: incomingVersion,
        broadcast: false,
        source,
        ts: payload.ts || payload.timestamp,
        tabId: incomingTabId,
        userId: currentUserId,
      });

      applyOrgRequiredUi(true);
      queueOrgScopedRender(source);
      _orgRoleHydrationGraceUntilByOrg.set(incomingOrgId, Date.now() + _ORG_ROLE_GRACE_MS);
      // Set inflight flag ASAP so hydration checker sees it immediately
      _orgBundleFetchInflightForOrg = incomingOrgId;
      maybeScheduleBillingRefresh('org-changed');

      if (isLogoutInProgress() || !AuthService.authGateIsSettled()) {
        orgContextQueued = true;
        return true;
      }
      void refreshOrgContext(source, { force: true, forceEmit: false })
        .then(() => OrganizationService.markWorkspaceSwitchOrgReadyIfResolved('org-sync:org-context-refreshed'))
        .catch(() => { });
      return true;
    }

    // ── Billing org-ready pump: retries refreshBilling until orgId resolves ──
    const BILLING_PUMP_RETRY_MS = 200;
    const BILLING_PUMP_MAX_TRIES = 12;
    const BILLING_PUMP_FRESH_MS = 30000;
    const BILLING_PUMP_COOLDOWN_MS = 5000;
    const BILLING_PUMP_HARD_COOLDOWN_MS = 10000;
    const _BILLING_PUMP_FORCE_REASONS = new Set(['org-changed', 'manual', 'org-context:partial', 'autopack-org-mismatch']);
    const _BILLING_PUMP_COOLDOWN_REASONS = new Set(['render-auth-state', 'org-context', 'tab-visible', 'settings-open', 'storage']);
    let _billingPumpTimer = null;
    let _billingPumpTries = 0;
    let _billingPumpEverRan = false;
    const _billingPumpLastByReason = new Map();
    let _billingPumpLastRunAtMs = 0;

    function resetBillingPumpForUserSwitch() {
      clearTimeout(_billingPumpTimer);
      _billingPumpTimer = null;
      _billingPumpTries = 0;
      _billingPumpEverRan = false;
      _billingPumpLastByReason.clear();
      _billingPumpLastRunAtMs = 0;
      BillingService.resetRefreshDedupForUserSwitch();
    }

    function maybeScheduleBillingRefresh(reason) {
      BillingService.billingAuthLifecycleDebugLog('billing-pump-enter', {
        reason,
        authUserIdTail: BillingService.abbreviateBillingLifecycleId(BillingService.getCurrentBillingAuthUserId()),
      });
      // ── Auth gate: never pump billing without a proven or usable session ──
      const _proven = typeof SupabaseClient.isAuthProven === 'function' && SupabaseClient.isAuthProven();
      if (!_proven) {
        const _truth = AuthService.getAuthTruthSnapshot();
        const _sessionUsable = Boolean(
          _truth && _truth.session && _truth.session.access_token &&
          _truth.session.expires_at && (_truth.session.expires_at * 1000) > Date.now()
        );
        if (!_sessionUsable) {
          billingDebugLog('[BillingPump] skip:auth-not-proven', {
            reason,
            orgId: OrganizationService.getActiveOrgIdNow() || null,
            status: _truth ? _truth.status : null,
          });
          return;
        }
      }

      const activeOrgId = OrganizationService.getActiveOrgIdNow();
      const now = Date.now();

      if (!activeOrgId) {
        // No org yet — schedule a retry if under the limit
        if (_billingPumpTries >= BILLING_PUMP_MAX_TRIES) {
          billingDebugLog('[BillingPump] give-up', { reason, tries: _billingPumpTries });
          _billingPumpTries = 0;
          return;
        }
        _billingPumpTries += 1;
        clearTimeout(_billingPumpTimer);
        _billingPumpTimer = setTimeout(() => {
          maybeScheduleBillingRefresh(reason);
        }, BILLING_PUMP_RETRY_MS);
        billingDebugLog('[BillingPump] retry-scheduled', { reason, try: _billingPumpTries });
        return;
      }

      // Org available — reset retry counter
      _billingPumpTries = 0;
      clearTimeout(_billingPumpTimer);

      const snap = (typeof window !== 'undefined' && window.__TP3D_BILLING
        && typeof window.__TP3D_BILLING.getBillingState === 'function')
        ? window.__TP3D_BILLING.getBillingState() : null;
      const snapOrgId = normalizeOrgIdForBilling(snap && snap.orgId ? snap.orgId : '');
      const authoritativeRefresh = BillingService.getBillingAuthoritativeRefreshToken(activeOrgId);
      const authoritativeRefreshRequired = Boolean(authoritativeRefresh);
      if (authoritativeRefreshRequired && BillingService.isBillingAuthoritativeRefreshInFlight(authoritativeRefresh)) {
        billingDebugLog('[BillingPump] skip:authoritative-inflight', {
          reason,
          orgId: activeOrgId,
          generation: authoritativeRefresh.generation,
        });
        return;
      }
      const authoritativeRefreshMustStart = Boolean(
        authoritativeRefreshRequired && !authoritativeRefresh.attemptedAt
      );
      let billingOrgMismatch = Boolean(snapOrgId && snapOrgId !== activeOrgId);
      const billingOrgMismatchAtStart = billingOrgMismatch;
      if (billingOrgMismatch) {
        const shared = BillingService._readShareableBillingResult(activeOrgId, 'pump-mismatch:' + reason);
        if (shared) {
          BillingService._applySharedBillingSnapshot(activeOrgId, shared, 'pump-mismatch-shared:' + reason);
          const nextSnapOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
          billingOrgMismatch = Boolean(nextSnapOrgId && nextSnapOrgId !== activeOrgId);
        }
      }
      const reasonIsForce = _BILLING_PUMP_FORCE_REASONS.has(reason) ||
        billingOrgMismatchAtStart ||
        billingOrgMismatch ||
        authoritativeRefreshMustStart;

      // ── Hard cooldown: absolute minimum time between any pump runs ──
      if (!reasonIsForce && _billingPumpLastRunAtMs && (now - _billingPumpLastRunAtMs) < BILLING_PUMP_HARD_COOLDOWN_MS) {
        billingDebugLog('[BillingPump] skip:hard-cooldown', { reason, ageMs: now - _billingPumpLastRunAtMs });
        return;
      }

      // ── Strong "already fresh" guard: skip if billing is current for this org ──
      if (
        snap &&
        snap.ok === true &&
        !snap.loading &&
        !snap.pending &&
        !snap.error &&
        snap.orgId &&
        String(snap.orgId) === String(activeOrgId) &&
        snap.lastFetchedAt &&
        (now - snap.lastFetchedAt) < BILLING_PUMP_FRESH_MS &&
        !authoritativeRefreshRequired &&
        !reasonIsForce
      ) {
        billingDebugLog('[BillingPump] skip:fresh', {
          reason,
          orgId: activeOrgId,
          ageMs: now - snap.lastFetchedAt,
        });
        return;
      }

      // ── Cross-tab shared freshness: skip if another tab recently fetched ──
      if (!reasonIsForce && !authoritativeRefreshRequired && activeOrgId) {
        const sharedFreshAt = BillingService._getSharedBillingFreshness(activeOrgId);
        if (sharedFreshAt && (now - sharedFreshAt) < _BILLING_SHARED_FRESH_MS) {
          const shared = BillingService._readShareableBillingResult(activeOrgId, 'pump:' + reason);
          if (shared) {
            billingDebugLog('billing:cross-tab-lock:skip-fresh', {
              reason: 'pump:' + reason,
              orgId: activeOrgId,
              sharedAgeMs: now - sharedFreshAt,
            });
            // Reuse shared result if our local state is older.
            if (BillingService._shouldApplySharedBillingSnapshotForOrg(activeOrgId, sharedFreshAt)) {
              BillingService._applySharedBillingSnapshot(activeOrgId, shared, 'shared-fresh-pump:' + reason);
            }
            return;
          }
          const unshareableShared = BillingService._readSharedBillingResult(activeOrgId);
          if (unshareableShared) {
            billingDebugLog('billing:cross-tab-lock:ignore-fresh-org-mismatch', {
              reason: 'pump:' + reason,
              orgId: activeOrgId,
              stateOrgId: unshareableShared && unshareableShared.orgId ? unshareableShared.orgId : null,
            });
          } else {
            billingDebugLog('billing:cross-tab-lock:ignore-fresh-missing-result', {
              reason: 'pump:' + reason,
              orgId: activeOrgId,
              sharedAgeMs: now - sharedFreshAt,
            });
          }
        }
      }

      // ── Per-reason cooldown (selected reasons only) ──
      if (_BILLING_PUMP_COOLDOWN_REASONS.has(reason)) {
        const lastAt = _billingPumpLastByReason.get(reason) || 0;
        if (!authoritativeRefreshMustStart && (now - lastAt) < BILLING_PUMP_COOLDOWN_MS) {
          billingDebugLog('[BillingPump] skip:cooldown', { reason, ageMs: now - lastAt });
          return;
        }
        if (authoritativeRefreshMustStart && (now - lastAt) < BILLING_PUMP_COOLDOWN_MS) {
          billingDebugLog('[BillingPump] bypass:authoritative-cooldown', {
            reason,
            orgId: activeOrgId,
            generation: authoritativeRefresh.generation,
            ageMs: now - lastAt,
          });
        }
      }
      _billingPumpLastByReason.set(reason, now);

      // ── Decide force: only org-changed, manual, or first-ever pump ──
      const shouldForce = authoritativeRefreshRequired || reasonIsForce || !_billingPumpEverRan;
      _billingPumpEverRan = true;

      _billingPumpLastRunAtMs = now;
      billingDebugLog('[BillingPump] run', { reason, orgId: activeOrgId, force: shouldForce });
      BillingService.refreshBilling({
        force: shouldForce,
        reason: 'pump:' + reason,
        ...(authoritativeRefresh ? { authoritativeRefresh } : {}),
      }).catch(() => { });
    }

    function handleOrgAccessLoss(orgId, meta = {}) {
      const lostOrgId = normalizeOrgIdForBilling(orgId || '');
      if (!lostOrgId) return false;

      const truth = AuthService.getAuthTruthSnapshot();
      if (!truth || !truth.isSignedIn || !truth.userId) return false;

      const activeOrgId = OrganizationService.getActiveOrgIdNow();
      if (!activeOrgId || activeOrgId !== lostOrgId) return false;

      const now = Date.now();
      const lastAt = _orgAccessLossLastAt.get(lostOrgId) || 0;
      if ((now - lastAt) < ORG_ACCESS_LOSS_COOLDOWN_MS) return true;
      _orgAccessLossLastAt.set(lostOrgId, now);

      BillingService.clearBillingPendingRetry(lostOrgId);
      const billingOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
      if (billingOrgId === lostOrgId) {
        // _clearBillingSnapshotForOrgTransition() is for switching to a different org.
        // Here the stale billing snapshot is the lost org itself, so use the existing full billing cleanup.
        BillingService.clearBillingState();
      }

      try {
        window.dispatchEvent(new CustomEvent('tp3d:org-access-lost', {
          detail: { orgId: lostOrgId, userId: truth.userId, ts: now },
        }));
      } catch {
        // ignore
      }

      try {
        const _uic = typeof window !== 'undefined' && window.__TP3D_UI ? window.__TP3D_UI : null;
        if (_uic && typeof _uic.showToast === 'function') {
          _uic.showToast(
            'You no longer have access to this workspace. Switch workspace or contact the owner.',
            'warning',
            { title: 'Workspace access', duration: 8000 },
          );
        }
      } catch {
        // ignore
      }

      try {
        if (isTp3dDebugEnabled()) {
          console.info('[orgContext] access-lost', {
            orgId: lostOrgId,
            reason: meta && meta.reason ? String(meta.reason) : null,
            status: meta && meta.status != null ? Number(meta.status) : null,
          });
        }
      } catch {
        // ignore
      }

      window.setTimeout(() => {
        const currentActiveOrgId = OrganizationService.getActiveOrgIdNow();
        if (!currentActiveOrgId || currentActiveOrgId !== lostOrgId) return;
        refreshOrgContext('access-loss-detected', { force: true, forceEmit: true }).catch(() => { });
      }, 0);

      return true;
    }

    function handleWorkspaceLeft(leftOrgId, options = {}) {
      const normalizedLeftOrgId = normalizeOrgIdForBilling(leftOrgId || '');
      if (!normalizedLeftOrgId) return false;

      const activeOrgId = OrganizationService.getActiveOrgIdNow();
      const wasActiveOrg = activeOrgId === normalizedLeftOrgId;

      BillingService.clearBillingPendingRetry(normalizedLeftOrgId);
      if (wasActiveOrg) {
        const billingOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
        if (billingOrgId === normalizedLeftOrgId) {
          BillingService.clearBillingState();
        }
      }

      const source = options && options.source ? String(options.source) : 'workspace-left';
      try {
        if (SupabaseClient && typeof SupabaseClient.invalidateAccountCache === 'function') {
          SupabaseClient.invalidateAccountCache();
        }
      } catch {
        // ignore
      }
      syncWorkspaceUiAfterOrgRefresh(source);
      const refreshPromise = refreshOrgContext(source, { force: true, forceEmit: true })
        .then(result => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refreshed');
          return result;
        })
        .catch(() => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refresh-error');
          return null;
        });
      return refreshPromise;
    }

    function handleWorkspaceArchived(archivedOrgId, options = {}) {
      const normalizedArchivedOrgId = normalizeOrgIdForBilling(archivedOrgId || '');
      if (!normalizedArchivedOrgId) return false;

      const activeOrgId = OrganizationService.getActiveOrgIdNow();
      const wasActiveOrg = activeOrgId === normalizedArchivedOrgId;

      BillingService.clearBillingPendingRetry(normalizedArchivedOrgId);
      if (wasActiveOrg) {
        const billingOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
        if (billingOrgId === normalizedArchivedOrgId) {
          BillingService.clearBillingState();
        }
      }

      const source = options && options.source ? String(options.source) : 'workspace-archived';
      try {
        if (SupabaseClient && typeof SupabaseClient.invalidateAccountCache === 'function') {
          SupabaseClient.invalidateAccountCache();
        }
      } catch {
        // ignore
      }
      syncWorkspaceUiAfterOrgRefresh(source);
      const refreshPromise = refreshOrgContext(source, { force: true, forceEmit: true })
        .then(result => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refreshed');
          return result;
        })
        .catch(() => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refresh-error');
          return null;
        });
      return refreshPromise;
    }

    function handleWorkspaceRestored(restoredOrgId, options = {}) {
      const normalizedRestoredOrgId = normalizeOrgIdForBilling(restoredOrgId || '');
      if (!normalizedRestoredOrgId) return false;

      const activeOrgIdBefore = OrganizationService.getActiveOrgIdNow();
      const hadActiveOrgBefore = Boolean(activeOrgIdBefore);

      BillingService.clearBillingPendingRetry(normalizedRestoredOrgId);
      const billingOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
      if (billingOrgId === normalizedRestoredOrgId) {
        BillingService.clearBillingState();
      }

      const source = options && options.source ? String(options.source) : 'workspace-restored';
      try {
        if (SupabaseClient && typeof SupabaseClient.invalidateAccountCache === 'function') {
          SupabaseClient.invalidateAccountCache();
        }
      } catch {
        // ignore
      }
      syncWorkspaceUiAfterOrgRefresh(source);
      const refreshPromise = refreshOrgContext(source, { force: true, forceEmit: true })
        .then(async result => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refreshed');
          if (!hadActiveOrgBefore && typeof setActiveOrgId === 'function') {
            const refreshedOrgs = Array.isArray(result && result.orgs)
              ? result.orgs
              : (Array.isArray(orgContext && orgContext.orgs) ? orgContext.orgs : []);
            const restoredOrgVisible = refreshedOrgs.some(org => (
              org && normalizeOrgIdForBilling(org.id || '') === normalizedRestoredOrgId
            ));
            if (restoredOrgVisible) {
              await setActiveOrgId(normalizedRestoredOrgId, { source: source + ':activate-restored' }).catch(() => null);
            }
          }
          maybeScheduleBillingRefresh(source);
          return result;
        })
        .catch(() => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refresh-error');
          return null;
        });
      return refreshPromise;
    }

    function handleOwnershipTransferred(orgId, options = {}) {
      const normalizedOrgId = normalizeOrgIdForBilling(orgId || '');
      if (!normalizedOrgId) return false;

      BillingService.clearBillingPendingRetry(normalizedOrgId);
      const billingOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
      if (billingOrgId === normalizedOrgId) {
        BillingService.clearBillingState();
      }

      const source = options && options.source ? String(options.source) : 'ownership-transferred';
      try {
        if (SupabaseClient && typeof SupabaseClient.invalidateAccountCache === 'function') {
          SupabaseClient.invalidateAccountCache();
        }
      } catch {
        // ignore
      }
      syncWorkspaceUiAfterOrgRefresh(source);
      const refreshPromise = refreshOrgContext(source, { force: true, forceEmit: true })
        .then(result => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refreshed');
          maybeScheduleBillingRefresh(source);
          return result;
        })
        .catch(() => {
          syncWorkspaceUiAfterOrgRefresh(source + ':refresh-error');
          return null;
        });
      return refreshPromise;
    }

    // Reconcile a server-confirmed organization update (e.g. a workspace rename)
    // into canonical org-context state without a network refetch: the caller
    // already has the fresh row from updateOrganization(). Unlike archive/
    // restore/transfer, a field-level update never changes which orgs are
    // visible or owned, so a full refreshOrgContext() round-trip is not needed.
    function handleWorkspaceUpdated(updatedOrg, options = {}) {
      const normalizedOrgId = normalizeOrgIdForBilling((updatedOrg && updatedOrg.id) || '');
      if (!normalizedOrgId || !updatedOrg) return false;

      const source = options && options.source ? String(options.source) : 'workspace-updated';
      const activeOrgId = orgContext.activeOrgId ? String(orgContext.activeOrgId) : null;
      const isActiveOrg = activeOrgId === normalizedOrgId;

      const existingOrgs = Array.isArray(orgContext.orgs) ? orgContext.orgs : [];
      const orgIndex = existingOrgs.findIndex(
        org => org && normalizeOrgIdForBilling(org.id || '') === normalizedOrgId
      );
      const inCollection = orgIndex >= 0;
      if (!inCollection && !isActiveOrg) return false;

      const nextOrgs = inCollection
        ? existingOrgs.map((org, idx) => (idx === orgIndex ? { ...org, ...updatedOrg } : org))
        : existingOrgs;

      orgContext = {
        ...orgContext,
        orgs: nextOrgs,
        activeOrg: isActiveOrg ? { ...(orgContext.activeOrg || {}), ...updatedOrg } : orgContext.activeOrg,
        updatedAt: Date.now(),
      };

      try {
        if (SupabaseClient && typeof SupabaseClient.invalidateAccountCache === 'function') {
          SupabaseClient.invalidateAccountCache();
        }
      } catch {
        // ignore
      }

      if (isActiveOrg) {
        OrganizationService.dispatchOrgContextChanged({
          orgId: normalizedOrgId,
          reason: source,
          broadcast: true,
          source: 'workspace-updated',
        });
      }
      queueOrgScopedRender(source);
      return true;
    }

    // Expose billing pump globally for SettingsOverlay (avoids import coupling)
    try {
      window.TruckPackerApp = window.TruckPackerApp || {};
      window.TruckPackerApp.maybeScheduleBillingRefresh = maybeScheduleBillingRefresh;
      window.TruckPackerApp.getWorkspaceSwitchState = getWorkspaceSwitchState;
      window.TruckPackerApp.notifyOrgAccessLoss = handleOrgAccessLoss;
      window.TruckPackerApp.handleWorkspaceLeft = handleWorkspaceLeft;
      window.TruckPackerApp.handleWorkspaceArchived = handleWorkspaceArchived;
      window.TruckPackerApp.handleWorkspaceRestored = handleWorkspaceRestored;
      window.TruckPackerApp.handleOwnershipTransferred = handleOwnershipTransferred;
      window.TruckPackerApp.handleWorkspaceUpdated = handleWorkspaceUpdated;
      BillingService.setOrgAccessLossHandler(handleOrgAccessLoss);
    } catch { /* ignore */ }

    function resolveOrgContextFromBundle(bundle) {
      const orgs = Array.isArray(bundle && bundle.orgs) ? bundle.orgs : [];
      const profile = bundle && bundle.profile ? bundle.profile : null;
      const membership = bundle && bundle.membership ? bundle.membership : null;
      const normalizeOrgId = value => {
        if (value === null || typeof value === 'undefined') return null;
        const str = String(value).trim();
        return str ? str : null;
      };

      const profileOrgId = normalizeOrgId(
        profile &&
        (profile.current_organization_id ||
          profile.current_org_id ||
          profile.currentOrgId ||
          profile.currentOrgID)
      );
      const localOrgId = normalizeOrgId(OrganizationService.readLocalOrgId());
      const membershipOrgId = normalizeOrgId(
        membership && membership.organization_id ? membership.organization_id : null
      );
      const activeOrgHint = normalizeOrgId(bundle && bundle.activeOrgId ? bundle.activeOrgId : null);
      const hasOrg = id => id && orgs.some(o => o && String(o.id) === String(id));

      let orgId = null;
      // Prefer explicit local selection first so post-invite org switches don't get
      // immediately reverted by a stale profile.current_organization_id snapshot.
      if (localOrgId && hasOrg(localOrgId)) orgId = localOrgId;
      else if (profileOrgId && hasOrg(profileOrgId)) orgId = profileOrgId;
      else if (activeOrgHint && hasOrg(activeOrgHint)) orgId = activeOrgHint;
      else if (membershipOrgId && hasOrg(membershipOrgId)) orgId = membershipOrgId;
      else if (orgs.length > 0) orgId = String(orgs[0].id);

      const activeOrg = orgId ? orgs.find(o => o && String(o.id) === String(orgId)) || null : null;
      let role = null;
      if (membership && orgId && membership.organization_id && String(membership.organization_id) === String(orgId)) {
        role = membership.role || null;
      } else if (activeOrg && activeOrg.role) {
        role = activeOrg.role;
      }

      return { orgId, activeOrg, orgs, role, profileOrgId, profile };
    }

    // ── Workspace-ready event replay buffer ──
    let _lastWorkspaceReadyDetail = null;
    let _lastWorkspaceReadyAt = 0;
    const WORKSPACE_READY_REPLAY_MS = 5000;
    let orgRequiredStateReason = '';

    function resetWorkspaceScopedUiState(targetOrgId) {
      const resetKey = targetOrgId ? `org:${String(targetOrgId)}` : 'no-org';
      if (lastWorkspaceUiResetKey === resetKey) return;
      lastWorkspaceUiResetKey = resetKey;
      try {
        if (PacksUI && typeof PacksUI.resetWorkspaceState === 'function') {
          PacksUI.resetWorkspaceState();
        }
        if (CasesUI && typeof CasesUI.resetWorkspaceState === 'function') {
          CasesUI.resetWorkspaceState();
        }
        if (EditorUI && typeof EditorUI.resetWorkspaceState === 'function') {
          EditorUI.resetWorkspaceState();
        }
        // Menus opened in the previous workspace (e.g. a Pack's Export action)
        // are dismissed; their actions also re-check scope when chosen.
        UIComponents.closeAllDropdowns();
      } catch {
        // ignore
      }

      const currentPackId = StateStore.get('currentPackId');
      const selectedIds = StateStore.get('selectedInstanceIds') || [];
      const currentScreen = StateStore.get('currentScreen');
      const needsReset = Boolean(currentPackId) || selectedIds.length > 0 || currentScreen !== 'packs';
      if (!needsReset) return;

      StateStore.set({
        currentScreen: 'packs',
        currentPackId: null,
        selectedInstanceIds: [],
      }, { skipHistory: true });
    }

    function clearOrgContext({ clearLocalOrgHint = false, confirmedNoOrg = false, reason = '' } = {}) {
      OrganizationService.finishWorkspaceSwitch('org-cleared');
      orgContext = {
        activeOrgId: null,
        activeOrg: null,
        orgs: [],
        role: null,
        updatedAt: Date.now(),
      };
      OrganizationService.resetOrgContextVersion();
      _orgBundleFetchInflightForOrg = null;
      _orgRoleHydrationGraceUntilByOrg.clear();
      lastOrgIdNotified = null;
      lastOrgChangeAt = 0;
      lastWorkspaceUiResetKey = '';
      setWorkspaceStorageScope(null);
      lastLoadedWorkspaceStorageKey = '';
      if (clearLocalOrgHint || confirmedNoOrg) OrganizationService.writeLocalOrgId(null);
      if (confirmedNoOrg) {
        orgRequiredStateReason = String(reason || '');
        BillingService.clearBillingAuthoritativeRefreshRequirement(null, 'confirmed-no-workspace');
        // BUG-01: confirmed no-workspace is a terminal state for the current
        // identity — release the user-switch promotion guard so it cannot stay
        // latched true for a user with zero active workspaces.
        try { window.__TP3D_USER_SWITCH_PENDING = false; } catch (_) { /* ignore */ }
        suspendAutoSave = true;
        try {
          resetAppStateToEmpty();
        } finally {
          suspendAutoSave = false;
        }
        resetWorkspaceScopedUiState(null);
      }
      orgContextResolved = Boolean(confirmedNoOrg);
      applyOrgRequiredUi(false, { confirmedNoOrg });
      queueOrgScopedRender('org-cleared');
      if (confirmedNoOrg) {
        const clearedUserId = AuthService.getSignedInUserIdStrict();
        if (clearedUserId) {
          OrganizationService.dispatchOrgContextChanged({
            orgId: '',
            allowEmpty: true,
            confirmedNoOrg: true,
            reason: reason || 'org-cleared',
            source: 'clear-org-context',
            broadcast: false,
            userId: clearedUserId,
          });
        }
      }
    }

    let orgScopedRenderTimer = null;
    function queueOrgScopedRender(_reason) {
      if (orgScopedRenderTimer) return;
      orgScopedRenderTimer = setTimeout(() => {
        orgScopedRenderTimer = null;
        try {
          PacksUI.render();
        } catch {
          // ignore
        }
        try {
          CasesUI.render();
        } catch {
          // ignore
        }
        try {
          EditorUI.render();
        } catch {
          // ignore
        }
        try {
          RecoverableErrorOverlay.syncRecoverableErrorOverlay();
        } catch {
          // ignore
        }
        try {
          syncWorkspaceUiAfterOrgRefresh(_reason);
        } catch {
          // ignore
        }
      }, 0);
    }

    const ORG_REQUIRED_BANNER_ID = 'tp3d-org-required-banner';
    let orgBannerRetryTimer = null;
    let orgBannerSignedInGraceTimer = null;
    function ensureOrgRequiredBanner() {
      const container = document && document.querySelector ? document.querySelector('.content') : null;
      if (!container) return null;
      let banner = document.getElementById(ORG_REQUIRED_BANNER_ID);
      if (banner) return banner;

      banner = document.createElement('div');
      banner.id = ORG_REQUIRED_BANNER_ID;
      banner.className = 'card tp3d-org-required-banner';
      banner.innerHTML = `
        <div class="tp3d-org-required-content">
          <div class="tp3d-org-required-title">Create or join a workspace</div>
          <div class="tp3d-org-required-sub muted">
            You need a workspace to manage packs, cases, and editor data. Open Settings to create one or join with an invite link.
          </div>
        </div>
        <div class="tp3d-org-required-actions">
          <button class="btn btn-primary" type="button" data-action="org-settings">Open Settings</button>
        </div>
      `;

      const actionBtn = banner.querySelector('[data-action="org-settings"]');
      if (actionBtn) {
        actionBtn.addEventListener('click', () => {
          try {
            openSettingsOverlay('org-general');
          } catch {
            // ignore
          }
        });
      }

      container.prepend(banner);
      return banner;
    }

    function setDisabled(el, disabled) {
      if (!el) return;
      el.disabled = Boolean(disabled);
      el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    function applyOrgRequiredUi(hasOrg, { confirmedNoOrg = false } = {}) {
      const banner = ensureOrgRequiredBanner();
      if (!banner) {
        if (!orgBannerRetryTimer) {
          orgBannerRetryTimer = window.setTimeout(() => {
            orgBannerRetryTimer = null;
            applyOrgRequiredUi(hasOrg, { confirmedNoOrg });
          }, 0);
        }
        return;
      }

      if (orgBannerRetryTimer) {
        window.clearTimeout(orgBannerRetryTimer);
        orgBannerRetryTimer = null;
      }

      const titleEl = banner.querySelector('.tp3d-org-required-title');
      const subEl = banner.querySelector('.tp3d-org-required-sub');
      if (hasOrg) {
        orgRequiredStateReason = '';
      }
      if (titleEl && subEl) {
        if (orgRequiredStateReason === 'workspace-archived') {
          titleEl.textContent = 'Workspace archived';
          subEl.textContent = 'You do not have any active workspaces right now. Create a new workspace or restore an archived workspace when restore is available.';
        } else {
          titleEl.textContent = 'Create or join a workspace';
          subEl.textContent = 'You need a workspace to manage load plans, cases, and editor data. Open Settings to create one or join with an invite link.';
        }
      }

      const authSnapshot = getCurrentAuthSnapshot();
      // Use definitively signed-out (not 'unknown'/'checking') so we don't flash the banner
      // while auth is still resolving on slow connections.
      const isDefinitelySignedOut = Boolean(authSnapshot && authSnapshot.status === 'signed_out');
      const isSignedInForNoOrgBanner = Boolean(
        authSnapshot && authSnapshot.userId && authSnapshot.hasToken && authSnapshot.status !== 'signed_out'
      );
      // P0.7 – If the wrapper says signed_out but the last real auth event was
      // signed_in within the fallback TTL, treat it as a transient glitch.
      const isTransientSignedOut = isDefinitelySignedOut && lastAuthEventSnapshot
        && lastAuthEventSnapshot.status === 'signed_in' && lastAuthEventSnapshot.hasToken
        && (Date.now() - (lastAuthEventSnapshot.ts || 0)) < FALLBACK_AUTH_TTL_MS;
      const signedInSnapshotAgeMs = lastAuthEventSnapshot &&
        lastAuthEventSnapshot.status === 'signed_in' &&
        lastAuthEventSnapshot.hasToken
        ? Date.now() - (lastAuthEventSnapshot.ts || 0)
        : Infinity;
      const suppressRecentSignedInNoOrg = signedInSnapshotAgeMs < NO_ORG_BANNER_SIGNED_IN_GRACE_MS;
      // A stored org hint means the user has (or recently had) an org — keep banner hidden
      // while auth/bundle is still resolving (prevents flash for returning users).
      const hasLocalOrgHint = Boolean(OrganizationService.readLocalOrgId());
      const suppressUncertain = !isDefinitelySignedOut && !confirmedNoOrg && hasLocalOrgHint;
      // Auth Stability Gate: never show banner while auth is still settling
      const authNotSettled = !AuthService.authGateIsSettled();
      const orgContextBusy = Boolean(orgContextInFlight || authRehydratePromise);
      const hasResolvedNoActiveOrg = Boolean(
        confirmedNoOrg &&
        orgContextResolved &&
        orgContext &&
        !orgContext.activeOrgId &&
        Array.isArray(orgContext.orgs) &&
        orgContext.orgs.length === 0
      );
      const showNoOrgBanner = Boolean(
        !hasOrg &&
        isSignedInForNoOrgBanner &&
        hasResolvedNoActiveOrg &&
        !suppressUncertain &&
        !isTransientSignedOut &&
        !suppressRecentSignedInNoOrg &&
        !authNotSettled &&
        !orgContextBusy
      );
      if (orgBannerSignedInGraceTimer && (hasOrg || !confirmedNoOrg || !suppressRecentSignedInNoOrg)) {
        window.clearTimeout(orgBannerSignedInGraceTimer);
        orgBannerSignedInGraceTimer = null;
      }
      if (!hasOrg && suppressRecentSignedInNoOrg && confirmedNoOrg && !orgBannerSignedInGraceTimer) {
        orgBannerSignedInGraceTimer = window.setTimeout(() => {
          orgBannerSignedInGraceTimer = null;
          applyOrgRequiredUi(hasOrg, { confirmedNoOrg });
        }, Math.max(50, NO_ORG_BANNER_SIGNED_IN_GRACE_MS - signedInSnapshotAgeMs));
      }
      if (!hasOrg && authNotSettled && !confirmedNoOrg) {
        if (isTp3dDebugEnabled()) console.info('[workspaceReady] defer-no-org:auth-not-settled (banner)');
      }
      banner.hidden = !showNoOrgBanner;

      // Only disable buttons when we are certain there is no org.
      // During auth wobble (suppressed/uncertain), keep buttons enabled so the UI isn't frozen.
      const disable = showNoOrgBanner;
      setDisabled(document.getElementById('btn-new-pack'), disable);
      setDisabled(document.getElementById('btn-import-pack'), disable);
      setDisabled(document.getElementById('btn-packs-bulk-delete'), disable);
      setDisabled(document.getElementById('btn-new-case'), disable);
      setDisabled(document.getElementById('btn-cases-import'), disable);
      setDisabled(document.getElementById('btn-cases-bulk-delete'), disable);
      setDisabled(document.getElementById('btn-autopack'), disable);
      setDisabled(document.getElementById('btn-screenshot'), disable);
      setDisabled(document.getElementById('btn-pdf'), disable);

      // ── Async workspace-ready recovery ──
      // If we just set buttons to disabled (no org) but it's NOT confirmed, launch
      // a background poll to check if a workspace becomes ready and re-apply.
      const authTruthForPoll = AuthService.getAuthTruthSnapshot();
      const canPollWorkspaceReady = Boolean(
        !hasOrg &&
        !confirmedNoOrg &&
        !_workspaceReadyInflight &&
        AuthService.authGateIsSettled() &&
        authTruthForPoll &&
        authTruthForPoll.isSignedIn
      );
      if (canPollWorkspaceReady) {
        _workspaceReadyInflight = true;
        ensureWorkspaceReadyForUI({ timeoutMs: 2500 }).then(async (result) => {
          if (isTp3dDebugEnabled()) {
            console.info('[WorkspaceReadyUI] poll result', result);
          }
          if (result && result.ok && result.activeOrgId) {
            // Store for replay in case listener isn't installed yet
            _lastWorkspaceReadyDetail = { activeOrgId: result.activeOrgId };
            _lastWorkspaceReadyAt = Date.now();

            if (isTp3dDebugEnabled()) {
              console.info('[WorkspaceReadyUI] dispatch', { activeOrgId: result.activeOrgId });
            }

            // Dispatch event for any listeners
            try {
              window.dispatchEvent(new CustomEvent('tp3d:workspace-ready', {
                detail: { activeOrgId: result.activeOrgId },
              }));
            } catch { /* ignore */ }

            // Immediately self-heal: re-hydrate org context + re-render
            // (ensures recovery even if listener hasn't been installed yet)
            try {
              await refreshOrgContext('workspace-ready:self-heal', { force: true, forceEmit: true });
            } catch { /* ignore */ }
            applyOrgRequiredUi(true);
            queueOrgScopedRender('workspace-ready:self-heal');
          }
        }).finally(() => { _workspaceReadyInflight = false; });
      }
    }

    function isConfirmedNoActiveOrgContext() {
      return Boolean(
        orgContextResolved &&
        orgContext &&
        !orgContext.activeOrgId &&
        Array.isArray(orgContext.orgs) &&
        orgContext.orgs.length === 0
      );
    }

    function refreshConfirmedNoActiveOrgUi() {
      if (!isConfirmedNoActiveOrgContext()) return;
      applyOrgRequiredUi(false, { confirmedNoOrg: true });
      try {
        if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
          AccountSwitcher.refresh();
        }
      } catch {
        // ignore
      }
    }

    // ── Install workspace-ready listener early (before any call site can fire) ──
    window.addEventListener('tp3d:workspace-ready', async (ev) => {
      try {
        const activeOrgId = ev && ev.detail && ev.detail.activeOrgId ? String(ev.detail.activeOrgId) : null;
        if (!activeOrgId) return;
        if (isTp3dDebugEnabled()) {
          console.info('[WorkspaceReadyUI] receive', { activeOrgId });
        }
        // Re-apply org context from fresh bundle then re-render
        try {
          await refreshOrgContext('workspace-ready', { force: true, forceEmit: true });
        } catch { /* ignore */ }
        applyOrgRequiredUi(true);
        queueOrgScopedRender('workspace-ready');
      } catch {
        // ignore
      }
    });

    async function applyOrgContextFromBundle(bundle, { reason = 'org-context', forceEmit = false } = {}) {
      if (!bundle || !bundle.session || !bundle.user) {
        // Do NOT wipe org state when bundle is unavailable — it may just be loading or a transient
        // network error. Only clear if auth is definitively signed_out.
        const _truth = AuthService.getAuthTruthSnapshot();
        if (_truth && _truth.status === 'signed_out' && AuthService.authGateIsSettled()) {
          try { window.__TP3D_LAST_ACCOUNT_BUNDLE = null; } catch (_) { /* ignore */ }
          clearOrgContext({ clearLocalOrgHint: true, confirmedNoOrg: true });
        }
        return null;
      }

      // Expose the authoritative bundle before no-active clear branches so Settings can
      // distinguish confirmed zero active workspaces from transient billing/org loading.
      try { window.__TP3D_LAST_ACCOUNT_BUNDLE = bundle; } catch (_) { /* ignore */ }
      const resolved = resolveOrgContextFromBundle(bundle);
      const nextOrgId = resolved.orgId;
      const nextOrgInActiveList = Boolean(
        nextOrgId &&
        Array.isArray(resolved.orgs) &&
        resolved.orgs.some(org => org && String(org.id) === String(nextOrgId))
      );
      const now = Date.now();

      if (nextOrgId && !nextOrgInActiveList && !(bundle && bundle.partial)) {
        clearOrgContext({
          clearLocalOrgHint: true,
          confirmedNoOrg: true,
          reason: String(reason || '').includes('archive') ? 'workspace-archived' : '',
        });
        return null;
      }

      if (!nextOrgId) {
        if (bundle && bundle.partial && OrganizationService.readLocalOrgId()) {
          maybeScheduleBillingRefresh('org-context:partial');
          return null;
        }
        clearOrgContext({
          clearLocalOrgHint: true,
          confirmedNoOrg: Boolean(!bundle?.partial && Array.isArray(resolved.orgs) && resolved.orgs.length === 0),
          reason: String(reason || '').includes('archive') ? 'workspace-archived' : '',
        });
        return null;
      } 

      const prevOrgId = orgContext.activeOrgId ? String(orgContext.activeOrgId) : null;
      const nextOrgIdStr = String(nextOrgId);
      const changed = !prevOrgId || prevOrgId !== nextOrgIdStr;
      const currentWorkspaceSwitch = OrganizationService.getWorkspaceSwitchState();
      const currentStorageScope =
        Storage && typeof Storage.getStorageScope === 'function'
          ? String(Storage.getStorageScope() || '')
          : '';
      const currentWorkspaceScope =
        Storage && typeof Storage.getWorkspaceScope === 'function'
          ? String(Storage.getWorkspaceScope() || '')
          : '';
      const localOrgIdBeforeApply = OrganizationService.readLocalOrgId();
      const preserveLiveUi = Boolean(
        changed &&
        !prevOrgId &&
        hasLoadedScopedState &&
        currentStorageScope &&
        currentStorageScope !== 'anon' &&
        currentWorkspaceScope === getWorkspaceStorageScope(nextOrgIdStr) &&
        localOrgIdBeforeApply &&
        String(localOrgIdBeforeApply) === nextOrgIdStr &&
        !(currentWorkspaceSwitch && currentWorkspaceSwitch.active) &&
        StateStore.get('currentScreen') !== 'packs'
      );

      // Never let a partial bundle override a newer full bundle or a user-selected org.
      if (bundle && bundle.partial === true && changed && prevOrgId) {
        if (isTp3dDebugEnabled()) {
          console.info('[orgContext] skip-partial-overwrite', {
            prevOrgId,
            nextOrgId: nextOrgIdStr,
            reason,
          });
        }
        maybeScheduleBillingRefresh('org-context:partial');
        return prevOrgId;
      }

      orgContext = {
        activeOrgId: nextOrgIdStr,
        activeOrg: resolved.activeOrg || null,
        orgs: resolved.orgs || [],
        role: resolved.role || null,
        updatedAt: now,
      };
      orgContextResolved = true;
      // Expose last bundle for sync role resolution (resolveCanManageBillingForOrg).
      try { window.__TP3D_LAST_ACCOUNT_BUNDLE = bundle; } catch (_) { /* ignore */ }
      OrganizationService.writeLocalOrgId(nextOrgIdStr);
      if (changed) {
        applyWorkspaceScopedLocalState(nextOrgIdStr, {
          seedIfMissing: false,
          preserveLiveUi,
        });
        if (!preserveLiveUi) resetWorkspaceScopedUiState(nextOrgIdStr);
      }
      if (
        bundle.partial !== true &&
        nextOrgInActiveList &&
        Storage &&
        typeof Storage.finalizeLegacyMigration === 'function'
      ) {
        Storage.finalizeLegacyMigration();
      }

      // Best-effort: persist current org to profile when we have a real profile row.
      if (resolved.profile && !resolved.profile._isDefault) {
        const hasProfileOrgField =
          Object.prototype.hasOwnProperty.call(resolved.profile, 'current_organization_id') ||
          Object.prototype.hasOwnProperty.call(resolved.profile, 'current_org_id') ||
          Object.prototype.hasOwnProperty.call(resolved.profile, 'currentOrgId') ||
          Object.prototype.hasOwnProperty.call(resolved.profile, 'currentOrgID');
        const profileOrgId = resolved.profileOrgId ? String(resolved.profileOrgId) : null;
        if (hasProfileOrgField && profileOrgId !== nextOrgIdStr && now - lastOrgPersistAt > ORG_PERSIST_COOLDOWN_MS) {
          lastOrgPersistAt = now;
          try {
            if (SupabaseClient && typeof SupabaseClient.updateProfile === 'function') {
              SupabaseClient.updateProfile({ current_organization_id: nextOrgIdStr }).catch(() => { });
            }
          } catch {
            // ignore
          }
        }
      }

      let hidden;
      try {
        hidden = typeof document !== 'undefined' && document.hidden === true;
      } catch {
        hidden = false;
      }
      if (hidden) {
        orgContextQueued = true;
        orgContextMetrics.orgChangedQueuedWhileHidden += 1;
        return nextOrgIdStr;
      }

      if (changed || forceEmit) {
        const sameOrgRecently =
          nextOrgIdStr === lastOrgIdNotified && now - lastOrgChangeAt < ORG_CONTEXT_DEDUP_MS;
        if (!forceEmit && sameOrgRecently) {
          // Skip duplicate org-changed bursts for the same org within 500ms
          orgContextMetrics.orgChangedIgnoredSameId += 1;
        } else {
          const shouldBroadcast =
            changed &&
            reason !== 'org-sync-storage' &&
            reason !== 'org-sync-legacy' &&
            reason !== 'org-sync-event';
          OrganizationService.dispatchOrgContextChanged({
            orgId: nextOrgIdStr,
            reason: reason || null,
            broadcast: shouldBroadcast,
            source: 'bundle-apply',
            userId: bundle && bundle.user && bundle.user.id ? String(bundle.user.id) : null,
          });
          lastOrgIdNotified = nextOrgIdStr;
          lastOrgChangeAt = now;
          orgContextMetrics.orgChangedEmitted += 1;
        }
      } else {
        orgContextMetrics.orgChangedIgnoredSameId += 1;
      }

      applyOrgRequiredUi(true);
      // The active-org apply can finish after renderAuthState already rendered
      // the switcher in its unresolved "Loading…" state (notably after a
      // cross-tab identity change). Refresh the switcher from the state owner
      // so delayed bundle recovery cannot leave that label stale.
      try {
        if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
          AccountSwitcher.refresh();
        }
      } catch {
        // Best-effort UI sync; org context remains authoritative.
      }
      if (changed || forceEmit) {
        queueOrgScopedRender(reason);
      }
      if (_orgBundleFetchInflightForOrg === nextOrgIdStr) _orgBundleFetchInflightForOrg = null;
      maybeScheduleBillingRefresh('org-context');
      // Re-apply access gate with current billing snapshot + fresh role.
      // Handles: role resolved after billing already cached → modal upgrades in-place.
      BillingService.applyAccessGateFromBilling(BillingService.getBillingState(), { reason: 'bundle-role-resolved' });
      return nextOrgIdStr;
    }

    async function refreshOrgContext(reason, { force = false, forceEmit = false } = {}) {
      let hidden;
      try {
        hidden = typeof document !== 'undefined' && document.hidden === true;
      } catch {
        hidden = false;
      }
      if (hidden) {
        orgContextQueued = true;
        return null;
      }

      const truth = AuthService.getAuthTruthSnapshot();
      if (!truth.isSignedIn) {
        if (truth.status === 'signed_out' && AuthService.authGateIsSettled()) {
          clearOrgContext({ clearLocalOrgHint: true, confirmedNoOrg: true });
        }
        return null;
      }

      if (orgContextInFlight) {
        orgContextQueued = true;
        return orgContextInFlight;
      }

      orgContextInFlight = (async () => {
        const bundle = await SupabaseClient.getAccountBundleSingleFlight({ force });
        await applyOrgContextFromBundle(bundle, { reason, forceEmit });
        return null;
      })().finally(() => {
        orgContextInFlight = null;
        refreshConfirmedNoActiveOrgUi();
        if (orgContextQueued) {
          orgContextQueued = false;
          window.setTimeout(() => {
            void refreshOrgContext('org-queued');
          }, AUTH_REFRESH_DEBOUNCE_MS);
        }
      });

      return orgContextInFlight;
    }

    function requestAuthRefresh(reason, opts = {}) {
      const normalizedReason = String(reason || '').trim();
      if (normalizedReason) authRefreshReasons.add(normalizedReason);
      if (opts && opts.force) authRefreshPending.force = true;
      if (opts && opts.forceBundle) authRefreshPending.forceBundle = true;
      if (opts && opts.sessionHint) {
        authRefreshPending.sessionHint = opts.sessionHint;
      }
      const autoReason = AUTH_REFRESH_AUTO_REASONS.has(normalizedReason);
      const truth = AuthService.getAuthTruthSnapshot();
      if (isLogoutInProgress()) {
        if (isTp3dDebugEnabled()) {
          console.info('[authRefresh] skip-logout-in-progress', { reason: normalizedReason || null });
        }
        return;
      }
      if (
        autoReason &&
        (!AuthService.authGateIsSettled() || authRehydratePromise || authRefreshInFlight || orgContextInFlight)
      ) {
        if (isTp3dDebugEnabled()) {
          console.info('[authRefresh] skip-auto-race', {
            reason: normalizedReason || null,
            settled: AuthService.authGateIsSettled(),
            authRehydrateInFlight: Boolean(authRehydratePromise),
            authRefreshInFlight: Boolean(authRefreshInFlight),
            orgContextInFlight: Boolean(orgContextInFlight),
          });
        }
        authRefreshQueued = true;
        return;
      }
      if (autoReason && truth.status === 'signed_out') {
        return;
      }

      // Auth proof fast-path: skip refresh when session is proven and bundle is cached
      if (autoReason && !opts.force && !opts.forceBundle) {
        const proven = typeof SupabaseClient.isAuthProven === 'function' && SupabaseClient.isAuthProven();
        const cached = typeof SupabaseClient.hasValidBundleCache === 'function' && SupabaseClient.hasValidBundleCache();
        if (proven && cached) {
          if (isTp3dDebugEnabled()) {
            console.info('[authRefresh] skip-proven-fresh', { reason: normalizedReason || null });
          }
          return;
        }
      }

      let hidden;
      try {
        hidden = typeof document !== 'undefined' && document.hidden === true;
      } catch {
        hidden = false;
      }
      if (hidden) {
        authRefreshQueued = true;
        return;
      }
      let online;
      try {
        online = typeof navigator === 'undefined' || navigator.onLine !== false;
      } catch {
        online = true;
      }
      if (!online) {
        authRefreshQueued = true;
        return;
      }

      if (authRefreshTimer) return;
      authRefreshTimer = setTimeout(() => {
        authRefreshTimer = null;
        void runAuthRefresh();
      }, AUTH_REFRESH_DEBOUNCE_MS);
    }

    async function runAuthRefresh() {
      if (authRefreshInFlight) {
        authRefreshQueued = true;
        return authRefreshInFlight;
      }
      if (isLogoutInProgress()) {
        return null;
      }

      let hidden;
      try {
        hidden = typeof document !== 'undefined' && document.hidden === true;
      } catch {
        hidden = false;
      }
      if (hidden) {
        authRefreshQueued = true;
        return null;
      }
      let online;
      try {
        online = typeof navigator === 'undefined' || navigator.onLine !== false;
      } catch {
        online = true;
      }
      if (!online) {
        authRefreshQueued = true;
        return null;
      }
      const truthBeforeRefresh = AuthService.getAuthTruthSnapshot();
      if (truthBeforeRefresh.status === 'signed_out' && AuthService.authGateIsSettled()) {
        return null;
      }

      authRefreshQueued = false;
      const reasons = Array.from(authRefreshReasons);
      authRefreshReasons.clear();
      const pending = authRefreshPending;
      authRefreshPending = {
        force: false,
        forceBundle: false,
        sessionHint: null,
      };

      const attemptsExceeded = AuthService.registerAuthRefreshAttempt();
      const autoOnly =
        reasons.length > 0 && reasons.every(r => AUTH_REFRESH_AUTO_REASONS.has(String(r || '').trim()));
      if (attemptsExceeded && autoOnly && !pending.force) {
        return null;
      }

      authRefreshInFlight = (async () => {
        const authState =
          SupabaseClient && typeof SupabaseClient.getAuthState === 'function' ? SupabaseClient.getAuthState() : null;
        let sessionHint = pending.sessionHint || (authState && authState.session ? authState.session : null);

        const hasTokens = Boolean(sessionHint && sessionHint.access_token && sessionHint.refresh_token);
        if (!hasTokens) {
          if (AuthService.shouldUseSignedInHint() && !pending.force) {
            if (isTp3dDebugEnabled()) {
              console.info('[authRefresh] signed-in-hint-retry', { reasons });
            }
            authRefreshQueued = true;
            if (!authRefreshTimer) {
              authRefreshTimer = setTimeout(() => {
                authRefreshTimer = null;
                void runAuthRefresh();
              }, 250);
            }
            return null;
          }
          if (!authMissingSessionShown) {
            authMissingSessionShown = true;
            await renderAuthState({
              event: 'SIGNED_OUT',
              user: null,
              userInitiatedSignIn: false,
              userInitiatedSignOut: false,
              isSameUser: false,
              isUserSwitch: false,
              onRetry: bootstrapAuthGate,
            });
          }
          return null;
        }
        authMissingSessionShown = false;

        const overlayOpen = getOverlayOpen();
        const reasonLabel = reasons.length ? reasons.join('|') : 'refresh';
        const forceBundle = pending.forceBundle || (overlayOpen && reasons.includes('tab-visible'));

        await rehydrateAuthState({
          reason: reasonLabel,
          force: pending.force,
          forceBundle,
          sessionHint,
          skipCooldown: true,
        });

        await refreshOrgContext(reasonLabel, { force: forceBundle });

        return null;
      })().finally(() => {
        authRefreshInFlight = null;
        if (authRefreshQueued) {
          authRefreshQueued = false;
          if (!authRefreshTimer) {
            authRefreshTimer = setTimeout(() => {
              authRefreshTimer = null;
              void runAuthRefresh();
            }, AUTH_REFRESH_DEBOUNCE_MS);
          }
        }
      });

      return authRefreshInFlight;
    }

    async function rehydrateAuthState({
      reason = 'auth-change',
      force = false,
      forceBundle = false,
      sessionHint = null,
      skipCooldown = false,
    } = {}) {
      BillingService.billingAuthLifecycleDebugLog('rehydrate-enter', {
        reason,
        sessionUserIdTail: BillingService.abbreviateBillingLifecycleId(
          sessionHint && sessionHint.user ? sessionHint.user.id : null,
        ),
      });
      // Single-flight rehydrate to avoid overlapping session/user reads.
      if (authRehydratePromise) return authRehydratePromise;
      try {
        if (!force && typeof document !== 'undefined' && document.hidden) return null;
      } catch {
        // ignore
      }
      if (!skipCooldown && !AuthService.canStartAuthRehydrate({ force })) return null;

      authRehydratePromise = (async () => {
        const epochAtStart = SupabaseClient.getAuthEpoch ? SupabaseClient.getAuthEpoch() : null;
        // Guard: only apply bundle-driven UI updates when the bundle matches current auth state.
        let bundleOk = true;
        let sessionData = sessionHint
          ? { session: sessionHint, user: sessionHint && sessionHint.user ? sessionHint.user : null }
          : null;
        if (!sessionData) {
          try {
            sessionData = await SupabaseClient.getSessionSingleFlight();
          } catch {
            sessionData = null;
          }
        }

        let user = sessionData && sessionData.user ? sessionData.user : null;
        if (!user) {
          try {
            user = await SupabaseClient.getUserSingleFlight();
          } catch {
            user = null;
          }
        }

        // Clear stale auth-block state when a valid user resolves.
        if (user && user.id) {
          BillingService.billingAuthLifecycleDebugLog('rehydrate-authenticated-user', {
            reason,
            userIdTail: BillingService.abbreviateBillingLifecycleId(user.id),
          });
          try {
            AuthService.clearAuthBlocked();
          } catch {
            // ignore
          }
          if (lastAuthUserId && String(lastAuthUserId) !== String(user.id)) {
            // BUG-01: a different authenticated identity surfaced mid-rehydrate.
            // Apply the full isolation contract instead of silently erasing the
            // prior-user evidence — a bare lastAuthUserId reset here used to
            // defeat both the auth listener's isUserSwitch detection and the
            // renderAuthState guard, leaving User A org/billing state live.
            applyUserSwitchIsolation('rehydrate-user-switch');
          }
          BillingService.transferPendingPostSignoutBillingRequirementForAuthenticatedUser({
            userId: user.id,
            source: 'rehydrate-auth-state',
            authEvent: reason || null,
          });
        }

        if (forceBundle && SupabaseClient.getAccountBundleSingleFlight) {
          try {
            const ready = SupabaseClient.awaitAuthReady
              ? await SupabaseClient.awaitAuthReady({ timeoutMs: 5000 })
              : { ok: true };
            if (!ready.ok) {
              bundleOk = false;
            } else {
              const bundle = await SupabaseClient.getAccountBundleSingleFlight({ force: true });
              const currentEpoch = SupabaseClient.getAuthEpoch ? SupabaseClient.getAuthEpoch() : null;
              const currentUserId = SupabaseClient.getCurrentUserId ? SupabaseClient.getCurrentUserId() : null;
              // Guard: ignore canceled or mismatched bundles to avoid stale UI.
              if (!bundle || bundle.canceled) {
                bundleOk = false;
              } else if (currentEpoch !== null && Number.isFinite(bundle.epoch) && bundle.epoch !== currentEpoch) {
                bundleOk = false;
              } else if (bundle.user && currentUserId && String(bundle.user.id) !== String(currentUserId)) {
                bundleOk = false;
              }
            }
          } catch {
            bundleOk = false;
          }
        }

        const epochNow = SupabaseClient.getAuthEpoch ? SupabaseClient.getAuthEpoch() : null;
        if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
          return user;
        }
        if (!bundleOk) return user;

        // handleAuthChange internally coalesces refreshAccountUI via microtask.
        // Do NOT call refreshAccountUI separately — it causes duplicate renders.
        try {
          if (SettingsOverlay && typeof SettingsOverlay.handleAuthChange === 'function') {
            SettingsOverlay.handleAuthChange(reason);
          }
        } catch {
          // ignore
        }
        try {
          if (AccountOverlay && typeof AccountOverlay.handleAuthChange === 'function') {
            AccountOverlay.handleAuthChange(reason);
          }
        } catch {
          // ignore
        }
        try {
          renderSidebarBrandMarks();
        } catch {
          // ignore
        }
        try {
          if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
            AccountSwitcher.refresh();
          }
        } catch {
          // ignore
        }

        return user;
      })().finally(() => {
        authRehydratePromise = null;
        refreshConfirmedNoActiveOrgUi();
      });

      return authRehydratePromise;
    }

    /** Sidebar billing/upgrade DOM hygiene for identity transitions (BUG-01/BUG-07). */
    function clearSidebarBillingDomForUserSwitch() {
      try {
        const upgradeEl = document.getElementById('tp3d-sidebar-upgrade');
        const upgradeWrap = document.getElementById('upgradeCardWrap');
        if (upgradeEl) upgradeEl.innerHTML = '';
        if (upgradeWrap) upgradeWrap.hidden = true;
        else if (upgradeEl) upgradeEl.hidden = true;
      } catch {
        // Best-effort DOM hygiene only; normal billing rendering will rebuild it.
      }
    }

    /**
     * BUG-01: the single authoritative cross-user isolation contract.
     * Runs synchronously so no await can interleave User A state reads with
     * User B identity. Every confirmed identity transition (auth listener,
     * renderAuthState guard, rehydrateAuthState mismatch) must go through this
     * helper — never erase lastAuthUserId evidence for a different user
     * anywhere else.
     */
    function applyUserSwitchIsolation(reason) {
      // Set the promotion guard before any clear below so nothing triggered
      // synchronously by billing/org notifications can promote the stale
      // localStorage org hint (read by resolveActiveOrganizationId in the
      // billing service).
      flushPendingStorageSave();
      try { window.__TP3D_USER_SWITCH_PENDING = true; } catch (_) { /* ignore */ }
      try { resetBillingPumpForUserSwitch(); } catch (_) { /* ignore */ }
      try { BillingService.clearBillingState(); } catch (_) { /* ignore */ }
      try { BillingService.requireBillingAuthoritativeRefreshForUserSwitch(AuthService.getSignedInUserIdStrict()); } catch (_) { /* ignore */ }
      clearOrgContext({ clearLocalOrgHint: true, confirmedNoOrg: false });
      suspendAutoSave = true;
      try {
        resetAppStateToEmpty();
      } finally {
        suspendAutoSave = false;
      }
      try {
        if (SupabaseClient.resetAccountBundleCache) {
          SupabaseClient.resetAccountBundleCache(String(reason || 'user-switch'), { skipEpochBump: true });
        }
      } catch {
        // ignore
      }
      clearSidebarBillingDomForUserSwitch();
      try {
        if (SettingsOverlay && typeof SettingsOverlay.close === 'function') SettingsOverlay.close();
      } catch (_) { /* ignore */ }
      try {
        if (AccountOverlay && typeof AccountOverlay.close === 'function') AccountOverlay.close();
      } catch (_) { /* ignore */ }
      lastAuthUserId = null;
      orgContextResolved = false;
    }

    /**
     * @param {{ event?: string, user?: any, userInitiatedSignIn?: boolean, userInitiatedSignOut?: boolean, isSameUser?: boolean, isUserSwitch?: boolean, onRetry?: any }} [opts]
     */
    async function renderAuthState({
      event,
      user,
      userInitiatedSignIn = false,
      userInitiatedSignOut = false,
      isSameUser = false,
      isUserSwitch = false,
      onRetry = null,
    } = {}) {
      const isSignedInEvent = event === 'SIGNED_IN';
      const isSignedOutEvent = event === 'SIGNED_OUT';
      const isInitialSessionEvent = event === 'INITIAL_SESSION';
      const treatAsSignedOut = isSignedOutEvent || (isInitialSessionEvent && !user);
      const authTruth = AuthService.getAuthTruthSnapshot();
      BillingService.billingAuthLifecycleDebugLog('render-enter', {
        event: event || null,
        authStatus: authTruth && authTruth.status ? authTruth.status : null,
        incomingUserIdTail: BillingService.abbreviateBillingLifecycleId(user && user.id),
        authUserIdTail: BillingService.abbreviateBillingLifecycleId(authTruth && authTruth.userId),
        previousUserPresent: Boolean(lastAuthUserId),
      });

      if (!user && authTruth.isSignedIn && authTruth.user) {
        user = authTruth.user;
      }
      if (user) {
        const incomingUserId = user && user.id ? String(user.id) : null;
        const authMatchesIncomingUser = Boolean(
          authTruth.isSignedIn &&
          authTruth.userId &&
          (!incomingUserId || String(authTruth.userId) === incomingUserId)
        );
        if (!authMatchesIncomingUser) {
          if (isTp3dDebugEnabled()) {
            console.info('[authRender] drop-stale-signed-in-user', {
              event: event || null,
              incomingUserId,
              authTruthUserId: authTruth.userId,
              authTruthStatus: authTruth.status,
              authTruthHasToken: authTruth.hasToken,
            });
          }
          user = null;
        }
      }

      if (user) {
        // BUG-01: On a confirmed identity change, apply the full isolation
        // contract BEFORE any await or state read below. The auth stability
        // gate's onConfirmed() is cancelled when SIGNED_IN for the new user
        // arrives before the 2-second timer fires, so the gate's org clear
        // never runs through that path — and checkProfileStatus() can hit the
        // network, so the clear must come first. This keeps the org-hint read
        // below, the billing service's org resolution, and feature gates unable
        // to inherit the prior user's org or billing authority.
        const _isConfirmedUserSwitch = isUserSwitch ||
          Boolean(lastAuthUserId && user.id && lastAuthUserId !== String(user.id));
        if (_isConfirmedUserSwitch) {
          applyUserSwitchIsolation(isUserSwitch ? 'SIGNED_IN_USER_SWITCH' : 'render-auth-state-user-switch');
        }
        BillingService.transferPendingPostSignoutBillingRequirementForAuthenticatedUser({
          userId: user.id,
          source: 'render-auth-state',
          authEvent: event || null,
        });

        const canProceed = await checkProfileStatus();
        if (!canProceed) return;
        AuthOverlay.hide();
        try { document.body.setAttribute('data-auth', 'signed_in'); } catch { /* ignore */ }
        startVisibleAuthRevocationCheck();

        // ── P0.9: Scope storage to this user and reload state ──────────
        const uid = user && user.id ? String(user.id) : 'anon';
        if (
          typeof Storage.getStorageScope === 'function' &&
          Storage.getStorageScope() !== uid
        ) {
          flushPendingStorageSave();
        }
        Storage.setStorageScope(uid);

        const hintedOrgId = OrganizationService.readLocalOrgId();
        setWorkspaceStorageScope(hintedOrgId);

        if (_isConfirmedUserSwitch || !hasLoadedScopedState) {
          applyWorkspaceScopedLocalState(hintedOrgId, {
            seedIfMissing: false,
            force: true,
            // The router has already selected the URL screen. Keep a safe
            // library/info route through the first signed-in storage load.
            preserveLiveUi: !_isConfirmedUserSwitch &&
              ['cases', 'import-export', 'updates', 'roadmap'].includes(StateStore.get('currentScreen')),
          });
          // Re-render all screens with the new user's data
          try { renderAll(); } catch { /* ignore */ }
        }
        // ── end P0.9 ───────────────────────────────────────────────────

        const shouldShowSignInToast = isSignedInEvent && !isSameUser && (userInitiatedSignIn || isUserSwitch);
        if (shouldShowSignInToast && canShowToast('auth-signed-in')) {
          const toastMsg = isUserSwitch ? 'Switched user' : 'Signed in';
          UIComponents.showToast(toastMsg, 'success', { title: 'Auth' });
        }

        if (isSignedInEvent || isUserSwitch || !orgContext.activeOrgId) {
          try { await refreshOrgContext('signed-in', { force: true, forceEmit: true }); } catch { /* ignore */ }
        }

        if (SettingsOverlay && typeof SettingsOverlay.handleAuthChange === 'function') {
          SettingsOverlay.handleAuthChange(event);
        }
        if (AccountOverlay && typeof AccountOverlay.handleAuthChange === 'function') {
          AccountOverlay.handleAuthChange(event);
        }
        lastAuthUserId = user && user.id ? String(user.id) : null;
        renderSidebarBrandMarks();
        if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
          AccountSwitcher.refresh();
        }
        // Guard: skip pump if same user + same org + billing already fresh
        if (!isSameUser || isUserSwitch) {
          maybeScheduleBillingRefresh('render-auth-state');
        } else {
          const _pumpSnap = (typeof window !== 'undefined' && window.__TP3D_BILLING
            && typeof window.__TP3D_BILLING.getBillingState === 'function')
            ? window.__TP3D_BILLING.getBillingState() : null;
          const _pumpFresh = _pumpSnap && _pumpSnap.ok && _pumpSnap.lastFetchedAt
            && (Date.now() - _pumpSnap.lastFetchedAt) < BILLING_PUMP_FRESH_MS;
          // Also check cross-tab shared freshness (90s window) to avoid
          // scheduling a pump that will immediately be blocked as skip-fresh
          let _pumpFreshCrossTab = false;
          if (!_pumpFresh) {
            const _pumpOrgId = BillingService.getActiveOrgIdForBilling();
            if (_pumpOrgId) {
              const _sharedAt = BillingService._getSharedBillingFreshness(_pumpOrgId);
              const _shared = _sharedAt && (Date.now() - _sharedAt) < _BILLING_SHARED_FRESH_MS
                ? BillingService._readShareableBillingResult(_pumpOrgId, 'render-auth-state') : null;
              _pumpFreshCrossTab = Boolean(_shared);
            }
          }
          if (!_pumpFresh && !_pumpFreshCrossTab) {
            maybeScheduleBillingRefresh('render-auth-state');
          } else if (_pumpFreshCrossTab) {
            billingDebugLog('billing:render-auth-state:skip-cross-tab-fresh');
          }
        }
        showReadyOnce();
        return;
      }

      // ── P0.9.1: If this is a transient cross-tab SIGNED_OUT (not user-initiated)
      //    and we have a recent signed-in snapshot, skip the destructive wipe.
      //    The follow-up SIGNED_IN / TOKEN_REFRESHED will rehydrate normally. ──
      const _isTransientSignedOut = !userInitiatedSignOut
        && !isLogoutInProgress()
        && !AuthService.authGateIsSettled()
        && AuthService.shouldUseSignedInHint();

      if (_isTransientSignedOut) {
        // Do NOT wipe state/storage/org — just request a forced refresh so the
        // imminent SIGNED_IN event can pick up cleanly.
        requestAuthRefresh('transient-signed-out', { force: true, forceBundle: true });
        return;
      }
      // ── end P0.9.1 ────────────────────────────────────────────────────────────────

      // ── Auth Stability Gate: defer destructive actions for non-user-initiated sign-outs ──
      // If the user didn't explicitly sign out, treat this SIGNED_OUT as a *candidate*
      // and defer org-clearing / UI wipe until it's confirmed stable.
      if (!userInitiatedSignOut && !AuthService.getAuthBlockState()) {
        AuthService.authGateSignedOutCandidate(() => {
          // This fires after AUTH_SIGNED_OUT_STABLE_MS with no intervening SIGNED_IN.
          try { document.body.setAttribute('data-auth', 'signed_out'); } catch { /* ignore */ }
          finalizeSignedOutLocally({
            source: 'auth-gate-signed-out',
            event,
            treatAsSignedOut,
            userInitiatedSignOut: false,
            onRetry,
          });
        });
        // Don't set data-auth yet — keep signed_in appearance while gate is pending
        return;
      }
      // ── end Auth Stability Gate ────────────────────────────────────────────────────

      finalizeSignedOutLocally({
        source: 'render-auth-state',
        event,
        treatAsSignedOut,
        userInitiatedSignOut,
        onRetry,
      });
    }

    /** Extracted destructive signed-out actions so the auth gate timer can call them. */
    function _executeSignedOutCleanup({ event, treatAsSignedOut, userInitiatedSignOut, onRetry }) {
      const isSignedOutEvent = event === 'SIGNED_OUT';
      const hadAuthenticatedSession = Boolean(
        lastAuthUserId ||
        (lastAuthEventSnapshot && lastAuthEventSnapshot.status === 'signed_in' && lastAuthEventSnapshot.userId)
      );
      BillingService.billingAuthLifecycleDebugLog('signed-out-cleanup-enter', {
        event: event || null,
        userInitiatedSignOut: Boolean(userInitiatedSignOut),
        hadAuthenticatedSession,
        previousUserIdTail: BillingService.abbreviateBillingLifecycleId(lastAuthUserId),
      });
      try { document.body.setAttribute('data-auth', 'signed_out'); } catch { /* ignore */ }
      stopVisibleAuthRevocationCheck();
      lastAuthEventSnapshot = { status: 'signed_out', userId: null, hasToken: false, session: null, ts: Date.now() };

      // ── P0.9: Reset scope to anon so autosave can't write to the old user's key ──
      flushPendingStorageSave();
      suspendAutoSave = true;
      try {
        resetAppStateToEmpty();
        Storage.setStorageScope('anon');
        setWorkspaceStorageScope(null);
        hasLoadedScopedState = false;
        lastLoadedWorkspaceStorageKey = '';
      } finally {
        suspendAutoSave = false;
      }
      // ── end P0.9 ─────────────────────────────────────────────────────────────────

      if (AuthService.getAuthBlockState()) {
        AuthOverlay.showAccountDisabled(AuthService.getAuthBlockState().message);
      } else if (treatAsSignedOut || userInitiatedSignOut) {
        AuthOverlay.setPhase('form', { onRetry: onRetry || bootstrapAuthGate });
        AuthOverlay.show();
      } else {
        AuthOverlay.setPhase('checking', { onRetry: onRetry || bootstrapAuthGate });
        AuthOverlay.show();
      }

      try {
        SupabaseClient.resetAccountBundleCache && SupabaseClient.resetAccountBundleCache('SIGNED_OUT');
      } catch {
        // ignore
      }
      try { window.__TP3D_LAST_ACCOUNT_BUNDLE = null; } catch (_) { /* ignore */ }
      try {
        const shouldClearSignedOutOrgHint = Boolean(userInitiatedSignOut || treatAsSignedOut || AuthService.getAuthBlockState());
        clearOrgContext({
          clearLocalOrgHint: shouldClearSignedOutOrgHint,
          confirmedNoOrg: shouldClearSignedOutOrgHint,
        });
      } catch {
        // ignore
      }
      try { BillingService.clearBillingState(); } catch (_) { /* ignore */ }
      BillingService.clearBillingAuthoritativeRefreshRequirement(null, 'signed-out-cleanup');
      if (userInitiatedSignOut && hadAuthenticatedSession) {
        BillingService.markBillingAuthoritativeRefreshForNextSignIn();
      }
      BillingService.billingAuthLifecycleDebugLog('signed-out-cleanup-authority-cleared', {
        markerSet: BillingService.isAuthoritativeRefreshMarkerSet(),
      });
      // BUG-01: sign-out is a terminal identity state — release the user-switch
      // promotion guard so it cannot stay latched across the next sign-in.
      try { window.__TP3D_USER_SWITCH_PENDING = false; } catch (_) { /* ignore */ }

      if (isSignedOutEvent && userInitiatedSignOut && canShowToast('auth-signed-out')) {
        UIComponents.showToast('Signed out', 'info', { title: 'Auth' });
      }

      if (SettingsOverlay && typeof SettingsOverlay.handleAuthChange === 'function') {
        SettingsOverlay.handleAuthChange(event);
      }
      if (AccountOverlay && typeof AccountOverlay.handleAuthChange === 'function') {
        AccountOverlay.handleAuthChange(event);
      }
      lastAuthUserId = null;
      orgContextResolved = false;
      renderSidebarBrandMarks();
      if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
        AccountSwitcher.refresh();
      }
      if (isLogoutInProgress()) {
        setLogoutInProgress(false, { source: 'render-auth-state', reason: 'signed-out-cleanup' });
      }
    }

    const PROFILE_CHECK_TTL_MS = 15000;
    let lastProfileCheckUserId = null;
    let lastProfileCheckAt = 0;

    /**
     * Check if current user's profile is in deletion requested state.
     * If so, sign out and show disabled overlay.
     * @returns {Promise<boolean>} true if OK to proceed, false if blocked
     */
    async function checkProfileStatus() {
      try {
        // First check if user is actually banned in Supabase auth
        const user = SupabaseClient.getUser();
        if (!user) return true; // Not logged in, let auth flow handle it

        // Avoid profile checks when tab is hidden or auth/session is not valid.
        try {
          if (typeof document !== 'undefined' && document.hidden === true) return true;
        } catch {
          // ignore
        }

        const authState =
          SupabaseClient && typeof SupabaseClient.getAuthState === 'function' ? SupabaseClient.getAuthState() : null;
        const status = authState && authState.status ? authState.status : 'unknown';
        const session = authState && authState.session ? authState.session : null;
        const tokenOk = Boolean(session && session.access_token);
        if (status !== 'signed_in' || !tokenOk) return true;

        const userId = user && user.id ? String(user.id) : null;
        const now = Date.now();
        if (userId && userId === lastProfileCheckUserId && now - lastProfileCheckAt < PROFILE_CHECK_TTL_MS) {
          return true;
        }
        lastProfileCheckUserId = userId;
        lastProfileCheckAt = now;

        // Get the raw user data which includes ban info (only if session user lacks it)
        let fullUser = session && session.user ? session.user : user || null;
        let userError = null;
        const hasBannedInfo = Boolean(fullUser) && Object.prototype.hasOwnProperty.call(fullUser, 'banned_until');

        if (!hasBannedInfo) {
          try {
            fullUser = await window.SupabaseClient.getUserSingleFlight();
          } catch (err) {
            userError = err;
          }
        }

        if (userError) {
          // If we can't get user data, might be banned or invalid session
          if (
            userError.message &&
            (userError.message.includes('banned') ||
              userError.message.includes('disabled') ||
              userError.message.includes('Invalid') ||
              userError.status === 401)
          ) {
            try {
              await SupabaseClient.signOut({ global: false, allowOffline: true });
            } catch {
              // ignore
            }
            const blockedMsg =
              userError && userError.message ? String(userError.message) : 'Your account has been disabled.';
            AuthService.setAuthBlocked(blockedMsg);
            AuthOverlay.showAccountDisabled(blockedMsg);
            return false;
          }
          return true; // Other errors, fail open
        }

        // Check if user is banned (Supabase sets user.banned_until)
        if (fullUser && fullUser.banned_until) {
          const bannedUntil = new Date(fullUser.banned_until);
          const bannedNow = new Date();

          if (bannedUntil > bannedNow) {
            // Still banned
            try {
              await SupabaseClient.signOut({ global: false, allowOffline: true });
            } catch {
              // ignore
            }
            const bannedMsg = bannedUntil
              ? `Your account has been disabled until ${bannedUntil.toLocaleString()}.`
              : 'Your account has been disabled.';
            AuthService.setAuthBlocked(bannedMsg);
            AuthOverlay.showAccountDisabled(bannedMsg);
            return false;
          }
        }

        // User is not banned, check profile deletion status
        const profileStatus = await SupabaseClient.getMyProfileStatus();
        if (profileStatus && profileStatus.deletion_status === 'requested') {
          try {
            await SupabaseClient.signOut({ global: false, allowOffline: true });
          } catch {
            // ignore
          }
          const delMsg = 'Your account is scheduled for deletion. Contact support to cancel this request.';
          AuthService.setAuthBlocked(delMsg);
          AuthOverlay.showAccountDisabled(delMsg);
          return false;
        }

        // Clear any previously set forced-disabled latch when user is allowed
        try {
          AuthService.clearAuthBlocked();
        } catch {
          // ignore
        }
        return true; // OK to proceed
      } catch (err) {
        console.warn('[checkProfileStatus] error:', err);
        return true; // On error, let them through (fail open)
      }
    }

    let initInFlightPromise = null;
    let initCompleted = false;

    async function init() {
      if (initInFlightPromise) return initInFlightPromise;
      if (initCompleted) return;
      console.info('[TruckPackerApp] init start');
      initInFlightPromise = (async () => {
      if (!(await validateRuntime())) {
        markAppReady();
        return;
      }
      installDevHelpers({ app: window.TruckPackerApp, stateStore: StateStore, Utils, documentRef: document });
      seedIfEmpty();
      try {
        // Clear any stale reload latches so the app can continue normally.
        if (window && window.sessionStorage) window.sessionStorage.removeItem(authReloadKey);
      } catch {
        // ignore
      }

      PreferencesManager.applyTheme(StateStore.get('preferences').theme);

      const debugEnabled = () => {
        try {
          return window && window.localStorage && window.localStorage.getItem('tp3dDebug') === '1';
        } catch {
          return false;
        }
      };

      let supabaseInitOk;
      const cfg = window.__TP3D_SUPABASE && typeof window.__TP3D_SUPABASE === 'object' ? window.__TP3D_SUPABASE : null;
      const url = cfg ? cfg.url : '';
      const anonKey = cfg ? String(cfg.anonKey || '') : '';
      const anonLooksLikeJwt = anonKey.startsWith('eyJ');
      const anonLooksPublishable = anonKey.startsWith('sb_publishable_');

      if (anonLooksPublishable) {
        if (cfg && !cfg.publishableKey) cfg.publishableKey = anonKey;
        const msg =
          'Supabase anon key is misconfigured. Use the public anon key (starts with "eyJ"), not the Stripe publishable key.';
        console.error('[TruckPackerApp] ' + msg);
        if (debugEnabled()) {
          try {
            if (UIComponents && typeof UIComponents.showToast === 'function') {
              UIComponents.showToast(msg, 'error', { title: 'Supabase Config' });
            }
          } catch {
            // ignore
          }
        }
        AuthOverlay.setPhase('cantconnect', {
          error: new Error(msg),
          onRetry: () => window.location.reload(),
        });
        AuthOverlay.show();
        markAppReady();
        return;
      }

      if (!url || !anonKey || !anonLooksLikeJwt) {
        AuthOverlay.setPhase('cantconnect', {
          error: new Error('Supabase config missing or invalid'),
          onRetry: async () => {
            const retryBootstrap = async () => {
              const retryCfg =
                window.__TP3D_SUPABASE && typeof window.__TP3D_SUPABASE === 'object' ? window.__TP3D_SUPABASE : null;
              const retryUrl = retryCfg ? retryCfg.url : '';
              const retryKey = retryCfg ? String(retryCfg.anonKey || '') : '';
              if (!retryUrl || !retryKey || !String(retryKey).startsWith('eyJ')) {
                throw new Error('Supabase config still missing or invalid');
              }
              await SupabaseClient.init({ url: retryUrl, anonKey: retryKey });
            };
            await retryBootstrap();
            window.location.reload();
          },
        });
        AuthOverlay.show();
        markAppReady();
        return;
      }

      try {
        await SupabaseClient.init({ url, anonKey });
        supabaseInitOk = true;
      } catch (err) {
        if (debugEnabled()) console.info('[TruckPackerApp] Supabase init failed, attempting vendor-ready retry');

        let vendorReadyOk = false;
        if (typeof window.__tp3dVendorAllReady === 'function') {
          try {
            const vendorTimeoutMs = 6000;
            await Promise.race([
              window.__tp3dVendorAllReady(),
              new Promise((_, rej) => window.setTimeout(() => rej(new Error('Vendor ready timeout')), vendorTimeoutMs)),
            ]);
            vendorReadyOk = true;
            if (debugEnabled()) console.info('[TruckPackerApp] Vendor ready resolved');
          } catch (vendorErr) {
            if (debugEnabled()) {
              console.info(
                '[TruckPackerApp] Vendor ready timed out or failed:',
                vendorErr && vendorErr.message ? vendorErr.message : ''
              );
            }
          }
        }

        if (vendorReadyOk) {
          try {
            await SupabaseClient.init({ url, anonKey });
            supabaseInitOk = true;
            if (debugEnabled()) console.info('[TruckPackerApp] Supabase init retry success');
          } catch (retryErr) {
            if (debugEnabled()) {
              console.info(
                '[TruckPackerApp] Supabase init retry failed:',
                retryErr && retryErr.message ? retryErr.message : ''
              );
            }
            AuthOverlay.setPhase('cantconnect', { error: retryErr, onRetry: () => window.location.reload() });
            AuthOverlay.show();
            markAppReady();
            return;
          }
        } else {
          AuthOverlay.setPhase('cantconnect', { error: err, onRetry: () => window.location.reload() });
          AuthOverlay.show();
          markAppReady();
          return;
        }
      }

      bootstrapAuthGate = async () => {
        AuthOverlay.setPhase('checking', { onRetry: bootstrapAuthGate });
        AuthOverlay.show();
        try {
          const timeoutMs = 12000;
          const session = await Promise.race([
            SupabaseClient.refreshSession(),
            new Promise((_, rej) => window.setTimeout(() => rej(new Error('Session check timed out')), timeoutMs)),
          ]);
          const user = session && session.user ? session.user : null;
          const ready = SupabaseClient.awaitAuthReady
            ? await SupabaseClient.awaitAuthReady({ timeoutMs: 5000 })
            : { ok: Boolean(user) };
          if (user) {
            // Check profile status before allowing access
            if (!ready.ok) {
              AuthOverlay.setPhase('form', { onRetry: bootstrapAuthGate });
              AuthOverlay.show();
              return false;
            }
            const canProceed = await checkProfileStatus();
            if (!canProceed) {
              return false; // Block app, auth overlay is already showing disabled state
            }
            // Reset phase to 'form' before hiding so a later show() (e.g. cross-tab sign-out
            // via tp3d:auth-signed-out) renders the sign-in form, not "Checking session…".
            AuthOverlay.setPhase('form', { onRetry: bootstrapAuthGate });
            AuthOverlay.hide();
            showReadyOnce();
            return true;
          }
          AuthOverlay.setPhase('form', { onRetry: bootstrapAuthGate });
          AuthOverlay.show();
          // Ensure settled is true so auto-race guard doesn't block refreshes forever
          AuthService.markSignedOutSettledIfIdle('bootstrap-no-session');
          return false;
        } catch (err) {
          AuthOverlay.setPhase('cantconnect', { error: err, onRetry: bootstrapAuthGate });
          AuthOverlay.show();
          AuthService.markSignedOutSettledIfIdle('bootstrap-cantconnect');
          return false;
        }
      };

      // Invite acceptance token (from org invite links)
      let pendingInviteToken = null;
      let inviteAcceptInFlight = false;
      const inviteTokenStorageKey = 'tp3d:pending_invite_token';
      const inviteHandoffNoticeId = 'tp3d-invite-handoff-notice';
      const inviteHandoffSigninMessage = 'You have a pending workspace invite. Sign in or create an account using the invited email address to accept this invite.';
      const inviteExpiredMessage = 'This invite link has expired. Please ask the workspace owner to send a new invite.';
      const inviteRevokedMessage = 'This invite link is no longer valid. Please ask the workspace owner to send a new invite.';
      const inviteWrongEmailMessage = 'Invite email does not match the signed-in account.';
      const inviteGenericFailureMessage = 'This invite link could not be accepted. Please ask the workspace owner to send a new invite.';
      const inviteRetryableFailureMessage = 'This invite could not be accepted right now. Please try again.';
      let inviteHandoffNotice = null;

      function sanitizeInviteHandoffMessage(message) {
        return String(message || '')
          .replace(/invite_token=[^\s&]+/gi, 'invite_token=[redacted]')
          .replace(/\beyJ[A-Za-z0-9._-]+/g, '[redacted]')
          .replace(/[^\x20-\x7E]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 280);
      }

      function mapInviteAcceptFailureMessage(error) {
        const raw = String(error || '').trim();
        const lower = raw.toLowerCase();
        if (lower.includes('invite') && lower.includes('expired')) return inviteExpiredMessage;
        if (lower.includes('invite email does not match')) return inviteWrongEmailMessage;
        if (
          lower.includes('invite') &&
          (lower.includes('no longer valid') || lower.includes('revoked') || lower.includes('not found'))
        ) {
          return inviteRevokedMessage;
        }
        return inviteGenericFailureMessage;
      }

      function isTerminalInviteAcceptFailure(error) {
        const lower = String(error || '').trim().toLowerCase();
        return Boolean(
          lower === 'missing invite token' ||
          lower === 'invite token is required' ||
          lower.includes('invite not found') ||
          lower.includes('invite link has expired') ||
          lower.includes('invite has expired') ||
          lower.startsWith('invite expired') ||
          lower.includes('invite is no longer valid') ||
          lower.includes('invite role is no longer valid') ||
          lower.includes('invite email does not match') ||
          lower.includes('invite was revoked') ||
          lower.includes('invite has been revoked') ||
          lower.startsWith('invite revoked') ||
          lower.includes('invalid invite role') ||
          lower.includes('invite has an invalid role')
        );
      }

      function clearPendingInviteToken() {
        pendingInviteToken = null;
        try {
          window.sessionStorage.removeItem(inviteTokenStorageKey);
        } catch (_) {
          // ignore
        }
      }

      function clearInviteHandoffNotice() {
        inviteHandoffNotice = null;
        try {
          const existing = document.getElementById(inviteHandoffNoticeId);
          if (existing) existing.remove();
        } catch {
          // Best-effort UI cleanup only.
        }
      }

      function renderInviteHandoffNotice() {
        try {
          const existing = document.getElementById(inviteHandoffNoticeId);
          if (existing) existing.remove();
          if (!inviteHandoffNotice || !inviteHandoffNotice.message) return;

          const authPage = document.querySelector('[data-auth-overlay="1"] .auth-page');
          // Only render inside the auth overlay when it is actually visible to the user.
          // The overlay hides via `display:none` but stays in the DOM after sign-in, so
          // a plain querySelector match does not guarantee the element is visible.
          const authOverlay = authPage ? authPage.closest('[data-auth-overlay="1"]') : null;
          const authPageVisible = authOverlay
            ? window.getComputedStyle(authOverlay).display !== 'none'
              && window.getComputedStyle(authOverlay).visibility !== 'hidden'
              && authOverlay.getClientRects().length > 0
            : false;
          const visibleAuthPage = authPage && authPageVisible ? authPage : null;

          // When the auth overlay is hidden (signed-in), the toast already handles the
          // rejection message. Do not append to document.body: a fixed banner with a
          // higher z-index than the auth overlay (99999) would sit on top of it during
          // sign-out and make "Checking session..." appear hung.
          if (!visibleAuthPage) return;

          const box = document.createElement('div');
          box.id = inviteHandoffNoticeId;
          box.setAttribute('data-invite-handoff-message', '1');
          box.setAttribute('role', 'alert');
          box.setAttribute('aria-live', 'polite');
          box.className = `auth-message auth-message--${inviteHandoffNotice.type === 'info' ? 'info' : 'error'}`;
          box.style.display = 'block';
          box.style.margin = '0 0 14px';

          const message = document.createElement('span');
          message.textContent = inviteHandoffNotice.message;
          box.appendChild(message);

          const dismiss = document.createElement('button');
          dismiss.type = 'button';
          dismiss.textContent = 'Dismiss';
          dismiss.setAttribute('aria-label', 'Dismiss invite message');
          Object.assign(dismiss.style, {
            marginLeft: '12px',
            border: '0',
            background: 'transparent',
            color: 'inherit',
            textDecoration: 'underline',
            cursor: 'pointer',
            font: 'inherit',
          });
          dismiss.addEventListener('click', clearInviteHandoffNotice);
          box.appendChild(dismiss);

          const brand = visibleAuthPage.querySelector('.auth-brand');
          if (brand && brand.nextSibling) visibleAuthPage.insertBefore(box, brand.nextSibling);
          else visibleAuthPage.insertBefore(box, visibleAuthPage.firstChild);
        } catch {
          // Invite copy is best-effort and must not block auth.
        }
      }

      function setInviteHandoffNotice(message, type = 'error') {
        const safeMessage = sanitizeInviteHandoffMessage(message);
        if (!safeMessage) return;
        inviteHandoffNotice = {
          message: safeMessage,
          type: type === 'info' ? 'info' : 'error',
        };
        renderInviteHandoffNotice();
      }

      function scheduleInviteHandoffNoticeRender() {
        [0, 250, 1000, 2500].forEach(delay => {
          window.setTimeout(renderInviteHandoffNotice, delay);
        });
      }

      try {
        const params = new URLSearchParams(window.location.search);
        const tokenFromUrl = String(params.get('invite_token') || '').trim();
        if (tokenFromUrl) {
          pendingInviteToken = tokenFromUrl;
          setInviteHandoffNotice(inviteHandoffSigninMessage, 'info');
          scheduleInviteHandoffNoticeRender();
          try {
            window.sessionStorage.setItem(inviteTokenStorageKey, tokenFromUrl);
          } catch (_) {
            // ignore
          }
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('invite_token');
          window.history.replaceState({}, '', cleanUrl.toString());
        } else {
          try {
            const storedToken = String(window.sessionStorage.getItem(inviteTokenStorageKey) || '').trim();
            if (storedToken) {
              pendingInviteToken = storedToken;
              setInviteHandoffNotice(inviteHandoffSigninMessage, 'info');
              scheduleInviteHandoffNoticeRender();
            }
          } catch (_) {
            // ignore
          }
        }
      } catch {
        // ignore
      }

      async function tryAcceptPendingInvite(sessionHint = null) {
        if (!pendingInviteToken || inviteAcceptInFlight) return;
        const token = pendingInviteToken;

        let session = sessionHint;
        if (!session) {
          try {
            session = SupabaseClient.getSession && SupabaseClient.getSession();
          } catch {
            session = null;
          }
        }
        if (!session || !session.access_token) {
          setInviteHandoffNotice(inviteHandoffSigninMessage, 'info');
          scheduleInviteHandoffNoticeRender();
          return;
        }

        inviteAcceptInFlight = true;
        try {
          UIComponents.showToast('Accepting invite…', 'info', { title: 'Workspace', duration: 6000 });
          const result = await acceptOrgInvite(token);

          if (result && result.ok) {
            clearPendingInviteToken();
            clearInviteHandoffNotice();
            const acceptedOrgId = String(
              (result && result.organization_id) ||
              (result && result.data && result.data.organization_id) ||
              ''
            ).trim();
            UIComponents.showToast('Invite accepted. You are now a member of this workspace.', 'success', {
              title: 'Workspace',
              duration: 8000,
            });
            // Refresh org list first, then switch active org to the accepted invite org.
            // This prevents landing in the newly-created personal org after signup.
            await refreshOrgContext('invite-accepted-refresh', { force: true, forceEmit: true });
            if (acceptedOrgId) {
              await setActiveOrgId(acceptedOrgId, { source: 'invite-accepted' });
            }
            requestAuthRefresh('invite-accepted', { force: true, forceBundle: true, sessionHint: session });
            try { SettingsOverlay.open('org-members'); } catch (_) { /* ignore */ }
          } else {
            const inviteError = result && result.error ? result.error : '';
            const isTerminalFailure = isTerminalInviteAcceptFailure(inviteError);
            if (isTerminalFailure) clearPendingInviteToken();
            const inviteMessage = isTerminalFailure
              ? mapInviteAcceptFailureMessage(inviteError)
              : inviteRetryableFailureMessage;
            // Rejection branches are only reachable when a valid session exists (signed-in user).
            // The no-session path returns early above and uses setInviteHandoffNotice for the
            // signed-out case. Here, clear any stale notice state and rely on the toast only.
            clearInviteHandoffNotice();
            UIComponents.showToast(inviteMessage, 'error', {
              title: 'Workspace',
              duration: 12000,
            });
          }
        } catch (err) {
          const inviteError = err && err.message ? err.message : '';
          const isTerminalFailure = isTerminalInviteAcceptFailure(inviteError);
          if (isTerminalFailure) clearPendingInviteToken();
          const inviteMessage = isTerminalFailure
            ? mapInviteAcceptFailureMessage(inviteError)
            : inviteRetryableFailureMessage;
          clearInviteHandoffNotice();
          UIComponents.showToast(inviteMessage, 'error', { title: 'Workspace', duration: 12000 });
        } finally {
          inviteAcceptInFlight = false;
        }
      }

      if (!authListenerInstalled) {
        authListenerInstalled = true;
        SupabaseClient.onAuthStateChange(async (event, session) => {
          const isSignedInEvent = event === 'SIGNED_IN';
          const isSignedOutEvent = event === 'SIGNED_OUT';
          const isTokenRefreshEvent = event === 'TOKEN_REFRESHED';
          const isInitialSessionEvent = event === 'INITIAL_SESSION';
          const isUserUpdatedEvent = event === 'USER_UPDATED';
          const isPasswordRecoveryEvent = event === 'PASSWORD_RECOVERY';

          // PASSWORD_RECOVERY: Supabase fires this when user clicks the reset link in email.
          // Show the reset-password page in the auth overlay so they can set a new password.
          if (isPasswordRecoveryEvent) {
            try { AuthOverlay.showResetPassword(); } catch { /* ignore */ }
            return;
          }

          const userFromSession = session && session.user ? session.user : null;
          const newUserId = userFromSession && userFromSession.id ? String(userFromSession.id) : null;
          const previousUserId = lastAuthUserId ? String(lastAuthUserId) : null;
          BillingService.billingAuthLifecycleDebugLog('auth-callback-enter', {
            event: event || null,
            authStatus: session && session.access_token ? 'signed_in' : 'signed_out',
            userIdTail: BillingService.abbreviateBillingLifecycleId(newUserId),
            previousUserIdTail: BillingService.abbreviateBillingLifecycleId(previousUserId),
            previousUserPresent: Boolean(previousUserId),
          });

          // P0.7 – Snapshot the *real* auth event so getCurrentAuthSnapshot() can
          // fall back to it during the brief window where getAuthState() returns
          // status:'unknown' / hasToken:false right after a valid event.
          if (session && session.access_token) {
            if (!isLogoutInProgress() && !logoutActionPromise) signedOutFinalized = false;
            lastAuthEventSnapshot = { status: 'signed_in', userId: newUserId, hasToken: true, session, ts: Date.now() };
          } else if (isSignedOutEvent) {
            lastAuthEventSnapshot = { status: 'signed_out', userId: null, hasToken: false, session: null, ts: Date.now() };
          }

          // ── Auth Stability Gate transitions ──
          if (isSignedInEvent || (isTokenRefreshEvent && session && session.access_token)) {
            AuthService.authGateSignedIn();
          } else if (isInitialSessionEvent && !userFromSession) {
            AuthService.authGateInitialSession();
          }
          // SIGNED_OUT is handled below after the transient-signed-out check in renderAuthState.
          // We do NOT call authGateSignedOutCandidate here — it is called from renderAuthState
          // only after the P0.9.1 transient-signed-out guard has been evaluated.

          // FIX: Detect cross-tab login with DIFFERENT user - this is the key bug fix.
          // When a different user logs in on another tab, we receive SIGNED_IN but lastAuthUserId
          // still holds the OLD user's ID. We must clear stale state BEFORE any re-hydration.
          const isUserSwitch = isSignedInEvent && newUserId && previousUserId && newUserId !== previousUserId;

          // Check if user initiated sign-in (consume intent ONCE and reuse the result)
          // Note: consumeAuthIntent clears the intent, so we must call it only once per event
          const userIntentConsumed =
            isSignedInEvent && SupabaseClient.consumeAuthIntent && SupabaseClient.consumeAuthIntent('signIn', 5000);
          const isCrossTabLogin = isSignedInEvent && newUserId && !userIntentConsumed;

          // Cross-tab user switches are handled via auth events (no page reload).

          // If this is a user switch (different user signed in), isolate stale state immediately
          if (isUserSwitch) {
            applyUserSwitchIsolation('SIGNED_IN_USER_SWITCH');
          }
          if (newUserId && session && session.access_token) {
            BillingService.transferPendingPostSignoutBillingRequirementForAuthenticatedUser({
              userId: newUserId,
              source: 'auth-listener',
              authEvent: event || null,
            });
          }
          BillingService.billingAuthLifecycleDebugLog('auth-callback-after-transfer', {
            event: event || null,
            userIdTail: BillingService.abbreviateBillingLifecycleId(newUserId),
          });

          // Rehydrate auth state for sign-in/session refresh events.
          // FIX: Force rehydration for user switches to ensure fresh data
          const shouldForceBundle =
            isSignedInEvent || isTokenRefreshEvent || isInitialSessionEvent || isUserUpdatedEvent;
          requestAuthRefresh(event || 'auth', {
            force: isUserSwitch,
            forceBundle: shouldForceBundle || isUserSwitch,
            sessionHint: session || null,
          });

          // Sync billing state on auth changes
          // NOTE: refreshBilling is NOT called here — renderAuthState (below) is the single billing trigger
          if (isSignedOutEvent) {
            BillingService.clearBillingState();
            clearInviteHandoffNotice();
          } else if (isSignedInEvent || isTokenRefreshEvent || isInitialSessionEvent || isUserUpdatedEvent) {
            if (userFromSession && userFromSession.id) {
              tryAcceptPendingInvite(session || null).catch(() => { });
            }
          }

          const authTruthForEvent = AuthService.getAuthTruthSnapshot();
          // Never treat stale wrapper user as signed-in unless auth truth has a usable session.
          const user = userFromSession || (authTruthForEvent.isSignedIn ? authTruthForEvent.user : null);

          // FIX: Reuse the already-consumed result instead of consuming again
          const userInitiatedSignIn = userIntentConsumed;
          const userInitiatedSignOut =
            isSignedOutEvent && SupabaseClient.consumeAuthIntent && SupabaseClient.consumeAuthIntent('signOut', 2500);

          // FIX: Recalculate isSameUser after potential lastAuthUserId clear
          const currentLastAuthUserId = lastAuthUserId ? String(lastAuthUserId) : null;
          const isSameUser = user && currentLastAuthUserId && user.id && String(user.id) === currentLastAuthUserId;

          try {
            emit('auth:changed', {
              event,
              userId: user && user.id ? String(user.id) : '',
              isUserSwitch,
              isCrossTabLogin,
            });
          } catch {
            // ignore
          }

          // 1) Close settings overlay only when auth really changes user context.
          // Avoid closing on TOKEN_REFRESHED / INITIAL_SESSION to prevent tab desync.
          const shouldCloseSettings = isUserSwitch || isSignedOutEvent;
          if (shouldCloseSettings) {
            try {
              if (SettingsOverlay && typeof SettingsOverlay.close === 'function') SettingsOverlay.close();
            } catch (_) {
              // ignore
            }
            try {
              if (AccountOverlay && typeof AccountOverlay.close === 'function') AccountOverlay.close();
            } catch (_) {
              // ignore
            }
          }

          // 2) Org context changes are handled via refreshOrgContext to keep a single source of truth.

          await renderAuthState({
            event,
            user,
            userInitiatedSignIn,
            userInitiatedSignOut,
            isSameUser,
            isUserSwitch,
            onRetry: bootstrapAuthGate,
          });
        });
      }

      if (!authUiBound) {
        authUiBound = true;
        try {
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            requestAuthRefresh('tab-visible');
          });
          let _legacyOrgSyncTimer = null;
          window.addEventListener('storage', ev => {
            const key = ev && ev.key ? String(ev.key) : '';
            if (!key) return;
            if (key === ORG_CONTEXT_SYNC_KEY && ev.newValue) {
              const payload = OrganizationService.parseOrgContextSyncPayload(ev.newValue);
              const accepted = payload
                ? handleIncomingOrgContextSync(payload, { source: 'org-sync-storage' })
                : false;
              if (accepted && _legacyOrgSyncTimer) {
                clearTimeout(_legacyOrgSyncTimer);
                _legacyOrgSyncTimer = null;
                if (isTp3dDebugEnabled()) {
                  console.info('[orgSync] legacy-hint:cancelled', { reason: 'canonical-accepted' });
                }
              }
              return;
            }
            if (key === WORKSPACE_SWITCH_SYNC_KEY && ev.newValue) {
              const payload = OrganizationService.parseWorkspaceSwitchSyncPayload(ev.newValue);
              if (payload) {
                OrganizationService.handleIncomingWorkspaceSwitchState(payload);
              }
              return;
            }
            if (key === ORG_CONTEXT_LS_KEY) {
              // Legacy key — treat as hint only, debounce to let canonical win
              const nextOrgId = normalizeOrgIdForBilling(ev.newValue || '');
              if (!nextOrgId) return;
              if (_legacyOrgSyncTimer) clearTimeout(_legacyOrgSyncTimer);
              if (isTp3dDebugEnabled()) {
                console.info('[orgSync] legacy-hint', { orgId: nextOrgId, startedMs: 100 });
              }
              _legacyOrgSyncTimer = setTimeout(() => {
                _legacyOrgSyncTimer = null;
                // Canonical did not arrive within window — refresh org context as fallback
                if (isLogoutInProgress()) return;
                const uid = AuthService.getSignedInUserIdStrict();
                if (!uid) return;
                if (isTp3dDebugEnabled()) {
                  console.info('[orgSync] legacy-hint:fired', { orgId: nextOrgId });
                }
                void refreshOrgContext('org-sync-legacy', { force: true, forceEmit: false });
              }, 100);
              return;
            }
            const isAuthKey =
              key === 'tp3d-logout-trigger' ||
              (key.startsWith('sb-') && (key.endsWith('-auth-token') || key.endsWith('-auth-token-code-verifier')));
            if (!isAuthKey) return;
            requestAuthRefresh('storage');
          });
          // ── Replay any workspace-ready event that fired before this block ran ──
          if (_lastWorkspaceReadyDetail && (Date.now() - _lastWorkspaceReadyAt) < WORKSPACE_READY_REPLAY_MS) {
            const _replayOrgId = _lastWorkspaceReadyDetail.activeOrgId;
            if (_replayOrgId) {
              if (isTp3dDebugEnabled()) {
                console.info('[WorkspaceReadyUI] replay', { activeOrgId: _replayOrgId });
              }
              (async () => {
                try {
                  await refreshOrgContext('workspace-ready:replay', { force: true, forceEmit: true });
                } catch { /* ignore */ }
                applyOrgRequiredUi(true);
                queueOrgScopedRender('workspace-ready:replay');
              })();
            }
          }
          window.addEventListener('tp3d:org-changed', ev => {
            const truth = AuthService.getAuthTruthSnapshot();
            if (!truth.isSignedIn) {
              orgContextMetrics.orgChangedIgnoredSignedOut += 1;
              return;
            }

            const detail = ev && ev.detail ? ev.detail : {};
            const detailUserId = detail && detail.userId ? String(detail.userId) : null;
            if (detailUserId && truth.userId && detailUserId !== truth.userId) {
              if (isTp3dDebugEnabled()) {
                console.info('[orgContext] ignore-user-mismatch', {
                  detailUserId,
                  currentUserId: truth.userId,
                });
              }
              return;
            }
            const detailEpoch = OrganizationService.getOrgContextEffectiveVersion(detail);
            const detailTabId = detail && detail.tabId ? String(detail.tabId) : '';
            if (detailEpoch && OrganizationService.compareOrgContextOrder(detailEpoch, detailTabId) < 0) {
              if (isTp3dDebugEnabled()) {
                console.info('[orgContext] ignore-older-epoch', {
                  detailEpoch,
                  lastAppliedOrgContextVersion: OrganizationService.getOrgContextVersionState().lastAppliedOrgContextVersion,
                });
              }
              return;
            }
            if (detailEpoch) {
              OrganizationService.markOrgContextVersion(detailEpoch, detailTabId);
            }

            const detailOrgId = detail && detail.orgId ? String(detail.orgId) : null;
            const isClearedEvent = !detailOrgId && Boolean(detail && detail.confirmedNoOrg);
            if (isClearedEvent) {
              orgContextMetrics.orgChangedHandled += 1;
              try {
                if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
                  AccountSwitcher.refresh();
                }
              } catch {
                // ignore
              }
              BillingService.applyAccessGateFromBilling(BillingService.getBillingState(), {
                reason: 'org-cleared',
                activeOrgId: null,
              });
              return;
            }
            const snapshotOrgId = orgContext.activeOrgId ? String(orgContext.activeOrgId) : null;
            const sameOrg = Boolean(detailOrgId && snapshotOrgId && snapshotOrgId === detailOrgId);
            const sameTabLocalSwitch = sameOrg && detail && detail.source === 'set-active-org';
            if (detailOrgId && snapshotOrgId && snapshotOrgId === detailOrgId) {
              orgContextMetrics.orgChangedIgnoredSameId += 1;
            }
            if (sameOrg && !sameTabLocalSwitch) {
              return;
            }

            let hidden;
            try {
              hidden = typeof document !== 'undefined' && document.hidden === true;
            } catch {
              hidden = false;
            }
            if (hidden) {
              orgContextMetrics.orgChangedQueuedWhileHidden += 1;
              orgContextQueued = true;
              return;
            }

            const overlayOpen = getOverlayOpen();
            requestAuthRefresh('org-changed', { forceBundle: Boolean(overlayOpen) });

            if (!sameTabLocalSwitch) {
              orgContextMetrics.orgChangedHandled += 1;
              queueOrgScopedRender('org-changed');
              try {
                if (AccountSwitcher && typeof AccountSwitcher.refresh === 'function') {
                  AccountSwitcher.refresh();
                }
              } catch {
                // ignore
              }
            }
            // Re-apply gating immediately for role/org context changes, then pump billing.
            const nextOrgId = detailOrgId || snapshotOrgId || null;
            BillingService.applyAccessGateFromBilling(BillingService.getBillingState(), {
              reason: 'org-changed',
              activeOrgId: nextOrgId,
            });
            // setActiveOrgId() already calls maybeScheduleBillingRefresh for same-tab switches;
            // skip the duplicate pump to avoid queuing two back-to-back refreshes.
            if (!sameTabLocalSwitch) {
              maybeScheduleBillingRefresh('org-changed');
            }
          });
        } catch {
          // ignore
        }
      }

      AppShell.init();
      PacksUI.init();
      CasesUI.init();
      ImportExportUI.init();
      EditorUI.init();
      UpdatesUI.init();
      RoadmapUI.init();
      AccountSwitcher.init();
      wireGlobalButtons();
      KeyboardManager.init();

      ErrorOverlay.setOnBackToPacks(() => {
        routeNotFoundActive = false;
        const replaced = Router.replaceScreen('packs');
        if (!replaced || StateStore.get('currentScreen') !== 'packs') {
          AppShell.navigate('packs');
        }
        RecoverableErrorOverlay.syncRecoverableErrorOverlay();
      });

      // Sidebar upgrade notice subscriber
      try {
        const upgradeEl = document.getElementById('tp3d-sidebar-upgrade');
        const upgradeWrap = document.getElementById('upgradeCardWrap');
        const TRIAL_WELCOME_LS_PREFIX = 'tp3d_trial_modal_shown_';
        let trialExpiredModalRef = null;
        let trialExpiredModalOrgId = null;
        let trialExpiredLockedOrgId = null;
        let trialWelcomeShownOrgId = null;
        let _trialModalCanManageBilling = null; // tracks the last canManageBilling value used for the open modal
        let _trialModalLine1Ref = null;
        let _trialModalRoleHintRef = null;
        /** @type {Map<string, string>} */
        const lastBillingStatusByOrg = new Map();

        /**
         * Resolve canManageBilling from a single source of truth: the membership
         * role for the active org (from the account bundle), scoped by userId+orgId.
         * Falls back to orgContext.role, then to OrgContext.getActiveRole().
         * Returns resolved=false when role is not yet known (default: non-owner/support UI).
         */
        function resolveCanManageBillingForOrg(orgId) {
          const normalizedOrgId = orgId ? String(orgId).trim() : '';
          const userId = AuthService.getSignedInUserIdStrict();

          // Early-out: cannot resolve role without both orgId and userId
          if (!normalizedOrgId || !userId) {
            if (isTp3dDebugEnabled()) {
              console.info('[resolveCanManageBillingForOrg]', {
                orgId: normalizedOrgId, userId, resolved: false, membershipRole: null,
                roleSource: 'none', reason: 'missing-identity',
              });
            }
            return { canManageBilling: false, membershipRole: null, roleSource: 'none', resolved: false, userId, orgId: normalizedOrgId };
          }

          let membershipRole = '';
          let roleSource = 'none';
          let resolved = false;

          // 1. Authoritative: orgContext.role (set by resolveOrgContextFromBundle, scoped to activeOrgId)
          if (normalizedOrgId && orgContext && orgContext.activeOrgId && String(orgContext.activeOrgId) === normalizedOrgId) {
            const ctxRole = typeof orgContext.role === 'string' ? orgContext.role.toLowerCase() : '';
            if (ctxRole === 'owner' || ctxRole === 'admin' || ctxRole === 'member') {
              membershipRole = ctxRole;
              roleSource = 'orgContext.role';
              resolved = true;
            }
          }

          // 2. Fallback: OrgContext.getActiveRole() (same data, different accessor)
          if (!resolved) {
            const activeRole = typeof OrgContext.getActiveRole === 'function' ? OrgContext.getActiveRole() : '';
            const normalized = typeof activeRole === 'string' ? activeRole.toLowerCase() : '';
            if (normalized === 'owner' || normalized === 'admin' || normalized === 'member') {
              membershipRole = normalized;
              roleSource = 'OrgContext.getActiveRole';
              resolved = true;
            }
          }

          // 3. Fallback: cached bundle membership from SupabaseClient
          if (!resolved && normalizedOrgId) {
            try {
              // Try the module-level bundle cache via window accessor
              const bundleCache = window.__TP3D_LAST_ACCOUNT_BUNDLE || null;
              if (bundleCache && bundleCache.membership) {
                const memOrgId = bundleCache.membership.organization_id ? String(bundleCache.membership.organization_id).trim() : '';
                const memUserId = bundleCache.user && bundleCache.user.id ? String(bundleCache.user.id) : '';
                if (memOrgId === normalizedOrgId && (!userId || memUserId === userId)) {
                  const memRole = typeof bundleCache.membership.role === 'string' ? bundleCache.membership.role.toLowerCase() : '';
                  if (memRole === 'owner' || memRole === 'admin' || memRole === 'member') {
                    membershipRole = memRole;
                    roleSource = 'bundleCache.membership';
                    resolved = true;
                  }
                }
              }
            } catch (_) { /* ignore */ }
          }

          const canManageBilling = resolved && membershipRole === 'owner';
          const result = { canManageBilling, membershipRole, roleSource, resolved, userId, orgId: normalizedOrgId };
          if (isTp3dDebugEnabled()) {
            console.info('[resolveCanManageBillingForOrg]', {
              orgId: normalizedOrgId, userId, resolved, membershipRole: membershipRole || null,
              roleSource, ctxRole: orgContext && typeof orgContext.role === 'string' ? orgContext.role : null,
              ctxActiveOrgId: orgContext && orgContext.activeOrgId ? String(orgContext.activeOrgId) : null,
              bundleMembership: (function() { try { const _b = window.__TP3D_LAST_ACCOUNT_BUNDLE; return _b && _b.membership ? { role: _b.membership.role, orgId: _b.membership.organization_id } : null; } catch(_) { return null; } })(),
            });
          }
          return result;
        }

        // ── Org Role Hydration State ──────────────────────────────────────
        // Returns 3 states: 'hydrated' (role known or definitively absent),
        // 'inflight' (bundle fetch still in-flight), 'unknown' (no fetch, no role).
        // Used to defer owner-only UI decisions until role has arrived.
        const _ROLE_HYDRATION_CAP_MS = 8000; // hard cap: treat as 'unknown' after 8s in-flight
        let _roleHydrationInflightSince = 0;

        /**
         * @param {string} orgId
         * @returns {'hydrated'|'inflight'|'unknown'}
         */
        function getOrgRoleHydrationState(orgId) {
          const normalizedOrgId = orgId ? String(orgId).trim() : '';
          if (!normalizedOrgId) return 'unknown';

          // Check if role is already known for this org
          if (orgContext && orgContext.activeOrgId && String(orgContext.activeOrgId) === normalizedOrgId) {
            const ctxRole = typeof orgContext.role === 'string' ? orgContext.role.toLowerCase() : '';
            if (ctxRole === 'owner' || ctxRole === 'admin' || ctxRole === 'member') {
              return 'hydrated';
            }
          }
          // Also check the accessor
          if (typeof OrgContext.getActiveRole === 'function') {
            const role = String(OrgContext.getActiveRole() || '').toLowerCase();
            if (role === 'owner' || role === 'admin' || role === 'member') {
              return 'hydrated';
            }
          }

          // Check if bundle fetch is in-flight for this org
          const bundleInflight = _orgBundleFetchInflightForOrg === normalizedOrgId;
          const contextInflight = Boolean(orgContextInFlight);
          const authInflight = Boolean(authRehydratePromise);
          // Grace window: treat as inflight for the first 1.5s after org change
          const graceUntil = _orgRoleHydrationGraceUntilByOrg.get(normalizedOrgId) || 0;
          const inGraceWindow = graceUntil > 0 && Date.now() < graceUntil;

          if (bundleInflight || contextInflight || authInflight || inGraceWindow) {
            // Track when inflight started for hard cap
            if (!_roleHydrationInflightSince) _roleHydrationInflightSince = Date.now();
            // Hard cap: if inflight > 8s, give up waiting and treat as unknown
            if ((Date.now() - _roleHydrationInflightSince) > _ROLE_HYDRATION_CAP_MS) {
              if (isTp3dDebugEnabled()) {
                console.info('[OrgRole] inflight-cap-exceeded', { orgId: normalizedOrgId, elapsedMs: Date.now() - _roleHydrationInflightSince });
              }
              _roleHydrationInflightSince = 0;
              return 'unknown';
            }
            return 'inflight';
          }

          // Not inflight anymore — reset timer
          _roleHydrationInflightSince = 0;
          // Bundle finished but no role found: definitively unknown (treat as non-owner)
          return 'unknown';
        }
        _getOrgRoleHydrationStateAccessor = getOrgRoleHydrationState;

        const pickCheckoutInterval = ({ initialInterval = 'month', _title = 'Choose Plan', _continueLabel = 'Continue' } = {}) =>
          new Promise(resolve => {
            const plans = BillingService.getCheckoutPlanOptions();
            const fallbackInterval = plans.month.available ? 'month' : (plans.year.available ? 'year' : 'month');
            let selectedInterval = plans[initialInterval] && plans[initialInterval].available
              ? initialInterval
              : fallbackInterval;
            let settled = false;
            const settle = value => {
              if (settled) return;
              settled = true;
              resolve(value);
            };

            // ── Build new plan-picker UI ──────────────────────────────────────
            const content = document.createElement('div');
            content.className = 'tp3d-plan-picker';

            // Title
            const pickerTitle = document.createElement('div');
            pickerTitle.className = 'tp3d-plan-picker__title';
            pickerTitle.textContent = 'Truck Packer Pro';
            content.appendChild(pickerTitle);

            // Feature list
            const featureItems = [
              'Unlimited load plans & cases',
              'Advanced 3D editor',
              'PDF & Excel export',
              'Team collaboration',
              'Priority support',
            ];
            const featureList = document.createElement('ul');
            featureList.className = 'tp3d-plan-picker__features';
            featureItems.forEach(text => {
              const li = document.createElement('li');
              li.className = 'tp3d-plan-picker__feature';
              li.textContent = text;
              featureList.appendChild(li);
            });
            content.appendChild(featureList);

            // "Learn More" link
            const learnMore = document.createElement('a');
            learnMore.className = 'tp3d-plan-picker__learn-more';
            learnMore.href = '#';
            learnMore.textContent = 'Learn More';
            learnMore.addEventListener('click', e => e.preventDefault());
            content.appendChild(learnMore);

            // Plan cards
            const cardsWrap = document.createElement('div');
            cardsWrap.className = 'tp3d-plan-picker__cards';

            const buildCard = (interval, badgeText, cardTitle, subText, priceMain, priceSub, disabled) => {
              const card = document.createElement('button');
              card.type = 'button';
              card.className = 'tp3d-plan-card';
              card.disabled = disabled;
              card.dataset.interval = interval;

              const cardLeft = document.createElement('div');
              cardLeft.className = 'tp3d-plan-card__left';

              if (badgeText) {
                const badge = document.createElement('span');
                badge.className = 'tp3d-plan-card__badge';
                badge.textContent = badgeText;
                cardLeft.appendChild(badge);
              }

              const cardTitleEl = document.createElement('div');
              cardTitleEl.className = 'tp3d-plan-card__title';
              cardTitleEl.textContent = cardTitle;
              cardLeft.appendChild(cardTitleEl);

              const cardSub = document.createElement('div');
              cardSub.className = 'tp3d-plan-card__sub';
              cardSub.textContent = subText;
              cardLeft.appendChild(cardSub);

              const cardPrice = document.createElement('div');
              cardPrice.className = 'tp3d-plan-card__price';

              const priceMainEl = document.createElement('span');
              priceMainEl.className = 'tp3d-plan-card__price-main';
              priceMainEl.textContent = priceMain;

              const priceSubEl = document.createElement('span');
              priceSubEl.className = 'tp3d-plan-card__price-sub';
              priceSubEl.textContent = priceSub;

              cardPrice.appendChild(priceMainEl);
              cardPrice.appendChild(priceSubEl);

              card.appendChild(cardLeft);
              card.appendChild(cardPrice);
              return card;
            };

            const yearCard = buildCard(
              'year',
              'Save 17%',
              'Yearly Plan',
              'Billed at $199.99/yr',
              '$16.67',
              'per month',
              !plans.year.available
            );

            const monthCard = buildCard(
              'month',
              null,
              'Monthly Plan',
              'Billed monthly',
              '$19.99',
              'per month',
              !plans.month.available
            );

            cardsWrap.appendChild(yearCard);
            cardsWrap.appendChild(monthCard);
            content.appendChild(cardsWrap);

            // Status line for unavailable plans
            const statusLine = document.createElement('div');
            statusLine.className = 'muted tp3d-checkout-plan-note';
            statusLine.textContent = '';
            content.appendChild(statusLine);

            // CTA button
            const ctaBtn = document.createElement('button');
            ctaBtn.type = 'button';
            ctaBtn.className = 'btn btn-primary tp3d-plan-picker__cta';
            ctaBtn.textContent = 'Start my subscription';
            if (!plans.month.available && !plans.year.available) {
              ctaBtn.disabled = true;
            }
            content.appendChild(ctaBtn);

            // Cancel anytime note — below the CTA
            const cancelNote = document.createElement('div');
            cancelNote.className = 'tp3d-plan-picker__cancel-note';
            cancelNote.textContent = 'Cancel anytime!';
            content.appendChild(cancelNote);

            // Selection state
            const updateSelectionUI = () => {
              yearCard.classList.toggle('tp3d-plan-card--selected', selectedInterval === 'year');
              monthCard.classList.toggle('tp3d-plan-card--selected', selectedInterval === 'month');
              const missing = [];
              if (!plans.month.available) missing.push('Monthly plan is not configured.');
              if (!plans.year.available) missing.push('Yearly plan is not configured.');
              statusLine.textContent = missing.join(' ');
            };

            yearCard.addEventListener('click', () => {
              if (!plans.year.available) return;
              selectedInterval = 'year';
              updateSelectionUI();
            });
            monthCard.addEventListener('click', () => {
              if (!plans.month.available) return;
              selectedInterval = 'month';
              updateSelectionUI();
            });

            updateSelectionUI();

            const modalRef = UIComponents.showModal({
              title: '',
              hideClose: false,
              content,
              actions: [],
              onClose: () => settle(null),
            });

            if (modalRef && modalRef.modal) {
              modalRef.modal.classList.add('tp3d-plan-picker-modal');
            }

            ctaBtn.addEventListener('click', () => {
              const selectedPlan = plans[selectedInterval];
              if (!selectedPlan || !selectedPlan.available) {
                UIComponents.showToast(`Price not configured for interval: ${selectedInterval}`, 'warning', { title: 'Billing' });
                return;
              }
              settle({ interval: selectedInterval });
              try { modalRef && typeof modalRef.close === 'function' && modalRef.close(); } catch (_) { /* ignore */ }
            });
          });

        try {
          if (window.__TP3D_BILLING && typeof window.__TP3D_BILLING === 'object') {
            window.__TP3D_BILLING.pickCheckoutInterval = pickCheckoutInterval;
          }
        } catch (_) {
          // ignore
        }

        const closeTrialExpiredModal = () => {
          if (!trialExpiredModalRef || typeof trialExpiredModalRef.close !== 'function') return;
          const ref = trialExpiredModalRef;
          trialExpiredModalRef = null;
          trialExpiredModalOrgId = null;
          _trialModalLine1Ref = null;
          _trialModalRoleHintRef = null;
          try {
            ref.close();
          } catch (_) {
            // ignore
          }
        };

        const upgradeTrialModalToOwner = (snapshot, orgId) => {
          // In-place upgrade: non-owner UI → owner UI (role resolved after modal opened)
          if (_trialModalLine1Ref) {
            _trialModalLine1Ref.textContent = 'Your free trial has ended. Start a subscription to continue using Truck Packer 3D.';
          }
          if (_trialModalRoleHintRef && _trialModalRoleHintRef.parentNode) {
            _trialModalRoleHintRef.parentNode.removeChild(_trialModalRoleHintRef);
            _trialModalRoleHintRef = null;
          }
          // Prepend "Start Subscription" button to footer (idempotent — skip if already present)
          if (trialExpiredModalRef && trialExpiredModalRef.modal) {
            const footer = trialExpiredModalRef.modal.querySelector('.modal-footer');
            if (footer && !footer.querySelector('[data-trial-upgrade-btn]')) {
              const btn = document.createElement('button');
              btn.setAttribute('data-trial-upgrade-btn', '1');
              btn.className = 'btn btn-primary';
              btn.type = 'button';
              btn.textContent = 'Start Subscription';
              btn.addEventListener('click', () => {
                pickCheckoutInterval({ _title: 'Choose Plan', _continueLabel: 'Continue' })
                  .then(selection => {
                    if (!selection || !selection.interval) return Promise.resolve();
                    return BillingService.startCheckout({ interval: selection.interval }).then((result) => {
                      if (!result.ok) {
                        UIComponents.showToast(result.error || 'Checkout failed', 'error', { title: 'Billing' });
                      }
                    });
                  })
                  .catch(() => {
                    UIComponents.showToast('Checkout failed', 'error', { title: 'Billing' });
                  });
              });
              footer.insertBefore(btn, footer.firstChild);
            }
          }
          _trialModalCanManageBilling = true;
          if (isTp3dDebugEnabled()) {
            const _roleInfo = resolveCanManageBillingForOrg(orgId);
            console.info('[TrialExpiredModal] upgrade', {
              tabId: SupabaseClient && typeof SupabaseClient.getTabId === 'function' ? SupabaseClient.getTabId() : null,
              orgId,
              membershipRole: _roleInfo.membershipRole || null,
              roleSource: _roleInfo.roleSource || null,
            });
          }
        };

        const showTrialExpiredModal = (snapshot, canManageBilling) => {
          const entitlementStatus = normalizeBillingEntitlementStatus(snapshot && snapshot.entitlementStatus);
          if (entitlementStatus && entitlementStatus !== 'trial_expired') return;
          const orgId = String(snapshot && snapshot.orgId ? snapshot.orgId : (orgContext && orgContext.activeOrgId) || '').trim();
          if (!orgId) return;
          // If modal already open for this org: skip if same state, upgrade in-place if role resolved
          if (trialExpiredModalRef && trialExpiredModalOrgId === orgId) {
            if (_trialModalCanManageBilling === canManageBilling) return;
            if (canManageBilling && !_trialModalCanManageBilling) {
              upgradeTrialModalToOwner(snapshot, orgId);
              return;
            }
          }
          closeTrialExpiredModal();

          const body = document.createElement('div');
          const line1 = document.createElement('div');
          if (canManageBilling) {
            line1.textContent = 'Your free trial has ended. Start a subscription to continue using Truck Packer 3D.';
          } else {
            line1.textContent = 'Your free trial has ended.';
          }
          body.appendChild(line1);
          _trialModalLine1Ref = line1;
          _trialModalRoleHintRef = null;
          if (!canManageBilling) {
            // TODO: replace support@pxl360.com with the real support email later.
            const roleHint = document.createElement('div');
            roleHint.className = 'muted tp3d-settings-mt-sm';
            const hintText = document.createTextNode('Ask your owner to upgrade this workspace or contact support: ');
            roleHint.appendChild(hintText);
            const supportLink = document.createElement('a');
            supportLink.href = 'mailto:support@pxl360.com';
            supportLink.textContent = 'support@pxl360.com';
            roleHint.appendChild(supportLink);
            body.appendChild(roleHint);
            _trialModalRoleHintRef = roleHint;
          }

          const logoutAction = {
            label: 'Logout',
            variant: 'ghost',
            onClick: () => {
              void performUserInitiatedLogout({ source: 'trial-expired-modal' });
              return false;
            },
          };

          const modalActions = canManageBilling
            ? [
                {
                  label: 'Start Subscription',
                  variant: 'primary',
                  onClick: () => {
                    pickCheckoutInterval({ _title: 'Choose Plan', _continueLabel: 'Continue' })
                      .then(selection => {
                        if (!selection || !selection.interval) return Promise.resolve();
                        return BillingService.startCheckout({ interval: selection.interval }).then((result) => {
                          if (!result.ok) {
                            UIComponents.showToast(result.error || 'Checkout failed', 'error', { title: 'Billing' });
                          }
                        });
                      })
                      .catch(() => {
                        UIComponents.showToast('Checkout failed', 'error', { title: 'Billing' });
                      });
                    return false;
                  },
                },
                logoutAction,
              ]
            : [logoutAction];

          trialExpiredModalOrgId = orgId;
          trialExpiredLockedOrgId = orgId;
          _trialModalCanManageBilling = canManageBilling;

          // tp3dDebug: log modal render context for cross-tab diagnostics
          if (isTp3dDebugEnabled()) {
            const _roleInfo = resolveCanManageBillingForOrg(orgId);
            console.info('[TrialExpiredModal] render', {
              tabId: SupabaseClient && typeof SupabaseClient.getTabId === 'function' ? SupabaseClient.getTabId() : null,
              userId: _roleInfo.userId || null,
              orgId,
              billingStatus: snapshot && snapshot.status ? snapshot.status : null,
              membershipRole: _roleInfo.membershipRole || null,
              canManageBilling,
              roleSource: _roleInfo.roleSource || null,
            });
          }

          trialExpiredModalRef = UIComponents.showModal({
            title: 'Trial Ended',
            content: body,
            dismissible: false,
            hideClose: true,
            actions: modalActions,
            onClose: () => {
              trialExpiredModalRef = null;
              trialExpiredModalOrgId = null;
              _trialModalCanManageBilling = null;
              _trialModalLine1Ref = null;
              _trialModalRoleHintRef = null;
            },
          });
        };

        const maybeShowTrialWelcome = (snapshot, prevStatus) => {
          if (!snapshot || !snapshot.ok || snapshot.pending || String(snapshot.status || '') !== 'trialing') return;
          const orgId = String(snapshot.orgId || '').trim();
          if (prevStatus === 'trialing') return;
          if (!orgId || trialWelcomeShownOrgId === orgId) return;
          const storageKey = TRIAL_WELCOME_LS_PREFIX + orgId;
          try {
            if (window.localStorage && window.localStorage.getItem(storageKey) === 'true') return;
          } catch (_) {
            // ignore
          }
          trialWelcomeShownOrgId = orgId;
          try {
            if (window.localStorage) window.localStorage.setItem(storageKey, 'true');
          } catch (_) {
            // ignore
          }

          // ---- Build welcome modal content ----
          const wrap = document.createElement('div');
          wrap.className = 'tp3d-trial-welcome';
          const panel = document.createElement('div');
          panel.className = 'tp3d-trial-welcome__panel';
          wrap.appendChild(panel);

          // Title
          const titleEl = document.createElement('div');
          titleEl.className = 'tp3d-trial-welcome__title';
          titleEl.textContent = 'Welcome to Truck Packer';
          wrap.appendChild(titleEl);

          // Subtitle with styled inline phrase
          const subtitleEl = document.createElement('p');
          subtitleEl.className = 'tp3d-trial-welcome__subtitle';
          subtitleEl.appendChild(document.createTextNode('Your one stop shop for the '));
          const artEl = document.createElement('em');
          artEl.className = 'tp3d-trial-welcome__art';
          artEl.textContent = 'not so subtle art';
          subtitleEl.appendChild(artEl);
          subtitleEl.appendChild(document.createTextNode(' of truck packing'));
          wrap.appendChild(subtitleEl);

          // Section heading
          const sectionHeadingEl = document.createElement('p');
          sectionHeadingEl.className = 'tp3d-trial-welcome__section-heading';
          sectionHeadingEl.textContent = 'Start your 7-day free trial';
          wrap.appendChild(sectionHeadingEl);

          // Features intro
          const featuresIntroEl = document.createElement('p');
          featuresIntroEl.className = 'tp3d-trial-welcome__features-intro';
          featuresIntroEl.textContent = 'Get full access to all pro features:';
          wrap.appendChild(featuresIntroEl);

          // Feature checklist
          const featuresList = document.createElement('ul');
          featuresList.className = 'tp3d-trial-welcome__features';
          const featureItems = [
            'Unlimited load plans',
            'Unlimited case presets',
            'AutoPack',
            'Export to PDF',
            'Import cases from .xlsx or .csv',
          ];
          featureItems.forEach(text => {
  const li = document.createElement('li');
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-circle-check';
  icon.setAttribute('aria-hidden', 'true');
  li.appendChild(icon);

  // Make file extensions bold for readability.
  if (text === 'Import cases from .xlsx or .csv') {
    // Wrap all inline content in a span so it stays one grid item
    // (li uses display:grid; bare child nodes each become a grid item).
    const textWrap = document.createElement('span');
    textWrap.appendChild(document.createTextNode('Import cases from '));
    const xlsx = document.createElement('strong');
    xlsx.textContent = '.xlsx';
    textWrap.appendChild(xlsx);
    textWrap.appendChild(document.createTextNode(' or '));
    const csv = document.createElement('strong');
    csv.textContent = '.csv';
    textWrap.appendChild(csv);
    li.appendChild(textWrap);
  } else {
    li.appendChild(document.createTextNode(text));
  }

  featuresList.appendChild(li);
});
          wrap.appendChild(featuresList);

          // No credit card note
          const noteEl = document.createElement('p');
          noteEl.className = 'tp3d-trial-welcome__note';
          noteEl.textContent = 'No credit card required, click the button below to get started.';
          wrap.appendChild(noteEl);

          // Get Started CTA (closes modal)
          const ctaBtn = document.createElement('button');
          ctaBtn.type = 'button';
          ctaBtn.className = 'btn btn-primary tp3d-trial-welcome__cta';
          ctaBtn.textContent = 'Get Started';
          wrap.appendChild(ctaBtn);

          // Logout link
          const footerEl = document.createElement('div');
          footerEl.className = 'tp3d-trial-welcome__footer';
          const logoutBtn = document.createElement('button');
          logoutBtn.type = 'button';
          logoutBtn.className = 'tp3d-trial-welcome__logout';
          logoutBtn.textContent = 'Logout';
          logoutBtn.addEventListener('click', () => {
            void performUserInitiatedLogout({ source: 'trial-welcome' });
          });
          footerEl.appendChild(logoutBtn);
          wrap.appendChild(footerEl);

          // Show modal — empty title + hideClose so our custom header takes full body
          const _welcomeRef = UIComponents.showModal({
            title: '',
            hideClose: true,
            content: wrap,
            actions: [],
          });
          // Add scoped class to hide the empty modal-header skeleton
          if (_welcomeRef && _welcomeRef.modal) {
            _welcomeRef.modal.classList.add('tp3d-trial-welcome-modal');
          }
          // Wire Get Started → close
          ctaBtn.addEventListener('click', () => {
            try { _welcomeRef && typeof _welcomeRef.close === 'function' && _welcomeRef.close(); } catch (_) { /* ignore */ }
          });
        };

        const updateSidebarNotice = (s) => {
          const orgId = String((s && s.orgId) || '').trim();
          const _roleResult = resolveCanManageBillingForOrg(orgId);
          const _hydrationState = orgId ? getOrgRoleHydrationState(orgId) : 'unknown';
          const _backendCanManageBilling = s && typeof s.canManageBilling === 'boolean' ? s.canManageBilling : null;
          // When inflight, force canManageBilling false so owner-only UI stays hidden until role arrives
          const canManageBilling = _hydrationState === 'inflight'
            ? false
            : (_backendCanManageBilling !== null ? _backendCanManageBilling : _roleResult.canManageBilling);
          if (isTp3dDebugEnabled() && orgId && _hydrationState !== 'hydrated') {
            const _hydLabel = _hydrationState === 'inflight' ? 'not-hydrated' : 'hydrated-no-role';
            const _hydDetail = _hydrationState === 'unknown' ? 'complete' : _hydrationState;
            const _graceUntilTs = _orgRoleHydrationGraceUntilByOrg.get(orgId) || 0;
            console.info('[OrgRole]', _hydLabel, {
              orgId, hydration: _hydDetail, roleSource: _roleResult.roleSource,
              reason: _hydrationState === 'inflight'
                ? (_orgBundleFetchInflightForOrg === orgId ? 'bundle-inflight'
                  : orgContextInFlight ? 'context-inflight'
                  : authRehydratePromise ? 'auth-inflight'
                  : (_graceUntilTs > Date.now() ? 'grace' : 'other'))
                : undefined,
            });
          }
          const status = String((s && s.status) || '');
          const entitlementStatus = normalizeBillingEntitlementStatus(s && s.entitlementStatus);
          const _storedStatus = orgId ? (() => { try { return sessionStorage.getItem('tp3d:billing:status:' + orgId) || ''; } catch (_) { return ''; } })() : '';
          const prevStatus = orgId ? String(lastBillingStatusByOrg.get(orgId) || _storedStatus) : '';
          if (orgId && status) {
            lastBillingStatusByOrg.set(orgId, status);
            try { sessionStorage.setItem('tp3d:billing:status:' + orgId, status); } catch (_) { /* ignore */ }
          }
          const trialEndMs = s && s.trialEndsAt ? new Date(s.trialEndsAt).getTime() : NaN;
          const trialExpired = entitlementStatus
            ? entitlementStatus === 'trial_expired'
            : Boolean(
                s &&
                s.ok &&
                !s.pending &&
                !s.isActive &&
                (status === 'trial_expired' || (Number.isFinite(trialEndMs) && trialEndMs <= Date.now()))
              );

          if (trialExpired) {
            showTrialExpiredModal(s, canManageBilling);
          }
          else if (!s || (!s.pending && !s.loading)) {
            const _authSnap = getCurrentAuthSnapshot();
            const _signedIn = _authSnap.status === 'signed_in';
            const _activeOid = String(_authSnap.activeOrgId || '').trim();
            const _lockedForOrg = trialExpiredLockedOrgId && _signedIn && _activeOid === trialExpiredLockedOrgId;
            const _defActive = s && s.ok && (entitlementStatus ? BillingService.isEntitlementAllowed(entitlementStatus) : s.isActive);
            if (_lockedForOrg && !_defActive) {
              if (!trialExpiredModalRef) { try { showTrialExpiredModal(s, canManageBilling); } catch (_) { /* ignore */ } }
            } else {
              if (_defActive || !_signedIn || (trialExpiredLockedOrgId && _activeOid && _activeOid !== trialExpiredLockedOrgId)) {
                trialExpiredLockedOrgId = null;
                closeTrialExpiredModal();
              }
            }
          }

          maybeShowTrialWelcome(s, prevStatus);

          // --- Payment problem banner ---
          const paymentProblem = Boolean(
            s && s.ok && !s.pending && s.paymentProblem && !trialExpired
          );
          let payBanner = document.getElementById('tp3d-payment-banner');
          if (paymentProblem) {
            if (!payBanner) {
              payBanner = document.createElement('div');
              payBanner.id = 'tp3d-payment-banner';
              payBanner.className = 'tp3d-payment-banner';
              document.body.prepend(payBanner);
            }
            const graceDays = Number(s.paymentGraceRemainingDays) || 0;
            const graceText = graceDays > 0
              ? ' (' + graceDays + ' day' + (graceDays === 1 ? '' : 's') + ' remaining)'
              : '';
            // Build banner content via DOM to avoid innerHTML
            payBanner.textContent = '';
            const msgSpan = document.createElement('span');
            if (canManageBilling) {
              msgSpan.textContent = 'Payment issue \u2014 your subscription needs attention.' + graceText;
              payBanner.appendChild(msgSpan);
              let fixBtn = payBanner.querySelector('.tp3d-payment-banner-btn');
              if (!fixBtn) {
                fixBtn = document.createElement('button');
                fixBtn.className = 'tp3d-payment-banner-btn';
                fixBtn.textContent = 'Fix payment';
                fixBtn.addEventListener('click', () => { BillingService.openPortal(); });
                payBanner.appendChild(fixBtn);
              }
            } else {
              msgSpan.textContent = 'Payment issue \u2014 ask the workspace owner to update billing.' + graceText;
              payBanner.appendChild(msgSpan);
            }
            payBanner.hidden = false;
          } else if (payBanner) {
            // BUG-07: clear stale billing text at the source when hiding.
            payBanner.textContent = '';
            payBanner.hidden = true;
          }

          if (!upgradeEl) return;
          const upgradeCurrentlyVisible = Boolean(upgradeWrap ? !upgradeWrap.hidden : !upgradeEl.hidden);
          if (s.loading || s.pending) {
            // Keep the card title / content intact while syncing — only update button state.
            // This prevents the card from flipping to a blank/syncing state on tab focus.
            if (canManageBilling && upgradeCurrentlyVisible) {
              const syncingBtn = upgradeEl.querySelector('button');
              if (syncingBtn) {
                syncingBtn.disabled = true;
                syncingBtn.textContent = 'Syncing\u2026';
              }
              return;
            }
            // Card wasn't visible — keep it hidden until we have resolved data.
            // BUG-07: also clear stale markup so no prior-identity content can
            // survive in hidden DOM (hide-only retention was the root cause).
            upgradeEl.innerHTML = '';
            if (upgradeWrap) upgradeWrap.hidden = true;
            else upgradeEl.hidden = true;
            return;
          }
          if (!s.ok) {
            // Billing fetch failed — hide the upgrade card (do not show stale Upgrade CTA).
            upgradeEl.innerHTML = '';
            if (upgradeWrap) upgradeWrap.hidden = true;
            else upgradeEl.hidden = true;
            return;
          }
          const isTrial = entitlementStatus ? entitlementStatus === 'trialing' : status === 'trialing';
          const isIncludedInPlan = entitlementStatus === 'included_in_plan';
          const isWorkspaceLimitReached = entitlementStatus === 'workspace_limit_reached';
          const isOwnerSubscriptionRequired = entitlementStatus === 'owner_subscription_required';
          const isBillingUnavailable = entitlementStatus === 'billing_unavailable';
          const isEntitled = entitlementStatus
            ? BillingService.isEntitlementAllowed(entitlementStatus)
            : Boolean(s.isActive && s.isPro);
          const showInfoOnlyCard = Boolean(
            isWorkspaceLimitReached ||
            isOwnerSubscriptionRequired ||
            isBillingUnavailable
          );
          if (isIncludedInPlan || (isEntitled && !isTrial)) {
            upgradeEl.innerHTML = '';
            if (upgradeWrap) upgradeWrap.hidden = true;
            else upgradeEl.hidden = true;
            return;
          }
          if (!canManageBilling && !showInfoOnlyCard) {
            upgradeEl.innerHTML = '';
            if (upgradeWrap) upgradeWrap.hidden = true;
            else upgradeEl.hidden = true;
            return;
          }
          const needsUpgrade = entitlementStatus
            ? !isEntitled
            : (!s.isActive || !s.isPro);
          if (!isTrial && !needsUpgrade) {
            upgradeEl.innerHTML = '';
            if (upgradeWrap) upgradeWrap.hidden = true;
            else upgradeEl.hidden = true;
            return;
          }
          if (upgradeWrap) upgradeWrap.hidden = false;
          else upgradeEl.hidden = false;

          let trialDays = null;
          if (isTrial && s.trialEndsAt) {
            try {
              const endMs = new Date(s.trialEndsAt).getTime();
              if (Number.isFinite(endMs)) trialDays = Math.max(0, Math.ceil((endMs - Date.now()) / 86400000));
            } catch (_) { /* ignore */ }
          }

          upgradeEl.innerHTML = '';

          // Header: icon + title
          const headerEl = document.createElement('div');
          headerEl.className = 'tp3d-sidebar-upgrade-header';
          const iconEl = document.createElement('span');
          iconEl.className = 'tp3d-sidebar-upgrade-icon';
          iconEl.textContent = '\uD83D\uDCE6';
          const titleEl = document.createElement('div');
          titleEl.className = 'tp3d-sidebar-upgrade-title';
          titleEl.textContent = isWorkspaceLimitReached
            ? 'Workspace Limit'
            : isBillingUnavailable
              ? 'Billing'
              : isOwnerSubscriptionRequired && !canManageBilling
                ? 'Subscription Required'
                : 'Subscribe';
          headerEl.appendChild(iconEl);
          headerEl.appendChild(titleEl);
          upgradeEl.appendChild(headerEl);

          // Subtitle
          const subEl = document.createElement('div');
          subEl.className = 'tp3d-sidebar-upgrade-text';
          subEl.textContent = isWorkspaceLimitReached
            ? (canManageBilling
              ? 'This workspace is over your plan limit.'
              : "This workspace is over the owner's plan limit.")
            : isOwnerSubscriptionRequired
              ? (canManageBilling
                ? 'Start a subscription to enable Pro features.'
                : 'Ask the workspace owner to start or restore the subscription.')
              : isBillingUnavailable
                ? 'Billing is unavailable. Pro features may be unavailable until billing refreshes.'
              : isTrial && trialDays !== null
                ? 'Your free trial ends in ' + trialDays + ' day' + (trialDays !== 1 ? 's' : '')
                : 'Start a subscription to enable Pro features.';
          upgradeEl.appendChild(subEl);

          const buttonLabel = isOwnerSubscriptionRequired ? 'Subscribe' : 'Upgrade Plan';
          if (canManageBilling && !isBillingUnavailable) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-primary tp3d-sidebar-upgrade-btn';
            btn.textContent = buttonLabel;
            btn.addEventListener('click', () => {
              btn.disabled = true;
              pickCheckoutInterval({ _title: 'Choose Plan', _continueLabel: 'Continue' }).then(selection => {
                if (!selection || !selection.interval) {
                  btn.disabled = false;
                  return;
                }
                btn.textContent = 'Redirecting\u2026';
                BillingService.startCheckout({ interval: selection.interval }).then((r) => {
                  if (!r.ok) {
                    UIComponents.showToast(r.error || 'Checkout failed', 'error', { title: 'Billing' });
                    btn.disabled = false;
                    btn.textContent = buttonLabel;
                  }
                }).catch(() => {
                  btn.disabled = false;
                  btn.textContent = buttonLabel;
                });
              }).catch(() => {
                btn.disabled = false;
              });
            });
            upgradeEl.appendChild(btn);
          }
        };
        BillingService.setBillingGateApplier(updateSidebarNotice);
        BillingService.subscribeBilling(snapshot => BillingService.applyAccessGateFromBilling(snapshot, { reason: 'billing-subscriber' }));
        BillingService.subscribeBilling(snapshot => OrganizationService.markWorkspaceSwitchBillingReadyIfSettled(snapshot, 'billing-subscriber'));
        BillingService.applyAccessGateFromBilling(BillingService.getBillingState(), { reason: 'gate-init' });
      } catch (_) { /* ignore */ }

      try {
        installVisibleAuthRevocationCheck();
        startVisibleAuthRevocationCheck();
      } catch (_) { /* ignore */ }

      // Refresh billing on focus (throttled inside refreshBilling + cross-tab freshness)
      try {
        const requestBillingResumeRefresh = reason => {
          if (Date.now() - _bootStartedAtMs < 8000) return;
          const s = SupabaseClient.getSession && SupabaseClient.getSession();
          if (!s || !s.access_token) return;
          const now = Date.now();
          const focusOrgId = BillingService.getActiveOrgIdForBilling();
          const focusBillingOrgId = normalizeOrgIdForBilling(BillingService.getBillingState().orgId || '');
          const hasFocusOrgMismatch = Boolean(focusOrgId && focusBillingOrgId && focusBillingOrgId !== focusOrgId);
          if (hasFocusOrgMismatch) BillingService.reconcileBillingStateForActiveOrg('focus-mismatch:' + reason);
          const needsRecovery = Boolean(BillingService.getBillingState().loading || BillingService.getBillingState().pending || !BillingService.getBillingState().ok || BillingService.getBillingState().error);
          if (!hasFocusOrgMismatch && !needsRecovery && BillingService.getLastFocusRefreshAt() && (now - BillingService.getLastFocusRefreshAt()) < BILLING_FOCUS_REFRESH_COOLDOWN_MS) return;
          if (
            !hasFocusOrgMismatch &&
            !needsRecovery &&
            BillingService.getBillingState().ok &&
            BillingService.getBillingState().lastFetchedAt &&
            (now - BillingService.getBillingState().lastFetchedAt) < BILLING_FOCUS_REFRESH_COOLDOWN_MS
          ) return;
          // ── Cross-tab shared freshness: skip focus refresh if another tab fetched recently ──
          if (focusOrgId) {
            const sharedFreshAt = BillingService._getSharedBillingFreshness(focusOrgId);
            if (sharedFreshAt && (now - sharedFreshAt) < BILLING_FOCUS_REFRESH_COOLDOWN_MS) {
              const shared = BillingService._readShareableBillingResult(focusOrgId, 'focus:' + reason);
              if (shared) {
                billingDebugLog('billing:cross-tab-lock:skip-fresh', {
                  reason,
                  orgId: focusOrgId,
                  sharedAgeMs: now - sharedFreshAt,
                });
                // Reuse shared result if our local state is older
                if (BillingService._shouldApplySharedBillingSnapshotForOrg(focusOrgId, sharedFreshAt)) {
                  BillingService._applySharedBillingSnapshot(focusOrgId, shared, 'shared-fresh:' + reason);
                }
                return;
              }
              const unshareableShared = BillingService._readSharedBillingResult(focusOrgId);
              billingDebugLog(unshareableShared ? 'billing:cross-tab-lock:ignore-fresh-org-mismatch' : 'billing:cross-tab-lock:ignore-fresh-missing-result', {
                reason,
                orgId: focusOrgId,
                stateOrgId: unshareableShared && unshareableShared.orgId ? unshareableShared.orgId : null,
                sharedAgeMs: now - sharedFreshAt,
              });
            }
          }
          BillingService.markFocusRefreshAt(now);
          BillingService.refreshBilling({ force: false, reason }).catch(() => { });
        };
        window.addEventListener('focus', () => {
          requestBillingResumeRefresh('window-focus');
        });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) return;
          requestBillingResumeRefresh('tab-visible');
        });
      } catch (_) { /* ignore */ }

      // Handle Stripe return URL (?billing=success|cancel|portal_return)
      try {
        const billingParam = new URLSearchParams(window.location.search).get('billing');
        if (billingParam) {
          billingDebugLog('stripe-return:param', { billing: billingParam });
          // Clean URL (remove billing param without reload)
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('billing');
          window.history.replaceState({}, '', cleanUrl.toString());

          if (billingParam === 'success') {
            UIComponents.showToast('Payment successful! Your plan is being activated.', 'success', { title: 'Billing', duration: 8000 });
            BillingService.refreshBilling({ force: true, reason: 'stripe-return-success-now' }).catch(() => { });
            // Force refresh billing after a short delay (webhook may take a moment)
            setTimeout(() => { BillingService.refreshBilling({ force: true, reason: 'stripe-return-success-2s' }).catch(() => { }); }, 2000);
            setTimeout(() => { BillingService.refreshBilling({ force: true, reason: 'stripe-return-success-6s' }).catch(() => { }); }, 6000);
          } else if (billingParam === 'cancel') {
            UIComponents.showToast('Checkout was cancelled.', 'info', { title: 'Billing' });
            BillingService.refreshBilling({ force: true, reason: 'stripe-return-cancel' }).catch(() => { });
          } else if (billingParam === 'portal_return') {
            UIComponents.showToast('Billing updated. Syncing status\u2026', 'info', { title: 'Billing', duration: 6000 });
            BillingService.refreshBilling({ force: true, reason: 'stripe-return-portal' }).catch(() => { });
            setTimeout(() => { BillingService.refreshBilling({ force: true, reason: 'stripe-return-portal-4s' }).catch(() => { }); }, 4000);
          }
        }
      } catch (_) { /* ignore */ }

      // If a pending invite token exists and the user is already signed in, accept now.
      try {
        const currentSession = SupabaseClient.getSession && SupabaseClient.getSession();
        if (currentSession && currentSession.access_token) {
          tryAcceptPendingInvite(currentSession).catch(() => { });
        }
      } catch (_) { /* ignore */ }

      let prevScreen = StateStore.get('currentScreen');

      StateStore.subscribe((changes, _state, notification) => {
        const previewContextChanged = changes._replace ||
          Object.prototype.hasOwnProperty.call(changes, 'currentPackId') ||
          (changes.currentScreen && changes.currentScreen !== prevScreen);
        // P0.9 – While swapping storage scope, skip autosave so we don't
        // persist stale (old-user/workspace) data into the new scope.
        if (
          !suspendAutoSave &&
          (
            changes.preferences ||
            changes.caseLibrary ||
            changes.packLibrary ||
            changes.folderLibrary ||
            changes.currentPackId ||
            changes._undo ||
            changes._redo ||
            changes._replace
          )
        ) {
          Storage.saveSoon();
        }
        if (notification?.type === 'pack-preview') {
          PacksUI.render();
          return;
        }
        if (notification?.type === 'pack-view') {
          AutoPackPreviewScheduler.schedule();
          return;
        }
        // Measurement-only write: already autosaved above. Refresh the overlay/list and the Load Plan
        // card (lastEdited); no cargo, scene or Inspector work is needed. The edit replaced the Pack
        // object, which aborts an automatic preview capture that was waiting for its frames, so the
        // freshness check is requested again: it retries only when the preview is still missing or
        // stale, and a current thumbnail finds no candidate (no needless recapture).
        if (notification?.type === 'pack-measurements') {
          PacksUI.render();
          EditorUI.syncMeasurements();
          AutoPackPreviewScheduler.schedule();
          return;
        }
        // Annotation-only write: the same route as a measurement write. Autosaved above; refresh the overlay
        // and list and the Load Plan card (lastEdited), re-request the preview freshness check, and do no
        // cargo, scene or Inspector work.
        if (notification?.type === 'pack-annotations') {
          PacksUI.render();
          EditorUI.syncAnnotations();
          AutoPackPreviewScheduler.schedule();
          return;
        }
        if (notification?.type === 'viewport-controls-preference') {
          EditorUI.syncViewportControls();
          return;
        }
        if (changes.preferences || changes._undo || changes._redo || changes._replace) {
          const prefs = StateStore.get('preferences');
          if (prefs && prefs.theme) PreferencesManager.applyTheme(prefs.theme);
          SceneManager.refreshTheme();
          if (StateStore.get('currentScreen') === 'editor') EditorUI.render();
        }

        if (changes.currentScreen || changes._replace) {
          const nextScreen = StateStore.get('currentScreen');
          prevScreen = nextScreen;

          AppShell.renderShell();
          EditorUI.render();
        }

        if (changes.caseLibrary || changes.packLibrary || changes.folderLibrary || changes._undo || changes._redo || changes._replace) {
          PacksUI.render();
          CasesUI.render();
          EditorUI.render();
          if (StateStore.get('currentScreen') === 'editor') AppShell.renderShell();
        }
        if (changes.currentPackId) {
          AppShell.renderShell();
          EditorUI.render();
        }
        // Context loss clears pending work; activation schedules a NEW request
        // only after the real Editor render has synchronized the committed Pack.
        if (previewContextChanged || changes.packLibrary || changes.caseLibrary ||
            changes.preferences || changes._undo || changes._redo) AutoPackPreviewScheduler.schedule();
        if (changes.autoPackResults) {
          EditorUI.render();
        }
        if (changes.selectedInstanceIds) {
          EditorUI.renderSelection();
        }
        if (
          changes.currentScreen ||
          changes.currentPackId ||
          changes.packLibrary ||
          changes._undo ||
          changes._redo ||
          changes._replace
        ) {
          RecoverableErrorOverlay.syncRecoverableErrorOverlay();
        }
      });

      try {
        Router.init({
          onScreen: screen => {
            routeNotFoundActive = false;
            ErrorOverlay.hide();
            if (screen === 'settings') openSettingsFromRoute();
            else AppShell.navigate(screen, { fromRoute: true });
            RecoverableErrorOverlay.syncRecoverableErrorOverlay();
          },
          onNotFound: () => {
            routeNotFoundActive = true;
            RecoverableErrorOverlay.syncRecoverableErrorOverlay();
          },
          onNeutral: () => {
            routeNotFoundActive = false;
            RecoverableErrorOverlay.syncRecoverableErrorOverlay();
          },
        });
      } catch (err) {
        console.error('[TruckPackerApp] Router init error:', err);
      }

      renderAll();
      if (!supabaseInitOk) {
        markAppReady();
        return;
      }
      await bootstrapAuthGate();
      markAppReady();
      flushPendingSettingsRoute();
      })().finally(() => {
        initInFlightPromise = null;
        initCompleted = true;
      });
      return initInFlightPromise;
    }

    return {
      init,
      maybeScheduleBillingRefresh,
      getWorkspaceSwitchState,
      handleWorkspaceArchived,
      handleWorkspaceRestored,
      handleWorkspaceUpdated,
      openCreateWorkspaceFlow,
      EditorUI,
      ui: {
        showToast: UIComponents.showToast,
        showModal: UIComponents.showModal,
        confirm: UIComponents.confirm,
      },
      _debug: { Utils, StateStore, Storage, CaseLibrary, PackLibrary, Defaults },
    };
  })();

  function checkBrowserSupport() {
    const ua = navigator.userAgent || '';
    const safariMatch = ua.match(/Version\/(\d+\.\d+).*Safari/);
    if (safariMatch) {
      const version = parseFloat(safariMatch[1]);
      if (version < 13.1) {
        console.warn('[TruckPackerApp] Safari ' + version + ' detected. Safari 13.1+ required for ES2020 support.');
        return false;
      }
    }
    const firefoxMatch = ua.match(/Firefox\/(\d+)/);
    if (firefoxMatch) {
      const version = parseInt(firefoxMatch[1], 10);
      if (version < 88) {
        console.warn('[TruckPackerApp] Firefox ' + version + ' detected. Firefox 88+ recommended.');
        return false;
      }
    }
    return true;
  }

  const boot = () => {
    if (window.__TP3D_FLAGS__ && window.__TP3D_FLAGS__.maintenanceMode) return;
    if (!checkBrowserSupport()) {
      const msg =
        'Your browser version may not be fully supported. Please upgrade to Chrome 90+, Firefox 88+, Safari 13.1+, or Edge 90+ for the best experience.';
      console.warn('[TruckPackerApp]', msg);
    }
    console.info('[TruckPackerApp] boot -> init');
    window.TruckPackerApp.init().catch(err => {
      console.error('[TruckPackerApp] fatal boot error:', err);
      showFatalOverlay({ message: normalizeFatalMessage(err) });
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
