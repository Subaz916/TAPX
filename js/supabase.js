/* =============================================================================
 * TAPX - js/supabase.js
 * -----------------------------------------------------------------------------
 * Single place where the Supabase client is created and where every RPC call
 * lives. Nothing else in the app talks to the database directly.
 * ========================================================================== */

import { SUPABASE_URL, SUPABASE_ANON_KEY, CONFIG, isSupabaseConfigured } from "./config.js";

let client = null;
let initPromise = null;

/** Lazily load the Supabase client library (CDN with fallbacks). */
async function loadLibrary() {
  const failures = [];
  for (const url of CONFIG.supabaseCdn) {
    try {
      return await import(/* @vite-ignore */ url);
    } catch (err) {
      failures.push(`${url} (${err && err.message ? err.message : "failed"})`);
    }
  }
  throw new Error(
    "Could not load the Supabase client library. Check your internet connection. " +
      "Tried: " + failures.join(", ")
  );
}

/**
 * Create (once) and return the shared Supabase client.
 * @returns {Promise<object>} supabase-js client
 */
export function initSupabase() {
  if (client) return Promise.resolve(client);
  if (initPromise) return initPromise;

  if (!isSupabaseConfigured()) {
    return Promise.reject(
      new Error(
        "Supabase is not configured. Open js/config.js and set SUPABASE_URL and SUPABASE_ANON_KEY."
      )
    );
  }

  initPromise = loadLibrary()
    .then(({ createClient }) => {
      client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce"
        },
        global: {
          headers: { "x-application-name": CONFIG.appName }
        },
        db: { schema: "public" }
      });
      return client;
    })
    .catch((err) => {
      initPromise = null;
      throw err;
    });

  return initPromise;
}

/** Synchronous accessor. Throws if the app has not initialised yet. */
export function supabase() {
  if (!client) throw new Error("Supabase client accessed before initSupabase() resolved.");
  return client;
}

export function isReady() {
  return client !== null;
}

/* -----------------------------------------------------------------------------
 * Errors
 * -------------------------------------------------------------------------- */

/** Normalise anything thrown by supabase-js into a plain Error. */
export function toError(err) {
  if (!err) return new Error("Unknown error");
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  return new Error(err.message || "Unexpected error");
}

/**
 * Turn a Postgres error into a friendly, user-facing message.
 * Codes are stable; messages come from the functions in supabase/schema.sql.
 */
export function friendlyError(err) {
  const e = toError(err);
  const msg = e.message || "";
  const detail = e.details || "";

  if (msg.includes("Not authenticated")) {
    return "Your session expired. Please sign in again.";
  }
  if (msg.includes("Admin privileges required")) {
    return "Administrator access is required for that action.";
  }
  if (msg.includes("Not enough coins")) {
    return "Not enough coins for that upgrade yet.";
  }
  if (msg.includes("already at max level")) {
    return "That upgrade is already at maximum level.";
  }
  if (msg.includes("Requirement not met")) {
    return "Keep tapping - you have not reached that milestone yet.";
  }
  if (msg.includes("already claimed")) {
    return "You already claimed that reward.";
  }
  if (msg.includes("Daily reward already claimed")) {
    return "Your daily reward is not ready yet. Come back later.";
  }
  if (msg.includes("Protected column")) {
    return "That change is not allowed.";
  }
  if (msg.includes("JWT") || msg.includes("token") || msg.includes("session")) {
    return "Your session is no longer valid. Please sign in again.";
  }
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return "No internet connection. Your progress could not be saved.";
  }
  if (msg.toLowerCase().includes("timeout")) {
    return "The server took too long to answer. Please try again.";
  }
  if (detail) return msg;
  return msg || "Something went wrong. Please try again.";
}

/** True when the error means "you are offline". */
export function isNetworkError(err) {
  const e = toError(err);
  return (
    !navigator.onLine ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(e.message)
  );
}

/* -----------------------------------------------------------------------------
 * Auth helpers
 * -------------------------------------------------------------------------- */

/** @returns {Promise<object|null>} current session, or null when signed out. */
export async function getSession() {
  const sb = await initSupabase();
  const { data, error } = await sb.auth.getSession();
  if (error) throw toError(error);
  return data?.session ?? null;
}

/** @returns {Promise<object|null>} current user, or null. */
export async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Resolve the current user or redirect to the login page.
 * @param {string} [redirectTo] page to return to after signing in
 */
export async function requireUser(redirectTo) {
  const user = await getUser();
  if (!user) {
    const target = redirectTo || window.location.pathname.split("/").pop() || "index.html";
    window.location.replace(`login.html?next=${encodeURIComponent(target)}`);
    return null;
  }
  return user;
}

/** Subscribe to auth state changes. Returns an unsubscribe function. */
export async function onAuthStateChange(handler) {
  const sb = await initSupabase();
  const { data } = sb.auth.onAuthStateChange((event, session) => {
    try {
      handler(event, session);
    } catch (err) {
      console.error("auth handler failed", err);
    }
  });
  return () => data.subscription.unsubscribe();
}

export async function signOut() {
  const sb = await initSupabase();
  const { error } = await sb.auth.signOut();
  if (error) throw toError(error);
}

/* -----------------------------------------------------------------------------
 * RPC wrapper
 * -------------------------------------------------------------------------- */

/**
 * Call a Postgres function and return its JSON result.
 * Throws a normalised Error on failure.
 * @param {string} fn   function name
 * @param {object} args named arguments
 */
export async function rpc(fn, args = {}) {
  const sb = await initSupabase();
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw toError(error);
  return data;
}

/** Read a single row set. */
export async function select(table, query) {
  const sb = await initSupabase();
  const { data, error } = await sb.from(table).select(query).maybeSingle();
  if (error) throw toError(error);
  return data ?? null;
}

/** Update the current user's game preferences (sound / vibration). */
export async function savePreferences({ sound_enabled, vibration_enabled }) {
  const sb = await initSupabase();
  const { error } = await sb
    .from("game_state")
    .update({ sound_enabled, vibration_enabled })
    .eq("user_id", (await getUser())?.id ?? "");
  if (error) throw toError(error);
}

/** Update the current user's cosmetic profile fields. */
export async function saveProfileFields({ username, display_name }) {
  const sb = await initSupabase();
  const { error } = await sb
    .from("profiles")
    .update({ username, display_name })
    .eq("id", (await getUser())?.id ?? "");
  if (error) throw toError(error);
}
