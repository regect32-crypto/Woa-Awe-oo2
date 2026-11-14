import {
  EARTH_RADIUS_KM_VALUE,
  ORBIT_REGIMES,
  orbitPeriodSeconds,
  parseCatalog,
  positionAt,
} from "./orbit.mjs";
import LAND_URL from "./data/ne_50m_land.geojson?url";

const CATALOG_URL = "https://celestrak.org/NORAD/elements/gp.php";
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const CACHE_PREFIX = "orbital-atlas-catalog-v1:";
const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1024;
const MIN_EARTH_BUFFER_SIZE = 512;
const MAX_EARTH_BUFFER_SIZE = 4096;
const EARTH_BUFFER_PADDING = 24;
const MIN_ZOOM = 0.01;

const canvas = document.querySelector("#globe");
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
const frameOrbitsButton = document.querySelector("#frameOrbits");
const zoomInButton = document.querySelector("#zoomIn");
const zoomOutButton = document.querySelector("#zoomOut");
const resetZoomButton = document.querySelector("#resetZoom");
const regimeSelect = document.querySelector("#regimeFilter");
const regimeLegendElement = document.querySelector("#regimeLegend");
const regimesById = new Map(ORBIT_REGIMES.map((regime) => [regime.id, regime]));
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
let renderedTextureLongitude = Number.NaN;
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

function setStatus(message) {
  statusElement.textContent = message;
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
  frameOrbits();
  const source = catalog === "active" ? "CelesTrak active catalog" : "CelesTrak space stations";
  const ageMinutes = Math.max(0, Math.floor((Date.now() - fetchedAt) / 60000));
  setStatus(`${source} · ${fromCache ? `cached ${ageMinutes} min ago` : "just fetched"} · element epoch varies by object`);
}

