/**
 * e-Invoice and e-way bill through the practice GSP (nothing leaves the browser): generate an IRN, see
 * its QR on the document and in the preview, cancel it, and extend an e-way bill near its end. The
 * clock is fixed so the 24-hour and 8-hour windows are exact.
 */
import { addLine, pickParty } from './documents.helpers';
import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(180_000);

const DAY = '2026-04-03';
const at = (time: string, date = DAY) => new Date(`${date}T${time}+05:30`);

/** Move inside the running app without reloading it (a reload would load the demo book again). */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Turn e-invoicing on for the demo business (practice mode is the default). */
async function enableEinvoicing(page: Page) {
  await go(page, '/books/settings?tab=portal');
  await expect(page.getByTestId('portal-tab')).toBeVisible({ timeout: 30_000 });
  const sw = page.getByTestId('einv-switch');
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
}

/** Issue a tax invoice to a registered buyer and open its e-Invoice tab. */
async function issueForBuyer(page: Page) {
  await go(page, '/books/documents/new?type=tax_invoice');
  await expect(page.getByTestId('doc-editor')).toBeVisible();
  await expect(page.getByTestId('line-grid')).toBeVisible();
  await pickParty(page);
  await addLine(page, 0, 'SKU-0001', '2');
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  const number = (await page.getByTestId('doc-issued-number').innerText()).trim();
  await page.getByTestId('tab-einvoice').click();
  await expect(page.getByTestId('einvoice-panel')).toBeVisible();
  return number;
}

test('the e-Invoice step lists what the portal would refuse, then generates an IRN with a QR', async ({
  page,
}) => {
  await page.clock.setFixedTime(at('10:00:00'));
  await openSeeded(page, '/books/dashboard');
  await enableEinvoicing(page);
  const number = await issueForBuyer(page);

  await page.getByTestId('irn-check').click();
  await expect(page.getByTestId('irn-problems').or(page.getByTestId('irn-ready'))).toBeVisible();
  await page.getByTestId('irn-generate').click();

  // the queue sends it (practice portal), the IRN and the QR appear
  await expect(page.getByTestId('irn-status')).toHaveText('IRN generated', { timeout: 30_000 });
  const irn = (await page.getByTestId('irn-value').innerText()).trim();
  expect(irn).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('irn-ack-no')).toHaveText(/^\d{15}$/);
  await expect(page.getByTestId('irn-qr')).toBeVisible();

  // the document now carries the IRN: the preview shows it, and it can no longer be changed here
  await page.getByTestId('tab-preview').click();
  await expect(page.getByTestId('doc-preview')).toContainText(irn.slice(0, 16));
  await expect(page.getByTestId('doc-edit')).toBeDisabled();
  expect(number).toBeTruthy();
});

test('cancel the IRN within 24 hours: the document is cancelled with it', async ({ page }) => {
  await page.clock.setFixedTime(at('10:00:00'));
  await openSeeded(page, '/books/dashboard');
  await enableEinvoicing(page);
  await issueForBuyer(page);
  await page.getByTestId('irn-generate').click();
  await expect(page.getByTestId('irn-status')).toHaveText('IRN generated', { timeout: 30_000 });

  await page.getByTestId('irn-cancel').click();
  await expect(page.getByTestId('portal-cancel-dialog')).toBeVisible();
  await page.getByTestId('portal-cancel-remarks').fill('Entered twice by mistake');
  await page.getByTestId('portal-cancel-confirm').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Cancelled', { timeout: 30_000 });
});

test('an e-way bill: generate, change the vehicle, extend near the end', async ({ page }) => {
  await page.clock.setFixedTime(at('10:00:00'));
  await openSeeded(page, '/books/dashboard');
  await enableEinvoicing(page);
  await issueForBuyer(page);
  await page.getByTestId('irn-generate').click();
  await expect(page.getByTestId('irn-status')).toHaveText('IRN generated', { timeout: 30_000 });

  await page.getByTestId('ewb-new').click();
  await page.getByTestId('ewb-distance').fill('100');
  await page.getByTestId('ewb-vehicle-no').fill('MH12AB1234');
  await page.getByTestId('ewb-submit').click();
  await expect(page.getByTestId('ewb-no')).toBeVisible({ timeout: 30_000 });
  // 100 km is one day: valid to the end of the next day
  await expect(page.getByTestId('ewb-valid')).toContainText('04/04/2026 23:59');

  await page.getByTestId('ewb-vehicle').click();
  await page.getByTestId('ewb-vehicle-no').fill('MH14CD5678');
  await page.getByTestId('ewb-place').fill('Pune');
  await page.getByTestId('ewb-state').fill('27');
  await page.getByTestId('ewb-remarks').fill('Breakdown');
  await page.getByTestId('ewb-submit').click();
  await expect(page.getByTestId('ewb-valid')).toContainText('MH14CD5678', { timeout: 30_000 });

  // too early to extend: the button is not offered
  await expect(page.getByTestId('ewb-extend')).toHaveCount(0);

  // the next evening, four hours before it ends, it can be extended
  await page.clock.setFixedTime(at('20:00:00', '2026-04-04'));
  await page
    .getByRole('link', { name: /e-Invoices/ })
    .first()
    .click();
  await page.getByTestId('einv-tab-ewb').click();
  await expect(page.getByTestId('ewb-list-row')).toContainText('3 hours left');
  await page.goBack();
  await page.getByTestId('tab-einvoice').click();
  await page.getByTestId('ewb-extend').click();
  await page.getByTestId('ewb-remaining').fill('150');
  await page.getByTestId('ewb-place').fill('Nashik');
  await page.getByTestId('ewb-pincode').fill('422001');
  await page.getByTestId('ewb-state').fill('27');
  await page.getByTestId('ewb-remarks').fill('Transhipment delay');
  await page.getByTestId('ewb-submit').click();
  await expect(page.getByTestId('ewb-valid')).toContainText('05/04/2026 23:59', {
    timeout: 30_000,
  });
});
