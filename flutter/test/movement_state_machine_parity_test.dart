import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:raahmitra_gps_logger/movement_state_machine.dart';

const double _baseLat = 31.4440206;
const double _baseLon = 77.0467109;
const double _metersPerDegLat = 111320;

// JSON `null` accuracy means "invalid/unknown". Dart's LocationFix.accuracy is a non-nullable
// double, so the same JSON null that RN passes straight through to sanitizeAccuracy(null) is
// mapped here to double.nan - sanitizeAccuracy(NaN) handles it equivalently on this side.
LocationFix _toFix(Map<String, dynamic> f) {
  final dNorthM = (f['dNorthM'] as num).toDouble();
  final dEastM = (f['dEastM'] as num).toDouble();
  final metersPerDegLon = _metersPerDegLat * math.cos(_baseLat * math.pi / 180);
  final lat = _baseLat + dNorthM / _metersPerDegLat;
  final lon = _baseLon + dEastM / metersPerDegLon;
  final speed = f['speed'] != null ? (f['speed'] as num).toDouble() : null;
  final accuracy = f['accuracy'] != null ? (f['accuracy'] as num).toDouble() : double.nan;
  return LocationFix(lat: lat, lon: lon, accuracy: accuracy, speed: speed);
}

void main() {
  final fixturePath = p.join(Directory.current.path, '..', 'test-fixtures', 'movement_state_machine_parity.json');
  final fixtureData = jsonDecode(File(fixturePath).readAsStringSync()) as Map<String, dynamic>;
  final cases = fixtureData['cases'] as List<dynamic>;

  group('movement state machine parity fixtures (shared with RN)', () {
    for (final testCase in cases) {
      final name = testCase['name'] as String;
      final expectedFinalState = testCase['expectedFinalState'] as String;
      final fixes = testCase['fixes'] as List<dynamic>;
      final expectedQuality = testCase['expectedQuality'] as int?;
      final expectedProcessedWithinMOfLastFix = (testCase['expectedProcessedWithinMOfLastFix'] as num?)?.toDouble();

      test('$name -> $expectedFinalState', () {
        var state = createInitialMovementState();
        LocationFix? lastFix;
        for (final f in fixes) {
          lastFix = _toFix(f as Map<String, dynamic>);
          state = processLocationFix(state, lastFix);
        }
        expect(state.state, expectedFinalState);

        if (expectedQuality != null) {
          expect(getLocationQuality(state, lastFix!), expectedQuality);
        }
        if (expectedProcessedWithinMOfLastFix != null) {
          final processed = getProcessedLocation(state);
          final processedPoint = LocationFix(lat: processed.lat!, lon: processed.lon!, accuracy: 1);
          expect(haversineDistanceMeters(processedPoint, lastFix!), lessThanOrEqualTo(expectedProcessedWithinMOfLastFix));
        }
      });
    }
  });
}
