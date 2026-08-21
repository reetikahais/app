const { haversineMeters } = require('./processing');
const { MAP_MATCH_CONFIDENCE, MATCHER_VERSION } = require('./trackingConfig');

function pointCoordinate(row) {
  return {
    latitude: Number(row.filtered_latitude ?? row.latitude),
    longitude: Number(row.filtered_longitude ?? row.longitude),
  };
}

function buildGpsRouteSegments(rows) {
  const grouped = new Map();
  rows.filter((row) => row.is_route_point && row.trajectory_decision === 'ACCEPTED')
    .sort((a, b) => Number(a.fix_timestamp_ms) - Number(b.fix_timestamp_ms))
    .forEach((row) => {
      const segmentId = Number(row.segment_id ?? 0);
      const segment = grouped.get(segmentId) || {
        segmentId,
        // A new segment_id always starts on the fix that lands right after a signal gap, so that
        // first row's own continuity_decision is always 'GAP' — that describes the jump *into*
        // this segment, not the walking that follows it, and must not be used to classify the
        // segment itself. Only a GAP seen after the segment already has a coordinate reflects a
        // genuine internal dropout worth downgrading the segment for.
        segmentType: 'RAW_GPS',
        confidence: 'UNMATCHED',
        coordinates: [],
        rawFixIds: [],
      };
      if (row.continuity_decision === 'GAP' && segment.coordinates.length) {
        segment.segmentType = 'GAP';
      }
      segment.coordinates.push(pointCoordinate(row));
      segment.rawFixIds.push(row.raw_fix_id ?? row.id ?? null);
      grouped.set(segmentId, segment);
    });
  return [...grouped.values()].filter((segment) => segment.coordinates.length > 0);
}

// Server confidence may arrive as a 0..1 score or an already-classified tier string.
// Normalizing to HIGH/MEDIUM/LOW/UNMATCHED lets the client itself enforce section 28/29
// of the spec, instead of trusting whatever a (pluggable, currently unhosted) matcher
// backend decided to label a segment.
function classifyConfidence(confidence) {
  if (typeof confidence === 'string') {
    const upper = confidence.toUpperCase();
    if (['HIGH', 'MEDIUM', 'LOW', 'UNMATCHED'].includes(upper)) return upper;
  }
  const score = Number(confidence);
  if (!Number.isFinite(score)) return 'UNMATCHED';
  if (score >= MAP_MATCH_CONFIDENCE.HIGH_MIN) return 'HIGH';
  if (score >= MAP_MATCH_CONFIDENCE.MEDIUM_MIN) return 'MEDIUM';
  return 'LOW';
}

function normalizeMatchedSegments(response) {
  if (!Array.isArray(response?.segments)) return null;
  return response.segments.map((segment, index) => ({
    segmentId: segment.segmentId ?? segment.segment_id ?? index,
    confidence: classifyConfidence(segment.confidence),
    coordinates: (segment.coordinates || []).map((coordinate) => ({
      latitude: Number(coordinate.latitude ?? coordinate[1]),
      longitude: Number(coordinate.longitude ?? coordinate[0]),
    })).filter((coordinate) => Number.isFinite(coordinate.latitude) && Number.isFinite(coordinate.longitude)),
    matchedWayId: segment.matchedWayId ?? segment.matched_way_id ?? null,
  })).filter((segment) => segment.coordinates.length > 1);
}

function nearestPointOnPolyline(point, coordinates) {
  let best = null;
  let bestDistance = Infinity;
  for (const vertex of coordinates) {
    const distance = haversineMeters(point.latitude, point.longitude, vertex.latitude, vertex.longitude);
    if (distance < bestDistance) { bestDistance = distance; best = vertex; }
  }
  return best ? { vertex: best, distance: bestDistance } : null;
}

