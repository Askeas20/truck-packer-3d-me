# Truck Packer 3D — Master TODO V6

**Last updated:** 2026-11-04
**Status:** Active operational roadmap.

---

## 1. Document Authority / Purpose

1. V6 is the current operational source of truth for Truck Packer 3D.
2. V5 (`TP3D-MASTER-TODO-V5.md`) is frozen/historical — do not use it to determine active work.
3. This document contains: current baseline, recently completed milestones, the current active milestone
   (if any), unapproved candidate workstreams, deferred work, critical invariants, and technical-debt
   follow-ups. A workstream is not active or approved until Section 4 names it.
4. Git history and project memory hold detailed implementation history. Do not paste full reports here.
5. Domain contracts win within their stated scope:
   - [Billing Entitlement Rules](./BILLING_ENTITLEMENT_RULES.md)
   - [AutoPack Engine Contract](../engineering/autopack-engine-contract.md)
6. Update at milestone closeout only. Replace stale status; do not append contradictory blocks.
7. `AGENTS.md`, `CLAUDE.md`, and `src/CLAUDE.md` define agent working rules and point here for status.

---

## 2. Current Baseline

| Field | Value |
|---|---|
| Repository branch | `main` |
| V6 creation baseline | `002c1f187b4a67fae6a1cbfde373c233f83d42f7` (snapshot at V6 creation; historical reference only) |
| Verified main at P2.5 start (2026-10-03) | `fe4bfe3be2b9a77b0d7ef9fc183fa08fd0ed15e3` — PR #95 merged; local `main` matched `origin/main` before branching |
| Last merge before P2.5 | PR #95 `cleanup: complete P2 legacy and dead code cleanup` |
| P2.5 implementation base | `test/p2-5-suite-ci-optimization` branched from that verified main; its PR and merge commit record the final P2.5 state |
| Three.js runtime | `three@0.185.1` via npm/Vite (WebGLRenderer, r185.1) |
| Vite | `8.2.1` |
| Node requirement | `^20.19.0` or `>=22.12.0` |
| Verified main after CI optimization (2026-10-17) | `a3c47f28c7930778771ac0806d398be22ed712a4` — PR #123 merged; main updated on GitHub |
| Verified main after Camera Controls Relocation (2026-10-17) | `c28fca550d827b67d855832ea913a57cf8423674` — PR #124 merged |
| Measurement Tool V1 | **MERGED** — PR #125, merge `036490a` (2026-10-20), from `feat/editor-measurement-tool-v1` (created from `c28fca550d827b67d855832ea913a57cf8423674`); Quality Gate passed. Contract and history: Section 4.1. Later refined by PR #129 (Section 3) |
| Verified main after Folder Foundation Stage 1 (2026-11-03) | `3052224bf1506ad529db2c3f2105437d864ad021` — PR #132 merged; local `main` matched `origin/main` |
| Quality Gate cost policy | One automatic **fast** Quality Gate for PRs targeting `main` (about 4–5 minutes: static checks, the full Node lane, a small Chromium smoke set, build, production audit, patch whitespace; 10-minute fail-safe); the complete Chromium regression is the local `npm run test:regression`, run before major releases or after high-risk changes and never scheduled; optional manual `workflow_dispatch`; no automatic run after merge/push to `main`. Focused local checks during implementation; documentation-only changes require diff/status checks, not application suites. |

---

## 3. Recently Completed Major Milestones

| Milestone | Key Result | PR / SHA |
|---|---|---|
| Folder Foundation Stage 1 | Folder security (names rendered as text; dialogs and menus bound to the user and workspace they opened in), workspace-scoped persistence and honest save results, damaged-Folder-graph detection with explicit repair that keeps recovery evidence (never silent), Unfiled kept separate from Folder ids, no-op rename/move writes nothing, empty-state and filter wording, Load Plans Undo/Redo scoped to Folder steps (Editor Undo/Redo unchanged), and the ten Stage 1 real-app tests in the browser CI lane. Completed 2026-11-03. Known limitations and deferred follow-ups: Section 6. **Folder Enhancement V1 is a separate, not yet approved milestone (Section 4)** | PR #132, merge `3052224` |
| Editor Annotations, Measurements & Unified Undo/Redo | Independent Annotations and Measurements managers; direct scene selection of existing Arrows and Measurements; editable endpoints; whole-Arrow and whole-Measurement movement on one compatible physical surface; shared single-sequence Undo/Redo with exact `lastEdited` restoration; Drawing and Callout refinements; preview and historical-state handling. Completed 2026-11-01. Open limitations are in Section 4.1 *Visibility* | PR #129, merge `61fc340` (feature head `b4bcd61`) |
| Measurement Tool V1 and Annotations V1 (Callouts, Arrows, Drawing) | Persistent point-to-point Measurement Tool (contract: Section 4.1); persistent 3D Callouts (V1A), directional Arrows (V1B.1) and freehand Drawing (V1B.2). Each passed the PR Quality Gate before merge. Completed 2026-10-20 to 2026-10-28; refined by PR #129 above | PR #125 `036490a`; PR #126 `bd68ac8`; PR #127 `df4d7f8`; PR #128 `e26427e` |
| Quantity Controls | Ecommerce-style Case Qty, atomic Undo/Redo, multi-unit staging, Cases/Load Plans qty surfaces, PDF reporting, legacy cleanup | PR #20, `37d2c4c` |
| LLM QA Navigation Runbook | Runbook for AI-assisted QA navigation | PR #22 |
| Three.js npm/Vite migration | Migrated Three.js r160 from CDN/vendor to npm + Vite build pipeline | PR #23, `be62612` |
| Three.js r185.1 upgrade | Upgraded Three.js runtime from r160 to r185.1 | PR #24, `02ff0f7` |
| Space Utilization foundation | Initial Inspector gauge, editor card layout integration, capacity UI | PR #21, `7409b12` |
| Generic Space Utilization Engine | Engine extracted to generic spatial calculator; scale-only Inspector card (capacity-only, no arc gauge) | PR #25, `fc50d3c` |
| Project AI memory/retrieval infrastructure | `.ai/memory.json`, `tools/project-memory` CLI, Obsidian vault integration, Graphify routing | PR #26, `002c1f1` |
| Import/Export/Recovery | Completed import/export and recovery flows | PR #36, `dc5ff0b` |
| Font Awesome vendor packaging | Tracked required Font Awesome vendor CSS (fixed missing icon packaging) | PR #37, `794679d` |
| Debugger / MCP config cleanup | Removed obsolete debugger; ignored local MCP configuration | PR #38, `b5626ae` |
| Editor stabilization & polish sequence | Preview integrity (capture identity, freshness, image fidelity); Pack/camera view isolation; AutoPack Results synchronized with committed Pack; Export Integrity A/B/C; Editor accessibility/responsive safety; Case Browser filters; Editor regression cleanup; Professional Dropdown System; unified Focus/Selection visuals; Shortcut Contract cleanup + Keyboard Shortcuts resource | PR #74–#88, `59ed22e` |
| Business Identity (Phases 1 + UI) | Case `itemCode`, Load Plan `loadPlanNumber` / `customerReference`, identifier UI, Card Display | PR #14, #16 |
| Billing/Platform Foundation (Packets 1–3) | org INSERT boundary, server workspace limits, slug integrity, billing fixture harnesses, normalized entitlement | Multiple PRs through V5 |
| AutoPack Cleanup | Legacy solver removed, strategy differentiation audit, Max Capacity Phase C profile reporting | V5 milestones |
| Cargo Instructions (Phases 1–3) | Standard Instructions, Instance Notes, Pack Notes Editor access | V5 milestones |
| app.js P0 modularization | Billing/Org/Auth/AccountSwitcher extracted; app.js −27.8% (9,510 → 6,867 lines) | PR #7 |
| P2 — Legacy / Dead Code | Removed disconnected legacy modules and test-pinned dead code; retired the legacy Settings screen safely (`#/settings` now opens Settings → Preferences; "Reset demo data" removed); removed broken `lint:report` and unused `knip.json`; corrected stale active contracts; KEEP/DEFER registry in Section 8 | PR #93, PR #94, PR #95 |
| C5 stabilization | Scoped camera/orientation and staged Truck Change improvements; C5 packing-quality work remains paused | PR #117 |
| Editor CSS cleanup + Import / Export navigation | Consolidated layout styling and improved import/export access | PR #119 |
| Camera Phase 1 | Seven named Editor camera views, Fit Truck and interactive View menu | PR #120 |
| Camera Phase 2 | Interactive Perspective / Orthographic projection, per-Load-Plan camera metadata, Settings integration and export support; live PDF acceptance passed | PR #121 |
| Optional viewport Zoom Controls | Zoom In/Out for both projections; Settings On/Off visibility | PR #122 |
| Quality Gate cost optimization | Preserve PR and manual gate; stop duplicate runs after merge | PR #123 |
| Quality Gate speed | Split the PR gate (fast smoke) from the full local regression (`test:regression`); shell-only Chromium install; 10-minute fail-safe | PR #125 |
| Camera controls relocation | Camera Views button moved into the floating viewport group above Zoom In/Out; independent Show Camera Controls setting on the lightweight visibility route | PR #124, `c28fca5` |

