import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/**
 * Prompt 41. The browser build has no sync client yet (it runs on the desktop and in Node, see the ADR);
 * these tests put the demo book into the states a synced book goes through, through demo-only hooks, and
 * check what a person sees: the pill, its sheet, and settling a conflict in the inbox.
 */
test.describe('sync status and conflicts', () => {
  test('the pill follows the book: local, offline with work waiting, synced, a conflict', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    const pill = page.getByTestId('sync-pill');
    await expect(pill).toHaveAttribute('data-state', 'local');
    await page.waitForFunction(() => !!window.__gstSync);

    await page.evaluate(() => window.__gstSync!.setMode('synced'));
    await expect(pill).toHaveAttribute('data-state', 'offline');

    await page.evaluate(() =>
      window.__gstSync!.setStatus({
        attached: true,
        connected: true,
        lastSyncedAt: Date.now(),
        pending: 3,
      }),
    );
    await expect(pill).toHaveAttribute('data-state', 'pending');
    await expect(pill).toContainText('3 changes waiting');
    await pill.click();
    await expect(page.getByTestId('sync-sheet')).toBeVisible();
    await expect(page.getByTestId('sync-sheet-queued')).toHaveText('3');
    await page.keyboard.press('Escape');

    await page.evaluate(() => window.__gstSync!.setStatus({ pending: 0 }));
    await expect(pill).toHaveAttribute('data-state', 'synced');
    await expect(pill).toContainText('Synced');

    await page.evaluate(() =>
      window.__gstSync!.setStatus({
        pending: 2,
        errors: [{ at: Date.now(), message: 'server answered 503' }],
      }),
    );
    await expect(pill).toHaveAttribute('data-state', 'error');
    await pill.click();
    await expect(page.getByTestId('sync-sheet-errors')).toContainText('503');
    await page.keyboard.press('Escape');

    await page.evaluate(() => window.__gstSync!.setStatus({ pending: 0, errors: [] }));
    await page.evaluate(() => window.__gstSync!.raiseConflict());
    await expect(pill).toHaveAttribute('data-state', 'conflict');
    await expect(pill).toContainText('1 conflict');
    await pill.click();
    await page.getByTestId('sync-open-conflicts').click();
    await expect(page.getByTestId('sync-conflict-detail')).toBeVisible();
  });

  test('a conflict shows both versions side by side, and keeping mine puts my change on the draft', async ({
    page,
  }) => {
    await openSeeded(page, '/books/inbox');
    await page.waitForFunction(() => !!window.__gstSync);
    await page.evaluate(() => window.__gstSync!.setMode('synced'));
    await page.evaluate(() => window.__gstSync!.raiseConflict());
    await page.getByTestId('inbox-kind').click();
    await page.getByRole('option', { name: 'Sync conflict' }).click();
    const detail = page.getByTestId('sync-conflict-detail');
    await expect(detail).toBeVisible();
    const fields = page.getByTestId('sync-conflict-fields');
    await expect(fields).toContainText('notes');
    await expect(fields).toContainText('Deliver before Friday (from the other counter)');
    await expect(page.getByTestId('detail-accept')).toHaveText('Keep my version');
    await expect(page.getByTestId('detail-reject')).toHaveText('Keep theirs');
    await page.getByTestId('detail-accept').click();
    await expect(page.getByTestId('inbox-count-done')).toHaveText('1');
    await page.getByTestId('inbox-tab-done').click();
    await page.getByTestId('detail-open').click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await expect(page.getByText('Deliver before Friday (from the other counter)')).toBeVisible();
  });
});
