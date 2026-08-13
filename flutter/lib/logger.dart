import 'dart:convert';
import 'dart:io';

import 'package:battery_plus/battery_plus.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String appStatePrefKey = 'app_state';
const String heartbeatPrefKey = 'last_heartbeat';
const String lifecycleEventPrefKey = 'last_lifecycle_event';
const String eventsLogFilename = 'events.log';
const int killGapMultiplier = 2;

Future<File> _eventsLogFile() async {
  final dir = await getApplicationDocumentsDirectory();
  return File(p.join(dir.path, eventsLogFilename));
}

Future<List<Map<String, dynamic>>> getAllEvents() async {
  try {
    final file = await _eventsLogFile();
    if (!file.existsSync()) return [];
    final lines = await file.readAsLines();
    final events = <Map<String, dynamic>>[];
    for (final line in lines) {
      if (line.isEmpty) continue;
      try {
        events.add(jsonDecode(line) as Map<String, dynamic>);
      } catch (_) {
        // skip malformed line
      }
    }
    return events;
  } catch (err) {
    // ignore: avoid_print
    print('getAllEvents failed: $err');
    return [];
  }
}

Future<void> clearEventsLog() async {
  try {
    final file = await _eventsLogFile();
    if (file.existsSync()) {
      await file.delete();
    }
  } catch (err) {
    // ignore: avoid_print
    print('clearEventsLog failed: $err');
  }
}

// Logging must never be able to take the app down with it — every function
// here swallows its own errors instead of letting a logging failure crash the
// caller (in particular the background service isolate).
Future<void> logEvent(String eventType, [Map<String, dynamic> metadata = const {}]) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final appState = prefs.getString(appStatePrefKey) ?? 'unknown';

    int? batteryPct;
    try {
      batteryPct = await Battery().batteryLevel;
    } catch (_) {
      batteryPct = null;
    }

    final line = jsonEncode({
      'ts': DateTime.now().toUtc().toIso8601String(),
      'event': eventType,
      'app_state': appState,
      'battery_pct': batteryPct,
      ...metadata,
    });

    final file = await _eventsLogFile();
    await file.writeAsString('$line\n', mode: FileMode.append, flush: true);
  } catch (err) {
    // ignore: avoid_print
    print('logEvent failed: $err');
  }
}

Future<void> recordHeartbeat([String? lifecycleEvent]) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(heartbeatPrefKey, DateTime.now().millisecondsSinceEpoch);
    if (lifecycleEvent != null) {
      await prefs.setString(lifecycleEventPrefKey, lifecycleEvent);
    }
  } catch (err) {
    // ignore: avoid_print
    print('recordHeartbeat failed: $err');
  }
}

// Heartbeat piggybacks on the background service's per-fix write (see
// location_task.dart) — no separate timer here, since anything owned by the
// UI isolate stops when the app backgrounds, which is exactly the case this
// needs to detect.
Future<void> checkForMissedShutdown(int logIntervalSeconds) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final lastHeartbeat = prefs.getInt(heartbeatPrefKey);
    final lastLifecycleEvent = prefs.getString(lifecycleEventPrefKey);

    if (lastHeartbeat == null) {
      await logEvent('app_start', {'reason': 'first_launch'});
      return;
    }

    if (lastLifecycleEvent == 'stop_tracking') {
      await logEvent('app_start', {'reason': 'normal'});
      return;
    }

    final gapMs = DateTime.now().millisecondsSinceEpoch - lastHeartbeat;
    final thresholdMs = killGapMultiplier * logIntervalSeconds * 1000;
    if (gapMs > thresholdMs) {
      await logEvent('app_kill_detected', {'reason': 'gap_exceeds_threshold', 'gap_ms': gapMs});
    }
    await logEvent('app_start', {'reason': 'normal'});
  } catch (err) {
    // ignore: avoid_print
    print('checkForMissedShutdown failed: $err');
  }
}
