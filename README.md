# Phi-nguin

A lightweight chat web app for your local [Ollama](https://ollama.com) server. It runs on this
machine and can be opened from any browser, here, on your network, or from the internet through an
HTTPS tunnel. It's protected by a **password plus authenticator-app code**.

- Sign-in with a password and an authenticator code (TOTP), plus single-use backup codes
- Streaming replies, with a Stop button
- Model picker (lists every model installed in Ollama)
- Chat history in the sidebar (saved in each browser's local storage)
- Markdown rendering, code blocks with a Copy button, and tables
- System prompt, temperature, and context-window settings
- Image attachments for vision models (e.g. `llava`, `gemma3`, `llama3.2-vision`)
- Collapsible "thinking" output for reasoning models (e.g. `deepseek-r1`, `qwen3`)
- Light and dark themes, and a mobile-friendly layout
- The server has no dependencies and no build step. It needs only Node.js 18+.

## Sign-in

Until sign-in is set up, the app is **locked for everyone** and shows setup instructions.

**Set it up** (in a terminal, in this folder):

```bash
node setup-auth.js
```

It asks for a password (at least 12 characters) and shows a QR code to scan with an authenticator app
(Google Authenticator, Microsoft Authenticator, 1Password, Authy, Bitwarden...). It saves nothing until
you've entered a correct code from the app, then clears the screen. The running server picks up the change
right away, with no restart.

**Signing in:** enter the password and the 6-digit code from the app. There's no username. Tick
*Keep me signed in* to stay signed in on that device for 30 days. Otherwise the session ends when the
browser closes, or after 12 hours at most.

**Backup codes:** 10 single-use codes, like `k7m2-qp9x`. Each one can replace an authenticator code
once, in case you lose your phone; your password is still required. On the sign-in page, click
*Use a backup code instead*. Keep them in your password manager or on paper.

| To…                                    | Run                                   |
|----------------------------------------|---------------------------------------|
| Change the password or authenticator   | `node setup-auth.js` (keeps your backup codes) |
| Get a new set of backup codes          | `node setup-auth.js --backup-codes` (the old set stops working) |
| Sign out every device                  | `node setup-auth.js --logout-all`     |

`auth.json` (password hash, authenticator secret, session key) and `backup-codes.json` (hashed backup
codes) live in this folder. Keep them private and don't share or commit them. Deleting `auth.json` locks
the app again until you rerun setup.

### How it's protected

- Passwords are hashed with scrypt; backup codes are stored only as salted hashes.
- Each authenticator code works only once, and each backup code is deleted after use.
- **Rate limits:** 5 sign-in attempts per IP address per 15 minutes, and 50 attempts per hour in total,
  then a short lockout. Failed and successful sign-ins are logged with the IP address in `logs\server.log`.
- Error messages never say whether the password or the code was wrong.
- **Sessions:** signed (HMAC), expiring cookies set `HttpOnly` and `SameSite=Lax`, plus `Secure` over HTTPS.
- Requests that change things must be JSON, which blocks cross-site form attacks.
- **Strict security headers:** Content-Security-Policy, no framing, nosniff, no-referrer, and HSTS over HTTPS.
- If `auth.json` is missing or corrupt, the app stays locked rather than opening up.
- Only chat and the model list are passed through to Ollama. Pull, delete and create are never exposed.

## Putting it on the internet

**Use HTTPS.** Over plain `http://`, your password and session cookie travel unencrypted. Don't just
forward port 3000 on your router. Use a tunnel that adds HTTPS instead:

- **Tailscale Funnel** (Tailscale is already installed here): `tailscale funnel --bg 3000` publishes
  `https://<this-pc>.<your-tailnet>.ts.net`. Funnel must be allowed for your tailnet in the Tailscale
  admin console.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:3000`, or a named tunnel on your
  own domain.

Both connect from this PC, so no router changes are needed. Phi-nguin reads the visitor's real IP
address (for rate limiting) and the HTTPS status from these local tunnels' headers, and trusts those
headers only from connections that come from this PC itself.

## Run it

Phi-nguin **starts automatically when you log in to Windows**. It runs in the background with no
window, through the scheduled task **"Phi-nguin"**. Open <http://localhost:3000>, or from another device
`http://192.168.0.110:3000`.

| To…                         | Do this                                                                 |
|-----------------------------|-------------------------------------------------------------------------|
| Stop the background server  | Double-click **`stop.bat`**                                             |
| Start it again now          | `schtasks /Run /TN "Phi-nguin"` (or log out and back in)                 |
| See its output / errors     | Open `logs\server.log`                                                  |
| Turn auto-start off         | `schtasks /Change /TN "Phi-nguin" /DISABLE` (or Task Scheduler → Phi-nguin → Disable) |
| Remove auto-start entirely  | `schtasks /Delete /TN "Phi-nguin" /F`                                   |

The background launcher (`run-hidden.vbs`) restarts the server within about 10 seconds if it ever crashes.

To run it in a visible window instead, run `stop.bat` first, then double-click **`start.bat`**, or run
`node server.js`.

Ollama itself is started at logon by your separate **"Ollama Server"** scheduled task. If Ollama starts
later than Phi-nguin, the app shows "Ollama offline" and reconnects on its own within 15 seconds.

## Change the logo

Save your logo image in this folder as `logo-source.png` or `logo-source.jpg`. The current one is
`logo-source.png.jpg`. Then run:

```bash
powershell -ExecutionPolicy Bypass -File make-logo.ps1
```

It finds the artwork on the image's plain background and crops a square around all of it. It then writes
rounded-square icons to `public\`: `icon-32.png` (browser tab), `icon-192.png` (sidebar and chat avatar),
`icon-320.png` (welcome screen), `icon-512.png`, and `apple-touch-icon.png` (phone home screen). Reload the page to see it.

The dark theme's background (`--bg` in `public/style.css`) is set to the logo's background color, `#17182b`,
so the logo blends in. The script prints the new logo's background color, so you can match it there.

## Add more models

On this machine:

```bash
ollama pull llama3.2
```

Reload the page and the new model appears in the picker.

## Configuration

Set these environment variables, or uncomment them in `start.bat`:

| Variable      | Default                  | Purpose                                                        |
|---------------|--------------------------|----------------------------------------------------------------|
| `PORT`        | `3000`                   | Port the web app listens on                                    |
| `HOST`        | `0.0.0.0`                | `0.0.0.0` = reachable from your network; `127.0.0.1` = this PC only (fine when using a tunnel) |
| `OLLAMA_URL`  | `http://127.0.0.1:11434` | Where Ollama is running                                        |
| `AUTH`        | `on`                     | `off` disables sign-in entirely. Only do this if the app is never reachable by others. |
| `AUTH_FILE`   | `auth.json`              | Where the sign-in settings are stored                          |
| `BACKUP_FILE` | `backup-codes.json`      | Where the hashed backup codes are stored                       |

## Access from your network

- **Same network:** open `http://<this-PC's-IP>:3000`. Windows Firewall must allow Node.js inbound on
  the active network profile.
- **Tailscale (private, tailnet only):** open `http://100.94.115.38:3000` from another device on your
  tailnet. Windows treats the Tailscale adapter as a *Private* network, so Node.js must also be allowed on
  the Private profile (Windows Security → Firewall & network protection → Allow an app through firewall →
  Node.js → tick *Private*).

Chats are stored in each browser, not on the server.

## Files

```
server.js           Node HTTP server: login gate, static files, /api/* (streaming proxy to Ollama)
auth.js             Password hashing, TOTP, backup codes, session tokens, rate limiting
setup-auth.js       Sets up sign-in, makes backup codes, signs out all devices
auth.json           Your sign-in settings (created by setup; keep private)
backup-codes.json   Hashed backup codes (keep private)
public/index.html   App layout
public/login.html   Sign-in page (+ login.js); locked.html is shown before setup
public/style.css    Styles (light/dark, responsive)
public/app.js       Chat logic: streaming, history, settings
public/markdown.js  Small, safe Markdown renderer (all HTML is escaped)
start.bat           Run the server in a visible window
stop.bat            Stop the background (auto-started) server
run-hidden.vbs      Background launcher used by the "Phi-nguin" logon task; restarts on crash
make-logo.ps1       Builds the icons in public\ from logo-source.png
logs/server.log     Output from the background server, including sign-in attempts
```

`setup-auth.js` uses one small package, `qrcode-generator` (MIT, no dependencies of its own), to draw
the QR code. If `node_modules` is missing, run `npm install`. Without it, setup still works, but you'll
type the key into your app by hand.
