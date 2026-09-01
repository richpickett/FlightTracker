// Personal Wings — live aircraft position from FlightAware AeroAPI (server-side; key never exposed).
//   GET /.netlify/functions/acpos?ident=SKW5989   (tail or airline callsign)   add &debug=1 for diagnostics
//   -> { ident, live: {lat,lon,alt_baro,gs,track,baro_rate,flight,r,t,ts} | null, note?, debug? }
// AeroAPI position refreshes ~1/min and every call bills — the client throttles to <=1/60s per tail.
const BASE = "https://aeroapi.flightaware.com/aeroapi";

function shape(f, p) {
  if (!p || p.latitude == null || p.longitude == null) return null;
  return {
    lat: p.latitude,
    lon: p.longitude,
    alt_baro: (typeof p.altitude === "number") ? p.altitude * 100 : null, // AeroAPI altitude is 100s of ft
    gs: (p.groundspeed != null) ? p.groundspeed : null,
    track: (p.heading != null) ? p.heading : null,
    baro_rate: null,
    flight: (f && f.ident) || "",
    r: (f && f.registration) || null,
    t: (f && f.aircraft_type) || "",
    ts: p.timestamp ? (Date.parse(p.timestamp) || Date.now()) : Date.now()
  };
}
const sm = x => ({ ident: x.ident, off: x.actual_off || null, on: x.actual_on || null, hasLP: !!(x.last_position && x.last_position.latitude != null), id: x.fa_flight_id });

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  const hdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const q = event.queryStringParameters || {};
  const ident = (q.ident || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const DBG = !!q.debug;
  if (!ident) return { statusCode: 400, headers: hdr, body: '{"error":"missing ident"}' };

  const key = process.env.AEROAPI_KEY || process.env.FLIGHTAWARE_API_KEY || process.env.AEROAPI_API_KEY;
  if (!key) return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: "not configured" }) };
  const H = { "x-apikey": key, Accept: "application/json" };
  const out = (o) => ({ statusCode: 200, headers: hdr, body: JSON.stringify(o) });

  try {
    const fr = await fetch(BASE + "/flights/" + encodeURIComponent(ident) + "?max_pages=1", { headers: H });
    if (!fr.ok) { const t = await fr.text().catch(() => ""); return out({ ident, live: null, note: "flights " + fr.status, detail: t.slice(0, 200) }); }
    const fd = await fr.json();
    const arr = Array.isArray(fd.flights) ? fd.flights : [];
    const f = arr.find(x => x.actual_off && !x.actual_on) || arr.find(x => x.actual_off) || arr[0];
    const debug = DBG ? { flights: arr.length, states: arr.slice(0, 8).map(sm), picked: f ? sm(f) : null } : undefined;
    if (!f || !f.fa_flight_id) return out({ ident, live: null, note: "no active flight", debug });

    // fast path: inline last_position (no extra billed call) when present
    let live = shape(f, f.last_position);
    let posStatus = live ? "last_position" : null, posBody = null;
    if (!live) {
      const pr = await fetch(BASE + "/flights/" + encodeURIComponent(f.fa_flight_id) + "/position", { headers: H });
      posStatus = pr.status;
      const txt = await pr.text().catch(() => "");
      if (DBG) posBody = txt.slice(0, 300);
      if (pr.ok) { try { const pj = JSON.parse(txt);
        // /flights/{id}/position wraps the current fix in last_position (or a positions[] array), not at top level
        const pos = pj.last_position || (Array.isArray(pj.positions) && pj.positions.length ? pj.positions[pj.positions.length - 1] : null) || pj;
        live = shape(f, pos); } catch (e) {} }
    }
    if (debug) { debug.posStatus = posStatus; if (posBody != null) debug.posBody = posBody; }
    return out({ ident, live, note: live ? undefined : "no position", debug });
  } catch (e) {
    return out({ ident, live: null, note: String(e.message || e) });
  }
};
