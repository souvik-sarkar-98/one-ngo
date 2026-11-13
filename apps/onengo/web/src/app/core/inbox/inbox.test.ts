import { describe, expect, it } from 'vitest';
import { paramsOf } from '../records/gateway/testing';
import { memoryGateway } from '../testing/memory-gateway';
import { INBOX_PARAMS, PAGE_SIZE, defaultTab, inboxParams, parseInboxAddress } from './address';
import { approvalQuery, type ApprovalsSession } from './approvals-session';
import { NotificationsFeed } from './notifications';
import { approvalFilters, approvalPills, countLabel, inboxChips, notificationAddress, recordAddress, waitedFor } from './rows';
import { inboxHarness, inboxSeed } from './testing';

/** Architecture §4: the Inbox's parameters, and which changes add a history entry. */
describe('inbox address contract', () => {
  type Case = { name: string; start: Record<string, string>; act: (s: ApprovalsSession) => void; push: boolean; writes: Record<string, string | null> };
  const CASES: Case[] = [
    { name: 'tab', start: { tab: 'approvals', q: 'don' }, act: (s) => s.selectTab('notifications'), push: true, writes: { tab: 'notifications', q: 'don' } },
    { name: 'search', start: { tab: 'approvals', show: '40' }, act: (s) => s.search(' DON/2026 '), push: false, writes: { q: 'DON/2026', show: null } },
    { name: 'filters', start: { tab: 'approvals' }, act: (s) => s.applyFilters({ type: ['donation'], requestedBy: ['u3'] }), push: false, writes: { type: 'donation', step: null, requestedBy: 'u3' } },
    { name: 'remove a filter', start: { tab: 'approvals', type: 'donation', step: 'cancel' }, act: (s) => s.removeFilter('type'), push: false, writes: { type: null, step: 'cancel' } },
    { name: 'clear filters', start: { tab: 'approvals', type: 'donation', requestedBy: 'u2' }, act: (s) => s.clearFilters(), push: false, writes: { type: null, requestedBy: null } },
    { name: 'sort', start: { tab: 'approvals' }, act: (s) => s.toggleSort('requestedBy'), push: false, writes: { sort: 'requestedBy' } },
    { name: 'sort again', start: { tab: 'approvals', sort: 'requestedBy' }, act: (s) => s.toggleSort('requestedBy'), push: false, writes: { sort: '-requestedBy' } },
    { name: 'sort cleared', start: { tab: 'approvals', sort: '-requestedBy' }, act: (s) => s.toggleSort('requestedBy'), push: false, writes: { sort: null } },
  ];

  it('owns exactly tab, q, type, step, requestedBy, sort and show', () => {
    expect([...INBOX_PARAMS].sort()).toEqual(['q', 'requestedBy', 'show', 'sort', 'step', 'tab', 'type']);
    expect(Object.keys(inboxParams(parseInboxAddress(paramsOf({})))).sort()).toEqual([...INBOX_PARAMS].sort());
  });

  for (const c of CASES) {
    it(`${c.name}: ${c.push ? 'adds a history entry' : 'replaces the current entry'}`, async () => {
      const h = inboxHarness(c.start);
      await h.start();
      h.urls.length = 0;
      c.act(h.session);
      expect(h.urls[0]!.replace).toBe(!c.push);
      expect(h.urls[0]!.params).toMatchObject(c.writes);
      expect(Object.keys(h.urls[0]!.params).every((k) => (INBOX_PARAMS as readonly string[]).includes(k))).toBe(true);
    });
  }

  it('loading more replaces the entry and writes the depth', async () => {
    const h = inboxHarness({ tab: 'approvals' });
    await h.start();
    h.session.loadMore();
    expect(h.urls.at(-1)).toMatchObject({ replace: true, params: { show: String(PAGE_SIZE * 2) } });
  });

  it('drops invalid parameters and leaves unknown ones alone', () => {
    const bad = parseInboxAddress(paramsOf({ tab: 'archive', sort: 'amount', show: 'lots', q: '  ', foo: 'bar' }));
    expect(bad).toEqual(parseInboxAddress(paramsOf({})));
    expect(parseInboxAddress(paramsOf({ show: '25', sort: '-waiting', type: 'donation,expense' }))).toMatchObject({ show: 40, sort: { field: 'waiting', dir: 'desc' }, type: ['donation', 'expense'] });
  });

  it('opens on Approvals when anything is waiting, otherwise on Notifications, without adding history', async () => {
    expect([defaultTab(3), defaultTab(0)]).toEqual(['approvals', 'notifications']);
    const busy = inboxHarness();
    await busy.start();
    await busy.settle();
    expect(busy.urls).toEqual([{ replace: true, params: expect.objectContaining({ tab: 'approvals' }) }]);
    const quiet = inboxHarness({}, inboxSeed(0));
    await quiet.start();
    await quiet.settle();
    expect(quiet.urls).toEqual([{ replace: true, params: expect.objectContaining({ tab: 'notifications' }) }]);
    expect(quiet.queries()).toEqual([]);
  });

  it('a tab given in the address wins over the default', async () => {
    const h = inboxHarness({ tab: 'notifications' });
    await h.start();
    await h.settle();
    expect(h.urls).toEqual([]);
    expect(h.queries()).toEqual([]);
  });
});

