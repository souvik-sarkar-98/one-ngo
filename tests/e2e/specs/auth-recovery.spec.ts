import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accounts, org, password } from '../src/accounts.js';
import { anonymousApi, memberApi, runTag } from '../src/api.js';
import { label } from '../src/catalogue.js';
import {
  addMemberWithPassword,
  messagesTo,
  nextMessage,
  noMailbox,
  openMailbox,
  passwordLinkToken,
  suspendQuietly,
} from '../src/journeys/data.js';

/**
 * Forgot password, the emailed reset link, and sign-in with an emailed code, in a real browser.
 * Each test makes its own throwaway member, so none of them change the shared test passwords.
 * The mail comes from the fixture mailbox; without it every test is skipped with the reason.
 */

const run = runTag('auth');
const newPassword = 'sunlit harbour gate eleven';
const tags = ['@e2e', '@auth', '@P1'];

let admin: APIRequestContext;
let mail: APIRequestContext | null = null;
const created: string[] = [];

test.beforeAll(async () => {
  admin = await memberApi(accounts.admin.email);
  mail = await openMailbox();
});

test.afterAll(async () => {
  for (const userId of created) await suspendQuietly(admin, userId);
  await admin.dispose();
  await mail?.dispose();
});

async function freshMember(tag: string): Promise<{ email: string; name: string }> {
  const email = `${tag}-${run}@riverbank.example`;
  const name = `Auth ${tag} ${run}`;
  const userId = await addMemberWithPassword(admin, mail!, { email, name, roles: [] });
  created.push(userId);
  return { email, name };
}

