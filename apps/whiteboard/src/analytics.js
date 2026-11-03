// Product analytics through an optional local sink. Only named events with a
// few plain properties are sent, never board content, titles, names, or
// addresses. Without a sink, as in tests, every call is a no-op.
export function track(event, props) {
  try {
    const sink = globalThis.__everythingAnalytics;
    if (typeof sink !== "function") return;
    sink(event, props ? { props } : undefined);
  } catch {}
}
