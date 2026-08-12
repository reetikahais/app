# Lifecycle & Shutdown-Reason Logging — Design

**Date:** 2026-08-11
**Scope:** `react-native/` app, `flutter/` app (parity build), root test-plan doc

## Problem

The RN vs Flutter GPS test plan (`# RaahMitra — React Native vs Flutter GP.md`) decides the mobile
framework based on which one survives Android's background-kill behavior better. Today "was it
killed?" (Phase 3) is answered by manually eyeballing gaps in the `logs` table timestamps. There is
no direct record of *why* the app stopped logging — user stopped it, it crashed, or Android killed
the background service/process outright.

Android/iOS give no callback when the OS kills a backgrounded process — this is a hard platform
constraint, not an implementation gap. The design below captures every event that *is* observable
and infers the unobservable case (OS kill) from a heartbeat gap detected at next launch.

## Event Schema

Append-only log file, one JSON object per line, identical shape on both platforms:

```json
{"ts": "2026-08-11T14:32:05.000Z", "event": "possible_kill", "reason": "gap_exceeds_threshold", "app_state": "background", "battery_pct": 61, "gap_ms": 145000}
```

Fields:
- `ts` — ISO 8601 timestamp of the log write (not of the event's true occurrence, for `possible_kill`).
- `event` — one of: `app_start`, `start_tracking`, `stop_tracking`, `foreground`, `background`, `js_crash`, `location_task_error`, `possible_kill`.
- `reason` — free text; `user_action`, `gap_exceeds_threshold`, error message for crashes, etc.
- `app_state` — `foreground` / `background` at time of write.
- `battery_pct` — integer 0–100, `null` if unavailable.
- `gap_ms` — only present on `possible_kill`, milliseconds since last heartbeat.

## Kill Inference

Every successful location write updates a `last_heartbeat` timestamp in persistent storage
(AsyncStorage on RN, `shared_preferences` on Flutter) — reuses the existing per-location write, no
extra timer.

On `app_start`:
1. Read `last_heartbeat` and `last_lifecycle_event`.
2. If `last_lifecycle_event` was `stop_tracking`, this is a normal restart after user stop — log `app_start` with `reason: "normal"`, done.
3. Else compute `gap_ms = now - last_heartbeat`. If `gap_ms > 3 * LOG_INTERVAL_MS`, log `possible_kill` (with the computed `gap_ms` and the `app_state`/`battery_pct` recorded at the last heartbeat), then log `app_start` with `reason: "normal"`.
4. If no `last_heartbeat` exists (first-ever launch), log `app_start` with `reason: "first_launch"`.

This directly produces the "how many times was it killed" count the test plan's Phase 3 wants,
without manual gap-hunting.

## Storage

Separate log file per platform (not the SQLite DB used for location rows):
- RN: `expo-file-system`, append lines to `${FileSystem.documentDirectory}events.log`.
- Flutter: `path_provider` + `dart:io File`, append lines to `<appDocumentsDir>/events.log`.

Rationale: keeps the location-row schema untouched (matches the test plan's existing Phase 1.1
table) and makes the events log trivially `adb pull`-able / shareable as plain text for Phase 3
comparison.

## React Native Implementation

New file `react-native/logger.js`:
- `logEvent(event, reason, extra)` — appends one JSON line to `events.log`, filling `app_state`
  (read from the existing `APP_STATE_KEY` in AsyncStorage) and `battery_pct` (via `expo-battery`,
  same call already used in `locationTask.js`).
- `recordHeartbeat()` — writes `last_heartbeat` + `last_lifecycle_event` to AsyncStorage.
- `checkForMissedShutdown()` — implements the Kill Inference steps above, called once on app start.

Wiring into existing files:
- `App.js`: call `checkForMissedShutdown()` in the top-level `useEffect` before anything else; call
  `logEvent('app_start', ...)` after. Extend the existing `AppState` listener to also call
  `logEvent('foreground'|'background', 'app_state_change')`. In `start()`/`stop()`, call
  `logEvent('start_tracking'|'stop_tracking', 'user_action')` and `recordHeartbeat()` with the
  matching `last_lifecycle_event`.
- `locationTask.js`: in the `if (error)` branch, call `logEvent('location_task_error', error.message)`
  in addition to the existing `console.error`. On successful insert, call `recordHeartbeat()`.
- New global handler in `index.js` (entry point) via `ErrorUtils.setGlobalHandler`: log `js_crash`
  with the error message/stack, then call through to the previous handler so crash behavior is
  unchanged.

## Flutter Implementation

`flutter/` currently has only a stub `main.dart` — this is a net-new parity build, not a retrofit.
Structure mirrors the RN app 1:1 so the test stays apples-to-apples:

- `lib/db.dart` — `sqflite`, same `logs` table schema as RN's `db.js`.
- `lib/logger.dart` — same event schema/JSON-lines format, `path_provider` + `File` for `events.log`,
  `shared_preferences` for `last_heartbeat`/`last_lifecycle_event`, same `checkForMissedShutdown()`
  logic.
- `lib/location_task.dart` — `geolocator` + `flutter_background_service` background task, mirrors
  `locationTask.js`: on location fix, insert log row + `recordHeartbeat()`; on task error, `logEvent`.
- `lib/main.dart` — replaces the stub: on-screen status/counter (same UI intent as RN's `App.js`),
  Start/Stop button wired to `logEvent('start_tracking'|'stop_tracking', ...)`, `WidgetsBindingObserver`
  overriding `didChangeAppLifecycleState` for foreground/background events, `FlutterError.onError`
  and `PlatformDispatcher.instance.onError` for `js_crash`-equivalent capture.

## Log Export & Sharing

Field testers won't have adb/PC access — the test plan's Phase 2 has each app run on a tester's own
phone in the field, then results need to come back. An in-app export removes the PC dependency
entirely.

New "Export Logs" button (added next to the existing Start/Stop button on both apps):
1. Share `gps_log.db` (the SQLite file) via the OS share sheet.
2. Immediately follow with a second share call for `events.log`.

Two sequential share-sheet invocations, not a zip — avoids adding a zip/archive native dependency
(costly here: each new native module means a full Gradle/CMake rebuild, ~45 min on this machine the
first time). Tester picks WhatsApp/email/Drive/Bluetooth/etc. in the native share sheet for each
file; two taps instead of one is an acceptable tradeoff for a test-only tool.

- **RN**: `expo-sharing`'s `Sharing.shareAsync(fileUri)`, called once for the db file path and once
  for `events.log`'s path (both already resolvable via `expo-sqlite`'s db path and
  `FileSystem.documentDirectory` respectively).
- **Flutter**: `share_plus`'s `Share.shareXFiles([XFile(path)])`, same two-call pattern against the
  `sqflite` db path and the `events.log` path from `path_provider`.

No new permissions required on Android 11+ (share-sheet based, not raw file access grants).

## Doc Update

`# RaahMitra — React Native vs Flutter GP.md`:
- Phase 1.1 log schema table: add a note that each app also writes `events.log` per the schema
  above (not part of the `logs` DB table — kept separate by design).
- Phase 3 "How to check 'was it killed'": rewrite to say count `possible_kill` events in `events.log`
  directly, instead of eyeballing timestamp gaps. Keep the manual-gap method as a fallback note only.

## Out of Scope

- True OS-level kill callbacks — not available on Android/iOS, hence the inference approach.
- Any server-side or remote log shipping — logs stay local, pulled manually per the test plan's
  existing no-server constraint.
- Flutter `pubspec.yaml` dependency versions beyond adding the packages named above — no attempt to
  pin exact versions here; implementation step resolves current stable versions.

## Testing

- RN: manual verification via Expo dev build — force-stop from Android settings, relaunch, confirm
  `possible_kill` appears; press Stop button, relaunch, confirm no false `possible_kill`.
- Flutter: same manual scenarios once the parity app exists (Flutter has no existing test app to
  automate against yet).
- No automated test suite exists in either app today; adding one is out of scope for this change.
- Export button: manual check that both share-sheet invocations fire and the shared files open
  correctly (db in DB Browser for SQLite, `events.log` as plain text) on the receiving end.
