# Personal Wings — Flight Ops System Overview

_Reference for the whole app: what's live, where it lives, and how it fits together._
_Last updated: 2026-07-26._

## Live URLs

- **App (map + tracking):** https://personalwings-ops.netlify.app/wx/
- **Briefing page:** https://personalwings-ops.netlify.app/brief.html
- **Ops hub / landing:** https://personalwings-ops.netlify.app/
- **Admin — notify users:** https://personalwings-ops.netlify.app/admin.html
- **Admin — manage users:** https://personalwings-ops.netlify.app/users.html
- **Surge preview (staging):** https://personalwings-ops.surge.sh/
- **Repo:** https://github.com/richpickett/FlightTracker  →  Netlify auto-deploys on push.

## Pages

| Page | File | What it does |
|------|------|--------------|
| Live map | `public/wx/index.html` | Route entry, radar (MRMS/nowCOAST) / echo-tops / satellite (4 hr loop) with matching legends, METARs, winds aloft, live ADS-B for N13709, GPS own-ship, **Share** (link/email/text), **New route**, in-app briefing, account sign-in. |
| Briefing | `public/brief.html` | Route-synced briefing: departure **date** + time, cruise altitude, wind-corrected legs, ETAs, fuel burn/reserve, METAR+TAF per field, winds/temps aloft, best-altitude, ISA-dev, fuel type per field, NOTAMs, food nearby (OpenStreetMap), embedded map + SPC overlay. |
| Account widget | `public/pwauth.js` | Loaded on map + briefing. Sign in / create account / forgot password, and per-user saved routes. Entry point is the **"👤 Sign in"** link in each page's header. |
| Notify users | `public/admin.html` | Compose + send an email blast to all users. Count-recipients dry run, send-test-to-me, send-to-all. Admin-key gated. |
| Manage users | `public/users.html` | List all users (name, email, joined, # routes), search, CSV export, delete (cascades routes). Admin-key gated. |

## Backend (Netlify Functions)

| Function | Purpose | Secrets used |
|----------|---------|--------------|
| `taf.js` | Proxies metar-taf.com TAFs (holds key server-side, adds CORS). | `METARTAF_KEY` |
| `metar.js` | Proxies aviationweather.gov METARs (adds CORS) — fallback for fields the NWS API returns empty. | — |
| `food.js` | Proxies OpenStreetMap Overpass for nearby restaurants (adds CORS, server-side). | — |
| `notam.js` | Proxies autorouter.aero NOTAMs per airport (OAuth client-credentials, token cached, adds CORS). Degrades to a NOTAM-search link if unset. | `AUTOROUTER_USER`, `AUTOROUTER_PASS` |
| `notify.js` | Reads user directory, emails everyone via Postmark. Test sends → transactional stream; blasts → broadcast stream. Admin-only (login + `is_admin`). | `POSTMARK_TOKEN`, `POSTMARK_FROM`, `POSTMARK_STREAM`, `SUPABASE_SERVICE_ROLE` |
| `users.js` | List users (+ route counts), delete a user, toggle admin. Admin-only (login + `is_admin`). | `SUPABASE_SERVICE_ROLE` |

`netlify.toml`: publish dir `public`, functions dir `netlify/functions`.

## Data sources (all browser-CORS-safe)

Radar: **NOAA/MRMS base-reflectivity mosaic via nowCOAST GeoServer WMS** (`nowcoast.noaa.gov/geoserver/observations/weather_radar/wms`, layer `conus_base_reflectivity_mosaic`). Quality-controlled (clutter/AP largely removed), CORS-enabled, renders at any zoom, time-enabled (~4-min scans, several hours history — the 4-hr loop sets `TIME` per frame; GeoServer nearest-matches). Legend (dBZ) is a CSS gradient built from the source's own GetLegendGraphic colors. Satellite: NASA GIBS (GOES-East Band13 IR). Echo tops: NCEP MRMS WMS (`conus_neet_v18`), with a CSS legend matching its GetLegendGraphic. METARs: api.weather.gov (NWS). Winds/temps aloft: Open-Meteo. ADS-B: airplanes.live. Convective outlook: SPC Day-1 GeoJSON. Airport DB: OurAirports + FAA NASR fuel types (`public/wx/airports.json`). TAFs: metar-taf.com via the `taf` function.

_Radar history note:_ Was RainViewer briefly (Jul 2026) — dropped because the free public tilecache only serves to zoom 7 (z8+ returns a "Zoom Level Not Supported" tile) and its nowcast feed was reliably empty. MRMS/nowCOAST is sharper, QC'd, and any-zoom. No forecast/nowcast frames currently (no reliable free forecast-reflectivity source; would need HRRR via a data proxy).

## Supabase (auth + database)

- Project URL: `https://dbkbigxeabzfzoqommtf.supabase.co`
- **Publishable key** (safe in client, in `wx-config.json`): `sb_publishable_7BOSD_...`
- **Tables:** `profiles` (id, name, email, default_reg, is_admin, created_at) and `routes` (user_id, name, route, aircraft, updated_at). Both cascade-delete with the auth user. RLS: users see only their own rows.
- A trigger auto-creates a `profiles` row on signup (captures name + email).
- Auth emails (confirm / reset) send through **Postmark SMTP** (configured in the Supabase dashboard, not the repo).

### Keys — the thing that bit us
- **Client code** uses the **publishable** key (`sb_publishable_...`). Safe to expose.
- **Server functions** use the **legacy `service_role` JWT** (starts `eyJ...`) as `SUPABASE_SERVICE_ROLE`. The new `sb_secret_...` keys do **not** reliably auth against the REST data API — use the legacy `eyJ...` service_role key. It bypasses RLS; keep it only in Netlify env vars, never in client code or the repo.

## Postmark (email)

- **Auth emails:** Supabase → SMTP settings. Host `smtp.postmarkapp.com`, port 587, **username + password both = the Postmark Server API Token** (not your account login). Sender = a verified Sender Signature (`no-reply@personalwings.com`).
- **Notification blasts:** the `notify` function → Postmark API. Test = transactional stream; blast = `broadcast` stream (handles unsubscribe).

## Netlify environment variables

| Var | Value / source |
|-----|----------------|
| `METARTAF_KEY` | metar-taf.com API key |
| `AUTOROUTER_USER` / `AUTOROUTER_PASS` | autorouter.aero account email + password (account must be API-enabled). Optional — NOTAMs show a search link until set. |
| `SUPABASE_ANON_KEY` | *(optional)* publishable/anon key for validating admin login tokens; defaults to the known publishable key |
| `POSTMARK_TOKEN` | Postmark Server API Token |
| `POSTMARK_FROM` | `no-reply@personalwings.com` (verified) |
| `POSTMARK_STREAM` | `broadcast` |
| `SUPABASE_URL` | `https://dbkbigxeabzfzoqommtf.supabase.co` |
| `SUPABASE_SERVICE_ROLE` | **legacy `eyJ...` service_role JWT** |

After changing any env var: **Deploys → Trigger deploy → Deploy site** (they don't apply to already-built functions).

## Deploy workflow

1. Edit files, push to `github.com/richpickett/FlightTracker`.
2. Netlify builds + deploys automatically (~1–2 min).
3. Surge (`personalwings-ops.surge.sh`) is a separate static staging preview — no functions run there, so account/email/admin features only work on Netlify.

## Admin quick-start

- **Admin access:** admin pages require signing in with an account whose `profiles.is_admin = true`. Bootstrap the first admin in SQL: `update public.profiles set is_admin=true where email='rich@personalwings.com';` — after that, promote others from the Users page.
- **Notify:** open `/admin.html` → sign in → subject + message → **Send test to me** → **Send to all users**.
- **Manage users:** open `/users.html` → sign in → **Load users** → search / CSV / delete / toggle admin.

## Open items / ideas

- ⚠️ **When moving to the custom domain (personalwings.com):** update Supabase → Authentication → URL Configuration — set **Site URL** to `https://personalwings.com` and add `https://personalwings.com/**` to **Redirect URLs**. Otherwise confirmation/reset emails will keep pointing at the netlify domain. (Rich asked to be reminded of this at move time.)
- Optional: scheduled task to alert if the confirmation-email flow ever breaks.
- Shared / team routes (currently routes are per-user).
- Fuel pricing per field (needs an authorized data source).
- Postmark account must be out of approval-pending for bulk sends to reach non-domain addresses.
