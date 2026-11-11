// Thin helpers around the Everything SDK runtime. Everything is the only cloud/AI
// backend this app talks to.

export const hasEverything = typeof window !== 'undefined' && !!window.everything

/** True when running inside the Everything desktop shell (auth is implicit there). */
export function isEverythingApp() {
  return hasEverything && window.everything.env === 'app'
}

/** Whether an Everything user is currently authenticated. */
export function isSignedIn() {
  try {
    return hasEverything && window.everything.auth && window.everything.auth.isSignedIn()
  } catch (_e) {
    return false
  }
}

/** Reject if an Everything API call hangs, so the UI never gets stuck on a spinner. */
export function withTimeout(promise, ms = 15000, label = 'Everything request') {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// UI preferences are device-local (not cloud data), so they live in
// localStorage for instant, pre-auth access.
const PREFS_NS = 'contacts:'
export function getPref(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFS_NS + key)
    return v === null ? fallback : v
  } catch (_e) {
    return fallback
  }
}
export function setPref(key, value) {
  try {
    localStorage.setItem(PREFS_NS + key, value)
  } catch (_e) {
    /* storage may be unavailable (private mode) — preferences are best-effort */
  }
}
