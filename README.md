# Orbital Atlas

A public-data atlas for exploring current Solar System ephemerides, published
Earth-orbit satellite elements, regional aircraft positions, and ground
receiver locations. A small same-origin Node/Vite API adapter handles sources
that are not suitable for direct browser requests. The project is a data
viewer, not a fully accurate digital twin.

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
- Orbits are propagated with the SGP4/SDP4 implementation in `satellite.js`
  using CelesTrak OMM records. Accuracy is still limited by the published
  elements, their epoch, and the model; this is not a guarantee of exact
  real-time satellite position.
- Current orbital speed is computed from SGP4's propagated velocity vector.
  It is an estimate based on the published element set, not onboard telemetry.
- The main view is a navigable, top-down J2000 ecliptic projection of the Sun,
  eight planets, and Moon. Planet positions come from JPL Horizons and are
  advanced continuously from the returned velocity vectors between
  thirty-minute ephemeris refreshes. The Moon uses an Earth-centered Horizons
  vector. Use “Entire Solar System” for the overview, “Earth + Moon” to zoom to
  the lunar neighborhood, or select an Earth-orbit catalog object to frame its
  orbit. Drag to pan and pinch or scroll to zoom.
- Orbital distances use a common AU scale. Planet and Moon graphics are
  enlarged for visibility; the mean planet-orbit circles are guides rather
  than Horizons osculating paths. The view shades bodies by their computed
  Sun/Earth geometry and shows the Moon's illuminated fraction. Shadow cones
  are physically based in length but are only a 2D projection; eclipse depth
  and atmospheric scattering are not modeled.
- [NOAA SWPC GOES feeds](https://services.swpc.noaa.gov/json/goes/primary/)
  provide X-ray and energetic proton/electron flux; [ACE solar-wind data](https://services.swpc.noaa.gov/json/ace/swepam/ace_swepam_1h.json)
  provide upstream speed, density, and plasma temperature; the
  [one-minute Kp feed](https://services.swpc.noaa.gov/json/planetary_k_index_1m.json)
  provides estimated geomagnetic activity. These public feeds refresh every
  five minutes in a separate measurement strip.
  Each reading retains its source timestamp; ACE observations are hourly.
  These measurements are shown separately from the planetary ephemeris and do
  not define a live magnetic-field solution.
  ACE SWEpam does not provide the interplanetary magnetic-field direction needed
  for a full magnetosphere model.   GOES particle flux and Kp remain instrument and index measurements; they do
  not locate global particle paths or aurora.
- Public orbital catalogs and these NOAA feeds do not provide per-satellite
  temperatures, heat-shield readings, or nuclear-system telemetry. Those values
  are not fabricated or inferred from the environmental feeds.
- All loaded object markers are continuously propagated from the published
  elements. Selecting an Earth-orbit catalog entry focuses the main view on
  Earth and draws its SGP4/SDP4 orbit trace; the trace is a model based on that
  element set, not a measured future path. Orbit and planet distances share
  physical units, while planetary body sizes are enlarged for visibility.
- Catalog entries are grouped and color-coded as VLEO, LEO, MEO, GEO,
  highly-elliptical, or high/transfer orbits. The level filter frames the
  selected regime, and the details panel shows current altitude plus mean-element
  perigee and apogee. These are useful orbital categories, not mission-purpose
  classifications.
- VLEO indicates an orbit whose mean apogee is roughly 120–450 km, where
  atmospheric drag can be significant. SGP4 propagates the published drag term;
  this viewer does not model changing atmospheric density, couple space weather
  into orbit decay, or predict maneuvering, and cannot guarantee full accuracy.
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
  Neptune, plus the Moon relative to Earth. Planet positions and heliocentric
  speeds are refreshed every 30 minutes and advanced from the published
  velocities between refreshes. These are computed ephemerides, not spacecraft
  telemetry.
- The app has no configured mission-specific source for onboard temperature
  or mass. Those values remain unavailable; neither is inferred from orbit or
  space-weather measurements.
- Earth weather forecasts, economics, logistics, radio links, and aquatic
  observations are not connected or simulated.
  Satellite catalog records do not reveal private access credentials or
  establish a satellite's current communications links.

Other domains need their own authoritative data sources and must show
provenance, coverage, and time of observation.

JPL Horizons ephemerides are computations, not spacecraft telemetry. The
display is not a full n-body simulation; planetary perturbations and detailed
surface appearance are not synthesized locally.

## Test

```sh
npm test
```
