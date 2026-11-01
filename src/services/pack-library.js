/**
 * @file pack-library.js
 * @description UI-free service module for pack library operations and state updates.
 * @module services/pack-library
 * @created Unknown
 * @updated 01/22/2026
 * @author Truck Packer 3D Team
 */

// ============================================================================
// SECTION: IMPORTS AND DEPENDENCIES
// ============================================================================

import * as StateStore from '../core/state-store.js';
import { assessCommittedPack } from './pack-assessment.js';
export { assessCommittedPack } from './pack-assessment.js';
import * as Utils from '../core/utils/index.js';
import * as CoreNormalizer from '../core/normalizer.js';
import * as CoreMeasurements from '../core/measurements.js';
import * as CoreAnnotations from '../core/annotations.js';
import { validatePortableCasePhysicalFields } from '../core/import-schema.js';
import * as CaseLibrary from './case-library.js';
import * as CategoryService from './category-service.js';
import { TrailerPresets } from '../data/trailer-presets.js';
import { canonicalOrientationLock, isCasePhysicalOrientationAllowed } from '../core/orientation.js';
import {
  normalizeRightAngleRotation,
  getOrientedDimsForRotation,
  getActualPoseDimensions,
  getPhysicalOrientationAxes,
} from '../core/oriented-dims.js';
import {
  caseSafeReuseKey,
  caseSafeReuseEqual,
  parseCargoDimension,
  parseCaseMass,
  isCanonicalCaseMass,
} from '../core/cargo-canonical.js';
// Hard-rule predicates and tolerances come from the single validation authority
// shared with the AutoPack solver (packing-core/validation.js), so manual
// revalidation and AutoPack can never silently diverge on a rule or epsilon.
// Imported directly (not via packing-core/index.js) to keep the graph cycle-free.
import {
  CONTAINMENT_EPS_INCHES,
  PLACEMENT_EPS,
  MIN_SUPPORT_FRACTION,
  aabbsOverlap as validationAabbsOverlap,
  isAabbContainedInZone as validationAabbContainedInZone,
  isAabbContainedInAnyZone as validationAabbContainedInAnyZone,
  computeSupportFraction as validationComputeSupportFraction,
  rulesAllowStackOnTop,
  rulesMaxStackCount,
  weightAllowsSupport,
} from '../packing-core/validation.js';
import {
  assertBusinessIdentityValue,
  assertItemCodeAvailable,
  assertLoadPlanNumberAvailable,
  generateLoadPlanNumber,
} from '../core/business-identity.js';
// The wheel-well physical model shared with the solver: manual revalidation
// must accept the same legal on-well/bridge poses AutoPack produces, or any
// manual edit near the wells ejects solver-legal cargo to staging.
import {
  getWheelWellGeometry,
  isAabbWithinTruckMinusBlocked,
  isWheelWellSupportedAndStable,
} from '../packing-core/wheel-well-model.js';
import { computeSpaceUtilization } from '../packing-core/space-utilization-engine.js';
import { repairDependentPlacements } from '../packing-core/repair.js';
import { computeCoG } from './cog-service.js';
import { computePalletWarnings } from './oog-service.js';

// Re-export the shared tolerances so existing consumers importing them from
// pack-library keep working while the single source lives in packing-core.
export { CONTAINMENT_EPS_INCHES, PLACEMENT_EPS, MIN_SUPPORT_FRACTION };

// Re-export the shared oriented-dimension helpers so existing consumers that
// import them from pack-library (autopack-engine, editor-screen) keep working
// while the single source of truth lives in core/oriented-dims.js.
export { normalizeRightAngleRotation, getOrientedDimsForRotation };

const MAX_PRESET_STAGING_LENGTH = Math.max(
  1,
  ...TrailerPresets.getAll().map(preset => Number(preset?.truck?.length) || 0)
);

function getDims(truck) {
  const t = truck && typeof truck === 'object' ? truck : {};
  const length = Math.max(0, Number(t.length) || 0);
  const width = Math.max(0, Number(t.width) || 0);
  const height = Math.max(0, Number(t.height) || 0);
  return { length, width, height };
}

function getMode(truck) {
  const mode = truck && truck.shapeMode;
  if (mode === 'wheelWells' || mode === 'frontBonus' || mode === 'rect') return mode;
  return 'rect';
}

function getConfig(truck) {
  const cfg = truck && truck.shapeConfig;
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
}

function zone(min, max) {
  return { min: { ...min }, max: { ...max } };
}

function sanitizeZones(zones) {
  const EPS = 1e-9;
  return (zones || []).filter(z => {
    const dx = z.max.x - z.min.x;
    const dy = z.max.y - z.min.y;
    const dz = z.max.z - z.min.z;
    return dx > EPS && dy > EPS && dz > EPS;
  });
}

/**
 * Truck/container coordinate convention (inches), shared by usable-zone
 * geometry, canonical staging (getStagingLayout), and manual placement:
 *  - X = truck length, x=0 is the rear / loading-door end, x=truck.length
 *    is the front / cab end (frontBonus sits at the high-X end).
 *  - Y = height, y=0 is the floor.
 *  - Z = width, centered on 0 (z=-truck.width/2 is left, z=+truck.width/2
 *    is right); wheel wells are measured from the rear (low-X) end via
 *    wellOffsetFromRear.
 * This is documentation of the existing convention only - no geometry here
 * changes as a result.
 */
export const TRUCK_DIRECTION_MODEL = Object.freeze({
  lengthAxis: 'x',
  widthAxis: 'z',
  heightAxis: 'y',
  rear: { axis: 'x', value: 0 },
  front: { axis: 'x', value: 'truck.length' },
  floor: { axis: 'y', value: 0 },
  left: { axis: 'z', value: '-truck.width / 2' },
  right: { axis: 'z', value: 'truck.width / 2' },
});

/**
 * Resolve TRUCK_DIRECTION_MODEL's symbolic bounds to concrete numbers for a
 * given truck. Pure description of the existing coordinate convention; does
 * not affect any geometry or placement math.
 */
export function getTruckDirectionModel(truck) {
  const { length: L, width: W } = getDims(truck);
  return {
    lengthAxis: TRUCK_DIRECTION_MODEL.lengthAxis,
    widthAxis: TRUCK_DIRECTION_MODEL.widthAxis,
    heightAxis: TRUCK_DIRECTION_MODEL.heightAxis,
    rear: { axis: 'x', value: 0 },
    front: { axis: 'x', value: L },
    floor: { axis: 'y', value: 0 },
    left: { axis: 'z', value: -W / 2 },
    right: { axis: 'z', value: W / 2 },
  };
}

/**
 * Shape-mode semantics for getTrailerUsableZones(truck) (G2 audit; G2.2B
 * true front-overhang update):
 *  - 'rect' (Standard): the entire 0..truck.length x 0..height x
 *    -width/2..width/2 box is a single usable zone.
 *  - 'wheelWells' (Box + Wheel Wells): the outer box/mesh is unchanged; the
 *    wheel-well volumes (low-height strips near the side walls) are not part
 *    of any returned zone, so an item placed there can render inside the
 *    outer trailer box while still being classified outside the usable
 *    zones (placement 'staged').
 *  - 'frontBonus' (Box + Front Overhang): the main zone is always the full
 *    0..truck.length x 0..height x -width/2..width/2 box (identical to
 *    'rect'). bonusHeight is the deck height / cab clearance, measured from
 *    the main floor (NOT the usable cargo height of the overhang). When
 *    bonusLength > 0, a second zone is appended immediately in front of the
 *    main box, modeling a raised over-cab deck that is flush with the main
 *    box's ceiling and spans the full trailer width:
 *    x: truck.length..truck.length+bonusLength, y: bonusHeight..height,
 *    z: -width/2..width/2 (bonusHeight clamped to <= height; usable overhang
 *    cargo height = height - bonusHeight). The space below the deck
 *    (x > truck.length, y < bonusHeight) is the unusable "cab void" - see
 *    getFrontBonusBlockedZones() - and is not part of any usable zone.
 *    bonusWidth is retained on shapeConfig for backward compatibility only
 *    and is not used in this geometry. A missing, invalid, or non-positive
 *    bonusLength defaults to 0, the overhang zone is then sanitized away,
 *    and frontBonus is geometrically equivalent to 'rect'. A missing or
 *    invalid bonusHeight defaults to 0.45 * height so the overhang never
 *    accidentally creates a floor-level deck.
 */
function getTrailerUsableZones(truck) {
  const { length: L, width: W, height: H } = getDims(truck);
  const mode = getMode(truck);
  const cfg = getConfig(truck);

  if (!L || !W || !H) return [];

  if (mode === 'frontBonus') {
    const bonusLengthRaw = Number(cfg.bonusLength);
    const bonusHeightRaw = Number(cfg.bonusHeight);

    const bonusLength = Math.max(0, Number.isFinite(bonusLengthRaw) ? bonusLengthRaw : 0);
    const bonusHeight = Utils.clamp(Number.isFinite(bonusHeightRaw) ? bonusHeightRaw : 0.45 * H, 0, H);

    const zones = [
      zone({ x: 0, y: 0, z: -W / 2 }, { x: L, y: H, z: W / 2 }),
      zone({ x: L, y: bonusHeight, z: -W / 2 }, { x: L + bonusLength, y: H, z: W / 2 }),
    ];
    return sanitizeZones(zones);
  }

  if (mode === 'wheelWells') {
    const wellHeightRaw = Number(cfg.wellHeight);
    const wellWidthRaw = Number(cfg.wellWidth);
    const wellLengthRaw = Number(cfg.wellLength);
    const wellOffsetRaw = Number(cfg.wellOffsetFromRear);

    const wellHeight = Utils.clamp(Number.isFinite(wellHeightRaw) ? wellHeightRaw : 0.35 * H, 0, H);
    const wellWidth = Utils.clamp(Number.isFinite(wellWidthRaw) ? wellWidthRaw : 0.15 * W, 0, W / 2);
    const wellLength = Utils.clamp(Number.isFinite(wellLengthRaw) ? wellLengthRaw : 0.35 * L, 0, L);
    const wellOffsetFromRear = Utils.clamp(Number.isFinite(wellOffsetRaw) ? wellOffsetRaw : 0.25 * L, 0, L);

    const wx0 = wellOffsetFromRear;
    const wx1 = Utils.clamp(wx0 + wellLength, wx0, L);
    const betweenHalfW = Math.max(0, W / 2 - wellWidth);

    const zones = [
      zone({ x: 0, y: 0, z: -W / 2 }, { x: wx0, y: H, z: W / 2 }),
      zone({ x: wx0, y: 0, z: -betweenHalfW }, { x: wx1, y: H, z: betweenHalfW }),
      zone({ x: wx0, y: wellHeight, z: -W / 2 }, { x: wx1, y: H, z: -betweenHalfW }),
      zone({ x: wx0, y: wellHeight, z: betweenHalfW }, { x: wx1, y: H, z: W / 2 }),
      zone({ x: wx1, y: 0, z: -W / 2 }, { x: L, y: H, z: W / 2 }),
    ];
    return sanitizeZones(zones);
  }

  return [zone({ x: 0, y: 0, z: -W / 2 }, { x: L, y: H, z: W / 2 })];
}

/**
 * G2.2: getFrontBonusBlockedZones() returns the "cab void" beneath the
 * raised over-cab deck (x: truck.length..truck.length+bonusLength,
 * y: 0..bonusHeight, full trailer width). This space is structurally
 * occupied by the cab and is never part of a usable zone - mirrors the
 * wheel-well blocked-zone shape so visuals/tests/warning logic can treat it
 * the same way as a blocked wheel-well volume.
 */
function getFrontBonusBlockedZones(truck) {
  const { length: L, width: W, height: H } = getDims(truck);
  const mode = getMode(truck);
  const cfg = getConfig(truck);
  if (mode !== 'frontBonus') return [];
  if (!L || !W || !H) return [];

  const bonusLengthRaw = Number(cfg.bonusLength);
  const bonusHeightRaw = Number(cfg.bonusHeight);

  const bonusLength = Math.max(0, Number.isFinite(bonusLengthRaw) ? bonusLengthRaw : 0);
  const bonusHeight = Utils.clamp(Number.isFinite(bonusHeightRaw) ? bonusHeightRaw : 0.45 * H, 0, H);

  const zones = [zone({ x: L, y: 0, z: -W / 2 }, { x: L + bonusLength, y: bonusHeight, z: W / 2 })];
  return sanitizeZones(zones);
}

/**
 * Wheel-well blocked bodies occupy the lower side-wall strips inside the
 * otherwise rectangular trailer shell. They are collision obstacles, not
 * staging/work-floor space.
 */
function getWheelWellsBlockedZones(truck) {
  const { length: L, width: W, height: H } = getDims(truck);
  const mode = getMode(truck);
  const cfg = getConfig(truck);
  if (mode !== 'wheelWells') return [];
  if (!L || !W || !H) return [];

  const wellHeightRaw = Number(cfg.wellHeight);
  const wellWidthRaw = Number(cfg.wellWidth);
  const wellLengthRaw = Number(cfg.wellLength);
  const wellOffsetRaw = Number(cfg.wellOffsetFromRear);

  const wellHeight = Utils.clamp(Number.isFinite(wellHeightRaw) ? wellHeightRaw : 0.35 * H, 0, H);
  const wellWidth = Utils.clamp(Number.isFinite(wellWidthRaw) ? wellWidthRaw : 0.15 * W, 0, W / 2);
  const wellLength = Utils.clamp(Number.isFinite(wellLengthRaw) ? wellLengthRaw : 0.35 * L, 0, L);
  const wellOffsetFromRear = Utils.clamp(Number.isFinite(wellOffsetRaw) ? wellOffsetRaw : 0.25 * L, 0, L);

  const wx0 = wellOffsetFromRear;
  const wx1 = Utils.clamp(wx0 + wellLength, wx0, L);
  const betweenHalfW = Math.max(0, W / 2 - wellWidth);

  const zones = [
    zone({ x: wx0, y: 0, z: -W / 2 }, { x: wx1, y: wellHeight, z: -betweenHalfW }),
    zone({ x: wx0, y: 0, z: betweenHalfW }, { x: wx1, y: wellHeight, z: W / 2 }),
  ];
  return sanitizeZones(zones);
}

function getTrailerCapacityInches3(truck) {
  const zones = getTrailerUsableZones(truck);
  return zones.reduce((sum, z) => {
    const dx = z.max.x - z.min.x;
    const dy = z.max.y - z.min.y;
    const dz = z.max.z - z.min.z;
    return sum + Math.max(0, dx) * Math.max(0, dy) * Math.max(0, dz);
  }, 0);
}

/** Maximum accepted gap between a retaining wall's front face and the overhang step. */
export const REAR_RETENTION_MAX_STEP_GAP_INCHES = 0.05;

/** Rear retention requires the candidate's complete width; vertical support uses a separate rule. */
export const MIN_REAR_RETENTION_WIDTH_FRACTION = 1.0;

const aabbContainedInZone = validationAabbContainedInZone;

/**
 * Resolve the true raised Front Overhang deck and its main-floor step geometry.
 * Wheel-well raised zones never extend beyond truck.length and therefore cannot
 * activate this contract.
 */
export function getFrontOverhangRetentionGeometry(truck, zonesOverride = null) {
  const t = truck && typeof truck === 'object' ? truck : {};
  if (getMode(t) !== 'frontBonus') return null;
  const length = Math.max(0, Number(t.length) || 0);
  const zones = Array.isArray(zonesOverride) ? zonesOverride : getTrailerUsableZones(t);
  const deckZone = zones
    .filter(z =>
      z && z.min && z.max &&
      z.min.y > CONTAINMENT_EPS_INCHES &&
      z.max.x > length + CONTAINMENT_EPS_INCHES &&
      Math.abs(z.min.x - length) <= CONTAINMENT_EPS_INCHES
    )
    .sort((a, b) => b.max.x - a.max.x || a.min.y - b.min.y)[0] || null;
  if (!deckZone) return null;
  const stepX = deckZone.min.x;
  const mainZone = zones.find(z =>
    z && z.min && z.max &&
    Math.abs(z.min.y) <= CONTAINMENT_EPS_INCHES &&
    Math.abs(z.max.x - stepX) <= CONTAINMENT_EPS_INCHES &&
    z.min.z <= deckZone.min.z + CONTAINMENT_EPS_INCHES &&
    z.max.z >= deckZone.max.z - CONTAINMENT_EPS_INCHES
  ) || null;
  if (!mainZone) return null;
  return { stepX, deckY: deckZone.min.y, deckZone, mainZone };
}

function retentionPlacementEntry(value, index) {
  if (!value) return null;
  const aabb = value.aabb || (value.min && value.max ? value : null);
  if (!aabb) return null;
  const id = value.instanceId || value.id || `retainer-${index}`;
  return { id, aabb, placement: value.placement, valid: value.valid, rejected: value.rejected };
}

/**
 * Pure per-candidate Front Overhang rear-retention evaluation. Callers pass only
 * placements that have already survived their ordinary hard validity rules.
 */
export function evaluateFrontOverhangRearRetention(
  candidateAabb,
  acceptedPlacements,
  truck,
  zonesOverride = null
) {
  const geometry = getFrontOverhangRetentionGeometry(truck, zonesOverride);
  if (!geometry || !aabbContainedInZone(candidateAabb, geometry.deckZone)) {
    return {
      required: false,
      retained: true,
      coveredWidth: 0,
      candidateWidth: Math.max(0, Number(candidateAabb?.max?.z) - Number(candidateAabb?.min?.z)),
      coverageFraction: 1,
      retainerIds: [],
      geometry,
    };
  }

  const candidateMinZ = candidateAabb.min.z;
  const candidateMaxZ = candidateAabb.max.z;
  const candidateWidth = Math.max(0, candidateMaxZ - candidateMinZ);
  const intervals = [];
  (acceptedPlacements || []).forEach((value, index) => {
    const entry = retentionPlacementEntry(value, index);
    if (!entry || entry.placement === 'staged' || entry.valid === false || entry.rejected === true) return;
    const aabb = entry.aabb;
    if (!aabbContainedInZone(aabb, geometry.mainZone)) return;
    const stepGap = geometry.stepX - aabb.max.x;
    if (stepGap < -CONTAINMENT_EPS_INCHES ||
        stepGap > REAR_RETENTION_MAX_STEP_GAP_INCHES + 1e-9) return;
    if (aabb.min.y > geometry.deckY + CONTAINMENT_EPS_INCHES ||
        aabb.max.y < geometry.deckY - CONTAINMENT_EPS_INCHES) return;
    const minZ = Math.max(candidateMinZ, aabb.min.z);
    const maxZ = Math.min(candidateMaxZ, aabb.max.z);
    if (maxZ - minZ <= CONTAINMENT_EPS_INCHES) return;
    intervals.push({ minZ, maxZ, id: entry.id });
  });

  intervals.sort((a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ || String(a.id).localeCompare(String(b.id)));
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval.minZ > last.maxZ) {
      merged.push({ minZ: interval.minZ, maxZ: interval.maxZ, ids: new Set([interval.id]) });
      continue;
    }
    last.maxZ = Math.max(last.maxZ, interval.maxZ);
    last.ids.add(interval.id);
  }
  const coveredWidth = merged.reduce((sum, interval) => sum + Math.max(0, interval.maxZ - interval.minZ), 0);
  const requiredWidth = candidateWidth * MIN_REAR_RETENTION_WIDTH_FRACTION;
  const retained = candidateWidth > 0 && coveredWidth + CONTAINMENT_EPS_INCHES >= requiredWidth;
  return {
    required: true,
    retained,
    coveredWidth,
    candidateWidth,
    coverageFraction: candidateWidth > 0 ? Math.min(1, coveredWidth / candidateWidth) : 0,
    retainerIds: retained
      ? [...new Set(merged.flatMap(interval => [...interval.ids]))].sort((a, b) => String(a).localeCompare(String(b)))
      : [],
    geometry,
  };
}

/**
 * Inch-space containment contract: all AABBs and usable zones passed here use
 * inches, and all active trailer-containment callers share the same physical
 * tolerance through CONTAINMENT_EPS_INCHES (single source: packing-core).
 */
const isAabbContainedInAnyZone = validationAabbContainedInAnyZone;

export function createOrientationLockPatch(rotation) {
  if (!getPhysicalOrientationAxes(rotation).valid) return null;
  return { orientationLocked: true, lockedRotation: normalizeRightAngleRotation(rotation) };
}

export function clearOrientationLockPatch() {
  return { orientationLocked: false, lockedRotation: null };
}

/** Signed physical Case permission; exact instance targets are planning only. */
export function isOrientationAllowedByCasePolicy(caseData = {}, rotation) {
  return isCasePhysicalOrientationAllowed(caseData, rotation);
}

function isFinitePositive(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0;
}

function finiteOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeTransformPosition(position) {
  if (!position || typeof position !== 'object') return null;
  const x = Number(position.x);
  const y = Number(position.y);
  const z = Number(position.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function normalizeTransformRotation(rotation) {
  const src = rotation && typeof rotation === 'object' ? rotation : {};
  return {
    x: finiteOr(src.x, 0),
    y: finiteOr(src.y, 0),
    z: finiteOr(src.z, 0),
  };
}

function normalizeTransformScale(scale) {
  const src = scale && typeof scale === 'object' ? scale : {};
  return {
    x: isFinitePositive(src.x) ? Number(src.x) : 1,
    y: isFinitePositive(src.y) ? Number(src.y) : 1,
    z: isFinitePositive(src.z) ? Number(src.z) : 1,
  };
}

function normalizeDims(dims, fallback = { length: 24, width: 24, height: 24 }) {
  const src = dims && typeof dims === 'object' ? dims : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    length: isFinitePositive(src.length) ? Number(src.length) : finiteOr(fb.length, 24),
    width: isFinitePositive(src.width) ? Number(src.width) : finiteOr(fb.width, 24),
    height: isFinitePositive(src.height) ? Number(src.height) : finiteOr(fb.height, 24),
  };
}

function getInstanceEffectiveDims(inst, caseData) {
  return getActualPoseDimensions(caseData, inst).value || null;
}

function hasPositiveFiniteDims(dims) {
  return Boolean(
    dims &&
    isFinitePositive(dims.length) &&
    isFinitePositive(dims.width) &&
    isFinitePositive(dims.height)
  );
}


function dimensionsEqual(a, b, tolerance = 1e-6) {
  return hasPositiveFiniteDims(a) && hasPositiveFiniteDims(b) &&
    Math.abs(Number(a.length) - Number(b.length)) <= tolerance &&
    Math.abs(Number(a.width) - Number(b.width)) <= tolerance &&
    Math.abs(Number(a.height) - Number(b.height)) <= tolerance;
}

/**
 * Resolve an instance's physical dimensions without inventing fallback geometry.
 * Rotation is the source of truth; stored orientedDims are accepted only when they
 * agree with the shared THREE-compatible right-angle helper.
 */
export function getCanonicalInstanceEffectiveDims(inst, caseData) {
  const actual = getActualPoseDimensions(caseData, inst);
  if (!actual.valid) return { ok: false, reason: 'missing or malformed Case dimensions or actual rotation' };
  const rotation = { ...inst.transform.rotation };
  return {
    ok: true,
    dims: actual.value,
    rotation,
    orientationAllowed: isOrientationAllowedByCasePolicy(caseData, rotation),
    storedConsistent: dimensionsEqual(inst.orientedDims, actual.value),
  };
}

function applyCanonicalInstancePose(inst, canonical) {
  const next = Utils.deepClone(inst);
  next.transform = next.transform && typeof next.transform === 'object' ? next.transform : {};
  next.transform.rotation = { ...canonical.rotation };
  next.orientedDims = { ...canonical.dims };
  return next;
}

function getDeterministicStagingCanonical(caseData) {
  return getCanonicalInstanceEffectiveDims({
    transform: { rotation: { x: 0, y: 0, z: 0 } },
  }, caseData);
}

function makeAabb(position, dims) {
  return {
    min: {
      x: position.x - dims.length / 2,
      y: position.y - dims.height / 2,
      z: position.z - dims.width / 2,
    },
    max: {
      x: position.x + dims.length / 2,
      y: position.y + dims.height / 2,
      z: position.z + dims.width / 2,
    },
  };
}

const aabbsOverlap = validationAabbsOverlap;

export function aabbIntersectsWheelWellBlockedBody(aabb, truck) {
  if (!aabb) return false;
  return getWheelWellsBlockedZones(truck).some(blocked => aabbsOverlap(aabb, blocked));
}

export function aabbIntersectsFrontBonusBlockedBody(aabb, truck) {
  if (!aabb) return false;
  return getFrontBonusBlockedZones(truck).some(blocked => aabbsOverlap(aabb, blocked));
}

function overlapsAny(aabb, acceptedAabbs) {
  return (acceptedAabbs || []).some(other => aabbsOverlap(aabb, other));
}

/**
 * Canonical staging-zone layout shared by every "place outside the trailer"
 * path (Add Case default placement, AutoPack overflow/unpacked items, Unpack
 * All, and Duplicate-to-staging). Defines a single gap and origin so staged
 * items always land in one consistent strip beside the trailer instead of
 * each caller drifting with its own offset formula.
 *
 * originX: 0 matches the rear / loading-door end of TRUCK_DIRECTION_MODEL
 * (x=0); the staging row runs alongside the trailer from the rear toward
 * the front (x=truck.length).
 */
export function getStagingLayout(truck, options = {}) {
  const t = truck && typeof truck === 'object' ? truck : {};
  const truckL = Math.max(Number(t.length) || 120, 1);
  const truckW = Math.max(Number(t.width) || 96, 1);
  const gap = Number(options.gap) > 0 ? Number(options.gap) : 12;
  const defaultOriginZ = truckW / 2 + gap;
  const originZ = Number.isFinite(Number(options.originZ)) ? Number(options.originZ) : defaultOriginZ;
  return {
    gap,
    truckL,
    truckW,
    originX: 0,
    originZ,
  };
}

export function findSafeStagingPosition(pack, dims, acceptedAabbs, options = {}) {
  const truck = pack && pack.truck ? pack.truck : {};
  const layout = getStagingLayout(truck, options);
  const truckL = Math.max(layout.truckL, dims.length);
  const gap = layout.gap;
  const stepX = Math.max(1, dims.length + gap);
  const stepZ = Math.max(1, dims.width + gap);
  const minX = layout.originX + dims.length / 2;
  const maxX = Math.max(minX, truckL - dims.length / 2);
  const availableX = Math.max(0, maxX - minX);
  const cols = Math.max(1, Math.floor(availableX / stepX) + 1);
  const startZ = layout.originZ + dims.width / 2;
  const accepted = Array.isArray(acceptedAabbs) ? acceptedAabbs : [];
  const maxRows = Math.max(200, Math.ceil((accepted.length + 1) / cols) + 20);

  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < cols; col++) {
      const position = {
        x: Math.min(minX + col * stepX, maxX),
        y: dims.height / 2,
        z: startZ + row * stepZ,
      };
      const aabb = makeAabb(position, dims);
      if (!overlapsAny(aabb, accepted)) return { position, aabb };
    }
  }

  let overflowZ = startZ;
  for (const aabb of accepted) {
    if (Number.isFinite(Number(aabb && aabb.max && aabb.max.z))) {
      overflowZ = Math.max(overflowZ, Number(aabb.max.z) + gap + dims.width / 2);
    }
  }
  const fallback = { x: minX, y: dims.height / 2, z: overflowZ };
  for (let attempt = 0; attempt < 1000; attempt++) {
    const position = { ...fallback, z: overflowZ + attempt * stepZ };
    const aabb = makeAabb(position, dims);
    if (!overlapsAny(aabb, accepted)) return { position, aabb };
  }
  return { position: fallback, aabb: makeAabb(fallback, dims) };
}

function getDuplicateSourcePosition(inst, dims) {
  return normalizeTransformPosition(inst && inst.transform && inst.transform.position) || {
    x: 0,
    y: Math.max(1, dims.height / 2),
    z: 0,
  };
}

function buildDuplicateSourcePayload(sourceInstances, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  return (Array.isArray(sourceInstances) ? sourceInstances : [])
    .map(inst => {
      if (!inst || !inst.caseId) return null;
      const caseData = caseMap.get(inst.caseId);
      if (!caseData) return null;
      const dims = getInstanceEffectiveDims(inst, caseData);
      if (!hasPositiveFiniteDims(dims)) return null;
      return {
        inst,
        caseData,
        dims,
        position: getDuplicateSourcePosition(inst, dims),
      };
    })
    .filter(Boolean);
}

function buildDuplicatePayloadBounds(payload) {
  const initial = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  return payload.reduce((bounds, item) => {
    const aabb = makeAabb(item.position, item.dims);
    bounds.min.x = Math.min(bounds.min.x, aabb.min.x);
    bounds.min.y = Math.min(bounds.min.y, aabb.min.y);
    bounds.min.z = Math.min(bounds.min.z, aabb.min.z);
    bounds.max.x = Math.max(bounds.max.x, aabb.max.x);
    bounds.max.y = Math.max(bounds.max.y, aabb.max.y);
    bounds.max.z = Math.max(bounds.max.z, aabb.max.z);
    return bounds;
  }, initial);
}

function buildDuplicateExistingAabbs(pack, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  return (pack && Array.isArray(pack.cases) ? pack.cases : [])
    .map(inst => {
      if (!inst) return null;
      const caseData = caseMap.get(inst.caseId);
      if (!caseData) return null;
      const dims = getInstanceEffectiveDims(inst, caseData);
      if (!hasPositiveFiniteDims(dims)) return null;
      const position = normalizeTransformPosition(inst.transform && inst.transform.position);
      if (!position) return null;
      const aabb = makeAabb(position, dims);
      // Staged cargo is not a truck obstacle, even if its saved pose is stale.
      return inst.placement === 'staged' && duplicateAabbIsInsideTruckGeometry(pack, aabb) ? null : aabb;
    })
    .filter(Boolean);
}

function duplicateAabbIsInsideTruckGeometry(pack, aabb) {
  if (!aabb ||
      aabbIntersectsWheelWellBlockedBody(aabb, pack && pack.truck) ||
      aabbIntersectsFrontBonusBlockedBody(aabb, pack && pack.truck)) return false;
  const zones = getTrailerUsableZones(pack && pack.truck);
  return isAabbInsideTruckGeometry(aabb, zones, getWheelWellGeometry(pack && pack.truck));
}

function buildDuplicateExistingEntries(pack, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  return (pack && Array.isArray(pack.cases) ? pack.cases : [])
    .filter(inst => inst && inst.placement !== 'staged')
    .map(inst => {
      const caseData = caseMap.get(inst.caseId);
      if (!caseData) return null;
      const dims = getInstanceEffectiveDims(inst, caseData);
      if (!hasPositiveFiniteDims(dims)) return null;
      const position = normalizeTransformPosition(inst.transform && inst.transform.position);
      if (!position) return null;
      return {
        id: inst.id,
        inst,
        caseData,
        dims,
        position,
        aabb: makeAabb(position, dims),
      };
    })
    .filter(Boolean);
}

function buildDuplicateAcceptedSupportEntries(pack, caseLibrary) {
  const zones = getTrailerUsableZones(pack && pack.truck);
  const wheelWell = getWheelWellGeometry(pack && pack.truck);
  const accepted = [];
  const entries = buildDuplicateExistingEntries(pack, caseLibrary)
    .filter(entry => entry.inst.placement !== 'staged' && duplicateAabbIsInsideTruckGeometry(pack, entry.aabb))
    .sort((a, b) =>
      a.aabb.min.y - b.aabb.min.y ||
      a.aabb.min.x - b.aabb.min.x ||
      a.aabb.min.z - b.aabb.min.z ||
      String(a.id).localeCompare(String(b.id))
    );

  for (const entry of entries) {
    const candidate = { id: entry.id, inst: entry.inst, caseData: entry.caseData };
    if (!aabbIsFullyValid(candidate, entry.aabb, accepted, zones, pack && pack.truck, RECON_TOL, wheelWell)) {
      continue;
    }
    accepted.push({ id: entry.id, inst: entry.inst, aabb: entry.aabb, caseData: entry.caseData });
  }

  return { accepted, zones, wheelWell };
}

function duplicatePackedGroupIsFullyValid(pack, records, caseLibrary) {
  const { accepted, zones, wheelWell } = buildDuplicateAcceptedSupportEntries(pack, caseLibrary);
  const ordered = [...records].sort((a, b) =>
    a.aabb.min.y - b.aabb.min.y ||
    a.aabb.min.x - b.aabb.min.x ||
    a.aabb.min.z - b.aabb.min.z ||
    String(a.inst?.id || '').localeCompare(String(b.inst?.id || ''))
  );

  for (const record of ordered) {
    const candidate = { id: record.inst?.id, inst: record.inst, caseData: record.caseData };
    if (!aabbIsFullyValid(candidate, record.aabb, accepted, zones, pack && pack.truck, RECON_TOL, wheelWell)) {
      return false;
    }
    accepted.push({ id: record.inst?.id, inst: record.inst, aabb: record.aabb, caseData: record.caseData });
  }

  return true;
}

function duplicateOffsetIsSafe(pack, payload, existingAabbs, offset, requirePacked, caseLibrary) {
  const candidateAabbs = [];
  const records = [];
  for (const item of payload) {
    const position = {
      x: item.position.x + offset.x,
      y: item.position.y + offset.y,
      z: item.position.z + offset.z,
    };
    const aabb = makeAabb(position, item.dims);
    if (overlapsAny(aabb, existingAabbs)) return false;
    if (overlapsAny(aabb, candidateAabbs)) return false;
    candidateAabbs.push(aabb);
    records.push({ ...item, position, aabb });
  }
  if (requirePacked && !duplicatePackedGroupIsFullyValid(pack, records, caseLibrary)) return false;
  return true;
}

function findDuplicateOffset(pack, payload, existingAabbs, caseLibrary) {
  if (!payload.length) return null;
  const bounds = buildDuplicatePayloadBounds(payload);
  const spanX = Math.max(1, bounds.max.x - bounds.min.x);
  const spanZ = Math.max(1, bounds.max.z - bounds.min.z);
  const sourceInsideTruck = payload.every(item =>
    duplicateAabbIsInsideTruckGeometry(pack, makeAabb(item.position, item.dims))
  );
  const insideOffsets = [
    { x: spanX, y: 0, z: 0 },
    { x: -spanX, y: 0, z: 0 },
    { x: 0, y: 0, z: spanZ },
    { x: 0, y: 0, z: -spanZ },
    { x: spanX, y: 0, z: spanZ },
    { x: spanX, y: 0, z: -spanZ },
    { x: -spanX, y: 0, z: spanZ },
    { x: -spanX, y: 0, z: -spanZ },
  ];
  if (sourceInsideTruck) {
    const packedOffset = insideOffsets.find(offset =>
      duplicateOffsetIsSafe(pack, payload, existingAabbs, offset, true, caseLibrary)
    );
    if (packedOffset) return { offset: packedOffset, staged: false };
  }

  const groupDims = {
    length: spanX,
    width: spanZ,
    height: Math.max(1, bounds.max.y - bounds.min.y),
  };
  const staged = findSafeStagingPosition(pack, groupDims, existingAabbs);
  const groupCenter = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const stagedOffset = {
    x: staged.position.x - groupCenter.x,
    y: staged.position.y - groupCenter.y,
    z: staged.position.z - groupCenter.z,
  };
  if (duplicateOffsetIsSafe(pack, payload, existingAabbs, stagedOffset, false, caseLibrary)) {
    return { offset: stagedOffset, staged: true };
  }
  return null;
}

export function buildSafeDuplicateInstances(pack, sourceInstances, caseLibrary = CaseLibrary.getCases()) {
  if (!pack) return { cases: [], newInstances: [], newIds: [], placement: null, offset: null };
  const payload = buildDuplicateSourcePayload(sourceInstances, caseLibrary);
  if (!payload.length) {
    return {
      cases: Array.isArray(pack.cases) ? pack.cases : [],
      newInstances: [],
      newIds: [],
      placement: null,
      offset: null,
    };
  }

  const placement = findDuplicateOffset(pack, payload, buildDuplicateExistingAabbs(pack, caseLibrary), caseLibrary);
  if (!placement) {
    return {
      cases: Array.isArray(pack.cases) ? pack.cases : [],
      newInstances: [],
      newIds: [],
      placement: null,
      offset: null,
    };
  }

  const placementState = placement.staged ? 'staged' : 'packed';
  const mintInstanceId = createInstanceIdMinter(pack);
  const newInstances = payload.map(item => {
    const next = Utils.deepClone(item.inst);
    next.id = mintInstanceId();
    next.transform = {
      ...Utils.deepClone(item.inst.transform || {}),
      position: {
        x: item.position.x + placement.offset.x,
        y: item.position.y + placement.offset.y,
        z: item.position.z + placement.offset.z,
      },
      rotation: normalizeTransformRotation(item.inst.transform && item.inst.transform.rotation),
      scale: normalizeTransformScale(item.inst.transform && item.inst.transform.scale),
    };
    next.hidden = false;
    next.placement = placementState;
    if (placementState === 'staged') delete next.packedProfile;
    // Item Notes describe this one physical unit (e.g. "this one arrived
    // dented") — never true of a freshly created duplicate, so a duplicated
    // instance must not inherit the source's instanceNotes even though the
    // deep clone above would otherwise carry it over.
    next.instanceNotes = null;
    return next;
  });

  return {
    cases: [...(Array.isArray(pack.cases) ? pack.cases : []), ...newInstances],
    newInstances,
    newIds: newInstances.map(inst => inst.id),
    placement: placementState,
    offset: placement.offset,
  };
}

export function duplicateInstancesSafely(packId, sourceInstances, caseLibrary = CaseLibrary.getCases()) {
  const pack = getById(packId);
  if (!pack) return null;
  const result = buildSafeDuplicateInstances(pack, sourceInstances, caseLibrary);
  if (!result.newIds.length) return null;
  const updated = update(packId, { cases: result.cases });
  return { ...result, pack: updated || { ...pack, cases: result.cases } };
}

/**
 * Canonical staging-row bounds derived from the same S1 staging layout used
 * by findSafeStagingPosition: a tight envelope around the neat row/column
 * grid where AutoPack overflow, Unpack All, Add Case, and Duplicate fallback
 * place items beside the trailer. This is intentionally small — it is not
 * the manual work area (see getStagingWorkAreaBounds).
 */
export function getStagingBounds(truck, options = {}) {
  const layout = getStagingLayout(truck, options);
  const margin = Number(options.margin) > 0 ? Number(options.margin) : layout.gap;
  const depth = Number(options.depth) > 0 ? Number(options.depth) : Math.max(layout.truckL, layout.truckW * 2);
  return {
    min: { x: layout.originX - margin, y: 0, z: layout.originZ - margin },
    max: { x: layout.truckL + margin, y: Infinity, z: layout.originZ + depth },
  };
}

/**
 * Large manual "work floor" bounds around the trailer/container. Unlike
 * getStagingBounds (the tight canonical staging-row envelope), this spans
 * both sides of the trailer in Z and a generous margin before/after it in X,
 * so users can drag staged items several feet away to organize, group, and
 * inspect them from any camera angle. Scales with truck size instead of a
 * fixed constant.
 */
export function getStagingWorkAreaBounds(truck, options = {}) {
  const t = truck && typeof truck === 'object' ? truck : {};
  const truckL = Math.max(Number(t.length) || 120, 1);
  const truckW = Math.max(Number(t.width) || 96, 1);
  const marginX = Number(options.marginX) > 0 ? Number(options.marginX) : Math.max(120, truckL * 0.25);
  const marginZ = Number(options.marginZ) > 0 ? Number(options.marginZ) : Math.max(180, truckW * 3);
  return {
    min: { x: -marginX, y: 0, z: -(truckW / 2 + marginZ) },
    max: { x: truckL + marginX, y: Infinity, z: truckW / 2 + marginZ },
  };
}

/**
 * Whether an inch-based AABB is inside the large manual staging work area
 * for this pack's truck. Used to validate manual drag/rotate/flip of staged
 * items so they can be organized away from the trailer without drifting off
 * the visible work floor.
 */
export function isAabbInStagingZone(pack, aabb, options = {}) {
  const bounds = getStagingWorkAreaBounds(pack && pack.truck, options);
  const EPS = 0.05;
  return (
    aabb.min.x >= bounds.min.x - EPS &&
    aabb.max.x <= bounds.max.x + EPS &&
    aabb.min.y >= bounds.min.y - EPS &&
    aabb.max.y <= bounds.max.y + EPS &&
    aabb.min.z >= bounds.min.z - EPS &&
    aabb.max.z <= bounds.max.z + EPS
  );
}

/**
 * Generated staging rows use the canonical X grid beside the trailer and may
 * grow indefinitely away from it in +Z. Keep that deterministic corridor
 * separate from the finite manual work floor so large organized inventories do
 * not become invalid solely because they need more rows.
 */
function isAabbInGeneratedStagingCorridor(pack, aabb, options = {}) {
  const values = [
    aabb?.min?.x, aabb?.min?.y, aabb?.min?.z,
    aabb?.max?.x, aabb?.max?.y, aabb?.max?.z,
  ].map(Number);
  if (!values.every(Number.isFinite)) return false;
  const [minX, minY, minZ, maxX, maxY, maxZ] = values;
  if (maxX <= minX || maxY <= minY || maxZ <= minZ) return false;

  const layout = getStagingLayout(pack && pack.truck, options);
  const aabbLength = maxX - minX;
  // Keep generated rows from the largest curated trailer valid
  // across sequential preset shrinks; the committed smaller truck otherwise
  // loses the prior row-width provenance on the next change.
  const corridorMaxX = layout.originX + Math.max(
    MAX_PRESET_STAGING_LENGTH,
    layout.truckL,
    aabbLength
  );
  const EPS = 0.05;
  return (
    minX >= layout.originX - EPS &&
    maxX <= corridorMaxX + EPS &&
    minY >= -EPS &&
    minZ >= layout.originZ - EPS
  );
}

function isAabbInSupportedStagingArea(pack, aabb, options = {}) {
  return isAabbInStagingZone(pack, aabb, options) ||
    isAabbInGeneratedStagingCorridor(pack, aabb, options);
}

/**
 * Derive the "packed" | "staged" placement state for an instance from its
 * final AABB: inside the trailer's usable zones is "packed", anything
 * outside (including the staging zone) is "staged".
 */
function getPlacementForAabb(pack, aabb) {
  if (aabbIntersectsWheelWellBlockedBody(aabb, pack && pack.truck) ||
      aabbIntersectsFrontBonusBlockedBody(aabb, pack && pack.truck)) return 'staged';
  const zones = getTrailerUsableZones(pack && pack.truck);
  return isAabbInsideTruckGeometry(aabb, zones, getWheelWellGeometry(pack && pack.truck))
    ? 'packed'
    : 'staged';
}

function buildAcceptedAabbs(pack, instances, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const acceptedAabbs = [];
  (instances || []).forEach(inst => {
    const caseData = caseMap.get(inst && inst.caseId);
    const position = normalizeTransformPosition(inst && inst.transform && inst.transform.position);
    if (!position) return;
    if (caseData) {
      // Resolved Cases reserve the envelope derived from their actual pose.
      const dims = getInstanceEffectiveDims(inst, caseData);
      if (dims) acceptedAabbs.push(makeAabb(position, dims));
    } else {
      const unresolved = getTrustedSavedAabb(inst);
      if (unresolved) acceptedAabbs.push(unresolved);
    }
  });
  return acceptedAabbs;
}

// Saved geometry is usable as an obstacle only with a finite position and
// positive explicit dimensions; no fallback Case size is invented. The packed
// wrapper below matches AutoPack's collision-only physical boundary.
function getTrustedSavedAabb(inst) {
  if (!inst) return null;
  const position = inst.transform && inst.transform.position;
  const dims = inst.orientedDims;
  if (!position || !dims ||
      !['x', 'y', 'z'].every(axis => typeof position[axis] === 'number' && Number.isFinite(position[axis])) ||
      !['length', 'width', 'height'].every(axis =>
        typeof dims[axis] === 'number' && Number.isFinite(dims[axis]) && dims[axis] > 0)) {
    return null;
  }
  return makeAabb(position, dims);
}

function getTrustedUnresolvedPackedAabb(inst) {
  return inst && inst.placement !== 'staged' ? getTrustedSavedAabb(inst) : null;
}

// ============================================================================
// SECTION: SHARED PLACEMENT VALIDATION CONSTANTS AND HELPERS
// PLACEMENT_EPS, MIN_SUPPORT_FRACTION, and computeSupportFraction are re-exported
// from packing-core/validation.js (the single validation authority) so
// editor-screen.js and every placement validator share one epsilon,
// support-fraction threshold, and coverage computation.
// ============================================================================

export const computeSupportFraction = validationComputeSupportFraction;

// ============================================================================
// SECTION: TRUCK GEOMETRY CHANGE RECONCILIATION
// When the truck preset/mode/dimensions/wheel-wells/overhang change, every placed
// instance must be revalidated against the NEW geometry. Valid placements are kept
// EXACTLY; an invalid one may be corrected only by a safe vertical snap to a valid
// floor/deck/support (unchanged X/Z, no collision, valid support); the rest are
// reported as "invalid" for the user to repack, stage, or cancel. Stacks are
// validated bottom-up as dependency groups so a support is never moved while its
// children are left floating — children inherit their support's vertical delta.
// ============================================================================

const RECON_TOL = 0.05; // matches CONTAINMENT_EPS_INCHES

function instanceUsesMaxCapacityProfile(inst) {
  return Boolean(
    inst &&
    inst.placement === 'packed' &&
    inst.packedProfile === 'max-capacity'
  );
}

function maxCapacitySupportRelationship(candidate, support) {
  return instanceUsesMaxCapacityProfile(candidate && candidate.inst) &&
    instanceUsesMaxCapacityProfile(support && support.inst);
}

