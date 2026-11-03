import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('makes a drawing with standard views and exports a PDF', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  const paper = page.getByRole('img', { name: 'Drawing sheet' });
  await expect(paper).toBeVisible();
  // Front, top, right and isometric views are projected by the geometry engine.
  await expect(page.locator('.relations-list > *')).toHaveCount(4, { timeout: 30_000 });
  await expect(paper.locator('svg path').first()).toBeAttached({ timeout: 30_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Mounting Bracket.pdf');
  expect(await file.failure()).toBeNull();
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.locator('canvas.gl')).toBeVisible();
  expect(errors).toEqual([]);
});
