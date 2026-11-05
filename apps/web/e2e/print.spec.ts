import { readFileSync } from 'node:fs';

import { unzipSync } from 'fflate';

import { addLine, openEditor, pickParty } from './documents.helpers';
import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

const option = (page: Page, id: string) =>
  page.locator(`[data-testid="template-option"][data-id="${id}"]`);

async function issueInvoice(page: Page) {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0001', '2');
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  return (await page.getByTestId('doc-issued-number').innerText()).trim();
}

test.describe('the template designer', () => {
  test('change a template, save it, make it the default, and issue an invoice with it', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=print');
    await expect(page.getByTestId('print-tab')).toBeVisible();
    await expect(page.getByTestId('template-option')).toHaveCount(5);

    await option(page, 'preset:modern').click();
    await page.getByTestId('template-name').fill('Wholesale Modern');
    await page.getByTestId('template-accent').fill('#aa1111');
    // the preview follows the change
    await expect(
      page.locator('[data-testid="designer-preview"] svg rect[fill="#aa1111"]').first(),
    ).toBeVisible();

    await page.getByTestId('template-save-new').click();
    await expect(
      page.locator('[data-testid="template-option"]', { hasText: 'Wholesale Modern' }),
    ).toBeVisible();
    await page.getByTestId('default-tax_invoice-books').click();
    await expect(page.getByTestId('default-tax_invoice-books')).toBeChecked();

    // an invoice now uses it, in the form and the preview
    await page.getByTestId('nav-sell').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await expect(page.getByTestId('doc-template')).toContainText('Wholesale Modern');
    await expect(page.getByTestId('preview-template')).toContainText('Wholesale Modern');
    await pickParty(page);
    await addLine(page, 0, 'SKU-0001', '1');
    await expect(
      page.locator('[data-testid="preview-sheet"] svg rect[fill="#aa1111"]').first(),
    ).toBeVisible();
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  });

  test('a saved template can be updated and deleted, but not while it is a default', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=print');
    await option(page, 'preset:compact').click();
    await page.getByTestId('template-name').fill('Counter Compact');
    await page.getByTestId('template-save-new').click();
    const mine = page.locator('[data-testid="template-option"]', { hasText: 'Counter Compact' });
    await expect(mine).toBeVisible();
    await page.getByTestId('default-quotation-shop').click();

    await page.getByTestId('template-name').fill('Counter Compact 2');
    await page.getByTestId('template-save').click();
    await expect(
      page.locator('[data-testid="template-option"]', { hasText: 'Counter Compact 2' }),
    ).toBeVisible();

    await page.getByTestId('template-delete').click();
    await expect(page.getByText(/default for quotation in shop/)).toBeVisible();
    await page.getByTestId('default-quotation-shop').click(); // clear it
    await page.getByTestId('template-delete').click();
    await expect(
      page.locator('[data-testid="template-option"]', { hasText: 'Counter Compact 2' }),
    ).toHaveCount(0);
  });

  test('wording follows the language, and every language prints in its own script', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=print');
    const title = page
      .locator('[data-testid="designer-preview"] [data-testid="preview-title"]')
      .first();
    await expect(title).toHaveText('Tax Invoice');
    for (const [name, text] of [
      ['हिन्दी', 'कर चालान'],
      ['தமிழ்', 'வரி விலைப்பட்டியல்'],
      ['বাংলা', 'কর চালান'],
      ['ગુજરાતી', 'ટેક્સ ઇન્વોઇસ'],
      ['मराठी', 'कर बीजक'],
    ] as const) {
      await page.getByTestId('template-language').click();
      await page.getByRole('option', { name }).click();
      await expect(title).toHaveText(text, { timeout: 10_000 });
    }
  });

  test('a label can be reworded, and the Tally-like preset prints three labelled copies', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=print');
    await page.getByTestId('label-search').fill('total');
    await page.locator('[data-testid="label-input"][data-key="total"]').fill('Grand Total');
    await expect(
      page.locator('[data-testid="designer-preview"] [data-testid="preview-sheet"]'),
    ).toContainText('Grand Total');

    await option(page, 'preset:tally').click();
    await expect(
      page.locator('[data-testid="designer-preview"] [data-testid="preview-page"]'),
    ).toHaveCount(3);
    const sheet = page.locator('[data-testid="designer-preview"] [data-testid="preview-sheet"]');
    await expect(sheet).toContainText('Original for Recipient');
    await expect(sheet).toContainText('Duplicate for Transporter');
    await expect(sheet).toContainText('Triplicate for Supplier');
  });

  test('blocks and columns can be switched off, and moved', async ({ page }) => {
    await openSeeded(page, '/books/settings?tab=print');
    const sheet = page.locator('[data-testid="designer-preview"] [data-testid="preview-sheet"]');
    await expect(sheet).toContainText('Bank Details');
    await page
      .locator('[data-testid="block-row"][data-block="bank"]')
      .getByTestId('block-visible')
      .click();
    await expect(sheet).not.toContainText('Bank Details');

    const cols = page.locator('[data-testid="column-row"][data-column="hsn"]');
    // "HSN/SAC" heads the lines table and the tax summary: hiding the column removes the first
    const hsnHeads = sheet.locator('text', { hasText: /^HSN\/SAC$/ });
    await expect(hsnHeads).toHaveCount(2);
    await cols.getByTestId('column-visible').click();
    await expect(hsnHeads).toHaveCount(1);

    // the order of the closing blocks changes with the arrows
    const order = () =>
      page
        .locator('[data-testid="blocks-closing"] [data-testid="block-row"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-block')));
    const before = await order();
    await page
      .locator('[data-testid="block-row"][data-block="terms"]')
      .getByTestId('block-up')
      .click();
    const after = await order();
    expect(after.indexOf('terms')).toBe(before.indexOf('terms') - 1);
  });

  test('the receipt roll shows how many characters fit', async ({ page }) => {
    await openSeeded(page, '/books/settings?tab=print');
    await page.getByTestId('template-roll').click();
    await page.getByRole('option', { name: '58 mm' }).click();
    await expect(page.getByTestId('roll-columns')).toContainText(
      '32 characters across a 58 mm roll',
    );
    const text = await page.getByTestId('roll-preview').textContent();
    const lines = text!.split('\n');
    expect(lines[0]!.length).toBe(32);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(32);
    await page.getByTestId('template-roll').click();
    await page.getByRole('option', { name: '80 mm' }).click();
    await expect(page.getByTestId('roll-columns')).toContainText(
      '48 characters across a 80 mm roll',
    );
  });

  test('a template can be exported and imported, and a bad file is refused with the reason', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=print');
    await option(page, 'preset:retail').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('template-export').click();
    const file = await download;
    const json = JSON.parse(readFileSync((await file.path())!, 'utf8')) as {
      v: number;
      name: string;
      page: { size: string };
    };
    expect(json).toMatchObject({ v: 1, name: 'Retail', page: { size: 'a5' } });

    await page.getByTestId('template-import-file').setInputFiles({
      name: 'mine.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...json, name: 'Imported One' })),
    });
    await expect(page.getByTestId('template-name')).toHaveValue('Imported One');

    await page.getByTestId('template-import-file').setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('this is not json'),
    });
    await expect(page.getByText(/not valid JSON/)).toBeVisible();
    await page.getByTestId('template-import-file').setInputFiles({
      name: 'wrong.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...json, theme: { accent: 'red' } })),
    });
    await expect(page.getByText(/theme/).first()).toBeVisible();
  });
});