// Existing committed Max-to-Max supports use the same relationship authority
// in reconciliation and fixed AutoPack preflight. Project only marked pairs;
// never mutate the stored support instance or its source case rules.
export function projectMaxCapacitySupportRecords(candidate, accepted) {
  if (!instanceUsesMaxCapacityProfile(candidate && candidate.inst)) return accepted || [];
  return (accepted || []).map(support => {
    if (!maxCapacitySupportRelationship(candidate, support)) return support;
    return {
      ...support,
      relaxWeightComparison: true,
      caseData: {
        ...(support.caseData || {}),
        noStackOnTop: false,
        stackable: true,
        maxStackCount: 0,
        relaxWeightComparison: true,
      },
      ...(support.item && { item: {
        ...support.item,
        noStackOnTop: false,
        stackable: true,
        maxStackCount: 0,
        relaxWeightComparison: true,
      } }),
    };
  });
}

function projectManualGeometrySupportRecords(accepted) {
  return (accepted || []).map(entry => ({ ...entry, caseData: {
    ...(entry.caseData || {}), noStackOnTop: false, stackable: true, maxStackCount: 0,
  } }));
}

function reconXzOverlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x));
  const oz = Math.max(0, Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z));
  return ox * oz;
}

function aabbRestsOnZoneFloor(aabb, zones, tol = RECON_TOL) {
  return (zones || []).some(z =>
    Math.abs(aabb.min.y - z.min.y) <= tol &&
    aabb.min.x >= z.min.x - tol && aabb.max.x <= z.max.x + tol &&
    aabb.min.z >= z.min.z - tol && aabb.max.z <= z.max.z + tol &&
    aabb.max.y <= z.max.y + tol
  );
}

function directChildCount(support, accepted, tol = RECON_TOL) {
  return (accepted || []).filter(child =>
    child !== support &&
    Math.abs(child.aabb.min.y - support.aabb.max.y) <= tol &&
    reconXzOverlapArea(child.aabb, support.aabb) > 0.05
  ).length;
}

function supportCanCarry(candidate, support, accepted) {
  const relaxComparison = maxCapacitySupportRelationship(candidate, support);
  if (relaxComparison) return weightAllowsSupport(candidate.caseData?.weight, support.caseData?.weight, false, true);
  const rules = support.caseData || {};
  if (!rulesAllowStackOnTop(rules)) return false;
  // Manual pipeline floors the cap at its boundary (canonicalization already
  // floors stored values; this keeps legacy data behavior unchanged).
  const limit = Math.max(0, Math.floor(rulesMaxStackCount(rules)));
  if (limit && directChildCount(support, accepted) >= limit) return false;
  return weightAllowsSupport(
    candidate.caseData?.weight,
    rules.weight,
    rules.isPallet === true
  );
}

function aabbIsSupported(candidate, aabb, accepted, zones, tol = RECON_TOL, manualGeometry = false) {
  if (aabbRestsOnZoneFloor(aabb, zones, tol)) return true;
  const supporters = (accepted || []).filter(support =>
    Math.abs(aabb.min.y - support.aabb.max.y) <= tol &&
    reconXzOverlapArea(aabb, support.aabb) > 0.05
  );
  if (!supporters.length) return false;
  if (!manualGeometry && supporters.some(support => !supportCanCarry(candidate, support, accepted))) return false;
  return computeSupportFraction(aabb, supporters.map(support => support.aabb), tol) >= MIN_SUPPORT_FRACTION;
}

/**
 * Containment for manual/reconciliation checks: inside the usable zones, OR —
 * for wheelWells trucks — inside the exact truck-minus-blocked union. The union
 * form accepts solver-legal poses that span zone seams (resting on or bridging
 * the rigid well tops) which single-zone containment can never express.
 */
function isAabbInsideTruckGeometry(aabb, zones, wheelWell) {
  if (isAabbContainedInAnyZone(aabb, zones)) return true;
  return Boolean(wheelWell) && isAabbWithinTruckMinusBlocked(aabb, wheelWell);
}

function aabbIsFullyValid(candidate, aabb, accepted, zones, truck, tol = RECON_TOL, wheelWell = null, manualGeometry = false) {
  const structural = (accepted || []).filter(entry => !entry.collisionOnly);
  // Manual authoring uses the same support geometry, without AutoPack's
  // handling preferences. These projected records never enter the saved Pack.
  const physicalSupportRecords = manualGeometry
    ? projectManualGeometrySupportRecords(structural)
    : projectMaxCapacitySupportRecords(candidate, structural);
  const physicallySupported = wheelWell
    ? isWheelWellSupportedAndStable(
      aabb,
      physicalSupportRecords,
      wheelWell,
      manualGeometry ? null : { weight: candidate?.caseData?.weight }
    )
    : aabbIsSupported(candidate, aabb, structural, zones, tol, manualGeometry);
  return isAabbInsideTruckGeometry(aabb, zones, wheelWell) &&
    !aabbIntersectsWheelWellBlockedBody(aabb, truck) &&
    !aabbIntersectsFrontBonusBlockedBody(aabb, truck) &&
    !overlapsAny(aabb, (accepted || []).map(entry => entry.aabb)) &&
    physicallySupported &&
    evaluateFrontOverhangRearRetention(aabb, structural, truck, zones).retained;
}

// Candidate floor/deck/support bottom-Y levels under a footprint at its current
// X/Z, lowest first (so a safe snap chooses the lowest valid resting surface).
// Rigid wheel-well tops count as candidate resting levels too; the full
// validity check decides whether the combined support/stability rules pass.
function candidateSnapBottoms(curAabb, accepted, zones, tol = RECON_TOL, wheelWell = null) {
  const footprintArea = Math.max(1e-9, (curAabb.max.x - curAabb.min.x) * (curAabb.max.z - curAabb.min.z));
  const bottoms = [];
  for (const z of zones || []) {
    if (curAabb.min.x >= z.min.x - tol && curAabb.max.x <= z.max.x + tol &&
        curAabb.min.z >= z.min.z - tol && curAabb.max.z <= z.max.z + tol) {
      bottoms.push(z.min.y);
    }
  }
  for (const support of accepted || []) {
    if (support.collisionOnly) continue;
    if (reconXzOverlapArea(curAabb, support.aabb) >= 0.5 * footprintArea) {
      bottoms.push(support.aabb.max.y);
    }
  }
  for (const top of wheelWell ? wheelWell.tops : []) {
    if (reconXzOverlapArea(curAabb, top) > 0.05) bottoms.push(top.max.y);
  }
  return [...new Set(bottoms.map(b => Math.round(b * 1e6) / 1e6))].sort((a, b) => a - b);
}

// Toast-ready reasons for manual vertical placement outcomes, keyed by code.
const MANUAL_VERTICAL_REASONS = {
  'invalid-selection': 'Select one placed case to move vertically.',
  'staged-case': 'Staged cases cannot be moved vertically. Place the case in the truck first.',
  'already-resting': 'This case is already resting on the nearest valid surface.',
  'no-level-above': 'No valid support level above this case at its current spot.',
  'no-level-below': 'No valid support level below this case at its current spot.',
  'blocked-collision': 'Another case or a blocked zone is in the way.',
  'no-clearance-above': 'Not enough clearance above for this case.',
  'support-rules': 'The surface there cannot support this case (stacking or weight rules).',
  'needs-rear-retention': 'The raised deck needs rear retention at the step before this case can rest there.',
  'outside-truck': 'The requested position is outside the truck.',
};

function manualVerticalFailure(code) {
  return { ok: false, code, reason: MANUAL_VERTICAL_REASONS[code] || 'Cannot move this case vertically.' };
}

// Explain why the nearest rejected level failed, mirroring aabbIsFullyValid's
// factor order so the toast names the first hard rule that actually blocked it.
function explainInvalidLevel(node, aabb, accepted, zones, truck, wheelWell, mode, manualGeometry = false) {
  if (!isAabbInsideTruckGeometry(aabb, zones, wheelWell)) {
    return manualVerticalFailure(mode === 'up' ? 'no-clearance-above' : 'blocked-collision');
  }
  if (aabbIntersectsWheelWellBlockedBody(aabb, truck) ||
      aabbIntersectsFrontBonusBlockedBody(aabb, truck) ||
      overlapsAny(aabb, (accepted || []).map(entry => entry.aabb))) {
    return manualVerticalFailure('blocked-collision');
  }
  const structural = (accepted || []).filter(entry => !entry.collisionOnly);
  const physicalSupportRecords = manualGeometry
    ? projectManualGeometrySupportRecords(structural)
    : projectMaxCapacitySupportRecords(node, structural);
  const physicallySupported = wheelWell
    ? isWheelWellSupportedAndStable(
      aabb,
      physicalSupportRecords,
      wheelWell,
      manualGeometry ? null : { weight: node?.caseData?.weight }
    )
    : aabbIsSupported(node, aabb, structural, zones, RECON_TOL, manualGeometry);
  if (!physicallySupported) return manualGeometry
    ? { ok: false, code: 'unsupported', reason: 'This position has no stable physical support.' }
    : manualVerticalFailure('support-rules');
  if (!evaluateFrontOverhangRearRetention(aabb, structural, truck, zones).retained) {
    return manualVerticalFailure('needs-rear-retention');
  }
  return manualVerticalFailure('blocked-collision');
}

// Preserving a saved body does not certify its support path. New proposals may
// collide with it, but cannot rest on floating/unresolved/unstable cargo.
function qualifiedSupportIds(assessment, manualGeometry = false) {
  return new Set(assessment.measurements.bodies
    .filter(body => body.pathOutcome === 'PASS' &&
      (manualGeometry ? body.support?.coverage >= MIN_SUPPORT_FRACTION : body.loadedOutcome === 'PASS'))
    .map(body => body.id));
}

/**
 * Manual vertical placement resolver for ONE instance. Staged cases may use
 * only 'resolve' to test an in-truck drop; they cannot move vertically while
 * staged. Finds the next valid support level above/below at the current X/Z ('up'/'down'),
 * the nearest valid resting surface below ('drop'), or validates/corrects a
 * requested position ('resolve', with options.desiredPosition). Every candidate
 * level flows through the same candidateSnapBottoms + aabbIsFullyValid pipeline
 * used by reconciliation. exact:true on 'resolve' refuses vertical repair and
 * accepts only the requested pose, so a result can never fake support, penetrate blocked
 * wheel-well bodies, or bypass Front Overhang rear retention. Pure: reads the
 * given pack and never mutates state.
 */
export function findManualVerticalPlacement(pack, caseLibrary, instanceId, options = {}) {
  const mode = options && typeof options.mode === 'string' ? options.mode : '';
  const manualGeometry = options.manualGeometry === true;
  if (!['up', 'down', 'drop', 'resolve'].includes(mode)) return manualVerticalFailure('invalid-selection');
  const source = pack && typeof pack === 'object' ? pack : {};
  const truck = source.truck && typeof source.truck === 'object' ? source.truck : {};
  const zones = getTrailerUsableZones(truck);
  const wheelWell = getWheelWellGeometry(truck);
  const supportIds = qualifiedSupportIds(assessCommittedPack({ ...source, cases: source.cases || [] }, caseLibrary || []), manualGeometry);
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));

  let target = null;
  const accepted = [];
  for (const inst of (Array.isArray(source.cases) ? source.cases : [])) {
    if (!inst) continue;
    const isTarget = inst.id === instanceId;
    if (inst.placement === 'staged' && (!isTarget || mode !== 'resolve')) {
      if (isTarget) return manualVerticalFailure('staged-case');
      continue; // staged cargo sits outside the truck and is never an obstacle
    }
    const caseData = caseMap.get(inst.caseId);
    const pos = normalizeTransformPosition(inst.transform && inst.transform.position);
    const canonical = caseData ? getCanonicalInstanceEffectiveDims(inst, caseData) : { ok: false };
    if (!caseData || !pos || !canonical.ok) {
      if (isTarget) return manualVerticalFailure('invalid-selection');
      const collisionAabb = !caseData ? getTrustedUnresolvedPackedAabb(inst) : null;
      if (collisionAabb) accepted.push({ inst, aabb: collisionAabb, collisionOnly: true });
      continue; // untrusted geometry cannot participate as an obstacle
    }
    const node = {
      inst,
      caseData,
      canonical,
      dims: canonical.dims,
      curPos: pos,
      curAabb: makeAabb(pos, canonical.dims),
    };
    if (isTarget) target = node;
    else accepted.push({ ...node, aabb: node.curAabb, position: pos,
      collisionOnly: (!manualGeometry && !canonical.orientationAllowed) || !supportIds.has(inst.id) });
  }
  if (!target) return manualVerticalFailure('invalid-selection');
  if (!manualGeometry && !target.canonical.orientationAllowed) {
    return manualVerticalFailure('invalid-selection');
  }

  const dims = target.dims;
  let probe = target.curAabb;
  let referenceBottom = target.curAabb.min.y;
  let anchorX = target.curPos.x;
  let anchorZ = target.curPos.z;
  if (mode === 'resolve') {
    const desired = normalizeTransformPosition(options.desiredPosition);
    if (!desired) return manualVerticalFailure('invalid-selection');
    probe = makeAabb(desired, dims);
    referenceBottom = probe.min.y;
    anchorX = desired.x;
    anchorZ = desired.z;
    // Deliberate out-of-truck moves stay on the caller's legacy staging path.
    if (!(zones || []).some(z => reconXzOverlapArea(probe, z) > 0)) {
      return manualVerticalFailure('outside-truck');
    }
    if (options.rejectProposedCollisions === true &&
        overlapsAny(probe, accepted.map(entry => entry.aabb))) {
      return manualVerticalFailure('blocked-collision');
    }
    if (aabbIsFullyValid(target, probe, accepted, zones, truck, RECON_TOL, wheelWell, manualGeometry)) {
      return {
        ok: true,
        position: desired,
        fromBottom: target.curAabb.min.y,
        toBottom: probe.min.y,
        corrected: false,
      };
    }
    if (options.exact === true) {
      return explainInvalidLevel(target, probe, accepted, zones, truck, wheelWell, mode, manualGeometry);
    }
  }

  const levels = candidateSnapBottoms(probe, accepted, zones, RECON_TOL, wheelWell);
  let candidates;
  if (mode === 'up') {
    candidates = levels.filter(b => b > referenceBottom + RECON_TOL);
  } else if (mode === 'down') {
    candidates = levels.filter(b => b < referenceBottom - RECON_TOL).reverse();
  } else if (mode === 'drop') {
    candidates = levels.filter(b => b <= referenceBottom + RECON_TOL).reverse();
  } else {
    candidates = [...levels].sort((a, b) =>
      Math.abs(a - referenceBottom) - Math.abs(b - referenceBottom) || a - b);
  }

  if (!candidates.length) {
    if (mode === 'up') return manualVerticalFailure('no-level-above');
    if (mode === 'down' || mode === 'drop') return manualVerticalFailure('no-level-below');
    return manualVerticalFailure('blocked-collision');
  }

  for (const bottom of candidates) {
    const sPos = { x: anchorX, y: bottom + dims.height / 2, z: anchorZ };
    const sAabb = makeAabb(sPos, dims);
    if (!aabbIsFullyValid(target, sAabb, accepted, zones, truck, RECON_TOL, wheelWell, manualGeometry)) continue;
    if (mode === 'drop' && Math.abs(bottom - referenceBottom) <= RECON_TOL) {
      return manualVerticalFailure('already-resting');
    }
    return {
      ok: true,
      position: sPos,
      fromBottom: target.curAabb.min.y,
      toBottom: bottom,
      corrected: mode === 'resolve',
    };
  }

  // Nothing passed. Down keeps the honest "no legal level below" statement (the
  // current supporter blocks the column by construction); other modes explain
  // the nearest rejected level so the toast names the blocking hard rule.
  if (mode === 'down') return manualVerticalFailure('no-level-below');
  const nearest = candidates[0];
  const nearestAabb = makeAabb({ x: anchorX, y: nearest + dims.height / 2, z: anchorZ }, dims);
  return explainInvalidLevel(target, nearestAabb, accepted, zones, truck, wheelWell, mode, manualGeometry);
}

/**
 * PURE: revalidate every placed instance of `pack` against `nextTruck`. Returns
 * { nextPack, kept, adjusted, invalid, summary, acceptedAabbs } with NO mutation.
 * - kept: ids whose current placement is fully valid (kept exactly).
 * - adjusted: [{ id, fromY, toY }] safely snapped vertically (X/Z unchanged).
 * - invalid: ids that cannot be kept or safely snapped (left at current position
 *   in the result; the caller decides whether to stage them).
 */
export function reconcilePlacementsForTruck(pack, nextTruck, caseLibrary, options = {}) {
  const basePack = pack && typeof pack === 'object' ? pack : {};
  const manualGeometry = options.manualGeometry === true;
  const preserveStagedPositions = options.preserveStagedPositions === true;
  const zones = getTrailerUsableZones(nextTruck);
  const wheelWell = getWheelWellGeometry(nextTruck);
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const allInstances = Array.isArray(basePack.cases) ? basePack.cases : [];
  const indexById = new Map(allInstances.map((inst, i) => [inst, i]));
  const packedNodes = [];
  const stagedNodes = [];
  const unresolved = [];
  const malformed = [];
  const collisionOnly = [];

  for (const inst of allInstances) {
    const caseData = caseMap.get(inst && inst.caseId);
    const pos = normalizeTransformPosition(inst && inst.transform && inst.transform.position);
    if (!inst) continue;
    if (!caseData) {
      unresolved.push({ id: inst.id, caseId: inst.caseId, name: inst.name || inst.caseId || 'Unknown case',
        reason: 'missing-case-definition' });
      const aabb = getTrustedUnresolvedPackedAabb(inst);
      if (aabb) collisionOnly.push({ inst, aabb, collisionOnly: true });
      continue;
    }
    if (!pos) {
      malformed.push({ id: inst.id, caseId: inst.caseId, reason: 'missing or malformed position' });
      continue;
    }
    const canonical = getCanonicalInstanceEffectiveDims(inst, caseData);
    if (!canonical.ok) {
      malformed.push({ id: inst.id, caseId: inst.caseId, reason: canonical.reason });
      continue;
    }
    const canonicalInst = applyCanonicalInstancePose(inst, canonical);
    const node = {
      inst,
      canonicalInst,
      caseData,
      canonical,
      dims: canonical.dims,
      curPos: pos,
      curAabb: makeAabb(pos, canonical.dims),
    };
    if (inst.placement === 'staged') stagedNodes.push(node);
    else packedNodes.push(node); // hidden packed cargo remains physical cargo
  }

  const order = [...packedNodes].sort((x, y) =>
    (x.curAabb.min.y - y.curAabb.min.y) || (indexById.get(x.inst) - indexById.get(y.inst))
  );

  // A local edit reserves all unrelated cargo in place, even if it already
  // has a physical finding. Truck Change remains an explicitly whole-truck edit.
  const mutableIds = options.mutableInstanceIds;
  const fixedNodes = mutableIds instanceof Set
    ? packedNodes.filter(node => !mutableIds.has(node.inst.id)) : [];
  const accepted = [...collisionOnly, ...fixedNodes.map(node => ({
    ...node, aabb: node.curAabb, position: node.curPos,
    collisionOnly: (!manualGeometry && !node.canonical.orientationAllowed) || !options.fixedSupportIds?.has(node.inst.id),
  }))];
  const resultByInst = new Map();
  const kept = []; const adjusted = []; const invalid = [];
  const invalidReasons = {};

  for (const node of order) {
    const { inst, dims, curPos, canonical } = node;
    if (mutableIds instanceof Set && !mutableIds.has(inst.id)) {
      resultByInst.set(inst, { status: 'preserved', position: curPos, node });
      continue;
    }
    const proposed = options.changedInstanceIds instanceof Set && options.changedInstanceIds.has(inst.id);
    if (!proposed && options.causalChanges instanceof Set &&
        !options.dependencies.some(([support, child]) => child === inst.id && options.causalChanges.has(support))) {
      accepted.push({ ...node, aabb: node.curAabb, position: curPos,
        collisionOnly: (!manualGeometry && !canonical.orientationAllowed) || !options.fixedSupportIds?.has(inst.id) });
      resultByInst.set(inst, { status: 'preserved', position: curPos, node });
      continue;
    }
    const cargoSupports = accepted.filter(support => !support.collisionOnly &&
      Math.abs(node.curAabb.min.y - support.aabb.max.y) <= RECON_TOL &&
      reconXzOverlapArea(node.curAabb, support.aabb) > 0.05);
    const rigidSupport = aabbRestsOnZoneFloor(node.curAabb, zones) ||
      (wheelWell && isWheelWellSupportedAndStable(node.curAabb, [], wheelWell, { weight: node.caseData.weight }));
    const incompleteSupportMass = !rigidSupport && cargoSupports.length > 0 &&
      (node.caseData.weight == null || cargoSupports.some(support => support.caseData?.weight == null));
    // C3 introduces stricter source semantics, not a new saved-layout repair.
    // Preserve incompatible committed poses and mark reconciliation incomplete;
    // a new manual proposal still goes through the conservative placement gate.
    if (!proposed && ((!manualGeometry && !canonical.orientationAllowed) || (!manualGeometry && incompleteSupportMass))) {
      unresolved.push({ id: inst.id, caseId: inst.caseId,
        reason: !canonical.orientationAllowed ? 'saved orientation requires assessment' : 'support mass is unknown' });
      accepted.push({ ...node, aabb: node.curAabb, position: curPos });
      resultByInst.set(inst, { status: 'preserved', position: curPos, node });
      continue;
    }
    if (!manualGeometry && !canonical.orientationAllowed) {
      invalid.push(inst.id);
      invalidReasons[inst.id] = 'orientation violates the case policy';
      options.causalChanges?.add(inst.id);
      resultByInst.set(inst, { status: 'invalid', position: curPos, node });
      continue;
    }

    const currentAabb = makeAabb(curPos, dims);
    if (proposed && manualGeometry && options.rejectProposedCollisions &&
        overlapsAny(currentAabb, accepted.map(entry => entry.aabb))) {
      invalid.push(inst.id);
      invalidReasons[inst.id] = 'collides with another Case';
      resultByInst.set(inst, { status: 'invalid', position: curPos, node });
      continue;
    }
    if (aabbIsFullyValid(node, currentAabb, accepted, zones, nextTruck, RECON_TOL, wheelWell, manualGeometry)) {
      const entry = { ...node, aabb: currentAabb, position: curPos };
      accepted.push(entry);
      kept.push(inst.id);
      resultByInst.set(inst, { status: 'kept', position: curPos, node });
      continue;
    }

    // 2) Safe vertical snap: same X/Z, lowest valid floor/deck/support level.
    let snapped = null;
    for (const bottom of candidateSnapBottoms(node.curAabb, accepted, zones, RECON_TOL, wheelWell)) {
      const sPos = { x: curPos.x, y: bottom + dims.height / 2, z: curPos.z };
      const sAabb = makeAabb(sPos, dims);
      if (aabbIsFullyValid(node, sAabb, accepted, zones, nextTruck, RECON_TOL, wheelWell, manualGeometry)) {
        snapped = { pos: sPos, aabb: sAabb };
        break;
      }
    }
    if (snapped) {
      accepted.push({ ...node, aabb: snapped.aabb, position: snapped.pos });
      adjusted.push({ id: inst.id, fromY: curPos.y, toY: snapped.pos.y });
      options.causalChanges?.add(inst.id);
      resultByInst.set(inst, { status: 'adjusted', position: snapped.pos, node });
      continue;
    }

    // 3) Invalid — leave at current position; the user resolves it.
    invalid.push(inst.id);
    invalidReasons[inst.id] = !isAabbInsideTruckGeometry(currentAabb, zones, wheelWell)
      ? 'outside the truck boundaries'
      : aabbIntersectsWheelWellBlockedBody(currentAabb, nextTruck) ||
        aabbIntersectsFrontBonusBlockedBody(currentAabb, nextTruck)
        ? 'intersects a blocked truck body'
        : overlapsAny(currentAabb, accepted.map(entry => entry.aabb))
          ? 'collides with another Case'
          : 'has no stable physical support at this position';
    options.causalChanges?.add(inst.id);
    resultByInst.set(inst, { status: 'invalid', position: curPos, node });
  }

  // Existing staged cargo is outside the active load plan. Keep a safe staging
  // pose exactly; only repair it when it is floating, colliding, or inside the truck.
  const stagingAccepted = mutableIds instanceof Set
    ? stagedNodes.filter(node => !mutableIds.has(node.inst.id)).map(node => node.curAabb) : [];
  const stagedUnchanged = [];
  const stagedAdjusted = [];
  const stagedRepairs = [];
  const packedAabbs = accepted.map(entry => entry.aabb);
  const stagedOrder = [...stagedNodes].sort((a, b) => indexById.get(a.inst) - indexById.get(b.inst));
  for (const node of stagedOrder) {
    if (mutableIds instanceof Set && !mutableIds.has(node.inst.id)) {
      resultByInst.set(node.inst, { status: 'preserved', position: node.curPos, node });
      continue;
    }
    const current = node.curAabb;
    const insideTruck = overlapsAny(current, zones);
    const blockedBody = aabbIntersectsWheelWellBlockedBody(current, nextTruck) ||
      aabbIntersectsFrontBonusBlockedBody(current, nextTruck);
    const collidesStaged = overlapsAny(current, stagingAccepted);
    const collides = overlapsAny(current, [...packedAabbs, ...stagingAccepted]);
    const onFloor = Math.abs(current.min.y) <= RECON_TOL;
    const reachable = isAabbInSupportedStagingArea({ truck: basePack.truck }, current) ||
      isAabbInSupportedStagingArea({ truck: nextTruck }, current);
    if (preserveStagedPositions && !insideTruck && !blockedBody && !collidesStaged) {
      if (onFloor) {
        stagingAccepted.push(current);
        stagedUnchanged.push(node.inst.id);
        resultByInst.set(node.inst, { status: 'staged-unchanged', position: node.curPos, node });
        continue;
      }
      stagedRepairs.push({
        node,
        preferredPosition: { ...node.curPos, y: node.dims.height / 2 },
      });
      continue;
    }
    if (!insideTruck && !blockedBody && !collides && onFloor && reachable) {
      stagingAccepted.push(current);
      stagedUnchanged.push(node.inst.id);
      resultByInst.set(node.inst, { status: 'staged-unchanged', position: node.curPos, node });
      continue;
    }
    stagedRepairs.push({ node, preferredPosition: null });
  }

  // Reserve every byte-equivalent safe original before placing repairs. If an
  // early unsafe row is relocated immediately, its provisional pose can occupy
  // a later safe row and falsely cascade the whole inventory into corrections.
  for (const repair of stagedRepairs) {
    const { node, preferredPosition } = repair;
    const acceptedForRepair = [...packedAabbs, ...stagingAccepted];
    let staged = null;
    if (preferredPosition) {
      const preferredAabb = makeAabb(preferredPosition, node.dims);
      const preferredInsideTruck = overlapsAny(preferredAabb, zones);
      const preferredBlockedBody = aabbIntersectsWheelWellBlockedBody(preferredAabb, nextTruck) ||
        aabbIntersectsFrontBonusBlockedBody(preferredAabb, nextTruck);
      if (!preferredInsideTruck && !preferredBlockedBody && !overlapsAny(preferredAabb, acceptedForRepair)) {
        staged = { position: preferredPosition, aabb: preferredAabb };
      }
    }
    if (!staged) {
      staged = findSafeStagingPosition(
        { truck: nextTruck },
        node.dims,
        acceptedForRepair
      );
    }
    stagingAccepted.push(staged.aabb);
    stagedAdjusted.push(node.inst.id);
    resultByInst.set(node.inst, { status: 'staged-adjusted', position: staged.position, node });
  }

  const nextCases = allInstances.map(inst => {
    const r = resultByInst.get(inst);
    if (r?.status === 'preserved' || (mutableIds instanceof Set && !mutableIds.has(inst.id))) return inst;
    if (mutableIds instanceof Set && r?.status === 'kept') return inst;
    if (!r) {
      if (inst && inst.placement === 'staged' && inst.packedProfile !== undefined) {
        const next = Utils.deepClone(inst);
        delete next.packedProfile;
        return next;
      }
      return inst; // unresolved/malformed are preserved and block confirmation
    }
    const next = applyCanonicalInstancePose(inst, r.node.canonical);
    next.transform.position = r.position;
    next.placement = r.status.startsWith('staged') ? 'staged' : 'packed';
    if (next.placement === 'staged') delete next.packedProfile;
    return next;
  });

  return {
    nextPack: { ...basePack, truck: nextTruck, cases: nextCases },
    kept,
    adjusted,
    invalid,
    invalidReasons,
    stagedUnchanged,
    stagedAdjusted,
    unresolved,
    malformed,
    summary: {
      kept: kept.length,
      adjusted: adjusted.length,
      invalid: invalid.length,
      stagedUnchanged: stagedUnchanged.length,
      stagedAdjusted: stagedAdjusted.length,
      unresolved: unresolved.length,
      malformed: malformed.length,
    },
    acceptedPlacements: accepted,
    acceptedAabbs: accepted.map(entry => entry.aabb),
    stagingAabbs: stagingAccepted,
  };
}

