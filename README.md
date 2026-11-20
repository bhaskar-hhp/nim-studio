# NIM Studio

A single-page AI chat app for **every model on NVIDIA NIM**. Plain HTML, CSS
and JavaScript on GitHub Pages; a Cloudflare Worker holds the API key and
streams replies from NVIDIA.

**Live:** https://bhaskar-hhp.github.io/nim-studio/

```
GitHub Pages (docs/)                 Cloudflare Worker                 NVIDIA NIM
 index.html + app.js + app.css  ──►  /api/models  (cached 30 min)  ──►  GET  /v1/models
 config.js holds the Worker URL      /api/chat    (SSE passthrough) ──►  POST /v1/chat/completions
                                     secret: NVIDIA_API_KEY
```

The browser never sees an `nvapi-…` key.

## What it does

- **Model catalogue** — every model returned by `GET /v1/models`, with search,
  filters (Chat, Vision, Reasoning, Code, Embeddings) and capability badges.
- **Streaming chat** — Server-Sent Events are passed through by the Worker and
  parsed in the browser; token-by-token rendering with a Stop button.
- **Reasoning models** — `reasoning_content` is shown in a separate collapsible
  panel, never mixed into the answer.
- **Vision** — attach up to four images to a message; they are downscaled in the
  browser and sent as `data:` URLs to multimodal models.
- **Markdown** — headings, lists, quotes, links, inline code and fenced code
  blocks with a Copy button. All model output is HTML-escaped before rendering.
- **Conversations** — kept in `localStorage` (last 40 chats), with a chat
  switcher, per-chat model, delete, and a system prompt / temperature /
  max-tokens panel.
- **Offline catalogue** — if the Worker is unreachable the UI falls back to
  `docs/models-snapshot.json` and disables chatting.

## What it is not

This is a **model explorer + chat client**, not a coding agent. A static page on
GitHub Pages cannot read local files or run shell commands — that would need a
local runtime. See [Phase 2](#phase-2-ideas) for the honest path.

## Run locally

```bash
cd docs
python3 -m http.server 8099
# open http://127.0.0.1:8099/
```

Without a Worker URL in `docs/config.js` the app loads the bundled catalogue and
shows a “backend not configured” banner.

## Deploy the Worker

```bash
cd worker
CLOUDFLARE_API_TOKEN=xxx NVIDIA_API_KEY=nvapi-... ./deploy.sh
```

It prints the Worker URL; put it in `docs/config.js`:

```js
window.NIMSTUDIO_API = "https://nim-studio.<your-subdomain>.workers.dev";
```

Token needs **Workers Scripts: Edit** and **Account Settings: Read**.

Then enable Pages: *Settings → Pages → Source: Deploy from a branch → main /docs*.

## Refresh the catalogue snapshot

```bash
NVIDIA_API_KEY=nvapi-... python3 scripts/fetch_models.py
```

Writes `docs/models-snapshot.json` from the live `/v1/models` endpoint. The
snapshot is only the fallback; the app always prefers the live Worker list.

## API

All routes are served by the Worker, not by Pages.

| Route | Purpose |
|---|---|
| `GET /api/models` | NIM catalogue, cached 30 min, `{ok, fetched_at, models[]}` |
| `POST /api/chat` | `{model, messages, temperature, max_tokens}` → SSE stream |
| `GET /api/health` | `{ok, has_key, ...}` |

Guard rails: 12 MB request cap, 120 messages, 8 192 max tokens, model ids must
match `publisher/name`, only `data:image/*` URLs accepted, and CORS is locked to
`ALLOWED_ORIGINS` (set in `worker/wrangler.toml`).

## Layout

```
docs/                 static app (GitHub Pages)
  index.html          sidebar catalogue + chat shell
  app.js              model metadata, markdown, SSE client, state
  app.css             dark UI, responsive drawer on mobile
  config.js           Worker URL (the only thing to edit after deploy)
  models-snapshot.json offline catalogue fallback
worker/
  index.js            /api/models, /api/chat, /api/health, CORS, caching
  wrangler.toml       worker name + allowed origin
  deploy.sh           secret upload + deploy in one command
scripts/
  fetch_models.py     refresh the snapshot
```

## Notes and limits

- **Free NIM credits are a grant**, not an unlimited tier. Streaming long replies
  on large models burns them quickly.
- **Images leave the browser** and are sent to NVIDIA when attached.
- Embedding / rerank / CLIP models are listed but cannot chat; selecting one
  disables the composer with an explanation.
- Per-model context windows and pricing are not exposed by `/v1/models`, so the
  UI does not invent them.
- The catalogue changes on NVIDIA's side; use **↻ refresh** or rerun the snapshot
  script.

## Phase 2 ideas

- Browser tools: fetch a URL, web search via the Worker, run JS in a sandbox.
- Server-side conversation storage with an access key.
- A local Node/Python agent runtime (files, shell, tests) with the same UI —
  the only way to get genuinely Claude-Code-like behaviour.
