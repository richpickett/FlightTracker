// Personal Wings — user-notification blast via Postmark (Netlify Function)
//
// POST /.netlify/functions/notify
//   headers: { "x-admin-key": <ADMIN_KEY>, "content-type": "application/json" }
//   body:    { "subject": "...", "message": "plain text or basic HTML",
//              "test": "you@example.com"   // optional: send ONLY to this address }
//
// Env vars to set in Netlify (Site settings → Environment variables, all scopes):
//   ADMIN_KEY              — a long random string you choose (gate for this endpoint)
//   POSTMARK_TOKEN         — Postmark Server API Token
//   POSTMARK_FROM          — verified sender, e.g. no-reply@personalwings.com
//   POSTMARK_STREAM        — Postmark message stream id (default "broadcast")
//   SUPABASE_URL           — https://dbkbigxeabzfzoqommtf.supabase.co
//   SUPABASE_SERVICE_ROLE  — Supabase service_role key (server-only secret; bypasses RLS)

const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(obj),
});

function esc(s) { return String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

// Turn a plain-text message into simple, safe HTML (paragraphs + line breaks).
function toHtml(msg) {
  const paras = String(msg || "").trim().split(/\n{2,}/).map(p =>
    "<p style=\"margin:0 0 14px;line-height:1.5\">" + esc(p).replace(/\n/g, "<br>") + "</p>"
  ).join("");
  return '<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,system-ui,sans-serif;color:#1a2230;max-width:560px">' +
    '<div style="border-bottom:3px solid #0b3d91;padding-bottom:8px;margin-bottom:16px;font-weight:800;letter-spacing:1px;color:#0b3d91">PERSONAL WINGS</div>' +
    paras +
    '<p style="margin:22px 0 0;font-size:12px;color:#8a97a6">You\'re receiving this because you have a Personal Wings flight-ops account. ' +
    '<a href="{{{ pm:unsubscribe }}}" style="color:#8a97a6">Unsubscribe</a>.</p></div>';
}

async function getRecipients() {
  const url = (process.env.SUPABASE_URL || "https://dbkbigxeabzfzoqommtf.supabase.co").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE not set");
  // Legacy service_role keys are JWTs (start with "ey") and want "Bearer <jwt>".
  // New secret keys (sb_secret_...) are NOT JWTs; PostgREST requires the Authorization
  // header to equal the apikey header exactly — no "Bearer " prefix.
  const auth = /^ey/.test(key) ? "Bearer " + key : key;
  const r = await fetch(url + "/rest/v1/profiles?select=email,name", {
    headers: { apikey: key, Authorization: auth },
  });
  if (!r.ok) throw new Error("profiles read failed (" + r.status + "): " + (await r.text()).slice(0, 160) +
    " [key " + key.slice(0, 7) + "…, auth=" + (/^ey/.test(key) ? "bearer-jwt" : "apikey-equal") + "]");
  const rows = await r.json();
  // de-dupe + drop blanks
  const seen = {}, out = [];
  rows.forEach(row => { const e = (row.email || "").trim().toLowerCase();
    if (e && !seen[e]) { seen[e] = 1; out.push({ email: e, name: row.name || "" }); } });
  return out;
}

async function sendBatch(messages) {
  // Postmark batch endpoint: max 500 messages per call.
  const r = await fetch("https://api.postmarkapp.com/email/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json",
      "X-Postmark-Server-Token": process.env.POSTMARK_TOKEN },
    body: JSON.stringify(messages),
  });
  const results = await r.json().catch(() => []);
  return { status: r.status, results };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,x-admin-key" } };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  if (!process.env.ADMIN_KEY || (event.headers["x-admin-key"] || event.headers["X-Admin-Key"]) !== process.env.ADMIN_KEY)
    return json(401, { error: "unauthorized" });
  if (!process.env.POSTMARK_TOKEN || !process.env.POSTMARK_FROM)
    return json(500, { error: "POSTMARK_TOKEN / POSTMARK_FROM not configured" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad JSON" }); }
  const subject = (body.subject || "").trim();
  const message = (body.message || "").trim();
  if (!subject || !message) return json(400, { error: "subject and message are required" });

  const From = process.env.POSTMARK_FROM;
  // Test sends go through the transactional stream (approved first, no suppression surprises);
  // real blasts use the broadcast stream.
  const Stream = body.test ? (process.env.POSTMARK_TEST_STREAM || "outbound")
                           : (process.env.POSTMARK_STREAM || "broadcast");
  const HtmlBody = toHtml(message);
  const TextBody = message;

  // Dry run: read the user directory via the service role, report the count, send nothing.
  if (body.dryRun) {
    try {
      const recips = await getRecipients();
      return json(200, { dryRun: true, recipients: recips.length,
        sample: recips.slice(0, 3).map(r => r.email), sent: 0, failed: 0 });
    } catch (e) { return json(500, { error: String(e.message || e) }); }
  }

  // Test mode: send only to the given address (uses the same broadcast stream).
  let recipients;
  if (body.test) recipients = [{ email: String(body.test).trim().toLowerCase(), name: "" }];
  else {
    try { recipients = await getRecipients(); }
    catch (e) { return json(500, { error: String(e.message || e) }); }
  }
  if (!recipients.length) return json(200, { sent: 0, note: "no recipients found" });

  const mk = r => ({ From, To: r.email, Subject: subject, HtmlBody, TextBody, MessageStream: Stream });
  let sent = 0, failed = 0, errors = [];
  for (let i = 0; i < recipients.length; i += 500) {
    const chunk = recipients.slice(i, i + 500).map(mk);
    const { status, results } = await sendBatch(chunk);
    if (!Array.isArray(results)) { failed += chunk.length; errors.push("batch http " + status); continue; }
    results.forEach(res => { if (res.ErrorCode === 0) sent++; else { failed++; if (errors.length < 10) errors.push((res.To || "?") + ": " + res.Message); } });
  }
  return json(200, { recipients: recipients.length, sent, failed, test: !!body.test, errors });
};
