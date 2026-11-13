import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const BASE = [
  'record:staff:read',
  'record:staff:create',
  'record:staff:update',
  'record:staff:transition:*',
  'record:staff:action:*',
  'record:staff:export',
  'record:staff:import',
  'record:staff:bulk',
  'record:payment:read',
];
let hr: Actor;
let clerk: Actor;
let staffId: string;
let fileId: string;

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
async function person(name: string, permissions: string[], roles: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name.toLowerCase()}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    for (const r of roles) await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, r]);
  });
  return { id: u!.id, roles, permissions };
}
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const as = (actor: Actor) => w.as(w.ngoA, actor);
const version = async (id: string) => (await w.platform.records.get(w.as(w.ngoA), id)).version;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  await w.platform.db.asSystem((tx) =>
    tx.query(
      `insert into role (tenant_id, key, label, permissions) values ($1, 'hr', 'HR', $2), ($1, 'staffers', 'Staffers', $3)`,
      [w.ngoA, ['record:staff:read', 'hr:salary', 'hr:grade'], ['record:staff:read']],
    ),
  );
  await publish('recordType', {
    key: 'staff',
    label: 'Staff member',
    pluralLabel: 'Staff',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'salary', label: 'Salary', type: 'money', readPermission: 'hr:salary' },
      { key: 'grade', label: 'Grade', type: 'text', editPermission: 'hr:grade' },
      { key: 'payslip', label: 'Payslip', type: 'file', readPermission: 'hr:salary' },
      { key: 'pan', label: 'PAN', type: 'text', sensitive: true },
    ],
  });
  await publish('recordType', {
    key: 'payment',
    label: 'Payment',
    fields: [
      { key: 'staff', label: 'Staff member', type: 'reference', referenceType: 'staff' },
      { key: 'amount', label: 'Amount', type: 'money', readPermission: 'hr:salary' },
    ],
  });
  await publish('workflow', {
    key: 'staff',
    recordType: 'staff',
    initial: 'active',
    states: [
      { key: 'active', label: 'Active' },
      { key: 'left', label: 'Left' },
    ],
    transitions: [{ key: 'leave', label: 'Leave', from: ['active'], to: 'left' }],
  });
  await publish('template', { key: 'payNote', subject: 'Pay for {{ record.name }}', body: 'Salary {{ record.salary }}, grade {{ record.grade }}' });
  await publish('action', { key: 'regrade', recordType: 'staff', label: 'Regrade', placement: ['panel', 'bulk'], steps: [{ type: 'setFields', values: { grade: "'B'" } }] });
  await publish('action', {
    key: 'tellPay',
    recordType: 'staff',
    label: 'Tell pay',
    placement: ['panel'],
    steps: [{ type: 'notify', template: 'payNote', to: { roles: ['hr', 'staffers'] }, channels: ['inApp'] }],
  });
  await publish('listView', {
    key: 'staff',
    recordType: 'staff',
    detail: {
      sections: [
        { label: 'Main', fields: ['name', 'grade'] },
        { label: 'Pay', permission: 'hr:salary', fields: ['salary', 'payslip'] },
        { label: 'Payments', permission: 'hr:salary', related: { recordType: 'payment', field: 'staff', total: 'amount' } },
      ],
    },
  });
  await publish('page', {
    key: 'people',
    label: 'People',
    widgets: [
      { type: 'stat', label: 'Staff', recordType: 'staff', measure: 'count' },
      { type: 'stat', label: 'Payroll', recordType: 'staff', measure: 'sum', field: 'salary', permission: 'hr:salary' },
      {
        type: 'links',
        label: 'Go',
        items: [
          { label: 'All staff', to: '/records/staff' },
          { label: 'Payroll', to: '/records/staff?chip=pay', permission: 'hr:salary' },
        ],
      },
      { type: 'links', label: 'HR only', items: [{ label: 'Grades', to: '/records/staff?chip=grades', permission: 'hr:grade' }] },
    ],
  });

  hr = await person('Hema', [...BASE, 'hr:salary', 'hr:grade', 'record:staff:sensitive'], ['hr']);
  clerk = await person('Kiran', BASE, ['staffers']);
  const file = await w.platform.files.upload(w.as(w.ngoA), { body: [Buffer.from('Payslip for April.\n')], name: 'slip.txt', recordType: 'staff', field: 'payslip' });
  fileId = file.id;
  const saved = await w.platform.records.create(w.as(w.ngoA), 'staff', { name: 'Meera', salary: 50000, grade: 'A', payslip: file.id, pan: 'ABCDE1234F' });
  staffId = saved.record.id;
  await w.platform.records.create(w.as(w.ngoA), 'payment', { staff: staffId, amount: 1200 });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('field read permission', () => {
  it('masks the value in get, query, related sections and exports for people without it', async () => {
    expect((await w.platform.records.get(as(clerk), staffId)).data).toMatchObject({ name: 'Meera', salary: '***', payslip: '***', grade: 'A', pan: '***' });
    expect((await w.platform.records.get(as(hr), staffId)).data).toMatchObject({ salary: 50000, payslip: fileId, pan: 'ABCDE1234F' });
    const { items } = await w.platform.records.query(as(clerk), 'staff', {});
    expect(items[0]!.data.salary).toBe('***');

    const related = await w.platform.records.query(as(clerk), 'payment', { filters: { staff: { eq: staffId } } });
    expect(related.items.map((r) => r.data.amount)).toEqual(['***']);
    expect((await w.platform.records.query(as(hr), 'payment', { filters: { staff: { eq: staffId } } })).items[0]!.data.amount).toBe(1200);

    const csv = await app.inject({ method: 'GET', url: '/api/records/staff/export.csv', headers: headers(clerk) });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('***');
    expect(csv.body).not.toContain('50000');
    expect(csv.body).not.toContain('slip.txt');
    const full = await app.inject({ method: 'GET', url: '/api/records/staff/export.csv', headers: headers(hr) });
    expect(full.body).toContain('50000');
  });

  it('refuses downloads of files in the field', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: headers(clerk) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: headers(hr) })).statusCode).toBe(200);
  });

  it('refuses filter, sort, sum and group on the field with 403 naming it', async () => {
    const filter = await expectCode(w.platform.records.query(as(clerk), 'staff', { filters: { salary: { from: 1 } } }), 'forbidden');
    expect(filter.message).toMatch(/'Salary' cannot be filtered/);
    expect((await expectCode(w.platform.records.query(as(clerk), 'staff', { sort: { field: 'salary' } }), 'forbidden')).message).toMatch(/'Salary' cannot be sorted/);
    expect((await expectCode(w.platform.records.query(as(clerk), 'staff', { sum: ['salary'] }), 'forbidden')).message).toMatch(/'Salary' cannot be totalled/);
    const agg = await expectCode(w.platform.aggregates.aggregate(as(clerk), 'staff', { measure: 'sum', field: 'salary' }), 'forbidden');
    expect(agg.message).toMatch(/'Salary' cannot be totalled/);
    const res = await app.inject({ method: 'POST', url: '/api/records/staff/query', headers: headers(clerk), payload: { filters: { salary: { from: 1 } } } });
    expect(res.statusCode).toBe(403);

    expect((await w.platform.records.query(as(hr), 'staff', { filters: { salary: { from: 1 } }, sort: { field: 'salary' }, sum: ['salary'] })).sums).toEqual({ salary: 50000 });
    expect(await w.platform.aggregates.aggregate(as(hr), 'staff', { measure: 'sum', field: 'salary' })).toEqual({ value: 50000 });
  });

  it('masks the field in notifications for recipients without it', async () => {
    await w.platform.actions.run(as(hr), 'staff', staffId, 'tellPay');
    await w.platform.dispatcher.runOnce();
    const [toHr] = await w.platform.notifications.inbox(as(hr));
    const [toClerk] = await w.platform.notifications.inbox(as(clerk));
    expect(toHr).toMatchObject({ subject: 'Pay for Meera', body: 'Salary 50000, grade A' });
    expect(toClerk).toMatchObject({ subject: 'Pay for Meera', body: 'Salary ***, grade A' });
  });

  it('keeps sensitive fields the same as readPermission record:<type>:sensitive', async () => {
    const plain = { ...clerk, permissions: [...BASE, 'record:staff:sensitive'] };
    expect((await w.platform.records.get(as(plain), staffId)).data).toMatchObject({ pan: 'ABCDE1234F', salary: '***' });
    const runtime = await w.platform.runtime.definitions(as(clerk));
    expect(runtime.recordTypes.find((t) => t.key === 'staff')!.fields.find((f) => f.key === 'pan')).toMatchObject({ masked: true });
    const bad = await w.platform.definitions.check(w.as(w.ngoA), 'recordType', {
      key: 'staff2',
      label: 'Staff',
      fields: [
        { key: 'pan', label: 'PAN', type: 'text', sensitive: true, readPermission: 'hr:salary' },
        { key: 'total', label: 'Total', type: 'number', calculated: '1 + 1', editPermission: 'hr:grade' },
      ],
    });
    expect(bad.errors.map((e) => e.path)).toEqual(['/fields/0/readPermission', '/fields/1/editPermission']);
    const same = await w.platform.definitions.check(w.as(w.ngoA), 'recordType', {
      key: 'staff2',
      label: 'Staff',
      fields: [{ key: 'pan', label: 'PAN', type: 'text', sensitive: true, readPermission: 'record:staff2:sensitive' }],
    });
    expect(same.errors).toEqual([]);
  });
});

