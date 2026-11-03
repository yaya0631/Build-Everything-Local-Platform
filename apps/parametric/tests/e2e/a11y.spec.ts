import { expect, test, type Page } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

async function seriousViolations(page: Page) {
  // Playwright resolves the path from the project directory.
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  const result = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations
      .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  return result as string[];
}

test.describe('accessibility', () => {
  test('start screen has no serious violations', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('dialog', { name: 'Parametric' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('modeling workspace has no serious violations', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('menus are reachable from the keyboard', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('menuitem', { name: 'File' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Edit' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});
