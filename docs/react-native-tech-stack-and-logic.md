# RaahMitra React Native App — Tech Stack & Logic

Reference doc for the `react-native/` app: what it's built with and how GPS data actually flows
through it, as of `algorithm_version: 2.2.0`. Written to be pasted as context into a future prompt
(human or AI) so nobody has to re-derive this from the source again.

> This is a snapshot of current behavior, not a design spec. If the code changes, this file is
> stale until someone updates it — check `react-native/processing.js`, `trackingConfig.js`,
> `routeMatching.js` and `App.js` against it before trusting it blindly.

## 1. Tech stack

Managed **Expo SDK 57** app (`react-native/`), plain JavaScript (no TypeScript), no navigation
library — a single screen in `App.js`.

| Package | Version | Used for |
|---|---|---|
| `expo` | ~57.0.14 | App runtime / build tooling |
| `react` / `react-native` | 19.2.3 / 0.86.2 | UI framework |
| `expo-location` | ~57.0.11 | GPS acquisition, foreground + background updates |
| `expo-task-manager` | ~57.0.11 | Background location delivery via a headless JS task |
| `expo-sqlite` | ~57.0.1 | On-device persistence (`gps_log.db`) |
| `expo-file-system` | ~57.0.4 | Writing export files (JSON, HTML) to device storage |
| `expo-sharing` | ~57.0.13 | Handing exported files to the OS share sheet |
| `expo-battery` | ~57.0.2 | Battery % logged alongside each GPS fix |
| `expo-intent-launcher` | ~57.0.1 | Opening Android's battery-optimization settings screen |
| `@react-native-async-storage/async-storage` | 2.2.0 | Small persisted key/values (session id, active profile, app-state) |
| `react-native-webview` | 13.16.1 | Hosts the live Leaflet map inside the app |
| `react-native-safe-area-context` | ~5.7.0 | Safe-area insets for the UI |
| Leaflet 1.9.4 (via CDN, `unpkg.com`) | — | Actual map rendering, loaded inside the WebView, not an npm dependency |
| Node's built-in `node:test` | — | Unit tests for the pure logic modules (no Jest) |

There is **no** `react-native-maps`, **no** MapView/MapKit/Google Maps SDK, and **no** map library
installed as an npm package — every map on screen (live or exported) is Leaflet running inside a
WebView or a standalone HTML file, talking to OpenStreetMap tile servers plus Esri's World Imagery
tiles for the satellite layer.

A sibling **`valhalla-adapter/`** service (plain Node, no framework, no dependencies beyond the
runtime) exists to do real map-matching — see §7.

## 2. File map

| File | Role |
|---|---|
| `App.js` | UI, permissions, start/stop, live map (WebView+Leaflet), exports |
| `locationTask.js` | `expo-task-manager` background task; turns raw provider fixes into DB rows |
| `processing.js` | The actual GPS pipeline — trajectory validation, Kalman-style filter, movement state machine |
| `trackingConfig.js` | All tunable constants: polling profiles, processing thresholds, matcher config |
| `routeMatching.js` | Groups accepted fixes into segments, talks to a map-matcher if one is configured, otherwise resolves to GPS fallback |
| `sessionStats.js` | Distance/duration/elevation summary for a finished session |
| `animatedMapExport.js` | Builds the standalone "replay this walk" HTML file |
| `db.js` | SQLite schema + queries |
| `logger.js` | Lifecycle/heartbeat/event logging |
| `signalInfo.js` | Cellular signal metadata attached to each raw fix (diagnostic only, not used by processing) |
| `index.js` | Registers the background task before the app itself |

## 3. GPS acquisition

`expo-location.startLocationUpdatesAsync()` + a background `TaskManager` task
(`LOCATION_TASK_NAME`, defined in `locationTask.js`) — not `watchPositionAsync()`. The task is
imported in `index.js` before `App` so it can receive updates even if the JS app isn't mounted.

