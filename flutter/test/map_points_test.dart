import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/map_points.dart';

Map<String, Object?> row(Map<String, Object?> overrides) {
  final base = <String, Object?>{
    'id': 1,
    'timestamp': '2026-08-19T08:49:15.964Z',
    'latitude': 31.0964199,
    'longitude': 77.1524214,
    'accuracy': 14.0,
    'battery': 80,
    'app_state': 'foreground',
    'method': 'fused',
    'movement_state': 'STATIONARY',
    'location_quality': 90,
  };
  base.addAll(overrides);
  return base;
}

void main() {
  group('buildMapPoints', () {
    test('empty input returns empty list', () {
      expect(buildMapPoints([]), isEmpty);
    });

    test('rows with no usable position or timestamp are dropped', () {
      final rows = [
        row({'id': 1, 'latitude': null, 'longitude': null}),
        row({'id': 2, 'timestamp': null}),
        row({'id': 3}),
      ];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [3]);
    });

    test('falls back to processed_latitude/longitude when raw is missing', () {
      final rows = [
        row({
          'id': 1,
          'latitude': null,
          'longitude': null,
          'processed_latitude': 31.1,
          'processed_longitude': 77.2,
        }),
      ];
      final points = buildMapPoints(rows);
      expect(points, hasLength(1));
      expect(points[0].lat, 31.1);
      expect(points[0].lon, 77.2);
    });

    test('sorts by timestamp ascending regardless of input order', () {
      final rows = [
        row({'id': 2, 'timestamp': '2026-08-19T08:50:00.000Z'}),
        row({'id': 1, 'timestamp': '2026-08-19T08:49:00.000Z'}),
      ];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [1, 2]);
    });

    test('drops a second row identical in timestamp+lat+lon (redelivery dedup)', () {
      final rows = [row({'id': 1}), row({'id': 2})];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [1]);
    });

    test('keeps two rows with the same timestamp if position differs', () {
      final rows = [row({'id': 1}), row({'id': 2, 'latitude': 31.2})];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [1, 2]);
    });

    test('flags accuracy worse than accuracyThresholdM as isLowAcc, excluded from path', () {
      final rows = [row({'id': 1, 'accuracy': accuracyThresholdM + 1})];
      final points = buildMapPoints(rows);
      expect(points[0].isLowAcc, true);
      expect(points[0].excluded, true);
    });

    test('accuracy at threshold is not flagged', () {
      final rows = [row({'id': 1, 'accuracy': accuracyThresholdM})];
      final points = buildMapPoints(rows);
      expect(points[0].isLowAcc, false);
      expect(points[0].excluded, false);
    });

    test('invalid (zero/negative) accuracy is treated as untrustworthy, not excellent', () {
      final rows = [row({'id': 1, 'accuracy': 0.0})];
      final points = buildMapPoints(rows);
      expect(points[0].isLowAcc, true);
      expect(points[0].excluded, true);
    });

    test('flags an isolated out-and-back spike, not its well-behaved neighbors', () {
      final rows = [
        row({'id': 1, 'timestamp': '2026-08-19T08:49:15.964Z', 'latitude': 31.0964199, 'longitude': 77.1524214, 'accuracy': 14.0}),
        row({'id': 2, 'timestamp': '2026-08-19T08:52:30.967Z', 'latitude': 31.0921669, 'longitude': 77.1349605, 'accuracy': 46.0}),
        row({'id': 3, 'timestamp': '2026-08-19T08:53:05.131Z', 'latitude': 31.0967622, 'longitude': 77.1529471, 'accuracy': 46.0}),
      ];
      final points = buildMapPoints(rows);
      expect(points.firstWhere((p) => p.id == 2).isSpike, true);
      expect(points.firstWhere((p) => p.id == 1).isSpike, false);
      expect(points.firstWhere((p) => p.id == 3).isSpike, false);
    });

    test('flags an unrealistic-speed jump at the array edge (no reunion neighbor)', () {
      final rows = [
        row({'id': 1, 'timestamp': '2026-08-19T08:49:00.000Z', 'latitude': 31.0, 'longitude': 77.0, 'accuracy': 10.0}),
        row({'id': 2, 'timestamp': '2026-08-19T08:49:10.000Z', 'latitude': 31.1, 'longitude': 77.0, 'accuracy': 10.0}),
      ];
      final points = buildMapPoints(rows);
      expect(points[1].isSpeedOutlier, true);
      expect(points[1].excluded, true);
    });

    test('speed check skips a low-accuracy fix as the reference point, not just spikes', () {
      final rows = [
        row({'id': 1, 'timestamp': '2026-08-19T08:00:00.000Z', 'latitude': 31.0, 'longitude': 77.0, 'accuracy': 10.0}),
        row({'id': 2, 'timestamp': '2026-08-19T08:00:05.000Z', 'latitude': 31.0018, 'longitude': 77.0, 'accuracy': 300.0}),
        row({'id': 3, 'timestamp': '2026-08-19T08:00:08.000Z', 'latitude': 31.00003, 'longitude': 77.0, 'accuracy': 10.0}),
      ];
      final points = buildMapPoints(rows);
      expect(points.firstWhere((p) => p.id == 2).isLowAcc, true);
      expect(points.firstWhere((p) => p.id == 3).isSpeedOutlier, false);
    });

    test('flags gapBefore when two kept fixes are more than maxGapSeconds apart', () {
      final base = DateTime.parse('2026-08-19T08:00:00.000Z');
      final rows = [
        row({'id': 1, 'timestamp': base.toIso8601String()}),
        row({'id': 2, 'timestamp': base.add(Duration(seconds: maxGapSeconds + 1)).toIso8601String()}),
      ];
      final points = buildMapPoints(rows);
      expect(points[0].gapBefore, false);
      expect(points[1].gapBefore, true);
      expect(points[1].runIndex, 1);
    });

    test('does not flag gapBefore when the gap is under maxGapSeconds', () {
      final base = DateTime.parse('2026-08-19T08:00:00.000Z');
      final rows = [
        row({'id': 1, 'timestamp': base.toIso8601String()}),
        row({'id': 2, 'timestamp': base.add(Duration(seconds: maxGapSeconds - 1)).toIso8601String()}),
      ];
      final points = buildMapPoints(rows);
      expect(points[1].gapBefore, false);
      expect(points[1].runIndex, 0);
    });

    test('output carries movement/telemetry fields through unchanged', () {
      final rows = [
        row({
          'id': 1,
          'movement_state': 'MOVING',
          'signal_dbm': -70,
          'carrier': 'Jio',
          'network_type': 'LTE',
          'signal_level': 3,
          'battery': 55,
          'app_state': 'background',
          'location_quality': 80,
        }),
      ];
      final points = buildMapPoints(rows);
      expect(points[0].movementState, 'MOVING');
      expect(points[0].signalDbm, -70);
      expect(points[0].carrier, 'Jio');
      expect(points[0].networkType, 'LTE');
      expect(points[0].signalLevel, 3);
      expect(points[0].batteryPct, 55);
      expect(points[0].appState, 'background');
      expect(points[0].locationQuality, 80);
    });
  });
}
