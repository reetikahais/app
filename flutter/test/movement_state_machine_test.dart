import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/movement_state_machine.dart';

const double _baseLat = 31.4440206;
const double _baseLon = 77.0467109;
const double _metersPerDegLat = 111320;

class _LatLon {
  final double lat;
  final double lon;
  const _LatLon(this.lat, this.lon);
}

_LatLon _offset(double dNorthM, double dEastM) {
  final metersPerDegLon = _metersPerDegLat * math.cos(_baseLat * math.pi / 180);
  return _LatLon(
    _baseLat + dNorthM / _metersPerDegLat,
    _baseLon + dEastM / metersPerDegLon,
  );
}

LocationFix _fix(double dNorthM, double dEastM, double accuracy, {double? speed}) {
  final pos = _offset(dNorthM, dEastM);
  return LocationFix(lat: pos.lat, lon: pos.lon, accuracy: accuracy, speed: speed);
}

void main() {
  group('pure geo helpers', () {
    test('haversineDistanceMeters is ~0 for identical points', () {
      final a = _fix(0, 0, 10);
      final b = _fix(0, 0, 10);
      expect(haversineDistanceMeters(a, b), closeTo(0, 0.001));
    });

    test('haversineDistanceMeters matches known offset within 1%', () {
      final a = _fix(0, 0, 10);
      final b = _fix(100, 0, 10);
      final d = haversineDistanceMeters(a, b);
      expect(d, greaterThan(99));
      expect(d, lessThan(101));
    });

    test('initialBearingDegrees: due north is ~0', () {
      final a = _fix(0, 0, 10);
      final b = _fix(100, 0, 10);
      expect(initialBearingDegrees(a, b), closeTo(0, 1));
    });

    test('initialBearingDegrees: due east is ~90', () {
      final a = _fix(0, 0, 10);
      final b = _fix(0, 100, 10);
      expect(initialBearingDegrees(a, b), closeTo(90, 1));
    });

    test('circularBearingDiffDeg: simple case', () {
      expect(circularBearingDiffDeg(10, 30), closeTo(20, 0.0001));
    });

    test('circularBearingDiffDeg: wraps correctly across 0/360', () {
      expect(circularBearingDiffDeg(350, 10), closeTo(20, 0.0001));
      expect(circularBearingDiffDeg(5, 355), closeTo(10, 0.0001));
    });

    test('computeNoiseThresholdM: max(accuracy) + 15m floor', () {
      expect(computeNoiseThresholdM(20, 35), 50);
      expect(computeNoiseThresholdM(35, 20), 50);
    });

    test('passesBearingCheck: skips check under 25m segment distance', () {
      expect(passesBearingCheck(24, 179), isTrue);
    });

    test('passesBearingCheck: enforces tolerance at/over 25m segment distance', () {
      expect(passesBearingCheck(25, 45), isTrue);
      expect(passesBearingCheck(25, 45.01), isFalse);
    });
  });

  group('movement state machine', () {
    test('1. stationary user with 10-40m GPS scatter remains STATIONARY', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 19));
      state = processLocationFix(state, _fix(-9, -3, 35));
      state = processLocationFix(state, _fix(-10, -5, 36));
      state = processLocationFix(state, _fix(-13, 3, 41));
      expect(state.state, 'STATIONARY');
    });

    test('2. accurate stationary points do not flap between states', () {
      var state = createInitialMovementState();
      for (var i = 0; i < 10; i++) {
        state = processLocationFix(state, _fix(i % 2 == 0 ? 3 : -3, 0, 8));
        expect(state.state, 'STATIONARY');
      }
    });

    test('3. large GPS jump followed by a return to anchor remains STATIONARY', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(200, 0, 15));
      expect(state.state, 'CONFIRMING_MOVEMENT');
      state = processLocationFix(state, _fix(2, 0, 10));
      expect(state.state, 'STATIONARY');
    });

    test('4. two consecutive consistent movement fixes becomes MOVING', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10));
      expect(state.state, 'CONFIRMING_MOVEMENT');
      state = processLocationFix(state, _fix(100, 0, 10));
      expect(state.state, 'MOVING');
    });

    test('5. speed >= 1.2 m/s with usable accuracy becomes MOVING immediately', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10, speed: 1.5));
      expect(state.state, 'MOVING');
    });

    test('6. slow movement below speed threshold still detected via distance/bearing', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10, speed: 0.3));
      expect(state.state, 'CONFIRMING_MOVEMENT');
      state = processLocationFix(state, _fix(100, 0, 10, speed: 0.3));
      expect(state.state, 'MOVING');
    });

    test('7. one stationary-looking fix while MOVING does not drop straight to STATIONARY', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10, speed: 2));
      expect(state.state, 'MOVING');
      state = processLocationFix(state, _fix(51, 1, 10));
      expect(state.state, isNot('STATIONARY'));
      expect(state.state, 'CONFIRMING_STOP');
    });

    test('8. two consecutive stationary fixes while MOVING transitions to STATIONARY', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10, speed: 2));
      state = processLocationFix(state, _fix(51, 1, 10));
      expect(state.state, 'CONFIRMING_STOP');
      state = processLocationFix(state, _fix(50, 0, 10));
      expect(state.state, 'STATIONARY');
    });

    test('confirming-stop: a moving fix in between reverts back to MOVING', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10, speed: 2));
      state = processLocationFix(state, _fix(51, 1, 10));
      state = processLocationFix(state, _fix(120, 0, 10, speed: 2));
      expect(state.state, 'MOVING');
    });

    test('9. background fixes with 30-50m accuracy are not automatically treated as movement', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 30));
      state = processLocationFix(state, _fix(15, -10, 45));
      state = processLocationFix(state, _fix(-10, 20, 50));
      expect(state.state, 'STATIONARY');
    });

    test('10. bearing near 0/360 wrap compares correctly inside the state machine', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 5));
      state = processLocationFix(state, _fix(50, -9, 5));
      expect(state.state, 'CONFIRMING_MOVEMENT');
      state = processLocationFix(state, _fix(100, 0, 5));
      expect(state.state, 'MOVING');
    });

    test('11. short-distance (<25m) consecutive candidates skip the bearing check', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 2));
      state = processLocationFix(state, _fix(30, 0, 2));
      expect(state.state, 'CONFIRMING_MOVEMENT');
      state = processLocationFix(state, _fix(30, 10, 2));
      expect(state.state, 'MOVING');
    });

    test('getProcessedLocation returns the smoothed anchor while STATIONARY', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 19));
      state = processLocationFix(state, _fix(-9, -3, 35));
      final processed = getProcessedLocation(state);
      expect(processed.lat, closeTo(state.anchor!.lat, 1e-10));
      expect(processed.lon, closeTo(state.anchor!.lon, 1e-10));
    });

    test('getProcessedLocation lightly smooths (does not exactly equal raw) the first fix while MOVING', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10)); // anchor/processed = (0,0)
      final f = _fix(50, 0, 10, speed: 2);
      state = processLocationFix(state, f);
      expect(state.state, 'MOVING');
      final processed = getProcessedLocation(state);
      // alpha=0.8 towards raw fix from the previous processed point (the anchor) - close to raw,
      // not identical, and strictly between the previous point and the raw fix.
      expect(processed.lat, isNot(closeTo(f.lat, 1e-10)));
      expect(processed.lat!, greaterThan(_baseLat));
      expect(processed.lat!, lessThan(f.lat));
      expect(processed.lat, closeTo(_baseLat + (f.lat - _baseLat) * movingSmoothingAlpha, 1e-10));
    });

    test('getProcessedLocation settles to a small steady-state lag on a straight constant-speed line', () {
      // EMA lag behind a constant step size converges to step * (1-alpha)/alpha - for a 50m step
      // and alpha=0.8 that's 50 * 0.25 = 12.5m, small relative to the 50m step itself (stays
      // responsive) while still damping any single noisy fix (see the sideways-jump test below).
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(50, 0, 10, speed: 2));
      state = processLocationFix(state, _fix(100, 0, 10, speed: 2));
      final f = _fix(150, 0, 10, speed: 2);
      state = processLocationFix(state, f);
      final processed = getProcessedLocation(state);
      final processedPoint = LocationFix(lat: processed.lat!, lon: processed.lon!, accuracy: 1);
      final expectedSteadyStateLagM = 50 * (1 - movingSmoothingAlpha) / movingSmoothingAlpha;
      expect(haversineDistanceMeters(processedPoint, f), closeTo(expectedSteadyStateLagM, 1));
    });

    test('a single sideways GPS jump while MOVING is damped, not fully followed', () {
      // Straight-line road: A -> B -> C -> D, but the raw GPS fix at C jumps 30m sideways.
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10)); // A (anchor)
      state = processLocationFix(state, _fix(50, 0, 10, speed: 2)); // B - confirms MOVING
      state = processLocationFix(state, _fix(100, 0, 10, speed: 2)); // still on the line
      final cRaw = _fix(150, 30, 10, speed: 2); // C - raw fix jumps 30m sideways (east)
      state = processLocationFix(state, cRaw);
      final processedC = getProcessedLocation(state);
      final lonOffsetFromLineRaw = (cRaw.lon - _baseLon).abs();
      final lonOffsetFromLineProcessed = (processedC.lon! - _baseLon).abs();
      expect(lonOffsetFromLineProcessed, lessThan(lonOffsetFromLineRaw));
      expect(lonOffsetFromLineProcessed, greaterThan(0));
    });

    test('getDistanceFromAnchorM is 0 when there is no anchor (MOVING)', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      final f = _fix(50, 0, 10, speed: 2);
      state = processLocationFix(state, f);
      expect(getDistanceFromAnchorM(state, f), 0);
    });

    test('getDistanceFromAnchorM reflects distance to the anchor while STATIONARY', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 19));
      final f = _fix(-9, -3, 35);
      state = processLocationFix(state, f);
      expect(getDistanceFromAnchorM(state, f), greaterThan(0));
      expect(getDistanceFromAnchorM(state, f), lessThan(20));
    });

    test('movementStateToJson/fromJson round-trips through a JSON string unchanged', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 10));
      state = processLocationFix(state, _fix(200, 0, 15)); // -> CONFIRMING_MOVEMENT (candidateStreak non-empty)

      final jsonStr = jsonEncode(movementStateToJson(state));
      final restored = movementStateFromJson(jsonDecode(jsonStr) as Map<String, dynamic>);

      expect(restored.state, state.state);
      expect(restored.anchor!.lat, closeTo(state.anchor!.lat, 1e-12));
      expect(restored.candidateStreak.length, state.candidateStreak.length);
      expect(restored.candidateStreak.first.lat, closeTo(state.candidateStreak.first.lat, 1e-12));
      expect(restored.processedLat, closeTo(state.processedLat!, 1e-12));
      expect(restored.processedLon, closeTo(state.processedLon!, 1e-12));
    });

    test('12a. Flutter fixture parity case - stationary cluster', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 19));
      state = processLocationFix(state, _fix(-9, -3, 35));
      state = processLocationFix(state, _fix(-10, -5, 36));
      state = processLocationFix(state, _fix(-13, 3, 41));
      expect(state.state, 'STATIONARY');
      expect(state.anchor, isNotNull);
    });
  });

  group('sanitizeAccuracy (Change 7 - accuracy edge-case hardening)', () {
    test('valid accuracy passes through unchanged (above the floor)', () {
      expect(sanitizeAccuracy(19), 19);
      expect(sanitizeAccuracy(500), 500);
    });

    test('zero, negative, NaN, and Infinity all fall back to the invalid-accuracy value', () {
      expect(sanitizeAccuracy(0), invalidAccuracyFallbackM);
      expect(sanitizeAccuracy(-5), invalidAccuracyFallbackM);
      expect(sanitizeAccuracy(double.nan), invalidAccuracyFallbackM);
      expect(sanitizeAccuracy(double.infinity), invalidAccuracyFallbackM);
    });

    test('implausibly tiny accuracy is floored, not trusted as super-precise', () {
      expect(sanitizeAccuracy(0.0001), minAccuracyFloorM);
    });

    test('foldFixIntoAnchor never divides by zero or produces NaN/Infinity for any invalid accuracy', () {
      for (final badAccuracy in [0.0, -1.0, double.nan, double.infinity]) {
        final anchor = foldFixIntoAnchor(null, LocationFix(lat: 1, lon: 2, accuracy: badAccuracy));
        expect(anchor.lat.isFinite, isTrue);
        expect(anchor.lon.isFinite, isTrue);
        expect(anchor.accuracy.isFinite, isTrue);
        expect(anchor.totalWeight.isFinite, isTrue);
      }
    });

    test('processLocationFix does not throw or misclassify on a fix with invalid accuracy', () {
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 19));
      // A fix with NaN accuracy right next to the anchor must still be treated as noise, not as
      // movement (an unsanitized NaN would poison Math.max()/the threshold comparison and could
      // make every such fix look like a "candidate" regardless of actual distance).
      state = processLocationFix(state, _fix(1, 1, 19).copyWith(accuracy: double.nan));
      expect(state.state, 'STATIONARY');
    });
  });

  group('blendPoint', () {
    test('alpha=0 stays at prev, alpha=1 jumps fully to next', () {
      const prev = (lat: 0.0, lon: 0.0);
      final next = LocationFix(lat: 10, lon: 20, accuracy: 1);
      expect(blendPoint(prev, next, 0), (lat: 0.0, lon: 0.0));
      expect(blendPoint(prev, next, 1), (lat: 10.0, lon: 20.0));
    });

    test('alpha=0.5 is the midpoint', () {
      const prev = (lat: 0.0, lon: 0.0);
      final next = LocationFix(lat: 10, lon: 20, accuracy: 1);
      expect(blendPoint(prev, next, 0.5), (lat: 5.0, lon: 10.0));
    });
  });

  group('getLocationQuality (Change 2 - not a re-statement of accuracy in meters)', () {
    test('high-accuracy fix scores high', () {
      const state = MovementState(state: 'STATIONARY');
      expect(getLocationQuality(state, LocationFix(lat: 0, lon: 0, accuracy: 5)), greaterThanOrEqualTo(90));
    });

    test('low-accuracy (but still stored) fix scores low, not zero unless very bad', () {
      const state = MovementState(state: 'STATIONARY');
      final q60 = getLocationQuality(state, LocationFix(lat: 0, lon: 0, accuracy: 60));
      expect(q60, greaterThan(0));
      expect(q60, lessThan(50));
    });

    test('invalid accuracy scores 0, never fake-precise', () {
      const state = MovementState(state: 'STATIONARY');
      expect(getLocationQuality(state, LocationFix(lat: 0, lon: 0, accuracy: double.nan)), 0);
    });

    test('very large accuracy clamps to 0, never negative', () {
      const state = MovementState(state: 'STATIONARY');
      expect(getLocationQuality(state, LocationFix(lat: 0, lon: 0, accuracy: 100000)), 0);
    });

    test('unconfirmed states (CONFIRMING_MOVEMENT/CONFIRMING_STOP) score lower than an equally-accurate confirmed state', () {
      final fix = LocationFix(lat: 0, lon: 0, accuracy: 20);
      final confirmed = getLocationQuality(const MovementState(state: 'STATIONARY'), fix);
      final confirming = getLocationQuality(const MovementState(state: 'CONFIRMING_MOVEMENT'), fix);
      expect(confirming, lessThan(confirmed));
    });

    test('a stable anchor built from 40m-accuracy fixes still only scores like a 40m fix', () {
      // Processing does not invent physical precision the raw measurement never had.
      var state = createInitialMovementState();
      state = processLocationFix(state, _fix(0, 0, 40));
      state = processLocationFix(state, _fix(2, 2, 40));
      state = processLocationFix(state, _fix(-2, -2, 40));
      final quality = getLocationQuality(state, LocationFix(lat: 0, lon: 0, accuracy: 40));
      expect(quality, lessThan(70));
    });
  });

  group('wantsHighAccuracy (Change 4)', () {
    test('MOVING, CONFIRMING_MOVEMENT, CONFIRMING_STOP all want high accuracy', () {
      expect(wantsHighAccuracy(const MovementState(state: 'MOVING')), isTrue);
      expect(wantsHighAccuracy(const MovementState(state: 'CONFIRMING_MOVEMENT')), isTrue);
      expect(wantsHighAccuracy(const MovementState(state: 'CONFIRMING_STOP')), isTrue);
    });

    test('STATIONARY does not need high accuracy', () {
      expect(wantsHighAccuracy(const MovementState(state: 'STATIONARY')), isFalse);
    });
  });

  group('computePollingIntervalMs', () {
    test('MOVING uses the moving tier regardless of stationarySinceMs', () {
      const state = MovementState(state: 'MOVING');
      expect(computePollingIntervalMs(state, 1000, 'foreground'), movingIntervalForegroundMs);
      expect(computePollingIntervalMs(state, 1000, 'background'), movingIntervalBackgroundMs);
    });

    test('CONFIRMING_MOVEMENT and CONFIRMING_STOP also use the moving tier', () {
      expect(
        computePollingIntervalMs(const MovementState(state: 'CONFIRMING_MOVEMENT'), 1000, 'foreground'),
        movingIntervalForegroundMs,
      );
      expect(
        computePollingIntervalMs(const MovementState(state: 'CONFIRMING_STOP'), 1000, 'background'),
        movingIntervalBackgroundMs,
      );
    });

    test('freshly-settled STATIONARY uses the short stationary tier', () {
      const state = MovementState(state: 'STATIONARY', stationarySinceMs: 1000);
      const now = 1000 + 60000; // 1 min stationary
      expect(computePollingIntervalMs(state, now, 'foreground'), stationaryIntervalForegroundMs);
      expect(computePollingIntervalMs(state, now, 'background'), stationaryIntervalBackgroundMs);
    });

    test('long-settled STATIONARY (>=5min) uses the long stationary tier', () {
      const state = MovementState(state: 'STATIONARY', stationarySinceMs: 1000);
      const now = 1000 + longStationaryThresholdMs;
      expect(computePollingIntervalMs(state, now, 'foreground'), longStationaryIntervalForegroundMs);
      expect(computePollingIntervalMs(state, now, 'background'), longStationaryIntervalBackgroundMs);
    });

    test('STATIONARY with no stationarySinceMs yet treated as just-settled', () {
      const state = MovementState(state: 'STATIONARY');
      expect(computePollingIntervalMs(state, 999999, 'foreground'), stationaryIntervalForegroundMs);
    });
  });

  group('processingVersion (Round 3, item 6)', () {
    test('is tagged as version 2', () {
      expect(processingVersion, 2);
    });
  });

  group('computeFixMetrics (Round 3, item 5 - internal reuse, not a behavior change)', () {
    test('matches haversineDistanceMeters/computeNoiseThresholdM computed separately', () {
      final anchor = _fix(0, 0, 20);
      final f = _fix(30, 0, 10);
      final metrics = computeFixMetrics(anchor, f);
      expect(metrics.distanceM, closeTo(haversineDistanceMeters(anchor, f), 1e-9));
      expect(metrics.thresholdM, computeNoiseThresholdM(anchor.accuracy, f.accuracy));
    });

    test('sanitizes the fix accuracy before computing the threshold', () {
      final anchor = _fix(0, 0, 20);
      final f = _fix(30, 0, double.nan);
      final metrics = computeFixMetrics(anchor, f);
      expect(metrics.thresholdM, computeNoiseThresholdM(anchor.accuracy, invalidAccuracyFallbackM));
    });
  });
}
