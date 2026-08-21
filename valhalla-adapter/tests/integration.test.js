// Proves this adapter's output is actually consumable by the real client code in
// ../../react-native/routeMatching.js, not just shaped to match MAP_MATCHING.md by assumption.
// No live Valhalla server involved — this feeds a synthetic (but realistic) trace_attributes
// response through the adapter's transform, then through the client's own normalizeMatchedSegments
// and resolveSegment, and checks the client ends up trusting the matched geometry.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { groupBySegment, traceAttributesToSegment } = require('../transform');
const { normalizeMatchedSegments, resolveSegment } = require(
  path.join('..', '..', 'react-native', 'routeMatching.js'),
);

function encodePolyline6(points) {
  const factor = 1e6;
  let prevLat = 0;
  let prevLon = 0;
  let out = '';
  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    chunk += String.fromCharCode(v + 63);
    return chunk;
  };
  for (const point of points) {
    const lat = Math.round(point.latitude * factor);
    const lon = Math.round(point.longitude * factor);
    out += encodeValue(lat - prevLat) + encodeValue(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

test('adapter output round-trips through the real client normalizeMatchedSegments + resolveSegment', () => {
  // Simulate the request body routeMatching.js actually sends (post the segmentId fix).
  const requestPoints = [
    { latitude: 31.09710670849519, longitude: 77.15215087447483, timestamp: 0, segmentId: 2 },
    { latitude: 31.097141162470027, longitude: 77.15212260216055, timestamp: 5861, segmentId: 2 },
    { latitude: 31.097185045711747, longitude: 77.15209156925518, timestamp: 10865, segmentId: 2 },
  ];

  const grouped = groupBySegment(requestPoints);
  const [segmentId, points] = [...grouped.entries()][0];
  const valhallaResponse = {
    shape: encodePolyline6(points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))),
    matched_points: points.map(() => ({ type: 'matched', distance_from_trace_point: 2 })),
    edges: [{ way_id: 42 }, { way_id: 42 }],
  };
  const adapterSegment = traceAttributesToSegment(segmentId, valhallaResponse);

  // This is exactly what server.js sends back over HTTP.
  const wireResponse = { segments: [adapterSegment] };
  const normalized = normalizeMatchedSegments(wireResponse);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].confidence, 'HIGH');
  assert.equal(normalized[0].coordinates.length, 3);

  const fallbackSegment = {
    segmentId,
    segmentType: 'RAW_GPS',
    coordinates: points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    rawFixIds: [10, 11, 12],
  };
  const resolved = resolveSegment(normalized[0], fallbackSegment);
  assert.equal(resolved.segmentType, 'MAP_MATCHED');
  assert.equal(resolved.matchedWayId, '42');
});

test('a segment the adapter could not match at all still resolves to safe GPS fallback', () => {
  const points = [
    { latitude: 31.1, longitude: 77.1, timestamp: 0, segmentId: 0 },
  ];
  const grouped = groupBySegment(points);
  const [segmentId, segPoints] = [...grouped.entries()][0];
  // Fewer than 2 points: adapter's own server.js short-circuits before calling Valhalla at all.
  const adapterSegment = { segmentId, confidence: 'UNMATCHED', coordinates: [], matchedWayId: null };
  const normalized = normalizeMatchedSegments({ segments: [adapterSegment] });
  // normalizeMatchedSegments drops segments with <2 coordinates (can't be a line) — confirms the
  // client safely ignores this rather than erroring on it.
  assert.equal(normalized.length, 0);

  const fallbackSegment = {
    segmentId,
    segmentType: 'RAW_GPS',
    coordinates: segPoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    rawFixIds: [1],
  };
  const resolved = resolveSegment(null, fallbackSegment);
  assert.equal(resolved.segmentType, 'RAW_GPS');
  assert.deepEqual(resolved.coordinates, fallbackSegment.coordinates);
});
