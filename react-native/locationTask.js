import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getNewestProcessedSegment, getRecentRawLocations, getSegmentIdForRawFix, insertLocationBatch } from './db';
import { logEvent, recordHeartbeat } from './logger';
import { getSignalInfo } from './signalInfo';
import { processLocations } from './processing';
import { chooseSegmentAnchor, createMutex, nullable, rebaseSegmentIds } from './taskHelpers';
import {
  ACTIVE_PROFILE_KEY, APP_STATE_KEY, HISTORY_WINDOW_MIN_FIXES, HISTORY_WINDOW_MS, LOCATION_TASK_NAME,
  REQUESTED_PROFILE_KEY, TRACKING_MODE_KEY,
  TRACKING_MODES, TRACKING_SESSION_KEY, createSessionId, decideProfileRequest, getTrackingProfile,
  normalizeTrackingMode,
} from './trackingConfig';

export { ACTIVE_PROFILE_KEY, APP_STATE_KEY, LOCATION_TASK_NAME };
export const LOG_INTERVAL_MS = 5000;

// A new session id is minted by App.js on every START; this only creates one if none exists yet
// (e.g. a task delivery on a build upgraded from before sessions were reset per start).
async function getSessionId() {
  let sessionId = await AsyncStorage.getItem(TRACKING_SESSION_KEY);
  if (!sessionId) {
    sessionId = createSessionId();
    await AsyncStorage.setItem(TRACKING_SESSION_KEY, sessionId);
  }
  return sessionId;
}

// Deliveries can overlap (a late batch arriving while the previous one is still processing). The
// whole read-history -> process -> insert sequence is one critical section so two deliveries can
// never process the same history snapshot and then both insert on top of it.
const runExclusive = createMutex();

