// Authentication helpers for Phi-nguin, using only Node's built-in crypto:
//  - password hashing with scrypt
//  - TOTP one-time codes (RFC 6238, compatible with Google/Microsoft Authenticator, 1Password, Authy...)
//  - signed, expiring session tokens (HMAC-SHA256)
//  - a login rate limiter (per client IP plus a global cap)

import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";

// ---------- Base32 (RFC 4648), used for TOTP secrets ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- Passwords (scrypt) ----------
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const MAX_PASSWORD_LENGTH = 1024;

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)));
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password).normalize("NFKC"), salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const pw = String(password ?? "");
  if (!pw || pw.length > MAX_PASSWORD_LENGTH) return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scryptAsync(pw.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

// ---------- TOTP (RFC 6238: SHA-1, 6 digits, 30-second steps) ----------
const STEP_MS = 30_000;

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));
export const totpCounter = (now = Date.now()) => Math.floor(now / STEP_MS);

export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

export const totpCode = (secret, now = Date.now()) => hotp(base32Decode(secret), totpCounter(now));

// Returns the matching time-step counter, or null. Accepts the previous, current and next code
// (to tolerate clock drift) but never a counter at or before `lastUsedCounter`, so a code that
// was already used can't be replayed.
export function verifyTotp(secret, code, lastUsedCounter = -1, now = Date.now()) {
  const given = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const key = base32Decode(secret);
  const current = totpCounter(now);
  let match = null;
  for (const c of [current - 1, current, current + 1]) {
    if (c <= lastUsedCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, c)), Buffer.from(given))) match = c;
  }
  return match;
}

export function totpUri(secret, account) {
  const issuer = "Phi-nguin";
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- Session tokens ----------
// Format: <expiry, base36 ms>.<random nonce>.<HMAC-SHA256 signature>
const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");

export function createSessionToken(sessionSecret, maxAgeMs, now = Date.now()) {
  const payload = `${(now + maxAgeMs).toString(36)}.${crypto.randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(sessionSecret, payload)}`;
}

export function verifySessionToken(sessionSecret, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 200) return false;
  const i = token.lastIndexOf(".");
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(sessionSecret, payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return false;
  const expiry = parseInt(payload.split(".")[0], 36);
  return Number.isFinite(expiry) && now < expiry;
}

export const generateSessionSecret = () => crypto.randomBytes(32).toString("base64url");

// ---------- Backup codes ----------
// Single-use codes that can replace an authenticator code (the password is still required).
// Only salted SHA-256 hashes are stored. 8 characters from a 31-letter alphabet is about
// 40 bits each, far beyond reach with the login rate limits.
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i look-alikes

export function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    let s = "";
    for (let i = 0; i < 8; i++) s += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normalizeBackupCode = (code) => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");
export const looksLikeBackupCode = (code) => /^[a-z0-9]{8}$/.test(normalizeBackupCode(code)) && !/^\d+$/.test(normalizeBackupCode(code));

const hashBackupCode = (code, salt) =>
  crypto.createHash("sha256").update(`${salt}:${normalizeBackupCode(code)}`).digest("base64url");

export function createBackupCodeSet(codes) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return { version: 1, salt, hashes: codes.map((c) => hashBackupCode(c, salt)), createdAt: new Date().toISOString() };
}

// Index of the matching unused code, or -1. Compares against every entry in constant time.
export function findBackupCode(set, code) {
  if (!set || !Array.isArray(set.hashes) || !looksLikeBackupCode(code)) return -1;
  const given = Buffer.from(hashBackupCode(code, set.salt));
  let found = -1;
  set.hashes.forEach((h, i) => {
    const stored = Buffer.from(String(h));
    if (stored.length === given.length && crypto.timingSafeEqual(stored, given)) found = i;
  });
  return found;
}

// ---------- JSON files (auth.json, backup-codes.json) ----------
// Re-reads the file whenever it changes, so running setup-auth.js takes effect without a restart.
// load() returns { config } when present, { config: null } when the file doesn't exist,
// or { error } when it exists but is unreadable or invalid (callers must fail closed).
function createJsonFileStore(file, validate) {
  let cached = null;
  let cachedMtime = -1;
  return {
    file,
    load() {
      let st;
      try {
        st = statSync(file);
      } catch (err) {
        if (err.code === "ENOENT") { cached = null; cachedMtime = -1; return { config: null }; }
        return { error: err.message };
      }
      if (st.mtimeMs !== cachedMtime) {
        try {
          const cfg = JSON.parse(readFileSync(file, "utf8"));
          validate(cfg);
          cached = cfg;
          cachedMtime = st.mtimeMs;
        } catch (err) {
          return { error: `${file.split(/[\\/]/).pop()} is invalid (${err.message})` };
        }
      }
      return { config: cached };
    },
  };
}

export const createAuthStore = (file) => createJsonFileStore(file, (cfg) => {
  if (!cfg.passwordHash || !cfg.totpSecret || !cfg.sessionSecret) throw new Error("missing fields");
  base32Decode(cfg.totpSecret);
});

export const createBackupStore = (file) => createJsonFileStore(file, (cfg) => {
  if (typeof cfg.salt !== "string" || !Array.isArray(cfg.hashes)) throw new Error("missing fields");
});

export async function saveAuthFile(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

// ---------- Login rate limiting ----------
// Each attempt counts as soon as it starts (so parallel guesses can't slip past the limit) and
// is cleared for that IP on a successful sign-in.
export function createLoginLimiter({
  perIp = 5, perIpWindowMs = 15 * 60_000,
  global = 50, globalWindowMs = 60 * 60_000,
} = {}) {
  const byIp = new Map();
  const globalHits = [];
  const prune = (hits, windowMs, now) => { while (hits.length && hits[0] <= now - windowMs) hits.shift(); };

  return {
    // Milliseconds until another attempt is allowed from this IP (0 = allowed now).
    retryAfter(ip, now = Date.now()) {
      prune(globalHits, globalWindowMs, now);
      const hits = byIp.get(ip);
      if (hits) { prune(hits, perIpWindowMs, now); if (!hits.length) byIp.delete(ip); }
      let wait = 0;
      if (hits && hits.length >= perIp) wait = hits[0] + perIpWindowMs - now;
      if (globalHits.length >= global) wait = Math.max(wait, globalHits[0] + globalWindowMs - now);
      return Math.max(0, wait);
    },
    attempt(ip, now = Date.now()) {
      let hits = byIp.get(ip);
      if (!hits) {
        if (byIp.size >= 10_000) byIp.delete(byIp.keys().next().value);
        hits = [];
        byIp.set(ip, hits);
      }
      hits.push(now);
      globalHits.push(now);
    },
    succeeded(ip) {
      byIp.delete(ip);
      globalHits.pop();
    },
  };
}
