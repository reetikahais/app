# React Native GPS Tracking Logic Audit

This audit describes the React Native implementation currently present in the repository. No code was modified for this audit.

> Important: the current repository already contains trajectory-validation changes, including `algorithmVersion: 2.1.0`, `lastAcceptedFix`, and trajectory decisions. Historical behavior before those changes is described separately where relevant.

## A. React Native Files Involved

| File | Purpose | Important functions |
|---|---|---|
| `react-native/App.js` | UI, permissions, start/stop, exports | `start()`, `stop()`, `exportLogs()`, `exportAnimatedMap()` |
| `react-native/locationTask.js` | Expo background location task and raw-fix ingestion | `toRawRow()`, `TaskManager.defineTask()` |
| `react-native/processing.js` | Normalization, trajectory validation, movement state, smoothing | `normalizeFix()`, `updateMovement()`, `processLocations()` |
| `react-native/trackingConfig.js` | Tracking profiles and processing thresholds | `TRACKING_PROFILES`, `PROCESSING_CONFIG` |
| `react-native/db.js` | SQLite schema and persistence | `getDb()`, `insertLocationBatch()` |
| `react-native/logger.js` | Lifecycle, heartbeat, and event logging | `logEvent()`, `recordHeartbeat()` |
| `react-native/signalInfo.js` | Android signal metadata | `getSignalInfo()` |
| `react-native/animatedMapExport.js` | Standalone HTML map generation | `buildAnimatedMapHtml()` |
| `react-native/index.js` | Expo registration and task import | `registerRootComponent(App)` |
| `react-native/app.json` | Expo permissions and plugins | `expo-location`, Android permissions |
| `react-native/android/app/src/main/AndroidManifest.xml` | Native Android permissions | Location and foreground-service permissions |

There is no React Native live map screen or `MapView` component in the current source tree.

## B. Current GPS Pipeline

```text
Android/iOS location provider
    |
    v
expo-location startLocationUpdatesAsync()
    |
    v
Expo TaskManager background task
    |
    v
TaskManager.defineTask(LOCATION_TASK_NAME)
    |
    v
toRawRow(location)
    |
    v
Sort by fix_timestamp_ms
    |
    v
getAllRawLocations()
    |
    v
processLocations([...history, ...rawRows])
    |
    v
normalizeFix()
    |
    v
Duplicate, stale, accuracy, and trajectory checks
    |
    v
ACCEPTED / UNCERTAIN / OUTLIER
    |
    v
updateMovement() for accepted fixes only
    |
    v
Accuracy-weighted local-coordinate smoothing
    |
    v
processed_locations SQLite insert
    |
    v
exportLogs() or exportAnimatedMap()
```

The task is registered in `react-native/locationTask.js` with:

```js
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
```

The task is imported before the app is registered in `react-native/index.js`:

```js
import './locationTask';
import App from './App';
```

## C. Location Configuration

### Provider and library

The application uses:

- `expo-location`
- `expo-task-manager`
- Android fused location through Expo
- Android foreground service configuration

### Permission setup

`react-native/App.js` requests permissions in this order:

```js
const fg = await Location.requestForegroundPermissionsAsync();
if (fg.status !== 'granted') return;
const bg = await Location.requestBackgroundPermissionsAsync();
if (bg.status !== 'granted') return;
```

Android also requests `READ_PHONE_STATE` and opens the battery-optimization settings screen.

### Active profile

The current UI always selects:

```js
const profileName = 'MOVING_NORMAL';
```

The active profile is:

```js
MOVING_NORMAL: {
  accuracy: 'Highest',
  timeIntervalMs: 5000,
  distanceIntervalM: 5,
}
```

Defined but not selected by the current UI:

| Profile | Accuracy | Time interval | Distance interval |
|---|---:|---:|---:|
| `ACQUIRING` | `BestForNavigation` | 1500 ms | 0 m |
| `LIVE_SAFETY` | `BestForNavigation` | 2500 ms | 2 m |
| `MOVING_NORMAL` | `Highest` | 5000 ms | 5 m |
| `STATIONARY` | `High` | 30000 ms | 25 m |

The call that starts tracking is:

```js
await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
  accuracy,
  timeInterval: profile.timeIntervalMs,
  distanceInterval: profile.distanceIntervalM,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'RaahMitra GPS logger',
    notificationBody: `Logging with ${profileName} profile`,
  },
});
```

