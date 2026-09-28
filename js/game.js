/* =============================================================================
 * TAPX - js/game.js
 * -----------------------------------------------------------------------------
 * The tap engine.
 *
 * Design:
 *   * Taps are counted locally for instant feedback (animation, combo, coins).
 *   * They are flushed to the server in small batches. Every batch is scored
 *     by the database function process_tap(), which re-validates the tap
 *     density, recomputes the coins from the server-side upgrade levels and
 *     decides criticals with its own RNG.
 *   * The UI then snaps to whatever the server returned. Local numbers are
 *     only ever an optimistic preview.
 *   * If the network is down, taps are visibly marked as unsaved instead of
 *     being silently trusted.
 * ========================================================================== */

import { CONFIG } from "./config.js";
import { rpc, getUser, friendlyError, isNetworkError } from "./supabase.js";
import { createTapGuard, createComboTracker, safeBigInt, safeInt, round } from "./security.js";
import { initSettings, setAccount, getPrefs, applyPrefs, renderHeader } from "./settings.js";
import { AdManager } from "./ads.js";
import { initRewards } from "./rewards.js";
import { loadStats } from "./stats.js";
import { initUpgrades } from "./upgrades.js";
import {
  $,
  on,
  emit,
  toast,
  feedback,
  floatText,
  ripple,
  pulse,
  setProgress,
  setProgressTone,
  formatNumber,
  formatCoins,
  setText,
  bindSheetTriggers,
  bindSheetDismiss,
  setBusy,
  setHidden
} from "./ui.js";

/* -----------------------------------------------------------------------------
 * State
 * -------------------------------------------------------------------------- */

const tapGuard = createTapGuard();
const comboTracker = createComboTracker();

const state = {
  user: null,
  id: null,
  username: "player",
  displayName: null,
  coins: 0,
  totalTaps: 0,
  coinsPerTap: 1, // effective, server-computed
  level: 1,
  experience: 0,
  xpToNext: 125,
  combo: 0,
  highestCombo: 0,
  dailyStreak: 0,
  dailyLastClaimedAt: null,
  isAdmin: false,

  // local, not yet persisted
  pendingTaps: 0,
  pendingFirstTapAt: 0,
  pendingLastTapAt: 0,
  pendingCoins: 0,
  flushTimer: null,
  flushing: false,
  online: navigator.onLine,
  ready: false
};

/* -----------------------------------------------------------------------------
 * Local optimistic maths
 *     These numbers mirror the SQL in process_tap() so the animation feels
 *     right. The server value always wins on the next flush.
 * -------------------------------------------------------------------------- */

function estimateCoinsPerTap(upgrades = {}) {
  const tapPower = upgrades.tap_power ?? 0;
  const comboBoost = upgrades.combo_boost ?? 0;
  const bonus = upgrades.bonus_multiplier ?? 0;
  const base = state.coinsPerTap;
  const levelBonus = (state.level - 1) * 0.1;
  return round((base + levelBonus) * 1.15 ** tapPower * 1.1 ** comboBoost * 1.25 ** bonus, 0);
}

/* -----------------------------------------------------------------------------
 * Render
 * -------------------------------------------------------------------------- */

function render() {
  const cpt = Math.max(1, estimateCoinsPerTap());
  setText("#coin-balance", formatCoins(state.coins));
  setText("#tap-value", `+${formatNumber(cpt)}`);
  setText("#level-value", String(state.level));
  setText("#level-value-2", String(state.level));
  setText("#xp-level", String(state.level));
  setText("#combo-value", state.combo > 1 ? `x${state.combo}` : "-");
  setText("#total-taps", formatNumber(state.totalTaps));
  setText("#xp-label", `${formatNumber(state.experience)} / ${formatNumber(state.xpToNext)} XP`);

  const xpEl = $("#xp-level");
  if (xpEl) xpEl.textContent = String(state.level);

  setProgress("xp-bar", state.experience, state.xpToNext);
  setProgressTone("xp-bar", state.xpToNext > 0 && state.experience / state.xpToNext > 0.75 ? "hot" : "cool");

  const comboMeter = $("#combo-meter");
  if (comboMeter) {
    const alive = state.combo > 1;
    comboMeter.dataset.active = String(alive);
    const fill = comboMeter.querySelector(".combo-meter__fill");
    if (fill) {
      const target = Math.min(100, (state.combo / 25) * 100);
      fill.style.width = `${target}%`;
    }
  }

  renderHeader({ username: state.username, coins: state.coins });
  setNetworkBadge();
}

