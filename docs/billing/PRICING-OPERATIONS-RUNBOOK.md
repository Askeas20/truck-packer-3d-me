# Cargo Planner 3D — Pricing Operations Runbook

## 1. Document Status

This is operational documentation for the current implementation. It is not a pricing decision, approval to modify Stripe, or a replacement for [Billing Entitlement Rules](../product/BILLING_ENTITLEMENT_RULES.md). Commercial pricing is not final.

The procedures below describe how the repository behaves at the time of writing. The server catalog separates active checkout Prices, recognition-only legacy Prices, and unknown Prices while preserving current commercial terms and valid paid entitlement results.

## 2. Current Pricing Architecture

Pricing authority is split across three layers.

### Stripe

Stripe is authoritative for:

- Product and Price objects;
- amount and currency;
- recurring interval;
- whether a Product or Price is active for new purchases;
- subscription status and billing dates.

### Supabase Edge Functions

Edge Functions currently own:

- the checkout Price allow-list;
- month/year selection of the configured Pro Price;
- requested-workspace billing identity and normalized entitlement;
- trial, Pro, and Business workspace-limit selection;
- subscription and billing-customer projection from Stripe webhooks;
- organization-scoped portal resolution.

### Frontend

The frontend owns display labels, displayed marketing price text, and month/year selection. It sends an interval to the server. It has no authority to approve arbitrary Stripe Price IDs or determine entitlement.

Current display copy is hardcoded and duplicated:

- `getCheckoutPlanOptions()` describes monthly as `$19.99/mo` and yearly as `$199/yr`;
- the plan-picker cards display `$19.99` per month and `$16.67` per month, with yearly subcopy `Billed at $199.99/yr` and `Save 17%`.

These strings are non-authoritative and currently disagree on the yearly total. They must not be treated as approved commercial terms.

### Environment variables

Use variable names only in documentation and reports. Never print secret values or full Stripe object IDs.

| Purpose | Current variables |
|---|---|
| Stripe API | `STRIPE_SECRET_KEY` |
| Webhook verification | `STRIPE_WEBHOOK_SECRET` |
| Pro checkout and interval recognition | `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` |
| Business limit recognition in billing-status | `STRIPE_PRICE_BUSINESS_MONTHLY`, `STRIPE_PRICE_BUSINESS_YEARLY` |
| Pro legacy recognition only | `STRIPE_PRICE_PRO_MONTHLY_LEGACY`, `STRIPE_PRICE_PRO_YEARLY_LEGACY` |
| Business legacy recognition only | `STRIPE_PRICE_BUSINESS_MONTHLY_LEGACY`, `STRIPE_PRICE_BUSINESS_YEARLY_LEGACY` |
| Workspace limits | `TP3D_TRIAL_WORKSPACE_LIMIT`, `TP3D_PRO_WORKSPACE_LIMIT`, `TP3D_BUSINESS_WORKSPACE_LIMIT` |
| Optional portal configuration | `STRIPE_PORTAL_CONFIGURATION_ID` |
| Supabase service access | `SUPABASE_URL`/`URL`, `SUPABASE_ANON_KEY`/`ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`/`SERVICE_ROLE_KEY` |

The current `.env.example` lists safe placeholders for active Pro/Business Price variables, optional comma-separated legacy-recognition lists, all three workspace-limit variables, and optional portal configuration. Active Pro variables enable checkout; legacy variables only preserve recognition for existing subscribers. Deployed values remain configuration, and the shared catalog is the implementation source of truth for interpreting them.

## 3. Current Source Map

