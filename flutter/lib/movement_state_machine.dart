import 'dart:math' as math;

// Pure movement-detection state machine: STATIONARY <-> CONFIRMING_MOVEMENT <-> MOVING <-> CONFIRMING_STOP.
// No I/O, no platform APIs - mirrors movementStateMachine.js in the react-native app 1:1 so both
// apps make the same movement decisions for equivalent input data.

const double minNoiseFloorM = 15;
const int confirmationCount = 2;
const double bearingToleranceDeg = 45;
const double minBearingDistanceM = 25;
const double minConfirmedSpeedMps = 1.2;
const double maxUsableAccuracyForSpeedM = 100;
const int stationaryConfirmationCount = 2;

// weight = 1/accuracy^2 (see foldFixIntoAnchor) must never see 0/NaN/Infinity/negative - any of
// those either throws, divides by zero, or silently poisons the anchor average. Invalid or unknown
// accuracy (represented as NaN, since LocationFix.accuracy is a non-nullable double) is treated as
// *very uncertain* (large fallback -> near-zero weight), never as falsely precise: inventing fake
// precision from missing data is worse than a fix barely counting.
const double minAccuracyFloorM = 1;
const double invalidAccuracyFallbackM = 1000;

double sanitizeAccuracy(double accuracy) {
  if (!accuracy.isFinite || accuracy <= 0) {
    return invalidAccuracyFallbackM;
  }
  return math.max(accuracy, minAccuracyFloorM);
}

const double _earthRadiusM = 6371000;

abstract class GeoPoint {
  double get lat;
  double get lon;
  double get accuracy;
}

class LocationFix implements GeoPoint {
  @override
  final double lat;
  @override
  final double lon;
  @override
  final double accuracy;
  final double? speed;
  final int? timestampMs;

  const LocationFix({
    required this.lat,
    required this.lon,
    required this.accuracy,
    this.speed,
    this.timestampMs,
  });

  LocationFix copyWith({double? accuracy}) => LocationFix(
        lat: lat,
        lon: lon,
        accuracy: accuracy ?? this.accuracy,
        speed: speed,
        timestampMs: timestampMs,
      );
}

class Anchor implements GeoPoint {
  @override
  final double lat;
  @override
  final double lon;
  @override
  final double accuracy;
  final double totalWeight;

  const Anchor({required this.lat, required this.lon, required this.accuracy, required this.totalWeight});
}

class MovementState {
  final String state;
  final Anchor? anchor;
  final List<LocationFix> candidateStreak;
  final LocationFix? lastMovingFix;
  final List<LocationFix> stopStreak;
  final int? stationarySinceMs;
  final double? processedLat;
  final double? processedLon;

  const MovementState({
    required this.state,
    this.anchor,
    this.candidateStreak = const [],
    this.lastMovingFix,
    this.stopStreak = const [],
    this.stationarySinceMs,
    this.processedLat,
    this.processedLon,
  });
}

double haversineDistanceMeters(GeoPoint a, GeoPoint b) {
  double toRad(double deg) => deg * math.pi / 180;
  final dLat = toRad(b.lat - a.lat);
  final dLon = toRad(b.lon - a.lon);
  final lat1 = toRad(a.lat);
  final lat2 = toRad(b.lat);
  final sinDLat = math.sin(dLat / 2);
  final sinDLon = math.sin(dLon / 2);
  final h = sinDLat * sinDLat + math.cos(lat1) * math.cos(lat2) * sinDLon * sinDLon;
  return 2 * _earthRadiusM * math.asin(math.sqrt(h));
}

double initialBearingDegrees(GeoPoint a, GeoPoint b) {
  double toRad(double deg) => deg * math.pi / 180;
  final lat1 = toRad(a.lat);
  final lat2 = toRad(b.lat);
  final dLon = toRad(b.lon - a.lon);
  final y = math.sin(dLon) * math.cos(lat2);
  final x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dLon);
  final deg = math.atan2(y, x) * 180 / math.pi;
  return (deg + 360) % 360;
}

double circularBearingDiffDeg(double b1, double b2) {
  final diff = (b1 - b2).abs() % 360;
  return diff > 180 ? 360 - diff : diff;
}

double computeNoiseThresholdM(double accuracyA, double accuracyB) {
  return math.max(accuracyA, accuracyB) + minNoiseFloorM;
}

