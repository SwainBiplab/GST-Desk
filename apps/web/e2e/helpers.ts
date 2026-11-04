import { expect, type Page } from '@playwright/test';

/** Open a path with the deterministic demo business loaded (500 documents) and wait for the counts. */
export async function openSeeded(page: Page, path = '/books/dashboard') {
  await page.goto(`${path}?demo=1`);
  await expect(page.getByTestId('badge-documents')).toHaveText('500', { timeout: 30_000 });
}

export async function openCommandBar(page: Page) {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-input')).toBeFocused();
}
