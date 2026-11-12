/**
 * Everything Local — Drop-in client SDK (`window.everything`).
 * Replaces the hosted Everything SDK locally with zero external network calls, zero popups,
 * and full support for Section 4 APIs + everything.peer (RTCPeerConnection + WS signaling).
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
  var loc = g.location || { protocol: 'http:', host: '127.0.0.1:8443', hostname: '127.0.0.1', origin: 'http://127.0.0.1:8443', search: '' };
  var API_ORIGIN = g.__EVERYTHING_API_ORIGIN__ || (loc.origin && loc.origin !== 'null' ? loc.origin : 'http://127.0.0.1:8443');
  var API_BASE = API_ORIGIN.replace(/\/$/, '') + '/api';

  function detectAppName() {
    if (g.__EVERYTHING_APP_NAME__) return String(g.__EVERYTHING_APP_NAME__);
    var host = String(loc.hostname || '');
    if (host.endsWith('.localhost')) return host.slice(0, -'.localhost'.length).split('.')[0] || 'app';
    var m = /^\/app\/([^/]+)/.exec(String(loc.pathname || ''));
    if (m) return m[1];
    return 'app';
  }

  var APP_NAME = detectAppName();
  var searchParams = new URLSearchParams(String(loc.search || ''));
  var tabUser = searchParams.get('user') || null;

  function storageGet(store, key) {
    try { return store ? store.getItem(key) : null; } catch { return null; }
  }
  function storageSet(store, key, val) {
    try { if (store) store.setItem(key, val); } catch { /* ignore */ }
  }
  function storageRemove(store, key) {
    try { if (store) store.removeItem(key); } catch { /* ignore */ }
  }

  var signedOut = storageGet(g.sessionStorage, 'everything.signedOut') === '1';
  var currentToken = storageGet(g.sessionStorage, 'everything.session.token')
    || storageGet(g.localStorage, 'everything.auth.token')
    || null;

  function isPrivateHost(host) {
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (/\.localhost$/.test(host) || /\.local$/.test(host) || /\.ts\.net$/.test(host)) return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
    var m = /^172\.(\d{1,3})\./.exec(host);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    var t = /^100\.(\d{1,3})\./.exec(host);
    if (t && Number(t[1]) >= 64 && Number(t[1]) <= 127) return true;
    return false;
  }

  function assertLocalUrl(url) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      try {
        var u = new URL(url);
        var h = u.hostname.toLowerCase();
        if (h !== String(loc.hostname || '').toLowerCase() && !isPrivateHost(h)) {
          var err = new Error('External network URLs are blocked in Everything Local: ' + url);
          err.code = 'external_not_allowed';
          throw err;
        }
      } catch (e) {
        if (e.code === 'external_not_allowed') throw e;
      }
    }
    return url;
  }

  function apiHeaders(extra) {
    var h = Object.assign({}, extra || {});
    if (signedOut) h['X-Everything-Signed-Out'] = '1';
    else if (currentToken) h['Authorization'] = 'Bearer ' + currentToken;
    if (tabUser) h['X-Everything-User'] = tabUser;
    return h;
  }

  function apiRequest(method, subPath, body) {
    var url = API_BASE + subPath + (subPath.indexOf('?') >= 0 ? '&' : '?') + 'app=' + encodeURIComponent(APP_NAME);
    var headers = apiHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {});
    var payload = body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body)
      ? Object.assign({ app: APP_NAME }, body)
      : body;
    return fetch(url, {
      method: method,
      credentials: 'include',
      headers: headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    }).then(async function (res) {
      var data = await res.json().catch(function () { return null; });
      if (!res.ok) {
        if (res.status === 401 && g.location && typeof g.location.assign === 'function') {
          try {
            var next = encodeURIComponent(String(loc.pathname || '/') + String(loc.search || ''));
            g.location.assign('/login?next=' + next);
          } catch { /* ignore */ }
        }
        var err = new Error((data && data.message) || ('HTTP ' + res.status));
        err.code = (data && (data.code || data.error)) || 'api_error';
        err.status = res.status;
        throw err;
      }
      return data;
    });
  }

  function FSItem(entry) {
    var e = entry || {};
    this.uid = e.uid || e.id || e.uuid || null;
    this.id = this.uid;
    this.uuid = this.uid;
    this.name = e.name || '';
    this.path = e.path || '/';
    this.dirname = e.dirname || '';
    this.is_dir = !!(e.is_dir || e.isDirectory || e.isDir);
    this.isDirectory = this.is_dir;
    this.isDir = this.is_dir;
    this.size = e.size ?? null;
    this.created = e.created ?? null;
    this.modified = e.modified ?? null;
    this.accessed = e.accessed ?? null;
    this.writable = e.writable !== false;
    this.readURL = e.readURL || null;
  }
  FSItem.prototype.read = function () { return everything.fs.read(this.path); };
  FSItem.prototype.text = function () { return everything.fs.read(this.path).then(function (b) { return b.text(); }); };
  FSItem.prototype.write = function (data) { return everything.fs.write(this.path, data); };
  FSItem.prototype.delete = function () { return everything.fs.delete(this.path); };
  FSItem.prototype.rename = function (newName) { return everything.fs.rename(this.path, newName); };
  FSItem.prototype.readdir = function () { return everything.fs.readdir(this.path); };

  function toBuffer(data) {
    if (data == null) return Promise.resolve(new Uint8Array(0));
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return data.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (typeof data === 'string') return Promise.resolve(new TextEncoder().encode(data));
    return Promise.resolve(new TextEncoder().encode(String(data)));
  }

  var everything = g.everything || {};
  everything.env = 'app';
  everything.appID = APP_NAME;
  everything.APIOrigin = API_BASE;
  everything.args = (function () {
    try { return JSON.parse(searchParams.get('everything_args') || '{}') || {}; } catch { return {}; }
  })();
  everything.source_app = { name: searchParams.get('everything.source_app.name') || null };
  Object.defineProperty(everything, 'authToken', {
    get: function () { return signedOut ? null : currentToken; },
    set: function (v) { currentToken = v; signedOut = !v; },
    configurable: true,
  });

  everything.exit = function () {
    if (g.parent && g.parent !== g && searchParams.get('everything_launch')) {
      try { g.parent.postMessage({ __everythingConn: searchParams.get('everything_launch'), ctrl: 'close' }, '*'); } catch { /* ignore */ }
    }
    return Promise.resolve(undefined);
  };

  everything.auth = {
    signIn: function (options) {
      var opts = options && typeof options === 'object' ? options : {};
      var uname = opts.username || opts.user || null;
      var password = opts.password != null ? String(opts.password) : null;
      if (uname && password) {
        return apiRequest('POST', '/auth/signin', { username: uname, password: password }).then(function (res) {
          signedOut = false;
          currentToken = res.token;
          storageRemove(g.sessionStorage, 'everything.signedOut');
          storageSet(g.sessionStorage, 'everything.session.token', res.token);
          if (!tabUser) storageSet(g.localStorage, 'everything.auth.token', res.token);
          return res;
        });
      }
      // Real accounts cannot be created from an app. Send the browser to the
      // server's sign-in page and resume at the current URL afterwards.
      var next = encodeURIComponent(String(loc.pathname || '/') + String(loc.search || ''));
      if (g.location && typeof g.location.assign === 'function') g.location.assign('/login?next=' + next);
      return new Promise(function () { /* wait for navigation */ });
    },
    signOut: function () {
      return apiRequest('POST', '/auth/signout', {}).catch(function () {}).then(function () {
        signedOut = true;
        currentToken = null;
        storageSet(g.sessionStorage, 'everything.signedOut', '1');
        storageRemove(g.sessionStorage, 'everything.session.token');
        storageRemove(g.localStorage, 'everything.auth.token');
        if (g.location && typeof g.location.assign === 'function') g.location.assign('/login');
      });
    },
    isSignedIn: function () {
      if (signedOut) return Promise.resolve(false);
      return apiRequest('GET', '/auth/whoami').then(function () { return true; }, function () { return false; });
    },
    getUser: function () {
      if (signedOut) return Promise.resolve(null);
      return apiRequest('GET', '/auth/whoami').catch(function () { return null; });
    },
    whoami: function () {
      return apiRequest('GET', '/auth/whoami');
    },
    getProfilePicture: function (options) {
      var q = options && options.username ? '&username=' + encodeURIComponent(options.username) : '';
      return apiRequest('GET', '/auth/avatar?' + q.slice(1)).then(function (d) { return d && d.dataUrl; });
    },
  };

  everything.fs = {
    FSItem: FSItem,
    write: function (path, data, options) {
      var opts = options || {};
      var q = new URLSearchParams({
        app: APP_NAME,
        path: String(path || '/'),
        options: JSON.stringify(opts),
      });
      return toBuffer(data).then(function (bytes) {
        return fetch(API_BASE + '/fs/write?' + q.toString(), {
          method: 'PUT',
          credentials: 'include',
          headers: apiHeaders({ 'Content-Type': 'application/octet-stream' }),
          body: bytes,
        }).then(async function (res) {
          var d = await res.json().catch(function () { return null; });
          if (!res.ok) {
            var err = new Error((d && d.message) || ('HTTP ' + res.status));
            err.code = (d && d.code) || 'fs_error';
            err.status = res.status;
            throw err;
          }
          return d;
        });
      });
    },
    read: function (path, options) {
      var opts = options || {};
      var q = new URLSearchParams({ app: APP_NAME, path: String(path || '/') });
      if (opts.offset !== undefined) q.set('offset', String(opts.offset));
      if (opts.byte_count !== undefined || opts.byteCount !== undefined) {
        q.set('byte_count', String(opts.byte_count ?? opts.byteCount));
      }
      return fetch(API_BASE + '/fs/read?' + q.toString(), {
        method: 'GET',
        credentials: 'include',
        headers: apiHeaders(),
      }).then(async function (res) {
        if (!res.ok) {
          var d = await res.json().catch(function () { return null; });
          var err = new Error((d && d.message) || ('HTTP ' + res.status));
          err.code = (d && d.code) || 'subject_does_not_exist';
          err.status = res.status;
          throw err;
        }
        return res.blob();
      });
    },
    mkdir: function (path, options) {
      return apiRequest('POST', '/fs/mkdir', { path: path, options: options || {} });
    },
    readdir: function (path, options) {
      return apiRequest('POST', '/fs/readdir', { path: path || '/', options: options || {} });
    },
    stat: function (path) {
      return apiRequest('POST', '/fs/stat', { path: path || '/' });
    },
    delete: function (paths, options) {
      return apiRequest('POST', '/fs/delete', { path: paths, options: options || {} }).then(function () { return undefined; });
    },
    rename: function (pathOrObj, newName) {
      var body = typeof pathOrObj === 'object' && pathOrObj !== null
        ? pathOrObj
        : { path: pathOrObj, newName: newName };
      return apiRequest('POST', '/fs/rename', body);
    },
    space: function () {
      return apiRequest('GET', '/fs/space');
    },
    getReadURL: function (path, expiresIn) {
      return apiRequest('POST', '/fs/readurl', { path: path, expiresIn: expiresIn }).then(function (d) {
        return d.url.startsWith('http') ? d.url : (API_ORIGIN.replace(/\/$/, '') + d.url);
      });
    },
    revokeReadURL: function (urlOrToken) {
      return apiRequest('POST', '/fs/revoke-readurl', { url: urlOrToken });
    },
    share: function (path, user, options) {
      var p = typeof path === 'string' ? path : (path && path.path);
      return apiRequest('POST', '/fs/share', { path: p, user: user, options: options || {} });
    },
    unshare: function (path, user) {
      var p = typeof path === 'string' ? path : (path && path.path);
      return apiRequest('POST', '/fs/unshare', { path: p, user: user });
    },
    listShared: function (path) {
      var p = typeof path === 'string' ? path : (path && path.path);
      return apiRequest('POST', '/fs/list-shared', { path: p });
    },
    getShares: function (path) {
      var p = typeof path === 'string' ? path : (path && path.path);
      return apiRequest('POST', '/fs/shares', { path: p });
    },
  };

  everything.kv = {
    MAX: 399 * 1024,
    MAX_KEY_SIZE: 1024,
    MAX_VALUE_SIZE: 399 * 1024,
    set: function (keyOrBatch, value, expires) {
      if (Array.isArray(keyOrBatch)) {
        return apiRequest('POST', '/kv/set', { batch: keyOrBatch, expires: expires }).then(function () { return true; });
      }
      if (keyOrBatch && typeof keyOrBatch === 'object') {
        return apiRequest('POST', '/kv/set', { key: keyOrBatch.key, value: keyOrBatch.value, expires: expires }).then(function () { return true; });
      }
      return apiRequest('POST', '/kv/set', { key: keyOrBatch, value: value, expires: expires }).then(function () { return true; });
    },
    get: function (key) {
      return apiRequest('POST', '/kv/get', { key: key });
    },
    del: function (key) {
      return apiRequest('POST', '/kv/del', { key: key }).then(function () { return true; });
    },
    list: function (patternOrOpts, returnValues) {
      var opts = {};
      if (patternOrOpts && typeof patternOrOpts === 'object' && !Array.isArray(patternOrOpts)) {
        opts = Object.assign({}, patternOrOpts);
      } else if (typeof patternOrOpts === 'boolean') {
        opts.returnValues = patternOrOpts;
      } else if (typeof patternOrOpts === 'string') {
        opts.pattern = patternOrOpts;
        if (returnValues === true) opts.returnValues = true;
      }
      if (opts.stream) {
        var limit = opts.limit || 100;
        var cursor = '0';
        return {
          next: async function () {
            if (cursor === null) return { done: true, value: undefined };
            var page = await apiRequest('POST', '/kv/list', Object.assign({}, opts, { limit: limit, cursor: cursor }));
            var items = (page && page.items) || [];
            cursor = page ? page.cursor : null;
            if (!items.length) return { done: true, value: undefined };
            return { done: false, value: { items: items, cursor: cursor } };
          },
          [Symbol.asyncIterator]: function () { return this; },
        };
      }
      return apiRequest('POST', '/kv/list', opts);
    },
    incr: function (key, value) {
      return apiRequest('POST', '/kv/incr', { key: key, value: value === undefined ? 1 : value });
    },
    add: function (key, value) {
      return apiRequest('POST', '/kv/add', { key: key, value: value === undefined ? 1 : value });
    },
    update: function (key, pathMap) {
      return apiRequest('POST', '/kv/update', { key: key, pathMap: pathMap });
    },
    expire: function (key, ttlSeconds) {
      return apiRequest('POST', '/kv/expire', { key: key, ttlSeconds: ttlSeconds });
    },
  };

  everything.workers = {
    create: function (name, filePath) {
      return apiRequest('POST', '/workers/create', { name: name, filePath: filePath });
    },
    get: function (name) {
      return apiRequest('POST', '/workers/get', { name: name }).catch(function (err) {
        if (err && err.status === 404) return null;
        throw err;
      });
    },
    list: function () {
      return apiRequest('POST', '/workers/list', {});
    },
    delete: function (name) {
      return apiRequest('POST', '/workers/delete', { name: name });
    },
    exec: function (target, init) {
      var opts = init || {};
      var body = opts.body;
      var headers = Object.assign({}, opts.headers || {});
      if (body !== undefined && body !== null && typeof body !== 'string') {
        body = JSON.stringify(body);
        headers['content-type'] = headers['content-type'] || 'application/json';
      }
      var payload = {
        target: String(target),
        path: opts.path || opts.url || undefined,
        method: opts.method || (body != null ? 'POST' : 'GET'),
        headers: headers,
        body: body ?? '',
        timeoutMs: opts.timeoutMs,
      };
      return fetch(API_BASE + '/workers/exec?app=' + encodeURIComponent(APP_NAME), {
        method: 'POST',
        credentials: 'include',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
    },
  };

  everything.email = {
    send: function (message) {
      return apiRequest('POST', '/email/send', { message: message });
    },
    sendTransactional: function (message) {
      return apiRequest('POST', '/email/send-transactional', { message: message });
    },
    list: function (options) {
      return apiRequest('POST', '/email/list', { options: options || {} });
    },
  };

  everything.hosting = {
    create: function (subdomain, dirPath) {
      var o = typeof subdomain === 'object' && subdomain !== null ? subdomain : { subdomain: subdomain, root_dir: dirPath };
      return apiRequest('POST', '/hosting/create', { subdomain: o.subdomain, root_dir: o.root_dir || o.dirPath || '/' });
    },
    update: function (subdomain, dirPath) {
      var o = typeof subdomain === 'object' && subdomain !== null ? subdomain : { subdomain: subdomain, root_dir: dirPath };
      return apiRequest('POST', '/hosting/update', { subdomain: o.subdomain, root_dir: o.root_dir || o.dirPath || '/' });
    },
    get: function (subdomain) {
      var s = typeof subdomain === 'string' ? subdomain : subdomain?.subdomain;
      return apiRequest('POST', '/hosting/get', { subdomain: s });
    },
    list: function () {
      return apiRequest('POST', '/hosting/list', {});
    },
    delete: function (subdomain) {
      var s = typeof subdomain === 'string' ? subdomain : subdomain?.subdomain;
      return apiRequest('POST', '/hosting/delete', { subdomain: s });
    },
  };

  everything.perms = {
    check: function (permission, options) {
      return apiRequest('POST', '/perms/check', { permission: permission, options: options || {} }).then(function (r) {
        return !!(r && r.granted);
      });
    },
    request: function (permission, options) {
      return apiRequest('POST', '/perms/request', { permission: permission, options: options || {} }).then(function (r) {
        return r && r.granted ? (permission === 'folder' ? (r.path || true) : true) : false;
      });
    },
  };

  function makeAppConn(token, targetWin, frame) {
    var handlers = { message: [], close: [] };
    var conn = {
      usesSDK: true,
      appInstanceID: token,
      frame: frame || null,
      postMessage: function (data) {
        if (targetWin && typeof targetWin.postMessage === 'function') {
          targetWin.postMessage({ __everythingConn: token, data: data }, '*');
        }
      },
      on: function (evt, fn) { if (handlers[evt]) handlers[evt].push(fn); return conn; },
      off: function (evt, fn) {
        if (handlers[evt]) handlers[evt] = handlers[evt].filter(function (f) { return f !== fn; });
        return conn;
      },
      close: function () {
        if (frame && frame.remove) frame.remove();
        handlers.close.forEach(function (fn) { fn(); });
      },
      _emit: function (evt, payload) {
        (handlers[evt] || []).slice().forEach(function (fn) { fn(payload); });
      },
    };
    return conn;
  }

  var parentConn = null;
  if (searchParams.get('everything_launch') && g.parent && g.parent !== g) {
    var launchTok = searchParams.get('everything_launch');
    parentConn = makeAppConn(launchTok, g.parent, null);
    if (typeof g.addEventListener === 'function') {
      g.addEventListener('message', function (ev) {
        if (ev.data && ev.data.__everythingConn === launchTok) {
          if (ev.data.ctrl === 'close') parentConn._emit('close');
          else parentConn._emit('message', ev.data.data);
        }
      });
    }
  }

  everything.ui = {
    showOpenFilePicker: async function (options) {
      var opts = options || {};
      if (typeof g.__EVERYTHING_PICKER_MOCK__ === 'function') return g.__EVERYTHING_PICKER_MOCK__('open', opts);
      if (opts.path) {
        var st = await everything.fs.stat(opts.path);
        return opts.multiple ? [new FSItem(st)] : new FSItem(st);
      }
      var list = await everything.fs.readdir('/');
      var files = (Array.isArray(list) ? list : (list.items || [])).filter(function (e) { return !e.is_dir; });
      if (!files.length) return opts.multiple ? [] : null;
      return opts.multiple ? files.map(function (f) { return new FSItem(f); }) : new FSItem(files[0]);
    },
    showSaveFilePicker: async function (content, suggestedName) {
      var name = typeof suggestedName === 'object' && suggestedName ? (suggestedName.suggestName || 'untitled.txt') : (suggestedName || 'untitled.txt');
      if (typeof g.__EVERYTHING_PICKER_MOCK__ === 'function') return g.__EVERYTHING_PICKER_MOCK__('save', { content: content, name: name });
      var entry = await everything.fs.write('/' + String(name).replace(/^\/+/, ''), content ?? '');
      return new FSItem(entry);
    },
    showDirectoryPicker: async function (options) {
      var opts = options || {};
      if (typeof g.__EVERYTHING_PICKER_MOCK__ === 'function') return g.__EVERYTHING_PICKER_MOCK__('dir', opts);
      var dirPath = opts.path || '/';
      var st = await everything.fs.stat(dirPath);
      return new FSItem(st);
    },
    alert: function (message, buttons) {
      var first = Array.isArray(buttons) && buttons[0] ? (buttons[0].id || buttons[0].value || buttons[0].label || 'OK') : 'OK';
      return Promise.resolve(first);
    },
    launchApp: function (name, options) {
      var opts = typeof name === 'object' && name ? name : (options || {});
      var app = typeof name === 'string' ? name : (opts.name || opts.app);
      if (opts.background && typeof document !== 'undefined') {
        var tok = 'launch-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        var frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = '/app/' + encodeURIComponent(app) + '/?everything_launch=' + encodeURIComponent(tok)
          + '&everything_args=' + encodeURIComponent(JSON.stringify(opts.args || {}))
          + '&everything.source_app.name=' + encodeURIComponent(APP_NAME);
        document.body.appendChild(frame);
        var conn = makeAppConn(tok, frame.contentWindow, frame);
        if (typeof g.addEventListener === 'function') {
          g.addEventListener('message', function (ev) {
            if (ev.data && ev.data.__everythingConn === tok) {
              if (ev.data.ctrl === 'close') conn._emit('close');
              else conn._emit('message', ev.data.data);
            }
          });
        }
        return Promise.resolve(conn);
      }
      var url = '/app/' + encodeURIComponent(app) + '/' + (opts.items ? '?open=' + encodeURIComponent(JSON.stringify(opts.items)) : '');
      if (loc.assign) loc.assign(url);
      return Promise.resolve(null);
    },
    parentApp: function () { return parentConn; },
    contextMenu: function () { return undefined; },
    onLaunchedWithItems: function (fn) {
      var raw = searchParams.get('open');
      if (raw && typeof fn === 'function') {
        try { fn(JSON.parse(raw)); } catch { /* ignore */ }
      }
    },
    onItemsOpened: function (fn) { return this.onLaunchedWithItems(fn); },
    setWindowTitle: function (title) {
      if (typeof document !== 'undefined') document.title = String(title ?? '');
    },
    showWindow: function () { return Promise.resolve(null); },
    hideWindow: function () { return undefined; },
    requestPermission: function (perm) {
      return everything.perms.request(perm).then(function (ok) { return { granted: !!ok }; });
    },
    onWindowClose: function (fn) {
      if (typeof g.addEventListener === 'function' && typeof fn === 'function') {
        g.addEventListener('pagehide', function () { try { fn(); } catch { /* ignore */ } });
      }
    },
    requestPictureInPicture: function (video) {
      var el = video || (typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector('video') : null);
      if (el && typeof el.requestPictureInPicture === 'function') return el.requestPictureInPicture();
      return Promise.resolve({ width: 320, height: 180 });
    },
    exitPictureInPicture: function () {
      if (typeof document !== 'undefined' && typeof document.exitPictureInPicture === 'function') {
        return document.exitPictureInPicture().catch(function () { return null; });
      }
      return Promise.resolve(null);
    },
  };

  /**
   * Binary inputs (a File, Blob, ArrayBuffer or typed array) are read here and
   * sent as a data URL, because JSON.stringify would turn them into "{}".
   */
  function encodePayloadValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      // Browsers read Blobs with FileReader. Node-based test harnesses (and
      // some webviews) have no FileReader, so fall back to arrayBuffer().
      if (typeof FileReader === 'function') {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve({ __blob: String(reader.result) }); };
          reader.onerror = function () { reject(new Error('Could not read the file.')); };
          reader.readAsDataURL(value);
        });
      }
      return value.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        var encoded = typeof btoa === 'function'
          ? btoa(bin)
          : (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : '');
        return { __blob: 'data:' + (value.type || 'application/octet-stream') + ';base64,' + encoded };
      });
    }
    if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) {
      var bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { __blob: 'data:application/octet-stream;base64,' + btoa(bin) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(encodePayloadValue));
    if (typeof value === 'object') {
      var out = {};
      var keys = Object.keys(value);
      return Promise.all(keys.map(function (k) { return encodePayloadValue(value[k]); }))
        .then(function (vals) {
          keys.forEach(function (k, i) { out[k] = vals[i]; });
          return out;
        });
    }
    return value;
  }

  /** Flatten { __blob: dataUrl } markers into the plain data URL the server wants. */
  function unwrapBlobs(value) {
    if (value && typeof value === 'object' && typeof value.__blob === 'string') return value.__blob;
    if (Array.isArray(value)) return value.map(unwrapBlobs);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = unwrapBlobs(value[k]); });
      return out;
    }
    return value;
  }

  function aiPost(subPath, payload) {
    return encodePayloadValue(payload)
      .then(function (encoded) { return apiRequest('POST', subPath, unwrapBlobs(encoded)); });
  }

  /** A picture result the way the apps read it: a data URL on .src and .currentSrc. */
  function imageResult(data) {
    var src = (data && (data.src || data.url)) || '';
    if (typeof Image === 'undefined') return { src: src, currentSrc: src };
    var img = new Image();
    img.src = src;
    return img;
  }

  /** A speech result the way the apps read it: an audio element with .src. */
  function audioResult(data) {
    var src = (data && (data.src || data.url)) || '';
    if (typeof Audio === 'undefined') return { src: src, currentSrc: src };
    var audio = new Audio();
    audio.src = src;
    return audio;
  }

  everything.ai = {
    listModels: function () {
      return apiRequest('GET', '/ai/models');
    },
    chat: function (prompt) {
      var opts = {};
      for (var i = 1; i < arguments.length; i++) {
        var a = arguments[i];
        if (a && typeof a === 'object' && !Array.isArray(a)) opts = Object.assign(opts, a);
      }
      var messages = Array.isArray(prompt) ? prompt : [{ role: 'user', content: String(prompt ?? '') }];
      var payload = Object.assign({}, opts, { messages: messages, app: APP_NAME });
      if (opts.stream) {
        return fetch(API_BASE + '/ai/chat?app=' + encodeURIComponent(APP_NAME), {
          method: 'POST',
          credentials: 'include',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
        }).then(async function (res) {
          if (!res.ok) {
            var errData = await res.json().catch(function () { return null; });
            var err = new Error((errData && errData.message) || 'Local AI is not available.');
            err.code = (errData && errData.code) || 'local_ai_unavailable';
            err.status = res.status;
            throw err;
          }
          var reader = res.body.getReader();
          var dec = new TextDecoder();
          var buf = '';
          var queue = [];
          var doneReading = false;
          var streamObj = {
            message: null,
            next: async function () {
              while (!queue.length && !doneReading) {
                var r = await reader.read();
                if (r.done) { doneReading = true; break; }
                buf += dec.decode(r.value, { stream: true });
                var idx;
                while ((idx = buf.indexOf('\n')) >= 0) {
                  var line = buf.slice(0, idx).trim();
                  buf = buf.slice(idx + 1);
                  if (!line) continue;
                  var obj = JSON.parse(line);
                  if (obj.message) streamObj.message = obj.message;
                  queue.push(obj);
                }
              }
              if (queue.length) return { value: queue.shift(), done: false };
              return { value: undefined, done: true };
            },
            [Symbol.asyncIterator]: function () { return this; },
          };
          return streamObj;
        });
      }
      return apiRequest('POST', '/ai/chat', payload).then(function (d) {
        return {
          message: d.message,
          finish_reason: d.finish_reason || 'stop',
          usage: d.usage || {},
          toString: function () { return d.message && d.message.content ? String(d.message.content) : ''; },
          valueOf: function () { return d.message && d.message.content; },
        };
      });
    },
    txt2img: function (prompt, options) {
      var o = options || {};
      return aiPost('/ai/txt2img', {
        prompt: String(prompt ?? ''),
        model: o.model,
        size: o.size,
        input_image: o.input_image,
        options: o,
      }).then(imageResult);
    },
    txt2vid: function (prompt, options) {
      return aiPost('/ai/txt2vid', { prompt: String(prompt ?? ''), options: options || {} });
    },
    speech2txt: function (audio, options) {
      // Some call sites pass (file, true) as a test-mode shorthand.
      var o = options && typeof options === 'object' ? options : (options === true ? { test_mode: true } : {});
      return aiPost('/ai/speech2txt', {
        audio: audio,
        model: o.model,
        language: o.language,
        options: o,
      });
    },
    txt2speech: function (text, options) {
      var o = options || {};
      return aiPost('/ai/txt2speech', {
        text: String(text ?? ''),
        model: o.model,
        voice: o.voice,
        options: o,
      }).then(audioResult);
    },
    img2txt: function (image, options) {
      var o = options || {};
      return aiPost('/ai/img2txt', { image: image, model: o.model, prompt: o.prompt, options: o })
        .then(function (d) { return (d && (d.text ?? d)) || ''; });
    },
  };

  function wsUrl(subPath) {
    var base = API_ORIGIN.replace(/^http/i, 'ws').replace(/\/$/, '');
    return base + '/api' + subPath + (subPath.indexOf('?') >= 0 ? '&' : '?') + 'app=' + encodeURIComponent(APP_NAME)
      + (currentToken ? '&token=' + encodeURIComponent(currentToken) : '');
  }

  function makeEventTarget(obj) {
    var map = {};
    obj.addEventListener = function (type, fn) { (map[type] = map[type] || []).push(fn); };
    obj.removeEventListener = function (type, fn) {
      if (map[type]) map[type] = map[type].filter(function (f) { return f !== fn; });
    };
    obj.on = function (type, fn) { obj.addEventListener(type, fn); return obj; };
    obj.off = function (type, fn) { obj.removeEventListener(type, fn); return obj; };
    obj.dispatchEvent = function (type, ev) {
      (map[type] || []).slice().forEach(function (fn) { fn.call(obj, ev); });
    };
    return obj;
  }

  function createPeerConn(serverObj, ws, id, owner, hostSide) {
    var conn = makeEventTarget({
      owner: owner || null,
      connected: false,
      closed: false,
      linkState: 'connecting',
      publications: new Map(),
      media: new Map(),
      peerconnection: null,
      _slots: {},
      _configs: {},
      _pendingIce: [],
      _pendingMedia: [],
    });

    function relay(payload) {
      if (conn.closed || ws.readyState !== 1) return;
      ws.send(JSON.stringify(hostSide ? { type: 'relay', connId: id, data: payload } : { type: 'relay', data: payload }));
    }

    if (typeof g.RTCPeerConnection === 'function') {
      try {
        var pc = new g.RTCPeerConnection({ iceServers: [] });
        conn.peerconnection = pc;
        if (!hostSide && typeof pc.addTransceiver === 'function') {
          try {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
          } catch { /* ignore */ }
        }
        pc.onicecandidate = function (e) {
          if (e.candidate) relay({ t: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
        };
        pc.onconnectionstatechange = function () {
          if (pc.connectionState === 'connected') {
            conn.linkState = 'connected';
            conn.dispatchEvent('linkstate', { state: 'connected', attempt: 0, of: 3 });
          }
        };
      } catch { /* fallback to WS relay */ }
    }

    function applyRemoteMedia(m) {
      if (m.action === 'unpublish') {
        var old = conn.media.get(m.name);
        conn.media.delete(m.name);
        if (old) conn.dispatchEvent('mediaended', { name: m.name, stream: old });
        return;
      }
      var pc = conn.peerconnection;
      var trs = pc && typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : [];
      if (pc && !trs.length && !pc.remoteDescription) {
        conn._pendingMedia.push(m);
        return;
      }
      var stream = conn.media.get(m.name);
      if (!stream) {
        stream = typeof g.MediaStream === 'function' ? new g.MediaStream() : { id: m.name, getTracks: function () { return []; } };
        conn.media.set(m.name, stream);
      }
      (m.slots || [0]).forEach(function (slot) {
        var track = trs[slot] && trs[slot].receiver && trs[slot].receiver.track
          ? trs[slot].receiver.track
          : { kind: slot === 0 ? 'audio' : 'video', id: m.name + '-' + slot };
        if (stream.addTrack && trs[slot]?.receiver?.track) {
          try { stream.addTrack(track); } catch { /* ignore */ }
        }
        conn.dispatchEvent('media', { name: m.name, stream: stream, track: track });
      });
    }

    conn.send = function (data) {
      if (conn.closed) throw new Error('Connection is closed.');
      relay({ t: 'msg', data: data });
    };
    conn.publish = function (name, stream, options) {
      conn.publications.set(name, stream);
      if (options && options.video) conn._configs[name] = options.video;
      var tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
      var slots = tracks.length ? tracks.map(function (t, idx) { return t.kind === 'audio' ? 0 : (idx + 1); }) : [1];
      conn._slots[name] = slots;
      var pc = conn.peerconnection;
      if (pc && typeof pc.getTransceivers === 'function') {
        var trs = pc.getTransceivers();
        slots.forEach(function (slot, i) {
          if (trs[slot] && trs[slot].sender && tracks[i]) {
            try { trs[slot].sender.replaceTrack(tracks[i]); } catch { /* ignore */ }
          }
        });
      }
      relay({ t: 'media', action: 'publish', name: name, slots: slots });
    };
    conn.unpublish = function (name) {
      conn.publications.delete(name);
      delete conn._slots[name];
      relay({ t: 'media', action: 'unpublish', name: name });
    };
    conn.configure = function (name, options) {
      if (options && options.video) conn._configs[name] = Object.assign({}, conn._configs[name] || {}, options.video);
    };
    conn.close = function (reason) {
      if (conn.closed) return;
      conn.closed = true;
      conn.connected = false;
      try { if (conn.peerconnection) conn.peerconnection.close(); } catch { /* ignore */ }
      if (serverObj) serverObj.connections.delete(id);
      try {
        ws.send(JSON.stringify(hostSide ? { type: 'close-conn', connId: id, reason: reason } : { type: 'close', reason: reason }));
      } catch { /* ignore */ }
    };
    conn._fromPeer = function (d) {
      if (!d || conn.closed) return;
      if (d.t === 'msg') conn.dispatchEvent('message', { data: d.data });
      else if (d.t === 'media') applyRemoteMedia(d);
      else if (d.t === 'sdp' && conn.peerconnection) {
        var pc = conn.peerconnection;
        pc.setRemoteDescription(d.description).then(function () {
          var pending = conn._pendingIce.splice(0);
          pending.forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
          var pm = conn._pendingMedia.splice(0);
          pm.forEach(applyRemoteMedia);
          if (d.description.type === 'offer') {
            return pc.createAnswer().then(function (ans) {
              return pc.setLocalDescription(ans);
            }).then(function () {
              relay({ t: 'sdp', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
            });
          }
        }).catch(function () {});
      } else if (d.t === 'ice' && conn.peerconnection) {
        if (!conn.peerconnection.remoteDescription) conn._pendingIce.push(d.candidate);
        else conn.peerconnection.addIceCandidate(d.candidate).catch(function () {});
      }
    };
    conn._open = function () {
      conn.connected = true;
      conn.linkState = 'connected';
      conn.dispatchEvent('open', {});
      var pc = conn.peerconnection;
      if (!hostSide && pc && typeof pc.createOffer === 'function') {
        try { if (typeof pc.createDataChannel === 'function') pc.createDataChannel('__everything_peer', { negotiated: true, id: 0 }); } catch {}
        pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          relay({ t: 'sdp', description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }).catch(function () {});
      }
    };
    conn._remoteClose = function (reason) {
      if (conn.closed) return;
      conn.closed = true;
      conn.connected = false;
      try { if (conn.peerconnection) conn.peerconnection.close(); } catch {}
      if (serverObj) serverObj.connections.delete(id);
      conn.dispatchEvent('close', { reason: reason || 'Closed.' });
    };
    return conn;
  }

  everything.peer = {
    ensureTurnRelays: function () { return Promise.resolve([]); },
    createGuestGrant: function () { return apiRequest('POST', '/peer/grant', {}); },
    serve: function () {
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket(wsUrl('/peer'));
        var srv = makeEventTarget({
          inviteCode: '',
          connections: new Map(),
          close: function () {
            srv.connections.forEach(function (c) { c._remoteClose('Server closed.'); });
            srv.connections.clear();
            try { ws.send(JSON.stringify({ type: 'close-server' })); ws.close(); } catch {}
            srv.dispatchEvent('close', { reason: 'Server closed.' });
          },
        });
        ws.onopen = function () { ws.send(JSON.stringify({ type: 'serve' })); };
        ws.onerror = function () { reject(new Error('Could not connect to local peer signaller.')); };
        ws.onmessage = function (ev) {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'served') {
            srv.inviteCode = msg.inviteCode;
            resolve(srv);
          } else if (msg.type === 'connection') {
            var c = createPeerConn(srv, ws, msg.connId, msg.user, true);
            srv.connections.set(msg.connId, c);
            srv.dispatchEvent('connection', { conn: c, user: msg.user });
            queueMicrotask(function () { c._open(); });
          } else if (msg.type === 'relay') {
            var target = srv.connections.get(msg.connId);
            if (target) target._fromPeer(msg.data);
          } else if (msg.type === 'conn-closed') {
            var gone = srv.connections.get(msg.connId);
            if (gone) gone._remoteClose(msg.reason);
          }
        };
      });
    },
    connect: function (code) {
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket(wsUrl('/peer'));
        var conn = null;
        ws.onopen = function () { ws.send(JSON.stringify({ type: 'join', code: code })); };
        ws.onerror = function () { reject(new Error('Could not connect to local peer signaller.')); };
        ws.onmessage = function (ev) {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'joined') {
            conn = createPeerConn(null, ws, msg.connId, msg.host, false);
            resolve(conn);
            queueMicrotask(function () { conn._open(); });
          } else if (msg.type === 'join-error') {
            var err = new Error(msg.message || 'Invalid invite code.');
            err.code = msg.code || 'invalid_invite';
            reject(err);
          } else if (msg.type === 'relay' && conn) {
            conn._fromPeer(msg.data);
          } else if (msg.type === 'conn-closed' && conn) {
            conn._remoteClose(msg.reason);
          }
        };
      });
    },
  };

  everything.events = {
    onLocal: function (subject, handler, options) {
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket(wsUrl('/events'));
        var id = 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        ws.onopen = function () {
          ws.send(JSON.stringify({ type: 'sub', id: id, subject: subject, includeValue: !!(options && options.includeValue) }));
        };
        ws.onerror = function () { reject(new Error('Event socket failed.')); };
        ws.onmessage = function (ev) {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'sub-ok' && msg.id === id) {
            resolve({
              subId: msg.subId,
              subject: subject,
              off: function () {
                try { ws.send(JSON.stringify({ type: 'unsub', subId: id })); ws.close(); } catch {}
                return Promise.resolve();
              },
            });
          } else if (msg.type === 'event' && msg.id === id && typeof handler === 'function') {
            handler({ event: msg.event });
          }
        };
      });
    },
  };

  function makeNetSocket(host, port, isTls) {
    var ws = new WebSocket(wsUrl('/net?host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + (isTls ? '&tls=1' : '')));
    var listeners = {};
    ws.onopen = function () { (listeners.open || []).forEach(function (fn) { fn(); }); };
    ws.onmessage = function (ev) {
      var msg = JSON.parse(ev.data);
      if (msg.type === 'data') {
        var raw = atob(msg.data || '');
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        (listeners.data || []).forEach(function (fn) { fn(bytes); });
      } else if (msg.type === 'error') {
        (listeners.error || []).forEach(function (fn) { fn(new Error(msg.message)); });
      } else if (msg.type === 'close') {
        (listeners.close || []).forEach(function (fn) { fn(!!msg.hadError); });
      }
    };
    return {
      on: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return this; },
      write: function (val) {
        toBuffer(val).then(function (b) {
          var s = '';
          for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
          ws.send(JSON.stringify({ type: 'write', data: btoa(s) }));
        });
      },
      close: function () { try { ws.send(JSON.stringify({ type: 'close' })); ws.close(); } catch {} },
    };
  }

  everything.net = {
    fetch: function (url, options) {
      assertLocalUrl(url);
      return fetch(url, options || {});
    },
    Socket: function (host, port) { return makeNetSocket(host, port, false); },
    tls: { TLSSocket: function (host, port) { return makeNetSocket(host, port, true); } },
  };

  /* ------------------------------------------------------------------ */
  /* Shared assistant                                                    */
  /* ------------------------------------------------------------------ */

  var ASSISTANT_NATIVE_APPS = ['3d', 'parametric', 'building-design', 'spreadsheet', 'presentation'];
  everything.assistant = everything.assistant || {};
  everything.assistant.nativeApps = ASSISTANT_NATIVE_APPS;
  everything.assistant._tools = everything.assistant._tools || [];

  /** Register one app-provided tool. Returns a function that removes it. */
  everything.assistant.registerTool = function (tool) {
    if (!tool || typeof tool !== 'object') throw new TypeError('registerTool expects a tool object.');
    var fn = tool.function || tool;
    var name = String(fn.name || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      throw new Error('Tool names use 1–64 letters, numbers, underscores or dashes.');
    }
    if (typeof tool.handler !== 'function') throw new Error('Tool "' + name + '" needs a handler function.');
    var entry = Object.assign({}, tool, {
      function: {
        name: name,
        description: String(fn.description || '').slice(0, 4000),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      },
      handler: tool.handler,
    });
    var list = everything.assistant._tools;
    for (var i = 0; i < list.length; i++) {
      if (((list[i].function || list[i]).name) === name) {
        list[i] = entry;
        return function () {
          var at = list.indexOf(entry);
          if (at >= 0) list.splice(at, 1);
        };
      }
    }
    list.push(entry);
    return function () {
      var at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
  };

  everything.assistant.registerTools = function (tools) {
    return (Array.isArray(tools) ? tools : []).map(everything.assistant.registerTool);
  };

  var assistantLoading = false;
  function loadSharedAssistant() {
    if (assistantLoading || !g.document || !g.document.createElement) return;
    if (everything.assistant.mounted) return;
    if (ASSISTANT_NATIVE_APPS.indexOf(APP_NAME) >= 0) return;
    if (!g.document.body) {
      setTimeout(loadSharedAssistant, 10);
      return;
    }
    assistantLoading = true;
    fetch(API_BASE + '/ai/assistant?app=' + encodeURIComponent(APP_NAME), {
      credentials: 'include',
      headers: apiHeaders(),
    }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (cfg) {
      if (!cfg || !cfg.enabled || !cfg.app_enabled) return;
      g.__EVERYTHING_ASSISTANT_CONFIG__ = cfg;
      var script = g.document.createElement('script');
      script.src = API_ORIGIN.replace(/\/$/, '') + '/sdk/assistant.js';
      script.async = true;
      (g.document.head || g.document.documentElement).appendChild(script);
    }).catch(function () {
      /* An unreachable server leaves the app untouched. */
    }).finally(function () {
      assistantLoading = false;
    });
  }

  if (g.document && g.document.readyState === 'loading') {
    g.document.addEventListener('DOMContentLoaded', loadSharedAssistant);
  } else {
    setTimeout(loadSharedAssistant, 0);
  }

  g.everything = everything;
})();
