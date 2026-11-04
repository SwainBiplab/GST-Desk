import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/index.ts', 'src/index.test.ts'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
