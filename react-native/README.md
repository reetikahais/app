# RaahMitra GPS Logger — React Native (Expo)

Local GPS evidence logger for foreground/background comparison with the Flutter version. Raw OS fixes are retained in SQLite and processed route decisions are stored separately.

Uses `expo-location`'s background task API (backed by Android's fused location provider), not Expo Go — background location needs a **dev client** build.

## First-time setup (after Android SDK/adb/Java are installed)

```powershell
cd react-native
npx expo run:android
```

This builds and installs a debug dev-client APK on the connected device (`adb devices` must show your Redmi 9A). Subsequent runs: `npx expo start --dev-client` and reload on-device, or `npx expo run:android` again after native changes (permissions, plugins).

## What it does

- Foreground screen: Start/Stop button, running status, log count (polled from SQLite every 5s).
- Background: `expo-task-manager` + `expo-location.startLocationUpdatesAsync` runs as an Android foreground service with an explicit 5-second `MOVING_NORMAL` request. The delivered interval is measured rather than assumed.
- Storage: every valid OS fix is written to `raw_locations`; `processed_locations` records freshness, confidence, filtered coordinates, movement state, and route segment decisions. Legacy `logs` remains readable.
- Route display: accepted filtered GPS is the offline fallback. `routeMatching.js` is a sequence-based adapter for a self-hosted Valhalla pedestrian matcher; leave `MATCHER_ENDPOINT` null to record and export GPS without network access.
- App state (foreground/background) tracked via React Native's `AppState`, written to `AsyncStorage`, read by the background task (`locationTask.js`) since it may run in a different JS context.
- Location method logged as `fused` — matches what `geolocator` uses on the Flutter side.

## Pulling the log for Phase 3 comparison

```powershell
adb shell run-as com.raahmitra.gpslogger cat /data/data/com.raahmitra.gpslogger/files/SQLite/gps_log.db > gps_log.db
```

Open with any SQLite browser. Inspect `raw_locations` and `processed_locations`; `logs` is retained for compatibility.

For route diagnostics, open `../tools/gps-route-analyzer.html` directly and load the JSON export. See [LOGGING.md](../docs/LOGGING.md) for status semantics and field-test verification.

## Running the 6 scenarios

See the test plan's Phase 2 table. For scenario 5 (battery optimization ON), don't grant the "unrestricted battery usage" prompt — leave the OS default.

## Walking route matching

When a Valhalla-compatible pedestrian matching service is available, set `MATCHER_ENDPOINT` in `trackingConfig.js`. The adapter sends accepted points with timestamps and accuracy, requests a pedestrian profile, and accepts only explicit matched segments. Low-confidence, unavailable, or failed matching falls back to processed GPS; raw GPS is never overwritten.

The New ISBT Shimla / Tutikandi walk is the primary manual benchmark. Check that curved mapped paths are followed only when the sequence supports them, while missing trails and long delivery gaps remain GPS fallback or disconnected segments.
