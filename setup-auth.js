#!/usr/bin/env node
// Sets up Phi-nguin's sign-in: a password plus an authenticator app (time-based one-time codes).
//
//   node setup-auth.js                 set up, or replace, the password and authenticator
//   node setup-auth.js --backup-codes  make a new set of backup codes (the old set stops working)
//   node setup-auth.js --logout-all    sign out every device (keeps the password and authenticator)
//
// The running server notices the change automatically; no restart needed.

import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createAuthStore, createBackupCodeSet, createBackupStore, generateBackupCodes, generateSessionSecret,
  generateTotpSecret, hashPassword, saveAuthFile, totpUri, verifyTotp,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.resolve(__dirname, process.env.AUTH_FILE || "auth.json");
const BACKUP_FILE = path.resolve(__dirname, process.env.BACKUP_FILE || "backup-codes.json");
const MIN_PASSWORD = 12;
const tty = process.stdin.isTTY && process.stdout.isTTY;

const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);

// ---------- Input ----------
// In a terminal: raw-mode reading, so passwords can be masked. Otherwise (piped input): plain lines.
let lineInterface = null;
let lineReader = null;
function readLine(prompt, { mask = false } = {}) {
  process.stdout.write(prompt);
  if (!tty) {
    lineInterface ??= readline.createInterface({ input: process.stdin, terminal: false });
    lineReader ??= lineInterface[Symbol.asyncIterator]();
    return lineReader.next().then(({ value, done }) => {
      process.stdout.write("\n");
      if (done) { console.error(red("Input ended unexpectedly.")); process.exit(1); }
      return value;
    });
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const chars = [];
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { finish(); resolve(chars.join("")); return; }
        if (ch === "\u0003") { finish(); clearScreen(); console.log("Cancelled. Nothing was changed."); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") {
          if (chars.length) { chars.pop(); process.stdout.write("\b \b"); }
          continue;
        }
        if (ch < " ") continue;
        chars.push(ch);
        process.stdout.write(mask ? "*" : ch);
      }
    }
    stdin.on("data", onData);
  });
}

