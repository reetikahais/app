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
      return db;
    });
  }
  return dbPromise;
}

export async function insertLog(row) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO logs (timestamp, latitude, longitude, accuracy, battery, app_state, method, location, signal_dbm, signal_level, carrier, network_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
