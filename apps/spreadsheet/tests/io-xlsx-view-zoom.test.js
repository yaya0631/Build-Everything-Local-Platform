import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

it.each(['', '<sheetViews><sheetView workbookViewId="0"/></sheetViews>', '<sheetViews><sheetView workbookViewId="0" zoomScale="bad"/></sheetViews>'])('defaults absent or invalid native zoom to 100%%: %s', async head => {
  const wb = await workbookFromFile(otherProgramsXlsx({ sheetNames: ['Detail', 'Overview'], sheetXml: {
    Detail: { head: '<sheetViews><sheetView workbookViewId="0" zoomScale="175"/></sheetViews>' }, Overview: { head },
  } }), 'views.xlsx');
  expect(wb.sheets.map(s => s.viewZoom)).toEqual([1.75, 1]);
});

it('preserves per-sheet zoom edits, native limits and drafts without recalculating cells', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Small', cells: { '0,0': { f: 'RAND()' } } }, { name: 'Large' }] });
  const first = wb.sheets[0], before = wb.getValue(first.id, 0, 0);
  wb.setSheetView(first.id, { viewZoom: .1, zoomToFit: true });
  wb.setSheetView(wb.sheets[1].id, { viewZoom: 4 });
  expect(wb.dirty).toBe(true); expect(wb.canUndo()).toBe(false);
  expect(first).not.toHaveProperty('zoomToFit');
  expect(wb.getValue(first.id, 0, 0)).toBe(before);
  for (const viewZoom of [0, -.5, 4.01, NaN, Infinity]) wb.setSheetView(first.id, { viewZoom });
  expect(first.viewZoom).toBe(.1);
  const restored = new Workbook(wb.toJSON());
  expect(restored.sheets.map(s => s.viewZoom)).toEqual([.1, 4]);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(restored)).arrayBuffer()), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'native.xlsx');
  expect(back.sheets.map(s => s.viewZoom)).toEqual([.1, 4]);
});

it('keeps current zoom when a structural edit is undone or redone', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.insertRows(id, 0, 2);
  wb.setSheetView(id, { viewZoom: 1.65 });
  wb.undo(); expect(wb.sheet(id).viewZoom).toBe(1.65);
  wb.redo(); expect(wb.sheet(id).viewZoom).toBe(1.65);
});
