import {
  createInitialMovementState,
  processLocationFix,
  haversineDistanceMeters,
  initialBearingDegrees,
  circularBearingDiffDeg,
  computeNoiseThresholdM,
  passesBearingCheck,
  getProcessedLocation,
  getDistanceFromAnchorM,
  getLocationQuality,
  sanitizeAccuracy,
  foldFixIntoAnchor,
  blendPoint,
  wantsHighAccuracy,
  computePollingIntervalMs,
  computeFixMetrics,
  PROCESSING_VERSION,
  MOVING_INTERVAL_FOREGROUND_MS,
  MOVING_INTERVAL_BACKGROUND_MS,
  STATIONARY_INTERVAL_FOREGROUND_MS,
  STATIONARY_INTERVAL_BACKGROUND_MS,
  LONG_STATIONARY_INTERVAL_FOREGROUND_MS,
  LONG_STATIONARY_INTERVAL_BACKGROUND_MS,
  LONG_STATIONARY_THRESHOLD_MS,
  MOVING_SMOOTHING_ALPHA,
  INVALID_ACCURACY_FALLBACK_M,
  MIN_ACCURACY_FLOOR_M,
} from '../movementStateMachine';

const BASE = { lat: 31.4440206, lon: 77.0467109 };
const METERS_PER_DEG_LAT = 111320;

// Approximate local offset in meters -> lat/lon. Good enough for unit tests
// (errors are sub-percent at this latitude over tens/hundreds of meters).
function offset(base, dNorthM, dEastM) {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180);
  return {
    lat: base.lat + dNorthM / METERS_PER_DEG_LAT,
    lon: base.lon + dEastM / metersPerDegLon,
  };
}

function fix(dNorthM, dEastM, accuracy, opts = {}) {
  const pos = offset(BASE, dNorthM, dEastM);
  return {
    lat: pos.lat,
    lon: pos.lon,
    accuracy,
    speed: opts.speed ?? null,
    timestamp: opts.timestamp ?? 0,
  };
}

describe('pure geo helpers', () => {
  test('haversineDistanceMeters is ~0 for identical points', () => {
    expect(haversineDistanceMeters(BASE, BASE)).toBeCloseTo(0, 3);
  });

  test('haversineDistanceMeters matches known offset within 1%', () => {
    const p = offset(BASE, 100, 0); // 100m due north
    const d = haversineDistanceMeters(BASE, p);
    expect(d).toBeGreaterThan(99);
    expect(d).toBeLessThan(101);
  });

  test('initialBearingDegrees: due north is ~0', () => {
    const p = offset(BASE, 100, 0);
    expect(initialBearingDegrees(BASE, p)).toBeCloseTo(0, 0);
  });

  test('initialBearingDegrees: due east is ~90', () => {
    const p = offset(BASE, 0, 100);
    expect(initialBearingDegrees(BASE, p)).toBeCloseTo(90, 0);
  });

  test('circularBearingDiffDeg: simple case', () => {
    expect(circularBearingDiffDeg(10, 30)).toBeCloseTo(20, 5);
  });

  test('circularBearingDiffDeg: wraps correctly across 0/360', () => {
    expect(circularBearingDiffDeg(350, 10)).toBeCloseTo(20, 5);
    expect(circularBearingDiffDeg(5, 355)).toBeCloseTo(10, 5);
  });

  test('computeNoiseThresholdM: max(accuracy) + 15m floor', () => {
    expect(computeNoiseThresholdM(20, 35)).toBe(50);
    expect(computeNoiseThresholdM(35, 20)).toBe(50);
  });

  test('passesBearingCheck: skips check under 25m segment distance', () => {
    expect(passesBearingCheck(24, 179)).toBe(true);
  });

  test('passesBearingCheck: enforces tolerance at/over 25m segment distance', () => {
    expect(passesBearingCheck(25, 45)).toBe(true);
    expect(passesBearingCheck(25, 45.01)).toBe(false);
  });
});

