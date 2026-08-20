import 'dart:math' as math;

import 'location_task.dart' show maxAccuracyMeters;
import 'movement_state_machine.dart' show longStationaryIntervalBackgroundMs;
import 'trajectory_validator.dart' show TrajectoryDecision;

// Pure GPS-fix -> plot-point pipeline. Mirrors react-native/mapPoints.js 1:1, same convention as
// movement_state_machine.dart mirroring movementStateMachine.js. No I/O, no platform APIs.

const double accuracyThresholdM = maxAccuracyMeters;
// Set above the app's own longest legitimate adaptive-poll interval so normal long-stationary
// polling never falsely reads as a tracking gap - only real outages do.
final int maxGapSeconds = longStationaryIntervalBackgroundMs ~/ 1000 + 60;
const double maxSpeedKmh = 150;

const double _noiseFloorM = 15;
const double _reunionSlack = 1.5;
const double _earthRadiusM = 6371000;

double _haversineM(double lat1, double lon1, double lat2, double lon2) {
  double toRad(double d) => d * math.pi / 180;
  final dLat = toRad(lat2 - lat1);
  final dLon = toRad(lon2 - lon1);
  final a = math.pow(math.sin(dLat / 2), 2) +
      math.cos(toRad(lat1)) * math.cos(toRad(lat2)) * math.pow(math.sin(dLon / 2), 2);
  return 2 * _earthRadiusM * math.asin(math.sqrt(a));
}

double _effectiveAccuracy(double? a) {
  if (a == null || !a.isFinite || a <= 0) return 100;
  return math.min(math.max(a, 3), 250);
}

double _noiseThresholdM(double accA, double accB) => math.max(accA, accB) + _noiseFloorM;

class MapPoint {
  final int? id;
  final int t;
  final double lat;
  final double lon;
  final double effAcc;
  final double? accuracy;
  final String? movementState;
  final String? method;
  final int? batteryPct;
  final String? appState;
  final int? signalDbm;
  final int? signalLevel;
  final String? carrier;
  final String? networkType;
  final int? locationQuality;
  final String? trajectoryDecision;
  final String? outlierReason;
  final String? movementMode;

  int? idx;
  bool isLowAcc = false;
  bool isSpike = false;
  bool isSpeedOutlier = false;
  bool isTrajectoryRejected = false;
  bool excluded = false;
  bool gapBefore = false;
  int runIndex = 0;

  MapPoint({
    required this.id,
    required this.t,
    required this.lat,
    required this.lon,
    required this.accuracy,
    required this.movementState,
    required this.method,
    required this.batteryPct,
    required this.appState,
    required this.signalDbm,
    required this.signalLevel,
    required this.carrier,
    required this.networkType,
    required this.locationQuality,
    this.trajectoryDecision,
    this.outlierReason,
    this.movementMode,
  }) : effAcc = _effectiveAccuracy(accuracy);
}

void _markSpikes(List<MapPoint> points) {
  for (var i = 1; i < points.length - 1; i++) {
    final prev = points[i - 1];
    final cur = points[i];
    final next = points[i + 1];
    final dPrevCur = _haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    final dCurNext = _haversineM(cur.lat, cur.lon, next.lat, next.lon);
    final dPrevNext = _haversineM(prev.lat, prev.lon, next.lat, next.lon);
    cur.isSpike = dPrevCur > _noiseThresholdM(prev.effAcc, cur.effAcc) &&
        dCurNext > _noiseThresholdM(cur.effAcc, next.effAcc) &&
        dPrevNext <= _noiseThresholdM(prev.effAcc, next.effAcc) * _reunionSlack;
  }
}

void _markSpeedOutliers(List<MapPoint> points) {
  MapPoint? prev;
  for (final p in points) {
    if (p.isSpike) continue;
    if (prev != null) {
      final dt = (p.t - prev.t) / 1000;
      if (dt > 0) {
        final kmh = (_haversineM(prev.lat, prev.lon, p.lat, p.lon) / dt) * 3.6;
        if (kmh > maxSpeedKmh) p.isSpeedOutlier = true;
      }
    }
    if (!p.isSpeedOutlier && !p.isLowAcc) prev = p;
  }
}

List<MapPoint> buildMapPoints(List<Map<String, Object?>> rows) {
  final parsed = <MapPoint>[];
  for (final r in rows) {
    final lat = (r['latitude'] as num?)?.toDouble() ?? (r['processed_latitude'] as num?)?.toDouble();
    final lon = (r['longitude'] as num?)?.toDouble() ?? (r['processed_longitude'] as num?)?.toDouble();
    final timestamp = r['timestamp'] as String?;
    final t = timestamp != null ? DateTime.tryParse(timestamp)?.millisecondsSinceEpoch : null;
    if (lat == null || lon == null || t == null) continue;
    parsed.add(MapPoint(
      id: (r['id'] as num?)?.toInt(),
      t: t,
      lat: lat,
      lon: lon,
      accuracy: (r['accuracy'] as num?)?.toDouble(),
      movementState: r['movement_state'] as String?,
      method: r['method'] as String?,
      batteryPct: (r['battery'] as num?)?.toInt(),
      appState: r['app_state'] as String?,
      signalDbm: (r['signal_dbm'] as num?)?.toInt(),
      signalLevel: (r['signal_level'] as num?)?.toInt(),
      carrier: r['carrier'] as String?,
      networkType: r['network_type'] as String?,
      locationQuality: (r['location_quality'] as num?)?.toInt(),
      trajectoryDecision: r['trajectory_decision'] as String?,
      outlierReason: r['outlier_reason'] as String?,
      movementMode: r['movement_mode'] as String?,
    ));
  }
  parsed.sort((a, b) => a.t.compareTo(b.t));

  final deduped = <MapPoint>[];
  for (var i = 0; i < parsed.length; i++) {
    final p = parsed[i];
    if (i > 0) {
      final prev = parsed[i - 1];
      if (p.t == prev.t && p.lat == prev.lat && p.lon == prev.lon) continue;
    }
    deduped.add(p);
  }

  for (final p in deduped) {
    p.isLowAcc = p.effAcc > accuracyThresholdM;
  }
  _markSpikes(deduped);
  _markSpeedOutliers(deduped);

  var runIndex = 0;
  int? prevKeptT;
  for (var idx = 0; idx < deduped.length; idx++) {
    final p = deduped[idx];
    p.idx = idx;
    // Step15: a fix the upstream trajectory validator rejected (location_task.dart, before this
    // row was ever written) must never draw a line segment either - same exclusion mechanism as
    // the pre-existing spike/speed-outlier/low-accuracy checks above, which stay in place as
    // defense-in-depth (and for rows written before this field existed).
    p.isTrajectoryRejected =
        p.trajectoryDecision == TrajectoryDecision.outlier || p.trajectoryDecision == TrajectoryDecision.uncertain;
    p.excluded = p.isSpike || p.isSpeedOutlier || p.isLowAcc || p.isTrajectoryRejected;
    if (!p.excluded) {
      p.gapBefore = prevKeptT != null && (p.t - prevKeptT) > maxGapSeconds * 1000;
      if (p.gapBefore) runIndex += 1;
      p.runIndex = runIndex;
      prevKeptT = p.t;
    }
  }

  return deduped;
}
