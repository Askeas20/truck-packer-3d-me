# Cargo Planner 3D — LLM QA and Repository Navigation Runbook

**Navigation baseline:** 2026-08-04 · `main` at `7409b12`

**Test commands and validation policy verified:** 2026-10-03 · P2.5 branch based on `fe4bfe3`
**Repository:** Truck Packer 3D (`Fdeoliveira24/truck-packer-3d`)

Navigation details outside the test and CI sections retain the older baseline; verify them against
current source before using them.

---

## 1. Purpose and Audience

This is the required starting point for any agent performing browser QA, Playwright automation,
runtime debugging, UI review, stress testing, or end-to-end validation on the Truck Packer 3D
codebase.

**Before beginning a QA task, read Sections 1, 2, 9, and 23.** Use the remaining sections as a
reference according to the Fast Lookup Index.

This document exists to prevent agents from wasting context and tokens searching for entry points,
commands, selectors, test data, authentication requirements, debugging tools, or evidence locations
that are already known and verified.

This document is **not**:

- the active operational TODO (that is `docs/product/TP3D-MASTER-TODO-V6.md`)
- a product roadmap
- an architecture contract
- a replacement for domain-specific test evidence
- permission to alter production data, remote resources, or active branches

---

## 2. Source-of-Truth Order

Each document class has a defined scope. Consult the most specific authority for the question at
hand.

| Priority | Document                           | Location                                                                                                                                         | Scope                                                                        |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1        | Active agent instructions          | `AGENTS.md`, `CLAUDE.md`, `src/CLAUDE.md`                                                                                                        | How agents work: editing style, risk classification, safe change boundaries  |
| 2        | Operational source of truth        | `docs/product/TP3D-MASTER-TODO-V6.md`                                                                                                            | Active task, approved branch, blockers, execution status                     |
| 3        | Domain contracts                   | `docs/engineering/autopack-engine-contract.md`, `docs/product/BILLING_ENTITLEMENT_RULES.md`, `docs/engineering/business-identity-contract-v1.md` | Permanent behavioral rules within each contract's stated scope               |
| 4        | Current source and tests           | `src/`, `tests/`, `supabase/`                                                                                                                    | Actual runtime behavior                                                      |
| 5        | Dedicated audit/evidence documents | `docs/audits/`, `docs/billing/`, `docs/dev/`                                                                                                     | Evidence supporting conclusions — do not derive active work items from these |
| 6        | Archived TODOs                     | `docs/archive/`                                                                                                                                  | Historical record only — never treat as current behavior                     |

**Scope guidance:**

- **Agent instructions** govern how agents work: what to edit, risk levels, change style.
- **V6** governs the active task, approved branch, blockers, and execution status.
- **Domain contracts** govern behavior inside their defined scope. The AutoPack contract rules
  AutoPack geometry; the billing entitlement rules rule billing semantics.
- **Current source and tests** describe actual runtime behavior. When behavior is ambiguous, source
  is authoritative over any document.
- **Audit/evidence documents** support conclusions but do not create or approve active work.
- **Archived documents** are historical only. Never treat an archived TODO as a description of
  current behavior.

When a domain contract and V6 appear to conflict, the domain contract governs behavior within its
stated scope; V6 governs whether that work is active or deferred.

---

## 3. Repository Fast Map

| Location                            | Owns                                                                                                                                              | Inspect when                                               | Must not assume                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `index.html`                        | App entry, vendor loading, boot sequence, all static markup, all DOM IDs                                                                          | Always first for browser QA; finding screen selectors      | That IDs match dynamically rendered content              |
| `src/app.js`                        | App wiring, auth lifecycle, workspace lifecycle, screen orchestration, keyboard shortcuts, billing state                                          | App-boot bugs, workspace-switch issues, cross-screen state | It is monolithic; it was modularized in PR #7            |
| `src/core/`                         | State store, storage, events, session, Supabase client, operation lifecycle, normalizer, defaults, business-identity, constants                   | State bugs, storage-scope bugs, lifecycle locks            | `storage.js` is P0-risk; edit only when clearly required |
| `src/services/`                     | CaseLibrary, PackLibrary, AutoPack engine, AutoPack solver, billing, auth, import/export, organization, category, preferences                     | Feature-specific logic bugs                                | Services are not UI — they do not own DOM                |
| `src/screens/`                      | Screen-level UI modules: `cases-screen.js`, `packs-screen.js`, `editor-screen.js`, `updates-screen.js`, `roadmap-screen.js` | Screen-specific QA and UI bugs                             | Screen modules delegate persistence to services          |
| `src/ui/`                           | App shell, overlays, error overlays, system overlay, keyboard manager, truck-change controller, UI components                                     | Overlay and modal QA, error display bugs                   | Many overlays are lazily initialized                     |
| `src/ui/overlays/`                  | Auth, account, settings, case modal, notes, card display, help, import dialogs                                                                    | Auth flow, settings rendering, modal QA                    | `settings-overlay.js` is large and org-scoped            |
| `src/editor/`                       | Scene runtime, geometry factory, trailer geometry, surface picker, measurement tool, annotation tool                                              | Editor/3D scene QA, geometry bugs                          | This is separate from `src/packing-core/`                |
| `src/packing-core/`                 | AutoPack budget, domain, explain, orientation, repair, retention-model, solution, space-model, validation, wheel-well-model                       | AutoPack correctness QA                                    | Do not modify solver geometry without explicit V6 scope  |
| `src/features/editor/`              | Editor feature modules                                                                                                                            | Editor feature flags                                       | May be lightly populated                                 |
| `src/auth/`                         | Auth permissions and session helpers                                                                                                              | Auth debugging                                             | Session lifecycle is also in `src/core/session.js`       |
| `src/config/`                       | Feature flags (`features.js`), plan config (`plans.js`), role config (`roles.js`)                                                                 | Gating behavior, plan limit checks                         | Config is not the billing entitlement truth — backend is |
| `src/router.js`                     | Client-side routing, hash-based navigation between screens                                                                                        | Navigation bugs                                            | Routing is hash-based; no server-side routing            |
| `styles/main.css`                   | All app CSS                                                                                                                                       | Visual/layout QA, dark-mode bugs                           | CSS is not modularized per component                     |
| `tests/audit/`                      | Node-run audit tests, including eight Chromium specs                                                                                              | Running focused specs or the required CI lanes             | Some specs launch a browser                              |
| `tests/behavioral/`                 | Behavioral test artifacts                                                                                                                         | Behavioral regression checks                               | Inspect for current coverage                             |
| `tests/local-db/`                   | Local Supabase billing, ownership, security tests                                                                                                 | Local Supabase QA                                          | Requires local Supabase running                          |
| `tests/integration/dev-billing/`    | Deployed Edge Function billing tests                                                                                                              | Deployed development QA                                    | Requires live dev Supabase credentials                   |
| `tests/integration/stripe-billing/` | Stripe test-mode billing tests                                                                                                                    | Stripe QA                                                  | Requires Stripe test-mode keys                           |
| `tests/stress.spec.js`              | UI stress test                                                                                                                                    | Stress/performance QA                                      | Separate from `npm test`; uses `stress:ui`               |
| `scripts/billing-fixtures/`         | Billing fixture seeding, verification, cleanup scripts                                                                                            | Local and dev billing QA                                   | Never run against production                             |
| `scripts/local-fixtures/`           | Local Supabase environment verification, cleanup                                                                                                  | Local Supabase setup                                       | Requires local Supabase                                  |
| `supabase/migrations/`              | Database schema migrations (30 migrations)                                                                                                        | Schema understanding, drift debugging                      | Do not edit without explicit V6 scope                    |
| `supabase/functions/`               | Edge Functions: billing, org management, auth, Stripe                                                                                             | Edge Function debugging                                    | Each function is in its own subdirectory                 |
| `supabase/config.toml`              | Local Supabase config (project ID, ports)                                                                                                         | Local Supabase setup                                       | Ports may vary from development                          |
| `docs/product/`                     | V6, billing entitlement rules, product strategy debrief                                                                                           | Operational status, billing product rules                  | Product debrief is not an implementation approval        |
| `docs/engineering/`                 | Architecture contracts, AutoPack contract, business identity contract                                                                             | Domain behavior rules                                      | Engineering docs are frozen contracts, not TODOs         |
| `docs/audits/`                      | Audit reports and evidence                                                                                                                        | Evidence lookup                                            | Audits are historical evidence only                      |
| `docs/billing/`                     | Pricing operations runbook, billing evidence                                                                                                      | Billing operations                                         | Runbook does not approve commercial terms                |
| `docs/dev/`                         | Developer-facing docs                                                                                                                             | Development setup                                          | May contain outdated procedures                          |
| `graphify-out/`                     | Pre-built knowledge graph; consult `graphify-out/GRAPH_REPORT.md` or the current Graphify query output for current counts                         | Architecture questions, cross-file relationships           | Graph may lag behind recent commits                      |
| `package.json`                      | All verified npm scripts                                                                                                                          | Finding exact test/lint commands                           | Do not invent commands — use only what is in scripts     |

