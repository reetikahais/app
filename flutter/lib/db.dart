import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

Future<String> _dbFilePath() async {
  final dir = await getApplicationDocumentsDirectory();
  return p.join(dir.path, 'gps_log.db');
}

Future<Database> openLogDb() async {
  final dbPath = await _dbFilePath();
  return openDatabase(
    dbPath,
    version: 7,
    onCreate: (db, version) => db.execute('''
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        battery INTEGER,
        app_state TEXT,
        method TEXT,
        location TEXT,
        signal_dbm INTEGER,
        signal_level INTEGER,
        carrier TEXT,
        network_type TEXT,
        movement_state TEXT,
        processed_latitude REAL,
        processed_longitude REAL,
        distance_from_anchor_m REAL,
        location_quality INTEGER,
        processing_version INTEGER,
        trajectory_decision TEXT,
        outlier_reason TEXT,
        implied_speed_mps REAL,
        distance_from_last_accepted_m REAL,
        movement_mode TEXT
      )
    '''),
    onUpgrade: (db, oldVersion, newVersion) async {
      if (oldVersion < 2) {
        await db.execute('ALTER TABLE logs ADD COLUMN location TEXT');
      }
      if (oldVersion < 3) {
        await db.execute('ALTER TABLE logs ADD COLUMN signal_dbm INTEGER');
        await db.execute('ALTER TABLE logs ADD COLUMN signal_level INTEGER');
        await db.execute('ALTER TABLE logs ADD COLUMN carrier TEXT');
        await db.execute('ALTER TABLE logs ADD COLUMN network_type TEXT');
      }
      if (oldVersion < 4) {
        await db.execute('ALTER TABLE logs ADD COLUMN movement_state TEXT');
        await db.execute('ALTER TABLE logs ADD COLUMN processed_latitude REAL');
        await db.execute('ALTER TABLE logs ADD COLUMN processed_longitude REAL');
        await db.execute('ALTER TABLE logs ADD COLUMN distance_from_anchor_m REAL');
      }
      if (oldVersion < 5) {
        await db.execute('ALTER TABLE logs ADD COLUMN location_quality INTEGER');
      }
      if (oldVersion < 6) {
        await db.execute('ALTER TABLE logs ADD COLUMN processing_version INTEGER');
      }
      if (oldVersion < 7) {
        await db.execute('ALTER TABLE logs ADD COLUMN trajectory_decision TEXT');
        await db.execute('ALTER TABLE logs ADD COLUMN outlier_reason TEXT');
        await db.execute('ALTER TABLE logs ADD COLUMN implied_speed_mps REAL');
        await db.execute('ALTER TABLE logs ADD COLUMN distance_from_last_accepted_m REAL');
        await db.execute('ALTER TABLE logs ADD COLUMN movement_mode TEXT');
      }
    },
  );
}

Future<int> countLogs(Database db) async {
  final result = await db.rawQuery('SELECT COUNT(*) as count FROM logs');
  return (result.first['count'] as int?) ?? 0;
}

Future<List<Map<String, Object?>>> getAllLogs(Database db) {
  return db.query('logs', orderBy: 'id');
}

Future<void> clearLogs(Database db) async {
  await db.delete('logs');
}
