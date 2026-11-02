/**
 * @file normalizer.js
 * @description Normalization helpers to keep stored data and preferences safe and compatible.
 * @module core/normalizer
 * @created Unknown
 * @updated 01/22/2026
 * @author Truck Packer 3D Team
 */

// ============================================================================
// SECTION: IMPORTS AND DEPENDENCIES
// ============================================================================

import * as CoreUtils from './utils/index.js';
import * as CoreDefaults from './defaults.js';
import { uuid } from './browser.js';
import {
  getActualPoseDimensions,
} from './oriented-dims.js';
import {
  canonicalCargoForStorage,
  pickSafeExtensions,
  CANONICAL_CASE_KEYS,
  DIMENSION_MAX_INCHES,
  parseCargoNotes,
} from './cargo-canonical.js';
import {
  assertBusinessIdentityValue,
  assertItemCodeAvailable,
  migrateLoadPlanNumbers,
} from './business-identity.js';
import { canonicalizeInstanceIds, carryMeasurementsThroughIdentity } from './measurements.js';
import { carryAnnotationsThroughIdentity } from './annotations.js';

const DEFAULT_TRUCK = { length: 636, width: 102, height: 98 };
const EDITOR_VIEW_PRECISION = 1000;

// Editor-internal markers that may ride along on a truck object but are never
// truck data. `__packId` scopes the Editor's pending (uncommitted) truck.
export const INTERNAL_TRUCK_KEYS = Object.freeze(['__packId']);

/**
 * Remove only the known internal markers from a truck. Every other truck field
 * is kept; the same object is returned when there is nothing to remove.
 * @template T
 * @param {T} truck
 * @returns {T}
 */
export function stripInternalTruckFields(truck) {
  if (!truck || typeof truck !== 'object' || Array.isArray(truck)) return truck;
  if (!INTERNAL_TRUCK_KEYS.some(key => Object.prototype.hasOwnProperty.call(truck, key))) return truck;
  const next = { ...truck };
  INTERNAL_TRUCK_KEYS.forEach(key => { delete next[key]; });
  return next;
}

// A blank or missing sequence is "no sequence", never 0 (Number(null) === 0).
function normalizeDeliverySequence(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Pack presentation only: reject partial or nonfinite camera poses. */
export function normalizeEditorView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const vector = source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const result = {};
    for (const axis of ['x', 'y', 'z']) {
      if (typeof source[axis] !== 'number' || !Number.isFinite(source[axis])) return null;
      const rounded = Math.round(source[axis] * EDITOR_VIEW_PRECISION) / EDITOR_VIEW_PRECISION;
      if (!Number.isFinite(rounded)) return null;
      result[axis] = Object.is(rounded, -0) ? 0 : rounded;
    }
    return result;
  };
  const cameraPosition = vector(value.cameraPosition);
  const target = vector(value.target);
  if (!cameraPosition || !target) return null;
  const distanceSquared = ['x', 'y', 'z'].reduce((sum, axis) =>
    sum + (cameraPosition[axis] - target[axis]) ** 2, 0);
  if (!(distanceSquared > 0.000001) || !Number.isFinite(distanceSquared)) return null;
  const view = { cameraPosition, target };
  if (Object.hasOwn(value, 'projection')) {
    view.projection = value.projection === 'orthographic' ? 'orthographic' : 'perspective';
  }
  if (view.projection === 'orthographic') {
    view.zoom = typeof value.zoom === 'number' && Number.isFinite(value.zoom) &&
      value.zoom >= 0.05 && value.zoom <= 50
      ? Math.round(value.zoom * EDITOR_VIEW_PRECISION) / EDITOR_VIEW_PRECISION : 1;
  }
  return view;
}

export function editorViewSignature(value) {
  const view = normalizeEditorView(value);
  return view ? JSON.stringify([view.cameraPosition.x, view.cameraPosition.y, view.cameraPosition.z,
    view.target.x, view.target.y, view.target.z,
    ...(view.projection === 'orthographic' ? ['orthographic', view.zoom] : [])]) : null;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = finiteNumber(value, fallback);
  return n > 0 ? n : fallback;
}

function safeString(value, fallback = '') {
  const s = value == null ? '' : String(value);
  const t = s.trim();
  return t || fallback;
}

function safeId(value) {
  return safeString(value, '') || uuid();
}

