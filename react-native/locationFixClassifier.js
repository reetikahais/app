// Pure fix-quality tagging - mirrors Flutter's classifyFixMethod (location_task.dart).
// Fixes are never discarded based on accuracy; this only labels them for downstream consumers
// (the movement/noise state machine decides how each fix is actually used).

export const MAX_ACCURACY_METERS = 50;

export function classifyFixMethod(accuracy) {
  return accuracy != null && accuracy <= MAX_ACCURACY_METERS ? 'fused' : 'low_accuracy_fallback';
}
