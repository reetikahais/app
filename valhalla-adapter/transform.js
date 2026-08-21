// Pure request/response translation between RaahMitra's matcher contract (see MAP_MATCHING.md at
// the repo root) and Valhalla's real trace_attributes API. No network calls live here on purpose —
// server.js does the fetching, this file just does the shape conversion, so it's testable without
// a running Valhalla instance.

// The app sends one flat point list per call, tagged with the same `segment_id` the client itself
// uses to split contiguous walked runs at signal gaps (see routeMatching.js buildGpsRouteSegments).
// Grouping here reproduces that split so each group can be matched as its own Valhalla trace and
// handed back under the same segmentId the client is keyed on.
function groupBySegment(points) {
  const groups = new Map();
  for (const point of points) {
    const key = Number(point.segmentId ?? 0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }
  return groups;
}

// Valhalla's shape `time` is seconds elapsed since the first point of *that trace*, not an epoch
// timestamp. Each segment is matched as an independent trace, so re-zero the clock per segment.
function toValhallaShape(points) {
  const firstTimestamp = Number(points[0]?.timestamp ?? 0);
  return points.map((point) => ({
    lat: Number(point.latitude),
    lon: Number(point.longitude),
    time: Math.max(0, Math.round((Number(point.timestamp ?? firstTimestamp) - firstTimestamp) / 1000)),
  }));
}

// shape_match: 'map_snap' — our GPS trace does not closely follow Valhalla edges (that's the whole
// point of matching it), so this must not be 'edge_walk' (reserved for shapes already snapped by a
// prior Valhalla route).
function buildTraceAttributesRequest(points) {
  return {
    shape: toValhallaShape(points),
    costing: 'pedestrian',
    shape_match: 'map_snap',
  };
}

// Valhalla's trace_attributes has no single per-edge confidence score to forward as-is. Its real,
// documented signal is matched_points[].distance_from_trace_point — how far each snapped point sits
// from the raw GPS fix it came from. Average that and classify it against the same tiers the client
// already uses for a 0..1 score (MAP_MATCH_CONFIDENCE in trackingConfig.js), just expressed as
// distances instead of a score, so both sides mean the same thing by "close enough".
const CONFIDENCE_DISTANCE_M = Object.freeze({ HIGH_MAX: 5, MEDIUM_MAX: 15 });

function confidenceFromMatchedPoints(matchedPoints) {
  const distances = (matchedPoints || [])
    .filter((point) => point.type === 'matched')
    .map((point) => Number(point.distance_from_trace_point ?? Infinity))
    .filter((distance) => Number.isFinite(distance));
  if (!distances.length) return 'UNMATCHED';
  const meanDistance = distances.reduce((sum, d) => sum + d, 0) / distances.length;
  if (meanDistance <= CONFIDENCE_DISTANCE_M.HIGH_MAX) return 'HIGH';
  if (meanDistance <= CONFIDENCE_DISTANCE_M.MEDIUM_MAX) return 'MEDIUM';
  return 'LOW';
}

// Valhalla's default shape_format is an encoded polyline at 1e6 precision ("polyline6") — the same
// zigzag/varint scheme as Google's public Encoded Polyline Algorithm Format, just scaled 1e6
// instead of the more commonly seen 1e5.
function decodePolyline6(encoded) {
  if (!encoded) return [];
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const factor = 1e6;
  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += (result & 1) !== 0 ? ~(result >> 1) : (result >> 1);

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lon += (result & 1) !== 0 ? ~(result >> 1) : (result >> 1);

    coordinates.push({ latitude: lat / factor, longitude: lon / factor });
  }
  return coordinates;
}

// The matched way (for diagnostics/labeling only, never used to override GPS — resolveSegment on
// the client enforces that) is taken as whichever OSM way the trace spent the most edges on, so one
// stray short connector edge doesn't flip the label.
function mostCommonWayId(edges) {
  if (!Array.isArray(edges) || !edges.length) return null;
  const counts = new Map();
  for (const edge of edges) {
    const id = edge?.way_id != null ? String(edge.way_id) : null;
    if (id == null) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) { best = id; bestCount = count; }
  }
  return best;
}

// Converts one Valhalla trace_attributes response into one segment of the app's contract:
// { segmentId, confidence, coordinates: [{latitude, longitude}], matchedWayId }
function traceAttributesToSegment(segmentId, response) {
  return {
    segmentId,
    confidence: confidenceFromMatchedPoints(response?.matched_points),
    coordinates: decodePolyline6(response?.shape),
    matchedWayId: mostCommonWayId(response?.edges),
  };
}

module.exports = {
  groupBySegment,
  toValhallaShape,
  buildTraceAttributesRequest,
  confidenceFromMatchedPoints,
  decodePolyline6,
  mostCommonWayId,
  traceAttributesToSegment,
};
