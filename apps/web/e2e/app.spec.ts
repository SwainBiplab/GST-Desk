import { expect, test } from '@playwright/test';

import { openCommandBar, openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });

test.describe('routing and shells', () => {
  test('/ opens the last used shell, /shop and /books land on the dashboard, bad pages 404', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/shop\/dashboard$/);
    await page.goto('/books');
    await expect(page).toHaveURL(/\/books\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/books\/dashboard$/); // remembered per device
    await page.goto('/shop/nonsense');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  test('every page deep-links inside its shell', async ({ page }) => {
    for (const shell of ['shop', 'books']) {
      for (const p of [
        'dashboard',
        'sell',
        'parties',
        'items',
        'documents',
        'payments',
        'reports',
        'inbox',
        'settings',
      ]) {
        await page.goto(`/${shell}/${p}`);
        await expect(page.locator(`[data-shell="${shell}"]`).first()).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      }
    }
  });

  test('switching shells is a layout change that keeps the page and takes under 200 ms', async ({
    page,
  }) => {
    await openSeeded(page, '/books/parties');
    await expect(page.getByRole('heading', { name: 'Parties' })).toBeVisible();
    const started = Date.now();
    await page.getByTestId('switch-shop').click();
    await expect(page.locator('[data-shell="shop"]').first()).toBeVisible();
    const ms = Date.now() - started;
    expect(ms).toBeLessThan(200);
    await expect(page).toHaveURL(/\/shop\/parties$/);
    await expect(page.getByTestId('summary-strip')).toBeVisible();
    await page.getByTestId('switch-books').click();
    await expect(page).toHaveURL(/\/books\/parties$/);
  });

  test('shell defaults: Shop is comfortable with 44 px targets, Books is compact; density is remembered per shell', async ({
    page,
  }) => {
    await page.goto('/shop/dashboard');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
    for (const id of ['nav-parties', 'action-new-bill']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height, id).toBeGreaterThanOrEqual(44);
      if (id.startsWith('nav')) expect(box!.width, id).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('switch-books').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await page.getByTestId('density-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
    await page.getByTestId('switch-shop').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
    await page.getByTestId('switch-books').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable'); // Books remembers the override
  });

  test('theme toggle persists across reloads', async ({ page }) => {
    await page.goto('/books/dashboard');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  });
});

test.describe('data', () => {
  test('first run shows the empty state and loads demo data on request', async ({ page }) => {
    await page.goto('/books/dashboard');
    await expect(page.getByText('No business set up yet')).toBeVisible();
    await expect(page.getByTestId('sync-pill')).toHaveText('Local');
    await page.getByTestId('load-demo').click();
    await expect(page.getByTestId('dashboard-frame')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('badge-parties')).toHaveText('50');
  });

  test('nav badges show the seeded counts in both shells', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await expect(page.getByTestId('badge-parties')).toHaveText('50');
    await expect(page.getByTestId('badge-items')).toHaveText('200');
    await expect(page.getByTestId('badge-documents')).toHaveText('500');
    await page.getByTestId('switch-shop').click();
    await expect(page.getByTestId('badge-parties')).toHaveText('50');
    await expect(page.getByTestId('badge-items')).toHaveText('200');
  });

  test('data survives a reload (OPFS) and the dashboard frames hold the question cards', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await page.goto('/books/dashboard'); // no ?demo=1 this time
    await expect(page.getByTestId('badge-documents')).toHaveText('500');
    await expect(page.getByTestId('card-gst')).toContainText('GST this month');
    await page.getByTestId('switch-shop').click();
    await expect(page.getByTestId('card-sold')).toContainText('sell today');
  });

  test('the shop strip shows today numbers and the bell shows pending reviews', async ({
    page,
  }) => {
    await openSeeded(page, '/shop/dashboard');
    await expect(page.getByTestId('strip-sales')).toContainText('₹');
    await expect(page.getByTestId('strip-pending')).toContainText('₹');
    await expect(page.getByTestId('bell')).toHaveAttribute(
      'aria-label',
      /0 items waiting for review/,
    );
  });
});

test.describe('command bar', () => {
  test('Ctrl+K and / open it, Esc closes it and focus returns', async ({ page }) => {
    await openSeeded(page);
    const link = page.getByTestId('nav-parties');
    await link.focus();
    await openCommandBar(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-bar')).toBeHidden();
    await expect(link).toBeFocused();
    await page.keyboard.press('/');
    await expect(page.getByTestId('command-input')).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('runs an action from the keyboard', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('go to parties');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/books\/parties$/);
    await expect(page.getByRole('heading', { name: 'Parties' })).toBeVisible();
  });

  test('toggles dark mode as an action and remembers it', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('dark');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('searches documents, parties and items within 100 ms on 500 documents', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('inv');
    const results = page.getByTestId('command-results');
    await expect(results.getByText('Documents')).toBeVisible();
    await expect(results.locator('[cmdk-item]').filter({ hasText: 'INV/' }).first()).toBeVisible();
    const docMs = Number(await results.getAttribute('data-search-ms'));
    expect(docMs).toBeLessThan(100);

    await page.getByTestId('command-input').fill('12');
    await expect(results.getByText('Parties')).toBeVisible();
    await expect(results.getByText('Items')).toBeVisible();
    await expect
      .poll(async () => Number(await results.getAttribute('data-search-ms')))
      .toBeLessThan(100);
  });

  test('finds a seeded party by name and opens it', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('12');
    const party = page
      .getByTestId('command-results')
      .locator('[cmdk-group]')
      .filter({ hasText: 'Parties' })
      .locator('[cmdk-item]')
      .first();
    await expect(party).toBeVisible();
    await party.click();
    await expect(page).toHaveURL(/\/books\/parties\?open=/);
  });

  test('parses typed arguments: "pay 5000 to Sharma"', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('pay 5000 to Sharma');
    const intent = page.getByTestId('command-intent');
    await expect(intent).toContainText('Pay ₹5,000.00 to');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/books\/payments/);
    await expect(page.getByTestId('intent')).toContainText('Pay ₹5,000.00 to Sharma');
  });

  test('offers the assistant for free text and says it is not available yet', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('what is my gst liability for march');
    await page.getByTestId('command-ask').click();
    await expect(page.getByText('The assistant is not available yet')).toBeVisible();
  });

  test('shows recent actions and rows when empty', async ({ page }) => {
    await openSeeded(page);
    await openCommandBar(page);
    await page.keyboard.type('items');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/books\/items$/);
    await openCommandBar(page);
    await expect(page.getByTestId('command-results').getByText('Recent').first()).toBeVisible();
    await expect(page.getByTestId('command-results').getByText('Go to Items')).toBeVisible();
  });
});

