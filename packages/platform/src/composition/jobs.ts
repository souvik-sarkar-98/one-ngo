import { can } from '../domain/permissions.js';
import { JobRunner } from '../infrastructure/jobs/jobs.js';
import { OutboxDispatcher } from '../infrastructure/outbox/outbox-dispatcher.js';
import { PostgresJobStore } from '../infrastructure/postgres/stores/job-store.js';
import { PostgresOutboxStore } from '../infrastructure/postgres/stores/outbox-store.js';
import { IndexManager } from '../runtime/definitions/index-manager.js';
import { registerRebuildJobs } from '../runtime/records/rebuild-jobs.js';
import type { Definitions } from './definitions.js';
import type { Identity } from './identity.js';
import type { Base } from './infrastructure.js';
import type { Messaging } from './messaging.js';
import type { Records } from './records.js';
import { atPortBoundary } from './infrastructure-errors.js';

/** Background work: the outbox dispatcher, the job runner with the rebuild jobs, and the managed indexes. */
export function wireJobs(base: Base, { definitions }: Definitions, { records }: Records, { notifications }: Messaging, { currentActor }: Pick<Identity, 'currentActor'>) {
  const { db, owner, logger, options } = base;
  const dispatcher = new OutboxDispatcher(new PostgresOutboxStore(db), logger);
  const jobs = atPortBoundary(
    new JobRunner(new PostgresJobStore(db), {
      logger,
      autoRun: options.autoRunJobs,
      permits: can,
      currentActor,
      notify: async (tenantId, userId, n) => {
        await notifications.notifyText(tenantId, { to: { users: [userId] }, subject: n.subject, body: n.body, recordId: n.recordId, link: n.link });
      },
    }),
  );
  registerRebuildJobs(jobs, records);
  const indexes = new IndexManager(owner.indexes, owner.tenants, definitions, logger);
  jobs.register<Record<string, never>, { done?: number; failed?: string[] }>('index.build', {
    label: 'Index build',
    batchSize: 1,
    notice: () => null,
    async run({ ctx, state, batchSize }) {
      const r = await indexes.buildPending(ctx.tenantId, batchSize, new Set(state.failed ?? []));
      const done = (state.done ?? 0) + r.built.length + r.failed.length;
      return { state: { done, failed: [...(state.failed ?? []), ...r.failed] }, progress: done, done: r.remaining === 0 };
    },
  });
  return { dispatcher, jobs, indexes };
}
export type Jobs = ReturnType<typeof wireJobs>;
