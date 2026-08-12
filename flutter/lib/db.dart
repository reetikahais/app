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
    version: 1,
    onCreate: (db, version) => db.execute('''
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        battery INTEGER,
        app_state TEXT,
        method TEXT
      )
    '''),
  );
}

Future<int> countLogs(Database db) async {
  final result = await db.rawQuery('SELECT COUNT(*) as count FROM logs');
  return (result.first['count'] as int?) ?? 0;
}

Future<String> getDbFilePath() => _dbFilePath();

Future<void> clearLogs(Database db) async {
  await db.delete('logs');
}
