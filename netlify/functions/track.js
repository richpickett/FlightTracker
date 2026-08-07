// Personal Wings — Flightradar24 proxy (Netlify Function). Token in env FR24_TOKEN (server-side only).
// Call: /.netlify/functions/track?reg=N7SG  (tail)  or  ?reg=SKW4084 (airline callsign)
// Returns {live:{...current position...}, tracks:[{t,lat,lon,...}]} for a flight airplanes.live may not cover.
// Used only as a FALLBACK (airplanes.live is primary) and for the animated history track.
const FR24 = "https://fr24api.flightradar24.com/api";
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=30" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (code, obj) => ({ statusCode: code, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const reg = ((event.queryStringParameters || {}).reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!reg) return J(400, { error: "missing reg" });
  const token = process.env.FR24_TOKEN;
  if (!token) return J(200, { reg, live: null, tracks: [], note: "FR24_TOKEN not set" });
  const H = { "Authorization": "Bearer " + token, "Accept": "application/json", "Accept-Version": "v1" };
  // 3-letter airline code + digit => callsign; otherwise treat as a registration (tail).
  const isCallsign = /^[A-Z]{3}[0-9]/.test(reg);
  const filter = isCallsign ? ("callsigns=" + reg) : ("registrations=" + reg);
  try {
    const lr = await fetch(`${FR24}/live/flight-positions/full?${filter}`, { headers: H });
    if (!lr.ok) return J(200, { reg, live: null, tracks: [], note: "live " + lr.status + " " + (await lr.text()).slice(0,140) });
    const lj = await lr.json();
    const data = (lj && (lj.data || lj)) || [];
    const ac = Array.isArray(data) ? data[0] : null;
    if (!ac) return J(200, { reg, live: null, tracks: [], note: "no active flight", debug: { url: `live/flight-positions/full?${filter}`, status: lr.status, keys: Object.keys(lj||{}), body: JSON.stringify(lj).slice(0, 700) } });
    const live = {
      lat: ac.lat, lon: ac.lon, track: ac.track,
      alt_baro: ac.alt, gs: ac.gspeed, baro_rate: ac.vspeed,
      flight: (ac.callsign || ac.flight || reg), r: ac.reg || null, t: ac.type || "",
      ts: Date.parse(ac.timestamp) || Date.now()
    };
    const fid = ac.fr24_id || ac.flight_id || ac.id;
    let tracks = [];
    if (fid) {
      const tr = await fetch(`${FR24}/flight-tracks?flight_id=${encodeURIComponent(fid)}`, { headers: H });
      if (tr.ok) {
        const tj = await tr.json();
        const rec = Array.isArray(tj) ? tj[0] : tj;
        const pts = (rec && rec.tracks) || [];
        tracks = pts.map(p => ({
          t: (typeof p.timestamp === "number") ? p.timestamp * 1000 : Date.parse(p.timestamp),
          lat: p.lat, lon: p.lon, alt: p.alt, gs: p.gspeed, track: p.track
        })).filter(p => p.t && p.lat != null && p.lon != null);
      }
    }
    return J(200, { reg, fr24_id: fid || null, live, tracks });
  } catch (e) {
    return J(200, { reg, live: null, tracks: [], note: "error " + (e && e.message) });
  }
};
