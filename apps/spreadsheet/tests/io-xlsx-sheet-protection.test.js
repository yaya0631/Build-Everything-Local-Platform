import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// Sheet protection travels in this app's sidecar; another program's <sheetProtection sheet="1">
// was ignored, so a protected Excel sheet opened editable and was saved back unprotected.
const ROWS = '<row r="1"><c r="A1"><v>1</v></c></row>';

it('reads sheet protection another program wrote, and keeps it through a save', async () => {
  const bytes = otherProgramsXlsx({
    sheetNames: ['Locked', 'Hashed', 'Objects', 'Plain'],
    sheetXml: {
      Locked: { rows: ROWS, tail: '<sheetProtection sheet="1" objects="1" scenarios="1"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' },
      Hashed: { rows: ROWS, tail: '<sheetProtection algorithmName="SHA-512" hashValue="abc=" saltValue="def=" spinCount="100000" sheet="true" formatCells="0"/>' },
      // Protection of drawings and scenarios alone leaves the cells editable.
      Objects: { rows: ROWS, tail: '<sheetProtection objects="1" scenarios="1"/>' },
      Plain: { rows: ROWS, tail: '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' },
    },
  });
  const wb = await workbookFromFile(bytes, 'locked.xlsx');
  expect(wb.sheets.map((s) => s.protected)).toEqual([true, true, false, false]);
  // A protected sheet refuses the edit; the plain one takes it.
  wb.setInput(wb.sheets[0].id, 0, 0, '2');
  expect(wb.getValue(wb.sheets[0].id, 0, 0)).toBe(1);
  wb.setInput(wb.sheets[3].id, 0, 0, '2');
  expect(wb.getValue(wb.sheets[3].id, 0, 0)).toBe(2);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'locked.xlsx');
  expect(back.sheets.map((s) => s.protected)).toEqual([true, true, false, false]);
});

it('lets the sidecar\'s own record win over protection written into the same file', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setFrozen(wb.activeSheetId, 1, 0); // anything of the app's own, so the file carries a sidecar entry for the sheet
  const saved = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const X = await import('../src/vendor/xlsx.mjs');
  const zip = X.CFB.read(saved, { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const xml = new TextDecoder().decode(sheet.content).replace('</sheetData>', '</sheetData><sheetProtection sheet="1"/>');
  sheet.content = new TextEncoder().encode(xml);
  sheet.size = sheet.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'mine.xlsx');
  expect(back.sheets[0].protected).toBe(false);
});
