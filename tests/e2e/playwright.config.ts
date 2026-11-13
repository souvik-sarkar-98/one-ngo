import { defineConfig, devices } from '@playwright/test';

const app = process.env.APP_BASE_URL ?? 'http://localhost:4200';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: app,
    // Headed by default so the run can be watched. CI, or E2E_HEADLESS=1, runs without a window.
    headless: !(process.env.CI || process.env.E2E_HEADLESS),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
