// Explicit extension so the file also loads under plain Node ESM (tests); Metro resolves it too.
import { splitByConfidence } from './routeSplit.js';

function escapeForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// `segments` draw the static background route (matched geometry follows the road network and is
// not required to be one point per GPS fix). `points` are the time-ordered per-fix positions used
// to drive the play animation — display-only interpolation, never persisted as GPS history.
// Section 27 debug marker colors: recovery confirmed = green, high-speed continuity accept = blue,
// hard outlier = red, effective-profile switch = purple.
const MARKER_COLORS_BY_REASON = Object.freeze({
  RECOVERY_CONFIRMED: '#2f8f4e',
  HIGH_SPEED_CONTINUITY_ACCEPT: '#1769aa',
  HARD_OUTLIER: '#c0392b',
  PROFILE_ESCALATED: '#7b3fa0',
  PROFILE_DOWNGRADED: '#7b3fa0',
});

// `markers` are individually-notable fixes (recovery confirmations, high-speed accepts, hard
// outliers) drawn as small static color-coded dots alongside the animated route.
export function buildAnimatedMapHtml(segments, points, title = 'RaahMitra walking route', markers = []) {
  // Low-confidence stretches become their own lines (drawn dashed and faded) instead of being merged
  // into the solid route. GAP segments are still not drawn as solid route, but a low-confidence run
  // inside one (e.g. recovery-confirmed fixes after a signal gap) is drawn, so it isn't lost.
  const lines = segments
    .flatMap((segment) => splitByConfidence(segment.coordinates)
      .filter((run) => run.coordinates.length > 1 && (segment.segmentType !== 'GAP' || run.lowConfidence))
      .map((run) => ({
        routeType: segment.segmentType,
        coordinates: run.coordinates.map((point) => [point.latitude, point.longitude]),
        lowConfidence: run.lowConfidence,
      })));
  const animation = points
    .filter((point) => point.latitude != null && point.longitude != null)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((point) => ({
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      timestamp: Number(point.timestamp ?? 0),
      routeType: point.routeType || 'RAW_GPS',
    }));
  const markerPoints = (markers || [])
    .filter((marker) => marker.latitude != null && marker.longitude != null)
    .map((marker) => ({
      latitude: Number(marker.latitude),
      longitude: Number(marker.longitude),
      reason: marker.reason || 'HARD_OUTLIER',
    }));

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0}#controls{position:absolute;z-index:1000;top:12px;left:12px;background:white;padding:8px;border-radius:4px;font:14px sans-serif;box-shadow:0 1px 5px #777}button{padding:6px 12px}</style></head>
<body><div id="map"></div><div id="controls"><button id="play">Play route</button><span id="time"></span></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const lines=${escapeForScript(lines)};const points=${escapeForScript(animation)};const markers=${escapeForScript(markerPoints)};
const markerColors=${escapeForScript(MARKER_COLORS_BY_REASON)};const map=L.map('map');
const streetLayer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const satelliteLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Esri, Maxar, Earthstar Geographics'});
L.control.layers({'Street':streetLayer,'Satellite':satelliteLayer}).addTo(map);
const bounds=[];lines.forEach(line=>{line.coordinates.forEach(c=>bounds.push(c));L.polyline(line.coordinates,{color:line.routeType==='MAP_MATCHED'?'#2f8f4e':'#d39b22',weight:5,opacity:line.lowConfidence?.4:.85,dashArray:line.lowConfidence?'2 8':null}).addTo(map);});
markers.forEach(m=>{L.circleMarker([m.latitude,m.longitude],{radius:5,color:markerColors[m.reason]||'#c0392b',fillColor:markerColors[m.reason]||'#c0392b',fillOpacity:.9,weight:1}).addTo(map).bindPopup(m.reason);});
if(!bounds.length)points.forEach(p=>bounds.push([p.latitude,p.longitude]));
if(bounds.length){map.fitBounds(bounds,{padding:[24,24]});L.marker(bounds[0]).addTo(map).bindPopup('Start');L.marker(bounds[bounds.length-1]).addTo(map).bindPopup('End');}
let marker=null,index=0,timer=null;document.getElementById('play').onclick=()=>{if(!points.length)return;clearTimeout(timer);index=0;
if(!marker)marker=L.circleMarker([points[0].latitude,points[0].longitude],{radius:7,color:'#d1495b',fillColor:'#d1495b',fillOpacity:1}).addTo(map);
const step=()=>{if(index>=points.length)return;const p=points[index];marker.setLatLng([p.latitude,p.longitude]);document.getElementById('time').textContent=' '+new Date(p.timestamp).toLocaleString();const next=points[index+1];const delay=next?Math.max(150,Math.min(1200,next.timestamp-p.timestamp)):0;index++;if(next)timer=setTimeout(step,delay);};step();};
</script></body></html>`;
}
