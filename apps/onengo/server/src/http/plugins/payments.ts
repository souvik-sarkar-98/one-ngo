import type { FastifyInstance } from 'fastify';
import type { PaymentsApi, WebhooksApi } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import {
  cashfreeCredentialsRequest,
  gatewayListResponse,
  razorpayCredentialsRequest,
  type CashfreeCredentialsRequest,
  type GatewaySummary,
  type RazorpayCredentialsRequest,
} from '@onengo/platform/contracts';
import { bodyText, parseJsonBody } from '../json-body.js';
import {
  confirmPaymentRequest,
  createPaymentRequest,
  openAccountRequest,
  reconciliationSignOffRequest,
  statementBookRequest,
  statementIgnoreRequest,
  statementImportRequest,
  statementMatchLineRequest,
  statementMatchRequest,
  transferRequest,
  updateAccountRequest,
  type ConfirmPaymentRequest,
  type CreatePaymentRequest,
  type OpenAccountRequest,
  type ReconciliationSignOffRequest,
  type StatementBookRequest,
  type StatementIgnoreRequest,
  type StatementImportRequest,
  type StatementMatchLineRequest,
  type StatementMatchRequest,
  type TransferRequest,
  type UpdateAccountRequest,
} from '@onengo/platform/contracts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The body exactly as sent; kept only on webhook routes, whose signatures cover these bytes. */
    rawBody?: string;
  }
}

/** Provider webhooks: public, each checked by the provider's signature over the raw body. */
export async function webhookRoutes(app: FastifyInstance, { deps }: { deps: WebhooksApi }): Promise<void> {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = bodyText(body);
    parseJsonBody(req.rawBody, done);
  });
  app.post<{ Params: { provider: string; tenantKey: string } }>('/webhooks/payments/:provider/:tenantKey', async (req, reply) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const outcome = await deps.paymentWebhook.run({ provider: req.params.provider, tenantKey: req.params.tenantKey, rawBody: req.rawBody ?? '', headers });
    if (outcome === 404) return reply.status(404).send();
    return reply.status(outcome).send({ ok: outcome === 200 });
  });
}

/** Money accounts, transfers, payments and payment gateway set-up. Signed-in scope only. */
export async function paymentRoutes(api: FastifyInstance, { deps }: { deps: PaymentsApi }): Promise<void> {
  api.get('/api/money/accounts', async (req) => deps.moneyAccounts.list(contextOf(req)));
  api.post<{ Body: OpenAccountRequest }>('/api/money/accounts', { schema: { body: openAccountRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.moneyAccounts.open(contextOf(req), req.body)),
  );
  api.patch<{ Params: { key: string }; Body: UpdateAccountRequest }>('/api/money/accounts/:key', { schema: { body: updateAccountRequest } }, async (req) =>
    deps.moneyAccounts.update(contextOf(req), req.params.key, req.body),
  );

  // Reconciliation: the bank's statement for one money account, paired with the books.
  const bank = deps.bankReconciliation;
  type Account = { Params: { key: string } };
  type Line = { Params: { key: string; lineId: string } };
  api.get<Account & { Querystring: { status?: string } }>('/api/money/accounts/:key/statement', async (req) =>
    bank.statement(contextOf(req), req.params.key, req.query.status),
  );
  api.post<Account & { Body: StatementImportRequest }>('/api/money/accounts/:key/statement', { schema: { body: statementImportRequest } }, async (req, reply) =>
    reply.status(201).send(await bank.importStatement(contextOf(req), req.params.key, req.body.lines)),
  );
  api.post<Account>('/api/money/accounts/:key/statement/auto-match', async (req) => bank.autoMatchAccount(contextOf(req), req.params.key));
  api.post<Line & { Body: StatementMatchLineRequest }>('/api/money/accounts/:key/statement/:lineId/match', { schema: { body: statementMatchLineRequest } }, async (req) =>
    bank.match(contextOf(req), req.params.key, req.params.lineId, req.body.journalLineId),
  );
  api.post<Line & { Body: StatementIgnoreRequest }>('/api/money/accounts/:key/statement/:lineId/ignore', { schema: { body: statementIgnoreRequest } }, async (req) =>
    bank.ignore(contextOf(req), req.params.key, req.params.lineId, req.body.note),
  );
  api.post<Line & { Body: StatementBookRequest }>('/api/money/accounts/:key/statement/:lineId/book', { schema: { body: statementBookRequest } }, async (req) =>
    bank.book(contextOf(req), req.params.key, req.params.lineId, req.body),
  );
  api.post<Line>('/api/money/accounts/:key/statement/:lineId/reopen', async (req) => bank.reopen(contextOf(req), req.params.key, req.params.lineId));
  api.get<Account & { Querystring: { asOf?: string; statementBalance?: string } }>('/api/money/accounts/:key/reconciliation', async (req) =>
    bank.report(contextOf(req), req.params.key, req.query.asOf ?? '', req.query.statementBalance ?? ''),
  );
  api.get<Account>('/api/money/accounts/:key/reconciliations', async (req) => bank.signOffs(contextOf(req), req.params.key));
  api.post<Account & { Body: ReconciliationSignOffRequest }>(
    '/api/money/accounts/:key/reconciliations',
    { schema: { body: reconciliationSignOffRequest } },
    async (req, reply) => reply.status(201).send(await bank.signOff(contextOf(req), req.params.key, req.body)),
  );

  api.post<{ Body: TransferRequest }>('/api/money/transfers', { schema: { body: transferRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.moneyAccounts.transfer(contextOf(req), req.body)),
  );

  api.post<{ Body: CreatePaymentRequest }>('/api/payments', { schema: { body: createPaymentRequest } }, async (req, reply) =>
    reply.status(201).send(await deps.requestPayment.run(contextOf(req), req.body.recordId, req.body.action, req.body.input ?? undefined)),
  );
  api.get<{ Params: { id: string } }>('/api/payments/:id', async (req) => deps.payments.get(contextOf(req), req.params.id));
  api.post<{ Params: { id: string }; Body: ConfirmPaymentRequest }>('/api/payments/:id/confirm', { schema: { body: confirmPaymentRequest } }, async (req, reply) => {
    await deps.confirmPayment.run(contextOf(req), req.params.id, req.body);
    return reply.status(204).send();
  });
  api.post<{ Body: StatementMatchRequest }>('/api/payments/statement-match', { schema: { body: statementMatchRequest } }, async (req) =>
    deps.payments.matchStatement(contextOf(req), req.body.lines),
  );

  api.get<{ Reply: GatewaySummary[] }>('/api/admin/payment-gateways', { schema: { response: { 200: gatewayListResponse } } }, async (req) =>
    deps.payments.gateways(contextOf(req)),
  );
  api.put<{ Body: RazorpayCredentialsRequest }>('/api/admin/payment-gateways/razorpay', { schema: { body: razorpayCredentialsRequest } }, async (req, reply) => {
    await deps.payments.saveGatewayCredentials(contextOf(req), 'razorpay', req.body);
    return reply.status(204).send();
  });
  api.put<{ Body: CashfreeCredentialsRequest }>('/api/admin/payment-gateways/cashfree', { schema: { body: cashfreeCredentialsRequest } }, async (req, reply) => {
    const { keyId, keySecret, webhookSecret = '', environment = 'sandbox' } = req.body;
    await deps.payments.saveGatewayCredentials(contextOf(req), 'cashfree', { keyId, keySecret, webhookSecret, environment });
    return reply.status(204).send();
  });
}
