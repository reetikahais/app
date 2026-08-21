# Mode-transition evidence in trajectory validation

Date: 2026-08-21
App: `react-native/trajectoryValidator.js` (+ 1:1 port `flutter/lib/trajectory_validator.dart`)
Continues: `docs/superpowers/plans/changes.md` (STEP1-21) — this is Step22.

## Problem

`classifyFix`/`classifyAgainstReference` judge every fix only against the *current* inferred
mode's ceiling (`ceilingForMode(trajState.mode)`). A genuine transport-mode change (walking →
vehicle) produces fixes that are implausible for the old mode and get rejected as
OUTLIER/UNCERTAIN before they ever reach `acceptFix` — but `updateMode`'s hysteresis (the
speed-history window that would otherwise confirm the new mode) only runs on ACCEPTED fixes.
Net effect: a sustained, physically-real acceleration (walking → car) can get permanently stuck
rejecting every subsequent car-speed fix against a stale walking-speed anchor, because none of
them are ever allowed to accumulate mode-switch evidence. A single GPS teleport must still be
rejected — the fix must not let isolated spikes trigger a false mode switch either.

## Design

### 1. New reason constants

`react-native/trajectoryValidator.js`, added to the existing `OUTLIER_REASON` freeze block:

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
  MODE_TRANSITION_PENDING: 'MODE_TRANSITION_PENDING',   // NEW — held, decision UNCERTAIN
  MODE_TRANSITION_CONFIRMED: 'MODE_TRANSITION_CONFIRMED', // NEW — used as an accept reason
});
```

`MODE_TRANSITION_PENDING` is a decision reason under `TRAJECTORY_DECISION.UNCERTAIN` — same
convention `STALE_ANCHOR_RECOVERING` already uses. This needs zero changes to any call site
(`locationTask.js`, `mapPoints.js`, Flutter equivalents) that branches on `decision ===
'ACCEPTED'`, since UNCERTAIN behaves exactly as it already does everywhere downstream.

### 2. Mode ordering + candidate-mode lookup

```js
const MODE_ORDER = [MOVEMENT_MODE.WALKING, MOVEMENT_MODE.CYCLING, MOVEMENT_MODE.VEHICLE];

function nextFasterModes(mode) {
  const idx = MODE_ORDER.indexOf(mode);
  return idx === -1 ? [] : MODE_ORDER.slice(idx + 1);
}
```

`MOVEMENT_MODE.UNKNOWN` returns `[]` (its ceiling already equals VEHICLE's — the fastest band —
so there is never a faster mode to consider; transition logic simply never engages while mode is
UNKNOWN). Reuses the existing `candidateModeForAvgSpeed()` and `classifyAgainstReference()`
helpers — no new distance/speed math.

### 3. New buffer state

Added to `createInitialTrajectoryState()`:

```js
transitionBuffer: [], // { fix, candidateMode }[], bounded by count and age
```

Separate from `pendingUncertain` (which keeps its existing two jobs — low-confidence
confirmation and stale-anchor recovery — completely untouched).

```js
export const MODE_TRANSITION_BUFFER_MAX_AGE_MS = 60000; // 60s
```

Max buffer size reuses the existing `MODE_SWITCH_CONFIRM_COUNT` (3) rather than a new constant
— buffer confirmation *is* this transition's hysteresis, so it uses the same "3 consistent
fixes" bar the normal mode-switch path already uses.

### 4. Trigger: opening the buffer

Inside `classifyFix`, when `transitionBuffer` is empty and `classifyAgainstReference` against
`trajState.mode` returns anything other than ACCEPTED, before finalizing that result, try each
mode in `nextFasterModes(trajState.mode)` (slowest-faster first) and re-run
`classifyAgainstReference` with that candidate mode. The first one that returns ACCEPTED opens
the buffer:

```js
result.decision = 'UNCERTAIN';
result.reason = OUTLIER_REASON.MODE_TRANSITION_PENDING;
newState.transitionBuffer = [{ fix, candidateMode }];
```

If no faster mode makes it plausible either (a true teleport, e.g. 1.7km in 5s exceeds even
VEHICLE's outlier ceiling), fall through to the existing OUTLIER/UNCERTAIN result unchanged.

### 5. Confirming or discarding the buffer

While `transitionBuffer` is non-empty, `classifyFix` routes to a new `resolveTransitionBuffer`
(checked before the existing stale-anchor/`pendingUncertain` branches, mutually exclusive with
them — a fix is never in both a transition buffer and a stale-anchor recovery chain at once):

1. If `fix.timestampMs - transitionBuffer[0].fix.timestampMs > MODE_TRANSITION_BUFFER_MAX_AGE_MS`
   → discard the buffer, re-run `classifyFix` on this fix as if the buffer never existed
   (same recursive-fallback pattern `resolvePending`'s timeout path already uses).
2. Otherwise run `classifyAgainstReference({ refFix: lastBufferedFix, prevFix: ..., fix, mode:
   candidateMode })`. ACCEPTED → append `{ fix, candidateMode }`, decision stays UNCERTAIN /
   `MODE_TRANSITION_PENDING`. Not ACCEPTED → discard the buffer and re-run `classifyFix` fresh
   (same fallback as above) — this is what stops an isolated spike (`1.3 → 25 → 1.4`) from
   ever confirming: the 1.4 m/s fix disagrees with the buffered 25 m/s fix at the candidate
   ceiling, the buffer is thrown away, and 1.4 m/s gets classified fresh against the untouched
   original anchor — ordinary ACCEPTED walking, no mode switch, no permanent trap.
3. Once the buffer reaches length `MODE_SWITCH_CONFIRM_COUNT` (3) → confirm: `trajState.mode`
   is set directly to `candidateMode` (bypassing the normal `updateMode` speed-history hysteresis
   — buffer confirmation *is* the hysteresis for this path), `speedHistory` reset from the
   buffer's own implied speeds, `candidateMode`/`modeStreak` cleared, buffer cleared, and the
   newest buffered fix is accepted via the existing `acceptFix` helper with reason
   `MODE_TRANSITION_CONFIRMED`.

No changes needed in `movementStateMachine.js` or `locationTask.js`: once accepted, the promoted
fix flows through `processLocationFix` exactly like any other accepted fix. Verified against
`movementStateMachine.js` — `processStationary`/`processConfirmingMovement` already react
generically to an arbitrary jump-from-anchor distance via the existing
CONFIRMING_MOVEMENT→MOVING threshold/bearing path (this is the same mechanism that already
smooths in today's `STALE_ANCHOR_REANCHORED` jumps — e.g. this session's fix #64,
`distance_from_anchor_m: 163.7`, landed in `CONFIRMING_MOVEMENT` exactly as expected). A
mode-transition promotion needs no special reset code; the existing pipeline already handles it.

### 6. Known limitation (accepted, documented in code comment)

Fixes held in the buffer while it was accumulating (steps 2 of the example: 4, 8 m/s) are
already returned to the caller as `UNCERTAIN`/`MODE_TRANSITION_PENDING` at the time they were
processed — this is a streaming, per-fix classifier with no retroactive rewrite of
already-emitted results. Only the fix that completes confirmation (the 3rd, e.g. 14 m/s) is
promoted to ACCEPTED. This satisfies the actual behavioral requirement (no false mode trap, no
teleport slipping through) even though the two earlier evidence fixes remain excluded from the
trail — same non-treatment `mapPoints.js` already gives any UNCERTAIN row today.

## Data flow

```
fix implausible for current mode
    |
    v
