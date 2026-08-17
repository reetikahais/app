import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/logger.dart';

void main() {
  group('computeSignalGap', () {
    test('no prior heartbeat returns null', () {
      expect(computeSignalGap(null, DateTime.now().millisecondsSinceEpoch, 120000), isNull);
    });

    test('gap under threshold returns null', () {
      const last = 1000000;
      const now = last + 60000; // 1 min gap, threshold 2 min
      expect(computeSignalGap(last, now, 120000), isNull);
    });

    test('gap exactly at threshold returns null', () {
      const last = 1000000;
      const now = last + 120000; // exactly 2 min, threshold 2 min
      expect(computeSignalGap(last, now, 120000), isNull);
    });

    test('gap over threshold returns event details', () {
      const last = 1000000;
      const now = last + 300000; // 5 min gap, threshold 2 min
      final result = computeSignalGap(last, now, 120000);
      expect(result, {
        'gap_started_at': DateTime.fromMillisecondsSinceEpoch(last).toUtc().toIso8601String(),
        'gap_ended_at': DateTime.fromMillisecondsSinceEpoch(now).toUtc().toIso8601String(),
        'duration_ms': 300000,
      });
    });
  });
}