function setNetworkBadge() {
  const badge = $("#net-badge");
  if (!badge) return;
  const offline = !state.online;
  const syncing = state.flushing || state.pendingTaps > 0;
  badge.hidden = !(offline || syncing);
  badge.dataset.state = offline ? "offline" : "syncing";
  const text = badge.querySelector("span");
  if (text) {
    text.textContent = offline
      ? state.pendingTaps > 0
        ? "Offline - progress not saved"
        : "Offline"
      : "Saving...";
  }
}

function bumpCoins(delta, x, y, variant) {
  if (delta <= 0) return;
  floatText(x, y, `+${formatNumber(delta)}`, variant || "coin");
}

/* -----------------------------------------------------------------------------
 * Tap handling
 * -------------------------------------------------------------------------- */

function handleTap(event) {
  if (!state.ready) return;
  if (!state.online) {
    feedback("error");
    showOfflineHint();
    return;
  }

  const now = Date.now();
  if (!tapGuard.accept(now)) return; // physically impossible burst - ignore

  const { avgInterval, alive } = comboTracker.update(now);

  // Optimistic local update (replaced by the server value on flush).
  const gain = Math.max(1, estimateCoinsPerTap());
  state.combo = alive && avgInterval <= CONFIG.comboWindowMs ? Math.min(state.combo + 1, CONFIG.maxCombo) : 1;
  state.coins += gain;
  state.pendingCoins += gain;
  state.pendingTaps += 1;
  if (!state.pendingFirstTapAt) state.pendingFirstTapAt = now;
  state.pendingLastTapAt = now;

  // Feedback
  const target = event?.currentTarget ?? $("#tap-button");
  ripple(target, event?.clientX, event?.clientY);
  pulse($("#tap-button-label"));
  feedback(state.combo >= 10 ? "combo" : "tap");

  const rect = target?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
  const cx = (event?.clientX ?? rect.left + rect.width / 2) + (Math.random() * 40 - 20);
  const cy = (event?.clientY ?? rect.top + rect.height / 2) + (Math.random() * 20 - 10);

  if (state.combo >= 10 && state.combo % 5 === 0) {
    floatText(cx, cy - 18, `COMBO x${state.combo}`, "combo");
  }
  bumpCoins(gain, cx, cy);

  render();
  scheduleFlush();
}

let offlineHintShown = false;
function showOfflineHint() {
  if (offlineHintShown) return;
  offlineHintShown = true;
  toast("You are offline. Taps are not saved until the connection is back.", "warn", 4000);
  window.setTimeout(() => {
    offlineHintShown = false;
  }, 8000);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = window.setTimeout(() => {
    state.flushTimer = null;
    flush();
  }, CONFIG.tapBatchMs);
}

async function flush() {
  if (state.flushing) return;
  if (state.pendingTaps === 0) return;
  if (!state.online) {
    setNetworkBadge();
    return;
  }
  if (document.visibilityState === "hidden" && state.pendingTaps < CONFIG.maxBatchTaps) {
    // Keep the timer going; the visibilitychange handler forces a flush.
    return;
  }

  const taps = state.pendingTaps;
  const duration = Math.max(0, state.pendingLastTapAt - state.pendingFirstTapAt);
  state.pendingTaps = 0;
  state.pendingFirstTapAt = 0;
  state.pendingCoins = 0;
  state.flushing = true;
  setNetworkBadge();

  try {
    const res = await rpc("process_tap", {
      p_tap_count: taps,
      p_duration_ms: duration,
      p_client_combo: state.combo
    });
    if (res && res.ok) {
      applyServerState(res);
      if (res.leveled_up) onLevelUp(res);
    }
  } catch (err) {
    if (isNetworkError(err)) {
      state.online = false;
      // The taps are gone: we never trust local numbers as authoritative.
      toast("Connection lost - that batch of taps was not saved.", "warn");
    } else {
      // The server rejected the batch (e.g. tapped impossibly fast). Resync.
      feedback("error");
      toast(friendlyError(err), "error");
      await resync();
    }
  } finally {
    state.flushing = false;
    render();
    if (state.pendingTaps > 0) scheduleFlush();
  }
}