describe('movement state machine', () => {
  test('1. stationary user with 10-40m GPS scatter remains STATIONARY', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 19));
    state = processLocationFix(state, fix(-9, -3, 35));
    state = processLocationFix(state, fix(-10, -5, 36));
    state = processLocationFix(state, fix(-13, 3, 41));
    expect(state.state).toBe('STATIONARY');
  });

  test('2. accurate stationary points do not flap between states', () => {
    let state = createInitialMovementState();
    for (let i = 0; i < 10; i++) {
      state = processLocationFix(state, fix(i % 2 === 0 ? 3 : -3, 0, 8));
      expect(state.state).toBe('STATIONARY');
    }
  });

  test('3. large GPS jump followed by a return to anchor remains STATIONARY', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10)); // anchor
    state = processLocationFix(state, fix(200, 0, 15)); // jump -> candidate
    expect(state.state).toBe('CONFIRMING_MOVEMENT');
    state = processLocationFix(state, fix(2, 0, 10)); // back near anchor
    expect(state.state).toBe('STATIONARY');
  });

  test('4. two consecutive consistent movement fixes becomes MOVING', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10)); // anchor
    state = processLocationFix(state, fix(50, 0, 10)); // candidate 1, due north
    expect(state.state).toBe('CONFIRMING_MOVEMENT');
    state = processLocationFix(state, fix(100, 0, 10)); // candidate 2, same bearing
    expect(state.state).toBe('MOVING');
  });

  test('5. speed >= 1.2 m/s with usable accuracy becomes MOVING immediately', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10)); // anchor
    state = processLocationFix(state, fix(50, 0, 10, { speed: 1.5 }));
    expect(state.state).toBe('MOVING');
  });

  test('6. slow movement below speed threshold still detected via distance/bearing', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10)); // anchor
    state = processLocationFix(state, fix(50, 0, 10, { speed: 0.3 }));
    expect(state.state).toBe('CONFIRMING_MOVEMENT');
    state = processLocationFix(state, fix(100, 0, 10, { speed: 0.3 }));
    expect(state.state).toBe('MOVING');
  });

  test('7. one stationary-looking fix while MOVING does not drop straight to STATIONARY', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10));
    state = processLocationFix(state, fix(50, 0, 10, { speed: 2 }));
    expect(state.state).toBe('MOVING');
    state = processLocationFix(state, fix(51, 1, 10)); // stationary-looking
    expect(state.state).not.toBe('STATIONARY');
    expect(state.state).toBe('CONFIRMING_STOP');
  });

  test('8. two consecutive stationary fixes while MOVING transitions to STATIONARY', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10));
    state = processLocationFix(state, fix(50, 0, 10, { speed: 2 }));
    state = processLocationFix(state, fix(51, 1, 10)); // -> CONFIRMING_STOP
    expect(state.state).toBe('CONFIRMING_STOP');
    state = processLocationFix(state, fix(50, 0, 10)); // clusters with previous
    expect(state.state).toBe('STATIONARY');
  });

  test('confirming-stop: a moving fix in between reverts back to MOVING', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10));
    state = processLocationFix(state, fix(50, 0, 10, { speed: 2 }));
    state = processLocationFix(state, fix(51, 1, 10)); // -> CONFIRMING_STOP
    state = processLocationFix(state, fix(120, 0, 10, { speed: 2 })); // moved again
    expect(state.state).toBe('MOVING');
  });

  test('9. background fixes with 30-50m accuracy are not automatically treated as movement', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 30));
    state = processLocationFix(state, fix(15, -10, 45));
    state = processLocationFix(state, fix(-10, 20, 50));
    expect(state.state).toBe('STATIONARY');
  });

  test('10. bearing near 0/360 wrap compares correctly inside the state machine', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 5)); // anchor, tight accuracy
    // candidate 1: bearing ~350 deg (slightly west of north)
    state = processLocationFix(state, fix(50, -9, 5));
    expect(state.state).toBe('CONFIRMING_MOVEMENT');
    // candidate 2: continues north-ish, bearing ~10 deg from candidate 1 -> diff ~20deg, wraps 350->10
    state = processLocationFix(state, fix(100, 0, 5));
    expect(state.state).toBe('MOVING');
  });

  test('11. short-distance (<25m) consecutive candidates skip the bearing check', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 2)); // very tight anchor accuracy
    // candidate 1: 30m north (exceeds threshold of 2+15=17)
    state = processLocationFix(state, fix(30, 0, 2));
    expect(state.state).toBe('CONFIRMING_MOVEMENT');
    // candidate 2: only 10m further east from candidate 1 (<25m segment) with a wild bearing swing,
    // still exceeds threshold from the original anchor -> should confirm MOVING since bearing is skipped
    state = processLocationFix(state, fix(30, 10, 2));
    expect(state.state).toBe('MOVING');
  });

  test('getProcessedLocation returns the smoothed anchor while STATIONARY', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 19));
    state = processLocationFix(state, fix(-9, -3, 35));
    const processed = getProcessedLocation(state);
    expect(processed.lat).toBeCloseTo(state.anchor.lat, 10);
    expect(processed.lon).toBeCloseTo(state.anchor.lon, 10);
  });

  test('getProcessedLocation lightly smooths (does not exactly equal raw) the first fix while MOVING', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10)); // anchor/processed = (0,0)
    const f = fix(50, 0, 10, { speed: 2 });
    state = processLocationFix(state, f);
    expect(state.state).toBe('MOVING');
    const processed = getProcessedLocation(state);
    // alpha=0.8 towards raw fix from the previous processed point (the anchor) - close to raw,
    // not identical, and strictly between the previous point and the raw fix.
    expect(processed.lat).not.toBeCloseTo(f.lat, 10);
    expect(processed.lat).toBeGreaterThan(BASE.lat);
    expect(processed.lat).toBeLessThan(f.lat);
    expect(processed.lat).toBeCloseTo(BASE.lat + (f.lat - BASE.lat) * MOVING_SMOOTHING_ALPHA, 10);
  });

  test('getProcessedLocation settles to a small steady-state lag on a straight constant-speed line', () => {
    // EMA lag behind a constant step size converges to step * (1-alpha)/alpha - for a 50m step
    // and alpha=0.8 that's 50 * 0.25 = 12.5m, small relative to the 50m step itself (stays
    // responsive) while still damping any single noisy fix (see the sideways-jump test above).
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10));
    state = processLocationFix(state, fix(50, 0, 10, { speed: 2 }));
    state = processLocationFix(state, fix(100, 0, 10, { speed: 2 }));
    const f = fix(150, 0, 10, { speed: 2 });
    state = processLocationFix(state, f);
    const processed = getProcessedLocation(state);
    const expectedSteadyStateLagM = 50 * (1 - MOVING_SMOOTHING_ALPHA) / MOVING_SMOOTHING_ALPHA;
    expect(haversineDistanceMeters(processed, f)).toBeCloseTo(expectedSteadyStateLagM, 0);
  });

  test('getDistanceFromAnchorM is 0 when there is no anchor (MOVING)', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10));
    const f = fix(50, 0, 10, { speed: 2 });
    state = processLocationFix(state, f);
    expect(getDistanceFromAnchorM(state, f)).toBe(0);
  });

  test('getDistanceFromAnchorM reflects distance to the anchor while STATIONARY', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 19));
    const f = fix(-9, -3, 35);
    state = processLocationFix(state, f);
    expect(getDistanceFromAnchorM(state, f)).toBeGreaterThan(0);
    expect(getDistanceFromAnchorM(state, f)).toBeLessThan(20);
  });

  test('12a. RN fixture parity case - stationary cluster', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 19));
    state = processLocationFix(state, fix(-9, -3, 35));
    state = processLocationFix(state, fix(-10, -5, 36));
    state = processLocationFix(state, fix(-13, 3, 41));
    expect(state.state).toBe('STATIONARY');
    expect(state.anchor).not.toBeNull();
  });

  test('a single sideways GPS jump while MOVING is damped, not fully followed', () => {
    // Straight-line road: A -> B -> C -> D, but the raw GPS fix at C jumps 30m sideways.
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 10)); // A (anchor)
    state = processLocationFix(state, fix(50, 0, 10, { speed: 2 })); // B - confirms MOVING
    state = processLocationFix(state, fix(100, 0, 10, { speed: 2 })); // still on the line
    const cRaw = fix(150, 30, 10, { speed: 2 }); // C - raw fix jumps 30m sideways (east)
    state = processLocationFix(state, cRaw);
    const processedC = getProcessedLocation(state);
    // Damped: processed point is closer to the straight line (lon ~0) than the raw 30m sideways jump.
    const lonOffsetFromLineRaw = Math.abs(cRaw.lon - BASE.lon);
    const lonOffsetFromLineProcessed = Math.abs(processedC.lon - BASE.lon);
    expect(lonOffsetFromLineProcessed).toBeLessThan(lonOffsetFromLineRaw);
    expect(lonOffsetFromLineProcessed).toBeGreaterThan(0); // still responsive, not ignored entirely
  });

  test('a low-accuracy sideways jump while MOVING is damped harder than the same jump at good accuracy', () => {
    // Same road, same forward+sideways jump at C (large enough that both accuracy values still
    // route through the same "still moving" branch, not CONFIRMING_STOP - isolates the blend
    // weighting itself). A degraded fix (field-observed: an 85m-accuracy reading during a real
    // walk pulled the processed trail 251m off anchor) must be trusted less than a normal one,
    // not blended in at the same fixed rate regardless of how uncertain the raw measurement was.
    function sidewaysJumpOffset(cAccuracy) {
      let state = createInitialMovementState();
      state = processLocationFix(state, fix(0, 0, 10)); // anchor
      state = processLocationFix(state, fix(50, 0, 10, { speed: 2 })); // confirms MOVING
      state = processLocationFix(state, fix(100, 0, 10, { speed: 2 })); // lastMovingFix
      state = processLocationFix(state, fix(250, 30, cAccuracy, { speed: 2 })); // forward+sideways jump
      expect(state.state).toBe('MOVING'); // same branch for every accuracy tested below
      return Math.abs(getProcessedLocation(state).lon - BASE.lon);
    }
    const goodAccuracyOffset = sidewaysJumpOffset(10);
    const badAccuracyOffset = sidewaysJumpOffset(85);
    expect(badAccuracyOffset).toBeLessThan(goodAccuracyOffset);
  });
});