---

## 4. Runtime Entry and Boot Sequence

**Entry point:** `index.html`  
**App module:** `src/app.js` (imported as ES module)

### Verified boot flow

```
index.html
  ├── BOOT init script (window.__TP3D_BOOT object, CDN failure capture)
  │
  ├── Three.js npm runtime (three@0.185.1 / r185, bundled by Vite):
  │   `import('./src/bootstrap/three-runtime.js')` → `installThreeRuntime()` asserts r185 and sets
  │   `window.THREE` (including OrbitControls from `three/addons`); awaited as `window.__TP3D_BOOT.threeReady`.
  │   There is no CDN or vendor fallback for Three.
  │
  ├── Vendor scripts (Supabase, Font Awesome, TWEEN, jsPDF, XLSX)
  │   └── Each has CDN primary → CDN fallback → local vendor/ fallback
  │   └── window.__tp3dVendorOk / window.__tp3dVendorFail callbacks
  │
  ├── Maintenance mode check (window.__TP3D_FLAGS__.maintenanceMode)
  │   └── If true → show 'maintenance' overlay → stop
  │
  ├── Fatal error / vendor timeout sentinel (appReady / loading timeout)
  │   └── If vendor load times out → show 'fatal' app status overlay
  │
  └── import('./src/app.js') — ES module, runs once
        ├── initTP3DDebugger()
        ├── Router initialization
        ├── Screen creation (createPacksScreen, createCasesScreen, createEditorScreen, ...)
        ├── Supabase client initialization (src/core/supabase-client.js)
        ├── Auth gate setup + onAuthStateChange listener
        │     ├── Signed out → AuthOverlay shown
        │     └── Signed in → workspace resolution begins
        ├── Workspace resolution (workspaceReady polling, org bundle fetch)
        ├── Billing state load (BillingService.refreshBilling)
        ├── Workspace UI sync (sidebar, topbar, workspace switcher)
        └── Screen render / active screen activation
```

**Boot globals** (verified in live browser, `window.__TP3D_BOOT` keys): `cdnFailures`,
`vendorLoaded`, `vendorPromises`, `vendorResolvers`, `fatalOverlayShown`, `maintenanceMode`,
`showAppStatusOverlay`, `threeReady`, `runtimeFatalHandlersInstalled`, `appReady`

**Maintenance mode:** Controlled by `window.__TP3D_FLAGS__.maintenanceMode` injected inline before
`src/app.js` imports. When true, the app shows a maintenance overlay and never imports app modules.

**CDN failures:** Each vendor registers with `__tp3dVendorOk`/`__tp3dVendorFail`. Failures
accumulate in `window.__TP3D_BOOT.cdnFailures`. The system overlay shows a CDN recovery UI when a
required vendor fails all fallbacks.

---

## 5. Main Product Surfaces

All surfaces verified against live DOM using the `main` baseline at `7409b12`.

### Screens

| Screen | Module | Root DOM ID | Notes | |---|---|---| ---| | Load Plans |
`src/screens/packs-screen.js` | `#screen-packs` | Customer-facing name; internal: Pack | | Cases |
`src/screens/cases-screen.js` | `#screen-cases` | Case library management | | Editor |
`src/screens/editor-screen.js` | `#screen-editor` | 3D scene, AutoPack, Inspector | | Release Notes
| `src/screens/updates-screen.js` | `#screen-updates` | Static update log | | Roadmap |
`src/screens/roadmap-screen.js` | `#screen-roadmap` | Static roadmap content |

**Settings surface note:** Settings is a single overlay, not a screen. The **Settings overlay**
(`src/ui/overlays/settings-overlay.js`) is opened via `openSettingsOverlay(tab)`. Its Preferences tab
hosts the per-user preference controls (units, theme, label size, hidden-case opacity, snapping, grid
size, screenshot resolution, PDF stats, AutoPack options); its other tabs host org-scoped settings:
billing, workspace membership, invites, and org general settings. The legacy Settings screen
(`settings-screen.js`, `#screen-settings`) was retired in P2. `#/settings` remains a compatibility
entry: it settles on a stable screen and opens the overlay on Preferences.

### Overlays and Modals

| Overlay            | Module                                    | Trigger                        | Notes                                                                                  |
| ------------------ | ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| Authentication     | `src/ui/overlays/auth-overlay.js`         | Signed out                     | Dialog role, blocks all app content                                                    |
| Account            | `src/ui/overlays/account-overlay.js`      | Account switcher button        | Workspace/org/billing/members/invites                                                  |
| Settings (overlay) | `src/ui/overlays/settings-overlay.js`     | `openSettingsOverlay(tab)`     | Preferences, plus org-scoped billing, members, invites, org general. |
| Case Modal         | `src/ui/overlays/case-modal.js`           | New/Edit case                  | Case create and edit                                                                   |
| Notes Overlay      | `src/ui/overlays/notes-overlay.js`        | Item Notes, Pack Notes actions | Three-tier cargo instructions                                                          |
| Card Display       | `src/ui/overlays/card-display-overlay.js` | Card Display toolbar button    | Grid card field configuration                                                          |
| Help Modal         | `src/ui/overlays/help-modal.js`           | Help action                    | In-app help                                                                            |
| Import Cases       | `src/ui/overlays/import-cases-dialog.js`  | Import Cases action            | CSV/XLSX import                                                                        |
| Import Load Plan   | `src/ui/overlays/import-pack-dialog.js`   | Import Load Plan action        | JSON import                                                                            |
| Import App/Backup  | `src/ui/overlays/import-app-dialog.js`    | App Backup import              | Full workspace restore                                                                 |
| Error Overlay      | `src/ui/error-overlay.js`                 | Fatal runtime errors           | `#error-overlay`, `#error-icon`, `#error-title`, `#error-body`, `#error-actions`       |
| System Overlay     | `src/ui/system-overlay.js`                | CDN failures, vendor issues    | `#system-overlay`, `#system-title`, `#system-message`, `#system-retry`                 |
| Truck Change       | `src/ui/truck-change-controller.js`       | Update Truck action in Editor  | Modal preview before committing truck config                                           |

### Key DOM IDs (all verified in live DOM)

**Application shell:**

- `#app` — root app container
- `#sidebar` — left navigation sidebar (`<aside>`)
- `#btn-account-switcher` — workspace/account switcher button
- `#btn-sidebar` — sidebar collapse toggle
- `#topbar-title` — current screen title
- `#topbar-subtitle` — screen subtitle
- `#modal-root` — shared modal mount point
- `#toast-container` — toast notification container
- `#tp3d-offline-indicator` — offline state indicator

**Load Plans screen (`#screen-packs`):**

- `#btn-new-pack`, `#btn-import-pack` — create/import actions
- `#packs-search` — search input
- `#packs-view-grid`, `#packs-view-list` — view toggle buttons
- `#packs-sort`, `#packs-filters-toggle`, `#packs-card-display`, `#packs-trailer-presets` — toolbar
  controls
- `#packs-grid`, `#packs-list`, `#packs-tbody` — content containers
- `#packs-empty` — empty state card

**Cases screen (`#screen-cases`):**

- `#btn-new-case`, `#btn-cases-import`, `#btn-cases-template` — create/import actions
- `#cases-search` — search input
- `#cases-view-grid`, `#cases-view-list` — view toggle buttons
- `#cases-sort`, `#cases-filters-toggle`, `#cases-card-display`, `#btn-manage-categories` — toolbar
  controls
- `#cases-grid`, `#cases-tbody` — content containers
- `#cases-empty` — empty state card

**Editor screen (`#screen-editor`):**

- `#viewport` — WebGL/Three.js canvas container
- `#viewport-toolbar` — top toolbar
- `#btn-autopack`, `#btn-unpack` — AutoPack/Unpack actions
- `#btn-share`, `#btn-screenshot`, `#btn-pdf` — export actions
- `#btn-editor-left`, `#btn-editor-right` — panel toggle buttons
- `#editor-left` — left panel (Case Browser)
- `#editor-case-search`, `#editor-case-filters-toggle`, `#editor-case-list` — Case Browser controls
- `#editor-right` — right panel (Inspector)
- `#inspector-body` — Inspector content

