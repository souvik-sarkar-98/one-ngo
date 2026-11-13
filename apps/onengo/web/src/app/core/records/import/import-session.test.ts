import { describe, expect, it } from 'vitest';
import { memoryGateway } from '../../testing/memory-gateway';
import { memoryImportExport, parseCsv } from '../../testing/memory-imports';
import { exportList, exportQuery, exportSelected } from '../list/export';
import { ImportSession, importStep, listImportNavigator, minutesLeft, permits, sampleCsv, transferMenu, type ImportView } from './import-session';
import { ListSession } from '../list/list-session';
import { resolveListSpec, type ListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, paramsOf } from '../gateway/testing';
import { parseListUrl, patch, pushesHistory, toQueryParams } from '../list/url';

const CSV = 'Name,City,Phone\r\nAsha Rao,Pune,98450\r\n,Delhi,98451\r\nRavi Kumar,Chennai,98452\r\n';
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 10_000; !check() && Date.now() < end; ) await settle();
  expect(check()).toBe(true);
}

async function donorSpec(g: ReturnType<typeof memoryGateway>): Promise<ListSpec> {
  const defs = await g.auth.definitions();
  return resolveListSpec(defs.recordTypes.find((t) => t.key === 'donor')!, defs.workflows['donor'], defs.listViews?.['donor']);
}

/** A record list with an import session, both on a fake address bar, over the memory gateway. */
async function harness(start: Record<string, string> = {}, wait = settle, batchSize = 2) {
  const g = memoryGateway();
  const io = memoryImportExport(g, { batchSize });
  const spec = await donorSpec(g);
  let params: Record<string, string> = { ...start };
  const pushes: Record<string, string>[] = [];
  const finished: ImportView[] = [];
  const get = (n: string) => params[n] ?? null;
  const sync = () => list.fromUrl(get).then(() => imports.follow(list.state.import, list.state.importStep));
  const list: ListSession = new ListSession(
    spec,
    g.records,
    {
      navigate: (next, replace) => {
        params = Object.fromEntries(Object.entries({ ...params, ...next }).filter(([, v]) => v !== null)) as Record<string, string>;
        if (!replace) pushes.push({ ...params });
        void sync();
      },
    },
    { preferred: () => 'cards', remember: () => undefined },
  );
  const imports = new ImportSession(io, spec.type, listImportNavigator(() => list), { wait, finished: (v) => finished.push(v) });
  await sync();
  return { g, io, spec, list, imports, pushes, finished, params: () => params, snap: () => imports.snapshot };
}

async function uploaded(h: Awaited<ReturnType<typeof harness>>, csv = CSV) {
  h.list.openImport();
  await until(() => h.params()['import'] === 'new');
  h.imports.choose(new Blob([csv], { type: 'text/csv' }), 'donors-october.csv');
  await h.imports.upload();
  await until(() => h.snap().step === 1 && !h.snap().loading);
  return h.snap().view!.id;
}

async function checked(h: Awaited<ReturnType<typeof harness>>) {
  const id = await uploaded(h);
  await h.imports.checkRows();
  await until(() => h.snap().step === 2);
  return id;
}