test.describe('PDF, print and share', () => {
  test('download the PDF: a deterministic name, a real PDF, small', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const number = await issueInvoice(page);
    const download = page.waitForEvent('download');
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-pdf').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(
      `Demo-Traders_${number.split('/')[1]}_Tax-Invoice_${number.replace(/\//g, '-')}.pdf`,
    );
    const bytes = readFileSync((await file.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2_000);
    expect(bytes.length).toBeLessThan(150 * 1024);
    // the same document again gives the same file
    const again = page.waitForEvent('download');
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-pdf').click();
    const second = readFileSync((await (await again).path())!);
    expect(second.equals(bytes)).toBe(true);
  });

  test('printing prints the document, not the app around it', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
    });
    await openSeeded(page, '/books/dashboard');
    await issueInvoice(page);
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-print').click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(
      1,
    );
    // the print stylesheet hides everything but the sheet
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('preview-sheet')).toBeVisible();
    await expect(page.getByTestId('doc-editor').getByTestId('doc-more')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
  });

  test('sharing without a share sheet opens WhatsApp with the message and saves the PDF', async ({
    page,
    context,
  }) => {
    await context.route('https://wa.me/**', (r) =>
      r.fulfill({ body: 'ok', contentType: 'text/html' }),
    );
    await page.addInitScript(() => {
      (navigator as unknown as { canShare?: unknown }).canShare = () => false;
    });
    await openSeeded(page, '/books/dashboard');
    const number = await issueInvoice(page);
    const popup = page.waitForEvent('popup');
    const download = page.waitForEvent('download');
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-share').click();
    const p = await popup;
    expect(decodeURIComponent(p.url())).toContain(number);
    expect(decodeURIComponent(p.url())).toContain('Tax Invoice');
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('a cancelled document prints CANCELLED, and its saved PDF is stamped', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await issueInvoice(page);
    // make and keep the PDF first
    const first = page.waitForEvent('download');
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-pdf').click();
    const plain = readFileSync((await (await first).path())!);

    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-cancel').click();
    await page.getByTestId('cancel-reason').fill('Wrong customer');
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Cancelled', { timeout: 15_000 });
    await expect(page.getByTestId('preview-cancelled')).toBeVisible();

    const again = page.waitForEvent('download');
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-pdf').click();
    const stamped = readFileSync((await (await again).path())!);
    expect(stamped.equals(plain)).toBe(false);
  });
});

