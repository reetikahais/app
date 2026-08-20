import { buildMapPoints, ACCURACY_THRESHOLD_M, MAX_GAP_SECONDS, MAX_SPEED_KMH } from '../mapPoints';

function row(overrides) {
  return {
    id: 1,
    timestamp: '2026-08-19T08:49:15.964Z',
    latitude: 31.0964199,
    longitude: 77.1524214,
    accuracy: 14,
    battery: 80,
    app_state: 'foreground',
    method: 'fused',
    movement_state: 'STATIONARY',
    location_quality: 90,
    ...overrides,
  };
}

describe('buildMapPoints', () => {
  test('empty input returns empty array', () => {
    expect(buildMapPoints([])).toEqual([]);
  });

  test('rows with no usable position or timestamp are dropped', () => {
    const rows = [
      row({ id: 1, latitude: null, longitude: null }),
      row({ id: 2, timestamp: null }),
      row({ id: 3 }),
    ];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([3]);
  });

  test('falls back to processed_latitude/longitude when raw is missing', () => {
    const rows = [
      row({ id: 1, latitude: null, longitude: null, processed_latitude: 31.1, processed_longitude: 77.2 }),
    ];
    const points = buildMapPoints(rows);
    expect(points).toHaveLength(1);
    expect(points[0].lat).toBe(31.1);
    expect(points[0].lon).toBe(77.2);
  });

  test('sorts by timestamp ascending regardless of input order', () => {
    const rows = [
      row({ id: 2, timestamp: '2026-08-19T08:50:00.000Z' }),
      row({ id: 1, timestamp: '2026-08-19T08:49:00.000Z' }),
    ];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([1, 2]);
  });

  test('drops a second row identical in timestamp+lat+lon (redelivery dedup)', () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([1]);
  });

  test('keeps two rows with the same timestamp if position differs', () => {
    const rows = [row({ id: 1 }), row({ id: 2, latitude: 31.2 })];
    const points = buildMapPoints(rows);
    expect(points.map((p) => p.id)).toEqual([1, 2]);
  });

  test('flags accuracy worse than ACCURACY_THRESHOLD_M as isLowAcc, excluded from path', () => {
    const rows = [row({ id: 1, accuracy: ACCURACY_THRESHOLD_M + 1 })];
    const points = buildMapPoints(rows);
    expect(points[0].isLowAcc).toBe(true);
    expect(points[0].excluded).toBe(true);
  });

  test('accuracy at threshold is not flagged', () => {
    const rows = [row({ id: 1, accuracy: ACCURACY_THRESHOLD_M })];
    const points = buildMapPoints(rows);
    expect(points[0].isLowAcc).toBe(false);
    expect(points[0].excluded).toBe(false);
  });

  test('flags an isolated out-and-back spike, not its well-behaved neighbors', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:49:15.964Z', latitude: 31.0964199, longitude: 77.1524214, accuracy: 14 }),
      row({ id: 2, timestamp: '2026-08-19T08:52:30.967Z', latitude: 31.0921669, longitude: 77.1349605, accuracy: 46 }),
      row({ id: 3, timestamp: '2026-08-19T08:53:05.131Z', latitude: 31.0967622, longitude: 77.1529471, accuracy: 46 }),
    ];
    const points = buildMapPoints(rows);
    expect(points.find((p) => p.id === 2).isSpike).toBe(true);
    expect(points.find((p) => p.id === 1).isSpike).toBeFalsy();
    expect(points.find((p) => p.id === 3).isSpike).toBeFalsy();
  });

  test('flags an unrealistic-speed jump at the array edge (no reunion neighbor)', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:49:00.000Z', latitude: 31.0, longitude: 77.0, accuracy: 10 }),
      // ~11km in 10s => far above MAX_SPEED_KMH, and it's the LAST point so markSpikes can't see it.
      row({ id: 2, timestamp: '2026-08-19T08:49:10.000Z', latitude: 31.1, longitude: 77.0, accuracy: 10 }),
    ];
    const points = buildMapPoints(rows);
    expect(points[1].isSpeedOutlier).toBe(true);
    expect(points[1].excluded).toBe(true);
  });

  test('flags gapBefore when two kept fixes are more than MAX_GAP_SECONDS apart, only on non-excluded points', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:00:00.000Z' }),
      row({ id: 2, timestamp: new Date(new Date('2026-08-19T08:00:00.000Z').getTime() + (MAX_GAP_SECONDS + 1) * 1000).toISOString() }),
    ];
    const points = buildMapPoints(rows);
    expect(points[0].gapBefore).toBeFalsy();
    expect(points[1].gapBefore).toBe(true);
    expect(points[1].runIndex).toBe(1);
  });

  test('does not flag gapBefore when the gap is under MAX_GAP_SECONDS', () => {
    const rows = [
      row({ id: 1, timestamp: '2026-08-19T08:00:00.000Z' }),
      row({ id: 2, timestamp: new Date(new Date('2026-08-19T08:00:00.000Z').getTime() + (MAX_GAP_SECONDS - 1) * 1000).toISOString() }),
    ];
    const points = buildMapPoints(rows);
    expect(points[1].gapBefore).toBe(false);
    expect(points[1].runIndex).toBe(0);
  });

  test('output carries movement/telemetry fields through unchanged', () => {
    const rows = [row({ id: 1, movement_state: 'MOVING', signal_dbm: -70, carrier: 'Jio', network_type: 'LTE', signal_level: 3, battery: 55, app_state: 'background', location_quality: 80 })];
    const points = buildMapPoints(rows);
    expect(points[0]).toMatchObject({
      id: 1,
      movementState: 'MOVING',
      signalDbm: -70,
      carrier: 'Jio',
      networkType: 'LTE',
      signalLevel: 3,
      batteryPct: 55,
      appState: 'background',
      locationQuality: 80,
    });
  });
});
