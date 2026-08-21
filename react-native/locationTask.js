import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAllRawLocations, insertLocationBatch } from './db';
import { logEvent, recordHeartbeat } from './logger';
import { getSignalInfo } from './signalInfo';
import { processLocations } from './processing';
import { ACTIVE_PROFILE_KEY, APP_STATE_KEY, LOCATION_TASK_NAME, PROCESSING_CONFIG } from './trackingConfig';

export { ACTIVE_PROFILE_KEY, APP_STATE_KEY, LOCATION_TASK_NAME };
export const LOG_INTERVAL_MS = 5000;
const SESSION_KEY = 'tracking_session_id';

async function getSessionId() {
  let sessionId = await AsyncStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await AsyncStorage.setItem(SESSION_KEY, sessionId);
  }
  return sessionId;
}

function nullable(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

function toRawRow(location, index, batchId, receivedTimestampMs, appState, batteryPct, signalInfo, sessionId) {
  const coords = location?.coords || {};
  const fixTimestampMs = nullable(location?.timestamp);
  const latitude = nullable(coords.latitude);
  const longitude = nullable(coords.longitude);
  if (latitude == null || longitude == null || fixTimestampMs == null) return null;
  return {
    tracking_session_id: sessionId,
    fix_timestamp_ms: fixTimestampMs,
    received_timestamp_ms: receivedTimestampMs,
    fix_age_ms: Math.max(0, receivedTimestampMs - fixTimestampMs),
    elapsed_realtime_ns: nullable(location?.elapsedRealtimeNanos),
    batch_id: batchId,
    batch_index: index,
    latitude,
    longitude,
    horizontal_accuracy_m: nullable(coords.accuracy),
    altitude_m: nullable(coords.altitude),
    vertical_accuracy_m: nullable(coords.altitudeAccuracy),
    speed_mps: nullable(coords.speed),
    speed_accuracy_mps: nullable(coords.speedAccuracy),
    bearing_deg: nullable(coords.heading),
    bearing_accuracy_deg: nullable(coords.headingAccuracy),
    provider: location?.provider || 'fused',
    method: location?.method || 'fused',
    is_mock: location?.mocked == null ? null : location.mocked ? 1 : 0,
    app_state: appState,
    battery_pct: batteryPct,
    motion_activity: location?.motionActivity || null,
    step_count: nullable(location?.stepCount),
    signal_dbm: signalInfo.signal_dbm,
    signal_level: signalInfo.signal_level,
    carrier: signalInfo.carrier,
    network_type: signalInfo.network_type,
    created_at: new Date(receivedTimestampMs).toISOString(),
  };
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('Location task error', error);
    await logEvent('error', { reason: 'location_task_error', message: error.message });
    return;
  }
  if (!data?.locations?.length) {
    await recordHeartbeat();
    return;
  }

  // This callback runs with no supervising try/catch anywhere upstream (it's invoked directly by
  // native TaskManager). Without a local try/catch, any thrown error here — a bad DB read, a bug
  // in processLocations, anything — silently kills this delivery: nothing gets persisted, no
  // heartbeat, and no visible error, which looks identical to "the task never fires" from the UI.
  // Always log and still heartbeat so a failure is diagnosable instead of indistinguishable from
  // GPS simply not producing fixes.
  try {
    const receivedTimestampMs = Date.now();
    const appState = (await AsyncStorage.getItem(APP_STATE_KEY)) || 'background';
    const profile = (await AsyncStorage.getItem(ACTIVE_PROFILE_KEY)) || 'MOVING_NORMAL';
    const sessionId = await getSessionId();
    const batchId = `batch-${receivedTimestampMs}-${Math.random().toString(36).slice(2, 7)}`;
    const batteryLevel = await Battery.getBatteryLevelAsync().catch(() => -1);
    const signalInfo = await getSignalInfo();
    const rawRows = data.locations
      .map((location, index) => toRawRow(location, index, batchId, receivedTimestampMs, appState,
        batteryLevel >= 0 ? Math.round(batteryLevel * 100) : null, signalInfo, sessionId))
      .filter(Boolean)
      .sort((a, b) => a.fix_timestamp_ms - b.fix_timestamp_ms || a.batch_index - b.batch_index);

    if (rawRows.length) {
      const history = await getAllRawLocations();
      const processedRows = processLocations([...history, ...rawRows], { ...PROCESSING_CONFIG, nowMs: receivedTimestampMs })
        .filter((row) => row.batch_id === batchId)
        .map((row) => ({ ...row, tracking_session_id: sessionId, created_at: new Date(receivedTimestampMs).toISOString() }));
      await insertLocationBatch(rawRows, processedRows);
      await logEvent('location_task_fired', {
        batch_id: batchId,
        batch_size: rawRows.length,
        active_profile: profile,
        requested_profile: profile,
        delivered_interval_ms: processedRows.map((row) => row.interval_ms).filter((value) => value != null),
        algorithm_version: PROCESSING_CONFIG.algorithmVersion,
      });
    }
  } catch (err) {
    console.error('Location task processing failed', err);
    await logEvent('error', { reason: 'location_task_processing_failed', message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 500) });
  }
  await recordHeartbeat();
});
