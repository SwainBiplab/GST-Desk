import { expect, test } from '@playwright/test';

test('/shop renders its heading', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
});

test('/books renders its heading', async ({ page }) => {
  await page.goto('/books');
  await expect(page.getByRole('heading', { name: 'Books' })).toBeVisible();
});

test('/ redirects to /shop', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/shop$/);
});
