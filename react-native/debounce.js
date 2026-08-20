// Trailing-edge debounce: collapses a burst of rapid calls (e.g. AppState firing
// foreground/background/foreground within milliseconds) into a single call with the
// last-seen arguments, applied only once the burst goes quiet for `waitMs`.

export function debounce(fn, waitMs) {
  let timer = null;

  function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  }

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
