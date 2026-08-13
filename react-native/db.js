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
      if (!columns.some((col) => col.name === 'location')) {
        await db.execAsync('ALTER TABLE logs ADD COLUMN location TEXT;');
      }
      return db;
    });
  }
  return dbPromise;
}

export async function insertLog(row) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO logs (timestamp, latitude, longitude, accuracy, battery, app_state, method, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.timestamp,
      row.latitude,
      row.longitude,
      row.accuracy,
      row.battery,
      row.app_state,
      row.method,
      row.latitude != null && row.longitude != null ? `${row.latitude},${row.longitude}` : null,
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
