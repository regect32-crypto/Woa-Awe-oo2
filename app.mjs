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
import {
  ASTRONOMICAL_UNIT_KM,
  EARTH_OBLIQUITY_DEGREES,
  SOLAR_VIEW_BODIES,
  SUN_RADIUS_KM,
  solarSystemPositions,
} from "./solar-view.mjs";

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
const VIEW_ROTATION_EPOCH = Date.now();
const VIEW_ROTATION_EPOCH_ANGLE = earthRotationAngleAt(VIEW_ROTATION_EPOCH);

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
let positionsUpdatedAt = 0;
let lastDrawAt = 0;
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
let lastSolarSystemEpoch = null;
let solarSystemPayload = null;
let solarCamera = { x: 0, y: 0 };
let solarZoom = 1;
let activePointers = new Map();
let pinchStart = null;

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
    throw new Error(payload.error ?? `Data service returned HTTP ${response.status}.`);
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

async function loadAircraft() {
  if (aircraftRefreshInProgress) return;
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
    setSourceStatus(
      aircraftStatusElement,
      aircraftPositions.length
        ? `Refresh failed; retaining ${aircraftPositions.length.toLocaleString()} prior positions: ${error.message}`
        : `Aircraft unavailable: ${error.message}`,
      true,
    );
    setCoverageState("aviation", "UNAVAILABLE", "pending");
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

function renderSolarSystem(payload) {
  solarSystemPayload = payload;
  const cards = payload.bodies.map((body) => {
    const speed = Math.hypot(
      body.velocityKmPerSecond.x,
      body.velocityKmPerSecond.y,
      body.velocityKmPerSecond.z,
    );
    return `<article class="solar-body-card">
      <strong>${escapeHtml(body.target.name)}</strong>
      <span>${(body.distanceKm / ASTRONOMICAL_UNIT_KM).toFixed(3)} AU from Sun</span>
      <span>${speed.toFixed(2)} km/s heliocentric speed</span>
    </article>`;
  });
  if (payload.moon) {
    const moonSpeed = Math.hypot(
      payload.moon.velocityKmPerSecond.x,
      payload.moon.velocityKmPerSecond.y,
      payload.moon.velocityKmPerSecond.z,
    );
    cards.splice(3, 0, `<article class="solar-body-card">
      <strong>Moon</strong>
      <span>${(payload.moon.distanceKm / 1000).toFixed(1)} thousand km from Earth</span>
      <span>${moonSpeed.toFixed(2)} km/s geocentric speed</span>
    </article>`);
  }
  solarSystemBodiesElement.innerHTML = cards.join("");
  mapStatusElement.textContent = payload.moon
    ? "Earth–Moon vector included · positions advance from Horizons velocities between refreshes."
    : "Planet positions advance from Horizons velocities · lunar ephemeris is currently unavailable.";
}

async function loadHorizons() {
  if (horizonsRefreshInProgress) return;
  horizonsRefreshInProgress = true;
  loadHorizonsButton.disabled = true;
  setSourceStatus(horizonsStatusElement, "Requesting current JPL Horizons planetary vectors…");
  try {
    const payload = await fetchSourceJson("/api/sources/solar-system", 90000);
    if (
      !Array.isArray(payload.bodies)
      || payload.bodies.length === 0
      || !payload.bodies.every((body) => (
        body.target
        && Number.isFinite(body.timestamp)
        && Number.isFinite(body.distanceKm)
        && Object.values(body.positionKm ?? {}).length === 3
        && Object.values(body.positionKm).every(Number.isFinite)
        && Object.values(body.velocityKmPerSecond ?? {}).length === 3
        && Object.values(body.velocityKmPerSecond).every(Number.isFinite)
      ))
      || (payload.moon !== null && payload.moon !== undefined && !(
        payload.moon.target?.id === "301"
        && payload.moon.center === "Earth"
        && Number.isFinite(payload.moon.timestamp)
        && Number.isFinite(payload.moon.distanceKm)
        && Object.values(payload.moon.positionKm ?? {}).length === 3
        && Object.values(payload.moon.positionKm).every(Number.isFinite)
        && Object.values(payload.moon.velocityKmPerSecond ?? {}).length === 3
        && Object.values(payload.moon.velocityKmPerSecond).every(Number.isFinite)
      ))
    ) {
      throw new TypeError("The data service returned invalid Solar System vectors.");
    }
    if (!Array.isArray(payload.errors)) {
      throw new TypeError("The data service returned invalid Solar System source status.");
    }
    renderSolarSystem(payload);
    const complete = payload.bodies.length === SOLAR_SYSTEM_BODIES.length
      && payload.moon
      && payload.errors.length === 0;
    const sourceTime = sourceTimestamp(payload.bodies[0].timestamp);
    lastSolarSystemEpoch = payload.bodies[0].timestamp;
    setSourceStatus(
      horizonsStatusElement,
      `JPL Horizons · ${payload.bodies.length}/${SOLAR_SYSTEM_BODIES.length} planets${payload.moon ? " + Moon" : ""} · ${complete ? "complete" : `partial · ${payload.errors.join(" · ")}`} · computed epoch ${sourceTime}.`,
    );
    setCoverageState("solar", complete ? "COMPUTED EPHEMERIS" : "PARTIAL EPHEMERIS", "limited");
  } catch (error) {
    const retainedData = Number.isFinite(lastSolarSystemEpoch)
      ? `Refresh failed; retaining ephemeris from ${sourceTimestamp(lastSolarSystemEpoch)}: `
      : "JPL Horizons unavailable: ";
    setSourceStatus(horizonsStatusElement, `${retainedData}${error.message}`, true);
    setCoverageState("solar", lastSolarSystemEpoch ? "STALE EPHEMERIS" : "UNAVAILABLE", "pending");
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
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`CelesTrak returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function installCatalog(records, fetchedAt, catalog, fromCache) {
  const parsed = parseCatalog(records);
  if (parsed.length === 0) {
    throw new Error("The catalog contained no valid orbital elements.");
  }
  objects = parsed;
  selectedId = null;
  cachedPositions.clear();
  positionsUpdatedAt = 0;
  refreshPositions(Date.now());
  renderList();
  renderRegimeLegend();
  renderDetails();
  objectCountElement.textContent = objects.length.toLocaleString();
  const source = catalog === "active"
    ? "CelesTrak active Earth-orbit catalog"
    : "CelesTrak space stations";
  const ageMinutes = Math.max(0, Math.floor((Date.now() - fetchedAt) / 60000));
  setStatus(`${source} · ${fromCache ? `cached ${ageMinutes} min ago` : "just fetched"} · element epoch varies by object`);
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
      }
    } else {
      setStatus(`Catalog unavailable: ${error.message}`);
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
  if (filtered.length === 0) {
    listElement.innerHTML = '<p class="empty-state">No matching catalog objects.</p>';
    return;
  }
  const rows = filtered.slice(0, 120).map((object) => `
    <button class="object-row${object.id === selectedId ? " selected" : ""}" data-id="${escapeHtml(object.id)}">
      <span class="object-name">${escapeHtml(object.name)}</span>
      <span class="object-id">${escapeHtml(object.id)}</span>
    </button>
  `);
  if (filtered.length > 120) {
    rows.push(`<p class="empty-state">Showing the first 120 of ${filtered.length.toLocaleString()} matches. Search to narrow the list.</p>`);
  }
  listElement.innerHTML = rows.join("");
}

function renderDetails() {
  const object = objects.find((item) => item.id === selectedId);
  if (!object) {
    detailsElement.innerHTML = '<p class="empty-state">Select a point or list entry to inspect its published orbital elements.</p>';
    return;
  }
  const position = positionAt(object, Date.now());
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

function solarPixelsPerAu() {
  return solarBaseScale() * solarZoom;
}

function solarPositionsAt(timeMs = Date.now()) {
  return solarSystemPayload ? solarSystemPositions(solarSystemPayload, timeMs) : new Map();
}

function frameSolarSystem() {
  solarCamera = { x: 0, y: 0 };
  solarZoom = 1;
}

function frameEarthMoon() {
  const earth = solarPositionsAt().get("399");
  if (!earth || !width || !height) return;
  solarCamera = { x: earth.x, y: earth.y };
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
  solarCamera = { x: earth.x, y: earth.y };
  const extentAu = maximumRadiusKm / ASTRONOMICAL_UNIT_KM * 1.25;
  solarZoom = Math.min(
    1000000,
    Math.max(0.15, Math.min(width, height) * 0.38 / (solarBaseScale() * extentAu)),
  );
}

function zoomSolarAt(factor, anchorX = width / 2, anchorY = height / 2) {
  if (!width || !height) return;
  const previousScale = solarPixelsPerAu();
  const worldX = solarCamera.x + (anchorX - width / 2) / previousScale;
  const worldY = solarCamera.y - (anchorY - height / 2) / previousScale;
  solarZoom = Math.max(0.15, Math.min(1000000, solarZoom * factor));
  const nextScale = solarPixelsPerAu();
  solarCamera = {
    x: worldX - (anchorX - width / 2) / nextScale,
    y: worldY + (anchorY - height / 2) / nextScale,
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

function refreshPositions(now) {
  if (now - positionsUpdatedAt < 1500) return;
  positionsUpdatedAt = now;
  const updatedPositions = new Map();
  for (const object of objects) {
    const position = positionAt(object, now);
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

function solarScreenPoint(position, pixelsPerAu) {
  return {
    x: width / 2 + (position.x - solarCamera.x) * pixelsPerAu,
    y: height / 2 - (position.y - solarCamera.y) * pixelsPerAu,
  };
}

function drawOrbitGuide(radiusAu, pixelsPerAu, label, color = "#48606d") {
  const radius = radiusAu * pixelsPerAu;
  if (radius < 8 || radius > Math.max(width, height) * 6) return;
  context.beginPath();
  context.arc(width / 2 - solarCamera.x * pixelsPerAu, height / 2 + solarCamera.y * pixelsPerAu, radius, 0, Math.PI * 2);
  context.strokeStyle = "rgba(91, 124, 139, 0.2)";
  context.lineWidth = 1;
  context.setLineDash([3, 7]);
  context.stroke();
  context.setLineDash([]);
  if (radius > 35 && solarZoom < 100) {
    context.fillStyle = color;
    context.font = "8px monospace";
    context.fillText(label, width / 2 - solarCamera.x * pixelsPerAu + radius + 4, height / 2 + solarCamera.y * pixelsPerAu);
  }
}

function illuminationFraction(position, observer) {
  if (!observer) return 1;
  const sunVector = { x: -position.x, y: -position.y, z: -position.z };
  const observerVector = {
    x: observer.x - position.x,
    y: observer.y - position.y,
    z: observer.z - position.z,
  };
  const sunDistance = Math.hypot(sunVector.x, sunVector.y, sunVector.z);
  const observerDistance = Math.hypot(observerVector.x, observerVector.y, observerVector.z);
  if (sunDistance === 0 || observerDistance === 0) return 1;
  const cosine = (
    sunVector.x * observerVector.x
    + sunVector.y * observerVector.y
    + sunVector.z * observerVector.z
  ) / (sunDistance * observerDistance);
  return Math.max(0, Math.min(1, (1 + cosine) / 2));
}

function drawShadowCone(position, body, pixelsPerAu) {
  const distanceAu = Math.hypot(position.x, position.y, position.z);
  if (!distanceAu || body.radiusKm >= SUN_RADIUS_KM) return;
  const bodyPoint = solarScreenPoint(position, pixelsPerAu);
  if (
    bodyPoint.x < -200 || bodyPoint.x > width + 200
    || bodyPoint.y < -200 || bodyPoint.y > height + 200
  ) return;
  const shadowLengthAu = body.radiusKm / (SUN_RADIUS_KM - body.radiusKm) * distanceAu;
  const radiusAu = body.radiusKm / ASTRONOMICAL_UNIT_KM;
  const directionX = position.x / distanceAu;
  const directionY = position.y / distanceAu;
  const start = {
    x: position.x + directionX * radiusAu,
    y: position.y + directionY * radiusAu,
  };
  const tip = {
    x: position.x + directionX * (radiusAu + shadowLengthAu),
    y: position.y + directionY * (radiusAu + shadowLengthAu),
  };
  const sideX = -directionY * radiusAu;
  const sideY = directionX * radiusAu;
  const first = solarScreenPoint({ x: start.x + sideX, y: start.y + sideY }, pixelsPerAu);
  const second = solarScreenPoint({ x: start.x - sideX, y: start.y - sideY }, pixelsPerAu);
  const end = solarScreenPoint(tip, pixelsPerAu);
  if (Math.hypot(end.x - first.x, end.y - first.y) < 3) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  context.lineTo(end.x, end.y);
  context.lineTo(second.x, second.y);
  context.closePath();
  context.fillStyle = "rgba(2, 6, 12, 0.2)";
  context.fill();
  context.strokeStyle = "rgba(115, 145, 159, 0.2)";
  context.lineWidth = 0.7;
  context.stroke();
}

function drawSolarBody(body, position, earth, pixelsPerAu, now) {
  const point = solarScreenPoint(position, pixelsPerAu);
  if (point.x < -60 || point.x > width + 60 || point.y < -60 || point.y > height + 60) return;

  const actualRadius = body.radiusKm / ASTRONOMICAL_UNIT_KM * pixelsPerAu;
  const minRadius = body.id === "301" ? 3 : body.id === "399" ? 5 : 3.5;
  const radius = Math.max(minRadius, Math.min(45, actualRadius));
  const sunAngle = Math.atan2(position.y, -position.x);
  const observer = body.id === "399" ? null : earth;
  const illumination = body.id === "399" ? 0.5 : illuminationFraction(position, observer);

  if (body.id === "699") {
    context.save();
    context.translate(point.x, point.y);
    context.rotate(-0.2);
    context.beginPath();
    context.ellipse(0, 0, radius * 2.1, radius * 0.72, 0, 0, Math.PI * 2);
    context.strokeStyle = "rgba(225, 203, 151, 0.68)";
    context.lineWidth = Math.max(1.5, radius * 0.18);
    context.stroke();
    context.restore();
  }

  const color = body.color;
  const dark = context.createRadialGradient(
    point.x - radius * 0.35, point.y - radius * 0.38, radius * 0.05,
    point.x, point.y, radius * 1.2,
  );
  dark.addColorStop(0, "#18232e");
  dark.addColorStop(1, "#050a11");
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fillStyle = dark;
  context.fill();

  if (illumination > 0) {
    context.save();
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.clip();
    context.translate(
      point.x + Math.cos(sunAngle) * radius * (1 - illumination),
      point.y + Math.sin(sunAngle) * radius * (1 - illumination),
    );
    context.rotate(sunAngle);
    context.scale(Math.max(0.015, illumination), 1);
    const lit = context.createRadialGradient(-radius * 0.28, -radius * 0.32, 0, 0, 0, radius * 1.3);
    lit.addColorStop(0, "#ffffff");
    lit.addColorStop(0.22, color);
    lit.addColorStop(1, color);
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fillStyle = lit;
    context.fill();
    context.restore();
  }

  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.strokeStyle = body.id === "399" ? "rgba(116, 211, 255, 0.9)" : "rgba(210, 227, 233, 0.38)";
  context.lineWidth = body.id === "399" ? 1.2 : 0.7;
  context.stroke();

  if (body.id === "399") {
    context.beginPath();
    context.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
    context.strokeStyle = "rgba(89, 190, 239, 0.22)";
    context.lineWidth = 2;
    context.stroke();
  }

  context.fillStyle = "#d9e5e9";
  context.font = `${body.id === "399" ? 10 : 9}px monospace`;
  context.textAlign = "left";
  context.fillText(body.name, point.x + radius + 5, point.y - radius - 3);
  if (body.id === "301" && earth) {
    context.fillStyle = "#91a4ac";
    context.font = "8px monospace";
    context.fillText(`${Math.round(illumination * 100)}% lit`, point.x + radius + 5, point.y + 7);
  }
  if (body.id === "599" || body.id === "699") {
    context.fillStyle = "#8295a0";
    context.font = "8px monospace";
    context.fillText(`${(Math.hypot(position.x, position.y, position.z)).toFixed(2)} AU`, point.x + radius + 5, point.y + 8);
  }
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

function drawEarthNeighborhood(earth, pixelsPerAu, now) {
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
      const point = solarScreenPoint(earthCenteredEclipticPosition(position, sampleTime, earth), pixelsPerAu);
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
    const point = solarScreenPoint(earthCenteredEclipticPosition(position, now, earth), pixelsPerAu);
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
    }, now, earth), pixelsPerAu);
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

function drawSolarSystemView(now) {
  context.fillStyle = "#050b12";
  context.fillRect(0, 0, width, height);
  for (let index = 0; index < 130; index += 1) {
    const x = (Math.sin(index * 127.1 + 8) * 0.5 + 0.5) * width;
    const y = (Math.sin(index * 311.7 + 4) * 0.5 + 0.5) * height;
    context.fillStyle = `rgba(169, 208, 215, ${0.1 + (index % 5) * 0.025})`;
    context.fillRect(x, y, index % 11 === 0 ? 1.5 : 1, index % 11 === 0 ? 1.5 : 1);
  }
  if (!solarSystemPayload) {
    context.fillStyle = "#91a4ac";
    context.font = "12px monospace";
    context.textAlign = "center";
    context.fillText("Waiting for JPL Horizons planetary vectors…", width / 2, height / 2);
    return;
  }

  const renderTime = Date.now();
  const positions = solarPositionsAt(renderTime);
  const pixelsPerAu = solarPixelsPerAu();
  const sunPosition = { x: 0, y: 0, z: 0 };
  const earth = positions.get("399");

  for (const body of SOLAR_VIEW_BODIES) {
    if (body.orbitAu) drawOrbitGuide(body.orbitAu, pixelsPerAu, body.name, body.color);
  }
  if (earth && positions.has("301")) {
    const moon = positions.get("301");
    const moonRadius = Math.hypot(moon.x - earth.x, moon.y - earth.y, moon.z - earth.z) * pixelsPerAu;
    if (moonRadius > 8 && moonRadius < Math.max(width, height) * 3) {
      const earthPoint = solarScreenPoint(earth, pixelsPerAu);
      context.beginPath();
      context.arc(earthPoint.x, earthPoint.y, moonRadius, 0, Math.PI * 2);
      context.strokeStyle = "rgba(180, 191, 196, 0.27)";
      context.setLineDash([2, 5]);
      context.lineWidth = 1;
      context.stroke();
      context.setLineDash([]);
    }
  }

  if (solarZoom > 500) {
    for (const body of SOLAR_VIEW_BODIES) {
      if (body.id === "301") continue;
      const position = positions.get(body.id);
      if (position) drawShadowCone(position, body, pixelsPerAu);
    }
    const moonPosition = positions.get("301");
    const moon = SOLAR_VIEW_BODIES.find((body) => body.id === "301");
    if (moonPosition && moon) drawShadowCone(moonPosition, moon, pixelsPerAu);
  }

  const sunPoint = solarScreenPoint(sunPosition, pixelsPerAu);
  const sunRadius = Math.max(9, Math.min(30, SUN_RADIUS_KM / ASTRONOMICAL_UNIT_KM * pixelsPerAu));
  const corona = context.createRadialGradient(sunPoint.x, sunPoint.y, sunRadius * 0.2, sunPoint.x, sunPoint.y, sunRadius * 3.5);
  corona.addColorStop(0, "rgba(255, 197, 90, 0.32)");
  corona.addColorStop(1, "rgba(255, 160, 59, 0)");
  context.beginPath();
  context.arc(sunPoint.x, sunPoint.y, sunRadius * 3.5, 0, Math.PI * 2);
  context.fillStyle = corona;
  context.fill();
  const sunGradient = context.createRadialGradient(
    sunPoint.x - sunRadius * 0.32, sunPoint.y - sunRadius * 0.38, sunRadius * 0.04,
    sunPoint.x, sunPoint.y, sunRadius,
  );
  sunGradient.addColorStop(0, "#fff6c9");
  sunGradient.addColorStop(0.52, "#ffd47a");
  sunGradient.addColorStop(1, "#e88435");
  context.beginPath();
  context.arc(sunPoint.x, sunPoint.y, sunRadius, 0, Math.PI * 2);
  context.fillStyle = sunGradient;
  context.fill();
  context.fillStyle = "#ffe4a1";
  context.font = "10px monospace";
  context.fillText("Sun", sunPoint.x + sunRadius + 6, sunPoint.y - sunRadius - 4);

  for (const body of SOLAR_VIEW_BODIES) {
    const position = positions.get(body.id);
    if (position) drawSolarBody(body, position, earth, pixelsPerAu, renderTime);
  }

  if (earth) {
    const earthPoint = solarScreenPoint(earth, pixelsPerAu);
    const earthRadiusPx = Math.max(5, Math.min(45, EARTH_RADIUS_KM / ASTRONOMICAL_UNIT_KM * pixelsPerAu));
    if (selectedId) {
      const selectedObject = objects.find((object) => object.id === selectedId);
      const selectedPosition = selectedObject ? cachedPositions.get(selectedObject.id) : null;
      if (selectedPosition) {
        const selectedPoint = solarScreenPoint(
          earthCenteredEclipticPosition(selectedPosition, renderTime, earth),
          pixelsPerAu,
        );
        context.beginPath();
        context.arc(selectedPoint.x, selectedPoint.y, 7, 0, Math.PI * 2);
        context.strokeStyle = "rgba(103, 244, 220, 0.8)";
        context.lineWidth = 1;
        context.stroke();
      }
    }
    drawEarthNeighborhood(earth, pixelsPerAu, renderTime);

    if (earthPoint.x > -earthRadiusPx && earthPoint.x < width + earthRadiusPx
      && earthPoint.y > -earthRadiusPx && earthPoint.y < height + earthRadiusPx) {
      context.fillStyle = "#94a9b2";
      context.font = "8px monospace";
      context.fillText(
        `1 AU = ${Math.round(pixelsPerAu).toLocaleString()} px · body sizes enlarged`,
        16,
        height - 34,
      );
    }
  }

  const epoch = solarSystemPayload.bodies[0]?.timestamp;
  context.fillStyle = "#748893";
  context.font = "8px monospace";
  context.textAlign = "right";
  context.fillText(
    `J2000 ecliptic · Horizons epoch ${epoch ? sourceTimestamp(epoch) : "unavailable"} · positions velocity-propagated to now`,
    width - 14,
    height - 16,
  );
  context.textAlign = "left";
}

function draw(now) {
  if (now - lastDrawAt < 33) {
    requestAnimationFrame(draw);
    return;
  }
  lastDrawAt = now;
  if (!width || !height) resizeCanvas();
  context.clearRect(0, 0, width, height);
  const renderTime = Date.now();
  refreshPositions(renderTime);
  drawSolarSystemView(renderTime);
  requestAnimationFrame(draw);
}

function updateClock() {
  clockElement.textContent = new Date().toISOString().slice(11, 19) + " UTC";
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

loadButton.addEventListener("click", loadCatalog);
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
searchInput.addEventListener("input", renderList);
regimeSelect.addEventListener("change", () => {
  const selected = objects.find((object) => object.id === selectedId);
  if (selected && regimeSelect.value !== "all" && selected.regimeId !== regimeSelect.value) {
    selectedId = null;
    renderDetails();
  }
  renderList();
});
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
      cameraX: solarCamera.x,
      cameraY: solarCamera.y,
      scale: solarPixelsPerAu(),
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
  solarCamera = {
    x: dragStart.cameraX - (event.clientX - dragStart.x) / dragStart.scale,
    y: dragStart.cameraY + (event.clientY - dragStart.y) / dragStart.scale,
  };
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
        cameraX: solarCamera.x,
        cameraY: solarCamera.y,
        scale: solarPixelsPerAu(),
        moved: true,
      };
    }
    return;
  }
  if (dragStart && !dragStart.moved) {
    const bounds = canvas.getBoundingClientRect();
    const clickX = event.clientX - bounds.left;
    const clickY = event.clientY - bounds.top;
    const renderTime = Date.now();
    const positions = solarPositionsAt(renderTime);
    const earth = positions.get("399");
    let nearestObject = null;
    let nearestObjectDistance = 9;
    if (earth && solarZoom >= 1500) {
      for (const object of objects) {
        if (regimeSelect.value !== "all" && object.regimeId !== regimeSelect.value) continue;
        const position = cachedPositions.get(object.id);
        if (!position) continue;
        const point = solarScreenPoint(
          earthCenteredEclipticPosition(position, renderTime, earth),
          solarPixelsPerAu(),
        );
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
        const point = solarScreenPoint(position, solarPixelsPerAu());
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
        solarCamera = { x: position.x, y: position.y };
        solarZoom = Math.max(solarZoom, 100);
      } else {
        const sunPoint = solarScreenPoint({ x: 0, y: 0 }, solarPixelsPerAu());
        if (Math.hypot(sunPoint.x - clickX, sunPoint.y - clickY) < 14) {
          solarCamera = { x: 0, y: 0 };
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
window.setInterval(refreshSpaceWeather, SPACE_WEATHER_REFRESH_INTERVAL_MS);
window.setInterval(() => {
  if (aircraftToggle.checked && aircraftPositions.length > 0) loadAircraft();
}, AIRCRAFT_REFRESH_INTERVAL_MS);
window.setInterval(loadGroundStations, STATIONS_REFRESH_INTERVAL_MS);
window.setInterval(loadHorizons, HORIZONS_REFRESH_INTERVAL_MS);
requestAnimationFrame(draw);
refreshSpaceWeather();
loadGroundStations();
loadHorizons();
loadCatalog();