There is no `watchPositionAsync()` subscription in the project.

### Android behavior

Android permissions include:

- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
- `POST_NOTIFICATIONS`
- `READ_PHONE_STATE`

The foreground service is configured in the Expo location-start options.

### iOS behavior

The JavaScript requests background permission and uses the same Expo API. There is no separate iOS native tracking implementation in this repository.

Exact iOS delivery behavior is **NOT DETERMINABLE FROM CURRENT CODE**. OS scheduling can defer or batch background updates.

## D. Raw Location Fields

Raw fields are constructed in `react-native/locationTask.js` by `toRawRow()`.

| Field | Available from provider | Stored | Used in processing |
|---|---:|---:|---:|
| Latitude | Yes | Yes | Yes |
| Longitude | Yes | Yes | Yes |
| Measurement timestamp | Yes | `fix_timestamp_ms` | Yes |
| Accuracy | Yes | `horizontal_accuracy_m` | Yes |
| Altitude | Yes | `altitude_m` | No |
| Vertical accuracy | Yes | `vertical_accuracy_m` | No |
| Speed | Possible/null | `speed_mps` | Yes when valid |
| Speed accuracy | Yes | `speed_accuracy_mps` | No |
| Heading/bearing | Possible | `bearing_deg` | Not by movement/smoothing |
| Heading accuracy | Possible | `bearing_accuracy_deg` | No |
| Provider | Possible | `provider` | No |
| Method | Possible | `method` | Yes for fallback detection |
| Mock flag | Possible | `is_mock` | No |
| Elapsed realtime | Android dependent | `elapsed_realtime_ns` | No |
| Receipt time | App-generated | `received_timestamp_ms` | Used for age |
| App state | App-generated | `app_state` | Not route filtering |
| Battery | App-generated | `battery_pct` | Not route filtering |
| Signal metadata | Android module | Signal columns | Not route filtering |

Invalid fixes are removed before raw insertion:

```js
if (latitude == null || longitude == null || fixTimestampMs == null) return null;
```

The original raw coordinates are not overwritten by filtered coordinates.

## E. Movement State Machine

The actual states are:

- `UNKNOWN`
- `POSSIBLY_MOVING`
- `MOVING`
- `POSSIBLY_STOPPED`
- `STATIONARY`

There are no exact states named `CONFIRMING_MOVEMENT` or `CONFIRMING_STOP`.

Movement logic is in `updateMovement()`.

### Moving evidence

```js
const movingEvidence =
  (speed >= config.movingSpeedMps && displacementM > movingRadius)
  || (displacementM > Math.max(noiseRadius * 1.5, 12) && elapsedMs <= 10000);
```

Moving speed threshold:

```text
movingSpeedMps = 1.2 m/s
```

Moving confirmation:

```text
movingConfirmationMs = 5000 ms
```

A fix with moving evidence first becomes `POSSIBLY_MOVING`; after enough accumulated moving time it becomes `MOVING`.

### Stationary evidence

```js
const stationaryEvidence =
  speed <= config.stationarySpeedMps && displacementM <= noiseRadius;
```

Stationary speed threshold:

```text
stationarySpeedMps = 0.8 m/s
```

Stationary confirmation:

```text
stationaryConfirmationMs = 20000 ms
```

Stationary radius:

```js
const noiseRadius = Math.max(
  config.stationaryNoiseFloorM,
  (fix.accuracy || config.stationaryNoiseFloorM)
    * config.stationaryAccuracyMultiplier,
);
```

### Rejected fixes and movement state

The current trajectory gate runs before movement-state update:

```js
if (accepted) movementState = updateMovement(...);
```

Therefore uncertain and outlier fixes do not update movement evidence or movement state.

## F. Current Reference and Previous-Point Logic

### `previousRaw`

`previousRaw` is used only to calculate the interval between consecutively sorted raw fixes:

```js
const elapsedMs = previousRaw
  ? fix.fix_timestamp_ms - previousRaw.fix_timestamp_ms
  : null;
```

It is updated for every non-duplicate fix, including uncertain or outlier fixes.

### `lastAcceptedFix`

`lastAcceptedFix` is the trajectory reference used for:

