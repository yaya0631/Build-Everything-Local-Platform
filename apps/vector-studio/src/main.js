/**
 * Entry point: apply the theme, connect to Everything (sign-in state, profile
 * picture, launch items), build the app and register feature modules.
 */
import './styles/index.css';
import { Prefs } from './prefs.js';
import { App } from './app.js';
import { applyTheme } from './theme.js';
import { installFeatures } from './features.js';

const prefs = new Prefs();
applyTheme(prefs.get('theme'));

function waitForEverything(timeout = 5000) {
  return new Promise((resolve) => {
    if (typeof window.everything !== 'undefined') return resolve(window.everything);
    const t0 = performance.now();
    const tick = () => {
      if (typeof window.everything !== 'undefined') resolve(window.everything);
      else if (performance.now() - t0 > timeout) resolve(null);
      else setTimeout(tick, 50);
    };
    tick();
  });
}

async function profile(everything) {
  try {
    const user = await everything.auth.getUser();
    let picture = null;
    try {
      picture = await everything.auth.getProfilePicture();
    } catch {
      picture = null;
    }
    return { user, picture };
  } catch {
    return { user: null, picture: null };
  }
}

async function boot() {
  const root = document.getElementById('app');
  const everything = await waitForEverything();
  const env = everything?.env || 'web';
  let user = null;
  let picture = null;
  if (everything && (env === 'app' || everything.auth.isSignedIn())) ({ user, picture } = await profile(everything));

  const app = new App(root, {
    prefs,
    env,
    user,
    picture,
    onSignIn: everything
      ? async () => {
          try {
            await everything.auth.signIn();
            const p = await profile(everything);
            app.setUser(p.user, p.picture);
          } catch {
            app.notify('Sign in was cancelled.');
          }
        }
      : null,
    onSignOut:
      everything && env !== 'app'
        ? async () => {
            await everything.auth.signOut();
            app.setUser(null, null);
          }
        : null,
  });
  app.everything = everything;
  installFeatures(app);
  app.start();
  window.addEventListener('themechange', () => {
    for (const v of app.views.values()) v.refreshColors();
    app.rulers?.refresh();
  });
  app.emit('ready');
  if (!app.editors.length && app.prefs.get('showStartScreen') !== false) app.showHome();
  if (import.meta.env.DEV) window.vs = app;
}

boot();
