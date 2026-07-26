// Personal Wings — NOTAM proxy via autorouter.aero (Netlify Function)
// autorouter API (free for GA). Your account must be enabled for API access
// (request it via a support ticket on autorouter.aero).
// Env vars (Netlify): AUTOROUTER_USER (account email), AUTOROUTER_PASS (account password)
// Call: /.netlify/functions/notam?id=KDEN

const TOKEN_URL = "https://api.autorouter.aero/v1.0/oauth2/token";
const NOTAM_URL = "https://api.autorouter.aero/v1.0/notam";
const PERM_SECONDS = 4102444800; // ~year 2100 — autorouter uses 2^32-1 for "permanent"

// Cache the bearer token across warm invocations (tokens last ~1h; max 20 per account).
let tok = { value: null, exp: 0 };

async function getToken(user, pass) {
  const now = Date.now();
  if (tok.value && now < tok.exp - 60000) return tok.value;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: user, client_secret: pass });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("auth " + r.status);
  const j = await r.json();
  tok = { value: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return tok.value;
}

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=600" };
  const send = (obj) => ({ statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const q = event.queryStringParameters || {};
  const id = (q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!id) return { statusCode: 400, headers: CORS, body: '{"error":"missing id"}' };

  const user = process.env.AUTOROUTER_USER, pass = process.env.AUTOROUTER_PASS;
  if (!user || !pass) return send({ id, configured: false, notams: [] });

  // autorouter keys NOTAMs by ICAO location (Item A). Only 4-letter ICAO codes apply.
  if (!/^[A-Z]{4}$/.test(id)) return send({ id, configured: true, total: 0, notams: [], note: "no ICAO" });

  try {
    const token = await getToken(user, pass);
    const url = NOTAM_URL + "?itemas=" + encodeURIComponent(JSON.stringify([id])) + "&offset=0&limit=50";
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (!r.ok) return send({ id, error: "autorouter " + r.status, notams: [] });
    const data = await r.json();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const notams = rows.map((n) => {
      const num = (n.series || "") + (n.number != null ? n.number : "") + (n.year ? "/" + String(n.year).slice(-2) : "");
      const endPerm = n.endvalidity == null || n.endvalidity >= PERM_SECONDS;
      return {
        number: num.trim(),
        classification: "",
        start: n.startvalidity ? n.startvalidity * 1000 : "",
        end: endPerm ? "" : n.endvalidity * 1000,
        text: (n.iteme || "").trim(),
      };
    }).filter((x) => x.text);
    return send({ id, configured: true, total: data.total != null ? data.total : notams.length, notams });
  } catch (e) {
    return send({ id, error: String(e.message || e), notams: [] });
  }
};
