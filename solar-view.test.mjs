import test from "node:test";
import assert from "node:assert/strict";
import {
  ASTRONOMICAL_UNIT_KM,
  solarSystemPositions,
  vectorAtEpoch,
} from "./solar-view.mjs";

test("advances a Horizons position with its published velocity", () => {
  const position = vectorAtEpoch({
    timestamp: 1000,
    positionKm: { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 },
    velocityKmPerSecond: { x: 2, y: -3, z: 1 },
  }, 2000);

  assert.equal(position.x, (ASTRONOMICAL_UNIT_KM + 2) / ASTRONOMICAL_UNIT_KM);
  assert.equal(position.y, -3 / ASTRONOMICAL_UNIT_KM);
  assert.equal(position.z, 1 / ASTRONOMICAL_UNIT_KM);
});

test("places the Moon by adding its Earth-centered vector to Earth's Sun-centered position", () => {
  const positions = solarSystemPositions({
    bodies: [{
      target: { id: "399" },
      timestamp: 0,
      positionKm: { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 },
      velocityKmPerSecond: { x: 0, y: 0, z: 0 },
    }],
    moon: {
      timestamp: 0,
      positionKm: { x: 0, y: 384400, z: 0 },
      velocityKmPerSecond: { x: 0, y: 0, z: 0 },
    },
  }, 0);

  assert.equal(positions.get("301").x, 1);
  assert.equal(positions.get("301").y, 384400 / ASTRONOMICAL_UNIT_KM);
});

test("keeps the planetary positions when the optional lunar vector is unavailable", () => {
  const positions = solarSystemPositions({ bodies: [{
    target: { id: "399" },
    timestamp: 0,
    positionKm: { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 },
    velocityKmPerSecond: { x: 0, y: 0, z: 0 },
  }], moon: null }, 0);

  assert.equal(positions.has("399"), true);
  assert.equal(positions.has("301"), false);
});