**Settings overlay → Preferences tab** (generated DOM; no `#pref-*` ids — locate `.tp3d-settings-row`
rows by label text):

- Rows: Length, Weight, Hidden Case Opacity, Label Font Size, Snapping, Grid Size (in), Show AutoPack
  loading screen (`data-role="autopack-loading-visibility"`), AutoPack Results starting view
  (`data-role="autopack-results-start-view"`), Screenshot Resolution, Include Stats in PDF, Theme
- `Save changes` button — persists the form through `PreferencesManager.set()`
- There is no reset/demo-data action; the retired legacy screen's `#btn-reset-demo` is gone

**Selector stability guidance:**

- All `#id` values listed above are **current DOM IDs** verified in the live app.
- No `data-testid` attributes exist in the current codebase. Selectors by ID are the most reliable.
  Class selectors are fragile.
- If a selector breaks, inspect `index.html` directly — all structural IDs are defined there.

---

## 6. How to Start the Application

### 6.1 Static file server (primary development method)

The app ships as static assets. No build step is required.

```bash
# Any static HTTP server works. Example with VS Code Live Server:
# Open index.html in VS Code → "Open with Live Server"
# Default: http://localhost:5500/index.html

# Or with npx:
cd "/path/to/Truck Packer 3D"
npx serve . -l 5500
# URL: http://localhost:5500/index.html
```

- **Prerequisites:** None beyond a static server. Network access to CDN vendors (Supabase
  JS, Font Awesome, TWEEN, jsPDF, XLSX) is required on first load. Three.js is bundled by Vite from
  the npm package (r185) and needs no CDN. Local vendor fallbacks exist in `vendor/` for the
  non-Three libraries but may be outdated.
- **Supabase required:** Yes — authentication and workspace data require a Supabase connection. The
  Supabase URL and anon key are embedded in the app at runtime from `src/core/supabase-client.js`.
  Without valid Supabase config, auth fails.
- **file:// URL:** The app comment states file:// works for demos. Some browser APIs (CORS,
  SharedArrayBuffer) are restricted on file://. Use http:// for reliable QA.
- **Environment variables:** None are required in the browser. Edge Function env vars are
  server-side only.

### 6.2 Local Supabase (for database/RLS/Edge Function testing)

```bash
# Start local Supabase stack
supabase start

# Expected URLs (from supabase/config.toml):
# API:  http://127.0.0.1:54321
# Studio: http://127.0.0.1:54323
# Inbucket email: http://127.0.0.1:54324

# ⚠️  DESTRUCTIVE LOCAL COMMAND — operator approval required.
# Drops and recreates the entire local database from scratch.
# Never run automatically. Verify the active Supabase target before running.
# This command only affects the local Docker instance — it never touches hosted dev or production.
supabase db reset
```

- **Prerequisites:** Docker running, `supabase` CLI installed, valid `supabase/config.toml`.
- **Warning:** Local Supabase uses a separate project configuration. The browser app still connects
  to the configured Supabase URL in `src/core/supabase-client.js`, which may point to the hosted
  development instance, not localhost. Switching between local and hosted requires code changes —
  confirm which target is active before testing.

### 6.3 Hosted development environment

- The app can be opened directly at the development Supabase-backed URL.
- Credentials and URL must be provided by the human operator (`<DEVELOPMENT_APP_URL>`).
- Used for deployed Edge Function testing and real network billing/Stripe flows.

### 6.4 No authenticated local browser startup without credentials

There is no anonymous or seed-account-based automated browser session. Browser QA past the auth
overlay always requires operator-supplied sign-in credentials.

---

## 7. Authentication and Test Accounts

### Auth flow

1. `src/app.js` initializes the Supabase client via `src/core/supabase-client.js`.
2. `supabase.auth.onAuthStateChange` listener is installed early in boot.
3. **Signed out:** `AuthOverlay` (`src/ui/overlays/auth-overlay.js`) is shown as a dialog. All app
   screens remain hidden behind it.
4. **Sign-in method:** Email + password via Supabase auth. Magic link is not currently the primary
   supported method.
5. **Callback behavior:** On successful auth, `onAuthStateChange` fires `SIGNED_IN`, workspace
   resolution begins, billing is refreshed, and screens are rendered.
6. **Session restoration:** Supabase persists the session in `localStorage`. On reload, the session
   is restored automatically before the auth overlay would show.
7. **Workspace resolution:** After auth, `workspaceReady()` polls org bundle until an active org is
   confirmed. If no org exists, the app shows an org-required banner.

### QA authentication

- No automated test accounts are provisioned in the current codebase.
- Credentials must be supplied by the human operator before browser QA.
- Placeholder for test account: `<QA_USER_EMAIL>` / `<QA_USER_PASSWORD>`
- Placeholder for app URL: `<DEVELOPMENT_APP_URL>`
- Verified QA path for local browser testing requires a real Supabase-authenticated user to be
  created in the target environment by the operator.

### What agents must never do

- Never print, log, or store email addresses, passwords, magic links, service-role keys, webhook
  secrets, or any private credentials.
- Never hardcode credentials into test files, source code, or documentation.
- Never reuse a production user's credentials for QA.

---

## 8. Environment Matrix

| Environment                            | Purpose                                            | Allowed                                                                               | Prohibited                                                     | Credentials required                     | Cleanup                                        |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Local browser only (no local Supabase) | Browser UI QA against hosted dev Supabase          | Read/display QA, manual navigation, screenshot                                        | Writing to production tables, changing production data         | Operator QA credentials for dev Supabase | None — read-only                               |
| Local browser + local Supabase         | Database, RLS, Edge Function testing               | Local fixture seeding, local billing tests, membership/org tests, schema verification | Touching hosted dev or production                              | Operator local Supabase credentials      | `supabase db reset` or fixture cleanup scripts |
| Hosted development Supabase            | Deployed Edge Function QA, billing lifecycle tests | Fixture-scoped dev billing tests, workspace/org lifecycle tests                       | Modifying unrelated workspace data, touching production Stripe | Operator dev project credentials         | `npm run billing:fixtures:dev:cleanup`         |
| Stripe test mode                       | Stripe billing API QA                              | Test-mode Stripe events, webhook testing, checkout/portal flows                       | Live-mode Stripe keys, real customer charge                    | Operator Stripe test-mode keys           | `npm run billing:fixtures:stripe:cleanup`      |
| Production                             | Live customer environment                          | None during development QA                                                            | All QA operations                                              | N/A — do not use                         | N/A                                            |

**Absolute rule:** Disposable QA must never target production or real customer data. Any test that
writes to a database must run against local Supabase or a clearly isolated development fixture set.

---

## 9. Browser QA Fast Path

Use this checklist to begin useful browser QA in a few minutes.

1. **Confirm the exact repository folder, branch, and clean state.**
   - Confirm you are working inside the original Truck Packer 3D repository folder.
   - Confirm the expected branch for the current task.
   - Run `git status -sb && git log --oneline -1`.
   - **If unexpected changes exist, stop before starting QA or changing branches.** Preserve
     existing work. Do not hide, relocate, or discard it.
   - Do not proceed until the working tree matches the expected state.
2. **Read V6 for current active task and approved branch.** `docs/product/TP3D-MASTER-TODO-V6.md` →
   Section 4 (Active Work).
3. **Start a static HTTP server** on the workspace root.  
   Confirm the app loads at `http://localhost:5500/index.html`.
4. **Confirm vendor loading** — open browser console, check for CDN errors. No
   `__TP3D_BOOT.cdnFailures` entries should remain for required vendors.
5. **Sign in** with operator-supplied QA credentials.  
   Auth overlay (`dialog` with heading "Truck Packer 3D") appears at boot.  
   Fill `input[type="email"]` and `input[type="password"]`, click "Sign in".
6. **Confirm active workspace.** Check sidebar account switcher shows a workspace name.
7. **Confirm fixture or test data** is present for the target test (Cases, Load Plans).
8. **Navigate to the target screen** using the sidebar navigation.
9. **Reproduce or test** the specific behavior.
10. **Collect evidence** (screenshot, console errors, network logs) — see Section 20.
11. **Reset or clean up** test fixture data if any records were created.

---

## 10. Playwright and Browser Automation

### Current status

