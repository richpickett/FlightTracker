// Personal Wings — pre-warm the airport-geometry cache for US airline-served fields.
// Hits the deployed airportgeo function (which caches geometry to Supabase on first success), so no
// Supabase creds are needed here. Airport diagrams / OSM taxiway geometry change ~yearly, so a broad
// seed + monthly refresh keeps every briefable field instant-loading and off the live-Overpass path.
//
// List: tools/us-airports.json — [ICAO, lat, lon] for ~562 US fields: 95 large + 409 scheduled-service
// medium (airline-served) + the busiest towered GA/reliever fields by operations (KMYF, KVNY, KDVT,
// KPRC, KAPA, etc. — high-ops fields the airline filter misses). Source: OurAirports. Regenerate if needed.
//
// Run: SITE=https://personalwings-ops.netlify.app node tools/geo-warm.mjs
//   (the GitHub Action geo-warm.yml runs this monthly; trigger it once via "Run workflow" to seed.)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SITE = process.env.SITE || "https://personalwings-ops.netlify.app";
const GAP_MS = parseInt(process.env.WARM_GAP_MS || "1500", 10);   // pacing between airports (be kind to Overpass)
const MAX_RETRY = parseInt(process.env.WARM_RETRY || "3", 10);

// Personal / home fields to always seed even if they're below the large/medium size cut (e.g. KMYF —
// Montgomery Gibbs, the CJ base). Add any field you operate from regularly here.
const EXTRA = [
  ["KMYF", 32.8157, -117.1396],   // Montgomery Gibbs — CJ base
];

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(here, "us-airports.json"), "utf8"));
const seen = new Set();
const APTS = [...EXTRA, ...base].filter(a => { const k = a[0]; if (seen.has(k)) return false; seen.add(k); return true; });

async function hit(icao, lat, lon) {
  const url = SITE + "/.netlify/functions/airportgeo?lat=" + lat + "&lon=" + lon + "&icao=" + icao + "&v=2";
  const t0 = Date.now();
  try {
    const r = await fetch(url);
    const j = await r.json();
    const n = (j.runways || []).length + (j.taxiways || []).length;
    return { icao, ms: Date.now() - t0, rwy: (j.runways || []).length, twy: (j.taxiways || []).length, ok: n > 0, err: j.error || "" };
  } catch (e) { return { icao, ms: Date.now() - t0, ok: false, err: String(e.message || e) }; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let ok = 0, failed = [];
const t0 = Date.now();
for (let i = 0; i < APTS.length; i++) {
  const [icao, lat, lon] = APTS[i];
  let res = await hit(icao, lat, lon);
  for (let k = 0; k < MAX_RETRY && !res.ok; k++) { await sleep(2500); res = await hit(icao, lat, lon); }
  if (res.ok) ok++; else failed.push(res.icao);
  console.log(
    String(i + 1).padStart(3) + "/" + APTS.length,
    res.icao.padEnd(6), res.ok ? "OK  " : "FAIL",
    String(res.ms).padStart(6) + "ms", "twy=" + (res.twy ?? "-"), res.err
  );
  await sleep(GAP_MS);
}
console.log("\nwarmed " + ok + "/" + APTS.length + " in " + Math.round((Date.now() - t0) / 1000) + "s" +
  (failed.length ? "  failed(" + failed.length + "): " + failed.join(",") : ""));
process.exit(0);
