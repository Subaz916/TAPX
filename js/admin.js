/* =============================================================================
 * TAPX - js/admin.js
 * -----------------------------------------------------------------------------
 * Administrator dashboard.
 *
 * Everything on this page is verified by the database: requireAdmin() runs
 * inside each admin_* function, and RLS blocks direct table writes. If a
 * non-admin somehow reaches this page, every call fails with
 * "Admin privileges required" and nothing can be changed.
 *
 * The Ads section configures the VISIBILITY of the three ad containers and
 * explains where to paste the official network code. It cannot create
 * impressions, cannot fabricate clicks and cannot touch network reporting.
 * ========================================================================== */

import { CONFIG, pageUrl } from "./config.js";
import { rpc, supabase, friendlyError, toError } from "./supabase.js";
import { requireAdmin } from "./auth.js";
import { once, safeInt, safeBigInt, escapeHtml } from "./security.js";
import {
  $,
  $$,
  el,
  toast,
  feedback,
  setBusy,
  setText,
  formatNumber,
  formatCoins,
  formatDate,
  relativeTime,
  bindSheetTriggers,
  bindSheetDismiss,
  openSheet
} from "./ui.js";

const state = {
  settings: {},
  placements: [],
  upgrades: [],
  milestones: [],
  announcements: [],
  users: [],
  userTotal: 0,
  userPage: 0,
  userQuery: "",
  masked: true
};

/* -----------------------------------------------------------------------------
 * Boot
 * -------------------------------------------------------------------------- */

async function boot() {
  bindSheetTriggers();
  bindSheetDismiss();
  bindNav();
  bindUsers();
  bindSettings();
  bindAds();
  bindUpgrades();
  bindMilestones();
  bindAnnouncements();

  setBusy(true, "Verifying access...");
  const allowed = await requireAdmin();
  if (!allowed) return;
  setBusy(false);

  try {
    await refreshAll();
  } catch (err) {
    toast(friendlyError(err), "error");
  }
}

async function refreshAll() {
  await Promise.allSettled([loadOverview(), loadSettings(), loadContent(), loadUsers(0)]);
}

/* -----------------------------------------------------------------------------
 * Navigation
 * -------------------------------------------------------------------------- */

function bindNav() {
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-admin-nav]");
    if (!link) return;
    e.preventDefault();
    const view = link.dataset.adminNav;
    $$("[data-admin-nav]").forEach((l) => l.classList.toggle("is-active", l === link));
    $$(".admin-view").forEach((v) => {
      v.hidden = v.dataset.view !== view;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

/* -----------------------------------------------------------------------------
 * 1. Overview
 * -------------------------------------------------------------------------- */

async function loadOverview() {
  const data = await rpc("admin_overview", {});
  if (!data?.ok) return;

  setText("#ov-users", formatNumber(data.users_total));
  setText("#ov-users-24h", formatNumber(data.users_24h));
  setText("#ov-dau-24h", formatNumber(data.dau_24h));
  setText("#ov-dau-7d", formatNumber(data.dau_7d));
  setText("#ov-taps", formatNumber(data.total_taps));
  setText("#ov-coins", formatNumber(data.total_coins));
  setText("#ov-avg-taps", formatNumber(data.avg_taps));
  setText("#ov-milestones", formatNumber(data.milestones_claimed));
  setText("#ov-upgrades", formatNumber(data.upgrades_purchased));
  setText("#ov-daily", formatNumber(data.daily_claims_24h));
  setText("#ov-ad-total", formatNumber(data.ad_events_total));
  setText("#ov-ad-24h", formatNumber(data.ad_events_24h));

  const byType = $("#ov-ad-by-type");
  if (byType) {
    byType.innerHTML = "";
    const entries = Object.entries(data.ad_events_by_type || {});
    if (!entries.length) {
      byType.appendChild(el("p", "empty-note", "No application-side ad events recorded yet."));
    } else {
      entries.forEach(([type, n]) => {
        const row = el("div", "stat-row");
        row.innerHTML = `<span>${escapeHtml(type.replace(/_/g, " "))}</span><strong>${formatNumber(n)}</strong>`;
        byType.appendChild(row);
      });
    }
  }

  const top = $("#ov-top-players");
  if (top) {
    top.innerHTML = "";
    (data.top_players || []).forEach((p, i) => {
      const row = el("div", "stat-row");
      row.innerHTML = `<span>#${i + 1} @${escapeHtml(p.username)}</span><strong>${formatNumber(p.total_taps)} taps</strong>`;
      top.appendChild(row);
    });
    if (!(data.top_players || []).length) top.appendChild(el("p", "empty-note", "No players yet."));
  }
}

/* -----------------------------------------------------------------------------
 * 2. Users
 * -------------------------------------------------------------------------- */

function bindUsers() {
  const search = $("#user-search");
  search?.addEventListener("input", () => {
    window.clearTimeout(bindUsers.timer);
    bindUsers.timer = window.setTimeout(() => {
      state.userQuery = search.value.trim();
      state.userPage = 0;
      loadUsers(0);
    }, 280);
  });

  $("#user-prev")?.addEventListener("click", () => loadUsers(state.userPage - 1));
  $("#user-next")?.addEventListener("click", () => loadUsers(state.userPage + 1));
  $("#user-refresh")?.addEventListener("click", () => loadUsers(state.userPage));

  $("#user-reveal")?.addEventListener("click", (e) => {
    state.masked = !state.masked;
    e.currentTarget.textContent = state.masked ? "Reveal emails" : "Hide emails";
    renderUsers();
  });

  $("#user-table")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-user-action]");
    if (!btn) return;
    const id = btn.dataset.userId;
    const action = btn.dataset.userAction;
    if (action === "admin") toggleAdmin(id, btn);
    if (action === "grant") grantCoins(id);
    if (action === "detail") showUser(id);
  });
}

