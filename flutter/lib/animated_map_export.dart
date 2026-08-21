import 'dart:convert';

String buildAnimatedMapHtml(List<Map<String, Object?>> rows) {
  final points = rows
      .where((row) => row['latitude'] != null && row['longitude'] != null)
      .map((row) => {
            'latitude': row['latitude'],
            'longitude': row['longitude'],
            'timestamp': row['timestamp'],
            'segment': 0,
          })
      .toList();
  final encoded = jsonEncode(points).replaceAll('<', r'\u003c');
  return '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RaahMitra walking route</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0}#controls{position:absolute;z-index:1000;top:12px;left:12px;background:white;padding:8px;border-radius:4px;font:14px sans-serif;box-shadow:0 1px 5px #777}button{padding:6px 12px}</style></head>
<body><div id="map"></div><div id="controls"><button id="play">Play route</button><span id="time"></span></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const points=$encoded;const map=L.map('map');L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);const valid=points.map(p=>[p.latitude,p.longitude]);if(valid.length){map.fitBounds(valid,{padding:[24,24]});L.marker(valid[0]).addTo(map).bindPopup('Start');if(valid.length>1)L.marker(valid[valid.length-1]).addTo(map).bindPopup('End');}L.polyline(valid,{color:'#1769aa',weight:5,opacity:.72}).addTo(map);let marker=null,index=0;document.getElementById('play').onclick=()=>{if(!points.length)return;index=0;marker??=L.circleMarker(valid[0],{radius:7,color:'#d1495b',fillColor:'#d1495b',fillOpacity:1}).addTo(map);const step=()=>{if(index>=points.length)return;marker.setLatLng(valid[index]);document.getElementById('time').textContent=' '+points[index].timestamp;index++;setTimeout(step,500)};step();};
</script></body></html>''';
}