`playwright` (v1.62.1) is installed as a dev dependency. Seven audit specs use Chromium through
browser harnesses and run in the serial CI browser lane. There is no `playwright.config.*` or
`playwright test` project; the repository uses Node's test runner for these specs. The separate
`playwright-cli` tool remains available for ad-hoc browser inspection and manual QA evidence.

### What a separate Playwright Test project would require

- A `playwright.config.ts` or `playwright.config.js` at the project root.
- A `tests/e2e/` or `tests/browser/` directory for spec files.
- A `baseURL` pointing to `http://localhost:5500` (or configurable via env var).
- Storage state handling for authenticated sessions (state-save after login, reuse per spec).
- A setup script or global setup fixture to perform the email/password auth flow once.
- Browser projects: at minimum Chromium; optionally Firefox and WebKit.
- Screenshot, trace, and video artifact paths.
- Environment variable injection for `<QA_USER_EMAIL>` and `<QA_USER_PASSWORD>`.
- A `package.json` script: `"test:e2e": "playwright test"`.

Do not claim Playwright coverage exists from ad-hoc `playwright-cli` usage.

---

## 11. Test Command Matrix

Test and CI commands below were verified from `package.json` and the Quality Gate workflow.

| Command                                   | What it proves                                                   | Prerequisites                               | Category           | Writes data?                      | Cleanup                           |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- | ------------------ | --------------------------------- | --------------------------------- |
| `npm test`                                | Local audit suite, including Chromium specs                     | Node.js, installed Chromium                | full local        | No                                | None                              |
| `npm run test:ci:node`                    | 44 non-browser audit specs at concurrency 2                     | Node.js                                     | required CI lane  | No                                | None                              |
| `npm run test:ci:browser`                 | Fast Chromium smoke set: four small specs plus 24 selected tests from four large ones (about 2 min locally) | Node.js, installed Chromium (headless shell) | required CI lane  | No                                | None                              |
| `npm run test:ci`                         | Node lane, then the fast browser smoke set (what the PR gate runs) | Node.js, installed Chromium                | required CI lane  | No                                | None                              |
| `npm run quality:ci`                      | Local mirror of the PR gate: lint, typecheck, Node lane, smoke set, build, audit | Node.js, installed Chromium                | required CI lane  | No                                | None                              |
| `npm run test:regression:browser`         | The complete Chromium suite: all eight specs at concurrency 1 (about 25 min on a hosted runner) | Node.js, installed Chromium                | full local        | No                                | None                              |
| `npm run test:regression`                 | Full regression: Node lane, then the complete Chromium suite. Not run by GitHub | Node.js, installed Chromium                | full local        | No                                | None                              |
| `node --test tests/behavioral/app-js-characterization.spec.mjs` | Auth/workspace/provider/identity transition characterization | Node.js, installed Chromium | Tier 2 domain | No | None |
| `npm run test:all`                        | All audit tests including stress phases                          | Node.js, `TP3D_STRESS=1` env                | full               | No                                | None                              |
| `npm run test:stress`                     | AutoPack perf stress phases only (PHASE-E1, E2A, E2B, A1-PERF-1) | Node.js                                     | focused            | No                                | None                              |
| `npm run lint`                            | JS + CSS + HTML lint all pass                                    | Node.js, eslint, stylelint, html-validate   | quick              | No                                | None                              |
| `npm run lint:js`                         | ESLint on `src/**/*.js` and `index.html`                         | Node.js, eslint                             | quick              | No                                | None                              |
| `npm run lint:css`                        | Stylelint on `styles/**/*.css`                                   | Node.js, stylelint                          | quick              | No                                | None                              |
| `npm run lint:html`                       | html-validate on `index.html`                                    | Node.js, html-validate                      | quick              | No                                | None                              |
| `npm run typecheck`                       | TypeScript type-check (allowJs)                                  | Node.js, tsc                                | quick              | No                                | None                              |
| `npm run format:check`                    | Prettier formatting check                                        | Node.js, prettier                           | quick              | No                                | None                              |
| `npm run validate`                        | lint + format:check combined                                     | Node.js                                     | quick              | No                                | None                              |
| `npm run stress:ui`                       | UI stress test (`tests/stress.spec.js`)                          | Node.js                                     | focused            | No                                | None                              |
| `npm run local:billing:verify`            | Verify local Supabase environment setup                          | Local Supabase running                      | focused            | No                                | None                              |
| `npm run test:billing:local`              | Local billing, ownership, security DB tests                      | Local Supabase running                      | destructive local  | Yes (local fixtures)              | Run cleanup script                |
| `npm run billing:fixtures:plan`           | Plan local billing fixtures                                      | Local Supabase running                      | focused            | No                                | None                              |
| `npm run billing:fixtures:verify-safety`  | Verify billing fixture safety checks                             | Node.js                                     | quick              | No                                | None                              |
| `npm run billing:fixtures:dev:plan`       | Plan development fixtures                                        | Dev Supabase credentials                    | remote development | No                                | None                              |
| `npm run billing:fixtures:dev:seed`       | Seed development fixtures                                        | Dev Supabase credentials, operator approval | remote development | Yes (dev fixtures)                | `billing:fixtures:dev:cleanup`    |
| `npm run billing:fixtures:dev:verify`     | Verify development fixtures                                      | Dev Supabase credentials                    | remote development | No                                | None                              |
| `npm run billing:fixtures:dev:cleanup`    | Clean up development fixtures                                    | Dev Supabase credentials                    | remote development | Yes (removes fixtures)            | None                              |
| `npm run test:billing:dev`                | Deployed Edge Function billing integration tests                 | Dev Supabase + Edge Functions running       | remote development | Yes (dev fixtures)                | `billing:fixtures:dev:cleanup`    |
| `npm run billing:fixtures:stripe:plan`    | Plan Stripe test-mode fixtures                                   | Stripe test keys                            | operator-only      | No                                | None                              |
| `npm run billing:fixtures:stripe:seed`    | Seed Stripe test-mode fixtures                                   | Stripe test keys, operator approval         | operator-only      | Yes (Stripe test objects)         | `billing:fixtures:stripe:cleanup` |
| `npm run billing:fixtures:stripe:cleanup` | Clean up Stripe test-mode fixtures                               | Stripe test keys                            | operator-only      | Yes (removes Stripe test objects) | None                              |
| `npm run test:billing:stripe`             | Stripe billing integration tests                                 | Stripe test keys, dev Supabase              | operator-only      | Yes (Stripe test objects)         | `billing:fixtures:stripe:cleanup` |
| `git diff --check`                        | No trailing whitespace in staged/unstaged changes                | git                                         | quick              | No                                | None                              |

**Category key:**

- **quick** — Safe to run anytime, no external dependencies.
- **focused** — Scoped subset of a larger suite.
- **full local** — Complete local suite; run deliberately, not after each edit.
- **required CI lane** — Part of the single PR Quality Gate job.
- **Tier 2 domain** — Required for affected contracts; separate from the global PR gate.
- **full** — Complete suite including slow phases.
- **destructive local** — Modifies local database; requires local Supabase; isolated.
- **remote development** — Requires hosted development Supabase credentials; modifies dev data.
- **operator-only** — Requires human-supplied production-adjacent credentials (Stripe test keys).

### Validation tiers

Choose the smallest tier that covers the changed contract. Do **not** run `npm test`,
`npm run test:ci`, `npm run test:all`, or `npm run quality:ci` after every local edit or commit.

| Tier | When | Validation |
|---|---|---|
| 0 — Static micro | Docs, comments, trivial cleanup | Inspect the diff; run `git diff --check`. No test suite. |
| 1 — Focused | Isolated helper, Settings UI, test cleanup | Run directly affected specs and relevant lint/typecheck. |
| 2 — Domain | AutoPack, auth/storage, Three/rendering, import/recovery contracts | Run all tests owned by the affected contract. |
| 3 — Final required Quality Gate | Complete PR candidate after the final material change | Let the single fast PR gate run: lint, typecheck, the full Node lane, the Chromium smoke set, build, production audit, and patch check. |
| 4 — Full regression | Before a major release, or after a substantial high-risk change (editor, persistence, import/export, billing, auth, rendering) | Run `npm run test:regression` locally. GitHub does not run it and no schedule exists. |

At Tier 2, auth, workspace, provider/session, and identity-transition changes also require the
separate `tests/behavioral/app-js-characterization.spec.mjs` suite. It is not in the global PR gate.
AutoPack solver changes need solver, lifecycle, and relevant handling/Max Capacity tests.
Three/rendering changes need the runtime guard and affected Editor/browser specs. CSS-only changes
need stylelint and an affected visual/browser contract only if layout behavior changes. Docs-only
changes need a diff check, with no test suite.

