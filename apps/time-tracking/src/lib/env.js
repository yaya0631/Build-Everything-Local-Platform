/**
 * Where the app is running. Inside Everything (env 'app') the platform owns the
 * session, so the app must not offer sign-out; on the open web it must.
 * http://localhost:8443/Utils/env/
 */
export function isEverythingApp() {
  return typeof everything !== 'undefined' && everything.env === 'app';
}
