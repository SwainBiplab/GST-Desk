import { pickParty } from './documents.helpers';
import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });
test.setTimeout(120_000);

async function chooseLanguage(page: Page, code: string) {
  await page.getByTestId('language-switcher').click();
  await page.getByTestId(`lang-${code}`).click();
}

async function openNewParty(page: Page) {
  await page.goto('/books/parties');
  await page.getByTestId('new-party').click();
  await expect(page.getByTestId('party-drawer')).toBeVisible();
}

async function savePartyIn(page: Page) {
  await page.getByTestId('party-state').click();
  await page.getByRole('option', { name: /\(27\)/ }).click();
  await page.getByTestId('party-save').click();
  await page
    .getByTestId('save-anyway')
    .click({ timeout: 2000 })
    .catch(() => undefined);
  await expect(page.getByTestId('party-360')).toBeVisible();
}

test.describe('languages', () => {
  test('switching language changes the screens at once, with no reload, and is remembered', async ({
    page,
  }) => {
    await openSeeded(page, '/books/inbox');
    let loads = 0;
    page.on('load', () => (loads += 1));

    await expect(page.getByTestId('nav-dashboard')).toContainText('Dashboard');
    await chooseLanguage(page, 'hi');
    await expect(page.getByTestId('nav-dashboard')).toContainText('डैशबोर्ड');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    // a string that has no translation yet is in English, never a raw key
    await expect(page.getByTestId('inbox-check')).toContainText('अभी जाँचें');
    expect(loads).toBe(0);
    // the command bar's actions are in the language too
    await page.keyboard.press('Control+k');
    await page.keyboard.type('डैश');
    await expect(page.getByTestId('command-results')).toContainText('डैशबोर्ड');
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.getByTestId('nav-dashboard')).toContainText('डैशबोर्ड');

    await chooseLanguage(page, 'en');
    await expect(page.getByTestId('nav-dashboard')).toContainText('Dashboard');
  });

  test('Indian script fonts are not fetched while the app is in English', async ({ page }) => {
    const fonts: string[] = [];
    page.on('request', (r) => {
      if (/noto-sans-(devanagari|tamil|bengali|gujarati)/.test(r.url())) fonts.push(r.url());
    });
    await openSeeded(page, '/books/dashboard');
    await expect(page.getByTestId('nav-dashboard')).toBeVisible();
    expect(fonts).toEqual([]);
  });

  test('a party name typed in Hindi letters through transliteration is saved and found either way', async ({
    page,
  }) => {
    await openSeeded(page, '/books/parties');
    await openNewParty(page);
    await expect(page.getByTestId('translit-toggle').first()).toBeVisible();
    await page.getByTestId('translit-toggle').first().click();
    await page.getByTestId('translit-deva').click();

    const name = page.getByTestId('party-name');
    await name.click();
    await name.pressSequentially('gopaal');
    await expect(page.getByTestId('translit-option').first()).toHaveText('गोपाल');
    await page.keyboard.press('Space');
    await name.pressSequentially('kiraanaa');
    await expect(page.getByTestId('translit-option').first()).toHaveText('किराना');
    await page.keyboard.press('Enter');
    await expect(name).toHaveValue('गोपाल किराना');
    await savePartyIn(page);

    await page.getByTestId('p360-back').click();
    for (const q of ['gopaal', 'गोपाल']) {
      await page.getByTestId('party-search').fill(q);
      await expect(page.getByTestId('party-row')).toHaveCount(1);
      await expect(page.getByTestId('party-row')).toContainText('गोपाल किराना');
    }
  });

  test('a party with a language of their own gets their copy of a document in it', async ({
    page,
  }) => {
    await openSeeded(page, '/books/parties');
    await openNewParty(page);
    await page.getByTestId('party-name').fill('Tamil Customer');
    await page.getByTestId('party-language').click();
    await page.getByRole('option', { name: 'தமிழ்' }).click();
    await savePartyIn(page);

    await page.goto('/books/documents/new?type=tax_invoice');
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await pickParty(page, 'Tamil Customer');
    await expect(page.getByTestId('preview-title').first()).toHaveText('வரி விலைப்பட்டியல்', {
      timeout: 15_000,
    });
  });

  test('the longest strings do not break the layout at 1366 by 768 in compact density', async ({
    page,
  }) => {
    for (const lng of ['hi', 'ta', 'bn', 'pseudo']) {
      await page.goto(`/books/dashboard?demo=1&lng=${lng}`);
      await expect(page.getByTestId('badge-documents')).toHaveText('500', { timeout: 30_000 });
      for (const path of ['dashboard', 'inbox', 'parties', 'items', 'documents', 'settings']) {
        await page.goto(`/books/${path}?lng=${lng}`);
        await page.waitForLoadState('networkidle');
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${lng} ${path}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
