import test from "node:test";
import assert from "node:assert/strict";
import { subsolarPoint } from "./solar.mjs";

test("computes a finite subsolar point near the equator at equinox", () => {
  const point = subsolarPoint(Date.parse("2026-03-20T12:00:00Z"));
  assert.ok(Math.abs(point.latitude) < 2);
  assert.ok(Math.abs(point.longitude) < 3);
  assert.ok(point.longitude >= -180 && point.longitude <= 180);
});

test("rejects invalid solar-position timestamps", () => {
  assert.throws(() => subsolarPoint(Number.NaN), /finite timestamp/);
});
