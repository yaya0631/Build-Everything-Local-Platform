import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isSignedIn, pullStats, pushStats, pullSave, pushSave, clearSave,
} from './everything-sync.js';

// The save/stats arbitration in main.js depends on this module's contract
// exactly: a failed cloud read must be distinguishable from a key that has
// never been written, or a transient failure gets treated as "empty" and a
// worse local value silently overwrites a better remote one. This module is
// trivially fakeable by assigning a fake `everything` onto globalThis — vitest
// runs in the node environment, and everything-sync.js only ever references the
// bare global `everything`, so a plain `globalThis.everything = {...}` is enough.
const ORIGINAL_EVERYTHING = globalThis.everything;

afterEach(() => {
  if (ORIGINAL_EVERYTHING === undefined) delete globalThis.everything;
  else globalThis.everything = ORIGINAL_EVERYTHING;
});

function installFakeEverything({ signedIn = true, kvGet, kvSet, maxValueSize = 100000 } = {}) {
  globalThis.everything = {
    auth: {
      isSignedIn: async () => {
        if (typeof signedIn === 'function') return signedIn();
        return signedIn;
      },
    },
    kv: {
      MAX_VALUE_SIZE: maxValueSize,
      get: kvGet || (async () => null),
      set: kvSet || (async () => {}),
      del: async () => {},
    },
  };
}

describe('isSignedIn', () => {
  it('returns false rather than throwing when everything is undefined entirely', async () => {
    delete globalThis.everything;
    await expect(isSignedIn()).resolves.toBe(false);
  });

  it('returns false rather than throwing when the underlying call rejects', async () => {
    installFakeEverything({ signedIn: () => { throw new Error('boom'); } });
    await expect(isSignedIn()).resolves.toBe(false);
  });

  it('returns true when the underlying call resolves true', async () => {
    installFakeEverything({ signedIn: true });
    await expect(isSignedIn()).resolves.toBe(true);
  });

  it('returns false when the underlying call resolves false', async () => {
    installFakeEverything({ signedIn: false });
    await expect(isSignedIn()).resolves.toBe(false);
  });
});

describe('pullStats / pullSave (read contract)', () => {
  it('yields { ok: false } on a read failure', async () => {
    installFakeEverything({ signedIn: true, kvGet: async () => { throw new Error('network'); } });
    const result = await pullStats();
    expect(result.ok).toBe(false);
  });

  it('yields { ok: true, value: null } for a key that has never been written — '
    + 'this is the distinction the original bug conflated', async () => {
    installFakeEverything({ signedIn: true, kvGet: async () => null });
    const result = await pullSave();
    expect(result).toEqual({ ok: true, value: null });
  });

  it('yields { ok: false } when not signed in, not { ok: true, value: null } — '
    + 'signed-out is "unknown", not "empty"', async () => {
    installFakeEverything({ signedIn: false });
    const result = await pullStats();
    expect(result.ok).toBe(false);
  });

  it('parses and returns a stored value', async () => {
    installFakeEverything({ signedIn: true, kvGet: async () => JSON.stringify({ played: 3 }) });
    const result = await pullStats();
    expect(result).toEqual({ ok: true, value: { played: 3 } });
  });

  it('nothing throws when everything is undefined entirely', async () => {
    delete globalThis.everything;
    await expect(pullStats()).resolves.toEqual({ ok: false, value: null });
    await expect(pullSave()).resolves.toEqual({ ok: false, value: null });
  });
});

describe('kvSet contract (pushStats / pushSave)', () => {
  it('refuses (returns false) when not signed in', async () => {
    installFakeEverything({ signedIn: false });
    await expect(pushStats({ played: 1 })).resolves.toBe(false);
  });

  it('refuses (returns false) when the payload exceeds MAX_VALUE_SIZE', async () => {
    installFakeEverything({ signedIn: true, maxValueSize: 4 });
    await expect(pushSave({ big: 'this is well over four bytes' })).resolves.toBe(false);
  });

  it('succeeds and writes the JSON payload when signed in and within the size limit', async () => {
    let written = null;
    installFakeEverything({
      signedIn: true,
      maxValueSize: 1000,
      kvSet: async (key, value) => { written = { key, value }; },
    });
    await expect(pushStats({ played: 1 })).resolves.toBe(true);
    expect(written).toEqual({ key: 'stats', value: JSON.stringify({ played: 1 }) });
  });

  it('returns false rather than throwing when the underlying set call rejects', async () => {
    installFakeEverything({ signedIn: true, kvSet: async () => { throw new Error('boom'); } });
    await expect(pushSave({ v: 1 })).resolves.toBe(false);
  });

  it('nothing throws when everything is undefined entirely', async () => {
    delete globalThis.everything;
    await expect(pushStats({})).resolves.toBe(false);
    await expect(pushSave({})).resolves.toBe(false);
  });
});

describe('clearSave', () => {
  it('nothing throws when everything is undefined entirely', async () => {
    delete globalThis.everything;
    await expect(clearSave()).resolves.toBeUndefined();
  });

  it('nothing throws when not signed in', async () => {
    installFakeEverything({ signedIn: false });
    await expect(clearSave()).resolves.toBeUndefined();
  });

  it('nothing throws when the underlying del call rejects', async () => {
    globalThis.everything = {
      auth: { isSignedIn: async () => true },
      kv: { del: async () => { throw new Error('boom'); }, MAX_VALUE_SIZE: 100000, get: async () => null, set: async () => {} },
    };
    await expect(clearSave()).resolves.toBeUndefined();
  });
});
