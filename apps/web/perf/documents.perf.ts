import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import budgets from './budgets.json' with { type: 'json' };

/**
 * Prompt 14 budgets, with 200 lines in the editor: a keystroke in a form field is handled (event, reprice,
 * render) within a frame (16 ms), the preview follows within 300 ms. The engine's own time is asserted in the domain tests.
 */
const B = budgets.documents;
const results: Record<string, number | boolean> = {};

test.afterAll(() => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'web-documents.json'),
    JSON.stringify(
      { suite: 'web-documents', at: new Date().toISOString(), budget: B, results },
      null,
      2,
    ),
  );
});

const rows = () =>
  Array.from(
    { length: B.lines },
    (_, i) => `Line item ${i + 1}\t7318\t${(i % 9) + 1}\tNOS\t${100 + i}.50\t\t\t\t18`,
  ).join('\n');

async function paste200(page: Page) {
  await page.evaluate((text) => navigator.clipboard.writeText(text), rows());
  const frame = (await page.getByTestId('grid-frame').boundingBox())!;
  await page.mouse.click(frame.x + 150, frame.y + 50);
  await page.keyboard.press('Control+v');
  await expect(page.getByTestId('preview-line')).toHaveCount(B.lines, { timeout: 30_000 });
}

/**
 * Time the page spends on one keystroke: from the `input` event (before React sees it) to the next task,
 * which runs once React has handled the change, repriced every line and committed. Paint comes after.
 */
async function keystrokeTimes(page: Page, testId: string, text: string): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __ks: number[] };
    w.__ks = [];
    document.addEventListener(
      'input',
      () => {
        const t0 = performance.now();
        setTimeout(() => w.__ks.push(performance.now() - t0), 0);
      },
      true,
    );
  });
  await page.getByTestId(testId).click();
  for (const ch of text) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  return page.evaluate(() => (window as unknown as { __ks: number[] }).__ks);
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;

test(`with ${B.lines} lines a keystroke is handled within a frame and the preview follows in ${B.previewMs} ms`, async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/books/documents/new?type=tax_invoice&demo=1');
  await expect(page.getByTestId('badge-documents')).toHaveText('500', { timeout: 30_000 });
  await expect(page.getByTestId('line-grid')).toBeVisible();
  await paste200(page);
  await expect(page.getByTestId('doc-total')).not.toHaveText('₹0.00');

  // a keystroke in the PO number field: a draft change that reprices all 200 lines
  // enough keystrokes for a 95th percentile to be one: with 14 samples it is just the slowest one
  const times = await keystrokeTimes(page, 'doc-ref-po', 'PO-12345-ABCDE'.repeat(4));
  results['keystrokeP95Ms'] = Math.round(p95(times));
  results['keystrokeMedianMs'] = Math.round(
    [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0,
  );
  results['keystrokes'] = times.length;
  expect(times.length).toBeGreaterThan(50);
  // the target is `keystrokeP95Ms` (one frame); `keystrokeP95HardMs` is the line a run must not cross while the
  // time-boxed exception in docs/decisions/0015-phase-1-performance-budgets.md is open
  results['keystrokeP95MeetsBudget'] = p95(times) <= B.keystrokeP95Ms;
  expect(p95(times), 'p95 key to frame (hard line)').toBeLessThanOrEqual(B.keystrokeP95HardMs);

  // the same keystrokes on the baseline device (4x slower CPU), recorded for the baseline document
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: budgets.cpuThrottle });
  const slow = await keystrokeTimes(page, 'doc-ref-challan', 'CH-12345-ABCDE'.repeat(4));
  results['keystrokeP95At4xMs'] = Math.round(p95(slow));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  // a change that alters the totals: how long until the preview shows the new total
  await page.getByTestId('doc-inv-discount-mode').click();
  await page.getByRole('option', { name: 'Percent' }).click();
  const before = (await page.getByTestId('preview-total').textContent()) ?? '';
  const t0 = Date.now();
  await page.getByTestId('doc-inv-discount').fill('10');
  await expect(page.getByTestId('preview-total')).not.toHaveText(before, { timeout: 5000 });
  const previewMs = Date.now() - t0;
  results['previewMs'] = previewMs;
  expect(previewMs, 'preview after a change').toBeLessThanOrEqual(B.previewMs);
});
