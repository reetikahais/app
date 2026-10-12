const test = require('node:test');
const assert = require('node:assert/strict');
const { processLocations } = require('../processing');
const { buildGpsRouteSegments, resolveSegment } = require('../routeMatching');
const { splitByConfidence, segmentsToRouteJson } = require('../routeSplit');
const { buildAnimatedMapHtml } = require('../animatedMapExport');
const fixture = require('./fixtures/hill-motorbike-2026-09-22.json');

const point = (n, lowConfidence) => (lowConfidence ? { latitude: n, longitude: n, lowConfidence: true } : { latitude: n, longitude: n });

test('splitByConfidence returns the input untouched when nothing is low confidence', () => {
  const coordinates = [point(1), point(2), point(3)];
  const runs = splitByConfidence(coordinates);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].coordinates, coordinates);
  assert.equal(runs[0].lowConfidence, false);
  assert.deepEqual(splitByConfidence([point(1, true)]), [{ coordinates: [point(1, true)], lowConfidence: false }]);
  assert.deepEqual(splitByConfidence(undefined), [{ coordinates: [], lowConfidence: false }]);
});

test('splitByConfidence puts low-confidence stretches in their own run, connected to the solid route', () => {
  const runs = splitByConfidence([point(1), point(2), point(3, true), point(4, true), point(5), point(6)]);
  assert.deepEqual(runs.map((run) => [run.lowConfidence, run.coordinates.map((p) => p.latitude)]), [
    [false, [1, 2]],
    [true, [2, 3, 4]],     // the lines INTO the low points; starts on the last solid point
    [false, [4, 5, 6]],
  ]);
});

test('splitByConfidence: a leading or whole-route low run is still drawn', () => {
  assert.deepEqual(splitByConfidence([point(1), point(2, true), point(3, true)]).map((r) => r.lowConfidence), [true]);
  assert.deepEqual(splitByConfidence([point(1), point(2, true), point(3)]).map((r) => r.lowConfidence), [true, false]);
});

// --- the real hill ride ---
const nowMs = fixture.raw_locations[fixture.raw_locations.length - 1].received_timestamp_ms;
const rows = processLocations(fixture.raw_locations, { mode: 'motorbike', nowMs });
const RECOVERY_IDS = [449, 450, 451];

test('hill fixture: recovery-confirmed rows 449-451 pass the animated export filter (is_route_point && ACCEPTED)', () => {
  const exported = rows.filter((row) => row.is_route_point && row.trajectory_decision === 'ACCEPTED');
  for (const id of RECOVERY_IDS) {
    const row = rows.find((r) => r.raw_fix_id === id);
    assert.equal(row.trajectory_decision, 'ACCEPTED', `raw id ${id}`);
    assert.equal(row.is_route_point, 1, `raw id ${id}`);
    assert.ok(exported.includes(row), `raw id ${id} is exported`);
  }
});

test('hill fixture: only the recovery-confirmed rows are tagged low confidence on the route', (t) => {
  const segments = buildGpsRouteSegments(rows);
  const routeRows = rows.filter((row) => row.is_route_point && row.trajectory_decision === 'ACCEPTED');
  const lowIds = routeRows.filter((row) => row.position_confidence === 'LOW').map((row) => row.raw_fix_id);
  t.diagnostic(`route points: ${routeRows.length}; position_confidence LOW: ${lowIds.join(', ') || 'none'}`);
  assert.deepEqual(lowIds, RECOVERY_IDS);
  const flagged = segments.flatMap((segment) => segment.coordinates).filter((c) => c.lowConfidence);
  assert.equal(flagged.length, RECOVERY_IDS.length);
  // Coordinates that are not low confidence keep their exact {latitude, longitude} shape.
  const plain = segments.flatMap((segment) => segment.coordinates).find((c) => !c.lowConfidence);
  assert.deepEqual(Object.keys(plain).sort(), ['latitude', 'longitude']);
});

