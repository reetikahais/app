export const openDatabaseAsync = jest.fn(() => Promise.resolve({
  execAsync: jest.fn(() => Promise.resolve()),
  getAllAsync: jest.fn(() => Promise.resolve([])),
  runAsync: jest.fn(() => Promise.resolve()),
  closeAsync: jest.fn(() => Promise.resolve()),
}));
