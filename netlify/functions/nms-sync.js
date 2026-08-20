// Personal Wings — sync FAA NMS NOTAMs into the Supabase mirror (public.notam).
// NMS is a mirror-and-sync feed (rate-limited), so we maintain a local copy and the app
// reads from it. This worker runs the two sync modes:
//   ?mode=bulk         full refresh — pull each classification, upsert, prune stale rows (daily)
//   ?mode=incremental  delta since the watermark — upsert changes (every few minutes; default)
//   ?mode=status       counts + sync state (no writes)
//
// Env: NMS_HOST, NMS_CLIENT_ID, NMS_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE.
// Guard: NMS_SYNC_KEY — callers must pass &key=<NMS_SYNC_KEY> (keeps the endpoint private).
// Classifications: NMS_CLASSES (default "DOMESTIC,INTERNATIONAL,FDC").

const NMS_HOST = process.env.NMS_HOST || "https://api-staging.cgifederal-aim.com";
const CID = process.env.NMS_CLIENT_ID, CSECRET = process.env.NMS_CLIENT_SECRET;
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE;
const SYNC_KEY = process.env.NMS_SYNC_KEY;
// US-only mirror. Pull all three classifications (US airports issue NOTAMs across DOMESTIC and
// INTERNATIONAL — the intl set carries real closures the domestic set lacks) but keep only US-location
// rows. Non-US airports are served by SkyLink at read time, not mirrored.
const CLASSES = (process.env.NMS_CLASSES || "DOMESTIC,INTERNATIONAL,FDC").split(",").map(s => s.trim()).filter(Boolean);
// US ICAO prefixes: K (CONUS) · P[A/F/G/H/K/L/M/O/P/W] (Alaska/Hawaii/Pacific) · TI/TJ (USVI/PR).
function isUS(icao) { icao = (icao || "").toUpperCase(); return /^K[A-Z]{3}$/.test(icao) || /^P[AFGHKLMOPW][A-Z]{2}$/.test(icao) || /^T[IJ][A-Z]{2}$/.test(icao); }

// ---- NMS auth (token cached across warm invocations) ----
// Transient-failure retry. NMS sits behind an edge/WAF that intermittently 403s
// requests from shared CI IPs (GitHub Actions), and can also 429/5xx under load.
// Those are not credential problems — a short backoff clears them. Retryable =
// 403/408/429/5xx or a network error; 4xx auth errors (401) are NOT retried.
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isTransient(err) {
  const m = String((err && err.message) || err);
  return /\b(403|408|429|500|502|503|504)\b/.test(m) || /Forbidden|Too Many|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket hang/i.test(m);
}
async function withRetry(fn, label) {
  const backoff = [1500, 4000, 9000];   // 3 retries after the first try
  let last;
  for (let i = 0; i <= backoff.length; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i === backoff.length || !isTransient(e)) throw e;
      console.error("nms-sync retry " + (i + 1) + "/" + backoff.length + " (" + label + "): " + String(e.message || e).slice(0, 120));
      await sleep(backoff[i]);
    }
  }
  throw last;
}