| Concern | Current file/function | Environment variable | Authority | Changes customer money behavior? | Deployment required? | Current risk |
|---|---|---|---|---|---|---|
| Catalog configuration and narrow resolvers | `supabase/functions/_shared/billing-catalog.ts` → `getBillingCatalog()` and resolver helpers | Active and legacy Pro/Business Price variables; three limit variables | Shared server configuration | Indirectly; callers control checkout and entitlement | Secret-only change: configuration refresh; catalog-code change: deploy its three importers | P0; active checkout and recognition-only legacy sets are separate |
| Checkout allow-list | `supabase/functions/_shared/billing-catalog.ts` → `allowedCheckoutPriceIds()` and `assertAllowedCheckoutPrice()` | Pro monthly/yearly Price variables | Server allow-list | Yes: controls which Price may be purchased | Secret-only change: configuration refresh; catalog-code change: deploy checkout | High; configured Pro monthly/yearly only |
| Interval-to-Price mapping | `supabase/functions/_shared/billing-catalog.ts` → `resolveCheckoutPrice()`; consumed by `stripe-create-checkout-session` | Pro monthly/yearly Price variables | Server checkout | Yes | Secret-only change: configuration refresh; code change: deploy checkout | High; only `month` and `year` exist |
| Billing-status Price recognition | `supabase/functions/_shared/billing-catalog.ts` → recognition and entitlement-limit resolvers; consumed by `billing-status` | Active and legacy Pro/Business Price variables; three limit variables | App entitlement truth | Indirectly; changes access/limits, not Stripe amount | Secret-only change: configuration refresh; code change: deploy billing-status | P0; unknown usable Prices retain conservative fallback and emit `unknownPriceId` |
| Restore workspace-limit logic | `supabase/functions/_shared/billing-catalog.ts` → `workspaceLimitForRestoreCandidate()`; consumed by `org-restore-workspace` | Three limit variables plus active and legacy Price IDs | Restore authorization | No charge change; yes entitlement capacity | Secret-only change: configuration refresh; code change: deploy restore | P0; explicit legacy tier wins while broader Business Price/plan-name matching remains |
| Webhook projection | `supabase/functions/stripe-webhook/index.ts` → `upsertSubscription()` | Stripe and webhook secrets | Stripe-to-database projection | Reflects billed state; does not choose checkout amount | Deploy webhook only when webhook/shared code changes | P0; `plan_name` is currently written as `pro` |
| Frontend plan options | `src/app.js` → `getCheckoutPlanOptions()` | None | Display only | No | Static frontend deployment | Medium; hardcoded copy can disagree with Stripe |
| Frontend plan picker | `src/app.js` → `pickCheckoutInterval()` | None | Display and interval selection | No direct authority | Static frontend deployment | Medium; duplicated yearly copy currently disagrees |
| Settings Billing CTA | `src/ui/overlays/settings-overlay.js` | None | Display and action routing | No direct authority | Static frontend deployment | Medium; must stay aligned with server truth |
| Workspace limits | `supabase/functions/_shared/billing-catalog.ts` → `workspaceLimitForTier()` and caller-specific resolvers | Trial/Pro/Business limit variables | Server entitlement | No charge change; changes capacity | Catalog-code change: deploy billing-status and restore; secret-only update still needs runtime verification | High; defaults remain `1`, `3`, `10` |
| Business recognition | Catalog exact-ID resolver for billing-status; catalog restore-specific resolver retains Price/plan-name string matching | Business Price and limit variables | Limit recognition only | No active checkout path | Deploy the affected importer(s) | High; caller-specific recognition deliberately remains different |
| Test/live handling | `supabase/functions/_shared/stripe.ts`, `supabase/functions/stripe-webhook/index.ts` event storage, and deployment secrets | Stripe secret, Price IDs, webhook secret | Deployment configuration | Yes | No code deploy for secret-only correction; affected functions must be revalidated | P0; no explicit application mode marker enforces separation |
| Portal configuration | `supabase/functions/stripe-create-checkout-session/index.ts` and `supabase/functions/stripe-create-portal-session/index.ts` → `getPortalConfigurationId()` | `STRIPE_PORTAL_CONFIGURATION_ID` | Stripe portal behavior | Can affect plan-management choices | Secret-only change: configuration refresh; code change: deploy checkout and/or portal | High; requested organization must remain explicit |

The catalog removes duplicated server reads and default-limit interpretation from its three consumers. Caller-specific behavior remains explicit: billing-status recognizes active and legacy tier IDs, restore also preserves its broader Business matcher, and checkout accepts only active configured Pro monthly/yearly IDs. Frontend price copy remains separate from Stripe and from the server catalog.

## 4. Current Known Pricing Constraints

