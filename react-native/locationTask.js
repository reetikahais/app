import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { insertLog } from './db';
import { logEvent, recordHeartbeat } from './logger';
import { getSignalInfo } from './signalInfo';

export const LOCATION_TASK_NAME = 'raahmitra-background-location-task';
export const APP_STATE_KEY = 'app_state';
export const LOG_INTERVAL_MS = 30000;
export const MAX_ACCURACY_METERS = 50;

export function classifyFixMethod(accuracy) {
  return accuracy != null && accuracy <= MAX_ACCURACY_METERS ? 'fused' : 'low_accuracy_fallback';
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
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

    for (const location of locations) {
      const accuracy = location?.coords?.accuracy ?? null;

      const fixTime = new Date(location.timestamp);
      await insertLog({
        timestamp: Number.isNaN(fixTime.getTime()) ? new Date().toISOString() : fixTime.toISOString(),
        latitude: location?.coords?.latitude ?? null,
        longitude: location?.coords?.longitude ?? null,
        accuracy: location?.coords?.accuracy ?? null,
        battery: Math.round(batteryLevel * 100),
        app_state: appState,
        method: classifyFixMethod(accuracy),
        signal_dbm: signalInfo.signal_dbm,
        signal_level: signalInfo.signal_level,
        carrier: signalInfo.carrier,
        network_type: signalInfo.network_type,
      });
    }

    const last = locations[locations.length - 1];
    await logEvent('location_task_fired', {
      batch_size: locations.length,
      latitude: last?.coords?.latitude ?? null,
      longitude: last?.coords?.longitude ?? null,
    });
  }

  await recordHeartbeat();
});