function toRawRow(location, index, batchId, receivedTimestampMs, appState, batteryPct, signalInfo, sessionId, mode) {
  const coords = location?.coords || {};
  const fixTimestampMs = nullable(location?.timestamp);
  const latitude = nullable(coords.latitude);
  const longitude = nullable(coords.longitude);
  if (latitude == null || longitude == null || fixTimestampMs == null) return null;
  return {
    tracking_session_id: sessionId,
    tracking_mode: mode,
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

  // Stamped on entry, before waiting for the mutex, so fix_age_ms still reflects when the OS handed
  // this batch over rather than how long it queued behind an earlier delivery.
  const receivedTimestampMs = Date.now();

  // This callback runs with no supervising try/catch anywhere upstream (it's invoked directly by
  // native TaskManager). Without a local try/catch, any thrown error here — a bad DB read, a bug
  // in processLocations, anything — silently kills this delivery: nothing gets persisted, no
  // heartbeat, and no visible error, which looks identical to "the task never fires" from the UI.
  // Always log and still heartbeat so a failure is diagnosable instead of indistinguishable from
  // GPS simply not producing fixes.
  try {
    await runExclusive(async () => {
      const appState = (await AsyncStorage.getItem(APP_STATE_KEY)) || 'background';
      const profile = (await AsyncStorage.getItem(ACTIVE_PROFILE_KEY)) || 'MOVING_NORMAL';
      const requestedProfile = (await AsyncStorage.getItem(REQUESTED_PROFILE_KEY)) || profile;
      // Legacy sessions (pre four-mode split) may have 'bike' still stored from before an app
      // update — normalize it to 'bicycle' rather than storing/propagating an ambiguous value.
      const mode = normalizeTrackingMode(await AsyncStorage.getItem(TRACKING_MODE_KEY)) || TRACKING_MODES.WALK;
      const sessionId = await getSessionId();
      const batchId = `batch-${receivedTimestampMs}-${Math.random().toString(36).slice(2, 7)}`;
      const batteryLevel = await Battery.getBatteryLevelAsync().catch(() => -1);
      const signalInfo = await getSignalInfo();
      const rawRows = data.locations
        .map((location, index) => toRawRow(location, index, batchId, receivedTimestampMs, appState,
          batteryLevel >= 0 ? Math.round(batteryLevel * 100) : null, signalInfo, sessionId, mode))
        .filter(Boolean)
        .sort((a, b) => a.fix_timestamp_ms - b.fix_timestamp_ms || a.batch_index - b.batch_index);
      if (!rawRows.length) return;

      // Only this session's recent history (never the previous trip, and not the whole session:
      // reprocessing everything made each delivery slower the longer the ride went on).
      const history = await getRecentRawLocations(sessionId, {
        minFixes: HISTORY_WINDOW_MIN_FIXES,
        sinceMs: rawRows[0].fix_timestamp_ms - HISTORY_WINDOW_MS,
      });
      const results = processLocations([...history, ...rawRows], { mode, nowMs: receivedTimestampMs });
      let newRows = results.filter((row) => row.batch_id === batchId);
      // A windowed run numbers segments from 0; continue the session's stored numbering instead.
      const lastHistory = history[history.length - 1];
      if (lastHistory) {
        const storedSegmentId = await getSegmentIdForRawFix(lastHistory.id);
        // The newest history row may have no processed row yet: anchor on the session's newest
        // processed row instead, or skip re-basing if there is none.
        const newestProcessed = storedSegmentId == null ? await getNewestProcessedSegment(sessionId) : null;
        const anchor = chooseSegmentAnchor(lastHistory, storedSegmentId, newestProcessed);
        if (anchor) newRows = rebaseSegmentIds(newRows, results, anchor.id, anchor.segmentId);
      }
      const processedRows = newRows
        .map((row) => ({ ...row, tracking_session_id: sessionId, created_at: new Date(receivedTimestampMs).toISOString() }));
      const { unpairedRawCount } = await insertLocationBatch(rawRows, processedRows);
      if (unpairedRawCount > 0) {
        await logEvent('warning', {
          reason: 'processed_row_missing',
          batch_id: batchId,
          batch_size: rawRows.length,
          unpaired_raw_count: unpairedRawCount,
        });
      }
      await logEvent('location_task_fired', {
        batch_id: batchId,
        batch_size: rawRows.length,
        active_profile: profile,
        requested_profile: requestedProfile,
        tracking_mode: mode,
        delivered_interval_ms: processedRows.map((row) => row.interval_ms).filter((value) => value != null),
        algorithm_version: getTrackingProfile(mode).algorithmVersion,
      });

      // Accuracy-driven polling escalation: sustained poor accuracy (hills, valleys, urban
      // canyon) should make the app ask the OS to try harder instead of quietly accepting
      // whatever MOVING_NORMAL keeps delivering for the rest of the session.
      //
      // This task NEVER calls stopLocationUpdatesAsync / startLocationUpdatesAsync. Android refuses
      // to start a foreground service while the app is in the background, so a switch attempted
      // here can fail after the stop already succeeded and leave tracking dead (22 Sept 2026 hill
      // ride). It only records the profile it would like; the app applies it from the foreground
      // (App.js applyPendingPollingProfile).
      const recentFixes = [...history, ...rawRows].sort((a, b) => a.fix_timestamp_ms - b.fix_timestamp_ms);
      const decision = decideProfileRequest(mode, profile, requestedProfile, recentFixes);
      if (decision.changed) {
        await AsyncStorage.setItem(REQUESTED_PROFILE_KEY, decision.requestedProfile);
        await logEvent('polling_profile_requested', {
          active_profile: profile,
          from_requested_profile: requestedProfile,
          requested_profile: decision.requestedProfile,
          tracking_mode: mode,
          reason: decision.requestedProfile === 'LIVE_SAFETY' ? 'sustained_low_accuracy' : 'accuracy_recovered',
        });
      }
    });
  } catch (err) {
    console.error('Location task processing failed', err);
    await logEvent('error', { reason: 'location_task_processing_failed', message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 500) });
  }
  await recordHeartbeat();
});
