import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  webServer: {
    command: 'pnpm exec vite preview --port 1420 --strictPort',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env['CI'],
  },
  use: { baseURL: 'http://localhost:1420' },
});
