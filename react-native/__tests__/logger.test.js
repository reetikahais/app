import { computeSignalGap } from '../logger';

describe('computeSignalGap', () => {
  test('no prior heartbeat returns null', () => {
    expect(computeSignalGap(null, Date.now(), 120000)).toBeNull();
  });

  test('gap under threshold returns null', () => {
    const last = 1000000;
    const now = last + 60000; // 1 min gap, threshold 2 min
    expect(computeSignalGap(String(last), now, 120000)).toBeNull();
  });

  test('gap over threshold returns event details', () => {
    const last = 1000000;
    const now = last + 300000; // 5 min gap, threshold 2 min
    const result = computeSignalGap(String(last), now, 120000);
    expect(result).toEqual({
      gap_started_at: new Date(last).toISOString(),
      gap_ended_at: new Date(now).toISOString(),
      duration_ms: 300000,
    });
  });

  test('gap exactly at threshold returns null', () => {
    const last = 1000000;
    const now = last + 120000; // exactly 2 min, threshold 2 min
    expect(computeSignalGap(String(last), now, 120000)).toBeNull();
  });
});