/** The six-digit code in a sign-in code email, plain or base64 encoded. */
function codeFrom(raw: string): string | null {
  const plain = /sign-in code is (\d{6})/.exec(raw.replace(/=\r?\n/g, ''));
  if (plain) return plain[1]!;
  for (const block of raw.match(/(?:^[A-Za-z0-9+/=]{16,}\r?\n)+/gm) ?? []) {
    const hit = /sign-in code is (\d{6})/.exec(Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8'));
    if (hit) return hit[1]!;
  }
  return null;
}

async function openSignIn(page: Page, tab?: 'tabCode'): Promise<void> {
  await page.context().clearCookies();
  await page.goto(`/o/${org}/sign-in`);
  if (tab) await page.getByRole('tab', { name: label(`ui.auth.${tab}`), exact: true }).click();
}

test('MT-AUTH-16 forgot password emails a link; the link sets a new password, works once, and the old password stops working', { tag: tags }, async ({ page }) => {
  test.skip(!mail, noMailbox);
  const who = await freshMember('reset');

  await openSignIn(page);
  await page.getByRole('button', { name: label('ui.auth.forgot'), exact: true }).click();
  await page.getByLabel(label('ui.auth.email'), { exact: true }).fill(who.email);
  const seen = (await messagesTo(mail!, who.email)).length;
  await page.getByRole('button', { name: label('ui.auth.sendReset'), exact: true }).click();
  await expect(page.getByText(label('ui.auth.resetSent'))).toBeVisible();

  const token = passwordLinkToken(await nextMessage(mail!, who.email, seen));
  expect(token, `reset link in the mail to ${who.email}`).toBeTruthy();
  const link = `/reset-password?token=${encodeURIComponent(token!)}&org=${org}`;

  await page.goto(link);
  await expect(page.getByRole('heading', { name: label('ui.reset.title'), level: 1 })).toBeVisible();
  await page.getByLabel(label('ui.reset.newPassword'), { exact: true }).fill(newPassword);
  await page.getByLabel(label('ui.reset.again'), { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: label('ui.reset.save'), exact: true }).click();
  await expect(page.getByText(label('ui.reset.done'))).toBeVisible();
  await expect(page.getByRole('link', { name: label('ui.reset.goToSignIn') })).toHaveAttribute('href', `/o/${org}/sign-in`);
  expect(page.url(), 'the token is removed from the address').not.toContain('token=');

  await test.step('the same link is refused as used', async () => {
    await page.goto(link);
    await expect(page.getByText(label('ui.reset.expired'))).toBeVisible();
  });

  await test.step('the new password signs in', async () => {
    await openSignIn(page);
    await page.getByLabel(label('ui.auth.email'), { exact: true }).fill(who.email);
    await page.getByLabel(label('ui.auth.password'), { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
    await expect(page.getByText(label('ui.home.welcome', { name: who.name }))).toBeVisible();
  });

  await test.step('the old password is refused', async () => {
    const anonymous = await anonymousApi();
    const old = await anonymous.post('/api/auth/login', { data: { tenant: org, email: who.email, password } });
    await anonymous.dispose();
    expect(old.ok(), 'old password refused').toBe(false);
  });
});

test('MT-AUTH-13 email code: the code from the mail signs the member in and opens Home', { tag: tags }, async ({ page }) => {
  test.skip(!mail, noMailbox);
  const who = await freshMember('code');

  await openSignIn(page, 'tabCode');
  await page.getByLabel(label('ui.auth.email'), { exact: true }).fill(who.email);
  const seen = (await messagesTo(mail!, who.email)).length;
  await page.getByRole('button', { name: label('ui.auth.sendCode'), exact: true }).click();
  await expect(page.getByText(label('ui.auth.codeSent'))).toBeVisible();

  const code = codeFrom(await nextMessage(mail!, who.email, seen));
  expect(code, `six-digit code in the mail to ${who.email}`).toMatch(/^\d{6}$/);
  await page.getByLabel(label('ui.auth.emailCode'), { exact: true }).fill(code!);
  await page.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
  await expect(page.getByText(label('ui.home.welcome', { name: who.name }))).toBeVisible();
});

test('email code: an unknown address gets the same notice with no mail, and a wrong code is refused', { tag: tags }, async ({ page }) => {
  test.skip(!mail, noMailbox);
  const who = await freshMember('wrong');
  const unknown = `nobody-${run}@riverbank.example`;

  await test.step('an unknown address is told the same thing and receives nothing', async () => {
    await openSignIn(page, 'tabCode');
    await page.getByLabel(label('ui.auth.email'), { exact: true }).fill(unknown);
    await page.getByRole('button', { name: label('ui.auth.sendCode'), exact: true }).click();
    await expect(page.getByText(label('ui.auth.codeSent'))).toBeVisible();
    expect(await messagesTo(mail!, unknown), 'no mail for an unknown address').toHaveLength(0);
  });

  await test.step('a wrong code is refused and the member stays on the sign-in page', async () => {
    await openSignIn(page, 'tabCode');
    await page.getByLabel(label('ui.auth.email'), { exact: true }).fill(who.email);
    const seen = (await messagesTo(mail!, who.email)).length;
    await page.getByRole('button', { name: label('ui.auth.sendCode'), exact: true }).click();
    await expect(page.getByText(label('ui.auth.codeSent'))).toBeVisible();

    const real = codeFrom(await nextMessage(mail!, who.email, seen));
    expect(real).toMatch(/^\d{6}$/);
    const wrong = real === '000000' ? '111111' : '000000';
    await page.getByLabel(label('ui.auth.emailCode'), { exact: true }).fill(wrong);
    await page.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(label('ui.home.welcome', { name: who.name }))).toHaveCount(0);
  });
});

test('forgot password for an unknown address gets the same notice and sends nothing', { tag: tags }, async ({ page }) => {
  test.skip(!mail, noMailbox);
  const unknown = `nobody-reset-${run}@riverbank.example`;

  await openSignIn(page);
  await page.getByRole('button', { name: label('ui.auth.forgot'), exact: true }).click();
  await page.getByLabel(label('ui.auth.email'), { exact: true }).fill(unknown);
  await page.getByRole('button', { name: label('ui.auth.sendReset'), exact: true }).click();
  await expect(page.getByText(label('ui.auth.resetSent'))).toBeVisible();
  expect(await messagesTo(mail!, unknown), 'no mail for an unknown address').toHaveLength(0);
});
