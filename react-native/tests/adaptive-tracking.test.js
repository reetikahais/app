const test = require('node:test');
const assert = require('node:assert/strict');
const { processLocations, fromLocalMeters } = require('../processing');

const base = 1700000000000;
const origin = { latitude: 31.05, longitude: 77.05 };

// Straight-line synthetic drive: `speedMps` due east, `stepMs` apart, starting at (0,0) local
// meters relative to `origin`. `overrides` can set accuracy/speed_mps/bearing_deg per point index.
function drive(count, speedMps, stepMs, { accuracy = 5, reportSpeed = false, startIndex = 1, jitter = 0 } = {}) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const east = speedMps * (stepMs / 1000) * i + (jitter ? (i % 2 === 0 ? jitter : -jitter) : 0);
    const point = fromLocalMeters(east, 0, origin);
    points.push({
      id: startIndex + i,
      timestamp: base + i * stepMs,
      received_timestamp_ms: base + i * stepMs,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy,
      method: 'fused',
      speed_mps: reportSpeed ? speedMps : null,
    });
  }
  return points;
}

test('walking: steady 1.4 m/s with good GPS is accepted under the walk profile', () => {
  const points = drive(6, 1.4, 2000, { accuracy: 10 });
  const result = processLocations(points, { userSelectedMode: 'walk', nowMs: base + 12000 });
  assert.ok(result.slice(1).every((row) => row.trajectory_decision === 'ACCEPTED'));
  assert.ok(result.every((row) => row.effective_mode === 'walk'));
});

test('bicycle: 5-10 m/s is accepted under the bicycle profile without escalating', () => {
  const points = drive(10, 7, 1000, { accuracy: 8 });
  const result = processLocations(points, { userSelectedMode: 'bicycle', nowMs: base + 10000 });
  assert.ok(result.slice(1).every((row) => row.trajectory_decision === 'ACCEPTED'));
  assert.ok(result.every((row) => row.effective_mode === 'bicycle'));
});

test('fast bicycle: a brief 15-20 m/s burst does not collapse the route or switch mode from one sample', () => {
  const points = drive(8, 18, 1000, { accuracy: 6, reportSpeed: true });
  const result = processLocations(points, { userSelectedMode: 'bicycle', nowMs: base + 8000 });
  assert.ok(result.filter((row) => row.trajectory_decision === 'ACCEPTED').length >= 6,
    'a brief fast burst must not collapse the route into rejected outliers');
  // 18 m/s exceeds the 18 m/s escalation threshold only at the boundary and for under 15s, so it
  // must never switch mode from a single sample this early.
  assert.equal(result[1].effective_mode, 'bicycle');
});

test('bicycle selected at vehicle speed: userSelectedMode never changes; effectiveTrackingMode escalates to motorbike after 15s+', () => {
  const points = drive(25, 22, 1000, { accuracy: 6, reportSpeed: true });
  const result = processLocations(points, { userSelectedMode: 'bicycle', nowMs: base + 25000 });
  assert.ok(result.every((row) => row.user_selected_mode === 'bicycle'), 'the user\'s original selection must never be overwritten');
  assert.equal(result.at(-1).effective_mode, 'motorbike', 'sustained 22 m/s for 20+ seconds must escalate the effective mode to motorbike');
  assert.ok(result.some((row) => row.mode_switch_event === 'PROFILE_ESCALATED'));
});

