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
  const body = { includedTypes: ["restaurant","cafe","bakery","coffee_shop"], maxResultCount: 20, rankPreference: "DISTANCE",
    locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } } };
  try {
    const r = await fetch(PLACES, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.location,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.googleMapsUri" },
      body: JSON.stringify(body) });
    const txt = await r.text();
    if (!r.ok) return J(200, { places: [], note: "google " + r.status, detail: txt.slice(0,220) });
    let j = {}; try { j = JSON.parse(txt); } catch (e) {}
    const places = (j.places || []).map(p => ({
      name: (p.displayName && p.displayName.text) || "",
      lat: p.location && p.location.latitude, lon: p.location && p.location.longitude,
      rating: (p.rating != null) ? p.rating : null, count: (p.userRatingCount != null) ? p.userRatingCount : null,
      type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "", mapsUri: p.googleMapsUri || ""
    })).filter(p => p.lat != null && p.lon != null && p.name);
    return J(200, { places });
  } catch (e) { return J(200, { places: [], note: "error " + (e && e.message) }); }
};
