import { defineConfig, devices } from '@playwright/test';

const app = process.env.APP_BASE_URL;
if (!app) throw new Error('Set APP_BASE_URL to the deployed app address.');

/**
 * Browser checks against a deployed environment. Run with:
 *   npx playwright test --config=playwright.post-deploy.config.ts
 * The suite in ./specs signs in and writes records, so it is not this config.
 */
export default defineConfig({
  testDir: './post-deploy',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: app,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
