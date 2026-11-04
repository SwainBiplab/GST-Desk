import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withCheckDigit } from '@gst/domain';
import { expect, test, type Page } from '@playwright/test';

import budgets from './budgets.json' with { type: 'json' };

/**
 * Prompt 13 acceptance: a seeded 200-item catalogue plus a 10,000-item CSV import stay responsive in the
 * grid and the command bar. The import runs at full speed in the real browser engine (SQLite on OPFS);
 * the grid and the command bar are measured at the baseline device's 4x CPU throttle.
 */
const B = budgets.items;
const ROWS = 10_000;
const results: Record<string, number | boolean> = {};

test.afterAll(() => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'web-items.json'),
    JSON.stringify(
      { suite: 'web-items', at: new Date().toISOString(), budget: B, results },
      null,
      2,
    ),
  );
});

function csv(): string {
  const words = [
    'cotton',
    'steel',
    'paper',
    'copper',
    'wood',
    'glass',
    'rubber',
    'wool',
    'silk',
    'brass',
  ];
  const lines = ['Item Name,SKU,Barcode,HSN,Selling Price,Purchase Price,GST %,Unit,Tags'];
  for (let i = 0; i < ROWS; i++) {
    const barcode = withCheckDigit(`891${String(100_000_000 + i * 13).padStart(9, '0')}`);
    lines.push(
      `${words[i % 10]} widget ${i},BULK-${i},${barcode},0902,"${(100 + (i % 900)).toLocaleString('en-IN')}.50",80,5,NOS,bulk`,
    );
  }
  return lines.join('\r\n');
}

async function timed(label: string, fn: () => Promise<void>): Promise<number> {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  results[label] = ms;
  return ms;
}

async function throttle(page: Page, rate: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

test(`imports ${ROWS} items under ${B.importSeconds} s, then the grid and command bar stay responsive`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/books/items?demo=1');
  await expect(page.getByText('200 of 200 items')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('import-items').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'big.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv()),
  });
  await expect(page.getByTestId('import-map-name')).toBeVisible();

  const review = await timed('reviewMs', async () => {
    await page.getByTestId('import-continue').click();
    await expect(page.getByTestId('import-review-summary')).toHaveText(
      `${ROWS} of ${ROWS} rows are ready. 0 have problems.`,
      { timeout: 60_000 },
    );
  });

  const importMs = await timed('importMs', async () => {
    await page.getByTestId('import-start').click();
    await expect(page.getByTestId('import-running')).toBeVisible();
    await expect(page.getByTestId('import-done')).toContainText(`Imported ${ROWS} rows`, {
      timeout: B.importSeconds * 1000,
    });
  });
  results['importPass'] = importMs <= B.importSeconds * 1000;
  expect(importMs, 'import of 10,000 items').toBeLessThanOrEqual(B.importSeconds * 1000);
  expect(review, 'review of 10,000 rows').toBeLessThanOrEqual(B.reviewSeconds * 1000);
  await page.getByTestId('import-close').click();
  await expect(page.getByText(`${200 + ROWS} of ${200 + ROWS} items`)).toBeVisible();

  // the grid stays virtualised: only the visible window is in the DOM
  const rendered = await page.getByTestId('item-row').count();
  results['renderedRows'] = rendered;
  expect(rendered).toBeLessThan(100);

  await throttle(page, budgets.cpuThrottle);

  const scroll = await timed('scrollMs', async () => {
    await page
      .getByTestId('item-table')
      .locator('[role="table"]')
      .evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByTestId('item-row').last()).toBeVisible();
  });
  expect(scroll, 'scroll to the end of the grid').toBeLessThanOrEqual(B.scrollMs);

  const search = await timed('searchMs', async () => {
    await page.getByTestId('item-search').fill('BULK-9999');
    await expect(page.getByTestId('item-row')).toHaveCount(1);
  });
  expect(search, 'grid search among 10,200 items').toBeLessThanOrEqual(B.searchMs);
  await page.getByTestId('item-search').fill('');

  const sort = await timed('sortMs', async () => {
    await page.getByTestId('sort-sale').click();
    await expect(page.getByTestId('sort-sale')).toBeVisible();
    await expect(page.getByTestId('item-row').first()).toBeVisible();
  });
  expect(sort, 'sort 10,200 items').toBeLessThanOrEqual(B.sortMs);

  const command = await timed('commandMs', async () => {
    await page.keyboard.press('Control+k');
    await page.getByTestId('command-input').fill('widget 4242');
    await expect(page.getByRole('option').filter({ hasText: 'widget 4242' }).first()).toBeVisible();
  });
  expect(command, 'command bar search among 10,200 items').toBeLessThanOrEqual(B.commandMs);
});
