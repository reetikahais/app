# Signal-Gap Detection + Fallback Accuracy Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently losing GPS data during signal outages — keep low-accuracy fixes instead of discarding them, and log a retroactive `signal_gap_detected` event once signal returns after a >2min outage.

**Architecture:** Extends the existing background-location heartbeat mechanism in `react-native/locationTask.js` and `react-native/logger.js`. No new background process — gaps are detected the moment the task next fires, since a live mid-outage watchdog is not achievable under OS background-execution limits (see [design spec](../specs/2026-08-17-signal-gap-detection-design.md)).

**Tech Stack:** Expo SDK 57, React Native 0.86.2, expo-task-manager, expo-location, AsyncStorage. Test infra added: jest + jest-expo (none existed before this plan).

---

## File Structure

- Modify: `react-native/package.json` — add jest/jest-expo devDependencies, `test` script, jest config
- Create: `react-native/__tests__/locationTask.test.js` — tests for `classifyFixMethod`
- Modify: `react-native/locationTask.js` — add `classifyFixMethod`, `SIGNAL_GAP_THRESHOLD_MS`; stop discarding low-accuracy fixes; call `recordHeartbeatAndDetectGap`
- Create: `react-native/__tests__/logger.test.js` — tests for `computeSignalGap`
- Modify: `react-native/logger.js` — add `computeSignalGap`, `recordHeartbeatAndDetectGap`

---

### Task 1: Add jest-expo test infrastructure

**Files:**
- Modify: `react-native/package.json`

- [ ] **Step 1: Add devDependencies, test script, and jest config**

Edit `react-native/package.json`:

```json
{
  "name": "raahmitra-rn-gps-logger",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@react-native-async-storage/async-storage": "2.2.0",
    "expo": "~57.0.12",
    "expo-battery": "~57.0.1",
    "expo-dev-client": "~57.0.11",
    "expo-file-system": "~57.0.2",
    "expo-intent-launcher": "~57.0.1",
    "expo-location": "~57.0.9",
    "expo-sharing": "~57.0.11",
    "expo-sqlite": "~57.0.1",
    "expo-status-bar": "~57.0.1",
    "expo-task-manager": "~57.0.9",
    "react": "19.2.3",
    "react-native": "0.86.2"
  },
  "devDependencies": {
    "jest": "^30.4.2",
    "jest-expo": "~57.0.4"
  },
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "web": "expo start --web",
    "test": "jest"
  },
  "jest": {
    "preset": "jest-expo"
  },
  "private": true
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd react-native && npm install`
Expected: installs `jest` and `jest-expo` into `node_modules`, no errors.

- [ ] **Step 3: Write a smoke test to confirm the preset works**

Create `react-native/__tests__/smoke.test.js`:

```js
test('jest-expo preset loads', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Run the smoke test**

Run: `cd react-native && npm test`
Expected: PASS (1 test passed).

- [ ] **Step 5: Commit**

```bash
git add react-native/package.json react-native/package-lock.json react-native/__tests__/smoke.test.js
git commit -m "test(rn): add jest-expo test infrastructure"
```

---

### Task 2: Stop discarding low-accuracy fixes, tag method instead

**Files:**
- Modify: `react-native/locationTask.js`
- Test: `react-native/__tests__/locationTask.test.js`

- [ ] **Step 1: Write the failing test**

Create `react-native/__tests__/locationTask.test.js`:

```js
import { classifyFixMethod, MAX_ACCURACY_METERS } from '../locationTask';