describe('import address', () => {
  const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
  const parse = (p: Record<string, string>) => parseListUrl(paramsOf(p), spec);

  it('reads import=new, import=<id>&importStep=n and the importId spelling', () => {
    expect(parse({ import: 'new' })).toMatchObject({ import: 'new', importStep: 0 });
    expect(parse({ import: 'new', importStep: '3' })).toMatchObject({ import: 'new', importStep: 0 });
    expect(parse({ import: 'imp7', importStep: '2' })).toMatchObject({ import: 'imp7', importStep: 2 });
    expect(parse({ import: 'new', importId: 'imp7', importStep: '1' })).toMatchObject({ import: 'imp7', importStep: 1 });
    expect(parse({ import: 'imp7', importStep: '5' }).importStep).toBe(4);
    expect(parse({ import: 'imp7', importStep: 'x' }).importStep).toBe(0);
    expect(parse({ id: 'r1', import: 'imp7' }).import).toBeUndefined();
    expect(parse({ importStep: '2' }).import).toBeUndefined();
  });

  it('writes the import back, its id in place of new, and clears importId', () => {
    expect(toQueryParams(parse({ import: 'new', importId: 'imp7', importStep: '2', chip: 'mine' }), spec)).toMatchObject({ import: 'imp7', importStep: '2', importId: null, chip: 'mine' });
    expect(toQueryParams(parse({ import: 'new' }), spec)).toMatchObject({ import: 'new', importStep: null });
  });

  it('keeps one panel: an import closes the record and create, and they close the import', () => {
    const open = parse({ id: 'r1', panel: 'edit' });
    const importing = patch(open, { import: 'new', importStep: 0 }, spec);
    expect(importing).toMatchObject({ id: undefined, panel: { kind: 'view' }, import: 'new', importStep: 0 });
    expect(patch(importing, { id: 'r2' }, spec)).toMatchObject({ id: 'r2', import: undefined });
    expect(patch(importing, { create: 'new' }, spec)).toMatchObject({ create: 'new', import: undefined });
    expect(patch(importing, { import: undefined }, spec).importStep).toBeUndefined();
    expect(patch(importing, { chip: 'mine' }, spec)).toMatchObject({ import: 'new' });
  });

  it('keeps one history entry while an import moves on, and replaces it when the import closes', () => {
    const closed = parse({});
    expect(pushesHistory(closed, patch(closed, { import: 'new' }, spec))).toBe(true);
    const a = parse({ import: 'imp7', importStep: '1' });
    expect(pushesHistory(a, patch(a, { importStep: 2 }, spec))).toBe(false);
    expect(pushesHistory(a, patch(a, { import: undefined }, spec))).toBe(false);
    expect(pushesHistory(a, patch(a, { q: 'asha' }, spec))).toBe(false);
  });
});

describe('the import step an import can show', () => {
  const view = (status: ImportView['status'], extra: Partial<ImportView> = {}) => ({ status, jobId: null, check: null, ...extra }) as ImportView;
  it('follows the import status', () => {
    expect(importStep(null, 3)).toBe(0);
    expect(importStep(view('uploaded'), 2)).toBe(1);
    expect(importStep(view('mapped'), 0)).toBe(1);
    const check = { rows: 1, valid: 1, invalid: 0, creates: 1, updates: 0, problems: [] };
    expect(importStep(view('checked', { check }), 2)).toBe(2);
    expect(importStep(view('checked', { check }), 1)).toBe(1);
    expect(importStep(view('checked', { check }), 4)).toBe(2);
    expect(importStep(view('running', { jobId: 'j' }), 1)).toBe(3);
    expect(importStep(view('done', { jobId: 'j' }), 1)).toBe(4);
    expect(importStep(view('failed', { jobId: 'j' }), 2)).toBe(4);
  });

  it('estimates the time left from the speed so far', () => {
    const job = { id: 'j', kind: 'import', status: 'running' as const, progress: 640, total: 1204, error: null, cancelRequested: false, startedAt: '2026-10-24T10:40:00.000Z' };
    expect(minutesLeft(job, Date.parse('2026-10-24T10:41:00.000Z'))).toBe(1);
    expect(minutesLeft({ ...job, startedAt: null }, Date.now())).toBeNull();
  });
});

