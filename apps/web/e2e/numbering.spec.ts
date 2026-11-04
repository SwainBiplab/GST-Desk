import { expect, test, type Page } from '@playwright/test';

import { addLine, openEditor, pickParty, uiTotal } from './documents.helpers';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

const today = () => new Date().toISOString().slice(0, 10);

/** A saved and issued invoice for the first demo party, one line. */
async function issueInvoice(page: Page, sku = 'SKU-0001') {
  await openEditor(page, 'tax_invoice');
  await pickParty(page);
  await addLine(page, 0, sku, '2');
  await page.getByTestId('doc-issue').click();
  await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
  return (await page.getByTestId('doc-issued-number').innerText()).trim();
}

const openSettings = async (page: Page, tab: string) => {
  await page.getByTestId('nav-settings').click();
  await page.getByTestId(`tab-${tab}`).click();
};

test.describe('number series', () => {
  test('configure a series, see the problems and the preview, issue from it', async ({ page }) => {
    await openSeeded(page, '/books/settings?tab=numbering');
    await expect(page.getByTestId('numbering-tab')).toBeVisible();
    await expect(
      page.locator('[data-testid="series-row"][data-type="tax_invoice"]').first(),
    ).toBeVisible();

    await page.getByTestId('series-add').click();
    await page.getByTestId('series-name-input').fill('Wholesale');
    await page.getByTestId('series-prefix').fill('WS#');
    // a character GST does not allow: the problem is shown and saving is off
    await expect(page.getByTestId('series-problems')).toContainText('letters, digits');
    await expect(page.getByTestId('series-save')).toBeDisabled();

    await page.getByTestId('series-prefix').fill('WS/{FY}/');
    await page.getByTestId('series-padding').fill('3');
    await expect(page.getByTestId('series-problems')).toHaveCount(0);
    await expect(page.getByTestId('series-preview')).toHaveText(/^WS\/\d{2}-\d{2}\/001$/);

    // too wide for 16 characters
    await page.getByTestId('series-padding').fill('9');
    await expect(page.getByTestId('series-problems')).toContainText('16 characters');
    await page.getByTestId('series-padding').fill('3');

    // the same prefix as the default series is refused: numbers could repeat
    await page.getByTestId('series-prefix').fill('INV/{FY}/');
    await expect(page.getByTestId('series-problems')).toContainText('already uses this prefix');
    await page.getByTestId('series-prefix').fill('WS/{FY}/');

    await page.getByTestId('series-save').click();
    await expect(page.locator('[data-testid="series-row"][data-name="Wholesale"]')).toBeVisible();

    // issue from it
    await page.getByTestId('nav-sell').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await pickParty(page);
    await addLine(page, 0, 'SKU-0001', '1');
    await page.getByTestId('doc-series').click();
    await page.getByRole('option', { name: 'Wholesale' }).click();
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    await expect(page.getByTestId('doc-issued-number')).toHaveText(/^WS\/\d{2}-\d{2}\/001$/);
  });

  test('renaming a series changes the next number only', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    const first = await issueInvoice(page);
    expect(first).toMatch(/^INV\/\d{2}-\d{2}\/\d{4}$/);

    await openSettings(page, 'numbering');
    await page
      .locator('[data-testid="series-row"][data-type="tax_invoice"][data-name="Default"]')
      .getByTestId('series-edit')
      .click();
    await page.getByTestId('series-prefix').fill('TI/{FY}/');
    await page.getByTestId('series-save').click();
    await expect(page.getByTestId('series-dialog')).toBeHidden();

    await page.getByTestId('nav-sell').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await pickParty(page);
    await addLine(page, 0, 'SKU-0002', '1');
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    const second = (await page.getByTestId('doc-issued-number').innerText()).trim();
    expect(second).toMatch(/^TI\/\d{2}-\d{2}\/\d{4}$/);
    // numbers carry on from the same counter
    expect(Number(second.split('/').pop())).toBe(Number(first.split('/').pop()) + 1);

    // the first document keeps its number
    await page.getByTestId('nav-documents').click();
    await expect(page.getByText(first, { exact: true }).first()).toBeVisible();
  });
});

