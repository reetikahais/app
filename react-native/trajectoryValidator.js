// Pure trajectory-validation / outlier-rejection layer: runs BEFORE a fix is allowed to update
// lastAcceptedFix, feed the movement state machine (movementStateMachine.js), or enter the
// processed trail. Mirrors flutter/lib/trajectory_validator.dart 1:1, same convention as
// movementStateMachine.js / mapPoints.js. No I/O, no platform APIs.
//
// Design doc: docs/superpowers/plans/changes.md (STEP1-21).

import {
  haversineDistanceMeters,
  initialBearingDegrees,
  circularBearingDiffDeg,
  computeNoiseThresholdM,
  sanitizeAccuracy,
  MIN_BEARING_DISTANCE_M,
  BEARING_TOLERANCE_DEG,
} from './movementStateMachine';

export const TRAJECTORY_DECISION = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  OUTLIER: 'OUTLIER',
  UNCERTAIN: 'UNCERTAIN',
});

export const OUTLIER_REASON = Object.freeze({
  IMPOSSIBLE_SPEED: 'IMPOSSIBLE_SPEED',
  EXCESSIVE_DISPLACEMENT: 'EXCESSIVE_DISPLACEMENT',
  BEARING_INCONSISTENCY: 'BEARING_INCONSISTENCY',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  DUPLICATE_OR_OUT_OF_ORDER: 'DUPLICATE_OR_OUT_OF_ORDER',
  STALE_ANCHOR_RECOVERING: 'STALE_ANCHOR_RECOVERING',
  STALE_ANCHOR_REANCHORED: 'STALE_ANCHOR_REANCHORED',
  UNCERTAIN_CONFIRMED: 'UNCERTAIN_CONFIRMED',
});

export const MOVEMENT_MODE = Object.freeze({
  WALKING: 'WALKING',
  CYCLING: 'CYCLING',
  VEHICLE: 'VEHICLE',
  UNKNOWN: 'UNKNOWN',
});

// Step7: rolling window of the last N accepted fixes' implied speeds used to infer mode. N=5
// chosen against the existing MOVING adaptive-poll tier (10s foreground / 20s background, see
// movementStateMachine.js) - 5 fixes covers roughly 50-100s of recent movement: long enough to
// average out a single noisy fix, short enough to react to a genuine mode change (walk->car)
// within about a minute or two.
export const MODE_SPEED_WINDOW_N = 5;
// Mode only switches after this many consecutive fixes support the new candidate band - stops a
// single borderline-speed fix flickering the inferred mode back and forth (Step7: "never switch
// mode based on a single fix").
export const MODE_SWITCH_CONFIRM_COUNT = 3;

// Step7 approximate mode-inference bands, in m/s. The source doc's illustrative ranges
// (~1-2 walking, ~3-8 cycling, ~8+ vehicle) leave a 2-3 gap; resolved here as two cut points so
// every average speed maps to exactly one candidate band.
export const WALKING_MODE_MAX_MPS = 2.2;
export const CYCLING_MODE_MAX_MPS = 8;
// Above CYCLING_MODE_MAX_MPS => VEHICLE candidate.

// Step8: speed ceiling used for the *plausibility gate* (distinct from the mode-inference bands
// above) - deliberately looser than the inference bands themselves, since a fix can legitimately
// run faster than its mode's "typical" band (e.g. downhill cycling) without being an outlier.
export const WALKING_MAX_SPEED_MPS = 3.5; // ~12.6 km/h - brisk-jog headroom before flip to cycling.
export const CYCLING_MAX_SPEED_MPS = 11; // ~40 km/h - fast cycling / e-bike.
// 150 km/h - matches mapPoints.js's MAX_SPEED_KMH absolute ceiling, so this validator's upstream
// gate and the map's downstream render-time filter agree on what "impossible" means here.
export const VEHICLE_MAX_SPEED_MPS = 150 / 3.6;
// UNKNOWN mode (no accepted history yet, or mode not yet confirmed): conservative-but-not-
// restrictive per Step7/21 - same ceiling as VEHICLE rather than a stricter one, so a legitimate
// fast car trip is never rejected just because mode inference hasn't caught up yet.
export const UNKNOWN_MAX_SPEED_MPS = VEHICLE_MAX_SPEED_MPS;

