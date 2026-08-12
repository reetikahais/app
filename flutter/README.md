# RaahMitra GPS Logger — Flutter

Throwaway app. Only job: log GPS/battery/state every 30s to local SQLite, foreground or background, so we can compare against the React Native version per the [test plan](../%23%20RaahMitra%20%E2%80%94%20React%20Native%20vs%20Flutter%20GP.md).

## First-time setup (after Flutter SDK is installed)

```powershell
cd flutter
flutter create --org com.raahmitra --project-name raahmitra_gps_logger .
```

This fills in `android/` and `ios/` without touching the existing `lib/main.dart` and `pubspec.yaml`.

Then add these permissions to `android/app/src/main/AndroidManifest.xml` (inside `<manifest>`, above `<application>`):

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>
```

And inside `<application>`, register the background service (required by `flutter_background_service`):

```xml
<service
    android:name="id.flutter.flutter_background_service.BackgroundService"
    android:foregroundServiceType="location"
    android:exported="false" />
```

Then:

```powershell
flutter pub get
flutter run
```

## What it does

- Foreground screen: Start/Stop button, running status, live count of logs written.
- Background: `flutter_background_service` runs a 30s timer as an Android foreground service, calling `geolocator` for a fix and `battery_plus` for battery %, writing a row to SQLite (`gps_log.db` in app documents dir).
- App state (foreground/background) tracked via `WidgetsBindingObserver`, shared into the background isolate via `SharedPreferences` since the service isolate can't see UI lifecycle directly.
- Location method logged as `fused` — `geolocator` uses Android's `FusedLocationProviderClient` by default, matching what the RN side logs.

## Pulling the log for Phase 3 comparison

```powershell
adb shell run-as com.raahmitra.raahmitra_gps_logger cat /data/data/com.raahmitra.raahmitra_gps_logger/app_flutter/gps_log.db > gps_log.db
```

Open with any SQLite browser, table `logs`.

## Running the 6 scenarios

See the test plan's Phase 2 table. For scenario 5 (battery optimization ON), leave the OS default — don't tap "Allow" on the ignore-battery-optimization prompt when testing that scenario.