test.describe('keyboard map', () => {
  test('? shows the map, Esc closes it and returns focus', async ({ page }) => {
    await openSeeded(page);
    const link = page.getByTestId('nav-items');
    await link.focus();
    await page.keyboard.press('?');
    const keymap = page.getByTestId('keymap');
    await expect(keymap).toBeVisible();
    await expect(keymap).toContainText('G then P');
    await page.keyboard.press('Escape');
    await expect(keymap).toBeHidden();
    await expect(link).toBeFocused();
  });

  test('Books shortcuts: G then P goes to Parties, N opens the new-document menu', async ({
    page,
  }) => {
    await openSeeded(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/\/books\/parties$/);
    await page.keyboard.press('n');
    await expect(page.getByTestId('command-input')).toHaveValue('new ');
    await page.keyboard.press('Escape');
  });

  test('shortcuts do not fire while typing and Shop does not have Books-only keys', async ({
    page,
  }) => {
    await openSeeded(page, '/books/_kit');
    await page.getByLabel('Name').fill('');
    await page.getByLabel('Name').press('g');
    await page.getByLabel('Name').press('p');
    await expect(page).toHaveURL(/_kit(\?|$)/);
    await page.goto('/shop/dashboard');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/\/shop\/dashboard$/);
    await page.keyboard.press('?');
    await expect(page.getByTestId('keymap')).not.toContainText('G then P');
  });

  test('all nav items are reachable and operable by keyboard', async ({ page }) => {
    await openSeeded(page);
    const ids = [
      'dashboard',
      'sell',
      'documents',
      'purchases',
      'parties',
      'items',
      'payments',
      'reports',
      'gst',
      'inbox',
      'settings',
    ];
    for (const id of ids) {
      const link = page.getByTestId(`nav-${id}`);
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(link).toHaveAttribute('aria-current', 'page');
    }
    await expect(page).toHaveURL(/\/books\/settings$/);
  });
});

test.describe('chrome', () => {
  test('the right panel resizes with the keyboard', async ({ page }) => {
    await openSeeded(page);
    const sep = page.getByTestId('panel-resizer');
    const before = Number(await sep.getAttribute('aria-valuenow'));
    await sep.focus();
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(async () => Number(await sep.getAttribute('aria-valuenow')))
      .toBe(before + 16);
    await page.keyboard.press('Home');
    await expect(sep).toHaveAttribute('aria-valuenow', '240');
  });

  test('business switcher lists the business and the sync pill says Local', async ({ page }) => {
    await openSeeded(page);
    await expect(page.getByTestId('business-switcher')).toContainText('Demo Traders');
    await page.getByTestId('business-switcher').click();
    await expect(page.getByRole('menuitem', { name: 'Demo Traders' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sync-pill')).toHaveText('Local');
  });

  test('unsaved-changes guard asks before leaving a dirty form', async ({ page }) => {
    await openSeeded(page, '/books/_kit');
    await page.getByLabel('Name').fill('Draft party');
    await page.getByTestId('nav-parties').click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('Leave without saving?');
    await dialog.getByRole('button', { name: 'Stay' }).click();
    await expect(page).toHaveURL(/_kit(\?|$)/);
    await page.getByTestId('nav-parties').click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Leave' }).click();
    await expect(page).toHaveURL(/\/books\/parties$/);
  });

  test('a crash shows the error screen and copies diagnostics without personal data', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/books/_crash');
    await expect(page.getByTestId('error-screen')).toBeVisible();
    await page.getByTestId('copy-diagnostics').click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const report = JSON.parse(text);
    expect(report.route).toBe('/books/_crash');
    expect(report.error.message).toBe('Deliberate crash for [email] [phone]');
    expect(text).not.toMatch(/sharma|9876543210/);
  });
});

test.describe('offline', () => {
  test('works offline from the second load, with data intact', async ({ page, context }) => {
    await openSeeded(page, '/books/dashboard');
    // wait for the service worker to take control, then load once more so the page is controlled
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('badge-parties')).toHaveText('50');
    await page.getByTestId('nav-parties').click();
    await expect(page.getByRole('heading', { name: 'Parties' })).toBeVisible();
    await context.setOffline(false);
  });
});
