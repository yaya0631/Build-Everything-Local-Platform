// @vitest-environment jsdom
/**
 * Someone removed from a shared fleet opens it (a file of its own, so no
 * earlier boot's listeners are listening).
 */
import { describe, it, expect } from 'vitest';
import { fakeEverything, teamExec, boot, settle } from './review-sync-boot-helpers.js';

describe('removed from a fleet', () => {
  it('says so once and switches back once', async () => {
    const url = 'http://fleet-abc.localhost:8443';
    const server = { role: 'member', calls: [], removed: true };
    const everything = fakeEverything({ exec: teamExec(server) });
    everything.kv.data.set('fl1:workspaces', { current: url, own: {}, joined: [{ url, business: 'Acme', role: 'member' }] });
    await boot(everything);
    await settle(2300); // past the first retry
    const toasts = [...document.querySelectorAll('.toast')].filter((t) => /no longer have access/.test(t.textContent));
    expect(toasts).toHaveLength(1);
    // Let the switch back finish before the test environment is torn down.
    for (let i = 0; i < 100 && everything.kv.data.get('fl1:workspaces').joined.length; i++) await settle(10);
    expect(everything.kv.data.get('fl1:workspaces').joined).toEqual([]);
    await settle(50);
  }, 10000);
});
