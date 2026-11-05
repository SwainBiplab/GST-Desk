import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  webServer: {
    command: 'pnpm exec vite preview --port 1420 --strictPort',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env['CI'],
  },
  use: {
    baseURL: 'http://localhost:1420',
    // a browser that has used the app before, so `/` opens the app and not the landing page
    storageState: {
      cookies: [],
      origins: [
        { origin: 'http://localhost:1420', localStorage: [{ name: 'gst.entered', value: '1' }] },
      ],
    },
  },
});
