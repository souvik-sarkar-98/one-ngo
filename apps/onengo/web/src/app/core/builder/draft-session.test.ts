import { describe, expect, it } from 'vitest';
import { memoryGateway } from '../testing/memory-gateway';
import { DraftSession, memoryDrafts, type LocalDrafts, type Timers } from './draft-session';

/** Timers the test runs by hand. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clear: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    pending: () => [...pending.values()].map((p) => p.ms),
    /** Runs every timer that is due and waits for what it started. */
    async run() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, p] of due) p.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const NOW = () => new Date('2026-10-24T10:42:00.000Z');

async function tenantDefinition() {
  const g = memoryGateway();
  await g.builder.saveDraft('recordType', 'volunteer', { key: 'volunteer', label: 'Volunteer', fields: [{ key: 'name', label: 'Name', type: 'text' }], titleField: 'name' });
  await g.builder.publish('recordType', 'volunteer');
  return g;
}

function open(g: ReturnType<typeof memoryGateway>, kind: 'recordType' | 'workflow', key: string, local: LocalDrafts = memoryDrafts()) {
  const clock = manualTimers();
  const s = new DraftSession(g.builder, kind, key, { timers: clock.timers, now: NOW, local });
  return { s, clock };
}

const ops = (g: ReturnType<typeof memoryGateway>) => g.calls.filter((c) => c.port === 'builder').map((c) => c.op);

describe('DraftSession: loading', () => {
  it('loads the published version, the draft and the history, newest first', async () => {
    const g = await tenantDefinition();
    await g.builder.saveDraft('recordType', 'volunteer', { key: 'volunteer', label: 'Volunteers', fields: [{ key: 'name', label: 'Name', type: 'text' }] });
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    const snap = s.snapshot;
    expect(snap).toMatchObject({ loading: false, shipped: false, patched: false, hasDraft: true, save: 'saved' });
    expect(snap.body?.['label']).toBe('Volunteers');
    expect(snap.detail?.published?.version).toBe(1);
    expect(snap.history.map((h) => [h.version, h.status])).toEqual([[1, 'published']]);
  });

  it('marks a module definition as shipped and tells whether the organisation changed it', async () => {
    const g = memoryGateway();
    const { s } = open(g, 'recordType', 'donation');
    await s.load();
    expect(s.snapshot).toMatchObject({ shipped: true, patched: false, hasDraft: false });
    await g.builder.savePatch('recordType', 'donation', { label: 'Gift' });
    await s.load();
    expect(s.snapshot).toMatchObject({ shipped: true, patched: true });
    expect(s.snapshot.history.map((h) => [h.version, h.canRestore])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it('reports a missing definition without an error message', async () => {
    const { s } = open(memoryGateway(), 'recordType', 'nothing');
    await s.load();
    expect(s.snapshot).toMatchObject({ loading: false, missing: true, error: '' });
  });
});

describe('DraftSession: autosave', () => {
  it('saves the draft 800 ms after the last edit, once, and records when', async () => {
    const g = await tenantDefinition();
    const { s, clock } = open(g, 'recordType', 'volunteer');
    await s.load();
    const body = s.snapshot.body!;
    s.edit({ ...body, label: 'Vol' });
    s.edit({ ...body, label: 'Volunteers' });
    expect(s.snapshot.save).toBe('pending');
    expect(clock.pending()).toEqual([800]);
    await clock.run();
    expect(ops(g).filter((o) => o === 'saveDraft')).toHaveLength(2);
    expect(s.snapshot).toMatchObject({ save: 'saved', savedAt: '2026-10-24T10:42:00.000Z', hasDraft: true });
    expect((await g.builder.detail('recordType', 'volunteer')).draft?.body['label']).toBe('Volunteers');
    expect(s.snapshot.detail?.draft?.version).toBe(2);
  });

  it('saves at once on flush and does nothing when nothing changed', async () => {
    const g = await tenantDefinition();
    const { s, clock } = open(g, 'recordType', 'volunteer');
    await s.load();
    const before = ops(g).length;
    await s.flush();
    expect(ops(g).length).toBe(before);
    s.edit({ ...s.snapshot.body!, label: 'Helpers' });
    await s.flush();
    expect(clock.pending()).toEqual([]);
    expect((await g.builder.detail('recordType', 'volunteer')).draft?.body['label']).toBe('Helpers');
  });

  it('shows a refused save with its problems and does not publish an older draft', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, key: 'other' });
    await s.flush();
    expect(s.snapshot.save).toBe('failed');
    expect(s.snapshot.error).toContain('key');
    const before = ops(g).filter((o) => o === 'publish').length;
    expect(await s.publish()).toBe(false);
    expect(ops(g).filter((o) => o === 'publish').length).toBe(before);
  });

  it('keeps a module definition\'s edits on the device, not as a server draft', async () => {
    const g = memoryGateway();
    const local = memoryDrafts();
    const { s } = open(g, 'recordType', 'donation', local);
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Gift' });
    await s.flush();
    expect(ops(g)).not.toContain('saveDraft');
    expect(s.snapshot).toMatchObject({ save: 'saved', hasDraft: true });
    expect(local.read('recordType/donation')?.['label']).toBe('Gift');

    const again = open(g, 'recordType', 'donation', local).s;
    await again.load();
    expect(again.snapshot.body?.['label']).toBe('Gift');
    expect(again.snapshot.hasDraft).toBe(true);
  });
});

