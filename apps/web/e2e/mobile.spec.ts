import { expect, test, type Page } from './fixtures';

/**
 * Prompt 43. The phone layout in a browser at phone size (`?mobile=1`): the same screens the phone app
 * shows, without the native plugins (camera, barcode, printer), which the device matrix covers on an
 * emulator. The bill flow here is the one Maestro drives on the phone.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.setTimeout(120_000);

async function openMobile(page: Page, path = '/shop/dashboard') {
  const join = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${join}demo=1&mobile=1`);
  await expect(page.getByTestId('mobile-layout')).toBeVisible();
  // the demo business is seeded before the first screen means anything
  await expect(page.getByTestId('mobile-business')).not.toHaveText('No business yet', {
    timeout: 30_000,
  });
}

/** Drag a row to the left far enough for its first action to run (`SWIPE_COMMIT_PX`). */
async function swipeLeft(page: Page, row: ReturnType<Page['getByTestId']>) {
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 20, y);
  await page.mouse.down();
  for (let x = box.x + box.width - 20; x > box.x + 20; x -= 40) await page.mouse.move(x, y);
  await page.mouse.up();
}

test.describe('the phone layout', () => {
  test('has the five tabs, lands on Home, and sends Books addresses to the phone layout', async ({
    page,
  }) => {
    await openMobile(page);
    for (const tab of ['home', 'bill', 'parties', 'inbox', 'more'])
      await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('mobile-business')).not.toBeEmpty();
    await expect(page.getByTestId('home-doc').first()).toBeVisible();
    await expect(page.getByTestId('home-sales')).not.toContainText('—');

    await page.getByTestId('tab-more').click();
    await expect(page.getByTestId('mobile-more')).toBeVisible();
    await expect(page.getByTestId('more-account-state')).toContainText('Not signed in');

    await page.goto('/books/parties?mobile=1');
    await expect(page).toHaveURL(/\/shop\/parties/);
    await expect(page.getByTestId('mobile-layout')).toBeVisible();
  });

  test('bills with one hand: customer, items, stepper, issue, then share and UPI on the done screen', async ({
    page,
  }) => {
    await openMobile(page);
    await page.getByTestId('home-new-bill').click();
    await expect(page.getByTestId('bill-editor')).toBeVisible();
    await expect(page.getByTestId('bill-issue')).toBeDisabled();

    await page.getByTestId('bill-party').click();
    const partySheet = page.getByTestId('party-sheet');
    await expect(partySheet).toBeVisible();
    await expect(page.getByTestId('party-sheet-row').first()).toBeVisible();
    await page.getByTestId('party-sheet-search').fill('Sharma');
    await page.getByTestId('party-sheet-row').first().click();
    await expect(partySheet).toBeHidden();
    await expect(page.getByTestId('bill-party')).toContainText('Sharma');

    await page.getByTestId('bill-add-item').click();
    await expect(page.getByTestId('item-sheet')).toBeVisible();
    // favourites come first, without typing
    await expect(page.getByTestId('item-sheet-row').first()).toBeVisible();
    await page.getByTestId('item-sheet-row').first().click();
    await expect(page.getByTestId('bill-line')).toHaveCount(1);
    await expect(page.getByTestId('line-qty')).toHaveText('1');
    await page.getByTestId('line-plus').click();
    await page.getByTestId('line-plus').click();
    await expect(page.getByTestId('line-qty')).toHaveText('3');
    await page.getByTestId('line-minus').click();
    await expect(page.getByTestId('line-qty')).toHaveText('2');
    const total = await page.getByTestId('bill-sticky-total').textContent();
    expect(total).not.toBe('₹0.00');

    // a second item, typed, then removed by its swipe action
    await page.getByTestId('bill-add-item').click();
    await page.getByTestId('item-sheet-search').fill('zzz-no-such-item');
    await page.getByTestId('item-sheet-text').click();
    await expect(page.getByTestId('bill-line')).toHaveCount(2);
    await swipeLeft(page, page.getByTestId('bill-line').last());
    await expect(page.getByTestId('bill-line')).toHaveCount(1);

    await page.getByTestId('bill-issue').click();
    await expect(page.getByTestId('bill-done')).toBeVisible();
    await expect(page.getByTestId('bill-number')).not.toBeEmpty();
    await expect(page.getByTestId('bill-share')).toBeEnabled();
    // the demo business has no UPI id, so the QR gives way to the hint
    await expect(page.getByTestId('bill-no-upi')).toBeVisible();

    await page.getByTestId('bill-new').click();
    await expect(page.getByTestId('bill-editor')).toBeVisible();
    await expect(page.getByTestId('bill-line')).toHaveCount(0);
  });

  test('the account screen asks for a phone number, and a new customer comes from the sheet', async ({
    page,
  }) => {
    await openMobile(page);
    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-open-account').click();
    await expect(page.getByTestId('account-screen')).toBeVisible();
    await expect(page.getByTestId('account-phone')).toBeVisible();
    await expect(page.getByTestId('account-send-code')).toBeDisabled();
    await page.getByTestId('account-phone').fill('+919876543210');
    await expect(page.getByTestId('account-send-code')).toBeEnabled();

    await page.getByTestId('tab-bill').click();
    await expect(page.getByTestId('bill-editor')).toBeVisible();
    await page.getByTestId('bill-party').click();
    await page.getByTestId('party-sheet-search').fill('Nobody Here');
    await expect(page.getByTestId('party-sheet-none')).toBeVisible();
    await page.getByTestId('party-sheet-create').click();
    await expect(page.getByTestId('party-new-name')).toHaveValue('Nobody Here');
    await page.getByTestId('party-new-phone').fill('9876543210');
    await page.getByTestId('party-new-save').click();
    await expect(page.getByTestId('bill-party')).toContainText('Nobody Here');
  });

  test('Home scans a bill from a file into the inbox', async ({ page }) => {
    await openMobile(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('home-scan').click();
    const fc = await chooser;
    await fc.setFiles({
      name: 'bill.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    // demo mode answers with its sample bill: the card lands in the inbox and the app goes there
    await expect(page).toHaveURL(/\/shop\/inbox/, { timeout: 60_000 });
    await expect(page.getByTestId('inbox')).toBeVisible();
  });
});
