import { expect, type Page, test } from '@playwright/test';
import { label } from './catalogue.js';

function nav(page: Page) {
  return page.getByRole('navigation', { name: label('ui.nav.main') });
}

export async function expectDestination(page: Page, name: string, visible: boolean): Promise<void> {
  await expect(nav(page)).toBeVisible();
  const inRail = await nav(page).getByRole('link', { name, exact: true }).count();
  const more = nav(page).getByRole('button', { name: label('ui.nav.more') });
  let inMore = 0;
  if (await more.count()) {
    await more.click();
    inMore = await page.getByRole('dialog').getByRole('link', { name, exact: true }).count();
    await page.getByRole('button', { name: label('ui.common.close') }).click();
  }
  expect(inRail + inMore > 0).toBe(visible);
}

export async function openDestination(page: Page, name: string): Promise<void> {
  const link = nav(page).getByRole('link', { name, exact: true });
  if (await link.count()) {
    await link.click();
    return;
  }
  await nav(page).getByRole('button', { name: label('ui.nav.more') }).click();
  await page.getByRole('dialog').getByRole('link', { name, exact: true }).click();
}

export async function signOut(page: Page): Promise<void> {
  const inRail = nav(page).getByRole('button', { name: label('ui.shell.signOut'), exact: true });
  if (await inRail.count()) {
    await inRail.click();
  } else {
    await nav(page).getByRole('button', { name: label('ui.nav.more') }).click();
    await page.getByRole('dialog').getByRole('button', { name: label('ui.shell.signOut'), exact: true }).click();
  }
  const confirm = page.getByRole('alertdialog', { name: label('ui.shell.signOutTitle') });
  await confirm.getByRole('button', { name: label('ui.shell.signOut'), exact: true }).click();
  await expect(page.getByRole('button', { name: label('ui.auth.signIn'), exact: true })).toBeVisible();
}

/** The plan's expected result is still wrong. Mark the test as a known failure, then assert the plan. */
export function knownDefect(id: string, summary: string): void {
  test.fail(true, `${id}: ${summary}`);
}
