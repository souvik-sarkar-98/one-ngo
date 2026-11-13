import { conflict } from '@onengo/kernel/errors';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { systemActor } from '../../domain/system-actor.js';
import type { OutboxEvent } from '../automation/ports/automation-collaborators.js';
import { MAX_AUTOMATION_DEPTH } from '../automation/limits.js';
import type { DefinitionReader } from '../definitions/ports/definition-reader.js';
import { auditSnapshots } from './audit-snapshot.js';
import type { RecordTypeDef } from '../definitions/types.js';
import { same } from './person-fields.js';
import type { RecordStore } from './ports/record-store.js';
import { searchText } from './query.js';
import type { SensitiveFields } from './sensitive.js';

const ACTOR = systemActor('follow').id;

/**
 * Writes a changed source value onto fields that follow it. The write is the
 * stored data, version, search text and audit: scripts and validation do not
 * run. A further `record.updated` carries a higher depth so a followed field
 * that is itself a source keeps propagating, and so automations see the value.
 */
export class FieldFollow {
  constructor(
    private readonly tm: TransactionManager,
    private readonly store: RecordStore,
    private readonly defs: DefinitionReader,
    private readonly sensitive: SensitiveFields,
  ) {}

  async onRecord(event: OutboxEvent): Promise<void> {
    const depth = depthOf(event);
    if (depth === undefined || depth >= MAX_AUTOMATION_DEPTH) return;
    const id = text(event.payload.id);
    const typeKey = text(event.payload.type);
    if (!id || !typeKey) return;
    const types = await this.types(event.tenantId);
    const sourceType = types.find((t) => t.key === typeKey);
    if (!sourceType) return;
    await this.tm.withTenant(event.tenantId, async (tx) => {
      const row = await this.store.get(tx, id);
      if (!row || row.type_key !== typeKey) return;
      const plain = this.sensitive.open(sourceType, row.data);
      for (const type of types) {
        for (const field of type.fields) {
          const follow = field.follow;
          if (!follow) continue;
          const via = type.fields.find((f) => f.key === follow.via);
          if (!via || via.type !== 'reference' || via.referenceType !== sourceType.key) continue;
          if (!sourceType.fields.some((f) => f.key === follow.field)) continue;
          await this.write(tx, type, field.key, via.key, id, plain[follow.field], depth);
        }
      }
    });
  }

  async onUser(event: OutboxEvent): Promise<void> {
    const depth = depthOf(event);
    if (depth === undefined || depth >= MAX_AUTOMATION_DEPTH) return;
    const userId = text(event.payload.userId);
    if (!userId) return;
    const name = event.payload.name == null ? undefined : String(event.payload.name);
    const email = event.payload.email == null ? undefined : String(event.payload.email);
    const types = await this.types(event.tenantId);
    await this.tm.withTenant(event.tenantId, async (tx) => {
      for (const type of types) {
        for (const field of type.fields) {
          const follow = field.follow;
          if (!follow || (follow.field !== 'name' && follow.field !== 'email')) continue;
          const via = type.fields.find((f) => f.key === follow.via);
          if (!via || via.type !== 'person') continue;
          const value = follow.field === 'name' ? name : email;
          if (value === undefined) continue;
          await this.write(tx, type, field.key, via.key, userId, value, depth);
        }
      }
    });
  }

  private async types(tenantId: string): Promise<RecordTypeDef[]> {
    return (await this.defs.list(tenantId, 'recordType')).map((t) => t.body);
  }

  private async write(tx: Tx, type: RecordTypeDef, fieldKey: string, viaKey: string, sourceId: string, value: unknown, depth: number): Promise<void> {
    for (const row of await this.store.linked(tx, type.key, viaKey, sourceId)) {
      const plain = this.sensitive.open(type, row.data);
      if (same(plain[fieldKey], value)) continue;
      const next = { ...plain };
      if (value === undefined || value === null || value === '') delete next[fieldKey];
      else next[fieldKey] = value;
      const stored = this.sensitive.seal(type, next);
      const updated = await this.store.update(tx, row.id, row.version, {
        data: stored.data,
        index: stored.index,
        status: row.status,
        schemaVersion: row.schema_version,
        states: row.workflow_state,
        searchText: searchText(type, row.number, next),
        actorId: ACTOR,
      });
      if (!updated) throw conflict('A followed record changed while it was being updated.');
      await this.store.audit(tx, {
        actorId: ACTOR,
        action: 'record.updated',
        entity: `record:${type.key}`,
        entityId: row.id,
        ...auditSnapshots(type, { data: plain, status: row.status }, { data: next, status: row.status }),
      });
      await this.store.enqueueEvent(tx, 'record.updated', {
        id: row.id,
        type: type.key,
        status: row.status,
        previousStatus: row.status,
        workflow: row.workflow_key,
        states: row.workflow_state,
        previousStates: row.workflow_state,
        transition: null,
        actorId: ACTOR,
        depth: depth + 1,
        causedBy: null,
      });
    }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function depthOf(event: OutboxEvent): number | undefined {
  const depth = Number(event.payload.depth ?? 0);
  return Number.isFinite(depth) ? depth : undefined;
}