const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTraceWindows, stitchWindowResults } = require('../traceBuffer');

function points(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i, latitude: 31 + i * 0.0001, longitude: 77 }));
}

test('buildTraceWindows returns a single window when the trip is already short', () => {
  const windows = buildTraceWindows(points(10), { windowSize: 15, overlapSize: 5 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].length, 10);
});

test('buildTraceWindows splits a long trip into overlapping windows covering every point', () => {
  const windows = buildTraceWindows(points(40), { windowSize: 15, overlapSize: 5 });
  assert.ok(windows.length > 1);
  // Every window respects the configured size cap.
  assert.ok(windows.every((w) => w.length <= 15));
  // Consecutive windows overlap by the configured amount.
  assert.equal(windows[1][0].id, windows[0][windows[0].length - 1 - (5 - 1)].id);
  // The final point of the trip is covered by the last window.
  assert.equal(windows[windows.length - 1].at(-1).id, 39);
});

test('buildTraceWindows handles an empty input', () => {
  assert.deepEqual(buildTraceWindows([]), []);
});

test('stitchWindowResults concatenates windows in order and drops an exact-duplicate seam', () => {
  const result = stitchWindowResults([
    { confidence: 'HIGH', coordinates: [{ latitude: 31, longitude: 77 }, { latitude: 31.001, longitude: 77 }], matchedWayId: 'way/1' },
    { confidence: 'HIGH', coordinates: [{ latitude: 31.001, longitude: 77 }, { latitude: 31.002, longitude: 77 }], matchedWayId: 'way/1' },
  ]);
  assert.equal(result.coordinates.length, 3, 'the shared seam coordinate should not be duplicated');
  assert.equal(result.matchedWayId, 'way/1');
});

test('stitchWindowResults skips a window that failed to match rather than discarding the whole trip', () => {
  const result = stitchWindowResults([
    { confidence: 'HIGH', coordinates: [{ latitude: 31, longitude: 77 }], matchedWayId: 'way/1' },
    null,
    { confidence: 'HIGH', coordinates: [{ latitude: 31.002, longitude: 77 }], matchedWayId: 'way/1' },
  ]);
  assert.equal(result.coordinates.length, 2);
});

test('stitchWindowResults reports the worst confidence across all windows, not the best', () => {
  const result = stitchWindowResults([
    { confidence: 'HIGH', coordinates: [{ latitude: 31, longitude: 77 }], matchedWayId: 'way/1' },
    { confidence: 'LOW', coordinates: [{ latitude: 31.001, longitude: 77 }], matchedWayId: 'way/1' },
  ]);
  assert.equal(result.confidence, 'LOW');
});

test('stitchWindowResults returns null when every window failed', () => {
  assert.equal(stitchWindowResults([null, undefined]), null);
});
