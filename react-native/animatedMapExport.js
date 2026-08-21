function escapeForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// `segments` draw the static background route (matched geometry follows the road network and is
// not required to be one point per GPS fix). `points` are the time-ordered per-fix positions used
// to drive the play animation — display-only interpolation, never persisted as GPS history.
export function buildAnimatedMapHtml(segments, points, title = 'RaahMitra walking route') {
  const lines = segments
    .filter((segment) => segment.segmentType !== 'GAP' && segment.coordinates.length > 1)
    .map((segment) => ({
      routeType: segment.segmentType,
      coordinates: segment.coordinates.map((point) => [point.latitude, point.longitude]),
    }));
  const animation = points
    .filter((point) => point.latitude != null && point.longitude != null)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((point) => ({
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      timestamp: Number(point.timestamp ?? 0),
      routeType: point.routeType || 'RAW_GPS',
    }));

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0}#controls{position:absolute;z-index:1000;top:12px;left:12px;background:white;padding:8px;border-radius:4px;font:14px sans-serif;box-shadow:0 1px 5px #777}button{padding:6px 12px}</style></head>
<body><div id="map"></div><div id="controls"><button id="play">Play route</button><span id="time"></span></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const lines=${escapeForScript(lines)};const points=${escapeForScript(animation)};const map=L.map('map');
const streetLayer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
const satelliteLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Esri, Maxar, Earthstar Geographics'});
L.control.layers({'Street':streetLayer,'Satellite':satelliteLayer}).addTo(map);
const bounds=[];lines.forEach(line=>{line.coordinates.forEach(c=>bounds.push(c));L.polyline(line.coordinates,{color:line.routeType==='MAP_MATCHED'?'#2f8f4e':'#d39b22',weight:5,opacity:.85}).addTo(map);});
if(!bounds.length)points.forEach(p=>bounds.push([p.latitude,p.longitude]));
if(bounds.length){map.fitBounds(bounds,{padding:[24,24]});L.marker(bounds[0]).addTo(map).bindPopup('Start');L.marker(bounds[bounds.length-1]).addTo(map).bindPopup('End');}
let marker=null,index=0,timer=null;document.getElementById('play').onclick=()=>{if(!points.length)return;clearTimeout(timer);index=0;
if(!marker)marker=L.circleMarker([points[0].latitude,points[0].longitude],{radius:7,color:'#d1495b',fillColor:'#d1495b',fillOpacity:1}).addTo(map);
const step=()=>{if(index>=points.length)return;const p=points[index];marker.setLatLng([p.latitude,p.longitude]);document.getElementById('time').textContent=' '+new Date(p.timestamp).toLocaleString();const next=points[index+1];const delay=next?Math.max(150,Math.min(1200,next.timestamp-p.timestamp)):0;index++;if(next)timer=setTimeout(step,delay);};step();};
</script></body></html>`;
}
