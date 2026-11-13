import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { csvCell, csvLine, parseCsv } from '../src/infrastructure/transfer/csv.js';
import { parseCell, parseDate, parseNumber, suggestMapping, type ImportView } from '../src/application/records/import-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind, FieldDef, RecordTypeDef } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

describe('CSV reading and writing', () => {
  it('reads quotes, doubled quotes, line breaks inside cells, CRLF and LF, and a byte-order mark', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\n"two\r\nlines",\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\r\nlines', ''],
    ]);
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(() => parseCsv('a,"never closed\nb')).toThrow(/never closed/);
  });

  it('writes cells that round-trip and cannot run as spreadsheet formulas', () => {
    expect(csvLine(['plain', 'a,b', 'say "hi"', 'two\nlines'])).toBe('plain,"a,b","say ""hi""","two\nlines"\r\n');
    expect(csvCell('=SUM(1,2)')).toBe(`"'=SUM(1,2)"`);
    for (const v of ['+1', '-cmd', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell('-250.50')).toBe('-250.50');
    expect(csvCell('+91 98765 43210')).toBe('+91 98765 43210');
    const row = ['x, y', 'say "hi"', 'two\r\nlines', '=SUM(1,2)', '+91 98765 43210'];
    expect(parseCsv(csvLine(row))).toEqual([row]);
  });
});

describe('reading cells', () => {
  const f = (type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({ key: 'x', label: 'X', type, ...extra });

  it('reads numbers with Indian or western grouping and dates as dd/mm/yyyy or ISO', () => {
    expect(parseNumber('1,00,000')).toBe(100000);
    expect(parseNumber('10,00,000.50')).toBe(1000000.5);
    expect(parseNumber('1,000,000')).toBe(1000000);
    expect(parseNumber('₹ 2,500')).toBe(2500);
    expect(parseNumber('-42')).toBe(-42);
    for (const bad of ['12,34', '1,2,3', 'abc', '1.2.3', '']) expect(parseNumber(bad)).toBeNull();
    expect(parseDate('05/04/2026')).toBe('2026-04-05');
    expect(parseDate('5-4-2026')).toBe('2026-04-05');
    expect(parseDate('2026-04-06')).toBe('2026-04-06');
    expect(parseDate('2026-04-06T10:00:00Z')).toBe('2026-04-06');
    for (const bad of ['31/02/2026', '2026-13-01', '04/2026', '13/13/13']) expect(parseDate(bad)).toBeNull();
  });

  it('reads booleans, choices by label or value, several choices and locations', () => {
    expect(parseCell(f('boolean'), 'Yes')).toEqual({ value: true });
    expect(parseCell(f('boolean'), 'FALSE')).toEqual({ value: false });
    expect(parseCell(f('boolean'), 'maybe')).toHaveProperty('error');
    const choices = [
      { value: 'upi', label: 'UPI' },
      { value: 'bank_transfer', label: 'Bank transfer' },
    ];
    expect(parseCell(f('choice', { choices }), 'bank transfer')).toEqual({ value: 'bank_transfer' });
    expect(parseCell(f('choice', { choices }), 'bank_transfer')).toEqual({ value: 'bank_transfer' });
    expect(parseCell(f('choice', { choices }), 'Cash')).toHaveProperty('error');
    expect(parseCell(f('multiChoice', { choices }), 'UPI; bank_transfer')).toEqual({ value: ['upi', 'bank_transfer'] });
    expect(parseCell(f('location'), '12.97, 77.59')).toEqual({ value: { lat: 12.97, lng: 77.59 } });
    expect(parseCell(f('money'), '1,00,000')).toEqual({ value: 100000 });
  });

  it('suggests fields by label or key, each field once, never calculated or file fields', () => {
    const type = {
      key: 't',
      label: 'T',
      fields: [
        { key: 'givenOn', label: 'Given on', type: 'date' },
        { key: 'code', label: 'Reference code', type: 'text' },
        { key: 'total', label: 'Total', type: 'money', calculated: '1' },
        { key: 'photo', label: 'Photo', type: 'file' },
      ],
    } as RecordTypeDef;
    expect(suggestMapping(type, ['GIVEN ON', 'code', 'Given_on', 'Total', 'Photo', 'Other'])).toEqual({
      'GIVEN ON': 'givenOn',
      code: 'code',
      Given_on: null,
      Total: null,
      Photo: null,
      Other: null,
    });
  });
});

let w: TestWorld;
let app: FastifyInstance;
const donors: Record<string, { id: string; number: string }> = {};
let campaignId: string;

const GIFT = [
  'record:gift:create',
  'record:gift:read',
  'record:gift:update',
  'record:gift:import',
  'record:gift:export',
  'record:donor:read',
  'record:donor:sensitive',
  'record:campaign:read',
];
let importer: Actor;
let quietImporter: Actor;
const reader: Actor = { id: 'reader-1', roles: [], permissions: ['record:gift:read', 'record:gift:export', 'record:donor:read'] };

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
async function member(name: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    // Import and export jobs act with the person's current roles (S4-12), so the permissions must be held through a role.
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [w.ngoA, `held-${name}`, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, `held-${name}`]);
  });
  return { id: u!.id, roles: [], permissions };
}
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const upload = (actor: Actor, csv: string | Buffer, name = 'gifts.csv', type = 'gift') =>
  app.inject({
    method: 'POST',
    url: `/api/records/${type}/imports`,
    headers: { ...headers(actor), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(name) },
    payload: Buffer.isBuffer(csv) ? csv : Buffer.from(csv),
  });
