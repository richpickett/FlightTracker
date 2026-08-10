# Personal Wings — FlightTracker handoff

Context doc for a fresh session (or developer). Covers architecture, data, and open items.

## What it is
VFR flight-planning + live-tracking web app. Static site + Netlify Functions, Supabase for auth/data.
- Repo: `github.com/richpickett/FlightTracker`
- Deploy: Netlify → `personalwings-ops.netlify.app` (auto-deploys on push to `main`)
- Build: `netlify.toml` → publish `public/`, functions in `netlify/functions/`

## Pages (`public/`)
- `index.html` — Ops Hub (`/`), the landing page.
- `brief.html` — the briefing tool (route → wind/fuel/wx/NOTAMs/hazards). Requires sign-in (see Gating).
- `wx/index.html` — live enroute map (radar, echo tops, satellite, lightning, area METARs, ADS-B).
- `wx/cost.html` — admin cost dashboard (see Cost tracking).
- `admin.html` — admin hub (Notify Users via Postmark) + nav to Users / Cost report / Map.
- `users.html` — user directory (admin).
- `pwauth.js` — Supabase auth + account panel; exposes `PW_getState`, `PW_applyState`, `PW_saveRoute`, `PW_logBriefing`, `PW_toggleAccount`, `PW_onAuth`.
- `wx/route-expand.js` — route string → points (airports/navaids/fixes/airways/SIDs-STARs).
- `wx/*.json` — nav databases (see Nav DB).
- `wx/wx-config.json` — public config (proxy paths, Supabase URL + publishable key).

## Netlify Functions (`netlify/functions/`) — secrets via env vars
- `food.js` — Google Places (New) searchNearby. **Paid.** Needs Google Places key.
- `notam.js` — SkyLink NOTAMs via RapidAPI. **Paid** (Basic $19/5000). Key `SKYLINK_KEY`.
- `taf.js` — TAF: AWC bbox nearest-station, fallback metar-taf.com. Free.
- `metar.js` — METAR by id or bbox (area mode). Free (aviationweather.gov).
- `sigmet.js` — SIGMET + G-AIRMET (Sierra/Tango/Zulu). Free. FZLVL excluded (renders as huge bands).
- `summarize.js` — NOTAM plain-English summary. Anthropic `claude-haiku-4-5` (key `ANTHROPIC_API_KEY`) or OpenAI `gpt-4o-mini` (`OPENAI_API_KEY`). Returns token usage + cost.
- `users.js`, `track.js`, `notify.js` — user directory / tracking / Postmark email.

### Required Netlify env vars
`SKYLINK_KEY`, `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`), Google Places key, Postmark token, Supabase service bits as used.

## Supabase
- Auth: email/password (`@supabase/supabase-js` v2 in `pwauth.js`).
- `profiles` — `default_reg`, `fleet` jsonb (saved aircraft, mirrored from localStorage `pw_fleet`).
- `routes` — per-user saved routes (+ aircraft snapshot).
- Cost tracking (3NF) — see below. SQL in `supabase/cost_schema.sql` + `supabase/cost_schema_addendum.sql`.

### Cost tracking schema (3NF)
- `cost_service` — billable meters: `places_call`, `notam_call`, `wx_call` ($0), `llm_in/out_haiku45`, `llm_in/out_gpt4omini`.
- `service_rate` — price history (`effective_from/to`); **cost is never stored**, computed in views.
- `briefing` — one row per briefing (`user_id` or anon `client_id`, route, aircraft).
- `briefing_usage` — quantity per service per briefing.
- Views: `v_briefing_cost`, `v_cost_by_month`, `v_cost_by_service`, `v_cost_by_user`, `v_cost_rolling30` (security_invoker; admin sees all via `admin_user`).
- Client logs via `PW_logBriefing` (debounced 5s, deduped per route 10min). Dashboard `/wx/cost.html` (admin sign-in) + CSV export.
- Paid APIs = Google Places + SkyLink NOTAM. WX/AWC = free (volume-tracked only).

## Nav DB (global)
- `airports.json` ~36.5k: US (FAA, unchanged) + ~13.6k international (OurAirports via `airport-data-js`, elevation from OpenFlights where available). Keyed by ident (ICAO for foreign).
- `navaids.json` ~4.95k: US (unchanged) + ~3.9k international (OurAirports `navaids.csv`). US ident wins on collision; VOR preferred over NDB.
- Foreign routing = airport-to-airport + VOR/NDB. Weather (METAR/TAF) + food already work worldwide.

## Account gating
- `brief.html` requires sign-in to build briefings (overlay `#pw-gate`). Shared view-only links (`?ac=`) bypass. Existing users unaffected.

## Known limitations
- Hazards (SIGMET/G-AIRMET) and rich NOTAMs are US-centric — thin abroad.
- Foreign enroute fixes/airways: not loaded (free data spotty). SIDs/STARs abroad: licensed, not available.
- Foreign navaid idents can collide across countries (kept VOR-over-NDB; map makes wrong picks visible).
- "Last 30 days" tile = rolling window via `v_cost_rolling30`.

## Dev workflow note
- Cloud Cowork sessions can't push to the repo (git proxy) and can't reach the local Chrome extension. Patches were couriered to `~/Documents/GitHub/FlightTracker/pw_patches/` and applied by hand.
- **On-computer Cowork mode** avoids this: the agent runs locally, pushes directly via HTTPS creds, and browser automation works. Preferred going forward.

## Open items / next
- Integrate the other Netlify app (provide: repo, stack, purpose, how to join — merge vs shared backend vs cross-link).
- Possible consolidation of the Render logbook app.
- SkyLink ADS-B as a tertiary data source (paid tier).
- Optional: region hints on off-route hazards; whole-app (map) gating if desired.
