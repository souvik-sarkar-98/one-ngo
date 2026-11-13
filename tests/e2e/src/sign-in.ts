import { expect, type Page } from '@playwright/test';
import { org, password } from './accounts.js';
import { label } from './catalogue.js';

export async function signIn(page: Page, email: string, name: string): Promise<void> {
  await submitPassword(page, email);
  await expect(page.getByText(label('ui.home.welcome', { name }))).toBeVisible();
}

/** Sign in and wait for the shell. Use this when the person's language is not English. */
export async function signInUntilShell(page: Page, email: string): Promise<void> {
  await submitPassword(page, email);
  await expect(page.locator('.shell')).toBeVisible();
}

async function submitPassword(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto(`/o/${org}/sign-in`);
  await page.getByRole('tab', { name: label('ui.auth.tabPassword') }).click();
  await page.getByLabel(label('ui.auth.email')).fill(email);
  await page.getByLabel(label('ui.auth.password')).fill(password);
  await page.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
}

export async function openUnknownOrganisation(page: Page, code: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(label('ui.auth.organisationCode')).fill(code);
  await page.getByRole('button', { name: label('ui.auth.continue') }).click();
  await expect(page.getByRole('heading', { name: label('ui.auth.orgNotFound') })).toBeVisible();
}