test.describe('bulk export', () => {
  test('twenty documents become twenty PDFs in one ZIP', async ({ page }) => {
    await openSeeded(page, '/books/documents');
    await expect(page.getByTestId('document-row').first()).toBeVisible();
    for (let i = 0; i < 20; i++) await page.getByTestId('doc-select').nth(i).click();
    await expect(page.getByTestId('bulk-export-button')).toContainText('20');

    const download = page.waitForEvent('download', { timeout: 100_000 });
    await page.getByTestId('bulk-export-button').click();
    await expect(page.getByTestId('bulk-export')).toBeVisible();
    await expect(page.getByTestId('bulk-done')).toBeVisible({ timeout: 100_000 });
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/-documents-\d{4}-\d{2}-\d{2}\.zip$/);

    const entries = unzipSync(new Uint8Array(readFileSync((await file.path())!)));
    const names = Object.keys(entries);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
    for (const [name, bytes] of Object.entries(entries)) {
      expect(name).toMatch(/\.pdf$/);
      expect(Buffer.from(bytes.subarray(0, 5)).toString(), name).toBe('%PDF-');
    }
  });

  test('stopping an export saves nothing', async ({ page }) => {
    await openSeeded(page, '/books/documents');
    await expect(page.getByTestId('document-row').first()).toBeVisible();
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    for (let i = 0; i < 20; i++) await page.getByTestId('doc-select').nth(i).click();
    await page.getByTestId('bulk-export-button').click();
    await page.getByTestId('bulk-cancel').click();
    await expect(page.getByTestId('bulk-cancelled')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(downloads).toBe(0);
  });

  test('the file name pattern is a setting', async ({ page }) => {
    await openSeeded(page, '/books/settings?tab=print');
    await page.getByTestId('bulk-pattern').fill('{business}_{number}');
    await page.getByTestId('bulk-pattern').blur();
    await expect(page.getByText('Template saved')).toBeVisible();

    await page.getByTestId('nav-documents').click();
    await expect(page.getByTestId('document-row').first()).toBeVisible();
    for (let i = 0; i < 2; i++) await page.getByTestId('doc-select').nth(i).click();
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('bulk-export-button').click();
    const entries = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
    for (const name of Object.keys(entries)) expect(name).toMatch(/^Demo-Traders_/);
  });
});
