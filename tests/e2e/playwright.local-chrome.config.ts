import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Temporary: uses the installed Chrome because the Playwright Chromium download failed.
export default defineConfig(base, {
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chrome' } }],
});
