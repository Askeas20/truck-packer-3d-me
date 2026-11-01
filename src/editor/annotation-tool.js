/**
 * @file annotation-tool.js
 * @description Annotations controller (V1A callouts, V1B.1 directional arrows, V1B.2 freehand drawings): the
 *   Annotations panel, callout, arrow and drawing creation and editing, and the on-screen markers, labels, cards,
 *   arrows and strokes. THREE and DOM
 *   concerns live here; the data model, validation and
 *   anchor resolution live in core/annotations.js (on the Measurement anchor model), picking is the shared
 *   editor/surface-picker.js, the screen-space layout is core/annotation-layout.js, and persistence is
 *   PackLibrary. An annotation is informational: it never moves cargo, never takes part in collision,
 *   handling rules, assessment, AutoPack or any export, and moving a card never moves its anchor.
 *
 *   Ownership rules (see the V1A contract):
 *   - Markers and cards are a DOM/SVG layer above the canvas, so no canvas capture (Screenshot, PDF views,
 *     thumbnails, previews) can include them. Three.js stays authoritative for the camera and for where
 *     cargo is; the layer only projects what the scene displays.
 *   - Only one scene tool owns pointer input. While the Callout or Arrow tool (or a re-attach) is armed the
 *     Editor's pointer handlers delegate here instead of selecting or dragging cargo; OrbitControls is
 *     untouched, so orbit, pan and zoom stay available. The Measurement Tool and Annotations are mutually
 *     exclusive (the Editor wires that). Markers and cards are ordinary DOM, so clicking them never reaches
 *     the canvas.
 *   - Selecting an annotation clears the cargo selection and selecting cargo clears the annotation, so
 *     Delete acts on the annotation only when it owns the selection and never deletes cargo as a side
 *     effect. Undo and Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) are the shared StateStore history's: a committed
 *     annotation edit is one step in the same history as cargo and measurements, and an unfinished marker or
 *     card drag, re-attach, arrow tail or stroke is cancelled by them without writing. Deleting an annotation
 *     shows a notification toast only; the toast carries no Undo button of its own.
 *   - One Escape closes one owner, in this order: a modal, dropdown, text field or popover that owns it
 *     (they keep it), an unfinished drag, the editor card, a pending re-attach, a
 *     pending arrow tail, the armed tool, the annotation selection. Anything else is left to the existing
 *     handlers (cargo deselection, drawers).
 *   - An arrow is two surface anchors drawn as an SVG shaft and head in this same layer (never a Three.js
 *     object, so no capture can include it). It is drawn only while both ends resolve and it is long enough
 *     to read; its ends move only by the owner's grip drag or Re-attach. Placing one takes two clicks (tail,
 *     then head): the first click is an unsaved gesture that Escape, closing the panel, Show Off, an
 *     operation, Measurement Mode, a Load Plan change or a cargo pose change all drop without writing.
 *   - A freehand drawing is one polyline on one flat face or convex patch, stored as one record and drawn as SVG paths in this
 *     layer. While the Draw tool is armed in Draw mode a primary drag draws instead of orbiting: this tool turns OrbitControls'
 *     rotation off (only that property, and restores exactly what it found), and Move View gives the camera back. Shift/Ctrl/Cmd +
 *     drag, the wheel, the other mouse buttons and two-finger touch keep navigating. A stroke is an unsaved gesture owned by the one
 *     pointer that began it: it freezes at the surface's edge, behind an occluder, at the view's edge or across a gap and never
 *     resumes, and Escape, pointercancel, a second touch, a blur, a hidden page, a tool or mode switch, an operation, Measurement
 *     Mode, a Load Plan change, a cargo change or a provisional pose all drop it without writing. Releasing it writes at most one
 *     record through PackLibrary.addDraw, which owns every rule about the stroke itself (simplification, limits, placement).
 *   - Creating, editing, moving, hiding and deleting are disabled while AutoPack, Unpack, Truck Change, a
 *     Truck Change preview or a transient AutoPack preview is active, and the message names the cause; the
 *     graphics are hidden for the same reasons. The committed scene is the authority, so an open, minimized or
 *     closed AutoPack Results card over the committed layout never pauses anything: annotations stay visible
 *     and editable. Results is only a placement obstacle: cards, labels and the editor keep clear of it, and
 *     Annotations never open, close, minimize, apply or change it.
 *     Viewing and selecting stay available. A background thumbnail capture is a pixel readback, not an
 *     edit: it never blocks annotations or cancels an unfinished one.
 *   - Annotations stay drawn while the Measurement Tool owns the scene, but only as a view: markers and cards
 *     take no pointer or keyboard input until that mode ends (the Editor wires `isSceneToolOwnedElsewhere`).
 *   - Cargo anchors are only ever picked from, and resolved against, COMMITTED poses; while the Editor
 *     owns a provisional pose a pick on cargo is refused. Overlay positions follow the pose the scene
 *     displays so a marker never floats away from cargo that is being dragged or animated.
 *   - An unresolvable annotation stays stored and is listed with an explanation; it is never drawn at a
 *     fabricated position and never relocated. The only way an anchor changes is the owner's deliberate
 *     marker drag or Re-attach onto a supported surface.
 * @module editor/annotation-tool
 */

