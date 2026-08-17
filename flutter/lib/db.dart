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
    version: 3,
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
        network_type TEXT
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
