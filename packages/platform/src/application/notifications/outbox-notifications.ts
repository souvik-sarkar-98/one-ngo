import type { HandlerCompletion } from '../actions/ports/action-ports.js';
import { joinTx } from '../../domain/transaction-scope.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { NamedRecipient } from '../../runtime/definitions/settings.js';
import type { RecipientDef } from '../../runtime/definitions/types.js';
import type { NotifyProposal } from '../../runtime/scripts/types.js';
import type { NotificationService, NotifyInput } from './notification-service.js';
import type { OutboxEvent } from './ports/outbox-event.js';

/** Queued by a script's `notify` effect in the save; the saved record's protected fields are already masked. */
interface ScriptNotifyEvent {
  script: string;
  version: number;
  template: string;
  to: NotifyProposal['to'];
  channels?: NotifyProposal['channels'];
  values: Record<string, unknown>;
  recordId: string;
  recordType: string;
  creatorId: string | null;
  record: Record<string, unknown>;
  status: string | null;
  actorId: string;
}

/**
 * The notifications the outbox sends when an action, a script, a finance
 * script publication or an approval queues them. Each one is recorded as done
 * in its own transaction (`run.complete`), so a replayed event never repeats it.
 */
export class OutboxNotifications {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly notifications: Pick<NotificationService, 'within'>,
    private readonly definitions: Pick<DefinitionReader, 'get' | 'workflowFor'>,
    /** The organisation's named fixed recipients, as set in its settings. */
    private readonly namedRecipients: (tx: Tx) => Promise<Record<string, NamedRecipient> | undefined>,
  ) {}

  private once(tenantId: string, run: HandlerCompletion, send: (n: NotificationService) => Promise<unknown>): Promise<void> {
    return this.transactions.withTenant(tenantId, async (tx) => {
      await send(this.notifications.within(joinTx(tenantId, tx)));
      await run.complete(tx);
    });
  }

  actionNotify(e: OutboxEvent, run: HandlerCompletion): Promise<void> {
    return this.once(e.tenantId, run, (n) => n.notify(e.tenantId, e.payload as unknown as NotifyInput));
  }

  async scriptNotify(e: OutboxEvent, run: HandlerCompletion): Promise<void> {
    const p = e.payload as unknown as ScriptNotifyEvent;
    const type = await this.definitions.get(e.tenantId, 'recordType', p.recordType);
    const fieldType = p.to.field ? type?.body.fields.find((f) => f.key === p.to.field)?.type : undefined;
    const to: RecipientDef = {
      roles: p.to.roles,
      users: p.to.users,
      creator: p.to.creator,
      ...(fieldType === 'person' ? { type: 'personField' as const, field: p.to.field } : {}),
      ...(fieldType === 'email' ? { email: `record.${p.to.field}` } : {}),
      ...(fieldType === 'phone' ? { phone: `record.${p.to.field}` } : {}),
    };
    const scope = { record: p.record, status: p.status, script: p.values, user: { id: p.actorId } };
    const base = { template: p.template, channels: p.channels, recordId: p.recordId, creatorId: p.creatorId, recordType: p.recordType };
    await this.transactions.withTenant(e.tenantId, async (tx) => {
      const n = this.notifications.within(joinTx(e.tenantId, tx));
      if (to.roles?.length || to.users?.length || to.creator || to.field || to.email || to.phone) await n.notify(e.tenantId, { ...base, to, scope });
      if (p.to.named?.length) {
        const named = (await this.namedRecipients(tx)) ?? {};
        for (const name of p.to.named) {
          const r = named[name];
          if (!r) continue;
          await n.notify(e.tenantId, {
            ...base,
            to: { ...(r.email ? { email: 'named.email' } : {}), ...(r.phone ? { phone: 'named.phone' } : {}) },
            scope: { ...scope, named: { email: r.email ?? null, phone: r.phone ?? null } },
          });
        }
      }
      await run.complete(tx);
    });
  }

  async financeScriptPublished(e: OutboxEvent, run: HandlerCompletion): Promise<void> {
    const p = e.payload as { key: string; label: string; recordType: string; action: string; version: number; previousVersion: number | null; author: string; roles: string[] };
    const what = p.action === 'rolled_back' ? 'rolled back' : 'published';
    await this.once(e.tenantId, run, (n) =>
      n.notifyText(e.tenantId, {
        to: { roles: p.roles },
        subject: `Finance script ${what}: ${p.label}`,
        body: `The script "${p.label}" for ${p.recordType} was ${what} as version ${p.version}${p.previousVersion ? ` (replacing version ${p.previousVersion})` : ''}. It can post to the books or runs on money records; review it in the change history.`,
      }),
    );
  }

  async approvalRequested(e: OutboxEvent, run: HandlerCompletion): Promise<void> {
    const p = e.payload as { requestId: string; id: string; type: string; transition: string; requestedBy: string };
    const wf = await this.definitions.workflowFor(e.tenantId, p.type);
    const t = wf?.body.transitions.find((x) => x.key === p.transition);
    if (!t?.approval) return;
    const approval = t.approval;
    await this.once(e.tenantId, run, (n) =>
      n.notifyText(e.tenantId, {
        to: { roles: approval.roles, users: approval.users },
        subject: `Approval needed: ${t.label}`,
        body: `A ${p.type} is waiting for your approval to "${t.label}".`,
        recordId: p.id,
        exclude: [p.requestedBy],
      }),
    );
  }

  async approvalDecided(e: OutboxEvent, run: HandlerCompletion): Promise<void> {
    const p = e.payload as { id: string; type: string; outcome: string; requestedBy: string };
    await this.once(e.tenantId, run, (n) =>
      n.notifyText(e.tenantId, {
        to: { users: [p.requestedBy] },
        subject: `Your request was ${p.outcome}`,
        body: `Your request on a ${p.type} was ${p.outcome}.`,
        recordId: p.id,
      }),
    );
  }
}