export function stagePlacementIds(pack, ids, nextTruck, caseLibrary, options = {}) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const targetSet = new Set(ids || []);
  const cases = (pack && pack.cases) || [];
  const grouped = options.grouped === true;
  const stagingCanonical = inst => options.preserveRotation === true
    ? getCanonicalInstanceEffectiveDims(inst, caseMap.get(inst.caseId))
    : getDeterministicStagingCanonical(caseMap.get(inst.caseId));
  const accepted = [];
  for (const inst of cases) {
    if (!inst || targetSet.has(inst.id)) continue;
    const canonical = getCanonicalInstanceEffectiveDims(inst, caseMap.get(inst.caseId));
    const pos = normalizeTransformPosition(inst.transform && inst.transform.position);
    if (canonical.ok && pos) {
      accepted.push(makeAabb(pos, canonical.dims));
    } else if (grouped && pos && hasPositiveFiniteDims(inst.orientedDims)) {
      // A preserved unresolved instance can still be a real obstacle when it
      // carries explicit physical dimensions. Never invent fallback geometry.
      accepted.push(makeAabb(pos, inst.orientedDims));
    }
  }
  const targets = cases
    .map((inst, index) => ({ inst, index }))
    .filter(e => targetSet.has(e.inst.id))
    .sort((a, b) =>
      String(a.inst.caseId).localeCompare(String(b.inst.caseId)) || a.index - b.index);

  const positioned = new Map();
  const preservedMissingIds = new Set();
  const stagedIds = [];
  const failedIds = [];
  const warnings = [];
  if (grouped) {
    const layout = getStagingLayout(nextTruck);
    const groupsByCaseId = new Map();
    for (const entry of targets) {
      if (options.preserveMissingDefinitions === true && !caseMap.has(entry.inst.caseId)) {
        // Truck Change cannot validate or rearrange a Case with no definition.
        // Retain its source pose; explicit stored bounds can still reserve space
        // for the Cases whose geometry is known and can be staged safely.
        preservedMissingIds.add(entry.inst.id);
        stagedIds.push(entry.inst.id);
        const pos = normalizeTransformPosition(entry.inst.transform && entry.inst.transform.position);
        if (pos && hasPositiveFiniteDims(entry.inst.orientedDims)) {
          accepted.push(makeAabb(pos, entry.inst.orientedDims));
        }
        continue;
      }
      const canonical = stagingCanonical(entry.inst);
      if (!canonical.ok) {
        failedIds.push(entry.inst.id);
        warnings.push(`Item ${entry.inst.id} could not be staged: ${canonical.reason}.`);
        continue;
      }
      const key = JSON.stringify([entry.inst.caseId, canonical.dims]);
      if (!groupsByCaseId.has(key)) groupsByCaseId.set(key, { key, canonical, entries: [] });
      groupsByCaseId.get(key).entries.push({ ...entry, canonical });
    }

    const groups = [...groupsByCaseId.values()].sort((a, b) =>
      (b.canonical.dims.length * b.canonical.dims.width) -
        (a.canonical.dims.length * a.canonical.dims.width) ||
      a.key.localeCompare(b.key)
    );
    for (const group of groups) {
      group.entries.sort((a, b) =>
        String(a.inst.id || '').localeCompare(String(b.inst.id || '')) || a.index - b.index
      );
      const dims = group.canonical.dims;
      const cellLength = dims.length + layout.gap;
      const cellWidth = dims.width + layout.gap;
      const cols = Math.max(1, Math.floor((layout.truckL + layout.gap) / Math.max(1, cellLength)));
      const rows = Math.ceil(group.entries.length / cols);
      const usedCols = Math.min(cols, group.entries.length);
      const bandDims = {
        length: usedCols * dims.length + Math.max(0, usedCols - 1) * layout.gap,
        width: rows * dims.width + Math.max(0, rows - 1) * layout.gap,
        height: dims.height,
      };
      // Reserve the whole caseId rectangle as one obstacle. If its nominal band
      // is blocked, findSafeStagingPosition shifts the complete band instead of
      // letting individual cases scatter into unrelated holes.
      const band = findSafeStagingPosition({ truck: nextTruck }, bandDims, accepted);
      if (!band || !band.aabb || !isAabbInSupportedStagingArea({ truck: nextTruck }, band.aabb)) {
        for (const { inst } of group.entries) {
          failedIds.push(inst.id);
          warnings.push(`Item ${inst.id} could not be staged inside the supported staging area.`);
        }
        continue;
      }
      accepted.push({
        min: { ...band.aabb.min },
        max: {
          ...band.aabb.max,
          x: band.aabb.max.x + layout.gap,
          z: band.aabb.max.z + layout.gap,
        },
      });
      for (let index = 0; index < group.entries.length; index += 1) {
        const { inst, canonical } = group.entries[index];
        const col = index % cols;
        const row = Math.floor(index / cols);
        const position = {
          x: band.aabb.min.x + dims.length / 2 + col * cellLength,
          y: dims.height / 2,
          z: band.aabb.min.z + dims.width / 2 + row * cellWidth,
        };
        positioned.set(inst.id, { position, canonical });
        stagedIds.push(inst.id);
      }
    }
  } else {
    for (const { inst } of targets) {
      // Staging is a visual holding area, not a packed orientation decision. Use
      // one deterministic identity pose so the placement AABB, rendered footprint,
      // and stored rotation/dimensions cannot inherit a prior packed orientation.
      const canonical = stagingCanonical(inst);
      if (!canonical.ok) {
        failedIds.push(inst.id);
        warnings.push(`Item ${inst.id} could not be staged: ${canonical.reason}.`);
        continue;
      }
      const staged = findSafeStagingPosition({ truck: nextTruck }, canonical.dims, accepted);
      accepted.push(staged.aabb);
      positioned.set(inst.id, { position: staged.position, canonical });
      stagedIds.push(inst.id);
    }
  }

  const nextCases = cases.map(inst => {
    if (preservedMissingIds.has(inst.id)) {
      const next = Utils.deepClone(inst);
      next.placement = 'staged';
      delete next.packedProfile;
      return next;
    }
    const staged = positioned.get(inst.id);
    if (!staged) {
      if (inst && inst.placement === 'staged' && inst.packedProfile !== undefined) {
        const next = Utils.deepClone(inst);
        delete next.packedProfile;
        return next;
      }
      return inst;
    }
    const next = options.preserveRotation === true
      ? Utils.deepClone(inst) : applyCanonicalInstancePose(inst, staged.canonical);
    next.transform.position = staged.position;
    next.placement = 'staged';
    delete next.packedProfile;
    return next;
  });
  return {
    pack: { ...pack, truck: nextTruck, cases: nextCases },
    stagedIds,
    failedIds,
    warnings,
  };
}

// Compatibility entry point for older callers. Reading saved source never repairs it.
export function repairRestoredPackPlacements(pack) {
  return pack;
}

/**
 * Local repair of reconciliation-invalid placements: try to re-settle each
 * affected case INSIDE the truck (same X/Z drop first, then nearby legal
 * anchors) through the full aabbIsFullyValid pipeline before staging is even
 * considered. Never moves valid placements; never rearranges the load.
 * Returns updated cases plus the ids repaired and the ids still invalid.
 */
function repairInvalidPlacementsLocally(reconResult, truck, caseLibrary, manualGeometry = false) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const zones = getTrailerUsableZones(truck);
  const wheelWell = getWheelWellGeometry(truck);
  const invalidSet = new Set(reconResult.invalid || []);
  const accepted = [...(reconResult.acceptedPlacements || [])];
  const cases = (reconResult.nextPack && reconResult.nextPack.cases) || [];

  const nodes = cases
    .map((inst, index) => ({ inst, index }))
    .filter(entry => invalidSet.has(entry.inst.id))
    .map(entry => {
      const caseData = caseMap.get(entry.inst.caseId);
      const canonical = getCanonicalInstanceEffectiveDims(entry.inst, caseData);
      const position = normalizeTransformPosition(entry.inst.transform && entry.inst.transform.position);
      if (!caseData || !canonical.ok ||
          (!manualGeometry && !canonical.orientationAllowed) ||
          !position) {
        return null;
      }
      return {
        id: entry.inst.id,
        inst: entry.inst,
        caseData,
        canonical,
        dims: canonical.dims,
        position,
        index: entry.index,
      };
    })
    .filter(Boolean)
    // Bottom-up so lower dependents become support for the ones above them.
    .sort((a, b) => (a.position.y - b.position.y) || (a.index - b.index));

  const positioned = new Map();
  const { repaired } = repairDependentPlacements(nodes, {
    zones,
    neighborAabbs: () => accepted.map(entry => entry.aabb),
    bottomsFor: (node, x, z) => {
      const probe = makeAabb({ x, y: node.dims.height / 2, z }, node.dims);
      return candidateSnapBottoms(probe, accepted, zones, RECON_TOL, wheelWell);
    },
    validate: (node, position) => {
      const aabb = makeAabb(position, node.dims);
      return aabbIsFullyValid(node, aabb, accepted, zones, truck, RECON_TOL, wheelWell, manualGeometry);
    },
    onRepaired: (node, position) => {
      const aabb = makeAabb(position, node.dims);
      accepted.push({ ...node, aabb, position });
      positioned.set(node.id, { position, canonical: node.canonical });
    },
  });

  const nextCases = cases.map(inst => {
    const entry = positioned.get(inst.id);
    if (!entry) return inst;
    const next = applyCanonicalInstancePose(inst, entry.canonical);
    next.transform.position = entry.position;
    next.placement = 'packed';
    return next;
  });

  const repairedIds = repaired.map(entry => entry.id);
  const repairedSet = new Set(repairedIds);
  return {
    pack: { ...reconResult.nextPack, cases: nextCases },
    repairedIds,
    stillInvalidIds: (reconResult.invalid || []).filter(id => !repairedSet.has(id)),
  };
}

// ============================================================================
// SECTION: HANDLING-RULES CASE-CHANGE PROPAGATION (P0-A)
//
// A Case is a shared definition; packed Load Plan instances reference it by
// caseId. Editing a placement-affecting rule, dimension, or weight can make an
// already-packed Load Plan illegal without moving cargo out from under the
// user's feet. This section owns Case change detection and atomic Case edits.
// C4 derives assessment separately and never repairs a Pack on Case Save.
// ============================================================================

const HANDLING_RULES_SIGNATURE_VERSION = 'v1';

// Semantic fingerprint of one Case's placement-affecting Handling Rules, built
// from the EFFECTIVE validation semantics (canonicalOrientationLock,
// rulesAllowStackOnTop, rulesMaxStackCount — the same shared authorities
// AutoPack/manual revalidation already consult), never from raw stored values.
// Two storage representations with identical hard-rule behavior (e.g. the
// legacy stackable/noStackOnTop aliases) therefore always fingerprint
// identically. The historical fingerprint remains only for compatibility.
// maxPalletWeight, laneItem, loadPriority, and shape do not define
// existing manual packed-placement validity and are intentionally excluded.
function handlingRuleSemanticFingerprint(caseData) {
  const lock = canonicalOrientationLock(caseData && caseData.orientationLock);
  const allowStackOnTop = rulesAllowStackOnTop(caseData || {});
  const maxStackCount = rulesMaxStackCount(caseData || {});
  const isPallet = Boolean(caseData && caseData.isPallet === true);
  return `${lock}:${allowStackOnTop ? 1 : 0}:${maxStackCount}:${isPallet ? 1 : 0}`;
}

// Match the dimensions and weight CaseLibrary actually stores (and manual
// revalidation consumes), so equivalent raw strings and clamped values do not
// create false placement impacts. Keep these out of the persisted v1 signature:
// existing signed Packs must stay current until a future Case edit affects them.
function placementAffectingCaseFingerprint(caseData) {
  const dims = caseData && caseData.dimensions || {};
  return JSON.stringify([
    handlingRuleSemanticFingerprint(caseData),
    parseCargoDimension(dims.length).value,
    parseCargoDimension(dims.width).value,
    parseCargoDimension(dims.height).value,
    parseCaseMass(caseData && caseData.weight).value,
  ]);
}

// A Case-modal Save converts its rounded display values back to inches/lb.
// Restore an old canonical value only when both values present identically in
// the units and precision the user actually saw. This prevents a metadata-only
// Save from silently drifting stored geometry or weight, while a one-step edit
// in any supported display unit remains a physical change. Other callers keep
// exact canonical comparison by omitting modalUnits.
function preserveCaseModalRoundTrips(oldCase, newCase, modalUnits) {
  if (!oldCase || !newCase || !modalUnits) return newCase;
  const oldDims = oldCase.dimensions || {};
  const proposedDims = newCase.dimensions || {};
  let nextDims = proposedDims;
  let nextWeight = newCase.weight;
  let changed = false;

  if (Utils.lengthUnits.includes(modalUnits.lengthUnit)) {
    for (const axis of ['length', 'width', 'height']) {
      const oldValue = parseCargoDimension(oldDims[axis]).value;
      const proposedValue = parseCargoDimension(proposedDims[axis]).value;
      const display = value => Utils.formatCaseModalNumber(Utils.inchesToUnit(value, modalUnits.lengthUnit), modalUnits.lengthUnit);
      if (oldValue !== proposedValue && display(oldValue) === display(proposedValue)) {
        if (nextDims === proposedDims) nextDims = { ...proposedDims };
        nextDims[axis] = oldValue;
        changed = true;
      }
    }
  }

  if (Utils.weightUnits.includes(modalUnits.weightUnit)) {
    const oldValue = parseCaseMass(oldCase.weight).value;
    const proposedValue = parseCaseMass(newCase.weight).value;
    const display = value => Utils.formatCaseModalWeightNumber(Utils.poundsToUnit(value, modalUnits.weightUnit));
    if (oldValue != null && proposedValue != null &&
        oldValue !== proposedValue && display(oldValue) === display(proposedValue)) {
      nextWeight = oldValue;
      changed = true;
    }
  }

  return changed ? { ...newCase, dimensions: nextDims, weight: nextWeight } : newCase;
}

// Historical API name retained for callers. A missing oldCase (new Case
// creation, or a caseId no longer in the library) is not a change.
export function hasPlacementAffectingHandlingRuleChange(oldCase, newCase, modalUnits = null) {
  if (!oldCase) return false;
  return placementAffectingCaseFingerprint(oldCase) !==
    placementAffectingCaseFingerprint(preserveCaseModalRoundTrips(oldCase, newCase, modalUnits));
}

// Handling Rules ACTIVE-LOAD membership authority: does this instance
// currently belong to the set of cargo whose Case Handling Rules govern a
// Pack's validity signature? This answers ONLY "is this part of the active
// truck load," never "is this placement currently fully legal" — support,
// collision, rear retention, and orientation legality are deliberately never
// consulted here; those remain revalidateManualPlacements' job.
//
// - Explicit staged state always wins: placement === 'staged' is NEVER a
//   member, even if its saved pose happens to overlap usable truck geometry.
//   Physical geometry must not override an explicit staged workflow state.
// - A non-staged instance participates only when its current geometry
//   physically occupies usable truck geometry — reusing the same shape-aware
//   (Wheel Wells / Front Overhang blocked-body) containment authority
//   getPlacementForAabb already uses for new-instance placement.
// - A non-staged instance that cannot be safely classified (missing Case
//   definition, missing/malformed position, malformed/unresolved dimensions,
//   or a Pack whose truck has no usable geometry) is conservatively treated
//   as an ACTIVE member so it is never silently dropped from Handling Rules
//   coverage. No fallback geometry (e.g. the origin, or a zero-size truck) is
//   ever invented to force a classification.
//
// getTrailerUsableZones()/getPlacementForAabb() treat a missing/malformed
// truck as having no usable zones at all, which would otherwise make every
// non-staged instance classify as physically "outside" — the opposite of
// conservative. hasUsableTruckGeometry() is checked first so a truck-less or
// zero/negative/non-finite-dimension Pack never reaches that path.
function hasUsableTruckGeometry(truck) {
  if (!truck || typeof truck !== 'object') return false;
  const length = Number(truck.length);
  const width = Number(truck.width);
  const height = Number(truck.height);
  return Number.isFinite(length) && length > 0 &&
    Number.isFinite(width) && width > 0 &&
    Number.isFinite(height) && height > 0;
}

function createHandlingRulesMembershipClassifier(pack, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const truckUsable = hasUsableTruckGeometry(pack && pack.truck);
  return inst => {
    if (!inst || inst.placement === 'staged') return false;
    const caseData = caseMap.get(inst.caseId);
    if (!caseData) return true;
    const pos = normalizeTransformPosition(inst.transform && inst.transform.position);
    if (!pos) return true;
    const canonical = getCanonicalInstanceEffectiveDims(inst, caseData);
    if (!canonical.ok) return true;
    if (!truckUsable) return true;
    const aabb = makeAabb(pos, canonical.dims);
    return getPlacementForAabb(pack, aabb) === 'packed';
  };
}