test('motorbike highway: 20-30 m/s at 1s intervals with good accuracy and a stable heading is accepted with no permanent outlier lockout', () => {
  const phase1 = drive(6, 20, 1000, { accuracy: 4, reportSpeed: true });
  const phase1EndEast = 20 * 5; // drive() places point i at speed*i seconds east
  const phase2 = [];
  for (let i = 1; i <= 6; i += 1) {
    const point = fromLocalMeters(phase1EndEast + 30 * i, 0, origin);
    phase2.push({
      id: 100 + i,
      timestamp: base + 5000 + i * 1000,
      received_timestamp_ms: base + 5000 + i * 1000,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: 4,
      method: 'fused',
      speed_mps: 30,
    });
  }
  const points = [...phase1, ...phase2];
  const result = processLocations(points, { userSelectedMode: 'motorbike', nowMs: base + 12000 });
  // The 20 -> 30 m/s step is a genuinely hard acceleration (10 m/s^2, above motorbike's own
  // maxAccelerationMps2 ceiling) and may briefly read UNCERTAIN — that's a correct confidence
  // signal, not a rejection. What must never happen is a hard OUTLIER/lockout on a clean highway
  // trace with good accuracy and agreeing GPS speed throughout.
  assert.ok(result.every((row) => row.trajectory_decision !== 'OUTLIER'), 'a stable highway trace must not produce any outliers');
  assert.equal(result.at(-1).trajectory_decision, 'ACCEPTED');
});

test('car highway: 30-45 m/s is accepted under the car profile', () => {
  const points = drive(10, 38, 1000, { accuracy: 5, reportSpeed: true });
  const result = processLocations(points, { userSelectedMode: 'car', nowMs: base + 10000 });
  assert.ok(result.slice(1).every((row) => row.trajectory_decision === 'ACCEPTED'));
});

test('delayed high-speed sample (~115m/4.95s, GPS speed agrees, stable heading) is HIGH_SPEED_CONTINUITY_ACCEPT, not EXCESSIVE_DISPLACEMENT', () => {
  const steady = drive(5, 5, 1000, { accuracy: 5, reportSpeed: true }); // establishes recentMedianSpeed ~5 m/s
  const lastSteady = steady.at(-1);
  const delayedEast = 5 * 4 + 112.8; // continues east from the last steady point
  const delayedPoint = fromLocalMeters(delayedEast, 0, origin);
  const delayed = {
    id: 999,
    timestamp: lastSteady.timestamp + 4950,
    received_timestamp_ms: lastSteady.timestamp + 4950,
    latitude: delayedPoint.latitude,
    longitude: delayedPoint.longitude,
    accuracy: 5,
    method: 'fused',
    speed_mps: 22.3,
  };
  const result = processLocations([...steady, delayed], { userSelectedMode: 'bicycle', nowMs: delayed.timestamp });
  const last = result.at(-1);
  assert.equal(last.trajectory_decision, 'ACCEPTED');
  assert.equal(last.trajectory_reason, 'HIGH_SPEED_CONTINUITY_ACCEPT');
  assert.equal(last.high_speed_override, 1);
  assert.notEqual(last.trajectory_reason, 'EXCESSIVE_DISPLACEMENT');
});