- Commercial pricing is not final.
- Pro monthly and Pro yearly are the only approved checkout paths in current source.
- Business Price variables may be recognized for workspace limits by billing-status, and restore also recognizes Business through Price/plan-name text. Business is not in the checkout allow-list.
- Frontend displayed prices are hardcoded, duplicated, non-authoritative, and currently inconsistent for the yearly total.
- Checkout, billing-status interval normalization, and webhook projection support only `month` and `year`.
- A usable, explicitly mapped active, trialing, or payment-grace Price that is unknown to the catalog retains the conservative Pro/base-paid fallback. Interval and period data still come from the selected subscription when valid.
- `billing-status` returns `unknownPriceId: true` only when the usable direct or owner entitlement candidate has a non-empty unrecognized Price. Known active and legacy Prices, inactive records, archived workspaces, and ambiguous identities return `false`.
- The diagnostic exposes no raw Price ID. Server warnings use reason `billing:unknown-price-fallback` with masked Price and organization references.
- Legacy Price variables are recognition-only. They preserve the mapped tier and workspace limit for existing subscribers and are never added to checkout.
- Checkout explicitly sets `allow_promotion_codes: false`. No coupon or promotion-code product feature is implemented or approved.
- No lifetime or complimentary entitlement feature is implemented.
- No supported existing-subscriber migration tool exists.
- Test/live separation depends on correct deployment secrets and Stripe mode. The app has no explicit mode marker tying Price IDs, Stripe keys, webhook events, and Supabase projects together.
- Webhook rows record Stripe's `livemode` flag, but current source does not use it as a complete deployment-mode enforcement contract.

## 5. Change-Type Decision Table

| Type | Stripe Dashboard action | Repository/config action | Affected functions | Frontend | Required deployment | Migration | Required tests | Rollback limits | Communication | Approved now? |
|---|---|---|---|---|---|---|---|---|---|---|
| A. Display copy only | None | Change both current display locations together | None | Update plan options and picker copy | Static frontend | No | Copy parity, monthly/yearly selection, checkout Price unchanged | Fully reversible before customers rely on copy | Required if public claim changes | Documentation/copy branch only with approval |
| B. Replace monthly Price | Create a new recurring monthly Price; keep old subscription Price | Update `STRIPE_PRICE_PRO_MONTHLY`; update display copy separately if amount changes | Checkout and billing-status consume config | Review monthly copy | Configuration refresh; deploy only changed code/static files | No | Full Section 10 matrix with monthly emphasis | Existing subscribers remain on old Price; charged invoices cannot be erased | Yes |
| C. Replace yearly Price | Create a new recurring yearly Price; keep old subscription Price | Update `STRIPE_PRICE_PRO_YEARLY`; update display copy separately if amount changes | Checkout and billing-status consume config | Review yearly total, monthly equivalent, savings claim | Configuration refresh; deploy only changed code/static files | No | Full matrix with yearly emphasis | Same as monthly | Yes |
| D. Replace both Prices | Create both new recurring Prices | Update both Pro Price variables and all display copy | Checkout and billing-status consume config | Review every displayed amount and savings claim | Configuration refresh plus any changed static/code deploy | No | Both intervals and rollback rehearsal | Larger blast radius; roll back each interval independently where possible | Yes |
| E. Change workspace limit only | None unless commercial Product terms also change | Update the relevant `TP3D_*_WORKSPACE_LIMIT` configuration | billing-status and restore | Update copy only if a visible promise changes | Configuration refresh; deploy only changed source | No | Direct, sibling, over-limit, archive/restore | Existing workspace access can change immediately | Yes only with explicit product approval |
| F. Add a recurring tier | Create Product/Prices only after product approval | New catalog/allow-list/limits/projection contract required | Checkout, billing-status, restore, webhook, portal review | New tier UI and copy | Multiple Edge functions plus static frontend | Maybe; audit first | Full new-tier matrix | Cannot safely roll back after customers subscribe without a support plan | Future work |
| G. Add another interval | Create Price with the approved interval | Extend interval types and every normalization/projection consumer | Checkout, billing-status, webhook; restore review | Add interval selection/copy | Affected Edge functions and static frontend | Maybe | New interval end-to-end | Existing sessions/subscriptions may outlive rollback | Future work |
| H. Stop new checkout for a tier | Deactivate/archive the current purchasable Price(s); do not delete Product/subscriptions | Optional user-facing unavailable copy; do not remove legacy entitlement recognition | Checkout behavior observed; entitlement functions should remain unchanged | Optional truthful unavailable state | Stripe action; static deploy only if copy changes | No | Checkout rejected, old entitlement/portal preserved | In-flight sessions may still require review | Yes as an incident action |
| I. Keep old subscribers grandfathered | Keep existing subscriptions on original Price | Add the old ID to its matching legacy-recognition variable before replacing the active Price | billing-status, webhook, portal, restore | No automatic price promise | Deploy catalog importers when code changes; refresh configuration when lists change | No | Old subscriber access plus new checkout rejection for the legacy ID | Recognition is explicit; verification remains mandatory | Safe default; commercial terms undecided |
| J. Move existing subscribers | Stripe subscription update after full approval | Dedicated migration tooling, evidence, recovery, and audit record | Webhook, billing-status, portal, restore | Communication/support UI as approved | Dedicated controlled release | Possibly | Rehearsal and per-subscription verification | Charges, prorations, and invoices may be irreversible | Required | Future work |
| K. Coupons or promotions | Create approved coupon/promotion objects | Checkout and entitlement policy design; current checkout disables promotion codes | Checkout, webhook, billing-status review | Coupon disclosure and terms | Affected Edge/static deploy | Maybe | Discount, renewal, cancellation, invoice tests | Redeemed discounts and invoices may not be fully reversible | Required | Future work |
| L. Lifetime or complimentary access | No current safe Stripe action | New entitlement model and source of truth required | Billing-status, gates, workspace limits, restore, admin controls | New truthful status/copy | Broad approved implementation | Likely | Full entitlement/security matrix | High risk of permanent access or revocation errors | Required | Future work |

