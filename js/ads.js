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
 *
 * SCRIPT-ONLY FORMATS (popunder, smartlink)
 * ------------------------------------------
 *   These are not placements. They have no visible box in the page, so they are
 *   kept in a separate database table and never given one of the five visible
 *   containers. Each loads exactly once per page view, and only while the
 *   master ads switch is on.
 *
 *   The popunder is the network's own script. TAPX does not open a window, does
 *   not hook clicks, and does not decide when it fires: the network's code
 *   attaches its own listener and only ever shows on the user's own click on a
 *   link that leaves the game. There is no automatic, timed or tap-triggered
 *   pop path anywhere in this file.
 *
 *   The smartlink is a URL prefix, not code. It is applied to exactly one link,
 *   the explicit Exit button, which is created only once the owner has saved a
 *   smartlink. The privacy, terms and support links are never wrapped: a user
 *   asking for help or reading the privacy policy must reach it directly.
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
  master: false,
  local: false,
  placements: [],
  scripts: [],
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
  state.local = Boolean(CONFIG.ads.enabled);
  state.master = false;
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
  mountScriptFormats();
  report();

  on("config:refresh", (e) => {
    // Re-read the config, but never re-inject: an injected placement is frozen
    // for the lifetime of this page load.
    applyConfig(e.detail);
  });
}

/* -----------------------------------------------------------------------------
 * Script-only formats: popunder and smartlink
 * --------------------------------------------------------------------------
 * A popunder and a smartlink produce no visible box, so they are kept out of
 * LOCATION_TO_CONTAINER entirely. Both are handled once, here, on page load.
 * ------------------------------------------------------------------------- */

