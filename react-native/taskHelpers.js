// Pure helpers shared by the background location task and the SQLite layer. Kept free of any React
// Native / Expo imports so they can be unit tested under plain Node (see tests/task-helpers.test.js).

// null, undefined, '' and whitespace-only strings are "missing", not zero: Number(null) and
// Number('') are both 0, which used to store a missing accuracy/speed/heading as a real 0.
function nullable(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function rowKey(row) {
  return `${row.batch_id}:${row.batch_index}`;
}

// Pairs each raw row with the processed row that came from the same fix, by (batch_id, batch_index)
// rather than by array position. processLocations() re-sorts and may not return exactly one row per
// input, so index pairing could attach one fix's processed result to another fix's raw row.
function pairRawWithProcessed(rawRows, processedRows) {
  const processedByKey = new Map();
  for (const processed of processedRows || []) {
    if (processed && processed.batch_id != null && processed.batch_index != null) {
      processedByKey.set(rowKey(processed), processed);
    }
  }
  const pairs = (rawRows || []).map((raw) => ({
    raw,
    processed: raw.batch_id != null && raw.batch_index != null ? (processedByKey.get(rowKey(raw)) ?? null) : null,
  }));
  return { pairs, unpairedRawCount: pairs.filter((pair) => !pair.processed).length };
}

// Promise-chain mutex: tasks run strictly one at a time, in call order. A task that throws rejects
// only its own caller; it never poisons the chain for the next one.
function createMutex() {
  let tail = Promise.resolve();
  return function runExclusive(fn) {
    const run = tail.then(fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

// The history the background task feeds back into processLocations: the larger of the last
// `minFixes` fixes and every fix within `windowMs` before the first incoming fix. `history` must be
// ordered by fix_timestamp_ms. db.getRecentRawLocations does the same selection in SQL.
function selectHistoryWindow(history, firstIncomingFixMs, { minFixes, windowMs }) {
  const withinTime = history.filter((row) => row.fix_timestamp_ms >= firstIncomingFixMs - windowMs);
  return withinTime.length >= minFixes ? withinTime : history.slice(-minFixes);
}

// processLocations numbers segments from 0 within whatever it was given, so a windowed run restarts
// at 0 and would merge unrelated segments of the session on the map. New rows are re-based instead:
// stored segment id of the newest history row + how many segment breaks the windowed run counted
// AFTER that row. (Anchoring on the window's first row is not safe: it can be a rejected fix whose
// gap increment the windowed run never sees.) `results` is the full windowed processLocations output
// (history + incoming), `lastHistoryId` the id of the newest history row, `storedLastSegmentId` the
// segment_id saved for it earlier.
function rebaseSegmentIds(processedRows, results, lastHistoryId, storedLastSegmentId) {
  if (lastHistoryId == null) return processedRows;
  const anchor = results.find((row) => row.id === lastHistoryId);
  if (!anchor) return processedRows;
  const delta = (Number(storedLastSegmentId) || 0) - anchor.segment_id;
  return processedRows.map((row) => ({ ...row, segment_id: row.segment_id + delta }));
}

// Which already-processed row to anchor segment re-basing on. Normally the newest history row. If
// that row has no processed row (its stored segment id is null), fall back to the newest processed
// row of the session; with neither, null means "skip re-basing".
function chooseSegmentAnchor(lastHistory, storedLastSegmentId, newestProcessed) {
  if (lastHistory && storedLastSegmentId != null) return { id: lastHistory.id, segmentId: storedLastSegmentId };
  if (newestProcessed && newestProcessed.raw_fix_id != null && newestProcessed.segment_id != null) {
    return { id: newestProcessed.raw_fix_id, segmentId: newestProcessed.segment_id };
  }
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    nullable, pairRawWithProcessed, createMutex, selectHistoryWindow, rebaseSegmentIds, chooseSegmentAnchor,
  };
}
