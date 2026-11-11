import { afterEach, describe, expect, it, vi } from 'vitest';
import * as account from '../src/net/everything.js';

/** Enough of everything.js for this module's purposes. */
const fakeEverything = (overrides = {}) => ({
  env: 'web',
  auth: {
    isSignedIn: () => true,
    getUser: async () => ({ username: 'tester' }),
    signIn: async () => {},
    signOut: async () => {},
  },
  kv: { get: async () => null, set: async () => {}, del: async () => {} },
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('availability', () => {
  it('reports unavailable when the script never loaded', () => {
    expect(account.isAvailable()).toBe(false);
    expect(account.getEverything()).toBeNull();
  });

  it('reports unavailable when the pieces it needs are missing', () => {
    vi.stubGlobal('everything', { env: 'web' });
    expect(account.isAvailable()).toBe(false);
    vi.stubGlobal('everything', { env: 'web', auth: {} });
    expect(account.isAvailable()).toBe(false);
  });

  it('reports available with auth and kv present', () => {
    vi.stubGlobal('everything', fakeEverything());
    expect(account.isAvailable()).toBe(true);
  });
});

describe('environment', () => {
  it('defaults to web when there is no everything to ask', () => {
    expect(account.environment()).toBe('web');
    expect(account.isHostedSession()).toBe(false);
  });

  it('reads the environment everything reports', () => {
    for (const env of ['app', 'gui', 'web', 'nodejs']) {
      vi.stubGlobal('everything', fakeEverything({ env }));
      expect(account.environment()).toBe(env);
    }
  });

  it('treats an app window and the Everything desktop as sessions it does not own', () => {
    // The requirement this encodes: inside an Everything app there must be no sign-out
    // button, because the session belongs to the shell and ending it would
    // strand the player in a window they cannot sign back into.
    vi.stubGlobal('everything', fakeEverything({ env: 'app' }));
    expect(account.isHostedSession()).toBe(true);
    vi.stubGlobal('everything', fakeEverything({ env: 'gui' }));
    expect(account.isHostedSession()).toBe(true);
  });

  it('treats an ordinary web page as a session the app manages', () => {
    vi.stubGlobal('everything', fakeEverything({ env: 'web' }));
    expect(account.isHostedSession()).toBe(false);
  });
});

describe('isSignedIn', () => {
  it('is false, not an error, when everything is absent', async () => {
    expect(await account.isSignedIn()).toBe(false);
  });

  it('reflects what everything says', async () => {
    vi.stubGlobal('everything', fakeEverything());
    expect(await account.isSignedIn()).toBe(true);
    vi.stubGlobal('everything', fakeEverything({ auth: { isSignedIn: () => false } }));
    expect(await account.isSignedIn()).toBe(false);
  });

  it('swallows a thrown check rather than breaking the app', async () => {
    vi.stubGlobal(
      'everything',
      fakeEverything({
        auth: {
          isSignedIn: () => {
            throw new Error('offline');
          },
        },
      }),
    );
    expect(await account.isSignedIn()).toBe(false);
  });

  it('handles an async check as readily as a sync one', async () => {
    vi.stubGlobal('everything', fakeEverything({ auth: { isSignedIn: async () => true } }));
    expect(await account.isSignedIn()).toBe(true);
  });
});

describe('signIn', () => {
  it('reports success once a session exists', async () => {
    let signedIn = false;
    vi.stubGlobal(
      'everything',
      fakeEverything({
        auth: {
          isSignedIn: () => signedIn,
          signIn: async () => {
            signedIn = true;
          },
        },
      }),
    );
    expect(await account.signIn()).toBe(true);
  });

  it('reports failure when the dialog is dismissed', async () => {
    vi.stubGlobal(
      'everything',
      fakeEverything({
        auth: {
          isSignedIn: () => false,
          signIn: async () => {
            throw new Error('cancelled');
          },
        },
      }),
    );
    expect(await account.signIn()).toBe(false);
  });

  it('reports failure when everything is absent', async () => {
    expect(await account.signIn()).toBe(false);
  });
});

describe('signOut', () => {
  it('ends the session on an ordinary web page', async () => {
    const signOut = vi.fn(async () => {});
    vi.stubGlobal('everything', fakeEverything({ auth: { isSignedIn: () => true, signOut } }));
    await account.signOut();
    expect(signOut).toHaveBeenCalled();
  });

  it('does nothing inside an Everything app, whatever the caller asks', async () => {
    const signOut = vi.fn(async () => {});
    vi.stubGlobal('everything', fakeEverything({ env: 'app', auth: { isSignedIn: () => true, signOut } }));
    await account.signOut();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('swallows a failure rather than leaving the caller mid-throw', async () => {
    vi.stubGlobal(
      'everything',
      fakeEverything({
        auth: {
          isSignedIn: () => true,
          signOut: async () => {
            throw new Error('network');
          },
        },
      }),
    );
    await expect(account.signOut()).resolves.toBeUndefined();
  });
});

describe('getUser', () => {
  it('returns the signed-in user', async () => {
    vi.stubGlobal('everything', fakeEverything());
    expect((await account.getUser()).username).toBe('tester');
  });

  it('returns null when signed out, without asking everything', async () => {
    const getUser = vi.fn();
    vi.stubGlobal('everything', fakeEverything({ auth: { isSignedIn: () => false, getUser } }));
    expect(await account.getUser()).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('returns null when the lookup throws', async () => {
    vi.stubGlobal(
      'everything',
      fakeEverything({
        auth: {
          isSignedIn: () => true,
          getUser: async () => {
            throw new Error('nope');
          },
        },
      }),
    );
    expect(await account.getUser()).toBeNull();
  });
});

describe('the key-value store', () => {
  it('separates "nothing stored" from "could not read"', async () => {
    // The distinction the whole sync design rests on: merging against a failed
    // read would let a dropped connection wipe a player's records.
    vi.stubGlobal('everything', fakeEverything({ kv: { get: async () => null } }));
    expect(await account.pullStats()).toEqual({ ok: true, value: null });

    vi.stubGlobal(
      'everything',
      fakeEverything({
        kv: {
          get: async () => {
            throw new Error('offline');
          },
        },
      }),
    );
    expect(await account.pullStats()).toEqual({ ok: false, value: null });
  });

  it('parses a stored JSON string', async () => {
    vi.stubGlobal('everything', fakeEverything({ kv: { get: async () => '{"solved":3}' } }));
    expect(await account.pullStats()).toEqual({ ok: true, value: { solved: 3 } });
  });

  it('accepts a store that already hands back objects', async () => {
    vi.stubGlobal('everything', fakeEverything({ kv: { get: async () => ({ solved: 3 }) } }));
    expect(await account.pullStats()).toEqual({ ok: true, value: { solved: 3 } });
  });

  it('treats unparseable stored data as a failed read, not as empty', async () => {
    vi.stubGlobal('everything', fakeEverything({ kv: { get: async () => '{broken' } }));
    expect(await account.pullStats()).toEqual({ ok: false, value: null });
  });

  it('reads nothing and writes nothing when signed out', async () => {
    const set = vi.fn();
    vi.stubGlobal('everything', fakeEverything({ auth: { isSignedIn: () => false }, kv: { set } }));
    expect(await account.pullSave()).toEqual({ ok: false, value: null });
    expect(await account.pushSave({})).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});
