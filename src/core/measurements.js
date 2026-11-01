/**
 * @file measurements.js
 * @description Pure Measurement Tool V1 data model (no THREE, no DOM). Owns the per-Load-Plan
 *   `measurements` schema, strict and lenient validation, anchor resolution with scene parity,
 *   derived validity, instance-ID remapping and measurement-specific length formatting.
 *
 *   Contract: docs/product/TP3D-MASTER-TODO-V6.md Section 4.1. A measurement is an illustrative,
 *   informational point-to-point ruler. It never influences cargo, collision, handling rules,
 *   assessment, AutoPack or PDF export. The distance is never stored; it is always recomputed
 *   from the currently resolved endpoints. All stored geometry is canonical inches.
 *
 *   A point can be placed anywhere that is visible: on any cargo surface (any shape), on the
 *   truck floor, wall or ceiling, or on the ground outside the truck. Three anchor kinds:
 *   - cargo: a point in the cargo's local frame; it follows the cargo's pose.
 *   - floor: a supported truck floor surface, revalidated by geometry against the current truck.
 *   - space: a fixed point in the Load Plan's coordinate space (ground, truck shell, free).
 * @module core/measurements
 */

import { getActualPoseDimensions } from './oriented-dims.js';
import { inchesToUnit } from './utils/index.js';

// ============================================================================
// SECTION: CONSTANTS
// ============================================================================

export const MEASUREMENT_SCHEMA_VERSION = 1;
export const MAX_MEASUREMENTS_PER_PACK = 100;
export const MEASUREMENT_TYPE_POINT_TO_POINT = 'point-to-point';
/** Wrapper that keeps an unreadable stored record verbatim so it is never silently dropped. */
export const MEASUREMENT_TYPE_UNREADABLE = 'unreadable';
export const MAX_MEASUREMENT_LABEL_LENGTH = 60;
export const BOX_FACES = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);
export const FLOOR_SURFACES = Object.freeze(['main', 'well-top', 'deck']);
/** Fixed-space surfaces. Truck-shell surfaces carry a truck signature; ground and free do not. */
export const SPACE_SURFACES = Object.freeze(['ground', 'wall-left', 'wall-right', 'wall-front', 'wall-rear', 'ceiling', 'free']);
const TRUCK_BOUND_SURFACES = new Set(['wall-left', 'wall-right', 'wall-front', 'wall-rear', 'ceiling']);

export const MEASUREMENT_STATUS = Object.freeze({
  VALID: 'valid',
  NEEDS_REVIEW: 'needs-review',
  UNRESOLVED: 'unresolved',
});

/**
 * Largest absolute coordinate or physical dimension (inches) a stored anchor may carry: 1,000,000 in
 * is about 16 miles, far beyond any truck, yard or camera reach (a ground pick stops about 16,000 in
 * from the camera). It exists so that no sum, difference or distance of two valid anchors can reach
 * the limit of a double: anything larger is malformed, not a measurement.
 */
export const MAX_ANCHOR_COORDINATE_INCHES = 1000000;

const MAX_ID_LENGTH = 64;
const MAX_INSTANCE_ID_LENGTH = 128;
const SIGNATURE_EPSILON = 1e-6;
const FLOOR_EPSILON = 0.01;
const MAX_TRUCK_ZONES = 16;
// Zones are stored rounded to 4 decimals, so two readings of the same geometry can differ by one rounding step.
const ZONE_EPSILON = 2e-4;
/**
 * A cargo-local point must lie on the saved physical surface within this tolerance (inches, plus a
 * relative part for very large cargo). Real picks differ from the exact surface only by the 4-decimal
 * rounding of the stored point and 32-bit mesh precision (about 1e-5 in), so 0.01 in leaves a wide
 * margin while an inch of error is rejected.
 */
const SURFACE_TOLERANCE_INCHES = 0.01;
const SURFACE_RELATIVE_TOLERANCE = 1e-6;
/**
 * Radial segments of a cylinder/drum mesh. The Editor builds it with this value
 * (src/editor/geometry-factory.js imports it), so the faceted side wall the user sees and the surface
 * a measurement point is validated against cannot drift apart.
 */
export const CARGO_CYLINDER_SEGMENTS = 24;
const CYLINDER_STEP = (2 * Math.PI) / CARGO_CYLINDER_SEGMENTS;
// Unit cross-section of that mesh in the cargo-local (height Y, width Z) plane, as THREE.CylinderGeometry
// lays it out once the axis is turned onto the length: vertex i at (sin, cos) of i * step, so vertices sit
// on the +Z/+Y axes and the facet centres half a step away. Normals point at the facet centres.
const CYLINDER_VERTEX = Array.from({ length: CARGO_CYLINDER_SEGMENTS + 1 }, (_, i) => [Math.sin(i * CYLINDER_STEP), Math.cos(i * CYLINDER_STEP)]);
const CYLINDER_FACET_NORMAL = Array.from({ length: CARGO_CYLINDER_SEGMENTS }, (_, i) => [Math.sin((i + 0.5) * CYLINDER_STEP), Math.cos((i + 0.5) * CYLINDER_STEP)]);
const CYLINDER_APOTHEM = Math.cos(CYLINDER_STEP / 2);
// The scene renders world units at 0.05 per inch and floors a cargo centre at 0.01 world units
// when no pose height is available (editor-screen applyTransform). Mirrored here for parity.
const SCENE_FALLBACK_HALF_HEIGHT_INCHES = 0.01 / 0.05;

// ============================================================================
// SECTION: SMALL HELPERS
// ============================================================================

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

/** Finite and within the canonical anchor bound (see MAX_ANCHOR_COORDINATE_INCHES). */
function isAnchorNumber(value) {
  return isFiniteNumber(value) && Math.abs(value) <= MAX_ANCHOR_COORDINATE_INCHES;
}

function isAnchorDimension(value) {
  return isPositiveNumber(value) && value <= MAX_ANCHOR_COORDINATE_INCHES;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function cloneJson(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return String(value);
  }
}

// ============================================================================
// SECTION: GEOMETRY SIGNATURE (CARGO)
// ============================================================================

/**
 * Physical signature of a Case definition: shape plus canonical dimensions. Stored on every
 * cargo anchor so a later change is detected and never silently re-anchored.
 * @param {any} caseData
 * @returns {{ shape: string, length: number, width: number, height: number } | null}
 */
export function getCargoGeometrySignature(caseData) {
  const dims = caseData && caseData.dimensions;
  if (!isRecord(dims) || !['length', 'width', 'height'].every(key => isPositiveNumber(dims[key]))) return null;
  const shape = String((caseData && caseData.shape) || 'box').trim().toLowerCase() || 'box';
  return { shape, length: dims.length, width: dims.width, height: dims.height };
}

function signaturesMatch(a, b) {
  return Boolean(a && b) && a.shape === b.shape &&
    Math.abs(a.length - b.length) <= SIGNATURE_EPSILON &&
    Math.abs(a.width - b.width) <= SIGNATURE_EPSILON &&
    Math.abs(a.height - b.height) <= SIGNATURE_EPSILON;
}

// ============================================================================
// SECTION: FACE MATH (CARGO-LOCAL FRAME)
// ============================================================================

// Local frame: X = Case length, Y = Case height, Z = Case width, origin at the cargo centre.
// New anchors store the local point directly (any shape). The face + (u, v) form is the earlier
// box-only encoding; it is still read so previously saved measurements keep resolving.
const FACE_FRAME = Object.freeze({
  '+x': { normal: 'x', sign: 1, u: 'z', v: 'y' },
  '-x': { normal: 'x', sign: -1, u: 'z', v: 'y' },
  '+y': { normal: 'y', sign: 1, u: 'x', v: 'z' },
  '-y': { normal: 'y', sign: -1, u: 'x', v: 'z' },
  '+z': { normal: 'z', sign: 1, u: 'x', v: 'y' },
  '-z': { normal: 'z', sign: -1, u: 'x', v: 'y' },
});

function halfExtents(signature) {
  return { x: signature.length / 2, y: signature.height / 2, z: signature.width / 2 };
}

/** Local (unrotated, centre-origin, inches) point for a face and normalized position. */
export function cargoLocalPointFromFace(face, u, v, signature) {
  const frame = FACE_FRAME[face];
  if (!frame || !signature) return null;
  const half = halfExtents(signature);
  const local = { x: 0, y: 0, z: 0 };
  local[frame.normal] = frame.sign * half[frame.normal];
  local[frame.u] = (u - 0.5) * 2 * half[frame.u];
  local[frame.v] = (v - 0.5) * 2 * half[frame.v];
  return local;
}

/**
 * Rotate a vector exactly as THREE.Euler order 'XYZ' (matrix Rx * Ry * Rz) does. Deliberately
 * not quantized so the result matches `group.rotation.set(x, y, z)` for any stored rotation.
 */
export function applyEulerXYZ(rotation, vector) {
  const a = Math.cos(rotation.x);
  const b = Math.sin(rotation.x);
  const c = Math.cos(rotation.y);
  const d = Math.sin(rotation.y);
  const e = Math.cos(rotation.z);
  const f = Math.sin(rotation.z);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  return {
    x: c * e * vector.x - c * f * vector.y + d * vector.z,
    y: (af + be * d) * vector.x + (ae - bf * d) * vector.y - b * c * vector.z,
    z: (bf - ae * d) * vector.x + (be + af * d) * vector.y + a * c * vector.z,
  };
}

// ============================================================================
// SECTION: ANCHOR + RECORD CONSTRUCTION
// ============================================================================

/**
 * Anchor on any cargo surface, whatever its shape. `local` is the picked point in the cargo's local
 * frame (centre origin, inches), so it follows the cargo's translation and rotation.
 * @param {{ instanceId: string, local: { x: number, y: number, z: number }, caseData: any }} input
 * @returns {Record<string, any> | null} null when the Case has no usable geometry signature
 */
export function buildCargoAnchor({ instanceId, local, caseData }) {
  const signature = getCargoGeometrySignature(caseData);
  if (!signature || !instanceId || !local) return null;
  if (![local.x, local.y, local.z].every(isAnchorNumber)) return null;
  return {
    kind: 'cargo',
    instanceId: String(instanceId),
    local: { x: round(local.x, 4), y: round(local.y, 4), z: round(local.z, 4) },
    signature,
  };
}