// Legacy fingerprint compatibility helper; never physical or persisted authority.
// Deterministic per-Pack signature of the placement-affecting Handling Rules
// currently governing every ACTIVE-LOAD (see createHandlingRulesMembershipClassifier)
// instance's Case. Explicitly staged instances are excluded: a staged item has
// no current truck placement to invalidate, and will be evaluated against
// whatever rules are live if/when it is later packed. Deterministic
// regardless of Case Library or instance ordering (unique caseIds, sorted).
export function buildHandlingRulesValiditySignature(pack, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const isActiveLoadMember = createHandlingRulesMembershipClassifier(pack, caseLibrary);
  const activeCaseIds = Array.from(new Set(
    ((pack && pack.cases) || [])
      .filter(inst => inst && inst.caseId && isActiveLoadMember(inst))
      .map(inst => String(inst.caseId))
  )).sort();
  const parts = activeCaseIds.map(caseId => {
    const caseData = caseMap.get(caseId);
    if (!caseData) return `${caseId}:missing`;
    return `${caseId}:${handlingRuleSemanticFingerprint(caseData)}`;
  });
  return `${HANDLING_RULES_SIGNATURE_VERSION}:${parts.join('|')}`;
}

// Compatibility adapter for existing review indicators (including report copy).
// Legacy certificates never determine current physical state or eligibility.
export function isHandlingRulesValidationRequired(pack, caseLibrary = CaseLibrary.getCases()) {
  if (!pack) return false;
  const assessment = assessCommittedPack(pack, caseLibrary);
  return assessment.primary !== 'VALID' || assessment.eligibility.state === 'blocked';
}

// A Case Save commits the shared definition and optional category only. Every
// referencing Pack keeps its source exactly; its next assessment sees the edit.
export function commitCaseHandlingRuleChange(caseData, categoryUpdate, modalUnits = null) {
  const oldCaseLibrary = CaseLibrary.getCases();
  const oldCase = oldCaseLibrary.find(c => c && c.id === (caseData && caseData.id)) || null;
  const canonicalInput = preserveCaseModalRoundTrips(oldCase, caseData, modalUnits);
  const { case: nextCase, cases: nextCaseLibrary } = CaseLibrary.prepareCaseSave(canonicalInput, oldCaseLibrary);

  const setPatch = { caseLibrary: nextCaseLibrary };
  let category = null;
  if (categoryUpdate) {
    const calculated = CategoryService.calculateUpsert(categoryUpdate);
    category = calculated.category;
    if (calculated.preferences) setPatch.preferences = calculated.preferences;
  }

  StateStore.set(setPatch);
  return { case: nextCase, category, packImpact: null };
}

// Atomic Case Deletion orchestration (single or bulk). Removes the Case
// definition(s) AND every instance referencing them (packed, staged, hidden,
// grouped or not) from every Load Plan, repairs/stages any remaining cargo
// that physically depended on the removed cargo, and publishes Case Library +
// Pack Library through exactly one StateStore.set() so one Undo/Redo covers the
// whole deletion. The full next state is built BEFORE publishing: an
// unexpected throw leaves the store untouched.
export function commitCaseDeletion(caseIds) {
  const oldCaseLibrary = CaseLibrary.getCases();
  const requested = new Set((Array.isArray(caseIds) ? caseIds : [caseIds]).filter(id => id != null));
  const deletedCaseIds = oldCaseLibrary
    .filter(c => c && requested.has(c.id))
    .map(c => c.id);
  const result = { deletedCaseIds, removedInstanceCount: 0, packImpacts: [] };
  if (!deletedCaseIds.length) return result;

  const deletedSet = new Set(deletedCaseIds);
  const nextCaseLibrary = oldCaseLibrary.filter(c => !(c && deletedSet.has(c.id)));
  const now = Date.now();
  const packs = getPacks();

  const nextPacks = packs.map(p => {
    const cases = Array.isArray(p && p.cases) ? p.cases : [];
    const targets = cases.filter(inst => inst && deletedSet.has(inst.caseId));
    if (!targets.length) return p;

    const remaining = cases.filter(inst => !(inst && deletedSet.has(inst.caseId)));
    const impact = {
      packId: p.id,
      removedInstanceCount: targets.length,
      revalidated: false,
      validationComplete: null,
      repositionedCount: 0,
      stagedCount: 0,
    };
    result.removedInstanceCount += targets.length;
    result.packImpacts.push(impact);

    // Same active-load membership authority buildHandlingRulesValiditySignature
    // uses: only a physically-outside instance (explicit staged, or non-staged
    // but not physically inside truck geometry) is exempt from being packed
    // cargo/support. Classified against the PRE-deletion Case Library — the
    // Cases being deleted must still resolve for their own removed instances.
    const isActiveLoadMember = createHandlingRulesMembershipClassifier(p, oldCaseLibrary);
    if (!targets.some(inst => isActiveLoadMember(inst))) {
      const stagedOnly = CoreNormalizer.sanitizeLegacyPackQuantityFields({ ...p, cases: remaining, lastEdited: now });
      stagedOnly.stats = computeStats(stagedOnly, nextCaseLibrary);
      return stagedOnly;
    }

    const revalidation = revalidateManualPlacements({ ...p, cases: remaining }, nextCaseLibrary, {
      repairDependents: true,
      preserveStagedPositions: true,
      beforePack: p,
      beforeCaseLibrary: oldCaseLibrary,
    });
    const next = CoreNormalizer.sanitizeLegacyPackQuantityFields({ ...revalidation.pack, lastEdited: now });
    next.stats = computeStats(next, nextCaseLibrary);

    impact.revalidated = true;
    impact.validationComplete = revalidation.validationComplete === true;
    // A vertical snap is reported as "adjusted", a local re-settle as
    // "repaired"; either way the cargo was repositioned but kept packed.
    impact.repositionedCount = (revalidation.adjustedIds || []).length + (revalidation.repairedIds || []).length;
    impact.stagedCount = (revalidation.stagedIds || []).length;
    return next;
  });

  const setPatch = { caseLibrary: nextCaseLibrary };
  // Deleting the last Case(s) is the authoritative empty-library transition:
  // the Default-only category reset rides in this same write (one Undo step),
  // so the Cases screen and Editor Case Browser can render it read-only.
  const emptyLibraryPreferences = CategoryService.calculateResetToDefaultIfNoCases(nextCaseLibrary);
  if (emptyLibraryPreferences) setPatch.preferences = emptyLibraryPreferences;
  if (result.packImpacts.length) {
    setPatch.packLibrary = nextPacks;

    // selectedInstanceIds is transient (not part of the Undo history slice) and
    // screen navigation does not clear it, so deleted instances of the Pack open
    // in the Editor would otherwise linger in a multi-selection. Prune only IDs
    // that no longer exist in that Pack, inside the same single write.
    const selected = StateStore.get('selectedInstanceIds');
    const currentPackId = StateStore.get('currentPackId');
    const currentPack = currentPackId ? nextPacks.find(p => p && p.id === currentPackId) : null;
    if (currentPack && Array.isArray(selected) && selected.length) {
      const surviving = new Set((currentPack.cases || []).filter(Boolean).map(inst => inst.id));
      const keptSelection = selected.filter(id => surviving.has(id));
      if (keptSelection.length !== selected.length) setPatch.selectedInstanceIds = keptSelection;
    }
  }

  StateStore.set(setPatch);
  return result;
}

// Completeness concerns packed placements only; staged integrity diagnostics
// remain available without blocking an otherwise complete explicit mutation.
export function getPackedReconciliationCompleteness(pack, reconciliation, failedIds = []) {
  const packedIds = new Set((pack.cases || []).filter(inst => inst && inst.placement === 'packed').map(inst => inst.id));
  const unresolved = reconciliation.unresolved || [];
  const malformed = reconciliation.malformed || [];
  const packedUnresolved = unresolved.filter(entry => packedIds.has(entry.id));
  const packedMalformed = malformed.filter(entry => packedIds.has(entry.id));
  return {
    unresolved,
    malformed,
    packedUnresolved,
    packedMalformed,
    validationComplete: failedIds.length === 0 && packedUnresolved.length === 0 && packedMalformed.length === 0,
  };
}

// Mutation authority follows actual pre-edit support/blocking contacts. Hidden
// cargo participates, staged cargo does not. Missing geometry yields no invented
// contact. A connected item is kept exactly if its current pose is still safe.
function manualMutationScope(beforePack, proposedPack, beforeCases, explicitIds, manualGeometry = false) {
  const before = new Map((beforePack?.cases || []).map(inst => [inst.id, inst]));
  const after = new Map((proposedPack.cases || []).map(inst => [inst.id, inst]));
  const changed = new Set(explicitIds || []);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id);
    if (!a || !b || a.caseId !== b.caseId || a.placement !== b.placement ||
        JSON.stringify(a.transform) !== JSON.stringify(b.transform)) changed.add(id);
  }
  const mutable = new Set(changed);
  const physicalChanges = new Set([...changed].filter(id => {
    const a = before.get(id), b = after.get(id);
    if (!a || !b || a.placement !== b.placement || a.caseId !== b.caseId) return true;
    const caseData = beforeCases.find(c => c.id === a.caseId);
    const oldDims = getCanonicalInstanceEffectiveDims(a, caseData);
    const newDims = getCanonicalInstanceEffectiveDims(b, caseData);
    return JSON.stringify(a.transform?.position) !== JSON.stringify(b.transform?.position) ||
      JSON.stringify(oldDims.dims) !== JSON.stringify(newDims.dims);
  }));
  const dependencies = [];
  const assessment = assessCommittedPack(beforePack, beforeCases);
  const supportIds = qualifiedSupportIds(assessment, manualGeometry);
  if (!physicalChanges.size) return { changed, mutable, physicalChanges, dependencies, supportIds };
  dependencies.push(...assessment.measurements.supportGraph.edges.map(edge => [edge.to, edge.from]));
  for (const finding of assessment.hard) {
    if (finding.property !== 'front-overhang.rear-blocking') continue;
    for (const contact of [...(finding.evidence.contacts || []), ...(finding.evidence.uncertain || [])]) {
      dependencies.push([contact.id, finding.subject]);
    }
  }
  const queue = [...physicalChanges];
  for (let index = 0; index < queue.length; index += 1) {
    for (const [support, child] of dependencies) {
      if (support !== queue[index] || mutable.has(child)) continue;
      mutable.add(child);
      queue.push(child);
    }
  }
  return { changed, mutable, physicalChanges, dependencies, supportIds };
}

export function revalidateManualPlacements(pack, caseLibrary, options = {}) {
  const source = pack && typeof pack === 'object' ? pack : {};
  const truck = source.truck && typeof source.truck === 'object' ? source.truck : {};
  const manualGeometry = options.manualGeometry === true;
  const beforePack = options.beforePack || getById(source.id) || source;
  const scope = manualMutationScope(beforePack, source, options.beforeCaseLibrary || caseLibrary, options.changedInstanceIds, manualGeometry);
  const stagedBefore = new Set((beforePack.cases || []).filter(inst => inst.placement === 'staged').map(inst => inst.id));
  const definitions = new Map((caseLibrary || []).map(definition => [definition.id, definition]));
  const zones = getTrailerUsableZones(truck);
  const proposed = { ...source, cases: (source.cases || []).map(inst => {
    if (!scope.changed.has(inst.id) || !stagedBefore.has(inst.id) || inst.placement !== 'packed') return inst;
    const position = normalizeTransformPosition(inst.transform?.position);
    const geometry = getCanonicalInstanceEffectiveDims(inst, definitions.get(inst.caseId));
    if (!position || !geometry.ok) return inst;
    const aabb = makeAabb(position, geometry.dims);
    // An outside staged drop stays staging. It must not become an implicit
    // local repack into the truck; untouched saved source is never classified.
    return zones.some(zone => reconXzOverlapArea(aabb, zone) > 0) ? inst : { ...inst, placement: 'staged' };
  }) };
  const reconciliation = reconcilePlacementsForTruck(proposed, truck, caseLibrary, {
    preserveStagedPositions: options.preserveStagedPositions !== false,
    changedInstanceIds: scope.changed,
    mutableInstanceIds: scope.mutable,
    causalChanges: scope.physicalChanges,
    dependencies: scope.dependencies,
    fixedSupportIds: scope.supportIds,
    manualGeometry,
    rejectProposedCollisions: options.rejectProposedCollisions === true,
  });
  let nextPack = reconciliation.nextPack;
  let stagedIds = [];
  let failedIds = [];
  let warnings = [];
  let repairedIds = [];
  let invalidForStaging = reconciliation.invalid || [];

  // Local repair before staging (delete/removal path): re-settle affected
  // dependents inside the truck when legally possible so removing one box
  // never ejects cargo that still has a valid nearby resting place.
  if (options.repairDependents === true && invalidForStaging.length) {
    const repair = repairInvalidPlacementsLocally(reconciliation, truck, caseLibrary, manualGeometry);
    nextPack = repair.pack;
    repairedIds = repair.repairedIds;
    invalidForStaging = repair.stillInvalidIds;
  }

  if (invalidForStaging.length) {
    const staged = stagePlacementIds(nextPack, invalidForStaging, truck, caseLibrary);
    nextPack = staged.pack;
    stagedIds = staged.stagedIds;
    failedIds = staged.failedIds;
    warnings = staged.warnings || [];
  }

  // Staging helpers may rebuild caches. A local action has no write authority
  // over any other row, including unrelated malformed/staged source.
  nextPack = { ...nextPack, cases: nextPack.cases.map(inst => scope.mutable.has(inst.id)
    ? inst : source.cases.find(original => original.id === inst.id)) };
  return {
    pack: nextPack,
    ...getPackedReconciliationCompleteness(source, reconciliation, failedIds),
    adjustedIds: (reconciliation.adjusted || []).map(entry => entry.id),
    repairedIds,
    stagedIds,
    failedIds,
    warnings,
    invalidIds: reconciliation.invalid || [],
    invalidReasons: reconciliation.invalidReasons || {},
    summary: {
      adjusted: (reconciliation.adjusted || []).length,
      repaired: repairedIds.length,
      staged: stagedIds.length,
      failed: failedIds.length,
    },
  };
}

export function updateCasesWithManualRevalidation(packId, nextCases, caseLibrary = CaseLibrary.getCases(), options = {}) {
  const pack = getById(packId);
  if (!pack) return null;
  const proposed = { ...pack, cases: Array.isArray(nextCases) ? nextCases : [] };
  const result = revalidateManualPlacements(proposed, caseLibrary, { ...options, beforePack: pack });
  const patch = { cases: result.pack.cases };
  const updated = update(packId, patch);
  return { ...result, pack: updated || result.pack };
}

// Explicit Check is a read: no source write, history entry or certification.
export function validateLoadPlan(packId, caseLibrary = CaseLibrary.getCases()) {
  const pack = getById(packId);
  return pack ? assessCommittedPack(pack, caseLibrary) : null;
}


export {
  getTrailerUsableZones,
  getTrailerCapacityInches3,
  isAabbContainedInAnyZone,
  getFrontBonusBlockedZones,
  getWheelWellsBlockedZones,
  getInstanceEffectiveDims,
  makeAabb,
  isAabbInsideTruckGeometry,
};

export function getPacks() {
  return StateStore.get('packLibrary') || [];
}

export function getById(packId) {
  return getPacks().find(p => p.id === packId) || null;
}

export function create(packData) {
  const source = packData && typeof packData === 'object' ? packData : {};
  const now = Date.now();
  const packs = getPacks();
  const requestedLoadPlanNumber = assertBusinessIdentityValue(source.loadPlanNumber, {
    field: 'loadPlanNumber',
    required: false,
  });
  const loadPlanNumber = requestedLoadPlanNumber == null
    ? generateLoadPlanNumber(packs)
    : assertLoadPlanNumberAvailable(requestedLoadPlanNumber, packs);
  const customerReference = assertBusinessIdentityValue(source.customerReference, {
    field: 'customerReference',
    required: false,
  });
  const rawTruck = source.truck || { length: 636, width: 102, height: 98 };
  const shapeMode =
    rawTruck &&
      (rawTruck.shapeMode === 'wheelWells' || rawTruck.shapeMode === 'frontBonus' || rawTruck.shapeMode === 'rect')
      ? rawTruck.shapeMode
      : 'rect';
  const shapeConfig =
    rawTruck && rawTruck.shapeConfig && typeof rawTruck.shapeConfig === 'object' && !Array.isArray(rawTruck.shapeConfig)
      ? Utils.deepClone(rawTruck.shapeConfig)
      : {};
  const truck = {
    length: Number(rawTruck.length) || 636,
    width: Number(rawTruck.width) || 102,
    height: Number(rawTruck.height) || 98,
    shapeMode,
    shapeConfig,
  };
  const pack = {
    id: Utils.uuid(),
    title: source.title || 'Untitled Pack',
    loadPlanNumber,
    customerReference,
    client: source.client || '',
    projectName: source.projectName || '',
    drawnBy: source.drawnBy || '',
    notes: source.notes || '',
    folderId: null,
    truck,
    cases: [],
    groups: [],
    stats: {
      totalCases: 0,
      hiddenCases: 0,
      packedCases: 0,
      volumeUsed: 0,
      volumePercent: 0,
      totalWeight: 0,
      cog: null,
      oogWarnings: [],
      palletWarnings: [],
    },
    createdAt: now,
    lastEdited: now,
    thumbnail: null,
    thumbnailUpdatedAt: null,
    thumbnailSource: null,
    thumbnailVisualSignature: null,
    thumbnailViewSignature: null,
    thumbnailRenderVersion: null,
    editorView: null,
  };
  StateStore.set({ packLibrary: [...getPacks(), pack] });
  return pack;
}

export function update(packId, patch, { skipHistory = false } = {}) {
  const packs = getPacks();
  const idx = packs.findIndex(p => p.id === packId);
  if (idx === -1) return null;
  const now = Date.now();
  const cloned = Utils.deepClone(patch);
  const prev = packs[idx];
  // Annotations have their own validated writers (addCallout, updateCallout, ... and the import gate): the
  // generic writer neither validates nor caps them, so it refuses to change them. A patch that merely repeats
  // the stored value (a whole-Pack patch) is tolerated and writes nothing for that field.
  if (Object.prototype.hasOwnProperty.call(cloned || {}, 'annotations')) {
    if (JSON.stringify(cloned.annotations) !== JSON.stringify(prev.annotations)) return null;
    delete cloned.annotations;
  }
  if (Object.prototype.hasOwnProperty.call(cloned || {}, 'loadPlanNumber')) {
    cloned.loadPlanNumber = assertLoadPlanNumberAvailable(cloned.loadPlanNumber, packs, {
      excludeId: packId,
    });
  }
  if (Object.prototype.hasOwnProperty.call(cloned || {}, 'customerReference')) {
    cloned.customerReference = assertBusinessIdentityValue(cloned.customerReference, {
      field: 'customerReference',
      required: false,
    });
  }
  // Durable truck writes (every truck commit ends here) keep all truck data but
  // never an Editor-internal marker such as the pending truck's __packId.
  if (Object.prototype.hasOwnProperty.call(cloned || {}, 'truck')) {
    cloned.truck = CoreNormalizer.stripInternalTruckFields(cloned.truck);
  }
  const next = CoreNormalizer.sanitizeLegacyPackQuantityFields({ ...prev, ...cloned });

  const lastEditedKeys = [
    'title',
    'client',
    'projectName',
    'drawnBy',
    'notes',
    'truck',
    'cases',
    'groups',
    'measurements',
  ];
  const hasLastEditedKey = Object.keys(cloned || {}).some(k => lastEditedKeys.includes(k));
  next.lastEdited = hasLastEditedKey ? now : prev.lastEdited || now;
  next.stats = computeStats(next);
  const nextPacks = packs.map((p, i) => (i === idx ? next : p));
  StateStore.set({ packLibrary: nextPacks }, { skipHistory });
  return next;
}

// Derived preview boundary: only thumbnail cache fields may change. Preserve cargo,
// stats and business timestamps; capture writes never enter or truncate history.
export function updatePreview(packId, patch, { skipHistory = true } = {}) {
  const previousPack = getById(packId);
  if (!previousPack) return null;
  const previewPatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = { ...previousPack };
  if (Object.hasOwn(previewPatch, 'thumbnail')) next.thumbnail = typeof previewPatch.thumbnail === 'string' ? previewPatch.thumbnail : null;
  if (Object.hasOwn(previewPatch, 'thumbnailRenderVersion')) {
    next.thumbnailRenderVersion = Number.isSafeInteger(previewPatch.thumbnailRenderVersion) && previewPatch.thumbnailRenderVersion > 0
      ? previewPatch.thumbnailRenderVersion : null;
  }
  if (Object.hasOwn(previewPatch, 'thumbnailUpdatedAt')) next.thumbnailUpdatedAt = Number.isFinite(previewPatch.thumbnailUpdatedAt) ? previewPatch.thumbnailUpdatedAt : null;
  if (Object.hasOwn(previewPatch, 'thumbnailSource')) next.thumbnailSource = ['manual', 'auto'].includes(previewPatch.thumbnailSource) ? previewPatch.thumbnailSource : null;
  if (Object.hasOwn(previewPatch, 'thumbnailVisualSignature')) {
    next.thumbnailVisualSignature = typeof previewPatch.thumbnailVisualSignature === 'string' && previewPatch.thumbnailVisualSignature
      ? previewPatch.thumbnailVisualSignature : null;
  }
  if (Object.hasOwn(previewPatch, 'thumbnailViewSignature')) {
    next.thumbnailViewSignature = typeof previewPatch.thumbnailViewSignature === 'string' && previewPatch.thumbnailViewSignature
      ? previewPatch.thumbnailViewSignature : null;
  }
  StateStore.set({ packLibrary: getPacks().map(p => p === previousPack ? next : p) }, {
    skipHistory,
    notification: { type: 'pack-preview', previousPack, pack: next },
  });
  return next;
}

/** Settled Pack view metadata, outside cargo stats, timestamps, Undo and Redo. */
export function updateEditorView(packId, view) {
  const previousPack = getById(packId);
  const editorView = CoreNormalizer.normalizeEditorView(view);
  if (!previousPack || !editorView) return null;
  const previousView = CoreNormalizer.normalizeEditorView(previousPack.editorView);
  if (CoreNormalizer.editorViewSignature(previousView) ===
      CoreNormalizer.editorViewSignature(editorView) &&
      previousView?.projection === editorView.projection) return previousPack;
  const pack = { ...previousPack, editorView };
  StateStore.set({ packLibrary: getPacks().map(p => p === previousPack ? pack : p) }, {
    skipHistory: true,
    notification: { type: 'pack-view', previousPack, pack },
  });
  return pack;
}

// ============================================================================
// SECTION: MEASUREMENTS (Measurement Tool V1)
// ============================================================================
// Measurements are authored Load Plan content stored beside cargo. Each completed edit bumps lastEdited
// and is one step of the same chronological Undo/Redo history as cargo edits, which restores the whole
// recorded Pack, lastEdited included. They never touch cargo, stats, thumbnails, AutoPack or any assessment.

/** Normalized, never-destructive measurement list (unreadable records are wrapped, not dropped). */
export function getMeasurements(packOrId) {
  const pack = typeof packOrId === 'string' ? getById(packOrId) : packOrId;
  return CoreMeasurements.normalizeMeasurements(pack && pack.measurements);
}

