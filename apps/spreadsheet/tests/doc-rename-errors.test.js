import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { installMockEverything } from './helpers/mock-everything.js';

let mock;
beforeEach(() => { mock = installMockEverything(); });
afterEach(() => { delete globalThis.everything; vi.restoreAllMocks(); });

// A network error while checking whether the new name was free escaped as a rejected
// promise: the prompt closed and nothing told the user why nothing happened.
it('returns the failure as a message from rename and save-as instead of rejecting', async () => {
  const doc = new Doc({ name: 'Plan', path: 'Spreadsheets/Plan.xlsx' });
  everything.fs.stat = async () => { throw new Error('Network request failed'); };
  await expect(doc.rename('Budget')).resolves.toBe('Could not rename the file: Everything could not be reached. Check your connection, then try again');
  expect(doc.path).toBe('Spreadsheets/Plan.xlsx');
  await expect(doc.saveAs('Copy')).resolves.toBe('Could not save a copy: Everything could not be reached. Check your connection, then try again');
  expect(mock.calls.filter(([op]) => op === 'write')).toEqual([]);
});
