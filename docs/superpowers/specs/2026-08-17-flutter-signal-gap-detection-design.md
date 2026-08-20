# Signal-gap detection + fallback accuracy retention (Flutter port)

Date: 2026-08-17
App: `flutter/` (RaahMitra GPS Logger, Flutter)

## Context

This ports the design already implemented for the React Native app ([2026-08-17-signal-gap-detection-design.md](2026-08-17-signal-gap-detection-design.md)) to the Flutter app. The two apps share intent (log GPS reliably, don't silently lose data on signal loss) but have a different background execution model, which changes what "the same changes" actually means here.

## Architectural difference from RN

RN's `TaskManager.defineTask` is OS-driven: the JS callback only runs when the OS delivers a location update, so a total signal outage means the callback simply never fires — nothing runs, nothing gets logged, until signal returns.

Flutter's `flutter_background_service` is different: `onServiceStart` runs a `Timer.periodic` **inside the persistent foreground-service isolate** ([location_task.dart:86](../../../flutter/lib/location_task.dart#L86)), actively pulling a position via `Geolocator.getCurrentPosition()` every tick. This timer keeps firing every interval as long as the service process is alive — regardless of whether GPS/network signal is available. `_logOnce` already handles a failed fix by writing a row with null lat/long/accuracy and calling `recordHeartbeat()` unconditionally at the end of every tick ([location_task.dart:47-66](../../../flutter/lib/location_task.dart#L47-L66)).

Consequence: Flutter already avoids RN's original bug of losing an entire outage window — a row is written every tick either way. The signal-gap detector being ported here is still a legitimate defense-in-depth (it catches the service process stalling or dying mid-tick, and a slow/hung GPS call that delays the heartbeat write), but it will fire less often than its RN counterpart, which was compensating for a full-blown "nothing runs at all" failure mode. This is a known, accepted difference — not a bug to work around.

## Two related but separate problems, both addressed

### 1. `Geolocator.getCurrentPosition()` has no timeout

[location_task.dart:36-38](../../../flutter/lib/location_task.dart#L36-L38) calls `Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high)` with no `timeLimit`. On zero signal this can hang indefinitely rather than failing fast — which would stall that tick's `recordHeartbeat()` call (executed only after the position attempt completes), weakening gap detection exactly in the scenario it's meant to catch.

**Fix:** add `timeLimit: const Duration(seconds: 25)` (under the 30s tick interval). A stalled fix throws `TimeoutException`, already caught by the existing `catch (err)` block at line 39-42, which sets `position = null` and logs `location_task_error` — no new error-handling path needed.

### 2. No accuracy-based method tagging

Unlike RN (which used to discard fixes over 50m accuracy), Flutter never discarded anything — but it also never distinguished fix quality; `method` is hardcoded to `'fused'` regardless of actual accuracy ([location_task.dart:54](../../../flutter/lib/location_task.dart#L54)).

**Fix:** add `MAX_ACCURACY_METERS = 50` constant and a pure `classifyFixMethod(double? accuracy)` function:

```dart
const double maxAccuracyMeters = 50;

String classifyFixMethod(double? accuracy) {
  return accuracy != null && accuracy <= maxAccuracyMeters ? 'fused' : 'low_accuracy_fallback';
}
```

Used in place of the hardcoded `'fused'` string. A null/failed fix (including one that just timed out per fix #1) now correctly tags as `'low_accuracy_fallback'` instead of the misleading `'fused'`.

### 3. Retroactive signal-gap detection

Dart port of RN's `computeSignalGap`/`recordHeartbeatAndDetectGap`, adapted to this app's storage: heartbeat is stored as an `int` (epoch milliseconds, via `SharedPreferences.setInt`), not a string, so the pure function takes `int?`/`int` directly rather than parsing a stored string.

In `logger.dart`, added after `recordHeartbeat`:

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

Timestamps use `.toUtc()` to match this file's existing `logEvent` convention (line 70), unlike RN's local-time `toISOString()` — each file follows its own codebase's existing convention rather than forcing byte-identical output across platforms.

`location_task.dart`'s final `await recordHeartbeat();` (line 66) becomes `await recordHeartbeatAndDetectGap(signalGapThresholdMs);`. The import list gains `recordHeartbeatAndDetectGap`; plain `recordHeartbeat` stays exported and used elsewhere (`main.dart`'s `_start`/`_stop` for `start_tracking`/`stop_tracking` lifecycle events — untouched, same reasoning as the RN design: resets the baseline on intentional stop/resume).

## Pre-existing uncommitted work

`flutter/lib/{db.dart,location_task.dart,main.dart}` and `pubspec.yaml` had uncommitted changes in the working tree before this plan started — a signal-strength-logging feature mirroring the already-merged RN commit `b6d5bb3`. These are committed as their own prerequisite commit before this plan's changes, keeping the two features cleanly separated in history. This design's diffs are written against that post-commit baseline.

## Testing

`flutter_test` is already a dev dependency; no new test-infra setup needed (unlike the RN port, which had zero test framework beforehand). New file `flutter/test/logger_test.dart` covers `computeSignalGap` (no-prior, under-threshold, over-threshold, exact-boundary — same 4 cases as the RN port). New file `flutter/test/location_task_test.dart` covers `classifyFixMethod` (at/below threshold, above threshold, null).

Manual verification: same airplane-mode procedure as the RN plan's Task 4, run separately against a Flutter build.

## Out of scope

- Live/proactive mid-outage detection (same OS background-execution limits apply; `Timer.periodic` inside the foreground service is already the best available granularity, and it's already running every tick — there's no coarser-vs-finer knob to turn here).
- Any network sync/upload — app remains local-only (sqflite + manual export), unchanged by this design.
