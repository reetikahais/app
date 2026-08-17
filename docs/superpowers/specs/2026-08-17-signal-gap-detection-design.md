# Signal-gap detection + fallback accuracy retention

Date: 2026-08-17
App: `react-native/` (RaahMitra GPS Logger, Expo SDK 57)

## Problem

Background location task ([locationTask.js](../../../react-native/locationTask.js)) only runs when the OS delivers a location update. If GPS/network signal is unavailable for an extended period (e.g. 30 min in a tunnel/basement), the task never fires — nothing is logged, and there is no record that a gap occurred at all. Separately, any fix with `accuracy > 50m` is discarded outright ([locationTask.js:29-33](../../../react-native/locationTask.js#L29-L33)), losing rough-but-nonzero position data during marginal signal.

## Platform constraint

A JS-owned watchdog (`setInterval`) does not survive backgrounding reliably (iOS suspends JS in background regardless of foreground-service indicators; risky on Android too). The OS-level alternative (`expo-background-fetch` / `expo-background-task`) enforces a minimum interval of ~15min on both platforms — too coarse for real-time gap detection. A live, mid-outage, sub-15-minute background watchdog is not achievable on this stack. This design accepts that constraint and detects gaps **retroactively**, the moment signal returns and the task fires again — it does not attempt to detect or react to an outage while it is still ongoing.

## Design

### 1. Stop discarding low-accuracy fixes

[locationTask.js:29-33](../../../react-native/locationTask.js#L29-L33): remove the discard/`continue`. Every fix is stored. `method` field is tagged based on `MAX_ACCURACY_METERS` (50m, unchanged threshold value):

- accuracy ≤ 50m → `method: 'fused'` (existing value, unchanged)
- accuracy > 50m (or null) → `method: 'low_accuracy_fallback'`

No schema change needed — `db.js`'s `logs.method` column already exists and is free-text.

### 2. Retroactive signal-gap detection

New constant in `locationTask.js`, alongside `LOG_INTERVAL_MS`:

```js
export const SIGNAL_GAP_THRESHOLD_MS = 120000; // 2 min
```

New function in `logger.js`, replacing the bare `recordHeartbeat()` call at [locationTask.js:59](../../../react-native/locationTask.js#L59):

```js
export async function recordHeartbeatAndDetectGap(thresholdMs) {
  const lastHeartbeatStr = await AsyncStorage.getItem(HEARTBEAT_KEY);
  const now = Date.now();

  if (lastHeartbeatStr) {
    const gapMs = now - Number(lastHeartbeatStr);
    if (gapMs > thresholdMs) {
      await logEvent('signal_gap_detected', {
        gap_started_at: new Date(Number(lastHeartbeatStr)).toISOString(),
        gap_ended_at: new Date(now).toISOString(),
        duration_ms: gapMs,
      });
    }
  }

  await AsyncStorage.setItem(HEARTBEAT_KEY, String(now));
}
```

`locationTask.js` calls `recordHeartbeatAndDetectGap(SIGNAL_GAP_THRESHOLD_MS)` instead of `recordHeartbeat()` at line 59.

First-ever heartbeat (no prior stored value) skips the gap check — matches existing `checkForMissedShutdown` first-launch handling.

`checkForMissedShutdown` (app-boot, app-kill detection) is unchanged — it is a separate concern (process death) from signal-gap-while-alive.

### 3. Reset-on-start already handles the stop/resume edge case

[App.js:82](../../../react-native/App.js#L82) already calls `recordHeartbeat('start_tracking')` when tracking starts, which resets the heartbeat baseline to "now". This means intentionally stopping tracking and resuming later does not falsely trigger a `signal_gap_detected` event covering the idle period. `recordHeartbeat(lifecycleEvent)` (the existing function) stays as-is for this call site — only the location-task call site switches to the new gap-aware variant.

## Data flow

Signal drops → OS delivers no location update → task doesn't fire → nothing happens (unavoidable — no code runs during the outage itself) → signal returns → OS delivers a fix → task fires → `recordHeartbeatAndDetectGap` compares against last stored heartbeat → if gap > 2min, `signal_gap_detected` event is written to `events.log` → the fix itself is stored normally, tagged by its own accuracy (`fused` or `low_accuracy_fallback`).

## Testing

- Unit test `recordHeartbeatAndDetectGap`: no prior heartbeat (skip), small gap (no event), gap over threshold (event fired with correct timestamps/duration).
- Unit test accuracy tagging: accuracy ≤50m → `fused`, >50m → `low_accuracy_fallback`, fix is stored in both cases (not discarded).
- Manual: toggle airplane mode for >2min during active tracking, confirm both a `signal_gap_detected` event and the resuming fix appear correctly in exported JSON.

## Out of scope

- Live/proactive mid-outage detection or retry (blocked by OS background-execution limits, see Platform constraint above).
- Any network sync/upload — app remains local-only (SQLite + manual export), unchanged by this design.
