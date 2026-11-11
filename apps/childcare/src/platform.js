/**
 * Everything that touches Everything directly (besides KV inside the backend):
 * auth, environment, profile pictures.
 */
import { clearSnapshots } from './core/cache.js';
import { app } from './app.js';

const PIC_KEY = 'childcare.profilePicture';

export function everythingAvailable() {
  return typeof globalThis.everything !== 'undefined';
}

export function everythingEnv() {
  try {
    return globalThis.everything?.env || 'web';
  } catch {
    return 'web';
  }
}

/** Inside the Everything desktop the user is always signed in and can't sign out. */
export function canSignOut() {
  return everythingEnv() !== 'app';
}

export async function isSignedIn() {
  if (!everythingAvailable()) return false;
  try {
    return (await Promise.resolve(everything.auth.isSignedIn())) === true;
  } catch {
    return false;
  }
}

export async function signIn() {
  await everything.auth.signIn();
}

/**
 * Sign out and forget what this device kept for the person (`uuid`): cached
 * records and unsent changes for every school, files, and their picture, so
 * nothing about the children stays on a shared device.
 */
export async function signOut(uuid) {
  clearProfilePicture();
  try {
    localStorage.removeItem(USER_KEY);
  } catch {}
  if (uuid) {
    // Nothing may write the offline copy back before the page reloads.
    app.store?.close();
    try {
      localStorage.removeItem(wsKey(uuid));
    } catch {}
    // Settled, not all: a failure in one must not cut the wait for the other.
    const forget = Promise.allSettled([clearSnapshots(`user:${uuid}`), import('./files.js').then((m) => m.clearFileCache(uuid))]).then((results) => {
      for (const r of results) if (r.status === 'rejected') console.warn('[childcare] could not clear this device', r.reason);
    });
    await Promise.race([forget, new Promise((r) => setTimeout(r, 3000))]);
  }
  try {
    everything.auth.signOut();
  } catch {}
}

export async function getUser() {
  return everything.auth.getUser();
}

const USER_KEY = 'childcare.lastUser';

/** A hash of the current Everything session token, or null if it is not known. */
async function sessionHash() {
  const token = globalThis.everything?.authToken;
  if (typeof token !== 'string' || !token || !globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Remember who is signed in, tied to this session, for starts when Everything cannot be reached. */
export async function rememberUser(user) {
  try {
    const session = await sessionHash();
    if (session) localStorage.setItem(USER_KEY, JSON.stringify({ username: user.username, uuid: user.uuid, session }));
  } catch {}
}

/** The person last seen in this same session (never someone signed in before it), or null. */
export async function lastUser() {
  try {
    const session = await sessionHash();
    const raw = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return session && raw?.session === session && typeof raw.uuid === 'string' && raw.uuid ? { username: String(raw.username || ''), uuid: raw.uuid } : null;
  } catch {
    return null;
  }
}

/**
 * Profile picture as a data URL, cached per user so the avatar appears
 * instantly on the next visit. Only data: images are accepted.
 */
export function cachedProfilePicture(username) {
  try {
    const raw = JSON.parse(localStorage.getItem(PIC_KEY) || 'null');
    return raw && raw.user === username ? raw.url : null;
  } catch {
    return null;
  }
}

export async function fetchProfilePicture(username) {
  try {
    const url = await everything.auth.getProfilePicture?.();
    if (typeof url === 'string' && url.startsWith('data:image/') && url.length < 2_000_000) {
      try {
        localStorage.setItem(PIC_KEY, JSON.stringify({ user: username, url }));
      } catch {}
      return url;
    }
  } catch {}
  return null;
}

const wsKey = (uuid) => `childcare.workspaces:${uuid}`;

/**
 * The person's last known school list (worker URLs, roles, school names, no
 * children's data), so a failed read does not open their own empty school.
 */
export function rememberWorkspaces(uuid, ws) {
  try {
    localStorage.setItem(wsKey(uuid), JSON.stringify(ws));
  } catch {}
}

export function cachedWorkspaces(uuid) {
  try {
    return JSON.parse(localStorage.getItem(wsKey(uuid)) || 'null');
  } catch {
    return null;
  }
}

export function clearProfilePicture() {
  try {
    localStorage.removeItem(PIC_KEY);
  } catch {}
}