describe('sanitizeAccuracy (Change 7 - accuracy edge-case hardening)', () => {
  test('valid accuracy passes through unchanged (above the floor)', () => {
    expect(sanitizeAccuracy(19)).toBe(19);
    expect(sanitizeAccuracy(500)).toBe(500);
  });

  test('zero, negative, null, undefined, NaN, and Infinity all fall back to the invalid-accuracy value', () => {
    expect(sanitizeAccuracy(0)).toBe(INVALID_ACCURACY_FALLBACK_M);
    expect(sanitizeAccuracy(-5)).toBe(INVALID_ACCURACY_FALLBACK_M);
    expect(sanitizeAccuracy(null)).toBe(INVALID_ACCURACY_FALLBACK_M);
    expect(sanitizeAccuracy(undefined)).toBe(INVALID_ACCURACY_FALLBACK_M);
    expect(sanitizeAccuracy(NaN)).toBe(INVALID_ACCURACY_FALLBACK_M);
    expect(sanitizeAccuracy(Infinity)).toBe(INVALID_ACCURACY_FALLBACK_M);
  });

  test('implausibly tiny accuracy is floored, not trusted as super-precise', () => {
    expect(sanitizeAccuracy(0.0001)).toBe(MIN_ACCURACY_FLOOR_M);
  });

  test('foldFixIntoAnchor never divides by zero or produces NaN for any invalid accuracy', () => {
    for (const badAccuracy of [0, -1, null, undefined, NaN, Infinity]) {
      const anchor = foldFixIntoAnchor(null, { lat: 1, lon: 2, accuracy: badAccuracy });
      expect(Number.isFinite(anchor.lat)).toBe(true);
      expect(Number.isFinite(anchor.lon)).toBe(true);
      expect(Number.isFinite(anchor.accuracy)).toBe(true);
      expect(Number.isFinite(anchor.totalWeight)).toBe(true);
    }
  });

  test('processLocationFix does not throw or misclassify on a fix with invalid accuracy', () => {
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 19));
    // A fix with NaN accuracy right next to the anchor must still be treated as noise, not as
    // movement (an unsanitized NaN would poison Math.max()/the threshold comparison and could
    // make every such fix look like a "candidate" regardless of actual distance).
    state = processLocationFix(state, { ...fix(1, 1, 19), accuracy: NaN });
    expect(state.state).toBe('STATIONARY');
  });
});

