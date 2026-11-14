export const MAX_SIMULATION_OFFSET_MINUTES = 12 * 60;
export const SIMULATION_WINDOW_MS = MAX_SIMULATION_OFFSET_MINUTES * 60 * 1000;

export function simulationTimeAtOffset(liveTimeMs, offsetMinutes) {
  if (!Number.isFinite(liveTimeMs) || !Number.isFinite(offsetMinutes)) {
    throw new TypeError("Simulation time requires a finite live time and offset.");
  }
  const boundedOffset = Math.max(
    -MAX_SIMULATION_OFFSET_MINUTES,
    Math.min(MAX_SIMULATION_OFFSET_MINUTES, offsetMinutes),
  );
  return liveTimeMs + boundedOffset * 60 * 1000;
}

export function advanceSimulationTime(timeMs, elapsedMs, rate, liveTimeMs) {
  if (
    !Number.isFinite(timeMs)
    || !Number.isFinite(elapsedMs)
    || elapsedMs < 0
    || !Number.isFinite(rate)
    || rate <= 0
    || !Number.isFinite(liveTimeMs)
  ) {
    throw new TypeError("Simulation playback requires finite time, elapsed duration, rate, and live time.");
  }
  return simulationTimeAtOffset(liveTimeMs, (timeMs + elapsedMs * rate - liveTimeMs) / 60000);
}
