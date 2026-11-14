# Orbital Atlas

A public-data globe for exploring published satellite orbital elements,
regional aircraft positions, and ground-receiver locations. A small same-origin
Node/Vite API adapter handles sources that are not suitable for direct browser
requests. The project is a data viewer, not a fully accurate digital twin.

## Run locally

Install dependencies and start the development server:

```sh
npm install
npm run dev
```

Development, preview, and production servers use port `4173` by default; run
only one mode at a time. If needed, set `PORT` to override the production
server's port. Open the printed local URL. The active Earth-orbit catalog loads
automatically; the station list is available from the selector. Results are cached in the
browser and refreshed no more often than every two hours per catalog, in line
with CelesTrak's usage guidance. If a refresh fails, a valid cached catalog
remains displayed. If a first active-catalog request is denied with HTTP 403,
the app tries the smaller space-stations set and clearly labels that reduced
coverage; select the active catalog to try it again later.

All connected sources except ADSB.lol use public endpoints without API keys.
For an optional ADSB.lol key, copy `.env.example` to `.env` and set
`ADSB_LOL_API_KEY`; both the Vite development server and Node production server
load it server-side. Never prefix this secret with `VITE_` or commit `.env`.
The anonymous ADSB.lol quota is 500 requests/day per IP; this app also enforces
a 450-request rolling 24-hour safety cap.

Build and run the Node-served app with:

```sh
npm run build
npm start
```

`npm run preview` is also available for local production-preview checks.
The same-origin `/api/sources/*` routes require a Node-capable host and are not
included in the static build output. The browser requests aircraft only for
the region entered by the user, and does not request device location. Keep API
keys in `.env` for local work or in the hosting platform's secret settings in
deployment; do not put credentials in frontend code.

## Data and accuracy

