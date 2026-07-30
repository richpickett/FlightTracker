// Personal Wings — METAR proxy via aviationweather.gov (Netlify Function)
// Browsers can't call aviationweather.gov directly (no CORS); this adds it.
// Call: /.netlify/functions/metar?id=KMYF   (comma-separated ids allowed)
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=120" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const q = event.queryStringParameters || {};
  const id = (q.id || "").toUpperCase().replace(/[^A-Z0-9,]/g, "");
  if (!id) return { statusCode: 400, headers: CORS, body: "[]" };
  try {
    const r = await fetch("https://aviationweather.gov/api/data/metar?ids=" + encodeURIComponent(id) + "&format=json");
    const body = await r.text();
    return { statusCode: r.status, headers: { ...CORS, "Content-Type": "application/json" }, body: body || "[]" };
  } catch (e) {
    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: "[]" };
  }
};
