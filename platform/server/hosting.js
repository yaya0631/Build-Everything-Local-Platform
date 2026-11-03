export function initHosting(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosting (
      subdomain TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      app_name TEXT NOT NULL,
      root_dir TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function cleanSubdomain(raw, reservedApps) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (!s) {
    const err = new Error('A valid subdomain name is required.');
    err.code = 'invalid_subdomain';
    err.status = 400;
    throw err;
  }
  if (reservedApps && reservedApps.has(s)) {
    const err = new Error(`Subdomain "${s}" is reserved for a local application.`);
    err.code = 'reserved_subdomain';
    err.status = 400;
    throw err;
  }
  return s;
}

export function createHostingService(ctx) {
  const { db } = ctx;

  function formatSite(row) {
    if (!row) return null;
    const port = ctx.port || 8443;
    return {
      subdomain: row.subdomain,
      uid: row.subdomain,
      root_dir: row.root_dir,
      dirPath: row.root_dir,
      url: `http://${row.subdomain}.localhost:${port}/`,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  return {
    create(user, app, subdomain, rootDir) {
      const sub = cleanSubdomain(subdomain, ctx.appNames);
      const dir = String(rootDir || '/');
      const now = Date.now();
      db.prepare(`
        INSERT OR REPLACE INTO hosting (subdomain, owner_id, app_name, root_dir, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sub, user.id, app || 'app', dir, now, now);
      return formatSite(db.prepare('SELECT * FROM hosting WHERE subdomain = ?').get(sub));
    },

    update(user, app, subdomain, rootDir) {
      return this.create(user, app, subdomain, rootDir);
    },

    get(subdomain) {
      const sub = cleanSubdomain(subdomain);
      const row = db.prepare('SELECT * FROM hosting WHERE subdomain = ?').get(sub);
      return formatSite(row);
    },

    list(user) {
      const rows = db.prepare('SELECT * FROM hosting WHERE owner_id = ? ORDER BY created_at DESC').all(user.id);
      return rows.map(formatSite);
    },

    delete(user, subdomain) {
      const sub = cleanSubdomain(subdomain);
      db.prepare('DELETE FROM hosting WHERE subdomain = ?').run(sub);
      return { deleted: true, subdomain: sub };
    },

    resolveRecord(subdomain) {
      if (!subdomain) return null;
      return db.prepare('SELECT * FROM hosting WHERE subdomain = ?').get(String(subdomain).toLowerCase());
    },
  };
}

export async function handleHosting(ctx, req, res, url, body, user, sendJson) {
  const p = url.pathname;
  if (!p.startsWith('/api/hosting/')) return false;
  const app = String(body?.app || url.searchParams.get('app') || 'app');

  try {
    if (p === '/api/hosting/create') {
      return sendJson(res, 200, ctx.hosting.create(user, app, body?.subdomain, body?.root_dir ?? body?.dirPath));
    }
    if (p === '/api/hosting/update') {
      return sendJson(res, 200, ctx.hosting.update(user, app, body?.subdomain, body?.root_dir ?? body?.dirPath));
    }
    if (p === '/api/hosting/get') {
      const site = ctx.hosting.get(body?.subdomain);
      if (!site) return sendJson(res, 404, { code: 'not_found', message: 'Subdomain not found.' });
      return sendJson(res, 200, site);
    }
    if (p === '/api/hosting/list') {
      return sendJson(res, 200, ctx.hosting.list(user));
    }
    if (p === '/api/hosting/delete') {
      return sendJson(res, 200, ctx.hosting.delete(user, body?.subdomain));
    }
  } catch (err) {
    return sendJson(res, err.status || 400, { code: err.code || 'hosting_error', message: err.message });
  }
  return false;
}
