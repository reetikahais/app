// Pure GPS-fix -> plot-point pipeline: mirrors tools/gps-path-animator.html's parseExport +
// markSpikes + markSpeedOutliers, minus the load-panel/DOM concerns (this runs before the points
// ever reach a WebView). No I/O, no platform APIs - same shape as movementStateMachine.js.

import { MAX_ACCURACY_METERS } from './locationFixClassifier';
import { LONG_STATIONARY_INTERVAL_BACKGROUND_MS } from './movementStateMachine';

export const ACCURACY_THRESHOLD_M = MAX_ACCURACY_METERS;
// Set above the app's own longest legitimate adaptive-poll interval so normal long-stationary
// polling never falsely reads as a tracking gap - only real outages (task killed, background
// throttled) do. See tools/gps-path-animator.html for the same reasoning.
export const MAX_GAP_SECONDS = LONG_STATIONARY_INTERVAL_BACKGROUND_MS / 1000 + 60;
// Supplementary to the spike check below: catches a bad fix at either END of the array, where
// there's no "next"/"prev" neighbor for the reunion check to use.
export const MAX_SPEED_KMH = 150;

const NOISE_FLOOR_M = 15;
const REUNION_SLACK = 1.5;
const EARTH_RADIUS_M = 6371000;

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function effectiveAccuracy(a) {
  return Number.isFinite(a) && a > 0 ? Math.min(Math.max(a, 3), 250) : 100;
}

function noiseThresholdM(accA, accB) {
  return Math.max(accA, accB) + NOISE_FLOOR_M;
}

function markSpikes(points) {
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dPrevCur = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    const dCurNext = haversineM(cur.lat, cur.lon, next.lat, next.lon);
    const dPrevNext = haversineM(prev.lat, prev.lon, next.lat, next.lon);
    cur.isSpike =
      dPrevCur > noiseThresholdM(prev.effAcc, cur.effAcc) &&
      dCurNext > noiseThresholdM(cur.effAcc, next.effAcc) &&
      dPrevNext <= noiseThresholdM(prev.effAcc, next.effAcc) * REUNION_SLACK;
  }
}

function markSpeedOutliers(points) {
  let prev = null;
  for (const p of points) {
    if (p.isSpike) continue;
    if (prev) {
      const dt = (p.t - prev.t) / 1000;
      if (dt > 0) {
        const kmh = (haversineM(prev.lat, prev.lon, p.lat, p.lon) / dt) * 3.6;
        if (kmh > MAX_SPEED_KMH) p.isSpeedOutlier = true;
      }
    }
    if (!p.isSpeedOutlier) prev = p;
  }
}

export function buildMapPoints(rows) {
  const parsed = rows
    .map((r) => {
      const lat = r.latitude ?? r.processed_latitude;
      const lon = r.longitude ?? r.processed_longitude;
      const t = r.timestamp ? new Date(r.timestamp).getTime() : NaN;
      return {
        id: r.id,
        t,
        lat,
        lon,
        hasPos: typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon),
        accuracy: r.accuracy ?? null,
        effAcc: effectiveAccuracy(r.accuracy),
        movementState: r.movement_state ?? null,
        method: r.method ?? null,
        batteryPct: r.battery ?? null,
        appState: r.app_state ?? null,
        signalDbm: r.signal_dbm ?? null,
        signalLevel: r.signal_level ?? null,
        carrier: r.carrier ?? null,
        networkType: r.network_type ?? null,
        locationQuality: r.location_quality ?? null,
      };
    })
    .filter((p) => p.hasPos && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  const deduped = parsed.filter((p, i) => {
    if (i === 0) return true;
    const prev = parsed[i - 1];
    return !(p.t === prev.t && p.lat === prev.lat && p.lon === prev.lon);
  });

  deduped.forEach((p) => {
    p.isLowAcc = p.accuracy != null && p.accuracy > ACCURACY_THRESHOLD_M;
  });
  markSpikes(deduped);
  markSpeedOutliers(deduped);

  let runIndex = 0;
  let prevKeptT = null;
  deduped.forEach((p, idx) => {
    p.idx = idx;
    p.excluded = !!(p.isSpike || p.isSpeedOutlier || p.isLowAcc);
    if (!p.excluded) {
      p.gapBefore = prevKeptT != null && p.t - prevKeptT > MAX_GAP_SECONDS * 1000;
      if (p.gapBefore) runIndex += 1;
      p.runIndex = runIndex;
      prevKeptT = p.t;
    }
  });

  return deduped;
}