- displacement
- implied speed
- bearing
- movement displacement
- gap detection
- smoothing reference
- accepted-reference diagnostics

It is updated only here:

```js
if (accepted) {
  ...
  lastAcceptedFix = fix;
}
```

### Current answer to outlier poisoning

For current `algorithmVersion: 2.1.0`:

```text
B -> C
B -> D
B -> E
```

is used for accepted trajectory calculations when C and D are rejected.

`previousRaw` still advances through rejected points, but it is not used as the accepted trajectory reference.

## G. Anchor Logic

There is no active runtime anchor object in the current React Native processor.

The legacy `logs` table contains:

```text
distance_from_anchor_m
```

but the active location task does not calculate or populate it.

The current equivalent is:

```text
distance_from_last_accepted_m
accepted_reference_latitude
accepted_reference_longitude
```

These are diagnostics associated with `lastAcceptedFix`, not a separate anchor state.

Anchor creation, reset, and update behavior are therefore:

```text
NOT IMPLEMENTED IN CURRENT PROCESSING CODE
```

## H. Accuracy Logic

Configured values:

```js
freshThresholdMs: 10000,
normalAccuracyMaxM: 50,
stationaryNoiseFloorM: 8,
stationaryAccuracyMultiplier: 0.75,
movingAccuracyMultiplier: 1.5,
```

Measurement variance is:

```js
function covarianceFor(accuracy) {
  const sigma = Math.max(finite(accuracy) || 100, 1);
  return sigma * sigma;
}
```

A point is normally classified as uncertain if:

```js
fix.accuracy == null || fix.accuracy > config.normalAccuracyMaxM
```

Position confidence is:

```js
status === 'FRESH_ACCEPTED'
  ? (fix.accuracy <= 20 ? 'HIGH' : 'MEDIUM')
  : 'LOW'
```

There is no active calculation of the legacy `location_quality` column.

A poor-accuracy fix normally:

- remains in raw storage
- does not update movement state
- does not update the accepted reference
- does not become a route point
- does not correct the normal smoothing state

Edge case: an uncertain first fix can initialize the filter state because the smoothing code checks `!lastAcceptedFix`. It remains marked non-route-point, but it can influence subsequent filter state.

## I. Speed Logic

Reported provider speed is normalized by `normalizeFix()`:

```js
speed_mps: finite(coords.speed ?? input.speed_mps ?? input.speed)
```

Trajectory reported speed is accepted only when:

```js
fix.speed_mps != null && fix.speed_mps >= 0
```

Therefore:

- `null` is unavailable
- `-1` is unavailable
- `NaN` is unavailable
- `0` is valid zero speed

Implied speed is:

```js
const impliedSpeed = acceptedElapsedSeconds
  ? previousDistance / acceptedElapsedSeconds
  : null;
```

Recent speed history contains implied speeds from accepted fixes only. It stores up to five values and uses the median.

```js
recentSpeedHistoryLength: 5
```

The movement function separately uses reported speed when present, otherwise distance divided by elapsed time when elapsed time is positive.

## J. Bearing Logic

Provider heading is stored as `bearing_deg`, but it is not used by the movement or smoothing code.

The trajectory layer calculates geographic bearing between `lastAcceptedFix` and the current fix:

```js
function bearingBetween(from, to) {
  const y = Math.sin(radians(to.longitude - from.longitude))
    * Math.cos(radians(to.latitude));
  const x = ...;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
```

Bearing change is compared with the prior accepted bearing.

A fix becomes uncertain for bearing inconsistency only when all of these are true:

```text
bearing change > 135 degrees
large displacement > 40 metres
implied speed > 3.75 m/s
```

Bearing is not used for smoothing or rendering.

## K. Smoothing

The processor converts geographic coordinates into local east/north metres around the first normalized fix.

Filter state:

```js
const state = {
  east: 0,
  north: 0,
  velocityEast: 0,
  velocityNorth: 0,
  variance: 10000,
};
```

For accepted non-gap fixes:

```js
state.east += state.velocityEast * dt;
state.north += state.velocityNorth * dt;

const gain = state.variance
  / (state.variance + measurementVariance);

state.east += gain * (local.east - state.east);
state.north += gain * (local.north - state.north);
```

Velocity is then updated from filtered state relative to the last accepted fix. Variance is updated with:

