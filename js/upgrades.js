/* =============================================================================
 * TAPX - js/upgrades.js
 * -----------------------------------------------------------------------------
 * The four upgrades: Tap Power, Combo Boost, Critical Tap, Bonus Multiplier.
 *
 * Prices are computed by the database (purchase_upgrade() re-derives the cost
 * from the catalogue), so editing JavaScript or the DOM in devtools buys
 * nothing. The cost shown here is a preview from upgrade_cost().
 * ========================================================================== */

import { rpc, friendlyError } from "./supabase.js";
import { once, safeInt, safeBigInt } from "./security.js";
import { $, el, on, emit, toast, feedback, formatCoins } from "./ui.js";

const ICONS = {
  bolt: "⚡",
  combo: "🔥",
  crit: "🎯",
  star: "🌟"
};

const state = {
  catalogue: [],
  levels: {}, // slug -> level
  loaded: false
};

/* -----------------------------------------------------------------------------
 * Public
 * -------------------------------------------------------------------------- */

export async function initUpgrades() {
  const list = $("#upgrade-list");
  if (!list) return;

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-buy-upgrade]");
    if (!btn) return;
    buy(btn.dataset.buyUpgrade, btn);
  });

  // Anything that changes the balance should re-evaluate affordability.
  on("player:state", refreshAffordability);
  on("coins:changed", refreshAffordability);

  await loadUpgrades();
}

export async function loadUpgrades() {
  try {
    const config = await rpc("get_public_config", {});
    state.catalogue = Array.isArray(config?.upgrades) ? config.upgrades : [];

    const owned = await loadOwnedLevels();
    state.levels = owned;
    state.loaded = true;
    render();
  } catch (err) {
    const list = $("#upgrade-list");
    if (list) {
      list.innerHTML = "";
      const empty = el("p", "empty-note", "Upgrades are unavailable right now.");
      list.appendChild(empty);
    }
    console.warn("[upgrades]", friendlyError(err));
  }
}

async function loadOwnedLevels() {
  // get_user_stats() is the single source of truth for upgrade levels.
  try {
    const stats = await rpc("get_user_stats", {});
    const map = {};
    (stats?.upgrades || []).forEach((u) => {
      map[u.slug] = safeInt(u.level, 0, { min: 0 });
    });
    return map;
  } catch {
    return {};
  }
}

function costFor(item) {
  const level = state.levels[item.slug] ?? 0;
  const base = safeBigInt(item.base_cost, 1, 1e12);
  const growth = Number(item.growth) > 1 ? Number(item.growth) : 1.15;
  return Math.max(1, Math.floor(base * growth ** level));
}

function effectLabel(item, level) {
  switch (item.slug) {
    case "tap_power":
      return `Coins per tap ×${(1.15 ** (level + 1)).toFixed(2)}`;
    case "combo_boost":
      return `Combo income ×${(1.1 ** (level + 1)).toFixed(2)}`;
    case "critical_tap":
      return `Critical chance ${Math.min(30, (level + 1) * 2)}%`;
    case "bonus_multiplier":
      return `All income ×${(1.25 ** (level + 1)).toFixed(2)}`;
    default:
      return `×${Number(item.multiplier).toFixed(2)} per level`;
  }
}

/* -----------------------------------------------------------------------------
 * Render
 * -------------------------------------------------------------------------- */

function render() {
  const list = $("#upgrade-list");
  if (!list) return;

  if (!state.catalogue.length) {
    list.innerHTML = "";
    list.appendChild(el("p", "empty-note", "No upgrades are available yet. Check back soon."));
    return;
  }

  list.innerHTML = "";
  state.catalogue.forEach((item) => {
    list.appendChild(renderItem(item));
  });
  refreshAffordability();
}

function renderItem(item) {
  const level = state.levels[item.slug] ?? 0;
  const maxed = level >= item.max_level;
  const cost = costFor(item);
  const isCrit = item.slug === "critical_tap";
  const nextChance = Math.min(30, (level + 1) * 2);

  const card = el("article", "upgrade-card");
  card.dataset.slug = item.slug;
  card.dataset.level = String(level);
  card.dataset.cost = String(cost);
  card.dataset.maxed = String(maxed);
  card.dataset.crit = String(isCrit);

  card.innerHTML = `
    <div class="upgrade-card__icon" aria-hidden="true">${ICONS[item.icon] || ICONS[item.icon] || "◆"}</div>
    <div class="upgrade-card__body">
      <div class="upgrade-card__title">
        <h3>${item.name}</h3>
        <span class="pill pill--level">LV ${level} / ${item.max_level}</span>
      </div>
      <p class="upgrade-card__desc">${item.description || ""}</p>
      <p class="upgrade-card__effect" data-effect>${effectLabel(item, level)}</p>
      ${isCrit ? `<div class="mini-bar" aria-hidden="true"><span style="width:${(nextChance / 30) * 100}%"></span></div>` : ""}
    </div>
    <button class="btn btn--buy" type="button" data-buy-upgrade="${item.id}" ${maxed ? "disabled" : ""}>
      <span class="btn__label">${maxed ? "MAXED" : formatCoins(cost)}</span>
      <span class="btn__hint">${maxed ? "" : "coins"}</span>
    </button>
  `;

  return card;
}

function refreshAffordability() {
  const coinsEl = $("#upgrade-coins");
  if (coinsEl) coinsEl.textContent = formatCoins(window.TAPX?.state?.coins ?? 0);

  document.querySelectorAll(".upgrade-card").forEach((card) => {
    const maxed = card.dataset.maxed === "true";
    const cost = Number(card.dataset.cost) || 0;
    const coins = window.TAPX?.state?.coins ?? 0;
    const btn = card.querySelector("[data-buy-upgrade]");
    if (!btn || maxed) return;
    const affordable = coins >= cost;
    card.dataset.affordable = String(affordable);
    btn.disabled = !affordable;
    btn.classList.toggle("is-affordable", affordable);
  });
}

/* -----------------------------------------------------------------------------
 * Purchase
 * -------------------------------------------------------------------------- */

async function buy(upgradeId, button) {
  const id = Number(upgradeId);
  if (!Number.isFinite(id)) return;

  // One purchase in flight per upgrade at a time.
  await once(`upgrade:${id}`, async () => {
    const original = button.innerHTML;
    button.disabled = true;
    button.classList.add("is-busy");
    button.innerHTML = '<span class="btn__label">...</span>';

    try {
      const res = await rpc("purchase_upgrade", { p_upgrade_id: id });
      if (res && res.ok) {
        const item = state.catalogue.find((u) => u.id === id);
        if (item) state.levels[item.slug] = res.level;
        emit("coins:changed", { coins: res.coins });
        feedback("reward");
        toast(`${item?.name || "Upgrade"} is now level ${res.level}.`, "success");
        render();
        if (state.loaded) {
          const stats = await rpc("get_user_stats", {});
          emit("stats:changed", stats);
        }
      }
    } catch (err) {
      feedback("error");
      toast(friendlyError(err), "error");
      button.innerHTML = original;
      button.disabled = false;
      // The server is the truth: resync so the UI cannot drift.
      emit("player:refresh");
    } finally {
      button.classList.remove("is-busy");
      refreshAffordability();
    }
  });
}
