/**
 * Talking to a collaboration worker, and deploying one. Adapted from the
 * Whiteboard app (src/whiteboard/src/collaboration/api.js).
 *
 * Every person who shares a space runs their own worker on their own Everything
 * account; the shared pages live there. People they invite call that worker
 * with a restricted credential (see auth.js).
 */
import { workerURL } from './protocol.js';
import { authorize, refuseCredential } from './auth.js';

const WORKER_KEY = 'wiki-collaboration-worker-v1';
const deploymentChecks = new WeakMap();

function checksFor(everything) {
  let entry = deploymentChecks.get(everything);
  if (!entry || entry.auth !== everything.authToken) {
    entry = { auth: everything.authToken, servers: new Map() };
    deploymentChecks.set(everything, entry);
  }
  return entry.servers;
}

export class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Keeps the owner's worker up to date with this build, once per session. */
export function refreshDeployment(everything, server) {
  server = workerURL(server);
  const checks = checksFor(everything);
  if (!checks.has(server)) {
    const pending = deploy(everything, () => {}, server);
    checks.set(server, pending);
    pending.catch(() => {
      if (checks.get(server) === pending) checks.delete(server);
    });
  }
  return checks.get(server);
}

export async function call(everything, server, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.op?.startsWith('asset') ? 120000 : 30000);
  try {
    server = workerURL(server);
    const bodyText = JSON.stringify(input);
    let headers = await authorize(everything, server, bodyText);
    const unreachable = () => new RequestError('Could not reach the shared space. Check your connection and try again.', 0);
    const send = async () => {
      try {
        controller.signal.throwIfAborted();
        return await everything.workers.exec(`${server}/api`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: bodyText,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        throw unreachable();
      }
    };
    let res = await send();
    // A credential that stopped working is replaced and the request sent once more.
    if (res.status === 401 && refuseCredential(everything, headers)) {
      headers = await authorize(everything, server, bodyText);
      res = await send();
    }
    const body = await res.json().catch(() => null);
    if (res.ok && !body) throw unreachable();
    if (!res.ok) throw new RequestError(body?.message || 'Could not synchronize this space.', res.status);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** The worker bundle served next to the app. */
async function bundle() {
  const url = new URL('worker/wiki-worker.js', document.baseURI);
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error('The collaboration server bundle could not load.');
  const source = await response.text();
  const build = /wiki-worker build=([a-f0-9]+)/.exec(source)?.[1];
  const builtAt = Number(/ at=(\d+)/.exec(source.slice(0, 150))?.[1]) || 0;
  if (!build) throw new Error('Invalid collaboration server bundle.');
  return { source, build, builtAt };
}

/**
 * Deploys this account's worker, or updates it to this build. A link alone
 * never causes a deployment: only a worker this account created and
 * recorded in its own private KV is ever updated.
 */
export async function deploy(everything, progress = () => {}, expectedServer) {
  const account = everything.authToken;
  const checkAccount = () => {
    if (everything.authToken !== account) throw new Error('Your Everything account changed. Reopen the shared space.');
  };
  let config = await everything.kv.get(WORKER_KEY);
  checkAccount();
  if (expectedServer && (!config || workerURL(config.server) !== expectedServer)) return null;
  progress('Preparing sharing...');
  const { source, build, builtAt } = await bundle();
  checkAccount();
  if (!config) {
    const name = `wiki-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const file = await everything.fs.write('wiki/wiki-worker.js', source, { overwrite: true, dedupeName: false, createMissingParents: true });
    checkAccount();
    const deployed = await everything.workers.create(name, file.path);
    checkAccount();
    config = { name, server: workerURL(deployed.url || `http://${name}.localhost:8443`), path: file.path, build, builtAt };
    await everything.kv.set(WORKER_KEY, config);
  } else if (config.build !== build && !(config.builtAt > builtAt)) {
    await everything.fs.write(config.path, source, { overwrite: true, dedupeName: false });
    checkAccount();
    config.build = build;
    config.builtAt = builtAt;
    await everything.kv.set(WORKER_KEY, config);
  }
  checkAccount();
  progress('Starting the sharing server...');
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await everything.workers.exec(`${workerURL(config.server)}/health`, { headers: { 'x-everything-no-auth': '1' }, redirect: 'error' });
      if (res.ok && (await res.json()).build === config.build) {
        checkAccount();
        checksFor(everything).set(config.server, Promise.resolve(config.server));
        return config.server;
      }
    } catch {
      /* the deployment may still be starting */
    }
    checkAccount();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The sharing server is still starting. Try again shortly.');
}

/** This account's own worker address, if it has one. */
export async function ownServer(everything) {
  const config = await everything.kv.get(WORKER_KEY);
  return config?.server ? workerURL(config.server) : null;
}
