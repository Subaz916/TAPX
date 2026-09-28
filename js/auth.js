/* =============================================================================
 * TAPX - js/auth.js
 * -----------------------------------------------------------------------------
 * Login, registration, password reset and the admin route guard.
 *
 * Authorisation is decided by the database (the admin_users table + RLS), never
 * by an email address or a flag in localStorage. isAdmin() asks the server.
 * ========================================================================== */

import { CONFIG, pageUrl } from "./config.js";
import { initSupabase, supabase, getUser, friendlyError, isNetworkError, onAuthStateChange } from "./supabase.js";
import { isValidEmail, isValidPassword, isValidUsername, sanitiseUsername, readPref, writePref } from "./security.js";
import { $, $$, toast, feedback, setBusy, buttonBusy, bindSheetTriggers, bindSheetDismiss } from "./ui.js";

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

/** Only allow same-site relative redirects (no open-redirect abuse). */
export function safeNext(raw, fallback = "index.html") {
  if (typeof raw !== "string" || !raw) return fallback;
  const decoded = decodeURIComponent(raw);
  if (/^(https?:)?\/\//i.test(decoded) || decoded.startsWith("//") || decoded.includes("..")) {
    return fallback;
  }
  const clean = decoded.replace(/[^\w.-]/g, "");
  return clean || fallback;
}

function fieldError(sel, message) {
  const node = $(sel);
  if (!node) return;
  node.textContent = message || "";
  node.hidden = !message;
}

function clearErrors() {
  $$(".field-error").forEach((n) => {
    n.textContent = "";
    n.hidden = true;
  });
}

/** Honeypot: real people never fill a hidden field. */
function honeypotTripped(form) {
  const trap = form.querySelector('input[name="website"]');
  return trap && trap.value.trim().length > 0;
}

/* -----------------------------------------------------------------------------
 * Sign in
 * -------------------------------------------------------------------------- */

export function initLogin() {
  const form = $("#login-form");
  if (!form) return;
  commonInit();

  const lastUser = readPref(CONFIG.storage.lastUsername, "");
  const identifier = $("#login-email");
  if (identifier && lastUser && !identifier.value) identifier.value = lastUser;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    if (honeypotTripped(form)) return;

    const email = identifier.value.trim();
    const password = $("#login-password").value;
    const next = safeNext(new URLSearchParams(window.location.search).get("next"), "index.html");

    if (!email) return fieldError("#error-email", "Enter your email or username.");
    if (!password) return fieldError("#error-password", "Enter your password.");

    const btn = $("#login-submit");
    buttonBusy(btn, true, "Signing in...");
    setBusy(true, "Signing in...");

    try {
      const sb = await initSupabase();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      writePref(CONFIG.storage.lastUsername, email.split("@")[0]);
      feedback("reward");
      window.location.replace(pageUrl(next));
    } catch (err) {
      const message =
        err?.message === "Invalid login credentials"
          ? "Incorrect email or password."
          : friendlyError(err);
      fieldError("#error-form", message);
      feedback("error");
      if (isNetworkError(err)) toast("No internet connection.", "error");
    } finally {
      buttonBusy(btn, false);
      setBusy(false);
    }
  });
}

/* -----------------------------------------------------------------------------
 * Register
 * -------------------------------------------------------------------------- */

export function initRegister() {
  const form = $("#register-form");
  if (!form) return;
  commonInit();

  const username = $("#register-username");
  const email = $("#register-email");
  const password = $("#register-password");
  const confirm = $("#register-password-confirm");
  const terms = $("#register-terms");

  // Live username validation.
  username?.addEventListener("input", () => {
    const value = sanitiseUsername(username.value);
    if (username.value !== value) username.value = value;
    fieldError("#error-username", isValidUsername(value) ? "" : "3-24 characters: a-z, 0-9 or _.");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    if (honeypotTripped(form)) return;

    const u = sanitiseUsername(username.value);
    const e_ = email.value.trim();
    const p = password.value;
    const p2 = confirm.value;
    const next = safeNext(new URLSearchParams(window.location.search).get("next"), "index.html");

    if (!isValidUsername(u)) return fieldError("#error-username", "Pick a username of 3-24 characters (a-z, 0-9, _).");
    if (!isValidEmail(e_)) return fieldError("#error-email", "Enter a valid email address.");
    if (!isValidPassword(p)) return fieldError("#error-password", "Use at least 6 characters.");
    if (p !== p2) return fieldError("#error-password-confirm", "The passwords do not match.");
    if (terms && !terms.checked) return fieldError("#error-terms", "Please accept the Terms and Privacy Policy.");

    const btn = $("#register-submit");
    buttonBusy(btn, true, "Creating account...");
    setBusy(true, "Creating your account...");

    try {
      const sb = await initSupabase();
      const { data, error } = await sb.auth.signUp({
        email: e_,
        password: p,
        options: {
          data: { username: u },
          emailRedirectTo: new URL(pageUrl(next), window.location.origin).href
        }
      });
      if (error) throw error;

      writePref(CONFIG.storage.lastUsername, u);

      if (data.session) {
        // Email confirmation disabled in this project.
        feedback("reward");
        window.location.replace(pageUrl(next));
        return;
      }

      // Email confirmation enabled (recommended for production).
      showVerifyPanel(e_);
    } catch (err) {
      const msg = String(err.message || "");
      if (/already registered|already exists/i.test(msg)) {
        fieldError("#error-email", "An account with that email already exists.");
      } else if (/rate limit|too many/i.test(msg)) {
        fieldError("#error-form", "Too many attempts. Please wait a minute and try again.");
      } else {
        fieldError("#error-form", friendlyError(err));
      }
      feedback("error");
    } finally {
      buttonBusy(btn, false);
      setBusy(false);
    }
  });
}

