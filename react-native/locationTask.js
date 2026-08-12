import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { insertLog } from './db';
import { logEvent, recordHeartbeat } from './logger';

export const LOCATION_TASK_NAME = 'raahmitra-background-location-task';
export const APP_STATE_KEY = 'app_state';
export const LOG_INTERVAL_MS = 30000;

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('Location task error', error);
    await logEvent('error', { reason: 'location_task_error', message: error.message });
    return;
  }
  if (!data) return;

  const { locations } = data;
  const location = locations?.[0];
  const appState = (await AsyncStorage.getItem(APP_STATE_KEY)) ?? 'background';
  const batteryLevel = await Battery.getBatteryLevelAsync();

  await insertLog({
    timestamp: new Date().toISOString(),
    latitude: location?.coords?.latitude ?? null,
    longitude: location?.coords?.longitude ?? null,
    accuracy: location?.coords?.accuracy ?? null,
    battery: Math.round(batteryLevel * 100),
    app_state: appState,
    method: 'fused',
  });

  await logEvent('location_task_fired', {
    latitude: location?.coords?.latitude ?? null,
    longitude: location?.coords?.longitude ?? null,
  });
  await recordHeartbeat();
});
