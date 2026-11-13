import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { memberApi } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { createRecord, openListMenu } from '../../../src/records.js';
import { signIn } from '../../../src/sign-in.js';
import {
  approverRole,
  automationBody,
  awardStep,
  checkBody,
  createGrant,
  definitionDetail,
  escapeRegExp,
  grantBody,
  grantListBody,
  grantRole,
  groupBody,
  moduleNames,
  modulePermissions,
  navigate,
  newDefinition,
  newPage,
  openPublish,
  openTab,
  pageBody,
  pageWidgets,
  programmeBody,
  programmeListBody,
  publishInBuilder,
  requesterRole,
  revokeRoles,
  templateBody,
  workflowBase,
  workflowFull,
  writeJson,
  type DefinitionDetail,
  type RoleGrants,
} from '../../../src/journeys/workflow.js';

type Body = Record<string, unknown>;

const tags = (priority: '@P0' | '@P1', smoke = false) => ({ tag: ['@e2e', '@FT-E2E-06', priority, ...(smoke ? ['@smoke'] : [])] });

/** A catalogue text with its placeholders turned into patterns, e.g. "Draft saved {time}". */
function pattern(text: string, parts: Record<string, string>): RegExp {
  let out = escapeRegExp(text);
  for (const [name, re] of Object.entries(parts)) out = out.replace(`\\{${name}\\}`, re);
  return new RegExp(out);
}

/** Paid and cancelled donations with their versions: records that existed before the module and must not change. */
async function settledDonations(admin: APIRequestContext): Promise<Map<string, number>> {
  const res = await admin.post('/api/records/donation/query', { data: { statusIn: ['paid', 'cancelled'], limit: 100 } });
  expect(res.status()).toBe(200);
  const { items } = (await res.json()) as { items: { id: string; version: number }[] };
  return new Map(items.map((r) => [r.id, r.version]));
}

/** The Donations module's definitions and the versions they are published at. */
async function shippedVersions(api: APIRequestContext): Promise<Record<string, string>> {
  const res = await api.get('/api/builder/catalogue');
  expect(res.status()).toBe(200);
  const items = (await res.json()) as { kind: string; key: string; owner: string; publishedVersion: number | null; draftVersion: number | null }[];
  return Object.fromEntries(items.filter((i) => i.owner === 'base').map((i) => [`${i.kind}/${i.key}`, `${i.publishedVersion}/${i.draftVersion}`]));
}

async function restoreHome(admin: APIRequestContext, before: DefinitionDetail | null): Promise<void> {
  if (before?.draft) {
    const res = await admin.put('/api/builder/definitions/page/home/draft', { data: before.draft.body });
    expect(res.status(), await res.text()).toBe(200);
    return;
  }
  if ((await definitionDetail(admin, 'page', 'home'))?.draft) {
    const res = await admin.post('/api/builder/definitions/page/home/discard');
    expect(res.status(), await res.text()).toBe(204);
  }
}

