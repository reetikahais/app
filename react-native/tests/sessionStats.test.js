const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSessionStats, computeElevation } = require('../sessionStats');

const base = 1700000000000;

function acceptedRow(id, t, lat, lon, altitude) {
  return {
    raw_fix_id: id, fix_timestamp_ms: base + t, latitude: lat, longitude: lon,
    filtered_latitude: lat, filtered_longitude: lon, altitude_m: altitude,
    trajectory_decision: 'ACCEPTED', is_route_point: 1,
  };
}

function rawRow(id, t, lat, lon, accuracy, altitude) {
  return { id, fix_timestamp_ms: base + t, latitude: lat, longitude: lon, horizontal_accuracy_m: accuracy, altitude_m: altitude };
}

test('computeSessionStats reports counts, duration and distance from resolved segments', () => {
  const rawRows = [
    rawRow(1, 0, 28.6, 77.2, 10, 1500),
    rawRow(2, 10000, 28.6005, 77.2005, 12, 1502),
    rawRow(3, 20000, 28.601, 77.201, 11, 1505),
  ];
  const processedRows = [
    { raw_fix_id: 1, trajectory_decision: 'ACCEPTED', is_route_point: 1 },
    { raw_fix_id: 2, trajectory_decision: 'UNCERTAIN', is_route_point: 0 },
    { raw_fix_id: 3, trajectory_decision: 'ACCEPTED', is_route_point: 1 },
  ];
  const segments = [{ segmentType: 'RAW_GPS', coordinates: [{ latitude: 28.6, longitude: 77.2 }, { latitude: 28.601, longitude: 77.201 }] }];
  const stats = computeSessionStats({ rawRows, processedRows, segments });
  assert.equal(stats.rawPointCount, 3);
  assert.equal(stats.acceptedPointCount, 2);
  assert.equal(stats.uncertainPointCount, 1);
  assert.equal(stats.outlierPointCount, 0);
  assert.equal(stats.durationMs, 20000);
  assert.ok(stats.totalDistanceM > 100);
  assert.ok(stats.averageAccuracyM > 0);
});

test('elevation gain/loss rejects an implausible single-fix vertical spike', () => {
  const rows = [
    acceptedRow(1, 0, 28.6, 77.2, 1500),
    acceptedRow(2, 5000, 28.6001, 77.2001, 1503),
    acceptedRow(3, 10000, 28.6002, 77.2002, 1700),
    acceptedRow(4, 15000, 28.6003, 77.2003, 1506),
  ];
  const { elevationGainM } = computeElevation(rows);
  assert.ok(elevationGainM < 20, `expected the 1503->1700->1506 spike to be rejected, got gain=${elevationGainM}`);
});

test('elevation is unavailable when no altitude data was recorded', () => {
  const rows = [acceptedRow(1, 0, 28.6, 77.2, null), acceptedRow(2, 5000, 28.6001, 77.2001, null)];
  const { elevationGainM, elevationLossM } = computeElevation(rows);
  assert.equal(elevationGainM, null);
  assert.equal(elevationLossM, null);
});
