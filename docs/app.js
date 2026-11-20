/* NIM Studio — catalogue, streaming chat, vision attachments.
   No framework, no build step. The NVIDIA key lives in the Worker only. */
(() => {
  "use strict";

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const API = String(window.NIMSTUDIO_API || "").replace(/\/+$/, "");

  const LS = {
    chats: "nimstudio.chats.v1",
    active: "nimstudio.active.v1",
    settings: "nimstudio.settings.v1",
    model: "nimstudio.model.v1",
    sidebar: "nimstudio.sidebar.v1",
  };

  const DEFAULT_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
  const MAX_IMAGES = 4;

  const state = {
    models: [],
    filter: "all",
    query: "",
    model: "",
    chats: [],
    activeId: null,
    streaming: false,
    controller: null,
    attachments: [],
    settings: { system: "", temperature: 0.6, max_tokens: 1024 },
    live: null,
    stick: true,
    apiOk: false,
  };

  /* --------------------------------------------------------------- helpers */

  const uid = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const fmtTime = (ts) => new Date(ts || Date.now())
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const num = (n) => Number(n || 0).toLocaleString();

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* --------------------------------------------------------- model metadata */

  const PUBLISHERS = {
    nvidia: "NVIDIA", google: "Google", meta: "Meta", mistralai: "Mistral AI",
    moonshotai: "Moonshot AI", "z-ai": "Z.ai", bigcode: "BigCode",
    fastino: "Fastino", minimaxai: "MiniMax", poolside: "Poolside",
    snowflake: "Snowflake", "stepfun-ai": "StepFun",
  };

  const RE_EMBED = /embed|rerank|retriev|nvclip|gliner|video-detector/;
  const RE_VISION = /(^|[/._-])(vl|vlm|vision|omni|cosmos)([/._-]|$)/;
  const RE_REASON = /reason|thinking|(^|[/._-])r1([/._-]|$)|nemotron-3|kimi|glm|muse-glimmer|cosmos/;
  const RE_CODE = /code|coder|starcoder|laguna|devstral/;
  const RE_SAFETY = /guard|safety|pii|topic-control|content-safety/;
  const RE_TRANSLATE = /translate/;

  const metaCache = new Map();

  function prettyName(raw) {
    return String(raw).split(/[-_]/).map((w) => {
      if (/^\d+(?:\.\d+)?b$/i.test(w)) return w.toUpperCase();
      if (/^a\d+b$/i.test(w)) return w.toUpperCase();
      if (/^(vl|vlm|glm|r1|m\d+(?:\.\d+)?|v\d|it|qa|pii|ai)$/i.test(w)) return w.toUpperCase();
      if (/^\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function modelMeta(m) {
    if (metaCache.has(m.id)) return metaCache.get(m.id);

    const [pub, raw = m.id] = m.id.split("/");
    const l = m.id.toLowerCase();
    const tags = [];
    const chat = !RE_EMBED.test(l);

    if (chat) tags.push("chat");
    if (RE_VISION.test(l)) tags.push("vision");
    if (RE_REASON.test(l)) tags.push("reasoning");
    if (RE_CODE.test(l)) tags.push("code");
    if (RE_EMBED.test(l)) tags.push("embedding");
    if (RE_SAFETY.test(l)) tags.push("safety");
    if (RE_TRANSLATE.test(l)) tags.push("translation");

    const size = raw.match(/(\d+(?:\.\d+)?)b(?=[-._]|$)/i);
    const info = {
      ...m,
      pub,
      raw,
      tags,
      chat,
      publisher: PUBLISHERS[pub] || pub,
      pretty: prettyName(raw),
      size: size ? size[1].toUpperCase() + "B" : "",
    };
    metaCache.set(m.id, info);
    return info;
  }

  const metaById = (id) => {
    const found = state.models.find((m) => m.id === id);
    return found ? modelMeta(found) : null;
  };

  const currentMeta = () => metaById(state.model);
  const shortModel = (id) => {
    const m = metaById(id);
    return m ? m.pretty : String(id || "model").split("/").pop();
  };

  function visibleModels() {
    const q = state.query.trim().toLowerCase();
    return state.models.map(modelMeta).filter((m) => {
      if (q) {
        const hay = `${m.id} ${m.pretty} ${m.publisher}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (state.filter === "all") return true;
      if (state.filter === "chat") return m.chat;
      return m.tags.includes(state.filter);
    }).sort((a, b) => {
      if (a.chat !== b.chat) return a.chat ? -1 : 1;
      return a.pretty.localeCompare(b.pretty);
    });
  }

  function renderModels() {
    const list = $("#model-list");
    const items = visibleModels();
    $("#model-count").textContent = state.models.length
      ? `${items.length} of ${state.models.length} models`
      : "no models";
    list.innerHTML = "";

    if (!items.length) {
      const e = document.createElement("div");
      e.className = "empty-note";
      e.style.cssText = "padding:16px 10px;color:var(--faint);font-size:13px";
      e.textContent = state.models.length
        ? "No model matches this filter."
        : "Catalogue unavailable. Check the Worker and refresh.";
      list.appendChild(e);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "model" + (m.id === state.model ? " active" : "");
      b.dataset.id = m.id;
      b.setAttribute("role", "listitem");
      b.title = m.id;

      const name = document.createElement("div");
      name.className = "m-name";
      name.textContent = m.pretty;

      const sub = document.createElement("div");
      sub.className = "m-sub";
      sub.textContent = [m.publisher, m.size].filter(Boolean).join(" · ");

      b.append(name, sub);
      b.onclick = () => selectModel(m.id);
      frag.appendChild(b);
    }
    list.appendChild(frag);
  }

  /* ---------------------------------------------------------------- catalogue */

  function setApiState(kind, text) {
    const el = $("#api-state");
    el.className = "state " + kind;
    el.textContent = text;
  }

  async function loadModels(opts = {}) {
    setApiState("snapshot", "loading models…");
    let data = null;

    if (API) {
      try {
        const res = await fetch(API + "/api/models", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
        data = body;
        setApiState("live", `${data.models.length} live models`);
      } catch (err) {
        console.warn("live catalogue unavailable:", err);
      }
    }

    if (!data) {
      try {
        const res = await fetch("models-snapshot.json", { cache: "no-store" });
        data = await res.json();
        setApiState(API ? "snapshot" : "offline", API ? "bundled snapshot" : "no backend");
      } catch {
        setApiState("down", "catalogue unavailable");
      }
    }

    if (!data) {
      state.models = [];
      renderModels();
      updateComposer();
      return;
    }

    state.models = Array.isArray(data.models) ? data.models : [];
    if (!state.models.some((m) => m.id === state.model)) {
      const preferred = state.models.find((m) => m.id === DEFAULT_MODEL);
      const firstChat = state.models.map(modelMeta).find((m) => m.chat);
      state.model = preferred ? preferred.id : (firstChat ? firstChat.id : "");
    }
    if (state.model) lsSet(LS.model, state.model);

    renderModels();
    updatePill();
    updateComposer();
    if (!opts.silent) toast(`${state.models.length} NIM models loaded`);
  }

  function selectModel(id) {
    if (state.streaming) { toast("Wait for the current reply to finish"); return; }
    state.model = id;
    lsSet(LS.model, id);
    const chat = activeChat();
    if (chat) { chat.model = id; saveChats(); }
    renderModels();
    updatePill();
    updateComposer();
    closeSidebar();
    if (!metaById(id)?.chat) toast("This model does not accept chat messages");
    else $("#prompt").focus();
  }

  function updatePill() {
    const m = currentMeta();
    const el = $("#model-pill-name");
    el.textContent = m ? `${m.pretty}${m.size ? " · " + m.size : ""}` : "Select a model";
    $("#model-pill").title = state.model || "No model selected";
  }

  /* ----------------------------------------------------------------- chats */

  function loadChats() {
    state.chats = lsGet(LS.chats, []);
    if (!Array.isArray(state.chats)) state.chats = [];
    state.activeId = lsGet(LS.active, null);
  }

  function saveChats() {
    lsSet(LS.chats, state.chats.slice(-40));
    if (state.activeId) lsSet(LS.active, state.activeId);
  }

  const activeChat = () => state.chats.find((c) => c.id === state.activeId) || null;

  function newChat(focus = true) {
    const chat = {
      id: uid(),
      title: "New chat",
      model: state.model,
      messages: [],
      created: Date.now(),
      updated: Date.now(),
    };
    state.chats.push(chat);
    state.activeId = chat.id;
    saveChats();
    renderChatSelect();
    renderChat();
    updatePill();
    closeSidebar();
    if (focus) $("#prompt").focus();
  }

  function activateChat(id) {
    state.activeId = id;
    const chat = activeChat();
    if (chat && chat.model) state.model = chat.model;
    saveChats();
    renderChatSelect();
    renderChat();
    updatePill();
    renderModels();
  }

  function deleteChat() {
    const chat = activeChat();
    if (!chat) return;
    if (!confirm(`Delete “${chat.title}”?`)) return;
    state.chats = state.chats.filter((c) => c.id !== chat.id);
    state.activeId = state.chats.length ? state.chats[state.chats.length - 1].id : null;
    if (!state.chats.length) newChat(false);
    else { saveChats(); renderChatSelect(); renderChat(); }
    toast("Chat deleted");
  }

  function renderChatSelect() {
    const sel = $("#chat-select");
    sel.innerHTML = "";
    for (const chat of [...state.chats].reverse()) {
      const opt = document.createElement("option");
      opt.value = chat.id;
      opt.textContent = chat.title || "New chat";
      sel.appendChild(opt);
    }
    sel.value = state.activeId || "";
    sel.hidden = state.chats.length < 2;
  }

  /* -------------------------------------------------------------- markdown */

  const FENCE = "\uE000";

  function codeBlock(lang, code) {
    return `<div class="code"><div class="code-head"><span>${escapeHtml(lang || "text")}</span>` +
      `<button class="copy-btn" type="button">Copy</button></div>` +
      `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`;
  }

  function inlineFmt(text) {
    return escapeHtml(text)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderMarkdown(src) {
    let text = String(src || "").replace(/\r\n/g, "\n");
    const blocks = [];

    text = text.replace(/```([\w.+-]*)[ \t]*\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push({ lang, code });
      return `\n${FENCE}${blocks.length - 1}${FENCE}\n`;
    });
    // unterminated fence while streaming
    text = text.replace(/```([\w.+-]*)[ \t]*\n([\s\S]*)$/, (_, lang, code) => {
      blocks.push({ lang, code });
      return `\n${FENCE}${blocks.length - 1}${FENCE}\n`;
    });

    const lines = text.split("\n");
    let html = "";
    let para = [];
    let list = "";

    const flushPara = () => {
      if (!para.length) return;
      html += `<p>${para.map(inlineFmt).join("<br>")}</p>`;
      para = [];
    };
    const closeList = () => {
      if (!list) return;
      html += `</${list}>`;
      list = "";
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      const ph = line.match(new RegExp(`^${FENCE}(\\d+)${FENCE}$`));
      if (ph) {
        flushPara(); closeList();
        const b = blocks[Number(ph[1])];
        html += codeBlock(b.lang, b.code);
        continue;
      }
      if (!line.trim()) { flushPara(); closeList(); continue; }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const level = Math.min(4, h[1].length + 1);
        html += `<h${level}>${inlineFmt(h[2])}</h${level}>`;
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); html += "<hr>"; continue; }

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += `<li>${inlineFmt(ul[1])}</li>`;
        continue;
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
        html += `<li>${inlineFmt(ol[1])}</li>`;
        continue;
      }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) {
        flushPara(); closeList();
        html += `<blockquote>${inlineFmt(bq[1])}</blockquote>`;
        continue;
      }
      para.push(line);
    }
    flushPara();
    closeList();
    return html;
  }

  /* ------------------------------------------------------------- rendering */

  function emptyState() {
    const el = document.createElement("div");
    el.className = "hero";
    const chatables = state.models.filter((m) => modelMeta(m).chat).length;
    el.innerHTML = `
      <div class="hero-mark" aria-hidden="true">◈</div>
      <h2>Every NVIDIA NIM model, one chat</h2>
      <p>${state.models.length
        ? `${num(state.models.length)} models in the catalogue · ${num(chatables)} accept chat. Pick one on the left, or ask below.`
        : "Loading the NVIDIA NIM catalogue…"}</p>
      <div class="suggestions">
        <button type="button" data-prompt="Explain what a mixture-of-experts model is, with a short example.">Explain MoE</button>
        <button type="button" data-prompt="Write a Python function that parses ISO-8601 dates and handles bad input.">Write code</button>
        <button type="button" data-prompt="Compare reasoning models and standard instruct models for extracting data from invoices.">Compare models</button>
      </div>`;
    el.querySelectorAll(".suggestions button").forEach((b) => {
      b.onclick = () => { $("#prompt").value = b.dataset.prompt; autoGrow(); $("#prompt").focus(); };
    });
    return el;
  }

  function messageNode(m) {
    const wrap = document.createElement("div");

    if (m.role === "user") {
      wrap.className = "msg user";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      if (m.content) {
        const p = document.createElement("div");
        p.className = "bubble-text";
        p.textContent = m.content;
        bubble.appendChild(p);
      }
      if (m.images && m.images.length) {
        const strip = document.createElement("div");
        strip.className = "msg-images";
        for (const src of m.images) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = "attachment";
          strip.appendChild(img);
        }
        bubble.appendChild(strip);
      }
      wrap.appendChild(bubble);
      return wrap;
    }

    wrap.className = "msg assistant";

    const head = document.createElement("div");
    head.className = "msg-head";
    const mark = document.createElement("span");
    mark.className = "msg-mark";
    mark.textContent = "◈";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = shortModel(m.model || state.model);
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = fmtTime(m.ts);
    head.append(mark, who, when);
    wrap.appendChild(head);

    if (m.reasoning) wrap.appendChild(reasoningNode(m.reasoning));

    const body = document.createElement("div");
    body.className = "msg-body md";
    body.innerHTML = m.content
      ? renderMarkdown(m.content)
      : (m.error ? "" : '<span class="thinking"><span class="spin"></span>thinking…</span>');
    wrap.appendChild(body);

    if (m.error) {
      const e = document.createElement("div");
      e.className = "msg-error";
      e.textContent = m.error;
      wrap.appendChild(e);
    }
    if (m.usage) wrap.appendChild(usageLine(m.usage));
    return wrap;
  }

  function reasoningNode(text) {
    const d = document.createElement("details");
    d.className = "reasoning";
    const s = document.createElement("summary");
    s.textContent = `Reasoning · ${num(text.length)} chars`;
    const b = document.createElement("div");
    b.className = "reason-body";
    b.textContent = text;
    d.append(s, b);
    return d;
  }

  function usageLine(u) {
    const d = document.createElement("div");
    d.className = "usage";
    const bits = [];
    if (u.prompt_tokens != null) bits.push(`in ${num(u.prompt_tokens)}`);
    if (u.completion_tokens != null) bits.push(`out ${num(u.completion_tokens)}`);
    if (u.total_tokens != null) bits.push(`total ${num(u.total_tokens)}`);
    d.textContent = bits.length ? `tokens: ${bits.join(" · ")}` : "";
    return d;
  }

  function renderChat() {
    const box = $("#chat");
    const chat = activeChat();
    box.innerHTML = "";
    if (!chat || !chat.messages.length) {
      box.appendChild(emptyState());
      state.stick = true;
      updateComposer();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of chat.messages) frag.appendChild(messageNode(m));
    box.appendChild(frag);
    state.stick = true;
    scrollBottom(true);
    updateComposer();
  }

  function scrollBottom(force) {
    const box = $("#chat");
    if (!box) return;
    if (force || state.stick) box.scrollTop = box.scrollHeight;
  }

  let liveRaf = 0;
  function scheduleLive() {
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(() => { liveRaf = 0; updateLive(); });
  }

  function updateLive() {
    if (!state.live) return;
    const { node, msg } = state.live;
    if (!node || !node.isConnected) return;

    const body = node.querySelector(".msg-body");
    if (body) {
      body.innerHTML = msg.content
        ? renderMarkdown(msg.content)
        : '<span class="thinking"><span class="spin"></span>thinking…</span>';
    }

    let det = node.querySelector(".reasoning");
    if (msg.reasoning) {
      if (!det) {
        det = reasoningNode(msg.reasoning);
        const b = node.querySelector(".msg-body");
        node.insertBefore(det, b);
      } else {
        det.querySelector(".reason-body").textContent = msg.reasoning;
        det.querySelector("summary").textContent = `Reasoning · ${num(msg.reasoning.length)} chars`;
      }
    } else if (det) {
      det.remove();
    }
    scrollBottom(false);
  }

  /* ---------------------------------------------------------------- composer */

  function autoGrow() {
    const t = $("#prompt");
    t.style.height = "auto";
    t.style.height = Math.min(200, t.scrollHeight) + "px";
  }

  function updateComposer() {
    const meta = currentMeta();
    const canChat = !!meta && meta.chat;
    const ready = !!API;

    $("#send").disabled = state.streaming || !ready || !canChat;
    $("#attach").disabled = state.streaming || !ready || !canChat;
    $("#prompt").disabled = !ready || !canChat;
    $("#send").hidden = state.streaming;
    $("#stop").hidden = !state.streaming;

    const hint = $("#stream-hint");
    if (state.streaming) hint.textContent = "streaming…";
    else if (!ready) hint.textContent = "backend not configured";
    else if (!canChat) hint.textContent = "this model does not chat";
    else hint.textContent = "";

    $("#prompt").placeholder = canChat
      ? `Message ${shortModel(state.model)}…`
      : "Select a chat model";
  }

  function renderAttachments() {
    const box = $("#attachments");
    box.innerHTML = "";
    box.hidden = !state.attachments.length;
    for (const [i, a] of state.attachments.entries()) {
      const wrap = document.createElement("div");
      wrap.className = "attachment";
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name || "image";
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", `Remove ${a.name || "image"}`);
      x.onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
      wrap.append(img, x);
      box.appendChild(wrap);
    }
  }

  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }

  function imageToDataUrl(file, maxSide = 1400, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("cannot read image")); };
      img.src = url;
    });
  }

  async function addImages(files) {
    const room = MAX_IMAGES - state.attachments.length;
    if (room <= 0) { toast(`Max ${MAX_IMAGES} images per message`); return; }
    for (const file of [...files].slice(0, room)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const dataUrl = await imageToDataUrl(file);
        state.attachments.push({ name: file.name, dataUrl });
      } catch {
        toast(`Could not read ${file.name}`);
      }
    }
    renderAttachments();
    updateComposer();
  }

  /* ------------------------------------------------------------------ send */

  function buildPayload(chat, pending) {
    const messages = [];
    const system = state.settings.system.trim();
    if (system) messages.push({ role: "system", content: system });

    for (const m of chat.messages) {
      if (m === pending) break;
      if (m.error) continue;
      if (!m.content && !(m.images && m.images.length)) continue;

      if (m.images && m.images.length) {
        const content = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const url of m.images) content.push({ type: "image_url", image_url: { url } });
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    return {
      model: state.model,
      messages,
      temperature: Number(state.settings.temperature),
      max_tokens: Number(state.settings.max_tokens),
      stream: true,
    };
  }

  function handleEvent(event, out) {
    for (const raw of event.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let payload;
      try { payload = JSON.parse(data); } catch { continue; }

      if (payload.error) {
        out.error = String(payload.error.message || payload.error);
        continue;
      }

      const choice = (payload.choices && payload.choices[0]) || {};
      const delta = choice.delta || choice.message || {};
      let changed = false;

      if (typeof delta.content === "string" && delta.content) {
        out.content += delta.content;
        changed = true;
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        out.reasoning += reasoning;
        changed = true;
      }
      if (payload.usage) out.usage = payload.usage;
      if (changed) scheduleLive();
    }
  }

  async function readStream(res, out) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        handleEvent(event, out);
      }
    }
    if (buffer.trim()) handleEvent(buffer, out);
  }

  async function send() {
    if (state.streaming) return;
    const chat = activeChat();
    if (!chat) return;

    const meta = currentMeta();
    if (!meta) { toast("Pick a model first"); return; }
    if (!meta.chat) { toast("This model does not accept chat messages"); return; }
    if (!API) { showBanner(); return; }

    const text = $("#prompt").value.trim();
    const images = state.attachments.map((a) => a.dataUrl);
    if (!text && !images.length) return;

    chat.messages.push({ role: "user", content: text, images, ts: Date.now() });
    if (chat.title === "New chat") {
      chat.title = (text || "Image").replace(/\s+/g, " ").slice(0, 46) || "Image";
      renderChatSelect();
    }
    chat.model = state.model;
    chat.updated = Date.now();

    $("#prompt").value = "";
    autoGrow();
    clearAttachments();
    saveChats();
    renderChat();

    const assistant = {
      role: "assistant",
      model: state.model,
      content: "",
      reasoning: "",
      ts: Date.now(),
    };
    chat.messages.push(assistant);
    saveChats();
    renderChat();

    const nodes = $("#chat").querySelectorAll(".msg.assistant");
    state.live = { node: nodes[nodes.length - 1], msg: assistant };

    state.streaming = true;
    state.controller = new AbortController();
    updateComposer();
    const started = performance.now();

    try {
      const res = await fetch(API + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(chat, assistant)),
        signal: state.controller.signal,
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const extra = detail.detail ? `: ${String(detail.detail).slice(0, 300)}` : "";
        throw new Error((detail.error || `HTTP ${res.status}`) + extra);
      }
      if (!res.body) throw new Error("streaming is not supported by this browser");

      await readStream(res, assistant);
      assistant.ms = Math.round(performance.now() - started);
      if (!assistant.content && !assistant.reasoning) {
        assistant.content = "_(the model returned no content)_";
      }
    } catch (err) {
      if (err.name === "AbortError") assistant.error = "Stopped";
      else assistant.error = String(err.message || err);
    } finally {
      state.streaming = false;
      state.controller = null;
      state.live = null;
      chat.updated = Date.now();
      saveChats();
      renderChat();
      updateComposer();
      if (assistant.error && assistant.error !== "Stopped") toast(assistant.error);
      $("#prompt").focus();
    }
  }

  /* ---------------------------------------------------------------- banner */

  function showBanner() {
    const b = $("#banner");
    b.hidden = false;
    b.innerHTML = "Backend not configured: set <code>window.NIMSTUDIO_API</code> in " +
      "<code>docs/config.js</code> to the deployed Worker URL. The catalogue below is the " +
      "bundled snapshot and chatting is disabled.";
  }

  async function checkBackend() {
    if (!API) {
      showBanner();
      updateComposer();
      return;
    }
    try {
      const res = await fetch(API + "/api/health", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error("health check failed");
      state.apiOk = true;
      if (!body.has_key) {
        $("#banner").hidden = false;
        $("#banner").textContent = "The Worker is deployed but its NVIDIA_API_KEY secret is not set.";
      }
    } catch {
      state.apiOk = false;
      $("#banner").hidden = false;
      $("#banner").textContent = `Cannot reach the Worker at ${API}. Chatting is disabled.`;
      setApiState("down", "worker unreachable");
    }
    updateComposer();
  }

  /* ------------------------------------------------------- sidebar / misc */

  const MOBILE_Q = "(max-width: 860px)";
  const isMobile = () => (window.matchMedia
    ? window.matchMedia(MOBILE_Q).matches
    : window.innerWidth <= 860);

  function openSidebar() {
    $("#sidebar").classList.add("open");
    $("#scrim").hidden = false;
    $("#sidebar-toggle").setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#scrim").hidden = true;
    if (isMobile()) $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  }

  /* Desktop: collapse / restore the catalogue pane. */
  function setSidebarCollapsed(collapsed) {
    const app = $(".app");
    app.classList.toggle("sidebar-collapsed", collapsed);
    lsSet(LS.sidebar, collapsed);
    const btn = $("#sidebar-toggle");
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Show model list" : "Hide model list");
  }

  function applySettingsToUI() {
    $("#sys-prompt").value = state.settings.system;
    $("#temperature").value = state.settings.temperature;
    $("#temp-val").textContent = Number(state.settings.temperature).toFixed(1);
    $("#max-tokens").value = state.settings.max_tokens;
  }

  function persistSettings() {
    lsSet(LS.settings, state.settings);
  }

  function bind() {
    /* sidebar */
    $("#sidebar-toggle").onclick = () => {
      if (isMobile()) openSidebar();
      else setSidebarCollapsed(!$(".app").classList.contains("sidebar-collapsed"));
    };
    $("#sidebar-collapse").onclick = () => { if (!isMobile()) setSidebarCollapsed(true); };
    $("#sidebar-close").onclick = closeSidebar;
    $("#scrim").onclick = closeSidebar;

    /* keep the collapsed state sane when crossing the 860px breakpoint */
    const mq = window.matchMedia ? window.matchMedia(MOBILE_Q) : null;
    const onBreakpoint = () => {
      if (mq.matches) {
        $(".app").classList.remove("sidebar-collapsed");
        closeSidebar();
        $("#sidebar-toggle").setAttribute("aria-expanded", "false");
        $("#sidebar-toggle").setAttribute("aria-label", "Open model list");
      } else {
        setSidebarCollapsed(lsGet(LS.sidebar, false) === true);
      }
    };
    if (mq && mq.addEventListener) mq.addEventListener("change", onBreakpoint);
    else if (mq && mq.addListener) mq.addListener(onBreakpoint);

    /* catalogue */
    $("#model-search").addEventListener("input", (e) => {
      state.query = e.target.value;
      renderModels();
    });
    $("#filters").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.dataset.filter;
      $$("#filters .chip").forEach((c) => {
        const on = c === chip;
        c.classList.toggle("active", on);
        c.setAttribute("aria-selected", String(on));
      });
      renderModels();
    });
    $("#models-refresh").onclick = () => loadModels();

    /* chats */
    $("#new-chat").onclick = () => newChat();
    $("#chat-select").onchange = (e) => activateChat(e.target.value);
    $("#delete-chat").onclick = deleteChat;
    $("#settings-btn").onclick = () => {
      const box = $("#settings");
      box.hidden = !box.hidden;
      $("#settings-btn").setAttribute("aria-expanded", String(!box.hidden));
    };
    $("#sys-prompt").addEventListener("input", (e) => {
      state.settings.system = e.target.value;
      persistSettings();
    });
    $("#temperature").addEventListener("input", (e) => {
      state.settings.temperature = Number(e.target.value);
      $("#temp-val").textContent = Number(e.target.value).toFixed(1);
      persistSettings();
    });
    $("#max-tokens").addEventListener("change", (e) => {
      const v = Math.min(8192, Math.max(64, Math.floor(Number(e.target.value) || 1024)));
      e.target.value = v;
      state.settings.max_tokens = v;
      persistSettings();
    });

    /* composer */
    $("#send").onclick = send;
    $("#stop").onclick = () => { if (state.controller) state.controller.abort(); };
    $("#prompt").addEventListener("input", autoGrow);
    $("#prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $("#attach").onclick = () => $("#image-input").click();
    $("#image-input").addEventListener("change", (e) => {
      addImages(e.target.files);
      e.target.value = "";
    });

    /* streaming scroll preference */
    $("#chat").addEventListener("scroll", () => {
      const box = $("#chat");
      state.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    });

    /* copy buttons (delegated) */
    $("#chat").addEventListener("click", async (e) => {
      const btn = e.target.closest(".copy-btn");
      if (!btn) return;
      const code = btn.closest(".code")?.querySelector("pre");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Failed";
      }
      setTimeout(() => { btn.textContent = "Copy"; }, 1400);
    });

    /* keyboard */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#sidebar").classList.contains("open")) closeSidebar();
        else if (!$("#settings").hidden) {
          $("#settings").hidden = true;
          $("#settings-btn").setAttribute("aria-expanded", "false");
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#model-search").focus();
      }
    });
  }

  /* ------------------------------------------------------------------ init */

  async function init() {
    state.settings = { ...state.settings, ...lsGet(LS.settings, {}) };
    state.model = lsGet(LS.model, "") || "";

    loadChats();
    applySettingsToUI();
    bind();
    renderAttachments();

    /* restore a collapsed catalogue on desktop; mobile always starts closed */
    if (isMobile()) {
      $(".app").classList.remove("sidebar-collapsed");
      $("#sidebar-toggle").setAttribute("aria-expanded", "false");
      $("#sidebar-toggle").setAttribute("aria-label", "Open model list");
    } else {
      setSidebarCollapsed(lsGet(LS.sidebar, false) === true);
    }

    await loadModels({ silent: true });
    await checkBackend();

    if (state.activeId && activeChat()) {
      activateChat(state.activeId);
    } else {
      newChat(false);
    }
    renderChatSelect();
    updatePill();
    updateComposer();

    if (state.chats.length === 0) newChat(false);
  }

  init();
})();
