// Low-confidence rendering (recovery-confirmed / late-delivered fixes carry position_confidence
// 'LOW'): buildGpsRouteSegments tags those coordinates with `lowConfidence: true`, and both map
// renderers split a segment into runs so those stretches draw as a separate dashed, faded line
// instead of being merged into the solid route. Pure and dependency-free so it can be unit tested.

// Splits one segment's ordered coordinates into runs of the same confidence. A line (edge) takes the
// confidence of the point it leads TO, and each new run starts on the previous run's last point so
// the drawn lines stay connected. With no low-confidence points the input array comes back as the
// single run, unchanged.
function splitByConfidence(coordinates) {
  const points = coordinates || [];
  if (points.length < 2 || !points.some((point) => point.lowConfidence)) {
    return [{ coordinates: points, lowConfidence: false }];
  }
  const runs = [];
  let current = null;
  for (let i = 1; i < points.length; i += 1) {
    const lowConfidence = Boolean(points[i].lowConfidence);
    if (!current || current.lowConfidence !== lowConfidence) {
      current = { coordinates: [points[i - 1]], lowConfidence };
      runs.push(current);
    }
    current.coordinates.push(points[i]);
  }
  return runs;
}

// JSON consumed by the live WebView's window.updateRoute().
function segmentsToRouteJson(segments) {
  return JSON.stringify(segments.flatMap((segment) => splitByConfidence(segment.coordinates).map((run) => ({
    type: segment.segmentType,
    coordinates: run.coordinates.map((point) => [point.latitude, point.longitude]),
    tentative: Boolean(segment.tentative),
    lowConfidence: run.lowConfidence,
  }))));
}

if (typeof module !== 'undefined') module.exports = { splitByConfidence, segmentsToRouteJson };
