import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('mobile layout opens the design tree as a sheet and has no page scroll', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('button', { name: 'Show design tree' }).click();
  await waitForFeature(page, 'Fillet1');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Fillet1' })).toBeVisible();
});