async function loadUsers(page) {
  const size = 25;
  const offset = Math.max(0, page) * size;
  try {
    const data = await rpc("admin_search_users", {
      p_query: state.userQuery || null,
      p_limit: size,
      p_offset: offset
    });
    state.users = data?.users || [];
    state.userTotal = data?.total || 0;
    state.userPage = Math.max(0, page);
    renderUsers();
  } catch (err) {
    toast(friendlyError(err), "error");
  }
}

function maskEmail(email) {
  if (!email) return "-";
  if (!state.masked) return email;
  const [user, domain] = email.split("@");
  if (!domain) return email;
  const head = user.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, user.length - 1))}@${domain}`;
}

function renderUsers() {
  const tbody = $("#user-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!state.users.length) {
    const tr = el("tr");
    tr.innerHTML = '<td colspan="7" class="empty-note">No users found.</td>';
    tbody.appendChild(tr);
  }

  state.users.forEach((u) => {
    const tr = el("tr");
    tr.innerHTML = `
      <td><strong>@${escapeHtml(u.username)}</strong>${u.is_admin ? ' <span class="pill pill--admin">ADMIN</span>' : ""}</td>
      <td>${escapeHtml(maskEmail(u.email))}</td>
      <td>${formatNumber(u.total_taps)}</td>
      <td>${formatCoins(u.coins)}</td>
      <td>LV ${u.level}</td>
      <td title="${escapeHtml(formatDate(u.created_at, true))}">${escapeHtml(relativeTime(u.created_at))}</td>
      <td class="table-actions">
        <button class="btn btn--tiny" type="button" data-user-action="detail" data-user-id="${u.id}">View</button>
        <button class="btn btn--tiny" type="button" data-user-action="grant" data-user-id="${u.id}">Coins</button>
        <button class="btn btn--tiny ${u.is_admin ? "btn--danger" : ""}" type="button"
                data-user-action="admin" data-user-id="${u.id}">${u.is_admin ? "Revoke" : "Make admin"}</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  setText("#user-range", `${state.users.length ? state.userPage * 25 + 1 : 0}-${state.userPage * 25 + state.users.length} of ${formatNumber(state.userTotal)}`);
  const prev = $("#user-prev");
  const next = $("#user-next");
  if (prev) prev.disabled = state.userPage === 0;
  if (next) next.disabled = (state.userPage + 1) * 25 >= state.userTotal;
}

