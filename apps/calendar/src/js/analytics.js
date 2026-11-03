/**
 * Thin wrapper around an optional local analytics sink.
 *
 * Analytics is strictly non-essential and best-effort: if no sink is installed
 * or it throws, track() is a silent no-op and never changes app behavior.
 *
 * We track only the few moments a user gets real value from the calendar, each
 * fired ONLY after the underlying action succeeds (so nothing counts while
 * offline, where writes are gated):
 *   - 'Event Created'        — scheduled something new (the core job).
 *   - 'Reminder Set'         — armed the app to notify them (started relying on it).
 *   - 'Calendar Imported'    — brought an existing calendar in (activation).
 *   - 'Booking Link Created' — published a page others can book them through.
 */
export function track(event, props) {
  try {
    const sink = globalThis.__everythingAnalytics;
    if (typeof sink !== 'function') return;
    sink(event, props ? { props } : undefined);
  } catch {
    /* analytics must never break the app */
  }
}