describe('field edit permission', () => {
  it('refuses changes on update and create with 422 naming the field, and allows unchanged values and masked round trips', async () => {
    const err = await expectCode(
      w.platform.records.update(as(clerk), staffId, { data: { grade: 'B' }, expectedVersion: await version(staffId) }),
      'validation_failed',
    );
    expect((err as unknown as { issues: { path: string; message: string }[] }).issues).toEqual([{ path: '/grade', message: "you may not change 'Grade'" }]);
    await expectCode(w.platform.records.create(as(clerk), 'staff', { name: 'New', grade: 'C' }), 'validation_failed');
    await w.platform.records.create(as(clerk), 'staff', { name: 'New' });

    const current = await w.platform.records.get(as(clerk), staffId);
    const saved = await w.platform.records.update(as(clerk), staffId, { data: { ...current.data, name: 'Meera K' }, expectedVersion: current.version });
    expect(saved.record.data).toMatchObject({ name: 'Meera K', grade: 'A', salary: '***' });
    expect((await w.platform.records.get(as(hr), staffId)).data).toMatchObject({ salary: 50000, payslip: fileId, pan: 'ABCDE1234F' });

    const res = await app.inject({ method: 'PATCH', url: `/api/records/staff/${staffId}`, headers: headers(clerk), payload: { data: { grade: 'Z' }, expectedVersion: await version(staffId) } });
    expect(res.statusCode).toBe(422);
    expect(res.json().issues[0].message).toMatch(/Grade/);
  });

  it('refuses changes in steps, actions, bulk edits and imports', async () => {
    await expectCode(w.platform.records.transition(as(clerk), staffId, 'leave', { data: { grade: 'X' }, expectedVersion: await version(staffId) }), 'validation_failed');
    await expectCode(w.platform.actions.run(as(clerk), 'staff', staffId, 'regrade'), 'validation_failed');
    await expectCode(w.platform.bulk.run(as(clerk), 'staff', { ids: [staffId] }, { type: 'action', action: 'regrade' }), 'validation_failed');
    const bulk = await w.platform.bulk.run(as(clerk), 'staff', { ids: [staffId] }, { type: 'edit', values: { grade: 'Q' } });
    expect(bulk).toMatchObject({ done: 0, failed: 1 });

    const up = await app.inject({
      method: 'POST',
      url: '/api/records/staff/imports',
      headers: { ...headers(clerk), 'content-type': 'text/csv', 'x-file-name': 'staff.csv' },
      payload: Buffer.from('Name,Grade\nAnil,D\n'),
    });
    expect(up.statusCode, up.body).toBe(201);
    const id = up.json().id as string;
    expect((await app.inject({ method: 'PUT', url: `/api/imports/${id}/mapping`, headers: headers(clerk), payload: {} })).statusCode).toBe(200);
    const check = await w.platform.imports.check(as(clerk), id);
    expect(check.problems).toEqual([expect.objectContaining({ row: 2, message: expect.stringMatching(/Grade/) })]);

    await w.platform.actions.run(as(hr), 'staff', staffId, 'regrade');
    expect((await w.platform.records.get(as(hr), staffId)).data.grade).toBe('B');
  });
});

