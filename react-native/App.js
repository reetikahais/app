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
  MATCHER_ENDPOINT, ACTIVE_PROFILE_KEY, REQUESTED_PROFILE_KEY, TRACKING_MODE_KEY, TRACKING_SESSION_KEY,
  TRACKING_MODES, MODE_PROFILES, BASE_PROCESSING_CONFIG, POLLING_PROFILES, createSessionId,
  getPollingProfile, getTrackingProfile, normalizeTrackingMode,
} from './trackingConfig';
import { buildLocationTaskOptions } from './locationOptions';
import { isIgnoringBatteryOptimizations } from './signalInfo';
import { buildAnimatedMapHtml } from './animatedMapExport';
import {
  buildGpsRouteSegments, matchSequence, matchSequenceChunked, resolveSegment,
  collectMatchDiagnostics, MATCHER_VERSION,
} from './routeMatching';
import { createRoadState, updateRoadState, splitCommittedTentative } from './routeConfidence';
import { segmentsToRouteJson } from './routeSplit';
import { computeSessionStats } from './sessionStats';
import {
  logEvent,
  recordHeartbeat,
  checkForMissedShutdown,
  clearEventsLog,
  getAllEvents,
  getTrackingLifecycle,
} from './logger';

const LIVE_MATCH_THROTTLE_MS = 10000;
const LIVE_MATCH_TAIL_POINTS = 15;
// After a failed attempt to apply a pending polling profile, wait this long before trying again so
// the 2-second refresh tick doesn't retry (and log) every tick.
const PROFILE_APPLY_RETRY_MS = 30000;

