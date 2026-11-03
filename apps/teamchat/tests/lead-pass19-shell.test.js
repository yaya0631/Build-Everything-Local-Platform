/**
 * The shell (review pass 19, lead), driven in node through tests/helpers/dom.js
 * as the pass-14 file is: a fresh DOM and a fresh module registry for every
 * test, Puter faked at `puter.workers.exec`, the conversation column and the
 * huddle window stubbed, browser notifications collected rather than shown.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDom } from './helpers/dom.js';

vi.mock('../src/ui/conversation.js', () => ({
  createConversationView: (convId) => {
    const node = document.createElement('div');
    node.className = 'main';
    node.dataset.conv = convId;
    return { el: node, destroy() {}, renderHeader() {}, tab: () => 'messages', setTab() {}, jumpTo() {} };
  },
}));
vi.mock('../src/ui/huddle.js', () => ({
  mountHuddleDock() {},
  joinHuddleFlow() {},
  huddleButton() { return document.createElement('span'); },
  createHuddleBar() { return { el: document.createElement('div'), destroy() {} }; },
}));
const banners = [];
vi.mock('../src/lib/notify.js', async (importOriginal) => ({ ...(await importOriginal()), showNotification: (opts) => { banners.push(opts); } }));

const REF = 'abc123def0@teamchat-test';
const OTHER = 'other00000@teamchat-test';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let dom = null;

/** A fresh DOM and fresh modules; the store opens a small workspace when asked. */
async function boot({ hash = '', width = 1280, routes = {}, ...env } = {}) {
  dom?.uninstall();
  dom = installDom({ hash, width, ...env });
  vi.resetModules();
  globalThis.puter = {
    workers: {
      exec: async (url, init = {}) => {
        const u = new URL(url);
        const hit = Object.entries(routes).find(([k]) => u.pathname.endsWith(k));
        if (!hit) return json({ code: 'not_found', message: 'nope' }, 404);
        return hit[1](u.searchParams, init);
      },
    },
  };
  const { store } = await import('../src/lib/store.js');
  const open = (ref = REF, name = 'Globex') => {
    store.wsId = ref;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = {
      id: ref.split('@')[0], name,
      channels: { c1: { id: 'c1', name: 'general', def: true } },
      members: {
        'u-me': { role: 'member', name: 'Me', username: 'me' },
        'u-dan': { role: 'member', name: 'Dan Ito', username: 'dan' },
      },
    };
    store.me = {
      role: 'member', channels: ['c1'],
      dms: { dm_d: { members: ['u-me', 'u-dan'], createdAt: 3 } },
      reads: {}, mentions: {}, notify: {}, threads: {},
    };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    store.workspaces = [{ id: REF, name: 'Globex' }, { id: OTHER, name: 'Initech' }];
  };
  store.openWorkspace = async () => { open(); store.emit('workspace'); };
  store.startPolling = () => {};
  store.pokeSync = () => {};
  return { store, open, dom };
}

afterEach(() => {
  dom?.uninstall();
  dom = null;
  delete globalThis.puter;
});

describe('a browser notification for a direct message', () => {
  it('is named with its workspace, so two workspaces\' news of a conversation of the same id neither replace nor silence each other', async () => {
    const ctx = await boot({ hash: `#/ws/${encodeURIComponent(REF)}/c/c1` });
    const { store, dom: d, open } = ctx;
    banners.length = 0;
    const { mountShell } = await import('../src/ui/shell.js');
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    mountShell(app);
    await d.tick(5);
    store.profile.prefs.notify = true; // banners on, sound off
    store.profile.prefs.sound = false;
    document.hidden = true;
    // The message stands in the loaded window, so nothing is read for it.
    const seed = (seq) => Object.assign(store.conv('dm_d'), { loaded: true, seq, hasMore: false, messages: [{ seq, user: 'u-dan', ts: 5000 + seq, text: 'psst', kind: 'msg', attachments: [], mentions: [], reactions: {} }] });
    seed(7);
    store.emit('incoming', [{ conv: 'dm_d', from: 'u-dan', seq: 7 }]);
    await d.tick(5);
    expect(banners.length).toBe(1);
    expect(banners[0].tag).toBe(`${REF}:message-dm_d`);
    // The same direct message id under another workspace, a moment later.
    open(OTHER, 'Initech');
    store.profile.prefs.notify = true;
    store.profile.prefs.sound = false;
    store.emit('workspace');
    await d.tick(2);
    seed(9);
    store.emit('incoming', [{ conv: 'dm_d', from: 'u-dan', seq: 9 }]);
    await d.tick(5);
    expect(banners.length).toBe(2);
    expect(banners[1].tag).toBe(`${OTHER}:message-dm_d`);
    expect(banners[1].tag).not.toBe(banners[0].tag);
    document.hidden = false;
  });
});
