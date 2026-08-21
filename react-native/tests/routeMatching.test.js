const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGpsRouteSegments, classifyConfidence, resolveSegment, matchWalkingSequence,
} = require('../routeMatching');

function row({ id, segmentId, lat, lon, t, continuity = 'CONTINUOUS' }) {
  return {
    raw_fix_id: id, segment_id: segmentId, is_route_point: 1, trajectory_decision: 'ACCEPTED',
    continuity_decision: continuity, latitude: lat, longitude: lon, filtered_latitude: lat,
    filtered_longitude: lon, fix_timestamp_ms: t,
  };
}

test('fallback route keeps accepted segments separate across a gap', () => {
  const segments = buildGpsRouteSegments([
    { segment_id: 0, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'CONTINUOUS', latitude: 31.1, longitude: 77.1 },
    { segment_id: 0, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'CONTINUOUS', latitude: 31.1001, longitude: 77.1001 },
    { segment_id: 1, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'GAP', latitude: 31.101, longitude: 77.101 },
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].segmentType, 'RAW_GPS');
  // The lone point in segment 1 is itself the gap-landing fix; that flag describes the jump into
  // the segment, not its (so far nonexistent) internal continuity, so it must not be excluded
  // from rendering merely for starting right after a gap.
  assert.equal(segments[1].segmentType, 'RAW_GPS');
});

test('walking resumes normally after a gap: only the landing fix carries GAP, the rest is RAW_GPS', () => {
  const segments = buildGpsRouteSegments([
    { segment_id: 0, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'CONTINUOUS', latitude: 31.1, longitude: 77.1 },
    { segment_id: 1, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'GAP', latitude: 31.101, longitude: 77.101 },
    { segment_id: 1, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'CONTINUOUS', latitude: 31.1011, longitude: 77.1011 },
    { segment_id: 1, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'CONTINUOUS', latitude: 31.1012, longitude: 77.1012 },
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[1].segmentType, 'RAW_GPS');
  assert.equal(segments[1].coordinates.length, 3);
});

test('a genuine internal dropout (GAP after the segment already has a fix) still downgrades the segment', () => {
  const segments = buildGpsRouteSegments([
    { segment_id: 0, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'CONTINUOUS', latitude: 31.1, longitude: 77.1 },
    { segment_id: 0, is_route_point: 1, trajectory_decision: 'ACCEPTED', continuity_decision: 'GAP', latitude: 31.1001, longitude: 77.1001 },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].segmentType, 'GAP');
});

test('unresolved uncertain and outlier fixes never enter fallback route', () => {
  const segments = buildGpsRouteSegments([
    { segment_id: 0, is_route_point: 1, trajectory_decision: 'ACCEPTED', latitude: 31.1, longitude: 77.1 },
    { segment_id: 0, is_route_point: 0, trajectory_decision: 'UNCERTAIN', latitude: 31.2, longitude: 77.2 },
    { segment_id: 0, is_route_point: 0, trajectory_decision: 'OUTLIER', latitude: 31.3, longitude: 77.3 },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].coordinates.length, 1);
});

test('classifyConfidence normalizes both numeric scores and tier strings', () => {
  assert.equal(classifyConfidence(0.9), 'HIGH');
  assert.equal(classifyConfidence(0.5), 'MEDIUM');
  assert.equal(classifyConfidence(0.1), 'LOW');
  assert.equal(classifyConfidence('high'), 'HIGH');
  assert.equal(classifyConfidence(undefined), 'UNMATCHED');
});

test('HIGH confidence uses mapped geometry (curved road case)', () => {
  const fallback = { segmentId: 0, segmentType: 'RAW_GPS', coordinates: [{ latitude: 31.1, longitude: 77.1 }], rawFixIds: [1] };
  const matched = { segmentId: 0, confidence: 'HIGH', coordinates: [{ latitude: 31.1, longitude: 77.1 }, { latitude: 31.1005, longitude: 77.1005 }], matchedWayId: 'way/1' };
  const resolved = resolveSegment(matched, fallback);
  assert.equal(resolved.segmentType, 'MAP_MATCHED');
  assert.equal(resolved.coordinates.length, 2);
  assert.equal(resolved.matchedWayId, 'way/1');
});

test('never forces a nearby road: LOW confidence keeps validated GPS even though a matched line exists', () => {
  const fallback = { segmentId: 0, segmentType: 'RAW_GPS', coordinates: [{ latitude: 31.1, longitude: 77.1 }], rawFixIds: [1] };
  const matched = { segmentId: 0, confidence: 'LOW', coordinates: [{ latitude: 31.2, longitude: 77.2 }, { latitude: 31.2005, longitude: 77.2005 }], matchedWayId: 'nearby-wrong-road' };
  const resolved = resolveSegment(matched, fallback);
  assert.equal(resolved.segmentType, 'RAW_GPS');
  assert.deepEqual(resolved.coordinates, fallback.coordinates);
});

test('MEDIUM confidence is used only when GPS continuity is not a GAP (ambiguity check)', () => {
  const continuousFallback = { segmentId: 0, segmentType: 'RAW_GPS', coordinates: [{ latitude: 31.1, longitude: 77.1 }], rawFixIds: [1] };
  const gapFallback = { segmentId: 1, segmentType: 'GAP', coordinates: [{ latitude: 31.1, longitude: 77.1 }], rawFixIds: [1] };
  const matched = { segmentId: 0, confidence: 'MEDIUM', coordinates: [{ latitude: 31.1, longitude: 77.1 }, { latitude: 31.1002, longitude: 77.1002 }], matchedWayId: 'way/2' };
  assert.equal(resolveSegment(matched, continuousFallback).segmentType, 'MAP_MATCHED');
  assert.equal(resolveSegment({ ...matched, segmentId: 1 }, gapFallback).segmentType, 'GAP');
});

test('UNMATCHED falls back to processed GPS', () => {
  const fallback = { segmentId: 0, segmentType: 'RAW_GPS', coordinates: [{ latitude: 31.1, longitude: 77.1 }], rawFixIds: [1] };
  assert.equal(resolveSegment(null, fallback).segmentType, 'RAW_GPS');
});

test('matcher unavailable (network failure) still returns a usable fallback route', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const rows = [row({ id: 1, segmentId: 0, lat: 31.1, lon: 77.1, t: 0 }), row({ id: 2, segmentId: 0, lat: 31.1001, lon: 77.1001, t: 5000 })];
    const segments = await matchWalkingSequence(rows, { endpoint: 'https://matcher.example/trace' });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].segmentType, 'RAW_GPS');
  } finally {
    global.fetch = originalFetch;
  }
});

