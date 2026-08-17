// Personal Wings — airport runway/taxiway/apron geometry from OpenStreetMap (Overpass), cached.
// Decouples the client from Overpass flakiness: fetches server-side with mirror fallbacks + per-request
// timeout, returns minimal geometry, and lets the CDN cache it (per airport) for hours.
//
// Constrained to the TARGET aerodrome: we also fetch aeroway=aerodrome polygons in the box and keep only
// features whose nearest aerodrome is the requested one (by ICAO, else nearest to lat/lon). This stops a
// neighbouring field from bleeding in — e.g. KNZY (North Island, 18/36) next to KSAN (San Diego, 09/27).
// GET /.netlify/functions/airportgeo?lat=32.7336&lon=-117.1897&icao=KSAN   (or &bbox=w,s,e,n)
//   -> { runways:[{ref,c:[[lat,lon]...]}], taxiways:[{ref,c}], aprons:[{c}] }

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=5184000" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const q = event.queryStringParameters || {};
  const ICAO = (q.icao || "").toUpperCase().trim();
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);

  let W, S, E, N;
  if (q.bbox) { const b = q.bbox.split(",").map(Number); if (b.length === 4 && b.every(isFinite)) [W, S, E, N] = b; }
  if (W == null) {
    if (!isFinite(lat) || !isFinite(lon)) return J(400, { error: "need lat/lon or bbox" });
    W = lon - 0.04; E = lon + 0.04; S = lat - 0.03; N = lat + 0.03; }

  // Fetch the movement features AND the aerodrome polygons in the box (the latter used only to filter).
  const query = `[out:json][timeout:20];(way["aeroway"~"taxiway|runway|apron"](${S},${W},${N},${E});way["aeroway"="aerodrome"](${S},${W},${N},${E});relation["aeroway"="aerodrome"](${S},${W},${N},${E}););out tags geom;`;
  const MIRRORS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter","https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter","https://overpass.private.coffee/api/interpreter","https://overpass.osm.jp/api/interpreter"];

  const attempt = (url, ms) => {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal })
      .then(r => r.ok ? r.text() : Promise.reject(new Error("http " + r.status)))
      .then(txt => { if (txt && txt.charAt(0) === "{") return JSON.parse(txt); throw new Error("bad body"); })
      .finally(() => clearTimeout(to));
  };

  // Race all mirrors concurrently and take the first valid response. Sequential
  // fallback can't work inside Netlify's ~10s function budget: at 9s per attempt,
  // one hung mirror kills the whole function before the next is tried. Racing
  // fails over within a single budget no matter which subset of mirrors is down.
  let data = null;
  try { data = await Promise.any(MIRRORS.map(m => attempt(m, 9000))); } catch (e) { data = null; }
  if (!data) return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "overpass unavailable", runways: [], taxiways: [], aprons: [] }) };

  const r5 = c => [Math.round(c.lat * 1e5) / 1e5, Math.round(c.lon * 1e5) / 1e5];
  const centroid = geom => { let a = 0, b = 0; for (const p of geom) { a += p.lat; b += p.lon; } return [a / geom.length, b / geom.length]; };
  const d2 = (p, c) => { const dy = p[0] - c[0], dx = p[1] - c[1]; return dy * dy + dx * dx; };

  // Aerodromes present in the box (for the filter).
  const ads = [];
  for (const el of (data.elements || [])) {
    if (el.tags && el.tags.aeroway === "aerodrome" && el.geometry && el.geometry.length) {
      ads.push({ icao: (el.tags.icao || el.tags.faa || el.tags.iata || "").toUpperCase(), c: centroid(el.geometry), ring: el.geometry.map(p => [p.lat, p.lon]) });
    }
  }
  // Target aerodrome: ICAO match if given, else the one nearest the requested point.
  let target = null;
  if (ICAO) target = ads.find(a => a.icao === ICAO) || null;
  if (!target && ads.length && isFinite(lat) && isFinite(lon)) {
    let bd = Infinity; for (const a of ads) { const dd = d2([lat, lon], a.c); if (dd < bd) { bd = dd; target = a; } }
  }
  const nearestAd = pt => { let best = null, bd = Infinity; for (const a of ads) { const dd = d2(pt, a.c); if (dd < bd) { bd = dd; best = a; } } return best; };
  // Ray-casting point-in-polygon (pt=[lat,lon], ring=[[lat,lon]...]).
  const pip = (pt, ring) => { let inside = false; const y = pt[0], x = pt[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    } return inside; };
  // Keep a feature only if its midpoint is INSIDE the target aerodrome boundary — excludes detached helipads and
  // neighbouring fields even when they're the closest aerodrome. No usable ring -> nearest-aerodrome; none -> keep all.
  const keep = geom => { if (!ads.length) return true; const m = geom[Math.floor(geom.length / 2)], pt = [m.lat, m.lon];
    if (target && target.ring && target.ring.length >= 3) return pip(pt, target.ring);
    if (target) return nearestAd(pt) === target;
    return true; };

  const runways = [], taxiways = [], aprons = [];
  for (const el of (data.elements || [])) {
    if (!el.geometry || !el.tags) continue;
    const aw = el.tags.aeroway;
    if (aw === "aerodrome") continue;                 // polygons are for filtering only
    if (!keep(el.geometry)) continue;                 // drop neighbouring-field features
    const g = el.geometry.map(r5), ref = el.tags.ref || el.tags.name || "";
    if (aw === "runway") runways.push({ ref, c: g });
    else if (aw === "taxiway") taxiways.push({ ref, c: g });
    else if (aw === "apron") aprons.push({ c: g });
  }
  return J(200, { runways, taxiways, aprons });
};