Four named polling profiles exist in `trackingConfig.js`; only `MOVING_NORMAL` is currently
selected by the UI:

| Profile | Accuracy | Interval | Distance |
|---|---|---:|---:|
| `ACQUIRING` | BestForNavigation | 1.5 s | 0 m |
| `LIVE_SAFETY` | BestForNavigation | 2.5 s | 2 m |
| `MOVING_NORMAL` (active) | Highest | 5 s | 5 m |
| `STATIONARY` | High | 30 s | 25 m |

The requested interval is not a guaranteed delivery interval — Android/iOS can defer or batch
background fixes regardless of what's requested (visible in exports as `delivered_interval_ms`
sometimes running 2-5x longer than the requested 5s).

## 4. The processing pipeline (`processing.js`)

```text
raw GPS fix
   │
   ▼
normalizeFix()              — coerce provider payload into a flat shape
   │
   ▼
duplicate / stale / accuracy checks
   │
   ▼
trajectory_decision: ACCEPTED / UNCERTAIN / OUTLIER
   │           (speed-mismatch / bearing-inconsistency / excessive-displacement /
   │            impossible-speed gates, with a "candidate confirmation" rescue path
   │            for a fix that looks bad from the last accepted point alone but forms
   │            a coherent walking pace with the immediately preceding uncertain fix)
   ▼
accuracy-weighted local-coordinate smoothing (Kalman-style filter)
   │            — only runs for ACCEPTED fixes; resets on a true gap
   ▼
computeProgressiveMovement() over the last 4 accepted fixes
   │            — net displacement vs. path length walked, to tell directional
   │              walking apart from GPS jitter (see §5)
   ▼
updateMovement()             — movement_state state machine (see §5)
   │
   ▼
route-inclusion decision (is_route_point)
   │
   ▼
processed_locations row
```

Every accepted fix is retained; raw fixes are never deleted or overwritten. A rejected fix never
becomes the trajectory reference for later fixes — `lastAcceptedFix` only advances on `ACCEPTED`.

### Movement state machine

States: `UNKNOWN → POSSIBLY_MOVING → MOVING`, and `MOVING → POSSIBLY_STOPPED → STATIONARY`.

Key thresholds (`PROCESSING_CONFIG`): `stationarySpeedMps: 0.8`, `movingSpeedMps: 1.2`,
`movingConfirmationMs: 5000`, `stationaryConfirmationMs: 20000`,
`stationaryNoiseFloorM: 8`.

A single 5-second-interval fix at normal walking pace (5–9m) never clears the old single-fix
"moving radius" bar (12m) — that bar was calibrated for a burst covering 2+ intervals in one tick.
`computeProgressiveMovement()` fixes this: it looks at the last `progressiveMovementWindowSize` (4)
accepted fixes and computes `netDisplacement / pathDistance` (`progressRatio`). Real walking nets
displacement roughly in line with distance traveled (high ratio); GPS jitter oscillates around a
centroid (low ratio, small net). When net displacement ≥ `progressiveMovementMinNetDisplacementM`
(15m) and `progressRatio ≥ progressiveMovementMinRatio` (0.6), `hasProgressiveMovement` is true and:
- counts as moving evidence on its own (no longer needs the single-fix 12m burst), and
- suppresses stationary evidence even if this one fix's own displacement looks small.

There is no bypass that snaps straight to `STATIONARY` on the first ambiguous fix after a gap —
every path to `STATIONARY` goes through the confirmation timer, always.

### Route inclusion (`is_route_point`)

A fix is excluded from the rendered route only when it's `ACCEPTED`, **not** progressively moving,
in `STATIONARY` or `POSSIBLY_STOPPED`, and its displacement from the last accepted fix is within
the stationary noise floor — i.e. it looks like in-place GPS jitter, not a slow step.

### Gaps vs. sampling delays

