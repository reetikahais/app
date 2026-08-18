// Pure movement-detection state machine: STATIONARY <-> CONFIRMING_MOVEMENT <-> MOVING <-> CONFIRMING_STOP.
// No I/O, no platform APIs - keeps this testable and portable (Flutter mirrors this file 1:1 in Dart).

export const MIN_NOISE_FLOOR_M = 15;
export const CONFIRMATION_COUNT = 2;
export const BEARING_TOLERANCE_DEG = 45;
export const MIN_BEARING_DISTANCE_M = 25;
export const MIN_CONFIRMED_SPEED_MPS = 1.2;
export const MAX_USABLE_ACCURACY_FOR_SPEED_M = 100;
export const STATIONARY_CONFIRMATION_COUNT = 2;

// weight = 1/accuracy^2 (see foldFixIntoAnchor) must never see 0/null/NaN/Infinity/negative -
// any of those either throws, divides by zero, or silently poisons the anchor average. Invalid or
// unknown accuracy is treated as *very uncertain* (large fallback -> near-zero weight), never as
// falsely precise: inventing fake precision from missing data is worse than a fix barely counting.
export const MIN_ACCURACY_FLOOR_M = 1;
export const INVALID_ACCURACY_FALLBACK_M = 1000;

export function sanitizeAccuracy(accuracy) {
  if (accuracy == null || !Number.isFinite(accuracy) || accuracy <= 0) {
    return INVALID_ACCURACY_FALLBACK_M;
  }
  return Math.max(accuracy, MIN_ACCURACY_FLOOR_M);
}

const EARTH_RADIUS_M = 6371000;

