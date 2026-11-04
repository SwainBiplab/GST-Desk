import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { openSeeded, png } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });

const csvFile = (text: string, name = 'items.csv') => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(text),
});

async function pickOption(page: Page, trigger: string, option: string | RegExp) {
  await page.getByTestId(trigger).click();
  await page.getByRole('option', { name: option }).click();
}

test.describe('item catalogue', () => {
  test('lists the seeded items in a virtualised table and searches them', async ({ page }) => {
    await openSeeded(page, '/books/items');
    await expect(page.getByTestId('item-table')).toBeVisible();
    await expect(page.getByText('200 of 200 items')).toBeVisible();
    const rendered = await page.getByTestId('item-row').count();
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(100);

    await page.getByTestId('item-search').fill('SKU-0042');
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await page.getByTestId('item-search').fill('zzzzzz');
    await expect(page.getByTestId('item-none')).toBeVisible();
  });

  test('creates an item with a suggested HSN, fills the rate and warns when it is overridden', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('new-item').click();
    await expect(page.getByTestId('item-drawer')).toBeVisible();

    await page.getByTestId('item-name').fill('Green tea leaves');
    await page.getByTestId('hsn-suggest').click();
    await expect(page.getByTestId('hsn-popover')).toBeVisible();
    // the item name is the starting description; the bundled master answers offline
    await expect(page.getByTestId('hsn-hit').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('hsn-hit').first()).toContainText('0902');
    await expect(page.getByTestId('hsn-hit').first()).toContainText('5%');
    await expect(page.getByTestId('hsn-hit').first()).toContainText('Matches: tea');
    expect(await page.getByTestId('hsn-hit').count()).toBeLessThanOrEqual(3);
    await page.getByTestId('hsn-hit').first().click();

    await expect(page.getByTestId('item-hsn')).toHaveValue('0902');
    await expect(page.getByTestId('item-gst')).toContainText('5%');
    await expect(page.getByTestId('rate-override-warning')).toHaveCount(0);

    await page.getByTestId('item-sale').fill('1,200.50');
    await page.getByTestId('item-sku').fill('E2E-TEA');

    await pickOption(page, 'item-gst', '18%');
    await expect(page.getByTestId('rate-override-warning')).toContainText('5%');
    await page.getByRole('button', { name: 'Use the master rate' }).click();
    await expect(page.getByTestId('item-gst')).toContainText('5%');

    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-drawer')).toBeHidden();
    await page.getByTestId('item-search').fill('E2E-TEA');
    const row = page.getByTestId('item-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Green tea leaves');
    await expect(row).toContainText('0902');
    await expect(row).toContainText('1,200.50');
    await expect(row).toContainText('5%');
  });

  test('checks the barcode check digit and refuses a duplicate SKU', async ({ page }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-name').fill('Barcode test');
    await page.getByTestId('item-barcode').fill('4006381333932');
    await page.getByTestId('item-save').click();
    await expect(page.getByText('The check digit is wrong')).toBeVisible();
    await page.getByTestId('item-barcode').fill('4006381333931');

    await page.getByTestId('item-sku').fill('SKU-0001');
    await page.getByTestId('item-save').click();
    await expect(page.getByText('Another item already uses this SKU.')).toBeVisible();
    await expect(page.getByTestId('item-drawer')).toBeVisible();

    await page.getByTestId('item-sku').fill('E2E-BARCODE');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-drawer')).toBeHidden();
  });

  test('keeps a service free of stock and a goods item with opening stock', async ({ page }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-name').fill('Opening stock item');
    await page.getByTestId('item-track').click();
    await page.getByTestId('item-opening-qty').fill('10');
    await page.getByTestId('item-opening-value').fill('500');
    await page.getByTestId('item-sku').fill('E2E-STOCK');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-drawer')).toBeHidden();

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-kind-service').click();
    await expect(page.getByTestId('item-track')).toHaveCount(0);
  });

  test('adds a picture, keeps it after saving, rejects a file that is not a picture', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-name').fill('Pictured item');
    await page.getByTestId('item-sku').fill('E2E-PIC');
    const input = page.getByTestId('item-image-input');
    await input.setInputFiles({
      name: 'not-a-picture.png',
      mimeType: 'image/png',
      buffer: Buffer.from('plain text'),
    });
    await expect(
      page.getByText('not-a-picture.png is not a picture this app can read.'),
    ).toBeVisible();
    await expect(page.getByTestId('item-image')).toHaveCount(0);

    await input.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png(900, 600) });
    await expect(page.getByTestId('item-image')).toHaveCount(1);
    await expect(page.getByRole('img', { name: 'photo.png' })).toBeVisible();
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-drawer')).toBeHidden();

    await page.getByTestId('item-search').fill('E2E-PIC');
    await page.getByTestId('item-open').click();
    await expect(page.getByTestId('item-image')).toHaveCount(1);
    await expect(page.getByRole('img', { name: 'photo.png' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove photo.png' }).click();
    await expect(page.getByTestId('item-image')).toHaveCount(0);
  });

  test('Shop shows the form as a full page', async ({ page }) => {
    await openSeeded(page, '/shop/items');
    await page.getByTestId('new-item').click();
    await expect(page.getByTestId('item-page-form')).toBeVisible();
    await page.getByTestId('item-name').fill('Counter item');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-list')).toBeVisible();
  });
});

