# Cargo Planner 3D — Product Strategy Debrief — July 2026

## Document Status

This is a **supporting product strategy reference**. It preserves the broad direction, open decisions, and future candidates discussed in the July 2026 debrief.

It is:

- not the active task list;
- not a permanent behavioral contract;
- not approval to implement every system described here;
- subordinate to [Master TODO V6](./TP3D-MASTER-TODO-V6.md) for current operational status (V5 is frozen/historical); and
- subordinate to the named domain contracts for approved behavior within their scope.

The current behavioral authorities include [Billing Entitlement Rules](./BILLING_ENTITLEMENT_RULES.md), the [AutoPack Engine Contract](../engineering/autopack-engine-contract.md), and the [Settings Visual System Contract](./SETTINGS-VISUAL-SYSTEM-CONTRACT.md). Where the original debrief conflicts with those documents or with current V6 status, the applicable contract governs behavior within its scope and [Master TODO V6](./TP3D-MASTER-TODO-V6.md) governs current operational status. V5 is historical, and this July 2026 debrief remains historical strategy context.

All schedules and duration ranges in this document are planning estimates only. They are not commitments, release dates, branch approvals, or staffing promises.

## Executive Summary

AutoPack and manual-placement reliability remain core product priorities. The July discussion also covered visual quality, rendering performance, server persistence, a public API, deployment, billing operations, business identifiers, internal operations, accessibility, support, and security. Those subjects are preserved here so that they can be evaluated deliberately without becoming parallel implementation streams.

The central operating principle is isolation: each future area requires its own measured scope, audit, product decision, tests, and approval. Visual work must not alter packing geometry. Data-model work must not be mixed into billing or AutoPack work. Operational tooling must not expose customer cargo data or privileged credentials.

Cases and Packs remain intentionally local-first during current development. Supabase remains the current temporary development backend, but server persistence must become stable before a supported public API. Billing reliability work remains active before Max Capacity Phase C. Visual quality, server persistence, API, operations, and identifier work are future candidates, not concurrent implementation.

## Settled Product Direction

- The product direction is a premium real-time 3D cargo planning and visualization environment.
- Packing geometry and visual representation remain separate layers. Visual models, materials, labels, lighting, and effects must never change dimensions, containment, collision, support, gravity, AutoPack, or manual-placement validation.
- Case and Pack storage remains local-first during current development while the models and solver rules continue to evolve.
- Supabase remains the current temporary development backend for authentication, workspaces, database, storage, and Edge Functions.
- AWS is unnecessary without a demonstrated heavy server workload. If adopted later, it should serve a specific job rather than trigger a wholesale platform move.
- Cloudflare Pages remains a future frontend-hosting candidate; no automatic deployment is asserted by this document.
- A supported public API waits for stable server-backed Case and Pack persistence.
- Telemetry must avoid sensitive cargo content by default and must never block editing, saving, AutoPack, or export.
- Internal UUIDs remain stable technical identity. User-facing business identifiers remain separate from UUIDs and from physical packing signatures.
- Billing, visual, data-model, persistence, and AutoPack changes must remain isolated and independently validated.

*July 2026 snapshot, superseded:* at the time of this debrief, Local Billing Fixture Stage B was the only active task and Max Capacity Phase C was blocked until the billing reliability gate closed. Current status and approvals are recorded only in [Master TODO V6](./TP3D-MASTER-TODO-V6.md).

## 3D Rendering and Visual Quality

### Space types

Future visual exploration may cover dry van trailers, box trucks, shipping containers, cargo vans, warehouse zones, storage bays, and later aircraft cargo areas. Transparent, solid, and cutaway modes should support inspection without changing the valid packing volume.

### Cargo visual types

Candidate visual families include cardboard cases, plastic totes, wood crates, metal cases, pallets, shrink wrap, pipes, drums, appliances, and generic planning blocks. A business record may choose a visual treatment while retaining exact packing geometry.

### Scene and camera quality

Candidate improvements include Studio, Warehouse, and Technical lighting profiles; clearer contact shadows; refined floors and backgrounds; controlled edge treatment; readable selection and warning states; named perspective views; and orthographic top, front, rear, and side views. Transparent or cutaway truck walls should improve clarity without concealing safety violations.

### Print and export quality

Higher-cost render settings may be appropriate for screenshots, print, and PDF output when they do not affect interactive state or placement results. Export quality should emphasize readable labels, accurate placement, professional composition, and predictable output.

Competitor examples demonstrate that clarity is more important than photorealism: simple geometry, large labels, transparent walls, and recognizable grouping are commercially useful. Potential quality targets combine that clarity with better depth, light realistic detail, stronger truck and cargo forms, and professional reports.

Any previously discussed 8–12 week foundation or 12–16 week expansion range is a planning estimate only. No visual schedule or implementation phase is approved here.

