# Deploy Personal Wings ops app to Netlify (with TAF function)

Structure:
  public/                     -> the site (served at your Netlify URL)
    index.html                -> ops hub
    wx/index.html             -> the live map + in-app briefing
    wx/airports.json          -> 16.8k US airport lookup
    wx/wx-config.json         -> { "tafProxy": "/.netlify/functions/taf" }  (same-origin)
    brief-katw-bdu.html
  netlify/functions/taf.js    -> metar-taf.com proxy (holds your key server-side)
  netlify.toml                -> publish + functions config

## Deploy (dashboard, no CLI)
1. app.netlify.com -> Add new site -> **Deploy manually**.
2. Drag this whole **netlify-site** folder onto the drop zone.
3. After it builds: Site configuration -> **Environment variables** ->
   add  METARTAF_KEY = <your metar-taf.com key>  (rotate it first — see note).
4. Deploys -> **Trigger deploy** (so the function picks up the env var).
5. Open the site. Map is at  /wx/ . Open Briefing -> TAFs appear per airport.

## Deploy (CLI alternative)
  npm i -g netlify-cli
  netlify login
  netlify deploy --prod --dir=public --functions=netlify/functions
  # then set METARTAF_KEY in the site's env vars and redeploy

## Notes
- The function is same-origin, so no CORS is involved. wx-config.json already points at it.
- METAR is free via NWS; only TAF uses metar-taf.com credits (cached 5 min by the function).
- Rotate your metar-taf.com key before setting METARTAF_KEY — the old one was briefly public.
- Custom domain: Site configuration -> Domain management (e.g. wx.personalwings.com).
