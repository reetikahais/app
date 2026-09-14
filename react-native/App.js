import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LOCATION_TASK_NAME, APP_STATE_KEY } from './trackingConfig';
import { countLogs, clearLogs, getAllLogs, getAllRawLocations, getAllProcessedLocations, updateMatchDiagnostics } from './db';
import {
  MATCHER_ENDPOINT, ACTIVE_PROFILE_KEY, TRACKING_MODE_KEY, TRACKING_MODES,
  MODE_PROFILES, BASE_PROCESSING_CONFIG, POLLING_PROFILES, getPollingProfile, getTrackingProfile,
} from './trackingConfig';
import { buildAnimatedMapHtml } from './animatedMapExport';
import {
  buildGpsRouteSegments, matchSequence, matchSequenceChunked, resolveSegment,
  collectMatchDiagnostics, MATCHER_VERSION,
} from './routeMatching';
import { createRoadState, updateRoadState, splitCommittedTentative } from './routeConfidence';
import { computeSessionStats } from './sessionStats';
import {
  logEvent,
  recordHeartbeat,
  checkForMissedShutdown,
  clearEventsLog,
  getAllEvents,
} from './logger';

const LIVE_MATCH_THROTTLE_MS = 10000;
const LIVE_MATCH_TAIL_POINTS = 15;
const BATTERY_OPT_REQUESTED_KEY = 'battery_optimization_requested';

// Android refuses to start a foreground service while the app is backgrounded. Returning from a
// system settings/permission screen can land here a beat before the app is reported active again,
// so give it a moment to catch up rather than racing Location.startLocationUpdatesAsync.
function waitForAppActive() {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        sub.remove();
        resolve();
      }
    });
    setTimeout(() => {
      sub.remove();
      resolve();
    }, 3000);
  });
}

// Loaded once; live updates after this are pushed in via injectJavaScript (window.updateRoute /
// window.updateLive) instead of replacing `source`, so the live marker animates smoothly instead
// of the whole WebView reloading every refresh tick (section 21). Route geometry and the live
// marker are driven by two independent calls, matching section 22.
function buildLiveMapShellHtml() {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0;background:#eaf2f6} .leaflet-control-attribution{font-size:9px}</style>
</head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const map = L.map('map').setView([31.1048, 77.1734], 14);
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Esri, Maxar, Earthstar Geographics'
});
L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
let liveMarker = null, accuracyCircle = null, fitted = false;

window.updateRoute = function (routesJson) {
  const routes = JSON.parse(routesJson);
  routeLayer.clearLayers();
  const bounds = [];
  routes.forEach((route) => {
    if (route.coordinates.length < 2) return;
    route.coordinates.forEach((coordinate) => bounds.push(coordinate));
    L.polyline(route.coordinates, {
      color: route.type === 'MAP_MATCHED' ? '#2f8f4e' : (route.type === 'GAP' ? '#9aa5ad' : '#d39b22'),
      weight: route.tentative ? 4 : 5,
      opacity: route.type === 'GAP' ? 0.5 : (route.tentative ? 0.55 : 0.9),
      dashArray: route.type === 'GAP' ? '8 8' : (route.tentative ? '4 6' : null)
    }).addTo(routeLayer);
  });
  if (routes[0] && routes[0].coordinates[0]) L.marker(routes[0].coordinates[0]).addTo(routeLayer).bindPopup('Start');
  if (bounds.length && !fitted) { map.fitBounds(bounds, { padding: [24, 24] }); fitted = true; }
};

