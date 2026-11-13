import { contracted, type ApprovalDecisionRequest, type ApprovalQueryRequest } from '../contracts';
import type { HttpLike } from '../http/http';
import type { ApprovalItem, ApprovalQueryBody, ApprovalRow, InboxNotification } from '../models';

export interface NotificationsQuery {
  unreadOnly?: boolean;
  limit?: number;
  /** The id of the last notification already shown; the page starts after it. */
  before?: string;
}

/** Approvals waiting for the person and their notifications. */
export interface InboxGateway {
  approvals(): Promise<ApprovalItem[]>;
  queryApprovals(body: ApprovalQueryBody): Promise<{ items: ApprovalRow[]; total: number }>;
  countApprovals(): Promise<{ waiting: number }>;
  decide(approvalId: string, decision: 'approve' | 'reject', comment?: string): Promise<{ status: string; message?: string }>;
  /** Newest first. */
  notifications(query?: NotificationsQuery): Promise<InboxNotification[]>;
  markRead(notificationId: string): Promise<void>;
  markAllRead(): Promise<{ marked: number }>;
}

/** Whether a link points at the server's API (a file download, say) rather than a screen of the app. */
export const isServerAddress = (link: string): boolean => link.startsWith('/api/');

/** The approval routes with fixed contracts. */
export interface ApprovalRoutes {
  'POST /api/approvals/query': { body: ApprovalQueryRequest; answer: { items: ApprovalRow[]; total: number } };
  'POST /api/approvals/:id/decision': { body: ApprovalDecisionRequest; answer: { status: string; message?: string } };
}

export function httpInbox(http: HttpLike): InboxGateway {
  const send = contracted<ApprovalRoutes>(http);
  return {
    approvals: () => http.get<ApprovalItem[]>('/api/approvals/inbox'),
    queryApprovals: (body) => send('POST /api/approvals/query', body),
    countApprovals: () => http.get<{ waiting: number }>('/api/approvals/count'),
    decide: (id, decision, comment) => send('POST /api/approvals/:id/decision', { id }, { decision, comment }),
    notifications: (query = {}) => {
      const params = new URLSearchParams();
      if (query.unreadOnly) params.set('unread', 'true');
      if (query.limit) params.set('limit', String(query.limit));
      if (query.before) params.set('before', query.before);
      const qs = params.toString();
      return http.get<InboxNotification[]>(`/api/notifications${qs ? `?${qs}` : ''}`);
    },
    markRead: (notificationId) => http.post(`/api/notifications/${encodeURIComponent(notificationId)}/read`),
    markAllRead: () => http.post<{ marked: number }>('/api/notifications/read-all'),
  };
}
