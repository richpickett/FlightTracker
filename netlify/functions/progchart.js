// Personal Wings — Surface Prog (fronts / pressure / isobars), via aviationweather.gov (no key).
// Same source the AWC GFA "Prog Chart" renders: WPC coded-front GeoJSON per forecast hour.
// GET /.netlify/functions/progchart?fhrs=0,6,12&bbox=minLon,minLat,maxLon,maxLat
//   -> { run, wxBounds:[[s,w],[n,e]], frames:[{ fhr, vsecs, valid, wxUrl, feats:[
//         {t:1,c:[[lon,lat]...]}            isobar
//         {t:2,front:"Cold Front",pip:1,c}  front (front name + pip side)
//         {t:15,code:"high"|"low",c}        H / L center
//         {t:21,text:"1016",c}              pressure label
//       ] }] }
// Feature lines are clipped to bbox (kept as in-box runs) so payload stays small & route-local.
// Weather shading (NDFD Wx) is a georeferenced PNG loaded client-side as an <img> overlay (wxUrl); no proxy bytes needed.

exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=900" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const q = event.queryStringParameters || {};

  // AWC weather-PNG georeference (best-fit; tune here if the overlay looks shifted).
  const WX_BOUNDS = [[21.0, -125.0], [50.0, -66.5]];

  const fhrs = (q.fhrs || "0,6,12").split(",").map(n => parseInt(n, 10)).filter(n => isFinite(n)).slice(0, 8);
  const bb = (q.bbox || "-125,22,-66,52").split(",").map(Number);
  const [loW, laS, loE, laN] = (bb.length === 4 && bb.every(isFinite)) ? bb : [-125, 22, -66, 52];
  const inBB = c => c[0] >= loW && c[0] <= loE && c[1] >= laS && c[1] <= laN;
  const r2 = c => [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100];

  const pad = n => String(n).padStart(2, "0");
  const stamp = (d) => "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes());
  const fmtZ = (sec) => { const d = new Date(sec * 1000); return pad(d.getUTCMonth() + 1) + "/" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "Z"; };
  const wxStamp = (sec) => { const d = new Date(sec * 1000); return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + "00"; };

  try {
    const idxUrl = "https://aviationweather.gov/api/data/progchart?date=" + stamp(new Date());
    const idx = await fetch(idxUrl).then(r => r.ok ? r.json() : null).catch(() => null);
    const prog = (idx && Array.isArray(idx.prog)) ? idx.prog : [];
    if (!prog.length) return J(200, { run: null, wxBounds: WX_BOUNDS, frames: [], error: "no prog index" });

    const wanted = fhrs.map(fhr => prog.find(p => p.fhr === fhr)).filter(Boolean);
    const frames = [];
    for (const p of wanted) {
      const dir = String(p.file).slice(0, 8);
      const gj = await fetch("https://aviationweather.gov/data/products/wpc/" + dir + "/" + p.file).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!gj || !Array.isArray(gj.features)) continue;
      const feats = [];
      for (const f of gj.features) {
        const g = f.geometry, pr = f.properties || {};
        if (!g) continue;
        if (g.type === "LineString") {
          let run = [];
          const flush = () => { if (run.length >= 2) feats.push(pr.type === 2 ? { t: 2, front: pr.front || null, pip: pr.fpipdr || 1, c: run.map(r2) } : { t: 1, c: run.map(r2) }); run = []; };
          for (const c of g.coordinates) { if (inBB(c)) run.push(c); else flush(); }
          flush();
        } else if (g.type === "Point" && inBB(g.coordinates)) {
          if (pr.type === 15) feats.push({ t: 15, code: pr.code || null, c: r2(g.coordinates) });
          else if (pr.type === 21) feats.push({ t: 21, text: pr.text || null, c: r2(g.coordinates) });
        }
      }
      frames.push({ fhr: p.fhr, vsecs: p.vsecs, valid: fmtZ(p.vsecs),
        wxUrl: "https://aviationweather.gov/api/data/model?model=ndfd&level=sfc&type=wx&date=" + wxStamp(p.vsecs),
        feats });
    }
    return J(200, { run: prog[0] ? String(prog[0].file).slice(0, 8) : null, wxBounds: WX_BOUNDS, frames });
  } catch (e) {
    return J(200, { error: String(e.message || e), frames: [] });
  }
};
