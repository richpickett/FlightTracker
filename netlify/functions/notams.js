// Personal Wings — unified NOTAM read path for the briefing + airport diagram.
// US airports: read from the Supabase NMS mirror (authoritative, structured — Q-codes + geometry).
// Non-US airports, or if the mirror is stale/unavailable: fall back to SkyLink (live).
// Domestic/international duplicates of the same NOTAM are collapsed.
//
// GET /.netlify/functions/notams?icao=KSFO
//  -> { icao, source, fresh, count, notams:[{number,classification,qCode,subject,condition,
//        text,translation,start,end,geometry,closed,conditional}] }

const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE;
const SBH = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
const STALE_MS = 60 * 60 * 1000;   // mirror considered stale if newest sync/bulk is older than this
const SITE = process.env.URL || "";  // Netlify site URL (for calling the SkyLink function)

function isUS(icao) { icao = (icao || "").toUpperCase(); return /^K[A-Z]{3}$/.test(icao) || /^P[AFGHKLMOPW][A-Z]{2}$/.test(icao) || /^T[IJ][A-Z]{2}$/.test(icao); }

// Collapse a NOTAM text for dedup: uppercase, drop a leading 3-letter location, squeeze whitespace.
function dedupKey(t) { return (t || "").toUpperCase().replace(/^[A-Z]{3,4}\s+/, "").replace(/\s+/g, " ").trim(); }

function classify(r) {
  const subj = r.q_subject || (r.q_code || "").slice(1, 3);
  const cond = r.q_condition || (r.q_code || "").slice(3, 5);
  const isMove = /^M[RXN]$/.test(subj);
  const closed = isMove && cond === "LC";
  const conditional = (isMove && cond === "LT") || /\bEXC\b|WINGSPAN/i.test(r.text || "");
  return { subject: subj || null, condition: cond || null, closed, conditional };
}

async function fromMirror(icao) {
  const sel = "number,classification,q_code,q_subject,q_condition,text,translation,effective_start,effective_end,geometry";
  const r = await fetch(SB_URL + "/rest/v1/notam?icao_location=eq." + encodeURIComponent(icao) + "&select=" + sel, { headers: SBH });
  if (!r.ok) throw new Error("mirror " + r.status);
  const rows = await r.json();
  // Dedup domestic/international copies; prefer the copy that carries geometry.
  const byKey = new Map();
  for (const x of rows) {
    const k = (x.q_code || "") + "|" + dedupKey(x.text);
    const hasGeom = x.geometry && (x.geometry.geometries || x.geometry.coordinates);
    const prev = byKey.get(k);
    if (!prev || (hasGeom && !(prev.geometry && (prev.geometry.geometries || prev.geometry.coordinates)))) byKey.set(k, x);
  }
  return [...byKey.values()].map(x => {
    const c = classify(x);
    return { number: x.number, classification: x.classification, qCode: x.q_code, subject: c.subject, condition: c.condition,
      text: x.text, translation: x.translation, start: x.effective_start, end: x.effective_end,
      geometry: x.geometry || null, closed: c.closed, conditional: c.conditional };
  });
}

async function syncFresh() {
  try {
    const r = await fetch(SB_URL + "/rest/v1/notam_sync?id=eq.state&select=last_sync,last_bulk", { headers: SBH });
    const a = r.ok ? await r.json() : [];
    const s = (a && a[0]) || {};
    const newest = [s.last_sync, s.last_bulk].filter(Boolean).sort().pop();
    if (!newest) return false;
    return (Date.now() - new Date(newest).getTime()) < STALE_MS;
  } catch (e) { return false; }
}

async function fromSkylink(icao) {
  if (!SITE) return [];
  const r = await fetch(SITE + "/.netlify/functions/notam?id=" + encodeURIComponent(icao));
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  const list = d.notams || [];
  return list.map(n => {
    const base = { number: n.number, classification: n.classification, qCode: null, subject: null, condition: null,
      text: n.text, translation: null, start: n.start, end: n.end, geometry: null };
    const c = classify({ text: n.text, q_code: "" });
    return { ...base, closed: c.closed, conditional: c.conditional };  // text-only; closed/conditional weak here
  });
}

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json", "Cache-Control": "public, max-age=120", "Access-Control-Allow-Origin": "*" };
  const q = (event && event.queryStringParameters) || {};
  const icao = (q.icao || q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!icao) return { statusCode: 400, headers: H, body: '{"error":"missing icao"}' };
  try {
    let source = "mirror", notams = [], fresh = true;
    if (isUS(icao) && SB_URL && SB_KEY) {
      fresh = await syncFresh();
      if (fresh) { notams = await fromMirror(icao); }
      else { source = "skylink"; notams = await fromSkylink(icao); }   // mirror stale -> live fallback
    } else {
      source = "skylink"; notams = await fromSkylink(icao);
    }
    return { statusCode: 200, headers: H, body: JSON.stringify({ icao, source, fresh, count: notams.length, notams }) };
  } catch (e) {
    // Any mirror failure -> SkyLink fallback (never fail closed on NOTAMs).
    try { const notams = await fromSkylink(icao); return { statusCode: 200, headers: H, body: JSON.stringify({ icao, source: "skylink", fresh: false, count: notams.length, notams, note: String(e.message || e) }) }; }
    catch (e2) { return { statusCode: 200, headers: H, body: JSON.stringify({ icao, source: "error", count: 0, notams: [], error: String(e.message || e) }) }; }
  }
};
