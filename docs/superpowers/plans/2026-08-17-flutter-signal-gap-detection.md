# Flutter Signal-Gap Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the RN app's signal-gap detection + fallback accuracy retention to the Flutter app: add a GPS fetch timeout, tag fixes by accuracy instead of hardcoding `'fused'`, and log a retroactive `signal_gap_detected` event when the heartbeat gap exceeds 2 minutes.

**Architecture:** Extends `flutter/lib/location_task.dart` and `flutter/lib/logger.dart`. Flutter's background timer already ticks (and heartbeats) every cycle regardless of GPS success — unlike RN, so this is defense-in-depth against service stalls/kills, not recovery from silently-skipped ticks. See [design spec](../specs/2026-08-17-flutter-signal-gap-detection-design.md) for full rationale.

**Tech Stack:** Flutter, `flutter_background_service`, `geolocator`, `shared_preferences`, `sqflite`. Tests use `flutter_test` (already a dev dependency — no new test infra needed).

**Prerequisite (already done):** commit `9c83180` (signal-strength logging) and `954fa8b` (design spec) on branch `feat/flutter-signal-gap-detection`, both ahead of this plan.

---

## File Structure

- Modify: `flutter/lib/location_task.dart` — add `maxAccuracyMeters`, `classifyFixMethod`, GPS `timeLimit`
- Create: `flutter/test/location_task_test.dart` — tests for `classifyFixMethod`
- Modify: `flutter/lib/logger.dart` — add `signalGapThresholdMs`, `computeSignalGap`, `recordHeartbeatAndDetectGap`
- Create: `flutter/test/logger_test.dart` — tests for `computeSignalGap`

---

### Task 1: GPS timeout + accuracy-based method tagging

**Files:**
- Modify: `flutter/lib/location_task.dart`
- Test: `flutter/test/location_task_test.dart`

- [ ] **Step 1: Write the failing test**

Create `flutter/test/location_task_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_flutter_gps_logger/location_task.dart';

void main() {
  group('classifyFixMethod', () {
    test('accuracy at or below threshold is fused', () {
      expect(classifyFixMethod(10), 'fused');
      expect(classifyFixMethod(maxAccuracyMeters), 'fused');
    });

    test('accuracy above threshold is low_accuracy_fallback', () {
      expect(classifyFixMethod(maxAccuracyMeters + 1), 'low_accuracy_fallback');
      expect(classifyFixMethod(500), 'low_accuracy_fallback');
    });

    test('null accuracy is low_accuracy_fallback', () {
      expect(classifyFixMethod(null), 'low_accuracy_fallback');
    });
  });
}
```

Note: check `flutter/pubspec.yaml`'s `name:` field for the actual package name to use in the import (`package:<name>/location_task.dart`) — do not assume `raahmitra_flutter_gps_logger` without verifying.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flutter && flutter test test/location_task_test.dart`
Expected: FAIL — `classifyFixMethod`/`maxAccuracyMeters` undefined (not exported yet).

- [ ] **Step 3: Add `maxAccuracyMeters`, `classifyFixMethod`, and the GPS timeout**

In `flutter/lib/location_task.dart`, add near the top-level constants (after `notificationChannelId`, around line 18):

```dart
const double maxAccuracyMeters = 50;

String classifyFixMethod(double? accuracy) {
  return accuracy != null && accuracy <= maxAccuracyMeters ? 'fused' : 'low_accuracy_fallback';
}
```

Add a timeout to the `getCurrentPosition` call (current lines 36-38):

```dart
      position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 25),
      );
```

Replace the hardcoded `'method': 'fused',` line (current line 54) with:

```dart
    'method': classifyFixMethod(position?.accuracy),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flutter && flutter test test/location_task_test.dart`
Expected: PASS (3 tests passed).

- [ ] **Step 5: Commit**

```bash
git add flutter/lib/location_task.dart flutter/test/location_task_test.dart
git commit -m "fix(flutter): timeout stalled GPS fixes, tag method by accuracy"
```

---

### Task 2: Retroactive signal-gap detection

**Files:**
- Modify: `flutter/lib/logger.dart`
- Modify: `flutter/lib/location_task.dart`
- Test: `flutter/test/logger_test.dart`

- [ ] **Step 1: Write the failing test**

Create `flutter/test/logger_test.dart`:

```dart
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
```

Use the same package name verified in Task 1 for the import.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flutter && flutter test test/logger_test.dart`
Expected: FAIL — `computeSignalGap` undefined (not exported yet).

- [ ] **Step 3: Add `signalGapThresholdMs`, `computeSignalGap`, and `recordHeartbeatAndDetectGap` to logger.dart**

In `flutter/lib/logger.dart`, add after the `recordHeartbeat` function (after line 96, right before the comment block starting "// Heartbeat piggybacks..."):

```dart
const int signalGapThresholdMs = 120000; // 2 min

Map<String, dynamic>? computeSignalGap(int? lastHeartbeatMs, int nowMs, int thresholdMs) {
  if (lastHeartbeatMs == null) return null;
  final gapMs = nowMs - lastHeartbeatMs;
  if (gapMs <= thresholdMs) return null;
  return {
    'gap_started_at': DateTime.fromMillisecondsSinceEpoch(lastHeartbeatMs).toUtc().toIso8601String(),
    'gap_ended_at': DateTime.fromMillisecondsSinceEpoch(nowMs).toUtc().toIso8601String(),
    'duration_ms': gapMs,
  };
}

