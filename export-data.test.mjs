import test from "node:test";
import assert from "node:assert/strict";
import { createPositionCsv } from "./export-data.mjs";
import { ASTRONOMICAL_UNIT_KM } from "./solar-view.mjs";

test("exports satellite, planet, and Earth-centered Moon positions with provenance", () => {
  const timestamp = 5000;
  const csv = createPositionCsv({
    timeMs: timestamp,
    satelliteStates: [{
      object: { id: "123", name: 'Satellite, "A"' },
      position: {
        latitude: 12.5,
        longitude: -45.25,
        altitudeKm: 420,
        speedKmPerSecond: 7.6,
      },
    }],
    solarSystemPayload: {
      bodies: [{
        target: { id: "399", name: "Earth" },
        center: "Sun",
        vectors: [
          {
            timestamp: 0,
            positionKm: { x: ASTRONOMICAL_UNIT_KM, y: 0, z: 0 },
            velocityKmPerSecond: { x: 0, y: 0, z: 0 },
          },
          {
            timestamp: 10000,
            positionKm: { x: ASTRONOMICAL_UNIT_KM + 10, y: 0, z: 0 },
            velocityKmPerSecond: { x: 0, y: 0, z: 0 },
          },
        ],
      }],
      moon: {
        target: { id: "301", name: "Moon" },
        center: "Earth",
        vectors: [
          {
            timestamp: 0,
            positionKm: { x: 0, y: 384400, z: 0 },
            velocityKmPerSecond: { x: 0, y: 0, z: 0 },
          },
          {
            timestamp: 10000,
            positionKm: { x: 0, y: 384410, z: 0 },
            velocityKmPerSecond: { x: 0, y: 0, z: 0 },
          },
        ],
      },
    },
  });
  const rows = csv.split("\r\n");

  assert.match(rows[1], /"Satellite, ""A"""/);
  assert.match(rows[1], /SGP4\/SDP4 estimate from published OMM elements/);
  assert.match(rows[2], /Solar System,Earth,399/);
  assert.match(rows[3], /Solar System,Moon,301/);
  assert.match(rows[3], /Earth,,,,0,384405,0,384405,1\.5/);
  assert.equal(rows[2].split(",").length, 14);
  assert.ok(rows.every((row) => row.includes(new Date(timestamp).toISOString()) || row === rows[0]));
});

test("does not export formula-like catalog names as active spreadsheet formulas", () => {
  const csv = createPositionCsv({
    timeMs: 0,
    satelliteStates: [{
      object: { id: "1", name: "=HYPERLINK(\"https://example.invalid\")" },
      position: { latitude: 0, longitude: 0, altitudeKm: 0, speedKmPerSecond: 0 },
    }],
    solarSystemPayload: null,
  });

  assert.match(csv, /,"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
});

test("requires at least one available position and a valid time", () => {
  assert.throws(
    () => createPositionCsv({ satelliteStates: [], solarSystemPayload: null, timeMs: 0 }),
    /No satellite or Solar System positions/,
  );
  assert.throws(
    () => createPositionCsv({ satelliteStates: [], solarSystemPayload: null, timeMs: Number.NaN }),
    /finite model time/,
  );
});
