import { registerRootComponent } from 'expo';

import { logEvent } from './logger';
import './locationTask';
import App from './App';

const previousHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  // Fire-and-forget: crash handling must not wait on (or be broken by) the log write.
  logEvent('error', { reason: 'js_crash', message: error?.message, fatal: !!isFatal }).catch(() => {});
  previousHandler(error, isFatal);
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
