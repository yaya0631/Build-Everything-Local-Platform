import crypto from 'node:crypto';

function makeAvatarSvg(username) {
  const label = String(username || 'U').slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#2563eb"/><text x="32" y="38" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="22" font-weight="600">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function initAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      avatar_svg TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS perms (
      owner_id INTEGER NOT NULL,
      app_name TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_path TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, app_name, permission)
    );
  `);

  const now = Date.now();
  for (const name of ['local', 'alice', 'bob', 'teammate']) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    if (!existing) {
      const uuid = `00000000-0000-4000-8000-${Buffer.from(name.padEnd(12, '0')).toString('hex').slice(0, 12)}`;
      const res = db.prepare(
        'INSERT INTO users (uuid, username, email, avatar_svg, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(uuid, name, `${name}@${name}.localhost`, makeAvatarSvg(name), now);
      db.prepare('INSERT OR IGNORE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
        `tok-${name}`,
        Number(res.lastInsertRowid),
        now
      );
    }
  }
}

export function ensureUser(db, username, email) {
  const clean = String(username || 'local').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'local';
  let row = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(clean);
  if (!row) {
    const uuid = crypto.randomUUID();
    const addr = email || `${clean}@${clean}.localhost`;
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO users (uuid, username, email, avatar_svg, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuid, clean, addr, makeAvatarSvg(clean), now);
    const userId = Number(info.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
      `tok-${clean}`,
      userId,
      now
    );
    row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  }
  return row;
}

export function createSession(db, user) {
  const token = `tok-${user.username}-${crypto.randomBytes(12).toString('hex')}`;
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, Date.now());
  return token;
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

export function extractToken(req, url) {
  const signedOut = req?.headers?.['x-puter-signed-out'];
  if (signedOut === '1' || signedOut === 'true') return 'SIGNED_OUT';
  const auth = req?.headers?.['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xTok = req?.headers?.['x-puter-token'] || req?.headers?.['puter-auth'];
  if (xTok) return String(xTok).trim();
  const qTok = url?.searchParams?.get('token') || url?.searchParams?.get('puter_token');
  if (qTok) return String(qTok).trim();
  const cookies = parseCookies(req?.headers?.cookie);
  if (cookies.puter_auth_token) return cookies.puter_auth_token;
  return null;
}

export function resolveUserByToken(db, token) {
  if (!token || token === 'SIGNED_OUT' || token === 'none' || token === 'null') return null;
  const sess = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (sess) return sess;
  const byUuid = db.prepare('SELECT * FROM users WHERE uuid = ?').get(token);
  if (byUuid) return byUuid;
  if (token.startsWith('tok-')) {
    const name = token.slice(4).split('-')[0];
    if (name) return ensureUser(db, name);
  }
  if (/^[a-z0-9_.-]{1,64}$/i.test(token)) {
    return ensureUser(db, token);
  }
  return null;
}

export function resolveUser(db, req, url, { allowDefault = true } = {}) {
  const token = extractToken(req, url);
  if (token === 'SIGNED_OUT') return null;
  if (token) {
    const found = resolveUserByToken(db, token);
    if (found) return found;
  }
  const qUser = url?.searchParams?.get('user') || req?.headers?.['x-puter-user'];
  if (qUser) return ensureUser(db, qUser);
  return allowDefault ? ensureUser(db, 'local') : null;
}

export function formatUser(user, token) {
  if (!user) return null;
  return {
    id: user.uuid,
    uid: user.uuid,
    uuid: user.uuid,
    username: user.username,
    email: user.email,
    email_confirmed: true,
    is_temp: false,
    avatar_url: user.avatar_svg,
    ...(token ? { token } : {}),
  };
}

export async function handleAuth(ctx, req, res, url, body, sendJson) {
  const { db } = ctx;
  const p = url.pathname;

  if (p === '/api/auth/signin') {
    if (typeof ctx.isHostedSiteRequest === 'function' && ctx.isHostedSiteRequest(req)) {
      return sendJson(res, 403, {
        code: 'hosted_origin_forbidden',
        message: 'Passwordless sign-in is only allowed from app origins, not hosted sites.',
      });
    }
    const username = body?.username || body?.user || url.searchParams.get('user') || 'local';
    const user = ensureUser(db, username, body?.email);
    const token = createSession(db, user);
    res.setHeader('Set-Cookie', `puter_auth_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`);
    return sendJson(res, 200, {
      ok: true,
      token,
      user: formatUser(user, token),
      ...formatUser(user, token),
    });
  }

  if (p === '/api/auth/signout' || p === '/api/auth/logout') {
    const token = extractToken(req, url);
    if (token && token !== 'SIGNED_OUT' && !token.startsWith('tok-local')) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
    res.setHeader('Set-Cookie', 'puter_auth_token=; Path=/; Max-Age=0; SameSite=Lax');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/whoami' || p === '/api/auth/user') {
    const token = extractToken(req, url);
    if (token === 'SIGNED_OUT') {
      return sendJson(res, 401, { code: 'auth_required', message: 'You are not signed in.' });
    }
    const user = resolveUser(db, req, url, { allowDefault: true });
    if (!user) {
      return sendJson(res, 401, { code: 'auth_required', message: 'You are not signed in.' });
    }
    return sendJson(res, 200, formatUser(user, token || `tok-${user.username}`));
  }

  if (p === '/api/auth/avatar') {
    const qName = url.searchParams.get('username');
    const user = qName ? ensureUser(db, qName) : resolveUser(db, req, url, { allowDefault: true });
    return sendJson(res, 200, { dataUrl: user ? user.avatar_svg : makeAvatarSvg('U') });
  }

  if (p === '/api/auth/users') {
    const rows = db.prepare('SELECT uuid, username, email, avatar_svg FROM users ORDER BY id ASC').all();
    return sendJson(res, 200, rows.map((r) => formatUser(r)));
  }

  if (p === '/api/perms/check') {
    const user = resolveUser(db, req, url, { allowDefault: true });
    const app = String(body?.app || url.searchParams.get('app') || 'app');
    const perm = String(body?.permission || 'default');
    const row = db.prepare('SELECT * FROM perms WHERE owner_id = ? AND app_name = ? AND permission = ?').get(user.id, app, perm);
    const granted = row ? row.granted_path !== 'DENIED' : true;
    return sendJson(res, 200, { granted, path: row?.granted_path || '/Documents' });
  }

  if (p === '/api/perms/request') {
    const user = resolveUser(db, req, url, { allowDefault: true });
    const app = String(body?.app || url.searchParams.get('app') || 'app');
    const perm = String(body?.permission || 'default');
    const grantedPath = body?.options?.path || '/Documents';
    db.prepare(
      'INSERT OR REPLACE INTO perms (owner_id, app_name, permission, granted_path, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, app, perm, grantedPath, Date.now());
    return sendJson(res, 200, { granted: true, path: grantedPath });
  }

  if (p === '/api/peer/grant') {
    const grant = `grant-${crypto.randomBytes(12).toString('hex')}`;
    return sendJson(res, 200, { grant, expiresAt: Date.now() + 3600_000 });
  }

  return false;
}
