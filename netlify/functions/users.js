// Personal Wings — user administration (Netlify Function)
//
// Auth: caller must send Authorization: Bearer <supabase access_token> for a user
// whose profiles.is_admin = true.  POST /.netlify/functions/users
//   { "action": "list" }                          -> { users:[{id,name,email,created_at,routes,is_admin}], total }
//   { "action": "delete", "id": "<uuid>" }         -> { ok:true }   (cascades profile + routes)
//   { "action": "setAdmin", "id": "<uuid>", "value": true|false } -> { ok:true }
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE (secret), optional SUPABASE_ANON_KEY

const DEF_URL = "https://dbkbigxeabzfzoqommtf.supabase.co";
const DEF_ANON = "sb_publishable_7BOSD_FB87NfHvyo78gD9g_fYpWfhIX";
const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(obj),
});
function base() { return (process.env.SUPABASE_URL || DEF_URL).replace(/\/$/, ""); }
function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE not set");
  return { apikey: key, Authorization: /^ey/.test(key) ? "Bearer " + key : key };
}

// Validate the caller's login token and confirm they are an admin.
async function verifyAdmin(event) {
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const anon = process.env.SUPABASE_ANON_KEY || DEF_ANON;
  const ur = await fetch(base() + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
  if (!ur.ok) return null;
  const u = await ur.json(); if (!u || !u.id) return null;
  const pr = await fetch(base() + "/rest/v1/profiles?select=is_admin&id=eq." + u.id, { headers: sbHeaders() });
  if (!pr.ok) return null;
  const rows = await pr.json();
  return (rows[0] && rows[0].is_admin === true) ? u : null;
}

async function listUsers() {
  const h = sbHeaders();
  const [pr, rt] = await Promise.all([
    fetch(base() + "/rest/v1/profiles?select=id,name,email,created_at,is_admin&order=created_at.desc", { headers: h }),
    fetch(base() + "/rest/v1/routes?select=user_id", { headers: h }),
  ]);
  if (!pr.ok) throw new Error("profiles read failed (" + pr.status + "): " + (await pr.text()).slice(0, 160));
  const profiles = await pr.json();
  const counts = {};
  if (rt.ok) (await rt.json()).forEach(r => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
  return profiles.map(p => ({ id: p.id, name: p.name || "", email: p.email || "", created_at: p.created_at, routes: counts[p.id] || 0, is_admin: !!p.is_admin }));
}

async function deleteUser(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("bad user id");
  const r = await fetch(base() + "/auth/v1/admin/users/" + id, { method: "DELETE", headers: sbHeaders() });
  if (!r.ok && r.status !== 200 && r.status !== 204)
    throw new Error("delete failed (" + r.status + "): " + (await r.text()).slice(0, 160));
  return true;
}

async function setAdmin(id, value) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("bad user id");
  const r = await fetch(base() + "/rest/v1/profiles?id=eq." + id, {
    method: "PATCH",
    headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ is_admin: !!value }),
  });
  if (!r.ok) throw new Error("update failed (" + r.status + "): " + (await r.text()).slice(0, 160));
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization" } };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let admin;
  try { admin = await verifyAdmin(event); } catch (e) { return json(500, { error: String(e.message || e) }); }
  if (!admin) return json(401, { error: "unauthorized — sign in with an admin account" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad JSON" }); }
  try {
    if (body.action === "list") { const users = await listUsers(); return json(200, { users, total: users.length }); }
    if (body.action === "delete") {
      if (body.id === admin.id) return json(400, { error: "you can't delete your own account here" });
      await deleteUser(body.id); return json(200, { ok: true });
    }
    if (body.action === "setAdmin") {
      if (body.id === admin.id && body.value === false) return json(400, { error: "you can't remove your own admin rights" });
      await setAdmin(body.id, body.value); return json(200, { ok: true });
    }
    return json(400, { error: "unknown action" });
  } catch (e) { return json(500, { error: String(e.message || e) }); }
};
