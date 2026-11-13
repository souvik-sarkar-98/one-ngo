import type { LedgerService } from '../../../domain/ledger/ledger-service.js';
import type { ReceiptService } from '../../../domain/receipts/receipt-service.js';
import type { PersonDirectory } from '../ports/person-directory.js';
import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { FieldDef, PostingRuleDef, PublishedDefinition, ReceiptRuleDef, RecordTypeDef, ScriptDef, WorkflowDef } from '../../definitions/types.js';
import type { ScriptEffect } from '../../scripts/types.js';
import type { RecordScripts } from '../ports/record-scripts.js';
import type { RecordRow, RecordStore, ScriptRun } from '../ports/record-store.js';
import type { SensitiveFields } from '../sensitive.js';
import type { ConnectorFact } from '../../definitions/ports/definition-store.js';

export type { ScriptRun };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Loaded {
  type: PublishedDefinition<'recordType'>;
  /** The default primary workflow. */
  workflow: PublishedDefinition<'workflow'> | undefined;
  /** Every workflow of the record type, default primary first. */
  workflows: PublishedDefinition<'workflow'>[];
  postingRules: PostingRuleDef[];
  receiptRules: ReceiptRuleDef[];
  /** Rollups on other record types that count records of this type. */
  rollupParents: { type: RecordTypeDef; field: FieldDef }[];
  /** Enabled before-save scripts of the record type, in run order. */
  beforeSave: PublishedDefinition<'script'>[];
  /** Enabled scripts of the record type on the other hooks, in run order. */
  validateScripts: PublishedDefinition<'script'>[];
  afterSave: PublishedDefinition<'script'>[];
  workflowGuard: PublishedDefinition<'script'>[];
  /** The record type's enabled custom-button script `key`. */
  buttonScript: (key: string) => PublishedDefinition<'script'> | undefined;
  /** Any published record type, for reading records of other types. */
  typeOf: (typeKey: string) => RecordTypeDef | undefined;
  /** Webhook and http connectors by key, read with the definitions; scripts' connector calls are queued by their type. */
  connectors: ReadonlyMap<string, ConnectorFact>;
  /** What a save of another record type loads, read with the same definitions; for nested saves. */
  loadedOf: (typeKey: string) => Loaded;
}

/** Where a save leaves the record's workflows. */
export interface Move {
  workflow: string | null;
  status: string | null;
  states: Record<string, string>;
}

export interface SaveServices {
  store: RecordStore;
  people: PersonDirectory;
  sandbox: RecordScripts;
  ledger: LedgerService;
  receipts: ReceiptService;
  sensitive: SensitiveFields;
  checkUniqueAndPatterns: (
    tx: Tx,
    type: RecordTypeDef,
    data: Record<string, unknown>,
    previous: Record<string, unknown> | null,
    recordId: string | null,
  ) => Promise<FieldIssue[]>;
  linkFiles: (tx: Tx, ctx: TenantContext, type: RecordTypeDef, recordId: string, data: Record<string, unknown>) => Promise<void>;
  /** Loads a script's declared inputs in the open transaction, read as `ctx`'s actor through the screens' read path. */
  scriptInputs: (tx: Tx, ctx: TenantContext, loaded: Loaded, def: ScriptDef, data: Record<string, unknown>, asOf: string) => Promise<Record<string, unknown>>;
  /** Saves of other records inside the open transaction, through the full pipeline; for script effects. */
  nested: {
    create(tx: Tx, ctx: TenantContext, loaded: Loaded, typeKey: string, data: Record<string, unknown>): Promise<SavedRecord>;
    update(tx: Tx, ctx: TenantContext, loaded: Loaded, id: string, input: { recordType: string; data: Record<string, unknown>; expectedVersion: number }): Promise<SavedRecord>;
  };
}

export interface SavedRecord {
  id: string;
  type: string;
  version: number;
}

/** Proposals of one script run, checked and held until the record is written. */
export interface HeldEffects {
  script: PublishedDefinition<'script'>;
  effects: ScriptEffect[];
}

/** The effects every script of one save, nested saves included, has proposed so far. */
export interface EffectBudget {
  used: number;
}

/** One save as it moves through the stages; the pre-write stages fill `patch`, `data`, `hidden` and `scripts`. */
export interface SaveContext {
  ctx: TenantContext;
  services: SaveServices;
  loaded: Loaded;
  type: RecordTypeDef;
  /** The stored record, its sensitive values decrypted; null on create. */
  current: RecordRow | null;
  previous: Record<string, unknown> | null;
  previousStatus: string | null;
  /** The status the record is saved in. */
  status: string | null;
  move: Move;
  requiredFields: string[];
  transition?: WorkflowDef['transitions'][number];
  dryRun: boolean;
  patch: Record<string, unknown>;
  data: Record<string, unknown>;
  hidden: Set<string>;
  scripts: ScriptRun[];
  /** Script proposals checked and waiting to be applied after the write. */
  held: HeldEffects[];
  /** Shared with nested saves started by this save's effects. */
  budget: EffectBudget;
}

export function saveContext(
  services: SaveServices,
  ctx: TenantContext,
  loaded: Loaded,
  current: RecordRow | null,
  input: Record<string, unknown>,
  move: Move,
  opts: { requiredFields?: string[]; transition?: WorkflowDef['transitions'][number]; dryRun?: boolean; budget?: EffectBudget; held?: HeldEffects[] } = {},
): SaveContext {
  return {
    ctx,
    services,
    loaded,
    type: loaded.type.body,
    current,
    previous: current?.data ?? null,
    previousStatus: current?.status ?? null,
    status: move.status,
    move,
    requiredFields: opts.requiredFields ?? [],
    transition: opts.transition,
    dryRun: opts.dryRun ?? false,
    patch: { ...input },
    data: {},
    hidden: new Set(),
    scripts: [],
    held: opts.held ?? [],
    budget: opts.budget ?? { used: 0 },
  };
}
