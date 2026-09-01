// Personal Wings — retrieve filed route(s) from FlightAware AeroAPI by tail number + date.
//   GET /.netlify/functions/filedroute?ident=N13709&date=2026-08-22
//   -> { ident, date, used:"live"|"history", flights:[{id,ident,origin,originName,destination,destName,route,dep_time,dist}] }
// The AeroAPI key is server-side only (env AEROAPI_KEY, sent as the x-apikey header) — never returned to the client.
const BASE = "https://aeroapi.flightaware.com/aeroapi";

// Strip filed speed/altitude tokens AeroAPI embeds (e.g. "N0450F350"); keep fixes / airways / DCT / SID / STAR.
function cleanRoute(s) {
  return String(s || "").toUpperCase()
    .replace(/\/?\b[NM]\d{3,4}[FSAM]\d{3,4}\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
function isoZ(ms) { return new Date(ms).toISOString().slice(0, 19) + "Z"; }

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  const hdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const q = event.queryStringParameters || {};
  const ident = (q.ident || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const date = (q.date || "").trim();
  if (!ident) return { statusCode: 400, headers: hdr, body: '{"error":"missing ident"}' };

  const key = process.env.AEROAPI_KEY || process.env.FLIGHTAWARE_API_KEY || process.env.AEROAPI_API_KEY;
  if (!key) return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, error: "not configured" }) };

  // UTC-day window around the requested date. AeroAPI live covers ~10 days back / 2 days forward;
  // older dates use /history/flights/{ident} (same response schema).
  const now = Date.now();
  let start, end, useHistory = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d0 = Date.parse(date + "T00:00:00Z");
    start = isoZ(d0); end = isoZ(d0 + 86400000);
    if (d0 < now - 9.5 * 86400000) useHistory = true;      // beyond the live window
    if (d0 > now + 2 * 86400000) return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, date, flights: [], note: "future date beyond AeroAPI coverage" }) };
  } else {
    start = isoZ(now - 2 * 86400000); end = isoZ(now + 2 * 3600000);
  }

  const path = (useHistory ? "/history/flights/" : "/flights/") + encodeURIComponent(ident) +
    "?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end) + "&max_pages=1";
  try {
    const r = await fetch(BASE + path, { headers: { "x-apikey": key, Accept: "application/json" } });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, error: "aeroapi " + r.status, detail: t.slice(0, 200) }) }; }
    const data = await r.json();
    const arr = Array.isArray(data.flights) ? data.flights : [];
    const flights = arr.map(f => {
      const o = f.origin || {}, dd = f.destination || {};
      return {
        id: f.fa_flight_id || "",
        ident: f.ident || ident,
        origin: (o.code_icao || o.code || o.code_iata || "").toUpperCase(),
        originName: o.city || o.name || "",
        destination: (dd.code_icao || dd.code || dd.code_iata || "").toUpperCase(),
        destName: dd.city || dd.name || "",
        route: cleanRoute(f.route || ""),
        dep_time: f.scheduled_out || f.estimated_out || f.scheduled_off || f.filed_departure_time || "",
        alt: (typeof f.filed_altitude === "number" && f.filed_altitude > 0) ? f.filed_altitude : null, // AeroAPI: 100s of feet (FL)
        speed: (typeof f.filed_airspeed === "number" && f.filed_airspeed > 0) ? f.filed_airspeed : null, // AeroAPI: filed airspeed (kt)
        ac_type: (f.aircraft_type || "").toString().toUpperCase(),
        dist: f.route_distance || null
      };
    }).filter(f => f.origin || f.destination || f.route);
    return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, date, used: useHistory ? "history" : "live", flights }) };
  } catch (e) {
    return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, error: String(e.message || e) }) };
  }
};
