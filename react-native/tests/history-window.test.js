const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { processLocations } = require('../processing');
const { selectHistoryWindow, rebaseSegmentIds, chooseSegmentAnchor } = require('../taskHelpers');
const { HISTORY_WINDOW_MIN_FIXES, HISTORY_WINDOW_MS } = require('../trackingConfig');

// The background task does not reprocess the whole session on every delivery, only a window of the
// most recent fixes (HISTORY_WINDOW_MIN_FIXES or HISTORY_WINDOW_MS, whichever holds more). These
// tests replay sessions delivery by delivery exactly the way the task does, once with the full
// session as history and once with the window, and require identical results per fix.

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const WINDOW = { minFixes: HISTORY_WINDOW_MIN_FIXES, windowMs: HISTORY_WINDOW_MS };
const batchKey = (row) => row.batch_id ?? `single-${row.id}`;
const byTime = (a, b) => a.fix_timestamp_ms - b.fix_timestamp_ms || (a.id ?? 0) - (b.id ?? 0);

function loadFixture(file) {
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
  if (Array.isArray(data)) {
    return { mode: 'walk', rows: data.map((row, i) => ({ batch_id: `fixture-${i}`, batch_index: 0, ...row })) };
  }
  return { mode: data.tracking_mode || 'walk', rows: data.raw_locations };
}

function groupIntoDeliveries(rows) {
  const deliveries = [];
  const index = new Map();
  for (const row of rows) {
    const key = batchKey(row);
    if (!index.has(key)) { index.set(key, deliveries.length); deliveries.push([]); }
    deliveries[index.get(key)].push(row);
  }
  return deliveries;
}

// Mirrors locationTask.js: history = rows delivered earlier; processed rows for the new batch are
// stored and never recomputed. `window` null = full history. With a window, segment ids are
// re-based on the stored segment_id of the newest history row (db.getSegmentIdForRawFix in the task).
function replayDeliveries(rows, mode, window) {
  const delivered = [];
  const stored = new Map();
  const out = [];
  for (const delivery of groupIntoDeliveries(rows)) {
    const incoming = [...delivery].sort((a, b) => byTime(a, b) || a.batch_index - b.batch_index);
    const sortedHistory = [...delivered].sort(byTime);
    const history = window ? selectHistoryWindow(sortedHistory, incoming[0].fix_timestamp_ms, window) : sortedHistory;
    const key = batchKey(incoming[0]);
    const results = processLocations([...history, ...incoming], { mode, nowMs: incoming[0].received_timestamp_ms });
    let processed = results.filter((row) => batchKey(row) === key);
    if (window && history.length) {
      const lastHistory = history[history.length - 1];
      processed = rebaseSegmentIds(processed, results, lastHistory.id, stored.get(lastHistory.id));
    }
    processed.forEach((row) => stored.set(row.id, row.segment_id));
    out.push(...processed);
    delivered.push(...incoming);
  }
  return out;
}
const FIELDS = ['trajectory_decision', 'trajectory_reason', 'is_route_point', 'segment_id', 'effective_mode'];
function differences(full, windowed) {
  assert.equal(windowed.length, full.length, 'same number of processed rows');
  const diffs = [];
  full.forEach((row, i) => {
    for (const field of FIELDS) {
      if (row[field] !== windowed[i][field]) {
        diffs.push({ id: row.id, field, full: row[field], window: windowed[i][field] });
      }
    }
  });
  return diffs;
}

// Long deterministic sessions so the 300-fix / 15-minute boundary is really exercised (the real
// fixtures are only 23-26 fixes, which fit inside any window).
function tile(rows, times, spacingMs) {
  const out = [];
  for (let t = 0; t < times; t += 1) {
    for (const row of rows) {
      out.push({
        ...row, id: row.id + t * 1000, batch_id: `${batchKey(row)}-t${t}`,
        fix_timestamp_ms: row.fix_timestamp_ms + t * spacingMs,
        received_timestamp_ms: row.received_timestamp_ms + t * spacingMs,
      });
    }
  }
  return out;
}