describe('DraftSession: check, changes, publish', () => {
  it('checks the body being edited and lists errors', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, titleField: 'missing' });
    const check = await s.check();
    expect(check?.errors.map((e) => e.path)).toEqual(['/titleField']);
    expect(s.snapshot.check).toEqual(check);
  });

  it('loads the draft-against-published lines and, for module definitions, organisation-against-module lines', async () => {
    const g = memoryGateway();
    await g.builder.savePatch('recordType', 'donation', { label: 'Gift' });
    const { s } = open(g, 'recordType', 'donation');
    await s.load();
    await s.loadChanges('module');
    expect(s.snapshot.changes?.lines).toEqual(["Changes 'label'"]);
    expect(s.snapshot.changesAgainst).toBe('module');

    s.edit({ ...s.snapshot.body!, description: 'Gifts from donors' });
    await s.loadChanges('published');
    expect(s.snapshot.changes?.lines).toEqual(['Adds description']);
  });

  it('summarises before publishing, then publishes the draft', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Helpers' });
    await s.openPublish();
    expect(s.snapshot.summary).toEqual({ version: 2, lines: ["Changes 'label'"], warnings: [], errors: [] });
    expect(await s.publish()).toBe(true);
    expect(s.snapshot).toMatchObject({ summary: null, hasDraft: false, message: 'Published. The change is live.' });
    expect(s.snapshot.detail?.published?.version).toBe(2);
    expect((await g.auth.definitions()).recordTypes.find((t) => t.key === 'volunteer')?.label).toBe('Helpers');
  });

  it('publishes a module definition\'s edits as the organisation\'s patch', async () => {
    const g = memoryGateway();
    const local = memoryDrafts();
    const { s } = open(g, 'recordType', 'donation', local);
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Gift' });
    await s.openPublish();
    expect(s.snapshot.summary).toMatchObject({ version: 2, lines: ['Changes label'], errors: [] });
    expect(await s.publish()).toBe(true);
    expect(g.calls.find((c) => c.op === 'savePatch')?.args[2]).toEqual({ label: 'Gift' });
    expect(local.read('recordType/donation')).toBeNull();
    expect(s.snapshot).toMatchObject({ patched: true, hasDraft: false });
  });

  it('shows errors in the summary and leaves publishing to the server', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, titleField: 'missing' });
    await s.openPublish();
    expect(s.snapshot.summary?.errors.map((e) => e.path)).toEqual(['/titleField']);
    s.closePublish();
    expect(s.snapshot.summary).toBeNull();
  });
});