/**
 * Compatibility-only cleanup for retired quantity and validation-certification fields.
 * Legacy files remain importable, but the obsolete field is never interpreted,
 * converted into physical instances, or allowed back across a save/export boundary.
 * @param {Record<string, any>} pack
 * @returns {Record<string, any>}
 */
export function sanitizeLegacyPackQuantityFields(pack) {
  const source = pack && typeof pack === 'object' && !Array.isArray(pack) ? pack : {};
  if (!Object.hasOwn(source, 'caseRequirements') && !Object.hasOwn(source, 'handlingRulesValidatedSignature')) return source;
  const next = { ...source };
  delete next.caseRequirements;
  delete next.handlingRulesValidatedSignature;
  return next;
}

/**
 * @param {unknown} packLibrary
 * @returns {{ packLibrary: any[], changed: boolean }}
 */
export function sanitizeLegacyPackQuantityLibrary(packLibrary) {
  let changed = false;
  const packs = Array.isArray(packLibrary) ? packLibrary : [];
  const sanitized = packs.map(pack => {
    const next = sanitizeLegacyPackQuantityFields(pack);
    if (next !== pack) changed = true;
    return next;
  });
  return { packLibrary: sanitized, changed };
}

function normalizeOrientedDims(value) {
  const dims = value && typeof value === 'object' ? value : {};
  const length = positiveNumber(dims.length, 0);
  const width = positiveNumber(dims.width, 0);
  const height = positiveNumber(dims.height, 0);
  if (!length || !width || !height) return null;
  return { length, width, height };
}