async function uploaded(actor: Actor, csv: string): Promise<ImportView> {
  const res = await upload(actor, csv);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ImportView;
}
const mapping = (actor: Actor, id: string, body: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/imports/${id}/mapping`, headers: headers(actor), payload: body });
const exportCsv = (actor: Actor, type: string, query?: Record<string, unknown>) =>
  app.inject({
    method: 'GET',
    url: `/api/records/${type}/export.csv${query ? `?q=${Buffer.from(JSON.stringify(query)).toString('base64url')}` : ''}`,
    headers: headers(actor),
  });
const gifts = async () => (await w.platform.records.query(w.as(w.ngoA), 'gift', { limit: 200, sort: { field: 'number', dir: 'asc' } })).items;
const count = async (sql: string, args: unknown[] = []) =>
  Number((await w.platform.db.asSystem((tx) => tx.query<{ n: number }>(sql, args)))[0]!.n);

const FIRST = [
  'Title,Donor,Amount,Mode,Given on,Anonymous,Code,Campaign,Comment',
  'Gift one,DNR/00001,"1,00,000",UPI,05/04/2026,yes,G-1,Monsoon,ignored',
  'Gift two,ravi kumar,"2,500.50",bank_transfer,2026-04-06,No,G-2,Monsoon,',
  'Gift three,PQRSX6789Z,750,Bank transfer,31/12/2025,true,G-3,,',
  ',,,,,,,,',
  'Gift four,Meena,10,Cash,31/02/2026,maybe,G-4,,',
].join('\r\n');

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  importer = await member('importer', GIFT);
  quietImporter = await member('quiet', [...GIFT, 'record:gift:import:quiet']);
  const campaign = { key: 'campaign', label: 'Campaign', titleField: 'name', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] };
  await publish('recordType', campaign);
  await publish('recordType', {
    key: 'gift',
    label: 'Gift',
    pluralLabel: 'Gifts',
    titleField: 'title',
    numbering: { sequence: 'gift', format: 'GFT/{seq:4}', reset: 'never' },
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'donor', label: 'Donor', type: 'reference', referenceType: 'donor' },
      { key: 'amount', label: 'Amount', type: 'money', required: true, min: 1 },
      {
        key: 'mode',
        label: 'Mode',
        type: 'choice',
        choices: [
          { value: 'upi', label: 'UPI' },
          { value: 'bank_transfer', label: 'Bank transfer' },
        ],
      },
      { key: 'givenOn', label: 'Given on', type: 'date' },
      { key: 'anonymous', label: 'Anonymous', type: 'boolean' },
      { key: 'code', label: 'Code', type: 'text', unique: true },
      { key: 'campaign', label: 'Campaign', type: 'reference', referenceType: 'campaign' },
      { key: 'tag', label: 'Tag', type: 'text' },
      { key: 'secret', label: 'Secret', type: 'text', sensitive: true },
    ],
  });
  await publish('recordType', {
    ...campaign,
    fields: [...campaign.fields, { key: 'gifts', label: 'Gifts', type: 'number', rollup: { recordType: 'gift', reference: 'campaign', measure: 'count' } }],
  });
  await publish('automation', {
    key: 'giftStamp',
    recordType: 'gift',
    trigger: { event: 'created' },
    actions: [{ type: 'setFields', values: { tag: "'auto'" } }],
  });
  const ctx = w.as(w.ngoA);
  for (const [k, data] of [
    ['asha', { name: 'Asha Rao', pan: 'ABCDE1234F' }],
    ['ravi', { name: 'Ravi Kumar', pan: 'PQRSX6789Z' }],
    ['meena1', { name: 'Meena' }],
    ['meena2', { name: 'Meena' }],
  ] as const) {
    const { record } = await w.platform.records.create(ctx, 'donor', data);
    donors[k] = { id: record.id, number: record.number! };
  }
  expect(donors.asha!.number).toBe('DNR/00001');
  campaignId = (await w.platform.records.create(ctx, 'campaign', { name: 'Monsoon' })).record.id;
  await w.platform.dispatcher.runOnce();
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('import upload and column matching', () => {
  it('stores the file and the columns, and suggests fields by label and key', async () => {
    const view = await uploaded(importer, FIRST);
    expect(view).toMatchObject({ type: 'gift', fileName: 'gifts.csv', rowCount: 4, status: 'uploaded', mapping: null, jobId: null });
    expect(view.columns.map((c) => c.name)).toEqual(['Title', 'Donor', 'Amount', 'Mode', 'Given on', 'Anonymous', 'Code', 'Campaign', 'Comment']);
    expect(view.columns[0]!.samples).toEqual(['Gift one', 'Gift two', 'Gift three']);
    expect(view.suggested).toEqual({
      Title: 'title',
      Donor: 'donor',
      Amount: 'amount',
      Mode: 'mode',
      'Given on': 'givenOn',
      Anonymous: 'anonymous',
      Code: 'code',
      Campaign: 'campaign',
      Comment: null,
    });
    const [file] = await w.platform.db.asSystem((tx) => tx.query<{ mime: string; created_by: string }>(`select mime, created_by from file_object where id = $1`, [view.fileId]));
    expect(file).toEqual({ mime: 'text/csv', created_by: importer.id });
  });

  it('refuses other files, files over 10 MB or 20,000 rows, and people without the import permission', async () => {
    expect((await upload(importer, FIRST, 'gifts.txt')).statusCode).toBe(422);
    expect((await upload(reader, FIRST)).statusCode).toBe(403);
    expect((await upload(importer, 'Title\r\n')).json().message).toMatch(/no rows/);
    const many = ['Title', ...Array.from({ length: 20_001 }, (_, i) => `G${i}`)].join('\n');
    expect((await upload(importer, many)).json().message).toMatch(/20000 can be imported/);
    const big = Buffer.alloc(10 * 1024 * 1024 + 10, 'a');
    const res = await upload(importer, big);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/larger than 10 MB/);
  });

  it('confirms or overrides matches, and refuses unknown columns, fields filled twice and non-unique update keys', async () => {
    const view = await uploaded(importer, 'title,Amount,Notes\nA,1,x\n');
    expect(view.suggested).toEqual({ title: 'title', Amount: 'amount', Notes: null });
    const res = await mapping(importer, view.id, { columns: { Notes: 'tag' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'mapped', mapping: { columns: { title: 'title', Amount: 'amount', Notes: 'tag' } } });
    expect((await mapping(importer, view.id, { columns: { Nope: 'tag' } })).statusCode).toBe(422);
    expect((await mapping(importer, view.id, { columns: { Notes: 'title' } })).json().message).toMatch(/More than one column/);
    expect((await mapping(importer, view.id, { columns: { Notes: 'unknownField' } })).statusCode).toBe(422);
    expect((await mapping(importer, view.id, { updateBy: 'title' })).json().message).toMatch(/unique field/);
    expect((await mapping(importer, view.id, { updateBy: 'code' })).json().message).toMatch(/Match a column/);
    expect((await mapping(importer, view.id, { quiet: true })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/imports/${view.id}`, headers: headers(quietImporter) })).statusCode).toBe(404);
  });
});

