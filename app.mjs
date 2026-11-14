import {
  EARTH_RADIUS_KM_VALUE,
  ORBIT_REGIMES,
  earthRotationAngleAt,
  orbitPeriodSeconds,
  parseCatalog,
  positionAt,
} from "./orbit.mjs";
import {
  magnetopauseStandoffEarthRadii,
  solarWindDynamicPressureNPa,
  solarWindEarthRadiiPerSecond,
} from "./environment.mjs";
import { subsolarPoint } from "./solar.mjs";
import { parseSpaceWeatherSeries, SPACE_WEATHER_FEEDS } from "./space-weather.mjs";
import {
  parseAircraftPayload,
  SOLAR_SYSTEM_BODIES,
} from "./data-sources.mjs";
import { createPositionCsv } from "./export-data.mjs";
import {
  ASTRONOMICAL_UNIT_KM,
  EARTH_OBLIQUITY_DEGREES,
  SOLAR_VIEW_BODIES,
  projectSolarPoint,
  solarCameraPosition,
  solarSystemDistances,
  solarSystemPositions,
  solarSystemVectorsAt,
} from "./solar-view.mjs";
import {
  advanceSimulationTime,
  MAX_SIMULATION_OFFSET_MINUTES,
  simulationTimeAtOffset,
  SIMULATION_WINDOW_MS,
} from "./time-model.mjs";

const CATALOG_URL = "https://celestrak.org/NORAD/elements/gp.php";
const GIBS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const GIBS_TRUE_COLOR_LAYER = "MODIS_Terra_CorrectedReflectance_TrueColor";
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const SPACE_WEATHER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const AIRCRAFT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const STATIONS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const HORIZONS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_PREFIX = "orbital-atlas-catalog-v1:";
const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1024;
const MIN_EARTH_BUFFER_SIZE = 512;
const MAX_EARTH_BUFFER_SIZE = 4096;
const EARTH_BUFFER_PADDING = 24;
const MIN_ZOOM = 0.01;
const DEFAULT_SOLAR_YAW = 0.24;
const DEFAULT_SOLAR_PITCH = 0.48;
const STARFIELD = Object.freeze(Array.from({ length: 220 }, (_unused, index) => {
  const unit = (seed) => {
    const value = Math.sin(index * seed + 8) * 43758.5453;
    return value - Math.floor(value);
  };
  return Object.freeze({
    x: unit(127.1),
    y: unit(311.7),
    size: index % 17 === 0 ? 1.5 : 1,
    brightness: 0.08 + unit(91.7) * 0.13,
    phase: unit(27.3) * Math.PI * 2,
  });
}));
const VIEW_ROTATION_EPOCH = Date.now();
const VIEW_ROTATION_EPOCH_ANGLE = earthRotationAngleAt(VIEW_ROTATION_EPOCH);
const REDUCED_MOTION_PREFERENCE = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const canvas = document.querySelector("#solarSystemCanvas");
const context = canvas.getContext("2d");
const stage = document.querySelector("#globeStage");
const catalogSelect = document.querySelector("#catalog");
const loadButton = document.querySelector("#loadCatalog");
const statusElement = document.querySelector("#sourceStatus");
const searchInput = document.querySelector("#search");
const listElement = document.querySelector("#objectList");
const detailsElement = document.querySelector("#details");
const objectCountElement = document.querySelector("#objectCount");
const visibleCountElement = document.querySelector("#visibleCount");
const clockElement = document.querySelector("#clock");
const mapStatusElement = document.querySelector("#mapStatus");
const fullscreenButton = document.querySelector("#fullscreenToggle");
const visualFxButton = document.querySelector("#visualFxToggle");
const downloadJsonButton = document.querySelector("#downloadJson");
const downloadCsvButton = document.querySelector("#downloadCsv");
const saveScenePngButton = document.querySelector("#saveScenePng");
const exportStatusElement = document.querySelector("#exportStatus");
const frameSolarSystemButton = document.querySelector("#frameSolarSystem");
const frameEarthMoonButton = document.querySelector("#frameEarthMoon");
const zoomInButton = document.querySelector("#zoomIn");
const zoomOutButton = document.querySelector("#zoomOut");
const resetZoomButton = document.querySelector("#resetZoom");
const regimeSelect = document.querySelector("#regimeFilter");
const regimeLegendElement = document.querySelector("#regimeLegend");
const regimesById = new Map(ORBIT_REGIMES.map((regime) => [regime.id, regime]));
const weatherStatusElement = document.querySelector("#weatherStatus");
const weatherCards = new Map(SPACE_WEATHER_FEEDS.map((feed) => [feed.id, {
  value: document.querySelector(`#weather-${feed.id}-value`),
  unit: document.querySelector(`#weather-${feed.id}-unit`),
  time: document.querySelector(`#weather-${feed.id}-time`),
}]));
const aircraftToggle = document.querySelector("#showAircraft");
const stationsToggle = document.querySelector("#showStations");
const aircraftLatitudeInput = document.querySelector("#aircraftLatitude");
const aircraftLongitudeInput = document.querySelector("#aircraftLongitude");
const aircraftRadiusInput = document.querySelector("#aircraftRadius");
const loadAircraftButton = document.querySelector("#loadAircraft");
const aircraftStatusElement = document.querySelector("#aircraftStatus");
const stationsStatusElement = document.querySelector("#stationsStatus");
const loadHorizonsButton = document.querySelector("#loadHorizons");
const horizonsStatusElement = document.querySelector("#horizonsStatus");
const solarSystemBodiesElement = document.querySelector("#solarSystemBodies");
const simulationTimeElement = document.querySelector("#simulationTime");
const simulationModeElement = document.querySelector("#simulationMode");
const simulationRangeInput = document.querySelector("#timeRange");
const simulationPlayButton = document.querySelector("#playSimulation");
const simulationRateInput = document.querySelector("#simulationRate");
const returnLiveButton = document.querySelector("#returnLive");
const loadMoreObjectsButton = document.querySelector("#loadMoreObjects");
const coverageStates = new Map([
  ["orbit", document.querySelector("#coverage-orbit-state")],
  ["environment", document.querySelector("#coverage-environment-state")],
  ["aviation", document.querySelector("#coverage-aviation-state")],
  ["receiver", document.querySelector("#coverage-receiver-state")],
  ["solar", document.querySelector("#coverage-solar-state")],
  ["telemetry", document.querySelector("#coverage-telemetry-state")],
]);
const textureCanvas = document.createElement("canvas");
textureCanvas.width = TEXTURE_WIDTH;
textureCanvas.height = TEXTURE_HEIGHT;
const textureContext = textureCanvas.getContext("2d", { willReadFrequently: true });
const earthCanvas = document.createElement("canvas");
earthCanvas.width = MIN_EARTH_BUFFER_SIZE;
earthCanvas.height = MIN_EARTH_BUFFER_SIZE;
const earthContext = earthCanvas.getContext("2d");

let objects = [];
let selectedId = null;
let landTexture = null;
let cloudTexture = null;
let cloudImageDate = null;
let renderedTextureLongitude = Number.NaN;
let renderedSunLatitude = Number.NaN;
let renderedSunLongitude = Number.NaN;
let earthBufferSize = MIN_EARTH_BUFFER_SIZE;
let earthBufferRadius = (MIN_EARTH_BUFFER_SIZE - EARTH_BUFFER_PADDING) / 2;
let earthImage = earthContext.createImageData(earthBufferSize, earthBufferSize);
let viewLongitude = 0;
let zoom = 1;
let dragStart = null;
let cachedPositions = new Map();
let lastPositionsRefreshWallTime = 0;
let lastDrawAt = 0;
let lastSimulationFrameTime = null;
let width = 0;
let height = 0;
let pixelRatio = 1;
let cacheAvailable = true;
let catalogLoadInProgress = false;
let weatherRefreshInProgress = false;
let aircraftRefreshInProgress = false;
let stationsRefreshInProgress = false;
let horizonsRefreshInProgress = false;
let imageryRefreshInProgress = false;
let weatherSeriesById = new Map();
let aircraftPositions = [];
let groundStations = [];
let lastSolarSystemFetch = null;
let catalogFetchedAt = null;
let solarSystemPayload = null;
let solarCamera = { x: 0, y: 0, z: 0 };
let solarZoom = 1;
let solarCameraYaw = DEFAULT_SOLAR_YAW;
let solarCameraPitch = DEFAULT_SOLAR_PITCH;
let activePointers = new Map();
let pinchStart = null;
let listRenderLimit = 120;
let simulationTimeMs = Date.now();
let simulationPinned = false;
let simulationPlaying = false;
let visualEffectsEnabled = !REDUCED_MOTION_PREFERENCE;
let autoRotateEnabled = false;
let aircraftRetryAfterMs = 0;

function setStatus(message) {
  statusElement.textContent = message;
}

function earthRotationOffsetDegrees(timeMs) {
  const radians = earthRotationAngleAt(timeMs) - VIEW_ROTATION_EPOCH_ANGLE;
  return ((radians * 180 / Math.PI) % 360 + 360) % 360;
}

function normalizeLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function viewLongitudeAt(timeMs) {
  return normalizeLongitude(viewLongitude - earthRotationOffsetDegrees(timeMs));
}

function centerViewOnLongitude(longitude, timeMs = Date.now()) {
  viewLongitude = longitude + earthRotationOffsetDegrees(timeMs);
}

function setCoverageState(sourceId, label, stateClass) {
  const element = coverageStates.get(sourceId);
  if (!element) return;
  element.textContent = label;
  element.className = `coverage-state ${stateClass}`;
}

async function fetchSourceJson(path, timeoutMs = 25000) {
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Data service returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(payload.error ?? `Data service returned HTTP ${response.status}.`);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const retryAt = Number.isFinite(seconds)
        ? Date.now() + seconds * 1000
        : Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) error.retryAfterMs = retryAt;
    }
    throw error;
  }
  return payload;
}

function sourceTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return "source time unavailable";
  return `${new Date(timestamp).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function setSourceStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("source-error", isError);
}

function updateVisualFxControl() {
  visualFxButton.textContent = `Effects: ${visualEffectsEnabled ? "On" : "Off"}`;
  visualFxButton.setAttribute("aria-pressed", String(visualEffectsEnabled));
  visualFxButton.title = visualEffectsEnabled
    ? "Decorative glow and star twinkle are on"
    : "Decorative glow and star twinkle are off";
}

function exportFilename(label, extension) {
  const timestamp = new Date(simulationTimeMs).toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `orbital-atlas-${label}-${timestamp}.${extension}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentSatelliteStates() {
  return objects.map((object) => ({
    object,
    position: positionAt(object, simulationTimeMs),
  }));
}

