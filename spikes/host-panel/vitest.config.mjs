import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.mjs', 'test/unit/**/*.test.ts'],
    environment: 'node',
    // Durable1000-manifest fixture must not compete with bounded browser/FS tests.
    fileParallelism: false,
    testTimeout: 20000
  }
});
// Test worker configuration boundary.
