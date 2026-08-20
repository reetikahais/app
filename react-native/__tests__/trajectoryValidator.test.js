import {
  classifyFix,
  createInitialTrajectoryState,
  sortFixesByTimestamp,
  TRAJECTORY_DECISION,
  OUTLIER_REASON,
  MOVEMENT_MODE,
  STALE_ANCHOR_THRESHOLD_MS,
  UNCERTAIN_CONFIRM_TIMEOUT_FIXES,
} from '../trajectoryValidator';

const BASE = { lat: 31.4440206, lon: 77.0467109 };
const METERS_PER_DEG_LAT = 111320;

function offset(base, dNorthM, dEastM) {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180);
  return {
    lat: base.lat + dNorthM / METERS_PER_DEG_LAT,
    lon: base.lon + dEastM / metersPerDegLon,
  };
}

function fixAt(dNorthM, dEastM, timestampMs, opts = {}) {
  const pos = offset(BASE, dNorthM, dEastM);
  return { lat: pos.lat, lon: pos.lon, accuracy: opts.accuracy ?? 10, speed: opts.speed ?? null, timestampMs };
}

// Drives `count` accepted fixes due north at `speedMps`, `dtSec` apart, to warm up mode
// inference (Step7 hysteresis needs MODE_SWITCH_CONFIRM_COUNT consecutive supporting fixes)
// before testing a mode-specific scenario.
function warmUp(state, distanceM, timeMs, count, speedMps, dtSec) {
  let s = state;
  let dist = distanceM;
  let t = timeMs;
  for (let i = 0; i < count; i++) {
    dist += speedMps * dtSec;
    t += dtSec * 1000;
    const { newState, result } = classifyFix(s, fixAt(dist, 0, t, { speed: speedMps }));
    expect(result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    s = newState;
  }
  return { state: s, distanceM: dist, timeMs: t };
}

describe('bootstrap', () => {
  test('first-ever fix is always ACCEPTED (nothing to compare against)', () => {
    const { result } = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    expect(result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
  });
});

describe('walking mode', () => {
  function walkingState() {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    return warmUp(boot.newState, 0, 0, 3, 1.2, 10);
  }

  test('10m/10s accepted', () => {
    const { state, distanceM, timeMs } = walkingState();
    const { result } = classifyFix(state, fixAt(distanceM + 10, 0, timeMs + 10000, { speed: 1 }));
    expect(result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(result.movementMode).toBe(MOVEMENT_MODE.WALKING);
  });

  test('20m/10s still plausible, not an outlier', () => {
    const { state, distanceM, timeMs } = walkingState();
    const { result } = classifyFix(state, fixAt(distanceM + 20, 0, timeMs + 10000, { speed: 2 }));
    expect(result.decision).not.toBe(TRAJECTORY_DECISION.OUTLIER);
  });

  test('300m/10s is an outlier (impossible speed for a walking trail)', () => {
    const { state, distanceM, timeMs } = walkingState();
    const { result } = classifyFix(state, fixAt(distanceM + 300, 0, timeMs + 10000, { speed: 30 }));
    expect(result.decision).toBe(TRAJECTORY_DECISION.OUTLIER);
    expect(result.reason).toBe(OUTLIER_REASON.IMPOSSIBLE_SPEED);
  });
});

describe('cycling mode', () => {
  function cyclingState() {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    return warmUp(boot.newState, 0, 0, 3, 5, 10);
  }

  test('50m/10s accepted', () => {
    const { state, distanceM, timeMs } = cyclingState();
    const { result } = classifyFix(state, fixAt(distanceM + 50, 0, timeMs + 10000, { speed: 5 }));
    expect(result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
  });

  test('150m/10s potentially accepted, not an outlier', () => {
    const { state, distanceM, timeMs } = cyclingState();
    const { result } = classifyFix(state, fixAt(distanceM + 150, 0, timeMs + 10000, { speed: 15 }));
    expect(result.decision).not.toBe(TRAJECTORY_DECISION.OUTLIER);
  });
});

describe('car mode', () => {
  function carState() {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    return warmUp(boot.newState, 0, 0, 3, 20, 10);
  }

  test('200m/10s accepted', () => {
    const { state, distanceM, timeMs } = carState();
    const { result } = classifyFix(state, fixAt(distanceM + 200, 0, timeMs + 10000, { speed: 20 }));
    expect(result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(result.movementMode).toBe(MOVEMENT_MODE.VEHICLE);
  });

  test('500m/10s potentially accepted, not an outlier', () => {
    const { state, distanceM, timeMs } = carState();
    const { result } = classifyFix(state, fixAt(distanceM + 500, 0, timeMs + 10000, { speed: 50 }));
    expect(result.decision).not.toBe(TRAJECTORY_DECISION.OUTLIER);
  });
});

describe('GPS jump / outlier poisoning', () => {
  function baseWalk() {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const warmed = warmUp(boot.newState, 0, 0, 3, 1.2, 10);
    const fB = fixAt(warmed.distanceM + 12, 0, warmed.timeMs + 10000, { speed: 1.2 });
    const { newState: stateB } = classifyFix(warmed.state, fB);
    return { stateB, distanceM: warmed.distanceM + 12, timeMs: warmed.timeMs + 10000 };
  }

  test('good, good, 300m jump, good - jump never enters the trail, recovery resumes off the last accepted fix', () => {
    const { stateB, distanceM, timeMs } = baseWalk();

    const fC = fixAt(distanceM + 300, 0, timeMs + 10000, { speed: 30 });
    const { newState: stateC, result: resultC } = classifyFix(stateB, fC);
    expect(resultC.decision).toBe(TRAJECTORY_DECISION.OUTLIER);
    expect(stateC.lastAcceptedFix).toEqual(stateB.lastAcceptedFix);

    const fD = fixAt(distanceM + 12, 0, timeMs + 20000, { speed: 1.2 });
    const { result: resultD } = classifyFix(stateC, fD);
    expect(resultD.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
  });

  test('outlier poisoning: two consecutive outliers never become the reference - E is compared to B', () => {
    const { stateB, distanceM, timeMs } = baseWalk();

    const fC = fixAt(distanceM + 300, 0, timeMs + 10000, { speed: 30 });
    const { newState: stateC } = classifyFix(stateB, fC);

    const fD = fixAt(distanceM + 600, 0, timeMs + 20000, { speed: 30 });
    const { newState: stateD, result: resultD } = classifyFix(stateC, fD);
    expect(resultD.decision).toBe(TRAJECTORY_DECISION.OUTLIER);
    expect(stateD.lastAcceptedFix).toEqual(stateB.lastAcceptedFix);

    // If compared to D (600m away) this would be a huge implausible jump; compared to B it's a
    // normal, plausible walking step.
    const fE = fixAt(distanceM + 24, 0, timeMs + 30000, { speed: 1.2 });
    const { result: resultE } = classifyFix(stateD, fE);
    expect(resultE.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
  });
});

describe('sharp legitimate turn', () => {
  test('a sharp turn with consistent speed/displacement is not auto-rejected', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const warmed = warmUp(boot.newState, 0, 0, 3, 5, 10);
    const fPrev = fixAt(warmed.distanceM + 50, 0, warmed.timeMs + 10000, { speed: 5 });
    const { newState: stateWithPrev } = classifyFix(warmed.state, fPrev);

    // 90-degree turn east, same distance/speed as the preceding segments - a real intersection.
    const turnFix = fixAt(warmed.distanceM + 50, 50, warmed.timeMs + 20000, { speed: 5 });
    const { result } = classifyFix(stateWithPrev, turnFix);
    expect(result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
  });
});

describe('accuracy-aware plausibility (Step10)', () => {
  test('poor-accuracy distant fix widens the band instead of being outright rejected', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0, { accuracy: 10 }));
    const noisy = fixAt(50, 0, 10000, { accuracy: 300 });
    const { result } = classifyFix(boot.newState, noisy);
    expect(result.decision).not.toBe(TRAJECTORY_DECISION.OUTLIER);
  });
});

describe('duplicate/out-of-order timestamps (Step3)', () => {
  test('a fix at or before lastAcceptedFix.timestampMs is rejected, anchor untouched', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 1000));
    const { newState, result } = classifyFix(boot.newState, fixAt(5, 0, 1000));
    expect(result.decision).toBe(TRAJECTORY_DECISION.OUTLIER);
    expect(result.reason).toBe(OUTLIER_REASON.DUPLICATE_OR_OUT_OF_ORDER);
    expect(newState.lastAcceptedFix).toEqual(boot.newState.lastAcceptedFix);
  });

  test('sortFixesByTimestamp sorts a batch ascending regardless of delivery order', () => {
    const sorted = sortFixesByTimestamp([fixAt(0, 0, 3000), fixAt(0, 0, 1000), fixAt(0, 0, 2000)]);
    expect(sorted.map((f) => f.timestampMs)).toEqual([1000, 2000, 3000]);
  });

  test('background batch: an out-of-order array is processed chronologically once sorted', () => {
    const raw = [fixAt(20, 0, 2000, { speed: 2 }), fixAt(0, 0, 0), fixAt(10, 0, 1000, { speed: 1 })];
    let state = createInitialTrajectoryState();
    const decisions = [];
    for (const f of sortFixesByTimestamp(raw)) {
      const { newState, result } = classifyFix(state, f);
      decisions.push(result.decision);
      state = newState;
    }
    expect(decisions).toEqual([TRAJECTORY_DECISION.ACCEPTED, TRAJECTORY_DECISION.ACCEPTED, TRAJECTORY_DECISION.ACCEPTED]);
  });
});

describe('false movement transition guard (Step13)', () => {
  test('OUTLIER decisions never advance lastAcceptedFix, so a single bad fix cannot move the trail', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { newState, result } = classifyFix(boot.newState, fixAt(5000, 0, 10000, { speed: 500 }));
    expect(result.decision).toBe(TRAJECTORY_DECISION.OUTLIER);
    expect(newState.lastAcceptedFix).toEqual(boot.newState.lastAcceptedFix);
  });
});

