/**
 * The Filing Desk on the seeded demo book. The clock is fixed to early April 2026 so the periods shown
 * (April 2025 to April 2026) include the months the seed fills, whatever day the suite runs.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

const row = (page: Page, label: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: label }) });

async function openMarch(page: Page) {
  await page.clock.setFixedTime(new Date('2026-04-05T10:00:00+05:30'));
  await openSeeded(page, '/books/gst');
  await expect(page.getByRole('heading', { name: 'GST returns' })).toBeVisible();
  const march = row(page, 'Mar 2026');
  await march.getByRole('button', { name: 'Review' }).click();
  await expect(march.getByRole('tab', { name: 'GSTR-1' })).toBeVisible({ timeout: 30_000 });
  return march;
}

test('the Filing Desk says plainly that the file layout is not verified', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-04-05T10:00:00+05:30'));
  await openSeeded(page, '/books/gst');
  await expect(page.getByRole('note').first()).toContainText('offline tool');
});

test('review a seeded month, export GSTR-1, mark it filed and reopen it', async ({ page }) => {
  const march = await openMarch(page);

  // the GSTR-1 tables have rows for the seeded month
  const b2b = march.getByRole('row', { name: /Invoices to registered buyers/ });
  await expect(b2b).toBeVisible();
  expect(Number(await b2b.getByRole('cell').nth(1).innerText())).toBeGreaterThan(0);

  // export the JSON file
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    march.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^GSTR1_[A-Z0-9]+_032026\.json$/);
  const file = JSON.parse(readFileSync((await download.path())!, 'utf8')) as Record<
    string,
    unknown
  >;
  expect(file['fp']).toBe('032026');
  expect(Array.isArray(file['b2b'])).toBe(true);

  // the card now says exported
  await expect(march.getByText('Exported').first()).toBeVisible();

  // CSVs come as one ZIP
  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    march.getByRole('button', { name: 'Export CSV files' }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/_032026_csv\.zip$/);

  // mark filed: a bad ARN is refused in plain words, a good one is kept
  await march.getByRole('button', { name: 'Mark as filed' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Acknowledgement number (ARN)').fill('x');
  await dialog.getByRole('button', { name: 'Mark as filed' }).click();
  await expect(page.getByText(/acknowledgement reference number/)).toBeVisible();
  await dialog.getByLabel('Acknowledgement number (ARN)').fill('aa270326123456z');
  await dialog.getByRole('button', { name: 'Mark as filed' }).click();
  await expect(march.getByText(/ARN AA270326123456Z/)).toBeVisible();
  await expect(march.getByText('Filed', { exact: true }).first()).toBeVisible();

  // reopen needs a reason
  await march.getByRole('button', { name: 'Reopen' }).click();
  const reopen = page.getByRole('alertdialog');
  await reopen.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText(/Say why/)).toBeVisible();
  await reopen.getByLabel('Why is this being reopened?').fill('wrong month');
  await reopen.getByRole('button', { name: 'Reopen' }).click();
  await expect(march.getByText(/ARN AA270326123456Z/)).toHaveCount(0);
});

test('GSTR-3B shows the figures, and an ITC change is kept with its reason', async ({ page }) => {
  const march = await openMarch(page);
  await march.getByRole('tab', { name: 'GSTR-3B' }).click();
  await expect(
    march.getByRole('row', { name: /3\.1\(a\) Outward taxable supplies/ }),
  ).toBeVisible();
  await expect(march.getByText(/The cash figure is an estimate/)).toBeVisible();

  const reason = march.getByLabel('Why', { exact: true });
  await march.getByLabel('CGST', { exact: true }).fill('50');
  await march.getByLabel('SGST', { exact: true }).fill('50');
  await march.getByRole('button', { name: 'Add change' }).click();
  await expect(
    page.getByText('Enter amounts in rupees').or(page.getByText(/Say why/)),
  ).toBeVisible();

  await reason.fill('blocked credit on a gift');
  await march.getByRole('button', { name: 'Add change' }).click();
  await expect(march.getByText('blocked credit on a gift')).toBeVisible();

  await march.getByRole('button', { name: 'Remove' }).click();
  await expect(march.getByText('blocked credit on a gift')).toHaveCount(0);
});

test('the checks tab lists what to look at, and the command bar finds the page', async ({
  page,
}) => {
  const march = await openMarch(page);
  await march.getByRole('tab', { name: /Checks/ }).click();
  await expect(march.getByRole('tabpanel')).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.getByTestId('command-input').fill('gstr');
  await expect(page.getByRole('option', { name: /GST returns/ })).toBeVisible();
});
