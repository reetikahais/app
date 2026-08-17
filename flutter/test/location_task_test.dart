import 'package:flutter_test/flutter_test.dart';
import 'package:raahmitra_gps_logger/location_task.dart';

void main() {
  group('classifyFixMethod', () {
    test('accuracy at or below threshold is fused', () {
      expect(classifyFixMethod(10), 'fused');
      expect(classifyFixMethod(maxAccuracyMeters), 'fused');
    });

    test('accuracy above threshold is low_accuracy_fallback', () {
      expect(classifyFixMethod(maxAccuracyMeters + 1), 'low_accuracy_fallback');
      expect(classifyFixMethod(500), 'low_accuracy_fallback');
    });

    test('null accuracy is low_accuracy_fallback', () {
      expect(classifyFixMethod(null), 'low_accuracy_fallback');
    });
  });
}