function downloadDataSnapshot() {
  const satellites = currentSatelliteStates().map(({ object, position }) => ({
    id: object.id,
    name: object.name,
    internationalDesignator: object.objectId,
    orbitRegime: regimesById.get(object.regimeId).shortLabel,
    publishedElementEpoch: object.publishedEpoch,
    positionModel: "SGP4 / SDP4 from published OMM elements; estimate, not telemetry",
    position,
  }));
  const solarStates = solarSystemPayload
    ? [...solarSystemVectorsAt(solarSystemPayload, simulationTimeMs)].map(([id, state]) => ({
      id,
      positionKm: state.positionKm,
      velocityKmPerSecond: state.velocityKmPerSecond,
      timestamp: new Date(state.timestamp).toISOString(),
    }))
    : [];
  const snapshot = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    modelTime: new Date(simulationTimeMs).toISOString(),
    limitations: [
      "Satellite positions are model estimates, not onboard telemetry.",
      "NOAA, aircraft, and station observations retain their source timestamps and are not replayed.",
      "Solar System vectors cover the currently loaded JPL Horizons sample range and target set only.",
    ],
    orbitalCatalog: {
      source: "CelesTrak OMM",
      selectedGroup: catalogSelect.value,
      fetchedAt: catalogFetchedAt ? new Date(catalogFetchedAt).toISOString() : null,
      objects: satellites,
    },
    spaceWeather: {
      source: "NOAA SWPC / ACE",
      feeds: Object.fromEntries(weatherSeriesById),
    },
    aircraft: {
      source: "ADSB.lol public regional state vectors",
      records: aircraftPositions,
    },
    groundStations: {
      source: "SatNOGS public station directory",
      records: groundStations,
    },
    solarSystem: solarSystemPayload
      ? {
        source: "JPL Horizons",
        modelTimeStates: solarStates,
        sampledData: solarSystemPayload,
      }
      : null,
  };
  const content = JSON.stringify(snapshot, null, 2);
  downloadBlob(
    new Blob([content], { type: "application/json;charset=utf-8" }),
    exportFilename("snapshot", "json"),
  );
  setSourceStatus(
    exportStatusElement,
    `JSON snapshot downloaded · ${satellites.length.toLocaleString()} catalog objects · model time ${new Date(simulationTimeMs).toISOString()}.`,
  );
}

function downloadPositionCsv() {
  const satelliteStates = currentSatelliteStates();
  const csv = createPositionCsv({
    satelliteStates,
    solarSystemPayload,
    timeMs: simulationTimeMs,
  });
  downloadBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    exportFilename("positions", "csv"),
  );
  setSourceStatus(
    exportStatusElement,
    `Position CSV downloaded · ${csv.split("\r\n").length - 1} rows · model time ${new Date(simulationTimeMs).toISOString()}.`,
  );
}

async function saveScenePng() {
  try {
    const blob = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("The browser could not encode the canvas."));
        }, "image/png");
      } catch (error) {
        reject(error);
      }
    });
    downloadBlob(blob, exportFilename("scene", "png"));
    setSourceStatus(
      exportStatusElement,
      `Scene image downloaded · model time ${new Date(simulationTimeMs).toISOString()}.`,
    );
  } catch (error) {
    setSourceStatus(exportStatusElement, `Scene export failed: ${error.message}`, true);
  }
}

async function loadAircraft() {
  if (aircraftRefreshInProgress) return;
  if (aircraftRetryAfterMs > Date.now()) {
    setSourceStatus(
      aircraftStatusElement,
      `ADSB.lol rate limit; retry after ${sourceTimestamp(aircraftRetryAfterMs)}.`,
      true,
    );
    return;
  }
  const latitude = Number(aircraftLatitudeInput.value);
  const longitude = Number(aircraftLongitudeInput.value);
  const radius = Number(aircraftRadiusInput.value);
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !Number.isFinite(radius) || radius < 1 || radius > 250
  ) {
    setSourceStatus(aircraftStatusElement, "Enter latitude −90…90, longitude −180…180, and radius 1…250 nautical miles.", true);
    return;
  }

  aircraftRefreshInProgress = true;
  loadAircraftButton.disabled = true;
  setSourceStatus(aircraftStatusElement, "Requesting regional ADS-B positions…");
  try {
    const query = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude),
      dist: String(radius),
    });
    const payload = await fetchSourceJson(`/api/sources/aircraft?${query}`);
    if (!Array.isArray(payload.aircraft) || !Number.isFinite(payload.fetchedAt)) {
      throw new TypeError("The data service returned an invalid aircraft payload.");
    }
    const parsed = parseAircraftPayload({
      ac: (payload.aircraft ?? []).map((aircraft) => ({
        hex: aircraft.id,
        flight: aircraft.name,
        lat: aircraft.latitude,
        lon: aircraft.longitude,
        alt_geom: aircraft.altitudeKm / 0.0003048,
        track: aircraft.trackDegrees,
        gs: aircraft.groundSpeedKnots,
        seen_pos: (payload.fetchedAt - aircraft.positionTimestamp) / 1000,
      })),
    }, payload.fetchedAt);
    aircraftPositions = parsed;
    setSourceStatus(
      aircraftStatusElement,
      `ADSB.lol · ${parsed.length.toLocaleString()} recent aircraft · ${sourceTimestamp(payload.fetchedAt)}.`,
    );
    setCoverageState("aviation", "LIVE REGIONAL DATA", "connected");
  } catch (error) {
    if (Number.isFinite(error.retryAfterMs)) aircraftRetryAfterMs = error.retryAfterMs;
    setSourceStatus(
      aircraftStatusElement,
      aircraftPositions.length
        ? `Refresh failed; retaining ${aircraftPositions.length.toLocaleString()} prior positions: ${error.message}${aircraftRetryAfterMs > Date.now() ? ` · retry after ${sourceTimestamp(aircraftRetryAfterMs)}` : ""}`
        : `Aircraft unavailable: ${error.message}`,
      true,
    );
    setCoverageState(
      "aviation",
      aircraftPositions.length ? "STALE REGIONAL DATA" : "UNAVAILABLE",
      "pending",
    );
  } finally {
    aircraftRefreshInProgress = false;
    loadAircraftButton.disabled = false;
  }
}

async function loadGroundStations() {
  if (stationsRefreshInProgress) return;
  stationsRefreshInProgress = true;
  setSourceStatus(stationsStatusElement, "Refreshing public SatNOGS station locations…");
  try {
    const payload = await fetchSourceJson("/api/sources/stations");
    if (!Array.isArray(payload.stations) || !payload.stations.every((station) => (
      Number.isFinite(station.latitude)
      && Number.isFinite(station.longitude)
      && Number.isFinite(station.altitudeKm)
      && typeof station.connected === "boolean"
    ))) {
      throw new TypeError("The data service returned an invalid station payload.");
    }
    const stations = payload.stations;
    groundStations = stations;
    const connected = stations.filter((station) => station.connected).length;
    const futureObservations = stations.reduce(
      (total, station) => total + (station.futureObservations ?? 0),
      0,
    );
    const truncated = payload.truncated ? " · display capped at 5,000 stations" : "";
    setSourceStatus(
      stationsStatusElement,
      `SatNOGS · ${stations.length.toLocaleString()} published station locations · ${connected.toLocaleString()} marked connected · ${futureObservations.toLocaleString()} future-observation count${truncated} · refreshed ${sourceTimestamp(payload.fetchedAt)}.`,
    );
    setCoverageState("receiver", "STATION DIRECTORY", "limited");
  } catch (error) {
    setSourceStatus(
      stationsStatusElement,
      groundStations.length
        ? `Refresh failed; retaining ${groundStations.length.toLocaleString()} prior stations: ${error.message}`
        : `Station directory unavailable: ${error.message}`,
      true,
    );
    setCoverageState("receiver", "UNAVAILABLE", "pending");
  } finally {
    stationsRefreshInProgress = false;
  }
}

function updateSolarSystemCards(timeMs = simulationTimeMs) {
  if (!solarSystemPayload) return;
  const states = solarSystemDistances(solarSystemPayload, timeMs);
  const cards = solarSystemPayload.bodies.map((body) => {
    const state = states.get(body.target.id);
    return `<article class="solar-body-card">
      <strong>${escapeHtml(body.target.name)}</strong>
      <span>${state
        ? `${(state.distanceKm / ASTRONOMICAL_UNIT_KM).toFixed(3)} AU from Sun`
        : "Outside fetched JPL time range"}</span>
      <span>${state ? `${state.speedKmPerSecond.toFixed(2)} km/s at model time` : "No extrapolated position"}</span>
    </article>`;
  });
  const moonState = states.get("301");
  if (solarSystemPayload.moon && moonState) {
    cards.splice(3, 0, `<article class="solar-body-card">
      <strong>Moon</strong>
      <span>${(moonState.distanceKm / 1000).toFixed(1)} thousand km from Earth</span>
      <span>${moonState.speedKmPerSecond.toFixed(2)} km/s relative to Earth</span>
    </article>`);
  } else if (solarSystemPayload.moon) {
    cards.splice(3, 0, `<article class="solar-body-card">
      <strong>Moon</strong>
      <span>Outside fetched JPL time range</span>
      <span>No extrapolated position</span>
    </article>`);
  }
  solarSystemBodiesElement.innerHTML = cards.join("");
}

function isValidHorizonsSeries(series, expectedCenter) {
  return Boolean(
    series?.target?.id
    && series.center === expectedCenter
    && series.referenceFrame === "Ecliptic J2000"
    && Array.isArray(series.vectors)
    && series.vectors.length >= 2
    && series.vectors.every((vector, index) => (
      Number.isFinite(vector.timestamp)
      && (index === 0 || vector.timestamp > series.vectors[index - 1].timestamp)
      && ["x", "y", "z"].every((axis) => (
        Number.isFinite(vector.positionKm?.[axis])
        && Number.isFinite(vector.velocityKmPerSecond?.[axis])
      ))
    )),
  );
}

function renderSolarSystem(payload) {
  solarSystemPayload = payload;
  updateSolarSystemCards();
  mapStatusElement.textContent = payload.moon
    ? `JPL vectors for ${payload.bodies.length} planets and dwarf planets sampled every ${payload.range.stepMinutes} minutes · Earth-centered Moon vector included.`
    : `JPL vectors for ${payload.bodies.length} planets and dwarf planets sampled every ${payload.range.stepMinutes} minutes · Moon data unavailable.`;
}

