import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.mjs', 'test/unit/**/*.test.ts'],
    environment: 'node'
  }
});
