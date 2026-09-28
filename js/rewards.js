/* =============================================================================
 * TAPX - js/rewards.js
 * -----------------------------------------------------------------------------
 * Daily reward (one legitimate claim per 24 hours) and milestone claims.
 *
 * Both are server-side operations. claim_daily_reward() and claim_milestone()
 * check the clock, the requirement and the duplicate-claim constraint in
 * PostgreSQL, so calling the function twice (or editing this file) does not
 * hand out a second reward.
 * ========================================================================== */

import { CONFIG } from "./config.js";
import { rpc, friendlyError } from "./supabase.js";
import { once, safeInt, safeBigInt } from "./security.js";
import { $, el, on, emit, toast, feedback, formatCoins, formatNumber, formatDuration } from "./ui.js";

const state = {
  streak: 0,
  lastClaimedAt: null,
  table: [...CONFIG.dailyRewardFallback],
  milestones: [],
  timer: null
};

/* -----------------------------------------------------------------------------
 * Public
 * -------------------------------------------------------------------------- */

export async function initRewards() {
  const claimBtn = $("#daily-claim");
  claimBtn?.addEventListener("click", () => claimDaily());

  const list = $("#milestone-list");
  list?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-claim-milestone]");
    if (!btn) return;
    claimMilestone(btn.dataset.claimMilestone, btn);
  });

  on("player:state", (e) => {
    const d = e.detail || {};
    state.streak = safeInt(d.daily_streak, 0, { min: 0 });
    state.lastClaimedAt = d.daily_last_claimed_at || null;
    renderDaily();
  });

  on("player:levelup", () => {
    void loadMilestones();
  });

  await loadRewards();
  startCountdown();
  await loadMilestones();
}

export async function loadRewards() {
  try {
    const config = await rpc("get_public_config", {});
    const table = config?.settings?.daily_rewards;
    if (Array.isArray(table) && table.length) {
      state.table = table.map((n) => safeBigInt(n, 0));
    }
  } catch {
    /* keep the built-in table */
  }
  renderDaily();
}

export async function loadMilestones() {
  const list = $("#milestone-list");
  if (!list) return;
  try {
    const rows = await rpc("get_milestone_status", {});
    state.milestones = Array.isArray(rows) ? rows : [];
    renderMilestones();
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("p", "empty-note", "Milestones are unavailable right now."));
    console.warn("[rewards]", friendlyError(err));
  }
}

/* -----------------------------------------------------------------------------
 * Daily reward
 * -------------------------------------------------------------------------- */

function msUntilNextClaim() {
  if (!state.lastClaimedAt) return 0;
  const next = new Date(state.lastClaimedAt).getTime() + CONFIG.dailyRewardIntervalMs;
  return Math.max(0, next - Date.now());
}

function nextReward() {
  const idx = state.lastClaimedAt ? state.streak % state.table.length : 0;
  return state.table[idx] ?? state.table[0] ?? 0;
}

function renderDaily() {
  const wrap = $("#daily-card");
  if (!wrap) return;

  const remaining = msUntilNextClaim();
  const ready = remaining === 0;

  const amountEl = $("#daily-amount");
  if (amountEl) amountEl.textContent = formatCoins(nextReward());

  const btn = $("#daily-claim");
  if (btn) {
    btn.disabled = !ready;
    btn.dataset.ready = String(ready);
    const label = btn.querySelector("[data-claim-label]") ?? btn;
    label.textContent = ready ? "CLAIM" : formatDuration(remaining);
  }

  const streakText = $("#daily-streak-text");
  if (streakText) {
    streakText.textContent = state.streak > 0 ? `Day ${state.streak} streak` : "Start your streak";
  }

  const dots = $("#daily-dots");
  if (dots) {
    dots.innerHTML = "";
    state.table.forEach((value, i) => {
      const day = el("span", "streak-dot");
      day.textContent = String(i + 1);
      day.dataset.state =
        !state.lastClaimedAt ? "next" : i < state.streak ? "done" : i === state.streak ? "next" : "locked";
      day.title = `Day ${i + 1}: ${formatCoins(value)} coins`;
      dots.appendChild(day);
    });
  }
}

