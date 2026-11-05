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

function createSdkClient(port, { app = 'notes', user = null, rtcClass = null } = {}) {
  const sdkCode = fs.readFileSync(path.resolve(import.meta.dirname, 'sdk/puter.js'), 'utf8');
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
    __PUTER_API_ORIGIN__: `http://127.0.0.1:${port}`,
    __PUTER_APP_NAME__: app,
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

  await t.test('2. puter.auth (signIn, signOut, isSignedIn, getUser, getProfilePicture, whoami)', async () => {
    const client = createSdkClient(port, { app: 'chess' });
    const { puter } = client;

    assert.equal(await puter.auth.isSignedIn(), true);
    const u1 = await puter.auth.getUser();
    assert.equal(u1.username, 'local');
    const who = await puter.auth.whoami();
    assert.equal(who.username, 'local');

    const pic = await puter.auth.getProfilePicture();
    assert.ok(pic.startsWith('data:image/svg+xml'));

    await puter.auth.signOut();
    assert.equal(await puter.auth.isSignedIn(), false);
    assert.equal(await puter.auth.getUser(), null);
    await assert.rejects(() => puter.auth.whoami(), (err) => err.status === 401);

    const signedIn = await puter.auth.signIn({ username: 'alice' });
    assert.equal(signedIn.username, 'alice');
    assert.equal(await puter.auth.isSignedIn(), true);
    assert.equal((await puter.auth.getUser()).username, 'alice');
  });

  await t.test('3. puter.fs (write, read, delete, readdir, stat, rename, mkdir, getReadURL, revokeReadURL, space, share, unshare, listShared, getShares)', async () => {
    const alice = createSdkClient(port, { app: 'notes', user: 'alice' }).puter;
    const bob = createSdkClient(port, { app: 'notes', user: 'bob' }).puter;

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

  await t.test('4. puter.kv (set, get, del, list, update, add, incr, MAX) + events.onLocal', async () => {
    const { puter } = createSdkClient(port, { app: 'notes' });

    assert.equal(puter.kv.MAX, 399 * 1024);
    assert.equal(puter.kv.decr, undefined);
    assert.equal(puter.kv.expireAt, undefined);
    assert.equal(puter.kv.flush, undefined);

    const eventsReceived = [];
    const handle = await puter.events.onLocal('note:', (ev) => eventsReceived.push(ev.event), { includeValue: true });

    await puter.kv.set('note:1', { title: 'First' });
    assert.deepEqual(await puter.kv.get('note:1'), { title: 'First' });

    const updated = await puter.kv.update('note:1', { '["title"]': 'Updated', 'meta.pinned': true });
    assert.deepEqual(updated, { title: 'Updated', meta: { pinned: true } });

    assert.equal(await puter.kv.incr('counter', 5), 5);
    assert.equal(await puter.kv.incr('counter'), 6);

    const arr1 = await puter.kv.add('items', ['a']);
    assert.deepEqual(arr1, ['a']);
    const arr2 = await puter.kv.add('items', ['b']);
    assert.deepEqual(arr2, ['a', 'b']);

    // Path-map forms used by the worker apps (teamchat counters and lists).
    await puter.kv.set('doc', { counters: { a: 1 }, tags: { list: ['x'] } });
    const doc1 = await puter.kv.incr('doc', { 'counters.a': 2, 'counters.b': 1 });
    assert.equal(doc1.counters.a, 3);
    assert.equal(doc1.counters.b, 1);
    const doc2 = await puter.kv.add('doc', { 'tags.list': ['y'] });
    assert.deepEqual(doc2.tags.list, ['x', 'y']);

    const keys = await puter.kv.list('note:*');
    assert.deepEqual(keys, ['note:1']);
    const pairs = await puter.kv.list('note:*', true);
    assert.equal(pairs[0].key, 'note:1');

    // Async iterator stream
    const streamed = [];
    for await (const page of puter.kv.list({ pattern: 'note:*', stream: true, returnValues: true })) {
      streamed.push(...page.items);
    }
    assert.equal(streamed.length, 1);

    await puter.kv.del('note:1');
    assert.equal(await puter.kv.get('note:1'), null);

    await new Promise((r) => setTimeout(r, 50));
    await handle.off();
    assert.ok(eventsReceived.length >= 1);
  });

  await t.test('5. puter.workers (create, exec, get, list, delete + pooled worker_threads + terminate on timeout)', async () => {
    const alice = createSdkClient(port, { app: 'teamchat', user: 'alice' }).puter;
    const bob = createSdkClient(port, { app: 'teamchat', user: 'bob' }).puter;

    const workerCode = `
      router.get('/health', async (ctx) => ({
        ok: true,
        owner: (await me.puter.auth.getUser()).username,
        caller: ctx.user ? (await ctx.user.puter.auth.getUser()).username : null,
      }));
      router.post('/messages', async (ctx) => {
        const body = await ctx.request.json();
        const who = await ctx.user.puter.auth.getUser();
        const list = await me.puter.kv.add('msgs', [{ from: who.username, text: body.text }]);
        await me.puter.email.sendTransactional({ to: 'team@localhost', subject: 'New msg', text: body.text });
        return new Response(JSON.stringify({ ok: true, count: list.length }), { status: 201, headers: { 'content-type': 'application/json' } });
      });
      router.post('/paths', async () => {
        await me.puter.kv.set('paths-doc', { counters: { a: 1 }, tags: { list: ['x'] }, members: { u1: { role: 'guest' } } });
        const inc = await me.puter.kv.incr('paths-doc', { 'counters.a': 2, 'counters.b': 1 });
        const added = await me.puter.kv.add('paths-doc', { 'tags.list': ['y'] });
        const removed = await me.puter.kv.remove('paths-doc', 'members.u1', 'counters.b');
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

  await t.test('6. puter.email (send, sendTransactional, list)', async () => {
    const { puter } = createSdkClient(port, { app: 'spreadsheet' });
    const sent1 = await puter.email.send({ to: 'ana@example.com', subject: 'Sheet', text: 'Body 1' });
    assert.equal(sent1.ok, true);
    const sent2 = await puter.email.sendTransactional({ to: ['ben@example.com'], subject: 'Invite', html: '<p>Hi</p>' });
    assert.equal(sent2.ok, true);
    const inbox = await puter.email.list();
    assert.ok(inbox.length >= 2);
  });

  await t.test('7. puter.hosting (create, delete) + Hosted-site Origin/Host signIn block', async () => {
    const { puter } = createSdkClient(port, { app: 'wiki' });
    await puter.fs.write('/site-out/index.html', '<h1>Published Local Site</h1>');
    const site = await puter.hosting.create('my-wiki-site', '/site-out');
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

    await puter.hosting.delete('my-wiki-site');
  });

  await t.test('8. puter.perms & puter.ui (all methods)', async () => {
    const client = createSdkClient(port, { app: 'documents' });
    const { puter } = client;

    assert.equal(await puter.perms.check('folder'), true);
    assert.ok(await puter.perms.request('folder'));
    assert.deepEqual(await puter.ui.requestPermission('ai'), { granted: true });

    const savedItem = await puter.ui.showSaveFilePicker('Doc content', 'doc.txt');
    assert.equal(savedItem.name, 'doc.txt');
    const openedItem = await puter.ui.showOpenFilePicker({ path: savedItem.path });
    assert.equal(await openedItem.text(), 'Doc content');
    const dirItem = await puter.ui.showDirectoryPicker({ path: '/' });
    assert.equal(dirItem.is_dir, true);

    assert.equal(await puter.ui.alert('Saved!', [{ label: 'Great', value: 'ok' }]), 'ok');
    puter.ui.setWindowTitle('My Document');
    assert.equal(client.document.title, 'My Document');
    assert.equal(await puter.ui.showWindow(), null);
    assert.equal(puter.ui.hideWindow(), undefined);
    assert.equal(puter.ui.contextMenu([]), undefined);
    assert.equal(puter.ui.parentApp(), null);
    assert.ok(await puter.ui.requestPictureInPicture());
    assert.equal(await puter.ui.exitPictureInPicture(), null);
    assert.equal(puter.env, 'app');
    assert.equal(await puter.exit(), undefined);
  });

  await t.test('9. puter.ai (chat non-streaming + streaming with local mock, graceful degradation for unconfigured engines)', async () => {
    // Start a mock local Ollama server
    const mockAi = http.createServer(async (req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'local-llama' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        let body = '';
        for await (const c of req) body += c;
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Local reply' }, finish_reason: 'stop' }] }));
        }
      }
    });
    await new Promise((r) => mockAi.listen(0, '127.0.0.1', r));
    const aiPort = mockAi.address().port;
    srv.ctx.localAiUrl = `http://127.0.0.1:${aiPort}`;

    const { puter } = createSdkClient(port, { app: 'video-studio' });
    const models = await puter.ai.listModels();
    assert.equal(models[0].id, 'local-llama');

    const chatReply = await puter.ai.chat('Say hi');
    assert.equal(String(chatReply), 'Local reply');

    const stream = await puter.ai.chat('Stream hi', { stream: true });
    let collected = '';
    for await (const chunk of stream) {
      if (chunk.text) collected += chunk.text;
    }
    assert.equal(collected, 'Hello world');

    await new Promise((r) => mockAi.close(r));
    srv.ctx.localAiUrl = 'http://127.0.0.1:1';

    for (const method of ['chat', 'txt2img', 'txt2vid', 'speech2txt', 'txt2speech', 'img2txt']) {
      await assert.rejects(() => puter.ai[method]('test'), (err) => err.code === 'local_ai_unavailable');
    }
  });

  await t.test('10. puter.peer (serve, connect, ensureTurnRelays, createGuestGrant + RTCPeerConnection SDP/ICE + media tracks)', async () => {
    const hostTab = createSdkClient(port, { app: 'meetings', user: 'alice' });
    const guestTab = createSdkClient(port, { app: 'meetings', user: 'bob' });

    assert.deepEqual(await hostTab.puter.peer.ensureTurnRelays(), []);
    const grant = await hostTab.puter.peer.createGuestGrant();
    assert.ok(grant.grant.startsWith('grant-'));

    const serverHandle = await hostTab.puter.peer.serve();
    assert.ok(serverHandle.inviteCode.startsWith('inv-'));

    let hostConn = null;
    const hostConnectedPromise = new Promise((resolve) => {
      serverHandle.on('connection', ({ conn, user }) => {
        hostConn = conn;
        resolve(user);
      });
    });

    const guestConn = await guestTab.puter.peer.connect(serverHandle.inviteCode);
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

  await t.test('11. puter.net (fetch local guard + Socket)', async () => {
    const { puter } = createSdkClient(port, { app: 'api-client' });
    await assert.rejects(
      async () => puter.net.fetch('https://example.com/api'),
      (err) => err.code === 'external_not_allowed'
    );
    const localRes = await puter.net.fetch(`http://127.0.0.1:${port}/api/auth/whoami`);
    assert.equal(localRes.status, 200);

    // Test local TCP echo via puter.net.Socket
    const echoServer = net.createServer((sock) => sock.pipe(sock));
    await new Promise((r) => echoServer.listen(0, '127.0.0.1', r));
    const echoPort = echoServer.address().port;

    const echoed = await new Promise((resolve) => {
      const sock = puter.net.Socket('127.0.0.1', echoPort);
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