async function loadCatalog() {
  const catalog = catalogSelect.value;
  const cached = readCache(catalog);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) {
    try {
      installCatalog(cached.records, cached.fetchedAt, catalog, true);
    } catch (error) {
      setStatus(`Could not use saved catalog: ${error.message}`);
    }
    return;
  }

  loadButton.disabled = true;
  loadButton.textContent = "Loading public catalog…";
  setStatus("Requesting orbital elements from CelesTrak…");
  try {
    const url = new URL(CATALOG_URL);
    url.searchParams.set("GROUP", catalog);
    url.searchParams.set("FORMAT", "JSON");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CelesTrak returned HTTP ${response.status}. No retry was attempted.`);
    }
    const records = await response.json();
    const fetchedAt = Date.now();
    installCatalog(records, fetchedAt, catalog, false);
    writeCache(catalog, records, fetchedAt);
  } catch (error) {
    setStatus(`Catalog unavailable: ${error.message}`);
  } finally {
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
  const position = cachedPositions.get(object.id) ?? positionAt(object, Date.now());
  if (position) viewLongitude = position.longitude;
  renderList();
  renderDetails();
}

function changeZoom(factor) {
  zoom = Math.max(MIN_ZOOM, Math.min(1.8, zoom * factor));
}

function frameOrbits() {
  const regimeId = regimeSelect.value;
  if (objects.length === 0 || !width || !height) return;
  let maximumRadiusRatio = 1;
  let matchingObjects = 0;
  for (const object of objects) {
    if (regimeId !== "all" && object.regimeId !== regimeId) continue;
    matchingObjects += 1;
    maximumRadiusRatio = Math.max(
      maximumRadiusRatio,
      (object.apogeeKm + EARTH_RADIUS_KM_VALUE) / EARTH_RADIUS_KM_VALUE,
    );
  }
  if (matchingObjects === 0) return;

  const baseRadius = Math.max(50, Math.min(width * 0.37, height * 0.43));
  const availableRadius = Math.max(12, Math.min(width, height) / 2 - 42);
  zoom = Math.max(MIN_ZOOM, Math.min(1.8, availableRadius / (baseRadius * maximumRadiusRatio)));
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
  mapStatusElement.textContent = "Land outlines: Natural Earth 1:50m.";
}

async function loadLandTexture() {
  try {
    const response = await fetch(LAND_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    createLandTexture(await response.json());
  } catch (error) {
    mapStatusElement.textContent = `Land outlines unavailable: ${error.message}`;
  }
}

function renderEarthTexture() {
  if (!landTexture || Math.abs(viewLongitude - renderedTextureLongitude) < 0.35) return;
  renderedTextureLongitude = viewLongitude;
  const pixels = earthImage.data;
  const texturePixels = landTexture.data;
  const center = earthBufferSize / 2;
  const lightX = -0.37;
  const lightY = 0.42;
  const lightZ = 0.83;

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
      const longitude = viewLongitude * Math.PI / 180 + Math.atan2(normalX, normalZ);
      const wrappedLongitude = (longitude / (2 * Math.PI) + 0.5 + 1) % 1;
      const textureX = Math.min(TEXTURE_WIDTH - 1, Math.floor(wrappedLongitude * TEXTURE_WIDTH));
      const textureY = Math.max(0, Math.min(TEXTURE_HEIGHT - 1,
        Math.floor((0.5 - latitude / Math.PI) * TEXTURE_HEIGHT)));
      const sourceOffset = (textureY * TEXTURE_WIDTH + textureX) * 4;
      const illumination = 0.48 + 0.52 * Math.max(0, normalX * lightX + normalY * lightY + normalZ * lightZ);

      pixels[pixelOffset] = texturePixels[sourceOffset] * illumination;
      pixels[pixelOffset + 1] = texturePixels[sourceOffset + 1] * illumination;
      pixels[pixelOffset + 2] = texturePixels[sourceOffset + 2] * illumination;
      pixels[pixelOffset + 3] = 255;
    }
  }
  earthContext.putImageData(earthImage, 0, 0);
}

function pointOnGlobe(position, centerX, centerY, radius) {
  const lat = position.latitude * Math.PI / 180;
  const deltaLongitude = (position.longitude - viewLongitude) * Math.PI / 180;
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

  if (landTexture) {
    ensureEarthBuffer(radius);
    renderEarthTexture();
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
    const position = positionAt(object, now + period * 1000 * index / samples);
    if (!position) {
      drawing = false;
      continue;
    }
    const point = pointOnGlobe(position, centerX, centerY, radius);
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

function draw(now) {
  if (now - lastDrawAt < 33) {
    requestAnimationFrame(draw);
    return;
  }
  lastDrawAt = now;
  if (!width || !height) resizeCanvas();
  context.clearRect(0, 0, width, height);

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(50, Math.min(width * 0.37, height * 0.43) * zoom);
  const stars = 75;
  for (let index = 0; index < stars; index += 1) {
    const x = (Math.sin(index * 127.1 + 8) * 0.5 + 0.5) * width;
    const y = (Math.sin(index * 311.7 + 4) * 0.5 + 0.5) * height;
    context.fillStyle = `rgba(169, 208, 215, ${0.12 + (index % 5) * 0.035})`;
    context.fillRect(x, y, index % 9 === 0 ? 1.5 : 1, index % 9 === 0 ? 1.5 : 1);
  }

  drawGrid(centerX, centerY, radius);
  refreshPositions(Date.now());
  const selected = objects.find((object) => object.id === selectedId);
  if (selected && (regimeSelect.value === "all" || selected.regimeId === regimeSelect.value)) {
    drawOrbit(selected, centerX, centerY, radius, Date.now());
  }

  for (const object of objects) {
    if (regimeSelect.value !== "all" && object.regimeId !== regimeSelect.value) continue;
    const position = cachedPositions.get(object.id);
    if (!position) continue;
    const point = pointOnGlobe(position, centerX, centerY, radius);
    if (!point) continue;
    const isSelected = object.id === selectedId;
    context.beginPath();
    context.fillStyle = isSelected ? "#67f4dc" : regimesById.get(object.regimeId).color;
    context.shadowColor = isSelected ? "#58e5ce" : "transparent";
    context.shadowBlur = isSelected ? 12 : 0;
    context.arc(point.x, point.y, isSelected ? 3.8 : 1.5, 0, Math.PI * 2);
    context.fill();
  }
  context.shadowBlur = 0;
  requestAnimationFrame(draw);
}

function updateClock() {
  clockElement.textContent = new Date().toISOString().slice(11, 19) + " UTC";
}

loadButton.addEventListener("click", loadCatalog);
searchInput.addEventListener("input", renderList);
regimeSelect.addEventListener("change", () => {
  const selected = objects.find((object) => object.id === selectedId);
  if (selected && regimeSelect.value !== "all" && selected.regimeId !== regimeSelect.value) {
    selectedId = null;
    renderDetails();
  }
  renderList();
  frameOrbits();
});
listElement.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  const object = objects.find((item) => item.id === button.dataset.id);
  if (object) selectObject(object);
});
canvas.addEventListener("pointerdown", (event) => {
  dragStart = { x: event.clientX, y: event.clientY, longitude: viewLongitude, moved: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 3) dragStart.moved = true;
  viewLongitude = dragStart.longitude - (event.clientX - dragStart.x) * 0.45;
});
canvas.addEventListener("pointerup", (event) => {
  if (dragStart && !dragStart.moved) {
    const bounds = canvas.getBoundingClientRect();
    const clickX = event.clientX - bounds.left;
    const clickY = event.clientY - bounds.top;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.max(50, Math.min(width * 0.37, height * 0.43) * zoom);
    let nearest = null;
    let nearestDistance = 9;
    for (const object of objects) {
      const position = cachedPositions.get(object.id);
      if (!position) continue;
      const point = pointOnGlobe(position, centerX, centerY, radius);
      if (!point) continue;
      const distance = Math.hypot(point.x - clickX, point.y - clickY);
      if (distance < nearestDistance) {
        nearest = object;
        nearestDistance = distance;
      }
    }
    if (nearest) {
      selectObject(nearest);
    }
  }
  dragStart = null;
});
canvas.addEventListener("pointercancel", () => { dragStart = null; });
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  changeZoom(Math.exp(-event.deltaY / 1000));
}, { passive: false });
window.addEventListener("resize", resizeCanvas);
new ResizeObserver(resizeCanvas).observe(stage);
zoomInButton.addEventListener("click", () => changeZoom(1.25));
zoomOutButton.addEventListener("click", () => changeZoom(1 / 1.25));
frameOrbitsButton.addEventListener("click", frameOrbits);
resetZoomButton.addEventListener("click", () => { zoom = 1; });
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
  fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit globe fullscreen" : "Open globe fullscreen");
});

resizeCanvas();
updateClock();
window.setInterval(updateClock, 1000);
requestAnimationFrame(draw);
loadLandTexture();
