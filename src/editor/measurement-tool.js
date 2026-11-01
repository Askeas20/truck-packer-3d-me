/**
 * @file measurement-tool.js
 * @description Measurement Tool V1 controller: Measurement Mode, picking, the on-screen dimension
 *   lines and the compact measurement list. THREE and DOM concerns live here; the data model,
 *   validation and geometry resolution live in core/measurements.js and persistence lives in
 *   PackLibrary. The tool is an illustrative, informational ruler: it never moves cargo, never
 *   changes the cargo selection while creating, and never participates in collision, assessment, AutoPack or exports.
 *
 *   A point can be placed on anything visible: any cargo surface (any shape), the truck floor,
 *   wheel-well tops and deck, the truck walls, ceiling and end planes, and the ground anywhere,
 *   including outside the truck. A completed measurement can be selected and either endpoint
 *   dragged onto any other supported surface.
 *
 *   Ownership rules (docs/product/TP3D-MASTER-TODO-V6.md Section 4.1):
 *   - While the mode is active the Editor's pointer handlers delegate here instead of selecting or
 *     dragging cargo. OrbitControls is untouched, so orbit, pan and zoom stay available. The one
 *     exception is a press on a selected measurement's grip: that press is claimed in the capture
 *     phase so neither OrbitControls nor the Editor sees it, and it ends on release or cancel.
 *   - One Escape exits the mode through exit(): an unfinished Point A or endpoint drag is dropped
 *     without writing, saved measurements stay, and the event is consumed in the capture phase so
 *     cargo deselection, the mobile drawers and other Escape handlers never see it. A modal, dropdown,
 *     text field or popover that owns Escape keeps it. Undo with an unfinished Point A or endpoint
 *     drag cancels only that gesture. Cargo keys (including Delete) act on the cargo selection as
 *     they always do; a gesture that loses its cargo is cancelled by sync() and writes nothing.
 *   - Lines, ticks and labels are drawn as an SVG/DOM layer above the canvas, so they can never
 *     appear in a canvas capture (Screenshot, PDF views, thumbnails, previews).
 *   - Saved measurements and the creation mode are separate. A saved Valid measurement stays drawn after the
 *     mode ends ("view only"): its line, ticks and distance label, with no draft points or hover marker, and
 *     with nothing selected no pointer or keyboard ownership and no write of any kind. Editing a saved record
 *     does not need creation: the Editor selects one on a click on its line or label (lineHitAt/select; a drag
 *     that starts there stays the camera or cargo drag), the selected measurement shows grips, and a press on a
 *     grip is claimed in the capture phase and dragged through the same endpoint writer. The body (line or label) of the
 *     SELECTED measurement drags the whole measurement when both ends sit on one physical surface (core/measurements.js
 *     rigidMoveFrame); anything else refuses the whole move and writes nothing. Selecting one replaces
 *     any cargo or annotation selection (and the reverse), so Delete never reaches cargo through it. A drag
 *     released off the canvas, Escape, Undo, an unchanged or rejected target all write nothing. The capture
 *     listeners exist only while armed, selected or dragging. The view follows cargo,
 *     camera, projection and viewport changes, and it is drawn only for the committed scene: nothing is
 *     drawn while AutoPack, Unpack or a truck change runs or while an unapplied preview is shown. Hiding the
 *     tool in Settings hides the lines with it. Saved callouts stay drawn while the mode is on.
 *   - The list panel can be dragged by its header grip (the same 2x3 dot grip as the AutoPack
 *     Results panel) so it never has to cover content. The position is a per-session view
 *     convenience: it is not saved with the Load Plan and never touches cargo or camera.
 *   - Cargo anchors are only ever picked from, and only ever resolved against, COMMITTED poses. While
 *     the Editor owns a provisional pose (a live drag, a gizmo stroke or a held case) a pick that lands
 *     on cargo is refused, because the mesh is displayed away from the pose the Load Plan stores. An
 *     unfinished Point A, or an endpoint drag, is dropped if the committed pose of any cargo it refers
 *     to changes (a nudge, a rotation): it was begun against a different arrangement. Camera moves
 *     never do. Saved measurements simply follow their cargo.
 *   - Cargo whose instance ID another item in the Load Plan shares (damaged stored data; the app never
 *     creates it) is never picked and never resolved: the pick is refused with its own message and the
 *     stored measurements on that ID stay, flagged Unresolved, until the IDs are unique again.
 *   - A background thumbnail capture is a read-only pixel readback, not an edit. It does not make
 *     measurements read-only and never cancels an unfinished measurement. AutoPack, Unpack, Truck
 *     Change and AutoPack/Truck Change previews do, and the message names the real cause.
 * @module editor/measurement-tool
 */

import {
  MAX_MEASUREMENTS_PER_PACK,
  MEASUREMENT_STATUS,
  MEASUREMENT_TYPE_POINT_TO_POINT,
  MEASUREMENT_TYPE_UNREADABLE,
  defaultMeasurementName,
  describeMeasurementReason,
  formatMeasurementLength,
  measureBetween,
  measurementStatusLabel,
  resolveAnchor,
  rigidMoveFrame,
  translateAnchorPair,
} from '../core/measurements.js';
import { createSurfacePicker } from './surface-picker.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
// A real mouse or trackpad click jitters a few pixels; anything larger is an orbit/pan drag.
const CLICK_DRAG_THRESHOLD_PX = 6;
const HOVER_PICK_INTERVAL_MS = 40;
const MIN_SEGMENT_INCHES = 0.05;
const MIN_MOVE_INCHES = 0.05;
const STATUS_VISIBLE_MS = 2600;
const NOTICE_INTERVAL_MS = 1400;
const LABEL_MARGIN_PX = 12;
// Dimension-line geometry, in screen pixels. The hit radii are invisible and deliberately larger
// than the drawn grips, so a precise drag is easy without making the grips look heavy.
const TICK_HALF_PX = 5;
const GRIP_HALF_PX = 8;
const MARKER_ARM_PX = 5;
const GRIP_HIT_RADIUS_PX = 16;
const LINE_HIT_PX = 6;
// How far from a saved line (px) a click still selects it while creation is off: a finger needs more room than a mouse.
const LINE_SELECT_REACH_PX = Object.freeze({ mouse: LINE_HIT_PX, pen: 9, touch: 12 });
// Near an endpoint a click places a point instead of selecting, so a new measurement can start from
// the corner of an existing one (length, then width from the same corner).
const ENDPOINT_CLICK_ZONE_PX = 14;
// The list panel drags like the AutoPack Results panel: 5px threshold, kept 10px inside its host.
const PANEL_MARGIN_PX = 10;
const PANEL_DRAG_THRESHOLD_PX = 5;
const HELD_POSE_NOTICE = 'Place or cancel the held case before measuring on cargo.';
const BODY_MOVE_TEXT = Object.freeze({
  ok: 'Release to move the whole measurement here. Esc cancels.',
  off: 'Part of the measurement would leave its surface. Release to leave it where it was, or press Esc.',
});
const BODY_MOVE_REFUSED = 'The whole measurement has to stay on its surface, so it was left where it was.';
const BODY_MOVE_UNSUPPORTED = 'The ends of this measurement are on different surfaces, so it can only be moved one end at a time. Drag a grip.';
const AMBIGUOUS_CARGO_NOTICE = 'This cargo shares its ID with another item in the Load Plan, so it cannot be measured.';
// Why a pick that landed on cargo was refused (set on the pick outcome); each has its own message.
const PICK_REFUSAL_NOTICE = { provisional: HELD_POSE_NOTICE, ambiguous: AMBIGUOUS_CARGO_NOTICE };
// Operations that only read pixels back never block or cancel measurement editing.
const PASSIVE_OPERATION_KINDS = new Set(['capturingPreview']);
const BLOCKED_CAUSE_TEXT = Object.freeze({
  preview: 'an AutoPack preview is shown',
  autopacking: 'AutoPack is running',
  unpacking: 'Unpack is running',
  changingTruck: 'the truck is being changed',
  previewingTruckChange: 'a truck change preview is open',
});

