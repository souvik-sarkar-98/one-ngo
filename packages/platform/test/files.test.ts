import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionBodies, DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;
const MB = 1024 * 1024;

const field: Actor = {
  id: 'field-1',
  roles: ['field'],
  permissions: ['record:case:create', 'record:case:read', 'record:case:update', 'record:note:create', 'record:note:read', 'record:note:update'],
};
const other: Actor = {
  id: 'other-1',
  roles: ['field'],
  permissions: ['record:case:create', 'record:case:read', 'record:case:update', 'record:note:read'],
};
const stranger: Actor = { id: 'stranger-1', roles: ['guest'], permissions: [] };

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, body.key);
}

function png(padding = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(4),
    Buffer.alloc(padding, 7),
  ]);
}
const pdf = () => Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const csv = () => Buffer.from('name,amount\nRavi,100\nMeena,250\n');

/** A stored (uncompressed) zip with the given entries. */
function zip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [entry, text] of entries) {
    const name = Buffer.from(entry);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const CONTENT_TYPES = ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'] as [string, string];
/** The compound-file signature followed by a directory entry name, as in legacy Office files. */
const ole = (stream: string) =>
  Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504), Buffer.from(stream, 'utf16le'), Buffer.alloc(64)]);
const docx = () => zip([CONTENT_TYPES, ['word/document.xml', '<w:document/>']]);
const xlsx = () => zip([CONTENT_TYPES, ['xl/workbook.xml', '<workbook/>']]);

const headers = (actor: Actor, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });

async function upload(actor: Actor, body: Buffer, name: string, query = '', tenant = w.ngoA) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/files${query}`,
    headers: { ...headers(actor, tenant), 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as { id: string; mime: string; size: number; name: string; code?: string; message?: string } };
}
async function uploaded(actor: Actor, body: Buffer, name: string, query = '') {
  const res = await upload(actor, body, name, query);
  expect(res.status, res.body.message).toBe(201);
  return res.body;
}
const download = (actor: Actor, id: string, tenant = w.ngoA) => app.inject({ method: 'GET', url: `/api/files/${id}`, headers: headers(actor, tenant) });

async function fileRow(id: string) {
  const [row] = await w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query<{ record_id: string | null; field_key: string | null; deleted_at: Date | null; storage_key: string; store_ref: string; sha256: string }>(
      `select record_id, field_key, deleted_at, storage_key, store_ref, sha256 from file_object where id = $1`,
      [id],
    ),
  );
  return row!;
}
const storedBlobs = () => (existsSync(join(w.filesDir!, w.ngoA)) ? readdirSync(join(w.filesDir!, w.ngoA)) : []);

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, donations: false, files: { maxUploadMb: 2, defaultQuotaMb: 50 } });
  app = buildServer(w.platform, { devAuth: true });
  await publish('recordType', {
    key: 'case',
    label: 'Case',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'photo', label: 'Photo', type: 'file', accept: ['image'], maxSizeMb: 1 },
      { key: 'papers', label: 'Papers', type: 'file', multiple: true, accept: ['pdf', 'document', 'spreadsheet'] },
      { key: 'medical', label: 'Medical report', type: 'file', sensitive: true },
      { key: 'sign', label: 'Signature', type: 'signature' },
    ],
  });
  await publish('recordType', {
    key: 'note',
    label: 'Note',
    visibility: 'restricted',
    fields: [
      { key: 'text', label: 'Text', type: 'text', required: true },
      { key: 'attachment', label: 'Attachment', type: 'file' },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('upload', () => {
  it('accepts images, PDF, office documents and CSV, typed by their content', async () => {
    const image = await uploaded(field, png(), 'photo.jpg');
    expect(image).toMatchObject({ mime: 'image/png', size: png().length, name: 'photo.jpg' });
    expect((await fileRow(image.id)).sha256).toBe(createHash('sha256').update(png()).digest('hex'));
    expect((await uploaded(field, pdf(), 'letter.pdf')).mime).toBe('application/pdf');
    expect((await uploaded(field, docx(), 'report.docx')).mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect((await uploaded(field, xlsx(), 'sheet.xlsx')).mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect((await uploaded(field, ole('Workbook'), 'old.xls')).mime).toBe('application/vnd.ms-excel');
    expect((await uploaded(field, ole('WordDocument'), 'old.doc')).mime).toBe('application/msword');
    expect((await uploaded(field, csv(), 'donors.csv')).mime).toBe('text/csv');
    expect((await uploaded(field, Buffer.from('Notes from the visit — all fine.\n'), 'visit.txt')).mime).toBe('text/plain');
    expect((await uploaded(field, png(), '../../etc/pass"wd.png')).name).toBe('passwd.png');
  });

  it('refuses disguised and unknown file types and keeps nothing of them', async () => {
    const before = storedBlobs().length;
    const html = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
    const refused = [
      [Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]), 'report.pdf'],
      [html, 'report.pdf'],
      [html, 'donors.csv'],
      [Buffer.from('name\n<script>alert(1)</script>\n'), 'list.csv'],
      [Buffer.from('plain words that are not a known format'), 'report.pdf'],
      [Buffer.concat([Buffer.from('name,amount\n'), Buffer.from([0]), Buffer.from('x')]), 'nul.csv'],
      [Buffer.concat([Buffer.from('name,amount,more,cols\n'), Buffer.from([0xff, 0xfe, 0xfd])]), 'latin.csv'],
      [zip([['META-INF/MANIFEST.MF', 'Main-Class: X']]), 'tool.docx'],
      [zip([CONTENT_TYPES, ['word/document.xml', '<w/>'], ['word/vbaProject.bin', 'macro']]), 'macro.docx'],
      [ole('SummaryInformation'), 'setup.msi'],
      [Buffer.concat([ole('WordDocument'), Buffer.from('_VBA_PROJECT', 'utf16le')]), 'macro.doc'],
      [Buffer.from('GIF8'), 'tiny.gif'],
      [Buffer.alloc(0), 'empty.png'],
    ] as const;
    for (const [body, name] of refused) {
      const res = await upload(field, body, name);
      expect(res.status, name).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    }
    const form = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { ...headers(field), 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x\r\n\r\nhello\r\n--x--',
    });
    expect(form.statusCode).toBe(422);
    expect(storedBlobs().length).toBe(before);
    expect((await app.inject({ method: 'POST', url: '/api/files', headers: { 'content-type': 'application/octet-stream' }, payload: png() })).statusCode).toBe(403);
  });

  it('limits the size by the target field, signatures, and the platform', async () => {
    const before = storedBlobs().length;
    const big = await upload(field, png(Math.round(1.5 * MB)), 'big.png', '?type=case&field=photo');
    expect(big.status).toBe(422);
    expect(big.body.message).toMatch(/larger than 1 MB/);
    await uploaded(field, png(Math.round(1.5 * MB)), 'big.png');
    const huge = await upload(field, png(Math.round(2.5 * MB)), 'huge.png');
    expect(huge.status).toBe(422);
    expect(huge.body.message).toMatch(/larger than 2 MB/);
    expect((await upload(field, png(210 * 1024), 'sign.png', '?type=case&field=sign')).status).toBe(422);
    expect((await upload(field, pdf(), 'sign.pdf', '?type=case&field=sign')).status).toBe(422);
    expect((await upload(field, pdf(), 'photo.pdf', '?type=case&field=photo')).body.message).toMatch(/accepts only image/);
    await uploaded(field, png(1000), 'sign.png', '?type=case&field=sign');
    expect((await upload(field, png(), 'x.png', '?type=case&field=title')).status).toBe(422);
    expect((await upload(stranger, png(), 'x.png', '?type=case&field=photo')).status).toBe(403);
    expect(storedBlobs().length).toBe(before + 2);
  });

  it("stops at the organisation's quota and reports storage use", async () => {
    await w.platform.db.withTenant(w.ngoB, (tx) =>
      tx.query(`insert into tenant_setting (tenant_id, key, value) values (app_tenant(), 'files.quotaBytes', '3000')`),
    );
    const first = await upload(field, png(1900), 'a.png', '', w.ngoB);
    expect(first.status).toBe(201);
    const second = await upload(field, png(1900), 'b.png', '', w.ngoB);
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('rule_violation');
    expect(second.body.message).toMatch(/storage is full/);
    const storage = await app.inject({ method: 'GET', url: '/api/admin/storage', headers: headers(admin, w.ngoB) });
    expect(storage.json()).toEqual({ used: first.body.size, quota: 3000 });
    expect(await w.platform.files.usage(w.as(w.ngoA))).toMatchObject({ quota: 50 * MB });
    expect((await app.inject({ method: 'GET', url: '/api/admin/storage', headers: headers(field, w.ngoB) })).statusCode).toBe(403);
    expect((await upload(field, png(900), 'c.png', '', w.ngoB)).status).toBe(201);
    expect((await upload(field, png(200), 'd.png', '', w.ngoB)).status).toBe(422);
  });
});

describe('linking on save', () => {
  it('links new files to the record and field, and unlinks removed ones', async () => {
    const photo = await uploaded(field, png(), 'p.png');
    const a = await uploaded(field, pdf(), 'a.pdf');
    const b = await uploaded(field, csv(), 'b.csv');
    const sign = await uploaded(field, png(), 'sign.png', '?type=case&field=sign');
    const ctx = w.as(w.ngoA, field);
    const { record } = await w.platform.records.create(ctx, 'case', { title: 'Ravi', photo: photo.id, papers: [a.id, b.id], sign: { file: sign.id } });
    expect(await fileRow(photo.id)).toMatchObject({ record_id: record.id, field_key: 'photo' });
    expect(await fileRow(b.id)).toMatchObject({ record_id: record.id, field_key: 'papers' });
    expect(await fileRow(sign.id)).toMatchObject({ record_id: record.id, field_key: 'sign' });

    const saved = await w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { papers: [a.id], photo: null } });
    expect(saved.record.data.papers).toEqual([a.id]);
    expect(await fileRow(b.id)).toMatchObject({ record_id: null, field_key: null });
    expect(await fileRow(photo.id)).toMatchObject({ record_id: null });
    expect(await fileRow(a.id)).toMatchObject({ record_id: record.id, field_key: 'papers' });
  });

  it('refuses missing files, files of others, files attached elsewhere, and kinds the field does not accept', async () => {
    const ctx = w.as(w.ngoA, field);
    const mine = await uploaded(field, png(), 'mine.png');
    const theirs = await uploaded(other, png(), 'theirs.png');
    const doc = await uploaded(field, pdf(), 'doc.pdf');
    const { record } = await w.platform.records.create(ctx, 'case', { title: 'Meena', photo: mine.id });
    const cases: Record<string, unknown>[] = [
      { photo: '00000000-0000-4000-8000-000000000000' },
      { photo: theirs.id },
      { photo: mine.id },
      { medical: mine.id },
      { photo: doc.id },
      { papers: [doc.id], medical: doc.id },
    ];
    for (const data of cases) {
      await expectCode(w.platform.records.create(ctx, 'case', { title: 'X', ...data }), 'validation_failed');
    }
    await expectCode(w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { medical: mine.id } }), 'validation_failed');
    expect(await fileRow(doc.id)).toMatchObject({ record_id: null });
    expect(await fileRow(theirs.id)).toMatchObject({ record_id: null });
  });
});

describe('download', () => {
  it('serves files same-origin through the linked record, with disposition and nosniff', async () => {
    const photo = await uploaded(field, png(), 'Rāvi photo.png');
    const sheet = await uploaded(field, csv(), 'donors.csv');
    const own = await download(field, photo.id);
    expect(own.statusCode).toBe(200);
    expect((await download(other, photo.id)).statusCode).toBe(404);

    const { record } = await w.platform.records.create(w.as(w.ngoA, field), 'case', { title: 'Asha', photo: photo.id, papers: [sheet.id] });
    const res = await download(other, photo.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(`inline; filename="R_vi photo.png"; filename*=UTF-8''${encodeURIComponent('Rāvi photo.png')}`);
    expect(res.rawPayload.equals(png())).toBe(true);
    const head = await app.inject({ method: 'HEAD', url: `/api/files/${photo.id}`, headers: headers(other, w.ngoA) });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-disposition']).toBe(res.headers['content-disposition']);
    expect(head.headers['content-type']).toBe('image/png');
    expect(Number(head.headers['content-length'])).toBe(png().length);
    const csvRes = await download(other, sheet.id);
    expect(csvRes.headers['content-disposition']).toMatch(/^attachment; filename="donors.csv"/);
    expect(csvRes.headers['content-type']).toMatch(/^text\/csv/);
    expect(csvRes.body).toBe(csv().toString());

    expect((await download(stranger, photo.id)).statusCode).toBe(403);
    expect((await download(admin, photo.id, w.ngoB)).statusCode).toBe(404);
    expect((await download(admin, 'not-a-uuid')).statusCode).toBe(404);
    expect(record.id).toBeTruthy();
  });

  it('follows restricted visibility of the linked record', async () => {
    const file = await uploaded(field, pdf(), 'private.pdf');
    await w.platform.records.create(w.as(w.ngoA, field), 'note', { text: 'Private', attachment: file.id });
    expect((await download(field, file.id)).statusCode).toBe(200);
    expect((await download(other, file.id)).statusCode).toBe(404);
    expect((await download(admin, file.id)).statusCode).toBe(200);
  });

  it('hides files in sensitive fields without the sensitive permission', async () => {
    const report = await uploaded(field, pdf(), 'medical.pdf');
    const { record } = await w.platform.records.create(w.as(w.ngoA, field), 'case', { title: 'Kiran', medical: report.id });
    expect(record.data.medical).toBe('***');
    expect((await download(field, report.id)).statusCode).toBe(404);
    expect((await download(other, report.id)).statusCode).toBe(404);
    const res = await download(admin, report.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    const kept = await w.platform.records.update(w.as(w.ngoA, field), record.id, { expectedVersion: 1, data: { medical: '***', title: 'Kiran K' } });
    expect(kept.record.data.title).toBe('Kiran K');
    expect(await fileRow(report.id)).toMatchObject({ record_id: record.id, field_key: 'medical' });
  });
});

describe('clean-up', () => {
  it('removes uploads left unlinked for more than a day, from the store too', async () => {
    const stale = await uploaded(field, png(), 'stale.png');
    const fresh = await uploaded(field, png(), 'fresh.png');
    const kept = await uploaded(field, png(), 'kept.png');
    await w.platform.records.create(w.as(w.ngoA, field), 'case', { title: 'Old', photo: kept.id });
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(`update file_object set created_at = now() - interval '25 hours' where id = any($1::uuid[])`, [[stale.id, kept.id]]),
    );
    const staleKey = (await fileRow(stale.id)).storage_key;
    expect(existsSync(join(w.filesDir!, ...staleKey.split('/')))).toBe(true);

    await w.platform.tick();

    expect((await fileRow(stale.id)).deleted_at).not.toBeNull();
    expect(existsSync(join(w.filesDir!, ...staleKey.split('/')))).toBe(false);
    expect((await download(field, stale.id)).statusCode).toBe(404);
    expect((await fileRow(fresh.id)).deleted_at).toBeNull();
    expect((await fileRow(kept.id)).deleted_at).toBeNull();
    expect((await download(field, kept.id)).statusCode).toBe(200);
    const jobs = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ status: string; result: { removed: number } }>(`select status, result from job where kind = 'files.cleanup'`),
    );
    expect(jobs).toEqual([{ status: 'done', result: { removed: 1 } }]);
    await w.platform.tick();
    expect(
      (await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`select 1 from job where kind = 'files.cleanup'`))).length,
    ).toBe(1);
  });
});

describe('the store that holds each file', () => {
  it('records the installation store for every upload and reads it back from there', async () => {
    const photo = await uploaded(field, png(), 'where.png');
    expect((await fileRow(photo.id)).store_ref).toBe('platform');
    expect((await download(field, photo.id)).rawPayload.equals(png())).toBe(true);
  });

  it('fails clearly for a file recorded under a store this server does not have', async () => {
    const photo = await uploaded(field, png(), 'elsewhere.png');
    await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update file_object set store_ref = 'org:gcs' where id = $1`, [photo.id]));
    await expect(w.platform.files.open(w.as(w.ngoA, field), photo.id)).rejects.toThrow("No file store is configured for 'org:gcs'.");
    expect((await download(field, photo.id)).statusCode).toBe(500);
  });
});
