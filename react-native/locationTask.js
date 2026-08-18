import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { insertLog } from './db';
import { logEvent, recordHeartbeat } from './logger';
import { getSignalInfo } from './signalInfo';
import { classifyFixMethod } from './locationFixClassifier';
import {
  createInitialMovementState,
  processLocationFix,
  getProcessedLocation,
  getDistanceFromAnchorM,
  getLocationQuality,
  wantsHighAccuracy,
  computePollingIntervalMs,
  PROCESSING_VERSION,
} from './movementStateMachine';
import { LOCATION_TASK_NAME } from './locationWatch';

export { LOCATION_TASK_NAME };
export const APP_STATE_KEY = 'app_state';
export const LOG_INTERVAL_MS = 30000;
export const MOVEMENT_STATE_KEY = 'movement_state_v1';
export const DESIRED_INTERVAL_KEY = 'desired_polling_interval_ms';
export const DESIRED_HIGH_ACCURACY_KEY = 'desired_high_accuracy';
// Tracks what's actually configured on the native watch right now - written by whichever side
// (this background task, or App.js's foreground poll) last succeeded in applying a config, and
// read by both, so neither one repeats a restart the other already made. Defaults (when unset)
// match start()'s initial startWatch() call in App.js.
export const APPLIED_INTERVAL_KEY = 'applied_polling_interval_ms';
export const APPLIED_HIGH_ACCURACY_KEY = 'applied_high_accuracy';

async function loadMovementState() {
  try {
    const raw = await AsyncStorage.getItem(MOVEMENT_STATE_KEY);
    return raw ? JSON.parse(raw) : createInitialMovementState();
  } catch (err) {
    return createInitialMovementState();
  }
}

async function saveMovementState(state) {
  await AsyncStorage.setItem(MOVEMENT_STATE_KEY, JSON.stringify(state));
}

// expo-task-manager can invoke this callback again before a previous invocation's
// load -> mutate -> save cycle on movementState finishes (e.g. two location batches
// delivered in quick succession). Chaining every invocation onto this promise serializes
// them - the next one's load only starts after the previous one's save completes - so
// movementState/anchor/candidateStreak/stopStreak/stationarySinceMs/processedLat/processedLon
// never see two invocations racing on the same read-modify-write. No fix is dropped either;
// each invocation still runs, just not concurrently with another.
let taskChain = Promise.resolve();

async function runLocationTask({ data, error }) {
  if (error) {
    console.error('Location task error', error);
    await logEvent('error', { reason: 'location_task_error', message: error.message });
    return;
  }
  if (!data) return;

  const { locations } = data;
  const appState = (await AsyncStorage.getItem(APP_STATE_KEY)) ?? 'background';

  if (locations?.length) {
    const batteryLevel = await Battery.getBatteryLevelAsync();
    const signalInfo = await getSignalInfo();
    let movementState = await loadMovementState();

    for (const location of locations) {
      const accuracy = location?.coords?.accuracy ?? null;
      const latitude = location?.coords?.latitude ?? null;
      const longitude = location?.coords?.longitude ?? null;

      let movementStateName = null;
      let processedLatitude = null;
      let processedLongitude = null;
      let distanceFromAnchorM = null;
      let locationQuality = null;

      if (latitude != null && longitude != null && accuracy != null && accuracy > 0) {
        const speed = location?.coords?.speed;
        const fix = {
          lat: latitude,
          lon: longitude,
          accuracy,
          speed: speed != null && speed >= 0 ? speed : null,
          timestampMs: location?.timestamp ?? Date.now(),
        };
        movementState = processLocationFix(movementState, fix);
        const processed = getProcessedLocation(movementState);
        movementStateName = movementState.state;
        processedLatitude = processed.lat;
        processedLongitude = processed.lon;
        distanceFromAnchorM = getDistanceFromAnchorM(movementState, fix);
        locationQuality = getLocationQuality(movementState, fix);
      }

      const fixTime = new Date(location.timestamp);
      await insertLog({
        timestamp: Number.isNaN(fixTime.getTime()) ? new Date().toISOString() : fixTime.toISOString(),
        latitude,
        longitude,
        accuracy,
        battery: Math.round(batteryLevel * 100),
        app_state: appState,
        method: classifyFixMethod(accuracy),
        signal_dbm: signalInfo.signal_dbm,
        signal_level: signalInfo.signal_level,
        carrier: signalInfo.carrier,
        network_type: signalInfo.network_type,
        movement_state: movementStateName,
        processed_latitude: processedLatitude,
        processed_longitude: processedLongitude,
        distance_from_anchor_m: distanceFromAnchorM,
        location_quality: locationQuality,
        processing_version: PROCESSING_VERSION,
      });
    }

    await saveMovementState(movementState);

    // Confirmed empirically on-device (OnePlus 6): calling stopLocationUpdatesAsync/
    // startLocationUpdatesAsync from inside this task's own callback does not fail cleanly - it
    // unregisters the task entirely (TaskManager then reports TaskNotFoundException on every
    // subsequent stop/start attempt, including from the foreground poll, until the app is
    // force-stopped and restarted). Restarting the watch must only ever happen from foreground JS
    // (App.js) - this only computes and persists the desired config for that poll to pick up.
    const desiredIntervalMs = computePollingIntervalMs(movementState, Date.now(), appState);
    const desiredHighAccuracy = wantsHighAccuracy(movementState);
    await AsyncStorage.setItem(DESIRED_INTERVAL_KEY, String(desiredIntervalMs));
    await AsyncStorage.setItem(DESIRED_HIGH_ACCURACY_KEY, desiredHighAccuracy ? '1' : '0');

    const last = locations[locations.length - 1];
    await logEvent('location_task_fired', {
      batch_size: locations.length,
      latitude: last?.coords?.latitude ?? null,
      longitude: last?.coords?.longitude ?? null,
    });
  }

  await recordHeartbeat();
}

TaskManager.defineTask(LOCATION_TASK_NAME, (event) => {
  taskChain = taskChain.then(
    () => runLocationTask(event),
    () => runLocationTask(event)
  );
  return taskChain;
});
