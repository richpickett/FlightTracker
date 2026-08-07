// Personal Wings — food near a point via Google Places API (New). Key in env GOOGLE_MAPS_API_KEY (server-side only).
// GET /.netlify/functions/food?lat=..&lon=..&radius=3218  ->  {places:[{name,lat,lon,rating,count,type,mapsUri}]}
const PLACES = "https://places.googleapis.com/v1/places:searchNearby";
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "public, max-age=86400" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const q = event.queryStringParameters || {};
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const radius = Math.min(Math.max(parseFloat(q.radius) || 3218, 50), 5000);
  if (!isFinite(lat) || !isFinite(lon)) return J(400, { error: "lat/lon required" });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return J(200, { places: [], note: "GOOGLE_MAPS_API_KEY not set" });
  // We also ask for the airport itself ("airport" type) so we can read its street address and
  // tag on-field food by street match — this rides on the SAME call, so no extra API cost.
  const body = { includedTypes: ["restaurant","cafe","bakery","coffee_shop","airport"], maxResultCount: 20, rankPreference: "DISTANCE",
    locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } } };
  try {
    const r = await fetch(PLACES, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.location,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.primaryType,places.formattedAddress,places.googleMapsUri" },
      body: JSON.stringify(body) });
    const txt = await r.text();
    if (!r.ok) return J(200, { places: [], note: "google " + r.status, detail: txt.slice(0,220) });
    let j = {}; try { j = JSON.parse(txt); } catch (e) {}
    // street name only, house number stripped, normalized for comparison
    const streetOf = a => { if (!a) return ""; const s = String(a).split(",")[0].replace(/^\s*\d+[-\s]*/, "").replace(/\b(ste|suite|unit|#).*$/i, ""); return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); };
    const raw = (j.places || []).filter(p => p.location && p.location.latitude != null && p.location.longitude != null);
    const apt = raw.find(p => p.primaryType === "airport");
    const aptStreet = apt ? streetOf(apt.formattedAddress) : "";
    const places = raw.filter(p => p.primaryType !== "airport" && p.displayName && p.displayName.text).map(p => ({
      name: (p.displayName && p.displayName.text) || "",
      lat: p.location.latitude, lon: p.location.longitude,
      rating: (p.rating != null) ? p.rating : null, count: (p.userRatingCount != null) ? p.userRatingCount : null,
      type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "", mapsUri: p.googleMapsUri || "",
      addr: p.formattedAddress || ""
    }));
    return J(200, { places, aptStreet });
  } catch (e) { return J(200, { places: [], note: "error " + (e && e.message) }); }
};
