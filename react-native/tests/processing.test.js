const test = require('node:test');
const assert = require('node:assert/strict');
const {
  haversineMeters, toLocalMeters, fromLocalMeters, percentile, processLocations, routeLength,
} = require('../processing');

const base = 1700000000000;
function fix(id, offset, lat, lon, accuracy = 12, method = 'fused') {
  return {
    id,
    timestamp: base + offset,
    received_timestamp_ms: base + offset,
    latitude: lat,
    longitude: lon,
    accuracy,
    method,
  };
}

test('haversine and local coordinate conversion are reversible', () => {
  const origin = { latitude: 28.6, longitude: 77.2 };
  const point = { latitude: 28.601, longitude: 77.201 };
  const local = toLocalMeters(point.latitude, point.longitude, origin);
  const restored = fromLocalMeters(local.east, local.north, origin);
  assert.ok(haversineMeters(origin.latitude, origin.longitude, point.latitude, point.longitude) > 100);
  assert.ok(Math.abs(restored.latitude - point.latitude) < 1e-9);
  assert.ok(Math.abs(restored.longitude - point.longitude) < 1e-9);
});

test('percentile and route length are deterministic', () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5);
  assert.ok(routeLength([fix(1, 0, 28.6, 77.2), fix(2, 1000, 28.6001, 77.2)]) > 10);
});

test('retains fallback fixes but does not trust them as route vertices', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2),
    fix(2, 5000, 28.6001, 77.2001),
    fix(3, 10000, 28.6002, 77.2002, 85, 'low_accuracy_fallback'),
    fix(4, 20000, 28.6002, 77.2002, 100, 'low_accuracy_fallback'),
    fix(5, 30000, 28.6002, 77.2002, 100, 'low_accuracy_fallback'),
  ], { nowMs: base + 10000 });
  assert.equal(result.length, 5);
  assert.equal(result[2].processing_status, 'FRESH_LOW_CONFIDENCE');
  assert.equal(result[2].is_route_point, 0);
  assert.equal(result[3].is_route_point, 0);
  assert.equal(result[4].is_route_point, 0);
});

test('long gaps create a new segment and never become trusted solid vertices', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2),
    fix(2, 5000, 28.6001, 77.2001),
    fix(3, 25000, 28.6003, 77.2003),
  ], { nowMs: base + 25000 });
  assert.equal(result[2].segment_id, result[1].segment_id + 1);
  assert.equal(result[2].processing_status, 'FRESH_ACCEPTED');
  assert.equal(result[2].trajectory_decision, 'ACCEPTED');
  assert.equal(result[2].continuity_decision, 'GAP');
  assert.equal(result[2].is_route_point, 1);
});

test('first uncertain fix cannot initialize accepted smoothing state', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2, 80),
    fix(2, 5000, 28.6001, 77.2001, 12),
  ], { nowMs: base + 5000 });
  assert.equal(result[0].trajectory_decision, 'UNCERTAIN');
  assert.equal(result[0].is_route_point, 0);
  assert.equal(result[0].accepted_reference_latitude, null);
  assert.ok(Math.abs(result[1].filtered_latitude - 28.6001) < 1e-9);
  assert.ok(Math.abs(result[1].filtered_longitude - 77.2001) < 1e-9);
});

test('uncertain fixes do not create route segments', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2),
    fix(2, 5000, 28.6001, 77.2001),
    fix(3, 10000, 28.6002, 77.2002, 80),
    fix(4, 15000, 28.6003, 77.2003),
  ], { nowMs: base + 15000 });
  assert.equal(result[2].trajectory_decision, 'UNCERTAIN');
  assert.equal(result[2].segment_id, result[1].segment_id);
  assert.equal(result[3].segment_id, result[1].segment_id);
  assert.equal(result[3].continuity_decision, 'CONTINUOUS');
});

test('exact timestamp-coordinate duplicates are marked without being processed twice', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2),
    fix(2, 5000, 28.6001, 77.2001),
    fix(3, 5000, 28.6001, 77.2001),
  ], { nowMs: base + 5000 });
  assert.equal(result.length, 3);
  assert.equal(result[2].processing_status, 'DUPLICATE');
  assert.equal(result[2].is_route_point, 0);
});

test('stationary GPS jitter is suppressed instead of classified as movement', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2, 15),
    fix(2, 5000, 28.60003, 77.20003, 15),
    fix(3, 10000, 28.59998, 77.20002, 16),
    fix(4, 15000, 28.60002, 77.19998, 15),
  ], { nowMs: base + 15000 });
  assert.ok(result.every((row) => row.movement_state !== 'MOVING'));
  assert.ok(result.slice(1).every((row) => row.is_route_point === 0));
  assert.equal(result.at(-1).processing_reason, 'stationary_noise_suppressed');
});

