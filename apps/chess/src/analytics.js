// Product analytics through an optional local sink. Only named events with
// a few plain properties are sent, never game state or player details.
// Without a sink, as in tests, every call is a no-op.
function cleanProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props || {})) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

export function track(event, props) {
  try {
    const sink = globalThis.__everythingAnalytics;
    if (typeof sink === 'function') sink(event, { props: cleanProps(props) });
  } catch {
    /* ignore — analytics must never surface to the player */
  }
}