/** Where the popunder / smartlink script is attached. Never visible. */
function scriptHost() {
  let host = document.getElementById("tapx-ad-scripts");
  if (!host) {
    host = document.createElement("div");
    host.id = "tapx-ad-scripts";
    // aria-hidden: these formats have no on-page UI to describe, and the Exit
    // button is a normal, labelled control that screen readers already reach.
    host.setAttribute("aria-hidden", "true");
    host.style.display = "none";
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Load every enabled script-only format, once.
 *
 * A script that was already injected this page load is never touched again, so
 * a config refresh cannot reload it. If the master switch is off, nothing is
 * injected at all - that is the remote kill switch.
 */
function mountScriptFormats() {
  const host = scriptHost();
  let loaded = 0;

  // A smartlink is a URL prefix, not a script, so it is applied to the Exit link
  // rather than injected. The Exit link is also the one reliable, clearly
  // labelled place for the network's popunder to open from.
  const smartlink = state.scripts.find((s) => s?.kind === "smartlink");
  applyExitLink(typeof smartlink?.code === "string" ? smartlink.code.trim() : "");

  for (const entry of state.scripts) {
    if (entry?.kind !== "popunder") continue;
    const raw = typeof entry.code === "string" ? entry.code.trim() : "";
    if (!raw) continue;
    if (injected.has("script:popunder")) continue;

    if (state.enabled && injectSnippet(host, "script:popunder", raw)) {
      injected.set("script:popunder", raw);
      loaded += 1;
    }
  }

  if (state.enabled && loaded > 0) {
    console.log(
      `[ads] popunder script loaded once for this page view. It opens only on ` +
        `the user's own click on the Exit link.`
    );
  }
}

/**
 * Point the Exit link at the owner's smartlink, or at its plain destination.
 *
 * The link stays hidden until there is somewhere real to send the user, so it
 * can never be a dead "#" link. With no smartlink it is an ordinary exit link
 * and the popunder still has a clean place to fire from.
 *
 * Only #exit-link is ever wrapped. The privacy, terms and support links are
 * left untouched on purpose, so a user can always reach the legal pages and
 * get help without an ad page in the way.
 */
function applyExitLink(prefix) {
  const link = document.getElementById("exit-link");
  if (!link) return false;

  const destination = (link.dataset.destination || "").trim();

  if (prefix) {
    // Support both common smartlink shapes without the owner having to know the
    // difference: a bare domain gets "?" appended, anything that already carries
    // a query separator is used as-is. The destination is always appended last.
    const separator = /[?&]$/.test(prefix) ? "" : /[?&]/.test(prefix) ? "&" : "?";
    link.href = `${prefix}${separator}url=${encodeURIComponent(destination)}`;
    link.hidden = false;
    if (!injected.has("exit:smartlink")) {
      injected.set("exit:smartlink", prefix);
      console.log("[ads] Exit link is wrapped by the configured smartlink.");
    }
    return true;
  }

  if (destination) {
    link.href = destination;
    link.hidden = false;
    return true;
  }

  link.hidden = true;
  return false;
}

/** Pull the parts of the public config this module cares about into `state`. */
function applyConfig(config) {
  if (!config || typeof config !== "object") return;
  if (Array.isArray(config.placements)) state.placements = config.placements;
  if (Array.isArray(config.scripts)) state.scripts = config.scripts;
  state.maintenance = config?.settings?.maintenance_mode === true;
  state.master = config?.settings?.ads_enabled === true;
  state.enabled = state.local && state.master;
}

/* -----------------------------------------------------------------------------
 * Diagnostic report
 * --------------------------------------------------------------------------
 * A placement that is switched off in the database is filtered out by
 * get_public_config() (`where enabled`) and therefore never reaches this module
 * at all. That is a completely silent failure: the container just stays hidden
 * and nothing appears in the console. This report names the reason for every
 * location so the cause is readable without adding visible debug UI.
 * ------------------------------------------------------------------------- */
function report() {
  const byLocation = new Map(state.placements.map((p) => [p.location, p]));

  const lines = [
    `[ads] local kill switch CONFIG.ads.enabled = ${state.local}`,
    `[ads] remote master switch ads_enabled = ${state.master}`,
    `[ads] global state = ${state.enabled ? "ON" : "OFF"}`
  ];

  for (const [location, selector] of Object.entries(LOCATION_TO_CONTAINER)) {
    const placement = byLocation.get(location);
    const host = $(selector);
    const seen = injected.has(placement?.slug);

    if (!placement) {
      lines.push(
        `[ads] ${location} (${selector}): NOT DELIVERED - the database row is ` +
          `missing or still disabled. It is only sent when enabled = true.`
      );
      continue;
    }

    const len = typeof placement.code === "string" ? placement.code.trim().length : 0;
    const verdict = seen
      ? "injected"
      : !state.enabled
        ? `hidden - global switch is OFF`
        : len === 0
          ? "visible placeholder - no snippet saved yet"
          : "enabled, snippet pending";

    lines.push(`[ads] ${location} (${selector}): ${verdict} [code ${len} chars]`);
    if (host?.classList.contains("is-error")) {
      lines.push(`[ads] ${location}: render error - see the warning above`);
    }
  }

  console.log(lines.join("\n"));
  reportScriptFormats();
}

/** One line per script-only format, so a silent popunder is never a mystery. */
function reportScriptFormats() {
  const byKind = new Map(state.scripts.map((s) => [s.kind, s]));
  const lines = [];

  for (const kind of ["popunder", "smartlink"]) {
    const entry = byKind.get(kind);
    if (!entry) {
      lines.push(
        `[ads] ${kind}: not enabled in the database, nothing loaded. ` +
          `Enable it in Admin > Ads.`
      );
      continue;
    }
    const len = typeof entry.code === "string" ? entry.code.trim().length : 0;
    if (!state.enabled) {
      lines.push(`[ads] ${kind}: saved (${len} chars) but the master switch is OFF.`);
    } else {
      lines.push(`[ads] ${kind}: active, loaded once for this page view (${len} chars).`);
    }
  }

  console.log(lines.join("\n"));
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
