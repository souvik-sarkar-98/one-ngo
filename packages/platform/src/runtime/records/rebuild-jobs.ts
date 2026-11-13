import type { JobRunner } from './ports/job-runner.js';
import type { DefinitionVersionReader } from '../definitions/ports/definition-reader.js';
import { isReadProtected, isStoredEncrypted } from '../definitions/field-permissions.js';
import type { RecordTypeDef } from '../definitions/types.js';
import type { RecordService } from './record-service.js';

export type RebuildKind = 'rollup.rebuild' | 'search.rebuild' | 'fields.reencrypt';

interface RebuildState {
  after?: string | null;
  done?: number;
}

/** Background rebuilds of stored values after a record type changes; they notify nobody. */
export function registerRebuildJobs(jobs: JobRunner, records: RecordService): void {
  const kinds: [Exclude<RebuildKind, 'fields.reencrypt'>, string, (tenantId: string, type: string, after: string | null, limit: number) => Promise<{ lastId: string | null; count: number }>][] = [
    ['rollup.rebuild', 'Totals rebuild', (t, k, a, l) => records.rebuildRollups(t, k, a, l)],
    ['search.rebuild', 'Search rebuild', (t, k, a, l) => records.rebuildSearch(t, k, a, l)],
  ];
  for (const [kind, label, rebuild] of kinds) {
    jobs.register<{ recordType: string }, RebuildState>(kind, {
      label,
      notice: () => null,
      async run({ ctx, input, state, batchSize }) {
        const page = await rebuild(ctx.tenantId, input.recordType, state.after ?? null, batchSize);
        const progress = (state.done ?? 0) + page.count;
        return { state: { after: page.lastId ?? state.after ?? null, done: progress }, progress, done: page.count < batchSize };
      },
    });
  }
  jobs.register<{ recordType: string }, RebuildState & { rewritten?: number }>('fields.reencrypt', {
    label: 'Sensitive values re-encryption',
    notice: () => null,
    async run({ ctx, input, state, batchSize }) {
      const page = await records.reencrypt(ctx.tenantId, input.recordType, state.after ?? null, batchSize);
      const progress = (state.done ?? 0) + page.count;
      const rewritten = (state.rewritten ?? 0) + page.rewritten;
      return {
        state: { after: page.lastId ?? state.after ?? null, done: progress, rewritten },
        progress,
        done: page.count < batchSize,
        result: { checked: progress, rewritten },
      };
    },
  });
}

/** The fields whose values make up a record's search text. */
const searchSignature = (t: RecordTypeDef) =>
  t.fields
    .filter((f) => !isReadProtected(t, f) && f.type !== 'longText' && (f.searchable || f.required || f.key === t.titleField))
    .map((f) => `${f.key}:${f.type}`)
    .sort()
    .join(',');

/** The fields whose values are stored encrypted, and which of them keep a keyed hash. */
const encryptionSignature = (t: RecordTypeDef) =>
  t.fields
    .filter(isStoredEncrypted)
    .map((f) => `${f.key}${f.unique ? ':unique' : ''}`)
    .sort()
    .join(',');

/**
 * Rebuilds needed after a record type is published: its own rollups and
 * those of record types that total it, its search text when the searchable
 * fields changed, and its stored values when the encrypted fields changed.
 * Record types without records need none.
 */
export async function rebuildsAfterPublish(
  defs: DefinitionVersionReader,
  records: RecordService,
  tenantId: string,
  key: string,
  version: number,
): Promise<{ kind: RebuildKind; recordType: string }[]> {
  const current = (await defs.get(tenantId, 'recordType', key))?.body;
  if (!current) return [];
  const out: { kind: RebuildKind; recordType: string }[] = [];
  const parents = (await defs.list(tenantId, 'recordType')).filter((t) => t.body.fields.some((f) => f.rollup?.recordType === key)).map((t) => t.key);
  for (const t of new Set([...(current.fields.some((f) => f.rollup) ? [key] : []), ...parents])) out.push({ kind: 'rollup.rebuild', recordType: t });
  const previous = version > 1 ? (await defs.getVersion(tenantId, 'recordType', key, version - 1))?.body : undefined;
  if (!previous || searchSignature(previous) !== searchSignature(current)) out.push({ kind: 'search.rebuild', recordType: key });
  if (previous && encryptionSignature(previous) !== encryptionSignature(current)) out.push({ kind: 'fields.reencrypt', recordType: key });
  const counts = new Map<string, number>();
  for (const job of out) if (!counts.has(job.recordType)) counts.set(job.recordType, await records.countOfType(tenantId, job.recordType));
  return out.filter((j) => counts.get(j.recordType)! > 0);
}
