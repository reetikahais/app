# RaahMitra Valhalla adapter

Fixes the actual accuracy gap: today `MATCHER_ENDPOINT` in `react-native/trackingConfig.js` is
`null`, so every walk resolves through the raw-GPS fallback path — no point ever gets snapped onto
the real footpath/highway geometry (`map_match_status` is always `FALLBACK` in your exports). This
folder is a small, free, self-hosted service that does the snapping for real.

Two pieces, run separately:
1. **Valhalla itself** — the actual routing/map-matching engine (Docker, official image).
2. **This adapter** (`server.js`) — a thin translator between RaahMitra's request/response contract
   (documented in `../react-native/MAP_MATCHING.md`) and Valhalla's real API. Run directly with
   `node server.js`, no Docker needed for this part.

Both pieces and their contract have been tested (see `tests/`, all passing, including a test that
feeds this adapter's output through your actual `routeMatching.js` code). What has **not** been
tested is the real Valhalla engine itself responding to a real GPS trace — that needs a running
instance, which nobody has stood up yet. Treat the matching quality as unverified until you've
walked a real session through it once.

## 1. Run Valhalla (Docker)

Requires Docker Desktop (or Docker Engine) installed.

```powershell
cd valhalla-adapter
docker compose up
```

First run downloads an OSM extract and builds the routing graph — this can take a while (10–30+
minutes depending on extract size and your machine) and needs a few GB of free disk. The default
extract in `docker-compose.yml` is Geofabrik's "Northern Zone" (India), ~212MB download, which
covers Himachal Pradesh along with several other northern states — much more area than you need
just for Shimla Bypass walks, so the graph build will take longer than necessary.

**Recommended instead:** get a small custom extract covering just your walking area from
[extract.bbbike.org](https://extract.bbbike.org/) (free, draw a box around Shimla/Tutikandi, a few
MB instead of 212MB, arrives by email/download link, usually within minutes to an hour). Once you
have that file:

```powershell
mkdir custom_files
# copy your downloaded shimla-extract.osm.pbf into ./custom_files/
```

Then edit `docker-compose.yml`, replacing the `tile_urls=...` line with:
```yaml
      - use_tiles_ignore_pbf=False
```
and drop your `.osm.pbf` file directly into `./custom_files/` before `docker compose up` — the
scripted image picks up any `.pbf` already there. (If you'd rather keep using `tile_urls` with a
direct download link to your bbbike extract, that works too — just point it at that URL instead of
the Geofabrik one.)

Once running, confirm it's up:
```powershell
curl http://localhost:8002/status
```

## 2. Run the adapter

No dependencies to install (uses only Node's built-ins + global `fetch`, Node 18+ required).

```powershell
cd valhalla-adapter
node server.js
```

By default it listens on port 8787 and forwards to `http://localhost:8002` (Valhalla). Override
with environment variables if needed:
```powershell
$env:PORT='8787'; $env:VALHALLA_URL='http://localhost:8002'; node server.js
```

Confirm it's up:
```powershell
curl http://localhost:8787/health
```

## 3. Point the app at it

In `react-native/trackingConfig.js`, change:
```js
const MATCHER_ENDPOINT = null;
```
to your machine's LAN IP (not `localhost` — the phone is a different device on the network) and
the adapter's port:
```js
const MATCHER_ENDPOINT = 'http://192.168.1.X:8787/';
```
Your phone and the computer running the adapter must be on the same WiFi network for this to work
during a live walk. Find your PC's LAN IP with `ipconfig` (look for the WiFi adapter's IPv4
address).

If you're not on the same network while walking, matching will simply fail silently and the app
falls back to plain GPS for that session — by design (see `MAP_MATCHING.md`, "matcher absence must
never stop GPS tracking or route display"). You can still get matched results afterward: run
`node server.js` once you're back on the same WiFi as the Valhalla container, then re-export the
animated map (`exportAnimatedMap()` re-runs matching fresh at export time).

## Running the tests

```powershell
cd valhalla-adapter
npm test
```

## Known gaps / things to verify once you have a real session through it

- **Confidence thresholds** (`CONFIDENCE_DISTANCE_M` in `transform.js`, 5m/15m) are a reasonable
  starting guess, not tuned against real data. If matched routes look right but get graded LOW/
  MEDIUM (or vice versa — clearly wrong roads getting graded HIGH), adjust these numbers.
- **`matchedWayId`** is only used for diagnostics/display, never to override GPS — `resolveSegment`
  in `routeMatching.js` enforces that client-side regardless of what this adapter reports.
- This adapter has no authentication — fine on a home LAN, but do not port-forward it to the public
  internet as-is.
