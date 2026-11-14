import * as satellite from "satellite.js";

const EARTH_RADIUS_KM = 6378.137;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const TAU = 2 * Math.PI;

export const ORBIT_REGIMES = Object.freeze([
  Object.freeze({ id: "vleo", label: "Very Low Earth Orbit (VLEO)", shortLabel: "VLEO", color: "#79b8ff" }),
  Object.freeze({ id: "leo", label: "Low Earth Orbit (LEO)", shortLabel: "LEO", color: "#f1bf6f" }),
  Object.freeze({ id: "meo", label: "Medium Earth Orbit (MEO)", shortLabel: "MEO", color: "#ae9cff" }),
  Object.freeze({ id: "geo", label: "Geosynchronous Orbit (GEO)", shortLabel: "GEO", color: "#62d2bf" }),
  Object.freeze({ id: "heo", label: "Highly Elliptical Orbit (HEO)", shortLabel: "HEO", color: "#ff8b86" }),
  Object.freeze({ id: "high", label: "High Earth / Transfer Orbit", shortLabel: "HIGH", color: "#c6cfd8" }),
]);

function normalizeDegrees(degrees) {
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

export function classifyOrbit(object) {
  const perigeeKm = object.semiMajorAxisKm * (1 - object.eccentricity) - EARTH_RADIUS_KM;
  const apogeeKm = object.semiMajorAxisKm * (1 + object.eccentricity) - EARTH_RADIUS_KM;

  if (apogeeKm >= 120 && apogeeKm <= 450 && object.eccentricity < 0.25) return ORBIT_REGIMES[0];
  if (apogeeKm <= 2000) return ORBIT_REGIMES[1];
  if (object.eccentricity >= 0.25) return ORBIT_REGIMES[4];

  const periodHours = orbitPeriodSeconds(object) / 3600;
  if (periodHours >= 23.5 && periodHours <= 24.5 && object.eccentricity <= 0.1) {
    return ORBIT_REGIMES[3];
  }
  if (apogeeKm < 35786) return ORBIT_REGIMES[2];
  return ORBIT_REGIMES[5];
}

export function parseCatalog(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("The orbital catalog response was not a JSON array.");
  }

  return records.flatMap((record) => {
    const meanMotion = Number(record.MEAN_MOTION);
    const eccentricity = Number(record.ECCENTRICITY);
    const epoch = Date.parse(record.EPOCH);
    const catalogId = Number(record.NORAD_CAT_ID);
    const dragTerms = [
      record.BSTAR,
      record.MEAN_MOTION_DOT,
      record.MEAN_MOTION_DDOT,
    ].map(Number);
    const requiredAngles = [
      record.INCLINATION,
      record.RA_OF_ASC_NODE,
      record.ARG_OF_PERICENTER,
      record.MEAN_ANOMALY,
    ].map(Number);

    if (
      !Number.isFinite(meanMotion)
      || meanMotion <= 0
      || !Number.isFinite(eccentricity)
      || eccentricity < 0
      || eccentricity >= 1
      || !Number.isFinite(epoch)
      || !Number.isInteger(catalogId)
      || catalogId <= 0
      || !dragTerms.every(Number.isFinite)
      || !requiredAngles.every(Number.isFinite)
    ) {
      return [];
    }

    let satrec;
    try {
      satrec = satellite.json2satrec(record);
    } catch {
      return [];
    }

    if (
      !satrec
      || satrec.error !== 0
      || !Number.isFinite(satrec.no)
      || satrec.no <= 0
      || !Number.isFinite(satrec.a)
      || satrec.a <= 1
    ) return [];

    const initialState = satellite.sgp4(satrec, 0);
    if (
      !initialState?.position
      || satrec.error !== 0
      || !Object.values(initialState.position).every(Number.isFinite)
    ) return [];

    const object = {
      id: String(catalogId),
      name: String(record.OBJECT_NAME ?? "Unnamed object"),
      objectId: String(record.OBJECT_ID ?? "—"),
      epoch,
      meanMotionRadiansPerSecond: satrec.no / 60,
      eccentricity,
      inclination: requiredAngles[0] * Math.PI / 180,
      semiMajorAxisKm: satrec.a * EARTH_RADIUS_KM,
      meanMotion,
      publishedEpoch: String(record.EPOCH),
      satrec,
    };
    object.perigeeKm = object.semiMajorAxisKm * (1 - object.eccentricity) - EARTH_RADIUS_KM;
    object.apogeeKm = object.semiMajorAxisKm * (1 + object.eccentricity) - EARTH_RADIUS_KM;
    object.regimeId = classifyOrbit(object).id;
    return [object];
  });
}

export function positionAt(object, timeMs) {
  if (!Number.isFinite(timeMs)) throw new TypeError("Position time must be a finite timestamp.");

  const date = new Date(timeMs);
  const state = satellite.propagate(object.satrec, date);
  if (!state?.position || !state?.velocity) return null;

  const gmst = satellite.gstime(date);
  const earthFixed = satellite.eciToEcf(state.position, gmst);
  const geodetic = satellite.eciToGeodetic(state.position, gmst);
  const radiusKm = Math.hypot(earthFixed.x, earthFixed.y, earthFixed.z);
  if (
    !Number.isFinite(radiusKm)
    || !Number.isFinite(geodetic.height)
    || !Object.values(earthFixed).every(Number.isFinite)
    || !Object.values(state.velocity).every(Number.isFinite)
  ) return null;

  return {
    latitude: Math.atan2(earthFixed.z, Math.hypot(earthFixed.x, earthFixed.y)) * DEGREES_PER_RADIAN,
    longitude: normalizeDegrees(Math.atan2(earthFixed.y, earthFixed.x) * DEGREES_PER_RADIAN),
    altitudeKm: geodetic.height,
    radiusKm,
    speedKmPerSecond: Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z),
  };
}

export function orbitPeriodSeconds(object) {
  return TAU / object.meanMotionRadiansPerSecond;
}

export const EARTH_RADIUS_KM_VALUE = EARTH_RADIUS_KM;
