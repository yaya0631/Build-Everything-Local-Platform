/**
 * Handle revocation (worker/events.js releaseHandle/revokeHandle, wired into
 * worker/index.js at every workspace-level membership ending): an admin
 * removal, a self-leave, an external seat ending on a host, and a workspace
 * deletion each give back the departing member's cached KV share handle, so
 * a removed member stops receiving even the opaque shard pings and the
 * owner's live-handle slot frees for someone still here. See
 * docs/systemDesignDocs/teamchatEventsSignaling.md, sections 7.2 and 7.3.
 *
 * Every scenario here boots with an app-bound token (see
 * tests/events-signal.test.js's file docstring for why): a user-scoped
 * worker can never hold a handle to revoke, which is covered on its own
 * terms in "a user-scoped worker" below.
 */
import {
  describe, it, expect, afterEach,
} from 'vitest';
import {
  boot, as, USERS, workspaceWith, fakeAuthToken,
} from './helpers/harness.js';
import { REVOKE_BATCH_MAX } from '../worker/events.js';
import { KEYS } from '../src/shared/blocks.js';

const {
  alice, bob, carol, dave,
} = USERS;
const SERVER = 'teamchat-api.test';
const realFetch = globalThis.fetch;

let rt;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (rt) expect(rt.kv._calls.list).toBe(0);
  rt = null;
});

/** True when `key` is one of this workspace's signal shard keys (see tests/events-signal.test.js). */
const isShardKey = (key, wsId) => key.startsWith(`tc:ws:${wsId}:ev:s`);

/**
 * What the stub mints for one member of one workspace. Real handles are per
 * (owner, grantee, app, region), so the workspace belongs in the name: two
 * workspaces on this worker with the same member in both would otherwise
 * hand out the one handle, and a release that reached for the wrong
 * workspace's document would still look right.
 */
const handleFor = (uuid, wsId) => `kvh-${uuid}-${wsId}`;

/**
 * A fetch stub that answers mints and revokes on the shape worker/events.js
 * sends them in, and records every call as { method, url, headers, kvOps },
 * `kvOps` being how many mutating KV ops the request had made so far — the
 * one clock the HTTP calls and the KV writes share, so a test can tell which
 * happened first. `mintFail`/`revokeFail` let a test make one grantee's mint,
 * or one handle's revoke, answer with a failure instead of the default
 * success; each takes the id in question and returns null (succeed) or
 * { status, body }.
 */
function installFetchStub({ mintFail = () => null, revokeFail = () => null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const call = { method, url: String(url), headers: init.headers || {}, kvOps: rt.kv._calls.log.length };
    calls.push(call);
    if (method === 'POST' && call.url.endsWith('/events/kv-handles')) {
      const body = JSON.parse(init.body || '{}');
      const bad = mintFail(body.granteeUid);
      if (bad) return new Response(JSON.stringify(bad.body || {}), { status: bad.status });
      // `prefix` is tc:ws:{id}:ev: — the region of the workspace being minted for.
      const wsId = String(body.prefix || '').split(':')[2] || '';
      return new Response(JSON.stringify({ handle: handleFor(body.granteeUid, wsId) }), { status: 200 });
    }
    if (method === 'DELETE' && call.url.includes('/events/kv-handles/')) {
      const handle = decodeURIComponent(call.url.split('/events/kv-handles/')[1]);
      const bad = revokeFail(handle);
      if (bad?.network) throw new Error('offline');
      if (bad) return new Response(JSON.stringify(bad.body || {}), { status: bad.status });
      return new Response(JSON.stringify({ handle, revokedAt: Date.now() }), { status: 200 });
    }
    throw new Error(`events-revoke.test.js: unexpected fetch ${method} ${call.url}`);
  };
  return calls;
}