## Rendering Performance

The present risk is cumulative scene cost from repeated canvas textures, per-object materials, separate edge objects, shadows, and numerous scene nodes. Large projects can therefore create excessive draw calls, materials, textures, shadow calculations, and memory pressure.

Future performance candidates include:

- shared base geometry and materials;
- instanced rendering for repeated cases, pipes, drums, and trailer components;
- label texture atlases and labels separated from base cargo materials;
- distance-based label visibility and detail reduction;
- rendering only while the scene or camera changes;
- Low, Medium, High, and Export quality profiles; and
- high-cost effects reserved for export when appropriate.

Performance evaluation should include 25, 100, 300, 500, and 1,000 items; hundreds of cylinders; mixed cargo; transparent spaces; Wheel Wells; and Front Overhang. Candidate objectives include responsive dragging, unchanged AutoPack results, stable memory across multiple Packs, approximately 60 FPS for ordinary projects, and at least 30 FPS for large supported projects. These are proposed measurement targets, not a current acceptance contract.

No visual or rendering-performance implementation is approved by this document.

## Public API and Server Persistence

There is no supported public customer API today. The app contains internal JavaScript services, libraries, AutoPack modules, Supabase integration, and browser-level methods, but these are not a stable external contract.

Cases and Packs are still local-first. Current scoping is:

```text
Signed-in user
    ↓
Active Supabase workspace
    ↓
Browser-local Case and Pack libraries
```

The workspace ID separates local records, but those records are not yet authoritative server-side Case and Pack rows. Stable server-backed persistence is therefore a prerequisite for multi-device authority, reliable partner integrations, server jobs, webhooks, and shared Pack state.

A future API foundation would need:

- stable and versioned Case, Pack, instance, import, and export schemas;
- API keys, scoped permissions, request validation, and rate limits;
- durable job and multiple-solution result records;
- explicit error codes and OpenAPI documentation;
- idempotency, webhooks, usage records, and audit records; and
- read-only viewer tokens with narrow, revocable access.

Earlier private-beta estimates of 10–14 weeks and production estimates of 14–20 weeks are planning estimates only. API work requires a separate decision after persistence is stable.

## Hosting and Deployment Direction

- **BanaHosting:** may continue serving the current static frontend and unrelated websites or email while that arrangement remains reliable.
- **Cloudflare:** remains suitable for DNS, HTTPS, caching, global asset delivery, and security rules.
- **Supabase:** remains the current temporary development backend for authentication, workspaces, database work, future storage, and Edge Functions.
- **GitHub:** remains the source-history and review foundation and can later coordinate tests, branch protections, releases, and deployment records.
- **Cloudflare Pages:** is a future candidate for frontend hosting, branch previews, staging, production deployment, domains, and rollback.
- **AWS:** should be considered only for demonstrated heavy workloads such as long-running server AutoPack jobs, queues, workers, server PDF/rendering, CAD conversion, model optimization, or specific enterprise requirements.

A possible future deployment flow is feature branch → automated checks → preview → review → merge → production. An integration branch could provide staging and `main` could become the production source later. This is a direction, not proof that automatic deployment, previews, or production-from-main exist today.

NoCodeBackend (NCB) is the preferred future migration target for production identity, billing, memberships, and Load Plan (`pack` internally) authority. A September 2026 investigation found NCB could be a viable future backend, but the migration was paused so product, domain, email, billing, settings, and workspace-behavior work can be completed first — see [NCB Migration Investigation — Paused](../archive/2026-09-ncb-migration-paused/README.md). NCB is not the current runtime backend; Supabase remains the temporary development backend, and server persistence remains a separate future phase. This update does not authorize migration implementation.

## Billing, Account, Workspace, and Stripe Direction

Reported lag in account, workspace, Settings, and billing flows should be addressed through evidence before provider changes. A focused timing audit should measure session resolution, account data, organization list, active workspace, members, `/billing-status`, rendering, request count, cache behavior, HTTP results, tab state, and workspace identity. Improvements should remain isolated from AutoPack and should follow backend truth rather than mask lifecycle problems in the UI.

As of July 2026, billing reliability work was active and defined in V5; current status is in [Master TODO V6](./TP3D-MASTER-TODO-V6.md). Detailed owner-account, workspace-limit, direct-paid identity, entitlement, and owner-only money-action rules remain governed by [Billing Entitlement Rules](./BILLING_ENTITLEMENT_RULES.md); this debrief does not restate or change them.

Stripe remains in development/test-mode use. The final legal seller account is undecided. Before live payments, the product needs a selected and verified seller entity, isolated live credentials, approved products and Prices, branding, payout and team controls, and tested app-created customer flows. If founder pricing is approved, it should use separate Stripe Price records rather than mutate regular prices.

