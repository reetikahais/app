const TRACKING_MODES = Object.freeze({
  WALK: 'walk',
  BICYCLE: 'bicycle',
  MOTORBIKE: 'motorbike',
  CAR: 'car',
});

// Legacy sessions recorded before the four-mode split only ever wrote 'bike'. That value meant
// "bicycle or bike/bicycle" ambiguously, and is deliberately mapped to 'bicycle' (never
// 'motorbike') for any old row/stored value still carrying it, so historical trips keep resolving
// to a valid profile instead of silently falling back to walk.
const LEGACY_MODE_MAP = Object.freeze({ bike: TRACKING_MODES.BICYCLE });

function normalizeTrackingMode(mode) {
  if (MODE_PROFILES_KEYS.includes(mode)) return mode;
  if (LEGACY_MODE_MAP[mode]) return LEGACY_MODE_MAP[mode];
  return null;
}

const MODE_PROFILES_KEYS = [
  TRACKING_MODES.WALK, TRACKING_MODES.BICYCLE, TRACKING_MODES.MOTORBIKE, TRACKING_MODES.CAR,
];

// Not mode-specific: safety ceilings, freshness/gap timing, and smoothing-input weighting that
// apply the same way regardless of what's carrying the phone.
const BASE_PROCESSING_CONFIG = Object.freeze({
  algorithmVersion: '4.0.0',
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
  // Section 19: three consecutive OUTLIER fixes force a recovery evaluation instead of comparing
  // every future fix back to the same stale accepted point forever.
  maxConsecutiveOutliersBeforeRecovery: 3,
  // Section 17/32: how many consecutive rejected fixes are buffered for candidate-to-candidate
  // recovery scoring before the oldest is dropped as permanently rejected.
  recoveryBufferMaxPoints: 5,
  // Terrain (hills, valleys, urban canyons) can hold horizontal_accuracy_m at 100-300m for minutes
  // at a time even while the device is genuinely moving — well past normalAccuracyMaxM/
  // maxAcceptableAccuracyMeters, which gate trusting a SINGLE fix. Candidate-to-candidate recovery
  // scoring (processing.js) asks a different question: do several consecutive fixes, each
  // individually uncertain, agree with each other on speed/bearing/progress? That multi-point
  // agreement is strong enough evidence to tolerate a much looser per-leg accuracy ceiling than a
  // lone fix ever gets — this bounds it only to exclude genuinely unusable readings (e.g.
  // cell-tower-only fallback positioning), not real GPS degraded by terrain.
  recoveryMaxAccuracyMeters: 250,
});