let _tok = null, _exp = 0;
async function token() {
  const now = Date.now();
  if (_tok && now < _exp - 60000) return _tok;
  const auth = Buffer.from(CID + ":" + CSECRET).toString("base64");
  return withRetry(async () => {
    const r = await fetch(NMS_HOST + "/v1/auth/token", {
      method: "POST",
      headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    const t = await r.text();
    if (!r.ok) throw new Error("token " + r.status + ": " + t.slice(0, 160));
    const j = JSON.parse(t);
    _tok = j.access_token; _exp = Date.now() + (parseInt(j.expires_in || "1799", 10) * 1000);
    return _tok;
  }, "token");
}
const zlib = require("zlib");
async function nmsGet(path) {
  return withRetry(async () => {
  const t = await token();
  const r = await fetch(NMS_HOST + path, { headers: { Authorization: "Bearer " + t, nmsResponseFormat: "GEOJSON", Accept: "application/json" } });
  let buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) { if (r.status === 401) { _tok = null; _exp = 0; } throw new Error("nms " + r.status + " " + path + ": " + buf.toString("utf8").slice(0, 200)); }
  // Bulk/classification pulls return a gzipped file (not inline JSON) — decompress if gzip-magic present.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch (e) {} }
  const txt = buf.toString("utf8");
  try { return JSON.parse(txt); } catch (e) { throw new Error("nms non-json " + path + " ct=" + (r.headers.get("content-type") || "?") + " first=" + JSON.stringify(txt.slice(0, 140))); }
  }, "nms " + path);
}
// Feature list can arrive as {data:{geojson:[]}}, a FeatureCollection {features:[]}, or a bare array.
function featuresFrom(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (d.data && Array.isArray(d.data.geojson)) return d.data.geojson;
  if (Array.isArray(d.features)) return d.features;
  if (d.data && Array.isArray(d.data.features)) return d.data.features;
  return [];
}

// ---- normalize an NMS GeoJSON feature -> mirror row ----
function isoOrNull(s) { return (typeof s === "string" && /^\d{4}-\d\d-\d\dT/.test(s)) ? s : null; }
function normalize(feature) {
  const cd = (feature.properties && feature.properties.coreNOTAMData) || {};
  const n = cd.notam || {};
  let translation = "";
  const tr = cd.notamTranslation;
  if (Array.isArray(tr)) { const icao = tr.find(x => x && x.type === "ICAO") || tr.find(x => x && (x.formattedText || x.simpleText)); translation = icao ? (icao.formattedText || icao.simpleText || "") : ""; }
  else if (tr) translation = tr.formattedText || tr.simpleText || "";
  const q = (n.selectionCode || "").toUpperCase();
  return {
    id: n.id, number: n.number || null, location: n.location || null, icao_location: n.icaoLocation || null,
    classification: n.classification || null,
    q_code: q || null, q_subject: q.length >= 3 ? q.slice(1, 3) : null, q_condition: q.length >= 5 ? q.slice(3, 5) : null,
    ntype: n.type || null, text: n.text || null, translation: translation || null,
    effective_start: isoOrNull(n.effectiveStart), effective_end: isoOrNull(n.effectiveEnd),
    issued: isoOrNull(n.issued), last_updated: isoOrNull(n.lastUpdated),
    geometry: feature.geometry || null
  };
}

// ---- Supabase (PostgREST via service role) ----
const SBH = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
async function sbUpsert(rows, stamp) {
  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map(r => ({ ...r, synced_at: stamp }));
    const r = await fetch(SB_URL + "/rest/v1/notam", {
      method: "POST",
      headers: { ...SBH, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk)
    });
    if (!r.ok) throw new Error("sb upsert " + r.status + ": " + (await r.text()).slice(0, 200));
    done += chunk.length;
  }
  return done;
}
async function sbGetState() {
  const r = await fetch(SB_URL + "/rest/v1/notam_sync?id=eq.state&select=*", { headers: SBH });
  const a = r.ok ? await r.json() : [];
  return (Array.isArray(a) && a[0]) || {};
}
async function sbSetState(patch) {
  await fetch(SB_URL + "/rest/v1/notam_sync?id=eq.state", {
    method: "PATCH", headers: { ...SBH, Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}
async function sbPruneOlderThan(stamp) {
  const r = await fetch(SB_URL + "/rest/v1/notam?synced_at=lt." + encodeURIComponent(stamp), { method: "DELETE", headers: { ...SBH, Prefer: "return=minimal" } });
  if (!r.ok) throw new Error("sb prune " + r.status);
}
async function sbCount() {
  const r = await fetch(SB_URL + "/rest/v1/notam?select=id", { method: "HEAD", headers: { ...SBH, Prefer: "count=exact", Range: "0-0" } });
  const cr = r.headers.get("content-range") || "";
  return cr.split("/")[1] || "?";
}
function maxIso(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }

// ---- modes ----
async function bulk() {
  const stamp = new Date().toISOString();
  let total = 0, watermark = null;
  const per = {};
  for (const cls of CLASSES) {
    const d = await nmsGet("/nmsapi/v1/notams?classification=" + encodeURIComponent(cls));
    const rows = featuresFrom(d).map(normalize).filter(r => r.id && isUS(r.icao_location));
    await sbUpsert(rows, stamp);
    for (const r of rows) watermark = maxIso(watermark, r.last_updated);
    per[cls] = rows.length; total += rows.length;
  }
  await sbPruneOlderThan(stamp);               // drop NOTAMs not present in this full refresh
  await sbSetState({ last_bulk: stamp, last_sync: watermark, note: "bulk " + total });
  return { mode: "bulk", total, per, watermark };
}
async function probe(only) {
  const list = only ? [only.toUpperCase()] : CLASSES;
  const per = {};
  for (const cls of list) {
    const d = await nmsGet("/nmsapi/v1/notams?classification=" + encodeURIComponent(cls));
    const feats = featuresFrom(d);
    per[cls] = { features: feats.length, approxBytes: JSON.stringify(d).length };
  }
  return { mode: "probe", per };
}
async function incremental() {
  const st = await sbGetState();
  const MAXBACK = 23 * 3600 * 1000;           // NMS rejects lastUpdatedDate older than 24h
  let since = st.last_sync || new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const floor = new Date(Date.now() - MAXBACK).toISOString();
  if (since < floor) since = floor;
  const d = await nmsGet("/nmsapi/v1/notams?lastUpdatedDate=" + encodeURIComponent(since));
  const rows = featuresFrom(d).map(normalize).filter(r => r.id && isUS(r.icao_location));
  const stamp = new Date().toISOString();
  if (rows.length) await sbUpsert(rows, stamp);
  let watermark = since;
  for (const r of rows) watermark = maxIso(watermark, r.last_updated);
  await sbSetState({ last_sync: watermark, note: "incr " + rows.length });
  return { mode: "incremental", since, changed: rows.length, watermark };
}

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const J = (c, o) => ({ statusCode: c, headers: H, body: JSON.stringify(o, null, 1) });
  const q = (event && event.queryStringParameters) || {};
  if (!CID || !CSECRET) return J(200, { error: "NMS creds not set" });
  if (!SB_URL || !SB_KEY) return J(200, { error: "Supabase env not set" });
  // Guard: HTTP callers must present the key. (A scheduled invocation with no key is allowed.)
  const scheduled = !event.httpMethod;
  if (!scheduled && SYNC_KEY && q.key !== SYNC_KEY) return J(403, { error: "forbidden" });
  const mode = (q.mode || "incremental").toLowerCase();
  try {
    if (mode === "status") return J(200, { mode: "status", rows: await sbCount(), state: await sbGetState(), classes: CLASSES, host: NMS_HOST });
    if (mode === "airport") {
      const icao = (q.icao || "").toUpperCase();
      const r = await fetch(SB_URL + "/rest/v1/notam?icao_location=eq." + encodeURIComponent(icao) + "&select=number,q_code,q_subject,q_condition,text,effective_end,geometry", { headers: SBH });
      const rows = r.ok ? await r.json() : [];
      const clsd = rows.filter(x => /^M[RXN]$/.test(x.q_subject || "") && (x.q_condition === "LC" || x.q_condition === "LT"));
      return J(200, { icao, total: rows.length, closures: clsd.length, sample: clsd.slice(0, 6).map(c => ({ q: c.q_code, geom: c.geometry && c.geometry.type, txt: (c.text || "").slice(0, 70) })) });
    }
    if (mode === "probe") return J(200, await probe(q.class));
    if (mode === "bulk") return J(200, await bulk());
    return J(200, await incremental());
  } catch (e) {
    return J(200, { error: String(e.message || e), mode });
  }
};

// CLI entry so the same file runs in a GitHub Action:  node nms-sync.js <bulk|incremental|status>
if (require.main === module) {
  const mode = (process.argv[2] || "incremental").toLowerCase();
  (async () => {
    try {
      let out;
      if (mode === "bulk") out = await bulk();
      else if (mode === "status") out = { rows: await sbCount(), state: await sbGetState() };
      else out = await incremental();
      console.log(JSON.stringify(out));
      process.exit(0);
    } catch (e) {
      console.error("nms-sync error:", e.message || e);
      // Incremental runs every N minutes and reads fall back to SkyLink if the mirror
      // goes briefly stale — so a transient edge/WAF blip (403/429/5xx) that survived the
      // in-run retries is a soft skip, NOT a job failure (avoids noise notices). The next
      // run catches up. Bulk (daily) and any non-transient error still fail loudly.
      if (mode !== "bulk" && isTransient(e)) { console.error("nms-sync: transient failure on '" + mode + "' — skipping this run, next run will catch up."); process.exit(0); }
      process.exit(1);
    }
  })();
}