test.describe('units and HSN master', () => {
  test('adds a custom unit mapped to a UQC and uses it on an item', async ({ page }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('units-open').click();
    await expect(page.getByTestId('units-dialog')).toBeVisible();
    await page.getByTestId('unit-code').fill('TRAY');
    await page.getByTestId('unit-name').fill('Tray');
    await pickOption(page, 'unit-uqc', /^NOS/);
    await page.getByTestId('unit-add-custom').click();
    const row = page.getByTestId('unit-row').filter({ hasText: 'TRAY' });
    await expect(row).toContainText('NOS');
    await expect(row).toContainText('your own');
    await page.getByTestId('units-close').click();

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-name').fill('Egg tray item');
    await pickOption(page, 'item-unit', /TRAY/);
    await page.getByTestId('item-sku').fill('E2E-TRAY');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-drawer')).toBeHidden();
    await page.getByTestId('item-search').fill('E2E-TRAY');
    await expect(page.getByTestId('item-row')).toContainText('TRAY');
  });

  test('shows the installed HSN version and keeps the update address off by default', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('hsn-open').click();
    await expect(page.getByTestId('hsn-dialog')).toBeVisible();
    await expect(page.getByTestId('hsn-version').first()).toContainText('2025.9.1', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('hsn-url')).toHaveValue('');
    await expect(page.getByTestId('hsn-check')).toBeDisabled();

    await page.getByTestId('hsn-url').fill('http://example.com/hsn.json');
    await expect(page.getByText('The address must start with https://.')).toBeVisible();
    await expect(page.getByTestId('hsn-url-save')).toBeDisabled();
    await page.getByTestId('hsn-url').fill('https://example.com/hsn/manifest.json');
    await page.getByTestId('hsn-url-save').click();
    await expect(page.getByTestId('hsn-check')).toBeEnabled();
  });
});

