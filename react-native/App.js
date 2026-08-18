import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Button, PermissionsAndroid, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LOCATION_TASK_NAME,
  APP_STATE_KEY,
  LOG_INTERVAL_MS,
  DESIRED_INTERVAL_KEY,
  DESIRED_HIGH_ACCURACY_KEY,
} from './locationTask';
import { startWatch, stopWatch, restartWatchWithOptions } from './locationWatch';
import { countLogs, clearLogs, getAllLogs } from './db';
import {
  logEvent,
  recordHeartbeat,
  checkForMissedShutdown,
  clearEventsLog,
  getAllEvents,
} from './logger';
import { debounce } from './debounce';

const LIFECYCLE_DEBOUNCE_MS = 300;

export default function App() {
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const appState = useRef(AppState.currentState);
  const currentIntervalMs = useRef(LOG_INTERVAL_MS);
  const currentHighAccuracy = useRef(true);
  const runningRef = useRef(false);

  useEffect(() => {
    checkForMissedShutdown();
    AsyncStorage.setItem(APP_STATE_KEY, 'foreground');

    const applyAppStateChange = debounce((next) => {
      appState.current = next;
      AsyncStorage.setItem(
        APP_STATE_KEY,
        next === 'active' ? 'foreground' : 'background'
      );
      logEvent(next === 'active' ? 'app_foreground' : 'app_background');
    }, LIFECYCLE_DEBOUNCE_MS);

    const sub = AppState.addEventListener('change', applyAppStateChange);

    Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).then((started) => {
      runningRef.current = started;
      setRunning(started);
    });

    // Applies polling-interval-tier and accuracy-mode changes computed by the background task.
    // Expo has no API to retune an active watch's timeInterval/accuracy - restarting it is only
    // documented-safe from foreground JS (not from inside the task callback itself), so this
    // foreground poll is where that restart actually happens. See locationWatch.js and the design
    // doc's "Adaptive polling frequency" section - this means tier/accuracy changes only take
    // effect while the app is foregrounded.
    const interval = setInterval(async () => {
      setCount(await countLogs());

      if (!runningRef.current) return;
      const [desiredIntervalRaw, desiredHighAccuracyRaw] = await Promise.all([
        AsyncStorage.getItem(DESIRED_INTERVAL_KEY),
        AsyncStorage.getItem(DESIRED_HIGH_ACCURACY_KEY),
      ]);
      const desiredInterval = desiredIntervalRaw ? Number(desiredIntervalRaw) : null;
      const desiredHighAccuracy = desiredHighAccuracyRaw != null ? desiredHighAccuracyRaw === '1' : null;
      const intervalChanged = desiredInterval && desiredInterval !== currentIntervalMs.current;
      const accuracyChanged = desiredHighAccuracy != null && desiredHighAccuracy !== currentHighAccuracy.current;
      if (intervalChanged || accuracyChanged) {
        const nextInterval = desiredInterval ?? currentIntervalMs.current;
        const nextHighAccuracy = desiredHighAccuracy ?? currentHighAccuracy.current;
        try {
          await restartWatchWithOptions(nextInterval, { highAccuracy: nextHighAccuracy });
          currentIntervalMs.current = nextInterval;
          currentHighAccuracy.current = nextHighAccuracy;
          await logEvent('polling_settings_changed', { interval_ms: nextInterval, high_accuracy: nextHighAccuracy });
        } catch (err) {
          console.error('Failed to apply new polling settings', err);
        }
      }
    }, 5000);

    return () => {
      sub.remove();
      applyAppStateChange.cancel();
      clearInterval(interval);
    };
  }, []);

  async function start() {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return;

    // Android refuses to start a location-type foreground service unless the app is currently
    // foregrounded at that exact call. startWatch() must run before anything below that opens a
    // separate Activity (the battery-optimization Settings screen) - that navigation backgrounds
    // this app immediately, and if the FGS start call landed after that we'd hit "Couldn't start
    // the foreground service: Foreground service cannot be started when the application is in
    // the background" instead of ever starting tracking.
    await startWatch(LOG_INTERVAL_MS, { highAccuracy: true });
    currentIntervalMs.current = LOG_INTERVAL_MS;
    currentHighAccuracy.current = true;
    await AsyncStorage.removeItem(DESIRED_INTERVAL_KEY);
    await AsyncStorage.removeItem(DESIRED_HIGH_ACCURACY_KEY);
    await recordHeartbeat('start_tracking');
    runningRef.current = true;
    setRunning(true);

    if (Platform.OS === 'android') {
      try {
        await IntentLauncher.startActivityAsync(
          'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
          { data: 'package:com.raahmitra.gpslogger' }
        );
      } catch (err) {
        console.error('battery optimization exemption request failed', err);
      }

      try {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE);
      } catch (err) {
        console.error('READ_PHONE_STATE request failed', err);
      }
    }
  }

  async function stop() {
    await stopWatch();
    await recordHeartbeat('stop_tracking');
    runningRef.current = false;
    setRunning(false);
  }

  async function exportLogs() {
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Export failed', 'Sharing is not available on this device.');
        return;
      }

      const [logs, events] = await Promise.all([getAllLogs(), getAllEvents()]);
      const payload = {
        exported_at: new Date().toISOString(),
        logs,
        events,
      };

      const file = new File(Paths.document, 'raahmitra_export.json');
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(payload, null, 2));

      await Sharing.shareAsync(file.uri);
    } catch (err) {
      console.error('Export failed', err);
      Alert.alert('Export failed', String(err?.message ?? err));
    }
  }

  function confirmClearLogs() {
    Alert.alert(
      'Clear logs?',
      'This deletes all rows in gps_log.db and events.log. Cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearLogs();
              clearEventsLog();
              setCount(0);
            } catch (err) {
              Alert.alert('Clear failed', String(err?.message ?? err));
            }
          },
        },
      ]
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>RaahMitra GPS Logger (React Native)</Text>
      <Text style={styles.status}>{running ? 'RUNNING' : 'STOPPED'}</Text>
      <Text style={styles.count}>Logs written: {count}</Text>
      <Button title={running ? 'Stop logging' : 'Start logging'} onPress={running ? stop : start} />
      <Button title="Export Logs" onPress={exportLogs} />
      <Button title="Clear Logs" color="#c0392b" onPress={confirmClearLogs} />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 12, textAlign: 'center' },
  status: { fontSize: 22, fontWeight: 'bold' },
  count: { fontSize: 18 },
});
