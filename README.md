# Orbital Atlas

A small, browser-based globe for exploring publicly published satellite orbital
elements. The project is intentionally a data viewer, not a fully accurate
digital twin of Earth.

## Run locally

Install dependencies and start the development server:

```sh
npm install
npm run dev
```

Open the printed local URL, select a catalog, and load it. The station list is
the smaller first check; the active catalog may contain many thousands of
objects. The application stores each result in the browser and will not request
that catalog again for two hours. A refresh is user initiated; there is no
background polling.

Create and preview a production build with `npm run build` and `npm run preview`.

## Data and accuracy

- Satellite element sets: [CelesTrak GP data](https://celestrak.org/NORAD/documentation/gp-data-formats.php),
  requested as OMM-compatible JSON. CelesTrak's [usage policy](https://celestrak.org/usage-policy.php)
  recommends retrieving GP data no more often than once every two hours.
- Land outlines: Natural Earth's 1:50m public-domain land dataset, bundled at
  `data/ne_50m_land.geojson` and rendered locally.
- Orbits are propagated with the SGP4/SDP4 implementation in `satellite.js`
  using CelesTrak OMM records. Accuracy is still limited by the published
  elements, their epoch, and the model; this is not a guarantee of exact
  real-time satellite position.
- Current orbital speed is computed from SGP4's propagated velocity vector.
  It is an estimate based on the published element set, not onboard telemetry.
- The globe surface uses NASA GIBS MODIS Terra corrected true-color imagery,
  which includes observed cloud cover, using the most recent available UTC-day
  composite. Its observation date is shown on the globe; this is a daily
  composite, not a simultaneous real-time global weather map. Images refresh
  periodically, with Natural Earth outlines retained as a fallback.
- Day/night shading follows a low-order solar ephemeris and updates with UTC.
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
- Satellite markers and the selected object's orbit trace are placed at the
  computed orbital radius relative to Earth's radius. Scroll to zoom out and
  frame higher orbits; zoom changes the view, not the underlying orbit.
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
- Recommended next public-data connectors:
  [ADSB.lol](https://www.adsb.lol/docs/open-data/api) provides regional ADS-B
  states under ODbL, with an anonymous limit of 500 requests/day per IP. Its
  API response does not permit direct browser CORS access, so it needs a
  server-side adapter and must honor quota/backoff; it is not integrated yet.
  [SatNOGS](https://network.satnogs.org/api/) exposes public station metadata
  and observation schedules, not comprehensive live receiver/link telemetry.
  Its station list is large, includes user-submitted receiver locations, and
  also needs a server-side adapter and privacy-aware filtering before display.
  [OpenSky](https://openskynetwork.github.io/opensky-api/rest.html) offers
  aircraft state vectors but requires OAuth2 client credentials; any connector
  must keep secrets server-side. These sources do not provide unlimited use.
- [NASA/JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) can provide modeled
  solar-system ephemerides, not live telemetry from every body or spacecraft;
  it is not connected yet.
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
