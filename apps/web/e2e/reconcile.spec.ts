/**
 * Pre-filing checks and GSTR-2B reconciliation on the seeded demo book. The clock is fixed to early
 * April 2026 so the periods shown (May 2025 to April 2026) are the same whatever day the suite runs.
 *
 * The demo book is nearly clean: November 2025 has exactly one problem (a credit note with no linked
 * invoice), which is what the acknowledge test uses. The reconciliation test does not depend on the
 * seed's purchase bills: it imports a 2B for a supplier the book has never seen, creates the bill from
 * the line, and watches it become a match.
 */
import AxeBuilder from '@axe-core/playwright';

import { expect, test, type Page } from './fixtures';
import { acknowledgeAll, gstin, openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

const OWN = '27AABCD1234E1Z8'; // the demo business
const SUPPLIER = gstin('29', 'AABCU9603R');

const row = (page: Page, label: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: label }) });

async function open(page: Page, label: string, tab: string | RegExp) {
  await page.clock.setFixedTime(new Date('2026-04-05T10:00:00+05:30'));
  await openSeeded(page, '/books/gst');
  const r = row(page, label);
  await r.getByRole('button', { name: 'Review' }).click();
  await expect(r.getByRole('tab', { name: tab })).toBeVisible({ timeout: 30_000 });
  await r.getByRole('tab', { name: tab }).click();
  return r;
}

const json2b = (lines: { number: string; taxable: number; igst: number }[]) =>
  JSON.stringify({
    data: {
      gstin: OWN,
      rtnprd: '032026',
      docdata: {
        b2b: [
          {
            ctin: SUPPLIER,
            trdnm: 'E2E Traders',
            inv: lines.map((l) => ({
              inum: l.number,
              dt: '10-03-2026',
              itcavl: 'Y',
              txval: l.taxable,
              igst: l.igst,
              cgst: 0,
              sgst: 0,
              cess: 0,
            })),
          },
        ],
      },
    },
  });

