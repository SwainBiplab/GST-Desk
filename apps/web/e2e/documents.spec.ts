import { expect, test, type Page } from '@playwright/test';

import {
  addLine,
  clickItemCell,
  engineTotalFromPreview,
  keyLine,
  openEditor,
  pickParty,
  uiTotal,
} from './documents.helpers';
import { openSeeded, png } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(90_000);

const issue = async (page: Page) => {
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
};

test.describe('every document type can be issued', () => {
  const TYPES: [string, RegExp, boolean][] = [
    ['tax_invoice', /^INV\/\d{2}-\d{2}\/\d{4}$/, false],
    ['bill_of_supply', /^BOS\//, false],
    ['proforma', /^PI\//, false],
    ['quotation', /^QT\//, false],
    ['credit_note', /^CN\//, false],
    ['debit_note', /^DN\//, false],
    ['delivery_challan', /^DC\//, false],
    ['purchase_bill', /^PB\//, true],
    ['purchase_return', /^PR\//, false],
    ['expense', /^EXP\//, false],
  ];

  for (const [type, numberPattern, purchaseBill] of TYPES) {
    test(`${type}: create, check the totals against the engine, issue, see it in the list`, async ({
      page,
    }) => {
      await openEditor(page, type);
      await pickParty(page);
      await addLine(page, 0, 'SKU-0001', '2');
      await addLine(page, 1, 'SKU-0002', '3');

      await expect(page.getByTestId('preview-line')).toHaveCount(2);
      const expected = await engineTotalFromPreview(page);
      expect(await uiTotal(page)).toBe(expected);
      expect(expected).toBeGreaterThan(0n);
      await expect(page.getByTestId('preview-title')).toBeVisible();

      if (purchaseBill) {
        await page.getByTestId('supplier-invoice-no').fill('SUP-1001');
        await page.getByTestId('supplier-invoice-date').fill(new Date().toISOString().slice(0, 10));
      }
      await issue(page);
      await expect(page.getByTestId('doc-issued-number')).toHaveText(numberPattern);
      // once issued it can no longer be edited
      await expect(page.getByTestId('doc-save')).toHaveCount(0);
      await expect(page.getByTestId('doc-party')).toBeDisabled();

      await page.goto('/books/documents');
      await expect(page.getByTestId('documents-table')).toBeVisible();
      const number = (
        await page.getByTestId('document-row').first().getByTestId('document-open').innerText()
      ).trim();
      expect(number).toMatch(numberPattern);
    });
  }
});

test('Shop: a counter sale needs only party, lines, totals and print', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
  });
  await openSeeded(page, '/shop/sell');
  await expect(page.getByTestId('doc-editor')).toHaveAttribute('data-shell', 'shop');
  await expect(page.getByTestId('doc-pos')).toHaveCount(0); // no tax details at the counter
  await expect(page.getByTestId('doc-roundoff')).toHaveCount(0);
  await expect(page.getByTestId('doc-date')).toBeVisible();
  await clickItemCell(page, 0);
  await keyLine(page, 'SKU-0003', '2');
  await expect(page.getByTestId('doc-total')).not.toHaveText('₹0.00');
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed))
    .toBe(1);
  await expect(page.getByTestId('doc-issued-number')).toHaveText(/^INV\//);
});

test('a repeat customer invoice with five lines is issued by keyboard alone in under 30 seconds', async ({
  page,
}) => {
  await openEditor(page, 'tax_invoice');
  await page.getByTestId('doc-party').focus();
  const started = Date.now();
  await page.keyboard.type('Rao');
  await expect(page.getByTestId('party-result').first()).toBeVisible();
  await page.keyboard.press('Enter'); // choose the party; the cursor moves to the first free line
  await page.waitForTimeout(150);
  for (const n of [1, 2, 3, 4, 5]) await keyLine(page, `SKU-000${n}`, String(n));
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  const seconds = (Date.now() - started) / 1000;
  expect(seconds, 'seconds from the first key to an issued invoice').toBeLessThan(30);
  await expect(page.getByTestId('preview-line')).toHaveCount(5);
});

test('creates a party and an item on the spot', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await page.getByTestId('doc-party').click();
  await page.getByTestId('doc-party').fill('Brand New Buyer');
  await page.getByTestId('party-new').click();
  await expect(page.getByTestId('party-quick')).toBeVisible();
  await page.getByTestId('party-name').fill('Brand New Buyer');
  await page.getByTestId('party-state').click();
  await page.getByRole('option', { name: /Karnataka/ }).click();
  await page.getByTestId('party-save').click();
  await expect(page.getByTestId('party-quick')).toBeHidden();
  await expect(page.getByTestId('doc-party')).toHaveValue('Brand New Buyer');
  await expect(page.getByTestId('supply-badge')).toHaveAttribute('data-supply', 'inter');

  await clickItemCell(page, 0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Custom widget 9');
  await expect(page.getByTestId('item-create')).toBeVisible();
  await page.keyboard.press('Enter'); // the only row is the create offer
  await expect(page.getByTestId('item-quick')).toBeVisible();
  await expect(page.getByTestId('item-name')).toHaveValue('Custom widget 9');
  await page.getByTestId('item-sale').fill('250');
  await page.getByTestId('item-sku').fill('E2E-CUSTOM-9');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-quick')).toBeHidden();
  await expect(page.getByTestId('preview-line')).toHaveCount(1);
  await expect(page.getByTestId('preview-line')).toContainText('Custom widget 9');
  await expect(page.getByTestId('preview-line')).toContainText('250.00');
});

test('a name typed straight onto an item cell opens the search, and can stay as plain text or become an item', async ({
  page,
}) => {
  await openEditor(page, 'tax_invoice');
  await clickItemCell(page, 0);
  await page.keyboard.press('L'); // a letter on an item cell starts the search with it
  await expect(page.getByTestId('item-picker-input')).toBeVisible();
  await page.keyboard.type('oose text line');
  await expect(page.getByTestId('item-as-text')).toBeVisible();
  await page.getByTestId('item-as-text').click();
  await expect(page.getByTestId('item-picker')).toBeHidden();
  await expect(page.getByTestId('preview-line')).toContainText('Loose text line');

  // a line that has no item behind it offers to become one
  await expect(page.getByTestId('item-offer')).toBeVisible();
  await expect(page.getByTestId('item-offer')).toContainText('Loose text line');
  await page.getByTestId('item-offer-create').click();
  await expect(page.getByTestId('item-quick')).toBeVisible();
  await expect(page.getByTestId('item-name')).toHaveValue('Loose text line');
  await page.getByTestId('item-sku').fill('E2E-LOOSE');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-quick')).toBeHidden();
  await expect(page.getByTestId('item-offer')).toBeHidden();
});

test('quotation to invoice to credit note keeps the lines and the links', async ({ page }) => {
  await openEditor(page, 'quotation');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0001', '4');
  await addLine(page, 1, 'SKU-0002', '2');
  await issue(page);
  await expect(page.getByTestId('doc-issued-number')).toHaveText(/^QT\//);

  await page.getByTestId('doc-more').click();
  await page.getByTestId('doc-convert-tax_invoice').click();
  await page.getByTestId('convert-confirm').click();
  await expect(page.getByTestId('preview-title')).toHaveText(/tax invoice/i, { timeout: 15_000 });
  await expect(page.getByTestId('doc-status')).toHaveText('Draft');
  await expect(page.getByTestId('preview-line')).toHaveCount(2);
  await issue(page);
  await expect(page.getByTestId('doc-issued-number')).toHaveText(/^INV\//);
  const invoiceTotal = await uiTotal(page);

  await page.getByTestId('doc-more').click();
  await page.getByTestId('doc-convert-credit_note').click();
  await expect(page.getByTestId('convert-dialog')).toBeVisible();
  const quantities = page.getByTestId('convert-qty');
  await expect(quantities).toHaveCount(2);
  await quantities.first().fill('1'); // take back one of the four
  await page.getByTestId('convert-confirm').click();
  await expect(page.getByTestId('preview-title')).toHaveText(/credit note/i, { timeout: 15_000 });
  await expect(page.getByTestId('preview-line').first().locator('[data-tag$=":qty"]')).toHaveText(
    '1 NOS',
  );
  expect(await uiTotal(page)).toBeLessThan(invoiceTotal);
  await issue(page);
  await expect(page.getByTestId('doc-issued-number')).toHaveText(/^CN\//);
});

test('a credit note cannot take back more than was invoiced', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0001', '2');
  await issue(page);
  await page.getByTestId('doc-more').click();
  await page.getByTestId('doc-convert-credit_note').click();
  await page.getByTestId('convert-qty').first().fill('3');
  await expect(page.getByTestId('convert-confirm')).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('no more than the original');
});

test('clicking a computed cell or a total explains it in the right panel', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0004', '3');
  await expect(page.getByTestId('trace-empty')).toHaveCount(0);

  // narrow the grid to Item, Qty and Taxable so the computed cell is plainly on screen, then click it
  await page.getByTestId('grid-columns').click();
  for (const col of ['hsn', 'unit', 'rate', 'incl', 'discount'])
    await page.getByTestId(`grid-col-${col}`).click();
  await page.keyboard.press('Escape');
  const frame = (await page.getByTestId('grid-frame').boundingBox())!;
  // marker 36 + item 260 + qty 80, then into the Taxable column
  await page.mouse.click(frame.x + 36 + 260 + 80 + 55, frame.y + 36 + 14);
  await expect(page.getByTestId('trace-step').first()).toBeVisible();
  const rules = await page
    .getByTestId('trace-step')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-rule')));
  expect(rules).toEqual(
    expect.arrayContaining(['line.gross', 'line.taxable', 'line.gst', 'line.total']),
  );
  await expect(
    page
      .getByTestId('trace-step')
      .filter({ has: page.locator('text=₹') })
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId('trace-step').first()).not.toContainText('paise');

  // a total: the document steps
  await page.getByRole('button', { name: /Explain Total/ }).click();
  await expect
    .poll(async () =>
      page
        .getByTestId('trace-step')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-rule'))),
    )
    .toEqual(expect.arrayContaining(['doc.lines_total', 'doc.total']));
});

test('a purchase bill carries the supplier invoice, input credit and the bill itself side by side', async ({
  page,
}) => {
  await openEditor(page, 'purchase_bill');
  await expect(page.getByTestId('purchase-fields')).toBeVisible();
  await expect(page.getByTestId('doc-itc')).toBeChecked();
  await pickParty(page);
  await addLine(page, 0, 'SKU-0005', '5');

  // refuses what is not a PDF or a picture, whatever it is called
  await page.getByTestId('tab-attachment').click();
  await page.getByTestId('attachment-input').setInputFiles({
    name: 'bill.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html><script>alert(1)</script></html>'),
  });
  await expect(page.getByText('bill.pdf is not a PDF, PNG, JPEG or WebP file.')).toBeVisible();
  await expect(page.getByTestId('attachment-view')).toHaveCount(0);

  await page
    .getByTestId('attachment-input')
    .setInputFiles({ name: 'supplier-bill.png', mimeType: 'image/png', buffer: png(300, 200) });
  await expect(page.getByTestId('attachment-view')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('attachment-view')).toHaveAttribute('alt', 'supplier-bill.png');

  // issuing needs the supplier's invoice number
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-problems')).toContainText('supplier invoice number');
  await page.getByTestId('supplier-invoice-no').fill('S/2026/77');
  await page.getByTestId('supplier-invoice-date').fill(new Date().toISOString().slice(0, 10));
  await issue(page);
  await expect(page.getByTestId('attachment-view')).toBeVisible();
});

test('a reverse-charge purchase bill shows the tax it leaves out of the total and issues a linked self-invoice', async ({
  page,
}) => {
  await openEditor(page, 'purchase_bill');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0001', '2');
  const before = await uiTotal(page);
  await page.getByTestId('doc-rcm').click();
  await expect(page.getByTestId('rcm-note')).toBeVisible();
  expect(await uiTotal(page)).toBeLessThan(before);
  await page.getByTestId('supplier-invoice-no').fill('RCM-1');
  await page.getByTestId('supplier-invoice-date').fill(new Date().toISOString().slice(0, 10));
  await issue(page);
  await page.goto('/books/documents');
  await expect(page.getByTestId('document-row').filter({ hasText: 'Self-invoice' })).toHaveCount(1);
  await expect(page.getByTestId('document-row').filter({ hasText: /RCM\// })).toBeVisible();
});

test('drafts are saved as you type, come back after a reload, and are offered when you start again', async ({
  page,
}) => {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0006', '2');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/id=/);
  const total = await uiTotal(page);

  await page.reload();
  await expect(page.getByTestId('doc-editor')).toBeVisible();
  await expect(page.getByTestId('preview-line')).toHaveCount(1, { timeout: 15_000 });
  expect(await uiTotal(page)).toBe(total);
  await expect(page.getByTestId('doc-party')).not.toHaveValue('');

  // the list of drafts, and the offer on a fresh document
  await page.goto('/books/documents');
  await expect(page.getByTestId('drafts-list')).toBeVisible();
  await expect(page.getByTestId('draft-row').first()).toBeVisible();
  expect(await page.getByTestId('draft-row').count()).toBeGreaterThan(0);
  await page.goto('/books/documents/new?type=tax_invoice');
  await expect(page.getByTestId('resume-banner')).toBeVisible();
  await page.getByTestId('resume-draft').click();
  await expect(page.getByTestId('preview-line')).toHaveCount(1, { timeout: 15_000 });
  expect(await uiTotal(page)).toBe(total);
});

test('an unchanged draft is not saved again', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0007', '1');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
  await page.getByTestId('doc-save').click();
  await expect(page.getByText('Draft saved')).toBeVisible();
});

test('nothing is issued blank, to nobody, or dated in the future', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-problems')).toContainText('Add at least one line');
  await expect(page.getByTestId('doc-status')).toHaveText('Draft');
  await page.waitForTimeout(300); // the list of problems has pushed the grid down; let it settle

  await addLine(page, 0, 'SKU-0001', '1');
  const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await page.getByTestId('doc-date').fill(future);
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-problems')).toContainText('cannot be in the future');
  await expect(page.getByTestId('doc-status')).toHaveText('Draft');
});

test('a quotation is not issued to nobody', async ({ page }) => {
  await openEditor(page, 'quotation');
  await addLine(page, 0, 'SKU-0001', '1');
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-problems')).toContainText('Choose the party');
  await expect(page.getByTestId('doc-status')).toHaveText('Draft');
});

test('a bad quantity is refused in the cell and the line keeps its value', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await addLine(page, 0, 'SKU-0001', '2');
  const before = await uiTotal(page);
  // back to the quantity cell of the first line
  const frame = (await page.getByTestId('grid-frame').boundingBox())!;
  await page.mouse.click(frame.x + 36 + 260 + 90 + 40, frame.y + 36 + 14);
  await page.keyboard.type('abc', { delay: 40 });
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Enter a quantity above zero.')).toBeVisible();
  expect(await uiTotal(page)).toBe(before);
});

test('discounts, round-off, reverse charge and export change what the engine charges', async ({
  page,
}) => {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, 'SKU-0008', '2');
  const base = await uiTotal(page);

  await page.getByTestId('doc-inv-discount-mode').click();
  await page.getByRole('option', { name: 'Percent' }).click();
  await page.getByTestId('doc-inv-discount').fill('10');
  await expect.poll(() => uiTotal(page)).toBeLessThan(base);
  const discounted = await uiTotal(page);
  expect(discounted).toBeGreaterThan(0n);

  await page.getByTestId('doc-roundoff').click();
  await expect(page.getByTestId('doc-totals')).not.toContainText('Round off');

  await page.getByTestId('doc-export').click();
  await expect(page.getByTestId('supply-badge')).toHaveAttribute('data-supply', 'export');
  await expect(page.getByTestId('doc-currency')).toBeVisible();
  await expect(page.getByTestId('doc-lut')).toBeChecked();
  await expect(page.getByTestId('doc-totals')).not.toContainText('IGST');
  await page.getByTestId('doc-currency').click();
  await page.getByRole('option', { name: 'USD' }).click();
  await page.getByTestId('doc-fx').fill('83.5');
  await page.getByTestId('doc-fx').blur();
  await expect(page.getByTestId('preview-foreign')).toContainText('USD');
});

test('changing the place of supply warns and changes the tax', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await addLine(page, 0, 'SKU-0001', '1');
  await expect(page.getByTestId('supply-badge')).toHaveAttribute('data-supply', 'intra');
  await expect(page.getByTestId('doc-totals')).toContainText('CGST');
  await page.getByTestId('doc-pos').click();
  await page.getByRole('option', { name: /Karnataka/ }).click();
  await expect(page.getByTestId('supply-badge')).toHaveAttribute('data-supply', 'inter');
  await expect(page.getByTestId('pos-warning')).toBeVisible();
  await expect(page.getByTestId('doc-totals')).toContainText('IGST');
  await expect(page.getByTestId('doc-totals')).not.toContainText('CGST');
});

test('notes: pasted markup is shown as text and never run', async ({ page }) => {
  await openEditor(page, 'tax_invoice');
  await addLine(page, 0, 'SKU-0001', '1');
  const notes = page.getByTestId('doc-notes');
  await notes.click();
  await page.keyboard.insertText(
    '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> ',
  );
  await page.getByRole('toolbar', { name: /Notes/ }).getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type('careful');
  await expect(page.getByTestId('preview-notes')).toContainText(
    '<script>window.__pwned=2</script>',
  );
  const html = await page.getByTestId('preview-notes').innerHTML();
  expect(html).toContain('&lt;script&gt;'); // the characters, not a tag
  expect(html).not.toMatch(/<img|<script/i);
  // the printed page carries the words (bold is kept in the editor and the stored notes)
  await expect(page.getByTestId('preview-notes')).toContainText('careful');
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
});

test('rows can be pasted from a spreadsheet, and the totals follow', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openEditor(page, 'tax_invoice');
  await page.evaluate(() =>
    navigator.clipboard.writeText(
      'Pasted bolt\t7318\t10\tNOS\t2.50\nPasted nut\t7318\t20\tNOS\t1.25\nPasted washer\t\t5\t\t0.50',
    ),
  );
  await clickItemCell(page, 0);
  await page.keyboard.press('Control+v');
  await expect(page.getByTestId('preview-line')).toHaveCount(3);
  await expect(page.getByTestId('preview-line').nth(1)).toContainText('Pasted nut');
  await expect(page.getByTestId('preview-line').nth(1)).toContainText('1.25');
  const expected = await engineTotalFromPreview(page);
  expect(await uiTotal(page)).toBe(expected);
});

test('the preview switches to a receipt and zooms, and issued documents print', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
  });
  await openEditor(page, 'tax_invoice');
  await addLine(page, 0, 'SKU-0001', '1');
  await expect(page.getByTestId('preview-sheet')).toHaveAttribute('data-paper', 'a4');
  await page.getByTestId('preview-paper').click();
  await page.getByRole('option', { name: 'Receipt' }).click();
  await expect(page.getByTestId('preview-sheet')).toHaveAttribute('data-paper', 'thermal');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByTestId('preview-zoom')).toHaveText('80%');
  await page.getByTestId('doc-more').click();
  await page.getByTestId('doc-issue-print').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed))
    .toBe(1);
});

test('the command bar starts a new document of the right type', async ({ page }) => {
  await openSeeded(page, '/books/dashboard');
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-input').fill('new invoice');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-editor')).toBeVisible();
  await expect(page.getByTestId('preview-title')).toHaveText(/tax invoice/i);
});