// 1 fix/s, 10 fixes per delivery. Straight ride at 6 m/s, a 2-minute signal gap, then more riding.
// Walk is selected, so the adaptive mode escalates mid-ride.
function syntheticRide() {
  const t0 = 1790000000000;
  const metersToDegrees = (m) => m / 111320;
  const rows = [];
  let id = 1;
  let timestamp = t0;
  let latitude = 31.0;
  const push = () => {
    rows.push({
      id, batch_id: `ride-${Math.floor((id - 1) / 10)}`, batch_index: (id - 1) % 10,
      fix_timestamp_ms: timestamp, received_timestamp_ms: timestamp + 200,
      latitude, longitude: 77.0, horizontal_accuracy_m: 10, speed_mps: 6, bearing_deg: 0, speed_accuracy_mps: 1,
    });
    id += 1;
  };
  for (let i = 0; i < 600; i += 1) { push(); timestamp += 1000; latitude += metersToDegrees(6); }
  timestamp += 120000; latitude += metersToDegrees(6 * 120);
  for (let i = 0; i < 700; i += 1) { push(); timestamp += 1000; latitude += metersToDegrees(6); }
  return rows;
}

test('history window constants: last 300 fixes or 15 minutes', () => {
  assert.equal(HISTORY_WINDOW_MIN_FIXES, 300);
  assert.equal(HISTORY_WINDOW_MS, 15 * 60 * 1000);
});

test('selectHistoryWindow keeps the larger of the last N fixes and the last T milliseconds', () => {
  const history = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, fix_timestamp_ms: i * 1000 }));
  const now = 500 * 1000;
  // Sparse in time: 500 fixes over 500 s fit in 15 min, so the time window holds all 500 (> 300).
  assert.equal(selectHistoryWindow(history, now, WINDOW).length, 500);
  // Short time window: the count (300) is larger.
  assert.equal(selectHistoryWindow(history, now, { minFixes: 300, windowMs: 60 * 1000 }).length, 300);
  assert.equal(selectHistoryWindow(history, now, { minFixes: 300, windowMs: 60 * 1000 })[0].id, 201);
  // Fewer fixes than the minimum: everything.
  assert.equal(selectHistoryWindow(history.slice(0, 40), now, { minFixes: 300, windowMs: 1000 }).length, 40);
  assert.deepEqual(selectHistoryWindow([], now, WINDOW), []);
});

for (const file of fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json'))) {
  test(`window vs full history: identical results for fixture ${file}`, (t) => {
    const { mode, rows } = loadFixture(file);
    const full = replayDeliveries(rows, mode, null);
    assert.deepEqual(differences(full, replayDeliveries(rows, mode, WINDOW)), []);
    // Informational: the smallest window that still reproduces decisions and route points.
    for (let minFixes = 1; minFixes <= rows.length; minFixes += 1) {
      const small = replayDeliveries(rows, mode, { minFixes, windowMs: 0 });
      if (differences(full, small).filter((d) => d.field !== 'segment_id').length === 0) {
        t.diagnostic(`${file}: ${rows.length} fixes, window of ${minFixes} fix(es) already matches`);
        break;
      }
    }
  });
}

test('window vs full history: identical on long sessions that cross the 300-fix / 15-minute boundary', (t) => {
  const hill = loadFixture('hill-motorbike-2026-09-22.json');
  const isbt = loadFixture('newIsbtShimla-stationary-session.json');
  const cases = [
    ['hill fixture x25 (575 fixes, 7 min apart)', 'motorbike', tile(hill.rows, 25, 7 * 60000)],
    ['ISBT fixture x20 (520 fixes, 3 min apart)', 'walk', tile(isbt.rows, 20, 3 * 60000)],
    ['synthetic ride, walk selected (1300 fixes, 1 Hz, with a 2 min gap)', 'walk', syntheticRide()],
  ];
  for (const [name, mode, rows] of cases) {
    const full = replayDeliveries(rows, mode, null);
    const windowed = replayDeliveries(rows, mode, WINDOW);
    const diffs = differences(full, windowed);
    t.diagnostic(`${name}: ${diffs.length} difference(s) across ${FIELDS.join(', ')}`);
    assert.deepEqual(diffs.slice(0, 5), [], name);
  }
});

