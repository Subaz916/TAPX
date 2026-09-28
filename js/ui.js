/* =============================================================================
 * TAPX - js/ui.js
 * -----------------------------------------------------------------------------
 * Presentation helpers shared by every page: event bus, toasts, modals,
 * number/date formatting, the floating "+coins" layer, progress bars and the
 * optional WebAudio click (no audio files required).
 * ========================================================================== */

import { escapeHtml, isFiniteNumber, round } from "./security.js";

/* -----------------------------------------------------------------------------
 * Tiny event bus - lets modules talk without importing each other
 * -------------------------------------------------------------------------- */

const bus = new EventTarget();

export function on(type, handler) {
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/* -----------------------------------------------------------------------------
 * DOM helpers
 * -------------------------------------------------------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function setText(sel, value) {
  const nodes = $$(sel);
  nodes.forEach((n) => {
    n.textContent = value;
  });
  return nodes.length;
}

export function setHidden(sel, hidden) {
  const node = typeof sel === "string" ? $(sel) : sel;
  if (node) node.hidden = Boolean(hidden);
}

export function toggleClass(sel, className, on) {
  const node = typeof sel === "string" ? $(sel) : sel;
  if (node) node.classList.toggle(className, Boolean(on));
}

/* -----------------------------------------------------------------------------
 * Formatting
 * -------------------------------------------------------------------------- */

const UNITS = [
  { limit: 1e12, suffix: "T" },
  { limit: 1e9, suffix: "B" },
  { limit: 1e6, suffix: "M" },
  { limit: 1e3, suffix: "K" }
];

/** 1234567 -> "1.23M" */
export function formatNumber(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!isFiniteNumber(n)) return "0";
  const abs = Math.abs(n);
  for (const u of UNITS) {
    if (abs >= u.limit) {
      const v = n / u.limit;
      return (Math.abs(v) >= 100 ? Math.round(v) : round(v, 2)) + u.suffix;
    }
  }
  return String(Math.trunc(n));
}

/** 1234567 -> "1,234,567" */
export function formatExact(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!isFiniteNumber(n)) return "0";
  return Math.trunc(n).toLocaleString("en-US");
}

/** 1234567 -> "1,234,567.00" style for balances (no decimals under 1000). */
export function formatCoins(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!isFiniteNumber(n)) return "0";
  return Math.trunc(n).toLocaleString("en-US");
}

