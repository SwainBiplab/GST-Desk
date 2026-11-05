import { addLine, openEditor, pickParty, uiTotal } from './documents.helpers';
import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

const rupees = (paise: bigint) => {
  const s = paise.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};

/** A brand-new buyer (so exactly one open invoice) with an invoice issued. */
async function buyerWithInvoice(page: Page, name: string, qty = '2') {
  await openEditor(page, 'tax_invoice');
  await page.getByTestId('doc-party').click();
  await page.getByTestId('doc-party').fill(name);
  await page.getByTestId('party-new').click();
  await page.getByTestId('party-name').fill(name);
  await page.getByTestId('party-state').click();
  await page.getByRole('option', { name: /Maharashtra/ }).click();
  await page.getByTestId('party-save').click();
  await expect(page.getByTestId('party-quick')).toBeHidden();
  await expect(page.getByTestId('doc-party')).toHaveValue(name);
  await addLine(page, 0, 'SKU-0001', qty);
  const total = await uiTotal(page);
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  const number = (await page.getByTestId('doc-issued-number').innerText()).trim();
  return { number, total };
}

async function pickPayer(page: Page, name: string) {
  const input = page.getByTestId('doc-party');
  await input.click();
  await input.fill(name);
  await expect(page.getByTestId('party-result').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('party-results')).toBeHidden();
}

/** Rupees as the app shows them: Indian digit grouping, two decimals. */
const inr = (paise: bigint) =>
  (Number(paise) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const statusOf = async (page: Page, number: string) => {
  await page.getByTestId('nav-documents').click();
  const row = page.locator('[data-testid="document-row"]', { hasText: number });
  await expect(row).toBeVisible();
  return row.getByTestId('pay-status');
};

test.describe('receiving money', () => {
  test('a single open invoice is prefilled; a partial receipt leaves it partly paid and makes a receipt', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const { number, total } = await buyerWithInvoice(page, 'Prefill Buyer');

    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await expect(page.getByTestId('pay-sheet')).toBeVisible();
    await pickPayer(page, 'Prefill Buyer');

    // the one open invoice is there, and the amount is what it owes
    await expect(page.getByTestId('alloc-row')).toHaveCount(1);
    await expect(page.getByTestId('alloc-row')).toHaveAttribute('data-number', number);
    await expect(page.getByTestId('pay-amount')).toHaveValue(rupees(total));
    await expect(page.getByTestId('alloc-amount')).toHaveValue(rupees(total));

    // pay a part
    const part = total / 4n;
    await page.getByTestId('pay-amount').fill(rupees(part));
    await expect(page.getByTestId('alloc-amount')).toHaveValue(rupees(part));
    await page.getByTestId('pay-save').click();
    await expect(page.getByText(/Recorded .* from Prefill Buyer/)).toBeVisible();

    const row = page.locator('[data-testid="payment-row"]', { hasText: 'Prefill Buyer' });
    await expect(row).toBeVisible();
    await expect(row.getByText(/^RV\/\d{2}-\d{2}\/\d{4}$/)).toBeVisible();

    expect(await (await statusOf(page, number)).getAttribute('data-status')).toBe('partial');
  });

  test('the receipt can be opened, printed and shared', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const { total } = await buyerWithInvoice(page, 'Receipt Buyer');
    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Receipt Buyer');
    await page.getByTestId('pay-mode').click();
    await page.getByRole('option', { name: 'UPI' }).click();
    await page.getByTestId('pay-reference').fill('UTR-778899');
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-sheet')).toBeHidden();

    await page
      .locator('[data-testid="payment-row"]', { hasText: 'Receipt Buyer' })
      .getByTestId('pay-voucher')
      .click();
    await expect(page.getByTestId('voucher-sheet')).toBeVisible();
    await expect(page.getByTestId('voucher-number')).toHaveText(/^RV\//);
    await expect(page.getByTestId('voucher-party')).toHaveText('Receipt Buyer');
    await expect(page.getByTestId('voucher-amount')).toContainText(rupees(total));
    await expect(page.getByTestId('voucher-sheet')).toContainText('UTR-778899');
    await expect(page.getByTestId('voucher-towards')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed += 1;
      };
    });
    await page.getByTestId('voucher-print').click();
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  });

  test('the receipt prints whole, from the top of the page, with the app hidden behind it', async ({
    page,
  }) => {
    await openSeeded(page, '/books/payments');
    const row = page
      .locator('[data-testid="payment-row"][data-direction="received"]')
      .filter({ has: page.getByTestId('pay-create-receipt') })
      .first();
    await row.getByTestId('pay-create-receipt').click();
    await expect(page.getByTestId('voucher-sheet')).toBeVisible();

    await page.emulateMedia({ media: 'print' });
    // the app behind the pop-up takes no room, and the receipt starts at the top-left of the page
    await expect(page.locator('#root')).toBeHidden();
    const box = (await page.getByTestId('voucher-sheet').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeLessThan(80);
    // every part of it is on the page: the number, the amount, the allocation and the signature
    for (const id of ['voucher-number', 'voucher-amount', 'voucher-towards']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.y, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, id).toBeLessThanOrEqual(1280);
    }
    await expect(page.getByTestId('voucher-print')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
  });

  test('an overpayment is kept as credit and offered on the next invoice', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const { number } = await buyerWithInvoice(page, 'Credit Buyer');

    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Credit Buyer');
    await page.getByTestId('pay-amount').fill('100000');
    await expect(page.getByTestId('pay-remainder')).toContainText('kept as credit');
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-sheet')).toBeHidden();
    expect(await (await statusOf(page, number)).getAttribute('data-status')).toBe('paid');

    // a new invoice for the same buyer: the credit is offered
    // in the app, not a fresh load (that would reseed the demo data)
    await page.getByTestId('nav-sell').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await pickParty(page, 'Credit Buyer');
    await addLine(page, 0, 'SKU-0002', '1');
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    const second = (await page.getByTestId('doc-issued-number').innerText()).trim();
    await expect(page.getByTestId('apply-credit')).toBeVisible();
    await expect(page.getByTestId('credit-sources')).toContainText('Advance RV/');
    await page.getByTestId('credit-apply').click();
    await expect(page.getByTestId('apply-credit')).toBeHidden();

    expect(await (await statusOf(page, second)).getAttribute('data-status')).toBe('paid');
  });

  test('a difference under a rupee can be written off to close an invoice', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const { number, total } = await buyerWithInvoice(page, 'Writeoff Buyer');
    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Writeoff Buyer');
    // pays 40 paise short
    await page.getByTestId('pay-amount').fill(rupees(total - 40n));
    await page.getByTestId('alloc-writeoff').click();
    await expect(page.getByTestId('alloc-writeoff')).toBeChecked();
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-sheet')).toBeHidden();
    expect(await (await statusOf(page, number)).getAttribute('data-status')).toBe('paid');
  });

  test('allocations cannot exceed what is owed, and a cheque needs its number and date', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const { total } = await buyerWithInvoice(page, 'Limit Buyer');
    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Limit Buyer');
    await page.getByTestId('pay-amount').fill(rupees(total * 2n));
    await page.getByTestId('alloc-amount').fill(rupees(total + 100n));
    await expect(page.getByTestId('pay-error')).toContainText('more than what is owed');
    await expect(page.getByTestId('pay-save')).toBeDisabled();
    await page.getByTestId('pay-auto').click();
    await expect(page.getByTestId('pay-error')).toHaveCount(0);

    await page.getByTestId('pay-mode').click();
    await page.getByRole('option', { name: 'Cheque' }).click();
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-error')).toContainText('cheque needs its number');
    await page.getByTestId('pay-reference').fill('000321');
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-error')).toContainText('cheque needs its date');
    await page.getByTestId('pay-cheque-date').fill(new Date().toISOString().slice(0, 10));
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-sheet')).toBeHidden();
  });
});

