import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { gstin, openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });

const rupees = (text: string | null) =>
  Number((text ?? '').replace(/[₹,\s]/g, '').replace(/[^\d.-]/g, ''));

async function newParty(
  page: Page,
  v: { name: string; gstin?: string; phone?: string; state?: string; opening?: string },
) {
  await page.getByTestId('new-party').click();
  await expect(page.getByTestId('party-drawer')).toBeVisible();
  await page.getByTestId('party-name').fill(v.name);
  if (v.gstin) await page.getByTestId('party-gstin').fill(v.gstin);
  else {
    await page.getByTestId('party-state').click();
    await page.getByRole('option', { name: new RegExp(`\\(${v.state ?? '27'}\\)`) }).click();
  }
  if (v.phone) await page.getByTestId('party-phone').fill(v.phone);
  if (v.opening) await page.getByTestId('party-opening').fill(v.opening);
}

test.describe('party list', () => {
  test('Books shows a virtualised table of all parties', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await expect(page.getByTestId('party-table')).toBeVisible();
    await expect(page.getByText('50 of 50 parties')).toBeVisible();
    const rendered = await page.getByTestId('party-row').count();
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(50); // only the visible window is in the DOM
    await page
      .getByTestId('party-table')
      .locator('[role="table"]')
      .evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByTestId('party-row').last()).toBeVisible();
  });

  test('searches by name, city and GSTIN with full-text search', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    const firstName = (await page.getByTestId('party-open').first().textContent())!;
    await page.getByTestId('party-search').fill(firstName.split(' ')[0]!);
    await expect(
      page.getByTestId('party-open').filter({ hasText: new RegExp(`^${firstName}$`) }),
    ).toHaveCount(1);
    await page.getByTestId('party-search').fill('zzzzzz');
    await expect(page.getByText('No parties match.')).toBeVisible();
    await page.getByTestId('party-search').fill('');
    await expect(page.getByText('50 of 50 parties')).toBeVisible();
  });

  test('filters by type, outstanding, overdue and unregistered', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    const count = async () =>
      Number(/(\d+) of 50/.exec((await page.getByText(/of 50 parties/).textContent())!)![1]);
    await page.getByTestId('filter-unregistered').click();
    await expect.poll(count).toBeLessThan(50);
    const unregistered = await count();
    expect(unregistered).toBeGreaterThan(0);
    await page.getByTestId('filter-unregistered').click();

    await page.getByTestId('filter-outstanding').click();
    await expect.poll(count).toBeLessThan(50);
    const owing = await count();
    await page.getByTestId('filter-overdue').click();
    await expect.poll(count).toBeLessThanOrEqual(owing);
    await page.getByRole('button', { name: 'Clear filters' }).click();

    await page.getByTestId('filter-type').click();
    await page.getByRole('option', { name: 'Supplier' }).click();
    await expect.poll(count).toBeLessThan(50);
  });

  test('sorts by outstanding and remembers the columns you choose', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await expect(page.getByRole('columnheader', { name: /City/ })).toHaveCount(0);
    await page.getByTestId('columns-menu').click();
    await page.getByTestId('col-city').click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('columnheader', { name: /City/ })).toBeVisible();
    await page.getByTestId('sort-balance').click();
    const header = page.getByRole('columnheader', { name: /Outstanding/ });
    await expect(header).not.toHaveAttribute('aria-sort', 'none');
    const firstDirection = await header.getAttribute('aria-sort');
    await page.getByTestId('sort-balance').click();
    await expect(header).not.toHaveAttribute('aria-sort', firstDirection!);
    const first = rupees(
      await page.getByTestId('party-row').first().locator('[role="cell"]').nth(6).textContent(),
    );
    expect(first).toBeGreaterThanOrEqual(0);
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /City/ })).toBeVisible();
  });

  test('exports the filtered list as CSV', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-csv').click(),
    ]);
    expect(download.suggestedFilename()).toBe('parties.csv');
    const csv = (await readFile((await download.path())!, 'utf8')).replace(/^\uFEFF/, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Name,Type,GSTIN,Phone,City,State,Outstanding,Overdue');
    expect(lines).toHaveLength(51);
  });

  test('Shop shows cards and a full-page form', async ({ page }) => {
    await openSeeded(page, '/shop/parties');
    await expect(page.getByTestId('party-card').first()).toBeVisible();
    await page.getByTestId('party-search').fill('zzzzzz');
    await expect(page.getByText('No parties match.')).toBeVisible();
    await page.getByTestId('party-search').fill('');
    await page.getByTestId('new-party').click();
    await expect(page.getByTestId('party-page-form')).toBeVisible();
    await page.getByTestId('party-name').fill('Counter Customer');
    await page.getByTestId('party-state').click();
    await page.getByRole('option', { name: /Karnataka/ }).click();
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('party-360')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Counter Customer' })).toBeVisible();
  });
});