describe('import session over the memory gateway', () => {
  it('uploads, matches, checks, runs with progress and shows the result', async () => {
    const h = await harness();
    const id = await uploaded(h);
    expect(h.params()).toMatchObject({ import: id, importStep: '1' });
    expect(h.snap().columns).toEqual({ Name: 'name', City: 'city', Phone: 'phone' });
    expect(h.snap().view!.columns[0]).toEqual({ name: 'Name', samples: ['Asha Rao', 'Ravi Kumar'] });

    h.imports.setColumn('Phone', null);
    h.imports.setColumn('City', 'name');
    expect(h.snap().columns).toEqual({ Name: null, City: 'name', Phone: null });
    h.imports.setColumn('Name', 'name');
    h.imports.setColumn('City', 'city');
    expect(h.snap().columns).toEqual({ Name: 'name', City: 'city', Phone: null });

    await h.imports.checkRows();
    await until(() => h.snap().step === 2);
    expect(h.params()).toMatchObject({ import: id, importStep: '2' });
    expect(h.snap().check).toMatchObject({ rows: 3, valid: 2, invalid: 1, creates: 2, updates: 0, problems: [{ row: 3, message: 'Name is required.' }] });
    expect(h.io.calls.filter((c) => c.op === 'setMapping')[0]!.args[1]).toEqual({ columns: { Name: 'name', City: 'city', Phone: null } });

    const before = (await h.g.records.query('donor', { limit: 100 })).total;
    await h.imports.run();
    await until(() => h.snap().step === 4);
    expect(h.params()).toMatchObject({ import: id, importStep: '4' });
    expect(h.snap().job).toMatchObject({ status: 'done', progress: 3, total: 3 });
    expect(h.snap().view).toMatchObject({ status: 'done', counts: { created: 2, updated: 0, failed: 1 } });
    expect(h.finished.map((v) => v.id)).toEqual([id]);
    expect((await h.g.records.query('donor', { limit: 100 })).total).toBe(before + 2);
    expect(h.io.calls.filter((c) => c.op === 'job').length).toBeGreaterThanOrEqual(2);

    const failed = parseCsv(await (await h.imports.failedRows()).body.text());
    expect(failed).toEqual([['Name', 'City', 'Phone', 'Reason'], ['', 'Delhi', '98451', 'Name is required.']]);
    // Opening the import pushes one entry. Later steps replace it, so Back closes the import instead of walking the steps.
    expect(h.pushes.map((p) => [p['import'], p['importStep']])).toEqual([['new', undefined]]);
  });

  it('goes back a step, and from matching back to a new upload', async () => {
    const h = await harness();
    const id = await checked(h);
    h.imports.back();
    await until(() => h.snap().step === 1);
    expect(h.params()).toMatchObject({ import: id, importStep: '1' });
    h.imports.back();
    await until(() => h.params()['import'] === 'new' && h.snap().view === null);
    expect(h.snap().step).toBe(0);
  });

  it('reopens on the right step from a link, as the notification does', async () => {
    const h = await harness();
    const id = await checked(h);
    await h.imports.run();
    await until(() => h.snap().step === 4);

    const params: Record<string, string> = { import: id, importStep: '5' };
    const shown: [string, number, boolean][] = [];
    const s = new ImportSession(h.io, h.spec.type, { show: (i, st, r) => shown.push([i, st, r]), close: () => undefined }, { wait: settle });
    const state = parseListUrl((n) => params[n] ?? null, h.spec);
    await s.follow(state.import, state.importStep);
    expect(s.snapshot).toMatchObject({ step: 4, view: { id, status: 'done' } });
    expect(shown).toEqual([]);

    await s.follow(undefined);
    await s.follow(id, 1);
    expect(s.snapshot.step).toBe(4);
    expect(shown).toEqual([[id, 4, true]]);
  });

  it('a running import reopens on its progress, and closing stops reading it', async () => {
    let release: () => void = () => undefined;
    const hold = () => new Promise<void>((r) => (release = r));
    const h = await harness({}, hold, 1);
    const reads = () => h.io.calls.filter((c) => c.op === 'job').length;
    const id = await checked(h);
    await h.imports.run();
    await until(() => !!h.snap().job);
    expect(h.snap()).toMatchObject({ step: 3, job: { status: 'running', progress: 1, total: 3 } });

    h.imports.close();
    await until(() => h.params()['import'] === undefined && h.snap().view === null);
    const before = reads();
    release();
    await settle();
    await settle();
    expect(reads()).toBe(before);

    const shown: [string, number, boolean][] = [];
    const s = new ImportSession(h.io, h.spec.type, { show: (i, st, r) => shown.push([i, st, r]), close: () => undefined }, { wait: hold });
    await s.follow(id, 4);
    expect(s.snapshot.step).toBe(3);
    expect(shown).toEqual([[id, 3, true]]);
    await until(() => s.snapshot.job?.progress === 2);
    release();
    await until(() => s.snapshot.step === 4);
    expect(s.snapshot.view!.counts).toEqual({ created: 2, updated: 0, failed: 1 });
    expect(shown.at(-1)).toEqual([id, 4, true]);
  });

  it('cancels a running import and shows what was saved', async () => {
    const h = await harness({}, () => new Promise<void>(() => undefined));
    await checked(h);
    await h.imports.run();
    await until(() => !!h.snap().job);
    await h.imports.cancel();
    expect(h.snap().job).toMatchObject({ status: 'cancelled' });
    const s = new ImportSession(h.io, h.spec.type, { show: () => undefined, close: () => undefined });
    await s.follow(h.snap().view!.id, 3);
    expect(s.snapshot).toMatchObject({ step: 4, view: { status: 'failed', counts: { created: 1, failed: 1 } } });
  });

  it('turning automations off is sent before the run', async () => {
    const h = await harness();
    await checked(h);
    h.imports.setQuiet(true);
    await h.imports.run();
    const ops = h.io.calls.map((c) => c.op);
    expect(ops.slice(ops.lastIndexOf('setMapping'), ops.indexOf('run') + 1)).toEqual(['setMapping', 'run']);
    expect(h.io.calls[ops.lastIndexOf('setMapping')]!.args[1]).toMatchObject({ quiet: true });
  });

  it('refuses files that are not CSV or too big, before sending them', async () => {
    const h = await harness();
    h.list.openImport();
    await until(() => h.params()['import'] === 'new');
    h.imports.choose(new Blob(['x']), 'donors.xlsx');
    expect(h.snap().error).not.toBe('');
    await h.imports.upload();
    expect(h.io.calls.filter((c) => c.op === 'upload')).toEqual([]);
    h.imports.choose(new Blob([CSV]), 'donors.csv');
    expect(h.snap()).toMatchObject({ error: '', file: { name: 'donors.csv' } });
  });

  it('shows the server’s refusal of a mapping and stays on the step', async () => {
    const h = await harness();
    await uploaded(h);
    for (const c of ['Name', 'City', 'Phone']) h.imports.setColumn(c, null);
    await h.imports.checkRows();
    expect(h.snap()).toMatchObject({ step: 1, busy: false });
    expect(h.snap().error).not.toBe('');
    expect(h.io.calls.filter((c) => c.op === 'setMapping')).toEqual([]);
  });

  it('a sample file has the heading of every field that can be imported', async () => {
    const h = await harness();
    expect(sampleCsv(h.spec.type)).toEqual({ fileName: 'Donors.csv', text: '\uFEFFName,Phone,Email,PAN,City\r\n' });
  });
});