describe('removing a member revokes their cached handle', () => {
  it('an admin removing a member issues exactly one DELETE, for that member\'s own handle, on the worker\'s own token', async () => {
    const token = fakeAuthToken();
    rt = await boot({ authToken: token });
    const calls = installFetchStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0].url.endsWith(`/events/kv-handles/${handleFor(bob.uuid, wsId)}`)).toBe(true);
    expect(deletes[0].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('the DELETE lands before the request\'s last mutating KV op, which is a shard write', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const beforeCalls = calls.length;
    const beforeKv = rt.kv._calls.log.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const del = calls.slice(beforeCalls).find((c) => c.method === 'DELETE');
    expect(del).toBeTruthy();
    const made = rt.kv._calls.log.slice(beforeKv);
    expect(made.length).toBeGreaterThan(0);
    expect(isShardKey(made[made.length - 1].key, wsId)).toBe(true);
    // del.kvOps is the log length as it stood the instant the DELETE went
    // out; strictly less than the final length means at least the shard
    // write above still landed after it.
    expect(del.kvOps).toBeLessThan(beforeKv + made.length);
  });

  it('leaving on one\'s own also revokes the handle', async () => {
    const token = fakeAuthToken();
    rt = await boot({ authToken: token });
    const calls = installFetchStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const before = calls.length;
    const res = await as(bob).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0].url.endsWith(`/events/kv-handles/${handleFor(bob.uuid, wsId)}`)).toBe(true);
  });

  it('a member with no cached handle (their mint was refused) is removed with no DELETE at all', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub({
      mintFail: (granteeUid) => (granteeUid === bob.uuid ? { status: 429, body: { code: 'too_many_requests' } } : null),
    });
    const { wsId } = await workspaceWith(alice, [bob]);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    expect(calls.slice(before).some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('an owner-only refusal (an older platform build) still lets the removal succeed, and changes nothing else', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub({
      revokeFail: () => ({ status: 403, body: { code: 'events_kv_handle_owner_only' } }),
    });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    const after = await as(alice).get(`/api/ws/${wsId}`);
    expect(after.data.workspace.members[bob.uuid]).toBeUndefined();
    expect(after.data.workspace.members[carol.uuid]).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('a network failure revoking the handle still lets the removal succeed, and changes nothing else', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub({ revokeFail: () => ({ network: true }) });
    const { wsId } = await workspaceWith(alice, [bob, carol]);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    // The revoke was attempted and threw; the removal went through regardless.
    expect(calls.slice(before).filter((c) => c.method === 'DELETE').length).toBe(1);
    const after = await as(alice).get(`/api/ws/${wsId}`);
    expect(after.data.workspace.members[bob.uuid]).toBeUndefined();
    expect(after.data.workspace.members[carol.uuid]).toBeTruthy();
  });
});

describe('deleting a workspace revokes a bounded batch of handles', () => {
  it(`revokes at most REVOKE_BATCH_MAX (${REVOKE_BATCH_MAX}) handles, however many members are holding one`, async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { wsId, code } = await workspaceWith(alice, []);
    const many = Array.from({ length: REVOKE_BATCH_MAX + 2 }, (_, i) => ({ uuid: `u-test-${String(i).padStart(2, '0')}`, username: `test${i}` }));
    for (const u of many) expect((await as(u).post('/api/join', { code })).ok).toBe(true);
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${wsId}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(REVOKE_BATCH_MAX);
  });
});

