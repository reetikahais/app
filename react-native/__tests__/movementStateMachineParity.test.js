import fs from 'fs';
import path from 'path';
import {
  createInitialMovementState,
  processLocationFix,
  getLocationQuality,
  getProcessedLocation,
  haversineDistanceMeters,
} from '../movementStateMachine';

const METERS_PER_DEG_LAT = 111320;
const BASE = { lat: 31.4440206, lon: 77.0467109 };

function offset(dNorthM, dEastM) {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180);
  return {
    lat: BASE.lat + dNorthM / METERS_PER_DEG_LAT,
    lon: BASE.lon + dEastM / metersPerDegLon,
  };
}

// JSON `null` accuracy means "invalid/unknown" - JS passes it straight through, since
// sanitizeAccuracy(null) already handles it (Dart's parity test maps the same JSON null to NaN,
// since Dart's LocationFix.accuracy is a non-nullable double - see that file for the equivalent).
function toFix(f) {
  const pos = offset(f.dNorthM, f.dEastM);
  return { lat: pos.lat, lon: pos.lon, accuracy: f.accuracy, speed: f.speed ?? null, timestampMs: 0 };
}

const fixturePath = path.join(__dirname, '..', '..', 'test-fixtures', 'movement_state_machine_parity.json');
const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('movement state machine parity fixtures (shared with Flutter)', () => {
  for (const testCase of fixtureData.cases) {
    test(`${testCase.name} -> ${testCase.expectedFinalState}`, () => {
      let state = createInitialMovementState();
      let lastFix = null;
      for (const f of testCase.fixes) {
        lastFix = toFix(f);
        state = processLocationFix(state, lastFix);
      }
      expect(state.state).toBe(testCase.expectedFinalState);

      if (testCase.expectedQuality != null) {
        expect(getLocationQuality(state, lastFix)).toBe(testCase.expectedQuality);
      }
      if (testCase.expectedProcessedWithinMOfLastFix != null) {
        const processed = getProcessedLocation(state);
        expect(haversineDistanceMeters(processed, lastFix)).toBeLessThanOrEqual(
          testCase.expectedProcessedWithinMOfLastFix
        );
      }
    });
  }
});
