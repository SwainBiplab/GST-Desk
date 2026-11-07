import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

/**
 * Prompt 50. The ledger page over the seeded business: a journal voucher that must balance before it posts, the
 * trial balance that ties and drills down to a statement, the profit and loss export, and the year-end audit.
 * The arithmetic and the repositories are tested in `packages/domain` and `packages/db` on both dialects.
 */
test.describe('the ledger', () => {
  test('a journal voucher balances before it posts, and shows in the journal and the statement', async ({
    page,
  }) => {
    await openSeeded(page, '/books/ledger?tab=journal');
    await expect(page.getByTestId('ledger-journal')).toBeVisible();
    await page.getByTestId('journal-new').click();
    const dialog = page.getByTestId('voucher-dialog');
    await expect(dialog).toBeVisible();
    // the journal lists the dates above, which open on the current financial year
    await dialog.getByTestId('voucher-date').fill('2026-06-01');
    await dialog.getByTestId('voucher-narration').fill('Office rent for June');
    await dialog.getByTestId('voucher-account-0').click();
    await page.getByRole('option', { name: /5100 · Expenses/ }).click();
    await dialog.getByTestId('voucher-debit-0').fill('1000');
    await dialog.getByTestId('voucher-account-1').click();
    await page.getByRole('option', { name: /1100 · Bank/ }).click();
    await dialog.getByTestId('voucher-credit-1').fill('900');
    await expect(dialog.getByTestId('voucher-balance')).toContainText('Off by');
    await expect(dialog.getByTestId('voucher-post')).toBeDisabled();
    await dialog.getByTestId('voucher-credit-1').fill('1000');
    await expect(dialog.getByTestId('voucher-balance')).toContainText('Balanced');
    await dialog.getByTestId('voucher-post').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('voucher-row').first()).toContainText('JV/26-27/0001');
    await expect(page.getByTestId('voucher-row').first()).toContainText('Office rent for June');

    // the statement of the expense account carries it, with the running balance
    await page.getByTestId('ledger-tab-statement').click();
    await page.getByTestId('statement-account').click();
    await page.getByRole('option', { name: /5100 · Expenses/ }).click();
    await expect(page.getByTestId('statement-title')).toContainText('5100');
    await expect(
      page.getByTestId('statement-row').filter({ hasText: 'JV/26-27/0001' }),
    ).toHaveCount(1);
    await expect(page.getByTestId('statement-closing')).toBeVisible();
  });

  test('the trial balance ties and drills down; the P&L exports; the audit says the books tie', async ({
    page,
  }) => {
    await openSeeded(page, '/books/ledger?tab=tb');
    await expect(page.getByTestId('ledger-tb')).toBeVisible();
    // the seed's books run from April 2024; read FY 2024-25
    await page.getByTestId('ledger-from').fill('2024-04-01');
    await page.getByTestId('ledger-to').fill('2025-03-31');
    const totals = page.getByTestId('tb-totals');
    await expect(totals).toBeVisible({ timeout: 30_000 });
    const cells = await totals.locator('td').allTextContents();
    // closing debit equals closing credit
    expect(cells.at(-2)).toBe(cells.at(-1));
    expect(await page.getByTestId('tb-row').count()).toBeGreaterThan(5);
    await page.getByTestId('tb-row').filter({ hasText: 'Sales' }).getByTestId('tb-drill').click();
    await expect(page.getByTestId('statement-title')).toContainText('4000');
    await expect(page.getByTestId('statement-row').first()).toBeVisible();

    await page.getByTestId('ledger-tab-pl').click();
    await expect(page.getByTestId('pl-net')).toContainText('Net profit');
    const download = page.waitForEvent('download');
    await page.getByTestId('pl-export-csv').click();
    expect((await download).suggestedFilename()).toMatch(/Profit_and_loss_.*\.csv$/);
    await page.getByTestId('pl-compare').click();
    await expect(page.getByTestId('pl-income').locator('th')).toHaveCount(3);

    await page.getByTestId('ledger-tab-bs').click();
    await expect(page.getByTestId('bs-difference')).toHaveAttribute('data-ties', 'yes');

    await page.getByTestId('ledger-tab-yearend').click();
    await expect(page.getByTestId('year-row').first()).toBeVisible();
    await page.getByTestId('audit-verify').click();
    await expect(page.getByTestId('audit-control')).toHaveAttribute('data-ties', 'yes', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('audit-repair')).toHaveCount(0);
  });
});
