const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRACKING_MODES, getTrackingProfile, getPollingProfile, MODE_PROFILES, normalizeTrackingMode,
  desiredPollingProfile, POLLING_ESCALATION_MIN_SAMPLES,
} = require('../trackingConfig');

const ALL_MODES = [TRACKING_MODES.WALK, TRACKING_MODES.BICYCLE, TRACKING_MODES.MOTORBIKE, TRACKING_MODES.CAR];

test('four modes are exposed with the spec-required internal names', () => {
  assert.deepEqual(ALL_MODES, ['walk', 'bicycle', 'motorbike', 'car']);
});

test('legacy "bike" sessions normalize to bicycle, never motorbike', () => {
  assert.equal(normalizeTrackingMode('bike'), TRACKING_MODES.BICYCLE);
  assert.notEqual(normalizeTrackingMode('bike'), TRACKING_MODES.MOTORBIKE);
});

test('an unrecognized mode string normalizes to null so callers fall back explicitly', () => {
  assert.equal(normalizeTrackingMode('unicycle'), null);
});

test('getTrackingProfile returns a distinct, fully-populated profile per mode', () => {
  const profiles = ALL_MODES.map((mode) => getTrackingProfile(mode));
  for (const [mode, profile] of ALL_MODES.map((mode, i) => [mode, profiles[i]])) {
    assert.equal(profile.mode, mode);
    for (const field of [
      'plausibleSpeedMps', 'burstSpeedMps', 'extremePhysicalSpeedMps', 'stationarySpeedMps',
      'stationaryRadiusMeters', 'headingImportance', 'smoothingStrength', 'turnSmoothingStrength',
      'maxAccelerationMps2', 'mapMatchingRadiusMeters', 'extendedMovementStates',
      'recoveryMinPoints', 'speedAgreementToleranceMps',
    ]) {
      assert.ok(field in profile, `${mode} profile missing ${field}`);
    }
  }
});

test('a legacy "bike" mode resolves to the bicycle profile, not walk fallback', () => {
  const legacy = getTrackingProfile('bike');
  assert.equal(legacy.mode, TRACKING_MODES.BICYCLE);
});

test('speed ceilings escalate in order across walk < bicycle < motorbike < car', () => {
  const [walk, bicycle, motorbike, car] = ALL_MODES.map((mode) => getTrackingProfile(mode));
  assert.ok(bicycle.plausibleSpeedMps > walk.plausibleSpeedMps);
  assert.ok(motorbike.plausibleSpeedMps > bicycle.plausibleSpeedMps);
  assert.ok(car.plausibleSpeedMps > motorbike.plausibleSpeedMps);
  assert.ok(bicycle.extremePhysicalSpeedMps > walk.extremePhysicalSpeedMps);
  assert.ok(motorbike.extremePhysicalSpeedMps > bicycle.extremePhysicalSpeedMps);
  assert.ok(car.extremePhysicalSpeedMps > motorbike.extremePhysicalSpeedMps);
});

test('motorbike and car weigh device heading more heavily and smooth turns less than walk', () => {
  const walk = getTrackingProfile(TRACKING_MODES.WALK);
  const motorbike = getTrackingProfile(TRACKING_MODES.MOTORBIKE);
  const car = getTrackingProfile(TRACKING_MODES.CAR);
  assert.ok(motorbike.headingImportance > walk.headingImportance);
  assert.ok(car.headingImportance > walk.headingImportance);
  assert.ok(motorbike.turnSmoothingStrength < walk.turnSmoothingStrength);
  assert.ok(car.turnSmoothingStrength < walk.turnSmoothingStrength);
});

test('walk keeps the classic movement-state set; every faster mode opts into the extended set', () => {
  assert.equal(MODE_PROFILES.walk.extendedMovementStates, false);
  assert.equal(MODE_PROFILES.bicycle.extendedMovementStates, true);
  assert.equal(MODE_PROFILES.motorbike.extendedMovementStates, true);
  assert.equal(MODE_PROFILES.car.extendedMovementStates, true);
});

test('an unknown mode falls back to the walk profile', () => {
  const fallback = getTrackingProfile('unknown-mode');
  assert.equal(fallback.mode, 'walk');
});

test('getPollingProfile returns a faster, tighter tier for each faster mode than walk', () => {
  const walkTier = getPollingProfile(TRACKING_MODES.WALK, 'MOVING_NORMAL');
  for (const mode of [TRACKING_MODES.BICYCLE, TRACKING_MODES.MOTORBIKE, TRACKING_MODES.CAR]) {
    const tier = getPollingProfile(mode, 'MOVING_NORMAL');
    assert.ok(tier.timeIntervalMs <= walkTier.timeIntervalMs, `${mode} should poll at least as often as walk`);
  }
});

test('getPollingProfile resolves legacy "bike" to the bicycle polling tiers', () => {
  const legacyTier = getPollingProfile('bike', 'MOVING_NORMAL');
  const bicycleTier = getPollingProfile(TRACKING_MODES.BICYCLE, 'MOVING_NORMAL');
  assert.deepEqual(legacyTier, bicycleTier);
});

function fix(t, accuracy) { return { fix_timestamp_ms: t, horizontal_accuracy_m: accuracy }; }

test('desiredPollingProfile stays put until enough samples exist to judge', () => {
  const fixes = [fix(0, 200), fix(1000, 200)];
  assert.equal(fixes.length < POLLING_ESCALATION_MIN_SAMPLES, true);
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'MOVING_NORMAL', fixes), 'MOVING_NORMAL');
});

test('desiredPollingProfile escalates once several consecutive fixes are all past the mode ceiling', () => {
  // motorbike maxAcceptableAccuracyMeters is 40 — every one of these is well past it.
  const fixes = [fix(0, 90), fix(1000, 120), fix(2000, 200)];
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'MOVING_NORMAL', fixes), 'LIVE_SAFETY');
});

test('desiredPollingProfile does not escalate if even one recent fix is within the ceiling', () => {
  const fixes = [fix(0, 90), fix(1000, 30), fix(2000, 200)];
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'MOVING_NORMAL', fixes), 'MOVING_NORMAL');
});

test('desiredPollingProfile de-escalates only once the latest fix is back under preferredAccuracyMeters', () => {
  // motorbike preferredAccuracyMeters is 15.
  const stillMediocre = [fix(0, 90), fix(1000, 90), fix(2000, 25)];
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'LIVE_SAFETY', stillMediocre), 'LIVE_SAFETY');
  const recovered = [fix(0, 90), fix(1000, 90), fix(2000, 12)];
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'LIVE_SAFETY', recovered), 'MOVING_NORMAL');
});

test('desiredPollingProfile never touches ACQUIRING/STATIONARY tiers driven by other logic', () => {
  const fixes = [fix(0, 200), fix(1000, 200), fix(2000, 200)];
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'ACQUIRING', fixes), 'ACQUIRING');
  assert.equal(desiredPollingProfile(TRACKING_MODES.MOTORBIKE, 'STATIONARY', fixes), 'STATIONARY');
});
