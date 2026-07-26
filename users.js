// Personal Wings — user administration (Netlify Function)
//
// POST /.netlify/functions/users   headers: { "x-admin-key": <ADMIN_KEY>, "content-type": "application/json" }
//   { "action": "list" }                       -> { users:[{id,name,email,created_at,routes}], total }
//   { "action": "delete", "id": "<uuid>" }      -> { ok:true }  (cascades profile + routes via FK)
//
// Env vars (same as notify.js): ADMIN_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE

const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(obj),
});

function base() { return (process.env.SUPABASE_URL || "https://dbkbigxeabzfzoqommtf.supabase.co").replace(/\/$/, ""); }
function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE not set");
  // Legacy service_role keys are JWTs (start "ey") -> Bearer; new sb_secret keys -> Authorization must equal apikey.
  return { apikey: key, Authorization: /^ey/.test(key) ? "Bearer " + key : key };
}

async function listUsers() {
  const h = sbHeaders();
  const [pr, rt] = await Promise.all([
    fetch(base() + "/rest/v1/profiles?select=id,name,email,created_at&order=created_at.desc", { headers: h }),
    fetch(base() + "/rest/v1/routes?select=user_id", { headers: h }),
  ]);
  if (!pr.ok) throw new Error("profiles read failed (" + pr.status + "): " + (await pr.text()).slice(0, 160));
  const profiles = await pr.json();
  const counts = {};
  if (rt.ok) (await rt.json()).forEach(r => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
  return profiles.map(p => ({ id: p.id, name: p.name || "", email: p.email || "", created_at: p.created_at, routes: counts[p.id] || 0 }));
}

async function deleteUser(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("bad user id");
  const r = await fetch(base() + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: sbHeaders() });
  if (!r.ok && r.status !== 200 && r.status !== 204)
    throw new Error("delete failed (" + r.status + "): " + (await r.text()).slice(0, 160));
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,x-admin-key" } };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!process.env.ADMIN_KEY || (event.headers["x-admin-key"] || event.headers["X-Admin-Key"]) !== process.env.ADMIN_KEY)
    return json(401, { error: "unauthorized" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad JSON" }); }
  try {
    if (body.action === "list") { const users = await listUsers(); return json(200, { users, total: users.length }); }
    if (body.action === "delete") { await deleteUser(body.id); return json(200, { ok: true }); }
    return json(400, { error: "unknown action" });
  } catch (e) { return json(500, { error: String(e.message || e) }); }
};