test.describe('party form', () => {
  test('creates a party, reading state and PAN from the GSTIN, and opens Party 360', async ({
    page,
  }) => {
    await openSeeded(page, '/books/parties');
    await newParty(page, {
      name: 'Zeta Traders',
      gstin: gstin('29', 'AABCZ1234F'),
      phone: '98765 43210',
    });
    await expect(page.getByTestId('party-derived')).toContainText(
      'Karnataka (29) | PAN AABCZ1234F',
    );
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('party-360')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Zeta Traders' })).toBeVisible();
    await expect(page.getByTestId('badge-parties')).toHaveText('51');
  });

  test('validates inline: name, GSTIN checksum, phone', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await page.getByTestId('new-party').click();
    await page.getByTestId('party-save').click();
    await expect(page.getByText('Enter a name of at least two letters')).toBeVisible();
    await expect(page.getByText('Choose your state')).toBeVisible();
    await page.getByTestId('party-name').fill('Bad Number Co');
    const g = gstin();
    await page.getByTestId('party-gstin').fill(g.slice(0, 14) + (g.endsWith('A') ? 'B' : 'A'));
    await page.getByTestId('party-phone').fill('12345');
    await page.getByTestId('party-save').click();
    await expect(page.getByText('last character does not match').first()).toBeVisible();
    await expect(page.getByText('10 digit mobile number')).toBeVisible();
  });

  test('an export customer needs no state and a foreign country', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await page.getByTestId('new-party').click();
    await page.getByTestId('party-name').fill('Acme GmbH');
    await page.getByTestId('party-country').fill('Germany');
    await expect(page.getByTestId('party-gstin')).toHaveCount(0);
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('party-360')).toBeVisible();
  });

  test('records an opening balance that shows in the ledger and as the outstanding amount', async ({
    page,
  }) => {
    await openSeeded(page, '/books/parties');
    await newParty(page, { name: 'Opening Co', state: '27', opening: '500' });
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('p360-outstanding')).toContainText('₹500.00');
    await expect(page.getByTestId('p360-outstanding')).toContainText('Owes you');
    await expect(page.getByTestId('ledger-line')).toContainText('Opening balance');
    await expect(page.getByTestId('ledger-closing')).toContainText('₹500.00');
  });

  test('a supplier we owe money shows as "You owe"', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await newParty(page, { name: 'Supplier Co', state: '27', opening: '900' });
    await page.getByTestId('party-opening-side').click();
    await page.getByRole('option', { name: 'I owe them' }).click();
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('p360-outstanding')).toContainText('You owe');
    await expect(page.getByTestId('p360-outstanding')).toContainText('₹900.00');
  });

  test('edits a party and keeps contacts and credit terms', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await newParty(page, { name: 'Editable Co', state: '27' });
    await page.getByTestId('add-contact').click();
    await page.getByLabel('Contact name').fill('Raj');
    await page.getByTestId('party-credit-days').fill('45');
    await page.getByTestId('party-credit-limit').fill('50000');
    await page.getByTestId('party-tags').fill('vip, wholesale');
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('p360-credit')).toContainText('₹50,000.00');
    await page.getByTestId('p360-edit').click();
    await expect(page.getByTestId('party-drawer')).toBeVisible();
    await expect(page.getByTestId('party-credit-days')).toHaveValue('45');
    await expect(page.getByLabel('Contact name')).toHaveValue('Raj');
    await page.getByTestId('party-name').fill('Edited Co');
    await page.getByTestId('party-save').click();
    await expect(page.getByRole('heading', { name: 'Edited Co' })).toBeVisible();
    await expect(page.getByText('wholesale')).toBeVisible();
  });
});

