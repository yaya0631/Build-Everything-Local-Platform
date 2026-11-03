import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// Whether a sheet shows gridlines travels in this app's sidecar; another program's
// <sheetView showGridLines="0"> was ignored, so a dashboard laid out without gridlines
// opened with them, and was saved back with them.
const ROWS = '<row r="1"><c r="A1"><v>1</v></c></row>';
const views = (attrs) => `<sheetViews><sheetView ${attrs} workbookViewId="0"/></sheetViews>`;

it('reads the gridline setting another program wrote, and keeps it through a save', async () => {
  const bytes = otherProgramsXlsx({
    sheetNames: ['Off', 'OffWord', 'On', 'Plain', 'Second'],
    sheetXml: {
      Off: { head: views('showGridLines="0" tabSelected="1"'), rows: ROWS },
      OffWord: { head: views('showGridLines="false"'), rows: ROWS },
      On: { head: views('showGridLines="1"'), rows: ROWS },
      Plain: { head: '<dimension ref="A1"/>', rows: ROWS },
      // Only the first view is the sheet's own; a second (a custom view's) does not count.
      Second: { head: `<sheetViews><sheetView workbookViewId="0"/><sheetView showGridLines="0" workbookViewId="1"/></sheetViews>`, rows: ROWS },
    },
  });
  const wb = await workbookFromFile(bytes, 'dashboard.xlsx');
  expect(wb.sheets.map((s) => s.gridlines)).toEqual([false, false, true, true, true]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'dashboard.xlsx');
  expect(back.sheets.map((s) => s.gridlines)).toEqual([false, false, true, true, true]);
});

it('lets the sidecar\'s own record win over a view written into the same file', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setFrozen(wb.activeSheetId, 1, 0); // anything of the app's own, so the file carries a sidecar entry for the sheet
  const saved = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const X = await import('../src/vendor/xlsx.mjs');
  const zip = X.CFB.read(saved, { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const xml = new TextDecoder().decode(sheet.content).replace(/<sheetViews>[\s\S]*?<\/sheetViews>|(<sheetData)/, (m, open) => `${views('showGridLines="0"')}${open || ''}`);
  sheet.content = new TextEncoder().encode(xml);
  sheet.size = sheet.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'mine.xlsx');
  expect(back.sheets[0].gridlines).toBe(true);
});
