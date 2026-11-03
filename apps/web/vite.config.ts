import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = (name: string) =>
  path.resolve(import.meta.dirname, `../../packages/${name}/src/index.ts`);

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'GST Desk',
        short_name: 'GST Desk',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0f766e',
        icons: [],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@gst/domain': pkg('domain'),
      '@gst/db': pkg('db'),
      '@gst/ui/tokens': path.resolve(import.meta.dirname, '../../packages/ui/tokens'),
      '@gst/ui': pkg('ui'),
      '@gst/ai': pkg('ai'),
      '@gst/i18n': pkg('i18n'),
    },
  },
  server: { port: 1420, strictPort: true },
  test: { environment: 'node', exclude: ['e2e/**', 'node_modules/**'] },
});
