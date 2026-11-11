// The Everything SDK, loaded the first time the assistant needs it (the rest of the
// app works without Everything, offline included, so the page does not load it up front).

const SDK_URL = '/sdk/everything.js';

interface EverythingSDK {
  env?: string;
  auth?: { isSignedIn(): boolean; signIn(opts?: Record<string, unknown>): Promise<unknown> };
  ai?: { chat: (messages: unknown, opts?: Record<string, unknown>) => Promise<unknown> };
}

const sdk = () => (globalThis as unknown as { everything?: EverythingSDK }).everything ?? null;
let loading: Promise<EverythingSDK | null> | null = null;

/** The SDK, loading it once; null when it cannot be reached. */
export function loadEverything(timeoutMs = 15000): Promise<EverythingSDK | null> {
  if (sdk()) return Promise.resolve(sdk());
  if (loading) return loading;
  loading = new Promise<EverythingSDK | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const done = () => {
      clearTimeout(timer);
      resolve(sdk());
      if (!sdk()) loading = null;
    };
    const timer = setTimeout(done, timeoutMs);
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = done;
    s.onerror = () => {
      s.remove();
      done();
    };
    document.head.append(s);
  });
  return loading;
}

/** Inside the Everything desktop the session belongs to the desktop. */
export const inEverythingDesktop = () => sdk()?.env === 'app';

export function isSignedIn(): boolean {
  try {
    return inEverythingDesktop() || !!sdk()?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

/** Opens Everything's sign-in window (call from a click). Resolves whether the user is now signed in. */
export async function signIn(): Promise<boolean> {
  const p = sdk();
  if (!p?.auth) throw new Error('Everything is not available right now. Check your connection and try again.');
  try {
    await p.auth.signIn();
  } catch (e) {
    const code = (e as { error?: string })?.error;
    if (code === 'auth_window_closed') return false;
    if (code === 'popup_blocked') throw new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.');
    throw e;
  }
  return isSignedIn();
}
