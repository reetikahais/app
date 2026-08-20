import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/debouncer.dart';

void main() {
  test('collapses rapid calls into a single trailing invocation', () async {
    final debouncer = Debouncer(const Duration(milliseconds: 30));
    var callCount = 0;
    String? lastValue;
    void run(String v) => debouncer.run(() {
          callCount++;
          lastValue = v;
        });

    run('a');
    await Future.delayed(const Duration(milliseconds: 10));
    run('b');
    await Future.delayed(const Duration(milliseconds: 10));
    run('c');
    expect(callCount, 0);

    await Future.delayed(const Duration(milliseconds: 50));
    expect(callCount, 1);
    expect(lastValue, 'c');
  });

  test('invokes again after a quiet period followed by a new call', () async {
    final debouncer = Debouncer(const Duration(milliseconds: 20));
    var callCount = 0;
    debouncer.run(() => callCount++);
    await Future.delayed(const Duration(milliseconds: 40));
    expect(callCount, 1);

    debouncer.run(() => callCount++);
    await Future.delayed(const Duration(milliseconds: 40));
    expect(callCount, 2);
  });

  test('cancel() prevents the pending trailing call', () async {
    final debouncer = Debouncer(const Duration(milliseconds: 20));
    var callCount = 0;
    debouncer.run(() => callCount++);
    debouncer.cancel();
    await Future.delayed(const Duration(milliseconds: 40));
    expect(callCount, 0);
  });
}