describe('import check and run', () => {
  let first: ImportView;

  it('checks every row without saving: no records, events, numbers, audit or script log', async () => {
    first = await uploaded(importer, FIRST);
    expect((await mapping(importer, first.id, {})).statusCode).toBe(200);
    const before = {
      records: await count(`select count(*)::int as n from record where type_key = 'gift'`),
      events: await count(`select count(*)::int as n from outbox_event`),
      numbers: await count(`select count(*)::int as n from sequence_counter where key = 'record:gift'`),
      audit: await count(`select count(*)::int as n from audit_event where entity = 'record:gift'`),
      scripts: await count(`select count(*)::int as n from script_run`),
    };
    const res = await app.inject({ method: 'POST', url: `/api/imports/${first.id}/check`, headers: headers(importer) });
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result).toMatchObject({ rows: 4, valid: 3, invalid: 1, creates: 3, updates: 0 });
    expect(result.problems).toEqual([
      { row: 6, column: 'Donor', field: 'donor', message: 'Donor matches more than one donor' },
      { row: 6, column: 'Mode', field: 'mode', message: 'Mode is not one of the choices (UPI, Bank transfer)' },
      { row: 6, column: 'Given on', field: 'givenOn', message: 'Given on is not a date (use dd/mm/yyyy or yyyy-mm-dd)' },
      { row: 6, column: 'Anonymous', field: 'anonymous', message: 'Anonymous must be yes or no' },
    ]);
    expect({
      records: await count(`select count(*)::int as n from record where type_key = 'gift'`),
      events: await count(`select count(*)::int as n from outbox_event`),
      numbers: await count(`select count(*)::int as n from sequence_counter where key = 'record:gift'`),
      audit: await count(`select count(*)::int as n from audit_event where entity = 'record:gift'`),
      scripts: await count(`select count(*)::int as n from script_run`),
    }).toEqual(before);
    expect((await w.platform.imports.get(w.as(w.ngoA, importer), first.id)).status).toBe('checked');
  });

  it('reports the record engine’s own checks: required fields, rules, unique values and permissions', async () => {
    const view = await uploaded(importer, 'Title,Amount,Code\n,5,X-1\nOk,0,X-2\nDup,5,X-3\nDup again,5,X-3\n');
    await mapping(importer, view.id, {});
    const result = await w.platform.imports.check(w.as(w.ngoA, importer), view.id);
    expect(result).toMatchObject({ rows: 4, valid: 1, invalid: 3 });
    expect(result.problems).toEqual([
      { row: 2, field: 'title', column: 'Title', message: 'Title is required' },
      { row: 3, field: 'amount', column: 'Amount', message: 'Amount must be at least 1.' },
      { row: 5, field: 'code', column: 'Code', message: 'Row 4 of the file has the same Code.' },
    ]);
    const noCreate: Actor = { ...importer, permissions: importer.permissions.filter((p) => p !== 'record:gift:create') };
    const denied = await w.platform.imports.check(w.as(w.ngoA, noCreate), view.id);
    expect(denied.valid).toBe(0);
    expect(denied.problems[0]!.message).toMatch(/permission/);
  });

  it('runs as an import job: rows saved through the pipeline, rollups once at the end, failures kept with the reason', async () => {
    const recompute = vi.spyOn(w.platform.records, 'recomputeRollups');
    const run = await app.inject({ method: 'POST', url: `/api/imports/${first.id}/run`, headers: headers(importer) });
    expect(run.statusCode).toBe(202);
    const view = run.json() as ImportView;
    expect(view.status).toBe('running');
    expect((await app.inject({ method: 'POST', url: `/api/imports/${first.id}/run`, headers: headers(importer) })).statusCode).toBe(409);
    await w.platform.jobs.runOnce();
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(recompute.mock.calls[0]![1]).toEqual([campaignId]);
    recompute.mockRestore();

    const done = (await app.inject({ method: 'GET', url: `/api/imports/${first.id}`, headers: headers(importer) })).json() as ImportView;
    expect(done).toMatchObject({ status: 'done', jobId: view.jobId, counts: { created: 3, updated: 0, failed: 1 } });
    const job = await w.platform.jobs.get(w.as(w.ngoA, importer), view.jobId!);
    expect(job).toMatchObject({ kind: 'import', status: 'done', progress: 4, total: 4 });

    const list = await gifts();
    expect(list.map((g) => [g.number, g.data.title])).toEqual([
      ['GFT/0001', 'Gift one'],
      ['GFT/0002', 'Gift two'],
      ['GFT/0003', 'Gift three'],
    ]);
    expect(list[0]!.data).toMatchObject({ donor: donors.asha!.id, amount: 100000, mode: 'upi', givenOn: '2026-04-05', anonymous: true, code: 'G-1', campaign: campaignId });
    expect(list[1]!.data).toMatchObject({ donor: donors.ravi!.id, amount: 2500.5, mode: 'bank_transfer', givenOn: '2026-04-06', anonymous: false });
    expect(list[2]!.data).toMatchObject({ donor: donors.ravi!.id, mode: 'bank_transfer', givenOn: '2025-12-31' });
    expect((await w.platform.records.get(w.as(w.ngoA), campaignId)).data.gifts).toBe(2);

    await w.platform.dispatcher.runOnce();
    expect((await gifts()).map((g) => g.data.tag)).toEqual(['auto', 'auto', 'auto']);
    const [note] = await w.platform.notifications.inbox(w.as(w.ngoA, importer));
    expect(note).toMatchObject({ subject: 'Import finished', body: 'Import finished: 3 created, 0 updated, 1 failed.', link: `/records/gift?import=${first.id}&importStep=5` });

    const failed = await app.inject({ method: 'GET', url: `/api/imports/${first.id}/failed.csv`, headers: headers(importer) });
    expect(failed.statusCode).toBe(200);
    expect(failed.headers['content-type']).toMatch(/^text\/csv/);
    const rows = parseCsv(failed.body);
    expect(rows[0]).toEqual(['Title', 'Donor', 'Amount', 'Mode', 'Given on', 'Anonymous', 'Code', 'Campaign', 'Comment', 'Reason']);
    expect(rows.slice(1).map((r) => r.slice(0, 9))).toEqual([['Gift four', 'Meena', '10', 'Cash', '31/02/2026', 'maybe', 'G-4', '', '']]);
    expect(rows[1]![9]).toMatch(/^Donor matches more than one donor; Mode is not one of the choices/);
  });

  it('writes a failed row’s phone number plainly, so the file imports once its reason is fixed', async () => {
    await publish('recordType', {
      key: 'caller',
      label: 'Caller',
      pluralLabel: 'Callers',
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'phone', label: 'Phone', type: 'phone' },
      ],
    });
    const caller = await member('caller', ['record:caller:create', 'record:caller:read', 'record:caller:import']);
    const callers = async (csv: string): Promise<ImportView> => {
      const res = await upload(caller, csv, 'callers.csv', 'caller');
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as ImportView;
    };
    const bad = await callers('Name,Phone\n,+91 98765 43210\n');
    await mapping(caller, bad.id, {});
    await w.platform.imports.run(w.as(w.ngoA, caller), bad.id);
    await w.platform.jobs.runOnce();
    expect((await w.platform.imports.get(w.as(w.ngoA, caller), bad.id)).counts).toEqual({ created: 0, updated: 0, failed: 1 });

    const failed = await app.inject({ method: 'GET', url: `/api/imports/${bad.id}/failed.csv`, headers: headers(caller) });
    expect(failed.body).toContain('+91 98765 43210');
    expect(failed.body).not.toContain(`'+91`);

    const fixed = await callers(failed.body.replace('\r\n,', '\r\nRanjan,'));
    await mapping(caller, fixed.id, {});
    expect(await w.platform.imports.check(w.as(w.ngoA, caller), fixed.id)).toMatchObject({ rows: 1, valid: 1, invalid: 0 });
    await w.platform.imports.run(w.as(w.ngoA, caller), fixed.id);
    await w.platform.jobs.runOnce();
    expect((await w.platform.imports.get(w.as(w.ngoA, caller), fixed.id)).counts).toEqual({ created: 1, updated: 0, failed: 0 });
    const [made] = (await w.platform.records.query(w.as(w.ngoA, caller), 'caller', { limit: 10 })).items;
    expect(made!.data).toMatchObject({ name: 'Ranjan', phone: '+91 98765 43210' });
  });

  it('matches references by a sensitive unique field only for people who may see it', async () => {
    const noSensitive = await member('plain', GIFT.filter((p) => p !== 'record:donor:sensitive'));
    const view = await uploaded(noSensitive, 'Title,Amount,Donor\nP,5,ABCDE1234F\nQ,5,Asha Rao\n');
    await mapping(noSensitive, view.id, {});
    const result = await w.platform.imports.check(w.as(w.ngoA, noSensitive), view.id);
    expect(result.problems).toEqual([{ row: 2, column: 'Donor', field: 'donor', message: 'Donor does not match any donor' }]);
  });

  it('creates or updates by a unique field', async () => {
    const view = await uploaded(importer, 'Code,Amount,Title\ng-1,500,\nG-9,20,Gift nine\n');
    expect((await mapping(importer, view.id, { updateBy: 'code' })).json().mapping).toMatchObject({ updateBy: 'code' });
    expect(await w.platform.imports.check(w.as(w.ngoA, importer), view.id)).toMatchObject({ valid: 2, creates: 1, updates: 1 });
    await w.platform.imports.run(w.as(w.ngoA, importer), view.id);
    await w.platform.jobs.runOnce();
    expect((await w.platform.imports.get(w.as(w.ngoA, importer), view.id)).counts).toEqual({ created: 1, updated: 1, failed: 0 });
    const list = await gifts();
    expect(list.find((g) => g.data.title === 'Gift one')!.data).toMatchObject({ code: 'g-1', amount: 500, mode: 'upi' });
    expect(list.find((g) => g.data.code === 'G-9')!.data).toMatchObject({ title: 'Gift nine', amount: 20 });
    expect(list).toHaveLength(4);
  });

  it('runs quietly, without automations, only with the quiet permission', async () => {
    const view = await uploaded(quietImporter, 'Title,Amount\nQuiet one,5\n');
    await mapping(quietImporter, view.id, { quiet: true });
    const stripped: Actor = { ...quietImporter, permissions: GIFT };
    await expectCode(w.platform.imports.run(w.as(w.ngoA, stripped), view.id), 'forbidden');
    await w.platform.imports.run(w.as(w.ngoA, quietImporter), view.id);
    await w.platform.jobs.runOnce();
    const [event] = await w.platform.db.asSystem((tx) =>
      tx.query<{ payload: { quiet?: boolean } }>(`select payload from outbox_event where type = 'record.created' and payload->>'type' = 'gift' order by created_at desc, id desc limit 1`),
    );
    expect(event!.payload.quiet).toBe(true);
    await w.platform.dispatcher.runOnce();
    const quiet = (await gifts()).find((g) => g.data.title === 'Quiet one')!;
    expect(quiet.data.tag).toBeUndefined();
  });
});

