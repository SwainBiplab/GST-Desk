/**
 * TDS, TCS, challans, the quarterly statements, the register of tax customers deducted, and the income
 * tax estimate, on the seeded demo book. The clock is fixed to February 2026 so the year is 2025-26 and
 * the quarter is Q4, whatever day the suite runs.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

async function newSupplier(page: Page) {
  await page.getByTestId('new-party').click();
  await expect(page.getByTestId('party-drawer')).toBeVisible();
  await page.getByTestId('party-name').fill('Sharma Contractors');
  await page.getByTestId('party-state').click();
  await page.getByRole('option', { name: /\(27\)/ }).click();
  await page.getByTestId('party-pan').fill('AAAPS1234C');
  await page.getByTestId('party-tds-section').click();
  await page.getByRole('option', { name: /194C/ }).click();
  await page.getByTestId('party-tds-category').click();
  await page.getByRole('option', { name: 'Individual or HUF' }).click();
  await page.getByTestId('party-save').click();
  await expect(page.getByTestId('party-360')).toBeVisible();
}

async function open(page: Page) {
  await page.clock.setFixedTime(new Date('2026-02-10T10:00:00+05:30'));
  await openSeeded(page, '/books/parties');
  await newSupplier(page);
  await page.goto('/books/directtax');
  await expect(page.getByTestId('direct-tax-page')).toBeVisible({ timeout: 30_000 });
}

test('says plainly that the rules are not verified', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-02-10T10:00:00+05:30'));
  await openSeeded(page, '/books/directtax');
  await expect(page.getByRole('note').first()).toContainText('chartered accountant');
  await expect(page.getByTestId('tax-fy')).toContainText('2025-26');
});

test('the party form keeps the PAN, the section and the payee kind', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-02-10T10:00:00+05:30'));
  await openSeeded(page, '/books/parties');
  await newSupplier(page);
  await page.getByTestId('p360-edit').click();
  await expect(page.getByTestId('party-pan')).toHaveValue('AAAPS1234C');
  await expect(page.getByTestId('party-tds-section')).toContainText('194C');
  await expect(page.getByTestId('party-tds-category')).toContainText('Individual or HUF');
});

test('a bad PAN is refused in plain words', async ({ page }) => {
  await openSeeded(page, '/books/parties');
  await page.getByTestId('new-party').click();
  await page.getByTestId('party-name').fill('Bad Pan Co');
  await page.getByTestId('party-state').click();
  await page.getByRole('option', { name: /\(27\)/ }).click();
  await page.getByTestId('party-pan').fill('12345');
  await page.getByTestId('party-save').click();
  await expect(page.getByText('A PAN is 5 letters, 4 digits and a letter')).toBeVisible();
});

test('works out a deduction by hand, records it, matches a challan and writes the 26Q', async ({
  page,
}) => {
  await open(page);

  // by hand: INR 40,000 to an individual contractor is over the INR 30,000 single-payment limit, 1%
  await page.getByTestId('tds-manual').getByRole('combobox', { name: 'Party' }).click();
  await page.getByRole('option', { name: 'Sharma Contractors' }).click();
  await page.getByTestId('tds-manual-amount').fill('40000');
  await page.getByTestId('tds-manual-work').click();
  await expect(page.getByTestId('tds-manual-result')).toContainText('₹400.00');
  await page.getByTestId('tds-manual-result').getByRole('button', { name: 'Record this' }).click();
  await expect(page.getByTestId('tds-recorded')).toContainText('Sharma Contractors');
  await expect(page.getByTestId('tds-recorded')).toContainText('Not matched to a challan');

  // under the limit nothing applies, and it says why
  await page.getByTestId('tds-manual-amount').fill('10000');
  await page.getByTestId('tds-manual-work').click();
  await expect(page.getByTestId('tds-manual-result')).toContainText('No tax applies');

  // a challan: a bad BSR code is refused, a good one saves
  await page.getByRole('tab', { name: 'Challans' }).click();
  await page.getByTestId('challan-bsr').fill('12');
  await page.getByTestId('challan-serial').fill('00431');
  await page.getByTestId('challan-date').fill('2026-02-12');
  await page.getByTestId('challan-tax').fill('400');
  await page.getByTestId('challan-save').click();
  await expect(page.getByText('The BSR code is 7 digits.')).toBeVisible();
  await page.getByTestId('challan-bsr').fill('0510308');
  await page.getByTestId('challan-save').click();
  await expect(page.getByTestId('challan-table')).toContainText('00431');

  // match the deduction to it
  await page.getByTestId('challan-match').click();
  await page.getByTestId('match-panel').getByRole('checkbox').first().check();
  await page.getByTestId('match-save').click();
  await expect(page.getByTestId('challan-table')).toContainText('1 matched');

  // the statement: one row, tax and deposit agree, nothing to fix
  await page.getByRole('tab', { name: 'Statements' }).click();
  await expect(page.getByTestId('return-rows')).toContainText('Sharma Contractors');
  await expect(page.getByTestId('return-rows')).toContainText('AAAPS1234C');
  await expect(page.getByTestId('return-totals')).toContainText('₹400.00');
  await expect(page.getByTestId('return-problems')).toContainText('Nothing to fix.');

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('return-csv').click(),
  ]);
  expect(csv.suggestedFilename()).toBe('26Q_2025-26_Q4.csv');
  const lines = readFileSync((await csv.path())!, 'utf8')
    .replace(new RegExp('^\\uFEFF'), '')
    .trimEnd()
    .split('\r\n');
  expect(lines[0]).toContain('PAN of Deductee');
  expect(lines[1]).toBe(
    '1,02,AAAPS1234C,Sharma Contractors,94C,2026-02-10,40000.00,1.00,400.00,2026-02-12,0510308,00431,,',
  );

  const [xlsx] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('return-xlsx').click(),
  ]);
  expect(xlsx.suggestedFilename()).toBe('26Q_2025-26_Q4.xlsx');
});

test('an unmatched deduction is flagged on the statement', async ({ page }) => {
  await open(page);
  await page.getByTestId('tds-manual').getByRole('combobox', { name: 'Party' }).click();
  await page.getByRole('option', { name: 'Sharma Contractors' }).click();
  await page.getByTestId('tds-manual-amount').fill('40000');
  await page.getByTestId('tds-manual-work').click();
  await page.getByTestId('tds-manual-result').getByRole('button', { name: 'Record this' }).click();
  await page.getByRole('tab', { name: 'Statements' }).click();
  await expect(page.getByTestId('return-problems')).toContainText('not matched to a challan');
});

test('collects TCS by hand on a party sold scrap to', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'TCS' }).click();
  await page.getByTestId('tcs-manual').getByRole('combobox', { name: 'Party' }).click();
  await page.getByRole('option', { name: 'Sharma Contractors' }).click();
  await page.getByTestId('tcs-manual').getByRole('combobox', { name: 'Collection on' }).click();
  await page.getByRole('option', { name: 'Scrap', exact: true }).click();
  await page.getByTestId('tcs-manual-amount').fill('100000');
  await page.getByTestId('tcs-manual-work').click();
  // 1% of INR 1,00,000
  await expect(page.getByTestId('tcs-manual-result')).toContainText('₹1,000.00');
});

test('tracks tax a customer deducted until the certificate arrives', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'TDS receivable' }).click();
  await page.getByTestId('receivable-add').getByRole('combobox', { name: 'Customer' }).click();
  await page.getByRole('option', { name: 'Sharma Contractors' }).click();
  await page.getByTestId('receivable-gross').fill('100000');
  await page.getByTestId('receivable-tds').fill('2000');
  await page.getByTestId('receivable-save').click();
  await expect(page.getByTestId('receivable-table')).toContainText('Certificate awaited');
  await expect(page.getByTestId('receivable-summary')).toContainText('₹2,000.00');

  // a certificate number is needed first
  await page.getByTestId('receivable-received').click();
  await expect(page.getByText('Enter the certificate number')).toBeVisible();
  await page.getByTestId('receivable-certno').fill('ABCD1234');
  await page.getByTestId('receivable-received').click();
  await expect(page.getByTestId('receivable-table')).toContainText('Certificate received');
  await expect(page.getByTestId('receivable-table')).toContainText('ABCD1234');
});

test('estimates income tax for both regimes, with the new one cheaper on INR 14 lakh', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('tab', { name: 'Income tax' }).click();
  await expect(page.getByTestId('income-form')).toContainText(
    'This is an estimate. Confirm with your CA.',
  );
  await page.getByTestId('income-profit').fill('1400000');
  await expect(page.getByTestId('total-new')).toContainText('₹93,600.00');
  await expect(page.getByTestId('total-old')).toContainText('₹2,41,800.00');
  await expect(page.getByTestId('income-better')).toContainText('New regime');

  // deductions change the old regime only
  await page.getByTestId('income-80c').fill('200000');
  await expect(page.getByTestId('deductionsAllowed-old')).toContainText('₹1,50,000.00');
  await expect(page.getByTestId('deductionsAllowed-new')).toContainText('₹0.00');

  // with nothing paid in advance, the schedule shows the dates and interest is charged
  await expect(page.getByTestId('advance-schedule')).toContainText('2025-06-15');
  await expect(page.getByTestId('payable-new')).not.toContainText('₹0.00');
});

test('keeps what was typed for the year after a reload', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Income tax' }).click();
  await page.getByTestId('income-profit').fill('900000');
  await expect(page.getByTestId('total-new')).toBeVisible();
  await page.waitForTimeout(1500); // the form is saved a moment after the last change
  await page.reload();
  await page.getByRole('tab', { name: 'Income tax' }).click();
  await expect(page.getByTestId('income-profit')).toHaveValue(/9,00,000/);
});

test('the page is reachable from the navigation and the command bar', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-02-10T10:00:00+05:30'));
  await openSeeded(page, '/books/dashboard');
  await page.getByRole('link', { name: 'TDS and income tax' }).click();
  await expect(page.getByTestId('direct-tax-page')).toBeVisible();
});
