import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });
test.setTimeout(120_000);

test.describe('help', () => {
  test('F1 opens the article for the screen you are on, and search narrows the list', async ({
    page,
  }) => {
    await openSeeded(page, '/books/parties');
    await page.keyboard.press('F1');
    await expect(page.getByTestId('help-dialog')).toBeVisible();
    await expect(page.getByTestId('help-article')).toHaveAttribute('data-id', 'parties');

    await page.getByTestId('help-search').fill('backup');
    await expect(page.getByTestId('help-item-start')).toBeVisible();
    await expect(page.getByTestId('help-item-settings')).toBeVisible();
    await expect(page.getByTestId('help-item-parties')).toHaveCount(0);

    await page.getByTestId('help-search').fill('zzzzzz');
    await expect(page.getByTestId('help-none')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-dialog')).toBeHidden();
  });

  test('the help menu opens this screen’s help and the Getting started guide', async ({ page }) => {
    await openSeeded(page, '/books/inbox');
    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByTestId('help-this-screen').click();
    await expect(page.getByTestId('help-article')).toHaveAttribute('data-id', 'inbox');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByTestId('help-getting-started').click();
    await expect(page.getByTestId('help-article')).toHaveAttribute('data-id', 'start');
    await expect(page.getByTestId('help-article').getByRole('listitem')).toHaveCount(6);
  });

  test('Getting started is there in all six languages, and says when it is a draft', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    for (const [code, word] of [
      ['hi', 'शुरुआत'],
      ['mr', 'सुरुवात'],
      ['ta', 'தொடங்குவது'],
      ['bn', 'শুরু'],
      ['gu', 'શરૂઆત'],
    ] as const) {
      await page.goto(`/books/dashboard?lng=${code}`);
      await expect(page.locator('html')).toHaveAttribute('lang', code);
      // the shortcuts are live once the app has drawn its navigation
      await expect(page.getByTestId('nav-dashboard')).toBeVisible();
      await page.keyboard.press('F1');
      await page.getByTestId('help-item-start').click();
      await expect(page.getByTestId('help-article')).toContainText(word);
      await expect(page.getByTestId('help-article').getByRole('listitem')).toHaveCount(6);
      await expect(page.getByTestId('help-draft-note')).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('privacy and usage counters', () => {
  test('nothing is counted or stored until the person opts in, and turning it off forgets it all', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    // ordinary use with the switch off leaves nothing behind
    await page.keyboard.press('F1');
    await expect(page.getByTestId('help-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    const stored = () => page.evaluate(() => localStorage.getItem('gst.telemetry.state'));
    expect(await stored()).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('gst.telemetry.on'))).toBeNull();

    await page.goto('/books/settings?tab=privacy');
    await expect(page.getByTestId('telemetry-switch')).not.toBeChecked();
    await expect(page.getByTestId('telemetry-state')).toContainText('Nothing is counted');
    await expect(page.getByTestId('telemetry-payload')).toHaveCount(0);

    await page.getByTestId('telemetry-switch').click();
    await expect(page.getByTestId('telemetry-payload')).toBeVisible();
    // the build has no address, and the screen says so
    await expect(page.getByTestId('telemetry-state')).toContainText('no address');

    // use a feature: it is counted by name, and the payload holds nothing else
    await page.keyboard.press('F1');
    await page.keyboard.press('Escape');
    const payload = JSON.parse(await page.getByTestId('telemetry-payload').innerText()) as {
      counts: Record<string, number>;
      installId: string;
    };
    expect(payload.counts['help_opened']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(payload).sort()).toEqual([
      'appVersion',
      'counts',
      'installId',
      'platform',
      'v',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/Sharma|GSTIN|@|\d{10}/);

    await page.getByTestId('telemetry-switch').click();
    await expect(page.getByTestId('telemetry-payload')).toHaveCount(0);
    expect(await stored()).toBeNull();
  });

  test('your data can be deleted from the Privacy tab', async ({ page }) => {
    await openSeeded(page, '/books/settings?tab=privacy');
    await page.getByTestId('delete-all').click();
    await expect(page.getByTestId('delete-all-dialog')).toBeVisible();
    await page.getByTestId('delete-all-confirm').click();
    // everything is gone: the app starts again from its welcome screen
    await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
  });
});
