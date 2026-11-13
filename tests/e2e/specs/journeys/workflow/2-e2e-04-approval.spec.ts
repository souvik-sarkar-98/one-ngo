import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { memberApi, runTag } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { signIn } from '../../../src/sign-in.js';
import {
  approverRole,
  approvers,
  badgeText,
  createGrant,
  decide,
  findPublishedModule,
  grant,
  grantRole,
  grantWaitingForApproval,
  moduleNames,
  modulePermissions,
  navigate,
  newPage,
  pendingApproval,
  publishModule,
  requesterRole,
  revokeRoles,
  runStep,
  userId,
  waitingCount,
  withdraw,
  type GrantRecord,
  type ModuleNames,
  type RoleGrants,
} from '../../../src/journeys/workflow.js';

/** Refusals the approval service writes (`packages/platform/src/runtime/workflows/approval-service.ts`). */
const refusals = {
  ownRequest: 'You cannot approve your own request.',
  alreadyDecided: 'You have already decided this request.',
  notApprover: 'You are not an approver for this step.',
  notRequester: 'Only the requester can withdraw this request.',
};

const tags = (priority: '@P0' | '@P1', smoke = false) => ({ tag: ['@e2e', '@FT-E2E-04', priority, ...(smoke ? ['@smoke'] : [])] });

