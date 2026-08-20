import 'dart:math' as math;

import 'movement_state_machine.dart';

// Pure trajectory-validation / outlier-rejection layer: runs BEFORE a fix is allowed to update
// lastAcceptedFix, feed the movement state machine (movement_state_machine.dart), or enter the
// processed trail. Mirrors react-native/trajectoryValidator.js 1:1, same convention as
// movement_state_machine.dart mirroring movementStateMachine.js. No I/O, no platform APIs.
//
// Design doc: docs/superpowers/plans/changes.md (STEP1-21).

class TrajectoryDecision {
  static const String accepted = 'ACCEPTED';
  static const String outlier = 'OUTLIER';
  static const String uncertain = 'UNCERTAIN';
}

class OutlierReason {
  static const String impossibleSpeed = 'IMPOSSIBLE_SPEED';
  static const String excessiveDisplacement = 'EXCESSIVE_DISPLACEMENT';
  static const String bearingInconsistency = 'BEARING_INCONSISTENCY';
  static const String lowConfidence = 'LOW_CONFIDENCE';
  static const String duplicateOrOutOfOrder = 'DUPLICATE_OR_OUT_OF_ORDER';
  static const String staleAnchorRecovering = 'STALE_ANCHOR_RECOVERING';
  static const String staleAnchorReanchored = 'STALE_ANCHOR_REANCHORED';
  static const String uncertainConfirmed = 'UNCERTAIN_CONFIRMED';
}

class MovementMode {
  static const String walking = 'WALKING';
  static const String cycling = 'CYCLING';
  static const String vehicle = 'VEHICLE';
  static const String unknown = 'UNKNOWN';
}

// Step7: rolling window of the last N accepted fixes' implied speeds used to infer mode. N=5
// chosen against the existing MOVING adaptive-poll tier (10s foreground / 20s background, see
// movement_state_machine.dart) - 5 fixes covers roughly 50-100s of recent movement: long enough
// to average out a single noisy fix, short enough to react to a genuine mode change within about
// a minute or two.
const int modeSpeedWindowN = 5;
// Mode only switches after this many consecutive fixes support the new candidate band - stops a
// single borderline-speed fix flickering the inferred mode back and forth (Step7: "never switch
// mode based on a single fix").
const int modeSwitchConfirmCount = 3;

// Step7 approximate mode-inference bands, in m/s. The source doc's illustrative ranges
// (~1-2 walking, ~3-8 cycling, ~8+ vehicle) leave a 2-3 gap; resolved here as two cut points so
// every average speed maps to exactly one candidate.
const double walkingModeMaxMps = 2.2;
const double cyclingModeMaxMps = 8;
// Above cyclingModeMaxMps => VEHICLE candidate.

// Step8: speed ceiling used for the *plausibility gate* (distinct from the mode-inference bands
// above) - deliberately looser than the inference bands themselves, since a fix can legitimately
// run faster than its mode's "typical" band (e.g. downhill cycling) without being an outlier.
const double walkingMaxSpeedMps = 3.5; // ~12.6 km/h - brisk-jog headroom before flip to cycling.
const double cyclingMaxSpeedMps = 11; // ~40 km/h - fast cycling / e-bike.
// 150 km/h - matches map_points.dart's maxSpeedKmh absolute ceiling, so this validator's upstream
// gate and the map's downstream render-time filter agree on what "impossible" means here.
const double vehicleMaxSpeedMps = 150 / 3.6;
// UNKNOWN mode (no accepted history yet, or mode not yet confirmed): conservative-but-not-
// restrictive per Step7/21 - same ceiling as VEHICLE rather than a stricter one, so a legitimate
// fast car trip is never rejected just because mode inference hasn't caught up yet.
const double unknownMaxSpeedMps = vehicleMaxSpeedMps;

// Step8: displacement is allowed to exceed ceilingSpeed*elapsedTime by this factor before being
// treated as suspicious at all - real speeds burst above a "typical" steady-state ceiling
// (accelerating, downhill, tailwind).
const double displacementMargin = 1.3;
// Beyond maxPlausibleDistance * outlierMultiplier, a fix is OUTLIER rather than UNCERTAIN.
const double outlierMultiplier = 1.5;

