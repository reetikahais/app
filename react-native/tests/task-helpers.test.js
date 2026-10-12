const test = require('node:test');
const assert = require('node:assert/strict');
const { nullable, pairRawWithProcessed, createMutex } = require('../taskHelpers');
const { decideProfileRequest, createSessionId, getTrackingProfile } = require('../trackingConfig');

test('nullable: null, undefined and empty strings are missing, not zero', () => {
  assert.equal(nullable(null), null);
  assert.equal(nullable(undefined), null);
  assert.equal(nullable(''), null);
  assert.equal(nullable('   '), null);
  assert.equal(nullable(NaN), null);
  assert.equal(nullable('abc'), null);
  assert.equal(nullable(Infinity), null);
});

test('nullable: real numbers (including a genuine 0) pass through', () => {
  assert.equal(nullable(0), 0);
  assert.equal(nullable('0'), 0);
  assert.equal(nullable(-1.5), -1.5);
  assert.equal(nullable('12.5'), 12.5);
  assert.equal(nullable(1790063758706), 1790063758706);
});

const raw = (batchIndex, extra = {}) => ({ batch_id: 'batch-1', batch_index: batchIndex, latitude: batchIndex, ...extra });
const processed = (batchIndex, extra = {}) => ({ batch_id: 'batch-1', batch_index: batchIndex, filtered_latitude: batchIndex * 10, ...extra });

test('pairRawWithProcessed pairs by (batch_id, batch_index), not by array position', () => {
  const rawRows = [raw(0), raw(1), raw(2)];
  const processedRows = [processed(2), processed(0), processed(1)]; // shuffled
  const { pairs, unpairedRawCount } = pairRawWithProcessed(rawRows, processedRows);
  assert.equal(unpairedRawCount, 0);
  assert.deepEqual(pairs.map((p) => [p.raw.batch_index, p.processed.batch_index]), [[0, 0], [1, 1], [2, 2]]);
});

test('pairRawWithProcessed: a raw row without a processed row is kept and counted', () => {
  // Index pairing would have attached processed(2) to raw(1) here.
  const { pairs, unpairedRawCount } = pairRawWithProcessed([raw(0), raw(1), raw(2)], [processed(0), processed(2)]);
  assert.equal(unpairedRawCount, 1);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[1].raw.batch_index, 1);
  assert.equal(pairs[1].processed, null);
  assert.equal(pairs[2].processed.batch_index, 2);
});

test('pairRawWithProcessed never matches across batches or on missing keys', () => {
  const { pairs, unpairedRawCount } = pairRawWithProcessed(
    [raw(0), { batch_id: null, batch_index: null }],
    [processed(0, { batch_id: 'other-batch' }), { batch_id: null, batch_index: null }],
  );
  assert.equal(unpairedRawCount, 2);
  assert.ok(pairs.every((p) => p.processed === null));
  assert.deepEqual(pairRawWithProcessed(undefined, undefined), { pairs: [], unpairedRawCount: 0 });
});

test('createMutex runs overlapping tasks strictly one at a time, in call order', async () => {
  const runExclusive = createMutex();
  const log = [];
  let running = 0;
  let maxRunning = 0;
  const task = (name, ms) => runExclusive(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    log.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(`end:${name}`);
    running -= 1;
    return name;
  });
  const results = await Promise.all([task('a', 30), task('b', 5), task('c', 1)]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('createMutex: a failing task rejects only its own caller and does not block the next', async () => {
  const runExclusive = createMutex();
  const failing = runExclusive(async () => { throw new Error('boom'); });
  const next = runExclusive(async () => 'still runs');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'still runs');
});

test('createSessionId produces a fresh id each call', () => {
  const a = createSessionId();
  const b = createSessionId();
  assert.match(a, /^session-\d+-[a-z0-9]+$/);
  assert.notEqual(a, b);
});

// --- polling-profile request (the task only requests; the app applies it from the foreground) ---

function fixesWithAccuracy(accuracies) {
  return accuracies.map((accuracy, index) => ({ fix_timestamp_ms: 1000 * (index + 1), horizontal_accuracy_m: accuracy }));
}

test('decideProfileRequest requests LIVE_SAFETY after sustained poor accuracy and flags it for applying', () => {
  const limit = getTrackingProfile('motorbike').maxAcceptableAccuracyMeters;
  const decision = decideProfileRequest('motorbike', 'MOVING_NORMAL', 'MOVING_NORMAL', fixesWithAccuracy([limit + 60, limit + 70, limit + 80]));
  assert.deepEqual(decision, { requestedProfile: 'LIVE_SAFETY', changed: true, needsApply: true });
});

test('decideProfileRequest: an already-requested profile is not re-requested, but stays pending until applied', () => {
  const limit = getTrackingProfile('motorbike').maxAcceptableAccuracyMeters;
  const poor = fixesWithAccuracy([limit + 60, limit + 70, limit + 80]);
  const decision = decideProfileRequest('motorbike', 'MOVING_NORMAL', 'LIVE_SAFETY', poor);
  assert.deepEqual(decision, { requestedProfile: 'LIVE_SAFETY', changed: false, needsApply: true });
});

test('decideProfileRequest: hysteresis is judged against the requested profile and de-escalates on recovery', () => {
  const { preferredAccuracyMeters, maxAcceptableAccuracyMeters } = getTrackingProfile('motorbike');
  // Active profile is still MOVING_NORMAL (not yet applied), but the latest request was LIVE_SAFETY.
  const recovered = fixesWithAccuracy([maxAcceptableAccuracyMeters + 50, maxAcceptableAccuracyMeters + 50, preferredAccuracyMeters - 1]);
  const decision = decideProfileRequest('motorbike', 'MOVING_NORMAL', 'LIVE_SAFETY', recovered);
  assert.deepEqual(decision, { requestedProfile: 'MOVING_NORMAL', changed: true, needsApply: false });
});

test('decideProfileRequest falls back to the active profile when nothing was requested yet', () => {
  const decision = decideProfileRequest('motorbike', 'MOVING_NORMAL', null, fixesWithAccuracy([10, 10]));
  assert.deepEqual(decision, { requestedProfile: 'MOVING_NORMAL', changed: false, needsApply: false });
});