/** Supported floor surfaces (main floor, Wheel Well tops, raised deck) from the authoritative usable zones. */
export function getMeasurementFloors(pack) {
  const truck = pack && pack.truck;
  return CoreMeasurements.buildFloorSurfaces(truck, getTrailerUsableZones(truck));
}

/**
 * The walls, end planes and ceiling that physically exist on the truck, exactly as the Editor draws
 * them (core/measurements.js buildTruckShellFaces): never the bounding box of the usable zones, so the
 * Front Overhang cab void and the open seam where the deck joins the main box have no face.
 */
export function getMeasurementShellFaces(pack) {
  const truck = pack && pack.truck;
  return CoreMeasurements.getTruckShellFaces(truck, getTrailerUsableZones(truck));
}

/**
 * The truck's effective usable zones: the authoritative geometry (it already reflects shapeConfig,
 * such as a Front Overhang length or a Wheel Well size). Truck-bound measurement anchors remember it.
 */
export function getMeasurementZones(pack) {
  return getTrailerUsableZones(pack && pack.truck);
}

/**
 * What an anchor (a measurement endpoint or an annotation) resolves against: the Load Plan's cargo by
 * identity key, its Case definitions, its floors and its truck geometry. One definition for every
 * anchored feature, from COMMITTED cargo poses and Case definitions.
 */
function anchorResolutionContext(pack) {
  // Instances are found by identity key (trimmed ID), the one policy shared with normalization and import.
  const identityKey = CoreMeasurements.instanceIdentityKey;
  const instances = new Map((pack.cases || []).filter(inst => inst && identityKey(inst.id) !== null).map(inst => [identityKey(inst.id), inst]));
  // A stored plan can carry an ID twice (damaged data is kept, never repaired): anchors naming it are Unresolved.
  const ambiguous = new Set(CoreMeasurements.findAmbiguousInstanceIds(pack.cases));
  const zones = getTrailerUsableZones(pack.truck);
  return {
    getInstance: id => instances.get(identityKey(id)) || null,
    isInstanceAmbiguous: id => ambiguous.has(identityKey(id)),
    getCase: id => CaseLibrary.getById(id) || null,
    floors: CoreMeasurements.buildFloorSurfaces(pack.truck, zones),
    truck: pack.truck,
    zones,
  };
}

/** Derived validity and geometry for every measurement, from COMMITTED cargo poses and Case definitions. */
export function resolveMeasurements(packOrId) {
  const pack = typeof packOrId === 'string' ? getById(packOrId) : packOrId;
  if (!pack) return [];
  return CoreMeasurements.resolveMeasurementList(pack.measurements, anchorResolutionContext(pack));
}

function commitMeasurements(previousPack, measurements) {
  const now = Date.now();
  const pack = { ...previousPack, measurements, lastEdited: now };
  // A completed measurement edit is one step of the shared Undo/Redo history.
  StateStore.set({ packLibrary: getPacks().map(p => (p === previousPack ? pack : p)) }, {
    notification: { type: 'pack-measurements', previousPack, pack },
  });
  return pack;
}

/**
 * @param {string} packId
 * @param {{ start?: any, end?: any, label?: string | null }} [input]
 * @returns {{ ok: true, measurement: any, pack: any } | { ok: false, reason: 'pack-not-found' | 'limit' | 'invalid' }}
 */
export function addMeasurement(packId, { start, end, label = null } = {}) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreMeasurements.normalizeMeasurements(previousPack.measurements);
  if (current.length >= CoreMeasurements.MAX_MEASUREMENTS_PER_PACK) return { ok: false, reason: 'limit' };
  const record = CoreMeasurements.createMeasurementRecord({ id: Utils.uuid(), start, end, label, now: Date.now() });
  const checked = CoreMeasurements.validateMeasurementCollection([record]);
  if (!checked.ok) return { ok: false, reason: 'invalid' };
  const measurement = checked.measurements[0];
  const pack = commitMeasurements(previousPack, [...current, measurement]);
  return { ok: true, measurement, pack };
}

export function renameMeasurement(packId, measurementId, label) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreMeasurements.normalizeMeasurements(previousPack.measurements);
  const index = current.findIndex(record => record.id === measurementId);
  if (index === -1 || current[index].type !== CoreMeasurements.MEASUREMENT_TYPE_POINT_TO_POINT) {
    return { ok: false, reason: 'not-found' };
  }
  const nextLabel = CoreMeasurements.normalizeMeasurementLabel(label);
  if (nextLabel === current[index].label) return { ok: true, pack: previousPack, unchanged: true };
  const next = current.map((record, i) => (i === index ? { ...record, label: nextLabel, updatedAt: Date.now() } : record));
  return { ok: true, pack: commitMeasurements(previousPack, next) };
}

/**
 * Reposition one endpoint of a completed measurement onto a new anchor. A measurement-only edit:
 * it bumps lastEdited, is one Undo/Redo step (none when nothing changed), and never touches cargo.
 * The new anchor is validated and an invalid one writes nothing.
 * @returns {{ ok: true, pack: any, unchanged?: true } | { ok: false, reason: 'pack-not-found' | 'not-found' | 'invalid' }}
 */
export function moveMeasurementEndpoint(packId, measurementId, which, anchor) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreMeasurements.normalizeMeasurements(previousPack.measurements);
  const index = current.findIndex(record => record.id === measurementId);
  if (index === -1 || current[index].type !== CoreMeasurements.MEASUREMENT_TYPE_POINT_TO_POINT) {
    return { ok: false, reason: 'not-found' };
  }
  const moved = CoreMeasurements.replaceMeasurementEndpoint(current[index], which, anchor, Date.now());
  if (!moved) return { ok: false, reason: 'invalid' };
  // The same content at the same place is no edit: no write, no history step, and the time of the last edit stays.
  if (JSON.stringify({ ...moved, updatedAt: 0 }) === JSON.stringify({ ...current[index], updatedAt: 0 })) {
    return { ok: true, pack: previousPack, unchanged: true };
  }
  const next = current.map((record, i) => (i === index ? moved : record));
  return { ok: true, pack: commitMeasurements(previousPack, next) };
}

/**
 * Move a whole completed measurement rigidly by one in-plane offset `(du, dv)` (inches, snapped to the 0.01 in grid).
 * Both endpoints must share ONE physical surface (the same cargo face, or the same floor, ground, wall or ceiling
 * plane of the same truck evidence), the moved endpoints must resolve Valid against the committed layout and stay
 * on the one patch that held them, otherwise the whole move is refused (`invalid` when the pair is not rigidly
 * movable, `unresolved` when the moved pair leaves its surface or stops resolving). Nothing is clamped, trimmed,
 * detached or converted to another anchor kind; the label, identity and distance are preserved. Exactly one
 * measurement-only write, or none; an offset that snaps to zero is `unchanged` and writes nothing. With `commit`
 * false nothing is written and the verdict is returned as `dryRun`.
 * @returns {{ ok: true, pack: any, measurement?: any, unchanged?: true, dryRun?: true } | { ok: false, reason: 'pack-not-found' | 'not-found' | 'invalid' | 'unresolved' }}
 */
export function moveMeasurement(packId, measurementId, du, dv, commit = true) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreMeasurements.normalizeMeasurements(previousPack.measurements);
  const index = current.findIndex(record => record.id === measurementId);
  if (index === -1 || current[index].type !== CoreMeasurements.MEASUREMENT_TYPE_POINT_TO_POINT) return { ok: false, reason: 'not-found' };
  const before = current[index];
  const moved = CoreMeasurements.translateMeasurementRecord(before, du, dv, Date.now());
  if (!moved) return { ok: false, reason: 'invalid' };
  if (JSON.stringify({ ...moved, updatedAt: 0 }) === JSON.stringify({ ...before, updatedAt: 0 })) return { ok: true, pack: previousPack, unchanged: true };
  if (!rigidMovePlacesPair(before, moved, previousPack)) return { ok: false, reason: 'unresolved' };
  if (!commit) return { ok: true, pack: previousPack, measurement: moved, dryRun: true };
  return { ok: true, pack: commitMeasurements(previousPack, current.map((record, i) => (i === index ? moved : record))), measurement: moved };
}

/** The verdict moveMeasurement would give for this offset right now, without writing: what a drag previews. */
export function checkMeasurementMove(packId, measurementId, du, dv) {
  return moveMeasurement(packId, measurementId, du, dv, false);
}

/**
 * Whether a rigidly moved record (a measurement or an arrow, both with `start` and `end`) still resolves Valid at
 * both ends against the committed layout and stays on the one patch that held the pair before it moved.
 */
function rigidMovePlacesPair(before, moved, pack) {
  const context = anchorResolutionContext(pack);
  const frame = CoreMeasurements.rigidMoveFrame(before.start, before.end);
  if (!frame.ok) return false;
  const placed = [moved.start, moved.end].every(anchor => {
    const resolution = CoreMeasurements.resolveAnchor(anchor, context);
    return resolution.status === CoreMeasurements.MEASUREMENT_STATUS.VALID && resolution.point &&
      [resolution.point.x, resolution.point.y, resolution.point.z].every(Number.isFinite);
  });
  return placed && CoreMeasurements.rigidMoveHeld(frame, before, moved, context);
}

/** Deliberate, individual deletion. Editing or deleting cargo never calls this. */
export function deleteMeasurement(packId, measurementId) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreMeasurements.normalizeMeasurements(previousPack.measurements);
  if (!current.some(record => record.id === measurementId)) return { ok: false, reason: 'not-found' };
  return { ok: true, pack: commitMeasurements(previousPack, current.filter(record => record.id !== measurementId)) };
}

// ============================================================================
// SECTION: ANNOTATIONS (Annotations V1)
// ============================================================================
// Annotations are authored Load Plan content, stored separately from cargo and measurements. Like
// measurements, each completed edit bumps lastEdited and is one step of the same chronological Undo/Redo
// history as cargo edits. They never touch cargo, stats, thumbnails, AutoPack or any assessment, and every
// write is validated by the same strict collection gate import uses.

/** Normalized, never-destructive annotation list (unreadable records are wrapped, not dropped). */
export function getAnnotations(packOrId) {
  const pack = typeof packOrId === 'string' ? getById(packOrId) : packOrId;
  return CoreAnnotations.normalizeAnnotations(pack && pack.annotations);
}

/** Derived validity and committed position for every annotation, against COMMITTED cargo poses. */
export function resolveAnnotations(packOrId) {
  const pack = typeof packOrId === 'string' ? getById(packOrId) : packOrId;
  if (!pack) return [];
  return CoreAnnotations.resolveAnnotationList(pack.annotations, anchorResolutionContext(pack));
}

function commitAnnotations(previousPack, annotations) {
  const now = Date.now();
  const pack = { ...previousPack, annotations, lastEdited: now };
  // A completed annotation edit is one step of the shared Undo/Redo history.
  StateStore.set({ packLibrary: getPacks().map(p => (p === previousPack ? pack : p)) }, {
    notification: { type: 'pack-annotations', previousPack, pack },
  });
  return pack;
}

const sameAnnotationContent = (a, b) => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });

/**
 * Apply a pure record edit to one stored annotation of the given type and commit it. An edit that changes
 * nothing writes nothing. `placement`, when given, is a write-time rule judged on the edited record against
 * the committed layout; it returns the reason to refuse the write, or null. With `commit` false nothing is
 * written: the result is the same verdict (`dryRun`), so a gesture can preview whether its edit would be accepted.
 * @returns {{ ok: true, pack: any, annotation: any, unchanged?: true, dryRun?: true } | { ok: false, reason: 'pack-not-found' | 'not-found' | 'invalid' | 'unresolved' | 'too-short' }}
 */
function editStoredAnnotation(packId, annotationId, type, edit, placement = null, commit = true) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreAnnotations.normalizeAnnotations(previousPack.annotations);
  const index = current.findIndex(record => record.id === annotationId);
  if (index === -1 || current[index].type !== type) return { ok: false, reason: 'not-found' };
  const edited = edit(current[index], Date.now());
  if (!edited) return { ok: false, reason: 'invalid' };
  if (sameAnnotationContent(edited, current[index])) return { ok: true, pack: previousPack, annotation: current[index], unchanged: true };
  const problem = placement ? placement(edited, previousPack) : null;
  if (problem) return { ok: false, reason: problem };
  if (!commit) return { ok: true, pack: previousPack, annotation: edited, dryRun: true };
  const next = current.map((record, i) => (i === index ? edited : record));
  return { ok: true, pack: commitAnnotations(previousPack, next), annotation: edited };
}

/**
 * Create one callout. Exactly one record is written, or nothing.
 * @param {string} packId
 * @param {{ anchor?: any, title?: string, description?: string | null, color?: string, keepExpanded?: boolean, offset?: any }} [input]
 * @returns {{ ok: true, annotation: any, pack: any } | { ok: false, reason: 'pack-not-found' | 'limit' | 'invalid' }}
 */
export function addCallout(packId, { anchor, title, description = null, color, keepExpanded = false, offset = null } = {}) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreAnnotations.normalizeAnnotations(previousPack.annotations);
  if (current.length >= CoreAnnotations.MAX_ANNOTATIONS_PER_PACK) return { ok: false, reason: 'limit' };
  const record = CoreAnnotations.createCalloutRecord({
    id: Utils.uuid(), anchor, title, description, color, keepExpanded, offset, now: Date.now(),
  });
  const checked = CoreAnnotations.validateAnnotationCollection([record]);
  if (!checked.ok) return { ok: false, reason: 'invalid' };
  const annotation = checked.annotations[0];
  return { ok: true, annotation, pack: commitAnnotations(previousPack, [...current, annotation]) };
}

/** Edit a callout's text, color, kept-expanded flag or visibility. */
export function updateCallout(packId, annotationId, patch) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_CALLOUT,
    (record, now) => CoreAnnotations.editCalloutRecord(record, patch, now));
}

/**
 * Move a callout's marker onto a new anchor the owner chose (a marker drag or Re-attach). An annotation-only
 * edit: the card offset is kept, the anchor is validated, and cargo is never moved, rotated or selected.
 */
export function reattachCallout(packId, annotationId, anchor) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_CALLOUT,
    (record, now) => CoreAnnotations.reattachCalloutRecord(record, anchor, now));
}

/** Store (or with null, clear) where a callout's card sits relative to its marker. */
export function setCalloutOffset(packId, annotationId, offset) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_CALLOUT,
    (record, now) => CoreAnnotations.offsetCalloutRecord(record, offset, now));
}

/**
 * Create one arrow from two anchors the owner chose (`start` is the tail, `end` the head). Both endpoints
 * must resolve against the committed layout and be at least MIN_ARROW_LENGTH_INCHES apart, otherwise
 * nothing is written. Exactly one record is written, or nothing.
 * @param {string} packId
 * @param {{ start?: any, end?: any, color?: string, width?: string, style?: string }} [input]
 * @returns {{ ok: true, annotation: any, pack: any } | { ok: false, reason: 'pack-not-found' | 'limit' | 'invalid' | 'unresolved' | 'too-short' }}
 */
export function addArrow(packId, { start, end, color, width, style } = {}) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreAnnotations.normalizeAnnotations(previousPack.annotations);
  if (current.length >= CoreAnnotations.MAX_ANNOTATIONS_PER_PACK) return { ok: false, reason: 'limit' };
  const record = CoreAnnotations.createArrowRecord({ id: Utils.uuid(), start, end, color, width, style, now: Date.now() });
  const checked = CoreAnnotations.validateAnnotationCollection([record]);
  if (!checked.ok) return { ok: false, reason: 'invalid' };
  const annotation = checked.annotations[0];
  const problem = CoreAnnotations.arrowPlacementProblem(annotation, anchorResolutionContext(previousPack));
  if (problem) return { ok: false, reason: problem };
  return { ok: true, annotation, pack: commitAnnotations(previousPack, [...current, annotation]) };
}

/** Edit an arrow's color, width, line style or visibility. Its endpoints are never touched, so no placement rule applies. */
export function updateArrow(packId, annotationId, patch) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_ARROW,
    (record, now) => CoreAnnotations.editArrowRecord(record, patch, now));
}

/**
 * Move one end of an arrow onto an anchor the owner chose (a grip drag or Re-attach). The new anchor must
 * resolve against the committed layout, and the arrow must stay at least MIN_ARROW_LENGTH_INCHES long when
 * both ends can be placed. The other end may be broken: moving one end is how a broken arrow is repaired.
 * @param {'start' | 'end'} which
 */
export function moveArrowEndpoint(packId, annotationId, which, anchor) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_ARROW,
    (record, now) => CoreAnnotations.replaceArrowEndpoint(record, which, anchor, now),
    (edited, pack) => CoreAnnotations.arrowPlacementProblem(edited, anchorResolutionContext(pack), which));
}

/**
 * Move a whole arrow rigidly by one in-plane offset `(du, dv)` (inches, snapped to the 0.01 in grid): both ends move
 * together and its length, direction, name, color, width, style and identity are preserved. Both ends must share ONE
 * physical surface (see moveMeasurement); an arrow whose ends are on different surfaces is `invalid` for a whole move
 * and stays movable one end at a time. The moved ends must resolve Valid and stay on the patch that held the pair,
 * otherwise (`unresolved`) the whole move is refused, never clamped or re-attached. Exactly one annotation-only
 * write, or none; an offset that snaps to zero is `unchanged`. With `commit` false nothing is written (`dryRun`).
 */
export function moveArrow(packId, annotationId, du, dv, commit = true) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_ARROW,
    (record, now) => CoreAnnotations.translateArrowRecord(record, du, dv, now),
    (edited, pack) => {
      const before = CoreAnnotations.normalizeAnnotations(pack.annotations).find(record => record.id === annotationId);
      if (!before || !rigidMovePlacesPair(before, edited, pack)) return 'unresolved';
      return CoreAnnotations.arrowPlacementProblem(edited, anchorResolutionContext(pack));
    }, commit);
}

/** The verdict moveArrow would give for this offset right now, without writing: what a drag previews. */
export function checkArrowMove(packId, annotationId, du, dv) {
  return moveArrow(packId, annotationId, du, dv, false);
}

/**
 * Create one freehand stroke from a finished gesture. `anchor` is the first vertex (a Measurement anchor on
 * the surface the gesture started on), `face` the cargo face for a cargo anchor, and `rawPoints` the sampled
 * surface-local `[u, v, ...]` positions after it. The raw samples are simplified within the stated error
 * budget and quantized (CoreAnnotations.prepareDrawStroke); a stroke that cannot fit is refused as
 * `too-complex`, never truncated. The stroke must also resolve Valid now (the anchor resolves and one
 * patch holds every vertex) and run at least MIN_DRAW_LENGTH_INCHES. Exactly one record is written, or nothing.
 * @param {string} packId
 * @param {{ anchor?: any, face?: string, rawPoints?: number[], color?: string, width?: string, style?: string }} [input]
 * @returns {{ ok: true, annotation: any, pack: any, tolerance: number }
 *   | { ok: false, reason: 'pack-not-found' | 'limit' | 'points-limit' | 'invalid' | 'too-short' | 'too-complex' | 'unresolved' }}
 */
export function addDraw(packId, { anchor, face, rawPoints, color, width, style } = {}) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreAnnotations.normalizeAnnotations(previousPack.annotations);
  if (current.length >= CoreAnnotations.MAX_ANNOTATIONS_PER_PACK) return { ok: false, reason: 'limit' };
  const prepared = CoreAnnotations.prepareDrawStroke({ anchor, face, rawPoints });
  if ('reason' in prepared) return { ok: false, reason: prepared.reason };
  const record = CoreAnnotations.createDrawRecord({
    id: Utils.uuid(), anchor, face, points: prepared.points, color, width, style, now: Date.now(),
  });
  const checked = CoreAnnotations.validateAnnotationCollection([record]);
  if (!checked.ok) return { ok: false, reason: 'invalid' };
  const annotation = checked.annotations[0];
  if (CoreAnnotations.drawVertexTotal(current) + CoreAnnotations.drawVertexCount(annotation) > CoreAnnotations.MAX_DRAW_VERTICES_PER_PACK) {
    return { ok: false, reason: 'points-limit' };
  }
  const problem = CoreAnnotations.drawPlacementProblem(annotation, anchorResolutionContext(previousPack));
  if (problem) return { ok: false, reason: problem };
  return { ok: true, annotation, pack: commitAnnotations(previousPack, [...current, annotation]), tolerance: prepared.tolerance };
}

/**
 * Edit a stroke's color, width, line style or visibility. Its surface, face and vertices are carried over untouched, so
 * no placement rule applies and a stroke that needs review can still be restyled or hidden.
 */
export function updateDraw(packId, annotationId, patch) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_DRAW,
    (record, now) => CoreAnnotations.editDrawRecord(record, patch, now));
}

/**
 * Move a whole stroke rigidly by one in-plane offset `(du, dv)` (inches, snapped to the 0.01 in grid) on the
 * surface it is already attached to. The moved stroke must be a valid record AND resolve Valid against the
 * committed layout (every vertex on the one cargo face, cap, floor or wall patch it belongs to): otherwise the
 * whole move is refused, never clamped, trimmed or re-attached. Exactly one annotation-only write, or none; an
 * offset that snaps to zero is `unchanged` and writes nothing. Cargo is never touched.
 */
export function moveDraw(packId, annotationId, du, dv) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_DRAW,
    (record, now) => CoreAnnotations.translateDrawRecord(record, du, dv, now),
    (edited, pack) => CoreAnnotations.drawPlacementProblem(edited, anchorResolutionContext(pack)));
}

/** The verdict moveDraw would give for this offset right now, without writing: what a drag previews. */
export function checkDrawMove(packId, annotationId, du, dv) {
  return editStoredAnnotation(packId, annotationId, CoreAnnotations.ANNOTATION_TYPE_DRAW,
    (record, now) => CoreAnnotations.translateDrawRecord(record, du, dv, now),
    (edited, pack) => CoreAnnotations.drawPlacementProblem(edited, anchorResolutionContext(pack)), false);
}

/** Deliberate, individual deletion (also removes an unreadable recovery record). Cargo is never touched. */
export function deleteAnnotation(packId, annotationId) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreAnnotations.normalizeAnnotations(previousPack.annotations);
  const index = current.findIndex(record => record.id === annotationId);
  if (index === -1) return { ok: false, reason: 'not-found' };
  return {
    ok: true, removed: current[index], index,
    pack: commitAnnotations(previousPack, current.filter((_, i) => i !== index)),
  };
}

/**
 * Put back a record that deleteAnnotation returned (the panel's one-level Undo). The record goes through
 * the same strict gate as import, keeps its ID and returns to its position, and is refused if the plan
 * changed in a way that makes that wrong (the ID is taken again, or the cap is reached).
 * @returns {{ ok: true, pack: any } | { ok: false, reason: 'pack-not-found' | 'exists' | 'limit' | 'points-limit' | 'invalid' }}
 */
