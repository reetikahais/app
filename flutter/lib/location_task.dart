import 'dart:async';
import 'dart:ui';

import 'package:battery_plus/battery_plus.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_background_service_android/flutter_background_service_android.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';

import 'db.dart';
import 'logger.dart';

const String logIntervalPrefKey = 'log_interval_seconds';
const int defaultLogIntervalSeconds = 30;
const String notificationChannelId = 'gps_logger_channel';

Future<void> _logOnce(Database db) async {
  final prefs = await SharedPreferences.getInstance();
  final appState = prefs.getString(appStatePrefKey) ?? 'background';

  int? batteryLevel;
  try {
    batteryLevel = await Battery().batteryLevel;
  } catch (_) {
    batteryLevel = null;
  }

  Position? position;
  try {
    position = await Geolocator.getCurrentPosition(
      desiredAccuracy: LocationAccuracy.high,
    );
  } catch (err) {
    position = null;
    await logEvent('error', {'reason': 'location_task_error', 'message': err.toString()});
  }

  await db.insert('logs', {
    'timestamp': (position?.timestamp ?? DateTime.now()).toIso8601String(),
    'latitude': position?.latitude,
    'longitude': position?.longitude,
    'accuracy': position?.accuracy,
    'battery': batteryLevel,
    'app_state': appState,
    'method': 'fused',
    'location': position != null ? '${position.latitude},${position.longitude}' : null,
  });

  await logEvent('location_task_fired', {
    'latitude': position?.latitude,
    'longitude': position?.longitude,
  });
  await recordHeartbeat();
}

@pragma('vm:entry-point')
void onServiceStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();

  final prefs = await SharedPreferences.getInstance();
  final intervalSeconds =
      prefs.getInt(logIntervalPrefKey) ?? defaultLogIntervalSeconds;
  final db = await openLogDb();

  if (service is AndroidServiceInstance) {
    service.setForegroundNotificationInfo(
      title: 'RaahMitra GPS logger',
      content: 'Logging every $intervalSeconds s',
    );
  }

  int count = 0;
  Timer.periodic(Duration(seconds: intervalSeconds), (timer) async {
    await _logOnce(db);
    count++;
    service.invoke('update', {'count': count});
  });
}

// flutter_background_service names the notification channel via
// AndroidConfiguration.notificationChannelId but never creates it — startForeground()
// then throws "invalid channel for service notification" (RuntimeException, fatal on the
// OS side). Create the channel ourselves before configure() ever runs.
Future<void> _ensureNotificationChannel() async {
  final plugin = FlutterLocalNotificationsPlugin();
  await plugin.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
  );
  await plugin
      .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
      ?.createNotificationChannel(const AndroidNotificationChannel(
        notificationChannelId,
        'RaahMitra GPS Logger',
        description: 'Foreground notification for the GPS logging service',
        importance: Importance.low,
      ));
}

Future<void> initializeService() async {
  await _ensureNotificationChannel();
  final service = FlutterBackgroundService();
  await service.configure(
    androidConfiguration: AndroidConfiguration(
      onStart: onServiceStart,
      isForegroundMode: true,
      autoStart: false,
      notificationChannelId: notificationChannelId,
      initialNotificationTitle: 'RaahMitra GPS logger',
      initialNotificationContent: 'Starting...',
    ),
    iosConfiguration: IosConfiguration(),
  );
}
