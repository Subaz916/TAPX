/* =============================================================================
 * TAPX - js/security.js
 * -----------------------------------------------------------------------------
 * Input validation, sanitisation and honest client-side anti-abuse helpers.
 *
 * IMPORTANT, PLEASE READ:
 *   Nothing in this file is a security boundary. Anyone can open devtools and
 *   call these functions with whatever they like. The real protections live in
 *   PostgreSQL (RLS, column grants, guard triggers, SECURITY DEFINER RPCs).
 *   These helpers exist to give immediate feedback and to keep obviously
 *   invalid data out of the UI and out of the network.
 * ========================================================================== */

import { CONFIG } from "./config.js";

/* -----------------------------------------------------------------------------
 * Number guards
 * -------------------------------------------------------------------------- */

/** True for a finite number (rejects NaN, Infinity, -Infinity, strings). */
export function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/** Coerce anything into a safe non-negative integer, or `fallback`. */
export function safeInt(value, fallback = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!isFiniteNumber(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** Big values (coins, taps) travel as numbers in JSON; keep them in range. */
export function safeBigInt(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  return safeInt(value, fallback, { min: 0, max });
}

/** Never let a balance go negative. */
export function clampNonNegative(value) {
  return isFiniteNumber(value) && value > 0 ? value : 0;
}

/** Round to `dp` decimal places, guarding against NaN. */
export function round(value, dp = 2) {
  if (!isFiniteNumber(value)) return 0;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/* -----------------------------------------------------------------------------
 * String guards
 * -------------------------------------------------------------------------- */

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidUsername(value) {
  return typeof value === "string" && USERNAME_RE.test(value.toLowerCase());
}

export function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

/** Supabase's default minimum. */
export function isValidPassword(value) {
  return typeof value === "string" && value.length >= 6 && value.length <= 72;
}

/**
 * Escape a string before it is inserted with innerHTML.
 * Always prefer textContent; this exists for the few places that build markup.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip characters that have no business in a username. */
export function sanitiseUsername(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

/** Cap free text coming from the database or the network. */
export function clampText(value, max = 500) {
  return String(value ?? "").slice(0, max);
}

/* -----------------------------------------------------------------------------
 * Tap cadence guard (client side UX only)
 * -------------------------------------------------------------------------- */

/**
 * Simple sliding-window tap tracker used to ignore physically impossible
 * bursts (accidental double-fire from a stuck pointer, a stuck key repeat,
 * a browser dispatching two events for one press, ...).
 *
 * The database performs the authoritative check in process_tap().
 */
export function createTapGuard({ minIntervalMs = CONFIG.minTapIntervalMs, maxPerSecond = 20 } = {}) {
  let last = 0;
  const window = [];

  return {
    /** @returns {boolean} true when the tap is plausible and should count. */
    accept(now = Date.now()) {
      if (now - last < minIntervalMs) return false;
      last = now;

      while (window.length && now - window[0] > 1000) window.shift();
      window.push(now);
      if (window.length > maxPerSecond) {
        window.shift();
        return false;
      }
      return true;
    },
    reset() {
      last = 0;
      window.length = 0;
    }
  };
}

/**
 * Tracks how fast the player is tapping so the combo meter can react.
 * @returns {{update: (now?:number)=>{avgInterval:number, alive:boolean, taps:number}}}
 */
export function createComboTracker(windowMs = CONFIG.comboWindowMs) {
  let taps = [];
  return {
    update(now = Date.now()) {
      taps.push(now);
      while (taps.length && now - taps[0] > windowMs) taps.shift();
      if (taps.length < 2) return { avgInterval: windowMs, alive: taps.length > 0, taps: taps.length };
      let total = 0;
      for (let i = 1; i < taps.length; i += 1) total += taps[i] - taps[i - 1];
      return { avgInterval: total / (taps.length - 1), alive: true, taps: taps.length };
    },
    reset() {
      taps = [];
    }
  };
}

/* -----------------------------------------------------------------------------
 * Request de-duplication
 * -------------------------------------------------------------------------- */

/**
 * Guarantees only one in-flight call per key. Duplicate clicks on a button
 * (double tap, impatient user) reuse the pending promise instead of firing a
 * second request - important for daily rewards and upgrades.
 */
const inflight = new Map();

export function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Client-side cooldown, for UI buttons. */
const cooldowns = new Map();

export function cooldown(key, ms) {
  const now = Date.now();
  const until = cooldowns.get(key) ?? 0;
  if (now < until) return Math.ceil((until - now) / 1000);
  cooldowns.set(key, now + ms);
  return 0;
}

/* -----------------------------------------------------------------------------
 * localStorage (UI preferences only - never balances)
 * -------------------------------------------------------------------------- */

export function readPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // private mode / storage full - preferences just will not persist
  }
}

export function clearPrefs() {
  try {
    Object.values(CONFIG.storage).forEach((k) => window.localStorage.removeItem(k));
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Session timeout (inactive tab protection)
 * -------------------------------------------------------------------------- */

export function createIdleWatcher(onIdle, idleMs = 30 * 60 * 1000) {
  let timer = null;
  const reset = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(onIdle, idleMs);
  };
  ["pointerdown", "keydown", "visibilitychange"].forEach((evt) =>
    window.addEventListener(evt, reset, { passive: true })
  );
  reset();
  return () => window.clearTimeout(timer);
}
