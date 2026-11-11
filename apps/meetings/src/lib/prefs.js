import { hasEverything } from './env.js';

/**
 * User preferences.
 *
 * localStorage is the fast, synchronous source of truth for boot;
 * everything.kv (per-user, per-app) syncs preferences across devices for
 * signed-in users. Both writes are best-effort.
 */

const LOCAL_PREFIX = 'pm.';
const KV_PREFIX = 'meet:pref:';

// 'background' syncs the chosen effect ({type, blur|id}); the custom
// image itself ('bgImage') stays local-only — data URLs are too big for kv.
export const PREF_KEYS = Object.freeze(['name', 'theme', 'micId', 'camId', 'speakerId', 'joinMuted', 'joinCamOff', 'background', 'noiseSuppression']);

export function getLocalPref(key) {
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Whether this device has an entry for `key` at all.
 *
 * Deliberately not `getLocalPref(key) !== undefined`: a value this module
 * cannot parse is still a choice the user made here, and the cloud pull
 * must not mistake it for an empty slot and overwrite it.
 */
export function hasLocalPref(key) {
  try {
    return localStorage.getItem(LOCAL_PREFIX + key) !== null;
  } catch {
    return false; // storage unavailable (private mode)
  }
}

export function setLocalPref(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(LOCAL_PREFIX + key);
    else localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) */
  }
}

/** Persist a preference locally and (best-effort) to everything.kv. */
export function setPref(key, value) {
  setLocalPref(key, value);
  if (!hasEverything()) return;
  try {
    if (!window.everything.auth?.isSignedIn?.()) return;
    const kv = window.everything.kv;
    if (value === undefined || value === null) kv.del(KV_PREFIX + key).catch(() => {});
    else kv.set(KV_PREFIX + key, JSON.stringify(value)).catch(() => {});
  } catch {
    /* not signed in / kv unavailable */
  }
}

export function getPref(key, fallback = undefined) {
  const v = getLocalPref(key);
  return v === undefined ? fallback : v;
}

/** @type {Promise<void>|null} the one in-flight (or finished) cloud pull */
let cloudPull = null;

/**
 * Pull cloud preferences into localStorage (call once after sign-in).
 * Cloud values win only for keys that are unset locally.
 */
export function syncPrefsFromCloud() {
  return (cloudPull ??= pullCloudPrefs());
}

/**
 * Resolves once the cloud pull has settled (immediately when none was
 * started). Views that prefill from a preference await this, or a device
 * that has nothing stored locally would render before its remembered
 * values arrive.
 */
export function prefsReady() {
  return cloudPull ?? Promise.resolve();
}

async function pullCloudPrefs() {
  if (!hasEverything()) return;
  try {
    // Only touch kv when already signed in — a kv call for a signed-out
    // user makes the Everything SDK pop its consent/auth dialog unprompted.
    if (!window.everything.auth?.isSignedIn?.()) return;
    const kv = window.everything.kv;
    await Promise.all(
      PREF_KEYS.map(async (key) => {
        if (hasLocalPref(key)) return;
        const raw = await kv.get(KV_PREFIX + key);
        if (raw === null || raw === undefined) return;
        try {
          setLocalPref(key, JSON.parse(raw));
        } catch {
          /* corrupt entry; ignore */
        }
      })
    );
  } catch {
    /* offline or not signed in */
  }
}

/**
 * Special-case theme: it is read before everything.js settles, by the boot
 * script in index.html. That script strips quotes before comparing, so the
 * value is stored in the same JSON form as every other preference — one
 * key, one format. Writing a second, bare copy only ever clobbered the
 * first, leaving behind a value getLocalPref() could not read.
 */
export function setThemePref(theme) {
  setPref('theme', theme);
}

/** Accepts the bare string older builds stored, as well as the JSON form. */
export function getThemePref() {
  try {
    const raw = localStorage.getItem('pm.theme');
    if (raw === 'light' || raw === 'dark') return raw;
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return undefined;
}
