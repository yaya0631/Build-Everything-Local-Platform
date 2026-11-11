/** Thin access to the Everything SDK, which index.html loads from js.localhost:8443. */

export function sdk() {
  return typeof window !== 'undefined' ? window.everything : undefined;
}

/** Wait for the deferred SDK script (it runs before modules, but be safe). */
export async function whenReady(timeout = 15000) {
  const start = Date.now();
  while (!sdk()) {
    if (window.__everythingFailed || Date.now() - start > timeout) throw new Error('Could not load Everything. Check your connection and try again.');
    await new Promise((r) => setTimeout(r, 50));
  }
  return sdk();
}

/** Inside the Everything desktop the app is always signed in and must not offer sign-out. */
export function isEverythingApp() {
  return sdk()?.env === 'app';
}

export async function currentUser() {
  const p = sdk();
  if (!p.auth.isSignedIn()) return null;
  try {
    return await p.auth.getUser();
  } catch {
    return null;
  }
}

export async function profilePicture() {
  try {
    return (await sdk()?.auth?.getProfilePicture?.()) || null;
  } catch {
    return null;
  }
}