Customer Portal behavior, final monthly/annual choices, tax, Radar, Smart Retries, payment recovery, refunds, disputes, proration, notices, test clocks, 3D Secure, webhook ordering, and duplicate-event tests remain later launch work. No provider migration should be approved merely because of an unmeasured delay.

The locked current owner-account billing model is not reopened by this strategy reference. Consolidated or next-generation billing architecture is an open future product decision only if it receives separate scope and approval.

## Platform Operations and Developer Console

A private Platform Operations and Developer Console is a future candidate, not current work.

Business operations may eventually cover users, workspaces, trials, paid plans, cancellations, failed payments, revenue, and account support. Engineering and product operations may cover errors, crashes, slow requests, AutoPack success and duration, export failures, browser and release problems, old app versions, and webhook failures.

Candidate sources include Stripe for payments, Supabase for users and access, a privacy-reviewed analytics platform such as PostHog for aggregate product use, an error platform such as Sentry for failures and performance, Cloudflare for delivery and availability, and GitHub for releases and deployment history. Tool choice remains open.

Any console should use a separate admin domain, a platform-admin role, MFA, short sessions, and server-side privileged credentials. Service-role keys must never enter browser code. Initial support tools should be read-only, every administrative action should be logged, and broad user impersonation should be avoided.

Permitted telemetry should favor browser family/version, operating system, device class, app version, coarse screen size, WebGL capability, broad location, and minimized error context. Exact GPS, durable fingerprinting, cargo contents, Pack or Case names, customer addresses, shipment details, and long-term exact IP history should not be collected by default.

## Case, Pack, and Instance Business Identifiers

Internal UUIDs are necessary technical identities, but they do not replace the business references customers use.

### Case identifier candidates

- internal UUID;
- SKU or item code;
- manufacturer part number;
- barcode such as GTIN, UPC, or EAN;
- revision; and
- external references, scoped by source system.

### Pack identifier candidates

- internal UUID;
- Pack or load-plan number;
- client or customer references;
- project codes;
- purchase order, sales order, shipment, booking, bill of lading, and route references.

### Pack-instance identifier candidates

- internal instance UUID;
- LPN or pallet ID;
- unit reference;
- serial and lot;
- stop number; and
- delivery sequence.

The central rule is permanent in direction: **business identity is separate from physical packing signature**. Two SKUs may have identical dimensions, weight, orientation, and handling rules while remaining distinct business records. Internal UUIDs should remain stable through future migration and should not be replaced by editable business fields.

Candidate uniqueness policies include workspace-unique SKU when present, workspace-unique Pack number, manufacturer plus part number as a pair, and external reference uniqueness by workspace, source, and value. These are proposals, not implemented constraints. Exact fields, formats, search/import matching, label behavior, and migration rules require a dedicated product/data contract.

## Accessibility, Browser Support, Assets, Backup, Support, and Security

These areas are required before a broad public release, but none is a current active branch.

### Accessibility

Plan for keyboard access, visible focus, screen-reader names, status icons in addition to color, color-blind-safe states, text scaling, high-contrast print, and reduced motion. Formal accessibility targets and test methods remain open.

### Browser and device support

Define an official matrix for Chrome, Edge, Safari, Firefox, macOS, Windows, iPad, Android tablets, and minimum GPU/memory expectations. Large-scene loading should eventually use a WebGL capability check and a truthful unsupported/limited-mode response.

### Asset rights and upload pipeline

Premium models and textures need verified commercial rights, size and complexity budgets, GLB and texture validation, model reduction, thumbnail generation, malware/file validation, and explicit public/private storage rules.

### Backup and disaster recovery

Before authoritative server persistence, define database and storage backup policy, customer export, restore testing, deletion recovery windows, disaster-recovery procedures, and production rollback.

### Customer support operations

Before paid broad release, define a support address, problem-report flow, ticket references, response expectations, known-issue and status pages, release notes, account recovery, and billing support.

### Production security review

Before production persistence or public API exposure, perform a threat review covering RLS, admin roles, API keys, uploads, rate limits, audit records, session expiry, account deletion, data export, dependency risk, and incident recovery.

## Product Naming and Brand Structure

The current names are **Cargo Planner 3D**, **Truck Packer 3D**, and **Just Pack It**. This document does not choose among them or define their relationship.

Later decisions must define the final product name, legal billing name, application domain, admin domain, API name, report branding, Stripe statement descriptor, and GitHub naming policy.

## Data Versioning and Sync Policy

Future durable models should explicitly version Case, Pack, workspace export, and solver data, with candidate fields such as `caseSchemaVersion`, `packSchemaVersion`, `workspaceExportVersion`, and `solverVersion`.

Before server synchronization, decide whether and how users work offline; how autosave relates to local and server state; what happens when multiple devices edit one Pack; how stale data is detected; whether conflicts create copies; which edits win; and how users recover or export their work. This document does not define an implementation.