test('export waits for every problem to be fixed or acknowledged with a reason', async ({
  page,
}) => {
  const nov = await open(page, 'Nov 2025', /^Checks/);
  // the period shows what is wrong, and export is off. (The demo book's GST rates are random, so the
  // HSN checks have things to say; the count is whatever the checks find.)
  const issues = nov.getByTestId('issue');
  const total = await issues.count();
  expect(total).toBeGreaterThanOrEqual(2);
  await expect(nov.getByTestId('checks-summary')).toContainText(`${total} problems`);
  await nov.getByRole('tab', { name: 'GSTR-1' }).click();
  await expect(nov.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
  await expect(nov.getByRole('button', { name: 'Export CSV files' })).toBeDisabled();
  await expect(nov.getByTestId('export-blocked')).toContainText(
    `Fix or acknowledge the ${total} problems`,
  );

  // acknowledging needs a reason, and one acknowledgement counts down the problems
  await nov.getByRole('tab', { name: /^Checks/ }).click();
  await nov.getByRole('button', { name: 'Acknowledge', exact: true }).first().click();
  await nov.getByRole('button', { name: 'Save reason' }).click();
  await expect(page.getByText('Say why this problem can stand.')).toBeVisible();
  await nov
    .getByLabel('Why can this stand?')
    .fill('Checked with the supplier: the rate on the bill is the one that applies');
  await nov.getByRole('button', { name: 'Save reason' }).click();
  await expect(nov.getByText(/Acknowledged: Checked with the supplier/)).toBeVisible();
  await expect(nov.getByTestId('checks-summary')).toContainText(`${total - 1} problem`);

  // acknowledge the rest: now export is on, and works
  await acknowledgeAll(nov);
  await expect(nov.getByTestId('checks-summary')).toHaveCount(0);
  await nov.getByRole('tab', { name: 'GSTR-1' }).click();
  await expect(nov.getByRole('button', { name: 'Export JSON' })).toBeEnabled();
  await expect(nov.getByTestId('export-blocked')).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    nov.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^GSTR1_[A-Z0-9]+_112025\.json$/);

  // taking one acknowledgement back turns it off again
  await nov.getByRole('tab', { name: /^Checks/ }).click();
  await nov.getByRole('button', { name: 'Take back' }).first().click();
  await nov.getByRole('tab', { name: 'GSTR-1' }).click();
  await expect(nov.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
});

test('the matching tolerances are settings, and bad input is refused in plain words', async ({
  page,
}) => {
  const mar = await open(page, 'Mar 2026', 'GSTR-2B');
  await mar.getByText('How strict the matching is').click();
  await expect(mar.getByLabel('Days for an exact match')).toHaveValue('3');
  await expect(mar.getByLabel('Amount tolerance (percent)')).toHaveValue('0.00');

  await mar.getByLabel('Days for an exact match').fill('x');
  await mar.getByRole('button', { name: 'Save tolerances' }).click();
  await expect(
    page.getByText('Enter whole days, an amount in rupees and a percentage.'),
  ).toBeVisible();

  await mar.getByLabel('Days for an exact match').fill('5');
  await mar.getByLabel('Widest date gap (days)').fill('2');
  await mar.getByRole('button', { name: 'Save tolerances' }).click();
  await expect(page.getByText(/widest date gap cannot be smaller/)).toBeVisible();

  await mar.getByLabel('Widest date gap (days)').fill('60');
  await mar.getByRole('button', { name: 'Save tolerances' }).click();
  await expect(page.getByText('Saved. The match is worked out again.')).toBeVisible();

  // it is still there after a reload
  await page.reload();
  const again = row(page, 'Mar 2026');
  await again.getByRole('button', { name: 'Review' }).click();
  await again.getByRole('tab', { name: 'GSTR-2B' }).click();
  await again.getByText('How strict the matching is').click();
  await expect(again.getByLabel('Days for an exact match')).toHaveValue('5');
  await expect(again.getByLabel('Widest date gap (days)')).toHaveValue('60');

  // put the defaults back so the other tests start from them
  await again.getByLabel('Days for an exact match').fill('3');
  await again.getByLabel('Widest date gap (days)').fill('45');
  await again.getByRole('button', { name: 'Save tolerances' }).click();
  await expect(page.getByText('Saved. The match is worked out again.').last()).toBeVisible();
});

test('import a GSTR-2B, create a bill from a line, accept the match and apply it to GSTR-3B', async ({
  page,
}) => {
  const mar = await open(page, 'Mar 2026', 'GSTR-2B');
  await expect(mar.getByText('No GSTR-2B has been imported for this month yet.')).toBeVisible();

  const file = (lines: { number: string; taxable: number; igst: number }[]) => ({
    name: 'GSTR2B_032026.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json2b(lines)),
  });

  // a file for another GSTIN is refused in plain words
  await mar.getByTestId('recon-file').setInputFiles({
    name: 'other.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      json2b([{ number: 'X', taxable: 1, igst: 0 }]).replace(OWN, gstin('27', 'AAPFU0939F')),
    ),
  });
  await expect(page.getByText(/is for GSTIN/)).toBeVisible();

  await mar.getByTestId('recon-file').setInputFiles(
    file([
      { number: 'E2E/1', taxable: 10_000, igst: 1_800 },
      { number: 'E2E/2', taxable: 5_000, igst: 900 },
    ]),
  );
  await expect(page.getByText('Imported 2 lines for Mar 2026.')).toBeVisible();
  await expect(mar.getByText(/Last import: 2 lines/)).toBeVisible();

  // both lines are in the 2B and not in the books
  await mar.getByTestId('recon-filter').click();
  await page.getByRole('option', { name: /^In 2B, not in books/ }).click();
  const only2b = mar.locator('[data-testid="recon-row"][data-class="in_2b_not_in_books"]');
  await expect(only2b).toHaveCount(2);
  await expect(only2b.filter({ hasText: 'E2E/1' })).toHaveCount(1);
  await expect(mar.getByTestId('tile-only2b')).toContainText('2,700.00');

  // importing the same file again replaces it: still two lines
  await mar.getByTestId('recon-file').setInputFiles(
    file([
      { number: 'E2E/1', taxable: 10_000, igst: 1_800 },
      { number: 'E2E/2', taxable: 5_000, igst: 900 },
    ]),
  );
  await expect(page.getByText('Imported 2 lines for Mar 2026.').last()).toBeVisible();
  await expect(only2b).toHaveCount(2);

  // create the bill from the first line: the supplier is added and the editor opens filled in
  await only2b
    .filter({ hasText: 'E2E/1' })
    .getByRole('button', { name: 'Create purchase bill' })
    .click();
  await expect(page.getByTestId('doc-editor')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('supplier-invoice-no')).toHaveValue('E2E/1');
  await expect(page.getByTestId('supplier-invoice-date')).toHaveValue('2026-03-10');
  await expect(page.getByTestId('doc-party')).toHaveValue(/E2E Traders/);
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });

  // back on the Filing Desk the line is now matched with the bill, exactly
  await page.goto('/books/gst');
  const again = row(page, 'Mar 2026');
  await again.getByRole('button', { name: 'Review' }).click();
  await again.getByRole('tab', { name: 'GSTR-2B' }).click();
  await again.getByTestId('recon-filter').click();
  await page.getByRole('option', { name: /^Matched \(/ }).click();
  const matched = again.locator('[data-testid="recon-row"][data-class="matched"]');
  await expect(matched).toHaveCount(1);
  await expect(matched.first()).toContainText('E2E/1');

  // accept every exact match in one go
  await again.getByRole('button', { name: /Accept all exact matches \(1\)/ }).click();
  await expect(page.getByText('1 match accepted')).toBeVisible();
  await expect(matched.first()).toContainText('Accepted');
  await expect(
    again.getByRole('button', { name: /Accept all exact matches \(0\)/ }),
  ).toBeDisabled();

  // the other line has no bill: link it by hand to nothing is impossible, so ignore it, then undo
  await again.getByTestId('recon-filter').click();
  await page.getByRole('option', { name: /^In 2B, not in books/ }).click();
  const left = again.locator('[data-testid="recon-row"][data-class="in_2b_not_in_books"]');
  await expect(left).toHaveCount(1);
  await left.first().getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Ignore' }).click();
  await expect(left).toHaveCount(0);

  // the outcome goes to GSTR-3B table 4
  await again.getByRole('button', { name: 'Apply to GSTR-3B' }).click();
  await expect(
    page.getByText(/change.* made to GSTR-3B table 4|Nothing needs to change/),
  ).toBeVisible();

  // the new tab has no serious accessibility problems
  const res = await new AxeBuilder({ page }).include('[role="tabpanel"]').analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
});