```js
state.variance = Math.max(
  1,
  (1 - gain) * state.variance + 4 * dt,
);
```

Output:

```js
const filtered = fromLocalMeters(state.east, state.north, origin);
```

The database output fields are:

```text
filtered_latitude
filtered_longitude
predicted_latitude
predicted_longitude
```

`predicted_latitude` and `predicted_longitude` currently contain the same filtered output.

Outlier and uncertain fixes do not perform the normal correction step. A gap resets the filter state to the current fix while marking the fix as non-route-point.

## L. Existing Outlier Protection

The current processor has these mechanisms:

| Mechanism | Trigger | Result |
|---|---|---|
| Coordinate/timestamp duplicate | Same timestamp and within 1 m | `DUPLICATE`, not route point |
| Stale fix | Age greater than 10 seconds | Low-confidence/stale status, not route point |
| Fallback method | `method` contains `fallback` | Low-confidence status, not route point |
| Missing/poor accuracy | Accuracy missing or over 50 m | `UNCERTAIN`, not route point |
| Extreme speed | Implied speed over 15 m/s | `OUTLIER`, not route point |
| Excessive dynamic displacement | Distance exceeds speed/time/accuracy allowance | `OUTLIER`, not route point |
| Reported/implied speed mismatch | Difference greater than 5 m/s | `UNCERTAIN` |
| Bearing inconsistency | Large reversal plus large displacement and speed | `UNCERTAIN` |

The current code does contain a true trajectory gate before movement processing and smoothing.

Raw fixes are preserved in `raw_locations`. The active code builds raw rows, processes them, then inserts raw and processed rows together in a database transaction.

## M. Processed Coordinate Calculation

The active task writes to `processed_locations`, not the legacy `logs` table.

The processor outputs:

```js
filtered_latitude: filtered.latitude,
filtered_longitude: filtered.longitude,
predicted_latitude: filtered.latitude,
predicted_longitude: filtered.longitude,
```

For accepted fixes:

```text
previous filter state
    |
    v
velocity prediction
    |
    v
accuracy-weighted correction toward current GPS
    |
    v
filtered coordinate
```

For outliers and uncertain fixes, the normal correction is skipped.

## N. Map Rendering

There is no in-app React Native `MapView`, `Polyline`, live marker, or route screen in the current project.

The only map renderer is the exported Leaflet HTML generated by `animatedMapExport.js`.

The export selects:

```js
processedRows.filter((row) => row.is_route_point)
```

and uses filtered coordinates when available:

```js
latitude: Number(point.filtered_latitude ?? point.latitude),
longitude: Number(point.filtered_longitude ?? point.longitude),
```

The HTML groups points by `segment_id` and creates a Leaflet polyline for each group.

There is no explicit `GAP` route type. A rejected point is omitted, but accepted points on either side may still be directly connected if they remain in the same segment.

## O. Background and Sampling Behavior

When the app changes lifecycle state, it stores `foreground` or `background` in `AsyncStorage` and logs the event.

It does not:

- stop tracking
- restart tracking
- recreate a location subscription
- change accuracy
- change the interval
- change profiles

The tracking task is configured as an Android foreground service. This is intended to support background and lock-screen tracking, but actual delivery remains subject to Android, device-vendor, and OS policy.

The requested interval is 5 seconds, not a guarantee of 5-second delivery.

The requested distance interval is 5 metres and can also affect delivery.

The `setInterval()` in `App.js` runs every 5 seconds only to refresh the stored-row count. It does not collect GPS fixes.

Batched locations are all processed and sorted by measurement timestamp:

```js
data.locations
  .map(...)
  .filter(Boolean)
  .sort((a, b) =>
    a.fix_timestamp_ms - b.fix_timestamp_ms
    || a.batch_index - b.batch_index
  );
```

Specific historical delivery gaps require the exported raw timestamps and event log to identify whether the delay came from the provider, OS, task scheduling, or battery policy.

## P. Real Failure Explanation

For current `algorithmVersion: 2.1.0`, a 1.7 km jump should normally be rejected.

The processor calculates:

```js
impliedSpeed = distanceFromLastAccepted / elapsedTime;
```

A 1.7 km jump implies approximately:

| Elapsed time | Implied speed |
|---:|---:|
| 5 seconds | 340 m/s |
| 10 seconds | 170 m/s |
| 30 seconds | 56.7 m/s |

