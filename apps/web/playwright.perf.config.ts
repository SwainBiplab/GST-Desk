import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'perf',
  testMatch: '**/*.perf.ts',
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  webServer: {
    command: 'pnpm exec vite preview --port 1420 --strictPort',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env['CI'],
  },
  use: { baseURL: 'http://localhost:1420' },
});