function showVerifyPanel(emailAddress) {
  const form = $("#register-form");
  const panel = $("#verify-panel");
  if (!panel) return;
  form?.setAttribute("hidden", "");
  panel.removeAttribute("hidden");
  const target = panel.querySelector("[data-verify-email]");
  if (target) target.textContent = emailAddress;
  toast("Check your inbox to confirm your email address.", "success", 5000);
}

/* -----------------------------------------------------------------------------
 * Forgot / reset password
 * -------------------------------------------------------------------------- */

export function initForgotPassword() {
  const form = $("#forgot-form");
  if (!form) return;
  commonInit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    if (honeypotTripped(form)) return;

    const email = $("#forgot-email").value.trim();
    if (!isValidEmail(email)) return fieldError("#error-email", "Enter a valid email address.");

    const btn = $("#forgot-submit");
    buttonBusy(btn, true, "Sending...");

    try {
      const sb = await initSupabase();
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: new URL(pageUrl("reset-password.html"), window.location.origin).href
      });
      if (error) throw error;
      // Always show the same message: do not leak whether the account exists.
      $("#forgot-form")?.setAttribute("hidden", "");
      $("#forgot-done")?.removeAttribute("hidden");
      toast("If that email is registered, a reset link is on its way.", "success", 5000);
    } catch (err) {
      fieldError("#error-form", friendlyError(err));
    } finally {
      buttonBusy(btn, false);
    }
  });
}

export function initResetPassword() {
  const form = $("#reset-form");
  if (!form) return;
  commonInit();

  // The recovery link puts tokens in the URL hash; supabase-js picks them up
  // automatically (detectSessionInUrl). We only need to know it worked.
  const check = async () => {
    const sb = await initSupabase();
    const { data } = await sb.auth.getSession();
    const ok = Boolean(data.session);
    $("#reset-waiting")?.setAttribute("hidden", ok ? "" : "hidden");
    form?.removeAttribute("hidden");
    if (!ok) {
      $("#reset-note").textContent =
        "Open this page from the reset link in your email. The link expires after a short time.";
    }
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();

    const p = $("#reset-password").value;
    const p2 = $("#reset-password-confirm").value;
    if (!isValidPassword(p)) return fieldError("#error-password", "Use at least 6 characters.");
    if (p !== p2) return fieldError("#error-password-confirm", "The passwords do not match.");

    const btn = $("#reset-submit");
    buttonBusy(btn, true, "Updating...");

    try {
      const sb = supabase();
      const { error } = await sb.auth.updateUser({ password: p });
      if (error) throw error;
      toast("Password updated. You are signed in.", "success");
      window.setTimeout(() => window.location.replace(pageUrl("index.html")), 900);
    } catch (err) {
      fieldError("#error-form", friendlyError(err));
    } finally {
      buttonBusy(btn, false);
    }
  });

  void check();
}

/* -----------------------------------------------------------------------------
 * Admin guard
 * -------------------------------------------------------------------------- */

/**
 * Verify admin rights with the server.
 * There is no email check and no client-side flag anywhere in this project.
 * @returns {Promise<boolean>}
 */
export async function isAdmin() {
  try {
    const sb = await initSupabase();
    const { data, error } = await sb.rpc("is_admin", {});
    if (error) throw error;
    return data === true;
  } catch (err) {
    console.warn("[auth] admin check failed", friendlyError(err));
    return false;
  }
}

/** Redirect to the login page unless the user is a verified administrator. */
export async function requireAdmin() {
  const user = await getUser();
  if (!user) {
    window.location.replace(pageUrl("login.html?next=admin.html"));
    return false;
  }
  const allowed = await isAdmin();
  if (!allowed) {
    toast("Administrator access is required for that page.", "error", 5000);
    window.setTimeout(() => window.location.replace(pageUrl("index.html")), 1200);
    return false;
  }
  return true;
}

/* -----------------------------------------------------------------------------
 * Shared
 * -------------------------------------------------------------------------- */

function commonInit() {
  bindSheetTriggers();
  bindSheetDismiss();

  // Already signed in? Skip the form.
  onAuthStateChange(async (event, session) => {
    if (!session) return;
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") {
      const onAuthPage = /login\.html|register\.html|forgot-password\.html|reset-password\.html/.test(
        window.location.pathname
      );
      if (!onAuthPage) return;
      // reset-password.html must stay put so the new password can be set.
      if (/reset-password\.html/.test(window.location.pathname)) return;
      const next = safeNext(new URLSearchParams(window.location.search).get("next"), "index.html");
      window.location.replace(pageUrl(next));
    }
  });

  // Toggle password visibility
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-toggle-password]");
    if (!btn) return;
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    btn.textContent = isPassword ? "Hide" : "Show";
    btn.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
  });
}