`segmentGapMs` (15s) alone used to decide both "should the filter re-anchor" and "should the route
visually break into a new segment" — conflating a late-delivered fix (small displacement, fine
accuracy) with a genuine discontinuity. Now:
- `gapCandidate` (the raw time-only test) still governs Kalman filter re-anchoring and
  movement-state/window resets — unchanged, so filter drift behavior is untouched.
- `isSamplingDelay` (gap-length wait, but displacement ≤ `samplingDelayMaxDisplacementM` (20m) and
  accuracy within `normalAccuracyMaxM`) keeps the route in the *same* segment
  (`continuity_decision: 'SAMPLING_DELAY'`), instead of splitting it.
- Only a real `gap` (`gapCandidate && !isSamplingDelay`) increments `segment_id` and marks
  `continuity_decision: 'GAP'`.

## 5. Persistence (`db.js`)

SQLite (`gps_log.db`), three tables: legacy `logs` (kept for backward compatibility, not the active
write path), `raw_locations` (every OS-delivered fix, untouched), `processed_locations` (one row per
raw fix — filtered coordinates, trajectory/movement/route decisions, map-match diagnostics).
Columns are added additively via `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info`, so
schema changes don't require a destructive migration.

## 6. Map rendering

**Live screen** (`App.js`): a `WebView` loaded once with a Leaflet HTML shell
(`buildLiveMapShellHtml()`); updates after that are pushed via `injectJavaScript` calling
`window.updateLive(lat, lng, accuracy)` (smoothly animated, 700ms interpolation) and
`window.updateRoute(routesJson)` — no page reload per update. Polled every 2s from SQLite via
`refreshMap()`.

**Exported replay** (`animatedMapExport.js`): a standalone HTML file with a "Play route" button
that steps a marker through the session's accepted points at real elapsed-time pacing.

Both now include a `Street ⇄ Satellite` `L.control.layers` toggle: OpenStreetMap tiles for street
view, Esri World Imagery (`server.arcgisonline.com`, no API key) for satellite.

## 7. Map matching (`routeMatching.js` + `valhalla-adapter/`)

`MATCHER_ENDPOINT` in `trackingConfig.js` is `null` by default — no server configured, so
`matchWalkingSequence()` always resolves through the GPS-fallback path (`RAW_GPS`/`GAP` segments
only), and every route point reports `map_match_status: 'FALLBACK'`. This is by design: a matcher
being absent must never stop tracking or route display.

`valhalla-adapter/` is a self-hostable reference implementation of the matcher contract: it
translates the app's request (`{ profile, points: [{ latitude, longitude, timestamp, segmentId, ... }] }`)
into a real Valhalla `trace_attributes` call and reshapes the response back into
`{ segments: [{ segmentId, confidence, coordinates, matchedWayId }] }`. `resolveSegment()` in
`routeMatching.js` enforces client-side that a matched line is only trusted at `HIGH` confidence (or
`MEDIUM` when the underlying GPS was already continuous) — `LOW`/`UNMATCHED` always keeps validated
GPS, regardless of how clean a nearby road would make the line look. See `MAP_MATCHING.md` and
`valhalla-adapter/README.md` for setup.

## 8. Testing

`node --test tests/*.test.js` (no Jest, no React Native Testing Library — these are pure-function
unit tests against `processing.js`, `routeMatching.js`, `sessionStats.js`). Includes a real captured
field-session fixture (`tests/fixtures/newIsbtShimla-stationary-session.json`) as a regression guard
against filter drift.

## 9. Known gaps (not implemented yet)

- No GPS-reliability/"degrading near a building" state — `position_confidence` is a function of
  raw accuracy only; it doesn't see the filter's own rising disagreement (innovation) with new fixes.
- No separate "final destination" confirmation distinct from the last accepted route point.
- No driving/vehicle profile — speed thresholds throughout are walking-calibrated; see the
  car-driving analysis for specifics if that's ever wanted.
- `valhalla-adapter/` is written and unit-tested against a synthetic Valhalla response shape, but
  has not yet been run against a live Valhalla instance end-to-end.
