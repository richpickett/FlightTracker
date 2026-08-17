// Personal Wings — proxy an FAA aeronav chart PDF so it can be embedded same-origin
// (aeronav.faa.gov sets X-Frame-Options / no CORS, which blocks a direct <iframe>).
// GET /.netlify/functions/chartpdf?u=<faa pdf url>
const ALLOW = /(^|\.)aeronav\.faa\.gov$/i;

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const u = q.u || "";
  let url;
  try { url = new URL(u); } catch (e) { return { statusCode: 400, body: "bad url" }; }
  // SSRF guard: only FAA aeronav chart PDFs
  if (!ALLOW.test(url.hostname) || !/\.pdf$/i.test(url.pathname)) return { statusCode: 403, body: "forbidden" };
  try {
    const r = await fetch(url.toString());
    if (!r.ok) return { statusCode: 502, body: "upstream " + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=21600",
        "Access-Control-Allow-Origin": "*"
        // deliberately no X-Frame-Options -> embeddable in our modal
      },
      body: buf.toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) { return { statusCode: 502, body: "error" }; }
};