// Step8 stale-anchor exception. 120s matches the existing signalGapThresholdMs convention
// (logger.dart) already used elsewhere in this codebase for "signal has been gone too long" -
// reusing it keeps one mental model for "how long is too long" across the app.
const int staleAnchorThresholdMs = 120000;
const int staleAnchorStreakN = 3;

// Step12: an UNCERTAIN fix not confirmed within this many subsequent fixes is dropped from the
// pending buffer (resolved-to-outlier for anchoring purposes).
const int uncertainConfirmTimeoutFixes = 2;

// Step9/11: a fix within this fraction of its own ceiling is "borderline" - only a borderline
// ACCEPTED/UNCERTAIN decision can be downgraded by a disagreeing secondary signal (bearing/GPS
// speed). A comfortably-plausible fix is never downgraded by a sharp turn or noisy GPS speed
// alone (Step11: "a sharp turn alone...must NOT be rejected").
const double borderlineRatio = 0.8;
const double speedDisagreementRatio = 0.6;
const double speedDisagreementSlackMps = 2;

double _ceilingForMode(String mode) {
  switch (mode) {
    case MovementMode.walking:
      return walkingMaxSpeedMps;
    case MovementMode.cycling:
      return cyclingMaxSpeedMps;
    case MovementMode.vehicle:
      return vehicleMaxSpeedMps;
    default:
      return unknownMaxSpeedMps;
  }
}

String _candidateModeForAvgSpeed(double? avgSpeedMps) {
  if (avgSpeedMps == null) return MovementMode.unknown;
  if (avgSpeedMps <= walkingModeMaxMps) return MovementMode.walking;
  if (avgSpeedMps <= cyclingModeMaxMps) return MovementMode.cycling;
  return MovementMode.vehicle;
}

double? _averageSpeed(List<double> history) {
  if (history.isEmpty) return null;
  return history.reduce((a, b) => a + b) / history.length;
}

class TrajectoryFix implements GeoPoint {
  @override
  final double lat;
  @override
  final double lon;
  @override
  final double accuracy;
  final double? speed;
  final int timestampMs;

  const TrajectoryFix({
    required this.lat,
    required this.lon,
    required this.accuracy,
    this.speed,
    required this.timestampMs,
  });

  TrajectoryFix copyWith({double? accuracy}) => TrajectoryFix(
        lat: lat,
        lon: lon,
        accuracy: accuracy ?? this.accuracy,
        speed: speed,
        timestampMs: timestampMs,
      );

  Map<String, dynamic> toJson() => {'lat': lat, 'lon': lon, 'accuracy': accuracy, 'speed': speed, 'timestampMs': timestampMs};

  static TrajectoryFix fromJson(Map<String, dynamic> j) => TrajectoryFix(
        lat: (j['lat'] as num).toDouble(),
        lon: (j['lon'] as num).toDouble(),
        accuracy: (j['accuracy'] as num).toDouble(),
        speed: j['speed'] != null ? (j['speed'] as num).toDouble() : null,
        timestampMs: (j['timestampMs'] as num).toInt(),
      );
}

class PendingUncertainFix {
  final TrajectoryFix fix;
  final int age;
  final bool staleRecovery;
  const PendingUncertainFix({required this.fix, required this.age, required this.staleRecovery});
}

class TrajectoryState {
  final TrajectoryFix? lastAcceptedFix;
  final TrajectoryFix? prevAcceptedFix;
  final List<double> speedHistory;
  final String mode;
  final int modeStreak;
  final String? candidateMode;
  final PendingUncertainFix? pendingUncertain;
  final int outlierStreak;

  const TrajectoryState({
    this.lastAcceptedFix,
    this.prevAcceptedFix,
    this.speedHistory = const [],
    this.mode = MovementMode.unknown,
    this.modeStreak = 0,
    this.candidateMode,
    this.pendingUncertain,
    this.outlierStreak = 0,
  });

