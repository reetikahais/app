import { debounce } from '../debounce';

describe('debounce', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('collapses rapid calls into a single trailing invocation', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    jest.advanceTimersByTime(100);
    debounced('b');
    jest.advanceTimersByTime(100);
    debounced('c');
    expect(fn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  test('invokes again after a quiet period followed by a new call', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    jest.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced('b');
    jest.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');
  });

  test('cancel() prevents the pending trailing call', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    debounced.cancel();
    jest.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
  });
});
