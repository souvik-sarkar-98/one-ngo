import { expect, test, type Page } from '@playwright/test';

/**
 * The console's organisation Sign-in screen, against `npm run dev -- --console`: the integration fixture
 * stands in for the operator identity provider and reports a multi-factor sign-in. Set CONSOLE_E2E_URL to the
 * console address (http://localhost:8081 by default in dev) to run it.
 */
const consoleBase = process.env.CONSOLE_E2E_URL?.replace(/\/$/, '');
const operatorEmail = process.env.CONSOLE_E2E_OPERATOR ?? 'operator.full@onengo.local';
const organisation = process.env.CONSOLE_E2E_ORG ?? 'riverbank';

async function throughFixture(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Demo sign-in' })).toBeVisible();
  await page.getByLabel('Email').fill(operatorEmail);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('MT-OP-SIGNIN console organisation sign-in', () => {
  test.skip(!consoleBase, 'Set CONSOLE_E2E_URL to a console started with npm run dev -- --console.');

  test('an operator verifies with MFA and saves an organisation sign-in policy', async ({ page }) => {
    await page.goto(`${consoleBase}/sign-in?next=${encodeURIComponent(`/organisations/sign-in?code=${organisation}`)}`);
    await page.getByRole('button', { name: 'Continue to identity provider' }).click();
    await throughFixture(page);

    await expect(page.getByRole('heading', { name: /^Sign-in for / })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Policy' })).toBeVisible();
    const save = page.getByRole('button', { name: 'Save policy' });
    await expect(save).toBeDisabled();

    await page.getByRole('button', { name: 'Verify to make a change' }).click();
    await throughFixture(page);
    await expect(page.getByText('You can make one change in the next five minutes.')).toBeVisible();
    await expect(save).toBeDisabled();

    // Saves the current values unchanged, so the organisation's sign-in stays as it was.
    await page.getByLabel('Reason for the change (kept in the audit)').fill('End-to-end check of the Sign-in screen');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Policy saved.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify to make a change' })).toBeVisible();
    await expect(save).toBeDisabled();
  });
});
