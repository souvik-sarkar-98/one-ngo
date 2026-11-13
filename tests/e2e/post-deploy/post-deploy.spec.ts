import { expect, test } from '@playwright/test';
import { label } from '../src/catalogue.js';

const consoleBase = process.env.CONSOLE_BASE_URL?.replace(/\/$/, '');
if (!consoleBase) throw new Error('Set CONSOLE_BASE_URL to the deployed console address.');

test('the deployed app shows organisation sign-in', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.locator('app-root')).toBeAttached();
  await expect(page.getByLabel(label('ui.auth.organisationCode'))).toBeVisible();
});

test('the deployed console shows its sign-in page', async ({ page }) => {
  await page.goto(`${consoleBase}/`);
  await expect(page.locator('op-root')).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Console sign in' })).toBeVisible();
});
