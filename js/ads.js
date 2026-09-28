/* =============================================================================
 * TAPX - js/ads.js
 * -----------------------------------------------------------------------------
 * Ad placements for Adsterra (or any network that allows publisher placements).
 *
 * READ THIS BEFORE EDITING
 * ------------------------
 *   1. This file never invents, guesses or generates ad code. The exact
 *      official snippet is pasted by an admin in Admin > Ads, stored in
 *      public.ad_placements.code, and rendered here into the three EMPTY,
 *      VISIBLE containers that already exist in index.html.
 *   2. To monetise: open Admin > Ads, pick a placement, paste the exact snippet
 *      your network gave you, press "Save code", switch the placement ON and
 *      switch the master "Ads enabled" switch ON. No file editing required.
 *      index.html can still be used instead as a fallback.
 *   3. Impression and click reporting is done exclusively by the official
 *      network code. TAPX does not simulate, refresh or manufacture any of it.
 *   4. recordAllowedEvent() writes one row to the app's own `ad_events` table
 *      so the site owner can see that a user opened a real placement. It is an
 *      application-side log, is rate limited, and is never sent to the network.
 *      It cannot inflate network statistics.
 *
 * TRUST MODEL
 * -----------
 *   The code column is written only through admin_set_ad_code(), which calls
 *   require_admin() server-side, so only a signed-in administrator can change
 *   it. It is injected verbatim because that is the whole point: a publisher
 *   snippet is a <script> tag and cannot be made to work any other way. An
 *   administrator can therefore already run arbitrary JavaScript on this site
 *   (they control the app name, the announcements and every setting), so this
 *   does not widen the existing trust boundary. Keep exactly one trusted admin
 *   account and give it a strong password.
 *
 * POLICY CONSTRAINTS ENFORCED HERE
 * --------------------------------
 *   * A placement is injected at most once per page load. It is never
 *     re-injected on a tap, on a settings refresh, on tab focus or on a
 *     timer, so no ad refresh loop exists.
 *   * document.write() snippets are rejected on save and again here, because
 *     injected after load they would blank the page.
 *   * A failing snippet is contained: the game keeps working without ads.
 * ========================================================================== */

import { CONFIG } from "./config.js";
import { rpc } from "./supabase.js";
import { $, on, toast } from "./ui.js";

/* One entry per ad container in index.html. Every unit here loads exactly
 * once per page view; nothing is ever re-injected or refreshed. */
const LOCATION_TO_CONTAINER = {
  top: "#ad-top",
  stats: "#ad-stats",
  between: "#ad-between",
  inline: "#ad-inline",
  bottom: "#ad-bottom"
};

const MAX_CODE_LENGTH = 20000;

const state = {
  enabled: false,
  placements: [],
  maintenance: false
};

const lastRecorded = new Map();

/* slug -> the exact code string already injected on this page load. Once a slug
 * is present here it is never touched again, which is what guarantees that a
 * settings refresh can never double-load or refresh an ad. */
const injected = new Map();

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

export const AdManager = {
  /** Load placement configuration and mount/dismount the visible containers. */
  init,

  /** Register a placement returned by get_public_config(). */
  registerPlacement,

  /** Make a placement visible (empty container) if it is enabled. */
  showAllowedPlacement,

  /** Log one genuine application-side event for a placement. */
  recordAllowedEvent,

  /** True when ads are switched on globally. */
  isEnabled: () => state.enabled,

  /** Current placement list. */
  getPlacements: () => state.placements.slice()
};

/* -----------------------------------------------------------------------------
 * Implementation
 * -------------------------------------------------------------------------- */

async function init() {
  // CONFIG.ads.enabled is only a local kill switch. The real on/off control is
  // the "ads_enabled" app setting, toggled from the admin panel, so the owner
  // never has to edit a file to turn ads on or off.
  state.enabled = Boolean(CONFIG.ads.enabled);
  state.maintenance = false;

  let config = null;
  try {
    config = await rpc("get_public_config", {});
  } catch (err) {
    // No config = no ad containers. The game must keep working regardless.
    console.warn("[ads] could not load placement config:", err.message);
    return;
  }

  applyConfig(config);
  state.placements.forEach(registerPlacement);

  on("config:refresh", (e) => {
    // Re-read the config, but never re-inject: an injected placement is frozen
    // for the lifetime of this page load.
    applyConfig(e.detail);
  });
}

/** Pull the parts of the public config this module cares about into `state`. */
function applyConfig(config) {
  if (!config || typeof config !== "object") return;
  if (Array.isArray(config.placements)) state.placements = config.placements;
  state.maintenance = config?.settings?.maintenance_mode === true;
  state.enabled =
    Boolean(CONFIG.ads.enabled) && config?.settings?.ads_enabled === true;
}

/**
 * Register one placement: find its container and apply the enabled flag.
 * A placement that is disabled leaves an empty, invisible container behind.
 */
function registerPlacement(placement) {
  if (!placement || !placement.slug) return null;
  const selector = LOCATION_TO_CONTAINER[placement.location];
  if (!selector) return null;

  const host = $(selector);
  if (!host) return null;

  host.dataset.placement = placement.slug;
  host.dataset.label = placement.label || "Sponsored";

  // Keep the visible "Sponsored" label; do not touch anything else yet.
  const badge = host.querySelector(".ad-slot__label");
  if (badge) badge.textContent = placement.label || "Sponsored";

  if (state.enabled && placement.enabled) {
    showAllowedPlacement(placement.slug);
  } else {
    host.hidden = true;
    host.classList.remove("is-visible", "is-empty");
  }

  // A visible link out is the honest way to handle a click on a banner.
  host.addEventListener(
    "click",
    (e) => {
      const link = e.target.closest("a");
      if (!link) return;
      recordAllowedEvent(placement.slug, "placement_click");
    },
    { passive: true }
  );

  return host;
}