The current absolute ceiling is:

```js
extremePhysicalSpeedMps: 15
```

The expected current result is:

```text
trajectory_decision = OUTLIER
trajectory_reason = IMPOSSIBLE_SPEED
is_route_point = 0
```

It should not update:

- `lastAcceptedFix`
- movement evidence
- accepted speed history
- accepted bearing history
- normal smoothing correction
- exported route vertices

If production data contains such a jump in the route, compare its `algorithm_version`. The pre-validation `2.0.0` implementation did not have the current trajectory gate and could allow a fresh, reasonably accurate jump to enter movement and smoothing.

Whether the production record was generated by the old implementation cannot be proven from the current source alone.

## Q. Recommended Validation Insertion Point

The current source already contains the intended insertion point.

Recommended location:

```text
File: react-native/processing.js
Function: processLocations()
```

Run validation after:

- `normalizeFix()`
- timestamp ordering
- duplicate detection
- accuracy/staleness metrics
- distance and speed metrics

Run it before:

```js
updateMovement()
```

and before the smoothing block:

```js
if (lastAcceptedFix && accepted && !gap) {
```

This preserves the existing movement state machine and smoothing while preventing rejected fixes from mutating accepted trajectory state.

## R. Existing Helpers to Reuse

Do not duplicate:

- `normalizeFix()` for normalization
- `haversineMeters()` for distance
- `toLocalMeters()` and `fromLocalMeters()` for local coordinates
- `percentile()` for median calculation
- `covarianceFor()` for accuracy variance
- `lastAcceptedFix` for trajectory reference
- `acceptedSpeeds` for accepted speed history
- `bearingBetween()` for calculated bearing
- `angleDifference()` for circular bearing comparison
- `updateMovement()` for movement-state transitions
- `fix_timestamp_ms` for measurement-time ordering
- `received_timestamp_ms` for age calculation
- `segment_id` for current route grouping

## S. Risks Before Modification

1. There is no live map screen in the current React Native source.
2. The current repository cannot verify a supposed green in-app polyline because no such component exists.
3. Raw rows are prepared before processing but inserted only after processing completes.
4. `previousRaw` advances through rejected fixes, although accepted trajectory calculations use `lastAcceptedFix`.
5. The first uncertain fix can initialize the smoothing state.
6. Gap handling resets smoothing state to the current fix while marking that row as non-route.
7. `insertLocationBatch()` assumes processed rows align positionally with raw rows.
8. The legacy `logs` table is not the active processing destination.
9. `location_quality` and `distance_from_anchor_m` exist in the legacy schema but are not calculated by the active task.
10. Provider heading is stored but is not used for movement or smoothing.
11. No sequence-based map matching exists.
12. No matched/raw hybrid route model exists.
13. The HTML export depends on remote Leaflet and OpenStreetMap resources.
14. The export groups by segment but does not explicitly model `GAP` segments.
15. Requested GPS intervals are not guaranteed delivery intervals.
16. Flutter and React Native currently use different processing architectures.
17. Historical production behavior requires the exported algorithm version and processing metadata for confirmation.

## Direct Answers

### How does one current React Native GPS fix reach the route export?

```text
Location provider
    |
    v
Expo location task
    |
    v
toRawRow()
    |
    v
Timestamp sorting
    |
    v
processLocations()
    |
    v
normalizeFix()
    |
    v
Trajectory classification
    |
    v
Movement update for accepted fixes
    |
    v
Accuracy-weighted smoothing
    |
    v
processed_locations
    |
    v
Animated HTML export
```

### Can a rejected fix become the accepted reference?

Normally no. `lastAcceptedFix` is updated only for accepted fixes.

The separate `previousRaw` variable does advance through rejected fixes and is used for raw consecutive interval calculation.

### Why could a bad point historically create a large route line?

The older pre-validation processing path had no true trajectory plausibility gate. A fresh point with accuracy at or below the normal accuracy threshold could influence movement and smoothing based on displacement and reported speed. The current `2.1.0` source now rejects the normal 1.7 km jump case through the speed and dynamic displacement checks.

### Where should future trajectory validation live?

Inside:

```text
react-native/processing.js
processLocations()
```

after normalization and trajectory metrics, but before `updateMovement()` and before smoothing state mutation.
