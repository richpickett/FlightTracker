// Personal Wings — feedback / issue collection (Netlify Function)
//
// POST /.netlify/functions/feedback
//   Submit (any visitor, no auth required):
//     { "message": "...", "kind": "bug|idea|other", "email": "you@x.com" (optional),
//       "app": "ft|suite", "context": { route, reg, url } (optional) }
//     -> inserts a row in Supabase `feedback` AND emails FEEDBACK_TO via Postmark. Returns { ok:true, id }.
//   Admin (Authorization: Bearer <supabase session token>, profiles.is_admin = true):
//     { "action": "list", "status": "open|closed|all" }         -> { items:[...] }
//     { "action": "setStatus", "id": "<uuid>", "status": "closed" } -> { ok:true }
//
// Env (Netlify → Environment variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE (secret), SUPABASE_ANON_KEY
//   POSTMARK_TOKEN, POSTMARK_FROM (verified sender), FEEDBACK_TO (recipient; falls back to POSTMARK_FROM)

const DEF_URL = "https://dbkbigxeabzfzoqommtf.supabase.co";
const DEF_ANON = "sb_publishable_7BOSD_FB87NfHvyo78gD9g_fYpWfhIX";
const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" },
  body: JSON.stringify(obj),
});
function esc(s) { return String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
function base() { return (process.env.SUPABASE_URL || DEF_URL).replace(/\/$/, ""); }
// New secret keys (sb_secret_…) are not JWTs; PostgREST wants Authorization == apikey (no "Bearer"). Legacy keys start with "ey".
function svcHeaders() { const key = process.env.SUPABASE_SERVICE_ROLE || ""; return { apikey: key, Authorization: /^ey/.test(key) ? "Bearer " + key : key, "Content-Type": "application/json" }; }

async function verifyAdmin(event) {
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const token = auth.replace(/^Bearer\s+/i, ""); if (!token) return null;
  const anon = process.env.SUPABASE_ANON_KEY || DEF_ANON;
  const ur = await fetch(base() + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
  if (!ur.ok) return null;
  const u = await ur.json(); if (!u || !u.id) return null;
  const pr = await fetch(base() + "/rest/v1/profiles?select=is_admin&id=eq." + u.id, { headers: svcHeaders() });
  if (!pr.ok) return null;
  const rows = await pr.json();
  return (rows[0] && rows[0].is_admin === true) ? u : null;
}
// Resolve the signed-in user (if any) from the bearer token — feedback submit is open, but we attribute it when we can.
async function currentUser(event) {
  try {
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, ""); if (!token) return null;
    const anon = process.env.SUPABASE_ANON_KEY || DEF_ANON;
    const ur = await fetch(base() + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
    if (!ur.ok) return null;
    const u = await ur.json(); return (u && u.id) ? u : null;
  } catch (e) { return null; }
}

async function emailAdmin(row) {
  const token = process.env.POSTMARK_TOKEN, from = process.env.POSTMARK_FROM;
  if (!token || !from) return { skipped: "postmark not configured" };
  const to = process.env.FEEDBACK_TO || from;   // no hardcoded address (Netlify secrets scanning) — set FEEDBACK_TO in env
  const kind = (row.kind || "other").toUpperCase();
  const ctx = row.context || {};
  const lines = [
    "Kind: " + kind,
    "From: " + (row.email || "(anonymous)") + (row.user_id ? " [user " + row.user_id + "]" : ""),
    "App: " + (row.app || "?"),
    ctx.reg ? "Tail: " + ctx.reg : "",
    ctx.route ? "Route: " + ctx.route : "",
    ctx.url ? "URL: " + ctx.url : "",
    "", row.message || "",
  ].filter(Boolean);
  const html = '<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,system-ui,sans-serif;color:#1a2230;max-width:600px">' +
    '<div style="border-bottom:3px solid #0b3d91;padding-bottom:8px;margin-bottom:14px;font-weight:800;letter-spacing:1px;color:#0b3d91">PERSONAL WINGS · FEEDBACK</div>' +
    '<table style="font-size:14px;border-collapse:collapse">' +
    ['kind:' + kind, 'from:' + (row.email || '(anonymous)'), 'app:' + (row.app || '?'),
      ctx.reg ? 'tail:' + esc(ctx.reg) : '', ctx.route ? 'route:' + esc(ctx.route) : '', ctx.url ? 'url:' + esc(ctx.url) : '']
      .filter(Boolean).map(s => { const i = s.indexOf(':'); return '<tr><td style="color:#8a97a6;padding:2px 10px 2px 0;vertical-align:top">' + esc(s.slice(0, i)) + '</td><td>' + esc(s.slice(i + 1)) + '</td></tr>'; }).join('') +
    '</table>' +
    '<p style="margin:16px 0 0;line-height:1.5;white-space:pre-wrap;border-top:1px solid #e5e9ee;padding-top:12px">' + esc(row.message || "") + '</p></div>';
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({
      From: from, To: to, ReplyTo: row.email || undefined,
      Subject: "[PW feedback] " + kind + " — " + (row.message || "").replace(/\s+/g, " ").slice(0, 60),
      TextBody: lines.join("\n"), HtmlBody: html,
      MessageStream: process.env.POSTMARK_STREAM_TX || "outbound",
    }),
  });
  return { ok: r.ok, status: r.status };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad json" }); }

  // ---- admin actions ----
  if (body.action === "list" || body.action === "setStatus") {
    let admin; try { admin = await verifyAdmin(event); } catch (e) { return json(500, { error: String(e.message || e) }); }
    if (!admin) return json(401, { error: "unauthorized — sign in with an admin account" });
    if (body.action === "list") {
      const st = body.status || "open";
      const flt = (st === "all") ? "" : "&status=eq." + encodeURIComponent(st);
      const r = await fetch(base() + "/rest/v1/feedback?select=*&order=created_at.desc&limit=500" + flt, { headers: svcHeaders() });
      if (!r.ok) return json(500, { error: "read failed " + r.status, detail: (await r.text()).slice(0, 200) });
      return json(200, { items: await r.json() });
    }
    if (body.action === "setStatus") {
      if (!body.id) return json(400, { error: "missing id" });
      const r = await fetch(base() + "/rest/v1/feedback?id=eq." + encodeURIComponent(body.id), {
        method: "PATCH", headers: { ...svcHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ status: body.status === "closed" ? "closed" : "open" }),
      });
      if (!r.ok) return json(500, { error: "update failed " + r.status });
      return json(200, { ok: true });
    }
  }

  // ---- submit (open to any visitor) ----
  const msg = String(body.message || "").trim();
  if (!msg) return json(400, { error: "message is required" });
  if (msg.length > 8000) return json(400, { error: "message too long" });
  const u = await currentUser(event);
  const row = {
    user_id: u ? u.id : null,
    email: (body.email || (u && u.email) || "").trim().toLowerCase().slice(0, 200) || null,
    app: /^(ft|suite)$/.test(body.app) ? body.app : null,
    kind: /^(bug|idea|other)$/.test(body.kind) ? body.kind : "other",
    message: msg,
    context: (body.context && typeof body.context === "object") ? body.context : null,
  };
  if (!process.env.SUPABASE_SERVICE_ROLE) return json(200, { ok: false, error: "not configured" });
  const ins = await fetch(base() + "/rest/v1/feedback", {
    method: "POST", headers: { ...svcHeaders(), Prefer: "return=representation" }, body: JSON.stringify(row),
  });
  if (!ins.ok) return json(500, { error: "insert failed " + ins.status, detail: (await ins.text()).slice(0, 200) });
  const saved = (await ins.json())[0] || {};
  let mail = null; try { mail = await emailAdmin({ ...row, ...saved }); } catch (e) { mail = { error: String(e.message || e) }; }
  return json(200, { ok: true, id: saved.id || null, mail });
};
