import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { createPlatformServer, isValidLocalHost, isValidLocalOrigin } from './server/index.js';
import { initAuth, listUsers, createUser } from './server/auth.js';
import { initAi } from './server/ai.js';

const TEST_USERS = {
  alice: { password: 'alice-password', role: 'admin' },
  bob: { password: 'bob-password', role: 'member' },
  carol: { password: 'carol-password', role: 'member' },
};

const testToken = (user) => `tok-${user}`;

function makeMockRTC() {
  const pairs = new Set();
  return class MockRTCPeerConnection {
    constructor(config = {}) {
      this.config = config;
      this.transceivers = [];
      this.localDescription = null;
      this.remoteDescription = null;
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      pairs.add(this);
    }
    addTransceiver(kind, init = {}) {
      const sender = {
        track: null,
        replaceTrack: async (t) => { sender.track = t; },
      };
      const receiver = {
        track: { kind, id: `recv-${kind}-${this.transceivers.length}` },
      };
      const tr = { kind, direction: init.direction || 'sendrecv', sender, receiver };
      this.transceivers.push(tr);
      return tr;
    }
    getTransceivers() { return this.transceivers; }
    createDataChannel(label) { return { label, close() {} }; }
    async createOffer() {
      return { type: 'offer', sdp: `v=0\r\nm=audio 9 RTP/SAVPF 111\r\nm=video 9 RTP/SAVPF 96\r\n` };
    }
    async createAnswer() {
      return { type: 'answer', sdp: `v=0\r\nm=audio 9 RTP/SAVPF 111\r\nm=video 9 RTP/SAVPF 96\r\n` };
    }
    async setLocalDescription(desc) {
      this.localDescription = desc;
      queueMicrotask(() => {
        if (this.onicecandidate) {
          this.onicecandidate({ candidate: { candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        }
      });
    }
    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
      if (desc.type === 'offer' && this.transceivers.length === 0) {
        this.addTransceiver('audio');
        this.addTransceiver('video');
        this.addTransceiver('video');
      }
      this.connectionState = 'connected';
      queueMicrotask(() => {
        if (this.onconnectionstatechange) this.onconnectionstatechange();
      });
    }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
  };
}

/** Direct HTTP call to the platform API, for the endpoints the SDK does not wrap. */
async function api(port, subPath, { method = 'GET', body, user = 'alice', token, origin } = {}) {
  const bearer = token !== undefined ? token : user ? testToken(user) : null;
  const sep = subPath.includes('?') ? '&' : '?';
  const res = await fetch(`http://127.0.0.1:${port}/api${subPath}${sep}app=test`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.message) || `HTTP ${res.status}`);
    err.code = data && data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function createSdkClient(port, { app = 'notes', user = 'alice', token, rtcClass = null } = {}) {
  const sdkCode = fs.readFileSync(path.resolve(import.meta.dirname, 'sdk/everything.js'), 'utf8');
  const bearer = token !== undefined ? token : user ? testToken(user) : null;
  const store = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };
  const sandbox = {
    fetch,
    WebSocket,
    Blob,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    ArrayBuffer,
    Uint8Array,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    localStorage: store(),
    sessionStorage: store(),
    RTCPeerConnection: rtcClass || makeMockRTC(),
    MediaStream: class MockMediaStream {
      constructor(tracks = []) { this._tracks = [...tracks]; }
      getTracks() { return this._tracks; }
      addTrack(t) { if (!this._tracks.includes(t)) this._tracks.push(t); }
    },
    document: { title: '' },
    location: {
      protocol: 'http:',
      host: `${app}.localhost:${port}`,
      hostname: `${app}.localhost`,
      origin: `http://127.0.0.1:${port}`,
      pathname: '/',
      search: '',
      assign(u) { this.href = u; },
    },
    __EVERYTHING_API_ORIGIN__: `http://127.0.0.1:${port}`,
    __EVERYTHING_APP_NAME__: app,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const fn = new Function('globalThis', 'window', 'document', 'location', 'localStorage', 'sessionStorage', 'RTCPeerConnection', 'MediaStream', sdkCode);
  fn(sandbox, sandbox, sandbox.document, sandbox.location, sandbox.localStorage, sandbox.sessionStorage, sandbox.RTCPeerConnection, sandbox.MediaStream);
  if (bearer) sandbox.everything.authToken = bearer;
  return sandbox;
}

/** Plain HTTP request for first-run tests where cookies matter more than the SDK. */
async function rawRequest(port, requestPath, { method = 'GET', body, token, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* HTML or empty */ }
  return { res, status: res.status, headers: res.headers, text, data };
}

test('Platform Conformance Suite (Section 4 + Security + Peer + Workers)', async (t) => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'everything-local-test-'));
  const srv = await createPlatformServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: tmpData,
    seedUsers: Object.entries(TEST_USERS).map(([username, user]) => ({
      username,
      email: `${username}@home.local`,
      password: user.password,
      role: user.role,
      token: testToken(username),
    })),
  });
  const port = srv.port;

  t.after(async () => {
    await srv.close();
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  await t.test('1. Security: loopback binding, LAN/Tailscale Host policy, strict Origin checks', async () => {
    assert.equal(srv.server.address().address, '127.0.0.1');

    // The Host policy accepts this machine on a private network and nothing
    // that could be a public DNS-rebinding name.
    for (const host of [
      'localhost:8443', '127.0.0.1:8443', '[::1]:8443',
      '192.168.1.25:8443', '10.0.0.42', '172.20.10.2', '100.101.102.103:8443',
      'docs.localhost:8443', 'home-server.local', 'attic-pc.tail1234.ts.net',
      'fd7a:115c:a1e0::1234', '[fd7a:115c:a1e0::1234]:8443', 'fe80::1',
    ]) {
      assert.equal(isValidLocalHost(host, {}), true, `${host} is a private host`);
    }
    for (const host of ['attacker.example.com', 'mybox.example.com', '93.184.216.34', '1.1.1.1', '0.0.0.0', '']) {
      assert.equal(isValidLocalHost(host, {}), false, `${host} is not a private host`);
    }
    assert.equal(isValidLocalHost('homelab.lan', { allowedHosts: new Set(['homelab.lan']) }), true);
    assert.equal(isValidLocalHost('HOMELAB', { machineName: 'homelab' }), true);
    assert.equal(isValidLocalHost('homelab.local', { machineName: 'homelab' }), true);

    const policy = { allowedHosts: new Set(['media.lan']), machineName: 'homelab' };
    assert.equal(isValidLocalOrigin('http://192.168.1.25:8443', '192.168.1.25:8443', policy), true);
    assert.equal(isValidLocalOrigin('https://attic-pc.tail1234.ts.net', 'attic-pc.tail1234.ts.net', policy), true);
    assert.equal(isValidLocalOrigin('http://192.168.1.25:8443', '192.168.1.25:8443', policy), true);
    assert.equal(isValidLocalOrigin('http://notes.localhost:8443', '127.0.0.1:8443', policy), false, 'cross-origin app page');
    assert.equal(isValidLocalOrigin('https://evil.example', '127.0.0.1:8443', policy), false);
    assert.equal(isValidLocalOrigin('null', '127.0.0.1:8443', policy), false, 'opaque origin');

    const statusForHost = (host) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/status', method: 'GET', headers: { Host: host } }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });

    // Public names are rejected at HTTP level too.
    assert.equal(await statusForHost('attacker.example.com'), 403);
    assert.equal(await statusForHost('93.184.216.34'), 403);
    for (const host of ['192.168.1.25', '100.101.102.103', 'home-server.local', 'attic-pc.tail1234.ts.net', 'docs.localhost']) {
      assert.equal(await statusForHost(`${host}:${port}`), 200, `${host} is served`);
    }

    const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(sameOrigin.status, 200);
    const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
      headers: { Origin: `http://notes.localhost:${port}` },
    });
    assert.equal(crossOrigin.status, 403);
    const badOrigin = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(badOrigin.status, 403);
  });

  await t.test('1b. A client that aborts mid-request does not crash the server', async () => {
    await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'POST /api/auth/signin HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 200\r\n\r\n' +
          '{"username":"carol","password":"'
        );
        setTimeout(() => { socket.destroy(); resolve(); }, 25);
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
    assert.equal(after.status, 200, 'the server still answers after an aborted upload');
  });

  await t.test('2. everything.auth (password sign-in, sign-out, session identity + redirect for missing password)', async () => {
    const client = createSdkClient(port, { app: 'chess', user: null });
    const { everything } = client;

    assert.equal(await everything.auth.isSignedIn(), false);
    assert.equal(await everything.auth.getUser(), null);
    await assert.rejects(() => everything.auth.whoami(), (err) => err.status === 401);

    await assert.rejects(
      () => everything.auth.signIn({ username: 'carol', password: 'not-the-password' }),
      (err) => err.status === 401 && err.code === 'invalid_credentials'
    );

    const signedIn = await everything.auth.signIn({ username: 'carol', password: TEST_USERS.carol.password });
    assert.equal(signedIn.username, 'carol');
    assert.equal(signedIn.role, 'member');
    assert.equal(everything.authToken, signedIn.token);
    assert.equal(await everything.auth.isSignedIn(), true);
    assert.equal((await everything.auth.getUser()).username, 'carol');
    assert.equal((await everything.auth.whoami()).username, 'carol');

    const pic = await everything.auth.getProfilePicture();
    assert.ok(pic.startsWith('data:image/svg+xml'));

    await everything.auth.signOut();
    assert.equal(await everything.auth.isSignedIn(), false);
    assert.equal(await everything.auth.getUser(), null);
    assert.equal(everything.authToken, null);

    // Without a password an app sends the browser to the sign-in page.
    client.location.href = '';
    void everything.auth.signIn({ username: 'carol' });
    assert.ok(String(client.location.href).startsWith('/login?next='));
  });

  await t.test('2b. Account roles gate settings, server details and app pages', async () => {
    const users = await api(port, '/auth/users');
    const names = users.map((user) => user.username);
    for (const name of ['alice', 'bob', 'carol']) assert.ok(names.includes(name), `${name} is listed`);
    assert.ok(!names.includes('local'), 'the bundled worker account is not a person');

    await assert.rejects(
      () => api(port, '/auth/users', { user: 'bob' }),
      (err) => err.status === 403 && err.code === 'admin_required'
    );
    await assert.rejects(() => api(port, '/ai/providers', { user: 'bob' }), (err) => err.status === 403);
    await assert.rejects(() => api(port, '/server/info', { user: 'bob' }), (err) => err.status === 403);

    const info = await api(port, '/server/info');
    assert.equal(info.host, '127.0.0.1');
    assert.equal(info.port, port);
    assert.equal(info.secure, false);
    assert.ok(info.urls.some((url) => url.includes('localhost')), 'loopback URL is advertised');
    assert.ok(!info.urls.some((url) => url.includes('0.0.0.0')), 'the wildcard bind is not shown as a destination');
    assert.equal(info.urls.length, 1, 'a loopback bind advertises only the loopback URL');

    const adminCookie = `everything_auth_token=${encodeURIComponent(testToken('alice'))}`;
    const memberCookie = `everything_auth_token=${encodeURIComponent(testToken('bob'))}`;

    const settings = await fetch(`http://127.0.0.1:${port}/settings`, { headers: { Cookie: adminCookie } });
    assert.equal(settings.status, 200);
    const settingsHtml = await settings.text();
    for (const section of ['People', 'Assistant', 'AI providers', 'Server access', 'Your account']) {
      assert.ok(settingsHtml.includes(section), `the settings page includes ${section}`);
    }

    const memberSettings = await fetch(`http://127.0.0.1:${port}/settings`, { headers: { Cookie: memberCookie } });
    assert.equal(memberSettings.status, 403);

    const signedOutSettings = await fetch(`http://127.0.0.1:${port}/settings`, { redirect: 'manual' });
    assert.equal(signedOutSettings.status, 302);
    assert.match(signedOutSettings.headers.get('location'), /^\/login\?next=/);

    const signedOutApp = await fetch(`http://127.0.0.1:${port}/app/notes/`, { redirect: 'manual' });
    assert.equal(signedOutApp.status, 302);
    assert.match(signedOutApp.headers.get('location'), /^\/login\?next=/);

    const authedApp = await fetch(`http://127.0.0.1:${port}/app/notes/`, { headers: { Cookie: adminCookie } });
    assert.equal(authedApp.status, 200);

    // A missing asset is a real 404, not the app's HTML shell: returning HTML
    // here makes a broken script fail with a misleading MIME error.
    const missingAsset = await fetch(`http://127.0.0.1:${port}/app/notes/assets/does-not-exist.js`, { headers: { Cookie: adminCookie } });
    assert.equal(missingAsset.status, 404);
    assert.match(missingAsset.headers.get('content-type') || '', /^text\/plain/);

    const loginPage = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(loginPage.status, 200);
    assert.ok((await loginPage.text()).includes('Sign in'));

    const signedOutApi = await fetch(`http://127.0.0.1:${port}/api/auth/whoami`);
    assert.equal(signedOutApi.status, 401);
  });

  await t.test('3. everything.fs (write, read, delete, readdir, stat, rename, mkdir, getReadURL, revokeReadURL, space, share, unshare, listShared, getShares)', async () => {
    const alice = createSdkClient(port, { app: 'notes', user: 'alice' }).everything;
    const bob = createSdkClient(port, { app: 'notes', user: 'bob' }).everything;

    // Verify removed methods are absent
    assert.equal(alice.fs.copy, undefined);
    assert.equal(alice.fs.move, undefined);

    await alice.fs.mkdir('folder1');
    const written = await alice.fs.write('folder1/hello.txt', 'Hello local world!');
    assert.equal(written.name, 'hello.txt');
    assert.equal(written.is_dir, false);

    const blob = await alice.fs.read('folder1/hello.txt');
    assert.equal(await blob.text(), 'Hello local world!');

    const sliceBlob = await alice.fs.read('folder1/hello.txt', { offset: 6, byte_count: 5 });
    assert.equal(await sliceBlob.text(), 'local');

    const st = await alice.fs.stat('folder1/hello.txt');
    assert.equal(st.size, 18);

    const dirList = await alice.fs.readdir('folder1');
    assert.equal(dirList.length, 1);
    assert.equal(dirList[0].name, 'hello.txt');

    const renamed = await alice.fs.rename('folder1/hello.txt', 'greet.txt');
    assert.equal(renamed.name, 'greet.txt');

    const sp = await alice.fs.space();
    assert.ok(sp.used >= 18 && sp.total > 0);

    const readUrl = await alice.fs.getReadURL('folder1/greet.txt');
    const r1 = await fetch(readUrl);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), 'Hello local world!');

    await alice.fs.revokeReadURL(readUrl);
    const r2 = await fetch(readUrl);
    assert.equal(r2.status, 404);

    // Multi-user sharing
    await alice.fs.share('folder1/greet.txt', 'bob', { mode: 'edit' });
    const shares = await alice.fs.getShares('folder1/greet.txt');
    assert.equal(shares.people.length, 1);
    assert.equal(shares.people[0].username, 'bob');

    const bobIncoming = await bob.fs.listShared();
    assert.ok(bobIncoming.some((s) => s.path.endsWith('/folder1/greet.txt')));

    const bobRead = await bob.fs.read('folder1/greet.txt');
    assert.equal(await bobRead.text(), 'Hello local world!');

    await alice.fs.unshare('folder1/greet.txt', 'bob');
    assert.equal((await alice.fs.getShares('folder1/greet.txt')).people.length, 0);

    await alice.fs.delete('folder1/greet.txt');
    await assert.rejects(() => alice.fs.stat('folder1/greet.txt'), (err) => err.status === 404);
  });

  await t.test('4. everything.kv (set, get, del, list, update, add, incr, MAX) + events.onLocal', async () => {
    const { everything } = createSdkClient(port, { app: 'notes' });

    assert.equal(everything.kv.MAX, 399 * 1024);
    assert.equal(everything.kv.decr, undefined);
    assert.equal(everything.kv.expireAt, undefined);
    assert.equal(everything.kv.flush, undefined);

    const eventsReceived = [];
    const handle = await everything.events.onLocal('note:', (ev) => eventsReceived.push(ev.event), { includeValue: true });

    await everything.kv.set('note:1', { title: 'First' });
    assert.deepEqual(await everything.kv.get('note:1'), { title: 'First' });

    const updated = await everything.kv.update('note:1', { '["title"]': 'Updated', 'meta.pinned': true });
    assert.deepEqual(updated, { title: 'Updated', meta: { pinned: true } });

    assert.equal(await everything.kv.incr('counter', 5), 5);
    assert.equal(await everything.kv.incr('counter'), 6);

    const arr1 = await everything.kv.add('items', ['a']);
    assert.deepEqual(arr1, ['a']);
    const arr2 = await everything.kv.add('items', ['b']);
    assert.deepEqual(arr2, ['a', 'b']);

    // Path-map forms used by the worker apps (teamchat counters and lists).
    await everything.kv.set('doc', { counters: { a: 1 }, tags: { list: ['x'] } });
    const doc1 = await everything.kv.incr('doc', { 'counters.a': 2, 'counters.b': 1 });
    assert.equal(doc1.counters.a, 3);
    assert.equal(doc1.counters.b, 1);
    const doc2 = await everything.kv.add('doc', { 'tags.list': ['y'] });
    assert.deepEqual(doc2.tags.list, ['x', 'y']);

    const keys = await everything.kv.list('note:*');
    assert.deepEqual(keys, ['note:1']);
    const pairs = await everything.kv.list('note:*', true);
    assert.equal(pairs[0].key, 'note:1');

    // Async iterator stream
    const streamed = [];
    for await (const page of everything.kv.list({ pattern: 'note:*', stream: true, returnValues: true })) {
      streamed.push(...page.items);
    }
    assert.equal(streamed.length, 1);

    await everything.kv.del('note:1');
    assert.equal(await everything.kv.get('note:1'), null);

    await new Promise((r) => setTimeout(r, 50));
    await handle.off();
    assert.ok(eventsReceived.length >= 1);
  });

  await t.test('5. everything.workers (create, exec, get, list, delete + pooled worker_threads + terminate on timeout)', async () => {
    const alice = createSdkClient(port, { app: 'teamchat', user: 'alice' }).everything;
    const bob = createSdkClient(port, { app: 'teamchat', user: 'bob' }).everything;

    const workerCode = `
      router.get('/health', async (ctx) => ({
        ok: true,
        owner: (await me.everything.auth.getUser()).username,
        caller: ctx.user ? (await ctx.user.everything.auth.getUser()).username : null,
      }));
      router.post('/messages', async (ctx) => {
        const body = await ctx.request.json();
        const who = await ctx.user.everything.auth.getUser();
        const list = await me.everything.kv.add('msgs', [{ from: who.username, text: body.text }]);
        await me.everything.email.sendTransactional({ to: 'team@localhost', subject: 'New msg', text: body.text });
        return new Response(JSON.stringify({ ok: true, count: list.length }), { status: 201, headers: { 'content-type': 'application/json' } });
      });
      router.post('/paths', async () => {
        await me.everything.kv.set('paths-doc', { counters: { a: 1 }, tags: { list: ['x'] }, members: { u1: { role: 'guest' } } });
        const inc = await me.everything.kv.incr('paths-doc', { 'counters.a': 2, 'counters.b': 1 });
        const added = await me.everything.kv.add('paths-doc', { 'tags.list': ['y'] });
        const removed = await me.everything.kv.remove('paths-doc', 'members.u1', 'counters.b');
        return { inc, added, removed };
      });
      router.get('/hang', async () => {
        while (true) {}
      });
    `;
    await alice.fs.write('chat-worker.js', workerCode);
    const created = await alice.workers.create('teamchat-test', 'chat-worker.js');
    assert.equal(created.name, 'teamchat-test');

    const got = await alice.workers.get('teamchat-test');
    assert.equal(got.name, 'teamchat-test');
    assert.ok((await alice.workers.list()).some((w) => w.name === 'teamchat-test'));

    // First exec spawns pooled thread #1
    const res1 = await bob.workers.exec('teamchat-test', { path: '/health', method: 'GET' });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.deepEqual(data1, { ok: true, owner: 'alice', caller: 'bob' });
    const stats1 = srv.ctx.workers.getPoolStats('teamchat-test');
    assert.equal(stats1.spawnCount, 1);

    // Second exec reuses the exact same pooled thread
    const res2 = await bob.workers.exec('teamchat-test', {
      path: '/messages',
      method: 'POST',
      body: { text: 'Hello from Bob' },
    });
    assert.equal(res2.status, 201);
    assert.deepEqual(await res2.json(), { ok: true, count: 1 });
    const stats2 = srv.ctx.workers.getPoolStats('teamchat-test');
    assert.equal(stats2.threadId, stats1.threadId);
    assert.equal(stats2.spawnCount, 1);

    // Worker-side path maps and path removal, the shape teamchat relies on.
    const resPaths = await bob.workers.exec('teamchat-test', { path: '/paths', method: 'POST' });
    assert.equal(resPaths.status, 200);
    const paths = await resPaths.json();
    assert.equal(paths.inc.counters.a, 3);
    assert.equal(paths.inc.counters.b, 1);
    assert.deepEqual(paths.added.tags.list, ['x', 'y']);
    assert.equal(paths.removed.counters.b, undefined);
    assert.equal(paths.removed.members.u1, undefined);
    assert.deepEqual(paths.removed.tags.list, ['x', 'y']);

    // Timeout test: synchronous infinite loop is terminated and thread respawns on next request
    const hangRes = await bob.workers.exec('teamchat-test', { path: '/hang', method: 'GET', timeoutMs: 250 });
    assert.equal(hangRes.status, 504);
    const hangData = await hangRes.json();
    assert.equal(hangData.code, 'worker_timeout');

    const resAfterTimeout = await bob.workers.exec('teamchat-test', { path: '/health', method: 'GET' });
    assert.equal(resAfterTimeout.status, 200);
    const stats3 = srv.ctx.workers.getPoolStats('teamchat-test');
    assert.notEqual(stats3.threadId, stats1.threadId);

    await alice.workers.delete('teamchat-test');
    assert.equal(await alice.workers.get('teamchat-test'), null);
  });

  await t.test('6. everything.email (send, sendTransactional, list)', async () => {
    const { everything } = createSdkClient(port, { app: 'spreadsheet' });
    const sent1 = await everything.email.send({ to: 'ana@example.com', subject: 'Sheet', text: 'Body 1' });
    assert.equal(sent1.ok, true);
    const sent2 = await everything.email.sendTransactional({ to: ['ben@example.com'], subject: 'Invite', html: '<p>Hi</p>' });
    assert.equal(sent2.ok, true);
    const inbox = await everything.email.list();
    assert.ok(inbox.length >= 2);
  });

  await t.test('7. everything.hosting (create, delete) + Hosted-site Origin/Host signIn block', async () => {
    const { everything } = createSdkClient(port, { app: 'wiki' });
    await everything.fs.write('/site-out/index.html', '<h1>Published Local Site</h1>');
    const site = await everything.hosting.create('my-wiki-site', '/site-out');
    assert.equal(site.subdomain, 'my-wiki-site');

    // Serving hosted site works
    const html = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: `my-wiki-site.localhost:${port}` } }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(html.status, 200);
    assert.equal(html.body, '<h1>Published Local Site</h1>');

    // Sign-in from a hosted-site subdomain is blocked (403), even with valid credentials.
    const hostedSignIn = await fetch(`http://127.0.0.1:${port}/api/auth/signin`, {
      method: 'POST',
      headers: {
        Origin: `http://my-wiki-site.localhost:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'carol', password: TEST_USERS.carol.password }),
    });
    assert.equal(hostedSignIn.status, 403);

    await everything.hosting.delete('my-wiki-site');
  });

  await t.test('8. everything.perms & everything.ui (all methods)', async () => {
    const client = createSdkClient(port, { app: 'documents' });
    const { everything } = client;

    assert.equal(await everything.perms.check('folder'), true);
    assert.ok(await everything.perms.request('folder'));
    assert.deepEqual(await everything.ui.requestPermission('ai'), { granted: true });

    const savedItem = await everything.ui.showSaveFilePicker('Doc content', 'doc.txt');
    assert.equal(savedItem.name, 'doc.txt');
    const openedItem = await everything.ui.showOpenFilePicker({ path: savedItem.path });
    assert.equal(await openedItem.text(), 'Doc content');
    const dirItem = await everything.ui.showDirectoryPicker({ path: '/' });
    assert.equal(dirItem.is_dir, true);

    assert.equal(await everything.ui.alert('Saved!', [{ label: 'Great', value: 'ok' }]), 'ok');
    everything.ui.setWindowTitle('My Document');
    assert.equal(client.document.title, 'My Document');
    assert.equal(await everything.ui.showWindow(), null);
    assert.equal(everything.ui.hideWindow(), undefined);
    assert.equal(everything.ui.contextMenu([]), undefined);
    assert.equal(everything.ui.parentApp(), null);
    assert.ok(await everything.ui.requestPictureInPicture());
    assert.equal(await everything.ui.exitPictureInPicture(), null);
    assert.equal(everything.env, 'app');
    assert.equal(await everything.exit(), undefined);
  });

  await t.test('9. everything.ai (provider config, chat + streaming, image/speech/OCR, graceful degradation)', async () => {
    // One mock that speaks all three wire protocols the adapters support.
    const seen = { auth: [], paths: [], lastTools: null, lastModel: null, lastImageRequest: null };
    const testTools = [{
      type: 'function',
      function: {
        name: 'read_page',
        description: 'Read the current page.',
        parameters: { type: 'object', properties: { target: { type: 'string', description: 'Where to look.' } } },
      },
    }];
    const messyTools = [
      ...testTools,
      { type: 'function', function: { name: 'not a valid name!', description: 'dropped', parameters: { type: 'object' } } },
    ];
    const mockAi = http.createServer(async (req, res) => {
      seen.paths.push(req.url);
      seen.auth.push(req.headers.authorization || req.headers['x-api-key'] || '');
      const send = (code, obj, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };

      if (req.url === '/api/tags') return send(200, { models: [{ name: 'local-llama' }] });
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'remote-model' }, { id: 'vendor/claude-opus-5.5' }] });
      if (req.url === '/v1/images/models') {
        return send(200, {
          data: [
            { id: 'google/gemini-3.1-flash-image', name: 'Google: Gemini 3.1 Flash Image' },
            { id: 'openai/gpt-image-2', name: 'OpenAI: GPT Image 2' },
          ],
        });
      }

      let body = '';
      for await (const c of req) body += c;

      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        seen.lastModel = parsed.model;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const last = messages[messages.length - 1] || {};
        const lastText = typeof last.content === 'string' ? last.content : '';
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        const toolMessage = [...messages].reverse().find((m) => m.role === 'tool');
        if (hasTools) seen.lastTools = parsed.tools;

        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (hasTools && /stream tool/i.test(lastText)) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream_1', type: 'function', function: { name: 'read_page', arguments: '' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"target":"main"}' } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        // Vision requests carry image parts; echo back what we saw.
        const parts = messages[0]?.content;
        if (Array.isArray(parts)) {
          const hasImage = parts.some((p) => p.type === 'image_url' && String(p.image_url.url).startsWith('data:image/'));
          return send(200, { choices: [{ message: { role: 'assistant', content: hasImage ? 'OCR TEXT' : 'no image' } }] });
        }
        if (hasTools && toolMessage) {
          return send(200, {
            choices: [{ message: { role: 'assistant', content: 'Tool result: ' + toolMessage.content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          });
        }
        if (hasTools && /use the tool/i.test(lastText)) {
          return send(200, {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_tool_1', type: 'function', function: { name: 'read_page', arguments: '{"target":"main"}' } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          });
        }
        return send(200, { choices: [{ message: { role: 'assistant', content: 'Remote reply' }, finish_reason: 'stop' }] });
      }
      if (req.url === '/v1/images/generations') {
        return send(200, { data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] });
      }
      if (req.url === '/v1/images') {
        seen.lastImageRequest = JSON.parse(body);
        return send(200, {
          data: [{ b64_json: Buffer.from('WEBPDATA').toString('base64'), media_type: 'image/webp' }],
          usage: { cost: 0.02 },
        });
      }
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        return res.end(Buffer.from('MP3DATA'));
      }
      if (req.url === '/v1/audio/transcriptions') {
        return send(200, { text: 'transcribed words' });
      }
      if (req.url === '/v1/messages') {
        const parsed = JSON.parse(body);
        seen.lastModel = parsed.model;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
        const toolResult = blocks.find((b) => b?.type === 'tool_result');
        const last = messages[messages.length - 1] || {};
        const lastText = Array.isArray(last.content)
          ? last.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
          : String(last.content || '');
        if (hasTools) seen.lastTools = parsed.tools;

        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (hasTools && /stream tool/i.test(lastText)) {
            res.write('data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_stream_1', name: 'read_page', input: {} } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"target":"main"}' } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic ' } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } }) + '\n\n');
            res.write('data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + '\n\n');
          }
          return res.end();
        }

        if (hasTools && toolResult) {
          return send(200, {
            content: [{ type: 'text', text: 'Anthropic tool result: ' + toolResult.content }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 9, output_tokens: 4 },
          });
        }
        if (hasTools && /use the tool/i.test(lastText)) {
          return send(200, {
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { target: 'main' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 2 },
          });
        }
        return send(200, { content: [{ type: 'text', text: 'Anthropic reply' }], stop_reason: 'end_turn' });
      }
      if (req.url === '/api/chat') {
        const parsed = JSON.parse(body);
        seen.lastModel = parsed.model;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        const toolMessage = [...messages].reverse().find((m) => m.role === 'tool');
        const last = messages[messages.length - 1] || {};
        const lastText = typeof last.content === 'string' ? last.content : '';
        if (hasTools) seen.lastTools = parsed.tools;

        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          if (hasTools && /stream tool/i.test(lastText)) {
            res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_page', arguments: { target: 'main' } } }] } }) + '\n');
            res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 6, eval_count: 3 }) + '\n');
          } else {
            res.write(JSON.stringify({ message: { content: 'Ollama ' } }) + '\n');
            res.write(JSON.stringify({ message: { content: 'native' }, done: true }) + '\n');
          }
          return res.end();
        }

        if (hasTools && toolMessage) {
          return send(200, { message: { role: 'assistant', content: 'Ollama tool result: ' + toolMessage.content }, done: true, prompt_eval_count: 4, eval_count: 2 });
        }
        if (hasTools && /use the tool/i.test(lastText)) {
          return send(200, {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_page', arguments: { target: 'main' } } }] },
            done: true,
          });
        }
        return send(200, { message: { role: 'assistant', content: 'Ollama reply' } });
      }
      return send(404, { error: 'not found' });
    });
    await new Promise((r) => mockAi.listen(0, '127.0.0.1', r));
    const aiBase = `http://127.0.0.1:${mockAi.address().port}`;

    const { everything } = createSdkClient(port, { app: 'video-studio' });

    // Nothing configured: every capability fails cleanly. There is no implicit
    // provider, because keys and endpoints only come from the settings page.
    assert.deepEqual(await everything.ai.listModels(), []);
    for (const method of ['chat', 'txt2img', 'txt2vid', 'speech2txt', 'txt2speech', 'img2txt']) {
      await assert.rejects(() => everything.ai[method]('test'), (err) => err.code === 'local_ai_unavailable');
    }

    // A saved Ollama provider serves chat and its model catalogue.
    const ollama = await api(port, '/ai/providers', {
      method: 'POST',
      body: { name: 'Mock Ollama', kind: 'ollama', base_url: aiBase, default_model: 'local-llama', capabilities: ['chat'] },
    });
    assert.ok(ollama.id);
    const localModels = await everything.ai.listModels();
    assert.equal(localModels[0].id, 'local-llama');
    assert.equal(localModels[0].default, true, 'the configured default is offered even without a live catalogue');
    assert.deepEqual(await api(port, '/ai/models?capability=txt2speech'), [], 'a chat-only provider is not offered for speech');
    assert.equal(String(await everything.ai.chat('Say hi')), 'Ollama reply');
    assert.equal(seen.lastModel, 'local-llama');

    // Ollama accepts OpenAI-shaped tool schemas and returns OpenAI-shaped tool calls.
    const ollamaTool = await everything.ai.chat('Use the tool', { tools: messyTools });
    assert.equal(ollamaTool.message.content, null);
    assert.equal(seen.lastTools.length, 1, 'a malformed tool schema is dropped');
    const ollamaCall = ollamaTool.message.tool_calls[0];
    assert.equal(ollamaCall.function.name, 'read_page');
    assert.equal(ollamaCall.function.arguments, '{"target":"main"}');
    assert.ok(ollamaCall.id.startsWith('call_'), 'a missing provider id gets one');
    const ollamaFollow = await everything.ai.chat([
      { role: 'user', content: 'Use the tool' },
      { role: 'assistant', content: null, tool_calls: [ollamaCall] },
      { role: 'tool', tool_call_id: ollamaCall.id, name: 'read_page', content: 'Page body' },
    ], { tools: testTools });
    assert.equal(String(ollamaFollow), 'Ollama tool result: Page body');

    const ollamaToolStream = await everything.ai.chat('Stream tool', { stream: true, tools: testTools });
    const ollamaEvents = [];
    for await (const event of ollamaToolStream) ollamaEvents.push(event);
    const ollamaUse = ollamaEvents.find((event) => event.type === 'tool_use');
    assert.equal(ollamaUse.name, 'read_page');
    assert.deepEqual(ollamaUse.input, { target: 'main' });
    assert.equal(ollamaEvents.find((event) => event.type === 'done').message.tool_calls[0].function.name, 'read_page');

    // App origins cannot rewrite provider records or keys.
    await assert.rejects(
      () => api(port, '/ai/providers', { method: 'POST', origin: 'http://notes.localhost:8443', body: { name: 'Nope', kind: 'ollama', base_url: aiBase } }),
      (err) => err.status === 403
    );

    // A configured OpenAI-compatible provider serves every capability.
    const saved = await api(port, '/ai/providers', {
      method: 'POST',
      body: { name: 'Mock OpenAI', kind: 'openai', base_url: `${aiBase}/v1`, api_key: 'sk-test', default_model: 'remote-model' },
    });
    assert.ok(saved.id);
    assert.equal(saved.has_key, true);
    assert.equal(saved.api_key, undefined, 'the key must never be sent back to the browser');

    // The model list offers live and saved ids, marks the provider default, and
    // filters by capability.
    const allModels = await everything.ai.listModels();
    assert.ok(allModels.some((m) => m.id === 'remote-model' && m.default === true));
    assert.ok(allModels.some((m) => m.id === 'vendor/claude-opus-5.5'));
    const chatModels = await api(port, '/ai/models?capability=chat');
    assert.equal(chatModels.length, allModels.length);

    const listed = await api(port, '/ai/providers');
    assert.equal(listed.length, 2);
    assert.equal(listed[0].api_key, undefined);

    await api(port, '/ai/routes', { method: 'POST', body: { routes: { chat: saved.id } } });
    assert.equal(String(await everything.ai.chat('Say hi')), 'Remote reply');
    assert.equal(seen.lastModel, 'remote-model');
    assert.ok(seen.auth.includes('Bearer sk-test'), 'the provider key must be sent upstream');

    // A saved default with a different spelling than the live catalogue is
    // mapped to the provider's own id, vendor prefix and punctuation included.
    await api(port, '/ai/providers', {
      method: 'POST',
      body: { id: saved.id, name: 'Mock OpenAI', kind: 'openai', base_url: `${aiBase}/v1`, default_model: 'claude-opus-5-5' },
    });
    assert.equal(String(await everything.ai.chat('Say hi')), 'Remote reply');
    assert.equal(seen.lastModel, 'vendor/claude-opus-5.5', 'the configured default is mapped to the live model id');

    // An app that sends no model gets the Assistant model override first.
    await api(port, '/ai/assistant', { method: 'POST', body: { model: 'remote-model' } });
    assert.equal(String(await everything.ai.chat('Say hi')), 'Remote reply');
    assert.equal(seen.lastModel, 'remote-model', 'the Assistant model override wins when an app sends none');
    assert.equal(String(await everything.ai.chat('Say hi', { model: 'vendor/claude-opus-5.5' })), 'Remote reply');
    assert.equal(seen.lastModel, 'vendor/claude-opus-5.5', 'an app-chosen model still wins over the override');
    await api(port, '/ai/assistant', { method: 'POST', body: { model: '' } });

    const stream = await everything.ai.chat('Stream hi', { stream: true });
    let collected = '';
    for await (const chunk of stream) {
      if (chunk.text) collected += chunk.text;
    }
    assert.equal(collected, 'Hello world');

    // OpenAI tool calls: non-streaming, a tool-result follow-up, and streaming deltas.
    const openAiTool = await everything.ai.chat('Use the tool', { tools: messyTools });
    assert.equal(seen.lastTools.length, 1, 'the OpenAI request only receives valid tool schemas');
    assert.equal(openAiTool.message.content, null);
    const openAiCall = openAiTool.message.tool_calls[0];
    assert.equal(openAiCall.id, 'call_tool_1');
    assert.equal(openAiCall.function.name, 'read_page');
    assert.equal(openAiCall.function.arguments, '{"target":"main"}');
    assert.equal(openAiTool.finish_reason, 'tool_calls');
    const openAiFollow = await everything.ai.chat([
      { role: 'user', content: 'Use the tool' },
      { role: 'assistant', content: null, tool_calls: [openAiCall] },
      { role: 'tool', tool_call_id: openAiCall.id, name: 'read_page', content: 'Page body' },
    ], { tools: testTools });
    assert.equal(String(openAiFollow), 'Tool result: Page body');

    const openAiToolStream = await everything.ai.chat('Stream tool', { stream: true, tools: testTools });
    const openAiEvents = [];
    for await (const event of openAiToolStream) openAiEvents.push(event);
    const openAiUse = openAiEvents.find((event) => event.type === 'tool_use');
    assert.equal(openAiUse.id, 'call_stream_1');
    assert.equal(openAiUse.name, 'read_page');
    assert.deepEqual(openAiUse.input, { target: 'main' });
    assert.equal(openAiEvents.find((event) => event.type === 'done').message.tool_calls[0].function.arguments, '{"target":"main"}');

    const img = await everything.ai.txt2img('a cat');
    assert.ok(String(img.src).startsWith('data:image/png;base64,'), 'txt2img resolves an image with a data URL src');

    // OpenRouter has a dedicated Image API and image-model catalogue. An
    // Automatic request must choose an image model, never the chat default.
    const openrouter = await api(port, '/ai/providers', {
      method: 'POST',
      body: {
        name: 'Mock OpenRouter',
        kind: 'openai',
        preset: 'openrouter',
        base_url: `${aiBase}/v1`,
        api_key: 'or-test',
        default_model: 'remote-model',
        capabilities: ['chat', 'txt2img', 'img2txt'],
      },
    });
    assert.equal(openrouter.preset, 'openrouter', 'the preset is stored so the adapter keeps its image API');
    await api(port, '/ai/routes', { method: 'POST', body: { routes: { txt2img: openrouter.id } } });

    const openRouterImageModels = await api(port, '/ai/models?capability=txt2img');
    assert.deepEqual(
      openRouterImageModels.filter((m) => m.provider_id === openrouter.id).map((m) => m.id),
      ['google/gemini-3.1-flash-image', 'openai/gpt-image-2'],
      'the image catalogue is offered without the chat default'
    );

    seen.lastImageRequest = null;
    const openRouterImage = await everything.ai.txt2img('a blue dog', { ratio: { w: 1600, h: 900 }, quality: 'high' });
    assert.ok(String(openRouterImage.src).startsWith('data:image/webp;base64,'), 'the response media_type is preserved');
    assert.equal(seen.lastImageRequest.model, 'google/gemini-3.1-flash-image', 'Automatic resolves an image model');
    assert.equal(seen.lastImageRequest.aspect_ratio, '16:9', 'pixel dimensions become an aspect ratio');
    assert.equal(seen.lastImageRequest.quality, 'high');
    assert.equal(seen.lastImageRequest.prompt, 'a blue dog');
    assert.ok(seen.auth.includes('Bearer or-test'), 'the OpenRouter key is sent upstream');

    const openRouterExplicit = await everything.ai.txt2img('a blue dog', { model: 'gpt-image-2', ratio: { w: 1024, h: 1024 } });
    assert.equal(seen.lastImageRequest.model, 'openai/gpt-image-2', 'an app image model is mapped to the provider spelling');
    assert.equal(seen.lastImageRequest.aspect_ratio, '1:1');
    assert.ok(String(openRouterExplicit.src).startsWith('data:image/webp;base64,'));

    await everything.ai.txt2img('make it watercolour', {
      model: 'gemini-3.1-flash-image',
      quality: '2K',
      input_image: 'data:image/png;base64,AAAA',
    });
    assert.equal(seen.lastImageRequest.model, 'google/gemini-3.1-flash-image');
    assert.equal(seen.lastImageRequest.resolution, '2K', 'Gemini quality tiers become an image resolution');
    assert.deepEqual(seen.lastImageRequest.input_references, [{
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    }]);
    await api(port, '/ai/providers/delete', { method: 'POST', body: { id: openrouter.id } });

    const speech = await everything.ai.txt2speech('hello there', { voice: 'alloy' });
    assert.ok(String(speech.src).startsWith('data:audio/mpeg;base64,'), 'txt2speech resolves audio with a data URL src');

    const transcript = await everything.ai.speech2txt(new Blob([Buffer.from('RIFF')], { type: 'audio/wav' }));
    assert.equal(transcript.text, 'transcribed words', 'a Blob must reach the provider, not serialize to {}');

    const ocr = await everything.ai.img2txt(new Blob([Buffer.from('PNG')], { type: 'image/png' }));
    assert.equal(ocr, 'OCR TEXT', 'a Blob image must reach the vision provider');

    // Anthropic protocol.
    const anthropic = await api(port, '/ai/providers', {
      method: 'POST',
      body: { name: 'Mock Anthropic', kind: 'anthropic', base_url: aiBase, api_key: 'ak-test', default_model: 'claude-test' },
    });
    await api(port, '/ai/routes', { method: 'POST', body: { routes: { chat: anthropic.id } } });
    assert.equal(String(await everything.ai.chat('hi')), 'Anthropic reply');
    assert.ok(seen.auth.includes('ak-test'), 'the Anthropic key goes in x-api-key');

    // Anthropic tool_use blocks and tool_result turns round-trip.
    const anthropicTool = await everything.ai.chat('Use the tool', { tools: messyTools });
    assert.equal(seen.lastTools.length, 1, 'Anthropic receives only valid tools');
    assert.equal(anthropicTool.message.content, null);
    const anthropicCall = anthropicTool.message.tool_calls[0];
    assert.equal(anthropicCall.id, 'toolu_1');
    assert.equal(anthropicCall.function.name, 'read_page');
    assert.equal(anthropicCall.function.arguments, '{"target":"main"}');
    assert.equal(anthropicTool.finish_reason, 'tool_calls');
    const anthropicFollow = await everything.ai.chat([
      { role: 'user', content: 'Use the tool' },
      { role: 'assistant', content: null, tool_calls: [anthropicCall] },
      { role: 'tool', tool_call_id: anthropicCall.id, name: 'read_page', content: 'Page body' },
    ], { tools: testTools });
    assert.equal(String(anthropicFollow), 'Anthropic tool result: Page body');

    const anthropicToolStream = await everything.ai.chat('Stream tool', { stream: true, tools: testTools });
    const anthropicEvents = [];
    for await (const event of anthropicToolStream) anthropicEvents.push(event);
    const anthropicUse = anthropicEvents.find((event) => event.type === 'tool_use');
    assert.equal(anthropicUse.id, 'toolu_stream_1');
    assert.equal(anthropicUse.name, 'read_page');
    assert.deepEqual(anthropicUse.input, { target: 'main' });
    assert.equal(anthropicEvents.find((event) => event.type === 'done').finish_reason, 'tool_calls');

    // An unreachable routed provider falls back to a healthy one, then surfaces
    // `local_ai_unavailable` once no healthy provider is left.
    await api(port, '/ai/providers', {
      method: 'POST',
      body: { id: anthropic.id, name: 'Mock Anthropic', kind: 'anthropic', base_url: 'http://127.0.0.1:1', default_model: 'claude-test' },
    });
    assert.equal(String(await everything.ai.chat('hi')), 'Ollama reply');
    await api(port, '/ai/providers/delete', { method: 'POST', body: { id: ollama.id } });
    await api(port, '/ai/providers/delete', { method: 'POST', body: { id: saved.id } });
    await assert.rejects(() => everything.ai.chat('hi'), (err) => err.code === 'local_ai_unavailable');

    // Deleting a provider clears its route.
    await api(port, '/ai/providers/delete', { method: 'POST', body: { id: anthropic.id } });
    assert.deepEqual(await api(port, '/ai/routes'), {});

    await api(port, '/ai/providers/delete', { method: 'POST', body: { id: ollama.id } });
    await api(port, '/ai/providers/delete', { method: 'POST', body: { id: saved.id } });
    assert.deepEqual(await api(port, '/ai/providers'), []);
    await new Promise((r) => mockAi.close(r));
    for (const method of ['chat', 'txt2img', 'txt2vid', 'speech2txt', 'txt2speech', 'img2txt']) {
      await assert.rejects(() => everything.ai[method]('test'), (err) => err.code === 'local_ai_unavailable');
    }
  });

  await t.test('9b. Assistant config (admin-only writes) and SDK tool registration', async () => {
    const config = await api(port, '/ai/assistant?app=documents', { user: 'bob' });
    assert.equal(config.enabled, true);
    assert.equal(config.app_enabled, true);
    assert.equal(config.configured, false, 'no provider is configured');
    assert.deepEqual(config.apps, ['documents', 'photo-studio', 'video-studio', 'whiteboard']);
    assert.deepEqual(config.native_apps, ['3d', 'parametric', 'building-design', 'spreadsheet', 'presentation']);
    assert.equal((await api(port, '/ai/assistant?app=notes', { user: 'bob' })).app_enabled, false);
    await assert.rejects(
      () => api(port, '/ai/assistant?app=notes', { user: null }),
      (err) => err.status === 401
    );

    await assert.rejects(
      () => api(port, '/ai/assistant', { method: 'POST', user: 'bob', body: { enabled: false } }),
      (err) => err.status === 403 && err.code === 'admin_required'
    );

    const saved = await api(port, '/ai/assistant', {
      method: 'POST',
      body: { enabled: false, apps: ['notes', '3d', 'not-an-app'], model: '  tiny-model  ', confirm_destructive: false },
    });
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.apps, ['notes'], 'native-assistant apps cannot be added to the shared list');
    assert.equal(saved.model, 'tiny-model');
    assert.equal(saved.confirm_destructive, false);
    assert.ok(saved.native_apps.includes('3d'));
    assert.equal((await api(port, '/ai/assistant?app=notes', { user: 'bob' })).app_enabled, true);

    const restored = await api(port, '/ai/assistant', {
      method: 'POST',
      body: { enabled: true, apps: ['documents', 'photo-studio', 'video-studio', 'whiteboard'], model: '', confirm_destructive: true },
    });
    assert.equal(restored.enabled, true);
    assert.equal(restored.confirm_destructive, true);

    const sdk = createSdkClient(port, { app: 'notes', user: 'bob' });
    const assistant = sdk.everything.assistant;
    assert.deepEqual(assistant.nativeApps, ['3d', 'parametric', 'building-design', 'spreadsheet', 'presentation']);
    assert.equal(typeof assistant.registerTool, 'function');
    let handlerCalls = 0;
    const removeFirst = assistant.registerTool({
      function: {
        name: 'notes_create',
        description: 'Create a note.',
        parameters: { type: 'object', properties: { title: { type: 'string' } } },
      },
      handler: () => { handlerCalls += 1; return { ok: true }; },
    });
    assert.equal(assistant._tools.length, 1);
    assert.equal(assistant._tools[0].function.name, 'notes_create');

    const removeSecond = assistant.registerTool({
      function: { name: 'notes_create', description: 'Replacement.' },
      handler: () => 'replaced',
    });
    assert.equal(assistant._tools.length, 1, 'registering the same name replaces it');
    assert.equal(assistant._tools[0].function.description, 'Replacement.');
    removeSecond();
    assert.equal(assistant._tools.length, 0);
    removeFirst();
    assert.equal(assistant._tools.length, 0);

    assert.throws(
      () => assistant.registerTool({ function: { name: 'not a valid name!' }, handler: () => {} }),
      /letters, numbers, underscores or dashes/
    );
    assert.throws(() => assistant.registerTool({ function: { name: 'ok_name' } }), /needs a handler/);
    assert.equal(handlerCalls, 0);
  });

  await t.test('10. everything.peer (serve, connect, ensureTurnRelays, createGuestGrant + RTCPeerConnection SDP/ICE + media tracks)', async () => {
    const hostTab = createSdkClient(port, { app: 'meetings', user: 'alice' });
    const guestTab = createSdkClient(port, { app: 'meetings', user: 'bob' });

    assert.deepEqual(await hostTab.everything.peer.ensureTurnRelays(), []);
    const grant = await hostTab.everything.peer.createGuestGrant();
    assert.ok(grant.grant.startsWith('grant-'));

    const serverHandle = await hostTab.everything.peer.serve();
    assert.ok(serverHandle.inviteCode.startsWith('inv-'));

    let hostConn = null;
    const hostConnectedPromise = new Promise((resolve) => {
      serverHandle.on('connection', ({ conn, user }) => {
        hostConn = conn;
        resolve(user);
      });
    });

    const guestConn = await guestTab.everything.peer.connect(serverHandle.inviteCode);
    const connectedUser = await hostConnectedPromise;
    assert.equal(connectedUser.username, 'bob');

    // Wait for RTCPeerConnection SDP offer/answer handshake over WebSocket
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(hostConn.peerconnection.remoteDescription);
    assert.equal(hostConn.peerconnection.remoteDescription.type, 'offer');
    assert.ok(guestConn.peerconnection.remoteDescription);
    assert.equal(guestConn.peerconnection.remoteDescription.type, 'answer');

    // Bidirectional message exchange (used by chess multiplayer)
    const msgPromise = new Promise((resolve) => {
      hostConn.on('message', (ev) => resolve(ev.data));
    });
    guestConn.send({ move: 'e2e4' });
    assert.deepEqual(await msgPromise, { move: 'e2e4' });

    // Live audio + video media track publication (used by meetings)
    const mediaPromise = new Promise((resolve) => {
      hostConn.on('media', (ev) => resolve(ev));
    });
    const mockStream = new guestTab.MediaStream([
      { kind: 'audio', id: 'mic-1' },
      { kind: 'video', id: 'cam-1' },
    ]);
    guestConn.publish('camera', mockStream, { video: { maxBitrate: 500000 } });
    const mediaEv = await mediaPromise;
    assert.equal(mediaEv.name, 'camera');
    assert.ok(mediaEv.track);

    const endedPromise = new Promise((resolve) => {
      hostConn.on('mediaended', (ev) => resolve(ev.name));
    });
    guestConn.unpublish('camera');
    assert.equal(await endedPromise, 'camera');

    guestConn.close();
    serverHandle.close();
  });

  await t.test('11. everything.net (fetch local guard + Socket)', async () => {
    const { everything } = createSdkClient(port, { app: 'api-client' });
    await assert.rejects(
      async () => everything.net.fetch('https://example.com/api'),
      (err) => err.code === 'external_not_allowed'
    );
    const localRes = await everything.net.fetch(`http://127.0.0.1:${port}/api/auth/whoami`, {
      headers: { Authorization: `Bearer ${testToken('alice')}` },
    });
    assert.equal(localRes.status, 200);
    assert.equal((await localRes.json()).username, 'alice');
    const anonymousRes = await everything.net.fetch(`http://127.0.0.1:${port}/api/auth/whoami`);
    assert.equal(anonymousRes.status, 401, 'the SDK never injects a default identity into net.fetch');

    // Test local TCP echo via everything.net.Socket
    const echoServer = net.createServer((sock) => sock.pipe(sock));
    await new Promise((r) => echoServer.listen(0, '127.0.0.1', r));
    const echoPort = echoServer.address().port;

    const echoed = await new Promise((resolve) => {
      const sock = everything.net.Socket('127.0.0.1', echoPort);
      sock.on('open', () => sock.write('ping-local'));
      sock.on('data', (bytes) => {
        sock.close();
        resolve(new TextDecoder().decode(bytes));
      });
    });
    assert.equal(echoed, 'ping-local');
    await new Promise((r) => echoServer.close(r));
  });
});

