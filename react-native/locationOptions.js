import * as Location from 'expo-location';
import { getPollingProfile } from './trackingConfig';

// Single place that turns a (mode, polling tier) pair into startLocationUpdatesAsync options, used
// both when tracking starts and when a pending profile change is applied from the foreground.
export function buildLocationTaskOptions(mode, profileName) {
  const profile = getPollingProfile(mode, profileName);
  return {
    accuracy: Location.Accuracy[profile.accuracy] || Location.Accuracy.Highest,
    timeInterval: profile.timeIntervalMs,
    distanceInterval: profile.distanceIntervalM,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'RaahMitra GPS logger',
      notificationBody: `Logging ${mode} with ${profileName} profile`,
    },
  };
}