function showUser(id) {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  const body = $("#user-detail-body");
  if (body) {
    body.innerHTML = `
      <div class="kv"><span>Username</span><strong>@${escapeHtml(u.username)}</strong></div>
      <div class="kv"><span>Display name</span><strong>${escapeHtml(u.display_name || "-")}</strong></div>
      <div class="kv"><span>Email</span><strong>${escapeHtml(maskEmail(u.email))}</strong></div>
      <div class="kv"><span>User ID</span><strong class="mono">${escapeHtml(u.id)}</strong></div>
      <div class="kv"><span>Total taps</span><strong>${formatNumber(u.total_taps)}</strong></div>
      <div class="kv"><span>Coins</span><strong>${formatCoins(u.coins)}</strong></div>
      <div class="kv"><span>Level</span><strong>${u.level}</strong></div>
      <div class="kv"><span>Created</span><strong>${escapeHtml(formatDate(u.created_at, true))}</strong></div>
      <div class="kv"><span>Last seen</span><strong>${escapeHtml(relativeTime(u.last_seen))}</strong></div>
      <div class="kv"><span>Admin</span><strong>${u.is_admin ? "Yes" : "No"}</strong></div>
    `;
  }
  openSheet("sheet-user-detail");
}

async function grantCoins(userId) {
  const raw = window.prompt("Coin adjustment (negative to remove):", "1000");
  if (raw === null) return;
  const delta = Number.parseInt(raw, 10);
  if (!Number.isFinite(delta) || delta === 0) {
    toast("Enter a non-zero whole number.", "warn");
    return;
  }
  await once("adjust", async () => {
    try {
      const res = await rpc("admin_adjust_coins", { p_user_id: userId, p_delta: delta, p_reason: "admin adjustment" });
      toast(`Balance updated: ${formatCoins(res.coins)} coins.`, "success");
      feedback("reward");
      loadUsers(state.userPage);
    } catch (err) {
      toast(friendlyError(toError(err)), "error");
    }
  });
}

async function toggleAdmin(userId, button) {
  const current = state.users.find((u) => u.id === userId);
  const grant = !current?.is_admin;
  if (
    grant &&
    !window.confirm("Grant administrator access to this user? Administrators can change all game settings.")
  ) {
    return;
  }
  await once(`admin:${userId}`, async () => {
    button.disabled = true;
    try {
      await rpc("admin_set_admin", { p_user_id: userId, p_role: "admin", p_grant: grant });
      toast(grant ? "Administrator granted." : "Administrator removed.", "success");
      loadUsers(state.userPage);
    } catch (err) {
      toast(friendlyError(err), "error");
      button.disabled = false;
    }
  });
}

/* -----------------------------------------------------------------------------
 * 3. + 6. Game settings and system settings
 * -------------------------------------------------------------------------- */