// Step8: displacement is allowed to exceed ceilingSpeed*elapsedTime by this factor before being
// treated as suspicious at all - real speeds burst above a "typical" steady-state ceiling
// (accelerating, downhill, tailwind).
export const DISPLACEMENT_MARGIN = 1.3;
// Beyond maxPlausibleDistance * OUTLIER_MULTIPLIER, a fix is OUTLIER rather than UNCERTAIN.
export const OUTLIER_MULTIPLIER = 1.5;

// Step8 stale-anchor exception. 120s matches the existing SIGNAL_GAP_THRESHOLD_MS convention
// (logger.js) already used elsewhere in this codebase for "signal has been gone too long" -
// reusing it keeps one mental model for "how long is too long" across the app.
export const STALE_ANCHOR_THRESHOLD_MS = 120000;
export const STALE_ANCHOR_STREAK_N = 3;

// Step12: an UNCERTAIN fix not confirmed within this many subsequent fixes is dropped from the
// pending buffer (resolved-to-outlier for anchoring purposes).
export const UNCERTAIN_CONFIRM_TIMEOUT_FIXES = 2;

// Step9/11: a fix within this fraction of its own ceiling is "borderline" - only a borderline
// ACCEPTED/UNCERTAIN decision can be downgraded by a disagreeing secondary signal (bearing/GPS
// speed). A comfortably-plausible fix is never downgraded by a sharp turn or noisy GPS speed
// alone (Step11: "a sharp turn alone...must NOT be rejected").
export const BORDERLINE_RATIO = 0.8;
export const SPEED_DISAGREEMENT_RATIO = 0.6;
export const SPEED_DISAGREEMENT_SLACK_MPS = 2;

function ceilingForMode(mode) {
  switch (mode) {
    case MOVEMENT_MODE.WALKING:
      return WALKING_MAX_SPEED_MPS;
    case MOVEMENT_MODE.CYCLING:
      return CYCLING_MAX_SPEED_MPS;
    case MOVEMENT_MODE.VEHICLE:
      return VEHICLE_MAX_SPEED_MPS;
    default:
      return UNKNOWN_MAX_SPEED_MPS;
  }
}

function candidateModeForAvgSpeed(avgSpeedMps) {
  if (avgSpeedMps == null) return MOVEMENT_MODE.UNKNOWN;
  if (avgSpeedMps <= WALKING_MODE_MAX_MPS) return MOVEMENT_MODE.WALKING;
  if (avgSpeedMps <= CYCLING_MODE_MAX_MPS) return MOVEMENT_MODE.CYCLING;
  return MOVEMENT_MODE.VEHICLE;
}

function averageSpeed(history) {
  if (!history.length) return null;
  return history.reduce((sum, v) => sum + v, 0) / history.length;
}

// Step7: hysteresis - a new candidate mode must win MODE_SWITCH_CONFIRM_COUNT consecutive times
// (via the rolling speed window) before it actually replaces the confirmed mode.
function updateMode(trajState, impliedSpeedMps) {
  const speedHistory = [...trajState.speedHistory, impliedSpeedMps].slice(-MODE_SPEED_WINDOW_N);
  const candidate = candidateModeForAvgSpeed(averageSpeed(speedHistory));
  if (candidate === trajState.mode) {
    return { speedHistory, mode: trajState.mode, modeStreak: 0, candidateMode: null };
  }
  const modeStreak = candidate === trajState.candidateMode ? trajState.modeStreak + 1 : 1;
  if (modeStreak >= MODE_SWITCH_CONFIRM_COUNT) {
    return { speedHistory, mode: candidate, modeStreak: 0, candidateMode: null };
  }
  return { speedHistory, mode: trajState.mode, modeStreak, candidateMode: candidate };
}

export function computeTrajectoryMetrics(refFix, fix) {
  const distanceM = haversineDistanceMeters(refFix, fix);
  const elapsedMs = fix.timestampMs - refFix.timestampMs;
  const elapsedSec = Math.max(elapsedMs, 1) / 1000;
  const impliedSpeedMps = distanceM / elapsedSec;
  return { distanceM, elapsedMs, impliedSpeedMps };
}

