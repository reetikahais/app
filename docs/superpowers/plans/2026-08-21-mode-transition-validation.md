# Mode-Transition Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the trajectory validator from permanently trapping itself in a stale transport mode — let a sustained, physically-consistent acceleration (e.g. walking → getting into a car) confirm a mode switch instead of rejecting every subsequent fast fix forever, while still rejecting an isolated GPS spike.

**Architecture:** Adds a bounded "transition buffer" to `react-native/trajectoryValidator.js`'s existing state machine, separate from its current `pendingUncertain` slot. A fix implausible for the current mode but plausible for a faster one is held (decision `UNCERTAIN`/`MODE_TRANSITION_PENDING`) instead of rejected; three mutually-consistent buffered fixes confirm the mode switch. 1:1 ported to `flutter/lib/trajectory_validator.dart`. See [design spec](../specs/2026-08-21-mode-transition-validation-design.md) for full rationale — this plan implements it, with one refinement over the spec's §5.2 found while designing concrete tests (see Self-Review Notes).

**Tech Stack:** React Native (jest, existing `react-native/__tests__/trajectoryValidator.test.js`), Flutter/Dart (existing `flutter/test/trajectory_validator_test.dart`). No new dependencies.

---

## File Structure

- Modify: `react-native/trajectoryValidator.js` — new constants, `nextFasterModes()`, `transitionBuffer` state field, `openTransitionBuffer()`, `resolveTransitionBuffer()`, wiring into `classifyFix()`
- Modify: `react-native/__tests__/trajectoryValidator.test.js` — three new `describe(...)` blocks: `mode ordering (Step22)`, `mode-transition buffer opens (Step22)`, `mode-transition buffer resolves (Step22)`
- Modify: `flutter/lib/trajectory_validator.dart` — 1:1 port of the above, plus `TransitionBufferEntry` class and JSON (de)serialization for the new field
- Modify: `flutter/test/trajectory_validator_test.dart` — 1:1 port of the new tests

No changes to `movementStateMachine.js`, `locationTask.js`, `mapPoints.js`, or their Dart equivalents — confirmed unnecessary in the design spec (§5).

---

### Task 1: Mode ordering helper + new reason constants (RN)

