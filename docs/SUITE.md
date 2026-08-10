# Personal Wings — Suite architecture plan

Plan for combining the Personal Wings apps into one product ("the suite") without
disrupting anything that's live today. Read alongside `docs/HANDOFF.md`.

## Apps in scope
- **FlightTracker** (this repo) — VFR briefing + live map. Netlify static + functions. **Live, keep untouched.**
- **Flightmap / Logbook** — flight mapping + logbook. `personalwings-flightmap.netlify.app`. Netlify. Has **Shopify Subscriptions stubs**.
- **Logbook analysis** — heavier aircraft-logbook analytics. Hosted on **Render** (compute-heavy). Joins later.

## Guiding principles
1. **One identity, many apps.** Supabase is the single user store for all apps (already built here: auth, `profiles`, `routes`, cost tracking). No app keeps its own separate user table.
2. **One billing / entitlement layer.** A single subscription system decides who's paid; each app just checks entitlement. (Decision pending — see Billing.)
3. **Apps stay on the infra that fits.** Static/edge → Netlify. Compute-heavy analytics → Render. Don't move the Render app into Netlify functions; integrate by calling it.
4. **Integrate at the seams, not by rewrite.** Shared auth token + shared data + a common hub/design. No big-bang monorepo merge.
5. **Never disrupt production.** Build the suite alongside; cut over only when proven (separate site/branch + Netlify preview deploys).

## Backbone: shared identity (Supabase)
Already the foundation here. The suite reuses it:
- Auth session is the passport across apps. Same Supabase project → a signed-in user is signed in everywhere (shared session on the same domain; token hand-off across subdomains).
- Add an **entitlements** table: `entitlement(user_id, plan, status, current_period_end, source)` — the single source of truth for "is this user paid, and for what." Every app gates on it (FlightTracker's `brief.html` gate is the template).

## Billing (DECISION NEEDED)
Pattern is the same either way: **subscription event → webhook → write `entitlement` in Supabase → apps check entitlement.**
- **Shopify Subscriptions** — fits if selling access inside the existing Personal Wings Shopify store/catalog. The flightmap stubs already lean this way.
- **Stripe** — cleaner for pure SaaS and usage-aware pricing (pairs with the per-briefing cost tracking we built). More direct Supabase integration.
- **Open:** pick one before wiring billing. Everything else is independent of the choice.

## Front door
- A unified **hub** (extend FlightTracker's Ops Hub, or a new landing) listing the apps, with one sign-in.
- Shared **design system** (colors, header/nav, account pill) so the apps read as one product.
- Routing: decide **subdomains** (`brief.`, `map.`, `logbook.`) vs **paths** — affects session sharing (subdomains need token hand-off; same-origin paths share the session natively).

## Phasing
- **Phase 1** — FlightTracker + Flightmap under shared Supabase auth, a common hub, and the chosen billing/entitlement layer. Both are Netlify, so this is the low-risk start.
- **Phase 2** — Bring in the Render logbook-analysis app: authenticate its API calls with the Supabase token, surface it in the hub, keep it on Render.
- Each phase ships behind a separate suite site/branch; production FlightTracker stays live throughout.

## Don't
- Put a git working tree on Google Drive (sync corrupts `.git`).
- Merge everything into one repo/host.
- Duplicate the user store across apps.
- Rewrite the Render app to fit Netlify.

## Open decisions (blockers to resolve first)
1. **Billing system:** Shopify vs Stripe.
2. **Routing/domains:** subdomains vs paths (drives session-sharing approach).
3. **Repo strategy:** multi-repo suite (recommended) vs monorepo.
4. **Flightmap specifics:** its repo location, stack, and what its Shopify stubs currently do.