## Open Product Decisions

The following deduplicated decisions remain open unless a later approved source closes them:

1. Final product name and the relationship among the three current names.
2. Final legal seller entity and customer-facing billing identity.
3. Final commercial pricing and intervals.
4. Founder-pricing eligibility, duration, and migration rules.
5. Trial policy.
6. Refund policy.
7. Cancellation and access-end timing.
8. Tax handling.
9. Cloudflare Pages and preview/staging timing.
10. Sentry or an alternative error and performance service.
11. PostHog or an alternative product analytics service.
12. Exact Case business-identifier fields.
13. Exact Pack and shipment-reference fields.
14. Pack-number format and generation rules.
15. Offline and server-sync behavior.
16. Multi-device conflict resolution and recovery.
17. First premium space models.
18. First cargo material types.
19. Final visual style: Studio, Technical, Warehouse, or a controlled combination.
20. Official browser, device, GPU, and memory support.
21. Consolidated or workspace billing architecture only as a separately scoped next-generation decision; it does not change the current owner-account contract.

## Deferred Candidate Work

The following groups are not approved branches, are not active work, and do not block Local Billing Fixture Stage B. Each requires a focused audit or product decision before implementation.

- **Visual quality:** space/cargo models, materials, lighting, cutaway modes, camera views, labels, and export presentation.
- **Rendering performance:** instancing, shared resources, label atlases, distance detail, render scheduling, quality profiles, and fixed-load benchmarks.
- **Server persistence:** authoritative Case/Pack storage, migration, sync, recovery, retention, and conflict behavior.
- **Public API:** versioned external schemas, authentication, authorization, jobs, idempotency, webhooks, usage, audits, and viewer tokens.
- **Deployment and preview environments:** automated checks, branch previews, staging, production-from-main policy, and rollback.
- **Operations console:** privacy-safe business, engineering, support, and incident views with strict admin security.
- **Business identifiers:** Case, Pack, and instance fields, uniqueness, search/import behavior, labels, and reports.
- **Accessibility:** keyboard, assistive-technology, contrast, scaling, and reduced-motion requirements.
- **Browser support:** official compatibility and capability policy.
- **Asset pipeline:** licensing, validation, optimization, upload safety, and storage controls.
- **Backup and recovery:** backup, restore, deletion recovery, exports, disaster recovery, and rollback.
- **Customer support:** contact, tickets, status, known issues, recovery, and billing operations.
- **Security and rate limits:** threat modeling, RLS, sessions, uploads, API controls, auditability, and incident response.
- **Telemetry and analytics:** privacy-safe measures, retention, minimization, error reporting, and operational reliability.
- **Next-generation billing architecture:** integrity, reconciliation, identity, subscription-policy, and consolidation questions after current billing reliability closes.

## Recommended Long-Term Order

This is a broad planning sequence, not the active queue (see V6):

1. Complete the current billing reliability foundation.
2. Resume Max Capacity Phase C.
3. Close remaining AutoPack quality and release work.
4. Define the business-identifier contract.
5. Define the visual-quality and rendering-performance contract.
6. Add deployment checks and a preview environment.
7. Add privacy-reviewed error reporting before broad beta.
8. Start isolated visual-quality work.
9. Add business identifiers to the local model.
10. Plan staging/production Supabase separation.
11. Move Cases and Packs server-side after the local model is stable.
12. Add internal operations tooling after reliable, privacy-safe data collection exists.
13. Consider a public API after server persistence is stable.
14. Add heavy server infrastructure only when a real workload requires it.

The older debrief began with AutoPack portfolio work. V5 (as of July 2026) recorded that portfolio and Max Capacity Phases A and B as completed; this roadmap does not reopen them. The July 2026 statements that Stage B billing fixtures were the only active task and that Phase C was blocked until billing reliability closed are superseded; see V6.

## Links to Current Sources of Truth

- [Master TODO V6](./TP3D-MASTER-TODO-V6.md) — current status, blockers, and approved execution queue. ([V5](./TP3D-MASTER-TODO-V5.md) is frozen/historical.)
- [Billing Entitlement Rules](./BILLING_ENTITLEMENT_RULES.md) — approved billing and workspace product semantics.
- [AutoPack Engine Contract](../engineering/autopack-engine-contract.md) — packing geometry, physical safety, and editor mutation behavior.
- [Settings Visual System Contract](./SETTINGS-VISUAL-SYSTEM-CONTRACT.md) — approved Settings visual behavior within its scope.
- [Billing Fixture Safety Foundation](../dev/billing-fixtures.md) — local billing fixture boundaries and commands.
- [Documentation Inventory — 2026-07](../archive/DOCUMENTATION-INVENTORY-2026-07.md) — documentation authority and lifecycle classification.
