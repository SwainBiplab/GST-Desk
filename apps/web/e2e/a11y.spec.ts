/**
 * Accessibility audit with axe: every route, in both shells, in the light and the dark theme, with the
 * demo business loaded so the screens hold real rows. A serious or critical violation fails the test;
 * every report (including the minor ones) is written to `a11y-reports/` and archived by CI.
 *
 * Run it on its own: `pnpm --filter web e2e e2e/a11y.spec.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';

import { expect, test, type Page } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 768 } });
test.setTimeout(300_000);

const OUT = join(import.meta.dirname, '..', 'a11y-reports');

/** Every screen a person can reach from the navigation, plus the settings tabs and the editor. */
const ROUTES: Record<'shop' | 'books', string[]> = {
  shop: [
    'dashboard',
    'sell',
    'parties',
    'items',
    'documents',
    'payments',
    'reports',
    'inbox',
    'settings',
  ],
  books: [
    'dashboard',
    'documents',
    'documents/new?type=tax_invoice',
    'parties',
    'items',
    'payments',
    'reports',
    'reports?report=sales_register',
    'gst',
    'inbox',
    'settings',
    'settings?tab=features',
    'settings?tab=numbering',
    'settings?tab=print',
    'settings?tab=accounts',
    'settings?tab=audit',
    'settings?tab=backup',
    'settings?tab=trash',
    'settings?tab=privacy',
  ],
};

interface Found {
  route: string;
  id: string;
  impact: string | null | undefined;
  nodes: number;
  help: string;
  sample: string;
}

async function audit(page: Page, route: string): Promise<Found[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => ({
    route,
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    help: v.help,
    sample: v.nodes[0]?.target.join(' ') ?? '',
  }));
}

for (const shell of ['shop', 'books'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${shell} shell, ${theme} theme: no serious or critical violations on any route`, async ({
      page,
    }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('data-theme', t);
        } catch {
          /* storage may be blocked */
        }
      }, theme);
      await openSeeded(page, `/${shell}/dashboard`);

      const all: Found[] = [];
      for (const route of ROUTES[shell]) {
        await page.goto(`/${shell}/${route}`);
        await expect(
          page.getByRole('main').or(page.locator('main, [data-shell]')).first(),
        ).toBeVisible();
        // let the screen finish loading its rows before it is judged
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        all.push(...(await audit(page, route)));
      }

      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${shell}-${theme}.json`), JSON.stringify(all, null, 2));
      const bad = all.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        bad.map((v) => `${v.route}: ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`),
        'serious or critical accessibility violations',
      ).toEqual([]);
    });
  }
}
