import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Battery from 'expo-battery';
import { APP_STATE_KEY, LOG_INTERVAL_MS } from './locationTask';

const EVENTS_LOG_FILENAME = 'events.log';
const HEARTBEAT_KEY = 'last_heartbeat';
const LIFECYCLE_KEY = 'last_lifecycle_event';
const KILL_GAP_MULTIPLIER = 2;

export function clearEventsLog() {
  try {
    const file = new File(Paths.document, EVENTS_LOG_FILENAME);
    if (file.exists) file.delete();
  } catch (err) {
    console.error('clearEventsLog failed', err);
  }
}

// Logging must never be able to take the app down with it — this whole module is
// best-effort telemetry, so every exported function swallows its own errors instead
// of letting a logging failure crash the caller (in particular the background
// location task, where an uncaught throw can kill the whole process silently).
export async function logEvent(eventType, metadata = {}) {
  try {
    const appState = (await AsyncStorage.getItem(APP_STATE_KEY)) ?? 'unknown';
    let batteryPct = null;
    try {
      const level = await Battery.getBatteryLevelAsync();
      batteryPct = level >= 0 ? Math.round(level * 100) : null;
    } catch {
      batteryPct = null;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: eventType,
      app_state: appState,
      battery_pct: batteryPct,
      ...metadata,
    });

    const file = new File(Paths.document, EVENTS_LOG_FILENAME);
    if (!file.exists) file.create();
    file.write(line + '\n', { append: true });
  } catch (err) {
    console.error('logEvent failed', err);
  }
}

export async function getAllEvents() {
  try {
    const file = new File(Paths.document, EVENTS_LOG_FILENAME);
    if (!file.exists) return [];
    const text = await file.text();
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('getAllEvents failed', err);
    return [];
  }
}

export async function recordHeartbeat(lifecycleEvent) {
  try {
    await AsyncStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
    if (lifecycleEvent) {
      await AsyncStorage.setItem(LIFECYCLE_KEY, lifecycleEvent);
    }
  } catch (err) {
    console.error('recordHeartbeat failed', err);
  }
}

// Heartbeat piggybacks on locationTask's per-fix write (recordHeartbeat call there) —
// no separate JS timer, since a JS-owned interval would get suspended when the app
// backgrounds, which is exactly the case this needs to detect.
export async function checkForMissedShutdown() {
  try {
    const [lastHeartbeatStr, lastLifecycleEvent] = await Promise.all([
      AsyncStorage.getItem(HEARTBEAT_KEY),
      AsyncStorage.getItem(LIFECYCLE_KEY),
    ]);

    if (!lastHeartbeatStr) {
      await logEvent('app_start', { reason: 'first_launch' });
      return;
    }

    if (lastLifecycleEvent === 'stop_tracking') {
      await logEvent('app_start', { reason: 'normal' });
      return;
    }

    const gapMs = Date.now() - Number(lastHeartbeatStr);
    if (gapMs > KILL_GAP_MULTIPLIER * LOG_INTERVAL_MS) {
      await logEvent('app_kill_detected', { reason: 'gap_exceeds_threshold', gap_ms: gapMs });
    }
    await logEvent('app_start', { reason: 'normal' });
  } catch (err) {
    console.error('checkForMissedShutdown failed', err);
  }
}
