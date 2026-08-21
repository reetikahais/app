# RaahMitra GPS logging

## Current implementation

The React Native logger uses Expo Location's background task with explicit profiles in `react-native/trackingConfig.js`:

| Profile | Expo accuracy | Requested interval | Distance |
| --- | --- | ---: | ---: |
| `ACQUIRING` | `BestForNavigation` | 1.5 s | 0 m |
| `LIVE_SAFETY` | `BestForNavigation` | 2.5 s | 2 m |
| `MOVING_NORMAL` | `Highest` | 5 s | 5 m |
| `STATIONARY` | `High` | 30 s | 25 m |

The current app starts `MOVING_NORMAL`. Acquisition, database writes, heartbeat, and future upload scheduling are separate concerns. Expo delivery is measured from fix timestamps and recorded as `interval_ms`; a requested interval is not evidence that the OS delivered that interval.

Profile changes are stored in `active_tracking_profile`. Starting an already-running task does not recreate it or emit a duplicate settings event for the same profile.

## Storage and timestamps

Every valid OS-delivered coordinate is inserted into `raw_locations` before route processing. `fix_timestamp_ms` is the timestamp supplied by the OS; `received_timestamp_ms` is the device receipt time. `fix_age_ms` is their non-negative difference. `elapsed_realtime_ns` is nullable because Expo does not expose it on every platform.

`processed_locations` contains a one-to-one processing decision where possible. It stores filtered/predicted coordinates separately from raw coordinates, the algorithm version, uncertainty, innovation, movement state, segment, and optional map-match fields. The legacy `logs` table remains for backward compatibility and older exports.

The database migration is additive: existing `logs` columns are preserved and the two new tables/indexes are created on open. Batch insertion uses a SQLite transaction.

## Processing rules

The canonical pure processor is `react-native/processing.js`, shared by the task and Node tests. It uses a local east/north metre coordinate system, actual elapsed time, and accuracy-derived measurement variance. It does not use a fixed movement-state alpha and cellular signal never changes GPS covariance.

Statuses:

- `FRESH_ACCEPTED`: fresh, sufficiently accurate fix that may be a solid route vertex.
- `FRESH_LOW_CONFIDENCE`: fresh fallback fix retained for diagnostics but excluded from the solid route.
- `PENDING_CONFIRMATION`: unusual or inaccurate fix awaiting corroboration.
- `STALE_FALLBACK`: stale or fallback data that must not extend a travelled line.
- `DUPLICATE`: exact timestamp/coordinate transport duplicate retained but excluded.
- `REJECTED_OUTLIER`: reserved for a future confirmation pass; current surprising points are conservatively pending.
- `NO_LOCATION`: reserved for task/error diagnostics.

A segment starts after a gap above `15,000 ms`, stale/fallback continuity, or a session/service boundary. No solid route is drawn across an unresolved segment gap. Raw fixes are never deleted. A map-matched coordinate, when added, is separate from physical filtered data and must not drive safety, geofence, helper-distance, or fraud decisions alone.

Position confidence and network quality are separate. Position confidence uses accuracy, age, method, innovation, and consistency. Network fields (`signal_dbm`, carrier, network type) describe upload/connectivity conditions only.

## Export schema

The app exports `schema_version`, `algorithm_version`, profile and processing configuration, legacy `logs`, `raw_locations`, `processed_locations`, and `events`. The analyzer accepts both this format and older payloads whose main array is `logs`.

## Analyzer

Open `tools/gps-route-analyzer.html` directly in a browser. Drop an export JSON into the file area or choose it with the picker. GeoJSON `LineString`/`FeatureCollection` and CSV with latitude/longitude can be loaded as a manual reference route. Nothing is uploaded.

The tool reports fix counts, fused/fallback counts, interval and accuracy percentiles, long gaps, route lengths, and processing decisions. Its canvas plot works without map tiles. Threshold controls rerun local analysis only. GeoJSON, CSV, and JSON diagnostics downloads are generated locally.

A nearest-line comparison against a manual route is a diagnostic approximation; it cannot prove the exact path between sparse observations. Blue screenshot lines are intentionally not interpreted as route data.

## Tests and field verification

Run the pure processing suite:

```powershell
cd react-native
npm test
```

The suite covers Haversine/local conversion, percentiles, fallback exclusion, gap segmentation, and duplicate handling. The supplied field export should be loaded in the analyzer to verify its 11 rows, 7 fused rows, 4 fallback rows, long gaps, and old-route displacement.

The Expo implementation does not yet include an Android native activity-recognition module or a native Kotlin location fallback. Those require a measured corrected Expo run first. If active moving delivery remains above the 10-second 95th percentile, add a Kotlin foreground service around `FusedLocationProviderClient` and preserve the same raw/processed schema.

Battery measurements and repeated-walk acceptance metrics remain field-test work: run stationary, walking, and live-safety sessions in foreground and background, then compare delivered intervals, accuracy, route length, and segment truthfulness rather than hiding missing data.
