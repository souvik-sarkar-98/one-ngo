import type { FieldIssue } from '@onengo/kernel/errors';

export type EffectType = 'ledger.propose' | 'records.create' | 'records.update' | 'notify' | 'connector.call';

/** A save may apply at most this many effects across all its scripts. */
export const MAX_EFFECTS_PER_SAVE = 50;

export type ScriptHook = 'beforeSave' | 'validate' | 'afterSave' | 'workflowGuard' | 'customButton' | 'reportShape';

export interface LedgerLineProposal {
  account: string;
  /** Normalised to a two-decimal string, for example "1500.00". */
  debit?: string;
  credit?: string;
  fund?: string | null;
}

export interface LedgerProposal {
  type: 'ledger.propose';
  date: string;
  memo?: string;
  lines: LedgerLineProposal[];
}

export interface RecordCreateProposal {
  type: 'records.create';
  recordType: string;
  data: Record<string, unknown>;
}

export interface RecordUpdateProposal {
  type: 'records.update';
  recordType: string;
  id: string;
  expectedVersion: number;
  data: Record<string, unknown>;
}

export interface NotifyProposal {
  type: 'notify';
  template: string;
  to: { roles?: string[]; users?: string[]; creator?: boolean; field?: string; named?: string[] };
  channels?: ('inApp' | 'email' | 'sms' | 'whatsapp')[];
  values?: Record<string, string | number | boolean | null>;
}

export interface ConnectorCallProposal {
  type: 'connector.call';
  connector: string;
  body: Record<string, unknown>;
}

export type ScriptEffect = LedgerProposal | RecordCreateProposal | RecordUpdateProposal | NotifyProposal | ConnectorCallProposal;

/** What the script definition declares about its effects, plus the hook it runs on. */
export interface EffectPolicy {
  hook: ScriptHook;
  /** Effect types the definition declares; anything else is refused. */
  allow: readonly EffectType[];
  /** Connectors the definition declares; a call to any other is refused. */
  connectors?: readonly string[];
  /** Ledger accounts the definition declares; required to propose journals, and a line on any other is refused. */
  accounts?: readonly string[];
  /** Named fixed recipients the definition declares; a notification to any other is refused. */
  recipients?: readonly string[];
  maxEffects?: number;
  /** Ceiling on the sum of debits across every proposed journal of one run; required to propose journals. */
  maxTotalAmount?: string | number;
  /** The record being saved; a script may not propose an update of it. */
  savedRecordId?: string | null;
  /** The record type being saved; a script may not create a record of it from that record's own save. */
  savedRecordType?: string;
}

export interface EffectCheck {
  record?: Record<string, unknown>;
  effects: ScriptEffect[];
  /** Sum of debits across the proposed journals, in paise. */
  totalPaise: number;
  issues: FieldIssue[];
}
