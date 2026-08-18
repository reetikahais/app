# Continuous location cache: movement/noise filtering, smoothing, adaptive polling

Date: 2026-08-17
Apps: `react-native/` and `flutter/` (RaahMitra GPS Logger, both platforms)

## Problem

Both apps log every raw GPS/fused fix on a fixed interval with no notion of whether the device
actually moved. A stationary device naturally scatters 10-40+ meters between fixes due to GPS/fused
noise (background fixes especially, given 30-50m typical accuracy) — plotted on a map this looks like
constant fake movement. Separately, RN hard-rejects any fix with `accuracy > 50m`
([locationTask.js:29-33](../../../react-native/locationTask.js#L29-L33)), silently losing legitimate
rough-position data during marginal signal; Flutter already retains these (tagged via
`classifyFixMethod`, see [2026-08-17-flutter-signal-gap-detection-design.md](2026-08-17-flutter-signal-gap-detection-design.md)).

Neither app has a Google Maps screen today — "stable trail" is judged by re-plotting exported JSON
externally. This design is data-quality-only: it does not add a map UI.

## Scope / decomposition

Split into ordered sub-projects. All of the below are implemented as of this writing except where
noted.

1. **Section 1 (implemented):** movement/noise state machine — distinguishes real movement from GPS
   noise. Pure, platform-agnostic logic, ported 1:1 to both apps.
2. **Section 2 (implemented):** stationary smoothing — accuracy-weighted incremental anchor update,
   wired into `processed_latitude`/`processed_longitude`/`movement_state`/`distance_from_anchor_m`
   columns on the existing `logs` row alongside the untouched raw fix.
3. **Adaptive polling frequency (implemented):** polling cadence tied to movement state. See below.
4. **Small mechanical fixes (implemented):** 300ms lifecycle debounce (req 7) both apps; RN
   accuracy-rejection removal (req 8); Flutter carrier parity via SIM-operator lookup (req 9).
5. **Dropped from scope:** device GPS → API → DB → Maps pipeline verification (req 11) — no such
   pipeline exists in this repo; no map UI was added either (data-quality-only, per the "Problem"
   section above).
6. **Round 2 (implemented):** location-quality score, graduated moving-smoothing, movement-tied
   accuracy mode, revised MOVING polling interval, accuracy edge-case hardening — see "Round 2"
   below. Activity recognition explicitly deferred to a separate future project (not implemented);
   a "LIVE" high-frequency mode and dateline-safe averaging were considered and intentionally not
   built (see "Round 2 — considered and not done").

## Section 1: movement state machine

States: `STATIONARY → CONFIRMING_MOVEMENT → MOVING`, with reverse hysteresis
`MOVING → CONFIRMING_STOP → STATIONARY`, so brief pauses/GPS blips don't flap the state.

### Noise threshold

```
threshold = max(anchorAccuracy, fixAccuracy) + MIN_NOISE_FLOOR_M   // MIN_NOISE_FLOOR_M = 15m
```

`distance <= threshold` → noise, folded into the anchor, state stays/returns `STATIONARY`.
`distance > threshold` → candidate movement, enters `CONFIRMING_MOVEMENT`.

No fixed 20m/50m accuracy cutoff is used to gate movement detection.

### Confirming movement

A candidate is promoted to `MOVING` when either:

- **Speed confirmation:** `fix.speed >= 1.2 m/s` and `fix.accuracy <= 100m` — device-reported speed
  (Doppler-derived) trusted directly, single fix is enough.
- **Consecutive-fix confirmation:** `CONFIRMATION_COUNT = 2` consecutive candidates, each already
  exceeding the noise threshold from the *original* anchor (by construction — a fix only enters the
  candidate streak after failing the noise check), with the newest segment's bearing agreeing with the
  previous segment's bearing within `BEARING_TOLERANCE_DEG = 45°` — **but only when that newest segment
  is ≥ `MIN_BEARING_DISTANCE_M = 25m`** (bearing is unreliable over shorter GPS-noise-scale distances,
  so the check is skipped, not failed, below 25m). Bearing comparison wraps correctly across 0°/360°.

If a candidate fix falls back within the *original* anchor's noise threshold, the streak resets
completely and the fix is folded into the anchor as noise (GPS jump-and-return, not movement) — this
takes priority over the speed/streak checks.

An inconsistent-bearing candidate does not reset all the way to `STATIONARY`; it restarts the
confirmation window from that fix (an unboundedly growing streak would never converge either way).

### Confirming stop

Symmetric hysteresis: once `MOVING`, a single stationary-looking fix (within noise threshold of the
last moving fix) moves to `CONFIRMING_STOP`, not straight to `STATIONARY`. A second consecutive fix
clustering within threshold of the first (`STATIONARY_CONFIRMATION_COUNT = 2`) confirms `STATIONARY`
and seeds a fresh anchor from the two clustered fixes. Any fix that doesn't cluster reverts back to
`MOVING` and discards the stop-candidate buffer.

### Foreground/background

Not used as a movement signal. It only affects cadence and expected-accuracy assumptions (deferred to
the not-yet-designed polling section) — background's naturally worse accuracy already produces a wider
noise threshold by construction, so degraded background fixes are not misclassified as movement without
any special-casing.

### Raw vs processed

Pure logic only in this section — no storage wiring yet. `LocationFix`/`Anchor` inputs and outputs are
in-memory values; Section 2 will wire the anchor's position into new nullable columns on the existing
`logs` row (raw columns untouched).

### Raw vs processed

`LocationFix`/`Anchor` are in-memory pure values; Section 2 (below) wires the anchor's position into
new nullable columns on the existing `logs` row. Raw `latitude`/`longitude`/`accuracy` columns are
never overwritten or skipped — every fix is still inserted exactly as received (this is also where
req 2/8's rejection-relaxation lives, see "Small mechanical fixes" below).

## Section 2: stationary smoothing, wired into storage

`getProcessedLocation(state, fix)` returns the anchor's position while `STATIONARY`/`CONFIRMING_MOVEMENT`
(an anchor exists — show the smoothed point, not raw jitter), or the fix's own raw position while
`MOVING`/`CONFIRMING_STOP` (no anchor — movement is confirmed, follow the raw fix directly).
`getDistanceFromAnchorM(state, fix)` returns 0 when there's no anchor, otherwise the fix's distance
from it.

Both apps' `logs` table gained four nullable columns (RN: `db.js` `addColumn` migration; Flutter:
`db.dart` schema bumped to `version: 4` with an `onUpgrade` step):

- `movement_state` — the state machine's state at the time of this fix.
- `processed_latitude` / `processed_longitude` — `getProcessedLocation`'s output.
- `distance_from_anchor_m` — `getDistanceFromAnchorM`'s output.

Both `locationTask.js` and `location_task.dart` load the persisted `MovementState` (AsyncStorage /
SharedPreferences, JSON-serialized — Dart needs explicit `movementStateToJson`/`FromJson` since it's
a typed class, not a plain object like JS), run `processLocationFix` per fix, save the updated state
back, and write the four columns above alongside the untouched raw fix.

## Adaptive polling frequency (req 10)

**Rules** (defined here before the implementation that follows, per req 10):

| Movement state | Foreground | Background |
|---|---|---|
| `MOVING` / `CONFIRMING_MOVEMENT` / `CONFIRMING_STOP` | 15s | 30s |
| `STATIONARY`, settled < 5 min | 60s | 90s |
| `STATIONARY`, settled ≥ 5 min | 180s | 300s |

Not a movement signal (Section 1, rule on foreground/background) — purely a cadence choice, computed
by the pure function `computePollingIntervalMs(state, nowMs, appState)` in both
`movementStateMachine.js`/`.dart`. "Settled duration" comes from a new `stationarySinceMs` field on
`MovementState`, set when a fresh `STATIONARY` period begins (bootstrap, a `CONFIRMING_STOP` success,
or a `CONFIRMING_MOVEMENT` fallback-reset — the latter two preserve/derive it rather than resetting to
"now", so a GPS-noise excursion doesn't reset the long-stationary battery-saving clock) and cleared
whenever the state leaves `STATIONARY`.

**Flutter wiring:** safe to do directly — `Timer.periodic` runs inside the same long-lived
`flutter_background_service` isolate as the tick logic itself. `_logOnce` now returns the desired next
interval (seconds); `onServiceStart`'s tick callback cancels and reschedules the timer when that value
changes from the currently-running one.

**RN wiring:** less direct. Expo's location API has no way to retune an already-running watch's
`timeInterval` — the only path is stop-then-restart with new options, and Expo's docs don't cover
whether doing that from inside the watch's own `TaskManager.defineTask` callback is safe (confirmed via
the SDK 57 docs — undocumented territory). Rather than rely on that, `locationTask.js` only *persists*
the desired interval (`DESIRED_INTERVAL_KEY` in AsyncStorage) each time it processes a fix.
`locationWatch.js` (new file, holds `LOCATION_TASK_NAME`/`startWatch`/`stopWatch`/
`restartWatchWithInterval`, replacing the inline `Location.startLocationUpdatesAsync` call that used to
live in `App.js`) exposes the actual restart. `App.js`'s existing 5-second foreground poll (previously
only refreshing the on-screen log count) now also compares the persisted desired interval against the
currently-applied one and calls `restartWatchWithInterval` when they differ — this is the
documented-safe context (foreground JS, not the task callback).

**Accepted platform constraint:** because the RN restart only happens from foreground JS, a tier change
computed while the app is backgrounded (e.g. settling into the long-stationary tier overnight) won't
actually take effect until the app is next foregrounded. This mirrors the same "JS timers don't survive
backgrounding" constraint already documented for this app's other background-reliant logic (see
[2026-08-17-signal-gap-detection-design.md](2026-08-17-signal-gap-detection-design.md)'s "Platform
constraint" section) rather than being a new gap introduced here.

## Small mechanical fixes

- **300ms lifecycle debounce (req 7):** `react-native/debounce.js` (trailing-edge debounce,
  `debounce(fn, waitMs)`) wraps the `AppState` listener in `App.js`. `flutter/lib/debouncer.dart`
  (`Debouncer` class, cancel-and-reschedule `Timer`) wraps `didChangeAppLifecycleState` in `main.dart`.
  Motivated directly by the user's own exported `events.log`, which showed multiple
  `app_foreground`/`app_background` flips within the same second during app startup.
- **RN accuracy-rejection removal (req 2/8):** `locationTask.js`'s `accuracy > 50` hard `continue`
  (previously discarding the fix entirely) is removed. New `locationFixClassifier.js` exports
  `classifyFixMethod(accuracy)` (`'fused'` ≤ 50m, else `'low_accuracy_fallback'` — mirrors Flutter's
  existing `classifyFixMethod` in `location_task.dart`), and every fix is now inserted regardless of
  accuracy, tagged by this classification.
- **Flutter carrier parity (req 9):** `SignalInfoPlugin.kt`'s `carrier` field switched from
  `tm.networkOperatorName` (live network) to `tm.simOperatorName.takeIf { it.isNotEmpty() } ?:
  tm.networkOperatorName` (SIM operator, falling back to network operator) — the same fix already
  applied to RN's `SignalInfoModule.kt` in commit `e8d5a00`.

## Implementation

- `react-native/movementStateMachine.js` — pure ES module, no RN/Expo dependencies.
- `flutter/lib/movement_state_machine.dart` — 1:1 port, no Flutter/platform dependencies.
- Both export: `haversineDistanceMeters`, `initialBearingDegrees`, `circularBearingDiffDeg`,
  `computeNoiseThresholdM`, `passesBearingCheck`, `foldFixIntoAnchor`, `createInitialMovementState`,
  `processLocationFix`, `getProcessedLocation`, `getDistanceFromAnchorM`, `computePollingIntervalMs`.
- `test-fixtures/movement_state_machine_parity.json` — end-to-end fix sequences with expected final
  states, consumed by both apps' test suites to guard cross-platform parity (req 12) and prevent the
  two implementations drifting apart under future edits.

## Testing

- `react-native/__tests__/movementStateMachine.test.js` — helper unit tests + all 12 scenarios from the
  spec, plus `getProcessedLocation`/`getDistanceFromAnchorM`/`computePollingIntervalMs` coverage. 31
  tests, passing.
- `react-native/__tests__/movementStateMachineParity.test.js` — shared fixture file, 6 cases, passing.
- `react-native/__tests__/locationFixClassifier.test.js` — 3 tests, passing.
- `react-native/__tests__/debounce.test.js` — 3 tests, passing.
- `flutter/test/movement_state_machine_test.dart`, `movement_state_machine_parity_test.dart`, and
  `debouncer_test.dart` — same cases ported to Dart, plus a JSON round-trip test for
  `movementStateToJson`/`FromJson`. **Not executed in this environment (no Flutter SDK on PATH)** — run
  `flutter test` locally to confirm before merging.
- Not covered by automated tests: the actual native interval-restart behavior on RN (`locationWatch.js`)
  and Flutter's `Timer` rescheduling in `onServiceStart` — both are thin glue around already-tested pure
  functions, verified by reading rather than running; recommend a manual on-device check (start
  tracking, walk to trigger `MOVING`, stop and wait 5+ minutes to observe the interval widen).

## Round 2: quality score, graduated smoothing, movement-tied accuracy, revised intervals, hardening

Follow-up pass inspired by (not copying — the exact algorithm is proprietary) publicly-documented
Life360-style behavior: sensor fusion, high-precision tracking while moving, reduced cadence while
stationary, location quality represented separately from the raw coordinate.

### Location quality score (Change 2)

`getLocationQuality(state, fix)` — a 0-100 confidence score, **not** a re-statement of accuracy in
meters and **not** a claim that processing made the underlying GPS measurement more physically
precise (a 40m-accuracy fix folded into a rock-stable anchor is still only worth as much trust as a
40m fix). `score = clamp(100 - sanitizedAccuracy, 0, 100)`, with a `-10` penalty while the state is
`CONFIRMING_MOVEMENT`/`CONFIRMING_STOP` — deliberately not re-deriving distance/speed/bearing
consistency here, since the movement state machine's own confirmation logic (Section 1) already *is*
that consistency check; quality just reads its verdict. New nullable `location_quality` (INTEGER)
column on `logs`, both apps.

### Graduated moving-smoothing (Change 3)

Previously `MOVING`/`CONFIRMING_STOP` displayed the raw fix outright (no smoothing) while
`STATIONARY`/`CONFIRMING_MOVEMENT` displayed the anchor (effectively infinite smoothing). Now every
state produces a `processedLat`/`processedLon` on `MovementState` itself via `blendPoint(prev, next,
alpha)` — a simple linear EMA towards the new fix:

| State | Alpha | Effect |
|---|---|---|
| `STATIONARY` | n/a | unchanged: the accuracy-weighted anchor (already "strong" smoothing) |
| `CONFIRMING_MOVEMENT` | 0.5 | moderate — starts responding before movement is confirmed, without fully committing |
| `MOVING` | 0.8 | light — mostly follows raw GPS, damps a single sideways jump (steady-state lag ≈ step × 0.25 on a straight line, e.g. ~12.5m of lag on 50m steps — stays responsive) |
| `CONFIRMING_STOP` | 0.5 | moderate — symmetric with `CONFIRMING_MOVEMENT` |

This is a deliberate, approved change to `getProcessedLocation`'s previous exact-raw-while-`MOVING`
contract (the old unit test asserting that is now a "lightly smooths, does not exactly equal raw"
test) — the classification logic (which state a fix lands in) is untouched; only the displayed point
changed. `getProcessedLocation` signature dropped its second (`fix`) parameter since the processed
point is now computed once, during the state transition, and stored on `MovementState` directly.

### Movement-tied accuracy mode (Change 4)

`wantsHighAccuracy(state)` — `true` for `MOVING`/`CONFIRMING_MOVEMENT`/`CONFIRMING_STOP`, `false` for
`STATIONARY`. The OS/hardware still decides what it can actually deliver; this only requests a tier.

- **Flutter:** `location_task.dart` loads the *previous* tick's `MovementState` before requesting a
  position (there's no fix yet to base this tick's own classification on), picks
  `LocationAccuracy.high` or `.medium` (Geolocator's "~100m, balanced power" tier) accordingly, and
  requests the position with that accuracy - no new architecture needed, it's a per-tick parameter.
- **RN:** reuses the adaptive-polling-interval architecture verbatim. `locationTask.js` persists a
  `DESIRED_HIGH_ACCURACY_KEY` alongside the desired interval; `locationWatch.js`'s `startWatch`/
  `restartWatchWithOptions` take a `{ highAccuracy }` option (`Location.Accuracy.High` vs `.Balanced`);
  `App.js`'s existing foreground poll now checks and applies both interval and accuracy changes in one
  restart. Same accepted platform constraint as the interval: only takes effect in the foreground.

### Revised MOVING polling interval (Change 5)

`MOVING_INTERVAL_FOREGROUND_MS`/`_BACKGROUND_MS` changed from 15s/30s to **10s/20s** (user's explicit
choice, over a more aggressive 5s/10s) — meaningfully more responsive while moving without tripling
foreground battery cost. `STATIONARY` tiers (60s/90s short, 180s/300s long) are unchanged.

### Accuracy edge-case hardening (Change 7)

`sanitizeAccuracy(accuracy)` — `weight = 1/accuracy²` (in `foldFixIntoAnchor`) must never see
`0`/`null`/`NaN`/`Infinity`/negative: any of those either throws, divides by zero, or silently
poisons the anchor average. Invalid/unknown accuracy maps to a large fallback (1000m — *very
uncertain*, near-zero weight), **never** to a small value (which would invent fake precision from
missing data). Implausibly tiny accuracy (e.g. `0.0001`) is floored to 1m rather than trusted as
super-precise. Applied once at `processLocationFix`'s entry (so every downstream threshold/weight
calculation sees a valid value — an unsanitized `NaN` would otherwise poison `Math.max()` in
`computeNoiseThresholdM` and could make a bad fix look like a movement candidate regardless of actual
distance) and again defensively inside `foldFixIntoAnchor` itself.

RN's JS `accuracy` field can be `null`; Dart's `LocationFix.accuracy` is a non-nullable `double`, so
the equivalent "invalid/unknown" sentinel there is `double.nan` — documented in both parity test
files' fixture-to-fix converters, since the shared JSON fixture encodes it as JSON `null` either way.

### Round 2 — considered and not done

- **Activity recognition (Change 1) — deferred, not this pass.** Neither app has any
  activity/motion-recognition dependency or native capability today (checked: no `expo-sensors`, no
  Flutter activity package). Doing this properly means new native surface on both platforms (Android
  `ActivityRecognitionClient`, iOS `CMMotionActivityManager`), new runtime permissions, and — following
  this repo's own precedent (the `signal_info` plugin) — likely a custom plugin rather than a
  third-party dependency. Sized on its own, this is bigger than every other Round 2 change combined.
  **Explicitly kept as a live idea for Phase 2, not discarded**: an independent `ActivityState`
  (`UNKNOWN`/`STILL`/`WALKING`/`RUNNING`/`CYCLING`/`IN_VEHICLE`) signal, additive to — never replacing —
  `MovementState`, would let the system distinguish "GPS says movement + phone says STILL → probably
  noise" from "GPS says movement + phone says WALKING → probably real" without ever letting activity
  alone drive a transition (GPS/geospatial evidence must still be present either way).
- **"LIVE" high-frequency mode (Change 6) — skipped.** Pure speculative architecture with no consumer
  (no UI or server live-view exists in this repo, and none was requested). Add a `NORMAL`/`LIVE` polling
  mode when an actual LIVE feature is being built, not before.
- **Dateline/longitude averaging (Change 8) — documented, not coded.** `foldFixIntoAnchor` and
  `blendPoint` both average latitude/longitude directly, which breaks near ±180° (e.g. `179.9°` and
  `-179.9°` averaging to `0°` instead of a point close to both). This app's actual data is Himachal
  Pradesh (~31.44°N, 77.05°E) — nowhere near the antimeridian. Not fixed, per the "if not relevant to
  the application's geography, document rather than add complexity" guidance; revisit if this app is
  ever used near ±180° longitude.

## Testing (Round 2 additions)

- `react-native/__tests__/movementStateMachine.test.js` grew four new `describe` blocks
  (`sanitizeAccuracy`, `blendPoint`, `getLocationQuality`, `wantsHighAccuracy`) plus a sideways-jump
  damping test and a steady-state-lag test; two pre-existing tests were updated to match the new
  smoothing contract. **62 RN tests total, all passing.**
- `test-fixtures/movement_state_machine_parity.json` gained `expectedQuality` (exact integer,
  deterministic) and `expectedProcessedWithinMOfLastFix` (distance bound) fields on select cases, plus
  two new cases (`moving_smoothing_stays_close_to_raw_trail`, `invalid_accuracy_fix_treated_as_uncertain_noise`).
  Both RN's and Flutter's parity test runners were updated to check these fields when present.
- `flutter/test/movement_state_machine_test.dart` and `movement_state_machine_parity_test.dart` were
  updated with the equivalent Dart tests. **Not executed in this environment (no Flutter SDK on
  PATH)** — run `flutter test` locally before merging.

## Round 3 — concurrency, processing_version, internal reuse

A follow-up spec proposed replacing several Round 2 formulas (accuracy sanitization, smoothing
alphas, `location_quality`) with different constants and a more elaborate weighted model, and
separately said not to touch the MOVING polling interval. Resolved against Round 2 (the user's
explicit decision): **Round 2's formulas and the 10s/20s MOVING interval stand unchanged.** Only
the following, non-conflicting items from Round 3 were implemented:

- **RN re-entrancy guard (item 8).** `expo-task-manager` can invoke `locationTask.js`'s
  `defineTask` callback again before a previous invocation's `movementState` load → mutate → save
  cycle finishes (e.g. two location batches delivered in quick succession). Without a guard, both
  invocations load the same stale state and whichever saves last silently discards the other's
  contribution to the anchor — a lost-update race, reproduced first as a failing test
  (`locationTask.concurrency.test.js`, asserting the anchor's `totalWeight` reflects *both* fixes'
  folded weight, not just one). Fixed with a module-level promise chain (`taskChain`) that
  serializes invocations — the next one's load only starts after the previous one's save
  completes. No fix is dropped, just never processed concurrently with another. Flutter's
  `location_task.dart` already had an equivalent `ticking` guard in its `Timer.periodic` callback;
  no change needed there.
- **`processing_version` (item 6) — both apps.** `PROCESSING_VERSION = 2` (`processingVersion` in
  Dart) exported from the movement-state-machine module as the single source of truth, tagged onto
  every inserted row by both `locationTask.js` and `location_task.dart`. `processing_version`
  column added via the existing idempotent migration pattern in both `db.js` (`addColumn`) and
  `db.dart` (schema bumped `5→6`). Lets rows produced by future formula changes be told apart from
  today's without guessing from timestamps.
- **`FixMetrics`/`computeFixMetrics` (item 5) — both apps.** Internal-only helper bundling the
  distance+threshold pair each of the four transition functions
  (`processStationary`/`processConfirmingMovement`/`processMoving`/`processConfirmingStop`) already
  computed against a reference point (anchor or last-moving-fix) — pure code reuse, not a new
  decision rule. Ported 1:1 to `movement_state_machine.dart` as a `FixMetrics` class +
  `computeFixMetrics`, same refactor applied to the four Dart transition functions. Verified
  behavior-neutral on the RN side by keeping the full existing test suite green (67 RN tests)
  through the refactor; Dart side mirrors the same call sites but is unexecuted here (see Testing).
- **Movement-state vs. tracking-profile boundary (item 7, doc-only).** `MovementState` describes
  *what the device is currently doing* (stationary/moving/confirming). It does not and should not
  encode *why* location is being tracked (e.g. Signal Map session vs. SOS vs. proximity/fraud
  check) — that's a separate, not-yet-built concept ("tracking profile"). `computePollingIntervalMs`
  and `wantsHighAccuracy` already only take movement state (+ app foreground/background) as input,
  not a tracking purpose, so no code changed here — this is a boundary to preserve in future work,
  not a gap to fix now.

**Explicitly not done, per the user's resolution:** the 70/20/10 `location_quality` reweighting,
the accuracy re-clamp to `[3, 250]`, accuracy-adaptive smoothing alphas, and any change to the
MOVING polling interval — all superseded by Round 2's already-shipped, already-approved versions.

### Testing (Round 3 additions)

- `react-native/__tests__/movementStateMachine.test.js`: `PROCESSING_VERSION` value,
  `computeFixMetrics` equivalence to the pre-refactor separate calls (including invalid-accuracy
  sanitization). **67 RN tests total, all passing.**
- `react-native/__tests__/locationTask.concurrency.test.js` (new): reproduces the lost-update race
  (failing before the guard, passing after) and asserts every inserted row carries
  `PROCESSING_VERSION`.
- `flutter/test/movement_state_machine_test.dart`: mirrored `processingVersion`/`computeFixMetrics`
  tests. **Not executed in this environment (no Flutter SDK on PATH)** — run `flutter test` locally.

## Round 4 — background watch retune for locked-phone travel tracking

**Problem:** the only place that ever called `restartWatchWithOptions(...)` was `App.js`'s
foreground 5-second poll. If the phone locked right after settling into a slow tier (e.g. 90s
background-stationary) and the user then started moving, that JS timer stops running (foreground
JS is not guaranteed to keep ticking once backgrounded/locked) — the watch stays at 90s until the
app is next foregrounded, even though `locationTask.js` was already correctly reclassifying each
slow-arriving fix as `MOVING` the whole time. Movement *detection* never depended on the foreground
timer (the background task runs `processLocationFix` on every OS-delivered batch regardless of app
state) — only *retuning the watch's cadence* did.

**Checked (again) whether restarting the watch from inside its own background task callback is
documented-safe:** fetched the exact v57 Location docs twice. Confirmed: still genuinely silent,
not confirmed safe *or* unsafe (unlike `startGeofencingAsync`, which the docs explicitly say can be
called again to update an active task — no equivalent statement exists for
`startLocationUpdatesAsync`). `distanceInterval`/`deferredUpdatesDistance` were also checked as a
possible declarative alternative (configure the watch once with both a time and distance trigger,
never needing a runtime restart) — ruled out because Android's underlying `smallestDisplacement`
semantics *suppress* redundant same-spot updates, they don't shorten the interval below what's
configured; there's no documented way to get "fast when moving, slow when still" without changing
`timeInterval` at runtime.

**First attempt (reverted — confirmed unsafe on real hardware).** `locationTask.js` briefly
attempted `restartWatchWithOptions(...)` itself, from inside the background task, wrapped in
try/catch, on the theory that a failure would just be a rejected promise leaving `DESIRED_*` as a
foreground fallback. **Tested on a real device (OnePlus 6) and confirmed this does not fail
cleanly**: calling `stopLocationUpdatesAsync`/`startLocationUpdatesAsync` from inside the task's
own callback unregisters the task entirely. TaskManager logged `Registered task...` followed
within the same second by `Unregistering task...`, and every subsequent restart attempt (including
`App.js`'s unrelated foreground poll) then threw
`TaskNotFoundException: Task 'raahmitra-background-location-task' not found` in a tight 5-second
loop — tracking stopped entirely until the app was force-stopped and restarted. This is a real,
now-confirmed answer to the ambiguity the docs left open: **restarting the watch from inside its
own background task callback is unsafe**, not just undocumented. Reverted; `locationTask.js` goes
back to only computing and persisting `DESIRED_*` for `App.js`'s foreground poll to apply, exactly
as before this attempt. `APPLIED_INTERVAL_KEY`/`APPLIED_HIGH_ACCURACY_KEY` were kept as a small,
low-risk improvement on their own — `App.js`'s foreground poll now reconciles against these
AsyncStorage keys instead of local component refs, with no functional change (still the same
foreground-only restart it always was).

**Flutter needed no change either way.** Its `Timer.periodic` already lives inside the same
long-lived `flutter_background_service` isolate as the tick logic itself (`onServiceStart`'s
`scheduleTick`), so it already reschedules itself with the newly-computed interval on every tick,
regardless of foreground/background/locked state — this was never gated on a foreground-only timer
the way RN's was, and never carried this risk.

**Actual fix: reconcile on the guaranteed lifecycle event, not just a passive timer.** Restarting
the watch still only ever happens from foreground JS (confirmed the only safe option above) — but
`App.js` previously only attempted this from its 5-second `setInterval`, which has no guarantee of
still being scheduled while the phone is locked. `App.js`'s `AppState` `'change'` listener, however,
is an OS-delivered lifecycle callback, not a passive timer — it reliably fires the moment the user
unlocks/reopens the app. The reconciliation logic (`DESIRED_*` vs `APPLIED_*`, restart-if-different)
was extracted into one `reconcilePollingConfig()` function, now called from *both* triggers: the
existing 5-second poll (covers the app already being open) and, new, the `AppState` listener's
`'active'` transition (covers the far more important locked-phone case — reconciliation now fires
immediately on unlock, not whenever the next poll tick happens to land). This doesn't make the
watch retune *while still locked* (still confirmed unsafe from background) — it bounds the stale
window to "how long the phone stays locked before it's next glanced at" instead of "until the app
is fully reopened," which is the best achievable fix given the confirmed background-restart
constraint.

**Not yet empirically re-verified on-device** with an actual lock→walk→unlock cycle (that's the
real test of whether this closes the gap in practice) — logcat/`events.log`'s
`polling_settings_changed` event will show up immediately on unlock if this works as intended.

### Testing (Round 4 additions)

- Net change after the revert + fix: no new automated tests (App.js has no test harness in this
  repo, same as its earlier ordering fix — this remains a manually/on-device-verified area).
  **67 RN tests total, all passing** — unchanged from before this round, since nothing here touched
  the pure, already-tested `movementStateMachine.js`/`locationTask.js` logic.

## Out of scope (this doc)

- Any map UI or API/DB pipeline — neither exists in this repo today, and req 11 (pipeline
  verification) was explicitly dropped from scope for that reason.
- Activity recognition, LIVE mode, and dateline-safe averaging — see "Round 2 — considered and not
  done" above.