/**
 * Show a placement.
 *
 * The official snippet comes from the database when an admin has saved one for
 * this placement; otherwise whatever already sits in the container (the manual
 * index.html fallback) is used as-is. With no snippet at all the slot shows an
 * honest placeholder rather than a reserved empty box.
 */
function showAllowedPlacement(slug) {
  const placement = state.placements.find((p) => p.slug === slug);
  if (!placement) return false;
  if (!state.enabled || !placement.enabled) return false;

  const host = $(LOCATION_TO_CONTAINER[placement.location]);
  if (!host) return false;

  const code = typeof placement.code === "string" ? placement.code.trim() : "";

  if (code) {
    host.hidden = false;
    host.classList.add("is-visible");
    host.classList.remove("is-empty", "is-error");

    // At most once per page load, and only once per distinct snippet. This is
    // what makes an ad refresh or a double load impossible.
    if (!injected.has(placement.slug)) {
      injected.set(placement.slug, code);
      injectSnippet(host, placement.slug, code);
    }

    recordAllowedEvent(placement.slug, "placement_view");
    return true;
  }

  const hasStaticCode =
    host.querySelector("script, iframe, ins, .adsbygoogle") !== null;

  if (!hasStaticCode) {
    // Nothing saved yet - show an honest placeholder instead of an empty box.
    host.hidden = false;
    host.classList.add("is-visible", "is-empty");
    return true;
  }

  host.hidden = false;
  host.classList.add("is-visible");
  host.classList.remove("is-empty");
  return true;
}

/**
 * Insert an official publisher snippet into a visible container.
 *
 * Scripts assigned through innerHTML never execute, so the snippet is parsed in
 * an inert <template> and every <script> is rebuilt as a live element before
 * the fragment is attached. Attaching is what triggers execution, and it
 * happens exactly once, here, on page load - never on a tap or on a timer.
 */
function injectSnippet(host, slug, code) {
  if (code.length > MAX_CODE_LENGTH) {
    console.warn("[ads] snippet too long, skipped:", slug);
    return false;
  }
  if (/document\s*\.\s*write\s*\(/.test(code)) {
    console.warn("[ads] document.write() snippet refused:", slug);
    return false;
  }

  try {
    // Drop a previous manual paste so the two cannot stack into two ads.
    Array.from(host.children).forEach((child) => {
      if (!child.classList.contains("ad-slot__label")) child.remove();
    });

    const template = document.createElement("template");
    template.innerHTML = code;

    template.content.querySelectorAll("script").forEach((original) => {
      const live = document.createElement("script");
      for (const attr of original.attributes) {
        live.setAttribute(attr.name, attr.value);
      }
      live.textContent = original.textContent;
      original.replaceWith(live);
    });

    host.appendChild(template.content);
    return true;
  } catch (err) {
    // A broken snippet must never take the game down with it.
    console.warn("[ads] could not render placement", slug, err);
    host.classList.add("is-error");
    return false;
  }
}

/**
 * Record that the app did something legitimate with a placement.
 *
 * This is a local application log only:
 *   * placement must exist and be enabled (enforced again by a DB trigger)
 *   * one event per placement per CONFIG.ads.recordCooldownMs (client side)
 *   * one event per placement per minute (server side, in guard_ad_event)
 *   * never triggers a network request, never reloads an ad
 */
async function recordAllowedEvent(slug, eventType = "placement_view") {
  if (!state.enabled) return false;
  if (!slug) return false;
  if (!["placement_view", "placement_click", "reward_view", "reward_complete"].includes(eventType)) {
    return false;
  }

  const now = Date.now();
  const key = `${slug}:${eventType}`;
  if (now - (lastRecorded.get(key) ?? 0) < CONFIG.ads.recordCooldownMs) return false;
  lastRecorded.set(key, now);

  try {
    await rpc("record_ad_event", { p_placement: slug, p_event_type: eventType });
    return true;
  } catch {
    // Silent by design: a logging failure must never interrupt the game and
    // must never surface ad-network information to the player.
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Optional rewarded flow
 * -----------------------------------------------------------------------------
 * If the publisher's network offers an opt-in "rewarded" format, bind it here
 * with the official API of that network. TAPX does not simulate a reward and
 * never grants a reward for an ad that did not actually complete.
 * -------------------------------------------------------------------------- */

/**
 * Hook up a real, network-provided reward trigger.
 * @param {(onReward: (payload:object)=>void) => void} bindNetworkCallback
 *        Receives a callback that the site owner wires to the official
 *        network's reward callback inside index.html.
 * @returns {() => void} teardown
 */
export function bindRewardedAd(bindNetworkCallback) {
  if (typeof bindNetworkCallback !== "function") return () => {};
  return bindNetworkCallback((payload) => {
    // Only rewards actually reported by the network reach this point.
    recordAllowedEvent("reward", "reward_complete");
    window.dispatchEvent(new CustomEvent("tapx:ad-reward", { detail: payload }));
  });
}

export function showAdError() {
  toast("Ad unavailable. The game works exactly the same without it.", "info", 2600);
}
