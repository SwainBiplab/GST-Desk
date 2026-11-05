/**
 * `test` for the end-to-end specs. It is Playwright's own, with one addition: when `COVERAGE=1` (and the
 * app was built instrumented, `pnpm e2e:coverage`), every page's `window.__coverage__` is written to
 * `.nyc_output` after each test, so `nyc` can report how much of `src/features` the suite really runs.
 * Without `COVERAGE` it changes nothing.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test as base, expect } from '@playwright/test';

export * from '@playwright/test';
export { expect };

const OUT = join(import.meta.dirname, '..', '.nyc_output');

export const test = base.extend<{ collect: undefined }>({
  collect: [
    async ({ context }, use) => {
      await use(undefined);
      if (process.env['COVERAGE'] !== '1') return;
      mkdirSync(OUT, { recursive: true });
      for (const page of context.pages()) {
        try {
          const cov = await page.evaluate(
            () => (window as unknown as { __coverage__?: unknown }).__coverage__,
          );
          if (cov) writeFileSync(join(OUT, `${randomUUID()}.json`), JSON.stringify(cov));
        } catch {
          // a page that is closed or never loaded the app has nothing to report
        }
      }
    },
    { auto: true },
  ],
});
