import test from "node:test";
import assert from "node:assert/strict";
import { parseSpaceWeatherSeries } from "./space-weather.mjs";

test("selects clean, valid GOES X-ray measurements in chronological order", () => {
  const series = parseSpaceWeatherSeries([
    { time_tag: "2026-11-14T00:02:00Z", satellite: 18, flux: 1e-7, energy: "0.1-0.8nm", electron_contaminaton: false },
    { time_tag: "2026-11-14T00:01:00Z", flux: 2e-7, energy: "0.1-0.8nm", electron_contaminaton: true },
    { time_tag: "2026-11-14T00:00:00Z", flux: 3e-7, energy: "0.05-0.4nm", electron_contaminaton: false },
    { time_tag: "2026-11-14T00:03:00Z", flux: "invalid", energy: "0.1-0.8nm", electron_contaminaton: false },
  ], "xray");

  assert.deepEqual(series, [{
    value: 1e-7,
    timestamp: Date.parse("2026-11-14T00:02:00Z"),
    satellite: 18,
  }]);
});

test("parses NOAA Kp timestamps as UTC and rejects out-of-range values", () => {
  const series = parseSpaceWeatherSeries([
    { time_tag: "2026-11-14T00:01:00", estimated_kp: 4.67 },
    { time_tag: "2026-11-14T00:02:00", estimated_kp: 9.1 },
  ], "kp");

  assert.deepEqual(series, [{
    value: 4.67,
    timestamp: Date.UTC(2026, 10, 14, 0, 1),
  }]);
});

test("keeps quality-approved ACE solar-wind plasma values", () => {
  const series = parseSpaceWeatherSeries([
    { time_tag: "2026-11-14T00:00:00", dsflag: 1, speed: 500, dens: 8, temperature: 100000 },
    { time_tag: "2026-11-13T23:00:00", dsflag: 0, speed: 400, dens: 4.5, temperature: 79000 },
  ], "solarwind");

  assert.deepEqual(series, [{
    value: 400,
    timestamp: Date.parse("2026-11-13T23:00:00Z"),
    density: 4.5,
    temperature: 79000,
  }]);
});

test("reports invalid space-weather payloads and feed identifiers", () => {
  assert.throws(() => parseSpaceWeatherSeries({}, "kp"), /JSON array/);
  assert.throws(() => parseSpaceWeatherSeries([], "unknown"), /Unknown space-weather feed/);
});
