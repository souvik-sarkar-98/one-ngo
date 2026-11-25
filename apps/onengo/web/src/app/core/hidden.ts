import type { RuntimeDefinitions, RuntimeRecordType, RuntimeWorkflow } from './models';

/**
 * Record types the app may offer: menus, choosers and "New" buttons. The server still sends hidden
 * types, because their records open from links and references, so lookups by key use the full list.
 */
export function shownRecordTypes(defs: Pick<RuntimeDefinitions, 'recordTypes'> | null | undefined): RuntimeRecordType[] {
  return (defs?.recordTypes ?? []).filter((t) => !t.hidden);
}

export function isTypeHidden(defs: Pick<RuntimeDefinitions, 'recordTypes'> | null | undefined, key: string): boolean {
  return !!defs?.recordTypes.find((t) => t.key === key)?.hidden;
}

/** Workflows whose steps may be offered. A hidden workflow still names the states of its records. */
export function offeredWorkflows<W extends Pick<RuntimeWorkflow, 'hidden'>>(workflows: readonly W[]): W[] {
  return workflows.filter((w) => !w.hidden);
}
