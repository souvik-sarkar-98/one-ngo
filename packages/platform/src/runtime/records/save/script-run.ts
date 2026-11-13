import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import { PlatformError, ruleViolation, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import { maskFor } from '../../definitions/field-permissions.js';
import type { PublishedDefinition, ScriptDef } from '../../definitions/types.js';
import { ScriptFailure } from '../../../domain/script-failure.js';
import { MAX_EFFECTS_PER_SAVE, type EffectPolicy, type ScriptEffect, type ScriptHook } from '../../scripts/types.js';
import type { RecordRow } from '../query.js';
import { organisationToday } from '../../../shared/time/organisation-time.js';
import type { SaveContext, ScriptRun } from './context.js';

/** Nested saves started by script effects stop at the automation depth limit. */
export const MAX_NESTED_DEPTH = 5;

/** The runs to log for a script that failed or whose proposals were refused, once the save has rolled back. */
export const failedScripts = new WeakMap<object, ScriptRun[]>();

export const today = () => organisationToday();

export function policyOf(def: ScriptDef, hook: ScriptHook, saved: { id?: string | null; type?: string } = {}): EffectPolicy {
  const e = def.effects;
  return {
    hook,
    allow: e?.allow ?? [],
    accounts: e?.accounts,
    connectors: e?.connectors,
    recipients: e?.recipients,
    maxEffects: e?.maxEffects,
    maxTotalAmount: e?.maxTotalAmount,
    savedRecordId: saved.id ?? null,
    savedRecordType: saved.type,
  };
}

/** `Script 'x' effect 2: message` for an issue under /effects/1, else `Script 'x': message`. */
export function scriptIssueMessage(key: string, issue: FieldIssue): string {
  const m = /^\/effects\/(\d+)/.exec(issue.path);
  return m ? `Script '${key}' effect ${Number(m[1]) + 1}: ${issue.message}` : `Script '${key}': ${issue.message}`;
}

export function effectSummary(effects: ScriptEffect[]): ScriptRun['effects'] {
  if (!effects.length) return null;
  const count: Record<string, number> = {};
  let paise = 0;
  for (const e of effects) {
    count[e.type] = (count[e.type] ?? 0) + 1;
    if (e.type === 'ledger.propose') for (const l of e.lines) if (l.debit) paise += Math.round(Number(l.debit) * 100);
  }
  return { count, journalTotal: `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}` };
}

/**
 * Who reads a script's inputs and applies its effects: the person saving, or,
 * for a script that runs as a role, the person with that role's permissions
 * only, so audit entries still name the person.
 */
export async function scriptContext(tx: Tx, s: SaveContext, def: ScriptDef): Promise<TenantContext> {
  if (!def.runAs) return s.ctx;
  const permissions = await s.services.store.rolePermissions(tx, def.runAs);
  if (!permissions) throw ruleViolation(`Script '${def.key}' runs as role '${def.runAs}', which does not exist.`);
  return { ...s.ctx, actor: { id: s.ctx.actor.id, roles: [def.runAs], permissions } };
}

export interface ScriptOutcome {
  record?: Record<string, unknown>;
  effects: ScriptEffect[];
  logs: string[];
}

/**
 * Runs one script on a hook: loads its declared inputs, runs it in the
 * sandbox, and checks what it returns. The run is added to `s.scripts`; a run
 * that fails, or whose proposals are refused, is remembered for logging after
 * the rollback. Proposals are counted against the save's budget, not applied.
 */
export async function runScript(
  tx: Tx,
  s: SaveContext,
  def: PublishedDefinition<'script'>,
  hook: ScriptHook,
  opts: { record: Record<string, unknown>; extra?: Record<string, unknown>; savedRecordId?: string | null },
): Promise<ScriptOutcome> {
  const body = def.body;
  const run = (durationMs: number, outcome: ScriptRun['outcome'], message: string | null, effects: ScriptRun['effects'] = null): ScriptRun => ({
    key: def.key,
    version: def.version,
    hook,
    durationMs,
    outcome,
    message,
    effects,
  });
  let durationMs = 0;
  try {
    const reader = await scriptContext(tx, s, body);
    const inputs = body.inputs ? await s.services.scriptInputs(tx, reader, s.loaded, body, opts.record, today()) : undefined;
    const out = await s.services.sandbox.run({
      hook,
      code: body.code,
      record: opts.record,
      previous: s.previous,
      status: s.status,
      recordType: s.type.key,
      user: { id: s.ctx.actor.id, roles: s.ctx.actor.roles },
      inputs,
      extra: opts.extra,
      timeoutMs: body.timeoutMs,
      memoryMb: body.memoryMb,
      tenantId: s.ctx.tenantId,
    });
    durationMs = out.durationMs;
    const checked = s.services.sandbox.checkEffects(out.output, policyOf(body, hook, { id: opts.savedRecordId, type: s.type.key }));
    if (!checked.issues.length && s.budget.used + checked.effects.length > MAX_EFFECTS_PER_SAVE) {
      checked.issues.push({ path: '/effects', message: `a save may apply at most ${MAX_EFFECTS_PER_SAVE} effects across all its scripts` });
    }
    if (checked.issues.length) {
      const err = new PlatformError('rule_violation', scriptIssueMessage(def.key, checked.issues[0]!), checked.issues);
      if (!s.dryRun) failedScripts.set(err, [...s.scripts, run(durationMs, 'rejected', err.message)]);
      throw err;
    }
    s.budget.used += checked.effects.length;
    s.scripts.push(run(durationMs, 'ok', null, effectSummary(checked.effects)));
    return { record: checked.record, effects: checked.effects, logs: out.logs };
  } catch (e) {
    if (e instanceof ScriptFailure && !s.dryRun) {
      failedScripts.set(e, [...s.scripts, run(e.durationMs, e.code === 'script_limit' ? 'limit' : 'failed', e.message)]);
    }
    throw e;
  }
}

/** Holds a run's proposals to apply after the write. */
export function hold(s: SaveContext, def: PublishedDefinition<'script'>, effects: ScriptEffect[]): void {
  if (effects.length) s.held.push({ script: def, effects });
}

/** The after-save scripts: they see the saved id, number and status, and their proposals are held with the rest. */
export async function afterSaveScripts(tx: Tx, s: SaveContext, row: RecordRow): Promise<void> {
  const logged = s.scripts.length;
  for (const h of s.loaded.afterSave) {
    const out = await runScript(tx, s, h, 'afterSave', {
      record: { ...row.data },
      extra: { id: row.id, number: row.number },
      savedRecordId: row.id,
    });
    if (!s.dryRun) hold(s, h, out.effects);
  }
  if (!s.dryRun) for (const r of s.scripts.slice(logged)) await s.services.store.logScript(tx, r, row.id);
}

/**
 * Applies the held proposals in order, each through the engine that owns it,
 * in the save's transaction: journals through the ledger, records through
 * nested saves, notifications and connector calls as outbox events. Any
 * refusal rolls the whole save back.
 */
export async function applyEffects(tx: Tx, s: SaveContext, row: RecordRow): Promise<{ journalEntryIds: string[]; applied: Record<string, unknown>[] }> {
  if (s.dryRun || !s.held.length) return { journalEntryIds: [], applied: [] };
  const journalEntryIds: string[] = [];
  const applied: Record<string, unknown>[] = [];
  for (const { script, effects } of s.held) {
    const body = script.body;
    const ctx = await scriptContext(tx, s, body);
    const source = `script:${script.key}@${script.version}`;
    const depth = (s.ctx.depth ?? 0) + 1;
    const nestedCtx: TenantContext = { ...ctx, depth, causedBy: source };
    let journals = 0;
    for (const [i, e] of effects.entries()) {
      const base = { script: script.key, version: script.version, effect: i + 1, type: e.type };
      try {
        switch (e.type) {
          case 'ledger.propose': {
            journals++;
            const id = await s.services.ledger.post(tx, ctx.actor, {
              date: e.date,
              memo: e.memo,
              sourceRecordId: row.id,
              sourceRule: journals === 1 ? source : `${source}#${journals}`,
              lines: e.lines.map((l) => ({ accountCode: l.account, debit: l.debit, credit: l.credit, fund: l.fund ?? null })),
            });
            journalEntryIds.push(id);
            applied.push({ ...base, journalEntryId: id, total: effectSummary([e])!.journalTotal });
            break;
          }
          case 'records.create':
          case 'records.update': {
            if (depth > MAX_NESTED_DEPTH) throw ruleViolation(`records saved by scripts may nest at most ${MAX_NESTED_DEPTH} deep`);
            if (e.type === 'records.update' && e.id.toLowerCase() === row.id.toLowerCase()) {
              throw ruleViolation('a script cannot update the record being saved');
            }
            const saved =
              e.type === 'records.create'
                ? await s.services.nested.create(tx, nestedCtx, s.loaded, e.recordType, e.data)
                : await s.services.nested.update(tx, nestedCtx, s.loaded, e.id, { recordType: e.recordType, data: e.data, expectedVersion: e.expectedVersion });
            applied.push({ ...base, recordType: saved.type, recordId: saved.id, recordVersion: saved.version });
            break;
          }
          case 'notify':
            await s.services.store.enqueueEvent(tx, 'script.notify', {
              script: script.key,
              version: script.version,
              template: e.template,
              to: e.to,
              channels: e.channels,
              values: e.values ?? {},
              recordId: row.id,
              recordType: row.type_key,
              creatorId: row.created_by,
              record: { ...maskFor(null, s.type, row.data), id: row.id, number: row.number },
              status: row.status,
              actorId: s.ctx.actor.id,
            });
            applied.push({ ...base, template: e.template });
            break;
          case 'connector.call':
            if (s.loaded.connectors.get(e.connector)?.type === 'http') {
              await s.services.store.enqueueEvent(tx, 'connector.http', {
                connector: e.connector,
                event: `script.${script.key}`,
                recordId: row.id,
                binding: { record: { ...maskFor(null, s.type, row.data), id: row.id, number: row.number, ...e.body } },
              });
            } else {
              await s.services.store.enqueueEvent(tx, 'connector.webhook', {
                connector: e.connector,
                event: `script.${script.key}`,
                record: { id: row.id, type: row.type_key, number: row.number, status: row.status },
                body: e.body,
                actorId: s.ctx.actor.id,
                time: new Date().toISOString(),
              });
            }
            applied.push({ ...base, connector: e.connector });
            break;
        }
      } catch (err) {
        if (!(err instanceof PlatformError) || err instanceof ScriptFailure) throw err;
        const wrapped = new PlatformError(err.code, `Script '${script.key}' effect ${i + 1}: ${err.message}`, err.issues);
        const own = s.scripts.map((r) => (r.key === script.key && r.outcome === 'ok' ? { ...r, outcome: 'rejected' as const, message: wrapped.message } : r));
        failedScripts.set(wrapped, [...own, ...(failedScripts.get(err) ?? [])]);
        throw wrapped;
      }
    }
  }
  return { journalEntryIds, applied };
}

/** One `script.effects` audit entry per save that applied effects: each effect with its script and version, the person saving and any role scripts ran as. */
export async function auditScriptEffects(tx: Tx, s: SaveContext, row: RecordRow, applied: Record<string, unknown>[]): Promise<void> {
  if (!applied.length) return;
  await s.services.store.audit(tx, {
    actorId: s.ctx.actor.id,
    action: 'script.effects',
    entity: `record:${row.type_key}`,
    entityId: row.id,
    after: {
      savedBy: s.ctx.actor.id,
      runAs: Object.fromEntries(s.held.filter((h) => h.script.body.runAs).map((h) => [h.script.key, h.script.body.runAs])),
      effects: applied,
    },
  });
}
