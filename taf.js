// Personal Wings — metar-taf.com TAF proxy (Netlify Function)
// Set env var METARTAF_KEY in Netlify site settings. Call: /.netlify/functions/taf?id=KDEN
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=300" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const q = event.queryStringParameters || {};
  const id = (q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const type = q.type === "metar" ? "metar" : "taf";
  if (!id) return { statusCode: 400, headers: CORS, body: '{"error":"missing id"}' };
  const r = await fetch(`https://api.metar-taf.com/${type}?api_key=${process.env.METARTAF_KEY}&id=${id}`);
  const body = await r.text();
  return { statusCode: r.status, headers: { ...CORS, "Content-Type": "application/json" }, body };
};
