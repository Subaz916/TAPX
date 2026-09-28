/* =============================================================================
 * TAPX - js/config.js
 * -----------------------------------------------------------------------------
 * SUPABASE SETUP
 *   1. Supabase Dashboard -> Project Settings -> API
 *   2. Copy "Project URL"          -> SUPABASE_URL
 *   3. Copy "anon public" key
 *      (or the new "publishable" key) -> SUPABASE_ANON_KEY
 *   4. Paste both below and save.
 *
 *   The anon / publishable key is designed for browser use and is safe to ship
 *   ONLY because every table in this project has Row Level Security enabled.
 *
 *   NEVER put the service_role key in this file (or anywhere in the frontend).
 *   NEVER put Adsterra private credentials here either.
 * ========================================================================== */

const SUPABASE_URL = "https://ptkkggyicusoikpkkiii.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a2tnZ3lpY3Vzb2lrcGtraWlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1OTE3NTksImV4cCI6MjEwNjE2Nzc1OX0.A48st7W6Q8T7LcCIBpwykx--9YCoXJoPP8GV93m5mvE";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

/* -----------------------------------------------------------------------------
 * Runtime configuration
 * -------------------------------------------------------------------------- */

export const CONFIG = Object.freeze({
  appName: "TAPX",

  /* Tap batching.
   * Taps are sent to the server in small batches instead of one request per
   * tap. This is a bandwidth optimisation only - every batch is still fully
   * re-validated and re-scored by the database. */
  tapBatchMs: 1200,
  maxBatchTaps: 250,

  /* Client-side sanity limits. These are UX guards, NOT security: the same
   * rules (and stricter ones) are enforced again in process_tap(). */
  minTapIntervalMs: 40,
  comboWindowMs: 900,
  maxCombo: 10000,

  /* Daily reward */
  dailyRewardIntervalMs: 24 * 60 * 60 * 1000,
  dailyRewardFallback: [100, 150, 250, 400, 600, 800, 1200],

  /* Supabase client library. Loaded from a CDN with automatic fallback.
   * Pin an exact version (e.g. @supabase/supabase-js@2.49.4) for production. */
  supabaseCdn: [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
    "https://esm.sh/@supabase/supabase-js@2",
    "https://unpkg.com/@supabase/supabase-js@2?module"
  ],

  /* Storage keys used for UI preferences only.
   * No balances, no sessions and no authoritative game state is ever stored
   * in localStorage. */
  storage: {
    sound: "tapx.sound",
    vibration: "tapx.vibration",
    lastUsername: "tapx.lastUsername",
    seenOnboarding: "tapx.onboarding"
  },

  /* Ad placements.
   *
   * `enabled` is a LOCAL KILL SWITCH only. Leave it true: it simply allows the
   * database to control ads. The real on/off switch is the "ads_enabled" app
   * setting, toggled from Admin > Ads, so you never have to edit this file to
   * start or stop advertising.
   *
   * Ads actually render only when ALL of these are true:
   *   CONFIG.ads.enabled (this file)        -> local switch allows it
   *   app setting "ads_enabled"             -> master switch in the database
   *   the placement row                     -> enabled in Admin > Ads
   *   the placement has an official snippet -> saved in Admin > Ads
   *
   * Set this to false only to hard-disable every ad, e.g. while debugging.
   */
  ads: {
    enabled: true,
    /* Minimum milliseconds between two app-side records for the same
     * placement. The ad network applies its own, much stricter, capping. */
    recordCooldownMs: 60000
  },

  /* Optional overrides. Leave null to use the defaults. */
  supportEmail: null,
  privacyUrl: "privacy.html",
  termsUrl: "terms.html"
});

/* -----------------------------------------------------------------------------
 * Small helpers used across modules
 * -------------------------------------------------------------------------- */

/** True when the app still has placeholder Supabase credentials. */
export function isSupabaseConfigured() {
  return (
    typeof SUPABASE_URL === "string" &&
    SUPABASE_URL.startsWith("http") &&
    SUPABASE_ANON_KEY.length > 20 &&
    !SUPABASE_URL.includes("YOUR_PROJECT_URL")
  );
}

/** Absolute redirect target, works identically on any static host. */
export function pageUrl(file) {
  const base = window.location.href.split("#")[0].split("?")[0];
  const dir = base.substring(0, base.lastIndexOf("/") + 1);
  return dir + file;
}
