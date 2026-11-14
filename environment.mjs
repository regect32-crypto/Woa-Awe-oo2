const PROTON_MASS_KG = 1.67262192369e-27;
const EARTH_RADIUS_KM = 6371.0088;

export function solarWindDynamicPressureNPa(speedKmPerSecond, densityPerCm3) {
  if (!Number.isFinite(speedKmPerSecond) || !Number.isFinite(densityPerCm3)) {
    throw new TypeError("Solar-wind speed and density must be finite numbers.");
  }
  if (speedKmPerSecond < 0 || densityPerCm3 < 0) {
    throw new RangeError("Solar-wind speed and density cannot be negative.");
  }
  const speedMetersPerSecond = speedKmPerSecond * 1000;
  const densityPerM3 = densityPerCm3 * 1e6;
  const pressureNPa = PROTON_MASS_KG * densityPerM3 * speedMetersPerSecond ** 2 * 1e9;
  if (!Number.isFinite(pressureNPa)) {
    throw new RangeError("Solar-wind dynamic pressure is outside the representable range.");
  }
  return pressureNPa;
}

export function magnetopauseStandoffEarthRadii(dynamicPressureNPa) {
  if (!Number.isFinite(dynamicPressureNPa)) {
    throw new TypeError("Solar-wind dynamic pressure must be a finite number.");
  }
  if (dynamicPressureNPa <= 0) return null;
  const pressureBalancedDistance = 10 * (2 / dynamicPressureNPa) ** (1 / 6);
  return Math.max(6, Math.min(14, pressureBalancedDistance));
}

export function solarWindEarthRadiiPerSecond(speedKmPerSecond) {
  if (!Number.isFinite(speedKmPerSecond) || speedKmPerSecond < 0) {
    throw new RangeError("Solar-wind speed must be a finite, non-negative number.");
  }
  return speedKmPerSecond / EARTH_RADIUS_KM;
}
