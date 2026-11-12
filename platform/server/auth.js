import crypto from 'node:crypto';

/**
 * Accounts and sessions for a home server.
 *
 * There is no passwordless sign-in and no implicit "local" user: every request
 * either carries a random session token or is treated as signed out. The first
 * account created through /api/auth/setup is the administrator; everyone else
 * arrives through an invite. Settings therefore have a real owner instead of
 * being writable by any page on the network.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SCRYPT_KEYLEN = 64;

function makeAvatarSvg(username) {
  const label = String(username || 'U').slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#2563eb"/><text x="32" y="38" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="22" font-weight="600">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function initAuth(db, options = {}) {
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
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);

  addColumn(db, 'users', 'password_hash', 'TEXT');
  addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'member'");
  addColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sessions', 'expires_at', 'INTEGER');
  addColumn(db, 'sessions', 'last_seen', 'INTEGER');

  // The old passwordless build created a "local" account for its bundled
  // workers. It is not a person; hide it from People while leaving its files
  // in place for the upgrade.
  db.prepare("UPDATE users SET role = 'system', disabled = 1 WHERE LOWER(username) = 'local' AND password_hash IS NULL").run();

  // Tokens created by the old passwordless build were predictable, and
  // sessions without an expiry cannot be reasoned about. Force one fresh
  // sign-in after upgrading.
  db.prepare('DELETE FROM sessions WHERE expires_at IS NULL').run();
  db.prepare('DELETE FROM invites WHERE expires_at <= ?').run(Date.now());

  if (Array.isArray(options.seedUsers)) {
    for (const seed of options.seedUsers) {
      const role = seed.role === 'admin' ? 'admin' : 'member';
      const user = ensureUser(db, seed.username, seed.email, { role });
      if (seed.password) setPassword(db, user.id, seed.password);
      db.prepare('UPDATE users SET role = ?, disabled = 0 WHERE id = ?').run(role, user.id);
      if (seed.token) {
        db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)')
          .run(String(seed.token), user.id, Date.now(), Date.now() + SESSION_TTL_MS, Date.now());
      }
    }
  }
}

function cleanUsername(username) {
  return String(username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

function validUsername(username) {
  return /^[a-z0-9_.-]{1,32}$/.test(username);
}

function assertPassword(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD) {
    const err = new Error(`Choose a password with at least ${MIN_PASSWORD} characters.`);
    err.status = 400;
    err.code = 'weak_password';
    throw err;
  }
  if (value.length > MAX_PASSWORD) {
    const err = new Error('That password is too long.');
    err.status = 400;
    err.code = 'weak_password';
    throw err;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (!expected.length) return false;
  const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** The one account the server needs for bundled workers. It can never sign in. */