test('live map JSON: recovery stretch is a separate lowConfidence entry, the rest stays solid', () => {
  const segments = buildGpsRouteSegments(rows).map((segment) => resolveSegment(null, segment));
  const entries = JSON.parse(segmentsToRouteJson(segments));
  const low = entries.filter((entry) => entry.lowConfidence);
  const solid = entries.filter((entry) => !entry.lowConfidence);
  assert.ok(low.length >= 1);
  assert.ok(solid.length >= 1);
  assert.ok(low.every((entry) => entry.coordinates.length >= 2));
  // Raw ids 449 and 450 are drawn in the low-confidence entry; no solid entry contains them.
  const latOf = (id) => rows.find((r) => r.raw_fix_id === id).filtered_latitude;
  const lows = low.flatMap((entry) => entry.coordinates.map((c) => c[0]));
  const solids = solid.flatMap((entry) => entry.coordinates.map((c) => c[0]));
  for (const id of [449, 450]) {
    assert.ok(lows.includes(latOf(id)), `raw id ${id} drawn in a low-confidence entry`);
    assert.ok(!solids.includes(latOf(id)), `raw id ${id} not merged into the solid route`);
  }
});

test('animated export: low-confidence stretch is its own dashed, faded line', () => {
  const segments = buildGpsRouteSegments(rows).map((segment) => resolveSegment(null, segment));
  const html = buildAnimatedMapHtml(segments, [], 'RaahMitra Bike route', []);
  const lines = JSON.parse(html.match(/const lines=(\[.*?\]);const points=/s)[1]);
  assert.ok(lines.some((line) => line.lowConfidence === true && line.coordinates.length >= 2));
  assert.ok(lines.some((line) => line.lowConfidence === false));
  assert.match(html, /opacity:line\.lowConfidence\?\.4:\.85/);
  assert.match(html, /dashArray:line\.lowConfidence\?'2 8':null/);
  assert.match(html, /<title>RaahMitra Bike route<\/title>/);
});

// --- which rows count as low confidence for drawing ---
const routeRow = (n, extra = {}) => ({
  is_route_point: 1, trajectory_decision: 'ACCEPTED', trajectory_reason: 'PLAUSIBLE_TRAJECTORY',
  segment_id: 0, fix_timestamp_ms: 1000 * n, latitude: 31 + n / 1000, longitude: 77, filtered_latitude: 31 + n / 1000,
  filtered_longitude: 77, horizontal_accuracy_m: 10, tracking_mode: 'motorbike', ...extra,
});
const lowFlags = (rowsIn) => buildGpsRouteSegments(rowsIn).flatMap((s) => s.coordinates).map((c) => Boolean(c.lowConfidence));

test('a late-delivered fix with good accuracy draws as a normal solid line', () => {
  const late = { position_confidence: 'LOW', processing_status: 'HISTORICAL_ACCEPTED', fix_age_ms: 60000 };
  assert.deepEqual(lowFlags([routeRow(1), routeRow(2, late), routeRow(3, late), routeRow(4)]), [false, false, false, false]);
  const entries = JSON.parse(segmentsToRouteJson(buildGpsRouteSegments([routeRow(1), routeRow(2, late), routeRow(3, late)])));
  assert.deepEqual(entries.map((e) => e.lowConfidence), [false]);
});

test('RECOVERY_CONFIRMED, or accuracy worse than the mode ceiling, draws low confidence', () => {
  assert.deepEqual(lowFlags([routeRow(1), routeRow(2, { trajectory_reason: 'RECOVERY_CONFIRMED' }), routeRow(3)]), [false, true, false]);
  // motorbike ceiling is 40 m, walk 30 m, car 50 m
  assert.deepEqual(lowFlags([routeRow(1), routeRow(2, { horizontal_accuracy_m: 45 })]), [false, true]);
  assert.deepEqual(lowFlags([routeRow(1), routeRow(2, { horizontal_accuracy_m: 40 })]), [false, false]);
  assert.deepEqual(lowFlags([routeRow(1, { tracking_mode: 'walk' }), routeRow(2, { tracking_mode: 'walk', horizontal_accuracy_m: 35 })]), [false, true]);
  assert.deepEqual(lowFlags([routeRow(1, { tracking_mode: 'car' }), routeRow(2, { tracking_mode: 'car', horizontal_accuracy_m: 45 })]), [false, false]);
  // effective_mode wins over the selected mode; accuracy falls back to the normalized `accuracy` field
  assert.deepEqual(lowFlags([routeRow(1), routeRow(2, { effective_mode: 'car', horizontal_accuracy_m: undefined, accuracy: 45 })]), [false, false]);
});

test('position_confidence alone no longer decides it: LOW with good accuracy stays solid, MEDIUM recovery is dashed', () => {
  assert.deepEqual(lowFlags([routeRow(1, { position_confidence: 'LOW' })]), [false]);
  assert.deepEqual(lowFlags([routeRow(1), routeRow(2, { position_confidence: 'MEDIUM', trajectory_reason: 'RECOVERY_CONFIRMED' })]), [false, true]);
});