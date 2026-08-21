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
function angleDifference(a, b) {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
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

function updateMovement(previous, fix, elapsedMs, displacementM, config, evidence, hasProgressiveMovement) {
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
    return evidence.movingMs >= config.movingConfirmationMs ? 'MOVING' : 'POSSIBLY_MOVING';
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

function processLocations(rawLocations, options = {}) {
  const config = { ...require('./trackingConfig').PROCESSING_CONFIG, ...options };
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
  let movementState = 'UNKNOWN';
  const movementEvidence = { movingMs: 0, stationaryMs: 0 };
  let segmentId = 0;
  const results = [];
  const seen = [];

  normalized.forEach((fix, index) => {
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
    const reportedSpeed = fix.speed_mps != null && fix.speed_mps >= 0 ? fix.speed_mps : null;
    const recentMedianSpeed = median(acceptedSpeeds);
    const currentBearing = lastAcceptedFix && previousDistance > 1 ? bearingBetween(lastAcceptedFix, fix) : null;
    const bearingChange = currentBearing != null && previousAcceptedBearing != null
      ? angleDifference(currentBearing, previousAcceptedBearing) : null;
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
    const plausibleSpeed = Math.min(config.walkingBurstSpeedMps,
      Math.max(config.walkingPlausibleSpeedMps, (recentMedianSpeed || 0) * 2.5));
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
      trajectoryDecision = 'OUTLIER'; trajectoryReason = 'EXCESSIVE_DISPLACEMENT';
    } else if (impliedSpeed != null && reportedSpeed != null && Math.abs(impliedSpeed - reportedSpeed) > 5) {
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'SPEED_MISMATCH';
    } else if (bearingChange != null && bearingChange > config.bearingPenaltyThresholdDeg && previousDistance > 40 && impliedSpeed > config.walkingPlausibleSpeedMps * 1.5) {
      trajectoryDecision = 'UNCERTAIN'; trajectoryReason = 'BEARING_INCONSISTENCY';
    }
    // Candidate confirmation (Fix 4): a fix that looks implausible measured straight from
    // lastAcceptedFix (A) can still be trustworthy if it forms a coherent walking pace with the
    // immediately preceding UNCERTAIN fix (X) — i.e. the walker plausibly moved A -> X -> Y.
    // Never applies to DUPLICATE/INVALID_TIMESTAMP/LOW_CONFIDENCE/IMPOSSIBLE_SPEED: those reflect
    // a problem with the fix itself (or the absolute safety ceiling), not just an A->Y comparison.
    const confirmableReasons = ['SPEED_MISMATCH', 'BEARING_INCONSISTENCY', 'EXCESSIVE_DISPLACEMENT'];
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
    const accepted = trajectoryDecision === 'ACCEPTED';
    if (accepted) {
      pendingUncertain = null;
    } else if (trajectoryDecision === 'UNCERTAIN' && ['SPEED_MISMATCH', 'BEARING_INCONSISTENCY'].includes(trajectoryReason)) {
      // Only trajectory-shape uncertainty becomes a confirmation candidate — a fix that is
      // uncertain because of its own poor accuracy (LOW_CONFIDENCE) is not trustworthy enough
      // to anchor a future confirmation, even if a later fix lands close to it.
      pendingUncertain = fix;
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
    if (accepted) movementState = updateMovement(movementState, fix, acceptedElapsedMs || 0, previousDistance, config, movementEvidence, hasProgressiveMovement);
    let status = trajectoryDecision === 'ACCEPTED'
      ? (isLiveFresh ? 'FRESH_ACCEPTED' : 'HISTORICAL_ACCEPTED')
      : trajectoryDecision === 'OUTLIER' ? 'OUTLIER' : 'PENDING_CONFIRMATION';
    let reason = trajectoryReason;
    let isRoutePoint = accepted ? 1 : 0;
    if (duplicate) { status = 'DUPLICATE'; reason = 'exact_transport_duplicate'; }
    else if (fallback) { status = stale ? 'STALE_FALLBACK' : 'FRESH_LOW_CONFIDENCE'; reason = 'fallback_not_trusted_for_solid_route'; }
    else if (stale && !accepted) { status = 'STALE_FALLBACK'; reason = 'fix_age_exceeds_freshness_threshold'; }
    else if (gap) { reason = 'active_gap_creates_new_segment'; }
    if (
      accepted
      && !hasProgressiveMovement
      && (movementState === 'STATIONARY' || movementState === 'POSSIBLY_STOPPED')
      && previousDistance <= Math.max(config.stationaryNoiseFloorM, (fix.accuracy || 0) * config.stationaryAccuracyMultiplier)
    ) {
      reason = 'stationary_noise_suppressed';
      isRoutePoint = results.length === 0 ? 1 : 0;
    }
    const measurementVariance = covarianceFor(fix.accuracy);
    const dt = Math.min(Math.max((intervalMs || 0) / 1000, 0), 30);
    if (accepted && (!stateInitialized || gapCandidate)) {
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
      state.variance = Math.max(1, (1 - gain) * state.variance + 4 * dt);
    }
    const filtered = fromLocalMeters(state.east, state.north, origin);
    const innovationM = lastAcceptedFix ? haversineMeters(filtered.latitude, filtered.longitude, fix.latitude, fix.longitude) : 0;
    const uncertaintyM = Math.sqrt(state.variance);
    results.push({
      ...fix, raw_fix_id: fix.id ?? index + 1, algorithm_version: config.algorithmVersion,
      processing_status: status, processing_reason: reason, filtered_latitude: filtered.latitude,
      filtered_longitude: filtered.longitude, predicted_latitude: filtered.latitude, predicted_longitude: filtered.longitude,
      innovation_m: innovationM, normalized_innovation: innovationM * innovationM / Math.max(measurementVariance, 1),
      estimated_uncertainty_m: uncertaintyM, position_confidence: status === 'FRESH_ACCEPTED' ? (fix.accuracy <= 20 ? 'HIGH' : 'MEDIUM') : 'LOW',
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
      accepted_reference_latitude: lastAcceptedFix?.latitude ?? null,
      accepted_reference_longitude: lastAcceptedFix?.longitude ?? null,
    });
    if (!duplicate) seen.push(fix);
    if (accepted) {
      if (impliedSpeed != null && Number.isFinite(impliedSpeed)) acceptedSpeeds.push(impliedSpeed);
      if (acceptedSpeeds.length > config.recentSpeedHistoryLength) acceptedSpeeds.shift();
      if (currentBearing != null) previousAcceptedBearing = currentBearing;
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
  computeProgressiveMovement,
};