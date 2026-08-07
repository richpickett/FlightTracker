// Personal Wings — Flightradar24 historical-track proxy (Netlify Function)
// Set env var FR24_TOKEN in Netlify site settings. Call: /.netlify/functions/track?reg=N7SG
// Resolves the tail's active flight, returns its recorded track (timestamped positions)
// so the live map can place the aircraft at the animated weather time. Token stays server-side.
const FR24 = "https://fr24api.flightradar24.com/api";
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=45" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (code, obj) => ({ statusCode: code, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const reg = ((event.queryStringParameters || {}).reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!reg) return J(400, { error: "missing reg" });
  const token = process.env.FR24_TOKEN;
  if (!token) return J(200, { reg, tracks: [], note: "FR24_TOKEN not set" });
  const H = { "Authorization": "Bearer " + token, "Accept": "application/json", "Accept-Version": "v1" };
  try {
    // 1) resolve the active flight id for this registration
    const lr = await fetch(`${FR24}/live/flight-positions/full?registrations=${reg}`, { headers: H });
    if (!lr.ok) return J(200, { reg, tracks: [], note: "live " + lr.status + " " + (await lr.text()).slice(0,120) });
    const lj = await lr.json();
    const data = (lj && (lj.data || lj)) || [];
    const ac = Array.isArray(data) ? data[0] : null;
    const fid = ac && (ac.fr24_id || ac.flight_id || ac.id);
    if (!fid) return J(200, { reg, tracks: [], note: "no active flight" });
    // 2) fetch that flight's recorded track
    const tr = await fetch(`${FR24}/flight-tracks?flight_id=${encodeURIComponent(fid)}`, { headers: H });
    if (!tr.ok) return J(200, { reg, fr24_id: fid, tracks: [], note: "tracks " + tr.status });
    const tj = await tr.json();
    const rec = Array.isArray(tj) ? tj[0] : tj;
    const pts = (rec && rec.tracks) || [];
    const tracks = pts.map(p => ({
      t: (typeof p.timestamp === "number") ? p.timestamp * 1000 : Date.parse(p.timestamp),
      lat: p.lat, lon: p.lon, alt: p.alt, gs: p.gspeed, track: p.track
    })).filter(p => p.t && p.lat != null && p.lon != null);
    return J(200, { reg, fr24_id: fid, flight: (ac.flight || ac.callsign || reg), tracks });
  } catch (e) {
    return J(200, { reg, tracks: [], note: "error " + (e && e.message) });
  }
};
