const EARTH_RADIUS_M = 6371000;

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function timestampMs(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function radians(value) { return value * Math.PI / 180; }
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function toLocalMeters(latitude, longitude, origin) {
  return {
    east: radians(longitude - origin.longitude) * EARTH_RADIUS_M * Math.cos(radians(origin.latitude)),
    north: radians(latitude - origin.latitude) * EARTH_RADIUS_M,
  };
}

function fromLocalMeters(east, north, origin) {
  return {
    latitude: origin.latitude + north / EARTH_RADIUS_M * 180 / Math.PI,
    longitude: origin.longitude + east / (EARTH_RADIUS_M * Math.cos(radians(origin.latitude))) * 180 / Math.PI,
  };
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function covarianceFor(accuracy) {
  const sigma = Math.max(finite(accuracy) || 100, 1);
  return sigma * sigma;
}

function isFallback(fix) { return String(fix.method || '').toLowerCase().includes('fallback'); }
function coordinateKey(fix) { return `${Number(fix.latitude).toFixed(6)},${Number(fix.longitude).toFixed(6)}`; }
function median(values) { return percentile(values, 0.5); }
function bearingBetween(from, to) {
  const y = Math.sin(radians(to.longitude - from.longitude)) * Math.cos(radians(to.latitude));
  const x = Math.cos(radians(from.latitude)) * Math.sin(radians(to.latitude))
    - Math.sin(radians(from.latitude)) * Math.cos(radians(to.latitude))
      * Math.cos(radians(to.longitude - from.longitude));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Android's fused provider reports speed 0, bearing 0 and no speed accuracy for fixes it derived
// from Wi-Fi/cell rather than GNSS: it has no speed for them, it is not saying the device is
// stationary. This is only the "looks like a placeholder" half of the test; callers also require
// evidence of real movement (implied speed above the mode's stationary speed) before ignoring it.
function isZeroSpeedPlaceholder(fix) {
  return fix.speed_mps === 0
    && (fix.bearing_deg == null || fix.bearing_deg === 0)
    && fix.speed_accuracy_mps == null;
}

// Recovery chains of poor-accuracy fixes are judged on a looser progress ratio than clean GNSS
// chains (their legs are mostly noise), but must still travel farther than their own accuracy.
const LOW_ACCURACY_RECOVERY_RATIO_FACTOR = 0.75;

function angleDifference(a, b) {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

// Circular weighted blend of two headings (degrees), e.g. a calculated bearing and a device-reported
// one. weight=0 returns `a` unchanged, weight=1 returns `b` unchanged.
function blendAngles(a, b, weight) {
  const clampedWeight = clamp(weight, 0, 1);
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * clampedWeight + 360) % 360;
}

function normalizeFix(input, nowMs = Date.now()) {
  const coords = input.coords || input;
  const fixTimestampMs = timestampMs(input.fix_timestamp_ms ?? input.timestamp_ms ?? input.timestamp ?? input.fixTimestampMs);
  const latitude = finite(coords.latitude ?? input.latitude);
  const longitude = finite(coords.longitude ?? input.longitude);
  const accuracy = finite(coords.accuracy ?? input.horizontal_accuracy_m ?? input.accuracy);
  const receivedTimestampMs = finite(input.received_timestamp_ms ?? input.receivedTimestampMs) || nowMs;
  return {
    ...input,
    latitude,
    longitude,
    accuracy,
    fix_timestamp_ms: fixTimestampMs,
    received_timestamp_ms: receivedTimestampMs,
    fix_age_ms: fixTimestampMs == null ? null : Math.max(0, receivedTimestampMs - fixTimestampMs),
    method: input.method || 'fused',
    speed_mps: finite(coords.speed ?? input.speed_mps ?? input.speed),
    provider: input.provider || 'fused',
  };
}

// Distinguishes real directional walking from GPS jitter using more than one fix: jitter oscillates
// around a centroid (net displacement small relative to the path length walked between samples),
// while real walking accumulates net displacement roughly in line with the path traveled. Needs at
// least 3 points (2 segments) — with only 2 points net always equals path length, which proves
// nothing about direction consistency.
function computeProgressiveMovement(windowPositions, config) {
  if (windowPositions.length < 3) {
    return { netDisplacementM: 0, pathDistanceM: 0, progressRatio: 0, hasProgressiveMovement: false };
  }
  const first = windowPositions[0];
  const last = windowPositions[windowPositions.length - 1];
  const netDisplacementM = haversineMeters(first.latitude, first.longitude, last.latitude, last.longitude);
  let pathDistanceM = 0;
  for (let i = 1; i < windowPositions.length; i += 1) {
    pathDistanceM += haversineMeters(
      windowPositions[i - 1].latitude, windowPositions[i - 1].longitude,
      windowPositions[i].latitude, windowPositions[i].longitude,
    );
  }
  const progressRatio = pathDistanceM > 0 ? netDisplacementM / pathDistanceM : 0;
  const hasProgressiveMovement = netDisplacementM >= config.progressiveMovementMinNetDisplacementM
    && progressRatio >= config.progressiveMovementMinRatio;
  return { netDisplacementM, pathDistanceM, progressRatio, hasProgressiveMovement };
}

function updateMovement(previous, fix, elapsedMs, displacementM, config, evidence, hasProgressiveMovement, turnDetected) {
  const speed = fix.speed_mps ?? (elapsedMs > 0 ? displacementM / elapsedMs * 1000 : 0);
  const reliable = fix.accuracy != null && fix.accuracy <= config.normalAccuracyMaxM && fix.fix_age_ms <= config.freshThresholdMs;
  if (!reliable) return previous || 'UNKNOWN';
  const noiseRadius = Math.max(
    config.stationaryNoiseFloorM,
    (fix.accuracy || config.stationaryNoiseFloorM) * config.stationaryAccuracyMultiplier,
  );
  const movingRadius = Math.max(noiseRadius * config.movingAccuracyMultiplier, 12);
  // A single 5s-interval fix at normal walking pace (5-9m) never clears movingRadius on its own —
  // that bar is calibrated for a burst covering 2+ intervals in one tick. hasProgressiveMovement
  // (net displacement over several recent fixes, direction-consistent) is what actually recognizes
  // steady walking, so it stands in for single-fix evidence rather than being required alongside it.
  const singleFixMovingEvidence = (speed >= config.movingSpeedMps && displacementM > movingRadius)
    || (displacementM > Math.max(noiseRadius * 1.5, 12) && elapsedMs <= 10000);
  const movingEvidence = singleFixMovingEvidence || hasProgressiveMovement;
  // Progressive movement across the recent window overrides what would otherwise look like in-place
  // jitter on this one fix — a walker's individual 5-9m steps must not be graded against the same
  // noise floor a truly stationary phone's GPS wander is graded against.
  const stationaryEvidence = !hasProgressiveMovement
    && speed <= config.stationarySpeedMps
    && displacementM <= noiseRadius;
  if (movingEvidence) {
    evidence.movingMs += Math.max(elapsedMs || 0, 0);
    evidence.stationaryMs = 0;
    const confirmed = evidence.movingMs >= config.movingConfirmationMs;
    if (!config.extendedMovementStates) return confirmed ? 'MOVING' : 'POSSIBLY_MOVING';
    if (!confirmed) return (previous === 'STATIONARY' || previous === 'POSSIBLY_STOPPED') ? 'RESUMING' : 'STARTING';
    return turnDetected ? 'TURNING' : 'MOVING';
  }
  if (stationaryEvidence) {
    evidence.stationaryMs += Math.max(elapsedMs || 0, 0);
    evidence.movingMs = 0;
    // No more "previous === 'UNKNOWN' -> STATIONARY" shortcut: every path to STATIONARY goes through
    // the same confirmation timer, so landing here right after a gap reset can no longer skip
    // hysteresis the way it used to (that was the mechanism that snapped ordinary walking straight
    // to STATIONARY on the very first ambiguous fix after any 15s+ gap).
    return evidence.stationaryMs >= config.stationaryConfirmationMs ? 'STATIONARY' : 'POSSIBLY_STOPPED';
  }
  evidence.movingMs = 0;
  evidence.stationaryMs = 0;
  return previous || 'UNKNOWN';
}

// Section 15/16: advance the effective tracking mode for the NEXT fix based on how this accepted
// fix's rolling median speed behaved. Escalation only ever climbs the walk -> bicycle -> motorbike
// ladder (never past motorbike into car — that would need real activity-recognition evidence this
// app doesn't have) and downgrade never drops below the user's own original selection (`floorMode`).
// Evidence accumulators are frozen (not reset, not advanced) while the fix is stationary-ish, so a
// traffic-light stop can never itself cause a downgrade (section 23).
function stepAdaptiveMode(effectiveMode, floorMode, medianSpeedMps, elapsedMs, evidence, isStationaryish) {
  const { ADAPTIVE_MODE_RANK: rank, ADAPTIVE_MODE_RULES: rules, TRACKING_MODES: MODES } = require('./trackingConfig');
  if (isStationaryish || medianSpeedMps == null || !Number.isFinite(elapsedMs)) {
    return { effectiveMode, reason: null };
  }
  const floorRank = rank[floorMode] ?? rank[MODES.WALK];
  if (effectiveMode === MODES.WALK) {
    const rule = rules.WALK_TO_BICYCLE;
    evidence.upMs = medianSpeedMps > rule.upSpeedMps ? evidence.upMs + elapsedMs : 0;
    if (evidence.upMs >= rule.upDurationMs) {
      evidence.upMs = 0;
      return { effectiveMode: MODES.BICYCLE, reason: 'PROFILE_ESCALATED' };
    }
    return { effectiveMode, reason: null };
  }
  if (effectiveMode === MODES.BICYCLE) {
    const upRule = rules.BICYCLE_TO_MOTORBIKE;
    evidence.upMs = medianSpeedMps > upRule.upSpeedMps ? evidence.upMs + elapsedMs : 0;
    if (evidence.upMs >= upRule.upDurationMs) {
      evidence.upMs = 0; evidence.downMs = 0;
      return { effectiveMode: MODES.MOTORBIKE, reason: 'PROFILE_ESCALATED' };
    }
    if (floorRank < rank[MODES.BICYCLE]) {
      const downRule = rules.WALK_TO_BICYCLE;
      evidence.downMs = medianSpeedMps < downRule.downSpeedMps ? evidence.downMs + elapsedMs : 0;
      if (evidence.downMs >= downRule.downDurationMs) {
        evidence.downMs = 0;
        return { effectiveMode: MODES.WALK, reason: 'PROFILE_DOWNGRADED' };
      }
    }
    return { effectiveMode, reason: null };
  }
  if (effectiveMode === MODES.MOTORBIKE && floorRank < rank[MODES.MOTORBIKE]) {
    const downRule = rules.BICYCLE_TO_MOTORBIKE;
    evidence.downMs = medianSpeedMps < downRule.downSpeedMps ? evidence.downMs + elapsedMs : 0;
    if (evidence.downMs >= downRule.downDurationMs) {
      evidence.downMs = 0;
      return { effectiveMode: MODES.BICYCLE, reason: 'PROFILE_DOWNGRADED' };
    }
  }
  // CAR (and MOTORBIKE once at its floor) never changes automatically.
  return { effectiveMode, reason: null };
}

function processLocations(rawLocations, options = {}) {
  const trackingConfig = require('./trackingConfig');
  const userSelectedMode = trackingConfig.normalizeTrackingMode(options.userSelectedMode || options.mode)
    || trackingConfig.TRACKING_MODES.WALK;
  let effectiveMode = userSelectedMode;
  const modeEvidence = { upMs: 0, downMs: 0 };
  const normalized = rawLocations.map((fix) => normalizeFix(fix, options.nowMs || Date.now()))
    .filter((fix) => fix.latitude != null && fix.longitude != null && fix.fix_timestamp_ms != null)
    .sort((a, b) => a.fix_timestamp_ms - b.fix_timestamp_ms);
  const origin = normalized[0] || { latitude: 0, longitude: 0 };
  const state = { east: 0, north: 0, velocityEast: 0, velocityNorth: 0, variance: 10000 };
  let stateInitialized = false;
  let previousRaw = null;
  let lastAcceptedFix = null;
  let pendingUncertain = null;
  const acceptedSpeeds = [];
  const recentAcceptedPositions = [];
  let previousAcceptedBearing = null;
  let previousAcceptedImpliedSpeed = null;
  let movementState = 'UNKNOWN';
  const movementEvidence = { movingMs: 0, stationaryMs: 0 };
  let segmentId = 0;
  let stationaryAnchor = null;
  let consecutiveUncertainCount = 0;
  let consecutiveOutlierCount = 0;
  let recoveryCandidates = [];
  const results = [];
  const seen = [];

  normalized.forEach((fix, index) => {
    // Recomputed every fix (not hoisted) because effectiveMode can escalate/downgrade mid-session
    // (section 15/16) — once it does, all downstream thresholds must immediately reflect the new
    // profile, not the one the session started with. `options` still wins over the profile so
    // existing per-call overrides (tests, callers) behave exactly as before.
    const config = { ...trackingConfig.getTrackingProfile(effectiveMode), ...options };
    const local = toLocalMeters(fix.latitude, fix.longitude, origin);
    const elapsedMs = previousRaw ? fix.fix_timestamp_ms - previousRaw.fix_timestamp_ms : null;
    const intervalMs = elapsedMs == null ? null : Math.max(0, elapsedMs);
    const rawDeliveryIntervalMs = previousRaw
      ? Math.max(0, fix.received_timestamp_ms - previousRaw.received_timestamp_ms) : null;
    const duplicate = seen.some((point) => haversineMeters(point.latitude, point.longitude, fix.latitude, fix.longitude) <= config.duplicateToleranceM && point.fix_timestamp_ms === fix.fix_timestamp_ms);
    const fallback = isFallback(fix);
    const stale = fix.fix_age_ms != null && fix.fix_age_ms > config.freshThresholdMs;
    const acceptedElapsedMs = lastAcceptedFix ? fix.fix_timestamp_ms - lastAcceptedFix.fix_timestamp_ms : null;
    const deliveryLatencyMs = fix.fix_age_ms;
    const isLiveFresh = fix.fix_age_ms == null || fix.fix_age_ms <= config.freshThresholdMs;
    const isTrajectoryUsable = fix.latitude != null && fix.longitude != null && fix.fix_timestamp_ms != null;
    const acceptedElapsedSeconds = acceptedElapsedMs > 0 ? acceptedElapsedMs / 1000 : null;
    const previousDistance = lastAcceptedFix ? haversineMeters(lastAcceptedFix.latitude, lastAcceptedFix.longitude, fix.latitude, fix.longitude) : 0;
    const impliedSpeed = acceptedElapsedSeconds ? previousDistance / acceptedElapsedSeconds : null;
    const reportedSpeedRaw = fix.speed_mps != null && fix.speed_mps >= 0 ? fix.speed_mps : null;
    // Reported speed becomes UNKNOWN (null) when it is the zero-speed placeholder AND the position
    // clearly moved faster than the mode's stationary speed since the last accepted point. SPEED_MISMATCH
    // and the speed-agreement checks then fall back to implied speed vs plausible/burst speed.
    const reportedSpeedUnavailable = Boolean(config.treatZeroSpeedAsUnknown)
      && reportedSpeedRaw === 0 && isZeroSpeedPlaceholder(fix)
      && impliedSpeed != null && impliedSpeed > config.stationarySpeedMps;
    const reportedSpeed = reportedSpeedUnavailable ? null : reportedSpeedRaw;
    const recentMedianSpeed = median(acceptedSpeeds);
    const calculatedBearing = lastAcceptedFix && previousDistance > 1 ? bearingBetween(lastAcceptedFix, fix) : null;
    // Device-reported heading is blended in (weighted by headingImportance) only when the calculated
    // bearing already exists — it refines a real bearing estimate, it never substitutes for one, since
    // a stale/parked heading value is common and must not fabricate motion direction on its own.
    // A placeholder bearing of 0 (north) from a speed-less fix is not a heading either.
    const deviceHeading = !reportedSpeedUnavailable && fix.bearing_deg != null
      && (fix.bearing_accuracy_deg == null || fix.bearing_accuracy_deg <= 45)
      ? fix.bearing_deg : null;
    const currentBearing = calculatedBearing != null && deviceHeading != null
      ? blendAngles(calculatedBearing, deviceHeading, config.headingImportance)
      : calculatedBearing;
    const bearingChange = currentBearing != null && previousAcceptedBearing != null
      ? angleDifference(currentBearing, previousAcceptedBearing) : null;
    const acceleration = (impliedSpeed != null && previousAcceptedImpliedSpeed != null && acceptedElapsedSeconds)
      ? Math.abs(impliedSpeed - previousAcceptedImpliedSpeed) / acceptedElapsedSeconds : null;
    // gapCandidate alone still governs filter re-anchoring and movement-state resets below, unchanged
    // from before. A long sampling gap with only a small displacement and reasonable accuracy is
    // almost always the OS delivering fixes late (screen lock, network throttling), not a real
    // discontinuity in the walk — only genuinely large/uncertain jumps should still break the
    // rendered route into a new segment (narrowed `gap`).
    const gapCandidate = acceptedElapsedMs != null && acceptedElapsedMs > config.segmentGapMs;
    const isSamplingDelay = gapCandidate
      && previousDistance <= config.samplingDelayMaxDisplacementM
      && fix.accuracy != null && fix.accuracy <= config.normalAccuracyMaxM;
    const gap = gapCandidate && !isSamplingDelay;
    const uncertaintyAllowance = (fix.accuracy ?? config.normalAccuracyMaxM)
      + (lastAcceptedFix?.accuracy ?? config.normalAccuracyMaxM);
    const plausibleSpeed = Math.min(config.burstSpeedMps,
      Math.max(config.plausibleSpeedMps, (recentMedianSpeed || 0) * 2.5));
    const maximumPlausibleDistance = plausibleSpeed * Math.max(acceptedElapsedSeconds || 0, 0)
      + uncertaintyAllowance * config.uncertaintyAccuracyFactor + config.dynamicDistanceSafetyMarginM;
    let trajectoryDecision = 'ACCEPTED';
    let trajectoryReason = 'PLAUSIBLE_TRAJECTORY';
    if (duplicate) {
      trajectoryDecision = 'OUTLIER'; trajectoryReason = 'DUPLICATE_TIMESTAMP';
    } else if (intervalMs != null && intervalMs <= 0) {
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'INVALID_TIMESTAMP';
    } else if (!lastAcceptedFix) {
      trajectoryDecision = fallback || fix.accuracy == null || fix.accuracy > config.normalAccuracyMaxM
        ? 'UNCERTAIN' : 'ACCEPTED';
      trajectoryReason = trajectoryDecision === 'ACCEPTED' ? (stale ? 'FIRST_HISTORICAL_FIX' : 'FIRST_FIX') : 'LOW_CONFIDENCE';
    } else if (fallback || fix.accuracy == null || fix.accuracy > config.normalAccuracyMaxM) {
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'LOW_CONFIDENCE';
    } else if (impliedSpeed != null && impliedSpeed > config.extremePhysicalSpeedMps) {
      trajectoryDecision = 'OUTLIER'; trajectoryReason = 'IMPOSSIBLE_SPEED';
    } else if (impliedSpeed != null && previousDistance > maximumPlausibleDistance) {
      // Section 13/14: a large displacement alone must never be the sole rejection signal. A
      // delayed GPS sample that covers real ground looks exactly like this on distance alone, but
      // three independent signals — good accuracy, GPS-reported speed agreeing with the implied
      // speed, and a stable heading — together are strong evidence the movement is real (we already
      // know it's within the mode's physical ceiling, since IMPOSSIBLE_SPEED is checked first).
      const goodAccuracy = fix.accuracy != null && fix.accuracy <= config.preferredAccuracyMeters;
      const speedAgreementGood = reportedSpeedUnavailable
        ? impliedSpeed <= config.burstSpeedMps
        : reportedSpeed != null && Math.abs(impliedSpeed - reportedSpeed) <= config.speedAgreementToleranceMps;
      const headingStable = bearingChange == null || bearingChange <= 30;
      if (goodAccuracy && speedAgreementGood && headingStable) {
        trajectoryDecision = 'ACCEPTED'; trajectoryReason = 'HIGH_SPEED_CONTINUITY_ACCEPT';
      } else {
        trajectoryDecision = 'OUTLIER'; trajectoryReason = 'EXCESSIVE_DISPLACEMENT';
      }
    } else if (impliedSpeed != null && reportedSpeed != null && Math.abs(impliedSpeed - reportedSpeed) > 5) {
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'SPEED_MISMATCH';
    } else if (bearingChange != null && bearingChange > config.bearingPenaltyThresholdDeg && previousDistance > 40 && impliedSpeed > config.plausibleSpeedMps * 1.5) {
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'BEARING_INCONSISTENCY';
    } else if (
      acceleration != null && acceleration > config.maxAccelerationMps2
      && impliedSpeed != null && impliedSpeed > config.plausibleSpeedMps
    ) {
      // A confidence signal, not a rejector (section 8): only ever downgrades an otherwise-plausible
      // fix to UNCERTAIN, never on its own escalates to OUTLIER — real bikes brake/accelerate hard.
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'HIGH_ACCELERATION';
    }
    // Candidate confirmation (Fix 4): a fix that looks implausible measured straight from
    // lastAcceptedFix (A) can still be trustworthy if it forms a coherent walking pace with the
    // immediately preceding UNCERTAIN fix (X) — i.e. the walker plausibly moved A -> X -> Y.
    // Never applies to DUPLICATE/INVALID_TIMESTAMP/LOW_CONFIDENCE/IMPOSSIBLE_SPEED: those reflect
    // a problem with the fix itself (or the absolute safety ceiling), not just an A->Y comparison.
    const confirmableReasons = ['SPEED_MISMATCH', 'BEARING_INCONSISTENCY', 'EXCESSIVE_DISPLACEMENT', 'HIGH_ACCELERATION'];
    let confirmedFromPending = false;
    if (trajectoryDecision !== 'ACCEPTED' && confirmableReasons.includes(trajectoryReason) && pendingUncertain && lastAcceptedFix) {
      const elapsedXYms = fix.fix_timestamp_ms - pendingUncertain.fix_timestamp_ms;
      if (elapsedXYms > 0 && elapsedXYms <= config.candidateConfirmationWindowMs) {
        const distanceXY = haversineMeters(pendingUncertain.latitude, pendingUncertain.longitude, fix.latitude, fix.longitude);
        const impliedSpeedXY = distanceXY / (elapsedXYms / 1000);
        const elapsedAXms = pendingUncertain.fix_timestamp_ms - lastAcceptedFix.fix_timestamp_ms;
        const distanceAX = haversineMeters(lastAcceptedFix.latitude, lastAcceptedFix.longitude, pendingUncertain.latitude, pendingUncertain.longitude);
        const impliedSpeedAX = elapsedAXms > 0 ? distanceAX / (elapsedAXms / 1000) : null;
        confirmedFromPending = impliedSpeedXY <= config.candidateConfirmationBurstSpeedMps
          && (impliedSpeedAX == null || impliedSpeedAX <= config.candidateConfirmationBurstSpeedMps);
      }
    }
    if (confirmedFromPending) {
      trajectoryDecision = 'ACCEPTED';
      trajectoryReason = 'CANDIDATE_CONFIRMED';
    }
    let accepted = trajectoryDecision === 'ACCEPTED';
    if (accepted) {
      pendingUncertain = null;
    } else if (trajectoryDecision === 'UNCERTAIN' && ['SPEED_MISMATCH', 'BEARING_INCONSISTENCY', 'HIGH_ACCELERATION'].includes(trajectoryReason)) {
      // Only trajectory-shape uncertainty becomes a confirmation candidate — a fix that is
      // uncertain because of its own poor accuracy (LOW_CONFIDENCE) is not trustworthy enough
      // to anchor a future confirmation, even if a later fix lands close to it.
      pendingUncertain = fix;
    }
    // Sections 17-21: multi-point outlier recovery. The single-slot pendingUncertain mechanism
    // above only recovers a fix that immediately follows one other uncertain fix; it does nothing
    // once rejection is sustained across several fixes in a row (e.g. no GPS-reported speed to
    // agree with, or a real turn briefly breaking the single-fix heading check), which is exactly
    // how a delayed high-speed sample used to lock the rest of the route out forever. Once
    // rejection looks sustained (maxConsecutiveOutliersBeforeRecovery) or the accepted reference is
    // simply too old to keep comparing against (stale), buffer the rejected fixes and only ever
    // compare them to EACH OTHER (candidate-to-candidate), never back to the stale accepted point.
    // LOW_CONFIDENCE (poor accuracy) rejections are included alongside OUTLIER here: in hilly/
    // mountainous terrain, sustained bad accuracy is the normal failure mode, not occasional bad
    // displacement jumps, and it deserves the same "trust the multi-point pattern over any single
    // reading" treatment — see recoveryMaxAccuracyMeters in trackingConfig.js.
    let forceReinitState = false;
    let recoveryState = null;
    let recoveryLowConfidence = false;
    const acceptedReferenceIsStale = acceptedElapsedMs != null
      && acceptedElapsedMs > config.candidateConfirmationWindowMs;
    const isRecoveryEligibleRejection = trajectoryDecision === 'OUTLIER'
      || (trajectoryDecision === 'UNCERTAIN' && trajectoryReason === 'LOW_CONFIDENCE')
      // A stale accepted point must not veto the trip forever: in modes that opt in, any other
      // uncertain fix measured against a stale reference also feeds the recovery buffer.
      || (config.lowAccuracyRecovery && acceptedReferenceIsStale
        && trajectoryDecision === 'UNCERTAIN' && trajectoryReason !== 'INVALID_TIMESTAMP');
    if (accepted) {
      consecutiveOutlierCount = 0;
      recoveryCandidates = [];
    } else if (isRecoveryEligibleRejection && lastAcceptedFix) {
      consecutiveOutlierCount += 1;
      if (consecutiveOutlierCount >= config.maxConsecutiveOutliersBeforeRecovery || acceptedReferenceIsStale) {
        trajectoryReason = acceptedReferenceIsStale && consecutiveOutlierCount < config.maxConsecutiveOutliersBeforeRecovery
          ? 'STALE_REFERENCE_RECOVERY' : 'RECOVERY_CANDIDATE';
        recoveryState = 'RECOVERY_CANDIDATE';
        recoveryCandidates.push({ fix, resultIndex: results.length });
        if (recoveryCandidates.length > config.recoveryBufferMaxPoints) {
          const dropped = recoveryCandidates.shift();
          const droppedRow = results[dropped.resultIndex];
          if (droppedRow) droppedRow.trajectory_reason = 'RECOVERY_REJECTED';
        }
        if (recoveryCandidates.length >= config.recoveryMinPoints) {
          const chain = recoveryCandidates.map((candidate) => candidate.fix);
          // Poor-accuracy chain (hills/terrain/Wi-Fi-cell fixes): individual legs are mostly noise,
          // so direction reversals between legs shorter than the fixes' own accuracy are ignored
          // and progress is judged against that accuracy instead (see below).
          const lowAccuracyChain = Boolean(config.lowAccuracyRecovery)
            && chain.some((point) => point.accuracy == null || point.accuracy > config.normalAccuracyMaxM);
          let chainPlausible = true;
          for (let i = 1; i < chain.length && chainPlausible; i += 1) {
            const prevPoint = chain[i - 1];
            const point = chain[i];
            const dtSec = (point.fix_timestamp_ms - prevPoint.fix_timestamp_ms) / 1000;
            if (dtSec <= 0) { chainPlausible = false; break; }
            const legDistance = haversineMeters(prevPoint.latitude, prevPoint.longitude, point.latitude, point.longitude);
            const legSpeed = legDistance / dtSec;
            const legReportedSpeedRaw = point.speed_mps != null && point.speed_mps >= 0 ? point.speed_mps : null;
            const legReportedSpeed = config.treatZeroSpeedAsUnknown && isZeroSpeedPlaceholder(point)
              && legSpeed > config.stationarySpeedMps ? null : legReportedSpeedRaw;
            const legSpeedAgreementOk = legReportedSpeed == null
              || Math.abs(legSpeed - legReportedSpeed) <= config.speedAgreementToleranceMps * 2;
            const legAccuracyOk = (prevPoint.accuracy ?? Infinity) <= config.recoveryMaxAccuracyMeters
              && (point.accuracy ?? Infinity) <= config.recoveryMaxAccuracyMeters;
            if (legSpeed > config.extremePhysicalSpeedMps || !legSpeedAgreementOk || !legAccuracyOk) chainPlausible = false;
            if (i > 1) {
              const priorLegDistance = haversineMeters(chain[i - 2].latitude, chain[i - 2].longitude, prevPoint.latitude, prevPoint.longitude);
              const noiseDominated = lowAccuracyChain
                && legDistance <= (prevPoint.accuracy ?? 0) + (point.accuracy ?? 0)
                && priorLegDistance <= (chain[i - 2].accuracy ?? 0) + (prevPoint.accuracy ?? 0);
              const legBearing = bearingBetween(prevPoint, point);
              const priorBearing = bearingBetween(chain[i - 2], prevPoint);
              if (!noiseDominated && angleDifference(legBearing, priorBearing) > config.bearingPenaltyThresholdDeg) chainPlausible = false;
            }
          }
          const chainPositions = chain.map((point) => ({ latitude: point.latitude, longitude: point.longitude }));
          let { hasProgressiveMovement: chainProgressive } = computeProgressiveMovement(
            chainPositions,
            lowAccuracyChain
              ? { ...config, progressiveMovementMinRatio: config.progressiveMovementMinRatio * LOW_ACCURACY_RECOVERY_RATIO_FACTOR }
              : config,
          );
          if (lowAccuracyChain && chainProgressive) {
            const meanAccuracyM = chain.reduce((sum, point) => sum + (point.accuracy ?? config.recoveryMaxAccuracyMeters), 0) / chain.length;
            const { netDisplacementM } = computeProgressiveMovement(chainPositions, config);
            chainProgressive = netDisplacementM > meanAccuracyM;
          }
          if (chainPlausible && chainProgressive) {
            // RECOVERY_CONFIRMED: promote every buffered candidate to an accepted route point.
            // Earlier candidates' rows already exist (pushed on a prior iteration) and get their
            // filtered position reset to their own raw fix — the smoothing filter had no valid
            // state during the lockout, so predicting from it would just be more stale coordinates.
            // The current (last) candidate's row does not exist yet; its acceptance is expressed by
            // flipping trajectoryDecision/trajectoryReason/isRoutePoint below, same as any other
            // accepted fix reaching the normal push at the end of this iteration.
            recoveryCandidates.slice(0, -1).forEach((candidate) => {
              const row = results[candidate.resultIndex];
              if (!row) return;
              row.trajectory_decision = 'ACCEPTED';
              row.trajectory_reason = 'RECOVERY_CONFIRMED';
              row.is_route_point = 1;
              row.filtered_latitude = candidate.fix.latitude;
              row.filtered_longitude = candidate.fix.longitude;
              row.movement_state = 'MOVING';
              row.recovery_state = 'RECOVERY_CONFIRMED';
              if (lowAccuracyChain) {
                // Confirmed on multi-point agreement alone, never on the fixes' own accuracy: keep
                // them visibly low confidence and no longer "pending".
                row.processing_status = row.is_live_fresh ? 'FRESH_ACCEPTED' : 'HISTORICAL_ACCEPTED';
                row.processing_reason = 'RECOVERY_CONFIRMED';
                row.position_confidence = 'LOW';
              }
            });
            recoveryLowConfidence = lowAccuracyChain;
            trajectoryDecision = 'ACCEPTED';
            trajectoryReason = 'RECOVERY_CONFIRMED';
            recoveryState = 'RECOVERY_CONFIRMED';
            accepted = true;
            forceReinitState = true;
            // Reseed velocity/bearing/speed history from the recovered trajectory itself (section
            // 21), not from the stale pre-lockout state — FILTER_RESEEDED_AFTER_RECOVERY.
            const priorCandidateFix = recoveryCandidates.length > 1
              ? recoveryCandidates[recoveryCandidates.length - 2].fix : lastAcceptedFix;
            const reseedDtSec = Math.max((fix.fix_timestamp_ms - priorCandidateFix.fix_timestamp_ms) / 1000, 0.001);
            const reseedDistance = haversineMeters(priorCandidateFix.latitude, priorCandidateFix.longitude, fix.latitude, fix.longitude);
            previousAcceptedBearing = bearingBetween(priorCandidateFix, fix);
            previousAcceptedImpliedSpeed = reseedDistance / reseedDtSec;
            acceptedSpeeds.length = 0;
            acceptedSpeeds.push(previousAcceptedImpliedSpeed);
            // Cleared (not pre-seeded with this fix) so the generic movementWindow construction
            // below adds it exactly once instead of twice.
            recentAcceptedPositions.length = 0;
            movementEvidence.movingMs = config.movingConfirmationMs;
            movementEvidence.stationaryMs = 0;
            consecutiveUncertainCount = 0;
            consecutiveOutlierCount = 0;
            recoveryCandidates = [];
            pendingUncertain = null;
          }
        }
      }
    }
    const continuityDecision = gap ? 'GAP' : (isSamplingDelay ? 'SAMPLING_DELAY' : 'CONTINUOUS');
    const gapDurationMs = gap ? acceptedElapsedMs : null;
    if (gap && accepted && lastAcceptedFix && !duplicate) segmentId += 1;
    if (gapCandidate && accepted) {
      movementState = 'UNKNOWN';
      movementEvidence.movingMs = 0;
      movementEvidence.stationaryMs = 0;
      // A real time gap (even a "sampling delay" one) breaks the progressive-movement window too —
      // otherwise a point from before a 20s silence and a point from after it could be compared as
      // if they were consecutive walking steps.
      recentAcceptedPositions.length = 0;
    }
    const movementWindow = accepted
      ? [...recentAcceptedPositions, { latitude: fix.latitude, longitude: fix.longitude }]
      : [];
    const { hasProgressiveMovement } = computeProgressiveMovement(movementWindow, config);
    // Gated on real progressive movement, not just any bearing swing: a stationary phone's GPS
    // wanders in every direction within the noise floor, which would otherwise look like a sharp
    // "turn" on every single fix. A turn only means something once actual directional travel is
    // established (section 12) — this also keeps walking output unaffected while merely standing.
    const turnDetected = accepted && hasProgressiveMovement
      && bearingChange != null && bearingChange > config.turnDetectionThresholdDeg;
    if (accepted) {
      movementState = updateMovement(movementState, reportedSpeedUnavailable ? { ...fix, speed_mps: null } : fix, acceptedElapsedMs || 0, previousDistance, config, movementEvidence, hasProgressiveMovement, turnDetected);
      consecutiveUncertainCount = 0;
    } else if (trajectoryDecision === 'UNCERTAIN') {
      consecutiveUncertainCount += 1;
      // Distinct from POSSIBLY_STOPPED/STATIONARY: several UNCERTAIN fixes in a row mean GPS itself
      // is unreliable right now, not that the user stopped moving — only meaningful for modes that
      // use the extended state set (bike), so walking's movement_state values are untouched.
      if (config.extendedMovementStates && consecutiveUncertainCount >= 2 && movementState !== 'STATIONARY') {
        movementState = 'GPS_UNCERTAIN';
      }
    }
    let status = trajectoryDecision === 'ACCEPTED'
      ? (isLiveFresh ? 'FRESH_ACCEPTED' : 'HISTORICAL_ACCEPTED')
      : trajectoryDecision === 'OUTLIER' ? 'OUTLIER' : 'PENDING_CONFIRMATION';
    let reason = trajectoryReason;
    let isRoutePoint = accepted ? 1 : 0;
    if (duplicate) { status = 'DUPLICATE'; reason = 'exact_transport_duplicate'; }
    else if (fallback) { status = stale ? 'STALE_FALLBACK' : 'FRESH_LOW_CONFIDENCE'; reason = 'fallback_not_trusted_for_solid_route'; }
    else if (stale && !accepted) { status = 'STALE_FALLBACK'; reason = 'fix_age_exceeds_freshness_threshold'; }
    else if (gap) { reason = 'active_gap_creates_new_segment'; }
    // Stationary anchor (section 10): the anchor is set/refreshed once entering a stationary-ish
    // state and every subsequent fix is graded against ITS radius, not just distance from the last
    // accepted fix — a formalization of the noise-floor check that also gives the debug viewer a
    // concrete point to draw. Anchor radius/suppression math is unchanged from before for a fix that
    // stays within the noise floor, so walking output is identical; the anchor object itself is new.
    const isStationaryish = movementState === 'STATIONARY' || movementState === 'POSSIBLY_STOPPED';
    // Section 15/16: decide, from this accepted fix's rolling median speed, whether the effective
    // mode escalates/downgrades starting with the NEXT fix. The mode this fix itself was validated
    // under is `effectiveMode` as captured into `config` at the top of this iteration — recorded as
    // effectiveModeForThisFix so the export always shows which profile actually processed each fix.
    const effectiveModeForThisFix = effectiveMode;
    let modeSwitchEvent = null;
    if (accepted) {
      const medianForSwitch = median(acceptedSpeeds.length ? acceptedSpeeds : [impliedSpeed].filter(Number.isFinite));
      const step = stepAdaptiveMode(effectiveMode, userSelectedMode, medianForSwitch, acceptedElapsedMs, modeEvidence, isStationaryish);
      if (step.effectiveMode !== effectiveMode) {
        effectiveMode = step.effectiveMode;
        modeSwitchEvent = step.reason;
      }
    }
    if (accepted && isStationaryish && !hasProgressiveMovement) {
      const anchorRadius = Math.max(config.stationaryRadiusMeters, (fix.accuracy || 0) * config.stationaryAccuracyMultiplier);
      if (!stationaryAnchor) {
        stationaryAnchor = { latitude: fix.latitude, longitude: fix.longitude, radiusM: anchorRadius, sinceMs: fix.fix_timestamp_ms, confidence: 'MEDIUM' };
      } else {
        stationaryAnchor.radiusM = anchorRadius;
        stationaryAnchor.confidence = movementState === 'STATIONARY' ? 'HIGH' : 'MEDIUM';
      }
    } else if (accepted && movementState === 'MOVING') {
      stationaryAnchor = null;
    }
    if (
      accepted
      && !hasProgressiveMovement
      && isStationaryish
      && previousDistance <= Math.max(config.stationaryNoiseFloorM, (fix.accuracy || 0) * config.stationaryAccuracyMultiplier)
    ) {
      reason = 'stationary_noise_suppressed';
      isRoutePoint = results.length === 0 ? 1 : 0;
    }
    const measurementVariance = covarianceFor(fix.accuracy);
    const dt = Math.min(Math.max((intervalMs || 0) / 1000, 0), 30);
    if (accepted && (!stateInitialized || gapCandidate || forceReinitState)) {
      state.east = local.east; state.north = local.north; state.velocityEast = 0; state.velocityNorth = 0; state.variance = measurementVariance;
      stateInitialized = true;
    } else if (lastAcceptedFix && accepted && !gap) {
      // Velocity must come from the filter's own displacement (previous filtered state -> new
      // filtered state), not from (new filtered state - previous RAW fix). Comparing against the
      // raw fix let any prediction/measurement mismatch get baked into "velocity" and re-applied
      // undamped next step, which is an unstable feedback loop: a stationary walker's filtered
      // position could run away tens to hundreds of meters from the real (near-static) GPS track
      // over a couple of minutes. See tests/processing.test.js for a real-session regression case.
      const previousFilteredEast = state.east;
      const previousFilteredNorth = state.north;
      state.east += state.velocityEast * dt;
      state.north += state.velocityNorth * dt;
      const gain = state.variance / (state.variance + measurementVariance);
      state.east += gain * (local.east - state.east);
      state.north += gain * (local.north - state.north);
      const velocityDt = Math.max(dt, 0.001);
      const maxSpeed = config.extremePhysicalSpeedMps;
      state.velocityEast = clamp((state.east - previousFilteredEast) / velocityDt, -maxSpeed, maxSpeed);
      state.velocityNorth = clamp((state.north - previousFilteredNorth) / velocityDt, -maxSpeed, maxSpeed);
      // On a detected turn, inject extra process noise (scaled by how little smoothing
      // turnSmoothingStrength calls for) so NEXT step's gain trusts the fresh GPS fix more instead of
      // cutting the corner toward the pre-turn trajectory (section 11-12). Off a turn, this reduces to
      // exactly the original constant (4 * dt) — walking output is unchanged unless a turn fires.
      const turnBoost = turnDetected ? (4 * dt) * (1 / Math.max(config.turnSmoothingStrength, 0.01) - 1) : 0;
      state.variance = Math.max(1, (1 - gain) * state.variance + 4 * dt + turnBoost);
    }
    const filtered = fromLocalMeters(state.east, state.north, origin);
    const innovationM = lastAcceptedFix ? haversineMeters(filtered.latitude, filtered.longitude, fix.latitude, fix.longitude) : 0;
    const uncertaintyM = Math.sqrt(state.variance);
    results.push({
      ...fix, raw_fix_id: fix.id ?? index + 1, algorithm_version: config.algorithmVersion,
      processing_status: status, processing_reason: reason, filtered_latitude: filtered.latitude,
      filtered_longitude: filtered.longitude, predicted_latitude: filtered.latitude, predicted_longitude: filtered.longitude,
      innovation_m: innovationM, normalized_innovation: innovationM * innovationM / Math.max(measurementVariance, 1),
      estimated_uncertainty_m: uncertaintyM,
      position_confidence: recoveryLowConfidence ? 'LOW'
        : status === 'FRESH_ACCEPTED' ? (fix.accuracy <= 20 ? 'HIGH' : 'MEDIUM') : 'LOW',
      movement_state: movementState, segment_id: segmentId, is_route_point: isRoutePoint,
      continuity_decision: continuityDecision, gap_duration_ms: gapDurationMs,
      route_segment_type: accepted ? (gap ? 'GAP' : 'RAW_GPS') : null,
      // Matching hasn't run yet at ingest time (it happens later in routeMatching.js), so this
      // stays null here — same as map_match_status/map_matched_latitude above — and only gets a
      // real value once db.updateMatchDiagnostics() persists an actual matching outcome.
      matcher_version: null,
      interval_ms: intervalMs, raw_to_filtered_m: haversineMeters(fix.latitude, fix.longitude, filtered.latitude, filtered.longitude),
      raw_delivery_interval_ms: rawDeliveryIntervalMs, accepted_interval_ms: acceptedElapsedMs,
      delivery_latency_ms: deliveryLatencyMs, is_live_fresh: isLiveFresh ? 1 : 0,
      is_trajectory_usable: isTrajectoryUsable ? 1 : 0,
      trajectory_decision: trajectoryDecision, trajectory_reason: trajectoryReason,
      distance_from_last_accepted_m: previousDistance, elapsed_time_ms: acceptedElapsedMs,
      implied_speed_mps: impliedSpeed, reported_speed_mps: reportedSpeed,
      recent_median_speed_mps: recentMedianSpeed, bearing: currentBearing, bearing_change: bearingChange,
      turn_detected: turnDetected ? 1 : 0, acceleration_mps2: acceleration,
      stationary_anchor_latitude: stationaryAnchor?.latitude ?? null,
      stationary_anchor_longitude: stationaryAnchor?.longitude ?? null,
      accepted_reference_latitude: lastAcceptedFix?.latitude ?? null,
      accepted_reference_longitude: lastAcceptedFix?.longitude ?? null,
      user_selected_mode: userSelectedMode, effective_mode: effectiveModeForThisFix,
      mode_switch_event: modeSwitchEvent, recovery_state: recoveryState,
      high_speed_override: trajectoryReason === 'HIGH_SPEED_CONTINUITY_ACCEPT' ? 1 : 0,
      filter_reseeded: forceReinitState ? 1 : 0,
      speed_agreement_mps: reportedSpeed != null && impliedSpeed != null ? Math.abs(impliedSpeed - reportedSpeed) : null,
      reported_speed_unavailable: reportedSpeedUnavailable ? 1 : 0,
    });
    if (!duplicate) seen.push(fix);
    if (accepted) {
      // A recovery-confirmed fix already had its speed/bearing/position history reseeded from the
      // recovered trajectory itself (section 21) — redoing this bookkeeping here would overwrite
      // that with numbers measured against the stale pre-lockout reference (the same huge jump that
      // triggered recovery in the first place), corrupting recentMedianSpeed/bearing for every fix
      // that follows.
      if (!forceReinitState) {
        if (impliedSpeed != null && Number.isFinite(impliedSpeed)) acceptedSpeeds.push(impliedSpeed);
        if (acceptedSpeeds.length > config.recentSpeedHistoryLength) acceptedSpeeds.shift();
        if (currentBearing != null) previousAcceptedBearing = currentBearing;
        if (impliedSpeed != null && Number.isFinite(impliedSpeed)) previousAcceptedImpliedSpeed = impliedSpeed;
      }
      recentAcceptedPositions.push({ latitude: fix.latitude, longitude: fix.longitude });
      if (recentAcceptedPositions.length > config.progressiveMovementWindowSize) recentAcceptedPositions.shift();
      lastAcceptedFix = fix;
    }
    previousRaw = fix;
  });
  return results;
}

function routeLength(points, latKey = 'latitude', lonKey = 'longitude') {
  return points.reduce((total, point, index) => index ? total + haversineMeters(points[index - 1][latKey], points[index - 1][lonKey], point[latKey], point[lonKey]) : 0, 0);
}

if (typeof module !== 'undefined') module.exports = {
  haversineMeters, toLocalMeters, fromLocalMeters, percentile, normalizeFix, processLocations, routeLength,
  computeProgressiveMovement, bearingBetween, angleDifference, blendAngles, stepAdaptiveMode,
};