function bindSettings() {
  $("#settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {};

    const appName = $("#set-app-name")?.value.trim();
    if (appName) payload.app_name = JSON.stringify(appName.slice(0, 40));

    const support = $("#set-support-email")?.value.trim();
    if (support) payload.support_email = JSON.stringify(support.slice(0, 120));

    const tagline = $("#set-tagline")?.value.trim();
    if (tagline) payload.tagline = JSON.stringify(tagline.slice(0, 120));

    const privacy = $("#set-privacy-url")?.value.trim();
    if (privacy) payload.privacy_url = JSON.stringify(privacy.slice(0, 200));

    const terms = $("#set-terms-url")?.value.trim();
    if (terms) payload.terms_url = JSON.stringify(terms.slice(0, 200));

    const tapValue = safeInt($("#set-tap-value")?.value, 1, { min: 1, max: 1000 });
    payload.tap_value = tapValue;

    const maintenance = $("#set-maintenance")?.checked === true;
    payload.maintenance_mode = maintenance;

    const rewardsRaw = $("#set-daily-rewards")?.value.trim() ?? "";
    const table = rewardsRaw
      .split(",")
      .map((n) => Number.parseInt(n.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (table.length) payload.daily_rewards = table;

    for (const [key, value] of Object.entries(payload)) {
      try {
        await rpc("admin_set_setting", { p_key: key, p_value: value });
      } catch (err) {
        toast(`${key}: ${friendlyError(err)}`, "error");
      }
    }
    feedback("reward");
    toast("Settings saved.", "success");
    await loadSettings();
  });

  $("#set-daily-reset")?.addEventListener("click", () => {
    $("#set-daily-rewards").value = CONFIG.dailyRewardFallback.join(", ");
  });

  $("#up-reset")?.addEventListener("click", () => {
    $("#upgrade-form").reset();
    $("#up-id").value = "";
    $("#up-active").checked = true;
    $("#up-cost").value = 100;
    $("#up-growth").value = 1.15;
    $("#up-multiplier").value = 1.15;
    $("#up-max").value = 20;
  });
}

async function loadSettings() {
  try {
    const data = await rpc("admin_list_settings", {});
    state.settings = data?.settings || {};
  } catch (err) {
    toast(friendlyError(err), "error");
    return;
  }
  const s = state.settings;

  const fill = (sel, value) => {
    const node = $(sel);
    if (node && (document.activeElement !== node)) node.value = value ?? "";
  };

  fill("#set-app-name", str(s.app_name, "TAPX"));
  fill("#set-tagline", str(s.tagline, ""));
  fill("#set-support-email", str(s.support_email, ""));
  fill("#set-privacy-url", str(s.privacy_url, "privacy.html"));
  fill("#set-terms-url", str(s.terms_url, "terms.html"));
  fill("#set-tap-value", num(s.tap_value, 1));
  fill("#set-daily-rewards", Array.isArray(s.daily_rewards) ? s.daily_rewards.join(", ") : CONFIG.dailyRewardFallback.join(", "));

  const maintenance = $("#set-maintenance");
  if (maintenance) maintenance.checked = s.maintenance_mode === true;

  const adsMaster = $("#ads-master");
  if (adsMaster && document.activeElement !== adsMaster) {
    adsMaster.checked = s.ads_enabled === true;
  }
}

/* -----------------------------------------------------------------------------
 * Ad code editor (Admin > Ads)
 *
 * The official publisher snippet is stored in public.ad_placements.code and
 * written only through admin_set_ad_code(), which verifies admin rights in the
 * database. Nothing here runs on the game page; this only manages the text.
 * -------------------------------------------------------------------------- */

const MAX_CODE_LENGTH = 20000;

function currentCodePlacement() {
  const slug = $("#code-slug")?.value;
  return state.placements.find((p) => p.slug === slug) || null;
}

/** Populate the placement <select> and show the stored snippet. */
function renderAdCodeEditor() {
  const select = $("#code-slug");
  if (!select) return;

  const previous = select.value;
  select.innerHTML = "";

  state.placements.forEach((p) => {
    const option = document.createElement("option");
    option.value = p.slug;
    option.textContent = `${p.slug} - ${p.location}`;
    select.appendChild(option);
  });

  if (previous && state.placements.some((p) => p.slug === previous)) {
    select.value = previous;
  }

  fillAdCodeFields();
}

/** Show the snippet saved for the selected placement. */
function fillAdCodeFields() {
  const placement = currentCodePlacement();
  const area = $("#code-value");
  if (!area) return;

  // Never overwrite text the admin is in the middle of typing.
  if (document.activeElement !== area) {
    area.value = placement?.code || "";
  }

  const status = $("#code-status");
  if (status) {
    const length = (placement?.code || "").length;
    status.textContent = placement
      ? length
        ? `Saved - ${length} characters.`
        : "No snippet saved yet."
      : "No placement selected.";
  }

  updateCodeCount();
}

function updateCodeCount() {
  const counter = $("#code-count");
  const area = $("#code-value");
  if (!counter || !area) return;
  const length = area.value.length;
  counter.textContent = String(length);
  counter.style.color = length > MAX_CODE_LENGTH ? "var(--danger)" : "";
}

function bindAdCodeEditor() {
  $("#code-slug")?.addEventListener("change", fillAdCodeFields);

  $("#code-value")?.addEventListener("input", updateCodeCount);

  $("#code-save")?.addEventListener("click", async (e) => {
    const placement = currentCodePlacement();
    const area = $("#code-value");
    if (!placement || !area) return;

    const code = area.value.trim();
    if (!code) {
      toast("Paste the official snippet first, or use Clear code.", "warn");
      return;
    }

    await once("adcode", async () => {
      try {
        const res = await rpc("admin_set_ad_code", {
          p_slug: placement.slug,
          p_code: code
        });
        if (res?.has_code) {
          placement.code = code;
          toast(`Code saved for "${placement.slug}" (${res.code_length} characters).`, "success");
        }
        await loadContent();
      } catch (err) {
        toast(friendlyError(err), "error", 6000);
      }
    });
  });

  $("#code-clear")?.addEventListener("click", async (e) => {
    const placement = currentCodePlacement();
    if (!placement) return;
    if (!window.confirm(`Remove the saved ad code for "${placement.slug}"?`)) return;

    await once("adcode", async () => {
      try {
        await rpc("admin_set_ad_code", { p_slug: placement.slug, p_code: "" });
        placement.code = "";
        const area = $("#code-value");
        if (area) area.value = "";
        toast(`Code cleared for "${placement.slug}".`, "success");
        await loadContent();
      } catch (err) {
        toast(friendlyError(err), "error");
      }
    });
  });

  $("#code-reload")?.addEventListener("click", async () => {
    try {
      await loadContent();
      toast("Reloaded from the server.", "info");
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  });
}

/** Recreate the three canonical placements if the table was never seeded. */
function bindPlacementRestore() {
  $("#pl-restore")?.addEventListener("click", async () => {
    await once("plrestore", async () => {
      try {
        const res = await rpc("admin_ensure_placements", {});
        toast(`Default placements restored (${res?.count ?? 0} rows).`, "success");        await loadContent();
      } catch (err) {
        toast(friendlyError(err), "error");
      }
    });
  });
}

/** The remote master switch: ads_enabled in app_settings. */
function bindAdMasterSwitch() {
  $("#ads-master")?.addEventListener("change", async (e) => {
    const wanted = e.currentTarget.checked;
    await once("adsmaster", async () => {
      try {
        await rpc("admin_set_setting", { p_key: "ads_enabled", p_value: wanted });
        state.settings.ads_enabled = wanted;
        toast(wanted ? "Ads are now live on the game page." : "All ads are now hidden.", "success");
      } catch (err) {
        e.currentTarget.checked = !wanted;
        toast(friendlyError(err), "error");
      }
    });
  });
}

function str(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/* -----------------------------------------------------------------------------
 * 4. Ads
 * -------------------------------------------------------------------------- */

function bindAds() {
  bindAdCodeEditor();
  bindAdMasterSwitch();
  bindPlacementRestore();

  $("#placement-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#pl-id").value.trim();
    const payload = {
      p_id: id ? Number(id) : null,
      p_slug: $("#pl-slug").value.trim().toLowerCase(),
      p_label: $("#pl-label").value.trim(),
      p_location: $("#pl-location").value,
      p_description: $("#pl-description").value.trim() || null,
      p_enabled: $("#pl-enabled").checked,
      p_sort_order: safeInt($("#pl-order").value, 0, { min: 0, max: 999 })
    };
    if (!payload.p_slug || !payload.p_label) {
      toast("Slug and label are required.", "warn");
      return;
    }
    try {
      await rpc("admin_save_placement", payload);
      toast("Placement saved.", "success");
      $("#placement-form").reset();
      $("#pl-id").value = "";
      await loadContent();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  });

  $("#placement-table")?.addEventListener("click", (e) => {
    const edit = e.target.closest("[data-pl-edit]");
    if (edit) {
      const p = state.placements.find((x) => String(x.id) === edit.dataset.plEdit);
      if (!p) return;
      $("#pl-id").value = p.id;
      $("#pl-slug").value = p.slug;
      $("#pl-label").value = p.label;
      $("#pl-location").value = p.location;
      $("#pl-description").value = p.description || "";
      $("#pl-enabled").checked = p.enabled === true;
      $("#pl-order").value = p.sort_order ?? 0;
      $("#placement-form").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const del = e.target.closest("[data-pl-delete]");
    if (del) {
      if (!window.confirm("Delete this placement?")) return;
      rpc("admin_delete_placement", { p_id: Number(del.dataset.plDelete) })
        .then(() => {
          toast("Placement deleted.", "success");
          loadContent();
        })
        .catch((err) => toast(friendlyError(err), "error"));
    }
  });
}

/* -----------------------------------------------------------------------------
 * Upgrades & milestones editors
 * -------------------------------------------------------------------------- */

function bindUpgrades() {
  $("#upgrade-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#up-id").value.trim();
    try {
      await rpc("admin_save_upgrade", {
        p_id: id ? Number(id) : null,
        p_slug: $("#up-slug").value.trim().toLowerCase(),
        p_name: $("#up-name").value.trim(),
        p_description: $("#up-description").value.trim() || null,
        p_icon: $("#up-icon").value,
        p_base_cost: safeBigInt($("#up-cost").value, 100, { min: 1, max: 1e12 }),
        p_growth: Number($("#up-growth").value) || 1.15,
        p_multiplier: Number($("#up-multiplier").value) || 1.15,
        p_max_level: safeInt($("#up-max").value, 20, { min: 1, max: 500 }),
        p_sort_order: safeInt($("#up-order").value, 0, { min: 0, max: 999 }),
        p_active: $("#up-active").checked
      });
      toast("Upgrade saved.", "success");
      $("#upgrade-form").reset();
      $("#up-id").value = "";
      await loadContent();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  });

  $("#upgrade-table")?.addEventListener("click", (e) => {
    const edit = e.target.closest("[data-up-edit]");
    if (edit) fillUpgradeForm(state.upgrades.find((x) => String(x.id) === edit.dataset.upEdit));
    const del = e.target.closest("[data-up-delete]");
    if (del) {
      if (!window.confirm("Delete this upgrade? Players lose it.")) return;
      rpc("admin_delete_upgrade", { p_id: Number(del.dataset.upDelete) })
        .then(() => {
          toast("Upgrade deleted.", "success");
          loadContent();
        })
        .catch((err) => toast(friendlyError(err), "error"));
    }
  });
}

function fillUpgradeForm(u) {
  if (!u) return;
  $("#up-id").value = u.id;
  $("#up-slug").value = u.slug;
  $("#up-name").value = u.name;
  $("#up-description").value = u.description || "";
  $("#up-icon").value = u.icon || "bolt";
  $("#up-cost").value = u.base_cost;
  $("#up-growth").value = u.growth;
  $("#up-multiplier").value = u.multiplier;
  $("#up-max").value = u.max_level;
  $("#up-order").value = u.sort_order;
  $("#up-active").checked = u.active;
  $("#upgrade-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function bindMilestones() {
  $("#milestone-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#ms-id").value.trim();
    try {
      await rpc("admin_save_milestone", {
        p_id: id ? Number(id) : null,
        p_name: $("#ms-name").value.trim(),
        p_description: $("#ms-description").value.trim() || null,
        p_tap_requirement: safeBigInt($("#ms-taps").value, 100, { min: 1, max: 1e15 }),
        p_reward_coins: safeBigInt($("#ms-coins").value, 500, { min: 0, max: 1e15 }),
        p_sort_order: safeInt($("#ms-order").value, 0, { min: 0, max: 999 }),
        p_active: $("#ms-active").checked
      });
      toast("Milestone saved.", "success");
      $("#milestone-form").reset();
      $("#ms-id").value = "";
      await loadContent();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  });

  $("#milestone-table")?.addEventListener("click", (e) => {
    const edit = e.target.closest("[data-ms-edit]");
    if (edit) {
      const m = state.milestones.find((x) => String(x.id) === edit.dataset.msEdit);
      if (!m) return;
      $("#ms-id").value = m.id;
      $("#ms-name").value = m.name;
      $("#ms-description").value = m.description || "";
      $("#ms-taps").value = m.tap_requirement;
      $("#ms-coins").value = m.reward_coins;
      $("#ms-order").value = m.sort_order;
      $("#ms-active").checked = m.active;
      $("#milestone-form").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const del = e.target.closest("[data-ms-delete]");
    if (del) {
      if (!window.confirm("Delete this milestone?")) return;
      rpc("admin_delete_milestone", { p_id: Number(del.dataset.msDelete) })
        .then(() => {
          toast("Milestone deleted.", "success");
          loadContent();
        })
        .catch((err) => toast(friendlyError(err), "error"));
    }
  });
}

/* -----------------------------------------------------------------------------
 * 5. Announcements
 * -------------------------------------------------------------------------- */

function bindAnnouncements() {
  $("#announcement-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#an-id").value.trim();
    try {
      await rpc("admin_save_announcement", {
        p_id: id ? Number(id) : null,
        p_title: $("#an-title").value.trim(),
        p_message: $("#an-message").value.trim(),
        p_active: $("#an-active").checked
      });
      toast("Announcement saved.", "success");
      $("#announcement-form").reset();
      $("#an-id").value = "";
      await loadContent();
    } catch (err) {
      toast(friendlyError(err), "error");
    }
  });

  $("#announcement-table")?.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-an-toggle]");
    if (toggle) {
      const a = state.announcements.find((x) => String(x.id) === toggle.dataset.anToggle);
      if (!a) return;
      rpc("admin_save_announcement", {
        p_id: a.id,
        p_title: a.title,
        p_message: a.message,
        p_active: !a.active
      })
        .then(() => {
          toast(a.active ? "Announcement hidden." : "Announcement published.", "success");
          loadContent();
        })
        .catch((err) => toast(friendlyError(err), "error"));
      return;
    }
    const edit = e.target.closest("[data-an-edit]");
    if (edit) {
      const a = state.announcements.find((x) => String(x.id) === edit.dataset.anEdit);
      if (!a) return;
      $("#an-id").value = a.id;
      $("#an-title").value = a.title;
      $("#an-message").value = a.message;
      $("#an-active").checked = a.active;
      $("#announcement-form").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const del = e.target.closest("[data-an-delete]");
    if (del) {
      if (!window.confirm("Delete this announcement?")) return;
      rpc("admin_delete_announcement", { p_id: Number(del.dataset.anDelete) })
        .then(() => {
          toast("Announcement deleted.", "success");
          loadContent();
        })
        .catch((err) => toast(friendlyError(err), "error"));
    }
  });
}