describe('runtime definitions', () => {
  it('omit sections, widgets and links the person cannot see, and mark fields masked or read-only', async () => {
    const mine = await w.platform.runtime.definitions(as(clerk));
    expect(mine.listViews.staff!.detail!.sections.map((s) => s.label)).toEqual(['Main']);
    const fields = mine.recordTypes.find((t) => t.key === 'staff')!.fields;
    expect(fields.find((f) => f.key === 'salary')).toMatchObject({ masked: true });
    expect(fields.find((f) => f.key === 'grade')).toMatchObject({ readOnly: true });
    expect(fields.find((f) => f.key === 'name')).not.toHaveProperty('masked');
    const page = mine.pages.find((p) => p.key === 'people')!;
    expect(page.widgets.map((x) => ('label' in x ? x.label : x.type))).toEqual(['Staff', 'Go']);
    expect(page.widgets[1]).toMatchObject({ items: [{ label: 'All staff', to: '/records/staff' }] });

    const theirs = await w.platform.runtime.definitions(as(hr));
    expect(theirs.listViews.staff!.detail!.sections.map((s) => s.label)).toEqual(['Main', 'Pay', 'Payments']);
    const hrFields = theirs.recordTypes.find((t) => t.key === 'staff')!.fields;
    expect(hrFields.some((f) => 'masked' in f || 'readOnly' in f)).toBe(false);
    expect(theirs.pages.find((p) => p.key === 'people')!.widgets).toHaveLength(4);
  });

  it('refuses aggregate requests for widgets the person cannot see', async () => {
    const ask = (actor: Actor, index: number) =>
      app.inject({ method: 'POST', url: '/api/records/staff/aggregate', headers: headers(actor), payload: { measure: 'count', widget: { page: 'people', index } } });
    expect((await ask(clerk, 0)).json()).toEqual({ value: 2 });
    expect((await ask(clerk, 1)).statusCode).toBe(403);
    expect((await ask(hr, 1)).statusCode).toBe(200);
    expect((await ask(clerk, 9)).statusCode).toBe(404);
  });
});