test('First run: setup, invites, admin protection and password recovery', async (t) => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'everything-local-setup-'));
  const srv = await createPlatformServer({ port: 0, host: '127.0.0.1', dataDir: tmpData });
  const port = srv.port;
  t.after(async () => {
    await srv.close();
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  const fresh = await rawRequest(port, '/api/auth/status');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.setup_required, true);
  assert.equal(fresh.data.signed_in, false);

  assert.equal((await rawRequest(port, '/api/apps')).status, 401);
  assert.equal((await rawRequest(port, '/api/ai/providers')).status, 401);

  const signedOutSettings = await rawRequest(port, '/settings');
  assert.equal(signedOutSettings.status, 302);
  assert.match(signedOutSettings.headers.get('location'), /^\/login\?next=/);
  const signedOutApp = await rawRequest(port, '/app/notes/');
  assert.equal(signedOutApp.status, 302);
  assert.match(signedOutApp.headers.get('location'), /^\/login\?next=/);
  const login = await rawRequest(port, '/login');
  assert.equal(login.status, 200);
  assert.ok(login.text.includes('Create the administrator'));

  const weak = await rawRequest(port, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'admin', password: 'short' },
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.code, 'weak_password');
  assert.equal((await rawRequest(port, '/api/auth/status')).data.setup_required, true);

  const setup = await rawRequest(port, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'admin', email: 'admin@home.local', password: 'admin-password' },
  });
  assert.equal(setup.status, 200);
  assert.ok(setup.data.token);
  assert.equal(setup.data.user.role, 'admin');
  const adminToken = setup.data.token;
  const setCookie = setup.headers.get('set-cookie') || '';
  assert.match(setCookie, /everything_auth_token=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const adminCookie = `everything_auth_token=${encodeURIComponent(adminToken)}`;

  const status = await rawRequest(port, '/api/auth/status', { token: adminToken });
  assert.equal(status.data.setup_required, false);
  assert.equal(status.data.signed_in, true);
  assert.equal(status.data.admin, true);
  assert.equal(status.data.user.username, 'admin');

  const secondSetup = await rawRequest(port, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'intruder', password: 'intruder-password' },
  });
  assert.equal(secondSetup.status, 403);
  assert.equal(secondSetup.data.code, 'setup_complete');

  const invite = await rawRequest(port, '/api/auth/invites', {
    method: 'POST',
    token: adminToken,
    body: { username: 'friend', email: 'friend@home.local', role: 'member' },
  });
  assert.equal(invite.status, 200);
  assert.equal(invite.data.username, 'friend');
  assert.ok(invite.data.url.includes('/join?token='));
  assert.equal(invite.data.role, 'member');
  const inviteToken = invite.data.token;

  const invites = await rawRequest(port, '/api/auth/invites', { token: adminToken });
  assert.equal(invites.status, 200);
  assert.equal(invites.data.length, 1);

  const peek = await rawRequest(port, `/api/auth/invite?token=${encodeURIComponent(inviteToken)}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.data.username, 'friend');

  const accepted = await rawRequest(port, '/api/auth/invite/accept', {
    method: 'POST',
    body: { token: inviteToken, password: 'friend-password' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.user.username, 'friend');
  assert.equal(accepted.data.user.role, 'member');
  const friendToken = accepted.data.token;
  const friendUuid = accepted.data.user.uuid;
  const friendCookie = `everything_auth_token=${encodeURIComponent(friendToken)}`;

  const reused = await rawRequest(port, '/api/auth/invite/accept', {
    method: 'POST',
    body: { token: inviteToken, password: 'another-password' },
  });
  assert.equal(reused.status, 404);
  assert.equal(reused.data.code, 'invite_invalid');

  for (const path of ['/api/auth/users', '/api/ai/providers', '/api/ai/routes', '/api/server/info']) {
    const denied = await rawRequest(port, path, { token: friendToken });
    assert.equal(denied.status, 403, `member is denied ${path}`);
    assert.equal(denied.data.code, 'admin_required');
  }
  const memberInvite = await rawRequest(port, '/api/auth/invites', {
    method: 'POST',
    token: friendToken,
    body: { username: 'sneaky' },
  });
  assert.equal(memberInvite.status, 403);
  assert.equal((await rawRequest(port, '/settings', { cookie: friendCookie })).status, 403);

  const memberApps = await rawRequest(port, '/api/apps', { token: friendToken });
  assert.equal(memberApps.status, 200);
  assert.ok(memberApps.data.some((app) => app.name === 'notes'));

  const memberPage = await rawRequest(port, '/app/notes/', { cookie: friendCookie });
  assert.equal(memberPage.status, 200);
  const adminSettings = await rawRequest(port, '/settings', { cookie: adminCookie });
  assert.equal(adminSettings.status, 200);
  assert.ok(adminSettings.text.includes('People'));
  assert.ok(adminSettings.text.includes('Assistant'));

  const people = await rawRequest(port, '/api/auth/users', { token: adminToken });
  assert.equal(people.status, 200);
  const names = people.data.map((user) => user.username);
  assert.ok(names.includes('admin'));
  assert.ok(names.includes('friend'));
  assert.ok(!names.includes('local'), 'the internal worker account cannot sign in and is not listed');

  const selfDisable = await rawRequest(port, '/api/auth/users/disable', {
    method: 'POST',
    token: adminToken,
    body: { uuid: people.data.find((user) => user.username === 'admin').uuid, disabled: true },
  });
  assert.equal(selfDisable.status, 400);
  assert.equal(selfDisable.data.code, 'invalid_request');

  // An administrator can reset a forgotten password; every old session dies.
  const reset = await rawRequest(port, '/api/auth/users/password', {
    method: 'POST',
    token: adminToken,
    body: { uuid: friendUuid, new_password: 'friend-password-2' },
  });
  assert.equal(reset.status, 200);
  assert.equal((await rawRequest(port, '/api/auth/whoami', { token: friendToken })).status, 401);

  const oldPassword = await rawRequest(port, '/api/auth/signin', {
    method: 'POST',
    body: { username: 'friend', password: 'friend-password' },
  });
  assert.equal(oldPassword.status, 401);
  assert.equal(oldPassword.data.code, 'invalid_credentials');

  const newPassword = await rawRequest(port, '/api/auth/signin', {
    method: 'POST',
    body: { username: 'friend', password: 'friend-password-2' },
  });
  assert.equal(newPassword.status, 200);
  assert.equal(newPassword.data.user.username, 'friend');
  const friendToken2 = newPassword.data.token;

  // Own password change keeps this session but invalidates the other ones.
  const changed = await rawRequest(port, '/api/auth/password', {
    method: 'POST',
    token: adminToken,
    body: { current_password: 'admin-password', new_password: 'admin-password-2' },
  });
  assert.equal(changed.status, 200);
  assert.equal((await rawRequest(port, '/api/auth/whoami', { token: adminToken })).status, 200);
  assert.equal((await rawRequest(port, '/api/auth/signin', {
    method: 'POST',
    body: { username: 'admin', password: 'admin-password' },
  })).status, 401);
  assert.equal((await rawRequest(port, '/api/auth/signin', {
    method: 'POST',
    body: { username: 'admin', password: 'admin-password-2' },
  })).status, 200);

  // Disabling an account ends its sessions and blocks future sign-ins.
  const disable = await rawRequest(port, '/api/auth/users/disable', {
    method: 'POST',
    token: adminToken,
    body: { uuid: friendUuid, disabled: true },
  });
  assert.equal(disable.status, 200);
  assert.equal(disable.data.disabled, true);
  assert.equal((await rawRequest(port, '/api/auth/whoami', { token: friendToken2 })).status, 401);
  assert.equal((await rawRequest(port, '/api/auth/signin', {
    method: 'POST',
    body: { username: 'friend', password: 'friend-password-2' },
  })).status, 401);

  const signedOut = await rawRequest(port, '/api/auth/signout', { method: 'POST', token: adminToken });
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal((await rawRequest(port, '/api/auth/whoami', { token: adminToken })).status, 401);
});

test('OpenRouter providers gain image generation once without losing their key', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initAi(db);
    // Simulate a database saved before OpenRouter image support existed.
    db.prepare('DELETE FROM ai_settings WHERE key = ?').run('migration.openrouter_images_v1');
    db.prepare(`
      INSERT INTO ai_providers
        (id, name, kind, base_url, api_key, default_model, models_json, capabilities_json, timeout_ms, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'prov-old', 'Openrouter', 'openai', 'https://openrouter.ai/api/v1/', 'sk-secret',
      'nemotron-3.5-super-vl:free', '[]', '["chat","img2txt"]', 120000, 1, Date.now(), Date.now()
    );

    initAi(db);

    const migrated = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get('prov-old');
    assert.deepEqual(JSON.parse(migrated.capabilities_json), ['chat', 'img2txt', 'txt2img']);
    assert.equal(migrated.preset, 'openrouter');
    assert.equal(migrated.api_key, 'sk-secret', 'the saved key is untouched');

    // The migration is one-time: a later deliberate capability change stands.
    db.prepare('UPDATE ai_providers SET capabilities_json = ? WHERE id = ?').run('["chat"]', 'prov-old');
    initAi(db);
    assert.deepEqual(JSON.parse(db.prepare('SELECT capabilities_json FROM ai_providers WHERE id = ?').get('prov-old').capabilities_json), ['chat']);
  } finally {
    db.close();
  }
});

test('Legacy passwordless accounts migrate without exposing the worker user', () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'everything-local-legacy-'));
  const db = new DatabaseSync(path.join(tmpData, 'everything.sqlite'));
  try {
    // The shape of the pre-accounts database: people exist, but there is no
    // password, role or session expiry yet.
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        avatar_svg TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare('INSERT INTO users (uuid, username, email, avatar_svg, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('legacy-local', 'local', 'local@local.localhost', '<svg/>', Date.now());
    insert.run('legacy-alice', 'alice', 'alice@local.localhost', '<svg/>', Date.now());

    initAuth(db);

    assert.deepEqual(listUsers(db).map((user) => user.username), ['alice'], 'the internal worker account is not a person');
    const worker = db.prepare("SELECT role, disabled FROM users WHERE username = 'local'").get();
    assert.equal(worker.role, 'system');
    assert.equal(worker.disabled, 1);
    assert.throws(
      () => createUser(db, { username: 'local', password: 'local-password' }),
      (err) => err.status === 400 && err.code === 'invalid_username'
    );
    assert.ok(db.prepare("SELECT id FROM users WHERE username = 'alice'").get(), 'legacy people keep their row for password recovery');
  } finally {
    db.close();
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

