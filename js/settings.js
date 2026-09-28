/* =============================================================================
 * TAPX - js/settings.js
 * -----------------------------------------------------------------------------
 * User preferences (sound / vibration), account details, logout, local reset.
 *
 * Preferences are mirrored in localStorage for instant UI feedback and stored
 * in the database (game_state) so they follow the account across devices.
 * Nothing here affects balances, which live only in PostgreSQL.
 * ========================================================================== */

import { CONFIG, pageUrl } from "./config.js";
import { savePreferences, saveProfileFields, signOut } from "./supabase.js";
import { isValidUsername, sanitiseUsername, readPref, writePref, clearPrefs } from "./security.js";
import {
  toast,
  setFeedbackHandler,
  audioEngine,
  vibrate as vibrateRaw,
  $,
  $$,
  on,
  emit,
  formatCoins
} from "./ui.js";

const state = {
  sound: readPref(CONFIG.storage.sound, true) !== false,
  vibration: readPref(CONFIG.storage.vibration, true) !== false,
  username: null,
  displayName: null
};

/* -----------------------------------------------------------------------------
 * Prefs
 * -------------------------------------------------------------------------- */

export function getPrefs() {
  return { sound: state.sound, vibration: state.vibration };
}

/** Apply preferences locally (no network). */
export function applyPrefs({ sound, vibration } = {}) {
  if (typeof sound === "boolean") {
    state.sound = sound;
    writePref(CONFIG.storage.sound, sound);
    audioEngine().setEnabled(sound);
  }
  if (typeof vibration === "boolean") {
    state.vibration = vibration;
    writePref(CONFIG.storage.vibration, vibration);
  }
}

/** Apply preferences and persist them to the account. */
export async function updatePrefs(patch) {
  applyPrefs(patch);
  try {
    await savePreferences({ sound_enabled: state.sound, vibration_enabled: state.vibration });
  } catch {
    // Preferences stay on this device if the sync fails - never block the UI.
    toast("Saved on this device only (could not reach the server).", "warn");
  }
}

export function getAccount() {
  return { username: state.username, displayName: state.displayName };
}

/** Store the account info returned by get_player_state(). */
export function setAccount(info) {
  state.username = info?.username ?? null;
  state.displayName = info?.display_name ?? null;
  if (state.username) writePref(CONFIG.storage.lastUsername, state.username);
}

/* -----------------------------------------------------------------------------
 * UI wiring
 * -------------------------------------------------------------------------- */

function syncToggles() {
  const soundInput = $("#pref-sound");
  const vibInput = $("#pref-vibration");
  if (soundInput) soundInput.checked = state.sound;
  if (vibInput) vibInput.checked = state.vibration;

  const soundRow = soundInput?.closest(".toggle-row");
  const vibRow = vibInput?.closest(".toggle-row");
  if (soundRow) soundRow.dataset.on = String(state.sound);
  if (vibRow) vibRow.dataset.on = String(state.vibration);
}

export function initSettings() {
  // Install the feedback handler used by ui.feedback().
  setFeedbackHandler({
    play: (kind) => audioEngine().play(kind),
    vibrate: (kind) => {
      if (!state.vibration) return;
      if (kind === "levelup") vibrateRaw([18, 40, 18]);
      else if (kind === "reward" || kind === "crit") vibrateRaw(24);
      else if (kind === "error") vibrateRaw([10, 60, 10]);
      else vibrateRaw(8);
    }
  });

  applyPrefs({});
  syncToggles();

  const soundInput = $("#pref-sound");
  soundInput?.addEventListener("change", (e) => {
    updatePrefs({ sound: e.target.checked });
    if (e.target.checked) audioEngine().play("tap");
  });

  const vibInput = $("#pref-vibration");
  vibInput?.addEventListener("change", (e) => {
    updatePrefs({ vibration: e.target.checked });
    if (e.target.checked) vibrateRaw(12);
  });

  // Account card
  const nameInput = $("#account-username");
  const displayInput = $("#account-display-name");
  nameInput?.addEventListener("change", async () => {
    const value = sanitiseUsername(nameInput.value);
    nameInput.value = value;
    if (!isValidUsername(value)) {
      toast("Username must be 3-24 characters: a-z, 0-9 or _.", "error");
      syncAccountForm();
      return;
    }
    await persistAccount({ username: value });
  });
  displayInput?.addEventListener("change", () => persistAccount({ display_name: displayInput.value.trim() }));

  $("#account-save")?.addEventListener("click", () =>
    persistAccount({
      username: sanitiseUsername(nameInput?.value ?? ""),
      display_name: displayInput?.value.trim() ?? ""
    })
  );

  // Logout
  $("#btn-logout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await signOut();
      toast("Signed out.", "success");
      window.setTimeout(() => window.location.replace(pageUrl("login.html")), 400);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  });

  // Admin shortcut
  $("#btn-admin")?.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.href = pageUrl("admin.html");
  });

  // Reset local preferences only
  $("#btn-reset-prefs")?.addEventListener("click", (e) => {
    e.preventDefault();
    clearPrefs();
    applyPrefs({ sound: true, vibration: true });
    syncToggles();
    toast("Local preferences reset. Your account data is untouched.", "success");
  });

  // Static links (keep them relative so any static host works)
  $$('a[data-config-link]').forEach((a) => {
    const key = a.dataset.configLink;
    const value = a.getAttribute("href") || "";
    if (key === "privacy" && value) a.setAttribute("href", pageUrl("privacy.html"));
    if (key === "terms" && value) a.setAttribute("href", pageUrl("terms.html"));
  });

  // Keep the settings sheet in sync when the game state reloads
  on("player:state", (e) => {
    const d = e.detail || {};
    if (typeof d.sound_enabled === "boolean" || typeof d.vibration_enabled === "boolean") {
      applyPrefs({ sound: d.sound_enabled ?? state.sound, vibration: d.vibration_enabled ?? state.vibration });
      syncToggles();
    }
    setAccount(d);
    syncAccountForm();
  });
}

function syncAccountForm() {
  const nameInput = $("#account-username");
  const displayInput = $("#account-display-name");
  const label = $("#account-username-label");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = state.username ?? "";
  if (displayInput && document.activeElement !== displayInput) displayInput.value = state.displayName ?? "";
  if (label) label.textContent = state.username ? `@${state.username}` : "@player";
}

async function persistAccount(patch) {
  const payload = {};
  if (patch.username !== undefined) payload.username = patch.username;
  if (patch.display_name !== undefined) {
    payload.display_name = patch.display_name.slice(0, 40) || payload.username || state.username;
  }
  if (!Object.keys(payload).length) return;

  try {
    await saveProfileFields(payload);
    setAccount({ ...state, ...payload });
    syncAccountForm();
    emit("account:update", payload);
    toast("Profile updated.", "success");
  } catch (err) {
    const msg = String(err.message || "");
    if (msg.includes("duplicate") || msg.includes("unique")) {
      toast("That username is already taken.", "error");
    } else {
      toast(msg || "Could not update your profile.", "error");
    }
    syncAccountForm();
  }
}

/** Update the small header chips (name + balance) after any balance change. */
export function renderHeader(stateData) {
  const nameEl = $("#header-user-name");
  if (nameEl && stateData?.username) nameEl.textContent = `@${stateData.username}`;
  const coinEl = $("#header-coins");
  if (coinEl && stateData) coinEl.textContent = formatCoins(stateData.coins);
}
