(() => {
  "use strict";

  // Use the theme chosen in the app (stored per browser).
  try {
    const theme = JSON.parse(localStorage.getItem("olc.settings.v1") || "{}").theme;
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {}

  const form = document.getElementById("loginForm");
  const password = document.getElementById("password");
  const code = document.getElementById("code");
  const remember = document.getElementById("remember");
  const error = document.getElementById("error");
  const submit = document.getElementById("submit");
  const codeLabel = document.getElementById("codeLabel");
  const codeMode = document.getElementById("codeMode");
  let lockTimer = null;
  let backupMode = false;

  function setBackupMode(on) {
    backupMode = on;
    code.value = "";
    codeLabel.textContent = on ? "Backup code" : "Authenticator code";
    code.inputMode = on ? "text" : "numeric";
    code.autocomplete = on ? "off" : "one-time-code";
    code.maxLength = on ? 9 : 6;
    code.placeholder = on ? "xxxx-xxxx" : "000000";
    code.classList.toggle("backup", on);
    codeMode.textContent = on ? "Use an authenticator code instead" : "Use a backup code instead";
    showError("");
    code.focus();
  }
  codeMode.addEventListener("click", () => setBackupMode(!backupMode));

  function showError(text) {
    error.textContent = text;
    error.hidden = !text;
  }

  function lockFor(seconds) {
    clearInterval(lockTimer);
    const until = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(lockTimer);
        submit.disabled = false;
        submit.textContent = "Sign in";
        showError("");
        return;
      }
      submit.disabled = true;
      const m = Math.floor(left / 60), s = String(left % 60).padStart(2, "0");
      submit.textContent = `Try again in ${m}:${s}`;
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  // Keep the code field digits-only, and submit as soon as 6 digits are in (if the password is filled).
  code.addEventListener("input", () => {
    if (backupMode) return;
    const digits = code.value.replace(/\D/g, "").slice(0, 6);
    if (digits !== code.value) code.value = digits;
    if (digits.length === 6 && password.value && !submit.disabled) form.requestSubmit();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    if (!password.value) { showError("Enter your password."); password.focus(); return; }
    if (backupMode) {
      if (!/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code.value.trim())) {
        showError("Enter one of your backup codes, like k7m2-qp9x."); code.focus(); return;
      }
    } else if (!/^\d{6}$/.test(code.value)) {
      showError("Enter the 6-digit code from your authenticator app."); code.focus(); return;
    }

    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.value, code: code.value.trim(), remember: remember.checked }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        submit.textContent = "Signed in";
        location.replace("/");
        return;
      }
      showError(data.error || `Sign-in failed (${res.status}).`);
      code.value = "";
      if (res.status === 429 && data.retryAfter) {
        lockFor(data.retryAfter);
        return;
      }
      code.focus();
    } catch {
      showError("Can't reach the server. Check your connection and try again.");
    }
    submit.disabled = false;
    submit.textContent = "Sign in";
  });
})();
