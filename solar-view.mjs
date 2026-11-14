export const ASTRONOMICAL_UNIT_KM = 149597870.7;
export const SUN_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6371;
export const EARTH_OBLIQUITY_DEGREES = 23.439;

export const SOLAR_VIEW_BODIES = Object.freeze([
  Object.freeze({ id: "199", name: "Mercury", radiusKm: 2439.7, orbitAu: 0.387, color: "#b7b2aa" }),
  Object.freeze({ id: "299", name: "Venus", radiusKm: 6051.8, orbitAu: 0.723, color: "#e5bd87" }),
  Object.freeze({ id: "399", name: "Earth", radiusKm: EARTH_RADIUS_KM, orbitAu: 1, color: "#58b9ed" }),
  Object.freeze({ id: "301", name: "Moon", radiusKm: 1737.4, orbitAu: null, color: "#d0d5d4" }),
  Object.freeze({ id: "499", name: "Mars", radiusKm: 3389.5, orbitAu: 1.524, color: "#e97866" }),
  Object.freeze({ id: "599", name: "Jupiter", radiusKm: 69911, orbitAu: 5.203, color: "#d5b27a" }),
  Object.freeze({ id: "699", name: "Saturn", radiusKm: 58232, orbitAu: 9.537, color: "#d9c68a" }),
  Object.freeze({ id: "799", name: "Uranus", radiusKm: 25362, orbitAu: 19.191, color: "#7ed1d1" }),
  Object.freeze({ id: "899", name: "Neptune", radiusKm: 24622, orbitAu: 30.07, color: "#8298ed" }),
]);

export function vectorAtEpoch(vector, timeMs) {
  if (!Number.isFinite(timeMs) || !Number.isFinite(vector?.timestamp)) {
    throw new TypeError("Ephemeris positions require finite timestamps.");
  }
  const elapsedSeconds = (timeMs - vector.timestamp) / 1000;
  const { positionKm, velocityKmPerSecond } = vector;
  const position = {};
  for (const axis of ["x", "y", "z"]) {
    if (!Number.isFinite(positionKm?.[axis]) || !Number.isFinite(velocityKmPerSecond?.[axis])) {
      throw new TypeError("Ephemeris positions require finite position and velocity vectors.");
    }
    position[axis] = (
      positionKm[axis] + velocityKmPerSecond[axis] * elapsedSeconds
    ) / ASTRONOMICAL_UNIT_KM;
  }
  return position;
}

export function solarSystemPositions(payload, timeMs) {
  const positions = new Map(
    payload.bodies.map((body) => [body.target.id, vectorAtEpoch(body, timeMs)]),
  );
  const earth = positions.get("399");
  if (earth && payload.moon) {
    const moonFromEarth = vectorAtEpoch(payload.moon, timeMs);
    positions.set("301", {
      x: earth.x + moonFromEarth.x,
      y: earth.y + moonFromEarth.y,
      z: earth.z + moonFromEarth.z,
    });
  }
  return positions;
}