/* -----------------------------------------------------------------------------
 * Content loading
 * -------------------------------------------------------------------------- */

async function loadContent() {
  // The public config only returns enabled placements and active upgrades.
  // For the editor we need everything, so read through the admin views.
  try {
    const data = await loadAdminCatalogue();
    state.placements = data.placements;
    state.upgrades = data.upgrades;
    state.milestones = data.milestones;
    state.announcements = data.announcements;
    renderContent();
  } catch (err) {
    toast(friendlyError(err), "error");
  }
}

async function loadAdminCatalogue() {
  const sb = supabase();
  const { data, error } = await sb
    .from("ad_placements")
    .select("id, slug, label, location, description, enabled, sort_order, code")
    .order("sort_order");
  if (error) throw toError(error);
  const placements = data || [];

  const { data: ups, error: e1 } = await sb
    .from("upgrades")
    .select("id, slug, name, description, icon, base_cost, growth, multiplier, max_level, sort_order, active")
    .order("sort_order");
  if (e1) throw toError(e1);

  const { data: ms, error: e2 } = await sb
    .from("milestones")
    .select("id, name, description, tap_requirement, reward_coins, sort_order, active")
    .order("sort_order");
  if (e2) throw toError(e2);

  const { data: ans, error: e3 } = await sb
    .from("site_announcements")
    .select("id, title, message, active, created_at")
    .order("created_at", { ascending: false });
  if (e3) throw toError(e3);

  return {
    placements,
    upgrades: ups || [],
    milestones: ms || [],
    announcements: ans || []
  };
}

