import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initAuth, resolveUser, ensureUser, handleAuth, resetPassword } from './auth.js';
import { initFs, createFsService, handleFs } from './fs.js';
import { initKv, createKvService, handleKv } from './kv.js';
import { initMail, createMailService, handleMail } from './mail.js';
import { initHosting, createHostingService, handleHosting } from './hosting.js';
import { initAi, createAiService, handleAi } from './ai.js';
import { initWorkers, createWorkersService, handleWorkers } from './workers.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');
const DEFAULT_APPS_DIR = path.join(ROOT_DIR, 'apps');
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'platform/data');
const SDK_FILE = path.join(ROOT_DIR, 'platform/sdk/everything.js');
const ASSISTANT_SDK_FILE = path.join(ROOT_DIR, 'platform/sdk/assistant.js');
const SETTINGS_FILE = path.join(ROOT_DIR, 'platform/web/settings.html');
const LOGIN_FILE = path.join(ROOT_DIR, 'platform/web/login.html');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
};

function normalizedHost(hostHeader) {
  return String(hostHeader || '').trim().toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '');
}

function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIpv6(host) {
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (!/^[0-9a-f:]+$/.test(host) || !host.includes(':')) return false;
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * A Host header is accepted when it is this machine on a local network:
 * loopback, a private IP (including Tailscale's 100.64/10), an mDNS .local
 * name, a Tailscale MagicDNS name, the machine's own hostname, or an explicit
 * entry in EVERYTHING_ALLOWED_HOSTS. Public hostnames are rejected so a
 * DNS-rebinding page cannot become this server.
 */
export function isValidLocalHost(hostHeader, policy = {}) {
  const host = normalizedHost(hostHeader);
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/.test(host)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(host)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host)) return true;
  const allowed = policy.allowedHosts instanceof Set ? policy.allowedHosts : new Set(policy.allowedHosts || []);
  if (allowed.has(host)) return true;
  const machine = String(policy.machineName || '').toLowerCase();
  if (machine && (host === machine || host === `${machine}.local`)) return true;
  return false;
}

function sameHost(originHost, requestHost) {
  const a = String(originHost || '').toLowerCase();
  const b = String(requestHost || '').toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (value) => value.replace(/:(80|443)$/, '');
  return strip(a) === strip(b);
}

export function isValidLocalOrigin(originHeader, requestHost, policy = {}) {
  if (!originHeader) return true;
  try {
    const u = new URL(originHeader);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!isValidLocalHost(u.host, policy)) return false;
    return requestHost ? sameHost(u.host, requestHost) : true;
  } catch {
    return false;
  }
}

function subdomainOf(hostHeader) {
  const host = normalizedHost(hostHeader);
  if (!host.endsWith('.localhost')) return null;
  return host.slice(0, -'.localhost'.length).split('.')[0] || null;
}

function wsAcceptKey(secKey) {
  return crypto.createHash('sha1').update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wrapWebSocket(socket) {
  const listeners = { message: [], close: [] };
  let closed = false;
  let buf = Buffer.alloc(0);

  function send(data) {
    if (closed) return;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { socket.write(Buffer.concat([header, payload])); } catch { /* ignore */ }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { socket.write(Buffer.from([0x88, 0x00])); socket.end(); } catch { /* ignore */ }
    for (const fn of listeners.close) fn();
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      const body = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
      buf = buf.subarray(offset + maskLen + len);
      if (masked && mask) { for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]; }
      if (opcode === 0x08) { close(); return; }
      if (opcode === 0x09) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch {} continue; }
      if (opcode === 0x01 || opcode === 0x02) { const text = body.toString('utf8'); for (const fn of listeners.message) fn(text); }
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; for (const fn of listeners.close) fn(); } });
  socket.on('error', () => close());
  return { send, close, on(evt, fn) { if (listeners[evt]) listeners[evt].push(fn); } };
}

