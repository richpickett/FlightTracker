// Personal Wings — nearby-food proxy via OpenStreetMap Overpass (Netlify Function)
// Runs Overpass server-side (no browser CORS). Overpass REQUIRES a descriptive
// User-Agent or it throttles/blocks — that was the missing piece.
// Call: /.netlify/functions/food?lat=32.8157&lon=-117.1396&r=1609
const EPS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];
const UA = "PersonalWings-FlightOps/1.0 (rich@personalwings.com)";
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=3600" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const r = Math.min(parseInt(q.r || "1609", 10) || 1609, 8000);   // default ~1 sm
  if (isNaN(lat) || isNaN(lon)) return { statusCode: 400, headers: CORS, body: '{"places":[]}' };
  const ql =
    "[out:json][timeout:60];(" +
    'node["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|biergarten)$"](around:' + r + "," + lat + "," + lon + ");" +
    'way["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|biergarten)$"](around:' + r + "," + lat + "," + lon + ");" +
    'relation["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|biergarten)$"](around:' + r + "," + lat + "," + lon + ");" +
    ");out center tags;";
  for (const ep of EPS) {
    try {
      const resp = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Accept: "application/json" },
        body: "data=" + encodeURIComponent(ql),
      });
      if (!resp.ok) continue;
      const j = await resp.json();
      const places = (j.elements || []).map(e => {
        const la = e.lat != null ? e.lat : (e.center && e.center.lat);
        const lo = e.lon != null ? e.lon : (e.center && e.center.lon);
        const t = e.tags || {};
        const name = t.name || t.brand;
        return (name && la != null) ? { name: name, amenity: t.amenity || "restaurant", cuisine: t.cuisine || "", lat: la, lon: lo } : null;
      }).filter(Boolean);
      return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ places }) };
    } catch (e) { /* try next mirror */ }
  }
  return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: '{"places":[],"error":"overpass unavailable"}' };
};
