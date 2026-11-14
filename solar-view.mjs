export const ASTRONOMICAL_UNIT_KM = 149597870.7;
export const SUN_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6371;
export const EARTH_OBLIQUITY_DEGREES = 23.439;

export const SOLAR_VIEW_BODIES = Object.freeze([
  Object.freeze({ id: "199", name: "Mercury", radiusKm: 2439.7, color: "#b7b2aa" }),
  Object.freeze({ id: "299", name: "Venus", radiusKm: 6051.8, color: "#e5bd87" }),
  Object.freeze({ id: "399", name: "Earth", radiusKm: EARTH_RADIUS_KM, color: "#58b9ed" }),
  Object.freeze({ id: "301", name: "Moon", radiusKm: 1737.4, color: "#d0d5d4" }),
  Object.freeze({ id: "499", name: "Mars", radiusKm: 3389.5, color: "#e97866" }),
  Object.freeze({ id: "599", name: "Jupiter", radiusKm: 69911, color: "#d5b27a" }),
  Object.freeze({ id: "699", name: "Saturn", radiusKm: 58232, color: "#d9c68a" }),
  Object.freeze({ id: "799", name: "Uranus", radiusKm: 25362, color: "#7ed1d1" }),
  Object.freeze({ id: "899", name: "Neptune", radiusKm: 24622, color: "#8298ed" }),
  Object.freeze({ id: "1;", name: "Ceres", radiusKm: 473, color: "#b6a9c7" }),
  Object.freeze({ id: "9", name: "Pluto barycenter", radiusKm: 1188.3, color: "#d5a89a" }),
  Object.freeze({ id: "136108;", name: "Haumea", radiusKm: 816, color: "#c5a6de" }),
  Object.freeze({ id: "136472;", name: "Makemake", radiusKm: 715, color: "#dd9e78" }),
  Object.freeze({ id: "136199;", name: "Eris", radiusKm: 1163, color: "#a7bfd6" }),
]);

export function horizonsStateAt(series, timeMs) {
  if (!Number.isFinite(timeMs) || !Array.isArray(series?.vectors) || series.vectors.length < 2) {
    throw new TypeError("Ephemeris interpolation requires a finite time and at least two JPL vectors.");
  }
  const vectors = series.vectors;
  if (timeMs < vectors[0].timestamp || timeMs > vectors.at(-1).timestamp) return null;

  let lower = 0;
  let upper = vectors.length - 1;
  while (upper - lower > 1) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (vectors[midpoint].timestamp <= timeMs) lower = midpoint;
    else upper = midpoint;
  }
  const first = vectors[lower];
  if (timeMs === first.timestamp) {
    return {
      timestamp: timeMs,
      positionKm: { ...first.positionKm },
      velocityKmPerSecond: { ...first.velocityKmPerSecond },
    };
  }
  const second = vectors[upper];
  if (timeMs === second.timestamp) {
    return {
      timestamp: timeMs,
      positionKm: { ...second.positionKm },
      velocityKmPerSecond: { ...second.velocityKmPerSecond },
    };
  }

  const durationSeconds = (second.timestamp - first.timestamp) / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TypeError("JPL vector timestamps must be strictly increasing.");
  }
  const fraction = (timeMs - first.timestamp) / (second.timestamp - first.timestamp);
  const squared = fraction * fraction;
  const cubed = squared * fraction;
  const positionKm = {};
  const velocityKmPerSecond = {};
  for (const axis of ["x", "y", "z"]) {
    const start = first.positionKm[axis];
    const end = second.positionKm[axis];
    const startVelocity = first.velocityKmPerSecond[axis];
    const endVelocity = second.velocityKmPerSecond[axis];
    if (![start, end, startVelocity, endVelocity].every(Number.isFinite)) {
      throw new TypeError("JPL vector series contains invalid position or velocity values.");
    }
    positionKm[axis] = (
      (2 * cubed - 3 * squared + 1) * start
      + (cubed - 2 * squared + fraction) * durationSeconds * startVelocity
      + (-2 * cubed + 3 * squared) * end
      + (cubed - squared) * durationSeconds * endVelocity
    );
    velocityKmPerSecond[axis] = (
      (6 * squared - 6 * fraction) / durationSeconds * start
      + (3 * squared - 4 * fraction + 1) * startVelocity
      + (-6 * squared + 6 * fraction) / durationSeconds * end
      + (3 * squared - 2 * fraction) * endVelocity
    );
  }
  return { timestamp: timeMs, positionKm, velocityKmPerSecond };
}

