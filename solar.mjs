const DEGREES_PER_RADIAN = 180 / Math.PI;

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

export function subsolarPoint(timeMs) {
  if (!Number.isFinite(timeMs)) throw new TypeError("Solar position time must be a finite timestamp.");

  const julianDate = timeMs / 86400000 + 2440587.5;
  const daysSinceJ2000 = julianDate - 2451545;
  const centuriesSinceJ2000 = daysSinceJ2000 / 36525;
  const meanLongitude = normalizeDegrees(280.46 + 0.9856474 * daysSinceJ2000);
  const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * daysSinceJ2000) / DEGREES_PER_RADIAN;
  const eclipticLongitude = (
    meanLongitude
    + 1.915 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)
  ) / DEGREES_PER_RADIAN;
  const obliquity = (23.439 - 0.0000004 * daysSinceJ2000) / DEGREES_PER_RADIAN;
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const greenwichMeanSiderealTime = normalizeDegrees(
    280.46061837
    + 360.98564736629 * daysSinceJ2000
    + 0.000387933 * centuriesSinceJ2000 ** 2
    - centuriesSinceJ2000 ** 3 / 38710000,
  ) / DEGREES_PER_RADIAN;

  return {
    latitude: declination * DEGREES_PER_RADIAN,
    longitude: normalizeDegrees((rightAscension - greenwichMeanSiderealTime) * DEGREES_PER_RADIAN + 180) - 180,
  };
}
