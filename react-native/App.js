import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Button, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LOCATION_TASK_NAME, APP_STATE_KEY, LOG_INTERVAL_MS } from './locationTask';
import { countLogs, clearLogs, getAllLogs } from './db';
import {
  logEvent,
  recordHeartbeat,
  checkForMissedShutdown,
  clearEventsLog,
  getAllEvents,
} from './logger';

export default function App() {
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    checkForMissedShutdown();
    AsyncStorage.setItem(APP_STATE_KEY, 'foreground');

    const sub = AppState.addEventListener('change', (next) => {
      appState.current = next;
      AsyncStorage.setItem(
        APP_STATE_KEY,
        next === 'active' ? 'foreground' : 'background'
      );
      logEvent(next === 'active' ? 'app_foreground' : 'app_background');
    });

    Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).then(setRunning);

    const interval = setInterval(async () => {
      setCount(await countLogs());
    }, 5000);

    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  async function start() {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return;

    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: LOG_INTERVAL_MS,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'RaahMitra GPS logger',
        notificationBody: `Logging every ${LOG_INTERVAL_MS / 1000}s`,
      },
    });
    await recordHeartbeat('start_tracking');
    setRunning(true);
  }

  async function stop() {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    await recordHeartbeat('stop_tracking');
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
