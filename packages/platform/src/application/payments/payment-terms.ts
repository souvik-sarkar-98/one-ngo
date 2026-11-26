import { PAYMENT_PROVIDERS, type OnPaid, type PayableRecord, type PaymentAsk, type PaymentTerms } from '../../domain/payments/payment-service.js';
import { evalTest, evalValue } from '../../runtime/records/save/scope.js';
import { actionPermission } from '../../runtime/definitions/action-permissions.js';
import type { DefinitionReader } from '../../runtime/definitions/ports/definition-reader.js';
import type { ActionStep } from '../../runtime/definitions/types.js';

type PaymentStep = Extract<ActionStep, { type: 'createPayment' }>;

// `fields.account` is left out on purpose: it only says where the account goes, so a request made before a module added it
// is still matched by the updated action, and a payment already waiting is not stranded by the update.
const sameOnPaid = (a: OnPaid, b: OnPaid): boolean => {
  const shape = (o: OnPaid) => {
    const f = o.fields ?? {};
    return JSON.stringify([o.transition, f.paidOn ?? null, f.reference ?? null, f.method ?? null, o.methodValue ?? null]);
  };
  return shape(a) === shape(b);
};

const asks = (step: PaymentStep, ask: PaymentAsk): boolean =>
  PAYMENT_PROVIDERS[step.provider] === ask.provider &&
  sameOnPaid(step.onPaid, ask.onPaid) &&
  // A step that lets the person choose the account accepts any account; the payment service checks that it is a real one with a UPI ID.
  (ask.provider !== 'upi_direct' || ask.upiAccountKey === null || !!step.accountFrom || step.account === ask.upiAccountKey);

/** Payment terms from the organisation's published actions, workflows and receipt rules. */
export class PublishedPaymentTerms implements PaymentTerms {
  constructor(private readonly defs: DefinitionReader) {}

  async actionPermissions(tenantId: string, recordType: string, ask: PaymentAsk): Promise<string[]> {
    const actions = (await this.defs.list(tenantId, 'action')).map((a) => a.body).filter((a) => a.recordType === recordType);
    return actions.filter((a) => a.steps.some((s) => s.type === 'createPayment' && asks(s, ask))).map(actionPermission);
  }

  async actionAmounts(tenantId: string, record: PayableRecord, ask: PaymentAsk, user: { id: string; roles: string[] }): Promise<unknown[]> {
    const steps = (await this.defs.list(tenantId, 'action'))
      .map((a) => a.body)
      .filter((a) => a.recordType === record.type)
      .flatMap((a) => a.steps.filter((s): s is PaymentStep => s.type === 'createPayment' && asks(s, ask)));
    const scope = {
      record: { ...record.data, id: record.id, number: record.number },
      previous: {},
      status: record.status,
      previousStatus: null,
      workflow: record.workflow,
      states: { ...record.states, ...(record.workflow ? { [record.workflow]: record.status } : {}) },
      user,
    };
    return steps.map((s) => {
      if (/\binput\b/.test(s.amount)) return null;
      try {
        return evalValue(s.amount, scope, 'payment amount');
      } catch {
        return null;
      }
    });
  }

  async receiptAmounts(tenantId: string, record: PayableRecord, onPaid: OnPaid, facts: Record<string, unknown>): Promise<unknown[]> {
    const workflows = (await this.defs.workflowsFor(tenantId, record.type)).map((w) => w.body);
    const wf = workflows.find((w) => w.transitions.some((t) => t.key === onPaid.transition));
    const t = wf?.transitions.find((x) => x.key === onPaid.transition);
    if (!wf || !t) return [];
    const parallel = wf.role === 'parallel';
    const status = parallel ? record.status : t.to;
    const states = parallel ? { ...record.states, [wf.key]: t.to } : record.states;
    const data = { ...record.data, ...facts };
    const scope = {
      record: { ...data, id: record.id, number: record.number },
      previous: {},
      status,
      previousStatus: record.status,
      workflow: record.workflow,
      states: { ...states, ...(record.workflow ? { [record.workflow]: status } : {}) },
      user: { id: 'system:payments', roles: ['system'] },
    };
    const rules = (await this.defs.list(tenantId, 'receiptRule')).map((r) => r.body).filter((r) => r.recordType === record.type);
    const fires = (r: (typeof rules)[number]) =>
      r.whenStatus === t.to && (parallel ? r.workflow === wf.key : !r.workflow || r.workflow === record.workflow || r.workflow === wf.key);
    return rules
      .filter((r) => fires(r) && (!r.condition || evalTest(r.condition, scope, `receipt rule ${r.key}`)))
      .map((r) => evalValue(r.amount, scope, `receipt rule ${r.key} amount`));
  }
}
