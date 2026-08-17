import { classifyFixMethod, MAX_ACCURACY_METERS } from '../locationTask';

describe('classifyFixMethod', () => {
  test('accuracy at or below threshold is fused', () => {
    expect(classifyFixMethod(10)).toBe('fused');
    expect(classifyFixMethod(MAX_ACCURACY_METERS)).toBe('fused');
  });

  test('accuracy above threshold is low_accuracy_fallback', () => {
    expect(classifyFixMethod(MAX_ACCURACY_METERS + 1)).toBe('low_accuracy_fallback');
    expect(classifyFixMethod(500)).toBe('low_accuracy_fallback');
  });

  test('null accuracy is low_accuracy_fallback', () => {
    expect(classifyFixMethod(null)).toBe('low_accuracy_fallback');
  });
});
