export const KV_MAX_KEY_SIZE = 1024;
export const KV_MAX_VALUE_SIZE = 399 * 1024;

export function initKv(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      owner_id INTEGER NOT NULL,
      app_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, app_name, key)
    );
  `);
}

function parsePathSegments(expr) {
  const segs = [];
  const str = String(expr || '');
  const re = /\["([^"]+)"\]|\['([^']+)'\]|\[(\d+)\]|([^.\[\]]+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    segs.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return segs;
}

/** The value at a dot/bracket path, or undefined when the path runs off the document. */
function getPath(root, segs) {
  let cur = root;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Write a value at a dot/bracket path, creating the objects the path names. */
function setPath(root, segs, value) {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
}

/** Delete a value at a dot/bracket path; returns whether the path existed. */
function deletePath(root, segs) {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = cur[segs[i]];
  }
  if (cur === null || typeof cur !== 'object') return false;
  return delete cur[segs[segs.length - 1]];
}

function objectRoot(current) {
  return current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {};
}

export function createKvService(ctx) {
  const { db } = ctx;

  function purgeExpired(ownerId, app) {
    db.prepare('DELETE FROM kv_store WHERE owner_id = ? AND app_name = ? AND expires_at IS NOT NULL AND expires_at <= ?')
      .run(ownerId, app, Date.now());
  }

  function notify(ownerId, app, op, key, value) {
    if (typeof ctx.emitEvent === 'function') {
      ctx.emitEvent({ ownerId, app, op, key, value });
    }
  }

  function getOne(ownerId, app, key) {
    purgeExpired(ownerId, app);
    const row = db.prepare('SELECT value_json FROM kv_store WHERE owner_id = ? AND app_name = ? AND key = ?')
      .get(ownerId, app, String(key));
    if (!row) return null;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return row.value_json;
    }
  }

  function setOne(ownerId, app, key, value, expiresAt = null) {
    const k = String(key ?? '');
    if (Buffer.byteLength(k, 'utf8') > KV_MAX_KEY_SIZE) {
      const err = new Error('Key exceeds maximum size of 1024 bytes.');
      err.code = 'key_too_large';
      err.status = 400;
      throw err;
    }
    const serialized = JSON.stringify(value === undefined ? null : value);
    if (Buffer.byteLength(serialized, 'utf8') > KV_MAX_VALUE_SIZE) {
      const err = new Error('Value exceeds maximum size.');
      err.code = 'value_too_large';
      err.status = 413;
      throw err;
    }
    db.prepare(
      'INSERT OR REPLACE INTO kv_store (owner_id, app_name, key, value_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(ownerId, app, k, serialized, expiresAt, Date.now());
    notify(ownerId, app, 'set', k, value);
    return true;
  }

  return {
    get(ownerId, app, keyOrArray) {
      if (Array.isArray(keyOrArray)) {
        return keyOrArray.map((k) => getOne(ownerId, app, k));
      }
      return getOne(ownerId, app, keyOrArray);
    },

    set(ownerId, app, keyOrBatch, value, expires) {
      const exp = typeof expires === 'number' && expires > 0
        ? (expires > 1e11 ? expires : Date.now() + expires * 1000)
        : null;
      if (Array.isArray(keyOrBatch)) {
        for (const item of keyOrBatch) {
          if (item && typeof item === 'object') setOne(ownerId, app, item.key, item.value, exp);
        }
        return true;
      }
      if (keyOrBatch && typeof keyOrBatch === 'object') {
        return setOne(ownerId, app, keyOrBatch.key, keyOrBatch.value, exp);
      }
      return setOne(ownerId, app, keyOrBatch, value, exp);
    },

    del(ownerId, app, keyOrArray) {
      const keys = Array.isArray(keyOrArray) ? keyOrArray : [keyOrArray];
      const stmt = db.prepare('DELETE FROM kv_store WHERE owner_id = ? AND app_name = ? AND key = ?');
      for (const k of keys) {
        stmt.run(ownerId, app, String(k));
        notify(ownerId, app, 'del', String(k), null);
      }
      return true;
    },

    list(ownerId, app, opts = {}) {
      purgeExpired(ownerId, app);
      let rows = db.prepare('SELECT key, value_json FROM kv_store WHERE owner_id = ? AND app_name = ? ORDER BY key ASC')
        .all(ownerId, app);
      if (opts.reverse) rows = rows.reverse();

      if (typeof opts.pattern === 'string' && opts.pattern.trim() && opts.pattern.trim() !== '*') {
        const raw = opts.pattern.trim();
        const prefix = raw.endsWith('*') ? raw.slice(0, -1) : raw;
        rows = rows.filter((r) => r.key.startsWith(prefix));
      }

      const total = rows.length;
      const offset = Number(opts.cursor ?? opts.offset ?? 0) || 0;
      const hasPagination = opts.limit !== undefined || opts.cursor !== undefined || opts.offset !== undefined || opts.includeTotal !== undefined;
      const limit = opts.limit ? Math.max(1, Number(opts.limit)) : rows.length;
      const slice = hasPagination ? rows.slice(offset, offset + limit) : rows;
      const nextCursor = hasPagination && offset + slice.length < total ? String(offset + slice.length) : null;

      const returnValues = !!opts.returnValues && opts.as !== 'keys';
      const items = slice.map((r) => {
        if (!returnValues) return r.key;
        let parsed = null;
        try { parsed = JSON.parse(r.value_json); } catch { parsed = r.value_json; }
        return { key: r.key, value: parsed };
      });

      if (hasPagination) {
        return { items, cursor: nextCursor, ...(opts.includeTotal ? { total } : {}) };
      }
      return items;
    },

    incr(ownerId, app, key, amount = 1) {
      const current = getOne(ownerId, app, key);
      // Puter accepts a path map here as well as a number:
      // incr(key, { 'counters.open': 1, 'counters.closed': -1 }).
      if (amount && typeof amount === 'object' && !Array.isArray(amount)) {
        const root = objectRoot(current);
        for (const [pathExpr, delta] of Object.entries(amount)) {
          const segs = parsePathSegments(pathExpr);
          if (!segs.length) continue;
          const base = Number(getPath(root, segs));
          setPath(root, segs, (Number.isFinite(base) ? base : 0) + (Number(delta) || 0));
        }
        setOne(ownerId, app, key, root);
        return root;
      }
      const base = current === null || current === undefined ? 0 : Number(current) || 0;
      const delta = amount === undefined ? 1 : Number(amount) || 0;
      const next = base + delta;
      setOne(ownerId, app, key, next);
      return next;
    },

    add(ownerId, app, key, value) {
      const current = getOne(ownerId, app, key);
      // Puter's add takes a path map: append to the array at each path.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const root = objectRoot(current);
        for (const [pathExpr, val] of Object.entries(value)) {
          const segs = parsePathSegments(pathExpr);
          if (!segs.length) continue;
          const prev = getPath(root, segs);
          const list = Array.isArray(prev) ? prev.slice() : (prev == null ? [] : [prev]);
          const additions = Array.isArray(val) ? val : [val];
          list.push(...additions);
          setPath(root, segs, list);
        }
        setOne(ownerId, app, key, root);
        return root;
      }
      if (Array.isArray(current) || Array.isArray(value)) {
        const base = Array.isArray(current) ? current : (current == null ? [] : [current]);
        const additions = Array.isArray(value) ? value : [value];
        const next = [...base, ...additions];
        setOne(ownerId, app, key, next);
        return next;
      }
      if (typeof current === 'number' || (current == null && (typeof value === 'number' || value === undefined))) {
        return this.incr(ownerId, app, key, value === undefined ? 1 : value);
      }
      const next = current == null ? [value] : [current, value];
      setOne(ownerId, app, key, next);
      return next;
    },

    update(ownerId, app, key, pathMap) {
      const current = getOne(ownerId, app, key);
      const root = objectRoot(current);
      if (pathMap && typeof pathMap === 'object') {
        for (const [pathExpr, val] of Object.entries(pathMap)) {
          const segs = parsePathSegments(pathExpr);
          if (!segs.length) continue;
          setPath(root, segs, val);
        }
      }
      setOne(ownerId, app, key, root);
      return root;
    },

    remove(ownerId, app, key, ...paths) {
      if (!paths.length) {
        this.del(ownerId, app, key);
        return true;
      }
      const current = getOne(ownerId, app, key);
      if (!current || typeof current !== 'object') return current ?? null;
      const root = structuredClone(current);
      for (const pathExpr of paths) {
        const segs = parsePathSegments(pathExpr);
        if (segs.length) deletePath(root, segs);
      }
      setOne(ownerId, app, key, root);
      return root;
    },

    expire(ownerId, app, key, ttlSeconds) {
      const expiresAt = Date.now() + Math.max(0, Number(ttlSeconds) || 0) * 1000;
      db.prepare('UPDATE kv_store SET expires_at = ? WHERE owner_id = ? AND app_name = ? AND key = ?')
        .run(expiresAt, ownerId, app, String(key));
      return true;
    },
  };
}

export async function handleKv(ctx, req, res, url, body, user, sendJson) {
  const p = url.pathname;
  if (!p.startsWith('/api/kv/')) return false;
  const app = String(body?.app || url.searchParams.get('app') || 'app');
  const kv = ctx.kv;

  try {
    if (p === '/api/kv/get') return sendJson(res, 200, kv.get(user.id, app, body?.key));
    if (p === '/api/kv/set') {
      kv.set(user.id, app, body?.batch ?? body?.key, body?.value, body?.expires);
      return sendJson(res, 200, null);
    }
    if (p === '/api/kv/del') {
      kv.del(user.id, app, body?.key);
      return sendJson(res, 200, null);
    }
    if (p === '/api/kv/list') return sendJson(res, 200, kv.list(user.id, app, body || {}));
    if (p === '/api/kv/incr') return sendJson(res, 200, kv.incr(user.id, app, body?.key, body?.value));
    if (p === '/api/kv/add') return sendJson(res, 200, kv.add(user.id, app, body?.key, body?.value));
    if (p === '/api/kv/update') return sendJson(res, 200, kv.update(user.id, app, body?.key, body?.pathMap));
    if (p === '/api/kv/expire') {
      kv.expire(user.id, app, body?.key, body?.ttlSeconds);
      return sendJson(res, 200, null);
    }
  } catch (err) {
    return sendJson(res, err.status || 400, { code: err.code || 'kv_error', message: err.message });
  }
  return false;
}