window.updateLive = function (lat, lng, accuracyM) {
  const target = [lat, lng];
  if (!liveMarker) {
    liveMarker = L.marker(target).addTo(map).bindPopup('Current position');
    accuracyCircle = L.circle(target, { radius: accuracyM || 10, color: '#1769aa', fillOpacity: 0.18, weight: 1 }).addTo(map);
    if (!fitted) { map.setView(target, 17); fitted = true; }
    return;
  }
  accuracyCircle.setRadius(accuracyM || 10);
  const start = liveMarker.getLatLng();
  const startTime = performance.now();
  const durationMs = 700;
  (function step(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    const lat2 = start.lat + (lat - start.lat) * t;
    const lng2 = start.lng + (lng - start.lng) * t;
    liveMarker.setLatLng([lat2, lng2]);
    accuracyCircle.setLatLng([lat2, lng2]);
    if (t < 1) requestAnimationFrame(step);
  })(startTime);
};
</script></body></html>`;
}

// The mode picker re-enables once stopped, so a user could switch it before pressing Export —
// export/finalize must reflect what the session was actually recorded with, not whatever the
// picker currently shows. tracking_mode is stamped on every raw row (locationTask.js), so the
// recorded rows are the source of truth; the current picker state is only a fallback for an
// empty/legacy session.
function sessionModeFromRows(rawRows, fallbackMode) {
  return rawRows.find((row) => row.tracking_mode)?.tracking_mode || fallbackMode;
}

function segmentsToRouteJson(segments) {
  return JSON.stringify(segments.map((segment) => ({
    type: segment.segmentType,
    coordinates: segment.coordinates.map((point) => [point.latitude, point.longitude]),
    tentative: Boolean(segment.tentative),
  })));
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const [trackingMode, setTrackingMode] = useState(TRACKING_MODES.WALK);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [rawCount, setRawCount] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const [sessionStats, setSessionStats] = useState(null);
  const latestLiveTimestamp = useRef(0);
  const appState = useRef(AppState.currentState);
  const webViewRef = useRef(null);
  const webViewReady = useRef(false);
  const matchedCacheRef = useRef(new Map());
  const roadStateBySegment = useRef(new Map());
  const lastLiveMatchAt = useRef(0);
  const pendingRouteJson = useRef(null);
  const pendingLive = useRef(null);
  const mapHtml = useMemo(() => buildLiveMapShellHtml(), []);

  function pushRoute(segments) {
    const json = segmentsToRouteJson(segments);
    if (!webViewReady.current) { pendingRouteJson.current = json; return; }
    webViewRef.current?.injectJavaScript(`window.updateRoute && window.updateRoute(${JSON.stringify(json)}); true;`);
  }

  function pushLive(latitude, longitude, accuracyM) {
    if (!webViewReady.current) { pendingLive.current = [latitude, longitude, accuracyM]; return; }
    webViewRef.current?.injectJavaScript(`window.updateLive && window.updateLive(${latitude}, ${longitude}, ${accuracyM || 0}); true;`);
  }

  function onWebViewLoadEnd() {
    webViewReady.current = true;
    if (pendingRouteJson.current) {
      webViewRef.current?.injectJavaScript(`window.updateRoute && window.updateRoute(${JSON.stringify(pendingRouteJson.current)}); true;`);
    }
    if (pendingLive.current) {
      const [latitude, longitude, accuracyM] = pendingLive.current;
      webViewRef.current?.injectJavaScript(`window.updateLive && window.updateLive(${latitude}, ${longitude}, ${accuracyM || 0}); true;`);
    }
  }

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
    AsyncStorage.getItem(TRACKING_MODE_KEY).then((stored) => {
      if (stored === TRACKING_MODES.WALK || stored === TRACKING_MODES.BIKE) setTrackingMode(stored);
    });

    // Bounded live map matching (section 36): only the tail of the currently open segment is
    // (re)matched, on a throttle, and each closed segment is matched at most once. No endpoint
    // configured means matchSequence resolves instantly to the GPS fallback, so this stays
    // cheap even while disabled.
    async function refreshLiveMatching(fallbackSegments, rowsByRawFixId) {
      if (!MATCHER_ENDPOINT || !fallbackSegments.length) return;
      const closed = fallbackSegments.slice(0, -1);
      for (const segment of closed) {
        if (matchedCacheRef.current.has(segment.segmentId)) continue;
        const segRows = segment.rawFixIds.map((id) => rowsByRawFixId.get(id)).filter(Boolean);
        const [resolved] = await matchSequence(segRows, { endpoint: MATCHER_ENDPOINT, mode: trackingMode });
        if (resolved) matchedCacheRef.current.set(segment.segmentId, resolved);
      }
      const open = fallbackSegments[fallbackSegments.length - 1];
      const now = Date.now();
      if (now - lastLiveMatchAt.current >= LIVE_MATCH_THROTTLE_MS) {
        lastLiveMatchAt.current = now;
        const tailIds = open.rawFixIds.slice(-LIVE_MATCH_TAIL_POINTS);
        const tailRows = tailIds.map((id) => rowsByRawFixId.get(id)).filter(Boolean);
        const [resolved] = await matchSequence(tailRows, { endpoint: MATCHER_ENDPOINT, mode: trackingMode });
        if (resolved) {
          matchedCacheRef.current.set(open.segmentId, resolved);
          // Road-lock (sections 17-19): track which way this segment's tail is currently matched
          // to, and only let a different candidate take over after enough consecutive corroborated
          // observations — a single closer-looking match on a parallel road is not enough evidence.
          const candidate = resolved.matchedWayId != null
            ? { matchedWayId: resolved.matchedWayId, confidence: resolved.confidence, headingCompatible: true }
            : null;
          roadStateBySegment.current.set(
            open.segmentId,
            updateRoadState(roadStateBySegment.current.get(open.segmentId), candidate),
          );
        }
      }
    }

    async function refreshMap() {
      const [nextCount, rawRows, processedRows] = await Promise.all([
        countLogs(), getAllRawLocations(), getAllProcessedLocations(),
      ]);
      setCount(nextCount);
      setRawCount(rawRows.length);
      setProcessedCount(processedRows.length);
      const rawById = new Map(rawRows.map((row) => [row.id, row]));
      const rows = processedRows.map((row) => ({ ...rawById.get(row.raw_fix_id), ...row }));
      setAcceptedCount(rows.filter((row) => row.is_route_point && row.trajectory_decision === 'ACCEPTED').length);

      const fallbackSegments = buildGpsRouteSegments(rows);
      const rowsByRawFixId = new Map(rows.map((row) => [row.raw_fix_id, row]));
      await refreshLiveMatching(fallbackSegments, rowsByRawFixId);
      const displaySegments = fallbackSegments.map(
        (segment) => matchedCacheRef.current.get(segment.segmentId) ?? resolveSegment(null, segment),
      );
      // Only the currently-open segment's tail is still subject to change; every closed segment is
      // matched at most once (see refreshLiveMatching above) and renders fully committed. Splitting
      // just the open segment's coordinates keeps the historical line from visibly jumping every
      // refresh tick (section 30) while the live tail can still be revised.
      const openSegmentId = fallbackSegments.at(-1)?.segmentId;
      const routeEntries = displaySegments.flatMap((segment) => {
        if (segment.segmentId !== openSegmentId) {
          return [{ segmentType: segment.segmentType, coordinates: segment.coordinates, tentative: false }];
        }
        const { committedCoordinates, tentativeCoordinates } = splitCommittedTentative(
          segment.coordinates, roadStateBySegment.current.get(segment.segmentId),
        );
        const entries = [];
        if (committedCoordinates.length >= 2) entries.push({ segmentType: segment.segmentType, coordinates: committedCoordinates, tentative: false });
        if (tentativeCoordinates.length >= 2) entries.push({ segmentType: segment.segmentType, coordinates: tentativeCoordinates, tentative: true });
        if (!entries.length) entries.push({ segmentType: segment.segmentType, coordinates: segment.coordinates, tentative: true });
        return entries;
      });
      pushRoute(routeEntries);

      const latest = rows
        .filter((row) => row.trajectory_decision === 'ACCEPTED' && row.is_live_fresh && row.filtered_latitude != null)
        .sort((a, b) => Number(b.fix_timestamp_ms) - Number(a.fix_timestamp_ms))[0];
      if (latest && Number(latest.fix_timestamp_ms) >= latestLiveTimestamp.current) {
        latestLiveTimestamp.current = Number(latest.fix_timestamp_ms);
        pushLive(Number(latest.filtered_latitude), Number(latest.filtered_longitude), Number(latest.horizontal_accuracy_m ?? latest.accuracy ?? 0));
      }
    }
    refreshMap();
    const interval = setInterval(refreshMap, 2000);

    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  async function start() {
    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        Alert.alert('Location is disabled', 'Turn on the phone Location setting, then press Start logging again.');
        return;
      }

      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        Alert.alert('Location permission required', 'Allow precise location access while using the app, then press Start logging again.');
        return;
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (bg.status !== 'granted') {
        Alert.alert('Background location required', 'Allow background or all-the-time location access in Android Settings, then press Start logging again.');
        return;
      }

    if (Platform.OS === 'android') {
      // Only launch these system screens once (on cold start with no prior grant/decision).
      // Re-launching the battery-optimization settings activity on every start() briefly
      // backgrounds the app; when the exemption is already granted, Android finishes that
      // activity almost instantly, and starting the location foreground service right after
      // can race Android's "not allowed to start foreground service while in background" check.
      const batteryOptRequested = await AsyncStorage.getItem(BATTERY_OPT_REQUESTED_KEY);
      if (!batteryOptRequested) {
        try {
          await IntentLauncher.startActivityAsync(
            'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
            { data: 'package:com.raahmitra.gpslogger' }
          );
        } catch (err) {
          console.error('battery optimization exemption request failed', err);
        }
        await AsyncStorage.setItem(BATTERY_OPT_REQUESTED_KEY, '1');
        await waitForAppActive();
      }

      const hasPhoneState = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE);
      if (!hasPhoneState) {
        try {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE);
        } catch (err) {
          console.error('READ_PHONE_STATE request failed', err);
        }
        await waitForAppActive();
      }
    }

    const profileName = 'MOVING_NORMAL';
    const profile = getPollingProfile(trackingMode, profileName);
    const accuracy = Location.Accuracy[profile.accuracy] || Location.Accuracy.Highest;
    const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    const previousProfile = await AsyncStorage.getItem(ACTIVE_PROFILE_KEY);
    const previousMode = await AsyncStorage.getItem(TRACKING_MODE_KEY);
    await AsyncStorage.setItem(ACTIVE_PROFILE_KEY, profileName);
    await AsyncStorage.setItem(TRACKING_MODE_KEY, trackingMode);
    if (!alreadyRunning) await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy,
      timeInterval: profile.timeIntervalMs,
      distanceInterval: profile.distanceIntervalM,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'RaahMitra GPS logger',
        notificationBody: `Logging ${trackingMode} with ${profileName} profile`,
      },
    });
    if (previousProfile !== profileName || previousMode !== trackingMode || !alreadyRunning) {
      await logEvent('polling_settings_changed', {
        profile: profileName,
        tracking_mode: trackingMode,
        accuracy: profile.accuracy,
        time_interval_ms: profile.timeIntervalMs,
        distance_interval_m: profile.distanceIntervalM,
        algorithm_version: getTrackingProfile(trackingMode).algorithmVersion,
      });
    }
      await recordHeartbeat('start_tracking');
      setRunning(true);
    } catch (err) {
      await logEvent('error', { reason: 'start_tracking_failed', message: String(err?.message ?? err) });
      Alert.alert('Tracking could not start', String(err?.message ?? err));
      setRunning(false);
    }
  }

  // Section 36/39: on stop, run one full-session map-matching pass (not the bounded live
  // window) and persist the outcome back onto processed_locations by raw_fix_id. Raw evidence
  // is never rewritten, so a future matcher/OSM version can redo this from scratch.
  async function finalizeSession() {
    try {
      const [rawRows, processedRows] = await Promise.all([getAllRawLocations(), getAllProcessedLocations()]);
      const rawById = new Map(rawRows.map((row) => [row.id, row]));
      const rows = processedRows.map((row) => ({ ...rawById.get(row.raw_fix_id), ...row }));
      const matched = await matchSequenceChunked(rows, { endpoint: MATCHER_ENDPOINT, mode: sessionModeFromRows(rawRows, trackingMode) });
      await updateMatchDiagnostics(collectMatchDiagnostics(matched));
      matchedCacheRef.current = new Map(matched.map((segment) => [segment.segmentId, segment]));
      pushRoute(matched);
      const stats = computeSessionStats({ rawRows, processedRows, segments: matched });
      setSessionStats(stats);
      await logEvent('session_finalized', {
        matcher_version: MATCHER_VERSION,
        total_distance_m: stats.totalDistanceM,
        accepted_point_count: stats.acceptedPointCount,
      });
    } catch (err) {
      console.error('finalizeSession failed', err);
      await logEvent('error', { reason: 'finalize_session_failed', message: String(err?.message ?? err) });
    }
  }

  async function stop() {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    await recordHeartbeat('stop_tracking');
    setRunning(false);
    await finalizeSession();
  }

  async function exportLogs() {
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Export failed', 'Sharing is not available on this device.');
        return;
      }

      const [logs, events] = await Promise.all([getAllLogs(), getAllEvents()]);
      const [rawLocations, processedLocations] = await Promise.all([
        getAllRawLocations(), getAllProcessedLocations(),
      ]);
      const exportedMode = sessionModeFromRows(rawLocations, trackingMode);
      const payload = {
        schema_version: '2.1',
        algorithm_version: getTrackingProfile(exportedMode).algorithmVersion,
        matcher_version: MATCHER_VERSION,
        tracking_mode: exportedMode,
        exported_at: new Date().toISOString(),
        configuration: { pollingProfiles: POLLING_PROFILES, modeProfiles: MODE_PROFILES, base: BASE_PROCESSING_CONFIG },
        session_stats: sessionStats,
        logs,
        raw_locations: rawLocations,
        processed_locations: processedLocations,
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

  async function exportAnimatedMap() {
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
      const [rawRows, processedRows] = await Promise.all([getAllRawLocations(), getAllProcessedLocations()]);
      const rawById = new Map(rawRows.map((row) => [row.id, row]));
      const rows = processedRows.map((row) => ({ ...rawById.get(row.raw_fix_id), ...row }));
      const matchedSegments = await matchSequence(rows, { endpoint: MATCHER_ENDPOINT, mode: sessionModeFromRows(rawRows, trackingMode) });
      const diagnosticsByRawFixId = new Map(collectMatchDiagnostics(matchedSegments).map((d) => [d.raw_fix_id, d]));
      const points = rows
        .filter((row) => row.is_route_point && row.trajectory_decision === 'ACCEPTED')
        .map((row) => {
          const diag = diagnosticsByRawFixId.get(row.raw_fix_id);
          return {
            latitude: diag?.map_matched_latitude ?? row.filtered_latitude ?? row.latitude,
            longitude: diag?.map_matched_longitude ?? row.filtered_longitude ?? row.longitude,
            timestamp: row.fix_timestamp_ms,
            routeType: diag?.route_segment_type ?? row.route_segment_type ?? 'RAW_GPS',
          };
        });
      const file = new File(Paths.document, 'raahmitra_animated_route.html');
      if (file.exists) file.delete();
      file.create();
      file.write(buildAnimatedMapHtml(matchedSegments, points));
      await Sharing.shareAsync(file.uri, { mimeType: 'text/html', dialogTitle: 'Export animated map' });
    } catch (err) {
      console.error('Animated map export failed', err);
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
              setRawCount(0);
              setProcessedCount(0);
              setAcceptedCount(0);
              setSessionStats(null);
              matchedCacheRef.current = new Map();
              lastLiveMatchAt.current = 0;
              latestLiveTimestamp.current = 0;
              pushRoute([]);
            } catch (err) {
              Alert.alert('Clear failed', String(err?.message ?? err));
            }
          },
        },
      ]
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <WebView
        ref={webViewRef}
        style={styles.map}
        originWhitelist={['*']}
        source={{ html: mapHtml }}
        javaScriptEnabled
        domStorageEnabled
        onLoadEnd={onWebViewLoadEnd}
      />
      <View style={[styles.panel, { paddingBottom: styles.panel.paddingBottom + insets.bottom }]}>
        <Text style={styles.title}>RaahMitra {trackingMode === TRACKING_MODES.BIKE ? 'cycling' : 'walking'} route</Text>
        <View style={styles.modeRow}>
          <Pressable
            disabled={running}
            style={[styles.modeButton, trackingMode === TRACKING_MODES.WALK && styles.modeButtonActive, running && styles.modeButtonDisabled]}
            onPress={() => setTrackingMode(TRACKING_MODES.WALK)}
          >
            <Text style={[styles.modeButtonText, trackingMode === TRACKING_MODES.WALK && styles.modeButtonTextActive]}>Walking</Text>
          </Pressable>
          <Pressable
            disabled={running}
            style={[styles.modeButton, trackingMode === TRACKING_MODES.BIKE && styles.modeButtonActive, running && styles.modeButtonDisabled]}
            onPress={() => setTrackingMode(TRACKING_MODES.BIKE)}
          >
            <Text style={[styles.modeButtonText, trackingMode === TRACKING_MODES.BIKE && styles.modeButtonTextActive]}>Cycling</Text>
          </Pressable>
        </View>
        <Text style={styles.status}>{running ? 'RUNNING' : 'STOPPED'}</Text>
        <View style={styles.countRow}>
          <Text style={styles.count}>Raw: {rawCount}</Text>
          <Text style={styles.count}>Processed: {processedCount}</Text>
          <Text style={styles.count}>Accepted: {acceptedCount}</Text>
        </View>
        {sessionStats ? (
          <View style={styles.countRow}>
            <Text style={styles.count}>Dist: {(sessionStats.totalDistanceM / 1000).toFixed(2)} km</Text>
            <Text style={styles.count}>Dur: {sessionStats.durationMs ? Math.round(sessionStats.durationMs / 60000) : 0} min</Text>
            <Text style={styles.count}>Avg: {sessionStats.averageSpeedMps ?? '-'} m/s</Text>
          </View>
        ) : null}
        <View style={styles.buttonGrid}>
          <Pressable style={[styles.actionButton, styles.startButton]} onPress={running ? stop : start}>
            <Text style={styles.actionText}>{running ? 'STOP LOGGING' : 'START LOGGING'}</Text>
          </Pressable>
          <Pressable style={[styles.actionButton, styles.exportButton]} onPress={exportLogs}>
            <Text style={styles.actionText}>EXPORT LOGS</Text>
          </Pressable>
          <Pressable style={[styles.actionButton, styles.animatedButton]} onPress={exportAnimatedMap}>
            <Text style={styles.actionText}>ANIMATED MAP</Text>
          </Pressable>
          <Pressable style={[styles.actionButton, styles.clearButton]} onPress={confirmClearLogs}>
            <Text style={styles.actionText}>CLEAR LOGS</Text>
          </Pressable>
        </View>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  map: { flex: 1, minHeight: 220 },
  panel: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 14, backgroundColor: '#fff' },
  countRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  buttonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  actionButton: { width: '48%', minHeight: 46, borderRadius: 8, justifyContent: 'center', alignItems: 'center', elevation: 3 },
  startButton: { backgroundColor: '#1687d9' },
  exportButton: { backgroundColor: '#1687d9' },
  animatedButton: { backgroundColor: '#116bb1' },
  clearButton: { backgroundColor: '#c0392b' },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 4, textAlign: 'center' },
  status: { fontSize: 22, fontWeight: 'bold' },
  count: { fontSize: 18 },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  modeButton: { flex: 1, minHeight: 38, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: '#eaf2f6', borderWidth: 1, borderColor: '#c7d7e0' },
  modeButtonActive: { backgroundColor: '#1687d9', borderColor: '#1687d9' },
  modeButtonDisabled: { opacity: 0.5 },
  modeButtonText: { color: '#1687d9', fontSize: 14, fontWeight: '700' },
  modeButtonTextActive: { color: '#fff' },
});
