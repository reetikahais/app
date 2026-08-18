import 'dart:async';

// Trailing-edge debounce: collapses a burst of rapid calls (e.g. didChangeAppLifecycleState
// firing background/foreground/background within milliseconds) into a single action, applied
// only once the burst goes quiet for `delay`.
class Debouncer {
  final Duration delay;
  Timer? _timer;

  Debouncer(this.delay);

  void run(void Function() action) {
    _timer?.cancel();
    _timer = Timer(delay, action);
  }

  void cancel() {
    _timer?.cancel();
    _timer = null;
  }
}
