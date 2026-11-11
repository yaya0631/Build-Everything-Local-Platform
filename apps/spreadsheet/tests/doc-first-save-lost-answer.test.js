import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc, UNTITLED } from '../src/lib/doc.js';
import { installMockEverything } from './helpers/mock-everything.js';

let mock;
beforeEach(() => {
  mock = installMockEverything();
  vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete globalThis.everything; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The next write reaches the drive, but its answer is lost on the way back. */
function loseNextAnswer() {
  const write = everything.fs.write;
  everything.fs.write = async (...args) => {
    everything.fs.write = write;
    await write(...args);
    throw new Error('Failed to fetch');
  };
}

// A new spreadsheet's first save whose answer was lost had made the file all the same; the retry found the name
// taken and saved a second file, "Untitled spreadsheet 2", leaving the first behind as a stray copy.
it('saves into the file a first save made when its answer was lost, not into a second one', async () => {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'x');
  loseNextAnswer();
  expect(await doc.save({ auto: true })).toBe(false);
  expect(doc.path).toBe(null);
  expect(await doc.save({ auto: true })).toBe(true);
  expect(doc.path).toBe(`Spreadsheets/${UNTITLED}.xlsx`);
  expect([...mock.fs.keys()].filter((k) => !k.includes('.versions'))).toEqual([`Spreadsheets/${UNTITLED}.xlsx`]);
  doc.destroy();
});

it('still saves under a new name when the file at that name is not the one this document wrote', async () => {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'x');
  const write = everything.fs.write;
  everything.fs.write = async () => { everything.fs.write = write; throw new Error('Failed to fetch'); };
  expect(await doc.save({ auto: true })).toBe(false);
  // Another tab took the name meanwhile.
  await write(`Spreadsheets/${UNTITLED}.xlsx`, new Blob(['theirs']));
  expect(await doc.save({ auto: true })).toBe(true);
  expect(doc.path).toBe(`Spreadsheets/${UNTITLED} 2.xlsx`);
  expect(mock.fs.get(`Spreadsheets/${UNTITLED}.xlsx`).blob.size).toBe(6);
  doc.destroy();
});
