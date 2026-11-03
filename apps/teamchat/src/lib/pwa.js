/**
 * The installable app: service worker registration with an update prompt,
 * push subscription per workspace, the install prompt, and the iOS hint.
 * All of it is optional: nothing here runs in the dev harness, and every
 * capability is probed before use.
 */
import { api } from './api.js';

let registration = null;
let deferredInstall = null;
let refreshing = false;

export const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
export const pushSupported = () => swSupported() && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
export const isStandalone = () => (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;

/**
 * Register sw.js (built next to the app) and report a waiting update. The
 * page reloads once the new worker takes over, and only when the user asked.
 */
export async function registerServiceWorker({ onUpdate, onMessage, onRoute } = {}) {
  if (!swSupported() || !import.meta.env?.PROD) return null;
  // Whether a worker controls this page: the first worker to claim it is
  // not an update, and must not reload a page mid-sign-in. A page that
  // started uncontrolled (a first visit) is controlled from that claim on,
  // so an update that lands later in the tab's life reloads it like any
  // other; and a reload the user asked for happens whatever the page's
  // history, since the new worker drops the old build's cache as it takes
  // over and the old page's lazy chunks are then gone.
  let controlled = !!navigator.serviceWorker.controller;
  let asked = false;
  try {
    registration = await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    console.warn('Service worker registration failed', e);
    return null;
  }
  const apply = (worker) => () => {
    asked = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  const watch = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onUpdate?.(apply(worker));
    });
  };
  if (registration.waiting && navigator.serviceWorker.controller) onUpdate?.(apply(registration.waiting));
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled && !asked) {
      controlled = true;
      return;
    }
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    // The push handler asking which workspace this window shows, answered
    // over the port it sent; it waits briefly, so an answer that cannot be
    // had (no onRoute, a throw) is given as null rather than never.
    if (e.data?.type === 'route?' && e.ports?.[0]) {
      let route = null;
      try {
        route = onRoute?.() || null;
      } catch { /* answered as null */ }
      e.ports[0].postMessage(route);
      return;
    }
    onMessage?.(e.data);
  });
  // Look for a new build whenever the tab comes back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) registration.update().catch(() => {}); });
  return registration;
}

export function captureInstallPrompt(onAvailable) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    onAvailable?.();
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; onAvailable?.(); });
}

export const canInstall = () => !!deferredInstall && !isStandalone();

export async function promptInstall() {
  if (!deferredInstall) return false;
  const e = deferredInstall;
  deferredInstall = null;
  e.prompt();
  const choice = await e.userChoice.catch(() => null);
  return choice?.outcome === 'accepted';
}

/* ---- push --------------------------------------------------------------- */

function toKey(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The device's offset from UTC in minutes, as the workers are told it (see pushPrefs). */
export const localTzOffset = () => -new Date().getTimezoneOffset();
/** The offset the workers were last told (see subscribePush); null until one was. */
let sentTzOffset = null;

/** What the worker needs to respect quiet hours and pauses while the app is closed. */
export function pushPrefs(prefs = {}) {
  const minutes = (hm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const d = prefs.dnd || {};
  return {
    pauseUntil: prefs.pauseUntil || null,
    tzOffset: localTzOffset(),
    dnd: d.enabled && minutes(d.from) != null && minutes(d.to) != null ? { enabled: true, from: minutes(d.from), to: minutes(d.to) } : { enabled: false },
  };
}

/**
 * Has the device's clock moved to another offset from UTC since the workers
 * were last told it (the clocks changed for daylight saving, the device
 * travelled)? The workers keep quiet hours by the offset they were told,
 * since they cannot know the zone, and were told it only as a workspace
 * opened or a setting changed: after the spring or autumn change, pushes
 * kept the old hour's quiet hours (rang in the last hour of the window, or
 * fell silent an hour past it) until the app was next opened. The store
 * asks this on every poll and tells them again (see syncPushPrefs). Nothing
 * has moved while nothing was told.
 */
export function pushOffsetMoved() {
  return sentTzOffset !== null && sentTzOffset !== localTzOffset();
}

/** Tests: the offset the workers were last told. */
export function _notePushOffset(tz) {
  sentTzOffset = tz;
}

/**
 * Subscribe this device to pushes from one workspace's worker (idempotent).
 * Only the user's own toggle may put the permission prompt up (interactive);
 * the background callers — the account preference found on at bootstrap, a
 * quiet-hours change fanning out — must not interrupt a page the user did
 * not ask anything of, so without permission already granted they give up.
 */
export async function subscribePush(wsId, prefs, { interactive = false } = {}) {
  if (!pushSupported() || !registration) throw new Error('Push is not available here');
  if (Notification.permission === 'denied') throw new Error('Notifications are blocked in your browser settings');
  if (Notification.permission !== 'granted' && (!interactive || (await Notification.requestPermission()) !== 'granted')) throw new Error('Notification permission was not granted');
  const { key } = await api.pushKey(wsId);
  let sub = await registration.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    const want = toKey(key);
    // Another workspace's worker signs with a different key; browsers allow one
    // key per origin, so the subscription is re-made for this worker's key.
    if (cur && (cur.length !== want.length || cur.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) });
  const sent = pushPrefs(prefs);
  await api.pushSubscribe(wsId, { subscription: sub.toJSON(), prefs: sent, preview: prefs?.notifyPreview !== false });
  sentTzOffset = sent.tzOffset;
  return sub;
}

export async function unsubscribePush(wsId) {
  if (!registration) return;
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(wsId, sub.endpoint).catch(() => {});
}

/**
 * Let go of this device's browser-side subscription (after the workers were
 * told). Workers not told keep a dead endpoint; their next push answers
 * 404/410 and they drop it themselves (see sendPush 'gone').
 */
export async function dropPushSubscription() {
  sentTzOffset = null; // nothing is pushed here any more, so no offset needs keeping up
  if (!registration) return;
  const sub = await registration.pushManager.getSubscription();
  if (sub) await sub.unsubscribe().catch(() => {});
}

export async function currentPushEndpoint() {
  const sub = await registration?.pushManager.getSubscription();
  return sub?.endpoint || null;
}
