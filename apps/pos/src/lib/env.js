/**
 * Where Everything.js is running: 'app' (inside an Everything app window), 'web', or
 * 'gui'. Inside an Everything app the platform owns the session, so the app never
 * offers sign-out there.
 */
export function everythingEnv() {
  return typeof everything !== 'undefined' ? everything.env : 'web';
}

export function isEverythingApp() {
  return everythingEnv() === 'app';
}
