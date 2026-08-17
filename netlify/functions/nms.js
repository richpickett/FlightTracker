// Personal Wings — FAA NMS-API (NOTAM Management System) spike.
// Evaluates replacing the free-text SkyLink NOTAM source with NMS structured GeoJSON.
// Fetches a bearer token (OAuth2 client_credentials) and pulls NOTAMs for one airport.
//
// Credentials come ONLY from env vars (never hardcoded/committed):
//   NMS_CLIENT_ID      = the "KEY" value from the FAA onboarding spreadsheet
//   NMS_CLIENT_SECRET  = the "SECRET" value
//   NMS_HOST           = optional override (default: staging)
//
// GET /.netlify/functions/nms?icao=KSFO         -> summary: features by type + closure list
// GET /.netlify/functions/nms?icao=KSFO&raw=1   -> full GeoJSON passthrough (ground truth)
// GET /.netlify/functions/nms?ping=1            -> auth check only (no NOTAM query)

const HOST = process.env.NMS_HOST || "https://api-staging.cgifederal-aim.com";
const CID = process.env.NMS_CLIENT_ID;
const CSECRET = process.env.NMS_CLIENT_SECRET;

let _tok = null, _tokExp = 0; // module-level token cache — reused across warm invocations (~30 min)

async function token() {
  const now = Date.now();
  if (_tok && now < _tokExp - 60000) return _tok;
  const auth = Buffer.from(CID + ":" + CSECRET).toString("base64");
  const r = await fetch(HOST + "/v1/auth/token", {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("token " + r.status + ": " + txt.slice(0, 200));
  const j = JSON.parse(txt);
  _tok = j.access_token;
  _tokExp = now + (parseInt(j.expires_in || "1799", 10) * 1000);
  return _tok;
}

exports.handler = async (event) => {
  const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
  const J = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o, null, 1) });
  const q = event.queryStringParameters || {};
  if (!CID || !CSECRET) return J({ error: "NMS creds not configured — set NMS_CLIENT_ID and NMS_CLIENT_SECRET on the Netlify site." });

  try {
    const t = await token();
    if (q.ping) return J({ ok: true, tokenLen: t ? t.length : 0, note: "auth succeeded" });

    const icao = (q.icao || q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!icao) return J({ error: "missing icao" });

    const url = HOST + "/nmsapi/v1/notams?location=" + encodeURIComponent(icao);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + t, nmsResponseFormat: "GEOJSON", Accept: "application/json" } });
    const txt = await r.text();
    if (!r.ok) return J({ error: "nms " + r.status, detail: txt.slice(0, 400) });

    let data;
    try { data = JSON.parse(txt); } catch (e) { return J({ error: "non-json response", detail: txt.slice(0, 400) }); }
    if (q.raw) return { statusCode: 200, headers: H, body: JSON.stringify(data) };

    // Best-effort summary (property names confirmed against &raw=1). Groups by NOTAM feature
    // type and lists anything that looks like a RWY/TWY closure, noting whether geometry is present.
    const feats = data.features || (data.data && data.data.features) || (Array.isArray(data) ? data : []);
    const byFeature = {};
    const closures = [];
    for (const f of feats) {
      const p = (f && f.properties) || {};
      const feature = p.feature || p.notamFeature || p.featureType || "?";
      byFeature[feature] = (byFeature[feature] || 0) + 1;
      const text = p.text || p.notamText || p.traditionalMessage || p.message || "";
      const geom = f && f.geometry ? f.geometry.type : null;
      if (/RWY|TWY/i.test(String(feature)) || /\bCLSD\b/i.test(String(text))) {
        closures.push({ feature, number: p.number || p.notamNumber, geometry: geom, text: String(text).slice(0, 220) });
      }
    }
    return J({ icao, total: feats.length, byFeature, closureCount: closures.length, closures });
  } catch (e) {
    return J({ error: String(e.message || e) });
  }
};
