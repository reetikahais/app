import 'dart:convert';

import 'map_points.dart';

// Templates buildMapPoints() output into the same self-contained HTML page as
// react-native/mapAnimatorHtml.js - keep the two in sync manually (no shared build step between
// the platforms). Adapted from tools/gps-path-animator.html: same map/animation/legend UI and
// red/green movement coloring. Deliberately dropped for this compact embedded view: the
// paste-JSON/file-picker load panel (points arrive already computed), the right-hand Live
// Telemetry readout panel, and the Fix Log list with click-to-seek - none of those fit a small
// WebView pane. Export buttons postMessage to native instead of Blob+<a download>, which is
// unreliable in a mobile WebView (RN and Flutter each supply a different message bridge - see the
// sendExport() shim at the bottom of the generated script).

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
  final pointsJson = jsonEncode(points.map(_pointToJson).toList()).replaceAll('<', '\\u003c');

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

const plottable = points.filter(p => !p.excluded);

if(points.length < 2 || plottable.length === 0){
  document.getElementById('emptyState').style.display = 'flex';
} else {
  const t0 = points[0].t, tN = points[points.length-1].t, totalSpanMs = Math.max(tN - t0, 1);
  const map = L.map('map', {zoomControl:true, attributionControl:true});
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:22, maxNativeZoom:19, attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics'
  }).addTo(map);
  L.control.scale({metric:true, imperial:false, position:'bottomright'}).addTo(map);

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
