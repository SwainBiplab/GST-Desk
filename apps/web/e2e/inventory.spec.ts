import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { addLine, pickParty } from './documents.helpers';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/** The number as the app shows a quantity: commas out. */
const num = (s: string | null) => Number((s ?? '').replace(/,/g, '').replace(/^\+/, '').trim());

/** Open an item from the list (its name opens it) and wait for the drawer. */
async function openItem(page: Page, sku: string) {
  await page.goto('/books/items');
  await page.getByTestId('item-search').fill(sku);
  await expect(page.getByTestId('item-row')).toHaveCount(1);
  await page.getByTestId('item-row').getByRole('button').first().click();
  await expect(page.getByTestId('item-drawer')).toBeVisible();
}

/** What an item holds, read from its stock panel. */
async function stockOf(page: Page, sku: string): Promise<number> {
  await openItem(page, sku);
  await expect(page.getByTestId('stock-panel')).toBeVisible();
  // the quantity shows once it has been worked out
  await expect(page.getByTestId('stock-on-hand')).not.toHaveText('…');
  const value = num(await page.getByTestId('stock-on-hand').textContent());
  await page.keyboard.press('Escape');
  return value;
}

/** A new sales invoice for the first party, issued unless told not to. */
async function newSale(page: Page, sku: string, qty: string, issue = true) {
  await page.goto('/books/documents/new?type=tax_invoice');
  await expect(page.getByTestId('doc-editor')).toBeVisible();
  await expect(page.getByTestId('line-grid')).toBeVisible();
  await pickParty(page);
  await addLine(page, 0, sku, qty);
  if (!issue) return;
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
}

async function setPolicy(page: Page, policy: 'allow' | 'block') {
  await page.goto('/books/settings?tab=inventory');
  await page.getByTestId(`stock-policy-${policy}`).click();
  // the radio looks chosen the moment it is clicked; the write is done when the app says so
  await expect(page.getByText('Saved.').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId(`stock-policy-${policy}`)).toBeChecked();
}