  TrajectoryState copyWith({
    TrajectoryFix? lastAcceptedFix,
    bool clearLastAcceptedFix = false,
    TrajectoryFix? prevAcceptedFix,
    bool clearPrevAcceptedFix = false,
    List<double>? speedHistory,
    String? mode,
    int? modeStreak,
    String? candidateMode,
    bool clearCandidateMode = false,
    PendingUncertainFix? pendingUncertain,
    bool clearPendingUncertain = false,
    int? outlierStreak,
  }) {
    return TrajectoryState(
      lastAcceptedFix: clearLastAcceptedFix ? null : (lastAcceptedFix ?? this.lastAcceptedFix),
      prevAcceptedFix: clearPrevAcceptedFix ? null : (prevAcceptedFix ?? this.prevAcceptedFix),
      speedHistory: speedHistory ?? this.speedHistory,
      mode: mode ?? this.mode,
      modeStreak: modeStreak ?? this.modeStreak,
      candidateMode: clearCandidateMode ? null : (candidateMode ?? this.candidateMode),
      pendingUncertain: clearPendingUncertain ? null : (pendingUncertain ?? this.pendingUncertain),
      outlierStreak: outlierStreak ?? this.outlierStreak,
    );
  }
}

TrajectoryState createInitialTrajectoryState() => const TrajectoryState();

class TrajectoryResult {
  final String decision;
  final String? reason;
  final double? distanceFromLastAcceptedM;
  final double? impliedSpeedMps;
  final String movementMode;

  const TrajectoryResult({
    required this.decision,
    this.reason,
    this.distanceFromLastAcceptedM,
    this.impliedSpeedMps,
    required this.movementMode,
  });
}

class TrajectoryOutcome {
  final TrajectoryState newState;
  final TrajectoryResult result;
  const TrajectoryOutcome({required this.newState, required this.result});
}

// Step7: hysteresis - a new candidate mode must win modeSwitchConfirmCount consecutive times
// (via the rolling speed window) before it actually replaces the confirmed mode.
({List<double> speedHistory, String mode, int modeStreak, String? candidateMode}) _updateMode(
    TrajectoryState trajState, double impliedSpeedMps) {
  final speedHistory = [...trajState.speedHistory, impliedSpeedMps];
  if (speedHistory.length > modeSpeedWindowN) {
    speedHistory.removeRange(0, speedHistory.length - modeSpeedWindowN);
  }
  final candidate = _candidateModeForAvgSpeed(_averageSpeed(speedHistory));
  if (candidate == trajState.mode) {
    return (speedHistory: speedHistory, mode: trajState.mode, modeStreak: 0, candidateMode: null);
  }
  final modeStreak = candidate == trajState.candidateMode ? trajState.modeStreak + 1 : 1;
  if (modeStreak >= modeSwitchConfirmCount) {
    return (speedHistory: speedHistory, mode: candidate, modeStreak: 0, candidateMode: null);
  }
  return (speedHistory: speedHistory, mode: trajState.mode, modeStreak: modeStreak, candidateMode: candidate);
}

class TrajectoryMetrics {
  final double distanceM;
  final int elapsedMs;
  final double impliedSpeedMps;
  const TrajectoryMetrics({required this.distanceM, required this.elapsedMs, required this.impliedSpeedMps});
}

TrajectoryMetrics computeTrajectoryMetrics(TrajectoryFix refFix, TrajectoryFix fix) {
  final distanceM = haversineDistanceMeters(refFix, fix);
  final elapsedMs = fix.timestampMs - refFix.timestampMs;
  final elapsedSec = math.max(elapsedMs, 1) / 1000;
  final impliedSpeedMps = distanceM / elapsedSec;
  return TrajectoryMetrics(distanceM: distanceM, elapsedMs: elapsedMs, impliedSpeedMps: impliedSpeedMps);
}

// Step6/8/10: dynamic ceiling - scales with elapsed time, inferred mode, and both fixes'
// accuracy. Never a single fixed cutoff. Reuses computeNoiseThresholdM (movement_state_machine)
// for the accuracy-slack term, so poor accuracy on either fix widens the plausible band exactly
// the same way it already widens the movement state machine's own noise threshold.
double _maxPlausibleDistanceM(TrajectoryFix refFix, TrajectoryFix fix, double elapsedSec, String mode) {
  final ceiling = _ceilingForMode(mode);
  final accuracySlackM = computeNoiseThresholdM(sanitizeAccuracy(refFix.accuracy), sanitizeAccuracy(fix.accuracy));
  return ceiling * elapsedSec * displacementMargin + accuracySlackM;
}

bool _speedsDisagree(TrajectoryFix fix, double impliedSpeedMps) {
  final gpsSpeed = fix.speed;
  if (gpsSpeed == null || !gpsSpeed.isFinite || gpsSpeed < 0) return false;
  final diff = (gpsSpeed - impliedSpeedMps).abs();
  final tolerance = math.max(gpsSpeed, impliedSpeedMps) * speedDisagreementRatio + speedDisagreementSlackMps;
  return diff > tolerance;
}

