// Personal Wings — FAA NASR runway-end coordinates (bundled, current cycle).
// GET /.netlify/functions/runways?icao=KDIJ
//   -> { icao, count, runways:[{id:"04/22",len,width,ends:[{id,lat,lon,dlat,dlon,hdg,elev}]}] }
// Authoritative threshold coordinates so the airport diagram can anchor runway closures
// to the real runway (matching Jeppesen / the FAA plate) instead of stale OSM geometry.
// Data regenerated from the 28-day NASR APT subset by tools/gen_runways.py (see refresh-runways.yml).
let DB = {};
try { DB = require("./runways-data.js"); } catch (e) { DB = {}; }

// The data is keyed by BOTH ICAO (KDIJ) and FAA ident (DIJ, L35, 1A9). Try the raw
// value first, then reasonable ICAO<->ident variants, so any of those forms resolves.
function keysFor(s) {
  s = (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const out = [s];
  if (s.length === 4 && (s[0] === "K" || s[0] === "P")) out.push(s.slice(1)); // KDIJ->DIJ, PANC->ANC
  if (/^[A-Z]{3}$/.test(s)) out.push("K" + s);                                 // DIJ->KDIJ (CONUS only)
  return out;
}

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const hdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" };
  const q = event.queryStringParameters || {};
  const raw = (q.icao || q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return { statusCode: 400, headers: hdr, body: '{"error":"need icao"}' };
  let runways = [];
  for (const k of keysFor(raw)) { if (DB[k] && DB[k].length) { runways = DB[k]; break; } }
  return { statusCode: 200, headers: hdr, body: JSON.stringify({ icao: raw, count: runways.length, runways }) };
};
