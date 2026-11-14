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
  this viewer does not model changing atmospheric density, space weather,
  maneuvering, or provide guaranteed full-accuracy predictions.
- The globe uses 1:50m land outlines. Its texture render target scales with
  zoom and display pixel density; use the fullscreen control for a larger view.
- Weather, economics, logistics, ground gateways, radio signals, aquatic
  observations, and Solar System ephemerides are not connected or simulated.
  Satellite catalog records do not reveal private access credentials or
  establish a satellite's current communications links.

Other domains need their own authoritative data sources and must show
provenance, coverage, and time of observation.

## Test

```sh
npm test
```
