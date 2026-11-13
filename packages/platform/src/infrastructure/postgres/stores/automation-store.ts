import { sql } from 'kysely';
import type {
  AutomationRecordRow,
  AutomationState,
  AutomationStateChange,
  AutomationStore,
} from '../../../runtime/automation/ports/automation-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;

const selectRecords = (tx: Tx) =>
  pg(tx)
    .selectFrom('record')
    .select(['id', 'type_key', 'number', 'status', 'version', 'data', 'created_by'])
    .where('tenant_id', '=', APP_TENANT)
    .where('deleted_at', 'is', null);

export class PgAutomationStore implements AutomationStore {
  state(tx: Tx, automationKey: string): Promise<AutomationState | undefined> {
    return pg(tx)
      .selectFrom('automation_state')
      .select(['last_run_at', 'pending_due_at', 'cursor_created_at', 'cursor_id'])
      .where('tenant_id', '=', APP_TENANT)
      .where('automation_key', '=', automationKey)
      .executeTakeFirst();
  }

  async saveState(tx: Tx, automationKey: string, s: AutomationStateChange): Promise<void> {
    await pg(tx)
      .insertInto('automation_state')
      .values({
        tenant_id: APP_TENANT,
        automation_key: automationKey,
        last_run_at: s.lastRunAt?.toISOString() ?? null,
        pending_due_at: s.pendingDueAt?.toISOString() ?? null,
        cursor_created_at: s.cursor?.at ?? null,
        cursor_id: s.cursor?.id ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'automation_key']).doUpdateSet((eb) => ({
          last_run_at: s.lastRunAt !== undefined ? eb.ref('excluded.last_run_at') : eb.ref('automation_state.last_run_at'),
          pending_due_at: s.pendingDueAt !== undefined ? eb.ref('excluded.pending_due_at') : eb.ref('automation_state.pending_due_at'),
          cursor_created_at: s.cursor !== undefined ? eb.ref('excluded.cursor_created_at') : eb.ref('automation_state.cursor_created_at'),
          cursor_id: s.cursor !== undefined ? eb.ref('excluded.cursor_id') : eb.ref('automation_state.cursor_id'),
        })),
      )
      .execute();
  }

  record(tx: Tx, id: string): Promise<AutomationRecordRow | undefined> {
    return selectRecords(tx).where('id', '=', id).$castTo<AutomationRecordRow>().executeTakeFirst();
  }

  recordsAfter(tx: Tx, typeKey: string, status: string | null | undefined, after: { at: string; id: string } | null, limit: number) {
    return selectRecords(tx)
      .select('created_at')
      .where('type_key', '=', typeKey)
      .$if(status !== undefined && status !== null, (qb) => qb.where('status', '=', status!))
      .$if(after !== null, (qb) => qb.where(sql<boolean>`(created_at, id) > (${after!.at}::timestamptz, ${after!.id}::uuid)`))
      .orderBy('created_at')
      .orderBy('id')
      .limit(limit)
      .$castTo<AutomationRecordRow & { created_at: Date }>()
      .execute();
  }

  async claimRun(tx: Tx, eventId: string, automationKey: string, actionIndex: number): Promise<boolean> {
    const claimed = await pg(tx)
      .insertInto('automation_run')
      .values({ tenant_id: APP_TENANT, event_id: eventId, automation_key: automationKey, action_index: actionIndex })
      .onConflict((oc) => oc.doNothing())
      .returning('action_index')
      .executeTakeFirst();
    return !!claimed;
  }
}
