/**
 * Thin wrapper over `everything.auth`. All calls are defensive so a missing or
 * partially-loaded Everything SDK degrades gracefully instead of throwing.
 */
function api() {
  return typeof everything !== 'undefined' && everything.auth ? everything.auth : null;
}

export function isSignedIn() {
  try {
    return Boolean(api() && api().isSignedIn());
  } catch {
    return false;
  }
}

export async function signIn() {
  const a = api();
  if (!a) throw new Error('Everything SDK is not available.');
  return a.signIn();
}

export async function signOut() {
  const a = api();
  if (a) await a.signOut();
}

export async function getUser() {
  try {
    return await api().getUser();
  } catch {
    return null;
  }
}

/**
 * The signed-in user's email address, or null when unavailable or denied.
 *
 * Ask for the email resource so Everything handles the permission prompt and
 * returns the address on approval. Already-granted access needs no prompt.
 * Do not gate this on getUser(): the SDK resolves the account itself, and
 * the permission result is the address, not a boolean to re-fetch after.
 */
export async function requestUserEmail() {
  try {
    const perms = typeof everything !== 'undefined' ? everything.perms : null;
    if (!perms || typeof perms.request !== 'function') return null;
    const email = await perms.request('email');
    return typeof email === 'string' && email.trim() ? email : null;
  } catch {
    return null;
  }
}

/** Best-effort display initial for the avatar. */
export function userInitial(user) {
  const name = (user && (user.username || user.email)) || '?';
  return name.trim().charAt(0).toUpperCase() || '?';
}
