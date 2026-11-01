/**
 * @file editor-screen.js
 * @description Screen factory responsible for rendering and binding UI for a specific screen.
 * @module screens/editor-screen
 * @created Unknown
 * @updated 01/22/2026
 * @author Truck Packer 3D Team
 */

// ============================================================================
// SECTION: IMPORTS AND DEPENDENCIES
// ============================================================================

import { createCaseGeometry } from '../editor/geometry-factory.js';
import { openCaseModal as openSharedCaseModal } from '../ui/overlays/case-modal.js';
import { openNotesOverlay, resolveNotesFocusTarget } from '../ui/overlays/notes-overlay.js';
import {
  buildSpaceUtilizationResult,
  createSpaceUtilizationGauge,
} from '../ui/space-utilization-gauge.js';
import * as CoreStorage from '../core/storage.js';
import { editorViewSignature, normalizeEditorView } from '../core/normalizer.js';
import {
  assessNormalAutoPackCandidate, buildAutoPackCaseRuleSignature, buildAutoPackLayoutSignature,
  buildAutoPackResultSignature, buildAutoPackSourceSignature, isAutoPackResultsFresh,
  isNormalAutoPackCandidateAcceptable,
} from '../services/autopack-engine.js';
import { MIN_SUPPORT_FRACTION } from '../services/pack-library.js';
import { getCaseHandlingSummary } from '../services/case-rule-summary.js';
import { isCasePhysicalOrientationAllowed } from '../core/orientation.js';
import { getActualPoseDimensions } from '../core/oriented-dims.js';
import { formatWeight } from '../core/utils/index.js';

// Editor screen + 3D interaction helpers (extracted from src/app.js; behavior preserved)

function caseCountText(count) {
  return `${count} case${count === 1 ? '' : 's'}`;
}

function formatEditorCaseWeightLabel(weight, unit) {
  return formatWeight(weight, unit, 2);
}

export function resetEditorCaseQtyDrafts(caseQtyDrafts) {
  caseQtyDrafts.clear();
}

const STAGING_QTY_INVALID_MESSAGE = 'Enter a whole quantity from 1 to 10,000.';
const NO_LOAD_PLAN_MESSAGE = 'Create or open a load plan first';
const CASE_MISSING_MESSAGE = 'This case no longer exists.';

// Maps a non-ok PackLibrary.addInstancesToStaging() result to its user feedback.
// The service owns the reason; this only chooses copy and toast tone.
export function getStagingAddFailureFeedback(result) {
  const reason = result && result.reason;
  if (reason === 'invalid-count') return { message: STAGING_QTY_INVALID_MESSAGE, tone: 'warning' };
  if (reason === 'pack-not-found') return { message: NO_LOAD_PLAN_MESSAGE, tone: 'warning' };
  if (reason === 'case-not-found') return { message: CASE_MISSING_MESSAGE, tone: 'error' };
  if (reason === 'placement-incomplete') {
    return { message: "Couldn't place the full quantity in staging. Nothing was added.", tone: 'warning' };
  }
  return { message: 'Add failed. Please try again.', tone: 'error' };
}

// Maps a PackLibrary.removeCaseInstancesFromStaging() result to its user
// feedback. Shortage is all-or-nothing, so its copy always says nothing was
// removed; eligibleCount comes from the service, never recomputed in the Editor.
export function getStagingRemoveFeedback(result) {
  const reason = result && result.reason;
  if (reason === 'ok') {
    return { message: `Removed ${caseCountText(result.removedCount)} from staging.`, tone: 'info' };
  }
  if (reason === 'insufficient-eligible') {
    return result.eligibleCount > 0
      ? { message: `Only ${result.eligibleCount} can be removed from staging. Nothing was removed.`, tone: 'warning' }
      : { message: 'No cases can be removed from staging. Nothing was removed.', tone: 'warning' };
  }
  if (reason === 'invalid-count') return { message: STAGING_QTY_INVALID_MESSAGE, tone: 'warning' };
  if (reason === 'pack-not-found') return { message: NO_LOAD_PLAN_MESSAGE, tone: 'warning' };
  if (reason === 'case-not-found') return { message: CASE_MISSING_MESSAGE, tone: 'error' };
  return { message: 'Remove failed. Please try again.', tone: 'error' };
}

// Selection after a Qty Remove: drop ONLY the removed ids and keep every other
// selected id (including any unrelated stale one) exactly as it was. Returns
// null when none of the removed ids were selected, meaning "make no selection
// write". Qty Remove is not explicit Delete, which clears the whole selection.
export function pruneSelectionAfterRemoval(selectedIds, removedIds) {
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  const removed = new Set(Array.isArray(removedIds) ? removedIds : []);
  if (!selected.length || !removed.size) return null;
  if (!selected.some(id => removed.has(id))) return null;
  return selected.filter(id => !removed.has(id));
}

// Duplicate-click suppression for the staging actions "+ Add" and "Unstage". A
// physical double-click delivers its second click to the button the FIRST click's
// synchronous re-render just built, after Qty has already reset to 1 — so it would
// act a second, unintended time (Add(5)+Add(1), Unstage(2)+Unstage(1)).
// This remembers only the most recent SUCCESSFUL action, keyed by kind + Pack +
// Case, in memory: no persistence, no StateStore/history, no lifecycle kind,
// nothing async. It lives outside the card DOM, so it survives the card being
// replaced. Each kind, Pack, and Case is independent, and the window is short so
// a deliberate follow-up action is unaffected.
export const STAGING_ACTION_DUPLICATE_CLICK_MS = 400;
export const STAGING_ACTION_KIND = Object.freeze({ ADD: 'add', UNSTAGE: 'unstage' });

export function createStagingActionDuplicateGuard({
  windowMs = STAGING_ACTION_DUPLICATE_CLICK_MS,
  now = () => performance.now(),
} = {}) {
  let last = null;
  const keyOf = (kind, packId, caseId) => JSON.stringify([kind, packId, caseId]);
  return {
    isDuplicate(kind, packId, caseId) {
      return last !== null && last.key === keyOf(kind, packId, caseId) && now() - last.at < windowMs;
    },
    recordSuccess(kind, packId, caseId) {
      last = { key: keyOf(kind, packId, caseId), at: now() };
    },
  };
}

function getDeleteFinalSelection(result) {
  return result && Array.isArray(result.finalSelectionIds) ? result.finalSelectionIds : [];
}

function formatDeleteResultMessage(result, fallbackDeletedIds = []) {
  const deletedIds = result && Array.isArray(result.deletedInstanceIds)
    ? result.deletedInstanceIds
    : [];
  const fallbackCount = Array.isArray(fallbackDeletedIds) ? fallbackDeletedIds.length : 0;
  const deletedCount = deletedIds.length || fallbackCount;
  const dependentCount = result && Array.isArray(result.dependentStagedIds)
    ? result.dependentStagedIds.length
    : 0;
  const repairedCount = result && Array.isArray(result.dependentRepairedIds)
    ? result.dependentRepairedIds.length
    : 0;

  let message = `Deleted ${caseCountText(deletedCount)}.`;
  if (repairedCount) {
    message += ` ${repairedCount} nearby ${caseCountText(repairedCount)} ${repairedCount === 1 ? 'was' : 'were'} re-settled inside the truck.`;
  }
  if (dependentCount) {
    message += ` ${dependentCount} dependent ${caseCountText(dependentCount)} ${dependentCount === 1 ? 'was' : 'were'} moved to staging because their support changed.`;
  }
  return message;
}

export function buildAppliedAutoPackCases(option, cloneCases = value => JSON.parse(JSON.stringify(value)), currentCases = option?.nextCases) {
  const isMaxCapacity = option && option.id === 'max-capacity';
  const movableIds = Array.isArray(option?.movableIds) ? new Set(option.movableIds) : null;
  const sourceCases = option && Array.isArray(option.nextCases) ? option.nextCases : [];
  if (!Array.isArray(currentCases) || sourceCases.length !== currentCases.length) return null;
  const proposed = cloneCases(sourceCases);
  const current = cloneCases(currentCases);
  const proposedById = new Map(proposed.map(inst => [inst?.id, inst]));
  if (proposedById.size !== proposed.length || current.some(inst => !inst?.id || !proposedById.has(inst.id)) ||
      new Set(current.map(inst => inst.id)).size !== current.length) return null;

  const rebased = current.map(inst => {
    const chosen = proposedById.get(inst.id);
    if (inst.caseId !== chosen.caseId || Boolean(inst.hidden) !== Boolean(chosen.hidden)) return null;
    if (movableIds && !movableIds.has(inst.id)) return inst;
    // Packed poses and packed-to-staged transitions belong to the candidate.
    // C5B's allocator preserves trustworthy authored staging and resolves only
    // eligible unsafe poses. Carry its atomic pose/cache through preview/Apply.
    // Older Results without allocator evidence retain source-staged ownership.
    const next = { ...inst, placement: chosen.placement };
    const resolvedStaging = chosen.placement === 'staged' && inst.placement === 'staged' &&
      !isMaxCapacity && option.stagingSourceSignatures && (
      ['position', 'rotation'].every(field => ['x', 'y', 'z'].every(axis =>
        inst.transform?.[field]?.[axis] === chosen.transform?.[field]?.[axis])) ||
      option.stagingSourceSignatures[inst.id] === buildAutoPackSourceSignature({ cases: [inst] })
    );
    if (chosen.placement === 'packed' || (chosen.placement === 'staged' &&
      (inst.placement !== 'staged' || resolvedStaging))) {
      if (!chosen.transform?.position || !chosen.transform?.rotation) return null;
      next.transform = {
        ...inst.transform,
        position: chosen.transform.position,
        rotation: chosen.transform.rotation,
      };
      if (Object.hasOwn(chosen, 'orientedDims')) next.orientedDims = chosen.orientedDims;
      else delete next.orientedDims;
    }
    if (isMaxCapacity && next.placement === 'packed') {
      next.packedProfile = 'max-capacity';
    } else {
      delete next.packedProfile;
    }
    return next;
  });
  return rebased.every(Boolean) ? rebased : null;
}

export function getAppliedAutoPackOption(pack, results, getCaseById) {
  if (!pack || !results || results.packId !== pack.id || !Array.isArray(results.options)) return null;
  if (buildAutoPackCaseRuleSignature(pack, getCaseById) !== results.caseRuleSignature) return null;
  const signature = buildAutoPackResultSignature(pack);
  const matches = results.options.filter(option => {
    if (Array.isArray(results.adoptedOptionIds) && !results.adoptedOptionIds.includes(option.id)) return false;
    if (option.id === 'max-capacity' || !option.sourceSignature) return option.signature === signature;
    return option.sourceSignature === buildAutoPackSourceSignature(pack) &&
      buildAutoPackCaseRuleSignature(pack, getCaseById, { exact: true }) === results.caseAuthoritySignature;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Strict signatures intentionally omit staged pose. The existing layout
    // signature distinguishes only an exact physical match; otherwise fail closed.
    const layout = buildAutoPackLayoutSignature(pack);
    const exact = matches.filter(option => option.layoutSignature === layout);
    if (exact.length === 1) return exact[0];
  }
  return null;
}

export function prepareNormalAutoPackResultApply(pack, results, option, getCaseById) {
  if (option?.id === 'max-capacity' || !results?.options.includes(option) ||
      !isAutoPackResultsFresh(pack, results, getCaseById)) return null;
  const cases = buildAppliedAutoPackCases(option, undefined, pack.cases);
  if (!cases || (option.sourceSignature &&
      buildAutoPackSourceSignature({ ...pack, cases }) !== option.sourceSignature)) return null;
  const definitions = [...new Set(cases.map(inst => inst.caseId))].map(getCaseById).filter(Boolean);
  const assessment = assessNormalAutoPackCandidate({ ...pack, cases }, definitions);
  return isNormalAutoPackCandidateAcceptable({ ...option, assessment }) ? { cases, assessment } : null;
}

export function describeAutoPackReviewReason(assessment) {
  if (assessment?.primary !== 'INCOMPLETE') return '';
  const unresolved = (assessment.hard || []).filter(finding => finding.outcome === 'UNRESOLVED');
  if (unresolved.some(finding => /^(source.case|source.instance|geometry.source|orientation\.)/.test(finding.property))) {
    return 'Some case information is missing.';
  }
  if (unresolved.some(finding => finding.property === 'source.target-space')) return 'Some truck information is missing.';
  if (assessment.measurements?.mass?.complete === false) return 'Weight information is missing.';
  return 'Some support information cannot be verified.';
}

// Display order only: Balanced (the first standard plan in solver order) leads,
// Max Capacity follows as the relaxed handling comparison, then the remaining
// standard plans in their solver order. Stored options retain portfolio order;
// Max remains distinct. Preference and Applied matching never read this order.
export function orderAutoPackResultOptions(options) {
  const list = Array.isArray(options) ? options : [];
  const standard = list.filter(option => !option || option.id !== 'max-capacity');
  return [
    ...standard.slice(0, 1),
    ...list.filter(option => option && option.id === 'max-capacity'),
    ...standard.slice(1),
  ];
}

// Initial presentation only: the display index a Results run first opens on,
// from the user's starting-view preference over the display-ordered options.
// 'applied' needs a uniquely resolved Applied option; 'recommended' follows the
// run's selectedId and never lands on Max Capacity. Anything unresolved falls
// back to the first option. Ranking, selectedId, Applied matching and the Pack
// are only read, never changed.
export function resolveAutoPackResultsStartIndex(options, results, appliedOption, startView) {
  const list = Array.isArray(options) ? options : [];
  let index = -1;
  if (startView === 'applied' && appliedOption) {
    index = list.indexOf(appliedOption);
  } else if (startView === 'recommended' && results) {
    index = list.findIndex(option => option && option.id === results.selectedId && option.id !== 'max-capacity');
  }
  return Math.max(0, index);
}

function withoutPackedProfile(inst) {
  const next = { ...inst };
  delete next.packedProfile;
  return next;
}

function buildNormalHandlingPack(pack, instanceIds) {
  const targetIds = new Set(instanceIds || []);
  return {
    ...pack,
    cases: (pack.cases || []).map(inst =>
      targetIds.has(inst.id) ? withoutPackedProfile(inst) : inst
    ),
  };
}

// Shortcut hint name for the Alt key: macOS labels the same key ⌥ Option.
// Exported for unit testing.
export function altKeyHintLabel() {
  const nav = typeof navigator === 'undefined' ? null : /** @type {any} */ (navigator);
  const platform = String((nav && ((nav.userAgentData && nav.userAgentData.platform) || nav.platform)) || '');
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌥ Option' : 'Alt';
}

/**
 * Resolve the one visual owner for a case without mutating THREE materials.
 * Selection intentionally outranks OOG to preserve the editor's existing
 * selection-first contract; collision remains the highest visible warning.
 */
export function resolveCaseVisualState({
  hidden = false,
  collision = false,
  selected = false,
  oog = false,
  dragged = false,
  hovered = false,
  accent = '#ff9f1c',
  baseEdgeColor = 0x333333,
  hiddenOpacity = 0.3,
} = {}) {
  const opacity = Math.min(1, Math.max(0, Number(hiddenOpacity) || 0));
  let owner = 'normal';
  if (hidden) owner = 'hidden';
  else if (collision) owner = 'collision';
  else if (selected) owner = 'selected';
  else if (oog) owner = 'oog';
  else if (dragged) owner = 'dragged';
  else if (hovered) owner = 'hovered';

  const emissiveByOwner = {
    collision: 0xff0000,
    selected: accent,
    oog: 0xcc3300,
    dragged: 0x111111,
    hovered: 0x333333,
  };

  return {
    owner,
    emissive: emissiveByOwner[owner] ?? 0x000000,
    edgeColor: owner === 'oog' ? 0xff0000 : baseEdgeColor,
    meshTransparent: hidden || dragged,
    meshOpacity: hidden ? opacity : (dragged ? 0.72 : 1),
    depthWrite: !hidden,
    edgeOpacity: hidden ? Math.max(0.25, opacity) : 0.95,
  };
}

// Vertical-move outcome message: base sentence plus what revalidation did to
// OTHER cases (re-settled / staged dependents), per the delete-path contract.
function formatVerticalMoveMessage(result, movedId, baseMessage) {
  let message = baseMessage;
  const otherIds = ids => (Array.isArray(ids) ? ids.filter(id => id !== movedId) : []);
  const resettled = new Set([
    ...otherIds(result && result.adjustedIds),
    ...otherIds(result && result.repairedIds),
  ]);
  if (resettled.size) {
    message += ` ${resettled.size} nearby ${caseCountText(resettled.size)} ${resettled.size === 1 ? 'was' : 'were'} re-settled.`;
  }
  const stagedCount = otherIds(result && result.stagedIds).length;
  if (stagedCount) {
    message += ` ${stagedCount} dependent ${caseCountText(stagedCount)} ${stagedCount === 1 ? 'was' : 'were'} moved to staging because their support changed.`;
  }
  return message;
}

export function validateAtomicManualGroupResult(proposedCases, validationResult, groupIds, tolerance = 1e-6) {
  const ids = Array.isArray(groupIds) ? [...new Set(groupIds.filter(Boolean))] : [];
  const validatedCases = validationResult && validationResult.pack && Array.isArray(validationResult.pack.cases)
    ? validationResult.pack.cases
    : null;
  if (ids.length < 2 || !Array.isArray(proposedCases) || !validatedCases) {
    return { ok: false, reason: 'validation-unavailable' };
  }

  const proposedById = new Map(proposedCases.filter(Boolean).map(inst => [inst.id, inst]));
  const validatedById = new Map(validatedCases.filter(Boolean).map(inst => [inst.id, inst]));
  const invalidIds = new Set([
    ...(Array.isArray(validationResult.invalidIds) ? validationResult.invalidIds : []),
    ...(Array.isArray(validationResult.failedIds) ? validationResult.failedIds : []),
  ]);
  let sharedVerticalCorrection = null;

  for (const id of ids) {
    const proposed = proposedById.get(id);
    const validated = validatedById.get(id);
    if (!proposed || !validated || invalidIds.has(id)) {
      return { ok: false, reason: 'selected-invalid', instanceId: id };
    }
    if (validated.placement !== proposed.placement) {
      return { ok: false, reason: 'selected-placement-changed', instanceId: id };
    }
    const requested = proposed.transform && proposed.transform.position;
    const settled = validated.transform && validated.transform.position;
    if (!requested || !settled || !['x', 'y', 'z'].every(axis =>
      Number.isFinite(Number(requested[axis])) && Number.isFinite(Number(settled[axis]))) ||
      Math.abs(Number(requested.x) - Number(settled.x)) > tolerance ||
      Math.abs(Number(requested.z) - Number(settled.z)) > tolerance) {
      return { ok: false, reason: 'selected-position-changed', instanceId: id };
    }
    const correction = Number(settled.y) - Number(requested.y);
    if (sharedVerticalCorrection !== null && Math.abs(correction - sharedVerticalCorrection) > tolerance) {
      return { ok: false, reason: 'selected-relative-position-changed', instanceId: id };
    }
    sharedVerticalCorrection = correction;
  }

  return { ok: true };
}

function pointInsideTruckFootprint(zones, position) {
  return (zones || []).some(zone =>
    position.x >= zone.min.x && position.x <= zone.max.x &&
    position.z >= zone.min.z && position.z <= zone.max.z
  );
}

function positionsShareManualXZ(a, b) {
  if (!a || !b) return false;
  const ax = Number(a.x);
  const az = Number(a.z);
  const bx = Number(b.x);
  const bz = Number(b.z);
  if (!Number.isFinite(ax) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(bz)) return false;
  return Math.abs(ax - bx) <= 0.05 && Math.abs(az - bz) <= 0.05;
}

function positionsShareManualY(a, b) {
  return a && b && Number.isFinite(Number(a.y)) && Number.isFinite(Number(b.y)) &&
    Math.abs(Number(a.y) - Number(b.y)) <= 0.05;
}

export function formatManualGroupMoveMessage(result, movedIds, baseMessage) {
  const movedSet = new Set(Array.isArray(movedIds) ? movedIds : []);
  const otherIds = ids => (Array.isArray(ids) ? ids.filter(id => !movedSet.has(id)) : []);
  const resettled = new Set([
    ...otherIds(result && result.adjustedIds),
    ...otherIds(result && result.repairedIds),
  ]);
  const stagedCount = new Set(otherIds(result && result.stagedIds)).size;

  let message = baseMessage;
  if (resettled.size) {
    message += ` ${resettled.size} nearby ${resettled.size === 1 ? 'case was' : 'cases were'} re-settled.`;
  }
  if (stagedCount) {
    message += ` ${stagedCount} dependent ${stagedCount === 1 ? 'case was' : 'cases were'} moved to staging because ${stagedCount === 1 ? 'its' : 'their'} support changed.`;
  }
  return message;
}

/**
 * Return the first normalized time (0..1) at which a moving AABB overlaps a
 * stationary AABB, or null when the swept segment stays clear. Face/edge
 * contact is allowed, matching the live point-collision tolerance.
 */
export function getSweptAabbCollisionTime(startAabb, endAabb, obstacleAabb, epsilon = 1e-6) {
  if (!startAabb || !endAabb || !obstacleAabb) return null;

  const axes = ['x', 'y', 'z'];
  const center = {};
  const delta = {};
  const half = {};
  for (const axis of axes) {
    const startMin = Number(startAabb.min && startAabb.min[axis]);
    const startMax = Number(startAabb.max && startAabb.max[axis]);
    const endMin = Number(endAabb.min && endAabb.min[axis]);
    const endMax = Number(endAabb.max && endAabb.max[axis]);
    const obstacleMin = Number(obstacleAabb.min && obstacleAabb.min[axis]);
    const obstacleMax = Number(obstacleAabb.max && obstacleAabb.max[axis]);
    if (![startMin, startMax, endMin, endMax, obstacleMin, obstacleMax].every(Number.isFinite)) {
      return null;
    }
    center[axis] = (startMin + startMax) / 2;
    delta[axis] = (endMin + endMax - startMin - startMax) / 2;
    half[axis] = Math.max(0, (startMax - startMin) / 2);
  }

  let entry = 0;
  let exit = 1;
  for (const axis of axes) {
    // Minkowski-expand the obstacle by the moving box half-extent, then
    // shrink by epsilon so exact touching does not count as penetration.
    const expandedMin = Number(obstacleAabb.min[axis]) - half[axis] + epsilon;
    const expandedMax = Number(obstacleAabb.max[axis]) + half[axis] - epsilon;
    if (expandedMin >= expandedMax) return null;

    if (Math.abs(delta[axis]) <= 1e-12) {
      if (center[axis] < expandedMin || center[axis] > expandedMax) return null;
      continue;
    }

    let axisEntry = (expandedMin - center[axis]) / delta[axis];
    let axisExit = (expandedMax - center[axis]) / delta[axis];
    if (axisEntry > axisExit) [axisEntry, axisExit] = [axisExit, axisEntry];
    entry = Math.max(entry, axisEntry);
    exit = Math.min(exit, axisExit);
    if (entry > exit) return null;
  }

  return exit >= 0 && entry <= 1 ? Math.max(0, entry) : null;
}

/**
 * Pure gravity simulation: find the settled center Y for a box at the given X,Z position.
 *
 * Rules:
 * - The floor surface (Y = floorY + halfWorld.y) is always valid support. floorY is
 *   normally 0 (main cargo floor), but is raised to the front-overhang deck height
 *   when the candidate's footprint sits over the overhang (see settleY()).
 * - A supporter is accepted only if its XZ overlap covers >= minSupportFraction of the
 *   candidate's footprint. This prevents tiny-corner contact from acting as support.
 * - The highest valid resting surface wins. No upper-bound filter — the caller's
 *   collision check handles cases where the result would penetrate something above.
 *
 * Exported for unit testing. The inner settleY() calls this with live instance state.
 *
 * @param {{ x: number, y: number, z: number }} halfWorld - half-extents in world units
 * @param {number} cx - candidate center X in world units
 * @param {number} cz - candidate center Z in world units
 * @param {Array<{ min: {x,y,z}, max: {x,y,z} }>} otherAabbs - world-space AABBs of other boxes
 * @param {number} minSupportFraction - required XZ overlap fraction (pass MIN_SUPPORT_FRACTION)
 * @param {number} [floorY] - world Y of the floor surface beneath this footprint (default 0)
 * @returns {number} settled center Y in world units (always >= floorY + halfWorld.y)
 */
export function computeSettleY(halfWorld, cx, cz, otherAabbs, minSupportFraction, floorY = 0) {
  const halfX = halfWorld.x;
  const halfY = halfWorld.y;
  const halfZ = halfWorld.z;

  let bestY = floorY + halfY; // floor fallback: center Y = floor surface + half-height

  for (const otherAabb of otherAabbs || []) {
    if (!otherAabb) continue;
    const potentialY = otherAabb.max.y + halfY;
    if (potentialY <= bestY) continue; // not an improvement

    // Compute what fraction of the candidate's footprint is over this supporter's top face.
    const overlapL = Math.max(0, Math.min(cx + halfX, otherAabb.max.x) - Math.max(cx - halfX, otherAabb.min.x));
    const overlapW = Math.max(0, Math.min(cz + halfZ, otherAabb.max.z) - Math.max(cz - halfZ, otherAabb.min.z));
    const overlapArea = overlapL * overlapW;
    const footprintArea = (halfX * 2) * (halfZ * 2);
    const fraction = footprintArea > 1e-9 ? overlapArea / footprintArea : 0;

    if (fraction >= minSupportFraction) {
      bestY = potentialY;
    }
  }

  return bestY;
}

/**
 * Constant on-screen gizmo sizing: world scale grows linearly with camera
 * distance, clamped so the handle stays usable at both OrbitControls zoom
 * extremes (minDistance 6, maxDistance 220). Exported for unit testing.
 */
export function computeGizmoScale(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  return Math.min(3.5, Math.max(0.35, d * 0.045));
}

/**
 * PREVIEW-ONLY terrain height for surface-following drag ("ghost over hills").
 * Returns the visual resting height of a dragged case footprint over the
 * highest sufficiently-overlapping preview surface (truck floor, box tops,
 * staged/outside box tops, wheel-well tops, front deck, staging floor).
 *
 * This is NOT a placement validator: it deliberately ignores stacking,
 * weight, noStackOnTop, retention, containment, and every other hard rule so
 * the ghost can ride over any surface while dragging. Final commits must
 * still go through PackLibrary validation (findManualVerticalPlacement
 * resolve + updateCasesWithManualRevalidation).
 *
 * Pure and THREE-free: plain numbers/objects in, plain object out; inputs are
 * never mutated. Exported for unit testing and later drag integration.
 *
 * Missing or malformed inputs are reported as `bad-input` at runtime, so every
 * property is optional at the type level.
 *
 * @param {object} [input]
 * @param {{ x: number, y: number, z: number }} [input.halfWorld] - dragged case half-extents
 * @param {number} [input.centerX] - dragged case center X
 * @param {number} [input.centerZ] - dragged case center Z
 * @param {Array<{ id?: string, kind: string, min: {x: number, z: number}, max: {x: number, z: number}, topY: number }>} [input.surfaces]
 * @param {number} [input.minOverlapFraction] - footprint overlap needed to ride a surface
 * @param {number} [input.clearance] - extra visual lift above the surface
 * @returns {{ ok: boolean, centerY?: number, bottomY?: number, surface?: object,
 *   overlapFraction?: number, reason?: 'no-surface' | 'bad-input' }}
 */
export function computeSurfaceFollowingPreviewY({
  halfWorld,
  centerX,
  centerZ,
  surfaces,
  minOverlapFraction = 0.08,
  clearance = 0,
} = {}) {
  const halfX = halfWorld ? Number(halfWorld.x) : NaN;
  const halfY = halfWorld ? Number(halfWorld.y) : NaN;
  const halfZ = halfWorld ? Number(halfWorld.z) : NaN;
  const cx = Number(centerX);
  const cz = Number(centerZ);
  if (!Number.isFinite(halfX) || halfX <= 0 ||
      !Number.isFinite(halfY) || halfY <= 0 ||
      !Number.isFinite(halfZ) || halfZ <= 0 ||
      !Number.isFinite(cx) || !Number.isFinite(cz) ||
      !Array.isArray(surfaces)) {
    return { ok: false, reason: 'bad-input' };
  }
  const threshold = Number.isFinite(Number(minOverlapFraction)) ? Number(minOverlapFraction) : 0.08;
  const lift = Number.isFinite(Number(clearance)) ? Number(clearance) : 0;
  const footprintArea = (halfX * 2) * (halfZ * 2);
  const minX = cx - halfX;
  const maxX = cx + halfX;
  const minZ = cz - halfZ;
  const maxZ = cz + halfZ;

  let best = null;
  for (const surface of surfaces) {
    if (!surface || !surface.min || !surface.max) continue;
    const topY = Number(surface.topY);
    if (!Number.isFinite(topY)) continue;
    const overlapX = Math.min(maxX, Number(surface.max.x)) - Math.max(minX, Number(surface.min.x));
    const overlapZ = Math.min(maxZ, Number(surface.max.z)) - Math.max(minZ, Number(surface.min.z));
    if (!(overlapX > 0) || !(overlapZ > 0)) continue;
    const overlapFraction = (overlapX * overlapZ) / footprintArea;
    if (overlapFraction < threshold) continue;
    if (!best || topY > best.topY ||
        (topY === best.topY && overlapFraction > best.overlapFraction)) {
      best = { topY, overlapFraction, surface };
    }
  }
  if (!best) return { ok: false, reason: 'no-surface' };
  return {
    ok: true,
    centerY: best.topY + halfY + lift,
    bottomY: best.topY + lift,
    surface: best.surface,
    overlapFraction: best.overlapFraction,
  };
}

function sweptFootprintCrossesSurface(
  fromX,
  fromZ,
  toX,
  toZ,
  halfX,
  halfZ,
  surface,
  epsilon = 1e-6
) {
  if (!surface || !surface.min || !surface.max) return false;
  const axes = [
    { from: fromX, to: toX, half: halfX, min: Number(surface.min.x), max: Number(surface.max.x) },
    { from: fromZ, to: toZ, half: halfZ, min: Number(surface.min.z), max: Number(surface.max.z) },
  ];
  if (axes.some(axis => ![axis.from, axis.to, axis.half, axis.min, axis.max].every(Number.isFinite))) {
    return false;
  }

  let entry = 0;
  let exit = 1;
  for (const axis of axes) {
    const expandedMin = axis.min - axis.half + epsilon;
    const expandedMax = axis.max + axis.half - epsilon;
    if (expandedMin >= expandedMax) return false;
    const delta = axis.to - axis.from;
    if (Math.abs(delta) <= 1e-12) {
      if (axis.from < expandedMin || axis.from > expandedMax) return false;
      continue;
    }
    let axisEntry = (expandedMin - axis.from) / delta;
    let axisExit = (expandedMax - axis.from) / delta;
    if (axisEntry > axisExit) [axisEntry, axisExit] = [axisExit, axisEntry];
    entry = Math.max(entry, axisEntry);
    exit = Math.min(exit, axisExit);
    if (entry > exit) return false;
  }
  return exit >= 0 && entry <= 1;
}

/**
 * Compute one shared Y delta for a rigid multi-selection over preview terrain.
 * Every member samples the same surface set at its translated X/Z footprint;
 * the member needing the greatest lift controls the whole group.
 *
 * @param {object} [input]
 * @param {Array<{ id?: string, start: {x: number, y: number, z: number},
 *   halfWorld: {x: number, y: number, z: number} }>} [input.members]
 * @param {Array<{ id?: string, kind: string, min: {x: number, z: number},
 *   max: {x: number, z: number}, topY: number }>} [input.surfaces]
 * @param {number} [input.deltaX]
 * @param {number} [input.deltaZ]
 * @param {number} [input.fromDeltaX]
 * @param {number} [input.fromDeltaZ]
 * @param {number} [input.minOverlapFraction]
 * @returns {{ ok: boolean, deltaY?: number, previews?: Array<object>,
 *   reason?: 'bad-input' }}
 */
export function computeRigidGroupSurfaceFollowingDelta({
  members,
  surfaces,
  deltaX = 0,
  deltaZ = 0,
  fromDeltaX = 0,
  fromDeltaZ = 0,
  minOverlapFraction = 0.08,
} = {}) {
  const dx = Number(deltaX);
  const dz = Number(deltaZ);
  const fromDx = Number(fromDeltaX);
  const fromDz = Number(fromDeltaZ);
  if (!Array.isArray(members) || members.length < 2 || !Array.isArray(surfaces) ||
      !Number.isFinite(dx) || !Number.isFinite(dz) ||
      !Number.isFinite(fromDx) || !Number.isFinite(fromDz)) {
    return { ok: false, reason: 'bad-input' };
  }

  let sharedDeltaY = null;
  let floorClampDeltaY = -Infinity;
  const previews = [];
  for (const member of members) {
    const start = member && member.start;
    const halfWorld = member && member.halfWorld;
    const startX = Number(start && start.x);
    const startY = Number(start && start.y);
    const startZ = Number(start && start.z);
    const halfX = Number(halfWorld && halfWorld.x);
    const halfY = Number(halfWorld && halfWorld.y);
    const halfZ = Number(halfWorld && halfWorld.z);
    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(startZ) ||
        !Number.isFinite(halfX) || halfX <= 0 ||
        !Number.isFinite(halfY) || halfY <= 0 ||
        !Number.isFinite(halfZ) || halfZ <= 0) {
      return { ok: false, reason: 'bad-input' };
    }

    floorClampDeltaY = Math.max(floorClampDeltaY, halfY - startY);
    const preview = computeSurfaceFollowingPreviewY({
      halfWorld,
      centerX: startX + dx,
      centerZ: startZ + dz,
      surfaces,
      minOverlapFraction,
    });
    previews.push({ id: member.id, preview });
    if (preview.ok && Number.isFinite(preview.centerY)) {
      const requiredDeltaY = preview.centerY - startY;
      sharedDeltaY = sharedDeltaY === null
        ? requiredDeltaY
        : Math.max(sharedDeltaY, requiredDeltaY);
    }

    // A fast pointer event may start and end clear while crossing cargo in
    // between. Keep the whole group high enough to clear every crossed terrain
    // surface for this event; the endpoint preview lowers it again once the
    // following segment is fully clear.
    for (const surface of surfaces) {
      const topY = Number(surface && surface.topY);
      if (!Number.isFinite(topY)) continue;
      if (!sweptFootprintCrossesSurface(
        startX + fromDx,
        startZ + fromDz,
        startX + dx,
        startZ + dz,
        halfX,
        halfZ,
        surface
      )) continue;
      sharedDeltaY = Math.max(sharedDeltaY === null ? -Infinity : sharedDeltaY, topY + halfY - startY);
    }
  }

  return {
    ok: true,
    deltaY: Math.max(sharedDeltaY === null ? 0 : sharedDeltaY, floorClampDeltaY),
    previews,
  };
}

const SURFACE_PREVIEW_DRAG_MIN_OVERLAP = 0.02;

function getUnpackCategoryKey(inst, getCaseById) {
  // Group by caseId so all instances of the same case type land in one band,
  // giving each band an exact uniform cell size with no mixed-dimension waste.
  return String(inst && inst.caseId ? inst.caseId : 'unknown').trim() || 'unknown';
}

export function groupInstancesForUnpackStaging(instances, getCaseById) {
  const groups = [];
  const groupByKey = new Map();
  for (const inst of Array.isArray(instances) ? instances : []) {
    const categoryKey = getUnpackCategoryKey(inst, getCaseById);
    let group = groupByKey.get(categoryKey);
    if (!group) {
      group = { categoryKey, instances: [] };
      groupByKey.set(categoryKey, group);
      groups.push(group);
    }
    group.instances.push(inst);
  }
  return groups;
}

const ORGANIZED_UNPACK_ROTATION = Object.freeze({ x: 0, y: 0, z: 0 });
// Organized Unpack presentation spacing, in inches of edge-to-edge clearance:
// between neighbours of one Case type, and between the occupied bounds of
// consecutive Case-type groups. Unpack-only — the canonical staging layout
// supplies the strip origin and length, and every other staging path keeps
// the canonical gap.
export const ORGANIZED_UNPACK_ITEM_GAP = 4;
export const ORGANIZED_UNPACK_GROUP_GAP = 8;

export function buildOrganizedUnpackStagingCases({
  instances,
  stagingLayout,
  getCaseById,
  getCanonicalInstanceEffectiveDims,
}) {
  const sourceInstances = Array.isArray(instances) ? instances : [];
  const layout = stagingLayout && typeof stagingLayout === 'object' ? stagingLayout : {};
  const gap = ORGANIZED_UNPACK_ITEM_GAP;
  const truckLength = Number(layout.truckL);
  const originX = Number(layout.originX);
  const originZ = Number(layout.originZ);
  const canBuildLayout = Number(layout.gap) > 0 && truckLength > 0 &&
    Number.isFinite(originX) && Number.isFinite(originZ) &&
    typeof getCaseById === 'function' &&
    typeof getCanonicalInstanceEffectiveDims === 'function';
  if (!canBuildLayout) {
    return {
      cases: sourceInstances.map(withoutPackedProfile),
      movedCount: 0,
    };
  }

  const itemById = new Map();
  for (const inst of sourceInstances) {
    const caseData = inst ? getCaseById(inst.caseId) : null;
    if (!inst || !caseData) continue;
    const stagingSource = {
      ...inst,
      transform: {
        ...(inst.transform || {}),
        rotation: { ...ORGANIZED_UNPACK_ROTATION },
      },
    };
    const canonical = getCanonicalInstanceEffectiveDims(stagingSource, caseData);
    if (!canonical || !canonical.ok) continue;
    itemById.set(inst.id, {
      inst,
      caseData,
      dims: { ...canonical.dims },
      rotation: { ...canonical.rotation },
    });
  }

  const stagingGroups = groupInstancesForUnpackStaging(sourceInstances, getCaseById);
  stagingGroups.sort((a, b) => {
    const footprint = group => {
      const item = group.instances.map(inst => itemById.get(inst.id)).find(Boolean);
      return item ? item.dims.length * item.dims.width : 0;
    };
    return footprint(b) - footprint(a);
  });

  const stagedById = new Map();
  let categoryOriginZ = originZ;
  let movedCount = 0;
  for (const group of stagingGroups) {
    const payload = group.instances
      .map(inst => itemById.get(inst.id))
      .filter(Boolean)
      .sort((a, b) =>
        String((a.caseData && a.caseData.name) || a.inst.caseId)
          .localeCompare(String((b.caseData && b.caseData.name) || b.inst.caseId)) ||
        (b.dims.length * b.dims.width - a.dims.length * a.dims.width) ||
        String(a.inst.id).localeCompare(String(b.inst.id))
      );
    if (!payload.length) continue;

    const cellLength = Math.max(...payload.map(item => item.dims.length)) + gap;
    const cellWidth = Math.max(...payload.map(item => item.dims.width)) + gap;
    const cols = Math.max(1, Math.floor((truckLength + gap) / Math.max(1, cellLength)));
    let groupMaxZ = categoryOriginZ;
    for (let index = 0; index < payload.length; index += 1) {
      const item = payload[index];
      const col = index % cols;
      const row = Math.floor(index / cols);
      const stagedPosition = {
        x: originX + item.dims.length / 2 + col * cellLength,
        y: item.dims.height / 2,
        z: categoryOriginZ + item.dims.width / 2 + row * cellWidth,
      };
      groupMaxZ = Math.max(groupMaxZ, stagedPosition.z + item.dims.width / 2);
      movedCount += 1;
      stagedById.set(item.inst.id, {
        ...item.inst,
        orientedDims: { ...item.dims },
        transform: {
          ...(item.inst.transform || {}),
          position: stagedPosition,
          rotation: { ...item.rotation },
        },
        placement: 'staged',
      });
    }
    // The next group starts a fixed clearance past this group's occupied edge.
    categoryOriginZ = groupMaxZ + ORGANIZED_UNPACK_GROUP_GAP;
  }

  return {
    cases: sourceInstances.map(inst => withoutPackedProfile(stagedById.get(inst.id) || inst)),
    movedCount,
  };
}

export function createCaseScene({
  SceneManager,
  CaseLibrary,
  CategoryService,
  PackLibrary,
  StateStore,
  TrailerGeometry,
  Utils,
  PreferencesManager,
}) {
  const CaseScene = (() => {
    const instances = new Map(); // instanceId -> THREE.Group
    const edgesCache = new Map(); // signature -> { geometry: THREE.EdgesGeometry, count: number }
    const textureCache = new Map(); // signature -> { textures: THREE.CanvasTexture[], count: number }
    let hoveredId = null;
    let draggedId = null;
    let selectedIds = new Set();
    const collisionIds = new Set();
    const oogSet = new Set();
    let pendingPoseWatcher = null;


    function generateCaseTexture(caseData, faceIndex, w, h) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const isPallet = caseData.isPallet === true;
      const catColor = CategoryService.meta(caseData.category).color;
      const baseColor = isPallet ? '#A0522D' : (catColor || caseData.color || '#8B4513');
      ctx.fillStyle = baseColor;
      ctx.fillRect(0, 0, w, h);

      if (isPallet) {
        // Draw wood slat pattern for pallets
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = Math.max(1, w * 0.005);
        ctx.beginPath();
        const slatSpacing = h / 6;
        for (let y = slatSpacing; y < h; y += slatSpacing) {
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(2, w * 0.01);
      ctx.strokeRect(2, 2, w - 4, h - 4);
      if (faceIndex === 4 || faceIndex === 5) {
        const faceDims = caseData.dimensions || {};
        if ((faceDims.length || 0) < 3 || (faceDims.height || 0) < 3) {
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          return tex;
        }
        ctx.fillStyle = '#000000';
        ctx.font = `bold ${Math.floor(h * 0.12)}px Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const name = caseData.name || (isPallet ? 'Pallet' : 'Case');
        ctx.fillText(name.substring(0, 16), w / 2, h * 0.4);
        ctx.font = `${Math.floor(h * 0.08)}px Arial, sans-serif`;
        ctx.fillText(formatWeight(caseData.weight, 'lb'), w / 2, h * 0.6);
        if (caseData.orientationLock === 'upright' && !isPallet) {
          ctx.font = `${Math.floor(h * 0.1)}px Arial`;
          ctx.fillText('⇧⇧', w / 2, h * 0.8);
        }
        if (isPallet && caseData.maxPalletWeight > 0) {
          ctx.font = `${Math.floor(h * 0.06)}px Arial, sans-serif`;
          ctx.fillText(`Warning limit: ${caseData.maxPalletWeight} lb`, w / 2, h * 0.8);
        }
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    function acquireTextures(signature, caseData, dims) {
      const cached = textureCache.get(signature);
      if (cached) { cached.count += 1; return cached.textures; }
      const lPx = Math.min(512, Math.max(64, dims.length * 4));
      const wPx = Math.min(512, Math.max(64, dims.width * 4));
      const hPx = Math.min(512, Math.max(64, dims.height * 4));
      const textures = [
        generateCaseTexture(caseData, 0, hPx, wPx),
        generateCaseTexture(caseData, 1, hPx, wPx),
        generateCaseTexture(caseData, 2, lPx, wPx),
        generateCaseTexture(caseData, 3, lPx, wPx),
        generateCaseTexture(caseData, 4, lPx, hPx),
        generateCaseTexture(caseData, 5, lPx, hPx),
      ];
      textureCache.set(signature, { textures, count: 1 });
      return textures;
    }

    function releaseTextures(signature) {
      const cached = textureCache.get(signature);
      if (!cached) return;
      cached.count -= 1;
      if (cached.count <= 0) {
        cached.textures.forEach(t => t.dispose());
        textureCache.delete(signature);
      }
    }

    let syncedPack = null;
    let syncedTransientPreview = false;
    // Counts the syncs that changed what stands in the scene (cargo added, removed, resized, moved, rotated or hidden), so a
    // reader that measured the layout earlier (the annotation overlay's occlusion) knows when to measure it again.
    let geometryRevision = 0;

    function clear() {
      syncedPack = null;
      const scene = SceneManager.getScene();
      if (!scene) return;
      if (instances.size) geometryRevision += 1;
      instances.forEach(group => disposeGroup(scene, group));
      instances.clear();
      edgesCache.forEach(entry => entry.geometry.dispose());
      edgesCache.clear();
      hoveredId = null;
      draggedId = null;
      selectedIds = new Set();
      collisionIds.clear();
      oogSet.clear();
    }

    // transientPreview marks a presentation-only layout (a browsed AutoPack
    // Results option) that is not the committed Pack. Every ordinary sync clears it.
    function sync(pack, { transientPreview = false } = {}) {
      syncedPack = null;
      syncedTransientPreview = false;
      const scene = SceneManager.getScene();
      if (!scene) return;
      if (!pack) {
        detachGizmo();
        clear();
        return;
      }

      // A pack sync reflects committed state. Preview collision ownership must
      // never leak across a commit, repair, revert, or selection-only render.
      collisionIds.clear();

      const keep = new Set();
      let geometryChanged = false;
      (pack.cases || []).forEach(inst => {
        const caseData = CaseLibrary.getById(inst.caseId);
        if (!caseData) return;
        keep.add(inst.id);

        const signature = buildSignature(inst, caseData);
        const existing = instances.get(inst.id);
        if (!existing || existing.userData.signature !== signature) {
          if (existing) disposeGroup(scene, existing);
          const group = createInstanceGroup(inst, caseData);
          instances.set(inst.id, group);
          scene.add(group);
          geometryChanged = true;
        }

        const group = instances.get(inst.id);
        const { x: px, y: py, z: pz } = group.position;
        const { x: rx, y: ry, z: rz } = group.rotation;
        const wasHidden = group.userData.hidden === true;
        applyTransform(group, inst);
        applyHidden(group, inst.hidden);
        if (px !== group.position.x || py !== group.position.y || pz !== group.position.z ||
            rx !== group.rotation.x || ry !== group.rotation.y || rz !== group.rotation.z ||
            wasHidden !== (group.userData.hidden === true)) geometryChanged = true;
      });

      // Remove old
      Array.from(instances.keys()).forEach(id => {
        if (keep.has(id)) return;
        disposeGroup(scene, instances.get(id));
        instances.delete(id);
        geometryChanged = true;
      });

      recomputeVisualStates();
      refreshGizmo();
      if (pendingPoseWatcher) pendingPoseWatcher();
      syncedPack = pack;
      syncedTransientPreview = Boolean(transientPreview);
      if (geometryChanged) geometryRevision += 1;
    }

    function buildSignature(inst, caseData) {
      const d = caseData.dimensions || { length: 0, width: 0, height: 0 };
      const catColor = CategoryService.meta(caseData.category).color;
      const color = String(catColor || caseData.color || '#ff9f1c');
      const isPallet = caseData.isPallet === true;
      const textureColor = String(isPallet ? '#A0522D' : (catColor || caseData.color || '#8B4513'));
      const rawShape = String(caseData.shape || 'box').toLowerCase();
      const shape = rawShape === 'cylinder' || rawShape === 'drum' ? 'cylinder' : 'box';
      const name = caseData.name || (isPallet ? 'Pallet' : 'Case');
      const labelName = name.substring(0, 16);
      const weightLabel = formatWeight(caseData.weight, 'lb');
      const showHandlingArrows = caseData.orientationLock === 'upright' && !isPallet;
      const palletWarning = isPallet && caseData.maxPalletWeight > 0
        ? `Warning limit: ${caseData.maxPalletWeight} lb`
        : '';
      return JSON.stringify([
        caseData.id,
        d.length,
        d.width,
        d.height,
        color,
        textureColor,
        shape,
        isPallet,
        labelName,
        weightLabel,
        showHandlingArrows,
        palletWarning,
      ]);
    }

    // Reuse the mesh/label signature so preview freshness follows production
    // appearance. Camera, selection, hover and gizmos are deliberately excluded.
    function getVisualSignature(pack) {
      const truck = pack.truck || {};
      const cfg = truck.shapeConfig || {};
      const mode = truck.shapeMode || 'rect';
      const configKeys = mode === 'wheelWells'
        ? ['wellHeight', 'wellWidth', 'wellLength', 'wellOffsetFromRear']
        : mode === 'frontBonus' ? ['bonusLength', 'bonusHeight'] : [];
      let hasHiddenCargo = false;
      const cargo = (pack.cases || []).flatMap(inst => {
        const data = CaseLibrary.getById(inst.caseId);
        if (!data) return [];
        hasHiddenCargo ||= Boolean(inst.hidden);
        const pos = inst.transform?.position || {};
        const rot = inst.transform?.rotation || {};
        const dims = getActualPoseDimensions(data, inst).value;
        return [[inst.id, inst.caseId, buildSignature(inst, data),
          [Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0],
          [Number(rot.x) || 0, Number(rot.y) || 0, Number(rot.z) || 0],
          [dims?.length, dims?.width, dims?.height], Boolean(inst.hidden), inst.placement === 'staged']];
      }).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
      // Scale is not applied by applyTransform; it is not rendered geometry.
      return JSON.stringify(['preview-v1', truck.length, truck.width, truck.height,
        mode, configKeys.map(key => [key, cfg[key]]), cargo,
        hasHiddenCargo ? Utils.clamp(Number(PreferencesManager.get().hiddenCaseOpacity) || 0.3, 0, 1) : null]);
    }

    function rebindPreviewPack(previous, next) {
      if (syncedPack !== previous || previous.cases !== next.cases || previous.truck !== next.truck) return false;
      syncedPack = next;
      return true;
    }

    function acquireEdgeGeometry(signature, boxGeometry) {
      const cached = edgesCache.get(signature);
      if (cached) {
        cached.count += 1;
        return cached.geometry;
      }
      const geometry = new THREE.EdgesGeometry(boxGeometry);
      geometry.userData.edgeCacheKey = signature;
      edgesCache.set(signature, { geometry, count: 1 });
      return geometry;
    }

    function releaseEdgeGeometry(signature) {
      const cached = edgesCache.get(signature);
      if (!cached) return;
      cached.count -= 1;
      if (cached.count <= 0) {
        cached.geometry.dispose();
        edgesCache.delete(signature);
      }
    }

    function createInstanceGroup(inst, caseData) {
      const group = new THREE.Group();
      group.userData.instanceId = inst.id;
      group.userData.caseId = inst.caseId;
      const signature = buildSignature(inst, caseData);
      group.userData.signature = signature;

      const dims = caseData.dimensions || { length: 1, width: 1, height: 1 };
      const lengthW = SceneManager.toWorld(dims.length);
      const widthW = SceneManager.toWorld(dims.width);
      const heightW = SceneManager.toWorld(dims.height);
      group.userData.halfWorld = { x: lengthW / 2, y: heightW / 2, z: widthW / 2 };
      group.userData.baseHalfWorld = { x: lengthW / 2, y: heightW / 2, z: widthW / 2 };

      const catColor = CategoryService.meta(caseData.category).color;
      const baseColor = String(catColor || caseData.color || '#ff9f1c');
      group.userData.baseColor = baseColor;

      const geo = createCaseGeometry(caseData, SceneManager.toWorld);
      const textures = acquireTextures(signature, caseData, dims);
      const materials = textures.map(tex => new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.88,
        metalness: 0.01,
        emissive: new THREE.Color(0x000000),
        envMapIntensity: 0.3,
        bumpScale: 0.02,
      }));
      const mesh = new THREE.Mesh(geo, materials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.instanceId = inst.id;
      group.userData.mesh = mesh;
      group.add(mesh);

      const edges = acquireEdgeGeometry(signature, geo);
      const edgeColor = new THREE.Color(baseColor);
      edgeColor.multiplyScalar(0.55);
      const lineMat = new THREE.LineBasicMaterial({
        color: edgeColor,
        transparent: true,
        opacity: 0.85,
      });
      const lines = new THREE.LineSegments(edges, lineMat);
      lines.userData.edgeKey = signature;
      group.userData.lines = lines;
      group.userData.edgeColorOriginal = edgeColor.getHex();
      group.add(lines);

      return group;
    }

    function disposeGroup(scene, group) {
      if (!group) return;
      if (group.userData && group.userData.signature) {
        releaseEdgeGeometry(group.userData.signature);
        releaseTextures(group.userData.signature);
      }
      scene.remove(group);
      group.traverse(obj => {
        if (obj.geometry) {
          const cachedKey = obj.geometry.userData && obj.geometry.userData.edgeCacheKey;
          if (!cachedKey) obj.geometry.dispose();
        }
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(m => {
            if (!m) return;
            if (m.dispose) m.dispose();
          });
        }
      });
    }

    function applyTransform(group, inst) {
      if (!group || !inst || !inst.transform) return;
      const pos = inst.transform.position || { x: 0, y: 0, z: 0 };
      const rot = inst.transform.rotation || { x: 0, y: 0, z: 0 };
      const worldPos = SceneManager.vecInchesToWorld(pos);

      // Actual pose alone determines physical extents, including saved poses
      // currently forbidden by Case permission. Planning targets are unrelated.
      const dims = getActualPoseDimensions(CaseLibrary.getById(inst.caseId), inst).value;
      if (dims) {
        group.userData.halfWorld = {
          x: SceneManager.toWorld(dims.length) / 2,
          y: SceneManager.toWorld(dims.height) / 2,
          z: SceneManager.toWorld(dims.width) / 2,
        };
      } else if (group.userData.baseHalfWorld) {
        group.userData.halfWorld = { ...group.userData.baseHalfWorld };
      }

      const halfY = group.userData.halfWorld ? group.userData.halfWorld.y : 0;
      worldPos.y = Math.max(halfY || 0.01, worldPos.y);
      group.position.copy(worldPos);
      group.rotation.set(Number(rot.x) || 0, Number(rot.y) || 0, Number(rot.z) || 0);
    }

    function applyHidden(group, hidden) {
      if (!group || !group.userData.mesh) return;
      group.userData.hidden = Boolean(hidden);
    }

    function applyVisualState(group) {
      if (!group || !group.userData || !group.userData.mesh) return;
      const prefs = PreferencesManager.get();
      const mesh = group.userData.mesh;
      const lines = group.userData.lines;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const hiddenOpacity = Utils.clamp(Number(prefs.hiddenCaseOpacity) || 0.3, 0, 1);
      const id = group.userData.instanceId;
      const state = resolveCaseVisualState({
        hidden: group.userData.hidden === true,
        collision: collisionIds.has(id),
        selected: selectedIds.has(id),
        oog: oogSet.has(id),
        dragged: id === draggedId,
        hovered: id === hoveredId,
        accent: Utils.getCssVar('--accent-primary') || '#ff9f1c',
        baseEdgeColor: Number.isFinite(group.userData.edgeColorOriginal)
          ? group.userData.edgeColorOriginal
          : 0x333333,
        hiddenOpacity,
      });

      mats.forEach(m => {
        if (!m) return;
        if (m.transparent !== state.meshTransparent) {
          m.transparent = state.meshTransparent;
          m.needsUpdate = true;
        }
        m.opacity = state.meshOpacity;
        m.depthWrite = state.depthWrite;
        if (m.emissive) {
          if (typeof state.emissive === 'string' && typeof m.emissive.set === 'function') {
            m.emissive.set(state.emissive);
          } else if (typeof m.emissive.setHex === 'function') {
            m.emissive.setHex(state.emissive);
          }
        }
      });
      if (lines && lines.material) {
        lines.material.transparent = true;
        lines.material.opacity = state.edgeOpacity;
        if (lines.material.color && typeof lines.material.color.setHex === 'function') {
          lines.material.color.setHex(state.edgeColor);
        }
      }
    }

    function recomputeVisualStates() {
      instances.forEach(group => applyVisualState(group));
    }

    function applySelection(ids) {
      selectedIds = new Set(ids || []);
      recomputeVisualStates();
    }

    function applyHover(instanceId) {
      hoveredId = instanceId || null;
      recomputeVisualStates();
    }

    function applyDragging(instanceId) {
      draggedId = instanceId || null;
      recomputeVisualStates();
    }

    function setCollision(instanceId, isCollision) {
      const group = instances.get(instanceId);
      if (!group || !group.userData.mesh) return;
      if (isCollision) collisionIds.add(instanceId);
      else collisionIds.delete(instanceId);
      applyVisualState(group);
    }

    function setHover(instanceId) {
      applyHover(instanceId);
    }

    function setSelected(instanceIds) {
      applySelection(instanceIds);
      refreshGizmo();
    }

    function setDragging(instanceId) {
      applyDragging(instanceId);
    }

    function getObject(instanceId) {
      return instances.get(instanceId) || null;
    }

    function getRaycastMeshes() {
      const meshes = [];
      instances.forEach(group => {
        if (group.userData.mesh) meshes.push(group.userData.mesh);
      });
      return meshes;
    }

    // ── V3A vertical placement gizmo ─────────────────────────────────────
    // A visible Y handle for the single selected packed case, built from
    // THREE primitives only (the boot loader exposes THREE + OrbitControls;
    // TransformControls is deliberately not used). The handle renders on top
    // of cargo and keeps a constant on-screen size via computeGizmoScale().
    let gizmoGroup = null;
    let gizmoTargetId = null;
    let gizmoTargetMode = null;
    let gizmoHitMeshes = [];
    let gizmoMaterials = null;
    // Per-axis references so staged mode can hide the Y control and drop its
    // grab proxy without disturbing X/Z (see refreshGizmo, getGizmoHandleMeshes).
    let gizmoAxisHandles = {}; // axis -> visible arrow THREE.Group
    let gizmoAxisHitMeshes = {}; // axis -> invisible grab proxy Mesh
    let gizmoControlsHooked = false;
    // Soft idle opacity keeps the handle reading as a refined editor control; the
    // active axis lifts to full opacity in setGizmoActive.
    const GIZMO_IDLE_OPACITY = 0.8;

    // Axis colors follow the app's existing axis language (Turn/Tip/Roll button
    // tones): Y = --success, X = --error, Z = --info; active = --accent-primary.
    function gizmoColor(axis, active) {
      if (active) {
        return new THREE.Color(String(Utils.getCssVar('--accent-primary') || '#ff9f1c').trim() || '#ff9f1c');
      }
      const token = axis === 'x'
        ? Utils.getCssVar('--error')
        : axis === 'z'
          ? Utils.getCssVar('--info')
          : Utils.getCssVar('--success');
      return new THREE.Color(String(token || '#22c55e').trim() || '#22c55e');
    }

    function createGizmo() {
      const group = new THREE.Group();
      group.visible = false;
      group.renderOrder = 999;
      gizmoMaterials = {};
      gizmoHitMeshes = [];
      gizmoAxisHandles = {};
      gizmoAxisHitMeshes = {};
      ['x', 'y', 'z'].forEach(axis => {
        gizmoMaterials[axis] = new THREE.MeshBasicMaterial({
          color: gizmoColor(axis, false),
          transparent: true,
          opacity: GIZMO_IDLE_OPACITY,
          depthTest: false,
          depthWrite: false,
        });
        const handle = buildGizmoAxisHandle(axis, gizmoMaterials[axis]);
        gizmoAxisHandles[axis] = handle;
        group.add(handle);
      });
      return group;
    }

    // TODO(V3-visual): remaining gizmo follow-ups — optional dotted guide lines
    // and rotate handles. Slim/minimal arrow styling landed in the visual pass.
    function buildGizmoAxisHandle(axis, material) {
      const handle = new THREE.Group();
      // Slim, minimal arrow: a thin shaft with small double-ended cones reads as
      // a refined editor control rather than a bulky debug gizmo.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.25, 12), material);
      const coneA = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.26, 16), material);
      coneA.position.y = 0.78;
      const coneB = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.26, 16), material);
      coneB.rotation.x = Math.PI;
      coneB.position.y = -0.78;
      // Fat invisible grab proxy: zero opacity renders nothing but stays
      // raycastable, giving a generous hit area around the slim arrow. Kept
      // generous on purpose — the visible arrow shrank, grabbing must not.
      const hit = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 2.6, 8),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false })
      );
      hit.userData.gizmoHandle = axis;
      gizmoHitMeshes.push(hit);
      gizmoAxisHitMeshes[axis] = hit;
      [shaft, coneA, coneB, hit].forEach(mesh => {
        mesh.renderOrder = 999;
        handle.add(mesh);
      });
      if (axis === 'x') handle.rotation.z = -Math.PI / 2;
      if (axis === 'z') handle.rotation.x = Math.PI / 2;
      return handle;
    }

    function setGizmoActive(activeAxis) {
      Object.keys(gizmoMaterials || {}).forEach(axis => {
        const material = gizmoMaterials[axis];
        if (!material) return;
        if (material.color) material.color.copy(gizmoColor(axis, axis === activeAxis));
        // Subtle emphasis: the active axis lifts to full opacity, idle axes stay soft.
        material.opacity = axis === activeAxis ? 1 : GIZMO_IDLE_OPACITY;
      });
    }

    function updateGizmoTransform() {
      if (!gizmoGroup || !gizmoGroup.visible || !gizmoTargetId) return;
      const group = instances.get(gizmoTargetId);
      const camera = SceneManager.getCamera();
      if (!group || !camera) return;
      const aabb = getAabbWorld(gizmoTargetId);
      if (!aabb) return;
      const scale = camera.isOrthographicCamera
        ? Math.max(0.04, Math.min(3.5, (camera.top - camera.bottom) / camera.zoom * 0.062))
        : computeGizmoScale(camera.position.distanceTo(group.position));
      gizmoGroup.scale.setScalar(scale);
      // Anchor the whole arrow above the case top so faces/labels stay readable.
      gizmoGroup.position.set(group.position.x, aabb.max.y + 0.3 + 1.35 * scale, group.position.z);
    }

    /**
     * Attach the gizmo when exactly one live case is selected. Packed cases keep
     * the full validated placement behavior; staged cases use a limited staging
     * mode that reuses the existing staging drag release path.
     */
    function refreshGizmo() {
      const ids = Array.from(selectedIds);
      let targetId = null;
      let targetMode = null;
      if (ids.length === 1 && instances.has(ids[0])) {
        const packId = StateStore.get('currentPackId');
        const pack = packId ? PackLibrary.getById(packId) : null;
        const inst = pack ? (pack.cases || []).find(i => i && i.id === ids[0]) : null;
        if (inst) {
          targetId = ids[0];
          targetMode = inst.placement === 'staged' ? 'staged' : 'packed';
        }
      }
      if (!targetId) {
        detachGizmo();
        return;
      }
      const scene = SceneManager.getScene();
      if (!scene) return;
      if (!gizmoGroup) {
        gizmoGroup = createGizmo();
        scene.add(gizmoGroup);
      }
      if (!gizmoControlsHooked) {
        const controls = SceneManager.getControls();
        if (controls && typeof controls.addEventListener === 'function') {
          controls.addEventListener('change', updateGizmoTransform);
          gizmoControlsHooked = true;
        }
      }
      gizmoTargetId = targetId;
      gizmoTargetMode = targetMode;
      // Staged cargo cannot stack vertically yet: staged cases expose X/Z only,
      // so the Y arrow is hidden (and its grab proxy dropped in
      // getGizmoHandleMeshes). Packed cases keep the full X/Y/Z control.
      if (gizmoAxisHandles.x) gizmoAxisHandles.x.visible = true;
      if (gizmoAxisHandles.z) gizmoAxisHandles.z.visible = true;
      if (gizmoAxisHandles.y) gizmoAxisHandles.y.visible = targetMode !== 'staged';
      gizmoGroup.visible = true;
      setGizmoActive(false);
      updateGizmoTransform();
    }

    function detachGizmo() {
      gizmoTargetId = null;
      gizmoTargetMode = null;
      if (gizmoGroup) gizmoGroup.visible = false;
    }

    function getGizmoHandleMeshes() {
      if (!gizmoGroup || !gizmoGroup.visible) return [];
      // Staged cargo has no grabbable Y proxy — staged vertical stacking is not
      // supported yet, so only the X/Z proxies stay raycastable.
      if (gizmoTargetMode === 'staged') {
        return ['x', 'z'].map(axis => gizmoAxisHitMeshes[axis]).filter(Boolean);
      }
      return gizmoHitMeshes;
    }

    function getGizmoTargetId() {
      return gizmoTargetId;
    }

    function getGizmoTargetMode() {
      return gizmoTargetMode;
    }

    // The InteractionManager registers a watcher so a scene-only held pose is
    // released whenever a pack-level sync re-applies committed transforms.
    function setPendingPoseWatcher(fn) {
      pendingPoseWatcher = typeof fn === 'function' ? fn : null;
    }

    function getAabbWorld(instanceId, positionOverrideWorld) {
      const group = instances.get(instanceId);
      if (!group) return null;
      const half = group.userData.halfWorld;
      if (!half) return null;
      const p = positionOverrideWorld || group.position;
      return {
        min: { x: p.x - half.x, y: p.y - half.y, z: p.z - half.z },
        max: { x: p.x + half.x, y: p.y + half.y, z: p.z + half.z },
      };
    }

    function aabbWorldToInches(aabb) {
      return {
        min: {
          x: SceneManager.toInches(aabb.min.x),
          y: SceneManager.toInches(aabb.min.y),
          z: SceneManager.toInches(aabb.min.z),
        },
        max: {
          x: SceneManager.toInches(aabb.max.x),
          y: SceneManager.toInches(aabb.max.y),
          z: SceneManager.toInches(aabb.max.z),
        },
      };
    }

    function aabbIntersects(a, b) {
      const EPS = 1e-6;
      return (
        a.min.x < b.max.x - EPS &&
        a.max.x > b.min.x + EPS &&
        a.min.y < b.max.y - EPS &&
        a.max.y > b.min.y + EPS &&
        a.min.z < b.max.z - EPS &&
        a.max.z > b.min.z + EPS
      );
    }

    function isInsideTruck(aabb) {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      const truck = pack && pack.truck ? pack.truck : null;
      if (truck) {
        const zonesInches = TrailerGeometry.getTrailerUsableZones(truck);
        const aabbInches = aabbWorldToInches(aabb);
        return TrailerGeometry.isAabbContainedInAnyZone(aabbInches, zonesInches);
      }

      // Fallback: full rectangular bounds (should only happen before a pack is loaded)
      const bounds = SceneManager.getTruckBoundsWorld();
      if (!bounds) return false;
      return (
        aabb.min.x >= bounds.min.x &&
        aabb.max.x <= bounds.max.x &&
        aabb.min.y >= bounds.min.y &&
        aabb.max.y <= bounds.max.y &&
        aabb.min.z >= bounds.min.z &&
        aabb.max.z <= bounds.max.z
      );
    }

    function intersectsWheelWellBlockedBody(aabb) {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      if (!pack || !pack.truck) return false;
      if (typeof PackLibrary.aabbIntersectsWheelWellBlockedBody !== 'function') return false;
      return PackLibrary.aabbIntersectsWheelWellBlockedBody(aabbWorldToInches(aabb), pack.truck);
    }

    function intersectsFrontOverhangCabVoid(aabb) {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      if (!pack || !pack.truck) return false;
      if (typeof PackLibrary.aabbIntersectsFrontBonusBlockedBody !== 'function') return false;
      return PackLibrary.aabbIntersectsFrontBonusBlockedBody(aabbWorldToInches(aabb), pack.truck);
    }

    function checkCollision(instanceId, candidateWorldPos, ignoreIds) {
      const aabb = getAabbWorld(instanceId, candidateWorldPos);
      if (!aabb) return { collides: false, insideTruck: false };
      const insideTruck = isInsideTruck(aabb);
      const blockedBody = intersectsWheelWellBlockedBody(aabb) || intersectsFrontOverhangCabVoid(aabb);
      if (blockedBody) return { collides: true, insideTruck, blockedBody: true };

      const ignoreSet =
        ignoreIds && typeof ignoreIds.has === 'function'
          ? ignoreIds
          : Array.isArray(ignoreIds)
            ? new Set(ignoreIds)
            : null;

      for (const [otherId] of instances.entries()) {
        if (otherId === instanceId) continue;
        if (ignoreSet && ignoreSet.has(otherId)) continue;
        const otherAabb = getAabbWorld(otherId);
        if (!otherAabb) continue;
        if (aabbIntersects(aabb, otherAabb)) return { collides: true, insideTruck };
      }
      return { collides: false, insideTruck };
    }

    function getBlockedAabbsWorld() {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      const truck = pack && pack.truck ? pack.truck : null;
      if (!truck || !TrailerGeometry || typeof TrailerGeometry.zonesInchesToWorld !== 'function') return [];

      const blockedInches = [];
      if (typeof PackLibrary.getWheelWellsBlockedZones === 'function') {
        blockedInches.push(...(PackLibrary.getWheelWellsBlockedZones(truck) || []));
      }
      if (typeof PackLibrary.getFrontBonusBlockedZones === 'function') {
        blockedInches.push(...(PackLibrary.getFrontBonusBlockedZones(truck) || []));
      }
      return TrailerGeometry.zonesInchesToWorld(blockedInches);
    }

    /**
     * Check the complete motion segment, not only its endpoint. This prevents a
     * fast pointer event from moving a selected group from one clear side of a
     * box or blocked truck body to the other clear side in a single frame.
     */
    function checkSweptCollision(instanceId, fromWorldPos, toWorldPos, ignoreIds) {
      const startAabb = getAabbWorld(instanceId, fromWorldPos);
      const endAabb = getAabbWorld(instanceId, toWorldPos);
      if (!startAabb || !endAabb) return { collides: false, insideTruck: false };
      const insideTruck = isInsideTruck(endAabb);
      const ignoreSet = ignoreIds && typeof ignoreIds.has === 'function'
        ? ignoreIds
        : Array.isArray(ignoreIds)
          ? new Set(ignoreIds)
          : null;

      for (const blockedAabb of getBlockedAabbsWorld()) {
        if (getSweptAabbCollisionTime(startAabb, endAabb, blockedAabb) !== null) {
          return { collides: true, insideTruck, blockedBody: true, swept: true };
        }
      }

      for (const [otherId] of instances.entries()) {
        if (otherId === instanceId) continue;
        if (ignoreSet && ignoreSet.has(otherId)) continue;
        const otherAabb = getAabbWorld(otherId);
        if (otherAabb && getSweptAabbCollisionTime(startAabb, endAabb, otherAabb) !== null) {
          return { collides: true, insideTruck, swept: true };
        }
      }
      return { collides: false, insideTruck };
    }

    /**
     * Resolve the world-Y of the raised front-overhang deck for a footprint centered at
     * (cx, cz) with the given half-extents, or null if the truck has no front-overhang
     * deck or the footprint is not entirely over it. The cab void below the deck is
     * never a valid floor, so this is the only non-zero floor offset settleY() uses.
     */
    function getFrontOverhangDeckFloorYWorld(cx, cz, halfX, halfZ) {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      const truck = pack && pack.truck ? pack.truck : null;
      if (!truck || truck.shapeMode !== 'frontBonus') return null;
      if (!TrailerGeometry || typeof TrailerGeometry.getFrontBonusZone !== 'function') return null;

      const zoneInches = TrailerGeometry.getFrontBonusZone(truck);
      if (!zoneInches) return null;
      const zoneWorld = TrailerGeometry.zonesInchesToWorld([zoneInches])[0];
      if (!zoneWorld) return null;

      const EPS = 1e-6;
      // Only settle onto the deck when the whole footprint sits over the overhang -
      // a footprint straddling the seam, extending past the front of the deck, or
      // spilling outside the deck's width still rests on the main floor / falls
      // back to the existing floor/support logic.
      const fitsX = cx - halfX >= zoneWorld.min.x - EPS && cx + halfX <= zoneWorld.max.x + EPS;
      const fitsZ = cz - halfZ >= zoneWorld.min.z - EPS && cz + halfZ <= zoneWorld.max.z + EPS;
      if (fitsX && fitsZ) return zoneWorld.min.y;
      return null;
    }

    /** Settle a case down via gravity: find highest valid support surface at current X,Z. */
    function settleY(instanceId) {
      const group = instances.get(instanceId);
      if (!group || !group.userData.halfWorld) return null;

      const otherAabbs = [];
      for (const [otherId, otherGroup] of instances.entries()) {
        if (otherId === instanceId) continue;
        if (!otherGroup || otherGroup.visible === false) continue;
        const otherAabb = getAabbWorld(otherId);
        if (otherAabb) otherAabbs.push(otherAabb);
      }

      const halfWorld = group.userData.halfWorld;
      const deckFloorY = getFrontOverhangDeckFloorYWorld(group.position.x, group.position.z, halfWorld.x, halfWorld.z);

      return computeSettleY(
        halfWorld,
        group.position.x,
        group.position.z,
        otherAabbs,
        MIN_SUPPORT_FRACTION,
        deckFloorY !== null ? deckFloorY : 0,
      );
    }

    function getSnapWallCandidatesWorld() {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      const truck = pack && pack.truck ? pack.truck : null;
      if (
        truck &&
        TrailerGeometry &&
        typeof TrailerGeometry.getTrailerUsableZones === 'function' &&
        typeof TrailerGeometry.zonesInchesToWorld === 'function'
      ) {
        const zonesInches = TrailerGeometry.getTrailerUsableZones(truck);
        const zonesWorld = TrailerGeometry.zonesInchesToWorld(zonesInches);
        const x = [];
        const z = [];
        zonesWorld.forEach(zone => {
          x.push(zone.min.x, zone.max.x);
          z.push(zone.min.z, zone.max.z);
        });
        if (x.length && z.length) return { x, z };
      }

      const bounds = SceneManager.getTruckBoundsWorld();
      if (!bounds) return null;
      return {
        x: [bounds.min.x, bounds.max.x],
        z: [bounds.min.z, bounds.max.z],
      };
    }

    function addPreviewSurface(surfaces, surface) {
      if (!surface || !surface.min || !surface.max) return;
      const minX = Number(surface.min.x);
      const maxX = Number(surface.max.x);
      const minZ = Number(surface.min.z);
      const maxZ = Number(surface.max.z);
      const topY = Number(surface.topY);
      if (!Number.isFinite(minX) || !Number.isFinite(maxX) ||
          !Number.isFinite(minZ) || !Number.isFinite(maxZ) ||
          !Number.isFinite(topY) ||
          minX === maxX || minZ === maxZ) {
        return;
      }
      surfaces.push({
        id: surface.id,
        kind: surface.kind,
        min: { x: Math.min(minX, maxX), z: Math.min(minZ, maxZ) },
        max: { x: Math.max(minX, maxX), z: Math.max(minZ, maxZ) },
        topY,
      });
    }

    function getSurfaceKindForUsableZone(truck, zoneWorld) {
      const topY = Number(zoneWorld && zoneWorld.min && zoneWorld.min.y);
      if (!(topY > 1e-6)) return 'truck-floor';
      return truck && truck.shapeMode === 'wheelWells' ? 'wheel-well-top' : 'front-deck';
    }

    function getSurfaceFollowingPreviewSurfaces(instanceId, ignoreIds) {
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      const truck = pack && pack.truck ? pack.truck : null;
      const packInstances = new Map(
        (pack && Array.isArray(pack.cases) ? pack.cases : [])
          .filter(inst => inst && inst.id)
          .map(inst => [inst.id, inst])
      );
      const surfaces = [];
      const ignoreSet = ignoreIds && typeof ignoreIds.has === 'function'
        ? ignoreIds
        : Array.isArray(ignoreIds)
          ? new Set(ignoreIds)
          : null;

      if (truck &&
          TrailerGeometry &&
          typeof TrailerGeometry.getTrailerUsableZones === 'function' &&
          typeof TrailerGeometry.zonesInchesToWorld === 'function') {
        const zonesInches = TrailerGeometry.getTrailerUsableZones(truck);
        const zonesWorld = TrailerGeometry.zonesInchesToWorld(zonesInches);
        zonesWorld.forEach((zoneWorld, index) => {
          if (!zoneWorld || !zoneWorld.min || !zoneWorld.max) return;
          addPreviewSurface(surfaces, {
            id: `truck-zone-${index}`,
            kind: getSurfaceKindForUsableZone(truck, zoneWorld),
            min: { x: zoneWorld.min.x, z: zoneWorld.min.z },
            max: { x: zoneWorld.max.x, z: zoneWorld.max.z },
            topY: zoneWorld.min.y,
          });
        });
      }

      if (truck && typeof PackLibrary.getStagingWorkAreaBounds === 'function') {
        const stagingBounds = PackLibrary.getStagingWorkAreaBounds(truck);
        if (stagingBounds && stagingBounds.min && stagingBounds.max) {
          const minWorld = SceneManager.vecInchesToWorld({
            x: stagingBounds.min.x,
            y: Number(stagingBounds.min.y) || 0,
            z: stagingBounds.min.z,
          });
          const maxWorld = SceneManager.vecInchesToWorld({
            x: stagingBounds.max.x,
            y: Number(stagingBounds.min.y) || 0,
            z: stagingBounds.max.z,
          });
          addPreviewSurface(surfaces, {
            id: 'staging-floor',
            kind: 'staging-floor',
            min: { x: minWorld.x, z: minWorld.z },
            max: { x: maxWorld.x, z: maxWorld.z },
            topY: minWorld.y,
          });
        }
      }

      for (const [otherId, otherGroup] of instances.entries()) {
        if (otherId === instanceId) continue;
        if (ignoreSet && ignoreSet.has(otherId)) continue;
        if (!otherGroup || otherGroup.visible === false) continue;
        const otherInst = packInstances.get(otherId);
        const aabb = getAabbWorld(otherId);
        if (!aabb) continue;
        // Preview-only terrain: staged tops can lift the ghost, but release
        // validation still keeps staged Y floor-normalized unless placed.
        const kind = otherInst && otherInst.placement === 'staged' ? 'staged-box-top' : 'box-top';
        addPreviewSurface(surfaces, {
          id: otherId,
          kind,
          min: { x: aabb.min.x, z: aabb.min.z },
          max: { x: aabb.max.x, z: aabb.max.z },
          topY: aabb.max.y,
        });
      }

      return surfaces;
    }

    function getSurfaceFollowingPreview(instanceId, candidateWorldPos, ignoreIds) {
      const group = instances.get(instanceId);
      if (!group || !group.userData.halfWorld || !candidateWorldPos) return null;
      return computeSurfaceFollowingPreviewY({
        halfWorld: group.userData.halfWorld,
        centerX: candidateWorldPos.x,
        centerZ: candidateWorldPos.z,
        surfaces: getSurfaceFollowingPreviewSurfaces(instanceId, ignoreIds),
        minOverlapFraction: SURFACE_PREVIEW_DRAG_MIN_OVERLAP,
      });
    }

    function getRigidGroupSurfaceFollowingPreview(
      groupIds,
      startMap,
      deltaX,
      deltaZ,
      fromDeltaX,
      fromDeltaZ
    ) {
      if (!Array.isArray(groupIds) || groupIds.length < 2 || !startMap ||
          typeof startMap.get !== 'function') {
        return null;
      }
      const ignoreSet = new Set(groupIds);
      const members = [];
      for (const id of groupIds) {
        const group = instances.get(id);
        const start = startMap.get(id);
        if (!group || !group.userData.halfWorld || !start) return null;
        members.push({ id, start, halfWorld: group.userData.halfWorld });
      }
      return computeRigidGroupSurfaceFollowingDelta({
        members,
        surfaces: getSurfaceFollowingPreviewSurfaces(null, ignoreSet),
        deltaX,
        deltaZ,
        fromDeltaX,
        fromDeltaZ,
        minOverlapFraction: SURFACE_PREVIEW_DRAG_MIN_OVERLAP,
      });
    }

    /**
     * Snap a world position to the nearest box edge or truck wall (XZ only).
     * Returns adjusted { x, z } or null if no snap occurred.
     * @param {string} instanceId - The instance being placed
     * @param {{ x: number, y: number, z: number }} worldPos - candidate world position
     * @returns {{ x: number, z: number } | null}
     */
    function snapToNearest(instanceId, worldPos) {
      const group = instances.get(instanceId);
      if (!group || !group.userData.halfWorld) { return null; }
      const half = group.userData.halfWorld;
      const SNAP_DIST = SceneManager.toWorld(2); // 2 inches snap threshold
      let bestX = worldPos.x;
      let bestZ = worldPos.z;
      let snapXDist = SNAP_DIST;
      let snapZDist = SNAP_DIST;
      let snapped = false;

      // My edges
      const myMinX = worldPos.x - half.x;
      const myMaxX = worldPos.x + half.x;
      const myMinZ = worldPos.z - half.z;
      const myMaxZ = worldPos.z + half.z;

      // Snap to truck walls
      const wallCandidates = getSnapWallCandidatesWorld();
      if (wallCandidates) {
        wallCandidates.x.forEach(wall => {
          [
            { myEdge: myMinX, offset: half.x },
            { myEdge: myMaxX, offset: -half.x },
          ].forEach(({ myEdge, offset }) => {
            const dist = Math.abs(myEdge - wall);
            if (dist < snapXDist) {
              snapXDist = dist;
              bestX = wall + offset;
              snapped = true;
            }
          });
        });
        wallCandidates.z.forEach(wall => {
          [
            { myEdge: myMinZ, offset: half.z },
            { myEdge: myMaxZ, offset: -half.z },
          ].forEach(({ myEdge, offset }) => {
            const dist = Math.abs(myEdge - wall);
            if (dist < snapZDist) {
              snapZDist = dist;
              bestZ = wall + offset;
              snapped = true;
            }
          });
        });
      }

      // Snap to other box edges
      for (const [otherId, otherGroup] of instances.entries()) {
        if (otherId === instanceId) { continue; }
        if (!otherGroup || otherGroup.visible === false) { continue; }
        const otherAabb = getAabbWorld(otherId);
        if (!otherAabb) { continue; }

        // X-axis snap: my left→other right, my right→other left
        const dxA = Math.abs(myMinX - otherAabb.max.x);
        if (dxA < snapXDist) { snapXDist = dxA; bestX = otherAabb.max.x + half.x; snapped = true; }
        const dxB = Math.abs(myMaxX - otherAabb.min.x);
        if (dxB < snapXDist) { snapXDist = dxB; bestX = otherAabb.min.x - half.x; snapped = true; }

        // Z-axis snap: my front→other back, my back→other front
        const dzA = Math.abs(myMinZ - otherAabb.max.z);
        if (dzA < snapZDist) { snapZDist = dzA; bestZ = otherAabb.max.z + half.z; snapped = true; }
        const dzB = Math.abs(myMaxZ - otherAabb.min.z);
        if (dzB < snapZDist) { snapZDist = dzB; bestZ = otherAabb.min.z - half.z; snapped = true; }
      }

      return snapped ? { x: bestX, z: bestZ } : null;
    }

    /** Highlight instances that are out-of-gauge (outside truck bounds). */
    function applyOOGHighlights() {
      oogSet.clear();
      const packId = StateStore.get('currentPackId');
      // Staged state comes from the layout the scene shows (a transient Results
      // preview included), so a case staged only in that layout is not flagged.
      const pack = syncedPack && syncedPack.id === packId
        ? syncedPack
        : (packId ? PackLibrary.getById(packId) : null);
      const instanceById = new Map(
        pack && Array.isArray(pack.cases)
          ? pack.cases.filter(inst => inst && inst.id).map(inst => [inst.id, inst])
          : []
      );
      for (const [id, group] of instances.entries()) {
        if (!group || !group.userData.mesh) continue;
        // Hidden cargo owns no warning highlight, even though it remains
        // translucent and raycastable in the scene.
        if (group.userData.hidden === true) continue;
        // Staged cases intentionally live outside the truck in the staging area;
        // do not mark them as out-of-gauge cargo.
        const inst = instanceById.get(id);
        if (inst && inst.placement === 'staged') continue;
        const aabb = getAabbWorld(id);
        if (!aabb) continue;
        const inside = isInsideTruck(aabb);
        if (!inside) oogSet.add(id);
      }
      recomputeVisualStates();
    }

    // Visual-export authority: every rendered group sits exactly at the pose
    // applyTransform derives from its committed Pack instance, so no drag, hold,
    // return tween or other scene-only motion can reach an exported image.
    function matchesCommittedPoses(pack) {
      if (!pack || syncedPack !== pack) return false;
      let rendered = 0;
      for (const inst of pack.cases || []) {
        if (!inst || !CaseLibrary.getById(inst.caseId)) continue;
        rendered += 1;
        const group = instances.get(inst.id);
        if (!group || !inst.transform) return false;
        const expected = SceneManager.vecInchesToWorld(inst.transform.position || { x: 0, y: 0, z: 0 });
        const halfY = group.userData.halfWorld ? group.userData.halfWorld.y : 0;
        expected.y = Math.max(halfY || 0.01, expected.y);
        const rot = inst.transform.rotation || {};
        if (group.position.distanceTo(expected) > 1e-6 ||
            Math.abs(group.rotation.x - (Number(rot.x) || 0)) > 1e-9 ||
            Math.abs(group.rotation.y - (Number(rot.y) || 0)) > 1e-9 ||
            Math.abs(group.rotation.z - (Number(rot.z) || 0)) > 1e-9) return false;
      }
      return rendered === instances.size;
    }

    // Clean export capture: drop interaction-only emphasis (selection, hover,
    // drag, collision, gizmo) and omit hidden cargo plus caller-excluded
    // instances. Committed OOG warnings stay. The returned restore() puts every
    // changed value back and must run in a finally.
    function beginExportCapture({ excludeIds = null } = {}) {
      const saved = {
        hoveredId,
        draggedId,
        selectedIds,
        collisions: new Set(collisionIds),
        gizmoVisible: gizmoGroup ? gizmoGroup.visible : null,
        visibility: new Map(),
      };
      hoveredId = null;
      draggedId = null;
      selectedIds = new Set();
      collisionIds.clear();
      if (gizmoGroup) gizmoGroup.visible = false;
      instances.forEach((group, id) => {
        saved.visibility.set(group, group.visible);
        if (group.userData.hidden === true || (excludeIds && excludeIds.has(id))) group.visible = false;
      });
      recomputeVisualStates();
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        hoveredId = saved.hoveredId;
        draggedId = saved.draggedId;
        selectedIds = saved.selectedIds;
        collisionIds.clear();
        saved.collisions.forEach(id => collisionIds.add(id));
        if (gizmoGroup && saved.gizmoVisible !== null) gizmoGroup.visible = saved.gizmoVisible;
        saved.visibility.forEach((visible, group) => { group.visible = visible; });
        recomputeVisualStates();
      };
    }

    return {
      clear,
      sync,
      getSyncedPack: () => syncedPack,
      getGeometryRevision: () => geometryRevision,
      isTransientPreview: () => syncedTransientPreview,
      matchesCommittedPoses,
      beginExportCapture,
      getVisualSignature,
      rebindPreviewPack,
      setHover,
      setSelected,
      setDragging,
      setCollision,
      getObject,
      getRaycastMeshes,
      getAabbWorld,
      checkCollision,
      checkSweptCollision,
      isInsideTruck,
      applyOOGHighlights,
      settleY,
      snapToNearest,
      getSurfaceFollowingPreview,
      getRigidGroupSurfaceFollowingPreview,
      refreshGizmo,
      updateGizmoTransform,
      setGizmoActive,
      getGizmoHandleMeshes,
      getGizmoTargetId,
      getGizmoTargetMode,
      setPendingPoseWatcher,
    };
  })();

  return CaseScene;
}

export function createInteractionManager({
  SceneManager,
  CaseScene,
  StateStore,
  PackLibrary,
  CaseLibrary,
  PreferencesManager,
  UIComponents,
  OperationLifecycle = null,
  MeasurementTool = null,
  AnnotationTool = null,
}) {
  const InteractionManager = (() => {
    // True while a mutating editor operation (AutoPack / Unpack / Truck Change /
    // preview capture) owns the editor, or while the scene shows a transient
    // AutoPack Results preview (not the committed Pack, so no scene move may
    // commit from it). Direct scene mutations must not run then — but camera
    // orbit/pan/zoom (OrbitControls, separate from these handlers) and
    // hover/selection stay available.
    function scenePreviewOnly() {
      return Boolean(CaseScene.isTransientPreview && CaseScene.isTransientPreview());
    }
    function operationsBusy() {
      return Boolean(OperationLifecycle && OperationLifecycle.isBusy()) || scenePreviewOnly();
    }
    function prepareSceneMutation() {
      return operationsBusy();
    }
    function showOperationsBusyToast() {
      UIComponents.showToast(scenePreviewOnly()
        ? 'Use "Apply this option" in AutoPack Results before editing cargo.'
        : 'Another operation is in progress. Please wait…', 'info', { title: 'Editor' });
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const dragOffset = new THREE.Vector3();
    const tmpVec3 = new THREE.Vector3();
    // Alt-drag release-outcome preview is throttled so the validated resolve
    // never runs per pointer event on large loads.
    const DRAG_PREVIEW_THROTTLE_MS = 120;
    let lastDragPreviewTime = 0;

    let domEl = null;
    let focusClickPackId = null;
    let hoveredId = null;
    let drawingHover = false; // the pointer is over a saved Drawing's line (grab cursor), which a plain press would take ahead of cargo
    let lineHover = false; // the pointer is over a saved Arrow's shaft (pointer cursor): a plain click selects it ahead of cargo
    let pressed = null;
    let draggingId = null;
    let gizmoDragging = false;
    let gizmoAxis = null;
    // Scene-only held pose from a gizmo stroke that did not end on a directly
    // valid spot: { instanceId }. Never persisted; the pack keeps the committed
    // pose until a validated drop commits or the hold is cancelled/invalidated.
    let gizmoPending = null;
    // Rejected-drop return tweens still moving meshes back to their committed
    // poses. Scene-only motion: provisional until the tween's settle timeout.
    let revertHolds = 0;
    let dragStartPosWorld = null;
    let dragGroupIds = null;
    let dragGroupStartWorld = null; // Map<instanceId, THREE.Vector3>
    let dragGroupAcceptedWorld = null; // Last rigid, collision-free preview pose.
    let dragGroupPreviewBlocked = false;
    let surfaceFollowingDrag = false;
    let lastRaycastTime = 0;
    const CLICK_DRAG_THRESHOLD_PX = 3;
    const RAYCAST_THROTTLE = 50; // ms - throttle hover raycasts

    function initInteraction(canvasEl) {
      domEl = canvasEl;
      domEl.classList.add('tp3d-editor-no-touch-action');
      domEl.addEventListener('pointermove', onMove);
      domEl.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      domEl.addEventListener('pointercancel', onCancel);
      domEl.addEventListener('lostpointercapture', onCancel);
      domEl.addEventListener('click', ev => {
        if (ev.detail === 1) focusClickPackId = StateStore.get('currentPackId');
      });
      domEl.addEventListener('dblclick', onDblClick);
      StateStore.subscribe(changes => {
        if (changes.currentScreen || changes.currentPackId || changes._replace) focusClickPackId = null;
      });
      // Only leaving the viewport ends pointer-origin focus; shortcuts keep it,
      // so Tab / Shift+Tab back in is what shows the keyboard cue.
      domEl.parentElement?.addEventListener('blur', () => {
        domEl.parentElement?.classList.remove('tp3d-pointer-focus');
      });
      window.addEventListener('keydown', onKeyDown);
      if (typeof CaseScene.setPendingPoseWatcher === 'function') {
        CaseScene.setPendingPoseWatcher(onScenePendingInvalidated);
      }
    }

    function rejectMoveCollision(instanceId, candidateWorld, ignoreSet) {
      const check = CaseScene.checkCollision(instanceId, candidateWorld, ignoreSet);
      CaseScene.setCollision(instanceId, check.collides);
      if (!check.collides) return false;
      UIComponents.showToast('Cannot place here: collision detected', 'error');
      // Nudge candidates are rejected immediately rather than held as a live
      // preview, so the temporary collision owner ends with this interaction.
      CaseScene.setCollision(instanceId, false);
      return true;
    }

    function commitCasesWithManualRevalidation(packId, nextCases, options = {}) {
      if (typeof PackLibrary.updateCasesWithManualRevalidation === 'function') {
        return PackLibrary.updateCasesWithManualRevalidation(packId, nextCases, CaseLibrary.getCases(), options);
      }
      return PackLibrary.update(packId, { cases: nextCases });
    }

    function getInstanceDimsInches(inst) {
      const caseData = inst ? CaseLibrary.getById(inst.caseId) : null;
      return getActualPoseDimensions(caseData, inst).value || null;
    }

    function makeInstanceAabbInches(position, dims) {
      if (!position || !dims) return null;
      const half = {
        x: Number(dims.length) / 2,
        y: Number(dims.height) / 2,
        z: Number(dims.width) / 2,
      };
      if (!Number.isFinite(half.x) || !Number.isFinite(half.y) || !Number.isFinite(half.z)) return null;
      return {
        min: { x: position.x - half.x, y: position.y - half.y, z: position.z - half.z },
        max: { x: position.x + half.x, y: position.y + half.y, z: position.z + half.z },
      };
    }

    function stagedCandidateIsInsideUsableTruckZone(pack, inst, positionInches) {
      if (!pack || !pack.truck ||
          typeof PackLibrary.getTrailerUsableZones !== 'function') {
        return false;
      }
      const dims = getInstanceDimsInches(inst);
      const aabb = makeInstanceAabbInches(positionInches, dims);
      if (!aabb) return false;
      return pointInsideTruckFootprint(PackLibrary.getTrailerUsableZones(pack.truck), positionInches);
    }

    function buildStagedToPackedCandidateCases(pack, instanceId, desiredPosition) {
      return (pack.cases || []).map(item =>
        item.id === instanceId
          ? withoutPackedProfile({
            ...item,
            transform: { ...(item.transform || {}), position: desiredPosition },
            placement: 'packed',
          })
          : item
      );
    }

    function tryCommitStagedIntoTruck(packId, pack, inst, obj, groupIds, startMap) {
      if (!inst || inst.placement !== 'staged' || !obj ||
          typeof PackLibrary.findManualVerticalPlacement !== 'function' ||
          typeof PackLibrary.revalidateManualPlacements !== 'function') {
        return false;
      }
      const desiredPosition = SceneManager.vecWorldToInches(obj.position);
      if (!stagedCandidateIsInsideUsableTruckZone(pack, inst, desiredPosition)) return false;
      const resolved = PackLibrary.findManualVerticalPlacement(
        pack, CaseLibrary.getCases(), inst.id,
        { mode: 'resolve', desiredPosition, manualGeometry: true, rejectProposedCollisions: true }
      );
      if (!resolved.ok) {
        if (resolved.code === 'outside-truck') return false;
        revertGroupToStart(groupIds, startMap);
        UIComponents.showToast(resolved.reason || 'Cannot place this staged case in the truck safely.', 'error');
        resetDrag();
        return true;
      }
      const candidateCases = buildStagedToPackedCandidateCases(pack, inst.id, resolved.position);
      const preflight = PackLibrary.revalidateManualPlacements(
        { ...pack, cases: candidateCases },
        CaseLibrary.getCases(),
        { repairDependents: true, beforePack: pack, manualGeometry: true }
      );
      const preflightSelf = preflight && preflight.pack && Array.isArray(preflight.pack.cases)
        ? preflight.pack.cases.find(item => item && item.id === inst.id)
        : null;
      if (preflightSelf && preflightSelf.placement === 'packed' &&
          preflightSelf.transform &&
          positionsShareManualXZ(preflightSelf.transform.position, resolved.position) &&
          positionsShareManualY(preflightSelf.transform.position, resolved.position)) {
        const committed = PackLibrary.update(packId, { cases: preflight.pack.cases });
        if (!committed) {
          revertGroupToStart(groupIds, startMap);
          UIComponents.showToast('Load Plan is unavailable. No Case was moved.', 'error');
          resetDrag();
          return true;
        }
        const result = { ...preflight, pack: committed };
        const committedSelf = committed.cases.find(item => item && item.id === inst.id);
        const stagedSelf = !committedSelf || committedSelf.placement !== 'packed' ||
          !positionsShareManualXZ(committedSelf.transform && committedSelf.transform.position, resolved.position) ||
          !positionsShareManualY(committedSelf.transform && committedSelf.transform.position, resolved.position) ||
          result.stagedIds.includes(inst.id);
        if (committedSelf && committedSelf.transform && committedSelf.transform.position) {
          obj.position.copy(SceneManager.vecInchesToWorld(committedSelf.transform.position));
        }
        CaseScene.setCollision(inst.id, stagedSelf);
        UIComponents.showToast(formatVerticalMoveMessage(
          result, inst.id, stagedSelf
            ? 'The case could not rest safely and stayed in staging.'
            : 'Placed staged case in the truck.'
        ), stagedSelf ? 'warning' : 'success');
        resetDrag();
        CaseScene.applyOOGHighlights();
        return true;
      }

      if (stagedCandidateIsInsideUsableTruckZone(pack, inst, desiredPosition)) {
        revertGroupToStart(groupIds, startMap);
        UIComponents.showToast(preflight.invalidReasons?.[inst.id] || 'This position has no stable physical support.', 'error');
        resetDrag();
        return true;
      }
      return false;
    }

    function buildAtomicManualGroupCandidate(pack, groupIds) {
      if (!pack || !pack.truck || !Array.isArray(groupIds) || groupIds.length < 2 ||
          typeof PackLibrary.getTrailerUsableZones !== 'function') {
        return null;
      }

      const zones = PackLibrary.getTrailerUsableZones(pack.truck);
      const patchById = new Map();
      let packedCount = 0;
      let stagedCount = 0;

      for (const id of groupIds) {
        const inst = (pack.cases || []).find(item => item && item.id === id);
        const caseData = inst ? CaseLibrary.getById(inst.caseId) : null;
        const obj = CaseScene.getObject(id);
        const dims = caseData ? getInstanceDimsInches(inst) : null;
        if (!inst || !caseData || !obj || !dims) return null;

        const position = SceneManager.vecWorldToInches(obj.position);
        const aabb = makeInstanceAabbInches(position, dims);
        if (!aabb) return null;
        const placement = pointInsideTruckFootprint(zones, position) ? 'packed' : 'staged';
        if (placement === 'packed') packedCount += 1;
        else stagedCount += 1;
        patchById.set(id, {
          transform: { ...(inst.transform || {}), position },
          placement,
        });
      }

      return {
        cases: applyInstancePatches(pack, patchById),
        packedCount,
        stagedCount,
      };
    }

    function revertAtomicManualGroup(groupIds, startMap, message) {
      revertGroupToStart(groupIds, startMap);
      UIComponents.showToast(message, 'error');
      resetDrag();
    }

    function tryCommitAtomicManualGroup(packId, pack, groupIds, startMap) {
      if (!Array.isArray(groupIds) || groupIds.length < 2) return false;
      if (typeof PackLibrary.revalidateManualPlacements !== 'function') {
        revertAtomicManualGroup(
          groupIds,
          startMap,
          'Cannot validate this group placement. All selected cases were returned.'
        );
        return true;
      }

      const candidate = buildAtomicManualGroupCandidate(pack, groupIds);
      if (!candidate) {
        revertAtomicManualGroup(
          groupIds,
          startMap,
          'Cannot validate every selected case. All selected cases were returned.'
        );
        return true;
      }

      const preflight = PackLibrary.revalidateManualPlacements(
        { ...pack, cases: candidate.cases },
        CaseLibrary.getCases(),
        { repairDependents: true, beforePack: pack, manualGeometry: true, rejectProposedCollisions: true }
      );
      const atomicResult = validateAtomicManualGroupResult(candidate.cases, preflight, groupIds);
      if (!atomicResult.ok || (Array.isArray(preflight && preflight.failedIds) && preflight.failedIds.length)) {
        revertAtomicManualGroup(
          groupIds,
          startMap,
          preflight.invalidReasons?.[atomicResult.instanceId] || {
            'selected-placement-changed': 'A selected Case cannot fit at this truck position.',
            'selected-position-changed': candidate.cases.find(item => item.id === atomicResult.instanceId)?.placement === 'staged'
              ? 'The selection overlaps Cases in staging. Move it into the truck or an open staging area.'
              : 'A selected Case would need to move sideways.',
            'selected-relative-position-changed': 'This group cannot settle without changing its shape.',
          }[atomicResult.reason] || (preflight.failedIds?.length
            ? 'A dependent Case could not be staged safely. No changes were saved.'
            : 'This selection has no stable, collision-free placement.')
        );
        return true;
      }

      const committed = PackLibrary.update(packId, { cases: preflight.pack.cases });
      const result = committed ? { ...preflight, pack: committed } : null;
      if (!result) {
        revertAtomicManualGroup(
          groupIds,
          startMap,
          'Group placement failed. All selected cases were returned.'
        );
        return true;
      }

      let baseMessage;
      if (candidate.packedCount === groupIds.length) {
        baseMessage = `Placed ${caseCountText(groupIds.length)}.`;
      } else if (candidate.stagedCount === groupIds.length) {
        baseMessage = `Placed ${caseCountText(groupIds.length)} in staging.`;
      } else {
        baseMessage = `Placed ${caseCountText(groupIds.length)}: ${candidate.packedCount} in the truck and ${candidate.stagedCount} in staging.`;
      }

      const movedSet = new Set(groupIds);
      const otherResettled = new Set([
        ...(Array.isArray(result.adjustedIds) ? result.adjustedIds : []),
        ...(Array.isArray(result.repairedIds) ? result.repairedIds : []),
      ].filter(id => !movedSet.has(id)));
      const otherStaged = new Set(
        (Array.isArray(result.stagedIds) ? result.stagedIds : []).filter(id => !movedSet.has(id))
      );
      const tone = otherStaged.size
        ? 'warning'
        : otherResettled.size
          ? 'info'
          : candidate.packedCount
            ? 'success'
            : 'info';
      UIComponents.showToast(formatManualGroupMoveMessage(result, groupIds, baseMessage), tone);
      resetDrag();
      CaseScene.applyOOGHighlights();
      return true;
    }

    function applyInstancePatches(pack, patchById) {
      return (pack.cases || []).map(inst => {
        const patch = patchById.get(inst.id);
        return patch ? withoutPackedProfile({ ...inst, ...patch }) : inst;
      });
    }

    // An unresolved held pose or a live stroke owns the case's pose until it is
    // placed or cancelled: a transform or nudge must not commit a second
    // authoritative pose around it.
    function provisionalPoseOwnsSelection() {
      if (draggingId || gizmoDragging || revertHolds > 0) return true;
      if (!gizmoPending) return false;
      UIComponents.showToast('Place or cancel the held case first (Drop, Enter, or Esc).', 'info');
      return true;
    }

    // Exact orientation is AutoPack planning intent. Read only the committed
    // single selection after the same strict refusal gates used by rotation.
    function setSelectionOrientationConstraint(active, expectedId = null) {
      if (prepareSceneMutation()) {
        showOperationsBusyToast();
        return false;
      }
      if (provisionalPoseOwnsSelection()) return false;
      const ids = getSelection();
      if (ids.length !== 1 || (expectedId && ids[0] !== expectedId)) return false;
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      const inst = pack?.cases?.find(item => item.id === ids[0]);
      if (!inst || (inst.orientationLocked === true) === active) return false;
      let patch;
      if (active) {
        const caseData = CaseLibrary.getById(inst.caseId);
        const rotation = inst.transform?.rotation;
        if (!isCasePhysicalOrientationAllowed(caseData, rotation)) {
          UIComponents.showToast('Cannot fix AutoPack orientation: the committed pose is unsupported or not permitted by this Case.', 'error');
          return false;
        }
        patch = PackLibrary.createOrientationLockPatch(rotation);
        if (!patch) return false;
      } else {
        // Release is always possible, even for a malformed or conflicting target.
        patch = PackLibrary.clearOrientationLockPatch();
      }
      PackLibrary.update(packId, {
        cases: pack.cases.map(item => item.id === inst.id ? { ...item, ...patch } : item),
      });
      return true;
    }

    /**
     * Rotate selected instances by delta on given axis, then apply gravity.
     */
    function rotateSelection(axis, delta) {
      if (prepareSceneMutation()) {
        showOperationsBusyToast();
        return;
      }
      if (provisionalPoseOwnsSelection()) return;
      const ids = getSelection();
      if (!ids.length) { return; }
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack) { return; }
      let rotatedCount = 0;
      let blockedCount = 0;
      let policyBlockedCount = 0;
      const patchById = new Map();
      ids.forEach(id => {
        const inst = (pack.cases || []).find(i => i.id === id);
        if (!inst) { return; }
        const rot = { ...(inst.transform.rotation || { x: 0, y: 0, z: 0 }) };
        rot[axis] = ((Number(rot[axis]) || 0) + delta) % (2 * Math.PI);
        const rotation = PackLibrary.normalizeRightAngleRotation(rot);
        const caseData = CaseLibrary.getById(inst.caseId);
        if (!isCasePhysicalOrientationAllowed(caseData, rotation)) {
          policyBlockedCount += 1;
          return;
        }
        const dims = getActualPoseDimensions(caseData, { transform: { rotation } }).value;
        const rotationPatch = {
          ...(inst.orientationLocked === true ? PackLibrary.createOrientationLockPatch(rotation) : {}),
          orientedDims: dims,
        };
        const obj = CaseScene.getObject(id);
        if (obj) {
          const originalWorld = obj.position.clone();
          const originalRotation = obj.rotation.clone();
          const originalHalfWorld = obj.userData && obj.userData.halfWorld
            ? { ...obj.userData.halfWorld }
            : null;
          const ignoreSet = new Set([id]);
          const originalInsideTruck = CaseScene.checkCollision(id, obj.position, ignoreSet).insideTruck;
          if (dims && obj.userData) {
            obj.userData.halfWorld = {
              x: SceneManager.toWorld(dims.length) / 2,
              y: SceneManager.toWorld(dims.height) / 2,
              z: SceneManager.toWorld(dims.width) / 2,
            };
          }
          obj.rotation.set(
            rotation.x,
            rotation.y,
            rotation.z
          );
          const settledY = CaseScene.settleY(id);
          if (settledY !== null) {
            const halfY = obj.userData && obj.userData.halfWorld ? obj.userData.halfWorld.y : 0;
            obj.position.y = Math.max(settledY, halfY || settledY);
          }
          const check = CaseScene.checkCollision(id, obj.position, ignoreSet);
          const posInches = SceneManager.vecWorldToInches(obj.position);
          if (check.collides || (originalInsideTruck && !check.insideTruck)) {
            obj.position.copy(originalWorld);
            obj.rotation.copy(originalRotation);
            if (originalHalfWorld && obj.userData) obj.userData.halfWorld = originalHalfWorld;
            const restoredCheck = CaseScene.checkCollision(id, obj.position, ignoreSet);
            CaseScene.setCollision(id, restoredCheck.collides);
            blockedCount += 1;
            return;
          }
          CaseScene.setCollision(id, false);
          patchById.set(id, {
            ...rotationPatch,
            transform: { ...inst.transform, rotation, position: posInches },
            placement: check.insideTruck ? 'packed' : 'staged',
          });
          rotatedCount += 1;
          return;
        }
        patchById.set(id, {
          ...rotationPatch,
          transform: { ...inst.transform, rotation },
        });
        rotatedCount += 1;
      });
      if (patchById.size) {
        commitCasesWithManualRevalidation(packId, applyInstancePatches(pack, patchById));
      }
      CaseScene.applyOOGHighlights();
      if (rotatedCount) UIComponents.showToast(`Rotated ${rotatedCount} case(s)`, 'info');
      if (blockedCount) UIComponents.showToast('Cannot rotate here: collision or truck boundary detected', 'error');
      // The block here comes from the CASE orientation policy (upright / on-side),
      // not an exact instance lock — keep the wording accurate.
      if (policyBlockedCount) UIComponents.showToast("Cannot rotate: the case's orientation policy does not allow this rotation.", 'error');
    }

    /**
     * Nudge selected instances by delta inches on given world axis.
     */
    function nudgeSelection(axis, deltaInches) {
      if (prepareSceneMutation()) {
        showOperationsBusyToast();
        return;
      }
      if (provisionalPoseOwnsSelection()) return;
      const ids = getSelection();
      if (!ids.length) { return; }
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack) { return; }
      const ignoreSet = new Set(ids);
      const patchById = new Map();
      ids.forEach(id => {
        const inst = (pack.cases || []).find(i => i.id === id);
        if (!inst) { return; }
        const pos = { ...(inst.transform.position || { x: 0, y: 0, z: 0 }) };
        pos[axis] = (Number(pos[axis]) || 0) + deltaInches;
        const obj = CaseScene.getObject(id);
        const originalWorld = obj ? obj.position.clone() : null;
        const candidateWorld = SceneManager.vecInchesToWorld(pos);
        if (rejectMoveCollision(id, candidateWorld, ignoreSet)) return;

        let finalPos = pos;
        if (obj) {
          obj.position.copy(candidateWorld);
          const settledY = CaseScene.settleY(id);
          if (settledY !== null) obj.position.y = settledY;
          if (rejectMoveCollision(id, obj.position, ignoreSet)) {
            if (originalWorld) obj.position.copy(originalWorld);
            return;
          }
          finalPos = SceneManager.vecWorldToInches(obj.position);
        }
        CaseScene.setCollision(id, false);
        patchById.set(id, { transform: { ...inst.transform, position: finalPos } });
      });
      if (patchById.size) {
        commitCasesWithManualRevalidation(packId, applyInstancePatches(pack, patchById));
      }
      CaseScene.applyOOGHighlights();
    }

    /**
     * Move the single selected packed case to an adjacent valid support level
     * ('up'/'down') or drop it onto the nearest valid surface ('drop'). All
     * validation runs through PackLibrary's hard-rule pipeline; the naive scene
     * gravity settle is bypassed so a validated raised placement is not pulled
     * back down on commit.
     */
    function moveSelectionVertical(mode) {
      if (prepareSceneMutation()) {
        showOperationsBusyToast();
        return;
      }
      // A live stroke owns the pose; the vertical move waits for its release.
      if (draggingId || gizmoDragging) return;
      if (gizmoPending) {
        if (mode === 'drop') {
          resolvePendingPose();
          return;
        }
        UIComponents.showToast('Place or cancel the held case first (Drop, Enter, or Esc).', 'info');
        return;
      }
      if (typeof PackLibrary.findManualVerticalPlacement !== 'function' ||
          typeof PackLibrary.updateCasesWithManualRevalidation !== 'function') {
        return;
      }
      const ids = getSelection();
      if (ids.length !== 1) {
        UIComponents.showToast('Select a single packed case to move it vertically.', 'info');
        return;
      }
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack) { return; }
      const inst = (pack.cases || []).find(i => i && i.id === ids[0]);
      if (!inst) { return; }
      const normalHandlingPack = buildNormalHandlingPack(pack, [inst.id]);
      const resolved = PackLibrary.findManualVerticalPlacement(
        normalHandlingPack,
        CaseLibrary.getCases(),
        inst.id,
        { mode, manualGeometry: true }
      );
      if (!resolved.ok) {
        const infoCodes = new Set(['already-resting', 'no-level-above', 'no-level-below']);
        UIComponents.showToast(
          resolved.reason || 'Cannot move this case vertically.',
          infoCodes.has(resolved.code) ? 'info' : 'error'
        );
        return;
      }
      const nextCases = (normalHandlingPack.cases || []).map(item =>
        item.id === inst.id
          ? { ...item, transform: { ...item.transform, position: resolved.position } }
          : item
      );
      const result = PackLibrary.updateCasesWithManualRevalidation(packId, nextCases, CaseLibrary.getCases(), {
        repairDependents: true,
        manualGeometry: true,
      });
      if (!result) {
        UIComponents.showToast('Vertical move failed. Please try again.', 'error');
        return;
      }
      // Toast from the actual committed outcome, not the predicted target:
      // dependent cascades can legally change where the moved case finally rests.
      const finalInst = ((result.pack && result.pack.cases) || []).find(i => i && i.id === inst.id);
      const finalY = finalInst && finalInst.transform && finalInst.transform.position
        ? Number(finalInst.transform.position.y)
        : null;
      const startY = Number(inst.transform.position && inst.transform.position.y) || 0;
      const stagedSelf = Array.isArray(result.stagedIds) && result.stagedIds.includes(inst.id);
      let tone = 'success';
      let base;
      if (stagedSelf) {
        tone = 'warning';
        base = 'The case could not rest safely and was moved to staging.';
      } else if (finalY !== null && Math.abs(finalY - startY) > 0.05) {
        base = mode === 'drop'
          ? 'Dropped case to the nearest valid surface.'
          : `Moved case ${mode === 'up' ? 'up' : 'down'} to the next valid level.`;
      } else {
        tone = 'info';
        base = 'Could not move the case safely; placement kept.';
      }
      UIComponents.showToast(formatVerticalMoveMessage(result, inst.id, base), tone);
    }

    /**
     * Keyboard shortcuts for selected cases (viewport focus, bare keys only).
     * R = rotate Y 90°, T = tip X 90°, E = roll Z 90°, F = flip (no auto-repeat)
     * Arrow keys = nudge X/Z 1" (Shift = 6" coarse step; auto-repeat allowed)
     * Alt+ArrowUp / Alt+ArrowDown = move to the next valid level up/down
     * Alt+Shift+ArrowDown = drop to the nearest valid surface
     * Enter = place a held (pending) case
     * Escape = cancel an active gizmo drag or a held case
     * Delete/Backspace = delete selection
     */
    function onKeyDown(ev) {
      if (UIComponents.modalOwnership?.blocksKeyboardEvent(ev)) return;
      // KeyboardManager consumes Escape while deselecting. Preserve the existing
      // continuation that releases an active drag/hold (including camera controls).
      // Modal-owned events above must never enter that continuation.
      if (ev.defaultPrevented && !(ev.key === 'Escape' && (gizmoDragging || gizmoPending))) return;
      if (!isEditorActive()) { return; }
      if (ev.key !== 'Escape' && ev.target !== domEl?.parentElement) return;
      // Don't intercept when typing in an input
      const tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return; }

      // Cargo keys are bare keys (Shift only picks the coarse step or Drop).
      // Cmd/Ctrl combinations, and Alt on letters or Left/Right, belong to the
      // browser/OS: no action and no preventDefault (Cmd/Ctrl+F is Find, not Flip).
      const transformKey = /^[rtef]$/i.test(ev.key);
      const arrowKey = /^Arrow(Left|Right|Up|Down)$/.test(ev.key);
      if ((transformKey || arrowKey) && (ev.metaKey || ev.ctrlKey)) return;
      if (ev.altKey && (transformKey || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) return;
      // Turn/Tip/Roll/Flip are discrete: auto-repeat is consumed, not applied.
      // Arrow nudges keep repeating for continuous positioning.
      if (transformKey && ev.repeat) {
        ev.preventDefault();
        return;
      }

      const halfPI = Math.PI / 2;
      const nudge = ev.shiftKey ? 6 : 1; // inches per press (Shift = coarse step)

      switch (ev.key) {
        case 'r':
        case 'R':
          rotateSelection('y', halfPI);
          ev.preventDefault();
          break;
        case 't':
        case 'T':
          rotateSelection('x', halfPI);
          ev.preventDefault();
          break;
        case 'e':
        case 'E':
          rotateSelection('z', halfPI);
          ev.preventDefault();
          break;
        case 'f':
        case 'F':
          rotateSelection('x', Math.PI);
          ev.preventDefault();
          break;
        case 'ArrowLeft':
          nudgeSelection('z', -nudge);
          ev.preventDefault();
          break;
        case 'ArrowRight':
          nudgeSelection('z', nudge);
          ev.preventDefault();
          break;
        case 'ArrowUp':
          if (ev.altKey) { moveSelectionVertical('up'); }
          else { nudgeSelection('x', nudge); }
          ev.preventDefault();
          break;
        case 'ArrowDown':
          if (ev.altKey) { moveSelectionVertical(ev.shiftKey ? 'drop' : 'down'); }
          else { nudgeSelection('x', -nudge); }
          ev.preventDefault();
          break;
        case 'Enter':
          if (resolvePendingPose()) {
            ev.preventDefault();
          }
          break;
        case 'Escape':
          if (gizmoDragging) {
            cancelGizmoDrag();
            ev.preventDefault();
          } else if (gizmoPending) {
            cancelPendingPose();
            ev.preventDefault();
          }
          break;
        case 'Delete':
        case 'Backspace':
          deleteSelection();
          ev.preventDefault();
          break;
        default:
          break;
      }
    }

    function hoverCursor() {
      if (hoveredId || drawingHover) return 'grab';
      return lineHover ? 'pointer' : 'default';
    }

    /**
     * The saved scene line (an Arrow's shaft or a Measurement's line or label) a plain primary pointer is on, or null. Selecting one is a click, never a press: nothing
     * here claims the pointer, so a drag that starts on the line is still the camera drag or the cargo drag it would have been. Shift,
     * Ctrl and Cmd are camera navigation, the other buttons orbit and pan, and a second finger is a pinch.
     */
    function savedLineAt(ev, { hover = false } = {}) {
      if (!ev || (!hover && ev.button !== 0) || ev.isPrimary === false || ev.shiftKey || ev.ctrlKey || ev.metaKey) return null;
      const arrow = AnnotationTool && typeof AnnotationTool.arrowHitAt === 'function' ? AnnotationTool.arrowHitAt(ev.clientX, ev.clientY, ev.pointerType) : null;
      const measurement = MeasurementTool && typeof MeasurementTool.lineHitAt === 'function' ? MeasurementTool.lineHitAt(ev.clientX, ev.clientY, ev.pointerType) : null;
      if (!arrow && !measurement) return null;
      // The nearer line wins where they cross (an Arrow on a tie: it is painted above).
      if (measurement && (!arrow || measurement.distance < arrow.distance)) {
        return { id: measurement.id, pointerId: ev.pointerId, select: () => MeasurementTool.select(measurement.id) };
      }
      return { id: arrow.id, pointerId: ev.pointerId, select: () => AnnotationTool.select(arrow.id) };
    }

    function onMove(ev) {
      if (!isEditorActive()) return;
      // Measurement Mode owns the pointer: no hover, drag or gizmo handling. OrbitControls is separate.
      if (MeasurementTool && MeasurementTool.isActive()) { MeasurementTool.onPointerMove(ev); return; }
      // The armed Annotations tool (Callout, Re-attach) owns the pointer the same way.
      if (AnnotationTool && AnnotationTool.isActive()) { AnnotationTool.onPointerMove(ev); return; }
      // A selected measurement's grip drag (no creation mode) is that tool's until the pointer lifts.
      if (MeasurementTool && typeof MeasurementTool.ownsPointer === 'function' && MeasurementTool.ownsPointer(ev)) return;
      // A press a saved Drawing's line took is that Drawing's until the pointer lifts: no cargo hover, drag or cursor meanwhile.
      if (AnnotationTool && typeof AnnotationTool.ownsPointer === 'function' && AnnotationTool.ownsPointer(ev)) return;
      updatePointer(ev);

      if (gizmoDragging && draggingId) {
        updateGizmoDrag();
        return;
      }

      if (pressed && !draggingId) {
        const dx = ev.clientX - pressed.clientX;
        const dy = ev.clientY - pressed.clientY;
        if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) startDrag();
      }

      if (draggingId) {
        updateDrag(ev);
        return;
      }

      // Throttle hover raycasts to avoid performance hits
      const now = performance.now();
      if (now - lastRaycastTime < RAYCAST_THROTTLE) return;
      lastRaycastTime = now;

      // A saved Drawing's line is ahead of cargo for a plain press, so it is ahead of it for hover too.
      const overDrawing = Boolean(AnnotationTool && typeof AnnotationTool.hoverDrawing === 'function' && AnnotationTool.hoverDrawing(ev));
      // So is a saved Arrow's shaft for a plain click (touch has no hover).
      const overLine = !overDrawing && ev.pointerType !== 'touch' && Boolean(savedLineAt(ev, { hover: true }));
      const hit = (overDrawing || overLine) ? null : raycastFirst();
      const nextHover = hit ? hit.instanceId : null;
      if (nextHover !== hoveredId || overDrawing !== drawingHover || overLine !== lineHover) {
        hoveredId = nextHover;
        drawingHover = overDrawing;
        lineHover = overLine;
        CaseScene.setHover(hoveredId);
        domEl.style.cursor = hoverCursor();
      }
    }

    function onDown(ev) {
      if (!isEditorActive()) return;
      // Programmatic focus can inherit :focus-visible from a keyboard-focused
      // control. Keep shortcut ownership while suppressing that inherited cue.
      domEl.parentElement?.classList.add('tp3d-pointer-focus');
      if (ev.button !== 0) return;
      domEl.parentElement?.focus({ preventScroll: true });
      // Measurement Mode owns primary presses: they never select, drag or grab a gizmo handle.
      if (MeasurementTool && MeasurementTool.isActive()) { MeasurementTool.onPointerDown(ev); return; }
      if (AnnotationTool && AnnotationTool.isActive()) { AnnotationTool.onPointerDown(ev); return; }
      // A saved Drawing's line takes a plain primary press ahead of the gizmo and of cargo. OrbitControls has read this press already (its
      // listener is on this canvas too and registered first), so returning here does not stop it: the tool holds the camera's rotation off
      // itself until the pointer lifts. Shift/Ctrl/Cmd, the other buttons and a second finger are never the Drawing's.
      if (AnnotationTool && typeof AnnotationTool.claimPress === 'function' && AnnotationTool.claimPress(ev)) return;
      updatePointer(ev);

      // V3A: gizmo handles take grab priority over case picking.
      if (beginGizmoDrag()) {
        domEl.setPointerCapture(ev.pointerId);
        domEl.style.cursor = 'grabbing';
        return;
      }

      const hit = raycastFirst();
      // Only remembered: a release that has not moved selects this line (see onUp); anything else is the ordinary press below.
      const line = savedLineAt(ev);

      if (hit) {
        const instanceId = hit.instanceId;
        pressed = {
          instanceId,
          pointWorld: hit.pointWorld.clone(),
          clientX: ev.clientX,
          clientY: ev.clientY,
          shift: Boolean(ev.shiftKey),
          line,
        };
        domEl.setPointerCapture(ev.pointerId);
        domEl.style.cursor = 'grabbing';
      } else {
        pressed = {
          instanceId: null,
          clientX: ev.clientX,
          clientY: ev.clientY,
          shift: Boolean(ev.shiftKey),
          line,
        };
      }
    }

    function onUp(ev) {
      if (!isEditorActive()) {
        // Departure never commits a provisional pose. Release the old gesture
        // so re-entry can synchronize and preview the committed Pack normally.
        if (pressed || draggingId) {
          gizmoDragging = false;
          gizmoAxis = null;
          CaseScene.setGizmoActive(false);
          resetDrag();
        }
        return;
      }
      if (MeasurementTool && MeasurementTool.isActive()) { if (ev) MeasurementTool.onPointerUp(ev); return; }
      if (AnnotationTool && AnnotationTool.isActive()) { if (ev) AnnotationTool.onPointerUp(ev); return; }
      if (!pressed && !draggingId) return;

      if (draggingId) {
        if (gizmoDragging) {
          finishGizmoDrag();
          return;
        }
        finishDrag();
        return;
      }

      // A click on a saved Arrow's shaft or Measurement line selects it ahead of the cargo or the empty ground under it. It must be the same pointer, released
      // without moving past the click threshold; selecting writes no history and clears the cargo selection (the tool's own rule).
      if (pressed.line && !pressed.shift && ev && ev.pointerId === pressed.line.pointerId &&
        Math.hypot(ev.clientX - pressed.clientX, ev.clientY - pressed.clientY) <= CLICK_DRAG_THRESHOLD_PX) {
        const line = pressed.line;
        pressed = null;
        lineHover = true;
        domEl.style.cursor = hoverCursor();
        line.select();
        return;
      }

      // Click selection
      if (!pressed.instanceId) {
        const dx = ev && Number.isFinite(ev.clientX) ? ev.clientX - pressed.clientX : 0;
        const dy = ev && Number.isFinite(ev.clientY) ? ev.clientY - pressed.clientY : 0;
        if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) {
          pressed = null;
          return;
        }
        if (!pressed.shift) setSelection([]);
        pressed = null;
        return;
      }
      const current = getSelection();
      const id = pressed.instanceId;
      if (pressed.shift) {
        if (current.includes(id)) setSelection(current.filter(x => x !== id));
        else setSelection([...current, id]);
      } else {
        setSelection([id]);
      }
      pressed = null;
    }

    function onCancel() {
      if (MeasurementTool && MeasurementTool.isActive()) { MeasurementTool.onPointerCancel(); return; }
      if (AnnotationTool && AnnotationTool.isActive()) { AnnotationTool.onPointerCancel(); return; }
      if (!pressed && !draggingId && !gizmoDragging) return;
      if (gizmoDragging) {
        cancelGizmoDrag();
      } else {
        const ids = Array.isArray(dragGroupIds) && dragGroupIds.length
          ? dragGroupIds : (draggingId ? [draggingId] : []);
        if (ids.length) { revertGroupToStart(ids, dragGroupStartWorld || new Map()); }
        resetDrag();
        CaseScene.refreshGizmo();
      }
      pressed = null;
    }

    /**
     * V3A vertical gizmo drag: grab priority over case picking. Returns true
     * when a visible gizmo handle was hit and a constrained vertical drag of
     * the gizmo's target case started.
     */
    function beginGizmoDrag() {
      if (OperationLifecycle && OperationLifecycle.isBusy()) return false;
      const camera = SceneManager.getCamera();
      const handles = CaseScene.getGizmoHandleMeshes();
      if (!camera || !handles.length) return false;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(handles, false);
      if (!hits.length) return false;
      if (prepareSceneMutation()) {
        if (scenePreviewOnly()) showOperationsBusyToast();
        return false;
      }
      const targetId = CaseScene.getGizmoTargetId();
      const obj = targetId ? CaseScene.getObject(targetId) : null;
      if (!obj) return false;
      gizmoDragging = true;
      gizmoAxis = hits[0].object && hits[0].object.userData && hits[0].object.userData.gizmoHandle
        ? hits[0].object.userData.gizmoHandle
        : 'y';
      draggingId = targetId;
      dragStartPosWorld = obj.position.clone();
      dragGroupIds = [targetId];
      dragGroupStartWorld = new Map([[targetId, obj.position.clone()]]);
      dragOffset.copy(obj.position).sub(hits[0].point);
      // Horizontal plane at the case's current height: X/Z strokes carry the
      // case at its lifted height; the Y stroke uses the Alt-drag vertical plane.
      dragPlane.set(new THREE.Vector3(0, 1, 0), -obj.position.y);
      const controls = SceneManager.getControls();
      if (controls) controls.enabled = false;
      CaseScene.setDragging(targetId);
      CaseScene.setGizmoActive(gizmoAxis);
      return true;
    }

    function updateGizmoDrag() {
      if (gizmoAxis === 'x' || gizmoAxis === 'z') {
        updateGizmoAxisDrag();
      } else {
        // Reuse the Alt-drag vertical-plane math (and its V2B release-outcome
        // preview) verbatim: the Y handle is a visible way to start that drag.
        updateDrag({ altKey: true });
      }
      CaseScene.updateGizmoTransform();
    }

    /**
     * X/Z handle stroke: intersect the horizontal plane at the case's current
     * height and move along the grabbed axis only, keeping the lifted Y so a
     * raised case can be carried sideways over other cargo.
     */
    function updateGizmoAxisDrag() {
      const camera = SceneManager.getCamera();
      const obj = draggingId ? CaseScene.getObject(draggingId) : null;
      if (!camera || !obj) return;
      raycaster.setFromCamera(pointer, camera);
      const intersection = tmpVec3;
      if (!raycaster.ray.intersectPlane(dragPlane, intersection)) return;
      const next = intersection.clone().add(dragOffset);
      const half = obj.userData && obj.userData.halfWorld ? obj.userData.halfWorld.y : 0.01;
      const candidate = new THREE.Vector3(
        gizmoAxis === 'x' ? next.x : dragStartPosWorld.x,
        Math.max(half || 0.01, dragStartPosWorld.y),
        gizmoAxis === 'z' ? next.z : dragStartPosWorld.z
      );
      if (typeof CaseScene.getSurfaceFollowingPreview === 'function') {
        const preview = CaseScene.getSurfaceFollowingPreview(draggingId, candidate);
        if (preview && preview.ok && Number.isFinite(preview.centerY)) {
          candidate.y = Math.max(half || 0.01, preview.centerY);
        }
      }
      const check = CaseScene.checkCollision(draggingId, candidate, new Set([draggingId]));
      CaseScene.setCollision(draggingId, check.collides);
      obj.position.copy(candidate);
    }

    function finishGizmoDrag() {
      const axis = gizmoAxis;
      gizmoDragging = false;
      gizmoAxis = null;
      CaseScene.setGizmoActive(false);
      const instanceId = draggingId;
      const obj = instanceId ? CaseScene.getObject(instanceId) : null;
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      if (!obj || !pack) {
        finishDrag();
        CaseScene.refreshGizmo();
        return;
      }
      const inst = (pack.cases || []).find(item => item && item.id === instanceId);
      const stagedGizmo = CaseScene.getGizmoTargetMode && CaseScene.getGizmoTargetMode() === 'staged';
      if (stagedGizmo || (inst && inst.placement === 'staged')) {
        if (axis === 'y') {
          const half = obj.userData && obj.userData.halfWorld ? obj.userData.halfWorld.y : 0.01;
          const floorCenterY = Math.max(half || 0.01, 0.01);
          obj.position.y = floorCenterY;
          UIComponents.showToast(
            'Staged vertical stacking is not supported yet. Use X/Z handles or normal drag to reposition on the staging floor.',
            'info'
          );
        }
        // Staged gizmo strokes reuse the same legacy release path as normal
        // staged drag. Do not call the packed vertical resolver: it intentionally
        // returns staged-case for staged ids.
        finishDrag();
        CaseScene.refreshGizmo();
        return;
      }
      if (typeof PackLibrary.findManualVerticalPlacement !== 'function') {
        finishDrag();
        CaseScene.refreshGizmo();
        return;
      }
      const resolved = PackLibrary.findManualVerticalPlacement(pack, CaseLibrary.getCases(), instanceId, {
        mode: 'resolve',
        desiredPosition: SceneManager.vecWorldToInches(obj.position),
        manualGeometry: true,
      });
      if (resolved.ok && resolved.corrected !== true) {
        // Directly valid: commit now through the shared validated release.
        gizmoPending = null;
        finishDrag();
        CaseScene.refreshGizmo();
        return;
      }
      if (!resolved.ok && (resolved.code === 'outside-truck' || resolved.code === 'invalid-selection')) {
        // Deliberate move out of the truck (or degenerate data) keeps the
        // legacy staging release; re-derive the hold if that release reverted.
        gizmoPending = null;
        finishDrag();
        if (!scenePoseMatchesPack(instanceId)) {
          gizmoPending = { instanceId };
          CaseScene.setDragging(instanceId);
        }
        CaseScene.refreshGizmo();
        return;
      }
      // Not directly valid: hold a scene-only pending pose so the user can keep
      // adjusting (lift → carry → drop). The pack keeps the committed pose, so
      // stats and exports stay truthful; the hold is never persisted.
      const firstHold = !gizmoPending;
      gizmoPending = { instanceId };
      resetDrag();
      CaseScene.setDragging(instanceId);
      CaseScene.setCollision(instanceId, !resolved.ok);
      if (firstHold) {
        UIComponents.showToast(
          `Case held above the load. Drop, Enter, or ${altKeyHintLabel()}+Shift+↓ places it; Esc cancels.`,
          'info'
        );
      }
      CaseScene.refreshGizmo();
    }

    function cancelGizmoDrag() {
      if (!gizmoDragging) return;
      gizmoDragging = false;
      gizmoAxis = null;
      CaseScene.setGizmoActive(false);
      const groupIds = Array.isArray(dragGroupIds) && dragGroupIds.length
        ? dragGroupIds
        : (draggingId ? [draggingId] : []);
      const startMap = dragGroupStartWorld || new Map();
      revertGroupToStart(groupIds, startMap);
      resetDrag();
      // A cancelled stroke returns to the stroke start; if that start was a
      // held pose, the hold (and its temporary look) remains.
      if (gizmoPending) CaseScene.setDragging(gizmoPending.instanceId);
      CaseScene.refreshGizmo();
    }

    function scenePoseMatchesPack(instanceId) {
      const obj = CaseScene.getObject(instanceId);
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      const inst = pack ? (pack.cases || []).find(i => i && i.id === instanceId) : null;
      if (!obj || !inst || !inst.transform || !inst.transform.position) return true;
      return obj.position.distanceTo(SceneManager.vecInchesToWorld(inst.transform.position)) <= 0.01;
    }

    /**
     * Commit a held (pending) pose through the same validated pipeline as every
     * other manual move. Returns true when a hold existed (whatever the outcome).
     */
    function resolvePendingPose() {
      if (!gizmoPending) return false;
      if (operationsBusy()) return true; // the busy sync will release the hold
      const instanceId = gizmoPending.instanceId;
      const obj = CaseScene.getObject(instanceId);
      const packId = StateStore.get('currentPackId');
      const pack = packId ? PackLibrary.getById(packId) : null;
      if (!obj || !pack ||
          typeof PackLibrary.findManualVerticalPlacement !== 'function' ||
          typeof PackLibrary.updateCasesWithManualRevalidation !== 'function') {
        cancelPendingPose();
        return true;
      }
      const normalHandlingPack = buildNormalHandlingPack(pack, [instanceId]);
      const resolved = PackLibrary.findManualVerticalPlacement(normalHandlingPack, CaseLibrary.getCases(), instanceId, {
        mode: 'resolve',
        desiredPosition: SceneManager.vecWorldToInches(obj.position),
        manualGeometry: true,
      });
      if (!resolved.ok && resolved.code === 'outside-truck') {
        // The hold was carried out of the truck: reuse the legacy drag release
        // so it stages honestly, and keep holding if that release reverted.
        gizmoPending = null;
        draggingId = instanceId;
        dragStartPosWorld = obj.position.clone();
        dragGroupIds = [instanceId];
        dragGroupStartWorld = new Map([[instanceId, obj.position.clone()]]);
        finishDrag();
        if (!scenePoseMatchesPack(instanceId)) {
          gizmoPending = { instanceId };
          CaseScene.setDragging(instanceId);
        }
        CaseScene.refreshGizmo();
        return true;
      }
      if (!resolved.ok) {
        // Keep holding; the user can adjust further or press Esc to cancel.
        UIComponents.showToast(resolved.reason || 'Cannot place the held case here.', 'error');
        return true;
      }
      gizmoPending = null;
      obj.position.copy(SceneManager.vecInchesToWorld(resolved.position));
      CaseScene.setDragging(null);
      CaseScene.setCollision(instanceId, false);
      const nextCases = (normalHandlingPack.cases || []).map(item =>
        item.id === instanceId
          ? { ...item, transform: { ...item.transform, position: resolved.position }, placement: 'packed' }
          : item
      );
      const result = PackLibrary.updateCasesWithManualRevalidation(packId, nextCases, CaseLibrary.getCases(), {
        repairDependents: true,
        manualGeometry: true,
      });
      const stagedSelf = result && Array.isArray(result.stagedIds) && result.stagedIds.includes(instanceId);
      let tone = resolved.corrected ? 'info' : 'success';
      let base = resolved.corrected ? 'Adjusted to the nearest supported level.' : 'Case placed.';
      if (stagedSelf) {
        tone = 'warning';
        base = 'The case could not rest safely and was moved to staging.';
      }
      UIComponents.showToast(result ? formatVerticalMoveMessage(result, instanceId, base) : base, tone);
      CaseScene.refreshGizmo();
      return true;
    }

    function cancelPendingPose() {
      if (!gizmoPending) return;
      const instanceId = gizmoPending.instanceId;
      gizmoPending = null;
      CaseScene.setDragging(null);
      CaseScene.setCollision(instanceId, false);
      // Restore every scene pose from the committed pack state.
      CaseScene.sync(PackLibrary.getById(StateStore.get('currentPackId')));
      UIComponents.showToast('Move cancelled — case returned to its last placement.', 'info');
    }

    // Any pack-level sync while holding means committed transforms were just
    // re-applied to the scene (AutoPack, deletes, overlay actions…): release
    // the hold instead of tracking a pose the scene no longer shows.
    function onScenePendingInvalidated() {
      if (!gizmoPending) return;
      const instanceId = gizmoPending.instanceId;
      gizmoPending = null;
      CaseScene.setDragging(null);
      CaseScene.setCollision(instanceId, false);
      UIComponents.showToast('Held case returned to its last placement.', 'info');
    }

    function onDblClick(ev) {
      // A double-click in Measurement Mode neither places a zero-length measurement nor focuses the camera.
      if (MeasurementTool && MeasurementTool.onDoubleClick(ev)) return;
      if (AnnotationTool && AnnotationTool.onDoubleClick(ev)) return;
      // Both clicks must originate in this Pack's viewport. The second click
      // used to open a Load Plan must not focus cargo exposed beneath the card.
      if (!isEditorActive() || focusClickPackId !== StateStore.get('currentPackId')) return;
      focusClickPackId = null;
      updatePointer(ev);
      const hit = raycastFirst();
      if (!hit) return;
      SceneManager.focusOnWorldPoint(hit.pointWorld, { duration: 700 });
    }

    function canSurfaceFollowNormalDrag(instanceId, groupIds) {
      if (!instanceId || !Array.isArray(groupIds) || !groupIds.length || !groupIds.includes(instanceId)) {
        return false;
      }
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      if (!pack) return false;
      const packIds = new Set((pack.cases || []).filter(Boolean).map(inst => inst.id));
      return groupIds.every(id => packIds.has(id));
    }

    function applyDragCandidates(groupIds, candidates, ignoreSet, options = {}) {
      // Preserve the existing single-case preview path exactly. Single-case
      // surface-following is allowed to show its candidate and resolve on drop.
      if (groupIds.length === 1) {
        const id = groupIds[0];
        const obj = CaseScene.getObject(id);
        const candidate = candidates.get(id);
        if (!obj || !candidate) return false;
        const check = CaseScene.checkCollision(id, candidate, ignoreSet);
        obj.position.copy(candidate);
        CaseScene.setCollision(id, check.collides);
        return check.collides;
      }

      let blocked = false;
      for (const id of groupIds) {
        const obj = CaseScene.getObject(id);
        const candidate = candidates.get(id);
        if (!obj || !candidate) {
          blocked = true;
          break;
        }
        const accepted = dragGroupAcceptedWorld && dragGroupAcceptedWorld.get(id)
          ? dragGroupAcceptedWorld.get(id)
          : obj.position;
        const check = options.sweep !== false && typeof CaseScene.checkSweptCollision === 'function'
          ? CaseScene.checkSweptCollision(id, accepted, candidate, ignoreSet)
          : CaseScene.checkCollision(id, candidate, ignoreSet);
        if (check.collides) {
          blocked = true;
          break;
        }
      }

      // Atomic live preview: either every selected case advances to the same
      // rigid candidate delta or none of them moves from the last accepted pose.
      if (!blocked) {
        groupIds.forEach(id => {
          const obj = CaseScene.getObject(id);
          const candidate = candidates.get(id);
          if (!obj || !candidate) return;
          obj.position.copy(candidate);
          if (dragGroupAcceptedWorld) dragGroupAcceptedWorld.set(id, candidate.clone());
        });
      }
      dragGroupPreviewBlocked = blocked;
      groupIds.forEach(id => CaseScene.setCollision(id, blocked));
      return blocked;
    }

    function startDrag() {
      if (!pressed || !pressed.instanceId) return;
      // Do not begin moving a case while a mutating operation owns the editor. Click
      // selection (handled in onUp) still works; camera orbit is unaffected.
      if (prepareSceneMutation()) {
        if (scenePreviewOnly()) {
          showOperationsBusyToast();
          pressed = null; // Refuse this gesture once, without ending the preview.
        }
        return;
      }
      if (gizmoPending) cancelPendingPose();
      draggingId = pressed.instanceId;
      dragStartPosWorld = CaseScene.getObject(draggingId).position.clone();

      // Ensure selected
      const current = getSelection();
      if (!current.includes(draggingId)) {
        if (pressed.shift) setSelection([...current, draggingId]);
        else setSelection([draggingId]);
      }

      const controls = SceneManager.getControls();
      if (controls) controls.enabled = false;

      // Group drag: if multiple selected, move them as a unit.
      // We record world positions at drag-start and apply the same delta to each.
      const selection = getSelection();
      dragGroupIds = selection && selection.length ? selection.slice() : [draggingId];
      dragGroupStartWorld = new Map();
      dragGroupAcceptedWorld = new Map();
      dragGroupIds.forEach(id => {
        const o = CaseScene.getObject(id);
        if (o) {
          dragGroupStartWorld.set(id, o.position.clone());
          dragGroupAcceptedWorld.set(id, o.position.clone());
        }
      });
      dragGroupPreviewBlocked = false;
      surfaceFollowingDrag = canSurfaceFollowNormalDrag(draggingId, dragGroupIds);

      dragPlane.set(new THREE.Vector3(0, 1, 0), -dragStartPosWorld.y);
      dragOffset.copy(CaseScene.getObject(draggingId).position).sub(pressed.pointWorld);

      CaseScene.setDragging(draggingId);
    }

    function updateDrag(ev) {
      const camera = SceneManager.getCamera();
      if (!camera) return;
      raycaster.setFromCamera(pointer, camera);

      const obj = CaseScene.getObject(draggingId);
      if (!obj) return;

      const groupIds = Array.isArray(dragGroupIds) && dragGroupIds.length ? dragGroupIds : [draggingId];
      const ignoreSet = new Set(groupIds);
      const startMap = dragGroupStartWorld || new Map([[draggingId, dragStartPosWorld]]);

      // Alt/Option key: vertical (Y-axis) drag mode
      const altKey = ev && ev.altKey;
      if (altKey) {
        surfaceFollowingDrag = false;
        // Use a plane facing the camera for vertical movement
        const camDir = camera.getWorldDirection(new THREE.Vector3());
        const vertPlaneNormal = new THREE.Vector3(camDir.x, 0, camDir.z).normalize();
        if (vertPlaneNormal.length() < 0.01) vertPlaneNormal.set(0, 0, 1);
        const vertPlane = new THREE.Plane();
        vertPlane.setFromNormalAndCoplanarPoint(vertPlaneNormal, obj.position);
        const intersection = tmpVec3;
        const ok = raycaster.ray.intersectPlane(vertPlane, intersection);
        if (!ok) return;
        const nextY = intersection.y + dragOffset.y;

        const start = startMap.get(draggingId) || obj.position;
        const deltaY = nextY - start.y;

        let groupDeltaY = deltaY;
        if (groupIds.length > 1) {
          groupIds.forEach(id => {
            const o = CaseScene.getObject(id);
            const s = startMap.get(id);
            if (!o || !s) return;
            const half = o.userData && o.userData.halfWorld ? o.userData.halfWorld.y : 0.01;
            groupDeltaY = Math.max(groupDeltaY, half - s.y);
          });
        }
        const candidates = new Map();
        groupIds.forEach(id => {
          const o = CaseScene.getObject(id);
          const s = startMap.get(id);
          if (!o || !s) return;
          const half = o.userData && o.userData.halfWorld ? o.userData.halfWorld.y : 0;
          const candidateY = groupIds.length > 1
            ? s.y + groupDeltaY
            : Math.max(half || 0.01, s.y + deltaY);
          candidates.set(id, new THREE.Vector3(s.x, candidateY, s.z));
        });
        const anyCollides = applyDragCandidates(groupIds, candidates, ignoreSet);

        // V2B release-outcome preview (single packed case only): highlight red
        // when the validated release would reject this spot outright. A spot
        // that merely corrects to a nearby legal level stays neutral, and
        // staging-bound positions are never flagged.
        if (groupIds.length === 1 && !anyCollides &&
            typeof PackLibrary.findManualVerticalPlacement === 'function') {
          const now = performance.now();
          if (now - lastDragPreviewTime >= DRAG_PREVIEW_THROTTLE_MS) {
            lastDragPreviewTime = now;
            const previewPack = PackLibrary.getById(StateStore.get('currentPackId'));
            const previewInst = previewPack
              ? (previewPack.cases || []).find(i => i && i.id === draggingId)
              : null;
            if (previewInst && previewInst.placement !== 'staged') {
              const resolved = PackLibrary.findManualVerticalPlacement(
                previewPack,
                CaseLibrary.getCases(),
                draggingId,
                { mode: 'resolve', desiredPosition: SceneManager.vecWorldToInches(obj.position), manualGeometry: true }
              );
              CaseScene.setCollision(draggingId, !resolved.ok && resolved.code !== 'outside-truck');
            }
          }
        }
        CaseScene.updateGizmoTransform();
        return;
      }

      const intersection = tmpVec3;
      const ok = raycaster.ray.intersectPlane(dragPlane, intersection);
      if (!ok) return;

      const next = intersection.clone().add(dragOffset);
      // Clamp Y to floor
      const halfYW = obj.userData && obj.userData.halfWorld ? obj.userData.halfWorld.y : 0.01;
      next.y = Math.max(halfYW, next.y);

      // Snap (X/Z) when enabled
      const prefs = PreferencesManager.get();
      if (prefs.snapping && prefs.snapping.enabled) {
        const gridIn = Math.max(0.25, Number(prefs.snapping.gridSize) || 1);
        const gridW = SceneManager.toWorld(gridIn);
        next.x = Math.round(next.x / gridW) * gridW;
        next.z = Math.round(next.z / gridW) * gridW;
      }

      const start = startMap.get(draggingId) || dragStartPosWorld;
      const deltaX = next.x - start.x;
      const deltaZ = next.z - start.z;

      let rigidGroupDeltaY = 0;
      if (groupIds.length > 1 && surfaceFollowingDrag &&
          typeof CaseScene.getRigidGroupSurfaceFollowingPreview === 'function') {
        const acceptedStart = startMap.get(draggingId);
        const acceptedPosition = dragGroupAcceptedWorld && dragGroupAcceptedWorld.get(draggingId);
        const fromDeltaX = acceptedStart && acceptedPosition ? acceptedPosition.x - acceptedStart.x : 0;
        const fromDeltaZ = acceptedStart && acceptedPosition ? acceptedPosition.z - acceptedStart.z : 0;
        const groupPreview = CaseScene.getRigidGroupSurfaceFollowingPreview(
          groupIds,
          startMap,
          deltaX,
          deltaZ,
          fromDeltaX,
          fromDeltaZ
        );
        if (groupPreview && groupPreview.ok && Number.isFinite(groupPreview.deltaY)) {
          rigidGroupDeltaY = groupPreview.deltaY;
        }
      }

      const candidates = new Map();
      groupIds.forEach(id => {
        const o = CaseScene.getObject(id);
        const s = startMap.get(id);
        if (!o || !s) return;
        const half = o.userData && o.userData.halfWorld ? o.userData.halfWorld.y : 0.01;
        const candidate = new THREE.Vector3(
          s.x + deltaX,
          groupIds.length > 1 ? s.y + rigidGroupDeltaY : Math.max(half, s.y),
          s.z + deltaZ
        );
        if (surfaceFollowingDrag && id === draggingId &&
            typeof CaseScene.getSurfaceFollowingPreview === 'function') {
          const preview = CaseScene.getSurfaceFollowingPreview(id, candidate);
          if (preview && preview.ok && Number.isFinite(preview.centerY)) {
            candidate.y = Math.max(half, preview.centerY);
          }
        }
        candidates.set(id, candidate);
      });
      applyDragCandidates(groupIds, candidates, ignoreSet, {
        // Normal rigid-group movement already lifts onto the highest terrain
        // needed by any selected footprint. Validate the rendered endpoint so
        // ordinary box/well/deck tops do not become impassable side walls.
        sweep: !(groupIds.length > 1 && surfaceFollowingDrag),
      });
      CaseScene.updateGizmoTransform();
    }

    /**
     * Tween (or snap) a drag group's objects back to their pre-drag world
     * positions, clearing collision/drag highlight state once settled.
     */
    function revertGroupToStart(groupIds, startMap) {
      const Tween = window.TWEEN || null;
      groupIds.forEach(id => {
        const o = CaseScene.getObject(id);
        const s = startMap.get(id);
        if (!o || !s) return;
        if (Tween) {
          new Tween.Tween(o.position)
            .to({ x: s.x, y: s.y, z: s.z }, 240)
            .easing(Tween.Easing.Cubic.Out)
            .onUpdate(() => CaseScene.updateGizmoTransform())
            .onComplete(() => CaseScene.updateGizmoTransform())
            .start();
        } else {
          o.position.copy(s);
          CaseScene.updateGizmoTransform();
        }
        CaseScene.setCollision(id, false);
      });

      if (Tween) {
        // Ensure hover/drag visuals restore once the tweens complete.
        revertHolds += 1;
        window.setTimeout(() => {
          revertHolds = Math.max(0, revertHolds - 1);
          CaseScene.setDragging(null);
          CaseScene.setHover(hoveredId);
          CaseScene.updateGizmoTransform();
        }, 260);
      } else {
        CaseScene.setDragging(null);
        CaseScene.setHover(hoveredId);
        CaseScene.updateGizmoTransform();
      }
    }

    function finishDrag() {
      const instanceId = draggingId;
      const obj = CaseScene.getObject(instanceId);
      if (!obj) {
        resetDrag();
        return;
      }
      // Defensive: if an operation claimed the editor mid-drag, do not commit the
      // moved transform — restore the scene from committed state and drop the drag.
      if (operationsBusy()) {
        resetDrag();
        CaseScene.sync(PackLibrary.getById(StateStore.get('currentPackId')));
        return;
      }

      const groupIds = Array.isArray(dragGroupIds) && dragGroupIds.length ? dragGroupIds : [instanceId];
      const ignoreSet = new Set(groupIds);
      const startMap = dragGroupStartWorld || new Map([[instanceId, dragStartPosWorld]]);

      if (groupIds.length > 1 && dragGroupPreviewBlocked) {
        revertGroupToStart(groupIds, startMap);
        UIComponents.showToast('A Case or blocked truck area is in the way.', 'error');
        resetDrag();
        return;
      }

      // Snap to nearest box edge or truck wall before final placement
      const prefs = PreferencesManager.get();
      if (prefs.snapping && prefs.snapping.enabled) {
        const snap = CaseScene.snapToNearest(instanceId, obj.position);
        if (snap) {
          const start = startMap.get(instanceId) || dragStartPosWorld;
          const deltaX = snap.x - start.x;
          const deltaZ = snap.z - start.z;
          groupIds.forEach(id => {
            const o = CaseScene.getObject(id);
            const s = startMap.get(id);
            if (!o || !s) return;
            o.position.x = s.x + deltaX;
            o.position.z = s.z + deltaZ;
          });
        }
      }

      let anyCollides = false;
      let anyInsideTruck = false;
      groupIds.forEach(id => {
        const o = CaseScene.getObject(id);
        if (!o) return;
        const check = CaseScene.checkCollision(id, o.position, ignoreSet);
        anyCollides = anyCollides || check.collides;
        anyInsideTruck = anyInsideTruck || check.insideTruck;
        CaseScene.setCollision(id, check.collides);
      });

      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack) {
        resetDrag();
        return;
      }
      const singleDraggedInst = groupIds.length === 1
        ? (pack.cases || []).find(i => i && i.id === instanceId)
        : null;
      // Staged truck releases use committed Pack geometry. A stale staged
      // mesh may be in the scene at this spot, but it is not packed cargo.
      if (singleDraggedInst && singleDraggedInst.placement === 'staged' &&
          tryCommitStagedIntoTruck(packId, pack, singleDraggedInst, obj, groupIds, startMap)) {
        CaseScene.refreshGizmo();
        return;
      }

      // A rigid group releases through the canonical atomic preflight below,
      // which owns the production overlap tolerance. Do not let this raw scene
      // check reject a near-flush group before that tolerant validator runs.
      // True group overlaps are still rejected atomically and reverted.
      if (anyCollides && groupIds.length === 1) {
        revertGroupToStart(groupIds, startMap);
        UIComponents.showToast('Cannot place here: collision detected', 'error');
        resetDrag();
        return;
      }

      // V2B: a single packed case releases through the validated placement
      // resolver so an Alt-drag raised position is honored when legal, corrected
      // to the nearest legal level when not, and never silently settled onto
      // cargo that cannot carry it. A single staged case gets one preflight
      // chance to become packed below. Multi-select uses the atomic group
      // preflight below; single out-of-truck releases keep the legacy path.
      if (singleDraggedInst && singleDraggedInst.placement !== 'staged' &&
          typeof PackLibrary.findManualVerticalPlacement === 'function' &&
          typeof PackLibrary.updateCasesWithManualRevalidation === 'function') {
        const normalHandlingPack = buildNormalHandlingPack(pack, [instanceId]);
        const resolved = PackLibrary.findManualVerticalPlacement(normalHandlingPack, CaseLibrary.getCases(), instanceId, {
          mode: 'resolve',
          desiredPosition: SceneManager.vecWorldToInches(obj.position),
          manualGeometry: true,
          rejectProposedCollisions: true,
        });
        if (resolved.ok) {
          obj.position.copy(SceneManager.vecInchesToWorld(resolved.position));
          CaseScene.setCollision(instanceId, false);
          const nextCases = (normalHandlingPack.cases || []).map(item =>
            item.id === instanceId
              ? { ...item, transform: { ...(item.transform || {}), position: resolved.position }, placement: 'packed' }
              : item
          );
          const result = PackLibrary.updateCasesWithManualRevalidation(packId, nextCases, CaseLibrary.getCases(), {
            repairDependents: true,
            manualGeometry: true,
          });
          const stagedSelf = result && Array.isArray(result.stagedIds) && result.stagedIds.includes(instanceId);
          let tone = resolved.corrected ? 'info' : 'success';
          let base = resolved.corrected ? 'Adjusted to the nearest supported level.' : 'Placed 1 case.';
          if (stagedSelf) {
            tone = 'warning';
            base = 'The case could not rest safely and was moved to staging.';
          }
          UIComponents.showToast(result ? formatVerticalMoveMessage(result, instanceId, base) : base, tone);
          resetDrag();
          CaseScene.applyOOGHighlights();
          return;
        }
        // Deliberate out-of-truck moves and degenerate references keep the
        // legacy settle/staging path; physical rule blocks revert honestly.
        if (resolved.code !== 'outside-truck' && resolved.code !== 'invalid-selection') {
          if (surfaceFollowingDrag) {
            const firstHold = !gizmoPending;
            gizmoPending = { instanceId };
            resetDrag();
            CaseScene.setDragging(instanceId);
            CaseScene.setCollision(instanceId, true);
            if (firstHold) {
              UIComponents.showToast(
                resolved.reason || 'Cannot place here yet. Move or Drop to resolve this held case.',
                'error'
              );
            }
            CaseScene.refreshGizmo();
            return;
          }
          revertGroupToStart(groupIds, startMap);
          UIComponents.showToast(resolved.reason || 'Cannot place here.', 'error');
          resetDrag();
          return;
        }
      }
      if (groupIds.length > 1 && tryCommitAtomicManualGroup(packId, pack, groupIds, startMap)) {
        return;
      }

      // Legacy single-case gravity for out-of-truck/staged release handling.
      const sortable = groupIds
        .map(id => ({ id, obj: CaseScene.getObject(id) }))
        .filter(x => x.obj)
        .sort((a, b) => a.obj.position.y - b.obj.position.y);

      sortable.forEach(({ id, obj: o }) => {
        const settledY = CaseScene.settleY(id);
        if (settledY !== null) o.position.y = settledY;
      });

      let settledCollides = false;
      anyInsideTruck = false;
      groupIds.forEach(id => {
        const o = CaseScene.getObject(id);
        if (!o) return;
        const check = CaseScene.checkCollision(id, o.position, ignoreSet);
        settledCollides = settledCollides || check.collides;
        anyInsideTruck = anyInsideTruck || check.insideTruck;
        CaseScene.setCollision(id, check.collides);
      });

      if (settledCollides) {
        revertGroupToStart(groupIds, startMap);
        UIComponents.showToast('Cannot place here: collision detected', 'error');
        resetDrag();
        return;
      }

      // IMPORTANT: Update the pack in one shot.
      // Calling PackLibrary.updateInstance() in a loop triggers a render/sync each time,
      // which can reset the other selected objects back to their old positions mid-drop.
      const nextPositions = new Map();
      groupIds.forEach(id => {
        const o = CaseScene.getObject(id);
        if (!o) return;
        const posInches = SceneManager.vecWorldToInches(o.position);
        const halfYWorld = o.userData && o.userData.halfWorld ? o.userData.halfWorld.y : 0;
        const halfYInches = halfYWorld > 0 ? SceneManager.toInches(halfYWorld) : 1;
        posInches.y = Math.max(halfYInches, posInches.y);
        nextPositions.set(id, posInches);
      });

      const zonesInches = PackLibrary.getTrailerUsableZones(pack.truck);
      const placementById = new Map();
      groupIds.forEach(id => {
        const pos = nextPositions.get(id);
        if (!pos) return;
        const inst = (pack.cases || []).find(i => i.id === id);
        if (!inst) return;
        const c = CaseLibrary.getById(inst.caseId);
        // Unresolved Cases or unsupported actual rotations supply no geometry.
        const dims = getActualPoseDimensions(c, inst).value;
        if (!dims) return;
        const half = { x: dims.length / 2, y: dims.height / 2, z: dims.width / 2 };
        const aabb = {
          min: { x: pos.x - half.x, y: pos.y - half.y, z: pos.z - half.z },
          max: { x: pos.x + half.x, y: pos.y + half.y, z: pos.z + half.z },
        };
        placementById.set(id, PackLibrary.isAabbContainedInAnyZone(aabb, zonesInches) ? 'packed' : 'staged');
      });

      const nextCases = (pack.cases || []).map(inst => {
        const pos = nextPositions.get(inst.id);
        if (!pos) return inst;
        const placementValue = placementById.get(inst.id) || 'staged';
        let finalPos = pos;
        if (singleDraggedInst && singleDraggedInst.id === inst.id &&
            singleDraggedInst.placement === 'staged' && placementValue === 'staged') {
          const dims = getInstanceDimsInches(inst);
          const halfY = dims && Number.isFinite(Number(dims.height)) ? Number(dims.height) / 2 : pos.y;
          finalPos = { ...pos, y: Math.max(0, halfY) };
        }
        return withoutPackedProfile({
          ...inst,
          transform: { ...(inst.transform || {}), position: finalPos },
          placement: placementValue,
        });
      });
      commitCasesWithManualRevalidation(packId, nextCases);

      UIComponents.showToast(
        anyInsideTruck ? `Placed ${groupIds.length} case(s)` : `Placed ${groupIds.length} case(s) in staging`,
        anyInsideTruck ? 'success' : 'info'
      );
      resetDrag();
      CaseScene.applyOOGHighlights();
    }

    function resetDrag() {
      const controls = SceneManager.getControls();
      if (controls) controls.enabled = true;
      draggingId = null;
      dragStartPosWorld = null;
      dragGroupIds = null;
      dragGroupStartWorld = null;
      dragGroupAcceptedWorld = null;
      dragGroupPreviewBlocked = false;
      surfaceFollowingDrag = false;
      pressed = null;
      domEl.style.cursor = hoverCursor();
      CaseScene.setDragging(null);
    }

    function updatePointer(ev) {
      if (!domEl) return;
      const rect = domEl.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function raycastFirst() {
      const camera = SceneManager.getCamera();
      if (!camera) return null;
      raycaster.setFromCamera(pointer, camera);
      const meshes = CaseScene.getRaycastMeshes();
      const hits = raycaster.intersectObjects(meshes, false);
      if (!hits.length) return null;
      const hit = hits[0];
      const instanceId = hit.object && hit.object.userData ? hit.object.userData.instanceId : null;
      if (!instanceId) return null;
      return { instanceId, pointWorld: hit.point.clone() };
    }

    function isEditorActive() {
      return StateStore.get('currentScreen') === 'editor';
    }

    function getSelection() {
      return StateStore.get('selectedInstanceIds') || [];
    }

    function setSelection(nextIds) {
      const ids = Array.isArray(nextIds) ? nextIds : [];
      // Changing the selection away from a held case abandons the hold safely.
      if (gizmoPending && (ids.length !== 1 || ids[0] !== gizmoPending.instanceId)) {
        cancelPendingPose();
      }
      StateStore.set({ selectedInstanceIds: ids }, { skipHistory: true });
      CaseScene.setSelected(ids);
    }

    function selectAllInPack() {
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      if (!pack) return;
      setSelection((pack.cases || []).map(i => i.id));
      UIComponents.showToast(`Selected ${(pack.cases || []).length} case(s)`, 'info');
    }

    function deleteSelection() {
      if (prepareSceneMutation()) {
        showOperationsBusyToast();
        return;
      }
      const ids = getSelection();
      if (!ids.length) return;
      const packId = StateStore.get('currentPackId');
      const result = PackLibrary.removeInstances(packId, ids);
      setSelection(getDeleteFinalSelection(result));
      if (!result) {
        UIComponents.showToast('Delete failed. Please try again.', 'error');
        return;
      }
      UIComponents.showToast(formatDeleteResultMessage(result, ids), 'info');
    }

    // Measurement Mode and the Annotations tool take over (and later return) the pointer: drop stale hover emphasis.
    function resetHover() {
      hoveredId = null;
      drawingHover = false;
      lineHover = false;
      CaseScene.setHover(null);
      if (domEl) domEl.style.cursor = 'default';
    }

    return {
      init: initInteraction, setSelection, selectAllInPack, deleteSelection, rotateSelection, moveSelectionVertical,
      resetHover,
      setSelectionOrientationConstraint,
      hasProvisionalPose: () => Boolean(draggingId || gizmoDragging || gizmoPending || revertHolds > 0),
    };
  })();

  return InteractionManager;
}

export function createEditorScreen({
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
  OperationLifecycle = null,
  MeasurementTool = null,
  AnnotationTool = null,
}) {
  const EditorUI = (() => {
    // Runtime authority only: navigation IDs cannot prove what the scene contains.
    // Publish after a complete committed render; replacement/departure kills it.
    let previewScene = null;
    let viewOwner = null;
    let viewRevision = 0;
    let focusRevision = null;
    let viewGestureActive = false;
    let viewFocusActive = false;
    let viewPendingEnd = false;
    let viewSettleTimer = null;
    let pendingViewSave = false;
    let onPreviewViewSettled = null;
    let activeCameraPreset = null;
    let activePresetSignature = null;

    function clearActiveCameraPreset() {
      activeCameraPreset = null;
      activePresetSignature = null;
    }

    function clearViewSettle() {
      if (viewSettleTimer !== null) window.clearTimeout(viewSettleTimer);
      viewSettleTimer = null;
      viewPendingEnd = false;
    }

    function invalidateViewOwner() {
      clearViewSettle();
      SceneManager.cancelFocus();
      viewOwner = null;
      viewGestureActive = false;
      viewFocusActive = false;
      focusRevision = null;
      pendingViewSave = false;
      clearActiveCameraPreset();
      viewRevision++;
    }

    function isViewOwnerCurrent() {
      return Boolean(viewOwner && StateStore.get('currentScreen') === 'editor' &&
        StateStore.get('currentPackId') === viewOwner.packId &&
        CoreStorage.isScopeContextCurrent(viewOwner.scope));
    }

    function persistSettledView(revision = viewRevision, { explicit = false } = {}) {
      if (revision !== viewRevision || !isViewOwnerCurrent() ||
          viewGestureActive || viewFocusActive || viewPendingEnd) return false;
      // Camera metadata belongs to the Pack even while Results owns the cargo preview.
      const pack = PackLibrary.getById(viewOwner.packId);
      if (!pack) {
        pendingViewSave = true;
        return false;
      }
      pendingViewSave = false;
      const view = SceneManager.getEditorView();
      const signature = editorViewSignature(view);
      const stored = normalizeEditorView(pack.editorView);
      const saved = stored || SceneManager.getDefaultEditorView(pack.truck,
        PreferencesManager.get().camera.defaultView);
      if (!signature) return false;
      if ((!explicit || stored?.projection) && signature === editorViewSignature(saved)) {
        if (onPreviewViewSettled) onPreviewViewSettled();
        return false;
      }
      return Boolean(PackLibrary.updateEditorView(pack.id, view));
    }

    function applyCameraPreset(preset) {
      if (!isViewOwnerCurrent()) return false;
      const pack = PackLibrary.getById(viewOwner.packId);
      if (!pack) return false;
      SceneManager.resize();
      const view = SceneManager.getPresetEditorView(pack.truck, preset);
      if (!view) return false;
      clearViewSettle();
      viewGestureActive = false;
      viewFocusActive = false;
      focusRevision = null;
      viewRevision++;
      if (!SceneManager.applyEditorView(view)) return false;
      activeCameraPreset = preset;
      activePresetSignature = editorViewSignature(SceneManager.getEditorView());
      // A command is a settled camera change; persist through the Pack owner.
      persistSettledView(viewRevision);
      return true;
    }

    function applyCameraProjection(projection, expectedPackId = viewOwner?.packId) {
      if (!isViewOwnerCurrent()) return false;
      if (viewOwner.packId !== expectedPackId) return false;
      const pack = PackLibrary.getById(viewOwner.packId);
      if (!pack || !['perspective', 'orthographic'].includes(projection)) return false;
      clearViewSettle();
      viewGestureActive = false;
      viewFocusActive = false;
      focusRevision = null;
      viewRevision++;
      if (!SceneManager.switchProjection(projection)) return false;
      clearActiveCameraPreset();
      persistSettledView(viewRevision, { explicit: true });
      return PackLibrary.getById(pack.id)?.editorView?.projection === projection;
    }

    function applyZoomStep(direction) {
      if (!isViewOwnerCurrent()) return false;
      clearViewSettle();
      viewGestureActive = false;
      viewFocusActive = false;
      focusRevision = null;
      viewRevision++;
      if (!SceneManager.zoomStep(direction)) return false;
      clearActiveCameraPreset();
      persistSettledView(viewRevision);
      return true;
    }

    function getCurrentCameraPack() {
      if (!isViewOwnerCurrent()) return null;
      const pack = PackLibrary.getById(viewOwner.packId);
      return pack ? { id: pack.id, title: pack.title } : null;
    }

    function scheduleViewSettle(revision) {
      if (viewSettleTimer !== null) window.clearTimeout(viewSettleTimer);
      viewSettleTimer = window.setTimeout(() => {
        viewSettleTimer = null;
        if (revision !== viewRevision) return;
        viewPendingEnd = false;
        persistSettledView(revision);
      }, 150);
    }

    function getPreviewView() {
      const scene = getPreviewScene();
      if (!scene || !isViewOwnerCurrent() || viewGestureActive || viewFocusActive ||
          viewPendingEnd || pendingViewSave) return null;
      const view = SceneManager.getEditorView();
      const signature = editorViewSignature(view);
      return signature ? { view, signature, revision: viewRevision } : null;
    }

    function flushPendingView() {
      if (!viewPendingEnd || viewGestureActive || viewFocusActive) return;
      const controls = SceneManager.getControls();
      if (controls) {
        const damping = controls.enableDamping;
        controls.enableDamping = false;
        controls.update();
        controls.enableDamping = damping;
      }
      clearViewSettle();
      persistSettledView();
    }

    function setPreviewViewSettledCallback(callback) {
      onPreviewViewSettled = callback;
    }

    StateStore.subscribe((changes, _state, notification) => {
      if (viewOwner && !isViewOwnerCurrent()) {
        invalidateViewOwner();
      }
      if (changes._replace || StateStore.get('currentScreen') !== 'editor' ||
          (previewScene && StateStore.get('currentPackId') !== previewScene.pack.id)) {
        previewScene = null;
      }
      const results = getAutoPackResultsState();
      if (results && results.previewEnded !== true && (changes._replace ||
          StateStore.get('currentScreen') !== 'editor' || StateStore.get('currentPackId') !== results.packId)) {
        // Context departure ends the preview monotonically. Returning to this
        // Pack can show the same Results, but cannot silently resume the scene.
        StateStore.set({ autoPackResults: { ...results, previewEnded: true } }, { skipHistory: true, skipNotify: true });
      }
      // Leaving the Editor ends a transient Results preview: back to the Pack.
      if (StateStore.get('currentScreen') !== 'editor' && CaseScene.isTransientPreview()) {
        CaseScene.sync(PackLibrary.getById(StateStore.get('currentPackId')));
      }
      // Only the whitelisted derived-metadata boundary can rebind authority.
      // An ordinary Pack replacement still requires a full committed render.
      // A measurement-only or annotation-only edit is such a boundary: it replaces the Pack object but keeps
      // the same cargo, truck and visual signature (the guards below and rebindPreviewPack re-check all three).
      if ((notification?.type === 'pack-preview' || notification?.type === 'pack-view' ||
          notification?.type === 'pack-measurements' || notification?.type === 'pack-annotations') && previewScene &&
          previewScene.pack === notification.previousPack &&
          PackLibrary.getById(notification.pack.id) === notification.pack &&
          CoreStorage.isScopeContextCurrent(previewScene.scope) &&
          previewScene.scene === SceneManager.getScene() &&
          previewScene.visualSignature === CaseScene.getVisualSignature(notification.pack) &&
          CaseScene.rebindPreviewPack(notification.previousPack, notification.pack)) {
        previewScene = { ...previewScene, pack: notification.pack };
      }
      // Undo/Redo step only the committed Pack. Once that notification settles,
      // a Results view left previewing a non-Applied option lands on the (new)
      // Applied option, so the canonical scene shows and can be captured.
      if (changes._undo || changes._redo) queueMicrotask(landAutoPackResultsViewOnApplied);
    });

    // Ends a transient Results preview by moving the view to the Applied option
    // (runId-guarded, Results state only — no Pack, history or lastEdited write).
    // Shared by Undo/Redo and visual export.
    function landAutoPackResultsViewOnApplied() {
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      if (!getAutoPackResultsPreviewPack(pack)) return;
      const view = resolveAutoPackResultsView(pack);
      const appliedIndex = view.options.indexOf(view.currentOption);
      patchAutoPackResultsState(appliedIndex >= 0
        ? { viewIndex: appliedIndex, previewEnded: false }
        : { previewEnded: true }, view.results.runId);
    }

    // Visual export and whole-Pack operations (Unpack, Truck Change) start from
    // the committed scene: a transient Results preview ends first through the
    // landing above, and the committed Pack is rendered synchronously, before
    // any operation claims the lifecycle slot. Returns true when it ended one.
    function endAutoPackResultsPreview({ forManualEdit = false } = {}) {
      if (!CaseScene.isTransientPreview()) return false;
      landAutoPackResultsViewOnApplied();
      if (CaseScene.isTransientPreview()) render();
      const ended = !CaseScene.isTransientPreview();
      if (ended && forManualEdit) {
        UIComponents.showToast('AutoPack preview ended. Saved load plan restored.', 'info', { title: 'Editor' });
      }
      return ended;
    }

    function getPreviewScene() {
      if (!previewScene || !CoreStorage.isScopeContextCurrent(previewScene.scope) ||
          StateStore.get('currentScreen') !== 'editor' ||
          StateStore.get('currentPackId') !== previewScene.pack.id ||
          PackLibrary.getById(previewScene.pack.id) !== previewScene.pack ||
          SceneManager.getScene() !== previewScene.scene ||
          CaseScene.getSyncedPack() !== previewScene.pack ||
          CaseScene.getVisualSignature(previewScene.pack) !== previewScene.visualSignature ||
          InteractionManager.hasProvisionalPose()) return null;
      const operation = OperationLifecycle && OperationLifecycle.currentOperation();
      if (operation && operation.busy && operation.kind !== 'capturingPreview') return null;
      return previewScene;
    }

    // Screenshot/PDF authority: the Preview boundary plus a fully idle lifecycle
    // (no capture either), the current Pack's own camera owner, and every mesh at
    // its committed pose. The runtime camera is used as-is, including a camera
    // focus/orbit in motion: camera movement never changes cargo authority.
    function getExportScene() {
      if (OperationLifecycle && OperationLifecycle.isBusy()) return null;
      // Visual exports always show the committed Pack: a transient Results
      // preview ends first (the view lands on the Applied option, re-rendering
      // the committed scene), then authority resolves exactly as before.
      endAutoPackResultsPreview();
      const scene = getPreviewScene();
      if (!scene || !isViewOwnerCurrent() || !CaseScene.matchesCommittedPoses(scene.pack)) return null;
      return scene;
    }
    const shellEl = /** @type {HTMLElement|null} */ (document.querySelector('.editor-shell'));
    const leftEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-left'));
    const rightEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-right'));
    const btnLeft = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-left'));
    const btnRight = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-right'));
    const btnLeftClose = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-left-close'));
    const btnRightClose = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-right-close'));
    const viewportEl = /** @type {HTMLElement|null} */ (document.getElementById('viewport'));
    const inspectorEl = /** @type {HTMLElement|null} */ (document.getElementById('inspector-body'));
    const caseSearchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('editor-case-search'));
    const caseFilterToggleEl = /** @type {HTMLButtonElement|null} */ (document.getElementById('editor-case-filters-toggle'));
    const caseChipsEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-case-chips'));
    const caseListEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-case-list'));
    const btnAutopack = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-autopack'));
    const btnUnpack = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-unpack'));
    const btnAnnotations = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-annotations'));
    const btnMeasure = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-measure'));
    const btnView = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-view'));
    const zoomControlsEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-zoom-controls'));
    const btnZoomIn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-zoom-in'));
    const btnZoomOut = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-editor-zoom-out'));
    const btnShare = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-share'));
    const btnPng = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-screenshot'));
    const btnPdf = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pdf'));
    const validationStatusEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-validation-status'));
    const validationStatusBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('editor-validation-status-btn'));
    const validationPopoverEl = /** @type {HTMLElement|null} */ (document.getElementById('editor-validation-popover'));
    const handlingRulesValidateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('editor-handling-rules-validate-btn'));
    const resultsReopenBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-autopack-results-reopen'));
    let packNotesButton = null;
    let editorFieldId = 0;

    // Existing status/popover shows derived committed-Pack assessment. Neither
    // opening it nor explicitly checking the load changes cargo or history.
    let validationPopoverOpen = false;
    let validationPopoverPackId = null;

    // Document listeners exist ONLY while the panel is open (added on open, removed
    // on close), so nothing accumulates across Editor re-renders. Capture phase so a
    // press on the 3D canvas still dismisses it even if the scene stops propagation.
    function onValidationPopoverPointerDown(ev) {
      if (!(ev.target instanceof Node)) return;
      if (validationStatusEl && validationStatusEl.contains(ev.target)) return;
      setValidationPopoverOpen(false);
    }

    function onValidationPopoverKeydown(ev) {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      setValidationPopoverOpen(false, { restoreFocus: true });
    }

    function setValidationPopoverOpen(open, { restoreFocus = false } = {}) {
      if (!validationStatusBtn || !validationPopoverEl) return;
      const next = Boolean(open);
      if (next === validationPopoverOpen) return;
      const focusInside = Boolean(
        validationStatusEl && document.activeElement && validationStatusEl.contains(document.activeElement)
      );
      validationPopoverOpen = next;
      validationPopoverEl.hidden = !next;
      validationStatusBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (next) {
        document.addEventListener('pointerdown', onValidationPopoverPointerDown, true);
        document.addEventListener('keydown', onValidationPopoverKeydown, true);
        return;
      }
      document.removeEventListener('pointerdown', onValidationPopoverPointerDown, true);
      document.removeEventListener('keydown', onValidationPopoverKeydown, true);
      validationPopoverPackId = null;
      if (restoreFocus && focusInside) validationStatusBtn.focus();
    }

    function renderHandlingRulesStatus(pack) {
      if (!validationStatusEl) return;
      const committed = pack && PackLibrary.getById(pack.id);
      const assessment = committed && PackLibrary.assessCommittedPack(committed, CaseLibrary.getCases());
      const needsReview = assessment && (assessment.primary !== 'VALID' || assessment.eligibility.state === 'blocked');
      validationStatusEl.hidden = !needsReview;
      if (assessment) {
        const title = `Load plan: ${assessment.primary}`;
        const body = `Physical assessment: ${assessment.primary}. Operational eligibility: ${assessment.eligibility.state}.`;
        validationStatusBtn?.setAttribute('aria-label', title);
        validationStatusEl.querySelectorAll('.tp3d-status-card__title, .tp3d-editor-validation-popover__title')
          .forEach(el => { el.textContent = title; });
        validationStatusEl.querySelectorAll('.tp3d-status-card__body, .tp3d-editor-validation-popover__body')
          .forEach(el => { el.textContent = body; });
      }
      if (!needsReview || (validationPopoverOpen && validationPopoverPackId !== pack.id)) {
        setValidationPopoverOpen(false);
      }
    }

    function focusAfterValidationAction() {
      if (validationStatusEl && !validationStatusEl.hidden && validationStatusBtn && !validationStatusBtn.disabled) {
        validationStatusBtn.focus();
        return;
      }
      const toolbarTarget = [btnAutopack, btnLeft, btnRight]
        .find(btn => btn && !btn.hidden && !btn.disabled);
      if (toolbarTarget) toolbarTarget.focus();
    }

    if (validationStatusBtn) {
      validationStatusBtn.addEventListener('click', () => {
        // Informational only: opening the panel never validates or mutates cargo.
        validationPopoverPackId = StateStore.get('currentPackId');
        setValidationPopoverOpen(!validationPopoverOpen);
      });
    }

    if (handlingRulesValidateBtn) {
      handlingRulesValidateBtn.addEventListener('click', () => {
        // Do not return focus to the status before validation: a successful render
        // hides it. Focus a visible destination only after the resulting state renders.
        setValidationPopoverOpen(false);
        if (editorMutationBlocked()) {
          focusAfterValidationAction();
          return;
        }
        const packId = StateStore.get('currentPackId');
        if (!packId) {
          focusAfterValidationAction();
          return;
        }
        const result = PackLibrary.validateLoadPlan(packId, CaseLibrary.getCases());
        if (!result) {
          UIComponents.showToast('Validation failed. Please try again.', 'error');
          render();
          focusAfterValidationAction();
          return;
        }
        const message = `Load Plan checked: ${result.primary}. Operational eligibility: ${result.eligibility.state}. Cargo unchanged.`;
        const tone = result.primary === 'VALID' && result.eligibility.state === 'eligible' ? 'success' : 'warning';
        UIComponents.showToast(message, tone);
        render();
        focusAfterValidationAction();
      });
    }

    // Swap a button into a visible "working" state (spinner + label) and back. The
    // idle markup is captured once so it can be restored exactly. Pairs with the
    // existing `.btn .fa-spinner` CSS.
    function setButtonWorking(btn, working, workingLabel) {
      if (!btn) return;
      if (working) {
        if (btn.dataset.idleHtml === undefined) btn.dataset.idleHtml = btn.innerHTML;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${workingLabel}`;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
      } else if (btn.dataset.idleHtml !== undefined) {
        btn.innerHTML = btn.dataset.idleHtml;
        delete btn.dataset.idleHtml;
        btn.removeAttribute('aria-busy');
      }
    }

    // Single source of truth for the action-bar button states: spinner on the active
    // operation's button, and every mutating/export control blocked while ANY editor
    // operation is in flight. Called by render() and by the operation-lifecycle
    // subscription so the working state appears the instant an operation begins.
    function refreshActionButtons() {
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      const op = OperationLifecycle
        ? OperationLifecycle.currentOperation()
        : { kind: AutoPackEngine.running ? 'autopacking' : 'idle', busy: AutoPackEngine.running };
      const busy = Boolean(op.busy);
      setButtonWorking(btnAutopack, op.kind === 'autopacking', 'Packing…');
      setButtonWorking(btnUnpack, op.kind === 'unpacking', 'Moving to staging…');
      if (btnAutopack && op.kind !== 'autopacking') btnAutopack.disabled = !pack || busy;
      if (btnUnpack && op.kind !== 'unpacking') btnUnpack.disabled = !pack || busy || !(pack && (pack.cases || []).length);
      if (btnView) btnView.disabled = !pack;
      const zoomUnavailable = !pack || !SceneManager.getCamera();
      if (btnZoomIn) btnZoomIn.disabled = zoomUnavailable;
      if (btnZoomOut) btnZoomOut.disabled = zoomUnavailable;
      if (btnShare) btnShare.disabled = !pack || busy;
      if (btnPng) btnPng.disabled = !pack || busy;
      if (btnPdf) btnPdf.disabled = !pack || busy;
      if (packNotesButton) packNotesButton.disabled = !pack || busy;
    }

    let initialized = false;
    // A selection change arrived while a mutating operation owned the Editor; the
    // full render it would have triggered runs once that operation ends.
    let selectionRenderPending = false;
    const supportsWebGL = Utils.hasWebGL();
    const browserCats = new Set();
    const browserManufacturers = new Set();
    const caseFiltersStorageKey = 'tp3d.editor.caseBrowser.showFilters';
    let showCaseFilters = false;
    let caseBrowserGroupBy = 'category';
    // Ephemeral per-Case Qty selector drafts, keyed by caseId and scoped to the
    // active workspace. Never read from or written to StateStore/localStorage/
    // Pack/Case. Survives same-workspace re-renders, Pack changes and navigation;
    // resetWorkspaceState clears it only when workspace scope changes.
    const caseQtyDrafts = new Map();
    // Ephemeral, in-memory only (see createStagingActionDuplicateGuard). Held here,
    // beside the drafts, so it outlives the Case Browser card that Add/Unstage rebuild.
    const stagingActionGuard = createStagingActionDuplicateGuard();
    const CASE_QTY_MIN = 1;
    const CASE_QTY_MAX = 10000;
    function getCaseQtyDraft(caseId) {
      const stored = caseQtyDrafts.get(caseId);
      return Number.isFinite(stored) ? stored : CASE_QTY_MIN;
    }
    function setCaseQtyDraft(caseId, value) {
      const clamped = Math.min(CASE_QTY_MAX, Math.max(CASE_QTY_MIN, Math.trunc(value)));
      caseQtyDrafts.set(caseId, clamped);
      return clamped;
    }
    function resetWorkspaceState() {
      previewScene = null;
      invalidateViewOwner();
      resetEditorCaseQtyDrafts(caseQtyDrafts);
      // Case Browser search/filter/group-by are workspace-scoped presentation
      // state: kept across Pack changes, reset only when the workspace changes.
      browserCats.clear();
      browserManufacturers.clear();
      if (caseSearchEl) caseSearchEl.value = '';
      caseBrowserGroupBy = 'category';
      setCaseFiltersVisible(false, false);
      syncCaseFilterIndicators();
    }
    let layoutRaf = null;
    let sceneHostResizeObserver = null;
    // Pending (uncommitted) truck geometry edited via the preset/shape dropdowns.
    // The committed truck stays pack.truck and the scene keeps rendering it until the
    // user clicks "Update truck"; this only pre-fills the inspector form. Tagged with
    // __packId so it is ignored after a pack switch.
    let pendingTruck = null;
    function getEffectiveTruck(pack) {
      return (pendingTruck && pack && pendingTruck.__packId === pack.id) ? pendingTruck : (pack ? pack.truck : null);
    }
    function setPendingTruck(pack, nextTruck) {
      pendingTruck = nextTruck ? { ...nextTruck, __packId: pack.id } : null;
    }
    function clearPendingTruck() {
      pendingTruck = null;
    }
    function getAutoPackResultsHost() {
      return viewportEl ? viewportEl.closest('.canvas-wrap') : null;
    }


    function removeAutoPackResultsPanel() {
      const host = getAutoPackResultsHost();
      if (!host) return;
      const existing = host.querySelector('[data-role="autopack-results-panel"]');
      if (existing) existing.remove();
    }

    function getAutoPackResultsState() {
      const results = StateStore.get('autoPackResults');
      return results && typeof results === 'object' ? results : null;
    }

    function captureEditorFocus(root) {
      const active = document.activeElement;
      if (!root?.contains(active) || !(active instanceof HTMLElement)) return null;
      return {
        key: active.dataset.focusKey || '',
        tag: active.tagName,
        name: active.getAttribute('aria-label') || active.textContent?.trim() || '',
      };
    }

    function restoreEditorFocus(snapshot, root, fallback) {
      if (!snapshot || UIComponents.modalOwnership?.getActiveOwner()) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body &&
          document.activeElement.isConnected) return;
      const candidates = Array.from(root?.querySelectorAll('button, input, [role="combobox"], textarea') || []);
      const match = candidates.find(el => snapshot.key && el.dataset.focusKey === snapshot.key) ||
        candidates.find(el => el.tagName === snapshot.tag &&
          (el.getAttribute('aria-label') || el.textContent?.trim() || '') === snapshot.name);
      const alternateKey = snapshot.key === 'results-next' ? 'results-prev'
        : snapshot.key === 'results-prev' ? 'results-next' : '';
      const alternate = candidates.find(el => alternateKey && el.dataset.focusKey === alternateKey && !el.disabled);
      const target = match && !match.disabled ? match : (alternate || fallback);
      target?.focus({ preventScroll: true });
    }

    function patchAutoPackResultsState(patch, expectedRunId) {
      const current = getAutoPackResultsState();
      if (!current || current.runId !== expectedRunId) return;
      StateStore.set({ autoPackResults: { ...current, ...patch } }, { skipHistory: true });
    }

    // The starting view is resolved once per run, the first time that run is
    // shown, so a later preference change, Apply, Undo or close/reopen never
    // moves an unbrowsed carousel. UI-only: never persisted or written to Results.
    let autoPackResultsStart = null;

    function getAutoPackResultsStartIndex(results, options, appliedOption) {
      if (autoPackResultsStart && autoPackResultsStart.runId === results.runId) return autoPackResultsStart.index;
      const index = resolveAutoPackResultsStartIndex(options, results, appliedOption,
        PreferencesManager.get().autoPackResultsStartView);
      autoPackResultsStart = { runId: results.runId, index };
      return index;
    }

    // The single viewed-option resolution shared by the Results card, the 3D
    // scene and the Inspector, so they can never show different options.
    function resolveAutoPackResultsView(pack) {
      const results = getAutoPackResultsState();
      const options = orderAutoPackResultOptions(results && results.options);
      if (!pack || !results || results.packId !== pack.id || !options.length) {
        return { results, options, open: false };
      }
      const currentOption = getAppliedAutoPackOption(pack, results, caseId => CaseLibrary.getById(caseId));
      const hasAlternates = options.length > 1;
      // Carousel view index is UI-only view state (never persisted, never part of
      // the result payload). Until the user browses, the view stays on the run's
      // starting option (the AutoPack Results starting view preference); once
      // Prev/Next writes an explicit index it is kept. Always clamped so a stale
      // index can never point out of bounds.
      const selectedIndex = Math.max(0, options.findIndex(option => option === currentOption));
      const startIndex = getAutoPackResultsStartIndex(results, options, currentOption);
      const requestedIndex = Number.isInteger(results.viewIndex) ? results.viewIndex : startIndex;
      const viewIndex = hasAlternates
        ? Math.min(Math.max(0, requestedIndex), options.length - 1)
        : selectedIndex;
      const viewedOption = hasAlternates ? (options[viewIndex] || options[0]) : (currentOption || options[0]);
      return { results, options, open: results.closed !== true, currentOption, hasAlternates, viewIndex, viewedOption };
    }

    // Transient live preview: the run's viewed option is independent of card
    // visibility. Closing/minimizing never adopts or ends the candidate. The
    // non-Applied option of a current (not Outdated) run, the scene and the
    // Inspector totals show that option through the same projection Apply
    // commits. Presentation only — the Pack, history, autosave, thumbnail and
    // export never see it (scene authority is published only for the committed
    // Pack). Anything else, or an operation owning the scene, shows the Pack.
    let autoPackResultsPreview = null;

    function getAutoPackResultsPreviewPack(pack) {
      const operation = OperationLifecycle && OperationLifecycle.currentOperation();
      if (!pack || (operation && operation.busy && operation.kind !== 'capturingPreview')) return null;
      const results = getAutoPackResultsState();
      const view = resolveAutoPackResultsView(pack);
      if (!view.viewedOption || !isAutoPackResultsFresh(pack, results, caseId => CaseLibrary.getById(caseId),
        { maxCapacity: view.viewedOption.id === 'max-capacity' })) return null;
      const caseLibrary = StateStore.get('caseLibrary');
      const memo = autoPackResultsPreview;
      if (memo && memo.pack === pack && memo.results === results && memo.caseLibrary === caseLibrary) {
        return memo.previewPack;
      }
      const option = view.results.previewEnded !== true &&
        view.viewedOption !== view.currentOption ? view.viewedOption : null;
      const cases = option ? buildAppliedAutoPackCases(option, cloneAutoPackCases, pack.cases) : null;
      autoPackResultsPreview = { pack, results, caseLibrary, previewPack: cases ? { ...pack, cases } : null };
      return autoPackResultsPreview.previewPack;
    }

    function isAutoPackResultsStale(pack, results, option = null) {
      return !isAutoPackResultsFresh(pack, results, caseId => CaseLibrary.getById(caseId),
        { maxCapacity: option?.id === 'max-capacity' });
    }

    function formatAutoPackResultNumber(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '0';
      return number.toLocaleString();
    }

    function formatAutoPackResultVolume(value) {
      const number = Number(value);
      return Number.isFinite(number) ? `${number.toFixed(1)}%` : '—';
    }

    function cloneAutoPackCases(cases) {
      if (Utils && typeof Utils.deepClone === 'function') return Utils.deepClone(cases);
      return JSON.parse(JSON.stringify(cases));
    }

    function applyAutoPackResultOption(optionId, expectedRunId) {
      const results = getAutoPackResultsState();
      if (!results || results.runId !== expectedRunId) return;
      // Applying swaps the whole load — a mutating path that must respect the
      // single-operation lifecycle like every other editor mutation.
      if (OperationLifecycle && typeof OperationLifecycle.isBusy === 'function' && OperationLifecycle.isBusy()) {
        UIComponents.showToast(
          'Wait for the current operation to finish before applying AutoPack results.',
          'info',
          { title: 'AutoPack Results' }
        );
        return;
      }
      const pack = PackLibrary.getById(StateStore.get('currentPackId'));
      if (!pack || results.packId !== pack.id || StateStore.get('currentScreen') !== 'editor') return;
      const option = (results.options || []).find(item => item.id === optionId);
      if (!option || !Array.isArray(option.nextCases)) return;
      if (isAutoPackResultsStale(pack, results, option)) {
        UIComponents.showToast('Rerun AutoPack after edits.', 'info', { title: 'AutoPack Results' });
        return;
      }
      const appliedOption = getAppliedAutoPackOption(pack, results, caseId => CaseLibrary.getById(caseId));
      if (option === appliedOption) return;

      // Max deliberately retains its existing C4 projection/check, not the new
      // normal assessment policy. C5C owns atomic Max policy integration.
      const prepared = option.id === 'max-capacity' ? null
        : prepareNormalAutoPackResultApply(pack, results, option, caseId => CaseLibrary.getById(caseId));
      const appliedCases = option.id === 'max-capacity'
        ? buildAppliedAutoPackCases(option, cloneAutoPackCases, pack.cases) : prepared?.cases;
      if (!appliedCases) {
        UIComponents.showToast('Rerun AutoPack after edits.', 'info', { title: 'AutoPack Results' });
        return;
      }
      const projectedPack = { ...pack, cases: appliedCases };
      const adoptedOptionIds = [...new Set([...(results.adoptedOptionIds || []), appliedOption?.id, option.id].filter(Boolean))];
      if (getAppliedAutoPackOption(projectedPack, { ...results, adoptedOptionIds }, caseId => CaseLibrary.getById(caseId)) !== option) {
        UIComponents.showToast('Rerun AutoPack after edits.', 'info', { title: 'AutoPack Results' });
        return;
      }
      StateStore.set({ selectedInstanceIds: [] }, { skipHistory: true, skipNotify: true });
      CaseScene.setSelected([]);
      // Publish action evidence with the commit notification, without a second
      // render/history step or an intermediate Outdated scene. Roll back only
      // this transient metadata if the Pack commit does not land.
      StateStore.set({ autoPackResults: { ...results, adoptedOptionIds,
        options: prepared && option.assessment
          ? results.options.map(item => item === option ? { ...item, assessment: prepared.assessment } : item) : results.options,
      } }, { skipHistory: true, skipNotify: true });
      let committed = null;
      try {
        committed = PackLibrary.update(pack.id, { cases: appliedCases });
      } finally {
        if (!committed && getAutoPackResultsState()?.runId === results.runId) {
          StateStore.set({ autoPackResults: results }, { skipHistory: true, skipNotify: true });
        }
      }
      if (!committed) return;
      UIComponents.showToast(`Applied ${option.label || 'load option'}.`, 'success', { title: 'AutoPack Results' });
    }

    function makeAutoPackResultStat(label, value) {
      const stat = document.createElement('div');
      stat.className = 'tp3d-autopack-results__stat';
      const labelEl = document.createElement('span');
      labelEl.className = 'tp3d-autopack-results__stat-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('strong');
      valueEl.className = 'tp3d-autopack-results__stat-value';
      valueEl.textContent = value;
      stat.appendChild(labelEl);
      stat.appendChild(valueEl);
      return stat;
    }

    const AUTOPACK_PARTIAL_CAUSE_LABELS = {
      fit: 'no safe fit for the remaining items',
      safety: 'safety rules blocked the remaining items',
      rules: 'cargo handling rules blocked the remaining items',
      budget: 'time limit reached before every item was tried',
    };

    function formatAutoPackPartialReason(option) {
      const causes = Array.isArray(option && option.partialCauses) ? option.partialCauses : [];
      if (!causes.length) return '';
      return `Partial — ${causes.map(cause => AUTOPACK_PARTIAL_CAUSE_LABELS[cause] || String(cause)).join('; ')}`;
    }

    function makeAutoPackResultDescription(option) {
      if (!option || !option.description) return null;
      const desc = document.createElement('div');
      desc.className = 'tp3d-autopack-results__option-desc';
      desc.textContent = option.description;
      return desc;
    }

    function makeAutoPackResultPill(className, text, iconClass = '') {
      const pill = document.createElement('span');
      pill.className = className;
      if (iconClass) {
        const icon = document.createElement('i');
        icon.className = iconClass;
        icon.setAttribute('aria-hidden', 'true');
        pill.appendChild(icon);
      }
      pill.appendChild(document.createTextNode(text));
      return pill;
    }

    // Closed Results stay in memory; the bottom-left restore control reopens
    // that same run. It exists only for the current Pack's closed Results and
    // carries their runId so a newer run can never be reopened by a stale click.
    function syncAutoPackResultsReopen(pack, results, options) {
      if (!resultsReopenBtn) return;
      const reopenable = Boolean(pack && results && results.closed === true &&
        results.packId === pack.id && options.length);
      resultsReopenBtn.hidden = !reopenable;
      if (reopenable) resultsReopenBtn.dataset.runId = String(results.runId);
      else delete resultsReopenBtn.dataset.runId;
    }

    // Presentation only: reopens and expands the existing Results through the
    // runId-guarded patch path. Never reruns AutoPack and never touches the Pack.
    function reopenAutoPackResults() {
      const runId = resultsReopenBtn ? resultsReopenBtn.dataset.runId : '';
      const results = getAutoPackResultsState();
      if (!runId || !results || results.runId !== runId ||
          results.packId !== StateStore.get('currentPackId')) return;
      patchAutoPackResultsState({ closed: false, minimized: false }, runId);
      const panel = getAutoPackResultsHost()?.querySelector('[data-role="autopack-results-panel"]');
      const toggle = panel?.querySelector('[data-focus-key="results-toggle"]');
      if (toggle instanceof HTMLElement) toggle.focus({ preventScroll: true });
    }

    function clampAutoPackResultsPosition(host, panel, position) {
      if (!host || !panel || !position) return null;
      const hostRect = host.getBoundingClientRect();
      const margin = 10;
      const maxX = Math.max(margin, hostRect.width - panel.offsetWidth - margin);
      const maxY = Math.max(margin, hostRect.height - panel.offsetHeight - margin);
      return {
        x: Math.min(Math.max(Number(position.x) || margin, margin), maxX),
        y: Math.min(Math.max(Number(position.y) || margin, margin), maxY),
      };
    }

    function attachAutoPackResultsDrag(panel, host, expectedRunId) {
      const handle = panel.querySelector('[data-role="autopack-results-drag"]');
      if (!(handle instanceof HTMLElement) || !host) return;
      handle.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        if (ev.target instanceof Element && ev.target.closest('button')) return;
        const hostRect = host.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const start = {
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          left: panelRect.left - hostRect.left,
          top: panelRect.top - hostRect.top,
        };
        let nextPosition = null;
        let dragging = false;
        const onMove = moveEv => {
          const dx = moveEv.clientX - start.pointerX;
          const dy = moveEv.clientY - start.pointerY;
          if (!dragging && Math.hypot(dx, dy) < 5) return;
          dragging = true;
          moveEv.preventDefault();
          nextPosition = clampAutoPackResultsPosition(host, panel, {
            x: start.left + dx,
            y: start.top + dy,
          });
          if (!nextPosition) return;
          panel.classList.add('is-dragged');
          panel.style.left = `${nextPosition.x}px`;
          panel.style.top = `${nextPosition.y}px`;
          panel.style.transform = 'none';
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (dragging && nextPosition) {
            patchAutoPackResultsState({ position: nextPosition }, expectedRunId);
          }
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }

    function renderAutoPackResultsPanel(pack) {
      const previousFocus = captureEditorFocus(getAutoPackResultsHost()?.querySelector('[data-role="autopack-results-panel"]'));
      removeAutoPackResultsPanel();
      const host = getAutoPackResultsHost();
      const view = resolveAutoPackResultsView(pack);
      const { results, options } = view;
      syncAutoPackResultsReopen(pack, results, options);
      if (!host || !view.open) {
        // Closing hands focus to the restore control that reverses it.
        const closedFocus = resultsReopenBtn && !resultsReopenBtn.hidden ? resultsReopenBtn : btnAutopack;
        restoreEditorFocus(previousFocus, null, closedFocus);
        return;
      }

      const { currentOption, hasAlternates, viewIndex, viewedOption } = view;
      const stale = isAutoPackResultsStale(pack, results, viewedOption);
      // minimized is UI-only panel state (never persisted, never in the result
      // payload): collapse the panel to a small draggable chip separate from close.
      const minimized = results.minimized === true;

      // Position + drag are shared by the full panel and the minimized chip, so
      // both reuse the one existing drag/position system (no second drag system).
      const placeAutoPackResultsEl = el => {
        el.dataset.role = 'autopack-results-panel';
        const position = clampAutoPackResultsPosition(host, el, results.position);
        if (position) {
          el.classList.add('is-dragged');
          el.style.left = `${position.x}px`;
          el.style.top = `${position.y}px`;
          el.style.transform = 'none';
        }
        host.appendChild(el);
        if (results.position) {
          const clamped = clampAutoPackResultsPosition(host, el, results.position);
          if (clamped) {
            el.style.left = `${clamped.x}px`;
            el.style.top = `${clamped.y}px`;
            el.style.transform = 'none';
          }
        }
        attachAutoPackResultsDrag(el, host, results.runId);
      };

      // 2×3 dot-grid grip hinting the header drag handle.
      const makeAutoPackGrip = () => {
        const grip = document.createElement('span');
        grip.className = 'tp3d-autopack-results__grip';
        grip.setAttribute('aria-hidden', 'true');
        for (let dot = 0; dot < 6; dot += 1) {
          const dotEl = document.createElement('span');
          dotEl.className = 'tp3d-autopack-results__grip-dot';
          grip.appendChild(dotEl);
        }
        return grip;
      };

      const panel = document.createElement('section');
      panel.className = `tp3d-autopack-results ${minimized ? 'is-minimized' : (hasAlternates ? 'is-carousel' : 'is-compact')}`;
      panel.setAttribute('aria-label', 'AutoPack results');
      panel.setAttribute('aria-live', 'polite');

      const header = document.createElement('div');
      header.className = 'tp3d-autopack-results__header';
      header.dataset.role = 'autopack-results-drag';

      const headerLeft = document.createElement('div');
      headerLeft.className = 'tp3d-autopack-results__header-left';
      headerLeft.appendChild(makeAutoPackGrip());
      const titleWrap = document.createElement('div');
      titleWrap.className = 'tp3d-autopack-results__title-wrap';
      const title = document.createElement('div');
      title.className = 'tp3d-autopack-results__title';
      title.textContent = 'AutoPack Results';
      titleWrap.appendChild(title);
      // Staleness must stay visible in every mode — the header renders in the
      // carousel, compact, and minimized states alike, so the badge lives here.
      if (stale) {
        const staleBadge = document.createElement('span');
        staleBadge.className = 'tp3d-autopack-results__stale-badge';
        staleBadge.textContent = 'Outdated — rerun AutoPack';
        titleWrap.appendChild(staleBadge);
      }
      headerLeft.appendChild(titleWrap);

      const headerActions = document.createElement('div');
      headerActions.className = 'tp3d-autopack-results__header-actions';
      // A single chevron toggles collapse/expand: up collapses the panel to its
      // header, down restores it. Close stays a separate dismiss action.
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'tp3d-autopack-results__icon-btn';
      toggleBtn.setAttribute('aria-label', minimized ? 'Restore AutoPack results' : 'Minimize AutoPack results');
      toggleBtn.dataset.focusKey = 'results-toggle';
      toggleBtn.innerHTML = `<i class="fa-solid fa-chevron-${minimized ? 'down' : 'up'}"></i>`;
      toggleBtn.addEventListener('click', () => patchAutoPackResultsState({ minimized: !minimized }, results.runId));
      headerActions.appendChild(toggleBtn);
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tp3d-autopack-results__icon-btn';
      closeBtn.setAttribute('aria-label', 'Close AutoPack results');
      closeBtn.dataset.focusKey = 'results-close';
      closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      closeBtn.addEventListener('click', () => patchAutoPackResultsState({ closed: true }, results.runId));
      headerActions.appendChild(closeBtn);

      header.appendChild(headerLeft);
      header.appendChild(headerActions);
      panel.appendChild(header);

      // Collapsed: render only the header (still the drag handle) — nothing below.
      if (minimized) {
        placeAutoPackResultsEl(panel);
        restoreEditorFocus(previousFocus, panel, toggleBtn);
        return;
      }

      const body = document.createElement('div');
      body.className = 'tp3d-autopack-results__body';

      // Multiple results: a compact one-at-a-time carousel (Option X of Y +
      // arrows). Prev/Next only move the UI view index; applying is unchanged.
      if (hasAlternates) {
        const nav = document.createElement('div');
        nav.className = 'tp3d-autopack-results__carousel-nav';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'tp3d-autopack-results__icon-btn tp3d-autopack-results__carousel-arrow';
        prevBtn.setAttribute('aria-label', 'Previous AutoPack option');
        prevBtn.dataset.focusKey = 'results-prev';
        prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
        prevBtn.disabled = viewIndex <= 0;
        if (stale) prevBtn.disabled = true;
        prevBtn.addEventListener('click', () => patchAutoPackResultsState({ viewIndex: Math.max(0, viewIndex - 1), previewEnded: false }, results.runId));

        const counter = document.createElement('span');
        counter.className = 'tp3d-autopack-results__counter';
        counter.textContent = `Option ${viewIndex + 1} of ${options.length}`;

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'tp3d-autopack-results__icon-btn tp3d-autopack-results__carousel-arrow';
        nextBtn.setAttribute('aria-label', 'Next AutoPack option');
        nextBtn.dataset.focusKey = 'results-next';
        nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
        nextBtn.disabled = viewIndex >= options.length - 1;
        if (stale) nextBtn.disabled = true;
        nextBtn.addEventListener('click', () => patchAutoPackResultsState({ viewIndex: Math.min(options.length - 1, viewIndex + 1), previewEnded: false }, results.runId));

        nav.appendChild(prevBtn);
        nav.appendChild(counter);
        nav.appendChild(nextBtn);
        body.appendChild(nav);
      }

      const metrics = document.createElement('div');
      metrics.className = 'tp3d-autopack-results__metrics';
      const stats = document.createElement('div');
      stats.className = 'tp3d-autopack-results__stats';
      stats.appendChild(makeAutoPackResultStat('Packed', formatAutoPackResultNumber(viewedOption.packedCount)));
      stats.appendChild(makeAutoPackResultStat('Staged', formatAutoPackResultNumber(viewedOption.stagedCount)));
      stats.appendChild(makeAutoPackResultStat('Volume', formatAutoPackResultVolume(viewedOption.volumePercent)));
      metrics.appendChild(stats);
      body.appendChild(metrics);

      // Single-option mode has no option title row; the strategy description
      // still explains what kind of load the user is looking at.
      if (!hasAlternates && !viewedOption.assessment && currentOption) {
        const compactDescription = makeAutoPackResultDescription(viewedOption);
        if (compactDescription) body.appendChild(compactDescription);
      }

      // Multiple results: name the viewed option, show its status, mark the
      // run's Recommended plan and the Applied one (independent states), and
      // keep Apply on the existing validated apply path.
      if (hasAlternates || viewedOption.assessment || !currentOption) {
        const isViewedCurrent = viewedOption === currentOption;
        // Only the preferred VALID + eligible normal candidate is Recommended.
        const isViewedRecommended = viewedOption.id === results.selectedId && viewedOption.id !== 'max-capacity' &&
          (!viewedOption.assessment || (viewedOption.assessment.primary === 'VALID' && isNormalAutoPackCandidateAcceptable(viewedOption)));
        const optionRow = document.createElement('div');
        optionRow.className = 'tp3d-autopack-results__carousel-body';

        const labelRow = document.createElement('div');
        labelRow.className = 'tp3d-autopack-results__carousel-title-row';
        const label = document.createElement('div');
        label.className = 'tp3d-autopack-results__option-title';
        label.textContent = viewedOption.label || viewedOption.strategy || 'Load option';
        labelRow.appendChild(label);
        const badges = document.createElement('span');
        badges.className = 'tp3d-autopack-results__badges';
        const status = document.createElement('span');
        status.className = `tp3d-autopack-results__status tp3d-autopack-results__status--${viewedOption.status === 'complete' ? 'complete' : 'partial'}`;
        status.textContent = viewedOption.statusLabel || (viewedOption.status === 'complete' ? 'Complete' : 'Partial');
        if (viewedOption.status !== 'complete') {
          const partialReason = formatAutoPackPartialReason(viewedOption);
          if (partialReason) {
            status.title = partialReason;
            status.setAttribute('aria-label', `Partial. ${partialReason}`);
          }
        }
        badges.appendChild(status);
        if (isViewedRecommended) {
          badges.appendChild(makeAutoPackResultPill('tp3d-autopack-results__recommended-pill', 'Recommended'));
        }
        if (isViewedCurrent) {
          badges.appendChild(makeAutoPackResultPill('tp3d-autopack-results__current-pill', 'Applied', 'fa-solid fa-check'));
        }
        labelRow.appendChild(badges);
        optionRow.appendChild(labelRow);
        const optionDescription = makeAutoPackResultDescription(viewedOption);
        if (optionDescription) optionRow.appendChild(optionDescription);
        const reviewReason = describeAutoPackReviewReason(viewedOption.assessment);
        if (reviewReason) {
          const review = makeAutoPackResultPill('tp3d-autopack-results__relaxed-note',
            `Needs review · ${reviewReason}`, 'fa-solid fa-triangle-exclamation');
          review.dataset.role = 'autopack-review-note';
          optionRow.appendChild(review);
        }
        // Max Capacity relaxes handling preferences: say so in visible text,
        // never only in a tooltip or accessible label.
        if (viewedOption.id === 'max-capacity') {
          optionRow.appendChild(makeAutoPackResultPill(
            'tp3d-autopack-results__relaxed-note',
            'Handling rules relaxed. Review before transport.',
            'fa-solid fa-triangle-exclamation'
          ));
        }

        const actions = document.createElement('div');
        actions.className = 'tp3d-autopack-results__carousel-actions';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.dataset.focusKey = 'results-apply';
        apply.className = `btn btn-sm btn-primary tp3d-autopack-results__apply-btn${isViewedCurrent ? ' tp3d-autopack-results__apply-btn--applied' : ''}`;
        apply.disabled = isViewedCurrent || stale ||
          (viewedOption.id !== 'max-capacity' && viewedOption.assessment && !isNormalAutoPackCandidateAcceptable(viewedOption));
        if (isViewedCurrent) {
          apply.innerHTML = '<i class="fa-solid fa-check"></i> Applied';
        } else {
          apply.textContent = 'Apply this option';
          // Disabled-but-not-applied only happens when stale: give the native
          // disabled button a reachable explanation (hover tooltip + a11y label)
          // since a disabled button never fires click, so it can never reach the
          // toast in applyAutoPackResultOption. Deliberately reworded from the
          // removed persistent panel text, not a duplicate of it.
          if (stale) {
            const staleReason = 'Outdated — rerun AutoPack to refresh this option.';
            apply.title = staleReason;
            apply.setAttribute('aria-label', `Apply this option. ${staleReason}`);
          }
        }
        apply.addEventListener('click', () => applyAutoPackResultOption(viewedOption.id, results.runId));
        actions.appendChild(apply);
        if (results.previewEnded === true && !isViewedCurrent) {
          const preview = document.createElement('button');
          preview.type = 'button';
          preview.className = 'btn btn-sm';
          preview.textContent = 'Preview this option';
          preview.disabled = stale;
          preview.addEventListener('click', () => patchAutoPackResultsState({ previewEnded: false }, results.runId));
          actions.appendChild(preview);
        }
        optionRow.appendChild(actions);
        body.appendChild(optionRow);
      }

      // Dedupe transparency, single-option mode only: that is the case where a
      // user genuinely wonders where the other options went. With alternates
      // visible the carousel already tells the story, so the note stays quiet.
      if (!hasAlternates && (results.deduplicatedSolutionCount !== undefined
        ? results.deduplicatedSolutionCount > 0 : Number(results.attemptedSolutionCount) > options.length)) {
        const dedupeNote = document.createElement('div');
        dedupeNote.className = 'tp3d-autopack-results__dedupe-note';
        dedupeNote.textContent = 'Other strategies produced the same layout.';
        body.appendChild(dedupeNote);
      }

      panel.appendChild(body);
      placeAutoPackResultsEl(panel);
      restoreEditorFocus(previousFocus, panel, toggleBtn);
    }

    function initEditorUI() {
      if (!supportsWebGL) {
        SystemOverlay.show({
          title: 'Editor unavailable',
          message: 'This device does not support WebGL, so the 3D Editor cannot run here.',
          items: ['Try a different browser (Chrome/Safari)', 'Update iOS/Android', 'Use a desktop device'],
        });
      }

      caseSearchEl.addEventListener('input', Utils.debounce(renderCaseBrowser, 250));
      if (caseFilterToggleEl) {
        const searchWrapEl = caseSearchEl ? caseSearchEl.closest('.tp3d-editor-case-search') : null;
        if (searchWrapEl && caseChipsEl && caseChipsEl.parentElement !== searchWrapEl) {
          searchWrapEl.appendChild(caseChipsEl);
        }
        try {
          const stored = window.localStorage.getItem(caseFiltersStorageKey);
          if (stored === '0') showCaseFilters = false;
        } catch {
          // ignore
        }
        setCaseFiltersVisible(showCaseFilters, false);
        caseFilterToggleEl.addEventListener('click', () => {
          setCaseFiltersVisible(!showCaseFilters, true);
        });
        document.addEventListener('click', ev => {
          if (!showCaseFilters) return;
          if (!(ev.target instanceof Node)) return;
          // A chip click rebuilds the popup before the click reaches here, so the
          // clicked chip is already detached; composedPath() is fixed at dispatch
          // and still records it as inside the filter surface.
          const path = ev.composedPath();
          if (path.includes(caseFilterToggleEl)) return;
          if (caseChipsEl && path.includes(caseChipsEl)) return;
          setCaseFiltersVisible(false, true);
        });
        window.addEventListener('resize', fitCaseFilterPopup);
        // The open filter popup joins the shared popup owner registry: wherever
        // focus is, its Escape comes first (focus back on the toggle), before the
        // deselect shortcut or the mobile drawer close, and Editor keys wait.
        UIComponents.registerDropdownSurface?.({
          isOpen: () => showCaseFilters,
          close: () => setCaseFiltersVisible(false, true),
          getAnchor: () => caseFilterToggleEl,
        });
      }
      btnLeft.addEventListener('click', () => togglePanel('left'));
      btnZoomIn?.addEventListener('click', () => applyZoomStep(1));
      btnZoomOut?.addEventListener('click', () => applyZoomStep(-1));
      btnRight.addEventListener('click', () => togglePanel('right'));
      btnLeftClose.addEventListener('click', () => setPanelVisible('left', false));
      btnRightClose.addEventListener('click', () => setPanelVisible('right', false));
      // A drawer closes only on an Escape nothing earlier consumed (a deselect,
      // a Qty revert, a popup or modal owner).
      window.addEventListener('keydown', ev => {
        if (ev.key !== 'Escape' || ev.defaultPrevented || UIComponents.modalOwnership?.getActiveOwner() ||
            StateStore.get('currentScreen') !== 'editor' ||
            !window.matchMedia('(max-width: 899px)').matches) return;
        if (rightEl.classList.contains('open')) {
          setPanelVisible('right', false);
          btnRight.focus();
        } else if (leftEl.classList.contains('open')) {
          setPanelVisible('left', false);
          btnLeft.focus();
        } else {
          return;
        }
        ev.preventDefault();
      });
      syncPanelAccessibility();

      // Keep the action-bar working/spinner/disabled states in lockstep with the
      // authoritative operation lifecycle, so a working state appears the instant any
      // operation (AutoPack/Unpack/Truck Change/preview capture) begins or ends.
      if (OperationLifecycle && typeof OperationLifecycle.subscribe === 'function') {
        let autoPackLoadingShown = false;
        OperationLifecycle.subscribe(operation => {
          const autoPackLoading = Boolean(operation && operation.kind === 'autopacking');
          const autoPackLoadingChanged = autoPackLoading !== autoPackLoadingShown;
          autoPackLoadingShown = autoPackLoading;
          const fullRenderDue = selectionRenderPending && !OperationLifecycle.isBusy();
          if (StateStore.get('currentScreen') === 'editor') {
            refreshActionButtons();
            const pack = PackLibrary.getById(StateStore.get('currentPackId'));
            if (autoPackLoadingChanged && pack && !fullRenderDue) {
              // AutoPack starting or finishing flips Load Summary and Space
              // Utilization between "Updating…" and the committed Pack values.
              renderInspector(pack);
            } else if (inspectorEl?.querySelector('[data-role="space-utilization-gauge"]')) {
              // Refresh Space Utilization only where the Truck Inspector already
              // renders it; a lifecycle change must never add it to a selection state.
              renderSpaceUtilizationSection(pack);
            }
          }
          if (fullRenderDue) render();
          if (pendingViewSave && !OperationLifecycle.isBusy()) {
            queueMicrotask(() => persistSettledView());
          }
        });
      }

      resultsReopenBtn?.addEventListener('click', reopenAutoPackResults);

      btnAutopack.addEventListener('click', async () => {
        // Cross-operation guard: the engine also rejects, but this avoids even
        // queueing a run while another operation owns the editor.
        if (OperationLifecycle && OperationLifecycle.isBusy()) {
          UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'AutoPack' });
          return;
        }
        try {
          await AutoPackEngine.pack();
        } catch (err) {
          console.error('[EditorScreen] AutoPack error:', err);
          UIComponents.showToast('AutoPack failed. Please try again.', 'error');
        } finally {
          render();
        }
      });
      if (btnUnpack) {
        btnUnpack.addEventListener('click', () => {
          Promise.resolve()
            .then(() => unpackAll())
            .catch(err => {
              console.error('[EditorScreen] Unpack error:', err);
              UIComponents.showToast('Unpack failed. Please try again.', 'error', { title: 'Unpack' });
            });
        });
      }
      btnPng.addEventListener('click', () => {
        Promise.resolve()
          .then(() => ExportService.captureScreenshot())
          .catch(err => {
            console.error('[EditorScreen] Screenshot error:', err);
            UIComponents.showToast('Screenshot failed.', 'error');
          });
      });
      btnPdf.addEventListener('click', () => {
        Promise.resolve()
          .then(() => ExportService.generatePDF())
          .catch(err => {
            console.error('[EditorScreen] PDF export error:', err);
            UIComponents.showToast('PDF export failed.', 'error');
          });
      });
      if (btnShare) {
        btnShare.addEventListener('click', ev => {
          ev.stopPropagation();
          UIComponents.openDropdown(
            btnShare,
            [
              { label: 'Screenshot', icon: 'fa-solid fa-camera', onClick: () => btnPng.click() },
              { label: 'Export PDF', icon: 'fa-solid fa-file-pdf', onClick: () => btnPdf.click() },
            ],
            { width: 200, align: 'left', role: 'editor-share', menuSemantics: true }
          );
        });
      }
      // The two floating managers never cover each other. A dragged panel that lands on the other one moves to the nearest clear spot
      // in its host, or gives its position back to the default when there is none. Only the panel that moved is changed.
      const apartRects = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      const avoidManagerOverlap = panel => {
        const other = document.getElementById(panel.id === 'editor-measure-panel' ? 'editor-annotation-panel' : 'editor-measure-panel');
        if (!other || other.hidden || !other.getClientRects().length || !panel.getClientRects().length) return null;
        const host = panel.offsetParent;
        if (!host) return null;
        const d = panel.getBoundingClientRect();
        const o = other.getBoundingClientRect();
        if (apartRects(d, o)) return null;
        const h = host.getBoundingClientRect();
        const gap = 10;
        const spots = [
          { left: o.left - gap - d.width, top: d.top },
          { left: o.right + gap, top: d.top },
          { left: d.left, top: o.bottom + gap },
          { left: d.left, top: o.top - gap - d.height },
        ].map(p => ({ ...p, right: p.left + d.width, bottom: p.top + d.height }));
        const fits = spots.filter(p => p.left >= h.left && p.top >= h.top && p.right <= h.right && p.bottom <= h.bottom && apartRects(p, o));
        if (!fits.length) return 'reset';
        fits.sort((a, b) => Math.hypot(a.left - d.left, a.top - d.top) - Math.hypot(b.left - d.left, b.top - d.top));
        return { x: fits[0].left - h.left - host.clientLeft, y: fits[0].top - h.top - host.clientTop };
      };
      let settleTimer = null;
      window.addEventListener('resize', () => {
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          if (MeasurementTool) MeasurementTool.settle();
          if (AnnotationTool) AnnotationTool.settle();
        }, 120);
      });
      if (MeasurementTool && btnMeasure) {
        MeasurementTool.bind({
          avoidOther: avoidManagerOverlap,
          button: btnMeasure,
          panel: document.getElementById('editor-measure-panel'),
          labels: document.getElementById('editor-measure-labels'),
          viewport: viewportEl,
          // New Measurement ends an armed Callout, Arrow or Draw first; a dirty callout draft asks before it closes.
          canStart: () => (AnnotationTool ? AnnotationTool.releaseForMeasurement() : true),
          // The load-status popover closes on Escape first; Measurement Mode exits on the next one.
          escapeOwnedElsewhere: () => validationPopoverOpen,
          // A live drag, gizmo stroke or held case displays cargo away from its committed pose.
          hasProvisionalPose: () => Boolean(InteractionManager && InteractionManager.hasProvisionalPose && InteractionManager.hasProvisionalPose()),
          // Selecting a saved measurement replaces the cargo and annotation selections (so Delete never reaches cargo through it).
          clearOtherSelections: () => {
            if (InteractionManager && typeof InteractionManager.setSelection === 'function') InteractionManager.setSelection([]);
            if (AnnotationTool) AnnotationTool.select(null);
          },
          // An armed Callout, Arrow or Draw keeps the canvas: a selected measurement's grips take no press meanwhile.
          isAnnotationToolActive: () => Boolean(AnnotationTool && AnnotationTool.isActive()),
        });
        btnMeasure.addEventListener('click', ev => {
          ev.stopPropagation();
          UIComponents.closeAllDropdowns();
          // The toolbar button shows or hides the Measurements manager. It never starts a measurement: that is the panel's
          // New Measurement control. The Annotations panel is left alone, so both managers can be open.
          if (MeasurementTool.isManagerOpen()) {
            // Closing the manager ends creation but keeps a selected measurement selected and editable.
            MeasurementTool.closeManager({ keepSelection: true });
          } else {
            if (!PackLibrary.getById(StateStore.get('currentPackId'))) {
              UIComponents.showToast(NO_LOAD_PLAN_MESSAGE, 'warning', { title: 'Measurements' });
              return;
            }
            if (!MeasurementTool.openManager()) {
              UIComponents.showToast('The 3D view is not ready yet.', 'info', { title: 'Measurements' });
            }
          }
          // Measurement Mode takes over the pointer, and returns it on exit: drop stale hover emphasis.
          if (InteractionManager && typeof InteractionManager.resetHover === 'function') InteractionManager.resetHover();
        });
        MeasurementTool.syncVisibility();
      }
      if (AnnotationTool && btnAnnotations) {
        AnnotationTool.bind({
          button: btnAnnotations,
          panel: document.getElementById('editor-annotation-panel'),
          avoidOther: avoidManagerOverlap,
          layer: document.getElementById('editor-annotation-layer'),
          viewport: viewportEl,
          // The load-status popover closes on Escape first; the Annotations tool takes the next one.
          escapeOwnedElsewhere: () => validationPopoverOpen,
          // A live drag, gizmo stroke or held case displays cargo away from its committed pose.
          hasProvisionalPose: () => Boolean(InteractionManager && InteractionManager.hasProvisionalPose && InteractionManager.hasProvisionalPose()),
          // Selecting an annotation clears the cargo selection (so Delete never touches cargo).
          clearCargoSelection: () => { if (InteractionManager && typeof InteractionManager.setSelection === 'function') InteractionManager.setSelection([]); },
          // Selecting an annotation (or arming a creator) also drops a saved measurement's selection.
          clearMeasurementSelection: () => { if (MeasurementTool) MeasurementTool.clearSelection(); },
          // A read-only question: does Measurement Mode own the scene's gestures right now? Saved callouts stay
          // drawn but take no input while it does.
          isSceneToolOwnedElsewhere: () => Boolean(MeasurementTool && MeasurementTool.isActive()),
          // Arming a creator here ends an unfinished Measurement creation (no write), so only one creator is ever armed.
          endOtherScene: () => { if (MeasurementTool && MeasurementTool.isActive()) MeasurementTool.cancelCreation(); },
        });
        btnAnnotations.addEventListener('click', ev => {
          ev.stopPropagation();
          UIComponents.closeAllDropdowns();
          const wasOpen = AnnotationTool.isPanelOpen();
          if (!wasOpen && !PackLibrary.getById(StateStore.get('currentPackId'))) {
            UIComponents.showToast(NO_LOAD_PLAN_MESSAGE, 'warning', { title: 'Annotations' });
            return;
          }
          AnnotationTool.togglePanel();
          if (!wasOpen && !AnnotationTool.isPanelOpen()) {
            UIComponents.showToast('The 3D view is not ready yet.', 'info', { title: 'Annotations' });
          }
          if (InteractionManager && typeof InteractionManager.resetHover === 'function') InteractionManager.resetHover();
        });
        AnnotationTool.syncVisibility();
      }
      if (btnView) {
        btnView.addEventListener('click', ev => {
          ev.stopPropagation();
          const presets = [
            ['Fit Truck', 'fit'], ['Isometric', 'isometric'], ['Front', 'front'],
            ['Rear', 'rear'], ['Left', 'left'], ['Right', 'right'], ['Top', 'top'],
          ];
          UIComponents.openDropdown(
            btnView,
            [
              { type: 'header', label: 'Camera View', fontSize: '14px' },
              ...presets.map(([label, preset]) => ({
                label, rightIcon: 'fa-solid fa-check', radio: true, radioGroup: 'Camera view',
                checked: activeCameraPreset === preset,
                onClick: () => applyCameraPreset(preset),
              })),
              { type: 'divider' },
              { type: 'header', label: 'Projection', fontSize: '14px' },
              ...['perspective', 'orthographic'].map(projection => ({
                label: projection === 'perspective' ? 'Perspective' : 'Orthographic',
                rightIcon: 'fa-solid fa-check', radio: true, radioGroup: 'Projection',
                checked: Boolean(SceneManager.getCamera()?.isOrthographicCamera) === (projection === 'orthographic'),
                onClick: () => applyCameraProjection(projection),
              })),
            ],
            { width: 156, minWidth: 156, placement: 'left', placementLift: 32, role: 'editor-view', menuSemantics: true, toggle: true }
          );
        });
      }
      const handleViewportChange = Utils.debounce(() => {
        if (StateStore.get('currentScreen') === 'editor') onActivated();
      }, 160);

      window.addEventListener('resize', handleViewportChange);
      window.addEventListener('orientationchange', handleViewportChange);
      if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
        window.visualViewport.addEventListener('resize', handleViewportChange);
      }
      if (!sceneHostResizeObserver && viewportEl && typeof ResizeObserver === 'function') {
        sceneHostResizeObserver = new ResizeObserver(() => {
          if (StateStore.get('currentScreen') === 'editor') syncEditorSceneLayout();
        });
        sceneHostResizeObserver.observe(viewportEl);
      }
    }

    function ensureScene() {
      if (initialized || !supportsWebGL) return;
      SceneManager.init(viewportEl);
      const controls = SceneManager.getControls();
      controls.addEventListener('start', () => {
        if (!isViewOwnerCurrent()) return;
        clearViewSettle();
        SceneManager.cancelFocus();
        viewFocusActive = false;
        focusRevision = null;
        viewGestureActive = true;
        viewRevision++;
      });
      controls.addEventListener('change', () => {
        if (activeCameraPreset && isViewOwnerCurrent() &&
            editorViewSignature(SceneManager.getEditorView()) !== activePresetSignature) {
          clearActiveCameraPreset();
        }
        if (viewPendingEnd && isViewOwnerCurrent()) scheduleViewSettle(viewRevision);
      });
      controls.addEventListener('end', () => {
        if (!viewGestureActive || !isViewOwnerCurrent()) return;
        viewGestureActive = false;
        viewPendingEnd = true;
        scheduleViewSettle(viewRevision);
      });
      SceneManager.setFocusViewCallbacks({
        onStart: () => {
          if (!isViewOwnerCurrent()) return;
          clearViewSettle();
          viewGestureActive = false;
          viewFocusActive = true;
          focusRevision = ++viewRevision;
          clearActiveCameraPreset();
        },
        onComplete: () => {
          if (!isViewOwnerCurrent() || focusRevision !== viewRevision) return;
          viewFocusActive = false;
          focusRevision = null;
          persistSettledView();
        },
      });
      InteractionManager.init(SceneManager.getRenderer().domElement);
      wireDropToViewport(SceneManager.getRenderer().domElement);
      initialized = true;
    }

    function render() {
      const previousPreviewScene = previewScene;
      previewScene = null;
      selectionRenderPending = false;
      if (StateStore.get('currentScreen') !== 'editor') {
        setValidationPopoverOpen(false);
        return;
      }
      ensureScene();
      syncViewportControls();

      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);

      refreshActionButtons();

      if (!pack) {
        invalidateViewOwner();
        const defaultTruck = { length: 636, width: 102, height: 98 };
        SceneManager.setTruck(defaultTruck);
        CaseScene.sync(null);
        SceneManager.applyEditorView(SceneManager.getDefaultEditorView(defaultTruck));
        renderCaseBrowser();
        renderInspectorNoPack();
        renderAutoPackResultsPanel(null);
        renderHandlingRulesStatus(null);
        SceneManager.resize();
        return;
      }

      SceneManager.setTruck(pack.truck);
      // The scene follows the Results card's viewed option (transient preview),
      // else the committed Pack. Scene authority below stays Pack-only.
      const wasResultsPreview = CaseScene.isTransientPreview();
      const resultsPreviewPack = getAutoPackResultsPreviewPack(pack);
      CaseScene.sync(resultsPreviewPack || pack, { transientPreview: Boolean(resultsPreviewPack) });
      CaseScene.setSelected(StateStore.get('selectedInstanceIds') || []);
      CaseScene.applyOOGHighlights();

      renderCaseBrowser();
      renderInspector(pack);
      renderAutoPackResultsPanel(pack);
      renderHandlingRulesStatus(pack);
      // Re-derive measurement validity from the freshly committed Pack (cargo, Case or truck changed).
      if (MeasurementTool) MeasurementTool.sync();
      if (AnnotationTool) AnnotationTool.sync();
      SceneManager.resize();
      if (!isViewOwnerCurrent()) {
        invalidateViewOwner();
        // Fit after the Inspector and viewport have their opening dimensions.
        // Same-Pack hydration and updates retain the user's active view.
        const savedView = normalizeEditorView(pack.editorView);
        const projection = savedView
          ? savedView.projection || 'perspective'
          : PreferencesManager.get().camera.defaultView;
        SceneManager.applyEditorView(SceneManager.getDefaultEditorView(pack.truck, projection));
        pendingViewSave = false;
        viewOwner = { packId: pack.id, scope: CoreStorage.captureScopeContext() };
      }
      if (initialized && CaseScene.getSyncedPack() === pack) {
        // A same-commit repaint (including AutoPack's final UI render) is not
        // context loss. Preserve its identity so a valid frame wait can finish.
        const visualSignature = CaseScene.getVisualSignature(pack);
        previewScene = previousPreviewScene && previousPreviewScene.pack === pack &&
          previousPreviewScene.visualSignature === visualSignature &&
          previousPreviewScene.scene === SceneManager.getScene() &&
          CoreStorage.isScopeContextCurrent(previousPreviewScene.scope)
          ? previousPreviewScene
          : { pack, visualSignature, scope: CoreStorage.captureScopeContext(), scene: SceneManager.getScene() };
      }
      // A preview refuses thumbnail capture; when it ends on the committed Pack,
      // re-request the freshness check so that Pack's thumbnail never stays stale.
      if (wasResultsPreview && previewScene && onPreviewViewSettled) queueMicrotask(() => onPreviewViewSettled());
      if (pendingViewSave) queueMicrotask(() => persistSettledView());
    }

    // Annotations, Measurement Tool, Camera Views, Zoom In and Zoom Out are shown or hidden
    // independently by their Settings preferences; the floating group hides only when none remain.
    // This is visibility only: it never renders the Editor or touches the scene, camera or Pack.
    // Hiding the ruler while Measurement Mode is active exits the mode and cancels an unfinished
    // point; hiding Annotations closes its panel, cancels any unfinished gesture without writing
    // and takes the graphics off the view. Saved measurements and annotations are untouched.
    function syncViewportControls() {
      if (!zoomControlsEl) return;
      const prefs = PreferencesManager.get();
      const showCamera = prefs.showCameraControls !== false;
      const showZoom = prefs.showZoomControls !== false;
      const showAnnotations = prefs.showAnnotations !== false;
      const showMeasure = prefs.showMeasurementTool !== false;
      if (!showAnnotations && btnAnnotations && btnAnnotations.contains(document.activeElement)) {
        viewportEl?.focus({ preventScroll: true });
      }
      if (AnnotationTool) AnnotationTool.syncVisibility();
      else if (btnAnnotations) btnAnnotations.hidden = !showAnnotations;
      if (!showMeasure && btnMeasure && btnMeasure.contains(document.activeElement)) {
        viewportEl?.focus({ preventScroll: true });
      }
      if (MeasurementTool) MeasurementTool.syncVisibility();
      else if (btnMeasure) btnMeasure.hidden = !showMeasure;
      // Hiding the Camera Views button must also dismiss its open menu.
      const openMenu = showCamera ? null : document.querySelector('[data-dropdown="1"][data-role="editor-view"]');
      const hiding = [];
      if (!showCamera && btnView) hiding.push(btnView);
      if (!showZoom && btnZoomIn) hiding.push(btnZoomIn);
      if (!showZoom && btnZoomOut) hiding.push(btnZoomOut);
      const active = document.activeElement;
      const focusLost = hiding.some(control => control.contains(active)) || Boolean(openMenu && openMenu.contains(active));
      if (openMenu) UIComponents.closeAllDropdowns();
      if (focusLost) viewportEl?.focus({ preventScroll: true });
      if (btnView) btnView.hidden = !showCamera;
      if (btnZoomIn) btnZoomIn.hidden = !showZoom;
      if (btnZoomOut) btnZoomOut.hidden = !showZoom;
      zoomControlsEl.hidden = !((Boolean(btnAnnotations) && showAnnotations) || showMeasure || showCamera || showZoom);
    }

    // Selection-only change. While a mutating operation owns the Editor the scene
    // can be ahead of what it shows (an AutoPack animation runs over poses the
    // Pack has already committed), so a full render's CaseScene.sync would snap
    // every mesh to its committed pose mid-animation. Keep the scene selection in
    // step with the app selection now, and render fully when the operation ends.
    // Outside the Editor the scene is not shown: render() returns before touching
    // it and clears any deferred render, and re-entering the Editor renders the
    // selection current at that time.
    function renderSelection() {
      if (StateStore.get('currentScreen') === 'editor' && OperationLifecycle && OperationLifecycle.isBusy()) {
        CaseScene.setSelected(StateStore.get('selectedInstanceIds') || []);
        selectionRenderPending = true;
        return;
      }
      render();
    }

    function syncEditorSceneLayout() {
      if (!initialized || !viewportEl || StateStore.get('currentScreen') !== 'editor') return;
      const rect = viewportEl.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) return;
      SceneManager.resize();
    }

    function scheduleEditorSceneLayoutSync() {
      if (layoutRaf) window.cancelAnimationFrame(layoutRaf);
      layoutRaf = window.requestAnimationFrame(() => {
        layoutRaf = null;
        syncEditorSceneLayout();
      });
    }

    function onActivated() {
      // Entering (or re-entering) the Editor always starts with the status panel closed.
      setValidationPopoverOpen(false);
      syncPanelAccessibility();
      if (!supportsWebGL || !viewportEl) return;
      ensureScene();
      scheduleEditorSceneLayoutSync();
    }

    function normalizeBrowserFilterKey(value) {
      return String(value || '')
        .trim()
        .toLowerCase();
    }

    function getManufacturerFilterKey(value) {
      return normalizeBrowserFilterKey(value) || '__no_manufacturer__';
    }

    function getManufacturerFilterLabel(value) {
      return String(value || '').trim() || '(No manufacturer)';
    }

    function getManufacturerFilterColor(value) {
      const key = getManufacturerFilterKey(value);
      if (key === '__no_manufacturer__') return '#9b9ba8';
      const palette = [
        '#f59e0b',
        '#3b82f6',
        '#10b981',
        '#ec4899',
        '#8b5cf6',
        '#14b8a6',
        '#f97316',
        '#6366f1',
        '#84cc16',
        '#ef4444',
      ];
      let hash = 0;
      for (let i = 0; i < key.length; i += 1) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      }
      return palette[hash % palette.length];
    }

    function getManufacturerFilterOptions(cases) {
      const options = new Map();
      (Array.isArray(cases) ? cases : []).forEach(c => {
        const key = getManufacturerFilterKey(c && c.manufacturer);
        const label = getManufacturerFilterLabel(c && c.manufacturer);
        const existing = options.get(key) || { key, name: label, count: 0, color: getManufacturerFilterColor(label) };
        // Spelling variants ("Acme", "ACME", " acme ") share one key; show one
        // deterministic label regardless of Case Library order.
        if (label.localeCompare(existing.name) < 0) existing.name = label;
        existing.count += 1;
        options.set(key, existing);
      });
      return Array.from(options.values()).sort((a, b) => {
        if (a.key === '__no_manufacturer__') return 1;
        if (b.key === '__no_manufacturer__') return -1;
        return a.name.localeCompare(b.name);
      });
    }

    function renderCaseBrowser() {
      const browserControlsHost = caseSearchEl ? caseSearchEl.closest('.tp3d-editor-case-search') : null;
      const staleBrowserControls = caseListEl && caseListEl.parentElement
        ? caseListEl.parentElement.querySelector('.tp3d-editor-browser-tabs')
        : null;
      if (staleBrowserControls && browserControlsHost && staleBrowserControls.parentElement !== browserControlsHost) {
        staleBrowserControls.remove();
      }
      if (browserControlsHost && !browserControlsHost.querySelector('.tp3d-editor-browser-tabs')) {
        const tabsEl = document.createElement('div');
        tabsEl.className = 'tp3d-editor-browser-tabs';
        const groupTabsEl = document.createElement('div');
        groupTabsEl.className = 'tp3d-editor-browser-group-tabs';
        const btnCat = document.createElement('button');
        btnCat.type = 'button';
        btnCat.className = 'btn btn-sm tp3d-browser-tab';
        btnCat.dataset.groupBy = 'category';
        btnCat.innerHTML = '<span class="tp3d-browser-tab-label">Category</span>';
        const btnMfg = document.createElement('button');
        btnMfg.type = 'button';
        btnMfg.className = 'btn btn-sm tp3d-browser-tab';
        btnMfg.dataset.groupBy = 'manufacturer';
        btnMfg.innerHTML = '<span class="tp3d-browser-tab-label">Manufacturer</span>';
        groupTabsEl.appendChild(btnCat);
        groupTabsEl.appendChild(btnMfg);
        const btnNewCase = document.createElement('button');
        btnNewCase.type = 'button';
        btnNewCase.className = 'btn btn-sm btn-primary tp3d-editor-new-case-btn';
        btnNewCase.setAttribute('data-role', 'editor-new-case');
        btnNewCase.setAttribute('aria-label', 'New case');
        btnNewCase.setAttribute('title', 'New case');
        btnNewCase.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btnNewCase.addEventListener('click', ev => {
          ev.stopPropagation();
          openEditorNewCaseModal();
        });
        tabsEl.appendChild(groupTabsEl);
        tabsEl.appendChild(btnNewCase);
        // Keep the (absolutely positioned) filter popup directly after the search
        // row in DOM order so Tab goes filter toggle → filter chips; the popup's
        // containing block is the sticky search block, so layout is unchanged.
        const searchRow = browserControlsHost.querySelector('.tp3d-editor-case-search-row');
        const tabsAnchor = caseChipsEl && caseChipsEl.parentElement === browserControlsHost ? caseChipsEl : searchRow;
        browserControlsHost.insertBefore(tabsEl, tabsAnchor ? tabsAnchor.nextSibling : null);
        tabsEl.addEventListener('click', ev => {
          if (!(ev.target instanceof Element)) return;
          const btn = ev.target.closest('[data-group-by]');
          if (!(btn instanceof HTMLElement)) return;
          caseBrowserGroupBy = btn.dataset.groupBy;
          renderCaseBrowser();
        });
      }
      const allCases = CaseLibrary.getCases();
      // Read-only: the empty-library category reset is published by the Case
      // deletion transition (PackLibrary.commitCaseDeletion), never by render.
      if (!allCases.length) {
        browserCats.clear();
        browserManufacturers.clear();
      }
      const activeBrowserFilters = caseBrowserGroupBy === 'manufacturer' ? browserManufacturers : browserCats;
      const manufacturerFilterOptions = getManufacturerFilterOptions(allCases);
      const categoryFilterOptions = CategoryService.listWithCounts(allCases);
      const browserFilterOptions = caseBrowserGroupBy === 'manufacturer' ? manufacturerFilterOptions : categoryFilterOptions;
      // Prune both group-by modes (each keeps its own selections across tab
      // switches) so retained counts never include options that no longer exist.
      [[browserCats, categoryFilterOptions], [browserManufacturers, manufacturerFilterOptions]].forEach(([filters, options]) => {
        const validFilterKeys = new Set(options.map(option => option.key));
        Array.from(filters).forEach(key => {
          if (!validFilterKeys.has(key)) filters.delete(key);
        });
      });
      syncCaseFilterIndicators();
      const allFilterCount = allCases.length;
      const q = String(caseSearchEl.value || '').trim();
      const prefs = PreferencesManager.get ? PreferencesManager.get() : { units: { length: 'in', weight: 'lb' } };
      const lengthUnit = (prefs.units && prefs.units.length) || 'in';
      const browserPack = PackLibrary.getById(StateStore.get('currentPackId'));

      // Qty/Add controls only apply when a Load Plan is open; show one Case
      // Browser-level message in their place otherwise (lazily created, same
      // reuse pattern as the browser tabs above) rather than repeating a
      // disabled control on every card.
      const qtyMessageHost = caseListEl && caseListEl.parentElement ? caseListEl.parentElement : null;
      let qtyMessageEl = /** @type {HTMLElement|null} */ (
        qtyMessageHost ? qtyMessageHost.querySelector('.tp3d-editor-case-qty-empty-message') : null
      );
      if (qtyMessageHost && !qtyMessageEl) {
        qtyMessageEl = document.createElement('div');
        qtyMessageEl.className = 'tp3d-editor-case-qty-empty-message muted';
        qtyMessageEl.textContent = 'Open a Load Plan to add quantities.';
        qtyMessageHost.insertBefore(qtyMessageEl, caseListEl);
      }
      if (qtyMessageEl) {
        qtyMessageEl.hidden = Boolean(browserPack);
      }

      const selectedInstanceIds = StateStore.get('selectedInstanceIds') || [];
      const selectedCaseIds = new Set();
      if (browserPack && selectedInstanceIds.length) {
        (browserPack.cases || []).forEach(inst => {
          if (selectedInstanceIds.includes(inst.id) && inst.caseId) selectedCaseIds.add(inst.caseId);
        });
      }
      let cases = CaseLibrary.search(q, caseBrowserGroupBy === 'category' ? Array.from(browserCats) : []);
      if (caseBrowserGroupBy === 'manufacturer' && browserManufacturers.size) {
        cases = cases.filter(c => browserManufacturers.has(getManufacturerFilterKey(c && c.manufacturer)));
      }
      cases = cases.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      // Rebuilding the chips (including from the chip's own click) must not drop
      // focus to BODY or jump the popup: restore both by stable filter key.
      const focusedChipEl = document.activeElement;
      const focusedFilterKey = focusedChipEl instanceof HTMLElement && caseChipsEl.contains(focusedChipEl)
        ? focusedChipEl.dataset.filterKey
        : null;
      const savedChipsScrollTop = caseChipsEl.scrollTop;
      caseChipsEl.innerHTML = '';
      caseChipsEl.appendChild(
        makeBrowserChip(
          'All',
          allFilterCount,
          'all',
          activeBrowserFilters.size === 0,
          () => {
            activeBrowserFilters.clear();
            renderCaseBrowser();
          },
          '#9b9ba8'
        )
      );
      browserFilterOptions.forEach(c => {
        const active = activeBrowserFilters.has(c.key);
        caseChipsEl.appendChild(
          makeBrowserChip(
            c.name,
            c.count,
            c.key,
            active,
            () => {
              if (activeBrowserFilters.has(c.key)) activeBrowserFilters.delete(c.key);
              else activeBrowserFilters.add(c.key);
              renderCaseBrowser();
            },
            c.color
          )
        );
      });
      setCaseFiltersVisible(showCaseFilters, false);
      caseChipsEl.scrollTop = savedChipsScrollTop;
      if (focusedFilterKey != null) {
        const nextChipEl = caseChipsEl.querySelector(`[data-filter-key="${CSS.escape(focusedFilterKey)}"]`);
        if (nextChipEl instanceof HTMLElement) nextChipEl.focus({ preventScroll: true });
      }

      // Quantity Controls: a target quantity commit triggers a StateStore-driven
      // re-render, which tears down and rebuilds every card below. Capture scroll
      // position and, if a quantity control currently owns focus, which case/role
      // it belongs to, so a mid-edit commit does not steal focus or jump the list.
      const savedScrollTop = caseListEl.scrollTop;
      const activeElRaw = document.activeElement;
      const activeQtyEl = activeElRaw instanceof HTMLElement ? activeElRaw : null;
      // selectionStart/selectionEnd only exist on text-selectable inputs, not the
      // generic HTMLElement type; the cast is safe because the typeof checks
      // below tolerate any element (e.g. the +/− buttons) reading them as undefined.
      const activeQtyInput = /** @type {HTMLInputElement} */ (activeQtyEl);
      const focusedQtyInfo =
        activeQtyEl && caseListEl.contains(activeQtyEl) && activeQtyEl.dataset.qtyRole
          ? {
            caseId: activeQtyEl.dataset.caseId,
            role: activeQtyEl.dataset.qtyRole,
            selStart: typeof activeQtyInput.selectionStart === 'number' ? activeQtyInput.selectionStart : null,
            selEnd: typeof activeQtyInput.selectionEnd === 'number' ? activeQtyInput.selectionEnd : null,
          }
          : null;
      const restoreCaseBrowserFocusAndScroll = () => {
        caseListEl.scrollTop = savedScrollTop;
        if (!focusedQtyInfo) return;
        const nextElRaw = caseListEl.querySelector(
          `[data-case-id="${CSS.escape(focusedQtyInfo.caseId || '')}"][data-qty-role="${focusedQtyInfo.role}"]`
        );
        if (!(nextElRaw instanceof HTMLElement)) return;
        nextElRaw.focus();
        const nextInputEl = /** @type {HTMLInputElement} */ (nextElRaw);
        if (focusedQtyInfo.selStart != null && typeof nextInputEl.setSelectionRange === 'function') {
          try {
            nextInputEl.setSelectionRange(focusedQtyInfo.selStart, focusedQtyInfo.selEnd);
          } catch {
            // Some input types (e.g. number, in some browsers) do not support
            // selection reflection — focus restoration above still applies.
          }
        }
      };

      caseListEl.innerHTML = '';
      if (!cases.length) {
        caseListEl.appendChild(buildCaseBrowserEmptyState({
          libraryEmpty: allCases.length === 0,
          hasSearch: Boolean(q),
          hasFilters: activeBrowserFilters.size > 0,
        }));
        restoreCaseBrowserFocusAndScroll();
        return;
      }
      if (caseBrowserGroupBy === 'manufacturer') {
        // Group by the same normalized key (and label/order) as the Manufacturer
        // filter options, so spelling variants share one heading and bucket.
        const mfgGroups = new Map(
          manufacturerFilterOptions.map(option => [option.key, { name: option.name, cases: [] }])
        );
        cases.forEach(c => {
          const group = mfgGroups.get(getManufacturerFilterKey(c && c.manufacturer));
          if (group) group.cases.push(c);
        });
        mfgGroups.forEach(group => {
          if (!group.cases.length) return;
          const hdr = document.createElement('div');
          hdr.className = 'tp3d-editor-mfg-group-header';
          hdr.textContent = group.name;
          caseListEl.appendChild(hdr);
          group.cases.forEach(c => {
            caseListEl.appendChild(
              buildCaseBrowserCard(c, lengthUnit, prefs, selectedCaseIds.has(c.id), browserPack)
            );
          });
        });
        restoreCaseBrowserFocusAndScroll();
        return;
      }
      cases.forEach(c => {
        caseListEl.appendChild(
          buildCaseBrowserCard(c, lengthUnit, prefs, selectedCaseIds.has(c.id), browserPack)
        );
      });
      restoreCaseBrowserFocusAndScroll();
    }

    /**
     * Builds a single Case Browser catalog card (shared by the Category and
     * Manufacturer grouped views). Preserves drag-to-pack and Add behavior.
     * `pack` is the currently open Load Plan (or null) — only when set does the
     * card grow a Quantity Controls target section.
     */
    function buildCaseBrowserCard(c, lengthUnit, prefs, isSelected, pack) {
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.add('tp3d-editor-card-padding-12', 'tp3d-editor-card-grid-gap-8', 'tp3d-editor-case-browser-card');
      card.classList.toggle('tp3d-editor-case-browser-card--selected', Boolean(isSelected));
      card.draggable = true;
      card.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', c.id);
        ev.dataTransfer.effectAllowed = 'copy';
      });

      const header = document.createElement('div');
      header.className = 'tp3d-editor-card-header';
      const name = document.createElement('div');
      name.classList.add('tp3d-editor-fw-semibold');
      name.textContent = c.name;
      header.appendChild(name);
      const hasDims =
        c &&
        c.dimensions &&
        Number.isFinite(c.dimensions.length) &&
        Number.isFinite(c.dimensions.width) &&
        Number.isFinite(c.dimensions.height);
      const dimsLabel = hasDims ? Utils.formatDims(c.dimensions, lengthUnit) : '—';
      const catMeta = CategoryService.meta(c.category || 'default');
      const volumeLabel = hasDims
        ? Utils.formatVolume(c.dimensions, lengthUnit)
        : '—';
      const weightLabel = formatEditorCaseWeightLabel(c.weight, (prefs.units && prefs.units.weight) || 'lb');
      const meta1 = document.createElement('div');
      meta1.className = 'tp3d-editor-card-dims tp3d-editor-case-meta-primary';
      const parts = [dimsLabel, volumeLabel, weightLabel].filter(v => v && v !== '—');
      meta1.textContent = parts.join(' · ');

      const meta2 = document.createElement('div');
      meta2.className = 'tp3d-editor-card-dims tp3d-editor-case-meta-secondary';
      const catInline = document.createElement('span');
      catInline.className = 'tp3d-editor-cat-inline';
      const catDot = document.createElement('span');
      catDot.className = 'chip-dot';
      catDot.style.background = catMeta.color;
      catInline.appendChild(catDot);
      const meta2Parts = [catMeta.name, ...getCaseHandlingSummary(c)];
      catInline.appendChild(document.createTextNode(meta2Parts.join(' · ')));
      meta2.appendChild(catInline);

      card.appendChild(header);
      card.appendChild(meta1);
      card.appendChild(meta2);
      if (pack) {
        card.appendChild(buildCaseQtyAddRow(c, pack));
      }
      return card;
    }

    /**
     * Builds the compact Qty stepper + always-"+ Add" row for a Case Browser
     * card, plus the "in load / in truck / staged" readout beneath it. Qty is
     * an ephemeral per-Case session draft (caseQtyDrafts) — never read from or
     * written to the Pack/Case/StateStore/localStorage. Clicking "+ Add"
     * creates exactly the drafted Qty as new staged physical instances via
     * PackLibrary.addInstancesToStaging() (one atomic Pack update, one Undo
     * step). A full success resets the draft back to 1; any failure leaves the
     * Pack untouched and preserves the requested Qty.
     *
     * While the Case has staged cargo, "Unstage" joins "+ Add" as the left
     * segment of one segmented action control (Unstage | + Add). It removes the
     * chosen Qty from staging only, via PackLibrary.removeCaseInstancesFromStaging().
     */
    function buildCaseQtyAddRow(c, pack) {
      const packId = pack.id;
      const counts = PackLibrary.getCaseInstanceCounts(pack, c.id);

      const section = document.createElement('div');
      section.className = 'tp3d-editor-case-qty';

      const row = document.createElement('div');
      row.className = 'tp3d-editor-case-qty-row';

      // Two groups so a narrow card can wrap the action control beneath the
      // stepper without ever splitting "Qty [−] [N] [+]" (see main.css).
      const stepper = document.createElement('div');
      stepper.className = 'tp3d-editor-case-qty-stepper';
      row.appendChild(stepper);

      const actions = document.createElement('div');
      actions.className = 'tp3d-editor-case-qty-actions';
      row.appendChild(actions);

      const label = document.createElement('span');
      label.className = 'tp3d-editor-case-qty-label';
      label.textContent = 'Qty';
      stepper.appendChild(label);

      const minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'btn btn-sm tp3d-editor-case-qty-btn';
      minusBtn.textContent = '−';
      minusBtn.setAttribute('aria-label', `Decrease quantity for ${c.name}`);
      minusBtn.dataset.caseId = c.id;
      minusBtn.dataset.qtyRole = 'minus';
      stepper.appendChild(minusBtn);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input tp3d-editor-case-qty-input';
      input.min = String(CASE_QTY_MIN);
      input.max = String(CASE_QTY_MAX);
      input.step = '1';
      input.inputMode = 'numeric';
      input.value = String(getCaseQtyDraft(c.id));
      input.setAttribute('aria-label', `Quantity to add or remove for ${c.name}`);
      input.dataset.caseId = c.id;
      input.dataset.qtyRole = 'input';
      stepper.appendChild(input);

      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'btn btn-sm tp3d-editor-case-qty-btn';
      plusBtn.textContent = '+';
      plusBtn.setAttribute('aria-label', `Increase quantity for ${c.name}`);
      plusBtn.dataset.caseId = c.id;
      plusBtn.dataset.qtyRole = 'plus';
      stepper.appendChild(plusBtn);

      // Unstage is offered only when this Case has physically staged cargo at all
      // (counts.staged is the readout's own figure). That is NOT an eligibility
      // check: whether any staged instance is actually removable stays entirely
      // with PackLibrary.removeCaseInstancesFromStaging(). With no staged cargo
      // nothing is rendered here — "+ Add" stands alone, no empty/disabled half.
      // It is the LEFT segment, so it is appended before "+ Add".
      let removeBtn = null;
      if (counts.staged > 0) {
        removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-sm tp3d-editor-case-qty-unstage';
        removeBtn.textContent = 'Unstage';
        removeBtn.title = 'Removes staged cases only. Packed, hidden, or grouped cases are not affected.';
        removeBtn.setAttribute('aria-label', `Unstage for ${c.name}`);
        // qtyRole is the internal focus-restore key — intentionally left as 'remove'.
        removeBtn.dataset.caseId = c.id;
        removeBtn.dataset.qtyRole = 'remove';
        actions.classList.add('tp3d-editor-case-qty-actions--segmented');
        actions.appendChild(removeBtn);
      }

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-primary btn-sm tp3d-editor-btn-add';
      // Label must always remain exactly "+ Add" — never a dynamic count/state.
      addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add';
      addBtn.setAttribute('aria-label', `Add to staging for ${c.name}`);
      addBtn.dataset.caseId = c.id;
      addBtn.dataset.qtyRole = 'add';
      actions.appendChild(addBtn);

      // Visible wording is unchanged: "N in load · N in truck · N staged". Only
      // the "N staged" fragment gets its own span (semibold) while staged cargo
      // exists, so it reads as the count the adjacent Unstage acts on.
      const readout = document.createElement('div');
      readout.className = 'tp3d-editor-case-qty-readout';
      readout.appendChild(
        document.createTextNode(`${counts.inLoad} in load · ${counts.inTruck} in truck · `)
      );
      if (counts.staged > 0) {
        const stagedEmphasis = document.createElement('span');
        stagedEmphasis.className = 'tp3d-editor-case-qty-readout-staged';
        stagedEmphasis.textContent = `${counts.staged} staged`;
        readout.appendChild(stagedEmphasis);
      } else {
        readout.appendChild(document.createTextNode(`${counts.staged} staged`));
      }

      section.appendChild(row);
      section.appendChild(readout);

      const revertInput = () => {
        input.value = String(getCaseQtyDraft(c.id));
      };

      // Direct entry must resolve to a whole number >= CASE_QTY_MIN; blank,
      // zero, negative, fractional, non-numeric, NaN, and infinite values are
      // all invalid and fall back to reverting the prior valid draft.
      const parseDirectEntry = () => {
        const raw = input.value.trim();
        if (raw === '') return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < CASE_QTY_MIN) return null;
        return n;
      };

      const commitDraft = value => {
        if (value === null) {
          revertInput();
          return;
        }
        setCaseQtyDraft(c.id, value);
        input.value = String(getCaseQtyDraft(c.id));
      };

      // Add acts on what is VISIBLY in the input, even if the user never blurred
      // it or pressed Enter. Returns the committed whole quantity, or null (after
      // reverting the field to the last valid draft and warning) when the visible
      // value is not a whole number from CASE_QTY_MIN to CASE_QTY_MAX.
      const readLiveQty = () => {
        const n = parseDirectEntry();
        if (n === null || n > CASE_QTY_MAX) {
          revertInput();
          UIComponents.showToast(STAGING_QTY_INVALID_MESSAGE, 'warning');
          return null;
        }
        commitDraft(n);
        return n;
      };

      minusBtn.addEventListener('click', () => {
        commitDraft(getCaseQtyDraft(c.id) - 1);
      });

      plusBtn.addEventListener('click', () => {
        commitDraft(getCaseQtyDraft(c.id) + 1);
      });

      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commitDraft(parseDirectEntry());
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          revertInput();
          input.blur();
        }
      });
      // Add and Unstage validate the LIVE input in their own click handler
      // (readLiveQty). Moving focus from the Qty input to either of them must not
      // pre-commit or revert that value first: the blur that precedes the click
      // would otherwise swap an invalid entry such as 1.5 for the previous draft,
      // and the click would then act on the restored value. relatedTarget names
      // the button where the browser focuses it on press (Chrome, Tab); the
      // pointerdown flag covers browsers that do not focus a button on click
      // (relatedTarget === null). Every other blur is unchanged.
      //
      // The flag is one-shot and strictly local to this card's listeners. It is
      // consumed by the next blur, and cleared if that press never reaches one:
      // pointercancel (a touch scroll or system interruption leaves the input
      // focused with no blur and no click), click (registered BEFORE each action's
      // own click listener, so it runs even when that handler returns early — busy,
      // duplicate, invalid Qty), and the input regaining focus.
      let actionPressPending = false;
      const markActionPress = () => {
        actionPressPending = true;
      };
      const clearActionPress = () => {
        actionPressPending = false;
      };
      [addBtn, removeBtn].forEach(button => {
        if (!button) return; // removeBtn is null with no staged cargo
        button.addEventListener('pointerdown', markActionPress);
        button.addEventListener('pointercancel', clearActionPress);
        button.addEventListener('click', clearActionPress);
      });
      input.addEventListener('focus', clearActionPress);
      input.addEventListener('blur', ev => {
        // removeBtn is null with no staged cargo: never match a null relatedTarget to it.
        const next = ev.relatedTarget;
        const toAction = actionPressPending || (Boolean(next) && (next === addBtn || next === removeBtn));
        actionPressPending = false;
        if (toAction) return;
        commitDraft(parseDirectEntry());
      });

      addBtn.addEventListener('click', () => {
        if (editorMutationBlocked()) return;
        // The second click of a physical double-click lands on the button the first
        // click's synchronous re-render just created, with Qty already reset: ignore it.
        if (stagingActionGuard.isDuplicate(STAGING_ACTION_KIND.ADD, packId, c.id)) return;
        const qty = readLiveQty();
        if (qty === null) return;
        minusBtn.disabled = true;
        plusBtn.disabled = true;
        input.disabled = true;
        addBtn.disabled = true;
        let added = false;
        try {
          endAutoPackResultsPreview({ forManualEdit: true });
          // Reset the draft BEFORE the mutating call: addInstancesToStaging's
          // Pack update triggers a synchronous StateStore-driven re-render
          // that rebuilds this card from caseQtyDrafts immediately, so the
          // reset must already be visible by then — not after, which would
          // leave the stale pre-add value showing on the freshly rebuilt input.
          setCaseQtyDraft(c.id, CASE_QTY_MIN);
          // Resolves the latest Pack/Case internally at call time — never
          // trusts a stale render-time reference.
          const result = PackLibrary.addInstancesToStaging(packId, c.id, qty);
          if (!result || result.reason !== 'ok') {
            const feedback = getStagingAddFailureFeedback(result);
            UIComponents.showToast(feedback.message, feedback.tone);
            return;
          }
          // Only a completed Add arms the duplicate-click window; a rejected one never does.
          stagingActionGuard.recordSuccess(STAGING_ACTION_KIND.ADD, packId, c.id);
          added = true;
          if (result.addedCount === 1) {
            StateStore.set({ selectedInstanceIds: result.createdInstanceIds }, { skipHistory: true });
          }
          const message = result.addedCount === 1
            ? 'Case added to staging.'
            : `Added ${result.addedCount} items to staging.`;
          UIComponents.showToast(message, 'success');
        } finally {
          // A failed Add writes nothing to the Pack, so no re-render replaced this
          // card and the visible input still shows the requested Qty: put the
          // pre-call draft back so it matches (also covers a throw).
          if (!added) setCaseQtyDraft(c.id, qty);
          minusBtn.disabled = false;
          plusBtn.disabled = false;
          input.disabled = false;
          addBtn.disabled = false;
        }
      });

      if (removeBtn) {
        removeBtn.addEventListener('click', () => {
          if (editorMutationBlocked()) return;
          // Same double-click mechanism as Add: the second click lands on the Unstage
          // button the first click's synchronous re-render just created, Qty already reset.
          if (stagingActionGuard.isDuplicate(STAGING_ACTION_KIND.UNSTAGE, packId, c.id)) return;
          const qty = readLiveQty();
          if (qty === null) return;
          let removed = false;
          try {
            endAutoPackResultsPreview({ forManualEdit: true });
            // Same ordering as Add: a successful removal re-renders this card
            // synchronously from caseQtyDrafts, so the reset must already be in place.
            setCaseQtyDraft(c.id, CASE_QTY_MIN);
            const result = PackLibrary.removeCaseInstancesFromStaging(packId, c.id, qty);
            const feedback = getStagingRemoveFeedback(result);
            if (!result || result.reason !== 'ok') {
              UIComponents.showToast(feedback.message, feedback.tone);
              return;
            }
            // Only a completed Unstage arms the duplicate-click window; a shortage,
            // invalid, or failed one never does.
            stagingActionGuard.recordSuccess(STAGING_ACTION_KIND.UNSTAGE, packId, c.id);
            removed = true;
            // Qty Unstage is not explicit Delete: drop only the removed ids from the
            // selection, and make no selection write at all if none were selected.
            const nextSelection = pruneSelectionAfterRemoval(
              StateStore.get('selectedInstanceIds'),
              result.removedInstanceIds
            );
            if (nextSelection) InteractionManager.setSelection(nextSelection);
            UIComponents.showToast(feedback.message, feedback.tone);
          } finally {
            // A rejected Unstage writes nothing to the Pack, so no re-render replaced
            // this card: restore the requested Qty so the field and draft match.
            if (!removed) setCaseQtyDraft(c.id, qty);
          }
        });
      }

      return section;
    }

    function openEditorNewCaseModal() {
      if (editorMutationBlocked()) return;
      openSharedCaseModal({
        existing: null,
        Utils,
        UIComponents,
        PreferencesManager,
        CaseLibrary,
        CategoryService,
        PackLibrary,
        beforeMutate: () => !editorMutationBlocked(),
        onSaved: () => {
          if (caseSearchEl) caseSearchEl.value = '';
          browserCats.clear();
          browserManufacturers.clear();
          caseBrowserGroupBy = 'category';
          setCaseFiltersVisible(false, false);
          renderCaseBrowser();
        },
      });
    }

    function setCaseFiltersVisible(nextVisible, persist) {
      showCaseFilters = Boolean(nextVisible);
      if (caseChipsEl) {
        caseChipsEl.hidden = !showCaseFilters;
        caseChipsEl.style.display = showCaseFilters ? '' : 'none';
      }
      if (caseFilterToggleEl) {
        caseFilterToggleEl.setAttribute('aria-expanded', showCaseFilters ? 'true' : 'false');
        caseFilterToggleEl.classList.toggle('btn-primary', showCaseFilters);
      }
      if (persist) {
        try {
          window.localStorage.setItem(caseFiltersStorageKey, showCaseFilters ? '1' : '0');
        } catch {
          // ignore
        }
      }
      fitCaseFilterPopup();
    }

    // The popup is absolutely positioned inside the sticky search block but is
    // clipped by the scrolling Case Browser body, so the height it can really use
    // is "body bottom − popup top" — which depends on the rendered layout (panel,
    // drawer, header heights), so CSS alone cannot express it. Measure it while
    // open; styles/main.css keeps the old cap only as the fallback.
    function fitCaseFilterPopup() {
      if (!showCaseFilters || !caseChipsEl) return;
      const scrollBody = caseChipsEl.closest('.panel-body');
      const clipBottom = Math.min(window.innerHeight, scrollBody ? scrollBody.getBoundingClientRect().bottom : window.innerHeight);
      const available = Math.floor(clipBottom - caseChipsEl.getBoundingClientRect().top - 12);
      caseChipsEl.style.setProperty('--tp3d-case-chips-max-height', `${Math.max(available, 72)}px`);
    }

    // Presentation-only indicators for the Case Browser filters. Yellow on the
    // toggle (btn-primary) keeps meaning "popup open"; the count badge and the
    // accessible name report the ACTIVE group-by mode's selections, and each
    // mode tab shows the selections it retains while inactive.
    function syncCaseFilterIndicators() {
      const activeCount = (caseBrowserGroupBy === 'manufacturer' ? browserManufacturers : browserCats).size;
      if (caseFilterToggleEl) {
        let badge = /** @type {HTMLElement|null} */ (caseFilterToggleEl.querySelector('.tp3d-filter-active-count'));
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tp3d-filter-active-count';
          badge.setAttribute('aria-hidden', 'true');
          caseFilterToggleEl.appendChild(badge);
        }
        badge.textContent = activeCount ? String(activeCount) : '';
        badge.hidden = !activeCount;
        caseFilterToggleEl.setAttribute('aria-label', activeCount ? `Toggle filters, ${activeCount} active` : 'Toggle filters');
      }
      document.querySelectorAll('.tp3d-browser-tab').forEach(btn => {
        if (!(btn instanceof HTMLElement)) return;
        const isManufacturer = btn.dataset.groupBy === 'manufacturer';
        const retained = (isManufacturer ? browserManufacturers : browserCats).size;
        btn.classList.toggle('btn-primary', btn.dataset.groupBy === caseBrowserGroupBy);
        btn.setAttribute('aria-pressed', String(btn.dataset.groupBy === caseBrowserGroupBy));
        let countEl = /** @type {HTMLElement|null} */ (btn.querySelector('.tp3d-browser-tab-count'));
        if (!countEl) {
          countEl = document.createElement('span');
          countEl.className = 'tp3d-browser-tab-count';
          countEl.setAttribute('aria-hidden', 'true');
          btn.appendChild(countEl);
        }
        countEl.textContent = retained ? String(retained) : '';
        countEl.hidden = !retained;
        const label = isManufacturer ? 'Manufacturer' : 'Category';
        if (retained) btn.setAttribute('aria-label', `${label}, ${retained} selected`);
        else btn.removeAttribute('aria-label');
      });
      const groupTabsEl = document.querySelector('.tp3d-editor-browser-group-tabs');
      if (groupTabsEl) groupTabsEl.classList.toggle('has-retained-counts', browserCats.size + browserManufacturers.size > 0);
    }

    function buildCaseBrowserEmptyState({ libraryEmpty, hasSearch, hasFilters }) {
      const el = document.createElement('div');
      el.className = 'tp3d-editor-case-empty';
      const message = document.createElement('p');
      message.className = 'tp3d-editor-case-empty__message muted';
      message.textContent = libraryEmpty ? 'No cases yet.' : 'No cases match.';
      el.appendChild(message);
      if (libraryEmpty) return el;
      const actions = document.createElement('div');
      actions.className = 'tp3d-editor-case-empty__actions';
      const addAction = (label, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        actions.appendChild(btn);
      };
      if (hasSearch) {
        addAction('Clear search', () => {
          caseSearchEl.value = '';
          renderCaseBrowser();
          caseSearchEl.focus();
        });
      }
      if (hasFilters) {
        // Clears BOTH group-by modes; "All" in the popup clears only the current one.
        addAction('Clear filters', () => {
          browserCats.clear();
          browserManufacturers.clear();
          renderCaseBrowser();
          if (caseFilterToggleEl) caseFilterToggleEl.focus();
        });
      }
      if (actions.childElementCount) el.appendChild(actions);
      return el;
    }

    function makeBrowserChip(name, count, key, active, onClick, color) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `chip ${active ? 'active' : ''}`;
      el.setAttribute('aria-pressed', String(active));
      el.dataset.filterKey = key;
      const fullLabel = `${name}: ${count}`;
      el.title = fullLabel;
      el.setAttribute('aria-label', fullLabel);
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = color || 'var(--border-strong)';
      // Name shrinks/ellipsizes; the count is its own non-shrinking span so a
      // long name can never hide it.
      const text = document.createElement('span');
      text.className = 'tp3d-browser-chip-label';
      text.textContent = name;
      const countEl = document.createElement('span');
      countEl.className = 'tp3d-browser-chip-count';
      countEl.textContent = `: ${count}`;
      el.appendChild(dot);
      el.appendChild(text);
      el.appendChild(countEl);
      el.addEventListener('click', onClick);
      return el;
    }

    function makeMiniCategoryChip(categoryKey) {
      const meta = CategoryService.meta(categoryKey || 'default');
      const el = document.createElement('span');
      el.className = 'badge tp3d-editor-meta-chip';
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = meta.color;
      const text = document.createElement('span');
      text.textContent = meta.name;
      el.appendChild(dot);
      el.appendChild(text);
      return el;
    }

    // True (and toasts) when a mutating editor operation owns the editor, so direct
    // case-list mutations (add / duplicate / delete) from the panels are blocked.
    function editorMutationBlocked({ endPreview = false } = {}) {
      if (OperationLifecycle && OperationLifecycle.isBusy()) {
        UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Editor' });
        return true;
      }
      // Geometry actions need committed cargo. Refuse a transient preview
      // before touching scene poses, Pack data or history.
      if (endPreview && CaseScene.isTransientPreview()) {
        UIComponents.showToast('Use "Apply this option" in AutoPack Results before editing cargo.', 'info', { title: 'Editor' });
        return true;
      }
      return false;
    }

    function setSelectionFromDeleteResult(result) {
      const nextIds = getDeleteFinalSelection(result);
      StateStore.set({ selectedInstanceIds: nextIds }, { skipHistory: true });
      CaseScene.setSelected(nextIds);
    }

    function deleteInstancesWithFeedback(packId, instanceIds) {
      const ids = Array.isArray(instanceIds) ? instanceIds : [];
      if (!ids.length) return null;
      if (editorMutationBlocked({ endPreview: true })) return null;
      const result = PackLibrary.removeInstances(packId, ids);
      setSelectionFromDeleteResult(result);
      if (!result) {
        UIComponents.showToast('Delete failed. Please try again.', 'error');
        return null;
      }
      UIComponents.showToast(formatDeleteResultMessage(result, ids), 'info');
      return result;
    }

    function addCaseToPack(caseId, positionInches) {
      if (editorMutationBlocked({ endPreview: true })) return;
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack) {
        UIComponents.showToast('Create or open a load plan first', 'warning');
        AppShell.navigate('packs');
        return;
      }

      const caseData = CaseLibrary.getById(caseId);
      if (!caseData) return;
      const inst = positionInches
        ? PackLibrary.addInstance(packId, caseId, positionInches)
        : PackLibrary.addInstance(packId, caseId);
      if (inst) {
        StateStore.set({ selectedInstanceIds: [inst.id] }, { skipHistory: true });
        UIComponents.showToast('Case added to load plan', 'success');
      } else if (positionInches) {
        UIComponents.showToast('Cannot place this case here safely.', 'error');
      }
    }

    async function unpackAll() {
      const packId = StateStore.get('currentPackId');
      const pack = PackLibrary.getById(packId);
      if (!pack || !(pack.cases || []).length) {
        UIComponents.showToast('Nothing to unpack', 'info');
        return;
      }
      // Unpack stages the committed cargo: the committed scene shows before the
      // slot is claimed, so the frame yield below never displays a candidate.
      endAutoPackResultsPreview();
      clearPendingTruck();
      // Claim the single mutating-operation slot so AutoPack / Truck Change cannot
      // run concurrently with the (synchronous, O(n^2)) staging computation below.
      const opToken = OperationLifecycle ? OperationLifecycle.beginOperation('unpacking', { packId }) : null;
      if (OperationLifecycle && !opToken) {
        UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Unpack' });
        return;
      }
      try {
        // Paint a working state and yield one frame BEFORE the synchronous staging
        // pass so large packs do not look frozen.
        UIComponents.showToast('Organizing staging area…', 'info', { title: 'Unpack' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // Staleness guard: if the user switched pack/screen during that frame, or a
        // newer operation took the slot, abort before committing.
        if (StateStore.get('currentPackId') !== packId || StateStore.get('currentScreen') !== 'editor') return;
        if (OperationLifecycle && !OperationLifecycle.isCurrent(opToken)) return;
        const livePack = PackLibrary.getById(packId);
        if (!livePack) return;

        const stagingLayout = PackLibrary.getStagingLayout(livePack.truck || {});
        const organized = buildOrganizedUnpackStagingCases({
          instances: livePack.cases || [],
          stagingLayout,
          getCaseById: caseId => CaseLibrary.getById(caseId),
          getCanonicalInstanceEffectiveDims: PackLibrary.getCanonicalInstanceEffectiveDims,
        });
        const nextCases = organized.cases;
        const movedCount = organized.movedCount;
        if (OperationLifecycle && !OperationLifecycle.isCurrent(opToken)) return;
        const patch = { cases: nextCases };
        // Staging the cargo discards the packed solution this Pack's AutoPack
        // Results describe. Clear them without a notification of their own so
        // the Pack commit's notification renders the staged Pack without them
        // (one Editor render); restore them if the commit does not land.
        const discardedResults = StateStore.get('autoPackResults');
        const clearsResults = movedCount > 0 && Boolean(discardedResults) && discardedResults.packId === packId;
        if (clearsResults) StateStore.set({ autoPackResults: null }, { skipHistory: true, skipNotify: true });
        let committed = null;
        try {
          committed = PackLibrary.update(packId, patch);
        } finally {
          if (clearsResults && !committed) {
            StateStore.set({ autoPackResults: discardedResults }, { skipHistory: true, skipNotify: true });
          }
        }
        if (!committed) return;
        // PackLibrary.update notified StateStore synchronously, and that
        // notification already ran the full Editor render for this commit.
        UIComponents.showToast(`Moved ${movedCount} case${movedCount === 1 ? '' : 's'} to staging.`, 'info', { title: 'Unpack' });
      } finally {
        if (opToken && OperationLifecycle) OperationLifecycle.finishOperation(opToken);
      }
    }

    function renderInspectorNoPack() {
      packNotesButton = null;
      inspectorEl.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
              <div class="tp3d-editor-fw-semibold tp3d-editor-mb-6">No pack open</div>
              <div class="muted tp3d-editor-fs-sm tp3d-editor-mb-12">Open a load plan from the Load Plans screen to use the 3D editor.</div>
            `;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.type = 'button';
      btn.innerHTML = '<i class="fa-solid fa-layer-group"></i> Go to Load Plans';
      btn.addEventListener('click', () => AppShell.navigate('packs'));
      card.appendChild(btn);
      inspectorEl.appendChild(card);
    }

    function renderInspector(pack) {
      const previousFocus = captureEditorFocus(inspectorEl);
      const prefs = PreferencesManager.get();
      const sel = StateStore.get('selectedInstanceIds') || [];
      packNotesButton = null;
      inspectorEl.innerHTML = '';

      if (!sel.length) {
        renderTruckInspector(pack, prefs);
        // Space Utilization belongs only in the Truck/default Inspector state.
        renderSpaceUtilizationSection(pack);
      } else if (sel.length > 1) {
        renderMultiInspector(pack, sel);
      } else {
        const instanceId = sel[0];
        const inst = (pack.cases || []).find(i => i.id === instanceId);
        if (!inst) {
          StateStore.set({ selectedInstanceIds: [] }, { skipHistory: true });
          renderTruckInspector(pack, prefs);
          renderSpaceUtilizationSection(pack);
        } else {
          const c = CaseLibrary.getById(inst.caseId);
          if (!c) renderUnresolvedCaseInspector(pack, inst);
          else renderSingleInspector(pack, inst, c, prefs);
        }
      }
      restoreEditorFocus(previousFocus, inspectorEl, btnRight);
    }

    // While AutoPack owns the Editor, placement-derived totals read Updating….
    // Once it releases ownership, all totals follow the same viewed subject.
    function isAutoPackLoadingCargo() {
      return Boolean(OperationLifecycle && typeof OperationLifecycle.currentOperation === 'function' &&
        OperationLifecycle.currentOperation().kind === 'autopacking');
    }

    function renderSpaceUtilizationSection(pack) {
      const existing = inspectorEl.querySelector('[data-role="space-utilization-gauge"]');
      if (existing) existing.remove();
      if (!pack) return;
      const prefs = PreferencesManager.get();
      // Follows the layout the scene shows, a transient Results preview included.
      const result = isAutoPackLoadingCargo()
        ? { state: 'updating' }
        : buildSpaceUtilizationResult(getAutoPackResultsPreviewPack(pack) || pack, PackLibrary);
      const gauge = createSpaceUtilizationGauge({
        result,
        detail: 'standard',
        lengthUnit: prefs.units && prefs.units.length,
      });
      inspectorEl.appendChild(gauge);
    }

    function renderUnresolvedCaseInspector(pack, inst) {
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.add('tp3d-editor-card-grid-gap-12');
      const title = document.createElement('div');
      title.classList.add('tp3d-editor-title-lg-semibold');
      title.textContent = 'Unresolved case';
      const msg = document.createElement('div');
      msg.className = 'muted';
      msg.classList.add('tp3d-editor-sub-sm');
      msg.textContent = `This item references a missing case definition (${inst && inst.caseId ? inst.caseId : 'unknown'}). It is excluded from AutoPack and Stats. Re-import the source pack or delete this item.`;
      card.appendChild(title);
      card.appendChild(msg);
      // Reachable repair/remove: the user can always delete the dangling item.
      const deleteButton = makeActionButton({
        label: 'Delete item',
        iconClass: 'fa-solid fa-trash',
        danger: true,
        onClick: () => {
          if (editorMutationBlocked()) return;
          deleteInstancesWithFeedback(pack.id, [inst.id]);
        },
      });
      card.appendChild(deleteButton);
      inspectorEl.appendChild(card);
    }

    function selectAllCases(pack) {
      const count = pack && Array.isArray(pack.cases) ? pack.cases.length : 0;
      if (!count) {
        UIComponents.showToast('No cases to select', 'info');
        return;
      }
      InteractionManager.selectAllInPack();
      render();
    }

    function makeSelectAllButton(pack, selectedCount = 0) {
      const totalCount = pack && Array.isArray(pack.cases) ? pack.cases.length : 0;
      return makeActionButton({
        label: 'Select All',
        iconHtml: selectAllIconSvg(),
        disabled: !totalCount || selectedCount >= totalCount,
        onClick: () => selectAllCases(pack),
      });
    }

    function selectAllIconSvg() {
      return [
        '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none"',
        ' xmlns="http://www.w3.org/2000/svg">',
        '<path d="M4 12.5V5.75C4 4.78 4.78 4 5.75 4h6.75" stroke="currentColor" stroke-width="2.2"',
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M8 16.5V9.75C8 8.78 8.78 8 9.75 8h6.75" stroke="currentColor" stroke-width="2.2"',
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        '<rect x="12" y="12" width="8" height="8" rx="1.8" stroke="currentColor" stroke-width="2.2"/>',
        '<path d="M14.2 16.1l1.55 1.55 3.05-3.3" stroke="currentColor" stroke-width="2.2"',
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
      ].join('');
    }

    function categoryTruckIconSvg() {
      return [
        '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none"',
        ' xmlns="http://www.w3.org/2000/svg">',
        '<path d="M3.5 7.5h10.2v7.2H3.5V7.5Z" stroke="currentColor" stroke-width="2.1"',
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M13.7 10h3.35l3.45 3.2v1.5h-6.8V10Z" stroke="currentColor" stroke-width="2.1"',
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M5.2 17.1a1.65 1.65 0 1 0 3.3 0 1.65 1.65 0 0 0-3.3 0Z"',
        ' stroke="currentColor" stroke-width="2.1"/>',
        '<path d="M16.1 17.1a1.65 1.65 0 1 0 3.3 0 1.65 1.65 0 0 0-3.3 0Z"',
        ' stroke="currentColor" stroke-width="2.1"/>',
        '<path d="M8.6 17.1h7.5M2.8 17.1h2.4" stroke="currentColor" stroke-width="2.1"',
        ' stroke-linecap="round"/>',
        '</svg>',
      ].join('');
    }

    function planningIconSvg() {
      return [
        '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none"',
        ' xmlns="http://www.w3.org/2000/svg">',
        '<path d="M8.4 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6.2"',
        ' stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M15.6 5H17a2 2 0 0 1 2 2v5.2" stroke="currentColor" stroke-width="2.1"',
        ' stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M8.4 5a3.6 3.6 0 0 1 7.2 0H8.4Z" stroke="currentColor" stroke-width="2.1"',
        ' stroke-linejoin="round"/>',
        '<path d="M8.4 10.2h6M8.4 14h3.2"',
        ' stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M15 19.1l4.55-4.55a1.55 1.55 0 0 1 2.2 2.2L17.2 21.3l-2.8.7.6-2.9Z"',
        ' stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
      ].join('');
    }

    function deselectBoxIconSvg() {
      return [
        '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none"',
        ' xmlns="http://www.w3.org/2000/svg">',
        '<path d="M12 3.2 4.4 7.3 12 11.5l7.6-4.2L12 3.2Z" stroke="currentColor"',
        ' stroke-width="2.1" stroke-linejoin="round"/>',
        '<path d="M4.4 7.3v8.4l7.6 4.1 2.2-1.2M19.6 7.3v5.1M12 11.5v4.1"',
        ' stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
        '<path d="M16.2 16.2 20 20M20 16.2 16.2 20" stroke="currentColor" stroke-width="2.2"',
        ' stroke-linecap="round"/>',
        '</svg>',
      ].join('');
    }

    function makeActionButton({ label, iconClass = '', iconHtml = '', danger = false, disabled = false, onClick }) {
      const btn = document.createElement('button');
      btn.className = danger ? 'btn btn-danger' : 'btn';
      btn.type = 'button';
      btn.dataset.focusKey = `action-${label}`;
      btn.innerHTML = `${iconHtml || `<i class="${iconClass}"></i>`} ${label}`;
      btn.disabled = Boolean(disabled);
      if (typeof onClick === 'function') btn.addEventListener('click', onClick);
      return btn;
    }

    function getCaseCategoryKey(caseData) {
      if (!caseData || caseData.category == null) return '';
      return String(caseData.category).trim().toLowerCase();
    }

    function getSelectedCategoryContext(pack, selectedIds) {
      const selected = Array.isArray(selectedIds) ? selectedIds : [];
      const firstId = selected[0];
      if (!firstId) return null;
      const inst = (pack.cases || []).find(item => item && item.id === firstId);
      if (!inst) return null;
      const caseData = CaseLibrary.getById(inst.caseId);
      const categoryKey = getCaseCategoryKey(caseData);
      if (!categoryKey) return null;
      return { inst, caseData, categoryKey };
    }

    function getCategorySelectionBuckets(pack, categoryKey) {
      const target = String(categoryKey || '').trim().toLowerCase();
      const truck = [];
      const staging = [];
      if (!target) return { truck, staging, everywhere: [] };

      (pack.cases || []).forEach(inst => {
        if (!inst || !inst.id || !inst.caseId) return;
        const caseData = CaseLibrary.getById(inst.caseId);
        if (getCaseCategoryKey(caseData) !== target) return;
        if (inst.placement === 'packed') truck.push(inst.id);
        if (inst.placement === 'staged') staging.push(inst.id);
      });

      return { truck, staging, everywhere: [...truck, ...staging] };
    }

    function getCategoryScopeLabel(scope) {
      if (scope === 'truck') return 'in the truck';
      if (scope === 'staging') return 'in staging';
      return 'in the truck or staging';
    }

    function selectCategoryGroup(pack, categoryKey, scope) {
      const buckets = getCategorySelectionBuckets(pack, categoryKey);
      const ids = buckets[scope] || [];
      const meta = CategoryService.meta(categoryKey || 'default');
      if (!ids.length) {
        UIComponents.showToast(`No ${meta.name} cases found ${getCategoryScopeLabel(scope)}.`, 'info');
        return;
      }
      InteractionManager.setSelection(ids);
      renderInspector(pack);
      UIComponents.showToast(`Selected ${ids.length} ${meta.name} case${ids.length === 1 ? '' : 's'}.`, 'info');
    }

    function renderCategorySelectionCard(pack, categoryKey) {
      const buckets = getCategorySelectionBuckets(pack, categoryKey);
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.add('tp3d-editor-card-grid-gap-12');
      card.appendChild(cardHeaderWithInfo(
        'Category Selection',
        'Select all cases in this category without changing placement or staging layout.'
      ));

      const row = document.createElement('div');
      row.className = 'tp3d-editor-action-grid';
      [
        {
          scope: 'truck',
          label: 'In Truck',
          iconHtml: categoryTruckIconSvg(),
        },
        {
          scope: 'staging',
          label: 'In Staging',
          iconHtml: planningIconSvg(),
        },
        {
          scope: 'everywhere',
          label: 'Everywhere',
          iconClass: 'fa-solid fa-layer-group',
          fullWidth: true,
        },
      ].forEach(({ scope, label, iconClass, iconHtml, fullWidth }) => {
        const btn = makeActionButton({
          label,
          iconClass,
          iconHtml,
          disabled: !buckets[scope].length,
          onClick: () => selectCategoryGroup(pack, categoryKey, scope),
        });
        if (fullWidth) btn.classList.add('tp3d-editor-action-grid-span-full');
        row.appendChild(btn);
      });
      card.appendChild(row);
      return card;
    }

    function makeVisibilityButton(pack, selectedIds) {
      const ids = Array.isArray(selectedIds) ? selectedIds : [];
      const instances = ids.map(id => (pack.cases || []).find(i => i.id === id)).filter(Boolean);
      const showSelection = instances.length > 0 && instances.every(inst => inst.hidden === true);
      return makeActionButton({
        label: showSelection ? 'Show' : 'Hide',
        iconClass: showSelection ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash',
        disabled: !instances.length,
        onClick: () => {
          if (editorMutationBlocked({ endPreview: true })) return;
          const targetIds = new Set(instances.map(inst => inst.id));
          const livePack = PackLibrary.getById(pack.id);
          if (!livePack) return;
          const nextCases = (livePack.cases || []).map(inst =>
            targetIds.has(inst.id) ? { ...inst, hidden: !showSelection } : inst
          );
          PackLibrary.update(pack.id, { cases: nextCases });
        },
      });
    }

    function duplicateSelection(pack, selectedIds) {
      if (editorMutationBlocked({ endPreview: true })) return;
      const ids = Array.isArray(selectedIds) ? selectedIds : [];
      if (!pack || !ids.length) return;
      const source = ids
        .map(id => (pack.cases || []).find(inst => inst && inst.id === id))
        .filter(Boolean);
      if (!source.length) return;
      const result = PackLibrary.duplicateInstancesSafely(pack.id, source, CaseLibrary.getCases());
      if (!result || !result.newIds.length) {
        UIComponents.showToast('No collision-free duplicate position found', 'warning');
        return;
      }
      StateStore.set({ selectedInstanceIds: result.newIds }, { skipHistory: true });
      CaseScene.setSelected(result.newIds);
      UIComponents.showToast(
        result.placement === 'staged'
          ? `Duplicated ${result.newIds.length} case(s) to staging`
          : `Duplicated ${result.newIds.length} case(s)`,
        'success'
      );
      render();
    }

    function openSetCategoryModal(pack, selectedIds) {
      if (editorMutationBlocked()) return;
      const selected = Array.isArray(selectedIds) ? selectedIds : [];
      const selectedCaseIds = new Set();
      const currentKeys = new Set();
      selected.forEach(id => {
        const inst = (pack.cases || []).find(i => i.id === id);
        if (!inst || !inst.caseId) return;
        selectedCaseIds.add(inst.caseId);
        const c = CaseLibrary.getById(inst.caseId);
        if (c && c.category) currentKeys.add(c.category);
      });

      const initialKey = currentKeys.size === 1 ? Array.from(currentKeys)[0] : 'default';
      const initialMeta = CategoryService.meta(initialKey);

      const content = document.createElement('div');
      content.className = 'tp3d-editor-card-grid-gap-12';

      const modalHint = document.createElement('div');
      modalHint.className = 'muted tp3d-editor-fs-sm';
      modalHint.textContent =
        'This updates the Category for the underlying Case templates used by the selection, so the whole app (chips, labels, colors, textures) stays consistent.';
      content.appendChild(modalHint);

      const row1 = document.createElement('div');
      row1.className = 'row';
      row1.style.alignItems = 'center';

      const nameLabel = document.createElement('div');
      nameLabel.className = 'muted';
      nameLabel.style.minWidth = '90px';
      nameLabel.textContent = 'Name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = initialMeta.name || '';
      nameInput.placeholder = 'e.g. Cables';
      nameInput.style.flex = '1';
      row1.appendChild(nameLabel);
      row1.appendChild(nameInput);
      content.appendChild(row1);

      const row2 = document.createElement('div');
      row2.className = 'row';
      row2.style.alignItems = 'center';

      const colorLabel = document.createElement('div');
      colorLabel.className = 'muted';
      colorLabel.style.minWidth = '90px';
      colorLabel.textContent = 'Color';
      const colorWrap = document.createElement('label');
      colorWrap.classList.add('tp3d-cases-cat-swatch');
      colorWrap.style.background = initialMeta.color || '#9ca3af';
      colorWrap.setAttribute('aria-label', 'Category color');
      colorWrap.setAttribute('title', 'Category color');
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'tp3d-cases-cat-color-input';
      colorInput.value = initialMeta.color || '#9ca3af';
      colorInput.setAttribute('aria-label', 'Category color');
      colorInput.addEventListener('input', () => {
        colorWrap.style.background = colorInput.value || '#9ca3af';
      });
      colorWrap.appendChild(colorInput);
      row2.appendChild(colorLabel);
      row2.appendChild(colorWrap);
      content.appendChild(row2);

      const row3 = document.createElement('div');
      row3.className = 'row';
      row3.style.alignItems = 'center';

      const renameLabel = document.createElement('div');
      renameLabel.className = 'muted';
      renameLabel.style.minWidth = '90px';
      renameLabel.textContent = 'Labels';

      const renameWrap = document.createElement('label');
      renameWrap.style.display = 'inline-flex';
      renameWrap.style.alignItems = 'center';
      renameWrap.style.gap = '8px';

      const renameCheckbox = document.createElement('input');
      renameCheckbox.type = 'checkbox';
      renameCheckbox.checked = true;
      const renameText = document.createElement('span');
      renameText.textContent = 'Update box labels (case names) to match';

      renameWrap.appendChild(renameCheckbox);
      renameWrap.appendChild(renameText);
      row3.appendChild(renameLabel);
      row3.appendChild(renameWrap);
      content.appendChild(row3);

      UIComponents.showModal({
        title: `Set category for ${selected.length} selected`,
        content,
        actions: [
          { label: 'Cancel', variant: 'ghost' },
          {
            label: 'Apply',
            variant: 'primary',
            onClick: () => {
              if (editorMutationBlocked()) return false;
              const name = String(nameInput.value || '').trim();
              if (!name) {
                UIComponents.showToast('Category name is required', 'warning');
                return false;
              }
              const color = String(colorInput.value || '').trim();
              const meta = CategoryService.calculateUpsert({ name, color }).category;
              const casePatches = [];
              selectedCaseIds.forEach(caseId => {
                const c = CaseLibrary.getById(caseId);
                if (!c) return;
                const next = { id: caseId, category: meta.key };
                if (renameCheckbox.checked) next.name = name;
                if ((c.category || 'default') === meta.key && (!renameCheckbox.checked || c.name === name)) return;
                casePatches.push(next);
              });
              // One atomic commit: the category preference and every affected Case
              // template publish together as a single significant history entry, so
              // one Undo/Redo always covers the whole Apply — never a partially
              // reverted selection.
              CaseLibrary.commitCasesWithCategory(casePatches, { name, color });
              const updated = casePatches.length;
              UIComponents.showToast(
                updated
                  ? `Updated category to “${meta.name}” for ${updated} case template(s)`
                  : `Category already “${meta.name}”`,
                'success'
              );
              render();
              return true;
            },
          },
        ],
      });
    }

    // Load Plan Notes is a Pack-owned single-field overlay. The shared overlay
    // owns modal state/focus only; this adapter retains PackLibrary ownership,
    // captures the opening user/workspace/Pack context, and writes only
    // pack.notes through the canonical Pack update path.
    function openPackNotesModal(pack, trigger = null) {
      const packId = pack.id;
      const getNotesContext = () => ({
        userScope: CoreStorage.getStorageScope(),
        workspaceScope: CoreStorage.getWorkspaceScope(),
        packId: StateStore.get('currentPackId'),
      });
      const capturedContext = getNotesContext();

      return openNotesOverlay({
        UIComponents,
        entityType: 'load plan',
        entityId: packId,
        capturedContext,
        getCurrentContext: getNotesContext,
        resolveEntity: ({ entityId }) => PackLibrary.getById(entityId),
        readNote: current => current.notes,
        saveNote: ({ entityId, value }) => {
          const updated = PackLibrary.update(entityId, { notes: value });
          if (!updated) throw new Error('Load plan no longer exists');
          return updated;
        },
        clearValue: '',
        title: 'Load Plan Notes',
        subtitle: current => current.title || 'Load Plan',
        fieldLabel: 'Load Plan Notes',
        emptyText: 'No notes for this load plan yet.',
        placeholder: 'Add notes for this load plan (handling, delivery, site contact, etc.)...',
        mutationGuard: () => !editorMutationBlocked(),
        getLastEdited: current => current.lastEdited,
        trigger,
        missingMessage: 'This load plan no longer exists.',
        contextMessage: 'The active user, workspace, or load plan changed. Close Load Plan Notes and try again.',
      });
    }

    // Single Notes modal for the Inspector's single selected Pack instance,
    // presenting both Cargo Instructions tiers together for progressive
    // disclosure while keeping their ownership and mutation paths entirely
    // separate: Standard Instructions (Case-owned) is always read-only here —
    // the Cases-screen Case editor remains its only editing location — and
    // Item Notes (Pack-instance-owned) is the only editable part of this
    // modal, saved exclusively through PackLibrary.updateInstance, never
    // CaseLibrary.upsert. Both packId and instanceId are captured up front so
    // the draft can never migrate to a different instance if the selection
    // changes while the modal is open, and either being missing (deleted/
    // synced away while the modal is open) fails safely instead of writing
    // anywhere.
    function openNotesModal(pack, inst) {
      const packId = pack.id;
      const instanceId = inst.id;
      const caseId = inst.caseId;
      const trigger = document.activeElement;

      // Shared ownership handles Escape and containment; keep the Notes task target.
      function showNotesModal(config) {
        const modalRef = UIComponents.showModal({
          ...config, parentOwnerId: null,
          initialFocus: () => modalRef.modal.querySelector('textarea, .modal-footer .btn-primary'),
          restoreFocusResolver: ({ isValidTarget }) => {
            const selection = StateStore.get('selectedInstanceIds') || [];
            if (StateStore.get('currentScreen') !== 'editor' || StateStore.get('currentPackId') !== packId ||
                selection.length !== 1 || selection[0] !== instanceId) return null;
            return resolveNotesFocusTarget({ trigger, entityType: 'item', entityId: instanceId, isValidTarget });
          },
        });
        modalRef.modal.classList.add('tp3d-notes-modal');
        const heading = modalRef.modal.querySelector('.modal-title');
        if (heading) {
          heading.textContent = '';
          heading.classList.add('tp3d-notes-modal-heading');

          const headingIcon = document.createElement('span');
          headingIcon.className = 'tp3d-notes-modal-heading-icon';
          headingIcon.setAttribute('aria-hidden', 'true');
          const headingIconGlyph = document.createElement('i');
          headingIconGlyph.className = 'fa-regular fa-file-lines';
          headingIcon.appendChild(headingIconGlyph);

          const headingCopy = document.createElement('span');
          headingCopy.className = 'tp3d-notes-modal-heading-copy';
          const headingTitle = document.createElement('span');
          headingTitle.className = 'tp3d-notes-modal-heading-title';
          headingTitle.textContent = config.title || 'Notes';
          const headingSubtitle = document.createElement('span');
          headingSubtitle.className = 'tp3d-notes-modal-heading-subtitle';
          headingSubtitle.textContent = config.subtitle || 'Case';
          headingCopy.appendChild(headingTitle);
          headingCopy.appendChild(headingSubtitle);

          heading.appendChild(headingIcon);
          heading.appendChild(headingCopy);
        }
        return modalRef;
      }

      function resolveInstance() {
        const currentPack = PackLibrary.getById(packId);
        if (!currentPack) return null;
        const currentInst = (currentPack.cases || []).find(i => i.id === instanceId);
        return currentInst || null;
      }

      // Re-resolved fresh on every open so an edit made elsewhere (Cases
      // screen) while this modal is closed is never stale, and so a Case
      // deleted out from under an open modal degrades to "—" instead of
      // throwing.
      function buildStandardInstructionsSection() {
        const caseData = CaseLibrary.getById(caseId);
        const section = document.createElement('div');
        section.className = 'tp3d-editor-standard-instructions tp3d-notes-section';
        const label = document.createElement('div');
        label.classList.add('tp3d-editor-fw-semibold');
        label.textContent = 'Case Instructions/Notes';
        section.appendChild(label);
        const note = String((caseData && caseData.notes) || '').trim();
        const value = document.createElement('div');
        if (note) {
          value.classList.add('tp3d-editor-sub-sm', 'tp3d-case-notes-read');
          value.textContent = note;
        } else {
          value.classList.add('muted', 'tp3d-editor-sub-sm');
          value.textContent = 'No case instructions/notes yet.';
        }
        section.appendChild(value);
        return section;
      }

      function buildItemNotesHeader() {
        const label = document.createElement('div');
        label.classList.add('tp3d-editor-fw-semibold');
        label.textContent = 'Item Notes';
        return label;
      }

      function open(state) {
        const current = resolveInstance();
        if (!current) {
          UIComponents.showToast('This item no longer exists.', 'error', { title: 'Notes' });
          return;
        }
        const caseData = CaseLibrary.getById(caseId);
        const note = String(current.instanceNotes || '').trim();
        const resolvedState = state === 'auto' ? (note ? 'read' : 'empty') : state;
        const caseName = (caseData && caseData.name) || 'Case';
        const hasCaseNotes = Boolean(String((caseData && caseData.notes) || '').trim());

        const wrap = document.createElement('div');
        wrap.className = 'tp3d-notes-modal-content';

        if (resolvedState === 'empty') {
          if (!hasCaseNotes) {
            const emptyState = document.createElement('div');
            emptyState.className = 'tp3d-notes-empty-state';
            const emptyIcon = document.createElement('span');
            emptyIcon.className = 'tp3d-notes-empty-state-icon';
            emptyIcon.setAttribute('aria-hidden', 'true');
            const emptyIconGlyph = document.createElement('i');
            emptyIconGlyph.className = 'fa-regular fa-file-lines';
            emptyIcon.appendChild(emptyIconGlyph);
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'muted';
            emptyMessage.textContent = 'No notes for this case yet.';
            emptyState.appendChild(emptyIcon);
            emptyState.appendChild(emptyMessage);
            wrap.appendChild(emptyState);
          } else {
            wrap.appendChild(buildStandardInstructionsSection());
            const itemSection = document.createElement('div');
            itemSection.className = 'tp3d-notes-section';
            itemSection.appendChild(buildItemNotesHeader());
            const msg = document.createElement('div');
            msg.className = 'muted';
            msg.textContent = 'No notes for this item yet.';
            itemSection.appendChild(msg);
            wrap.appendChild(itemSection);
          }
          showNotesModal({
            title: 'Notes',
            subtitle: caseName,
            content: wrap,
            actions: [
              { label: 'Add Note', variant: 'primary', onClick: () => { open('edit'); return true; } },
            ],
          });
          return;
        }

        if (resolvedState === 'read') {
          wrap.appendChild(buildStandardInstructionsSection());
          const itemSection = document.createElement('div');
          itemSection.className = 'tp3d-notes-section';
          itemSection.appendChild(buildItemNotesHeader());
          const content = document.createElement('div');
          content.classList.add('tp3d-editor-sub-sm', 'tp3d-case-notes-read', 'tp3d-notes-item-read');
          content.textContent = note;
          itemSection.appendChild(content);
          const currentPackForEdited = PackLibrary.getById(packId);
          if (currentPackForEdited && currentPackForEdited.lastEdited) {
            const lastEdited = document.createElement('div');
            lastEdited.className = 'muted tp3d-notes-last-edited';
            lastEdited.textContent = `Last edited ${Utils.formatRelativeTime(currentPackForEdited.lastEdited)}`;
            itemSection.appendChild(lastEdited);
          }
          wrap.appendChild(itemSection);
          showNotesModal({
            title: 'Notes',
            subtitle: caseName,
            content: wrap,
            actions: [
              { label: 'Close', variant: 'ghost' },
              { label: 'Edit', variant: 'primary', onClick: () => { open('edit'); return true; } },
            ],
          });
          return;
        }

        // Edit state: a fresh textarea seeded from the current saved note.
        // Cancel, Escape, and backdrop click all discard this draft without
        // touching storage — only Save writes through
        // PackLibrary.updateInstance, and closing the dialog any other way
        // never deletes a previously saved note.
        wrap.appendChild(buildStandardInstructionsSection());
        const itemSection = document.createElement('div');
        itemSection.className = 'tp3d-notes-section';
        itemSection.appendChild(buildItemNotesHeader());
        const fieldWrap = document.createElement('div');
        fieldWrap.className = 'field';
        const textarea = document.createElement('textarea');
        textarea.className = 'input tp3d-textarea-minh-60';
        textarea.placeholder = 'Add notes specific to this item (condition, delivery note, etc.)...';
        textarea.value = note;
        fieldWrap.appendChild(textarea);
        itemSection.appendChild(fieldWrap);
        wrap.appendChild(itemSection);
        showNotesModal({
          title: 'Notes',
          subtitle: caseName,
          content: wrap,
          actions: [
            { label: 'Cancel', variant: 'ghost', onClick: () => { open('auto'); return true; } },
            {
              label: 'Save',
              variant: 'primary',
              onClick: () => {
                if (editorMutationBlocked()) return false;
                if (!resolveInstance()) {
                  // Save failure: keep the draft and stay in edit state — do
                  // not close (returning false leaves this same modal, with
                  // the user's typed text still in the textarea, open).
                  UIComponents.showToast('This item no longer exists.', 'error', { title: 'Notes' });
                  return false;
                }
                const trimmed = textarea.value.trim();
                // A single updateInstance call here is one Pack update and
                // one Undo/Redo history entry (packLibrary is in
                // StateStore's significant-state list) — never loop this
                // over multiple instances. Standard Instructions is never
                // touched by this handler — it has no Save action of its own.
                PackLibrary.updateInstance(packId, instanceId, { instanceNotes: trimmed || null });
                open('auto');
                return true;
              },
            },
          ],
        });
      }

      open('auto');
    }

    // Every editor truck writer delegates to the shared, single-flight
    // staging confirmation controller. The current render is also the canonical
    // control restoration path for Cancel, X, overlay click, and Escape.
    function applyTruckGeometryChange(pack, nextTruck, successMsg) {
      // Single choke point for every truck-geometry commit (Update truck + the
      // config-card save buttons). Block while another operation owns the editor,
      // and hold the lifecycle slot for the duration of the preview modal so AutoPack/
      // Unpack cannot mutate the pack underneath an open Truck Change.
      if (OperationLifecycle && OperationLifecycle.isBusy()) {
        UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Truck' });
        return { status: 'busy' };
      }
      const token = OperationLifecycle ? OperationLifecycle.beginOperation('changingTruck', { packId: pack.id }) : null;
      const release = () => { if (token && OperationLifecycle) OperationLifecycle.finishOperation(token); };
      let result;
      try {
        result = TruckChangeController.request({
          pack,
          nextTruck,
          successMessage: successMsg || 'Truck updated',
          onCommitted: () => { clearPendingTruck(); render(); release(); },
          restoreControls: () => { clearPendingTruck(); render(); release(); },
        });
      } catch (err) {
        release();
        throw err;
      }
      // If no preview modal opened (committed/unchanged/failed/invalid), the slot is
      // released now; for 'preview' it is held until the modal resolves via the
      // onCommitted / restoreControls callbacks above.
      if (!result || result.status !== 'preview') {
        if (result && result.status === 'committed') clearPendingTruck();
        release();
      }
      return result;
    }

    function renderTruckInspector(pack, prefs) {
      const lengthUnit = getLengthUnit(prefs);
      // The dropdowns/dims edit a PENDING truck; the committed truck (and the scene)
      // only change when the user clicks "Update truck". effectiveTruck pre-fills the
      // form; truckDirty drives the Update-truck active state.
      const effectiveTruck = getEffectiveTruck(pack) || pack.truck;
      const truckDirty = Boolean(pendingTruck && pendingTruck.__packId === pack.id) &&
        !TruckChangeController.truckGeometryEqual(pack.truck, effectiveTruck);
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.add('tp3d-editor-card-grid-gap-12');

      const viewedPack = getAutoPackResultsPreviewPack(pack) || pack;
      const stats = PackLibrary.computeStats(viewedPack);
      const truckHeader = document.createElement('div');
      truckHeader.className = 'row space-between tp3d-editor-inspector-title-row';
      const truckTitle = document.createElement('div');
      truckTitle.classList.add('tp3d-editor-fw-semibold');
      truckTitle.textContent = 'Truck';
      const hasLoadPlanNotes = Boolean(String(pack.notes || '').trim());
      packNotesButton = makeActionButton({
        label: 'Load Plan Notes',
        iconClass: 'fa-regular fa-file-lines',
        disabled: Boolean(OperationLifecycle && OperationLifecycle.isBusy()),
        onClick: event => {
          if (editorMutationBlocked()) return;
          const activePack = PackLibrary.getById(StateStore.get('currentPackId'));
          if (!activePack) return;
          openPackNotesModal(activePack, event.currentTarget);
        },
      });
      packNotesButton.dataset.notesEntityType = 'load plan';
      packNotesButton.dataset.notesEntityId = pack.id;
      if (hasLoadPlanNotes) {
        const notesIndicator = document.createElement('span');
        notesIndicator.className = 'tp3d-notes-indicator-dot';
        packNotesButton.appendChild(notesIndicator);
        const noteStatus = document.createElement('span');
        noteStatus.className = 'visually-hidden';
        noteStatus.textContent = ', notes present';
        packNotesButton.appendChild(noteStatus);
      }
      truckHeader.appendChild(truckTitle);
      truckHeader.appendChild(packNotesButton);
      card.appendChild(truckHeader);

      const presetRow = document.createElement('div');
      presetRow.className = 'row';
      presetRow.classList.add('tp3d-editor-preset-row');

      const presetWrap = document.createElement('div');
      presetWrap.className = 'field';
      presetWrap.classList.add('tp3d-editor-wrap-full');

      const presetLabel = document.createElement('div');
      presetLabel.className = 'label';
      presetLabel.textContent = 'Trailer preset';

      const presetSelect = UIComponents.createSelect({
        id: `tp3d-editor-field-${++editorFieldId}`,
        label: 'Trailer preset',
        options: [{ value: 'custom', label: 'Custom' }, ...TrailerPresets.getAll().map(p => ({
          value: String(p.id), label: String(p.label),
        }))],
        className: 'tp3d-editor-select-full',
      });
      presetSelect.dataset.focusKey = 'truck-preset';

      function inferPresetIdFromTruck(truck) {
        const t = truck && typeof truck === 'object' ? truck : {};
        const tl = Number(t.length);
        const tw = Number(t.width);
        const th = Number(t.height);
        const tm = String(t.shapeMode || 'rect');
        const presets = TrailerPresets.getAll();
        for (let i = 0; i < presets.length; i++) {
          const p = presets[i];
          const pt = p && p.truck ? p.truck : null;
          if (!pt) continue;
          if (
            Number(pt.length) === tl &&
            Number(pt.width) === tw &&
            Number(pt.height) === th &&
            String(pt.shapeMode || 'rect') === tm
          ) {
            return p.id;
          }
        }
        return 'custom';
      }

      presetSelect.value = inferPresetIdFromTruck(effectiveTruck);

      presetSelect.addEventListener('change', () => {
        // Pending only: pre-fill the form with the preset's geometry. Nothing is
        // reconciled, previewed, or committed until the user clicks "Update truck".
        if (OperationLifecycle && OperationLifecycle.isBusy()) {
          UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Truck' });
          presetSelect.value = inferPresetIdFromTruck(effectiveTruck);
          return;
        }
        const id = String(presetSelect.value || 'custom');
        if (id === 'custom') return;
        const preset = TrailerPresets.getById(id);
        if (!preset) return;
        setPendingTruck(pack, TrailerPresets.applyToTruck(pack.truck, preset));
        render();
      });

      presetWrap.appendChild(presetLabel);
      presetWrap.appendChild(presetSelect);
      presetRow.appendChild(presetWrap);

      const shapeRow = document.createElement('div');
      shapeRow.className = 'row';
      shapeRow.classList.add('tp3d-editor-preset-row');
      const shapeWrap = document.createElement('div');
      shapeWrap.className = 'field';
      shapeWrap.classList.add('tp3d-editor-wrap-full');
      const shapeLabel = document.createElement('div');
      shapeLabel.className = 'label';
      shapeLabel.textContent = 'Trailer Shape Mode';
      const shapeSelect = UIComponents.createSelect({
        id: `tp3d-editor-field-${++editorFieldId}`,
        label: 'Trailer Shape Mode',
        options: [
          { value: 'rect', label: 'Standard' },
          { value: 'wheelWells', label: 'Wheel Wells' },
          { value: 'frontBonus', label: 'Front Overhang' },
        ],
        className: 'tp3d-editor-select-full',
      });
      shapeSelect.dataset.focusKey = 'truck-shape';
      shapeSelect.value =
        effectiveTruck && (effectiveTruck.shapeMode === 'wheelWells' || effectiveTruck.shapeMode === 'frontBonus')
          ? effectiveTruck.shapeMode
          : 'rect';
      shapeWrap.appendChild(shapeLabel);
      shapeWrap.appendChild(shapeSelect);
      shapeRow.appendChild(shapeWrap);

      card.appendChild(presetRow);
      const dimsRow = document.createElement('div');
      dimsRow.className = 'row';
      dimsRow.classList.add('tp3d-editor-dims-row');
      const fL = smallField(`Length (${lengthUnit})`, Utils.inchesToUnit(effectiveTruck.length, lengthUnit), 'truck-length');
      const fW = smallField(`Width (${lengthUnit})`, Utils.inchesToUnit(effectiveTruck.width, lengthUnit), 'truck-width');
      const fH = smallField(`Height (${lengthUnit})`, Utils.inchesToUnit(effectiveTruck.height, lengthUnit), 'truck-height');
      [fL.wrap, fW.wrap, fH.wrap].forEach(wrap => wrap.classList.add('tp3d-editor-field-wrap-full'));
      dimsRow.appendChild(fL.wrap);
      dimsRow.appendChild(fW.wrap);
      dimsRow.appendChild(fH.wrap);

      const btnSave = document.createElement('button');
      btnSave.className = 'btn btn-primary';
      btnSave.type = 'button';
      btnSave.innerHTML = truckDirty
        ? '<i class="fa-solid fa-floppy-disk"></i> Update truck •'
        : '<i class="fa-solid fa-floppy-disk"></i> Update truck';
      btnSave.classList.add('tp3d-editor-btn-full');
      if (truckDirty) btnSave.classList.add('tp3d-editor-btn-attention');
      btnSave.dataset.role = 'truck-update';
      btnSave.addEventListener('click', () => {
        // Commit only after confirmation; pending form edits leave Results alone.
        if (OperationLifecycle && OperationLifecycle.isBusy()) {
          UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Truck' });
          return;
        }
        const minDisplay = Utils.inchesToUnit(24, lengthUnit);
        const fields = [fL, fW, fH];
        let invalidField = null;
        fields.forEach(field => {
          const raw = field.input.value.trim();
          const inches = raw ? displayLengthToInches(raw, NaN, lengthUnit) : NaN;
          const invalid = !Number.isFinite(inches) || inches < 24;
          setEditorFieldError(field, invalid ? `Enter at least ${Number(minDisplay.toFixed(1))} ${lengthUnit}.` : '');
          if (invalid && !invalidField) invalidField = field.input;
        });
        if (invalidField) {
          invalidField.focus();
          return;
        }
        const next = {
          ...effectiveTruck,
          length: Math.max(24, displayLengthToInches(fL.input.value, effectiveTruck.length, lengthUnit)),
          width: Math.max(24, displayLengthToInches(fW.input.value, effectiveTruck.width, lengthUnit)),
          height: Math.max(24, displayLengthToInches(fH.input.value, effectiveTruck.height, lengthUnit)),
          shapeMode:
            effectiveTruck && (effectiveTruck.shapeMode === 'wheelWells' || effectiveTruck.shapeMode === 'frontBonus')
              ? effectiveTruck.shapeMode
              : 'rect',
          shapeConfig:
            effectiveTruck && effectiveTruck.shapeConfig && typeof effectiveTruck.shapeConfig === 'object'
              ? Utils.deepClone(effectiveTruck.shapeConfig)
              : {},
        };
        // Clamp config values to bounds (safe even if unused)
        if (next.shapeMode === 'wheelWells') {
          const cfg = next.shapeConfig || {};
          if (Number.isFinite(cfg.wellHeight)) cfg.wellHeight = Utils.clamp(Number(cfg.wellHeight), 0, next.height);
          if (Number.isFinite(cfg.wellWidth)) cfg.wellWidth = Utils.clamp(Number(cfg.wellWidth), 0, next.width / 2);
          if (Number.isFinite(cfg.wellLength)) cfg.wellLength = Utils.clamp(Number(cfg.wellLength), 0, next.length);
          if (Number.isFinite(cfg.wellOffsetFromRear)) {
            cfg.wellOffsetFromRear = Utils.clamp(Number(cfg.wellOffsetFromRear), 0, next.length);
          }
          next.shapeConfig = cfg;
        } else if (next.shapeMode === 'frontBonus') {
          const cfg = next.shapeConfig || {};
          if (Number.isFinite(cfg.bonusLength)) cfg.bonusLength = Utils.clamp(Number(cfg.bonusLength), 0, next.length);
          // bonusWidth is no longer used in overhang geometry (the overhang
          // always spans the full trailer width). Kept on shapeConfig for
          // backward compatibility only, normalized to truck.width.
          if (Number.isFinite(cfg.bonusWidth)) cfg.bonusWidth = next.width;
          if (Number.isFinite(cfg.bonusHeight)) cfg.bonusHeight = Utils.clamp(Number(cfg.bonusHeight), 0, next.height);
          next.shapeConfig = cfg;
        }

        clearPendingTruck();
        applyTruckGeometryChange(pack, next, 'Truck updated');
      });

      shapeSelect.addEventListener('change', () => {
        // Pending only: pre-fill the form (and surface the matching config card on the
        // next render). Confirmation opens only when the user clicks Update truck.
        if (OperationLifecycle && OperationLifecycle.isBusy()) {
          UIComponents.showToast('Another operation is in progress. Please wait…', 'info', { title: 'Truck' });
          shapeSelect.value = effectiveTruck && (effectiveTruck.shapeMode === 'wheelWells' || effectiveTruck.shapeMode === 'frontBonus') ? effectiveTruck.shapeMode : 'rect';
          return;
        }
        const mode = String(shapeSelect.value || 'rect');
        const nextTruck = {
          ...effectiveTruck,
          shapeMode: mode === 'wheelWells' || mode === 'frontBonus' ? mode : 'rect',
          shapeConfig:
            effectiveTruck && effectiveTruck.shapeConfig && typeof effectiveTruck.shapeConfig === 'object'
              ? Utils.deepClone(effectiveTruck.shapeConfig)
              : {},
        };

        // Fill sensible defaults (stored) + clamp to trailer bounds.
        if (nextTruck.shapeMode === 'wheelWells') {
          const cfg = nextTruck.shapeConfig || {};
          if (!Number.isFinite(cfg.wellHeight)) cfg.wellHeight = 0.35 * nextTruck.height;
          if (!Number.isFinite(cfg.wellWidth)) cfg.wellWidth = 0.15 * nextTruck.width;
          if (!Number.isFinite(cfg.wellLength)) cfg.wellLength = 0.35 * nextTruck.length;
          if (!Number.isFinite(cfg.wellOffsetFromRear)) cfg.wellOffsetFromRear = 0.25 * nextTruck.length;
          cfg.wellHeight = Utils.clamp(Number(cfg.wellHeight) || 0, 0, nextTruck.height);
          cfg.wellWidth = Utils.clamp(Number(cfg.wellWidth) || 0, 0, nextTruck.width / 2);
          cfg.wellLength = Utils.clamp(Number(cfg.wellLength) || 0, 0, nextTruck.length);
          cfg.wellOffsetFromRear = Utils.clamp(Number(cfg.wellOffsetFromRear) || 0, 0, nextTruck.length);
          nextTruck.shapeConfig = cfg;
        } else if (nextTruck.shapeMode === 'frontBonus') {
          nextTruck.shapeConfig = TrailerPresets.normalizeFrontBonusShapeConfig(nextTruck.shapeConfig, nextTruck);
        }

        // Pending only — store the new shape (with its default config) and re-render
        // so the matching config card appears. Committing happens on Update truck.
        setPendingTruck(pack, nextTruck);
        render();
      });

      const statsEl = document.createElement('div');
      statsEl.className = 'card';
      statsEl.classList.add('tp3d-editor-stats-card');
      const autoPackLoading = isAutoPackLoadingCargo();
      // Counts, loaded mass and utilization share the scene's viewed subject.
      // computeStats preserves nullable mass; this projection never writes Pack.
      const utilization = autoPackLoading ? null
        : buildSpaceUtilizationResult(viewedPack, PackLibrary);
      statsEl.innerHTML = autoPackLoading ? `
              <div class="tp3d-editor-fw-semibold">Load Summary</div>
              <div class="muted tp3d-editor-fs-sm tp3d-editor-stats-updating" data-role="load-summary-updating">Updating…</div>
            ` : `
              <div class="tp3d-editor-fw-semibold">Load Summary</div>
              <div class="row space-between"><span class="muted tp3d-editor-fs-sm">In truck</span><b class="tp3d-text-primary tp3d-editor-fs-sm">${utilization.loadedCount || 0}</b></div>
              <div class="row space-between"><span class="muted tp3d-editor-fs-sm">Staged</span><b class="tp3d-text-primary tp3d-editor-fs-sm">${utilization.stagedCount || 0}</b></div>
              <div class="row space-between"><span class="muted tp3d-editor-fs-sm">Total weight</span><b class="tp3d-text-primary tp3d-editor-fs-sm">${Utils.formatWeight(stats.totalWeight, prefs.units.weight)}</b></div>
            `;

      card.appendChild(shapeRow);
      card.appendChild(dimsRow);
      card.appendChild(btnSave);
      inspectorEl.appendChild(card);

      // === Shape Config Card (Overhang / Wheel Wells) ===
      // Keyed off effectiveTruck (pending or committed), so selecting Wheel Wells /
      // Front Overhang in the dropdown shows that mode's config controls immediately
      // in the form — the 3D scene still shows the committed truck until Update truck.
      const currentMode = effectiveTruck && effectiveTruck.shapeMode ? effectiveTruck.shapeMode : 'rect';
      if (currentMode === 'frontBonus' || currentMode === 'wheelWells') {
        const cfgCard = document.createElement('div');
        cfgCard.className = 'card';
        cfgCard.classList.add('tp3d-editor-card-grid-gap-12');

        const cfg = (effectiveTruck && effectiveTruck.shapeConfig && typeof effectiveTruck.shapeConfig === 'object')
          ? effectiveTruck.shapeConfig : {};
        const tL = effectiveTruck.length || 636;
        const tW = effectiveTruck.width || 102;
        const tH = effectiveTruck.height || 110;

        if (currentMode === 'frontBonus') {
          cfgCard.appendChild(cardHeaderWithInfo(
            'Front Overhang',
            'Adds a raised deck above the cab. Length controls how far it extends. Deck Height controls cab clearance; the space below is blocked.'
          ));

          const defBL = Math.round(0.12 * tL);
          const defBW = tW;
          const defBH = Math.round(0.45 * tH);
          const bonusLength = Number.isFinite(cfg.bonusLength) ? cfg.bonusLength : defBL;
          const bonusHeight = Number.isFinite(cfg.bonusHeight) ? cfg.bonusHeight : defBH;

          const cfgRow = document.createElement('div');
          cfgRow.className = 'tp3d-editor-dims-row tp3d-editor-dims-row--two';
          const fBL = smallField(`Length (${lengthUnit})`, Utils.inchesToUnit(bonusLength, lengthUnit), 'overhang-length');
          const fBH = smallField(`Deck Height (${lengthUnit})`, Utils.inchesToUnit(bonusHeight, lengthUnit), 'overhang-height');
          [fBL.wrap, fBH.wrap].forEach(w => w.classList.add('tp3d-editor-field-wrap-full'));
          cfgRow.appendChild(fBL.wrap);
          cfgRow.appendChild(fBH.wrap);
          cfgCard.appendChild(cfgRow);

          const usableOverhangHeight = Math.max(0, tH - bonusHeight);
          const cfgHint = document.createElement('div');
          cfgHint.className = 'muted tp3d-editor-fs-xs';
          cfgHint.textContent =
            `Usable overhang height: ${Utils.inchesToUnit(usableOverhangHeight, lengthUnit).toFixed(1)} ${lengthUnit} ` +
            '(trailer height − deck height)';
          cfgCard.appendChild(cfgHint);

          const btnRow = document.createElement('div');
          btnRow.className = 'row';
          btnRow.classList.add('tp3d-editor-row-gap-10');

          const cfgSave = document.createElement('button');
          cfgSave.className = 'btn btn-primary';
          cfgSave.type = 'button';
          cfgSave.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update';
          cfgSave.addEventListener('click', () => {
            const nextCfg = {
              bonusLength: Utils.clamp(displayLengthToInches(fBL.input.value, bonusLength, lengthUnit), 0, tL),
              // Width is fixed to the trailer's full width for this mode and
              // is not user-editable. Kept on shapeConfig for backward
              // compatibility only.
              bonusWidth: tW,
              bonusHeight: Utils.clamp(displayLengthToInches(fBH.input.value, bonusHeight, lengthUnit), 0, tH),
            };
            const nextTruck = { ...effectiveTruck, shapeConfig: nextCfg };
            applyTruckGeometryChange(pack, nextTruck, 'Overhang updated');
          });

          const cfgReset = document.createElement('button');
          cfgReset.className = 'btn';
          cfgReset.type = 'button';
          cfgReset.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i> Reset';
          cfgReset.addEventListener('click', () => {
            fBL.input.value = String(Utils.inchesToUnit(defBL, lengthUnit).toFixed(1));
            fBH.input.value = String(Utils.inchesToUnit(defBH, lengthUnit).toFixed(1));
            const nextCfg = { bonusLength: defBL, bonusWidth: defBW, bonusHeight: defBH };
            const nextTruck = { ...effectiveTruck, shapeConfig: nextCfg };
            applyTruckGeometryChange(pack, nextTruck, 'Overhang reset to defaults');
          });

          btnRow.appendChild(cfgSave);
          btnRow.appendChild(cfgReset);
          cfgCard.appendChild(btnRow);
        }

        if (currentMode === 'wheelWells') {
          cfgCard.appendChild(cardHeaderWithInfo(
            'Wheel Wells',
            'Defines matching blocked zones on both sides of the truck. Offset is measured from the rear/loading door.'
          ));

          const defWH = Math.round(0.35 * tH);
          const defWW = Math.round(0.15 * tW);
          const defWL = Math.round(0.35 * tL);
          const defWO = Math.round(0.25 * tL);
          const wellHeight = Number.isFinite(cfg.wellHeight) ? cfg.wellHeight : defWH;
          const wellWidth = Number.isFinite(cfg.wellWidth) ? cfg.wellWidth : defWW;
          const wellLength = Number.isFinite(cfg.wellLength) ? cfg.wellLength : defWL;
          const wellOffset = Number.isFinite(cfg.wellOffsetFromRear) ? cfg.wellOffsetFromRear : defWO;

          const cfgRow1 = document.createElement('div');
          cfgRow1.className = 'tp3d-editor-dims-row';
          const fWH = smallField(`Height (${lengthUnit})`, Utils.inchesToUnit(wellHeight, lengthUnit), 'well-height');
          const fWW = smallField(`Width (${lengthUnit})`, Utils.inchesToUnit(wellWidth, lengthUnit), 'well-width');
          const fWL = smallField(`Length (${lengthUnit})`, Utils.inchesToUnit(wellLength, lengthUnit), 'well-length');
          [fWH.wrap, fWW.wrap, fWL.wrap].forEach(w => w.classList.add('tp3d-editor-field-wrap-full'));
          cfgRow1.appendChild(fWH.wrap);
          cfgRow1.appendChild(fWW.wrap);
          cfgRow1.appendChild(fWL.wrap);
          cfgCard.appendChild(cfgRow1);

          const fWO = smallField(`Offset from rear (${lengthUnit})`, Utils.inchesToUnit(wellOffset, lengthUnit), 'well-offset');
          fWO.wrap.classList.add('tp3d-editor-field-wrap-full');
          cfgCard.appendChild(fWO.wrap);

          const btnRow = document.createElement('div');
          btnRow.className = 'row';
          btnRow.classList.add('tp3d-editor-row-gap-10');

          const cfgSave = document.createElement('button');
          cfgSave.className = 'btn btn-primary';
          cfgSave.type = 'button';
          cfgSave.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update';
          cfgSave.addEventListener('click', () => {
            const nextCfg = {
              wellHeight: Utils.clamp(displayLengthToInches(fWH.input.value, wellHeight, lengthUnit), 0, tH),
              wellWidth: Utils.clamp(displayLengthToInches(fWW.input.value, wellWidth, lengthUnit), 0, tW / 2),
              wellLength: Utils.clamp(displayLengthToInches(fWL.input.value, wellLength, lengthUnit), 0, tL),
              wellOffsetFromRear: Utils.clamp(displayLengthToInches(fWO.input.value, wellOffset, lengthUnit), 0, tL),
            };
            if (nextCfg.wellOffsetFromRear + nextCfg.wellLength > tL) {
              nextCfg.wellLength = tL - nextCfg.wellOffsetFromRear;
            }
            const nextTruck = { ...effectiveTruck, shapeConfig: nextCfg };
            applyTruckGeometryChange(pack, nextTruck, 'Wheel wells updated');
          });

          const cfgReset = document.createElement('button');
          cfgReset.className = 'btn';
          cfgReset.type = 'button';
          cfgReset.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i> Reset';
          cfgReset.addEventListener('click', () => {
            fWH.input.value = String(Utils.inchesToUnit(defWH, lengthUnit).toFixed(1));
            fWW.input.value = String(Utils.inchesToUnit(defWW, lengthUnit).toFixed(1));
            fWL.input.value = String(Utils.inchesToUnit(defWL, lengthUnit).toFixed(1));
            fWO.input.value = String(Utils.inchesToUnit(defWO, lengthUnit).toFixed(1));
            const nextCfg = {
              wellHeight: defWH, wellWidth: defWW,
              wellLength: defWL, wellOffsetFromRear: defWO,
            };
            const nextTruck = { ...effectiveTruck, shapeConfig: nextCfg };
            applyTruckGeometryChange(pack, nextTruck, 'Wheel wells reset to defaults');
          });

          btnRow.appendChild(cfgSave);
          btnRow.appendChild(cfgReset);
          cfgCard.appendChild(btnRow);
        }

        inspectorEl.appendChild(cfgCard);
      }

      inspectorEl.appendChild(statsEl);
    }

    function renderMultiInspector(pack, selected) {
      // === Selection Info Card ===
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.add('tp3d-editor-card-grid-gap-12');
      const title = document.createElement('div');
      title.classList.add('tp3d-editor-fw-semibold');
      title.textContent = `${selected.length} cases selected`;
      card.appendChild(title);
      // Surface unresolved (dangling) items inside a multi-selection so the user can
      // see they are excluded from AutoPack and Stats.
      const unresolvedSelected = selected
        .map(id => (pack.cases || []).find(i => i.id === id))
        .filter(inst => inst && !CaseLibrary.getById(inst.caseId)).length;
      if (unresolvedSelected > 0) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.classList.add('tp3d-editor-sub-sm');
        note.textContent = `${unresolvedSelected} of these reference a missing case definition and are excluded from AutoPack and Stats.`;
        card.appendChild(note);
      }
      inspectorEl.appendChild(card);

      // === Batch Rotation Card ===
      const rotCard = document.createElement('div');
      rotCard.className = 'card';
      rotCard.classList.add('tp3d-editor-card-grid-gap-12');
      const rotateFlipHelp = 'Turn: Y axis. Tip: X axis. Roll: Z axis. Flip: 180°.';
      rotCard.appendChild(cardHeaderWithInfo('Rotate All', rotateFlipHelp));

      const halfPI = Math.PI / 2;
      const rotRow = document.createElement('div');
      rotRow.className = 'tp3d-editor-rot-grid';
      [
        { label: 'Turn', icon: 'fa-rotate', tone: 'turn', axis: 'y', delta: halfPI },
        { label: 'Tip', icon: 'fa-rotate-left', tone: 'tip', axis: 'x', delta: halfPI },
        { label: 'Roll', icon: 'fa-rotate-right', tone: 'roll', axis: 'z', delta: halfPI },
        { label: 'Flip', icon: 'fa-arrows-up-down', tone: 'flip', axis: 'x', delta: Math.PI },
      ].forEach(({ label, icon, tone, axis, delta }) => {
        const btn = document.createElement('button');
        btn.className = `btn tp3d-editor-rot-btn tp3d-editor-rot-btn--${tone}`;
        btn.type = 'button';
        btn.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
        btn.addEventListener('click', () => {
          InteractionManager.rotateSelection(axis, delta);
        });
        rotRow.appendChild(btn);
      });
      rotCard.appendChild(rotRow);
      inspectorEl.appendChild(rotCard);

      // === Actions Card ===
      const actCard = document.createElement('div');
      actCard.className = 'card';
      actCard.classList.add('tp3d-editor-card-grid-gap-12');
      const actTitle = document.createElement('div');
      actTitle.classList.add('tp3d-editor-fw-semibold');
      actTitle.textContent = 'Actions';
      actCard.appendChild(actTitle);

      const actRow = document.createElement('div');
      actRow.className = 'tp3d-editor-action-grid';

      const btnSelectAll = makeSelectAllButton(pack, selected.length);

      const btnSetCategory = makeActionButton({
        label: 'Set Category',
        iconClass: 'fa-solid fa-tag',
        onClick: () => openSetCategoryModal(pack, selected),
      });
      const btnVisibility = makeVisibilityButton(pack, selected);
      const btnClear = makeActionButton({
        label: 'Deselect',
        iconHtml: deselectBoxIconSvg(),
        onClick: () => InteractionManager.setSelection([]),
      });
      const btnDuplicate = makeActionButton({
        label: 'Duplicate',
        iconClass: 'fa-solid fa-copy',
        onClick: () => duplicateSelection(pack, selected),
      });
      const btnDelete = makeActionButton({
        label: `Delete (${selected.length})`,
        iconClass: 'fa-solid fa-trash',
        danger: true,
        onClick: () => InteractionManager.deleteSelection(),
      });

      actRow.appendChild(btnSetCategory);
      actRow.appendChild(btnVisibility);
      actRow.appendChild(btnSelectAll);
      actRow.appendChild(btnClear);
      actRow.appendChild(btnDuplicate);
      actRow.appendChild(btnDelete);
      actCard.appendChild(actRow);
      inspectorEl.appendChild(actCard);

      const categoryContext = getSelectedCategoryContext(pack, selected);
      if (categoryContext) {
        inspectorEl.appendChild(renderCategorySelectionCard(pack, categoryContext.categoryKey));
      }
    }

    function renderSingleInspector(pack, inst, caseData, prefs) {
      const lengthUnit = getLengthUnit(prefs);
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.add('tp3d-editor-card-grid-gap-12');

      // Header mirrors the Truck card: section title + Notes. titleRow is appended
      // directly to .card (not wrapped) so it picks up the existing
      // "#inspector-body .card>.row.space-between" sizing/min-width rule.
      const titleRow = document.createElement('div');
      titleRow.className = 'row space-between tp3d-editor-inspector-title-row';
      const title = document.createElement('div');
      title.classList.add('tp3d-editor-fw-semibold');
      title.textContent = 'Cases';
      const hasAnyNotes = Boolean(String(caseData.notes || '').trim()) || Boolean(String(inst.instanceNotes || '').trim());
      const notesButton = makeActionButton({
        label: 'Notes',
        iconClass: 'fa-regular fa-file-lines',
        onClick: () => openNotesModal(pack, inst),
      });
      notesButton.dataset.notesEntityType = 'item';
      notesButton.dataset.notesEntityId = inst.id;
      if (hasAnyNotes) {
        const notesIndicator = document.createElement('span');
        notesIndicator.className = 'tp3d-notes-indicator-dot';
        notesButton.appendChild(notesIndicator);
        const noteStatus = document.createElement('span');
        noteStatus.className = 'visually-hidden';
        noteStatus.textContent = ', notes present';
        notesButton.appendChild(noteStatus);
      }
      titleRow.appendChild(title);
      titleRow.appendChild(notesButton);
      card.appendChild(titleRow);
      const name = document.createElement('div');
      name.className = 'tp3d-editor-case-name';
      name.textContent = caseData.name || '—';
      name.title = caseData.name || '';
      card.appendChild(name);
      // Read-only case metadata pills share the Case Browser's dimensions,
      // volume, and two-decimal weight display contract.
      const meta = document.createElement('div');
      meta.className = 'tp3d-editor-case-meta';
      const addMetaChip = text => {
        const chip = document.createElement('span');
        chip.className = 'badge tp3d-editor-meta-chip';
        chip.textContent = text;
        meta.appendChild(chip);
      };
      const d = caseData.dimensions || { length: 0, width: 0, height: 0 };
      const hasDims = ['length', 'width', 'height'].every(axis => Number.isFinite(d[axis]));
      if (hasDims) {
        addMetaChip(Utils.formatDims(d, lengthUnit));
        addMetaChip(Utils.formatVolume(d, lengthUnit));
      }
      const weightLabel = formatEditorCaseWeightLabel(caseData.weight, (prefs.units && prefs.units.weight) || 'lb');
      if (weightLabel !== '—') addMetaChip(weightLabel);
      const manufacturer = String(caseData.manufacturer || '').trim();
      if (manufacturer) addMetaChip(manufacturer);
      meta.appendChild(makeMiniCategoryChip(caseData.category));
      card.appendChild(meta);
      if (!inst.hidden && inst.placement !== 'staged') {
        const bounds = CaseScene.getAabbWorld(inst.id);
        if (bounds && !CaseScene.isInsideTruck(bounds)) {
          const warning = document.createElement('p');
          warning.className = 'tp3d-editor-oog-warning';
          warning.textContent = 'Out of gauge — this case extends outside the truck.';
          card.appendChild(warning);
        }
      }

      // Instance orientation is controlled once, in Rotate / Flip below.
      const caseRules = getCaseHandlingSummary(caseData);
      if (caseRules.length) {
        const rulesWrap = document.createElement('div');
        rulesWrap.className = 'tp3d-editor-handling-rules';
        const heading = document.createElement('div');
        heading.className = 'tp3d-editor-rules-heading';
        heading.textContent = 'Handling rules';
        rulesWrap.appendChild(heading);
        const chips = document.createElement('div');
        chips.className = 'tp3d-editor-handling-chips';
        caseRules.forEach(label => {
          const chip = document.createElement('span');
          chip.className = 'badge tp3d-handling-chip';
          chip.textContent = label;
          chips.appendChild(chip);
        });
        rulesWrap.appendChild(chips);
        card.appendChild(rulesWrap);
      }

      inspectorEl.appendChild(card);

      // === Transform Card (Position + Rotate / Flip) ===
      const transformCard = document.createElement('div');
      transformCard.className = 'card';
      transformCard.classList.add('tp3d-editor-card-grid-gap-12', 'tp3d-editor-transform-card');
      transformCard.appendChild(cardHeaderWithInfo(
        'Transform',
        'Position uses the selected display units. Changes are checked against collisions and usable truck zones.'
      ));

      const posTitle = document.createElement('div');
      posTitle.className = 'label';
      posTitle.textContent = 'Position';
      transformCard.appendChild(posTitle);

      const posRow = document.createElement('div');
      posRow.className = 'tp3d-editor-dims-row tp3d-editor-position-row';
      const pos = inst.transform.position || { x: 0, y: 0, z: 0 };
      const fX = inlinePositionField('X', lengthUnit, Utils.inchesToUnit(pos.x, lengthUnit));
      const fY = inlinePositionField('Y', lengthUnit, Utils.inchesToUnit(pos.y, lengthUnit));
      const fZ = inlinePositionField('Z', lengthUnit, Utils.inchesToUnit(pos.z, lengthUnit));
      [fX.wrap, fY.wrap, fZ.wrap].forEach(w => w.classList.add('tp3d-editor-field-wrap-full'));
      posRow.appendChild(fX.wrap);
      posRow.appendChild(fY.wrap);
      posRow.appendChild(fZ.wrap);
      transformCard.appendChild(posRow);

      const savePos = document.createElement('button');
      savePos.className = 'btn btn-primary';
      savePos.classList.add('tp3d-editor-btn-full');
      savePos.type = 'button';
      savePos.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Apply position';
      savePos.addEventListener('click', () => {
        if (editorMutationBlocked({ endPreview: true })) return;
        const nextPos = {
          x: Utils.unitToInches(Number(fX.input.value) || 0, lengthUnit),
          y: Utils.unitToInches(Number(fY.input.value) || 0, lengthUnit),
          z: Utils.unitToInches(Number(fZ.input.value) || 0, lengthUnit),
        };
        const obj = CaseScene.getObject(inst.id);
        const originalWorld = obj ? obj.position.clone() : null;
        const candidateWorld = SceneManager.vecInchesToWorld(nextPos);
        const ignoreSet = new Set([inst.id]);
        const stagedTruckProposal = inst.placement === 'staged' &&
          pointInsideTruckFootprint(PackLibrary.getTrailerUsableZones(pack.truck), nextPos);
        let check = CaseScene.checkCollision(inst.id, candidateWorld, ignoreSet);
        CaseScene.setCollision(inst.id, check.collides);
        if (check.collides && !stagedTruckProposal) {
          UIComponents.showToast('Cannot place here: collision detected', 'error');
          CaseScene.setCollision(inst.id, false);
          return;
        }

        // Validated vertical resolve replaces the naive gravity settle: a typed Y
        // is honored when it is a legal supported level, corrected to the nearest
        // legal level otherwise, and never silently settled onto a case that
        // cannot carry it. Out-of-truck moves keep the legacy settle+stage path.
        let resolved = null;
        const normalHandlingPack = buildNormalHandlingPack(pack, [inst.id]);
        if (typeof PackLibrary.findManualVerticalPlacement === 'function' &&
            (inst.placement !== 'staged' || stagedTruckProposal)) {
          resolved = PackLibrary.findManualVerticalPlacement(normalHandlingPack, CaseLibrary.getCases(), inst.id, {
            mode: 'resolve',
            desiredPosition: nextPos,
            manualGeometry: true,
            rejectProposedCollisions: stagedTruckProposal,
          });
        }
        if (resolved && !resolved.ok && resolved.code !== 'outside-truck') {
          CaseScene.setCollision(inst.id, false);
          UIComponents.showToast(resolved.reason || 'Cannot place here.', 'error');
          return;
        }
        const corrected = Boolean(resolved && resolved.ok && resolved.corrected);
        const useLegacySettle = !resolved || !resolved.ok;
        let finalPos = resolved && resolved.ok ? resolved.position : nextPos;
        if (obj) {
          obj.position.copy(SceneManager.vecInchesToWorld(finalPos));
          if (useLegacySettle) {
            const settledY = CaseScene.settleY(inst.id);
            if (settledY !== null) obj.position.y = settledY;
          }
          check = CaseScene.checkCollision(inst.id, obj.position, ignoreSet);
          CaseScene.setCollision(inst.id, check.collides);
          if (check.collides && !stagedTruckProposal) {
            if (originalWorld) obj.position.copy(originalWorld);
            UIComponents.showToast('Cannot place here: collision detected', 'error');
            CaseScene.setCollision(inst.id, false);
            return;
          }
          if (useLegacySettle) { finalPos = SceneManager.vecWorldToInches(obj.position); }
        }
        CaseScene.setCollision(inst.id, false);
        const nextCases = (normalHandlingPack.cases || []).map(item =>
          item.id === inst.id
            ? { ...item, transform: { ...item.transform, position: finalPos },
              placement: stagedTruckProposal && resolved?.ok ? 'packed' : item.placement }
            : item
        );
        let preflight = null;
        if (stagedTruckProposal) {
          preflight = PackLibrary.revalidateManualPlacements(
            { ...pack, cases: nextCases }, CaseLibrary.getCases(),
            { beforePack: pack, repairDependents: true, manualGeometry: true }
          );
          const checked = preflight.pack.cases.find(item => item?.id === inst.id);
          if (checked?.placement !== 'packed' ||
              !positionsShareManualXZ(checked?.transform?.position, finalPos) ||
              !positionsShareManualY(checked?.transform?.position, finalPos)) {
            if (obj && originalWorld) obj.position.copy(originalWorld);
            CaseScene.setCollision(inst.id, false);
            UIComponents.showToast(preflight.invalidReasons?.[inst.id] ||
              'This position has no stable physical support.', 'error');
            return;
          }
        }
        let result = null;
        if (preflight) {
          const committed = PackLibrary.update(pack.id, { cases: preflight.pack.cases });
          if (!committed) {
            if (obj && originalWorld) obj.position.copy(originalWorld);
            UIComponents.showToast('Load Plan is unavailable. No Case was moved.', 'error');
            return;
          }
          result = { ...preflight, pack: committed };
        } else if (typeof PackLibrary.updateCasesWithManualRevalidation === 'function') {
          result = PackLibrary.updateCasesWithManualRevalidation(pack.id, nextCases, CaseLibrary.getCases(), {
            repairDependents: true,
            manualGeometry: true,
          });
        } else {
          PackLibrary.update(pack.id, { cases: nextCases });
        }
        if (inst.placement !== 'staged') {
          SceneManager.focusOnWorldPoint(SceneManager.vecInchesToWorld(finalPos), { duration: 420 });
        }
        const baseMessage = corrected ? 'Adjusted to the nearest supported level.' : 'Position updated';
        UIComponents.showToast(
          result ? formatVerticalMoveMessage(result, inst.id, baseMessage) : baseMessage,
          corrected ? 'info' : 'success'
        );
        CaseScene.applyOOGHighlights();
      });
      transformCard.appendChild(savePos);

      // Vertical placement row: single packed case only. Staged cases must be
      // placed in the truck first, so the row is hidden for them.
      if (inst.placement !== 'staged') {
        const vertTitle = document.createElement('div');
        vertTitle.className = 'label';
        vertTitle.textContent = 'Vertical placement';
        transformCard.appendChild(vertTitle);

        const vertRow = document.createElement('div');
        vertRow.className = 'tp3d-editor-vert-grid';
        const alt = altKeyHintLabel();
        [
          { text: 'Up', icon: 'fa-arrow-up', tone: 'up', mode: 'up', hint: `Move up to the next valid level (${alt}+↑)` },
          { text: 'Down', icon: 'fa-arrow-down', tone: 'down', mode: 'down', hint: `Move down to the next valid level (${alt}+↓)` },
          { text: 'Drop', icon: 'fa-arrows-down-to-line', tone: 'drop', mode: 'drop', hint: `Drop to nearest valid surface (${alt}+Shift+↓)` },
        ].forEach(({ text, icon, tone, mode, hint }) => {
          const btn = document.createElement('button');
          btn.className = `btn tp3d-editor-rot-btn tp3d-editor-vert-btn--${tone}`;
          btn.type = 'button';
          btn.title = hint;
          btn.innerHTML = `<i class="fa-solid ${icon}"></i><span>${text}</span>`;
          btn.addEventListener('click', () => {
            InteractionManager.moveSelectionVertical(mode);
          });
          vertRow.appendChild(btn);
        });
        transformCard.appendChild(vertRow);
      }
      inspectorEl.appendChild(transformCard);

      // === Rotate / Flip Card ===
      const rotCard = document.createElement('div');
      rotCard.className = 'card';
      rotCard.classList.add('tp3d-editor-card-grid-gap-12');
      const rotateFlipHelp = 'Turn: Y axis. Tip: X axis. Roll: Z axis. Flip: 180°.';
      rotCard.appendChild(cardHeaderWithInfo('Rotate / Flip', rotateFlipHelp));

      const halfPI = Math.PI / 2;
      const rotRow = document.createElement('div');
      rotRow.className = 'tp3d-editor-rot-grid';
      [
        { label: 'Turn', icon: 'fa-rotate', tone: 'turn', axis: 'y', delta: halfPI },
        { label: 'Tip', icon: 'fa-rotate-left', tone: 'tip', axis: 'x', delta: halfPI },
        { label: 'Roll', icon: 'fa-rotate-right', tone: 'roll', axis: 'z', delta: halfPI },
        { label: 'Flip', icon: 'fa-arrows-up-down', tone: 'flip', axis: 'x', delta: Math.PI },
      ].forEach(({ label, icon, tone, axis, delta }) => {
        const btn = document.createElement('button');
        btn.className = `btn tp3d-editor-rot-btn tp3d-editor-rot-btn--${tone}`;
        btn.type = 'button';
        btn.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
        btn.addEventListener('click', () => {
          InteractionManager.rotateSelection(axis, delta);
        });
        rotRow.appendChild(btn);
      });
      rotCard.appendChild(rotRow);
      const orientationActive = inst.orientationLocked === true;
      const orientationAction = makeActionButton({
        label: orientationActive ? 'Unlock for AutoPack' : 'Lock for AutoPack',
        iconClass: orientationActive ? 'fa-solid fa-unlock' : 'fa-solid fa-lock',
        onClick: () => InteractionManager.setSelectionOrientationConstraint(!orientationActive, inst.id),
      });
      orientationAction.setAttribute('aria-pressed', String(orientationActive));
      orientationAction.dataset.focusKey = 'action-autopack-orientation';
      rotCard.appendChild(orientationAction);
      inspectorEl.appendChild(rotCard);

      // === Actions Card ===
      const actCard = document.createElement('div');
      actCard.className = 'card';
      actCard.classList.add('tp3d-editor-card-grid-gap-12');
      const actTitle = document.createElement('div');
      actTitle.classList.add('tp3d-editor-fw-semibold');
      actTitle.textContent = 'Actions';
      actCard.appendChild(actTitle);

      const actRow = document.createElement('div');
      actRow.className = 'tp3d-editor-action-grid';

      const selectAll = makeSelectAllButton(pack, 1);
      const setCategory = makeActionButton({
        label: 'Set Category',
        iconClass: 'fa-solid fa-tag',
        onClick: () => openSetCategoryModal(pack, [inst.id]),
      });
      const visibility = makeVisibilityButton(pack, [inst.id]);
      const clear = makeActionButton({
        label: 'Deselect',
        iconHtml: deselectBoxIconSvg(),
        onClick: () => {
          StateStore.set({ selectedInstanceIds: [] }, { skipHistory: true });
          CaseScene.setSelected([]);
        },
      });
      const duplicate = makeActionButton({
        label: 'Duplicate',
        iconClass: 'fa-solid fa-copy',
        onClick: () => duplicateSelection(pack, [inst.id]),
      });
      const deleteButton = makeActionButton({
        label: 'Delete',
        iconClass: 'fa-solid fa-trash',
        danger: true,
        onClick: () => {
          if (editorMutationBlocked()) return;
          deleteInstancesWithFeedback(pack.id, [inst.id]);
        },
      });
      actRow.appendChild(setCategory);
      actRow.appendChild(visibility);
      actRow.appendChild(selectAll);
      actRow.appendChild(clear);
      actRow.appendChild(duplicate);
      actRow.appendChild(deleteButton);
      actCard.appendChild(actRow);
      inspectorEl.appendChild(actCard);

      const categoryKey = getCaseCategoryKey(caseData);
      if (categoryKey) {
        inspectorEl.appendChild(renderCategorySelectionCard(pack, categoryKey));
      }
    }

    /**
     * Creates a card header row with a title and a compact help icon.
     */
    function cardHeaderWithInfo(titleText, tooltipText) {
      const header = document.createElement('div');
      header.className = 'row space-between';
      const title = document.createElement('div');
      title.classList.add('tp3d-editor-fw-semibold');
      title.textContent = titleText;
      header.appendChild(title);

      if (tooltipText) {
        const infoIcon = document.createElement('button');
        infoIcon.type = 'button';
        infoIcon.className = 'muted tp3d-editor-info-icon';
        infoIcon.setAttribute('data-tooltip', tooltipText);
        infoIcon.setAttribute('aria-label', tooltipText);
        infoIcon.innerHTML = '<i class="fa-solid fa-circle-question"></i>';
        header.appendChild(infoIcon);
      }

      return header;
    }

    function getLengthUnit(prefs) {
      return prefs && prefs.units && prefs.units.length ? prefs.units.length : 'in';
    }

    function displayLengthToInches(value, fallbackInches, unit) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallbackInches;
      return Utils.unitToInches(n, unit || 'in');
    }

    function inlinePositionField(axis, unit, value) {
      const wrap = document.createElement('div');
      wrap.className = 'field tp3d-editor-inline-position-field';
      wrap.classList.add('tp3d-editor-minw-90');
      const l = document.createElement('label');
      l.className = 'label';
      l.textContent = `${axis} (${unit || 'in'})`;
      const input = document.createElement('input');
      input.id = `tp3d-editor-field-${++editorFieldId}`;
      l.htmlFor = input.id;
      input.dataset.focusKey = `position-${axis}`;
      input.className = 'input';
      input.type = 'number';
      input.step = '0.1';
      input.value = String(Number(value).toFixed(1));
      wrap.appendChild(l);
      wrap.appendChild(input);
      return { wrap, input };
    }

    function smallField(label, value, focusKey = '') {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      wrap.classList.add('tp3d-editor-minw-90');
      const l = document.createElement('label');
      l.className = 'label';
      l.textContent = label;
      const input = document.createElement('input');
      input.id = `tp3d-editor-field-${++editorFieldId}`;
      l.htmlFor = input.id;
      if (focusKey) input.dataset.focusKey = focusKey;
      input.className = 'input';
      input.type = 'number';
      input.step = '0.1';
      input.value = String(Number(value).toFixed(1));
      wrap.appendChild(l);
      wrap.appendChild(input);
      return { wrap, input };
    }

    function setEditorFieldError(field, message) {
      let error = field.wrap.querySelector('.tp3d-field-error');
      if (!error) {
        error = document.createElement('div');
        error.className = 'tp3d-field-error';
        error.id = `${field.input.id}-error`;
        error.setAttribute('role', 'alert');
        field.wrap.appendChild(error);
        field.input.setAttribute('aria-describedby', error.id);
        field.input.addEventListener('input', () => setEditorFieldError(field, ''));
      }
      error.textContent = message;
      error.hidden = !message;
      if (message) field.input.setAttribute('aria-invalid', 'true');
      else field.input.removeAttribute('aria-invalid');
    }

    function syncPanelAccessibility() {
      const mobile = window.matchMedia('(max-width: 899px)').matches;
      btnLeft.setAttribute('aria-expanded', String(mobile
        ? leftEl.classList.contains('open') : !shellEl.classList.contains('is-left-panel-hidden')));
      btnRight.setAttribute('aria-expanded', String(mobile
        ? rightEl.classList.contains('open') : !shellEl.classList.contains('is-right-panel-hidden')));
    }

    function setPanelVisible(side, visible) {
      const isMobile = window.matchMedia('(max-width: 899px)').matches;
      if (side === 'left' && !visible) {
        setCaseFiltersVisible(false, false);
      }
      if (side === 'left') {
        if (isMobile) leftEl.classList.toggle('open', visible);
        else shellEl.classList.toggle('is-left-panel-hidden', !visible);
      }
      if (side === 'right') {
        if (isMobile) rightEl.classList.toggle('open', visible);
        else shellEl.classList.toggle('is-right-panel-hidden', !visible);
      }
      syncPanelAccessibility();
      if (isMobile && visible) (side === 'left' ? btnLeftClose : btnRightClose).focus();
      if (!visible && (side === 'left' ? leftEl : rightEl).contains(document.activeElement)) {
        (side === 'left' ? btnLeft : btnRight).focus();
      }

      if (StateStore.get('currentScreen') === 'editor') {
        scheduleEditorSceneLayoutSync();
      }
    }

    function togglePanel(side) {
      const isMobile = window.matchMedia('(max-width: 899px)').matches;
      if (side === 'left') {
        if (isMobile) {
          setPanelVisible('left', !leftEl.classList.contains('open'));
        } else {
          setPanelVisible('left', shellEl.classList.contains('is-left-panel-hidden'));
        }
      }
      if (side === 'right') {
        if (isMobile) {
          setPanelVisible('right', !rightEl.classList.contains('open'));
        } else {
          setPanelVisible('right', shellEl.classList.contains('is-right-panel-hidden'));
        }
      }
    }

    function wireDropToViewport(canvasEl) {
      canvasEl.addEventListener('dragover', ev => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
      });
      canvasEl.addEventListener('drop', ev => {
        ev.preventDefault();
        const caseId = ev.dataTransfer.getData('text/plain');
        if (!caseId) return;
        const world = worldPointOnGround(ev.clientX, ev.clientY, canvasEl);
        if (!world) {
          addCaseToPack(caseId);
          return;
        }
        const inches = SceneManager.vecWorldToInches(world);
        const c = CaseLibrary.getById(caseId);
        if (c && c.dimensions && c.dimensions.height) inches.y = Math.max(1, c.dimensions.height / 2);
        addCaseToPack(caseId, inches);
      });
    }

    function worldPointOnGround(clientX, clientY, canvasEl) {
      const camera = SceneManager.getCamera();
      if (!camera) return null;
      const rect = canvasEl.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera({ x, y }, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const out = new THREE.Vector3();
      const ok = raycaster.ray.intersectPlane(plane, out);
      return ok ? out : null;
    }

    // Measurement-only change: re-derive validity and refresh the overlay/list. No scene or Inspector render.
    function syncMeasurements() {
      if (MeasurementTool && StateStore.get('currentScreen') === 'editor') MeasurementTool.sync();
    }

    // Annotation-only change: re-derive validity and refresh the overlay/list. No scene or Inspector render.
    function syncAnnotations() {
      if (AnnotationTool && StateStore.get('currentScreen') === 'editor') AnnotationTool.sync();
    }

    return { init: initEditorUI, render, renderSelection, onActivated, resetWorkspaceState, syncViewportControls,
      syncMeasurements, syncAnnotations, getCurrentCameraPack, applyCameraProjection,
      getPreviewScene, getExportScene, getPreviewView, flushPendingView, setPreviewViewSettledCallback };
  })();

  const onDeactivated = () => { };

  return { ...EditorUI, onDeactivated };
}
