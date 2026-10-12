import * as SQLite from 'expo-sqlite';
import { pairRawWithProcessed } from './taskHelpers';

let dbPromise = null;

// Section 28: the location task and a manual finalize/live-match pass can both want to write at
// nearly the same moment. expo-sqlite's async API already queues calls on a single connection, but
// this chain makes the "one writer at a time" guarantee explicit at the call-site level too, so two
// overlapping withTransactionAsync callers can never observe "cannot start a transaction within a
// transaction" — each write simply waits for the previous one to fully settle first.
let writeQueue = Promise.resolve();
function serializeWrite(fn) {
  const next = writeQueue.then(fn, fn);
  // Swallow so one failed write doesn't poison the chain for every write after it; the caller
  // still sees (and can handle) its own rejection via the returned promise.
  writeQueue = next.catch(() => {});
  return next;
}

export function getDb() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('gps_log.db').then(async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT,
          latitude REAL,
          longitude REAL,
          accuracy REAL,
          battery INTEGER,
          app_state TEXT,
          method TEXT
        );
        CREATE TABLE IF NOT EXISTS raw_locations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tracking_session_id TEXT,
          tracking_mode TEXT,
          fix_timestamp_ms INTEGER NOT NULL,
          received_timestamp_ms INTEGER NOT NULL,
          fix_age_ms INTEGER,
          elapsed_realtime_ns INTEGER,
          batch_id TEXT,
          batch_index INTEGER,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          horizontal_accuracy_m REAL,
          altitude_m REAL,
          vertical_accuracy_m REAL,
          speed_mps REAL,
          speed_accuracy_mps REAL,
          bearing_deg REAL,
          bearing_accuracy_deg REAL,
          provider TEXT,
          method TEXT,
          is_mock INTEGER,
          app_state TEXT,
          battery_pct INTEGER,
          motion_activity TEXT,
          step_count INTEGER,
          signal_dbm INTEGER,
          signal_level INTEGER,
          carrier TEXT,
          network_type TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processed_locations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          raw_fix_id INTEGER NOT NULL,
          tracking_session_id TEXT,
          algorithm_version TEXT NOT NULL,
          processing_status TEXT NOT NULL,
          processing_reason TEXT,
          filtered_latitude REAL,
          filtered_longitude REAL,
          predicted_latitude REAL,
          predicted_longitude REAL,
          innovation_m REAL,
          normalized_innovation REAL,
          estimated_uncertainty_m REAL,
          position_confidence TEXT,
          movement_state TEXT,
          segment_id INTEGER,
          is_route_point INTEGER NOT NULL DEFAULT 0,
          map_matched_latitude REAL,
          map_matched_longitude REAL,
          map_match_status TEXT,
          map_match_confidence REAL,
          interval_ms INTEGER,
          raw_delivery_interval_ms INTEGER,
          accepted_interval_ms INTEGER,
          delivery_latency_ms INTEGER,
          continuity_decision TEXT,
          route_segment_type TEXT,
          matcher_version TEXT,
          raw_to_filtered_m REAL,
          gap_duration_ms INTEGER,
          matched_way_id TEXT,
          distance_from_matched_path_m REAL,
          turn_detected INTEGER,
          acceleration_mps2 REAL,
          stationary_anchor_latitude REAL,
          stationary_anchor_longitude REAL,
          created_at TEXT NOT NULL
        );
      `);
      const rawColumns = await db.getAllAsync('PRAGMA table_info(raw_locations)');
      const rawExisting = new Set(rawColumns.map((col) => col.name));
      const addRawColumn = async (name, type) => {
        if (!rawExisting.has(name)) await db.execAsync(`ALTER TABLE raw_locations ADD COLUMN ${name} ${type};`);
      };
      await addRawColumn('tracking_mode', 'TEXT');
      const columns = await db.getAllAsync('PRAGMA table_info(logs)');
      const existing = new Set(columns.map((col) => col.name));
      const addColumn = async (name, type) => {
        if (!existing.has(name)) {
          await db.execAsync(`ALTER TABLE logs ADD COLUMN ${name} ${type};`);
        }
      };
      await addColumn('location', 'TEXT');
      await addColumn('signal_dbm', 'INTEGER');
      await addColumn('signal_level', 'INTEGER');
      await addColumn('carrier', 'TEXT');
      await addColumn('network_type', 'TEXT');
      await addColumn('processed_latitude', 'REAL');
      await addColumn('processed_longitude', 'REAL');
      await addColumn('distance_from_anchor_m', 'REAL');
      await addColumn('location_quality', 'INTEGER');
      await addColumn('movement_state', 'TEXT');
      await addColumn('is_valid_route_point', 'INTEGER');
      const processedColumns = await db.getAllAsync('PRAGMA table_info(processed_locations)');
      const processedExisting = new Set(processedColumns.map((col) => col.name));
      const addProcessedColumn = async (name, type) => {
        if (!processedExisting.has(name)) await db.execAsync(`ALTER TABLE processed_locations ADD COLUMN ${name} ${type};`);
      };
      await addProcessedColumn('trajectory_decision', 'TEXT');
      await addProcessedColumn('trajectory_reason', 'TEXT');
      await addProcessedColumn('distance_from_last_accepted_m', 'REAL');
      await addProcessedColumn('elapsed_time_ms', 'INTEGER');
      await addProcessedColumn('implied_speed_mps', 'REAL');
      await addProcessedColumn('reported_speed_mps', 'REAL');
      await addProcessedColumn('recent_median_speed_mps', 'REAL');
      await addProcessedColumn('bearing', 'REAL');
      await addProcessedColumn('bearing_change', 'REAL');
      await addProcessedColumn('accepted_reference_latitude', 'REAL');
      await addProcessedColumn('accepted_reference_longitude', 'REAL');
      await addProcessedColumn('raw_delivery_interval_ms', 'INTEGER');
      await addProcessedColumn('accepted_interval_ms', 'INTEGER');
      await addProcessedColumn('delivery_latency_ms', 'INTEGER');
      await addProcessedColumn('continuity_decision', 'TEXT');
      await addProcessedColumn('route_segment_type', 'TEXT');
      await addProcessedColumn('matcher_version', 'TEXT');
      await addProcessedColumn('gap_duration_ms', 'INTEGER');
      await addProcessedColumn('matched_way_id', 'TEXT');
      await addProcessedColumn('distance_from_matched_path_m', 'REAL');
      await addProcessedColumn('turn_detected', 'INTEGER');
      await addProcessedColumn('acceleration_mps2', 'REAL');
      await addProcessedColumn('stationary_anchor_latitude', 'REAL');
      await addProcessedColumn('stationary_anchor_longitude', 'REAL');
      // Four-mode tracking (userSelectedMode vs effectiveTrackingMode) and high-speed/recovery
      // diagnostics: additive columns only, existing rows simply read back null for these.
      await addProcessedColumn('user_selected_mode', 'TEXT');
      await addProcessedColumn('effective_mode', 'TEXT');
      await addProcessedColumn('mode_switch_event', 'TEXT');
      await addProcessedColumn('recovery_state', 'TEXT');
      await addProcessedColumn('high_speed_override', 'INTEGER');
      await addProcessedColumn('filter_reseeded', 'INTEGER');
      await addProcessedColumn('speed_agreement_mps', 'REAL');
      // 1 when the fix reported speed 0 / bearing 0 with no speed accuracy while clearly moving, so
      // reported speed was ignored for that fix (processing.js) — visible in exports.
      await addProcessedColumn('reported_speed_unavailable', 'INTEGER');
      await db.execAsync('CREATE INDEX IF NOT EXISTS raw_locations_session_time ON raw_locations(tracking_session_id, fix_timestamp_ms);');
      await db.execAsync('CREATE INDEX IF NOT EXISTS processed_locations_raw_fix ON processed_locations(raw_fix_id);');
      return db;
    });
  }
  return dbPromise;
}

export async function insertLog(row) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO logs (
      timestamp, latitude, longitude, accuracy, battery, app_state, method,
      location, signal_dbm, signal_level, carrier, network_type,
      processed_latitude, processed_longitude, distance_from_anchor_m,
      location_quality, movement_state, is_valid_route_point
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.timestamp,
      row.latitude,
      row.longitude,
      row.accuracy,
      row.battery,
      row.app_state,
      row.method,
      row.latitude != null && row.longitude != null ? `${row.latitude},${row.longitude}` : null,
      row.signal_dbm ?? null,
      row.signal_level ?? null,
      row.carrier ?? null,
      row.network_type ?? null,
      row.processed_latitude ?? row.latitude ?? null,
      row.processed_longitude ?? row.longitude ?? null,
      row.distance_from_anchor_m ?? null,
      row.location_quality ?? null,
      row.movement_state ?? null,
      row.is_valid_route_point ?? 1,
    ]
  );
}

const RAW_COLUMNS = [
  'tracking_session_id', 'tracking_mode', 'fix_timestamp_ms', 'received_timestamp_ms', 'fix_age_ms', 'elapsed_realtime_ns',
  'batch_id', 'batch_index', 'latitude', 'longitude', 'horizontal_accuracy_m', 'altitude_m',
  'vertical_accuracy_m', 'speed_mps', 'speed_accuracy_mps', 'bearing_deg', 'bearing_accuracy_deg',
  'provider', 'method', 'is_mock', 'app_state', 'battery_pct', 'motion_activity', 'step_count',
  'signal_dbm', 'signal_level', 'carrier', 'network_type', 'created_at',
];

// Raw and processed rows are paired by (batch_id, batch_index), not by array position. A raw row
// whose processed counterpart is missing is still inserted (raw evidence is never dropped); the
// count of those is returned so the caller can log a warning.
export async function insertLocationBatch(rawRows, processedRows) {
  const { pairs, unpairedRawCount } = pairRawWithProcessed(rawRows, processedRows);
  if (unpairedRawCount > 0) {
    console.warn(`insertLocationBatch: ${unpairedRawCount} raw row(s) have no processed row; inserting raw only`);
  }
  await serializeWrite(async () => {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const { raw, processed } of pairs) {
      const rawValues = RAW_COLUMNS.map((column) => raw[column] ?? null);
      const result = await db.runAsync(
        `INSERT INTO raw_locations (${RAW_COLUMNS.join(', ')}) VALUES (${RAW_COLUMNS.map(() => '?').join(', ')})`,
        rawValues
      );
      if (!processed) continue;
      await db.runAsync(
        `INSERT INTO processed_locations (
          raw_fix_id, tracking_session_id, algorithm_version, processing_status, processing_reason,
          filtered_latitude, filtered_longitude, predicted_latitude, predicted_longitude, innovation_m,
          normalized_innovation, estimated_uncertainty_m, position_confidence, movement_state, segment_id,
          is_route_point, map_matched_latitude, map_matched_longitude, map_match_status, map_match_confidence,
          interval_ms, raw_delivery_interval_ms, accepted_interval_ms, delivery_latency_ms, continuity_decision,
          route_segment_type, matcher_version, raw_to_filtered_m, gap_duration_ms, trajectory_decision, trajectory_reason,
          distance_from_last_accepted_m, elapsed_time_ms, implied_speed_mps, reported_speed_mps,
          recent_median_speed_mps, bearing, bearing_change, accepted_reference_latitude,
          accepted_reference_longitude, turn_detected, acceleration_mps2, stationary_anchor_latitude,
          stationary_anchor_longitude, user_selected_mode, effective_mode, mode_switch_event,
          recovery_state, high_speed_override, filter_reseeded, speed_agreement_mps,
          reported_speed_unavailable, created_at
        ) VALUES (${Array(53).fill('?').join(', ')})`,
        [result.lastInsertRowId, processed.tracking_session_id ?? null, processed.algorithm_version,
          processed.processing_status, processed.processing_reason, processed.filtered_latitude,
          processed.filtered_longitude, processed.predicted_latitude, processed.predicted_longitude,
          processed.innovation_m, processed.normalized_innovation, processed.estimated_uncertainty_m,
          processed.position_confidence, processed.movement_state, processed.segment_id, processed.is_route_point,
          processed.map_matched_latitude ?? null, processed.map_matched_longitude ?? null,
          processed.map_match_status ?? null, processed.map_match_confidence ?? null, processed.interval_ms ?? null,
          processed.raw_delivery_interval_ms ?? null, processed.accepted_interval_ms ?? null,
          processed.delivery_latency_ms ?? null, processed.continuity_decision ?? null,
          processed.route_segment_type ?? null, processed.matcher_version ?? null,
          processed.raw_to_filtered_m ?? null, processed.gap_duration_ms ?? null,
          processed.trajectory_decision ?? null, processed.trajectory_reason ?? null,
          processed.distance_from_last_accepted_m ?? null, processed.elapsed_time_ms ?? null,
          processed.implied_speed_mps ?? null, processed.reported_speed_mps ?? null,
          processed.recent_median_speed_mps ?? null, processed.bearing ?? null, processed.bearing_change ?? null,
          processed.accepted_reference_latitude ?? null, processed.accepted_reference_longitude ?? null,
          processed.turn_detected ?? null, processed.acceleration_mps2 ?? null,
          processed.stationary_anchor_latitude ?? null, processed.stationary_anchor_longitude ?? null,
          processed.user_selected_mode ?? null, processed.effective_mode ?? null,
          processed.mode_switch_event ?? null, processed.recovery_state ?? null,
          processed.high_speed_override ?? null, processed.filter_reseeded ?? null,
          processed.speed_agreement_mps ?? null,
          processed.reported_speed_unavailable ?? null,
          processed.created_at],
      );
    }
  });
  });
  return { unpairedRawCount };
}

// Persists the outcome of a final-session map-matching pass (section 36/39) back onto the
// existing processed_locations rows by raw_fix_id. Raw evidence itself is never touched — this
// only updates the derived matching columns, so a future matcher/OSM version can freely redo it.
export async function updateMatchDiagnostics(diagnostics) {
  if (!diagnostics.length) return;
  return serializeWrite(async () => {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const diag of diagnostics) {
      await db.runAsync(
        `UPDATE processed_locations SET
          map_matched_latitude = ?, map_matched_longitude = ?, map_match_status = ?,
          map_match_confidence = ?, matched_way_id = ?, distance_from_matched_path_m = ?,
          route_segment_type = ?, matcher_version = ?
        WHERE raw_fix_id = ?`,
        [diag.map_matched_latitude ?? null, diag.map_matched_longitude ?? null, diag.map_match_status ?? null,
          diag.map_match_confidence ?? null, diag.matched_way_id ?? null, diag.distance_from_matched_path_m ?? null,
          diag.route_segment_type ?? null, diag.matcher_version ?? null, diag.raw_fix_id],
      );
    }
  });
  });
}

export async function getAllLogs() {
  const db = await getDb();
  return db.getAllAsync('SELECT * FROM logs ORDER BY id');
}

// With a session id, only that session's rows (the background task must not process a new trip
// against the previous one's history); without one, every row (UI refresh and export).
export async function getAllRawLocations(sessionId) {
  const db = await getDb();
  if (sessionId == null) {
    return db.getAllAsync('SELECT * FROM raw_locations ORDER BY fix_timestamp_ms, id');
  }
  return db.getAllAsync(
    'SELECT * FROM raw_locations WHERE tracking_session_id = ? ORDER BY fix_timestamp_ms, id',
    [sessionId],
  );
}

// The session history the background task reprocesses with each delivery: the larger of the last
// `minFixes` fixes and every fix since `sinceMs` (same rule as taskHelpers.selectHistoryWindow,
// which tests/history-window.test.js checks against full-history processing). Ascending order.
export async function getRecentRawLocations(sessionId, { minFixes, sinceMs }) {
  const db = await getDb();
  const sinceTime = await db.getAllAsync(
    'SELECT * FROM raw_locations WHERE tracking_session_id = ? AND fix_timestamp_ms >= ? ORDER BY fix_timestamp_ms, id',
    [sessionId, sinceMs],
  );
  if (sinceTime.length >= minFixes) return sinceTime;
  const latest = await db.getAllAsync(
    'SELECT * FROM raw_locations WHERE tracking_session_id = ? ORDER BY fix_timestamp_ms DESC, id DESC LIMIT ?',
    [sessionId, minFixes],
  );
  return latest.reverse();
}

// Stored segment_id of an already-processed fix, used to continue segment numbering when only a
// window of the session is reprocessed. null when that fix has no processed row.
export async function getSegmentIdForRawFix(rawFixId) {
  const db = await getDb();
  const row = await db.getFirstAsync(
    'SELECT segment_id FROM processed_locations WHERE raw_fix_id = ? ORDER BY id DESC LIMIT 1',
    [rawFixId],
  );
  return row?.segment_id ?? null;
}

// Fallback anchor for segment re-basing: the newest processed row of the session (one query).
export async function getNewestProcessedSegment(sessionId) {
  const db = await getDb();
  return (await db.getFirstAsync(
    'SELECT raw_fix_id, segment_id FROM processed_locations WHERE tracking_session_id = ? ORDER BY raw_fix_id DESC, id DESC LIMIT 1',
    [sessionId],
  )) ?? null;
}

export async function getAllProcessedLocations() {
  const db = await getDb();
  return db.getAllAsync('SELECT * FROM processed_locations ORDER BY raw_fix_id, id');
}

export async function countLogs() {
  const db = await getDb();
  const result = await db.getFirstAsync('SELECT COUNT(*) as count FROM raw_locations');
  return result?.count ?? 0;
}

export async function clearLogs() {
  const db = await getDb();
  await db.execAsync('DELETE FROM processed_locations; DELETE FROM raw_locations; DELETE FROM logs;');
}