function registerBundledWorkers(ctx) {
  const systemDefs = [
    ['spreadsheet', 'spreadsheet-email', 'src/workers/email-worker.js'], ['calendar', 'calendar-email', 'src/workers/email-worker.js'],
    ['calendar', 'calendar-rsvp', 'src/workers/rsvp-worker.js'], ['invoicing', 'invoicing-email', 'src/workers/email-worker.js'],
    ['field-service', 'field-service-email', 'src/workers/email-worker.js'], ['property-management', 'property-management-email', 'src/workers/email-worker.js'],
    ['signatures', 'signatures-email', 'src/workers/email-worker.js'], ['signatures', 'signatures-sign', 'src/workers/sign-worker.js'],
    ['teamchat', 'teamchat-email', 'worker/email.js'], ['meetings', 'everything-meetings-rooms', 'worker/rooms.js'],
  ];
  const sysUser = ensureUser(ctx.db, 'local', undefined, { role: 'system' });
  for (const [app, workerName, relPath] of systemDefs) {
    const full = path.join(ctx.appsDir, app, relPath);
    if (fs.existsSync(full)) ctx.workers.create(sysUser, app, workerName, relPath, fs.readFileSync(full, 'utf8'));
  }
}

export function lanAddresses() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const address of list || []) {
        if (address.internal || address.family !== 'IPv4') continue;
        out.push({ name, address: address.address });
      }
    }
  } catch { /* no interfaces */ }
  return out;
}

