import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

test('double-click selects the header drawing outside its anchor line, with delete, undo and export', async ({ page }, info) => {
  const source = 'public/fixtures/header-drawings.docx';
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles(source);
  await expect(page.getByRole('textbox', { name: 'Document text', exact: true })).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
  const target = await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { layoutDocument, imageAtPoint } = await import('/src/engine/layout.js');
    const { layoutPageStories } = await import('/src/engine/page-story-layout.js');
    const { pageGeometry } = await import('/src/engine/page-settings.js');
    const { measureCanvasText } = await import('/src/engine/canvas-text.js');
    const pkg = await DocxPackage.open(new Uint8Array(bytes)), context = document.createElement('canvas').getContext('2d');
    const measure = (text, style) => measureCanvasText(context, text, style);
    const body = layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, pkg.pageStories);
    const stories = layoutPageStories(body, pkg.pageStories, [pkg.pageSettings], measure, pkg.numbering, { styles: pkg.styles });
    for (const f of stories.floatingObjects.filter(f => f.page === 0 && pkg.pageStories.stories[f.pageStory].kind === 'header')) {
      for (const ry of [.2, .5, .8]) for (const rx of [.2, .5, .8]) {
        const x = f.x + f.width * rx, y = f.y + f.height * ry;
        if (stories.lines.some(l => l.page === 0 && y >= l.y && y <= l.y + l.height)) continue;
        if (body.lines.some(l => l.page === 0 && y >= l.y && y <= l.y + l.height)) continue;
        if (imageAtPoint({ ...body, ...stories }, 0, x, y)?.image.id !== f.image.id) continue;
        const firstBody = body.lines.find(line => line.page === 0);
        return { x, y, start: f.start, end: f.end, path: f.pageStory, bodyPoint: { x: firstBody.stops[0].x + 4, y: firstBody.y + firstBody.height / 2 }, text: pkg.pageStories.stories[f.pageStory].paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n') };
      }
    }
    throw new Error('The original control has no isolated header drawing target.');
  }, [...readFileSync(source)]);
  await page.locator('canvas.canvas-page').first().dblclick({ position: { x: target.x, y: target.y } });
  const input = page.getByRole('textbox', { name: 'Header text', exact: true });
  await expect(input).toHaveValue(target.text);
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([target.start, target.end]);
  await input.press('Delete'); await expect(input).toHaveValue(target.text.slice(0, target.start) + target.text.slice(target.end));
  const download = async name => {
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(name + '.docx'); await (await pending).saveAs(path); return unzipSync(readFileSync(path));
  };
  const original = unzipSync(readFileSync(source)), edited = await download('deleted');
  expect(edited[target.path]).not.toEqual(original[target.path]);
  for (const name of Object.keys(original)) if (name !== target.path) expect(edited[name], name).toEqual(original[name]);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(target.text);
  expect(await download('undo')).toEqual(original);
  await page.locator('canvas.canvas-page').first().dblclick({ position: target.bodyPoint });
  await expect(page.getByRole('textbox', { name: 'Document text', exact: true })).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
});
