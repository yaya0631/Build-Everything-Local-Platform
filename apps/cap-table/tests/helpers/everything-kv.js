/** An atomic KV backend; separate SDK clients can share this one backend. */
export function everythingBackend() {
  const values = new Map();
  const calls = [];
  const clone = (value) => structuredClone(value);
  const client = () => ({
    get: async (key) => {
      calls.push({ method: 'get', key });
      return clone(values.get(key) ?? null);
    },
    set: async (key, value) => {
      calls.push({ method: 'set', key, value: clone(value) });
      if (new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length > 400_000) {
        throw new Error('KV value exceeds 400 KB');
      }
      values.set(key, clone(value));
      return true;
    },
    add: async (key, items) => {
      calls.push({ method: 'add', key, value: clone(items) });
      const previous = values.get(key) ?? [];
      if (!Array.isArray(previous)) throw new Error('Expected a list');
      const next = [...previous, ...clone(items)];
      values.set(key, next);
      return clone(next);
    },
    del: async (key) => {
      calls.push({ method: 'del', key });
      return values.delete(key);
    },
  });
  const install = () => {
    globalThis.everything = { kv: client(), auth: { getUser: async () => ({ uuid: 'test', username: 'test' }) } };
    return globalThis.everything.kv;
  };
  return { values, calls, client, install };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
