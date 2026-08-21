// Reference implementation of the MATCHER_ENDPOINT contract documented in ../react-native/MAP_MATCHING.md,
// fronting a self-hosted Valhalla instance (see docker-compose.yml). Requires Node 18+ for global fetch.
const http = require('node:http');
const { groupBySegment, buildTraceAttributesRequest, traceAttributesToSegment } = require('./transform');

const PORT = Number(process.env.PORT ?? 8787);
const VALHALLA_URL = process.env.VALHALLA_URL ?? 'http://localhost:8002';

async function matchSegment(segmentId, points) {
  // Valhalla's map matching needs at least two points to establish a trace; a lone point can only
  // ever be UNMATCHED, so skip the round trip and let the client's own fallback (raw GPS) stand —
  // per MAP_MATCHING.md, a matcher must never be the reason tracking/display breaks.
  if (points.length < 2) return { segmentId, confidence: 'UNMATCHED', coordinates: [], matchedWayId: null };
  const response = await fetch(`${VALHALLA_URL}/trace_attributes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildTraceAttributesRequest(points)),
  });
  if (!response.ok) throw new Error(`valhalla_http_${response.status}`);
  const body = await response.json();
  return traceAttributesToSegment(segmentId, body);
}

async function handleMatch(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }

  const points = Array.isArray(payload?.points) ? payload.points : [];
  const groups = groupBySegment(points);

  // One segment failing to reach Valhalla (network hiccup, extract doesn't cover that area, etc.)
  // must not take the rest of the session down with it — resolve each segment independently and
  // simply omit ones that error, so the client's own per-segment fallback covers the gap.
  const settled = await Promise.allSettled(
    [...groups.entries()].map(([segmentId, segmentPoints]) => matchSegment(segmentId, segmentPoints)),
  );
  const segments = settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ segments }));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/') {
    handleMatch(req, res).catch((err) => {
      console.error('match_failed', err);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'matcher_upstream_failed', message: String(err?.message ?? err) }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, valhallaUrl: VALHALLA_URL }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`raahmitra-valhalla-adapter listening on :${PORT}, forwarding to ${VALHALLA_URL}`);
});
