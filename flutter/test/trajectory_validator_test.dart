import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/trajectory_validator.dart';

const _base = (lat: 31.4440206, lon: 77.0467109);
const double _metersPerDegLat = 111320;

({double lat, double lon}) _offset(double dNorthM, double dEastM) {
  final metersPerDegLon = _metersPerDegLat * math.cos(_base.lat * math.pi / 180);
  return (lat: _base.lat + dNorthM / _metersPerDegLat, lon: _base.lon + dEastM / metersPerDegLon);
}

TrajectoryFix fixAt(double dNorthM, double dEastM, int timestampMs, {double accuracy = 10, double? speed}) {
  final pos = _offset(dNorthM, dEastM);
  return TrajectoryFix(lat: pos.lat, lon: pos.lon, accuracy: accuracy, speed: speed, timestampMs: timestampMs);
}

({TrajectoryState state, double distanceM, int timeMs}) warmUp(
    TrajectoryState state, double distanceM, int timeMs, int count, double speedMps, int dtSec) {
  var s = state;
  var dist = distanceM;
  var t = timeMs;
  for (var i = 0; i < count; i++) {
    dist += speedMps * dtSec;
    t += dtSec * 1000;
    final outcome = classifyFix(s, fixAt(dist, 0, t, speed: speedMps));
    expect(outcome.result.decision, TrajectoryDecision.accepted);
    s = outcome.newState;
  }
  return (state: s, distanceM: dist, timeMs: t);
}