// Bundles the distance+threshold pair transition functions each compute against a reference
// point (anchor or last-moving-fix) - pure code reuse, not a new decision rule. `fix.accuracy`
// is sanitized here so every call site gets the same invalid-accuracy handling for free.
class FixMetrics {
  final double distanceM;
  final double thresholdM;
  const FixMetrics({required this.distanceM, required this.thresholdM});
}

FixMetrics computeFixMetrics(GeoPoint referencePoint, LocationFix fix) {
  final sanitizedFix = fix.copyWith(accuracy: sanitizeAccuracy(fix.accuracy));
  return FixMetrics(
    distanceM: haversineDistanceMeters(referencePoint, sanitizedFix),
    thresholdM: computeNoiseThresholdM(referencePoint.accuracy, sanitizedFix.accuracy),
  );
}

bool passesBearingCheck(double segmentDistanceM, double bearingDiffDeg) {
  if (segmentDistanceM < minBearingDistanceM) return true;
  return bearingDiffDeg <= bearingToleranceDeg;
}

bool _isSpeedConfirmed(LocationFix fix) {
  return fix.speed != null &&
      fix.speed!.isFinite &&
      fix.speed! >= minConfirmedSpeedMps &&
      fix.accuracy <= maxUsableAccuracyForSpeedM;
}

Anchor foldFixIntoAnchor(Anchor? anchor, LocationFix fix) {
  final accuracy = sanitizeAccuracy(fix.accuracy);
  final weight = 1 / (accuracy * accuracy);
  if (anchor == null) {
    return Anchor(lat: fix.lat, lon: fix.lon, accuracy: accuracy, totalWeight: weight);
  }
  final totalWeight = anchor.totalWeight + weight;
  return Anchor(
    lat: (anchor.lat * anchor.totalWeight + fix.lat * weight) / totalWeight,
    lon: (anchor.lon * anchor.totalWeight + fix.lon * weight) / totalWeight,
    accuracy: 1 / math.sqrt(totalWeight),
    totalWeight: totalWeight,
  );
}

// Graduated smoothing of the *displayed/stored* processed point, layered on top of the anchor
// above (which is unchanged: STATIONARY keeps its own accuracy-weighted averaging - already
// "strong" smoothing). The other three states blend the previous processed point toward the new
// raw fix by `alpha` (closer to 1 = follows raw more closely). This damps a single-fix sideways
// GPS jump without making the trail lag behind real movement.
const double confirmingMovementSmoothingAlpha = 0.5;
const double movingSmoothingAlpha = 0.8;
const double confirmingStopSmoothingAlpha = 0.5;

// blendPoint's alpha above was a flat rate regardless of how uncertain the incoming fix was -
// field data showed a single 85m-accuracy fix (above this reference) yank the displayed trail
// 251m off anchor, the same as a good 10m fix would. Unlike the STATIONARY anchor (already
// accuracy-weighted via foldFixIntoAnchor), reuse minNoiseFloorM as the "trustworthy" accuracy
// reference: at or below it, alpha is unchanged (every existing fixture uses <=15m fixes here,
// so this is additive, not a behavior change for normal fixes); above it, alpha shrinks in
// proportion to how much worse the fix is, so a degraded reading pulls the trail less.
const double blendAccuracyReferenceM = minNoiseFloorM;

double _accuracyWeightedAlpha(double baseAlpha, double accuracy) {
  return baseAlpha * math.min(1.0, blendAccuracyReferenceM / accuracy);
}

({double lat, double lon}) blendPoint(({double lat, double lon}) prev, GeoPoint next, double alpha) {
  return (
    lat: prev.lat + (next.lat - prev.lat) * alpha,
    lon: prev.lon + (next.lon - prev.lon) * alpha,
  );
}

MovementState createInitialMovementState() {
  return const MovementState(state: 'STATIONARY');
}

MovementState _toMoving(LocationFix fix, ({double lat, double lon})? prevProcessed) {
  final processed = prevProcessed != null
      ? blendPoint(prevProcessed, fix, _accuracyWeightedAlpha(movingSmoothingAlpha, fix.accuracy))
      : (lat: fix.lat, lon: fix.lon);
  return MovementState(
    state: 'MOVING',
    lastMovingFix: fix,
    processedLat: processed.lat,
    processedLon: processed.lon,
  );
}

