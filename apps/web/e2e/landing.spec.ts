/**
 * The landing page: first-time web visitors see it at `/`, everyone else goes straight to the app,
 * and the page itself is accessible and shows the finished sample invoice without motion.
 */
import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

const FRESH = { storageState: { cookies: [], origins: [] } };

test.describe('first visit', () => {
  test.use(FRESH);

  test('a first-time visitor at / is sent to the landing page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/landing\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('Open the web app goes into the app and remembers it', async ({ page }) => {
    await page.goto('/landing/');
    await page.getByRole('link', { name: 'Open the web app' }).click();
    await expect(page).toHaveURL(/\/(shop|books)\//);
    await page.goto('/');
    await expect(page).toHaveURL(/\/(shop|books)\//);
  });
});

test.describe('returning visit', () => {
  test('/ opens the app for a browser that has used it', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/(shop|books)\//);
  });
});

test.describe('the page', () => {
  test.use(FRESH);

  test('has no serious or critical accessibility violations, in both themes', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/landing/');
      const res = await new AxeBuilder({ page }).analyze();
      const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        bad.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`),
        scheme,
      ).toEqual([]);
    }
  });

  test('with reduced motion the finished invoice is shown at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/landing/');
    await expect(page.locator('#total')).toHaveText('3,201.00');
    await expect(page.locator('.stamp')).toBeVisible();
  });

  test('the sample invoice writes itself and ends on the total', async ({ page }) => {
    await page.goto('/landing/');
    await expect(page.locator('#total')).toHaveText('3,201.00', { timeout: 8000 });
    await expect(page.locator('.stamp.on')).toHaveCount(1);
  });

  test('is usable on a phone: no sideways scroll on the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/landing/');
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(wide).toBe(false);
  });
});