### P2.5 suite footprint (2026-10-03)

| Measure | Pre-P2.5 main `fe4bfe3` | P2.5 candidate |
|---|---:|---:|
| Audit specs | 38 | 49 |
| Audit spec lines | 61,054 | 57,878 |
| Audit spec bytes | 3,335,630 | 3,172,067 |
| Static `test()` / `t.test()` declaration sites | 1,992 | 1,981 |
| Largest audit spec | 26,112 lines / 1,498,847 bytes | 4,302 lines / 247,227 bytes |
| Direct `.indexOf()` source-declaration anchors | 583* | 555 |
| Explicit literal waits | 11 | 6 |
| Chromium audit specs | 7 | 7 |
| Non-browser audit specs proven serial-required | 0 | 0 |

The new shared test fixture, `tests/fixtures/security-invariants-support.mjs`, is 3,151 lines /
124,566 bytes outside `tests/audit`. Including it, the candidate has 61,029 lines / 3,296,633
bytes of audit spec and shared-fixture source. The line and byte reductions in the audit-spec row
are therefore primarily a reduction in individual spec/context size. *The original P2.5 audit
reported 582 private declaration anchors; the reproducible direct `.indexOf()` literal heuristic
over the baseline tree counts 583, a one-site measurement difference.

---

## 12. Test and Fixture Data

### Audit tests (`tests/audit/*.spec.mjs`)

The non-browser specs import source modules and exercise logic in Node.js. Seven specs launch
Chromium and cover browser behavior. The required PR Quality Gate runs the Node lane in full and only
a smoke selection of the Chromium specs (see `test:ci:browser`); `npm run test:regression` runs all of them. They cover:

- AutoPack results carousel and strategy differentiation
- Billing catalog and fixture safety
- Business identity phase 1 invariants
- Import/export compatibility
- Cargo instructions (inspector case notes)
- Load Plan terminology invariants
- Manual vertical placement rules
- Max capacity (duplicate, durability, phase C reporting, truck change)
- Quantity controls phase 1
- Security and invariants (including AutoPack stress phases when `TP3D_STRESS=1`)
- Space utilization gauge, merged through PR #21

### Local Supabase fixtures

Located in `scripts/local-fixtures/`. The entry point is:

```bash
npm run local:billing:verify   # environment.mjs — checks local Supabase is correctly configured
```

Additional: `harness.mjs` (test harness), `cleanup.mjs` (cleanup helpers).

### Billing fixtures

Located in `scripts/billing-fixtures/`. Separate scripts for local, dev, and Stripe:

- `cli.mjs` — local billing fixture CLI
- `dev-cli.mjs` — development Supabase fixture CLI
- `stripe-cli.mjs` — Stripe test-mode fixture CLI

**Safety guarantee:** The fixture layer is environment-bound, no-write, masked, and
production-refusing. `billing:fixtures:verify-safety` validates this. Never run fixture seed scripts
without verifying the target environment first.

### Demo/seed data

The app no longer has a demo reset button. The legacy `#btn-reset-demo` ("Reset demo data") was retired
with the legacy Settings screen because it cleared every workspace key under the user's storage
scope, and cases and load plans are browser-local only. Create QA data with the Test Pack/Case
procedures below or an App Backup import; never wipe local storage to get a clean fixture.

### Test Pack/Case creation

No programmatic browser-side factory exists for seeding Cases or Load Plans from test code. Create
test data manually via the Cases and Load Plans screens, or import an App Backup.

### No deterministic seed

There is no seed file or factory that generates reproducible Case/Load Plan fixtures across
sessions. When reproducing a bug, document exact Case dimensions, settings, and app version/commit
(see Section 20 evidence template).

---

## 13. Local Storage and Workspace Scoping

### Storage key structure (verified in `src/core/storage.js`)

```
Base key:    truckPacker3d:v1
User-scoped: truckPacker3d:v1:<user_storage_scope>
Workspace-scoped: truckPacker3d:v1:<user_storage_scope>|<workspace_id>
```

- `STORAGE_KEY` = `'truckPacker3d:v1'` (legacy/anon key)
- `getStorageScope()` → current user storage scope string
- `getWorkspaceScope()` → current workspace (org) scope string
- The workspace-scoped key format is `${STORAGE_KEY}:${STORAGE_SCOPE}|<orgId>`

### What is stored in localStorage

- **User-scoped:** User preferences (units, theme, label size, snapping, grid size, export settings)
- **Workspace-scoped:** All Cases (`CaseLibrary`), all Load Plans (`PackLibrary`), active Load Plan
  ID, folder structure
- **Debug flag:** `tp3dDebug` = `'1'` enables runtime debugger
- **Session:** Supabase auth session (managed by Supabase JS client)

### Cross-tab behavior

- Cross-tab org/workspace sync is guarded by user identity and freshness checks.
- Workspace switches are propagated via `localStorage` events.
- Stale cross-tab billing state is guarded — see `AGENTS.md` Section 10.

### Browser-specific behavior

- Cases and Load Plans currently live in `localStorage` (not Supabase database rows). Clearing
  browser storage permanently deletes all workspace cargo data.
- Incognito sessions have isolated storage — test data will not carry over.
- Different browsers have separate storage — a Chrome QA session is isolated from Firefox.

### Risks when clearing storage

Clearing `localStorage` while a workspace is active destroys all local Cases and Load Plans for that
user/workspace. Always export or backup before clearing.

### Isolating QA data

Use a dedicated browser profile or incognito session for QA. Log in as a separate QA user account
from any production users.

### Export/backup paths

- Load Plan export: JSON via `src/services/import-export.js`
- Workspace backup: full localStorage export via Settings → Export Workspace
- `btn-save-prefs` saves preferences without a full export

---

## 14. Supabase Navigation

### Local configuration

- Project ID: `Truck_Packer_3D` (from `supabase/config.toml`)
- Local API port: 54321
- Local Studio port: 54323
- Local inbucket (email): 54324
- Shadow DB port: 54320
- Local DB port: 54322/54329

### Migrations (30 migrations)

| Migration                                                 | Purpose                      |
| --------------------------------------------------------- | ---------------------------- |
| `2026021501_create_profiles.sql`                          | User profiles                |
| `2026021600_account_deletion.sql`                         | Account deletion flow        |
| `2026021601_create_org_schema.sql`                        | Organizations schema         |
| `2026021700_create_billing_schema.sql`                    | Billing tables               |
| `2026021701_org_member_rls_hardening.sql`                 | Member RLS                   |
| `2026021702_stripe_webhook_reliability.sql`               | Stripe webhook               |
| `2026021703_organization_invites.sql`                     | Org invites                  |
| `2026021901_org_trial_seed.sql`                           | Trial seeding                |
| `2026021912_fix_webhook_and_billing_projection.sql`       | Billing projection fix       |
| `2026041801_auto_org_on_signup.sql`                       | Auto-org on signup           |
| `2026041802_billing_rls.sql`                              | Billing RLS                  |
| `2026041803_storage_buckets_and_rls.sql`                  | Storage buckets              |
| `2026042201_organizations_rls.sql`                        | Org RLS                      |
| `2026042301_org_members_select_self.sql`                  | Member self-select           |
| `2026042901_stop_repeat_workspace_trials.sql`             | Trial dedup                  |
| `2026050501_organization_invites_expiration.sql`          | Invite expiry                |
| `2026050601_fix_signup_auto_org_uuid.sql`                 | Signup UUID fix              |
| `2026050701_organization_archive.sql`                     | Workspace archive            |
| `2026050702_org_member_admin_delete_guard.sql`            | Admin delete guard           |
| `2026050801_transfer_ownership_fn.sql`                    | Ownership transfer           |
| `2026050802_transfer_ownership_live_schema_fix.sql`       | Transfer fix                 |
| `2026050803_restore_workspace.sql`                        | Workspace restore            |
| `2026050804_account_purge_status.sql`                     | Account purge                |
| `2026061301_guard_profile_deletion_fields.sql`            | Profile deletion guard       |
| `2026071401_explicit_api_role_privileges.sql`             | API role grants              |
| `20260716061516_server_controlled_workspace_creation.sql` | Server-side creation limit   |
| `20260716061518_restrict_direct_membership_mutations.sql` | Membership write restriction |
| `20260717135117_restrict_direct_organization_inserts.sql` | Org insert restriction       |
| `20260717142844_enforce_server_workspace_limits.sql`      | Workspace limit enforcement  |
| `20260717150000_enforce_workspace_slug_integrity.sql`     | Slug integrity               |

