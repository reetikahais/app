const mockStopLocationUpdatesAsync = jest.fn();
const mockStartLocationUpdatesAsync = jest.fn();

jest.mock('expo-location', () => ({
  Accuracy: { High: 'high', Balanced: 'balanced' },
  stopLocationUpdatesAsync: (...args) => mockStopLocationUpdatesAsync(...args),
  startLocationUpdatesAsync: (...args) => mockStartLocationUpdatesAsync(...args),
}));

const { stopWatch, restartWatchWithOptions } = require('../locationWatch');

function taskNotFoundError() {
  const err = new Error(
    "Call to function 'ExpoLocation.stopLocationUpdatesAsync' has been rejected.\n" +
      "→ Caused by: expo.modules.taskManager.exceptions.TaskNotFoundException: Task " +
      "'raahmitra-background-location-task' not found for app ID 'com.raahmitra.gpslogger'."
  );
  err.code = 'ERR_UNEXPECTED';
  return err;
}

beforeEach(() => {
  mockStopLocationUpdatesAsync.mockReset();
  mockStartLocationUpdatesAsync.mockReset();
});

describe('stopWatch', () => {
  test('resolves normally when the task is registered', async () => {
    mockStopLocationUpdatesAsync.mockResolvedValueOnce(undefined);
    await expect(stopWatch()).resolves.toBeUndefined();
  });

  test('swallows TaskNotFoundException - an already-dead task counts as stopped', async () => {
    mockStopLocationUpdatesAsync.mockRejectedValueOnce(taskNotFoundError());
    await expect(stopWatch()).resolves.toBeUndefined();
  });

  test('does not swallow unrelated errors', async () => {
    const other = new Error('permission denied');
    other.code = 'ERR_LOCATION_UNAUTHORIZED';
    mockStopLocationUpdatesAsync.mockRejectedValueOnce(other);
    await expect(stopWatch()).rejects.toBe(other);
  });
});

describe('restartWatchWithOptions', () => {
  test('still starts a fresh watch when the old task was already OS-killed', async () => {
    mockStopLocationUpdatesAsync.mockRejectedValueOnce(taskNotFoundError());
    mockStartLocationUpdatesAsync.mockResolvedValueOnce(undefined);

    await restartWatchWithOptions(60000, { highAccuracy: false });

    expect(mockStartLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(mockStartLocationUpdatesAsync.mock.calls[0][1]).toMatchObject({ timeInterval: 60000 });
  });
});
