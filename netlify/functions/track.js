// Personal Wings — Flightradar24 proxy (Netlify Function). Token in env FR24_TOKEN (server-side only).
// Call: /.netlify/functions/track?reg=N7SG (tail) or ?reg=SKW4084 (airline callsign)
// Strategy: try live/flight-positions first; if empty, resolve via flight-summary/light (last 24h)
// then flight-tracks (FR24's documented pattern). Returns {live, tracks}. airplanes.live stays primary.
const FR24 = "https://fr24api.flightradar24.com/api";
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=30" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const reg = ((event.queryStringParameters || {}).reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!reg) return J(400, { error: "missing reg" });
  const token = process.env.FR24_TOKEN;
  if (!token) return J(200, { reg, live: null, tracks: [], note: "FR24_TOKEN not set" });
  const H = { "Authorization": "Bearer " + token, "Accept": "application/json", "Accept-Version": "v1" };
  const isCS = /^[A-Z]{3}[0-9]/.test(reg);
  const filters = isCS ? ["callsigns=" + reg, "flights=" + reg, "registrations=" + reg]
                       : ["registrations=" + reg, "callsigns=" + reg, "flights=" + reg];
  const fdt = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const tried = []; let lastStatus = 0, lastBody = "";
  const getJSON = async (url) => { const r = await fetch(url, { headers: H }); lastStatus = r.status; const t = await r.text(); lastBody = t.slice(0, 240); if (!r.ok) return null; try { return JSON.parse(t); } catch (e) { return null; } };
  try {
    let ac = null, fid = null, live = null;
    // 1) live positions (freshest current position) — may be tier-locked
    for (const f of filters) {
      const j = await getJSON(`${FR24}/live/flight-positions/full?${f}`);
      const data = (j && (j.data || j)) || [];
      tried.push("live:" + f + "=>" + (Array.isArray(data) ? data.length : "?"));
      if (Array.isArray(data) && data[0]) { ac = data[0]; break; }
    }
    if (ac) {
      fid = ac.fr24_id || ac.flight_id || ac.id;
      live = { lat: ac.lat, lon: ac.lon, track: ac.track, alt_baro: ac.alt, gs: ac.gspeed, baro_rate: ac.vspeed, flight: (ac.callsign || ac.flight || reg), r: ac.reg || null, t: ac.type || "", ts: Date.parse(ac.timestamp) || Date.now() };
    }
    // 2) fallback: flight-summary/light over last 24h -> fr24_id (documented path)
    if (!fid) {
      const from = encodeURIComponent(fdt(Date.now() - 24 * 3600 * 1000)), to = encodeURIComponent(fdt(Date.now()));
      for (const f of filters) {
        const j = await getJSON(`${FR24}/flight-summary/light?flight_datetime_from=${from}&flight_datetime_to=${to}&${f}&limit=20`);
        const rows = (j && (j.data || j)) || [];
        tried.push("sum:" + f + "=>" + (Array.isArray(rows) ? rows.length : "?"));
        if (Array.isArray(rows) && rows.length) { const row = rows.find(r => !r.datetime_landed) || rows[rows.length - 1]; fid = row.fr24_id; break; }
      }
    }
    // 3) flight-tracks for the resolved flight id
    let tracks = [];
    if (fid) {
      const tj = await getJSON(`${FR24}/flight-tracks?flight_id=${encodeURIComponent(fid)}`);
      const rec = Array.isArray(tj) ? tj[0] : tj;
      const pts = (rec && rec.tracks) || [];
      tracks = pts.map(p => ({ t: (typeof p.timestamp === "number") ? p.timestamp * 1000 : Date.parse(p.timestamp), lat: p.lat, lon: p.lon, alt: p.alt, gs: p.gspeed, track: p.track })).filter(p => p.t && p.lat != null && p.lon != null);
    }
    // 4) if no live-position hit, use the newest track point as the current position
    if (!live && tracks.length) { const p = tracks[tracks.length - 1]; live = { lat: p.lat, lon: p.lon, track: p.track, alt_baro: p.alt, gs: p.gs, baro_rate: null, flight: reg, r: null, t: "", ts: p.t }; }
    if (!fid && !live) {
      let probe; try { const pr = await fetch(`${FR24}/live/flight-positions/full?bounds=34.5,33,-119,-116&limit=5`, { headers: H }); const pb = await pr.text(); let cnt = "?"; try { const pj = JSON.parse(pb); const pd = (pj && (pj.data || pj)) || []; cnt = Array.isArray(pd) ? pd.length : "?"; } catch (e) {} probe = { status: pr.status, count: cnt, body: pb.slice(0, 160) }; } catch (e) { probe = { error: String(e && e.message) }; }
      return J(200, { reg, live: null, tracks: [], note: "no active flight", debug: { tried, status: lastStatus, body: lastBody, boundsProbe: probe } });
    }
    return J(200, { reg, fr24_id: fid || null, live, tracks, debug: { tried } });
  } catch (e) {
    return J(200, { reg, live: null, tracks: [], note: "error " + (e && e.message), debug: { tried } });
  }
};