test.describe('duplicates and merging', () => {
  test('warns about a likely duplicate and lets you use it, or save anyway', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    const g = gstin('27', 'AAPFD1111F');
    await newParty(page, { name: 'Alpha Stores Pvt Ltd', gstin: g, phone: '9811111111' });
    await page.getByTestId('party-save').click();
    await expect(page.getByTestId('party-360')).toBeVisible();
    await page.getByTestId('p360-back').click();

    // same GSTIN under a different spelling
    await newParty(page, { name: 'Alpha Store Private Limited', gstin: g });
    await page.getByTestId('party-save').click();
    const dialog = page.getByTestId('duplicates-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('duplicate-candidate')).toContainText('Alpha Stores Pvt Ltd');
    await expect(dialog).toContainText('same GSTIN');
    await dialog.getByTestId('merge-into').click();
    await expect(page.getByText(/Using Alpha Stores Pvt Ltd/)).toBeVisible();
    await expect(page.getByTestId('party-360')).toBeVisible();
    await expect(page.getByTestId('badge-parties')).toHaveText('51'); // nothing new was created

    await page.getByTestId('p360-back').click();
    await newParty(page, { name: 'Alpha Stores', phone: '9811111111', state: '27' });
    await page.getByTestId('party-save').click();
    await page.getByTestId('save-anyway').click();
    await expect(page.getByTestId('party-360')).toBeVisible();
    await expect(page.getByTestId('badge-parties')).toHaveText('52');
  });

  test('merges two parties from the list and can undo it', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    for (const [name, phone] of [
      ['Merge One', '9822222221'],
      ['Merge Two', '9822222222'],
    ] as const) {
      await newParty(page, { name, state: '27', phone, opening: '100' });
      await page.getByTestId('party-save').click();
      await page
        .getByTestId('save-anyway')
        .click({ timeout: 1500 })
        .catch(() => undefined);
      await expect(page.getByTestId('party-360')).toBeVisible();
      await page.getByTestId('p360-back').click();
    }
    await expect(page.getByTestId('badge-parties')).toHaveText('52');
    await page.getByTestId('party-search').fill('merge');
    await expect(page.getByTestId('party-row')).toHaveCount(2);
    await page.getByLabel('Select all').click();
    await page.getByTestId('bulk-merge').click();
    await expect(page.getByTestId('merge-dialog')).toBeVisible();
    await page.getByTestId('confirm-merge').click();
    await expect(page.getByText(/Merged Merge/)).toBeVisible();
    await expect(page.getByTestId('badge-parties')).toHaveText('51');
    await expect(page.getByTestId('party-row')).toHaveCount(1);
    await expect(page.getByTestId('party-row').getByRole('cell').nth(7)).toContainText('₹200.00'); // opening balances added

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Merge undone')).toBeVisible();
    await expect(page.getByTestId('badge-parties')).toHaveText('52');
    await expect(page.getByTestId('party-row')).toHaveCount(2);
  });

  test('tags the selected parties', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await page
      .getByLabel(/^Select /)
      .nth(1)
      .click();
    await page
      .getByLabel(/^Select /)
      .nth(2)
      .click();
    await page.getByTestId('bulk-tag').click();
    await page.getByTestId('tag-input').fill('priority');
    await page.getByTestId('tag-apply').click();
    await expect(page.getByText('Tagged 2 parties')).toBeVisible();
    await page.getByTestId('columns-menu').click();
    await page.getByTestId('col-tags').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('party-row').filter({ hasText: 'priority' })).toHaveCount(2);
  });
});

