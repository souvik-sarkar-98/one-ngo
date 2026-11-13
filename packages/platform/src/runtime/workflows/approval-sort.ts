import type { ApprovalSortField } from './ports/approval-store.js';

export const APPROVAL_SORT_FIELDS = ['waiting', 'record', 'type', 'step', 'requestedBy'] as const satisfies readonly ApprovalSortField[];