export function restoreAnnotation(packId, record, index) {
  const previousPack = getById(packId);
  if (!previousPack) return { ok: false, reason: 'pack-not-found' };
  const current = CoreAnnotations.normalizeAnnotations(previousPack.annotations);
  if (current.length >= CoreAnnotations.MAX_ANNOTATIONS_PER_PACK) return { ok: false, reason: 'limit' };
  const checked = CoreAnnotations.validateAnnotationCollection([record]);
  if (!checked.ok) return { ok: false, reason: 'invalid' };
  if (current.some(existing => existing.id === checked.annotations[0].id)) return { ok: false, reason: 'exists' };
  if (CoreAnnotations.drawVertexTotal(current) + CoreAnnotations.drawVertexTotal(checked.annotations) > CoreAnnotations.MAX_DRAW_VERTICES_PER_PACK) {
    return { ok: false, reason: 'points-limit' };
  }
  const at = Math.max(0, Math.min(Number.isInteger(index) ? index : current.length, current.length));
  const next = [...current.slice(0, at), checked.annotations[0], ...current.slice(at)];
  return { ok: true, pack: commitAnnotations(previousPack, next) };
}

export function remove(packId) {
  const packs = getPacks().filter(p => p.id !== packId);
  const current = StateStore.get('currentPackId');
  StateStore.set(
    { packLibrary: packs, currentPackId: current === packId ? null : current, selectedInstanceIds: [] },
    { skipHistory: true }
  );
}

/**
 * Mints cargo instance IDs for a Load Plan. An ID is never one that any Load Plan in the workspace (or
 * `pack`, which may not be stored yet) already uses, nor one this minter issued before, so the
 * "unique within a Load Plan" invariant holds at creation by construction rather than by the
 * improbability of a collision. Every place that creates cargo instances mints through here.
 * @param {any} [pack]
 */
function createInstanceIdMinter(pack = null) {
  const used = new Set();
  const take = instances => (Array.isArray(instances) ? instances : []).forEach(instance => {
    const key = CoreMeasurements.instanceIdentityKey(instance && instance.id);
    if (key !== null) used.add(key);
  });
  getPacks().forEach(stored => take(stored && stored.cases));
  if (pack) take(pack.cases);
  return () => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const id = Utils.uuid();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error('Could not generate a unique cargo instance ID.');
  };
}

export function duplicate(packId) {
  const pack = getById(packId);
  if (!pack) return null;
  const now = Date.now();
  const copy = CoreNormalizer.sanitizeLegacyPackQuantityFields(Utils.deepClone(pack));
  copy.id = Utils.uuid();
  copy.title = pack.title + ' (Copy)';
  copy.loadPlanNumber = generateLoadPlanNumber(getPacks());
  copy.customerReference = null;
  copy.createdAt = now;
  copy.lastEdited = now;
  copy.thumbnail = null;
  copy.thumbnailUpdatedAt = null;
  copy.thumbnailSource = null;
  copy.thumbnailVisualSignature = null;
  copy.thumbnailViewSignature = null;
  copy.thumbnailRenderVersion = null;
  // Instance IDs are regenerated, so keep the exact old->new map and carry measurements across
  // through it. A cargo anchor whose instance is not in the map is left as-is (stays Unresolved).
  // An ID that a damaged plan gives to several instances is ambiguous: it is never mapped, so no
  // anchor is guessed onto one of them.
  const { ids, idMap: instanceIdMap } = CoreMeasurements.assignFreshInstanceIds(copy.cases, createInstanceIdMinter());
  copy.cases = (copy.cases || []).map((i, index) => ({ ...i, id: ids[index] }));
  if (copy.measurements !== undefined) {
    copy.measurements = CoreMeasurements.remapMeasurementInstanceIds(copy.measurements, instanceIdMap);
  }
  // Annotations follow their cargo through the same exact map; an unmapped anchor stays Unresolved.
  if (copy.annotations !== undefined) {
    copy.annotations = CoreAnnotations.remapAnnotationInstanceIds(copy.annotations, instanceIdMap);
  }
  StateStore.set({ packLibrary: [...getPacks(), copy] });
  return copy;
}

export function open(packId) {
  const pack = getById(packId);
  if (!pack) return null;
  const previousPackId = StateStore.get('currentPackId');
  StateStore.set({ currentPackId: packId, selectedInstanceIds: [] }, { skipHistory: true });
  if (previousPackId !== packId) StateStore.resetHistory();
  return pack;
}