describe('blendPoint', () => {
  test('alpha=0 stays at prev, alpha=1 jumps fully to next', () => {
    const prev = { lat: 0, lon: 0 };
    const next = { lat: 10, lon: 20 };
    expect(blendPoint(prev, next, 0)).toEqual({ lat: 0, lon: 0 });
    expect(blendPoint(prev, next, 1)).toEqual({ lat: 10, lon: 20 });
  });

  test('alpha=0.5 is the midpoint', () => {
    const prev = { lat: 0, lon: 0 };
    const next = { lat: 10, lon: 20 };
    expect(blendPoint(prev, next, 0.5)).toEqual({ lat: 5, lon: 10 });
  });
});

describe('getLocationQuality (Change 2 - not a re-statement of accuracy in meters)', () => {
  test('high-accuracy fix scores high', () => {
    const state = { state: 'STATIONARY' };
    expect(getLocationQuality(state, { accuracy: 5 })).toBeGreaterThanOrEqual(90);
  });

  test('low-accuracy (but still stored) fix scores low, not zero unless very bad', () => {
    const state = { state: 'STATIONARY' };
    const q60 = getLocationQuality(state, { accuracy: 60 });
    expect(q60).toBeGreaterThan(0);
    expect(q60).toBeLessThan(50);
  });

  test('invalid accuracy scores 0, never fake-precise', () => {
    const state = { state: 'STATIONARY' };
    expect(getLocationQuality(state, { accuracy: null })).toBe(0);
    expect(getLocationQuality(state, { accuracy: NaN })).toBe(0);
  });

  test('very large accuracy clamps to 0, never negative', () => {
    const state = { state: 'STATIONARY' };
    expect(getLocationQuality(state, { accuracy: 100000 })).toBe(0);
  });

  test('unconfirmed states (CONFIRMING_MOVEMENT/CONFIRMING_STOP) score lower than an equally-accurate confirmed state', () => {
    const confirmed = getLocationQuality({ state: 'STATIONARY' }, { accuracy: 20 });
    const confirming = getLocationQuality({ state: 'CONFIRMING_MOVEMENT' }, { accuracy: 20 });
    expect(confirming).toBeLessThan(confirmed);
  });

  test('a stable anchor built from 40m-accuracy fixes still only scores like a 40m fix', () => {
    // Processing does not invent physical precision the raw measurement never had.
    let state = createInitialMovementState();
    state = processLocationFix(state, fix(0, 0, 40));
    state = processLocationFix(state, fix(2, 2, 40));
    state = processLocationFix(state, fix(-2, -2, 40));
    const quality = getLocationQuality(state, { accuracy: 40 });
    expect(quality).toBeLessThan(70);
  });
});

