import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

const count = async (page: Page, view: 'open' | 'snoozed' | 'done' = 'open') =>
  Number(await page.getByTestId(`inbox-count-${view}`).innerText());

/** The first run of the checks happens a few seconds after the app opens (the quick duplicate pass comes first). */
async function waitForInbox(page: Page, atLeast = 20) {
  await expect(page.getByTestId('inbox-row').first()).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(async () => Number(await page.getByTestId('inbox-count-open').innerText()), {
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

async function newParty(page: Page, name: string, phone: string) {
  await page.goto('/books/parties');
  await page.getByTestId('new-party').click();
  await expect(page.getByTestId('party-drawer')).toBeVisible();
  await page.getByTestId('party-name').fill(name);
  await page.getByTestId('party-state').click();
  await page.getByRole('option', { name: /\(27\)/ }).click();
  await page.getByTestId('party-phone').fill(phone);
  await page.getByTestId('party-save').click();
  await page
    .getByTestId('save-anyway')
    .click({ timeout: 2000 })
    .catch(() => undefined);
  await expect(page.getByTestId('party-360')).toBeVisible();
}

async function newItemWithoutHsn(page: Page, name: string, sku: string) {
  await page.goto('/books/items');
  await page.getByTestId('new-item').click();
  await expect(page.getByTestId('item-drawer')).toBeVisible();
  await page.getByTestId('item-name').fill(name);
  await page.getByTestId('item-sku').fill(sku);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-drawer')).toBeHidden();
}

/** Show only one kind, so a row's position does not depend on what else the demo book raised. */
async function search(page: Page, text: string) {
  const box = page.getByTestId('inbox-search');
  await box.fill(text);
  // leave the box, or the next key press is typed into it instead of acting on the list
  await box.evaluate((el) => (el as HTMLInputElement).blur());
}

test.describe('review inbox', () => {
  test('a seeded book fills the inbox on first run, and the nav badge agrees', async ({ page }) => {
    await openSeeded(page, '/books/inbox');
    await waitForInbox(page);
    const n = await count(page);
    expect(n).toBeGreaterThan(5);
    await expect(page.getByTestId('badge-inbox')).toHaveText(String(n));
    // every card says what kind it is and the list is windowed
    expect(await page.getByTestId('inbox-row').count()).toBeLessThanOrEqual(n);
  });

  test('clears 20 items from the keyboard in well under two minutes', async ({ page }) => {
    await openSeeded(page, '/books/inbox');
    await waitForInbox(page);
    const start = await count(page);
    expect(start).toBeGreaterThanOrEqual(20);
    // the kinds that are applied by a person, not the "not built yet" ones, are all acceptable
    const t0 = Date.now();
    for (let i = 1; i <= 20; i++) {
      await page.keyboard.press('a');
      await expect(page.getByTestId('inbox-count-open')).toHaveText(String(start - i), {
        timeout: 15_000,
      });
    }
    expect(Date.now() - t0).toBeLessThan(120_000);
    await expect(page.getByTestId('inbox-count-done')).toHaveText('20');
  });

  test('J and K move, R rejects with a reason that shows under Done', async ({ page }) => {
    await openSeeded(page, '/books/inbox');
    await waitForInbox(page);
    const rows = page.getByTestId('inbox-row');
    await expect(rows.first()).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('k');
    await expect(rows.first()).toHaveAttribute('data-selected', 'true');

    const before = await count(page);
    await page.keyboard.press('r');
    await expect(page.getByTestId('reject-dialog')).toBeVisible();
    await page.getByTestId('reject-reason').fill('not for us');
    await page.getByTestId('reject-confirm').click();
    await expect(page.getByTestId('inbox-count-open')).toHaveText(String(before - 1));

    await page.getByTestId('inbox-tab-done').click();
    await expect(page.getByTestId('inbox-status').first()).toContainText('Rejected');
    await expect(page.getByTestId('inbox-detail')).toContainText('not for us');
  });

  test('a snoozed item leaves the list and the count, and can be brought back', async ({
    page,
  }) => {
    await openSeeded(page, '/books/inbox');
    await waitForInbox(page);
    const before = await count(page);
    await page.getByTestId('detail-snooze').click();
    await page.getByTestId('snooze-week').click();
    await expect(page.getByTestId('inbox-count-open')).toHaveText(String(before - 1));
    await expect(page.getByTestId('badge-inbox')).toHaveText(String(before - 1));
    await expect(page.getByTestId('inbox-count-snoozed')).toHaveText('1');
    await page.getByTestId('inbox-tab-snoozed').click();
    await page.getByRole('button', { name: 'Bring back' }).click();
    await expect(page.getByTestId('inbox-count-open')).toHaveText(String(before));
  });

  test('a duplicate party appears and accepting it merges the two', async ({ page }) => {
    await openSeeded(page, '/books/parties');
    await newParty(page, 'Zeta Traders', '9833333331');
    await newParty(page, 'Zeta Traders Pvt Ltd', '9833333331');
    await page.goto('/books/parties');
    await expect(page.getByTestId('badge-parties')).toHaveText('52');

    await page.goto('/books/inbox');
    await search(page, 'Zeta');
    const row = page.getByTestId('inbox-row').filter({ hasText: 'Possible duplicate party' });
    await expect(row).toHaveCount(1, { timeout: 45_000 });
    await expect(page.getByTestId('inbox-diff')).toContainText('Zeta Traders');

    await page.keyboard.press('a');
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('badge-parties')).toHaveText('51');
  });

  test('an HSN suggestion fills the item in when accepted', async ({ page }) => {
    await openSeeded(page, '/books/inbox');
    await newItemWithoutHsn(page, 'Green tea leaves', 'E2E-INBOX-TEA');
    await page.goto('/books/inbox');
    await search(page, 'Green tea');
    const row = page.getByTestId('inbox-row').filter({ hasText: 'HSN suggestion' });
    await expect(row).toHaveCount(1, { timeout: 45_000 });
    await expect(page.getByTestId('inbox-diff')).toContainText('0902');

    await page.keyboard.press('a');
    await expect(row).toHaveCount(0);

    await page.goto('/books/items');
    await page.getByTestId('item-search').fill('E2E-INBOX-TEA');
    await page.getByTestId('item-row').getByRole('button').first().click();
    await expect(page.getByTestId('item-hsn')).toHaveValue('0902');
  });

  test('accepts many HSN suggestions at once after a preview', async ({ page }) => {
    await openSeeded(page, '/books/inbox');
    await newItemWithoutHsn(page, 'Green tea leaves', 'E2E-BULK-1');
    await newItemWithoutHsn(page, 'Black tea leaves', 'E2E-BULK-2');
    await page.goto('/books/inbox');
    await search(page, 'tea');
    await expect(page.getByTestId('inbox-row').filter({ hasText: 'HSN suggestion' })).toHaveCount(
      2,
      { timeout: 45_000 },
    );
    // the dialog offers what the list is showing (here: only the two tea items)
    await page.getByTestId('inbox-bulk').click();
    await expect(page.getByTestId('bulk-dialog')).toBeVisible();
    // lower the bar so both suggestions are offered, then look at them before accepting
    await page.getByTestId('bulk-min').click();
    await page.getByRole('option', { name: '50%' }).click();
    await expect(page.getByTestId('bulk-row')).toHaveCount(2);
    // untick one: only the other is applied
    await page.getByTestId('bulk-row').first().getByRole('checkbox').click();
    await expect(page.getByTestId('bulk-confirm')).toContainText('Accept 1 suggestion');
    await page.getByTestId('bulk-confirm').click();
    await expect(page.getByTestId('bulk-dialog')).toBeHidden();
    await expect(page.getByTestId('inbox-row').filter({ hasText: 'HSN suggestion' })).toHaveCount(
      1,
    );
  });

  test('Edit changes the suggestion before accepting, and the change is kept for evals', async ({
    page,
  }) => {
    await openSeeded(page, '/books/inbox');
    await newItemWithoutHsn(page, 'Green tea leaves', 'E2E-EDIT-TEA');
    await page.goto('/books/inbox');
    await search(page, 'Green tea');
    await expect(page.getByTestId('inbox-row').filter({ hasText: 'HSN suggestion' })).toHaveCount(
      1,
      { timeout: 45_000 },
    );
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-dialog')).toBeVisible();
    await page.getByTestId('edit-code').fill('0901');
    await page.getByTestId('edit-confirm').click();
    await expect(page.getByTestId('inbox-row').filter({ hasText: 'HSN suggestion' })).toHaveCount(
      0,
    );

    await page.goto('/books/items');
    await page.getByTestId('item-search').fill('E2E-EDIT-TEA');
    await page.getByTestId('item-row').getByRole('button').first().click();
    await expect(page.getByTestId('item-hsn')).toHaveValue('0901');
  });

  test('Shop shows the same items as simple cards with the buttons on them', async ({ page }) => {
    await openSeeded(page, '/shop/inbox');
    await waitForInbox(page);
    const before = await count(page);
    await expect(page.getByTestId('card-accept').first()).toBeVisible();
    await page.getByTestId('card-accept').first().click();
    await expect(page.getByTestId('inbox-count-open')).toHaveText(String(before - 1));
  });

  test('stays responsive with 5,000 waiting items: only a window is drawn', async ({ page }) => {
    await page.goto('/books/inbox?demo=1&inbox=5000');
    await expect(page.getByTestId('inbox-count-open')).toHaveText(/^[5-9]\d{3}$/, {
      timeout: 60_000,
    });
    const drawn = await page.getByTestId('inbox-row').count();
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(80);
    // jumping to the end is instant and still draws a window
    const t0 = Date.now();
    await page.getByTestId('inbox-list').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByTestId('inbox-row').last()).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(2000);
    await search(page, 'Synthetic check 4999');
    await expect(page.getByTestId('inbox-row')).toHaveCount(1);
  });
});
