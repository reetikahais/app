const test = require('node:test');
const assert = require('node:assert/strict');
const { processLocations } = require('../processing');
const { MODE_PROFILES, TRACKING_MODES } = require('../trackingConfig');
const fixture = require('./fixtures/hill-motorbike-2026-09-22.json');

// Real motorbike ride in the hills, 22 Sept 2026. Moving fixes (raw ids 444-451) arrived with
// ~100 m accuracy, speed_mps 0, bearing_deg 0 and no speed accuracy (Android reports 0 when it has
// no speed). Before the fix they were rejected as SPEED_MISMATCH and recovery never confirmed them.
const LEGACY = { treatZeroSpeedAsUnknown: false, lowAccuracyRecovery: false };
const nowMs = fixture.raw_locations[fixture.raw_locations.length - 1].received_timestamp_ms;

function replay(extraOptions = {}) {
  return processLocations(fixture.raw_locations, { mode: TRACKING_MODES.MOTORBIKE, nowMs, ...extraOptions });
}

function summarize(rows) {
  return {
    total: rows.length,
    accepted: rows.filter((r) => r.trajectory_decision === 'ACCEPTED').length,
    routePoints: rows.filter((r) => r.is_route_point === 1).length,
    speedMismatch: rows.filter((r) => r.trajectory_reason === 'SPEED_MISMATCH').length,
    pending: rows.filter((r) => r.processing_status === 'PENDING_CONFIRMATION').length,
  };
}

const MOVING_IDS = [444, 445, 446, 447, 448, 449, 450, 451];
const byId = (rows, id) => rows.find((r) => r.raw_fix_id === id);

test('hill fixture still has the shape this regression depends on', () => {
  for (const id of MOVING_IDS) {
    const raw = fixture.raw_locations.find((r) => r.id === id);
    assert.ok(raw, `raw id ${id} present`);
    assert.equal(raw.speed_mps, 0);
    assert.equal(raw.bearing_deg, 0);
    assert.equal(raw.speed_accuracy_mps, null);
  }
});

test('zero-speed placeholder fixes (ids 444-451) are not rejected as SPEED_MISMATCH', (t) => {
  const before = replay(LEGACY);
  const after = replay();
  t.diagnostic(`legacy SPEED_MISMATCH among 444-451: ${MOVING_IDS.filter((id) => byId(before, id).trajectory_reason === 'SPEED_MISMATCH').join(',') || 'none'}`);
  assert.ok(
    MOVING_IDS.some((id) => byId(before, id).trajectory_reason === 'SPEED_MISMATCH'),
    'legacy behaviour reproduces the original bug',
  );
  for (const id of MOVING_IDS) {
    const row = byId(after, id);
    assert.notEqual(row.trajectory_reason, 'SPEED_MISMATCH', `raw id ${id}`);
    assert.notEqual(row.processing_reason, 'SPEED_MISMATCH', `raw id ${id}`);
  }
});

test('placeholder speed is flagged on rows where it was ignored', () => {
  const after = replay();
  const flagged = after.filter((r) => r.reported_speed_unavailable === 1);
  assert.ok(flagged.length > 0);
  for (const row of flagged) {
    assert.equal(row.reported_speed_mps, null);
    assert.equal(row.speed_mps, 0, 'the raw reading itself is preserved on the row');
  }
  assert.equal(replay(LEGACY).filter((r) => r.reported_speed_unavailable === 1).length, 0);
});