export function formatDuration(ms) {
  if (!isFiniteNumber(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatDate(value, withTime = false) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const opts = { year: "numeric", month: "short", day: "numeric" };
  if (withTime) {
    opts.hour = "2-digit";
    opts.minute = "2-digit";
  }
  return d.toLocaleString(undefined, opts);
}

export function relativeTime(value) {
  if (!value) return "never";
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return "never";
  const diff = Date.now() - d;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/* -----------------------------------------------------------------------------
 * Toasts
 * -------------------------------------------------------------------------- */

let toastHost = null;

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = el("div", "toast-host");
  toastHost.setAttribute("role", "status");
  toastHost.setAttribute("aria-live", "polite");
  document.body.appendChild(toastHost);
  return toastHost;
}

const TOAST_ICON = {
  info: "ℹ",
  success: "✓",
  warn: "!",
  error: "✕",
  reward: "★"
};

/**
 * Show a short message.
 * @param {string} message
 * @param {"info"|"success"|"warn"|"error"|"reward"} [kind]
 * @param {number} [ms]
 */
export function toast(message, kind = "info", ms = 3200) {
  const text = String(message ?? "");
  if (!text) return;
  const host = ensureToastHost();
  const node = el("div", `toast toast--${kind}`);
  node.innerHTML = `<span class="toast__icon">${TOAST_ICON[kind] || TOAST_ICON.info}</span><span class="toast__text">${escapeHtml(text)}</span>`;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-visible"));
  window.setTimeout(() => {
    node.classList.remove("is-visible");
    window.setTimeout(() => node.remove(), 260);
  }, ms);
}

/* -----------------------------------------------------------------------------
 * Modals / sheets
 * -------------------------------------------------------------------------- */

const openSheets = new Set();

/**
 * Open a bottom sheet / modal by id.
 * @param {string} id element id of the sheet
 */
export function openSheet(id) {
  const node = document.getElementById(id);
  if (!node) return false;
  node.classList.add("is-open");
  node.removeAttribute("hidden");
  node.setAttribute("aria-hidden", "false");
  openSheets.add(id);
  document.body.classList.add("has-sheet");
  const focusable = node.querySelector("[data-autofocus]");
  if (focusable) window.setTimeout(() => focusable.focus(), 60);
  return true;
}

export function closeSheet(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.remove("is-open");
  node.setAttribute("aria-hidden", "true");
  openSheets.delete(id);
  if (openSheets.size === 0) document.body.classList.remove("has-sheet");
  window.setTimeout(() => {
    if (!node.classList.contains("is-open")) node.setAttribute("hidden", "");
  }, 240);
}

export function closeAllSheets() {
  Array.from(openSheets).forEach(closeSheet);
}

export function isSheetOpen(id) {
  return openSheets.has(id);
}

/** Wire up [data-sheet-open="id"] and [data-sheet-close] buttons. */
export function bindSheetTriggers(root = document) {
  $$("[data-sheet-open]", root).forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openSheet(btn.dataset.sheetOpen);
    });
  });
  $$("[data-sheet-close]", root).forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.dataset.sheetClose || btn.closest(".sheet")?.id;
      if (id) closeSheet(id);
    });
  });
}

/** Close sheets on backdrop click and on Escape. */
export function bindSheetDismiss(root = document) {
  $$(".sheet", root).forEach((sheet) => {
    if (sheet.dataset.dismissBound) return;
    sheet.dataset.dismissBound = "1";
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet || e.target.classList.contains("sheet__backdrop")) {
        closeSheet(sheet.id);
      }
    });
  });
  if (!bindSheetDismiss.escapeBound) {
    bindSheetDismiss.escapeBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllSheets();
    });
  }
}

/* -----------------------------------------------------------------------------
 * Progress bars
 * -------------------------------------------------------------------------- */

/** Update a progress bar by id (data-value 0..1). */
export function setProgress(id, value, max = 1) {
  const node = document.getElementById(id);
  if (!node) return;
  const safeMax = isFiniteNumber(max) && max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
  node.style.setProperty("--progress", `${pct}%`);
  node.setAttribute("aria-valuenow", String(Math.round(pct)));
  const label = node.querySelector("[data-progress-label]");
  if (label) label.textContent = `${Math.round(pct)}%`;
}

/** Colour a progress bar by how full it is. */
export function setProgressTone(id, tone) {
  const node = document.getElementById(id);
  if (!node) return;
  node.dataset.tone = tone;
}

/* -----------------------------------------------------------------------------
 * Floating "+coins"
 * -------------------------------------------------------------------------- */

let floatLayer = null;

function ensureFloatLayer() {
  if (floatLayer && document.body.contains(floatLayer)) return floatLayer;
  floatLayer = el("div", "float-layer");
  floatLayer.setAttribute("aria-hidden", "true");
  document.body.appendChild(floatLayer);
  return floatLayer;
}

/**
 * Pop a floating value at a screen position.
 * @param {number} x viewport x
 * @param {number} y viewport y
 * @param {string} text
 * @param {"coin"|"combo"|"crit"|"level"} variant
 */
export function floatText(x, y, text, variant = "coin") {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const layer = ensureFloatLayer();
  const node = el("span", `float float--${variant}`, text);
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  const drift = (Math.random() * 60 - 30).toFixed(0);
  node.style.setProperty("--drift", `${drift}px`);
  layer.appendChild(node);
  window.setTimeout(() => node.remove(), 1200);
}