// Step6/8/10: dynamic ceiling - scales with elapsed time, inferred mode, and both fixes'
// accuracy. Never a single fixed cutoff. Reuses computeNoiseThresholdM (movementStateMachine.js)
// for the accuracy-slack term, so poor accuracy on either fix widens the plausible band exactly
// the same way it already widens the movement state machine's own noise threshold.
function maxPlausibleDistanceM(refFix, fix, elapsedSec, mode) {
  const ceiling = ceilingForMode(mode);
  const accuracySlackM = computeNoiseThresholdM(sanitizeAccuracy(refFix.accuracy), sanitizeAccuracy(fix.accuracy));
  return ceiling * elapsedSec * DISPLACEMENT_MARGIN + accuracySlackM;
}

function speedsDisagree(fix, impliedSpeedMps) {
  const gpsSpeed = fix.speed;
  if (gpsSpeed == null || !Number.isFinite(gpsSpeed) || gpsSpeed < 0) return false;
  const diff = Math.abs(gpsSpeed - impliedSpeedMps);
  const tolerance = Math.max(gpsSpeed, impliedSpeedMps) * SPEED_DISAGREEMENT_RATIO + SPEED_DISAGREEMENT_SLACK_MPS;
  return diff > tolerance;
}

function bearingInconsistent(prevFix, refFix, fix, segmentDistanceM) {
  if (!prevFix) return false;
  if (segmentDistanceM < MIN_BEARING_DISTANCE_M) return false;
  const b1 = initialBearingDegrees(prevFix, refFix);
  const b2 = initialBearingDegrees(refFix, fix);
  return circularBearingDiffDeg(b1, b2) > BEARING_TOLERANCE_DEG;
}

// Step2/6/8/9/10/11: the core three-outcome plausibility check between a reference fix and a
// candidate fix. Bearing/GPS-speed disagreement (Step9/11) only ever downgrade an already-
// borderline decision - never reject a comfortably-plausible fix on their own.
function classifyAgainstReference({ refFix, prevFix, fix, mode }) {
  const { distanceM, elapsedMs, impliedSpeedMps } = computeTrajectoryMetrics(refFix, fix);
  const elapsedSec = elapsedMs / 1000;
  const maxPlausibleM = maxPlausibleDistanceM(refFix, fix, elapsedSec, mode);
  const outlierCeilingM = maxPlausibleM * OUTLIER_MULTIPLIER;

  let decision;
  let reason = null;
  if (distanceM > outlierCeilingM) {
    decision = TRAJECTORY_DECISION.OUTLIER;
    reason =
      impliedSpeedMps > ceilingForMode(mode) * OUTLIER_MULTIPLIER
        ? OUTLIER_REASON.IMPOSSIBLE_SPEED
        : OUTLIER_REASON.EXCESSIVE_DISPLACEMENT;
  } else if (distanceM > maxPlausibleM) {
    decision = TRAJECTORY_DECISION.UNCERTAIN;
    reason = OUTLIER_REASON.LOW_CONFIDENCE;
  } else {
    decision = TRAJECTORY_DECISION.ACCEPTED;
  }

  const borderline = distanceM >= maxPlausibleM * BORDERLINE_RATIO;
  if (borderline && decision !== TRAJECTORY_DECISION.OUTLIER) {
    const disagree = speedsDisagree(fix, impliedSpeedMps) || bearingInconsistent(prevFix, refFix, fix, distanceM);
    if (disagree) {
      if (decision === TRAJECTORY_DECISION.ACCEPTED) {
        decision = TRAJECTORY_DECISION.UNCERTAIN;
        reason = OUTLIER_REASON.LOW_CONFIDENCE;
      } else {
        decision = TRAJECTORY_DECISION.OUTLIER;
        reason = OUTLIER_REASON.BEARING_INCONSISTENCY;
      }
    }
  }

  return { decision, reason, distanceM, impliedSpeedMps };
}