Future<void> recordHeartbeatAndDetectGap(int thresholdMs) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final lastHeartbeat = prefs.getInt(heartbeatPrefKey);
    final now = DateTime.now().millisecondsSinceEpoch;

    final gap = computeSignalGap(lastHeartbeat, now, thresholdMs);
    if (gap != null) {
      await logEvent('signal_gap_detected', gap);
    }

    await prefs.setInt(heartbeatPrefKey, now);
  } catch (err) {
    // ignore: avoid_print
    print('recordHeartbeatAndDetectGap failed: $err');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flutter && flutter test test/logger_test.dart`
Expected: PASS (4 tests passed).

- [ ] **Step 5: Wire the new function into the location task**

In `flutter/lib/location_task.dart`, replace the final line of `_logOnce` (current line 66, `await recordHeartbeat();`) with:

```dart
  await recordHeartbeatAndDetectGap(signalGapThresholdMs);
```

`recordHeartbeat` and `recordHeartbeatAndDetectGap` are both exported from `logger.dart` via the existing `import 'logger.dart';` at the top of `location_task.dart` — no import line changes needed (Dart doesn't use named import lists like the RN version did). Do not modify `main.dart` — it still calls plain `recordHeartbeat('start_tracking')` / `recordHeartbeat('stop_tracking')`.

- [ ] **Step 6: Add a re-entrancy guard around `_logOnce`**

Code-quality review of Task 1 flagged a real risk: `Timer.periodic` does not wait for the previous callback's `Future` to resolve before scheduling the next tick, so a slow `_logOnce` call (GPS timeout up to 25s, plus battery/signal/db calls, against a 30s tick interval) can overlap with the next tick — two concurrent runs would race the heartbeat read-modify-write that `recordHeartbeatAndDetectGap` just introduced, corrupting gap detection.

In `flutter/lib/location_task.dart`, inside `onServiceStart` (find the current `Timer.periodic` block), add an in-flight guard:

```dart
  bool ticking = false;
  int count = 0;
  final timer = Timer.periodic(Duration(seconds: intervalSeconds), (timer) async {
    if (ticking) return;
    ticking = true;
    try {
      await _logOnce(db);
      count++;
      service.invoke('update', {'count': count});
    } finally {
      ticking = false;
    }
  });
```

This replaces the existing `Timer.periodic` block's body (currently just `await _logOnce(db); count++; service.invoke('update', {'count': count});` with no guard) — read the current file first to match the exact surrounding code, since `count` is already declared above the timer in the existing file; don't declare it twice.

- [ ] **Step 7: Run full test suite**

Run: `cd flutter && flutter test`
Expected: PASS (all tests — location_task_test.dart, logger_test.dart). Note: the re-entrancy guard has no dedicated unit test (it's a timing/concurrency property of a `Timer.periodic` callback, not practically unit-testable without a fake clock/timer harness, which is out of scope for this plan) — verify it by reading the code, not by a new test.

- [ ] **Step 8: Commit**

```bash
git add flutter/lib/logger.dart flutter/lib/location_task.dart flutter/test/logger_test.dart
git commit -m "feat(flutter): detect signal gaps retroactively on fix resume"
```

---

### Task 3: Manual verification

**Files:** none (manual QA only)

- [ ] **Step 1: Build and install to a real Android device**

Run: `cd flutter && flutter run --release`

- [ ] **Step 2: Start tracking**

Open the app, tap "Start logging". Confirm status shows RUNNING and the foreground-service notification appears.

- [ ] **Step 3: Simulate a signal outage**

Enable Airplane Mode. Wait at least 3 minutes (longer than `signalGapThresholdMs` = 2 min).

- [ ] **Step 4: Restore signal**

Disable Airplane Mode. Wait for the next tick (up to 30s).

- [ ] **Step 5: Export and inspect**

Tap "Export Logs", open the shared JSON file. Confirm:
- Rows continue to be written every ~30s throughout the outage (expected — Flutter's timer doesn't stop), each tagged `method: "low_accuracy_fallback"` while signal is down.
- No `TimeoutException` crashes the service — a stalled fix should cleanly resolve to a null-position row within ~25s.
- If the gap-detection event does NOT appear (likely, since the timer never actually stalled for >2min per tick), that's expected per the design's stated caveat — only note it as a bug if the app process/service itself appeared to die and restart without an `app_kill_detected` or `signal_gap_detected` event explaining the gap.

---

## Self-Review Notes

- **Spec coverage:** GPS timeout (Task 1), accuracy tagging (Task 1), retroactive gap detection (Task 2), manual verification acknowledging the reduced-likelihood caveat (Task 3). All spec sections covered.
- **Type consistency:** `classifyFixMethod(double? accuracy)` and `computeSignalGap(int? lastHeartbeatMs, int nowMs, int thresholdMs)` signatures match between their definitions and test usages.
- **No placeholders:** every step has complete code or an exact command with expected output.
- **Package name caveat:** Task 1 Step 1 flags verifying the actual Dart package name from `pubspec.yaml` before writing the test import — this wasn't hardcoded blindly since it wasn't confirmed during planning.
