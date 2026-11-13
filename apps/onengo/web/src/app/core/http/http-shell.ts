import type { HttpLike } from './http';
import type { ShellGateway } from '../shell/shell';

/** Writes after which the approvals waiting for the person may have changed: decisions, withdrawals and workflow steps. */
export function changesApprovals(method: string, url: string): boolean {
  return method !== 'GET' && (/^\/api\/approvals\/[^/?]+\/(decision|withdraw)$/.test(url) || /^\/api\/records\/[^/]+\/[^/]+\/transitions\//.test(url));
}

export function httpShell(http: HttpLike): ShellGateway {
  return {
    approvalsWaiting: async () => (await http.get<{ waiting: number }>('/api/approvals/count')).waiting,
  };
}