// Removes the QR code and key from the screen and scrollback.
function clearScreen() {
  if (tty) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

// ---------- QR code (half-block characters: two QR rows per text line) ----------
async function renderQr(text) {
  let qrcode;
  try {
    qrcode = (await import("qrcode-generator")).default;
  } catch {
    return null;
  }
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = "";
    for (let c = -quiet; c < n + quiet; c++) {
      const top = dark(r, c), bottom = dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    // Black modules on a white background, whatever the terminal's colors are.
    lines.push(`  \x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join("\n");
}

// ---------- Backup codes ----------
async function makeBackupCodes() {
  const codes = generateBackupCodes(10);
  await saveAuthFile(BACKUP_FILE, createBackupCodeSet(codes));
  return codes;
}

async function showBackupCodes(codes) {
  console.log(`${bold("Your backup codes")} ${dim("(each works once, in place of an authenticator code)")}\n`);
  for (let i = 0; i < codes.length; i += 2) {
    console.log(`    ${bold(codes[i])}      ${codes[i + 1] ? bold(codes[i + 1]) : ""}`);
  }
  console.log("\n  Save them somewhere safe, like your password manager or a printout.");
  console.log("  If you lose your phone, sign in with your password and one of these codes.\n");
  if (tty) {
    await readLine(dim("  Press Enter once you've saved them (the screen will be cleared)..."));
    clearScreen();
  }
}

// ---------- Main ----------
async function main() {
  const store = createAuthStore(AUTH_FILE);
  const existing = store.load();

  console.log(`\n${bold("Phi-nguin sign-in setup")}\n`);

  if (process.argv.includes("--backup-codes")) {
    const codes = await makeBackupCodes();
    console.log(green("✓ New backup codes created.") + " Any previous backup codes no longer work.\n");
    await showBackupCodes(codes);
    if (tty) console.log(green("✓ Backup codes saved.") + "\n");
    return;
  }

  if (process.argv.includes("--logout-all")) {
    if (!existing.config) {
      console.log(red("Sign-in isn't set up yet, so there's nobody to sign out."));
      process.exit(1);
    }
    await saveAuthFile(AUTH_FILE, { ...existing.config, sessionSecret: generateSessionSecret() });
    console.log(green("✓ Every device has been signed out.") + " Sign in again with your password and a code.\n");
    return;
  }

  if (existing.config) {
    console.log("Sign-in is already set up. Continuing replaces the password and the authenticator,");
    console.log("and signs out every device.\n");
    const answer = await readLine("Continue? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) { console.log("Nothing was changed."); return; }
  } else if (existing.error) {
    console.log(red(`The existing ${path.basename(AUTH_FILE)} can't be used (${existing.error}). It will be replaced.\n`));
  }

  // 1) Password
  console.log(`${bold("Step 1 of 2:")} choose a password ${dim(`(at least ${MIN_PASSWORD} characters; a passphrase works well)`)}`);
  let password;
  for (;;) {
    const first = await readLine("  Password: ", { mask: true });
    if ([...first].length < MIN_PASSWORD) { console.log(red(`  Too short. Use at least ${MIN_PASSWORD} characters.`)); continue; }
    if (new Set(first).size < 4) { console.log(red("  Too simple. Use a mix of different characters.")); continue; }
    const second = await readLine("  Type it again: ", { mask: true });
    if (first !== second) { console.log(red("  The passwords don't match. Try again.")); continue; }
    password = first;
    break;
  }

  // 2) Authenticator
  const secret = generateTotpSecret();
  const uri = totpUri(secret, os.hostname());
  console.log(`\n${bold("Step 2 of 2:")} add Phi-nguin to your authenticator app`);
  console.log(dim("  (Google Authenticator, Microsoft Authenticator, 1Password, Authy, Bitwarden, ...)\n"));
  const qr = await renderQr(uri);
  if (qr) {
    console.log("  Scan this QR code with the app:\n");
    console.log(qr);
    console.log("");
  } else {
    console.log(dim("  (Run `npm install` in this folder to show a QR code here.)\n"));
  }
  console.log("  Can't scan it? Add an account manually with this key (time-based, 6 digits):");
  console.log(`  ${bold(secret.match(/.{1,4}/g).join(" "))}\n`);

  let verified = false;
  for (let attempt = 1; attempt <= 5 && !verified; attempt++) {
    const code = await readLine("  Enter the 6-digit code the app shows: ");
    if (verifyTotp(secret, code) !== null) verified = true;
    else console.log(red("  That code doesn't match. Use the newest code, and check that this computer's clock is right."));
  }
  if (!verified) {
    clearScreen();
    console.log(red("Setup cancelled: the codes didn't match. Nothing was changed. Run this again to retry."));
    process.exit(1);
  }

  await saveAuthFile(AUTH_FILE, {
    version: 1,
    passwordHash: await hashPassword(password),
    totpSecret: secret,
    sessionSecret: generateSessionSecret(),
    createdAt: new Date().toISOString(),
  });

  clearScreen();

  // Backup codes: create a set the first time; otherwise keep the existing ones.
  const backups = createBackupStore(BACKUP_FILE).load();
  let backupNote;
  if (backups.config && backups.config.hashes.length > 0) {
    backupNote = `Your existing backup codes still work (${backups.config.hashes.length} left).`;
  } else {
    console.log("");
    await showBackupCodes(await makeBackupCodes());
    backupNote = "Your 10 backup codes are active.";
  }

  console.log(`\n${green("✓ Sign-in is set up.")}\n`);
  console.log("  Open Phi-nguin and sign in with your password and a code from the app.");
  console.log("  The running server picks this up automatically; no restart needed.");
  console.log(`  ${backupNote}\n`);
  console.log(dim(`  ${path.basename(AUTH_FILE)} holds your password hash and authenticator secret. Keep it private.`));
  console.log(dim("  New backup codes:            node setup-auth.js --backup-codes"));
  console.log(dim("  Sign out every device:       node setup-auth.js --logout-all\n"));
}

main()
  .then(() => lineInterface?.close()) // release piped stdin so the process can exit
  .catch((err) => {
    console.error(red(`\nSetup failed: ${err.message}`));
    process.exit(1);
  });