/** Adopt the authoritative values returned by the server. */
function applyServerState(res) {
  state.coins = safeBigInt(res.coins, state.coins);
  state.totalTaps = safeBigInt(res.total_taps, state.totalTaps);
  state.level = safeInt(res.level, state.level, { min: 1, max: 1000 });
  state.experience = safeBigInt(res.experience, state.experience);
  state.xpToNext = safeBigInt(res.xp_to_next, state.xpToNext, { min: 1 });
  state.combo = safeInt(res.combo, 0, { min: 0, max: CONFIG.maxCombo });
  state.highestCombo = Math.max(state.highestCombo, safeInt(res.highest_combo, 0, { min: 0 }));
  state.coinsPerTap = Math.max(1, safeBigInt(res.coins_per_tap, state.coinsPerTap));
}

function onLevelUp(res) {
  feedback("levelup");
  const el = $("#level-value");
  if (el) {
    el.textContent = String(res.level);
    el.classList.remove("is-pulsing");
    void el.offsetWidth;
    el.classList.add("is-pulsing");
  }
  const rect = $("#tap-button")?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  floatText(x, y - 40, `LEVEL ${res.level}`, "level");
  toast(`Level ${res.level} reached!`, "reward", 2600);
  emit("player:levelup", res);
}

/* -----------------------------------------------------------------------------
 * Sync / bootstrap
 * -------------------------------------------------------------------------- */

async function loadPlayerState() {
  const res = await rpc("get_player_state", {});
  if (!res || !res.ok) {
    if (res?.missing_state) {
      // Should not happen: the DB trigger creates the rows. Self-heal anyway.
      throw new Error("Your player record is missing. Please sign out and sign in again.");
    }
    throw new Error("Could not load your player data.");
  }

  state.id = res.id;
  state.username = res.username;
  state.displayName = res.display_name;
  state.coins = safeBigInt(res.coins);
  state.totalTaps = safeBigInt(res.total_taps);
  state.coinsPerTap = Math.max(1, safeBigInt(res.coins_per_tap, 1));
  state.level = safeInt(res.level, 1, { min: 1, max: 1000 });
  state.experience = safeBigInt(res.experience);
  state.xpToNext = safeBigInt(res.xp_to_next, 125, { min: 1 });
  state.combo = safeInt(res.combo, 0, { min: 0 });
  state.highestCombo = safeInt(res.highest_combo, 0, { min: 0 });
  state.dailyStreak = safeInt(res.daily_streak, 0, { min: 0 });
  state.dailyLastClaimedAt = res.daily_last_claimed_at;
  state.isAdmin = res.is_admin === true;

  setAccount(res);
  applyPrefs({
    sound: res.sound_enabled !== false,
    vibration: res.vibration_enabled !== false
  });

  emit("player:state", res);
  return res;
}

