const test = require('node:test');
const assert = require('node:assert/strict');
const {
  groupBySegment, toValhallaShape, buildTraceAttributesRequest,
  confidenceFromMatchedPoints, decodePolyline6, mostCommonWayId, traceAttributesToSegment,
} = require('../transform');

// Test-only mirror of decodePolyline6's algorithm, used solely to produce known-good encoded
// strings to feed back into the real decoder — this checks the shift/zigzag bit math is invertible,
// which is the actual risk in a hand-written polyline codec, without needing a live Valhalla
// response to compare against.
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

test('groupBySegment splits a flat point list by segmentId, preserving order', () => {
  const groups = groupBySegment([
    { segmentId: 0, latitude: 1 }, { segmentId: 0, latitude: 2 },
    { segmentId: 1, latitude: 3 }, { segmentId: 0, latitude: 4 },
  ]);
  assert.deepEqual([...groups.keys()], [0, 1]);
  assert.equal(groups.get(0).length, 3);
  assert.equal(groups.get(1).length, 1);
});

test('groupBySegment defaults missing segmentId to 0', () => {
  const groups = groupBySegment([{ latitude: 1 }, { latitude: 2 }]);
  assert.deepEqual([...groups.keys()], [0]);
  assert.equal(groups.get(0).length, 2);
});

test('toValhallaShape re-zeroes time relative to the first point of the segment', () => {
  const shape = toValhallaShape([
    { latitude: 31.1, longitude: 77.1, timestamp: 1000000 },
    { latitude: 31.1001, longitude: 77.1001, timestamp: 1005000 },
    { latitude: 31.1002, longitude: 77.1002, timestamp: 1012500 },
  ]);
  assert.deepEqual(shape.map((p) => p.time), [0, 5, 13]);
  assert.equal(shape[0].lat, 31.1);
  assert.equal(shape[0].lon, 77.1);
});

test('buildTraceAttributesRequest uses pedestrian costing and map_snap (never edge_walk)', () => {
  const request = buildTraceAttributesRequest([
    { latitude: 31.1, longitude: 77.1, timestamp: 0 },
    { latitude: 31.1001, longitude: 77.1001, timestamp: 5000 },
  ]);
  assert.equal(request.costing, 'pedestrian');
  assert.equal(request.shape_match, 'map_snap');
  assert.equal(request.shape.length, 2);
});

test('confidenceFromMatchedPoints: tight snapping is HIGH', () => {
  const confidence = confidenceFromMatchedPoints([
    { type: 'matched', distance_from_trace_point: 1.2 },
    { type: 'matched', distance_from_trace_point: 2.8 },
  ]);
  assert.equal(confidence, 'HIGH');
});

test('confidenceFromMatchedPoints: loose snapping is MEDIUM, far snapping is LOW', () => {
  assert.equal(confidenceFromMatchedPoints([{ type: 'matched', distance_from_trace_point: 10 }]), 'MEDIUM');
  assert.equal(confidenceFromMatchedPoints([{ type: 'matched', distance_from_trace_point: 40 }]), 'LOW');
});

test('confidenceFromMatchedPoints: no matched points at all is UNMATCHED', () => {
  assert.equal(confidenceFromMatchedPoints([{ type: 'unmatched', distance_from_trace_point: null }]), 'UNMATCHED');
  assert.equal(confidenceFromMatchedPoints([]), 'UNMATCHED');
  assert.equal(confidenceFromMatchedPoints(undefined), 'UNMATCHED');
});

test('decodePolyline6 round-trips through encodePolyline6 within float rounding', () => {
  const original = [
    { latitude: 31.104812, longitude: 77.173401 },
    { latitude: 31.105920, longitude: 77.174118 },
    { latitude: 31.106733, longitude: 77.174900 },
  ];
  const decoded = decodePolyline6(encodePolyline6(original));
  assert.equal(decoded.length, original.length);
  decoded.forEach((point, i) => {
    assert.ok(Math.abs(point.latitude - original[i].latitude) < 1e-5, `latitude[${i}] drifted`);
    assert.ok(Math.abs(point.longitude - original[i].longitude) < 1e-5, `longitude[${i}] drifted`);
  });
});

test('decodePolyline6 handles an empty/missing shape', () => {
  assert.deepEqual(decodePolyline6(''), []);
  assert.deepEqual(decodePolyline6(undefined), []);
});

test('mostCommonWayId picks the way with the most edges, ignoring a short connector', () => {
  const wayId = mostCommonWayId([
    { way_id: 100 }, { way_id: 100 }, { way_id: 100 }, { way_id: 'connector-1' }, { way_id: 100 },
  ]);
  assert.equal(wayId, '100');
});

test('mostCommonWayId returns null with no edges', () => {
  assert.equal(mostCommonWayId([]), null);
  assert.equal(mostCommonWayId(undefined), null);
});

test('traceAttributesToSegment assembles the full app-facing segment shape', () => {
  const encoded = encodePolyline6([
    { latitude: 31.104812, longitude: 77.173401 },
    { latitude: 31.105920, longitude: 77.174118 },
  ]);
  const segment = traceAttributesToSegment(2, {
    shape: encoded,
    matched_points: [
      { type: 'matched', distance_from_trace_point: 1.5 },
      { type: 'matched', distance_from_trace_point: 2.1 },
    ],
    edges: [{ way_id: 555 }, { way_id: 555 }],
  });
  assert.equal(segment.segmentId, 2);
  assert.equal(segment.confidence, 'HIGH');
  assert.equal(segment.matchedWayId, '555');
  assert.equal(segment.coordinates.length, 2);
});