// Per-mode tunables (spec section 2: TrackingProfile). Every threshold that governs what counts
// as plausible/stationary/moving/turning must live here, never hardcoded inside processing.js,
// so each mode's behavior can diverge without scattering `if (mode === 'x')` checks.
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
    recoveryMinPoints: 3,
    speedAgreementToleranceMps: 1.5,
    extendedMovementStates: false,
    treatZeroSpeedAsUnknown: false,
    lowAccuracyRecovery: false,
  }),
  [TRACKING_MODES.BICYCLE]: Object.freeze({
    gpsIntervalMs: 1000,
    minDistanceMeters: 4,
    preferredAccuracyMeters: 15,
    maxAcceptableAccuracyMeters: 35,
    stationarySpeedMps: 1.0,
    stationaryRadiusMeters: 12,
    stationaryNoiseFloorM: 12,
    stationaryAccuracyMultiplier: 0.75,
    stationaryConfirmationMs: 5000,
    movingSpeedMps: 1.8,
    movingAccuracyMultiplier: 1.5,
    movingConfirmationMs: 3000,
    plausibleSpeedMps: 10,
    burstSpeedMps: 16,
    extremePhysicalSpeedMps: 25,
    maxAccelerationMps2: 4,
    bearingPenaltyThresholdDeg: 135,
    turnDetectionThresholdDeg: 25,
    headingImportance: 0.7,
    smoothingStrength: 0.5,
    turnSmoothingStrength: 0.15,
    mapMatchingRadiusMeters: 40,
    candidateConfirmationBurstSpeedMps: 18,
    candidateConfirmationWindowMs: 30000,
    progressiveMovementWindowSize: 4,
    progressiveMovementMinNetDisplacementM: 20,
    progressiveMovementMinRatio: 0.6,
    recoveryMinPoints: 3,
    speedAgreementToleranceMps: 2.5,
    extendedMovementStates: true,
    treatZeroSpeedAsUnknown: true,
    lowAccuracyRecovery: true,
  }),
  [TRACKING_MODES.MOTORBIKE]: Object.freeze({
    gpsIntervalMs: 1000,
    minDistanceMeters: 5,
    preferredAccuracyMeters: 15,
    maxAcceptableAccuracyMeters: 40,
    stationarySpeedMps: 1.5,
    stationaryRadiusMeters: 15,
    stationaryNoiseFloorM: 15,
    stationaryAccuracyMultiplier: 0.75,
    stationaryConfirmationMs: 4000,
    movingSpeedMps: 3,
    movingAccuracyMultiplier: 1.5,
    movingConfirmationMs: 2500,
    plausibleSpeedMps: 25,
    burstSpeedMps: 40,
    extremePhysicalSpeedMps: 55,
    maxAccelerationMps2: 8,
    bearingPenaltyThresholdDeg: 140,
    turnDetectionThresholdDeg: 20,
    headingImportance: 0.9,
    smoothingStrength: 0.4,
    turnSmoothingStrength: 0.12,
    mapMatchingRadiusMeters: 45,
    candidateConfirmationBurstSpeedMps: 42,
    candidateConfirmationWindowMs: 20000,
    progressiveMovementWindowSize: 4,
    progressiveMovementMinNetDisplacementM: 30,
    progressiveMovementMinRatio: 0.65,
    recoveryMinPoints: 3,
    speedAgreementToleranceMps: 4,
    extendedMovementStates: true,
    // Hill-ride regression (22 Sept 2026): Android reports speed 0 / bearing 0 / no speed accuracy
    // for Wi-Fi/cell-grade fused fixes because it has no speed, not because the bike stopped. Enabled
    // for every vehicle mode (bicycle, motorbike, car); walk stays off.
    treatZeroSpeedAsUnknown: true,
    lowAccuracyRecovery: true,
  }),
  [TRACKING_MODES.CAR]: Object.freeze({
    gpsIntervalMs: 1000,
    minDistanceMeters: 6,
    preferredAccuracyMeters: 20,
    maxAcceptableAccuracyMeters: 50,
    stationarySpeedMps: 2,
    stationaryRadiusMeters: 18,
    stationaryNoiseFloorM: 18,
    stationaryAccuracyMultiplier: 0.75,
    stationaryConfirmationMs: 4000,
    movingSpeedMps: 4,
    movingAccuracyMultiplier: 1.5,
    movingConfirmationMs: 2500,
    plausibleSpeedMps: 35,
    burstSpeedMps: 50,
    extremePhysicalSpeedMps: 70,
    maxAccelerationMps2: 8,
    bearingPenaltyThresholdDeg: 145,
    turnDetectionThresholdDeg: 18,
    headingImportance: 0.9,
    smoothingStrength: 0.4,
    turnSmoothingStrength: 0.1,
    mapMatchingRadiusMeters: 55,
    candidateConfirmationBurstSpeedMps: 52,
    candidateConfirmationWindowMs: 20000,
    progressiveMovementWindowSize: 4,
    progressiveMovementMinNetDisplacementM: 40,
    progressiveMovementMinRatio: 0.65,
    recoveryMinPoints: 3,
    speedAgreementToleranceMps: 5,
    extendedMovementStates: true,
    treatZeroSpeedAsUnknown: true,
    lowAccuracyRecovery: true,
  }),
});

function getTrackingProfile(mode) {
  const resolved = MODE_PROFILES[mode] ? mode : (normalizeTrackingMode(mode) || TRACKING_MODES.WALK);
  return { ...BASE_PROCESSING_CONFIG, ...MODE_PROFILES[resolved], mode: resolved };
}