test('hybrid route: HIGH, LOW, HIGH confidence segments render as MAP_MATCHED, RAW_GPS, MAP_MATCHED', async () => {
  const originalFetch = global.fetch;
  const rows = [
    row({ id: 1, segmentId: 0, lat: 31.1, lon: 77.1, t: 0 }),
    row({ id: 2, segmentId: 0, lat: 31.1005, lon: 77.1005, t: 5000 }),
    row({ id: 3, segmentId: 1, lat: 31.2, lon: 77.2, t: 100000 }),
    row({ id: 4, segmentId: 1, lat: 31.2005, lon: 77.2005, t: 105000 }),
    row({ id: 5, segmentId: 2, lat: 31.3, lon: 77.3, t: 200000 }),
    row({ id: 6, segmentId: 2, lat: 31.3005, lon: 77.3005, t: 205000 }),
  ];
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      segments: [
        { segmentId: 0, confidence: 'HIGH', coordinates: [[77.1, 31.1], [77.1005, 31.1005]], matchedWayId: 'way/a' },
        { segmentId: 1, confidence: 'LOW', coordinates: [[77.2, 31.2], [77.2005, 31.2005]], matchedWayId: 'way/wrong' },
        { segmentId: 2, confidence: 'HIGH', coordinates: [[77.3, 31.3], [77.3005, 31.3005]], matchedWayId: 'way/c' },
      ],
    }),
  });
  try {
    const segments = await matchWalkingSequence(rows, { endpoint: 'https://matcher.example/trace' });
    assert.deepEqual(segments.map((s) => s.segmentType), ['MAP_MATCHED', 'RAW_GPS', 'MAP_MATCHED']);
  } finally {
    global.fetch = originalFetch;
  }
});
