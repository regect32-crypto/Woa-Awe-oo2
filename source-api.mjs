import {
  parseAircraftPayload,
  parseHorizonsVector,
  parseSatnogsStations,
  MOON_TARGET,
  SOLAR_SYSTEM_BODIES,
} from "./data-sources.mjs";

const AIRCRAFT_CACHE_MS = 60 * 1000;
const STATIONS_CACHE_MS = 30 * 60 * 1000;
const HORIZONS_CACHE_MS = 30 * 60 * 1000;
const MAX_STATION_COUNT = 5000;
const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;
const MAX_ADSB_REQUESTS_PER_24H = 450;
const ADSB_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;
const ADSB_BASE_URL = "https://api.adsb.lol/v2";
const SATNOGS_STATIONS_URL = "https://network.satnogs.org/api/stations/?format=json";
const HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api";
const adsbRequestTimes = [];

class UpstreamError extends Error {
  constructor(message, status = 502, retryAfter = null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function writeJson(response, status, body, retryAfter = null) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (retryAfter) response.setHeader("Retry-After", retryAfter);
  response.end(JSON.stringify(body));
}

async function fetchJson(fetchImpl, url, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UpstreamError(`${new URL(url).hostname} request failed: ${message}`);
  }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : 502;
    throw new UpstreamError(
      `${new URL(url).hostname} returned HTTP ${response.status}.`,
      status,
      response.headers.get("retry-after"),
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UpstreamError(`${new URL(url).hostname} response could not be read: ${message}`);
  }
  if (text.length > MAX_UPSTREAM_BYTES) {
    throw new UpstreamError("Upstream response exceeded the configured size limit.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("Upstream returned invalid JSON.");
  }
}

function parseCoordinate(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function cachedRequest(cache, key, ttl, request) {
  const existing = cache.get(key);
  const now = Date.now();
  if (existing && existing.expiresAt > now) return Promise.resolve(existing.value);
  if (existing?.pending) return existing.pending;

  for (const [entryKey, entry] of cache) {
    if (!entry.pending && entry.expiresAt <= now) cache.delete(entryKey);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestAvailableKey = [...cache].find(([, entry]) => !entry.pending)?.[0];
    if (oldestAvailableKey !== undefined) cache.delete(oldestAvailableKey);
  }
  const pending = request().then((value) => {
    const cacheDuration = typeof ttl === "function" ? ttl(value) : ttl;
    cache.set(key, { value, expiresAt: Date.now() + cacheDuration, pending: null });
    return value;
  }).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { value: null, expiresAt: 0, pending });
  return pending;
}

function enforceAdsbRequestLimit(now = Date.now()) {
  while (adsbRequestTimes.length && adsbRequestTimes[0] <= now - ADSB_WINDOW_MS) {
    adsbRequestTimes.shift();
  }
  if (adsbRequestTimes.length >= MAX_ADSB_REQUESTS_PER_24H) {
    const retryAfter = Math.max(
      1,
      Math.ceil((adsbRequestTimes[0] + ADSB_WINDOW_MS - now) / 1000),
    );
    throw new UpstreamError(
      "The server's ADS-B safety quota is exhausted for the rolling 24-hour window.",
      429,
      String(retryAfter),
    );
  }
  adsbRequestTimes.push(now);
}

async function getAircraft(fetchImpl, cache, url) {
  const latitude = parseCoordinate(url.searchParams.get("lat"), -90, 90, "Latitude");
  const longitude = parseCoordinate(url.searchParams.get("lon"), -180, 180, "Longitude");
  const distance = parseCoordinate(url.searchParams.get("dist"), 1, 250, "Radius");
  const key = `${latitude.toFixed(3)}:${longitude.toFixed(3)}:${distance}`;

  return cachedRequest(cache, `aircraft:${key}`, AIRCRAFT_CACHE_MS, async () => {
    enforceAdsbRequestLimit();
    const upstreamUrl = `${ADSB_BASE_URL}/lat/${latitude}/lon/${longitude}/dist/${distance}`;
    const headers = process.env.ADSB_LOL_API_KEY
      ? { "x-api-key": process.env.ADSB_LOL_API_KEY }
      : {};
    const payload = await fetchJson(fetchImpl, upstreamUrl, headers);
    let aircraft;
    try {
      aircraft = parseAircraftPayload(payload, Number.isFinite(Number(payload?.now)) ? Number(payload.now) : Date.now());
    } catch (error) {
      throw new UpstreamError(`ADSB.lol response was invalid: ${error.message}`);
    }
    const fetchedAt = Number.isFinite(Number(payload?.now)) ? Number(payload.now) : Date.now();
    return {
      fetchedAt,
      aircraft,
      region: { latitude, longitude, radiusNauticalMiles: distance },
      license: "ODbL 1.0",
    };
  });
}

async function getStations(fetchImpl, cache) {
  return cachedRequest(cache, "stations", STATIONS_CACHE_MS, async () => {
    const records = await fetchJson(fetchImpl, SATNOGS_STATIONS_URL);
    let stations;
    try {
      stations = parseSatnogsStations(records);
    } catch (error) {
      throw new UpstreamError(`SatNOGS response was invalid: ${error.message}`);
    }
    const truncated = stations.length > MAX_STATION_COUNT;
    return {
      fetchedAt: Date.now(),
      stations: stations.slice(0, MAX_STATION_COUNT),
      total: stations.length,
      truncated,
    };
  });
}

async function fetchHorizonsBody(fetchImpl, target, requestedAt, centerId = "10", centerName = "Sun") {
  const time = requestedAt.toISOString().slice(0, 16).replace("T", " ");
  const params = new URLSearchParams({
    format: "json",
    COMMAND: `'${target.id}'`,
    OBJ_DATA: "NO",
    MAKE_EPHEM: "YES",
    EPHEM_TYPE: "VECTORS",
    CENTER: `'500@${centerId}'`,
    TLIST: `'${time}'`,
    TLIST_TYPE: "CAL",
    TIME_TYPE: "UT",
    QUANTITIES: "'1'",
  });
  const payload = await fetchJson(fetchImpl, `${HORIZONS_URL}?${params}`);
  if (typeof payload.result !== "string") {
    throw new UpstreamError(payload.error ?? "JPL Horizons returned no result.");
  }
  try {
    return parseHorizonsVector(payload.result, target.id, centerName);
  } catch (error) {
    throw new UpstreamError(`JPL Horizons response for ${target.name} was invalid: ${error.message}`);
  }
}

async function getSolarSystem(fetchImpl, cache) {
  return cachedRequest(cache, "solar-system", (value) => (
    value.errors.length ? 60 * 1000 : HORIZONS_CACHE_MS
  ), async () => {
    const requestedAt = new Date();
    const results = [];
    for (let index = 0; index < SOLAR_SYSTEM_BODIES.length; index += 2) {
      const batch = await Promise.allSettled(
        SOLAR_SYSTEM_BODIES.slice(index, index + 2)
          .map((target) => fetchHorizonsBody(fetchImpl, target, requestedAt)),
      );
      results.push(...batch);
      if (index + 2 < SOLAR_SYSTEM_BODIES.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    let moon = null;
    const errors = [];
    try {
      moon = await fetchHorizonsBody(fetchImpl, MOON_TARGET, requestedAt, "399", "Earth");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`Moon: ${reason}`);
    }

    const bodies = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        bodies.push(result.value);
      } else {
        const target = SOLAR_SYSTEM_BODIES[index];
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`${target.name}: ${reason}`);
      }
    }
    if (bodies.length === 0) {
      throw new UpstreamError(`JPL Horizons returned no body positions. ${errors.join(" ")}`);
    }
    return {
      fetchedAt: Date.now(),
      bodies,
      moon,
      errors,
    };
  });
}

export function createSourceApiHandler(fetchImpl = fetch) {
  const cache = new Map();
  return async (request, response, next = () => {}) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith("/api/sources/")) {
      next();
      return;
    }
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "Only GET requests are supported." });
      return;
    }

    try {
      let payload;
      if (requestUrl.pathname === "/api/sources/aircraft") {
        payload = await getAircraft(fetchImpl, cache, requestUrl);
      } else if (requestUrl.pathname === "/api/sources/stations") {
        payload = await getStations(fetchImpl, cache);
      } else if (requestUrl.pathname === "/api/sources/solar-system") {
        payload = await getSolarSystem(fetchImpl, cache);
      } else {
        writeJson(response, 404, { error: "Unknown data source." });
        return;
      }
      writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof RangeError) {
        writeJson(response, 400, { error: error.message });
        return;
      }
      if (error instanceof UpstreamError) {
        writeJson(response, error.status, { error: error.message }, error.retryAfter);
        return;
      }
      next(error);
    }
  };
}
