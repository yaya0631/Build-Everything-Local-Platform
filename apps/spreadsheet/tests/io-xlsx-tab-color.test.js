import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// A sheet's tab colour travels in this app's sidecar; another program's <sheetPr><tabColor>
// was ignored, so an Excel file's coloured tabs opened grey and were saved back that way.
const ROWS = '<row r="1"><c r="A1"><v>1</v></c></row>';

it('reads the tab colour another program wrote, and keeps it through a save', async () => {
  const bytes = otherProgramsXlsx({
    sheetNames: ['Red', 'Themed', 'Plain', 'Odd'],
    sheetXml: {
      Red: { head: '<sheetPr><tabColor rgb="FFFF0000"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1"/>', rows: ROWS },
      Themed: { head: '<sheetPr><tabColor theme="5" tint="0.39997558519241921"/></sheetPr>', rows: ROWS },
      Plain: { head: '<sheetPr codeName="Sheet3"/>', rows: ROWS },
      Odd: { head: '<sheetPr><tabColor rgb="00ABCDEFGH"/></sheetPr>', rows: ROWS },
    },
  });
  const wb = await workbookFromFile(bytes, 'tabs.xlsx');
  expect(wb.sheets.map((s) => s.color)).toEqual(['#ff0000', '#d99694', null, null]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'tabs.xlsx');
  expect(back.sheets.map((s) => s.color)).toEqual(['#ff0000', '#d99694', null, null]);
});

it('lets the sidecar\'s own record win over a tab colour written into the same file', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setSheetColor(wb.activeSheetId, '#00ff00');
  const saved = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const X = await import('../src/vendor/xlsx.mjs');
  const zip = X.CFB.read(saved, { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const xml = new TextDecoder().decode(sheet.content).replace(/<sheetPr\b[^>]*\/>|<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>|(<dimension|<sheetViews|<sheetData)/, (m, open) => `<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>${open || ''}`);
  sheet.content = new TextEncoder().encode(xml);
  sheet.size = sheet.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'mine.xlsx');
  expect(back.sheets[0].color).toBe('#00ff00');
});
