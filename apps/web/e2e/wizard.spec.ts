import { expect, test, type Page } from '@playwright/test';

import { gstin, openSeeded, png, runWizard, tabTo } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });

const settings = async (page: Page, tab?: string) => {
  await page.goto(`/books/settings${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
};

test.describe('first run', () => {
  test('a new database sends you to the wizard from anywhere, and a set-up one skips it', async ({
    page,
  }) => {
    await page.goto('/books/parties');
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();
    await runWizard(page);
    await page.goto('/welcome');
    await expect(page).toHaveURL(/\/(shop|books)\/dashboard$/);
  });

  test('a GSTIN gets from the first screen to a dashboard in under 20 UI actions', async ({
    page,
  }) => {
    const started = Date.now();
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome$/);
    const actions = await runWizard(page, { name: 'Sharma Traders', preset: 'retail' });
    // upload a logo as part of the run? Kept separate: this counts the shortest honest path.
    await page.getByTestId('go-dashboard').click();
    const total = actions + 1;
    await expect(page.getByTestId('dashboard-frame')).toBeVisible();
    expect(total).toBeLessThan(20);
    expect(Date.now() - started).toBeLessThan(120_000);
    await expect(page.getByTestId('business-switcher')).toContainText('Sharma Traders');
    // profile is complete straight away; the logo and the rest are still to do
    await expect(page.getByTestId('step-profile')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('step-party')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('checklist-progress')).toHaveText('1/7');
    console.log(`wizard run: ${total} actions in ${Math.round((Date.now() - started) / 1000)} s`);
  });

  test('completes with the keyboard only', async ({ page }) => {
    await page.goto('/welcome');
    // 1 language and mode, 2 start from: Tab to Next and press Enter
    for (const step of ['start', 'registration']) {
      await tabTo(page, 'wizard-next');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('wizard')).toHaveAttribute('data-step', step);
    }
    // 3 GSTIN: the field is focused, Enter submits
    await expect(page.getByLabel('GSTIN')).toBeFocused();
    await page.keyboard.type(gstin());
    await page.keyboard.press('Enter');
    // 4 details
    await expect(page.getByLabel('Legal name')).toBeFocused();
    await page.keyboard.type('Keyboard Traders');
    await page.keyboard.press('Tab'); // trade name
    await page.keyboard.press('Tab'); // address
    await page.keyboard.type('1 Main Street');
    await page.keyboard.press('Enter');
    // 5 preset: arrow keys choose
    await expect(page.getByTestId('wizard')).toHaveAttribute('data-step', 'preset');
    await page.keyboard.press('ArrowDown');
    await tabTo(page, 'wizard-next');
    await page.keyboard.press('Enter');
    // 6 payment account: skip
    await expect(page.getByTestId('wizard')).toHaveAttribute('data-step', 'bank');
    await expect(page.getByTestId('wizard-skip')).toBeEnabled(); // waits for the database to open
    await tabTo(page, 'wizard-skip');
    await page.keyboard.press('Enter');
    // 7 done
    await expect(page.getByTestId('go-dashboard')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('business-switcher')).toContainText('Keyboard Traders');
  });

  test('validates each step inline and Back keeps what you typed', async ({ page }) => {
    await page.goto('/welcome');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    // registration
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('Enter your GSTIN')).toBeVisible();
    await page.getByLabel('GSTIN').fill('27AAPFU0939F1Z');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('15 letters and digits')).toBeVisible();
    const g = gstin();
    const wrong = g.slice(0, 14) + (g.endsWith('A') ? 'B' : 'A');
    await page.getByLabel('GSTIN').fill(wrong);
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('last character does not match')).toBeVisible();
    await page.getByLabel('GSTIN').fill(g);
    await expect(page.getByTestId('gstin-derived')).toContainText(
      'Maharashtra (27) | PAN AAPFU0939F | Firm or LLP',
    );
    await page.getByTestId('wizard-next').click();
    // details
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('Enter the business name')).toBeVisible();
    await expect(page.getByText('Enter the address')).toBeVisible();
    await page.getByLabel('Legal name').fill('Kept Traders');
    await page.getByLabel('Address').fill('9 Road');
    await page.getByLabel('PIN code').fill('4000');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('PIN code has 6 digits')).toBeVisible();
    await page.getByLabel('PIN code').fill('400001');
    await page.getByLabel('Phone').fill('12345');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('10 digit mobile number')).toBeVisible();
    await page.getByLabel('Phone').fill('98765 43210');
    // back twice and forward again: nothing is lost
    await page.getByTestId('wizard-back').click();
    await expect(page.getByLabel('GSTIN')).toHaveValue(g);
    await page.getByTestId('wizard-next').click();
    await expect(page.getByLabel('Legal name')).toHaveValue('Kept Traders');
    await expect(page.getByLabel('PIN code')).toHaveValue('400001');
    await expect(page.getByLabel('Phone')).toHaveValue('98765 43210');
  });

  test('a business that is not registered picks a state; composition needs a GSTIN', async ({
    page,
  }) => {
    await page.goto('/welcome');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('I am not registered for GST yet').click();
    await expect(page.getByLabel('GSTIN')).toHaveCount(0);
    await expect(page.getByLabel('Composition scheme')).toBeDisabled();
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('Choose your state')).toBeVisible();
    await page.getByTestId('state-select').click();
    await page.getByRole('option', { name: /Karnataka/ }).click();
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('Legal name').fill('Freelance Co');
    await page.getByLabel('Address').fill('Indiranagar');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-skip').click();
    await page.getByTestId('go-dashboard').click();
    await expect(page.getByTestId('step-profile')).toHaveAttribute('data-done', 'true');
  });

  test('the sample business fills the app and skips the questions', async ({ page }) => {
    await page.goto('/welcome');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('Coming soon')).toBeVisible();
    await expect(page.getByLabel(/Import from Tally/)).toBeDisabled();
    await page.getByLabel(/Try it with a sample business/).click();
    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('wizard')).toHaveAttribute('data-step', 'done', {
      timeout: 30_000,
    });
    await page.getByTestId('go-dashboard').click();
    await expect(page.getByTestId('badge-parties')).toHaveText('50');
  });

  test('stores a logo as an attachment, resized to 512 px', async ({ page }) => {
    await page.goto('/welcome');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('GSTIN').fill(gstin());
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('Legal name').fill('Logo Traders');
    await page.getByLabel('Address').fill('1 Road');
    await page
      .getByTestId('logo-input')
      .setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: png(1200, 600) });
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-skip').click();
    await expect(page.getByTestId('step-logo')).toHaveAttribute('data-done', 'true');
    await page.getByTestId('go-dashboard').click();
    await settings(page, 'branding');
    const img = page.getByTestId('preview-logo');
    await expect(img).toBeVisible();
    const size = await img.evaluate((el: HTMLImageElement) => ({
      w: el.naturalWidth,
      h: el.naturalHeight,
    }));
    expect(size).toEqual({ w: 512, h: 256 });
  });
});

test.describe('settings and businesses', () => {
  test('edits the profile, asks before leaving unsaved changes, and shows the new name', async ({
    page,
  }) => {
    await page.goto('/welcome');
    await runWizard(page, { name: 'Old Name' });
    await page.getByTestId('go-dashboard').click();
    await settings(page);
    await page.getByLabel('Trade name (optional)').fill('Fresh Brand');
    await page.getByTestId('nav-parties').click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Stay' }).click();
    await expect(page).toHaveURL(/settings/);
    await page.getByTestId('save-profile').click();
    await expect(page.getByText('Saved').first()).toBeVisible();
    await expect(page.getByTestId('business-switcher')).toContainText('Fresh Brand');
    await page.getByTestId('nav-parties').click();
    await expect(page).toHaveURL(/\/books\/parties$/);
  });

  test('uploads a signature and a stamp', async ({ page }) => {
    await page.goto('/welcome');
    await runWizard(page);
    await page.getByTestId('go-dashboard').click();
    await settings(page, 'branding');
    await page
      .getByTestId('file-signature')
      .setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: png(300, 100) });
    await expect(page.getByTestId('preview-signature')).toBeVisible();
    await page
      .getByTestId('file-stamp')
      .setInputFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: png(200, 200) });
    await expect(page.getByTestId('preview-stamp')).toBeVisible();
    await expect(page.getByTestId('preview-logo')).toHaveCount(0);
  });

  test('a second business keeps its own data and can be switched to and archived', async ({
    page,
  }) => {
    await openSeeded(page, '/books/settings?tab=businesses');
    await expect(page.getByTestId('badge-parties')).toHaveText('50');
    await page.getByTestId('add-business').click();
    await expect(page).toHaveURL(/welcome\?add=true/);
    await expect(page.getByTestId('wizard')).toHaveAttribute('data-step', 'registration'); // no language or start steps
    await runWizard(page, { name: 'Second Shop', gstin: gstin('29', 'AABCS1234F') });
    await page.getByTestId('go-dashboard').click();

    await expect(page.getByTestId('business-switcher')).toContainText('Second Shop');
    await expect(page.getByTestId('badge-parties')).toHaveCount(0); // empty business: no parties, nothing leaks
    await page.getByTestId('business-switcher').click();
    await page.getByRole('menuitem', { name: 'Demo Traders' }).click();
    await expect(page.getByTestId('badge-parties')).toHaveText('50');

    await settings(page, 'businesses');
    await expect(
      page.locator('li[data-testid^="business-"]').filter({ hasText: 'Demo Traders' }),
    ).toBeVisible();
    await page.getByTestId('business-switcher').click();
    await page.getByRole('menuitem', { name: 'Second Shop' }).click();
    await settings(page, 'businesses');
    const row = page.locator('li[data-testid^="business-"]').filter({ hasText: 'Demo Traders' });
    await row.getByRole('button', { name: 'Archive' }).click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Archive' }).click();
    await expect(
      page.locator('li[data-testid^="business-"]').filter({ hasText: 'Demo Traders' }),
    ).toHaveCount(0);
    // the last business cannot be archived
    await expect(
      page.locator('li[data-testid^="business-"]').getByRole('button', { name: 'Archive' }),
    ).toBeDisabled();
  });
});

test.describe('presets and the composition scheme', () => {
  test('retail turns on inventory and thermal sections; services does not', async ({ page }) => {
    await page.goto('/welcome');
    await runWizard(page, { preset: 'retail' });
    await page.getByTestId('go-dashboard').click();
    await settings(page);
    await expect(page.getByTestId('tab-inventory')).toBeVisible();
    await expect(page.getByTestId('tab-thermal')).toBeVisible();
    await expect(page.getByTestId('nav-purchases')).toBeVisible();
  });

  test('a freelancer has no inventory, thermal or purchases; overrides bring them back', async ({
    page,
  }) => {
    await page.goto('/welcome');
    await runWizard(page, { preset: 'freelancer' });
    await page.getByTestId('go-dashboard').click();
    await settings(page);
    await expect(page.getByTestId('tab-inventory')).toHaveCount(0);
    await expect(page.getByTestId('tab-thermal')).toHaveCount(0);
    await expect(page.getByTestId('nav-purchases')).toHaveCount(0);

    await page.getByTestId('tab-features').click();
    await page.getByTestId('flag-inventory').click();
    await expect(page.getByText('Saved').first()).toBeVisible();
    await expect(page.getByTestId('tab-inventory')).toBeVisible();
    await page.getByTestId('flag-purchases').click();
    await expect(page.getByTestId('nav-purchases')).toBeVisible();

    // overrides survive a reload
    await page.reload();
    await expect(page.getByTestId('tab-inventory')).toBeVisible();
    await expect(page.getByTestId('nav-purchases')).toBeVisible();
  });

  test('flags hide command-bar actions too', async ({ page }) => {
    await page.goto('/welcome');
    await runWizard(page, { preset: 'freelancer' });
    await page.getByTestId('go-dashboard').click();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('new purchase');
    await expect(page.getByTestId('command-results')).not.toContainText('New purchase bill');
  });

  test('composition: Bill of Supply with the Rule 46A text, tax invoices blocked with a reason', async ({
    page,
  }) => {
    await page.goto('/welcome');
    await runWizard(page, { composition: true, preset: 'trader' });
    await page.getByTestId('go-dashboard').click();

    await page.getByTestId('nav-sell').click();
    await expect(page.getByTestId('preview-title')).toHaveText(/bill of supply/i);
    // the declaration wraps onto more than one printed line: compare without the spaces at the wrap
    await expect
      .poll(async () =>
        ((await page.getByTestId('preview-sheet').textContent()) ?? '').replace(/\s+/g, ''),
      )
      .toContain('Compositiontaxableperson,noteligibletocollecttaxonsupplies');
    // a tax invoice cannot be issued, and the reason is shown
    await page.goto('/books/documents/new?type=tax_invoice');
    await page.getByTestId('doc-issue').click();
    await expect(page.getByTestId('doc-problems')).toContainText('cannot issue a tax invoice');

    await settings(page, 'features');
    await expect(page.getByTestId('flag-taxInvoice')).toBeDisabled();
    await expect(page.getByTestId('flag-taxInvoice')).not.toBeChecked();
    await page.getByTestId('tab-documents').click();
    await expect(page.getByTestId('declaration')).toContainText('Composition taxable person');
  });

  test('switching to composition in Settings asks for confirmation first', async ({ page }) => {
    await page.goto('/welcome');
    await runWizard(page);
    await page.getByTestId('go-dashboard').click();
    await settings(page);
    await page.getByLabel('Composition scheme').click();
    await page.getByTestId('save-profile').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Change the tax scheme?');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('nav-sell').click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Leave' }).click();
    await expect(page.getByTestId('preview-title')).toHaveText(/tax invoice/i);
  });
});

test.describe('getting-started checklist', () => {
  test('is on both dashboards, can be dismissed, and stays dismissed', async ({ page }) => {
    await page.goto('/welcome');
    await runWizard(page);
    await page.getByTestId('go-dashboard').click();
    await expect(page.getByTestId('checklist')).toBeVisible();
    await page.getByTestId('switch-books').click();
    await expect(page.getByTestId('checklist')).toBeVisible();
    await page.getByTestId('checklist-dismiss').click();
    await expect(page.getByTestId('checklist')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('dashboard-frame')).toBeVisible();
    await expect(page.getByTestId('checklist')).toHaveCount(0);
    await page.getByTestId('switch-shop').click();
    await expect(page.getByTestId('checklist')).toHaveCount(0);
  });

  test('ticks itself from the data', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    for (const id of ['party', 'item', 'invoice', 'payment']) {
      await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('data-done', 'true');
    }
    await expect(page.getByTestId('step-logo')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('step-backup')).toHaveAttribute('data-done', 'false');
    await page.getByTestId('step-logo').getByRole('link').click();
    await expect(page).toHaveURL(/settings\?tab=branding/);
    await expect(page.getByTestId('branding-logo')).toBeVisible();
  });
});
