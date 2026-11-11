/**
 * Access to the Everything SDK (loaded from js.localhost:8443 by index.html, or the
 * offline stand-in in demo mode) and the signed-in user.
 */
export function sdk() {
  return typeof window !== 'undefined' ? window.everything : undefined;
}

export function everythingEnv() {
  return sdk()?.env || 'web';
}

/** Inside the Everything desktop the session belongs to Everything, so no sign out. */
export function canSignOut() {
  return everythingEnv() !== 'app';
}

export function isSignedIn() {
  try {
    return !!sdk()?.auth?.isSignedIn();
  } catch {
    return false;
  }
}

let userPromise = null;
export function currentUser({ refresh = false } = {}) {
  if (refresh) userPromise = null;
  userPromise ||= sdk().auth.getUser().then((u) => ({ uuid: String(u.uuid), username: String(u.username || ''), email: u.email || null }));
  userPromise.catch(() => { userPromise = null; });
  return userPromise;
}

export async function signIn() {
  await sdk().auth.signIn();
  userPromise = null;
  return currentUser();
}

export async function signOut() {
  try {
    await sdk().auth.signOut();
  } finally {
    userPromise = null;
  }
}

const pictureCache = new Map();
/** The user's profile picture as a data URL, or null. */
export function profilePicture(username) {
  const key = username || '';
  if (!pictureCache.has(key)) {
    const p = (async () => {
      try {
        const fn = sdk()?.auth?.getProfilePicture;
        if (typeof fn !== 'function') return null;
        const pic = username ? await fn.call(sdk().auth, username) : await fn.call(sdk().auth);
        return typeof pic === 'string' && pic.startsWith('data:image/') ? pic : null;
      } catch {
        return null;
      }
    })();
    pictureCache.set(key, p);
  }
  return pictureCache.get(key);
}
