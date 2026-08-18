// Personal Wings — official FAA airport diagram (and other charts) via SkyLink (RapidAPI gateway).
// Reuses the SkyLink key already used by notam.js. Returns the airport-diagram PDF URL for embedding.
// GET /.netlify/functions/airportchart?icao=KSFO   ->  { icao, diagram:{name,url}, gen:[{name,url}...] }
const HOST = "skylink-api.p.rapidapi.com";

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
  const okHdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" };
  const errHdr = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const q = event.queryStringParameters || {};
  const icao = (q.icao || q.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!icao) return { statusCode: 400, headers: errHdr, body: '{"error":"missing icao"}' };

  const key = process.env.SKYLINK_KEY || process.env.SKYLINK_API_KEY || process.env.RAPIDAPI_KEY;
  if (!key) return { statusCode: 200, headers: errHdr, body: JSON.stringify({ icao, error: "not configured" }) };

  // Full chart index (RapidAPI gateway, no version prefix, matching notam.js convention), then find the airport diagram across all categories.
  const url = "https://" + HOST + "/charts/" + encodeURIComponent(icao);
  try {
    const r = await fetch(url, { headers: { "x-rapidapi-key": key, "x-rapidapi-host": HOST, Accept: "application/json" } });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { statusCode: 200, headers: errHdr, body: JSON.stringify({ icao, error: "skylink " + r.status, detail: t.slice(0, 160) }) }; }
    const data = await r.json();
    const nm = c => c.name || c.chart_name || c.chartName || c.title || "";
    const cat = c => c.category || c.cat || c.type || c.chart_code || "";
    let all = [];
    if (Array.isArray(data)) all = data;
    else if (data.charts && typeof data.charts === "object" && !Array.isArray(data.charts)) {
      Object.keys(data.charts).forEach(k => { if (Array.isArray(data.charts[k])) all = all.concat(data.charts[k].map(c => ({ ...c, category: c.category || k }))); });
    } else if (data.charts && Array.isArray(data.charts)) all = data.charts;
    all = all.filter(c => c && c.url).map(c => ({ name: nm(c), url: c.url, category: cat(c) }));
    // Match the real Airport Diagram. NOTE: require a DIGIT before "AD.PDF" — FAA airport-diagram files are
    // <5-char-id>AD.PDF (e.g. 00119AD.PDF), but general charts like RADAR MINIMUMS are <region>RAD.PDF
    // ("SW1RAD.PDF") which also ends in "AD.PDF" and was false-matching. Drop the loose /\bairport\b/ name test too.
    const isAD = c => /airport\s*diagram/i.test(c.name) || /^APD$/i.test(c.category) || /\dAD\.PDF(\?|$)/i.test(c.url);
    let diagram = all.find(isAD) || null;
    if (!diagram) {
      // SkyLink lists procedures but not the airport diagram — derive it: FAA d-TPP <5-digit><proc>.PDF  ->  <5-digit>AD.PDF
      for (const c of all) {
        const mm = (c.url || "").match(/\/d-tpp\/(\d{4})\/(\d{5})[A-Z0-9_]*\.PDF/i);
        if (mm) { diagram = { name: "Airport Diagram", url: "https://aeronav.faa.gov/d-tpp/" + mm[1] + "/" + mm[2] + "AD.PDF", category: "APD", derived: true }; break; }
      }
    }
    // Many smaller fields have no published airport diagram — a derived URL would 404. Verify it exists before returning it.
    if (diagram && diagram.derived) {
      try { const h = await fetch(diagram.url, { method: "HEAD" }); if (!h.ok) diagram = null; }
      catch (e) { /* transient network issue — leave the derived URL rather than dropping a valid diagram */ }
    }
    return { statusCode: 200, headers: (diagram ? okHdr : errHdr), body: JSON.stringify({ icao, diagram, count: all.length, charts: all }) };
  } catch (e) {
    return { statusCode: 200, headers: errHdr, body: JSON.stringify({ icao, error: String(e.message || e) }) };
  }
};