({double lat, double lon})? _prevProcessed(MovementState prev) {
  if (prev.processedLat == null || prev.processedLon == null) return null;
  return (lat: prev.processedLat!, lon: prev.processedLon!);
}

MovementState _processStationary(MovementState prev, LocationFix fix) {
  if (prev.anchor == null) {
    final anchor = foldFixIntoAnchor(null, fix);
    return MovementState(
      state: 'STATIONARY',
      anchor: anchor,
      stationarySinceMs: fix.timestampMs,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    );
  }
  final metrics = computeFixMetrics(prev.anchor!, fix);
  if (metrics.distanceM <= metrics.thresholdM) {
    final anchor = foldFixIntoAnchor(prev.anchor, fix);
    return MovementState(
      state: 'STATIONARY',
      anchor: anchor,
      stationarySinceMs: prev.stationarySinceMs,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    );
  }
  if (_isSpeedConfirmed(fix)) {
    return _toMoving(fix, _prevProcessed(prev));
  }
  final processed = blendPoint(
      _prevProcessed(prev)!,
      fix,
      _accuracyWeightedAlpha(confirmingMovementSmoothingAlpha, fix.accuracy),
    );
  return MovementState(
    state: 'CONFIRMING_MOVEMENT',
    anchor: prev.anchor,
    candidateStreak: [fix],
    stationarySinceMs: prev.stationarySinceMs,
    processedLat: processed.lat,
    processedLon: processed.lon,
  );
}

MovementState _processConfirmingMovement(MovementState prev, LocationFix fix) {
  final anchorMetrics = computeFixMetrics(prev.anchor!, fix);
  if (anchorMetrics.distanceM <= anchorMetrics.thresholdM) {
    // Fell back inside the original anchor's noise circle: GPS jump-and-return, not movement.
    final anchor = foldFixIntoAnchor(prev.anchor, fix);
    return MovementState(
      state: 'STATIONARY',
      anchor: anchor,
      stationarySinceMs: prev.stationarySinceMs,
      processedLat: anchor.lat,
      processedLon: anchor.lon,
    );
  }
  if (_isSpeedConfirmed(fix)) {
    return _toMoving(fix, _prevProcessed(prev));
  }

  final streak = [...prev.candidateStreak, fix];
  if (streak.length >= confirmationCount) {
    final prevCandidate = streak[streak.length - 2];
    final segmentDistance = haversineDistanceMeters(prevCandidate, fix);
    final b1 = initialBearingDegrees(prev.anchor!, prevCandidate);
    final b2 = initialBearingDegrees(prevCandidate, fix);
    final bearingDiff = circularBearingDiffDeg(b1, b2);
    if (passesBearingCheck(segmentDistance, bearingDiff)) {
      return _toMoving(fix, _prevProcessed(prev));
    }
    // Inconsistent direction: not a confirmed move yet. Restart the confirmation window from
    // this fix rather than growing it unboundedly - an erratic streak never converges.
    final processed = blendPoint(
      _prevProcessed(prev)!,
      fix,
      _accuracyWeightedAlpha(confirmingMovementSmoothingAlpha, fix.accuracy),
    );
    return MovementState(
      state: 'CONFIRMING_MOVEMENT',
      anchor: prev.anchor,
      candidateStreak: [fix],
      stationarySinceMs: prev.stationarySinceMs,
      processedLat: processed.lat,
      processedLon: processed.lon,
    );
  }
  final processed = blendPoint(
      _prevProcessed(prev)!,
      fix,
      _accuracyWeightedAlpha(confirmingMovementSmoothingAlpha, fix.accuracy),
    );
  return MovementState(
    state: 'CONFIRMING_MOVEMENT',
    anchor: prev.anchor,
    candidateStreak: streak,
    stationarySinceMs: prev.stationarySinceMs,
    processedLat: processed.lat,
    processedLon: processed.lon,
  );
}

MovementState _processMoving(MovementState prev, LocationFix fix) {
  final metrics = computeFixMetrics(prev.lastMovingFix!, fix);
  if (metrics.distanceM <= metrics.thresholdM) {
    final processed = blendPoint(
      _prevProcessed(prev)!,
      fix,
      _accuracyWeightedAlpha(confirmingStopSmoothingAlpha, fix.accuracy),
    );
    return MovementState(
      state: 'CONFIRMING_STOP',
      lastMovingFix: prev.lastMovingFix,
      stopStreak: [fix],
      processedLat: processed.lat,
      processedLon: processed.lon,
    );
  }
  return _toMoving(fix, _prevProcessed(prev));
}

