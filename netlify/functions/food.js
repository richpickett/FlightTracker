// Personal Wings — nearby-food proxy via OpenStreetMap Overpass (Netlify Function)
// Runs the Overpass query server-side (reliable, no browser CORS / rate-limit issues).
// Call: /.netlify/functions/food?lat=32.8157&lon=-117.14&r=4000
const EPS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=3600" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const r = Math.min(parseInt(q.r || "4000", 10) || 4000, 8000);
  if (isNaN(lat) || isNaN(lon)) return { statusCode: 400, headers: CORS, body: '{"places":[]}' };
  const ql = '[out:json][timeout:25];(nwr["amenity"~"^(restaurant|cafe|fast_food|pub|bar|biergarten|food_court)$"](around:' + r + ',' + lat + ',' + lon + '););out center 80;';
  for (const ep of EPS) {
    try {
      const resp = await fetch(ep, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(ql) });
      if (!resp.ok) continue;
      const j = await resp.json();
      const places = (j.elements || []).map(e => {
        const la = e.lat != null ? e.lat : (e.center && e.center.lat);
        const lo = e.lon != null ? e.lon : (e.center && e.center.lon);
        const t = e.tags || {};
        return (t.name && la != null) ? { name: t.name, amenity: t.amenity || "restaurant", cuisine: t.cuisine || "", lat: la, lon: lo } : null;
      }).filter(Boolean);
      return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ places }) };
    } catch (e) { /* try next mirror */ }
  }
  return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: '{"places":[],"error":"overpass unavailable"}' };
};
