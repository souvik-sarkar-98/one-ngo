import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { KeyRing, parseKey, parseKeys } from '@onengo/kernel/crypto';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { MemoryLogger } from '@onengo/kernel/observability';
import type { DefinitionKind, RecordTypeDef } from '../src/runtime/definitions/types.js';
import { createPlatform, type Platform } from '../src/platform.js';
import { SensitiveFields } from '../src/runtime/records/sensitive.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const BASE = ['record:client:read', 'record:client:create', 'record:client:update', 'record:client:export', 'record:client:transition:*'];
const SEALED = /^enc:v1:[0-9a-f]{8}:[A-Za-z0-9_-]+$/;

let w: TestWorld;
let app: FastifyInstance;
let caseworker: Actor;
let volunteer: Actor;
let clientId: string;

const as = (actor: Actor) => w.as(w.ngoA, actor);
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
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
/** The record as stored, read past the application. */
async function stored(id: string) {
  const [row] = await w.platform.db.asSystem((tx) =>
    tx.query<{ data: Record<string, unknown>; blind_index: Record<string, string>; search_text: string | null }>(
      `select data, blind_index, search_text from record where id = $1`,
      [id],
    ),
  );
  return row!;
}
const keyIdOf = (key: Buffer) => new KeyRing(key).currentId;
const second = (encryptionKey: Buffer, previousEncryptionKeys?: Buffer[]) =>
  createPlatform(w.platform.db, {
    tokenSecret: randomBytes(32).toString('hex'),
    encryptionKey,
    previousEncryptionKeys,
    definitionCacheCheckMs: 0,
    autoRunJobs: false,
    logger: new MemoryLogger(),
  });
