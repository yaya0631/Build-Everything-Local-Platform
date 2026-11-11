import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/page.css';
import './styles/editor.css';
import './styles/database.css';
import { h } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { applyTheme } from './ui/prefs.js';
import { Workspace } from './data/workspace.js';
import { everythingBackend, everythingKv, indexedDbBackend, localKv } from './data/backend.js';
import { indexedDbCache, memoryCache } from './data/cache.js';
import { App } from './ui/app.js';
import { call, deploy, refreshDeployment } from './collab/api.js';
import { parseLink } from './collab/protocol.js';
import { grantEvents } from './collab/consent.js';

const root = document.getElementById('app');
applyTheme();

const logo = () => h('img.splash-logo', { src: './icon-192.png', alt: '', width: 48, height: 48 });

function screen(...children) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('main.splash', { id: 'main' }, ...children));
}

function loading(text = 'Opening your wiki...') {
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(h('div.splash', { role: 'status' }, logo(), h('div.spinner', { 'aria-hidden': 'true' }), h('p.splash-sub', text)));
}

function errorScreen(title, message, retry) {
  screen(h('div.splash-icon', icon('cloudOff', 28)), h('h1.splash-title', title), h('p.splash-sub', message), retry ? h('button.btn.primary.splash-cta', { type: 'button', onclick: retry }, 'Try again') : null);
}

function signInScreen(onSignedIn, inviting) {
  const btn = h('button.btn.primary.splash-cta', { type: 'button' }, 'Sign in');
  const error = h('p.field-error', { role: 'alert' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Waiting for Everything...';
    error.textContent = '';
    try {
      await everything.auth.signIn();
      onSignedIn();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      if (err?.error === 'popup_blocked') error.textContent = 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
      else if (err?.error !== 'auth_window_closed') error.textContent = 'Could not sign in. Try again.';
    }
  });
  const feature = (ic, text) => h('li', icon(ic, 18), h('span', text));
  screen(
    logo(),
    h('h1.splash-title', inviting ? 'You are invited to a shared space' : 'Wiki'),
    h('p.splash-sub', inviting ? 'Sign in with Everything to open it.' : 'Docs, notes and databases for you and your team.'),
    inviting
      ? null
      : h(
          'ul.splash-features',
          feature('pencil', 'Write with blocks: headings, lists, to-dos, tables, code and images'),
          feature('database', 'Track anything with tables, boards, lists and calendars'),
          feature('users', 'Share pages and edit together in real time'),
          feature('cloud', 'Stored as files in your own Everything cloud'),
        ),
    btn,
    error,
  );
  btn.focus();
}

async function profilePicture() {
  try {
    return (await everything.auth.getProfilePicture?.()) || null;
  } catch {
    return null;
  }
}

async function start({ backend, kv, cache, user, env, collab, onSignOut, picture, link }) {
  loading();
  const ws = new Workspace({ backend, kv, cache, user, collab });
  try {
    await ws.start();
  } catch (err) {
    console.error(err);
    errorScreen('Could not open your wiki', 'Check your connection and try again.', () => location.reload());
    return;
  }
  const app = new App(root, { ws, user, env, onSignOut, picture: null, everything: typeof everything === 'undefined' ? null : everything });
  window.wikiApp = app;
  await app.start();
  Promise.resolve(picture).then((p) => p && app.setPicture(p));
  if (link) {
    history.replaceState(null, '', location.pathname + location.search);
    app.join(link);
  }
}

function inviteFromHash() {
  if (!/(^|[#&])space=/.test(location.hash)) return null;
  try {
    return parseLink(location.href);
  } catch {
    return null;
  }
}

async function boot() {
  const link = inviteFromHash();
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has('local')) {
    // Development sandbox: everything stays in this browser, no Everything account.
    // Sharing runs on a local copy of the collaboration service; add &as=<name>
    // in another tab to be someone else.
    const { localCollab, devUser } = await import('./dev/local-collab.js');
    const user = { ...devUser(params.get('as')), sandbox: true };
    const ns = user.username === 'you' ? '' : `-${user.username}`;
    const backend = await indexedDbBackend(`wiki-local${ns}`);
    start({ backend, kv: localKv(`wiki-local${ns}:`), cache: memoryCache(), user, env: 'web', collab: localCollab(user), onSignOut: null, picture: null, link });
    return;
  }
  if (typeof everything === 'undefined') {
    errorScreen('Could not reach Everything', 'Wiki keeps your pages in your Everything cloud. Check your connection and try again.', () => location.reload());
    return;
  }
  const env = everything.env;
  const begin = async () => {
    loading();
    let user = null;
    try {
      user = await everything.auth.getUser();
    } catch {
      /* pages still load; the avatar falls back to initials */
    }
    const collab = {
      request: (server, op, data) => call(everything, server, { op, ...data }),
      deploy: (progress) => deploy(everything, progress),
      refresh: (server) => refreshDeployment(everything, server),
      events: everything.events || null,
      grantEvents: (space) => grantEvents(everything, space),
    };
    start({
      backend: everythingBackend(everything),
      kv: everythingKv(everything),
      cache: await indexedDbCache(),
      user,
      env,
      collab,
      // Inside the Everything desktop the session is Everything's, so no sign-out is offered.
      onSignOut:
        env === 'app'
          ? null
          : async () => {
              await everything.auth.signOut();
              location.hash = '';
              location.reload();
            },
      picture: profilePicture(),
      link,
    });
  };
  if (env === 'app' || everything.auth.isSignedIn()) begin();
  else signInScreen(begin, !!link);
}

boot();
