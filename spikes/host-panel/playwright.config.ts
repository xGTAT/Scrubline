import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/ui',
  testMatch: '**/*.spec.ts',
  outputDir: '../../test-results',
  use: {
    baseURL: 'http://127.0.0.1:4701'
  },
  webServer: [
    {
      command: 'node test/ui/serve-harness.mjs',
      url: 'http://127.0.0.1:4701',
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'node ../../fixtures/sample-web/server.js --port 4702',
      url: 'http://127.0.0.1:4702',
      reuseExistingServer: !process.env.CI
    }
  ]
});