/** Local (cargo-frame, inches) point of a cargo anchor, in either stored encoding. */
export function cargoAnchorLocal(anchor) {
  if (anchor && anchor.local) return anchor.local;
  return anchor ? cargoLocalPointFromFace(anchor.face, anchor.u, anchor.v, anchor.signature) : null;
}

/** @param {{ surface: string, point: { x: number, y: number, z: number } }} input */
export function buildFloorAnchor({ surface, point }) {
  if (!FLOOR_SURFACES.includes(surface) || !point) return null;
  if (![point.x, point.y, point.z].every(isAnchorNumber)) return null;
  return {
    kind: 'floor',
    surface,
    position: { x: round(point.x, 4), y: round(point.y, 4), z: round(point.z, 4) },
  };
}

/**
 * One usable zone as `[xMin, yMin, zMin, xMax, yMax, zMax]` (inches, 4 decimals), from either that
 * array or the `{ min, max }` form the zone calculation returns. Null when it is not a bounded box.
 */
function canonicalZone(zone) {
  let values = null;
  if (Array.isArray(zone)) {
    values = zone;
  } else if (isRecord(zone) && isRecord(zone.min) && isRecord(zone.max)) {
    values = [zone.min.x, zone.min.y, zone.min.z, zone.max.x, zone.max.y, zone.max.z];
  }
  if (!values || values.length !== 6 || !values.every(isAnchorNumber)) return null;
  if (values[0] > values[3] || values[1] > values[4] || values[2] > values[5]) return null;
  return values.map(value => round(value, 4));
}

function canonicalZones(zones) {
  if (!Array.isArray(zones) || zones.length < 1 || zones.length > MAX_TRUCK_ZONES) return null;
  const list = zones.map(canonicalZone);
  return list.every(Boolean) ? list : null;
}

