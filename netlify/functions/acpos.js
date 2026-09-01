// Personal Wings — live aircraft position from FlightAware AeroAPI (server-side; key never exposed).
//   GET /.netlify/functions/acpos?ident=SKW5989   (tail or airline callsign)
//   -> { ident, live: {lat,lon,alt_baro,gs,track,baro_rate,flight,r,t,ts} | null, note? }
// AeroAPI position refreshes ~once/minute and every call bills — the client throttles to <=1/60s per tail.
const BASE = "https://aeroapi.flightaware.com/aeroapi";

function shape(f, p) {
  if (!p || p.latitude == null || p.longitude == null) return null;
  return {
    lat: p.latitude,
    lon: p.longitude,
    alt_baro: (typeof p.altitude === "number") ? p.altitude * 100 : null, // AeroAPI altitude is 100s of ft
    gs: (p.groundspeed != null) ? p.groundspeed : null,
    track: (p.heading != null) ? p.heading : null,
    baro_rate: null,                                                       // AeroAPI gives C/D/- not fpm
    flight: (f && f.ident) || "",
    r: (f && f.registration) || null,
    t: (f && f.aircraft_type) || "",
    ts: p.timestamp ? (Date.parse(p.timestamp) || Date.now()) : Date.now()
  };
}

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  const hdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const q = event.queryStringParameters || {};
  const ident = (q.ident || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!ident) return { statusCode: 400, headers: hdr, body: '{"error":"missing ident"}' };

  const key = process.env.AEROAPI_KEY || process.env.FLIGHTAWARE_API_KEY || process.env.AEROAPI_API_KEY;
  if (!key) return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: "not configured" }) };
  const H = { "x-apikey": key, Accept: "application/json" };

  try {
    // 1) resolve the active (airborne) flight for this ident
    const fr = await fetch(BASE + "/flights/" + encodeURIComponent(ident) + "?max_pages=1", { headers: H });
    if (!fr.ok) { const t = await fr.text().catch(() => ""); return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: "aeroapi " + fr.status, detail: t.slice(0, 160) }) }; }
    const fd = await fr.json();
    const arr = Array.isArray(fd.flights) ? fd.flights : [];
    // prefer departed-but-not-arrived (in the air); else most recently departed; else first
    const f = arr.find(x => x.actual_off && !x.actual_on) || arr.find(x => x.actual_off) || arr[0];
    if (!f || !f.fa_flight_id) return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: "no active flight" }) };

    // 2) fast path — the flight object often carries last_position inline (no extra billed call)
    let live = shape(f, f.last_position);
    if (!live) {
      const pr = await fetch(BASE + "/flights/" + encodeURIComponent(f.fa_flight_id) + "/position", { headers: H });
      if (!pr.ok) { const t = await pr.text().catch(() => ""); return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: "pos " + pr.status, detail: t.slice(0, 160) }) }; }
      live = shape(f, await pr.json());
    }
    if (!live) return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: "no position yet" }) };
    return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live }) };
  } catch (e) {
    return { statusCode: 200, headers: hdr, body: JSON.stringify({ ident, live: null, note: String(e.message || e) }) };
  }
};
