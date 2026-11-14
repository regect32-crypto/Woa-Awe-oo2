import test from "node:test";
import assert from "node:assert/strict";
import {
  magnetopauseStandoffEarthRadii,
  solarWindDynamicPressureNPa,
  solarWindEarthRadiiPerSecond,
} from "./environment.mjs";

test("converts ACE speed and density into proton dynamic pressure", () => {
  const pressure = solarWindDynamicPressureNPa(400, 5);
  assert.ok(Math.abs(pressure - 1.338) < 0.002);
});

test("pressure-only magnetopause estimate contracts as solar-wind pressure rises", () => {
  const nominal = magnetopauseStandoffEarthRadii(2);
  const compressed = magnetopauseStandoffEarthRadii(8);
  assert.equal(nominal, 10);
  assert.ok(compressed < nominal);
  assert.equal(magnetopauseStandoffEarthRadii(0), null);
  assert.equal(magnetopauseStandoffEarthRadii(1e-9), 14);
  assert.equal(magnetopauseStandoffEarthRadii(1e9), 6);
});

test("converts measured flow speed into Earth radii per second", () => {
  assert.ok(Math.abs(solarWindEarthRadiiPerSecond(400) - 400 / 6371.0088) < 1e-12);
});

test("rejects invalid physical inputs", () => {
  assert.throws(() => solarWindDynamicPressureNPa(400, -1), RangeError);
  assert.throws(() => solarWindDynamicPressureNPa(Number.MAX_VALUE, 1), RangeError);
  assert.throws(() => magnetopauseStandoffEarthRadii(Number.NaN), TypeError);
  assert.throws(() => solarWindEarthRadiiPerSecond(-1), RangeError);
});
