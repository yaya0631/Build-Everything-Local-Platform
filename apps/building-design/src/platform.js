/**
 * Everything that touches Everything directly for identity: environment, sign-in
 * state, user and profile picture. The app works without signing in; cloud
 * files and settings sync need an account.
 */
const PIC_KEY = 'bd.profilePicture';

export function everythingAvailable() {
  return typeof globalThis.everything !== 'undefined';
}

let ready = null;

/**
 * Resolves true once the Everything SDK has loaded (it loads asynchronously so a
 * slow network never blocks drawing), or false if it fails to load.
 */
export function whenEverything(timeoutMs = 20000) {
  if (everythingAvailable()) return Promise.resolve(true);
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const script = document.getElementById('everything-sdk');
    const done = () => resolve(everythingAvailable());
    if (!script) return done();
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', done, { once: true });
    setTimeout(done, timeoutMs);
  });
  return ready;
}

export function everythingEnv() {
  try {
    return globalThis.everything?.env || 'web';
  } catch {
    return 'web';
  }
}

/** Inside the Everything desktop the user is always signed in and cannot sign out. */
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

/** Must be called from a user gesture (opens a popup). */
export async function signIn() {
  await everything.auth.signIn();
}

export function signOut() {
  try {
    everything.auth.signOut();
  } catch {
    /* ignore */
  }
}

export async function getUser() {
  try {
    return await everything.auth.getUser();
  } catch {
    return null;
  }
}

/** Profile picture as a data URL, cached per user so it shows instantly next time. */
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
      } catch {
        /* ignore quota */
      }
      return url;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearProfilePicture() {
  try {
    localStorage.removeItem(PIC_KEY);
  } catch {
    /* ignore */
  }
}

