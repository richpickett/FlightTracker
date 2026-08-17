// Personal Wings — FAA Preferred Routes lookup (bundled NASR PFR data).
// GET /.netlify/functions/prefroutes?dep=KPDX&arr=KMSO  ->  { dep, arr, count, routes:[{t,cat,r,alt,ac,hrs}] }
// cat: hi = high-altitude (jet) · lo = low-altitude / TEC (piston / turboprop).
const DB = require("./prefroutes-data.js");

function norm(s){ s = (s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); if (s.length === 4 && s[0] === "K") s = s.slice(1); return s; }

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const hdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" };
  const q = event.queryStringParameters || {};
  const dep = norm(q.dep), arr = norm(q.arr);
  if (!dep || !arr) return { statusCode: 400, headers: hdr, body: '{"error":"need dep and arr"}' };
  const routes = DB[dep + "-" + arr] || [];
  return { statusCode: 200, headers: hdr, body: JSON.stringify({ dep, arr, count: routes.length, routes }) };
};