test.describe('Party 360', () => {
  async function openHeavy(page: Page) {
    await openSeeded(page, '/books/parties', { heavy: true });
    await page.getByTestId('party-search').fill('heavy');
    await expect(page.getByTestId('party-row')).toHaveCount(1);
  }

  test('renders a party with 200 documents in under 500 ms', async ({ page }) => {
    await openHeavy(page);
    // measure inside the page from the click until 200 ledger lines are on screen
    await page.evaluate(() => {
      const w = window as unknown as { __p360: number; __t0: number };
      document.addEventListener('click', () => (w.__t0 = performance.now()), {
        capture: true,
        once: true,
      });
      new MutationObserver((_m, obs) => {
        if (
          document.querySelector('[data-testid="party-360"]') &&
          document.querySelectorAll('[data-testid="ledger-line"]').length >= 200
        ) {
          w.__p360 = performance.now() - w.__t0;
          obs.disconnect();
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByTestId('party-open').first().click();
    await expect(page.getByTestId('ledger-line').nth(199)).toBeVisible();
    const ms = await page.evaluate(() => (window as unknown as { __p360: number }).__p360);
    console.log(`party 360 with 200+ documents rendered in ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(500);
  });

  test('header, ageing, ledger and list all agree on what is outstanding', async ({ page }) => {
    await openSeeded(page, '/books/parties', { heavy: true });
    await page.getByTestId('party-search').fill('heavy');
    const listBalance = rupees(
      await page.getByTestId('party-row').getByRole('cell').nth(7).textContent(),
    );
    await page.getByTestId('party-open').first().click();
    const header = rupees(
      await page
        .getByTestId('p360-outstanding')
        .locator('[data-testid="p360-outstanding-value"]')
        .textContent(),
    );
    expect(header).toBe(listBalance);
    const buckets = await Promise.all(
      ['current', 'd0_30', 'd31_60', 'd61_90', 'd90plus'].map(async (b) =>
        rupees(await page.getByTestId(`ageing-${b}`).locator('span').textContent()),
      ),
    );
    expect(Math.round(buckets.reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(header * 100));
    const closing = rupees(
      await page.getByTestId('ledger-closing').getByRole('cell').last().textContent(),
    );
    expect(closing).toBe(header);
    await expect(page.getByTestId('p360-overdue')).toContainText('₹');
  });

  test('ledger date range, CSV export and print', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
    });
    await openSeeded(page, '/books/parties', { heavy: true });
    await page.getByTestId('party-search').fill('heavy');
    await page.getByTestId('party-open').first().click();
    await expect(page.getByTestId('ledger-line').nth(199)).toBeVisible();
    const all = await page.getByTestId('ledger-line').count();
    expect(all).toBeGreaterThanOrEqual(200);

    await page.getByTestId('ledger-from').fill('2025-04-01');
    await page.getByTestId('ledger-to').fill('2025-06-30');
    await expect.poll(() => page.getByTestId('ledger-line').count()).toBeLessThan(all);
    await expect(page.getByTestId('ledger-brought-forward')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('statement-csv').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^statement-Heavy_Traders.*\.csv$/);
    const csv = (await readFile((await download.path())!, 'utf8')).replace(/^\uFEFF/, '');
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('Date,Type,Reference,Description,Debit,Credit,Balance');
    expect(rows[1]).toContain('Balance brought forward');
    expect(rows.length - 2).toBe(await page.getByTestId('ledger-line').count());
    expect(rows.every((r) => !/^[=+@]/.test(r))).toBe(true);

    await page.getByTestId('statement-print').click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(
      1,
    );
  });

  test('documents, payments, reminders and notes tabs', async ({ page }) => {
    await openSeeded(page, '/books/parties', { heavy: true });
    await page.getByTestId('party-search').fill('heavy');
    await page.getByTestId('party-open').first().click();

    await page.getByTestId('tab-documents').click();
    await expect(page.getByTestId('party-document').nth(199)).toBeVisible();
    expect(await page.getByTestId('party-document').count()).toBeGreaterThanOrEqual(200);
    await page.getByTestId('tab-payments').click();
    await expect(page.getByTestId('party-payment').first()).toBeVisible();

    await page.getByTestId('tab-reminders').click();
    await expect(page.getByTestId('reminder-message')).toContainText('Heavy Traders');
    await expect(page.getByTestId('remind-whatsapp')).toBeDisabled(); // the heavy party has no phone
    await page.getByTestId('remind-call').click();
    await expect(page.getByText('Reminder logged')).toBeVisible();
    await expect(page.getByTestId('reminder-history')).toContainText('call');

    await page.getByTestId('tab-notes').click();
    await page.getByTestId('notes-text').fill('Pays on the 10th');
    await page.getByTestId('notes-save').click();
    await expect(page.getByText('Saved').first()).toBeVisible();
    await page.reload();
    await page.getByTestId('tab-notes').click();
    await expect(page.getByTestId('notes-text')).toHaveValue('Pays on the 10th');
  });

  test('WhatsApp reminder opens the share link and logs it', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = (url) => {
        w.__opened.push(String(url));
        return null;
      };
    });
    await openSeeded(page, '/books/parties');
    await newParty(page, { name: 'Chatty Co', state: '27', phone: '98765 43210', opening: '1500' });
    await page.getByTestId('party-save').click();
    await page.getByTestId('tab-reminders').click();
    await page.getByTestId('remind-whatsapp').click();
    const urls = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe('https://wa.me/919876543210');
    expect(url.searchParams.get('text')).toBe(
      'Dear Chatty Co, ₹1,500.00 is outstanding with Demo Traders. Please pay at your earliest. Thank you.',
    );
    await expect(page.getByTestId('reminder-history')).toContainText('whatsapp');
  });

  test('quick actions go to the right places', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await page.getByTestId('party-open').first().click();
    const id = (await page.getByTestId('party-360').getAttribute('data-party-id'))!;
    await page.getByTestId('qa-invoice').click();
    await expect(page).toHaveURL(new RegExp(`/books/sell\\?party=${id}`));
    await page.goBack();
    await page.getByTestId('qa-receive').click();
    await expect(page).toHaveURL(/\/books\/payments\?intent=receive/);
    await page.goBack();
    await page.getByTestId('qa-upi').click();
    await expect(page.getByText('Add a UPI id in Settings')).toBeVisible();
  });

  test('copies a UPI payment link for the amount owed', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/welcome');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('GSTIN').fill(gstin());
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('Legal name').fill('Pay Shop');
    await page.getByLabel('Address').fill('1 Road');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('Add a bank or UPI account').click();
    await page.getByLabel('UPI', { exact: true }).click();
    await page.getByLabel('UPI id').fill('payshop@okhdfc');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('go-dashboard').click();
    await page.goto('/books/parties');
    await page.getByTestId('new-party').click();
    await page.getByTestId('party-name').fill('Debtor Co');
    await page.getByTestId('party-state').click();
    await page.getByRole('option', { name: /\(27\)/ }).click();
    await page.getByTestId('party-opening').fill('2500.50');
    await page.getByTestId('party-save').click();
    await page.getByTestId('qa-upi').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toBe(
      'upi://pay?pa=payshop%40okhdfc&pn=Pay%20Shop&am=2500.50&cu=INR&tn=Payment%20to%20Pay%20Shop',
    );
  });
});
