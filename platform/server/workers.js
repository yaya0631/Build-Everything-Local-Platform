/**
 * Local serverless worker runtime (`everything.workers`).
 *
 * Uses `node:worker_threads` with one pooled Worker thread per worker name.
 * Note: `worker_threads` provides resource isolation (separate V8 isolate,
 * memory cap, and preemptive `worker.terminate()` on timeout), not an OS
 * security sandbox — appropriate for running the local user's own app workers.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolveUser, ensureUser } from './auth.js';

export function initWorkers(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      name TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, app_name TEXT NOT NULL,
      file_path TEXT NOT NULL, script_source TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

const THREAD_BOOTSTRAP = `
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

delete globalThis.fetch;
delete globalThis.WebSocket;

const pendingRpc = new Map();
let rpcSeq = 0;
const callHost = (actor, area, op, args) => new Promise((resolve, reject) => {
  const id = ++rpcSeq;
  pendingRpc.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'rpc', id, actor, area, op, args });
});

function makeEverything(actor, info) {
  const who = { uuid: info?.uuid || '', uid: info?.uuid || '', username: info?.username || '', email: info?.email || '' };
  return {
    username: who.username, uuid: who.uuid, uid: who.uid, email: who.email, authToken: info?.token || who.uuid,
    getUser: async () => ({ ...who }),
    auth: { getUser: async () => ({ ...who }), whoami: async () => ({ ...who }) },
    kv: {
      get: (k) => callHost(actor, 'kv', 'get', [k]),
      set: (k, v, exp) => callHost(actor, 'kv', 'set', [k, v, exp]),
      del: (k) => callHost(actor, 'kv', 'del', [k]),
      remove: (k, ...paths) => callHost(actor, 'kv', 'remove', [k, ...paths]),
      list: (pat, ret) => callHost(actor, 'kv', 'list', [pat, ret]),
      incr: (k, amt) => callHost(actor, 'kv', 'incr', [k, amt]),
      add: (k, val) => callHost(actor, 'kv', 'add', [k, val]),
      update: (k, map) => callHost(actor, 'kv', 'update', [k, map]),
      expire: (k, ttl) => callHost(actor, 'kv', 'expire', [k, ttl]),
    },
    fs: {
      read: async (p, opts) => new Blob([Buffer.from(await callHost(actor, 'fs', 'read', [p, opts]), 'base64')]),
      write: (p, data, opts) => callHost(actor, 'fs', 'write', [p, typeof data === 'string' ? data : String(data ?? ''), opts]),
      mkdir: (p, opts) => callHost(actor, 'fs', 'mkdir', [p, opts]),
      delete: (p, opts) => callHost(actor, 'fs', 'delete', [p, opts]),
      stat: (p) => callHost(actor, 'fs', 'stat', [p]),
      readdir: (p, opts) => callHost(actor, 'fs', 'readdir', [p, opts]),
    },
    email: {
      send: (msg) => callHost(actor, 'mail', 'send', [msg, false]),
      sendTransactional: (msg) => callHost(actor, 'mail', 'send', [msg, true]),
    },
  };
}

const routes = [];
const router = {
  add(method, pattern, handler) { routes.push({ method: method.toUpperCase(), pattern: String(pattern), handler }); },
  get(p, h) { this.add('GET', p, h); },
  post(p, h) { this.add('POST', p, h); },
  put(p, h) { this.add('PUT', p, h); },
  patch(p, h) { this.add('PATCH', p, h); },
  delete(p, h) { this.add('DELETE', p, h); },
  options(p, h) { this.add('OPTIONS', p, h); },
  all(p, h) { this.add('ALL', p, h); },
};

function matchRoute(method, pathname) {
  const cleanPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  for (const r of routes) {
    if (r.method !== 'ALL' && r.method !== method) continue;
    const pat = r.pattern.length > 1 && r.pattern.endsWith('/') ? r.pattern.slice(0, -1) : r.pattern;
    if (pat === '*' || pat === '/*') return { handler: r.handler, params: {} };
    const segP = pat.split('/');
    const segA = cleanPath.split('/');
    if (segP.length !== segA.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segP.length; i++) {
      if (segP[i].startsWith(':')) params[segP[i].slice(1)] = decodeURIComponent(segA[i]);
      else if (segP[i] !== segA[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

const ownerMe = { everything: makeEverything('owner', workerData.owner) };
const sandbox = {
  router, me: ownerMe, Request, Response, Headers, URL, URLSearchParams,
  TextEncoder, TextDecoder, crypto: globalThis.crypto, console, setTimeout,
  clearTimeout, atob, btoa, structuredClone, Uint8Array, ArrayBuffer, Blob, Buffer,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const cleanedCode = String(workerData.source || '')
  .replace(/\\r\\n/g, '\\n')
  .replace(/^\\s*export\\s+default\\s+/gm, '')
  .replace(/^\\s*export\\s+\\{[^}]*\\};?\\s*$/gm, '')
  .replace(/^\\s*export\\s+(const|let|var|function|async\\s+function|class)\\s+/gm, '$1 ');

vm.createContext(sandbox);
vm.runInContext(cleanedCode, sandbox, { filename: workerData.name + '.js' });

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'rpc-reply') {
    const waiter = pendingRpc.get(msg.id);
    if (!waiter) return;
    pendingRpc.delete(msg.id);
    if (msg.error) waiter.reject(Object.assign(new Error(msg.error), { code: msg.code }));
    else waiter.resolve(msg.result);
    return;
  }
  if (msg.type === 'req') {
    try {
      const method = String(msg.method || 'GET').toUpperCase();
      const urlObj = new URL(msg.url || 'http://localhost/');
      const hit = matchRoute(method, urlObj.pathname);
      if (!hit) {
        parentPort.postMessage({ type: 'res', reqId: msg.reqId, status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not_found', path: urlObj.pathname }) });
        return;
      }
      const hdrMap = new Map(Object.entries(msg.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const rawBody = String(msg.body ?? '');
      const request = {
        url: urlObj.href, method, path: urlObj.pathname,
        headers: { get: (k) => hdrMap.get(String(k).toLowerCase()) ?? null, has: (k) => hdrMap.has(String(k).toLowerCase()), entries: () => hdrMap.entries() },
        body: rawBody, text: async () => rawBody,
        json: async () => (rawBody.trim() ? JSON.parse(rawBody) : null),
      };
      const callerObj = msg.caller
        ? { uuid: msg.caller.uuid, uid: msg.caller.uuid, username: msg.caller.username, email: msg.caller.email, everything: makeEverything('caller', msg.caller) }
        : null;
      const out = await hit.handler({ request, params: hit.params, me: ownerMe, user: callerObj, requestor: callerObj });
      if (out instanceof Response || (out && typeof out === 'object' && typeof out.status === 'number' && typeof out.text === 'function')) {
        const hdrs = {};
        if (out.headers?.forEach) out.headers.forEach((v, k) => { hdrs[k] = v; });
        const text = await out.text();
        parentPort.postMessage({ type: 'res', reqId: msg.reqId, status: out.status || 200, headers: hdrs, body: text });
      } else {
        parentPort.postMessage({ type: 'res', reqId: msg.reqId, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out ?? null) });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'res', reqId: msg.reqId, status: err.status || 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: err.code || 'worker_error', message: err.message || String(err) }) });
    }
  }
});
`;

export function createWorkersService(ctx) {
  const { db } = ctx;
  const pools = new Map();
  let reqCounter = 0;

  function formatWorker(row) {
    if (!row) return null;
    const port = ctx.port || 8443;
    return {
      name: row.name, uid: row.name, host_label: row.name,
      url: `http://${row.name}.localhost:${port}`, file_path: row.file_path,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  async function killPooledThread(name) {
    const entry = pools.get(name);
    if (!entry) return;
    pools.delete(name);
    try { await entry.worker.terminate(); } catch { /* already exited */ }
  }

  function handleThreadRpc(row, ownerUser, currentCaller, worker, msg) {
    const targetUser = msg.actor === 'caller' && currentCaller ? currentCaller : ownerUser;
    const kvNamespace = msg.actor === 'owner' ? `worker:${row.name}` : (row.app_name || 'app');
    const args = msg.args || [];
    Promise.resolve().then(() => {
      if (msg.area === 'kv') {
        if (msg.op === 'list') {
          const pat = args[0];
          const ret = args[1];
          const opts = typeof pat === 'object' && pat !== null ? pat : { pattern: pat, returnValues: !!ret };
          return ctx.kv.list(ownerUser.id, `worker:${row.name}`, opts);
        }
        return ctx.kv[msg.op](ownerUser.id, kvNamespace, ...args);
      }
      if (msg.area === 'fs') {
        if (msg.op === 'read') {
          const buf = ctx.fs.read(targetUser, row.app_name, args[0], args[1]);
          return Buffer.from(buf).toString('base64');
        }
        return ctx.fs[msg.op](targetUser, row.app_name, ...args);
      }
      if (msg.area === 'mail') {
        return ctx.mail.send(targetUser, row.app_name, args[0], !!args[1]);
      }
      throw new Error(`Unsupported worker RPC area: ${msg.area}`);
    }).then(
      (result) => worker.postMessage({ type: 'rpc-reply', id: msg.id, result }),
      (err) => worker.postMessage({ type: 'rpc-reply', id: msg.id, error: err.message, code: err.code })
    );
  }

  function getOrSpawnPool(row, ownerUser) {
    const existing = pools.get(row.name);
    if (existing && existing.updatedAt === row.updated_at) return existing;
    if (existing) killPooledThread(row.name);

    const worker = new Worker(THREAD_BOOTSTRAP, {
      eval: true,
      workerData: { name: row.name, source: row.script_source, owner: { uuid: ownerUser.uuid, username: ownerUser.username, email: ownerUser.email, token: `tok-${ownerUser.username}` } },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });

    const entry = { name: row.name, updatedAt: row.updated_at, worker, inFlight: new Map(), currentCaller: null, spawnCount: (existing?.spawnCount || 0) + 1 };

    worker.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'rpc') handleThreadRpc(row, ownerUser, entry.currentCaller, worker, msg);
      else if (msg.type === 'res') {
        const pending = entry.inFlight.get(msg.reqId);
        if (pending) { clearTimeout(pending.timer); entry.inFlight.delete(msg.reqId); pending.resolve({ status: msg.status, headers: msg.headers, body: msg.body }); }
      }
    });

    worker.on('exit', () => {
      if (pools.get(row.name) === entry) pools.delete(row.name);
      for (const [, p] of entry.inFlight) {
        clearTimeout(p.timer);
        p.resolve({ status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'worker_exited' }) });
      }
      entry.inFlight.clear();
    });

    pools.set(row.name, entry);
    return entry;
  }

  return {
    getPoolStats(name) {
      const e = pools.get(name);
      return e ? { threadId: e.worker.threadId, spawnCount: e.spawnCount } : null;
    },

    create(user, app, name, filePath, explicitSource = null) {
      const cleanName = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleanName) {
        throw Object.assign(new Error('Worker name is required.'), { code: 'invalid_worker_name', status: 400 });
      }
      let source = explicitSource;
      if (source === null) {
        try {
          source = ctx.fs.read(user, app, filePath).toString('utf8');
        } catch {
          const appDir = path.join(ctx.appsDir, app);
          const rel = String(filePath || '').replace(/^\/+/, '');
          const candidates = [path.join(appDir, rel), path.join(appDir, 'public', rel), path.join(appDir, 'dist', rel)];
          const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
          if (!hit) {
            throw Object.assign(new Error(`Worker script not found: ${filePath}`), { code: 'worker_script_not_found', status: 404 });
          }
          source = fs.readFileSync(hit, 'utf8');
        }
      }
      const now = Date.now();
      db.prepare('INSERT OR REPLACE INTO workers (name, owner_id, app_name, file_path, script_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(cleanName, user.id, app || 'app', String(filePath || `${cleanName}.js`), source, now, now);
      killPooledThread(cleanName);
      return formatWorker(db.prepare('SELECT * FROM workers WHERE name = ?').get(cleanName));
    },

    get(name) {
      return formatWorker(db.prepare('SELECT * FROM workers WHERE name = ?').get(String(name || '').trim()));
    },

    list(user) {
      return db.prepare('SELECT * FROM workers WHERE owner_id = ? ORDER BY created_at DESC').all(user.id).map(formatWorker);
    },

    async delete(user, name) {
      const cleanName = String(name || '').trim();
      await killPooledThread(cleanName);
      db.prepare('DELETE FROM workers WHERE name = ?').run(cleanName);
      return { deleted: true, name: cleanName };
    },

    async exec({ target, path: reqPath, method = 'GET', headers = {}, body = '', caller = null, timeoutMs = 15000 }) {
      let workerName = String(target || '').trim();
      let routePath = String(reqPath || '/');
      const urlMatch = /^(?:https?:\/\/)?([^/]+?)(?:\.(?:everything\.work|localhost(?::\d+)?))(\/.*)?$/i.exec(workerName);
      if (urlMatch) {
        workerName = urlMatch[1];
        if (urlMatch[2]) routePath = urlMatch[2];
      } else if (workerName.startsWith('/w/')) {
        const rest = workerName.slice(3);
        const slash = rest.indexOf('/');
        workerName = slash >= 0 ? rest.slice(0, slash) : rest;
        if (slash >= 0) routePath = rest.slice(slash);
      }

      const row = db.prepare('SELECT * FROM workers WHERE name = ?').get(workerName);
      if (!row) {
        return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'worker_not_found', name: workerName }) };
      }
      const ownerUser = db.prepare('SELECT * FROM users WHERE id = ?').get(row.owner_id) || ensureUser(db, 'local');
      const entry = getOrSpawnPool(row, ownerUser);
      entry.currentCaller = caller;

      const reqId = ++reqCounter;
      const fullUrl = `http://${row.name}.localhost:${ctx.port || 8443}${routePath.startsWith('/') ? routePath : '/' + routePath}`;
      const mergedHeaders = { ...headers };
      if (caller) mergedHeaders['everything-auth'] = `tok-${caller.username}`;

      return new Promise((resolve) => {
        const timer = setTimeout(async () => {
          entry.inFlight.delete(reqId);
          await killPooledThread(row.name);
          resolve({ status: 504, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'worker_timeout', error: 'worker_timeout', message: 'Worker execution timed out.' }) });
        }, timeoutMs);

        entry.inFlight.set(reqId, { resolve, timer });
        entry.worker.postMessage({
          type: 'req', reqId, method, url: fullUrl, headers: mergedHeaders, body: body == null ? '' : String(body),
          caller: caller ? { uuid: caller.uuid, username: caller.username, email: caller.email, token: `tok-${caller.username}` } : null,
        });
      });
    },

    async shutdownAll() {
      for (const name of [...pools.keys()]) {
        await killPooledThread(name);
      }
    },
  };
}

