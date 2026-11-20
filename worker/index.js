/**
 * NIM Studio — Cloudflare Worker proxy.
 *
 * Holds the NVIDIA API key (never shipped to the browser) and exposes:
 *   GET  /api/models   live NVIDIA NIM catalogue (cached 30 min)
 *   POST /api/chat     streaming OpenAI-compatible chat completions
 *   GET  /api/health   liveness
 *
 * Deploy:
 *   cd worker
 *   CLOUDFLARE_API_TOKEN=... NVIDIA_API_KEY=nvapi-... ./deploy.sh
 */

const NIM_BASE = "https://integrate.api.nvidia.com/v1";
const MODELS_TTL = 1800;                      // seconds
const MAX_BODY = 12 * 1024 * 1024;            // images as data URLs are large
const MAX_MESSAGES = 120;
const MAX_TOKENS_CAP = 8192;

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || "*")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes("*")
    ? "*"
    : (allowed.includes(origin) ? origin : (allowed[0] || ""));
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (body, headers, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const bad = (headers, status, error, extra = {}) =>
  json({ ok: false, error, ...extra }, headers, status);

function auth(env) {
  return {
    Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/* ---------------------------------------------------------------- models -- */

async function listModels(env, request, ctx, headers) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + "/_cache/models", { method: "GET" });

  const hit = await cache.match(key);
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json", "X-Models-Cache": "hit" },
    });
  }

  const up = await fetch(`${NIM_BASE}/models`, { headers: auth(env) });
  if (!up.ok) {
    const detail = (await up.text()).slice(0, 400);
    return bad(headers, up.status === 401 ? 401 : 502,
      `NVIDIA NIM /v1/models returned ${up.status}`, { detail });
  }

  const payload = await up.json();
  const models = (payload.data || payload.models || []).map((m) => ({
    id: String(m.id || ""),
    owned_by: String(m.owned_by || ""),
    created: m.created || 0,
  })).filter((m) => m.id);

  const body = JSON.stringify({
    ok: true,
    fetched_at: new Date().toISOString(),
    source: "integrate.api.nvidia.com/v1/models",
    models,
  });

  const stored = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${MODELS_TTL}`,
    },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, stored.clone()));

  return new Response(body, {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json", "X-Models-Cache": "miss" },
  });
}

/* ------------------------------------------------------------------ chat -- */

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  if (input.length > MAX_MESSAGES) return null;

  const out = [];
  for (const m of input) {
    const role = m && m.role;
    if (!["system", "user", "assistant"].includes(role)) return null;

    if (typeof m.content === "string") {
      out.push({ role, content: m.content.slice(0, 200000) });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content.slice(0, 8)) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ type: "text", text: p.text.slice(0, 200000) });
        } else if (p.type === "image_url" && p.image_url
                   && typeof p.image_url.url === "string"
                   && p.image_url.url.startsWith("data:image/")) {
          if (p.image_url.url.length > 9 * 1024 * 1024) return null;
          parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
        }
      }
      if (!parts.length) return null;
      out.push({ role, content: parts });
      continue;
    }
    return null;
  }
  return out;
}

async function chat(request, env, headers) {
  if (!env.NVIDIA_API_KEY) return bad(headers, 500, "NVIDIA_API_KEY secret is not set");

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) return bad(headers, 413, "request body too large");

  let body;
  try {
    body = await request.json();
  } catch {
    return bad(headers, 400, "body must be JSON");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model || !/^[\w.\-]+\/[\w.\-]+$/.test(model)) {
    return bad(headers, 400, "model must look like publisher/name");
  }

  const messages = cleanMessages(body.messages);
  if (!messages) return bad(headers, 400, "messages are missing or invalid");

  const temperature = Math.min(2, Math.max(0, Number(body.temperature) || 0));
  const maxTokens = Math.min(MAX_TOKENS_CAP,
    Math.max(64, Math.floor(Number(body.max_tokens) || 1024)));

  const upstream = await fetch(`${NIM_BASE}/chat/completions`, {
    method: "POST",
    headers: auth(env),
    signal: request.signal,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: body.stream !== false,
    }),
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 600);
    return bad(headers, upstream.status === 429 ? 429 : 502,
      `NVIDIA NIM returned ${upstream.status}`, { detail });
  }

  // Pass the SSE stream straight through; the Worker adds no buffering.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/* ---------------------------------------------------------------- routes -- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = cors(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "nim-studio",
        has_key: !!env.NVIDIA_API_KEY,
        models_cached_seconds: MODELS_TTL,
      }, headers);
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      if (!env.NVIDIA_API_KEY) return bad(headers, 500, "NVIDIA_API_KEY secret is not set");
      try {
        return await listModels(env, request, ctx, headers);
      } catch (err) {
        return bad(headers, 502, String(err && err.message || err));
      }
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        return await chat(request, env, headers);
      } catch (err) {
        return bad(headers, 502, String(err && err.message || err));
      }
    }

    return bad(headers, 404, "not found");
  },
};
