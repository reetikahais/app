# RaahMitra GPS Logger — React Native (Expo)

Throwaway app. Only job: log GPS/battery/state every 30s to local SQLite, foreground or background, so we can compare against the Flutter version per the [test plan](../%23%20RaahMitra%20%E2%80%94%20React%20Native%20vs%20Flutter%20GP.md).

Uses `expo-location`'s background task API (backed by Android's fused location provider), not Expo Go — background location needs a **dev client** build.

## First-time setup (after Android SDK/adb/Java are installed)

```powershell
cd react-native
npx expo run:android
```

This builds and installs a debug dev-client APK on the connected device (`adb devices` must show your Redmi 9A). Subsequent runs: `npx expo start --dev-client` and reload on-device, or `npx expo run:android` again after native changes (permissions, plugins).

## What it does

- Foreground screen: Start/Stop button, running status, log count (polled from SQLite every 5s).
- Background: `expo-task-manager` + `expo-location.startLocationUpdatesAsync` runs as an Android foreground service, firing every 30s, writing timestamp/lat/lon/accuracy/battery/app_state/method to SQLite (`gps_log.db`).
- App state (foreground/background) tracked via React Native's `AppState`, written to `AsyncStorage`, read by the background task (`locationTask.js`) since it may run in a different JS context.
- Location method logged as `fused` — matches what `geolocator` uses on the Flutter side.

## Pulling the log for Phase 3 comparison

```powershell
adb shell run-as com.raahmitra.gpslogger cat /data/data/com.raahmitra.gpslogger/files/SQLite/gps_log.db > gps_log.db
```

Open with any SQLite browser, table `logs`.

## Running the 6 scenarios

See the test plan's Phase 2 table. For scenario 5 (battery optimization ON), don't grant the "unrestricted battery usage" prompt — leave the OS default.
