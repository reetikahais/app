// Road-switch protection and tentative/committed route splitting (sections 17-21, 48). Layered on
// top of routeMatching.js's existing per-fix resolveSegment() — this module doesn't replace that
// GPS-vs-matched-geometry decision, it adds a second layer of caution specifically about which ROAD
// a matched segment is allowed to claim, so a closer-but-wrong candidate on a parallel mountain road
// can't flip the displayed route from one noisy observation.

function createRoadState() {
  return { matchedWayId: null, confidence: 'UNMATCHED', consecutiveMatches: 0, pendingCandidate: null };
}

// candidate: { matchedWayId, confidence, headingCompatible } for the segment's latest matched
// geometry. A different way only takes over after `roadSwitchConfirmationCount` consecutive,
// heading-compatible observations of the SAME new candidate — one closer point is evidence, not
// proof; several in a row, all agreeing, is proof (section 19).
function updateRoadState(state, candidate, { roadSwitchConfirmationCount = 3 } = {}) {
  const current = state || createRoadState();
  if (!candidate || candidate.matchedWayId == null) return current;
  if (current.matchedWayId == null) {
    return { matchedWayId: candidate.matchedWayId, confidence: candidate.confidence, consecutiveMatches: 1, pendingCandidate: null };
  }
  if (candidate.matchedWayId === current.matchedWayId) {
    return { ...current, confidence: candidate.confidence, consecutiveMatches: current.consecutiveMatches + 1, pendingCandidate: null };
  }
  if (candidate.headingCompatible === false) {
    // Wrong direction for this road (or the opposite carriageway logic doesn't apply) — never
    // counts toward a switch, and doesn't even reset an in-progress one.
    return current;
  }
  const samePending = current.pendingCandidate && current.pendingCandidate.matchedWayId === candidate.matchedWayId;
  const streak = samePending ? current.pendingCandidate.streak + 1 : 1;
  if (streak >= roadSwitchConfirmationCount) {
    return { matchedWayId: candidate.matchedWayId, confidence: candidate.confidence, consecutiveMatches: 1, pendingCandidate: null };
  }
  return { ...current, pendingCandidate: { matchedWayId: candidate.matchedWayId, streak } };
}

// Splits an open segment's coordinates into a committed prefix (won't be redrawn/recomputed on
// subsequent live-refresh passes) and a tentative tail (still subject to change). Only meaningful
// once the road-lock is actually confident — an UNMATCHED/LOW segment has nothing worth committing
// yet, so everything stays tentative (section 21, 48).
function splitCommittedTentative(coordinates, roadState, { committedLagPoints = 6, minConsecutiveMatchesToCommit = 3 } = {}) {
  const points = coordinates || [];
  const eligible = roadState && roadState.matchedWayId != null
    && (roadState.confidence === 'HIGH' || roadState.confidence === 'MEDIUM')
    && roadState.consecutiveMatches >= minConsecutiveMatchesToCommit;
  if (!eligible || points.length <= committedLagPoints) {
    return { committedCoordinates: [], tentativeCoordinates: points };
  }
  const splitAt = points.length - committedLagPoints;
  return { committedCoordinates: points.slice(0, splitAt), tentativeCoordinates: points.slice(splitAt) };
}

if (typeof module !== 'undefined') module.exports = { createRoadState, updateRoadState, splitCommittedTentative };