export function ensureUser(db, username, email, { role = 'member' } = {}) {
  const clean = cleanUsername(username) || 'local';
  let row = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(clean);
  if (!row) {
    const uuid = crypto.randomUUID();
    const addr = email || `${clean}@${clean}.localhost`;
    const info = db.prepare(
      'INSERT INTO users (uuid, username, email, avatar_svg, created_at, role) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(uuid, clean, addr, makeAvatarSvg(clean), Date.now(), role);
    row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  return row;
}

export function createUser(db, { username, email, password, role = 'member' }) {
  const clean = cleanUsername(username);
  if (!validUsername(clean)) {
    const err = new Error('Usernames use 1–32 letters, numbers, dots, dashes or underscores.');
    err.status = 400;
    err.code = 'invalid_username';
    throw err;
  }
  if (clean === 'local') {
    const err = new Error('That username is reserved for this server.');
    err.status = 400;
    err.code = 'invalid_username';
    throw err;
  }
  assertPassword(password);
  if (db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(clean)) {
    const err = new Error('That username is already taken.');
    err.status = 409;
    err.code = 'username_taken';
    throw err;
  }
  const uuid = crypto.randomUUID();
  const addr = String(email || '').trim() || `${clean}@${clean}.localhost`;
  const info = db.prepare(
    'INSERT INTO users (uuid, username, email, avatar_svg, created_at, role, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(uuid, clean, addr, makeAvatarSvg(clean), Date.now(), role === 'admin' ? 'admin' : 'member', hashPassword(password));
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function setPassword(db, userId, password) {
  assertPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), Number(userId));
}

export function hasAdmin(db) {
  return !!db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL LIMIT 1").get();
}

export function findUser(db, username) {
  return db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(cleanUsername(username)) || null;
}

export function createSession(db, user, { ttlMs = SESSION_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(token, user.id, now, now + ttlMs, now);
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      try {
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      }
    }
  }
  return out;
}

export function extractToken(req, url) {
  const signedOut = req?.headers?.['x-everything-signed-out'];
  if (signedOut === '1' || signedOut === 'true') return 'SIGNED_OUT';
  const auth = req?.headers?.['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xTok = req?.headers?.['x-everything-token'] || req?.headers?.['everything-auth'];
  if (xTok) return String(xTok).trim();
  const qTok = url?.searchParams?.get('token') || url?.searchParams?.get('everything_token');
  if (qTok) return String(qTok).trim();
  const cookies = parseCookies(req?.headers?.cookie);
  if (cookies.everything_auth_token) return cookies.everything_auth_token;
  return null;
}

export function resolveUserByToken(db, token) {
  if (!token || token === 'SIGNED_OUT' || token === 'none' || token === 'null') return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(String(token));
  if (!row) return null;
  if (row.disabled) return null;
  if (!row.session_expires_at || row.session_expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
    return null;
  }
  const now = Date.now();
  if (!row.last_seen || now - row.last_seen > 60 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(now, String(token));
  }
  delete row.session_expires_at;
  delete row.last_seen;
  return row;
}

/**
 * Resolve the signed-in user. There is deliberately no default user: a missing
 * or invalid token means "signed out", never "become local".
 */
export function resolveUser(db, req, url) {
  const token = extractToken(req, url);
  if (token === 'SIGNED_OUT') return null;
  return token ? resolveUserByToken(db, token) : null;
}

export function formatUser(user, token) {
  if (!user) return null;
  return {
    id: user.uuid,
    uid: user.uuid,
    uuid: user.uuid,
    username: user.username,
    email: user.email,
    role: user.role || 'member',
    admin: (user.role || 'member') === 'admin',
    email_confirmed: true,
    is_temp: false,
    avatar_url: user.avatar_svg,
    ...(token ? { token } : {}),
  };
}

export function publicUser(user) {
  return {
    uuid: user.uuid,
    username: user.username,
    email: user.email,
    role: user.role || 'member',
    avatar_url: user.avatar_svg,
    created_at: user.created_at,
    disabled: !!user.disabled,
  };
}

export function listUsers(db) {
  return db.prepare("SELECT * FROM users WHERE role <> 'system' ORDER BY id ASC").all();
}

export function createInvite(db, createdBy, { username, email, role = 'member' }) {
  const clean = cleanUsername(username);
  if (!validUsername(clean)) {
    const err = new Error('Usernames use 1–32 letters, numbers, dots, dashes or underscores.');
    err.status = 400;
    err.code = 'invalid_username';
    throw err;
  }
  if (clean === 'local') {
    const err = new Error('That username is reserved for this server.');
    err.status = 400;
    err.code = 'invalid_username';
    throw err;
  }
  if (findUser(db, clean)) {
    const err = new Error('That username is already taken.');
    err.status = 409;
    err.code = 'username_taken';
    throw err;
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO invites (token, username, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(token, clean, String(email || '').trim(), role === 'admin' ? 'admin' : 'member', createdBy?.id || null, now, now + INVITE_TTL_MS);
  return db.prepare('SELECT * FROM invites WHERE token = ?').get(token);
}

export function getInvite(db, token) {
  const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(String(token || ''));
  if (!invite || invite.used_at || invite.expires_at <= Date.now()) return null;
  return invite;
}

export function acceptInvite(db, token, { password, email }) {
  const invite = getInvite(db, token);
  if (!invite) {
    const err = new Error('This invite is no longer valid. Ask the administrator for a new one.');
    err.status = 404;
    err.code = 'invite_invalid';
    throw err;
  }
  if (findUser(db, invite.username)) {
    const err = new Error('That username is already taken.');
    err.status = 409;
    err.code = 'username_taken';
    throw err;
  }
  const user = createUser(db, {
    username: invite.username,
    email: email || invite.email,
    password,
    role: invite.role,
  });
  db.prepare('UPDATE invites SET used_at = ? WHERE token = ?').run(Date.now(), invite.token);
  return user;
}

export function listInvites(db) {
  return db.prepare('SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(Date.now());
}

/** Set a new password from the command line. Returns the account, or null. */
export function resetPassword(db, username, password) {
  const user = findUser(db, username);
  if (!user) return null;
  setPassword(db, user.id, password);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return user;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function cookieValue(req, token, maxAgeSeconds) {
  const secure = typeof req?.isSecure === 'function' ? req.isSecure() : !!req?.socket?.encrypted;
  return `everything_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function clearCookie(req) {
  const secure = typeof req?.isSecure === 'function' ? req.isSecure() : !!req?.socket?.encrypted;
  return `everything_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && (req.trustProxy || req.headers['x-everything-trust-proxy'] === '1')) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const loginFailures = new Map();

function tooManyAttempts(key) {
  const found = loginFailures.get(key);
  if (!found) return false;
  if (found.until <= Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return found.count >= 5;
}

function noteFailure(key) {
  const now = Date.now();
  const found = loginFailures.get(key);
  if (!found || found.until <= now) loginFailures.set(key, { count: 1, until: now + 60_000 });
  else found.count += 1;
}

function clearFailures(key) {
  loginFailures.delete(key);
}

function requireUser(user) {
  if (!user) {
    const err = new Error('Sign in to continue.');
    err.status = 401;
    err.code = 'auth_required';
    throw err;
  }
  return user;
}

function requireAdmin(user) {
  requireUser(user);
  if (user.role !== 'admin') {
    const err = new Error('Only an administrator can do that.');
    err.status = 403;
    err.code = 'admin_required';
    throw err;
  }
  return user;
}

function inviteUrl(req, token) {
  const proto = req.isSecure?.() ? 'https' : 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  return `${proto}://${host}/join?token=${encodeURIComponent(token)}`;
}

function invitePayload(req, invite) {
  return {
    token: invite.token,
    username: invite.username,
    email: invite.email || '',
    role: invite.role,
    expires_at: invite.expires_at,
    url: inviteUrl(req, invite.token),
  };
}

export async function handleAuth(ctx, req, res, url, body, sendJson) {
  const { db } = ctx;
  const p = url.pathname;

  try {
    if (p === '/api/auth/status') {
      const user = resolveUser(db, req, url);
      return sendJson(res, 200, {
        setup_required: !hasAdmin(db),
        signed_in: !!user,
        user: formatUser(user),
        admin: user?.role === 'admin',
      });
    }

    if (p === '/api/auth/setup') {
      if (hasAdmin(db)) {
        return sendJson(res, 403, { code: 'setup_complete', message: 'This server already has an administrator.' });
      }
      const user = createUser(db, {
        username: body?.username,
        email: body?.email,
        password: body?.password,
        role: 'admin',
      });
      const token = createSession(db, user);
      res.setHeader('Set-Cookie', cookieValue(req, token, Math.floor(SESSION_TTL_MS / 1000)));
      return sendJson(res, 200, { ok: true, token, user: formatUser(user, token), ...formatUser(user, token) });
    }

    if (p === '/api/auth/signin') {
      if (typeof ctx.isHostedSiteRequest === 'function' && ctx.isHostedSiteRequest(req)) {
        return sendJson(res, 403, {
          code: 'hosted_origin_forbidden',
          message: 'Sign-in is only allowed from app origins, not hosted sites.',
        });
      }
      const username = cleanUsername(body?.username || body?.user);
      const password = String(body?.password ?? '');
      const ip = clientIp(req);
      const key = `${ip}|${username}`;
      if (tooManyAttempts(key)) {
        return sendJson(res, 429, { code: 'too_many_attempts', message: 'Too many sign-in attempts. Wait a minute and try again.' });
      }
      const user = username ? findUser(db, username) : null;
      const ok = !!user && !user.disabled && !!user.password_hash && verifyPassword(password, user.password_hash);
      if (!ok) {
        // Exercise the hash even for an unknown name so the response time does
        // not reveal whether the account exists.
        if (!user) verifyPassword(password, hashPassword('not-a-real-password'));
        noteFailure(key);
        return sendJson(res, 401, { code: 'invalid_credentials', message: 'The username or password is not correct.' });
      }
      clearFailures(key);
      const token = createSession(db, user);
      res.setHeader('Set-Cookie', cookieValue(req, token, Math.floor(SESSION_TTL_MS / 1000)));
      return sendJson(res, 200, { ok: true, token, user: formatUser(user, token), ...formatUser(user, token) });
    }

    if (p === '/api/auth/signout' || p === '/api/auth/logout') {
      const token = extractToken(req, url);
      if (token && token !== 'SIGNED_OUT') destroySession(db, token);
      res.setHeader('Set-Cookie', clearCookie(req));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/auth/whoami' || p === '/api/auth/user') {
      const user = requireUser(resolveUser(db, req, url));
      const token = extractToken(req, url);
      return sendJson(res, 200, formatUser(user, token || undefined));
    }

    if (p === '/api/auth/avatar') {
      const user = resolveUser(db, req, url);
      if (!user) return sendJson(res, 401, { code: 'auth_required', message: 'Sign in to continue.' });
      const qName = url.searchParams.get('username');
      const target = qName ? findUser(db, qName) : user;
      return sendJson(res, 200, { dataUrl: target ? target.avatar_svg : makeAvatarSvg('U') });
    }

    if (p === '/api/auth/users') {
      const user = requireUser(resolveUser(db, req, url));
      requireAdmin(user);
      return sendJson(res, 200, listUsers(db).map(publicUser));
    }

    if (p === '/api/auth/users/create') {
      const admin = requireAdmin(resolveUser(db, req, url));
      const user = createUser(db, {
        username: body?.username,
        email: body?.email,
        password: body?.password,
        role: body?.role,
      });
      return sendJson(res, 200, { ok: true, user: publicUser(user), created_by: admin.uuid });
    }

    if (p === '/api/auth/users/disable') {
      const admin = requireAdmin(resolveUser(db, req, url));
      const target = db.prepare('SELECT * FROM users WHERE uuid = ?').get(String(body?.uuid || ''));
      if (!target) return sendJson(res, 404, { code: 'not_found', message: 'No such user.' });
      if (target.id === admin.id) return sendJson(res, 400, { code: 'invalid_request', message: 'You cannot disable your own account.' });
      const disabled = body?.disabled === false ? 0 : 1;
      if (disabled && target.role === 'admin') {
        const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
        if (admins <= 1) return sendJson(res, 400, { code: 'last_admin', message: 'Keep at least one active administrator.' });
      }
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled, target.id);
      if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      return sendJson(res, 200, { ok: true, username: target.username, disabled: !!disabled });
    }

    if (p === '/api/auth/users/password') {
      const admin = requireAdmin(resolveUser(db, req, url));
      const target = db.prepare('SELECT * FROM users WHERE uuid = ?').get(String(body?.uuid || ''));
      if (!target || target.role === 'system') {
        return sendJson(res, 404, { code: 'not_found', message: 'No such user.' });
      }
      setPassword(db, target.id, body?.new_password);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      return sendJson(res, 200, { ok: true, username: target.username, reset_by: admin.uuid });
    }

    if (p === '/api/auth/password') {
      const user = requireUser(resolveUser(db, req, url));
      if (!user.password_hash || !verifyPassword(body?.current_password, user.password_hash)) {
        return sendJson(res, 401, { code: 'invalid_credentials', message: 'The current password is not correct.' });
      }
      setPassword(db, user.id, body?.new_password);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, extractToken(req, url) || '');
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/auth/invites') {
      const admin = requireAdmin(resolveUser(db, req, url));
      if (req.method === 'GET') {
        return sendJson(res, 200, listInvites(db).map((invite) => invitePayload(req, invite)));
      }
      const invite = createInvite(db, admin, {
        username: body?.username,
        email: body?.email,
        role: body?.role,
      });
      return sendJson(res, 200, invitePayload(req, invite));
    }

    if (p === '/api/auth/invites/revoke') {
      requireAdmin(resolveUser(db, req, url));
      db.prepare('DELETE FROM invites WHERE token = ?').run(String(body?.token || ''));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/auth/invite') {
      const invite = getInvite(db, url.searchParams.get('token'));
      if (!invite) return sendJson(res, 404, { code: 'invite_invalid', message: 'This invite is no longer valid.' });
      return sendJson(res, 200, {
        username: invite.username,
        email: invite.email || '',
        role: invite.role,
        expires_at: invite.expires_at,
      });
    }

    if (p === '/api/auth/invite/accept') {
      const user = acceptInvite(db, body?.token, { password: body?.password, email: body?.email });
      const token = createSession(db, user);
      res.setHeader('Set-Cookie', cookieValue(req, token, Math.floor(SESSION_TTL_MS / 1000)));
      return sendJson(res, 200, { ok: true, token, user: formatUser(user, token), ...formatUser(user, token) });
    }

    if (p === '/api/perms/check') {
      const user = requireUser(resolveUser(db, req, url));
      const app = String(body?.app || url.searchParams.get('app') || 'app');
      const perm = String(body?.permission || 'default');
      const row = db.prepare('SELECT * FROM perms WHERE owner_id = ? AND app_name = ? AND permission = ?').get(user.id, app, perm);
      const granted = row ? row.granted_path !== 'DENIED' : true;
      return sendJson(res, 200, { granted, path: row?.granted_path || '/Documents' });
    }

    if (p === '/api/perms/request') {
      const user = requireUser(resolveUser(db, req, url));
      const app = String(body?.app || url.searchParams.get('app') || 'app');
      const perm = String(body?.permission || 'default');
      const grantedPath = body?.options?.path || '/Documents';
      db.prepare(
        'INSERT OR REPLACE INTO perms (owner_id, app_name, permission, granted_path, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(user.id, app, perm, grantedPath, Date.now());
      return sendJson(res, 200, { granted: true, path: grantedPath });
    }

    if (p === '/api/peer/grant') {
      requireUser(resolveUser(db, req, url));
      const grant = `grant-${crypto.randomBytes(12).toString('hex')}`;
      return sendJson(res, 200, { grant, expiresAt: Date.now() + 3600_000 });
    }
  } catch (err) {
    return sendJson(res, err.status || 500, { code: err.code || 'auth_error', message: err.message || 'Authentication failed.' });
  }

  return false;
}