export async function handleWorkers(ctx, req, res, url, body, rawBuffer, user, sendJson) {
  const p = url.pathname;
  if (p.startsWith('/w/')) {
    const rest = p.slice(3);
    const slash = rest.indexOf('/');
    const name = slash >= 0 ? rest.slice(0, slash) : rest;
    const routePath = (slash >= 0 ? rest.slice(slash) : '/') + (url.search || '');
    const caller = resolveUser(ctx.db, req, url, { allowDefault: true });
    const reqBody = rawBuffer ? rawBuffer.toString('utf8') : (body ? JSON.stringify(body) : '');
    const out = await ctx.workers.exec({ target: name, path: routePath, method: req.method, headers: req.headers, body: reqBody, caller });
    res.writeHead(out.status || 200, out.headers || { 'content-type': 'application/json' });
    res.end(out.body);
    return true;
  }
  if (!p.startsWith('/api/workers')) return false;
  const app = String(body?.app || url.searchParams.get('app') || 'app');

  try {
    if (p === '/api/workers' || p === '/api/workers/create') return sendJson(res, 200, ctx.workers.create(user, app, body?.name, body?.filePath, body?.source ?? null));
    if (p === '/api/workers/get') {
      const w = ctx.workers.get(body?.name);
      return w ? sendJson(res, 200, w) : sendJson(res, 404, { code: 'worker_not_found', message: 'Worker not found.' });
    }
    if (p === '/api/workers/list') return sendJson(res, 200, ctx.workers.list(user));
    if (p === '/api/workers/delete') return sendJson(res, 200, await ctx.workers.delete(user, body?.name));
    if (p === '/api/workers/exec') {
      const caller = resolveUser(ctx.db, req, url, { allowDefault: false });
      const out = await ctx.workers.exec({
        target: body?.target, path: body?.path, method: body?.method || 'GET',
        headers: body?.headers || {}, body: body?.body ?? '', caller, timeoutMs: body?.timeoutMs || 15000,
      });
      res.writeHead(out.status || 200, out.headers || { 'content-type': 'application/json' });
      res.end(out.body);
      return true;
    }
  } catch (err) {
    return sendJson(res, err.status || 400, { code: err.code || 'worker_error', message: err.message });
  }
  return false;
}
