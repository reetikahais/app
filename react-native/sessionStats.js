const { haversineMeters, routeLength } = require('./processing');
const { ELEVATION_CONFIG } = require('./trackingConfig');

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Rejects obvious vertical spikes (GPS altitude noise) before summing gain/loss, using a
// simple centered-median smoother — good enough to stop single-fix jumps from being counted
// as real elevation change without inventing a full physical vertical-speed model.
function smoothAltitudes(rows) {
  const window = Math.max(1, ELEVATION_CONFIG.smoothingWindow);
  const half = Math.floor(window / 2);
  return rows.map((row, index) => {
    if (row.altitude_m == null) return null;
    const start = Math.max(0, index - half);
    const end = Math.min(rows.length, index + half + 1);
    const neighborhood = rows.slice(start, end).map((r) => r.altitude_m).filter(Number.isFinite);
    return median(neighborhood);
  });
}

function computeElevation(acceptedRows) {
  if (acceptedRows.length < 2) return { elevationGainM: null, elevationLossM: null };
  const hasAltitude = acceptedRows.some((row) => Number.isFinite(row.altitude_m));
  if (!hasAltitude) return { elevationGainM: null, elevationLossM: null };
  const smoothed = smoothAltitudes(acceptedRows);
  let gain = 0;
  let loss = 0;
  let previous = null;
  let previousTimestamp = null;
  for (let index = 0; index < smoothed.length; index += 1) {
    const altitude = smoothed[index];
    const timestamp = Number(acceptedRows[index].fix_timestamp_ms);
    if (altitude == null) continue;
    if (previous != null) {
      const elapsedS = Math.max(0, (timestamp - previousTimestamp) / 1000);
      const delta = altitude - previous;
      const verticalSpeed = elapsedS > 0 ? Math.abs(delta) / elapsedS : 0;
      if (verticalSpeed <= ELEVATION_CONFIG.maxPlausibleVerticalSpeedMps) {
        if (delta > 0) gain += delta; else loss += -delta;
      }
      // else: implausible vertical spike for the elapsed time — dropped, not summed.
    }
    previous = altitude;
    previousTimestamp = timestamp;
  }
  return { elevationGainM: Math.round(gain * 10) / 10, elevationLossM: Math.round(loss * 10) / 10 };
}

// Prefers high-confidence matched geometry for total distance where available (section 40),
// falling back to processed GPS geometry per segment otherwise. `segments` are the resolved
// display segments from routeMatching (routeMatching.resolveSegment output), already excluding
// OUTLIER/unconfirmed-UNCERTAIN evidence.
function computeDistanceM(segments) {
  return segments.reduce((total, segment) => (
    segment.segmentType === 'GAP' ? total : total + routeLength(segment.coordinates)
  ), 0);
}

function computeSessionStats({ rawRows, processedRows, segments }) {
  const rawById = new Map(rawRows.map((row) => [row.id, row]));
  const rows = processedRows.map((row) => ({ ...rawById.get(row.raw_fix_id), ...row }));
  const acceptedRows = rows.filter((row) => row.trajectory_decision === 'ACCEPTED' && row.is_route_point)
    .sort((a, b) => Number(a.fix_timestamp_ms) - Number(b.fix_timestamp_ms));

  const startRow = acceptedRows[0] ?? null;
  const endRow = acceptedRows[acceptedRows.length - 1] ?? null;
  const durationMs = startRow && endRow ? Number(endRow.fix_timestamp_ms) - Number(startRow.fix_timestamp_ms) : null;
  const totalDistanceM = segments ? computeDistanceM(segments) : routeLength(
    acceptedRows.map((row) => ({ latitude: row.filtered_latitude ?? row.latitude, longitude: row.filtered_longitude ?? row.longitude })),
  );
  const averageSpeedMps = durationMs && durationMs > 0 ? totalDistanceM / (durationMs / 1000) : null;
  const accuracies = rawRows.map((row) => Number(row.horizontal_accuracy_m)).filter(Number.isFinite);
  const { elevationGainM, elevationLossM } = computeElevation(acceptedRows);

  return {
    date: startRow ? new Date(Number(startRow.fix_timestamp_ms)).toISOString().slice(0, 10) : null,
    startTime: startRow ? new Date(Number(startRow.fix_timestamp_ms)).toISOString() : null,
    endTime: endRow ? new Date(Number(endRow.fix_timestamp_ms)).toISOString() : null,
    startLocation: startRow ? { latitude: startRow.filtered_latitude ?? startRow.latitude, longitude: startRow.filtered_longitude ?? startRow.longitude } : null,
    endLocation: endRow ? { latitude: endRow.filtered_latitude ?? endRow.latitude, longitude: endRow.filtered_longitude ?? endRow.longitude } : null,
    totalDistanceM: Math.round(totalDistanceM * 10) / 10,
    durationMs,
    averageSpeedMps: averageSpeedMps != null ? Math.round(averageSpeedMps * 100) / 100 : null,
    elevationGainM,
    elevationLossM,
    rawPointCount: rawRows.length,
    acceptedPointCount: rows.filter((row) => row.trajectory_decision === 'ACCEPTED').length,
    uncertainPointCount: rows.filter((row) => row.trajectory_decision === 'UNCERTAIN').length,
    outlierPointCount: rows.filter((row) => row.trajectory_decision === 'OUTLIER').length,
    averageAccuracyM: accuracies.length ? Math.round((accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 10) / 10 : null,
  };
}

if (typeof module !== 'undefined') module.exports = { computeSessionStats, computeElevation, smoothAltitudes };
