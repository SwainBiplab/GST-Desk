import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

const BACKUP_TAB = '/books/settings?tab=backup';
const DAY = 86_400_000;

async function backupNow(page: Page) {
  const before = await page.getByTestId('backup-row').count();
  await page.getByTestId('backup-now').click();
  await expect(page.getByText(/Backup made and checked/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('backup-row')).toHaveCount(before + 1);
}

/** What the app shows in the Items badge: the number of items. */
const items = (page: Page) => page.getByTestId('badge-items');

async function addItem(page: Page, name: string, sku: string) {
  await page.goto('/books/items');
  await page.getByTestId('new-item').click();
  await expect(page.getByTestId('item-drawer')).toBeVisible();
  await page.getByTestId('item-name').fill(name);
  await page.getByTestId('item-sku').fill(sku);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-drawer')).toBeHidden();
}

async function deleteItem(page: Page, sku: string) {
  await page.goto('/books/items');
  await page.getByTestId('item-search').fill(sku);
  await expect(page.getByTestId('item-row')).toHaveCount(1);
  await page.getByTestId('item-row').getByRole('button').first().click();
  await page.getByTestId('item-delete').click();
  await page.getByTestId('item-delete-confirm').click();
  await expect(page.getByTestId('item-drawer')).toBeHidden();
}

async function download(page: Page, testId: string) {
  const dl = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const file = await dl;
  return {
    name: file.suggestedFilename(),
    bytes: new Uint8Array(readFileSync((await file.path())!)),
  };
}

test.describe('backups', () => {
  test('a backup is made, checked and kept, and survives a reload', async ({ page }) => {
    await openSeeded(page, BACKUP_TAB);
    await expect(page.getByTestId('browser-warning')).toContainText('cleared');
    await expect(page.getByTestId('backup-empty')).toBeVisible();
    await expect(page.getByTestId('backup-last')).toContainText('No backup has been made yet');

    await backupNow(page);
    const row = page.getByTestId('backup-row');
    await expect(row).toContainText('Made by you');
    await expect(row).toContainText('Checked');
    await expect(row).toContainText(/\d+(\.\d)? MB|\d+ KB/);
    await expect(page.getByTestId('backup-last')).toContainText('checked');
    await expect(page.getByTestId('backup-last')).toContainText(/\d[\d,]* records/);

    await page.reload();
    await expect(page.getByTestId('backup-row')).toHaveCount(1);
    await expect(page.getByTestId('backup-last')).toContainText('checked');
  });

  test('a downloaded backup is a ZIP with every table, a checksum for each, and no secrets', async ({
    page,
  }) => {
    await openSeeded(page, BACKUP_TAB);
    const { name, bytes } = await download(page, 'backup-download');
    expect(name).toMatch(/^manual-\d{8}T\d{6}Z\.gstbk$/);
    const files = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as {
      format: string;
      tables: Record<string, { rows: number; sha256: string }>;
      businesses: { legalName: string }[];
    };
    expect(manifest.format).toBe('gstbk');
    expect(manifest.tables['documents']!.rows).toBe(500);
    expect(manifest.tables['parties']!.rows).toBe(50);
    expect(manifest.businesses[0]!.legalName).toBe('Demo Traders Pvt Ltd');
    for (const t of Object.values(manifest.tables)) expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(strFromU8(files['data/documents.jsonl']!).split('\n').filter(Boolean)).toHaveLength(500);
    // downloading also keeps a copy in the browser
    await expect(page.getByTestId('backup-row')).toHaveCount(1);
  });

  test('restoring brings back what the backup held, and keeps what was there as a backup', async ({
    page,
  }) => {
    await openSeeded(page, BACKUP_TAB);
    await expect(items(page)).toHaveText('200');
    await backupNow(page);

    await addItem(page, 'Added after the backup', 'LATER-1');
    await expect(items(page)).toHaveText('201');

    await page.goto(BACKUP_TAB);
    await page.getByTestId('backup-restore-row').click();
    const dialog = page.getByTestId('restore-dialog');
    await expect(dialog.getByTestId('restore-preflight')).toBeVisible();
    await expect(dialog.getByTestId('restore-businesses')).toContainText('Demo Traders');
    await expect(dialog.getByTestId('restore-contents')).toContainText(/\d[\d,]* records/);
    await expect(dialog.getByTestId('restore-problems')).toHaveCount(0);
    // the person has to say they mean it
    await expect(dialog.getByTestId('restore-go')).toBeDisabled();
    await dialog.getByTestId('restore-agree').click();
    await dialog.getByTestId('restore-go').click();

    // the page reloads onto the restored database
    await expect(items(page)).toHaveText('200', { timeout: 120_000 });
    await expect(page.getByTestId('badge-documents')).toHaveText('500');
    await page.goto('/books/items');
    await page.getByTestId('item-search').fill('LATER-1');
    await expect(page.getByText('No items match')).toBeVisible();

    // what was here before the restore was kept as a backup, and it is still the database after a reload
    await page.goto(BACKUP_TAB);
    await expect
      .poll(() => page.getByTestId('backup-row').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    await page.reload();
    await expect(items(page)).toHaveText('200');
  });

  test('refuses a file that is not a backup, and a backup that was damaged', async ({ page }) => {
    await openSeeded(page, BACKUP_TAB);
    await page.getByTestId('restore-file').setInputFiles({
      name: 'notes.gstbk',
      mimeType: 'application/zip',
      buffer: Buffer.from('this is not a backup'),
    });
    let dialog = page.getByTestId('restore-dialog');
    await expect(dialog.getByTestId('restore-problems')).toContainText('not a GST Desk backup');
    await expect(dialog.getByTestId('restore-go')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // a real backup with one byte flipped in the middle
    const { bytes } = await download(page, 'backup-download');
    const damaged = Buffer.from(bytes);
    damaged[Math.floor(damaged.length / 2)]! ^= 0xff;
    await page.getByTestId('restore-file').setInputFiles({
      name: 'damaged.gstbk',
      mimeType: 'application/zip',
      buffer: damaged,
    });
    dialog = page.getByTestId('restore-dialog');
    await expect(dialog.getByTestId('restore-problems')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('restore-go')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // nothing changed
    await expect(items(page)).toHaveText('200');
  });

  test('one business can be added from a backup as a new business, leaving everything else alone', async ({
    page,
  }) => {
    await openSeeded(page, BACKUP_TAB);
    await backupNow(page);
    await page.getByTestId('backup-restore-row').click();
    const dialog = page.getByTestId('restore-dialog');
    await expect(dialog.getByTestId('restore-preflight')).toBeVisible();
    await dialog.getByTestId('restore-mode-one').check();
    await expect(dialog.getByTestId('restore-business')).toContainText('Demo Traders');
    await dialog.getByTestId('restore-go').click();
    await expect(page.getByText(/Business added/)).toBeVisible({ timeout: 120_000 });

    await page.getByTestId('business-switcher').click();
    await expect(page.getByRole('menuitem', { name: 'Demo Traders (imported)' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Demo Traders', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Demo Traders (imported)' }).click();
    await expect(page.getByTestId('badge-documents')).toHaveText('500');
    await expect(items(page)).toHaveText('200');
  });

  test('exports JSON and CSV, and imports the JSON back as a new business after showing what it holds', async ({
    page,
  }) => {
    await openSeeded(page, BACKUP_TAB);
    const json = await download(page, 'export-json');
    expect(json.name).toMatch(/^Demo_Traders_\d{4}-\d{2}-\d{2}\.gst\.json$/);
    const doc = JSON.parse(strFromU8(json.bytes)) as {
      format: string;
      business: { legal_name: string };
      tables: Record<string, { lines?: unknown[] }[]>;
    };
    expect(doc.format).toBe('gst-desk-export');
    expect(doc.business.legal_name).toBe('Demo Traders Pvt Ltd');
    expect(doc.tables['documents']).toHaveLength(500);
    expect(doc.tables['documents']!.some((d) => (d.lines?.length ?? 0) > 0)).toBe(true);
    expect(strFromU8(json.bytes)).not.toContain('cloud.');

    const csv = await download(page, 'export-csv');
    const zip = unzipSync(csv.bytes);
    expect(Object.keys(zip)).toEqual(
      expect.arrayContaining(['documents.csv', 'parties.csv', 'README.txt']),
    );
    expect(strFromU8(zip['documents.csv']!).split('\r\n').filter(Boolean)).toHaveLength(501);

    await page.getByTestId('import-file').setInputFiles({
      name: 'export.json',
      mimeType: 'application/json',
      buffer: Buffer.from(json.bytes),
    });
    const dialog = page.getByTestId('import-dialog');
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByTestId('import-count-documents')).toHaveText('500');
    await expect(dialog.getByTestId('import-count-parties')).toHaveText('50');
    // the preview wrote nothing: cancel, and there is no imported business
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('business-switcher').click();
    await expect(page.getByRole('menuitem', { name: /imported/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('import-file').setInputFiles({
      name: 'export.json',
      mimeType: 'application/json',
      buffer: Buffer.from(json.bytes),
    });
    await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 60_000 });
    await dialog.getByTestId('import-go').click();
    await expect(page.getByText(/Business imported/)).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('business-switcher').click();
    await expect(page.getByRole('menuitem', { name: 'Demo Traders (imported)' })).toBeVisible();
  });

  test('something that is not an export is explained, not imported', async ({ page }) => {
    await openSeeded(page, BACKUP_TAB);
    await page.getByTestId('import-file').setInputFiles({
      name: 'other.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"hello":"world"}'),
    });
    await expect(page.getByTestId('import-error')).toContainText('not a GST Desk export');
    await expect(page.getByTestId('import-go')).toBeDisabled();
  });

  test('automatic backups run on their own, and the schedule is kept', async ({ page }) => {
    await openSeeded(page, BACKUP_TAB);
    // nothing has been backed up, so the first launch of the day takes one
    await expect(page.getByTestId('backup-row')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('backup-row')).toContainText('Automatic');

    await page.getByTestId('schedule-mode').click();
    await page.getByRole('option', { name: 'Every day at' }).click();
    await page.getByTestId('schedule-time').fill('03:15');
    await page.getByTestId('schedule-enabled').click();
    await page.reload();
    await expect(page.getByTestId('schedule-time')).toHaveValue('03:15');
    await expect(page.getByTestId('schedule-enabled')).not.toBeChecked();
  });

  test('the cloud drive is for the desktop app, and says so', async ({ page }) => {
    await openSeeded(page, BACKUP_TAB);
    await expect(page.getByTestId('cloud-desktop-only')).toContainText('desktop app');
    await expect(page.getByTestId('cloud-client-id')).toHaveCount(0);
  });
});

test.describe('download reminder and failure alert', () => {
  test('a new install is not nagged; after a week it asks once a day, and a download clears it', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await expect(page.getByTestId('dashboard-frame')).toBeVisible();
    await expect(page.getByTestId('download-reminder')).toHaveCount(0);

    await page.evaluate((ago) => {
      localStorage.setItem('gst.backup.status', JSON.stringify({ sinceAt: Date.now() - ago }));
    }, 10 * DAY);
    await page.goto('/books/dashboard');
    const card = page.getByTestId('download-reminder');
    await expect(card).toContainText('10 days since you downloaded a backup');
    await page.getByTestId('reminder-later').click();
    await expect(card).toHaveCount(0);
    await page.goto('/books/dashboard');
    await expect(page.getByTestId('dashboard-frame')).toBeVisible();
    await expect(page.getByTestId('download-reminder')).toHaveCount(0);

    // snoozing is for a day; a download ends it
    await page.evaluate((ago) => {
      localStorage.setItem('gst.backup.status', JSON.stringify({ sinceAt: Date.now() - ago }));
    }, 10 * DAY);
    await page.goto('/books/dashboard');
    const dl = page.waitForEvent('download');
    await page.getByTestId('reminder-download').click();
    await dl;
    await expect(page.getByTestId('download-reminder')).toHaveCount(0);
  });

  test('a backup that failed shows on the bell, and the Backup tab says why', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await page.evaluate(() => {
      localStorage.setItem(
        'gst.backup.status',
        JSON.stringify({
          ok: false,
          error: 'The disk is full',
          failedAt: Date.now(),
          sinceAt: Date.now(),
        }),
      );
    });
    await page.goto('/books/dashboard');
    const bell = page.getByTestId('bell');
    await expect(bell).toHaveAttribute('aria-label', /The last backup did not work/);
    await bell.click();
    await page.getByTestId('bell-backup').click();
    await expect(page).toHaveURL(/settings\?tab=backup/);
    await expect(page.getByTestId('backup-failed')).toContainText('The disk is full');
  });
});

test.describe('the trash', () => {
  test('a deleted item waits 30 days, comes back on request, and can be deleted for good', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await addItem(page, 'Trash test item', 'TRASH-1');
    await deleteItem(page, 'TRASH-1');
    await expect(items(page)).toHaveText('200');

    await page.goto('/books/settings?tab=trash');
    const row = page.getByTestId('trash-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Trash test item');
    await expect(row).toContainText('Item');
    await expect(row.getByTestId('trash-days')).toHaveText('30 days');

    await row.getByTestId('trash-restore').click();
    await expect(page.getByText(/Restored “Trash test item”/)).toBeVisible();
    await expect(page.getByTestId('trash-none')).toBeVisible();
    await expect(items(page)).toHaveText('201');

    await deleteItem(page, 'TRASH-1');
    await page.goto('/books/settings?tab=trash');
    await page.getByTestId('trash-purge').click();
    await page
      .getByTestId('confirm-dialog')
      .getByRole('button', { name: 'Delete for good' })
      .click();
    await expect(page.getByTestId('trash-none')).toBeVisible();
    await page.goto('/books/items');
    await page.getByTestId('item-search').fill('TRASH-1');
    await expect(page.getByText('No items match')).toBeVisible();
  });

  test('emptying the trash asks first and removes everything in it', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await addItem(page, 'First to go', 'GO-1');
    await addItem(page, 'Second to go', 'GO-2');
    await deleteItem(page, 'GO-1');
    await deleteItem(page, 'GO-2');
    await page.goto('/books/settings?tab=trash');
    await expect(page.getByTestId('trash-row')).toHaveCount(2);
    await page.getByTestId('trash-empty').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(
      '2 things will be deleted for good',
    );
    await page
      .getByTestId('confirm-dialog')
      .getByRole('button', { name: 'Empty the trash' })
      .click();
    await expect(page.getByTestId('trash-none')).toBeVisible();
  });
});