async function loadHorizons() {
  if (horizonsRefreshInProgress) return;
  horizonsRefreshInProgress = true;
  loadHorizonsButton.disabled = true;
  setSourceStatus(horizonsStatusElement, "Requesting sampled JPL Horizons vectors…");
  try {
    const payload = await fetchSourceJson("/api/sources/solar-system", 150000);
    if (
      !Array.isArray(payload.bodies)
      || payload.bodies.length === 0
      || !payload.bodies.every((body) => isValidHorizonsSeries(body, "Sun"))
      || (payload.moon !== null && payload.moon !== undefined
        && !isValidHorizonsSeries(payload.moon, "Earth"))
      || !Number.isFinite(payload.range?.startTime)
      || !Number.isFinite(payload.range?.stopTime)
      || payload.range.stopTime <= payload.range.startTime
      || !Number.isFinite(payload.range?.stepMinutes)
      || !Number.isFinite(payload.fetchedAt)
    ) {
      throw new TypeError("The data service returned invalid sampled Solar System vectors.");
    }
    if (!Array.isArray(payload.errors)) {
      throw new TypeError("The data service returned invalid Solar System source status.");
    }
    renderSolarSystem(payload);
    const complete = payload.bodies.length === SOLAR_SYSTEM_BODIES.length
      && SOLAR_SYSTEM_BODIES.every((target) => (
        payload.bodies.some((body) => body.target.id === target.id)
      ))
      && payload.moon
      && payload.errors.length === 0;
    lastSolarSystemFetch = payload.fetchedAt;
    const startTime = sourceTimestamp(payload.range.startTime);
    const stopTime = sourceTimestamp(payload.range.stopTime);
    const planetCount = payload.bodies.filter((body) => (
      SOLAR_SYSTEM_BODIES.slice(0, 8).some((target) => target.id === body.target.id)
    )).length;
    const dwarfPlanetCount = payload.bodies.length - planetCount;
    setSourceStatus(
      horizonsStatusElement,
      `JPL Horizons · ${planetCount}/8 planets + ${dwarfPlanetCount}/5 dwarf planets${payload.moon ? " + Moon" : ""} · ${payload.range.stepMinutes}-minute vectors · ${complete ? "complete" : `partial · ${payload.errors.join(" · ")}`} · sampled ${startTime}–${stopTime}.`,
    );
    setCoverageState("solar", complete ? "COMPUTED EPHEMERIS" : "PARTIAL EPHEMERIS", "limited");
  } catch (error) {
    const retainedData = Number.isFinite(lastSolarSystemFetch)
      ? `Refresh failed; retaining samples fetched ${sourceTimestamp(lastSolarSystemFetch)}: `
      : "JPL Horizons unavailable: ";
    setSourceStatus(horizonsStatusElement, `${retainedData}${error.message}`, true);
    setCoverageState("solar", lastSolarSystemFetch ? "STALE EPHEMERIS" : "UNAVAILABLE", "pending");
  } finally {
    horizonsRefreshInProgress = false;
    loadHorizonsButton.disabled = false;
  }
}

function cacheKey(catalog) {
  return `${CACHE_PREFIX}${catalog}`;
}

function readCache(catalog) {
  if (!cacheAvailable) return null;
  try {
    const serialized = localStorage.getItem(cacheKey(catalog));
    if (!serialized) return null;
    const cached = JSON.parse(serialized);
    if (!Array.isArray(cached.records) || !Number.isFinite(cached.fetchedAt)) {
      throw new TypeError("The saved catalog cache has an invalid format.");
    }
    return cached;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      setStatus(`Saved catalog cache is invalid: ${error.message}`);
    } else {
      cacheAvailable = false;
      setStatus("Browser storage is unavailable; the live catalog can still be loaded.");
    }
    return null;
  }
}

function writeCache(catalog, records, fetchedAt) {
  if (!cacheAvailable) return;
  try {
    localStorage.setItem(cacheKey(catalog), JSON.stringify({ records, fetchedAt }));
  } catch {
    cacheAvailable = false;
    setStatus("Catalog loaded, but browser storage is unavailable; refresh protection cannot persist.");
  }
}

async function fetchCatalogRecords(catalog) {
  const url = new URL(CATALOG_URL);
  url.searchParams.set("GROUP", catalog);
  url.searchParams.set("FORMAT", "JSON");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      continue;
    }
    if (!response.ok) {
      const error = new Error(`CelesTrak returned HTTP ${response.status}.`);
      error.status = response.status;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const retryAt = Number.isFinite(seconds)
          ? Date.now() + seconds * 1000
          : Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) error.retryAfterMs = retryAt;
      }
      const transient = response.status === 429 || response.status >= 500;
      const delay = error.retryAfterMs
        ? error.retryAfterMs - Date.now()
        : 250 * (2 ** attempt);
      if (!transient || attempt === 2 || delay > 4000) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
      continue;
    }
    return response.json();
  }
  throw new Error("CelesTrak request failed after three attempts.");
}

function installCatalog(records, fetchedAt, catalog, fromCache) {
  const parsed = parseCatalog(records);
  if (parsed.length === 0) {
    throw new Error("The catalog contained no valid orbital elements.");
  }
  catalogFetchedAt = fetchedAt;
  objects = parsed;
  listRenderLimit = 120;
  selectedId = null;
  cachedPositions.clear();
  lastPositionsRefreshWallTime = 0;
  refreshPositions(simulationTimeMs, true);
  renderList();
  renderRegimeLegend();
  renderDetails();
  objectCountElement.textContent = objects.length.toLocaleString();
  const source = catalog === "active"
    ? "CelesTrak active Earth-orbit catalog"
    : "CelesTrak space stations";
  const ageMinutes = Math.max(0, Math.floor((Date.now() - fetchedAt) / 60000));
  setStatus(`${source} · ${fromCache ? `cached ${ageMinutes} min ago` : "just fetched"} · element epoch varies by object`);
  setCoverageState("orbit", fromCache ? "CACHED MODEL" : "LIVE MODEL", "connected");
}

async function loadCatalog() {
  if (catalogLoadInProgress) return;
  const catalog = catalogSelect.value;
  const cached = readCache(catalog);
  let usingCachedCatalog = false;
  if (cached) {
    try {
      installCatalog(cached.records, cached.fetchedAt, catalog, true);
      usingCachedCatalog = true;
    } catch (error) {
      setStatus(`Could not use saved catalog: ${error.message}`);
    }
    if (usingCachedCatalog && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) return;
  }

  catalogLoadInProgress = true;
  loadButton.disabled = true;
  loadButton.textContent = "Loading public catalog…";
  setCoverageState("orbit", "CONNECTING", "pending");
  setStatus("Requesting orbital elements from CelesTrak…");
  try {
    const records = await fetchCatalogRecords(catalog);
    const fetchedAt = Date.now();
    installCatalog(records, fetchedAt, catalog, false);
    writeCache(catalog, records, fetchedAt);
  } catch (error) {
    if (usingCachedCatalog) {
      const ageMinutes = Math.max(0, Math.floor((Date.now() - cached.fetchedAt) / 60000));
      setStatus(`Refresh failed; showing ${catalog} catalog cached ${ageMinutes} min ago: ${error.message}`);
      setCoverageState("orbit", "CACHED MODEL", "connected");
    } else if (catalog === "active" && error.status === 403) {
      setStatus("CelesTrak denied the active catalog (HTTP 403); trying its smaller stations set instead…");
      try {
        const records = await fetchCatalogRecords("stations");
        const fetchedAt = Date.now();
        installCatalog(records, fetchedAt, "stations", false);
        catalogSelect.value = "stations";
        setStatus("Active catalog denied (HTTP 403); showing the smaller CelesTrak stations set. Select the active catalog to try it again.");
        writeCache("stations", records, fetchedAt);
      } catch (fallbackError) {
        setStatus(`Active catalog denied (HTTP 403); stations fallback unavailable: ${fallbackError.message}`);
        setCoverageState("orbit", "UNAVAILABLE", "pending");
      }
    } else {
      setStatus(`Catalog unavailable: ${error.message}`);
      setCoverageState("orbit", "UNAVAILABLE", "pending");
    }
  } finally {
    catalogLoadInProgress = false;
    loadButton.disabled = false;
    loadButton.innerHTML = 'Load public catalog <span aria-hidden="true">↗</span>';
  }
}

function visibleObjects() {
  const query = searchInput.value.trim().toLowerCase();
  const regimeId = regimeSelect.value;
  return objects.filter((object) => {
    if (regimeId !== "all" && object.regimeId !== regimeId) return false;
    return !query || object.name.toLowerCase().includes(query) || object.id.toLowerCase().includes(query);
  });
}

function renderRegimeLegend() {
  const counts = new Map(ORBIT_REGIMES.map((regime) => [regime.id, 0]));
  for (const object of objects) counts.set(object.regimeId, counts.get(object.regimeId) + 1);
  regimeLegendElement.innerHTML = ORBIT_REGIMES.map((regime) => `
    <span class="regime-key" title="${regime.label}">
      <span class="regime-swatch" style="background:${regime.color}"></span>
      ${regime.shortLabel}<strong>${counts.get(regime.id).toLocaleString()}</strong>
    </span>
  `).join("");
}

function renderList() {
  const filtered = visibleObjects();
  visibleCountElement.textContent = filtered.length.toLocaleString();
  loadMoreObjectsButton.hidden = true;
  if (filtered.length === 0) {
    listElement.innerHTML = '<p class="empty-state">No matching catalog objects.</p>';
    return;
  }
  const rows = filtered.slice(0, listRenderLimit).map((object) => `
    <button class="object-row${object.id === selectedId ? " selected" : ""}" data-id="${escapeHtml(object.id)}">
      <span class="object-name">${escapeHtml(object.name)}</span>
      <span class="object-id">${escapeHtml(object.id)}</span>
    </button>
  `);
  if (filtered.length > listRenderLimit) {
    loadMoreObjectsButton.hidden = false;
    loadMoreObjectsButton.textContent = `Load next ${Math.min(120, filtered.length - listRenderLimit).toLocaleString()} · ${listRenderLimit.toLocaleString()} of ${filtered.length.toLocaleString()}`;
  }
  listElement.innerHTML = rows.join("");
}

function renderDetails() {
  const object = objects.find((item) => item.id === selectedId);
  if (!object) {
    detailsElement.innerHTML = '<p class="empty-state">Select a point or list entry to inspect its published orbital elements.</p>';
    return;
  }
  const position = positionAt(object, simulationTimeMs);
  if (!position) {
    detailsElement.innerHTML = `<p class="details-name">${escapeHtml(object.name)}</p><p class="empty-state">SGP4 propagation failed for this element set (error ${object.satrec.error}).</p>`;
    return;
  }
  const details = [
    ["Catalog ID", object.id],
    ["Launch ID", object.objectId],
    ["Orbit regime", regimesById.get(object.regimeId).shortLabel],
    ["Altitude (SGP4)", `${Math.round(position.altitudeKm).toLocaleString()} km`],
    ["Speed (SGP4)", `${position.speedKmPerSecond.toFixed(3)} km/s`],
    ["Ground position", `${position.latitude.toFixed(2)}°, ${position.longitude.toFixed(2)}°`],
    ["Mean perigee", `${Math.round(object.perigeeKm).toLocaleString()} km`],
    ["Mean apogee", `${Math.round(object.apogeeKm).toLocaleString()} km`],
    ["Inclination", `${(object.inclination * 180 / Math.PI).toFixed(2)}°`],
    ["Period*", `${(orbitPeriodSeconds(object) / 60).toFixed(1)} min`],
    ["Element epoch", object.publishedEpoch.replace("T", " ") + " UTC"],
  ];
  detailsElement.innerHTML = `
    <p class="details-name">${escapeHtml(object.name)}</p>
    <div class="detail-grid">${details.map(([label, value]) => `
      <div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
    `).join("")}</div>
  `;
}

