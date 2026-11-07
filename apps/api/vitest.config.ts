import { defineConfig } from 'vitest/config';

// containers start once per file; give them time on a cold machine
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 180_000, fileParallelism: false },
});