describe('classifyFixMethod', () => {
  test('accuracy at or below threshold is fused', () => {
    expect(classifyFixMethod(10)).toBe('fused');
    expect(classifyFixMethod(MAX_ACCURACY_METERS)).toBe('fused');
  });

  test('accuracy above threshold is low_accuracy_fallback', () => {
    expect(classifyFixMethod(MAX_ACCURACY_METERS + 1)).toBe('low_accuracy_fallback');
    expect(classifyFixMethod(500)).toBe('low_accuracy_fallback');
  });

  test('null accuracy is low_accuracy_fallback', () => {
    expect(classifyFixMethod(null)).toBe('low_accuracy_fallback');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-native && npm test -- locationTask.test.js`
Expected: FAIL — `classifyFixMethod is not a function` (not exported yet).

- [ ] **Step 3: Add `classifyFixMethod` and stop discarding fixes**

In `react-native/locationTask.js`, add the exported function right after the `MAX_ACCURACY_METERS` constant (after line 11):

```js
export const MAX_ACCURACY_METERS = 50;

export function classifyFixMethod(accuracy) {
  return accuracy != null && accuracy <= MAX_ACCURACY_METERS ? 'fused' : 'low_accuracy_fallback';
}
```

Then replace the discard block and `method: 'fused'` line inside the `for` loop (current lines 28-43):

```js
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
```

This removes the `location_fix_discarded` event and the `continue` — every fix is now stored.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-native && npm test -- locationTask.test.js`
Expected: PASS (3 tests passed).

- [ ] **Step 5: Commit**

```bash
git add react-native/locationTask.js react-native/__tests__/locationTask.test.js
git commit -m "fix(rn): stop discarding low-accuracy GPS fixes"
```

---

### Task 3: Retroactive signal-gap detection

**Files:**
- Modify: `react-native/logger.js`
- Modify: `react-native/locationTask.js`
- Test: `react-native/__tests__/logger.test.js`

- [ ] **Step 1: Write the failing test**

Create `react-native/__tests__/logger.test.js`:

```js
import { computeSignalGap } from '../logger';

describe('computeSignalGap', () => {
  test('no prior heartbeat returns null', () => {
    expect(computeSignalGap(null, Date.now(), 120000)).toBeNull();
  });

  test('gap under threshold returns null', () => {
    const last = 1000000;
    const now = last + 60000; // 1 min gap, threshold 2 min
    expect(computeSignalGap(String(last), now, 120000)).toBeNull();
  });

  test('gap over threshold returns event details', () => {
    const last = 1000000;
    const now = last + 300000; // 5 min gap, threshold 2 min
    const result = computeSignalGap(String(last), now, 120000);
    expect(result).toEqual({
      gap_started_at: new Date(last).toISOString(),
      gap_ended_at: new Date(now).toISOString(),
      duration_ms: 300000,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-native && npm test -- logger.test.js`
Expected: FAIL — `computeSignalGap is not a function` (not exported yet).

- [ ] **Step 3: Add `computeSignalGap` and `recordHeartbeatAndDetectGap` to logger.js**

In `react-native/logger.js`, add after the `recordHeartbeat` function (after line 82):

```js
export function computeSignalGap(lastHeartbeatStr, now, thresholdMs) {
  if (!lastHeartbeatStr) return null;
  const gapMs = now - Number(lastHeartbeatStr);
  if (gapMs <= thresholdMs) return null;
  return {
    gap_started_at: new Date(Number(lastHeartbeatStr)).toISOString(),
    gap_ended_at: new Date(now).toISOString(),
    duration_ms: gapMs,
  };
}

export async function recordHeartbeatAndDetectGap(thresholdMs) {
  try {
    const lastHeartbeatStr = await AsyncStorage.getItem(HEARTBEAT_KEY);
    const now = Date.now();

    const gap = computeSignalGap(lastHeartbeatStr, now, thresholdMs);
    if (gap) {
      await logEvent('signal_gap_detected', gap);
    }

    await AsyncStorage.setItem(HEARTBEAT_KEY, String(now));
  } catch (err) {
    console.error('recordHeartbeatAndDetectGap failed', err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-native && npm test -- logger.test.js`
Expected: PASS (3 tests passed).

- [ ] **Step 5: Wire the new function into the location task**

In `react-native/locationTask.js`:

Add the constant after `MAX_ACCURACY_METERS`:

```js
export const SIGNAL_GAP_THRESHOLD_MS = 120000; // 2 min
```

Update the import (current line 5):

```js
import { logEvent, recordHeartbeatAndDetectGap } from './logger';
```

Replace the final line of the task handler (current line 59):

```js
  await recordHeartbeatAndDetectGap(SIGNAL_GAP_THRESHOLD_MS);
```

Note: `App.js` still imports and calls plain `recordHeartbeat('start_tracking')` / `recordHeartbeat('stop_tracking')` from `logger.js` — that export is untouched, only `locationTask.js`'s call site changes.

- [ ] **Step 6: Run full test suite**

Run: `cd react-native && npm test`
Expected: PASS (all tests, including Task 1's smoke test and Task 2's tests).

- [ ] **Step 7: Commit**

```bash
git add react-native/logger.js react-native/locationTask.js react-native/__tests__/logger.test.js
git commit -m "feat(rn): detect signal gaps retroactively on fix resume"
```

---

### Task 4: Manual verification

**Files:** none (manual QA only)

- [ ] **Step 1: Build and install a dev client on a real Android device**

Run: `cd react-native && npm run android`

- [ ] **Step 2: Start tracking**

Open the app, tap "Start logging". Confirm status shows RUNNING and the foreground-service notification appears.

- [ ] **Step 3: Simulate a signal outage**

Enable Airplane Mode. Wait at least 3 minutes (longer than `SIGNAL_GAP_THRESHOLD_MS` = 2 min).

- [ ] **Step 4: Restore signal**

Disable Airplane Mode. Wait for the next fix (up to 30s, `LOG_INTERVAL_MS`).

- [ ] **Step 5: Export and inspect**

Tap "Export Logs", open the shared JSON file. Confirm:
- `events` array contains a `signal_gap_detected` entry with `duration_ms` roughly matching the outage length.
- `logs` array has no missing/discarded rows for fixes taken while signal was marginal (e.g. right as Airplane Mode was toggled off, accuracy may be poor) — those rows should have `method: "low_accuracy_fallback"` instead of being absent.

---

## Self-Review Notes

- **Spec coverage:** discard-removal + method tagging (Task 2), retroactive gap detection via heartbeat comparison (Task 3), reset-on-start edge case (already handled by existing `recordHeartbeat('start_tracking')` call in `App.js:82`, untouched — verified no task modifies it), manual airplane-mode test (Task 4). All spec sections covered.
- **Deviation from spec pseudocode:** spec's `recordHeartbeatAndDetectGap` sketch inlined the gap math; this plan extracts the comparison into a pure `computeSignalGap` (and similarly `classifyFixMethod`) so the logic is unit-testable without mocking AsyncStorage/expo-file-system/expo-battery through `TaskManager.defineTask`'s module-level side effects. Behavior is identical; only the internal decomposition differs.
- **Type consistency:** `classifyFixMethod(accuracy)` and `computeSignalGap(lastHeartbeatStr, now, thresholdMs)` signatures are used identically in their test files and call sites.
- **No placeholders:** every step has complete code or an exact command with expected output.
