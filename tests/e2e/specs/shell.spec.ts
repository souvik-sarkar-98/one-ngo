import { expect, test, type Page } from '@playwright/test';
import { accounts } from '../src/accounts.js';
import { label } from '../src/catalogue.js';
import { openListMenu } from '../src/records.js';
import { expectDestination, knownDefect, openDestination } from '../src/shell.js';
import { signIn, signInUntilShell } from '../src/sign-in.js';

const phone = { width: 390, height: 844 };
const desktop = { width: 1366, height: 900 };

async function openLanguage(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.locator('section').filter({ has: page.locator('#settings-preferences') }).getByRole('button').first().click();
}

async function chooseLanguage(page: Page, name: string): Promise<void> {
  await openLanguage(page);
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
}

test('MT-NAV-01 Asha can open every destination, and /people is not a route', async ({ page }) => {
  await signIn(page, accounts.admin.email, accounts.admin.name);
  for (const path of ['/', '/records', '/inbox', '/settings', '/admin', '/builder']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : path}$`));
  }
  await expectDestination(page, label('ui.crumbs.people'), false);

  await page.goto('/people');
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: label('ui.crumbs.administration') })).toHaveCount(0);
});

test('MT-NAV-03 Finance is kept out of Administration and Builder', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await expectDestination(page, label('ui.crumbs.administration'), false);
  await expectDestination(page, label('ui.builder.title'), false);

  await page.goto('/admin');
  await page.waitForURL((url) => url.pathname === '/' || url.pathname.startsWith('/admin'));
  const sentHome = new URL(page.url()).pathname === '/';
  if (sentHome && (await page.getByText(label('ui.pages.noAccess')).count()) === 0) {
    knownDefect('DEF-03', '/admin and /builder open Home with no access message.');
  }
  await expect(page.getByText(label('ui.pages.noAccess'))).toBeVisible();
  await page.goto('/builder');
  await expect(page.getByText(label('ui.pages.noAccess'))).toBeVisible();
});

test('MT-NAV-04 phone uses the bottom bar and cards, desktop uses the side bar and both layouts', async ({ page }) => {
  await page.setViewportSize(phone);
  await signIn(page, accounts.admin.email, accounts.admin.name);
  await expect(page.locator('.shell--bottom')).toBeVisible();
  await expect(page.locator('.shell__rail')).toHaveCount(0);
  await page.goto('/records/donor');
  await expect(page.getByRole('group', { name: label('ui.records.layout') })).toHaveCount(0);

  await page.setViewportSize(desktop);
  await page.goto('/records/donor');
  await expect(page.locator('.shell__rail')).toBeVisible();
  await expect(page.locator('.shell--bottom')).toHaveCount(0);
  const layout = page.getByRole('group', { name: label('ui.records.layout') });
  await expect(layout.getByRole('button', { name: label('ui.records.cards'), exact: true })).toBeVisible();
  await expect(layout.getByRole('button', { name: label('ui.records.table'), exact: true })).toBeVisible();
  await layout.getByRole('button', { name: label('ui.records.cards'), exact: true }).click();
  await expect(layout.getByRole('button', { name: label('ui.records.cards'), exact: true })).toHaveAttribute('aria-pressed', 'true');
  await layout.getByRole('button', { name: label('ui.records.table'), exact: true }).click();
  await expect(layout.getByRole('button', { name: label('ui.records.table'), exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('MT-NAV-05 Back returns to the previous place, and the desktop breadcrumb shows the trail', async ({ page }) => {
  await page.setViewportSize(desktop);
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await openDestination(page, label('ui.nav.records'));
  await page.getByRole('link', { name: 'Donors', exact: true }).click();
  await expect(page).toHaveURL(/\/records\/donor/);
  const trail = page.getByRole('navigation', { name: label('ui.crumbs.nav') });
  await expect(trail.getByRole('link', { name: label('ui.nav.records'), exact: true })).toBeVisible();
  await page.getByRole('button', { name: label('ui.common.back'), exact: true }).click();
  await expect(page).toHaveURL(/\/records$/);

  await openDestination(page, label('ui.nav.settings'));
  await expect(page).toHaveURL(/\/settings$/);
  await expect(trail.getByRole('link', { name: label('ui.nav.home'), exact: true })).toBeVisible();
  await page.getByRole('button', { name: label('ui.common.back'), exact: true }).click();
  await expect(page).toHaveURL(/\/records$/);
});

test('MT-NAV-07 a personal pin can be renamed, moved, and removed', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/records/donor');
  await openListMenu(page, label('ui.pins.pinMine'));
  await expect(page.getByText(label('ui.pins.pinned', { label: 'Donors' }))).toBeVisible();
  await page.goto('/records/donation');
  await openListMenu(page, label('ui.pins.pinMine'));
  await expect(page.getByText(label('ui.pins.pinned', { label: 'Donations' }))).toBeVisible();

  await page.goto('/');
  const renamed = `Donors ${Date.now()}`;
  const donors = page.locator('app-widget').filter({ hasText: label('ui.pins.yours') }).filter({ hasText: 'Donors' }).first();
  await donors.getByRole('button', { name: label('ui.common.moreActions') }).click();
  await page.getByRole('menuitem', { name: label('ui.pins.rename'), exact: true }).click();
  const rename = page.getByRole('dialog', { name: label('ui.pins.renameTitle') });
  await rename.getByRole('textbox').fill(renamed);
  await rename.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
  const pin = page.locator('app-widget').filter({ hasText: label('ui.pins.yours') }).filter({ hasText: renamed });
  await expect(pin).toBeVisible();

  await pin.getByRole('button', { name: label('ui.common.moreActions') }).click();
  await page.getByRole('menuitem', { name: label('ui.pins.moveDown'), exact: true }).click();
  await expect(pin).toBeVisible();

  for (const name of [renamed, 'Donations']) {
    const widget = page.locator('app-widget').filter({ hasText: label('ui.pins.yours') }).filter({ hasText: name });
    await widget.getByRole('button', { name: label('ui.common.moreActions') }).click();
    await page.getByRole('menuitem', { name: label('ui.pins.unpin'), exact: true }).click();
    await expect(widget).toHaveCount(0);
  }
});

test('MT-NAV-09 a language choice sticks for that person and leaves everyone else in English', async ({ page }) => {
  await signIn(page, accounts.config.email, accounts.config.name);
  try {
    for (const name of ['हिन्दी', 'தமிழ்', 'తెలుగు', 'বাংলা', 'मराठी']) {
      await chooseLanguage(page, name);
    }
    await page.reload();
    await openLanguage(page);
    await expect(page.getByRole('dialog').getByRole('button', { name: 'मराठी' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await chooseLanguage(page, 'हिन्दी');
    await signInUntilShell(page, accounts.config.email);
    await expect(page.getByRole('link', { name: 'होम', exact: true })).toBeVisible();

    await signIn(page, accounts.viewer.email, accounts.viewer.name);
    await openLanguage(page);
    await expect(page.getByRole('dialog').getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await signInUntilShell(page, accounts.config.email);
    await chooseLanguage(page, 'English');
  }
});

test('MT-NAV-10 unpublished strings stay in English while published strings follow the language', async ({ page }) => {
  await signIn(page, accounts.config.email, accounts.config.name);
  try {
    await chooseLanguage(page, 'हिन्दी');
    await expect(page.getByText('स्वागत है, Config Author')).toBeVisible();
    await page.goto('/records/donor');
    await expect(page.getByRole('button', { name: 'नया donor', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Donors', exact: true })).toBeVisible();
  } finally {
    await chooseLanguage(page, 'English');
  }
});

test('MT-ACC-02 name and email on My profile are not editable', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/settings');
  await expect(page.getByText(accounts.finance.email)).toBeVisible();
  await expect(page.getByText(label('ui.profile.accountHint'))).toBeVisible();
  await expect(page.getByRole('textbox', { name: label('ui.settings.email') })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: label('ui.people.col.name') })).toHaveCount(0);
});

test('MT-ACC-04 two-step shows Off and offers no setup code', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/settings');
  await expect(page.getByText(label('ui.more.off'), { exact: true })).toBeVisible();
  await expect(page.getByText(label('ui.settings.twoStepOff'))).toBeVisible();
  await expect(page.getByRole('button', { name: /QR|setup code|authenticator/i })).toHaveCount(0);
});

test('MT-ACC-05 About this app shows a version', async ({ page }) => {
  await signIn(page, accounts.finance.email, accounts.finance.name);
  await page.goto('/settings');
  await page.getByRole('button', { name: label('ui.more.about') }).click();
  await expect(page.getByRole('dialog', { name: label('ui.more.about') })).toContainText(/Version \d/);
});

