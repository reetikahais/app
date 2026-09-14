# Bike tracking: tuning checklist for real field logs

The bike profile in `react-native/trackingConfig.js` (`MODE_PROFILES.bike`) ships with starting
values only — informed by the spec, not by real RaahMitra rides. No field logs existed at the time
these were written, so treat every number below as a hypothesis to check once real logs exist, not
a conclusion. This doc is the checklist for that pass; it does not contain tuning results.

## How to capture a log worth tuning from

1. Start a session in **Cycling** mode, ride a route that includes at least: a stretch of straight
   road, a sharp (>60°) turn, a stop of 30-60s (traffic light/junction), and — if available — a
   hairpin or two parallel roads close together.
2. Stop tracking, then **Export logs** (produces `raahmitra_export.json`, schema v2.1+, includes
   `tracking_mode: "bike"` at the top level and per-fix `turn_detected`/`acceleration_mps2`/
   `stationary_anchor_latitude`/`stationary_anchor_longitude` in `processed_locations`).
3. Open the export in `tools/gps-route-analyzer.html` (Layers: Stationary anchors, Turns detected)
   to eyeball it before touching numbers.

## What to check, and which config field governs it

| Symptom in the log | Field to adjust | Where |
|---|---|---|
| Real fast riding rejected as `IMPOSSIBLE_SPEED` | `extremePhysicalSpeedMps` (bike) | `MODE_PROFILES.bike` |
| Real riding rejected/downgraded as `EXCESSIVE_DISPLACEMENT` at plausible speed | `plausibleSpeedMps` / `burstSpeedMps` (bike) | `MODE_PROFILES.bike` |
| Legitimate braking/acceleration flagged `HIGH_ACCELERATION` too often | `maxAccelerationMps2` (bike) | `MODE_PROFILES.bike` |
| A real turn isn't marked `turn_detected` (smoothing cuts the corner) | `turnDetectionThresholdDeg` (bike) — lower it | `MODE_PROFILES.bike` |
| GPS jitter while riding straight gets marked as turns | `turnDetectionThresholdDeg` (bike) — raise it | `MODE_PROFILES.bike` |
| A real stop takes too long to register as `STATIONARY` (or never does) | `stationaryConfirmationMs`, `stationarySpeedMps` (bike) | `MODE_PROFILES.bike` |
| Stop still adds a little false distance | `stationaryRadiusMeters` / `stationaryNoiseFloorM` (bike) | `MODE_PROFILES.bike` |
| Route stays on the wrong (parallel) road too long once Valhalla is deployed | `roadSwitchConfirmationCount`, `committedLagPoints` | `routeConfidence.js` call sites in `App.js` |
| GPS polling misses turns (route looks like it cuts corners even before smoothing) | `gpsIntervalMs` / `minDistanceMeters` (bike) → `POLLING_PROFILES.bike.MOVING_NORMAL` | `trackingConfig.js` |

## Process

1. Change one field at a time. Re-run `npm test` in `react-native/` after every change — the
   existing walk-profile regression tests (and the New ISBT Shimla fixture) must stay green; a bike
   tuning change should never move walk's numbers.
2. Prefer the `tests/processing.test.js` bike fixture (`buildBikeSession`) as a starting point for a
   new regression test capturing whatever real-log behavior prompted the change — a synthetic fixture
   derived from the real log's shape (not the raw log itself, to keep the repo free of real user
   location data) keeps the fix from regressing silently later.
3. Record *why* a value changed (which symptom, which ride) in the commit message — these numbers
   will be revisited again after more rides, and "why" matters more than "what" a year from now.
