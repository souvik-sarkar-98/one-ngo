import type { FieldIssue } from '@onengo/kernel/errors';
import type { ScriptDef } from './types.js';

export const MAX_RELATED_INPUTS = 5;
export const MAX_LOOKUP_INPUTS = 3;
export const MAX_LOOKUP_LIMIT = 20;
export const MAX_LOOKUP_ROWS = 50;
export const DEFAULT_LOOKUP_LIMIT = 5;
export const SETTING_INPUTS = ['organisationName', 'financialYearStartMonth', 'defaultCurrency', 'receiptSeries'] as const;

/** What each hook may hand back; mirrors `HOOK_OUTPUT` in src/scripts/effects.ts. */
export const HOOK_TAKES_EFFECTS: Record<ScriptDef['hook'], boolean> = {
  beforeSave: true,
  validate: false,
  afterSave: true,
  workflowGuard: false,
  customButton: true,
  reportShape: false,
};

/**
 * Publishing, or rolling back to, a script that runs as a role or reads
 * ledger balances needs this permission. The organisation administrator
 * role (`*`) holds it.
 */
export const SCRIPT_ADMIN_PERMISSION = 'config:script:admin';

/** The parts of a script that only an organisation administrator may publish, by name; empty when none. */
export function adminOnlyParts(def: ScriptDef): string[] {
  return [...(def.runAs ? ['runAs'] : []), ...(def.inputs?.balances ? ['balances'] : []), ...(def.hook === 'reportShape' ? ['reportShape'] : [])];
}

/**
 * A finance script declares journal effects, or runs for a record type that
 * posts to the ledger, issues receipts, or holds money fields.
 */
export function isFinanceScript(
  def: ScriptDef,
  recordType: { fields: { type: string }[] } | undefined,
  hasPostingOrReceiptRule: boolean,
): boolean {
  return !!def.effects?.allow.includes('ledger.propose') || hasPostingOrReceiptRule || !!recordType?.fields.some((f) => f.type === 'money');
}

/**
 * The limits on declared inputs that need no database: counts, the lookup row
 * budget, the settings allow-list, and names that do not collide.
 */
export function checkDeclaredInputs(inputs: ScriptDef['inputs']): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!inputs) return issues;
  const names = new Set<string>();
  const named = (name: string, path: string) => {
    if (names.has(name) || name === 'balances' || name === 'settings') issues.push({ path, message: `input name '${name}' is used twice or reserved` });
    names.add(name);
  };
  if ((inputs.related?.length ?? 0) > MAX_RELATED_INPUTS) issues.push({ path: '/inputs/related', message: `at most ${MAX_RELATED_INPUTS} related records` });
  inputs.related?.forEach((r, i) => named(r.name, `/inputs/related/${i}/name`));
  if ((inputs.lookups?.length ?? 0) > MAX_LOOKUP_INPUTS) issues.push({ path: '/inputs/lookups', message: `at most ${MAX_LOOKUP_INPUTS} lookups` });
  let rows = 0;
  inputs.lookups?.forEach((l, i) => {
    named(l.name, `/inputs/lookups/${i}/name`);
    const limit = l.limit ?? DEFAULT_LOOKUP_LIMIT;
    if (limit > MAX_LOOKUP_LIMIT) issues.push({ path: `/inputs/lookups/${i}/limit`, message: `at most ${MAX_LOOKUP_LIMIT}` });
    rows += limit;
  });
  if (rows > MAX_LOOKUP_ROWS) issues.push({ path: '/inputs/lookups', message: `lookups may load at most ${MAX_LOOKUP_ROWS} records in total` });
  inputs.settings?.forEach((s, i) => {
    if (!(SETTING_INPUTS as readonly string[]).includes(s)) issues.push({ path: `/inputs/settings/${i}`, message: `'${s}' is not a setting scripts may read` });
  });
  return issues;
}