export function addInstance(packId, caseId, position) {
  const pack = getById(packId);
  if (!pack) return null;
  const caseData = CaseLibrary.getById(caseId);
  if (!caseData) return null;
  const explicitPosition = normalizeTransformPosition(position);
  const dims = normalizeDims(caseData.dimensions);
  const acceptedAabbs = buildAcceptedAabbs(pack, pack.cases || [], CaseLibrary.getCases());
  const explicitAabb = explicitPosition ? makeAabb(explicitPosition, dims) : null;
  const blockedBody = explicitAabb && (
    aabbIntersectsWheelWellBlockedBody(explicitAabb, pack.truck) ||
    aabbIntersectsFrontBonusBlockedBody(explicitAabb, pack.truck)
  );
  const truckDrop = explicitAabb && (
    blockedBody || overlapsAny(explicitAabb, getTrailerUsableZones(pack.truck))
  );
  const id = createInstanceIdMinter(pack)();
  // Existing blocked-body drops deliberately fall back to canonical staging.
  // Other truck attempts must pass the exact manual placement rules.
  if (truckDrop && !blockedBody) {
    // The HTML5 drop supplies a floor pose. Validate that exact pose with the
    // same manual hard-rule pipeline used by a packed drag release; never
    // repair it onto a different case or displace existing packed cargo.
    const candidate = {
      id, caseId, placement: 'staged',
      transform: { position: explicitPosition, rotation: { x: 0, y: 0, z: 0 } },
    };
    const resolved = findManualVerticalPlacement(
      { ...pack, cases: [...(pack.cases || []), candidate] },
      CaseLibrary.getCases(), id,
      { mode: 'resolve', desiredPosition: explicitPosition, exact: true }
    );
    if (!resolved.ok) return null;
  }
  const needsSafeStaging = !explicitPosition || blockedBody ||
    (!truckDrop && overlapsAny(explicitAabb, acceptedAabbs));
  const staged = needsSafeStaging ? findSafeStagingPosition(pack, dims, acceptedAabbs) : null;
  if (staged && overlapsAny(staged.aabb, acceptedAabbs)) return null;
  const finalPosition = staged ? staged.position : explicitPosition;
  const finalAabb = staged ? staged.aabb : explicitAabb;
  const instance = {
    id,
    caseId,
    transform: {
      position: finalPosition,
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    hidden: false,
    groupId: null,
    placement: getPlacementForAabb(pack, finalAabb),
  };
  const nextCases = [...(pack.cases || []), instance];
  update(packId, { cases: nextCases });
  return instance;
}

export const BULK_ADD_MAX_QUANTITY = 10000;

// Every result gets its own createdInstanceIds array so a caller can never
// mutate state shared with another call.
function bulkAddResult(reason, requestedCount, addedCount = 0, createdInstanceIds = [], pack = null) {
  return { reason, requestedCount, addedCount, createdInstanceIds, pack };
}

/**
 * Quantity Controls: bulk-create `count` physical instances of `caseId`, all
 * placed in staging (never inside the truck), committed as ONE PackLibrary
 * update/history entry — never one update() per instance. `count` comes from
 * the Editor's ephemeral Qty selector, not any persisted/computed value.
 *
 * Strict, all-or-nothing command contract (same spirit as
 * removeCaseInstancesFromStaging). `count` must already be a whole number from
 * 1 to BULK_ADD_MAX_QUANTITY: nothing is coerced, truncated, or clamped.
 * `reason` is one of 'ok' | 'invalid-count' | 'pack-not-found' |
 * 'case-not-found' | 'placement-incomplete'. Any non-'ok' result performs ZERO
 * Pack writes (no update, no history entry, no lastEdited bump) and reports
 * addedCount 0 with an empty createdInstanceIds. A successful Add always adds
 * exactly `count` instances.
 *
 * Reuses the exact same staging-grid layout formula getStagingLayout() and
 * findSafeStagingPosition() are built on (normalizeDims, buildAcceptedAabbs,
 * getPlacementForAabb; same originX/originZ/gap/step math), so placement
 * conventions never diverge. It does NOT call findSafeStagingPosition() in a
 * loop: that primitive re-scans its grid from (row=0, col=0) on every call,
 * which is fine for a single addInstance() but is O(n^2) overlap checks for
 * an n-item batch (each of the n calls re-checks all instances placed by the
 * previous calls). Instead this walks the same grid ONCE with a persistent
 * cursor. Same-size grid cells never overlap each other by construction
 * (stepX/stepZ >= dims), so a newly placed instance only ever needs checking
 * against the pack's pre-existing instances (a fixed-size set), not against
 * the other instances in this same batch — O(n * existingCount) instead of
 * O(n^2), which is what keeps a 10,000-item batch responsive.
 */
export function addInstancesToStaging(packId, caseId, count) {
  if (typeof count !== 'number' || !Number.isFinite(count) ||
      !Number.isInteger(count) || count < 1 || count > BULK_ADD_MAX_QUANTITY) {
    return bulkAddResult('invalid-count', count);
  }
  const requestedCount = count;

  const pack = getById(packId);
  if (!pack) return bulkAddResult('pack-not-found', requestedCount);
  const caseData = caseId ? CaseLibrary.getById(caseId) : null;
  if (!caseData) return bulkAddResult('case-not-found', requestedCount);

  const dims = normalizeDims(caseData.dimensions);
  const existingInstances = pack.cases || [];
  const existingAccepted = buildAcceptedAabbs(pack, existingInstances, CaseLibrary.getCases());

  const layout = getStagingLayout(pack.truck);
  const truckL = Math.max(layout.truckL, dims.length);
  const gap = layout.gap;
  const stepX = Math.max(1, dims.length + gap);
  const stepZ = Math.max(1, dims.width + gap);
  const minX = layout.originX + dims.length / 2;
  const maxX = Math.max(minX, truckL - dims.length / 2);
  const availableX = Math.max(0, maxX - minX);
  const cols = Math.max(1, Math.floor(availableX / stepX) + 1);
  const startZ = layout.originZ + dims.width / 2;

  const newInstances = [];
  const mintInstanceId = createInstanceIdMinter(pack);
  let row = 0;
  let col = 0;
  // Generous but finite safety valve: any single pre-existing AABB can only
  // ever block a bounded run of grid cells, so a free cell is always reached
  // well within a small multiple of (existingAccepted.length + requestedCount).
  // This only guards against a pathological truck/case-dims combination —
  // it must never be the normal termination path.
  const maxAttempts = (existingAccepted.length + requestedCount) * 4 + 10000;
  let attempts = 0;

  while (newInstances.length < requestedCount && attempts < maxAttempts) {
    attempts++;
    const position = {
      x: Math.min(minX + col * stepX, maxX),
      y: dims.height / 2,
      z: startZ + row * stepZ,
    };
    col++;
    if (col >= cols) {
      col = 0;
      row++;
    }
    const aabb = makeAabb(position, dims);
    if (overlapsAny(aabb, existingAccepted)) continue;
    newInstances.push({
      id: mintInstanceId(),
      caseId,
      transform: {
        position,
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      hidden: false,
      groupId: null,
      // The grid's Z-band always starts outside the truck's usable zones by
      // construction (originZ = truckWidth/2 + gap), but this is still
      // classified through the same shared predicate addInstance() uses
      // rather than hardcoded, so the two paths can never diverge.
      placement: getPlacementForAabb(pack, aabb),
    });
  }

  // All-or-nothing: if the deterministic placement search could not create the
  // FULL requested batch, discard the locally built instances and write nothing.
  // A partial batch is never published, so there is no partial-Add outcome.
  if (newInstances.length !== requestedCount) {
    return bulkAddResult('placement-incomplete', requestedCount);
  }

  // Single write: all created instances committed together, one update()
  // call, one history/Undo entry.
  const updatedPack = update(packId, { cases: [...existingInstances, ...newInstances] });
  if (!updatedPack) return bulkAddResult('pack-not-found', requestedCount);

  return bulkAddResult(
    'ok',
    requestedCount,
    newInstances.length,
    newInstances.map(inst => inst.id),
    updatedPack
  );
}

export function updateInstance(packId, instanceId, patch) {
  const pack = getById(packId);
  if (!pack) return null;
  const nextInstances = (pack.cases || []).map(i => (i.id === instanceId ? { ...i, ...Utils.deepClone(patch) } : i));
  return update(packId, { cases: nextInstances });
}

function createPhysicalPlacementClassifier(pack, caseLibrary) {
  const caseMap = new Map((caseLibrary || []).map(caseData => [caseData.id, caseData]));
  const zonesInches = getTrailerUsableZones(pack && pack.truck);
  const wheelWell = getWheelWellGeometry(pack && pack.truck);

  return inst => {
    const caseData = caseMap.get(inst && inst.caseId);
    if (!caseData) return null;
    const effDims = getInstanceEffectiveDims(inst, caseData);
    if (!effDims) return null;
    const pos = inst && inst.transform && inst.transform.position
      ? inst.transform.position
      : { x: 0, y: 0, z: 0 };
    const aabb = makeAabb(pos, effDims);
    return isAabbInsideTruckGeometry(aabb, zonesInches, wheelWell) ? 'packed' : 'staged';
  };
}

function emptyRemovalRevalidation() {
  return {
    adjustedIds: [],
    repairedIds: [],
    stagedIds: [],
    failedIds: [],
    invalidIds: [],
    summary: { adjusted: 0, repaired: 0, staged: 0, failed: 0 },
    warnings: [],
  };
}

function buildRemoveInstancesResult(pack, requestedDeletedIds, deletedInstanceIds, revalidation) {
  const deletedSet = new Set(deletedInstanceIds);
  const dependentStagedIds = (revalidation.stagedIds || []).filter(id => !deletedSet.has(id));
  const dependentRepairedIds = (revalidation.repairedIds || []).filter(id => !deletedSet.has(id));
  const mutation = {
    type: 'removeInstances',
    requestedDeletedIds: [...requestedDeletedIds],
    deletedInstanceIds,
    dependentStagedIds,
    dependentStagedCount: dependentStagedIds.length,
    dependentRepairedIds,
    dependentRepairedCount: dependentRepairedIds.length,
    finalSelectionIds: [],
    revalidation,
  };

  return {
    ...pack,
    pack,
    mutation,
    deletedInstanceIds,
    requestedDeletedIds: [...requestedDeletedIds],
    dependentStagedIds,
    dependentStagedCount: dependentStagedIds.length,
    dependentRepairedIds,
    dependentRepairedCount: dependentRepairedIds.length,
    finalSelectionIds: [],
    revalidation,
  };
}

export function removeInstances(packId, instanceIds) {
  const pack = getById(packId);
  if (!pack) return null;
  const requestedDeletedIds = Array.isArray(instanceIds) ? instanceIds : [];
  const idSet = new Set(requestedDeletedIds);
  const deletedInstances = (pack.cases || []).filter(i => i && idSet.has(i.id));
  if (!deletedInstances.length) return null;

  const deletedInstanceIds = deletedInstances.map(i => i.id);
  const nextInstances = (pack.cases || []).filter(i => !idSet.has(i.id));

  const classifyPhysicalPlacement = createPhysicalPlacementClassifier(pack, CaseLibrary.getCases());
  if (deletedInstances.every(inst => classifyPhysicalPlacement(inst) === 'staged')) {
    const updatedPack = update(packId, { cases: nextInstances });
    if (!updatedPack) return null;
    return buildRemoveInstancesResult(
      updatedPack,
      requestedDeletedIds,
      deletedInstanceIds,
      emptyRemovalRevalidation()
    );
  }

  // Delete path enables local dependent repair: affected cases are re-settled
  // inside the truck when legally possible; only truly unplaceable ones stage.
  const result = updateCasesWithManualRevalidation(packId, nextInstances, CaseLibrary.getCases(), {
    repairDependents: true,
  });
  if (!result) return null;

  const revalidation = {
    adjustedIds: result.adjustedIds || [],
    repairedIds: result.repairedIds || [],
    stagedIds: result.stagedIds || [],
    failedIds: result.failedIds || [],
    invalidIds: result.invalidIds || [],
    summary: result.summary || {},
    warnings: result.warnings || [],
  };
  return buildRemoveInstancesResult(
    result.pack,
    requestedDeletedIds,
    deletedInstanceIds,
    revalidation
  );
}

function stagedCaseRemovalResult(reason, requestedCount, eligibleCount = 0, removedInstanceIds = [], pack = null) {
  return {
    reason,
    requestedCount,
    eligibleCount,
    removedCount: removedInstanceIds.length,
    removedInstanceIds,
    pack,
  };
}

function hasActiveGroup(inst) {
  return inst && inst.groupId != null && String(inst.groupId).trim() !== '';
}

/**
 * Remove a requested number of visible, ungrouped, physically staged instances
 * for one Case. This is the service authority for the Editor's future Qty
 * Remove action; it never removes packed cargo or invokes Pack revalidation.
 */
export function removeCaseInstancesFromStaging(packId, caseId, count) {
  if (typeof count !== 'number' || !Number.isFinite(count) ||
      !Number.isInteger(count) || count < 1 || count > BULK_ADD_MAX_QUANTITY) {
    return stagedCaseRemovalResult('invalid-count', count);
  }

  const pack = getById(packId);
  if (!pack) return stagedCaseRemovalResult('pack-not-found', count);
  if (!caseId || !CaseLibrary.getById(caseId)) {
    return stagedCaseRemovalResult('case-not-found', count);
  }

  const classifyPhysicalPlacement = createPhysicalPlacementClassifier(pack, CaseLibrary.getCases());
  const eligibleInstances = (pack.cases || []).filter(inst =>
    inst &&
    inst.caseId === caseId &&
    inst.hidden !== true &&
    !hasActiveGroup(inst) &&
    classifyPhysicalPlacement(inst) === 'staged'
  );
  const eligibleCount = eligibleInstances.length;
  if (eligibleCount < count) {
    return stagedCaseRemovalResult('insufficient-eligible', count, eligibleCount);
  }

  const targets = eligibleInstances.slice(-count).reverse();
  const removedInstanceIds = targets.map(inst => inst.id);
  const targetIds = new Set(removedInstanceIds);
  const nextInstances = (pack.cases || []).filter(inst => !targetIds.has(inst && inst.id));
  const updatedPack = update(packId, { cases: nextInstances });
  if (!updatedPack) return stagedCaseRemovalResult('pack-not-found', count, eligibleCount);
  return stagedCaseRemovalResult('ok', count, eligibleCount, removedInstanceIds, updatedPack);
}

function computeShapeAwareOOGWarnings(pack, caseLibrary, resolvedInstanceIds) {
  if (!pack || !Array.isArray(pack.cases) || !pack.truck) return [];
  const zonesInches = getTrailerUsableZones(pack.truck);
  const oogWheelWell = getWheelWellGeometry(pack.truck);
  const truck = pack.truck || {};
  const truckL = Number(truck.length) || 0;
  const truckW = Number(truck.width) || 0;
  const truckH = Number(truck.height) || 0;
  const halfW = truckW / 2;
  // Shape-aware front boundary: for frontBonus this is truck.length + bonusLength
  // (the far edge of the cab-over overhang deck), not raw truck.length. For
  // rect/wheelWells every zone's max.x is truck.length, so this is equivalent
  // to the previous truckL-based check.
  const maxUsableX = zonesInches.length ? Math.max(...zonesInches.map(z => z.max.x)) : truckL;
  const caseMap = new Map((caseLibrary || []).map(c => [c.id, c]));
  const warnings = [];

  (pack.cases || []).forEach(inst => {
    if (!inst || inst.placement === 'staged' ||
        !resolvedInstanceIds.has(inst.id == null ? null : String(inst.id))) return;
    const caseData = caseMap.get(inst.caseId);
    if (!caseData) return;
    const dims = getInstanceEffectiveDims(inst, caseData);
    if (!dims) return;
    const pos = inst.transform && inst.transform.position ? inst.transform.position : { x: 0, y: 0, z: 0 };
    const half = { x: dims.length / 2, y: dims.height / 2, z: dims.width / 2 };
    const aabb = {
      min: { x: pos.x - half.x, y: pos.y - half.y, z: pos.z - half.z },
      max: { x: pos.x + half.x, y: pos.y + half.y, z: pos.z + half.z },
    };
    if (isAabbInsideTruckGeometry(aabb, zonesInches, oogWheelWell)) return;

    const issues = [];
    if (aabb.min.x < -0.05) issues.push('protrudesRear');
    if (aabb.max.x > maxUsableX + 0.05) issues.push('protrudesFront');
    if (aabb.min.y < -0.05) issues.push('belowFloor');
    if (aabb.max.y > truckH + 0.05) issues.push('exceedsHeight');
    if (aabb.min.z < -halfW - 0.05) issues.push('protrudesLeft');
    if (aabb.max.z > halfW + 0.05) issues.push('protrudesRight');
    if (!issues.length) issues.push('outsideUsableZone');

    warnings.push({
      instanceId: inst.id,
      caseId: inst.caseId,
      caseName: caseData.name || 'Unknown',
      issues,
    });
  });

  return warnings;
}

export function computeStats(pack, caseLibraryOverride) {
  const caseLib = Array.isArray(caseLibraryOverride) ? caseLibraryOverride : CaseLibrary.getCases();
  const spaceUtilization = computeSpaceUtilization({
    pack,
    caseLibrary: caseLib,
    geometry: {
      getTrailerUsableZones,
      getTrailerCapacityInches3,
      getFrontBonusBlockedZones,
      getInstanceEffectiveDims,
      makeAabb,
      isAabbInsideTruckGeometry,
    },
  });
  let totalWeight = 0;
  let massComplete = true;
  let maxCapacityProfileCount = 0;
  const loadedInstanceIds = new Set();
  const resolvedInstanceIds = new Set();
  spaceUtilization.instanceAabbs.forEach(entry => {
    if (entry.placement === 'loaded' || entry.placement === 'staged') {
      resolvedInstanceIds.add(entry.instanceId);
    }
    if (entry.placement === 'loaded') loadedInstanceIds.add(entry.instanceId);
  });
  ((pack && pack.cases) || []).forEach(inst => {
    if (!inst || !loadedInstanceIds.has(inst.id == null ? null : String(inst.id))) return;
    const c = caseLib.find(caseData => caseData && caseData.id === inst.caseId) || null;
    if (!c) return;
    // Contract C: packedProfile === 'max-capacity' on a currently packed instance
    // means active Max Capacity profile membership, not per-instance evidence
    // that a relaxed rule was individually required. See docs/audits/
    // max-capacity-phase-c-packed-profile-semantics-audit-2026-07-18.md.
    if (instanceUsesMaxCapacityProfile(inst)) maxCapacityProfileCount++;
    if (c.weight == null || !isCanonicalCaseMass(c.weight)) massComplete = false;
    else totalWeight += c.weight;
  });
  const cog = computeCoG(pack, caseLib, loadedInstanceIds);
  const oogWarnings = computeShapeAwareOOGWarnings(pack, caseLib, resolvedInstanceIds);
  const palletWarnings = computePalletWarnings(pack, caseLib, loadedInstanceIds);
  // Completeness: when any instance is unresolved, weight/volume/utilization totals
  // are necessarily incomplete (we never fabricate the missing item's physical
  // contribution). Surfaces must avoid any "complete"/"fits all" wording when false.
  const totalsComplete = spaceUtilization.unresolvedCount === 0 &&
    spaceUtilization.diagnostics.geometry.length === 0;
  const stats = {
    totalCases: ((pack && pack.cases) || []).length,
    hiddenCases: spaceUtilization.hiddenCount,
    packedCases: spaceUtilization.loadedCount,
    stagedCases: spaceUtilization.stagedCount,
    unresolvedInstances: spaceUtilization.unresolvedCount,
    maxCapacityProfileCount,
    volumeUsed: spaceUtilization.cargoCubeVolume,
    volumePercent: spaceUtilization.cargoCubePercent,
    totalWeight: massComplete && totalsComplete ? totalWeight : null,
    cog: massComplete && totalsComplete ? cog : null,
    oogWarnings,
    palletWarnings,
    totalsComplete,
    weightComplete: massComplete && totalsComplete,
    volumeComplete: totalsComplete,
    utilizationComplete: totalsComplete,
  };
  // Pack updates retain the legacy enumerable stats shape. The richer engine
  // result is available to live consumers but cannot be serialized into Pack
  // persistence by JSON/object-spread paths.
  Object.defineProperty(stats, 'spaceUtilization', {
    value: spaceUtilization,
    enumerable: false,
  });
  return stats;
}

/**
 * Per-instance physical status aligned with pack.cases ('inTruck' | 'staged' |
 * 'unresolved'), read from the SAME classification a live computeStats() result
 * reports. Hidden is an independent visibility count, not a physical status.
 * Entries match by instance id + case id and are consumed once, in Pack order.
 * Also returns the distinct reasons behind unresolved instances.
 */
export function getStatsInstanceStatuses(pack, stats) {
  const utilization = stats && stats.spaceUtilization;
  if (!utilization || !Array.isArray(utilization.instanceAabbs)) {
    throw new Error('Load plan statistics are unavailable');
  }
  const key = (instanceId, caseId) => JSON.stringify([instanceId, caseId]);
  const queues = new Map();
  utilization.instanceAabbs.forEach(entry => {
    if (entry.placement !== 'loaded' && entry.placement !== 'staged') return;
    const k = key(entry.instanceId, entry.caseId);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(entry.placement === 'loaded' ? 'inTruck' : 'staged');
  });
  const statuses = ((pack && pack.cases) || []).map(inst => {
    const queue = queues.get(key(
      inst && inst.id != null ? String(inst.id) : null,
      inst && inst.caseId != null ? String(inst.caseId) : null
    ));
    return queue && queue.length ? queue.shift() : 'unresolved';
  });
  const unresolvedReasons = Array.from(new Set(
    (utilization.diagnostics.unresolvedInstances || []).map(entry => entry.reason).filter(Boolean)
  ));
  return { statuses, unresolvedReasons };
}

// ============================================================================
// SECTION: CASE INSTANCE COUNTS — derived, non-persisted quantity classification
// ============================================================================

const EMPTY_CASE_INSTANCE_COUNTS = Object.freeze({ inTruck: 0, staged: 0, inLoad: 0, hidden: 0 });

/**
 * Derived (never persisted) per-Case physical instance counts within one Pack.
 * Reuses the SAME shape-aware truck-geometry classification computeStats()
 * uses (getTrailerUsableZones/getWheelWellGeometry/isAabbInsideTruckGeometry)
 * so the Editor Qty readout can never diverge from Pack statistics.
 */
export function getCaseInstanceCounts(packOrId, caseId, caseLibraryOverride) {
  const pack = typeof packOrId === 'string' ? getById(packOrId) : packOrId;
  if (!pack || !caseId) return { ...EMPTY_CASE_INSTANCE_COUNTS };

  const caseLibrary = Array.isArray(caseLibraryOverride) ? caseLibraryOverride : CaseLibrary.getCases();
  const classifyPhysicalPlacement = createPhysicalPlacementClassifier(pack, caseLibrary);

  let inTruck = 0;
  let staged = 0;
  let hidden = 0;
  (pack.cases || []).forEach(inst => {
    if (!inst || inst.caseId !== caseId) return;
    if (inst.hidden) hidden++;
    const physicalPlacement = classifyPhysicalPlacement(inst);
    // No resolvable case definition means no geometry to test — consistent with
    // computeStats() excluding unresolved instances from packed/staged totals.
    if (physicalPlacement === 'packed') {
      inTruck++;
    } else if (physicalPlacement === 'staged') {
      staged++;
    }
  });

  return { inTruck, staged, inLoad: inTruck + staged, hidden };
}

/**
 * Workspace-wide physical instance count per Case, aggregated in
 * ONE pass over the active workspace's packLibrary (never a per-Case scan).
 * Result is derived for the current render cycle only — never persisted.
 */
export function getWorkspaceCaseQuantities() {
  const counts = new Map();
  getPacks().forEach(pack => {
    (pack.cases || []).forEach(inst => {
      if (!inst || !inst.caseId) return;
      counts.set(inst.caseId, (counts.get(inst.caseId) || 0) + 1);
    });
  });
  return counts;
}

// Cargo equivalence and the import fingerprint share one typed canonical
// representation (core/cargo-canonical.js): the SAME raw value yields the SAME
// canonical result in every path, "false" is never truthy, malformed numbers are
// never silently 0, and an invalid value never equals a valid default. The
// comparison is SAFE SEMANTIC REUSE — physical identity (manufacturer/category
// display taxonomy excluded so casing/taxonomy differences never fork a
// separate physical case) PLUS operational/handling identity (mustLoadLast,
// mustUnloadFirst, hazmatClass, stopGroup, keepTogetherGroup). Two physically
// identical cases with different operational rules are NOT safe to silently
// reuse — see core/cargo-canonical.js caseSafeReuseKey/Equal for the full
// rationale (Milestone C Case semantic conflict fix). The fingerprint is
// stamped onto a conflict-imported case as `importSourceKey` so re-importing
// the same conflicting pack reuses the existing copy (idempotence).
const cargoRulesEquivalent = caseSafeReuseEqual;
const cargoFingerprint = caseSafeReuseKey;

// A bundled case definition is "complete" (storable) only if it is an object
// with a non-blank id and finite positive dimensions. Anything else is malformed
// and must block the whole import before any mutation. Returns an error string,
// or null when the definition is valid.
function validateBundledCaseDefinition(c) {
  if (!c || typeof c !== 'object') return 'bundled case definition is not an object';
  if (!String(c.id || '').trim()) return 'bundled case definition is missing an id';
  const d = c.dimensions;
  if (!d || typeof d !== 'object') return `bundled case "${c.id}" is missing dimensions`;
  const ok = v => Number.isFinite(Number(v)) && Number(v) > 0;
  if (!ok(d.length) || !ok(d.width) || !ok(d.height)) {
    return `bundled case "${c.id}" has invalid dimensions`;
  }
  return null;
}

// The destination-independent structural gates of a pack import. planPackImport
// runs them against the local Case ids; a Load Plan export runs them with no
// local Cases, proving the file is self-contained. Pure; throws on failure.
/**
 * @param {any} payload
 * @param {Set<string>} [localCaseIds]
 */
export function validatePackImportPayload(payload, localCaseIds = new Set()) {
  const incomingPack = payload && payload.pack;
  if (!incomingPack || !incomingPack.truck || !Array.isArray(incomingPack.cases)) {
    throw new Error('Invalid pack format');
  }

  const bundled = Array.isArray(payload.bundledCases) ? payload.bundledCases : [];

  // Reject blank/missing instance caseId up front — these can never resolve to a
  // real case and previously slipped past the missing-reference gate.
  const blankRefCount = (incomingPack.cases || []).filter(
    inst => !inst || !String(inst.caseId || '').trim()
  ).length;
  if (blankRefCount) {
    throw new Error(
      `Pack import blocked: ${blankRefCount} instance(s) have a blank or missing case reference.`
    );
  }

  // The destination regenerates every instance ID, so a measurement anchor is re-targeted through an
  // exact old-to-new map. A source ID shared by several instances is ambiguous: which one an anchor
  // meant cannot be known, and guessing would silently attach it to the wrong cargo. Reject up front,
  // before any ID is generated or any state is touched (single import, batch import and export
  // self-preflight all run this).
  const ambiguousIds = CoreMeasurements.findAmbiguousInstanceIds(incomingPack.cases);
  if (ambiguousIds.length) {
    const shown = ambiguousIds.slice(0, 3).map(id => `"${String(id).slice(0, 40)}"`).join(', ') +
      (ambiguousIds.length > 3 ? ', …' : '');
    throw new Error(
      `Pack import blocked: ${ambiguousIds.length} cargo instance ID(s) are used by more than one item (${shown}), ` +
      'so measurement references cannot be attributed to a single item.'
    );
  }

  // Structural preflight precedes all planning/publication. Finite overlap,
  // containment and Case-permission failures remain representable source;
  // missing/nonfinite coordinates cannot be repaired into an imported pose.
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  for (const [index, instance] of incomingPack.cases.entries()) {
    const transform = instance.transform;
    if (!record(transform) || !record(transform.position) ||
        !['x', 'y', 'z'].every(axis => typeof transform.position[axis] === 'number' && Number.isFinite(transform.position[axis]))) {
      throw new Error(`Pack import blocked: instance ${index + 1} requires a finite transform.position (x/y/z).`);
    }
    for (const field of ['rotation', 'scale']) {
      const vector = transform[field];
      // Older portable files may omit these optional identity-transform fields.
      if (vector === undefined) continue;
      if (!record(vector) || !['x', 'y', 'z'].every(axis =>
        typeof vector[axis] === 'number' && Number.isFinite(vector[axis]) && (field !== 'scale' || vector[axis] > 0))) {
        throw new Error(`Pack import blocked: instance ${index + 1} has malformed transform.${field}.`);
      }
    }
  }

  // Validate every bundled case definition. A malformed bundled case (anywhere in
  // the list — first, middle, or last) blocks the entire import atomically.
  for (const c of bundled) {
    validatePortableCasePhysicalFields(c, { legacy: true, label: `bundled case "${c?.id}"` });
    const err = validateBundledCaseDefinition(c);
    if (err) throw new Error(`Pack import blocked: ${err}.`);
  }

  // Integrity gate: every instance must reference a case that resolves to either
  // an existing local case or a bundled case definition. Block the whole pack
  // import otherwise — never save a partial pack as a successful import.
  const bundledIds = new Set(bundled.filter(b => b && b.id).map(b => b.id));
  const unresolvedRefs = [...new Set(
    (incomingPack.cases || [])
      .map(inst => inst && inst.caseId)
      .filter(cid => cid && !localCaseIds.has(cid) && !bundledIds.has(cid))
  )];
  if (unresolvedRefs.length) {
    const shown = unresolvedRefs.slice(0, 3).join(', ') + (unresolvedRefs.length > 3 ? ', …' : '');
    throw new Error(
      `Pack import blocked: ${unresolvedRefs.length} referenced case definition(s) are missing (${shown}). ` +
      'The pack file must bundle every case its instances use.'
    );
  }

  // Measurements are validated strictly BEFORE anything is applied: a malformed collection, a
  // duplicate measurement ID or more than the per-plan maximum rejects this Load Plan. A structurally
  // valid anchor to a missing instance is kept (it resolves as Unresolved). The same rule gates the
  // export self-preflight, so an exported file is never one the importer would refuse.
  const measurementCheck = CoreMeasurements.validateMeasurementCollection(incomingPack.measurements);
  if (measurementCheck.ok === false) {
    throw new Error(`Pack import blocked: the measurements are not valid (${measurementCheck.error}).`);
  }
  // Annotations are validated by the same gate, before anything is applied. The export self-preflight
  // runs it too, so an exported file is never one the importer would refuse.
  const annotationCheck = CoreAnnotations.validateAnnotationCollection(incomingPack.annotations);
  if (annotationCheck.ok === false) {
    throw new Error(`Pack import blocked: the annotations are not valid (${annotationCheck.error}).`);
  }
  return { incomingPack, bundled, measurements: measurementCheck.measurements, annotations: annotationCheck.annotations };
}

// PURE preflight: parse, validate, canonicalize and plan a pack import WITHOUT
// mutating the case library, pack library, or StateStore. Returns a complete
// import plan ({ currentCases, currentPacks, newCases, pack, caseConflicts }) or
// throws with zero side effects. The single state commit happens only in
// importPackPayload after the entire plan succeeds.
export function planPackImport(payload) {
  const now = Date.now();
  const currentCases = CaseLibrary.getCases();
  const currentPacks = getPacks();
  const caseById = new Map(currentCases.map(c => [c.id, c]));
  const { incomingPack, bundled, measurements: validatedMeasurements, annotations: validatedAnnotations } =
    validatePackImportPayload(payload, new Set(caseById.keys()));
  const caseByName = new Map(
    currentCases.map(c => [
      String(c.name || '')
        .trim()
        .toLowerCase(),
      c,
    ])
  );

  const caseIdMap = new Map();
  const caseConflicts = [];
  const newCases = [];
  // Index of previously-imported cases by their source fingerprint, so repeated
  // conflicting imports reuse the first imported copy (idempotence).
  const caseByImportKey = new Map();
  currentCases.forEach(c => {
    if (c && c.importSourceKey) caseByImportKey.set(String(c.importSourceKey), c);
  });

  const makeUniqueImportedName = name => {
    const base = String(name || 'Imported Case').trim() || 'Imported Case';
    let candidate = `${base} (Imported)`;
    let n = 2;
    while (caseByName.has(candidate.trim().toLowerCase())) {
      candidate = `${base} (Imported ${n})`;
      n += 1;
    }
    return candidate;
  };

  // Plan adoption of a bundled case as a new local case (no mutation). On a cargo
  // conflict, regenerate the id and give a unique "(Imported)" name so the imported
  // pack keeps its intended behavior and the existing local case is never
  // overwritten. With no conflict the imported id is preserved so re-importing the
  // same pack is idempotent (it will match by id next time). The fully prepared,
  // canonical case is accumulated in `newCases` and committed once by the caller.
  const planNewCase = (c, conflictKind, fingerprint) => {
    const copy = Utils.deepClone(c);
    if (conflictKind) {
      copy.id = Utils.uuid();
      copy.name = makeUniqueImportedName(c.name);
    } else {
      copy.id = c.id;
    }
    // Stamp the source fingerprint so a future identical import reuses this copy.
    copy.importSourceKey = fingerprint;
    const storable = CaseLibrary.buildStorableCase(copy);
    storable.itemCode = assertItemCodeAvailable(
      storable.itemCode,
      [...currentCases, ...newCases]
    );
    newCases.push(storable);
    caseIdMap.set(c.id, storable.id);
    caseById.set(storable.id, storable);
    caseByImportKey.set(fingerprint, storable);
    const newNameKey = String(storable.name || '').trim().toLowerCase();
    if (newNameKey) caseByName.set(newNameKey, storable);
    if (conflictKind) {
      caseConflicts.push({
        kind: conflictKind,
        importedId: c.id,
        importedName: String(c.name || ''),
        newId: storable.id,
        newName: storable.name,
      });
    }
    return storable;
  };

  bundled.forEach(c => {
    if (!c || !c.id) return;
    const nameKey = String(c.name || '')
      .trim()
      .toLowerCase();
    const fingerprint = cargoFingerprint(c);
    const localById = caseById.get(c.id);
    // Same id with equivalent cargo → reuse the local case.
    if (localById && cargoRulesEquivalent(localById, c)) {
      caseIdMap.set(c.id, c.id);
      return;
    }
    const localByName = nameKey ? caseByName.get(nameKey) : null;
    // Same name (different id) with equivalent cargo → reuse the local case.
    if (localByName && cargoRulesEquivalent(localByName, c)) {
      caseIdMap.set(c.id, localByName.id);
      return;
    }
    // Idempotence: if this exact cargo was already imported as a conflict copy,
    // reuse it instead of creating (Imported 2), (Imported 3), ...
    const priorImport = caseByImportKey.get(fingerprint);
    if (priorImport) {
      caseIdMap.set(c.id, priorImport.id);
      return;
    }
    // True id/name conflict → renamed new case; otherwise a brand-new case that
    // keeps the imported id. Both are stamped with the source fingerprint.
    const conflictKind = localById ? 'id-conflict' : localByName ? 'name-conflict' : null;
    planNewCase(c, conflictKind, fingerprint);
  });

  const pack = CoreNormalizer.sanitizeLegacyPackQuantityFields(Utils.deepClone(incomingPack));
  pack.id = currentPacks.some(p => p.id === pack.id) ? Utils.uuid() : pack.id || Utils.uuid();
  pack.title = pack.title ? `${pack.title} (Imported)` : 'Imported Pack';
  const requestedLoadPlanNumber = assertBusinessIdentityValue(pack.loadPlanNumber, {
    field: 'loadPlanNumber',
    required: false,
  });
  pack.loadPlanNumber = requestedLoadPlanNumber == null
    ? generateLoadPlanNumber(currentPacks)
    : assertLoadPlanNumberAvailable(requestedLoadPlanNumber, currentPacks);
  pack.customerReference = assertBusinessIdentityValue(pack.customerReference, {
    field: 'customerReference',
    required: false,
  });
  pack.folderId = null;
  pack.createdAt = pack.createdAt || now;
  pack.lastEdited = now;

  // Validation above already refused any source ID shared by several items, so every anchor target is exact.
  const { ids: importedIds, idMap: importedInstanceIdMap } =
    CoreMeasurements.assignFreshInstanceIds(pack.cases, createInstanceIdMinter());
  pack.cases = (pack.cases || []).map((inst, index) => {
    const next = Utils.deepClone(inst);
    next.id = importedIds[index];
    next.caseId = caseIdMap.get(next.caseId) || next.caseId;
    next.transform.rotation ??= { x: 0, y: 0, z: 0 };
    next.transform.scale ??= { x: 1, y: 1, z: 1 };
    if (next.placement !== 'packed' || next.packedProfile !== 'max-capacity') delete next.packedProfile;
    if (next.packedProfile === 'max-capacity' || Object.hasOwn(next, 'orientedDims')) {
      const geometry = getCanonicalInstanceEffectiveDims(next, caseById.get(next.caseId));
      if (geometry.ok) next.orientedDims = { ...geometry.dims };
      else delete next.orientedDims;
    }
    return next;
  });

  pack.measurements = CoreMeasurements.remapMeasurementInstanceIds(validatedMeasurements, importedInstanceIdMap);
  pack.annotations = CoreAnnotations.remapAnnotationInstanceIds(validatedAnnotations, importedInstanceIdMap);

  // Final reference validation against the planned final case set.
  const finalCases = [...currentCases, ...newCases];
  const finalCaseIds = new Set(finalCases.map(c => c.id));
  const stillUnresolved = pack.cases.filter(inst => !finalCaseIds.has(inst.caseId));
  if (stillUnresolved.length) {
    throw new Error(
      `Pack import blocked: ${stillUnresolved.length} instance reference(s) could not be resolved after planning.`
    );
  }

  const rawTruck = pack.truck && typeof pack.truck === 'object' ? pack.truck : {};
  pack.truck = CoreNormalizer.normalizeTruck(rawTruck);
  // Structural validation has succeeded. Preserve physical source even when
  // current assessment is INVALID or INCOMPLETE; only safe derived stats rebuild.
  pack.stats = computeStats(pack, finalCases);
  const placementsPreserved = pack.cases.length;
  const placementsRepaired = 0;
  const placementsStaged = 0;

  // Portable category metadata (Milestone C): additive only — a category key
  // the LOCAL WORKSPACE HAS EXPLICITLY CUSTOMIZED is never overwritten (the
  // existing local name/color remains authoritative), and a mismatch is
  // reported rather than silently applied. Deliberately reads the RAW
  // preferences.categories array (not CategoryService.all(), which seeds in
  // built-in default names/colors for uncustomized keys) — otherwise every
  // built-in-keyed category (audio, lighting, rigging, ...) would look
  // "already customized" the moment ANY workspace opens, permanently
  // blocking a legitimate import even into a workspace with zero
  // customizations of its own. See core/import-schema.js
  // projectPortableCategories for the export-side projection (same
  // built-in-vs-customized distinction, mirrored here for the import side).
  const incomingCategories = Array.isArray(payload.categories) ? payload.categories : [];
  const rawPreferences = StateStore.get('preferences') || {};
  const localCategories = new Map(
    (Array.isArray(rawPreferences.categories) ? rawPreferences.categories : [])
      .filter(c => c && c.key)
      .map(c => [String(c.key).trim().toLowerCase(), c])
  );
  const categoriesToAdd = [];
  const categoryConflicts = [];
  const seenCategoryKeys = new Set();
  incomingCategories.forEach(cat => {
    const key = String((cat && cat.key) || '').trim().toLowerCase();
    if (!key || seenCategoryKeys.has(key)) return;
    seenCategoryKeys.add(key);
    const local = localCategories.get(key);
    if (!local) {
      categoriesToAdd.push({ key, name: cat.name || null, color: cat.color || null });
      return;
    }
    const nameDiffers = cat.name && String(cat.name).trim() !== String(local.name || '').trim();
    const colorDiffers = cat.color && String(cat.color).trim().toLowerCase() !== String(local.color || '').trim().toLowerCase();
    if (nameDiffers || colorDiffers) {
      categoryConflicts.push({
        key,
        localName: local.name,
        localColor: local.color,
        importedName: cat.name || null,
        importedColor: cat.color || null,
      });
    }
  });

  return {
    currentCases,
    currentPacks,
    newCases,
    finalCases,
    pack,
    caseConflicts,
    reusedCaseCount: Math.max(0, bundled.length - newCases.length),
    placementsPreserved,
    placementsRepaired,
    placementsStaged,
    categoriesToAdd,
    categoryConflicts,
  };
}

export function importPackPayload(payload) {
  const plan = planPackImport(payload);

  // Single atomic state commit: all planned new cases + the new pack persist
  // together, or (on any preflight throw above) nothing at all.
  StateStore.set(
    {
      caseLibrary: plan.finalCases,
      packLibrary: [...plan.currentPacks, plan.pack],
      selectedInstanceIds: [],
    },
    { skipHistory: false }
  );

  // Additive-only category merge: never overwrites an existing local category
  // (see planPackImport's categoryConflicts computation for the disclosed
  // mismatch case) and is a separate preferences-slice write from the pack/case
  // commit above, so it can never partially apply the pack/case import itself.
  plan.categoriesToAdd.forEach(cat => CategoryService.upsert(cat));

  // Surface import-preflight results to the caller without persisting them on
  // the pack (non-enumerable so JSON serialization to storage ignores them).
  Object.defineProperty(plan.pack, 'caseConflicts', {
    value: plan.caseConflicts,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(plan.pack, 'categoryConflicts', {
    value: plan.categoryConflicts,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(plan.pack, 'importStats', {
    value: {
      reusedCaseCount: plan.reusedCaseCount,
      createdCaseCount: plan.newCases.length,
      placementsPreserved: plan.placementsPreserved,
      placementsRepaired: plan.placementsRepaired,
      placementsStaged: plan.placementsStaged,
    },
    enumerable: false,
    configurable: true,
  });

  return plan.pack;
}