export function lanUrls(port, host = '0.0.0.0') {
  const urls = [`http://localhost:${port}/`];
  const bound = String(host || '').trim();
  if (bound && bound !== '0.0.0.0' && bound !== '::') {
    if (!['127.0.0.1', '::1', 'localhost'].includes(bound)) {
      urls.push(`http://${bound.includes(':') ? `[${bound}]` : bound}:${port}/`);
    }
    return urls;
  }
  for (const { address } of lanAddresses()) urls.push(`http://${address}:${port}/`);
  return urls;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

export async function createPlatformServer(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const appsDir = options.appsDir || DEFAULT_APPS_DIR;
  fs.mkdirSync(dataDir, { recursive: true });

  const trustProxy = options.trustProxy ?? process.env.EVERYTHING_TRUST_PROXY === '1';
  const secureCookies = options.secureCookies ?? process.env.EVERYTHING_SECURE_COOKIES === '1';
  const extraHosts = String(options.allowedHosts ?? process.env.EVERYTHING_ALLOWED_HOSTS ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hostPolicy = {
    allowedHosts: new Set(extraHosts.map((h) => normalizedHost(h))),
    machineName: os.hostname(),
  };

  const db = new DatabaseSync(path.join(dataDir, 'everything.sqlite'));
  initAuth(db, { seedUsers: options.seedUsers });
  initFs(db); initKv(db); initMail(db); initHosting(db); initWorkers(db); initAi(db);

  const appNames = new Set(
    fs.existsSync(appsDir)
      ? fs.readdirSync(appsDir).filter((f) => fs.statSync(path.join(appsDir, f)).isDirectory())
      : ['chess', 'notes', 'spreadsheet', 'teamchat', 'video-studio', 'meetings']
  );
  // `assets` is the upstream store-listing folder, not an app: keep its files
  // for parity but never serve or build it.
  appNames.delete('assets');

  const eventClients = new Set();
  const peerRooms = new Map();
  const upgradedSockets = new Set();

  const ctx = {
    db, dataDir, appsDir, appNames, port: options.port ?? Number(process.env.PORT || 8443),
    host: options.host ?? process.env.EVERYTHING_HOST ?? '0.0.0.0',
    trustProxy,
    secureCookies,
    requestHost(req) {
      if (trustProxy && req.headers['x-forwarded-host']) return String(req.headers['x-forwarded-host']).split(',')[0].trim();
      return req.headers.host || '';
    },
    isSecureRequest(req) {
      if (secureCookies) return true;
      if (req.socket?.encrypted) return true;
      if (trustProxy) {
        const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
        if (proto === 'https') return true;
      }
      return false;
    },
    emitEvent(ev) {
      for (const c of eventClients) {
        if (c.ownerId !== ev.ownerId) continue;
        for (const [id, s] of c.subs) {
          if (ev.key.startsWith(s.subject) || s.subject === '*') c.ws.send({ type: 'event', id, event: { op: ev.op, key: ev.key, subject: s.subject, ...(s.includeValue ? { value: ev.value } : {}) } });
        }
      }
    },
    isHostedSiteRequest(req) {
      let originSub = null;
      try { if (req.headers.origin) originSub = subdomainOf(new URL(req.headers.origin).host); } catch {}
      const sub = originSub || subdomainOf(req.headers.host);
      return !!(sub && !appNames.has(sub) && ctx.hosting.resolveRecord(sub));
    },
  };

  ctx.fs = createFsService(ctx);
  ctx.kv = createKvService(ctx);
  ctx.mail = createMailService(ctx);
  ctx.hosting = createHostingService(ctx);
  ctx.ai = createAiService(ctx);
  ctx.workers = createWorkersService(ctx);
  registerBundledWorkers(ctx);

  function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data === undefined ? null : data));
    return true;
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });

  function serveStaticFile(res, filePath) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(fs.readFileSync(filePath));
    return true;
  }

  const appInfoCache = new Map();
  function appInfo(name) {
    if (appInfoCache.has(name)) return appInfoCache.get(name);
    let title = name.replace(/(^|-)([a-z])/g, (_, dash, letter) => `${dash ? ' ' : ''}${letter.toUpperCase()}`);
    let description = '';
    try {
      const html = fs.readFileSync(path.join(appsDir, name, 'index.html'), 'utf8');
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      if (m) title = m[1].replace(/\s+/g, ' ').trim() || title;
    } catch { /* keep the folder name */ }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appsDir, name, 'package.json'), 'utf8'));
      description = String(pkg.description || '').replace(/\s+/g, ' ').trim();
    } catch { /* optional */ }
    const info = { name, title, description, url: `/app/${encodeURIComponent(name)}/` };
    appInfoCache.set(name, info);
    return info;
  }

  function appList() {
    return [...appNames].sort().map(appInfo);
  }

  function loginRedirect(req, res, next) {
    const target = next || req.url || '/';
    const safe = target.startsWith('/') && !target.startsWith('//') ? target : '/';
    res.writeHead(302, { Location: `/login?next=${encodeURIComponent(safe)}` });
    res.end();
  }

  function serveLogin(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    res.end(fs.readFileSync(LOGIN_FILE, 'utf8'));
  }

  function serveSettings(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }

  function landingHtml(user) {
    const apps = appList().map((app) => `
      <li><a class="app" href="${app.url}">
        <span class="app-title">${escapeHtml(app.title)}</span>
        <span class="app-desc">${escapeHtml(app.description)}</span>
      </a></li>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Everything Local</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#626a78;--line:#dfe3ea;--accent:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#eef1f6;--muted:#9aa3b2;--line:#2b313c;--accent:#6f9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:18px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{font-weight:650;color:inherit;text-decoration:none}.brand span{color:var(--muted);font-weight:400}
.grow{flex:1}main{max-width:1100px;margin:0 auto;padding:28px 24px 60px}
h1{font-size:24px;margin:0 0 6px}p.lede{margin:0 0 24px;color:var(--muted)}
ul.apps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
a.app{display:flex;flex-direction:column;gap:5px;padding:15px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:inherit;text-decoration:none;min-height:78px}
a.app:hover{border-color:var(--accent)}.app-title{font-weight:600}.app-desc{color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
nav{display:flex;align-items:center;gap:14px;font-size:14px}nav a,nav button{color:inherit;background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline}
.who{color:var(--muted)}
</style></head><body>
<header><a class="brand" href="/">Everything <span>Local</span></a><span class="grow"></span>
<nav><span class="who">${escapeHtml(user.username)}</span>${user.role === 'admin' ? '<a href="/settings">Settings</a>' : ''}<button type="button" id="signout">Sign out</button></nav></header>
<main><h1>Your apps</h1><p class="lede">Everything runs on this machine. Family and friends sign in with their own accounts.</p>
<ul class="apps">${apps}</ul></main>
<script>document.getElementById('signout').addEventListener('click',function(){fetch('/api/auth/signout',{method:'POST',credentials:'same-origin'}).finally(function(){location.assign('/login')})})</script>
</body></html>`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  const server = http.createServer(async (req, res) => {
    const requestHost = ctx.requestHost(req);
    if (!isValidLocalHost(requestHost, hostPolicy)) {
      return sendJson(res, 403, { code: 'invalid_host', message: 'Forbidden Host header.' });
    }
    req.isSecure = () => ctx.isSecureRequest(req);
    req.trustProxy = trustProxy;

    const origin = req.headers.origin;
    if (origin) {
      if (!isValidLocalOrigin(origin, requestHost, hostPolicy)) {
        return sendJson(res, 403, { code: 'invalid_origin', message: 'Forbidden Origin header.' });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Everything-Token, X-Everything-Signed-Out, X-Everything-User, everything-auth');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || '/', `http://${requestHost || '127.0.0.1'}`);
    const p = url.pathname;
    const requestUser = resolveUser(db, req, url);

    if (p === '/sdk/everything.js' || p === '/sdk/assistant.js' || p === '/v2/' || p === '/v2') {
      const file = p === '/sdk/assistant.js' ? ASSISTANT_SDK_FILE : SDK_FILE;
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file, 'utf8'));
      return;
    }

    if (p === '/login' || p === '/join') {
      serveLogin(req, res);
      return;
    }

    if (p === '/logout') {
      const token = req.headers.cookie && /everything_auth_token=([^;]+)/.exec(req.headers.cookie);
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(decodeURIComponent(token[1]));
      res.writeHead(302, {
        'Set-Cookie': `everything_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${ctx.isSecureRequest(req) ? '; Secure' : ''}`,
        Location: '/login',
      });
      res.end();
      return;
    }

    if (p === '/settings' || p === '/settings/') {
      if (!requestUser) return loginRedirect(req, res, '/settings');
      if (requestUser.role !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Only an administrator can open settings.');
        return;
      }
      serveSettings(req, res);
      return;
    }

    if (p.startsWith('/api/') || p.startsWith('/w/')) {
      if (p.startsWith('/api/') && !p.startsWith('/api/fs/raw/') && ctx.isHostedSiteRequest(req)) {
        return sendJson(res, 403, { code: 'hosted_origin_forbidden', message: 'Hosted sites cannot call platform APIs.' });
      }

      const rawBuf = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      const isJson = (req.headers['content-type'] || '').includes('application/json');
      let parsedBody = {};
      if (rawBuf && rawBuf.length > 0 && isJson) {
        try { parsedBody = JSON.parse(rawBuf.toString('utf8')); } catch { parsedBody = {}; }
      }

      if (await handleAuth(ctx, req, res, url, parsedBody, sendJson)) return;

      // Read-by-token file URLs are the one intentionally public API: the token
      // is the capability. Everything else needs a session.
      if (!requestUser && !p.startsWith('/api/fs/raw/')) {
        return sendJson(res, 401, { code: 'auth_required', message: 'Sign in to continue.' });
      }

      if (p === '/api/apps') return sendJson(res, 200, appList());
      if (p === '/api/server/info') {
        if (requestUser.role !== 'admin') return sendJson(res, 403, { code: 'admin_required', message: 'Only an administrator can see server details.' });
        return sendJson(res, 200, {
          host: ctx.host,
          port: ctx.port,
          secure: ctx.isSecureRequest(req),
          trust_proxy: trustProxy,
          addresses: lanAddresses(ctx.port),
          urls: lanUrls(ctx.port, ctx.host),
        });
      }

      if (await handleFs(ctx, req, res, url, parsedBody, isJson ? null : rawBuf, requestUser, sendJson)) return;
      if (await handleKv(ctx, req, res, url, parsedBody, requestUser, sendJson)) return;
      if (await handleMail(ctx, req, res, url, parsedBody, requestUser, sendJson)) return;
      if (await handleHosting(ctx, req, res, url, parsedBody, requestUser, sendJson)) return;
      if (await handleAi(ctx, req, res, url, parsedBody, requestUser, sendJson)) return;
      if (await handleWorkers(ctx, req, res, url, parsedBody, isJson ? null : rawBuf, requestUser, sendJson)) return;
      if (p.startsWith('/api/fleet/')) {
        return sendJson(res, 503, { code: 'offline', message: 'External NHTSA lookup is disabled offline.' });
      }
      return sendJson(res, 404, { code: 'not_found', message: `Unknown API route: ${p}` });
    }

    const sub = subdomainOf(requestHost);
    if (sub && !appNames.has(sub)) {
      const site = ctx.hosting.resolveRecord(sub);
      if (site) {
        const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(site.owner_id);
        if (!owner) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Hosted file not found'); return;
        }
        const relPath = p === '/' ? '/index.html' : p;
        try {
          const content = ctx.fs.read(owner, site.app_name, `${site.root_dir.replace(/\/$/, '')}${relPath}`);
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(relPath).toLowerCase()] || 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(content);
          return;
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Hosted file not found'); return;
        }
      }
    }

    let appName = sub && appNames.has(sub) ? sub : null;
    let assetRel = p;
    if (!appName && p.startsWith('/app/')) {
      const parts = p.slice(5).split('/');
      appName = parts[0];
      assetRel = '/' + parts.slice(1).join('/');
    }
    if (appName && appNames.has(appName)) {
      const appRoot = path.join(appsDir, appName);
      const distRoot = fs.existsSync(path.join(appRoot, 'dist/index.html')) ? path.join(appRoot, 'dist') : appRoot;
      const cleanRel = assetRel === '/' ? 'index.html' : assetRel.replace(/^\/+/, '');
      const wantsIndex = cleanRel === 'index.html';
      if (wantsIndex && !requestUser) return loginRedirect(req, res, req.url || '/');
      if (serveStaticFile(res, path.join(distRoot, cleanRel))) return;
      if (serveStaticFile(res, path.join(appRoot, 'public', cleanRel))) return;
      if (!requestUser) return loginRedirect(req, res, req.url || '/');
      if (serveStaticFile(res, path.join(distRoot, 'index.html'))) return;
    }

    if (!requestUser) return loginRedirect(req, res, '/');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(landingHtml(requestUser));
  });

  server.on('upgrade', (req, socket) => {
    const requestHost = ctx.requestHost(req);
    if (!isValidLocalHost(requestHost, hostPolicy) || !isValidLocalOrigin(req.headers.origin, requestHost, hostPolicy)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    const url = new URL(req.url || '/', `http://${requestHost}`);
    const user = resolveUser(db, req, url);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    if (url.pathname === '/api/net' && user.role !== 'admin') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`);
    const ws = wrapWebSocket(socket);

    if (url.pathname === '/api/events') {
      const client = { ws, ownerId: user.id, subs: new Map() };
      eventClients.add(client);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'sub') {
            client.subs.set(msg.id, { subject: String(msg.subject || '*'), includeValue: !!msg.includeValue });
            ws.send({ type: 'sub-ok', id: msg.id, subId: msg.id, anchor: Date.now(), match: 'prefix', op: 'set|del' });
          } else if (msg.type === 'unsub') {
            client.subs.delete(msg.subId);
          }
        } catch { /* ignore */ }
      });
      ws.on('close', () => eventClients.delete(client));
      return;
    }

    if (url.pathname === '/api/peer') {
      let hostedCode = null;
      let joinedRoom = null;
      let joinedConnId = null;
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'serve') {
          hostedCode = `inv-${crypto.randomBytes(6).toString('hex')}`;
          peerRooms.set(hostedCode, { hostWs: ws, hostUser: { username: user.username, uuid: user.uuid }, peers: new Map() });
          ws.send({ type: 'served', inviteCode: hostedCode });
        } else if (msg.type === 'join') {
          const room = peerRooms.get(msg.code);
          if (!room) { ws.send({ type: 'join-error', code: 'invalid_invite', message: 'Invalid invite code.' }); return; }
          joinedRoom = room;
          joinedConnId = `c-${crypto.randomBytes(4).toString('hex')}`;
          room.peers.set(joinedConnId, ws);
          room.hostWs.send({ type: 'connection', connId: joinedConnId, user: { username: user.username, uuid: user.uuid } });
          ws.send({ type: 'joined', connId: joinedConnId, host: room.hostUser });
        } else if (msg.type === 'relay') {
          if (hostedCode && peerRooms.has(hostedCode)) {
            const room = peerRooms.get(hostedCode);
            const target = room.peers.get(msg.connId);
            if (target) target.send({ type: 'relay', data: msg.data });
          } else if (joinedRoom && joinedConnId) {
            joinedRoom.hostWs.send({ type: 'relay', connId: joinedConnId, data: msg.data });
          }
        } else if (msg.type === 'close-conn' && hostedCode && peerRooms.has(hostedCode)) {
          const room = peerRooms.get(hostedCode);
          const target = room.peers.get(msg.connId);
          if (target) { room.peers.delete(msg.connId); target.send({ type: 'conn-closed', reason: msg.reason || 'Closed.' }); }
        } else if (msg.type === 'close' && joinedRoom && joinedConnId) {
          joinedRoom.peers.delete(joinedConnId);
          joinedRoom.hostWs.send({ type: 'conn-closed', connId: joinedConnId, reason: msg.reason || 'Closed.' });
        } else if (msg.type === 'close-server' && hostedCode && peerRooms.has(hostedCode)) {
          const room = peerRooms.get(hostedCode);
          peerRooms.delete(hostedCode);
          for (const [, pws] of room.peers) pws.send({ type: 'conn-closed', reason: 'Server closed.' });
        }
      });
      ws.on('close', () => {
        if (hostedCode && peerRooms.has(hostedCode)) {
          const room = peerRooms.get(hostedCode);
          peerRooms.delete(hostedCode);
          for (const [, pws] of room.peers) pws.send({ type: 'conn-closed', reason: 'Host disconnected.' });
        }
        if (joinedRoom && joinedConnId) {
          joinedRoom.peers.delete(joinedConnId);
          joinedRoom.hostWs.send({ type: 'conn-closed', connId: joinedConnId, reason: 'Peer disconnected.' });
        }
      });
      return;
    }

    if (url.pathname === '/api/net') {
      const host = url.searchParams.get('host') || '127.0.0.1';
      const port = Number(url.searchParams.get('port')) || 80;
      const useTls = url.searchParams.get('tls') === '1';
      if (host !== '127.0.0.1' && host !== 'localhost') {
        ws.send({ type: 'error', code: 'external_not_allowed', message: 'Only local sockets are permitted.' });
        ws.close();
        return;
      }
      const tcp = useTls ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : net.connect({ host: '127.0.0.1', port });
      tcp.on('data', (chunk) => ws.send({ type: 'data', data: chunk.toString('base64') }));
      tcp.on('error', (err) => ws.send({ type: 'error', code: err.code || 'socket_error', message: err.message }));
      tcp.on('close', (hadError) => ws.send({ type: 'close', hadError: !!hadError }));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'write' && msg.data) tcp.write(Buffer.from(msg.data, 'base64'));
          else if (msg.type === 'close') tcp.end();
        } catch { /* ignore */ }
      });
      ws.on('close', () => tcp.destroy());
    }
  });

  await new Promise((resolve) => server.listen(options.port ?? ctx.port, ctx.host, resolve));
  ctx.port = server.address().port;
  return {
    server, ctx, port: ctx.port,
    async close() {
      await ctx.workers.shutdownAll();
      for (const s of upgradedSockets) s.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

function viteBinFor(appDir) {
  try {
    const requireFromApp = createRequire(path.join(appDir, 'package.json'));
    const pkgPath = requireFromApp.resolve('vite/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite;
    if (bin) return path.resolve(path.dirname(pkgPath), bin);
  } catch { /* fall through to the hoisted copy */ }
  return path.join(ROOT_DIR, 'node_modules/vite/bin/vite.js');
}

function buildApp(app) {
  const appDir = path.join(DEFAULT_APPS_DIR, app);
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const viteBin = viteBinFor(appDir);
  if (!fs.existsSync(viteBin)) throw new Error(`Vite is not installed for ${app}`);
  if (pkg.scripts?.['build:worker']) {
    const tsConfig = path.join(appDir, 'vite.worker.config.ts');
    const cfgFile = fs.existsSync(tsConfig) ? 'vite.worker.config.ts' : 'vite.worker.config.js';
    const worker = spawnSync(process.execPath, [viteBin, 'build', '--config', cfgFile], { cwd: appDir, stdio: 'inherit' });
    if (worker.status !== 0) throw new Error(`${app}: worker build exited with ${worker.status}`);
  }
  const built = spawnSync(process.execPath, [viteBin, 'build'], { cwd: appDir, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`${app}: build exited with ${built.status}`);
}

function buildApps({ onlyMissing = false, only = [] } = {}) {
  const failures = [];
  for (const app of fs.readdirSync(DEFAULT_APPS_DIR).sort()) {
    const appDir = path.join(DEFAULT_APPS_DIR, app);
    if (!fs.existsSync(path.join(appDir, 'package.json'))) continue;
    if (app === 'assets' && !fs.existsSync(path.join(appDir, 'src'))) continue;
    if (only.length && !only.includes(app)) continue;
    if (onlyMissing && fs.existsSync(path.join(appDir, 'dist/index.html'))) continue;
    console.log(`[build] ${app}`);
    try {
      buildApp(app);
    } catch (error) {
      failures.push(app);
      console.error(`[build] ${error.message}`);
    }
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resetName = argValue('--reset-password');
  if (resetName) {
    fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
    const db = new DatabaseSync(path.join(DEFAULT_DATA_DIR, 'everything.sqlite'));
    initAuth(db);
    const password = process.env.EVERYTHING_NEW_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const user = resetPassword(db, resetName, password);
    if (!user) {
      console.error(`No account named "${resetName}".`);
      process.exit(1);
    }
    console.log(`Password reset for ${user.username}. New password: ${password}`);
    console.log('Open the login page, sign in, then change it in Settings.');
    db.close();
    process.exit(0);
  }

  const appFlag = process.argv.indexOf('--build-app');
  const requested = appFlag > -1 ? process.argv.slice(appFlag + 1).filter((arg) => !arg.startsWith('--')) : [];
  if (process.argv.includes('--build') || requested.length) {
    const failures = buildApps({ only: requested });
    if (failures.length) {
      console.error(`\n${failures.length} app(s) failed to build: ${failures.join(', ')}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const missing = buildApps({ onlyMissing: true });
  if (missing.length) console.error(`Serving with ${missing.length} app(s) unbuilt: ${missing.join(', ')}`);
  const listenHost = argValue('--host') || process.env.EVERYTHING_HOST || '0.0.0.0';
  const listenPort = Number(argValue('--port') || process.env.PORT || 8443);
  const started = await createPlatformServer({ host: listenHost, port: listenPort });
  console.log('Everything Local is running:');
  for (const url of lanUrls(started.port, listenHost)) console.log(`  ${url}`);
  console.log('\nFirst run: open one of these addresses and create the administrator account.');
  console.log(`Bound to ${listenHost}:${started.port}. Set EVERYTHING_HOST=127.0.0.1 for this machine only.`);
}