test('false rejection recovery: a sustained real trajectory recovers within 3 buffered candidate points instead of locking out forever', () => {
  const baseline = drive(3, 2, 1000, { accuracy: 3 }); // slow baseline establishing lastAcceptedFix
  const lastBaseline = baseline.at(-1);
  const burstStartEast = 2 * 2; // continue from baseline's last position
  const burst = [];
  for (let i = 1; i <= 5; i += 1) {
    const east = burstStartEast + 45 * i; // 45 m/s burst, no reported speed (worst case for continuity accept)
    const point = fromLocalMeters(east, 0, origin);
    burst.push({
      id: 100 + i,
      timestamp: lastBaseline.timestamp + i * 1000,
      received_timestamp_ms: lastBaseline.timestamp + i * 1000,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: 3,
      method: 'fused',
      speed_mps: null,
    });
  }
  const tail = [];
  for (let i = 1; i <= 3; i += 1) {
    const east = burstStartEast + 45 * 5 + 45 * i;
    const point = fromLocalMeters(east, 0, origin);
    tail.push({
      id: 200 + i,
      timestamp: burst.at(-1).timestamp + i * 1000,
      received_timestamp_ms: burst.at(-1).timestamp + i * 1000,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: 3,
      method: 'fused',
      speed_mps: null,
    });
  }
  const result = processLocations([...baseline, ...burst, ...tail], { userSelectedMode: 'motorbike', nowMs: tail.at(-1).timestamp });
  const burstResults = result.slice(baseline.length, baseline.length + burst.length);
  const firstRejected = burstResults.filter((row) => row.trajectory_decision === 'OUTLIER');
  assert.ok(firstRejected.length >= 1 && firstRejected.length <= 2,
    'the burst should be rejected briefly before recovery confirms, not for its whole length');
  assert.ok(burstResults.some((row) => row.trajectory_reason === 'RECOVERY_CONFIRMED'));
  const confirmedIndex = burstResults.findIndex((row) => row.trajectory_reason === 'RECOVERY_CONFIRMED');
  assert.ok(confirmedIndex >= 0 && confirmedIndex <= 4, 'recovery must be confirmed within the first few candidate points, not never');
  // Every point after recovery (including the tail) must keep being accepted normally — no
  // permanent lockout comparing forever against the stale pre-burst reference.
  const tailResults = result.slice(-tail.length);
  assert.ok(tailResults.every((row) => row.trajectory_decision === 'ACCEPTED'));
});

test('GPS teleport is still rejected: 500m in 1s at a reported 8 m/s does not recover', () => {
  const baseline = drive(3, 1, 1000, { accuracy: 5 });
  const lastBaseline = baseline.at(-1);
  const teleportPoint = fromLocalMeters(500, 0, origin);
  const teleport = {
    id: 500,
    timestamp: lastBaseline.timestamp + 1000,
    received_timestamp_ms: lastBaseline.timestamp + 1000,
    latitude: teleportPoint.latitude,
    longitude: teleportPoint.longitude,
    accuracy: 5,
    method: 'fused',
    speed_mps: 8,
  };
  const after = drive(2, 1, 1000, { accuracy: 5, startIndex: 600 })
    .map((p, i) => ({ ...p, timestamp: teleport.timestamp + 1000 + i * 1000, received_timestamp_ms: teleport.timestamp + 1000 + i * 1000 }));
  const result = processLocations([...baseline, teleport, ...after], { userSelectedMode: 'walk', nowMs: after.at(-1).timestamp });
  const teleportRow = result[baseline.length];
  assert.equal(teleportRow.trajectory_decision, 'OUTLIER');
  assert.equal(teleportRow.trajectory_reason, 'IMPOSSIBLE_SPEED');
  // The point(s) after the teleport must resolve back near the ORIGINAL trajectory, not the
  // rejected teleport location.
  const lastRow = result.at(-1);
  assert.ok(Math.abs(lastRow.accepted_reference_latitude - lastBaseline.latitude) < 0.01);
});

test('traffic-light stop: an escalated motorbike effective mode is not downgraded by a stationary stop', () => {
  const escalation = drive(20, 20, 1000, { accuracy: 5, reportSpeed: true }); // 20 m/s > 18 m/s threshold, 20s+
  const lastMoving = escalation.at(-1);
  const stop = [];
  for (let i = 1; i <= 35; i += 1) {
    const point = fromLocalMeters(lastMoving ? 20 * 19 : 0, i % 2 === 0 ? 0.3 : -0.3, origin);
    stop.push({
      id: 300 + i,
      timestamp: lastMoving.timestamp + i * 1000,
      received_timestamp_ms: lastMoving.timestamp + i * 1000,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: 6,
      method: 'fused',
      speed_mps: null,
    });
  }
  const result = processLocations([...escalation, ...stop], { userSelectedMode: 'bicycle', nowMs: stop.at(-1).timestamp });
  assert.equal(result.at(-1).effective_mode, 'motorbike',
    'a 30-60s traffic-light stop must not downgrade an already-escalated effective mode');
});
