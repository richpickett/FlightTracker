// Personal Wings — SIGMET / G-AIRMET (Sierra/Tango/Zulu), via aviationweather.gov (no key).
// GET /.netlify/functions/sigmet?all=1&path=lat,lon;...&dep=<epoch_sec>
//   -> { hazards:[{group,kind,label,sev,alt,valid,text,coords:[[lat,lon],...],onRoute}], gairmetValid }
// all=1 (or no path) returns every US hazard; each is tagged onRoute if the route crosses its polygon.
// G-AIRMET: only the forecast snapshot whose valid time is nearest departure (or now) is returned.
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=300" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const q = event.queryStringParameters || {};
  const route = (q.path || "").split(";").map(s => s.split(",").map(Number)).filter(a => a.length === 2 && isFinite(a[0]) && isFinite(a[1]));
  const all = q.all === "1" || !route.length;   // all=1 (or no path) → every US hazard
  const now = Math.floor(Date.now() / 1000);
  const dep = parseInt(q.dep, 10) || 0;
  const target = dep || now;

  const pip = (pt, poly) => { const x = pt[1], y = pt[0]; let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][1], yi = poly[i][0], xj = poly[j][1], yj = poly[j][0];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    } return inside; };
  const toPoly = (coords) => Array.isArray(coords) ? coords.map(c => [parseFloat(c.lat), parseFloat(c.lon)]).filter(a => isFinite(a[0]) && isFinite(a[1])) : [];
  const crosses = (poly) => { if (poly.length < 3 || !route.length) return false; for (const p of route) if (pip(p, poly)) return true; return false; };
  const include = (poly) => poly.length >= 3 && (all || crosses(poly));
  const fmtZ = (sec) => { if (!sec) return ""; const d = new Date(sec * 1000), p = n => String(n).padStart(2, "0");
    return p(d.getUTCMonth() + 1) + "/" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + p(d.getUTCMinutes()) + "Z"; };

  const out = [];
  let gairmetValid = "";
  try {
    const [as, ga] = await Promise.all([
      fetch("https://aviationweather.gov/api/data/airsigmet?format=json").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("https://aviationweather.gov/api/data/gairmet?format=json").then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    // SIGMETs (G-AIRMET covers Sierra/Tango/Zulu) — active within [now .. departure]
    (Array.isArray(as) ? as : []).forEach(f => {
      if (String(f.airSigmetType || "").toUpperCase().indexOf("SIGMET") < 0) return;
      const poly = toPoly(f.coords); if (!include(poly)) return;
      if (f.validTimeTo && f.validTimeTo < now) return;
      if (f.validTimeFrom && f.validTimeFrom > Math.max(now, dep)) return;
      out.push({ group: "SIGMET", kind: "SIGMET", label: String(f.hazard || "").replace(/_/g, " "), sev: "", alt: "",
        valid: fmtZ(f.validTimeFrom) + (f.validTimeTo ? "–" + fmtZ(f.validTimeTo) : ""),
        text: String(f.rawAirSigmet || "").trim().slice(0, 400), coords: poly, onRoute: crosses(poly) });
    });
    // G-AIRMET — the snapshot valid-time nearest departure
    // Exclude FZLVL (freezing-level) — a continent-wide contour, not a localized hazard; it renders as huge horizontal bands.
    const gaHits = (Array.isArray(ga) ? ga : []).map(f => ({ f, poly: toPoly(f.coords) }))
      .filter(x => include(x.poly) && !/FZLVL/i.test(String(x.f.hazard || "")));
    let bestVt = null, bestDiff = Infinity;
    gaHits.forEach(({ f }) => { const t = Date.parse(f.validTime || "") / 1000; if (!isFinite(t)) return;
      const d = Math.abs(t - target); if (d < bestDiff) { bestDiff = d; bestVt = f.validTime; } });
    gairmetValid = bestVt ? fmtZ(Math.floor(Date.parse(bestVt) / 1000)) : "";
    gaHits.forEach(({ f, poly }) => { if (f.validTime !== bestVt) return;
      const base = f.base || "", top = f.top || "", alt = (base || top) ? (base + (base && top ? "–" : "") + top) : "";
      out.push({ group: String(f.product || "").toUpperCase(), kind: "G-AIRMET",
        label: (String(f.product || "") + " " + String(f.hazard || "").replace(/_/g, " ")).trim(),
        sev: f.severity || "", alt, valid: gairmetValid, text: "", coords: poly, onRoute: crosses(poly) }); });
  } catch (e) { return J(200, { error: String(e.message || e), hazards: [] }); }

  const rank = { SIGMET: 0, SIERRA: 1, TANGO: 2, ZULU: 3 };
  out.sort((a, b) => ((b.onRoute ? 1 : 0) - (a.onRoute ? 1 : 0)) || ((rank[a.group] || 9) - (rank[b.group] || 9)));
  return J(200, { hazards: out.slice(0, 300), gairmetValid });
};