describe('wantsHighAccuracy (Change 4)', () => {
  test('MOVING, CONFIRMING_MOVEMENT, CONFIRMING_STOP all want high accuracy', () => {
    expect(wantsHighAccuracy({ state: 'MOVING' })).toBe(true);
    expect(wantsHighAccuracy({ state: 'CONFIRMING_MOVEMENT' })).toBe(true);
    expect(wantsHighAccuracy({ state: 'CONFIRMING_STOP' })).toBe(true);
  });

  test('STATIONARY does not need high accuracy', () => {
    expect(wantsHighAccuracy({ state: 'STATIONARY' })).toBe(false);
  });
});

describe('computePollingIntervalMs', () => {
  test('MOVING uses the moving tier regardless of stationarySinceMs', () => {
    const state = { state: 'MOVING', stationarySinceMs: null };
    expect(computePollingIntervalMs(state, 1000, 'foreground')).toBe(MOVING_INTERVAL_FOREGROUND_MS);
    expect(computePollingIntervalMs(state, 1000, 'background')).toBe(MOVING_INTERVAL_BACKGROUND_MS);
  });

  test('CONFIRMING_MOVEMENT and CONFIRMING_STOP also use the moving tier', () => {
    expect(computePollingIntervalMs({ state: 'CONFIRMING_MOVEMENT' }, 1000, 'foreground')).toBe(
      MOVING_INTERVAL_FOREGROUND_MS
    );
    expect(computePollingIntervalMs({ state: 'CONFIRMING_STOP' }, 1000, 'background')).toBe(
      MOVING_INTERVAL_BACKGROUND_MS
    );
  });

  test('freshly-settled STATIONARY uses the short stationary tier', () => {
    const state = { state: 'STATIONARY', stationarySinceMs: 1000 };
    const now = 1000 + 60000; // 1 min stationary
    expect(computePollingIntervalMs(state, now, 'foreground')).toBe(STATIONARY_INTERVAL_FOREGROUND_MS);
    expect(computePollingIntervalMs(state, now, 'background')).toBe(STATIONARY_INTERVAL_BACKGROUND_MS);
  });

  test('long-settled STATIONARY (>=5min) uses the long stationary tier', () => {
    const state = { state: 'STATIONARY', stationarySinceMs: 1000 };
    const now = 1000 + LONG_STATIONARY_THRESHOLD_MS;
    expect(computePollingIntervalMs(state, now, 'foreground')).toBe(LONG_STATIONARY_INTERVAL_FOREGROUND_MS);
    expect(computePollingIntervalMs(state, now, 'background')).toBe(LONG_STATIONARY_INTERVAL_BACKGROUND_MS);
  });

  test('STATIONARY with no stationarySinceMs yet treated as just-settled', () => {
    const state = { state: 'STATIONARY', stationarySinceMs: null };
    expect(computePollingIntervalMs(state, 999999, 'foreground')).toBe(STATIONARY_INTERVAL_FOREGROUND_MS);
  });
});

describe('PROCESSING_VERSION (Round 3, item 6)', () => {
  test('is tagged as version 2', () => {
    expect(PROCESSING_VERSION).toBe(2);
  });
});

describe('computeFixMetrics (Round 3, item 5 - internal reuse, not a behavior change)', () => {
  test('matches haversineDistanceMeters/computeNoiseThresholdM computed separately', () => {
    const anchor = { lat: BASE.lat, lon: BASE.lon, accuracy: 20 };
    const f = fix(30, 0, 10);
    const metrics = computeFixMetrics(anchor, f);
    expect(metrics.distanceM).toBeCloseTo(haversineDistanceMeters(anchor, f), 10);
    expect(metrics.thresholdM).toBe(computeNoiseThresholdM(anchor.accuracy, f.accuracy));
  });

  test('sanitizes the fix accuracy before computing the threshold', () => {
    const anchor = { lat: BASE.lat, lon: BASE.lon, accuracy: 20 };
    const f = { ...fix(30, 0, 10), accuracy: NaN };
    const metrics = computeFixMetrics(anchor, f);
    expect(metrics.thresholdM).toBe(computeNoiseThresholdM(anchor.accuracy, INVALID_ACCURACY_FALLBACK_M));
  });
});
