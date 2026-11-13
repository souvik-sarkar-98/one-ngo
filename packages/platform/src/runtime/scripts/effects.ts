import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import type { FieldIssue } from '@onengo/kernel/errors';
import type {
  ConnectorCallProposal,
  EffectCheck,
  EffectPolicy,
  EffectType,
  LedgerProposal,
  NotifyProposal,
  RecordCreateProposal,
  RecordUpdateProposal,
  ScriptEffect,
  ScriptHook,
} from './types.js';

export { MAX_EFFECTS_PER_SAVE } from './types.js';
export type {
  ConnectorCallProposal,
  EffectCheck,
  EffectPolicy,
  EffectType,
  LedgerLineProposal,
  LedgerProposal,
  NotifyProposal,
  RecordCreateProposal,
  RecordUpdateProposal,
  ScriptEffect,
  ScriptHook,
} from './types.js';

export const EFFECT_TYPES = ['ledger.propose', 'records.create', 'records.update', 'notify', 'connector.call'] as const satisfies readonly EffectType[];

/** Hard ceilings; a script definition may declare lower ones but never higher. */
export const MAX_EFFECTS_PER_RUN = 20;

/** What each hook may hand back: changed record values, proposed effects, or neither. */
export const HOOK_OUTPUT: Record<ScriptHook, { record: boolean; effects: boolean }> = {
  beforeSave: { record: true, effects: true },
  validate: { record: false, effects: false },
  afterSave: { record: false, effects: true },
  workflowGuard: { record: false, effects: false },
  customButton: { record: true, effects: true },
  reportShape: { record: true, effects: false },
};

/** Whole paise from a rupee amount, or null when it is not a non-negative amount with at most two decimals. */
function paise(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const p = Math.round(n * 100);
  if (Math.abs(p - n * 100) > 1e-6 || !Number.isSafeInteger(p)) return null;
  return p;
}

const decimal = (p: number) => `${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`;

function isCalendarDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Checks a script's output against the effect schema and the core-rule
 * pre-checks that need no database: the hook allows it, the definition
 * declares it, each journal balances, amounts stay under the declared ceiling.
 * The owning engines repeat their own checks when the effect is applied.
 */
export class ScriptEffectsValidator {
  private readonly schema: ValidateFunction;

  constructor(schemaDir: string) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    this.schema = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'scriptEffects.schema.json'), 'utf8')));
  }

  check(output: unknown, policy: EffectPolicy): EffectCheck {
    const empty = { effects: [], totalPaise: 0 };
    if (!this.schema(output)) {
      return { ...empty, issues: (this.schema.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'is invalid' })) };
    }
    const out = output as { record?: Record<string, unknown>; effects: Record<string, unknown>[] };
    const issues: FieldIssue[] = [];
    const allowed = HOOK_OUTPUT[policy.hook];
    if (out.record !== undefined && !allowed.record) issues.push({ path: '/record', message: `the ${policy.hook} hook cannot change the record` });
    if (out.effects.length && !allowed.effects) {
      issues.push({ path: '/effects', message: `the ${policy.hook} hook cannot propose effects` });
      return { ...empty, issues };
    }
    const max = Math.min(policy.maxEffects ?? MAX_EFFECTS_PER_RUN, MAX_EFFECTS_PER_RUN);
    if (out.effects.length > max) issues.push({ path: '/effects', message: `at most ${max} effects per run` });

    const effects: ScriptEffect[] = [];
    let totalPaise = 0;
    out.effects.forEach((e, i) => {
      const at = `/effects/${i}`;
      const type = e.type as EffectType;
      if (!policy.allow.includes(type)) {
        issues.push({ path: `${at}/type`, message: `the script does not declare '${type}' effects` });
        return;
      }
      switch (type) {
        case 'ledger.propose': {
          const entry = this.journal(e as unknown as LedgerProposal, at, policy.accounts ?? [], issues);
          if (entry) {
            totalPaise += entry.debitPaise;
            effects.push(entry.proposal);
          }
          return;
        }
        case 'connector.call': {
          const c = e as unknown as ConnectorCallProposal;
          if (!policy.connectors?.includes(c.connector)) {
            issues.push({ path: `${at}/connector`, message: `the script does not declare connector '${c.connector}'` });
            return;
          }
          effects.push(c);
          return;
        }
        case 'notify': {
          const n = e as unknown as NotifyProposal;
          const { roles, users, creator, field, named } = n.to;
          if (!roles?.length && !users?.length && !creator && !field && !named?.length) {
            issues.push({ path: `${at}/to`, message: 'choose at least one recipient' });
            return;
          }
          const undeclared = (named ?? []).filter((r) => !policy.recipients?.includes(r));
          if (undeclared.length) {
            issues.push({ path: `${at}/to/named`, message: `the script does not declare recipient '${undeclared[0]}'` });
            return;
          }
          effects.push(n);
          return;
        }
        case 'records.create': {
          const c = e as unknown as RecordCreateProposal;
          if (policy.savedRecordType && c.recordType === policy.savedRecordType) {
            issues.push({ path: `${at}/recordType`, message: `a script cannot create a '${c.recordType}' from that record type's own save` });
            return;
          }
          effects.push(c);
          return;
        }
        case 'records.update': {
          const u = e as unknown as RecordUpdateProposal;
          if (policy.savedRecordId && u.id.toLowerCase() === policy.savedRecordId.toLowerCase()) {
            issues.push({ path: `${at}/id`, message: 'a script cannot update the record being saved; change ctx.record instead' });
            return;
          }
          effects.push(u);
        }
      }
    });

    if (effects.some((e) => e.type === 'ledger.propose')) {
      const ceiling = policy.maxTotalAmount === undefined ? null : paise(policy.maxTotalAmount);
      if (ceiling === null) {
        issues.push({ path: '/effects', message: 'the script must declare a maximum total amount to propose journal entries' });
      } else if (totalPaise > ceiling) {
        issues.push({ path: '/effects', message: `proposed journals total ${decimal(totalPaise)}, above the script's limit of ${decimal(ceiling)}` });
      }
    }
    return { ...(out.record !== undefined ? { record: out.record } : {}), effects: issues.length ? [] : effects, totalPaise, issues };
  }

  private journal(e: LedgerProposal, at: string, accounts: readonly string[], issues: FieldIssue[]): { proposal: LedgerProposal; debitPaise: number } | null {
    const before = issues.length;
    if (!isCalendarDate(e.date)) issues.push({ path: `${at}/date`, message: 'is not a real date' });
    let debit = 0;
    let credit = 0;
    const lines = e.lines.map((l, j) => {
      if (!accounts.includes(l.account)) {
        issues.push({ path: `${at}/lines/${j}/account`, message: `the script does not declare account '${l.account}'` });
      }
      const side = l.debit !== undefined ? 'debit' : 'credit';
      const p = paise(l[side]);
      if (p === null || p === 0) {
        issues.push({ path: `${at}/lines/${j}/${side}`, message: 'must be a positive amount with at most two decimals' });
        return l;
      }
      if (side === 'debit') debit += p;
      else credit += p;
      return { ...l, [side]: decimal(p) };
    });
    if (issues.length === before && debit !== credit) {
      issues.push({ path: `${at}/lines`, message: `journal does not balance: debits ${decimal(debit)}, credits ${decimal(credit)}` });
    }
    return issues.length === before ? { proposal: { ...e, lines }, debitPaise: debit } : null;
  }
}