bool _bearingInconsistent(TrajectoryFix? prevFix, TrajectoryFix refFix, TrajectoryFix fix, double segmentDistanceM) {
  if (prevFix == null) return false;
  if (segmentDistanceM < minBearingDistanceM) return false;
  final b1 = initialBearingDegrees(prevFix, refFix);
  final b2 = initialBearingDegrees(refFix, fix);
  return circularBearingDiffDeg(b1, b2) > bearingToleranceDeg;
}

// Step2/6/8/9/10/11: the core three-outcome plausibility check between a reference fix and a
// candidate fix. Bearing/GPS-speed disagreement (Step9/11) only ever downgrade an already-
// borderline decision - never reject a comfortably-plausible fix on their own.
({String decision, String? reason, double distanceM, double impliedSpeedMps}) _classifyAgainstReference({
  required TrajectoryFix refFix,
  required TrajectoryFix? prevFix,
  required TrajectoryFix fix,
  required String mode,
}) {
  final metrics = computeTrajectoryMetrics(refFix, fix);
  final elapsedSec = metrics.elapsedMs / 1000;
  final maxPlausibleM = _maxPlausibleDistanceM(refFix, fix, elapsedSec, mode);
  final outlierCeilingM = maxPlausibleM * outlierMultiplier;

  String decision;
  String? reason;
  if (metrics.distanceM > outlierCeilingM) {
    decision = TrajectoryDecision.outlier;
    reason = metrics.impliedSpeedMps > _ceilingForMode(mode) * outlierMultiplier
        ? OutlierReason.impossibleSpeed
        : OutlierReason.excessiveDisplacement;
  } else if (metrics.distanceM > maxPlausibleM) {
    decision = TrajectoryDecision.uncertain;
    reason = OutlierReason.lowConfidence;
  } else {
    decision = TrajectoryDecision.accepted;
  }

  final borderline = metrics.distanceM >= maxPlausibleM * borderlineRatio;
  if (borderline && decision != TrajectoryDecision.outlier) {
    final disagree = _speedsDisagree(fix, metrics.impliedSpeedMps) ||
        _bearingInconsistent(prevFix, refFix, fix, metrics.distanceM);
    if (disagree) {
      if (decision == TrajectoryDecision.accepted) {
        decision = TrajectoryDecision.uncertain;
        reason = OutlierReason.lowConfidence;
      } else {
        decision = TrajectoryDecision.outlier;
        reason = OutlierReason.bearingInconsistency;
      }
    }
  }

  return (decision: decision, reason: reason, distanceM: metrics.distanceM, impliedSpeedMps: metrics.impliedSpeedMps);
}

TrajectoryOutcome _acceptFix(
    TrajectoryState trajState, TrajectoryFix fix, String? reason, double? distanceM, double? impliedSpeedMps) {
  final modeUpdate = impliedSpeedMps != null
      ? _updateMode(trajState, impliedSpeedMps)
      : (
          speedHistory: trajState.speedHistory,
          mode: trajState.mode,
          modeStreak: trajState.modeStreak,
          candidateMode: trajState.candidateMode,
        );
  return TrajectoryOutcome(
    newState: trajState.copyWith(
      speedHistory: modeUpdate.speedHistory,
      mode: modeUpdate.mode,
      modeStreak: modeUpdate.modeStreak,
      candidateMode: modeUpdate.candidateMode,
      clearCandidateMode: modeUpdate.candidateMode == null,
      prevAcceptedFix: trajState.lastAcceptedFix,
      clearPrevAcceptedFix: trajState.lastAcceptedFix == null,
      lastAcceptedFix: fix,
      clearPendingUncertain: true,
      outlierStreak: 0,
    ),
    result: TrajectoryResult(
      decision: TrajectoryDecision.accepted,
      reason: reason,
      distanceFromLastAcceptedM: distanceM,
      impliedSpeedMps: impliedSpeedMps,
      movementMode: modeUpdate.mode,
    ),
  );
}

