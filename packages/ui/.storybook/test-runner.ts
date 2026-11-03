import type { TestRunnerConfig } from '@storybook/test-runner';

const combos = [
  ['light', 'comfortable'],
  ['light', 'compact'],
  ['dark', 'comfortable'],
  ['dark', 'compact'],
] as const;

const config: TestRunnerConfig = {
  async postVisit(page, context) {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    for (const [theme, density] of combos) {
      await page.evaluate(
        ([t, d]) => {
          document.documentElement.setAttribute('data-theme', t as string);
          document.documentElement.setAttribute('data-density', d as string);
        },
        [theme, density],
      );
    }
    if (errors.length) throw new Error(`${context.id}: console errors: ${errors.join(' | ')}`);
  },
};

export default config;