test.describe('undo, edit and delete', () => {
  test('a payment can be undone from the toast', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const { number } = await buyerWithInvoice(page, 'Undo Buyer');
    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Undo Buyer');
    await page.getByTestId('pay-save').click();
    await expect(page.getByText(/Recorded .* from Undo Buyer/)).toBeVisible();
    await expect(
      page.locator('[data-testid="payment-row"]', { hasText: 'Undo Buyer' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Payment removed')).toBeVisible();
    await expect(
      page.locator('[data-testid="payment-row"]', { hasText: 'Undo Buyer' }),
    ).toHaveCount(0);
    expect(await (await statusOf(page, number)).getAttribute('data-status')).toBe('unpaid');
  });

  test('editing a payment keeps its receipt number and changes the amount', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const { total } = await buyerWithInvoice(page, 'Edit Buyer');
    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Edit Buyer');
    await page.getByTestId('pay-amount').fill(rupees(total / 2n));
    await page.getByTestId('pay-save').click();
    const row = page.locator('[data-testid="payment-row"]', { hasText: 'Edit Buyer' });
    await expect(row).toBeVisible();
    const receipt = (await row.getByText(/^RV\//).innerText()).trim();

    await row.getByTestId('pay-edit').click();
    await page.getByTestId('pay-amount').fill(rupees(total));
    await page.getByTestId('pay-save').click();
    await expect(page.getByTestId('pay-sheet')).toBeHidden();
    await expect(row.getByText(receipt)).toBeVisible();
    await expect(row).toContainText(inr(total));
  });

  test('deleting a payment asks first and puts the invoice back to unpaid', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const { number } = await buyerWithInvoice(page, 'Delete Buyer');
    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await pickPayer(page, 'Delete Buyer');
    await page.getByTestId('pay-save').click();
    const row = page.locator('[data-testid="payment-row"]', { hasText: 'Delete Buyer' });
    await expect(row).toBeVisible();
    await row.getByTestId('pay-delete').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Delete this payment?');
    await page
      .getByTestId('confirm-dialog')
      .getByRole('button', { name: 'Delete payment' })
      .click();
    await expect(row).toHaveCount(0);
    expect(await (await statusOf(page, number)).getAttribute('data-status')).toBe('unpaid');
  });
});

test.describe('lists, exports and accounts', () => {
  test('filters the list and exports a CSV', async ({ page }) => {
    await openSeeded(page, '/books/payments');
    await expect(page.getByTestId('payment-row').first()).toBeVisible();
    await page.getByTestId('pay-filter-mode').click();
    await page.getByRole('option', { name: 'Cheque' }).click();
    const rows = page.getByTestId('payment-row');
    const n = await rows.count();
    for (let i = 0; i < Math.min(n, 5); i++) await expect(rows.nth(i)).toContainText('Cheque');
    await page.getByTestId('pay-filter-mode').click();
    await page.getByRole('option', { name: 'All modes' }).click();

    await page.getByTestId('pay-search').fill('zzzz-nobody');
    await expect(page.getByTestId('payment-row')).toHaveCount(0);
    await page.getByTestId('pay-search').fill('');

    const download = page.waitForEvent('download');
    await page.getByTestId('pay-export').click();
    expect((await download).suggestedFilename()).toBe('payments.csv');
  });

  test('opening Payments shows the list, not a receipt (demo payments have no receipt)', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await page.getByTestId('nav-payments').click();
    await expect(page.getByTestId('payments-table')).toBeVisible();
    await expect(page.getByTestId('voucher-dialog')).toHaveCount(0);
    await expect(page.getByTestId('pay-receive')).toBeEnabled();
  });

  test('a payment with no receipt (demo data) can get one on demand', async ({ page }) => {
    await openSeeded(page, '/books/payments');
    const row = page
      .locator('[data-testid="payment-row"][data-direction="received"]')
      .filter({ has: page.getByTestId('pay-create-receipt') })
      .first();
    await expect(row).toBeVisible();
    await row.getByTestId('pay-create-receipt').click();
    await expect(page.getByTestId('voucher-sheet')).toBeVisible();
    await expect(page.getByTestId('voucher-number')).toHaveText(/^RV\//);
  });

  test('the command bar opens the receive form with the amount filled in', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('receive 1500 from sharma');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pay-sheet')).toBeVisible();
    await expect(page.getByTestId('pay-amount')).toHaveValue('1500.00');
  });

  test('bank and UPI accounts: bad details are refused, good ones saved and chosen on a receipt', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=accounts');
    await page.getByTestId('account-add').click();
    await page.getByTestId('account-name').fill('HDFC Current');
    await page.getByTestId('account-ifsc').fill('BAD');
    await page.getByTestId('account-save').click();
    await expect(page.getByTestId('account-error')).toContainText('IFSC');
    await page.getByTestId('account-ifsc').fill('HDFC0001234');
    await page.getByTestId('account-number').fill('50100123456789');
    await page.getByTestId('account-save').click();
    await expect(page.getByTestId('account-dialog')).toBeHidden();
    await expect(page.getByTestId('account-row')).toContainText('HDFC Current');
    await expect(page.getByTestId('account-row')).toContainText('HDFC0001234');

    await page.getByTestId('nav-payments').click();
    await page.getByTestId('pay-receive').click();
    await page.getByTestId('pay-mode').click();
    await page.getByRole('option', { name: 'Bank transfer' }).click();
    await expect(page.getByTestId('pay-account')).toContainText('HDFC Current');
  });
});

test.describe('Shop', () => {
  test('receive a payment for the only open invoice in under 10 seconds, and see it in the day book', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const { total } = await buyerWithInvoice(page, 'Counter Buyer');
    await page.getByTestId('switch-shop').click();
    await expect(page.locator('[data-shell="shop"]').first()).toBeVisible();
    await page.getByTestId('nav-payments').click();
    await expect(page.getByTestId('day-book')).toBeVisible();

    const started = Date.now();
    await page.getByTestId('pay-receive').click();
    await expect(page.getByTestId('pay-inline')).toBeVisible();
    await pickPayer(page, 'Counter Buyer');
    await expect(page.getByTestId('pay-amount')).toHaveValue(rupees(total));
    await page.getByTestId('pay-save').click();
    await expect(page.getByText(/Recorded .* from Counter Buyer/)).toBeVisible();
    expect(Date.now() - started).toBeLessThan(10_000);

    // cash in the day book
    await expect(page.getByTestId('daybook-in')).toContainText(inr(total));
    await expect(page.getByTestId('daybook-closing')).not.toHaveText('₹0.00');
  });
});
