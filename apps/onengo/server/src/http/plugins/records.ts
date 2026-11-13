import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { notFound } from '@onengo/kernel/errors';
import { recordQueryOf, type RecordsApi, type RequestContext, type ShareInput } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import { approvalDecisionRequest, approvalQueryRequest, type ApprovalDecisionRequest, type ApprovalQueryRequest } from '@onengo/platform/contracts';
import {
  actionRequest,
  aggregateRequest,
  bulkRequest,
  createRecordRequest,
  recordQueryRequest,
  transitionRequest,
  updateRecordRequest,
  type ActionRequest,
  type AggregateRequestBody,
  type BulkRequest,
  type CreateRecordRequest,
  type RecordQueryRequest,
  type TransitionRequest,
  type UpdateRecordRequest,
} from '@onengo/platform/contracts';
import { attachment } from '../download.js';
import { sendOnce } from '../idempotent.js';
/** Records, their shares, receipts and approvals, and published definitions. Signed-in scope only. */
export async function recordRoutes(api: FastifyInstance, { deps }: { deps: RecordsApi }): Promise<void> {
  /** Create, update and step requests honour `Idempotency-Key` (24 hours, per actor). */
  const once = (ctx: RequestContext, req: FastifyRequest, reply: FastifyReply, status: number, run: () => Promise<unknown>) =>
    sendOnce(deps.idempotency, req.headers['idempotency-key'], ctx, req, reply, status, run);

  api.post<{ Params: { type: string }; Body: CreateRecordRequest }>('/api/records/:type', { schema: { body: createRecordRequest } }, async (req, reply) => {
    const ctx = contextOf(req);
    return once(ctx, req, reply, 201, () => deps.createRecord.run(ctx, req.params.type, req.body));
  });

  api.get<{ Params: { type: string }; Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>(
    '/api/records/:type',
    async (req) => deps.listRecords.run(contextOf(req), req.params.type, req.query),
  );

  /** Filtered list with a total: { statusIn, owner, sharedWithMe, search, filters: { field: { in, eq, from, to } }, limit, offset }. */
  api.post<{ Params: { type: string }; Body: RecordQueryRequest }>('/api/records/:type/query', { schema: { body: recordQueryRequest } }, async (req) => {
    const ctx = contextOf(req);
    return deps.queryRecords.run(ctx, req.params.type, req.body);
  });

  /**
   * One operation over selected records: { ids } or { query } (every match, up to the limit), and
   * operation { type: 'edit', values } | { type: 'step', step, data? } | { type: 'action', action, input? }
   * | { type: 'share', principalKind, principal, access, expiresAt? } | { type: 'export' }.
   * Per-record results at once for small selections; 202 with the job for larger ones; export answers as export.csv does.
   */
  api.post<{ Params: { type: string }; Body: BulkRequest }>('/api/records/:type/bulk', { schema: { body: bulkRequest } }, async (req, reply) => {
    const ctx = contextOf(req);
    const b = req.body;
    const selection = b.ids ? { ids: b.ids } : { query: recordQueryOf(b.query) };
    const out = await deps.bulk.run(ctx, req.params.type, selection, b.operation);
    if ('jobId' in out) return reply.status(202).send(out);
    if ('lines' in out) {
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', attachment(out.fileName))
        .header('x-content-type-options', 'nosniff')
        .send(Readable.from(out.lines));
    }
    return out;
  });

  /**
   * Counts and totals for pages: { statusIn, owner, sharedWithMe, filters, states, measure, field, groupBy },
   * with `widget: { page, index }` naming the page widget asking, refused when the person cannot see it.
   */
  api.post<{ Params: { type: string }; Body: AggregateRequestBody }>('/api/records/:type/aggregate', { schema: { body: aggregateRequest } }, async (req) => {
    return deps.aggregateRecords.run(contextOf(req), req.params.type, req.body);
  });

  api.get<{ Params: { type: string; id: string } }>('/api/records/:type/:id', async (req) =>
    deps.getRecord.run(contextOf(req), req.params.id),
  );

  api.patch<{ Params: { type: string; id: string }; Body: UpdateRecordRequest }>(
    '/api/records/:type/:id',
    { schema: { body: updateRecordRequest } },
    async (req, reply) => {
      const ctx = contextOf(req);
      return once(ctx, req, reply, 200, () => deps.updateRecord.run(ctx, req.params.id, req.body));
    },
  );

  api.post<{ Params: { type: string; id: string; transition: string }; Body: TransitionRequest }>(
    '/api/records/:type/:id/transitions/:transition',
    { schema: { body: transitionRequest } },
    async (req, reply) => {
      const ctx = contextOf(req);
      return once(ctx, req, reply, 200, () => deps.transitionRecord.run(ctx, req.params.id, req.params.transition, req.body));
    },
  );

  /** Runs a configured action: { input, expectedVersion } → { record, message, open? }. */
  api.post<{ Params: { type: string; id: string; key: string }; Body: ActionRequest }>(
    '/api/records/:type/:id/actions/:key',
    { schema: { body: actionRequest } },
    async (req) => deps.runAction.run(contextOf(req), req.params.type, req.params.id, req.params.key, req.body),
  );

  api.get<{ Params: { type: string; id: string } }>('/api/records/:type/:id/shares', async (req) =>
    deps.shares.list(contextOf(req), req.params.type, req.params.id),
  );
  /** ?q= → { items: [{ principalKind, principal, name, email?, canSee, canEdit }] }: people and roles to share with, for whoever manages the shares. */
  api.get<{ Params: { type: string; id: string }; Querystring: { q?: string } }>('/api/records/:type/:id/shares/candidates', async (req) =>
    deps.shares.candidates(contextOf(req), req.params.type, req.params.id, req.query),
  );

  /** Shares with a person or role: { principalKind: 'user' | 'role', principal, access: 'read' | 'edit', expiresAt? }. */
  api.post<{ Params: { type: string; id: string }; Body: ShareInput }>('/api/records/:type/:id/shares', async (req, reply) => {
    const share = await deps.shares.share(contextOf(req), req.params.type, req.params.id, req.body ?? {});
    return reply.status(201).send(share);
  });

  api.delete<{ Params: { type: string; id: string; shareId: string } }>('/api/records/:type/:id/shares/:shareId', async (req, reply) => {
    await deps.shares.remove(contextOf(req), req.params.type, req.params.id, req.params.shareId);
    return reply.status(204).send();
  });

  api.get<{ Params: { id: string } }>('/api/print/receipt/:id', async (req) => deps.printReceipt.run(contextOf(req), req.params.id));
  api.post<{ Params: { id: string } }>('/api/print/receipt/:id/link', async (req) => deps.receiptLinks.ensure(contextOf(req), req.params.id));
  api.delete<{ Params: { id: string } }>('/api/print/receipt/:id/link', async (req, reply) => {
    await deps.receiptLinks.revoke(contextOf(req), req.params.id);
    return reply.status(204).send();
  });

  api.get<{ Params: { type: string; id: string } }>('/api/records/:type/:id/public-link', async (req) => {
    const link = await deps.publicForms.linkFor(contextOf(req), req.params.id);
    if (!link) throw notFound('Not found.');
    return link;
  });
  api.delete<{ Params: { type: string; id: string } }>('/api/records/:type/:id/public-link', async (req, reply) => {
    await deps.publicForms.revoke(contextOf(req), req.params.id);
    return reply.status(204).send();
  });

  api.get<{ Params: { type: string; id: string } }>('/api/records/:type/:id/receipts', async (req) => {
    return deps.receipts.forRecord(contextOf(req), req.params.id);
  });

  api.get<{ Params: { type: string; id: string } }>('/api/records/:type/:id/approval', async (req) =>
    deps.recordApproval.pending(contextOf(req), req.params.id),
  );

  api.get<{ Params: { kind: string; key: string } }>('/api/definitions/:kind/:key', async (req) =>
    deps.getDefinition.run(contextOf(req), req.params.kind, req.params.key),
  );

  api.get('/api/approvals/inbox', async (req) => deps.approvals.inbox(contextOf(req)));

  api.post<{ Body: ApprovalQueryRequest }>('/api/approvals/query', { schema: { body: approvalQueryRequest } }, async (req) =>
    deps.queryApprovals.run(contextOf(req), req.body),
  );
  api.get('/api/approvals/count', async (req) => deps.approvals.count(contextOf(req)));
  api.post<{ Params: { id: string }; Body: ApprovalDecisionRequest }>(
    '/api/approvals/:id/decision',
    { schema: { body: approvalDecisionRequest } },
    async (req) => deps.approvals.decide(contextOf(req), req.params.id, req.body.decision, req.body.comment),
  );
  api.post<{ Params: { id: string } }>('/api/approvals/:id/withdraw', async (req, reply) => {
    await deps.approvals.withdraw(contextOf(req), req.params.id);
    return reply.status(204).send();
  });
}