function selectObject(object) {
  selectedId = object.id;
  frameOrbits();
  renderList();
  renderDetails();
}

function changeZoom(factor) {
  zoomSolarAt(factor);
}

function solarBaseScale() {
  return Math.max(1, Math.min(width, height) * 0.44 / 30.5);
}

function solarSystemExtentAu() {
  let extentAu = 30.5;
  for (const position of solarPositionsAt().values()) {
    extentAu = Math.max(extentAu, Math.hypot(position.x, position.y, position.z));
  }
  return extentAu;
}

function solarPixelsPerAu() {
  return solarBaseScale() * solarZoom;
}

function solarProjection() {
  return {
    yaw: solarCameraYaw,
    pitch: solarCameraPitch,
    distanceAu: 60 / solarZoom,
    focalLengthPx: solarBaseScale() * 60,
  };
}

function cameraPlaneOffset(cameraX, cameraY) {
  const cosYaw = Math.cos(solarCameraYaw);
  const sinYaw = Math.sin(solarCameraYaw);
  const cosPitch = Math.cos(solarCameraPitch);
  const sinPitch = Math.sin(solarCameraPitch);
  return {
    x: cosYaw * cameraX + sinYaw * cosPitch * cameraY,
    y: -sinYaw * cameraX + cosYaw * cosPitch * cameraY,
    z: sinPitch * cameraY,
  };
}

function solarPositionsAt(timeMs = simulationTimeMs) {
  return solarSystemPayload ? solarSystemPositions(solarSystemPayload, timeMs) : new Map();
}

function frameSolarSystem() {
  solarCamera = { x: 0, y: 0, z: 0 };
  solarCameraYaw = DEFAULT_SOLAR_YAW;
  solarCameraPitch = DEFAULT_SOLAR_PITCH;
  const extentAu = solarSystemExtentAu() * 1.15;
  solarZoom = width && height
    ? Math.max(0.15, Math.min(1, Math.min(width, height) * 0.28 / (solarBaseScale() * extentAu)))
    : 1;
}

function frameEarthMoon() {
  const earth = solarPositionsAt().get("399");
  if (!earth || !width || !height) return;
  solarCamera = { ...earth };
  const extentAu = 0.0035;
  solarZoom = Math.min(
    1000000,
    Math.max(0.15, Math.min(width, height) * 0.38 / (solarBaseScale() * extentAu)),
  );
}

function frameOrbits() {
  const regimeId = regimeSelect.value;
  if (objects.length === 0 || !width || !height) return;
  const earth = solarPositionsAt().get("399");
  if (!earth) return;
  let maximumRadiusKm = EARTH_RADIUS_KM_VALUE;
  let matchingObjects = 0;
  for (const object of objects) {
    if (regimeId !== "all" && object.regimeId !== regimeId) continue;
    matchingObjects += 1;
    maximumRadiusKm = Math.max(maximumRadiusKm, object.apogeeKm + EARTH_RADIUS_KM_VALUE);
  }
  if (matchingObjects === 0) return;
  solarCamera = { ...earth };
  const extentAu = maximumRadiusKm / ASTRONOMICAL_UNIT_KM * 1.25;
  solarZoom = Math.min(
    1000000,
    Math.max(0.15, Math.min(width, height) * 0.38 / (solarBaseScale() * extentAu)),
  );
}

function frameEarthFleet() {
  regimeSelect.value = "all";
  selectedId = null;
  renderList();
  renderDetails();
  frameOrbits();
}

function zoomSolarAt(factor, anchorX = width / 2, anchorY = height / 2) {
  if (!width || !height) return;
  const previousScale = solarPixelsPerAu();
  const screenX = (anchorX - width / 2) / previousScale;
  const screenY = -(anchorY - height / 2) / previousScale;
  const cosYaw = Math.cos(solarCameraYaw);
  const sinYaw = Math.sin(solarCameraYaw);
  const cosPitch = Math.cos(solarCameraPitch);
  const sinPitch = Math.sin(solarCameraPitch);
  const anchorOffset = {
    x: cosYaw * screenX + sinYaw * cosPitch * screenY,
    y: -sinYaw * screenX + cosYaw * cosPitch * screenY,
    z: sinPitch * screenY,
  };
  const worldAnchor = {
    x: solarCamera.x + anchorOffset.x,
    y: solarCamera.y + anchorOffset.y,
    z: solarCamera.z + anchorOffset.z,
  };
  solarZoom = Math.max(0.15, Math.min(1000000, solarZoom * factor));
  const nextScale = solarPixelsPerAu();
  solarCamera = {
    x: worldAnchor.x - anchorOffset.x * previousScale / nextScale,
    y: worldAnchor.y - anchorOffset.y * previousScale / nextScale,
    z: worldAnchor.z - anchorOffset.z * previousScale / nextScale,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  width = bounds.width;
  height = bounds.height;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function ensureEarthBuffer(radius) {
  const requestedSize = Math.ceil(radius * 2 * pixelRatio + EARTH_BUFFER_PADDING * 2);
  const nextSize = Math.max(MIN_EARTH_BUFFER_SIZE, Math.min(MAX_EARTH_BUFFER_SIZE, requestedSize));
  if (nextSize === earthBufferSize) return;

  earthBufferSize = nextSize;
  earthBufferRadius = (earthBufferSize - EARTH_BUFFER_PADDING) / 2;
  earthCanvas.width = earthBufferSize;
  earthCanvas.height = earthBufferSize;
  earthImage = earthContext.createImageData(earthBufferSize, earthBufferSize);
  renderedTextureLongitude = Number.NaN;
}

function drawLandRing(ring, offset) {
  const points = [];
  let previousX = null;
  for (const [longitude, latitude] of ring) {
    let x = (longitude + 180) / 360 * TEXTURE_WIDTH;
    if (previousX !== null) {
      while (x - previousX > TEXTURE_WIDTH / 2) x -= TEXTURE_WIDTH;
      while (x - previousX < -TEXTURE_WIDTH / 2) x += TEXTURE_WIDTH;
    }
    points.push([x + offset, (90 - latitude) / 180 * TEXTURE_HEIGHT]);
    previousX = x;
  }
  if (points.length < 4) return;
  textureContext.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) {
    textureContext.lineTo(points[index][0], points[index][1]);
  }
  textureContext.closePath();
}

function createLandTexture(geojson) {
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new TypeError("The land-outline file is not a GeoJSON feature collection.");
  }
  textureContext.fillStyle = "#10334a";
  textureContext.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  textureContext.fillStyle = "#39745e";
  for (const feature of geojson.features) {
    const geometry = feature.geometry;
    const polygons = geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    for (const polygon of polygons) {
      for (const offset of [-TEXTURE_WIDTH, 0, TEXTURE_WIDTH]) {
        textureContext.beginPath();
        for (const ring of polygon) drawLandRing(ring, offset);
        textureContext.fill("evenodd");
      }
    }
  }
  landTexture = textureContext.getImageData(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  fillCloudTextureGaps();
  if (cloudTexture) renderedTextureLongitude = Number.NaN;
  if (!cloudTexture) mapStatusElement.textContent = "Land outlines: Natural Earth 1:50m (satellite imagery unavailable).";
}

function imageryDate(daysAgo) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function imageCoverage(imageData) {
  let visiblePixels = 0;
  let sampledPixels = 0;
  for (let y = 8; y < TEXTURE_HEIGHT; y += 16) {
    for (let x = 8; x < TEXTURE_WIDTH; x += 16) {
      const offset = (y * TEXTURE_WIDTH + x) * 4;
      if (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2] > 45) {
        visiblePixels += 1;
      }
      sampledPixels += 1;
    }
  }
  return visiblePixels / sampledPixels;
}

function fillCloudTextureGaps() {
  if (!cloudTexture || !landTexture) return;
  for (let offset = 0; offset < cloudTexture.data.length; offset += 4) {
    const brightness = cloudTexture.data[offset]
      + cloudTexture.data[offset + 1]
      + cloudTexture.data[offset + 2];
    if (brightness >= 18) continue;
    cloudTexture.data[offset] = landTexture.data[offset];
    cloudTexture.data[offset + 1] = landTexture.data[offset + 1];
    cloudTexture.data[offset + 2] = landTexture.data[offset + 2];
  }
}

