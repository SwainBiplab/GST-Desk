import { expect, test } from './fixtures';
import { openSeeded, png } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

/**
 * Prompt 36. In demo mode the OCR engine is a fixture that returns a sample bill for any image, so the
 * whole path (file, review card, edit, accept, purchase draft) runs without a model on the machine.
 * Real OCR and the local model are a human check (docs/runbooks/offline-ai.md).
 */
test.describe('scan a bill into a purchase draft', () => {
  test('a scanned image becomes a review card with the fields and their confidence, and accepting opens a purchase draft', async ({
    page,
  }) => {
    await openSeeded(page, '/books/inbox?intent=scan');
    await expect(page.getByTestId('scan-panel')).toBeVisible();
    await page
      .getByTestId('scan-input')
      .setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: png(640, 480) });
    // the card lands in the inbox and is selected
    await expect(page.getByTestId('inbox-kind')).toContainText('Scanned purchase bill', {
      timeout: 60_000,
    });
    const detail = page.getByTestId('extraction-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('scan-view')).toBeVisible();
    await expect(detail.getByTestId('field-supplierName')).toContainText('SHREE GANESH TRADERS');
    await expect(detail.getByTestId('field-invoiceNumber')).toContainText('SGT/2026/0412');
    await expect(detail.getByTestId('field-date')).toContainText('2026-06-15');
    await expect(detail.getByTestId('field-totalPaise')).toContainText('16,343');
    await expect(detail.getByTestId('extraction-lines').locator('tbody tr')).toHaveCount(2);
    await expect(detail.getByTestId('extraction-checks')).toContainText('Totals add up');
    await expect(detail.getByTestId('field-confidence').first()).toBeVisible();

    // the same file again is not raised twice
    await page
      .getByTestId('scan-input')
      .setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: png(640, 480) });
    await expect(page.getByTestId('scan-error')).toContainText('already scanned');

    // fix a line's rate before accepting
    await page.getByTestId('detail-edit').click();
    const dialog = page.getByTestId('extraction-edit');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('edit-invoice-number')).toHaveValue('SGT/2026/0412');
    await dialog.getByTestId('edit-lines').getByLabel('Rate').nth(1).fill('60.00');
    await dialog.getByTestId('extraction-confirm').click();
    await expect(page.getByTestId('inbox-count-done')).toHaveText('1');

    // the draft exists: open it from the done list
    await page.getByTestId('inbox-tab-done').click();
    await page.getByTestId('inbox-kind').click();
    await page.getByRole('option', { name: 'Scanned purchase bill' }).click();
    await page.getByTestId('detail-open').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await expect(page.getByTestId('doc-party')).toHaveValue(/Shree Ganesh|SHREE GANESH/i);
    await page.getByRole('tab', { name: 'Supplier bill' }).click();
    await expect(page.getByTestId('attachment-view')).toBeVisible();
    await expect(page.getByTestId('doc-totals')).toContainText('16,');
  });

  test('the panel says where the demo text comes from, and the settings page says nothing is downloaded', async ({
    page,
  }) => {
    await openSeeded(page, '/books/inbox');
    await page.getByTestId('inbox-scan').click();
    await expect(page.getByTestId('scan-panel')).toContainText('Demo');
    await page.goto('/books/settings?tab=ai');
    await expect(page.getByTestId('ai-tab')).toBeVisible();
    await expect(page.getByTestId('ai-enable-cta')).toBeVisible();
    await expect(page.getByTestId('ai-tier1-off')).toHaveAttribute('aria-checked', 'true');
    // the browser build offers no built-in sidecar
    await expect(page.getByTestId('ai-tier1-builtin')).toBeDisabled();
    await expect(page.getByTestId('ai-hardware')).toBeVisible();
  });
});

test.describe('speech to a draft', () => {
  test('a typed sentence becomes a confirmed draft with the party and the lines filled in', async ({
    page,
  }) => {
    await openSeeded(page, '/books/documents/new?type=tax_invoice');
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-input')).toBeFocused();
    await page.getByTestId('voice-type').click();
    await page
      .getByTestId('voice-text')
      .fill('3 kg sugar at 42 and 2 piece pen 10 rupees for Sharma');
    await page.getByTestId('voice-parse').click();
    const dialog = page.getByTestId('voice-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('voice-party')).toHaveText('Sharma');
    await expect(dialog.getByTestId('voice-lines').locator('li')).toHaveCount(2);
    await dialog.getByTestId('voice-create').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    // two lines from the words, quantities carried over
    await expect(page.getByTestId('line-grid')).toBeVisible();
    await expect(page.getByTestId('line-grid')).toContainText('sugar');
    await expect(page.getByTestId('line-grid')).toContainText('pen');
  });

  test('the shop screen has the same button', async ({ page }) => {
    await openSeeded(page, '/shop/sell');
    await expect(page.getByTestId('doc-header').getByTestId('voice-button')).toBeVisible();
  });
});

test.describe('settings, AI', () => {
  test('lists the signed model list with sizes and licences, and refuses to download before the licence is accepted', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=ai');
    await expect(page.getByTestId('ai-models')).toBeVisible();
    const rows = page.getByTestId('ai-model');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    await expect(rows.first()).toContainText(/MB|GB/);
    await expect(rows.first()).toContainText(/Apache|MIT|Qwen/);
    await rows.first().getByTestId('ai-model-download').click();
    await expect(page.getByTestId('ai-licence')).toBeVisible();
    await expect(page.getByTestId('ai-licence')).toContainText('licence');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(rows.first()).toHaveAttribute('data-status', 'none');
    await expect(page.getByTestId('ai-disk')).toContainText('0 MB');
  });
});