describe('CSV export', () => {
  it('streams the readable fields of the list query, masking sensitive ones and defusing formulas', async () => {
    await w.platform.records.create(w.as(w.ngoA), 'gift', { title: '=SUM(1,2) "total"', amount: 9, secret: 's3cret', donor: donors.asha!.id });
    const res = await exportCsv(importer, 'gift', { search: 'sum(1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Gifts \d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual(['Number', 'Title', 'Donor', 'Amount', 'Mode', 'Given on', 'Anonymous', 'Code', 'Campaign', 'Tag', 'Secret']);
    expect(rows).toHaveLength(2);
    const [row] = rows.slice(1);
    expect(res.body).toContain(`"'=SUM(1,2) ""total"""`);
    expect([row![1], row![2], row![3], row![10]]).toEqual(['=SUM(1,2) "total"', 'DNR/00001', '9', '***']);
    const asAdmin = parseCsv((await exportCsv(admin, 'gift', { search: 'sum(1' })).body);
    expect(asAdmin[1]![10]).toBe('s3cret');

    const all = parseCsv((await exportCsv(importer, 'gift', { sort: { field: 'number', dir: 'asc' } })).body);
    expect(all.slice(1, 3).map((r) => [r[0], r[4], r[5], r[6]])).toEqual([
      ['GFT/0001', 'UPI', '2026-04-05', 'Yes'],
      ['GFT/0002', 'Bank transfer', '2026-04-06', 'No'],
    ]);
    expect(all[1]![8]).toBe('Monsoon');
  });

  it('needs the export permission and a valid query', async () => {
    const noExport: Actor = { ...reader, permissions: ['record:gift:read'] };
    expect((await exportCsv(noExport, 'gift')).statusCode).toBe(403);
    const bad = await app.inject({ method: 'GET', url: `/api/records/gift/export.csv?q=${Buffer.from('not json').toString('base64url')}`, headers: headers(importer) });
    expect(bad.statusCode).toBe(422);
    expect((await exportCsv(importer, 'gift', { filters: { secret: { eq: 'x' } } })).statusCode).toBe(403);
  });

  it('respects restricted visibility', async () => {
    await publish('recordType', {
      key: 'casefile',
      label: 'Case file',
      titleField: 'title',
      visibility: 'restricted',
      fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
    });
    const perms = ['record:casefile:create', 'record:casefile:read', 'record:casefile:export'];
    const owner: Actor = { id: 'owner-1', roles: [], permissions: perms };
    const other: Actor = { id: 'other-1', roles: [], permissions: perms };
    await w.platform.records.create(w.as(w.ngoA, owner), 'casefile', { title: 'Mine A' });
    await w.platform.records.create(w.as(w.ngoA, owner), 'casefile', { title: 'Mine B' });
    await w.platform.records.create(w.as(w.ngoA, other), 'casefile', { title: 'Theirs' });
    const titles = async (actor: Actor) => parseCsv((await exportCsv(actor, 'casefile')).body).slice(1).map((r) => r[0]).sort();
    expect(await titles(other)).toEqual(['Theirs']);
    expect(await titles(owner)).toEqual(['Mine A', 'Mine B']);
    expect(await titles(admin)).toEqual(['Mine A', 'Mine B', 'Theirs']);
  });
});

describe('large exports', () => {
  let small: TestWorld;
  let smallApp: FastifyInstance;
  beforeAll(async () => {
    small = await createWorld({ autoRunJobs: false, exportInlineRows: 2 });
    smallApp = buildServer(small.platform, { devAuth: true });
    for (const [name, pan] of [
      ['One', 'AAAAA1111A'],
      ['Two', 'BBBBB2222B'],
      ['Three', 'CCCCC3333C'],
    ]) {
      await small.platform.records.create(small.as(small.ngoA), 'donor', { name, pan });
    }
  });
  afterAll(async () => {
    await smallApp?.close();
    await small?.close();
  });

  it('becomes an export job above the inline limit, with a file only the requester can download', async () => {
    const requester: Actor = { id: 'exporter-1', roles: [], permissions: ['record:donor:read', 'record:donor:export'] };
    const h = (actor: Actor) => ({ 'x-dev-tenant': small.ngoA, 'x-dev-actor': JSON.stringify(actor) });
    const inline = await smallApp.inject({ method: 'GET', url: `/api/records/donor/export.csv?q=${Buffer.from(JSON.stringify({ search: 'one' })).toString('base64url')}`, headers: h(requester) });
    expect(inline.statusCode).toBe(200);
    expect(parseCsv(inline.body)).toHaveLength(2);

    const res = await smallApp.inject({ method: 'GET', url: '/api/records/donor/export.csv', headers: h(requester) });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    await small.platform.jobs.runOnce();
    const job = await small.platform.jobs.get(small.as(small.ngoA, requester), jobId);
    expect(job).toMatchObject({ kind: 'export', status: 'done', progress: 3, result: { rows: 3, recordType: 'donor' } });
    const fileId = String(job.result!.fileId);
    const download = await smallApp.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: h(requester) });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^text\/csv/);
    const rows = parseCsv(download.body);
    expect(rows[0]!.slice(0, 3)).toEqual(['Number', 'Name', 'Email']);
    expect(rows.slice(1).map((r) => r[1]).sort()).toEqual(['One', 'Three', 'Two']);
    expect(rows.slice(1).every((r) => r[4] === '***')).toBe(true);
    const someoneElse: Actor = { ...requester, id: 'exporter-2' };
    expect((await smallApp.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: h(someoneElse) })).statusCode).toBe(404);
    const [owner] = await small.platform.db.asSystem((tx) => tx.query<{ created_by: string }>(`select created_by from file_object where id = $1`, [fileId]));
    expect(owner!.created_by).toBe('exporter-1');
    expect(readdirSync(join(small.filesDir!, small.ngoA)).filter((n) => n.startsWith('export-'))).toEqual([]);
  });
});