void main() {
  group('bootstrap', () {
    test('first-ever fix is always ACCEPTED', () {
      final outcome = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      expect(outcome.result.decision, TrajectoryDecision.accepted);
    });
  });

  group('walking mode', () {
    ({TrajectoryState state, double distanceM, int timeMs}) walkingState() {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      return warmUp(boot.newState, 0, 0, 3, 1.2, 10);
    }

    test('10m/10s accepted', () {
      final w = walkingState();
      final outcome = classifyFix(w.state, fixAt(w.distanceM + 10, 0, w.timeMs + 10000, speed: 1));
      expect(outcome.result.decision, TrajectoryDecision.accepted);
      expect(outcome.result.movementMode, MovementMode.walking);
    });

    test('20m/10s still plausible, not an outlier', () {
      final w = walkingState();
      final outcome = classifyFix(w.state, fixAt(w.distanceM + 20, 0, w.timeMs + 10000, speed: 2));
      expect(outcome.result.decision, isNot(TrajectoryDecision.outlier));
    });

    test('300m/10s is an outlier (impossible speed for a walking trail)', () {
      final w = walkingState();
      final outcome = classifyFix(w.state, fixAt(w.distanceM + 300, 0, w.timeMs + 10000, speed: 30));
      expect(outcome.result.decision, TrajectoryDecision.outlier);
      expect(outcome.result.reason, OutlierReason.impossibleSpeed);
    });
  });

  group('cycling mode', () {
    ({TrajectoryState state, double distanceM, int timeMs}) cyclingState() {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      return warmUp(boot.newState, 0, 0, 3, 5, 10);
    }

    test('50m/10s accepted', () {
      final c = cyclingState();
      final outcome = classifyFix(c.state, fixAt(c.distanceM + 50, 0, c.timeMs + 10000, speed: 5));
      expect(outcome.result.decision, TrajectoryDecision.accepted);
    });

    test('150m/10s potentially accepted, not an outlier', () {
      final c = cyclingState();
      final outcome = classifyFix(c.state, fixAt(c.distanceM + 150, 0, c.timeMs + 10000, speed: 15));
      expect(outcome.result.decision, isNot(TrajectoryDecision.outlier));
    });
  });

  group('car mode', () {
    ({TrajectoryState state, double distanceM, int timeMs}) carState() {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      return warmUp(boot.newState, 0, 0, 3, 20, 10);
    }

    test('200m/10s accepted', () {
      final c = carState();
      final outcome = classifyFix(c.state, fixAt(c.distanceM + 200, 0, c.timeMs + 10000, speed: 20));
      expect(outcome.result.decision, TrajectoryDecision.accepted);
      expect(outcome.result.movementMode, MovementMode.vehicle);
    });

    test('500m/10s potentially accepted, not an outlier', () {
      final c = carState();
      final outcome = classifyFix(c.state, fixAt(c.distanceM + 500, 0, c.timeMs + 10000, speed: 50));
      expect(outcome.result.decision, isNot(TrajectoryDecision.outlier));
    });
  });

  group('GPS jump / outlier poisoning', () {
    ({TrajectoryState stateB, double distanceM, int timeMs}) baseWalk() {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      final w = warmUp(boot.newState, 0, 0, 3, 1.2, 10);
      final outcomeB = classifyFix(w.state, fixAt(w.distanceM + 12, 0, w.timeMs + 10000, speed: 1.2));
      return (stateB: outcomeB.newState, distanceM: w.distanceM + 12, timeMs: w.timeMs + 10000);
    }

    test('good, good, 300m jump, good - jump never enters the trail, recovery resumes off the last accepted fix', () {
      final b = baseWalk();

      final outcomeC = classifyFix(b.stateB, fixAt(b.distanceM + 300, 0, b.timeMs + 10000, speed: 30));
      expect(outcomeC.result.decision, TrajectoryDecision.outlier);
      expect(outcomeC.newState.lastAcceptedFix!.timestampMs, b.stateB.lastAcceptedFix!.timestampMs);

      final outcomeD = classifyFix(outcomeC.newState, fixAt(b.distanceM + 12, 0, b.timeMs + 20000, speed: 1.2));
      expect(outcomeD.result.decision, TrajectoryDecision.accepted);
    });

    test('outlier poisoning: two consecutive outliers never become the reference - E is compared to B', () {
      final b = baseWalk();

      final outcomeC = classifyFix(b.stateB, fixAt(b.distanceM + 300, 0, b.timeMs + 10000, speed: 30));
      final outcomeD = classifyFix(outcomeC.newState, fixAt(b.distanceM + 600, 0, b.timeMs + 20000, speed: 30));
      expect(outcomeD.result.decision, TrajectoryDecision.outlier);
      expect(outcomeD.newState.lastAcceptedFix!.timestampMs, b.stateB.lastAcceptedFix!.timestampMs);

      final outcomeE = classifyFix(outcomeD.newState, fixAt(b.distanceM + 24, 0, b.timeMs + 30000, speed: 1.2));
      expect(outcomeE.result.decision, TrajectoryDecision.accepted);
    });
  });

  group('sharp legitimate turn', () {
    test('a sharp turn with consistent speed/displacement is not auto-rejected', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      final w = warmUp(boot.newState, 0, 0, 3, 5, 10);
      final outcomePrev = classifyFix(w.state, fixAt(w.distanceM + 50, 0, w.timeMs + 10000, speed: 5));

      final outcomeTurn = classifyFix(outcomePrev.newState, fixAt(w.distanceM + 50, 50, w.timeMs + 20000, speed: 5));
      expect(outcomeTurn.result.decision, TrajectoryDecision.accepted);
    });
  });

  group('accuracy-aware plausibility (Step10)', () {
    test('poor-accuracy distant fix widens the band instead of being outright rejected', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0, accuracy: 10));
      final outcome = classifyFix(boot.newState, fixAt(50, 0, 10000, accuracy: 300));
      expect(outcome.result.decision, isNot(TrajectoryDecision.outlier));
    });
  });

  group('duplicate/out-of-order timestamps (Step3)', () {
    test('a fix at or before lastAcceptedFix.timestampMs is rejected, anchor untouched', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 1000));
      final outcome = classifyFix(boot.newState, fixAt(5, 0, 1000));
      expect(outcome.result.decision, TrajectoryDecision.outlier);
      expect(outcome.result.reason, OutlierReason.duplicateOrOutOfOrder);
      expect(outcome.newState.lastAcceptedFix!.timestampMs, boot.newState.lastAcceptedFix!.timestampMs);
    });

    test('sortFixesByTimestamp sorts a batch ascending regardless of delivery order', () {
      final sorted = sortFixesByTimestamp([fixAt(0, 0, 3000), fixAt(0, 0, 1000), fixAt(0, 0, 2000)]);
      expect(sorted.map((f) => f.timestampMs).toList(), [1000, 2000, 3000]);
    });

    test('background batch: an out-of-order array is processed chronologically once sorted', () {
      final raw = [fixAt(20, 0, 2000, speed: 2), fixAt(0, 0, 0), fixAt(10, 0, 1000, speed: 1)];
      var state = createInitialTrajectoryState();
      final decisions = <String>[];
      for (final f in sortFixesByTimestamp(raw)) {
        final outcome = classifyFix(state, f);
        decisions.add(outcome.result.decision);
        state = outcome.newState;
      }
      expect(decisions, [TrajectoryDecision.accepted, TrajectoryDecision.accepted, TrajectoryDecision.accepted]);
    });
  });

  group('false movement transition guard (Step13)', () {
    test('OUTLIER decisions never advance lastAcceptedFix', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      final outcome = classifyFix(boot.newState, fixAt(5000, 0, 10000, speed: 500));
      expect(outcome.result.decision, TrajectoryDecision.outlier);
      expect(outcome.newState.lastAcceptedFix!.timestampMs, boot.newState.lastAcceptedFix!.timestampMs);
    });
  });

  group('UNCERTAIN resolution (Step12)', () {
    ({TrajectoryState state, double distanceM, int timeMs}) walkingAnchor() {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      return warmUp(boot.newState, 0, 0, 3, 1.2, 10);
    }

    test('an UNCERTAIN fix confirmed by the next fix is accepted and re-anchors to the newer fix', () {
      final w = walkingAnchor();
      final uncertain = fixAt(w.distanceM + 85, 0, w.timeMs + 10000, speed: 8.5);
      final r1 = classifyFix(w.state, uncertain);
      expect(r1.result.decision, TrajectoryDecision.uncertain);
      expect(r1.newState.lastAcceptedFix!.timestampMs, w.state.lastAcceptedFix!.timestampMs);

      final confirming = fixAt(w.distanceM + 90, 0, w.timeMs + 15000, speed: 1);
      final r2 = classifyFix(r1.newState, confirming);
      expect(r2.result.decision, TrajectoryDecision.accepted);
      expect(r2.result.reason, OutlierReason.uncertainConfirmed);
      expect(r2.newState.lastAcceptedFix!.lat, closeTo(confirming.lat, 1e-9));
      expect(r2.newState.pendingUncertain, isNull);
    });

    test('an UNCERTAIN fix followed by a fix consistent with the OLD anchor is discarded as an isolated blip', () {
      final w = walkingAnchor();
      final blip = fixAt(w.distanceM + 85, 0, w.timeMs + 10000, speed: 8.5);
      final r1 = classifyFix(w.state, blip);
      expect(r1.result.decision, TrajectoryDecision.uncertain);

      final backToNormal = fixAt(w.distanceM + 11, 0, w.timeMs + 20000, speed: 1.1);
      final r2 = classifyFix(r1.newState, backToNormal);
      expect(r2.result.decision, TrajectoryDecision.accepted);
      expect(r2.newState.pendingUncertain, isNull);
      expect(r2.newState.prevAcceptedFix!.timestampMs, w.state.lastAcceptedFix!.timestampMs);
    });

    test('an UNCERTAIN fix never confirmed within the timeout is dropped from the pending buffer', () {
      final w = walkingAnchor();
      final originalUncertainT = w.timeMs + 10000;
      var cur = classifyFix(w.state, fixAt(w.distanceM + 85, 0, originalUncertainT, speed: 8.5));
      expect(cur.result.decision, TrajectoryDecision.uncertain);
      expect(cur.newState.pendingUncertain!.fix.timestampMs, originalUncertainT);

      for (var i = 0; i < uncertainConfirmTimeoutFixes + 1; i++) {
        cur = classifyFix(
          cur.newState,
          fixAt(w.distanceM + 85 + (i + 1) * 40, 0, w.timeMs + 10000 + (i + 1) * 3000, speed: 13),
        );
      }
      if (cur.newState.pendingUncertain != null) {
        expect(cur.newState.pendingUncertain!.fix.timestampMs, isNot(originalUncertainT));
      }
    });
  });

  group('stale-anchor recovery (Step8)', () {
    test('a long gap followed by two mutually consistent fixes re-anchors instead of staying stuck', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      final state = boot.newState;

      final staleT = staleAnchorThresholdMs + 5000;
      final candidate = fixAt(2000, 0, staleT, speed: 5);
      final r1 = classifyFix(state, candidate);
      expect(r1.result.decision, TrajectoryDecision.uncertain);
      expect(r1.result.reason, OutlierReason.staleAnchorRecovering);
      expect(r1.newState.lastAcceptedFix!.timestampMs, state.lastAcceptedFix!.timestampMs);

      final confirm = fixAt(2010, 0, staleT + 5000, speed: 2);
      final r2 = classifyFix(r1.newState, confirm);
      expect(r2.result.decision, TrajectoryDecision.accepted);
      expect(r2.result.reason, OutlierReason.staleAnchorReanchored);
      expect(r2.newState.lastAcceptedFix!.lat, closeTo(confirm.lat, 1e-9));
      expect(r2.newState.pendingUncertain, isNull);
    });

    test('N consecutive OUTLIER/UNCERTAIN fixes also trigger stale recovery even before the time threshold', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      var cur = boot;
      for (var i = 0; i < 3; i++) {
        cur = classifyFix(cur.newState, fixAt(5000 + i * 10, 0, (i + 1) * 10000, speed: 500));
      }
      expect(cur.newState.outlierStreak, greaterThanOrEqualTo(3));

      final next = classifyFix(cur.newState, fixAt(9000, 0, 40000, speed: 5));
      expect(next.result.decision, TrajectoryDecision.uncertain);
      expect(next.result.reason, OutlierReason.staleAnchorRecovering);
    });
  });

  group('mode inference hysteresis (Step7)', () {
    test('mode never switches on a single fix', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      final outcome = classifyFix(boot.newState, fixAt(50, 0, 10000, speed: 5));
      expect(outcome.newState.mode, MovementMode.unknown);
    });

    test('mode confirms WALKING after modeSwitchConfirmCount consistent fixes', () {
      final boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
      final w = warmUp(boot.newState, 0, 0, 3, 1.2, 10);
      expect(w.state.mode, MovementMode.walking);
    });
  });
}
