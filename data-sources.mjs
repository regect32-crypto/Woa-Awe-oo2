export const HORIZONS_TARGETS = Object.freeze([
  Object.freeze({ id: "10", name: "Sun" }),
  Object.freeze({ id: "199", name: "Mercury" }),
  Object.freeze({ id: "299", name: "Venus" }),
  Object.freeze({ id: "399", name: "Earth" }),
  Object.freeze({ id: "499", name: "Mars" }),
  Object.freeze({ id: "599", name: "Jupiter" }),
  Object.freeze({ id: "699", name: "Saturn" }),
  Object.freeze({ id: "799", name: "Uranus" }),
  Object.freeze({ id: "899", name: "Neptune" }),
  Object.freeze({ id: "301", name: "Moon" }),
]);

export const MOON_TARGET = HORIZONS_TARGETS.find(({ id }) => id === "301");
export const SOLAR_SYSTEM_BODIES = Object.freeze(
  HORIZONS_TARGETS.filter(({ id }) => id !== "10" && id !== "301"),
);

const MONTHS = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3],
  ["May", 4], ["Jun", 5], ["Jul", 6], ["Aug", 7],
  ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
]);

function isValidLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseAircraftPayload(payload, fetchedAt = Date.now()) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.ac)) {
    throw new TypeError("ADSB.lol response did not contain an aircraft list.");
  }

  const aircraft = [];
  for (const record of payload.ac) {
    if (!record || typeof record !== "object") continue;
    const latitude = Number(record.lat);
    const longitude = Number(record.lon);
    const altitudeFeet = Number(record.alt_geom ?? record.alt_baro);
    const seenSeconds = Number(record.seen_pos);
    if (
      !isValidLatitude(latitude)
      || !isValidLongitude(longitude)
      || !Number.isFinite(altitudeFeet)
      || !Number.isFinite(seenSeconds)
      || seenSeconds < 0
      || seenSeconds > 120
    ) continue;

    aircraft.push({
      id: String(record.hex ?? `${latitude},${longitude}`),
      name: String(record.flight ?? record.r ?? record.hex ?? "Unidentified aircraft").trim()
        || "Unidentified aircraft",
      latitude,
      longitude,
      altitudeKm: altitudeFeet * 0.0003048,
      trackDegrees: finiteOrNull(record.track),
      groundSpeedKnots: finiteOrNull(record.gs),
      positionTimestamp: fetchedAt - seenSeconds * 1000,
    });
  }
  return aircraft;
}

export function parseSatnogsStations(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("SatNOGS response was not a station list.");
  }

  return records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const latitude = Number(record.lat);
    const longitude = Number(record.lng);
    const altitudeMeters = Number(record.altitude);
    if (
      record.id === null
      || record.id === undefined
      || !Number.isInteger(Number(record.id))
      || Number(record.id) <= 0
      || !isValidLatitude(latitude)
      || !isValidLongitude(longitude)
    ) {
      return [];
    }

    const lastSeen = typeof record.last_seen === "string" ? Date.parse(record.last_seen) : Number.NaN;
    return [{
      id: String(record.id),
      name: String(record.name ?? "SatNOGS station"),
      latitude,
      longitude,
      altitudeKm: Number.isFinite(altitudeMeters) ? altitudeMeters / 1000 : 0,
      status: String(record.status ?? "Unknown"),
      connected: record.is_connected === true,
      futureObservations: finiteOrNull(record.future_observations),
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : null,
    }];
  });
}

function parseHorizonsTimestamp(text) {
  const match = text.match(/A\.D\.\s+(\d{4})-([A-Z][a-z]{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match || !MONTHS.has(match[2])) return null;
  const [, year, month, day, hour, minute, seconds] = match;
  const milliseconds = Math.round(Number(seconds) * 1000);
  return Date.UTC(Number(year), MONTHS.get(month), Number(day), Number(hour), Number(minute))
    + milliseconds;
}

export function parseHorizonsVector(result, targetId, center = "Earth") {
  if (typeof result !== "string") throw new TypeError("JPL Horizons response did not contain vector results.");
  const target = HORIZONS_TARGETS.find((item) => item.id === targetId);
  if (!target) throw new RangeError(`Unsupported JPL Horizons target: ${targetId}`);

  const match = result.match(/\$\$SOE\s*([\s\S]*?)\s*\$\$EOE/);
  if (!match) throw new TypeError("JPL Horizons returned no vector ephemeris for this time.");
  const block = match[1];
  const readValue = (label) => {
    const value = block.match(new RegExp(`\\b${label}\\s*=\\s*([-+\\d.Ee]+)`));
    return value ? Number(value[1]) : Number.NaN;
  };
  const positionKm = { x: readValue("X"), y: readValue("Y"), z: readValue("Z") };
  const velocityKmPerSecond = { x: readValue("VX"), y: readValue("VY"), z: readValue("VZ") };
  const distanceKm = readValue("RG");
  if (
    !Object.values(positionKm).every(Number.isFinite)
    || !Object.values(velocityKmPerSecond).every(Number.isFinite)
    || !Number.isFinite(distanceKm)
    || distanceKm < 0
  ) {
    throw new TypeError("JPL Horizons returned an incomplete vector ephemeris.");
  }

  const timestamp = parseHorizonsTimestamp(block);
  const longitudeDegrees = ((Math.atan2(positionKm.y, positionKm.x) * 180 / Math.PI) % 360 + 360) % 360;
  const latitudeDegrees = Math.atan2(
    positionKm.z,
    Math.hypot(positionKm.x, positionKm.y),
  ) * 180 / Math.PI;
  return {
    target,
    timestamp,
    referenceFrame: "Ecliptic J2000",
    center,
    positionKm,
    velocityKmPerSecond,
    distanceKm,
    longitudeDegrees,
    latitudeDegrees,
  };
}