TrajectoryOutcome _outlierFix(
    TrajectoryState trajState, String? reason, double? distanceM, double? impliedSpeedMps) {
  return TrajectoryOutcome(
    newState: trajState.copyWith(outlierStreak: trajState.outlierStreak + 1),
    result: TrajectoryResult(
      decision: TrajectoryDecision.outlier,
      reason: reason,
      distanceFromLastAcceptedM: distanceM,
      impliedSpeedMps: impliedSpeedMps,
      movementMode: trajState.mode,
    ),
  );
}

// Step12/Step8: resolves a held UNCERTAIN fix (or Step8 stale-recovery candidate - same buffer,
// same mechanism) against the newly-arrived fix.
TrajectoryOutcome _resolvePending(TrajectoryState trajState, TrajectoryFix fix) {
  final pending = trajState.pendingUncertain!;

  if (fix.timestampMs <= pending.fix.timestampMs) {
    return _outlierFix(trajState, OutlierReason.duplicateOrOutOfOrder, null, null);
  }

  final vsPending = _classifyAgainstReference(
    refFix: pending.fix,
    prevFix: trajState.prevAcceptedFix,
    fix: fix,
    mode: trajState.mode,
  );

  if (vsPending.decision == TrajectoryDecision.accepted) {
    final reason = pending.staleRecovery ? OutlierReason.staleAnchorReanchored : OutlierReason.uncertainConfirmed;
    return _acceptFix(trajState, fix, reason, vsPending.distanceM, vsPending.impliedSpeedMps);
  }

  if (!pending.staleRecovery && trajState.lastAcceptedFix != null) {
    final vsAnchor = _classifyAgainstReference(
      refFix: trajState.lastAcceptedFix!,
      prevFix: trajState.prevAcceptedFix,
      fix: fix,
      mode: trajState.mode,
    );
    if (vsAnchor.decision == TrajectoryDecision.accepted) {
      return _acceptFix(trajState.copyWith(clearPendingUncertain: true), fix, null, vsAnchor.distanceM, vsAnchor.impliedSpeedMps);
    }
  }

  final age = pending.age + 1;
  if (age > uncertainConfirmTimeoutFixes) {
    return classifyFix(
      trajState.copyWith(clearPendingUncertain: true, outlierStreak: trajState.outlierStreak + 1),
      fix,
    );
  }

  final nextPending = pending.staleRecovery
      ? PendingUncertainFix(fix: fix, age: 0, staleRecovery: true)
      : PendingUncertainFix(fix: pending.fix, age: age, staleRecovery: false);
  return TrajectoryOutcome(
    newState: trajState.copyWith(pendingUncertain: nextPending, outlierStreak: trajState.outlierStreak + 1),
    result: TrajectoryResult(
      decision: TrajectoryDecision.uncertain,
      reason: pending.staleRecovery ? OutlierReason.staleAnchorRecovering : OutlierReason.lowConfidence,
      distanceFromLastAcceptedM: vsPending.distanceM,
      impliedSpeedMps: vsPending.impliedSpeedMps,
      movementMode: trajState.mode,
    ),
  );
}