// Section 28/29: HIGH confidence uses mapped geometry; MEDIUM only when the underlying GPS
// evidence is itself continuous (low ambiguity, no gap to bridge); LOW/UNMATCHED never override
// validated GPS, no matter how much cleaner a nearby mapped road would make the line look.
// Per-raw-fix diagnostics (nearest matched vertex + distance) are kept separate from the
// rendered polyline geometry, since a sequence matcher's output is not required to be
// one-to-one with the input GPS points.
function resolveSegment(matchedSegment, fallbackSegment) {
  const confidence = matchedSegment ? matchedSegment.confidence : 'UNMATCHED';
  const fallbackIsContinuous = fallbackSegment?.segmentType !== 'GAP';
  const useMatched = Boolean(matchedSegment)
    && (confidence === 'HIGH' || (confidence === 'MEDIUM' && fallbackIsContinuous));
  const rawPoints = fallbackSegment?.coordinates ?? [];
  const rawFixIds = fallbackSegment?.rawFixIds ?? [];
  const pointDiagnostics = rawPoints.map((point, index) => {
    const nearest = useMatched ? nearestPointOnPolyline(point, matchedSegment.coordinates) : null;
    return {
      rawFixId: rawFixIds[index] ?? null,
      mapMatchedLatitude: nearest ? nearest.vertex.latitude : null,
      mapMatchedLongitude: nearest ? nearest.vertex.longitude : null,
      distanceFromMatchedPathM: nearest ? nearest.distance : null,
    };
  });
  if (useMatched) {
    return {
      segmentId: fallbackSegment?.segmentId ?? matchedSegment.segmentId,
      segmentType: 'MAP_MATCHED',
      confidence,
      coordinates: matchedSegment.coordinates,
      matchedWayId: matchedSegment.matchedWayId,
      pointDiagnostics,
    };
  }
  return {
    segmentId: fallbackSegment?.segmentId,
    segmentType: fallbackSegment?.segmentType ?? 'RAW_GPS',
    confidence,
    coordinates: rawPoints,
    matchedWayId: null,
    pointDiagnostics,
  };
}

/**
 * Adapter for a self-hosted pedestrian matcher (Valhalla-compatible trace-route response).
 * No endpoint configured, or a failed/unreachable request, resolves every segment through the
 * fallback path — matcher absence must never stop GPS tracking or route display (section 37).
 */
async function matchWalkingSequence(rows, { endpoint, signal } = {}) {
  const fallbackSegments = buildGpsRouteSegments(rows);
  if (!endpoint || rows.length < 2) {
    return fallbackSegments.map((segment) => resolveSegment(null, segment));
  }
  let matchedSegments = null;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: 'pedestrian',
        points: rows.map((row) => ({
          ...pointCoordinate(row), timestamp: row.fix_timestamp_ms, accuracy: row.accuracy,
          bearing: row.bearing, speed: row.implied_speed_mps,
          // Without this, a server has no way to know where one contiguous walked segment ends
          // and the next begins — the client itself only reconstructs that boundary from
          // segment_id (see buildGpsRouteSegments above), so the request must carry the same value.
          segmentId: Number(row.segment_id ?? 0),
        })),
        allowed_highways: ['footway', 'path', 'pedestrian', 'track', 'steps', 'residential', 'service'],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`matcher_http_${response.status}`);
    matchedSegments = normalizeMatchedSegments(await response.json());
  } catch (_) {
    matchedSegments = null;
  }
  const matchedById = new Map((matchedSegments || []).map((segment) => [segment.segmentId, segment]));
  return fallbackSegments.map((segment) => resolveSegment(matchedById.get(segment.segmentId) || null, segment));
}

// Per-raw-fix diagnostics for section 42/43 persistence: one row per original accepted GPS
// fix, keyed by raw_fix_id, so processed_locations can be updated after final matching runs.
function collectMatchDiagnostics(segments) {
  return segments.flatMap((segment) => segment.pointDiagnostics
    .filter((diag) => diag.rawFixId != null)
    .map((diag) => ({
      raw_fix_id: diag.rawFixId,
      map_matched_latitude: diag.mapMatchedLatitude,
      map_matched_longitude: diag.mapMatchedLongitude,
      map_match_status: segment.segmentType === 'MAP_MATCHED' ? 'MATCHED' : 'FALLBACK',
      map_match_confidence: segment.confidence,
      matched_way_id: segment.matchedWayId,
      distance_from_matched_path_m: diag.distanceFromMatchedPathM,
      route_segment_type: segment.segmentType,
      matcher_version: MATCHER_VERSION,
    })));
}

if (typeof module !== 'undefined') module.exports = {
  MATCHER_VERSION, buildGpsRouteSegments, matchWalkingSequence,
  classifyConfidence, resolveSegment, normalizeMatchedSegments, collectMatchDiagnostics,
};