export function normalizePreferences(prefs) {
  const base = CoreUtils.deepClone(CoreDefaults.defaultPreferences);
  const next = { ...base, ...(prefs && typeof prefs === 'object' ? prefs : {}) };
  next.packsViewMode = next.packsViewMode === 'list' ? 'list' : 'grid';
  next.casesViewMode = next.casesViewMode === 'grid' ? 'grid' : 'list';
  next.packsFiltersVisible = next.packsFiltersVisible !== false;
  next.casesFiltersVisible = next.casesFiltersVisible !== false;
  const baseBadges = base.gridCardBadges || {};
  const inBadges = next.gridCardBadges && typeof next.gridCardBadges === 'object' ? next.gridCardBadges : {};
  const inPacks = inBadges.packs && typeof inBadges.packs === 'object' ? inBadges.packs : {};
  const inCases = inBadges.cases && typeof inBadges.cases === 'object' ? inBadges.cases : {};
  const basePacks = baseBadges.packs && typeof baseBadges.packs === 'object' ? baseBadges.packs : {};
  const baseCases = baseBadges.cases && typeof baseBadges.cases === 'object' ? baseBadges.cases : {};
  next.gridCardBadges = {
    packs: {
      ...basePacks,
      ...inPacks,
    },
    cases: {
      ...baseCases,
      ...inCases,
    },
  };
  const hasLegacyStatLine = Object.prototype.hasOwnProperty.call(inPacks, 'showPackedStatLine');
  const hasNewPacked = Object.prototype.hasOwnProperty.call(inPacks, 'showPacked');
  const hasNewVolume = Object.prototype.hasOwnProperty.call(inPacks, 'showVolume');
  const hasNewWeight = Object.prototype.hasOwnProperty.call(inPacks, 'showWeight');
  const hasLegacyTrailerMode = Object.prototype.hasOwnProperty.call(inPacks, 'showTrailerMode');
  const hasShapeMode = Object.prototype.hasOwnProperty.call(inPacks, 'showShapeMode');
  if (hasLegacyStatLine && !hasNewPacked && !hasNewVolume && !hasNewWeight) {
    const legacy = inPacks.showPackedStatLine !== false;
    next.gridCardBadges.packs.showPacked = legacy;
    next.gridCardBadges.packs.showVolume = legacy;
    next.gridCardBadges.packs.showWeight = legacy;
  }
  if (hasLegacyTrailerMode && !hasShapeMode) {
    next.gridCardBadges.packs.showShapeMode = inPacks.showTrailerMode !== false;
  }
  // Cases Qty replaces the separate "Cases Count" and "Packed" Card Display
  // options. Compatibility rule: if the user has not yet saved an explicit
  // showCasesQty preference, derive its initial value from BOTH legacy flags
  // so a user who had hidden either the old count or the old packed value
  // does not suddenly see the consolidated Cases Qty reappear. Once
  // showCasesQty is saved, it is the sole source of truth and legacy keys are
  // no longer consulted.
  const hasNewCasesQty = Object.prototype.hasOwnProperty.call(inPacks, 'showCasesQty');
  if (!hasNewCasesQty) {
    const legacyCasesCount = inPacks.showCasesCount !== false;
    const legacyPacked = inPacks.showPacked !== false;
    next.gridCardBadges.packs.showCasesQty = legacyCasesCount && legacyPacked;
  }
  next.gridCardBadges.packs.showCasesQty = next.gridCardBadges.packs.showCasesQty !== false;
  next.gridCardBadges.packs.showLoadPlanNumber = next.gridCardBadges.packs.showLoadPlanNumber !== false;
  next.gridCardBadges.packs.showCustomerReference = next.gridCardBadges.packs.showCustomerReference !== false;
  next.gridCardBadges.packs.showNotes = next.gridCardBadges.packs.showNotes !== false;
  next.gridCardBadges.packs.showCasesCount = next.gridCardBadges.packs.showCasesCount !== false;
  next.gridCardBadges.packs.showTruckDims = next.gridCardBadges.packs.showTruckDims !== false;
  next.gridCardBadges.packs.showThumbnail = next.gridCardBadges.packs.showThumbnail !== false;
  next.gridCardBadges.packs.showShapeMode = next.gridCardBadges.packs.showShapeMode !== false;
  next.gridCardBadges.packs.showPacked = next.gridCardBadges.packs.showPacked !== false;
  next.gridCardBadges.packs.showVolume = next.gridCardBadges.packs.showVolume !== false;
  next.gridCardBadges.packs.showWeight = next.gridCardBadges.packs.showWeight !== false;
  next.gridCardBadges.packs.showEditedTime = next.gridCardBadges.packs.showEditedTime !== false;
  next.gridCardBadges.cases.showItemCode = next.gridCardBadges.cases.showItemCode !== false;
  next.gridCardBadges.cases.showManufacturer = next.gridCardBadges.cases.showManufacturer !== false;
  next.gridCardBadges.cases.showCategory = next.gridCardBadges.cases.showCategory !== false;
  next.gridCardBadges.cases.showDims = next.gridCardBadges.cases.showDims !== false;
  next.gridCardBadges.cases.showVolume = next.gridCardBadges.cases.showVolume !== false;
  next.gridCardBadges.cases.showWeight = next.gridCardBadges.cases.showWeight !== false;
  next.gridCardBadges.cases.showFlip = next.gridCardBadges.cases.showFlip !== false;
  next.gridCardBadges.cases.showHandling = next.gridCardBadges.cases.showHandling !== false;
  next.gridCardBadges.cases.showNotes = next.gridCardBadges.cases.showNotes !== false;
  next.gridCardBadges.cases.showEditedTime = next.gridCardBadges.cases.showEditedTime !== false;
  // Workspace-wide physical Quantity chip/column (derived, never persisted itself).
  next.gridCardBadges.cases.showQuantity = next.gridCardBadges.cases.showQuantity !== false;
  next.units = next.units && typeof next.units === 'object' ? next.units : base.units;
  next.units.length = CoreUtils.lengthUnits.includes(next.units.length) ? next.units.length : base.units.length;
  next.units.weight = CoreUtils.weightUnits.includes(next.units.weight) ? next.units.weight : base.units.weight;
  next.theme = next.theme === 'dark' ? 'dark' : 'light';
  const quality = safeString(next.renderQuality, base.renderQuality).toLowerCase();
  next.renderQuality = ['low', 'medium', 'high', 'auto'].includes(quality) ? quality : base.renderQuality;
  next.showLabels = next.showLabels !== false;
  next.showShadows = next.showShadows !== false;
  next.showBevels = next.showBevels !== false;
  next.showCameraControls = next.showCameraControls !== false;
  next.showZoomControls = next.showZoomControls !== false;
  next.showAnnotations = next.showAnnotations !== false;
  next.showMeasurementTool = next.showMeasurementTool !== false;
  next.labelFontSize = CoreUtils.clamp(finiteNumber(next.labelFontSize, base.labelFontSize), 8, 24);
  next.hiddenCaseOpacity = CoreUtils.clamp(finiteNumber(next.hiddenCaseOpacity, base.hiddenCaseOpacity), 0, 1);
  next.showAutoPackLoadingOverlay = next.showAutoPackLoadingOverlay !== false;
  next.autoPackResultsStartView = CoreDefaults.AUTOPACK_RESULTS_START_VIEWS.includes(next.autoPackResultsStartView)
    ? next.autoPackResultsStartView
    : base.autoPackResultsStartView;
  const incomingSpaceUtilization = next.spaceUtilization && typeof next.spaceUtilization === 'object'
    ? next.spaceUtilization
    : {};
  const incomingGaugePosition = incomingSpaceUtilization.position && typeof incomingSpaceUtilization.position === 'object'
    ? incomingSpaceUtilization.position
    : {};
  const customX = Number(incomingGaugePosition.x);
  const customY = Number(incomingGaugePosition.y);
  const hasCustomPosition = incomingGaugePosition.mode === 'custom' && Number.isFinite(customX) && Number.isFinite(customY);
  next.spaceUtilization = {
    showGauge: incomingSpaceUtilization.showGauge === true,
    style: incomingSpaceUtilization.style === 'arc' ? 'arc' : 'spatial',
    detail: incomingSpaceUtilization.detail === 'standard' ? 'standard' : 'minimal',
    position: hasCustomPosition
      ? {
          mode: 'custom',
          x: CoreUtils.clamp(customX, 0, 1),
          y: CoreUtils.clamp(customY, 0, 1),
        }
      : { ...base.spaceUtilization.position },
  };
  next.snapping = next.snapping && typeof next.snapping === 'object' ? next.snapping : base.snapping;
  next.snapping.enabled = Boolean(next.snapping.enabled);
  next.snapping.gridSize = Math.max(0.25, finiteNumber(next.snapping.gridSize, base.snapping.gridSize));
  next.camera = next.camera && typeof next.camera === 'object' ? next.camera : base.camera;
  next.camera.defaultView = next.camera.defaultView === 'orthographic' ? 'orthographic' : 'perspective';
  next.export = next.export && typeof next.export === 'object' ? next.export : base.export;
  const screenshotResolution = safeString(next.export.screenshotResolution, '');
  next.export.screenshotResolution = CoreDefaults.SCREENSHOT_RESOLUTIONS.includes(screenshotResolution)
    ? screenshotResolution
    : base.export.screenshotResolution;
  next.export.pdfIncludeStats = Boolean(next.export.pdfIncludeStats);
  const normalizeCatKey = key =>
    String(key || '')
      .trim()
      .toLowerCase();
  const prefCats = Array.isArray(next.categories) ? next.categories : base.categories;
  next.categories = (prefCats || [])
    .map(c => ({
      key: normalizeCatKey(c.key || c.name),
      name: safeString(c.name, c.key || ''),
      color: safeString(c.color, ''),
    }))
    .filter(c => c.key);
  if (!next.categories.length) {
    next.categories = (CoreDefaults.categories || [])
      .filter(c => c.key !== 'all')
      .map(c => ({ key: c.key, name: c.name, color: c.color }));
  }
  return next;
}