test.describe.serial('FT-E2E-06 New module without code', () => {
  const n = moduleNames();
  const renamedList = `Grant requests ${n.suffix}`;
  const grants: RoleGrants = { roles: [], members: [] };
  let page: Page;
  let adminPage: Page;
  let admin: APIRequestContext;
  let config: APIRequestContext;
  let oldDonations: Map<string, number>;
  let shipped: Record<string, string>;

  const awardInDraft = async () =>
    ((await definitionDetail(config, 'workflow', n.workflow.key))?.draft?.body['transitions'] as Body[] | undefined)?.find((t) => t['key'] === n.award.key);

  test.beforeAll(async ({ browser }, testInfo) => {
    admin = await memberApi(accounts.admin.email);
    config = await memberApi(accounts.config.email);
    await grantRole(admin, grants, requesterRole, modulePermissions(n).requester, [accounts.finance.email]);
    oldDonations = await settledDonations(admin);
    shipped = await shippedVersions(config);
    page = await newPage(browser, testInfo);
    adminPage = await newPage(browser, testInfo);
  });

  test.afterAll(async () => {
    if (admin) await revokeRoles(admin, grants);
    await page?.context().close();
    await adminPage?.context().close();
    await admin?.dispose();
    await config?.dispose();
  });

  test('FT-BLD-002 the Builder lists every section and kind, and a kind page has sortable columns', tags('@P1'), async () => {
    await signIn(page, accounts.config.email, accounts.config.name);
    await navigate(page, '/builder');
    await expect(page.getByRole('heading', { level: 1, name: label('ui.builder.title'), exact: true })).toBeVisible();
    for (const section of ['data', 'process', 'templates', 'money', 'look', 'access', 'advanced']) {
      await expect(page.getByRole('heading', { level: 2, name: label(`ui.builder.sections.${section}`), exact: true })).toBeVisible();
    }
    const rows = [
      'ui.builder.kinds.recordType',
      'ui.builder.home.lists',
      'ui.builder.kinds.recordGroup',
      'ui.builder.kinds.dataFeed',
      'ui.builder.kinds.workflow',
      'ui.builder.kinds.action',
      'ui.builder.kinds.automation',
      'ui.builder.kinds.template',
      'ui.builder.home.templates.report',
      'ui.builder.kinds.postingRule',
      'ui.builder.kinds.receiptRule',
      'ui.builder.look.theme',
      'ui.builder.look.layout',
      'ui.builder.kinds.page',
      'ui.builder.kinds.translation',
      'ui.builder.sections.access',
      'ui.builder.kinds.script',
      'ui.crumbs.builder.modules',
    ];
    for (const key of rows) {
      await expect(page.locator('.builder-dir strong').filter({ hasText: new RegExp(`^${escapeRegExp(label(key))}$`) }).first()).toBeVisible();
    }

    await page.locator('.builder-dir a').filter({ has: page.locator('strong', { hasText: new RegExp(`^${label('ui.builder.kinds.recordType')}$`) }) }).click();
    await expect(page).toHaveURL(/\/builder\?kind=recordType/);
    await expect(page.getByRole('heading', { level: 1, name: label('ui.builder.kinds.recordType'), exact: true })).toBeVisible();
    for (const column of ['ui.builder.name', 'ui.builder.kindLabel', 'ui.builder.key', 'ui.builder.catalogue.from', 'ui.builder.catalogue.state']) {
      await expect(page.getByRole('columnheader', { name: label(column), exact: true })).toBeVisible();
    }
    const nameColumn = page.getByRole('columnheader', { name: label('ui.builder.name'), exact: true });
    await nameColumn.getByRole('button').click();
    await expect(nameColumn).toHaveAttribute('aria-sort', /ascending|descending/);
    await expect(page.getByRole('row', { name: /Donor/ }).first()).toBeVisible();

    const catalogue = (await (await config.get('/api/builder/catalogue')).json()) as { kind: string }[];
    const search = page.getByLabel(label('ui.common.search'), { exact: true });
    if (catalogue.filter((i) => i.kind === 'recordType').length > 8) await expect(search).toBeVisible();
    else await expect(search).toHaveCount(0);
  });

  test('FT-BLD-004 a record type from the Beneficiary starter and a blank one get keys from their names and start as drafts', tags('@P1'), async () => {
    expect(await newDefinition(page, 'recordType', n.grant.name, { starter: 'beneficiary' })).toBe(n.grant.key);
    await expect(page.getByText(label('ui.builder.draftVersion', { version: 1 }), { exact: true }).first()).toBeVisible();
    const fromStarter = await definitionDetail(config, 'recordType', n.grant.key);
    expect(fromStarter?.published).toBeNull();
    expect(((fromStarter?.draft?.body['fields'] as Body[]) ?? []).map((f) => f['key'])).toEqual(['name', 'phone', 'dateOfBirth', 'address']);

    expect(await newDefinition(page, 'recordType', n.programme.name)).toBe(n.programme.key);
    await expect(page.getByText(label('ui.builder.draftVersion', { version: 1 }), { exact: true }).first()).toBeVisible();
    const blank = await definitionDetail(config, 'recordType', n.programme.key);
    expect(blank?.draft?.body['label']).toBe(n.programme.name);
  });

  test('FT-BLD-005 an edit is saved as a draft about 800 ms after typing stops', tags('@P1'), async () => {
    test.setTimeout(120_000);
    test.info().annotations.push({ type: 'not covered', description: 'The "draft on device" badge when offline needs the network to drop.' });
    await openTab(page, 'json');
    const foot = page.locator('.builder-foot');
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/builder/definitions/recordType/${n.programme.key}/draft`);
    await page.getByLabel(label('ui.builder.definition'), { exact: true }).fill(JSON.stringify(programmeBody(n), null, 2));
    await expect(foot).toContainText(new RegExp(`${escapeRegExp(label('ui.builder.unsaved'))}|${escapeRegExp(label('ui.builder.saving'))}`));
    expect((await saved).status()).toBe(200);
    await expect(foot).toContainText(pattern(label('ui.builder.draftSavedAt'), { time: '\\d{1,2}[:.]\\d{2}' }));
    await expect(page.getByText(label('ui.builder.draftVersion', { version: 1 }), { exact: true }).first()).toBeVisible();
    expect((await definitionDetail(config, 'recordType', n.programme.key))?.draft?.body).toMatchObject(programmeBody(n));

    await publishInBuilder(page, n.programme.label);
    await expect(page.getByText(label('ui.builder.publishedVersion', { version: 1 }), { exact: true })).toBeVisible();

    await navigate(page, `/builder/recordType/${n.grant.key}`);
    await writeJson(page, 'recordType', n.grant.key, grantBody(n));
    await expect(foot).toContainText(pattern(label('ui.builder.draftSavedAt'), { time: '\\d{1,2}[:.]\\d{2}' }));
    await publishInBuilder(page, n.grant.label);
    await expect(page.getByText(label('ui.builder.publishedVersion', { version: 1 }), { exact: true })).toBeVisible();
  });

  test('FT-BLD-050 the workflow shows its diagram, states and steps, warns about an unreachable state, and takes a 2-approval step', tags('@P1'), async () => {
    test.setTimeout(120_000);
    expect(await newDefinition(page, 'workflow', n.workflow.name, { recordType: n.grant.key })).toBe(n.workflow.key);
    await writeJson(page, 'workflow', n.workflow.key, workflowBase(n));
    await openTab(page, 'visual');
    await expect(page.getByRole('heading', { name: label('ui.builder.workflows.diagram'), exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: label('ui.builder.workflows.statesCount', { count: 3 }), exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: label('ui.builder.workflows.stepsCount', { count: 1 }), exact: true })).toBeVisible();
    const unreachable = page.getByText(label('ui.builder.workflows.unreachable', { states: 'Approved' }));
    await expect(unreachable).toBeVisible();

    await page.getByRole('button', { name: label('ui.builder.workflow.addStep'), exact: true }).click();
    const panel = page.locator('app-workflow-step-panel');
    await expect(panel).toBeVisible();
    await panel.getByLabel(label('ui.builder.workflow.buttonLabel'), { exact: true }).fill(n.award.label);
    const from = panel.getByRole('group', { name: label('ui.builder.workflow.availableFrom') });
    await from.getByRole('checkbox', { name: 'Submitted', exact: true }).check();
    await from.getByRole('checkbox', { name: 'Draft', exact: true }).uncheck();
    await panel.getByLabel(label('ui.builder.workflow.movesTo'), { exact: true }).selectOption('approved');
    await panel.getByRole('checkbox', { name: label('ui.builder.workflow.needsApproval'), exact: true }).check();
    const roleChoices = panel.getByRole('group', { name: label('ui.builder.workflow.approverRoles') });
    if (await roleChoices.count()) {
      await roleChoices.getByRole('checkbox', { name: approverRole.label, exact: true }).check();
    } else {
      const roles = panel.getByLabel(label('ui.builder.workflow.approverRoles'), { exact: true });
      await roles.fill(approverRole.key);
      await roles.press('Tab');
    }
    await panel.getByLabel(label('ui.builder.workflow.approvalsNeeded'), { exact: true }).fill('2');

    await expect(unreachable).toHaveCount(0);
    await expect(page.getByRole('heading', { name: label('ui.builder.workflows.stepsCount', { count: 2 }), exact: true })).toBeVisible();
    await expect(page.getByText(label('ui.builder.workflows.approvalOf', { count: 2, who: approverRole.key })).first()).toBeVisible();
    await expect.poll(awardInDraft, { timeout: 15_000 }).toEqual(awardStep(n));

    const full = workflowFull(n);
    const dupState = { ...full, states: [...(full['states'] as Body[]), { key: 'draft', label: 'Draft again' }] };
    expect((await checkBody(config, 'workflow', n.workflow.key, dupState)).errors.map((e) => e.message)).toContain('duplicate state keys');
    const dupStep = { ...full, transitions: [...(full['transitions'] as Body[]), { key: n.submit.key, label: 'Submit again', from: ['submitted'], to: 'draft' }] };
    expect((await checkBody(config, 'workflow', n.workflow.key, dupStep)).errors.map((e) => e.message)).toContain(`duplicate transition '${n.submit.key}'`);
  });

  test('FT-WF-034 approvals needed keeps 1 to 5, and the check refuses 0 and 6', tags('@P1'), async () => {
    const count = page.locator('app-workflow-step-panel').getByLabel(label('ui.builder.workflow.approvalsNeeded'), { exact: true });
    for (const [typed, kept] of [['0', 1], ['1', 1], ['5', 5], ['6', 5], ['2', 2]] as const) {
      await count.fill(typed);
      await expect.poll(async () => ((await awardInDraft())?.['approval'] as { count?: number } | undefined)?.count, { message: `typed ${typed}`, timeout: 15_000 }).toBe(kept);
    }
    for (const value of [0, 6]) {
      const { errors } = await checkBody(config, 'workflow', n.workflow.key, workflowFull(n, value));
      expect(errors.some((e) => e.path.includes('approval')), `count ${value}: ${JSON.stringify(errors)}`).toBe(true);
    }
    for (const value of [1, 5]) {
      expect((await checkBody(config, 'workflow', n.workflow.key, workflowFull(n, value))).errors, `count ${value}`).toEqual([]);
    }
  });

  test('FT-BLD-006 Check reports no problems, then an error, then a warning that does not block', tags('@P1'), async () => {
    const check = page.getByRole('button', { name: label('ui.builder.check'), exact: true });
    const ok = page.getByText(label('ui.builder.checkOk'), { exact: true });
    await check.click();
    await expect(ok).toBeVisible();

    const broken = workflowFull(n);
    (broken['transitions'] as Body[])[1]!['to'] = 'nowhere';
    await writeJson(page, 'workflow', n.workflow.key, broken);
    await check.click();
    const withError = page.locator('.notice').filter({ hasText: pattern(label('ui.builder.checkResult'), { errors: '[1-9]\\d*', warnings: '\\d+' }) });
    await expect(withError).toBeVisible();
    await expect(withError).toContainText("unknown state 'nowhere'");

    const warned = workflowFull(n);
    (warned['transitions'] as Body[])[0]!['permission'] = 'e2e:unheld';
    await writeJson(page, 'workflow', n.workflow.key, warned);
    await check.click();
    const withWarning = page.locator('.notice').filter({ hasText: pattern(label('ui.builder.checkResult'), { errors: '0', warnings: '[1-9]\\d*' }) });
    await expect(withWarning).toBeVisible();
    await expect(withWarning).toContainText("'e2e:unheld' is not a generated permission and no role has it yet");

    await writeJson(page, 'workflow', n.workflow.key, workflowFull(n));
    await check.click();
    await expect(ok).toBeVisible();
  });

  test('FT-BLD-007 a list label change shows what changes first, and the live list uses the new label', tags('@P0', true), async () => {
    test.setTimeout(180_000);
    for (const [list, type, body] of [
      [n.programmeList, n.programme.key, programmeListBody(n)],
      [n.grantList, n.grant.key, grantListBody(n)],
    ] as const) {
      expect(await newDefinition(page, 'listView', list.name, { recordType: type })).toBe(list.key);
      await writeJson(page, 'listView', list.key, body);
      await publishInBuilder(page, list.name);
    }
    expect(await newDefinition(page, 'recordGroup', n.group.name, { recordType: n.grant.key })).toBe(n.group.key);
    await writeJson(page, 'recordGroup', n.group.key, groupBody(n));
    await publishInBuilder(page, n.group.name);

    await navigate(page, `/builder/listView/${n.grantList.key}`);
    await writeJson(page, 'listView', n.grantList.key, grantListBody(n, renamedList));
    const lines = await publishInBuilder(page, renamedList);
    expect(lines.length, 'the plain-language summary lists the change').toBeGreaterThan(0);

    await signIn(adminPage, accounts.admin.email, accounts.admin.name);
    await navigate(adminPage, `/records/${n.grant.key}`);
    await expect(adminPage.getByRole('heading', { name: renamedList, exact: true })).toBeVisible();
  });

  test('FT-BLD-008 publishing with errors shows only the problems and Back', tags('@P0'), async () => {
    test.setTimeout(180_000);
    await navigate(page, `/builder/workflow/${n.workflow.key}`);
    const broken = workflowFull(n);
    (broken['transitions'] as Body[])[1]!['to'] = 'nowhere';
    await writeJson(page, 'workflow', n.workflow.key, broken);
    const sheet = await openPublish(page, n.workflow.key);
    await expect(sheet.getByText(label('ui.builder.fixFirst'))).toBeVisible();
    await expect(sheet).toContainText("unknown state 'nowhere'");
    await expect(sheet.getByRole('button', { name: label('ui.builder.publish'), exact: true })).toHaveCount(0);
    await sheet.getByRole('button', { name: label('ui.common.back'), exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect((await definitionDetail(config, 'workflow', n.workflow.key))?.published).toBeNull();

    await writeJson(page, 'workflow', n.workflow.key, workflowFull(n));
    await publishInBuilder(page, n.workflow.key);

    const second = { ...workflowFull(n), key: `${n.workflow.key}Second`, appliesWhen: "record.priority == 'high'" };
    const { errors } = await checkBody(config, 'workflow', String(second.key), second);
    expect(errors.map((e) => e.message), 'FT-BLD-050: a step key is unique across the record type\'s workflows').toContain(`step '${n.submit.key}' is already used by workflow '${n.workflow.key}'`);

    expect(await newDefinition(page, 'template', n.template.name)).toBe(n.template.key);
    await writeJson(page, 'template', n.template.key, templateBody(n));
    await publishInBuilder(page, n.template.name);
    expect(await newDefinition(page, 'automation', n.automation.name, { recordType: n.grant.key })).toBe(n.automation.key);
    await writeJson(page, 'automation', n.automation.key, automationBody(n));
    await publishInBuilder(page, n.automation.name);
  });

  test('FT-HOME-003 a published page shows its stat, chart, list, links and groups widgets', tags('@P1'), async () => {
    test.setTimeout(120_000);
    expect(await newDefinition(page, 'page', n.page.name)).toBe(n.page.key);
    await writeJson(page, 'page', n.page.key, pageBody(n));
    await publishInBuilder(page, n.page.name);
    await createGrant(admin, n, `Overview grant ${n.suffix}`);

    await navigate(adminPage, `/pages/${n.page.key}`);
    await expect(adminPage.getByRole('heading', { name: n.page.name, exact: true })).toBeVisible();
    for (const heading of Object.values(pageWidgets)) {
      await expect(adminPage.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible();
    }
    await expect(adminPage.getByRole('img', { name: pageWidgets.chart })).toBeVisible();
    await expect(adminPage.getByRole('link', { name: 'All grants', exact: true })).toBeVisible();
    const groups = adminPage.locator('app-widget.home__full');
    await expect(groups.getByRole('heading', { name: n.group.name, exact: true })).toBeVisible();
    const grid = adminPage.locator('.home__grid');
    await expect(grid).toHaveClass(/home__grid--two/);
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await expect(grid).not.toHaveClass(/home__grid--two/);
    await adminPage.setViewportSize({ width: 1440, height: 900 });
  });

  test("FT-HOME-015 Pin to everyone's Home adds the list to the Home draft, and others do not see it before publish", tags('@P1'), async () => {
    test.info().annotations.push({ type: 'not covered', description: 'The Home draft is not published, so the organisation Home stays as it was. Seeing it after publish is not run.' });
    const before = await definitionDetail(admin, 'page', 'home');
    try {
      await navigate(adminPage, `/records/${n.grant.key}`);
      await expect(adminPage.getByRole('heading', { name: renamedList, exact: true })).toBeVisible();
      await openListMenu(adminPage, label('ui.pins.pinEveryone'));
      await expect(adminPage.getByText(label('ui.pins.drafted'))).toBeVisible();
      const draft = (await definitionDetail(admin, 'page', 'home'))?.draft?.body['widgets'] as Body[] | undefined;
      expect(draft?.some((w) => w['type'] === 'list' && w['listView'] === n.grantList.key)).toBe(true);

      await signIn(page, accounts.finance.email, accounts.finance.name);
      await expect(page.getByRole('heading', { name: renamedList, exact: true })).toHaveCount(0);
    } finally {
      await restoreHome(admin, before);
    }
  });

  test('FT-E2E-06 members use the new module the same day, and nothing in old records changed', tags('@P0'), async () => {
    await navigate(page, '/records');
    const group = page.locator('section').filter({ has: page.getByRole('button', { name: n.group.name }) });
    await expect(group.getByRole('link', { name: n.grant.plural, exact: true })).toBeVisible();
    await expect(group.getByRole('link', { name: n.programme.plural, exact: true })).toBeVisible();
    await group.getByRole('link', { name: n.grant.plural, exact: true }).click();
    await expect(page.getByRole('heading', { name: renamedList, exact: true })).toBeVisible();

    const name = `Same-day grant ${n.suffix}`;
    await createRecord(page, n.grant.label, { Name: name });
    await expect(page.getByText(label('ui.records.createdMessage'))).toBeVisible();
    await expect(page.getByText(name).first()).toBeVisible();

    const now = await settledDonations(admin);
    for (const [id, version] of oldDonations) expect(now.get(id), `donation ${id}`).toBe(version);
    expect(await shippedVersions(config)).toEqual(shipped);
    const published = await definitionDetail(config, 'workflow', n.workflow.key);
    expect((published?.published?.body['transitions'] as Body[]).find((t) => t['key'] === n.award.key)).toEqual(awardStep(n));
  });
});