describe('approvals session over the memory gateway', () => {
  it('lists requests waiting for me, longest waiting first, with only the common workflow fields', async () => {
    const h = inboxHarness({ tab: 'approvals' });
    await h.start();
    const rows = h.session.rows;
    expect(rows.total).toBe(32);
    expect(rows.items).toHaveLength(PAGE_SIZE);
    expect(rows.items.map((r) => r.id).slice(0, 3)).toEqual(['approval-1', 'approval-2', 'approval-3']);
    expect(rows.items.some((r) => r.requestedBy === 'u1')).toBe(false);
    expect(rows.items[0]).toEqual({
      id: 'approval-1',
      recordId: 'donation-2',
      recordType: 'donation',
      recordTypeLabel: 'Donation',
      recordNumber: 'DON/2026-27/00002',
      recordTitle: 'Rahul Banerjee',
      step: 'cancel',
      stepLabel: 'Cancel donation',
      fromStatusLabel: 'Raised',
      toStatusLabel: 'Cancelled',
      requestedBy: 'u2',
      requestedByName: 'Vikram Iyer',
      requestedAt: '2026-10-01T00:00:00.000Z',
      approvalsGiven: 0,
      approvalsNeeded: 2,
    });
    expect(h.queries()).toEqual([{ offset: 0, limit: PAGE_SIZE }]);
  });

  it('pages as the depth grows, each page once, and stops at the total', async () => {
    const h = inboxHarness({ tab: 'approvals' });
    await h.start();
    h.session.loadMore();
    h.session.loadMore();
    await h.settle();
    h.session.loadMore();
    await h.settle();
    expect(h.queries().map((q) => [q.offset, q.limit])).toEqual([
      [0, 20],
      [20, 20],
    ]);
    expect(h.session.rows).toMatchObject({ total: 32, hasMore: false });
    expect(h.session.rows.items).toHaveLength(32);
  });

  it('searches, filters and sorts on the server, starting again from the first page', async () => {
    const h = inboxHarness({ tab: 'approvals', show: '40' });
    await h.start();
    h.session.applyFilters({ requestedBy: ['u3'] });
    await h.settle();
    expect(h.session.rows.items.map((r) => r.requestedByName)).toEqual(Array(8).fill('Kiran Rao'));
    h.session.toggleSort('requestedBy');
    h.session.search('00010');
    await h.settle();
    expect(h.queries().at(-1)).toEqual({ search: '00010', filters: { requestedBy: ['u3'] }, sort: { field: 'requestedBy', dir: 'asc' }, offset: 0, limit: 20 });
    expect(h.session.rows.items.every((r) => r.recordNumber === 'DON/2026-27/00010')).toBe(true);
    h.session.clearFilters();
    h.session.search('');
    await h.settle();
    expect(h.session.rows.total).toBe(32);
    expect(approvalQuery(parseInboxAddress(paramsOf({ q: 'x', step: 'cancel', sort: '-waiting' })), 40, 20)).toEqual({
      search: 'x',
      filters: { step: ['cancel'] },
      sort: { field: 'waiting', dir: 'desc' },
      offset: 40,
      limit: 20,
    });
  });

  it('decided requests leave the list and the waiting count follows', async () => {
    const h = inboxHarness({ tab: 'approvals' });
    await h.start();
    expect(await h.session.refreshCount()).toBe(32);
    expect(await h.session.decide('approval-2', 'approve')).toEqual({ ok: true, message: 'Approved and applied.' });
    expect(await h.session.decide('approval-3', 'reject', '  Receipt missing  ')).toEqual({ ok: true, message: 'Rejected.' });
    expect(h.g.calls.filter((c) => c.op === 'decide').map((c) => c.args)).toEqual([
      ['approval-2', 'approve', undefined],
      ['approval-3', 'reject', 'Receipt missing'],
    ]);
    // Two approvals needed: mine is recorded, and the request is no longer waiting for me.
    expect(await h.session.decide('approval-1', 'approve')).toEqual({ ok: true, message: 'Your approval was recorded.' });
    await h.settle();
    expect(h.session.rows.items.map((r) => r.id)).not.toContain('approval-1');
    expect(h.session.rows.total).toBe(29);
    expect(h.session.waiting).toBe(29);
    h.session.loadMore();
    await h.settle();
    expect(h.session.rows.items).toHaveLength(29);
  });

  it('an out-of-date request leaves the list with the server message; a failed call keeps it', async () => {
    const h = inboxHarness({ tab: 'approvals' });
    await h.start();
    await h.g.inbox.decide('approval-2', 'reject');
    expect(await h.session.decide('approval-2', 'approve')).toEqual({ ok: true, message: 'This request has already been decided.' });
    expect(h.session.rows.items.map((r) => r.id)).not.toContain('approval-2');
    h.g.inbox.decide = () => Promise.reject({ code: 'offline', message: 'Cannot reach the server.' });
    expect(await h.session.decide('approval-3', 'approve')).toEqual({ ok: false, message: 'Cannot reach the server.' });
    expect(h.session.rows.items.map((r) => r.id)).toContain('approval-3');
  });

  it('builds the filters from the workflows that ask for approval and the people seen, with pills to match', async () => {
    const h = inboxHarness({ tab: 'approvals', type: 'donation', requestedBy: 'u3,u9' });
    await h.start();
    const defs = await h.g.auth.definitions();
    const filters = approvalFilters(defs, h.session.requesters, h.session.state);
    expect(filters.map((f) => [f.key, f.options.map((o) => o.label)])).toEqual([
      ['type', ['Donation']],
      ['step', ['Cancel donation']],
      ['requestedBy', ['Kiran Rao', 'u9']],
    ]);
    expect(approvalPills(h.session.state, filters)).toEqual([
      { id: 'type', label: 'Type: Donation' },
      { id: 'requestedBy', label: 'Requested by: Kiran Rao, u9' },
    ]);
  });
});

