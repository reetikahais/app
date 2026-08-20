# In-App Map Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "View Map" screen to both the RN and Flutter apps that plots the logged GPS path (red = stationary, green = moving) with play/scrub animation and CSV/KML/GeoJSON export via the OS share sheet — no export/import round-trip through the standalone `tools/gps-path-animator.html` tool.

**Architecture:** A pure `buildMapPoints(rows)` function (one per platform, full TDD) turns `getAllLogs()` rows into flagged, sorted plot points — including the accuracy/spike/speed-outlier/gap-detection logic already proven in `tools/gps-path-animator.html` this session. A second function, `animatorHtml(points)`, templates those points directly into a self-contained HTML string (map/animation/export UI adapted from the standalone tool) that a WebView renders. Export buttons inside the WebView `postMessage` back to native, which writes a temp file and opens the OS share sheet — the same pattern `exportLogs()`/`_exportLogs()` already use today.

**Tech Stack:** `react-native-webview` (RN), `webview_flutter` (Flutter), Leaflet.js + Esri World_Imagery tiles (CDN, inside the WebView HTML) — same as the standalone tool.

**Supersedes:** `docs/superpowers/specs/2026-08-19-in-app-map-screen-design.md`'s `buildMapPoints` filtering rules (section "Rules (mirrors the standalone tool's `parseExport`)") — that spec predates this session's accuracy/spike/speed-outlier/gap-detection work in `tools/gps-path-animator.html`. This plan ports the *current* (updated) tool logic instead of the original simpler version.

---

## File Structure

**React Native (new files):**
- `react-native/mapPoints.js` — pure `buildMapPoints(rows)`. No I/O, no platform APIs — same shape as `movementStateMachine.js`.
- `react-native/mapAnimatorHtml.js` — pure `animatorHtml(points)`, returns an HTML string. No I/O.
- `react-native/__tests__/mapPoints.test.js` — TDD coverage for `buildMapPoints`.

**React Native (modified):**
- `react-native/App.js` — add "View Map" button, full-screen WebView, Back/Refresh buttons, export-message handler.
- `react-native/package.json` — add `react-native-webview` dependency.

**Flutter (new files):**
- `flutter/lib/map_points.dart` — pure `buildMapPoints(rows)` + `MapPoint` class. Mirrors `mapPoints.js` 1:1, same convention as `movement_state_machine.dart`/`.js`.
- `flutter/lib/map_animator_html.dart` — pure `animatorHtml(points)`.
- `flutter/test/map_points_test.dart` — TDD coverage, mirrors `mapPoints.test.js`.

**Flutter (modified):**
- `flutter/lib/main.dart` — add "View Map" button, full-screen `WebViewWidget`, Back/Refresh buttons, JS-channel export handler.
- `flutter/pubspec.yaml` — add `webview_flutter` dependency.

---

## Task 1: RN — `buildMapPoints` failing tests

**Files:**
- Create: `react-native/__tests__/mapPoints.test.js`

- [ ] **Step 1: Write the failing test file**

```javascript
import { buildMapPoints, ACCURACY_THRESHOLD_M, MAX_GAP_SECONDS, MAX_SPEED_KMH } from '../mapPoints';

function row(overrides) {
  return {
    id: 1,
    timestamp: '2026-08-19T08:49:15.964Z',
    latitude: 31.0964199,
    longitude: 77.1524214,
    accuracy: 14,
    battery: 80,
    app_state: 'foreground',
    method: 'fused',
    movement_state: 'STATIONARY',
    location_quality: 90,
    ...overrides,
  };
}

describe('buildMapPoints', () => {
  test('empty input returns empty array', () => {
    expect(buildMapPoints([])).toEqual([]);
  });

  test('rows with no usable position or timestamp are dropped', () => {
    const rows = [
      row({ id: 1, latitude: null, longitude: null }),
      row({ id: 2, timestamp: null }),
      row({ id: 3 }),
    ];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([3]);
  });

  test('falls back to processed_latitude/longitude when raw is missing', () => {
    const rows = [
      row({ id: 1, latitude: null, longitude: null, processed_latitude: 31.1, processed_longitude: 77.2 }),
    ];
    const points = buildMapPoints(rows);
    expect(points).toHaveLength(1);
    expect(points[0].lat).toBe(31.1);
    expect(points[0].lon).toBe(77.2);
  });

  test('sorts by timestamp ascending regardless of input order', () => {
    const rows = [
      row({ id: 2, timestamp: '2026-08-19T08:50:00.000Z' }),
      row({ id: 1, timestamp: '2026-08-19T08:49:00.000Z' }),
    ];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([1, 2]);
  });

  test('drops a second row identical in timestamp+lat+lon (redelivery dedup)', () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([1]);
  });

  test('keeps two rows with the same timestamp if position differs', () => {
    const rows = [row({ id: 1 }), row({ id: 2, latitude: 31.2 })];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([1, 2]);
  });

  test('flags accuracy worse than ACCURACY_THRESHOLD_M as isLowAcc, excluded from path', () => {
    const rows = [row({ id: 1, accuracy: ACCURACY_THRESHOLD_M + 1 })];
    const points = buildMapPoints(rows);
    expect(points[0].isLowAcc).toBe(true);
    expect(points[0].excluded).toBe(true);
  });

  test('accuracy at threshold is not flagged', () => {
    const rows = [row({ id: 1, accuracy: ACCURACY_THRESHOLD_M })];
    const points = buildMapPoints(rows);
    expect(points[0].isLowAcc).toBe(false);
    expect(points[0].excluded).toBe(false);
  });

  test('flags an isolated out-and-back spike, not its well-behaved neighbors', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:49:15.964Z', latitude: 31.0964199, longitude: 77.1524214, accuracy: 14 }),
      row({ id: 2, timestamp: '2026-08-19T08:52:30.967Z', latitude: 31.0921669, longitude: 77.1349605, accuracy: 46 }),
      row({ id: 3, timestamp: '2026-08-19T08:53:05.131Z', latitude: 31.0967622, longitude: 77.1529471, accuracy: 46 }),
    ];
    const points = buildMapPoints(rows);
    expect(points.find((p) => p.id === 2).isSpike).toBe(true);
    expect(points.find((p) => p.id === 1).isSpike).toBeFalsy();
    expect(points.find((p) => p.id === 3).isSpike).toBeFalsy();
  });

  test('flags an unrealistic-speed jump at the array edge (no reunion neighbor)', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:49:00.000Z', latitude: 31.0, longitude: 77.0, accuracy: 10 }),
      // ~11km in 10s => far above MAX_SPEED_KMH, and it's the LAST point so markSpikes can't see it.
      row({ id: 2, timestamp: '2026-08-19T08:49:10.000Z', latitude: 31.1, longitude: 77.0, accuracy: 10 }),
    ];
    const points = buildMapPoints(rows);
    expect(points[1].isSpeedOutlier).toBe(true);
    expect(points[1].excluded).toBe(true);
  });

  test('flags gapBefore when two kept fixes are more than MAX_GAP_SECONDS apart, only on non-excluded points', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:00:00.000Z' }),
      row({ id: 2, timestamp: new Date(new Date('2026-08-19T08:00:00.000Z').getTime() + (MAX_GAP_SECONDS + 1) * 1000).toISOString() }),
    ];
    const points = buildMapPoints(rows);
    expect(points[0].gapBefore).toBeFalsy();
    expect(points[1].gapBefore).toBe(true);
    expect(points[1].runIndex).toBe(1);
  });

  test('does not flag gapBefore when the gap is under MAX_GAP_SECONDS', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:00:00.000Z' }),
      row({ id: 2, timestamp: new Date(new Date('2026-08-19T08:00:00.000Z').getTime() + (MAX_GAP_SECONDS - 1) * 1000).toISOString() }),
    ];
    const points = buildMapPoints(rows);
    expect(points[1].gapBefore).toBe(false);
    expect(points[1].runIndex).toBe(0);
  });

  test('output carries movement/telemetry fields through unchanged', () => {
    const rows = [row({ id: 1, movement_state: 'MOVING', signal_dbm: -70, carrier: 'Jio', network_type: 'LTE', signal_level: 3, battery: 55, app_state: 'background', location_quality: 80 })];
    const points = buildMapPoints(rows);
    expect(points[0]).toMatchObject({
      id: 1,
      movementState: 'MOVING',
      signalDbm: -70,
      carrier: 'Jio',
      networkType: 'LTE',
      signalLevel: 3,
      batteryPct: 55,
      appState: 'background',
      locationQuality: 80,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd react-native && npx jest __tests__/mapPoints.test.js`