function startCountdown() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (msUntilNextClaim() === 0) renderDaily();
    else {
      const btn = $("#daily-claim");
      const label = btn?.querySelector("[data-claim-label]") ?? btn;
      if (label && btn?.disabled) label.textContent = formatDuration(msUntilNextClaim());
    }
  }, 1000);
}

async function claimDaily() {
  if (msUntilNextClaim() > 0) {
    toast("Your daily reward is not ready yet.", "warn");
    return;
  }

  await once("daily-claim", async () => {
    const btn = $("#daily-claim");
    btn?.setAttribute("disabled", "true");
    try {
      const res = await rpc("claim_daily_reward", {});
      if (res && res.ok) {
        state.streak = res.streak;
        state.lastClaimedAt = res.next_at ? new Date(new Date(res.next_at).getTime() - CONFIG.dailyRewardIntervalMs).toISOString() : new Date().toISOString();
        emit("coins:changed", { coins: res.coins });
        feedback("reward");
        toast(`Day ${res.streak} claimed: +${formatCoins(res.reward)} coins`, "reward", 3600);
        renderDaily();
        emit("player:refresh");
      }
    } catch (err) {
      feedback("error");
      toast(friendlyError(err), "error");
      emit("player:refresh");
    } finally {
      btn?.removeAttribute("disabled");
      renderDaily();
    }
  });
}

/* -----------------------------------------------------------------------------
 * Milestones
 * -------------------------------------------------------------------------- */

function renderMilestones() {
  const list = $("#milestone-list");
  if (!list) return;

  const totalTaps = safeBigInt(window.TAPX?.state?.totalTaps, 0);
  list.innerHTML = "";

  if (!state.milestones.length) {
    list.appendChild(el("p", "empty-note", "No milestones configured yet."));
    return;
  }

  state.milestones.forEach((m) => {
    const claimed = m.claimed === true;
    const unlocked = m.unlocked === true || totalTaps >= Number(m.tap_requirement);
    const req = safeBigInt(m.tap_requirement, 1);
    const pct = Math.min(100, (totalTaps / req) * 100);

    const card = el("article", "milestone-card");
    card.dataset.claimed = String(claimed);
    card.dataset.unlocked = String(unlocked);
    card.innerHTML = `
      <div class="milestone-card__head">
        <h3>${m.name || `${formatNumber(req)} taps`}</h3>
        <span class="pill">${formatNumber(req)} taps</span>
      </div>
      <p class="milestone-card__desc">${m.description || ""}</p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}">
        <span class="progress__fill" style="width:${pct}%"></span>
      </div>
      <div class="milestone-card__foot">
        <span class="milestone-card__reward">+${formatCoins(m.reward_coins)} coins</span>
        <button class="btn btn--small" type="button" data-claim-milestone="${m.id}" ${claimed || !unlocked ? "disabled" : ""}>
          ${claimed ? "CLAIMED" : unlocked ? "CLAIM" : `${formatNumber(Math.max(0, req - totalTaps))} to go`}
        </button>
      </div>
    `;
    list.appendChild(card);
  });
}

async function claimMilestone(milestoneId, button) {
  const id = Number(milestoneId);
  if (!Number.isFinite(id)) return;

  await once(`milestone:${id}`, async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "...";

    try {
      const res = await rpc("claim_milestone", { p_milestone_id: id });
      if (res && res.ok) {
        emit("coins:changed", { coins: res.coins });
        feedback("reward");
        toast(`${res.name} claimed: +${formatCoins(res.reward)} coins`, "reward", 3400);
        emit("player:refresh");
        await loadMilestones();
      }
    } catch (err) {
      feedback("error");
      toast(friendlyError(err), "error");
      button.disabled = false;
      button.textContent = label;
      await loadMilestones();
    }
  });
}

on("player:state", () => {
  if (state.milestones.length) renderMilestones();
});