describe('UNCERTAIN resolution (Step12)', () => {
  function walkingAnchor() {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    return warmUp(boot.newState, 0, 0, 3, 1.2, 10);
  }

  test('an UNCERTAIN fix confirmed by the next fix is accepted and re-anchors to the newer fix', () => {
    const { state, distanceM, timeMs } = walkingAnchor();
    const uncertain = fixAt(distanceM + 85, 0, timeMs + 10000, { speed: 8.5 });
    const r1 = classifyFix(state, uncertain);
    expect(r1.result.decision).toBe(TRAJECTORY_DECISION.UNCERTAIN);
    expect(r1.newState.lastAcceptedFix).toEqual(state.lastAcceptedFix);

    const confirming = fixAt(distanceM + 90, 0, timeMs + 15000, { speed: 1 });
    const r2 = classifyFix(r1.newState, confirming);
    expect(r2.result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(r2.result.reason).toBe(OUTLIER_REASON.UNCERTAIN_CONFIRMED);
    expect(r2.newState.lastAcceptedFix.lat).toBeCloseTo(confirming.lat, 9);
    expect(r2.newState.pendingUncertain).toBeNull();
  });

  test('an UNCERTAIN fix followed by a fix consistent with the OLD anchor is discarded as an isolated blip', () => {
    const { state, distanceM, timeMs } = walkingAnchor();
    const blip = fixAt(distanceM + 85, 0, timeMs + 10000, { speed: 8.5 });
    const r1 = classifyFix(state, blip);
    expect(r1.result.decision).toBe(TRAJECTORY_DECISION.UNCERTAIN);

    // Back to a normal walking step from the OLD anchor - the blip was noise, not real movement.
    const backToNormal = fixAt(distanceM + 11, 0, timeMs + 20000, { speed: 1.1 });
    const r2 = classifyFix(r1.newState, backToNormal);
    expect(r2.result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(r2.newState.pendingUncertain).toBeNull();
    // Anchored off the old reference, not the discarded blip.
    expect(r2.newState.prevAcceptedFix).toEqual(state.lastAcceptedFix);
  });

  test('an UNCERTAIN fix never confirmed within the timeout is dropped from the pending buffer', () => {
    const { state, distanceM, timeMs } = walkingAnchor();
    const originalUncertainT = timeMs + 10000;
    let cur = classifyFix(state, fixAt(distanceM + 85, 0, originalUncertainT, { speed: 8.5 }));
    expect(cur.result.decision).toBe(TRAJECTORY_DECISION.UNCERTAIN);
    expect(cur.newState.pendingUncertain.fix.timestampMs).toBe(originalUncertainT);

    // Neither confirms the pending fix nor matches the old anchor - repeated ambiguous fixes.
    for (let i = 0; i < UNCERTAIN_CONFIRM_TIMEOUT_FIXES + 1; i++) {
      cur = classifyFix(cur.newState, fixAt(distanceM + 85 + (i + 1) * 40, 0, timeMs + 10000 + (i + 1) * 3000, { speed: 13 }));
    }
    // The original pending fix must have been dropped by now (timeout exceeded) - whatever (if
    // anything) is pending now is not the fix that first went UNCERTAIN.
    if (cur.newState.pendingUncertain) {
      expect(cur.newState.pendingUncertain.fix.timestampMs).not.toBe(originalUncertainT);
    }
  });
});

describe('stale-anchor recovery (Step8)', () => {
  test('a long gap followed by two mutually consistent fixes re-anchors instead of staying stuck', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const state = boot.newState;

    const staleT = STALE_ANCHOR_THRESHOLD_MS + 5000;
    const candidate = fixAt(2000, 0, staleT, { speed: 5 });
    const r1 = classifyFix(state, candidate);
    expect(r1.result.decision).toBe(TRAJECTORY_DECISION.UNCERTAIN);
    expect(r1.result.reason).toBe(OUTLIER_REASON.STALE_ANCHOR_RECOVERING);
    expect(r1.newState.lastAcceptedFix).toEqual(state.lastAcceptedFix);

    const confirm = fixAt(2010, 0, staleT + 5000, { speed: 2 });
    const r2 = classifyFix(r1.newState, confirm);
    expect(r2.result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(r2.result.reason).toBe(OUTLIER_REASON.STALE_ANCHOR_REANCHORED);
    expect(r2.newState.lastAcceptedFix.lat).toBeCloseTo(confirm.lat, 9);
    expect(r2.newState.pendingUncertain).toBeNull();
  });

  test('N consecutive OUTLIER/UNCERTAIN fixes also trigger stale recovery even before the time threshold', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    let cur = boot;
    // Three wild jumps in a row (each compared to the original anchor, each rejected).
    for (let i = 0; i < 3; i++) {
      cur = classifyFix(cur.newState, fixAt(5000 + i * 10, 0, (i + 1) * 10000, { speed: 500 }));
    }
    expect(cur.newState.outlierStreak).toBeGreaterThanOrEqual(3);

    // Next fix should now enter stale-recovery (compared to nothing, held as a fresh candidate)
    // rather than being judged against the long-abandoned original anchor.
    const next = classifyFix(cur.newState, fixAt(9000, 0, 40000, { speed: 5 }));
    expect(next.result.decision).toBe(TRAJECTORY_DECISION.UNCERTAIN);
    expect(next.result.reason).toBe(OUTLIER_REASON.STALE_ANCHOR_RECOVERING);
  });
});

describe('mode inference hysteresis (Step7)', () => {
  test('mode never switches on a single fix', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { newState } = classifyFix(boot.newState, fixAt(50, 0, 10000, { speed: 5 }));
    expect(newState.mode).toBe(MOVEMENT_MODE.UNKNOWN);
  });

  test('mode confirms WALKING after MODE_SWITCH_CONFIRM_COUNT consistent fixes', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { state } = warmUp(boot.newState, 0, 0, 3, 1.2, 10);
    expect(state.mode).toBe(MOVEMENT_MODE.WALKING);
  });
});
