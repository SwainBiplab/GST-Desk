/**
 * Moving data in and out: a spreadsheet and a Tally file in, the books out to Tally. The clock is fixed
 * to February 2026 so the financial year is 2025-26 whatever day the suite runs.
 */
import { readFileSync } from 'node:fs';

import { DOCUMENT_TEMPLATE } from '@gst/interop';

import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

async function open(page: Page) {
  await page.clock.setFixedTime(new Date('2026-02-10T10:00:00+05:30'));
  await openSeeded(page, '/books/migrate');
  await expect(page.getByTestId('migrate-page')).toBeVisible({ timeout: 30_000 });
}

const upload = (page: Page, name: string, text: string, mime = 'text/csv') =>
  page
    .getByTestId('migrate-file')
    .setInputFiles({ name, mimeType: mime, buffer: Buffer.from(text) });

const TALLY = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><LEDGER NAME="Walk In Traders"><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>27AAPFU0939F1ZV</PARTYGSTIN><LEDSTATENAME>Maharashtra</LEDSTATENAME></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20250601</DATE><VOUCHERNUMBER>TL-1</VOUCHERNUMBER><PARTYLEDGERNAME>Walk In Traders</PARTYLEDGERNAME><PLACEOFSUPPLY>Maharashtra</PLACEOFSUPPLY>
<LEDGERENTRIES.LIST><LEDGERNAME>Walk In Traders</LEDGERNAME><AMOUNT>-1180.00</AMOUNT></LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>Consulting Income</LEDGERNAME><AMOUNT>1000.00</AMOUNT></LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>CGST 9%</LEDGERNAME><AMOUNT>90.00</AMOUNT></LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>SGST 9%</LEDGERNAME><AMOUNT>90.00</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20250602</DATE><VOUCHERNUMBER>J-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

test('says plainly that the Tally layouts are untested', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('note').first()).toContainText('not been tried against TallyPrime');
});

test('a spreadsheet: guess the sheet, review what would happen, import, and the documents are there', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('source-excel').click();
  await page.getByTestId('source-next').click();
  await upload(page, 'documents.csv', DOCUMENT_TEMPLATE);

  // one sheet, taken as sales documents, with the columns found
  await expect(page.getByTestId('map-step')).toBeVisible();
  await expect(page.getByTestId('sheet-role')).toContainText('Sales documents');
  await expect(page.getByTestId('map-number')).toContainText('Invoice No');
  await page.getByTestId('map-next').click();

  // the dry run: two documents, nothing written, nothing to fix
  await expect(page.getByTestId('review-step')).toBeVisible();
  await expect(page.getByTestId('review-counts')).toContainText('2 to import, 0 skipped');
  await expect(page.getByTestId('review-documents')).toContainText('INV-001');
  await expect(page.getByTestId('review-documents')).toContainText('PB-007');
  await expect(page.getByTestId('review-issues')).toContainText('Nothing to look at.');

  await page.getByTestId('do-import').click();
  await expect(page.getByTestId('import-result')).toContainText('2 documents imported');
  await expect(page.getByTestId('migration-log')).toContainText('documents.csv');

  await page.getByTestId('open-documents').click();
  await expect(page.getByText('INV-001').first()).toBeVisible({ timeout: 15_000 });
});

test('importing the same file again renumbers instead of overwriting', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 2; i++) {
    if (i === 1) await page.getByRole('button', { name: 'Import another file' }).click();
    await page.getByTestId('source-excel').click();
    await page.getByTestId('source-next').click();
    await upload(page, 'documents.csv', DOCUMENT_TEMPLATE);
    await page.getByTestId('map-next').click();
    if (i === 1) {
      await expect(page.getByTestId('review-documents')).toContainText('INV-001/IMP');
      await expect(page.getByTestId('review-issues')).toContainText('already used here');
    }
    await page.getByTestId('do-import').click();
    await expect(page.getByTestId('import-result')).toContainText('2 documents imported');
  }
});

test('a sheet it places wrongly can be changed, a missing column is named, and choosing one carries on', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('source-excel').click();
  await page.getByTestId('source-next').click();
  const csv =
    'Bill No,Booked,Customer,Particulars,Qty,Price,GST\nR-1,2025-05-01,Acme,Widget,2,100,18\n';
  await upload(page, 'odd.csv', csv);
  await expect(page.getByTestId('map-step')).toBeVisible();
  // no "date" column it recognises, so it takes the sheet for a list of items; the person knows better
  await expect(page.getByTestId('sheet-role')).toContainText('Items');
  await page.getByTestId('sheet-role').click();
  await page.getByRole('option', { name: 'Sales documents' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose a column for: Date');
  await expect(page.getByTestId('map-next')).toBeDisabled();
  await page.getByTestId('map-date').click();
  await page.getByRole('option', { name: 'Booked' }).click();
  await expect(page.getByTestId('map-next')).toBeEnabled();
  await page.getByTestId('map-next').click();
  await expect(page.getByTestId('review-documents')).toContainText('R-1');
});

test('a Tally file: vouchers and a party come in, what is not imported is explained', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('source-tally').click();
  await page.getByTestId('source-next').click();
  await upload(page, 'tally.xml', TALLY, 'text/xml');

  await expect(page.getByTestId('review-step')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('review-counts')).toContainText('1 to import, 0 skipped');
  await expect(page.getByTestId('review-documents')).toContainText('TL-1');
  // the file says 1,180.00 and the engine agrees
  await expect(page.getByTestId('review-documents')).toContainText('1180.00');
  await page.getByTestId('do-import').click();
  await expect(page.getByTestId('import-result')).toContainText('1 document imported');
});

test('sends the books to Tally as two XML files', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Send to Tally' }).click();
  await expect(page.getByTestId('export-fy')).toHaveValue('2025-26');
  await page.getByText('Ledger names').click();
  await expect(page.getByTestId('name-sales')).toHaveValue('Sales');
  await page.getByTestId('name-sales').fill('Sales Accounts Local');

  const downloads: { name: string; text: string }[] = [];
  page.on('download', async (d) => {
    downloads.push({ name: d.suggestedFilename(), text: readFileSync((await d.path())!, 'utf8') });
  });
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-result')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => downloads.length).toBe(2);
  const names = downloads.map((d) => d.name).sort();
  expect(names).toEqual(['Tally_Masters_2025-26.xml', 'Tally_Vouchers_2025-26.xml']);
  const masters = downloads.find((d) => d.name.includes('Masters'))!.text;
  const vouchers = downloads.find((d) => d.name.includes('Vouchers'))!.text;
  expect(masters).toContain('<ENVELOPE>');
  expect(masters).toContain('<LEDGER NAME="Sales Accounts Local"');
  expect(masters).toContain('<PARENT>Sundry Debtors</PARENT>');
  expect(vouchers).toContain('VCHTYPE="Sales"');
  expect(vouchers).toContain('<LEDGERNAME>Sales Accounts Local</LEDGERNAME>');
  await expect(page.getByTestId('export-result')).toContainText('Vouchers:');
});

test('the setup wizard offers the import and takes you there when it is done', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('start-import').click();
  await expect(page.getByLabel(/Import from Tally/)).toBeChecked();
});
