import { NativeModules, Platform } from 'react-native';

const EMPTY_SIGNAL_INFO = {
  signal_dbm: null,
  signal_level: null,
  carrier: null,
  network_type: null,
};

// true / false from Android's PowerManager; null when it cannot be determined (not Android, or a
// build made before the native method existed) — callers must treat null as "don't nag".
export async function isIgnoringBatteryOptimizations() {
  if (Platform.OS !== 'android' || !NativeModules.SignalInfo?.isIgnoringBatteryOptimizations) return null;
  try {
    return Boolean(await NativeModules.SignalInfo.isIgnoringBatteryOptimizations());
  } catch (err) {
    console.error('isIgnoringBatteryOptimizations failed', err);
    return null;
  }
}

export async function getSignalInfo() {
  if (Platform.OS !== 'android' || !NativeModules.SignalInfo) {
    return EMPTY_SIGNAL_INFO;
  }
  try {
    return await NativeModules.SignalInfo.getSignalInfo();
  } catch (err) {
    console.error('getSignalInfo failed', err);
    return EMPTY_SIGNAL_INFO;
  }
}
