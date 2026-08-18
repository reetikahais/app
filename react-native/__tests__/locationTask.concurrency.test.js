// Round 3, item 8: expo-task-manager can invoke the same defineTask callback again before a
// previous invocation's AsyncStorage load -> mutate -> save cycle finishes (e.g. two location
// batches delivered in quick succession). Without serialization both invocations load the same
// stale movementState, each folds its own fix in isolation, and whichever saves last silently
// discards the other's contribution - a classic lost-update race on movementState/anchor.
describe('RN location task re-entrancy guard (Round 3, item 8)', () => {
  let store;
  let AsyncStorage;
  let TaskManager;

  beforeEach(() => {
    jest.resetModules();
    store = {};

    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn(),
      setItem: jest.fn(),
    }));
    jest.doMock('expo-battery', () => ({ getBatteryLevelAsync: jest.fn().mockResolvedValue(0.8) }));
    jest.doMock('expo-task-manager', () => ({ defineTask: jest.fn() }));
    jest.doMock('../db', () => ({ insertLog: jest.fn().mockResolvedValue(undefined) }));
    jest.doMock('../logger', () => ({
      logEvent: jest.fn().mockResolvedValue(undefined),
      recordHeartbeat: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../signalInfo', () => ({
      getSignalInfo: jest.fn().mockResolvedValue({
        signal_dbm: null,
        signal_level: null,
        carrier: null,
        network_type: null,
      }),
    }));
    jest.doMock('../locationWatch', () => ({ LOCATION_TASK_NAME: 'test-location-task' }));
  });

  function makeLocation() {
    return {
      coords: { latitude: 31.4440206, longitude: 77.0467109, accuracy: 10, speed: null },
      timestamp: Date.now(),
    };
  }

  test('two overlapping invocations fold both fixes into the anchor instead of racing', async () => {
    AsyncStorage = require('@react-native-async-storage/async-storage');
    TaskManager = require('expo-task-manager');

    // Delay only the *first* movementState load, resolving with a snapshot captured at call
    // time (not read lazily at resolve time) - this models a genuinely stale read regardless of
    // what either invocation writes to `store` while the delayed read is in flight, so a second
    // invocation fired immediately after has a real chance to interleave if nothing serializes
    // the two - exactly the OS-delivery scenario this guard defends against.
    let delayNextGet = true;
    AsyncStorage.getItem.mockImplementation((key) => {
      const snapshot = store[key] ?? null;
      if (key === 'movement_state_v1' && delayNextGet) {
        delayNextGet = false;
        return new Promise((resolve) => setTimeout(() => resolve(snapshot), 20));
      }
      return Promise.resolve(snapshot);
    });
    AsyncStorage.setItem.mockImplementation(async (key, value) => {
      store[key] = value;
    });

    require('../locationTask');
    const handler = TaskManager.defineTask.mock.calls[0][1];

    const invocationA = handler({ data: { locations: [makeLocation()] }, error: null });
    const invocationB = handler({ data: { locations: [makeLocation()] }, error: null });
    await Promise.all([invocationA, invocationB]);

    const savedState = JSON.parse(store['movement_state_v1']);
    // Each 10m-accuracy fix carries weight 1/10^2 = 0.01. Serialized processing folds both
    // fixes into one anchor (0.02 total weight); a lost-update race leaves only one fix's
    // weight (0.01) because the second invocation started from a stale, anchor-less state.
    expect(savedState.anchor.totalWeight).toBeCloseTo(0.02, 5);
  });
});

describe('RN location task processing_version tagging (Round 3, item 6)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('expo-battery', () => ({ getBatteryLevelAsync: jest.fn().mockResolvedValue(0.8) }));
    jest.doMock('expo-task-manager', () => ({ defineTask: jest.fn() }));
    jest.doMock('../db', () => ({ insertLog: jest.fn().mockResolvedValue(undefined) }));
    jest.doMock('../logger', () => ({
      logEvent: jest.fn().mockResolvedValue(undefined),
      recordHeartbeat: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../signalInfo', () => ({
      getSignalInfo: jest.fn().mockResolvedValue({
        signal_dbm: null,
        signal_level: null,
        carrier: null,
        network_type: null,
      }),
    }));
    jest.doMock('../locationWatch', () => ({ LOCATION_TASK_NAME: 'test-location-task' }));
  });

  test('every inserted row carries the current PROCESSING_VERSION', async () => {
    const { PROCESSING_VERSION } = require('../movementStateMachine');
    const { insertLog } = require('../db');
    const TaskManagerMock = require('expo-task-manager');

    require('../locationTask');
    const handler = TaskManagerMock.defineTask.mock.calls[0][1];

    await handler({
      data: {
        locations: [
          {
            coords: { latitude: 31.4440206, longitude: 77.0467109, accuracy: 10, speed: null },
            timestamp: Date.now(),
          },
        ],
      },
      error: null,
    });

    expect(insertLog).toHaveBeenCalledWith(
      expect.objectContaining({ processing_version: PROCESSING_VERSION })
    );
  });
});