Expected: FAIL — `Cannot find module '../mapPoints'`

- [ ] **Step 3: Commit the failing test**

```bash
git add react-native/__tests__/mapPoints.test.js
git commit -m "test(rn): add failing buildMapPoints spec"
```

---

## Task 2: RN — implement `buildMapPoints`

**Files:**
- Create: `react-native/mapPoints.js`

- [ ] **Step 1: Write the implementation**

```javascript
// Pure GPS-fix -> plot-point pipeline: mirrors tools/gps-path-animator.html's parseExport +
// markSpikes + markSpeedOutliers, minus the load-panel/DOM concerns (this runs before the points
// ever reach a WebView). No I/O, no platform APIs - same shape as movementStateMachine.js.

import { MAX_ACCURACY_METERS } from './locationFixClassifier';
import { LONG_STATIONARY_INTERVAL_BACKGROUND_MS } from './movementStateMachine';

export const ACCURACY_THRESHOLD_M = MAX_ACCURACY_METERS;
// Set above the app's own longest legitimate adaptive-poll interval so normal long-stationary
// polling never falsely reads as a tracking gap - only real outages (task killed, background
// throttled) do. See tools/gps-path-animator.html for the same reasoning.
export const MAX_GAP_SECONDS = LONG_STATIONARY_INTERVAL_BACKGROUND_MS / 1000 + 60;
// Supplementary to the spike check below: catches a bad fix at either END of the array, where
// there's no "next"/"prev" neighbor for the reunion check to use.
export const MAX_SPEED_KMH = 150;

const NOISE_FLOOR_M = 15;
const REUNION_SLACK = 1.5;
const EARTH_RADIUS_M = 6371000;

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function effectiveAccuracy(a) {
  return Number.isFinite(a) && a > 0 ? Math.min(Math.max(a, 3), 250) : 100;
}

function noiseThresholdM(accA, accB) {
  return Math.max(accA, accB) + NOISE_FLOOR_M;
}

function markSpikes(points) {
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dPrevCur = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    const dCurNext = haversineM(cur.lat, cur.lon, next.lat, next.lon);
    const dPrevNext = haversineM(prev.lat, prev.lon, next.lat, next.lon);
    cur.isSpike =
      dPrevCur > noiseThresholdM(prev.effAcc, cur.effAcc) &&
      dCurNext > noiseThresholdM(cur.effAcc, next.effAcc) &&
      dPrevNext <= noiseThresholdM(prev.effAcc, next.effAcc) * REUNION_SLACK;
  }
}

function markSpeedOutliers(points) {
  let prev = null;
  for (const p of points) {
    if (p.isSpike) continue;
    if (prev) {
      const dt = (p.t - prev.t) / 1000;
      if (dt > 0) {
        const kmh = (haversineM(prev.lat, prev.lon, p.lat, p.lon) / dt) * 3.6;
        if (kmh > MAX_SPEED_KMH) p.isSpeedOutlier = true;
      }
    }
    if (!p.isSpeedOutlier) prev = p;
  }
}

export function buildMapPoints(rows) {
  const parsed = rows
    .map((r) => {
      const lat = r.latitude ?? r.processed_latitude;
      const lon = r.longitude ?? r.processed_longitude;
      const t = r.timestamp ? new Date(r.timestamp).getTime() : NaN;
      return {
        id: r.id,
        t,
        lat,
        lon,
        hasPos: typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon),
        accuracy: r.accuracy ?? null,
        effAcc: effectiveAccuracy(r.accuracy),
        movementState: r.movement_state ?? null,
        method: r.method ?? null,
        batteryPct: r.battery ?? null,
        appState: r.app_state ?? null,
        signalDbm: r.signal_dbm ?? null,
        signalLevel: r.signal_level ?? null,
        carrier: r.carrier ?? null,
        networkType: r.network_type ?? null,
        locationQuality: r.location_quality ?? null,
      };
    })
    .filter((p) => p.hasPos && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  const deduped = parsed.filter((p, i) => {
    if (i === 0) return true;
    const prev = parsed[i - 1];
    return !(p.t === prev.t && p.lat === prev.lat && p.lon === prev.lon);
  });

  deduped.forEach((p) => {
    p.isLowAcc = p.accuracy != null && p.accuracy > ACCURACY_THRESHOLD_M;
  });
  markSpikes(deduped);
  markSpeedOutliers(deduped);

  let runIndex = 0;
  let prevKeptT = null;
  deduped.forEach((p, idx) => {
    p.idx = idx;
    p.excluded = !!(p.isSpike || p.isSpeedOutlier || p.isLowAcc);
    if (!p.excluded) {
      p.gapBefore = prevKeptT != null && p.t - prevKeptT > MAX_GAP_SECONDS * 1000;
      if (p.gapBefore) runIndex += 1;
      p.runIndex = runIndex;
      prevKeptT = p.t;
    }
  });

  return deduped;
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd react-native && npx jest __tests__/mapPoints.test.js`
Expected: PASS, all 13 tests green.

- [ ] **Step 3: Commit**

```bash
git add react-native/mapPoints.js
git commit -m "feat(rn): add buildMapPoints for in-app map screen"
```

---

## Task 3: RN — `animatorHtml(points)`

**Files:**
- Create: `react-native/mapAnimatorHtml.js`