MovementState _processConfirmingStop(MovementState prev, LocationFix fix) {
  final last = prev.stopStreak.last;
  final metrics = computeFixMetrics(last, fix);
  if (metrics.distanceM > metrics.thresholdM) {
    // Moved again before the stop was confirmed.
    return _toMoving(fix, _prevProcessed(prev));
  }
  final streak = [...prev.stopStreak, fix];
  if (streak.length >= stationaryConfirmationCount) {
    Anchor? anchor;
    for (final f in streak) {
      anchor = foldFixIntoAnchor(anchor, f);
    }
    return MovementState(
      state: 'STATIONARY',
      anchor: anchor,
      stationarySinceMs: streak.first.timestampMs,
      processedLat: anchor!.lat,
      processedLon: anchor.lon,
    );
  }
  final processed = blendPoint(
      _prevProcessed(prev)!,
      fix,
      _accuracyWeightedAlpha(confirmingStopSmoothingAlpha, fix.accuracy),
    );
  return MovementState(
    state: 'CONFIRMING_STOP',
    lastMovingFix: prev.lastMovingFix,
    stopStreak: streak,
    processedLat: processed.lat,
    processedLon: processed.lon,
  );
}

// Position to display/store for a fix - already computed as part of the state transition above
// (see the graduated-smoothing comment). Kept as its own accessor so callers don't need to know
// about the `processedLat`/`processedLon` field names.
({double? lat, double? lon}) getProcessedLocation(MovementState state) {
  return (lat: state.processedLat, lon: state.processedLon);
}

double getDistanceFromAnchorM(MovementState state, LocationFix fix) {
  if (state.anchor == null) return 0;
  return haversineDistanceMeters(state.anchor!, fix);
}

// 0-100 confidence score for a single fix - NOT a re-statement of accuracy-in-meters, and NOT a
// claim that processing made the underlying GPS measurement more physically precise. A 40m-accuracy
// fix folded into a rock-stable anchor is still only worth as much trust as a 40m fix; the anchor
// looking stable on screen doesn't mean the original measurement became a 3m-accurate one.
// Dominated by sanitized accuracy (tighter = higher), with a penalty while the movement state
// machine hasn't yet corroborated this fix with enough consecutive evidence (CONFIRMING_* states) -
// that corroboration already *is* the distance/speed/bearing consistency check from Section 1, so
// quality reads its verdict rather than re-deriving consistency separately.
const int qualityUnconfirmedPenalty = 10;

int getLocationQuality(MovementState state, LocationFix fix) {
  final accuracy = sanitizeAccuracy(fix.accuracy);
  var score = 100 - accuracy;
  if (state.state == 'CONFIRMING_MOVEMENT' || state.state == 'CONFIRMING_STOP') {
    score -= qualityUnconfirmedPenalty;
  }
  return score.clamp(0, 100).round();
}

// Adaptive polling tiers - see docs/superpowers/specs/2026-08-17-continuous-location-cache-design.md
// ("Adaptive polling frequency") for the rationale. Not used as a movement signal (Section 1,
// rule 5) - only chooses how often to ask for the next fix. MOVING tier is 10s/20s (not the
// original 15s/30s design default) - chosen over a more aggressive 5s/10s to keep the responsiveness
// win from Change 5 without tripling foreground battery cost while actively tracking.
const int movingIntervalForegroundMs = 10000;
const int movingIntervalBackgroundMs = 20000;
const int stationaryIntervalForegroundMs = 60000;
const int stationaryIntervalBackgroundMs = 90000;
const int longStationaryThresholdMs = 5 * 60 * 1000;
const int longStationaryIntervalForegroundMs = 180000;
const int longStationaryIntervalBackgroundMs = 300000;

int computePollingIntervalMs(MovementState state, int nowMs, String appState) {
  final isBackground = appState == 'background';
  if (state.state != 'STATIONARY') {
    return isBackground ? movingIntervalBackgroundMs : movingIntervalForegroundMs;
  }
  final stationaryDurationMs =
      state.stationarySinceMs != null ? math.max(0, nowMs - state.stationarySinceMs!) : 0;
  if (stationaryDurationMs >= longStationaryThresholdMs) {
    return isBackground ? longStationaryIntervalBackgroundMs : longStationaryIntervalForegroundMs;
  }
  return isBackground ? stationaryIntervalBackgroundMs : stationaryIntervalForegroundMs;
}

