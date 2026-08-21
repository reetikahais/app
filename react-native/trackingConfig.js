const TRACKING_PROFILES = Object.freeze({
  ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1500, distanceIntervalM: 0 },
  LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 2500, distanceIntervalM: 2 },
  MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 5000, distanceIntervalM: 5 },
  STATIONARY: { accuracy: 'High', timeIntervalMs: 30000, distanceIntervalM: 25 },
});

const PROCESSING_CONFIG = Object.freeze({
  algorithmVersion: '2.2.0',
  freshThresholdMs: 10000,
  normalAccuracyMaxM: 50,
  segmentGapMs: 15000,
  duplicateToleranceM: 1,
  innovationGate: 5.99,
  routeSimplificationToleranceM: 2,
  stationarySpeedMps: 0.8,
  movingSpeedMps: 1.2,
  stationaryNoiseFloorM: 8,
  stationaryAccuracyMultiplier: 0.75,
  movingAccuracyMultiplier: 1.5,
  movingConfirmationMs: 5000,
  stationaryConfirmationMs: 20000,
  recentSpeedHistoryLength: 5,
  walkingPlausibleSpeedMps: 2.5,
  walkingBurstSpeedMps: 4.5,
  dynamicDistanceSafetyMarginM: 8,
  uncertaintyAccuracyFactor: 1.5,
  extremePhysicalSpeedMps: 15,
  bearingPenaltyThresholdDeg: 135,
  candidateConfirmationBurstSpeedMps: 6,
  candidateConfirmationWindowMs: 60000,
  // Recognizes real directional walking across several recent fixes instead of judging each one
  // against a noise floor in isolation (see updateMovement/computeProgressiveMovement in processing.js).
  progressiveMovementWindowSize: 4,
  progressiveMovementMinNetDisplacementM: 15,
  progressiveMovementMinRatio: 0.6,
  // A long sampling gap with only a small displacement is a late-delivered fix, not a route break.
  samplingDelayMaxDisplacementM: 20,
});

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
const MATCHER_ENDPOINT = null;
const MATCHER_VERSION = 'valhalla-walking-adapter-2';

if (typeof module !== 'undefined') module.exports = {
  TRACKING_PROFILES, PROCESSING_CONFIG, LOCATION_TASK_NAME, APP_STATE_KEY, ACTIVE_PROFILE_KEY,
  MATCHER_ENDPOINT, MATCHER_VERSION, MAP_MATCH_CONFIDENCE, ELEVATION_CONFIG,
};