test('movement requires corroborated evidence rather than one noisy displacement', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2, 12),
    fix(2, 5000, 28.6002, 77.2002, 12),
    fix(3, 10000, 28.6004, 77.2004, 12),
  ], { nowMs: base + 10000, movingConfirmationMs: 10000 });
  assert.equal(result[1].movement_state, 'POSSIBLY_MOVING');
  assert.equal(result[2].movement_state, 'MOVING');
});

test('rejects a jump without poisoning the accepted reference', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2),
    fix(2, 10000, 28.6001, 77.2001),
    fix(3, 20000, 28.603, 77.203),
    fix(4, 30000, 28.606, 77.206),
    fix(5, 40000, 28.6002, 77.2002),
  ]);
  assert.equal(result[2].trajectory_decision, 'OUTLIER');
  assert.equal(result[3].trajectory_decision, 'OUTLIER');
  assert.equal(result[4].trajectory_decision, 'ACCEPTED');
  assert.equal(result[4].accepted_reference_latitude, 28.6001);
});

test('missing GPS speed is unavailable rather than zero', () => {
  const result = processLocations([fix(1, 0, 28.6, 77.2), fix(2, 10000, 28.6001, 77.2001)]);
  assert.equal(result[1].reported_speed_mps, null);
});

test('long gap records gap_duration_ms; continuous fixes do not', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2),
    fix(2, 5000, 28.6001, 77.2001),
    fix(3, 25000, 28.6003, 77.2003),
  ], { nowMs: base + 25000 });
  assert.equal(result[1].gap_duration_ms, null);
  assert.equal(result[2].gap_duration_ms, 20000);
});

test('candidate confirmation: a plausible X->Y walking pace rescues a fix that looks bad from A alone', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2, 12),
    fix(2, 10000, 28.6001797, 77.2, 12),
    fix(3, 25000, 28.5995507, 77.2, 12),
    fix(4, 30000, 28.5994059, 77.2, 12),
  ], { nowMs: base + 30000 });
  assert.equal(result[2].trajectory_decision, 'UNCERTAIN');
  assert.equal(result[2].trajectory_reason, 'BEARING_INCONSISTENCY');
  assert.equal(result[3].trajectory_decision, 'ACCEPTED');
  assert.equal(result[3].trajectory_reason, 'CANDIDATE_CONFIRMED');
  assert.equal(result[3].accepted_reference_latitude, 28.6001797);
});

test('an OUTLIER never becomes a pending confirmation candidate', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2, 12),
    fix(2, 10000, 28.6001, 77.2001, 12),
    fix(3, 20000, 28.63, 77.23, 12),
    fix(4, 25000, 28.6301, 77.2301, 12),
  ], { nowMs: base + 25000 });
  assert.equal(result[2].trajectory_decision, 'OUTLIER');
  assert.equal(result[3].trajectory_decision, 'OUTLIER');
  assert.notEqual(result[3].trajectory_reason, 'CANDIDATE_CONFIRMED');
});

test('extreme physical speed ceiling cannot be bypassed by candidate confirmation', () => {
  const result = processLocations([
    fix(1, 0, 28.6, 77.2, 12),
    fix(2, 10000, 28.6001797, 77.2, 12),
    fix(3, 25000, 28.5995507, 77.2, 12),
    fix(4, 26000, 28.7, 77.2, 12),
  ], { nowMs: base + 26000 });
  assert.equal(result[2].trajectory_decision, 'UNCERTAIN');
  assert.equal(result[3].trajectory_decision, 'OUTLIER');
  assert.equal(result[3].trajectory_reason, 'IMPOSSIBLE_SPEED');
});

test('New ISBT Shimla regression: a real mostly-stationary session must not let the smoothing state run away from raw GPS', () => {
  // Captured field session (real device, New ISBT Shimla / Tutikandi coordinates). Earlier
  // versions of the Kalman-style smoother derived velocity from (new filtered state - previous
  // RAW accepted fix) instead of (new filtered state - previous filtered state); that mismatch
  // compounded every step and made the filtered/live position drift ~450m away from a raw GPS
  // track that barely moved 10m the whole time. Guards against that regression coming back.
  const rawSession = require('./fixtures/newIsbtShimla-stationary-session.json');
  const result = processLocations(rawSession, { nowMs: 1787227524630 + 1000 });
  const maxDriftM = Math.max(...result.map((row) => row.raw_to_filtered_m));
  assert.ok(maxDriftM < 30, `expected filtered position to stay within ~30m of raw GPS for a stationary session, got ${maxDriftM}m`);
});

