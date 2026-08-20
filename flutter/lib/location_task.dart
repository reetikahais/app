import 'dart:async';
import 'dart:convert';
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
import 'movement_state_machine.dart';
import 'trajectory_validator.dart';

const String logIntervalPrefKey = 'log_interval_seconds';
const int defaultLogIntervalSeconds = 30;
const String notificationChannelId = 'gps_logger_channel';
const double maxAccuracyMeters = 50;
const String movementStatePrefKey = 'movement_state_v1';
const String trajectoryStatePrefKey = 'trajectory_state_v1';

String classifyFixMethod(double? accuracy) {
  return accuracy != null && accuracy <= maxAccuracyMeters ? 'fused' : 'low_accuracy_fallback';
}

Future<MovementState> _loadMovementState(SharedPreferences prefs) async {
  final raw = prefs.getString(movementStatePrefKey);
  if (raw == null) return createInitialMovementState();
  try {
    return movementStateFromJson(jsonDecode(raw) as Map<String, dynamic>);
  } catch (_) {
    return createInitialMovementState();
  }
}

Future<void> _saveMovementState(SharedPreferences prefs, MovementState state) async {
  await prefs.setString(movementStatePrefKey, jsonEncode(movementStateToJson(state)));
}

Future<TrajectoryState> _loadTrajectoryState(SharedPreferences prefs) async {
  final raw = prefs.getString(trajectoryStatePrefKey);
  if (raw == null) return createInitialTrajectoryState();
  try {
    return trajectoryStateFromJson(jsonDecode(raw) as Map<String, dynamic>);
  } catch (_) {
    return createInitialTrajectoryState();
  }
}

Future<void> _saveTrajectoryState(SharedPreferences prefs, TrajectoryState state) async {
  await prefs.setString(trajectoryStatePrefKey, jsonEncode(trajectoryStateToJson(state)));
}

// Returns the polling interval (seconds) the caller should use for the *next* tick, based on
// the movement state resulting from this fix. Falls back to `currentIntervalSeconds` unchanged
// when there's no usable fix to base a decision on.
Future<int> _logOnce(Database db, int currentIntervalSeconds) async {
  final prefs = await SharedPreferences.getInstance();
  final appState = prefs.getString(appStatePrefKey) ?? 'background';

  int? batteryLevel;
  try {
    batteryLevel = await Battery().batteryLevel;
  } catch (_) {
    batteryLevel = null;
  }

  // Change 4: the *previous* movement state decides how precise to ask for - there's no fix yet
  // to base this tick's own classification on. STATIONARY requests Balanced (Android's "~100m"
  // tier); any state with a chance of movement requests high accuracy. The OS/hardware still
  // decides what it can actually deliver - this only requests, it doesn't guarantee, better fixes.
  final movementStateBeforeThisFix = await _loadMovementState(prefs);
  final desiredAccuracy =
      wantsHighAccuracy(movementStateBeforeThisFix) ? LocationAccuracy.high : LocationAccuracy.medium;

  Position? position;
  if (!await Geolocator.isLocationServiceEnabled()) {
    await logEvent('error', {'reason': 'location_services_disabled'});
  } else {
    try {
      position = await Geolocator.getCurrentPosition(
        desiredAccuracy: desiredAccuracy,
        timeLimit: const Duration(seconds: 25),
      );
    } catch (err) {
      position = null;
      await logEvent('error', {'reason': 'location_task_error', 'message': err.toString()});
    }
  }

  final signal = await getSignalInfo();

  String? movementStateName;
  double? processedLatitude;
  double? processedLongitude;
  double? distanceFromAnchorM;
  int? locationQuality;
  String? trajectoryDecision;
  String? outlierReason;
  double? impliedSpeedMps;
  double? distanceFromLastAcceptedM;
  String? movementMode;
  var nextIntervalSeconds = currentIntervalSeconds;
  var trajectoryState = await _loadTrajectoryState(prefs);

  if (position != null && position.accuracy > 0) {
    final fix = TrajectoryFix(
      lat: position.latitude,
      lon: position.longitude,
      accuracy: position.accuracy,
      speed: position.speed,
      timestampMs: position.timestamp.millisecondsSinceEpoch,
    );

    // Step2/16: trajectory validation runs BEFORE the movement state machine - only an ACCEPTED
    // fix is allowed to update lastAcceptedFix, movement state, smoothing, or the processed
    // trail. OUTLIER/UNCERTAIN fixes are still stored raw below, untouched.
    final trajectoryOutcome = classifyFix(trajectoryState, fix);
    trajectoryState = trajectoryOutcome.newState;
    trajectoryDecision = trajectoryOutcome.result.decision;
    outlierReason = trajectoryOutcome.result.reason;
    impliedSpeedMps = trajectoryOutcome.result.impliedSpeedMps;
    distanceFromLastAcceptedM = trajectoryOutcome.result.distanceFromLastAcceptedM;
    movementMode = trajectoryOutcome.result.movementMode;

    if (trajectoryOutcome.result.decision == TrajectoryDecision.accepted) {
      final movementFix = LocationFix(
        lat: position.latitude,
        lon: position.longitude,
        accuracy: position.accuracy,
        speed: position.speed,
        timestampMs: position.timestamp.millisecondsSinceEpoch,
      );
      final movementState = processLocationFix(movementStateBeforeThisFix, movementFix);
      await _saveMovementState(prefs, movementState);

      final processed = getProcessedLocation(movementState);
      movementStateName = movementState.state;
      processedLatitude = processed.lat;
      processedLongitude = processed.lon;
      distanceFromAnchorM = getDistanceFromAnchorM(movementState, movementFix);
      locationQuality = getLocationQuality(movementState, movementFix);

      final intervalMs = computePollingIntervalMs(movementState, DateTime.now().millisecondsSinceEpoch, appState);
      nextIntervalSeconds = (intervalMs / 1000).round();
    }
  }
  await _saveTrajectoryState(prefs, trajectoryState);

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
    'movement_state': movementStateName,
    'processed_latitude': processedLatitude,
    'processed_longitude': processedLongitude,
    'distance_from_anchor_m': distanceFromAnchorM,
    'location_quality': locationQuality,
    'processing_version': processingVersion,
    'trajectory_decision': trajectoryDecision,
    'outlier_reason': outlierReason,
    'implied_speed_mps': impliedSpeedMps,
    'distance_from_last_accepted_m': distanceFromLastAcceptedM,
    'movement_mode': movementMode,
  });

  await logEvent('location_task_fired', {
    'latitude': position?.latitude,
    'longitude': position?.longitude,
  });
  await recordHeartbeatAndDetectGap(signalGapThresholdMs);

  return nextIntervalSeconds;
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
  Timer? timer;

  void scheduleTick(int seconds) {
    timer?.cancel();
    timer = Timer.periodic(Duration(seconds: seconds), (_) async {
      if (ticking) return;
      ticking = true;
      try {
        final nextIntervalSeconds = await _logOnce(db, seconds);
        count++;
        service.invoke('update', {'count': count});
        if (service is AndroidServiceInstance) {
          service.setForegroundNotificationInfo(
            title: 'RaahMitra GPS logger',
            content: 'Logging every $nextIntervalSeconds s',
          );
        }
        if (nextIntervalSeconds != seconds) {
          scheduleTick(nextIntervalSeconds);
        }
      } finally {
        ticking = false;
      }
    });
  }

  scheduleTick(intervalSeconds);

  service.on('stopService').listen((event) {
    timer?.cancel();
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
