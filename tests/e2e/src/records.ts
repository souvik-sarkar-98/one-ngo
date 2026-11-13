import { expect, type Page } from '@playwright/test';
import { label } from './catalogue.js';

export function newRecord(page: Page, typeLabel: string) {
  return page.getByRole('button', { name: label('ui.records.new', { type: typeLabel.toLowerCase() }), exact: true });
}

export async function createRecord(page: Page, typeLabel: string, fields: Record<string, string>): Promise<void> {
  await newRecord(page, typeLabel).click();
  const dialog = page.getByRole('dialog', { name: label('ui.records.createTitle', { type: typeLabel.toLowerCase() }) });
  await expect(dialog).toBeVisible();
  for (const [name, value] of Object.entries(fields)) {
    await dialog.getByLabel(name).fill(value);
  }
  await dialog.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
}

/** Local calendar day, as Angular Material labels the datepicker button. */
export function dayLabel(date: Date): string {
  return new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

export function todayLabel(): string {
  return dayLabel(new Date());
}

export async function openListMenu(page: Page, entry: string): Promise<void> {
  await page.locator('.list-filter-toolbar').getByRole('button', { name: label('ui.common.moreActions'), exact: true }).click();
  await page.getByRole('menuitem', { name: entry, exact: true }).click();
}
