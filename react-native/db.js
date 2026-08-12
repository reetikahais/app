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
      return db;
    });
  }
  return dbPromise;
}

export function getDbFileUri() {
  const path = `${SQLite.defaultDatabaseDirectory.replace(/\/*$/, '')}/gps_log.db`;
  return path.startsWith('file://') ? path : `file://${path}`;
}

export async function insertLog(row) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO logs (timestamp, latitude, longitude, accuracy, battery, app_state, method)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.timestamp, row.latitude, row.longitude, row.accuracy, row.battery, row.app_state, row.method]
  );
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
