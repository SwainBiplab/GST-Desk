import { deflateSync } from 'node:zlib';

import { gstinCheckChar } from '@gst/domain';
import { expect, type Page } from '@playwright/test';

/** Open a path with the deterministic demo business loaded (500 documents) and wait for the counts. */
export async function openSeeded(page: Page, path = '/books/dashboard') {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}demo=1`);
  await expect(page.getByTestId('badge-documents')).toHaveText('500', { timeout: 30_000 });
}

export async function openCommandBar(page: Page) {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-input')).toBeFocused();
}

/** A GSTIN with a correct check character, for the given state and PAN. */
export function gstin(state = '27', pan = 'AAPFU0939F') {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
}

/** A solid-colour PNG of any size, built without dependencies. */
export function png(width: number, height: number): Buffer {
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) row.set([15, 118, 110, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Press Tab until the element with this test id has focus (keyboard-only navigation). */
export async function tabTo(page: Page, testId: string, max = 20) {
  for (let i = 0; i < max; i++) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    if (focused === testId) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`could not reach ${testId} with the keyboard`);
}

export interface WizardOptions {
  name?: string;
  gstin?: string | null;
  preset?: string;
  composition?: boolean;
  state?: string;
}

/** Click through the wizard from the welcome screen to the "all set" step. Returns the number of UI actions. */
export async function runWizard(page: Page, o: WizardOptions = {}): Promise<number> {
  let actions = 0;
  const click = async (testId: string) => {
    await page.getByTestId(testId).click();
    actions++;
  };
  await expect(page.getByTestId('wizard')).toBeVisible();
  if ((await page.getByTestId('wizard').getAttribute('data-step')) === 'language') {
    await click('wizard-next');
    await click('wizard-next'); // start from scratch is the default
  }
  if (o.gstin === null) {
    await page.getByLabel('I am not registered for GST yet').click();
    actions++;
    await page.getByTestId('state-select').click();
    await page.getByRole('option', { name: new RegExp(`\\(${o.state ?? '29'}\\)`) }).click();
    actions += 2;
  } else {
    await page.getByLabel('GSTIN').fill(o.gstin ?? gstin());
    actions++;
    if (o.composition) {
      await page.getByLabel('Composition scheme').click();
      actions++;
    }
  }
  await click('wizard-next');
  await page.getByLabel('Legal name').fill(o.name ?? 'Demo Traders');
  await page.getByLabel('Address').fill('12 Market Road');
  actions += 2;
  await click('wizard-next');
  if (o.preset) {
    await page.getByLabel(new RegExp(o.preset, 'i')).first().click();
    actions++;
  }
  await click('wizard-next');
  await click('wizard-skip');
  await expect(page.getByTestId('wizard')).toHaveAttribute('data-step', 'done');
  return actions;
}
