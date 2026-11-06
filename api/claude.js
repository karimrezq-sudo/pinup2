// PinUp's only server code. It keeps the Anthropic API key secret and forwards
// the page's requests to Claude, streaming the answer back as plain text.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.PINUP_MODEL || "claude-opus-5-5";
// If a safety classifier declines a request, the API retries it on a recommended fallback model.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_REQUESTS_PER_HOUR = Number(process.env.PINUP_HOURLY_LIMIT || 80);
const MAX_TEXT_CHARS = 200_000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BASE64 = 7_000_000; // about 5 MB per image
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const hits = new Map(); // best-effort per-IP rate limit (resets when the function restarts)

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_REQUESTS_PER_HOUR;
}

function fail(res, status, code, message) {
  res.status(status).json({ code, message });
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Health check for the site owner: open /api/claude in a browser. Never reveals the key.
    const key = process.env.ANTHROPIC_API_KEY || "";
    const status = !key ? "No API key found. Add ANTHROPIC_API_KEY in Vercel > Settings > Environment Variables, then Redeploy."
      : !key.trim().startsWith("sk-ant-") ? "An API key is set, but it doesn't start with sk-ant-. Check you pasted the whole key."
      : key !== key.trim() ? "The API key has extra spaces. Edit it in Vercel, remove the spaces, then Redeploy."
      : "API key found. If the jury still fails, check your credit at console.anthropic.com > Billing.";
    return res.status(200).json({ site: "PinUp", keyConfigured: !!key, message: status });
  }
  if (req.method !== "POST") return fail(res, 405, "invalid_request", "Use POST.");
  if (!process.env.ANTHROPIC_API_KEY) return fail(res, 500, "site_key_missing", "The site owner hasn't added an API key yet.");

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return fail(res, 429, "rate_limited", "Too many requests from this device. Try again later.");

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const turns = Array.isArray(body.turns) ? body.turns : [];
  const images = Array.isArray(body.images) ? body.images : [];
  const effort = ["low", "medium", "high"].includes(body.effort) ? body.effort : "medium";

  // Validate input
  if (!turns.length || turns.length > 80) return fail(res, 400, "invalid_request", "Bad conversation.");
  let chars = 0;
  for (const t of turns) {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string" || !t.content.trim()) return fail(res, 400, "invalid_request", "Bad turn.");
    chars += t.content.length;
  }
  if (turns[0].role !== "user" || turns[turns.length - 1].role !== "user") return fail(res, 400, "invalid_request", "Conversation must start and end with the student.");
  if (chars > MAX_TEXT_CHARS) return fail(res, 413, "prompt_too_large", "Too much text.");
  if (images.length > MAX_IMAGES) return fail(res, 400, "image_rejected", "Too many images.");
  for (const im of images) {
    if (!im || !IMAGE_TYPES.has(im.media_type) || typeof im.data !== "string" || im.data.length > MAX_IMAGE_BASE64) return fail(res, 400, "image_rejected", "Unsupported image.");
  }

  // Merge consecutive same-role turns, attach the boards to the last student turn
  const messages = [];
  for (const t of turns) {
    const last = messages[messages.length - 1];
    if (last && last.role === t.role) last.text += "\n\n" + t.content;
    else messages.push({ role: t.role, text: t.content });
  }
  const apiMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && images.length) {
      return {
        role: "user",
        content: [
          ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
          { type: "text", text: m.text },
        ],
      };
    }
    return { role: m.role, content: m.text };
  });

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  let stream;
  req.on("close", () => { if (!res.writableEnded) stream?.abort(); });
  try {
    stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: body.json ? 16000 : 8000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort },
      cache_control: { type: "ephemeral" }, // the boards are re-sent each turn; caching makes repeats cheaper
      messages: apiMessages,
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") res.write(ev.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") res.write("\u0000ERR:refused");
    else if (final.stop_reason === "max_tokens") res.write("\u0000ERR:truncated");
  } catch (err) {
    let code = "upstream_error";
    if (err instanceof Anthropic.RateLimitError) code = "rate_limited";
    else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) code = "site_key_invalid";
    else if (err instanceof Anthropic.BadRequestError && /credit/i.test(err.message || "")) code = "site_no_credit";
    else if (err instanceof Anthropic.BadRequestError) code = "invalid_request";
    else if (err instanceof Anthropic.APIUserAbortError) code = "cancelled";
    if (code !== "cancelled") console.error("Claude request failed:", err && err.message);
    if (!res.writableEnded) res.write("\u0000ERR:" + code);
  } finally {
    if (!res.writableEnded) res.end();
  }
}
