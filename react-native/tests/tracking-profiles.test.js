const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRACKING_MODES, getTrackingProfile, getPollingProfile, MODE_PROFILES,
} = require('../trackingConfig');

test('getTrackingProfile returns a distinct, fully-populated profile per mode', () => {
  const walk = getTrackingProfile(TRACKING_MODES.WALK);
  const bike = getTrackingProfile(TRACKING_MODES.BIKE);
  assert.equal(walk.mode, 'walk');
  assert.equal(bike.mode, 'bike');
  for (const field of [
    'plausibleSpeedMps', 'burstSpeedMps', 'extremePhysicalSpeedMps', 'stationarySpeedMps',
    'stationaryRadiusMeters', 'headingImportance', 'smoothingStrength', 'turnSmoothingStrength',
    'maxAccelerationMps2', 'mapMatchingRadiusMeters', 'extendedMovementStates',
  ]) {
    assert.ok(field in walk, `walk profile missing ${field}`);
    assert.ok(field in bike, `bike profile missing ${field}`);
  }
});

test('bike tolerates far higher speeds than walk before treating movement as implausible', () => {
  const walk = getTrackingProfile(TRACKING_MODES.WALK);
  const bike = getTrackingProfile(TRACKING_MODES.BIKE);
  assert.ok(bike.plausibleSpeedMps > walk.plausibleSpeedMps);
  assert.ok(bike.extremePhysicalSpeedMps > walk.extremePhysicalSpeedMps);
});

test('bike weighs device heading more heavily and smooths turns less aggressively than walk', () => {
  const walk = getTrackingProfile(TRACKING_MODES.WALK);
  const bike = getTrackingProfile(TRACKING_MODES.BIKE);
  assert.ok(bike.headingImportance > walk.headingImportance);
  assert.ok(bike.turnSmoothingStrength < walk.turnSmoothingStrength);
});

test('walk keeps the classic movement-state set; bike opts into the extended set', () => {
  assert.equal(MODE_PROFILES.walk.extendedMovementStates, false);
  assert.equal(MODE_PROFILES.bike.extendedMovementStates, true);
});

test('an unknown mode falls back to the walk profile', () => {
  const fallback = getTrackingProfile('unknown-mode');
  assert.equal(fallback.mode, 'walk');
});

test('getPollingProfile returns a faster, tighter tier for bike than walk', () => {
  const walkTier = getPollingProfile(TRACKING_MODES.WALK, 'MOVING_NORMAL');
  const bikeTier = getPollingProfile(TRACKING_MODES.BIKE, 'MOVING_NORMAL');
  assert.ok(bikeTier.timeIntervalMs < walkTier.timeIntervalMs);
  assert.ok(bikeTier.distanceIntervalM < walkTier.distanceIntervalM);
});