function renderContent() {
  renderAdCodeEditor();

  renderTable(
    "#placement-table tbody",
    state.placements,
    (p) => `
      <td><code>${escapeHtml(p.slug)}</code></td>
      <td>${escapeHtml(p.label)}</td>
      <td>${escapeHtml(p.location)}</td>
      <td><span class="pill ${p.code ? "pill--on" : "pill--off"}">${p.code ? "SET" : "NONE"}</span></td>
      <td><span class="pill ${p.enabled ? "pill--on" : "pill--off"}">${p.enabled ? "ON" : "OFF"}</span></td>
      <td class="table-actions">
        <button class="btn btn--tiny" type="button" data-pl-edit="${p.id}">Edit</button>
        <button class="btn btn--tiny btn--danger" type="button" data-pl-delete="${p.id}">Delete</button>
      </td>`,
    "No placements yet. Press \"Restore the 5 default placements\" below, or run supabase/seed.sql in the Supabase SQL Editor."
  );

  renderTable(
    "#upgrade-table tbody",
    state.upgrades,
    (u) => `
      <td>${escapeHtml(u.name)}<br /><code>${escapeHtml(u.slug)}</code></td>
      <td>${formatCoins(u.base_cost)}</td>
      <td>${Number(u.growth).toFixed(2)}</td>
      <td>${u.max_level}</td>
      <td><span class="pill ${u.active ? "pill--on" : "pill--off"}">${u.active ? "ON" : "OFF"}</span></td>
      <td class="table-actions">
        <button class="btn btn--tiny" type="button" data-up-edit="${u.id}">Edit</button>
        <button class="btn btn--tiny btn--danger" type="button" data-up-delete="${u.id}">Delete</button>
      </td>`
  );

  renderTable(
    "#milestone-table tbody",
    state.milestones,
    (m) => `
      <td>${escapeHtml(m.name)}</td>
      <td>${formatNumber(m.tap_requirement)}</td>
      <td>${formatCoins(m.reward_coins)}</td>
      <td><span class="pill ${m.active ? "pill--on" : "pill--off"}">${m.active ? "ON" : "OFF"}</span></td>
      <td class="table-actions">
        <button class="btn btn--tiny" type="button" data-ms-edit="${m.id}">Edit</button>
        <button class="btn btn--tiny btn--danger" type="button" data-ms-delete="${m.id}">Delete</button>
      </td>`
  );

  renderTable(
    "#announcement-table tbody",
    state.announcements,
    (a) => `
      <td><strong>${escapeHtml(a.title)}</strong><br /><small>${escapeHtml(a.message)}</small></td>
      <td><span class="pill ${a.active ? "pill--on" : "pill--off"}">${a.active ? "LIVE" : "HIDDEN"}</span></td>
      <td>${escapeHtml(relativeTime(a.created_at))}</td>
      <td class="table-actions">
        <button class="btn btn--tiny" type="button" data-an-edit="${a.id}">Edit</button>
        <button class="btn btn--tiny" type="button" data-an-toggle="${a.id}">${a.active ? "Hide" : "Publish"}</button>
        <button class="btn btn--tiny btn--danger" type="button" data-an-delete="${a.id}">Delete</button>
      </td>`
  );
}

function renderTable(selector, rows, rowHtml, emptyMessage = "Nothing here yet.") {
  const tbody = $(`${selector}`);
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = el("tr");
    tr.innerHTML = `<td colspan="6" class="empty-note">${escapeHtml(emptyMessage)}</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach((row) => {
    const tr = el("tr");
    tr.innerHTML = rowHtml(row);
    tbody.appendChild(tr);
  });
}

/* -----------------------------------------------------------------------------
 * Header / footer
 * -------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  const back = $("#admin-back");
  if (back) back.setAttribute("href", pageUrl("index.html"));
  const home = $("[data-brand]");
  if (home) home.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.href = pageUrl("index.html");
  });
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
