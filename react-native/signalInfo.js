import { NativeModules, Platform } from 'react-native';

const EMPTY_SIGNAL_INFO = {
  signal_dbm: null,
  signal_level: null,
  carrier: null,
  network_type: null,
};

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