export function createInitialTrajectoryState() {
  return {
    lastAcceptedFix: null,
    prevAcceptedFix: null,
    speedHistory: [],
    mode: MOVEMENT_MODE.UNKNOWN,
    modeStreak: 0,
    candidateMode: null,
    pendingUncertain: null,
    outlierStreak: 0,
  };
}

function acceptFix(trajState, fix, reason, distanceM, impliedSpeedMps) {
  const modeUpdate =
    impliedSpeedMps != null
      ? updateMode(trajState, impliedSpeedMps)
      : {
          speedHistory: trajState.speedHistory,
          mode: trajState.mode,
          modeStreak: trajState.modeStreak,
          candidateMode: trajState.candidateMode,
        };
  return {
    newState: {
      ...trajState,
      ...modeUpdate,
      prevAcceptedFix: trajState.lastAcceptedFix,
      lastAcceptedFix: fix,
      pendingUncertain: null,
      outlierStreak: 0,
    },
    result: {
      decision: TRAJECTORY_DECISION.ACCEPTED,
      reason,
      distanceFromLastAcceptedM: distanceM,
      impliedSpeedMps,
      movementMode: modeUpdate.mode,
    },
  };
}

function outlierFix(trajState, fix, reason, distanceM, impliedSpeedMps) {
  return {
    newState: { ...trajState, outlierStreak: trajState.outlierStreak + 1 },
    result: {
      decision: TRAJECTORY_DECISION.OUTLIER,
      reason,
      distanceFromLastAcceptedM: distanceM,
      impliedSpeedMps,
      movementMode: trajState.mode,
    },
  };
}

// Step12/Step8: resolves a held UNCERTAIN fix (or Step8 stale-recovery candidate - same buffer,
// same mechanism) against the newly-arrived fix.
function resolvePending(trajState, fix) {
  const pending = trajState.pendingUncertain;

  if (fix.timestampMs <= pending.fix.timestampMs) {
    return outlierFix(trajState, fix, OUTLIER_REASON.DUPLICATE_OR_OUT_OF_ORDER, null, null);
  }

  const vsPending = classifyAgainstReference({
    refFix: pending.fix,
    prevFix: trajState.prevAcceptedFix,
    fix,
    mode: trajState.mode,
  });

  if (vsPending.decision === TRAJECTORY_DECISION.ACCEPTED) {
    // Two consecutive fixes mutually agree - accept the newer one and re-anchor to it.
    const reason = pending.staleRecovery ? OUTLIER_REASON.STALE_ANCHOR_REANCHORED : OUTLIER_REASON.UNCERTAIN_CONFIRMED;
    return acceptFix(trajState, fix, reason, vsPending.distanceM, vsPending.impliedSpeedMps);
  }

  if (!pending.staleRecovery) {
    // Not a stale-recovery chain: check whether the old anchor still explains the new fix - if
    // so, the pending fix was an isolated blip; discard it and evaluate the new fix normally.
    const vsAnchor = classifyAgainstReference({
      refFix: trajState.lastAcceptedFix,
      prevFix: trajState.prevAcceptedFix,
      fix,
      mode: trajState.mode,
    });
    if (vsAnchor.decision === TRAJECTORY_DECISION.ACCEPTED) {
      return acceptFix({ ...trajState, pendingUncertain: null }, fix, null, vsAnchor.distanceM, vsAnchor.impliedSpeedMps);
    }
  }

  const age = pending.age + 1;
  if (age > UNCERTAIN_CONFIRM_TIMEOUT_FIXES) {
    // Confirmation window elapsed - drop the pending fix (resolved-to-outlier for anchoring
    // purposes) and re-evaluate this fix fresh, as if there were no pending fix at all.
    return classifyFix({ ...trajState, pendingUncertain: null, outlierStreak: trajState.outlierStreak + 1 }, fix);
  }

  // Stale-recovery: no valid anchor to fall back to, so this fix simply replaces the pending
  // candidate and the chain keeps trying. Non-stale: keep the original pending fix and wait for
  // the timeout above.
  const nextPending = pending.staleRecovery ? { fix, age: 0, staleRecovery: true } : { ...pending, age };
  return {
    newState: { ...trajState, pendingUncertain: nextPending, outlierStreak: trajState.outlierStreak + 1 },
    result: {
      decision: TRAJECTORY_DECISION.UNCERTAIN,
      reason: pending.staleRecovery ? OUTLIER_REASON.STALE_ANCHOR_RECOVERING : OUTLIER_REASON.LOW_CONFIDENCE,
      distanceFromLastAcceptedM: vsPending.distanceM,
      impliedSpeedMps: vsPending.impliedSpeedMps,
      movementMode: trajState.mode,
    },
  };
}

