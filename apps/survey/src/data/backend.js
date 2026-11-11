/**
 * The platform the app runs on: Everything (the real thing), or local demo mode,
 * which keeps everything in this browser and runs the collector worker
 * in-page. Local mode starts with ?local in the URL and exists for trying the
 * app without an account, for development, and for tests. Everything above
 * this file sees the same small interface either way.
 */
import { createLocalKv } from './local-kv.js';
import { LOCAL_WORKER_URL, LOCAL_WORKER_FILE_KEY, localWorkerFetch, localWorkerFile } from './local-worker.js';

function everythingBackend(everything) {
  return {
    mode: 'everything',
    env: everything.env,
    kv: everything.kv,
    fs: {
      write: (path, data, opts) => everything.fs.write(path, data, opts),
      async readText(path) {
        const blob = await everything.fs.read(path);
        return blob.text();
      },
      delete: (path) => everything.fs.delete(path),
    },
    workers: everything.workers,
    auth: {
      isSignedIn: async () => !!(await everything.auth.isSignedIn()),
      signIn: () => everything.auth.signIn(),
      signOut: () => everything.auth.signOut(),
      getUser: () => everything.auth.getUser(),
      getProfilePicture: () =>
        typeof everything.auth.getProfilePicture === 'function' ? everything.auth.getProfilePicture() : Promise.resolve(null),
    },
    fetchWorker: (url, init) => fetch(url, init),
    ai: everything.ai,
  };
}

function localBackend(storage = globalThis.localStorage) {
  const kv = createLocalKv({ storage, namespace: 'sv-local-kv:' });
  const fsKey = (path) => `sv-local-fs:${String(path).replace(/^\/+/, '')}`;
  const fs = {
    async write(path, data) {
      const text = typeof data === 'string' ? data : await new Response(data).text();
      storage.setItem(fsKey(path), JSON.stringify(text));
      return { path };
    },
    async readText(path) {
      const raw = storage.getItem(fsKey(path));
      if (raw == null) {
        const err = new Error('File not found');
        err.code = 'subject_does_not_exist';
        throw err;
      }
      return JSON.parse(raw);
    },
    async delete(path) {
      storage.removeItem(fsKey(path));
    },
  };
  const workers = {
    async create(name, filePath) {
      storage.setItem(LOCAL_WORKER_FILE_KEY, filePath);
      return { name, url: LOCAL_WORKER_URL, file_path: filePath };
    },
    async get(name) {
      return { name, url: LOCAL_WORKER_URL, file_path: localWorkerFile(storage) };
    },
    async delete() {
      return true;
    },
  };
  const user = { username: 'local', uuid: 'local' };
  return {
    mode: 'local',
    env: 'web',
    kv,
    fs,
    workers,
    auth: {
      isSignedIn: async () => true,
      signIn: async () => user,
      signOut: async () => {},
      getUser: async () => user,
      getProfilePicture: async () => null,
    },
    fetchWorker: localWorkerFetch(storage),
    ai: null,
  };
}

export function isLocalMode(loc = globalThis.location) {
  try {
    return new URLSearchParams(loc.search).has('local');
  } catch {
    return false;
  }
}

/** Wait for the Everything SDK (loaded with `defer`) for up to `ms`. */
export function waitForEverything(ms = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (globalThis.everything && globalThis.everything.kv) return resolve(globalThis.everything);
      if (Date.now() - start > ms) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function createBackend({ local = isLocalMode() } = {}) {
  if (local) return localBackend();
  const everything = await waitForEverything();
  if (!everything) return null;
  return everythingBackend(everything);
}

export { localBackend as createLocalBackend };
