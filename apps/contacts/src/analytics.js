// Thin, fail-safe wrapper for local product events. Analytics is best-effort:
// if no local sink is installed, tracking is a silent no-op so it can never
// break a user action.
//
// We track only a small set of "value" moments — getting contacts in (added /
// imported) and putting stored data to use (copied) — not general activity.

/**
 * Record a product event.
 * @param {string} event   Event name, e.g. 'Contact Added'.
 * @param {Record<string, string|number>} [props] Optional custom properties.
 */
export function track(event, props) {
  try {
    const sink = globalThis.__everythingAnalytics
    if (typeof sink === 'function') sink(event, props ? { props } : undefined)
  } catch (_e) {
    /* analytics must never throw into a user action */
  }
}
