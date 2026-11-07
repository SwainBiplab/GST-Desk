import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import istanbul from 'vite-plugin-istanbul';
import { VitePWA } from 'vite-plugin-pwa';

const root = (p: string) => path.resolve(import.meta.dirname, `../../packages/${p}`);

import { readFileSync } from 'node:fs';

const pkgJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'),
) as { version: string };

/**
 * `VITE_TARGET=capacitor` builds the phone app's web layer: Capacitor serves the files itself, so the
 * service worker is replaced by one that removes itself; a debug build may also talk to the API on the
 * development machine over plain http (the emulator reaches it at 10.0.2.2).
 */
const capacitor = process.env['VITE_TARGET'] === 'capacitor';
const debugApi = capacitor && process.env['VITE_DEBUG_API'] === '1';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkgJson.version), __DEBUG_API__: debugApi },
  // the phone app runs in Android's System WebView, which Play keeps current on real phones; the syntax
  // floor is Chrome 100 (Android 10+ with an updated WebView). Older ones see the note in entry-gate.js.
  ...(capacitor ? { build: { target: ['chrome100', 'safari15'] } } : {}),
  plugins: [
    // `COVERAGE=1 vite build` instruments the feature code so the end-to-end run can report coverage
    ...(process.env['COVERAGE'] === '1'
      ? [
          istanbul({
            include: 'src/features/**/*',
            exclude: ['**/*.test.*'],
            extension: ['.ts', '.tsx'],
            requireEnv: false,
            forceBuildInstrument: true,
          }),
        ]
      : []),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    ...(debugApi
      ? [
          {
            name: 'gst-debug-csp',
            transformIndexHtml: (html: string) =>
              html.replace(
                "connect-src 'self' https:",
                "connect-src 'self' https: http://10.0.2.2:*",
              ),
          },
        ]
      : []),
    VitePWA({
      registerType: 'prompt',
      selfDestroying: capacitor,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        // the browser model runtime is fetched only when a person switches it on, never precached
        globIgnores: ['**/webllm-*.js'],
        // the landing page is static files, not part of the app's routes
        navigateFallbackDenylist: [/^\/landing(\/|$)/],
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
  build: {
    rollupOptions: {
      output: {
        // the optional AI libraries load on demand and must not sit in the shared chunk (web-llm alone is 6 MB)
        advancedChunks: {
          groups: [
            { name: 'webllm', test: /@mlc-ai[\\/]web-llm/ },
            { name: 'tesseract', test: /tesseract\.js/ },
            { name: 'pdfjs', test: /pdfjs-dist/ },
          ],
        },
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { port: 1420, strictPort: true },
  test: {
    environment: 'node',
    exclude: ['e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      // every feature file, loaded by a test or not, so the figure is not flattered by what happens to be imported
      include: ['src/features/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/features/**/README.md'],
    },
  },
});