**Files:**
- Modify: `react-native/trajectoryValidator.js:24-33` (OUTLIER_REASON), after line 96 (new constants/helper)
- Test: `react-native/__tests__/trajectoryValidator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `react-native/__tests__/trajectoryValidator.test.js`, in the existing top-of-file import list, add `nextFasterModes` to the named imports:

```js
import {
  classifyFix,
  createInitialTrajectoryState,
  sortFixesByTimestamp,
  TRAJECTORY_DECISION,
  OUTLIER_REASON,
  MOVEMENT_MODE,
  STALE_ANCHOR_THRESHOLD_MS,
  UNCERTAIN_CONFIRM_TIMEOUT_FIXES,
  nextFasterModes,
} from '../trajectoryValidator';
```

Then add a new `describe` block anywhere after the existing `describe('mode inference hysteresis (Step7)', ...)` block:

```js
describe('mode ordering (Step22)', () => {
  test('WALKING has CYCLING and VEHICLE as faster modes, in order', () => {
    expect(nextFasterModes(MOVEMENT_MODE.WALKING)).toEqual([MOVEMENT_MODE.CYCLING, MOVEMENT_MODE.VEHICLE]);
  });

  test('CYCLING has only VEHICLE as a faster mode', () => {
    expect(nextFasterModes(MOVEMENT_MODE.CYCLING)).toEqual([MOVEMENT_MODE.VEHICLE]);
  });

  test('VEHICLE has no faster mode', () => {
    expect(nextFasterModes(MOVEMENT_MODE.VEHICLE)).toEqual([]);
  });

  test('UNKNOWN has no faster mode (its ceiling already equals VEHICLE\'s)', () => {
    expect(nextFasterModes(MOVEMENT_MODE.UNKNOWN)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-native && npm test -- trajectoryValidator.test.js -t "mode ordering"`
Expected: FAIL — `nextFasterModes is not a function` (not exported yet).

- [ ] **Step 3: Add the reason constants and helper**

In `react-native/trajectoryValidator.js`, replace the `OUTLIER_REASON` block (lines 24-33):

```js
export const OUTLIER_REASON = Object.freeze({
  IMPOSSIBLE_SPEED: 'IMPOSSIBLE_SPEED',
  EXCESSIVE_DISPLACEMENT: 'EXCESSIVE_DISPLACEMENT',
  BEARING_INCONSISTENCY: 'BEARING_INCONSISTENCY',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  DUPLICATE_OR_OUT_OF_ORDER: 'DUPLICATE_OR_OUT_OF_ORDER',
  STALE_ANCHOR_RECOVERING: 'STALE_ANCHOR_RECOVERING',
  STALE_ANCHOR_REANCHORED: 'STALE_ANCHOR_REANCHORED',
  UNCERTAIN_CONFIRMED: 'UNCERTAIN_CONFIRMED',
  MODE_TRANSITION_PENDING: 'MODE_TRANSITION_PENDING',
  MODE_TRANSITION_CONFIRMED: 'MODE_TRANSITION_CONFIRMED',
});
```

Then, right after the existing `SPEED_DISAGREEMENT_SLACK_MPS` constant (currently line 96, before `function ceilingForMode`), add:

```js
// Step22: mode-transition evidence - a fix implausible for the current mode isn't immediately
// OUTLIER/UNCERTAIN if it's plausible for a faster mode; it's buffered instead (see
// openTransitionBuffer/resolveTransitionBuffer below), and only a run of MODE_SWITCH_CONFIRM_COUNT
// mutually-consistent faster-mode fixes actually switches the mode. Reuses
// MODE_SWITCH_CONFIRM_COUNT (3) as the buffer's confirm size - this buffer IS this transition's
// hysteresis, the same bar the normal (accepted-fixes-only) mode-switch path already uses.
export const MODE_TRANSITION_BUFFER_MAX_AGE_MS = 60000;

const MODE_ORDER = [MOVEMENT_MODE.WALKING, MOVEMENT_MODE.CYCLING, MOVEMENT_MODE.VEHICLE];

// UNKNOWN has no "faster" mode - its ceiling already equals VEHICLE's (see
// UNKNOWN_MAX_SPEED_MPS), so transition evidence never needs to run while mode is still UNKNOWN.
export function nextFasterModes(mode) {
  const idx = MODE_ORDER.indexOf(mode);
  return idx === -1 ? [] : MODE_ORDER.slice(idx + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-native && npm test -- trajectoryValidator.test.js -t "mode ordering"`
Expected: PASS (4 tests passed).

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `cd react-native && npm test -- trajectoryValidator.test.js`
Expected: PASS (all existing tests plus the 4 new ones).

- [ ] **Step 6: Commit**

```bash
git add react-native/trajectoryValidator.js react-native/__tests__/trajectoryValidator.test.js
git commit -m "feat(rn): add mode-ordering helper for transition evidence (Step22)"
```

---

### Task 2: Open a transition buffer instead of rejecting outright (RN)

**Files:**
- Modify: `react-native/trajectoryValidator.js` (`createInitialTrajectoryState`, `classifyFix`, new `openTransitionBuffer`)
- Test: `react-native/__tests__/trajectoryValidator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `react-native/__tests__/trajectoryValidator.test.js`, after the `mode ordering (Step22)` block:

```js
describe('mode-transition buffer opens (Step22)', () => {
  test('a fix implausible for WALKING but plausible for VEHICLE is held, not rejected', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { state, distanceM, timeMs } = warmUp(boot.newState, 0, 0, 3, 1.2, 10);
    expect(state.mode).toBe(MOVEMENT_MODE.WALKING);

    // 140m in 10s from the anchor = 14 m/s: implausible for WALKING (ceiling 3.5 m/s). Its own
    // pace independently reads as VEHICLE-band (candidateModeForAvgSpeed, >8 m/s), and is
    // plausible against VEHICLE's ceiling too.
    const { newState, result } = classifyFix(state, fixAt(distanceM + 140, 0, timeMs + 10000, { speed: 14 }));

    expect(result.decision).toBe(TRAJECTORY_DECISION.UNCERTAIN);
    expect(result.reason).toBe(OUTLIER_REASON.MODE_TRANSITION_PENDING);
    expect(newState.mode).toBe(MOVEMENT_MODE.WALKING); // not switched yet
    expect(newState.transitionBuffer).toHaveLength(1);
    expect(newState.transitionBuffer[0].candidateMode).toBe(MOVEMENT_MODE.VEHICLE);
  });

  test('a true teleport (implausible even for VEHICLE) is still rejected outright', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { state, distanceM, timeMs } = warmUp(boot.newState, 0, 0, 3, 1.2, 10);

    // 1700m in 5s from the anchor = 340 m/s: exceeds even VEHICLE's outlier ceiling.
    const { newState, result } = classifyFix(state, fixAt(distanceM + 1700, 0, timeMs + 5000, { speed: 340 }));

    expect(result.decision).toBe(TRAJECTORY_DECISION.OUTLIER);
    expect(newState.transitionBuffer).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-native && npm test -- trajectoryValidator.test.js -t "mode-transition buffer opens"`
Expected: FAIL — `newState.transitionBuffer` is `undefined`, first test's assertions fail.

- [ ] **Step 3: Add `transitionBuffer` to state and implement `openTransitionBuffer`**

In `react-native/trajectoryValidator.js`, modify `createInitialTrajectoryState()` (currently lines 213-224) to add the new field:

```js
export function createInitialTrajectoryState() {
  return {
    lastAcceptedFix: null,
    prevAcceptedFix: null,
    speedHistory: [],
    mode: MOVEMENT_MODE.UNKNOWN,
    modeStreak: 0,
    candidateMode: null,
    pendingUncertain: null,
    outlierStreak: 0,
    transitionBuffer: [],
  };
}
```

Add a new function right before `classifyFix` (currently line 332, after `resolvePending` ends):

```js
// Step22: a fix rejected against the CURRENT mode's ceiling may still be genuine evidence of a
// real transport-mode change (walking -> vehicle) rather than noise. Picks the candidate mode via
// candidateModeForAvgSpeed (the SAME inference-band scale resolveTransitionBuffer's band-match
// check below uses) rather than ceilingForMode's own generous plausibility scale - the two scales
// disagree (e.g. 14 m/s passes CYCLING's loose ceiling but reads as VEHICLE-band on the inference
// scale), so picking by ceiling here would open a buffer under a candidateMode that a later
// same-mode segment could never actually band-match against. Returns null if the fix's own pace
// isn't even a faster mode than the current one, or if it's implausible even against that
// candidate's ceiling (a true teleport) - the caller's existing OUTLIER/UNCERTAIN result then
// stands unchanged.
function openTransitionBuffer(trajState, fix) {
  const metrics = computeTrajectoryMetrics(trajState.lastAcceptedFix, fix);
  const candidateMode = candidateModeForAvgSpeed(metrics.impliedSpeedMps);
  if (!nextFasterModes(trajState.mode).includes(candidateMode)) return null;

  const vsCandidate = classifyAgainstReference({
    refFix: trajState.lastAcceptedFix,
    prevFix: trajState.prevAcceptedFix,
    fix,
    mode: candidateMode,
  });
  if (vsCandidate.decision !== TRAJECTORY_DECISION.ACCEPTED) return null;

  return {
    newState: { ...trajState, transitionBuffer: [{ fix, candidateMode }] },
    result: {
      decision: TRAJECTORY_DECISION.UNCERTAIN,
      reason: OUTLIER_REASON.MODE_TRANSITION_PENDING,
      distanceFromLastAcceptedM: vsCandidate.distanceM,
      impliedSpeedMps: vsCandidate.impliedSpeedMps,
      movementMode: trajState.mode,
    },
  };
}
```

Then modify the tail of `classifyFix` (currently lines 367-386) to try `openTransitionBuffer` before finalizing OUTLIER/UNCERTAIN:

```js
  const outcome = classifyAgainstReference({
    refFix: trajState.lastAcceptedFix,
    prevFix: trajState.prevAcceptedFix,
    fix,
    mode: trajState.mode,
  });

  if (outcome.decision === TRAJECTORY_DECISION.ACCEPTED) {
    return acceptFix(trajState, fix, null, outcome.distanceM, outcome.impliedSpeedMps);
  }

  const transitionCandidate = openTransitionBuffer(trajState, fix);
  if (transitionCandidate) return transitionCandidate;

  if (outcome.decision === TRAJECTORY_DECISION.OUTLIER) {
    return outlierFix(trajState, fix, outcome.reason, outcome.distanceM, outcome.impliedSpeedMps);
  }
  return {
    newState: { ...trajState, pendingUncertain: { fix, age: 0, staleRecovery: false }, outlierStreak: trajState.outlierStreak + 1 },
    result: {
      decision: TRAJECTORY_DECISION.UNCERTAIN,
      reason: outcome.reason,
      distanceFromLastAcceptedM: outcome.distanceM,
      impliedSpeedMps: outcome.impliedSpeedMps,
      movementMode: trajState.mode,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-native && npm test -- trajectoryValidator.test.js -t "mode-transition buffer opens"`
Expected: PASS (2 tests passed).

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `cd react-native && npm test -- trajectoryValidator.test.js`
Expected: PASS (all existing tests plus new ones — the existing `describe('GPS jump / outlier poisoning', ...)` tests must still pass unchanged, since their jumps exceed even VEHICLE's ceiling).

- [ ] **Step 6: Commit**

```bash
git add react-native/trajectoryValidator.js react-native/__tests__/trajectoryValidator.test.js
git commit -m "feat(rn): hold faster-mode-plausible fixes as transition evidence (Step22)"
```

---

### Task 3: Confirm or discard the transition buffer (RN)

**Files:**
- Modify: `react-native/trajectoryValidator.js` (new `resolveTransitionBuffer`, wire into `classifyFix`)
- Test: `react-native/__tests__/trajectoryValidator.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `react-native/__tests__/trajectoryValidator.test.js`, after the `mode-transition buffer opens (Step22)` block:

```js
describe('mode-transition buffer resolves (Step22)', () => {
  test('3 mutually-consistent faster fixes confirm the new mode', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { state, distanceM, timeMs } = warmUp(boot.newState, 0, 0, 3, 1.2, 10);

    // fix1: 140m/10s from the anchor = 14 m/s -> opens a VEHICLE transition buffer.
    const s1 = classifyFix(state, fixAt(distanceM + 140, 0, timeMs + 10000, { speed: 14 }));
    expect(s1.result.reason).toBe(OUTLIER_REASON.MODE_TRANSITION_PENDING);

    // fix2: +160m/10s = 16 m/s from fix1 -> still VEHICLE-band, same bearing, extends the buffer.
    const s2 = classifyFix(s1.newState, fixAt(distanceM + 300, 0, timeMs + 20000, { speed: 16 }));
    expect(s2.result.reason).toBe(OUTLIER_REASON.MODE_TRANSITION_PENDING);
    expect(s2.newState.transitionBuffer).toHaveLength(2);

    // fix3: +180m/10s = 18 m/s from fix2 -> 3rd consistent fix confirms VEHICLE.
    const fix3 = fixAt(distanceM + 480, 0, timeMs + 30000, { speed: 18 });
    const s3 = classifyFix(s2.newState, fix3);
    expect(s3.result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(s3.result.reason).toBe(OUTLIER_REASON.MODE_TRANSITION_CONFIRMED);
    expect(s3.newState.mode).toBe(MOVEMENT_MODE.VEHICLE);
    expect(s3.newState.transitionBuffer).toHaveLength(0);
    expect(s3.newState.lastAcceptedFix.lat).toBeCloseTo(fix3.lat, 9);
  });

  test('an isolated spike-and-return never confirms a mode switch', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { state, distanceM, timeMs } = warmUp(boot.newState, 0, 0, 3, 1.2, 10);

    // spike: 150m/5s from the anchor = 30 m/s -> opens a VEHICLE transition buffer.
    const s1 = classifyFix(state, fixAt(distanceM + 150, 0, timeMs + 5000, { speed: 30 }));
    expect(s1.result.reason).toBe(OUTLIER_REASON.MODE_TRANSITION_PENDING);
    expect(s1.newState.transitionBuffer).toHaveLength(1);

    // recover: back near where normal walking from the ORIGINAL anchor would put it (13m over
    // the full 10s since the anchor = 1.3 m/s) - relative to the spike this reverses bearing by
    // ~180 degrees, discarding the buffer outright (the band-match check alone would NOT catch
    // this: 150m/5s back down to 13m over the next 5s is still a ~27m/s segment, itself still
    // VEHICLE-band - bearing is what actually catches the "teleported out and back" signature).
    const s2 = classifyFix(s1.newState, fixAt(distanceM + 13, 0, timeMs + 10000, { speed: 1.3 }));

    expect(s2.result.decision).toBe(TRAJECTORY_DECISION.ACCEPTED);
    expect(s2.newState.mode).toBe(MOVEMENT_MODE.WALKING);
    expect(s2.newState.transitionBuffer).toHaveLength(0);
  });

  test('an unconfirmed buffer older than MODE_TRANSITION_BUFFER_MAX_AGE_MS is discarded, not carried forward', () => {
    const boot = classifyFix(createInitialTrajectoryState(), fixAt(0, 0, 0));
    const { state, distanceM, timeMs } = warmUp(boot.newState, 0, 0, 3, 1.2, 10);

    // fix1 opens a VEHICLE buffer.
    const s1 = classifyFix(state, fixAt(distanceM + 140, 0, timeMs + 10000, { speed: 14 }));
    expect(s1.newState.transitionBuffer).toHaveLength(1);

    // fix2 arrives 65s after fix1 (> MODE_TRANSITION_BUFFER_MAX_AGE_MS = 60000) - even though it
    // would otherwise look consistent, the stale buffer must be thrown away, not extended.
    const s2 = classifyFix(s1.newState, fixAt(distanceM + 300, 0, timeMs + 75000, { speed: 16 }));

    expect(s2.newState.transitionBuffer).not.toHaveLength(2);
    expect(s2.newState.mode).toBe(MOVEMENT_MODE.WALKING);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-native && npm test -- trajectoryValidator.test.js -t "mode-transition buffer resolves"`
Expected: FAIL — `s2.newState.transitionBuffer` stays empty / mode never switches (no confirm/discard logic yet), or `classifyFix` throws on `trajState.transitionBuffer.length` since the buffer is never consumed.

- [ ] **Step 3: Implement `resolveTransitionBuffer` and wire it in**

In `react-native/trajectoryValidator.js`, add a new function right after `openTransitionBuffer`:

```js
// Step22: extends, confirms, or discards a run of candidate-faster-mode fixes. Confirmation
// requires ALL of: (1) plausible distance from the last buffered fix at the candidate mode's own
// ceiling; (2) the segment's own implied speed independently lands in the candidate mode's
// inference band (candidateModeForAvgSpeed) - stops a single wide ceiling (e.g. VEHICLE) from
// rubber-stamping a fix that's actually walking-slow; (3) bearing continuity relative to the fix
// before the one being compared against - checked unconditionally, not just on borderline cases,
// since a genuine mode transition keeps heading the same way, while a GPS spike-and-return
// reverses bearing back toward where the walker actually was (the "1.3 -> 25 -> 1.4" case - see
// design doc for why classifyAgainstReference's own borderline-only bearing check isn't enough
// here).
function resolveTransitionBuffer(trajState, fix) {
  const buffer = trajState.transitionBuffer;
  const first = buffer[0];

  if (fix.timestampMs - first.fix.timestampMs > MODE_TRANSITION_BUFFER_MAX_AGE_MS) {
    return classifyFix({ ...trajState, transitionBuffer: [] }, fix);
  }

  const candidateMode = first.candidateMode;
  const last = buffer[buffer.length - 1];
  const prevFix = buffer.length >= 2 ? buffer[buffer.length - 2].fix : trajState.lastAcceptedFix;

  const vsLast = classifyAgainstReference({ refFix: last.fix, prevFix, fix, mode: candidateMode });
  const bandMatches = candidateModeForAvgSpeed(vsLast.impliedSpeedMps) === candidateMode;
  const bearingOk = !bearingInconsistent(prevFix, last.fix, fix, vsLast.distanceM);

  if (vsLast.decision !== TRAJECTORY_DECISION.ACCEPTED || !bandMatches || !bearingOk) {
    return classifyFix({ ...trajState, transitionBuffer: [] }, fix);
  }

  const nextBuffer = [...buffer, { fix, candidateMode }];
  if (nextBuffer.length < MODE_SWITCH_CONFIRM_COUNT) {
    return {
      newState: { ...trajState, transitionBuffer: nextBuffer },
      result: {
        decision: TRAJECTORY_DECISION.UNCERTAIN,
        reason: OUTLIER_REASON.MODE_TRANSITION_PENDING,
        distanceFromLastAcceptedM: vsLast.distanceM,
        impliedSpeedMps: vsLast.impliedSpeedMps,
        movementMode: trajState.mode,
      },
    };
  }

  // Seed the confirmed mode's speed history from the buffer's own evidence (excluding the
  // confirming fix itself - acceptFix's updateMode call below appends that one via its normal
  // impliedSpeedMps parameter, so seeding it here too would double-count it).
  const seeded = nextBuffer.slice(0, -1);
  const speedHistory = seeded.map((entry, i) => {
    const ref = i === 0 ? trajState.lastAcceptedFix : seeded[i - 1].fix;
    return computeTrajectoryMetrics(ref, entry.fix).impliedSpeedMps;
  });

  const confirmed = {
    ...trajState,
    mode: candidateMode,
    speedHistory,
    candidateMode: null,
    modeStreak: 0,
    transitionBuffer: [],
  };
  return acceptFix(confirmed, fix, OUTLIER_REASON.MODE_TRANSITION_CONFIRMED, vsLast.distanceM, vsLast.impliedSpeedMps);
}
```

Then wire it into `classifyFix`: right after the existing `if (trajState.pendingUncertain) { return resolvePending(trajState, fix); }` line, add:

```js
  if (trajState.transitionBuffer.length > 0) {
    return resolveTransitionBuffer(trajState, fix);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd react-native && npm test -- trajectoryValidator.test.js -t "mode-transition buffer resolves"`
Expected: PASS (3 tests passed).

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `cd react-native && npm test -- trajectoryValidator.test.js`
Expected: PASS — every test in the file, including all pre-existing `describe` blocks (bootstrap, walking/cycling/car mode, GPS jump/outlier poisoning, sharp legitimate turn, accuracy-aware plausibility, duplicate/out-of-order, false movement transition guard, UNCERTAIN resolution, stale-anchor recovery, mode inference hysteresis) plus all new Step22 blocks.

- [ ] **Step 6: Commit**

```bash
git add react-native/trajectoryValidator.js react-native/__tests__/trajectoryValidator.test.js
git commit -m "feat(rn): confirm or discard mode-transition buffer (Step22)"
```

---

### Task 4: Port to Flutter/Dart

**Files:**
- Modify: `flutter/lib/trajectory_validator.dart`
- Modify: `flutter/test/trajectory_validator_test.dart`

- [ ] **Step 1: Add reason constants, mode-ordering helper, and buffer state**

In `flutter/lib/trajectory_validator.dart`, add to the `OutlierReason` class:

```dart
class OutlierReason {
  static const String impossibleSpeed = 'IMPOSSIBLE_SPEED';
  static const String excessiveDisplacement = 'EXCESSIVE_DISPLACEMENT';
  static const String bearingInconsistency = 'BEARING_INCONSISTENCY';
  static const String lowConfidence = 'LOW_CONFIDENCE';
  static const String duplicateOrOutOfOrder = 'DUPLICATE_OR_OUT_OF_ORDER';
  static const String staleAnchorRecovering = 'STALE_ANCHOR_RECOVERING';
  static const String staleAnchorReanchored = 'STALE_ANCHOR_REANCHORED';
  static const String uncertainConfirmed = 'UNCERTAIN_CONFIRMED';
  static const String modeTransitionPending = 'MODE_TRANSITION_PENDING';
  static const String modeTransitionConfirmed = 'MODE_TRANSITION_CONFIRMED';
}
```

Right after the `speedDisagreementSlackMps` constant, add:

```dart
// Step22: see react-native/trajectoryValidator.js for the full rationale (mirrors it 1:1).
const int modeTransitionBufferMaxAgeMs = 60000;

const List<String> _modeOrder = [MovementMode.walking, MovementMode.cycling, MovementMode.vehicle];

List<String> nextFasterModes(String mode) {
  final idx = _modeOrder.indexOf(mode);
  return idx == -1 ? const [] : _modeOrder.sublist(idx + 1);
}
```

Add a new class right after `PendingUncertainFix`:

```dart
class TransitionBufferEntry {
  final TrajectoryFix fix;
  final String candidateMode;
  const TransitionBufferEntry({required this.fix, required this.candidateMode});
}
```

Modify `TrajectoryState` to add the field, constructor default, and `copyWith` param:

```dart
class TrajectoryState {
  final TrajectoryFix? lastAcceptedFix;
  final TrajectoryFix? prevAcceptedFix;
  final List<double> speedHistory;
  final String mode;
  final int modeStreak;
  final String? candidateMode;
  final PendingUncertainFix? pendingUncertain;
  final int outlierStreak;
  final List<TransitionBufferEntry> transitionBuffer;

  const TrajectoryState({
    this.lastAcceptedFix,
    this.prevAcceptedFix,
    this.speedHistory = const [],
    this.mode = MovementMode.unknown,
    this.modeStreak = 0,
    this.candidateMode,
    this.pendingUncertain,
    this.outlierStreak = 0,
    this.transitionBuffer = const [],
  });

  TrajectoryState copyWith({
    TrajectoryFix? lastAcceptedFix,
    bool clearLastAcceptedFix = false,
    TrajectoryFix? prevAcceptedFix,
    bool clearPrevAcceptedFix = false,
    List<double>? speedHistory,
    String? mode,
    int? modeStreak,
    String? candidateMode,
    bool clearCandidateMode = false,
    PendingUncertainFix? pendingUncertain,
    bool clearPendingUncertain = false,
    int? outlierStreak,
    List<TransitionBufferEntry>? transitionBuffer,
  }) {
    return TrajectoryState(
      lastAcceptedFix: clearLastAcceptedFix ? null : (lastAcceptedFix ?? this.lastAcceptedFix),
      prevAcceptedFix: clearPrevAcceptedFix ? null : (prevAcceptedFix ?? this.prevAcceptedFix),
      speedHistory: speedHistory ?? this.speedHistory,
      mode: mode ?? this.mode,
      modeStreak: modeStreak ?? this.modeStreak,
      candidateMode: clearCandidateMode ? null : (candidateMode ?? this.candidateMode),
      pendingUncertain: clearPendingUncertain ? null : (pendingUncertain ?? this.pendingUncertain),
      outlierStreak: outlierStreak ?? this.outlierStreak,
      transitionBuffer: transitionBuffer ?? this.transitionBuffer,
    );
  }
}
```

- [ ] **Step 2: Add `_openTransitionBuffer` and `_resolveTransitionBuffer`**

Add after `_resolvePending` (before the `classifyFix` doc-comment):

```dart
// Picks the candidate mode via _candidateModeForAvgSpeed (the same inference-band scale
// _resolveTransitionBuffer's band-match check uses) rather than _ceilingForMode's own generous
// plausibility scale - see the matching comment on react-native/trajectoryValidator.js's
// openTransitionBuffer for why mixing the two scales picks the wrong candidate.
TrajectoryOutcome? _openTransitionBuffer(TrajectoryState trajState, TrajectoryFix fix) {
  final metrics = computeTrajectoryMetrics(trajState.lastAcceptedFix!, fix);
  final candidateMode = _candidateModeForAvgSpeed(metrics.impliedSpeedMps);
  if (!nextFasterModes(trajState.mode).contains(candidateMode)) return null;

  final vsCandidate = _classifyAgainstReference(
    refFix: trajState.lastAcceptedFix!,
    prevFix: trajState.prevAcceptedFix,
    fix: fix,
    mode: candidateMode,
  );
  if (vsCandidate.decision != TrajectoryDecision.accepted) return null;

  return TrajectoryOutcome(
    newState: trajState.copyWith(
      transitionBuffer: [TransitionBufferEntry(fix: fix, candidateMode: candidateMode)],
    ),
    result: TrajectoryResult(
      decision: TrajectoryDecision.uncertain,
      reason: OutlierReason.modeTransitionPending,
      distanceFromLastAcceptedM: vsCandidate.distanceM,
      impliedSpeedMps: vsCandidate.impliedSpeedMps,
      movementMode: trajState.mode,
    ),
  );
}

TrajectoryOutcome _resolveTransitionBuffer(TrajectoryState trajState, TrajectoryFix fix) {
  final buffer = trajState.transitionBuffer;
  final first = buffer.first;

  if (fix.timestampMs - first.fix.timestampMs > modeTransitionBufferMaxAgeMs) {
    return classifyFix(trajState.copyWith(transitionBuffer: const []), fix);
  }

  final candidateMode = first.candidateMode;
  final last = buffer.last;
  final prevFix = buffer.length >= 2 ? buffer[buffer.length - 2].fix : trajState.lastAcceptedFix;

  final vsLast = _classifyAgainstReference(refFix: last.fix, prevFix: prevFix, fix: fix, mode: candidateMode);
  final bandMatches = _candidateModeForAvgSpeed(vsLast.impliedSpeedMps) == candidateMode;
  final bearingOk = !_bearingInconsistent(prevFix, last.fix, fix, vsLast.distanceM);

  if (vsLast.decision != TrajectoryDecision.accepted || !bandMatches || !bearingOk) {
    return classifyFix(trajState.copyWith(transitionBuffer: const []), fix);
  }

  final nextBuffer = [...buffer, TransitionBufferEntry(fix: fix, candidateMode: candidateMode)];
  if (nextBuffer.length < modeSwitchConfirmCount) {
    return TrajectoryOutcome(
      newState: trajState.copyWith(transitionBuffer: nextBuffer),
      result: TrajectoryResult(
        decision: TrajectoryDecision.uncertain,
        reason: OutlierReason.modeTransitionPending,
        distanceFromLastAcceptedM: vsLast.distanceM,
        impliedSpeedMps: vsLast.impliedSpeedMps,
        movementMode: trajState.mode,
      ),
    );
  }

  final seeded = nextBuffer.sublist(0, nextBuffer.length - 1);
  final speedHistory = <double>[];
  for (var i = 0; i < seeded.length; i++) {
    final ref = i == 0 ? trajState.lastAcceptedFix! : seeded[i - 1].fix;
    speedHistory.add(computeTrajectoryMetrics(ref, seeded[i].fix).impliedSpeedMps);
  }

  final confirmed = trajState.copyWith(
    mode: candidateMode,
    speedHistory: speedHistory,
    modeStreak: 0,
    clearCandidateMode: true,
    transitionBuffer: const [],
  );
  return _acceptFix(confirmed, fix, OutlierReason.modeTransitionConfirmed, vsLast.distanceM, vsLast.impliedSpeedMps);
}
```

- [ ] **Step 3: Wire both into `classifyFix`**

In `classifyFix`, right after the existing `if (trajState.pendingUncertain != null) { return _resolvePending(trajState, fix); }`, add:

```dart
  if (trajState.transitionBuffer.isNotEmpty) {
    return _resolveTransitionBuffer(trajState, fix);
  }
```

Then in the tail of `classifyFix` (the `_classifyAgainstReference` call and its three branches), insert the transition-buffer attempt between the ACCEPTED branch and the OUTLIER branch:

```dart
  final outcome = _classifyAgainstReference(
    refFix: trajState.lastAcceptedFix!,
    prevFix: trajState.prevAcceptedFix,
    fix: fix,
    mode: trajState.mode,
  );

  if (outcome.decision == TrajectoryDecision.accepted) {
    return _acceptFix(trajState, fix, null, outcome.distanceM, outcome.impliedSpeedMps);
  }

  final transitionCandidate = _openTransitionBuffer(trajState, fix);
  if (transitionCandidate != null) return transitionCandidate;

  if (outcome.decision == TrajectoryDecision.outlier) {
    return _outlierFix(trajState, outcome.reason, outcome.distanceM, outcome.impliedSpeedMps);
  }
  return TrajectoryOutcome(
    newState: trajState.copyWith(
      pendingUncertain: PendingUncertainFix(fix: fix, age: 0, staleRecovery: false),
      outlierStreak: trajState.outlierStreak + 1,
    ),
    result: TrajectoryResult(
      decision: TrajectoryDecision.uncertain,
      reason: outcome.reason,
      distanceFromLastAcceptedM: outcome.distanceM,
      impliedSpeedMps: outcome.impliedSpeedMps,
      movementMode: trajState.mode,
    ),
  );
}
```

- [ ] **Step 4: Update JSON (de)serialization**

`TrajectoryState` is persisted across background-service ticks via `trajectoryStateToJson`/`trajectoryStateFromJson` — the buffer must round-trip too, or a confirmation in progress silently resets every time the service ticks. Add `transitionBuffer` to `trajectoryStateToJson`:

```dart
Map<String, dynamic> trajectoryStateToJson(TrajectoryState s) => {
      'lastAcceptedFix': s.lastAcceptedFix?.toJson(),
      'prevAcceptedFix': s.prevAcceptedFix?.toJson(),
      'speedHistory': s.speedHistory,
      'mode': s.mode,
      'modeStreak': s.modeStreak,
      'candidateMode': s.candidateMode,
      'pendingUncertain': s.pendingUncertain != null
          ? {
              'fix': s.pendingUncertain!.fix.toJson(),
              'age': s.pendingUncertain!.age,
              'staleRecovery': s.pendingUncertain!.staleRecovery,
            }
          : null,
      'outlierStreak': s.outlierStreak,
      'transitionBuffer': s.transitionBuffer
          .map((e) => {'fix': e.fix.toJson(), 'candidateMode': e.candidateMode})
          .toList(),
    };
```

And add parsing to `trajectoryStateFromJson`:

```dart
TrajectoryState trajectoryStateFromJson(Map<String, dynamic> j) => TrajectoryState(
      lastAcceptedFix: j['lastAcceptedFix'] != null ? TrajectoryFix.fromJson(j['lastAcceptedFix'] as Map<String, dynamic>) : null,
      prevAcceptedFix: j['prevAcceptedFix'] != null ? TrajectoryFix.fromJson(j['prevAcceptedFix'] as Map<String, dynamic>) : null,
      speedHistory: (j['speedHistory'] as List).map((e) => (e as num).toDouble()).toList(),
      mode: j['mode'] as String,
      modeStreak: (j['modeStreak'] as num).toInt(),
      candidateMode: j['candidateMode'] as String?,
      pendingUncertain: j['pendingUncertain'] != null
          ? PendingUncertainFix(
              fix: TrajectoryFix.fromJson((j['pendingUncertain'] as Map<String, dynamic>)['fix'] as Map<String, dynamic>),
              age: ((j['pendingUncertain'] as Map<String, dynamic>)['age'] as num).toInt(),
              staleRecovery: (j['pendingUncertain'] as Map<String, dynamic>)['staleRecovery'] as bool,
            )
          : null,
      outlierStreak: (j['outlierStreak'] as num).toInt(),
      transitionBuffer: j['transitionBuffer'] != null
          ? (j['transitionBuffer'] as List)
              .map((e) => TransitionBufferEntry(
                    fix: TrajectoryFix.fromJson((e as Map<String, dynamic>)['fix'] as Map<String, dynamic>),
                    candidateMode: e['candidateMode'] as String,
                  ))
              .toList()
          : const [],
    );
```

- [ ] **Step 5: Port the tests**

In `flutter/test/trajectory_validator_test.dart`, find the existing `fixAt`/`warmUp` Dart equivalents (mirroring the JS test file's helpers) and add Dart translations of every test added in Tasks 1-3 above (mode ordering: 4 tests; buffer opens: 2 tests; buffer resolves: 3 tests) — same scenarios, same numbers, same assertions, translated to Dart `test()`/`expect()` syntax and `TrajectoryDecision`/`OutlierReason`/`MovementMode` class constants instead of the JS `TRAJECTORY_DECISION`/`OUTLIER_REASON`/`MOVEMENT_MODE` objects.

- [ ] **Step 6: Attempt to run Flutter tests**

Run: `cd flutter && flutter test test/trajectory_validator_test.dart`

If no Flutter SDK is available in this environment (same caveat as commits `c72abf6` and `475aa13`), note that in the commit message instead of claiming a pass — do not claim PASS without having actually seen it run.

- [ ] **Step 7: Commit**

```bash
git add flutter/lib/trajectory_validator.dart flutter/test/trajectory_validator_test.dart
git commit -m "feat(flutter): port mode-transition validation (Step22)

Ported 1:1 from react-native/trajectoryValidator.js. Manually reviewed
but unexecuted if no Flutter SDK is available in this environment -
run flutter test before relying on it."
```

---

## Self-Review Notes

- **Spec coverage:** every numbered item in the design spec's §1-5 has a corresponding task —
  reason constants + mode ordering (Task 1), buffer opening/trigger (Task 2), buffer
  confirm/discard (Task 3), Dart port including persistence (Task 4). §6 (known limitation) and
  Out of Scope require no code, just the code comments already included inline.
- **Deviation from spec, found while designing concrete tests (mechanism fix):** the design
  spec's §4 described picking the candidate mode by iterating `nextFasterModes` and taking the
  first whose `ceilingForMode`-based plausibility check passed. Working through the confirm-test's
  actual numbers showed this picks the wrong mode: `ceilingForMode`'s plausibility scale (WALKING
  3.5 / CYCLING 11 / VEHICLE 41.7 m/s) and `candidateModeForAvgSpeed`'s inference-band scale
  (WALKING ≤2.2 / CYCLING ≤8 / else VEHICLE) disagree — e.g. 14 m/s passes CYCLING's loose
  ceiling but reads as VEHICLE-band on the inference scale. Picking by ceiling would open a buffer
  under `candidateMode: CYCLING` that `resolveTransitionBuffer`'s own band-match check (which
  necessarily uses the inference scale, per §5.2) could then never match against a real
  14+ m/s segment, permanently stalling the buffer at length 1. Task 2 picks the candidate mode
  directly via `candidateModeForAvgSpeed` instead (a single computation, no loop), with
  `ceilingForMode`/`classifyAgainstReference` used only as the plausibility sanity check on that
  one candidate. Both scales are now used consistently in exactly one place each.
- **Deviation from spec, found while designing concrete tests (bearing check):** the design spec's §5.2 said
  buffer extension should just re-run `classifyAgainstReference` at the candidate mode's ceiling.
  While working out the isolated-spike test (`1.3 → 25 → 1.4`), that alone proved insufficient: a
  wide ceiling like VEHICLE's accepts almost any distance, including a "spike-and-return" fix that
  reverses direction back toward the walker's true position — `classifyAgainstReference`'s own
  bearing check only ever fires on *borderline* distances, and a small return-distance is never
  borderline against VEHICLE's generous ceiling. Task 3 adds two more required conditions: (a) the
  segment's own implied speed must independently land in the candidate mode's inference band
  (`candidateModeForAvgSpeed`), and (b) bearing continuity is checked *unconditionally*, not just
  on borderline cases. Both are implemented and covered by the "isolated spike-and-return" test.
- **Placeholder scan:** every step has complete code or an exact command with expected output; no
  TBD/TODO.
- **Type consistency:** `nextFasterModes`, `openTransitionBuffer`/`_openTransitionBuffer`,
  `resolveTransitionBuffer`/`_resolveTransitionBuffer`, and the `transitionBuffer` field name and
  shape (`{ fix, candidateMode }` / `TransitionBufferEntry`) are used identically across Tasks
  1-4 and their test files.
- **Also updated (not code, but same feature):** `docs/superpowers/plans/changes.md` — appended
  as STEP 22, matching the existing STEP1-21 convention that file already establishes and that
  `trajectoryValidator.js`'s own header comment points to. That file was untracked before this
  session; left untracked (not staged in any commit above) since committing a pre-existing file
  outside this plan's scope wasn't asked for — flag if you want it added to git too.
