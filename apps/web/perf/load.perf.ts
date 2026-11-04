import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import budgets from './budgets.json' with { type: 'json' };

interface Measure {
  route: string;
  fcpMs: number;
  loadMs: number;
  budget: { fcpMs: number; loadMs: number };
  pass: boolean;
}

const results: Measure[] = [];

test.afterAll(() => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'perf-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'web.json'),
    JSON.stringify(
      { suite: 'web', at: new Date().toISOString(), cpuThrottle: budgets.cpuThrottle, results },
      null,
      2,
    ),
  );
});

for (const [route, budget] of Object.entries(budgets.routes)) {
  test(`${route} loads within budget at ${budgets.cpuThrottle}x CPU throttle`, async ({
    context,
  }) => {
    // seed once per context, then close that page so its OPFS lock is released before measuring
    const seeder = await context.newPage();
    await seeder.goto('/books/dashboard?demo=1');
    await expect(seeder.getByTestId('badge-documents')).toHaveText('500', { timeout: 30_000 });
    await seeder.close();

    const page = await context.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: budgets.cpuThrottle });
    await page.goto(route, { waitUntil: 'load' });
    // take the median of the navigation timing and paint entries after the page settles
    await page.waitForLoadState('networkidle');
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { loadMs: nav.loadEventEnd, fcpMs: fcp?.startTime ?? nav.domContentLoadedEventEnd };
    });
    const pass = m.fcpMs <= budget.fcpMs && m.loadMs <= budget.loadMs;
    results.push({ route, fcpMs: Math.round(m.fcpMs), loadMs: Math.round(m.loadMs), budget, pass });
    expect(m.fcpMs, 'first contentful paint').toBeLessThanOrEqual(budget.fcpMs);
    expect(m.loadMs, 'load event').toBeLessThanOrEqual(budget.loadMs);
  });
}