export function normalizeCase(c, now = Date.now()) {
  const createdAt = finiteNumber(c && c.createdAt, now);
  const updatedAt = finiteNumber(c && c.updatedAt, now);
  const dims = c && c.dimensions && typeof c.dimensions === 'object' ? c.dimensions : {};
  // Apply the data-sanity dimension cap so absurd values can never yield an
  // infinite volume.
  const length = Math.min(DIMENSION_MAX_INCHES, positiveNumber(dims.length, 48));
  const width = Math.min(DIMENSION_MAX_INCHES, positiveNumber(dims.width, 24));
  const height = Math.min(DIMENSION_MAX_INCHES, positiveNumber(dims.height, 24));
  const hazmatRaw = safeString(c && c.hazmatClass, '');
  const hazmatClass = hazmatRaw ? hazmatRaw : null;
  const category = safeString(c && c.category, 'default').toLowerCase();
  const color = safeString(c && c.color, '');
  // Typed canonical handling-rule fields from the single shared representation.
  const cargo = canonicalCargoForStorage(c);
  const normalizedCase = {
    id: safeId(c && c.id),
    name: safeString(c && c.name, 'Unnamed Case'),
    itemCode: assertBusinessIdentityValue(c && c.itemCode, {
      field: 'itemCode',
      required: false,
    }),
    manufacturer: safeString(c && c.manufacturer, ''),
    category,
    dimensions: { length, width, height },
    weight: cargo.weight,
    volume: CoreUtils.volumeInCubicInches({ length, width, height }),
    shape: cargo.shape,
    stackable: cargo.stackable,
    maxStackCount: cargo.maxStackCount,
    orientationLock: cargo.orientationLock,
    noStackOnTop: cargo.noStackOnTop,
    isPallet: cargo.isPallet,
    maxPalletWeight: cargo.maxPalletWeight,
    hazmatClass,
    laneItem: cargo.laneItem,
    loadPriority: cargo.loadPriority,
    mustLoadLast: cargo.mustLoadLast,
    mustUnloadFirst: cargo.mustUnloadFirst,
    stopGroup: safeString(c && c.stopGroup, ''),
    keepTogetherGroup: safeString(c && c.keepTogetherGroup, ''),
    notes: cargo.notes,
    color,
    createdAt,
    updatedAt,
  };
  // Preserve approved safe unknown metadata (incl. the pack-import idempotence
  // fingerprint importSourceKey) so extensions survive App Backup and Workspace
  // normalization. Prototype keys, functions and non-finite values are dropped.
  return { ...pickSafeExtensions(c, CANONICAL_CASE_KEYS), ...normalizedCase };
}

