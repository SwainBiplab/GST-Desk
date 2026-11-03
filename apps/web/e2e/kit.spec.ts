import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1366, height: 768 } });

for (const theme of ['light', 'dark']) {
  test(`/books/_kit fits 1366x768 without horizontal scroll (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/books/_kit');
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await expect(page.getByRole('heading', { name: 'UI kit' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test('GSTIN input shows validity', async ({ page }) => {
  await page.goto('/books/_kit');
  await expect(page.getByText('Valid GSTIN')).toBeVisible();
});
