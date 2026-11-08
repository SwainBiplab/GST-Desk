import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

/** What the screen shows as an amount: ₹ and commas out. */
const rupees = (s: string | null) => Number((s ?? '').replace(/[₹,\s]/g, ''));

/** A scanner types its code in a burst and ends with Enter: type fast, then Enter. */
async function scan(page: Page, code: string) {
  const box = page.getByTestId('pos-scan');
  await box.focus();
  await box.pressSequentially(code, { delay: 0 });
  await page.keyboard.press('Enter');
}

/** Make a counter, open a shift with a float, and wait for the scan box. */
async function openCounter(page: Page, float = '1000') {
  await openSeeded(page, '/shop/pos');
  await expect(page.getByTestId('pos-counter-setup')).toBeVisible();
  await page.getByTestId('pos-counter-create').click();
  await expect(page.getByTestId('pos-open-shift')).toBeVisible();
  await page.getByTestId('pos-float').fill(float);
  await page.getByTestId('pos-open').click();
  await expect(page.getByTestId('pos-scan')).toBeVisible();
}

test.describe('the counter', () => {
  test('scanning adds the item in under 100 ms, accumulates quantity, and the total is the lines', async ({
    page,
  }) => {
    await openCounter(page);
    await scan(page, 'SKU-0002');
    await expect(page.getByTestId('pos-line')).toHaveCount(1);
    await expect(page.getByTestId('pos-note')).toHaveAttribute('data-kind', 'ok');
    // the line was on screen within a frame or two of the Enter
    await expect
      .poll(async () => Number(await page.getByTestId('pos-note').getAttribute('data-scan-ms')), {
        timeout: 5000,
      })
      .toBeLessThan(100);
    await scan(page, 'SKU-0002');
    await expect(page.getByTestId('pos-line')).toHaveCount(1);
    await expect(page.getByTestId('pos-qty').first()).toHaveValue('2');
    await scan(page, 'SKU-0003');
    await expect(page.getByTestId('pos-line')).toHaveCount(2);
    const lines = await page.getByTestId('pos-line-total').allTextContents();
    const sum = lines.reduce((s, v) => s + rupees(v), 0);
    // lines are priced before the bill is rounded to the rupee
    expect(Math.abs(rupees(await page.getByTestId('pos-total').textContent()) - sum)).toBeLessThan(
      1,
    );

    // an unknown code says so and changes nothing
    await scan(page, 'NOSUCHCODE9');
    await expect(page.getByTestId('pos-note')).toHaveAttribute('data-kind', 'error');
    await expect(page.getByTestId('pos-line')).toHaveCount(2);

    // "3*code" sells three; the quantity can be edited and a discount given
    await scan(page, '3*SKU-0004');
    await expect(page.getByTestId('pos-line')).toHaveCount(3);
    await expect(page.getByTestId('pos-qty').nth(2)).toHaveValue('3');
    const before = rupees(await page.getByTestId('pos-total').textContent());
    await page.getByTestId('pos-discount').nth(2).fill('10');
    await page.getByTestId('pos-discount').nth(2).blur();
    await expect
      .poll(async () => rupees(await page.getByTestId('pos-total').textContent()))
      .toBeLessThan(before);
    await page.getByTestId('pos-remove').nth(2).click();
    await expect(page.getByTestId('pos-line')).toHaveCount(2);
  });

  test('holds a bill while another customer is served, then recalls it whole', async ({ page }) => {
    await openCounter(page);
    await scan(page, 'SKU-0002');
    await scan(page, 'SKU-0003');
    const total = rupees(await page.getByTestId('pos-total').textContent());
    await page.getByTestId('pos-hold').click();
    await expect(page.getByTestId('pos-line')).toHaveCount(0);
    await expect(page.getByTestId('pos-held-count')).toHaveText('1');
    // the next customer
    await scan(page, 'SKU-0005');
    await expect(page.getByTestId('pos-line')).toHaveCount(1);
    await page.getByTestId('pos-recall-open').click();
    await expect(page.getByTestId('pos-held')).toHaveCount(1);
    await page.getByTestId('pos-recall-one').click();
    // the bill on the screen was put aside, the held one is back
    await expect(page.getByTestId('pos-line')).toHaveCount(2);
    expect(rupees(await page.getByTestId('pos-total').textContent())).toBe(total);
    await expect(page.getByTestId('pos-held-count')).toHaveText('1');
  });

  test('takes a split payment with change, returns goods against the bill, and closes the shift with a variance', async ({
    page,
  }) => {
    await openCounter(page, '1000');
    // quick keys are there for the items sold most
    await expect(page.getByTestId('pos-quick-key').first()).toBeVisible();

    await scan(page, 'SKU-0002');
    await scan(page, '2*SKU-0003');
    const total = rupees(await page.getByTestId('pos-total').textContent());
    await page.keyboard.press('F2');
    await expect(page.getByTestId('pos-pay')).toBeVisible();
    expect(rupees(await page.getByTestId('pos-pay-due').textContent())).toBe(total);
    // UPI 100 and cash handed over 50 more than the rest: 50 change
    await page.getByTestId('tender-upi').fill('100');
    await page.getByTestId('ref-upi').fill('UPI-1234');
    await page.getByTestId('tender-cash').fill(String(total - 100 + 50));
    await expect(page.getByTestId('pos-pay-change')).toContainText('50.00');
    await expect(page.getByTestId('pos-pay-confirm')).toBeEnabled();
    // UPI above the total is refused on the spot
    await page.getByTestId('tender-upi').fill(String(total + 1));
    await expect(page.getByTestId('pos-pay-over')).toBeVisible();
    await expect(page.getByTestId('pos-pay-confirm')).toBeDisabled();
    await page.getByTestId('tender-upi').fill('100');
    await page.getByTestId('pos-pay-confirm').click();
    await expect(page.getByTestId('pos-pay')).toHaveCount(0);
    await expect(page.getByTestId('pos-line')).toHaveCount(0);
    const note = (await page.getByTestId('pos-note').textContent()) ?? '';
    expect(note).toMatch(/paid/);
    expect(note).toMatch(/50\.00/);
    const number = /Bill (\S+) paid/.exec(note)![1]!;

    // a second, plain cash sale
    await scan(page, 'SKU-0004');
    await page.keyboard.press('Enter'); // an empty Enter goes to payment
    await expect(page.getByTestId('pos-pay')).toBeVisible();
    const due2 = rupees(await page.getByTestId('pos-pay-due').textContent());
    await page.getByTestId('tender-cash').fill(String(due2));
    await page.getByTestId('pos-pay-confirm').click();
    await expect(page.getByTestId('pos-pay')).toHaveCount(0);

    // cash out for tea
    await page.keyboard.press('F8');
    await page.getByTestId('cash-amount').fill('100');
    await page.getByTestId('cash-reason').fill('Tea for the staff');
    await page.getByTestId('cash-save').click();
    await expect(page.getByTestId('pos-cash')).toHaveCount(0);

    // one of the two SKU-0003 comes back: type the bill's number, as if the QR had been scanned
    await page.keyboard.press('F6');
    await page.getByTestId('pos-return-code').fill(number);
    await page.getByTestId('pos-return-find').click();
    await expect(page.getByTestId('pos-return-line')).toHaveCount(2);
    await page.getByTestId('pos-return-qty-2').fill('1');
    await page.getByTestId('pos-refund-cash').check();
    await page.getByTestId('pos-return-confirm').click();
    await expect(page.getByTestId('pos-return')).toHaveCount(0);

    // asking for more than was sold is refused
    await page.keyboard.press('F6');
    await page.getByTestId('pos-return-code').fill(number);
    await page.getByTestId('pos-return-find').click();
    await page.getByTestId('pos-return-qty-2').fill('5');
    await page.getByTestId('pos-return-confirm').click();
    await expect(page.getByTestId('pos-return')).toBeVisible();
    await page.getByTestId('pos-return').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('pos-return')).toHaveCount(0);

    // the shift so far
    await page.getByTestId('pos-xreport-open').click();
    await expect(page.getByTestId('z-sales-count')).toHaveText('2');
    await expect(page.getByTestId('z-returns-count')).toHaveText('1');
    await page.keyboard.press('Escape');

    // close: count short, the variance is the count less what the drawer should hold
    await page.getByTestId('pos-close-open').click();
    await page.getByTestId('close-counted').fill('0');
    await expect(page.getByTestId('close-preview')).toHaveAttribute('data-status', 'short');
    await page.getByTestId('close-confirm').click();
    await expect(page.getByTestId('close-result')).toHaveAttribute('data-status', 'short');
    await expect(page.getByTestId('z-sales-count')).toHaveText('2');
    const expected = rupees(await page.getByTestId('z-expected').textContent());
    expect(expected).toBeGreaterThan(1000); // the float plus the cash taken, less the refund and the tea
    await expect(page.getByTestId('close-result')).toContainText(
      String(expected.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    );
    await page.getByRole('button', { name: 'Done' }).click();
    // the shift is closed: the counter asks for a new one
    await expect(page.getByTestId('pos-open-shift')).toBeVisible();
  });

  test('the customer display, in a second window, shows the lines and the total', async ({
    page,
    context,
  }) => {
    await openCounter(page);
    const display = await context.newPage();
    await display.goto('/shop/pos?display=1');
    await expect(display.getByTestId('pos-display')).toBeVisible();
    await scan(page, 'SKU-0002');
    await expect(page.getByTestId('pos-line')).toHaveCount(1);
    const total = (await page.getByTestId('pos-total').textContent()) ?? '';
    await expect(display.getByTestId('pos-display-total')).toHaveText(total);
    await expect(display.locator('table tbody tr')).toHaveCount(1);
  });
});