// Polling profiles: how often/how far GPS updates are requested from the OS. Nested per mode so
// faster-moving modes can poll faster/tighter than walking without a second copy of the tier logic.
const POLLING_PROFILES = Object.freeze({
  [TRACKING_MODES.WALK]: Object.freeze({
    ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1500, distanceIntervalM: 0 },
    LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 2500, distanceIntervalM: 2 },
    MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 5000, distanceIntervalM: 5 },
    STATIONARY: { accuracy: 'High', timeIntervalMs: 30000, distanceIntervalM: 25 },
  }),
  [TRACKING_MODES.BICYCLE]: Object.freeze({
    ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1000, distanceIntervalM: 0 },
    LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 1500, distanceIntervalM: 2 },
    MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 1000, distanceIntervalM: 4 },
    STATIONARY: { accuracy: 'High', timeIntervalMs: 20000, distanceIntervalM: 20 },
  }),
  [TRACKING_MODES.MOTORBIKE]: Object.freeze({
    ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1000, distanceIntervalM: 0 },
    LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 1000, distanceIntervalM: 3 },
    MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 1000, distanceIntervalM: 5 },
    STATIONARY: { accuracy: 'High', timeIntervalMs: 15000, distanceIntervalM: 20 },
  }),
  [TRACKING_MODES.CAR]: Object.freeze({
    ACQUIRING: { accuracy: 'BestForNavigation', timeIntervalMs: 1000, distanceIntervalM: 0 },
    LIVE_SAFETY: { accuracy: 'BestForNavigation', timeIntervalMs: 1000, distanceIntervalM: 4 },
    MOVING_NORMAL: { accuracy: 'Highest', timeIntervalMs: 1000, distanceIntervalM: 6 },
    STATIONARY: { accuracy: 'High', timeIntervalMs: 15000, distanceIntervalM: 25 },
  }),
});

function getPollingProfile(mode, tier) {
  const resolvedMode = POLLING_PROFILES[mode] ? mode : (normalizeTrackingMode(mode) || TRACKING_MODES.WALK);
  return POLLING_PROFILES[resolvedMode][tier] || POLLING_PROFILES[resolvedMode].MOVING_NORMAL;
}

// Back-compat: TRACKING_PROFILES/PROCESSING_CONFIG named exports kept equal to the walk profile
// so any not-yet-migrated call site still behaves exactly as before.
const TRACKING_PROFILES = POLLING_PROFILES[TRACKING_MODES.WALK];
const PROCESSING_CONFIG = getTrackingProfile(TRACKING_MODES.WALK);

// Section 15/16: rolling-median speed thresholds that let the tracking engine escalate its
// effective profile above the user's selected one (and relax back down) without ever switching on
// a single GPS sample. Order is a ladder: walk -> bicycle -> motorbike. There is no speed-based
// escalation from motorbike to car (real activity-recognition evidence would be required, which
// this app does not currently have) and car never escalates or downgrades on its own.
const ADAPTIVE_MODE_RANK = Object.freeze({
  [TRACKING_MODES.WALK]: 0,
  [TRACKING_MODES.BICYCLE]: 1,
  [TRACKING_MODES.MOTORBIKE]: 2,
  [TRACKING_MODES.CAR]: 3,
});
const ADAPTIVE_MODE_RULES = Object.freeze({
  WALK_TO_BICYCLE: { upSpeedMps: 3.5, upDurationMs: 10000, downSpeedMps: 2.5, downDurationMs: 30000 },
  BICYCLE_TO_MOTORBIKE: { upSpeedMps: 18, upDurationMs: 15000, downSpeedMps: 12, downDurationMs: 30000 },
});

// Polling accuracy escalation: switches the OS-facing GPS request between MOVING_NORMAL and
// LIVE_SAFETY based on how the last few RAW fixes' own accuracy looked, so hilly/canyon terrain
// that sustains poor accuracy prompts the GPS chip to try harder (LIVE_SAFETY uses
// BestForNavigation plus a tighter interval — see POLLING_PROFILES) instead of the app just
// accepting whatever MOVING_NORMAL happens to deliver for the rest of the session. Escalating
// requires POLLING_ESCALATION_MIN_SAMPLES consecutive fixes ALL past maxAcceptableAccuracyMeters
// (the same per-mode ceiling processing.js's recovery scoring uses); de-escalating requires only
// the latest fix back under the tighter preferredAccuracyMeters. That asymmetry is deliberate
// hysteresis so accuracy hovering near one boundary can't flap the request every batch.
const POLLING_ESCALATION_MIN_SAMPLES = 3;