test('rebaseSegmentIds continues the stored segment id instead of restarting at 0', () => {
  // Windowed run: history row 7 sits in relative segment 0; two incoming rows after a new break are 1.
  const results = [
    { id: 7, segment_id: 0 }, { id: undefined, batch_id: 'b', segment_id: 0 }, { id: undefined, batch_id: 'b', segment_id: 1 },
  ];
  const incoming = results.slice(1);
  assert.deepEqual(rebaseSegmentIds(incoming, results, 7, 12).map((row) => row.segment_id), [12, 13]);
  // No history (first delivery) or an anchor that isn't in the results: rows are returned unchanged.
  assert.equal(rebaseSegmentIds(incoming, results, null, 0), incoming);
  assert.equal(rebaseSegmentIds(incoming, results, 99, 12), incoming);
  // Missing stored id counts as 0.
  assert.deepEqual(rebaseSegmentIds(incoming, results, 7, undefined).map((row) => row.segment_id), [0, 1]);
});
test('chooseSegmentAnchor: the newest history row when it has a stored segment id (including 0)', () => {
  const lastHistory = { id: 9 };
  assert.deepEqual(chooseSegmentAnchor(lastHistory, 4, { raw_fix_id: 3, segment_id: 2 }), { id: 9, segmentId: 4 });
  assert.deepEqual(chooseSegmentAnchor(lastHistory, 0, null), { id: 9, segmentId: 0 });
});

test('chooseSegmentAnchor: falls back to the newest processed row when the newest history row has none', () => {
  assert.deepEqual(chooseSegmentAnchor({ id: 9 }, null, { raw_fix_id: 7, segment_id: 3 }), { id: 7, segmentId: 3 });
  assert.deepEqual(chooseSegmentAnchor({ id: 9 }, undefined, { raw_fix_id: 7, segment_id: 0 }), { id: 7, segmentId: 0 });
});

test('chooseSegmentAnchor: no processed row anywhere means no anchor (skip re-basing)', () => {
  assert.equal(chooseSegmentAnchor({ id: 9 }, null, null), null);
  assert.equal(chooseSegmentAnchor({ id: 9 }, null, undefined), null);
  assert.equal(chooseSegmentAnchor({ id: 9 }, null, { raw_fix_id: null, segment_id: null }), null);
  assert.equal(chooseSegmentAnchor(null, null, null), null);
});

test('fallback anchor re-bases correctly: older processed row as anchor, rows after it keep their breaks', () => {
  // Windowed run: row 7 (older history, stored segment 3) is relative 0; row 9 (newest history,
  // never processed) and the new rows sit after one break (relative 1) and another (relative 2).
  const results = [
    { id: 7, segment_id: 0 }, { id: 9, segment_id: 1 },
    { batch_id: 'b', segment_id: 1 }, { batch_id: 'b', segment_id: 2 },
  ];
  const incoming = results.slice(2);
  const anchor = chooseSegmentAnchor({ id: 9 }, null, { raw_fix_id: 7, segment_id: 3 });
  assert.deepEqual(rebaseSegmentIds(incoming, results, anchor.id, anchor.segmentId).map((row) => row.segment_id), [4, 5]);
  // No anchor: rows are left exactly as the windowed run numbered them.
  const none = chooseSegmentAnchor({ id: 9 }, null, null);
  assert.equal(none === null ? incoming : rebaseSegmentIds(incoming, results, none.id, none.segmentId), incoming);
  // Fallback row outside the window (not in the results): rebase is skipped, never throws.
  const outside = chooseSegmentAnchor({ id: 9 }, null, { raw_fix_id: 1, segment_id: 3 });
  assert.equal(rebaseSegmentIds(incoming, results, outside.id, outside.segmentId), incoming);
});