async function runJobs(p: Platform, ids: string[]) {
  for (let i = 0; i < 20; i++) {
    await p.jobs.runOnce();
    const jobs = await Promise.all(ids.map((id) => p.jobs.get(w.as(w.ngoA), id)));
    if (jobs.every((j) => j.status === 'done' || j.status === 'failed')) return jobs;
  }
  throw new Error('The jobs did not finish.');
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, encryptionKey: oldKey });
  app = buildServer(w.platform, { devAuth: true });
  await w.platform.db.asSystem((tx) =>
    tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'caseworker', 'Caseworker', $2), ($1, 'volunteer', 'Volunteer', $3)`, [
      w.ngoA,
      ['record:client:read', 'record:client:sensitive'],
      ['record:client:read'],
    ]),
  );
  await publish('recordType', {
    key: 'client',
    label: 'Client',
    titleField: 'name',
    numbering: { sequence: 'client', format: 'CL/{seq:3}', reset: 'never' },
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'pan', label: 'PAN', type: 'text', sensitive: true, unique: true, searchable: true },
      { key: 'income', label: 'Income', type: 'money', sensitive: true },
      { key: 'history', label: 'History', type: 'longText', sensitive: true },
      { key: 'tag', label: 'Tag', type: 'text' },
    ],
  });
  await publish('recordType', {
    key: 'visit',
    label: 'Visit',
    fields: [
      { key: 'client', label: 'Client', type: 'reference', referenceType: 'client' },
      { key: 'clientPan', label: 'Client PAN', type: 'text', sensitive: true, copyFrom: { reference: 'client', field: 'pan' } },
    ],
  });
  await publish('workflow', {
    key: 'client',
    recordType: 'client',
    initial: 'open',
    states: [
      { key: 'open', label: 'Open' },
      { key: 'verified', label: 'Verified' },
    ],
    transitions: [{ key: 'verify', label: 'Verify', from: ['open'], to: 'verified', approval: { roles: ['caseworker'] } }],
  });
  await publish('template', { key: 'intake', subject: 'New client {{ record.name }}', body: 'PAN {{ record.pan }}, tag {{ record.tag }}' });
  await publish('automation', {
    key: 'intake',
    recordType: 'client',
    trigger: { event: 'created' },
    condition: "record.pan == 'ABCDE1234F'",
    actions: [
      { type: 'setFields', values: { tag: "'checked'" } },
      { type: 'notify', template: 'intake', to: { roles: ['caseworker', 'volunteer'] }, channels: ['inApp'] },
    ],
  });
  caseworker = await person('Chitra', [...BASE, 'record:client:sensitive'], ['caseworker']);
  volunteer = await person('Vikram', BASE, ['volunteer']);
  const { record } = await w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Asha Rao', pan: 'ABCDE1234F', income: 120000.5, history: 'Lost her job in May.' });
  clientId = record.id;
  await w.platform.dispatcher.runOnce();
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('sensitive values at rest', () => {
  it('stores sensitive values as ciphertext under the current key, with a keyed hash for unique ones', async () => {
    const row = await stored(clientId);
    for (const k of ['pan', 'income', 'history']) {
      expect(row.data[k]).toMatch(SEALED);
      expect(String(row.data[k]).split(':')[2]).toBe(keyIdOf(oldKey));
    }
    expect(row.data).toMatchObject({ name: 'Asha Rao', tag: 'checked' });
    expect(JSON.stringify(row.data)).not.toMatch(/ABCDE1234F|120000|Lost her job/);
    expect(Object.keys(row.blind_index)).toEqual(['pan']);
    expect(row.blind_index.pan).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps sensitive plaintext out of the search text and the audit trail', async () => {
    const row = await stored(clientId);
    expect(row.search_text).toContain('asha rao');
    expect(row.search_text).not.toMatch(/abcde1234f|enc:/);
    const audit = await w.platform.db.asSystem((tx) =>
      tx.query<{ before: unknown; after: unknown }>(`select before, after from audit_event where entity_id = $1 order by id`, [clientId]),
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(audit);
    expect(text).not.toMatch(/ABCDE1234F|120000|Lost her job|enc:v1/);
    expect(audit[0]!.after).toMatchObject({ data: { name: 'Asha Rao', pan: '***', income: '***', history: '***' } });
  });

  it('seals the values of a step waiting for approval, and saves them in plain form once approved', async () => {
    const current = await w.platform.records.get(w.as(w.ngoA), clientId);
    const res = await w.platform.records.transition(w.as(w.ngoA), clientId, 'verify', { data: { income: 99000 }, expectedVersion: current.version });
    const [req] = await w.platform.db.asSystem((tx) => tx.query<{ data: Record<string, unknown> }>(`select data from approval_request where id = $1`, [res.approvalRequestId]));
    expect(req!.data.income).toMatch(SEALED);
    expect(await w.platform.approvals.decide(as(caseworker), res.approvalRequestId!, 'approve')).toMatchObject({ status: 'approved' });
    expect((await w.platform.records.get(as(caseworker), clientId)).data).toMatchObject({ income: 99000 });
    const approvals = await w.platform.approvals.query(as(caseworker));
    expect(approvals.items).toEqual([]);
  });
});

describe('reads, masking and exports', () => {
  it('shows plain values to people with the sensitive permission and the mask to others', async () => {
    expect((await w.platform.records.get(as(caseworker), clientId)).data).toMatchObject({ name: 'Asha Rao', pan: 'ABCDE1234F', history: 'Lost her job in May.' });
    expect((await w.platform.records.get(as(volunteer), clientId)).data).toMatchObject({ name: 'Asha Rao', pan: '***', income: '***', history: '***' });
    const forCaseworker = await w.platform.records.query(as(caseworker), 'client', {});
    expect(forCaseworker.items.find((r) => r.id === clientId)!.data.pan).toBe('ABCDE1234F');
    const forVolunteer = await w.platform.records.query(as(volunteer), 'client', {});
    expect(forVolunteer.items.find((r) => r.id === clientId)!.data.pan).toBe('***');
  });

  it('keeps unchanged sensitive values on an update that does not send them', async () => {
    const current = await w.platform.records.get(w.as(w.ngoA), clientId);
    const { record } = await w.platform.records.update(w.as(w.ngoA), clientId, { data: { tag: 'seen' }, expectedVersion: current.version });
    expect(record.data).toMatchObject({ pan: 'ABCDE1234F', income: 99000, tag: 'seen' });
    expect((await stored(clientId)).data.pan).toMatch(SEALED);
  });

  it('exports plain values to permitted exporters and the mask to others', async () => {
    const full = await app.inject({ method: 'GET', url: '/api/records/client/export.csv', headers: headers(caseworker) });
    expect(full.statusCode).toBe(200);
    expect(full.body).toContain('ABCDE1234F');
    expect(full.body).toContain('Lost her job in May.');
    expect(full.body).not.toContain('enc:v1');
    const masked = await app.inject({ method: 'GET', url: '/api/records/client/export.csv', headers: headers(volunteer) });
    expect(masked.statusCode).toBe(200);
    expect(masked.body).toContain('***');
    expect(masked.body).not.toMatch(/ABCDE1234F|enc:v1/);
  });

  it('gives automations the plain values and masks them in notifications per recipient', async () => {
    const [toCaseworker] = await w.platform.notifications.inbox(as(caseworker));
    const [toVolunteer] = await w.platform.notifications.inbox(as(volunteer));
    expect(toCaseworker).toMatchObject({ subject: 'New client Asha Rao', body: 'PAN ABCDE1234F, tag checked' });
    expect(toVolunteer).toMatchObject({ subject: 'New client Asha Rao', body: 'PAN ***, tag checked' });
  });

  it('copies a sensitive value from a chosen record in plain form, and stores the copy sealed', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'visit', { client: clientId });
    expect(record.data.clientPan).toBe('ABCDE1234F');
    expect((await stored(record.id)).data.clientPan).toMatch(SEALED);
  });
});

describe('unique sensitive fields', () => {
  it('refuses a value another record holds, ignoring case, without decrypting', async () => {
    const err = await expectCode(w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Copy', pan: 'abcde1234f' }), 'validation_failed');
    expect(err).toMatchObject({ issues: [{ path: '/pan', message: 'Another client already has this PAN.' }] });
    const other = await w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Ravi', pan: 'PQRSX6789Z' });
    expect(other.record.data.pan).toBe('PQRSX6789Z');
  });

  it('finds the record by its value for imports, and only for people who may see the field', async () => {
    expect(await w.platform.records.findByUnique(w.as(w.ngoA), 'client', 'pan', 'ABCDE1234F')).toMatchObject({ id: clientId });
    expect(await w.platform.records.findByUnique(w.as(w.ngoA), 'client', 'pan', 'ZZZZZ9999Z')).toBeNull();
    expect(await w.platform.records.resolveReference(as(caseworker), 'client', 'abcde1234f')).toBe(clientId);
    await expectCode(w.platform.records.resolveReference(as(volunteer), 'client', 'ABCDE1234F'), 'validation_failed');
  });

  it('builds the managed unique index on the keyed hash', async () => {
    const plan = await w.platform.indexes.plan(w.ngoA);
    expect(plan.needed.find((n) => n.typeKey === 'client' && n.field === 'pan')).toMatchObject({ cast: 'hash', kind: 'unique' });
    const { failed } = await w.platform.indexes.buildPending(w.ngoA, 100);
    expect(failed).toEqual([]);
    const results = await Promise.allSettled([
      w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Left', pan: 'RACEC1234D' }),
      w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Right', pan: 'RACEC1234D' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('key rotation', () => {
  let legacyId: string;

  it('reads values stored before encryption, and still finds them for unique checks', async () => {
    legacyId = (await w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Old Timer' })).record.id;
    await w.platform.db.asSystem((tx) =>
      tx.query(`update record set data = data || '{"pan": "LEGAC1234Y", "income": 5000}'::jsonb, blind_index = '{}' where id = $1`, [legacyId]),
    );
    expect((await w.platform.records.get(as(caseworker), legacyId)).data).toMatchObject({ pan: 'LEGAC1234Y', income: 5000 });
    await expectCode(w.platform.records.create(w.as(w.ngoA), 'client', { name: 'Twin', pan: 'LEGAC1234Y' }), 'validation_failed');
  });

  it('reads values under the old key after a new current key is added, and fails clearly without it', async () => {
    const rotated = await second(newKey, [oldKey]);
    expect((await rotated.records.get(as(caseworker), clientId)).data).toMatchObject({ pan: 'ABCDE1234F', income: 99000 });
    await expectCode(rotated.records.create(w.as(w.ngoA), 'client', { name: 'Copy', pan: 'ABCDE1234F' }), 'validation_failed');
    const fresh = await rotated.records.create(w.as(w.ngoA), 'client', { name: 'New', pan: 'NEWKY1234A', income: 10 });
    expect(String((await stored(fresh.record.id)).data.pan).split(':')[2]).toBe(keyIdOf(newKey));
    await expect(w.platform.records.get(as(caseworker), fresh.record.id)).rejects.toThrow(/not configured/);

    const newOnly = await second(newKey);
    await expect(newOnly.records.get(as(caseworker), clientId)).rejects.toThrow(/encrypted with key [0-9a-f]{8}, which is not configured.*ENCRYPTION_KEY_PREVIOUS/);
    const wrong = await second(randomBytes(32), [randomBytes(32)]);
    await expect(wrong.records.get(as(caseworker), clientId)).rejects.toThrow(/not configured/);
  });

  it('re-encrypts every value under the current key with the job, with progress, and then needs only the new key', async () => {
    const rotated = await second(newKey, [oldKey]);
    const queued = await rotated.reencryptSensitiveFields();
    const mine = queued.filter((j) => j.kind === 'fields.reencrypt');
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const finished = await runJobs(rotated, mine.map((j) => j.id));
    expect(finished.every((j) => j.status === 'done')).toBe(true);
    const sum = (k: 'checked' | 'rewritten') => finished.reduce((n, j) => n + Number(j.result?.[k] ?? 0), 0);
    expect(finished.reduce((n, j) => n + j.progress, 0)).toBe(6);
    expect(sum('checked')).toBe(6);
    // Four clients under the old key or in plain text, and the visit; the client saved under the new key needs none.
    expect(sum('rewritten')).toBe(5);

    const rows = await w.platform.db.asSystem((tx) =>
      tx.query<{ data: Record<string, unknown>; blind_index: Record<string, string> }>(
        `select data, blind_index from record where tenant_id = $1 and type_key in ('client', 'visit')`,
        [w.ngoA],
      ),
    );
    for (const r of rows) {
      for (const k of ['pan', 'income', 'history', 'clientPan']) {
        if (r.data[k] === undefined) continue;
        expect(r.data[k]).toMatch(SEALED);
        expect(String(r.data[k]).split(':')[2]).toBe(keyIdOf(newKey));
      }
    }
    expect(JSON.stringify(rows)).not.toContain('LEGAC1234Y');

    const newOnly = await second(newKey);
    expect((await newOnly.records.get(as(caseworker), clientId)).data).toMatchObject({ pan: 'ABCDE1234F', income: 99000, history: 'Lost her job in May.' });
    expect((await newOnly.records.get(as(caseworker), legacyId)).data).toMatchObject({ pan: 'LEGAC1234Y', income: 5000 });
    expect((await newOnly.records.get(as(volunteer), clientId)).data).toMatchObject({ pan: '***' });
    await expectCode(newOnly.records.create(w.as(w.ngoA), 'client', { name: 'Twin', pan: 'legac1234y' }), 'validation_failed');

    const again = await newOnly.reencryptSensitiveFields();
    const rerun = await runJobs(newOnly, again.filter((j) => j.kind === 'fields.reencrypt').map((j) => j.id));
    expect(rerun.map((j) => j.result?.rewritten)).toEqual(rerun.map(() => 0));
  });

  it('opens values of a field that is no longer sensitive until the job stores them in plain form', async () => {
    const newOnly = await second(newKey);
    const before = await stored(clientId);
    expect(before.data.history).toMatch(SEALED);
    await newOnly.definitions.saveDraft(w.as(w.ngoA), 'recordType', {
      key: 'client',
      label: 'Client',
      titleField: 'name',
      numbering: { sequence: 'client', format: 'CL/{seq:3}', reset: 'never' },
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'pan', label: 'PAN', type: 'text', sensitive: true, unique: true, searchable: true },
        { key: 'income', label: 'Income', type: 'money', sensitive: true },
        { key: 'history', label: 'History', type: 'longText' },
        { key: 'tag', label: 'Tag', type: 'text' },
      ],
    } as RecordTypeDef as never);
    await newOnly.definitions.publish(w.as(w.ngoA), 'recordType', 'client');
    expect((await newOnly.records.get(as(volunteer), clientId)).data).toMatchObject({ history: 'Lost her job in May.', pan: '***' });
    await newOnly.dispatcher.runOnce();
    const queued = await newOnly.db.asSystem((tx) =>
      tx.query<{ id: string }>(`select id from job where tenant_id = $1 and kind = 'fields.reencrypt' and status = 'queued'`, [w.ngoA]),
    );
    expect(queued.length).toBe(1);
    await runJobs(newOnly, queued.map((j) => j.id));
    expect((await stored(clientId)).data.history).toBe('Lost her job in May.');
  });
});

describe('key ring', () => {
  const type: RecordTypeDef = { key: 't', label: 'T', fields: [{ key: 's', label: 'S', type: 'text', sensitive: true }] };

  it('keeps every value type, binds the value to its field, and refuses tampering and unknown keys', () => {
    const fields = new SensitiveFields(new KeyRing(oldKey));
    for (const value of ['x', 42, 0, true, ['a', 'b'], { lat: 1, lng: 2 }]) {
      const sealed = fields.seal(type, { s: value });
      expect(sealed.data.s).toMatch(SEALED);
      expect(fields.open(type, sealed.data).s).toEqual(value);
    }
    expect(fields.seal(type, { s: '' }).data.s).toBe('');
    expect(fields.seal(type, { s: null }).data.s).toBeNull();
    const ring = new KeyRing(oldKey);
    const value = ring.seal('"secret"', 't.s');
    expect(() => ring.open(value, 't.other')).toThrow(/could not be decrypted/);
    const tampered = value.slice(0, -2) + (value.endsWith('A') ? 'BB' : 'AA');
    expect(() => ring.open(tampered, 't.s')).toThrow(/could not be decrypted/);
    expect(() => new KeyRing(newKey).open(value, 't.s')).toThrow(/not configured/);
    expect(new KeyRing(newKey, [oldKey]).open(value, 't.s')).toBe('"secret"');
    expect(() => SensitiveFields.withoutKeys().open(type, { s: value })).toThrow(/without ENCRYPTION_KEY/);
    expect(SensitiveFields.withoutKeys().open(type, { s: 'plain' })).toEqual({ s: 'plain' });
  });

  it('reads the previous keys from their setting', () => {
    const previous = parseKeys(` ${oldKey.toString('base64')} ,`);
    expect(previous).toEqual([oldKey]);
    const ring = new KeyRing(parseKey(newKey.toString('base64')), previous);
    expect(ring.currentId).toBe(keyIdOf(newKey));
    expect(ring.open(new KeyRing(oldKey).seal('1', 'c'), 'c')).toBe('1');
    expect(parseKeys(undefined)).toEqual([]);
    expect(() => parseKeys('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});