No test for this task (markup/rendering generator — same disclosed exemption as `App.js`, per the spec's Testing section). Verify manually per Task 5.

- [ ] **Step 1: Write `animatorHtml`**

```javascript
// Templates buildMapPoints() output straight into a self-contained HTML page for a WebView.
// Adapted from tools/gps-path-animator.html: same map/animation/legend/telemetry UI, minus the
// paste-JSON/file-picker load panel (points arrive already computed, no client-side detection
// logic needed here - buildMapPoints already flagged isSpike/isSpeedOutlier/isLowAcc/gapBefore).
// Export buttons postMessage to native instead of Blob+<a download>, which is unreliable in a
// mobile WebView (RN and Flutter each supply a different message bridge - see the sendExport()
// shim at the bottom of the generated script).

export function animatorHtml(points) {
  const pointsJson = JSON.stringify(points);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RaahMitra Map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
<style>
  :root{
    --bg:#0b1210; --panel:#101a17; --panel-2:#142019; --line:#24342c;
    --amber:#e8a33d; --amber-dim:#7a5a2a; --text:#e7ede9; --text-dim:#7c8d85;
    --green:#4caf6d; --green-lt:#7fcf8f; --yellow:#e0c04a; --red:#d1554a; --ghost:#4a5a52;
  }
  *{box-sizing:border-box;}
  html,body{height:100%;}
  body{margin:0; background:var(--bg); color:var(--text); font-family:sans-serif; overflow:hidden;}
  .app{display:flex; flex-direction:column; height:100vh;}
  header{display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--line); background:var(--panel-2); flex-shrink:0; gap:12px; flex-wrap:wrap;}
  .stats{display:flex; gap:14px; flex-wrap:wrap; font-size:11px;}
  .stat .v{font-weight:600;}
  .content{display:flex; flex:1; min-height:0;}
  .map-wrap{flex:1; position:relative; min-width:0;}
  #map{height:100%; width:100%; background:#0b1210;}
  .float-panel{position:absolute; z-index:500; background:rgba(16,26,23,0.93); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:10px; color:var(--text-dim);}
  .legend{right:10px; top:10px; width:180px;}
  .legend .row{display:flex; align-items:center; gap:6px; margin:3px 0;}
  .legend .sw{width:14px; height:4px; border-radius:2px; display:inline-block; flex-shrink:0;}
  .export-panel{right:10px; bottom:10px; width:190px;}
  .export-btn{display:block; width:100%; text-align:left; background:var(--panel); border:1px solid var(--line); color:var(--text); padding:7px 9px; border-radius:6px; margin-top:5px; font-size:11px;}
  .empty-state{position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-dim); font-size:13px; text-align:center; padding:20px; z-index:400;}
  .timeline-wrap{flex-shrink:0; border-top:1px solid var(--line); background:var(--panel-2); padding:8px 14px 12px 14px;}
  .transport{display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;}
  .btn{background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:7px 10px; font-size:12px;}
  .btn.play{background:var(--amber); color:#1a1204; border-color:var(--amber); font-weight:600;}
  .timeline-time{margin-left:auto; font-size:11px; color:var(--text-dim);}
  input[type=range]{width:100%; height:4px;}
</style>
</head>
<body>
<div class="app">
  <header>
    <span style="font-weight:700;color:var(--amber);">RaahMitra Map</span>
    <div class="stats" id="headerStats"></div>
  </header>
  <div class="content">
    <div class="map-wrap">
      <div id="map"></div>
      <div class="empty-state" id="emptyState" style="display:none;">Not enough data yet - log a few fixes first.</div>
      <div class="float-panel legend">
        <div class="row"><span class="sw" style="background:var(--red)"></span> Not moving</div>
        <div class="row"><span class="sw" style="background:var(--green)"></span> Moving</div>
        <div class="row"><span class="sw" style="background:var(--ghost)"></span> Low-accuracy (excluded)</div>
        <div class="row"><span class="sw" style="background:#8a6fd1"></span> Spike / speed outlier (excluded)</div>
        <div class="row"><span class="sw" style="background:repeating-linear-gradient(90deg,var(--yellow) 0 4px,transparent 4px 8px)"></span> Tracking gap (no line)</div>
      </div>
      <div class="float-panel export-panel">
        <button class="export-btn" id="expCsv">CSV export</button>
        <button class="export-btn" id="expKml">KML export</button>
        <button class="export-btn" id="expGeo">GeoJSON export</button>
      </div>
    </div>
  </div>
  <div class="timeline-wrap">
    <div class="transport">
      <button class="btn play" id="playBtn">Play</button>
      <button class="btn" id="resetBtn">Restart</button>
      <div class="timeline-time" id="tlTime">00:00 / 00:00</div>
    </div>
    <input type="range" id="scrub" min="0" max="1000" value="0">
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const points = ${pointsJson};

function isMovingState(s){ return s === 'MOVING' || s === 'CONFIRMING_MOVEMENT' || s === 'CONFIRMING_STOP'; }
function fmtElapsed(ms){ const s=Math.floor(ms/1000); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function lerp(a,b,f){ return a + (b-a)*f; }

// One shared shim so this same generated page works whether it's hosted in an RN WebView
// (window.ReactNativeWebView.postMessage) or a Flutter webview_flutter WebView (a named
// JavaScript channel object) - only one of the two will exist at runtime.
function sendExport(format, filename, content){
  const payload = JSON.stringify({ format, filename, content });
  if(window.ReactNativeWebView && window.ReactNativeWebView.postMessage){
    window.ReactNativeWebView.postMessage(payload);
  } else if(window.FlutterExport && window.FlutterExport.postMessage){
    window.FlutterExport.postMessage(payload);
  }
}

if(points.length < 2){
  document.getElementById('emptyState').style.display = 'flex';
} else {
  const t0 = points[0].t, tN = points[points.length-1].t, totalSpanMs = Math.max(tN - t0, 1);
  const map = L.map('map', {zoomControl:true, attributionControl:true});
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:22, maxNativeZoom:19, attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics'
  }).addTo(map);
  L.control.scale({metric:true, imperial:false, position:'bottomright'}).addTo(map);

  const plottable = points.filter(p => !p.excluded);
  plottable.forEach((p, i) => { p.plottableIdx = i; });
  const runs = [];
  plottable.forEach(p => { (runs[p.runIndex] ??= []).push(p); });

  const segmentLayers = [];
  for(let i = 1; i < plottable.length; i++){
    const a = plottable[i-1], b = plottable[i];
    if(b.gapBefore) continue;
    const color = isMovingState(b.movementState) ? '#4caf6d' : '#d1554a';
    segmentLayers.push(L.polyline([[a.lat,a.lon],[b.lat,b.lon]], {color, weight:4, opacity:0.85}).addTo(map));
  }

  points.forEach((p) => {
    const outlier = p.isSpike || p.isSpeedOutlier;
    const badFix = !outlier && p.isLowAcc;
    const excluded = outlier || badFix;
    const color = outlier ? '#8a6fd1' : badFix ? '#4a5a52' : (isMovingState(p.movementState) ? '#4caf6d' : '#d1554a');
    L.circleMarker([p.lat, p.lon], {
      radius: excluded ? 4 : 6, color, weight:2, fillColor:color, fillOpacity: excluded ? 0.5 : 0.7
    }).addTo(map).bindPopup(
      'Fix #' + p.id + '<br>' + (p.movementState ?? '-') + '<br>' +
      (p.accuracy != null ? p.accuracy.toFixed(1)+'m accuracy' : '') +
      (p.gapBefore ? '<br><b>tracking gap before this fix</b>' : '')
    );
  });

  const riderIcon = L.divIcon({ className:'', html:'<div style="width:18px;height:18px;border-radius:50%;background:#e8a33d;border:3px solid #1a1204;"></div>', iconSize:[18,18], iconAnchor:[9,9] });
  const rider = L.marker([plottable[0].lat, plottable[0].lon], {icon:riderIcon, zIndexOffset:1000}).addTo(map);
  const accuracyCircle = L.circle([plottable[0].lat, plottable[0].lon], {radius:plottable[0].effAcc, color:'#e8a33d', weight:1, fillColor:'#e8a33d', fillOpacity:0.08}).addTo(map);
  const trailLayers = runs.map(() => L.polyline([], {color:'#e8a33d', weight:2, opacity:0.6, dashArray:'4,5'}).addTo(map));

  map.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lon])), {padding:[40,40], maxZoom:19});

  document.getElementById('headerStats').innerHTML =
    '<div class="stat"><div class="v">' + points.length + '</div>fixes</div>' +
    '<div class="stat"><div class="v">' + plottable.filter(p=>p.gapBefore).length + '</div>gaps</div>';

  const SEGMENT_MS = 2200;
  let playing = false, segIndex = 0, segProgress = 0, lastFrame = null;
  const scrub = document.getElementById('scrub');
  const SCRUB_MAX = 1000;
  scrub.max = SCRUB_MAX;
  function totalSegments(){ return Math.max(plottable.length - 1, 1); }

  function render(idx, prog){
    const a = plottable[idx];
    const b = plottable[Math.min(idx+1, plottable.length-1)];
    const jump = b.gapBefore && a !== b;
    const lat = jump ? (prog < 1 ? a.lat : b.lat) : lerp(a.lat, b.lat, prog);
    const lon = jump ? (prog < 1 ? a.lon : b.lon) : lerp(a.lon, b.lon, prog);
    rider.setLatLng([lat, lon]);
    accuracyCircle.setLatLng([lat, lon]);
    accuracyCircle.setRadius(lerp(a.effAcc, b.effAcc, prog));
    const curRun = a.runIndex;
    trailLayers.forEach((layer, ri) => {
      if(ri < curRun) layer.setLatLngs(runs[ri].map(p => [p.lat, p.lon]));
      else if(ri > curRun) layer.setLatLngs([]);
      else if(jump) layer.setLatLngs(runs[ri].map(p => [p.lat, p.lon]));
      else layer.setLatLngs(runs[ri].filter(p => p.plottableIdx <= idx).map(p => [p.lat, p.lon]).concat([[lat, lon]]));
    });
    const tMs = lerp(a.t, b.t, prog);
    document.getElementById('tlTime').textContent = fmtElapsed(tMs - t0) + ' / ' + fmtElapsed(totalSpanMs);
    scrub.value = ((idx + prog) / totalSegments()) * SCRUB_MAX;
  }
  render(0, 0);

  document.getElementById('playBtn').addEventListener('click', () => {
    playing = !playing;
    document.getElementById('playBtn').textContent = playing ? 'Pause' : 'Play';
    lastFrame = null;
    if(playing) requestAnimationFrame(tick);
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    playing = false; document.getElementById('playBtn').textContent = 'Play';
    segIndex = 0; segProgress = 0; render(0,0);
  });
  scrub.addEventListener('input', () => {
    playing = false; document.getElementById('playBtn').textContent = 'Play';
    const frac = parseFloat(scrub.value) / SCRUB_MAX;
    const segF = frac * totalSegments();
    segIndex = clamp(Math.floor(segF), 0, totalSegments()-1);
    segProgress = clamp(segF - segIndex, 0, 1);
    render(segIndex, segProgress);
  });
  function tick(now){
    if(!playing) return;
    if(lastFrame === null) lastFrame = now;
    const dt = now - lastFrame;
    lastFrame = now;
    segProgress += dt / SEGMENT_MS;
    while(segProgress >= 1 && segIndex < totalSegments()-1){ segProgress -= 1; segIndex += 1; }
    if(segIndex >= totalSegments()-1 && segProgress >= 1){ segProgress = 1; playing = false; document.getElementById('playBtn').textContent = 'Play'; }
    render(segIndex, clamp(segProgress,0,1));
    if(playing) requestAnimationFrame(tick);
  }

  function labelFor(p){ return 'Fix #' + p.id; }
  document.getElementById('expCsv').addEventListener('click', () => {
    const rows = ['lat,lon,label,moving'];
    plottable.forEach(p => rows.push(p.lat+','+p.lon+',"'+labelFor(p)+'",'+isMovingState(p.movementState)));
    sendExport('csv', 'raahmitra_path.csv', rows.join('\\n'));
  });
  document.getElementById('expKml').addEventListener('click', () => {
    const placemarks = plottable.map(p => '<Placemark><name>Fix #'+p.id+'</name><Point><coordinates>'+p.lon+','+p.lat+',0</coordinates></Point></Placemark>').join('');
    const kml = '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>RaahMitra Path</name>'+placemarks+'</Document></kml>';
    sendExport('kml', 'raahmitra_path.kml', kml);
  });
  document.getElementById('expGeo').addEventListener('click', () => {
    const fc = { type:'FeatureCollection', features: plottable.map(p => ({ type:'Feature', geometry:{type:'Point', coordinates:[p.lon,p.lat]}, properties:{id:p.id, movementState:p.movementState} })) };
    sendExport('geojson', 'raahmitra_path.geojson', JSON.stringify(fc, null, 2));
  });
}
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: Commit**

```bash
git add react-native/mapAnimatorHtml.js
git commit -m "feat(rn): add animatorHtml WebView template"
```

---

## Task 4: RN — add `react-native-webview` dependency

**Files:**
- Modify: `react-native/package.json`

- [ ] **Step 1: Install**

Run: `cd react-native && npx expo install react-native-webview`
Expected: adds `react-native-webview` to `dependencies` in `package.json` at a version matched to Expo 57.

- [ ] **Step 2: Commit**

```bash
git add react-native/package.json react-native/package-lock.json
git commit -m "chore(rn): add react-native-webview dependency"
```

Note: this is a native module. The existing EAS preview build does not have it — a new build is required before this feature can run on-device (covered in Task 6's manual test note).

---

## Task 5: RN — wire the map screen into `App.js`

**Files:**
- Modify: `react-native/App.js`

- [ ] **Step 1: Add imports and state**

In `react-native/App.js`, add to the import block (after the existing `debounce` import at line 27):

```javascript
import { WebView } from 'react-native-webview';
import { buildMapPoints } from './mapPoints';
import { animatorHtml } from './mapAnimatorHtml';
```

Inside `export default function App() {`, alongside the existing `useState` calls (after `const [count, setCount] = useState(0);` at line 33):

```javascript
  const [showMap, setShowMap] = useState(false);
  const [mapHtml, setMapHtml] = useState(null);
```

- [ ] **Step 2: Add `refreshMap` and export-message handler**

After the existing `exportLogs` function (after its closing brace, currently ending at line 182), add:

```javascript
  async function refreshMap() {
    const logs = await getAllLogs();
    setMapHtml(animatorHtml(buildMapPoints(logs)));
  }

  async function openMap() {
    await refreshMap();
    setShowMap(true);
  }

  async function handleMapExport(event) {
    try {
      const { format, filename, content } = JSON.parse(event.nativeEvent.data);
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Export failed', 'Sharing is not available on this device.');
        return;
      }
      const file = new File(Paths.document, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(content);
      await Sharing.shareAsync(file.uri);
    } catch (err) {
      console.error('Map export failed', err);
      Alert.alert('Export failed', String(err?.message ?? err));
    }
  }
```

- [ ] **Step 3: Add the "View Map" button and full-screen map view**

Replace the `return (...)` block (lines 207-218) with:

```javascript
  if (showMap) {
    return (
      <View style={styles.container}>
        <View style={styles.mapToolbar}>
          <Button title="< Back" onPress={() => setShowMap(false)} />
          <Button title="Refresh" onPress={refreshMap} />
        </View>
        {mapHtml && (
          <WebView
            originWhitelist={['*']}
            source={{ html: mapHtml }}
            onMessage={handleMapExport}
            style={styles.webview}
          />
        )}
        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>RaahMitra GPS Logger (React Native)</Text>
      <Text style={styles.status}>{running ? 'RUNNING' : 'STOPPED'}</Text>
      <Text style={styles.count}>Logs written: {count}</Text>
      <Button title={running ? 'Stop logging' : 'Start logging'} onPress={running ? stop : start} />
      <Button title="View Map" onPress={openMap} />
      <Button title="Export Logs" onPress={exportLogs} />
      <Button title="Clear Logs" color="#c0392b" onPress={confirmClearLogs} />
      <StatusBar style="auto" />
    </View>
  );
}
```

- [ ] **Step 4: Add the new styles**

In the `StyleSheet.create({...})` block at the bottom of the file, add alongside the existing keys:

```javascript
  mapToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 12,
    paddingTop: 40,
    paddingBottom: 8,
  },
  webview: {
    flex: 1,
    width: '100%',
  },
```

- [ ] **Step 5: Run existing RN test suite to confirm no regressions**

Run: `cd react-native && npx jest`
Expected: PASS — all existing suites plus `mapPoints.test.js` green. (No test exists for `App.js` before or after this change — same disclosed exemption as today.)

- [ ] **Step 6: Commit**

```bash
git add react-native/App.js
git commit -m "feat(rn): wire in-app map screen into App.js"
```

---

## Task 6: RN — manual on-device verification

No automated test — this is the UI-glue layer, same exemption as `App.js` generally.

- [ ] **Step 1: Trigger a new EAS build** (required — `react-native-webview` is a native module the current APK doesn't have)

Run: `cd react-native && eas build --platform android --profile preview`

- [ ] **Step 2: Install the new build, log a short walk (or reuse existing DB rows), tap "View Map"**

Verify:
- Map renders with satellite tiles, red/green path matching movement state.
- Play/scrub animation works.
- "Refresh" re-pulls latest rows without leaving the screen.
- "Back" returns to the start/stop screen.
- Each export button (CSV/KML/GeoJSON) triggers the OS share sheet with a non-empty file.
- If fewer than 2 usable fixes are logged, the map screen shows "Not enough data yet - log a few fixes first." instead of a broken map.

---

## Task 7: Flutter — `buildMapPoints` failing tests

**Files:**
- Create: `flutter/test/map_points_test.dart`

- [ ] **Step 1: Write the failing test file**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/map_points.dart';

Map<String, Object?> row(Map<String, Object?> overrides) {
  final base = <String, Object?>{
    'id': 1,
    'timestamp': '2026-08-19T08:49:15.964Z',
    'latitude': 31.0964199,
    'longitude': 77.1524214,
    'accuracy': 14.0,
    'battery': 80,
    'app_state': 'foreground',
    'method': 'fused',
    'movement_state': 'STATIONARY',
    'location_quality': 90,
  };
  base.addAll(overrides);
  return base;
}

void main() {
  group('buildMapPoints', () {
    test('empty input returns empty list', () {
      expect(buildMapPoints([]), isEmpty);
    });

    test('rows with no usable position or timestamp are dropped', () {
      final rows = [
        row({'id': 1, 'latitude': null, 'longitude': null}),
        row({'id': 2, 'timestamp': null}),
        row({'id': 3}),
      ];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [3]);
    });

    test('falls back to processed_latitude/longitude when raw is missing', () {
      final rows = [
        row({
          'id': 1,
          'latitude': null,
          'longitude': null,
          'processed_latitude': 31.1,
          'processed_longitude': 77.2,
        }),
      ];
      final points = buildMapPoints(rows);
      expect(points, hasLength(1));
      expect(points[0].lat, 31.1);
      expect(points[0].lon, 77.2);
    });

    test('sorts by timestamp ascending regardless of input order', () {
      final rows = [
        row({'id': 2, 'timestamp': '2026-08-19T08:50:00.000Z'}),
        row({'id': 1, 'timestamp': '2026-08-19T08:49:00.000Z'}),
      ];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [1, 2]);
    });

    test('drops a second row identical in timestamp+lat+lon (redelivery dedup)', () {
      final rows = [row({'id': 1}), row({'id': 2})];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [1]);
    });

    test('keeps two rows with the same timestamp if position differs', () {
      final rows = [row({'id': 1}), row({'id': 2, 'latitude': 31.2})];
      final points = buildMapPoints(rows);
      expect(points.map((p) => p.id).toList(), [1, 2]);
    });

    test('flags accuracy worse than accuracyThresholdM as isLowAcc, excluded from path', () {
      final rows = [row({'id': 1, 'accuracy': accuracyThresholdM + 1})];
      final points = buildMapPoints(rows);
      expect(points[0].isLowAcc, true);
      expect(points[0].excluded, true);
    });

    test('accuracy at threshold is not flagged', () {
      final rows = [row({'id': 1, 'accuracy': accuracyThresholdM})];
      final points = buildMapPoints(rows);
      expect(points[0].isLowAcc, false);
      expect(points[0].excluded, false);
    });

    test('flags an isolated out-and-back spike, not its well-behaved neighbors', () {
      final rows = [
        row({'id': 1, 'timestamp': '2026-08-19T08:49:15.964Z', 'latitude': 31.0964199, 'longitude': 77.1524214, 'accuracy': 14.0}),
        row({'id': 2, 'timestamp': '2026-08-19T08:52:30.967Z', 'latitude': 31.0921669, 'longitude': 77.1349605, 'accuracy': 46.0}),
        row({'id': 3, 'timestamp': '2026-08-19T08:53:05.131Z', 'latitude': 31.0967622, 'longitude': 77.1529471, 'accuracy': 46.0}),
      ];
      final points = buildMapPoints(rows);
      expect(points.firstWhere((p) => p.id == 2).isSpike, true);
      expect(points.firstWhere((p) => p.id == 1).isSpike, false);
      expect(points.firstWhere((p) => p.id == 3).isSpike, false);
    });

    test('flags an unrealistic-speed jump at the array edge (no reunion neighbor)', () {
      final rows = [
        row({'id': 1, 'timestamp': '2026-08-19T08:49:00.000Z', 'latitude': 31.0, 'longitude': 77.0, 'accuracy': 10.0}),
        row({'id': 2, 'timestamp': '2026-08-19T08:49:10.000Z', 'latitude': 31.1, 'longitude': 77.0, 'accuracy': 10.0}),
      ];
      final points = buildMapPoints(rows);
      expect(points[1].isSpeedOutlier, true);
      expect(points[1].excluded, true);
    });

    test('flags gapBefore when two kept fixes are more than maxGapSeconds apart', () {
      final base = DateTime.parse('2026-08-19T08:00:00.000Z');
      final rows = [
        row({'id': 1, 'timestamp': base.toIso8601String()}),
        row({'id': 2, 'timestamp': base.add(Duration(seconds: maxGapSeconds + 1)).toIso8601String()}),
      ];
      final points = buildMapPoints(rows);
      expect(points[0].gapBefore, false);
      expect(points[1].gapBefore, true);
      expect(points[1].runIndex, 1);
    });

    test('does not flag gapBefore when the gap is under maxGapSeconds', () {
      final base = DateTime.parse('2026-08-19T08:00:00.000Z');
      final rows = [
        row({'id': 1, 'timestamp': base.toIso8601String()}),
        row({'id': 2, 'timestamp': base.add(Duration(seconds: maxGapSeconds - 1)).toIso8601String()}),
      ];
      final points = buildMapPoints(rows);
      expect(points[1].gapBefore, false);
      expect(points[1].runIndex, 0);
    });

    test('output carries movement/telemetry fields through unchanged', () {
      final rows = [
        row({
          'id': 1,
          'movement_state': 'MOVING',
          'signal_dbm': -70,
          'carrier': 'Jio',
          'network_type': 'LTE',
          'signal_level': 3,
          'battery': 55,
          'app_state': 'background',
          'location_quality': 80,
        }),
      ];
      final points = buildMapPoints(rows);
      expect(points[0].movementState, 'MOVING');
      expect(points[0].signalDbm, -70);
      expect(points[0].carrier, 'Jio');
      expect(points[0].networkType, 'LTE');
      expect(points[0].signalLevel, 3);
      expect(points[0].batteryPct, 55);
      expect(points[0].appState, 'background');
      expect(points[0].locationQuality, 80);
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flutter && flutter test test/map_points_test.dart`
Expected: FAIL — `Error: Not found: 'package:raahmitra_gps_logger/map_points.dart'`

- [ ] **Step 3: Commit the failing test**

```bash
git add flutter/test/map_points_test.dart
git commit -m "test(flutter): add failing buildMapPoints spec"
```

---

## Task 8: Flutter — implement `buildMapPoints`

**Files:**
- Create: `flutter/lib/map_points.dart`

- [ ] **Step 1: Write the implementation**

```dart
import 'dart:math' as math;

import 'location_task.dart' show maxAccuracyMeters;
import 'movement_state_machine.dart' show longStationaryIntervalBackgroundMs;

// Pure GPS-fix -> plot-point pipeline. Mirrors react-native/mapPoints.js 1:1, same convention as
// movement_state_machine.dart mirroring movementStateMachine.js. No I/O, no platform APIs.

const double accuracyThresholdM = maxAccuracyMeters;
// Set above the app's own longest legitimate adaptive-poll interval so normal long-stationary
// polling never falsely reads as a tracking gap - only real outages do.
final int maxGapSeconds = longStationaryIntervalBackgroundMs ~/ 1000 + 60;
const double maxSpeedKmh = 150;

const double _noiseFloorM = 15;
const double _reunionSlack = 1.5;
const double _earthRadiusM = 6371000;

double _haversineM(double lat1, double lon1, double lat2, double lon2) {
  double toRad(double d) => d * math.pi / 180;
  final dLat = toRad(lat2 - lat1);
  final dLon = toRad(lon2 - lon1);
  final a = math.pow(math.sin(dLat / 2), 2) +
      math.cos(toRad(lat1)) * math.cos(toRad(lat2)) * math.pow(math.sin(dLon / 2), 2);
  return 2 * _earthRadiusM * math.asin(math.sqrt(a));
}

double _effectiveAccuracy(double? a) {
  if (a == null || !a.isFinite || a <= 0) return 100;
  return math.min(math.max(a, 3), 250);
}

double _noiseThresholdM(double accA, double accB) => math.max(accA, accB) + _noiseFloorM;

class MapPoint {
  final int? id;
  final int t;
  final double lat;
  final double lon;
  final double effAcc;
  final double? accuracy;
  final String? movementState;
  final String? method;
  final int? batteryPct;
  final String? appState;
  final int? signalDbm;
  final int? signalLevel;
  final String? carrier;
  final String? networkType;
  final int? locationQuality;

  late int idx;
  bool isLowAcc = false;
  bool isSpike = false;
  bool isSpeedOutlier = false;
  bool excluded = false;
  bool gapBefore = false;
  int runIndex = 0;

  MapPoint({
    required this.id,
    required this.t,
    required this.lat,
    required this.lon,
    required this.accuracy,
    required this.movementState,
    required this.method,
    required this.batteryPct,
    required this.appState,
    required this.signalDbm,
    required this.signalLevel,
    required this.carrier,
    required this.networkType,
    required this.locationQuality,
  }) : effAcc = _effectiveAccuracy(accuracy);
}

void _markSpikes(List<MapPoint> points) {
  for (var i = 1; i < points.length - 1; i++) {
    final prev = points[i - 1];
    final cur = points[i];
    final next = points[i + 1];
    final dPrevCur = _haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    final dCurNext = _haversineM(cur.lat, cur.lon, next.lat, next.lon);
    final dPrevNext = _haversineM(prev.lat, prev.lon, next.lat, next.lon);
    cur.isSpike = dPrevCur > _noiseThresholdM(prev.effAcc, cur.effAcc) &&
        dCurNext > _noiseThresholdM(cur.effAcc, next.effAcc) &&
        dPrevNext <= _noiseThresholdM(prev.effAcc, next.effAcc) * _reunionSlack;
  }
}

void _markSpeedOutliers(List<MapPoint> points) {
  MapPoint? prev;
  for (final p in points) {
    if (p.isSpike) continue;
    if (prev != null) {
      final dt = (p.t - prev.t) / 1000;
      if (dt > 0) {
        final kmh = (_haversineM(prev.lat, prev.lon, p.lat, p.lon) / dt) * 3.6;
        if (kmh > maxSpeedKmh) p.isSpeedOutlier = true;
      }
    }
    if (!p.isSpeedOutlier) prev = p;
  }
}

List<MapPoint> buildMapPoints(List<Map<String, Object?>> rows) {
  final parsed = <MapPoint>[];
  for (final r in rows) {
    final lat = (r['latitude'] as num?)?.toDouble() ?? (r['processed_latitude'] as num?)?.toDouble();
    final lon = (r['longitude'] as num?)?.toDouble() ?? (r['processed_longitude'] as num?)?.toDouble();
    final timestamp = r['timestamp'] as String?;
    final t = timestamp != null ? DateTime.tryParse(timestamp)?.millisecondsSinceEpoch : null;
    if (lat == null || lon == null || t == null) continue;
    parsed.add(MapPoint(
      id: r['id'] as int?,
      t: t,
      lat: lat,
      lon: lon,
      accuracy: (r['accuracy'] as num?)?.toDouble(),
      movementState: r['movement_state'] as String?,
      method: r['method'] as String?,
      batteryPct: r['battery'] as int?,
      appState: r['app_state'] as String?,
      signalDbm: r['signal_dbm'] as int?,
      signalLevel: r['signal_level'] as int?,
      carrier: r['carrier'] as String?,
      networkType: r['network_type'] as String?,
      locationQuality: r['location_quality'] as int?,
    ));
  }
  parsed.sort((a, b) => a.t.compareTo(b.t));

  final deduped = <MapPoint>[];
  for (var i = 0; i < parsed.length; i++) {
    final p = parsed[i];
    if (i > 0) {
      final prev = parsed[i - 1];
      if (p.t == prev.t && p.lat == prev.lat && p.lon == prev.lon) continue;
    }
    deduped.add(p);
  }

  for (final p in deduped) {
    p.isLowAcc = p.accuracy != null && p.accuracy! > accuracyThresholdM;
  }
  _markSpikes(deduped);
  _markSpeedOutliers(deduped);

  var runIndex = 0;
  int? prevKeptT;
  for (var idx = 0; idx < deduped.length; idx++) {
    final p = deduped[idx];
    p.idx = idx;
    p.excluded = p.isSpike || p.isSpeedOutlier || p.isLowAcc;
    if (!p.excluded) {
      p.gapBefore = prevKeptT != null && (p.t - prevKeptT) > maxGapSeconds * 1000;
      if (p.gapBefore) runIndex += 1;
      p.runIndex = runIndex;
      prevKeptT = p.t;
    }
  }

  return deduped;
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd flutter && flutter test test/map_points_test.dart`
Expected: PASS, all 13 tests green.

- [ ] **Step 3: Commit**

```bash
git add flutter/lib/map_points.dart
git commit -m "feat(flutter): add buildMapPoints for in-app map screen"
```

---

## Task 9: Flutter — `animatorHtml(points)`

**Files:**
- Create: `flutter/lib/map_animator_html.dart`

No test for this task — same markup/rendering exemption as Task 3.

- [ ] **Step 1: Write `animatorHtml`**

```dart
import 'dart:convert';

import 'map_points.dart';

// Templates buildMapPoints() output into the same self-contained HTML page as
// react-native/mapAnimatorHtml.js - keep the two in sync manually (no shared build step between
// the platforms). See that file for the full rationale on what got left out vs. the standalone
// tools/gps-path-animator.html (no load panel, no client-side detection logic - buildMapPoints
// already flagged everything).

Map<String, Object?> _pointToJson(MapPoint p) => {
      'id': p.id,
      't': p.t,
      'lat': p.lat,
      'lon': p.lon,
      'effAcc': p.effAcc,
      'accuracy': p.accuracy,
      'movementState': p.movementState,
      'isLowAcc': p.isLowAcc,
      'isSpike': p.isSpike,
      'isSpeedOutlier': p.isSpeedOutlier,
      'excluded': p.excluded,
      'gapBefore': p.gapBefore,
      'runIndex': p.runIndex,
    };

String animatorHtml(List<MapPoint> points) {
  final pointsJson = jsonEncode(points.map(_pointToJson).toList());

  return '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RaahMitra Map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
<style>
  :root{
    --bg:#0b1210; --panel:#101a17; --panel-2:#142019; --line:#24342c;
    --amber:#e8a33d; --amber-dim:#7a5a2a; --text:#e7ede9; --text-dim:#7c8d85;
    --green:#4caf6d; --green-lt:#7fcf8f; --yellow:#e0c04a; --red:#d1554a; --ghost:#4a5a52;
  }
  *{box-sizing:border-box;}
  html,body{height:100%;}
  body{margin:0; background:var(--bg); color:var(--text); font-family:sans-serif; overflow:hidden;}
  .app{display:flex; flex-direction:column; height:100vh;}
  header{display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--line); background:var(--panel-2); flex-shrink:0; gap:12px; flex-wrap:wrap;}
  .stats{display:flex; gap:14px; flex-wrap:wrap; font-size:11px;}
  .content{display:flex; flex:1; min-height:0;}
  .map-wrap{flex:1; position:relative; min-width:0;}
  #map{height:100%; width:100%; background:#0b1210;}
  .float-panel{position:absolute; z-index:500; background:rgba(16,26,23,0.93); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:10px; color:var(--text-dim);}
  .legend{right:10px; top:10px; width:180px;}
  .legend .row{display:flex; align-items:center; gap:6px; margin:3px 0;}
  .legend .sw{width:14px; height:4px; border-radius:2px; display:inline-block; flex-shrink:0;}
  .export-panel{right:10px; bottom:10px; width:190px;}
  .export-btn{display:block; width:100%; text-align:left; background:var(--panel); border:1px solid var(--line); color:var(--text); padding:7px 9px; border-radius:6px; margin-top:5px; font-size:11px;}
  .empty-state{position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-dim); font-size:13px; text-align:center; padding:20px; z-index:400;}
  .timeline-wrap{flex-shrink:0; border-top:1px solid var(--line); background:var(--panel-2); padding:8px 14px 12px 14px;}
  .transport{display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;}
  .btn{background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:7px 10px; font-size:12px;}
  .btn.play{background:var(--amber); color:#1a1204; border-color:var(--amber); font-weight:600;}
  .timeline-time{margin-left:auto; font-size:11px; color:var(--text-dim);}
  input[type=range]{width:100%; height:4px;}
</style>
</head>
<body>
<div class="app">
  <header>
    <span style="font-weight:700;color:var(--amber);">RaahMitra Map</span>
    <div class="stats" id="headerStats"></div>
  </header>
  <div class="content">
    <div class="map-wrap">
      <div id="map"></div>
      <div class="empty-state" id="emptyState" style="display:none;">Not enough data yet - log a few fixes first.</div>
      <div class="float-panel legend">
        <div class="row"><span class="sw" style="background:var(--red)"></span> Not moving</div>
        <div class="row"><span class="sw" style="background:var(--green)"></span> Moving</div>
        <div class="row"><span class="sw" style="background:var(--ghost)"></span> Low-accuracy (excluded)</div>
        <div class="row"><span class="sw" style="background:#8a6fd1"></span> Spike / speed outlier (excluded)</div>
        <div class="row"><span class="sw" style="background:repeating-linear-gradient(90deg,var(--yellow) 0 4px,transparent 4px 8px)"></span> Tracking gap (no line)</div>
      </div>
      <div class="float-panel export-panel">
        <button class="export-btn" id="expCsv">CSV export</button>
        <button class="export-btn" id="expKml">KML export</button>
        <button class="export-btn" id="expGeo">GeoJSON export</button>
      </div>
    </div>
  </div>
  <div class="timeline-wrap">
    <div class="transport">
      <button class="btn play" id="playBtn">Play</button>
      <button class="btn" id="resetBtn">Restart</button>
      <div class="timeline-time" id="tlTime">00:00 / 00:00</div>
    </div>
    <input type="range" id="scrub" min="0" max="1000" value="0">
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const points = $pointsJson;

function isMovingState(s){ return s === 'MOVING' || s === 'CONFIRMING_MOVEMENT' || s === 'CONFIRMING_STOP'; }
function fmtElapsed(ms){ const s=Math.floor(ms/1000); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function lerp(a,b,f){ return a + (b-a)*f; }

function sendExport(format, filename, content){
  const payload = JSON.stringify({ format, filename, content });
  if(window.ReactNativeWebView && window.ReactNativeWebView.postMessage){
    window.ReactNativeWebView.postMessage(payload);
  } else if(window.FlutterExport && window.FlutterExport.postMessage){
    window.FlutterExport.postMessage(payload);
  }
}

if(points.length < 2){
  document.getElementById('emptyState').style.display = 'flex';
} else {
  const t0 = points[0].t, tN = points[points.length-1].t, totalSpanMs = Math.max(tN - t0, 1);
  const map = L.map('map', {zoomControl:true, attributionControl:true});
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:22, maxNativeZoom:19, attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics'
  }).addTo(map);
  L.control.scale({metric:true, imperial:false, position:'bottomright'}).addTo(map);

  const plottable = points.filter(p => !p.excluded);
  plottable.forEach((p, i) => { p.plottableIdx = i; });
  const runs = [];
  plottable.forEach(p => { (runs[p.runIndex] ??= []).push(p); });

  const segmentLayers = [];
  for(let i = 1; i < plottable.length; i++){
    const a = plottable[i-1], b = plottable[i];
    if(b.gapBefore) continue;
    const color = isMovingState(b.movementState) ? '#4caf6d' : '#d1554a';
    segmentLayers.push(L.polyline([[a.lat,a.lon],[b.lat,b.lon]], {color, weight:4, opacity:0.85}).addTo(map));
  }

  points.forEach((p) => {
    const outlier = p.isSpike || p.isSpeedOutlier;
    const badFix = !outlier && p.isLowAcc;
    const excluded = outlier || badFix;
    const color = outlier ? '#8a6fd1' : badFix ? '#4a5a52' : (isMovingState(p.movementState) ? '#4caf6d' : '#d1554a');
    L.circleMarker([p.lat, p.lon], {
      radius: excluded ? 4 : 6, color, weight:2, fillColor:color, fillOpacity: excluded ? 0.5 : 0.7
    }).addTo(map).bindPopup(
      'Fix #' + p.id + '<br>' + (p.movementState ?? '-') + '<br>' +
      (p.accuracy != null ? p.accuracy.toFixed(1)+'m accuracy' : '') +
      (p.gapBefore ? '<br><b>tracking gap before this fix</b>' : '')
    );
  });

  const riderIcon = L.divIcon({ className:'', html:'<div style="width:18px;height:18px;border-radius:50%;background:#e8a33d;border:3px solid #1a1204;"></div>', iconSize:[18,18], iconAnchor:[9,9] });
  const rider = L.marker([plottable[0].lat, plottable[0].lon], {icon:riderIcon, zIndexOffset:1000}).addTo(map);
  const accuracyCircle = L.circle([plottable[0].lat, plottable[0].lon], {radius:plottable[0].effAcc, color:'#e8a33d', weight:1, fillColor:'#e8a33d', fillOpacity:0.08}).addTo(map);
  const trailLayers = runs.map(() => L.polyline([], {color:'#e8a33d', weight:2, opacity:0.6, dashArray:'4,5'}).addTo(map));

  map.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lon])), {padding:[40,40], maxZoom:19});

  document.getElementById('headerStats').innerHTML =
    '<div class="stat"><div class="v">' + points.length + '</div>fixes</div>' +
    '<div class="stat"><div class="v">' + plottable.filter(p=>p.gapBefore).length + '</div>gaps</div>';

  const SEGMENT_MS = 2200;
  let playing = false, segIndex = 0, segProgress = 0, lastFrame = null;
  const scrub = document.getElementById('scrub');
  const SCRUB_MAX = 1000;
  scrub.max = SCRUB_MAX;
  function totalSegments(){ return Math.max(plottable.length - 1, 1); }

  function render(idx, prog){
    const a = plottable[idx];
    const b = plottable[Math.min(idx+1, plottable.length-1)];
    const jump = b.gapBefore && a !== b;
    const lat = jump ? (prog < 1 ? a.lat : b.lat) : lerp(a.lat, b.lat, prog);
    const lon = jump ? (prog < 1 ? a.lon : b.lon) : lerp(a.lon, b.lon, prog);
    rider.setLatLng([lat, lon]);
    accuracyCircle.setLatLng([lat, lon]);
    accuracyCircle.setRadius(lerp(a.effAcc, b.effAcc, prog));
    const curRun = a.runIndex;
    trailLayers.forEach((layer, ri) => {
      if(ri < curRun) layer.setLatLngs(runs[ri].map(p => [p.lat, p.lon]));
      else if(ri > curRun) layer.setLatLngs([]);
      else if(jump) layer.setLatLngs(runs[ri].map(p => [p.lat, p.lon]));
      else layer.setLatLngs(runs[ri].filter(p => p.plottableIdx <= idx).map(p => [p.lat, p.lon]).concat([[lat, lon]]));
    });
    const tMs = lerp(a.t, b.t, prog);
    document.getElementById('tlTime').textContent = fmtElapsed(tMs - t0) + ' / ' + fmtElapsed(totalSpanMs);
    scrub.value = ((idx + prog) / totalSegments()) * SCRUB_MAX;
  }
  render(0, 0);

  document.getElementById('playBtn').addEventListener('click', () => {
    playing = !playing;
    document.getElementById('playBtn').textContent = playing ? 'Pause' : 'Play';
    lastFrame = null;
    if(playing) requestAnimationFrame(tick);
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    playing = false; document.getElementById('playBtn').textContent = 'Play';
    segIndex = 0; segProgress = 0; render(0,0);
  });
  scrub.addEventListener('input', () => {
    playing = false; document.getElementById('playBtn').textContent = 'Play';
    const frac = parseFloat(scrub.value) / SCRUB_MAX;
    const segF = frac * totalSegments();
    segIndex = clamp(Math.floor(segF), 0, totalSegments()-1);
    segProgress = clamp(segF - segIndex, 0, 1);
    render(segIndex, segProgress);
  });
  function tick(now){
    if(!playing) return;
    if(lastFrame === null) lastFrame = now;
    const dt = now - lastFrame;
    lastFrame = now;
    segProgress += dt / SEGMENT_MS;
    while(segProgress >= 1 && segIndex < totalSegments()-1){ segProgress -= 1; segIndex += 1; }
    if(segIndex >= totalSegments()-1 && segProgress >= 1){ segProgress = 1; playing = false; document.getElementById('playBtn').textContent = 'Play'; }
    render(segIndex, clamp(segProgress,0,1));
    if(playing) requestAnimationFrame(tick);
  }

  function labelFor(p){ return 'Fix #' + p.id; }
  document.getElementById('expCsv').addEventListener('click', () => {
    const rows = ['lat,lon,label,moving'];
    plottable.forEach(p => rows.push(p.lat+','+p.lon+',"'+labelFor(p)+'",'+isMovingState(p.movementState)));
    sendExport('csv', 'raahmitra_path.csv', rows.join('\\n'));
  });
  document.getElementById('expKml').addEventListener('click', () => {
    const placemarks = plottable.map(p => '<Placemark><name>Fix #'+p.id+'</name><Point><coordinates>'+p.lon+','+p.lat+',0</coordinates></Point></Placemark>').join('');
    const kml = '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>RaahMitra Path</name>'+placemarks+'</Document></kml>';
    sendExport('kml', 'raahmitra_path.kml', kml);
  });
  document.getElementById('expGeo').addEventListener('click', () => {
    const fc = { type:'FeatureCollection', features: plottable.map(p => ({ type:'Feature', geometry:{type:'Point', coordinates:[p.lon,p.lat]}, properties:{id:p.id, movementState:p.movementState} })) };
    sendExport('geojson', 'raahmitra_path.geojson', JSON.stringify(fc, null, 2));
  });
}
</script>
</body>
</html>''';
}
```

- [ ] **Step 2: Commit**

```bash
git add flutter/lib/map_animator_html.dart
git commit -m "feat(flutter): add animatorHtml WebView template"
```

---

## Task 10: Flutter — add `webview_flutter` dependency

**Files:**
- Modify: `flutter/pubspec.yaml`

- [ ] **Step 1: Add the dependency**

In `flutter/pubspec.yaml`, add to the `dependencies:` block (alongside `share_plus`):

```yaml
  webview_flutter: ^4.10.0
```

- [ ] **Step 2: Fetch packages**

Run: `cd flutter && flutter pub get`
Expected: resolves and updates `pubspec.lock`.

- [ ] **Step 3: Commit**

```bash
git add flutter/pubspec.yaml flutter/pubspec.lock
git commit -m "chore(flutter): add webview_flutter dependency"
```

---

## Task 11: Flutter — wire the map screen into `main.dart`

**Files:**
- Modify: `flutter/lib/main.dart`

- [ ] **Step 1: Add imports**

Add to the import block at the top of `flutter/lib/main.dart` (after the existing `logger.dart` import at line 17):

```dart
import 'package:webview_flutter/webview_flutter.dart';

import 'map_animator_html.dart';
import 'map_points.dart';
```

- [ ] **Step 2: Add map state to `_LoggerHomeState`**

Add alongside the existing `int _count = 0;` / `bool _running = false;` fields (lines 76-78):

```dart
  bool _showMap = false;
  WebViewController? _mapController;
```

- [ ] **Step 3: Add `_openMap`, `_refreshMap`, and the export message handler**

After `_exportLogs()` (after its closing brace, currently ending at line 176), add:

```dart
  Future<void> _refreshMap() async {
    final db = await openLogDb();
    final rows = await getAllLogs(db);
    final points = buildMapPoints(rows);
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('FlutterExport', onMessageReceived: _handleMapExport)
      ..loadHtmlString(animatorHtml(points));
    setState(() => _mapController = controller);
  }

  Future<void> _openMap() async {
    await _refreshMap();
    setState(() => _showMap = true);
  }

  Future<void> _handleMapExport(JavaScriptMessage message) async {
    try {
      final data = jsonDecode(message.message) as Map<String, dynamic>;
      final filename = data['filename'] as String;
      final content = data['content'] as String;
      final dir = await getApplicationDocumentsDirectory();
      final exportFile = File(p.join(dir.path, filename));
      await exportFile.writeAsString(content);
      await SharePlus.instance.share(ShareParams(files: [XFile(exportFile.path)]));
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Map export failed: $err')),
      );
    }
  }
```

- [ ] **Step 4: Add the "View Map" button and full-screen map view**

Replace the `build` method's `return Scaffold(...)` (lines 214-246) with:

```dart
  @override
  Widget build(BuildContext context) {
    if (_showMap) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('RaahMitra Map'),
          leading: IconButton(
            icon: const Icon(Icons.arrow_back),
            onPressed: () => setState(() => _showMap = false),
          ),
          actions: [
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: _refreshMap,
            ),
          ],
        ),
        body: _mapController == null
            ? const Center(child: CircularProgressIndicator())
            : WebViewWidget(controller: _mapController!),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('RaahMitra GPS Logger (Flutter)')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_running ? 'RUNNING' : 'STOPPED',
                style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 16),
            Text('Logs written: $_count',
                style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 32),
            ElevatedButton(
              onPressed: _running ? _stop : _start,
              child: Text(_running ? 'Stop logging' : 'Start logging'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: _openMap,
              child: const Text('View Map'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: _exportLogs,
              child: const Text('Export Logs'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: Colors.red.shade700),
              onPressed: _confirmClearLogs,
              child: const Text('Clear Logs'),
            ),
          ],
        ),
      ),
    );
  }
```

- [ ] **Step 5: Run existing Flutter test suite to confirm no regressions**

Run: `cd flutter && flutter test`
Expected: PASS — all existing suites plus `map_points_test.dart` green. (No test exists for `main.dart` before or after this change — same disclosed exemption as today.)

- [ ] **Step 6: Commit**

```bash
git add flutter/lib/main.dart
git commit -m "feat(flutter): wire in-app map screen into main.dart"
```

---

## Task 12: Flutter — manual on-device verification

No automated test — UI-glue layer, same exemption as `main.dart` generally.

- [ ] **Step 1: Trigger a new Codemagic build** (required — `webview_flutter` is a native-backed plugin the current APK doesn't have)

Push to the `gpscodeflutter` repo per the existing Codemagic trigger for this project.

- [ ] **Step 2: Install the new build, log a short walk (or reuse existing DB rows), tap "View Map"**

Verify the same checklist as Task 6, Step 2, on the Flutter build.

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-08-19-in-app-map-screen-design.md` is covered — snapshot+refresh (Tasks 5, 11), export via share sheet (Tasks 5, 11), `buildMapPoints` pure/tested (Tasks 1-2, 7-8, extended per the "Supersedes" note above), WebView HTML/JS reuse with data templated inline before load (Tasks 3, 9), new dependencies flagged as requiring a rebuild (Tasks 4, 10, 6, 12), error handling for <2 points (Tasks 3, 9), out-of-scope items untouched (no live updates, no offline tiles, no nav library, no multi-device view).
- **Type consistency checked:** `buildMapPoints`/`buildMapPoints` return shape (`id, t, lat, lon, effAcc, accuracy, movementState, method, batteryPct, appState, signalDbm, signalLevel, carrier, networkType, locationQuality, isLowAcc, isSpike, isSpeedOutlier, excluded, gapBefore, runIndex, idx`) matches what `animatorHtml` consumes in both platforms (`movementState`, `effAcc`, `gapBefore`, `runIndex`, `excluded`, `isSpike`, `isSpeedOutlier`, `isLowAcc`, `id`, `accuracy`, `lat`, `lon`, `t`) — same field names used consistently across `mapPoints.js` → `mapAnimatorHtml.js` and `map_points.dart` → `map_animator_html.dart`.
- **No placeholders:** every step has complete, runnable code — no TBD/TODO left in any task.