test.describe('CSV import, bulk edit and export', () => {
  test('imports a file that has a bad row: report with line numbers, skip it, then bulk edit and undo', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('import-items').click();
    await expect(page.getByTestId('import-wizard')).toBeVisible();

    await page
      .getByTestId('import-file')
      .setInputFiles(
        csvFile(
          [
            'Item Name,SKU,HSN,Selling Price,GST %,Unit',
            'Import Alpha,IMP-ALPHA,0902,"1,250.50",5,NOS',
            'Import Beta,IMP-BETA,1701,45,5,KGS',
            ',IMP-BAD,0902,10,5,NOS',
          ].join('\r\n'),
        ),
      );
    // columns are matched by their headings
    await expect(page.getByTestId('import-map-hsn')).toContainText('HSN');
    await expect(page.getByTestId('import-map-sale_price')).toContainText('Selling Price');
    await page.getByTestId('import-continue').click();

    await expect(page.getByTestId('import-review-summary')).toHaveText(
      '2 of 3 rows are ready. 1 have problems.',
    );
    await expect(page.getByText('Nothing has been saved yet.')).toBeVisible();
    const problem = page.getByTestId('import-problem-row');
    await expect(problem).toHaveCount(1);
    await expect(problem).toContainText('4'); // file line number
    await expect(problem).toContainText('Enter a name of at least two letters.');
    await expect(page.getByTestId('import-start')).toBeDisabled();

    const [report] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('import-download-problems').click(),
    ]);
    const text = (await readFile((await report.path())!, 'utf8')).slice(1);
    expect(text.split('\r\n')[1]).toContain('4,');

    await page.getByTestId('import-skip-invalid').click();
    await expect(page.getByTestId('import-start')).toBeEnabled();
    await page.getByTestId('import-start').click();
    await expect(page.getByTestId('import-done')).toContainText('Imported 2 rows');
    await page.getByTestId('import-close').click();
    await expect(page.getByTestId('import-wizard')).toBeHidden();

    await page.getByTestId('item-search').fill('IMP');
    await expect(page.getByTestId('item-row')).toHaveCount(2);
    const alpha = page.getByTestId('item-row').filter({ hasText: 'Import Alpha' });
    const beta = page.getByTestId('item-row').filter({ hasText: 'Import Beta' });
    await expect(alpha).toContainText('1,250.50');
    await expect(beta).toContainText('KGS');

    // bulk edit: +10% on both, check the preview, apply, undo
    await page.getByLabel('Select Import Alpha').click();
    await page.getByLabel('Select Import Beta').click();
    await page.getByTestId('bulk-open').click();
    await expect(page.getByTestId('bulk-dialog')).toBeVisible();
    await pickOption(page, 'bulk-what', 'Sale price');
    await page.getByTestId('bulk-value').fill('10');
    await expect(page.getByTestId('bulk-summary')).toHaveText(
      '2 items will change, 0 will be left alone.',
    );
    const previewAlpha = page.getByTestId('bulk-row').filter({ hasText: 'Import Alpha' });
    await expect(previewAlpha).toContainText('1250.50');
    await expect(previewAlpha).toContainText('1375.55');
    await page.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('bulk-dialog')).toBeHidden();
    await expect(alpha).toContainText('1,375.55');
    await expect(beta).toContainText('49.50');

    await page.getByTestId('bulk-undo').click();
    await expect(alpha).toContainText('1,250.50');
    await expect(beta).toContainText('45.00');
  });

  test('bulk edit changes the GST rate and adds a tag, and refuses prices that would go below zero', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('item-search').fill('SKU-0001');
    await page
      .getByLabel(/^Select /)
      .first()
      .click();
    await page.getByTestId('bulk-open').click();
    await pickOption(page, 'bulk-what', 'GST rate');
    await pickOption(page, 'bulk-rate', '12%');
    await expect(page.getByTestId('bulk-row').first()).toContainText('12%');
    await page.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('item-row')).toContainText('12%');

    await page
      .getByLabel(/^Select /)
      .first()
      .click();
    await page.getByTestId('bulk-open').click();
    await pickOption(page, 'bulk-what', 'Purchase price');
    await pickOption(page, 'bulk-mode', 'An amount');
    await page.getByTestId('bulk-value').fill('-999999');
    await expect(page.getByTestId('bulk-summary')).toHaveText(
      '0 items will change, 1 will be left alone.',
    );
    await expect(page.getByTestId('bulk-row').first()).toContainText('Would go below zero');
    await expect(page.getByTestId('bulk-apply')).toBeDisabled();
  });

  test('exports items in the shape the import reads, with formulas neutralised', async ({
    page,
  }) => {
    await openSeeded(page, '/books/items');
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-name').fill('=HYPERLINK("http://evil")');
    await page.getByTestId('item-sku').fill('E2E-FORMULA');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-drawer')).toBeHidden();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-items').click(),
    ]);
    expect(download.suggestedFilename()).toBe('items.csv');
    const csv = (await readFile((await download.path())!, 'utf8')).slice(1);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Name,Type,SKU,Barcode,HSN/SAC,Unit,Sale Price,Purchase Price,MRP,GST Rate %,Cess %,Tax Inclusive,Opening Stock,Opening Value,Reorder Level,Tags,Active',
    );
    expect(lines).toHaveLength(202);
    expect(lines.find((l) => l.includes('E2E-FORMULA'))).toContain(
      `"'=HYPERLINK(""http://evil"")"`,
    );
  });

  test('imports parties and posts the opening balance', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await page.getByTestId('import-parties').click();
    await page
      .getByTestId('import-file')
      .setInputFiles(
        csvFile(
          [
            'Name,Phone,State,Opening Balance',
            'Import Party One,9876543210,Maharashtra,"2,500.00"',
            'Import Party Two,9876543211,Karnataka,',
            'Bad Phone,123,Karnataka,',
          ].join('\n'),
          'parties.csv',
        ),
      );
    await page.getByTestId('import-continue').click();
    await expect(page.getByTestId('import-review-summary')).toHaveText(
      '2 of 3 rows are ready. 1 have problems.',
    );
    await page.getByTestId('import-skip-invalid').click();
    await page.getByTestId('import-start').click();
    await expect(page.getByTestId('import-done')).toContainText('Imported 2 rows');
    await page.getByTestId('import-close').click();
    await page.getByTestId('party-search').fill('Import Party One');
    await expect(page.getByTestId('party-row')).toHaveCount(1);
    await expect(page.getByTestId('party-row')).toContainText('2,500.00');
  });

  test('remembers the column mapping for the same layout', async ({ page }) => {
    await openSeeded(page, '/books/items');
    const file = csvFile('Particulars,Code,Rate\nMapped One,MAP-1,10\n');
    await page.getByTestId('import-items').click();
    await page.getByTestId('import-file').setInputFiles(file);
    await expect(page.getByTestId('import-map-name')).toContainText('Particulars');
    await pickOption(page, 'import-map-sku', 'Code');
    await pickOption(page, 'import-map-sale_price', 'Rate');
    await page.getByTestId('import-continue').click();
    await page.getByTestId('import-start').click();
    await page.getByTestId('import-close').click();

    await page.getByTestId('import-items').click();
    await page
      .getByTestId('import-file')
      .setInputFiles(csvFile('Rate,Code,Particulars\n5,MAP-2,Mapped Two\n'));
    await expect(page.getByTestId('import-map-name')).toContainText('Particulars');
    await expect(page.getByTestId('import-map-sku')).toContainText('Code');
    await expect(page.getByTestId('import-map-sale_price')).toContainText('Rate');
  });

  test('the command bar finds the import actions', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await page.keyboard.press('Control+k');
    await page.getByTestId('command-input').fill('import items');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('import-wizard')).toBeVisible();
  });
});