export function normalizeTruck(truck) {
  const t = truck && typeof truck === 'object' ? truck : {};
  const mode =
    t.shapeMode === 'wheelWells' || t.shapeMode === 'frontBonus' || t.shapeMode === 'rect' ? t.shapeMode : 'rect';
  const shapeConfig =
    t.shapeConfig && typeof t.shapeConfig === 'object' && !Array.isArray(t.shapeConfig) ? t.shapeConfig : {};
  return {
    length: positiveNumber(t.length, DEFAULT_TRUCK.length),
    width: positiveNumber(t.width, DEFAULT_TRUCK.width),
    height: positiveNumber(t.height, DEFAULT_TRUCK.height),
    shapeMode: mode,
    shapeConfig,
  };
}

export function normalizeInstance(inst, caseMap) {
  const transform = inst && inst.transform && typeof inst.transform === 'object' ? inst.transform : {};
  const pos = transform.position && typeof transform.position === 'object' ? transform.position : {};
  const rot = transform.rotation && typeof transform.rotation === 'object' ? transform.rotation : { x: 0, y: 0, z: 0 };
  const scale = transform.scale && typeof transform.scale === 'object' ? transform.scale : { x: 1, y: 1, z: 1 };
  const caseId = safeString(inst && inst.caseId, '');
  const caseData = caseMap.get(caseId) || null;
  const orientationLocked = inst && inst.orientationLocked === true;
  const placement =
    inst && (inst.placement === 'packed' || inst.placement === 'staged') ? inst.placement : null;
  const packedProfile =
    placement === 'packed' && inst && inst.packedProfile === 'max-capacity'
      ? 'max-capacity'
      : null;
  // Exact AutoPack intent is preserved independently of the actual pose. Never
  // fabricate a missing target or quantize malformed planning data into one.
  const target = inst && inst.lockedRotation;
  const lockedRotation = orientationLocked
    ? (Array.isArray(target) ? [...target] : target && typeof target === 'object' ? { ...target } : (target ?? null))
    : null;
  const actualDims = getActualPoseDimensions(caseData, { transform: { rotation: rot } });
  const isIdentityRotation = rot.x === 0 && rot.y === 0 && rot.z === 0;
  // The cache follows actual Case geometry only. Missing definitions retain a
  // valid saved cache for diagnosis; targets and solver provenance never drive it.
  const orientedDims = caseData
    ? (actualDims.valid && !isIdentityRotation ? actualDims.value : null)
    : normalizeOrientedDims(inst && inst.orientedDims);
  const deliverySequence = normalizeDeliverySequence(inst && inst.deliverySequence);
  return {
    id: safeId(inst && inst.id),
    caseId,
    transform: {
      position: {
        x: typeof pos.x === 'number' && Number.isFinite(pos.x) ? pos.x : null,
        y: typeof pos.y === 'number' && Number.isFinite(pos.y) ? pos.y : null,
        z: typeof pos.z === 'number' && Number.isFinite(pos.z) ? pos.z : null,
      },
      rotation: {
        x: finiteNumber(rot.x, 0),
        y: finiteNumber(rot.y, 0),
        z: finiteNumber(rot.z, 0),
      },
      scale: {
        x: finiteNumber(scale.x, 1),
        y: finiteNumber(scale.y, 1),
        z: finiteNumber(scale.z, 1),
      },
    },
    hidden: Boolean(inst && inst.hidden),
    groupId: inst && inst.groupId != null ? inst.groupId : null,
    orientationLocked,
    lockedRotation,
    orientedDims,
    deliverySequence,
    placement,
    instanceNotes: parseCargoNotes(inst && inst.instanceNotes),
    ...(packedProfile ? { packedProfile } : {}),
  };
}