test.describe('cancellation', () => {
  test('cancel with a reason: number kept, stamped, no longer editable, history shows why', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const number = await issueInvoice(page);

    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-cancel').click();
    await expect(page.getByTestId('cancel-dialog')).toBeVisible();
    await expect(page.getByTestId('cancel-credit-hint')).toContainText('credit note');

    // a reason is required
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('cancel-reason-error')).toBeVisible();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued');

    await page.getByTestId('cancel-reason').fill('Entered for the wrong customer');
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Cancelled', { timeout: 15_000 });
    await expect(page.getByTestId('doc-issued-number')).toHaveText(number);
    await expect(page.getByTestId('doc-cancelled-banner')).toContainText(
      'Entered for the wrong customer',
    );
    await expect(page.getByTestId('preview-cancelled')).toBeVisible();
    await expect(page.getByTestId('doc-edit')).toHaveCount(0);
    await page.getByTestId('doc-more').click();
    await expect(page.getByTestId('doc-cancel')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // the History tab tells the story
    await page.getByTestId('tab-history').click();
    await expect(page.getByTestId('history-list')).toBeVisible();
    await expect(page.getByTestId('history-list')).toContainText('Entered for the wrong customer');
    await page
      .getByTestId('history-entry')
      .filter({ hasText: 'Entered for the wrong customer' })
      .getByTestId('history-toggle')
      .click();
    await expect(page.getByTestId('audit-diff').first()).toContainText('cancelled');
  });

  test('"Use a credit note instead" opens a credit note draft for the document', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await issueInvoice(page);
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-cancel').click();
    await page.getByTestId('cancel-use-credit-note').click();
    await expect(page.getByTestId('cancel-dialog')).toBeHidden();
    // the convert dialog for a credit note
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('editing after issue', () => {
  test('a financial change makes a new revision; a notes-only change does not', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await issueInvoice(page);
    const before = await uiTotal(page);

    await page.getByTestId('doc-edit').click();
    await expect(page.getByTestId('doc-revising-banner')).toBeVisible();
    await page.getByTestId('doc-inv-discount-mode').click();
    await page.getByRole('option', { name: 'Percent' }).click();
    await page.getByTestId('doc-inv-discount').fill('10');
    await expect.poll(() => uiTotal(page)).toBeLessThan(before);
    const after = await uiTotal(page);

    await page.getByTestId('doc-revise-save').click();
    await expect(page.getByTestId('doc-revision')).toHaveText('Revision 2', { timeout: 15_000 });
    await expect(page.getByTestId('doc-status')).toHaveText('Issued');
    expect(await uiTotal(page)).toBe(after);
    await expect(page.getByTestId('doc-revising-banner')).toHaveCount(0);

    // notes only
    await page.getByTestId('doc-edit').click();
    await page.getByTestId('doc-notes').click();
    await page.keyboard.type('Delivered to gate 2');
    await page.getByTestId('doc-revise-save').click();
    await expect(page.getByText('Nothing financial changed')).toBeVisible();
    await expect(page.getByTestId('doc-revision')).toHaveText('Revision 2');

    // history keeps before and after
    await page.getByTestId('tab-history').click();
    await expect(page.getByTestId('history-entry').first()).toBeVisible();
    expect(await page.getByTestId('history-entry').count()).toBeGreaterThan(2);
  });

  test('discarding an edit puts the document back as it was', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await issueInvoice(page);
    const before = await uiTotal(page);
    await page.getByTestId('doc-edit').click();
    await page.getByTestId('doc-inv-discount-mode').click();
    await page.getByRole('option', { name: 'Percent' }).click();
    await page.getByTestId('doc-inv-discount').fill('50');
    await expect.poll(() => uiTotal(page)).toBeLessThan(before);
    await page.getByTestId('doc-revise-discard').click();
    await expect(page.getByTestId('doc-revising-banner')).toHaveCount(0);
    await expect.poll(() => uiTotal(page)).toBe(before);
  });
});

test.describe('period lock and the audit trail', () => {
  test('a locked date needs an owner reason, which is kept in history and the audit viewer', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=numbering');
    await page.getByTestId('lock-until').fill(today());
    await page.getByTestId('lock-set').click();
    await expect(page.getByTestId('lock-state')).toContainText(`Locked up to ${today()}`);

    await page.getByTestId('nav-sell').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await pickParty(page);
    await addLine(page, 0, 'SKU-0001', '1');
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('lock-override')).toBeVisible();

    // no reason, no go
    await page.getByTestId('lock-confirm').click();
    await expect(page.getByRole('alert').filter({ hasText: 'reason is required' })).toBeVisible();

    await page.getByTestId('lock-reason').fill('Customer asked for today’s date');
    await page.getByTestId('lock-confirm').click();
    await expect(page.getByTestId('doc-status')).toHaveText('Issued', { timeout: 15_000 });
    const number = (await page.getByTestId('doc-issued-number').innerText()).trim();

    // the override is on the document's history
    await page.getByTestId('tab-history').click();
    await expect(
      page.locator('[data-testid="history-entry"][data-table="period_lock"]'),
    ).toContainText('Customer asked for today');

    // and in the audit viewer, found by document number
    await openSettings(page, 'audit');
    await page.getByTestId('audit-document').fill(number);
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    await expect(page.locator('[data-testid="audit-row"][data-table="period_lock"]')).toHaveCount(
      1,
    );
    await expect(
      page.locator('[data-testid="audit-row"][data-table="documents"]').first(),
    ).toBeVisible();

    // unlocking needs a reason
    await openSettings(page, 'numbering');
    await page.getByTestId('lock-clear').click();
    await expect(page.getByTestId('lock-state')).toContainText('Locked up to');
    await page.getByTestId('lock-reason-input').fill('Year-end review finished');
    await page.getByTestId('lock-clear').click();
    await expect(page.getByTestId('lock-state')).toHaveText('Not locked');
  });

  test('the audit viewer filters by record type and exports a CSV', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await issueInvoice(page);
    await openSettings(page, 'audit');
    await expect(page.getByTestId('audit-row').first()).toBeVisible();

    await page.getByTestId('audit-table').click();
    await page.getByRole('option', { name: 'documents' }).click();
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    const tables = await page
      .getByTestId('audit-row')
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-table')))]);
    expect(tables).toEqual(['documents']);

    await page.getByTestId('audit-toggle').first().click();
    await expect(page.getByTestId('audit-diff').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByTestId('audit-export').click();
    expect((await download).suggestedFilename()).toBe('audit-trail.csv');

    // a filter with nothing in it says so
    await page.getByTestId('audit-actor').fill('nobody-at-all');
    await expect(page.getByTestId('audit-empty')).toBeVisible();
  });
});
