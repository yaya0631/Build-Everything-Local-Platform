import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// Row and column groups travel in this app's sidecar; another program's outline levels
// (<row outlineLevel="1">, <col outlineLevel="1">), which the reader hands on, were ignored,
// so an Excel file's groups opened flat and were saved back flat.
const cell = (r) => `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`;

it('reads nested row and column groups from another program\'s outline levels, collapsed where hidden', async () => {
  const rows = cell(1)
    + `<row r="2" outlineLevel="1"><c r="A2"><v>2</v></c></row>`
    + `<row r="3" outlineLevel="2" hidden="1"><c r="A3"><v>3</v></c></row>`
    + `<row r="4" outlineLevel="2" hidden="1"><c r="A4"><v>4</v></c></row>`
    + `<row r="5" outlineLevel="1" collapsed="1"><c r="A5"><v>5</v></c></row>`
    + cell(6)
    + `<row r="8" outlineLevel="1"><c r="A8"><v>8</v></c></row>`;
  const bytes = otherProgramsXlsx({
    sheetXml: { Data: { head: '<dimension ref="A1:D8"/><sheetFormatPr defaultRowHeight="15" outlineLevelRow="2" outlineLevelCol="1"/><cols><col min="2" max="3" width="9" outlineLevel="1"/><col min="4" max="4" width="9"/></cols>', rows } },
  });
  const wb = await workbookFromFile(bytes, 'outline.xlsx');
  const sheet = wb.sheets[0];
  expect(sheet.groups).toEqual({
    rows: [{ from: 1, to: 4, collapsed: false }, { from: 2, to: 3, collapsed: true }, { from: 7, to: 7, collapsed: false }],
    cols: [{ from: 1, to: 2, collapsed: false }],
  });
  expect([...sheet.hiddenRows]).toEqual([2, 3]);
  // The groups work as the app's own: expanding the collapsed one shows its rows again.
  wb.toggleGroup(sheet.id, 'row', 2, 3);
  expect([...wb.sheets[0].hiddenRows]).toEqual([]);
  expect(wb.sheets[0].groups.rows[1]).toEqual({ from: 2, to: 3, collapsed: false });
  wb.undo(); // a structural step: the live sheet object is replaced, so it is read from the book again
  expect(wb.sheets[0].groups.rows[1]).toEqual({ from: 2, to: 3, collapsed: true });
  const back = await workbookFromFile(await workbookToXlsx(wb), 'outline.xlsx');
  expect(back.sheets[0].groups).toEqual(wb.sheets[0].groups);
  expect([...back.sheets[0].hiddenRows]).toEqual([2, 3]);
});

it('reads no groups from a file without outline levels', async () => {
  const wb = await workbookFromFile(otherProgramsXlsx({ sheetXml: { Data: { rows: cell(1) + `<row r="2" hidden="1"><c r="A2"><v>2</v></c></row>` } } }), 'flat.xlsx');
  expect(wb.sheets[0].groups).toEqual({ rows: [], cols: [] });
  expect([...wb.sheets[0].hiddenRows]).toEqual([1]);
});

it('lets the sidecar\'s own record win over outline levels written into the same file', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.groupLines(wb.activeSheetId, 'row', 5, 6);
  const saved = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const X = await import('../src/vendor/xlsx.mjs');
  const zip = X.CFB.read(saved, { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const xml = new TextDecoder().decode(sheet.content).replace(/<row r="1"/, '<row r="1" outlineLevel="1"');
  sheet.content = new TextEncoder().encode(xml);
  sheet.size = sheet.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'mine.xlsx');
  expect(back.sheets[0].groups).toEqual({ rows: [{ from: 5, to: 6, collapsed: false }], cols: [] });
});