export function haversineDistanceMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function initialBearingDegrees(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function circularBearingDiffDeg(b1, b2) {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function computeNoiseThresholdM(accuracyA, accuracyB) {
  return Math.max(accuracyA, accuracyB) + MIN_NOISE_FLOOR_M;
}

// Bundles the distance+threshold pair transition functions each compute against a reference
// point (anchor or last-moving-fix) - pure code reuse, not a new decision rule. `fix.accuracy`
// is sanitized here so every call site gets the same invalid-accuracy handling for free.
export function computeFixMetrics(referencePoint, fix) {
  const sanitizedFix = { ...fix, accuracy: sanitizeAccuracy(fix.accuracy) };
  return {
    distanceM: haversineDistanceMeters(referencePoint, sanitizedFix),
    thresholdM: computeNoiseThresholdM(referencePoint.accuracy, sanitizedFix.accuracy),
  };
}

export function passesBearingCheck(segmentDistanceM, bearingDiffDeg) {
  if (segmentDistanceM < MIN_BEARING_DISTANCE_M) return true;
  return bearingDiffDeg <= BEARING_TOLERANCE_DEG;
}

function isSpeedConfirmed(fix) {
  return (
    fix.speed != null &&
    Number.isFinite(fix.speed) &&
    fix.speed >= MIN_CONFIRMED_SPEED_MPS &&
    fix.accuracy <= MAX_USABLE_ACCURACY_FOR_SPEED_M
  );
}

export function foldFixIntoAnchor(anchor, fix) {
  const accuracy = sanitizeAccuracy(fix.accuracy);
  const weight = 1 / (accuracy * accuracy);
  if (!anchor) {
    return { lat: fix.lat, lon: fix.lon, accuracy, totalWeight: weight };
  }
  const totalWeight = anchor.totalWeight + weight;
  return {
    lat: (anchor.lat * anchor.totalWeight + fix.lat * weight) / totalWeight,
    lon: (anchor.lon * anchor.totalWeight + fix.lon * weight) / totalWeight,
    accuracy: 1 / Math.sqrt(totalWeight),
    totalWeight,
  };
}

// Graduated smoothing of the *displayed/stored* processed point, layered on top of the anchor
// above (which is unchanged: STATIONARY keeps its own accuracy-weighted averaging - already
// "strong" smoothing). The other three states blend the previous processed point toward the new
// raw fix by `alpha` (closer to 1 = follows raw more closely). This damps a single-fix sideways
// GPS jump without making the trail lag behind real movement.
export const CONFIRMING_MOVEMENT_SMOOTHING_ALPHA = 0.5;
export const MOVING_SMOOTHING_ALPHA = 0.8;
export const CONFIRMING_STOP_SMOOTHING_ALPHA = 0.5;

export function blendPoint(prev, next, alpha) {
  return {
    lat: prev.lat + (next.lat - prev.lat) * alpha,
    lon: prev.lon + (next.lon - prev.lon) * alpha,
  };
}

export function createInitialMovementState() {
  return {
    state: 'STATIONARY',
    anchor: null,
    candidateStreak: [],
    lastMovingFix: null,
    stopStreak: [],
    stationarySinceMs: null,
    processedLat: null,
    processedLon: null,
  };
}

function toMoving(fix, prevProcessed) {
  const processed = prevProcessed ? blendPoint(prevProcessed, fix, MOVING_SMOOTHING_ALPHA) : { lat: fix.lat, lon: fix.lon };
  return {
    state: 'MOVING',
    anchor: null,
    candidateStreak: [],
    lastMovingFix: fix,
    stopStreak: [],
    stationarySinceMs: null,
    processedLat: processed.lat,
    processedLon: processed.lon,
  };
}

function processStationary(prev, fix) {
  if (!prev.anchor) {
    const anchor = foldFixIntoAnchor(null, fix);
    return {
      state: 'STATIONARY',
      anchor,
      candidateStreak: [],
      lastMovingFix: null,
      stopStreak: [],
      stationarySinceMs: fix.timestampMs ?? null,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    };
  }
  const { distanceM: dist, thresholdM: threshold } = computeFixMetrics(prev.anchor, fix);
  if (dist <= threshold) {
    const anchor = foldFixIntoAnchor(prev.anchor, fix);
    return {
      state: 'STATIONARY',
      anchor,
      candidateStreak: [],
      lastMovingFix: null,
      stopStreak: [],
      stationarySinceMs: prev.stationarySinceMs,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    };
  }
  if (isSpeedConfirmed(fix)) {
    return toMoving(fix, { lat: prev.processedLat, lon: prev.processedLon });
  }
  const processed = blendPoint({ lat: prev.processedLat, lon: prev.processedLon }, fix, CONFIRMING_MOVEMENT_SMOOTHING_ALPHA);
  return {
    state: 'CONFIRMING_MOVEMENT',
    anchor: prev.anchor,
    candidateStreak: [fix],
    lastMovingFix: null,
    stopStreak: [],
    stationarySinceMs: prev.stationarySinceMs,
    processedLat: processed.lat,
    processedLon: processed.lon,
  };
}

function processConfirmingMovement(prev, fix) {
  const { distanceM: distFromAnchor, thresholdM: thresholdFromAnchor } = computeFixMetrics(prev.anchor, fix);
  if (distFromAnchor <= thresholdFromAnchor) {
    // Fell back inside the original anchor's noise circle: GPS jump-and-return, not movement.
    const anchor = foldFixIntoAnchor(prev.anchor, fix);
    return {
      state: 'STATIONARY',
      anchor,
      candidateStreak: [],
      lastMovingFix: null,
      stopStreak: [],
      stationarySinceMs: prev.stationarySinceMs,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    };
  }
  if (isSpeedConfirmed(fix)) {
    return toMoving(fix, { lat: prev.processedLat, lon: prev.processedLon });
  }

  const streak = [...prev.candidateStreak, fix];
  if (streak.length >= CONFIRMATION_COUNT) {
    const prevCandidate = streak[streak.length - 2];
    const segmentDistance = haversineDistanceMeters(prevCandidate, fix);
    const b1 = initialBearingDegrees(prev.anchor, prevCandidate);
    const b2 = initialBearingDegrees(prevCandidate, fix);
    const bearingDiff = circularBearingDiffDeg(b1, b2);
    if (passesBearingCheck(segmentDistance, bearingDiff)) {
      return toMoving(fix, { lat: prev.processedLat, lon: prev.processedLon });
    }
    // Inconsistent direction: not a confirmed move yet. Restart the confirmation window from
    // this fix rather than growing it unboundedly - an erratic streak never converges.
    const processed = blendPoint({ lat: prev.processedLat, lon: prev.processedLon }, fix, CONFIRMING_MOVEMENT_SMOOTHING_ALPHA);
    return {
      state: 'CONFIRMING_MOVEMENT',
      anchor: prev.anchor,
      candidateStreak: [fix],
      lastMovingFix: null,
      stopStreak: [],
      stationarySinceMs: prev.stationarySinceMs,
      processedLat: processed.lat,
      processedLon: processed.lon,
    };
  }
  const processed = blendPoint({ lat: prev.processedLat, lon: prev.processedLon }, fix, CONFIRMING_MOVEMENT_SMOOTHING_ALPHA);
  return {
    state: 'CONFIRMING_MOVEMENT',
    anchor: prev.anchor,
    candidateStreak: streak,
    lastMovingFix: null,
    stopStreak: [],
    stationarySinceMs: prev.stationarySinceMs,
    processedLat: processed.lat,
    processedLon: processed.lon,
  };
}

function processMoving(prev, fix) {
  const { distanceM: dist, thresholdM: threshold } = computeFixMetrics(prev.lastMovingFix, fix);
  if (dist <= threshold) {
    const processed = blendPoint({ lat: prev.processedLat, lon: prev.processedLon }, fix, CONFIRMING_STOP_SMOOTHING_ALPHA);
    return {
      state: 'CONFIRMING_STOP',
      anchor: null,
      candidateStreak: [],
      lastMovingFix: prev.lastMovingFix,
      stopStreak: [fix],
      stationarySinceMs: null,
      processedLat: processed.lat,
      processedLon: processed.lon,
    };
  }
  return toMoving(fix, { lat: prev.processedLat, lon: prev.processedLon });
}

function processConfirmingStop(prev, fix) {
  const last = prev.stopStreak[prev.stopStreak.length - 1];
  const { distanceM: dist, thresholdM: threshold } = computeFixMetrics(last, fix);
  if (dist > threshold) {
    // Moved again before the stop was confirmed.
    return toMoving(fix, { lat: prev.processedLat, lon: prev.processedLon });
  }
  const streak = [...prev.stopStreak, fix];
  if (streak.length >= STATIONARY_CONFIRMATION_COUNT) {
    let anchor = null;
    for (const f of streak) anchor = foldFixIntoAnchor(anchor, f);
    return {
      state: 'STATIONARY',
      anchor,
      candidateStreak: [],
      lastMovingFix: null,
      stopStreak: [],
      stationarySinceMs: streak[0].timestampMs ?? null,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    };
  }
  const processed = blendPoint({ lat: prev.processedLat, lon: prev.processedLon }, fix, CONFIRMING_STOP_SMOOTHING_ALPHA);
  return {
    state: 'CONFIRMING_STOP',
    anchor: null,
    candidateStreak: [],
    lastMovingFix: prev.lastMovingFix,
    stopStreak: streak,
    stationarySinceMs: null,
    processedLat: processed.lat,
    processedLon: processed.lon,
  };
}

// Position to display/store for a fix - already computed as part of the state transition above
// (see the graduated-smoothing comment). Kept as its own accessor so callers don't need to know
// about the `processedLat`/`processedLon` field names.
export function getProcessedLocation(state) {
  return { lat: state.processedLat, lon: state.processedLon };
}

export function getDistanceFromAnchorM(state, fix) {
  if (!state.anchor) return 0;
  return haversineDistanceMeters(state.anchor, fix);
}

// 0-100 confidence score for a single fix - NOT a re-statement of accuracy-in-meters, and NOT a
// claim that processing made the underlying GPS measurement more physically precise. A 40m-accuracy
// fix folded into a rock-stable anchor is still only worth as much trust as a 40m fix; the anchor
// looking stable on screen doesn't mean the original measurement became a 3m-accurate one.
// Dominated by sanitized accuracy (tighter = higher), with a penalty while the movement state
// machine hasn't yet corroborated this fix with enough consecutive evidence (CONFIRMING_* states) -
// that corroboration already *is* the distance/speed/bearing consistency check from Section 1, so
// quality reads its verdict rather than re-deriving consistency separately.
export const QUALITY_UNCONFIRMED_PENALTY = 10;

export function getLocationQuality(state, fix) {
  const accuracy = sanitizeAccuracy(fix.accuracy);
  let score = 100 - accuracy;
  if (state.state === 'CONFIRMING_MOVEMENT' || state.state === 'CONFIRMING_STOP') {
    score -= QUALITY_UNCONFIRMED_PENALTY;
  }
  return Math.round(Math.max(0, Math.min(100, score)));
}

// Adaptive polling tiers - see docs/superpowers/specs/2026-08-17-continuous-location-cache-design.md
// ("Adaptive polling frequency") for the rationale. Not used as a movement signal (Section 1,
// rule 5) - only chooses how often to ask for the next fix. MOVING tier is 10s/20s (not the
// original 15s/30s design default) - chosen over a more aggressive 5s/10s to keep the responsiveness
// win from Change 5 without tripling foreground battery cost while actively tracking.
export const MOVING_INTERVAL_FOREGROUND_MS = 10000;
export const MOVING_INTERVAL_BACKGROUND_MS = 20000;
export const STATIONARY_INTERVAL_FOREGROUND_MS = 60000;
export const STATIONARY_INTERVAL_BACKGROUND_MS = 90000;
export const LONG_STATIONARY_THRESHOLD_MS = 5 * 60 * 1000;
export const LONG_STATIONARY_INTERVAL_FOREGROUND_MS = 180000;
export const LONG_STATIONARY_INTERVAL_BACKGROUND_MS = 300000;

export function computePollingIntervalMs(state, nowMs, appState) {
  const isBackground = appState === 'background';
  if (state.state !== 'STATIONARY') {
    return isBackground ? MOVING_INTERVAL_BACKGROUND_MS : MOVING_INTERVAL_FOREGROUND_MS;
  }
  const stationaryDurationMs = state.stationarySinceMs != null ? Math.max(0, nowMs - state.stationarySinceMs) : 0;
  if (stationaryDurationMs >= LONG_STATIONARY_THRESHOLD_MS) {
    return isBackground ? LONG_STATIONARY_INTERVAL_BACKGROUND_MS : LONG_STATIONARY_INTERVAL_FOREGROUND_MS;
  }
  return isBackground ? STATIONARY_INTERVAL_BACKGROUND_MS : STATIONARY_INTERVAL_FOREGROUND_MS;
}

// Movement state also implies a desired GPS *precision* mode, not just cadence (Change 4): high
// accuracy while there's any chance of movement, balanced/default accuracy once settled STATIONARY
// (the OS/hardware still decides what it can actually deliver - this only requests, it doesn't
// guarantee, better fixes).
export const HIGH_ACCURACY_STATES = new Set(['MOVING', 'CONFIRMING_MOVEMENT', 'CONFIRMING_STOP']);

export function wantsHighAccuracy(state) {
  return HIGH_ACCURACY_STATES.has(state.state);
}

// Tags rows produced by this version of the processing pipeline (Round 3, item 6) - lets future
// changes to the formulas above be told apart from older stored rows without guessing from dates.
export const PROCESSING_VERSION = 2;

export function processLocationFix(prevState, rawFix) {
  const fix = { ...rawFix, accuracy: sanitizeAccuracy(rawFix.accuracy) };
  switch (prevState.state) {
    case 'STATIONARY':
      return processStationary(prevState, fix);
    case 'CONFIRMING_MOVEMENT':
      return processConfirmingMovement(prevState, fix);
    case 'MOVING':
      return processMoving(prevState, fix);
    case 'CONFIRMING_STOP':
      return processConfirmingStop(prevState, fix);
    default:
      throw new Error(`Unknown movement state: ${prevState.state}`);
  }
}