import {
  ANNOTATION_COLORS,
  annotationForegroundFor,
  isCustomAnnotationColor,
  ANNOTATION_STATUS,
  ANNOTATION_TYPE_ARROW,
  ANNOTATION_TYPE_CALLOUT,
  ANNOTATION_TYPE_DRAW,
  ANNOTATION_TYPE_UNREADABLE,
  ARROW_WIDTHS,
  CALLOUT_PRESETS,
  DEFAULT_ARROW_WIDTH,
  DEFAULT_DRAW_WIDTH,
  DEFAULT_LINE_STYLE,
  DRAW_MAX_RAW_VERTICES,
  DRAW_WIDTHS,
  LINE_STYLES,
  MAX_ANNOTATIONS_PER_PACK,
  MAX_ANNOTATION_NAME_LENGTH,
  MAX_CALLOUT_DESCRIPTION_LENGTH,
  MAX_CALLOUT_TITLE_LENGTH,
  MAX_CARD_OFFSET_PX,
  MIN_ARROW_LENGTH_INCHES,
  anchorSurfaceNormal,
  annotationStatusLabel,
  calloutNumbers,
  describeAnchorTarget,
  describeAnnotationReason,
  normalizeCalloutDescription,
  normalizeCalloutTitle,
} from '../core/annotations.js';
import {
  ARROW_SAMPLE_FRACTIONS,
  ARROW_SHAFT_PX,
  arrowPathData,
  arrowShape,
  autoPlace,
  cardBudget,
  cardWidth,
  clampRect,
  clipSegmentToConvex,
  clipSegmentToNear,
  distanceToPolyline,
  estimateCardHeight,
  fitEditorClear,
  fitLabels,
  fitPanelClear,
  fitSheet,
  isCompactViewport,
  LABEL_FLIP_MARGIN,
  leaderLine,
  offsetFromRect,
  overlapArea,
  panelBodyFlows,
  rectFromOffset,
  VIEWPORT_MARGIN,
} from '../core/annotation-layout.js';
import { cargoFaceFrame, drawAnchorUV, drawFrameKey, drawLift, patchContains, patchOutline, rigidMoveFrame, translateAnchorPair } from '../core/measurements.js';
import { createSurfacePicker } from './surface-picker.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAFT_ID = '__draft';
// A real mouse or trackpad click jitters a few pixels; anything larger is an orbit/pan drag.
const CLICK_DRAG_THRESHOLD_PX = 6;
const PIN_DRAG_THRESHOLD_PX = 5;
const CARD_DRAG_THRESHOLD_PX = 4;
const HOVER_PICK_INTERVAL_MS = 40;
const OCCLUSION_INTERVAL_MS = 100;
const STATUS_VISIBLE_MS = 3200;
const NOTICE_INTERVAL_MS = 1400;
const OFFSCREEN_MARGIN_PX = 30;
// Freehand strokes. A sample is taken when the pointer has moved this far on screen since the last one, and a jump
// larger than the gap limit between two samples freezes the stroke (something may have come between them). The pointer
// samples queue between frames and are verified a few at a time, so a fast drag never costs more than a frame's budget.
const DRAW_SAMPLE_MIN_PX = 4;
const DRAW_MAX_GAP_PX = 160;
const DRAW_PICKS_PER_FRAME = 8;
const DRAW_FLUSH_PICKS = 128;
const DRAW_QUEUE_LIMIT = 64;
const DRAW_EDGE_MIN_INCHES = 0.02; // an exit point closer than this to the last vertex adds nothing
const DRAW_CLIP_MARGIN_PX = 40; // strokes are clipped to the view plus this margin, so SVG coordinates stay small and finite
// A drawing's own look is in screen pixels, but its edge and its pattern follow how large the stroke is on screen: one that spans
// DRAW_FIT_SPAN_PX or more is drawn at full size, a smaller one down to DRAW_FIT_MIN of it (the line itself never changes weight).
const DRAW_FIT_SPAN_PX = 140;
const DRAW_FIT_MIN = 0.7;
// The extra width (px, both sides together) of the edge under a drawing's line: a neutral one that keeps it legible on any cargo, a
// fainter one for the dots of a Dotted line (no ring around each dot), and the selection's own accent edge, which grows a little with
// the line's weight (so a selected Thin, Regular and Bold stay distinguishable) rather than adding the same band to each.
// Never below DRAW_EDGE_FLOOR.
const DRAW_EDGE_PX = Object.freeze({ neutral: 3, dotted: 1.5, selected: 1.5 });
const DRAW_SELECTED_EDGE_PER_PX = 0.3;
const DRAW_EDGE_FLOOR_PX = 1.5;
const ARROW_DOTTED_HALO_PX = DRAW_EDGE_PX.dotted; // a Dotted arrow's neutral shaft edge in screen pixels, in total (as a Dotted drawing's)
const DRAW_OCCLUSION_RAYS_PER_STROKE = 5;
const DRAW_OCCLUSION_RAYS_PER_TICK = 60;
const PIN_RECT_PX = 24;
// The ray stops this far short of the marker, so the surface the marker sits on never hides it.
const OCCLUSION_STOP_INCHES = 0.5;
const ORTHO_RAY_LENGTH = 1e4;
const MARKER_ARM_PX = 6;
const PANEL_MARGIN_PX = 10;
const PANEL_DRAG_THRESHOLD_PX = 5;
const EDITOR_WIDTH_PX = 336;
const EDITOR_FALLBACK_HEIGHT_PX = 404;
const PANEL_SHEET_MAX_FRACTION = 0.46; // the compact panel's own max-height (styles/main.css)
const PANEL_LIMIT_PROPERTY = '--tp3d-annot-panel-limit'; // the desktop panel's extra max-height (styles/main.css)
const PANEL_MAX_HEIGHT_PX = 520; // the desktop panel's own max-height is min(this, the layer's height - the inset below)
const PANEL_MAX_HEIGHT_INSET_PX = 140;
const MIN_RAY_LENGTH = 1e-6;
const HELD_POSE_NOTICE = 'Place or cancel the held case before working with annotations on cargo.';
const AMBIGUOUS_CARGO_NOTICE = 'This cargo shares its ID with another item in the Load Plan, so a callout cannot be attached to it.';
const AMBIGUOUS_CARGO_ARROW_NOTICE = 'This cargo shares its ID with another item in the Load Plan, so an arrow cannot be attached to it.';
const PICK_REFUSAL_NOTICE = { provisional: HELD_POSE_NOTICE, ambiguous: AMBIGUOUS_CARGO_NOTICE };
const PICK_REFUSAL_NOTICE_ARROW = { provisional: HELD_POSE_NOTICE, ambiguous: AMBIGUOUS_CARGO_ARROW_NOTICE };
// Operations that only read pixels back never block or cancel annotation editing.
const PASSIVE_OPERATION_KINDS = new Set(['capturingPreview']);
// Annotations are paused (graphics hidden, editing refused) whenever something other than the committed scene
// is on screen or being rebuilt. The wording is deliberately short: it is a status, not an instruction.
const PAUSED_TEXT = Object.freeze({
  preview: 'Annotations paused during AutoPack preview.',
  autopacking: 'Annotations paused during AutoPack.',
  unpacking: 'Annotations paused during Unpack.',
  changingTruck: 'Annotations paused during truck change.',
  previewingTruckChange: 'Annotations paused during truck change preview.',
});
const COLOR_LABELS = Object.freeze({ ink: 'Ink', blue: 'Blue', green: 'Green', red: 'Red', violet: 'Violet' });
const DRAW_VIEWS = Object.freeze([['draw', 'Draw'], ['move', 'Move View']]);
const DISPLAY_MODES = Object.freeze([['markers', 'Markers'], ['labels', 'Labels'], ['cards', 'Cards']]);
const SHOW_MODES = Object.freeze([['all', 'All'], ['selected', 'Selected'], ['off', 'Off']]);
const DEFAULT_CUSTOM_COLOR = '#e11d8f';
const ARROW_WIDTH_LABELS = Object.freeze({ thin: 'Thin', regular: 'Regular', bold: 'Bold' });
const LINE_STYLE_LABELS = Object.freeze({ solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' });
const ARROW_END_NAMES = Object.freeze({ start: 'tail', end: 'head' });
const ARROW_HINT_TAIL = 'Click cargo, the truck or the ground to place the arrow tail.';
const ARROW_HINT_HEAD = 'Click where the arrow should point. You can orbit first. Esc cancels.';
// The shared reason copy says "callout"; an arrow reports each of its two ends on its own.
const ARROW_END_REASON_TEXT = Object.freeze({
  'cargo-missing': 'The cargo this end was attached to is no longer in this Load Plan.',
  'cargo-ambiguous': 'More than one cargo item in this Load Plan has the same ID, so the cargo this end belongs to cannot be identified.',
  'case-missing': 'The Case definition for this cargo is missing, so where this end points cannot be checked.',
  'case-changed': 'The Case size or shape changed, so this end may no longer point to the right place.',
  'pose-invalid': 'The cargo position or orientation could not be read.',
  'floor-missing': 'The floor surface for this end no longer exists.',
  'floor-changed': 'The floor at this spot has changed.',
  'truck-changed': 'The truck changed after this end was placed.',
  'truck-unverified': 'The truck this end was placed on cannot be confirmed.',
  'point-invalid': 'The position of this end could not be calculated.',
});
const arrowEndReason = reason => ARROW_END_REASON_TEXT[reason] || 'This end could not be checked.';
const DRAW_HINT = 'Drag across cargo, the truck or the ground to draw. Shift, Ctrl or Cmd + drag moves the view.';
const DRAW_HINT_MOVE = 'Move View: drag to orbit. Choose Draw to draw again.';
const DRAW_HINT_STROKING = 'Drawing. Release to save it, or press Esc to cancel.';
const DRAW_FROZEN_TEXT = Object.freeze({
  edge: 'The drawing stopped at the edge of the surface. Release to save it.',
  blocked: 'The drawing stopped where something is in the way. Release to save it.',
  view: 'The drawing stopped at the edge of the view. Release to save it.',
  gap: 'The drawing stopped because the pointer moved too fast. Release to save it.',
  limit: 'The drawing reached its length limit. Release to save it.',
});
const MOVE_GRID_STEPS = 100; // a whole-stroke move is snapped to the 0.01 in grid the stored vertices live on
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });
// How far from the centre of a saved stroke's line (px) a press still takes the stroke: a finger needs more room than a mouse.
const DRAW_HIT_REACH_PX = Object.freeze({ mouse: 7, pen: 9, touch: 12 });
const HELD_POINTER_EVENTS = Object.freeze(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']);
const DRAW_MOVE_TEXT = Object.freeze({
  ok: 'Release to move the drawing here. Esc cancels.',
  off: 'Part of the drawing would leave its surface. Release to leave it where it was, or press Esc.',
  view: 'Move the pointer back over the surface. Release to leave the drawing where it was, or press Esc.',
});
const DRAW_MOVE_REFUSED = 'The whole drawing has to stay on its surface, so it was left where it was.';
const ARROW_MOVE_TEXT = Object.freeze({
  ok: 'Release to move the arrow here. Esc cancels.',
  off: 'Part of the arrow would leave its surface. Release to leave it where it was, or press Esc.',
  view: 'Move the pointer back over the surface. Release to leave the arrow where it was, or press Esc.',
});
const ARROW_MOVE_REFUSED = 'The whole arrow has to stay on its surface, so it was left where it was.';
const ARROW_MOVE_UNSUPPORTED = 'This arrow\'s ends are on different surfaces, so it can only be moved one end at a time. Drag a handle.';
const AMBIGUOUS_CARGO_DRAW_NOTICE = 'This cargo shares its ID with another item in the Load Plan, so a drawing cannot be made on it.';
const UNSUPPORTED_DRAW_NOTICE = 'Drawings go on cargo faces and end caps, the truck and the ground. Curved sides and open space cannot take one.';
// The shared reason copy says "callout"; a drawing describes its own surface.
const DRAW_REASON_TEXT = Object.freeze({
  'cargo-missing': 'The cargo this drawing was on is no longer in this Load Plan. It is kept as drawn; delete it, or restore the cargo to see it again.',
  'cargo-ambiguous': 'More than one cargo item in this Load Plan has the same ID, so the cargo this drawing belongs to cannot be identified.',
  'case-missing': 'The Case definition for this cargo is missing, so where this drawing sits cannot be checked.',
  'case-changed': 'The Case size or shape changed, so this drawing may no longer sit on the right surface.',
  'pose-invalid': 'The cargo position or orientation could not be read.',
  'floor-missing': 'The floor surface this drawing was on no longer exists.',
  'floor-changed': 'The floor under this drawing has changed.',
  'truck-changed': 'The truck changed after this drawing was made.',
  'truck-unverified': 'The truck this drawing was made on cannot be confirmed.',
  'point-invalid': 'The position of this drawing could not be calculated.',
});
const drawReason = reason => DRAW_REASON_TEXT[reason] || describeAnnotationReason(reason) || 'This drawing could not be checked.';
const SHOW_OFF_HINT = 'Annotations are hidden in the view. Choose All or Selected to place, select or edit callouts.';
const TOOL_DEFS = Object.freeze([
  { key: 'callout', label: 'Callout', icon: 'fa-solid fa-location-dot', available: true },
  { key: 'arrow', label: 'Arrow', icon: 'fa-solid fa-arrow-right', available: true },
  { key: 'draw', label: 'Draw', icon: 'fa-solid fa-pen', available: true },
]);

export function createAnnotationTool({
  SceneManager,
  CaseScene,
  CaseLibrary,
  PackLibrary,
  StateStore,
  UIComponents,
  OperationLifecycle = null,
  PreferencesManager = null,
  doc = typeof document !== 'undefined' ? document : null,
}) {
  // ==========================================================================
  // SECTION: STATE
  // ==========================================================================
  let els = { button: null, panel: null, layer: null, viewport: null };
  let bound = false;
  let toolShown = true; // Settings > Show Annotations (default On); a visibility switch only, never a data change
  let panelOpen = false;
  let tool = null; // 'callout' | 'arrow' | 'draw' while that tool is armed
  let reattachId = null; // a callout (or an arrow end) whose marker is waiting for a new surface
  let reattachWhich = null; // 'start' | 'end' when that pending re-attach belongs to an arrow
  let arrowTail = null; // the first click of a new arrow, waiting for its head: { anchor, world, poseKey }
  let arrowStyle = { color: 'ink', width: DEFAULT_ARROW_WIDTH, style: DEFAULT_LINE_STYLE }; // what the next new arrow looks like (this session only)
  let drawStyle = { color: 'ink', width: DEFAULT_DRAW_WIDTH, style: DEFAULT_LINE_STYLE }; // what the next new drawing looks like (this session only; apart from arrows)
  let drawView = 'draw'; // while the Draw tool is armed: 'draw' (a primary drag draws) or 'move' (a primary drag orbits)
  let stroke = null; // the unsaved freehand gesture, see beginStroke
  let viewGate = null; // { controls, prior } while this tool holds OrbitControls' rotation off (Draw mode, or a press a saved drawing took)
  let draft = null; // the editor card: a new callout or an edit of an existing one
  let selectedId = null;
  const collapsedIds = new Set(); // session-only: callouts folded to their header; never saved, never changes the hidden flag or selection
  let renamingId = null; // the arrow or drawing whose name is being typed in its row; nothing is written until it is committed
  let colorPreview = null; // { id, color }: the color a picker is showing for the selected arrow or drawing; render-only, never stored
  let revealedId = null; // the selection whose row was last revealed: a selection change reveals its row once, never per frame
  let display = 'markers'; // view-level: 'markers' | 'labels' | 'cards'; not saved with the Load Plan
  let showMode = 'all'; // view-level: 'all' | 'selected' | 'off'; never saved, never overrides a record's own hidden flag
  let lastCustomColor = null; // the custom color last picked in this session, offered again by the swatch
  let records = [];
  let results = [];
  let numbers = new Map();
  let arrowNumbers = new Map();
  let drawNumbers = new Map();
  let drawableIds = new Set(); // callouts, arrows and drawings the overlay may draw (Valid and not hidden)
  let pinDrag = null; // { id, which (arrow end, else null), pointerId, startX, startY, moved, dirty, candidate, poseKey, target }
  let cardDrag = null; // { id, pointerId, startX, startY, startRect, marker, moved, rect, offset }
  let moveDrag = null; // a saved drawing being carried along its surface, see beginDrawPress
  let editorDrag = null;
  let press = null; // { x, y } of a primary press that began on the canvas while a scene tool is armed
  let hover = null;
  let hoverDirty = false;
  let lastHoverPickAt = 0;
  let lastClient = null;
  let lastNoticeAt = 0;
  let lastCursor = '';
  let rafId = null;
  let statusMessage = '';
  let statusTone = '';
  let statusTimer = null;
  let lastBlockedReason = null;
  let sessionEpoch = 0; // bumped whenever the Load Plan session ends: a pending dialog answer from an older one is ignored
  let graphicsHidden = true; // the overlay is empty while annotations are paused
  let keyboardModality = false;
  let suppressClick = false;
  let compact = false;
  let panelCollapsed = false;
  let panelPosition = null;
  let panelShift = { x: 0, y: 0 }; // display-only shift (px) that keeps the desktop panel off AutoPack Results
  let panelBehindEditor = false; // the desktop panel yields to an open editor card it would otherwise hide (display only)
  let panelParts = null;
  let panelObserver = null;
  let flowObserver = null;
  let suppressToggleClick = false;
  let layerParts = null;
  let layerObserver = null;
  let editorParts = null;
  let visDirty = true;
  let lastVisAt = 0;
  let lastSignature = NaN;
  let lastGeometryRevision = NaN; // CaseScene's count of syncs that changed what stands in the scene
  let selfClearing = false;
  let lastOwnedElsewhere = false; // another scene tool (Measurement Mode) owned gestures on the previous frame
  let heldPointer = null; // { pointerId, pointerType } from a press a saved drawing took until that pointer lifts: the camera's rotation stays off
  let interruptEvent = null; // the press of a second finger that ended a drawing's move: the Editor must not take that same press for cargo
  let titleRevealPending = false; // the editor just opened: show its title field if the card is shorter than its content
  const views = new Map(); // annotation id -> { pin, chip, badge, card, ... } DOM + per-frame state
  const arrowViews = new Map(); // arrow id -> { graphic, grips, start/end world + screen, front, ... } DOM + per-frame state
  const drawViews = new Map(); // drawing id -> { graphic, local/world vertices, path, front, ... } DOM + per-frame state
  let drawBacklog = new Set(); // drawing ids waiting for an occlusion measurement
  let lastDrawMeasureAt = 0;
  const rows = new Map();

  const picker = createSurfacePicker({
    SceneManager, CaseScene, CaseLibrary, PackLibrary,
    getPack: () => currentPack(),
    hasProvisionalPose: () => provisionalPoseActive(),
  });
  const { pick, liveAnchorWorld, lookupInstance, cargoPoseKey, cargoGroupFor, getCanvas } = picker;

  const raycaster = new THREE.Raycaster();
  const projected = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const viewDir = new THREE.Vector3();
  const normalVec = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const draftWorld = new THREE.Vector3();
  const ghostWorld = new THREE.Vector3();
  const tailWorld = new THREE.Vector3();
  const sampleWorld = new THREE.Vector3();
  const strokeExitWorld = new THREE.Vector3();
  const strokePreviewVisible = [];
  const cameraSpaceA = new THREE.Vector3();
  const cameraSpaceB = new THREE.Vector3();
  const scratchScreen = { x: 0, y: 0 };
  const ghostScreen = { x: 0, y: 0 };

  // ==========================================================================
  // SECTION: SMALL HELPERS
  // ==========================================================================
  function inEditor() {
    return StateStore.get('currentScreen') === 'editor';
  }

  function currentPack() {
    return PackLibrary.getById(StateStore.get('currentPackId'));
  }

  // The Editor holds a scene-only pose (live drag, gizmo stroke, held case): meshes are not where the Load Plan says.
  function provisionalPoseActive() {
    return typeof els.hasProvisionalPose === 'function' && Boolean(els.hasProvisionalPose());
  }

  const preferenceShown = () => !PreferencesManager || PreferencesManager.get().showAnnotations !== false;

  const recordById = id => records.find(record => record.id === id) || null;
  const resultById = id => {
    const index = records.findIndex(record => record.id === id);
    return index === -1 ? null : results[index];
  };
  const isCallout = record => Boolean(record) && record.type === ANNOTATION_TYPE_CALLOUT;
  const isArrow = record => Boolean(record) && record.type === ANNOTATION_TYPE_ARROW;
  // A custom name replaces the generated one everywhere an arrow or a drawing is named; without one the generated name stays.
  const arrowName = id => { const named = recordById(id); return named && named.name ? named.name : `Arrow ${arrowNumbers.get(id) || ''}`.trim(); };
  const isDraw = record => Boolean(record) && record.type === ANNOTATION_TYPE_DRAW;
  const drawName = id => { const named = recordById(id); return named && named.name ? named.name : `Drawing ${drawNumbers.get(id) || ''}`.trim(); };
  const isStyled = record => isArrow(record) || isDraw(record);

  // The refusal wording names what is being placed: an arrow end or a callout marker.
  function annotatingAnArrow() {
    return tool === 'arrow' || (Boolean(reattachId) && isArrow(recordById(reattachId))) || Boolean(pinDrag && pinDrag.which);
  }

  function pickRefusal(blocked) {
    return (annotatingAnArrow() ? PICK_REFUSAL_NOTICE_ARROW : PICK_REFUSAL_NOTICE)[blocked] || '';
  }

  function drawRefusal(blocked) {
    return { provisional: HELD_POSE_NOTICE, ambiguous: AMBIGUOUS_CARGO_DRAW_NOTICE, unsupported: UNSUPPORTED_DRAW_NOTICE }[blocked] || '';
  }

  /** Fingerprint of the committed pose of the cargo under BOTH ends of an arrow (a gesture is dropped when it changes). */
  function arrowPoseKey(pack, record) {
    return `${cargoPoseKey(pack, record.start)}|${cargoPoseKey(pack, record.end)}`;
  }

  /**
   * Why annotations are paused right now, or null: a transient Results/Truck Change preview or a running
   * operation. Scene authority comes from those two signals only; whether an AutoPack Results card is open,
   * minimized or closed says nothing about which layout the scene displays. A passive thumbnail capture
   * is neither: it only reads pixels. An annotation write replaces the Pack object, which aborts a capture
   * that is mid-flight; the app re-requests it (app.js, 'pack-annotations').
   * The same reason hides the graphics and refuses editing.
   */
  function blockedReason() {
    if (CaseScene.isTransientPreview && CaseScene.isTransientPreview()) return 'preview';
    if (OperationLifecycle && OperationLifecycle.isBusy()) {
      const operation = typeof OperationLifecycle.currentOperation === 'function' ? OperationLifecycle.currentOperation() : null;
      const kind = operation && operation.kind ? operation.kind : 'busy';
      if (!PASSIVE_OPERATION_KINDS.has(kind)) return kind;
    }
    return null;
  }

  /**
   * True while another scene tool (Measurement Mode) owns scene-editing gestures. Annotations are then a
   * view only: they stay drawn, but nothing here takes pointer or keyboard input. A read-only question asked
   * of the Editor, never a state this tool changes.
   */
  function sceneOwnedElsewhere() {
    return typeof els.isSceneToolOwnedElsewhere === 'function' && Boolean(els.isSceneToolOwnedElsewhere());
  }

  function blockedMessage(reason) {
    return PAUSED_TEXT[reason] || 'Annotations paused during an operation.';
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
    UIComponents.showToast(message, tone, { title: 'Annotations' });
  }

  function isTypingTarget(target) {
    if (!target || !target.matches) return false;
    if (target.isContentEditable) return true;
    return target.matches('input, textarea, select');
  }

  /** Name of what an anchor is attached to: the Case name for cargo, else the surface. */
  function anchorTargetName(anchor) {
    if (!anchor) return '';
    if (anchor.kind !== 'cargo') return describeAnchorTarget(anchor);
    const pack = currentPack();
    const { instance } = pack ? lookupInstance(pack, anchor.instanceId) : { instance: null };
    const caseData = instance ? CaseLibrary.getById(instance.caseId) : null;
    return describeAnchorTarget(anchor, caseData && caseData.name);
  }

  function svgEl(name, className) {
    const el = doc.createElementNS(SVG_NS, name);
    if (className) el.setAttribute('class', className);
    return el;
  }

  function htmlEl(name, className, text) {
    const el = doc.createElement(name);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function iconEl(classes) {
    const icon = doc.createElement('i');
    icon.className = classes;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function toggleClass(el, name, on) {
    if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
  }

  /**
   * Colour an element for a record color: a built-in name is styled by the stylesheet (theme aware); a custom
   * `#rrggbb` is passed as custom properties, with a number color that stays readable on it.
   */
  function applyColor(el, color) {
    if (isCustomAnnotationColor(color)) {
      el.dataset.color = 'custom';
      el.style.setProperty('--annot-color', color);
      el.style.setProperty('--annot-fg', annotationForegroundFor(color));
    } else {
      el.dataset.color = color || '';
      el.style.removeProperty('--annot-color');
      el.style.removeProperty('--annot-fg');
    }
  }

  /** Focus returns to the 3D viewport when what held it is about to disappear. */
  function refocusViewportIfLost() {
    const viewport = els.viewport;
    const active = doc ? doc.activeElement : null;
    const lost = !active || active === doc.body || !active.isConnected ||
      Boolean(active.closest && active.closest('[hidden]'));
    if (!lost || !viewport || typeof viewport.focus !== 'function') return;
    if (!keyboardModality && viewport.classList) {
      viewport.classList.add('tp3d-pointer-focus');
      viewport.addEventListener('focusout', () => viewport.classList.remove('tp3d-pointer-focus'), { once: true });
    }
    viewport.focus({ preventScroll: true });
  }

  function clearCargoSelection() {
    // Only one scene object or cargo selection at a time: a saved measurement selected from the scene steps aside too.
    if (typeof els.clearMeasurementSelection === 'function') els.clearMeasurementSelection();
    if (typeof els.clearCargoSelection !== 'function') return;
    selfClearing = true;
    try {
      els.clearCargoSelection();
    } finally {
      selfClearing = false;
    }
  }

  // ==========================================================================
  // SECTION: SESSION (what the tool remembers while the Editor is open)
  // ==========================================================================

  function resetSession() {
    sessionEpoch += 1;
    showMode = 'all';
    closePanel();
    selectedId = null;
    collapsedIds.clear();
    renamingId = null;
    revealedId = null;
    records = [];
    results = [];
    numbers = new Map();
    arrowNumbers = new Map();
    drawNumbers = new Map();
    drawableIds = new Set();
    disposeOverlay();
  }

  // ==========================================================================
  // SECTION: SELECTION
  // ==========================================================================
  /**
   * Select (or with null, deselect) an annotation. Selecting one clears the cargo selection, so the
   * annotation owns Delete and no cargo can be deleted as a side effect. Refused while the Editor holds a
   * provisional pose, because clearing the cargo selection would abandon that hold.
   */
  /** Folds a callout to its header, or opens it again. Session-only: selection, the hidden flag and the Load Plan are untouched. */
  function toggleCollapsed(id) {
    if (!id || !recordById(id)) return;
    if (collapsedIds.has(id)) collapsedIds.delete(id);
    else collapsedIds.add(id);
    visDirty = true;
    refreshOverlay();
  }

  function select(id, { toggle = false } = {}) {
    colorPreview = null;
    let target = id && recordById(id) ? id : null;
    if (toggle && target && selectedId === target) target = null;
    if (target && showMode === 'off') {
      notice(SHOW_OFF_HINT);
      return;
    }
    if (target && sceneOwnedElsewhere()) return;
    if (target && blockedReason()) {
      notice(blockedMessage(blockedReason()));
      return;
    }
    if (target && target !== selectedId) {
      if (provisionalPoseActive()) {
        notice(HELD_POSE_NOTICE);
        return;
      }
      clearCargoSelection();
    }
    selectedId = target;
    visDirty = true;
    renderPanel();
    refreshOverlay();
  }

  // ==========================================================================
  // SECTION: SYNC + LIFECYCLE
  // ==========================================================================
  /** Re-derive validity from committed data. Cheap; called on render and on annotation writes. */
  function sync() {
    const pack = currentPack();
    if (!pack || !inEditor()) {
      resetSession();
      return;
    }
    records = PackLibrary.getAnnotations(pack);
    results = PackLibrary.resolveAnnotations(pack);
    numbers = calloutNumbers(records);
    arrowNumbers = new Map();
    records.forEach(record => { if (isArrow(record)) arrowNumbers.set(record.id, arrowNumbers.size + 1); });
    drawNumbers = new Map();
    records.forEach(record => { if (isDraw(record)) drawNumbers.set(record.id, drawNumbers.size + 1); });
    drawableIds = new Set();
    records.forEach((record, index) => {
      if ((isCallout(record) || isArrow(record) || isDraw(record)) && results[index] && results[index].status === ANNOTATION_STATUS.VALID && !record.hidden) drawableIds.add(record.id);
    });
    if (selectedId && !recordById(selectedId)) selectedId = null;
    if (reattachId && !recordById(reattachId)) {
      reattachId = null;
      reattachWhich = null;
    }
    if (arrowTail && cargoPoseKey(pack, arrowTail.anchor) !== arrowTail.poseKey) cancelArrowTail('The cargo changed, so the new arrow was cancelled.');
    if (stroke) {
      if (stroke.packId !== pack.id) cancelStroke();
      else if (cargoPoseKey(pack, stroke.anchor) !== stroke.poseKey || layoutKey(pack) !== stroke.layoutKey) cancelStroke('The cargo changed, so the drawing was cancelled.');
    }
    if (draft) {
      if (draft.editId && !recordById(draft.editId)) cancelDraft('The callout was removed, so editing was cancelled.');
      else if (draft.editId && draft.hiddenAtOpen === false && recordById(draft.editId).hidden === true) cancelDraft('The callout was hidden, so editing was cancelled.');
      else if (!draft.editId && cargoPoseKey(pack, draft.anchor) !== draft.poseKey) cancelDraft('The cargo changed, so the new callout was cancelled.');
    }
    if (pinDrag && pinDrag.id !== DRAFT_ID) {
      const record = recordById(pinDrag.id);
      const result = resultById(pinDrag.id);
      const subject = pinDrag.which ? 'arrow' : 'callout';
      if (!record || !result || result.status !== ANNOTATION_STATUS.VALID || record.hidden) cancelPinDrag(`The ${subject} changed, so the move was cancelled.`);
      else if ((pinDrag.which ? arrowPoseKey(pack, record) : cargoPoseKey(pack, record.anchor)) !== pinDrag.poseKey) cancelPinDrag('The cargo changed, so the move was cancelled.');
    }
    if (pinDrag && pinDrag.id === DRAFT_ID && draft && cargoPoseKey(pack, draft.anchor) !== pinDrag.poseKey) {
      cancelPinDrag('The cargo changed, so the move was cancelled.');
    }
    if (cardDrag && !recordById(cardDrag.id)) cancelCardDrag();
    if (moveDrag) {
      const record = recordById(moveDrag.id);
      const result = resultById(moveDrag.id);
      if (!record || !result || result.status !== ANNOTATION_STATUS.VALID || record.hidden || moveShapeOf(record) !== moveDrag.shape) {
        cancelMoveDrag(`The ${moveSubject(moveDrag)} changed, so the move was cancelled.`);
      } else if (moveDrag.packId !== pack.id || movePoseKey(pack, record) !== moveDrag.poseKey || layoutKey(pack) !== moveDrag.layoutKey) {
        cancelMoveDrag('The cargo changed, so the move was cancelled.');
      }
    }
    visDirty = true;
    renderPanel();
    ensureLoop();
    refreshOverlay();
  }

  function bind(elements) {
    els = { ...els, ...elements };
    if (bound) return;
    bound = true;
    StateStore.subscribe(changes => {
      if (changes._replace || !inEditor() || Object.prototype.hasOwnProperty.call(changes, 'currentPackId')) {
        sessionEpoch += 1;
        showMode = 'all'; // the view mode ends with the Load Plan session it belonged to
        cancelMoveDrag();
        if (panelOpen || selectedId || draft || records.length) resetSession();
        return;
      }
      // A Results card changing its viewed option can start or end a transient preview, which pauses or resumes
      // the overlay. Opening, minimizing or closing the card changes nothing here.
      if (Object.prototype.hasOwnProperty.call(changes, 'autoPackResults') && (wantsLoop() || panelOpen)) {
        syncBlocked();
        ensureLoop();
      }
      if (changes._undo || changes._redo) {
        if (moveDrag) cancelMoveDrag('Undo or redo cancelled the move.');
        if (pinDrag) cancelPinDrag('Undo or redo cancelled the move.');
        if (cardDrag) cancelCardDrag();
        if (reattachId) cancelReattach('Undo or redo cancelled the re-attach.');
        if (arrowTail) cancelArrowTail('Undo or redo cancelled the new arrow.');
        if (stroke) cancelStroke('Undo or redo cancelled the drawing.');
      }
      // Selecting cargo (or clicking empty space) deselects the annotation; our own clearing is not that.
      if (Object.prototype.hasOwnProperty.call(changes, 'selectedInstanceIds') && !selfClearing && selectedId) {
        selectedId = null;
        visDirty = true;
        renderPanel();
      }
    });
    if (OperationLifecycle && typeof OperationLifecycle.subscribe === 'function') {
      OperationLifecycle.subscribe(() => {
        if (wantsLoop() || panelOpen) syncBlocked();
      });
    }
    if (doc) doc.addEventListener('keydown', onKeyDownCapture, true);
    if (els.layer) attachLayerEvents(els.layer);
    if (typeof ResizeObserver === 'function' && els.layer) {
      layerObserver = new ResizeObserver(() => { visDirty = true; });
      layerObserver.observe(els.layer);
    }
    syncButton();
  }

  // Leaves the panel, removes the overlay and detaches the document listener. The store subscriptions
  // registered once by bind() belong to the application-lifetime singleton, so they stay.
  function destroy() {
    resetSession();
    if (doc) doc.removeEventListener('keydown', onKeyDownCapture, true);
    cancelMoveDrag();
    releaseHeldPointer();
    if (layerObserver) layerObserver.disconnect();
    layerObserver = null;
    if (layerParts && layerParts.svg.parentNode) layerParts.svg.parentNode.removeChild(layerParts.svg);
    layerParts = null;
  }

  // ==========================================================================
  // SECTION: PANEL OPEN / CLOSE, TOOL, DISPLAY
  // ==========================================================================
  function syncButton() {
    if (els.button) els.button.setAttribute('aria-pressed', panelOpen ? 'true' : 'false');
  }

  function openPanel() {
    if (panelOpen) return true;
    if (!toolShown || !inEditor() || !currentPack() || !els.panel) return false;
    panelOpen = true;
    CaseScene.setHover(null);
    const entryFocus = doc ? doc.activeElement : null;
    keyboardModality = Boolean(entryFocus && typeof entryFocus.matches === 'function' && entryFocus.matches(':focus-visible'));
    lastBlockedReason = blockedReason();
    els.panel.hidden = false;
    syncButton();
    const host = panelHost();
    if (host && typeof ResizeObserver === 'function') {
      panelObserver = new ResizeObserver(() => applyPanelPosition());
      panelObserver.observe(host);
    }
    if (typeof ResizeObserver === 'function') {
      flowObserver = new ResizeObserver(() => syncPanelFlow()); // the panel's height is limited by the window, a card or the sheet
      flowObserver.observe(els.panel);
    }
    sync();
    settle();
    const unreadable = records.filter(record => record.type === ANNOTATION_TYPE_UNREADABLE).length;
    if (unreadable) {
      UIComponents.showToast(
        `${unreadable === 1 ? 'A saved annotation' : `${unreadable} saved annotations`} couldn't be read. The original data is kept.`,
        'warning', { title: 'Annotations' }
      );
    }
    return true;
  }

  /**
   * Close the panel and stop everything it started: the armed tool, a pending re-attach, an unfinished
   * drag and an open editor card (an unsaved callout writes nothing). Saved annotations and the selection stay.
   */
  function closePanel() {
    const wasOpen = panelOpen;
    cancelStroke();
    cancelMoveDrag();
    cancelPinDrag();
    cancelCardDrag();
    if (draft) cancelDraft();
    arrowTail = null;
    tool = null;
    reattachId = null;
    reattachWhich = null;
    hover = null;
    press = null;
    panelOpen = false;
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = null;
    statusMessage = '';
    statusTone = '';
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }
    if (flowObserver) {
      flowObserver.disconnect();
      flowObserver = null;
    }
    if (els.panel) els.panel.hidden = true;
    rows.forEach(row => row.el.remove());
    rows.clear();
    syncButton();
    applyViewGate();
    updateCursor();
    if (wasOpen) refocusViewportIfLost();
    return wasOpen;
  }

  function togglePanel() {
    if (panelOpen) {
      closePanel();
      return false;
    }
    return openPanel();
  }

  /**
   * Show or hide the Annotations tool per Settings. Hiding it ends everything under way without writing (the
   * panel, an armed tool, a pending arrow or re-attach, an unfinished drag, an unsaved editor), clears the
   * selection and takes every callout and arrow off the view; saved records and their own hidden flags are never
   * touched. Showing it again redraws them from the records and the current Show mode: no gesture returns and
   * nothing is selected. Returns whether the tool is shown.
   */
  function syncVisibility() {
    const show = preferenceShown();
    const changed = show !== toolShown;
    toolShown = show;
    if (els.button) els.button.hidden = !show;
    if (els.layer) els.layer.hidden = !show;
    if (!show) {
      closePanel();
      selectedId = null;
      visDirty = true;
      disposeOverlay();
      graphicsHidden = true;
      return false;
    }
    if (changed) sync();
    return true;
  }

  /**
   * A user's choice of an existing annotation (a row, a marker or a card head) ends an armed creation tool and any unfinished
   * placement, without writing. The selection then owns the controls, and creation resumes only when the user arms a tool again.
   * An open callout draft is not touched here: its own confirm flow decides it.
   */
  function endCreation() {
    colorPreview = null;
    if (!tool) return;
    cancelStroke();
    cancelMoveDrag();
    cancelArrowTail();
    tool = null;
    hover = null;
    hoverDirty = true;
    press = null;
    setStatus('', { sticky: true });
    applyViewGate();
    updateCursor();
    refreshOverlay();
  }

  function setTool(key) {
    const def = TOOL_DEFS.find(item => item.key === key);
    if (!def || !def.available) return;
    // Measurement creation holds the canvas: it ends first (a pending first point is dropped, nothing is written).
    if (tool !== key && sceneOwnedElsewhere() && typeof els.endOtherScene === 'function') els.endOtherScene();
    const reason = blockedReason();
    if (reason && tool !== key) {
      notice(blockedMessage(reason));
      return;
    }
    if (showMode === 'off') {
      notice(SHOW_OFF_HINT);
      return;
    }
    cancelStroke();
    cancelMoveDrag();
    if (draft) cancelDraft();
    cancelArrowTail();
    reattachId = null;
    reattachWhich = null;
    tool = tool === key ? null : key;
    if (tool === 'draw') drawView = 'draw'; // arming Draw always starts in Draw mode
    hover = null;
    hoverDirty = true;
    press = null;
    selectedId = tool ? null : selectedId;
    if (tool && typeof els.clearMeasurementSelection === 'function') els.clearMeasurementSelection();
    setStatus('', { sticky: true });
    applyViewGate();
    updateCursor();
    refreshOverlay();
  }

  /** Draw mode: a primary drag draws. Move View: it orbits, and no stroke can start. Switching ends any unfinished stroke. */
  function setDrawView(mode) {
    if (!DRAW_VIEWS.some(([key]) => key === mode) || tool !== 'draw' || mode === drawView) return;
    cancelStroke();
    drawView = mode;
    hover = null;
    hoverDirty = true;
    applyViewGate();
    setStatus('', { sticky: true });
    updateCursor();
  }

  function setDisplay(mode) {
    if (!DISPLAY_MODES.some(([key]) => key === mode) || mode === display) return;
    display = mode;
    visDirty = true;
    renderPanel();
    refreshOverlay();
  }

  // ==========================================================================
  // SECTION: SCENE PICKING (the shared picker; click = place, drag = orbit)
  // ==========================================================================
  function onPointerDown(ev) {
    if (!isActive()) return;
    if (tool === 'draw') {
      beginStroke(ev);
      return;
    }
    if (ev.button !== 0) return;
    press = { x: ev.clientX, y: ev.clientY };
    lastClient = { x: ev.clientX, y: ev.clientY };
    keyboardModality = false;
  }

  function onPointerMove(ev) {
    if (!isActive()) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    hoverDirty = true;
  }

  function onPointerCancel() {
    // A pointer interaction that was part of placing an arrow's head is cancelled with the arrow; nothing is written.
    if (press && arrowTail) cancelArrowTail('Placement cancelled.');
    press = null;
    // The Editor also routes lostpointercapture here. After a release the stroke is already gone, so that trailing
    // event finds nothing; during a stroke it means the pointer was taken away.
    if (stroke) cancelStroke('Drawing cancelled.');
  }

  function onPointerUp(ev) {
    if (!isActive() || !press) return; // a stroke ends on its own window listener, never here
    const moved = Math.hypot(ev.clientX - press.x, ev.clientY - press.y);
    press = null;
    if (ev.button !== 0 || moved > CLICK_DRAG_THRESHOLD_PX) return; // an orbit/pan drag, not a click
    handleSceneClick(ev.clientX, ev.clientY);
  }

  /** A double-click must neither start two callouts nor focus the camera on cargo, and the same on a saved stroke's line (two clicks select, then deselect it). */
  function onDoubleClick(ev) {
    if (!isActive() && !(ev && drawHitReachable() && drawHitIdAt(ev.clientX, ev.clientY))) return false;
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    return true;
  }

  function handleSceneClick(clientX, clientY) {
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    if (!pack) return;
    if (draft && draft.editId) {
      setStatus('Save or cancel the open callout first.');
      return;
    }
    if (!reattachId && !draft && !arrowTail && records.length >= MAX_ANNOTATIONS_PER_PACK) {
      notice(`Limit of ${MAX_ANNOTATIONS_PER_PACK} annotations reached. Delete one to add another.`, 'warning');
      return;
    }
    const outcome = {};
    const picked = pick(clientX, clientY, outcome);
    hover = picked;
    if (!picked) {
      notice(pickRefusal(outcome.blocked) || 'Nothing to annotate there. Click cargo, the truck or the ground.');
      return;
    }
    if (reattachId) {
      commitReattach(reattachId, picked, reattachWhich);
      return;
    }
    if (tool === 'arrow') {
      handleArrowPick(picked, pack);
      return;
    }
    if (draft) {
      moveDraftAnchor(picked, pack);
      return;
    }
    openNewDraft(picked, pack);
  }

  // ==========================================================================
  // SECTION: DRAW / MOVE VIEW (who owns the camera's rotation)
  // ==========================================================================
  /**
   * Whether a primary drag on the canvas should draw right now (so OrbitControls must not rotate on it), or a press a saved drawing
   * took is still down (a drag on its line carries the drawing, so it must not also orbit). Derived, never stored.
   */
  function drawGateWanted() {
    if (heldPointer && inEditor()) return true;
    return toolShown && panelOpen && tool === 'draw' && drawView === 'draw' && inEditor() && !sceneOwnedElsewhere() && !blockedReason();
  }

  /**
   * Make OrbitControls' rotation match the gate: off while a primary drag draws or carries a drawing, back exactly as found otherwise. Derived
   * and idempotent: called after every state change that could matter and on every frame, so it also catches a controls
   * instance that was replaced. It touches `enableRotate` and nothing else (zoom, pan, damping, mouse and touch maps and
   * cargo dragging are left alone). What it restores is what it found: a rotation that was already off stays off, and a
   * value another owner has changed since is theirs.
   */
  function applyViewGate() {
    const controls = typeof SceneManager.getControls === 'function' ? SceneManager.getControls() : null;
    if (viewGate && viewGate.controls !== controls) releaseViewGate(); // the instance this gate held is gone
    if (controls && drawGateWanted()) {
      if (!viewGate) viewGate = { controls, prior: controls.enableRotate };
      if (controls.enableRotate !== false) controls.enableRotate = false;
    } else if (viewGate) {
      releaseViewGate();
    }
  }

  function releaseViewGate() {
    const gate = viewGate;
    viewGate = null;
    if (!gate) return;
    if (gate.controls.enableRotate === false && gate.prior !== false) gate.controls.enableRotate = gate.prior;
  }

  // ==========================================================================
  // SECTION: FREEHAND STROKE (armed -> stroking -> frozen -> committing; Escape and every interruption -> armed)
  // ==========================================================================
  /**
   * Fingerprint of everything that decides where a stroke may sit: the truck and every cargo item's identity, Case, pose and
   * visibility. A stroke records it when it starts and is dropped if it changes, so what is saved is what was drawn over.
   */
  function layoutKey(pack) {
    const cargo = (pack.cases || []).map(inst => (inst
      ? `${inst.id}:${inst.caseId}:${inst.placement || ''}:${inst.hidden ? 1 : 0}:${JSON.stringify(inst.transform || null)}` : ''));
    return `${JSON.stringify(pack.truck || null)}|${cargo.join(';')}`;
  }

  /**
   * Start a stroke on a primary press, or refuse quietly. A press with a modifier key is navigation (OrbitControls pans on it) and
   * never draws; Move View never draws; a second finger or another pointer while one stroke is under way ends that stroke.
   */
  function beginStroke(ev) {
    if (stroke) {
      if (ev.pointerId !== stroke.pointerId) cancelStroke('Drawing cancelled.');
      return;
    }
    if (drawView !== 'draw' || ev.button !== 0 || ev.isPrimary === false || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    keyboardModality = false;
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    if (sceneOwnedElsewhere()) return;
    if (showMode === 'off') {
      notice(SHOW_OFF_HINT);
      return;
    }
    const pack = currentPack();
    if (!pack) return;
    if (provisionalPoseActive()) {
      notice(HELD_POSE_NOTICE);
      return;
    }
    if (records.length >= MAX_ANNOTATIONS_PER_PACK) {
      notice(`Limit of ${MAX_ANNOTATIONS_PER_PACK} annotations reached. Delete one to add another.`, 'warning');
      return;
    }
    const outcome = {};
    const picked = picker.pickDraw(ev.clientX, ev.clientY, outcome);
    const surface = picked ? picker.beginDrawSurface(picked, pack) : null;
    if (!surface) {
      notice(drawRefusal(outcome.blocked) || (picked ? UNSUPPORTED_DRAW_NOTICE : 'Nothing to draw on there. Drag across cargo, the truck or the ground.'));
      return;
    }
    clearCargoSelection();
    selectedId = null;
    const startWorld = picked.world;
    stroke = {
      phase: 'stroking', pointerId: ev.pointerId, pointerType: ev.pointerType || 'mouse', packId: pack.id, epoch: sessionEpoch,
      anchor: picked.anchor, face: surface.face, surface, candidates: surface.patches.slice(),
      poseKey: cargoPoseKey(pack, picked.anchor), layoutKey: layoutKey(pack), style: { ...drawStyle },
      raw: [], // surface-local [u, v, ...] after the first vertex, which is the anchor
      world: [startWorld.x, startWorld.y, startWorld.z], // world units, every vertex including the first, for the preview
      last: { u: surface.first.u, v: surface.first.v }, lastClient: { x: ev.clientX, y: ev.clientY },
      queued: { x: ev.clientX, y: ev.clientY }, lastSample: { x: ev.clientX, y: ev.clientY },
      pending: [], frozen: null, previewKey: '', canvas: getCanvas(),
    };
    attachStrokeListeners();
    const canvas = stroke.canvas;
    try {
      if (canvas && typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(ev.pointerId);
    } catch (_) {
      // Capture is a convenience; the window listeners still end the stroke.
    }
    hover = null;
    setStatus('', { sticky: true });
    visDirty = true;
    ensureLoop();
    updateCursor();
  }

  function attachStrokeListeners() {
    window.addEventListener('pointermove', onStrokeMove);
    window.addEventListener('pointerup', onStrokeUp);
    window.addEventListener('pointercancel', onStrokeCancel);
    window.addEventListener('pointerdown', onStrokeOtherPointer, true);
    window.addEventListener('blur', onStrokeInterrupted);
    if (doc) doc.addEventListener('visibilitychange', onStrokeVisibility);
  }

  function detachStrokeListeners() {
    window.removeEventListener('pointermove', onStrokeMove);
    window.removeEventListener('pointerup', onStrokeUp);
    window.removeEventListener('pointercancel', onStrokeCancel);
    window.removeEventListener('pointerdown', onStrokeOtherPointer, true);
    window.removeEventListener('blur', onStrokeInterrupted);
    if (doc) doc.removeEventListener('visibilitychange', onStrokeVisibility);
  }

  function onStrokeOtherPointer(ev) {
    if (stroke && ev.pointerId !== stroke.pointerId) cancelStroke('Drawing cancelled.');
  }

  function onStrokeInterrupted() {
    if (stroke) cancelStroke('Drawing cancelled.');
  }

  function onStrokeVisibility() {
    if (stroke && doc && doc.visibilityState === 'hidden') cancelStroke('Drawing cancelled.');
  }

  function onStrokeCancel(ev) {
    if (stroke && ev.pointerId === stroke.pointerId) cancelStroke('Drawing cancelled.');
  }

  function onStrokeMove(ev) {
    if (!stroke || ev.pointerId !== stroke.pointerId || stroke.phase === 'committing') return;
    // A button other than the primary joining the press, or the primary no longer held (the release was lost), ends the stroke.
    if (ev.pointerType === 'mouse' && ev.buttons !== 1) {
      cancelStroke('Drawing cancelled.');
      return;
    }
    stroke.lastClient = { x: ev.clientX, y: ev.clientY };
    lastClient = stroke.lastClient;
    if (stroke.phase !== 'stroking') return;
    ev.preventDefault();
    const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
    (coalesced.length ? coalesced : [ev]).forEach(queueStrokeSample);
  }

  /** Keep a pointer position as a sample once it is far enough from the last kept one; the queue thins itself rather than grow. */
  function queueStrokeSample(point) {
    if (Math.hypot(point.clientX - stroke.queued.x, point.clientY - stroke.queued.y) < DRAW_SAMPLE_MIN_PX) return;
    stroke.queued = { x: point.clientX, y: point.clientY };
    stroke.pending.push(stroke.queued);
    if (stroke.pending.length > DRAW_QUEUE_LIMIT) stroke.pending = stroke.pending.filter((_, i, all) => i % 2 === 1 || i === all.length - 1);
  }

  /** Verify queued samples against the scene, a bounded number per call. Stops at the first sample that freezes the stroke. */
  function processStrokeQueue(budget) {
    for (let done = 0; done < budget; done += 1) {
      // A sample can freeze or cancel the stroke, so it is looked at again before each one.
      if (!stroke || stroke.phase !== 'stroking' || !stroke.pending.length) break;
      const next = stroke.pending.shift();
      addStrokeSample(next.x, next.y);
    }
    if (stroke && stroke.phase !== 'stroking') stroke.pending.length = 0;
  }

  function addStrokeSample(x, y) {
    if (Math.hypot(x - stroke.lastSample.x, y - stroke.lastSample.y) > DRAW_MAX_GAP_PX) {
      freezeStroke('gap');
      return;
    }
    if (stroke.raw.length / 2 >= DRAW_MAX_RAW_VERTICES) {
      freezeStroke('limit');
      return;
    }
    const sample = picker.sampleDrawSurface(stroke.surface, stroke.candidates, x, y);
    if (sample.status === 'provisional') {
      cancelStroke(HELD_POSE_NOTICE);
    } else if (sample.status === 'ok') {
      stroke.candidates = stroke.candidates.filter(patch => patchContains(patch, sample.u, sample.v));
      stroke.raw.push(sample.u, sample.v);
      stroke.world.push(sample.world.x, sample.world.y, sample.world.z);
      stroke.last = { u: sample.u, v: sample.v };
      stroke.lastSample = { x, y };
    } else if (sample.status === 'edge') {
      addEdgeExit(sample.u, sample.v);
      freezeStroke('edge');
    } else {
      freezeStroke(sample.status === 'view' ? 'view' : 'blocked');
    }
  }

  /**
   * The stroke ran off its patch: end it exactly on the patch boundary, where the last segment crosses it, so a stroke that is
   * drawn to a face's edge reaches that edge. The cut uses the exact outline (the 24-sided cap polygon for a drum). The point
   * is quantized with the rest at save and stays within the footprint tolerance, which was sized for exactly this.
   */
  function addEdgeExit(u, v) {
    let best = null;
    stroke.candidates.forEach(patch => {
      const outline = patchOutline(patch);
      const clip = outline ? clipSegmentToConvex({ x: stroke.last.u, y: stroke.last.v }, { x: u, y: v }, outline) : null;
      if (clip && (!best || clip.t1 > best.t1)) best = clip;
    });
    if (!best || best.t1 >= 1 || Math.hypot(best.b.x - stroke.last.u, best.b.y - stroke.last.v) < DRAW_EDGE_MIN_INCHES) return;
    const world = picker.drawSurfaceWorld(stroke.surface, best.b.x, best.b.y, strokeExitWorld);
    if (!world) return;
    stroke.raw.push(best.b.x, best.b.y);
    stroke.world.push(world.x, world.y, world.z);
    stroke.last = { u: best.b.x, v: best.b.y };
  }

  function freezeStroke(reason) {
    if (!stroke || stroke.phase !== 'stroking') return;
    stroke.phase = 'frozen';
    stroke.frozen = reason;
    stroke.pending.length = 0;
    visDirty = true;
    setStatus(DRAW_FROZEN_TEXT[reason] || DRAW_FROZEN_TEXT.blocked, { sticky: true });
  }

  function onStrokeUp(ev) {
    if (!stroke || ev.pointerId !== stroke.pointerId || stroke.phase === 'committing') return;
    if (stroke.phase === 'stroking') {
      queueStrokeSample({ clientX: ev.clientX, clientY: ev.clientY });
      processStrokeQueue(DRAW_FLUSH_PICKS);
    }
    if (!stroke) return; // a flushed sample cancelled it
    const finished = stroke;
    finished.phase = 'committing';
    endStroke();
    commitStroke(finished);
  }

  /**
   * Write the finished stroke, once, if everything it was drawn on is still as it was. Every rule about the stroke itself (that
   * it is long enough, simple enough, within the limits, and still on its surface) is PackLibrary.addDraw's; this only checks that
   * the session, the plan and the tool are still the ones the stroke belongs to.
   */
  function commitStroke(finished) {
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    if (!pack || pack.id !== finished.packId || finished.epoch !== sessionEpoch || !toolShown || !panelOpen || tool !== 'draw' ||
        drawView !== 'draw' || showMode === 'off' || sceneOwnedElsewhere() || provisionalPoseActive()) {
      setStatus('The drawing was cancelled.');
      return;
    }
    if (cargoPoseKey(pack, finished.anchor) !== finished.poseKey || layoutKey(pack) !== finished.layoutKey) {
      setStatus('The cargo changed, so the drawing was cancelled.');
      return;
    }
    if (!finished.raw.length) {
      setStatus('Drag across a surface to draw.');
      return;
    }
    const outcome = PackLibrary.addDraw(pack.id, {
      anchor: finished.anchor, face: finished.face, rawPoints: finished.raw, color: finished.style.color, width: finished.style.width,
      style: finished.style.style,
    });
    if (!outcome.ok) {
      const refused = {
        limit: [`Limit of ${MAX_ANNOTATIONS_PER_PACK} annotations reached. Delete one to add another.`, 'warning'],
        'points-limit': ['This Load Plan has reached its drawing detail limit. Delete a drawing to add another.', 'warning'],
        'too-short': ['That drawing is too short. Drag a little farther.', 'info'],
        'too-complex': ['That drawing is too detailed to save as one stroke. Draw it in smaller pieces.', 'warning'],
        unresolved: ['That drawing could not be placed on its surface, so it was not saved.', 'warning'],
      }[outcome.reason];
      if (refused) notice(refused[0], refused[1]);
      else UIComponents.showToast('Could not save this drawing.', 'error', { title: 'Annotations' });
      return;
    }
    hover = null;
    hoverDirty = true;
    // The saved drawing is not selected: the tool stays armed and the next drag starts another one.
    visDirty = true;
    setStatus('Drawing saved. Drag to draw another, or press Esc to finish.', { tone: 'success' });
    refreshOverlay();
  }

  /** Drop the unfinished stroke without writing. Safe to call when none is under way. */
  function cancelStroke(message = '') {
    if (!stroke) return;
    endStroke();
    visDirty = true;
    if (message) setStatus(message);
    else renderPanel();
    refreshOverlay();
  }

  /** Release everything a stroke holds. After this no pointer event can reach it, so none can bring it back. */
  function endStroke() {
    if (!stroke) return;
    const { canvas, pointerId } = stroke;
    detachStrokeListeners();
    stroke = null;
    try {
      if (canvas && typeof canvas.releasePointerCapture === 'function' && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch (_) {
      // Already released.
    }
    updateCursor();
  }

  /** Each frame while a stroke is under way: a held pose ends it, then a bounded number of queued samples are verified. */
  function advanceStroke() {
    if (!stroke) return;
    if (provisionalPoseActive()) {
      cancelStroke(HELD_POSE_NOTICE);
      return;
    }
    processStrokeQueue(DRAW_PICKS_PER_FRAME);
  }

  // ==========================================================================
  // SECTION: ARROW PLACEMENT (two clicks: tail, then head)
  // ==========================================================================
  /** The first click holds the tail as an unsaved gesture; the second saves one record. Nothing is written before that. */
  function handleArrowPick(picked, pack) {
    if (!arrowTail) {
      if (records.length >= MAX_ANNOTATIONS_PER_PACK) {
        notice(`Limit of ${MAX_ANNOTATIONS_PER_PACK} annotations reached. Delete one to add another.`, 'warning');
        return;
      }
      clearCargoSelection();
      selectedId = null;
      arrowTail = { anchor: picked.anchor, world: picked.world.clone(), poseKey: cargoPoseKey(pack, picked.anchor) };
      setStatus('', { sticky: true });
      visDirty = true;
      refreshOverlay();
      return;
    }
    // The cargo under the tail must still be posed as it was when the tail was picked.
    if (cargoPoseKey(pack, arrowTail.anchor) !== arrowTail.poseKey) {
      cancelArrowTail('The cargo changed, so the new arrow was cancelled.');
      return;
    }
    // Clicking the tail's own spot again (a double-click) is the likely slip: the writer rejects identical ends as
    // invalid, so answer it here the same way as any other head that is too close.
    if (arrowTail.world.distanceTo(picked.world) / picker.toWorldScale() < MIN_ARROW_LENGTH_INCHES) {
      notice('That point is too close to the tail. Click farther away to point the arrow.');
      return;
    }
    const outcome = PackLibrary.addArrow(pack.id, { start: arrowTail.anchor, end: picked.anchor, color: arrowStyle.color, width: arrowStyle.width, style: arrowStyle.style });
    if (!outcome.ok) {
      if (outcome.reason === 'too-short') {
        // Nothing was written and the tail stays: the owner can simply click farther away.
        notice('That point is too close to the tail. Click farther away to point the arrow.');
      } else if (outcome.reason === 'unresolved') {
        cancelArrowTail('One end of the arrow could not be placed, so it was cancelled.');
      } else if (outcome.reason === 'limit') {
        cancelArrowTail(`Limit of ${MAX_ANNOTATIONS_PER_PACK} annotations reached. Delete one to add another.`);
      } else {
        cancelArrowTail('');
        UIComponents.showToast('Could not save this arrow.', 'error', { title: 'Annotations' });
      }
      return;
    }
    arrowTail = null;
    hover = null;
    hoverDirty = true;
    // The saved arrow is not selected: the tool stays armed and the next click starts another one.
    visDirty = true;
    setStatus('Arrow saved. Click to start another, or press Esc to finish.', { tone: 'success' });
    refreshOverlay();
  }

  /** Drop the unfinished arrow (the tail only ever existed on screen). Safe to call when none is pending. */
  function cancelArrowTail(message = '') {
    if (!arrowTail) return;
    arrowTail = null;
    visDirty = true;
    if (message) setStatus(message);
    else renderPanel();
    refreshOverlay();
  }

  // ==========================================================================
  // SECTION: THE EDITOR CARD (new callout / edit callout)
  // ==========================================================================
  function openNewDraft(picked, pack) {
    clearCargoSelection();
    selectedId = null;
    draft = {
      editId: null,
      anchor: picked.anchor,
      world: picked.world.clone(),
      poseKey: cargoPoseKey(pack, picked.anchor),
      title: '',
      description: '',
      color: 'ink',
      keepExpanded: false,
      preset: null,
      editorPos: null,
    };
    showEditor();
    setStatus('', { sticky: true });
    visDirty = true;
    refreshOverlay();
  }

  function moveDraftAnchor(picked, pack) {
    draft.anchor = picked.anchor;
    draft.world = picked.world.clone();
    draft.poseKey = cargoPoseKey(pack, picked.anchor);
    syncEditorFields();
    setStatus('Marker moved. Click elsewhere or drag it to move it again.');
    refreshOverlay();
  }

  function openEditor(id) {
    const record = recordById(id);
    if (!isCallout(record)) return;
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    if (showMode === 'off') {
      notice(SHOW_OFF_HINT);
      return;
    }
    if (draft) cancelDraft();
    // Editing a callout ends every armed creator (Arrow, Draw, Re-attach): an unfinished stroke or arrow is cancelled without a
    // write, and the camera gate Draw holds is released through applyViewGate().
    cancelStroke();
    cancelMoveDrag();
    cancelArrowTail();
    tool = null;
    hover = null;
    press = null;
    reattachId = null;
    reattachWhich = null;
    applyViewGate();
    updateCursor();
    draft = {
      editId: id,
      hiddenAtOpen: record.hidden === true,
      anchor: record.anchor,
      world: null,
      poseKey: null,
      title: record.title,
      description: record.description || '',
      color: record.color,
      keepExpanded: record.keepExpanded,
      preset: null,
      editorPos: null,
    };
    select(id);
    showEditor();
    setStatus('', { sticky: true });
    refreshOverlay();
  }

  /**
   * New Measurement is about to start. The armed Callout, Arrow or Draw tool ends and an open card closes, but an edited card
   * is discarded only after the owner agrees. Declining keeps the draft and the armed tool; nothing is written.
   */
  function releaseForMeasurement() {
    const finish = () => {
      cancelStroke();
      cancelMoveDrag();
      cancelPinDrag();
      cancelCardDrag();
      cancelArrowTail();
      if (draft) cancelDraft();
      tool = null;
      reattachId = null;
      reattachWhich = null;
      hover = null;
      press = null;
      applyViewGate();
      updateCursor();
      visDirty = true;
      refreshOverlay();
      return true;
    };
    if (!(draft && draftIsDirty())) return Promise.resolve(finish());
    return confirmDiscard({
      title: 'Discard changes?',
      message: 'Starting a measurement closes the open callout editor and discards its unsaved changes.',
      okLabel: 'Discard and measure',
    }).then(confirmed => (confirmed ? finish() : false));
  }

  function cancelDraft(message = '') {
    if (!draft) return;
    const restore = Boolean(editorParts && editorParts.root.contains(doc.activeElement));
    draft = null;
    editorDrag = null;
    if (editorParts) setHidden(editorParts.root, true);
    visDirty = true;
    if (message) setStatus(message);
    else renderPanel();
    refreshOverlay();
    if (restore) refocusViewportIfLost();
  }

  function saveDraft() {
    if (!draft) return;
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    if (!pack) return;
    const title = normalizeCalloutTitle(draft.title);
    if (!title) {
      setStatus('Add a title to save this callout.');
      if (editorParts) editorParts.title.focus();
      return;
    }
    const fields = {
      title,
      description: normalizeCalloutDescription(draft.description),
      color: draft.color,
      keepExpanded: draft.keepExpanded,
    };
    let id;
    if (draft.editId) {
      const outcome = PackLibrary.updateCallout(pack.id, draft.editId, fields);
      if (!outcome.ok) {
        UIComponents.showToast('Could not save this callout.', 'error', { title: 'Annotations' });
        return;
      }
      id = draft.editId;
    } else {
      // The cargo the marker sits on must still be posed as it was when the point was picked.
      if (cargoPoseKey(pack, draft.anchor) !== draft.poseKey) {
        cancelDraft('The cargo changed, so the new callout was cancelled.');
        return;
      }
      const outcome = PackLibrary.addCallout(pack.id, { anchor: draft.anchor, ...fields });
      if (!outcome.ok) {
        UIComponents.showToast(outcome.reason === 'limit'
          ? `Annotation limit reached (${MAX_ANNOTATIONS_PER_PACK}).`
          : 'Could not save this callout.', 'error', { title: 'Annotations' });
        return;
      }
      id = outcome.annotation.id;
    }
    const target = anchorTargetName(draft.anchor);
    const wasEdit = Boolean(draft.editId);
    const restore = Boolean(editorParts && editorParts.root.contains(doc.activeElement));
    draft = null;
    editorDrag = null;
    if (editorParts) setHidden(editorParts.root, true);
    adoptSelection(id);
    visDirty = true;
    setStatus(wasEdit ? 'Callout updated.' : `Callout saved to ${target}.`, { tone: 'success' });
    refreshOverlay();
    if (restore) refocusViewportIfLost();
  }

  /**
   * The color row shared by the callout editor and the arrow options: the five built-in names and one custom
   * swatch that opens the browser's native color picker. `getColor` reads the color being edited (null when nothing
   * is), `onPick` receives the chosen color and `sync` shows a color as the pressed one.
   */
  /** The color an arrow or drawing is painted with: the picker's live preview for the selected record, otherwise its stored color. */
  function paintColorOf(record) {
    return colorPreview && record && colorPreview.id === record.id ? colorPreview.color : record.color;
  }

  /** Set (or with null, clear) the live color preview of the selected arrow or drawing. Nothing is written. */
  function setColorPreview(color) {
    const record = recordById(selectedId);
    const next = color && (isArrow(record) || isDraw(record)) ? { id: record.id, color } : null;
    if (colorPreview && next && colorPreview.id === next.id && colorPreview.color === next.color) return;
    if (!colorPreview && !next) return;
    colorPreview = next;
    refreshOverlay();
  }

  function buildColorPicker({ ariaLabel, getColor, onPick, onPreview }) {
    const root = htmlEl('div', 'tp3d-annot-swatches');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', ariaLabel);
    root.appendChild(htmlEl('span', 'tp3d-annot-editor__label', 'Color'));
    const swatches = ANNOTATION_COLORS.map(color => {
      const swatch = htmlEl('button', 'tp3d-annot-swatch');
      swatch.type = 'button';
      swatch.dataset.color = color;
      swatch.title = COLOR_LABELS[color];
      swatch.setAttribute('aria-label', COLOR_LABELS[color]);
      swatch.setAttribute('aria-pressed', 'false');
      swatch.addEventListener('click', () => {
        if (getColor() == null) return;
        onPick(color);
      });
      root.appendChild(swatch);
      return { color, swatch };
    });
    // One custom color beside the built-in names: a swatch that opens the browser's native color picker.
    const customSwatch = htmlEl('span', 'tp3d-annot-swatch tp3d-annot-swatch--custom');
    customSwatch.dataset.color = 'custom';
    const customInput = htmlEl('input', 'tp3d-annot-swatch__input');
    customInput.type = 'color';
    customInput.value = DEFAULT_CUSTOM_COLOR;
    customInput.title = 'Custom color';
    customInput.setAttribute('aria-label', 'Custom color');
    customInput.addEventListener('click', () => {
      // Choosing the swatch again brings back the custom color picked earlier, before the picker adjusts it.
      const current = getColor();
      if (current != null && !isCustomAnnotationColor(current) && lastCustomColor) onPick(lastCustomColor);
    });
    // A native color picker fires `input` for every move of its pointer. Those events only preview the color; the one
    // completed choice is the `change` event, which writes once (one undoable step), or nothing when it is unchanged.
    customInput.addEventListener('input', () => {
      if (getColor() == null) return;
      const picked = customInput.value.toLowerCase();
      if (!isCustomAnnotationColor(picked)) return;
      onPreview(picked);
    });
    customInput.addEventListener('change', () => {
      onPreview(null);
      if (getColor() == null) return;
      const picked = customInput.value.toLowerCase();
      if (!isCustomAnnotationColor(picked)) return;
      lastCustomColor = picked;
      onPick(picked);
    });
    // A picker closed without a change (a cancelled choice) leaves nothing behind.
    customInput.addEventListener('blur', () => onPreview(null));
    customSwatch.appendChild(customInput);
    root.appendChild(customSwatch);
    function showColor(color) {
      swatches.forEach(({ color: name, swatch }) => setAttr(swatch, 'aria-pressed', color === name ? 'true' : 'false'));
      const custom = isCustomAnnotationColor(color);
      applyColor(customSwatch, custom ? color : '');
      if (!custom) customSwatch.dataset.color = 'custom';
      toggleClass(customSwatch, 'is-selected', custom);
      if (custom && customInput.value !== color) customInput.value = color;
      else if (!custom && lastCustomColor && customInput.value !== lastCustomColor) customInput.value = lastCustomColor;
    }
    return { root, swatches, customSwatch, customInput, sync: showColor };
  }

  function buildEditor() {
    const root = htmlEl('div', 'tp3d-annot-editor');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'New callout');
    root.hidden = true;

    const head = htmlEl('div', 'tp3d-annot-editor__head');
    head.title = 'Drag to move this card';
    const headline = htmlEl('div', 'tp3d-annot-editor__headline');
    headline.append(gripEl(), htmlEl('span', 'tp3d-annot-editor__heading'));
    const target = htmlEl('div', 'tp3d-annot-editor__target');
    target.append(iconEl('fa-solid fa-cube'), htmlEl('span', 'tp3d-annot-editor__target-text'));
    head.append(headline, target);

    const body = htmlEl('div', 'tp3d-annot-editor__body');
    const presetsWrap = htmlEl('div', 'tp3d-annot-editor__field');
    presetsWrap.append(htmlEl('div', 'tp3d-annot-editor__label', 'Presets'));
    const presets = htmlEl('div', 'tp3d-annot-editor__presets');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Text presets');
    const presetButtons = CALLOUT_PRESETS.map(preset => {
      const button = htmlEl('button', 'tp3d-annot-chip', preset.key);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (!draft) return;
        draft.title = preset.title;
        draft.description = preset.description;
        draft.preset = preset.key;
        syncEditorFields();
      });
      presets.appendChild(button);
      return { key: preset.key, button };
    });
    presetsWrap.appendChild(presets);

    const titleLabel = htmlEl('label', 'tp3d-annot-editor__field');
    titleLabel.append(htmlEl('span', 'tp3d-annot-editor__label', 'Title'));
    const title = htmlEl('input', 'tp3d-annot-editor__input');
    title.type = 'text';
    title.maxLength = MAX_CALLOUT_TITLE_LENGTH;
    title.placeholder = 'e.g. UNLOAD FIRST';
    title.autocomplete = 'off';
    title.addEventListener('input', () => {
      if (!draft) return;
      draft.title = title.value;
      draft.preset = null;
      syncEditorFields({ keepInputs: true });
    });
    titleLabel.appendChild(title);

    const descLabel = htmlEl('label', 'tp3d-annot-editor__field');
    descLabel.append(htmlEl('span', 'tp3d-annot-editor__label', 'Description (optional)'));
    const description = htmlEl('textarea', 'tp3d-annot-editor__input tp3d-annot-editor__textarea');
    description.rows = 3;
    description.maxLength = MAX_CALLOUT_DESCRIPTION_LENGTH;
    description.placeholder = 'Short instruction for the crew';
    description.addEventListener('input', () => {
      if (draft) draft.description = description.value;
    });
    descLabel.appendChild(description);

    const options = htmlEl('div', 'tp3d-annot-editor__options');
    const colorPicker = buildColorPicker({
      ariaLabel: 'Callout color',
      getColor: () => (draft ? draft.color : null),
      // A callout's color is held in the open draft, which is not stored until Save: it keeps its live preview.
      onPreview: color => { if (color && draft) { draft.color = color; syncEditorFields({ keepInputs: true }); } },
      onPick: color => {
        draft.color = color;
        syncEditorFields({ keepInputs: true });
      },
    });
    const keepLabel = htmlEl('label', 'tp3d-annot-editor__keep');
    const keep = htmlEl('input');
    keep.type = 'checkbox';
    keep.addEventListener('change', () => {
      if (draft) draft.keepExpanded = keep.checked;
    });
    keepLabel.append(keep, doc.createTextNode('Keep expanded'));
    options.append(colorPicker.root, keepLabel);
    body.append(presetsWrap, titleLabel, descLabel, options);

    const foot = htmlEl('div', 'tp3d-annot-editor__foot');
    const del = htmlEl('button', 'tp3d-annot-btn tp3d-annot-btn--danger');
    del.type = 'button';
    del.title = 'Delete callout';
    del.setAttribute('aria-label', 'Delete callout');
    del.appendChild(iconEl('fa-solid fa-trash-can'));
    del.addEventListener('click', () => {
      if (draft && draft.editId) removeAnnotation(draft.editId);
    });
    const spacer = htmlEl('span', 'tp3d-annot-editor__spacer');
    const cancel = htmlEl('button', 'tp3d-annot-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cancelDraft());
    const save = htmlEl('button', 'tp3d-annot-btn tp3d-annot-btn--primary', 'Save callout');
    save.type = 'button';
    save.addEventListener('click', saveDraft);
    foot.append(del, spacer, cancel, save);

    root.append(head, body, foot);
    // The card is not modal: it owns Escape and Enter only while focus is inside it.
    root.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancelDraft();
      } else if (ev.key === 'Enter' && ev.target === title && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        saveDraft();
      }
    });
    head.addEventListener('pointerdown', ev => beginEditorDrag(ev, root));
    return {
      root, head, body, heading: headline.querySelector('.tp3d-annot-editor__heading'),
      targetText: target.querySelector('.tp3d-annot-editor__target-text'),
      presetButtons, title, description, colorPicker, keep, del, cancel, save,
    };
  }

  function ensureEditor() {
    if (editorParts && editorParts.root.isConnected) return editorParts;
    if (!els.layer || !doc) return null;
    editorParts = buildEditor();
    els.layer.appendChild(editorParts.root);
    return editorParts;
  }

  /** Make the editor card show `draft`. `keepInputs` leaves the text fields alone while the user types in them. */
  function syncEditorFields({ keepInputs = false } = {}) {
    const parts = ensureEditor();
    if (!parts || !draft) return;
    const editing = Boolean(draft.editId);
    setText(parts.heading, editing ? 'Edit callout' : 'New callout');
    parts.root.setAttribute('aria-label', editing ? 'Edit callout' : 'New callout');
    setText(parts.targetText, `Attached to ${anchorTargetName(draft.anchor)}`);
    if (!keepInputs) {
      if (parts.title.value !== draft.title) parts.title.value = draft.title;
      if (parts.description.value !== draft.description) parts.description.value = draft.description;
    }
    parts.keep.checked = draft.keepExpanded;
    parts.presetButtons.forEach(({ key, button }) => setAttr(button, 'aria-pressed', draft.preset === key ? 'true' : 'false'));
    parts.colorPicker.sync(draft.color);
    setHidden(parts.del, !editing);
    setText(parts.save, editing ? 'Save changes' : 'Save callout');
    parts.save.disabled = !normalizeCalloutTitle(draft.title);
  }

  function showEditor() {
    const parts = ensureEditor();
    if (!parts || !draft) return;
    syncEditorFields();
    parts.root.dataset.measured = '';
    setHidden(parts.root, false);
    titleRevealPending = true;
    parts.title.focus({ preventScroll: true });
    parts.title.select();
  }

  function beginEditorDrag(ev, root) {
    if (ev.button !== 0 || compact || !draft || (ev.target.closest && ev.target.closest('button'))) return;
    const layerRect = els.layer.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    editorDrag = {
      pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY,
      startLeft: rect.left - layerRect.left, startTop: rect.top - layerRect.top, w: rect.width, h: rect.height, moved: false,
    };
    const onMove = moveEv => {
      if (!editorDrag || moveEv.pointerId !== editorDrag.pointerId || !draft) return;
      const dx = moveEv.clientX - editorDrag.startX;
      const dy = moveEv.clientY - editorDrag.startY;
      if (!editorDrag.moved && Math.hypot(dx, dy) < CARD_DRAG_THRESHOLD_PX) return;
      editorDrag.moved = true;
      moveEv.preventDefault();
      const placed = clampRect({ x: editorDrag.startLeft + dx, y: editorDrag.startTop + dy, w: editorDrag.w, h: editorDrag.h },
        { width: layerRect.width, height: layerRect.height });
      draft.editorPos = { x: placed.x, y: placed.y };
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      editorDrag = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  // ==========================================================================
  // SECTION: WRITES THAT SELECT / HIDE / DELETE / RE-ATTACH
  // ==========================================================================
  function toggleHidden(id) {
    const reason = blockedReason();
    if (reason) {
      setStatus(blockedMessage(reason));
      return;
    }
    const record = recordById(id);
    if (!currentPack() || !(isCallout(record) || isStyled(record))) return;
    // Hiding the callout whose editor is open closes that editor: nothing is saved, and unsaved edits are
    // only discarded after the owner agrees. Declining leaves the editor and the visibility untouched.
    if (!record.hidden && draft && draft.editId === id) {
      if (!draftIsDirty()) {
        closeEditingFor(id);
        writeHidden(id);
        return;
      }
      const epoch = sessionEpoch;
      confirmDiscard({
        title: 'Discard changes?',
        message: `Hiding "${record.title}" closes its editor and discards your unsaved changes.`,
        okLabel: 'Discard and hide',
      }).then(confirmed => {
        if (!confirmed || epoch !== sessionEpoch || !draft || draft.editId !== id) return;
        closeEditingFor(id);
        writeHidden(id);
      });
      return;
    }
    writeHidden(id);
  }

  /** Scrolls the nearest scrolling ancestor just far enough to show a row. Called on a selection change only, never per frame. */
  function revealRow(row) {
    if (!row || !row.el.isConnected) return;
    let scroller = row.el.parentElement;
    while (scroller && scroller !== doc.body) {
      if (/(auto|scroll)/.test(doc.defaultView.getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === doc.body) return;
    const box = scroller.getBoundingClientRect();
    const item = row.el.getBoundingClientRect();
    if (box.height === 0) return;
    if (item.top < box.top) scroller.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) scroller.scrollTop += item.bottom - box.bottom;
  }

  /** Opens the inline rename of an arrow or a drawing in its own row. Nothing is written until the name is committed. */
  function startRename(id) {
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const record = recordById(id);
    if (!isArrow(record) && !isDraw(record)) return;
    renamingId = id;
    renderPanel();
  }

  /**
   * Ends an inline rename. A commit writes the name through the same arrow or drawing update as every other look
   * change; a blank name removes the custom name so the generated one shows again. Escape (commit false) writes nothing.
   */
  function finishRename(id, value, commit, { refocus = false } = {}) {
    if (renamingId !== id) return;
    renamingId = null;
    const pack = currentPack();
    const record = recordById(id);
    if (commit && pack && record && !blockedReason() && (isArrow(record) || isDraw(record))) {
      const outcome = isArrow(record)
        ? PackLibrary.updateArrow(pack.id, id, { name: value })
        : PackLibrary.updateDraw(pack.id, id, { name: value });
      if (!outcome.ok) {
        UIComponents.showToast(`Could not rename this ${isArrow(record) ? 'arrow' : 'drawing'}.`, 'error', { title: 'Annotations' });
      }
    }
    renderPanel();
    if (refocus) {
      const row = rows.get(id);
      if (row && typeof row.edit.focus === 'function') row.edit.focus({ preventScroll: true });
    }
  }

  function writeHidden(id) {
    if (blockedReason()) return;
    const pack = currentPack();
    const record = recordById(id);
    if (!pack || !(isCallout(record) || isStyled(record))) return;
    const patch = { hidden: !record.hidden };
    let outcome;
    if (isArrow(record)) outcome = PackLibrary.updateArrow(pack.id, id, patch);
    else if (isDraw(record)) outcome = PackLibrary.updateDraw(pack.id, id, patch);
    else outcome = PackLibrary.updateCallout(pack.id, id, patch);
    const noun = isArrow(record) ? 'arrow' : (isDraw(record) ? 'drawing' : 'callout');
    if (!outcome.ok) UIComponents.showToast(`Could not change this ${noun}.`, 'error', { title: 'Annotations' });
  }

  /**
   * Change the look of arrows (color, weight, line style). With an arrow selected the change is written to that arrow
   * alone (one record edit, ends untouched) and the defaults stay as they were; with none selected it sets the look of the
   * next new arrows and writes nothing.
   */
  function setArrowStyle(patch) {
    const record = recordById(selectedId);
    const editing = isArrow(record);
    // A selected arrow is edited on its own; only with none selected does this set what the next new arrows look like.
    const next = { ...(editing ? { ...record, style: lineStyleOf(record) } : arrowStyle), ...patch };
    if (!next.color || !ARROW_WIDTHS.includes(next.width) || !LINE_STYLES.includes(next.style)) return;
    if (editing) {
      const reason = blockedReason();
      if (reason) {
        notice(blockedMessage(reason));
        return;
      }
      const pack = currentPack();
      if (!pack) return;
      const outcome = PackLibrary.updateArrow(pack.id, record.id, patch);
      if (!outcome.ok) UIComponents.showToast('Could not change this arrow.', 'error', { title: 'Annotations' });
      return;
    }
    arrowStyle = { color: next.color, width: next.width, style: next.style };
    renderPanel();
    refreshOverlay();
  }

  /**
   * Change the look of drawings (color, weight, line style). With a drawing selected the change is written to that drawing
   * alone (one record edit, vertices untouched) and the defaults stay as they were; with none selected it sets the look of the
   * next new drawings and writes nothing. Separate from the arrow defaults.
   */
  function setDrawStyle(patch) {
    const record = recordById(selectedId);
    const editing = isDraw(record);
    const next = { ...(editing ? { ...record, style: lineStyleOf(record) } : drawStyle), ...patch };
    if (!next.color || !DRAW_WIDTHS.includes(next.width) || !LINE_STYLES.includes(next.style)) return;
    if (editing) {
      const reason = blockedReason();
      if (reason) {
        notice(blockedMessage(reason));
        return;
      }
      const pack = currentPack();
      if (!pack) return;
      const outcome = PackLibrary.updateDraw(pack.id, record.id, patch);
      if (!outcome.ok) UIComponents.showToast('Could not change this drawing.', 'error', { title: 'Annotations' });
      return;
    }
    drawStyle = { color: next.color, width: next.width, style: next.style };
    renderPanel();
    refreshOverlay();
  }

  /** Close the editor for `id` and end anything that was moving it, using the same cleanup as Cancel. */
  function closeEditingFor(id) {
    if (pinDrag && pinDrag.id === id) cancelPinDrag();
    if (cardDrag && cardDrag.id === id) cancelCardDrag();
    if (draft && draft.editId === id) cancelDraft();
  }

  /** True when the open editor holds text, color or option changes that Save would write. */
  function draftIsDirty() {
    if (!draft) return false;
    const title = normalizeCalloutTitle(draft.title);
    const description = normalizeCalloutDescription(draft.description);
    if (draft.editId) {
      const stored = recordById(draft.editId);
      if (!isCallout(stored)) return false;
      return title !== stored.title || description !== (stored.description || null) ||
        draft.color !== stored.color || draft.keepExpanded !== stored.keepExpanded;
    }
    return Boolean(title || description || draft.color !== 'ink' || draft.keepExpanded);
  }

  /**
   * The discard dialog. Its message is built as an element with textContent: the modal API treats a string as
   * trusted HTML, and the message names user-authored text.
   */
  function confirmDiscard({ message, ...options }) {
    const content = htmlEl('div');
    content.textContent = message;
    return UIComponents.confirm({ cancelLabel: 'Keep editing', danger: true, ...options, message: content }).catch(() => false);
  }

  // ==========================================================================
  // SECTION: GLOBAL SHOW (All / Selected / Off) — a view setting, never written to the Load Plan
  // ==========================================================================
  /** Whether the global Show mode lets this (already drawable) callout be drawn. */
  function isShownByMode(id) {
    return showMode === 'all' || (showMode === 'selected' && id === selectedId);
  }

  /**
   * Change the global Show mode. All and Selected only filter what is drawn. Off also ends every gesture that
   * would otherwise act on graphics the owner cannot see; an editor with unsaved changes is only closed after
   * the owner agrees, and declining changes nothing.
   */
  function requestShowMode(mode) {
    if (!SHOW_MODES.some(([key]) => key === mode) || mode === showMode) return;
    if (mode === 'off' && draft && draftIsDirty()) {
      const epoch = sessionEpoch;
      const openDraft = draft;
      confirmDiscard({
        title: 'Discard changes?',
        message: 'Turning annotations off closes the open callout editor and discards its unsaved changes.',
        okLabel: 'Discard and turn off',
      }).then(confirmed => {
        // The answer belongs to the session and editor that asked: a Load Plan change, workspace replacement or
        // a different editor in the meantime makes it void.
        if (!confirmed || epoch !== sessionEpoch || draft !== openDraft || showMode === 'off') return;
        applyShowMode('off');
      });
      return;
    }
    applyShowMode(mode);
  }

  function applyShowMode(mode) {
    if (mode === 'off') {
      cancelStroke();
      cancelMoveDrag();
      if (pinDrag) cancelPinDrag();
      if (cardDrag) cancelCardDrag();
      if (draft) cancelDraft();
      arrowTail = null;
      reattachId = null;
      reattachWhich = null;
      tool = null;
      hover = null;
      press = null;
      selectedId = null;
      applyViewGate();
      updateCursor();
    }
    showMode = mode;
    visDirty = true;
    renderPanel();
    refreshOverlay();
    if (mode === 'off') refocusViewportIfLost();
  }

  /**
   * A single click deletes: no confirm step. The toast only reports it; the shared StateStore Undo (Ctrl/Cmd+Z)
   * brings it back, in order with cargo, measurement and other annotation edits.
   * Cargo is never touched. Focus only moves on when the delete came from the keyboard.
   */
  function removeAnnotation(id, viaKeyboard = false) {
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    if (!pack) return;
    const index = records.findIndex(record => record.id === id);
    const removed = recordById(id);
    if (!removed) return;
    if (draft && draft.editId === id) cancelDraft();
    if (pinDrag && pinDrag.id === id) cancelPinDrag();
    if (cardDrag && cardDrag.id === id) cancelCardDrag();
    if (moveDrag && moveDrag.id === id) cancelMoveDrag();
    if (reattachId === id) {
      reattachId = null;
      reattachWhich = null;
    }
    if (selectedId === id) selectedId = null;
    collapsedIds.delete(id);
    const outcome = PackLibrary.deleteAnnotation(pack.id, id);
    if (!outcome.ok) {
      renderPanel();
      return;
    }
    UIComponents.showToast(`${annotationNoun(outcome.removed)} deleted.`, 'info', { title: 'Annotations' });
    setStatus('', { sticky: true });
    if (!viaKeyboard) return;
    const next = records[Math.min(index, records.length - 1)];
    const row = next ? rows.get(next.id) : null;
    const target = row && !row.select.disabled ? row.select : (panelParts && panelParts.toggle);
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    else refocusViewportIfLost();
  }

  /** The noun a toast uses for a record: a callout, an arrow, a drawing or an annotation that could not be read. */
  function annotationNoun(record) {
    if (record.type === ANNOTATION_TYPE_CALLOUT) return 'Callout';
    if (record.type === ANNOTATION_TYPE_ARROW) return 'Arrow';
    if (record.type === ANNOTATION_TYPE_DRAW) return 'Drawing';
    return 'Unreadable annotation';
  }

  /**
   * After a successful annotation write, make that callout the selection the same way select() does: the cargo
   * selection is cleared (so Delete and the arrow keys can never act on cargo while a callout is selected),
   * unless the Editor holds a provisional pose, which must not be abandoned.
   */
  function adoptSelection(id) {
    if (!id || id === selectedId || provisionalPoseActive()) return;
    clearCargoSelection();
    selectedId = id;
  }

  /** Wait for a surface to attach a callout's marker (or, with `which`, one end of an arrow) to. */
  function startReattach(id, which = null) {
    const record = recordById(id);
    const arrowEnd = isArrow(record) && (which === 'start' || which === 'end');
    if (!isCallout(record) && !arrowEnd) return;
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    if (showMode === 'off') {
      notice(SHOW_OFF_HINT);
      return;
    }
    if (draft) cancelDraft();
    cancelArrowTail();
    tool = null;
    reattachId = id;
    reattachWhich = arrowEnd ? which : null;
    hover = null;
    hoverDirty = true;
    select(id);
    setStatus('', { sticky: true });
    updateCursor();
  }

  function cancelReattach(message = '') {
    if (!reattachId) return;
    reattachId = null;
    reattachWhich = null;
    hover = null;
    updateCursor();
    if (message) setStatus(message);
    else renderPanel();
  }

  /**
   * Move a callout's marker (or, with `which`, one end of an arrow) onto a surface the owner chose.
   * Annotation-only: cargo is never touched.
   */
  function commitReattach(id, picked, which = null) {
    const pack = currentPack();
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return false;
    }
    const record = recordById(id);
    if (!pack || !record) return false;
    if (isArrow(record)) {
      if (which !== 'start' && which !== 'end') return false;
      const moved = PackLibrary.moveArrowEndpoint(pack.id, id, which, picked.anchor);
      if (!moved.ok) {
        // Picking the other end's own spot is rejected as identical ends ('invalid'): the same advice applies.
        if (moved.reason === 'too-short' || moved.reason === 'invalid') notice('That would make the arrow too short. Pick a spot farther from the other end.');
        else UIComponents.showToast('Could not move this end of the arrow.', 'error', { title: 'Annotations' });
        return false;
      }
      reattachId = null;
      reattachWhich = null;
      hover = null;
      adoptSelection(id);
      updateCursor();
      setStatus(moved.unchanged ? 'The arrow end is already attached there.' : `Arrow ${ARROW_END_NAMES[which]} moved.`, { tone: 'success' });
      return true;
    }
    const outcome = PackLibrary.reattachCallout(pack.id, id, picked.anchor);
    if (!outcome.ok) {
      UIComponents.showToast('Could not move this callout.', 'error', { title: 'Annotations' });
      return false;
    }
    reattachId = null;
    hover = null;
    adoptSelection(id);
    updateCursor();
    setStatus('Callout re-attached.', { tone: 'success' });
    return true;
  }

  // ==========================================================================
  // SECTION: DRAGS (marker onto a new surface, card to a new place)
  // ==========================================================================
  /** Start dragging a callout marker, or (with `which`) one end of the selected arrow, onto another surface. */
  function beginPinDrag(ev, id, which = null) {
    if (ev.button !== 0 || pinDrag || cardDrag) return;
    const pack = currentPack();
    if (!pack) return;
    let poseKey;
    if (id === DRAFT_ID) {
      if (!draft) return;
      poseKey = cargoPoseKey(pack, draft.anchor);
    } else {
      const record = recordById(id);
      const result = resultById(id);
      if (!(which ? isArrow(record) : isCallout(record)) || !result || result.status !== ANNOTATION_STATUS.VALID || blockedReason()) return;
      // A grip belongs to the selected arrow only. A grip still on screen after another tool was armed, or after the selection
      // moved on, must never start an edit, whatever the render timing.
      if (which && (selectedId !== id || tool || sceneOwnedElsewhere())) return;
      poseKey = which ? arrowPoseKey(pack, record) : cargoPoseKey(pack, record.anchor);
    }
    const target = ev.currentTarget || ev.target;
    pinDrag = { id, which, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, moved: false, dirty: false, candidate: null, poseKey, target };
    lastClient = { x: ev.clientX, y: ev.clientY };
    window.addEventListener('pointermove', onPinDragMove);
    window.addEventListener('pointerup', onPinDragUp);
    window.addEventListener('pointercancel', onPinDragCancel);
  }

  function onPinDragMove(ev) {
    if (!pinDrag || ev.pointerId !== pinDrag.pointerId) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    if (!pinDrag.moved) {
      if (Math.hypot(ev.clientX - pinDrag.startX, ev.clientY - pinDrag.startY) < PIN_DRAG_THRESHOLD_PX) return;
      pinDrag.moved = true;
      try {
        if (pinDrag.target && typeof pinDrag.target.setPointerCapture === 'function') pinDrag.target.setPointerCapture(ev.pointerId);
      } catch (_) {
        // Capture is a convenience; the window listeners still end the drag.
      }
      CaseScene.setHover(null);
    }
    ev.preventDefault();
    pinDrag.dirty = true;
    updateCursor();
  }

  function onPinDragUp(ev) {
    if (!pinDrag || ev.pointerId !== pinDrag.pointerId) return;
    const finished = pinDrag;
    endPinDrag();
    if (!finished.moved) return; // an ordinary click: the click handler selects
    suppressNextClick();
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const outcome = {};
    const picked = pick(ev.clientX, ev.clientY, outcome);
    if (!picked) {
      notice(`${pickRefusal(outcome.blocked) || `Drop the ${finished.which ? 'handle' : 'marker'} on cargo, the truck or the ground.`} It was left where it was.`);
      return;
    }
    const pack = currentPack();
    if (finished.id === DRAFT_ID) {
      if (draft && pack) moveDraftAnchor(picked, pack);
      return;
    }
    commitReattach(finished.id, picked, finished.which);
  }

  function onPinDragCancel(ev) {
    if (!pinDrag || ev.pointerId !== pinDrag.pointerId) return;
    cancelPinDrag('Move cancelled.');
  }

  function endPinDrag() {
    if (!pinDrag) return;
    const { target, pointerId } = pinDrag;
    try {
      if (target && typeof target.releasePointerCapture === 'function' && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (_) {
      // Already released.
    }
    window.removeEventListener('pointermove', onPinDragMove);
    window.removeEventListener('pointerup', onPinDragUp);
    window.removeEventListener('pointercancel', onPinDragCancel);
    pinDrag = null;
    visDirty = true;
    updateCursor();
  }

  /** Abandon the marker drag; the anchor is simply never changed, so there is nothing to restore. */
  function cancelPinDrag(message = '') {
    if (!pinDrag) return;
    const moved = pinDrag.moved;
    endPinDrag();
    if (message && moved) setStatus(message);
    else if (message) renderPanel();
  }

  function beginCardDrag(ev, id) {
    if (ev.button !== 0 || pinDrag || cardDrag || blockedReason()) return;
    const view = views.get(id);
    if (!view || !view.cardRect || !view.screen) return;
    cardDrag = {
      id, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, target: ev.currentTarget || ev.target,
      startRect: { ...view.cardRect }, marker: { x: view.screen.x, y: view.screen.y }, moved: false, rect: null, offset: null,
    };
    window.addEventListener('pointermove', onCardDragMove);
    window.addEventListener('pointerup', onCardDragUp);
    window.addEventListener('pointercancel', onCardDragCancel);
  }

  function onCardDragMove(ev) {
    if (!cardDrag || ev.pointerId !== cardDrag.pointerId) return;
    const dx = ev.clientX - cardDrag.startX;
    const dy = ev.clientY - cardDrag.startY;
    if (!cardDrag.moved) {
      if (Math.hypot(dx, dy) < CARD_DRAG_THRESHOLD_PX) return;
      cardDrag.moved = true;
      try {
        if (cardDrag.target && typeof cardDrag.target.setPointerCapture === 'function') cardDrag.target.setPointerCapture(ev.pointerId);
      } catch (_) {
        // Capture is a convenience; the window listeners still end the drag.
      }
    }
    ev.preventDefault();
    const layerRect = els.layer.getBoundingClientRect();
    cardDrag.rect = clampRect({ ...cardDrag.startRect, x: cardDrag.startRect.x + dx, y: cardDrag.startRect.y + dy },
      { width: layerRect.width, height: layerRect.height });
    cardDrag.offset = offsetFromRect(cardDrag.marker, cardDrag.rect);
    visDirty = true;
  }

  function onCardDragUp(ev) {
    if (!cardDrag || ev.pointerId !== cardDrag.pointerId) return;
    const finished = cardDrag;
    endCardDrag();
    if (!finished.moved) return; // an ordinary click: the click handler selects
    suppressNextClick();
    const pack = currentPack();
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    if (!pack || !recordById(finished.id) || !finished.offset) return;
    const clamp = value => Math.max(-MAX_CARD_OFFSET_PX, Math.min(MAX_CARD_OFFSET_PX, value));
    const outcome = PackLibrary.setCalloutOffset(pack.id, finished.id, { dx: clamp(finished.offset.dx), dy: clamp(finished.offset.dy) });
    if (!outcome.ok) UIComponents.showToast('Could not move this card.', 'error', { title: 'Annotations' });
    else setStatus('Card moved. The callout stays attached to its cargo.', { tone: 'success' });
  }

  function onCardDragCancel(ev) {
    if (!cardDrag || ev.pointerId !== cardDrag.pointerId) return;
    cancelCardDrag();
  }

  function endCardDrag() {
    if (!cardDrag) return;
    const { target, pointerId } = cardDrag;
    try {
      if (target && typeof target.releasePointerCapture === 'function' && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (_) {
      // Already released.
    }
    window.removeEventListener('pointermove', onCardDragMove);
    window.removeEventListener('pointerup', onCardDragUp);
    window.removeEventListener('pointercancel', onCardDragCancel);
    cardDrag = null;
    visDirty = true;
  }

  /** Abandon the card drag; the stored offset was never changed. */
  function cancelCardDrag() {
    endCardDrag();
  }

  /** The click that follows a drag released over a marker or card must not also select it. */
  function suppressNextClick() {
    suppressClick = true;
    window.setTimeout(() => { suppressClick = false; }, 0);
  }

  // ==========================================================================
  // SECTION: DRAWING SELECT + MOVE (a saved stroke is carried rigidly along the surface it is on)
  // ==========================================================================
  /**
   * Whether a saved stroke may take a press right now. Derived, never stored: no armed tool or re-attach
   * (those own the canvas gestures), no unsaved stroke, open editor or other drag, no Measurement, not Show Off and
   * not paused. Each of those either owns the pointer or leaves the strokes out of reach.
   */
  function drawHitReachable() {
    return toolShown && inEditor() && !tool && !reattachId && !stroke && !draft && !pinDrag && !cardDrag &&
      !sceneOwnedElsewhere() && showMode !== 'off' && !blockedReason();
  }

  /** The same, and no move already under way: what a new press on a stroke needs. */
  function drawHitWanted() {
    return !moveDrag && drawHitReachable();
  }

  /** Shift, Ctrl or Cmd: OrbitControls pans on a primary press that carries any of them, so it is never a stroke gesture. */
  function navigationKeys(ev) {
    return Boolean(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
  }

  /**
   * The saved stroke whose line is at a client position, or ''. A stroke is tested on the screen geometry its last projection already
   * traced (the extent of its view), so nothing is projected or allocated here: a stroke is skipped by its padded bounding box before
   * any of its segments is read, so a press or a hover costs one comparison per stroke plus a scan of the strokes under the pointer.
   * Only what the overlay shows as clear can be taken (valid, shown, in front and measured), and where lines cross the one painted on
   * top wins, as it looks: the views are in the order their groups were added to the SVG.
   */
  function drawHitIdAt(clientX, clientY, pointerType = 'mouse') {
    if (!drawViews.size || !els.layer) return '';
    const rect = els.layer.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const reach = DRAW_HIT_REACH_PX[pointerType] || DRAW_HIT_REACH_PX.mouse;
    let found = '';
    drawViews.forEach((view, id) => {
      const shape = view.extent;
      if (!view.shown || !view.front || !view.measured || !shape.count) return;
      if (x < shape.left - reach || x > shape.right + reach || y < shape.top - reach || y > shape.bottom + reach) return;
      if (!drawableIds.has(id) || !isShownByMode(id)) return;
      if (nearTrace(shape, x, y, reach)) found = id;
    });
    return found;
  }

  /** Whether (x, y) is within `reach` of a traced stroke: its points are x, y pairs, and a NaN pair ends a sub-path. A dot is one point twice. */
  function nearTrace(shape, x, y, reach) {
    const xy = shape.xy;
    const limit = reach * reach;
    let ax = NaN;
    let ay = NaN;
    for (let i = 0; i < shape.count; i += 2) {
      const bx = xy[i];
      const by = xy[i + 1];
      if (Number.isNaN(bx)) {
        ax = NaN;
        continue;
      }
      if (!Number.isNaN(ax)) {
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ex = ax + t * dx - x;
        const ey = ay + t * dy - y;
        if (ex * ex + ey * ey <= limit) return true;
      }
      ax = bx;
      ay = by;
    }
    return false;
  }

  /**
   * The Editor's canvas pointerdown asks first: does a saved stroke's line take this press? Only a plain primary press does (Shift,
   * Ctrl and Cmd are camera navigation, the other buttons orbit and pan, and a second finger is a pinch). The press reaches the canvas
   * natively, so OrbitControls has read it already (its listener is on the same canvas and runs first): what keeps the camera still is
   * the rotation gate held until this pointer lifts, never the Editor's early return. True when the stroke takes the press: nothing
   * below it may select, drag or grab for it.
   */
  function claimPress(ev) {
    if (!ev) return false;
    if (ev === interruptEvent) { // the finger that ended a move is a camera finger now
      interruptEvent = null;
      return true;
    }
    if (ev.button !== 0 || ev.isPrimary === false || navigationKeys(ev) || (ev.pointerType !== 'touch' && ev.buttons !== 1)) return false;
    if (heldPointer || !drawHitWanted()) return false;
    const id = drawHitIdAt(ev.clientX, ev.clientY, ev.pointerType);
    if (id) return beginDrawPress(ev, id);
    // The body of the SELECTED Arrow carries the whole arrow. An Arrow that is not selected takes no press: it is selected by a click
    // (the Editor) and a drag that starts on it stays the camera or cargo drag it was. Its end grips are DOM buttons above the canvas, so
    // a press on one never gets here.
    const arrow = selectedArrowBodyAt(ev.clientX, ev.clientY, ev.pointerType);
    return Boolean(arrow) && beginDrawPress(ev, arrow);
  }

  /** The id of the selected Arrow when a client position is on its drawn shaft (and no other Arrow's is nearer), else ''. */
  function selectedArrowBodyAt(clientX, clientY, pointerType) {
    if (!selectedId || !isArrow(recordById(selectedId))) return '';
    const hit = arrowHitAt(clientX, clientY, pointerType);
    return hit && hit.id === selectedId ? selectedId : '';
  }

  /** Whether the pointer is one whose press a saved stroke took and has not yet let go: the Editor's hover and cargo handling leave it alone. */
  function ownsPointer(ev) {
    return Boolean(heldPointer && ev && ev.pointerId === heldPointer.pointerId);
  }

  /**
   * The saved Arrow whose drawn shaft is nearest a client position, within the pointer's reach: `{ id, distance }` in screen pixels, or
   * null. A pure query on the line the overlay painted last frame, so nothing is projected here. Only an Arrow drawn in front (the
   * dashed, occluded ones are not taken) and only while the scene is free: no armed tool, re-attach, open editor, drag or other tool
   * (the same condition a saved stroke needs). It never claims a press: the Editor selects an Arrow on a click, and a drag that
   * starts on the shaft stays the camera drag or cargo drag it was.
   */
  function arrowHitAt(clientX, clientY, pointerType = 'mouse') {
    if (!arrowViews.size || !els.layer || !drawHitWanted()) return null;
    const rect = els.layer.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const reach = DRAW_HIT_REACH_PX[pointerType] || DRAW_HIT_REACH_PX.mouse;
    let best = null;
    arrowViews.forEach((view, id) => {
      if (!view.shown || !view.front || !view.tail || !view.head) return;
      const distance = distanceToPolyline([view.tail.x, view.tail.y, view.head.x, view.head.y], x, y);
      if (distance <= reach && (!best || distance < best.distance)) best = { id, distance };
    });
    return best;
  }

  /** Whether the pointer is over a stroke's line that a plain press would take (for the grab cursor); touch has no hover. */
  function hoverDrawing(ev) {
    if (!ev || heldPointer || ev.pointerType === 'touch' || navigationKeys(ev) || !drawHitWanted()) return false;
    return Boolean(drawHitIdAt(ev.clientX, ev.clientY, ev.pointerType) || selectedArrowBodyAt(ev.clientX, ev.clientY, ev.pointerType));
  }

  function pointerOverCanvas(x, y) {
    const canvas = getCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function snapInches(value) {
    return Math.round(value * MOVE_GRID_STEPS) / MOVE_GRID_STEPS + 0;
  }

  /** What fixes a stroke's place: the surface it is on, the face and every vertex (a style edit leaves it alone). */
  function moveShapeOf(record) {
    return isArrow(record) ? JSON.stringify([record.start, record.end]) : JSON.stringify([record.anchor, record.face, record.points]);
  }

  /** Fingerprint of the committed cargo pose under whatever a whole-object move carries (a stroke's anchor, or both ends of an arrow). */
  function movePoseKey(pack, record) {
    return isArrow(record) ? arrowPoseKey(pack, record) : cargoPoseKey(pack, record.anchor);
  }

  function moveSubject(drag) {
    return drag && drag.subject === 'arrow' ? 'arrow' : 'drawing';
  }

  /**
   * A plain primary press that a saved stroke's line took (see claimPress). Nothing is written or selected here: a release without a
   * drag selects the stroke, a drag past the threshold carries the whole stroke along the plane it is on. The press position on that
   * plane is the baseline every later position is measured from, never an accumulated delta. A stroke that cannot be carried right
   * now (a held pose, a surface that cannot be read) still takes the press, so no cargo under it is touched; its release selects it
   * or explains why it cannot be.
   */
  function beginDrawPress(ev, id) {
    const record = recordById(id);
    const result = resultById(id);
    const pack = currentPack();
    const target = getCanvas();
    const arrow = isArrow(record);
    if (!pack || !target || !(arrow || isDraw(record)) || !result || result.status !== ANNOTATION_STATUS.VALID || record.hidden || !isShownByMode(id)) return false;
    keyboardModality = false;
    holdPointer(ev);
    // A stroke moves along the face its anchor names; an arrow along the one surface BOTH ends share, or not at all.
    const shared = arrow ? rigidMoveFrame(record.start, record.end) : null;
    const place = arrow ? (shared.ok ? { anchor: record.start, face: shared.face } : null) : { anchor: record.anchor, face: record.face };
    const surface = provisionalPoseActive() || !place ? null : picker.beginDrawSurface(place, pack);
    const base = surface ? picker.sampleDrawPlane(surface, ev.clientX, ev.clientY) : null;
    const view = arrow ? arrowViews.get(id) : drawViews.get(id);
    const movable = Boolean(surface && view && base && base.status === 'ok');
    moveDrag = {
      id, subject: arrow ? 'arrow' : 'drawing', pair: null, pointerId: ev.pointerId, pointerType: ev.pointerType || 'mouse', startX: ev.clientX, startY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, target,
      movable, stray: false, moved: false, dirty: false, packId: pack.id, epoch: sessionEpoch, surface, base: movable ? { u: base.u, v: base.v } : null,
      shape: moveShapeOf(record), poseKey: movePoseKey(pack, record), layoutKey: layoutKey(pack), poseStamp: view && !arrow ? view.poseStamp : 0,
      du: 0, dv: 0, rev: 0, valid: true, reason: '', kind: 'ok', verdictKey: '',
    };
    lastClient = { x: ev.clientX, y: ev.clientY };
    attachMoveListeners(target);
    ensureLoop();
    return true;
  }

  function attachMoveListeners(target) {
    window.addEventListener('pointermove', onMoveDragMove);
    window.addEventListener('pointerup', onMoveDragUp);
    window.addEventListener('pointercancel', onMoveDragCancel);
    window.addEventListener('blur', onMoveDragInterrupted);
    if (doc) doc.addEventListener('visibilitychange', onMoveDragVisibility);
    if (target) target.addEventListener('lostpointercapture', onMoveDragLost);
  }

  function detachMoveListeners(target) {
    window.removeEventListener('pointermove', onMoveDragMove);
    window.removeEventListener('pointerup', onMoveDragUp);
    window.removeEventListener('pointercancel', onMoveDragCancel);
    window.removeEventListener('blur', onMoveDragInterrupted);
    if (doc) doc.removeEventListener('visibilitychange', onMoveDragVisibility);
    if (target) target.removeEventListener('lostpointercapture', onMoveDragLost);
  }

  /**
   * Keep the camera's rotation off from a press a saved stroke took until that pointer lifts, however the move ends meanwhile (Escape, a
   * blur, a changed plan): a pointer still down is a gesture OrbitControls already began, and it would start rotating the moment the gate
   * lifted. The window sees every pointer event first (capture), so a stale hold or a second finger is dealt with before OrbitControls
   * reads that press.
   */
  function holdPointer(ev) {
    releaseHeldPointer();
    heldPointer = { pointerId: ev.pointerId, pointerType: ev.pointerType || 'mouse' };
    for (const type of HELD_POINTER_EVENTS) window.addEventListener(type, onHeldPointer, { capture: true, passive: true });
    applyViewGate();
  }

  function releaseHeldPointer() {
    if (!heldPointer) return;
    heldPointer = null;
    for (const type of HELD_POINTER_EVENTS) window.removeEventListener(type, onHeldPointer, { capture: true });
    applyViewGate();
  }

  function onHeldPointer(ev) {
    const held = heldPointer;
    if (!held) return;
    if (ev.type === 'pointerdown') {
      if (ev.pointerId === held.pointerId) { // the id came round again: the end of the old press was lost, so its move is abandoned, never finished by this press
        if (moveDrag) cancelMoveDrag('Move cancelled.');
        releaseHeldPointer();
        return;
      }
      // A different pointer pressed. The gate is not per pointer and the held press may still be physically down, so this is an ownership
      // conflict: the move ends without a write and the gate lifts BEFORE OrbitControls reads this press, which it then takes natively.
      if (moveDrag) cancelMoveDrag('Move cancelled.');
      // A second finger is a pinch with the first one OrbitControls already tracks, so this same press must not start a cargo drag either;
      // a pointer of another kind is an ordinary fresh press, left to the Editor as ever.
      if (ev.pointerType === 'touch' && held.pointerType === 'touch') interruptEvent = ev;
      releaseHeldPointer();
      return;
    }
    if (ev.pointerId !== held.pointerId) return;
    if (ev.type === 'pointermove') {
      if (ev.pointerType !== 'touch' && ev.buttons === 0) releaseHeldPointer(); // released where no event could say so
      return;
    }
    releaseHeldPointer(); // pointerup or pointercancel
  }

  function onMoveDragInterrupted() {
    if (moveDrag) cancelMoveDrag('Move cancelled.');
  }

  function onMoveDragVisibility() {
    if (moveDrag && doc && doc.visibilityState === 'hidden') cancelMoveDrag('Move cancelled.');
  }

  function onMoveDragCancel(ev) {
    if (moveDrag && ev.pointerId === moveDrag.pointerId) cancelMoveDrag('Move cancelled.');
  }

  function onMoveDragLost(ev) {
    if (moveDrag && ev.pointerId === moveDrag.pointerId) cancelMoveDrag('Move cancelled.');
  }

  function onMoveDragMove(ev) {
    const drag = moveDrag;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    // A button other than the primary joining the press (a pen's barrel button included), or the primary no longer held (the release
    // was lost), ends the move.
    if (ev.pointerType !== 'touch' && ev.buttons !== 1) {
      cancelMoveDrag('Move cancelled.');
      return;
    }
    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    lastClient = { x: ev.clientX, y: ev.clientY };
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < PIN_DRAG_THRESHOLD_PX) return;
      if (!drag.movable) { // a stroke that cannot be carried does not take a drag as a click either
        const stored = drag.subject === 'arrow' ? recordById(drag.id) : null;
        if (!drag.stray && stored && !rigidMoveFrame(stored.start, stored.end).ok) notice(ARROW_MOVE_UNSUPPORTED);
        drag.stray = true;
        return;
      }
      drag.moved = true;
      drag.rev = 1;
      try {
        if (drag.target && typeof drag.target.setPointerCapture === 'function') drag.target.setPointerCapture(ev.pointerId);
      } catch (_) {
        // Capture is a convenience; the window listeners still end the move.
      }
      CaseScene.setHover(null);
      updateCursor();
      renderPanel();
    }
    ev.preventDefault();
    drag.dirty = true;
  }

  /**
   * Where the pointer is on the stroke's own plane and whether the WHOLE stroke may sit there. The offset is measured from the press
   * and snapped to the grid; the verdict is the writer's own (a valid record, and every vertex on the one cargo face, cap, floor or
   * wall patch it belongs to), asked without writing. An unreadable position (the ray misses the plane) is a position the stroke
   * cannot take. `provisional` means the Editor now holds a scene-only pose.
   */
  function judgeMove(drag, x, y) {
    // A whole arrow released off the 3D view is cancelled, never resolved against wherever the ray meets its plane far away.
    if (drag.subject === 'arrow' && !pointerOverCanvas(x, y)) return { status: 'off', du: drag.du, dv: drag.dv, valid: false, reason: 'view' };
    const sample = picker.sampleDrawPlane(drag.surface, x, y);
    if (sample.status === 'provisional') return { status: 'provisional' };
    if (sample.status !== 'ok') return { status: 'off', du: drag.du, dv: drag.dv, valid: false, reason: 'view' };
    const du = snapInches(sample.u - drag.base.u);
    const dv = snapInches(sample.v - drag.base.v);
    const verdict = drag.subject === 'arrow' ? PackLibrary.checkArrowMove(drag.packId, drag.id, du, dv) : PackLibrary.checkDrawMove(drag.packId, drag.id, du, dv);
    return { status: 'ok', du, dv, valid: Boolean(verdict.ok), reason: verdict.ok ? '' : verdict.reason };
  }

  /** Take a verdict into the live move: the preview geometry follows the offset, and the panel line follows the kind of verdict. */
  function applyMoveJudgement(drag, judged) {
    if (judged.du !== drag.du || judged.dv !== drag.dv) {
      drag.du = judged.du;
      drag.dv = judged.dv;
      drag.rev += 1;
      if (drag.subject === 'arrow') {
        const record = recordById(drag.id);
        drag.pair = record ? translateAnchorPair(record.start, record.end, drag.du, drag.dv) : null;
      }
    }
    drag.valid = judged.valid;
    drag.reason = judged.reason;
    const kind = judged.valid ? 'ok' : (judged.reason === 'view' ? 'view' : 'off');
    if (kind !== drag.kind) {
      drag.kind = kind;
      renderPanel();
    }
  }

  /** Each frame while a stroke is carried: anything that changed under it ends the move, then the pointer's latest position is judged once. */
  function advanceMove() {
    const drag = moveDrag;
    if (!drag || !drag.movable) return;
    if (provisionalPoseActive()) {
      cancelMoveDrag(HELD_POSE_NOTICE);
      return;
    }
    const subject = moveSubject(drag);
    if (drag.subject === 'arrow') {
      const record = recordById(drag.id);
      const pack = currentPack();
      if (!record || !drawableIds.has(drag.id) || !isShownByMode(drag.id)) {
        cancelMoveDrag(`The ${subject} changed, so the move was cancelled.`);
        return;
      }
      if (!pack || movePoseKey(pack, record) !== drag.poseKey) {
        cancelMoveDrag('The cargo changed, so the move was cancelled.');
        return;
      }
    } else {
      const view = drawViews.get(drag.id);
      if (!view || !drawableIds.has(drag.id) || !isShownByMode(drag.id)) {
        cancelMoveDrag(`The ${subject} changed, so the move was cancelled.`);
        return;
      }
      if (view.poseStamp !== drag.poseStamp) {
        cancelMoveDrag('The cargo changed, so the move was cancelled.');
        return;
      }
    }
    if (!drag.moved || !drag.dirty) return;
    drag.dirty = false;
    const judged = judgeMove(drag, drag.lastX, drag.lastY);
    if (judged.status === 'provisional') cancelMoveDrag(HELD_POSE_NOTICE);
    else applyMoveJudgement(drag, judged);
  }

  function onMoveDragUp(ev) {
    const finished = moveDrag;
    if (!finished || ev.pointerId !== finished.pointerId) return;
    // The release position decides, not the last frame's: judged on the finished gesture, which is cleared before anything below
    // can notify, so no trailing cancellation can reach a move that already ended.
    const judged = finished.moved ? judgeMove(finished, ev.clientX, ev.clientY) : null;
    endMoveDrag();
    if (!finished.moved) { // an ordinary click
      clickDrawing(finished);
      return;
    }
    suppressNextClick();
    commitMove(finished, judged);
    refreshOverlay(); // the moved drawing, or the one a refused move left where it was, is on screen now rather than a frame later
  }

  /** A press that never became a drag is a click: it selects the stroke like its list row does (or deselects it, if it already was). Nothing is written. */
  function clickDrawing(finished) {
    if (finished.subject === 'arrow') return; // a click on the selected arrow's body leaves it selected, as it always did
    if (finished.stray || !recordById(finished.id) || !drawableIds.has(finished.id) || !drawHitWanted()) return;
    select(finished.id, { toggle: true });
    refocusViewportIfLost();
  }

  /**
   * Write the finished move, once, if everything it was measured against is still as it was. Whether the moved stroke is valid and
   * still sits wholly on its surface is PackLibrary.moveDraw's rule; this only checks the session, the plan and the tool are still
   * the ones the move belongs to, and explains a refusal. A refused or cancelled move leaves the stored stroke exactly as it was.
   */
  function commitMove(finished, judged) {
    const reason = blockedReason();
    if (reason) {
      notice(blockedMessage(reason));
      return;
    }
    const pack = currentPack();
    const record = recordById(finished.id);
    if (!pack || pack.id !== finished.packId || finished.epoch !== sessionEpoch || !toolShown || showMode === 'off' ||
        sceneOwnedElsewhere() || provisionalPoseActive() || !record || moveShapeOf(record) !== finished.shape) {
      setStatus(`The ${moveSubject(finished)} changed, so the move was cancelled.`);
      return;
    }
    if (movePoseKey(pack, record) !== finished.poseKey || layoutKey(pack) !== finished.layoutKey) {
      setStatus('The cargo changed, so the move was cancelled.');
      return;
    }
    const arrow = finished.subject === 'arrow';
    const subject = moveSubject(finished);
    const refused = arrow ? ARROW_MOVE_REFUSED : DRAW_MOVE_REFUSED;
    if (!judged || judged.status !== 'ok' || !judged.valid) {
      notice(refused);
      return;
    }
    if (!judged.du && !judged.dv) {
      setStatus(`The ${subject} was left where it was.`);
      return;
    }
    const outcome = arrow ? PackLibrary.moveArrow(pack.id, finished.id, judged.du, judged.dv) : PackLibrary.moveDraw(pack.id, finished.id, judged.du, judged.dv);
    if (!outcome.ok) {
      if (outcome.reason === 'invalid' || outcome.reason === 'unresolved' || outcome.reason === 'too-short') notice(refused);
      else UIComponents.showToast(`Could not move this ${subject}.`, 'error', { title: 'Annotations' });
      return;
    }
    adoptSelection(finished.id);
    visDirty = true;
    setStatus(outcome.unchanged ? `The ${subject} was left where it was.` : (arrow ? 'Arrow moved.' : 'Drawing moved.'), { tone: 'success' });
  }

  /** Release everything a move holds. After this no pointer event can reach it, so none can bring it back. */
  function endMoveDrag() {
    if (!moveDrag) return;
    const { target, pointerId } = moveDrag;
    detachMoveListeners(target);
    moveDrag = null;
    try {
      if (target && typeof target.releasePointerCapture === 'function' && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (_) {
      // Already released.
    }
    visDirty = true;
    updateCursor();
  }

  /** Abandon the move: the stored stroke was never touched, so showing it where it is IS the restore. */
  function cancelMoveDrag(message = '') {
    if (!moveDrag) return;
    const moved = moveDrag.moved;
    endMoveDrag();
    if (moved || message) setStatus(message);
    refreshOverlay();
  }

  /**
   * The stroke's vertices shifted by the live offset, in the frame they are stored in (scene units). A scratch copy: the record, the
   * view's own geometry and the cargo are never changed, so cancelling needs no restore.
   */
  function movedLocal(view, record) {
    const axes = cargoFaceFrame(drawFrameKey(record.anchor, record.face));
    if (!axes || !view.local) return view.local;
    if (!view.moved || view.moved.length !== view.local.length) view.moved = new Float64Array(view.local.length);
    view.moved.set(view.local);
    const scale = picker.toWorldScale();
    const iu = AXIS_INDEX[axes.u];
    const iv = AXIS_INDEX[axes.v];
    for (let i = 0; i < view.moved.length; i += 3) {
      view.moved[i + iu] += moveDrag.du * scale;
      view.moved[i + iv] += moveDrag.dv * scale;
    }
    return view.moved;
  }

  // ==========================================================================
  // SECTION: OVERLAY EVENTS (markers and cards are ordinary DOM above the canvas)
  // ==========================================================================
  function attachLayerEvents(layer) {
    layer.addEventListener('pointerdown', ev => {
      if (!toolShown || sceneOwnedElsewhere()) return;
      keyboardModality = false;
      const grip = ev.target.closest && ev.target.closest('.tp3d-annot-handle');
      if (grip && layer.contains(grip)) {
        beginPinDrag({ button: ev.button, pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY, currentTarget: grip, target: grip }, grip.dataset.annotId, grip.dataset.end);
        return;
      }
      const pin = ev.target.closest && ev.target.closest('.tp3d-annot-pin');
      if (pin && layer.contains(pin)) {
        beginPinDrag({ button: ev.button, pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY, currentTarget: pin, target: pin }, pin.dataset.annotId);
        return;
      }
      const head = ev.target.closest && ev.target.closest('.tp3d-annot-card__head');
      if (head && !ev.target.closest('button')) {
        const card = head.closest('.tp3d-annot-card');
        beginCardDrag({ button: ev.button, pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY, currentTarget: head, target: head }, card.dataset.annotId);
      }
    });
    layer.addEventListener('click', ev => {
      if (suppressClick || !toolShown || sceneOwnedElsewhere()) return;
      const act = ev.target.closest && ev.target.closest('[data-act]');
      if (act && layer.contains(act)) {
        const id = act.closest('.tp3d-annot-card')?.dataset.annotId;
        if (act.dataset.act === 'edit') openEditor(id);
        else if (act.dataset.act === 'collapse') toggleCollapsed(id);
        return;
      }
      const grip = ev.target.closest && ev.target.closest('.tp3d-annot-handle');
      if (grip && layer.contains(grip)) {
        // A click (or Enter / Space) on an end handle moves that end the click-to-place way: the next click on the scene sets it.
        startReattach(grip.dataset.annotId, grip.dataset.end);
        return;
      }
      const pin = ev.target.closest && ev.target.closest('.tp3d-annot-pin');
      if (pin && layer.contains(pin)) {
        if (pin.dataset.annotId === DRAFT_ID) return;
        endCreation();
        select(pin.dataset.annotId, { toggle: true });
        return;
      }
      const head = ev.target.closest && ev.target.closest('.tp3d-annot-card__head');
      if (head && layer.contains(head)) {
        const id = head.closest('.tp3d-annot-card').dataset.annotId;
        if (id !== selectedId) {
          endCreation();
          select(id);
        }
      }
    });
    layer.addEventListener('pointerover', ev => {
      // Hover feedback belongs to the canvas: entering a marker or card clears it.
      if (hover && ev.target !== layer) hover = null;
    });
    // The wheel keeps zooming the 3D view when the pointer is over a marker or card.
    layer.addEventListener('wheel', ev => {
      if (ev.target === layer || (ev.target.closest && ev.target.closest('.tp3d-annot-editor'))) return;
      const canvas = getCanvas();
      if (!canvas) return;
      ev.preventDefault();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaX: ev.deltaX, deltaY: ev.deltaY, deltaZ: ev.deltaZ, deltaMode: ev.deltaMode,
        clientX: ev.clientX, clientY: ev.clientY, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey,
        bubbles: true, cancelable: true,
      }));
    }, { passive: false });
  }

  // ==========================================================================
  // SECTION: KEYBOARD OWNERSHIP (capture phase)
  // ==========================================================================
  function ownsEscape() {
    return Boolean(stroke || moveDrag || pinDrag || cardDrag || draft || reattachId || arrowTail || tool || selectedId);
  }

  function onKeyDownCapture(ev) {
    if (!bound || !toolShown || !inEditor()) return;
    if (ev.defaultPrevented) return;
    // Measurement Mode owns Escape, Delete and Undo while it is on; a selected callout never reacts to them.
    if (sceneOwnedElsewhere()) return;
    if (panelOpen && ev.key !== 'Escape' && !['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) keyboardModality = true;
    if (UIComponents.modalOwnership && UIComponents.modalOwnership.blocksKeyboardEvent(ev)) return;
    const key = String(ev.key || '').toLowerCase();
    if (key === 'escape') {
      if (!ownsEscape()) return;
      // A text field, dropdown or popover that owns Escape keeps it (the editor card handles its own fields).
      if (isTypingTarget(ev.target)) return;
      if (typeof els.escapeOwnedElsewhere === 'function' && els.escapeOwnedElsewhere()) return;
      closeOneOwner();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (key === 'delete' || key === 'backspace') {
      if (!selectedId || draft || isTypingTarget(ev.target)) return;
      const target = ev.target;
      const owned = target === els.viewport || Boolean(els.layer && els.layer.contains(target)) ||
        Boolean(els.panel && els.panel.contains(target));
      if (!owned) return;
      // The annotation owns this key: cargo is never deleted as a side effect.
      ev.preventDefault();
      ev.stopPropagation();
      removeAnnotation(selectedId, true);
      return;
    }
    // Undo / Redo mid-drag cancels only that drag; cargo history is untouched.
    if (key === 'z' && (ev.metaKey || ev.ctrlKey) && !ev.altKey && (pinDrag || cardDrag || moveDrag) && !isTypingTarget(ev.target)) {
      if (moveDrag) cancelMoveDrag('Move cancelled.');
      else if (pinDrag) cancelPinDrag('Move cancelled.');
      else cancelCardDrag();
      ev.preventDefault();
    }
  }

  /** One Escape press closes exactly one owner. */
  function closeOneOwner() {
    if (stroke) {
      // An unfinished stroke goes before the armed Draw tool does.
      cancelStroke('Drawing cancelled.');
    } else if (moveDrag) {
      cancelMoveDrag('Move cancelled.');
    } else if (pinDrag) {
      cancelPinDrag('Move cancelled.');
    } else if (cardDrag) {
      cancelCardDrag();
    } else if (draft) {
      cancelDraft();
    } else if (reattachId) {
      cancelReattach('Re-attach cancelled.');
    } else if (arrowTail) {
      cancelArrowTail('Arrow cancelled.');
    } else if (tool) {
      const wasSaving = tool === 'arrow' || tool === 'draw';
      tool = null;
      hover = null;
      applyViewGate();
      updateCursor();
      // "Click to start another, or press Esc to finish" ends with the tool it was about.
      if (wasSaving) setStatus('');
      else renderPanel();
    } else if (selectedId) {
      selectedId = null;
      visDirty = true;
      renderPanel();
    }
    refreshOverlay();
    refocusViewportIfLost();
  }

  // ==========================================================================
  // SECTION: PANEL POSITION (drag by the header grip, like the Measurements and AutoPack Results panels)
  // ==========================================================================
  // The positioned ancestor the panel's left/top are measured from.
  function panelHost() {
    return els.panel ? (els.panel.offsetParent || els.panel.parentElement) : null;
  }

  /** The panel's height if nothing limited it: its own chrome plus the whole list, up to the stylesheet's cap. Null while it is not laid out. */
  function panelNaturalHeight() {
    const host = panelHost();
    const parts = panelParts;
    if (!host || !parts || parts.root !== els.panel || !parts.root.offsetHeight) return null;
    return Math.max(1, Math.min(panelContentHeight(parts), PANEL_MAX_HEIGHT_PX, host.clientHeight - PANEL_MAX_HEIGHT_INSET_PX));
  }

  /**
   * The panel's height with nothing scrolling: what it is now plus whatever its list hides, or its body while the arrow
   * look controls make the body the scroller. Measured as it is, so a panel that was limited can grow back.
   */
  function panelContentHeight(parts) {
    const hidden = element => Math.max(0, element.scrollHeight - element.clientHeight);
    return parts.root.offsetHeight + hidden(parts.list) + hidden(parts.body);
  }

  function clampPanelPosition(position, height = els.panel ? els.panel.offsetHeight : 0) {
    const host = panelHost();
    const panel = els.panel;
    if (!host || !panel || !position) return null;
    const maxX = Math.max(PANEL_MARGIN_PX, host.clientWidth - panel.offsetWidth - PANEL_MARGIN_PX);
    const maxY = Math.max(PANEL_MARGIN_PX, host.clientHeight - height - PANEL_MARGIN_PX);
    return {
      x: Math.min(Math.max(Number(position.x) || 0, PANEL_MARGIN_PX), maxX),
      y: Math.min(Math.max(Number(position.y) || 0, PANEL_MARGIN_PX), maxY),
    };
  }

  /**
   * Place the panel at the dragged position (clamped to what fits right now) or at its default spot. The
   * preferred position is kept as dragged, so a panel pushed in by a small window returns toward it.
   */
  function applyPanelPosition() {
    const panel = els.panel;
    if (!panel || panel.hidden) return;
    if (!panelPosition || compact) {
      if (panel.classList.contains('is-dragged')) {
        panel.classList.remove('is-dragged');
        panel.style.left = '';
        panel.style.top = '';
      }
      return;
    }
    // Where it belongs is decided at its natural height, so a panel limited to clear AutoPack Results does not slide
    // down as it shrinks. While the owner drags it, it is clamped as shown.
    const next = clampPanelPosition(panelPosition, panel.classList.contains('is-dragging') ? undefined : (panelNaturalHeight() ?? undefined));
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
    if (!els.panel || els.panel.hidden || typeof els.avoidOther !== 'function' || compact) return;
    const spot = els.avoidOther(els.panel);
    if (spot === 'reset') panelPosition = null;
    else if (spot) panelPosition = clampPanelPosition(spot);
    else return;
    applyPanelPosition();
  }

  function attachPanelDrag(handle) {
    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || !els.panel || compact) return;
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
          // The drag starts from the panel as shown (where it is and how tall it is); avoiding Results settles on release.
          setPanelFit({ limit: els.panel.style.getPropertyValue(PANEL_LIMIT_PROPERTY) });
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

  function gripEl() {
    const grip = htmlEl('span', 'tp3d-annot-grip');
    grip.setAttribute('aria-hidden', 'true');
    for (let dot = 0; dot < 6; dot += 1) grip.appendChild(htmlEl('span', 'tp3d-annot-grip__dot'));
    return grip;
  }

  // ==========================================================================
  // SECTION: PANEL (compact, collapsible; updated in place so a click is never lost)
  // ==========================================================================
  function segmented(label, className) {
    const group = htmlEl('div', `tp3d-annot-seg ${className || ''}`.trim());
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    return group;
  }

  function ensurePanel() {
    if (panelParts && panelParts.root === els.panel && els.panel.contains(panelParts.head)) return panelParts;
    if (!els.panel || !doc) return null;
    const head = htmlEl('div', 'tp3d-annot-panel__head');
    const toggleButton = htmlEl('button', 'tp3d-annot-panel__toggle');
    toggleButton.type = 'button';
    toggleButton.setAttribute('aria-controls', 'editor-annotation-panel-body');
    const title = htmlEl('span', 'tp3d-annot-panel__title', 'Annotations');
    const count = htmlEl('span', 'tp3d-annot-panel__count');
    const chevron = iconEl('fa-solid fa-chevron-up tp3d-annot-panel__chevron');
    toggleButton.append(title, count, chevron);
    toggleButton.addEventListener('click', () => {
      // A drag that began on the title must not also collapse or expand the panel.
      if (suppressToggleClick) return;
      panelCollapsed = !panelCollapsed;
      renderPanel();
    });
    head.append(gripEl(), toggleButton);
    attachPanelDrag(head);

    const body = htmlEl('div', 'tp3d-annot-panel__body');
    body.id = 'editor-annotation-panel-body';

    const toolGroup = segmented('Annotation tool', 'tp3d-annot-seg--tools');
    const toolButtons = TOOL_DEFS.map(def => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn');
      button.type = 'button';
      button.dataset.tool = def.key;
      button.append(iconEl(def.icon), doc.createTextNode(def.label));
      if (def.available) {
        button.addEventListener('click', () => setTool(def.key));
      } else {
        // A tool that is not shipped yet is clearly unavailable, never pretending to work.
        button.disabled = true;
        button.title = `${def.label} is not available yet`;
        button.setAttribute('aria-label', `${def.label} (not available yet)`);
      }
      toolGroup.appendChild(button);
      return { key: def.key, button, available: def.available };
    });

    // Draw / Move View: who owns a primary drag while the Draw tool is armed. Shown only then.
    const drawModeRow = htmlEl('div', 'tp3d-annot-panel__view tp3d-annot-panel__drawmode');
    drawModeRow.hidden = true;
    drawModeRow.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Drag'));
    const drawModeGroup = segmented('Drag action', 'tp3d-annot-seg--small tp3d-annot-seg--drawmode');
    const drawModeButtons = DRAW_VIEWS.map(([key, label]) => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', label);
      button.type = 'button';
      button.dataset.drawView = key;
      button.addEventListener('click', () => setDrawView(key));
      drawModeGroup.appendChild(button);
      return { key, button };
    });
    drawModeRow.appendChild(drawModeGroup);

    const hint = htmlEl('div', 'tp3d-annot-panel__hint');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');

    const show = htmlEl('div', 'tp3d-annot-panel__view');
    show.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Show'));
    const showGroup = segmented('Show annotations', 'tp3d-annot-seg--small tp3d-annot-seg--show');
    const showButtons = SHOW_MODES.map(([key, label]) => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', label);
      button.type = 'button';
      button.addEventListener('click', () => requestShowMode(key));
      showGroup.appendChild(button);
      return { key, button };
    });
    show.append(showGroup);

    const view = htmlEl('div', 'tp3d-annot-panel__view');
    // Visible text stays on one line in the fixed label column; the group keeps the accessible name "Callout display".
    view.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Callouts'));
    const displayGroup = segmented('Callout display', 'tp3d-annot-seg--small tp3d-annot-seg--display');
    const displayButtons = DISPLAY_MODES.map(([key, label]) => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', label);
      button.type = 'button';
      button.addEventListener('click', () => setDisplay(key));
      displayGroup.appendChild(button);
      return { key, button };
    });
    view.appendChild(displayGroup);

    const empty = htmlEl('div', 'tp3d-annot-panel__empty', 'No annotations yet. Choose a tool above to add one. Annotations never change the load.');
    const warning = htmlEl('div', 'tp3d-annot-panel__notice', "Some saved annotations couldn't be read. The original data is kept until you delete it.");
    warning.hidden = true;
    const list = htmlEl('ul', 'tp3d-annot-panel__list');
    body.append(toolGroup, drawModeRow, hint, show, view, warning, empty, list);

    els.panel.replaceChildren(head, body);
    rows.clear();
    panelParts = {
      root: els.panel, head, toggle: toggleButton, chevron, count, body,
      toolButtons, drawModeRow, drawModeButtons, hint, showButtons, displayButtons, empty, warning, list,
      arrowOptions: null, arrowTitle: null, widthButtons: [], arrowColors: null,
      drawOptions: null, drawTitle: null, drawWidthButtons: [], drawStyleButtons: [], drawColors: null,
    };
    return panelParts;
  }

  function iconButton(className, iconClass, label) {
    const button = htmlEl('button', `tp3d-annot-row__btn ${className}`);
    button.type = 'button';
    button.title = label;
    button.appendChild(iconEl(iconClass));
    return button;
  }

  function createRow() {
    const el = htmlEl('li', 'tp3d-annot-row');
    const selectButton = htmlEl('button', 'tp3d-annot-row__select');
    selectButton.type = 'button';
    const badge = htmlEl('span', 'tp3d-annot-row__badge');
    const text = htmlEl('span', 'tp3d-annot-row__text');
    const name = htmlEl('span', 'tp3d-annot-row__name');
    const sub = htmlEl('span', 'tp3d-annot-row__sub');
    text.append(name, sub);
    selectButton.append(badge, text);
    // An arrow or a drawing is renamed in place: this field replaces the name while it is being typed.
    const nameInput = htmlEl('input', 'tp3d-annot-row__rename');
    nameInput.type = 'text';
    nameInput.maxLength = MAX_ANNOTATION_NAME_LENGTH;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.hidden = true;
    const actions = htmlEl('div', 'tp3d-annot-row__actions');
    const eye = iconButton('tp3d-annot-row__eye', 'fa-solid fa-eye', 'Hide');
    const edit = iconButton('tp3d-annot-row__edit', 'fa-solid fa-pen', 'Edit');
    const remove = iconButton('tp3d-annot-row__delete', 'fa-solid fa-trash-can', 'Delete');
    actions.append(eye, edit, remove);
    const issue = htmlEl('div', 'tp3d-annot-row__issue');
    issue.hidden = true;
    const issueText = htmlEl('div');
    const reattach = htmlEl('button', 'tp3d-annot-btn tp3d-annot-btn--small', 'Re-attach');
    reattach.type = 'button';
    issue.append(issueText, reattach);
    // An arrow reports each of its two ends that cannot be placed, each with its own Re-attach.
    const ends = {};
    ['start', 'end'].forEach(which => {
      const line = htmlEl('div', 'tp3d-annot-row__end');
      line.hidden = true;
      const reason = htmlEl('div');
      const button = htmlEl('button', 'tp3d-annot-btn tp3d-annot-btn--small', `Re-attach ${ARROW_END_NAMES[which]}`);
      button.type = 'button';
      button.dataset.end = which;
      line.append(reason, button);
      issue.appendChild(line);
      ends[which] = { line, text: reason, button };
    });
    el.append(selectButton, nameInput, actions, issue);
    const row = { el, select: selectButton, badge, name, sub, nameInput, eye, edit, remove, issue, issueText, reattach, ends, id: null, eyeIcon: eye.firstChild, renaming: false };
    // Picking a row from the list ends a pending Arrow tail (an unfinished creation) and leaves the armed tool as it is.
    selectButton.addEventListener('click', () => {
      endCreation();
      select(row.id, { toggle: true });
    });
    eye.addEventListener('click', () => toggleHidden(row.id));
    // The same control edits a callout in the full editor and renames an arrow or a drawing in its row.
    edit.addEventListener('click', () => (isCallout(recordById(row.id)) ? openEditor(row.id) : startRename(row.id)));
    // Typing never reaches the scene or the other shortcuts: Enter commits, Escape cancels, leaving the field commits.
    nameInput.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finishRename(row.id, nameInput.value, true, { refocus: true });
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finishRename(row.id, '', false, { refocus: true });
      }
    });
    nameInput.addEventListener('blur', () => finishRename(row.id, nameInput.value, true));
    // A click event with detail 0 is a keyboard activation (Enter / Space).
    remove.addEventListener('click', ev => removeAnnotation(row.id, ev.detail === 0));
    reattach.addEventListener('click', () => startReattach(row.id));
    ends.start.button.addEventListener('click', () => startReattach(row.id, 'start'));
    ends.end.button.addEventListener('click', () => startReattach(row.id, 'end'));
    return row;
  }

  function updateRow(row, record, result, blocked, viewOff) {
    row.id = record.id;
    row.el.dataset.annotId = record.id;
    const callout = isCallout(record);
    const arrow = isArrow(record);
    const draw = isDraw(record);
    const supported = callout || arrow || draw;
    const status = supported && result ? result.status : ANNOTATION_STATUS.UNRESOLVED;
    const valid = status === ANNOTATION_STATUS.VALID;
    const title = callout ? record.title : (arrow ? arrowName(record.id) : (draw ? drawName(record.id) : 'Unreadable annotation'));
    setText(row.name, title);
    let sub;
    if (!supported) sub = 'Data could not be read';
    else if (!valid) sub = annotationStatusLabel(status);
    else if (arrow) sub = `${anchorTargetName(record.start)} → ${anchorTargetName(record.end)}${record.hidden ? ' · Hidden' : ''}`;
    else sub = `${anchorTargetName(record.anchor)}${record.hidden ? ' · Hidden' : ''}`;
    setText(row.sub, sub);
    row.sub.dataset.status = supported ? status : 'unreadable';
    const selected = record.id === selectedId;
    toggleClass(row.el, 'is-selected', selected);
    toggleClass(row.el, 'is-hidden', supported && record.hidden === true);
    row.el.dataset.status = supported ? status : 'unreadable';
    row.el.dataset.type = supported ? record.type : 'unreadable';
    // Badge: a number (callout) or an arrow glyph (arrow), colored when Valid; a dashed ring when it needs attention,
    // a warning icon when unreadable.
    const number = numbers.get(record.id);
    if (callout) {
      setText(row.badge, number ? String(number) : '');
      applyColor(row.badge, record.color);
      toggleClass(row.badge, 'is-flagged', !valid);
    } else if (arrow) {
      applyColor(row.badge, record.color);
      toggleClass(row.badge, 'is-flagged', !valid);
      if (!row.badge.firstChild || row.badge.firstChild.nodeType !== 1) row.badge.replaceChildren(iconEl('fa-solid fa-arrow-right'));
    } else if (draw) {
      applyColor(row.badge, record.color);
      toggleClass(row.badge, 'is-flagged', !valid);
      if (!row.badge.firstChild || row.badge.firstChild.nodeType !== 1) row.badge.replaceChildren(iconEl('fa-solid fa-pen'));
    } else {
      applyColor(row.badge, '');
      toggleClass(row.badge, 'is-flagged', true);
      if (!row.badge.firstChild || row.badge.firstChild.nodeType !== 1) row.badge.replaceChildren(iconEl('fa-solid fa-triangle-exclamation'));
    }
    row.select.disabled = !supported || viewOff;
    setAttr(row.select, 'aria-pressed', selected ? 'true' : 'false');
    setAttr(row.select, 'aria-label', `${callout ? `Callout ${number}: ` : ''}${title}, ${sub}${selected ? ', selected' : ''}`);
    row.select.title = callout ? 'Select to show its card' : (arrow ? 'Select to edit its ends, color and width' : (draw ? 'Select to edit its color and width' : ''));

    setHidden(row.eye, !supported);
    setHidden(row.edit, !supported);
    row.eye.disabled = blocked;
    row.edit.disabled = blocked || viewOff;
    row.remove.disabled = blocked;
    if (supported) {
      const hiddenNow = record.hidden === true;
      const eyeClass = `fa-solid ${hiddenNow ? 'fa-eye-slash' : 'fa-eye'}`;
      if (row.eyeIcon.className !== eyeClass) row.eyeIcon.className = eyeClass;
      setAttr(row.eye, 'aria-label', `${hiddenNow ? 'Show' : 'Hide'} ${title}`);
      row.eye.title = hiddenNow ? 'Show' : 'Hide';
    }
    const editVerb = callout ? 'Edit' : 'Rename';
    row.edit.title = editVerb;
    setAttr(row.edit, 'aria-label', `${editVerb} ${title}`);
    setAttr(row.remove, 'aria-label', `Delete ${title}`);

    // An arrow or a drawing being renamed shows its name field. The field is filled and focused once, when the rename starts.
    const renaming = (arrow || draw) && renamingId === record.id;
    const starting = renaming && !row.renaming;
    row.renaming = renaming;
    setHidden(row.nameInput, !renaming);
    if (starting) {
      const generated = arrow ? `Arrow ${arrowNumbers.get(record.id) || ''}`.trim() : `Drawing ${drawNumbers.get(record.id) || ''}`.trim();
      row.nameInput.value = record.name || '';
      row.nameInput.placeholder = generated;
      row.nameInput.setAttribute('aria-label', `Name for ${generated}. Leave blank to use that name.`);
      row.nameInput.focus();
      row.nameInput.select();
    }

    // A callout reports one reason and one Re-attach; an arrow reports each end that cannot be placed on its own.
    const issueReason = result ? result.reason : 'unreadable';
    let issue = '';
    if (!supported) issue = describeAnnotationReason('unreadable');
    else if (!arrow && !valid) issue = draw ? drawReason(issueReason) : describeAnnotationReason(issueReason);
    setText(row.issueText, issue);
    setHidden(row.issueText, !issue);
    setHidden(row.reattach, !callout || valid);
    row.reattach.disabled = blocked || viewOff;
    let endIssues = 0;
    ['start', 'end'].forEach(which => {
      const part = row.ends[which];
      const broken = arrow && !valid && (!result || result[`${which}Status`] !== ANNOTATION_STATUS.VALID);
      if (broken) endIssues += 1;
      setHidden(part.line, !broken);
      if (broken) {
        const reason = result ? result[`${which}Reason`] : null;
        const name = ARROW_END_NAMES[which];
        setText(part.text, `${name[0].toUpperCase()}${name.slice(1)}: ${arrowEndReason(reason)}`);
        part.button.disabled = blocked || viewOff;
      }
    });
    setHidden(row.issue, !issue && !endIssues);
  }

  /** Context-sensitive guidance: empty unless something is relevant right now. */
  function guidanceText(blockedNow) {
    if (blockedNow) return blockedMessage(blockedNow);
    if (moveDrag && moveDrag.moved) return (moveDrag.subject === 'arrow' ? ARROW_MOVE_TEXT : DRAW_MOVE_TEXT)[moveDrag.kind];
    if (statusMessage) return statusMessage;
    if (showMode === 'off') return SHOW_OFF_HINT;
    if (pinDrag && pinDrag.moved) return pinDrag.which ? 'Drag the handle onto a surface. Esc cancels.' : 'Drag the marker onto a surface. Esc cancels.';
    if (reattachId) {
      return reattachWhich
        ? `Click cargo, the truck or the ground to set the arrow ${ARROW_END_NAMES[reattachWhich]}. Esc cancels.`
        : 'Click cargo, the truck or the ground to re-attach this callout. Esc cancels.';
    }
    if (draft) {
      return draft.editId
        ? 'Editing callout. Drag its marker or card to move them. Esc cancels.'
        : 'Add a title, then save. Click the scene or drag the marker to move it. Esc cancels.';
    }
    if (stroke) return stroke.phase === 'frozen' ? (DRAW_FROZEN_TEXT[stroke.frozen] || DRAW_FROZEN_TEXT.blocked) : DRAW_HINT_STROKING;
    if (tool === 'draw') return drawView === 'move' ? DRAW_HINT_MOVE : DRAW_HINT;
    if (tool === 'callout') return 'Click cargo, the truck or the ground to place a callout.';
    if (tool === 'arrow') return arrowTail ? ARROW_HINT_HEAD : ARROW_HINT_TAIL;
    if (records.length >= MAX_ANNOTATIONS_PER_PACK) return `Limit of ${MAX_ANNOTATIONS_PER_PACK} annotations reached. Delete one to add another.`;
    if (!records.length) return 'Choose Callout, Arrow or Draw, then click or drag on cargo, the truck or the ground.';
    return '';
  }

  /** Colour of the dot beside the guidance: orange while a gesture is under way or something needs attention, green after a save. */
  function guidanceTone(blockedNow) {
    if (blockedNow || (moveDrag && moveDrag.moved)) return 'active';
    if (showMode === 'off' && !statusMessage) return 'active';
    if (statusMessage) return statusTone || (tool || draft || reattachId ? 'active' : '');
    if (tool || draft || reattachId || stroke || (pinDrag && pinDrag.moved) || records.length >= MAX_ANNOTATIONS_PER_PACK) return 'active';
    return '';
  }

  function renderPanel() {
    if (!panelOpen || !doc) return;
    const parts = ensurePanel();
    if (!parts) return;
    const blockedNow = blockedReason();

    const countText = records.length ? String(records.length) : '';
    setText(parts.count, countText);
    parts.toggle.setAttribute('aria-expanded', panelCollapsed ? 'false' : 'true');
    const chevronClass = `fa-solid fa-chevron-${panelCollapsed ? 'down' : 'up'} tp3d-annot-panel__chevron`;
    if (parts.chevron.className !== chevronClass) parts.chevron.className = chevronClass;
    toggleClass(parts.root, 'is-collapsed', panelCollapsed);
    toggleClass(parts.root, 'is-compact', compact);
    toggleClass(parts.root, 'is-covered', compact && Boolean(draft));
    toggleClass(parts.root, 'is-behind-editor', panelBehindEditor && !compact && Boolean(draft));
    setHidden(parts.body, panelCollapsed);

    parts.toolButtons.forEach(({ key, button, available }) => {
      if (!available) return;
      setAttr(button, 'aria-pressed', tool === key ? 'true' : 'false');
      button.disabled = (Boolean(blockedNow) && tool !== key) || showMode === 'off';
    });
    setHidden(parts.drawModeRow, tool !== 'draw' || showMode === 'off');
    parts.drawModeButtons.forEach(({ key, button }) => {
      setAttr(button, 'aria-pressed', drawView === key ? 'true' : 'false');
      button.disabled = Boolean(blockedNow);
    });
    parts.showButtons.forEach(({ key, button }) => setAttr(button, 'aria-pressed', showMode === key ? 'true' : 'false'));
    parts.displayButtons.forEach(({ key, button }) => setAttr(button, 'aria-pressed', display === key ? 'true' : 'false'));

    const hintText = guidanceText(blockedNow);
    setText(parts.hint, hintText);
    const hintTone = guidanceTone(blockedNow);
    if ((parts.hint.dataset.tone || '') !== hintTone) {
      if (hintTone) parts.hint.dataset.tone = hintTone;
      else delete parts.hint.dataset.tone;
    }
    setHidden(parts.empty, records.length > 0);
    setHidden(parts.warning, !records.some(record => record.type === ANNOTATION_TYPE_UNREADABLE));
    renderLookOptions(parts, blockedNow);

    const seen = new Set();
    records.forEach((record, index) => {
      let row = rows.get(record.id);
      if (!row) {
        row = createRow();
        rows.set(record.id, row);
      }
      updateRow(row, record, results[index], Boolean(blockedNow), showMode === 'off' || Boolean(blockedNow));
      if (parts.list.children[index] !== row.el) parts.list.insertBefore(row.el, parts.list.children[index] || null);
      seen.add(record.id);
    });
    rows.forEach((row, id) => {
      if (seen.has(id)) return;
      row.el.remove();
      rows.delete(id);
    });
    // A record picked from the scene gets its row shown once, when the selection changes. Otherwise the list stays where the user scrolled it.
    if (selectedId !== revealedId) {
      revealedId = selectedId;
      if (selectedId) revealRow(rows.get(selectedId));
    }
    applyPanelPosition(); // rows or collapsing change the panel size: keep it inside the viewport
    syncPanelFlow();
  }

  /**
   * Whether the panel body scrolls as a whole under its header (the tool, Show and Callouts rows, the list and the arrow look
   * controls together) instead of keeping those rows and controls fixed around a scrolling list. A panel limited in height
   * (a small window, the Results card below it, the narrow sheet) must never lose its rows to pinned controls. Decided from
   * the measured heights, never from a window size, so it follows whatever limits the panel; the class changes only how the
   * panel's own content scrolls, never the panel's box, so it cannot feed back into the height it is decided from.
   */
  function syncPanelFlow() {
    const parts = panelParts;
    if (!parts || parts.root !== els.panel || els.panel.hidden || !parts.root.offsetHeight) return;
    const footer = [parts.arrowOptions, parts.drawOptions].find(options => options && !options.hidden);
    const footerHeight = footer ? footer.offsetHeight : 0;
    toggleClass(parts.body, 'is-flow', panelBodyFlows({
      panelHeight: parts.root.offsetHeight,
      contentHeight: panelContentHeight(parts),
      headHeight: parts.head.offsetHeight,
      footerHeight,
    }));
  }

  /**
   * The look of arrows (width and color), built the first time it is needed. It edits the selected arrow, or what the
   * next one will look like, and sits below the list so showing it never moves a row under the pointer.
   */
  function buildArrowOptions(parts) {
    const options = htmlEl('div', 'tp3d-annot-panel__arrow');
    const title = htmlEl('div', 'tp3d-annot-panel__arrow-title');
    const widthRow = htmlEl('div', 'tp3d-annot-panel__view');
    widthRow.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Weight'));
    const widthGroup = segmented('Arrow weight', 'tp3d-annot-seg--small tp3d-annot-seg--width');
    const widthButtons = ARROW_WIDTHS.map(key => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', ARROW_WIDTH_LABELS[key]);
      button.type = 'button';
      button.dataset.width = key;
      button.addEventListener('click', () => setArrowStyle({ width: key }));
      widthGroup.appendChild(button);
      return { key, button };
    });
    widthRow.appendChild(widthGroup);
    const styleRow = htmlEl('div', 'tp3d-annot-panel__view');
    styleRow.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Style'));
    const styleGroup = segmented('Arrow line style', 'tp3d-annot-seg--small tp3d-annot-seg--line');
    const styleButtons = LINE_STYLES.map(key => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', LINE_STYLE_LABELS[key]);
      button.type = 'button';
      button.dataset.lineStyle = key;
      button.addEventListener('click', () => setArrowStyle({ style: key }));
      styleGroup.appendChild(button);
      return { key, button };
    });
    styleRow.appendChild(styleGroup);
    const colors = buildColorPicker({
      ariaLabel: 'Arrow color',
      getColor: () => { const selectedArrow = recordById(selectedId); return isArrow(selectedArrow) ? selectedArrow.color : arrowStyle.color; },
      onPick: color => setArrowStyle({ color }),
      onPreview: color => setColorPreview(color),
    });
    colors.root.classList.add('tp3d-annot-panel__arrow-colors');
    options.append(title, widthRow, styleRow, colors.root);
    parts.body.appendChild(options);
    parts.arrowOptions = options;
    parts.arrowTitle = title;
    parts.widthButtons = widthButtons;
    parts.styleButtons = styleButtons;
    parts.arrowColors = colors;
  }

  /** The look controls of whichever styled annotation is in play: arrows or drawings (never both at once). */
  function renderLookOptions(parts, blockedNow) {
    const arrowShown = renderArrowOptions(parts, blockedNow);
    const drawShown = renderDrawOptions(parts, blockedNow);
    toggleClass(parts.body, 'has-arrow-options', arrowShown || drawShown);
  }

  /**
   * The drawing look controls (width and color), built the first time they are needed. They edit the selected drawing, or what
   * the next one will look like, and sit below the list like the arrow controls. Their classes are their own so nothing that
   * addresses the arrow controls can reach them.
   */
  function buildDrawOptions(parts) {
    const options = htmlEl('div', 'tp3d-annot-panel__draw');
    const title = htmlEl('div', 'tp3d-annot-panel__draw-title');
    const widthRow = htmlEl('div', 'tp3d-annot-panel__view');
    widthRow.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Weight'));
    const widthGroup = segmented('Drawing weight', 'tp3d-annot-seg--small tp3d-annot-seg--draw-width');
    const widthButtons = DRAW_WIDTHS.map(key => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', ARROW_WIDTH_LABELS[key]);
      button.type = 'button';
      button.dataset.drawWidth = key;
      button.addEventListener('click', () => setDrawStyle({ width: key }));
      widthGroup.appendChild(button);
      return { key, button };
    });
    widthRow.appendChild(widthGroup);
    const styleRow = htmlEl('div', 'tp3d-annot-panel__view');
    styleRow.appendChild(htmlEl('span', 'tp3d-annot-panel__view-label', 'Style'));
    const styleGroup = segmented('Drawing line style', 'tp3d-annot-seg--small tp3d-annot-seg--draw-line');
    const styleButtons = LINE_STYLES.map(key => {
      const button = htmlEl('button', 'tp3d-annot-seg__btn', LINE_STYLE_LABELS[key]);
      button.type = 'button';
      button.dataset.drawLineStyle = key;
      button.addEventListener('click', () => setDrawStyle({ style: key }));
      styleGroup.appendChild(button);
      return { key, button };
    });
    styleRow.appendChild(styleGroup);
    const colors = buildColorPicker({
      ariaLabel: 'Drawing color',
      getColor: () => { const selectedDraw = recordById(selectedId); return isDraw(selectedDraw) ? selectedDraw.color : drawStyle.color; },
      onPick: color => setDrawStyle({ color }),
      onPreview: color => setColorPreview(color),
    });
    colors.root.classList.add('tp3d-annot-panel__draw-colors');
    options.append(title, widthRow, styleRow, colors.root);
    parts.body.appendChild(options);
    parts.drawOptions = options;
    parts.drawTitle = title;
    parts.drawWidthButtons = widthButtons;
    parts.drawStyleButtons = styleButtons;
    parts.drawColors = colors;
  }

  /** The drawing look controls: shown while the Draw tool is armed or a drawing is selected, for that drawing or for the next one. */
  function renderDrawOptions(parts, blockedNow) {
    const selectedDraw = recordById(selectedId);
    const editing = isDraw(selectedDraw) ? selectedDraw : null;
    const visible = (Boolean(editing) || tool === 'draw') && showMode !== 'off';
    if (!visible) {
      if (parts.drawOptions) setHidden(parts.drawOptions, true);
      return false;
    }
    if (!parts.drawOptions) buildDrawOptions(parts);
    setHidden(parts.drawOptions, false);
    const color = editing ? editing.color : drawStyle.color;
    const width = editing ? editing.width : drawStyle.width;
    const lineStyle = editing ? lineStyleOf(editing) : drawStyle.style;
    setText(parts.drawTitle, editing ? `Drawing: ${drawName(editing.id)} — Selected` : 'New Drawing — Defaults');
    parts.drawColors.sync(color);
    parts.drawWidthButtons.forEach(({ key, button }) => {
      setAttr(button, 'aria-pressed', width === key ? 'true' : 'false');
      button.disabled = Boolean(blockedNow);
    });
    parts.drawStyleButtons.forEach(({ key, button }) => {
      setAttr(button, 'aria-pressed', lineStyle === key ? 'true' : 'false');
      button.disabled = Boolean(blockedNow);
    });
    return true;
  }

  /** The arrow look controls: shown while the Arrow tool is armed or an arrow is selected, for that arrow or for the next one. */
  function renderArrowOptions(parts, blockedNow) {
    const selectedArrow = recordById(selectedId);
    const editing = isArrow(selectedArrow) ? selectedArrow : null;
    const visible = (Boolean(editing) || tool === 'arrow') && showMode !== 'off';
    if (!visible) {
      if (parts.arrowOptions) setHidden(parts.arrowOptions, true);
      return false;
    }
    if (!parts.arrowOptions) buildArrowOptions(parts);
    setHidden(parts.arrowOptions, false);
    const color = editing ? editing.color : arrowStyle.color;
    const width = editing ? editing.width : arrowStyle.width;
    const lineStyle = editing ? lineStyleOf(editing) : arrowStyle.style;
    setText(parts.arrowTitle, editing ? `Arrow: ${arrowName(editing.id)} — Selected` : 'New Arrow — Defaults');
    parts.arrowColors.sync(color);
    parts.widthButtons.forEach(({ key, button }) => {
      setAttr(button, 'aria-pressed', width === key ? 'true' : 'false');
      button.disabled = Boolean(blockedNow);
    });
    parts.styleButtons.forEach(({ key, button }) => {
      setAttr(button, 'aria-pressed', lineStyle === key ? 'true' : 'false');
      button.disabled = Boolean(blockedNow);
    });
    return true;
  }

  /** React to a change in what (if anything) makes annotations read-only. A blocking operation cancels unfinished edits. */
  function syncBlocked() {
    const reason = blockedReason();
    if (reason === lastBlockedReason) return reason;
    lastBlockedReason = reason;
    if (reason) {
      cancelStroke(blockedMessage(reason));
      cancelMoveDrag(blockedMessage(reason));
      if (pinDrag) cancelPinDrag(blockedMessage(reason));
      if (cardDrag) cancelCardDrag();
      if (reattachId) cancelReattach(blockedMessage(reason));
      if (arrowTail) cancelArrowTail(blockedMessage(reason));
      if (draft && !draft.editId) cancelDraft(blockedMessage(reason));
      else if (draft) cancelDraft(blockedMessage(reason));
      if (tool) {
        tool = null;
        hover = null;
        updateCursor();
      }
      selectedId = null; // hidden graphics leave nothing selected
      visDirty = true;
    }
    applyViewGate();
    renderPanel();
    refreshOverlay();
    return reason;
  }

  /**
   * Keep the overlay a pure view while another scene tool owns gestures: the layer goes inert (no pointer
   * input, no focus) and anything this tool had under way ends without writing. The Editor already closes the
   * panel when Measurement starts; this covers every other way the mode can begin.
   */
  function syncInputOwnership() {
    const owned = sceneOwnedElsewhere();
    if (els.layer) {
      toggleClass(els.layer, 'is-view-only', owned);
      const inert = owned;
      if ('inert' in els.layer && els.layer.inert !== inert) els.layer.inert = inert;
    }
    if (owned === lastOwnedElsewhere) return;
    lastOwnedElsewhere = owned;
    if (!owned) return;
    cancelStroke();
    cancelMoveDrag();
    cancelPinDrag();
    cancelCardDrag();
    if (draft) cancelDraft();
    arrowTail = null;
    reattachId = null;
    reattachWhich = null;
    tool = null;
    hover = null;
    press = null;
    applyViewGate();
    renderPanel();
  }

  // ==========================================================================
  // SECTION: FRAME LOOP (runs while there is anything to draw or edit)
  // ==========================================================================
  /** True while a scene tool (the armed Callout tool or a re-attach) owns primary pointer input on the canvas. */
  function isActive() {
    return toolShown && Boolean(tool || reattachId);
  }

  function wantsLoop() {
    return bound && toolShown && inEditor() && Boolean(currentPack()) &&
      (panelOpen || draft || tool || reattachId || pinDrag || cardDrag || stroke || moveDrag || drawableIds.size > 0);
  }

  function ensureLoop() {
    if (rafId === null && wantsLoop()) rafId = window.requestAnimationFrame(loop);
  }

  /**
   * Draw the overlay now instead of waiting for the next frame, so a state change (a save, a selection, a
   * deletion) is visible at once even when frames are slow. Never starts the loop by itself.
   */
  function refreshOverlay() {
    if (!wantsLoop() || !SceneManager.getCamera()) return;
    render(window.performance.now());
  }

  function loop(now) {
    rafId = null;
    if (!wantsLoop()) {
      disposeOverlay();
      return;
    }
    frame(now);
    rafId = window.requestAnimationFrame(loop);
  }

  function updateCursor() {
    const canvas = getCanvas();
    if (!canvas || sceneOwnedElsewhere()) return; // the tool that owns the scene owns the cursor
    let cursor = 'default';
    if (isActive()) {
      if (pinDrag && pinDrag.moved) cursor = 'grabbing';
      else if (tool === 'draw') cursor = drawView === 'draw' ? 'crosshair' : 'default';
      else cursor = hover ? 'crosshair' : 'default';
    }
    if (moveDrag && moveDrag.moved) cursor = 'grabbing';
    if (cursor === lastCursor) return;
    lastCursor = cursor;
    canvas.style.cursor = cursor;
  }

  function frame(now) {
    const reason = syncBlocked();
    applyViewGate();
    advanceStroke();
    advanceMove();
    if (pinDrag && pinDrag.moved) {
      if (pinDrag.dirty && lastClient) {
        pinDrag.dirty = false;
        pinDrag.candidate = reason ? null : pick(lastClient.x, lastClient.y);
      }
    } else if (isActive() && !stroke && hoverDirty && lastClient && now - lastHoverPickAt >= HOVER_PICK_INTERVAL_MS) {
      hoverDirty = false;
      lastHoverPickAt = now;
      if (reason || (tool === 'draw' && drawView !== 'draw')) hover = null;
      else hover = tool === 'draw' ? picker.pickDraw(lastClient.x, lastClient.y) : pick(lastClient.x, lastClient.y);
    } else if ((!isActive() || stroke) && hover) {
      hover = null;
    }
    render(now);
    updateCursor();
  }

  // ==========================================================================
  // SECTION: OVERLAY (projection, facing/occlusion, layout, DOM)
  // ==========================================================================
  function ensureLayerParts() {
    if (layerParts && layerParts.svg.isConnected) return layerParts;
    if (!els.layer || !doc) return null;
    const svg = svgEl('svg', 'tp3d-annot-svg');
    svg.setAttribute('aria-hidden', 'true');
    const hoverUnder = svgEl('path', 'tp3d-annot-svg__under');
    const hoverMark = svgEl('path', 'tp3d-annot-svg__mark');
    const ghost = svgEl('circle', 'tp3d-annot-svg__ghost');
    ghost.setAttribute('r', '9');
    ghost.style.display = 'none';
    const draftLeaderUnder = svgEl('path', 'tp3d-annot-svg__under');
    const draftLeader = svgEl('path', 'tp3d-annot-svg__leader is-selected');
    // Arrows sit under everything else the SVG draws (leaders, hover mark, ghost); pins and cards are HTML above it all.
    const arrowGroup = svgEl('g', 'tp3d-annot-arrows');
    // Drawings sit under the arrows, and the stroke being drawn is above the saved ones.
    const drawGroup = svgEl('g', 'tp3d-annot-draws');
    const drawPreview = makeDrawGraphic('is-preview');
    const preview = makeArrowGraphic('is-preview');
    const previewTailUnder = svgEl('circle', 'tp3d-annot-arrow__tail-under');
    const previewTail = svgEl('circle', 'tp3d-annot-arrow__tail');
    previewTailUnder.setAttribute('r', '8');
    previewTail.setAttribute('r', '5');
    previewTailUnder.style.display = 'none';
    previewTail.style.display = 'none';
    preview.group.append(previewTailUnder, previewTail);
    svg.append(drawGroup, drawPreview.group, arrowGroup, preview.group, ghost, hoverUnder, hoverMark, draftLeaderUnder, draftLeader);
    els.layer.prepend(svg);
    const tip = htmlEl('div', 'tp3d-annot-tip');
    tip.hidden = true;
    const overflow = htmlEl('div', 'tp3d-annot-overflow');
    overflow.hidden = true;
    overflow.setAttribute('role', 'status');
    overflow.append(iconEl('fa-solid fa-circle-info'), htmlEl('span'));
    const draftPin = makePin(DRAFT_ID);
    draftPin.pin.classList.add('is-draft');
    draftPin.badge.textContent = '+';
    draftPin.pin.setAttribute('aria-label', 'New callout marker. Drag to move it.');
    draftPin.pin.title = 'Drag to move the marker';
    draftPin.pin.hidden = true;
    els.layer.append(tip, overflow);
    layerParts = {
      svg, hoverUnder, hoverMark, ghost, tip, overflow, overflowText: overflow.querySelector('span'),
      draftLeaderUnder, draftLeader, draftPin, leaders: new Map(), keys: { hover: '', ghost: '', draftLeader: '' },
      arrowGroup, preview, previewTail, previewTailUnder, drawGroup, drawPreview,
    };
    return layerParts;
  }

  // ==========================================================================
  // SECTION: DRAWINGS (one SVG path per stroke in the overlay; never a Three.js object, never a texture)
  // ==========================================================================
  /** The two paths of one stroke: a neutral halo under the colored line. A stroke is one path however many vertices it has. */
  function makeDrawGraphic(extraClass = '') {
    const group = svgEl('g', `tp3d-annot-draw ${extraClass}`.trim());
    const under = svgEl('path', 'tp3d-annot-draw__under');
    const line = svgEl('path', 'tp3d-annot-draw__line');
    group.append(under, line);
    return { group, under, line, colorKey: null, widthKey: '', patternKey: '' };
  }

  /**
   * Show `d` (or nothing, for an empty string) on a stroke graphic. The line width is constant on screen, so it never scales
   * with zoom. Only what changed is written: a new color or selection touches classes and one custom property, never the path.
   */
  function paintDraw(graphic, d, { color, width = DEFAULT_DRAW_WIDTH, style = DEFAULT_LINE_STYLE, selected = false, occluded = false, frozen = false, moving = false, invalid = false, span = Infinity }) {
    if (graphic.colorKey !== color) {
      graphic.colorKey = color;
      applyColor(graphic.group, color);
    }
    toggleClass(graphic.group, 'is-selected', selected);
    toggleClass(graphic.group, 'is-occluded', occluded);
    toggleClass(graphic.group, 'is-frozen', frozen);
    toggleClass(graphic.group, 'is-moving', moving);
    toggleClass(graphic.group, 'is-move-invalid', moving && invalid);
    setPath(graphic.under, d);
    setPath(graphic.line, d);
    if (!d) return;
    setAttr(graphic.group, 'data-line-style', style);
    const px = ARROW_SHAFT_PX[width] || ARROW_SHAFT_PX.regular;
    // The edge under the line: the accent edge while selected (a hidden stroke keeps its neutral one, so it never looks unobstructed),
    // otherwise the neutral one. Both follow the stroke's size on screen, in steps so a zoom does not rewrite styles every frame.
    const fit = drawFit(span);
    const edge = selected && !occluded
      ? DRAW_EDGE_PX.selected + px * DRAW_SELECTED_EDGE_PER_PX
      : (style === 'dotted' ? DRAW_EDGE_PX.dotted : DRAW_EDGE_PX.neutral);
    const halo = Math.max(DRAW_EDGE_FLOOR_PX, Math.round(edge * fit * 4) / 4);
    const key = `${px}|${halo}|${style}|${fit}`;
    if (graphic.widthKey === key) return;
    graphic.widthKey = key;
    setStyleProp(graphic.line, 'strokeWidth', `${px}px`);
    setStyleProp(graphic.under, 'strokeWidth', `${px + halo}px`);
    paintDrawPattern(graphic, style, px, fit);
  }

  /** 1 for a stroke that spans DRAW_FIT_SPAN_PX on screen or more, down to DRAW_FIT_MIN for a small one, in steps of a tenth. */
  function drawFit(span) {
    if (!(span < DRAW_FIT_SPAN_PX)) return 1;
    const fit = DRAW_FIT_MIN + (1 - DRAW_FIT_MIN) * Math.max(0, span) / DRAW_FIT_SPAN_PX;
    return Math.round(fit * 10) / 10;
  }

  /**
   * A drawing's Dashed or Dotted pattern on its line and its edge. Dashes and dot spacing grow with the weight and follow `fit` (never
   * below a clear gap), so a small stroke keeps its rhythm instead of showing three huge marks. A dot is a zero-length dash with round
   * caps, so its diameter is the line's own weight; Solid sets nothing, which leaves the stylesheet in charge.
   */
  function paintDrawPattern(graphic, style, px, fit) {
    const key = `${style}|${px}|${fit}`;
    if (graphic.patternKey === key) return;
    graphic.patternKey = key;
    let dash = '';
    let cap = '';
    if (style === 'dashed') {
      dash = `${Math.max(px * 4 * fit, px * 2)} ${Math.max(px * 2.5 * fit, 4)}`;
      cap = 'butt';
    } else if (style === 'dotted') {
      dash = `0.01 ${Math.max(Math.max(px * 2.6, px + 7) * fit, px + 3.5)}`;
      cap = 'round';
    }
    [graphic.line, graphic.under].forEach(path => {
      setStyleProp(path, 'strokeDasharray', dash);
      setStyleProp(path, 'strokeLinecap', cap);
    });
  }

  function getDrawView(id) {
    let view = drawViews.get(id);
    if (!view) {
      const graphic = makeDrawGraphic();
      graphic.group.dataset.annotId = id;
      layerParts.drawGroup.appendChild(graphic.group);
      view = {
        id, graphic, record: null, local: null, world: null, stamp: NaN, poseStamp: 0, d: '', visible: [], samples: [],
        front: false, measured: false, measuredAt: -1, shown: false, moved: null, dragKey: 0, extent: newDrawExtent(),
      };
      drawViews.set(id, view);
      visDirty = true;
    }
    return view;
  }

  function hideDrawView(view) {
    paintDraw(view.graphic, '', { color: view.graphic.colorKey });
    view.shown = false;
  }

  function removeDrawView(id) {
    const view = drawViews.get(id);
    if (!view) return;
    view.graphic.group.remove();
    drawViews.delete(id);
    drawBacklog.delete(id);
  }

  const sameNumbers = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

  /** Every vertex of a stroke in the frame it is stored in, as scene units: the cargo's own frame for cargo, the world's for the rest. Null if any cannot be built. */
  function drawLocalPoints(record) {
    const first = drawAnchorUV(record.anchor, record.face);
    if (!first || !Array.isArray(record.points)) return null;
    const scale = picker.toWorldScale();
    const count = 1 + record.points.length / 2;
    const out = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const lifted = drawLift(record.anchor, record.face, i === 0 ? first.u : record.points[2 * (i - 1)], i === 0 ? first.v : record.points[2 * (i - 1) + 1]);
      if (!lifted) return null;
      out[3 * i] = lifted.x * scale;
      out[3 * i + 1] = lifted.y * scale;
      out[3 * i + 2] = lifted.z * scale;
    }
    return out.every(Number.isFinite) ? out : null;
  }

  /**
   * What a stroke's projection leaves for later reading: how large it is on screen (`span`, which sizes its edge and pattern) and the points
   * of the drawn path in layer pixels (`xy`, with its padded bounds), which is all a press needs to find the line. One per stroke view, rewritten
   * by each projection and grown, never reallocated, so reading it costs nothing per event.
   */
  function newDrawExtent() {
    return { span: Infinity, count: 0, xy: new Float32Array(64), left: 0, top: 0, right: 0, bottom: 0 };
  }

  function resetTrace(shape) {
    shape.span = 0;
    shape.count = 0;
    shape.left = Infinity;
    shape.top = Infinity;
    shape.right = -Infinity;
    shape.bottom = -Infinity;
  }

  /** Append a traced point (a NaN pair ends a sub-path and has no bounds). */
  function pushTrace(shape, x, y) {
    if (shape.count + 2 > shape.xy.length) {
      const grown = new Float32Array(shape.xy.length * 2);
      grown.set(shape.xy);
      shape.xy = grown;
    }
    shape.xy[shape.count] = x;
    shape.xy[shape.count + 1] = y;
    shape.count += 2;
    if (Number.isNaN(x)) return;
    if (x < shape.left) shape.left = x;
    if (x > shape.right) shape.right = x;
    if (y < shape.top) shape.top = y;
    if (y > shape.bottom) shape.bottom = y;
  }

  /**
   * Project a polyline (flat world-unit x, y, z) to an SVG path in layer pixels. A perspective camera cannot project what is
   * at or behind its near plane, so each segment is cut there first; each is then cut to the view plus a margin, so every
   * coordinate is finite and small however close the camera is. A cut that leaves a gap starts a new sub-path. `visible`
   * receives the index of every vertex that is on screen (what the occlusion samples are chosen from). One vertex draws a dot.
   * `extent`, when given, is rewritten with the stroke's size on screen and the points of the path it returns (see newDrawExtent).
   * `samples`, when given, is rewritten with world x, y, z of a point in the middle of each drawn segment, but only while no vertex of the
   * stroke is on screen yet: a segment can cross the view with both its vertices outside it, and those points are what the occlusion
   * rays use then (see pushClippedSample). It is emptied again when a vertex turns out to be on screen.
   */
  function projectDrawPath(points, camera, width, height, visible, extent = null, samples = null) {
    const count = Math.floor(points.length / 3);
    visible.length = 0;
    if (samples) samples.length = 0;
    if (extent) resetTrace(extent);
    if (!count) return '';
    camera.updateMatrixWorld(true);
    const e = camera.matrixWorldInverse.elements;
    const perspective = Boolean(camera.isPerspectiveCamera);
    const nearZ = -(camera.near + 0.001);
    const m = DRAW_CLIP_MARGIN_PX;
    const outline = [-m, -m, width + m, -m, width + m, height + m, -m, height + m];
    const fixed = value => value.toFixed(1);
    const parts = [];
    let lastX = NaN;
    let lastY = NaN;
    let previous = null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = points[3 * i];
      const y = points[3 * i + 1];
      const z = points[3 * i + 2];
      const current = {
        x: e[0] * x + e[4] * y + e[8] * z + e[12],
        y: e[1] * x + e[5] * y + e[9] * z + e[13],
        z: e[2] * x + e[6] * y + e[10] * z + e[14],
      };
      const inFront = !perspective || current.z <= nearZ;
      if (inFront) {
        const screen = cameraToLayer(current, camera, width, height);
        if (screen.x >= 0 && screen.x <= width && screen.y >= 0 && screen.y <= height) visible.push(i);
        // How large the stroke is on screen, from every vertex in front of the camera (not the clipped path, so panning never changes it).
        if (extent) {
          minX = Math.min(minX, screen.x);
          maxX = Math.max(maxX, screen.x);
          minY = Math.min(minY, screen.y);
          maxY = Math.max(maxY, screen.y);
        }
      }
      if (previous) {
        let a = previous;
        let b = current;
        let drawable = true;
        if (perspective) {
          const cut = clipSegmentToNear(a, b, nearZ);
          if (cut) ({ a, b } = cut);
          else drawable = false;
        }
        const sa = drawable ? cameraToLayer(a, camera, width, height) : null;
        const sb = drawable ? cameraToLayer(b, camera, width, height) : null;
        const clip = drawable ? clipSegmentToConvex(sa, sb, outline) : null;
        if (clip) {
          if (samples && !visible.length) pushClippedSample(samples, a, b, sa, sb, clip, camera, perspective);
          const jump = !(Math.abs(clip.a.x - lastX) < 0.05 && Math.abs(clip.a.y - lastY) < 0.05);
          if (jump) parts.push(`M${fixed(clip.a.x)} ${fixed(clip.a.y)}`);
          parts.push(`L${fixed(clip.b.x)} ${fixed(clip.b.y)}`);
          if (extent) {
            if (jump) {
              if (extent.count) pushTrace(extent, NaN, NaN);
              pushTrace(extent, clip.a.x, clip.a.y);
            }
            pushTrace(extent, clip.b.x, clip.b.y);
          }
          lastX = clip.b.x;
          lastY = clip.b.y;
        }
      }
      previous = current;
    }
    if (samples && visible.length) samples.length = 0;
    if (extent && maxX >= minX) extent.span = Math.hypot(maxX - minX, maxY - minY);
    if (!parts.length && count === 1 && visible.length) {
      const screen = cameraToLayer(previous, camera, width, height);
      if (extent) {
        pushTrace(extent, screen.x, screen.y);
        pushTrace(extent, screen.x, screen.y);
      }
      return `M${fixed(screen.x)} ${fixed(screen.y)}L${fixed(screen.x)} ${fixed(screen.y)}`;
    }
    return parts.join('');
  }

  /**
   * One occlusion sample for a segment the view clips: the middle of what is drawn of it (the clip's two ends), taken back onto the
   * segment in camera space and then to the world, so the ray from the camera runs through the very pixel that shows it. A position
   * along a perspective segment is not linear on screen, so the screen fraction is weighted by the depths of the segment's two ends.
   * `a` and `b` are the segment's camera-space ends after the near cut, `sa` and `sb` the same on the layer.
   */
  function pushClippedSample(samples, a, b, sa, sb, clip, camera, perspective) {
    const dx = sb.x - sa.x;
    const dy = sb.y - sa.y;
    const length = dx * dx + dy * dy;
    if (!(length > 0)) return;
    const mx = (clip.a.x + clip.b.x) / 2;
    const my = (clip.a.y + clip.b.y) / 2;
    const s = Math.min(1, Math.max(0, ((mx - sa.x) * dx + (my - sa.y) * dy) / length));
    let t = s;
    if (perspective) {
      const weight = (1 - s) * -b.z + s * -a.z;
      if (!(weight > 0)) return;
      t = (s * -a.z) / weight;
    }
    const x = a.x + t * (b.x - a.x);
    const y = a.y + t * (b.y - a.y);
    const z = a.z + t * (b.z - a.z);
    const m = camera.matrixWorld.elements;
    samples.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
  }

  /**
   * Which saved strokes are drawn this frame, and their paths. A stroke is drawn only while it is Valid, not hidden, shown by
   * the Show mode and projects onto the view. Its geometry is rebuilt only when the camera, the cargo it sits on, the viewport
   * or its vertices changed; a color, width or selection change reuses the path it already has.
   */
  function collectDraws(camera, width, height, camSig) {
    const entries = [];
    const live = new Set();
    records.forEach(record => {
      if (!isDraw(record)) return;
      live.add(record.id);
      const known = drawViews.get(record.id);
      if (!drawableIds.has(record.id) || !isShownByMode(record.id)) {
        if (known) hideDrawView(known);
        return;
      }
      const view = known || getDrawView(record.id);
      if (view.record !== record) {
        const local = drawLocalPoints(record);
        const same = Boolean(local) && Boolean(view.local) && view.face === record.face && view.kind === record.anchor.kind && sameNumbers(view.local, local);
        if (!same) {
          view.local = local;
          view.face = record.face;
          view.kind = record.anchor.kind;
          view.stamp = NaN;
          view.measured = false;
        }
        view.record = record;
      }
      let group = null;
      if (view.local && record.anchor.kind === 'cargo') {
        group = cargoGroupFor(record.anchor);
        if (group) {
          group.updateMatrixWorld(true);
          const elements = group.matrixWorld.elements;
          let poseStamp = 0;
          for (let i = 0; i < 16; i++) poseStamp += elements[i] * (i + 1.7);
          view.poseStamp = poseStamp;
        }
      } else {
        view.poseStamp = 0;
      }
      if (!view.local || (record.anchor.kind === 'cargo' && !group)) {
        hideDrawView(view);
        return;
      }
      const stamp = camSig + view.poseStamp * 3.1 + width * 0.013 + height * 0.017;
      // A stroke being carried is drawn from a shifted copy of its own vertices; the revision says when the offset changed.
      const carried = Boolean(moveDrag && moveDrag.moved && moveDrag.id === record.id);
      const dragKey = carried ? moveDrag.rev : 0;
      if (stamp !== view.stamp || dragKey !== view.dragKey) {
        view.stamp = stamp;
        view.dragKey = dragKey;
        const source = carried ? movedLocal(view, record) : view.local;
        if (group) {
          const matrix = group.matrixWorld.elements;
          const count = source.length / 3;
          if (!view.world || view.world.length !== source.length || view.world === view.local) view.world = new Float64Array(source.length);
          for (let i = 0; i < count; i++) {
            const x = source[3 * i];
            const y = source[3 * i + 1];
            const z = source[3 * i + 2];
            view.world[3 * i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
            view.world[3 * i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
            view.world[3 * i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
          }
        } else {
          view.world = source;
        }
        view.d = projectDrawPath(view.world, camera, width, height, view.visible, view.extent, view.samples);
      }
      if (!view.d) {
        hideDrawView(view);
        return;
      }
      view.shown = true;
      entries.push({ record, view, selected: record.id === selectedId });
    });
    [...drawViews.keys()].forEach(id => { if (!live.has(id)) removeDrawView(id); });
    return entries;
  }

  /**
   * Whether any of a few sample vertices of a stroke is hidden behind cargo or the truck from where the camera is: one hidden
   * sample marks the whole stroke occluded, the same convention as an arrow. At most DRAW_OCCLUSION_RAYS_PER_STROKE rays, chosen
   * evenly from the vertices that are on screen; a stroke with none costs none.
   */
  function computeDrawFront(view, camera, meshes) {
    const own = view.visible.length > 0;
    const available = drawSampleCount(view);
    const rays = Math.min(DRAW_OCCLUSION_RAYS_PER_STROKE, available);
    if (!rays) return false; // nothing was tested, so nothing is known to be clear
    for (let k = 0; k < rays; k++) {
      const nth = rays === 1 ? 0 : Math.round((k * (available - 1)) / (rays - 1));
      if (own) {
        const i = view.visible[nth];
        sampleWorld.set(view.world[3 * i], view.world[3 * i + 1], view.world[3 * i + 2]);
      } else {
        sampleWorld.set(view.samples[3 * nth], view.samples[3 * nth + 1], view.samples[3 * nth + 2]);
      }
      if (!isRayClear(sampleWorld, camera, meshes)) return false;
    }
    return true;
  }

  /** What a stroke offers the occlusion rays: its own vertices that are on screen, else the middles of the clipped segments that cross it. */
  function drawSampleCount(view) {
    return view.visible.length || view.samples.length / 3;
  }

  /**
   * Refresh the occlusion of drawn strokes. A stroke is measured when it first appears and again after the scene or camera
   * moved (the same signal that drives callouts and arrows), no more often than OCCLUSION_INTERVAL_MS, at most
   * DRAW_OCCLUSION_RAYS_PER_TICK rays per measurement, oldest measurement first, so a crowded plan catches up over a few ticks
   * instead of casting every ray at once. A stroke that has never been measured is drawn as hidden until it is.
   */
  function measureDraws(entries, camera, now, due) {
    const present = new Set(entries.map(entry => entry.record.id));
    drawBacklog.forEach(id => { if (!present.has(id)) drawBacklog.delete(id); });
    if (due) present.forEach(id => drawBacklog.add(id));
    let fresh = false;
    entries.forEach(entry => {
      if (entry.view.measured) return;
      drawBacklog.add(entry.record.id);
      fresh = true;
    });
    if (!drawBacklog.size || (!fresh && now - lastDrawMeasureAt < OCCLUSION_INTERVAL_MS)) return;
    lastDrawMeasureAt = now;
    const meshes = CaseScene.getRaycastMeshes().filter(mesh => mesh.parent && mesh.parent.visible !== false);
    meshes.forEach(mesh => mesh.updateWorldMatrix(true, false));
    let rays = DRAW_OCCLUSION_RAYS_PER_TICK;
    const waiting = entries.filter(entry => drawBacklog.has(entry.record.id)).sort((a, b) => a.view.measuredAt - b.view.measuredAt);
    for (const entry of waiting) {
      const cost = Math.min(DRAW_OCCLUSION_RAYS_PER_STROKE, drawSampleCount(entry.view));
      if (cost > rays) break;
      rays -= cost;
      entry.view.front = meshes.length ? computeDrawFront(entry.view, camera, meshes) : true;
      entry.view.measured = true;
      entry.view.measuredAt = now;
      drawBacklog.delete(entry.record.id);
    }
  }

  function paintDraws(entries) {
    entries.forEach(({ record, view, selected }) => {
      const moving = Boolean(moveDrag && moveDrag.moved && moveDrag.id === record.id);
      paintDraw(view.graphic, view.d, {
        color: paintColorOf(record), width: record.width, style: lineStyleOf(record), selected: selected,
        occluded: !view.front && !moving, moving, invalid: moving && !moveDrag.valid, span: view.extent.span,
      });
    });
  }

  /** The stroke being drawn: its samples so far as one path, repainted at most once per frame (this runs from the frame's render). */
  function renderStrokePreview(parts, camera, width, height, camSig) {
    const preview = parts.drawPreview;
    if (!stroke) {
      paintDraw(preview, '', { color: preview.colorKey });
      return;
    }
    const key = `${camSig}|${stroke.world.length}|${width}|${height}`;
    if (stroke.previewKey !== key) {
      stroke.previewKey = key;
      stroke.previewPath = projectDrawPath(stroke.world, camera, width, height, strokePreviewVisible);
    }
    paintDraw(preview, stroke.previewPath, {
      color: stroke.style.color, width: stroke.style.width, style: stroke.style.style, frozen: stroke.phase === 'frozen',
    });
  }

  // ==========================================================================
  // SECTION: ARROWS (SVG shaft + head in the overlay; never a Three.js object)
  // ==========================================================================
  /** The four paths of one arrow: a neutral halo under the shaft and under the head, the colored shaft and the head. */
  function makeArrowGraphic(extraClass = '') {
    const group = svgEl('g', `tp3d-annot-arrow ${extraClass}`.trim());
    const under = svgEl('path', 'tp3d-annot-arrow__under');
    const underHead = svgEl('path', 'tp3d-annot-arrow__under-head');
    const shaft = svgEl('path', 'tp3d-annot-arrow__shaft');
    const head = svgEl('path', 'tp3d-annot-arrow__head');
    group.append(under, underHead, shaft, head);
    return { group, under, underHead, shaft, head, colorKey: null, patternKey: '' };
  }

  function setStyleProp(el, name, value) {
    if (el.style[name] !== value) el.style[name] = value;
  }

  /** The line style a stored arrow or drawing shows: a record with no `style` has always been solid. */
  function lineStyleOf(record) {
    return record && LINE_STYLES.includes(record.style) ? record.style : DEFAULT_LINE_STYLE;
  }

  /**
   * Draw a line (and its halo) in its style at `px` screen pixels. Dashes and the dot spacing grow with the weight, so a Bold
   * line is never a Thin pattern thickened. Dots are zero-length dashes with round caps; Solid sets nothing, which leaves the
   * stylesheet in charge (including its dashed look for a Solid line hidden behind cargo).
   */
  function paintLinePattern(graphic, style, px, line, halo) {
    const key = `${style}|${px}`;
    if (graphic.patternKey === key) return;
    graphic.patternKey = key;
    let dash = '';
    let cap = '';
    if (style === 'dashed') {
      dash = `${px * 4} ${Math.max(px * 2.5, 5)}`;
      cap = 'butt';
    } else if (style === 'dotted') {
      dash = `0.01 ${Math.max(px * 2.6, px + 7)}`;
      cap = 'round';
    }
    [line, halo].forEach(path => {
      setStyleProp(path, 'strokeDasharray', dash);
      setStyleProp(path, 'strokeLinecap', cap);
    });
  }

  /**
   * Show `shape` (from `arrowShape`, or null to clear) on a graphic. The width is constant on screen; a selected arrow
   * swaps its neutral halo (2 px a side) for a 1 px orange edge, and a hidden one (dashed, hollow head) keeps its neutral halo.
   */
  function paintArrow(graphic, shape, { color, style = DEFAULT_LINE_STYLE, selected = false, occluded = false }) {
    if (graphic.colorKey !== color) {
      graphic.colorKey = color;
      applyColor(graphic.group, color);
    }
    toggleClass(graphic.group, 'is-selected', selected);
    toggleClass(graphic.group, 'is-occluded', occluded);
    const data = arrowPathData(shape);
    setPath(graphic.under, data.shaft);
    setPath(graphic.shaft, data.shaft);
    setPath(graphic.underHead, data.head);
    setPath(graphic.head, data.head);
    if (!shape) return;
    setAttr(graphic.group, 'data-line-style', style);
    const halo = selected && !occluded ? 2 : 4;
    // A Dotted shaft gets the same neutral edge as a Dotted drawing (DRAW_EDGE_PX.dotted, 1.5 px in total), so the dots read alike.
    // The head keeps its own halo: it is solid, and it is what shows the direction.
    const shaftHalo = style === 'dotted' && !(selected && !occluded) ? ARROW_DOTTED_HALO_PX : halo;
    setStyleProp(graphic.shaft, 'strokeWidth', `${shape.shaftWidth}px`);
    setStyleProp(graphic.under, 'strokeWidth', `${shape.shaftWidth + shaftHalo}px`);
    setStyleProp(graphic.underHead, 'strokeWidth', `${halo}px`);
    // Only the shaft and its halo take the pattern; the head and its halo stay solid so the direction always reads.
    paintLinePattern(graphic, style, shape.shaftWidth, graphic.shaft, graphic.under);
  }

  function getArrowView(id) {
    let view = arrowViews.get(id);
    if (!view) {
      const graphic = makeArrowGraphic();
      graphic.group.dataset.annotId = id;
      layerParts.arrowGroup.appendChild(graphic.group);
      const grips = {};
      ['start', 'end'].forEach(which => {
        const el = htmlEl('button', 'tp3d-annot-handle');
        el.type = 'button';
        el.hidden = true;
        el.dataset.annotId = id;
        el.dataset.end = which;
        els.layer.appendChild(el);
        grips[which] = { el, key: '' };
      });
      view = { id, graphic, grips, startWorld: new THREE.Vector3(), endWorld: new THREE.Vector3(), front: true, measured: false, shown: false, tail: null, head: null };
      arrowViews.set(id, view);
      visDirty = true;
    }
    return view;
  }

  function hideArrowView(view) {
    paintArrow(view.graphic, null, { color: view.graphic.colorKey });
    view.grips.start.el.hidden = true;
    view.grips.end.el.hidden = true;
    view.shown = false;
  }

  function removeArrowView(id) {
    const view = arrowViews.get(id);
    if (!view) return;
    view.graphic.group.remove();
    view.grips.start.el.remove();
    view.grips.end.el.remove();
    arrowViews.delete(id);
  }

  /** Camera-space point to layer pixels. Callers have already kept it in front of a perspective camera. */
  function cameraToLayer(point, camera, width, height) {
    projected.set(point.x, point.y, point.z).applyMatrix4(camera.projectionMatrix);
    return { x: (projected.x * 0.5 + 0.5) * width, y: (-projected.y * 0.5 + 0.5) * height };
  }

  /**
   * Project the two world ends of an arrow to the layer and shape them. A perspective camera cannot project what is
   * at or behind its near plane, so the segment is cut there first (the cut end is flagged and gets no head or
   * handle). Null when nothing can be drawn: behind the camera, off screen, too short on screen or not finite.
   */
  function projectArrow(from, to, camera, width, height, viewport, widthName) {
    cameraSpaceA.copy(from).applyMatrix4(camera.matrixWorldInverse);
    cameraSpaceB.copy(to).applyMatrix4(camera.matrixWorldInverse);
    let a = { x: cameraSpaceA.x, y: cameraSpaceA.y, z: cameraSpaceA.z };
    let b = { x: cameraSpaceB.x, y: cameraSpaceB.y, z: cameraSpaceB.z };
    let tailClipped = false;
    let headClipped = false;
    if (camera.isPerspectiveCamera) {
      const clipped = clipSegmentToNear(a, b, -(camera.near + 0.001));
      if (!clipped) return null;
      ({ a, b } = clipped);
      tailClipped = clipped.aClipped;
      headClipped = clipped.bClipped;
    }
    const tail = cameraToLayer(a, camera, width, height);
    const head = cameraToLayer(b, camera, width, height);
    const shape = arrowShape({ tail, head, width: widthName, viewport, headClipped });
    return shape ? { shape, tail, head, tailClipped, headClipped } : null;
  }

  /** A shifted non-cargo anchor's own position, for the live preview of a carried arrow (cargo anchors follow their live group instead). */
  function carriedPoint(anchor) {
    return anchor.kind === 'cargo' ? null : anchor.position;
  }

  /**
   * Which arrows are drawn this frame and where they project. An arrow is drawn only while it is Valid (both ends
   * resolve), not hidden, shown by the Show mode, still at least the minimum length apart as the scene displays
   * it (cargo may have moved since it was saved; the record is never touched) and projects to a readable shape.
   */
  function collectArrows(camera, width, height, viewport) {
    const entries = [];
    const live = new Set();
    const scale = picker.toWorldScale();
    records.forEach((record, index) => {
      if (!isArrow(record)) return;
      live.add(record.id);
      const known = arrowViews.get(record.id);
      if (!drawableIds.has(record.id) || !isShownByMode(record.id)) {
        if (known) hideArrowView(known);
        return;
      }
      const view = known || getArrowView(record.id);
      const result = results[index];
      const candidate = pinDrag && pinDrag.moved && pinDrag.id === record.id && pinDrag.which && pinDrag.candidate ? pinDrag.candidate : null;
      // The end being dragged follows the surface under the pointer; everything else follows the displayed scene.
      // A whole-arrow move shows both ends at the live offset: the shifted anchors, from the same pure move the write uses.
      const carried = moveDrag && moveDrag.moved && moveDrag.subject === 'arrow' && moveDrag.id === record.id && moveDrag.pair ? moveDrag.pair : null;
      const startAnchor = carried ? carried.start : record.start;
      const endAnchor = carried ? carried.end : record.end;
      const startOk = candidate && pinDrag.which === 'start' ? view.startWorld.copy(candidate.world)
        : liveAnchorWorld(startAnchor, carried ? carriedPoint(startAnchor) : result.start, view.startWorld);
      const endOk = candidate && pinDrag.which === 'end' ? view.endWorld.copy(candidate.world)
        : liveAnchorWorld(endAnchor, carried ? carriedPoint(endAnchor) : result.end, view.endWorld);
      if (!startOk || !endOk || view.startWorld.distanceTo(view.endWorld) / scale < MIN_ARROW_LENGTH_INCHES) {
        hideArrowView(view);
        return;
      }
      const projection = projectArrow(view.startWorld, view.endWorld, camera, width, height, viewport, record.width);
      if (!projection) {
        hideArrowView(view);
        return;
      }
      entries.push({ record, view, projection, selected: record.id === selectedId });
    });
    [...arrowViews.keys()].forEach(id => { if (!live.has(id)) removeArrowView(id); });
    return entries;
  }

  function placeGrip(grip, screen, label, dragging) {
    if (!screen) {
      setHidden(grip.el, true);
      return;
    }
    const transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
    if (grip.key !== transform) {
      grip.key = transform;
      grip.el.style.transform = transform;
    }
    setAttr(grip.el, 'aria-label', label);
    grip.el.title = 'Drag to move this end';
    toggleClass(grip.el, 'is-dragging', dragging);
    setHidden(grip.el, false);
  }

  /** Paint every drawn arrow. Two end handles exist only on the selected arrow, and not while a tool or re-attach owns the scene. */
  function drawArrows(entries, width, height) {
    const gripsAllowed = !isActive() && !sceneOwnedElsewhere();
    entries.forEach(({ record, view, projection, selected: isSelected }) => {
      const selected = isSelected;
      // A whole-arrow move that cannot be dropped where the pointer is shows the arrow as the dashed, behind-cargo look.
      const refused = Boolean(moveDrag && moveDrag.moved && moveDrag.subject === 'arrow' && moveDrag.id === record.id && !moveDrag.valid);
      paintArrow(view.graphic, projection.shape, { color: paintColorOf(record), style: lineStyleOf(record), selected, occluded: !view.front || refused });
      view.shown = true;
      // Kept for the Editor's click test: the layer pixels of the shaft exactly as it was just painted.
      view.tail = projection.tail;
      view.head = projection.head;
      ['start', 'end'].forEach(which => {
        const screen = which === 'start' ? projection.tail : projection.head;
        const clipped = which === 'start' ? projection.tailClipped : projection.headClipped;
        const onScreen = !clipped && screen.x >= 0 && screen.x <= width && screen.y >= 0 && screen.y <= height;
        const dragging = Boolean(pinDrag && pinDrag.moved && pinDrag.id === record.id && pinDrag.which === which);
        placeGrip(view.grips[which], selected && gripsAllowed && onScreen ? screen : null,
          `${arrowName(record.id)} ${ARROW_END_NAMES[which]} handle. Drag it, or press Enter and click the scene.`, dragging);
      });
    });
  }

  /** While an arrow is being placed: a dot at the tail and the arrow it would make to the surface under the pointer. */
  function renderArrowPreview(parts, camera, width, height, viewport) {
    const { preview, previewTail, previewTailUnder } = parts;
    const showDot = visible => {
      setStyleProp(previewTail, 'display', visible ? '' : 'none');
      setStyleProp(previewTailUnder, 'display', visible ? '' : 'none');
    };
    if (!arrowTail || blockedReason()) {
      paintArrow(preview, null, { color: arrowStyle.color });
      showDot(false);
      return;
    }
    if (!liveAnchorWorld(arrowTail.anchor, null, tailWorld)) tailWorld.copy(arrowTail.world);
    const tailScreen = projectToLayer(tailWorld, camera, width, height, scratchScreen);
    if (tailScreen) {
      const cx = tailScreen.x.toFixed(1);
      const cy = tailScreen.y.toFixed(1);
      [previewTail, previewTailUnder].forEach(dot => {
        setAttr(dot, 'cx', cx);
        setAttr(dot, 'cy', cy);
      });
    }
    showDot(Boolean(tailScreen));
    const target = hover && hover.world && !(pinDrag && pinDrag.moved) ? hover.world : null;
    const far = target && tailWorld.distanceTo(target) / picker.toWorldScale() >= MIN_ARROW_LENGTH_INCHES;
    const projection = far ? projectArrow(tailWorld, target, camera, width, height, viewport, arrowStyle.width) : null;
    paintArrow(preview, projection ? projection.shape : null, { color: arrowStyle.color, style: arrowStyle.style });
  }

  function makePin(id) {
    const pin = htmlEl('button', 'tp3d-annot-pin');
    pin.type = 'button';
    pin.hidden = true; // drawn only once it has a valid projected position
    pin.dataset.annotId = id;
    const badge = htmlEl('span', 'tp3d-annot-pin__badge');
    const chip = htmlEl('span', 'tp3d-annot-pin__chip');
    chip.hidden = true;
    pin.append(badge, chip);
    els.layer.appendChild(pin);
    return { pin, badge, chip };
  }

  function makeCard(id) {
    const card = htmlEl('div', 'tp3d-annot-card');
    card.dataset.annotId = id;
    card.setAttribute('role', 'group');
    const head = htmlEl('div', 'tp3d-annot-card__head');
    head.title = 'Drag to move this card';
    const swatch = htmlEl('span', 'tp3d-annot-card__swatch');
    const title = htmlEl('span', 'tp3d-annot-card__title');
    const edit = htmlEl('button', 'tp3d-annot-card__btn');
    edit.type = 'button';
    edit.dataset.act = 'edit';
    edit.title = 'Edit callout';
    edit.setAttribute('aria-label', 'Edit callout');
    edit.appendChild(iconEl('fa-solid fa-pen'));
    const collapse = htmlEl('button', 'tp3d-annot-card__btn');
    collapse.type = 'button';
    collapse.dataset.act = 'collapse';
    const chevron = iconEl('fa-solid fa-chevron-up');
    collapse.appendChild(chevron);
    head.append(swatch, title, edit, collapse);
    const desc = htmlEl('div', 'tp3d-annot-card__desc');
    const foot = htmlEl('div', 'tp3d-annot-card__foot');
    const target = htmlEl('span', 'tp3d-annot-card__target');
    const behind = htmlEl('span', 'tp3d-annot-card__behind', 'Behind cargo');
    foot.append(iconEl('fa-solid fa-cube'), target, behind);
    card.append(head, desc, foot);
    els.layer.appendChild(card);
    return { card, swatch, title, edit, collapse, chevron, desc, foot, target, behind };
  }

  function getView(id) {
    let view = views.get(id);
    if (!view) {
      const pinParts = makePin(id);
      view = {
        id, ...pinParts, cardParts: null, world: new THREE.Vector3(), screen: null, front: true, measured: false, slot: null,
        cardKey: '', cardSize: null, cardRect: null, pinKey: '', transformKey: '', cardTransformKey: '', shown: false,
      };
      views.set(id, view);
      visDirty = true;
    }
    return view;
  }

  function hideView(view) {
    view.pin.hidden = true;
    if (view.cardParts) {
      view.cardParts.card.hidden = true;
      view.cardParts.card.classList.remove('is-selected');
    }
    view.shown = false;
    view.screen = null;
    view.cardRect = null;
  }

  function removeView(id) {
    const view = views.get(id);
    if (!view) return;
    view.pin.remove();
    if (view.cardParts) view.cardParts.card.remove();
    views.delete(id);
    if (layerParts) {
      const leader = layerParts.leaders.get(id);
      if (leader) {
        leader.under.remove();
        leader.line.remove();
        layerParts.leaders.delete(id);
      }
    }
  }

  /** Remove every drawn element (the loop has stopped, the panel closed with nothing to show, or the Editor was left). */
  function disposeOverlay() {
    [...views.keys()].forEach(removeView);
    [...arrowViews.keys()].forEach(removeArrowView);
    [...drawViews.keys()].forEach(removeDrawView);
    drawBacklog = new Set();
    if (editorParts) setHidden(editorParts.root, true);
    if (layerParts) {
      paintDraw(layerParts.drawPreview, '', { color: layerParts.drawPreview.colorKey });
      if (stroke) stroke.previewKey = '';
      paintArrow(layerParts.preview, null, { color: arrowStyle.color });
      layerParts.previewTail.style.display = 'none';
      layerParts.previewTailUnder.style.display = 'none';
      layerParts.draftPin.pin.hidden = true;
      layerParts.tip.hidden = true;
      layerParts.overflow.hidden = true;
      layerParts.ghost.style.display = 'none';
      layerParts.hoverMark.setAttribute('d', '');
      layerParts.hoverUnder.setAttribute('d', '');
      layerParts.draftLeader.setAttribute('d', '');
      layerParts.draftLeaderUnder.setAttribute('d', '');
      layerParts.keys = { hover: '', ghost: '', draftLeader: '' };
    }
    lastSignature = NaN;
  }

  function setPath(el, d) {
    if (el.getAttribute('d') !== d) el.setAttribute('d', d);
  }

  /** Project a world point to layer pixels; null when it is behind a perspective camera. */
  function projectToLayer(point, camera, width, height, out) {
    projected.copy(point).applyMatrix4(camera.matrixWorldInverse);
    if (camera.isPerspectiveCamera && projected.z > -(camera.near + 0.001)) return null;
    projected.applyMatrix4(camera.projectionMatrix);
    out.x = (projected.x * 0.5 + 0.5) * width;
    out.y = (-projected.y * 0.5 + 0.5) * height;
    return out;
  }

  function cameraSignature(camera) {
    const e = camera.matrixWorld.elements;
    const p = camera.projectionMatrix.elements;
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i] * (i + 1.37);
    return sum + p[0] * 7.1 + p[5] * 3.3 + p[10] * 1.9 + p[14] * 0.7;
  }

  /**
   * Whether the marker's surface faces the camera and nothing is in front of it. Derived on demand (never
   * stored); a marker that fails either test is drawn hollow, but a selected one keeps its card.
   */
  function computeFront(entry, camera, meshes) {
    const { record, view } = entry;
    const spec = anchorSurfaceNormal(record.anchor);
    let hasNormal = false;
    if (spec) {
      if (spec.frame === 'world') {
        normalVec.set(spec.x, spec.y, spec.z);
        hasNormal = true;
      } else {
        const group = cargoGroupFor(record.anchor);
        if (group) {
          group.updateMatrixWorld(true);
          normalVec.set(spec.x, spec.y, spec.z).transformDirection(group.matrixWorld);
          hasNormal = true;
        }
      }
    }
    const ortho = Boolean(camera.isOrthographicCamera);
    if (ortho) camera.getWorldDirection(viewDir);
    else camera.getWorldPosition(camPos);
    if (hasNormal) {
      const facing = ortho ? normalVec.dot(viewDir) < 0 : normalVec.dot(rayDir.subVectors(camPos, view.world)) > 0;
      if (!facing) return false;
    }
    return isRayClear(view.world, camera, meshes);
  }

  /**
   * Whether nothing in the scene stands between the camera and `point`. The ray goes from the camera TOWARD the point,
   * stopping just short of it: whatever is hit on the way hides it. (Casting from the point would start inside any
   * cargo that was moved onto it, where back faces are culled.)
   */
  function isRayClear(point, camera, meshes) {
    const scale = picker.toWorldScale();
    let far;
    if (camera.isOrthographicCamera) {
      camera.getWorldDirection(viewDir);
      rayDir.copy(viewDir);
      rayOrigin.copy(point).addScaledVector(viewDir, -ORTHO_RAY_LENGTH);
      far = ORTHO_RAY_LENGTH - OCCLUSION_STOP_INCHES * scale;
    } else {
      camera.getWorldPosition(camPos);
      rayDir.subVectors(point, camPos);
      far = rayDir.length() - OCCLUSION_STOP_INCHES * scale;
      if (far <= MIN_RAY_LENGTH) return true;
      rayDir.normalize();
      rayOrigin.copy(camPos);
    }
    raycaster.set(rayOrigin, rayDir);
    raycaster.near = 0;
    raycaster.far = far;
    return raycaster.intersectObjects(meshes, false).length === 0;
  }

  /**
   * An arrow is in the clear only when nothing hides any of three points along it (tail, middle, head). Sampled,
   * never stored, and at most a few rays per arrow per refresh; one hidden sample marks the whole arrow occluded.
   */
  function computeArrowFront(view, camera, meshes) {
    for (const fraction of ARROW_SAMPLE_FRACTIONS) {
      sampleWorld.lerpVectors(view.startWorld, view.endWorld, fraction);
      if (!isRayClear(sampleWorld, camera, meshes)) return false;
    }
    return true;
  }

  function updatePin(view, entry, flags) {
    const { record } = entry;
    const key = `${record.title}|${record.color}|${entry.number}|${flags.chipText}|${flags.selected}|${flags.hollow}|${flags.dragging}`;
    if (view.pinKey !== key) {
      view.pinKey = key;
      setText(view.badge, String(entry.number));
      applyColor(view.pin, record.color);
      setAttr(view.pin, 'aria-label', `Callout ${entry.number}: ${record.title}`);
      setAttr(view.pin, 'aria-pressed', flags.selected ? 'true' : 'false');
      view.pin.title = record.title;
      toggleClass(view.pin, 'is-selected', flags.selected);
      toggleClass(view.pin, 'is-hollow', flags.hollow);
      toggleClass(view.pin, 'is-dragging', flags.dragging);
      setText(view.chip, flags.chipText);
      setHidden(view.chip, !flags.chipText);
    }
    toggleClass(view.pin, 'is-chip-left', view.screen.x > flags.width - LABEL_FLIP_MARGIN);
    const transform = `translate(${view.screen.x.toFixed(1)}px, ${view.screen.y.toFixed(1)}px)`;
    if (view.transformKey !== transform) {
      view.transformKey = transform;
      view.pin.style.transform = transform;
    }
    if (view.pin.hidden) view.pin.hidden = false;
  }

  function updateCardContent(view, entry, cardW, behind, selected) {
    if (!view.cardParts) view.cardParts = makeCard(entry.record.id);
    const parts = view.cardParts;
    const { record } = entry;
    const targetName = anchorTargetName(record.anchor);
    const collapsed = collapsedIds.has(record.id);
    const key = `${record.title}\n${record.description || ''}\n${record.color}\n${entry.number}\n${targetName}\n${cardW}\n${collapsed}`;
    const wasHidden = parts.card.hidden;
    if (wasHidden) parts.card.hidden = false;
    if (view.cardKey !== key) {
      view.cardKey = key;
      applyColor(parts.card, record.color);
      parts.card.style.width = `${cardW}px`;
      setAttr(parts.card, 'aria-label', `Callout ${entry.number}: ${record.title}`);
      setText(parts.swatch, String(entry.number));
      setText(parts.title, record.title);
      setText(parts.desc, record.description || '');
      setText(parts.target, targetName);
      // A folded card keeps only its header: the title and swatch stay, the body and footer are hidden.
      toggleClass(parts.card, 'is-collapsed', collapsed);
      setHidden(parts.desc, collapsed || !record.description);
      setHidden(parts.foot, collapsed);
      parts.chevron.className = `fa-solid fa-chevron-${collapsed ? 'down' : 'up'}`;
      const foldLabel = `${collapsed ? 'Expand' : 'Collapse'} callout`;
      setAttr(parts.collapse, 'aria-label', foldLabel);
      setAttr(parts.collapse, 'title', foldLabel);
      setAttr(parts.collapse, 'aria-expanded', collapsed ? 'false' : 'true');
      view.cardSize = null;
    }
    toggleClass(parts.card, 'is-selected', selected);
    toggleClass(parts.card, 'is-behind', behind);
    setHidden(parts.behind, !behind);
    setHidden(parts.edit, !selected || collapsed);
    // The fold control stays for a selected callout and for a folded one, so a folded card can always be opened again.
    setHidden(parts.collapse, !selected && !collapsed);
    if (!view.cardSize || view.cardSize.w !== cardW) {
      // Measured once per content change (not per frame): the placement needs the real height.
      view.cardSize = { w: cardW, h: parts.card.offsetHeight || estimateCardHeight(record.description, cardW) };
    }
    return view.cardSize;
  }

  function placeCard(view, rect) {
    const transform = `translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px)`;
    if (view.cardTransformKey !== transform) {
      view.cardTransformKey = transform;
      view.cardParts.card.style.transform = transform;
    }
    view.cardRect = rect;
  }

  function leaderFor(parts, id) {
    let leader = parts.leaders.get(id);
    if (!leader) {
      leader = { under: svgEl('path', 'tp3d-annot-svg__under'), line: svgEl('path', 'tp3d-annot-svg__leader') };
      parts.svg.append(leader.under, leader.line);
      parts.leaders.set(id, leader);
    }
    return leader;
  }

  function render(now) {
    const camera = SceneManager.getCamera();
    const parts = ensureLayerParts();
    if (!camera || !parts || !doc || !inEditor()) return;
    // Another scene tool owns gestures: the overlay stays visible but takes no input (markers and cards go inert).
    syncInputOwnership();
    // Paused (an operation or a transient Results preview): nothing is drawn and nothing is projected,
    // raycast or laid out. The records are untouched; the overlay comes back from them when the pause ends.
    if (blockedReason()) {
      if (!graphicsHidden) {
        disposeOverlay();
        graphicsHidden = true;
      }
      return;
    }
    graphicsHidden = false;
    const layerRect = els.layer.getBoundingClientRect();
    const width = layerRect.width > 0 ? layerRect.width : 1;
    const height = layerRect.height > 0 ? layerRect.height : 1;
    const viewport = { width, height };
    const nextCompact = isCompactViewport(width);
    if (nextCompact !== compact) {
      compact = nextCompact;
      toggleClass(els.layer, 'is-compact', compact);
      if (panelOpen) renderPanel();
    }

    // 1. Which callouts are drawn, and where they project.
    const entries = [];
    const live = new Set();
    records.forEach((record, index) => {
      if (!isCallout(record)) return;
      live.add(record.id);
      if (!drawableIds.has(record.id) || !isShownByMode(record.id)) {
        const stale = views.get(record.id);
        if (stale) hideView(stale);
        return;
      }
      const view = getView(record.id);
      const dragging = Boolean(pinDrag && pinDrag.moved && pinDrag.id === record.id);
      const ok = dragging && pinDrag.candidate
        ? view.world.copy(pinDrag.candidate.world)
        : liveAnchorWorld(record.anchor, results[index].point, view.world);
      const screen = ok ? projectToLayer(view.world, camera, width, height, view.screen || {}) : null;
      if (!screen || screen.x < -OFFSCREEN_MARGIN_PX || screen.x > width + OFFSCREEN_MARGIN_PX ||
          screen.y < -OFFSCREEN_MARGIN_PX || screen.y > height + OFFSCREEN_MARGIN_PX) {
        hideView(view);
        return;
      }
      view.screen = screen;
      view.shown = true;
      entries.push({ record, view, number: numbers.get(record.id), selected: record.id === selectedId, dragging });
    });
    [...views.keys()].forEach(id => { if (!live.has(id)) removeView(id); });
    const arrowEntries = collectArrows(camera, width, height, viewport);
    const camSig = cameraSignature(camera);
    const drawEntries = collectDraws(camera, width, height, camSig);

    // 2. Facing and occlusion, refreshed only after something moved and at most every OCCLUSION_INTERVAL_MS.
    let signature = camSig;
    entries.forEach((entry, i) => {
      const p = entry.view.world;
      signature += (i + 1) * (p.x * 1.1 + p.y * 1.3 + p.z * 1.7);
    });
    arrowEntries.forEach((entry, i) => {
      const a = entry.view.startWorld;
      const b = entry.view.endWorld;
      signature += (i + 1.5) * (a.x * 0.9 + a.y * 1.2 + a.z * 1.6) + (i + 2.5) * (b.x * 1.3 + b.y * 0.8 + b.z * 1.1);
    });
    drawEntries.forEach((entry, i) => {
      signature += (i + 3.5) * entry.view.poseStamp * 0.37;
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      visDirty = true;
    }
    // Cargo that was added, removed, resized, moved or hidden by a scene sync is not in the signature above (a ground marker
    // or arrow does not move with it), so a completed sync that changed the layout asks for a new measurement of its own.
    const geometryRevision = typeof CaseScene.getGeometryRevision === 'function' ? CaseScene.getGeometryRevision() : 0;
    if (geometryRevision !== lastGeometryRevision) {
      lastGeometryRevision = geometryRevision;
      visDirty = true;
    }
    // A marker or arrow that has never been measured is measured at once, so it is never first drawn as in the clear.
    const unmeasured = entries.filter(entry => !entry.view.measured);
    const arrowsUnmeasured = arrowEntries.filter(entry => !entry.view.measured);
    const due = visDirty && now - lastVisAt >= OCCLUSION_INTERVAL_MS;
    if ((due || unmeasured.length || arrowsUnmeasured.length) && (entries.length || arrowEntries.length)) {
      if (due) {
        visDirty = false;
        lastVisAt = now;
      }
      const meshes = CaseScene.getRaycastMeshes().filter(mesh => mesh.parent && mesh.parent.visible !== false);
      // A scene sync moves the cargo groups at once, but world matrices are only refreshed when the renderer next draws. The
      // rays must test the layout that was just synchronized, not the one drawn last frame (this runs inside the sync's own task).
      meshes.forEach(mesh => mesh.updateWorldMatrix(true, false));
      (due ? entries : unmeasured).forEach(entry => {
        entry.view.front = computeFront(entry, camera, meshes);
        entry.view.measured = true;
      });
      (due ? arrowEntries : arrowsUnmeasured).forEach(entry => {
        entry.view.front = computeArrowFront(entry.view, camera, meshes);
        entry.view.measured = true;
      });
    }
    drawArrows(arrowEntries, width, height);
    // Strokes have their own measurement and ray budget; a plan with only strokes still consumes the shared signal here.
    measureDraws(drawEntries, camera, now, due);
    if (due) {
      visDirty = false;
      lastVisAt = now;
    }
    paintDraws(drawEntries);

    // 3. Which cards are shown: selected, kept expanded and (in Cards mode) every visible one, within a budget.
    const editingId = draft && draft.editId;
    // A folded callout keeps its header in every display mode, so Markers and Labels never hide it on its own.
    const wantsCard = entry => entry.record.id !== editingId &&
      (entry.selected || entry.record.keepExpanded || collapsedIds.has(entry.record.id) || display === 'cards') &&
      (entry.view.front || entry.selected || entry.record.keepExpanded || collapsedIds.has(entry.record.id));
    const candidates = entries.filter(wantsCard).sort((a, b) =>
      (Number(b.selected) - Number(a.selected)) ||
      (Number(b.record.keepExpanded) - Number(a.record.keepExpanded)) ||
      (Number(b.view.front) - Number(a.view.front)) || (a.number - b.number));
    const budget = cardBudget(width, height);
    const shown = candidates.slice(0, budget);
    const shownIds = new Set(shown.map(entry => entry.record.id));
    const overflow = candidates.length - shown.length;

    // 4. Pins first (cards avoid every marker), then cards in priority order.
    const pinRects = entries.map(entry => ({ id: entry.record.id, x: entry.view.screen.x - PIN_RECT_PX / 2, y: entry.view.screen.y - PIN_RECT_PX / 2, w: PIN_RECT_PX, h: PIN_RECT_PX }));
    const resultsBox = resultsObstacles();
    fitPanel(resultsBox, viewport);
    const panelBox = panelObstacle(resultsBox);
    const labelIds = display === 'markers' ? new Set() : fitLabels(
      entries.filter(entry => entry.view.front && !shownIds.has(entry.record.id))
        .sort((a, b) => a.number - b.number)
        .map(entry => ({ id: entry.record.id, marker: { x: entry.view.screen.x, y: entry.view.screen.y }, text: entry.record.title })),
      panelBox ? pinRects.concat(panelBox.map(box => ({ id: '', ...box }))) : pinRects, width);
    entries.forEach(entry => {
      const showLabel = labelIds.has(entry.record.id);
      updatePin(entry.view, entry, {
        selected: entry.selected,
        hollow: !entry.view.front && !entry.selected,
        dragging: entry.dragging,
        chipText: showLabel ? entry.record.title : '',
        width,
      });
    });
    const cardW = cardWidth(width);
    const placed = [];
    const activeLeaders = new Set();
    shown.forEach(entry => {
      const { view, record } = entry;
      const size = updateCardContent(view, entry, cardW, !view.front, entry.selected);
      const marker = { x: view.screen.x, y: view.screen.y };
      let rect;
      if (cardDrag && cardDrag.id === record.id && cardDrag.rect) {
        rect = cardDrag.rect;
      } else if (record.offset) {
        rect = rectFromOffset(marker, record.offset, size, viewport);
      } else {
        // A saved card also keeps clear of the camera and zoom stack, so its Edit and Collapse buttons stay reachable.
        const occupied = [...pinRects.filter(pinRect => pinRect.id !== record.id), ...placed, ...(panelBox || []), ...controlsObstacle()];
        const auto = autoPlace({ marker, size, viewport, occupied, previousSlot: view.slot });
        view.slot = auto.slot;
        rect = { x: auto.x, y: auto.y, w: auto.w, h: auto.h };
      }
      placed.push(rect);
      placeCard(view, rect);
      const line = leaderLine(marker, rect);
      const leader = leaderFor(parts, record.id);
      activeLeaders.add(record.id);
      const d = line ? `M${line.x1.toFixed(1)} ${line.y1.toFixed(1)}L${line.x2.toFixed(1)} ${line.y2.toFixed(1)}` : '';
      setPath(leader.under, d);
      setPath(leader.line, d);
      toggleClass(leader.line, 'is-selected', entry.selected);
    });
    entries.forEach(entry => {
      if (shownIds.has(entry.record.id)) return;
      const card = entry.view.cardParts && entry.view.cardParts.card;
      if (card && !card.hidden) {
        card.hidden = true;
        card.classList.remove('is-selected');
      }
      entry.view.cardRect = null;
    });
    parts.leaders.forEach((leader, id) => {
      if (activeLeaders.has(id)) return;
      setPath(leader.under, '');
      setPath(leader.line, '');
    });

    // 5. The overflow notice, the new-callout marker and editor card, the hover mark and its tip, the drag ghost.
    setHidden(parts.overflow, overflow <= 0);
    if (overflow > 0) {
      setText(parts.overflowText, `${overflow} more ${overflow === 1 ? 'callout is' : 'callouts are'} shown without a card. Zoom in or hide some to see their cards.`);
    }
    renderDraft(parts, camera, width, height, viewport, pinRects, panelBox, resultsBox);
    renderArrowPreview(parts, camera, width, height, viewport);
    renderStrokePreview(parts, camera, width, height, camSig);
    renderHover(parts, camera, width, height);
    renderGhost(parts, camera, width, height, entries);
  }

  function renderDraft(parts, camera, width, height, viewport, pinRects, panelBox, resultsBox) {
    const pin = parts.draftPin;
    if (!draft) {
      if (!pin.pin.hidden) pin.pin.hidden = true;
      setPath(parts.draftLeader, '');
      setPath(parts.draftLeaderUnder, '');
      setPanelBehindEditor(false);
      return;
    }
    // The new callout's marker, or (when editing) the existing marker is drawn by its own view.
    let screen;
    if (!draft.editId) {
      const dragging = pinDrag && pinDrag.moved && pinDrag.id === DRAFT_ID && pinDrag.candidate;
      // Cargo follows the scene's displayed pose; any other surface is a fixed point in space.
      if (dragging) draftWorld.copy(pinDrag.candidate.world);
      else if (!liveAnchorWorld(draft.anchor, null, draftWorld)) draftWorld.copy(draft.world);
      screen = projectToLayer(draftWorld, camera, width, height, scratchScreen);
    } else {
      const view = views.get(draft.editId);
      screen = view && view.screen ? view.screen : null;
    }
    if (!draft.editId) {
      if (screen) {
        const transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
        if (pin.pin.style.transform !== transform) pin.pin.style.transform = transform;
        if (pin.pin.hidden) pin.pin.hidden = false;
        toggleClass(pin.pin, 'is-dragging', Boolean(pinDrag && pinDrag.moved && pinDrag.id === DRAFT_ID));
      } else if (!pin.pin.hidden) {
        pin.pin.hidden = true;
      }
    } else if (!pin.pin.hidden) {
      pin.pin.hidden = true;
    }
    const parts2 = ensureEditor();
    if (!parts2) return;
    const natural = editorNaturalHeight(parts2);
    const hideLeader = () => {
      setPath(parts.draftLeader, '');
      setPath(parts.draftLeaderUnder, '');
    };
    if (compact) {
      toggleClass(parts2.root, 'is-sheet', true);
      parts2.root.style.transform = '';
      keepTitleInView(parts2, fitEditorSheet(parts2, viewport, resultsBox, natural));
      hideLeader();
      setPanelBehindEditor(false); // the compact panel is covered by the sheet's own rule
      return;
    }
    const size = { w: EDITOR_WIDTH_PX, h: Math.min(natural, Math.max(1, viewport.height - 2 * VIEWPORT_MARGIN)) };
    // A card the owner positioned keeps that spot while its marker is on screen; without a marker on screen (the
    // cargo it sits on is out of view) the card is at the stylesheet's own corner, as it always was.
    const ownerPlaced = Boolean(draft.editorPos) && Boolean(screen);
    let rect;
    if (ownerPlaced) {
      rect = clampRect({ x: draft.editorPos.x, y: draft.editorPos.y, w: size.w, h: size.h }, viewport);
    } else if (screen) {
      const occupied = pinRects.filter(p => p.id !== draft.editId).concat(panelBox || []);
      const auto = autoPlace({ marker: { x: screen.x, y: screen.y }, size, viewport, occupied, previousSlot: draft.slot });
      draft.slot = auto.slot;
      rect = { x: auto.x, y: auto.y, w: auto.w, h: auto.h };
    } else {
      rect = { x: 0, y: 0, w: size.w, h: size.h };
    }
    // The AutoPack Results card can sit anywhere the owner dragged it, and it is drawn above this layer: the
    // card keeps clear of it (display only; the stored position is untouched) so Save, Cancel and the fields stay
    // reachable. With no full-size spot it gives up height, and with no usable spot at all it becomes the sheet.
    // The Annotations panel is drawn above this card as well, so a card that meets it has its fields underneath:
    // automatic placement keeps off the panel and its own marker, relaxing the marker and then the panel (which then
    // yields while the card is open) rather than covering Save. A card the owner positioned only yields to Results.
    const markerBox = screen ? [{ x: screen.x - PIN_RECT_PX / 2, y: screen.y - PIN_RECT_PX / 2, w: PIN_RECT_PX, h: PIN_RECT_PX }] : [];
    const panelRects = panelRectsNow();
    // The toolbar is a hard obstacle like the status button: a card never opens with its header under it.
    const placement = fitEditorClear({ rect, viewport, panel: panelRects, status: statusObstacle().concat(toolbarObstacle()), results: resultsBox, marker: markerBox, controls: controlsObstacle(), ownerPlaced });
    const fit = placement.fit;
    // A panel the owner is dragging stays under their pointer; it yields once it is dropped.
    const panelDragging = Boolean(els.panel && els.panel.classList.contains('is-dragging'));
    if (!fit.clear) {
      toggleClass(parts2.root, 'is-sheet', true);
      parts2.root.style.transform = '';
      keepTitleInView(parts2, fitEditorSheet(parts2, viewport, resultsBox, natural));
      hideLeader();
      const [sheet] = layerRects([parts2.root]);
      setPanelBehindEditor(!panelDragging && Boolean(sheet) && panelRects.some(box => overlapArea(sheet, box) > 0), parts2);
      return;
    }
    setPanelBehindEditor(!panelDragging && placement.coversPanel, parts2);
    toggleClass(parts2.root, 'is-sheet', false);
    keepTitleInView(parts2, resetEditorFit(parts2, fit.shrunk ? fit.h : null));
    rect = { x: fit.x, y: fit.y, w: fit.w, h: fit.h };
    // The stylesheet's corner needs no transform; anything else is a translation from it.
    const transform = !screen && rect.x === 0 && rect.y === 0 ? '' : `translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px)`;
    if (parts2.root.style.transform !== transform) parts2.root.style.transform = transform;
    if (!screen) {
      hideLeader();
      return;
    }
    const line = leaderLine({ x: screen.x, y: screen.y }, rect);
    const d = line ? `M${line.x1.toFixed(1)} ${line.y1.toFixed(1)}L${line.x2.toFixed(1)} ${line.y2.toFixed(1)}` : '';
    setPath(parts.draftLeader, d);
    setPath(parts.draftLeaderUnder, d);
  }

  /** Screen rectangles of `elements` in layer pixels; elements that are absent or not laid out are skipped. */
  function layerRects(elements) {
    const layerRect = els.layer.getBoundingClientRect();
    return elements.filter(Boolean).map(el => el.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => ({ x: rect.left - layerRect.left, y: rect.top - layerRect.top, w: rect.width, h: rect.height }));
  }

  /**
   * The AutoPack Results card (expanded, minimized or dragged anywhere) and its restore button: controls the
   * editor must never cover and cards and labels avoid. Read from the DOM, so it follows the card when it is
   * moved, minimized, closed or the viewport resizes; empty when neither shows. Annotations only look at it.
   */
  function resultsObstacles() {
    if (!els.layer || !doc) return [];
    const restore = doc.getElementById('btn-autopack-results-reopen');
    return layerRects([doc.querySelector('[data-role="autopack-results-panel"]'), restore && !restore.hidden ? restore : null]);
  }

  /**
   * What automatic placement keeps cards, labels and the editor off: the open Annotations panel, the Editor's
   * own "Load plan needs review" button and the AutoPack Results controls, as rectangles in layer pixels.
   * Null when none shows.
   */
  function panelObstacle(resultsBox = resultsObstacles()) {
    if (!els.layer || !doc) return null;
    const found = panelRectsNow().concat(statusObstacle(), resultsBox);
    return found.length ? found : null;
  }

  /** The open Annotations panel's rectangle in layer pixels (empty when it is closed or covered by the compact sheet). A panel yielding to the editor keeps its layout box, so this stays measurable. */
  function panelRectsNow() {
    if (!els.layer || !doc) return [];
    return layerRects([panelOpen && els.panel && !els.panel.hidden ? els.panel : null]);
  }

  /** The viewport control stack (annotations, measurement, camera and zoom buttons) down the right-hand edge. */
  function controlsObstacle() {
    if (!els.layer || !doc) return [];
    const stack = doc.getElementById('editor-zoom-controls');
    return layerRects([stack && !(stack.closest && stack.closest('[hidden]')) ? stack : null]);
  }

  /**
   * The floating Editor toolbar (Cases, AutoPack, ...) across the top of the viewport. It is drawn above this layer, so
   * an editor card or sheet that reaches it has its header underneath; both keep clear of it like the Annotations panel
   * does (the panel's own region starts below it).
   */
  function toolbarObstacle() {
    if (!els.layer || !doc) return [];
    const toolbar = doc.getElementById('viewport-toolbar');
    return layerRects([toolbar && !(toolbar.closest && toolbar.closest('[hidden]')) ? toolbar : null]);
  }

  /** The Editor's "Load plan needs review" button, when it shows. */
  function statusObstacle() {
    if (!els.layer || !doc) return [];
    const status = doc.getElementById('editor-validation-status-btn');
    return layerRects([status && !(status.closest && status.closest('[hidden]')) ? status : null]);
  }

  /**
   * The desktop Annotations panel is drawn above the editor card, so while the card has no room beside it the panel
   * yields: it keeps its place and size (so the placement above stays stable and its saved position is untouched)
   * and is only not painted or clickable until the card closes. Focus that was inside it moves to the card.
   */
  function setPanelBehindEditor(on, editor = null) {
    const yielding = Boolean(on) && !compact;
    if (panelBehindEditor !== yielding) panelBehindEditor = yielding;
    if (!els.panel) return;
    toggleClass(els.panel, 'is-behind-editor', yielding);
    if (yielding && editor && doc && els.panel.contains(doc.activeElement)) editor.title.focus({ preventScroll: true });
  }

  /**
   * The editor card's height if nothing limited it: the card's own chrome plus the full height of its scrolling
   * body. Measured without clearing any height limit, so a card that was shrunk can grow back.
   */
  function editorNaturalHeight(parts) {
    if (!parts.root.offsetHeight) return EDITOR_FALLBACK_HEIGHT_PX;
    return parts.root.offsetHeight - parts.body.clientHeight + parts.body.scrollHeight;
  }

  /**
   * The display-only overrides that keep the panel off the AutoPack Results card; no argument clears them all. The
   * compact panel (a bottom sheet) limits its height and bottom edge; the desktop panel limits its height and shifts.
   * Neither touches the dragged position the owner chose.
   */
  function setPanelFit({ maxHeight = '', bottom = '', limit = '', dx = 0, dy = 0 } = {}) {
    const style = els.panel && els.panel.style;
    if (!style) return;
    if (style.maxHeight !== maxHeight) style.maxHeight = maxHeight;
    if (style.bottom !== bottom) style.bottom = bottom;
    if (style.getPropertyValue(PANEL_LIMIT_PROPERTY) !== limit) {
      if (limit) style.setProperty(PANEL_LIMIT_PROPERTY, limit);
      else style.removeProperty(PANEL_LIMIT_PROPERTY);
    }
    const transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    if (style.transform !== transform) style.transform = transform;
    panelShift = { x: dx, y: dy };
  }

  /**
   * Keeps the open Annotations panel off the AutoPack Results card, wherever either was dragged; the list scrolls
   * before any control is hidden. The compact panel is a bottom sheet like the editor and rides in the largest clear
   * stretch (usually straight above the card). The desktop panel moves to the nearest clear spot, or gives up height
   * where there is none. Nothing is overridden (and nothing measured) while Results is not in the way, and a panel
   * the owner is dragging is left alone until it is released.
   */
  function fitPanel(resultsBox, viewport) {
    const parts = panelParts;
    if (!parts || parts.root !== els.panel || parts.root.classList.contains('is-dragging')) return;
    const shown = panelOpen && !els.panel.hidden && !els.panel.classList.contains('is-covered');
    if (!shown || !resultsBox.length) {
      setPanelFit();
      return;
    }
    if (!compact) {
      applyPanelPosition(); // the dragged place at the natural height, whatever this function limited last frame
      const naturalHeight = panelNaturalHeight();
      const [box] = layerRects([parts.root]);
      if (!naturalHeight || !box) return;
      // Where it would sit unshifted and unlimited: the owner's spot, or the stylesheet's (the measured box less last frame's shift).
      const natural = { x: box.x - panelShift.x, y: box.y - panelShift.y, w: box.w, h: naturalHeight };
      const fit = fitPanelClear({ panel: natural, blockers: resultsBox, viewport });
      setPanelFit(fit.clear ? { limit: fit.maxHeight == null ? '' : `${fit.maxHeight}px`, dx: fit.dx, dy: fit.dy } : {});
      return;
    }
    const rootHeight = parts.root.offsetHeight;
    if (!rootHeight) return;
    const cap = Math.floor(viewport.height * PANEL_SHEET_MAX_FRACTION);
    const fit = fitSheet({ viewport, blockers: resultsBox, height: Math.min(panelContentHeight(parts), cap) });
    setPanelFit(fit.moved ? { maxHeight: `${Math.min(fit.maxHeight, cap)}px`, bottom: `${fit.bottom}px` } : {});
  }

  /** Back to the stylesheet's placement, or (with `height`) the same placement limited to `height` px. True when the limit changed. */
  function resetEditorFit(parts, height = null) {
    const maxHeight = height == null ? '' : `${Math.floor(height)}px`;
    const changed = parts.root.style.maxHeight !== maxHeight || parts.root.style.bottom !== '';
    if (parts.root.style.maxHeight !== maxHeight) parts.root.style.maxHeight = maxHeight;
    if (parts.root.style.bottom !== '') parts.root.style.bottom = '';
    return changed;
  }

  /** The narrow-viewport sheet, moved clear of the Results card and the toolbar and limited in height before any button is hidden. True when it changed. */
  function fitEditorSheet(parts, viewport, resultsBox, natural) {
    const fit = fitSheet({ viewport, blockers: resultsBox.concat(toolbarObstacle()), height: natural });
    const maxHeight = fit.moved ? `${fit.maxHeight}px` : '';
    const bottom = fit.moved ? `${fit.bottom}px` : '';
    const changed = parts.root.style.maxHeight !== maxHeight || parts.root.style.bottom !== bottom;
    if (parts.root.style.maxHeight !== maxHeight) parts.root.style.maxHeight = maxHeight;
    if (parts.root.style.bottom !== bottom) parts.root.style.bottom = bottom;
    return changed;
  }

  /**
   * A card shorter than its content scrolls its body. It opens with the title field in view (not scrolled out
   * below the presets), and keeps it in view when it is squeezed while the title has focus.
   */
  function keepTitleInView(parts, fitChanged) {
    const opened = titleRevealPending;
    titleRevealPending = false;
    if (!opened && !(fitChanged && doc && doc.activeElement === parts.title)) return;
    const body = parts.body;
    if (!body || body.scrollHeight <= body.clientHeight) return;
    const field = (parts.title.closest && parts.title.closest('.tp3d-annot-editor__field')) || parts.title;
    const bodyRect = body.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    if (fieldRect.bottom > bodyRect.bottom || fieldRect.top < bodyRect.top) body.scrollTop += fieldRect.top - bodyRect.top - 4;
  }

  function renderHover(parts, camera, width, height) {
    const show = isActive() && !stroke && hover && hover.world && !(pinDrag && pinDrag.moved) && !blockedReason();
    if (!show) {
      if (parts.keys.hover !== '') {
        parts.keys.hover = '';
        setPath(parts.hoverMark, '');
        setPath(parts.hoverUnder, '');
      }
      if (!parts.tip.hidden) parts.tip.hidden = true;
      return;
    }
    const screen = projectToLayer(hover.world, camera, width, height, scratchScreen);
    if (!screen) {
      if (!parts.tip.hidden) parts.tip.hidden = true;
      return;
    }
    const x = screen.x.toFixed(1);
    const y = screen.y.toFixed(1);
    const key = `${x},${y}`;
    if (parts.keys.hover !== key) {
      parts.keys.hover = key;
      const arm = MARKER_ARM_PX;
      const d = `M${(screen.x - arm).toFixed(1)} ${y}L${(screen.x + arm).toFixed(1)} ${y}M${x} ${(screen.y - arm).toFixed(1)}L${x} ${(screen.y + arm).toFixed(1)}`;
      setPath(parts.hoverMark, d);
      setPath(parts.hoverUnder, d);
    }
    // What a click would attach to, next to the pointer.
    const name = anchorTargetName(hover.anchor);
    setText(parts.tip, name);
    const px = lastClient ? lastClient.x - els.layer.getBoundingClientRect().left : screen.x;
    const py = lastClient ? lastClient.y - els.layer.getBoundingClientRect().top : screen.y;
    const tx = Math.max(4, Math.min(width - 190, px + 14));
    const ty = Math.max(4, Math.min(height - 30, py + 16));
    const transform = `translate(${tx.toFixed(0)}px, ${ty.toFixed(0)}px)`;
    if (parts.tip.style.transform !== transform) parts.tip.style.transform = transform;
    if (parts.tip.hidden) parts.tip.hidden = false;
  }

  /** While a saved marker is dragged: a faint ring where it was. */
  function renderGhost(parts, camera, width, height, entries) {
    const dragged = pinDrag && pinDrag.moved && pinDrag.id !== DRAFT_ID ? pinDrag : null;
    const entry = dragged && !dragged.which ? entries.find(e => e.record.id === dragged.id) : null;
    let shownGhost = false;
    if (dragged && dragged.which) {
      // An arrow end being dragged: a faint ring where that end is saved.
      const index = records.findIndex(record => record.id === dragged.id);
      const record = index === -1 ? null : records[index];
      if (isArrow(record) && liveAnchorWorld(record[dragged.which], results[index][dragged.which], ghostWorld)) {
        const screen = projectToLayer(ghostWorld, camera, width, height, ghostScreen);
        if (screen) {
          parts.ghost.setAttribute('cx', screen.x.toFixed(1));
          parts.ghost.setAttribute('cy', screen.y.toFixed(1));
          shownGhost = true;
        }
      }
    } else if (entry) {
      const index = records.findIndex(record => record.id === entry.record.id);
      if (index !== -1 && liveAnchorWorld(entry.record.anchor, results[index].point, ghostWorld)) {
        const screen = projectToLayer(ghostWorld, camera, width, height, ghostScreen);
        if (screen) {
          parts.ghost.setAttribute('cx', screen.x.toFixed(1));
          parts.ghost.setAttribute('cy', screen.y.toFixed(1));
          shownGhost = true;
        }
      }
    }
    parts.ghost.style.display = shownGhost ? '' : 'none';
  }

  // ==========================================================================
  // SECTION: PUBLIC API
  // ==========================================================================
  return {
    bind,
    sync,
    destroy,
    openPanel,
    closePanel,
    togglePanel,
    syncVisibility,
    isPanelOpen: () => panelOpen,
    releaseForMeasurement,
    settle,
    isActive,
    hasDraft: () => Boolean(draft),
    // 'off' | 'armed' | 'move' | 'stroking' | 'frozen': read-only, for the Editor and tests.
    // Read-only, for the Editor's interaction routing: while true, cargo is never selected, dragged, highlighted or edited from the viewport.
    drawingState: () => (stroke ? stroke.phase : (tool === 'draw' ? (drawView === 'move' ? 'move' : 'armed') : 'off')),
    // 'idle' | 'pressed' (a press on a saved drawing, not yet a drag) | 'moving' | 'blocked' (carried to a place it cannot take): read-only, for tests.
    moveState: () => (moveDrag ? (moveDrag.moved ? (moveDrag.valid ? 'moving' : 'blocked') : 'pressed') : 'idle'),
    selectedId: () => selectedId,
    // For the Editor's canvas routing: does a saved drawing's line take this press, is this the pointer it holds, is the pointer over a line.
    claimPress,
    ownsPointer,
    hoverDrawing,
    // A saved Arrow has no pointer target of its own: the Editor asks which one a click is on, then selects it.
    arrowHitAt,
    select,
    onPointerDown,
    onPointerMove,
    onPointerCancel,
    onPointerUp,
    onDoubleClick,
  };
}