function desiredPollingProfile(mode, currentProfileName, recentFixesSortedByTime) {
  // ACQUIRING/STATIONARY are reserved for other logic (not currently wired up) — this function
  // only ever moves between MOVING_NORMAL and LIVE_SAFETY, so leave any other tier untouched.
  if (currentProfileName !== 'MOVING_NORMAL' && currentProfileName !== 'LIVE_SAFETY') {
    return currentProfileName;
  }
  const modeProfile = getTrackingProfile(mode);
  const fixes = (recentFixesSortedByTime || []).filter((fix) => fix && fix.fix_timestamp_ms != null);
  if (fixes.length < POLLING_ESCALATION_MIN_SAMPLES) return currentProfileName;
  const lastFew = fixes.slice(-POLLING_ESCALATION_MIN_SAMPLES);
  const allDegraded = lastFew.every((fix) => (
    fix.horizontal_accuracy_m == null || fix.horizontal_accuracy_m > modeProfile.maxAcceptableAccuracyMeters
  ));
  if (allDegraded) return 'LIVE_SAFETY';
  if (currentProfileName === 'LIVE_SAFETY') {
    const latest = fixes[fixes.length - 1];
    const recovered = latest.horizontal_accuracy_m != null && latest.horizontal_accuracy_m <= modeProfile.preferredAccuracyMeters;
    if (recovered) return 'MOVING_NORMAL';
  }
  return currentProfileName;
}

// The background task must never stop/start location updates itself: Android refuses to start a
// foreground service from the background (the 22 Sept 2026 hill ride lost ~23 minutes of tracking
// that way). The task only decides which profile it WOULD like, stores that as the "requested"
// profile, and the app applies it the next time it is in the foreground. Hysteresis is evaluated
// against the requested profile (the latest decision), not the active one, since the active one
// can lag behind until the app is foregrounded.
function decideProfileRequest(mode, activeProfileName, requestedProfileName, recentFixesSortedByTime) {
  const current = requestedProfileName || activeProfileName;
  const requestedProfile = desiredPollingProfile(mode, current, recentFixesSortedByTime);
  return {
    requestedProfile,
    changed: requestedProfile !== current,
    needsApply: requestedProfile !== activeProfileName,
  };
}

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
const REQUESTED_PROFILE_KEY = 'requested_tracking_profile';
const TRACKING_SESSION_KEY = 'tracking_session_id';
// The background task reprocesses recent history with every delivery. It only loads the larger of
// "the last HISTORY_WINDOW_MIN_FIXES fixes" and "the last HISTORY_WINDOW_MS of fixes" of the session.
const HISTORY_WINDOW_MIN_FIXES = 300;
const HISTORY_WINDOW_MS = 15 * 60 * 1000;
const TRACKING_MODE_KEY = 'tracking_mode';

function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
const MATCHER_ENDPOINT = null;
// Valhalla costing model names (see valhalla-adapter/transform.js, which forwards `costing`
// straight through to Valhalla's trace_attributes API with no allowlist of its own): 'pedestrian',
// 'bicycle', 'motorcycle' and 'auto' are all real, currently-supported Valhalla costing profiles.
// 'motorcycle' is used for the Bike button (motorbike/scooter) rather than inventing a
// scooter-specific profile the deployed Valhalla version may not expose.
const MATCHER_PROFILE_BY_MODE = Object.freeze({
  [TRACKING_MODES.WALK]: 'pedestrian',
  [TRACKING_MODES.BICYCLE]: 'bicycle',
  [TRACKING_MODES.MOTORBIKE]: 'motorcycle',
  [TRACKING_MODES.CAR]: 'auto',
});
const MATCHER_VERSION = 'valhalla-adapter-4';

if (typeof module !== 'undefined') module.exports = {
  TRACKING_MODES, MODE_PROFILES, BASE_PROCESSING_CONFIG, getTrackingProfile, normalizeTrackingMode,
  POLLING_PROFILES, getPollingProfile, TRACKING_PROFILES, PROCESSING_CONFIG,
  ADAPTIVE_MODE_RANK, ADAPTIVE_MODE_RULES, POLLING_ESCALATION_MIN_SAMPLES, desiredPollingProfile,
  decideProfileRequest, REQUESTED_PROFILE_KEY, TRACKING_SESSION_KEY, createSessionId,
  HISTORY_WINDOW_MIN_FIXES, HISTORY_WINDOW_MS,
  LOCATION_TASK_NAME, APP_STATE_KEY, ACTIVE_PROFILE_KEY, TRACKING_MODE_KEY,
  MATCHER_ENDPOINT, MATCHER_PROFILE_BY_MODE, MATCHER_VERSION, MAP_MATCH_CONFIDENCE, ELEVATION_CONFIG,
};