async function loadEarthImagery() {
  if (imageryRefreshInProgress) return;
  imageryRefreshInProgress = true;
  const failures = [];
  try {
    for (let daysAgo = 0; daysAgo <= 2; daysAgo += 1) {
      const date = imageryDate(daysAgo);
      const url = `${GIBS_WMS_URL}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0`
        + `&LAYERS=${GIBS_TRUE_COLOR_LAYER}&STYLES=&FORMAT=image/jpeg&TRANSPARENT=false`
        + `&HEIGHT=${TEXTURE_HEIGHT}&WIDTH=${TEXTURE_WIDTH}&CRS=EPSG:4326`
        + `&BBOX=-90,-180,90,180&TIME=${date}`;
      let bitmap;
      try {
        const response = await fetch(url, {
          cache: "no-cache",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`NASA GIBS returned HTTP ${response.status}`);
        bitmap = await createImageBitmap(await response.blob());
        if (bitmap.width < 2 || bitmap.height < 2) throw new Error("NASA GIBS returned an empty image.");
        textureContext.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
        textureContext.drawImage(bitmap, 0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
        const image = textureContext.getImageData(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
        const coverage = imageCoverage(image);
        if (coverage < 0.2) {
          throw new Error(`only ${(coverage * 100).toFixed(0)}% of sampled pixels contain visible imagery`);
        }
        cloudTexture = image;
        fillCloudTextureGaps();
        cloudImageDate = date;
        renderedTextureLongitude = Number.NaN;
        renderedSunLatitude = Number.NaN;
        renderedSunLongitude = Number.NaN;
        mapStatusElement.textContent = `NASA MODIS Terra true-color / clouds · ${date} UTC composite · ~${Math.round(coverage * 100)}% image coverage.`;
        return;
      } catch (error) {
        failures.push(`${date}: ${error.message}`);
      } finally {
        bitmap?.close();
      }
    }

    const failureMessage = failures.join(" · ");
    mapStatusElement.textContent = cloudTexture
      ? `NASA imagery refresh failed; retaining ${cloudImageDate}: ${failureMessage}`
      : `NASA cloud imagery unavailable; using Natural Earth outlines. ${failureMessage}`;
  } finally {
    imageryRefreshInProgress = false;
  }
}

function renderEarthTexture(now) {
  const surfaceTexture = cloudTexture ?? landTexture;
  if (!surfaceTexture) return;
  const sun = subsolarPoint(now);
  const currentViewLongitude = viewLongitudeAt(now);
  if (
    Math.abs(normalizeLongitude(currentViewLongitude - renderedTextureLongitude)) < 0.1
    && Math.abs(sun.latitude - renderedSunLatitude) < 0.5
    && Math.abs(sun.longitude - renderedSunLongitude) < 0.5
  ) return;
  renderedTextureLongitude = currentViewLongitude;
  renderedSunLatitude = sun.latitude;
  renderedSunLongitude = sun.longitude;
  const pixels = earthImage.data;
  const texturePixels = surfaceTexture.data;
  const center = earthBufferSize / 2;
  const solarLatitude = sun.latitude * Math.PI / 180;
  const solarLongitude = (sun.longitude - currentViewLongitude) * Math.PI / 180;
  const lightX = Math.cos(solarLatitude) * Math.sin(solarLongitude);
  const lightY = Math.sin(solarLatitude);
  const lightZ = Math.cos(solarLatitude) * Math.cos(solarLongitude);

  for (let y = 0; y < earthBufferSize; y += 1) {
    const normalY = (center - y) / earthBufferRadius;
    for (let x = 0; x < earthBufferSize; x += 1) {
      const normalX = (x - center) / earthBufferRadius;
      const distanceSquared = normalX * normalX + normalY * normalY;
      const pixelOffset = (y * earthBufferSize + x) * 4;
      if (distanceSquared > 1) {
        pixels[pixelOffset + 3] = 0;
        continue;
      }

      const normalZ = Math.sqrt(1 - distanceSquared);
      const latitude = Math.asin(normalY);
      const longitude = currentViewLongitude * Math.PI / 180 + Math.atan2(normalX, normalZ);
      const wrappedLongitude = (longitude / (2 * Math.PI) + 0.5 + 1) % 1;
      const textureX = Math.min(TEXTURE_WIDTH - 1, Math.floor(wrappedLongitude * TEXTURE_WIDTH));
      const textureY = Math.max(0, Math.min(TEXTURE_HEIGHT - 1,
        Math.floor((0.5 - latitude / Math.PI) * TEXTURE_HEIGHT)));
      const sourceOffset = (textureY * TEXTURE_WIDTH + textureX) * 4;
      const solarIncidence = Math.max(0, normalX * lightX + normalY * lightY + normalZ * lightZ);
      const illumination = 0.08 + 0.92 * Math.pow(solarIncidence, 0.65);

      pixels[pixelOffset] = texturePixels[sourceOffset] * illumination;
      pixels[pixelOffset + 1] = texturePixels[sourceOffset + 1] * illumination;
      pixels[pixelOffset + 2] = texturePixels[sourceOffset + 2] * illumination;
      pixels[pixelOffset + 3] = 255;
    }
  }
  earthContext.putImageData(earthImage, 0, 0);
}

function pointOnGlobe(position, centerX, centerY, radius, timeMs = Date.now(), positionTime = timeMs) {
  const lat = position.latitude * Math.PI / 180;
  const rotationSinceView = positionTime === timeMs
    ? 0
    : (earthRotationAngleAt(positionTime) - earthRotationAngleAt(timeMs)) * 180 / Math.PI;
  const deltaLongitude = (position.longitude + rotationSinceView - viewLongitudeAt(timeMs)) * Math.PI / 180;
  const depth = Math.cos(lat) * Math.cos(deltaLongitude);
  const orbitalRadius = position.radiusKm;
  const earthRadiusRatio = EARTH_RADIUS_KM_VALUE / Math.max(EARTH_RADIUS_KM_VALUE, orbitalRadius);
  const horizon = -Math.sqrt(Math.max(0, 1 - earthRadiusRatio ** 2));
  if (depth < horizon) return null;
  const orbitalDisplayRadius = radius * Math.max(EARTH_RADIUS_KM_VALUE, orbitalRadius) / EARTH_RADIUS_KM_VALUE;
  return {
    x: centerX + orbitalDisplayRadius * Math.cos(lat) * Math.sin(deltaLongitude),
    y: centerY - orbitalDisplayRadius * Math.sin(lat),
    depth,
  };
}

function drawGrid(centerX, centerY, radius) {
  context.save();
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.clip();

  if (cloudTexture || landTexture) {
    ensureEarthBuffer(radius);
    renderEarthTexture(Date.now());
    context.drawImage(
      earthCanvas,
      centerX - radius,
      centerY - radius,
      radius * 2,
      radius * 2,
    );
  } else {
    const ocean = context.createRadialGradient(
      centerX - radius * 0.38, centerY - radius * 0.44, radius * 0.08,
      centerX, centerY, radius * 1.15,
    );
    ocean.addColorStop(0, "#17445a");
    ocean.addColorStop(0.55, "#0b293d");
    ocean.addColorStop(1, "#071522");
    context.fillStyle = ocean;
    context.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
  }

  context.strokeStyle = "rgb(97 192 188 / 19%)";
  context.lineWidth = 0.7;
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const y = centerY - radius * Math.sin(latitude * Math.PI / 180);
    const widthAtLatitude = radius * Math.cos(latitude * Math.PI / 180);
    context.beginPath();
    context.ellipse(centerX, y, widthAtLatitude, Math.max(1, width * 0.001), 0, 0, Math.PI * 2);
    context.stroke();
  }
  for (let longitude = -60; longitude <= 60; longitude += 30) {
    const angle = longitude * Math.PI / 180;
    context.beginPath();
    context.ellipse(centerX, centerY, radius * Math.abs(Math.sin(angle)), radius, 0, 0, Math.PI * 2);
    context.stroke();
  }

  const glow = context.createRadialGradient(centerX, centerY, radius * 0.8, centerX, centerY, radius * 1.04);
  glow.addColorStop(0, "rgb(44 176 174 / 0%)");
  glow.addColorStop(1, "rgb(61 220 202 / 21%)");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(centerX, centerY, radius * 1.04, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.strokeStyle = "rgb(99 207 194 / 42%)";
  context.lineWidth = 1;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.stroke();
}

function drawEarthAxis(centerX, centerY, radius) {
  if (radius < 35) return;
  context.save();
  context.strokeStyle = "rgba(201, 230, 235, 0.7)";
  context.fillStyle = "#d7e8e9";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(centerX, centerY - radius * 1.15);
  context.lineTo(centerX, centerY - radius * 0.84);
  context.stroke();
  context.beginPath();
  context.moveTo(centerX, centerY - radius * 1.15);
  context.lineTo(centerX - 3, centerY - radius * 1.15 + 6);
  context.lineTo(centerX + 3, centerY - radius * 1.15 + 6);
  context.closePath();
  context.fill();
  context.font = "8px monospace";
  context.textAlign = "center";
  context.fillText("N", centerX, centerY - radius * 1.15 - 5);
  context.restore();
}

function refreshPositions(timeMs, force = false) {
  const wallTime = Date.now();
  if (!force && wallTime - lastPositionsRefreshWallTime < 1500) return;
  lastPositionsRefreshWallTime = wallTime;
  const updatedPositions = new Map();
  for (const object of objects) {
    const position = positionAt(object, timeMs);
    if (position) updatedPositions.set(object.id, position);
  }
  cachedPositions = updatedPositions;
}

function drawOrbit(object, centerX, centerY, radius, now) {
  const period = orbitPeriodSeconds(object);
  const samples = 100;
  context.save();
  context.strokeStyle = regimesById.get(object.regimeId).color;
  context.globalAlpha = 0.65;
  context.lineWidth = 1.2;
  context.beginPath();
  let drawing = false;
  for (let index = 0; index <= samples; index += 1) {
    const positionTime = now + period * 1000 * index / samples;
    const position = positionAt(object, positionTime);
    if (!position) {
      drawing = false;
      continue;
    }
    const point = pointOnGlobe(position, centerX, centerY, radius, now, positionTime);
    if (!point) {
      drawing = false;
      continue;
    }
    if (!drawing) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
    drawing = true;
  }
  context.stroke();
  context.restore();
}

function drawPublicDataLayers(centerX, centerY, radius, now) {
  if (stationsToggle.checked) {
    for (const station of groundStations) {
      const point = pointOnGlobe({
        latitude: station.latitude,
        longitude: station.longitude,
        radiusKm: EARTH_RADIUS_KM_VALUE + station.altitudeKm,
      }, centerX, centerY, radius, now);
      if (!point) continue;
      context.beginPath();
      context.fillStyle = station.connected ? "#75e0bd" : "#b8a6e8";
      context.globalAlpha = station.connected ? 0.9 : 0.62;
      context.arc(point.x, point.y, station.connected ? 2 : 1.5, 0, Math.PI * 2);
      context.fill();
    }
  }

  if (aircraftToggle.checked) {
    for (const aircraft of aircraftPositions) {
      if (now - aircraft.positionTimestamp > 120000) continue;
      const point = pointOnGlobe({
        latitude: aircraft.latitude,
        longitude: aircraft.longitude,
        radiusKm: EARTH_RADIUS_KM_VALUE + aircraft.altitudeKm,
      }, centerX, centerY, radius, now);
      if (!point) continue;
      context.beginPath();
      context.fillStyle = "#ffae6b";
      context.globalAlpha = 0.9;
      context.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.globalAlpha = 1;
}

function solarScreenPoint(position, projection = solarProjection()) {
  return projectSolarPoint(position, solarCamera, { width, height }, projection);
}

function drawDecorativeBackdrop(wallTime) {
  if (visualEffectsEnabled) {
    const drift = Math.sin(wallTime / 24000) * width * 0.025;
    const nebula = context.createRadialGradient(
      width * 0.72 + drift,
      height * 0.34,
      0,
      width * 0.72 + drift,
      height * 0.34,
      Math.max(width, height) * 0.7,
    );
    nebula.addColorStop(0, "rgba(29, 86, 116, 0.11)");
    nebula.addColorStop(1, "rgba(29, 86, 116, 0)");
    context.fillStyle = nebula;
    context.fillRect(0, 0, width, height);
  }
  for (const star of STARFIELD) {
    const twinkle = visualEffectsEnabled
      ? 0.62 + 0.38 * Math.sin(wallTime / 1500 + star.phase)
      : 1;
    context.fillStyle = `rgba(169, 208, 215, ${star.brightness * twinkle})`;
    context.fillRect(star.x * width, star.y * height, star.size, star.size);
  }
}

function drawEphemerisTrails(projection) {
  const earthSeries = solarSystemPayload.bodies.find((body) => body.target.id === "399");
  const earthSamples = new Map(
    (earthSeries?.vectors ?? []).map((vector) => [vector.timestamp, vector]),
  );
  const drawSeries = (series, body, addEarth = false) => {
    context.beginPath();
    let drawing = false;
    for (const vector of series.vectors) {
      const earthVector = addEarth ? earthSamples.get(vector.timestamp) : null;
      if (addEarth && !earthVector) {
        drawing = false;
        continue;
      }
      const position = {
        x: (vector.positionKm.x + (earthVector?.positionKm.x ?? 0)) / ASTRONOMICAL_UNIT_KM,
        y: (vector.positionKm.y + (earthVector?.positionKm.y ?? 0)) / ASTRONOMICAL_UNIT_KM,
        z: (vector.positionKm.z + (earthVector?.positionKm.z ?? 0)) / ASTRONOMICAL_UNIT_KM,
      };
      const point = solarScreenPoint(position, projection);
      if (!point) {
        drawing = false;
        continue;
      }
      if (!drawing) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
      drawing = true;
    }
    context.save();
    context.strokeStyle = body.color;
    context.lineWidth = 1;
    context.globalAlpha = 0.34;
    if (visualEffectsEnabled) {
      context.shadowColor = body.color;
      context.shadowBlur = 6;
    }
    context.stroke();
    context.restore();
  };

  for (const series of solarSystemPayload.bodies) {
    const body = SOLAR_VIEW_BODIES.find((item) => item.id === series.target.id);
    if (body) drawSeries(series, body);
  }
  if (solarSystemPayload.moon && earthSeries) {
    const moon = SOLAR_VIEW_BODIES.find((body) => body.id === "301");
    drawSeries(solarSystemPayload.moon, moon, true);
  }
}

function drawSolarBody(body, position, projection) {
  const point = solarScreenPoint(position, projection);
  if (!point) return;
  if (point.x < -60 || point.x > width + 60 || point.y < -60 || point.y > height + 60) return;
  const radius = body.id === "399" ? 3.5 : 2.5;
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fillStyle = body.color;
  context.fill();
  context.strokeStyle = "rgba(232, 243, 246, 0.8)";
  context.lineWidth = 0.8;
  context.stroke();
  context.fillStyle = "#d9e5e9";
  context.font = "9px monospace";
  context.textAlign = "left";
  context.fillText(body.name, point.x + radius + 5, point.y - radius - 3);
}

function earthCenteredEclipticPosition(position, timeMs, earth) {
  const latitude = position.latitude * Math.PI / 180;
  const longitude = position.longitude * Math.PI / 180 + earthRotationAngleAt(timeMs);
  const equatorialX = position.radiusKm * Math.cos(latitude) * Math.cos(longitude);
  const equatorialY = position.radiusKm * Math.cos(latitude) * Math.sin(longitude);
  const equatorialZ = position.radiusKm * Math.sin(latitude);
  const obliquity = EARTH_OBLIQUITY_DEGREES * Math.PI / 180;
  return {
    x: earth.x + equatorialX / ASTRONOMICAL_UNIT_KM,
    y: earth.y + (equatorialY * Math.cos(obliquity) + equatorialZ * Math.sin(obliquity)) / ASTRONOMICAL_UNIT_KM,
    z: earth.z + (equatorialZ * Math.cos(obliquity) - equatorialY * Math.sin(obliquity)) / ASTRONOMICAL_UNIT_KM,
  };
}

function drawEarthNeighborhood(earth, projection, now) {
  if (solarZoom < 1500) return;
  const regimeId = regimeSelect.value;
  const selected = objects.find((object) => object.id === selectedId);
  if (selected && (regimeId === "all" || selected.regimeId === regimeId)) {
    context.beginPath();
    let drawing = false;
    const period = orbitPeriodSeconds(selected);
    for (let index = 0; index <= 100; index += 1) {
      const sampleTime = now + period * 1000 * index / 100;
      const position = positionAt(selected, sampleTime);
      if (!position) {
        drawing = false;
        continue;
      }
      const point = solarScreenPoint(earthCenteredEclipticPosition(position, sampleTime, earth), projection);
      if (!point) {
        drawing = false;
        continue;
      }
      if (!drawing) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
      drawing = true;
    }
    context.strokeStyle = regimesById.get(selected.regimeId).color;
    context.globalAlpha = 0.48;
    context.lineWidth = 1;
    context.stroke();
    context.globalAlpha = 1;
  }

  for (const object of objects) {
    if (regimeId !== "all" && object.regimeId !== regimeId) continue;
    const position = cachedPositions.get(object.id);
    if (!position) continue;
    const point = solarScreenPoint(earthCenteredEclipticPosition(position, now, earth), projection);
    if (!point) continue;
    if (
      point.x < -5 || point.x > width + 5
      || point.y < -5 || point.y > height + 5
    ) continue;
    const isSelected = object.id === selectedId;
    context.beginPath();
    context.arc(point.x, point.y, isSelected ? 3.5 : 1.8, 0, Math.PI * 2);
    context.fillStyle = isSelected ? "#67f4dc" : regimesById.get(object.regimeId).color;
    context.fill();
  }

  const drawGroundPoint = (latitude, longitude, radiusKm, color, size) => {
    const point = solarScreenPoint(earthCenteredEclipticPosition({
      latitude,
      longitude,
      radiusKm,
    }, now, earth), projection);
    if (!point) return;
    if (
      point.x < -5 || point.x > width + 5
      || point.y < -5 || point.y > height + 5
    ) return;
    context.beginPath();
    context.arc(point.x, point.y, size, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  };
  if (stationsToggle.checked) {
    for (const station of groundStations) {
      drawGroundPoint(
        station.latitude,
        station.longitude,
        EARTH_RADIUS_KM_VALUE + station.altitudeKm,
        station.connected ? "#75e0bd" : "#b8a6e8",
        1.8,
      );
    }
  }
  if (aircraftToggle.checked) {
    for (const aircraft of aircraftPositions) {
      if (now - aircraft.positionTimestamp > 120000) continue;
      drawGroundPoint(
        aircraft.latitude,
        aircraft.longitude,
        EARTH_RADIUS_KM_VALUE + aircraft.altitudeKm,
        "#ffae6b",
        2.1,
      );
    }
  }
}

function drawSolarSystemView(renderTime, wallTime) {
  context.fillStyle = "#050b12";
  context.fillRect(0, 0, width, height);
  drawDecorativeBackdrop(wallTime);
  if (!solarSystemPayload) {
    context.fillStyle = "#91a4ac";
    context.font = "12px monospace";
    context.textAlign = "center";
    context.fillText("Waiting for JPL Horizons planetary vectors…", width / 2, height / 2);
    return;
  }

  const positions = solarPositionsAt(renderTime);
  const projection = solarProjection();
  const sunPosition = { x: 0, y: 0, z: 0 };
  const earth = positions.get("399");
  drawEphemerisTrails(projection);
  const sunPoint = solarScreenPoint(sunPosition, projection);
  const renderQueue = [];
  if (sunPoint) renderQueue.push({ type: "sun", position: sunPosition, point: sunPoint });
  for (const body of SOLAR_VIEW_BODIES) {
    const position = positions.get(body.id);
    const point = position ? solarScreenPoint(position, projection) : null;
    if (position && point) renderQueue.push({ type: "planet", body, position, point });
  }
  renderQueue.sort((first, second) => first.point.depth - second.point.depth);
  for (const item of renderQueue) {
    if (item.type === "sun") {
      if (visualEffectsEnabled) {
        const glow = context.createRadialGradient(
          item.point.x,
          item.point.y,
          2,
          item.point.x,
          item.point.y,
          42,
        );
        glow.addColorStop(0, "rgba(255, 207, 123, 0.24)");
        glow.addColorStop(0.35, "rgba(255, 169, 72, 0.1)");
        glow.addColorStop(1, "rgba(255, 169, 72, 0)");
        context.beginPath();
        context.arc(item.point.x, item.point.y, 42, 0, Math.PI * 2);
        context.fillStyle = glow;
        context.fill();
      }
      context.beginPath();
      context.arc(item.point.x, item.point.y, 4.5, 0, Math.PI * 2);
      context.fillStyle = "#ffd47a";
      context.fill();
      context.strokeStyle = "rgba(255, 246, 201, 0.9)";
      context.lineWidth = 0.8;
      context.stroke();
      context.fillStyle = "#ffe4a1";
      context.font = "10px monospace";
      context.fillText("Sun", item.point.x + 9, item.point.y - 7);
    } else {
      drawSolarBody(item.body, item.position, projection);
    }
  }

  if (earth) {
    const earthPoint = solarScreenPoint(earth, projection);
    if (selectedId) {
      const selectedObject = objects.find((object) => object.id === selectedId);
      const selectedPosition = selectedObject ? cachedPositions.get(selectedObject.id) : null;
      if (selectedPosition) {
        const selectedPoint = solarScreenPoint(
          earthCenteredEclipticPosition(selectedPosition, renderTime, earth),
          projection,
        );
        if (selectedPoint) {
          context.beginPath();
          context.arc(selectedPoint.x, selectedPoint.y, 7, 0, Math.PI * 2);
          context.strokeStyle = "rgba(103, 244, 220, 0.8)";
          context.lineWidth = 1;
          context.stroke();
        }
      }
    }
    drawEarthNeighborhood(earth, projection, renderTime);

    if (earthPoint && earthPoint.x > -45 && earthPoint.x < width + 45
      && earthPoint.y > -45 && earthPoint.y < height + 45) {
      context.fillStyle = "#94a9b2";
      context.font = "8px monospace";
      context.fillText(
        `1 AU ≈ ${Math.round(earthPoint.scale).toLocaleString()} px · body markers not to scale`,
        16,
        height - 34,
      );
    }
  }

  context.fillStyle = "#748893";
  context.font = "8px monospace";
  context.textAlign = "right";
  context.fillText(
    `MODEL ${new Date(renderTime).toISOString().replace("T", " ").slice(0, 19)} UTC · JPL ${solarSystemPayload.range.stepMinutes}m`,
    width - 14,
    height - 16,
  );
  context.textAlign = "left";
}

function draw(frameTime) {
  if (frameTime - lastDrawAt < 33) {
    requestAnimationFrame(draw);
    return;
  }
  const elapsedFrameMs = lastSimulationFrameTime === null
    ? 0
    : Math.max(0, frameTime - lastSimulationFrameTime);
  lastSimulationFrameTime = frameTime;
  lastDrawAt = frameTime;
  if (autoRotateEnabled && activePointers.size === 0) {
    solarCameraYaw += Math.min(elapsedFrameMs, 100) / 1000 * 0.045;
  }
  const wallTime = Date.now();
  if (simulationPlaying) {
    simulationTimeMs = advanceSimulationTime(
      simulationTimeMs,
      elapsedFrameMs,
      Number(simulationRateInput.value),
      wallTime,
    );
    if (simulationTimeMs >= wallTime + SIMULATION_WINDOW_MS - 1000) {
      simulationTimeMs = simulationTimeAtOffset(wallTime, MAX_SIMULATION_OFFSET_MINUTES);
      simulationPlaying = false;
      simulationPinned = true;
      updateTimeControls(wallTime);
    }
  } else if (!simulationPinned) {
    simulationTimeMs = wallTime;
  }
  if (!width || !height) resizeCanvas();
  context.clearRect(0, 0, width, height);
  refreshPositions(simulationTimeMs);
  drawSolarSystemView(simulationTimeMs, wallTime);
  requestAnimationFrame(draw);
}

function updateTimeControls(wallTime = Date.now()) {
  const offsetMinutes = Math.round((simulationTimeMs - wallTime) / 60000);
  const boundedOffset = Math.max(
    -MAX_SIMULATION_OFFSET_MINUTES,
    Math.min(MAX_SIMULATION_OFFSET_MINUTES, offsetMinutes),
  );
  simulationRangeInput.value = String(boundedOffset);
  simulationRangeInput.setAttribute(
    "aria-valuetext",
    new Date(simulationTimeMs).toISOString().replace("T", " ").slice(0, 19) + " UTC",
  );
  simulationTimeElement.textContent = new Date(simulationTimeMs)
    .toISOString().replace("T", " ").slice(0, 19) + " UTC";
  simulationModeElement.textContent = simulationPlaying
    ? `PLAYING · ${Number(simulationRateInput.value).toLocaleString()}×`
    : simulationPinned ? "PAUSED MODEL" : "LIVE";
  simulationPlayButton.textContent = simulationPlaying ? "Pause" : "Play";
  simulationPlayButton.setAttribute(
    "aria-label",
    simulationPlaying ? "Pause model time" : "Play model time",
  );
  returnLiveButton.disabled = !simulationPinned && !simulationPlaying;
}

function updateClock() {
  const wallTime = Date.now();
  clockElement.textContent = new Date(wallTime).toISOString().slice(11, 19) + " UTC";
  updateTimeControls(wallTime);
  updateSolarSystemCards();
  if (selectedId) renderDetails();
}

function formatWeatherValue(feedId, value) {
  if (feedId === "xray") return value.toExponential(2);
  if (feedId === "kp") return value.toFixed(2);
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(value);
}

function drawSpaceEnvironmentFx(centerX, centerY, radius, now) {
  const solarWind = weatherSeriesById.get("solarwind")?.at(-1);
  const dynamicPressure = solarWind
    ? solarWindDynamicPressureNPa(solarWind.value, solarWind.density)
    : null;
  const standoff = dynamicPressure
    ? magnetopauseStandoffEarthRadii(dynamicPressure) ?? 10
    : 10;
  const sun = subsolarPoint(now);
  const solarLatitude = sun.latitude * Math.PI / 180;
  const solarLongitude = (sun.longitude - viewLongitudeAt(now)) * Math.PI / 180;
  const projectedSunX = Math.cos(solarLatitude) * Math.sin(solarLongitude);
  const projectedSunY = -Math.sin(solarLatitude);
  const projectedSunLength = Math.hypot(projectedSunX, projectedSunY);

  if (projectedSunLength < 0.08) {
    if (radius < 15) {
      context.fillStyle = "#91a4ac";
      context.font = "9px monospace";
      context.fillText("Rotate globe to view magnetotail", 14, height - 14);
    }
    return;
  }

  const sunX = projectedSunX;
  const sunY = projectedSunY;
  const crossX = -sunY / projectedSunLength;
  const crossY = sunX / projectedSunLength;
  const point = (sunwardDistance, crossTrack) => ({
    x: centerX + radius * (sunwardDistance * sunX + crossTrack * crossX),
    y: centerY + radius * (sunwardDistance * sunY + crossTrack * crossY),
  });
  const nose = point(standoff, 0);
  const tail = point(-60, 0);

  context.save();
  if (solarWind) {
    const streamOffset = Math.max(10, standoff * 0.85);
    const flowSpeed = solarWindEarthRadiiPerSecond(solarWind.value);
    const phase = ((now / 1000 * flowSpeed) % 12 + 12) % 12;
    for (const side of [-1, 1]) {
      for (let row = 0; row < 2; row += 1) {
        const crossTrack = side * (streamOffset + row * 2.5);
        const upstream = point(80, crossTrack);
        const downstream = point(-70, crossTrack);
        context.beginPath();
        context.moveTo(upstream.x, upstream.y);
        context.lineTo(downstream.x, downstream.y);
        context.setLineDash([3, 12]);
        context.lineDashOffset = -phase * radius;
        context.strokeStyle = "rgba(231, 199, 122, 0.42)";
        context.lineWidth = 1;
        context.stroke();
        context.setLineDash([]);

        for (let distance = phase; distance < 150; distance += 12) {
          const particle = point(80 - distance, crossTrack);
          context.beginPath();
          context.fillStyle = "rgba(244, 211, 135, 0.86)";
          context.arc(particle.x, particle.y, Math.max(1, Math.min(2.4, radius * 0.035)), 0, Math.PI * 2);
          context.fill();
        }
      }
    }
  }

  context.beginPath();
  context.moveTo(nose.x, nose.y);
  const upperDayFlare = point(standoff * 0.65, 8);
  const upperTailCurve = point(-10, 9);
  const upperTailNeck = point(-24, 7);
  context.bezierCurveTo(
    upperDayFlare.x, upperDayFlare.y,
    upperTailCurve.x, upperTailCurve.y,
    upperTailNeck.x, upperTailNeck.y,
  );
  const upperTail = point(-60, 5);
  const lowerTail = point(-60, -5);
  const lowerTailNeck = point(-24, -7);
  context.lineTo(upperTail.x, upperTail.y);
  context.lineTo(lowerTail.x, lowerTail.y);
  context.lineTo(lowerTailNeck.x, lowerTailNeck.y);
  const lowerTailCurve = point(-10, -9);
  const lowerDayFlare = point(standoff * 0.65, -8);
  context.bezierCurveTo(
    lowerTailCurve.x, lowerTailCurve.y,
    lowerDayFlare.x, lowerDayFlare.y,
    nose.x, nose.y,
  );
  context.closePath();
  context.fillStyle = dynamicPressure ? "rgba(79, 196, 176, 0.08)" : "rgba(127, 149, 160, 0.035)";
  context.fill();
  context.strokeStyle = dynamicPressure ? "rgba(79, 196, 176, 0.78)" : "rgba(127, 149, 160, 0.45)";
  context.lineWidth = 1.1;
  if (!dynamicPressure) context.setLineDash([5, 5]);
  context.stroke();
  context.setLineDash([]);

  if (radius < 20) {
    context.fillStyle = dynamicPressure ? "#9de2d6" : "#a1b0b7";
    context.font = "9px monospace";
    const noseLabel = point(standoff + 2, 1);
    if (noseLabel.x > 8 && noseLabel.x < width - 150 && noseLabel.y > 12 && noseLabel.y < height - 12) {
      const label = dynamicPressure
        ? `Magnetopause ${standoff.toFixed(1)} Rₑ · ${dynamicPressure.toFixed(2)} nPa`
        : "Reference magnetopause · ACE data pending";
      context.fillText(label, noseLabel.x, noseLabel.y);
    }
    if (tail.x > 12 && tail.x < width - 100 && tail.y > 12 && tail.y < height - 12) {
      context.fillStyle = "#8da9ad";
      context.fillText("Magnetotail · 60 Rₑ", tail.x, tail.y - radius * 5 - 5);
    }
  }
  context.restore();

}

function drawAtmosphericXrayFx(centerX, centerY, radius, now) {
  const xray = weatherSeriesById.get("xray")?.at(-1);
  if (!xray || xray.value <= 0) return;
  const sun = subsolarPoint(now);
  const latitude = sun.latitude * Math.PI / 180;
  const longitude = (sun.longitude - viewLongitudeAt(now)) * Math.PI / 180;
  const projectedSunX = Math.cos(latitude) * Math.sin(longitude);
  const projectedSunY = -Math.sin(latitude);
  if (Math.hypot(projectedSunX, projectedSunY) < 0.08) return;
  const intensity = Math.max(0, Math.min(1, (Math.log10(xray.value) + 8) / 4));
  const sunAngle = Math.atan2(projectedSunY, projectedSunX);
  context.save();
  context.beginPath();
  context.arc(centerX, centerY, radius * 1.045, sunAngle - Math.PI / 2, sunAngle + Math.PI / 2);
  context.strokeStyle = `rgba(255, 158, 89, ${0.22 + intensity * 0.64})`;
  context.lineWidth = Math.max(1, radius * 0.025);
  context.shadowColor = "#ff9e59";
  context.shadowBlur = Math.min(14, radius * 0.08);
  context.stroke();
  context.restore();
}

function renderWeatherFeed(feed, series) {
  const latest = series.at(-1);
  const card = weatherCards.get(feed.id);
  const source = latest.satellite
    ? `GOES-${latest.satellite}`
    : feed.id === "solarwind"
      ? "ACE upstream"
      : "NOAA SWPC";
  const timestamp = new Date(latest.timestamp).toISOString().replace("T", " ").slice(0, 19);
  card.value.textContent = formatWeatherValue(feed.id, latest.value);
  card.time.textContent = `${source} · ${timestamp} UTC`;
  if (feed.id === "solarwind") {
    card.unit.textContent = `km/s · n ${latest.density.toFixed(1)} cm⁻³ · T ${latest.temperature.toExponential(2)} K`;
  }
}

async function fetchWeatherFeed(feed) {
  const response = await fetch(feed.url, {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseSpaceWeatherSeries(await response.json(), feed.id);
}

async function refreshSpaceWeather() {
  if (weatherRefreshInProgress) return;
  weatherRefreshInProgress = true;
  try {
    weatherStatusElement.textContent = "Refreshing NOAA SWPC observations…";
    const results = await Promise.allSettled(SPACE_WEATHER_FEEDS.map(fetchWeatherFeed));
    const errors = [];
    let updatedCount = 0;

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const feed = SPACE_WEATHER_FEEDS[index];
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`${feed.id}: ${reason}`);
        continue;
      }
      if (result.value.length === 0) {
        errors.push(`${feed.id}: NOAA returned no valid observations`);
        continue;
      }
      weatherSeriesById.set(feed.id, result.value);
      renderWeatherFeed(feed, result.value);
      updatedCount += 1;
    }

    const refreshedAt = new Date().toISOString().slice(11, 19) + " UTC";
    setCoverageState(
      "environment",
      updatedCount > 0 ? (errors.length ? "PARTIAL MEASUREMENTS" : "LIVE MEASUREMENTS") : "UNAVAILABLE",
      updatedCount > 0 ? "connected" : "pending",
    );
    weatherStatusElement.textContent = errors.length
      ? `${updatedCount}/${SPACE_WEATHER_FEEDS.length} feeds updated ${refreshedAt} · ${errors.join(" · ")}`
      : `All ${updatedCount} NOAA feeds updated ${refreshedAt}`;
  } catch (error) {
    weatherStatusElement.textContent = `Space-weather update failed: ${error.message}`;
    throw error;
  } finally {
    weatherRefreshInProgress = false;
  }
}

async function loadInitialSources() {
  await loadCatalog();
  await loadHorizons();
  await loadGroundStations();
  await refreshSpaceWeather();
}

loadButton.addEventListener("click", loadCatalog);
downloadJsonButton.addEventListener("click", () => {
  try {
    downloadDataSnapshot();
  } catch (error) {
    setSourceStatus(exportStatusElement, `JSON export failed: ${error.message}`, true);
  }
});
downloadCsvButton.addEventListener("click", () => {
  try {
    downloadPositionCsv();
  } catch (error) {
    setSourceStatus(exportStatusElement, `CSV export failed: ${error.message}`, true);
  }
});
saveScenePngButton.addEventListener("click", saveScenePng);
visualFxButton.addEventListener("click", () => {
  visualEffectsEnabled = !visualEffectsEnabled;
  updateVisualFxControl();
});
document.querySelector("#autoRotateToggle").addEventListener("click", (event) => {
  autoRotateEnabled = !autoRotateEnabled;
  event.currentTarget.textContent = `Auto-rotate: ${autoRotateEnabled ? "On" : "Off"}`;
  event.currentTarget.setAttribute("aria-pressed", String(autoRotateEnabled));
});
loadAircraftButton.addEventListener("click", () => {
  aircraftToggle.checked = true;
  loadAircraft();
});
loadHorizonsButton.addEventListener("click", loadHorizons);
aircraftToggle.addEventListener("change", () => {
  if (aircraftToggle.checked && aircraftPositions.length === 0) loadAircraft();
});
stationsToggle.addEventListener("change", () => {
  if (stationsToggle.checked && groundStations.length === 0) loadGroundStations();
});
searchInput.addEventListener("input", () => {
  listRenderLimit = 120;
  renderList();
});
regimeSelect.addEventListener("change", () => {
  listRenderLimit = 120;
  const selected = objects.find((object) => object.id === selectedId);
  if (selected && regimeSelect.value !== "all" && selected.regimeId !== regimeSelect.value) {
    selectedId = null;
    renderDetails();
  }
  renderList();
});
loadMoreObjectsButton.addEventListener("click", () => {
  listRenderLimit += 120;
  renderList();
});
simulationRangeInput.addEventListener("input", () => {
  simulationPinned = true;
  simulationPlaying = false;
  lastSimulationFrameTime = null;
  simulationTimeMs = simulationTimeAtOffset(Date.now(), Number(simulationRangeInput.value));
  refreshPositions(simulationTimeMs, true);
  updateTimeControls();
  updateSolarSystemCards();
  if (selectedId) renderDetails();
});
simulationPlayButton.addEventListener("click", () => {
  if (simulationPlaying) {
    simulationPlaying = false;
    simulationPinned = true;
  } else {
    const wallTime = Date.now();
    if (!simulationPinned || simulationTimeMs >= wallTime + SIMULATION_WINDOW_MS - 60000) {
      simulationTimeMs = wallTime;
    }
    simulationPinned = true;
    simulationPlaying = true;
    lastSimulationFrameTime = null;
  }
  updateTimeControls();
});
returnLiveButton.addEventListener("click", () => {
  simulationPlaying = false;
  simulationPinned = false;
  simulationTimeMs = Date.now();
  lastSimulationFrameTime = null;
  refreshPositions(simulationTimeMs, true);
  updateTimeControls();
  updateSolarSystemCards();
  if (selectedId) renderDetails();
});
simulationRateInput.addEventListener("change", () => updateTimeControls());
listElement.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  const object = objects.find((item) => item.id === button.dataset.id);
  if (object) selectObject(object);
});
canvas.addEventListener("pointerdown", (event) => {
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  if (activePointers.size === 1) {
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      camera: { ...solarCamera },
      yaw: solarCameraYaw,
      pitch: solarCameraPitch,
      scale: solarPixelsPerAu(),
      pan: event.shiftKey,
      moved: false,
    };
  } else if (activePointers.size === 2) {
    const [first, second] = [...activePointers.values()];
    pinchStart = {
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      zoom: solarZoom,
    };
    dragStart = null;
  }
});
canvas.addEventListener("pointermove", (event) => {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  if (activePointers.size >= 2 && pinchStart) {
    const [first, second] = [...activePointers.values()];
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    solarZoom = Math.max(0.15, Math.min(1000000, pinchStart.zoom * distance / pinchStart.distance));
    return;
  }
  if (!dragStart) return;
  if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 3) dragStart.moved = true;
  if (dragStart.pan || event.shiftKey) {
    const offset = cameraPlaneOffset(
      -(event.clientX - dragStart.x) / dragStart.scale,
      (event.clientY - dragStart.y) / dragStart.scale,
    );
    solarCamera = {
      x: dragStart.camera.x + offset.x,
      y: dragStart.camera.y + offset.y,
      z: dragStart.camera.z + offset.z,
    };
  } else {
    solarCameraYaw = dragStart.yaw + (event.clientX - dragStart.x) * 0.006;
    solarCameraPitch = Math.max(
      -1.45,
      Math.min(1.45, dragStart.pitch + (event.clientY - dragStart.y) * 0.006),
    );
  }
});
canvas.addEventListener("pointerup", (event) => {
  const wasPinching = pinchStart !== null;
  activePointers.delete(event.pointerId);
  if (wasPinching) {
    pinchStart = null;
    dragStart = null;
    if (activePointers.size === 1) {
      const [remaining] = activePointers.values();
      dragStart = {
        ...remaining,
        camera: { ...solarCamera },
        yaw: solarCameraYaw,
        pitch: solarCameraPitch,
        scale: solarPixelsPerAu(),
        pan: false,
        moved: true,
      };
    }
    return;
  }
  if (dragStart && !dragStart.moved) {
    const bounds = canvas.getBoundingClientRect();
    const clickX = event.clientX - bounds.left;
    const clickY = event.clientY - bounds.top;
    const renderTime = simulationTimeMs;
    const positions = solarPositionsAt(renderTime);
    const earth = positions.get("399");
    const projection = solarProjection();
    let nearestObject = null;
    let nearestObjectDistance = 9;
    if (earth && solarZoom >= 1500) {
      for (const object of objects) {
        if (regimeSelect.value !== "all" && object.regimeId !== regimeSelect.value) continue;
        const position = cachedPositions.get(object.id);
        if (!position) continue;
        const point = solarScreenPoint(
          earthCenteredEclipticPosition(position, renderTime, earth),
          projection,
        );
        if (!point) continue;
        const distance = Math.hypot(point.x - clickX, point.y - clickY);
        if (distance < nearestObjectDistance) {
          nearestObject = object;
          nearestObjectDistance = distance;
        }
      }
    }
    if (nearestObject) {
      selectObject(nearestObject);
    } else {
      let nearestBody = null;
      let nearestBodyDistance = 13;
      for (const body of SOLAR_VIEW_BODIES) {
        const position = positions.get(body.id);
        if (!position) continue;
        const point = solarScreenPoint(position, projection);
        if (!point) continue;
        const distance = Math.hypot(point.x - clickX, point.y - clickY);
        if (distance < nearestBodyDistance) {
          nearestBody = body;
          nearestBodyDistance = distance;
        }
      }
      if (nearestBody?.id === "399" || nearestBody?.id === "301") {
        frameEarthMoon();
      } else if (nearestBody) {
        const position = positions.get(nearestBody.id);
        solarCamera = { ...position };
        solarZoom = Math.max(solarZoom, 100);
      } else {
        const sunPoint = solarScreenPoint({ x: 0, y: 0, z: 0 }, projection);
        if (sunPoint && Math.hypot(sunPoint.x - clickX, sunPoint.y - clickY) < 14) {
          solarCamera = { x: 0, y: 0, z: 0 };
          solarZoom = Math.max(solarZoom, 100);
        }
      }
    }
  }
  dragStart = null;
});
canvas.addEventListener("pointercancel", (event) => {
  activePointers.clear();
  pinchStart = null;
  dragStart = null;
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const bounds = canvas.getBoundingClientRect();
  zoomSolarAt(
    Math.exp(-event.deltaY / 1000),
    event.clientX - bounds.left,
    event.clientY - bounds.top,
  );
}, { passive: false });
window.addEventListener("resize", () => {
  resizeCanvas();
});
new ResizeObserver(resizeCanvas).observe(stage);
zoomInButton.addEventListener("click", () => changeZoom(1.25));
zoomOutButton.addEventListener("click", () => changeZoom(1 / 1.25));
frameSolarSystemButton.addEventListener("click", frameSolarSystem);
frameEarthMoonButton.addEventListener("click", frameEarthMoon);
document.querySelector("#frameEarthFleet").addEventListener("click", frameEarthFleet);
resetZoomButton.addEventListener("click", frameSolarSystem);
fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen();
    else await stage.requestFullscreen();
  } catch (error) {
    setStatus(`Fullscreen unavailable: ${error.message}`);
  }
});
document.addEventListener("fullscreenchange", () => {
  const isFullscreen = document.fullscreenElement === stage;
  fullscreenButton.textContent = isFullscreen ? "Exit fullscreen" : "Fullscreen ⛶";
  fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit Solar System fullscreen" : "Open Solar System fullscreen");
});

resizeCanvas();
updateClock();
window.setInterval(updateClock, 1000);
window.setInterval(loadCatalog, REFRESH_INTERVAL_MS + 1000);
window.setInterval(() => { void refreshSpaceWeather(); }, SPACE_WEATHER_REFRESH_INTERVAL_MS);
window.setInterval(() => {
  if (aircraftToggle.checked && aircraftPositions.length > 0) void loadAircraft();
}, AIRCRAFT_REFRESH_INTERVAL_MS);
window.setInterval(() => { void loadGroundStations(); }, STATIONS_REFRESH_INTERVAL_MS);
window.setInterval(() => { void loadHorizons(); }, HORIZONS_REFRESH_INTERVAL_MS);
updateVisualFxControl();
requestAnimationFrame(draw);
void loadInitialSources();
