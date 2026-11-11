/**
 * Everything that touches Everything directly (besides KV inside the backend):
 * auth, environment, profile pictures.
 */
const PIC_KEY = 'propertymgmt.profilePicture';

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

export function signOut() {
  try {
    everything.auth.signOut();
  } catch {}
}

export async function getUser() {
  return everything.auth.getUser();
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

export function clearProfilePicture() {
  try {
    localStorage.removeItem(PIC_KEY);
  } catch {}
}
