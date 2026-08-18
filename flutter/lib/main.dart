import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:cross_file/cross_file.dart';
import 'package:flutter/material.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'db.dart';
import 'debouncer.dart';
import 'location_task.dart';
import 'logger.dart';

const Duration lifecycleDebounceDelay = Duration(milliseconds: 300);

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final previousFlutterOnError = FlutterError.onError;
  FlutterError.onError = (FlutterErrorDetails details) {
    // Fire-and-forget: crash handling must not wait on (or be broken by) the log write.
    logEvent('error', {
      'reason': 'flutter_error',
      'message': details.exceptionAsString(),
    });
    previousFlutterOnError?.call(details);
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    logEvent('error', {'reason': 'uncaught_error', 'message': error.toString()});
    return false;
  };

  await checkForMissedShutdown(defaultLogIntervalSeconds);
  await initializeService();
  runApp(const LoggerApp());
}

Future<void> requestPermissions() async {
  // Android 11+ auto-denies locationAlways if requested before foreground
  // location is granted — must request in this order.
  final foreground = await Permission.locationWhenInUse.request();
  if (foreground.isGranted) {
    await Permission.locationAlways.request();
  }
  await Permission.notification.request();
  await Permission.ignoreBatteryOptimizations.request();
  await Permission.phone.request();
}

class LoggerApp extends StatelessWidget {
  const LoggerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RaahMitra GPS Logger',
      home: const LoggerHome(),
    );
  }
}

class LoggerHome extends StatefulWidget {
  const LoggerHome({super.key});

  @override
  State<LoggerHome> createState() => _LoggerHomeState();
}

class _LoggerHomeState extends State<LoggerHome> with WidgetsBindingObserver {
  int _count = 0;
  bool _running = false;
  final _lifecycleDebouncer = Debouncer(lifecycleDebounceDelay);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _setAppState('foreground');
    _syncRunningState();

    FlutterBackgroundService().on('update').listen((event) {
      if (event == null) return;
      setState(() => _count = event['count'] as int);
    });
  }

  // _running is in-memory only and resets to false on every relaunch — if the
  // service is still alive from before the app was killed/swiped away, ask
  // the OS for the real state instead of assuming stopped.
  Future<void> _syncRunningState() async {
    final running = await FlutterBackgroundService().isRunning();
    if (mounted) setState(() => _running = running);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _lifecycleDebouncer.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final next = state == AppLifecycleState.resumed ? 'foreground' : 'background';
    _lifecycleDebouncer.run(() {
      _setAppState(next);
      logEvent(next == 'foreground' ? 'app_foreground' : 'app_background');
    });
  }

  Future<void> _setAppState(String value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(appStatePrefKey, value);
  }

  Future<void> _start() async {
    try {
      await requestPermissions();
      await FlutterBackgroundService().startService();
      await recordHeartbeat('start_tracking');
      await logEvent('start_tracking', {'reason': 'user_action'});
      setState(() => _running = true);
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Start failed: $err')),
      );
    }
  }

  Future<void> _stop() async {
    try {
      FlutterBackgroundService().invoke('stopService');
      await recordHeartbeat('stop_tracking');
      await logEvent('stop_tracking', {'reason': 'user_action'});
      setState(() => _running = false);
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Stop failed: $err')),
      );
    }
  }

  Future<void> _exportLogs() async {
    try {
      final db = await openLogDb();
      final logs = await getAllLogs(db);
      final events = await getAllEvents();

      final payload = {
        'exported_at': DateTime.now().toIso8601String(),
        'logs': logs,
        'events': events,
      };

      final dir = await getApplicationDocumentsDirectory();
      final exportFile = File(p.join(dir.path, 'raahmitra_flutter_export.json'));
      await exportFile.writeAsString(
        const JsonEncoder.withIndent('  ').convert(payload),
      );

      await SharePlus.instance.share(ShareParams(files: [XFile(exportFile.path)]));
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Export failed: $err')),
      );
    }
  }

  Future<void> _confirmClearLogs() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear logs?'),
        content: const Text(
          'This deletes all rows in gps_log.db and events.log. Cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      final db = await openLogDb();
      await clearLogs(db);
      await clearEventsLog();
      setState(() => _count = 0);
    } catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Clear failed: $err')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('RaahMitra GPS Logger (Flutter)')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_running ? 'RUNNING' : 'STOPPED',
                style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 16),
            Text('Logs written: $_count',
                style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 32),
            ElevatedButton(
              onPressed: _running ? _stop : _start,
              child: Text(_running ? 'Stop logging' : 'Start logging'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: _exportLogs,
              child: const Text('Export Logs'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: Colors.red.shade700),
              onPressed: _confirmClearLogs,
              child: const Text('Clear Logs'),
            ),
          ],
        ),
      ),
    );
  }
}
