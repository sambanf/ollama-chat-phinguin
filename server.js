// Phi-nguin server: serves the chat UI behind a password + TOTP login and proxies a safe
// subset of the Ollama API. No dependencies; requires Node 18+.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  createAuthStore, createBackupStore, createLoginLimiter, createSessionToken, findBackupCode,
  looksLikeBackupCode, saveAuthFile, verifySessionToken, verifyPassword, verifyTotp,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // 0.0.0.0 = reachable from other devices on your network
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const AUTH_ENABLED = String(process.env.AUTH || "on").toLowerCase() !== "off";
const AUTH_FILE = path.resolve(__dirname, process.env.AUTH_FILE || "auth.json");
const BACKUP_FILE = path.resolve(__dirname, process.env.BACKUP_FILE || "backup-codes.json");
const MAX_BODY_BYTES = 20 * 1024 * 1024; // allows long histories / base64 images
const LOGIN_BODY_BYTES = 4096;
const SESSION_COOKIE = "phi_session";
const REMEMBER_MS = 30 * 24 * 3600_000; // "Keep me signed in"
const SHORT_SESSION_MS = 12 * 3600_000; // otherwise: until the browser closes, at most 12 hours

const authStore = createAuthStore(AUTH_FILE);
const backupStore = createBackupStore(BACKUP_FILE);
const limiter = createLoginLimiter();
let lastTotpCounter = -1; // last accepted TOTP time step (blocks code reuse)

// Files the login page needs before you're signed in. Everything else requires a session.
const OPEN_FILES = new Set([
  "/login.js", "/style.css", "/icon-32.png", "/icon-192.png", "/icon-320.png", "/icon-512.png",
  "/apple-touch-icon.png",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const CSP = [
  "default-src 'self'", "img-src 'self' data: blob:", "style-src 'self'", "script-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

const now = () => new Date().toISOString();
const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

// The real client address. Proxy headers are trusted only when the connection itself comes from
// this machine (e.g. a Tailscale Funnel or Cloudflare Tunnel daemon), so remote clients can't spoof them.
function clientIp(req) {
  const remote = req.socket.remoteAddress || "";
  if (isLoopback(remote)) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // the entry appended by the local proxy
  }
  return remote.replace(/^::ffff:/, "");
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return isLoopback(req.socket.remoteAddress || "") && proto === "https";
}

function setSecurityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", CSP);
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isJson = (req) => /^application\/json\b/i.test(req.headers["content-type"] || "");

async function serveStatic(req, res, pathname, status = 200) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad request" });
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    // ETag lets the browser revalidate cheaply (304) instead of re-downloading unchanged files.
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
      ETag: etag,
    };
    if (status === 200 && req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const body = await readFile(filePath);
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

// ---------- Auth ----------
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(req, value, maxAgeMs) {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeMs !== null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

// "off" (AUTH=off), "ok" (signed in), "anon" (not signed in), or "locked" (login not set up / auth file broken)
function authState(req) {
  if (!AUTH_ENABLED) return { state: "off" };
  const { config, error } = authStore.load();
  if (error) return { state: "locked", reason: error };
  if (!config) return { state: "locked", reason: "not set up" };
  const ok = verifySessionToken(config.sessionSecret, getCookie(req, SESSION_COOKIE));
  return { state: ok ? "ok" : "anon", config };
}

async function handleLogin(req, res, ip) {
  if (!AUTH_ENABLED) return sendJson(res, 200, { ok: true });
  if (!isJson(req)) return sendJson(res, 415, { error: "Expected JSON" });
  const { config, error } = authStore.load();
  if (error || !config) {
    return sendJson(res, 503, { error: "Login isn't set up yet. On the server, run: node setup-auth.js" });
  }

  const wait = limiter.retryAfter(ip);
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    return sendJson(res, 429, {
      error: `Too many sign-in attempts. Try again in ${Math.ceil(secs / 60)} minute${secs > 60 ? "s" : ""}.`,
      retryAfter: secs,
    }, { "Retry-After": String(secs) });
  }
  limiter.attempt(ip);

  let body;
  try {
    body = JSON.parse(await readBody(req, LOGIN_BODY_BYTES));
  } catch {
    return sendJson(res, 400, { error: "Invalid request" });
  }
  const passwordOk = await verifyPassword(body?.password, config.passwordHash).catch(() => false);

  // Second factor: a 6-digit authenticator code, or a single-use backup code.
  // Everything from here to "spend" runs synchronously, so two requests can't both use one code.
  let factor = null;
  let spend = () => {};
  if (looksLikeBackupCode(body?.code)) {
    const { config: backups } = backupStore.load();
    const index = passwordOk ? findBackupCode(backups, body.code) : -1;
    if (index >= 0) {
      factor = "backup code";
      spend = () => {
        backups.hashes.splice(index, 1);
        saveAuthFile(BACKUP_FILE, backups).catch((err) =>
          console.error(`[${now()}] Couldn't save backup codes: ${err.message}`));
        return backups.hashes.length;
      };
    }
  } else {
    const counter = verifyTotp(config.totpSecret, body?.code, lastTotpCounter);
    if (passwordOk && counter !== null) {
      factor = "authenticator";
      spend = () => { lastTotpCounter = counter; };
    }
  }
  if (!passwordOk || !factor) {
    console.warn(`[${now()}] Failed sign-in from ${ip}`);
    return sendJson(res, 401, { error: "Incorrect password or code." });
  }

  const backupsLeft = spend();
  limiter.succeeded(ip);
  const remember = body.remember === true;
  const token = createSessionToken(config.sessionSecret, remember ? REMEMBER_MS : SHORT_SESSION_MS);
  console.log(`[${now()}] Signed in from ${ip} with ${factor}` +
    (factor === "backup code" ? ` (${backupsLeft} left)` : "") + (remember ? ", remembered for 30 days" : ""));
  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, token, remember ? REMEMBER_MS : null) });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
}