test.describe.serial('FT-E2E-04 Approval journey', () => {
  const tag = runTag('appr');
  const firstName = `Grant request ${tag} A`;
  const secondName = `Grant request ${tag} B`;
  const grants: RoleGrants = { roles: [], members: [] };
  const openRequests: string[] = [];
  const nativeDialogs: string[] = [];
  let n: ModuleNames;
  let page: Page;
  let admin: APIRequestContext;
  let config: APIRequestContext;
  let requester: APIRequestContext;
  let approverOne: APIRequestContext;
  let approverTwo: APIRequestContext;
  let first: GrantRecord;
  let firstRequest = '';
  let second: { record: GrantRecord; requestId: string };

  const summary = (given: number) =>
    page.getByText(label('ui.records.approvalSummary', { step: n.award.label, by: accounts.finance.name, given, needed: 2 }));
  const approveButton = () => page.getByRole('button', { name: label('ui.common.approve'), exact: true });
  const inboxRow = (name: string) => page.getByRole('row').filter({ hasText: name });

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    admin = await memberApi(accounts.admin.email);
    config = await memberApi(accounts.config.email);
    const published = await findPublishedModule(config);
    if (published) {
      n = published;
    } else {
      n = moduleNames();
      await publishModule(config, n);
    }
    const permissions = modulePermissions(n);
    await grantRole(admin, grants, requesterRole, permissions.requester, [accounts.finance.email]);
    await grantRole(admin, grants, approverRole, permissions.approver, [approvers.one.email, approvers.two.email]);
    requester = await memberApi(accounts.finance.email);
    approverOne = await memberApi(approvers.one.email);
    approverTwo = await memberApi(approvers.two.email);
    first = (await runStep(requester, n, await createGrant(requester, n, firstName), n.submit.key)).record;
    page = await newPage(browser, testInfo);
    page.on('dialog', (dialog) => {
      nativeDialogs.push(dialog.type());
      void dialog.dismiss();
    });
  });

  test.afterAll(async () => {
    for (const id of openRequests) if (requester) await withdraw(requester, id);
    if (admin) await revokeRoles(admin, grants);
    await page?.context().close();
    for (const api of [admin, config, requester, approverOne, approverTwo]) await api?.dispose();
  });

  test('FT-WF-020 the requester runs the step and it waits for 2 approvals', tags('@P0'), async () => {
    await signIn(page, accounts.finance.email, accounts.finance.name);
    await navigate(page, `/records/${n.grant.key}?id=${first.id}`);
    await page.getByRole('button', { name: n.award.label, exact: true }).click();
    const sheet = page.getByRole('dialog', { name: n.award.label });
    await sheet.getByRole('button', { name: n.award.label, exact: true }).click();
    await expect(page.getByText(label('ui.records.stepSent', { step: n.award.label }))).toBeVisible();
    await expect(summary(0)).toBeVisible();
    await expect(page.getByRole('button', { name: n.award.label, exact: true })).toBeDisabled();

    const pending = await pendingApproval(requester, n, first.id);
    expect(pending).toMatchObject({ approvalsGiven: 0, approvalsNeeded: 2, canDecide: false });
    firstRequest = pending!.id;
    expect((await grant(admin, n, first.id)).status).toBe('submitted');
  });

  test('FT-WF-021 the requester cannot approve their own request', tags('@P0', true), async () => {
    await expect(approveButton()).toHaveCount(0);
    const out = await decide(requester, firstRequest, 'approve');
    expect(out.status).toBe(403);
    expect(out.message).toBe(refusals.ownRequest);
  });

  test('FT-WF-022 approver 1 approves and the request shows 1 of 2', tags('@P0'), async () => {
    await signIn(page, approvers.one.email, approvers.one.name);
    await navigate(page, `/records/${n.grant.key}?id=${first.id}`);
    await expect(summary(0)).toBeVisible();
    await approveButton().click();
    await expect(page.getByText(label('ui.approval.recorded'))).toBeVisible();
    await expect(summary(1)).toBeVisible();
    expect((await pendingApproval(approverOne, n, first.id))?.approvalsGiven).toBe(1);
  });

  test('FT-WF-023 approver 1 cannot approve the same request again', tags('@P0'), async () => {
    await expect(approveButton()).toHaveCount(0);
    const again = await decide(approverOne, firstRequest, 'approve');
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.message).toBe(refusals.alreadyDecided);
  });

  test('FT-WF-024 approver 2 approves from Inbox, the step is applied, and the request leaves the list', tags('@P0', true), async () => {
    await signIn(page, approvers.two.email, approvers.two.name);
    await navigate(page, '/inbox');
    const row = inboxRow(firstName);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: label('ui.common.approve'), exact: true }).click();
    await expect(page.getByText(label('ui.approval.approved'))).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await grant(admin, n, first.id)).status).toBe('approved');
    expect(await pendingApproval(admin, n, first.id)).toBeNull();
  });

  test('FT-WF-025 someone who is not an approver cannot decide (API)', tags('@P0'), async () => {
    second = await grantWaitingForApproval(requester, n, secondName);
    openRequests.push(second.requestId);
    const out = await decide(admin, second.requestId, 'approve');
    expect(out.status).toBe(403);
    expect(out.message).toBe(refusals.notApprover);
  });

  test('FT-WF-050 Inbox opens on Notifications with nothing waiting, and on Approvals when something waits', tags('@P1'), async () => {
    await signIn(page, accounts.finance.email, accounts.finance.name);
    await navigate(page, '/inbox');
    await expect(page.getByRole('tab', { name: new RegExp(`^${label('ui.inbox.notifications')}`) })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: label('ui.inbox.approvals'), exact: true })).toBeVisible();

    await signIn(page, approvers.two.email, approvers.two.name);
    await navigate(page, '/inbox');
    const waiting = await waitingCount(approverTwo);
    expect(waiting).toBeGreaterThan(0);
    await expect(page.getByRole('tab', { name: label('ui.inbox.approvalsChip', { count: badgeText(waiting) }), exact: true })).toHaveAttribute('aria-selected', 'true');
  });

  test('FT-WF-051 the approvals list shows the common columns with Approve and Reject, and cards on a phone', tags('@P1'), async () => {
    for (const key of ['ui.inbox.record', 'ui.inbox.type', 'ui.inbox.step', 'ui.inbox.statusChange', 'ui.inbox.requestedBy', 'ui.inbox.waitingSince', 'ui.inbox.approvals']) {
      await expect(page.getByRole('columnheader', { name: label(key), exact: true })).toBeVisible();
    }
    const row = inboxRow(secondName);
    await expect(row).toContainText(n.grant.label);
    await expect(row).toContainText(n.award.label);
    await expect(row).toContainText('Submitted → Approved');
    await expect(row).toContainText(accounts.finance.name);
    await expect(row).toContainText('0 / 2');
    await expect(row.getByRole('button', { name: label('ui.common.approve'), exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: label('ui.common.reject'), exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByText(secondName).first()).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('FT-WF-053 opening a row opens the record panel with the request at the top', tags('@P1'), async () => {
    await inboxRow(secondName).getByRole('cell').first().click();
    await expect(page).toHaveURL(new RegExp(`/records/${n.grant.key}\\?id=${second.record.id}`));
    await expect(summary(0)).toBeVisible();
    await expect(approveButton()).toBeVisible();
  });

  test('FT-WF-054 Reject opens a sheet with an optional reason and no browser prompt', tags('@P1'), async () => {
    await navigate(page, '/inbox');
    await inboxRow(secondName).getByRole('button', { name: label('ui.common.reject'), exact: true }).click();
    const sheet = page.getByRole('dialog', { name: label('ui.inbox.rejectTitle', { step: n.award.label }) });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel(label('ui.inbox.rejectReason'))).toHaveValue('');
    await expect(sheet.getByRole('button', { name: label('ui.common.reject'), exact: true })).toBeEnabled();
    expect(nativeDialogs).toEqual([]);
    await sheet.getByRole('button', { name: label('ui.common.close'), exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect((await pendingApproval(requester, n, second.record.id))?.id).toBe(second.requestId);
  });

  test('FT-NAV-009 the Inbox badge counts waiting approvals and not unread notifications', tags('@P1'), async () => {
    test.info().annotations.push({ type: 'not covered', description: 'The "99+" badge needs 120 waiting approvals; only 0 and 3 or more are checked.' });
    for (const suffix of ['C', 'D']) openRequests.push((await grantWaitingForApproval(requester, n, `Grant request ${tag} ${suffix}`)).requestId);
    await page.reload();
    const waiting = await waitingCount(approverTwo);
    expect(waiting).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.app-bar__badge')).toHaveText(badgeText(waiting));
    await expect(page.getByRole('link', { name: `${label('ui.nav.inbox')} (${badgeText(waiting)})`, exact: true })).toBeVisible();

    await signIn(page, accounts.finance.email, accounts.finance.name);
    expect(await waitingCount(requester)).toBe(0);
    await expect(page.getByRole('link', { name: label('ui.nav.inbox'), exact: true })).toBeVisible();
    await expect(page.locator('.app-bar__badge')).toHaveCount(0);
  });

  test('FT-WF-030 only the requester can withdraw, and a withdrawn request is gone', tags('@P1'), async () => {
    const refused = await withdraw(admin, second.requestId);
    expect(refused.status).toBe(403);
    expect(refused.message).toBe(refusals.notRequester);
    const done = await withdraw(requester, second.requestId);
    expect(done.status).toBe(204);
    openRequests.splice(openRequests.indexOf(second.requestId), 1);
    expect(await pendingApproval(requester, n, second.record.id)).toBeNull();
    expect((await grant(admin, n, second.record.id)).status).toBe('submitted');
  });

  test('FT-E2E-04 the step is applied, the requester is notified, and the audit shows the request and both approvals', tags('@P0'), async () => {
    expect((await grant(admin, n, first.id)).status).toBe('approved');
    await expect
      .poll(
        async () => {
          const res = await requester.get('/api/notifications', { params: { limit: '50' } });
          return ((await res.json()) as { recordId: string | null }[]).some((x) => x.recordId === first.id);
        },
        { message: 'a notification for the approved grant', timeout: 30_000 },
      )
      .toBe(true);

    const res = await admin.get('/api/admin/audit', { params: { recordType: n.grant.key, limit: '200' } });
    expect(res.status()).toBe(200);
    const events = ((await res.json()) as { items: { action: string; actorId: string | null; entityId: string | null }[] }).items.filter((e) => e.entityId === first.id);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('approval.requested');
    expect(actions).toContain('record.transitioned');
    const approvedBy = events.filter((e) => e.action === 'approval.approved').map((e) => e.actorId);
    expect(new Set(approvedBy)).toEqual(new Set([await userId(admin, approvers.one.email), await userId(admin, approvers.two.email)]));
  });
});
