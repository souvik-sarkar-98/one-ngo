import { join } from 'node:path';
import { systemActor } from '../domain/system-actor.js';
import { checkMemory } from '@onengo/kernel/observability';
import type { JobView } from '../runtime/records/ports/job-runner.js';
import type { DispatchResult } from '../infrastructure/outbox/outbox-dispatcher.js';
import { applyRetention, type RetentionResult } from '../infrastructure/postgres/retention.js';
import { exportTenant, type ExportSummary } from '../infrastructure/postgres/tenant-export.js';
import { isStoredEncrypted } from '../runtime/definitions/field-permissions.js';
import type { TickResult } from '../runtime/automation/automation-engine.js';
import { loadModulePackage, publishModulePackage, type ModulePackage } from '../runtime/definitions/package-loader.js';
import type { Definitions } from './definitions.js';
import type { Files } from './files.js';
import type { Base } from './infrastructure.js';
import type { Jobs } from './jobs.js';
import type { Operations } from './operations.js';
import type { Records } from './records.js';

/** What the scheduler wiring offers the entry points: the tick, tenant export, shipped-module publishing and the key-change re-encryption. */
export interface Scheduler {
  /** Scheduler entry point (App Engine cron): scheduled automations, queued work, background jobs, then cleanup. */
  tick(now?: Date): Promise<{ automations: TickResult; dispatch: DispatchResult; jobs: { jobs: number; batches: number }; retention: RetentionResult }>;
  /** Streams one NGO's data as JSON lines (portability and backups). */
  exportTenant(tenantId: string, writeLine: (line: string) => void | Promise<void>): Promise<ExportSummary>;
  /** Loads a shipped module from `modules/<key>` and publishes it to the base layer. */
  publishShippedModule(key: string): Promise<ModulePackage>;
  /**
   * Queues a fields.reencrypt job for every record type with sensitive fields
   * in every active organisation, which stores their values under the current
   * key: after the key changes, and once for values saved before they were
   * encrypted. Returns the jobs queued; their progress is on each job.
   */
  reencryptSensitiveFields(): Promise<(JobView & { tenantId: string })[]>;
}

/** The scheduler tick, tenant export, shipped-module publishing and the key-change re-encryption. */
export function wireScheduler(
  base: Base,
  { definitions }: Definitions,
  { records }: Records,
  { files }: Files,
  { dispatcher, jobs, indexes }: Jobs,
  { automations }: Operations,
): Scheduler {
  const { db, owner, logger, options, schemas, paths } = base;
  let indexesMaintainedAt = 0;
  return {
    async tick(now = new Date()) {
      const automationResult = await automations.tick(now, { timeBudgetMs: options.tickBudgetMs });
      const dispatch = await dispatcher.runOnce();
      try {
        for (const tenantId of await files.tenantsWithStaleUploads()) {
          await jobs.createUnlessQueued({ tenantId, actor: systemActor('files') }, 'files.cleanup', {});
        }
      } catch (error) {
        logger.log('ERROR', 'Scheduling file clean-up failed', {}, error);
      }
      const jobRun = await jobs.runOnce();
      if (Date.now() - indexesMaintainedAt > 6 * 3_600_000) {
        indexesMaintainedAt = Date.now();
        await indexes.maintain().catch((error) => logger.log('ERROR', 'Managed index maintenance failed', {}, error));
      }
      const retention = await applyRetention(db, options.retention);
      if (automationResult.incomplete) {
        logger.log('NOTICE', 'Scheduled automations did not finish within the tick budget; resuming next tick', {
          tenants: automationResult.tenants,
          records: automationResult.recordsProcessed,
        });
      }
      checkMemory(logger, options.memoryAlertMb);
      return { automations: automationResult, dispatch, jobs: jobRun, retention };
    },
    exportTenant: (tenantId, writeLine) => exportTenant(db, tenantId, writeLine),
    async publishShippedModule(key: string) {
      const pkg = await loadModulePackage(join(paths.modules, key), schemas);
      await publishModulePackage(definitions, pkg);
      return pkg;
    },
    async reencryptSensitiveFields() {
      const queued: (JobView & { tenantId: string })[] = [];
      for (const tenantId of await owner.tenants.activeIds()) {
        const ctx = { tenantId, actor: systemActor('fields') };
        for (const type of await definitions.list(tenantId, 'recordType')) {
          if (!type.body.fields.some(isStoredEncrypted) || !(await records.countOfType(tenantId, type.key))) continue;
          const job = await jobs.createUnlessQueued(ctx, 'fields.reencrypt', { recordType: type.key });
          if (job) queued.push({ ...job, tenantId });
        }
      }
      return queued;
    },
  };
}