### Edge Functions (each in `supabase/functions/<name>/`)

| Function                                                                  | Purpose                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `billing-status`                                                          | Entitlement truth — normalizes billing state for frontend   |
| `stripe-create-checkout-session`                                          | Stripe checkout initiation (owner only)                     |
| `stripe-create-portal-session`                                            | Stripe billing portal (owner only)                          |
| `stripe-webhook`                                                          | Stripe event ingestion                                      |
| `org-create-workspace`                                                    | Server-controlled workspace creation with limit enforcement |
| `org-archive-workspace`                                                   | Archive a workspace                                         |
| `org-restore-workspace`                                                   | Restore an archived workspace                               |
| `org-invite`                                                              | Send org invitation                                         |
| `org-invite-accept`                                                       | Accept an invitation                                        |
| `org-invite-revoke`                                                       | Revoke an invitation                                        |
| `org-leave-workspace`                                                     | Member leaves workspace                                     |
| `org-member-remove`                                                       | Remove a member (admin/owner)                               |
| `org-member-role-update`                                                  | Update member role                                          |
| `org-transfer-ownership`                                                  | Transfer workspace ownership                                |
| `ban-user` / `unban-user`                                                 | User ban management                                         |
| `delete-account` / `cancel-account-deletion` / `request-account-deletion` | Account deletion flow                                       |
| `purge-deleted-accounts` / `purge-deleted-users`                          | Account purge                                               |

Shared helpers: `supabase/functions/_shared/`

### Local reset command

```bash
supabase db reset   # Drops and re-applies all migrations from scratch
```

### What Supabase currently owns

- Authentication and profiles
- Organizations and memberships (with server-enforced limits)
- Billing records (`billing_customers`, billing state)
- Invitations
- Storage buckets (for any file assets)
- Workspace creation/archive/restore/transfer lifecycle

**What Supabase does NOT currently own:** Cases and Load Plans are stored in browser `localStorage`,
not in Supabase tables. Cargo persistence is a localStorage-first model as of the last verified
state.

---

## 15. Stripe and Billing QA

**Absolute rule:** Only Stripe test-mode keys are permitted for QA. Never use live Stripe keys in
fixture scripts.

### Safe test path

1. Verify environment safety first:
   ```bash
   npm run billing:fixtures:verify-safety
   npm run billing:fixtures:stripe:safety
   ```
2. Plan the fixture set:
   ```bash
   npm run billing:fixtures:stripe:plan
   ```
3. Seed (operator must provide Stripe test keys):
   ```bash
   npm run billing:fixtures:stripe:seed
   ```
4. Run Stripe billing tests:
   ```bash
   npm run test:billing:stripe
   ```
5. Clean up (must always run):
   ```bash
   npm run billing:fixtures:stripe:cleanup
   ```

### Relevant Edge Functions for billing QA

- `billing-status` — normalized entitlement truth; inspect this first when billing display is wrong
- `stripe-create-checkout-session` — owner-only, test-mode
- `stripe-create-portal-session` — owner-only, test-mode
- `stripe-webhook` — event ingestion; test with Stripe CLI webhook forwarding

### Billing entitlement states

Valid normalized `entitlementStatus` values (from `BILLING_ENTITLEMENT_RULES.md`): `active`,
`trialing`, `trial_expired`, `included_in_plan`, `workspace_limit_reached`,
`owner_subscription_required`, `billing_unavailable`

### Owner-only rules

- Checkout, portal, plan changes, and payment management are owner-only actions.
- Members are never billed separately.
- The owner's own additional workspaces within plan limits inherit coverage.

### Prohibited in Stripe QA

- Live-mode Stripe key usage
- Modifying real customer payment records
- Sharing or reusing another workspace's billing identity in test fixtures
- Exposing secrets in logs, docs, or evidence files

---

## 16. Three.js and Editor QA Map

### Scene ownership

| Concern                               | Location                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Scene initialization, render loop     | `src/editor/scene-runtime.js`                                               |
| Camera                                | `src/editor/scene-runtime.js` (OrbitControls from `three/addons`)           |
| Controls (orbit/pan/zoom)             | `src/bootstrap/three-runtime.js` (installs OrbitControls) + `src/editor/scene-runtime.js` |
| Trailer geometry, dimensions          | `src/editor/trailer-geometry.js`                                            |
| Geometry factory for Case meshes      | `src/editor/geometry-factory.js`                                            |
| Space model                           | `src/packing-core/space-model.js`                                           |
| Wheel well model                      | `src/packing-core/wheel-well-model.js`                                      |
| Validation (placement)                | `src/packing-core/validation.js`                                            |
| Repair (layout repair)                | `src/packing-core/repair.js`                                                |
| Retention model (front overhang)      | `src/packing-core/retention-model.js`                                       |
| Case mesh creation, labels, selection | `src/screens/editor-screen.js` + scene runtime                              |
| Drag/move, rotation, nudge            | `src/screens/editor-screen.js` (InteractionManager)                         |
| Collision, support checks             | `src/packing-core/validation.js`                                            |
| Snapping                              | Preferences + `src/screens/editor-screen.js`                                |
| AutoPack application to editor        | `src/services/autopack-engine.js` → `src/screens/editor-screen.js`          |
| Screenshot/export rendering           | `src/app.js` (screenshot helper) + `src/screens/editor-screen.js`           |
| Performance panel                     | `src/debugger.js` (when `tp3dDebug=1`)                                      |

### Editor QA checklist

1. Open a Load Plan from the Load Plans screen.
2. Verify the Case Browser (left panel, `#editor-left`) loads and shows available cases.
3. Add a case instance (click or drag from Case Browser).
4. Select the placed instance (verify Inspector, `#editor-right`, shows instance details).
5. Move the instance (drag in viewport).
6. Rotate the instance (rotation controls in Inspector or viewport).
7. Unpack all instances (`#btn-unpack`).
8. Run AutoPack (`#btn-autopack`) — verify a spinner/working state appears.
9. Verify AutoPack result is applied to the scene.
10. Switch truck preset (Truck edit form in right panel) — verify pending vs committed state.
11. Click "Update truck" — verify preview modal appears.
12. Cancel truck change — verify committed scene is restored.
13. Test Inspector behavior (Standard Instructions, Item Notes, Pack Notes).
14. Export screenshot (`#btn-screenshot`).
15. Export PDF (`#btn-pdf`).
16. Verify no unexpected console errors or network failures throughout.

---

## 17. AutoPack QA Map

### Flow

```
User clicks #btn-autopack
  → operation-lifecycle.js: acquire lock (prevents concurrent mutations)
  → editor-screen.js: collect placed instances, read truck config
  → autopack-engine.js: orchestrate (stage input, call solver, validate, animate/snap result)
      → autopack-solver.js: strategy selection, placement generation, scoring
          → packing-core/: geometry, validation, space model, budget, domain rules
  → Result returned to engine
  → engine: validate result, apply to PackLibrary (persistence)
  → editor-screen.js: apply visual result to scene
  → operation-lifecycle.js: release lock
```

### Key files

| File                                           | Role                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `src/core/operation-lifecycle.js`              | Lifecycle lock — prevents overlapping mutations                           |
| `src/services/autopack-engine.js`              | AutoPack orchestration, staging, persistence, animation/snap              |
| `src/services/autopack-solver.js`              | Solver: strategy, placement generation, scoring                           |
| `src/packing-core/`                            | Geometry, validation, space model, budget, domain, retention, wheel-wells |
| `src/services/autopack-item-builder.js`        | Input item construction for solver                                        |
| `docs/engineering/autopack-engine-contract.md` | Permanent behavioral contract                                             |

### Test spaces

| Space type     | Notes                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| Standard       | Default trailer with no special features                                                   |
| Wheel Wells    | Floor geometry has wheel well shelves; wider cases require bridge/support approval         |
| Front Overhang | C2 (front deck) requires rear retention before loading; wall-building requires V6 approval |

### Deterministic reproduction

Record all of the following when capturing an AutoPack result:

- Strategy used
- Input Case count and dimensions
- Trailer preset and configuration
- All relevant solver settings
- App version and git commit SHA
- Do not modify fixture data between reproduction runs

### Large-load snap threshold

AutoPack snaps directly to final layout for performance when `> 300` packed placements. This is a
performance safety measure, not a solver quality improvement. At 800–1200+ cases, the solver may
block the main thread.

---

