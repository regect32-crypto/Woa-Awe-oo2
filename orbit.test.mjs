import test from "node:test";
import assert from "node:assert/strict";
import { classifyOrbit, parseCatalog, positionAt } from "./orbit.mjs";

function orbitAt(altitudeKm, eccentricity = 0, periodHours = 12) {
  return {
    semiMajorAxisKm: 6378.137 + altitudeKm,
    eccentricity,
    meanMotionRadiansPerSecond: 2 * Math.PI / (periodHours * 3600),
  };
}

const issRecord = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  EPOCH: "2026-11-13T09:36:10.705824",
  MEAN_MOTION: 15.49350588,
  ECCENTRICITY: 0.0007366,
  INCLINATION: 51.6324,
  RA_OF_ASC_NODE: 281.7005,
  ARG_OF_PERICENTER: 20.9423,
  MEAN_ANOMALY: 339.1866,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 59488,
  BSTAR: 0.00016503,
  MEAN_MOTION_DOT: 8.768e-5,
  MEAN_MOTION_DDOT: 0,
};

test("parses OMM records and preserves the published identity", () => {
  const [object] = parseCatalog([issRecord]);
  assert.equal(object.name, "ISS (ZARYA)");
  assert.equal(object.id, "25544");
  assert.equal(object.publishedEpoch, issRecord.EPOCH);
  assert.ok(object.semiMajorAxisKm > 6378);
  assert.equal(object.regimeId, "vleo");
  assert.ok(Number.isFinite(object.perigeeKm));
  assert.ok(Number.isFinite(object.apogeeKm));
});

test("skips invalid or non-orbiting records", () => {
  const invalid = { ...issRecord, MEAN_MOTION: "not-a-number" };
  const belowEarth = { ...issRecord, MEAN_MOTION: 100 };
  assert.deepEqual(parseCatalog([invalid, belowEarth]), []);
});

test("propagates a finite Earth-fixed position for a catalog object", () => {
  const [object] = parseCatalog([issRecord]);
  const position = positionAt(object, Date.parse(issRecord.EPOCH));
  assert.ok(position.latitude >= -90 && position.latitude <= 90);
  assert.ok(position.longitude >= -180 && position.longitude <= 180);
  assert.ok(position.altitudeKm > 100 && position.altitudeKm < 1000);
  assert.ok(Math.abs(position.latitude - 0.0000081) < 0.01);
  assert.ok(Math.abs(position.longitude - 85.1361) < 0.01);
  assert.ok(Math.abs(position.altitudeKm - 414.686) < 0.2);
  assert.ok(Math.abs(position.radiusKm - position.altitudeKm - 6378.137) < 1);
  assert.ok(position.speedKmPerSecond > 7 && position.speedKmPerSecond < 8);
});

test("rejects malformed catalog payloads and timestamps", () => {
  assert.throws(() => parseCatalog({}), /JSON array/);
  const [object] = parseCatalog([issRecord]);
  assert.throws(() => positionAt(object, Number.NaN), /finite timestamp/);
});

test("classifies low, medium, geosynchronous, elliptical, and high orbits", () => {
  assert.equal(classifyOrbit(orbitAt(300, 0.01)).id, "vleo");
  assert.equal(classifyOrbit(orbitAt(800)).id, "leo");
  assert.equal(classifyOrbit(orbitAt(10000)).id, "meo");
  assert.equal(classifyOrbit(orbitAt(35786, 0.001, 23.934)).id, "geo");
  assert.equal(classifyOrbit(orbitAt(20000, 0.7)).id, "heo");
  assert.equal(classifyOrbit(orbitAt(50000, 0.05, 48)).id, "high");
});