describe('DraftSession: discard, restore, revert', () => {
  it('discards the draft and goes back to the published version', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Helpers' });
    await s.flush();
    expect(await s.discard()).toBe(true);
    expect(s.snapshot).toMatchObject({ hasDraft: false, missing: false });
    expect(s.snapshot.body?.['label']).toBe('Volunteer');
  });

  it('discarding the only draft of a new definition leaves nothing', async () => {
    const g = memoryGateway();
    await g.builder.saveDraft('recordType', 'shift', { key: 'shift', label: 'Shift', fields: [{ key: 'name', label: 'Name', type: 'text' }] });
    const { s } = open(g, 'recordType', 'shift');
    await s.load();
    await s.discard();
    expect(s.snapshot.missing).toBe(true);
    await expect(g.builder.detail('recordType', 'shift')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('discards a module definition\'s edits kept on the device', async () => {
    const g = memoryGateway();
    const local = memoryDrafts();
    const { s, clock } = open(g, 'recordType', 'donation', local);
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Gift' });
    await s.discard();
    expect(clock.pending()).toEqual([]);
    expect(local.read('recordType/donation')).toBeNull();
    expect(s.snapshot.body?.['label']).not.toBe('Gift');
  });

  it('restores an earlier version as the newest published version', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Helpers' });
    await s.publish();
    expect(s.snapshot.history.map((h) => [h.version, h.canRestore])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(await s.restore(1)).toBe(true);
    expect(s.snapshot.detail?.published?.version).toBe(3);
    expect(s.snapshot.body?.['label']).toBe('Volunteer');
  });

  it('restores an earlier version of a module definition, dropping what was kept on the device', async () => {
    const g = memoryGateway();
    const local = memoryDrafts();
    const { s } = open(g, 'recordType', 'donation', local);
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Gift' });
    await s.publish();
    s.edit({ ...s.snapshot.body!, label: 'Contribution' });
    await s.publish();
    s.edit({ ...s.snapshot.body!, description: 'Not published' });
    await s.flush();

    expect(await s.restore(2)).toBe(true);
    expect(local.read('recordType/donation')).toBeNull();
    expect(s.snapshot).toMatchObject({ hasDraft: false, message: 'Version 2 restored.' });
    expect(s.snapshot.detail?.published?.version).toBe(4);
    expect(s.snapshot.body?.['label']).toBe('Gift');
  });

  it('reverts a module definition to the module\'s version', async () => {
    const g = memoryGateway();
    await g.builder.savePatch('recordType', 'donation', { label: 'Gift' });
    const { s } = open(g, 'recordType', 'donation');
    await s.load();
    expect(await s.revertToModule()).toBe(true);
    expect(g.calls.filter((c) => c.op === 'savePatch').at(-1)?.args[2]).toEqual({});
    expect(s.snapshot).toMatchObject({ patched: false, message: 'Reverted to the module version.' });
    expect(s.snapshot.body?.['label']).toBe((await g.builder.detail('recordType', 'donation')).shipped?.base['label']);
  });

  it('does not revert an organisation\'s own definition', async () => {
    const g = await tenantDefinition();
    const { s } = open(g, 'recordType', 'volunteer');
    await s.load();
    expect(await s.revertToModule()).toBe(false);
  });

  it('saves what is waiting when closed and schedules nothing afterwards', async () => {
    const g = await tenantDefinition();
    const { s, clock } = open(g, 'recordType', 'volunteer');
    await s.load();
    s.edit({ ...s.snapshot.body!, label: 'Helpers' });
    await s.dispose();
    expect((await g.builder.detail('recordType', 'volunteer')).draft?.body['label']).toBe('Helpers');
    s.edit({ ...s.snapshot.body!, label: 'Later' });
    expect(clock.pending()).toEqual([]);
  });
});