/** Order does not matter: two zone lists are the same truck geometry when they hold the same boxes. */
function sameZoneSets(a, b) {
  if (a.length !== b.length) return false;
  const order = (x, y) => { for (let i = 0; i < 6; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const left = [...a].sort(order);
  const right = [...b].sort(order);
  return left.every((zone, i) => zone.every((value, j) => Math.abs(value - right[i][j]) <= ZONE_EPSILON));
}

/**
 * The usable zones of a plain rectangular truck: one box, fully described by its dimensions (x from the
 * rear 0 to the cab end `length`, y from the floor 0 to `height`, z centred on 0). This is the only
 * shape whose geometry can be rebuilt from a record that did not remember its zones; it mirrors the
 * 'rect' rule of the zone calculation (pinned against it by the core spec).
 * @param {any} truck `{ length, width, height }` in inches
 * @returns {number[][] | null} zones in canonical form, or null when the dimensions are unusable
 */
export function rectangularTruckZones(truck) {
  const t = truck && typeof truck === 'object' ? truck : {};
  const { length, width, height } = t;
  if (![length, width, height].every(isAnchorDimension)) return null;
  return canonicalZones([[0, 0, -width / 2, length, height, width / 2]]);
}

/**
 * The geometry a truck-bound point was placed on, in canonical form: the zones it remembers or, for a
 * record saved before they were remembered, only what the dimensions alone prove (a rectangular
 * truck). A Front Overhang or Wheel Well record without zones is NOT reconstructed from its outside
 * dimensions: its configuration was never saved, so nothing is guessed. Null when unproven.
 */
function placedOnZones(stored) {
  if (!isRecord(stored)) return null;
  if (stored.zones !== undefined) return canonicalZones(stored.zones);
  return stored.shapeMode === 'rect' ? rectangularTruckZones(stored) : null;
}

/**
 * Signature of the truck a truck-bound point was placed on: its dimensions and shape mode plus, when
 * the caller knows them, the EFFECTIVE usable zones (the authoritative geometry, which also reflects
 * shapeConfig such as a Front Overhang length or a Wheel Well size). Older records carry no `zones`.
 * @param {any} truck
 * @param {any} [zones] usable zones (`{ min, max }` or 6-number arrays); defaults to `truck.zones`
 */
export function getTruckSignature(truck, zones) {
  const t = truck && typeof truck === 'object' ? truck : {};
  const num = value => (isFiniteNumber(Number(value)) ? Number(value) : 0);
  const signature = {
    length: num(t.length),
    width: num(t.width),
    height: num(t.height),
    shapeMode: typeof t.shapeMode === 'string' ? t.shapeMode : 'rect',
  };
  const effective = canonicalZones(zones !== undefined ? zones : t.zones);
  if (effective) signature.zones = effective;
  return signature;
}

/**
 * Fixed point in the Load Plan's coordinate space (ground, truck wall/ceiling, or anywhere).
 * Truck-bound surfaces remember the truck and its effective usable zones, so a later truck change is
 * flagged, never relocated; without usable zones, or with a point that is not on a physical face of the
 * named kind (see buildTruckShellFaces), no anchor is built.
 * @param {{ surface: string, point: { x: number, y: number, z: number }, truck?: any, zones?: any }} input
 */
export function buildSpaceAnchor({ surface, point, truck, zones }) {
  if (!SPACE_SURFACES.includes(surface) || !point) return null;
  if (![point.x, point.y, point.z].every(isAnchorNumber)) return null;
  const anchor = {
    kind: 'space',
    surface,
    position: { x: round(point.x, 4), y: round(point.y, 4), z: round(point.z, 4) },
  };
  if (TRUCK_BOUND_SURFACES.has(surface)) {
    // A new point always remembers the effective geometry it sits on (otherwise a later change to the
    // truck could not be detected), and it must lie on a face of that truck that physically exists.
    const signature = getTruckSignature(truck, zones);
    const faces = signature.zones ? shellFacesOf(signature, signature.zones) : null;
    if (!faces || !pointOnTruckShell(surface, anchor.position, faces)) return null;
    anchor.truck = signature;
  }
  return anchor;
}

export function normalizeMeasurementLabel(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_MEASUREMENT_LABEL_LENGTH);
  return text || null;
}

/**
 * Move one endpoint of a point-to-point record to a new, deliberately chosen anchor (the owner may
 * drag an endpoint onto any supported surface, so the anchor kind may change). Pure: the stored
 * record is never mutated, an invalid anchor yields null and nothing is written, and the label,
 * identity and creation time are preserved. The distance is still derived, never stored.
 * @param {Record<string, any>} record
 * @param {'start' | 'end'} which
 * @param {Record<string, any>} anchor
 * @param {number} now
 * @returns {Record<string, any> | null}
 */
export function replaceMeasurementEndpoint(record, which, anchor, now) {
  if (which !== 'start' && which !== 'end') return null;
  if (!isRecord(record) || record.type !== MEASUREMENT_TYPE_POINT_TO_POINT) return null;
  if (!isFiniteNumber(now) || validateAnchor(anchor, which)) return null;
  const next = { ...record, [which]: anchor, updatedAt: now };
  return validatePointRecord(next) ? null : canonicalPointRecord(next);
}

/** New point-to-point record. `id` and `now` are injected so callers own identity and time. */
export function createMeasurementRecord({ id, start, end, label = null, now }) {
  return {
    id: String(id),
    type: MEASUREMENT_TYPE_POINT_TO_POINT,
    label: normalizeMeasurementLabel(label),
    start,
    end,
    createdAt: now,
    updatedAt: now,
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
  };
}

// ============================================================================
// SECTION: VALIDATION
// ============================================================================

function validateSignature(signature) {
  if (!isRecord(signature)) return 'signature must be an object';
  if (typeof signature.shape !== 'string' || !signature.shape.trim() || signature.shape.length > 24) {
    return 'signature.shape is invalid';
  }
  if (!['length', 'width', 'height'].every(key => isAnchorDimension(signature[key]))) {
    return 'signature dimensions must be positive numbers within the supported range';
  }
  return null;
}

/**
 * Signed distance from a point of the cylinder's cross-section plane (cargo-local Y, Z) to the regular
 * 24-gon of the given circumradius: negative inside (distance to the nearest facet), positive outside
 * (distance to the nearest facet segment, which near a vertex is the distance to that vertex).
 */
function polygonSignedDistance(y, z, radius) {
  let inside = -Infinity;
  for (const [ny, nz] of CYLINDER_FACET_NORMAL) inside = Math.max(inside, y * ny + z * nz - radius * CYLINDER_APOTHEM);
  if (inside <= 0) return inside;
  let nearest = Infinity;
  for (let i = 0; i < CARGO_CYLINDER_SEGMENTS; i++) {
    const ay = CYLINDER_VERTEX[i][0] * radius;
    const az = CYLINDER_VERTEX[i][1] * radius;
    const ey = CYLINDER_VERTEX[i + 1][0] * radius - ay;
    const ez = CYLINDER_VERTEX[i + 1][1] * radius - az;
    const along = Math.min(1, Math.max(0, ((y - ay) * ey + (z - az) * ez) / (ey * ey + ez * ez)));
    nearest = Math.min(nearest, Math.hypot(y - (ay + along * ey), z - (az + along * ez)));
  }
  return nearest;
}

/**
 * Euclidean distance (inches) from a cargo-local point (centre origin) to the surface of the physical
 * solid a geometry signature describes: 0 on the surface, positive both outside and inside. It is the
 * exact surface of the mesh the Editor builds (src/editor/geometry-factory.js): a cylinder or drum is
 * the prism over the faceted 24-gon in the width/height plane (radius = half of the smaller of the two)
 * with its axis along the length and flat end caps; every other shape is a box. Null when the inputs
 * cannot describe a solid.
 * @param {{ x: number, y: number, z: number }} local
 * @param {{ shape: string, length: number, width: number, height: number }} signature
 * @returns {number | null}
 */
export function distanceToCargoSurface(local, signature) {
  if (!isRecord(local) || !isRecord(signature)) return null;
  if (![local.x, local.y, local.z].every(isFiniteNumber)) return null;
  if (!['length', 'width', 'height'].every(key => isPositiveNumber(signature[key]))) return null;
  const half = halfExtents(signature);
  const shape = String(signature.shape || '').trim().toLowerCase();
  const isRound = shape === 'cylinder' || shape === 'drum';
  // The solid is the product of independent parts, each as a signed distance (negative inside): along
  // the length, then either the faceted cross-section or the box's two remaining axes.
  const alongLength = Math.abs(local.x) - half.x;
  const sectionA = isRound
    ? polygonSignedDistance(local.y, local.z, Math.min(signature.width, signature.height) / 2)
    : Math.abs(local.y) - half.y;
  const sectionB = isRound ? -Infinity : Math.abs(local.z) - half.z;
  const deepest = Math.max(alongLength, sectionA, sectionB);
  return deepest <= 0
    ? -deepest
    : Math.hypot(Math.max(alongLength, 0), Math.max(sectionA, 0), Math.max(sectionB, 0));
}

/**
 * Whether a cargo-local point lies on the saved physical surface, within the documented tolerance:
 * 0.01 in (the stored point is rounded to 4 decimals and a mesh hit carries 32-bit precision, about
 * 1e-5 in) plus a millionth of the largest dimension. A point inside the cargo, or away from it, is
 * not a surface point.
 * @param {{ x: number, y: number, z: number }} local
 * @param {{ shape: string, length: number, width: number, height: number }} signature
 */
export function isLocalPointOnCargoSurface(local, signature) {
  const distance = distanceToCargoSurface(local, signature);
  if (distance === null) return false;
  return distance <= cargoSurfaceTolerance(signature);
}

/** The documented on-surface tolerance (inches) for one cargo signature: absolute plus a relative part. */
function cargoSurfaceTolerance(signature) {
  return SURFACE_TOLERANCE_INCHES +
    SURFACE_RELATIVE_TOLERANCE * Math.max(signature.length, signature.width, signature.height);
}

function validateAnchor(anchor, label) {
  if (!isRecord(anchor)) return `${label} must be an object`;
  if (anchor.kind === 'cargo') {
    if (typeof anchor.instanceId !== 'string' || !anchor.instanceId.trim() ||
        anchor.instanceId.length > MAX_INSTANCE_ID_LENGTH) return `${label}.instanceId is invalid`;
    if (anchor.local !== undefined) {
      const local = anchor.local;
      if (!isRecord(local) || ![local.x, local.y, local.z].every(isAnchorNumber)) {
        return `${label}.local must have finite x, y and z within the supported range`;
      }
    } else {
      if (!BOX_FACES.includes(anchor.face)) return `${label}.face is invalid`;
      if (![anchor.u, anchor.v].every(n => isFiniteNumber(n) && n >= 0 && n <= 1)) {
        return `${label}.u and ${label}.v must be numbers from 0 to 1`;
      }
    }
    const signatureError = validateSignature(anchor.signature);
    if (signatureError) return `${label}.${signatureError}`;
    // The point must be on the cargo it claims to be on; the original data is never clamped or moved.
    return isLocalPointOnCargoSurface(cargoAnchorLocal(anchor), anchor.signature)
      ? null : `${label} is not on the surface of its cargo`;
  }
  if (anchor.kind === 'space') {
    if (!SPACE_SURFACES.includes(anchor.surface)) return `${label}.surface is invalid`;
    const position = anchor.position;
    if (!isRecord(position) || ![position.x, position.y, position.z].every(isAnchorNumber)) {
      return `${label}.position must have finite x, y and z within the supported range`;
    }
    if (TRUCK_BOUND_SURFACES.has(anchor.surface)) {
      const truck = anchor.truck;
      if (!isRecord(truck) || !['length', 'width', 'height'].every(key => isAnchorNumber(truck[key])) ||
          typeof truck.shapeMode !== 'string') return `${label}.truck is invalid`;
      if (truck.zones !== undefined && !canonicalZones(truck.zones)) return `${label}.truck.zones is invalid`;
      // Where the geometry it was placed on is known, the point must lie on a physical face of the kind it names.
      const placedOn = placedOnZones(truck);
      const faces = placedOn ? shellFacesOf(truck, placedOn) : null;
      if (faces && !pointOnTruckShell(anchor.surface, position, faces)) {
        return `${label} is not on a physical ${anchor.surface} of its truck`;
      }
    }
    return null;
  }
  if (anchor.kind === 'floor') {
    if (!FLOOR_SURFACES.includes(anchor.surface)) return `${label}.surface is invalid`;
    const position = anchor.position;
    if (!isRecord(position) || ![position.x, position.y, position.z].every(isAnchorNumber)) {
      return `${label}.position must have finite x, y and z within the supported range`;
    }
    return position.y < -FLOOR_EPSILON ? `${label}.position.y must not be negative` : null;
  }
  return `${label}.kind must be "cargo", "floor" or "space"`;
}

function validateRecordId(record) {
  return typeof record.id === 'string' && record.id.trim() && record.id.length <= MAX_ID_LENGTH
    ? null : 'id is invalid';
}

function validatePointRecord(record) {
  if (!isRecord(record)) return 'record must be an object';
  const idError = validateRecordId(record);
  if (idError) return idError;
  if (record.type !== MEASUREMENT_TYPE_POINT_TO_POINT) return 'type is not supported';
  if (record.schemaVersion !== MEASUREMENT_SCHEMA_VERSION) return 'schemaVersion is not supported';
  if (record.label != null && (typeof record.label !== 'string' ||
      record.label.length > MAX_MEASUREMENT_LABEL_LENGTH)) return 'label is invalid';
  if (!isFiniteNumber(record.createdAt) || !isFiniteNumber(record.updatedAt)) return 'timestamps are invalid';
  return validateAnchor(record.start, 'start') || validateAnchor(record.end, 'end');
}

function validateRecoveryRecord(record) {
  if (!isRecord(record)) return 'record must be an object';
  const idError = validateRecordId(record);
  if (idError) return idError;
  if (record.type !== MEASUREMENT_TYPE_UNREADABLE) return 'type is not unreadable';
  if (typeof record.reason !== 'string') return 'reason is invalid';
  return Object.hasOwn(record, 'original') ? null : 'original is missing';
}

function canonicalAnchor(anchor) {
  if (anchor.kind === 'cargo') {
    const base = {
      kind: 'cargo',
      instanceId: anchor.instanceId,
      signature: {
        shape: anchor.signature.shape,
        length: anchor.signature.length,
        width: anchor.signature.width,
        height: anchor.signature.height,
      },
    };
    if (anchor.local !== undefined) return { ...base, local: { x: anchor.local.x, y: anchor.local.y, z: anchor.local.z } };
    return { ...base, face: anchor.face, u: anchor.u, v: anchor.v };
  }
  if (anchor.kind === 'space') {
    const position = { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z };
    return TRUCK_BOUND_SURFACES.has(anchor.surface)
      ? { kind: 'space', surface: anchor.surface, position, truck: { ...getTruckSignature(anchor.truck) } }
      : { kind: 'space', surface: anchor.surface, position };
  }
  return {
    kind: 'floor',
    surface: anchor.surface,
    position: { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z },
  };
}

// The anchor model is shared with Annotations (core/annotations.js): the same validation and canonical
// form for a cargo, floor or space anchor, so there is exactly one definition of what an anchor is.
export { validateAnchor as validateAnchorRecord, canonicalAnchor as canonicalAnchorRecord };

function canonicalPointRecord(record) {
  return {
    id: record.id,
    type: MEASUREMENT_TYPE_POINT_TO_POINT,
    label: record.label == null ? null : record.label,
    start: canonicalAnchor(record.start),
    end: canonicalAnchor(record.end),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
  };
}

function canonicalRecoveryRecord(record) {
  return {
    id: record.id,
    type: MEASUREMENT_TYPE_UNREADABLE,
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    reason: record.reason,
    original: cloneJson(record.original),
  };
}

function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}~${n++}`.slice(-MAX_ID_LENGTH);
  return id;
}

function wrapUnreadable(original, index, reason, used) {
  const sourceId = isRecord(original) && typeof original.id === 'string' && original.id.trim()
    ? original.id.trim().slice(0, MAX_ID_LENGTH - 8) : `unreadable-${index + 1}`;
  const id = uniqueId(sourceId, used);
  used.add(id);
  return {
    id,
    type: MEASUREMENT_TYPE_UNREADABLE,
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    reason,
    original: cloneJson(original),
  };
}

const normalizedCache = new WeakMap();

/**
 * Lenient, NEVER-DESTRUCTIVE normalization for stored data and export projection. A valid record is
 * kept in canonical form; anything else (malformed, unknown schema version, duplicate id, a
 * non-list container) is wrapped verbatim as an `unreadable` recovery record so the original data
 * is preserved, surfaced to the user, and written back unchanged. Nothing is dropped, coerced into
 * geometry or truncated. Missing/null input yields an empty collection (older Load Plans).
 * @param {unknown} raw
 * @returns {Array<Record<string, any>>}
 */
export function normalizeMeasurements(raw) {
  if (raw == null) return [];
  const cacheable = typeof raw === 'object';
  if (cacheable && normalizedCache.has(raw)) return normalizedCache.get(raw);
  const used = new Set();
  let out;
  if (!Array.isArray(raw)) {
    out = [wrapUnreadable(raw, 0, 'The saved measurement list could not be read.', used)];
  } else {
    out = [];
    raw.forEach((entry, index) => {
      const pointError = validatePointRecord(entry);
      if (!pointError) {
        if (used.has(entry.id)) {
          out.push(wrapUnreadable(entry, index, 'Duplicate measurement ID in this Load Plan.', used));
          return;
        }
        used.add(entry.id);
        out.push(canonicalPointRecord(entry));
        return;
      }
      if (!validateRecoveryRecord(entry) && !used.has(entry.id)) {
        used.add(entry.id);
        out.push(canonicalRecoveryRecord(entry));
        return;
      }
      const reason = isRecord(entry) && entry.schemaVersion > MEASUREMENT_SCHEMA_VERSION
        ? 'Saved by a newer version of the app.'
        : 'The saved measurement could not be read.';
      out.push(wrapUnreadable(entry, index, reason, used));
    });
  }
  if (cacheable) {
    normalizedCache.set(raw, out);
    normalizedCache.set(out, out);
  }
  return out;
}

/**
 * Strict validation for import and restore. A structurally valid collection (point-to-point
 * records and explicit recovery records) is accepted, INCLUDING cargo anchors that reference
 * instances that do not exist (they resolve as Unresolved). Any malformed record, duplicate
 * measurement ID within the plan, or more than MAX_MEASUREMENTS_PER_PACK rejects the whole
 * collection; nothing is truncated or repaired.
 * @param {unknown} raw
 * @returns {{ ok: true, measurements: Array<Record<string, any>> } | { ok: false, error: string }}
 */
export function validateMeasurementCollection(raw) {
  if (raw == null) return { ok: true, measurements: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'expected an array' };
  if (raw.length > MAX_MEASUREMENTS_PER_PACK) {
    return { ok: false, error: `too many measurements (${raw.length}; maximum ${MAX_MEASUREMENTS_PER_PACK})` };
  }
  const ids = new Set();
  const measurements = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    const pointError = validatePointRecord(entry);
    let canonical;
    if (!pointError) {
      canonical = canonicalPointRecord(entry);
    } else if (!validateRecoveryRecord(entry)) {
      canonical = canonicalRecoveryRecord(entry);
    } else {
      return { ok: false, error: `measurements[${index}] ${pointError}` };
    }
    if (ids.has(canonical.id)) {
      return { ok: false, error: `duplicate measurement id "${canonical.id}"` };
    }
    ids.add(canonical.id);
    measurements.push(canonical);
  }
  return { ok: true, measurements };
}

// ============================================================================
// SECTION: INSTANCE-ID REMAPPING (DUPLICATE / IMPORT)
// ============================================================================

/**
 * Identity key of a cargo instance ID: the trimmed string, exactly as the workspace validators
 * (`requireUniqueId`) and the normalizer (`safeId`) read it. Null for a blank or non-string ID, which
 * no anchor can reference.
 * @param {unknown} id
 * @returns {string | null}
 */
export function instanceIdentityKey(id) {
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * The cargo instance ID invariant: within a Load Plan every instance has its own ID. These are the
 * identity keys that appear on more than one instance. An anchor naming one of them cannot be
 * attributed to a single instance, so import rejects such a plan, duplication leaves the anchor
 * unmapped, and a stored plan that has them resolves those anchors as Unresolved: an anchor is never
 * guessed onto one of the instances.
 * @param {unknown} instances
 * @returns {string[]}
 */
export function findAmbiguousInstanceIds(instances) {
  const seen = new Set();
  const repeated = new Set();
  (Array.isArray(instances) ? instances : []).forEach(instance => {
    const key = instanceIdentityKey(instance && instance.id);
    if (key === null) return;
    if (seen.has(key)) repeated.add(key);
    else seen.add(key);
  });
  return [...repeated];
}

/**
 * The canonical form of cargo instance IDs, for normalizing a stored or restored Load Plan. The one
 * policy: an instance's identity is its trimmed ID (see instanceIdentityKey).
 *
 * Identity ambiguity is judged on the COMPLETE source list, before any instance is discarded: dropping
 * an instance (one with no Case reference, say) must never turn "this ID was held by several items" into
 * "this ID has exactly one holder", because a measurement that named it would then silently resolve on
 * the survivor. Per instance that survives (`survivors[i] !== false`):
 *  - held by one survivor and by no other source instance: stored in canonical (trimmed) form, and the
 *    returned `idMap` carries every anchor naming it to that form, keyed by identity key;
 *  - held by several survivors: every holder keeps its source string (distinct strings never collapse
 *    into one identity) and nothing is mapped, so anchors naming it stay Unresolved as ambiguous;
 *  - held by one survivor but ALSO by an instance that was discarded: the survivor is stored in
 *    canonical form (it is the only holder left) but the key is `contested`: it is not mapped, and the
 *    anchors that named it must not be resolved against the survivor (see carryMeasurementsThroughIdentity).
 * Idempotent: canonical input yields itself.
 * @param {unknown[]} rawIds the `id` of every SOURCE instance, in order
 * @param {() => string} mintId id for a surviving instance that has none
 * @param {boolean[]} [survivors] which source instances survive (default: all)
 * @returns {{ ids: string[], idMap: Map<string, string>, contestedKeys: Set<string> }} `ids[i]` is the
 *   stored ID of instance `i` (the source string for one that does not survive)
 */
export function canonicalizeInstanceIds(rawIds, mintId, survivors) {
  const texts = (Array.isArray(rawIds) ? rawIds : []).map(id => (id == null ? '' : String(id)));
  const survives = index => !Array.isArray(survivors) || survivors[index] !== false;
  const sourceHolders = new Map();
  const survivingHolders = new Map();
  texts.forEach((text, index) => {
    const key = text.trim();
    if (!key) return;
    sourceHolders.set(key, (sourceHolders.get(key) || 0) + 1);
    if (survives(index)) survivingHolders.set(key, (survivingHolders.get(key) || 0) + 1);
  });
  const idMap = new Map();
  const contestedKeys = new Set();
  const ids = texts.map((text, index) => {
    if (!survives(index)) return text;
    const key = text.trim();
    if (!key) return mintId();
    if (survivingHolders.get(key) > 1) return text;
    if (sourceHolders.get(key) > 1) {
      contestedKeys.add(key);
      return key;
    }
    idMap.set(key, key);
    return key;
  });
  return { ids, idMap, contestedKeys };
}

/**
 * Fresh IDs for a copy of a cargo list, with the exact old-to-new map measurement anchors are
 * re-targeted through (keyed by identity key). The one place that map is built (Load Plan duplication
 * and import): an old ID that more than one instance carries is never entered, so no anchor can land
 * on an arbitrary one.
 * @param {unknown} instances
 * @param {() => string} mintId returns a new, unused ID
 * @returns {{ ids: string[], idMap: Map<string, string> }} `ids[i]` is the new ID of `instances[i]`
 */
export function assignFreshInstanceIds(instances, mintId) {
  const list = Array.isArray(instances) ? instances : [];
  const ambiguous = new Set(findAmbiguousInstanceIds(list));
  const idMap = new Map();
  const ids = list.map(instance => {
    const id = mintId();
    const key = instanceIdentityKey(instance && instance.id);
    if (key !== null && !ambiguous.has(key)) idMap.set(key, id);
    return id;
  });
  return { ids, idMap };
}

/**
 * Remap cargo anchors through a deterministic old-instance-ID to new-instance-ID map keyed by identity
 * key (instanceIdentityKey), so an anchor naming `" cargo "` follows the instance the map knows as
 * `"cargo"`. An anchor whose instance is not in the map is left exactly as it is (it stays Unresolved);
 * a replacement is never guessed. Floor anchors and recovery records are untouched. Nothing that does
 * not change is copied, and if nothing changes the normalized list itself is returned.
 * @param {unknown} measurements
 * @param {Map<string, string> | Record<string, string>} idMap
 */
export function remapMeasurementInstanceIds(measurements, idMap) {
  const map = idMap instanceof Map ? idMap : new Map(Object.entries(idMap || {}));
  const remapAnchor = anchor => {
    if (!anchor || anchor.kind !== 'cargo') return anchor;
    const key = instanceIdentityKey(anchor.instanceId);
    const next = key === null ? undefined : map.get(key);
    return next === undefined || next === anchor.instanceId ? anchor : { ...anchor, instanceId: next };
  };
  const records = normalizeMeasurements(measurements);
  const remapped = records.map(record => {
    if (record.type !== MEASUREMENT_TYPE_POINT_TO_POINT) return record;
    const start = remapAnchor(record.start);
    const end = remapAnchor(record.end);
    return start === record.start && end === record.end ? record : { ...record, start, end };
  });
  return remapped.every((record, index) => record === records[index]) ? records : remapped;
}

const CONTESTED_IDENTITY_REASON =
  'The cargo this measurement was placed on shared its ID with another cargo item in the source, so which one it meant cannot be determined. The original is kept.';

/**
 * Carries a Load Plan's measurements through the cargo identity decision made by canonicalizeInstanceIds,
 * as one step so neither half can be forgotten:
 *  1. anchors naming a canonicalized instance follow it (remapMeasurementInstanceIds);
 *  2. a measurement with an anchor on a CONTESTED key (an ID the source gave to several items, of which
 *     only one survived) is withheld from resolution by the existing unreadable-recovery wrapper: the
 *     verbatim source record is preserved, nothing is relocated, re-targeted or guessed, and the
 *     surviving cargo never inherits the reference. Such a record stays Unresolved.
 * Everything else is untouched, including anchors on cargo that is simply missing, and normalizing
 * again changes nothing.
 * @param {unknown} rawMeasurements the stored measurements as they came in
 * @param {{ idMap: Map<string, string>, contestedKeys: Set<string> }} identity from canonicalizeInstanceIds
 */
export function carryMeasurementsThroughIdentity(rawMeasurements, identity) {
  const records = remapMeasurementInstanceIds(rawMeasurements, identity.idMap);
  if (!identity.contestedKeys.size) return records;
  const contested = record => record.type === MEASUREMENT_TYPE_POINT_TO_POINT &&
    [record.start, record.end].some(anchor => anchor && anchor.kind === 'cargo' &&
      identity.contestedKeys.has(instanceIdentityKey(anchor.instanceId)));
  const targets = new Set(records.flatMap((record, index) => (contested(record) ? [index] : [])));
  if (!targets.size) return records;
  // normalizeMeasurements yields one record per stored entry, so the stored entry at the same position is
  // the original; the (already canonical) record stands in only if that alignment ever fails.
  const aligned = Array.isArray(rawMeasurements) && rawMeasurements.length === records.length;
  const used = new Set(records.filter((_, index) => !targets.has(index)).map(record => record.id));
  return records.map((record, index) => (targets.has(index)
    ? wrapUnreadable(aligned ? rawMeasurements[index] : record, index, CONTESTED_IDENTITY_REASON, used)
    : record));
}

// ============================================================================
// SECTION: FLOOR SURFACES
// ============================================================================

/**
 * Supported truck floor surfaces from the authoritative usable zones: the floor of every usable
 * zone. Elevation 0 is the main floor; a raised floor is a Wheel Well top or the over-cab deck
 * depending on the truck shape. Walls, ceiling and end planes are `space` anchors on the physical
 * shell faces (see buildTruckShellFaces); wheel-well side faces are not individually pickable.
 * @param {any} truck
 * @param {Array<{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number} }>} zones
 */
export function buildFloorSurfaces(truck, zones) {
  const mode = truck && truck.shapeMode;
  return (Array.isArray(zones) ? zones : []).map(zone => ({
    surface: zone.min.y <= FLOOR_EPSILON ? 'main' : (mode === 'frontBonus' ? 'deck' : 'well-top'),
    elevation: zone.min.y,
    xMin: zone.min.x,
    xMax: zone.max.x,
    zMin: zone.min.z,
    zMax: zone.max.z,
  }));
}

// ============================================================================
// SECTION: TRUCK SHELL FACES (the walls and ceiling that physically exist)
// ============================================================================

/**
 * One supported measurable face kind. `axis` is the face normal's axis (0 = x, 1 = y, 2 = z) and `side`
 * which end of the volume it is on (0 = min, 1 = max). The floor is not here: floors are the upward faces
 * of the usable zones (see buildFloorSurfaces). +X is the cab end, +Z the truck's left.
 */
const SHELL_FACE_KINDS = Object.freeze([
  { surface: 'wall-rear', axis: 0, side: 0, isEndCap: true },
  { surface: 'wall-front', axis: 0, side: 1, isEndCap: true },
  { surface: 'wall-right', axis: 2, side: 0, isEndCap: false },
  { surface: 'wall-left', axis: 2, side: 1, isEndCap: false },
  { surface: 'ceiling', axis: 1, side: 1, isEndCap: false },
]);
const FACE_PLANE_EPSILON = 1e-3;
const MIN_FACE_EXTENT = 1e-6;

/**
 * The solid volumes whose outer faces are the truck's physical shell, exactly as the Editor draws them
 * (src/editor/scene-runtime.js setTruck): a standard truck is its single usable zone; a Front Overhang
 * is the main box plus the raised deck (its usable zones), the cab void beneath the deck being empty;
 * Wheel Wells are blocked guide volumes INSIDE the box, so the shell is the full outer box taken from
 * the dimensions. Anything else is treated like the zones themselves.
 * @param {{ length?: unknown, width?: unknown, height?: unknown, shapeMode?: unknown }} signature
 * @param {unknown} zones usable zones (`{ min, max }` or 6-number arrays)
 * @returns {number[][] | null} canonical boxes, or null when the geometry is missing or unusable
 */
export function buildTruckShellVolumes(signature, zones) {
  const canonical = canonicalZones(zones);
  if (!canonical) return null;
  return signature && signature.shapeMode === 'wheelWells' ? rectangularTruckZones(signature) : canonical;
}

function overlapExtent(a, b) {
  return [Math.min(a[2], b[2]) - Math.max(a[0], b[0]), Math.min(a[3], b[3]) - Math.max(a[1], b[1])];
}

/** `rect` ([a0, b0, a1, b1]) with the part covered by `cut` removed, as up to four rectangles. */
function subtractRect(rect, cut) {
  const [overlapA, overlapB] = overlapExtent(rect, cut);
  if (overlapA <= MIN_FACE_EXTENT || overlapB <= MIN_FACE_EXTENT) return [rect];
  const [a0, b0, a1, b1] = rect;
  const ia0 = Math.max(a0, cut[0]);
  const ia1 = Math.min(a1, cut[2]);
  const ib0 = Math.max(b0, cut[1]);
  const ib1 = Math.min(b1, cut[3]);
  const pieces = [];
  if (ia0 - a0 > MIN_FACE_EXTENT) pieces.push([a0, b0, ia0, b1]);
  if (a1 - ia1 > MIN_FACE_EXTENT) pieces.push([ia1, b0, a1, b1]);
  if (ib0 - b0 > MIN_FACE_EXTENT) pieces.push([ia0, b0, ia1, ib0]);
  if (b1 - ib1 > MIN_FACE_EXTENT) pieces.push([ia0, ib1, ia1, b1]);
  return pieces;
}

/**
 * The exposed outer faces of the shell volumes: every wall and ceiling rectangle a person can see and
 * touch, and nothing else.
 *  - A face covered by a neighbouring volume's opposite face is an internal boundary, not a surface.
 *  - An end cap (front/rear) where two volumes connect is not drawn at all, as in the Editor: the main
 *    box's front and the deck's rear are open to each other, including the part below the deck.
 *  - Regions with no volume (the Front Overhang cab void) have no face, whatever the outer bounding box says.
 * @param {number[][] | null} volumes from buildTruckShellVolumes
 * @returns {Array<{ surface: string, axis: number, outward: 1 | -1, min: number[], max: number[] }>}
 */
export function buildTruckShellFaces(volumes) {
  if (!Array.isArray(volumes)) return [];
  const faces = [];
  volumes.forEach((volume, index) => {
    SHELL_FACE_KINDS.forEach(kind => {
      const at = volume[kind.axis + 3 * kind.side];
      const [a, b] = [0, 1, 2].filter(axis => axis !== kind.axis);
      const full = [volume[a], volume[b], volume[a + 3], volume[b + 3]];
      const neighbours = volumes
        .filter((other, otherIndex) => otherIndex !== index &&
          Math.abs(other[kind.axis + 3 * (1 - kind.side)] - at) <= FACE_PLANE_EPSILON)
        .map(other => [other[a], other[b], other[a + 3], other[b + 3]])
        .filter(cut => overlapExtent(full, cut).every(extent => extent > MIN_FACE_EXTENT));
      if (kind.isEndCap && neighbours.length) return;
      let pieces = [full];
      neighbours.forEach(cut => { pieces = pieces.flatMap(piece => subtractRect(piece, cut)); });
      pieces.forEach(([a0, b0, a1, b1]) => {
        const min = [0, 0, 0];
        const max = [0, 0, 0];
        min[kind.axis] = at;
        max[kind.axis] = at;
        min[a] = a0;
        max[a] = a1;
        min[b] = b0;
        max[b] = b1;
        faces.push(Object.freeze({ surface: kind.surface, axis: kind.axis, outward: kind.side ? 1 : -1, min, max }));
      });
    });
  });
  return faces;
}

function shellFacesOf(signature, zones) {
  const volumes = buildTruckShellVolumes(signature, zones);
  return volumes ? buildTruckShellFaces(volumes) : null;
}

/**
 * The physical shell faces of a truck, from its dimensions, shape and effective usable zones. Empty when
 * the geometry is unavailable: with no known surface nothing can be picked, built or found Valid.
 * @param {any} truck
 * @param {any} zones usable zones of that truck
 */
export function getTruckShellFaces(truck, zones) {
  const signature = getTruckSignature(truck, zones);
  return (signature.zones && shellFacesOf(signature, signature.zones)) || [];
}

/**
 * Whether a point lies on a face of the named kind (a wall, an end plane or the ceiling) that actually
 * exists, within the documented floor tolerance. A point on the bounding plane of the truck but where
 * no face is drawn (the cab void) is not on the surface.
 * @param {string} surface
 * @param {{ x: number, y: number, z: number }} point
 * @param {ReturnType<typeof buildTruckShellFaces>} faces
 */
export function pointOnTruckShell(surface, point, faces) {
  if (!isRecord(point) || !Array.isArray(faces)) return false;
  const coordinates = [point.x, point.y, point.z];
  return faces.some(face => face.surface === surface && coordinates.every((value, axis) =>
    value >= face.min[axis] - FLOOR_EPSILON && value <= face.max[axis] + FLOOR_EPSILON));
}

function floorContains(floor, point) {
  return point.x >= floor.xMin - FLOOR_EPSILON && point.x <= floor.xMax + FLOOR_EPSILON &&
    point.z >= floor.zMin - FLOOR_EPSILON && point.z <= floor.zMax + FLOOR_EPSILON;
}

// ============================================================================
// SECTION: RESOLUTION + VALIDITY
// ============================================================================

const REASON_TEXT = Object.freeze({
  'cargo-missing': 'The cargo this point was placed on is no longer in this Load Plan.',
  'cargo-ambiguous': 'More than one cargo item in this Load Plan has the same ID, so the cargo this point belongs to cannot be identified.',
  'case-missing': 'The Case definition for this cargo is missing.',
  'case-changed': 'The Case size or shape changed. Delete and recreate this measurement to confirm it.',
  'pose-invalid': 'The cargo position or orientation could not be read.',
  'floor-missing': 'The floor surface for this point no longer exists.',
  'floor-changed': 'The floor at this point has changed. Delete and recreate this measurement to confirm it.',
  'truck-changed': 'The truck changed after this point was placed. Delete and recreate this measurement to confirm it.',
  'truck-unverified': 'The truck this point was placed on cannot be confirmed. Delete and recreate this measurement to confirm it.',
  'distance-invalid': 'The distance could not be calculated from these positions.',
  unreadable: 'The saved data could not be read. The original is kept until you delete it.',
});

export function describeMeasurementReason(reason) {
  return REASON_TEXT[reason] || '';
}

export function measurementStatusLabel(status) {
  if (status === MEASUREMENT_STATUS.VALID) return 'Valid';
  if (status === MEASUREMENT_STATUS.NEEDS_REVIEW) return 'Needs review';
  return 'Unresolved';
}

/**
 * Committed world pose (inches) of a cargo instance, mirroring the scene's applyTransform:
 * translation is the stored centre, rotation is the stored Euler XYZ angles, transform.scale is
 * ignored, and the centre height is floored at half the oriented height.
 * @returns {{ center: {x:number,y:number,z:number}, rotation: {x:number,y:number,z:number} } | null}
 */
export function resolveCargoPose(instance, caseData) {
  const transform = instance && instance.transform;
  const position = transform && transform.position;
  const rotation = (transform && transform.rotation) || { x: 0, y: 0, z: 0 };
  if (!isRecord(position) || ![position.x, position.y, position.z].every(isFiniteNumber)) return null;
  if (![rotation.x, rotation.y, rotation.z].every(isFiniteNumber)) return null;
  const pose = getActualPoseDimensions(caseData, instance);
  const baseHeight = caseData && caseData.dimensions && caseData.dimensions.height;
  const halfHeight = pose.valid && pose.value ? pose.value.height / 2 : (isFiniteNumber(baseHeight) ? baseHeight / 2 : 0);
  const minimumY = halfHeight > 0 ? halfHeight : SCENE_FALLBACK_HALF_HEIGHT_INCHES;
  return {
    center: { x: position.x, y: Math.max(minimumY, position.y), z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
  };
}

/** World point (inches) of a cargo-local point under a committed pose. */
export function cargoLocalToWorld(pose, local) {
  const rotated = applyEulerXYZ(pose.rotation, local);
  return { x: rotated.x + pose.center.x, y: rotated.y + pose.center.y, z: rotated.z + pose.center.z };
}

function unresolved(reason) {
  return { status: MEASUREMENT_STATUS.UNRESOLVED, reason, point: null };
}

function needsReview(reason) {
  return { status: MEASUREMENT_STATUS.NEEDS_REVIEW, reason, point: null };
}

/**
 * @param {Record<string, any>} anchor
 * @param {{ instance?: any, caseData?: any }} context
 */
export function resolveCargoAnchor(anchor, { instance, caseData }) {
  if (!instance) return unresolved('cargo-missing');
  if (!caseData) return unresolved('case-missing');
  if (!signaturesMatch(getCargoGeometrySignature(caseData), anchor.signature)) return needsReview('case-changed');
  const pose = resolveCargoPose(instance, caseData);
  if (!pose) return unresolved('pose-invalid');
  const local = cargoAnchorLocal(anchor);
  return { status: MEASUREMENT_STATUS.VALID, reason: null, point: cargoLocalToWorld(pose, local) };
}

/**
 * @param {Record<string, any>} anchor
 * @param {{ floors?: ReturnType<typeof buildFloorSurfaces> }} context
 */
export function resolveFloorAnchor(anchor, { floors }) {
  const point = anchor.position;
  const surfaces = Array.isArray(floors) ? floors : [];
  const exact = surfaces.find(floor => floor.surface === anchor.surface &&
    Math.abs(floor.elevation - point.y) <= FLOOR_EPSILON && floorContains(floor, point));
  if (exact) return { status: MEASUREMENT_STATUS.VALID, reason: null, point: { x: point.x, y: point.y, z: point.z } };
  // The same spot is still on a floor, but not the one that was measured: never relocate.
  return surfaces.some(floor => floorContains(floor, point)) ? needsReview('floor-changed') : unresolved('floor-missing');
}

/**
 * Whether a truck-bound point is still on the truck it was placed on, judged only by evidence: the
 * effective usable zones it was placed on (remembered, or provable from a rectangular truck's
 * dimensions) must equal the current effective zones, as a set of boxes, and the point must lie on a
 * wall, end plane or ceiling face that physically exists on the current truck. The comparison is of
 * geometry, not of configuration, so equivalent settings (an explicit default, an unused key, a Front
 * Overhang of length 0 on a standard truck) are the same truck while any real change to a wall, the
 * ceiling, a deck or a Wheel Well is not.
 * @returns {'valid' | 'changed' | 'unverified'} `unverified`: the original geometry cannot be proven
 *   (an older Front Overhang or Wheel Well record, or no current geometry), which is never Valid.
 */
function truckEvidence(anchor, zones, truck) {
  const placedOn = placedOnZones(anchor.truck);
  const current = canonicalZones(zones !== undefined ? zones : (truck && truck.zones));
  if (!placedOn || !current) return 'unverified';
  const faces = shellFacesOf(getTruckSignature(truck, current), current);
  if (!faces) return 'unverified';
  return sameZoneSets(placedOn, current) && pointOnTruckShell(anchor.surface, anchor.position, faces) ? 'valid' : 'changed';
}

/**
 * A fixed-space point never moves. Ground and free points are always Valid; a point on the truck
 * shell is Valid only while its truck geometry is proven unchanged (see truckEvidence), otherwise
 * Needs Review (the point is never relocated onto the new truck).
 * @param {Record<string, any>} anchor
 * @param {{ truck?: any, zones?: any }} context `zones` are the current usable zones
 */
export function resolveSpaceAnchor(anchor, { truck, zones }) {
  const point = { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z };
  if (!TRUCK_BOUND_SURFACES.has(anchor.surface)) return { status: MEASUREMENT_STATUS.VALID, reason: null, point };
  const evidence = truckEvidence(anchor, zones, truck);
  if (evidence === 'valid') return { status: MEASUREMENT_STATUS.VALID, reason: null, point };
  return needsReview(evidence === 'changed' ? 'truck-changed' : 'truck-unverified');
}

/**
 * Resolve one anchor of any kind against the Load Plan: the single dispatch used by every caller.
 * @param {Record<string, any>} anchor
 * @param {{ getInstance?: (id: string) => any, getCase?: (id: string) => any, isInstanceAmbiguous?: (id: string) => boolean,
 *   floors?: any[], truck?: any, zones?: any }} context
 */
export function resolveAnchor(anchor, context) {
  if (anchor.kind === 'space') return resolveSpaceAnchor(anchor, context);
  if (anchor.kind === 'floor') return resolveFloorAnchor(anchor, context);
  // Several instances sharing the ID: which one the point belongs to cannot be known.
  if (context.isInstanceAmbiguous && context.isInstanceAmbiguous(anchor.instanceId)) return unresolved('cargo-ambiguous');
  const instance = context.getInstance ? context.getInstance(anchor.instanceId) : null;
  return resolveCargoAnchor(anchor, { instance, caseData: instance && context.getCase ? context.getCase(instance.caseId) : null });
}

// ============================================================================
// SECTION: DRAW SURFACES (freehand strokes: one flat face or one convex patch)
// ============================================================================
// A stroke is a polyline drawn on exactly ONE flat, convex patch: a face of a box, a flat end cap of a
// cylinder or drum, one usable-zone floor rectangle, one physical wall or ceiling rectangle, or the ground.
// Its first vertex is the stroke's Measurement anchor (so the cargo identity policy, truck evidence and
// surface protections are exactly those of every other anchor); later vertices are absolute surface-local
// `(u, v)` inches in the frame below. Nothing here moves, snaps or substitutes a vertex: a stroke is
// either wholly on its patch or it is not Valid.

/**
 * How far (inches, per axis for a rectangle, Euclidean for the cap polygon) a stroke vertex may sit outside
 * its patch and still count as on it. A real pick is on the surface, and quantizing it to 0.01 in moves it
 * by at most 0.01 / sqrt(2) = 0.00707 in, so this is the smallest round value that never rejects an honest
 * stroke that ends on a patch edge. It is deliberately separate from the cargo-surface tolerance, the
 * floor tolerance, the 0.01 in quantum and the simplification error.
 */
export const DRAW_FOOTPRINT_TOLERANCE_INCHES = 0.01;

/** Which world frame (a FACE_FRAME key) each non-cargo surface is drawn in. Floors share the ground's. */
const WORLD_DRAW_FRAME = Object.freeze({
  ground: '+y',
  ceiling: '+y',
  'wall-left': '+z',
  'wall-right': '-z',
  'wall-front': '+x',
  'wall-rear': '-x',
});
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });

function isRoundSignature(signature) {
  const shape = String((signature && signature.shape) || '').trim().toLowerCase();
  return shape === 'cylinder' || shape === 'drum';
}

/** `{ normal, sign, u, v }` of a cargo face: the axis it faces, which side, and its two in-plane axes. Null for an unknown face. */
export function cargoFaceFrame(face) {
  return BOX_FACES.includes(face) ? { ...FACE_FRAME[face] } : null;
}

/** All six faces of a box; only the two flat end caps (+x, -x) of a cylinder or drum (its side wall is curved). */
export function isCargoFaceSupported(face, signature) {
  if (!BOX_FACES.includes(face) || !isRecord(signature)) return false;
  return isRoundSignature(signature) ? face === '+x' || face === '-x' : true;
}

/**
 * The flat patch of a cargo face in the face's own `(u, v)` inches (centre origin), plus the signed plane
 * coordinate along the face normal. A box face is the exact rectangle; a cap is the 24-sided polygon the
 * Editor actually builds (circumradius = half of the smaller of width and height), never the circle around
 * it. Null when the face is not supported for the signature.
 * @returns {{ kind: 'rect', uMin: number, uMax: number, vMin: number, vMax: number, plane: number }
 *   | { kind: 'ngon', radius: number, plane: number } | null}
 */
export function cargoFacePatch(face, signature) {
  if (!isCargoFaceSupported(face, signature)) return null;
  if (!['length', 'width', 'height'].every(key => isPositiveNumber(signature[key]))) return null;
  const frame = FACE_FRAME[face];
  const half = halfExtents(signature);
  const plane = frame.sign * half[frame.normal];
  if (isRoundSignature(signature)) return { kind: 'ngon', radius: Math.min(signature.width, signature.height) / 2, plane };
  return { kind: 'rect', uMin: -half[frame.u], uMax: half[frame.u], vMin: -half[frame.v], vMax: half[frame.v], plane };
}

/** Whether a cargo-local point lies on the plane of a face, within the same tolerance as every cargo anchor. */
export function isCargoPointOnFacePlane(face, local, signature) {
  const patch = cargoFacePatch(face, signature);
  if (!patch || !isRecord(local)) return false;
  const value = local[FACE_FRAME[face].normal];
  return isFiniteNumber(value) && Math.abs(value - patch.plane) <= cargoSurfaceTolerance(signature);
}

/**
 * Whether `(u, v)` lies on a patch, within `tolerance`: per axis for a rectangle, and for a cap by its
 * Euclidean distance to the polygon (so a point inside the circle around the cap but outside the
 * polygon is outside).
 */
export function patchContains(patch, u, v, tolerance = DRAW_FOOTPRINT_TOLERANCE_INCHES) {
  if (!patch || !isFiniteNumber(u) || !isFiniteNumber(v)) return false;
  if (patch.kind === 'ngon') return polygonSignedDistance(v, u, patch.radius) <= tolerance;
  return u >= patch.uMin - tolerance && u <= patch.uMax + tolerance &&
    v >= patch.vMin - tolerance && v <= patch.vMax + tolerance;
}

/** Whether EVERY vertex of a flat `[u0, v0, u1, v1, ...]` list is on the one patch. */
export function patchContainsAll(patch, flat, tolerance = DRAW_FOOTPRINT_TOLERANCE_INCHES) {
  if (!patch || !Array.isArray(flat) || !flat.length || flat.length % 2) return false;
  for (let i = 0; i < flat.length; i += 2) if (!patchContains(patch, flat[i], flat[i + 1], tolerance)) return false;
  return true;
}

/** The patch boundary as a flat counter-clockwise `[u, v, ...]` outline (4 vertices, or the cap's 24), for exact clipping. */
export function patchOutline(patch) {
  if (!patch) return null;
  if (patch.kind === 'ngon') {
    const outline = [];
    // Vertex i of the mesh is (y, z) = (sin, cos) of i * step; a cap's (u, v) is (z, y).
    for (let i = 0; i < CARGO_CYLINDER_SEGMENTS; i++) outline.push(CYLINDER_VERTEX[i][1] * patch.radius, CYLINDER_VERTEX[i][0] * patch.radius);
    return outline;
  }
  return [patch.uMin, patch.vMin, patch.uMax, patch.vMin, patch.uMax, patch.vMax, patch.uMin, patch.vMax];
}

/**
 * The frame a stroke is drawn in, as a key into the face table: the stored face for cargo, `+y` for any
 * floor, the ground and the ceiling, and the wall's own plane for a wall. Null where no stroke may be
 * drawn (open space, a malformed anchor, or cargo without a known face).
 */
export function drawFrameKey(anchor, face) {
  if (!isRecord(anchor)) return null;
  if (anchor.kind === 'cargo') return BOX_FACES.includes(face) ? face : null;
  if (anchor.kind === 'floor') return '+y';
  if (anchor.kind === 'space' && Object.hasOwn(WORLD_DRAW_FRAME, anchor.surface)) return WORLD_DRAW_FRAME[anchor.surface];
  return null;
}

/** The anchor's own point in the frame its stroke lives in: cargo-local for cargo, world for every other kind. */
function drawAnchorPoint(anchor) {
  if (anchor.kind === 'cargo') return isRecord(anchor.local) ? anchor.local : null;
  return isRecord(anchor.position) ? anchor.position : null;
}

/** `(u, v)` of a stroke's first vertex (the anchor itself) in the stroke's frame, at the anchor's stored 4-decimal precision. */
export function drawAnchorUV(anchor, face) {
  const key = drawFrameKey(anchor, face);
  const point = isRecord(anchor) ? drawAnchorPoint(anchor) : null;
  if (!key || !point) return null;
  const frame = FACE_FRAME[key];
  const u = point[frame.u];
  const v = point[frame.v];
  return isFiniteNumber(u) && isFiniteNumber(v) ? { u, v } : null;
}

/**
 * A surface-local `(u, v)` as a point in the anchor's frame (cargo-local or world), at the anchor's own
 * coordinate along the surface normal, so every vertex of a stroke lies in the one plane its first vertex
 * is in. Null when the frame is unknown.
 */
export function drawLift(anchor, face, u, v) {
  const key = drawFrameKey(anchor, face);
  const point = isRecord(anchor) ? drawAnchorPoint(anchor) : null;
  if (!key || !point) return null;
  const frame = FACE_FRAME[key];
  const lifted = { x: 0, y: 0, z: 0 };
  lifted[frame.normal] = point[frame.normal];
  lifted[frame.u] = u;
  lifted[frame.v] = v;
  return lifted;
}

// ----------------------------------------------------------------------------
// Rigid pair moves (a whole Arrow or Measurement carried along ONE surface)
// ----------------------------------------------------------------------------
// Both endpoints move by the same in-plane offset, so the length, direction and everything else about the
// pair is preserved. That is only well defined when the two anchors sit on one physical surface in one
// coordinate frame: the same cargo face, or the same floor, ground, wall or ceiling plane of the same
// truck evidence. A shared plane direction alone is not proof (two different cargo, a floor and the
// ground, or two walls facing the same way are different surfaces), so anything else is refused here and
// the endpoints stay individually movable.

/** How far apart (inches) two anchors' coordinates along the surface normal may be and still be one plane. */
const RIGID_PLANE_TOLERANCE_INCHES = 0.01;

/**
 * Whether two anchors share one surface a pair can be carried along, and in which frame. For cargo that is
 * exactly ONE supported face holding both points (two points on a shared edge could belong to either face,
 * so that is refused as ambiguous); for everything else it is the one plane of the same floor, ground, wall
 * or ceiling, with the same truck evidence on a truck-bound surface.
 * @param {Record<string, any>} start
 * @param {Record<string, any>} end
 * @returns {{ ok: true, key: string, face: string | undefined }
 *   | { ok: false, reason: 'invalid' | 'mixed' | 'different-cargo' | 'unsupported' | 'ambiguous' | 'no-common-surface' }}
 */
export function rigidMoveFrame(start, end) {
  if (!isRecord(start) || !isRecord(end) || validateAnchor(start, 'start') || validateAnchor(end, 'end')) return { ok: false, reason: 'invalid' };
  if (start.kind !== end.kind) return { ok: false, reason: 'mixed' };
  if (start.kind === 'cargo') {
    if (instanceIdentityKey(start.instanceId) !== instanceIdentityKey(end.instanceId) || !signaturesMatch(start.signature, end.signature)) {
      return { ok: false, reason: 'different-cargo' };
    }
    if (!isRecord(start.local) || !isRecord(end.local)) return { ok: false, reason: 'unsupported' };
    const common = BOX_FACES.filter(face => {
      const patch = cargoFacePatch(face, start.signature);
      const frame = FACE_FRAME[face];
      return Boolean(patch) && [start.local, end.local].every(local => isCargoPointOnFacePlane(face, local, start.signature) &&
        patchContains(patch, local[frame.u], local[frame.v]));
    });
    if (common.length === 1) return { ok: true, key: common[0], face: common[0] };
    return { ok: false, reason: common.length ? 'ambiguous' : 'no-common-surface' };
  }
  const key = drawFrameKey(start, undefined);
  if (!key) return { ok: false, reason: 'unsupported' };
  if (start.surface !== end.surface) return { ok: false, reason: 'mixed' };
  const frame = FACE_FRAME[key];
  if (Math.abs(start.position[frame.normal] - end.position[frame.normal]) > RIGID_PLANE_TOLERANCE_INCHES) return { ok: false, reason: 'no-common-surface' };
  if (TRUCK_BOUND_SURFACES.has(start.surface) && JSON.stringify(start.truck) !== JSON.stringify(end.truck)) return { ok: false, reason: 'no-common-surface' };
  return { ok: true, key, face: undefined };
}

/**
 * Pure rigid move of an anchor pair by one in-plane offset `(du, dv)` in their shared frame (inches). The offset
 * is snapped to the 0.01 in grid, both coordinates move at their own 4-decimal precision and keep their
 * coordinate along the surface normal; every other field of both anchors is carried over. Null when the pair
 * does not share one surface (see rigidMoveFrame) or the offset is not finite. Whether the moved pair is still on
 * its physical patch, and still resolves, needs the layout and is judged at write time (rigidMoveHeld, resolution).
 * @param {Record<string, any>} start
 * @param {Record<string, any>} end
 * @param {number} du
 * @param {number} dv
 * @returns {{ start: Record<string, any>, end: Record<string, any>, du: number, dv: number, key: string, face: string | undefined } | null}
 */
export function translateAnchorPair(start, end, du, dv) {
  if (!isFiniteNumber(du) || !isFiniteNumber(dv)) return null;
  const frame = rigidMoveFrame(start, end);
  if (!frame.ok) return null;
  const axes = FACE_FRAME[frame.key];
  const offset = [Math.round(du * 100) / 100 + 0, Math.round(dv * 100) / 100 + 0];
  const shift = anchor => {
    const home = anchor.kind === 'cargo' ? 'local' : 'position';
    const next = { ...anchor, [home]: { ...anchor[home] } };
    next[home][axes.u] = round(next[home][axes.u] + offset[0], 4);
    next[home][axes.v] = round(next[home][axes.v] + offset[1], 4);
    return next;
  };
  return { start: shift(start), end: shift(end), du: offset[0], dv: offset[1], key: frame.key, face: frame.face };
}

/**
 * Whether ONE physical patch of the current layout holds the pair both where it is and where a move would put it,
 * so a move can never carry it onto a second zone, wall piece, or off the edge of its cargo face.
 * @param {{ key: string, face: string | undefined }} frame from rigidMoveFrame
 * @param {{ start: Record<string, any>, end: Record<string, any> }} before
 * @param {{ start: Record<string, any>, end: Record<string, any> }} after
 * @param {Parameters<typeof resolveAnchor>[1]} context
 */
export function rigidMoveHeld(frame, before, after, context) {
  const axes = FACE_FRAME[frame.key];
  if (!axes) return false;
  const flat = [before.start, before.end, after.start, after.end].flatMap(anchor => {
    const point = anchor.kind === 'cargo' ? anchor.local : anchor.position;
    return [point[axes.u], point[axes.v]];
  });
  const patches = before.start.kind === 'cargo' ? [cargoFacePatch(frame.face, before.start.signature)] : drawSurfacePatches(before.start, context);
  return patches.some(patch => patchContainsAll(patch, flat));
}

/**
 * Pure rigid move of a whole point-to-point record: both endpoints by the same in-plane offset. The label,
 * identity and creation time are preserved; the distance is still derived, never stored. An offset that snaps to
 * zero returns the record unchanged (same `updatedAt`), anything else gets `updatedAt = now`. Null for a record
 * that is not valid, a pair that does not share one surface, a non-finite offset or an invalid result.
 * @param {Record<string, any>} record
 * @param {number} du
 * @param {number} dv
 * @param {number} now
 * @returns {Record<string, any> | null}
 */
export function translateMeasurementRecord(record, du, dv, now) {
  if (!isRecord(record) || record.type !== MEASUREMENT_TYPE_POINT_TO_POINT || !isFiniteNumber(now)) return null;
  if (validatePointRecord(record)) return null;
  const moved = translateAnchorPair(record.start, record.end, du, dv);
  if (!moved) return null;
  if (moved.du === 0 && moved.dv === 0) return canonicalPointRecord(record);
  const next = { ...record, start: moved.start, end: moved.end, updatedAt: now };
  return validatePointRecord(next) ? null : canonicalPointRecord(next);
}

/**
 * What a stroke's anchor and face must satisfy on their own, with no Load Plan around them. Run after
 * validateAnchor. Cargo: the new local-point encoding, a face this cargo supports, the point on that
 * face's plane and inside its footprint. Floor: nothing more. Ground: on the ground plane. A wall or the
 * ceiling must remember the usable zones it was placed on. Open space and a `face` on anything but cargo
 * are refused. Whether a world stroke's vertices share one patch needs the current truck, so it is judged
 * at resolution (resolveDrawVertices) and at write time, not here.
 * @returns {string | null}
 */
export function validateDrawSurface(anchor, face, label = 'anchor') {
  if (!isRecord(anchor)) return `${label} must be an object`;
  if (anchor.kind === 'cargo') {
    if (!isRecord(anchor.local)) return `${label} must use a cargo-local point`;
    if (!isCargoFaceSupported(face, anchor.signature)) return 'face is not supported for this cargo';
    if (!isCargoPointOnFacePlane(face, anchor.local, anchor.signature)) return `${label} is not on the plane of its face`;
    const uv = drawAnchorUV(anchor, face);
    return uv && patchContains(cargoFacePatch(face, anchor.signature), uv.u, uv.v) ? null : `${label} is outside its face`;
  }
  if (face !== undefined) return 'face is only allowed on cargo';
  if (anchor.kind === 'floor') return null;
  if (anchor.kind === 'space') {
    if (anchor.surface === 'free') return 'open space cannot carry a drawing';
    if (anchor.surface === 'ground') return Math.abs(anchor.position.y) <= FLOOR_EPSILON ? null : `${label} is not on the ground`;
    return isRecord(anchor.truck) && anchor.truck.zones !== undefined ? null : `${label}.truck.zones is required`;
  }
  return `${label}.kind is invalid`;
}

/** @returns {{ kind: 'rect', uMin: number, uMax: number, vMin: number, vMax: number, plane: number }} */
function rectPatch(uMin, uMax, vMin, vMax, plane) {
  return { kind: 'rect', uMin, uMax, vMin, vMax, plane };
}

/**
 * The permitted convex patches of a world stroke, in the stroke's `(u, v)` frame, from the CURRENT layout:
 *  - floor: every usable-zone floor with the anchor's label whose elevation is within the floor tolerance
 *    of the anchor's (a Wheel Well top is a different patch from the main floor beside it, and a second
 *    main-floor zone is a different patch from the first);
 *  - ground: one patch far larger than any truck, at elevation 0, apart from the truck floor;
 *  - wall or ceiling: every physical shell face of that kind lying in the anchor's plane.
 * Nothing is identified by position in a list, so reordering the zones changes nothing. Empty for cargo.
 * @returns {Array<{ kind: 'rect', uMin: number, uMax: number, vMin: number, vMax: number, plane: number }>}
 */
export function drawSurfacePatches(anchor, context) {
  if (!isRecord(anchor) || anchor.kind === 'cargo' || !isRecord(anchor.position)) return [];
  if (anchor.kind === 'floor') {
    const floors = Array.isArray(context && context.floors) ? context.floors : [];
    return floors
      .filter(floor => floor.surface === anchor.surface && Math.abs(floor.elevation - anchor.position.y) <= FLOOR_EPSILON)
      .map(floor => rectPatch(floor.xMin, floor.xMax, floor.zMin, floor.zMax, floor.elevation));
  }
  if (anchor.surface === 'ground') {
    const reach = MAX_ANCHOR_COORDINATE_INCHES;
    return [rectPatch(-reach, reach, -reach, reach, 0)];
  }
  const key = drawFrameKey(anchor, undefined);
  if (!key || !TRUCK_BOUND_SURFACES.has(anchor.surface)) return [];
  const frame = FACE_FRAME[key];
  const [normalAxis, uAxis, vAxis] = [AXIS_INDEX[frame.normal], AXIS_INDEX[frame.u], AXIS_INDEX[frame.v]];
  const zones = context && context.zones !== undefined ? context.zones : (context && context.truck && context.truck.zones);
  return getTruckShellFaces(context && context.truck, zones)
    .filter(face => face.surface === anchor.surface &&
      Math.abs(face.min[normalAxis] - anchor.position[frame.normal]) <= FLOOR_EPSILON)
    .map(face => rectPatch(face.min[uAxis], face.max[uAxis], face.min[vAxis], face.max[vAxis], face.min[normalAxis]));
}

/**
 * Resolve a stroke against the Load Plan: the world position of every vertex, or why there is none.
 * The first vertex is the anchor, so everything `resolveAnchor` decides (missing or ambiguous cargo, a
 * changed Case, a changed truck, a changed floor) decides here first and is passed through unchanged. Then
 * one patch must hold EVERY vertex within the footprint tolerance, otherwise the stroke Needs Review
 * (`stroke-off-surface`) and no position is offered: a vertex is never relocated, snapped or substituted.
 * @param {Record<string, any>} anchor
 * @param {string | undefined} face
 * @param {number[]} points flat surface-local `[u, v, ...]` of vertices 1..n
 * @param {Parameters<typeof resolveAnchor>[1]} context
 * @returns {{ status: string, reason: string | null, vertices: Array<{x:number,y:number,z:number}> | null }}
 */
export function resolveDrawVertices(anchor, face, points, context) {
  const resolution = resolveAnchor(anchor, context);
  if (resolution.status !== MEASUREMENT_STATUS.VALID) return { status: resolution.status, reason: resolution.reason, vertices: null };
  const first = drawAnchorUV(anchor, face);
  if (!first || !Array.isArray(points) || points.length < 2 || points.length % 2 || !points.every(isFiniteNumber)) {
    return { ...unresolved('point-invalid'), vertices: null };
  }
  const uv = [first.u, first.v, ...points];
  let patches;
  let toPoint;
  if (anchor.kind === 'cargo') {
    const patch = cargoFacePatch(face, anchor.signature);
    if (!patch) return { ...unresolved('surface-unsupported'), vertices: null };
    const instance = context.getInstance ? context.getInstance(anchor.instanceId) : null;
    const caseData = instance && context.getCase ? context.getCase(instance.caseId) : null;
    const pose = instance && caseData ? resolveCargoPose(instance, caseData) : null;
    if (!pose) return { ...unresolved('pose-invalid'), vertices: null };
    patches = [patch];
    toPoint = (u, v) => cargoLocalToWorld(pose, drawLift(anchor, face, u, v));
  } else {
    patches = drawSurfacePatches(anchor, context);
    toPoint = (u, v) => drawLift(anchor, face, u, v);
  }
  if (!patches.some(patch => patchContainsAll(patch, uv))) return { ...needsReview('stroke-off-surface'), vertices: null };
  const vertices = [];
  for (let i = 0; i < uv.length; i += 2) {
    const point = toPoint(uv[i], uv[i + 1]);
    if (!isFinitePoint(point)) return { ...unresolved('point-invalid'), vertices: null };
    vertices.push({ x: point.x, y: point.y, z: point.z });
  }
  return { status: MEASUREMENT_STATUS.VALID, reason: null, vertices };
}

function resolvedMeasurement(record, reason = 'unreadable') {
  return {
    id: record.id,
    status: MEASUREMENT_STATUS.UNRESOLVED,
    reason,
    start: null,
    end: null,
    distance: null,
    delta: null,
  };
}

function isFinitePoint(point) {
  return Boolean(point) && [point.x, point.y, point.z].every(isFiniteNumber);
}

/**
 * Derived validity and geometry for one measurement. The distance exists only when both anchors
 * resolve; Needs Review and Unresolved never carry a number.
 * @param {Record<string, any>} record normalized record
 * @param {{ getInstance: (id: string) => any, getCase: (id: string) => any, isInstanceAmbiguous?: (id: string) => boolean, floors: any[], truck?: any, zones?: any }} context
 */
export function resolveMeasurement(record, context) {
  if (record.type !== MEASUREMENT_TYPE_POINT_TO_POINT) return resolvedMeasurement(record);
  const start = resolveAnchor(record.start, context);
  const end = resolveAnchor(record.end, context);
  const worst = [start, end].find(r => r.status === MEASUREMENT_STATUS.UNRESOLVED) ||
    [start, end].find(r => r.status === MEASUREMENT_STATUS.NEEDS_REVIEW);
  if (worst) {
    return { id: record.id, status: worst.status, reason: worst.reason, start: null, end: null, distance: null, delta: null };
  }
  // Valid always carries a usable number: resolved points, their differences and the distance must be
  // finite (a pose can place cargo anywhere), otherwise no figure is offered.
  if (!isFinitePoint(start.point) || !isFinitePoint(end.point)) return resolvedMeasurement(record, 'distance-invalid');
  const measured = measureBetween(start.point, end.point);
  if (!isFiniteNumber(measured.distance) || !isFinitePoint(measured.delta)) return resolvedMeasurement(record, 'distance-invalid');
  return {
    id: record.id,
    status: MEASUREMENT_STATUS.VALID,
    reason: null,
    start: start.point,
    end: end.point,
    ...measured,
  };
}

/** Straight-line 3D distance and absolute axis deltas between two world points (inches). */
export function measureBetween(a, b) {
  const delta = { x: Math.abs(b.x - a.x), y: Math.abs(b.y - a.y), z: Math.abs(b.z - a.z) };
  return { distance: Math.hypot(delta.x, delta.y, delta.z), delta };
}

/** @returns {Array<ReturnType<typeof resolveMeasurement>>} one result per normalized record, in order */
export function resolveMeasurementList(measurements, context) {
  return normalizeMeasurements(measurements).map(record => resolveMeasurement(record, context));
}

// ============================================================================
// SECTION: DISPLAY
// ============================================================================

const DISPLAY_DECIMALS = Object.freeze({ in: 1, ft: 2, cm: 1, m: 3 });

/** Measurement-specific length text. The whole-inch app formatter is too coarse for a ruler. */
export function formatMeasurementLength(inches, unit = 'in') {
  const key = Object.hasOwn(DISPLAY_DECIMALS, unit) ? unit : 'in';
  const value = inchesToUnit(inches, key);
  return Number.isFinite(value) ? `${value.toFixed(DISPLAY_DECIMALS[key])} ${key}` : '—';
}

export function defaultMeasurementName(index) {
  return `Measurement ${index + 1}`;
}