// Step1-21 entry point. Returns { newState, result } - result carries the Step14/20 diagnostics
// fields (decision, reason, distanceFromLastAcceptedM, impliedSpeedMps, movementMode). Caller
// must only feed the fix into the movement state machine / smoothing / processed trail when
// result.decision === TRAJECTORY_DECISION.ACCEPTED (Step2/13/16), and must always store the raw
// fix regardless of decision (Step14).
export function classifyFix(trajState, rawFix) {
  const fix = { ...rawFix, accuracy: sanitizeAccuracy(rawFix.accuracy) };

  if (!trajState.lastAcceptedFix) {
    return acceptFix(trajState, fix, null, 0, null);
  }

  // Step3: duplicate/out-of-order guard - never let time run backwards against the anchor.
  if (fix.timestampMs <= trajState.lastAcceptedFix.timestampMs) {
    return outlierFix(trajState, fix, OUTLIER_REASON.DUPLICATE_OR_OUT_OF_ORDER, null, null);
  }

  if (trajState.pendingUncertain) {
    return resolvePending(trajState, fix);
  }

  // Step8: stale-anchor exception - the reference point is no longer comparable, so stop
  // requiring consistency with it and instead start a mutual-consistency chain between fresh
  // fixes (reuses the same pending-buffer mechanism as Step12's UNCERTAIN resolution).
  const elapsedSinceAcceptedMs = fix.timestampMs - trajState.lastAcceptedFix.timestampMs;
  const isStale =
    elapsedSinceAcceptedMs > STALE_ANCHOR_THRESHOLD_MS || trajState.outlierStreak >= STALE_ANCHOR_STREAK_N;
  if (isStale) {
    return {
      newState: { ...trajState, pendingUncertain: { fix, age: 0, staleRecovery: true } },
      result: {
        decision: TRAJECTORY_DECISION.UNCERTAIN,
        reason: OUTLIER_REASON.STALE_ANCHOR_RECOVERING,
        distanceFromLastAcceptedM: haversineDistanceMeters(trajState.lastAcceptedFix, fix),
        impliedSpeedMps: null,
        movementMode: trajState.mode,
      },
    };
  }

  const outcome = classifyAgainstReference({
    refFix: trajState.lastAcceptedFix,
    prevFix: trajState.prevAcceptedFix,
    fix,
    mode: trajState.mode,
  });

  if (outcome.decision === TRAJECTORY_DECISION.ACCEPTED) {
    return acceptFix(trajState, fix, null, outcome.distanceM, outcome.impliedSpeedMps);
  }
  if (outcome.decision === TRAJECTORY_DECISION.OUTLIER) {
    return outlierFix(trajState, fix, outcome.reason, outcome.distanceM, outcome.impliedSpeedMps);
  }
  return {
    newState: { ...trajState, pendingUncertain: { fix, age: 0, staleRecovery: false }, outlierStreak: trajState.outlierStreak + 1 },
    result: {
      decision: TRAJECTORY_DECISION.UNCERTAIN,
      reason: outcome.reason,
      distanceFromLastAcceptedM: outcome.distanceM,
      impliedSpeedMps: outcome.impliedSpeedMps,
      movementMode: trajState.mode,
    },
  };
}

// Step3: sort a batch of raw fixes chronologically before running them through classifyFix one
// at a time - a background delivery callback must never assume its array arrives in order.
export function sortFixesByTimestamp(fixes) {
  return [...fixes].sort((a, b) => a.timestampMs - b.timestampMs);
}
