import type { Params } from '../address';
import type { ApprovalQueryBody } from '../models';
import { memoryGateway, sampleSeed, type SampleSeed } from '../testing/memory-gateway';
import { ApprovalsSession } from './approvals-session';

const RAISED = ['donation-2', 'donation-4', 'donation-7', 'donation-9', 'donation-10', 'donation-12'];

/**
 * The sample organisation with `n` cancel requests, one a minute from 1 Oct
 * 2026 (the first has waited longest). Every fifth is Asha's own (the
 * signed-in person), every fifth from the fourth Kiran's, the rest Vikram's;
 * every third needs two approvals. `notifications` adds that many for Asha,
 * one an hour, the even ones read.
 */
export function inboxSeed(n = 40, notifications = 0): SampleSeed {
  const s = sampleSeed();
  s.users.push({ id: 'u3', displayName: 'Kiran Rao', email: 'kiran@example.org', password: 'kiran of seva trust', roles: [] });
  s.approvals = Array.from({ length: n }, (_, i) => ({
    id: `approval-${i + 1}`,
    recordType: 'donation',
    recordId: RAISED[i % RAISED.length]!,
    transition: 'cancel',
    requestedBy: i % 5 === 4 ? 'u1' : i % 5 === 3 ? 'u3' : 'u2',
    approvalsNeeded: i % 3 === 0 ? 2 : 1,
    approvalsGiven: 0,
    status: 'pending' as const,
    data: {},
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }));
  if (notifications) {
    s.notifications = Array.from({ length: notifications }, (_, i) => ({
      id: `notification-${String(i + 1).padStart(3, '0')}`,
      userId: 'u1',
      subject: `Notice ${i + 1}`,
      body: 'Something happened.',
      recordId: null,
      readAt: i % 2 === 0 ? '2026-10-19T00:00:00.000Z' : null,
      createdAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
    }));
  }
  return s;
}

/** An approvals session over the memory gateway, wired to a fake address bar. */
export function inboxHarness(start: Record<string, string> = {}, seed: SampleSeed = inboxSeed()) {
  const g = memoryGateway(seed);
  const urls: { params: Params; replace: boolean }[] = [];
  let params: Record<string, string> = { ...start };
  const session = new ApprovalsSession(g.inbox, {
    navigate: (next, replace) => {
      urls.push({ params: next, replace });
      params = Object.fromEntries(Object.entries({ ...params, ...next }).filter(([, v]) => v !== null)) as Record<string, string>;
      void session.fromUrl((name) => params[name] ?? null);
    },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    g,
    session,
    urls,
    settle,
    params: () => params,
    queries: () => g.calls.filter((c) => c.op === 'queryApprovals').map((c) => c.args[0] as ApprovalQueryBody),
    start: () => session.fromUrl((name) => params[name] ?? null),
  };
}
