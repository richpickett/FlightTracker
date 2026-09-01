// Personal Wings — server-side proxy for free, unfiltered community ADS-B (adsb.lol, adsb.fi fallback).
//   GET /.netlify/functions/adsb?type=reg&q=N91CH    |    ?type=callsign&q=SKW5989
// Returns adsb.lol v2 JSON { ac:[...] }. Server-side => no CORS. Unfiltered => FAA-blocked/LADD tails included.
// Coverage is receiver-based (excellent over land, gaps over oceans/remote); the map falls to AeroAPI there.
const BASES = ["https://api.adsb.lol/v2", "https://opendata.adsb.fi/api/v2"];
const UA = "PersonalWings-FlightSuite/1.0 (+https://personalwings.com)";

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  const hdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const q = event.queryStringParameters || {};
  const type = (q.type === "callsign") ? "callsign" : "reg";
  const val = (q.q || q.reg || q.callsign || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!val) return { statusCode: 200, headers: hdr, body: '{"ac":[]}' };

  for (const base of BASES) {
    try {
      const r = await fetch(base + "/" + type + "/" + encodeURIComponent(val), { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        const ac = Array.isArray(j && j.ac) ? j.ac : [];
        return { statusCode: 200, headers: hdr, body: JSON.stringify({ ac, src: base }) };
      }
    } catch (e) { /* try next source */ }
  }
  return { statusCode: 200, headers: hdr, body: '{"ac":[]}' };
};