describe('inbox chips, times and links', () => {
  it('shows counts on the chips, capped for large unread counts', () => {
    expect(inboxChips(4, 3).map((c) => c.label)).toEqual(['Approvals 4', 'Notifications 3']);
    expect(inboxChips(0, null).map((c) => c.label)).toEqual(['Approvals', 'Notifications']);
    expect(countLabel(100)).toBe('99+');
  });

  it('says how long a request has waited', () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    expect(waitedFor('2026-10-04T11:59:30.000Z', now)).toBe('0 minutes');
    expect(waitedFor('2026-10-04T11:59:00.000Z', now)).toBe('1 minute');
    expect(waitedFor('2026-10-04T07:00:00.000Z', now)).toBe('5 hours');
    expect(waitedFor('2026-10-01T12:00:00.000Z', now)).toBe('3 days');
  });

  it('opens records in their list, and notifications by their own link or a known record', () => {
    expect(recordAddress('donation', 'donation-2')).toBe('/records/donation?id=donation-2');
    const n = { id: 'n', subject: 's', body: 'b', recordId: 'donation-2', readAt: null, createdAt: '2026-10-01T00:00:00.000Z' };
    expect(notificationAddress({ ...n, link: '/records/donation?import=i1&importStep=5' }, () => undefined)).toBe('/records/donation?import=i1&importStep=5');
    expect(notificationAddress({ ...n, link: '/api/files/f1' }, () => 'donation')).toBe('/records/donation?id=donation-2');
    expect(notificationAddress({ ...n, link: '//elsewhere.example/x' }, () => undefined)).toBeNull();
    expect(notificationAddress(n, () => undefined)).toBeNull();
  });
});

describe('notifications feed over the memory gateway', () => {
  it('pages newest first, marks one or all read, and keeps the unread count', async () => {
    const g = memoryGateway(inboxSeed(0, 45));
    const feed = new NotificationsFeed(g.inbox, 20, () => new Date('2026-10-20T10:00:00.000Z'));
    await Promise.all([feed.load(), feed.countUnread()]);
    expect(feed.snapshot).toMatchObject({ hasMore: true, unread: 22 });
    expect(feed.snapshot.items.map((n) => n.subject).slice(0, 2)).toEqual(['Notice 45', 'Notice 44']);
    await feed.loadMore();
    await feed.loadMore();
    expect(feed.snapshot.items).toHaveLength(45);
    expect(feed.snapshot.hasMore).toBe(false);
    expect(new Set(feed.snapshot.items.map((n) => n.id)).size).toBe(45);
    await feed.markRead('notification-044');
    expect(feed.snapshot.unread).toBe(21);
    expect(await g.inbox.notifications({ unreadOnly: true, limit: 100 })).toHaveLength(21);
    expect(await feed.markAllRead()).toBeNull();
    expect(feed.snapshot.unread).toBe(0);
    expect(feed.snapshot.items.every((n) => n.readAt)).toBe(true);
    expect(await g.inbox.notifications({ unreadOnly: true })).toEqual([]);
  });

  it('reports a failed load and retries', async () => {
    const g = memoryGateway(inboxSeed(0, 3));
    const real = g.inbox.notifications;
    g.inbox.notifications = () => Promise.reject(new Error('boom'));
    const feed = new NotificationsFeed(g.inbox);
    await feed.load();
    expect(feed.snapshot.error).toBe('Could not load your inbox.');
    g.inbox.notifications = real;
    await feed.retry();
    expect(feed.snapshot).toMatchObject({ error: '', hasMore: false });
    expect(feed.snapshot.items).toHaveLength(3);
  });
});
