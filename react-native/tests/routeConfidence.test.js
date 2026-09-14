const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoadState, updateRoadState, splitCommittedTentative } = require('../routeConfidence');

test('a fresh road state locks onto the first candidate immediately', () => {
  const state = updateRoadState(createRoadState(), { matchedWayId: 'way/1', confidence: 'HIGH' });
  assert.equal(state.matchedWayId, 'way/1');
  assert.equal(state.consecutiveMatches, 1);
});

test('repeated observations of the same road accumulate consecutiveMatches', () => {
  let state = createRoadState();
  for (let i = 0; i < 3; i += 1) state = updateRoadState(state, { matchedWayId: 'way/1', confidence: 'HIGH' });
  assert.equal(state.consecutiveMatches, 3);
});

test('a single closer-but-different candidate does not switch the locked road', () => {
  let state = updateRoadState(createRoadState(), { matchedWayId: 'way/1', confidence: 'HIGH' });
  state = updateRoadState(state, { matchedWayId: 'way/2', confidence: 'HIGH', headingCompatible: true });
  assert.equal(state.matchedWayId, 'way/1', 'must not switch off a single competing observation');
  assert.equal(state.pendingCandidate.matchedWayId, 'way/2');
});

test('switches only after roadSwitchConfirmationCount consecutive matches of the new road', () => {
  let state = updateRoadState(createRoadState(), { matchedWayId: 'way/1', confidence: 'HIGH' });
  for (let i = 0; i < 2; i += 1) {
    state = updateRoadState(state, { matchedWayId: 'way/2', confidence: 'HIGH', headingCompatible: true }, { roadSwitchConfirmationCount: 3 });
    assert.equal(state.matchedWayId, 'way/1', 'still locked before the confirmation threshold is reached');
  }
  state = updateRoadState(state, { matchedWayId: 'way/2', confidence: 'HIGH', headingCompatible: true }, { roadSwitchConfirmationCount: 3 });
  assert.equal(state.matchedWayId, 'way/2', 'switches once enough consecutive corroboration accumulates');
});

test('an alternating parallel-road candidate never accumulates enough streak to switch', () => {
  let state = updateRoadState(createRoadState(), { matchedWayId: 'way/1', confidence: 'HIGH' });
  for (let i = 0; i < 6; i += 1) {
    const candidateWay = i % 2 === 0 ? 'way/2' : 'way/3';
    state = updateRoadState(state, { matchedWayId: candidateWay, confidence: 'HIGH', headingCompatible: true }, { roadSwitchConfirmationCount: 3 });
  }
  assert.equal(state.matchedWayId, 'way/1', 'flip-flopping candidates must never individually reach the confirmation streak');
});

test('a heading-incompatible candidate never counts toward a switch', () => {
  let state = updateRoadState(createRoadState(), { matchedWayId: 'way/1', confidence: 'HIGH' });
  for (let i = 0; i < 5; i += 1) {
    state = updateRoadState(state, { matchedWayId: 'way/2', confidence: 'HIGH', headingCompatible: false }, { roadSwitchConfirmationCount: 3 });
  }
  assert.equal(state.matchedWayId, 'way/1');
});

test('splitCommittedTentative keeps everything tentative until the road-lock is confident enough', () => {
  const coordinates = Array.from({ length: 20 }, (_, i) => ({ latitude: 31 + i * 0.0001, longitude: 77 }));
  const freshState = { matchedWayId: 'way/1', confidence: 'LOW', consecutiveMatches: 1 };
  const result = splitCommittedTentative(coordinates, freshState);
  assert.equal(result.committedCoordinates.length, 0);
  assert.equal(result.tentativeCoordinates.length, 20);
});

test('splitCommittedTentative commits everything except the trailing lag once confident', () => {
  const coordinates = Array.from({ length: 20 }, (_, i) => ({ latitude: 31 + i * 0.0001, longitude: 77 }));
  const confidentState = { matchedWayId: 'way/1', confidence: 'HIGH', consecutiveMatches: 5 };
  const result = splitCommittedTentative(coordinates, confidentState, { committedLagPoints: 6 });
  assert.equal(result.committedCoordinates.length, 14);
  assert.equal(result.tentativeCoordinates.length, 6);
  assert.deepEqual([...result.committedCoordinates, ...result.tentativeCoordinates], coordinates);
});

test('splitCommittedTentative never commits a segment shorter than the lag window', () => {
  const coordinates = Array.from({ length: 4 }, (_, i) => ({ latitude: 31 + i * 0.0001, longitude: 77 }));
  const confidentState = { matchedWayId: 'way/1', confidence: 'HIGH', consecutiveMatches: 5 };
  const result = splitCommittedTentative(coordinates, confidentState, { committedLagPoints: 6 });
  assert.equal(result.committedCoordinates.length, 0);
  assert.equal(result.tentativeCoordinates.length, 4);
});