---

## 4. Current Active / Next Milestone

**Current status (2026-11-04):** **No implementation milestone is currently active.** Folder Foundation Stage 1 is complete and merged (PR #132; Section 3). Measurement Tool V1 and Annotations V1 (Callouts, Arrows, Drawing) are complete and merged (PRs #125–#129; Section 3), as are Camera Phase 1, Camera Phase 2, optional Zoom Controls and the Camera Controls relocation (PRs #120–#124). The owner accepted live PDF verification for Camera Phase 2 on 2026-10-17. PR #123 closed the duplicate full Quality Gate after merge.

**Next planned product-review milestone: Folder Enhancement V1.** Its product contract has **not** been approved and its implementation has **not** started. Before any implementation branch exists, the owner reviews the Folder Enhancement V1 mockups, the existing Folder UI, the earlier recommendations and the deferred Stage 1 follow-ups (Section 6), then approves a complete product contract. A candidate is not active until this section names it as approved.

### Owner-approved sequence (planning order, not blanket implementation authorization)

| Order | Milestone | Intended outcome / contract to define | State |
|---|---|---|---|
| 1 | **Measurement Tool V1** | Illustrative, informational point-to-point ruler saved with each Load Plan. Approved scope, non-goals, anchoring and persistence rules, and stage gates: Section 4.1. | ✅ **COMPLETE / MERGED** (PR #125; refined by PR #129) |
| 2 | **Annotations: Text and Drawing** | Notes/labels and graphical marks/arrows independent of cargo geometry. Delivered as Callouts (V1A), Arrows (V1B.1) and Drawing (V1B.2), then unified with Measurements in PR #129. | ✅ **COMPLETE / MERGED** (PRs #126–#129) |
| 3 | **PDF Construction / Interactive Export Preview** | Clicking **Export PDF** opens a document-construction screen showing the proposed PDF. Users can modify the presentation/layout and content before selecting the final **Export PDF** action. Specify available editing, page reordering/layout, accurate print preview, templates/persistence, billing gates, and export safety in its product contract. Do not mutate cargo data by editing the document. | **PLANNED — contract not defined; not started.** Its order relative to Folder Enhancement V1 is not recorded here (owner decision) |

**Removed from roadmap:** Zoom to Area / Magnifying Glass. Do not implement or propose it as part of Zoom Controls or the Measurement Tool.

**Owner sequencing:** Measurement, then Annotations (Text and Drawing) — both complete — then PDF Construction. Each phase requires its own scoped acceptance and release checkpoint. Do not bundle these into a single implementation branch.

**Held work:** C5 AutoPack quality and related follow-ups are **PAUSED** due to unresolved load realism/transport-quality concerns. C6 reporting is **DEFERRED**. The Claude visual (`feat/cargo-visual-v5-claude`, no commits beyond `main`) and Codex visual (`feat/cargo-visual-v4-codex`, one commit not on `main`) checkouts are visual R&D, not merged product features; no changes to them, or to any separate stabilization worktree, are authorized.

### 4.1 Measurement Tool V1 — Approved Contract

**Status:** 🔒 Locked 2026-10-17 (owner-approved, including Stage 0 and the derived rules below). **Revised 2026-10-17 by the owner after visual review** (decisions 1, 3 and 4, the Interaction, Management and Presentation bullets, derived rule 3 and the non-goals); those revisions and their implementation were **visually approved by the owner on 2026-10-18**, and the same day the owner made Escape a one-press exit from the mode. Status: **MERGED — PR #125 (merge `036490a`, 2026-10-20; Quality Gate passed), later refined by PR #129.** The pre-merge history below is retained as implementation evidence. Two independent source audits followed. The first (2 P1 and 6 P2 findings: ambiguous import IDs, truck configuration, cargo surfaces, numeric limits, export preflight, cargo-pose gestures, provisional poses, thumbnail retry) was remediated before publication. The second led to an owner-directed root-cause correctness pass (2026-10-18) that strengthened three contracts below and closed the remaining gaps: **cargo instance IDs are unique within a Load Plan** (an owner-approved strengthening of the data contract that supersedes the earlier `EXPORT-C-LP-3` expectation that Load Plan import could accept duplicate source IDs because it regenerates them); **truck-shell anchors are judged against the effective usable zones and are Valid only when the original geometry is proven**; and **cylinder/drum anchors are validated against the real faceted 24-sided mesh**. A real held-case integration test and an end-to-end Screenshot/PDF/thumbnail acceptance test (`EXPORT-M`) were added. A third audit then found two correctness defects, both corrected at their root: **truck-shell points could be created on a surface the Editor does not draw** (the bounding box of the usable zones was treated as proof that a wall exists, so a point in the Front Overhang cab void was accepted as a front-wall point), and **normalization canonicalized a cargo ID without carrying its measurement anchors** (a valid backup lost the relationship). Measurable truck faces are now the exposed physical faces the Editor draws, one model shared by picking, anchor creation, resolution and validity and pinned against the real scene by a parity test; and one identity policy (the trimmed ID) maps every anchor with its cargo, idempotently. At the time of writing, independent re-verification and the GitHub Quality Gate were pending; PR #125 has since been merged with a passing Quality Gate. Merge to `main` is not by itself a production release approval. Specs: `tests/audit/measurement-tool-core.spec.mjs`, `measurement-tool-lifecycle.spec.mjs` (Node lane), `measurement-tool-interaction.spec.mjs` and the `P2-8`/`EXPORT-M` cases of `preview-identity-context.spec.mjs` (Chromium lane); `EXPORT-C-LP-3` in `export-integrity-c.spec.mjs` carries the revised import contract. Branch `feat/editor-measurement-tool-v1`; baseline `c28fca550d827b67d855832ea913a57cf8423674`. Agent-facing summary: `AGENTS.md` (Measurement Tool V1 Invariants).

**Nature:** An illustrative, informational point-to-point ruler. Measurements are planning references — not certified measurements, minimum-clearance results, or safety/compliance findings. It is not a placement, load-optimization or AutoPack feature, and it never changes handling rules, collision, cargo physics, assessment, Space Utilization or the existing PDF. Keep the user-facing experience simple.

| # | Owner decision (locked) |
|---|---|
| 1 | ~~Box-shaped cargo only.~~ **Revised 2026-10-17 (owner, after visual review):** a point can be placed on **any cargo surface, any shape** (box, cylinder, drum). The picked point is stored in the cargo's local frame, so it follows the cargo. |
| 2 | A **malformed** measurement structure rejects import/restore under the existing strict contracts. A structurally valid record that references deleted or missing cargo is **retained as Unresolved**. |
| 3 | Creating, renaming, deleting or **repositioning an endpoint of** a measurement updates the Load Plan's `lastEdited` and is an ordinary step of the shared Undo/Redo history *(since PR #129, 2026-11-01; V1 originally created no Undo entry)*. *(Endpoint repositioning added 2026-10-17 by the owner; visually approved 2026-10-18.)* |
| 4 | ~~Floor surfaces only.~~ **Revised 2026-10-17 (owner, after visual review):** a point can be placed **anywhere that is visible**: truck floor surfaces (main floor, Wheel Well tops, over-cab/raised deck), truck walls, ceiling and end planes, and the **ground anywhere, including outside the truck**. Floor points are revalidated by geometry; truck-shell points remember the truck and flag Needs Review if it changes; ground points never move. Nothing is ever relocated. |
| 5 | A previously valid measurement that becomes unresolvable **stays stored and visibly flagged**. Never silently delete, relocate or substitute an anchor. |
| 6 | **Maximum 100** saved measurements per Load Plan. |

**Behavior**

- *Control:* ruler button directly above Camera Views in the floating viewport group (order: Measurement, Camera Views, Zoom In, Zoom Out); active state uses the existing orange selected styling. Setting: Settings → Preferences → Editor Display → **Show Measurement Tool** (default On; existing Save changes; lightweight visibility route, no scene rebuild; independent of Show Camera/Zoom Controls). Hiding the button while the mode is active exits the mode and cancels an unfinished measurement; saved measurements are untouched.
- *Interaction:* first valid click = Point A; pointer move previews a dashed line and the distance; second valid click = Point B, saves exactly one measurement, releases the gesture and returns directly to Ready for Point A while the mode stays active (up to the 100 cap). In the mode, primary clicks place points instead of selecting or dragging cargo and never change the cargo selection or placement; orbit, pan, wheel and trackpad stay available; **one Escape press exits Measurement Mode completely** *(owner-specified 2026-10-18)*: an unfinished Point A or endpoint drag is dropped without writing, saved measurements stay, the panel and overlay hide exactly as when the ruler is clicked again, and the key is consumed so it never also deselects cargo, triggers another shortcut or closes a mobile drawer. A modal, dropdown, text field (such as a rename) or the load-status popover that owns Escape keeps it and closes first (the next Escape exits), and with the mode off Escape behaves as before. Focus is never sent to the ruler: it returns to the 3D viewport (with no focus frame after mouse use, and the normal ring after keyboard use). Clicking the ruler again also exits. Cargo keyboard shortcuts, including Delete, keep acting on the cargo selection as they always do (cargo edits stay undoable through cargo history); a pending point or drag whose cargo is deleted or changed is cancelled and writes nothing, and the stored measurement is kept and flagged, never deleted. A valid pick is acknowledged by the marker/line itself (no ripple); a click that hits nothing (only pure sky) says so with a notice and never invents depth. Press/release within 6px counts as a click, larger movement is an orbit/pan drag. A click on a drawn line or its label selects that measurement; a click near an endpoint places a point, so a new measurement can start at the corner of an existing one.
- *Record* (`pack.measurements`, owned by exactly one Load Plan, canonical inches): unique ID, type `point-to-point`, optional label, start anchor, end anchor, `createdAt`/`updatedAt`, `schemaVersion`. The distance is never stored: it is the 3D straight line between the currently resolved endpoints displayed in the user's Length unit as a single distance (no L/W/H breakdown), and never called clearance.
- *Cargo anchor:* cargo **instance ID** (never Case ID), the picked point in the cargo's local frame (any shape), geometry signature (shape + dimensions). A duplicated instance never inherits measurements; a replacement with the same Case never receives an anchor. *Floor anchor:* a supported truck floor point (main floor, Wheel Well top, deck), revalidated by geometry. *Space anchor:* a fixed point on the truck wall/ceiling/end plane (remembers the truck) or on the ground or anywhere else (never moves). None of these move with cargo.
- *Validity (derived, never stored):* **Valid** = both anchors resolve. **Needs Review** = a referenced Case's shape/dimensions or the truck geometry changed so the reference is uncertain. **Unresolved** = cargo instance or surface gone, or record unreconstructable; shows an explanatory indicator, never a fabricated number. Validity re-derives automatically, so undoing a cargo deletion or restoring original dimensions returns a measurement to Valid.
- *Management:* create several, rename, see status, delete individually (one click, no confirm step; undoable through the shared Editor history since PR #129). **Endpoint repositioning** *(owner-approved 2026-10-17, visually approved 2026-10-18):* select a measurement (its line, its label or its list row) and drag either line-style grip onto any supported surface; the anchor kind may change and cargo anchors stay cargo-local. The drag shows a faint ghost of the original and the live distance. Release on a valid surface writes one measurement edit (one shared-history step; `lastEdited` updated). Escape (which also leaves the mode), pointer cancel, a drop on nothing, a blocking operation or leaving the Load Plan restores the original and writes nothing. Cargo is never moved, rotated, staged or selected by it. Measurement edits use the shared Undo/Redo history (PR #129); V1 originally had none. Editing or deleting cargo never deletes a measurement.
- *Presentation* *(visually approved 2026-10-18)*: an architectural dimension-line style: thin neutral lines with short perpendicular end ticks over a soft surface-colour underlay and a compact one-distance label (a user-given name is added only while that measurement is selected); brand orange only for the selected or actively edited measurement (grips, preview line, label border). No rings, ripples or glow. The list is a compact, collapsible panel (heading, count, one row per measurement with its distance, rename and delete); guidance text appears only when relevant. The panel can be dragged by its header, whose 2×3 dot grip matches the AutoPack Results grip and shows both expanded and collapsed; it stays inside the viewport and its position is a per-session view convenience, not saved with the Load Plan *(owner-requested 2026-10-17, visually approved 2026-10-18)*.
- *Visibility* *(owner amendment 2026-10-20; shipped)*: saved measurements are no longer tied to the active mode. A **Valid** measurement stays drawn while the ruler is inactive (view-only: no grips, draft points or hover marker; no pointer capture, keyboard or focus ownership, writes or history entries), and it keeps following cargo moves, orbit, zoom, projection changes and resize. Needs Review and Unresolved are never drawn. Stacking: saved lines and labels are drawn beneath the callout layer (pins, expanded cards and the editor), so no line or label ever crosses the content of a card; they stay fully readable outside the cards. Only while Measurement Mode owns the scene are its lines, labels and grips lifted above the then view-only callouts, so endpoint editing is never covered. Only one tool owns scene-editing gestures: while Measurement Mode (creation) is active the Annotations layer stays drawn but takes no input. **Saved-record editing is separate from creation** *(owner amendment 2026-10-31; shipped in PR #129)*: with creation off, with the manager closed or open, a plain click on a saved line or its label selects that measurement (a click selects, a drag starting on a line stays the camera or cargo drag it was, and a click on an Arrow or cargo under the same point goes to the nearer saved line first); the selected measurement shows its grips and either grip drags onto any supported surface through the same endpoint writer, anchor checks and length calculation as before (one measurement-only edit; an unchanged, rejected, Escape-cancelled or **off-canvas-released** drag writes nothing and keeps Redo; a grip press that does not move does nothing and never starts Point A). Selection adds no history entry. Only one thing is selected at a time: selecting a measurement clears any cargo or annotation selection (so Delete never reaches cargo through it), and selecting cargo or an annotation clears the measurement selection. Escape, an empty click or selecting something else deselects it; closing the manager ends creation but keeps a valid selection and its editable grips. A measurement is still deleted only from its manager row (no keyboard Delete). **Whole-measurement movement** *(same amendment; shipped in PR #129)*: with creation off, dragging the **body** (line or label) of the SELECTED measurement carries both endpoints by one in-plane offset, only when both sit on ONE physical surface (the same cargo face, or the same floor, ground, wall or ceiling plane of the same truck evidence; a shared plane direction alone is not enough), and only if the moved pair still resolves Valid on the patch that held it. The length, label, identity and anchor kinds are preserved; nothing is detached, converted or stretched. Two cargo items, cargo and ground, a floor and the ground, or two points on a shared cargo edge refuse the whole move (the endpoints stay individually movable by their grips); an invalid, Escape-cancelled or off-canvas-released drag writes nothing and keeps Redo; one valid move is one measurement-only history step. A selected grip wins over the body, and a drag that starts on an unselected line stays the camera or cargo drag. The same rule moves the body of a SELECTED Arrow (annotation-only write). Numeric length editing is not part of this. Known limitations: legacy face-encoded cargo anchors refuse the whole move (their endpoints stay individually editable), and body dragging was verified with a mouse only (touch is untested). Nothing listens while no measurement is selected and creation is off. All saved graphics, view-only or active, are hidden while AutoPack, Unpack or Truck Change runs and while an unapplied transient layout is displayed; they are redrawn from committed records afterwards, never on temporary solver poses. **Show Measurement Tool** Off hides the saved lines as well as the button. Screenshot, PDF, thumbnail and AutoPack Results preview exclusions are unchanged (G5).

**Anchoring and validity rules**

| Topic | Rule |
|---|---|
| Cargo-local anchoring | Stored as a point in the cargo's local frame (any shape; the earlier box face + normalized position encoding is still read); no world coordinate is stored for cargo anchors. Resolved by a pure, THREE-free resolver from committed pose and Case dimensions: `transform.position`, right-angle `rotation` (Euler XYZ, `core/oriented-dims.js`), ignoring `transform.scale` and applying the same minimum-height floor as the scene's `applyTransform`. Parity with THREE is pinned across all right-angle rotations. Follows move, rotate, flip, stage/unstage and the committed AutoPack pose. A cargo anchor is valid only if its local point lies on the saved physical surface, within a small tolerance (0.01 in plus 1e-6 of the largest dimension, for the 4-decimal rounding of the stored point and 32-bit mesh precision): the box faces, or — for a cylinder or drum — the **faceted** surface the Editor actually renders, a prism over the regular 24-gon of `CARGO_CYLINDER_SEGMENTS` sides (circumradius half of the smaller of width and height, vertices on the width/height axes, flat end caps; the geometry factory imports the same constant, so the two cannot drift). The check is the exact Euclidean distance to that surface, never a circle or radial band: a point on the circle through the vertices but outside a flat facet is off the mesh. It is pinned against the real meshes by a nearest-triangle oracle and by random raycasts on rotated cargo. A point inside, away from or far outside the cargo is malformed: import rejects it, stored data is kept as an unreadable recovery record, and it never yields Valid. |
| Committed vs. transient | Saved data and creation use committed poses only. While a drag, gizmo hold, animation or AutoPack Results preview is shown, the overlay follows the pose the scene displays (it never floats) but nothing transient is persisted. |
| Case change | Geometry-signature mismatch (shape or L/W/H) → Needs Review. Nothing is rewritten, rescaled or re-anchored. |
| Space change | Floor anchors are revalidated by geometry against the current truck: same supported floor surface still present → Valid; surface present but its governing truck geometry changed so the reference is uncertain → Needs Review; surface gone → Unresolved. Never moved to another surface. Truck wall/ceiling/end points are Valid only while their truck geometry is **proven** unchanged: a new point remembers the truck's effective usable zones (the authoritative geometry, which already reflects every `shapeConfig` value — Front Overhang length and deck height, Wheel Well size) and is Valid only while the current zones are the same set of boxes and the point is still on a wall, end plane or ceiling **face that physically exists** on the current truck (see *Truck shell faces* below); otherwise Needs Review. The comparison is of effective geometry, not of configuration: reordering, an explicit default, an unused key or a Front Overhang of length 0 on a standard truck are the same truck. A record saved before zones were remembered is retained unchanged (never rewritten with invented geometry) and is Valid only where its dimensions alone prove the original geometry — a standard rectangular truck; an older Front Overhang or Wheel Well record, or any record when the current zones are unavailable, is Needs Review (`truck-unverified`), never Valid. Ground and free points are always Valid. |
| Truck shell faces | The measurable walls, end planes and ceiling are the **exposed outer faces of the solid shell volumes**, exactly as the Editor draws them (`core/measurements.js` `buildTruckShellVolumes` / `buildTruckShellFaces`; `PackLibrary.getMeasurementShellFaces`). The shell volumes are the usable zones (a standard truck is one box; a Front Overhang is the main box plus the raised deck, the cab void below the deck being empty) or, for Wheel Wells, the full outer box from the dimensions (the wells are guide volumes inside it). A face covered by a neighbouring volume's opposite face is an internal boundary and is not a surface; an end cap where two volumes connect is not drawn and is not a surface (the main box's front, including below the deck, and the deck's rear). Regions with no volume have no face whatever the outer bounding box says: `(700, 10, 0)` on a Front Overhang truck is in the cab void and cannot be picked, built, imported or found Valid. The floor is separate: the upward faces of the usable zones (`main`, `deck`, `well-top`) stay measurable. Picking keeps the transparent-truck convention: of the faces the ray leaves the truck through, the farthest; a ray that crosses no face falls through to the floor or the ground and the anchor says which real surface it is. A record saved on a surface that does not exist (by the previous build) is rejected on import and kept verbatim as an unreadable recovery record when stored: never deleted, relocated, clamped or reconstructed. |
| Deleted / recovered cargo | Deleting an instance leaves its measurements stored and Unresolved. Undo restores the same instance ID and the anchor resolves again. Duplicate and import use an explicit old→new instance-ID map — never a guessed match. An ID that more than one cargo item carries in a stored plan (damaged data is kept, never repaired) leaves the anchors on it Unresolved (`cargo-ambiguous`) and cannot be picked on; it resolves again once the IDs are unique. |

**Acceptance gates — the six audit risk areas.** Each must be handled explicitly and pinned by a test. Passing `measurements` through a generic object spread is **not** sufficient for persistence or validation.

| Gate | Required handling | Code surfaces |
|---|---|---|
| G1 Normalization / persistence | `normalizePack` is an explicit field whitelist: add `measurements`. Older plans normalize to `[]`; ≤100 enforced. **Non-destructive local recovery:** a malformed stored record must never be silently dropped and then overwritten by autosave. Local load never throws and never produces geometry from it; the original data is preserved, a recovery condition is surfaced, and destructive persistence of that Load Plan's measurements is prevented until the condition is resolved. Exact mechanism: Stage 1 design. | `core/normalizer.js` `normalizePack`/`normalizeAppData`; `PackLibrary.update` |
| G2 Undo/Redo | History snapshots all of `packLibrary`; measurements must be carried across Undo/Redo from the current state per Load Plan (as `editorView` is), written with `skipHistory`, and added to the `lastEdited` keys. Cargo Undo/Redo must neither erase nor resurrect measurements, and must not roll back `lastEdited` solely because measurement edits are excluded from cargo history (Undo/Redo is otherwise unchanged). Exact mechanism: Stage 2 design. **Superseded by PR #129 (2026-11-01):** measurement and annotation commits are ordinary entries of the single `StateStore` history. Undo/Redo restores the whole recorded Pack, including the exact historical `lastEdited` (a Pack that never had one is restored without one); only the Editor camera (`editorView`) stays current, and derived preview updates are written into the current entry without creating an Undo step. | `core/state-store.js` `restoreCargoHistory`; `PackLibrary.update` |
| G3 Duplicate / import remap | `duplicate()` and `planPackImport()` regenerate instance IDs: both must apply one shared old→new map to cargo anchors. Unmapped anchors stay Unresolved. Instance IDs must be preserved by AutoPack Apply, Unpack, Truck Change and Add/Qty staging — assert in tests. **Cargo instance IDs are unique within a Load Plan** (owner-approved strengthening, second audit): every place that creates instances mints through one minter that never reissues an ID used anywhere in the workspace; import (single, batch — per Load Plan, and the export self-preflight) rejects a plan in which any ID is used by more than one item, **whether or not any measurement references it** (IDs are compared trimmed — the one identity policy, `instanceIdentityKey`), before any ID is generated or any state changes; duplication builds its old→new map only from unambiguous IDs, so an anchor is never guessed onto one of several items. **Normalization preserves the relationship:** `normalizePack` stores an unambiguous cargo ID in its canonical (trimmed) form and carries the measurement anchors through the same explicit map (`canonicalizeInstanceIds`, `remapMeasurementInstanceIds`), so a restore never orphans a measurement; ambiguity is judged on the **complete source list, before any instance is discarded**: an ID shared by several surviving instances is not canonicalized (each holder keeps its source string, distinct strings never collapse into one identity) and its anchors stay Unresolved; an ID the source gave to several items of which only one survives normalization (the others had no Case reference) is **contested** — the survivor is stored canonically but never inherits the reference: every measurement with an anchor on it is withheld, whole and verbatim, into the existing unreadable recovery record (Unresolved, the original kept, nothing re-targeted or guessed), so discarding an instance can never turn an ambiguous reference into a Valid one on another cargo; a dangling anchor (no surviving holder) is left as it is; normalizing again changes nothing. Resolution everywhere (stored plans, duplicate, import, the overlay) finds cargo by the same identity key. Cargo IDs are the only persisted instance-ID references (`groupId` names groups, never cargo). | `services/pack-library.js` `duplicate`, `planPackImport`; `editor-screen.js` `buildAppliedAutoPackCases` |
| G4 Export / backup / restore | Single and batch Load Plan export/import, Workspace Backup and Active Workspace Backup must all carry measurements via explicit projection, strict validation before normalization, and atomic apply. Malformed structure (including >100, duplicate IDs within a plan) rejects the whole import/restore. Single and batch Load Plan export self-preflight runs the same rule on the exact serialized file, so an export is never one the importer would refuse (an over-cap collection or a repeated cargo ID fails the export; nothing is truncated, repaired or rewritten in the saved plan). Workspace Backup and Active Workspace Backup restore share `validateWorkspaceGraph`, which already rejects a repeated instance ID anywhere in the workspace (trimmed) before anything is applied. A cargo reference to a missing instance is **accepted** (Unresolved) — the dangling-`caseId` rejection rule must not be reused for it. | `core/import-schema.js` `projectPortablePack`, `projectPortableWorkspacePack`, `validateWorkspaceGraph`; `services/import-export.js` `validateWorkspacePack`, `parsePackImportJSON`, `parsePackBatchImportJSON` |
| G5 Capture exclusion | Lines, handles and labels are an SVG/DOM layer above the canvas, so no canvas capture can include them: Screenshot, PDF views, pack preview/thumbnail and AutoPack Results preview capture never show measurement graphics. Existing PDF unchanged. | `index.html` `#editor-measure-labels`; `editor/measurement-tool.js` |
| G6 Pointer / keyboard ownership | One mode owner gates `onDown`/`onMove`/`onUp`/`onDblClick`/`onKeyDown`; ordinary clicks never `stopPropagation` (OrbitControls shares the canvas); the only claimed press is one on the selected measurement's grip (capture phase, so neither OrbitControls nor the Editor sees it; released on pointer up or cancel); 6px click threshold; one Escape exits the mode through `exit()` (dropping a drag or pending point without writing) in the capture phase, consuming the key before `deselectAll` and the drawer-close handler, and yielding to modal, dropdown, text-field and popover owners; guard double-click zero-length and a pending point or drag under Undo/Delete (Undo cancels only the gesture; Delete acts on the cargo selection and `sync()` cancels a gesture that lost its cargo; a gesture is also dropped when the committed pose of cargo it refers to changes — a nudge or rotation, never a camera move — and cargo picks are refused while the Editor owns a provisional pose: a live drag, gizmo stroke or held case — pinned with a real gizmo stroke through the production `hasProvisionalPose` signal, not a stub); Cargo `raycastFirst` is not reused as-is (no face data, cargo only). | `screens/editor-screen.js` interaction handlers; `ui/keyboard-manager.js` |

**Derived rules — OWNER APPROVED 2026-10-17** (follow from decisions 2, 5 and 6 and the "never fabricate" principle):

1. Only a Valid measurement shows a numeric distance; Needs Review and Unresolved show an explanatory indicator instead. Valid always has a finite distance: stored anchors are bounded to ±1,000,000 in, and the resolved points, their differences and the distance are checked (otherwise Unresolved: the distance could not be calculated).
2. More than 100 measurements in an import/restore is malformed and rejects the import; nothing is truncated, and the 100 cap blocks creation in the UI.
3. Creating, renaming, deleting and repositioning measurements is disabled while an Editor operation that changes the plan is busy (AutoPack, Unpack, Truck Change, Truck Change preview) or any transient preview (including AutoPack Results preview) is displayed, and the message names the actual cause. *(Amended 2026-10-20: the saved lines are also hidden while that holds — see Visibility — instead of staying visible and read-only.)* A background thumbnail capture only reads pixels back: it is **not** such an operation and never blocks a measurement or cancels an unfinished one (found and fixed in the 2026-10-17 correction pass: it used to cancel Point A with a misleading "operation is running" message). A measurement write replaces the Pack object, which aborts a capture that is mid-flight: the Editor re-binds its preview authority for that edit (as for `pack-preview`/`pack-view`, so Screenshot, PDF and manual capture keep working) and the app re-requests the freshness check, which retries only when the preview is still missing or stale.
4. A cargo instance whose Case definition is missing is Unresolved (geometry cannot be verified).
5. Measurement IDs are unique within a Load Plan only; duplicate/import may regenerate them.

**Non-goals:** Text Annotations, Drawing, PDF Construction, AutoPack changes, clearance/gap analysis or any safety or compliance claim, any handles beyond the two line-style endpoint grips, measurement Undo/Redo *(a V1 non-goal; added later by PR #129 as part of the shared history, see G2)*, snapping beyond the picked surface point, database or backend changes, and any change to existing PDF/image exports (data is stored only so the future PDF Construction milestone can consume it).

**Known limitations (V1, stated so they are not mistaken for guarantees):**
- Truck geometry is compared as the list of usable-zone boxes. Two configurations that tile the same volume with a different decomposition (for example Wheel Wells of zero size versus a standard truck) are treated as different: Needs Review, never a falsely Valid point.
- Wheel Wells: the Editor draws the full outer box and shows the wells as guide volumes, so the wall behind a wheel well body is measurable (it is drawn) while the wells' own inner faces are not. The seam where a Front Overhang deck joins the main box has no drawn wall, so the main box's front below the deck is not measurable either: the cab or bulkhead there is not modelled.
- A rectangle-subtraction face model is only as complete as the shapes the Editor has: a new truck shape needs its shell volumes added to `buildTruckShellVolumes`, and the scene parity test (`P1-3 parity`) fails until the Editor and the model agree.
- Records saved before the effective zones were remembered cannot prove an older Front Overhang or Wheel Well truck and show Needs Review until the owner deletes and recreates them. No automatic migration invents the missing geometry.
- A stored Load Plan that already contains a repeated cargo ID is kept as it is (Unresolved anchors, picks refused with a message); V1 offers no repair UI. Importing or restoring such a plan is refused.
- Measurements are informational: the surface tolerance (0.01 in + 1e-6 of the largest dimension) and the face-level geometry are not a certified metrology claim.
- *(Pre-merge note, kept as history.)* When this was written, the GitHub Quality Gate and independent re-verification had not run for this correctness pass. The Quality Gate has since passed on PR #125; whether further independent re-verification was performed is not recorded here.

**Implementation stages** (each requires explicit owner release; focused local checks per stage; owner visual acceptance and one PR Quality Gate at closeout):

| Stage | Scope | Exit gate |
|---|---|---|
| 0 | This documentation checkpoint | ✅ Owner-approved 2026-10-17 (documentation commit on this branch) |
| 1 | Data foundation, no UI: pure measurement module (schema, normalize/validate, resolver, validity, distance); `normalizePack` field; cap; G1 non-destructive local recovery | Legacy plan → `[]`; malformed/over-cap cases; malformed stored record is preserved, surfaced and not overwritten by autosave; resolver parity across all right-angle rotations; scale and min-height parity; signature and floor predicate; typecheck |
| 2 | Lifecycle plumbing, no UI: G2 history carry-over, `skipHistory` writes and `lastEdited` (no rollback by Undo/Redo) *(superseded by PR #129: shared history, exact `lastEdited` restoration)*; G3 remap; G4 projection and validation | Tests modelled on `pack-camera-view-isolation.spec.mjs`; Undo/Redo keeps measurements and `lastEdited`; ID-set preservation asserted; round-trip for every import/export path including malformed rejection |
| 3 | Setting and control shell: `showMeasurementTool` through defaults, normalizer, Settings and the visibility route; ruler button and mode flag, no tool behavior | Existing camera/zoom control tests stay green; lightweight-route test; hide-while-active exits mode |
| 4 | Interaction (G6): mode owner, picking on any visible surface (cargo of any shape, truck floor/walls/ceiling, ground), pending point, click feedback, busy/preview gating, Escape exit and ownership | Existing selection, drag, keyboard and modal-ownership tests stay green; new ownership tests; localhost QA |
| 5 | Presentation: overlay pass and labels, list (rename/delete/status), G5 capture exclusion, disposal; UX correction pass 2026-10-17 (restrained dimension lines, one distance, endpoint grips and repositioning, compact collapsible list; visually approved 2026-10-18) | Exclusion tests for screenshot/PDF/thumbnail/preview; both projections and themes; no resource growth across repeated toggles |
| 6 | Closeout: owner visual acceptance, one PR Quality Gate, Section 3 row | ✅ Done — owner acceptance; gate green; merged in PR #125 |

**Open technical items (settle in Stage 1; none blocks the contract):** the mechanism for the G1 non-destructive local-recovery invariant (preserve the original record, surface the condition, block destructive autosave until resolved) and, in Stage 2, for the G2 `lastEdited` invariant; the floor-surface source of truth (the editor's `TrailerGeometry` duplicates `PackLibrary` zone formulas — consume one and pin parity); a measurement-specific length formatter (`formatLength` rounds inches to whole numbers); confirmation that Truck Change preserves instance IDs (not traced in the audit).

---

## 5. Candidate Workstreams (Unapproved)

These are unapproved candidates outside the owner-approved sequence in Section 4. No candidate is an active implementation merely because it appears here. Items remain subject to individual product decisions and owner authorization; the sequence in Section 4 takes precedence.

1a. **Simultaneous Measurement and Annotation graphics, and Annotations beside AutoPack Results (owner-approved 2026-10-20; shipped; the Measurement side is recorded in Section 4.1 *Visibility*)**
   - Measurement and Annotation graphics are on screen together. The Measurements and Annotations managers are independent and may be open together (PR #129); opening Measurements manages records and only New measurement arms creation. Only one tool owns scene-editing gestures at a time: picking an existing record ends a pending creation tool, Drawing and Callout editing disarm incompatible tools, and the layer that does not own the scene takes no pointer, keyboard or focus input. Saved Valid measurements are drawn by a view-only pass of the Measurement Tool on its existing SVG layer; Annotations keep their Show All / Selected / Off control. No change to Measurement data, anchors or persistence.
   - Annotations are not paused by AutoPack Results. They are hidden and not editable only while AutoPack, Unpack or Truck Change runs and while an unapplied transient layout is displayed (the existing operation and transient-preview signals); on the committed, applied layout they stay visible and editable with Results expanded, minimized or closed. Editing never applies a result, switches the viewed option, ends a preview, closes or minimizes Results, changes cargo, or makes Results stale.
   - Placement: the visible Results card (including after it is dragged) and its reopen button are obstacles for the annotation editor, cards and the Annotations panel. The existing placement system keeps Save, Cancel and the inputs clear of them, re-fits on resize and when Results moves, and falls back to the compact bottom sheet above Results when space runs out. The desktop Annotations panel keeps clear of the Results card wherever either was dragged (card below it, over its lower rows, over its header, minimized to its small chip, or after a viewport resize): when the card sits below, the panel stays docked and is limited to the stretch above it, so its list scrolls instead of running under the card; otherwise it moves to the nearest clear spot inside the canvas. This is display-only: the owner's dragged panel position is never rewritten, the panel returns exactly to it when Results moves away, and dragging the panel starts from where it is shown. The callout editor is never left under the panel (the panel is drawn above it): the editor first keeps clear of the panel, relaxing its marker clearance before anything else; when no clear spot exists at a mid-size desktop window (for example 1100×620 with both sidebars open) it keeps its preferred spot, still clear of Results, the status button and the viewport controls, and the panel yields in place (`is-behind-editor`: not painted and not clickable, same box) until the editor closes or the overlap ends, then returns exactly where it was. The same applies to an editor the owner dragged over the panel and to a panel dropped over the open editor. Both panels stay draggable; AutoPack Results logic, state and cargo are untouched. Saved measurement lines and labels are drawn beneath callout cards and the editor (see Section 4.1 *Visibility*), so they never cross card content or its fields.

1. **Professional 3D Editor Visual Foundation**
   - Cargo box presentation, edges/lines, labels, materials; selection/hover clarity, contact cues; truck visual hierarchy
   - Do not rewrite renderer architecture
   - **Reverted:** PRs #29, #31, and #33 were rejected and reverted in PR #34 (`6c305fc`); no restart without explicit owner approval

2. **PDF / Image Visualization Polish**
   - Optional future image/report styling beyond the already planned **PDF Construction / Interactive Export Preview** workflow in Section 4
   - Do not start a competing PDF export redesign before that product contract is settled

3. **Small 3D Visual Asset Spike (GLB)**
   - Test representative GLB assets before a full library: simple pallet, medium appliance, complex vehicle
   - Test at 1 / 25 / 100 / 300 counts

4. **Folder Sidebar Implementation**
   - Unapproved. Folder Foundation Stage 1 is complete (PR #132; Section 3). Folder Enhancement V1 (Section 4) is where the next Folder product contract is reviewed; nothing here is approved by it.

5. **Load Plans / Stops / Unload Sequence**
   - Define sequencing/data model before Auto-Pack v2

6. **Auto-Pack v2 / Strategy Revisit**
   - Builds on a finalized load/unload model; remains held with C5

7. **Asset Manager + Curated Model Library**

8. **Measured Renderer Optimization**
   - Only after GLBs and richer visual scenes are available for realistic measurements

9. **Expanded 3D World / Environment Work**
   - Includes future 3D realism work, subject to explicit design approval

10. **Email Delivery / Sharing**

11. **Broader Shortcut / UI Consolidation**

12. **Settings Cleanup**

13. **Beta / Launch Hardening**
    - Observability, code/security audit, deployment/server review and production readiness before broad beta

14. **Real 3D Heatmap + Legend — LOW PRIORITY / NEAR LAST**
    - Optional visual enhancement, not required for core logistics planning
    - Postpone until **after 3D realism and richer scene presentation**
    - If later approved, build on the Generic Space Utilization Engine; capacity analysis only, not safety/compliance scoring

**Completed, not a candidate:** Camera / View System (PRs #120–#121), optional Zoom Controls (PR #122), Measurement Tool V1 and Annotations V1 (PRs #125–#129) and Folder Foundation Stage 1 (PR #132).

---

## 5.5. Phase C — Editor Authority & Workflow Continuity (C5 Cycle)

**Status:** Locked product contract; C5A merged (PR #111). PR #117 merged scoped C5 stabilization changes. **C5 further implementation is PAUSED by explicit owner decision.** The prior C5B review state below is historical only; it does not authorize resumption.

### Phase C Milestones

| Phase | Title | Status | Approved Order | Key Outcomes |
|---|---|---|---|---|
| C1 | Canonical Source Semantics | ✅ COMPLETE / MERGED | 1 | Canonical mass, orientation and physical-input primitives |
| C2 | Shared Measurements + Assessment Core | ✅ COMPLETE / MERGED | 2 | Support geometry, load transfer and shared assessment/eligibility semantics |
| C3 | Mass + Orientation Runtime Cutover | ✅ COMPLETE / MERGED | 3 | Runtime adoption of canonical mass/orientation semantics |
| C4 | Assessment + Lifecycle Cutover | ✅ COMPLETE / MERGED | 4 | Read-only assessment and removal of hidden lifecycle repair |
| C5-0 | Editor Authority Contract | 🔒 LOCKED | — | Documentation checkpoint (this update) |
| C5A | Normal AutoPack Assessment + Results/Apply Authority | ✅ COMPLETE / MERGED (PR #111) | 5 | Candidate assessment, Balanced preference, transient Results authority and Apply |
| C5B | Staging Preservation + Inspector Coherence | ⏸️ PAUSED / HISTORICAL REVIEW STATE | 6 | Previous local work/review notes are not current implementation authorization; preserve existing branches/worktrees |
| C5M | Manual Editor Authority Hardening | ⏸️ PAUSED | 7 | Manual drag/move/rotate/stage/unstage and warning-vs-hard-rule boundary |
| C5T | Truck Change Workflow Continuity | ⏸️ PAUSED | 8 | Unresolved cargo preservation/fallback-to-staging without workflow blockage |
| C5C | Max Capacity Policy | ⏸️ PAUSED | 9 | Preserve relaxed Max handling with profile-aware assessment and Apply |
| C5D | Packing Quality + Wheel-Well Search | ⏸️ PAUSED | 10 | Avoidable-gap recovery, leftover-fit search and Wheel-Well seam competition |
| C5E | Bounded AutoPack Presentation | ⏸️ PAUSED | 11 | Adaptive bounded loading presentation without persistence authority |
| C6 | Reporting + Integrated Closure | 🔮 DEFERRED | 12 | Reporting, integrated validation and Phase C closure; not approved for current work |

**C5D recorded transport-realism finding:** Normal AutoPack can produce tall exposed stack faces without meaningful longitudinal blocking. Balanced optimizes packing/layout heuristics but does not establish truck-wide braking restraint or complete transport securement. C5D should investigate passive restraint and layout realism without claiming to certify tiedowns, friction, load bars or regulatory securement. This is recorded for future investigation; C5A introduces no transport-restraint solver behavior.

### C5-0 Product Contract (Locked)

See [AutoPack Engine Contract — Editor Authority and Automation Boundary](../engineering/autopack-engine-contract.md#editor-authority-and-automation-boundary) for the full contract.

**Core Principle:** Cargo Planner 3D is a manual load-planning workspace first. AutoPack is an assistant, not an override.

- Manual Editor is user-authoritative.
- AutoPack is assistant/recommendation.
- Hard physical geometry remains enforced for new manual placement.
- Handling/planning rules generally assess/warn rather than block manual editing.
- Manual VALID/INCOMPLETE/INVALID layouts may remain saved.
- Assessment does not grant/revoke editing permission.
- No silent repair.
- Missing definitions degrade physical certainty, not workflow availability.
- Untrusted unresolved cargo falls back to staging during geometry changes.
- Future load/unload sequence remains manually overridable.
- Automated solutions may be stricter than manual authoring.

### C5M Manual Editor Findings Registry

| ID | Finding | Status | Notes |
|---|---|---|---|
| M-01 | Manual drop may commit collision/occupied-space problems | RETAIN | Focused C5M verification required |
| M-02 | Staged cargo sometimes refuses an apparently valid truck-floor drop | RETAIN | User-observed; latest controlled QA did not reliably reproduce; do not rewrite drag architecture speculatively |
| M-03 | Manual action sometimes receives unrelated vertical-move messages | RETAIN | User-observed; latest controlled QA did not reproduce; investigate when reproducible |
| M-04 | AutoPack planning state must never become a permanent manual movement restriction | 🔒 LOCKED | Product invariant |
| M-05 | Handling rules should evaluate manual layouts, not generally block authoring | 🔒 LOCKED | Product decision |
| M-06 | Impossible physical geometry remains blocked | 🔒 LOCKED | Product decision |
| M-07 | Manual INVALID/INCOMPLETE layouts remain editable and saveable | 🔒 LOCKED | Product decision |

### Execution Notes

- C5A merged through PR #111 and scoped C5 stabilization merged through PR #117. Earlier C5B local-implementation notes are superseded by the owner's pause; do not resume from an old worktree or branch without renewed approval. Keep C5M and C5T separate.
- C5M owns manual drag/move/rotate/stage/unstage authority and handling rules warning behavior.
- C5T owns unresolved cargo preservation and fallback behavior.
- **No C5 implementation is currently authorized.** C5B/C5M/C5T/C5C/C5D/C5E require new explicit owner approval; C6 remains deferred.

---

## 6. Deferred / Future Work

Not approved branches. Not active work. Require focused audits and product decisions before implementation.

- Folder Stage 1 follow-ups (known limitations recorded in PR #132; none is a defect, none is approved): Folder Undo/Redo is intentionally narrow (any non-Folder state write ends the Folder run); damaged-graph recovery evidence is browser-local, capped at 5 copies and 1,000,000 serialized characters per workspace, has no in-app download or management interface, and repair fails safely with no in-app remedy once the cap is reached; one earlier F-02 browser timing failure has no recorded cause and was not reproduced. Review with Folder Enhancement V1 (Section 4).
- Next-generation billing hardening (workspace-to-Stripe identity, cross-table consistency, billing anomaly logging)
- Workspace Slug Phase 2 (friendly slugs, owner-editable, routing)
- Pack Publishing / Crew View / Share Links
- Server-backed packs/cases and conflict-safe sync
- Business Identity server-persistence uniqueness contract
- Workspace-level analytics and telemetry
- Platform-admin schema and audit records
- CoG / axle / crush / DOT weight-distribution (requires explicit safety contracts)
- Deployment: Cloudflare Pages, branch previews, staging, rollback policy
- Product decisions still open: consolidated billing, one Customer per workspace vs. shared, final commercial plans

---

## 7. Critical Architecture Invariants

### Billing

- Stripe is payment truth. `/billing-status` is application entitlement truth.
- Normalized `entitlementStatus` only — never overload raw `status`.
- Valid states: `active`, `trialing`, `trial_expired`, `included_in_plan`, `workspace_limit_reached`, `owner_subscription_required`, `billing_unavailable`.
- Owners only for checkout, portal, plan, and payment.
- Do not gate owner inheritance on `ownerUserId !== currentUserId`.

### Development / CI Cost Policy

- The fast Quality Gate runs automatically on PRs targeting `main` (lint, typecheck, Node lane, Chromium smoke set, build, audit, patch check); optional manual dispatch is available. The complete Chromium regression (`npm run test:regression`) is local and deliberate, never automatic. No automatic suite after merging/pushing to `main` (PR #123).
- During implementation, use directly affected focused tests, typecheck as appropriate, and diff/status inspection. Do not duplicate broad local and GitHub CI runs.
- Documentation-only updates require diff review and whitespace/status checks, not application test suites.

### AutoPack / Editor

- Use `src/core/operation-lifecycle.js` for all mutating editor operations.
- Large-load snap: `> 300` packed placements — performance guard, not final solution.
- Wheel Wells wider-than-shelf and Front Overhang C2 require explicit safety contracts before implementation.
- Final saved state must never depend on animation completion.
- Camera orbit/pan/zoom must remain usable during operations.

### Space Utilization

- **Capacity analysis only:** occupied %, remaining space, density visualization.
- Not safety scoring, not compliance scoring, not weight-distribution quality.
- Internal diagnostics must not become user-facing scores without a future explicit product decision.

### 3D Architecture

- Direct Three.js + WebGLRenderer, currently r185.1 via npm/Vite.
- No React/R3F rewrite. No WebGPU migration now.
- Future addons via `three/addons`.
- GLB architecture (when introduced): authoritative packing envelope is always separate from optional visual model. Visual model never becomes collision truth by default. Keep technical-box fallback.

### Backend / Persistence Direction

- Supabase remains the temporary development backend for identity, workspaces, and billing.
- Cases, Load Plans, and related business data remain browser-local during this development phase.
- NoCodeBackend (NCB) remains the preferred future migration target. A September 2026 investigation found NCB could be viable, but the migration is paused, not canceled, so product, domain, email, billing, settings, and workspace-behavior work can be completed first — see [NCB Migration Investigation — Paused](../archive/2026-09-ncb-migration-paused/README.md).
- No active backend migration branch exists. A future migration must repeat the provider and source audit against the application state at that time. This entry does not authorize migration implementation.

### Data and Identity

- Customer-facing object name: **Load Plan** (not "Pack").
- Internal architecture: `PackLibrary`, `pack`, `pack.id`, DOM ids, CSS classes, storage keys, route identifiers, JSON schema unchanged.
- Auto-Pack, Unpack, packed item, packing rules vocabulary preserved.
- "Cargo Planner 3D" is the provisional product name — not yet applied in UI. Final branding deferred to launch prep.

---

## 8. Technical Debt / Security Follow-ups

- `.claude/settings.local.json` — git-ignored, previously flagged as potentially containing credential-bearing commands. Do not print or modify during normal sessions. Dedicated security/credential cleanup required before broad beta.
- **Implemented locally, NOT merged — preserve:** `fix/stripe-fixture-persistent-subscription-guard` at `9671de3` (`fix(billing-fixtures): refuse to cancel Stripe subscriptions not proven fixture-owned`). It exists only in the local repository (no `origin` ref) and has no PR. Do not delete, rebase or push it without the owner; a review and merge decision is pending.
- Development retains legacy schema differences (cases/packs, policy/function, billing ID). Separate audit required.
- Workspace Slug Phase 2 (friendly slugs) remains required product work.
- `docs/product/PROJECT_TREE.md` is a point-in-time snapshot (2026-07-16) — no active authority.
- Graphify: run `graphify update .` after significant code changes. Do not hardcode node/edge counts in permanent instructions.

### P2 — Legacy / Dead Code: COMPLETE (2026-10)

Confirmed dead ordinary code is removed, test-pinned dead code is removed, the duplicate legacy Settings screen is retired safely, broken unused tooling is removed, and materially stale active contracts are corrected. The registry below records what remains on purpose so future audits do not reopen it. Provider/persistence and rendering cleanup are **not** complete; they are assigned to their own phases.

**Intentional KEEP (not dead code):**

| Item | Reason |
|---|---|
| `getCurrentAuthKey`, `debugAuthSnapshot`, `getMyMembership`, `getCurrentOrganization`, and the documented test/admin exports published via `window.__TP3D_SUPABASE_API` / `__TP3D_SUPABASE` / `SupabaseClient` | Public/debug/backward-compat surface; no in-repo caller is not proof of no consumer |
| `src/packing-core/{index,domain,space-model,orientation}.js` | Intentional, tested Phase-5 architectural boundary; do not delete as orphans |
| `src/core/utils.js` | Still has live production and test consumers |
| `vendor/three.module.js` (r160) | Intentional documented test fixture; production Three is npm r185 (`src/bootstrap/three-runtime.js`) |
| Browser harness `esm.sh` / `skypack` abort route (`tests/behavioral/app-js-browser-harness.mjs`) | Guards against accidental reintroduction of CDN Three loading |
| Storage legacy v1 migration (`src/core/storage.js`) | Backward compatibility for old persisted data |
| Retired HTTP 410 Edge Function tombstones (`supabase/functions/*`) | Provider/external endpoint compatibility; frontend call-graph absence does not prove no external caller |
| Constant-false auth/provider flags (e.g. `AUTH_GUARD_*_ENABLED`) | Explicit dormant provider gates; provider/persistence scope |
| Persisted `preferences.spaceUtilization` compatibility fields | Old backups/imported preferences may still carry them |

**Explicit DEFER (not dead-code cleanup):**

| Item | Owner |
|---|---|
| AccountOverlay module/lifecycle (the old opener is removed; auth-transition `close()` / `handleAuthChange` wiring remains) | Future auth/provider cleanup |
| `getSessionRawSingleFlight` and related auth internal state / string probes | Provider/persistence cleanup |
| Legacy `BillingService` compatibility helper object (`src/data/services/billing.service.js`) | Billing/provider cleanup |
| `readJson` / `writeJson` / `removeKey` (`src/core/storage.js`; may have no ordinary callers now) | Provider/persistence/recovery cleanup |
| DevOverlay (`src/editor/scene-runtime.js`) | Rendering phase |
| CoG visual marker / `updateCoG` | Rendering / future CoG safety work |

---

## 9. AI Memory Infrastructure

```
Config:    .ai/memory.json
CLI:       bash tools/project-memory query|record|promote "<text>"
Vault:     Truck-Packer-3D Obsidian Markdown vault (path in .ai/memory.json)
```

- `query` — retrieval works without a semantic memory graph (exact-match by default).
- `record` — record meaningful completed milestones.
- `promote` — promote durable Decisions, Lessons, or Problems.
- Semantic Graphify indexing of the memory vault is optional and requires an external LLM API key.

---

## 10. Status Legend

| Symbol | Meaning |
|---|---|
| ✅ | Complete and merged to main |
| 🔄 | In-progress / active branch |
| ⏭️ | Next milestone (explicitly approved by the user) |
| 📋 | Candidate workstream (unapproved, not yet started) |
| 🔮 | Deferred — not yet approved |
| 🔒 | Locked product contract / decision |

---

## 11. Update Rules

1. Update the current baseline and active milestone row only at milestone closeout or real blocker-state change.
2. Keep the candidate workstream list at 10–15 items maximum.
3. Replace stale status — do not append contradictory blocks.
4. Move detailed implementation reports and audit evidence to dedicated topic or archive documents.
5. Do not paste full implementation evidence here.
6. Do not promote deferred inventory to active queue without explicit approval.
7. When a milestone is closed, add a one-line concise summary with a PR link to Section 3.
8. Update `AGENTS.md` and `CLAUDE.md` references if V6 is superseded.
