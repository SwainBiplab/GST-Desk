import {
  buildDocument,
  emptyDraft,
  emptyDraftLine,
  parseAmountPaise,
  parseQtyMicros,
  type DocumentType,
} from '@gst/domain';
import { expect, type Page } from '@playwright/test';

import { openSeeded } from './helpers';

/** Open the editor on a new document with the demo business loaded. */
export async function openEditor(
  page: Page,
  type: DocumentType | string = 'tax_invoice',
  extra = '',
) {
  await openSeeded(page, `/books/documents/new?type=${type}${extra}`);
  await expect(page.getByTestId('doc-editor')).toBeVisible();
  // the demo parties and items are loaded before the first search can find them
  await expect(page.getByTestId('line-grid')).toBeVisible();
}

/** Choose the first party the list offers (or the one matching `query`), by keyboard. */
export async function pickParty(page: Page, query = '') {
  const input = page.getByTestId('doc-party');
  await input.click();
  if (query) await input.fill(query);
  await expect(page.getByTestId('party-result').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('party-results')).toBeHidden();
}

const rowHeight = (page: Page) =>
  page.evaluate(
    () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) * 16,
  );

/** Put the cursor on the item cell of a grid row with a click (the first move; the rest is keyboard). */
export async function clickItemCell(page: Page, row = 0) {
  // the grid can still be moving (a list of problems above it appears, a panel opens): click once it is still
  let frame = (await page.getByTestId('grid-frame').boundingBox())!;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(60);
    const next = (await page.getByTestId('grid-frame').boundingBox())!;
    const still = next.x === frame.x && next.y === frame.y && next.height === frame.height;
    frame = next;
    if (still) break;
  }
  const h = await rowHeight(page);
  await page.mouse.click(frame.x + 150, frame.y + 36 + h * row + h / 2);
}

/**
 * Enter opens the item picker; type to search, Tab to the quantity, type it, Enter. The cursor then
 * waits on the next line's item cell.
 */
export async function keyLine(page: Page, query: string, qty = '1', opened = false) {
  if (!opened) await page.keyboard.press('Enter');
  await expect(page.getByTestId('item-picker-input')).toBeVisible();
  await page.keyboard.type(query);
  await expect(page.getByTestId('item-result').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('item-picker-qty')).toBeFocused();
  await page.keyboard.type(qty);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('item-picker')).toBeHidden();
  await page.waitForTimeout(60); // the cursor settles on the next line
}

/** Add a line (starting from a click on the first free item cell). */
export async function addLine(page: Page, row: number, query: string, qty = '1') {
  // a click that lands while the layout is still moving can miss the cell: click again, as a person would
  const picker = page.getByTestId('item-picker-input');
  for (let attempt = 0; attempt < 4; attempt++) {
    await clickItemCell(page, row);
    await page.keyboard.press('Enter');
    const open = await picker
      .waitFor({ state: 'visible', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (open) break;
  }
  await keyLine(page, query, qty, true);
}

const text = (page: Page, id: string) => page.getByTestId(id).innerText();
const paise = (s: string) => BigInt(parseAmountPaise(s.replace(/[₹\s]/g, '')) ?? 0);

/**
 * What the engine says the total should be, recomputed from the lines the preview shows and the place
 * of supply on the form. Independent of the editor's own numbers.
 */
/** The preview follows the form 150 ms after the last change: wait until it shows the form's total. */
export async function settlePreview(page: Page) {
  await expect
    .poll(async () => (await text(page, 'preview-total')).replace(/\s/g, ''))
    .toBe((await text(page, 'doc-total')).replace(/\s/g, ''));
}

export async function engineTotalFromPreview(
  page: Page,
  type: DocumentType = 'tax_invoice',
): Promise<bigint> {
  await settlePreview(page);
  const pos = /\((\d+)\)/.exec(await text(page, 'doc-pos'))?.[1] ?? '27';
  const rows = page.getByTestId('preview-line');
  const n = await rows.count();
  const draft = emptyDraft(type, new Date().toISOString().slice(0, 10), { supplierState: '27' });
  draft.placeOfSupply = pos;
  draft.lines = [];
  for (let i = 0; i < n; i++) {
    const cells = await rows.nth(i).locator('td').allInnerTexts();
    const qty = parseQtyMicros(cells[3]!.split(' ')[0]!) ?? 0;
    draft.lines.push({
      ...emptyDraftLine(`e${i}`),
      description: cells[1]!,
      qtyMicros: BigInt(qty),
      ratePaise: paise(cells[4]!),
      gstRateBp: Math.round(parseFloat(cells[6]!.replace('%', '')) * 100),
    });
  }
  return buildDocument(draft).totals.totalPaise;
}

export async function uiTotal(page: Page): Promise<bigint> {
  return paise(await text(page, 'doc-total'));
}