// Movement state also implies a desired GPS *precision* mode, not just cadence (Change 4): high
// accuracy while there's any chance of movement, balanced/default accuracy once settled STATIONARY
// (the OS/hardware still decides what it can actually deliver - this only requests, it doesn't
// guarantee, better fixes).
const Set<String> highAccuracyStates = {'MOVING', 'CONFIRMING_MOVEMENT', 'CONFIRMING_STOP'};

bool wantsHighAccuracy(MovementState state) => highAccuracyStates.contains(state.state);

// Tags rows produced by this version of the processing pipeline (Round 3, item 6) - lets future
// changes to the formulas above be told apart from older stored rows without guessing from dates.
const int processingVersion = 2;

// JSON (de)serialization - lets the background service persist MovementState across ticks
// (SharedPreferences only stores primitives/strings, not Dart objects).
Map<String, dynamic> anchorToJson(Anchor a) =>
    {'lat': a.lat, 'lon': a.lon, 'accuracy': a.accuracy, 'totalWeight': a.totalWeight};

Anchor anchorFromJson(Map<String, dynamic> j) => Anchor(
      lat: (j['lat'] as num).toDouble(),
      lon: (j['lon'] as num).toDouble(),
      accuracy: (j['accuracy'] as num).toDouble(),
      totalWeight: (j['totalWeight'] as num).toDouble(),
    );

Map<String, dynamic> fixToJson(LocationFix f) =>
    {'lat': f.lat, 'lon': f.lon, 'accuracy': f.accuracy, 'speed': f.speed, 'timestampMs': f.timestampMs};

LocationFix fixFromJson(Map<String, dynamic> j) => LocationFix(
      lat: (j['lat'] as num).toDouble(),
      lon: (j['lon'] as num).toDouble(),
      accuracy: (j['accuracy'] as num).toDouble(),
      speed: j['speed'] != null ? (j['speed'] as num).toDouble() : null,
      timestampMs: j['timestampMs'] != null ? (j['timestampMs'] as num).toInt() : null,
    );

Map<String, dynamic> movementStateToJson(MovementState s) => {
      'state': s.state,
      'anchor': s.anchor != null ? anchorToJson(s.anchor!) : null,
      'candidateStreak': s.candidateStreak.map(fixToJson).toList(),
      'lastMovingFix': s.lastMovingFix != null ? fixToJson(s.lastMovingFix!) : null,
      'stopStreak': s.stopStreak.map(fixToJson).toList(),
      'stationarySinceMs': s.stationarySinceMs,
      'processedLat': s.processedLat,
      'processedLon': s.processedLon,
    };

MovementState movementStateFromJson(Map<String, dynamic> j) => MovementState(
      state: j['state'] as String,
      anchor: j['anchor'] != null ? anchorFromJson(j['anchor'] as Map<String, dynamic>) : null,
      candidateStreak: (j['candidateStreak'] as List)
          .map((e) => fixFromJson(e as Map<String, dynamic>))
          .toList(),
      lastMovingFix:
          j['lastMovingFix'] != null ? fixFromJson(j['lastMovingFix'] as Map<String, dynamic>) : null,
      stopStreak:
          (j['stopStreak'] as List).map((e) => fixFromJson(e as Map<String, dynamic>)).toList(),
      stationarySinceMs: j['stationarySinceMs'] != null ? (j['stationarySinceMs'] as num).toInt() : null,
      processedLat: j['processedLat'] != null ? (j['processedLat'] as num).toDouble() : null,
      processedLon: j['processedLon'] != null ? (j['processedLon'] as num).toDouble() : null,
    );

MovementState processLocationFix(MovementState prevState, LocationFix rawFix) {
  final fix = rawFix.copyWith(accuracy: sanitizeAccuracy(rawFix.accuracy));
  switch (prevState.state) {
    case 'STATIONARY':
      return _processStationary(prevState, fix);
    case 'CONFIRMING_MOVEMENT':
      return _processConfirmingMovement(prevState, fix);
    case 'MOVING':
      return _processMoving(prevState, fix);
    case 'CONFIRMING_STOP':
      return _processConfirmingStop(prevState, fix);
    default:
      throw StateError('Unknown movement state: ${prevState.state}');
  }
}
