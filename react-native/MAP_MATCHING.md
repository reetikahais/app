# Map matching approach (v2.2.0)

## Decision

**Valhalla's `trace_route`/`trace_attributes` pedestrian mode, self-hosted, called through the
adapter in `routeMatching.js`.** Not GraphHopper, not OSRM.

- Valhalla's `costing: pedestrian` already treats `footway`/`path`/`pedestrian`/`track`/`steps`/
  `residential`/`service` correctly and respects `foot=no`/access tags, so section 25 doesn't need
  a hand-rolled way filter.
- Valhalla's map matching is sequence-based (Viterbi over candidate edges), not nearest-edge
  snapping, which is the specific failure mode section 26 calls out for hillside roads with
  parallel/switchback geometry (New ISBT Shimla / Tutikandi).
- It is free, self-hostable, and takes a plain OSM extract, satisfying "no paid third-party
  matching service" (section 24).

GraphHopper's matching module and OSRM's `match` service would both also satisfy the "self-hosted
sequence matcher" requirement; Valhalla was picked over them only because its trace-route response
already reports a per-edge confidence score, which section 28's HIGH/MEDIUM/LOW/UNMATCHED model
needs. If this project already runs one of the others in production, swap it in — `routeMatching.js`
only assumes the adapter's request/response shape below, not the specific engine.

## Current status: adapter only, no server deployed

`MATCHER_ENDPOINT` in `trackingConfig.js` is `null`. **No Valhalla instance has been stood up.**
Standing one up means picking a host, extracting an OSM region around Shimla/Tutikandi, and paying
for the running cost — that's an infrastructure decision for the project owner, not something to
silently provision from inside a coding change. Until `MATCHER_ENDPOINT` is set, every session
resolves through the GPS-fallback path (`RAW_GPS`/`GAP` segments only) — tracking, filtering,
segmentation, and export all work exactly as before; the app simply doesn't display `MAP_MATCHED`
geometry yet.

## Adapter contract (`routeMatching.js`)

Request (`POST {MATCHER_ENDPOINT}`):
```json
{
  "profile": "pedestrian",
  "points": [{ "latitude": 0, "longitude": 0, "timestamp": 0, "accuracy": 0, "bearing": 0, "speed": 0, "segmentId": 0 }],
  "allowed_highways": ["footway", "path", "pedestrian", "track", "steps", "residential", "service"]
}
```
`segmentId` mirrors the client's own `segment_id` grouping (a new value each time `continuity_decision`
flips to `GAP`). A server has no other way to know where one contiguous walked run ends and the next
begins — it must echo this same value back on each response segment (see below) rather than invent
its own numbering, or the client will fail to line the response up with `fallbackSegments`.

A reference adapter implementing this contract in front of a self-hosted Valhalla instance lives in
`valhalla-adapter/` at the repo root — see its README for setup (Docker image, OSM extract, and how
it derives `confidence` from Valhalla's `matched_points[].distance_from_trace_point`, since Valhalla's
own `trace_attributes` response has no single per-edge confidence score to forward as-is).

Expected response:
```json
{
  "segments": [
    { "segmentId": 0, "confidence": 0.92, "coordinates": [[lon, lat], ...], "matchedWayId": "way/123" }
  ]
}
```
`confidence` may be a 0–1 score or an already-classified `"HIGH"/"MEDIUM"/"LOW"/"UNMATCHED"` string;
`classifyConfidence()` normalizes either. A thin adapter in front of Valhalla's own
`trace_attributes` response (edge `confidence_score` fields) is expected to produce this shape —
that adapter itself is not part of this change since there's no server to run it against yet.

## Client-side confidence gating (sections 28/29 — enforced regardless of what the server returns)

`resolveSegment()` in `routeMatching.js` is the single place this rule lives:

- **HIGH** → use the matched geometry.
- **MEDIUM** → use it only if the underlying GPS evidence for that segment is `CONTINUOUS` (no
  `GAP`) — i.e. only when the raw trajectory itself isn't already ambiguous.
- **LOW / UNMATCHED** → always keep validated GPS (`RAW_GPS`/`GAP`), never the matched line, no
  matter how much cleaner a nearby road would make the route look.

This is enforced client-side on purpose: the confidence tier a matcher backend reports is not
trusted to already imply the right fallback behavior.

## Live vs. final matching (section 36)

- **Live** (`App.js`, `refreshLiveMatching`): each closed segment is matched at most once and
  cached; the currently-open segment is rematched on a 10s throttle using only its last 15 accepted
  points. No endpoint configured means this is a cheap no-op every tick.
- **Final** (`App.js`, `finalizeSession`, run from `stop()`): one full-session match per segment,
  written back onto `processed_locations` via `db.updateMatchDiagnostics()` (keyed by
  `raw_fix_id`), without touching any raw column — so a future matcher version or newer OSM extract
  can redo this from the untouched raw evidence at any time (section 35).

## Known limitation

Per-raw-fix `distance_from_matched_path_m` is computed as the distance to the *nearest vertex* of
the matched polyline, not a true point-to-segment (line) distance. That's a reasonable
approximation for a reasonably dense matched geometry but will slightly overstate distance near
long straight edges. Worth tightening once a real matcher is connected and its actual vertex
density is known.
