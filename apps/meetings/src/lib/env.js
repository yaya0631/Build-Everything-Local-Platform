/** Access to the everything.js global, with a friendly failure mode. */

export function hasEverything() {
  return typeof window !== 'undefined' && !!window.everything;
}

export function getEverything() {
  if (!hasEverything()) {
    throw new Error(
      'Everything.js is not loaded. Check your connection to /sdk/everything.js and reload the page.'
    );
  }
  return window.everything;
}
