// Personal Wings — TAF proxy (Netlify Function)
//   By station:  /.netlify/functions/taf?id=KDEN            -> metar-taf.com JSON (needs METARTAF_KEY)
//   Nearest:     /.netlify/functions/taf?lat=..&lon=..&radius=25
//                -> {found,id,raw,distNm}  (aviationweather.gov bbox; no key; used when a field issues no TAF)
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=300" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const q = event.queryStringParameters || {};

  // ---- Nearest-TAF mode: closest station issuing a TAF within `radius` nm of lat/lon ----
  if (q.lat != null && q.lon != null) {
    const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
    const radius = Math.min(Math.max(parseFloat(q.radius) || 25, 1), 100);
    if (!isFinite(lat) || !isFinite(lon)) return J(400, { found: false, error: "bad lat/lon" });
    const gcNm = (a, b, c, d) => { const R = 3440.065, r = Math.PI / 180, dp = (c - a) * r, dl = (d - b) * r,
      x = Math.sin(dp / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
    const dLat = radius / 60, dLon = radius / (60 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(n => n.toFixed(4)).join(","); // minLat,minLon,maxLat,maxLon
    try {
      const r = await fetch("https://aviationweather.gov/api/data/taf?bbox=" + bbox + "&format=json");
      let arr = []; try { arr = JSON.parse((await r.text()) || "[]"); } catch (e) {}
      let best = null;
      (Array.isArray(arr) ? arr : []).forEach(t => {
        const tl = t.lat, tn = t.lon, raw = t.rawTAF || t.rawTaf || t.raw;
        if (tl == null || tn == null || !raw) return;
        const dist = gcNm(lat, lon, tl, tn);
        if (dist > radius) return;
        if (!best || dist < best.d) best = { id: t.icaoId || t.stationId || "", raw: String(raw).trim(), d: dist };
      });
      if (!best) return J(200, { found: false });
      return J(200, { found: true, id: best.id, raw: best.raw, distNm: Math.round(best.d) });
    } catch (e) { return J(200, { found: false }); }
  }

  // ---- By-station mode (metar-taf.com) ----
  const id = (q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const type = q.type === "metar" ? "metar" : "taf";
  if (!id) return { statusCode: 400, headers: CORS, body: '{"error":"missing id"}' };
  const r = await fetch(`https://api.metar-taf.com/${type}?api_key=${process.env.METARTAF_KEY}&id=${id}`);
  const body = await r.text();
  return { statusCode: r.status, headers: { ...CORS, "Content-Type": "application/json" }, body };
};