describe('permission suggestions, catalogue and access map', () => {
  const get = (actor: Actor, url: string) => app.inject({ method: 'GET', url, headers: headers(actor) });

  it('suggests generated permissions and every permission string used, with where and how many roles hold it', async () => {
    expect((await get(clerk, '/api/admin/permission-suggestions')).statusCode).toBe(403);
    const res = await get(admin, '/api/admin/permission-suggestions?q=hr:');
    expect(res.statusCode).toBe(200);
    const list = res.json() as { permission: string; source: string; roles: number; usedIn: { label: string; kind: string; key: string; path: string }[] }[];
    const salary = list.find((s) => s.permission === 'hr:salary')!;
    expect(salary).toMatchObject({ source: 'used', roles: 1 });
    expect(salary.usedIn.map((u) => `${u.kind}:${u.key} ${u.path}`)).toEqual([
      'recordType:payment /fields/1/readPermission',
      'recordType:staff /fields/1/readPermission',
      'recordType:staff /fields/3/readPermission',
      'listView:staff /detail/sections/1/permission',
      'listView:staff /detail/sections/2/permission',
      'page:people /widgets/1/permission',
      'page:people /widgets/2/items/1/permission',
    ]);
    expect(salary.usedIn[1]!.label).toBe('Salary (Staff member)');
    expect(list.map((s) => s.permission)).toEqual(expect.arrayContaining(['hr:salary', 'hr:grade']));
    const generated = (await get(admin, '/api/admin/permission-suggestions?q=record:staff:')).json() as { permission: string; source: string }[];
    expect(generated).toEqual(expect.arrayContaining([expect.objectContaining({ permission: 'record:staff:read', source: 'generated' })]));
  });

  it('adds a "Used in definitions" group to the permission catalogue', async () => {
    const catalogue = await w.platform.roles.catalogue(w.as(w.ngoA));
    expect(catalogue.groups.at(-1)).toEqual({ key: 'used', label: 'Used in definitions', kind: 'used' });
    expect(catalogue.entries.filter((e) => e.group === 'used').map((e) => e.permission)).toEqual(['hr:grade', 'hr:salary']);
  });

  it('lists every element with its permission, holders and warnings, and what a role sees', async () => {
    await publish('listView', {
      key: 'payments',
      recordType: 'payment',
      chips: [{ id: 'ghost', label: 'Ghost', permission: 'ghost:only' }],
    });
    expect((await get(clerk, '/api/admin/access-map')).statusCode).toBe(403);
    const map = (await get(admin, '/api/admin/access-map?recordType=staff')).json() as {
      elements: { element: string; access: string; label: string; permission: string; roles: string[]; warnings: string[]; overridable: boolean }[];
    };
    const salary = map.elements.find((e) => e.element === 'field' && e.access === 'see' && e.label.startsWith('Salary'))!;
    expect(salary).toMatchObject({ permission: 'hr:salary', roles: ['hr'], warnings: [], overridable: true });
    expect(map.elements.every((e) => e.label && e.element)).toBe(true);

    const problems = (await get(admin, '/api/admin/access-map?problems=true')).json() as { elements: { permission: string; warnings: string[] }[] };
    expect(problems.elements).toEqual([expect.objectContaining({ permission: 'ghost:only', warnings: ["No role has 'ghost:only' yet."] })]);

    const view = (await get(admin, '/api/admin/access-map?recordType=staff&role=staffers')).json() as {
      elements: { element: string; access: string; label: string; visible: boolean }[];
      role: { key: string; summary: string };
    };
    expect(view.elements.find((e) => e.element === 'field' && e.access === 'see' && e.label.startsWith('Salary'))!.visible).toBe(false);
    expect(view.elements.find((e) => e.element === 'field' && e.access === 'see' && e.label.startsWith('Name'))!.visible).toBe(true);
    expect(view.role.summary).toMatch(/^Staffers sees 1 of 1 record type; 3 fields are masked; .*hidden: 2 sections/);
    expect((await get(admin, '/api/admin/access-map?role=nobody')).statusCode).toBe(404);
    expect((await get(admin, '/api/admin/access-map?area=moon')).statusCode).toBe(422);
  });

  it('warns, without failing, on permission strings no role holds and on masked columns', async () => {
    const res = await w.platform.definitions.check(w.as(w.ngoA), 'listView', {
      key: 'staffTable',
      recordType: 'staff',
      columns: ['name', 'salary'],
      chips: [
        { id: 'a', label: 'A', permission: 'hr:salary' },
        { id: 'b', label: 'B', permission: 'nobody:yet' },
      ],
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings.map((x) => x.path)).toEqual(['/chips/1/permission', '/columns/1']);
  });
});
