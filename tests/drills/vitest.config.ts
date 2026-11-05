import { defineConfig } from 'vitest/config';

// Drills spawn processes and move files: they are slow on purpose and run in CI nightly.
export default defineConfig({
  test: { testTimeout: 180_000, hookTimeout: 180_000, include: ['src/**/*.drill.ts'] },
});
