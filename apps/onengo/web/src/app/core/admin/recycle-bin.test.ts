import { describe, expect, it } from 'vitest';
import type { Me } from '../models';
import { adminHome, mayOpen } from './areas';
import { ConnectorSession, ConnectorsList, summaryState } from './connectors';
import { BIN_PAGE, RecycleBinSession, binName } from './recycle-bin';
import { fakeAddress, memoryAdmin } from './testing';

const caps = (c: Partial<Me['capabilities']>): Me['capabilities'] => ({ configure: false, publish: false, scripts: false, money: false, ...c });

describe('the recycle bin area', () => {
  it('is under Data, for people who may delete records', () => {
    expect(adminHome(caps({ recordBin: true })).data.map((a) => [a.id, a.label, a.link])).toEqual([['recordBin', 'Recycle bin', '/admin/recycle-bin']]);
    expect(adminHome(caps({ migration: true, recordBin: true })).data.map((a) => a.id)).toEqual(['migration', 'recordBin']);
    expect(mayOpen('recordBin', caps({ recordBin: true }))).toBe(true);
    expect(mayOpen('recordBin', caps({ settings: true, migration: true }))).toBe(false);
    expect(mayOpen('recordBin', undefined)).toBe(false);
  });
});

describe('the recycle bin session', () => {
  it('lists deleted records, searches on the server and names each by title, else number', async () => {
    const m = memoryAdmin();
    const s = new RecycleBinSession(m.gateway);
    await s.load();
    expect(s.state.value.items.map((r) => r.id)).toEqual(['r-kabir', 'r-meera']);
    expect(s.state.value.total).toBe(2);
    expect(m.calls.at(-1)!.args[0]).toEqual({ q: undefined, limit: BIN_PAGE, offset: 0 });
    await s.search(' kabir ');
    expect(s.state.value.q).toBe('kabir');
    expect(s.state.value.items.map((r) => r.id)).toEqual(['r-kabir']);
    expect(m.calls.at(-1)!.args[0]).toEqual({ q: 'kabir', limit: BIN_PAGE, offset: 0 });
    const calls = m.calls.length;
    await s.search('kabir');
    expect(m.calls).toHaveLength(calls);
    expect(binName({ ...s.state.value.items[0]!, title: null })).toBe('DON/2026/00004');
    expect(binName({ ...s.state.value.items[0]!, title: null, number: null })).toBe('Untitled record');
  });

  it('keeps the latest search when an older answer arrives late', async () => {
    const m = memoryAdmin();
    const slow = m.gateway.deletedRecords;
    let release: () => void = () => undefined;
    m.gateway.deletedRecords = async (q) => {
      if (q.q === 'slow') await new Promise<void>((r) => (release = r));
      return slow(q);
    };
    const s = new RecycleBinSession(m.gateway);
    const first = s.search('slow');
    await s.search('meera');
    release();
    await first;
    expect(s.state.value.items.map((r) => r.id)).toEqual(['r-meera']);
  });

  it('restores after a confirmation, takes the record out of the list and says so', async () => {
    const m = memoryAdmin();
    const s = new RecycleBinSession(m.gateway);
    await s.load();
    s.askRestore('r-kabir');
    expect(s.state.value.restoring?.id).toBe('r-kabir');
    expect(await s.confirmRestore()).toEqual({ ok: true, message: 'Kabir restored.' });
    expect(m.calls.find((c) => c.op === 'restoreRecord')!.args).toEqual(['r-kabir', 3]);
    expect(s.state.value).toMatchObject({ restoring: null, total: 1, busy: false });
    expect(s.state.value.items.map((r) => r.id)).toEqual(['r-meera']);
  });

  it('keeps the confirmation open with the reason when the server refuses, and reads the list again on a conflict', async () => {
    const m = memoryAdmin();
    const s = new RecycleBinSession(m.gateway);
    await s.load();
    s.askRestore('r-kabir');
    await m.gateway.restoreRecord('r-kabir', 3);
    const out = await s.confirmRestore();
    expect(out).toEqual({ ok: false, message: '' });
    expect(s.state.value.restoring?.id).toBe('r-kabir');
    expect(s.state.value.restoreError).toBe('Deleted record not found.');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.value.items.map((r) => r.id)).toEqual(['r-meera']);
    s.cancelRestore();
    expect(s.state.value).toMatchObject({ restoring: null, restoreError: '' });
    expect(await s.confirmRestore()).toEqual({ ok: false, message: '' });
  });
});

