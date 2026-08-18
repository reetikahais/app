import * as Location from 'expo-location';

// Expo's location API has no way to change timeInterval/distanceInterval on an already-running
// watch - the only documented path is stop then start again with new options. That restart is
// done here from foreground JS (App.js), never from inside the TaskManager task callback itself:
// Expo's docs don't cover whether stop/start-from-within-your-own-task-callback is safe, so this
// sticks to the documented-safe path even though it means interval changes only take effect while
// the app is in the foreground (see the design doc's "Adaptive polling frequency" section).
export const LOCATION_TASK_NAME = 'raahmitra-background-location-task';

// Change 4: movement state also implies a desired GPS *precision* mode, not just cadence - high
// accuracy while there's any chance of movement, Balanced (Expo's "~100m" tier) once settled
// STATIONARY. The OS/hardware still decides what it can actually deliver; this only requests.
export async function startWatch(intervalMs, { highAccuracy = true } = {}) {
  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
    accuracy: highAccuracy ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: intervalMs,
    distanceInterval: 0,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'RaahMitra GPS logger',
      notificationBody: `Logging every ${Math.round(intervalMs / 1000)}s`,
    },
  });
}

export async function stopWatch() {
  await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
}

export async function restartWatchWithOptions(intervalMs, { highAccuracy = true } = {}) {
  await stopWatch();
  await startWatch(intervalMs, { highAccuracy });
}