## 6. Safe Price Replacement Procedure

Use this procedure for monthly, yearly, or both. A new Stripe Price is immutable in amount/currency/interval; replacement means creating a new Price.

1. Obtain explicit approval for the change type, customer impact, displayed copy, and rollback owner.
2. In the correct Stripe account's **test mode**, create the new recurring Price for the existing approved Product. Do not modify live mode yet.
3. Keep the old Price and existing subscriptions intact. Do not migrate subscribers.
4. Record masked old/new Price references in [Pricing Change Log](./PRICING-CHANGE-LOG.md).
5. Before replacing an active variable, add the old Price ID to the matching `*_LEGACY` recognition list for its tier and interval. Legacy lists are comma-separated and never checkout-enabled.
6. Configure the new test Price ID in `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, or both for the intended non-production Supabase project.
7. Update repository code/config only where required. A secret-only Price replacement does not require changing catalog source because the catalog reads the variables lazily. Frontend display copy is a separate change.
8. Run source/runtime tests, local database integration, typecheck, lint, and full repository tests.
9. Run deployed-development function checks against the intended project.
10. Complete a real Stripe test-mode checkout for each changed interval and confirm the Checkout Session uses the masked new Price reference.
11. Confirm webhook signature verification, idempotency, organization binding, Price ID, interval, status, and period projection.
12. Confirm `billing-status` returns the requested workspace's direct identity, correct interval/period, entitlement, workspace limit, and `unknownPriceId: false` for both the new active Price and recognized old Price.
13. Confirm direct attempts to checkout with the old legacy Price return the established invalid-Price response.
14. Open the organization-scoped portal and confirm it targets the correct customer/subscription and configured portal behavior.
15. Archive and restore a safe fixture workspace to verify the same recognized tier limit is used by restore logic.
16. Verify F12 direct-paid identity for directly paid siblings.
17. Verify included sibling coverage and over-limit behavior without relying on `includedOrgIds` as direct identity.
18. Verify active direct billing still blocks ownership transfer and that role/owner protections remain intact.
19. Update both frontend display-copy locations separately and prove they match the Stripe amount and approved wording.
20. Rehearse rollback in test mode: restore the previous configured Price reference and verify old checkout, billing-status, webhook, portal, and restore behavior.
21. Repeat the evidence process in live mode only after test-mode sign-off, with the live Stripe account, live Price, live webhook secret, and intended production Supabase project independently confirmed.
22. Only after validation may the old Price be deactivated/archived for **new purchases**. Do not delete the Product, Price, subscriptions, or customers.
23. Do not migrate existing subscribers automatically.

### Current legacy and unknown Price contract

The catalog now represents current active checkout Prices separately from optional recognition-only legacy lists. A recognized legacy Price maps to its current Pro or Business tier and limit, but checkout never accepts it. A usable, explicitly mapped unknown Price retains conservative Pro/base-paid access and reports `unknownPriceId: true`; it is never promoted to Business without a recognized Business ID. Unknown inactive records do not grant access, and ambiguous or conflicting identity still fails closed.

The catalog does not model replacement effective dates, commercial grandfathering promises, or test/live binding. Inventory and test every existing Price before a live replacement. Do not infer commercial terms from technical legacy recognition.

## 7. Grandfathering Policy — Current Safe Default

- Existing Stripe subscriptions stay on their original Price unless an explicitly approved migration changes them.
- Changing an environment Price ID does not modify existing Stripe subscriptions.
- Old Prices must be added to the matching recognition-only legacy list before active configuration stops recognizing them. This preserves existing-subscriber entitlement without enabling new checkout.
- Do not delete an old Product or Price. Do not deactivate an old Price for new purchases until existing-subscriber billing-status, webhook, portal, and restore behavior has been proved.
- Subscription migration is a separate, higher-risk operation.

This is an operational safety default, not final commercial grandfathering policy.

## 8. Existing Subscriber Migration Warning

> **High-risk operation — not approved by this runbook.** Moving an existing subscription to another Price can change invoices, renewal amounts, taxes, credits, and customer expectations. Rollback may be incomplete after Stripe creates a charge, proration, credit, or invoice.

Any subscriber migration requires:

- explicit approval and a named accountable owner;
- an exact affected-customer/subscription inventory;
- a proration decision;
- a renewal-date versus immediate-transition decision;
- test-mode rehearsal with equivalent subscription states;
- idempotent tooling;
- per-subscription before/after evidence;
- partial-failure recovery and safe restart behavior;
- customer communication and consent where required;
- a support plan;
- an audit record;
- a refund/credit policy.

Do not perform subscriber migration manually as an incidental part of a Price replacement.

## 9. Test and Live Environment Safety

- Never mix Stripe test and live secret keys, webhook secrets, Products, Prices, Customers, or Subscriptions.
- Never place secret keys in source control, documentation, screenshots, terminal transcripts, or browser code.
- Confirm Stripe key mode before any Price operation.
- Confirm the exact Supabase project before reading or setting secrets.
- Confirm the intended Stripe account and Dashboard mode independently.
- Mask Price, Customer, Subscription, event, user, organization, and project identifiers in reports.
- Never run fixture tooling against production and never use customer records as fixtures.
- Do not assume a Price ID exists in both Stripe modes. Stripe object IDs are mode-specific.
- Verify the webhook endpoint and signing secret for the same Stripe mode as the Price.
- Record `livemode` evidence from webhook events, but do not treat that field alone as a complete guard.

The current catalog has no test/live mode marker. Legacy recognition lists are environment-specific and must be verified against the same Stripe account and mode as the active Price set. A future mode contract may bind these values explicitly; that is a recommendation, not current behavior.

## 10. Validation Matrix

Use the evidence classifications exactly: **source/runtime**, **local DB**, **deployed development**, **Stripe test mode**, **browser**, and **controlled live**. A source test is not Stripe evidence, and local DB fixtures are not hosted evidence.

| Check | Source/runtime | Local DB | Deployed development | Stripe test mode | Browser | Controlled live |
|---|---:|---:|---:|---:|---:|---:|
| Monthly checkout and configured Price | Required | Supporting | Required | Required | Required | Required before release |
| Yearly checkout and configured Price | Required | Supporting | Required | Required | Required | Required before release |
| Invalid Price rejection | Required | Supporting | Required | Required | Optional | Spot-check |
| Old subscriber access | Required | Required fixture where representable | Required | Required | Required | Required inventory sample |
| New subscriber receives new Price | Required | Supporting | Required | Required | Required | Required controlled purchase |
| Billing-status interval | Required | Required | Required | Required | Required | Required |
| Billing-status period end | Required | Required | Required | Required | Required | Required |
| Workspace limit | Required | Required | Required | Required | Required | Required |
| Direct-paid requested-workspace identity | Required | Required | Required | Required | Required | Required |
| Included sibling coverage | Required | Required | Required | Required | Required | Required |
| Over-limit behavior | Required | Required | Required | Required | Required | Required |
| Portal subscription target | Required | Supporting | Required | Required | Required | Required |
| Webhook projection/idempotency | Required | Supporting | Required | Required | Indirect | Required |
| Workspace restore | Required | Required | Required | Required | Required | Required |
| Ownership-transfer billing guard | Required | Required | Required | Required | Required | Required |
| Role and canonical-owner protections | Required | Required | Required | Supporting | Required | Spot-check |
| Sanitized errors and masked reports | Required | Required | Required | Required | Required | Required |
| Frontend display-copy parity | Required | Not applicable | Deployed static check | Compare to Dashboard | Required | Required |
| Rollback rehearsal | Required | Required | Required | Required | Required | Documented live plan before release |

Do not mark a column passed when that evidence layer was not run. Record **NOT RUN** with the reason.

## 11. Deployment Matrix

| Change | `billing-status` | `stripe-create-checkout-session` | `org-restore-workspace` | `stripe-webhook` | `stripe-create-portal-session` | Frontend/static |
|---|---|---|---|---|---|---|
| Display copy only | No | No | No | No | No | Yes |
| Pro Price secret value only | Validate runtime; no source deploy | Validate runtime; no source deploy | No, unless limits/tier logic also changes | No source deploy; validate projection | No source deploy; validate portal | Only if copy changes |
| Workspace-limit secret only | Validate runtime | No | Validate runtime | No | No | Only if visible promise changes |
| Catalog checkout allow-list or interval code | Review recognition compatibility | Yes | Review restore compatibility | No | No | If selector/copy changes |
| Catalog workspace-limit or Price-recognition code | Yes | Review checkout compatibility | Yes | No unless projection changes separately | No unless portal targeting changes separately | If visible tier/copy changes |
| Billing recognition/tier mapping | Yes | If checkout availability changes | Yes when restore mapping/limit changes | Yes when projection changes | Review organization/plan targeting | Yes when visible tier/copy changes |
| Webhook projection only | Review consumer compatibility | No | Review projected fields | Yes | Review projected mapping | No unless status copy changes |
| Portal configuration secret only | No | Validate existing-subscription redirect | No | No | Validate runtime | No |

Setting an Edge secret/configuration value and deploying function source are different operations. Do not redeploy an unaffected function merely because another function changed. A catalog source change requires deploying its current importers: billing-status, checkout, and restore. `_shared/stripe.ts` remains a separate shared dependency; changing it still requires redeploying its current importers: billing-status, checkout, portal, and webhook.

## 12. Rollback Procedures

| Failure | Immediate stop | Code/config rollback | Stripe action | Supabase repair | Customer communication | Irreversible effects | Evidence after rollback |
|---|---|---|---|---|---|---|---|
| Wrong display copy | Pause promotion/share links | Revert static copy and redeploy | None | None | Correct material if published | Customer confusion | Screenshots plus checkout Price comparison |
| Wrong checkout Price ID | Stop new checkout; deactivate wrong purchasable Price if necessary | Restore prior Price variable | Preserve objects; cancel only proven erroneous sessions/subscriptions under incident approval | Correct projection only from Stripe truth | Contact affected purchasers | Completed charges/invoices may remain | Session/subscription inventory, webhook and billing-status proof |
| Wrong workspace limit | Stop limit/config rollout | Restore prior limit in every consumer | None | Repair only proven incorrect projection/access state if needed | Notify customers whose access changed | Temporary access denial/grant | Direct/sibling/over-limit/restore matrix |
| Wrong tier mapping | Disable affected new checkout | Restore prior recognition/limit mapping | Keep existing objects | Reconcile affected projections from Stripe truth | Required for entitlement impact | Access may have been granted/denied | Per-workspace entitlement evidence |
| Bad webhook projection | Keep event retries available; pause risky follow-on operations | Revert webhook code and redeploy | Do not delete Stripe truth | Replay/reconcile idempotently from verified events | If customer access/payment UI was wrong | External Stripe event already occurred | Event IDs masked, projection before/after, billing-status |
| Test/live mismatch | Stop all billing actions immediately | Restore correct mode-specific secrets | Do not copy/delete cross-mode objects | Remove only exact test pollution from non-production; escalate any live impact | Required for any live exposure | Live objects/charges cannot be moved to test | Independent account/mode/project verification |
| Accidental subscriber migration | Stop migration tool/job | Disable migration path; do not blindly reverse | Follow approved per-subscription recovery | Reconcile from final Stripe state | Mandatory | Proration, invoice, charge, tax, credit may persist | Per-subscription audit and financial reconciliation |
| Unintended Business checkout | Deactivate unintended purchasable Price | Restore Pro-only allow-list/config and redeploy affected code | Preserve existing affected subscriptions pending decision | Reconcile tier/limit projection | Mandatory for purchasers | Existing contracts/charges may remain | Checkout rejection plus affected-subscriber inventory |

Never repair billing by broad database deletion or by making Supabase projection contradict Stripe.

## 13. Emergency Checkout Stop

There is no current application checkout kill switch. The checkout function resolves one of the configured Pro Price IDs through the catalog and validates it against the catalog's same Pro-only allow-list.

The smallest no-code emergency action is:

1. Confirm the affected Stripe account and mode.
2. Deactivate/archive the affected currently configured Pro Price for new purchases. Deactivate both monthly and yearly Prices to stop all new checkout.
3. Leave Products, Customers, Subscriptions, and existing entitlement projections intact.
4. Verify new Checkout Session creation is refused for each stopped interval.
5. Verify existing subscribers still receive correct billing-status, portal access, workspace limits, and Pro entitlement.
6. Record the incident and masked Price references.

Do not delete Stripe objects. Do not cancel customer subscriptions as a checkout-stop mechanism. Removing a required Price secret can also stop checkout, but because those variables are read by billing-status for interval recognition, it has a broader diagnostic blast radius and is not the preferred first action.

## 14. Pricing Change Evidence Template

Copy this block into an approved change record. Mask every external identifier.

```text
Change ID:
Date/time and timezone:
Approved by:
Implementation SHA:
Deployment project (masked):
Stripe account/mode:
Tier:
Interval:
Old Price reference (masked):
New Price reference (masked):
Change type (A–L):
Customer impact:
Grandfathering decision:
Migration performed: no / approved reference
Source/runtime results:
Local DB results:
Deployed-development results:
Stripe test-mode results:
Browser results:
Webhook results:
Portal results:
Workspace-limit/restore results:
Rollback rehearsal:
Customer communication:
Open gaps:
Final sign-off:
```

Append the final record to [Pricing Change Log](./PRICING-CHANGE-LOG.md). Never overwrite an older entry; append a corrective entry linked to the original change ID.

## 15. Open Decisions

The following remain unresolved and are not approved by this runbook:

- final monthly price;
- final yearly price;
- annual savings/discount representation;
- Business tier launch and included features;
- final Trial, Pro, and Business workspace limits;
- trial duration and eligibility policy;
- founder pricing;
- refund policy;
- cancellation timing;
- proration policy;
- tax handling;
- supported currency/currencies;
- existing-subscriber migration or commercial grandfathering;
- coupon and promotion policy;
- lifetime and complimentary access.

Operational priority and approval come from [Master TODO V6](../product/TP3D-MASTER-TODO-V6.md). Broader context is preserved in the [July 2026 Product Strategy Debrief](../product/PRODUCT-STRATEGY-DEBRIEF-2026-07.md).

## 16. Catalog Implementation Status

Unknown and replaced Price handling is implemented and validated. One shared catalog now exposes active-checkout IDs, recognition-only legacy IDs, tier resolution, known/legacy checks, and conservative unknown fallback. Its three importers remain billing-status, checkout, and restore. Webhook and portal remain catalog-independent, shared Stripe helpers are unchanged, and no frontend pricing, migration, commercial value, or subscriber Price changed.

The validated behavior is:

- current configured Pro monthly/yearly Prices are the only checkout-enabled recurring paths;
- configured Business and all legacy Prices are recognition-only and checkout-disabled;
- recognized legacy Pro/Business Prices retain their current tier and workspace limit;
- usable explicitly mapped unknown Prices retain paid Pro/base fallback and return `unknownPriceId: true` without exposing the Price ID;
- inactive unknown records do not grant access, while ambiguity and archived-workspace rules remain fail closed;
- workspace-limit defaults remain Trial `1`, Pro `3`, and Business `10` when configuration is absent or invalid;
- restore recognizes explicit legacy tiers before preserving its broader Business matcher;
- webhook continues storing Stripe Price truth, and portal remains organization-scoped without Price recognition.

Local Stage B passed 39/39 with zero residual rows. Catalog tests passed 13/13, security/invariants passed 881 with 5 existing skips, fixture safety and typecheck passed, lint had 0 errors, database lint retained only two existing warnings, and the full repository suite passed 1,027 with 5 existing skips. Development deployment was limited to billing-status, checkout, and restore; known direct and included-sibling results were unchanged, the existing-subscriber configured checkout path returned the expected portal flow, and unknown/retired-like checkout IDs retained the sanitized 400 response. Unknown active behavior was proved through the real local Edge/database fixture. No payment was completed.

The next approved billing task is deployed development-function smoke fixtures. It must remain development-only, masked, exact-cleanup-owned, and separate from Stripe test-mode fixture work.