// ---------- Ollama API ----------
async function handleHealth(res) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(3000) });
    const v = await r.json();
    sendJson(res, 200, { ok: true, ollama: v.version, auth: AUTH_ENABLED });
  } catch {
    sendJson(res, 503, { ok: false, error: `Ollama unreachable at ${OLLAMA_URL}`, auth: AUTH_ENABLED });
  }
}

// GET /api/models -> list installed models
async function handleModels(res) {
  const upstream = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!upstream.ok) return sendJson(res, 502, { error: `Ollama returned ${upstream.status}` });
  const data = await upstream.json();
  const models = (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    family: m.details?.family,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    capabilities: m.capabilities || [],
  }));
  sendJson(res, 200, { models });
}

// POST /api/chat -> stream NDJSON from Ollama straight through to the browser
async function handleChat(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: "Expected JSON" });
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : "Invalid JSON body" });
  }
  if (!payload || typeof payload.model !== "string" || !Array.isArray(payload.messages)) {
    return sendJson(res, 400, { error: "Body must include 'model' (string) and 'messages' (array)" });
  }

  // Only forward known fields so the browser can't smuggle other options through.
  const body = {
    model: payload.model,
    messages: payload.messages.map((m) => ({
      role: m.role,
      content: String(m.content ?? ""),
      ...(Array.isArray(m.images) && m.images.length ? { images: m.images } : {}),
    })),
    stream: true,
    ...(payload.options && typeof payload.options === "object" ? { options: payload.options } : {}),
    ...(payload.keep_alive !== undefined ? { keep_alive: payload.keep_alive } : {}),
  };

  // Abort the Ollama request if the browser disconnects or presses "Stop".
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    return sendJson(res, 502, { error: `Cannot reach Ollama at ${OLLAMA_URL}: ${err.message}` });
  }

  if (!upstream.ok) {
    let message = `Ollama returned ${upstream.status}`;
    try {
      const errBody = await upstream.json();
      if (errBody?.error) message = errBody.error;
    } catch {}
    return sendJson(res, upstream.status, { error: message });
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", () => res.end());
  stream.pipe(res);
}

// ---------- Routing ----------
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    res.writeHead(400);
    return res.end();
  }
  setSecurityHeaders(req, res);
  const isGet = req.method === "GET" || req.method === "HEAD";
  const isApi = pathname.startsWith("/api/");

  try {
    if (pathname === "/api/login" && req.method === "POST") return await handleLogin(req, res, clientIp(req));
    if (pathname === "/api/logout" && req.method === "POST") return handleLogout(req, res);
    if (isGet && OPEN_FILES.has(pathname)) return await serveStatic(req, res, pathname);

    const auth = authState(req);
    if (pathname === "/login" && isGet) {
      if (auth.state === "ok" || auth.state === "off") return redirect(res, "/");
      if (auth.state === "locked") return await serveStatic(req, res, "/locked.html", 503);
      return await serveStatic(req, res, "/login.html");
    }
    if (auth.state === "locked") {
      if (auth.reason !== "not set up") console.error(`[${now()}] Login is locked: ${auth.reason}`);
      if (isApi) return sendJson(res, 503, { error: "Login isn't set up yet. On the server, run: node setup-auth.js" });
      return await serveStatic(req, res, "/locked.html", 503);
    }
    if (auth.state === "anon") {
      if (isApi) return sendJson(res, 401, { error: "Not signed in" });
      return redirect(res, "/login");
    }

    if (pathname === "/api/health" && isGet) return await handleHealth(res);
    if (pathname === "/api/models" && isGet) return await handleModels(res);
    if (pathname === "/api/chat" && req.method === "POST") return await handleChat(req, res);
    if (isApi) return sendJson(res, 404, { error: "Unknown API route" });
    if (isGet) return await serveStatic(req, res, pathname);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(`[${now()}] ${req.method} ${pathname}:`, err.message);
    if (!res.headersSent) sendJson(res, 502, { error: err.message });
    else res.end();
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[${now()}] Port ${PORT} is already in use (is Phi-nguin already running?). Set PORT to use another port.`);
  } else {
    console.error(`[${now()}] Server error:`, err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  [${now()}] Phi-nguin is running`);
  console.log(`  Ollama:   ${OLLAMA_URL}`);
  if (!AUTH_ENABLED) {
    console.log(`  Login:    DISABLED (AUTH=off). Anyone who can reach this port can use it.`);
  } else {
    const { config, error } = authStore.load();
    if (error) console.log(`  Login:    LOCKED. ${error}. Fix it or run: node setup-auth.js`);
    else if (!config) console.log(`  Login:    NOT SET UP. The app stays locked until you run: node setup-auth.js`);
    else console.log(`  Login:    password + authenticator code`);
  }
  console.log(`  Local:    http://localhost:${PORT}`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) {
          console.log(`  Network:  http://${a.address}:${PORT}`);
        }
      }
    }
  }
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
