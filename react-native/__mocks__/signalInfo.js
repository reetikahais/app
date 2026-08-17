export const getSignalInfo = jest.fn(() => Promise.resolve({
  signal_dbm: -80,
  signal_level: 3,
  carrier: 'test-carrier',
  network_type: '4g',
}));
