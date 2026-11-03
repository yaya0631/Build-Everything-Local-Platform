import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { xlsxAttr } from '../src/core/xlsx-styles.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

const viewTag = bytes => {
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/workbook.xml').content);
  return xml.match(/<workbookView\b[^>]*\/>/)[0];
};

it('keeps the primary Excel window geometry and tab strip through edits, drafts and native XLSX', async () => {
  const source = otherProgramsXlsx({ sheetNames: ['First', 'Second'], patch: { '/xl/workbook.xml': xml =>
    xml.replace('<sheets>', '<bookViews><workbookView xWindow="-240" yWindow="300" windowWidth="15360" windowHeight="8640" tabRatio="425" showHorizontalScroll="0" showVerticalScroll="1" showSheetTabs="0" firstSheet="1" activeTab="1"/></bookViews><sheets>') } });
  const wb = await workbookFromFile(source, 'external.xlsx');
  const first = wb.sheetByName('First'), second = wb.sheetByName('Second');
  expect(wb.activeSheetId).toBe(second.id);
  expect(wb.workbookView).toEqual({ xWindow: -240, yWindow: 300, windowWidth: 15360, windowHeight: 8640,
    tabRatio: 425, showHorizontalScroll: false, showVerticalScroll: true, showSheetTabs: false, firstSheetId: second.id });
  expect(new Workbook(wb.toJSON()).workbookView).toEqual(wb.workbookView);

  wb.moveSheet(second.id, 0);
  wb.setActiveSheet(first.id);
  const exported = await (await workbookToXlsx(wb)).arrayBuffer();
  const tag = viewTag(exported);
  for (const [name, value] of Object.entries({ xWindow: '-240', yWindow: '300', windowWidth: '15360', windowHeight: '8640', tabRatio: '425',
    showHorizontalScroll: 'false', showVerticalScroll: 'true', showSheetTabs: 'false', firstSheet: '0', activeTab: '1' })) {
    expect(xlsxAttr(tag, name)).toBe(value);
  }
  const reopened = await workbookFromFile(exported, 'reopened.xlsx');
  expect(reopened.activeSheet.name).toBe('First');
  expect(reopened.workbookView).toEqual({ ...wb.workbookView, firstSheetId: reopened.sheetByName('Second').id });
});

it('does not export malformed workbook window values or invent view settings for new books', async () => {
  const source = otherProgramsXlsx({ sheetNames: ['Data'], patch: { '/xl/workbook.xml': xml =>
    xml.replace('<sheets>', '<!-- <bookViews><workbookView windowWidth="999"/></bookViews> --><bookViews><workbookView xWindow="1.5" windowWidth="-1" tabRatio="bad" showSheetTabs="maybe" firstSheet="8" activeTab="4"/></bookViews><sheets>') } });
  const wb = await workbookFromFile(source, 'malformed.xlsx');
  expect(wb.workbookView).toBeNull();
  expect(wb.activeSheet.name).toBe('Data');
  expect(viewTag(await (await workbookToXlsx(wb)).arrayBuffer())).toMatch(/<workbookView activeTab="0"\/>/);
  expect(viewTag(await (await workbookToXlsx(new Workbook())).arrayBuffer())).toMatch(/<workbookView activeTab="0"\/>/);
});

it('does not add a first visible sheet when the source view only sets window geometry', async () => {
  const source = otherProgramsXlsx({ sheetNames: ['Data'], patch: { '/xl/workbook.xml': xml =>
    xml.replace('<sheets>', '<bookViews><workbookView xWindow="20" windowWidth="12000"/></bookViews><sheets>') } });
  const wb = await workbookFromFile(source, 'window-only.xlsx');
  expect(wb.workbookView).toEqual({ xWindow: 20, windowWidth: 12000 });
  const tag = viewTag(await (await workbookToXlsx(wb)).arrayBuffer());
  expect(xlsxAttr(tag, 'firstSheet')).toBeUndefined();
});
