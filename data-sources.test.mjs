import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAircraftPayload,
  parseHorizonsVector,
  parseSatnogsStations,
} from "./data-sources.mjs";

test("keeps recent aircraft with finite Earth positions and converts altitude", () => {
  const aircraft = parseAircraftPayload({
    ac: [
      { hex: "abc123", flight: " TEST123 ", lat: 47.6, lon: -122.3, alt_geom: 10000, seen_pos: 5, track: 90, gs: 210 },
      { hex: "unknown", lat: 47, lon: -122, alt_geom: 10000, seen_pos: 3, track: null, gs: null },
      { hex: "stale", lat: 0, lon: 0, alt_baro: 1000, seen_pos: 121 },
      { hex: "ground", lat: 0, lon: 0, alt_baro: "ground", seen_pos: 2 },
    ],
  }, 100000);

  assert.equal(aircraft.length, 2);
  const { altitudeKm, ...position } = aircraft[0];
  assert.deepEqual(position, {
    id: "abc123",
    name: "TEST123",
    latitude: 47.6,
    longitude: -122.3,
    trackDegrees: 90,
    groundSpeedKnots: 210,
    positionTimestamp: 95000,
  });
  assert.ok(Math.abs(altitudeKm - 3.048) < 1e-12);
  assert.equal(aircraft[1].trackDegrees, null);
  assert.equal(aircraft[1].groundSpeedKnots, null);
});

test("filters malformed SatNOGS station coordinates without exposing owner data", () => {
  const stations = parseSatnogsStations([
    { id: 1, name: "Station", lat: 40, lng: -75, altitude: 100, status: "Online", is_connected: true, future_observations: 4, last_seen: "2026-11-14T01:00:00Z", owner: "private-name" },
    { id: 2, name: "Invalid", lat: 95, lng: 0 },
  ]);
  assert.deepEqual(stations, [{
    id: "1",
    name: "Station",
    latitude: 40,
    longitude: -75,
    altitudeKm: 0.1,
    status: "Online",
    connected: true,
    futureObservations: 4,
    lastSeen: Date.parse("2026-11-14T01:00:00Z"),
  }]);
});

test("parses Earth-centered JPL vectors with epoch and ecliptic direction", () => {
  const vector = parseHorizonsVector(`$$SOE
2461358.569444444 = A.D. 2026-Nov-14 01:40:00.0000 UT
 X =-1.6E+08 Y = 1.2E+08 Z = 6.0E+06
 VX= 1.4E+00 VY=-2.3E+01 VZ= 4.4E-01
 LT= 6.6E+02 RG= 1.98E+08 RR=-1.47E+01
$$EOE`, "499");

  assert.equal(vector.target.name, "Mars");
  assert.equal(vector.timestamp, Date.UTC(2026, 10, 14, 1, 40));
  assert.equal(vector.center, "Earth");
  assert.equal(vector.referenceFrame, "Ecliptic J2000");
  assert.equal(vector.distanceKm, 1.98e8);
  assert.ok(vector.longitudeDegrees > 0 && vector.longitudeDegrees < 360);
  assert.throws(() => parseHorizonsVector("No ephemeris", "499"), /no vector ephemeris/);
});
