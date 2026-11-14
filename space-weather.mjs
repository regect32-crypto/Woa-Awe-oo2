export const SPACE_WEATHER_FEEDS = Object.freeze([
  Object.freeze({
    id: "xray",
    label: "Solar X-ray flux · 0.1–0.8 nm",
    unit: "W/m²",
    color: "#ffb35c",
    url: "https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json",
    energy: "0.1-0.8nm",
    logarithmic: true,
  }),
  Object.freeze({
    id: "protons",
    label: "Proton flux · ≥10 MeV",
    unit: "particles cm⁻² s⁻¹ sr⁻¹",
    color: "#ff8585",
    url: "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json",
    energy: ">=10 MeV",
    logarithmic: true,
  }),
  Object.freeze({
    id: "electrons",
    label: "Electron flux · ≥2 MeV",
    unit: "particles cm⁻² s⁻¹ sr⁻¹",
    color: "#79b8ff",
    url: "https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json",
    energy: ">=2 MeV",
    logarithmic: true,
  }),
  Object.freeze({
    id: "kp",
    label: "Estimated planetary geomagnetic index · Kp",
    unit: "index · 0–9",
    color: "#62d2bf",
    url: "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json",
    logarithmic: false,
  }),
  Object.freeze({
    id: "solarwind",
    label: "ACE solar-wind plasma speed",
    unit: "km/s",
    color: "#d0a6ff",
    url: "https://services.swpc.noaa.gov/json/ace/swepam/ace_swepam_1h.json",
    valueField: "speed",
    logarithmic: false,
  }),
]);

const FEEDS_BY_ID = new Map(SPACE_WEATHER_FEEDS.map((feed) => [feed.id, feed]));

function parseUtcTimestamp(value) {
  if (typeof value !== "string") return Number.NaN;
  const utcValue = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  return Date.parse(utcValue);
}

export function parseSpaceWeatherSeries(records, feedId) {
  const feed = FEEDS_BY_ID.get(feedId);
  if (!feed) throw new RangeError(`Unknown space-weather feed: ${feedId}`);
  if (!Array.isArray(records)) throw new TypeError("Space-weather response must be a JSON array.");

  const series = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || (feed.energy && record.energy !== feed.energy)) continue;
    if (feedId === "xray" && record.electron_contaminaton === true) continue;

    if (feedId === "solarwind" && Number(record.dsflag) !== 0) continue;

    const valueField = feed.valueField ?? (feedId === "kp" ? "estimated_kp" : "flux");
    const rawValue = record[valueField];
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;
    const value = Number(rawValue);
    const timestamp = parseUtcTimestamp(record.time_tag);
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(timestamp)) continue;
    if (feedId === "kp" && value > 9) continue;
    const point = { value, timestamp };
    if (record.satellite !== null && record.satellite !== undefined
      && Number.isInteger(Number(record.satellite))) {
      point.satellite = Number(record.satellite);
    }
    if (feedId === "solarwind") {
      point.density = Number(record.dens);
      point.temperature = Number(record.temperature);
      if (
        !Number.isFinite(point.density)
        || point.density < 0
        || !Number.isFinite(point.temperature)
        || point.temperature < 0
      ) continue;
    }
    series.push(point);
  }

  return series.sort((left, right) => left.timestamp - right.timestamp);
}