// --- Bike profile fixture: steady ride, a 90-degree turn, a traffic-light stop ---
const bikeOrigin = { latitude: 31.05, longitude: 77.05 };
function bikeFix(id, offsetMs, east, north, accuracy = 10) {
  const point = fromLocalMeters(east, north, bikeOrigin);
  return {
    id, timestamp: base + offsetMs, received_timestamp_ms: base + offsetMs,
    latitude: point.latitude, longitude: point.longitude, accuracy, method: 'fused',
  };
}

function buildBikeSession() {
  const points = [];
  let id = 1;
  let t = 0;
  // Steady eastward ride at 7 m/s for 6 seconds.
  for (let i = 0; i <= 6; i += 1) {
    points.push(bikeFix(id, t, 7 * i, 0));
    id += 1; t += 1000;
  }
  // Sharp 90-degree turn: now heads due north at the same pace for 6 more seconds.
  const turnEast = 7 * 6;
  for (let i = 1; i <= 6; i += 1) {
    points.push(bikeFix(id, t, turnEast, 7 * i));
    id += 1; t += 1000;
  }
  // Traffic-light stop: ~8 seconds of small GPS drift (sub-1m/s implied speed) within the bike
  // stationary radius — real GPS jitter while parked, not a rhythmic full-amplitude bounce.
  const stopEast = turnEast;
  const stopNorth = 7 * 6;
  for (let i = 1; i <= 8; i += 1) {
    const jitter = (i % 2 === 0) ? 0.3 : -0.3;
    points.push(bikeFix(id, t, stopEast + jitter, stopNorth + jitter, 12));
    id += 1; t += 1000;
  }
  return points;
}

test('bike profile: steady pace and a hard turn are accepted, not flagged as impossible speed', () => {
  const session = buildBikeSession();
  const result = processLocations(session, { mode: 'bike', nowMs: base + 20000 });
  const rideAndTurn = result.slice(0, 13);
  assert.ok(rideAndTurn.every((row) => row.trajectory_reason !== 'IMPOSSIBLE_SPEED'),
    'steady ~7 m/s bike pace must not be rejected as impossible under the bike profile');
  assert.ok(rideAndTurn.filter((row) => row.trajectory_decision === 'ACCEPTED').length >= 10,
    'most of the steady ride + turn should be accepted');
});

test('bike profile: a sustained 90-degree turn is detected and relaxes smoothing', () => {
  const session = buildBikeSession();
  const result = processLocations(session, { mode: 'bike', nowMs: base + 20000 });
  assert.ok(result.some((row) => row.turn_detected === 1), 'expected at least one turn_detected fix around the 90-degree bend');
});

test('bike profile: a fast downhill burst within bike\'s speed ceiling would be IMPOSSIBLE_SPEED under walk', () => {
  // 20 m/s (72 km/h) is below bike's extremePhysicalSpeedMps (30) but above walk's (15) — the
  // absolute safety ceiling itself, not the accuracy-margined displacement check, is what should
  // differ between profiles here.
  const burst = [
    bikeFix(1, 0, 0, 0),
    bikeFix(2, 3000, 60, 0), // 60m in 3s = 20 m/s
  ];
  const bikeResult = processLocations(burst, { mode: 'bike', nowMs: base + 3000 });
  const walkResult = processLocations(burst, { mode: 'walk', nowMs: base + 3000 });
  assert.notEqual(bikeResult[1].trajectory_reason, 'IMPOSSIBLE_SPEED');
  assert.equal(walkResult[1].trajectory_reason, 'IMPOSSIBLE_SPEED');
});

test('bike profile: a traffic-light stop produces a stationary anchor and adds no artificial distance', () => {
  const session = buildBikeSession();
  const result = processLocations(session, { mode: 'bike', nowMs: base + 20000 });
  const stopPhase = result.slice(-8);
  assert.ok(stopPhase.some((row) => row.stationary_anchor_latitude != null), 'expected a stationary anchor once stopped');
  assert.ok(stopPhase.filter((row) => row.is_route_point === 1).length <= 1,
    'jitter around a stop must not keep extending the route');
});

test('delayed accurate fixes remain historical trajectory evidence', () => {
  const result = processLocations([
    { ...fix(1, 0, 28.6, 77.2), received_timestamp_ms: base + 25000 },
    { ...fix(2, 5000, 28.6001, 77.2001), received_timestamp_ms: base + 25000 },
  ], { nowMs: base + 25000 });
  assert.equal(result[0].trajectory_decision, 'ACCEPTED');
  assert.equal(result[0].is_live_fresh, 0);
  assert.equal(result[1].trajectory_decision, 'ACCEPTED');
  assert.equal(result[1].processing_status, 'HISTORICAL_ACCEPTED');
  assert.equal(result[1].is_route_point, 1);
  assert.equal(result[1].delivery_latency_ms, 20000);
});