describe('an external member\'s seat ending on the host revokes their handle', () => {
  /**
   * Acme (alice, carol) hosts #design; Globex (alice owns it too, bob is its
   * admin, dave a member) is the partner. Bob accepts the share link,
   * records it on Globex, and joins the channel on Acme — copied from
   * tests/connect.test.js's shared(), with the fetch stub already in place
   * so every join along the way mints a real (stubbed) handle.
   */
  async function shared() {
    const acme = await workspaceWith(alice, [carol], 'Acme');
    const globex = await workspaceWith(alice, [bob, dave], 'Globex');
    expect((await as(alice).post(`/api/ws/${globex.wsId}/members/${bob.uuid}/role`, { role: 'admin' })).ok).toBe(true);
    const design = (await as(alice).post(`/api/ws/${acme.wsId}/channels`, { name: 'design', topic: 'Pixels' })).data.channel.id;
    await as(carol).post(`/api/ws/${acme.wsId}/channels/${design}/join`);
    const inv = await as(alice).post(`/api/ws/${acme.wsId}/channels/${design}/connect/invites`, { inviteTtl: '7d' });
    expect(inv.ok).toBe(true);
    const acc = await as(bob).post('/api/connect/accept', { code: inv.data.code, partner: { ref: `${globex.wsId}@${SERVER}`, name: 'Globex' }, profile: { name: 'Bob B.' } });
    expect(acc.ok).toBe(true);
    const added = await as(bob).post(`/api/ws/${globex.wsId}/channels/shared`, {
      ref: `${acme.wsId}@${SERVER}`, ch: design, conn: acc.data.conn, secret: acc.data.secret, name: 'design-with-acme', host: acc.data.workspace.name,
    });
    expect(added.ok).toBe(true);
    const local = added.data.channel.id;
    const att = await as(bob).post(`/api/ws/${globex.wsId}/channels/${local}/attest`, {});
    expect(att.ok).toBe(true);
    const j = await as(bob).post('/api/connect/join', { conn: att.data.conn, token: att.data.token, profile: { name: 'Bob B.', title: 'Globex ops' } });
    expect(j.ok).toBe(true);
    return { acme, globex, design, local, conn: acc.data.conn };
  }

  it('ending the connection from the host revokes the external member\'s handle', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { acme, design, conn } = await shared();
    // Bob's own bootstrap on Acme is what mints and caches his handle there.
    const bobBoot = await as(bob).get(`/api/ws/${acme.wsId}`);
    expect(bobBoot.data.events).toMatchObject({ mode: 'handle', handle: handleFor(bob.uuid, acme.wsId) });
    const before = calls.length;
    const res = await as(alice).del(`/api/ws/${acme.wsId}/channels/${design}/connections/${conn}`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    // Acme's handle, not the one bob holds on Globex, which he keeps.
    expect(deletes[0].url.endsWith(`/events/kv-handles/${handleFor(bob.uuid, acme.wsId)}`)).toBe(true);
  });

  it('the partner\'s word that one of its people is out ends the seat here and gives the handle back', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { acme, globex, conn } = await shared();
    expect((await as(bob).get(`/api/ws/${acme.wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, acme.wsId) });
    // Globex takes bob out, which hands its admin the word for Acme (see
    // revocationsFor); that removal gives back the handle bob held on
    // Globex, and carrying the word to Acme gives back the one he held here.
    const removed = await as(alice).del(`/api/ws/${globex.wsId}/members/${bob.uuid}`);
    expect(removed.data.revocations).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/events/kv-handles/')[1]))
      .toEqual([handleFor(bob.uuid, globex.wsId)]);
    const before = calls.length;
    expect((await as(alice).post('/api/connect/revoke', { conn, token: removed.data.revocations[0].token })).data).toEqual({ ok: true });
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0].url.endsWith(`/events/kv-handles/${handleFor(bob.uuid, acme.wsId)}`)).toBe(true);
  });

  it('a standing that ran out long ago is swept, and the handle goes with the card', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { acme } = await shared();
    expect((await as(bob).get(`/api/ws/${acme.wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, acme.wsId) });
    // Past the sweep's grace (see EXTERNAL_LAPSE_GRACE_MS), so the next
    // bootstrap by anyone here lets the card go (see lapseExternals).
    await rt.kv.update(KEYS.ws(acme.wsId), { [`members.${bob.uuid}.exp`]: Date.now() - 31 * 86400_000 });
    const before = calls.length;
    expect((await as(carol).get(`/api/ws/${acme.wsId}`)).ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0].url.endsWith(`/events/kv-handles/${handleFor(bob.uuid, acme.wsId)}`)).toBe(true);
  });

  it('an external member leaving their last shared channel gives their handle back too', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { acme, design } = await shared();
    expect((await as(bob).get(`/api/ws/${acme.wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, acme.wsId) });
    const before = calls.length;
    // The channel he is here for is his last one, so leaving it takes him
    // out of the host workspace altogether (see the leave route).
    const res = await as(bob).post(`/api/ws/${acme.wsId}/channels/${design}/leave`);
    expect(res.ok).toBe(true);
    const deletes = calls.slice(before).filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0].url.endsWith(`/events/kv-handles/${handleFor(bob.uuid, acme.wsId)}`)).toBe(true);
  });
});

describe('a removal that is not the end of a membership revokes nothing', () => {
  it('leaving one channel of a workspace one stays in keeps the handle', async () => {
    rt = await boot({ authToken: fakeAuthToken() });
    const calls = installFetchStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const ops = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'ops' })).data.channel.id;
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${ops}/join`)).ok).toBe(true);
    const before = calls.length;
    // The signal region is per workspace and a shard key names no channel,
    // so someone still in the workspace still has something to watch.
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${ops}/leave`)).ok).toBe(true);
    expect(calls.slice(before).some((c) => c.method === 'DELETE')).toBe(false);
    expect((await as(bob).get(`/api/ws/${wsId}`)).data.events).toMatchObject({ handle: handleFor(bob.uuid, wsId) });
  });
});

describe('a user-scoped worker', () => {
  it('never issues a DELETE on a removal (nor a mint on the join before it)', async () => {
    rt = await boot(); // authToken: null
    const calls = installFetchStub();
    const { wsId } = await workspaceWith(alice, [bob]);
    const res = await as(alice).del(`/api/ws/${wsId}/members/${bob.uuid}`);
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(0);
  });
});
