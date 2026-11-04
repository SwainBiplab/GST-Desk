import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

const root = (p: string) => path.resolve(import.meta.dirname, `../../packages/${p}`);

import { readFileSync } from 'node:fs';

const pkgJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkgJson.version) },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        // the print fonts load on first use and are kept, so printing works offline afterwards
        runtimeCaching: [
          {
            urlPattern: /\.woff2?$/,
            handler: 'CacheFirst',
            options: { cacheName: 'print-fonts', expiration: { maxEntries: 30 } },
          },
        ],
      },
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
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, 'src') },
      // subpaths first, then the bare package names (exact match only)
      { find: /^@gst\/ui\/tokens/, replacement: root('ui/tokens') },
      { find: /^@gst\/ui\/icons$/, replacement: root('ui/src/icons.ts') },
      { find: /^@gst\/domain\/data\//, replacement: root('domain/data') + '/' },
      { find: /^@gst\/ai\/fixtures/, replacement: root('ai/fixtures') },
      { find: /^@gst\/ai\/db$/, replacement: root('ai/src/db/index.ts') },
      { find: /^@gst\/print\/fonts\.web$/, replacement: root('print/src/fonts.web.ts') },
      { find: /^@gst\/db\/node$/, replacement: root('db/src/node.ts') },
      { find: /^@gst\/db\/seed$/, replacement: root('db/src/seed.ts') },
      { find: /^@gst\/(domain|db|ui|ai|i18n|print)$/, replacement: root('$1/src/index.ts') },
    ],
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { port: 1420, strictPort: true },
  test: { environment: 'node', exclude: ['e2e/**', 'node_modules/**'] },
});
