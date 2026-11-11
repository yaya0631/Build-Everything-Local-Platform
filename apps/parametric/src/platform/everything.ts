// Every Everything SDK call goes through this module so the app works the same
// with or without Everything (signed out, offline, or in tests).

export interface EverythingFSItem {
  id?: string;
  uid?: string;
  name: string;
  path: string;
  is_dir?: boolean;
  isDir?: boolean;
  size?: number | null;
  modified?: number;
  read?: () => Promise<Blob>;
}

export interface EverythingSDK {
  env?: string;
  appID?: string;
  auth: {
    isSignedIn(): boolean;
    signIn(opts?: Record<string, unknown>): Promise<unknown>;
    signOut(): Promise<void> | void;
    getUser(): Promise<{ username: string; uuid: string }>;
    getProfilePicture?(): Promise<string | null>;
  };
  fs: {
    write(path: string, data: Blob | string, opts?: Record<string, unknown>): Promise<EverythingFSItem>;
    read(path: string): Promise<Blob>;
    readdir(path: string, opts?: Record<string, unknown>): Promise<EverythingFSItem[]>;
    delete(path: string, opts?: Record<string, unknown>): Promise<void>;
    rename(path: string, name: string): Promise<EverythingFSItem>;
    stat(path: string): Promise<EverythingFSItem>;
    mkdir(path: string, opts?: Record<string, unknown>): Promise<EverythingFSItem>;
  };
  kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<boolean>;
    del(key: string): Promise<boolean>;
  };
  ui?: {
    showOpenFilePicker?(opts?: Record<string, unknown>): Promise<EverythingFSItem | EverythingFSItem[]> & { undefinedOnCancel?: Promise<EverythingFSItem | EverythingFSItem[] | undefined> };
    showSaveFilePicker?(data?: Blob | string, name?: string): Promise<EverythingFSItem> & { undefinedOnCancel?: Promise<EverythingFSItem | undefined> };
    onLaunchedWithItems?(fn: (items: EverythingFSItem[]) => void): void;
    wasLaunchedWithItems?(): boolean;
    setWindowTitle?(title: string): void;
    onWindowClose?(fn: () => void): void;
  };
}

declare global {
  interface Window {
    everything?: EverythingSDK;
  }
}

let sdk: EverythingSDK | null = null;

/** Waits briefly for the SDK script (loaded with defer) and returns it or null. */
export async function loadEverything(timeoutMs = 5000): Promise<EverythingSDK | null> {
  if (sdk) return sdk;
  const start = Date.now();
  while (typeof window !== 'undefined' && !window.everything && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 40));
  }
  sdk = typeof window !== 'undefined' && window.everything ? window.everything : null;
  return sdk;
}

export const everything = () => sdk;
export function setEverythingForTests(p: EverythingSDK | null) {
  sdk = p;
}

/** 'app' inside the Everything desktop, 'web' on a normal website, 'none' without the SDK. */
export function env(): string {
  return sdk?.env || 'none';
}

/** Inside the Everything desktop the session belongs to the desktop: no sign-out. */
export const canSignOut = () => env() !== 'app' && isSignedIn();

export function isSignedIn(): boolean {
  try {
    return !!sdk?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

/** Cloud storage is usable without triggering a sign-in prompt. */
export const cloudAvailable = () => !!sdk?.fs && (env() === 'app' || isSignedIn());

let pictureCache: { value: string | null; at: number } | null = null;

export async function getUser(): Promise<{ username: string } | null> {
  if (!sdk || !cloudAvailable()) return null;
  try {
    return await sdk.auth.getUser();
  } catch {
    return null;
  }
}

/** Profile picture as a data URL, or null. Cached briefly in memory only. */
export async function getProfilePicture(): Promise<string | null> {
  if (!sdk?.auth?.getProfilePicture || !cloudAvailable()) return null;
  if (pictureCache && Date.now() - pictureCache.at < (pictureCache.value ? 300_000 : 60_000)) return pictureCache.value;
  let value: string | null = null;
  try {
    const pic = await sdk.auth.getProfilePicture();
    value = typeof pic === 'string' && pic.startsWith('data:image/') && pic.length < 2_000_000 ? pic : null;
  } catch {
    value = null;
  }
  pictureCache = { value, at: Date.now() };
  return value;
}

export async function signIn(): Promise<boolean> {
  if (!sdk) throw new Error('Everything is not available right now. Check your connection and try again.');
  pictureCache = null;
  try {
    await sdk.auth.signIn();
  } catch (e) {
    const code = (e as { error?: string })?.error;
    if (code === 'auth_window_closed') return false;
    if (code === 'popup_blocked') throw new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.');
    throw e;
  }
  return isSignedIn();
}

export async function signOut(): Promise<void> {
  if (!sdk) return;
  pictureCache = null;
  await sdk.auth.signOut();
}

/** True when an error from everything.fs means the path does not exist. */
export function isMissing(err: unknown): boolean {
  const e = err as { code?: string; error?: { code?: string }; message?: string; status?: number };
  const code = e?.code || e?.error?.code || e?.message || '';
  return /subject_does_not_exist|not_found|does not exist|404/i.test(String(code)) || e?.status === 404;
}

/** Human readable error text for storage failures. */
export function storageError(err: unknown): string {
  const e = err as { code?: string; message?: string; status?: number };
  if (e?.code === 'storage_limit_reached' || e?.status === 413) return 'Your Everything storage is full. Free up space or upgrade your plan, then save again.';
  if (e?.status === 429 || e?.code === 'too_many_requests') return 'Too many requests right now. Wait a moment and try again.';
  return e?.message || 'Something went wrong while talking to Everything.';
}

/** Everything timestamps are Unix seconds; normalise to milliseconds. */
export const toMs = (t?: number) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

// Settings live in one small KV entry read on load and written on change:
// never one key per setting, to keep reads and writes minimal.
export const KV_SETTINGS_KEY = 'parametric:settings:v1';

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (!sdk?.kv || !cloudAvailable()) return undefined;
  try {
    const v = await sdk.kv.get(key);
    return (v ?? undefined) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<boolean> {
  if (!sdk?.kv || !cloudAvailable()) return false;
  try {
    await sdk.kv.set(key, value);
    return true;
  } catch {
    return false;
  }
}
