import { solarSystemVectorsAt } from "./solar-view.mjs";

const POSITION_CSV_COLUMNS = Object.freeze([
  "domain",
  "name",
  "id",
  "model_time_utc",
  "reference_center",
  "latitude_deg",
  "longitude_deg",
  "altitude_km",
  "x_km",
  "y_km",
  "z_km",
  "distance_km",
  "speed_km_s",
  "position_source",
]);

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function vectorMagnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function createPositionRow({
  domain,
  name,
  id,
  modelTime,
  center,
  latitude = null,
  longitude = null,
  altitude = null,
  position = null,
  distance = null,
  speed = null,
  source,
}) {
  return [
    domain,
    name,
    id,
    modelTime,
    center,
    latitude,
    longitude,
    altitude,
    position?.x,
    position?.y,
    position?.z,
    distance,
    speed,
    source,
  ];
}

export function createPositionCsv({ satelliteStates, solarSystemPayload, timeMs }) {
  if (!Number.isFinite(timeMs)) throw new TypeError("CSV export requires a finite model time.");
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) throw new RangeError("CSV export time is outside the supported date range.");
  const modelTime = date.toISOString();
  const rows = [];

  for (const { object, position } of satelliteStates) {
    if (!position) continue;
    rows.push(createPositionRow({
      domain: "Earth orbit",
      name: object.name,
      id: object.id,
      modelTime,
      center: "Earth",
      latitude: position.latitude,
      longitude: position.longitude,
      altitude: position.altitudeKm,
      speed: position.speedKmPerSecond,
      source: "SGP4/SDP4 estimate from published OMM elements",
    }));
  }

  if (solarSystemPayload) {
    const vectors = solarSystemVectorsAt(solarSystemPayload, timeMs);
    for (const body of solarSystemPayload.bodies) {
      const state = vectors.get(body.target.id);
      if (!state) continue;
      rows.push(createPositionRow({
        domain: "Solar System",
        name: body.target.name,
        id: body.target.id,
        modelTime,
        center: "Sun",
        position: state.positionKm,
        distance: vectorMagnitude(state.positionKm),
        speed: vectorMagnitude(state.velocityKmPerSecond),
        source: "JPL Horizons; interpolated between timestamped samples",
      }));
    }

    const moon = vectors.get("301");
    const earth = vectors.get("399");
    if (moon && earth) {
      const position = {
        x: moon.positionKm.x - earth.positionKm.x,
        y: moon.positionKm.y - earth.positionKm.y,
        z: moon.positionKm.z - earth.positionKm.z,
      };
      const velocity = {
        x: moon.velocityKmPerSecond.x - earth.velocityKmPerSecond.x,
        y: moon.velocityKmPerSecond.y - earth.velocityKmPerSecond.y,
        z: moon.velocityKmPerSecond.z - earth.velocityKmPerSecond.z,
      };
      rows.push(createPositionRow({
        domain: "Solar System",
        name: "Moon",
        id: "301",
        modelTime,
        center: "Earth",
        position,
        distance: vectorMagnitude(position),
        speed: vectorMagnitude(velocity),
        source: "JPL Horizons Earth-centered vector; interpolated between timestamped samples",
      }));
    }
  }

  if (rows.length === 0) {
    throw new Error("No satellite or Solar System positions are available to export yet.");
  }
  return [
    POSITION_CSV_COLUMNS.join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\r\n");
}