test('the trailing poor-accuracy recovery sequence is confirmed, low confidence, never left pending', () => {
  const after = replay();
  const tail = [449, 450, 451].map((id) => byId(after, id));
  assert.ok(!tail.every((r) => r.processing_status === 'PENDING_CONFIRMATION'));
  for (const row of tail) {
    assert.equal(row.trajectory_decision, 'ACCEPTED', `raw id ${row.raw_fix_id}`);
    assert.equal(row.trajectory_reason, 'RECOVERY_CONFIRMED', `raw id ${row.raw_fix_id}`);
    assert.equal(row.is_route_point, 1);
    assert.equal(row.position_confidence, 'LOW');
    assert.notEqual(row.processing_status, 'PENDING_CONFIRMATION');
  }
  const legacyTail = [449, 450, 451].map((id) => byId(replay(LEGACY), id));
  assert.ok(legacyTail.every((r) => r.processing_status === 'PENDING_CONFIRMATION'), 'legacy left them pending');
});

test('hill fixture yields more route points than before the change (before/after counts)', (t) => {
  const before = summarize(replay(LEGACY));
  const after = summarize(replay());
  t.diagnostic(`before: ${JSON.stringify(before)}`);
  t.diagnostic(`after:  ${JSON.stringify(after)}`);
  assert.ok(after.routePoints > before.routePoints);
  assert.ok(after.accepted > before.accepted);
  assert.ok(after.speedMismatch < before.speedMismatch);
  assert.ok(after.pending < before.pending);
});

test('the new handling is opt-in per profile: every vehicle mode enables it, walk does not', () => {
  for (const [mode, profile] of Object.entries(MODE_PROFILES)) {
    const expected = mode !== TRACKING_MODES.WALK;
    assert.equal(profile.treatZeroSpeedAsUnknown, expected, `${mode}.treatZeroSpeedAsUnknown`);
    assert.equal(profile.lowAccuracyRecovery, expected, `${mode}.lowAccuracyRecovery`);
  }
});

// Synthetic: 100 m north in 8 s (12.5 m/s) with good accuracy, reported speed 0.
function twoFixes(second) {
  const t0 = 1790000000000;
  const first = {
    id: 1, batch_id: 'b1', batch_index: 0, fix_timestamp_ms: t0, received_timestamp_ms: t0,
    latitude: 31.0, longitude: 77.0, horizontal_accuracy_m: 8, speed_mps: 0, bearing_deg: 0, speed_accuracy_mps: null,
  };
  return [first, {
    id: 2, batch_id: 'b1', batch_index: 1, fix_timestamp_ms: t0 + 8000, received_timestamp_ms: t0 + 8000,
    latitude: 31.0009, longitude: 77.0, horizontal_accuracy_m: 8, speed_mps: 0, bearing_deg: 0, speed_accuracy_mps: null,
    ...second,
  }];
}

test('speed 0 is only treated as unknown when it looks like the placeholder AND the fix really moved', () => {
  const run = (second, options = {}) => processLocations(twoFixes(second), { mode: 'motorbike', nowMs: 1790000010000, ...options })[1];

  const placeholder = run({});
  assert.equal(placeholder.reported_speed_unavailable, 1);
  assert.equal(placeholder.trajectory_decision, 'ACCEPTED');

  // A real speed accuracy means the 0 is a genuine reading: still a mismatch against 12.5 m/s.
  const genuineZero = run({ speed_accuracy_mps: 0.5 });
  assert.equal(genuineZero.reported_speed_unavailable, 0);
  assert.equal(genuineZero.trajectory_reason, 'SPEED_MISMATCH');

  // A real heading likewise means the device reported full motion data.
  const hasHeading = run({ bearing_deg: 10 });
  assert.equal(hasHeading.reported_speed_unavailable, 0);
  assert.equal(hasHeading.trajectory_reason, 'SPEED_MISMATCH');

  // Barely moved (implied speed below stationarySpeedMps): speed 0 is plausible, nothing is ignored.
  const stationary = run({ latitude: 31.00001 });
  assert.equal(stationary.reported_speed_unavailable, 0);

  // Same fixes with the feature off (e.g. any other mode) behave exactly as before.
  const legacy = run({}, LEGACY);
  assert.equal(legacy.reported_speed_unavailable, 0);
  assert.equal(legacy.trajectory_reason, 'SPEED_MISMATCH');
});