export function solarSystemVectorsAt(payload, timeMs) {
  const vectors = new Map();
  for (const body of payload.bodies) {
    const state = horizonsStateAt(body, timeMs);
    if (state) vectors.set(body.target.id, state);
  }

  const earth = vectors.get("399");
  if (earth && payload.moon) {
    const moonFromEarth = horizonsStateAt(payload.moon, timeMs);
    if (moonFromEarth) {
      const positionKm = {};
      const velocityKmPerSecond = {};
      for (const axis of ["x", "y", "z"]) {
        positionKm[axis] = earth.positionKm[axis] + moonFromEarth.positionKm[axis];
        velocityKmPerSecond[axis] = earth.velocityKmPerSecond[axis]
          + moonFromEarth.velocityKmPerSecond[axis];
      }
      vectors.set("301", { timestamp: timeMs, positionKm, velocityKmPerSecond });
    }
  }
  return vectors;
}

export function solarSystemPositions(payload, timeMs) {
  return new Map(
    [...solarSystemVectorsAt(payload, timeMs)].map(([id, state]) => [id, {
      x: state.positionKm.x / ASTRONOMICAL_UNIT_KM,
      y: state.positionKm.y / ASTRONOMICAL_UNIT_KM,
      z: state.positionKm.z / ASTRONOMICAL_UNIT_KM,
    }]),
  );
}

export function solarSystemDistances(payload, timeMs) {
  const vectors = solarSystemVectorsAt(payload, timeMs);
  const distances = new Map(
    [...vectors].map(([id, state]) => [
      id,
      {
        distanceKm: Math.hypot(
          state.positionKm.x,
          state.positionKm.y,
          state.positionKm.z,
        ),
        speedKmPerSecond: Math.hypot(
          state.velocityKmPerSecond.x,
          state.velocityKmPerSecond.y,
          state.velocityKmPerSecond.z,
        ),
      },
    ]),
  );
  const moon = vectors.get("301");
  const earth = vectors.get("399");
  if (moon && earth) {
    const moonFromEarth = {
      x: moon.positionKm.x - earth.positionKm.x,
      y: moon.positionKm.y - earth.positionKm.y,
      z: moon.positionKm.z - earth.positionKm.z,
    };
    const moonVelocityFromEarth = {
      x: moon.velocityKmPerSecond.x - earth.velocityKmPerSecond.x,
      y: moon.velocityKmPerSecond.y - earth.velocityKmPerSecond.y,
      z: moon.velocityKmPerSecond.z - earth.velocityKmPerSecond.z,
    };
    distances.set("301", {
      distanceKm: Math.hypot(moonFromEarth.x, moonFromEarth.y, moonFromEarth.z),
      speedKmPerSecond: Math.hypot(
        moonVelocityFromEarth.x,
        moonVelocityFromEarth.y,
        moonVelocityFromEarth.z,
      ),
    });
  }
  return distances;
}

export function projectSolarPoint(position, camera, viewport, projection) {
  const deltaX = position.x - camera.x;
  const deltaY = position.y - camera.y;
  const deltaZ = position.z - camera.z;
  const cosYaw = Math.cos(projection.yaw);
  const sinYaw = Math.sin(projection.yaw);
  const cosPitch = Math.cos(projection.pitch);
  const sinPitch = Math.sin(projection.pitch);
  const rotatedX = cosYaw * deltaX - sinYaw * deltaY;
  const rotatedY = sinYaw * deltaX + cosYaw * deltaY;
  const cameraY = cosPitch * rotatedY - sinPitch * deltaZ;
  const depth = sinPitch * rotatedY + cosPitch * deltaZ;
  const distanceToCameraPlane = projection.distanceAu - depth;
  if (distanceToCameraPlane <= projection.distanceAu * 0.01) return null;

  const scale = projection.focalLengthPx / distanceToCameraPlane;
  return {
    x: viewport.width / 2 + rotatedX * scale,
    y: viewport.height / 2 - cameraY * scale,
    depth,
    scale,
  };
}

export function solarCameraPosition(camera, projection) {
  const distance = projection.distanceAu;
  const pitchOffset = Math.sin(projection.pitch) * distance;
  return {
    x: camera.x + Math.sin(projection.yaw) * pitchOffset,
    y: camera.y + Math.cos(projection.yaw) * pitchOffset,
    z: camera.z + Math.cos(projection.pitch) * distance,
  };
}
