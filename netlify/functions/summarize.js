// Personal Wings — plain-English NOTAM summary via an LLM (Netlify Function).
// POST { airport, texts:[...] }  ->  { summary, model, usage:{in,out}, costUSD }
// Provider: ANTHROPIC_API_KEY (Claude Haiku) preferred, else OPENAI_API_KEY (gpt-4o-mini). No key -> {error}.
// Cost is computed from token usage x per-model price so the client can tally briefing cost.
const PRICE = {                                  // USD per 1M tokens {input, output} — adjust if pricing changes
  "claude-haiku-4-5": { in: 1.00, out: 5.00 },
  "gpt-4o-mini":      { in: 0.15, out: 0.60 },
};
const priceOf = (m) => PRICE[m] || { in: 0, out: 0 };  // unknown model → 0 cost, never crash the summary
exports.handler = async (event) => {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "content-type", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };
  const J = (c, o) => ({ statusCode: c, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  if (event.httpMethod !== "POST") return J(405, { error: "POST only" });

  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const airport = String(b.airport || "").slice(0, 8);
  const texts = (Array.isArray(b.texts) ? b.texts : []).map(t => String(t || "").trim()).filter(Boolean).slice(0, 40);
  if (!texts.length) return J(200, { summary: "", note: "no NOTAMs" });

  const prompt = "You are an aviation weather/NOTAM briefer for a general-aviation pilot. Summarize the NOTAMs below for " +
    (airport || "this airport") + " in plain English. Lead with the operationally significant items (runway/taxiway closures, " +
    "approach/navaid outages, airspace/TFRs), then briefly note the rest. Use short bullet points (max ~7), each one line. " +
    "Do NOT invent anything — only condense what is given. Keep tail info like runway IDs and times.\n\nNOTAMs:\n" +
    texts.map((t, i) => (i + 1) + ". " + t).join("\n");

  const aKey = process.env.ANTHROPIC_API_KEY, oKey = process.env.OPENAI_API_KEY;
  try {
    if (aKey) {
      const model = "claude-haiku-4-5";
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": aKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: "user", content: prompt }] }) });
      const t = await r.text(); if (!r.ok) return J(200, { error: "anthropic " + r.status, detail: t.slice(0, 160) });
      const j = JSON.parse(t);
      const summary = (j.content || []).map(c => c.text || "").join("").trim();
      const inTok = (j.usage && j.usage.input_tokens) || 0, outTok = (j.usage && j.usage.output_tokens) || 0;
      const p = priceOf(model), costUSD = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
      return J(200, { summary, model, usage: { in: inTok, out: outTok }, costUSD: +costUSD.toFixed(6) });
    }
    if (oKey) {
      const model = "gpt-4o-mini";
      const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST",
        headers: { Authorization: "Bearer " + oKey, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: "user", content: prompt }] }) });
      const t = await r.text(); if (!r.ok) return J(200, { error: "openai " + r.status, detail: t.slice(0, 160) });
      const j = JSON.parse(t);
      const summary = (((j.choices || [])[0] || {}).message || {}).content || "";
      const inTok = (j.usage && j.usage.prompt_tokens) || 0, outTok = (j.usage && j.usage.completion_tokens) || 0;
      const p = priceOf(model), costUSD = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
      return J(200, { summary: summary.trim(), model, usage: { in: inTok, out: outTok }, costUSD: +costUSD.toFixed(6) });
    }
    return J(200, { error: "no LLM key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)" });
  } catch (e) { return J(200, { error: String(e.message || e) }); }
};
