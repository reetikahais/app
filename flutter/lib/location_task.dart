import 'dart:async';
import 'dart:ui';

import 'package:battery_plus/battery_plus.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_background_service_android/flutter_background_service_android.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:signal_info/signal_info.dart';
import 'package:sqflite/sqflite.dart';

import 'db.dart';
import 'logger.dart';

const String logIntervalPrefKey = 'log_interval_seconds';
const int defaultLogIntervalSeconds = 30;
const String notificationChannelId = 'gps_logger_channel';
const double maxAccuracyMeters = 50;

String classifyFixMethod(double? accuracy) {
  return accuracy != null && accuracy <= maxAccuracyMeters ? 'fused' : 'low_accuracy_fallback';
}

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
  if (!await Geolocator.isLocationServiceEnabled()) {
    await logEvent('error', {'reason': 'location_services_disabled'});
  } else {
    try {
      position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 25),
      );
    } catch (err) {
      position = null;
      await logEvent('error', {'reason': 'location_task_error', 'message': err.toString()});
    }
  }

  final signal = await getSignalInfo();

  await db.insert('logs', {
    'timestamp': (position?.timestamp ?? DateTime.now()).toIso8601String(),
    'latitude': position?.latitude,
    'longitude': position?.longitude,
    'accuracy': position?.accuracy,
    'battery': batteryLevel,
    'app_state': appState,
    'method': classifyFixMethod(position?.accuracy),
    'location': position != null ? '${position.latitude},${position.longitude}' : null,
    'signal_dbm': signal.signalDbm,
    'signal_level': signal.signalLevel,
    'carrier': signal.carrier,
    'network_type': signal.networkType,
  });

  await logEvent('location_task_fired', {
    'latitude': position?.latitude,
    'longitude': position?.longitude,
  });
  await recordHeartbeatAndDetectGap(signalGapThresholdMs);
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

  bool ticking = false;
  int count = 0;
  final timer = Timer.periodic(Duration(seconds: intervalSeconds), (timer) async {
    if (ticking) return;
    ticking = true;
    try {
      await _logOnce(db);
      count++;
      service.invoke('update', {'count': count});
    } finally {
      ticking = false;
    }
  });

  service.on('stopService').listen((event) {
    timer.cancel();
    service.stopSelf();
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