describe('archiving a connector', () => {
  it('lists active connectors by default, archived ones on their own chip, and names the state', async () => {
    const m = memoryAdmin();
    await m.gateway.saveConnector('spare', { kind: 'webhook', enabled: false, config: { url: 'https://spare.test/' }, secrets: { signingSecret: 'x' } });
    const list = new ConnectorsList(m.gateway);
    await list.load();
    expect(list.shown().map((c) => c.key)).toEqual(['crm', 'spare']);
    expect(list.archivedCount()).toBe(0);
    await m.gateway.archiveConnector('spare');
    await list.load();
    expect(list.shown().map((c) => c.key)).toEqual(['crm']);
    list.setChip('archived');
    expect(list.shown().map((c) => [c.key, c.enabled, summaryState(c)])).toEqual([['spare', false, 'Archived']]);
    expect(list.archivedCount()).toBe(1);
    list.setChip('anything');
    expect(list.state.value.chip).toBe('active');
  });

  it('switches a connector off and on without touching its other settings', async () => {
    const m = memoryAdmin();
    const s = new ConnectorSession(m.gateway, 'crm', fakeAddress().nav);
    await s.load();
    expect(await s.setEnabled(false)).toEqual({ ok: true, message: 'Connector switched off.' });
    expect(m.calls.filter((c) => c.op === 'saveConnector').at(-1)!.args[1]).toEqual({ enabled: false });
    expect(s.state.value.view).toMatchObject({ enabled: false, archived: false });
    expect(s.state.value.values['enabled']).toBe(false);
    expect((await s.setEnabled(true)).ok).toBe(true);
    expect(s.state.value.view?.enabled).toBe(true);
  });

  it('archives, shows the connector read-only, and restores it switched off', async () => {
    const m = memoryAdmin();
    await m.gateway.saveConnector('spare', { kind: 'webhook', enabled: true, config: { url: 'https://spare.test/' }, secrets: { signingSecret: 'x' } });
    const s = new ConnectorSession(m.gateway, 'spare', fakeAddress().nav);
    await s.load();
    expect(s.isArchived()).toBe(false);
    expect(s.fields().every((f) => !f.readOnly)).toBe(true);
    expect(await s.archive()).toEqual({ ok: true, message: 'Connector archived.' });
    expect(s.isArchived()).toBe(true);
    expect(s.state.value.view).toMatchObject({ archived: true, enabled: false });
    expect(s.fields().every((f) => f.readOnly)).toBe(true);
    expect((await s.setEnabled(true)).ok).toBe(false);
    expect(await s.restore()).toEqual({ ok: true, message: 'Connector restored. It stays switched off until you switch it on.' });
    expect(s.state.value.view).toMatchObject({ archived: false, enabled: false });
    expect(s.fields().every((f) => !f.readOnly)).toBe(true);
    expect((await s.restore()).ok).toBe(false);
  });

  it('shows why the server refuses to archive a connector that is still used', async () => {
    const m = memoryAdmin();
    const s = new ConnectorSession(m.gateway, 'crm', fakeAddress().nav);
    await s.load();
    const out = await s.archive();
    expect(out).toEqual({ ok: false, message: "'crm' is still used by Tell the CRM. Stop using it there first." });
    expect(s.isArchived()).toBe(false);
    expect(s.state.value.saving).toBe(false);
  });
});
