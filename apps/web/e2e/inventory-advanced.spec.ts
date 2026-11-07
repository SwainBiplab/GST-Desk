import { addLine, pickParty } from './documents.helpers';
import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

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

/** A new sales invoice for the pharma customer with one line, the stock details left to the caller. */
async function startSale(page: Page, sku: string, qty: string) {
  await page.goto('/books/documents/new?type=tax_invoice');
  await expect(page.getByTestId('doc-editor')).toBeVisible();
  await expect(page.getByTestId('line-grid')).toBeVisible();
  await pickParty(page, 'Sharma Medical');
  await addLine(page, 0, sku, qty);
}

/** Open the stock details of the first line: narrow the grid to Item, Qty and Stock, click the stock cell, Enter. */
async function openStockDetails(page: Page) {
  await page.getByTestId('grid-columns').click();
  for (const col of [
    'hsn',
    'unit',
    'rate',
    'incl',
    'discount',
    'taxable',
    'taxRate',
    'tax',
    'total',
  ])
    await page.getByTestId(`grid-col-${col}`).click();
  await page.keyboard.press('Escape');
  // the grid lays itself out again after the columns change: click once it has, and again if it had not
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(300);
    const frame = (await page.getByTestId('grid-frame').boundingBox())!;
    // marker 36 + item 260 + qty 80, then into the Stock column
    await page.mouse.click(frame.x + 36 + 260 + 80 + 40, frame.y + 36 + 14);
    await page.keyboard.press('Enter');
    const open = await page
      .getByTestId('stock-details')
      .waitFor({ state: 'visible', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (open) return;
  }
  await expect(page.getByTestId('stock-details')).toBeVisible();
}

test.describe('advanced inventory', () => {
  test('a batch item is sold first expiry first by default, or from the batch chosen', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard', { pharma: true });
    // the pharma seed: paracetamol has batch PCM-B25 with 80 strips (60 in Main, 20 in cold storage)
    await openItem(page, 'PCM-500');
    await expect(page.getByTestId('stock-batches')).toBeVisible();
    const batchQty = num(await page.getByTestId('stock-batch-qty').first().textContent());
    expect(batchQty).toBe(80);
    await page.keyboard.press('Escape');

    await startSale(page, 'PCM-500', '5');
    await openStockDetails(page);
    // FEFO is the default; the one batch with stock is listed with what is available here
    await expect(page.getByTestId('stock-batch-fefo')).toBeChecked();
    await expect(page.getByTestId('stock-batch-option')).toHaveCount(1);
    await expect(page.getByTestId('stock-batch-available').first()).toContainText('60');
    await page.getByTestId('stock-batch-PCM-B25').click();
    await page.getByTestId('stock-details-apply').click();
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });

    await openItem(page, 'PCM-500');
    await expect(page.getByTestId('stock-batch-qty').first()).toHaveText('75');
    // the movement names its batch and godown
    await expect(page.getByTestId('stock-where').first()).toContainText('PCM-B25');
  });

  test('a serial item is sold by its serial numbers, and a serial that is not in stock is refused', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard', { pharma: true });
    await startSale(page, 'GLU-01', '1');
    await openStockDetails(page);
    // GM-0001 was sold in the seed; GM-0004 is on the shelf
    await page.getByTestId('stock-serials').fill('GM-0001');
    await expect(page.getByTestId('stock-serial-problems')).toContainText('GM-0001');
    await expect(page.getByTestId('stock-details-apply')).toBeDisabled();
    await page.getByTestId('stock-serials').fill('GM-0004\nGM-0005');
    await expect(page.getByTestId('stock-serial-problems')).toHaveCount(0);
    await expect(page.getByTestId('stock-serial-count')).toContainText('2 serial');
    await page.getByTestId('stock-details-apply').click();
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });

    // the stock page finds the serial and says it is out
    await page.goto('/books/stock?tab=serials');
    await page.getByTestId('serial-query').fill('GM-0004');
    await page.getByTestId('serial-find').click();
    await expect(page.getByTestId('serial-status')).toHaveText(/Sold/);
    await page.getByTestId('serial-query').fill('GM-0003');
    await page.getByTestId('serial-find').click();
    await expect(page.getByTestId('serial-status')).toHaveText(/In stock/);
  });

  test('a transfer dispatches from one godown and is received in the other, and the valuation ties', async ({
    page,
  }) => {
    await openSeeded(page, '/books/stock', { pharma: true });
    await expect(page.getByTestId('stock-overview')).toBeVisible();
    await page.getByTestId('stock-search').fill('PCM-500');
    const row = page.getByTestId('stock-overview-row').first();
    await expect(row.getByTestId('stock-cell-Main')).toHaveText('60');
    await expect(row.getByTestId('stock-cell-Cold storage')).toHaveText('20');

    await page.getByTestId('transfer-new').click();
    const dialog = page.getByTestId('transfer-dialog');
    await dialog.getByTestId('transfer-to').click();
    await page.getByRole('option', { name: 'Cold storage' }).click();
    await dialog.getByTestId('transfer-line-0-item').fill('PCM-500');
    await dialog.getByTestId('transfer-line-0-item-result').first().click();
    await dialog.getByTestId('transfer-line-0-batch').click();
    await page.getByRole('option', { name: /PCM-B25/ }).click();
    await dialog.getByTestId('transfer-line-0-qty').fill('10');
    // two steps: dispatch now, receive later
    await dialog.getByTestId('transfer-immediate').click();
    await dialog.getByTestId('transfer-submit').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('transfer-row').first()).toHaveAttribute(
      'data-status',
      'dispatched',
    );

    await page.getByTestId('stock-tab-overview').click();
    await page.getByTestId('stock-search').fill('PCM-500');
    await expect(row.getByTestId('stock-cell-Main')).toHaveText('50');
    await expect(row.getByTestId('stock-cell-Cold storage')).toHaveText('20');
    await expect(row.getByTestId('stock-overview-total')).toHaveText('80');

    await page.getByTestId('stock-tab-transfers').click();
    await page.getByTestId('transfer-receive').first().click();
    await expect(page.getByTestId('transfer-row').first()).toHaveAttribute(
      'data-status',
      'received',
    );
    await page.getByTestId('stock-tab-overview').click();
    await page.getByTestId('stock-search').fill('PCM-500');
    await expect(row.getByTestId('stock-cell-Cold storage')).toHaveText('30');

    // the settings say FIFO, and the Inventory ledger equals the stock on hand at cost
    await page.goto('/books/settings?tab=inventory');
    await expect(page.getByTestId('valuation-fifo')).toBeChecked();
    await expect(page.getByTestId('valuation-check')).toHaveAttribute('data-ties', 'yes', {
      timeout: 30_000,
    });
  });

  test('the expiry report and the inbox flag the batch about to expire', async ({ page }) => {
    await openSeeded(page, '/books/dashboard', { pharma: true });
    await page.goto('/books/reports?report=expiry&preset=custom&from=2026-04-01&to=2027-12-31');
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'expiry');
    await expect(page.getByTestId('report-summary')).not.toHaveText(/Loading/, { timeout: 30_000 });
    const first = page.getByTestId('report-row').first();
    await expect(first.locator('[data-col="batch"]')).toHaveText('AMX-A24');
    await expect(first.locator('[data-col="daysLeft"]')).toHaveText('20');

    await page.goto('/books/stock?tab=batches');
    await expect(page.getByTestId('expiring-row')).toHaveCount(1);
    await expect(page.getByTestId('expiring-row').first()).toContainText('AMX-A24');

    await page.goto('/books/inbox');
    await page.getByTestId('inbox-check').click();
    await expect(page.getByText('Expiring stock').first()).toBeVisible({ timeout: 30_000 });
  });
});