describe('list ⋮ import and export', () => {
  it('shows each entry only with its permission', () => {
    expect(transferMenu(['*'], 'donor').map((e) => e.id)).toEqual(['import', 'export']);
    expect(transferMenu(['record:donor:*'], 'donor').map((e) => e.id)).toEqual(['import', 'export']);
    expect(transferMenu(['record:donor:export'], 'donor').map((e) => e.id)).toEqual(['export']);
    expect(transferMenu(['record:donation:import', 'record:donor:read'], 'donor')).toEqual([]);
    expect(permits(['record:*:import'], 'record:donor:import')).toBe(true);
    expect(permits(['record:donor:import'], 'record:donor:import:quiet')).toBe(false);
  });

  it('exports the current list with its chip, search, filters and sort, and selected rows by id', async () => {
    const g = memoryGateway();
    const io = memoryImportExport(g);
    const spec = resolveListSpec(donationType, donationWorkflow, donationsView);
    const state = parseListUrl(paramsOf({ chip: 'mine', q: 'asha', method: 'upi', sort: '-amount', show: '60' }), spec);
    const query = exportQuery(spec, state);
    expect(query).toMatchObject({ search: 'asha', filters: { method: { in: ['upi'] } }, sort: { field: 'amount', dir: 'desc' } });
    expect(query).not.toHaveProperty('limit');
    expect(query).not.toHaveProperty('offset');

    const all = await exportList(io, { ...spec, chips: [] }, { ...state, q: '', criteria: {} });
    expect(all.kind).toBe('file');
    const rows = all.kind === 'file' ? parseCsv(await all.file.body.text()) : [];
    expect(rows.length - 1).toBe((await g.records.query('donation', { limit: 1 })).total);

    const some = await exportSelected(io, 'donation', ['donation-1', 'donation-1', 'donation-2']);
    expect(io.calls.at(-1)).toEqual({ op: 'exportSelected', args: ['donation', ['donation-1', 'donation-2']] });
    expect(some.kind === 'file' ? parseCsv(await some.file.body.text()).length : 0).toBe(3);

    const big = memoryImportExport(g, { inlineRows: 1 });
    expect(await exportList(big, { ...spec, chips: [] }, { ...state, q: '', criteria: {} })).toMatchObject({ kind: 'job' });
  });
});
