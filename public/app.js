(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const els = {
    app: $("#app"), chatList: $("#chatList"), newChat: $("#newChat"), status: $("#status"),
    themeBtn: $("#themeBtn"), settingsBtn: $("#settingsBtn"), menuBtn: $("#menuBtn"),
    closeSidebar: $("#closeSidebar"), scrim: $("#scrim"), modelSelect: $("#modelSelect"),
    modelMeta: $("#modelMeta"), messages: $("#messages"), composer: $("#composer"), input: $("#input"),
    sendBtn: $("#sendBtn"), attachBtn: $("#attachBtn"), fileInput: $("#fileInput"),
    attachments: $("#attachments"), dialog: $("#settingsDialog"), systemPrompt: $("#systemPrompt"),
    temperature: $("#temperature"), tempOut: $("#tempOut"), numCtx: $("#numCtx"),
    clearAll: $("#clearAll"), cancelSettings: $("#cancelSettings"), logoutBtn: $("#logoutBtn"),
  };

  // fetch() wrapper: if the session has expired or was revoked, go to the sign-in page.
  async function api(url, opts) {
    const res = await fetch(url, { cache: "no-store", ...opts });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("Signed out");
    }
    return res;
  }

  const ICONS = {
    copy: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const SUGGESTIONS = [
    { title: "Explain a concept", sub: "like how DNS works, simply", prompt: "Explain how DNS works in simple terms." },
    { title: "Write some code", sub: "a script to rename files", prompt: "Write a Python script that adds today's date to the name of every .txt file in a folder." },
    { title: "Brainstorm ideas", sub: "for a weekend project", prompt: "Give me 5 fun weekend project ideas I could build at home." },
    { title: "Summarize text", sub: "paste something long", prompt: "Summarize the following text in 3 bullet points:\n\n" },
  ];

  // ---------- Storage (per browser) ----------
  const KEYS = { chats: "olc.chats.v1", settings: "olc.settings.v1", current: "olc.current.v1" };
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
    },
  };

  const loadedChats = store.get(KEYS.chats, []);
  const state = {
    chats: Array.isArray(loadedChats) ? loadedChats : [],
    currentId: store.get(KEYS.current, null),
    settings: Object.assign(
      { model: "", systemPrompt: "", temperature: 0.7, numCtx: null, theme: "system" },
      store.get(KEYS.settings, {})
    ),
    models: [],
    online: null,
    generating: false,
    stream: null, // { chat, msg }
    controller: null,
    pendingImages: [],
  };

  // Messages left empty by a page reload mid-generation.
  for (const c of state.chats) {
    for (const m of c.messages || []) {
      if (m.role === "assistant" && !m.content && !m.error && !m.thinking) m.error = "Interrupted.";
    }
  }
  if (!state.chats.some((c) => c.id === state.currentId)) state.currentId = null;

  const isTouch = matchMedia("(pointer: coarse)").matches;
  const uid = () =>
    globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const currentChat = () => state.chats.find((c) => c.id === state.currentId) || null;
  const THINK_RE = /^\s*<think>[\s\S]*?(<\/think>|$)/;
  const stripThink = (s) => (s || "").replace(THINK_RE, "").trim();

  function saveSettings() { store.set(KEYS.settings, state.settings); }
  function saveCurrent() { store.set(KEYS.current, state.currentId); }
  function saveChats() {
    if (store.set(KEYS.chats, state.chats)) return;
    // Storage full: drop images from the oldest chats until it fits.
    const oldestFirst = [...state.chats].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const c of oldestFirst) {
      let changed = false;
      for (const m of c.messages) if (m.images?.length) { m.images = []; changed = true; }
      if (changed && store.set(KEYS.chats, state.chats)) {
        toast("Browser storage full: removed images from older chats");
        return;
      }
    }
    toast("Could not save chat history: browser storage is full");
  }

  // ---------- Helpers ----------
  let toastTimer;
  function toast(text) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      t.setAttribute("role", "status");
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // Fallback for plain-http LAN access, where the Clipboard API is unavailable.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }

  const formatBytes = (n) => (n ? `${(n / 1e9).toFixed(1)} GB` : "");
  const makeTitle = (text) => {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > 48 ? t.slice(0, 48).trimEnd() + "…" : t;
  };

  function iconButton(icon, label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = ICONS[icon];
    b.addEventListener("click", onClick);
    return b;
  }

  const nearBottom = () => {
    const b = els.messages;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 120;
  };
  const scrollToBottom = () => { els.messages.scrollTop = els.messages.scrollHeight; };

  function friendlyError(message) {
    if (/model .*not found/i.test(message)) {
      return `${message}. Install it on the server with: ollama pull <model>`;
    }
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return "Lost connection to the chat server.";
    }
    return message;
  }

  // ---------- Theme ----------
  const THEMES = ["system", "light", "dark"];
  function applyTheme() {
    const t = state.settings.theme;
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    els.themeBtn.title = `Theme: ${t}`;
  }

  // ---------- Status & models ----------
  function setStatus(kind, text) {
    els.status.classList.remove("ok", "err");
    if (kind) els.status.classList.add(kind);
    els.status.querySelector(".status-text").textContent = text;
  }

  async function checkHealth() {
    try {
      const r = await api("/api/health");
      const d = await r.json();
      els.logoutBtn.hidden = !d.auth;
      state.online = !!d.ok;
      setStatus(d.ok ? "ok" : "err", d.ok ? `Ollama ${d.ollama}` : "Ollama offline");
    } catch {
      state.online = false;
      setStatus("err", "Server offline");
    }
    return state.online;
  }

  async function loadModels() {
    try {
      const r = await api("/api/models");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      state.models = d.models || [];
    } catch {
      state.models = [];
    }
    renderModelSelect();
  }

  const selectedModel = () => state.models.find((m) => m.name === els.modelSelect.value);

  function renderModelSelect() {
    const sel = els.modelSelect;
    sel.innerHTML = "";
    if (!state.models.length) {
      sel.add(new Option(state.online === false ? "Ollama offline" : "No models installed", ""));
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const m of state.models) sel.add(new Option(m.name, m.name));
      const chat = currentChat();
      const want = chat?.model || state.settings.model;
      sel.value = state.models.some((m) => m.name === want) ? want : state.models[0].name;
      if (state.settings.model !== sel.value && !chat) {
        state.settings.model = sel.value;
        saveSettings();
      }
    }
    updateModelMeta();
    updateComposer();
  }

  function updateModelMeta() {
    const m = selectedModel();
    els.modelMeta.textContent = m
      ? [m.parameterSize, m.quantization, formatBytes(m.size)].filter(Boolean).join(" · ")
      : "";
    const vision = !!m?.capabilities?.includes("vision");
    els.attachBtn.hidden = !vision;
    if (!vision && state.pendingImages.length) {
      state.pendingImages = [];
      renderAttachments();
    }
    els.input.placeholder = m ? `Message ${m.name.replace(/:latest$/, "")}…` : "Send a message…";
  }

  // ---------- Sidebar ----------
  function renderChatList() {
    const list = els.chatList;
    list.innerHTML = "";
    const chats = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!chats.length) {
      const p = document.createElement("div");
      p.className = "chat-group";
      p.textContent = "No chats yet";
      list.append(p);
      return;
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const groupOf = (t) =>
      t >= today ? "Today" : t >= today - 864e5 ? "Yesterday" : t >= today - 7 * 864e5 ? "Previous 7 days" : "Older";
    let lastGroup = null;
    for (const c of chats) {
      const g = groupOf(c.updatedAt);
      if (g !== lastGroup) {
        const h = document.createElement("div");
        h.className = "chat-group";
        h.textContent = g;
        list.append(h);
        lastGroup = g;
      }
      const item = document.createElement("div");
      item.className = "chat-item" + (c.id === state.currentId ? " active" : "");
      item.dataset.id = c.id;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = c.title || "New chat";
      title.title = c.title || "";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn del";
      del.title = "Delete chat";
      del.setAttribute("aria-label", "Delete chat");
      del.innerHTML = ICONS.trash;
      item.append(title, del);
      list.append(item);
    }
  }

  const openSidebar = () => els.app.classList.add("sidebar-open");
  const closeSidebar = () => els.app.classList.remove("sidebar-open");

  function selectChat(id) {
    state.currentId = id;
    saveCurrent();
    const chat = currentChat();
    if (chat?.model && state.models.some((m) => m.name === chat.model)) {
      els.modelSelect.value = chat.model;
      updateModelMeta();
    }
    renderChatList();
    renderMessages();
    scrollToBottom();
    closeSidebar();
    updateComposer();
  }

  function newChat() {
    state.currentId = null;
    saveCurrent();
    renderChatList();
    renderMessages();
    closeSidebar();
    if (!isTouch) els.input.focus();
  }

  function deleteChat(id) {
    const chat = state.chats.find((c) => c.id === id);
    if (!chat || !confirm(`Delete "${chat.title || "New chat"}"?`)) return;
    if (state.stream?.chat.id === id) state.controller?.abort();
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.currentId === id) {
      state.currentId = null;
      saveCurrent();
      renderMessages();
    }
    saveChats();
    renderChatList();
  }

  // ---------- Messages ----------
  function renderEmpty() {
    const d = document.createElement("div");
    d.className = "empty";
    const logo = new Image();
    logo.className = "hero-logo";
    logo.src = "/icon-320.png";
    logo.alt = "Phi-nguin";
    logo.width = logo.height = 148;
    d.append(logo);
    const h = document.createElement("h1");
    h.textContent = "What can I help with?";
    const p = document.createElement("p");
    const model = els.modelSelect.value;
    p.textContent = model ? `Chatting with ${model}, running locally on this machine.` : "";
    d.append(h, p);

    if (!state.models.length && state.online !== null) {
      const n = document.createElement("div");
      n.className = "notice";
      n.innerHTML = state.online
        ? "No models are installed yet. On the server, run <code>ollama pull llama3.2</code>, then reload this page."
        : "Can't reach Ollama. Make sure it's running on the server (<code>ollama serve</code>), then reload.";
      d.append(n);
    } else {
      const grid = document.createElement("div");
      grid.className = "suggestions";
      for (const s of SUGGESTIONS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "suggestion";
        const bt = document.createElement("b");
        bt.textContent = s.title;
        const bs = document.createElement("span");
        bs.textContent = s.sub;
        b.append(bt, bs);
        b.addEventListener("click", () => {
          els.input.value = s.prompt;
          autosize();
          updateComposer();
          els.input.focus();
          els.input.setSelectionRange(s.prompt.length, s.prompt.length);
        });
        grid.append(b);
      }
      d.append(grid);
    }
    return d;
  }

  function renderMessages() {
    const box = els.messages;
    const chat = currentChat();
    box.innerHTML = "";
    if (!chat || !chat.messages.length) {
      box.append(renderEmpty());
      return;
    }
    const thread = document.createElement("div");
    thread.className = "thread";
    chat.messages.forEach((m, i) => thread.append(renderMessage(chat, m, i)));
    box.append(thread);
  }

  function refreshMessage(chat, index) {
    const old = els.messages.querySelector(`.msg[data-index="${index}"]`);
    if (old) old.replaceWith(renderMessage(chat, chat.messages[index], index));
  }

  function renderMessage(chat, m, index) {
    const el = document.createElement("div");
    el.className = `msg ${m.role}`;
    el.dataset.index = index;
    if (m.role === "user") {
      if (m.images?.length) {
        const imgs = document.createElement("div");
        imgs.className = "images";
        for (const b64 of m.images) {
          const img = new Image();
          img.src = `data:image/jpeg;base64,${b64}`;
          img.alt = "Attached image";
          imgs.append(img);
        }
        el.append(imgs);
      }
      if (m.content) {
        const b = document.createElement("div");
        b.className = "bubble";
        b.textContent = m.content;
        el.append(b);
      }
    } else {
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = '<img class="avatar" src="/icon-192.png" alt="" width="24" height="24">';
      const name = document.createElement("span");
      name.textContent = (m.model || chat.model || "assistant").replace(/:latest$/, "");
      who.append(name);
      const content = document.createElement("div");
      content.className = "content";
      fillAssistant(content, m, state.stream?.msg === m);
      el.append(who, content);
    }
    el.append(renderActions(chat, m, index));
    return el;
  }

  function fillAssistant(el, m, streaming) {
    let thinking = m.thinking || "";
    let answer = m.content || "";
    let thinkingUnclosed = false;
    const t = answer.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
    if (t) {
      thinking = [thinking, t[1].trim()].filter(Boolean).join("\n");
      answer = answer.slice(t[0].length);
      thinkingUnclosed = !t[2];
    }
    const prevDetails = el.querySelector("details.thinking");
    let html = "";
    if (thinking) {
      const stillThinking = streaming && (thinkingUnclosed || !answer.trim());
      const open = prevDetails ? prevDetails.open : stillThinking;
      html += `<details class="thinking"${open ? " open" : ""}><summary>${stillThinking ? "Thinking…" : "Thought process"}</summary>` +
        `<div class="thinking-body">${Markdown.escapeHtml(thinking.trim())}</div></details>`;
    }
    if (answer.trim()) html += Markdown.render(answer.replace(/^\s*\n/, ""));
    else if (streaming && !thinking) html += '<div class="typing" aria-label="Generating"><span></span><span></span><span></span></div>';
    if (m.error) html += `<div class="error">${Markdown.escapeHtml(m.error)}</div>`;
    el.innerHTML = html;
  }

  function renderActions(chat, m, index) {
    const a = document.createElement("div");
    a.className = "actions";
    if (state.stream?.msg === m) return a;
    const text = m.role === "assistant" ? stripThink(m.content) : m.content;
    if (text) {
      a.append(iconButton("copy", "Copy", async () => toast((await copyText(text)) ? "Copied" : "Copy failed")));
    }
    if (m.role === "assistant" && index === chat.messages.length - 1) {
      a.append(iconButton("refresh", "Regenerate", regenerate));
    }
    if (m.role === "assistant" && (m.stats || m.stopped || m.truncated)) {
      const s = document.createElement("span");
      s.className = "stats";
      s.textContent = [m.stats, m.stopped && "stopped", m.truncated && "hit length limit"].filter(Boolean).join(" · ");
      a.append(s);
    }
    return a;
  }

  let rafPending = false;
  function scheduleStreamRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const s = state.stream;
      if (!s || s.chat.id !== state.currentId) return;
      const content = els.messages.querySelector(".thread > .msg:last-child .content");
      if (!content) return;
      const stick = nearBottom();
      fillAssistant(content, s.msg, true);
      if (stick) scrollToBottom();
    });
  }

  // ---------- Chat flow ----------
  function buildHistory(chat) {
    const out = [];
    const sys = state.settings.systemPrompt.trim();
    if (sys) out.push({ role: "system", content: sys });
    for (const m of chat.messages) {
      if (m === state.stream?.msg) continue;
      if (m.role === "assistant" && !stripThink(m.content)) continue; // skip failed/empty replies
      const msg = { role: m.role, content: m.role === "assistant" ? stripThink(m.content) : m.content };
      if (m.images?.length) msg.images = m.images;
      out.push(msg);
    }
    return out;
  }

  function buildOptions() {
    const o = { temperature: Number(state.settings.temperature) };
    if (state.settings.numCtx > 0) o.num_ctx = Number(state.settings.numCtx);
    return o;
  }

  function formatStats(d) {
    const parts = [];
    if (d.eval_count) parts.push(`${d.eval_count} tokens`);
    if (d.eval_count && d.eval_duration) parts.push(`${(d.eval_count / (d.eval_duration / 1e9)).toFixed(1)} tok/s`);
    if (d.total_duration) parts.push(`${(d.total_duration / 1e9).toFixed(1)}s`);
    return parts.join(" · ");
  }

  async function send() {
    const text = els.input.value.trim();
    if (state.generating || (!text && !state.pendingImages.length)) return;
    const model = els.modelSelect.value;
    if (!model) { toast("No model available"); return; }

    let chat = currentChat();
    if (!chat) {
      chat = { id: uid(), title: "", model, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      state.chats.push(chat);
      state.currentId = chat.id;
      saveCurrent();
    }
    chat.model = model;
    const userMsg = { role: "user", content: text };
    if (state.pendingImages.length) userMsg.images = state.pendingImages.slice();
    chat.messages.push(userMsg);
    if (!chat.title) chat.title = makeTitle(text || "Image");

    els.input.value = "";
    autosize();
    state.pendingImages = [];
    renderAttachments();
    await generate(chat);
  }

  function regenerate() {
    if (state.generating) return;
    const chat = currentChat();
    if (!chat) return;
    if (chat.messages[chat.messages.length - 1]?.role === "assistant") chat.messages.pop();
    if (!chat.messages.length) return;
    chat.model = els.modelSelect.value || chat.model;
    generate(chat);
  }

  function stop() { state.controller?.abort(); }

  async function generate(chat) {
    const msg = { role: "assistant", content: "", model: chat.model };
    const history = buildHistory(chat);
    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    state.generating = true;
    state.stream = { chat, msg };
    state.controller = new AbortController();
    saveChats();
    renderChatList();
    renderMessages();
    scrollToBottom();
    updateComposer();

    try {
      const res = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: chat.model, messages: history, options: buildOptions() }),
        signal: state.controller.signal,
      });
      if (!res.ok) {
        let e = `Request failed (${res.status})`;
        try { const j = await res.json(); if (j.error) e = j.error; } catch {}
        throw new Error(e);
      }

      const handleLine = (raw) => {
        const line = raw.trim();
        if (!line) return;
        let d;
        try { d = JSON.parse(line); } catch { return; }
        if (d.error) throw new Error(d.error);
        if (d.message?.content) msg.content += d.message.content;
        if (d.message?.thinking) msg.thinking = (msg.thinking || "") + d.message.thinking;
        if (d.done) {
          msg.stats = formatStats(d);
          if (d.done_reason === "length") msg.truncated = true;
        }
        scheduleStreamRender();
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handleLine(buf + decoder.decode());
    } catch (err) {
      if (err.name === "AbortError") {
        if (msg.content || msg.thinking) msg.stopped = true;
        else msg.error = "Stopped.";
      } else {
        msg.error = friendlyError(err.message || String(err));
      }
    } finally {
      state.generating = false;
      state.stream = null;
      state.controller = null;
      chat.updatedAt = Date.now();
      saveChats();
      if (chat.id === state.currentId) {
        const stick = nearBottom();
        refreshMessage(chat, chat.messages.indexOf(msg));
        if (stick) scrollToBottom();
      }
      renderChatList();
      updateComposer();
      if (!isTouch) els.input.focus();
    }
  }

  // ---------- Composer ----------
  function autosize() {
    const t = els.input;
    t.style.height = "auto";
    if (!t.value || !t.offsetWidth) return; // empty (or not laid out yet): keep natural one-row height
    t.style.height = Math.min(t.scrollHeight, 220) + "px";
  }
  addEventListener("resize", autosize);

  function updateComposer() {
    const hasInput = els.input.value.trim().length > 0 || state.pendingImages.length > 0;
    els.sendBtn.classList.toggle("stop", state.generating);
    els.sendBtn.type = state.generating ? "button" : "submit";
    els.sendBtn.disabled = state.generating ? false : !hasInput || !els.modelSelect.value;
    const label = state.generating ? "Stop generating" : "Send";
    els.sendBtn.setAttribute("aria-label", label);
    els.sendBtn.title = label;
  }

  async function fileToBase64Jpeg(file, maxSide = 1280) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.85).split(",")[1];
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function addImages(files) {
    if (!selectedModel()?.capabilities?.includes("vision")) {
      toast("This model doesn't accept images");
      return;
    }
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      try { state.pendingImages.push(await fileToBase64Jpeg(f)); } catch { toast(`Couldn't read ${f.name || "image"}`); }
    }
    renderAttachments();
    updateComposer();
  }

  function renderAttachments() {
    const box = els.attachments;
    box.innerHTML = "";
    box.hidden = !state.pendingImages.length;
    state.pendingImages.forEach((b64, i) => {
      const t = document.createElement("div");
      t.className = "thumb";
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      img.alt = "";
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", "Remove image");
      x.addEventListener("click", () => {
        state.pendingImages.splice(i, 1);
        renderAttachments();
        updateComposer();
      });
      t.append(img, x);
      box.append(t);
    });
  }

  // ---------- Settings ----------
  function openSettings() {
    els.systemPrompt.value = state.settings.systemPrompt;
    els.temperature.value = state.settings.temperature;
    els.tempOut.textContent = Number(state.settings.temperature).toFixed(1);
    els.numCtx.value = state.settings.numCtx || "";
    els.dialog.returnValue = "";
    els.dialog.showModal();
  }

  // ---------- Events ----------
  els.composer.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  els.sendBtn.addEventListener("click", (e) => {
    if (state.generating) { e.preventDefault(); stop(); }
  });
  els.input.addEventListener("input", () => { autosize(); updateComposer(); });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch) {
      e.preventDefault();
      if (!state.generating) send();
    }
  });
  els.input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length && selectedModel()?.capabilities?.includes("vision")) {
      e.preventDefault();
      addImages(files);
    }
  });
  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    addImages([...els.fileInput.files]);
    els.fileInput.value = "";
  });

  els.modelSelect.addEventListener("change", () => {
    state.settings.model = els.modelSelect.value;
    saveSettings();
    const chat = currentChat();
    if (chat && !state.generating) { chat.model = els.modelSelect.value; saveChats(); }
    updateModelMeta();
    updateComposer();
    if (!chat || !chat.messages.length) renderMessages();
  });

  els.newChat.addEventListener("click", newChat);
  els.chatList.addEventListener("click", (e) => {
    const item = e.target.closest(".chat-item");
    if (!item) return;
    if (e.target.closest(".del")) deleteChat(item.dataset.id);
    else selectChat(item.dataset.id);
  });
  els.chatList.addEventListener("keydown", (e) => {
    const item = e.target.closest(".chat-item");
    if (item && e.target === item && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      selectChat(item.dataset.id);
    }
  });

  els.messages.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-code");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    const ok = await copyText(code);
    btn.textContent = ok ? "Copied" : "Failed";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  });

  els.menuBtn.addEventListener("click", openSidebar);
  els.closeSidebar.addEventListener("click", closeSidebar);
  els.scrim.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.app.classList.contains("sidebar-open")) closeSidebar();
  });

  els.themeBtn.addEventListener("click", () => {
    state.settings.theme = THEMES[(THEMES.indexOf(state.settings.theme) + 1) % THEMES.length];
    saveSettings();
    applyTheme();
    toast(`Theme: ${state.settings.theme}`);
  });

  els.settingsBtn.addEventListener("click", openSettings);
  els.logoutBtn.addEventListener("click", async () => {
    stop();
    try {
      await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {}
    location.href = "/login";
  });
  els.cancelSettings.addEventListener("click", () => els.dialog.close());
  els.temperature.addEventListener("input", () => {
    els.tempOut.textContent = Number(els.temperature.value).toFixed(1);
  });
  els.dialog.addEventListener("close", () => {
    if (els.dialog.returnValue !== "save") return;
    state.settings.systemPrompt = els.systemPrompt.value;
    state.settings.temperature = Number(els.temperature.value);
    const ctx = parseInt(els.numCtx.value, 10);
    state.settings.numCtx = ctx > 0 ? ctx : null;
    saveSettings();
    toast("Settings saved");
  });
  els.clearAll.addEventListener("click", () => {
    if (!confirm("Delete all chats stored in this browser? This can't be undone.")) return;
    stop();
    state.chats = [];
    state.currentId = null;
    saveChats();
    saveCurrent();
    renderChatList();
    renderMessages();
    els.dialog.close();
    toast("All chats deleted");
  });

  // ---------- Init ----------
  applyTheme();
  renderChatList();
  renderMessages();
  autosize();
  updateComposer();

  (async () => {
    await checkHealth();
    await loadModels();
    renderMessages();
    scrollToBottom();
    if (!isTouch) els.input.focus();
  })();

  // Keep the status dot fresh; pick up Ollama coming back or new models.
  setInterval(async () => {
    const wasOnline = state.online;
    const online = await checkHealth();
    if (online && (!wasOnline || !state.models.length) && !state.generating) {
      await loadModels();
      if (!currentChat()?.messages.length) renderMessages();
    }
  }, 15000);
})();