// Step1-21 entry point. Result carries the Step14/20 diagnostics fields (decision, reason,
// distanceFromLastAcceptedM, impliedSpeedMps, movementMode). Caller must only feed the fix into
// the movement state machine / smoothing / processed trail when result.decision ==
// TrajectoryDecision.accepted (Step2/13/16), and must always store the raw fix regardless of
// decision (Step14).
TrajectoryOutcome classifyFix(TrajectoryState trajState, TrajectoryFix rawFix) {
  final fix = rawFix.copyWith(accuracy: sanitizeAccuracy(rawFix.accuracy));

  if (trajState.lastAcceptedFix == null) {
    return _acceptFix(trajState, fix, null, 0, null);
  }

  // Step3: duplicate/out-of-order guard - never let time run backwards against the anchor.
  if (fix.timestampMs <= trajState.lastAcceptedFix!.timestampMs) {
    return _outlierFix(trajState, OutlierReason.duplicateOrOutOfOrder, null, null);
  }

  if (trajState.pendingUncertain != null) {
    return _resolvePending(trajState, fix);
  }

  // Step8: stale-anchor exception - the reference point is no longer comparable, so stop
  // requiring consistency with it and instead start a mutual-consistency chain between fresh
  // fixes (reuses the same pending-buffer mechanism as Step12's UNCERTAIN resolution).
  final elapsedSinceAcceptedMs = fix.timestampMs - trajState.lastAcceptedFix!.timestampMs;
  final isStale = elapsedSinceAcceptedMs > staleAnchorThresholdMs || trajState.outlierStreak >= staleAnchorStreakN;
  if (isStale) {
    return TrajectoryOutcome(
      newState: trajState.copyWith(pendingUncertain: PendingUncertainFix(fix: fix, age: 0, staleRecovery: true)),
      result: TrajectoryResult(
        decision: TrajectoryDecision.uncertain,
        reason: OutlierReason.staleAnchorRecovering,
        distanceFromLastAcceptedM: haversineDistanceMeters(trajState.lastAcceptedFix!, fix),
        impliedSpeedMps: null,
        movementMode: trajState.mode,
      ),
    );
  }

  final outcome = _classifyAgainstReference(
    refFix: trajState.lastAcceptedFix!,
    prevFix: trajState.prevAcceptedFix,
    fix: fix,
    mode: trajState.mode,
  );

  if (outcome.decision == TrajectoryDecision.accepted) {
    return _acceptFix(trajState, fix, null, outcome.distanceM, outcome.impliedSpeedMps);
  }
  if (outcome.decision == TrajectoryDecision.outlier) {
    return _outlierFix(trajState, outcome.reason, outcome.distanceM, outcome.impliedSpeedMps);
  }
  return TrajectoryOutcome(
    newState: trajState.copyWith(
      pendingUncertain: PendingUncertainFix(fix: fix, age: 0, staleRecovery: false),
      outlierStreak: trajState.outlierStreak + 1,
    ),
    result: TrajectoryResult(
      decision: TrajectoryDecision.uncertain,
      reason: outcome.reason,
      distanceFromLastAcceptedM: outcome.distanceM,
      impliedSpeedMps: outcome.impliedSpeedMps,
      movementMode: trajState.mode,
    ),
  );
}

// Step3: sort a batch of raw fixes chronologically before running them through classifyFix one
// at a time - a background delivery callback must never assume its array arrives in order.
List<TrajectoryFix> sortFixesByTimestamp(List<TrajectoryFix> fixes) {
  final sorted = [...fixes];
  sorted.sort((a, b) => a.timestampMs.compareTo(b.timestampMs));
  return sorted;
}

// JSON (de)serialization - lets the background service persist TrajectoryState across ticks
// (SharedPreferences only stores primitives/strings, not Dart objects).
Map<String, dynamic> trajectoryStateToJson(TrajectoryState s) => {
      'lastAcceptedFix': s.lastAcceptedFix?.toJson(),
      'prevAcceptedFix': s.prevAcceptedFix?.toJson(),
      'speedHistory': s.speedHistory,
      'mode': s.mode,
      'modeStreak': s.modeStreak,
      'candidateMode': s.candidateMode,
      'pendingUncertain': s.pendingUncertain != null
          ? {
              'fix': s.pendingUncertain!.fix.toJson(),
              'age': s.pendingUncertain!.age,
              'staleRecovery': s.pendingUncertain!.staleRecovery,
            }
          : null,
      'outlierStreak': s.outlierStreak,
    };

TrajectoryState trajectoryStateFromJson(Map<String, dynamic> j) => TrajectoryState(
      lastAcceptedFix: j['lastAcceptedFix'] != null ? TrajectoryFix.fromJson(j['lastAcceptedFix'] as Map<String, dynamic>) : null,
      prevAcceptedFix: j['prevAcceptedFix'] != null ? TrajectoryFix.fromJson(j['prevAcceptedFix'] as Map<String, dynamic>) : null,
      speedHistory: (j['speedHistory'] as List).map((e) => (e as num).toDouble()).toList(),
      mode: j['mode'] as String,
      modeStreak: (j['modeStreak'] as num).toInt(),
      candidateMode: j['candidateMode'] as String?,
      pendingUncertain: j['pendingUncertain'] != null
          ? PendingUncertainFix(
              fix: TrajectoryFix.fromJson((j['pendingUncertain'] as Map<String, dynamic>)['fix'] as Map<String, dynamic>),
              age: ((j['pendingUncertain'] as Map<String, dynamic>)['age'] as num).toInt(),
              staleRecovery: (j['pendingUncertain'] as Map<String, dynamic>)['staleRecovery'] as bool,
            )
          : null,
      outlierStreak: (j['outlierStreak'] as num).toInt(),
    );