## 18. Stress and Performance Testing

### Current tools (verified)

| Tool                         | Command / Location                               | What it measures                                               |
| ---------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| AutoPack stress phases       | `npm run test:stress`                            | AutoPack duration at defined case counts (Node.js, no browser) |
| UI stress test               | `npm run stress:ui` → `tests/stress.spec.js`     | Browser UI stress (requires browser)                           |
| Runtime debugger             | `localStorage.tp3dDebug = '1'` or `?tp3dDebug=1` | AutoPack timing, render stats, auth events, storage events     |
| Browser DevTools Performance | Manual — browser Performance tab                 | FPS, main thread blocking, GC, paint                           |
| Browser DevTools Memory      | Manual — browser Memory tab                      | Heap size, retained objects                                    |
| Three.js renderer info       | `renderer.info` (available via debugger panel)   | Draw calls, triangles, geometries, textures                    |

### Debug flag activation

```javascript
// In browser console:
localStorage.setItem('tp3dDebug', '1');
location.reload();

// Or via URL: http://localhost:5500/index.html?tp3dDebug=1
```

### Suggested test sizes

These reflect existing project direction and current stress test structure.

| Size    | Case/instance count | What to check                                                  |
| ------- | ------------------- | -------------------------------------------------------------- |
| Small   | 1–50                | Functional correctness, no console errors                      |
| Medium  | 50–300              | AutoPack speed, UI responsiveness, no layout errors            |
| Large   | 300–800             | Large-load snap activates (>300), AutoPack duration, UI freeze |
| Extreme | 800–1200+           | Main thread blocking risk; document observed duration          |

**Threshold guidance:**

- Large-load snap threshold: `> 300` placed instances — **currently approved**
- AutoPack duration at 300 cases: current observed baseline (record per test run)
- No formal acceptance thresholds exist for FPS or draw calls — document as baselines

Do not convert observed baselines into acceptance criteria without V6 approval.

---

## 19. Debugging and Diagnostics

### Console log prefixes (verified in source)

| Prefix              | Module                               |
| ------------------- | ------------------------------------ |
| `[TP3D]`            | Boot / vendor loading (`index.html`) |
| `[TruckPackerApp]`  | `src/app.js` top level               |
| `[workspaceReady]`  | `src/app.js` workspace resolution    |
| `[autopack]`        | `src/services/autopack-engine.js`    |
| `[AutoPackSolver]`  | `src/services/autopack-solver.js`    |
| `[supabase-client]` | `src/core/supabase-client.js`        |
| `[BillingService]`  | `src/services/billing-service.js`    |
| `[Storage]`         | `src/core/storage.js`                |
| `[DIAG]`            | `src/debugger.js` (debug mode only)  |

### Debug localStorage flags

| Key             | Value    | Effect                                                     |
| --------------- | -------- | ---------------------------------------------------------- |
| `tp3dDebug`     | `'1'`    | Enables full runtime debugger output and performance panel |
| `__TP3D_DIAG__` | Internal | Preserved by debugger; do not manually set                 |

### Common diagnosis paths

| Symptom                               | First files / logs to inspect                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| App does not boot                     | Browser console → `[TP3D]` vendor lines → `window.__TP3D_BOOT.cdnFailures`                                      |
| Vendor/CDN failure                    | `index.html` CDN script blocks → System overlay (`#system-overlay`) → check vendor fallback paths in `vendor/`  |
| Blank screen after auth               | `src/app.js` → workspace resolution → check `window.__TP3D_BOOT.appReady`                                       |
| Authentication loop                   | `src/core/supabase-client.js` → `src/ui/overlays/auth-overlay.js` → check `onAuthStateChange` events in console |
| Wrong workspace shown                 | `src/app.js` `getOrgContext()` / `setActiveOrgId()` → check `localStorage` workspace keys                       |
| Missing local data (Cases/Load Plans) | `src/core/storage.js` → check `truckPacker3d:v1` keys in Application → LocalStorage                             |
| Billing state stale                   | `supabase/functions/billing-status/` → `src/services/billing-service.js` → check refresh call in console        |
| Edge Function failure                 | Supabase dashboard logs → check function name in `supabase/functions/<name>/`                                   |
| AutoPack failure                      | `src/services/autopack-engine.js` → `src/services/autopack-solver.js` → console `[autopack]` prefix             |
| WebGL context problem                 | Browser DevTools → check GPU errors → `src/editor/scene-runtime.js`                                             |
| PDF/export failure                    | `src/app.js` screenshot helper → jsPDF vendor → check console errors during export                              |

---

## 20. Evidence Collection Standard

Every QA report must record all of the following.

```
## QA Evidence Record

- Branch: <git branch name>
- Commit SHA: <git log --oneline -1>
- Dirty/clean status: <git status -sb output>
- Environment: <local browser / local Supabase / hosted dev / Stripe test>
- Browser and version: <e.g. Chrome 128.0.6613.113>
- Operating system: <e.g. macOS 15.2 arm64>
- Viewport: <e.g. 1440x900>
- User role: <owner / admin / member>
- Workspace: <workspace name / ID>
- Test data: <Case names, dimensions, counts, Load Plan ID>
- Exact steps:
  1. ...
  2. ...
- Expected result: ...
- Actual result: ...
- Screenshots: <list file paths or inline>
- Console errors: <paste or attach>
- Network failures: <HTTP status, URL, request body>
- Relevant request/event IDs: <Supabase request ID, Stripe event ID>
- Automated commands run: <paste exact commands>
- Cleanup performed: <what was removed/reset>
```

---

## 21. Manual QA Routes

All paths verified against current app navigation structure.

### Sign in

1. Open `http://localhost:5500/index.html`.
2. Auth dialog appears ("Truck Packer 3D" heading, "Please sign in to continue").
3. Fill email (`input[type="email"]`), fill password (`input[type="password"]`).
4. Click "Sign in" button.
5. Wait for sidebar to show workspace name in account switcher.

### Switch workspace

1. Click `#btn-account-switcher` (workspace name in sidebar).
2. Account overlay opens.
3. Select the target workspace from the workspace list.
4. Confirm topbar and sidebar update to the new workspace.

### Create Case

1. Navigate to Cases screen (sidebar "Cases").
2. Click `#btn-new-case`.
3. Fill Case name, dimensions, and optional fields in the Case modal.
4. Click Save.
5. Confirm new Case appears in `#cases-grid` or `#cases-tbody`.

### Edit Case

1. In Cases screen, click a Case card or row to select.
2. Click the Edit (pencil) action.
3. Modify fields in Case modal.
4. Click Save.

### Search / sort Cases

1. In Cases screen, type in `#cases-search`.
2. Use `#cases-sort` button to change sort order.
3. Use `#cases-filters-toggle` to filter by category or other filters.

### Import Cases

1. In Cases screen, click `#btn-cases-import`.
2. Select a CSV or XLSX file.
3. Confirm import result.

### Create Load Plan

1. Navigate to Load Plans screen (sidebar "Load Plans").
2. Click `#btn-new-pack`.
3. Fill name, select truck preset.
4. Click Create.
5. Confirm new Load Plan appears in `#packs-grid` or `#packs-list`.

### Search / sort Load Plans

1. In Load Plans screen, type in `#packs-search`.
2. Use `#packs-sort`, `#packs-filters-toggle`, `#packs-trailer-presets` as needed.

### Open Editor

1. In Load Plans screen, click on a Load Plan card or row.
2. Editor screen (`#screen-editor`) activates with the Load Plan loaded.
3. Confirm truck is rendered in `#viewport`.

### Add Case instances

1. In Editor, open Case Browser (left panel, `#editor-left`).
2. Search for a Case using `#editor-case-search`.
3. Click a Case in `#editor-case-list` to add an instance.

### AutoPack

1. In Editor with at least one Case instance, click `#btn-autopack`.
2. Wait for operation to complete (spinner/working state during lock).
3. Confirm instances are repositioned in the viewport.

### Apply solution

AutoPack results are applied automatically after the solver completes. No separate "Apply" action is
currently required.

### Add Cargo Notes (three-tier model)

- **Standard Instructions** (per Case): Edit via Cases screen → Case editor. Displayed as read-only
  in Inspector top card.
- **Item Notes** (per instance): Select instance in Editor → Inspector → "Item Notes" action. Opens
  notes overlay, saves to `instanceNotes`.
- **Pack Notes** (per Load Plan): In Editor → `#btn-pack-notes` in viewport toolbar. Opens notes
  overlay, saves to `pack.notes`.

### Export

