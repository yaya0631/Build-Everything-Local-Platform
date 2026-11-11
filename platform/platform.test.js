import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { createPlatformServer } from './server/index.js';

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
async function api(port, subPath, { method = 'GET', body, user = 'local', origin } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api${subPath}?app=test`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer tok-${user}`,
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

function createSdkClient(port, { app = 'notes', user = null, rtcClass = null } = {}) {
  const sdkCode = fs.readFileSync(path.resolve(import.meta.dirname, 'sdk/everything.js'), 'utf8');
  const store = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };
  const search = user ? `?user=${encodeURIComponent(user)}` : '';
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
      search,
      assign(u) { this.href = u; },
    },
    __EVERYTHING_API_ORIGIN__: `http://127.0.0.1:${port}`,
    __EVERYTHING_APP_NAME__: app,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const fn = new Function('globalThis', 'window', 'document', 'location', 'localStorage', 'sessionStorage', 'RTCPeerConnection', 'MediaStream', sdkCode);
  fn(sandbox, sandbox, sandbox.document, sandbox.location, sandbox.localStorage, sandbox.sessionStorage, sandbox.RTCPeerConnection, sandbox.MediaStream);
  return sandbox;
}

test('Platform Conformance Suite (Section 4 + Security + Peer + Workers)', async (t) => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'everything-local-test-'));
  const srv = await createPlatformServer({ port: 0, dataDir: tmpData });
  const port = srv.port;

  t.after(async () => {
    await srv.close();
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  await t.test('1. Security: Loopback binding, Host header (DNS rebinding guard), Origin check, and Hosted subdomain isolation', async () => {
    assert.equal(srv.server.address().address, '127.0.0.1');

    // DNS rebinding guard: invalid Host header on GET must return 403
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/whoami', method: 'GET', headers: { Host: 'attacker.example.com' } }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHostStatus, 403);

    // Valid *.localhost Host header succeeds
    const goodHostStatus = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/auth/whoami', method: 'GET', headers: { Host: `notes.localhost:${port}` } }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(goodHostStatus, 200);

    // Cross-origin API call from external Origin must return 403
    const badOriginRes = await fetch(`http://127.0.0.1:${port}/api/auth/signin`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'local' }),
    });
    assert.equal(badOriginRes.status, 403);
  });

  await t.test('2. everything.auth (signIn, signOut, isSignedIn, getUser, getProfilePicture, whoami)', async () => {
    const client = createSdkClient(port, { app: 'chess' });
    const { everything } = client;

    assert.equal(await everything.auth.isSignedIn(), true);
    const u1 = await everything.auth.getUser();
    assert.equal(u1.username, 'local');
    const who = await everything.auth.whoami();
    assert.equal(who.username, 'local');

    const pic = await everything.auth.getProfilePicture();
    assert.ok(pic.startsWith('data:image/svg+xml'));

    await everything.auth.signOut();
    assert.equal(await everything.auth.isSignedIn(), false);
    assert.equal(await everything.auth.getUser(), null);
    await assert.rejects(() => everything.auth.whoami(), (err) => err.status === 401);

    const signedIn = await everything.auth.signIn({ username: 'alice' });
    assert.equal(signedIn.username, 'alice');
    assert.equal(await everything.auth.isSignedIn(), true);
    assert.equal((await everything.auth.getUser()).username, 'alice');
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

    // Passwordless signIn from hosted-site subdomain is blocked (403)
    const hostedSignIn = await fetch(`http://127.0.0.1:${port}/api/auth/signin`, {
      method: 'POST',
      headers: {
        Origin: `http://my-wiki-site.localhost:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'local' }),
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
    const seen = { auth: [], paths: [] };
    const mockAi = http.createServer(async (req, res) => {
      seen.paths.push(req.url);
      seen.auth.push(req.headers.authorization || req.headers['x-api-key'] || '');
      const send = (code, obj, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };

      if (req.url === '/api/tags') return send(200, { models: [{ name: 'local-llama' }] });
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'remote-model' }] });

      let body = '';
      for await (const c of req) body += c;

      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        // Vision requests carry image parts; echo back what we saw.
        const parts = parsed.messages?.[0]?.content;
        if (Array.isArray(parts)) {
          const hasImage = parts.some((p) => p.type === 'image_url' && String(p.image_url.url).startsWith('data:image/'));
          return send(200, { choices: [{ message: { role: 'assistant', content: hasImage ? 'OCR TEXT' : 'no image' } }] });
        }
        return send(200, { choices: [{ message: { role: 'assistant', content: 'Remote reply' }, finish_reason: 'stop' }] });
      }
      if (req.url === '/v1/images/generations') {
        return send(200, { data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] });
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
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Anthropic ' } }) + '\n\n');
          res.write('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'reply' } }) + '\n\n');
          return res.end();
        }
        return send(200, { content: [{ type: 'text', text: 'Anthropic reply' }], stop_reason: 'end_turn' });
      }
      if (req.url === '/api/chat') {
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { content: 'Ollama ' } }) + '\n');
          res.write(JSON.stringify({ message: { content: 'native' } }) + '\n');
          return res.end();
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
    assert.equal(String(await everything.ai.chat('Say hi')), 'Ollama reply');

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

    const listed = await api(port, '/ai/providers');
    assert.equal(listed.length, 2);
    assert.equal(listed[0].api_key, undefined);

    await api(port, '/ai/routes', { method: 'POST', body: { routes: { chat: saved.id } } });
    assert.equal(String(await everything.ai.chat('Say hi')), 'Remote reply');
    assert.ok(seen.auth.includes('Bearer sk-test'), 'the provider key must be sent upstream');

    const stream = await everything.ai.chat('Stream hi', { stream: true });
    let collected = '';
    for await (const chunk of stream) {
      if (chunk.text) collected += chunk.text;
    }
    assert.equal(collected, 'Hello world');

    const img = await everything.ai.txt2img('a cat');
    assert.ok(String(img.src).startsWith('data:image/png;base64,'), 'txt2img resolves an image with a data URL src');

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
    const localRes = await everything.net.fetch(`http://127.0.0.1:${port}/api/auth/whoami`);
    assert.equal(localRes.status, 200);

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