- Satellite element sets: [CelesTrak GP data](https://celestrak.org/NORAD/documentation/gp-data-formats.php),
  requested as OMM-compatible JSON. CelesTrak's [usage policy](https://celestrak.org/usage-policy.php)
  recommends retrieving GP data no more often than once every two hours.
- The active catalog includes Earth-orbiting objects for which CelesTrak
  publishes GP elements; spacecraft are shown when represented in that
  catalog. It is not a complete list of all spacecraft or deep-space missions.
  Objects without public GP elements, maneuvering vehicles, and classified or
  otherwise unavailable objects cannot be plotted from this source.
- Land outlines: Natural Earth's 1:50m public-domain land dataset, bundled at
  `data/ne_50m_land.geojson` and rendered locally.
- Orbits are propagated with the SGP4/SDP4 implementation in `satellite.js`
  using CelesTrak OMM records. Accuracy is still limited by the published
  elements, their epoch, and the model; this is not a guarantee of exact
  real-time satellite position.
- Current orbital speed is computed from SGP4's propagated velocity vector.
  It is an estimate based on the published element set, not onboard telemetry.
- Earth-surface orientation advances using Greenwich Mean Sidereal Time at the
  sidereal rotation rate. The solar declination/day-night calculation uses the
  low-order solar ephemeris in `solar.mjs`; the globe displays the north axis
  and uses a fixed J2000 obliquity of about 23.44°. Precession and nutation are
  not modeled.
- The globe surface uses NASA GIBS MODIS Terra corrected true-color imagery,
  which includes observed cloud cover, using the most recent available UTC-day
  composite. Its observation date is shown on the globe; this is a daily
  composite, not a simultaneous real-time global weather map. Images refresh
  periodically, with Natural Earth outlines retained as a fallback.
- Day/night shading follows the low-order solar ephemeris and updates with UTC.
- [NOAA SWPC GOES feeds](https://services.swpc.noaa.gov/json/goes/primary/)
  provide X-ray and energetic proton/electron flux; [ACE solar-wind data](https://services.swpc.noaa.gov/json/ace/swepam/ace_swepam_1h.json)
  provide upstream speed, density, and plasma temperature; the
  [one-minute Kp feed](https://services.swpc.noaa.gov/json/planetary_k_index_1m.json)
  provides estimated geomagnetic activity. These public feeds refresh every
  five minutes in a separate measurement strip, without covering the globe.
  Each reading retains its source timestamp; ACE observations are hourly.
  Solar-wind flow and an estimated magnetopause are drawn in the same viewport
  and at the same Earth-radius scale as the orbital markers. Use “Frame space
  environment” to fit the 60-Rₑ tail; pinch or scroll to zoom and drag to rotate.
  The tail shape is schematic, not a live magnetic-field solution.
  ACE SWEpam does not provide the interplanetary magnetic-field direction needed
  for a full magnetosphere model. GOES particle flux and Kp remain instrument
  and index measurements; they are not rendered as global particle paths or
  aurora because those feeds do not locate those effects.
- Public orbital catalogs and these NOAA feeds do not provide per-satellite
  temperatures, heat-shield readings, or nuclear-system telemetry. Those values
  are not fabricated or inferred from the environmental feeds.
- All loaded object markers are continuously propagated from the published
  elements. Selecting a marker or list entry draws its SGP4/SDP4 orbit trace;
  the trace is a model based on that element set, not a measured future path.
  Positions use the computed orbital radius relative to Earth's radius.
  Objects on the far side of Earth are naturally hidden by the globe; scroll
  or use “Frame orbits” to fit higher orbits.
- Catalog entries are grouped and color-coded as VLEO, LEO, MEO, GEO,
  highly-elliptical, or high/transfer orbits. The level filter frames the
  selected regime, and the details panel shows current altitude plus mean-element
  perigee and apogee. These are useful orbital categories, not mission-purpose
  classifications.
- VLEO indicates an orbit whose mean apogee is roughly 120–450 km, where
  atmospheric drag can be significant. SGP4 propagates the published drag term;
  this viewer does not model changing atmospheric density, couple space weather
  into orbit decay, or predict maneuvering, and cannot guarantee full accuracy.
- The globe uses 1:50m land outlines. Its texture render target scales with
  zoom and display pixel density; use the fullscreen control for a larger view.
- [ADSB.lol](https://www.adsb.lol/docs/open-data/api) is connected through the
  same-origin server adapter. The user selects a center and radius (1–250
  nautical miles); recent reported positions are plotted at reported altitude,
  and positions older than two minutes are omitted. Automatic refresh is
  limited to once every ten minutes while the aircraft layer is enabled. Its
  ODbL data has an anonymous limit of 500 requests/day per IP; the shared
  server's IP and cache therefore affect all users. HTTP 429 and `Retry-After`
  are surfaced rather than retried in a tight loop.
- [SatNOGS](https://network.satnogs.org/api/) station locations and the
  source-published connected/status fields are plotted from the public station
  directory, refreshed every 30 minutes and capped at 5,000 displayed
  stations. Coordinates are publicly published, including user-submitted
  receiver locations. This is not a continuous receiver/link feed; observation
  counts are not pass schedules or proof of a successful link.
- [NASA/JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) is connected for
  the Sun-centered geometric vectors of Mercury, Venus, Earth, and Mars through
  Neptune. Their current positions and heliocentric speeds are plotted at a
  common epoch in the J2000 ecliptic frame and refreshed every 30 minutes.
  The diagram preserves relative distance (planet sizes are not to scale) and
  is separate from the Earth-orbit globe. These are computed ephemerides, not
  spacecraft telemetry.
- The app has no configured mission-specific source for onboard temperature
  or mass. Those values remain unavailable; neither is inferred from orbit or
  space-weather measurements.
- Earth weather forecasts, economics, logistics, radio links, and aquatic
  observations are not connected or simulated.
  Satellite catalog records do not reveal private access credentials or
  establish a satellite's current communications links.

Other domains need their own authoritative data sources and must show
provenance, coverage, and time of observation.

We acknowledge the use of imagery provided by NASA's Global Imagery Browse
Services (GIBS), part of NASA's Earth Science Data and Information System
(ESDIS).

## Test

```sh
npm test
```