// Button label -> internal mode value. The visible "Bike" button intentionally maps to the
// internal value 'motorbike' (motorbike/motorcycle/scooter) — 'bike' is no longer used internally
// because it was ambiguous between bicycle and motorbike.
const MODE_BUTTONS = [
  { value: TRACKING_MODES.WALK, label: 'Walking' },
  { value: TRACKING_MODES.BICYCLE, label: 'Bicycle' },
  { value: TRACKING_MODES.MOTORBIKE, label: 'Bike' },
  { value: TRACKING_MODES.CAR, label: 'Car' },
];
const MODE_LABELS = Object.fromEntries(MODE_BUTTONS.map((option) => [option.value, option.label]));

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
    // Low-confidence stretches (recovery-confirmed / late fixes) draw as their own faded dashed line.
    L.polyline(route.coordinates, {
      color: route.type === 'MAP_MATCHED' ? '#2f8f4e' : (route.type === 'GAP' ? '#9aa5ad' : '#d39b22'),
      weight: route.tentative ? 4 : 5,
      opacity: route.lowConfidence ? 0.4 : (route.type === 'GAP' ? 0.5 : (route.tentative ? 0.55 : 0.9)),
      dashArray: route.lowConfidence ? '2 8' : (route.type === 'GAP' ? '8 8' : (route.tentative ? '4 6' : null))
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
  const stored = rawRows.find((row) => row.tracking_mode)?.tracking_mode;
  return normalizeTrackingMode(stored) || fallbackMode;
}

// Effective mode drives Valhalla costing (a session that escalated bicycle -> motorbike should be
// matched against motorcycle-appropriate roads, not bicycle-only ones) — use the most recent
// processed row's effective_mode, since that reflects how the trip actually ended up moving.
// Older sessions/rows recorded before this column existed simply fall back to the selected mode.
function sessionEffectiveModeFromRows(processedRows, fallbackMode) {
  const sorted = [...processedRows].filter((row) => row.effective_mode)
    .sort((a, b) => Number(a.raw_fix_id ?? 0) - Number(b.raw_fix_id ?? 0));
  return sorted.at(-1)?.effective_mode || fallbackMode;
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
  const trackingModeRef = useRef(TRACKING_MODES.WALK);
  trackingModeRef.current = trackingMode;
  // The mount effect's listeners are created once; they call the latest start() through this ref.
  const startRef = useRef(null);
  const applyingProfile = useRef(false);
  const lastProfileApplyFailureAt = useRef(0);
  const lostAlertOpen = useRef(false);
  const mapHtml = useMemo(() => buildLiveMapShellHtml(), []);

  // The background task only REQUESTS a polling profile change (it can't start a foreground service
  // from the background). Apply it here while the app is in the foreground. startLocationUpdatesAsync
  // on an already-running task just updates its options in place (expo-task-manager registerTask ->
  // setOptions), so there is deliberately no stopLocationUpdatesAsync first: a stop that succeeded
  // followed by a start that failed is exactly what killed tracking on the 22 Sept 2026 ride.
  async function applyPendingPollingProfile() {
    if (applyingProfile.current) return;
    if (Date.now() - lastProfileApplyFailureAt.current < PROFILE_APPLY_RETRY_MS) return;
    applyingProfile.current = true;
    try {
      if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME))) return;
      const [activeProfile, requestedProfile, storedMode] = await Promise.all([
        AsyncStorage.getItem(ACTIVE_PROFILE_KEY),
        AsyncStorage.getItem(REQUESTED_PROFILE_KEY),
        AsyncStorage.getItem(TRACKING_MODE_KEY),
      ]);
      if (!requestedProfile || requestedProfile === activeProfile) return;
      const mode = normalizeTrackingMode(storedMode) || TRACKING_MODES.WALK;
      try {
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, buildLocationTaskOptions(mode, requestedProfile));
        await AsyncStorage.setItem(ACTIVE_PROFILE_KEY, requestedProfile);
        await logEvent('polling_profile_changed', {
          from_profile: activeProfile,
          to_profile: requestedProfile,
          tracking_mode: mode,
          reason: 'applied_in_foreground',
        });
      } catch (err) {
        lastProfileApplyFailureAt.current = Date.now();
        console.error('Applying pending polling profile failed', err);
        await logEvent('error', {
          reason: 'polling_profile_apply_failed',
          message: String(err?.message ?? err),
          from_profile: activeProfile,
          attempted_profile: requestedProfile,
        });
      }
    } catch (err) {
      console.error('applyPendingPollingProfile failed', err);
    } finally {
      applyingProfile.current = false;
    }
  }

  // Silent-death detection: the app last recorded "start_tracking" but the OS no longer has the
  // location task registered (service killed, start rejected, reboot...). Tell the user instead of
  // leaving a screen that looks idle, and offer to resume.
  async function checkTrackingLost() {
    // Claimed synchronously, before the first await, so the mount call and the 'active' event
    // (which can fire together) can never both get past this point. Released in `finally` on every
    // path except the one where the alert is actually shown (its buttons release it then).
    if (lostAlertOpen.current) return;
    lostAlertOpen.current = true;
    let alertShown = false;
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      setRunning(started);
      if (started) return;
      const { lastHeartbeatMs, lastLifecycleEvent } = await getTrackingLifecycle();
      if (lastLifecycleEvent !== 'start_tracking') return;
      const lastSeen = lastHeartbeatMs ? new Date(lastHeartbeatMs) : null;
      await logEvent('tracking_lost_detected', {
        last_heartbeat_ms: lastHeartbeatMs,
        last_heartbeat_iso: lastSeen ? lastSeen.toISOString() : null,
      });
      const storedMode = normalizeTrackingMode(await AsyncStorage.getItem(TRACKING_MODE_KEY));
      Alert.alert(
        'Tracking stopped',
        `Tracking stopped at ${lastSeen ? lastSeen.toLocaleTimeString() : 'an unknown time'}. Resume?`,
        [
          {
            text: 'Not now',
            style: 'cancel',
            onPress: () => {
              lostAlertOpen.current = false;
              // Marks tracking as intentionally stopped so this prompt doesn't repeat.
              recordHeartbeat('stop_tracking');
            },
          },
          {
            text: 'Resume',
            onPress: () => {
              lostAlertOpen.current = false;
              startRef.current?.(storedMode || undefined);
            },
          },
        ],
        { onDismiss: () => { lostAlertOpen.current = false; } },
      );
      alertShown = true;
    } catch (err) {
      console.error('checkTrackingLost failed', err);
    } finally {
      if (!alertShown) lostAlertOpen.current = false;
    }
  }

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
      if (next === 'active') {
        applyPendingPollingProfile();
        checkTrackingLost();
      }
    });

    Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).then(setRunning).catch((err) => {
      console.error('hasStartedLocationUpdatesAsync failed', err);
      logEvent('error', { reason: 'has_started_check_failed', message: String(err?.message ?? err) });
    });
    AsyncStorage.getItem(TRACKING_MODE_KEY).then((stored) => {
      const normalized = normalizeTrackingMode(stored);
      if (normalized) setTrackingMode(normalized);
    });
    applyPendingPollingProfile();
    checkTrackingLost();

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

      // is_live_fresh reflects delivery latency (fix_age_ms), not whether this is the newest known
      // position — background location delivery routinely batches/delays fixes past
      // freshThresholdMs, which used to make every accepted point fail this gate and leave the
      // live marker stuck/missing even while the route line and counters kept updating normally.
      // The marker should always show the chronologically latest accepted position, fresh or not.
      const latest = rows
        .filter((row) => row.trajectory_decision === 'ACCEPTED' && row.filtered_latitude != null)
        .sort((a, b) => Number(b.fix_timestamp_ms) - Number(a.fix_timestamp_ms))[0];
      if (latest && Number(latest.fix_timestamp_ms) >= latestLiveTimestamp.current) {
        latestLiveTimestamp.current = Number(latest.fix_timestamp_ms);
        pushLive(Number(latest.filtered_latitude), Number(latest.filtered_longitude), Number(latest.horizontal_accuracy_m ?? latest.accuracy ?? 0));
      }
    }
    // A refresh reads both full tables; if one is still running when the next tick fires, skip the
    // tick instead of stacking a second run on top of it.
    let refreshingMap = false;
    const refreshMapSafely = () => {
      if (refreshingMap) return;
      refreshingMap = true;
      refreshMap()
        .catch((err) => console.error('refreshMap failed', err))
        .finally(() => { refreshingMap = false; });
    };
    refreshMapSafely();
    const interval = setInterval(() => {
      refreshMapSafely();
      // The app can stay in the foreground the whole time, so no 'active' transition will fire:
      // pick up a pending polling-profile request on this tick as well.
      if (appState.current === 'active') applyPendingPollingProfile();
    }, 2000);

    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  // Tell the user (once per START) when the app isn't exempt from battery optimization. Runs AFTER
  // tracking has started and never blocks it: opening the settings screen backgrounds the app, and
  // starting the foreground service from the background is exactly what Android rejects.
  async function promptBatteryOptimizationIfNeeded() {
    if (Platform.OS !== 'android') return;
    const exempt = await isIgnoringBatteryOptimizations();
    if (exempt !== false) return; // true = already exempt, null = can't tell: don't nag.
    await logEvent('battery_optimization_not_exempt');
    Alert.alert(
      'Allow background tracking',
      'Battery optimization can stop RaahMitra from logging while the screen is off or the app is in the background. Allow it to run unrestricted in Android settings for reliable tracking.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open settings', onPress: openBatteryOptimizationSettings },
      ],
    );
  }

  async function openBatteryOptimizationSettings() {
    try {
      await IntentLauncher.startActivityAsync(
        'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        { data: 'package:com.raahmitra.gpslogger' },
      );
    } catch (err) {
      console.error('battery optimization exemption request failed', err);
      try {
        await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
      } catch (fallbackErr) {
        console.error('battery optimization settings screen failed', fallbackErr);
      }
    }
  }

  async function start(modeOverride) {
    // Called both from the START button (no argument) and from the "Resume?" prompt, which passes
    // the mode tracking was last started with.
    const mode = normalizeTrackingMode(modeOverride) || trackingModeRef.current;
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
      const profile = getPollingProfile(mode, profileName);
      const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      const previousMode = await AsyncStorage.getItem(TRACKING_MODE_KEY);
      await AsyncStorage.setItem(TRACKING_MODE_KEY, mode);
      if (!alreadyRunning) {
        await AsyncStorage.setItem(ACTIVE_PROFILE_KEY, profileName);
        await AsyncStorage.setItem(REQUESTED_PROFILE_KEY, profileName);
        // Every START is a new session: the background task only processes its own session's rows.
        await AsyncStorage.setItem(TRACKING_SESSION_KEY, createSessionId());
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, buildLocationTaskOptions(mode, profileName));
      }
      if (!alreadyRunning || previousMode !== mode) {
        await logEvent('polling_settings_changed', {
          profile: profileName,
          tracking_mode: mode,
          accuracy: profile.accuracy,
          time_interval_ms: profile.timeIntervalMs,
          distance_interval_m: profile.distanceIntervalM,
          algorithm_version: getTrackingProfile(mode).algorithmVersion,
        });
      }
      await recordHeartbeat('start_tracking');
      setTrackingMode(mode);
      setRunning(true);
      promptBatteryOptimizationIfNeeded().catch((err) => console.error('battery optimization prompt failed', err));
    } catch (err) {
      await logEvent('error', { reason: 'start_tracking_failed', message: String(err?.message ?? err) });
      Alert.alert('Tracking could not start', String(err?.message ?? err));
      setRunning(false);
    }
  }
  startRef.current = start;
  // Section 36/39: on stop, run one full-session map-matching pass (not the bounded live
  // window) and persist the outcome back onto processed_locations by raw_fix_id. Raw evidence
  // is never rewritten, so a future matcher/OSM version can redo this from scratch.
  async function finalizeSession() {
    try {
      const [rawRows, processedRows] = await Promise.all([getAllRawLocations(), getAllProcessedLocations()]);
      const rawById = new Map(rawRows.map((row) => [row.id, row]));
      const rows = processedRows.map((row) => ({ ...rawById.get(row.raw_fix_id), ...row }));
      const selectedMode = sessionModeFromRows(rawRows, trackingMode);
      const matchMode = sessionEffectiveModeFromRows(processedRows, selectedMode);
      const matched = await matchSequenceChunked(rows, { endpoint: MATCHER_ENDPOINT, mode: matchMode });
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
    try {
      // Only stop a task that is registered: stopLocationUpdatesAsync throws TaskNotFoundException
      // otherwise (e.g. the OS already dropped it), which must not leave the UI stuck on RUNNING.
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    } catch (err) {
      console.error('Stopping location updates failed', err);
      await logEvent('error', { reason: 'stop_tracking_failed', message: String(err?.message ?? err) });
      const stillRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
      if (stillRunning) {
        Alert.alert('Could not stop tracking', String(err?.message ?? err));
        return;
      }
    }
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
      const effectiveMode = sessionEffectiveModeFromRows(processedLocations, exportedMode);
      // Section 25: every mode_switch_event recorded during processing, in order, so a viewer can
      // see exactly when/why the effective mode escalated or downgraded during this trip.
      const modeSwitches = processedLocations
        .filter((row) => row.mode_switch_event)
        .sort((a, b) => Number(a.raw_fix_id ?? 0) - Number(b.raw_fix_id ?? 0))
        .map((row) => ({
          at_fix_id: row.raw_fix_id, event: row.mode_switch_event, effective_mode: row.effective_mode,
        }));
      const payload = {
        schema_version: '2.1',
        algorithm_version: getTrackingProfile(exportedMode).algorithmVersion,
        matcher_version: MATCHER_VERSION,
        tracking_mode: exportedMode,
        user_selected_mode: exportedMode,
        effective_mode: effectiveMode,
        mode_switches: modeSwitches,
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
      const selectedMode = sessionModeFromRows(rawRows, trackingMode);
      const matchMode = sessionEffectiveModeFromRows(processedRows, selectedMode);
      const matchedSegments = await matchSequence(rows, { endpoint: MATCHER_ENDPOINT, mode: matchMode });
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
            trajectoryReason: row.trajectory_reason,
          };
        });
      // Section 27: surface rejected/high-speed/recovery fixes too, not just the accepted route,
      // so the debug viewer can show why a point was excluded or specially handled.
      const markers = rows
        .filter((row) => ['HIGH_SPEED_CONTINUITY_ACCEPT', 'RECOVERY_CONFIRMED'].includes(row.trajectory_reason)
          || row.trajectory_decision === 'OUTLIER')
        .map((row) => ({
          latitude: row.filtered_latitude ?? row.latitude,
          longitude: row.filtered_longitude ?? row.longitude,
          timestamp: row.fix_timestamp_ms,
          reason: row.trajectory_decision === 'OUTLIER' ? 'HARD_OUTLIER' : row.trajectory_reason,
        }));
      const file = new File(Paths.document, 'raahmitra_animated_route.html');
      if (file.exists) file.delete();
      file.create();
      file.write(buildAnimatedMapHtml(matchedSegments, points, `RaahMitra ${MODE_LABELS[selectedMode] || 'GPS'} route`, markers));
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
        <Text style={styles.title}>RaahMitra {MODE_LABELS[trackingMode] || 'Walking'} route</Text>
        <Text style={styles.sectionLabel}>Choose Activity</Text>
        <View style={styles.modeRow}>
          {MODE_BUTTONS.map((option) => (
            <Pressable
              key={option.value}
              disabled={running}
              style={[styles.modeButton, trackingMode === option.value && styles.modeButtonActive, running && styles.modeButtonDisabled]}
              onPress={() => setTrackingMode(option.value)}
            >
              <Text style={[styles.modeButtonText, trackingMode === option.value && styles.modeButtonTextActive]}>{option.label}</Text>
            </Pressable>
          ))}
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
          <Pressable style={[styles.actionButton, styles.startButton]} onPress={running ? stop : () => start()}>
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
  sectionLabel: { fontSize: 13, fontWeight: '600', color: '#5b6b74', marginBottom: 6, textAlign: 'center' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  modeButton: { width: '48%', minHeight: 38, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: '#eaf2f6', borderWidth: 1, borderColor: '#c7d7e0' },
  modeButtonActive: { backgroundColor: '#1687d9', borderColor: '#1687d9' },
  modeButtonDisabled: { opacity: 0.5 },
  modeButtonText: { color: '#1687d9', fontSize: 14, fontWeight: '700' },
  modeButtonTextActive: { color: '#fff' },
});
