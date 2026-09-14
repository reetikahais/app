const TRACKING_MODES = Object.freeze({ WALK: 'walk', BIKE: 'bike' });

// Not mode-specific: safety ceilings, freshness/gap timing, and smoothing-input weighting that
// apply the same way regardless of what's carrying the phone.
const BASE_PROCESSING_CONFIG = Object.freeze({
  algorithmVersion: '3.0.0',
  freshThresholdMs: 10000,
  normalAccuracyMaxM: 50,
  segmentGapMs: 15000,
  duplicateToleranceM: 1,
  innovationGate: 5.99,
  routeSimplificationToleranceM: 2,
  recentSpeedHistoryLength: 5,
  dynamicDistanceSafetyMarginM: 8,
  uncertaintyAccuracyFactor: 1.5,
  // A long sampling gap with only a small displacement is a late-delivered fix, not a route break.
  samplingDelayMaxDisplacementM: 20,
});

// Per-mode tunables (spec section 2: TrackingProfile). Every threshold that governs what counts
// as plausible/stationary/moving/turning must live here, never hardcoded inside processing.js,
// so bike behavior can diverge from walking without scattering `if (mode === 'bike')` checks.
const MODE_PROFILES = Object.freeze({
  [TRACKING_MODES.WALK]: Object.freeze({
    gpsIntervalMs: 2000,
    minDistanceMeters: 2,
    preferredAccuracyMeters: 15,
    maxAcceptableAccuracyMeters: 30,
    stationarySpeedMps: 0.8,
    stationaryRadiusMeters: 8,
    stationaryNoiseFloorM: 8,
    stationaryAccuracyMultiplier: 0.75,
    stationaryConfirmationMs: 20000,
    movingSpeedMps: 1.2,
    movingAccuracyMultiplier: 1.5,
    movingConfirmationMs: 5000,
    plausibleSpeedMps: 2.5,
    burstSpeedMps: 4.5,
    extremePhysicalSpeedMps: 15,
    maxAccelerationMps2: 3,
    bearingPenaltyThresholdDeg: 135,
    turnDetectionThresholdDeg: 30,
    headingImportance: 0.3,
    smoothingStrength: 0.7,
    turnSmoothingStrength: 0.3,
    mapMatchingRadiusMeters: 30,
    candidateConfirmationBurstSpeedMps: 6,
    candidateConfirmationWindowMs: 60000,
    progressiveMovementWindowSize: 4,
    progressiveMovementMinNetDisplacementM: 15,
    progressiveMovementMinRatio: 0.6,
    extendedMovementStates: false,
  }),
  [TRACKING_MODES.BIKE]: Object.freeze({
    gpsIntervalMs: 1000,
    minDistanceMeters: 4,
    preferredAccuracyMeters: 15,
    maxAcceptableAccuracyMeters: 35,
    stationarySpeedMps: 1.0,
    stationaryRadiusMeters: 12,
    stationaryNoiseFloorM: 12,
    stationaryAccuracyMultiplier: 0.75,
    stationaryConfirmationMs: 5000,
    movingSpeedMps: 1.5,
    movingAccuracyMultiplier: 1.5,
    movingConfirmationMs: 3000,
    plausibleSpeedMps: 8,
    burstSpeedMps: 14,
    extremePhysicalSpeedMps: 30,
    maxAccelerationMps2: 4,
    bearingPenaltyThresholdDeg: 135,
    turnDetectionThresholdDeg: 25,
    headingImportance: 0.8,
    smoothingStrength: 0.5,
    turnSmoothingStrength: 0.15,
    mapMatchingRadiusMeters: 40,
    candidateConfirmationBurstSpeedMps: 16,
    candidateConfirmationWindowMs: 60000,
    progressiveMovementWindowSize: 4,
    progressiveMovementMinNetDisplacementM: 20,
    progressiveMovementMinRatio: 0.6,
    extendedMovementStates: true,
  }),
});

function getTrackingProfile(mode) {
  const resolved = MODE_PROFILES[mode] ? mode : TRACKING_MODES.WALK;
  return { ...BASE_PROCESSING_CONFIG, ...MODE_PROFILES[resolved], mode: resolved };
}

// Polling profiles: how often/how far GPS updates are requested from the OS. Nested per mode so
// bike can poll faster/tighter than walking without a second copy of the tier logic.
const POLLING_PROFILES = Object.freeze({
  [TRACKING_MODES.WALK]: Object.freeze({
    ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1500, distanceIntervalM: 0 },
    LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 2500, distanceIntervalM: 2 },
    MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 5000, distanceIntervalM: 5 },
    STATIONARY: { accuracy: 'High', timeIntervalMs: 30000, distanceIntervalM: 25 },
  }),
  [TRACKING_MODES.BIKE]: Object.freeze({
    ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1000, distanceIntervalM: 0 },
    LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 1500, distanceIntervalM: 2 },
    MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 1000, distanceIntervalM: 4 },
    STATIONARY: { accuracy: 'High', timeIntervalMs: 20000, distanceIntervalM: 20 },
  }),
});

function getPollingProfile(mode, tier) {
  const resolvedMode = POLLING_PROFILES[mode] ? mode : TRACKING_MODES.WALK;
  return POLLING_PROFILES[resolvedMode][tier] || POLLING_PROFILES[resolvedMode].MOVING_NORMAL;
}

// Back-compat: TRACKING_PROFILES/PROCESSING_CONFIG named exports kept equal to the walk profile
// so any not-yet-migrated call site still behaves exactly as before.
const TRACKING_PROFILES = POLLING_PROFILES[TRACKING_MODES.WALK];
const PROCESSING_CONFIG = getTrackingProfile(TRACKING_MODES.WALK);

const MAP_MATCH_CONFIDENCE = Object.freeze({
  HIGH_MIN: 0.75,
  MEDIUM_MIN: 0.45,
});

const ELEVATION_CONFIG = Object.freeze({
  smoothingWindow: 5,
  maxPlausibleVerticalSpeedMps: 3,
});

const LOCATION_TASK_NAME = 'raahmitra-background-location-task';
const APP_STATE_KEY = 'app_state';
const ACTIVE_PROFILE_KEY = 'active_tracking_profile';
const TRACKING_MODE_KEY = 'tracking_mode';
const MATCHER_ENDPOINT = null;
const MATCHER_PROFILE_BY_MODE = Object.freeze({
  [TRACKING_MODES.WALK]: 'pedestrian',
  [TRACKING_MODES.BIKE]: 'bicycle',
});
const MATCHER_VERSION = 'valhalla-adapter-3';

if (typeof module !== 'undefined') module.exports = {
  TRACKING_MODES, MODE_PROFILES, BASE_PROCESSING_CONFIG, getTrackingProfile,
  POLLING_PROFILES, getPollingProfile, TRACKING_PROFILES, PROCESSING_CONFIG,
  LOCATION_TASK_NAME, APP_STATE_KEY, ACTIVE_PROFILE_KEY, TRACKING_MODE_KEY,
  MATCHER_ENDPOINT, MATCHER_PROFILE_BY_MODE, MATCHER_VERSION, MAP_MATCH_CONFIDENCE, ELEVATION_CONFIG,
};
