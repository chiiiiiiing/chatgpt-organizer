import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, expect: { timeout: 12000 },
  fullyParallel: false, workers: 1, reporter: 'list',
  outputDir: process.env.E2E_BROWSER === 'edge' ? 'test-results/edge' : 'test-results/chromium',
});
