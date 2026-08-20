import * as SQLite from 'expo-sqlite';

let dbPromise = null;

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
      `);
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
      await addColumn('movement_state', 'TEXT');
      await addColumn('processed_latitude', 'REAL');
      await addColumn('processed_longitude', 'REAL');
      await addColumn('distance_from_anchor_m', 'REAL');
      await addColumn('location_quality', 'INTEGER');
      await addColumn('processing_version', 'INTEGER');
      await addColumn('trajectory_decision', 'TEXT');
      await addColumn('outlier_reason', 'TEXT');
      await addColumn('implied_speed_mps', 'REAL');
      await addColumn('distance_from_last_accepted_m', 'REAL');
      await addColumn('movement_mode', 'TEXT');
      return db;
    });
  }
  return dbPromise;
}

export async function insertLog(row) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO logs (timestamp, latitude, longitude, accuracy, battery, app_state, method, location, signal_dbm, signal_level, carrier, network_type, movement_state, processed_latitude, processed_longitude, distance_from_anchor_m, location_quality, processing_version, trajectory_decision, outlier_reason, implied_speed_mps, distance_from_last_accepted_m, movement_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.movement_state ?? null,
      row.processed_latitude ?? null,
      row.processed_longitude ?? null,
      row.distance_from_anchor_m ?? null,
      row.location_quality ?? null,
      row.processing_version ?? null,
      row.trajectory_decision ?? null,
      row.outlier_reason ?? null,
      row.implied_speed_mps ?? null,
      row.distance_from_last_accepted_m ?? null,
      row.movement_mode ?? null,
    ]
  );
}

export async function getAllLogs() {
  const db = await getDb();
  return db.getAllAsync('SELECT * FROM logs ORDER BY id');
}

export async function countLogs() {
  const db = await getDb();
  const result = await db.getFirstAsync('SELECT COUNT(*) as count FROM logs');
  return result?.count ?? 0;
}

export async function clearLogs() {
  const db = await getDb();
  await db.execAsync('DELETE FROM logs;');
}
