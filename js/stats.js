/* =============================================================================
 * TAPX - js/stats.js
 * -----------------------------------------------------------------------------
 * The statistics sheet: total taps, coins, level, XP, highest combo, global
 * rank, owned upgrades and claimed milestones.
 *
 * On advertising revenue this file says exactly one thing, and it is the
 * truthful one: earnings are shown in the ad network's own publisher
 * dashboard. No figure shown here is derived from ad activity, and no figure
 * shown here is an estimate of money.
 * ========================================================================== */

import { rpc, friendlyError } from "./supabase.js";
import { safeInt, safeBigInt } from "./security.js";
import { $, el, on, emit, setProgress, formatNumber, formatCoins, formatDate, toast } from "./ui.js";

let lastStats = null;

/* -----------------------------------------------------------------------------
 * Public
 * -------------------------------------------------------------------------- */

export async function loadStats() {
  try {
    lastStats = await rpc("get_user_stats", {});
    render(lastStats);
    emit("stats:changed", lastStats);
    return lastStats;
  } catch (err) {
    renderUnavailable(friendlyError(err));
    return null;
  }
}

on("stats:changed", (e) => {
  if (e.detail) render(e.detail);
});

on("player:state", () => {
  // Keep the numbers in the sheet honest without an extra round trip on
  // every tap: refresh when the sheet is actually visible.
  const sheet = $("#sheet-stats");
  if (sheet?.classList.contains("is-open")) void loadStats();
});

/* -----------------------------------------------------------------------------
 * Render
 * -------------------------------------------------------------------------- */

function renderUnavailable(message) {
  const host = $("#stats-upgrades");
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(el("p", "empty-note", message));
}

function render(stats) {
  if (!stats) return;
  const s = window.TAPX?.state ?? {};
  const totalTaps = safeBigInt(stats.total_taps ?? s.totalTaps);
  const coins = safeBigInt(stats.coins ?? s.coins);
  const level = safeInt(stats.level ?? s.level, 1, { min: 1 });
  const xp = safeBigInt(stats.experience ?? s.experience);
  const xpNext = safeBigInt(stats.xp_to_next ?? s.xpToNext, 1, { min: 1 });
  const highestCombo = safeInt(stats.highest_combo ?? s.highestCombo);

  setStat("#stat-taps", formatNumber(totalTaps));
  setStat("#stat-coins", formatCoins(coins));
  setStat("#stat-level", String(level));
  setStat("#stat-combo", `x${formatNumber(highestCombo)}`);
  setStat("#stat-rank", `#${formatNumber(stats.global_rank ?? "-")}`);
  setStat("#stat-member", formatDate(stats.created_at));

  setProgress("stat-xp-bar", xp, xpNext);

  // Upgrades owned
  const upList = $("#stats-upgrades");
  if (upList) {
    upList.innerHTML = "";
    const ups = Array.isArray(stats.upgrades) ? stats.upgrades : [];
    if (!ups.length) {
      upList.appendChild(el("p", "empty-note", "No upgrades purchased yet."));
    } else {
      ups.forEach((u) => {
        const row = el("div", "stat-row");
        row.innerHTML = `<span>${u.name}</span><strong>LV ${u.level} / ${u.max_level}</strong>`;
        upList.appendChild(row);
      });
    }
  }

  // Milestones claimed
  const mList = $("#stats-milestones");
  if (mList) {
    mList.innerHTML = "";
    const ms = Array.isArray(stats.milestones) ? stats.milestones : [];
    if (!ms.length) {
      mList.appendChild(el("p", "empty-note", "No milestones claimed yet."));
    } else {
      ms.forEach((m) => {
        const row = el("div", "stat-row");
        row.innerHTML = `<span>${m.name}</span><strong>+${formatCoins(m.reward_coins)}</strong>`;
        mList.appendChild(row);
      });
    }
  }
}

function setStat(sel, value) {
  const node = $(sel);
  if (node) node.textContent = value;
}

/** Live counters shown on the home screen. */
export function renderQuickStats() {
  const s = window.TAPX?.state ?? {};
  setStat("#total-taps", formatNumber(s.totalTaps ?? 0));
}

export function statsUnavailable(message = "Statistics are unavailable right now.") {
  toast(message, "warn");
}
