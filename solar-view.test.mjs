import test from "node:test";
import assert from "node:assert/strict";
import {
  ASTRONOMICAL_UNIT_KM,
  horizonsStateAt,
  projectSolarPoint,
  solarSystemDistances,
  solarSystemPositions,
  solarCameraPosition,
} from "./solar-view.mjs";

function vector(timestamp, positionKm, velocityKmPerSecond = { x: 0, y: 0, z: 0 }) {
  return { timestamp, positionKm, velocityKmPerSecond };
}

function series(id, center, vectors) {
  return { target: { id }, center, vectors };
}

test("interpolates JPL position and velocity with cubic Hermite samples", () => {
  const body = series("399", "Sun", [
    vector(0, { x: 0, y: 0, z: 0 }),
    vector(10000, { x: 10, y: 0, z: 0 }),
  ]);
  const midpoint = horizonsStateAt(body, 5000);

  assert.equal(midpoint.positionKm.x, 5);
  assert.equal(midpoint.velocityKmPerSecond.x, 1.5);
  assert.equal(horizonsStateAt(body, 0).positionKm.x, 0);
  assert.equal(horizonsStateAt(body, 10000).positionKm.x, 10);
  assert.equal(horizonsStateAt(body, -1), null);
  assert.equal(horizonsStateAt(body, 10001), null);
});

test("places the Moon by adding its Earth-centered JPL vector to Earth's Sun-centered vector", () => {
  const positions = solarSystemPositions({
    bodies: [series("399", "Sun", [
      vector(0, { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 }),
      vector(1000, { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 }),
    ])],
    moon: series("301", "Earth", [
      vector(0, { x: 0, y: 384400, z: 0 }),
      vector(1000, { x: 0, y: 384400, z: 0 }),
    ]),
  }, 500);

  assert.equal(positions.get("301").x, 1);
  assert.equal(positions.get("301").y, 384400 / ASTRONOMICAL_UNIT_KM);
});

test("reports time-specific distance and speed from interpolated vectors", () => {
  const result = solarSystemDistances({
    bodies: [series("399", "Sun", [
      vector(0, { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      vector(10000, { x: ASTRONOMICAL_UNIT_KM + 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    ])],
    moon: series("301", "Earth", [
      vector(0, { x: 0, y: 384400, z: 0 }, { x: 0, y: 0, z: 0 }),
      vector(10000, { x: 0, y: 384410, z: 0 }, { x: 0, y: 0, z: 0 }),
    ]),
  }, 5000);

  assert.equal(result.get("399").distanceKm, ASTRONOMICAL_UNIT_KM + 5);
  assert.equal(result.get("301").distanceKm, 384405);
});

test("does not extrapolate when optional lunar samples are absent", () => {
  const positions = solarSystemPositions({
    bodies: [series("399", "Sun", [
      vector(0, { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 }),
      vector(1000, { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 }),
    ])],
    moon: null,
  }, 0);

  assert.equal(positions.has("399"), true);
  assert.equal(positions.has("301"), false);
});

test("rejects malformed or undersampled series rather than fabricating positions", () => {
  assert.throws(() => horizonsStateAt({ vectors: [] }, 0), /at least two JPL vectors/);
  assert.throws(() => horizonsStateAt({
    vectors: [
      vector(0, { x: 0, y: 0, z: 0 }),
      vector(1000, { x: Number.NaN, y: 0, z: 0 }),
    ],
  }, 500), /invalid position or velocity/);
});

test("projects points with camera yaw, pitch, and perspective depth", () => {
  const camera = { x: 0, y: 0, z: 0 };
  const viewport = { width: 800, height: 600 };
  const projection = {
    yaw: 0,
    pitch: 0,
    distanceAu: 10,
    focalLengthPx: 100,
  };

  assert.deepEqual(projectSolarPoint(
    { x: 1, y: 0, z: 0 },
    camera,
    viewport,
    projection,
  ), { x: 410, y: 300, depth: 0, scale: 10 });
  assert.equal(projectSolarPoint(
    { x: 0, y: 0, z: 5 },
    camera,
    viewport,
    projection,
  ).scale, 20);
  assert.equal(projectSolarPoint(
    { x: 0, y: 0, z: 10 },
    camera,
    viewport,
    projection,
  ), null);
});

test("places the camera at the requested 3D distance and orientation", () => {
  const camera = { x: 1, y: 2, z: 3 };
  const projection = { yaw: 0.7, pitch: 0.4, distanceAu: 10, focalLengthPx: 500 };
  const viewport = { width: 800, height: 600 };
  const position = solarCameraPosition(camera, projection);

  assert.ok(Math.abs(position.x - 1) > 0);
  assert.ok(Math.abs(position.y - 2) > 0);
  assert.ok(position.z > 3);
  const midpoint = {
    x: (camera.x + position.x) / 2,
    y: (camera.y + position.y) / 2,
    z: (camera.z + position.z) / 2,
  };
  const projected = projectSolarPoint(midpoint, camera, viewport, projection);
  assert.ok(Math.abs(projected.x - 400) < 1e-10);
  assert.ok(Math.abs(projected.y - 300) < 1e-10);
  assert.ok(Math.abs(projected.depth - 5) < 1e-10);
  assert.equal(projected.scale, 100);
});
