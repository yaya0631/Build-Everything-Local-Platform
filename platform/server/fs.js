import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureUser } from './auth.js';

export function initFs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fs_meta (
      uid TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, path TEXT NOT NULL,
      is_dir INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, modified INTEGER NOT NULL, accessed INTEGER NOT NULL,
      UNIQUE(owner_id, path)
    );
    CREATE TABLE IF NOT EXISTS fs_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, path TEXT NOT NULL,
      target_user TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'view', created_at INTEGER NOT NULL,
      UNIQUE(owner_id, path, target_user)
    );
    CREATE TABLE IF NOT EXISTS fs_read_urls (
      token TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, path TEXT NOT NULL,
      expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function normalizeVirtualPath(rawPath, appName = 'app') {
  let p = String(rawPath ?? '/').trim().replace(/\\/g, '/');
  if (p.startsWith('%appdata%')) p = `/Apps/${appName}/${p.slice('%appdata%'.length)}`;
  else if (p.startsWith('~/')) p = p.slice(1);
  else if (p === '~') p = '/';
  else if (!p.startsWith('/')) p = `/Apps/${appName}/${p}`;

  const segs = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return segs.length ? `/${segs.join('/')}` : '/';
}

const parentDirOf = (v) => (v === '/' ? '' : (v.lastIndexOf('/') <= 0 ? '/' : v.slice(0, v.lastIndexOf('/'))));
const baseNameOf = (v) => (v === '/' ? '' : v.slice(v.lastIndexOf('/') + 1));
const fsErr = (msg, code, status = 404) => Object.assign(new Error(msg), { code, status });

export function formatFsEntry(row) {
  const vpath = row.path || '/';
  const dirname = parentDirOf(vpath);
  const isDir = !!row.is_dir;
  return {
    id: row.uid, uid: row.uid, uuid: row.uid, parent_id: null, parent_uid: null,
    path: vpath, dirname: dirname === '/' ? '' : dirname, dirpath: dirname === '/' ? '' : dirname,
    name: baseNameOf(vpath), is_dir: isDir, isDirectory: isDir, type: isDir ? 'dir' : 'file',
    writable: row.writable !== false, is_shared: !!row.is_shared,
    size: isDir ? null : Number(row.size ?? 0),
    created: row.created, modified: row.modified, accessed: row.accessed,
    subdomains: [], workers: [],
  };
}

export function createFsService(ctx) {
  const { db, dataDir } = ctx;
  const filesRoot = path.join(dataDir, 'files');
  fs.mkdirSync(filesRoot, { recursive: true });

  function diskPathFor(user, vpath) {
    const userRoot = path.resolve(filesRoot, user.uuid);
    const target = path.resolve(userRoot, vpath.replace(/^\/+/, ''));
    if (target !== userRoot && !target.startsWith(userRoot + path.sep)) {
      throw fsErr('Path traversal is not allowed.', 'invalid_path', 400);
    }
    return target;
  }

  function resolveTargetOwner(user, app, rawPath, needWrite = false) {
    const vpath = normalizeVirtualPath(rawPath, app);
    const disk = diskPathFor(user, vpath);
    if (fs.existsSync(disk)) return { owner: user, vpath };
    const shared = db.prepare(
      'SELECT s.*, u.id as uid_id, u.uuid as u_uuid, u.username as u_name, u.email as u_email, u.avatar_svg FROM fs_shares s JOIN users u ON u.id = s.owner_id WHERE s.path = ? AND (LOWER(s.target_user) = ? OR s.target_user = ?)'
    ).get(vpath, user.username.toLowerCase(), '*');
    if (shared) {
      if (needWrite && shared.permission !== 'edit' && shared.permission !== 'write') {
        throw fsErr('Shared file is read-only.', 'permission_denied', 403);
      }
      return {
        owner: { id: shared.uid_id, uuid: shared.u_uuid, username: shared.u_name, email: shared.u_email, avatar_svg: shared.avatar_svg },
        vpath,
      };
    }
    return { owner: user, vpath };
  }

  function upsertMeta(ownerId, vpath, isDir, size) {
    const now = Date.now();
    const existing = db.prepare('SELECT * FROM fs_meta WHERE owner_id = ? AND path = ?').get(ownerId, vpath);
    const uid = existing?.uid || crypto.randomUUID();
    const created = existing?.created || now;
    db.prepare(`
      INSERT OR REPLACE INTO fs_meta (uid, owner_id, path, is_dir, size, created, modified, accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid, ownerId, vpath, isDir ? 1 : 0, size || 0, created, now, now);
    return db.prepare('SELECT * FROM fs_meta WHERE uid = ?').get(uid);
  }

  function ensureParentMeta(owner, vpath) {
    const parts = vpath.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      upsertMeta(owner.id, cur, true, 0);
    }
  }

  return {
    write(user, app, rawPath, data = '', options = {}) {
      const { owner, vpath } = resolveTargetOwner(user, app, rawPath, true);
      let finalPath = vpath;
      let disk = diskPathFor(owner, finalPath);

      if (options.exclusive && fs.existsSync(disk)) {
        throw fsErr('File already exists.', 'file_already_exists', 409);
      }
      if (options.dedupeName && fs.existsSync(disk) && options.overwrite === false) {
        const ext = path.posix.extname(finalPath);
        const stem = finalPath.slice(0, finalPath.length - ext.length);
        let n = 1;
        while (fs.existsSync(diskPathFor(owner, `${stem} (${n})${ext}`))) n++;
        finalPath = `${stem} (${n})${ext}`;
        disk = diskPathFor(owner, finalPath);
      }

      fs.mkdirSync(path.dirname(disk), { recursive: true });
      const buf = Buffer.isBuffer(data)
        ? data
        : data instanceof Uint8Array
          ? Buffer.from(data)
          : Buffer.from(String(data ?? ''), 'utf8');
      fs.writeFileSync(disk, buf);
      ensureParentMeta(owner, finalPath);
      const row = upsertMeta(owner.id, finalPath, false, buf.length);
      return formatFsEntry(row);
    },

    read(user, app, rawPath, options = {}) {
      const { owner, vpath } = resolveTargetOwner(user, app, rawPath, false);
      const disk = diskPathFor(owner, vpath);
      if (!fs.existsSync(disk) || fs.statSync(disk).isDirectory()) {
        throw fsErr(`File not found: ${vpath}`, 'subject_does_not_exist', 404);
      }
      const full = fs.readFileSync(disk);
      const offset = Math.max(0, Number(options.offset) || 0);
      const byteCount = Number(options.byte_count ?? options.byteCount) || 0;
      return byteCount > 0 ? full.subarray(offset, offset + byteCount) : (offset > 0 ? full.subarray(offset) : full);
    },

    mkdir(user, app, rawPath, options = {}) {
      let vpath = normalizeVirtualPath(rawPath, app);
      let disk = diskPathFor(user, vpath);
      if (options.exclusive && fs.existsSync(disk)) {
        throw fsErr('Directory already exists.', 'directory_already_exists', 409);
      }
      if (options.dedupeName && fs.existsSync(disk)) {
        let n = 1;
        while (fs.existsSync(diskPathFor(user, `${vpath} (${n})`))) n++;
        vpath = `${vpath} (${n})`;
        disk = diskPathFor(user, vpath);
      }
      fs.mkdirSync(disk, { recursive: true });
      ensureParentMeta(user, vpath);
      return formatFsEntry(upsertMeta(user.id, vpath, true, 0));
    },

    stat(user, app, rawPath) {
      const { owner, vpath } = resolveTargetOwner(user, app, rawPath, false);
      if (vpath === '/') {
        const now = Date.now();
        return formatFsEntry({ uid: `root-${owner.uuid}`, path: '/', is_dir: 1, size: 0, created: now, modified: now, accessed: now });
      }
      const disk = diskPathFor(owner, vpath);
      if (!fs.existsSync(disk)) {
        throw fsErr(`Path does not exist: ${vpath}`, 'subject_does_not_exist', 404);
      }
      const st = fs.statSync(disk);
      const row = upsertMeta(owner.id, vpath, st.isDirectory(), st.size);
      return formatFsEntry(row);
    },

    readdir(user, app, rawPath = '/', options = {}) {
      const { owner, vpath } = resolveTargetOwner(user, app, rawPath, false);
      const disk = diskPathFor(owner, vpath);
      if (!fs.existsSync(disk)) {
        if (vpath === '/' || vpath.startsWith(`/Apps/${app}`)) {
          fs.mkdirSync(disk, { recursive: true });
        } else {
          throw fsErr(`Directory not found: ${vpath}`, 'subject_does_not_exist', 404);
        }
      }
      const names = fs.readdirSync(disk).sort();
      const entries = names.map((name) => {
        const childVpath = vpath === '/' ? `/${name}` : `${vpath}/${name}`;
        const st = fs.statSync(path.join(disk, name));
        return formatFsEntry(upsertMeta(owner.id, childVpath, st.isDirectory(), st.size));
      });

      const hasPagination = options.limit !== undefined || options.cursor !== undefined || options.offset !== undefined || options.includeTotal !== undefined;
      if (!hasPagination) return entries;
      const offset = Number(options.cursor ?? options.offset ?? 0) || 0;
      const limit = options.limit ? Math.max(1, Number(options.limit)) : entries.length;
      const items = entries.slice(offset, offset + limit);
      const cursor = offset + items.length < entries.length ? String(offset + items.length) : null;
      return { items, cursor, ...(options.includeTotal ? { total: entries.length } : {}) };
    },

    delete(user, app, rawPaths, options = {}) {
      const list = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
      for (const item of list) {
        const vpath = normalizeVirtualPath(item, app);
        const disk = diskPathFor(user, vpath);
        if (fs.existsSync(disk)) {
          if (options.descendantsOnly && fs.statSync(disk).isDirectory()) {
            for (const child of fs.readdirSync(disk)) {
              fs.rmSync(path.join(disk, child), { recursive: true, force: true });
            }
            db.prepare('DELETE FROM fs_meta WHERE owner_id = ? AND path LIKE ?').run(user.id, `${vpath}/%`);
          } else {
            fs.rmSync(disk, { recursive: options.recursive !== false, force: true });
            db.prepare('DELETE FROM fs_meta WHERE owner_id = ? AND (path = ? OR path LIKE ?)').run(user.id, vpath, `${vpath}/%`);
          }
        }
      }
      return true;
    },

    rename(user, app, input, maybeNewName) {
      let srcPath = typeof input === 'object' && input ? input.path : input;
      const newName = typeof input === 'object' && input ? (input.newName ?? input.name) : maybeNewName;
      if (!srcPath && input?.uid) {
        const byUid = db.prepare('SELECT path FROM fs_meta WHERE owner_id = ? AND uid = ?').get(user.id, input.uid);
        srcPath = byUid?.path;
      }
      const oldVpath = normalizeVirtualPath(srcPath, app);
      const oldDisk = diskPathFor(user, oldVpath);
      if (!fs.existsSync(oldDisk)) {
        throw fsErr(`Path not found: ${oldVpath}`, 'subject_does_not_exist', 404);
      }
      const nextVpath = String(newName || '').includes('/')
        ? normalizeVirtualPath(newName, app)
        : `${parentDirOf(oldVpath) === '/' ? '' : parentDirOf(oldVpath)}/${String(newName).trim()}`;
      const nextDisk = diskPathFor(user, nextVpath);
      fs.mkdirSync(path.dirname(nextDisk), { recursive: true });
      fs.renameSync(oldDisk, nextDisk);
      db.prepare('DELETE FROM fs_meta WHERE owner_id = ? AND path = ?').run(user.id, oldVpath);
      const st = fs.statSync(nextDisk);
      return formatFsEntry(upsertMeta(user.id, nextVpath, st.isDirectory(), st.size));
    },

    space(user) {
      const row = db.prepare('SELECT COALESCE(SUM(size), 0) as used FROM fs_meta WHERE owner_id = ?').get(user.id);
      const used = Number(row?.used || 0);
      const capacity = 10 * 1024 * 1024 * 1024;
      return { used, capacity, total: capacity, available: capacity - used };
    },

    getReadURL(user, app, rawPath, expiresIn = 3600) {
      const { owner, vpath } = resolveTargetOwner(user, app, rawPath, false);
      const disk = diskPathFor(owner, vpath);
      if (!fs.existsSync(disk)) {
        throw fsErr(`File not found: ${vpath}`, 'subject_does_not_exist', 404);
      }
      const token = `rurl-${crypto.randomBytes(16).toString('hex')}`;
      const expiresAt = Date.now() + Math.max(1, Number(expiresIn) || 3600) * 1000;
      db.prepare('INSERT INTO fs_read_urls (token, owner_id, path, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
        .run(token, owner.id, vpath, expiresAt);
      return `/api/fs/raw/${token}`;
    },

    revokeReadURL(user, tokenOrUrl) {
      const str = String(tokenOrUrl || '');
      const m = /\/api\/fs\/raw\/([a-zA-Z0-9_-]+)/.exec(str);
      const token = m ? m[1] : str;
      db.prepare('UPDATE fs_read_urls SET revoked = 1 WHERE token = ?').run(token);
      return { revoked: true };
    },

    readByToken(token) {
      const row = db.prepare('SELECT * FROM fs_read_urls WHERE token = ?').get(String(token || ''));
      if (!row || row.revoked || row.expires_at <= Date.now()) return null;
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(row.owner_id);
      if (!owner) return null;
      const disk = diskPathFor(owner, row.path);
      if (!fs.existsSync(disk) || fs.statSync(disk).isDirectory()) return null;
      return { buffer: fs.readFileSync(disk), path: row.path };
    },

    share(user, app, rawPath, targetUser, options = {}) {
      const vpath = normalizeVirtualPath(rawPath, app);
      const target = String(targetUser || '*').trim().toLowerCase();
      if (target !== '*') ensureUser(db, target);
      const perm = options?.mode || options?.permission || 'view';
      db.prepare(`
        INSERT OR REPLACE INTO fs_shares (owner_id, path, target_user, permission, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, vpath, target, perm, Date.now());
      return { shared: true, path: vpath, user: target, mode: perm };
    },

    unshare(user, app, rawPath, targetUser) {
      const vpath = normalizeVirtualPath(rawPath, app);
      if (targetUser) {
        db.prepare('DELETE FROM fs_shares WHERE owner_id = ? AND path = ? AND LOWER(target_user) = ?')
          .run(user.id, vpath, String(targetUser).trim().toLowerCase());
      } else {
        db.prepare('DELETE FROM fs_shares WHERE owner_id = ? AND path = ?').run(user.id, vpath);
      }
      return { unshared: true, path: vpath };
    },

    getShares(user, app, rawPath) {
      const vpath = normalizeVirtualPath(rawPath, app);
      const rows = db.prepare('SELECT target_user, permission, created_at FROM fs_shares WHERE owner_id = ? AND path = ?')
        .all(user.id, vpath);
      return {
        path: vpath,
        people: rows.map((r) => ({ username: r.target_user, user: r.target_user, mode: r.permission, created_at: r.created_at })),
        links: [],
      };
    },

    listShared(user, app, rawPath) {
      if (rawPath) return this.getShares(user, app, rawPath).people;
      const incoming = db.prepare(`
        SELECT s.path, s.permission, s.created_at, u.username as owner
        FROM fs_shares s JOIN users u ON u.id = s.owner_id
        WHERE LOWER(s.target_user) = ? OR s.target_user = '*'
      `).all(user.username.toLowerCase());
      return incoming.map((r) => ({ path: r.path, owner: r.owner, mode: r.permission, created_at: r.created_at }));
    },
  };
}

export async function handleFs(ctx, req, res, url, body, rawBuffer, user, sendJson) {
  const p = url.pathname;
  if (p.startsWith('/api/fs/raw/')) {
    const token = p.slice('/api/fs/raw/'.length);
    const found = ctx.fs.readByToken(token);
    if (!found) return sendJson(res, 404, { code: 'not_found', message: 'Read URL is expired or revoked.' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(found.buffer);
    return true;
  }
  if (!p.startsWith('/api/fs/')) return false;
  const app = String(body?.app || url.searchParams.get('app') || 'app');

  try {
    if (p === '/api/fs/write') {
      const targetPath = url.searchParams.get('path') ?? body?.path;
      let opts = body?.options || {};
      if (url.searchParams.get('options')) {
        try { opts = JSON.parse(url.searchParams.get('options')); } catch { /* ignore */ }
      }
      const content = rawBuffer !== null ? rawBuffer : (body?.data ?? '');
      return sendJson(res, 200, ctx.fs.write(user, app, targetPath, content, opts));
    }
    if (p === '/api/fs/read') {
      const targetPath = url.searchParams.get('path') ?? body?.path;
      const buf = ctx.fs.read(user, app, targetPath, {
        offset: url.searchParams.get('offset') ?? body?.offset,
        byte_count: url.searchParams.get('byte_count') ?? body?.byte_count,
      });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
      return true;
    }
    if (p === '/api/fs/mkdir') return sendJson(res, 200, ctx.fs.mkdir(user, app, body?.path, body?.options));
    if (p === '/api/fs/stat') return sendJson(res, 200, ctx.fs.stat(user, app, body?.path));
    if (p === '/api/fs/readdir') return sendJson(res, 200, ctx.fs.readdir(user, app, body?.path, body?.options));
    if (p === '/api/fs/delete') {
      ctx.fs.delete(user, app, body?.path ?? body?.paths, body?.options);
      return sendJson(res, 200, { deleted: true });
    }
    if (p === '/api/fs/rename') return sendJson(res, 200, ctx.fs.rename(user, app, body, body?.newName));
    if (p === '/api/fs/space') return sendJson(res, 200, ctx.fs.space(user));
    if (p === '/api/fs/readurl') {
      const readUrl = ctx.fs.getReadURL(user, app, body?.path, body?.expiresIn);
      return sendJson(res, 200, { url: readUrl });
    }
    if (p === '/api/fs/revoke-readurl') {
      return sendJson(res, 200, ctx.fs.revokeReadURL(user, body?.url ?? body?.token));
    }
    if (p === '/api/fs/share') return sendJson(res, 200, ctx.fs.share(user, app, body?.path, body?.user, body?.options));
    if (p === '/api/fs/unshare') return sendJson(res, 200, ctx.fs.unshare(user, app, body?.path, body?.user));
    if (p === '/api/fs/list-shared') return sendJson(res, 200, ctx.fs.listShared(user, app, body?.path));
    if (p === '/api/fs/shares') return sendJson(res, 200, ctx.fs.getShares(user, app, body?.path));
  } catch (err) {
    return sendJson(res, err.status || 400, { code: err.code || 'fs_error', message: err.message });
  }
  return false;
}