export function createMeasurementTool({
  SceneManager,
  CaseScene,
  CaseLibrary,
  PackLibrary,
  StateStore,
  PreferencesManager,
  UIComponents,
  OperationLifecycle = null,
  doc = typeof document !== 'undefined' ? document : null,
}) {
  // ==========================================================================
  // SECTION: STATE
  // ==========================================================================
  let els = { button: null, panel: null, labels: null, viewport: null };
  let bound = false;
  let active = false; // creation armed: the canvas accepts New Measurement's points (and owns its gestures)
  let managerOpen = false; // the Measurements manager is shown: saved records can be selected, renamed and deleted; nothing is created
  let pending = null; // { anchor, world: THREE.Vector3, poseKey } — Point A of a measurement being created
  let selectedId = null; // the completed measurement that shows grips
  let drag = null; // { id, which, pointerId, candidate, dirty, poseKeys } — an endpoint being repositioned
  let listening = false; // the document capture listeners (grip press, Escape, Undo) are registered: only while armed, selected or dragging
  let selfClearing = false; // this tool is itself clearing the other selections: the store notification it causes is not a reason to deselect
  let hover = null; // latest surface pick under the pointer
  let hoverGrip = null; // 'start' | 'end' when the pointer is over the selected measurement's grip
  let hoverMeasurementId = null;
  let press = null; // { x, y } of a primary press that began on the canvas while active
  let keyboardModality = false; // keyboard (not pointer) was the last input while active: decides the viewport's focus ring on Escape
  let lastClient = null;
  let hoverDirty = false;
  let lastHoverPickAt = 0;
  let lastNoticeAt = 0;
  let lastCursor = '';
  let rafId = null;
  let records = [];
  let results = [];
  let lengthUnit = 'in';
  let statusMessage = '';
  let statusTone = ''; // presentation only: colours the guidance dot ('success' after a save or move)
  let statusTimer = null;
  let renamingId = null;
  let lastBlockedReason = null;
  let panelCollapsed = false;
  let panelParts = null;
  let panelPosition = null; // { x, y } the user dragged the panel to, relative to its host; null = default spot
  let panelObserver = null;
  let suppressToggleClick = false;
  let svg = null;
  let syncedPackId = null; // the Load Plan `records` and `results` were derived from (view-only drawing never trusts older ones)
  let toolShown = true; // the Settings toggle, read when it changes (not per frame): hidden means no ruler and no saved lines
  const rows = new Map(); // measurement id -> { el, select, name, value, rename, remove, issue, input }
  const visuals = new Map(); // measurement id -> segment visual
  const overlayOrigin = { left: 0, top: 0 };
  let previewVisual = null;
  let ghostVisual = null;
  let hoverMarker = null;
  let pendingMarker = null;

  const scratchA = new THREE.Vector3();
  const scratchB = new THREE.Vector3();
  const scratchC = new THREE.Vector3();
  const scratchD = new THREE.Vector3();
  const viewA = new THREE.Vector3();
  const viewB = new THREE.Vector3();

  // ==========================================================================
  // SECTION: SMALL HELPERS
  // ==========================================================================
  const inEditor = () => StateStore.get('currentScreen') === 'editor';
  const currentPack = () => PackLibrary.getById(StateStore.get('currentPackId'));
  // The positioned ancestor the panel's left/top are measured from.
  const panelHost = () => (els.panel ? (els.panel.offsetParent || els.panel.parentElement) : null);

  /**
   * Why measurements cannot be created, moved, renamed or deleted right now, or null. A transient
   * Results/Truck Change preview is named first; then the running operation. A passive thumbnail
   * capture is neither: it only reads pixels. A measurement write replaces the Pack object, which
   * aborts a capture that is mid-flight; the app re-requests it (app.js, 'pack-measurements').
   */
  function blockedReason() {
    if (CaseScene.isTransientPreview && CaseScene.isTransientPreview()) return 'preview';
    if (!OperationLifecycle || !OperationLifecycle.isBusy()) return null;
    const operation = typeof OperationLifecycle.currentOperation === 'function' ? OperationLifecycle.currentOperation() : null;
    const kind = operation && operation.kind ? operation.kind : 'busy';
    return PASSIVE_OPERATION_KINDS.has(kind) ? null : kind;
  }

  function blockedMessage(reason) {
    return `Measurements are read-only while ${BLOCKED_CAUSE_TEXT[reason] || 'an operation is running'}.`;
  }

  /**
   * True when saved Valid measurements should be on screen while the mode is off: in the Editor, for the Load
   * Plan the records belong to, with the tool enabled in Settings. Needs Review and Unresolved ones never get
   * geometry, so a Load Plan with only those draws nothing.
   */
  function viewOnlyWanted() {
    if (!bound || active || !inEditor() || !els.labels) return false;
    if (syncedPackId === null || syncedPackId !== StateStore.get('currentPackId') || !currentPack()) return false;
    if (!toolShown) return false;
    return results.some((result, index) => result.status === MEASUREMENT_STATUS.VALID &&
      records[index] && records[index].type === MEASUREMENT_TYPE_POINT_TO_POINT);
  }

  function setStatus(message, { sticky = false, tone = '' } = {}) {
    statusMessage = message || '';
    statusTone = statusMessage ? tone : '';
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = null;
    if (statusMessage && !sticky) {
      statusTimer = window.setTimeout(() => {
        statusMessage = '';
        statusTone = '';
        statusTimer = null;
        renderPanel();
      }, STATUS_VISIBLE_MS);
    }
    renderPanel();
  }

  /** A click that cannot be used must be noticed: toast (rate limited) plus the panel line. */
  function notice(message, tone = 'info') {
    setStatus(message);
    const now = Date.now();
    if (now - lastNoticeAt < NOTICE_INTERVAL_MS) return;
    lastNoticeAt = now;
    UIComponents.showToast(message, tone, { title: 'Measurements' });
  }

  // The Editor holds a scene-only pose (live drag, gizmo stroke, held case): meshes are not where the Load Plan says.
  const provisionalPoseActive = () => typeof els.hasProvisionalPose === 'function' && Boolean(els.hasProvisionalPose());

  /** The only writer of the selection: the capture listeners follow it, so nothing listens while nothing is selected or armed. */
  function setSelected(id) {
    selectedId = id;
    syncInputListeners();
  }

  function syncInputListeners() {
    if (!doc) return;
    const wanted = active || Boolean(selectedId) || Boolean(drag);
    if (wanted === listening) return;
    listening = wanted;
    const method = wanted ? 'addEventListener' : 'removeEventListener';
    doc[method]('keydown', onKeyDownCapture, true);
    doc[method]('pointerdown', onPointerDownCapture, true);
  }

  /** One saved scene object or one cargo selection at a time: selecting a measurement drops the cargo and annotation selections. */
  function clearOtherSelections() {
    if (typeof els.clearOtherSelections !== 'function') return;
    selfClearing = true;
    try {
      els.clearOtherSelections();
    } finally {
      selfClearing = false;
    }
  }

  // The one surface picker shared with the Annotations tool: picking, committed-pose keys, ambiguous-ID
  // refusal and live (displayed-pose) anchor positions. See editor/surface-picker.js.
  const picker = createSurfacePicker({ SceneManager, CaseScene, CaseLibrary, PackLibrary, getPack: currentPack, hasProvisionalPose: provisionalPoseActive });
  const { pick, liveAnchorWorld, lookupInstance, cargoPoseKey, worldVectorToInches, getCanvas } = picker;

  // ==========================================================================
  // SECTION: OVERLAY (restrained SVG dimension lines, DOM labels) — never part of a canvas capture
  // ==========================================================================
  function svgEl(name, className) {
    const el = doc.createElementNS(SVG_NS, name);
    if (className) el.setAttribute('class', className);
    return el;
  }

  function ensureSvg() {
    if (svg && svg.isConnected) return svg;
    if (!els.labels || !doc) return null;
    svg = svgEl('svg', 'tp3d-measure-svg');
    svg.setAttribute('aria-hidden', 'true');
    els.labels.prepend(svg);
    return svg;
  }

  /** A dimension line: thin line, short perpendicular end ticks, grips when selected, compact label. */
  function makeSegment(kind) {
    const root = ensureSvg();
    const group = svgEl('g', `tp3d-measure-svg__segment is-${kind}`);
    const underLine = svgEl('path', 'tp3d-measure-svg__under tp3d-measure-svg__under--line');
    const underTicks = svgEl('path', 'tp3d-measure-svg__under');
    const line = svgEl('path', 'tp3d-measure-svg__line');
    const ticks = svgEl('path', 'tp3d-measure-svg__ticks');
    const grips = svgEl('path', 'tp3d-measure-svg__grips');
    group.append(underLine, underTicks, line, ticks, grips);
    group.style.display = 'none';
    root.appendChild(group);
    let label = null;
    if (kind !== 'ghost') {
      label = doc.createElement('div');
      label.className = `tp3d-measure-label${kind === 'preview' ? ' tp3d-measure-label--preview' : ''}`;
      label.hidden = true;
      els.labels.appendChild(label);
    }
    return { kind, group, underLine, underTicks, line, ticks, grips, label, selected: false, gripHover: false, d: {}, screen: null };
  }

  function disposeSegment(visual) {
    if (!visual) return;
    if (visual.group && visual.group.parentNode) visual.group.parentNode.removeChild(visual.group);
    if (visual.label && visual.label.parentNode) visual.label.parentNode.removeChild(visual.label);
  }

  /** A small "+" showing where a click would land (neutral) or where Point A sits (accent). */
  function makeMarker(kind) {
    const root = ensureSvg();
    const group = svgEl('g', `tp3d-measure-svg__marker is-${kind}`);
    const under = svgEl('path', 'tp3d-measure-svg__under');
    const mark = svgEl('path', 'tp3d-measure-svg__mark');
    group.append(under, mark);
    group.style.display = 'none';
    root.appendChild(group);
    return { group, under, mark, key: '' };
  }

  function setMarker(marker, point) {
    if (!point) {
      if (marker.group.style.display !== 'none') marker.group.style.display = 'none';
      return;
    }
    const arm = MARKER_ARM_PX;
    const x = point.x.toFixed(1);
    const y = point.y.toFixed(1);
    const key = `${x},${y}`;
    marker.group.style.display = '';
    if (marker.key === key) return;
    marker.key = key;
    const d = `M${(point.x - arm).toFixed(1)} ${y}L${(point.x + arm).toFixed(1)} ${y}M${x} ${(point.y - arm).toFixed(1)}L${x} ${(point.y + arm).toFixed(1)}`;
    marker.under.setAttribute('d', d);
    marker.mark.setAttribute('d', d);
  }

  function disposeMarker(marker) {
    if (marker && marker.group.parentNode) marker.group.parentNode.removeChild(marker.group);
  }

  function setPath(visual, name, d) {
    if (visual.d[name] === d) return;
    visual.d[name] = d;
    visual[name].setAttribute('d', d);
  }

  /**
   * Project a world segment to screen pixels. A segment with one end behind a perspective camera is
   * clipped at the near plane so it never flips; fully-behind segments return null.
   */
  function projectSegment(a, b, camera, width, height) {
    viewA.copy(a).applyMatrix4(camera.matrixWorldInverse);
    viewB.copy(b).applyMatrix4(camera.matrixWorldInverse);
    const perspective = camera.isPerspectiveCamera;
    const limit = perspective ? -(camera.near + 0.001) : Infinity;
    const aIn = !perspective || viewA.z <= limit;
    const bIn = !perspective || viewB.z <= limit;
    if (!aIn && !bIn) return null;
    if (!aIn || !bIn) {
      // Move the end that is behind the camera onto the near plane along the segment.
      const behind = aIn ? viewB : viewA;
      const front = aIn ? viewA : viewB;
      const t = (limit - front.z) / (behind.z - front.z);
      behind.set(front.x + (behind.x - front.x) * t, front.y + (behind.y - front.y) * t, limit);
    }
    const toPx = view => {
      view.applyMatrix4(camera.projectionMatrix);
      return { x: (view.x * 0.5 + 0.5) * width, y: (-view.y * 0.5 + 0.5) * height };
    };
    return { p1: toPx(viewA), p2: toPx(viewB), aVisible: aIn, bVisible: bIn };
  }

  function projectPoint(point, camera, width, height) {
    const projected = projectSegment(point, point, camera, width, height);
    return projected && projected.aVisible ? projected.p1 : null;
  }

  const fixed = value => value.toFixed(1);

  /** Segment plus perpendicular end ticks (and longer grips) in screen pixels. */
  function buildPaths(projected) {
    const { p1, p2, aVisible, bVisible } = projected;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    const nx = length > 0.01 ? -dy / length : 0;
    const ny = length > 0.01 ? dx / length : 1;
    const tick = (point, half) => `M${fixed(point.x - nx * half)} ${fixed(point.y - ny * half)}L${fixed(point.x + nx * half)} ${fixed(point.y + ny * half)}`;
    return {
      line: `M${fixed(p1.x)} ${fixed(p1.y)}L${fixed(p2.x)} ${fixed(p2.y)}`,
      ticks: `${aVisible ? tick(p1, TICK_HALF_PX) : ''}${bVisible ? tick(p2, TICK_HALF_PX) : ''}`,
      grips: `${aVisible ? tick(p1, GRIP_HALF_PX) : ''}${bVisible ? tick(p2, GRIP_HALF_PX) : ''}`,
    };
  }

  function placeLabel(visual, text, projected, width, height, selected) {
    const label = visual.label;
    if (!label) return null;
    const minX = Math.min(projected.p1.x, projected.p2.x);
    const maxX = Math.max(projected.p1.x, projected.p2.x);
    const minY = Math.min(projected.p1.y, projected.p2.y);
    const maxY = Math.max(projected.p1.y, projected.p2.y);
    if (maxX < 0 || minX > width || maxY < 0 || minY > height) {
      label.hidden = true;
      return null;
    }
    label.hidden = false;
    if (label.textContent !== text) label.textContent = text;
    label.classList.toggle('is-selected', Boolean(selected));
    const x = Math.min(width - LABEL_MARGIN_PX, Math.max(LABEL_MARGIN_PX, (projected.p1.x + projected.p2.x) / 2));
    const y = Math.min(height - LABEL_MARGIN_PX, Math.max(LABEL_MARGIN_PX, (projected.p1.y + projected.p2.y) / 2));
    const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    if (label.style.transform !== transform) label.style.transform = transform;
    // Estimated box for hit-testing (no layout reads in the frame loop).
    return { x, y, w: Math.round(text.length * 6.4 + 14), h: 18 };
  }

  function hideSegment(visual) {
    if (visual.group.style.display !== 'none') visual.group.style.display = 'none';
    if (visual.label) visual.label.hidden = true;
    visual.screen = null;
  }

  function drawSegment(visual, a, b, text, camera, width, height, { selected = false, grips = false } = {}) {
    const projected = projectSegment(a, b, camera, width, height);
    if (!projected) {
      hideSegment(visual);
      return;
    }
    visual.group.style.display = '';
    const paths = buildPaths(projected);
    setPath(visual, 'underLine', paths.line);
    setPath(visual, 'line', paths.line);
    setPath(visual, 'underTicks', paths.ticks);
    setPath(visual, 'ticks', paths.ticks);
    setPath(visual, 'grips', grips ? paths.grips : '');
    if (visual.selected !== selected) {
      visual.selected = selected;
      visual.group.classList.toggle('is-selected', selected);
      // Paint the selected measurement above the others.
      if (selected && visual.group.parentNode) visual.group.parentNode.appendChild(visual.group);
    }
    const gripHover = grips && Boolean(hoverGrip || drag);
    if (visual.gripHover !== gripHover) {
      visual.gripHover = gripHover;
      visual.group.classList.toggle('is-grip-hover', gripHover);
    }
    const labelBox = placeLabel(visual, text, projected, width, height, selected);
    visual.screen = { p1: projected.p1, p2: projected.p2, aVisible: projected.aVisible, bVisible: projected.bVisible, labelBox };
  }

  /** The scene label is one compact distance; a user-given name is added only while it is selected. */
  function labelText(record, distanceInches, selected = false) {
    const value = formatMeasurementLength(distanceInches, lengthUnit);
    return selected && record && record.label ? `${record.label} · ${value}` : value;
  }

  function updateOverlay() {
    const camera = SceneManager.getCamera();
    if (!camera || !ensureSvg()) return;
    // Only the committed scene is measured. While an operation runs or an unapplied preview is shown the
    // scene displays poses the Load Plan does not hold, so nothing is drawn; the lines come back from the
    // saved records when the committed scene returns.
    if (blockedReason()) {
      disposeAllVisuals();
      return;
    }
    const rect = els.labels.getBoundingClientRect();
    overlayOrigin.left = rect.left;
    overlayOrigin.top = rect.top;
    const width = rect.width > 0 ? rect.width : 1;
    const height = rect.height > 0 ? rect.height : 1;

    // Saved measurements: only Valid ones are drawn. Needs Review and Unresolved never get geometry.
    const live = new Set();
    let ghostDrawn = false;
    results.forEach((result, index) => {
      const record = records[index];
      if (!record || record.type !== MEASUREMENT_TYPE_POINT_TO_POINT || result.status !== MEASUREMENT_STATUS.VALID) return;
      live.add(record.id);
      let visual = visuals.get(record.id);
      if (!visual) {
        visual = makeSegment('saved');
        visuals.set(record.id, visual);
      }
      const a = liveAnchorWorld(record.start, result.start, scratchA);
      const b = liveAnchorWorld(record.end, result.end, scratchB);
      if (!a || !b) {
        hideSegment(visual);
        return;
      }
      const dragging = drag && drag.id === record.id;
      const carried = dragging && drag.which === 'body';
      if (dragging && (!carried || drag.moved)) {
        // Subtle ghost of where the endpoint (or the whole measurement) was, then the live preview with the new distance.
        const ghostA = liveAnchorWorld(record.start, result.start, scratchC);
        const ghostB = liveAnchorWorld(record.end, result.end, scratchD);
        if (ghostA && ghostB) {
          if (!ghostVisual) ghostVisual = makeSegment('ghost');
          drawSegment(ghostVisual, ghostA, ghostB, '', camera, width, height);
          ghostDrawn = true;
        }
        if (carried) {
          // Both ends at the live offset: the shifted anchors, from the same pure move the write uses.
          if (drag.pair) {
            liveAnchorWorld(drag.pair.start, drag.pair.start.kind === 'cargo' ? null : drag.pair.start.position, a);
            liveAnchorWorld(drag.pair.end, drag.pair.end.kind === 'cargo' ? null : drag.pair.end.position, b);
          }
        } else if (drag.candidate) {
          (drag.which === 'start' ? a : b).copy(drag.candidate.world);
        }
      }
      const inches = measureBetween(worldVectorToInches(a), worldVectorToInches(b)).distance;
      const selected = record.id === selectedId || dragging;
      drawSegment(visual, a, b, labelText(record, inches, selected), camera, width, height, { selected, grips: selected });
    });
    visuals.forEach((visual, id) => {
      if (live.has(id)) return;
      disposeSegment(visual);
      visuals.delete(id);
    });
    if (ghostVisual && !ghostDrawn) {
      disposeSegment(ghostVisual);
      ghostVisual = null;
    }

    // Live preview from Point A to the point under the pointer.
    const pendingWorld = pending
      ? (liveAnchorWorld(pending.anchor, null, scratchA) || scratchA.copy(pending.world))
      : null;
    if (pendingWorld) {
      if (!previewVisual) previewVisual = makeSegment('preview');
      if (hover && hover.world) {
        const target = scratchB.copy(hover.world);
        const inches = measureBetween(worldVectorToInches(pendingWorld), worldVectorToInches(target)).distance;
        drawSegment(previewVisual, pendingWorld, target, formatMeasurementLength(inches, lengthUnit), camera, width, height);
        if (pendingMarker) setMarker(pendingMarker, null);
      } else {
        // Only Point A so far: a single accent marker, no line or label.
        hideSegment(previewVisual);
        if (!pendingMarker) pendingMarker = makeMarker('pending');
        setMarker(pendingMarker, projectPoint(pendingWorld, camera, width, height));
      }
    } else {
      if (previewVisual) {
        disposeSegment(previewVisual);
        previewVisual = null;
      }
      if (pendingMarker) setMarker(pendingMarker, null);
    }

    // Where a click would land: a small neutral "+", only on something measurable.
    const showHover = hover && hover.world && !drag && !hoverGrip && !hoverMeasurementId;
    if (showHover) {
      if (!hoverMarker) hoverMarker = makeMarker('hover');
      setMarker(hoverMarker, projectPoint(hover.world, camera, width, height));
    } else if (hoverMarker) {
      setMarker(hoverMarker, null);
    }
  }

  /** Everything an editing session draws beyond the saved lines: the live preview, the move ghost and the markers. */
  function disposeTransientVisuals() {
    if (previewVisual) disposeSegment(previewVisual);
    if (ghostVisual) disposeSegment(ghostVisual);
    previewVisual = null;
    ghostVisual = null;
    disposeMarker(hoverMarker);
    disposeMarker(pendingMarker);
    hoverMarker = null;
    pendingMarker = null;
  }

  function disposeAllVisuals() {
    visuals.forEach(disposeSegment);
    visuals.clear();
    disposeTransientVisuals();
  }

  // ==========================================================================
  // SECTION: SCREEN-SPACE HIT TESTING (grips, lines, labels of the drawn overlay)
  // ==========================================================================
  const toLayerPoint = client => ({ x: client.x - overlayOrigin.left, y: client.y - overlayOrigin.top });

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** Which endpoint grip of the selected measurement is under the pointer, or null. */
  function gripAt(client) {
    if (!selectedId || drag || blockedReason()) return null;
    const visual = visuals.get(selectedId);
    const screen = visual && visual.screen;
    if (!screen) return null;
    const p = toLayerPoint(client);
    const da = screen.aVisible ? Math.hypot(p.x - screen.p1.x, p.y - screen.p1.y) : Infinity;
    const db = screen.bVisible ? Math.hypot(p.x - screen.p2.x, p.y - screen.p2.y) : Infinity;
    if (Math.min(da, db) > GRIP_HIT_RADIUS_PX) return null;
    return da <= db ? 'start' : 'end';
  }

  /** The drawn measurement (line body or label) under the pointer, or null. Endpoint zones never select. */
  function measurementAt(client) {
    const p = toLayerPoint(client);
    let bestId = null;
    let bestDistance = LINE_HIT_PX;
    visuals.forEach((visual, id) => {
      const screen = visual.screen;
      if (!screen) return;
      let distance = distanceToSegment(p, screen.p1, screen.p2);
      const nearEnd = Math.min(Math.hypot(p.x - screen.p1.x, p.y - screen.p1.y), Math.hypot(p.x - screen.p2.x, p.y - screen.p2.y)) < ENDPOINT_CLICK_ZONE_PX;
      if (nearEnd) distance = Infinity;
      const box = screen.labelBox;
      if (box && Math.abs(p.x - box.x) <= box.w / 2 && Math.abs(p.y - box.y) <= box.h / 2) distance = 0;
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestId = id;
      }
    });
    return bestId;
  }

  // ==========================================================================
  // SECTION: FRAME LOOP (runs while Measurement Mode is active, or while saved lines are shown view-only)
  // ==========================================================================
  function updateCursor() {
    const canvas = getCanvas();
    if (!canvas) return;
    let cursor = 'default';
    if (drag) {
      cursor = 'grabbing';
    } else if (active) {
      if (hoverGrip) cursor = 'grab';
      else if (hoverMeasurementId) cursor = 'pointer';
      else if (hover) cursor = 'crosshair';
    }
    if (cursor === lastCursor) return;
    lastCursor = cursor;
    canvas.style.cursor = cursor;
  }

  /**
   * React to a change in what (if anything) makes measurements read-only. A genuinely blocking
   * operation cancels an unfinished Point A or endpoint drag; a passive capture never does.
   */
  function syncBlocked() {
    const reason = blockedReason();
    if (reason === lastBlockedReason) return reason;
    lastBlockedReason = reason;
    if (reason) {
      if (drag) cancelDrag(blockedMessage(reason));
      if (pending) cancelPending(blockedMessage(reason));
    }
    renderPanel();
    return reason;
  }

  function frame(now) {
    if (!active) {
      // View only: redraw the saved lines for the camera and cargo as they are now. The one gesture is a selected measurement's
      // grip drag; the Editor's own hover handles the cursor, so only a drag sets it here.
      if (drag) {
        const blocked = syncBlocked();
        if (drag && drag.which === 'body') {
          advanceBodyMove();
        } else if (drag && drag.dirty && lastClient) {
          drag.dirty = false;
          drag.candidate = blocked || !insideCanvas(lastClient.x, lastClient.y) ? null : pick(lastClient.x, lastClient.y);
        }
        updateCursor();
      }
      updateOverlay();
      return;
    }
    const reason = syncBlocked();
    if (drag) {
      if (drag.dirty && lastClient) {
        drag.dirty = false;
        drag.candidate = reason || !insideCanvas(lastClient.x, lastClient.y) ? null : pick(lastClient.x, lastClient.y);
      }
    } else if (hoverDirty && lastClient && now - lastHoverPickAt >= HOVER_PICK_INTERVAL_MS) {
      hoverDirty = false;
      lastHoverPickAt = now;
      hoverGrip = gripAt(lastClient);
      hoverMeasurementId = hoverGrip || pending ? null : measurementAt(lastClient);
      hover = reason || hoverGrip || hoverMeasurementId ? null : pick(lastClient.x, lastClient.y);
    }
    updateOverlay();
    updateCursor();
  }

  function loop(now) {
    rafId = null;
    if (!active && !viewOnlyWanted()) {
      // Nothing is left to show (other Load Plan, left the Editor, tool hidden, no Valid measurement): nothing stays selected.
      cancelDrag();
      setSelected(null);
      disposeAllVisuals();
      return;
    }
    frame(now);
    rafId = window.requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId === null) rafId = window.requestAnimationFrame(loop);
  }

  /** Start drawing when there is something to draw and nothing is drawing it yet. */
  function ensureLoop() {
    if (rafId === null && (active || viewOnlyWanted())) startLoop();
  }

  function stopLoop() {
    if (rafId !== null) window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  // ==========================================================================
  // SECTION: MODE + PENDING POINT
  // ==========================================================================
  function cancelPending(message = '') {
    const had = Boolean(pending);
    pending = null;
    hoverDirty = true;
    if (had && message) setStatus(message);
    else if (had) renderPanel();
  }

  function enter() {
    if (active || !inEditor() || !currentPack() || !SceneManager.getScene() || !getCanvas()) return false;
    active = true;
    managerOpen = true;
    pending = null;
    drag = null;
    setSelected(null);
    hover = null;
    hoverGrip = null;
    hoverMeasurementId = null;
    press = null;
    // A mouse click on the ruler leaves it unmarked; activating it from the keyboard leaves it focus-visible.
    const entryFocus = doc ? doc.activeElement : null;
    keyboardModality = Boolean(entryFocus && typeof entryFocus.matches === 'function' && entryFocus.matches(':focus-visible'));
    lastBlockedReason = blockedReason();
    CaseScene.setHover(null);
    syncButton();
    syncNewButton();
    if (els.labels) els.labels.classList.add('is-active');
    ensureSvg();
    syncInputListeners();
    sync();
    if (els.panel) els.panel.hidden = false;
    renderPanel();
    // Keep a dragged panel inside the viewport when the viewport itself resizes (window, side panels).
    const host = panelHost();
    if (host && typeof ResizeObserver === 'function') {
      panelObserver = new ResizeObserver(() => applyPanelPosition());
      panelObserver.observe(host);
    }
    updateCursor();
    startLoop();
    const unreadable = records.filter(record => record.type === MEASUREMENT_TYPE_UNREADABLE).length;
    if (unreadable) {
      UIComponents.showToast(
        `${unreadable === 1 ? 'A saved measurement' : `${unreadable} saved measurements`} couldn't be read. The original data is kept.`,
        'warning', { title: 'Measurements' }
      );
    }
    return true;
  }

  function exit({ keepSelection = false } = {}) {
    const wasActive = active;
    endDrag();
    active = false;
    pending = null;
    // Hiding the manager keeps a selection made on a saved record. What a creation session auto-selected after saving is part of that
    // session (cargo may be selected beside it, as creation always allowed), so it ends with it.
    setSelected(keepSelection && !wasActive && selectedId ? selectedId : null);
    hover = null;
    hoverGrip = null;
    hoverMeasurementId = null;
    press = null;
    renamingId = null;
    stopLoop();
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = null;
    statusMessage = '';
    statusTone = '';
    if (els.labels) els.labels.classList.remove('is-active');
    if (els.panel) els.panel.hidden = !managerOpen;
    if (!managerOpen && panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }
    rows.forEach(row => row.el.remove());
    rows.clear();
    // The editing session's own drawing goes; the saved lines stay on screen as a view when there are any.
    disposeTransientVisuals();
    if (viewOnlyWanted()) {
      // Redraw now, not on the next frame, so no frame shows the finished session's selection or grips.
      updateOverlay();
      startLoop();
    } else {
      disposeAllVisuals();
    }
    if (wasActive) updateCursor();
    syncButton();
    syncNewButton();
    if (managerOpen) renderPanel();
    return wasActive;
  }

  function toggle() {
    if (active) {
      exit();
      return false;
    }
    return enter();
  }

  /** The toolbar button's aria-pressed: whether the Measurements manager is open (creation has its own control). */
  function syncButton() {
    if (els.button) els.button.setAttribute('aria-pressed', managerOpen ? 'true' : 'false');
  }

  /** The New measurement control reflects creation, even while the panel is hidden (its state is read when it is shown again). */
  function syncNewButton() {
    if (!panelParts || !panelParts.newButton) return;
    panelParts.newButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    const label = active ? 'Stop measuring' : 'New measurement';
    if (panelParts.newButton.lastChild.textContent !== label) panelParts.newButton.lastChild.textContent = label;
  }

  /** Show the Measurements manager. It lists, selects, renames and deletes saved measurements and creates nothing. */
  function openManager() {
    if (managerOpen || !bound || !inEditor() || !currentPack() || !els.panel) return false;
    managerOpen = true;
    els.panel.hidden = false;
    const host = panelHost();
    if (host && typeof ResizeObserver === 'function' && !panelObserver) {
      panelObserver = new ResizeObserver(() => applyPanelPosition());
      panelObserver.observe(host);
    }
    syncButton();
    sync();
    settle();
    ensureLoop();
    return true;
  }

  /**
   * Hide the Measurements manager. Creation ends too (a pending first point is dropped, nothing is written); saved lines stay drawn.
   * With `keepSelection` (the toolbar button) a selected saved measurement stays selected and editable; every other caller is
   * leaving the Load Plan, the Editor or the tool, so the selection goes with it.
   */
  function closeManager({ keepSelection = false } = {}) {
    managerOpen = false;
    exit({ keepSelection });
    if (els.panel) els.panel.hidden = true;
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }
    syncButton();
    ensureLoop();
    return true;
  }

  /** The panel's New Measurement control: arms creation, or stops it when it is already armed. */
  function startFromPanel() {
    if (active) {
      exit();
      renderPanel();
      return;
    }
    if (!managerOpen) return;
    // Another creator (Callout, Arrow, Draw) may hold the canvas: it ends first, unless it holds an unsaved draft the owner keeps.
    const gate = typeof els.canStart === 'function' ? els.canStart() : true;
    Promise.resolve(gate).then(ok => {
      if (!ok || !managerOpen || active) return;
      if (!enter()) setStatus('The 3D view is not ready yet.');
    });
  }

  /** Stop creation without writing (the manager stays open). Used when another creator takes the canvas. */
  function cancelCreation() {
    if (!active) return false;
    return exit();
  }

  // ==========================================================================
  // SECTION: POINTER OWNERSHIP (called by the Editor's pointer handlers while active)
  // ==========================================================================
  function onPointerDown(ev) {
    if (!active || ev.button !== 0) return;
    press = { x: ev.clientX, y: ev.clientY };
    lastClient = { x: ev.clientX, y: ev.clientY };
  }

  function onPointerMove(ev) {
    if (!active) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    hoverDirty = true;
  }

  function onPointerCancel() {
    press = null;
  }

  function onPointerUp(ev) {
    if (!active || !press) return;
    const moved = Math.hypot(ev.clientX - press.x, ev.clientY - press.y);
    press = null;
    if (ev.button !== 0 || moved > CLICK_DRAG_THRESHOLD_PX) return; // an orbit/pan drag, not a click
    handleClick(ev.clientX, ev.clientY);
  }

  /** Double-click must neither place a zero-length measurement nor focus the camera on cargo. */
  function onDoubleClick(ev) {
    if (!active) return false;
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    return true;
  }

  /** A click on a drawn measurement selects it; anywhere else places a point. */
  function handleClick(clientX, clientY) {
    if (!pending) {
      const id = measurementAt({ x: clientX, y: clientY });
      if (id) {
        selectMeasurement(id);
        return;
      }
    }
    placePoint(clientX, clientY);
  }

  function placePoint(clientX, clientY) {
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    if (!pack) return;
    if (!pending && PackLibrary.getMeasurements(pack).length >= MAX_MEASUREMENTS_PER_PACK) {
      notice(`Limit of ${MAX_MEASUREMENTS_PER_PACK} measurements reached. Delete one to add another.`, 'warning');
      return;
    }
    const pickOutcome = {};
    const picked = pick(clientX, clientY, pickOutcome);
    hover = picked;
    if (!picked) {
      notice(PICK_REFUSAL_NOTICE[pickOutcome.blocked] || 'Nothing to measure there. Click cargo, the truck or the ground.');
      return;
    }
    if (!pending) {
      pending = { anchor: picked.anchor, world: picked.world.clone(), poseKey: cargoPoseKey(pack, picked.anchor) };
      setSelected(null);
      setStatus('', { sticky: true });
      return;
    }
    const start = liveAnchorWorld(pending.anchor, null, scratchA) || scratchA.copy(pending.world);
    const segment = measureBetween(worldVectorToInches(start), worldVectorToInches(picked.world));
    if (segment.distance < MIN_SEGMENT_INCHES) {
      setStatus('Pick a different second point.');
      return;
    }
    const outcome = PackLibrary.addMeasurement(pack.id, { start: pending.anchor, end: picked.anchor });
    // The measurement is finished either way: release the gesture and be ready for the next Point A.
    pending = null;
    press = null;
    hover = null;
    hoverDirty = true;
    if (!outcome.ok) {
      UIComponents.showToast(outcome.reason === 'limit'
        ? `Measurement limit reached (${MAX_MEASUREMENTS_PER_PACK}).`
        : 'Could not save this measurement.', 'error', { title: 'Measurements' });
      renderPanel();
      return;
    }
    setSelected(outcome.measurement.id);
    setStatus('Measurement saved.', { tone: 'success' });
  }

  // ==========================================================================
  // SECTION: SELECTION + ENDPOINT REPOSITIONING
  // ==========================================================================
  /**
   * Select (or with null, deselect) a saved measurement, from its list row, from a click on its line, or after it was saved. Selecting
   * one replaces any cargo or annotation selection, so only one thing is selected and Delete can never reach cargo through it.
   * It needs neither the manager nor creation: it writes nothing and adds no history.
   */
  function selectMeasurement(id) {
    const target = id && records.some(record => record.id === id) ? id : null;
    // While creating, selecting a saved line (or its row) leaves the cargo selection alone, as creation always has.
    if (target && target !== selectedId && !active) {
      if (blockedReason()) return false;
      if (provisionalPoseActive()) {
        notice('Place or cancel the held case before selecting a measurement.');
        return false;
      }
      clearOtherSelections();
    }
    setSelected(target);
    hoverGrip = null;
    renderPanel();
    if (!active && viewOnlyWanted()) updateOverlay();
    return true;
  }

  /** Another tool or the cargo took the selection: drop this one quietly (creation is not touched). */
  function clearSelection() {
    if (!selectedId || active) return;
    cancelDrag();
    setSelected(null);
    renderPanel();
    if (viewOnlyWanted()) updateOverlay();
  }

  /**
   * The saved measurement whose line or label is nearest a client position, within the pointer's reach: `{ id, distance }` or null.
   * A pure query on the geometry the last frame drew (nothing is projected here). Endpoint zones count, unlike creation, where they
   * place a point. Only while creation is off: the armed tool does its own hit testing. It claims nothing: the Editor selects on a
   * click, so a drag that starts on a line is still the camera or cargo drag it was.
   */
  function lineHitAt(clientX, clientY, pointerType = 'mouse') {
    if (active || !visuals.size || !inEditor() || blockedReason()) return null;
    const p = toLayerPoint({ x: clientX, y: clientY });
    const reach = LINE_SELECT_REACH_PX[pointerType] || LINE_HIT_PX;
    let best = null;
    visuals.forEach((visual, id) => {
      const screen = visual.screen;
      if (!screen) return;
      let distance = distanceToSegment(p, screen.p1, screen.p2);
      const box = screen.labelBox;
      if (box && Math.abs(p.x - box.x) <= box.w / 2 && Math.abs(p.y - box.y) <= box.h / 2) distance = 0;
      if (distance <= reach && (!best || distance < best.distance)) best = { id, distance };
    });
    return best;
  }

  /** Whether the pointer is the one dragging a grip: the Editor's hover and cargo handling leave it alone. */
  function ownsPointer(ev) {
    return Boolean(drag && ev && ev.pointerId === drag.pointerId);
  }

  function insideCanvas(x, y) {
    const canvas = getCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /**
   * Claim a press on the selected measurement's grip before OrbitControls or the Editor sees it. Armed or not: a saved measurement's
   * selected grips are editable without creation mode. Unarmed, a press with Shift/Ctrl/Cmd stays camera navigation and an armed
   * Annotations tool keeps the canvas.
   */
  function onPointerDownCapture(ev) {
    if (active) keyboardModality = false;
    if (ev.button !== 0 || ev.isPrimary === false || drag || pending || !selectedId) return;
    if (!active && (ev.shiftKey || ev.ctrlKey || ev.metaKey || (typeof els.isAnnotationToolActive === 'function' && els.isAnnotationToolActive()))) return;
    const canvas = getCanvas();
    if (!canvas || ev.target !== canvas) return;
    const which = gripAt({ x: ev.clientX, y: ev.clientY });
    if (which) {
      ev.stopPropagation();
      ev.preventDefault();
      beginDrag(which, ev);
      return;
    }
    // Unarmed, the body (line or label) of the SELECTED measurement carries the whole measurement. A grip, above, wins; a measurement
    // that is not selected takes no press (the Editor selects it on a click), and an armed tool keeps its own gestures.
    if (active) return;
    const hit = lineHitAt(ev.clientX, ev.clientY, ev.pointerType);
    if (!hit || hit.id !== selectedId || !beginDrag('body', ev)) return;
    ev.stopPropagation();
    ev.preventDefault();
  }

  /** @returns {boolean} whether a drag began */
  function beginDrag(which, ev) {
    const record = records.find(item => item.id === selectedId);
    const result = results[records.indexOf(record)];
    if (!record) return false;
    const pack = currentPack();
    drag = {
      id: record.id, which, pointerId: ev.pointerId, candidate: null, dirty: false, startX: ev.clientX, startY: ev.clientY,
      poseKeys: [cargoPoseKey(pack, record.start), cargoPoseKey(pack, record.end)],
    };
    if (which === 'body') {
      if (!pack || !result || result.status !== MEASUREMENT_STATUS.VALID) {
        drag = null;
        return false;
      }
      // Both ends move along the one surface they share, measured from the press position on that plane; no shared surface, no move.
      const shared = rigidMoveFrame(record.start, record.end);
      const surface = shared.ok && !provisionalPoseActive() ? picker.beginDrawSurface({ anchor: record.start, face: shared.face }, pack) : null;
      const base = surface ? picker.sampleDrawPlane(surface, ev.clientX, ev.clientY) : null;
      Object.assign(drag, {
        shape: JSON.stringify([record.start, record.end]), packId: pack.id, surface, shared: shared.ok,
        base: base && base.status === 'ok' ? { u: base.u, v: base.v } : null, moved: false, du: 0, dv: 0, valid: true, pair: null,
      });
      drag.movable = Boolean(drag.base);
    }
    lastClient = { x: ev.clientX, y: ev.clientY };
    press = null;
    const canvas = getCanvas();
    try {
      if (canvas && typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(ev.pointerId);
    } catch (_) {
      // Capture is a convenience; the window listeners below still end the drag.
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragCancel);
    updateCursor();
    // Grabbing a grip replaces any stale "saved/updated" message with the drag guidance.
    setStatus('', { sticky: true });
    return true;
  }

  function onDragMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (drag.which === 'body') {
      // The primary no longer held (the release was lost), or another button joined the press, ends the move.
      if (ev.pointerType !== 'touch' && ev.buttons !== 1) {
        cancelDrag('Move cancelled.');
        return;
      }
      if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) >= CLICK_DRAG_THRESHOLD_PX) {
        drag.moved = true;
        if (!drag.movable) notice(drag.shared ? 'This measurement cannot be moved right now.' : BODY_MOVE_UNSUPPORTED);
      }
    }
    lastClient = { x: ev.clientX, y: ev.clientY };
    drag.dirty = true;
  }

  /**
   * Where the pointer is on the measurement's shared surface and whether the WHOLE measurement may sit there: the offset from the press,
   * snapped to the grid, judged by the writer's own rule without writing. A pointer off the 3D view or a ray that misses the plane is a
   * position the measurement cannot take.
   */
  function judgeBodyMove(d, x, y) {
    if (!insideCanvas(x, y)) return { status: 'off', du: d.du, dv: d.dv, valid: false };
    const sample = picker.sampleDrawPlane(d.surface, x, y);
    if (sample.status === 'provisional') return { status: 'provisional' };
    if (sample.status !== 'ok') return { status: 'off', du: d.du, dv: d.dv, valid: false };
    const du = Math.round((sample.u - d.base.u) * 100) / 100 + 0;
    const dv = Math.round((sample.v - d.base.v) * 100) / 100 + 0;
    return { status: 'ok', du, dv, valid: Boolean(PackLibrary.checkMeasurementMove(d.packId, d.id, du, dv).ok) };
  }

  /** Each frame while the body is carried: the pointer's latest position is judged once, and the preview pair follows the offset. */
  function advanceBodyMove() {
    if (!drag || drag.which !== 'body' || !drag.moved || !drag.movable || !drag.dirty || !lastClient) return;
    drag.dirty = false;
    const judged = judgeBodyMove(drag, lastClient.x, lastClient.y);
    if (judged.status === 'provisional') {
      cancelDrag(HELD_POSE_NOTICE);
      return;
    }
    const record = records.find(item => item.id === drag.id);
    if (!record) return;
    if (judged.du !== drag.du || judged.dv !== drag.dv || !drag.pair) {
      drag.du = judged.du;
      drag.dv = judged.dv;
      drag.pair = translateAnchorPair(record.start, record.end, drag.du, drag.dv);
    }
    if (judged.valid !== drag.valid) {
      drag.valid = judged.valid;
      renderPanel();
    }
  }

  /** Write the finished whole-measurement move, once, if everything it was measured against is still as it was; otherwise leave it. */
  function finishBodyMove(finished, ev) {
    if (!finished.moved || !finished.movable) return; // a still press does nothing; an unmovable one already said why
    if (!insideCanvas(ev.clientX, ev.clientY)) {
      setStatus('Move cancelled.');
      return;
    }
    const pack = currentPack();
    const index = records.findIndex(item => item.id === finished.id);
    const record = records[index];
    const result = results[index];
    if (!pack || pack.id !== finished.packId || !record || !result || result.status !== MEASUREMENT_STATUS.VALID ||
        JSON.stringify([record.start, record.end]) !== finished.shape) {
      setStatus('The measurement changed, so the move was cancelled.');
      return;
    }
    if ([record.start, record.end].some((anchor, i) => cargoPoseKey(pack, anchor) !== finished.poseKeys[i])) {
      setStatus('The cargo changed, so the move was cancelled.');
      return;
    }
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    // The release position decides, not the last frame's.
    const judged = judgeBodyMove(finished, ev.clientX, ev.clientY);
    if (judged.status === 'provisional') {
      notice(HELD_POSE_NOTICE);
      return;
    }
    if (judged.status !== 'ok' || !judged.valid) {
      notice(BODY_MOVE_REFUSED);
      return;
    }
    if (!judged.du && !judged.dv) {
      setStatus('The measurement was left where it was.');
      return;
    }
    const outcome = PackLibrary.moveMeasurement(pack.id, record.id, judged.du, judged.dv);
    if (!outcome.ok) {
      if (outcome.reason === 'invalid' || outcome.reason === 'unresolved') notice(BODY_MOVE_REFUSED);
      else UIComponents.showToast('Could not move this measurement.', 'error', { title: 'Measurements' });
      return;
    }
    setStatus(outcome.unchanged ? 'The measurement was left where it was.' : 'Measurement moved.', { tone: 'success' });
  }

  function onDragUp(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const finished = drag;
    lastClient = { x: ev.clientX, y: ev.clientY };
    const travelled = Math.hypot(ev.clientX - finished.startX, ev.clientY - finished.startY);
    endDrag();
    hoverDirty = true;
    if (finished.which === 'body') {
      finishBodyMove(finished, ev);
      return;
    }
    // While creating, a press on a grip that never moved is an ordinary click: it places a point, so a new
    // measurement can begin at the corner of the selected one. Unarmed, it is nothing at all.
    if (travelled <= CLICK_DRAG_THRESHOLD_PX) {
      if (active) placePoint(ev.clientX, ev.clientY);
      return;
    }
    // Released outside the 3D view (over the toolbar, a panel's edge or off the window): the move is cancelled, never resolved
    // against whatever surface the ray happens to meet far away.
    if (!insideCanvas(ev.clientX, ev.clientY)) {
      setStatus('Move cancelled.');
      return;
    }
    // The release position decides: resolve it freshly instead of trusting the last frame's pick.
    const outcome = {};
    commitMove(finished, blockedReason() ? null : pick(ev.clientX, ev.clientY, outcome), outcome.blocked);
  }

  function onDragCancel(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    cancelDrag('Move cancelled.');
  }

  /** Stop the gesture and release pointer ownership. Writes nothing. */
  function endDrag() {
    if (!drag) return;
    const canvas = getCanvas();
    try {
      if (canvas && typeof canvas.releasePointerCapture === 'function' && canvas.hasPointerCapture(drag.pointerId)) {
        canvas.releasePointerCapture(drag.pointerId);
      }
    } catch (_) {
      // Already released.
    }
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    drag = null;
    syncInputListeners();
    updateCursor();
  }

  /** Abandon the drag; the endpoint is simply never changed, so there is nothing to restore. */
  function cancelDrag(message = '') {
    if (!drag) return;
    endDrag();
    hoverDirty = true;
    if (message) setStatus(message);
    else renderPanel();
  }

  /** Persist a finished drag as one measurement-only edit, or leave the measurement untouched. */
  function commitMove(finished, picked, blocked = null) {
    const pack = currentPack();
    const index = records.findIndex(item => item.id === finished.id);
    const record = records[index];
    const result = results[index];
    if (!pack || !record || !result || result.status !== MEASUREMENT_STATUS.VALID) {
      setStatus('The measurement changed, so the move was cancelled.');
      return;
    }
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    if (!picked) {
      notice(`${PICK_REFUSAL_NOTICE[blocked] || 'Nothing to measure there.'} The point was left where it was.`);
      return;
    }
    const moving = finished.which === 'start' ? result.start : result.end;
    const fixedEnd = finished.which === 'start' ? result.end : result.start;
    const target = worldVectorToInches(picked.world);
    if (measureBetween(moving, target).distance < MIN_MOVE_INCHES) return; // released where it started
    if (measureBetween(fixedEnd, target).distance < MIN_SEGMENT_INCHES) {
      setStatus('Pick a different point.');
      return;
    }
    const outcome = PackLibrary.moveMeasurementEndpoint(pack.id, record.id, finished.which, picked.anchor);
    if (!outcome.ok) {
      UIComponents.showToast('Could not move this point.', 'error', { title: 'Measurements' });
      return;
    }
    setStatus('Measurement updated.', { tone: 'success' });
  }

  // ==========================================================================
  // SECTION: KEYBOARD OWNERSHIP (capture phase, only while active)
  // ==========================================================================
  function isTypingTarget(target) {
    if (!target || !target.matches) return false;
    if (target.isContentEditable) return true;
    return target.matches('input, textarea, select');
  }

  /**
   * One Escape leaves the mode. An unfinished Point A or endpoint drag is dropped first (nothing is
   * written) by the regular exit routine; saved measurements stay. The event is consumed so cargo
   * deselection, the mobile drawers and the other Escape handlers never see it. Focus is never sent
   * to the ruler: if it sat in the panel that is about to hide, or on the ruler itself, it returns to
   * the 3D viewport so cargo shortcuts keep working. The viewport shows its focus ring only when the
   * keyboard was the input in use; after mouse use the Escape press itself must not paint a frame
   * around the whole 3D view (the browser would, because the last event was a key press).
   */
  function exitFromEscape(ev) {
    const focused = doc ? doc.activeElement : null;
    const needsFocus = !focused || focused === doc.body || focused === els.button ||
      Boolean(els.panel && els.panel.contains(focused));
    ev.preventDefault();
    ev.stopPropagation();
    exit();
    const viewport = els.viewport;
    if (needsFocus && viewport && typeof viewport.focus === 'function') {
      if (!keyboardModality && viewport.classList) {
        // The viewport's own pointer-focus marker (see #viewport:focus-visible in main.css), dropped on blur.
        viewport.classList.add('tp3d-pointer-focus');
        viewport.addEventListener('focusout', () => viewport.classList.remove('tp3d-pointer-focus'), { once: true });
      }
      viewport.focus({ preventScroll: true });
    }
  }

  function onKeyDownCapture(ev) {
    if (!active && !selectedId && !drag) return;
    if (active && ev.key !== 'Escape' && !['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) keyboardModality = true;
    if (ev.defaultPrevented) return;
    if (UIComponents.modalOwnership && UIComponents.modalOwnership.blocksKeyboardEvent(ev)) return;
    if (!inEditor() || isTypingTarget(ev.target)) return;
    const key = String(ev.key || '').toLowerCase();
    if (key === 'escape') {
      // A popover that owns Escape (the load-status popover) closes first; the next Escape exits.
      if (typeof els.escapeOwnedElsewhere === 'function' && els.escapeOwnedElsewhere()) return;
      if (active) {
        exitFromEscape(ev);
        return;
      }
      // Creation is off: Escape drops a grip drag first, then the selection. Deleting stays on the manager's row.
      ev.preventDefault();
      ev.stopPropagation();
      if (drag) cancelDrag('Move cancelled.');
      else clearSelection();
      return;
    }
    // Undo / Redo mid-gesture cancels only that gesture; cargo history is untouched.
    if (key === 'z' && (ev.metaKey || ev.ctrlKey) && !ev.altKey && (drag || pending)) {
      if (drag) {
        cancelDrag('Move cancelled.');
      } else {
        cancelPending('Measurement cancelled.');
      }
      ev.preventDefault();
    }
  }

  // ==========================================================================
  // SECTION: PANEL POSITION (drag by the header grip, like the AutoPack Results panel)
  // ==========================================================================
  /** Keep the whole panel inside its host, whatever its current (expanded or collapsed) size. */
  function clampPanelPosition(position) {
    const host = panelHost();
    const panel = els.panel;
    if (!host || !panel || !position) return null;
    // left/top are measured inside the host's border, so size against its inner (client) box.
    const maxX = Math.max(PANEL_MARGIN_PX, host.clientWidth - panel.offsetWidth - PANEL_MARGIN_PX);
    const maxY = Math.max(PANEL_MARGIN_PX, host.clientHeight - panel.offsetHeight - PANEL_MARGIN_PX);
    return {
      x: Math.min(Math.max(Number(position.x) || 0, PANEL_MARGIN_PX), maxX),
      y: Math.min(Math.max(Number(position.y) || 0, PANEL_MARGIN_PX), maxY),
    };
  }

  /**
   * Place the panel at the dragged position (clamped to what fits right now) or at its default
   * spot. The preferred position is kept as dragged, so a panel pushed in by a small window or by
   * expanding returns toward it when there is room again.
   */
  function applyPanelPosition() {
    const panel = els.panel;
    if (!panel || panel.hidden) return;
    if (!panelPosition) {
      if (panel.classList.contains('is-dragged')) {
        panel.classList.remove('is-dragged');
        panel.style.left = '';
        panel.style.top = '';
      }
      return;
    }
    const next = clampPanelPosition(panelPosition);
    if (!next) return;
    panel.classList.add('is-dragged');
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
  }

  /**
   * A dragged panel never settles over the other manager: after a drag, a layout change or an opening, the screen names a clear
   * spot (`{ x, y }` in this host) or asks for the default place (`'reset'`). Nothing moves when the panel is already clear.
   */
  function settle() {
    if (!els.panel || els.panel.hidden || typeof els.avoidOther !== 'function') return;
    const spot = els.avoidOther(els.panel);
    if (spot === 'reset') panelPosition = null;
    else if (spot) panelPosition = clampPanelPosition(spot);
    else return;
    applyPanelPosition();
  }

  function attachPanelDrag(handle) {
    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || !els.panel) return;
      const host = panelHost();
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const panelRect = els.panel.getBoundingClientRect();
      const start = {
        pointerX: ev.clientX,
        pointerY: ev.clientY,
        left: panelRect.left - hostRect.left - host.clientLeft,
        top: panelRect.top - hostRect.top - host.clientTop,
      };
      let moved = false;
      const onMove = moveEv => {
        const dx = moveEv.clientX - start.pointerX;
        const dy = moveEv.clientY - start.pointerY;
        if (!moved && Math.hypot(dx, dy) < PANEL_DRAG_THRESHOLD_PX) return;
        if (!moved) {
          moved = true;
          els.panel.classList.add('is-dragging');
        }
        moveEv.preventDefault();
        panelPosition = clampPanelPosition({ x: start.left + dx, y: start.top + dy });
        applyPanelPosition();
      };
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        if (els.panel) els.panel.classList.remove('is-dragging');
        if (!moved) return;
        settle();
        // The click that follows a drag released over the title must not toggle the panel.
        suppressToggleClick = true;
        window.setTimeout(() => { suppressToggleClick = false; }, 0);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    });
  }

  // ==========================================================================
  // SECTION: PANEL (compact, collapsible list; updated in place so a click is never lost)
  // ==========================================================================
  function ensurePanel() {
    if (panelParts && panelParts.root === els.panel && els.panel.contains(panelParts.head)) return panelParts;
    if (!els.panel || !doc) return null;
    const head = doc.createElement('div');
    head.className = 'tp3d-measure-panel__head';
    // 2x3 dot-grid grip, identical in look to the AutoPack Results grip. Decorative: the header drags.
    const grip = doc.createElement('span');
    grip.className = 'tp3d-measure-panel__grip';
    grip.setAttribute('aria-hidden', 'true');
    for (let dot = 0; dot < 6; dot += 1) {
      const dotEl = doc.createElement('span');
      dotEl.className = 'tp3d-measure-panel__grip-dot';
      grip.appendChild(dotEl);
    }
    const toggleButton = doc.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'tp3d-measure-panel__toggle';
    toggleButton.setAttribute('aria-controls', 'editor-measure-panel-body');
    const title = doc.createElement('span');
    title.className = 'tp3d-measure-panel__title';
    title.textContent = 'Measurements';
    const count = doc.createElement('span');
    count.className = 'tp3d-measure-panel__count';
    // Far right like the AutoPack Results header: chevron up collapses, chevron down restores.
    const chevron = doc.createElement('i');
    chevron.className = 'fa-solid fa-chevron-up tp3d-measure-panel__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    toggleButton.append(title, count, chevron);
    toggleButton.addEventListener('click', () => {
      // A drag that began on the title must not also collapse or expand the panel.
      if (suppressToggleClick) return;
      panelCollapsed = !panelCollapsed;
      renderPanel();
    });
    head.append(grip, toggleButton);
    attachPanelDrag(head);

    const body = doc.createElement('div');
    body.className = 'tp3d-measure-panel__body';
    body.id = 'editor-measure-panel-body';
    const hint = doc.createElement('div');
    hint.className = 'tp3d-measure-panel__hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    const warning = doc.createElement('div');
    warning.className = 'tp3d-measure-panel__notice';
    warning.hidden = true;
    warning.textContent = "Some saved measurements couldn't be read. The original data is kept until you delete it.";
    const list = doc.createElement('ul');
    list.className = 'tp3d-measure-panel__list';
    const newButton = doc.createElement('button');
    newButton.type = 'button';
    newButton.id = 'editor-measure-new';
    newButton.className = 'tp3d-measure-panel__new';
    newButton.setAttribute('aria-pressed', 'false');
    const newIcon = doc.createElement('i');
    newIcon.className = 'fa-solid fa-plus';
    newIcon.setAttribute('aria-hidden', 'true');
    newButton.append(newIcon, doc.createTextNode(' '), doc.createElement('span'));
    newButton.addEventListener('click', startFromPanel);
    body.append(newButton, hint, warning, list);

    els.panel.replaceChildren(head, body);
    rows.clear();
    panelParts = { root: els.panel, head, toggle: toggleButton, chevron, count, body, hint, warning, list, newButton };
    return panelParts;
  }

  function iconButton(className, iconClass) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `tp3d-measure-row__btn ${className}`;
    const icon = doc.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    return button;
  }

  function startRename(id) {
    const reason = blockedReason();
    if (reason) {
      setStatus(blockedMessage(reason));
      return;
    }
    renamingId = id;
    renderPanel();
    const row = rows.get(id);
    if (row && row.input) {
      row.input.focus();
      row.input.select();
    }
  }

  function finishRename(id, value, commit) {
    if (renamingId !== id) return;
    renamingId = null;
    const pack = currentPack();
    if (commit && pack && !blockedReason()) PackLibrary.renameMeasurement(pack.id, id, value);
    renderPanel();
  }

  /**
   * A single click deletes: no confirm step. The row is removed in place. Focus only moves on when
   * the delete came from the keyboard, so a mouse click never leaves a focus ring behind.
   */
  function removeMeasurement(id, viaKeyboard = false) {
    const reason = blockedReason();
    if (reason) {
      setStatus(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    if (!pack) return;
    const index = records.findIndex(record => record.id === id);
    if (selectedId === id) setSelected(null);
    if (renamingId === id) renamingId = null;
    if (drag && drag.id === id) cancelDrag();
    const outcome = PackLibrary.deleteMeasurement(pack.id, id);
    if (!outcome.ok) {
      renderPanel();
      return;
    }
    setStatus('');
    UIComponents.showToast('Measurement deleted.', 'info', { title: 'Measurements' });
    if (!viaKeyboard) return;
    // Keep keyboard focus in the panel: the next row, else the previous, else the header.
    const next = records[Math.min(index, records.length - 1)];
    const row = next ? rows.get(next.id) : null;
    const target = row && !row.select.disabled ? row.select : (panelParts && panelParts.toggle);
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function createRow() {
    const el = doc.createElement('li');
    el.className = 'tp3d-measure-row';
    const select = doc.createElement('button');
    select.type = 'button';
    select.className = 'tp3d-measure-row__select';
    const name = doc.createElement('span');
    name.className = 'tp3d-measure-row__name';
    const value = doc.createElement('span');
    value.className = 'tp3d-measure-row__value';
    select.append(name, value);
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'tp3d-measure-row__input';
    input.maxLength = 60;
    input.hidden = true;
    const rename = iconButton('tp3d-measure-row__rename', 'fa-solid fa-pen');
    const remove = iconButton('tp3d-measure-row__delete', 'fa-solid fa-trash-can');
    const issue = doc.createElement('div');
    issue.className = 'tp3d-measure-row__issue';
    issue.hidden = true;
    el.append(select, input, rename, remove, issue);
    const row = { el, select, name, value, input, rename, remove, issue, id: null, renaming: false };
    select.addEventListener('click', () => selectMeasurement(selectedId === row.id ? null : row.id));
    rename.addEventListener('click', () => startRename(row.id));
    // A click event with detail 0 is a keyboard activation (Enter / Space).
    remove.addEventListener('click', ev => removeMeasurement(row.id, ev.detail === 0));
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finishRename(row.id, input.value, true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finishRename(row.id, input.value, false);
      }
    });
    input.addEventListener('blur', () => finishRename(row.id, input.value, true));
    return row;
  }

  function updateRow(row, record, result, index, blocked) {
    row.id = record.id;
    row.el.dataset.measurementId = record.id;
    const unreadable = record.type === MEASUREMENT_TYPE_UNREADABLE;
    const title = unreadable ? 'Unreadable measurement' : (record.label || defaultMeasurementName(index));
    if (row.name.textContent !== title) row.name.textContent = title;
    const valid = Boolean(result && result.status === MEASUREMENT_STATUS.VALID);
    const status = result ? result.status : MEASUREMENT_STATUS.UNRESOLVED;
    const valueText = valid ? formatMeasurementLength(result.distance, lengthUnit) : measurementStatusLabel(status);
    if (row.value.textContent !== valueText) row.value.textContent = valueText;
    row.value.classList.toggle('is-needs-review', !valid && status === MEASUREMENT_STATUS.NEEDS_REVIEW);
    row.value.classList.toggle('is-unresolved', !valid && status !== MEASUREMENT_STATUS.NEEDS_REVIEW);

    const selected = record.id === selectedId;
    row.el.classList.toggle('is-selected', selected);
    row.select.disabled = unreadable;
    row.select.setAttribute('aria-pressed', selected ? 'true' : 'false');
    row.select.setAttribute('aria-label', unreadable ? title : `${title}, ${valueText}${selected ? ', selected' : ''}`);
    row.select.title = unreadable ? '' : 'Select to show its endpoints, then drag an endpoint to move it';

    const renaming = renamingId === record.id && !unreadable;
    row.select.hidden = renaming;
    row.input.hidden = !renaming;
    if (renaming && !row.renaming) {
      row.input.value = record.label || '';
      row.input.placeholder = defaultMeasurementName(index);
      row.input.setAttribute('aria-label', 'Measurement name');
    }
    row.renaming = renaming;

    row.rename.hidden = unreadable;
    row.rename.disabled = blocked;
    row.rename.setAttribute('aria-label', `Rename ${title}`);
    row.rename.title = 'Rename';
    row.remove.disabled = blocked;
    row.remove.setAttribute('aria-label', `Delete ${title}`);
    row.remove.title = 'Delete';

    const issueText = valid ? '' : describeMeasurementReason(result ? result.reason : 'unreadable');
    if (row.issue.textContent !== issueText) row.issue.textContent = issueText;
    row.issue.hidden = !issueText;
  }

  /** Context-sensitive guidance: empty unless something is relevant right now. */
  function guidanceText(blockedNow) {
    if (blockedNow) return blockedMessage(blockedNow);
    if (statusMessage) return statusMessage;
    if (drag) return drag.which === 'body' ? (drag.valid ? BODY_MOVE_TEXT.ok : BODY_MOVE_TEXT.off) : 'Drag to a new position. Esc cancels.';
    if (pending) return 'Click the second point. Esc cancels.';
    if (records.length >= MAX_MEASUREMENTS_PER_PACK) return `Limit of ${MAX_MEASUREMENTS_PER_PACK} measurements reached. Delete one to add another.`;
    if (!active) return records.length ? '' : 'No measurements yet. Choose New measurement to add one.';
    if (!records.length) return 'Click two points to measure a distance.';
    return '';
  }

  /** Colour of the dot beside the guidance: orange while a gesture is under way or something needs attention, green after a save. */
  function guidanceTone(blockedNow) {
    if (blockedNow) return 'active';
    if (statusMessage) return statusTone || (pending || drag ? 'active' : '');
    if (pending || drag || records.length >= MAX_MEASUREMENTS_PER_PACK) return 'active';
    return '';
  }

  function renderPanel() {
    if ((!active && !managerOpen) || !doc) return;
    const parts = ensurePanel();
    if (!parts) return;
    const blockedNow = blockedReason();

    const countText = records.length ? String(records.length) : ''; // no badge for zero
    if (parts.count.textContent !== countText) parts.count.textContent = countText;
    syncNewButton();
    parts.newButton.disabled = Boolean(blockedNow);
    parts.toggle.setAttribute('aria-expanded', panelCollapsed ? 'false' : 'true');
    const chevronClass = `fa-solid fa-chevron-${panelCollapsed ? 'down' : 'up'} tp3d-measure-panel__chevron`;
    if (parts.chevron.className !== chevronClass) parts.chevron.className = chevronClass;
    parts.root.classList.toggle('is-collapsed', panelCollapsed);
    parts.body.hidden = panelCollapsed;
    const hintText = guidanceText(blockedNow);
    if (parts.hint.textContent !== hintText) parts.hint.textContent = hintText;
    const hintTone = guidanceTone(blockedNow);
    if ((parts.hint.dataset.tone || '') !== hintTone) {
      if (hintTone) parts.hint.dataset.tone = hintTone;
      else delete parts.hint.dataset.tone;
    }
    parts.warning.hidden = !records.some(record => record.type === MEASUREMENT_TYPE_UNREADABLE);

    const seen = new Set();
    records.forEach((record, index) => {
      let row = rows.get(record.id);
      if (!row) {
        row = createRow();
        rows.set(record.id, row);
      }
      updateRow(row, record, results[index], index, Boolean(blockedNow));
      if (parts.list.children[index] !== row.el) parts.list.insertBefore(row.el, parts.list.children[index] || null);
      seen.add(record.id);
    });
    rows.forEach((row, id) => {
      if (seen.has(id)) return;
      row.el.remove();
      rows.delete(id);
    });
    applyPanelPosition(); // rows or collapsing change the panel size: keep it inside the viewport
  }

  // ==========================================================================
  // SECTION: SYNC + LIFECYCLE
  // ==========================================================================
  /** Re-derive validity from committed data. Cheap; called on render and on measurement writes. */
  function sync() {
    const pack = currentPack();
    const preferences = PreferencesManager.get();
    lengthUnit = (preferences.units || {}).length || 'in';
    toolShown = preferences.showMeasurementTool !== false;
    if (!pack || !inEditor()) {
      records = [];
      results = [];
      syncedPackId = null;
      cancelDrag();
      setSelected(null);
      if (active || managerOpen) closeManager();
      return;
    }
    records = PackLibrary.getMeasurements(pack);
    results = PackLibrary.resolveMeasurements(pack);
    syncedPackId = pack.id;
    if (selectedId && !records.some(record => record.id === selectedId)) setSelected(null);
    if (renamingId && !records.some(record => record.id === renamingId)) renamingId = null;
    if (pending && !pendingStillValid(pack)) {
      cancelPending('The cargo for Point A changed, so the measurement was cancelled.');
    }
    if (drag) {
      const index = records.findIndex(record => record.id === drag.id);
      if (index === -1 || !results[index] || results[index].status !== MEASUREMENT_STATUS.VALID) {
        cancelDrag('The measurement changed, so the move was cancelled.');
      } else {
        const poseKeys = [cargoPoseKey(pack, records[index].start), cargoPoseKey(pack, records[index].end)];
        if (poseKeys.some((key, i) => key !== drag.poseKeys[i])) cancelDrag('The cargo changed, so the move was cancelled.');
        else if (drag.shape && JSON.stringify([records[index].start, records[index].end]) !== drag.shape) cancelDrag('The measurement changed, so the move was cancelled.');
      }
    }
    if (active || managerOpen) renderPanel();
    ensureLoop();
  }

  function pendingStillValid(pack) {
    const anchor = pending.anchor;
    const lookup = anchor.kind === 'cargo' ? lookupInstance(pack, anchor.instanceId) : null;
    const resolution = resolveAnchor(anchor, {
      getInstance: () => (lookup ? lookup.instance : null),
      getCase: id => CaseLibrary.getById(id),
      isInstanceAmbiguous: () => Boolean(lookup && lookup.ambiguous),
      floors: PackLibrary.getMeasurementFloors(pack),
      truck: pack.truck,
      zones: PackLibrary.getMeasurementZones(pack),
    });
    // Valid is not enough: the cargo must also still be posed as it was when Point A was picked on it.
    return resolution.status === MEASUREMENT_STATUS.VALID && cargoPoseKey(pack, anchor) === pending.poseKey;
  }

  /** Show or hide the ruler per Settings. Hiding it while active exits the mode and cancels any gesture. */
  function syncVisibility() {
    const show = PreferencesManager.get().showMeasurementTool !== false;
    toolShown = show;
    if (!show && (active || managerOpen)) closeManager();
    if (!show) {
      cancelDrag();
      setSelected(null);
    }
    if (els.button) els.button.hidden = !show;
    ensureLoop(); // showing the tool again brings its saved lines back; hiding it ends the view-only loop by itself
    return show;
  }

  function bind(elements) {
    els = { ...els, ...elements };
    if (bound) return;
    bound = true;
    StateStore.subscribe(changes => {
      if (changes._replace || !inEditor() || Object.prototype.hasOwnProperty.call(changes, 'currentPackId')) {
        if (active || managerOpen) {
          closeManager();
          return;
        }
        cancelDrag();
        setSelected(null);
        // Another Load Plan, a workspace swap or the Editor closing: the saved lines belong to the old one.
        if (syncedPackId !== null) {
          records = [];
          results = [];
          syncedPackId = null;
          disposeAllVisuals();
        }
        return;
      }
      // Cargo selected (or its selection rewritten) by anything but this tool: a measurement selected from the scene steps aside.
      if (selectedId && !selfClearing && Object.prototype.hasOwnProperty.call(changes, 'selectedInstanceIds')) clearSelection();
      if (!active && !managerOpen && !drag) return;
      if (changes._undo || changes._redo) {
        if (drag) cancelDrag('Undo or redo cancelled the move.');
        cancelPending('Undo or redo cancelled the unfinished measurement.');
      }
    });
    if (OperationLifecycle && typeof OperationLifecycle.subscribe === 'function') {
      OperationLifecycle.subscribe(() => {
        if (active || drag) syncBlocked();
      });
    }
  }

  // Leaves the mode and removes the overlay. The two store subscriptions registered once by bind() belong
  // to the application-lifetime singleton (it is created once in app.js and never torn down), so they stay.
  function destroy() {
    exit();
    stopLoop();
    records = [];
    results = [];
    syncedPackId = null;
    disposeAllVisuals();
    if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
    svg = null;
  }

  return {
    bind,
    sync,
    syncVisibility,
    toggle,
    exit,
    destroy,
    openManager,
    closeManager,
    cancelCreation,
    settle,
    isManagerOpen: () => managerOpen,
    isActive: () => active,
    hasPending: () => Boolean(pending),
    // Saved-record editing is separate from creation: the Editor selects a measurement on a click on its line, and asks who holds a grip drag.
    select: selectMeasurement,
    selectedId: () => selectedId,
    clearSelection,
    lineHitAt,
    ownsPointer,
    onPointerDown,
    onPointerMove,
    onPointerCancel,
    onPointerUp,
    onDoubleClick,
  };
}
