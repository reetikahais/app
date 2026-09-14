// Sliding-window trace buffering (section 15-16): breaks a long ordered point list into overlapping
// windows instead of matching either "one point at a time" (too little context for the matcher to
// pick the right road) or "the entire trip in one call" (slow/heavy on a long bike ride, and
// re-matches settled history every time it runs). Pure/stateless — callers decide what to do with
// each window's result.

function buildTraceWindows(points, { windowSize = 15, overlapSize = 5 } = {}) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (points.length <= windowSize) return [points];
  const step = Math.max(1, windowSize - overlapSize);
  const windows = [];
  for (let start = 0; start < points.length; start += step) {
    const end = Math.min(start + windowSize, points.length);
    windows.push(points.slice(start, end));
    if (end === points.length) break;
  }
  return windows;
}

const EXACT_COORD_EPSILON = 1e-7;
function sameCoordinate(a, b) {
  return a && b && Math.abs(a.latitude - b.latitude) < EXACT_COORD_EPSILON && Math.abs(a.longitude - b.longitude) < EXACT_COORD_EPSILON;
}

// Concatenates a sequence of per-window matched segments (parallel to buildTraceWindows' output,
// each either a matched segment shape or null/undefined for a window that failed to match) into one
// polyline, in trip order. Windows that failed to match are skipped rather than breaking the whole
// stitched result — a matcher hiccup on one window must not discard the windows around it. Where an
// exact coordinate is shared at a seam (the common case when two adjacent snapped results land on
// the same road endpoint) the duplicate is dropped; otherwise both windows' geometry is kept as-is,
// since matched polylines from independently-matched windows are not guaranteed to share vertices
// even when they describe the same road.
function stitchWindowResults(windowResults) {
  const usable = (windowResults || []).filter((result) => result && result.coordinates && result.coordinates.length);
  if (!usable.length) return null;
  const coordinates = [];
  let matchedWayId = null;
  let worstConfidenceRank = 3;
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, UNMATCHED: 0 };
  for (const window of usable) {
    let windowCoords = window.coordinates;
    if (coordinates.length && sameCoordinate(coordinates[coordinates.length - 1], windowCoords[0])) {
      windowCoords = windowCoords.slice(1);
    }
    coordinates.push(...windowCoords);
    if (matchedWayId == null) matchedWayId = window.matchedWayId;
    worstConfidenceRank = Math.min(worstConfidenceRank, rank[window.confidence] ?? 0);
  }
  const confidenceByRank = ['UNMATCHED', 'LOW', 'MEDIUM', 'HIGH'];
  return { coordinates, matchedWayId, confidence: confidenceByRank[worstConfidenceRank] };
}

if (typeof module !== 'undefined') module.exports = { buildTraceWindows, stitchWindowResults };
