# In-App Map Screen — Design Spec

## Context

Both apps (RN, Flutter) log GPS fixes with movement state (`STATIONARY` / `CONFIRMING_MOVEMENT` / `MOVING` / `CONFIRMING_STOP`), accuracy, and quality to local SQLite. Today the only way to see the logged path is to export the JSON and open it in an external tool (`tools/gps-path-animator.html` — a standalone browser page that accepts a pasted/uploaded export). This spec adds a screen inside both apps to view the same red/green (stationary/moving) animated path directly on-device, without the export/import round-trip.

This is the first UI screen beyond the single logger view in either app. The original project scope explicitly excluded a Maps UI (throwaway background-reliability harness, no server/API); this spec is a deliberate, explicitly-requested expansion of that scope for on-device inspection, not a reversal of the "no server" constraint — everything here stays local.

## Goals

- View the logged path on-device: red segments while `STATIONARY`, green while `MOVING`/`CONFIRMING_MOVEMENT`/`CONFIRMING_STOP`, matching `tools/gps-path-animator.html`'s convention exactly.
- Play/pause/scrub animation through the logged fixes, with a live telemetry readout (state, accuracy, quality, signal, battery) — same feature set as the standalone tool.
- Export the currently-plotted points as CSV/KML/GeoJSON via the OS share sheet.
- Manual refresh to pull in newly-logged fixes since the screen opened.

## Non-goals

- No live/streaming updates while tracking runs in the background — snapshot + manual refresh only.
- No offline map tiles — satellite imagery (Esri) requires internet, same as today's signal/carrier lookups.
- No new navigation library — the screen is a boolean toggle over the existing single-screen layout, not a new route.
- No multi-device/multi-track comparison (that's what the standalone desktop tool's device-comparison variant is for).

## Architecture

```
[Start/Stop screen] --tap "View Map"--> [Map screen: full-screen WebView]
        ^                                        |
        |                                        v
        +---------------tap "Back"---------------+

Map screen internals:
  getAllLogs() (RN) / getAllLogs(db) (Flutter)   -- already exists, unchanged
        |
        v
  buildMapPoints(rows)   <-- NEW pure function, ported 1:1 RN/Flutter
        |
        v
  animatorHtml(points)   <-- NEW: embeds points JSON into the WebView HTML/JS
        |                     (adapted from tools/gps-path-animator.html,
        |                      minus the paste/upload panel - data comes
        |                      straight from the points argument)
        v
  WebView renders it; "Refresh" button re-runs the pipeline and reloads;
  "Export" buttons inside the page postMessage the generated file text
  back to native, which writes a temp file and opens the share sheet
  (same pattern as the existing exportLogs()/_exportLogs()).
```

### `buildMapPoints(rows)` — pure, testable

Input: the raw array of log rows from `getAllLogs()` (same shape as one entry in an export's `logs` array).

Output: an array of plot points, sorted by timestamp ascending, each with:
`{ id, t (epoch ms), lat, lon, movementState, accuracy, method, batteryPct, appState, signalDbm, signalLevel, carrier, networkType, locationQuality }`

Rules (mirrors the standalone tool's `parseExport`):
- Position: `processed_latitude`/`processed_longitude` if present, else fall back to raw `latitude`/`longitude`.
- Drop rows missing both a usable position and a parseable timestamp.
- No other filtering — low-accuracy-fallback rows are kept but flagged (`method === 'low_accuracy_fallback'`) so the renderer can grey them out, exactly like the standalone tool. Nothing is silently discarded from the count the user sees.

This function has no I/O and no platform APIs — same shape as `movementStateMachine.js`/`.dart` — and gets real unit tests (empty input, all-unusable input, fallback to raw lat/lon, sort-by-time, mixed valid/invalid rows).

### WebView HTML/JS

Reuses `tools/gps-path-animator.html`'s map/animation/legend/telemetry code almost verbatim (same red/green/grey convention, same play/pause/scrub engine, same Esri tile layer). Differences from the standalone version:
- No paste-JSON/file-picker panel — the points array is serialized and templated directly into the HTML string's `<script>` block before it's handed to the WebView (same as how `tools/gps-path-animator.html` embeds its own hardcoded data), not sent after load via `postMessage` — avoids a load-timing race between the WebView firing ready and native posting the data.
- Export buttons no longer build a `Blob` + `<a download>` (unreliable inside a mobile WebView) — they instead call `window.ReactNativeWebView.postMessage(...)` (RN) / the Flutter WebView's registered JS channel (Flutter) with `{format, filename, content}`. Native receives it, writes a temp file, and calls `Sharing.shareAsync()` (RN) / `SharePlus.instance.share()` (Flutter) — the exact mechanism `exportLogs()`/`_exportLogs()` already use today.

### New dependencies

- RN: `react-native-webview` (native module — needs `expo install react-native-webview`, then a new EAS build; today's freshly-built APK does not have this yet).
- Flutter: `webview_flutter` (needs `flutter pub get` and a rebuild).

### Error handling

- `buildMapPoints` returns fewer than 2 points → Map screen shows a plain "Not enough data yet — log a few fixes first" message instead of attempting to render a broken/empty map.
- WebView fails to load (no internet, tile load failure) → Leaflet/tile errors surface as usual (grey tiles); not specially handled beyond what the standalone tool already does.

## Testing

- `buildMapPoints`: full TDD, both RN (Jest) and Flutter (`flutter test`) — mirrors the existing pattern for `movementStateMachine`/`computeFixMetrics`.
- WebView glue, the "View Map"/"Back"/"Refresh" wiring, and the native postMessage-to-share handlers: same disclosed exemption as `App.js`/`main.dart` today — no component/UI test harness exists in this repo for that layer.
- The animator HTML/JS itself (map rendering, animation engine, red/green coloring) is carried over from `tools/gps-path-animator.html`, already manually verified in that standalone context; not re-verified by automated tests here (it's markup/rendering, not logic this repo's test setup can exercise).

## Out of scope / explicitly deferred

- Live-updating map while tracking runs (deferred per this session's decision — snapshot + refresh only).
- Offline tiles.
- In-app multi-device comparison view.