plausible for a faster mode? --no--> existing OUTLIER/UNCERTAIN (unchanged)
    |
   yes
    |
    v
open/extend transitionBuffer, decision=UNCERTAIN/MODE_TRANSITION_PENDING
    |
    v
next fix agrees with buffer at candidate-mode ceiling?
    |                                   |
   yes                                  no / buffer too old
    |                                   |
    v                                   v
buffer reaches 3 fixes?          discard buffer, re-classify
    |                            this fix fresh (may re-open
   yes                           a new buffer, or just ACCEPT
    |                            normally against old anchor)
    v
confirm: mode=candidateMode, accept newest fix
(reason=MODE_TRANSITION_CONFIRMED) -> normal pipeline
(processLocationFix/movement state machine, unchanged)
```

## Testing

New `describe('mode transition (Step22)', ...)` block in `react-native/__tests__/trajectoryValidator.test.js`:

- Sustained WALKING→VEHICLE acceleration (`1.3 → 4 → 8 → 14` m/s) confirms VEHICLE after 3
  buffered fixes agree; the 14 m/s fix is ACCEPTED with reason `MODE_TRANSITION_CONFIRMED`.
- Isolated spike (`1.3 → 25 → 1.4` m/s) never confirms a mode switch; mode stays WALKING; the
  1.4 m/s fix is ACCEPTED against the original anchor.
- Buffer expires after `MODE_TRANSITION_BUFFER_MAX_AGE_MS` with no confirmation → discarded,
  mode unchanged.
- Regression test for the exact circular-trap scenario this design fixes: before this change, a
  rejected fast fix could never contribute evidence toward a mode switch; after, 3 consistent
  fast fixes do switch the mode even though each was individually implausible for the old one.

Same test cases ported to `flutter/test/trajectory_validator_test.dart` (existing 1:1-port
convention for this file — see `475aa13`).

## Out of scope

- Kalman/process-noise widening during transitions — main has no Kalman filter (fixed-alpha
  blend per movement state instead); the existing generic jump-handling in
  `movementStateMachine.js` already covers this need (see Design §5).
- Porting JC branch's "progressive movement" (net-displacement/path-ratio) concept — not needed;
  buffer confirmation already only requires multi-fix agreement for genuinely borderline cases,
  never gates an unambiguous fast/accurate/consistent-bearing fix.
- Any change to `movementStateMachine.js`, `locationTask.js`, or `mapPoints.js` — verified
  unnecessary (Design §5).