async function resync() {
  try {
    const res = await loadPlayerState();
    state.pendingTaps = 0;
    state.pendingCoins = 0;
    render();
    await loadStats();
    return res;
  } catch (err) {
    console.warn("resync failed", err);
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Bindings
 * -------------------------------------------------------------------------- */

function bindGame() {
  const button = $("#tap-button");
  if (button) {
    // pointerdown gives the lowest possible latency on touch devices
    button.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      handleTap(e);
    });
    button.addEventListener("click", (e) => {
      // Keyboard activation (Enter/Space) has no pointerdown.
      if (e.detail === 0) handleTap(e);
    });
    button.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // Space bar taps anywhere on the game screen.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.code !== "Enter") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    if (document.querySelector(".sheet.is-open")) return;
    e.preventDefault();
    handleTap({ currentTarget: button, clientX: 0, clientY: 0 });
  });

  // Bottom navigation
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (!nav) return;
    e.preventDefault();
    const target = nav.dataset.nav;
    if (nav.dataset.sheetOpen) return; // sheet trigger handles it
    document.querySelectorAll(".bottom-nav__item").forEach((i) => i.classList.remove("is-active"));
    nav.classList.add("is-active");
    if (target === "refresh") {
      resync().then(() => toast("Progress refreshed.", "success"));
    }
  });

  // Network state
  window.addEventListener("online", async () => {
    state.online = true;
    setNetworkBadge();
    await resync();
    toast("Back online. Progress synced.", "success");
  });
  window.addEventListener("offline", () => {
    state.online = false;
    setNetworkBadge();
    showOfflineHint();
  });

  // Flush before the tab goes away so nothing is lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", () => flush());
  window.addEventListener("beforeunload", () => flush());

  // Tapping again after a pause should not keep the old combo alive.
  setInterval(() => {
    if (state.pendingTaps === 0 && state.combo > 1) {
      state.combo = 0;
      render();
    }
  }, 4000);
}

/* -----------------------------------------------------------------------------
 * Maintenance mode
 * -------------------------------------------------------------------------- */

function applyConfig(config) {
  if (!config) return;
  const settings = config.settings || {};

  if (settings.app_name) {
    document.title = `${settings.app_name} - Tap game`;
    const brand = $("[data-brand]");
    if (brand) brand.textContent = settings.app_name;
  }

  const banner = $("#maintenance-banner");
  if (settings.maintenance_mode === true) {
    if (banner) {
      banner.textContent = "TAPX is under maintenance. Progress is paused for everyone.";
      setHidden(banner, false);
    }
    const button = $("#tap-button");
    if (button) button.disabled = true;
  }

  // Announcements
  const list = $("#announcement-list");
  if (list) {
    list.textContent = "";
    (config.announcements || []).slice(0, 3).forEach((a) => {
      const node = document.createElement("div");
      node.className = "announcement";
      const title = document.createElement("strong");
      title.textContent = a.title;
      const body = document.createElement("p");
      body.textContent = a.message;
      node.append(title, body);
      list.appendChild(node);
    });
  }

  emit("config:refresh", config);
}

/* -----------------------------------------------------------------------------
 * Boot
 * -------------------------------------------------------------------------- */

async function boot() {
  setBusy(true, "Connecting...");
  bindSheetTriggers();
  bindSheetDismiss();
  initSettings();
  bindGame();

  try {
    const user = await getUser();
    if (!user) {
      window.location.replace("login.html?next=index.html");
      return;
    }
    state.user = user;
    writeLastUsername(user.email);

    // Public config first: it is not sensitive and works even when signed out.
    try {
      applyConfig(await rpc("get_public_config", {}));
    } catch (err) {
      console.warn("config unavailable", err);
    }

    await AdManager.init();

    await loadPlayerState();
    state.ready = true;
    render();

    await initUpgrades();
    await initRewards();
    await loadStats();

    setHidden("#game-screen", false);
    setHidden("#boot-screen", true);

    if (state.isAdmin) {
      setHidden("#btn-admin", false);
    }

    // Keep the header chips in sync with anything that changes the balance.
    on("coins:changed", (e) => {
      state.coins = safeBigInt(e.detail?.coins, state.coins);
      render();
    });
    on("player:refresh", async () => {
      await resync();
    });
  } catch (err) {
    console.error(err);
    showFatal(friendlyError(err));
  } finally {
    setBusy(false);
  }
}

function writeLastUsername(email) {
  try {
    if (email) window.localStorage.setItem(CONFIG.storage.lastUsername, JSON.stringify(email.split("@")[0]));
  } catch {
    /* ignore */
  }
}

function showFatal(message) {
  const box = $("#fatal-error");
  if (!box) return;
  const text = box.querySelector("[data-fatal-message]");
  if (text) text.textContent = message;
  setHidden(box, false);
  setHidden("#boot-screen", true);
  setHidden("#game-screen", true);
}

/* Expose a tiny read-only surface for debugging in the console. */
window.TAPX = Object.freeze({
  get state() {
    return { ...state };
  },
  get prefs() {
    return getPrefs();
  },
  sync: resync,
  flush
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
