import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceSimulationTime,
  MAX_SIMULATION_OFFSET_MINUTES,
  simulationTimeAtOffset,
  SIMULATION_WINDOW_MS,
} from "./time-model.mjs";

test("maps offsets around live time and bounds the model window", () => {
  const liveTime = 1_000_000;
  assert.equal(simulationTimeAtOffset(liveTime, 60), liveTime + 60 * 60 * 1000);
  assert.equal(
    simulationTimeAtOffset(liveTime, MAX_SIMULATION_OFFSET_MINUTES + 1),
    liveTime + SIMULATION_WINDOW_MS,
  );
  assert.equal(
    simulationTimeAtOffset(liveTime, -MAX_SIMULATION_OFFSET_MINUTES - 1),
    liveTime - SIMULATION_WINDOW_MS,
  );
});

test("advances playback at the selected rate without exceeding the model window", () => {
  const liveTime = 5_000_000;
  assert.equal(advanceSimulationTime(liveTime, 1000, 60, liveTime), liveTime + 60_000);
  assert.equal(
    advanceSimulationTime(liveTime + SIMULATION_WINDOW_MS - 1000, 1000, 60, liveTime),
    liveTime + SIMULATION_WINDOW_MS,
  );
});

test("rejects invalid simulation times and playback rates", () => {
  assert.throws(() => simulationTimeAtOffset(Number.NaN, 0), /finite live time/);
  assert.throws(() => advanceSimulationTime(1000, -1, 1, 1000), /finite time/);
  assert.throws(() => advanceSimulationTime(1000, 1, 0, 1000), /finite time/);
});