- Screenshot: `#btn-screenshot` in Editor viewport toolbar.
- PDF: `#btn-pdf` in Editor viewport toolbar.
- Load Plan export: Load Plans screen → kebab/action menu on a Load Plan card.
- Workspace export/backup: Settings overlay → Resources → Export App Backup.

### Account and workspace settings

1. Click `#btn-account-switcher` → Account overlay.
2. Or open `#/settings`, which opens the Settings overlay on Preferences.
3. Settings overlay (full) opens for billing, members, invites when accessed via account overlay.

### Workspace members

1. Click `#btn-account-switcher` → Account overlay → Members tab.

### Billing portal

1. Click `#btn-account-switcher` → Account overlay → Billing tab → Manage Billing (owner only).

### Archive / restore workspace

Available via Settings overlay workspace management (owner only).

---

## 22. Known QA Blockers and Limitations

| Limitation                                              | Detail                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| No automated test accounts                              | Browser QA past auth always requires operator-supplied credentials                         |
| No Playwright test suite                                | Playwright devDependency exists but no specs or config are present                         |
| Local Supabase ↔ browser disconnect                     | Browser app may point to hosted Supabase even when local Supabase is running               |
| Cargo data is localStorage-only                         | Cases and Load Plans do not exist in Supabase — server-side persistence is not implemented |
| Stripe test-mode requires operator keys                 | `npm run test:billing:stripe` cannot run without human-supplied Stripe test keys           |
| Development Supabase credentials required for dev tests | `npm run test:billing:dev` requires operator-supplied dev project credentials              |
| No `data-testid` attributes                             | All browser selectors rely on DOM IDs or fragile CSS classes                               |
| Main-thread blocking at 800–1200+ cases                 | AutoPack solver is synchronous; no Web Worker; large loads can freeze the UI               |
| No separate Playwright Test project                    | Browser audit specs run through Node's test runner in CI; no `playwright.config.*` exists  |
| Workspace Slug Phase 2 (friendly slugs)                 | Deferred; UUID-derived slug is the current only slug                                       |
| Cargo persistence — server-side                         | Not yet implemented; future work requires V6 approval                                      |

---

## 23. Agent Safety Rules

1. **Read V6 and agent instructions first.** Do not begin work without confirming active task,
   branch, and blockers from `docs/product/TP3D-MASTER-TODO-V6.md`.
2. **Use Graphify first for codebase questions** when `graphify-out/graph.json` exists and the
   repository instructions require it.
3. **Verify runtime paths against current source.** Do not trust memory of past sessions.
4. **Never use production data as a disposable fixture.** All fixture operations must target local
   or development environments only.
5. **Never expose secrets.** No credentials, keys, passwords, or magic links in any document, log,
   or evidence file.
6. **Never assume archived TODOs describe current behavior.** Archived docs are historical only.
7. **Never change production code during a read-only QA task.** Source files, tests, and package
   scripts are read-only during documentation and QA tasks.
8. **Never repair unrelated issues during focused QA.** Scope stays within the approved task
   boundary.
9. **Never open multiple browser windows unless the test explicitly requires it.**
10. **Never leave fixture records behind.** Run the corresponding cleanup script after every seeding
    operation.
11. **Never report a browser test as passed if authentication or the target screen was not
    reached.** The sign-in step and workspace confirmation are mandatory.
12. **Never treat source inspection as browser proof.** Reading code is not the same as observing
    behavior in a running browser.
13. **Never claim Playwright coverage when only manual browser QA was performed.** These are
    separate evidence categories.
14. **Never use raw UUIDs as customer-facing identifiers** in QA reports or evidence. Use workspace
    names and Load Plan numbers.
15. **Stop when a safety prerequisite cannot be verified.** If the environment, credentials, or
    fixture state cannot be confirmed, halt and report to the operator.
16. **Use the original Truck Packer 3D repository folder.** Do not create worktrees, duplicate
    repositories, or duplicate project folders unless the operator explicitly requests them.
17. **Confirm branch and status before any operation.** Run `git branch --show-current` and
    `git status -sb` before starting any task.
18. **When unexpected changes exist, stop and report them.** Do not hide, relocate, or discard
    uncommitted work found in the working tree.
19. **Do not run `git clean`, `git reset`, `git restore`, `git stash`, or switch branches with a
    dirty working tree without explicit operator approval.**
20. **Do not mix another branch's documentation or feature work into the current working tree.**
    Each branch must contain only its own approved changes.
21. **Do not publish, deploy, create a hosted demo, or use GitHub Sites** when the task is local
    browser QA or repository implementation unless publishing was explicitly requested by the
    operator.
22. **Actual product UI validation must use the real Truck Packer 3D application** at the approved
    localhost URL, not a separately generated or scaffolded application.

---

## 24. Fast Lookup Index

| Need                 | Start here                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| App boot sequence    | [Section 4](#4-runtime-entry-and-boot-sequence) · `index.html` lines 25–145 · `src/app.js`                             |
| Screen routing       | `src/router.js` · sidebar nav buttons in `index.html`                                                                  |
| Cases                | `#screen-cases` · `src/screens/cases-screen.js` · `src/services/case-library.js`                                       |
| Load Plans           | `#screen-packs` · `src/screens/packs-screen.js` · `src/services/pack-library.js`                                       |
| Editor               | `#screen-editor` · `src/screens/editor-screen.js`                                                                      |
| 3D scene / viewport  | `#viewport` · `src/editor/scene-runtime.js` · `src/editor/geometry-factory.js`                                         |
| AutoPack             | `#btn-autopack` · `src/services/autopack-engine.js` · `src/services/autopack-solver.js` · `src/packing-core/`          |
| Auth overlay         | `src/ui/overlays/auth-overlay.js` · `src/core/supabase-client.js`                                                      |
| Workspace / org      | `src/app.js` (workspace resolution) · `src/services/organization-service.js`                                           |
| Billing entitlement  | `supabase/functions/billing-status/` · `src/services/billing-service.js` · `docs/product/BILLING_ENTITLEMENT_RULES.md` |
| Import / export      | `src/services/import-export.js` · `src/ui/overlays/import-cases-dialog.js` · `src/ui/overlays/import-pack-dialog.js`   |
| Tests                | `npm test` (audit) · `npm run lint` · `npm run typecheck` · `tests/audit/`                                             |
| Supabase             | `supabase/migrations/` · `supabase/functions/` · `src/core/supabase-client.js`                                         |
| Stripe fixtures      | `scripts/billing-fixtures/stripe-cli.mjs` · [Section 15](#15-stripe-and-billing-qa)                                    |
| Browser QA           | [Section 9](#9-browser-qa-fast-path) · [Section 20](#20-evidence-collection-standard)                                  |
| Performance / stress | `npm run test:stress` · `npm run stress:ui` · `localStorage.tp3dDebug='1'`                                             |
| Active task status   | `docs/product/TP3D-MASTER-TODO-V6.md` Section 4                                                                        |
| DOM IDs              | `index.html` (authoritative) · [Section 5](#5-main-product-surfaces)                                                   |
| Debug flags          | `localStorage.tp3dDebug = '1'` · `src/debugger.js`                                                                     |

---

## 25. Maintenance Rules

Update this document when:

- The application startup command or URL changes.
- Authentication flow changes (method, provider, overlay structure).
- New stable DOM IDs or screen sections are added or renamed.
- Test commands are added, removed, or renamed in `package.json`.
- Environment boundaries change (new local/dev/production targets).
- Fixture procedures change (new scripts, new cleanup steps).
- Supabase is adopted as the cargo persistence layer (currently localStorage).
- Playwright is configured as a supported test path.

Do **not** update this document for every feature addition. Update when navigation entry points,
commands, or environment rules change.

**Do not update sections without re-verifying the corresponding commands, paths, or selectors
against current source.** Mark stale sections explicitly with `⚠️ STALE — verify before use`.

V6 (`docs/product/TP3D-MASTER-TODO-V6.md`) remains the operational authority. This document
describes how to move through the repository, not what to build.

---

### Required document qualities checklist (self-audit)

- [x] Quick-start and safety sections are concise enough to read before a QA task
- [x] Detailed enough to prevent repository searching
- [x] Uses tables and short checklists
- [x] No implementation history
- [x] No product brainstorming
- [x] No future-roadmap content
- [x] No secrets or private credentials
- [x] No guessed commands (all from verified `package.json` or verified source)
- [x] No unsupported selectors (all DOM IDs verified in live browser)
- [x] No stale archived conclusions presented as current behavior
