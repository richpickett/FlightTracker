// Personal Wings — airport runway/taxiway/apron geometry from OpenStreetMap (Overpass), cached.
// Decouples the client from Overpass flakiness: fetches server-side with mirror fallbacks + per-request
// timeout, returns minimal geometry, and lets the CDN cache it (per airport) for hours.
// GET /.netlify/functions/airportgeo?lat=37.6189&lon=-122.375   (or &bbox=w,s,e,n)
//   -> { runways:[{ref,c:[[lat,lon]...]}], taxiways:[{ref,c}], aprons:[{c}] }

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=21600" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const q = event.queryStringParameters || {};

  let W, S, E, N;
  if (q.bbox) { const b = q.bbox.split(",").map(Number); if (b.length === 4 && b.every(isFinite)) [W, S, E, N] = b; }
  if (W == null) { const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
    if (!isFinite(lat) || !isFinite(lon)) return J(400, { error: "need lat/lon or bbox" });
    W = lon - 0.04; E = lon + 0.04; S = lat - 0.03; N = lat + 0.03; }

  const query = `[out:json][timeout:20];(way["aeroway"~"taxiway|runway|apron"](${S},${W},${N},${E}););out tags geom;`;
  const MIRRORS = ["https://overpass.kumi.systems/api/interpreter","https://overpass.private.coffee/api/interpreter","https://overpass-api.de/api/interpreter","https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

  const fetchTimeout = (url, ms) => {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal })
      .then(r => r.ok ? r.text() : null).finally(() => clearTimeout(to));
  };

  let data = null;
  for (const m of MIRRORS) {
    try { const txt = await fetchTimeout(m, 9000); if (txt && txt.charAt(0) === "{") { data = JSON.parse(txt); break; } } catch (e) {}
  }
  // Do NOT let a transient Overpass outage get cached for hours — mark errors no-store.
  if (!data) return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "overpass unavailable", runways: [], taxiways: [], aprons: [] }) };

  const r5 = c => [Math.round(c.lat * 1e5) / 1e5, Math.round(c.lon * 1e5) / 1e5];
  const runways = [], taxiways = [], aprons = [];
  for (const el of (data.elements || [])) {
    if (!el.geometry || !el.tags) continue;
    const g = el.geometry.map(r5), aw = el.tags.aeroway, ref = el.tags.ref || el.tags.name || "";
    if (aw === "runway") runways.push({ ref, c: g });
    else if (aw === "taxiway") taxiways.push({ ref, c: g });
    else if (aw === "apron") aprons.push({ c: g });
  }
  return J(200, { runways, taxiways, aprons });
};