export function normalizeFolder(folder, now) {
  const source = folder && typeof folder === 'object' ? folder : {};
  const createdAt = finiteNumber(source.createdAt, now);
  const updatedAt = finiteNumber(source.updatedAt, createdAt);
  return {
    id: safeId(source.id),
    name: safeString(source.name, 'Untitled Folder'),
    scope: 'pack',
    parentFolderId: null,
    sortOrder: Math.max(0, Math.trunc(finiteNumber(source.sortOrder, 0))),
    createdAt,
    updatedAt,
  };
}

// A repeated Folder id keeps its first holder; every later holder gets a new id.
function dedupeFolderIds(folders) {
  const seenFolderIds = new Set();
  folders.forEach(folder => {
    if (!seenFolderIds.has(folder.id)) {
      seenFolderIds.add(folder.id);
      return;
    }
    folder.id = uuid();
    seenFolderIds.add(folder.id);
  });
  return folders;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A Folder id the app can act on: a string with no surrounding blanks (the shape every id the app mints has).
function folderRecordId(folder) {
  return isRecord(folder) && typeof folder.id === 'string' && folder.id !== '' && folder.id === folder.id.trim()
    ? folder.id
    : '';
}

// The first field-level problem the strict Workspace Backup validator would reject, or ''.
function folderFieldProblem(folder) {
  if (typeof folder.name !== 'string' || !folder.name.trim()) return 'invalid-name';
  if (folder.scope != null && folder.scope !== 'pack') return 'invalid-scope';
  if (folder.parentFolderId != null && String(folder.parentFolderId).trim()) return 'nested';
  if (folder.sortOrder != null && !(Number.isInteger(folder.sortOrder) && folder.sortOrder >= 0)) return 'invalid-sort-order';
  if (['createdAt', 'updatedAt'].some(key => folder[key] != null && !Number.isFinite(folder[key]))) return 'invalid-timestamp';
  return '';
}

/**
 * Read-only check of the Folder graph exactly as a workspace holds it. It applies the rules the strict Workspace
 * Backup validator enforces (unique non-blank ids, flat Folders, every Load Plan folderId resolves) but reports
 * instead of throwing, and it never changes, drops or repairs anything.
 *  - `folders`: the records the Folder UI may show and act on (same objects, unique valid ids).
 *  - `issues`: damaged records `{ index, kind, id? }`. A record with a field problem stays usable; a non-object,
 *    an invalid id or a repeated id does not, because acting on it could hit the wrong record.
 *  - `unresolved`: Load Plans whose folderId matches no usable Folder, `{ packId, folderId, reason }`
 *    with reason `missing | ambiguous | invalid`.
 * @param {unknown} folderLibrary
 * @param {unknown} packLibrary
 */
export function inspectFolderGraph(folderLibrary, packLibrary) {
  const records = Array.isArray(folderLibrary) ? folderLibrary : [];
  const packs = Array.isArray(packLibrary) ? packLibrary : [];
  const idCounts = new Map();
  records.forEach(record => {
    const id = folderRecordId(record);
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  });

  const folders = [];
  const issues = [];
  const ambiguousIds = new Set();
  records.forEach((record, index) => {
    if (!isRecord(record)) {
      issues.push({ index, kind: 'not-a-record' });
      return;
    }
    const id = folderRecordId(record);
    if (!id) {
      issues.push({ index, kind: 'invalid-id' });
      return;
    }
    if (idCounts.get(id) > 1) {
      ambiguousIds.add(id);
      issues.push({ index, kind: 'duplicate-id', id });
      return;
    }
    const problem = folderFieldProblem(record);
    if (problem) issues.push({ index, kind: problem, id });
    folders.push(record);
  });

  const usableIds = new Set(folders.map(folder => folder.id));
  const unresolved = [];
  packs.forEach(pack => {
    if (!isRecord(pack)) return;
    const ref = pack.folderId;
    if (ref == null || (typeof ref === 'string' && !ref.trim())) return;
    if (typeof ref === 'string' && usableIds.has(ref)) return;
    unresolved.push({
      packId: pack.id,
      folderId: ref,
      reason: typeof ref !== 'string' ? 'invalid' : ambiguousIds.has(ref) ? 'ambiguous' : 'missing',
    });
  });

  return {
    folders,
    issues,
    ambiguousIds: Array.from(ambiguousIds),
    unresolved,
    clean: issues.length === 0 && unresolved.length === 0,
  };
}

/**
 * The explicit repair for a damaged Folder graph, built from the same rules Workspace Backup restore applies
 * (normalizeFolder, a repeated id keeps its first holder, a Load Plan that points nowhere becomes Unfiled).
 * Records that are not objects hold no data and are left out; every other record survives. A repeated id cannot
 * say which of its Folders a Load Plan belonged to, so every Load Plan that points at one is moved to Unfiled
 * rather than given to whichever Folder comes first (the result never depends on record order). Load Plans are
 * returned unchanged (same objects) unless their folderId had to be cleared, and `lastEdited` is never touched.
 * Callers must have preserved the original graph first; this function itself never writes anywhere.
 */
export function repairFolderGraph(folderLibrary, packLibrary, now = Date.now()) {
  const records = Array.isArray(folderLibrary) ? folderLibrary : [];
  const packs = Array.isArray(packLibrary) ? packLibrary : [];
  const normalized = records.filter(isRecord).map(record => normalizeFolder(record, now));
  // Counted before dedupeFolderIds re-ids anything: an id more than one record holds is ambiguous.
  const claimedIds = new Set();
  const ambiguousIds = new Set();
  normalized.forEach(folder => (claimedIds.has(folder.id) ? ambiguousIds : claimedIds).add(folder.id));
  const folders = dedupeFolderIds(normalized);
  const folderIds = new Set(folders.map(folder => folder.id));
  const packLibraryNext = packs.map(pack => {
    if (!isRecord(pack) || pack.folderId == null) return pack;
    if (
      typeof pack.folderId === 'string' &&
      !ambiguousIds.has(pack.folderId) &&
      (folderIds.has(pack.folderId) || !pack.folderId.trim())
    ) {
      return pack;
    }
    return { ...pack, folderId: null };
  });
  return { folderLibrary: folders, packLibrary: packLibraryNext };
}

export function normalizePack(p, caseMap = new Map(), now = Date.now()) {
  const truck = normalizeTruck(p && p.truck);
  const rawCases = Array.isArray(p && p.cases) ? p.cases : [];
  const normalizedCases = rawCases.map(raw => normalizeInstance(raw, caseMap));
  const survives = normalizedCases.map(normalized => Boolean(normalized.caseId));
  // One identity policy for cargo instance IDs (core/measurements.js canonicalizeInstanceIds). It judges
  // ambiguity on EVERY source instance, including the ones the filter below discards, so removing a
  // conflicting instance can never make an ambiguous measurement reference resolve on the survivor.
  const identity = canonicalizeInstanceIds(rawCases.map(raw => raw && raw.id), uuid, survives);
  const instances = normalizedCases
    .map((normalized, index) => ({ ...normalized, id: identity.ids[index] }))
    .filter((_, index) => survives[index]);
  const folderId = safeString(p && p.folderId, '') || null;
  const thumbnail = typeof (p && p.thumbnail) === 'string' ? p.thumbnail : null;
  const thumbnailUpdatedAt = Number.isFinite(p && p.thumbnailUpdatedAt) ? p.thumbnailUpdatedAt : null;
  const thumbnailSource =
    p && (p.thumbnailSource === 'auto' || p.thumbnailSource === 'manual') ? p.thumbnailSource : null;
  const baseStats = {
    totalCases: 0,
    hiddenCases: 0,
    packedCases: 0,
    volumeUsed: 0,
    volumePercent: 0,
    totalWeight: 0,
    cog: null,
    oogWarnings: [],
    palletWarnings: [],
  };
  const stats = p && p.stats && typeof p.stats === 'object' ? { ...baseStats, ...p.stats } : baseStats;
  const migrated = migrateLoadPlanNumbers([p]).packLibrary[0];
  return {
    id: safeId(p && p.id),
    title: safeString(p && p.title, 'Untitled Load Plan'),
    loadPlanNumber: assertBusinessIdentityValue(migrated.loadPlanNumber, {
      field: 'loadPlanNumber',
      required: true,
    }),
    customerReference: assertBusinessIdentityValue(p && p.customerReference, {
      field: 'customerReference',
      required: false,
    }),
    client: safeString(p && p.client, ''),
    projectName: safeString(p && p.projectName, ''),
    drawnBy: safeString(p && p.drawnBy, ''),
    notes: safeString(p && p.notes, ''),
    truck,
    cases: instances,
    folderId,
    groups: Array.isArray(p && p.groups) ? p.groups : [],
    stats,
    createdAt: finiteNumber(p && p.createdAt, now),
    lastEdited: finiteNumber(p && p.lastEdited, now),
    thumbnail,
    thumbnailUpdatedAt,
    thumbnailSource,
    thumbnailRenderVersion: Number.isSafeInteger(p?.thumbnailRenderVersion) && p.thumbnailRenderVersion > 0
      ? p.thumbnailRenderVersion : null,
    thumbnailVisualSignature: typeof p?.thumbnailVisualSignature === 'string' && p.thumbnailVisualSignature
      ? p.thumbnailVisualSignature : null,
    thumbnailViewSignature: typeof p?.thumbnailViewSignature === 'string' && p.thumbnailViewSignature
      ? p.thumbnailViewSignature : null,
    editorView: normalizeEditorView(p?.editorView),
    // Explicit field: this function is a whitelist, so a missing entry would silently drop the
    // collection on restore/import. Older plans become []; unreadable records are wrapped
    // verbatim (never dropped) so the original data survives and is surfaced for recovery.
    measurements: carryMeasurementsThroughIdentity(p?.measurements, identity),
    // Same rule for Annotations: an explicit field (the function is a whitelist), older plans become [],
    // unreadable records are kept verbatim, and anchors follow the one cargo identity decision above.
    annotations: carryAnnotationsThroughIdentity(p?.annotations, identity),
  };
}

export function normalizeAppData(data) {
  const now = Date.now();
  const rawFolders = Array.isArray(data && data.folderLibrary) ? data.folderLibrary : [];
  const folders = dedupeFolderIds(rawFolders.map(folder => normalizeFolder(folder, now)));
  const folderIds = new Set(folders.map(folder => folder.id));

  const rawCases = Array.isArray(data && data.caseLibrary) ? data.caseLibrary : [];
  const cases = [];
  rawCases.forEach(rawCase => {
    const normalizedCase = normalizeCase(rawCase, now);
    normalizedCase.itemCode = assertItemCodeAvailable(normalizedCase.itemCode, cases);
    cases.push(normalizedCase);
  });

  const seenCaseIds = new Set();
  cases.forEach(c => {
    if (!seenCaseIds.has(c.id)) {
      seenCaseIds.add(c.id);
      return;
    }
    c.id = uuid();
  });
  const caseMap = new Map(cases.map(c => [c.id, c]));

  const rawPacks = Array.isArray(data && data.packLibrary) ? data.packLibrary : [];
  const migratedPacks = migrateLoadPlanNumbers(rawPacks).packLibrary;
  const packs = migratedPacks.map(p => {
    const pack = normalizePack(p, caseMap, now);
    if (pack.folderId && !folderIds.has(pack.folderId)) pack.folderId = null;
    return pack;
  });

  const prefs = normalizePreferences(data && data.preferences);
  const currentPackId = safeString(data && data.currentPackId, '');
  const current = packs.some(p => p.id === currentPackId) ? currentPackId : packs[0] ? packs[0].id : null;

  return { caseLibrary: cases, packLibrary: packs, folderLibrary: folders, preferences: prefs, currentPackId: current };
}
