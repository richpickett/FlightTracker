# Personal Wings — Flight Ops

Static flight-ops web app (map + in-app briefing) with a metar-taf.com TAF proxy.
Deployed on Netlify via continuous deployment (push to main → live).

## Layout
    public/                     served site (Netlify publish dir)
      index.html                ops hub
      wx/index.html             live map + route entry + in-app briefing
      wx/airports.json          16.8k US airport lookup
      wx/wx-config.json         { "tafProxy": "/.netlify/functions/taf" }
      brief-katw-bdu.html
    netlify/functions/taf.js    metar-taf.com proxy (key kept server-side)
    netlify.toml                publish + functions config

## Netlify settings
- Build command: (none)
- Publish directory: public
- Functions directory: netlify/functions
- Environment variable: METARTAF_KEY = <your metar-taf.com key>  (rotate first)

## Data sources
METAR: NWS api.weather.gov (free) · TAF: metar-taf.com (via function) ·
Radar/GOES: Iowa Env Mesonet + NASA GIBS · Winds: Open-Meteo · ADS-B: airplanes.live