/** Ripple effect for the tap button. */
export function ripple(target, clientX, clientY) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.6;
  const node = el("span", "ripple");
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.style.left = `${(clientX ?? rect.left + rect.width / 2) - rect.left - size / 2}px`;
  node.style.top = `${(clientY ?? rect.top + rect.height / 2) - rect.top - size / 2}px`;
  target.appendChild(node);
  window.setTimeout(() => node.remove(), 620);
}

/** Brief scale pulse on an element. */
export function pulse(target) {
  if (!target) return;
  target.classList.remove("is-pulsing");
  // force reflow so the animation restarts
  void target.offsetWidth;
  target.classList.add("is-pulsing");
  window.setTimeout(() => target.classList.remove("is-pulsing"), 320);
}

/* -----------------------------------------------------------------------------
 * Feedback (sound + haptics)
 * -----------------------------------------------------------------------------
 * The handler is installed by settings.js so that ui.js stays free of
 * preference lookups and there is no circular import.
 * -------------------------------------------------------------------------- */

let feedbackHandler = { play: () => {}, vibrate: () => {} };

export function setFeedbackHandler(handler) {
  feedbackHandler = { ...feedbackHandler, ...handler };
}

export function feedback(kind = "tap") {
  try {
    feedbackHandler.play?.(kind);
  } catch {
    /* audio is optional, never let it break the game */
  }
  if (kind === "tap" || kind === "reward" || kind === "levelup" || kind === "error") {
    try {
      feedbackHandler.vibrate?.(kind);
    } catch {
      /* haptics are optional */
    }
  }
}

/** Synthesised UI sound (WebAudio). No audio files, no download. */
const Audio = (() => {
  let ctx = null;
  let enabled = true;

  function ensure() {
    if (!enabled) return null;
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function blip(freq, duration, type = "sine", gain = 0.05, slideTo = null) {
    const ac = ensure();
    if (!ac) return;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(ac.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  return {
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled && ctx) {
        ctx.suspend().catch(() => {});
      }
    },
    play(kind) {
      switch (kind) {
        case "tap":
          blip(420, 0.06, "triangle", 0.035, 620);
          break;
        case "combo":
          blip(660, 0.08, "square", 0.03, 880);
          break;
        case "crit":
          blip(300, 0.16, "sawtooth", 0.05, 1200);
          break;
        case "reward":
          blip(523, 0.12, "sine", 0.06);
          window.setTimeout(() => blip(784, 0.18, "sine", 0.06), 110);
          break;
        case "levelup":
          blip(392, 0.12, "triangle", 0.06);
          window.setTimeout(() => blip(587, 0.14, "triangle", 0.06), 120);
          window.setTimeout(() => blip(880, 0.22, "triangle", 0.05), 250);
          break;
        case "error":
          blip(180, 0.14, "sine", 0.05, 120);
          break;
        default:
          break;
      }
    }
  };
})();

/** Direct access for settings.js. */
export function audioEngine() {
  return Audio;
}

/* -----------------------------------------------------------------------------
 * Misc
 * -------------------------------------------------------------------------- */

export function vibrate(pattern) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* not supported */
    }
  }
}

/** Full-screen loader overlay. */
export function setBusy(busy, message = "") {
  let node = document.getElementById("global-loader");
  if (busy) {
    if (!node) {
      node = el("div", "loader");
      node.id = "global-loader";
      node.innerHTML = '<div class="loader__ring"></div><p class="loader__text"></p>';
      document.body.appendChild(node);
    }
    node.querySelector(".loader__text").textContent = message;
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add("is-visible"));
  } else if (node) {
    node.classList.remove("is-visible");
    window.setTimeout(() => {
      node.hidden = true;
    }, 220);
  }
}

/** Toggle a button into a loading state (prevents double submits). */
export function buttonBusy(button, busy, busyLabel = "Working...") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.dataset.label || button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
    button.classList.add("is-busy");
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

/** Debounce for resize / input handlers. */
export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}
