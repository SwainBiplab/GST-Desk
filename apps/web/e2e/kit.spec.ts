import { expect, test } from '@playwright/test';

import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });

for (const theme of ['light', 'dark']) {
  test(`/books/_kit fits 1366x768 without horizontal scroll (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await openSeeded(page, '/books/_kit');
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await expect(page.getByRole('heading', { name: 'UI kit' })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        main: main.scrollWidth - main.clientWidth,
      };
    });
    expect(overflow).toEqual({ page: 0, main: 0 });
    expect(errors).toEqual([]);
  });
}

test('GSTIN input shows validity', async ({ page }) => {
  await openSeeded(page, '/books/_kit');
  await expect(page.getByText('Valid GSTIN')).toBeVisible();
});
