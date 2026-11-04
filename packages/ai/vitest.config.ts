import { defineConfig } from 'vitest/config';

// PGlite starts a WASM Postgres per test file; give it room when the whole monorepo is testing at once.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