test.describe('inventory', () => {
  test('issuing a sale takes stock out, cancelling puts it back, and the item shows where it went', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const before = await stockOf(page, 'SKU-0002');

    await newSale(page, 'SKU-0002', '3');
    const number = (await page.getByTestId('doc-issued-number').innerText()).trim();
    expect(await stockOf(page, 'SKU-0002')).toBe(before - 3);

    // the movement names the invoice, and the link opens it
    await openItem(page, 'SKU-0002');
    const first = page.getByTestId('stock-movement').first();
    await expect(first).toContainText(number);
    await expect(first.getByTestId('stock-qty')).toHaveText('-3');
    await first.getByTestId('stock-doc-link').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued');

    // cancelling restores it
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-cancel').click();
    await page.getByTestId('cancel-reason').fill('Entered for the wrong customer');
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('doc-cancelled-banner')).toBeVisible();
    expect(await stockOf(page, 'SKU-0002')).toBe(before);
  });

  test('a manual adjustment adds or removes stock with a reason, and shows on the item', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    const before = await stockOf(page, 'SKU-0003');

    await page.goto('/books/items');
    await page.getByTestId('adjust-open').click();
    await expect(page.getByTestId('adjust-sheet')).toBeVisible();
    await page.getByTestId('adjust-reason').click();
    await page.getByRole('option', { name: 'Damaged' }).click();
    await page.getByTestId('adjust-note').fill('Dropped in the godown');
    await page.getByTestId('adjust-row-0-item').fill('SKU-0003');
    await page.getByTestId('adjust-item-result').first().click();
    await page.getByTestId('adjust-row-0-qty').fill('-2');
    await expect(page.getByTestId('adjust-row-0-after')).toContainText(`Becomes ${before - 2}`);
    await page.getByTestId('adjust-submit').click();
    await expect(page.getByText('Stock changed for 1 item.')).toBeVisible();

    expect(await stockOf(page, 'SKU-0003')).toBe(before - 2);
    await openItem(page, 'SKU-0003');
    await expect(page.getByTestId('stock-movement').first()).toContainText(
      'damage: Dropped in the godown',
    );
  });

  test('set to a counted quantity, from the item panel, books the difference', async ({ page }) => {
    await openSeeded(page, '/books/items');
    await openItem(page, 'SKU-0004');
    await page.getByTestId('stock-adjust').click();
    await expect(page.getByTestId('adjust-sheet')).toBeVisible();
    // opened from the item: its row is ready
    await expect(page.getByTestId('adjust-row-0-picked')).toContainText('SKU-0004');
    await page.getByTestId('adjust-mode').click();
    await page.getByRole('option', { name: 'Set to the counted quantity' }).click();
    await page.getByTestId('adjust-row-0-qty').fill('7');
    await expect(page.getByTestId('adjust-row-0-after')).toContainText('Becomes 7');
    await page.getByTestId('adjust-submit').click();
    await expect(page.getByText('Stock changed for 1 item.')).toBeVisible();
    expect(await stockOf(page, 'SKU-0004')).toBe(7);
  });

  test('a count sheet comes back as a CSV: matched items are booked, the rest are listed with their lines', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('adjust-open').click();
    await page.getByTestId('adjust-tab-count').click();

    const download = page.waitForEvent('download');
    await page.getByTestId('count-template').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^count-sheet_\d{4}-\d{2}-\d{2}\.csv$/);
    const sheet = readFileSync((await file.path())!, 'utf8')
      .slice(1)
      .split('\r\n')
      .filter(Boolean);
    expect(sheet[0]).toBe('SKU,Item,System quantity,Counted quantity');
    expect(sheet.length).toBe(1 + 180); // 200 items, 20 of them services that hold no stock
    expect(sheet[1]).toMatch(/^SKU-0001,/);

    const csv = [
      'SKU,Item,System quantity,Counted quantity',
      'SKU-0005,Five,,12',
      'SKU-0006,Six,,',
      'NOPE-1,Nothing,,3',
      'SKU-0010,A service,,4',
      'SKU-0007,Seven,,abc',
    ].join('\r\n');
    await page.getByTestId('count-file').setInputFiles({
      name: 'count.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    const preview = page.getByTestId('count-preview');
    await expect(preview.getByTestId('count-row')).toHaveCount(1);
    await expect(preview.getByTestId('count-row')).toContainText('SKU-0005');
    const errors = page.getByTestId('count-errors');
    await expect(errors).toContainText('Line 4');
    await expect(errors).toContainText('"NOPE-1" matches no item that tracks stock');
    await expect(errors).toContainText('Line 5');
    await expect(errors).toContainText('"SKU-0010" is an item that does not track stock');
    await expect(errors).toContainText('Line 6');
    await expect(errors).toContainText('the quantity is not a number');
    // SKU-0006 had no count, so it is simply not in the list
    await expect(preview).not.toContainText('SKU-0006');

    await page.getByTestId('count-apply').click();
    await expect(page.getByText('Stock changed for 1 item.')).toBeVisible();
    expect(await stockOf(page, 'SKU-0005')).toBe(12);
  });

  test('"do not allow" refuses a sale that would go below zero; "allow" asks first', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const before = await stockOf(page, 'SKU-0006');

    await setPolicy(page, 'block');
    await newSale(page, 'SKU-0006', '100000', false);
    await page.getByTestId('doc-issue').click();
    await expect(page.getByText(/Not enough stock to issue this/)).toBeVisible();
    await expect(page.getByTestId('doc-status')).toHaveText('Draft');
    expect(await stockOf(page, 'SKU-0006')).toBe(before);

    await setPolicy(page, 'allow');
    await newSale(page, 'SKU-0006', '100000', false);
    await page.getByTestId('doc-issue').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toContainText('This will take stock below zero', { timeout: 20_000 });
    await expect(confirm).toContainText('on hand');
    // saying no leaves it a draft
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('doc-status')).toHaveText('Draft');
    await page.getByTestId('doc-issue').click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Issue anyway' }).click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    expect(await stockOf(page, 'SKU-0006')).toBe(before - 100000);
  });

  test('items below their reorder level show on the bell, the dashboard and the stock report', async ({
    page,
  }) => {
    await openSeeded(page, '/shop/dashboard');
    const bell = page.getByTestId('bell');
    await expect(bell).toHaveAttribute('aria-label', /\d+ items? low on stock/);
    const low = Number(
      /(\d+) items? low on stock/.exec((await bell.getAttribute('aria-label'))!)![1],
    );
    expect(low).toBeGreaterThan(0);

    await expect(page.getByTestId('dash-low-count')).toBeVisible();
    await expect(page.getByTestId('dash-low-list')).toBeVisible();

    await bell.click();
    await page.getByTestId('bell-low-stock').click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'stock_summary');
    await expect(page).toHaveURL(/type=low/);
    await expect(page.getByTestId('report-summary')).not.toHaveText(/Loading/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('report-summary')).toContainText(`${low} rows`);
  });

  test('the stock summary values stock at purchase price and matches the item panels', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await page.goto(
      '/books/reports?report=stock_summary&preset=custom&from=2024-04-01&to=2026-12-31&cols=item,sku,opening,in,out,closing,value',
    );
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'stock_summary');
    await expect(page.getByTestId('report-summary')).not.toHaveText(/Loading/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('report-totals').locator('[data-col="value"]')).toContainText(
      /\d/,
    );
    const row = page.getByTestId('report-row').first();
    await expect(row).toBeVisible();
    const sku = ((await row.locator('[data-col="sku"]').textContent()) ?? '').trim();
    expect(sku).toMatch(/^SKU-\d{4}$/);
    const closing = num(await row.locator('[data-col="closing"]').textContent());
    expect(await stockOf(page, sku)).toBe(closing);
  });

  test('a delivery challan takes stock out only when asked to', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const before = await stockOf(page, 'SKU-0008');
    await page.goto('/books/documents/new?type=delivery_challan');
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await expect(page.getByTestId('line-grid')).toBeVisible();
    await expect(page.getByTestId('doc-reduce-stock')).toBeVisible();
    await expect(page.getByTestId('doc-returnable')).toBeVisible();
    await pickParty(page);
    await addLine(page, 0, 'SKU-0008', '2');
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    expect(await stockOf(page, 'SKU-0008')).toBe(before);

    await page.goto('/books/documents/new?type=delivery_challan');
    await expect(page.getByTestId('line-grid')).toBeVisible();
    await page.getByTestId('doc-reduce-stock').click();
    await page.getByTestId('doc-returnable').click();
    await pickParty(page);
    await addLine(page, 0, 'SKU-0008', '2');
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    expect(await stockOf(page, 'SKU-0008')).toBe(before - 2);
  });

  test('turning inventory off hides it, keeps the movements, and turning it on brings them back', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=features');
    const before = await stockOf(page, 'SKU-0009');

    await page.goto('/books/settings?tab=features');
    await page.getByTestId('flag-inventory').click();
    await expect(page.getByText('Saved').first()).toBeVisible();
    await expect(page.getByTestId('tab-inventory')).toHaveCount(0);
    await expect(page.getByTestId('bell')).not.toHaveAttribute('aria-label', /low on stock/);

    await page.goto('/books/items');
    await page.getByTestId('item-search').fill('SKU-0009');
    await page.getByTestId('item-row').getByRole('button').first().click();
    await expect(page.getByTestId('item-drawer')).toBeVisible();
    await expect(page.getByTestId('stock-panel')).toHaveCount(0);
    await expect(page.getByTestId('adjust-open')).toHaveCount(0);

    // a sale made while it is off moves nothing
    await newSale(page, 'SKU-0009', '4');

    await page.goto('/books/settings?tab=features');
    await page.getByTestId('flag-inventory').click();
    await expect(page.getByText('Saved').first()).toBeVisible();
    expect(await stockOf(page, 'SKU-0009')).toBe(before);
  });
});
