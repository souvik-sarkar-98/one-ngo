import type { Tx } from '../../../domain/ports/transaction.js';
import type { DefinitionKind, ModuleManifest } from '../types.js';

export type { DefinitionKind, ModuleManifest } from '../types.js';

export interface DefinitionRow {
  kind: DefinitionKind;
  key: string;
  version: number;
  base_version: number | null;
  module_key: string | null;
  body: unknown;
  checksum: string;
  status: 'draft' | 'published' | 'superseded';
}

export interface CatalogueRow {
  kind: DefinitionKind;
  key: string;
  version: number;
  status: string;
  base_version: number | null;
  module_key: string | null;
  label: string | null;
}

export interface NewPublished {
  actorId: string;
  kind: DefinitionKind;
  key: string;
  version: number;
  baseVersion: number | null;
  moduleKey: string | null;
  body: unknown;
  checksum: string;
}

/** A webhook or http connector a definition may name. Webhooks always send. */
export interface ConnectorFact {
  key: string;
  type: 'webhook' | 'http';
  mode: 'send' | 'lookup';
}

/** What cross-reference checks need besides definitions: the organisation's accounts, receipt series, roles and webhook and http connectors. */
export interface ReferenceFacts {
  accountCodes: string[];
  receiptSeries: string[];
  roles: { key: string; permissions: string[] }[];
  /** False when no organisation is in scope (base-layer checks). */
  inTenant: boolean;
  /** Webhook and http connectors; null outside an organisation. */
  connectors: ConnectorFact[] | null;
  /** Names of the fixed recipients in the organisation settings; null outside an organisation. */
  namedRecipients?: string[] | null;
}

export interface ModuleState {
  module_key: string;
  module_version: string;
  enabled: boolean;
}

/**
 * Definitions of the organisation in the open transaction: the published
 * snapshot, drafts, versions, extension patches and module switches.
 * Platform definitions are those of the base layer's platform module.
 */
export interface DefinitionStore {
  /** The organisation's config version, or undefined when it does not exist. */
  configVersion(tx: Tx): Promise<number | undefined>;
  bumpConfigVersion(tx: Tx): Promise<void>;
  /** The published definitions the organisation reads: its own, and platform ones it has not replaced. */
  published(tx: Tx): Promise<DefinitionRow[]>;
  /** A published or superseded version, the organisation's own before the platform's. */
  version(tx: Tx, kind: DefinitionKind, key: string, version: number): Promise<DefinitionRow | undefined>;
  /** A published or superseded version of the organisation's own. */
  ownVersion(tx: Tx, kind: DefinitionKind, key: string, version: number): Promise<DefinitionRow | undefined>;
  history(tx: Tx, kind: DefinitionKind, key: string): Promise<{ version: number; status: string; base_version: number | null; published_at: Date | null }[]>;
  catalogue(tx: Tx): Promise<CatalogueRow[]>;

  draft(tx: Tx, kind: DefinitionKind, key: string): Promise<DefinitionRow | undefined>;
  draftVersion(tx: Tx, kind: DefinitionKind, key: string): Promise<{ version: number } | undefined>;
  /** Supersedes the open draft; false when there is none. */
  discardDraft(tx: Tx, kind: DefinitionKind, key: string): Promise<boolean>;
  replaceDraft(tx: Tx, kind: DefinitionKind, key: string, version: number, body: unknown, checksum: string, actorId: string): Promise<void>;
  addDraft(tx: Tx, kind: DefinitionKind, key: string, version: number, body: unknown, checksum: string, actorId: string): Promise<void>;
  publishDraft(tx: Tx, kind: DefinitionKind, key: string, version: number, actorId: string): Promise<void>;
  /** One above every version of the organisation's and the platform's, so a patched version never shares a number with a base one. */
  nextVersion(tx: Tx, kind: DefinitionKind, key: string): Promise<number>;
  /** Supersedes the organisation's published version. */
  supersede(tx: Tx, kind: DefinitionKind, key: string): Promise<void>;
  addPublished(tx: Tx, d: NewPublished): Promise<void>;
  /** The organisation's published version's base and checksum. */
  publishedState(tx: Tx, kind: DefinitionKind, key: string): Promise<{ base_version: number | null; checksum: string } | undefined>;

  /** The current base-layer version of a shipped definition. */
  base(tx: Tx, kind: DefinitionKind, key: string): Promise<DefinitionRow | undefined>;
  /** Published base-layer definitions of a module. */
  moduleBases(tx: Tx, moduleKey: string): Promise<DefinitionRow[]>;
  /** Every base-layer version of a module's definitions, published or superseded. */
  moduleBaseVersions(tx: Tx, moduleKey: string): Promise<{ kind: DefinitionKind; key: string; version: number; body: unknown }[]>;
  patch(tx: Tx, kind: DefinitionKind, key: string): Promise<{ patch: unknown } | undefined>;
  patches(tx: Tx): Promise<{ kind: DefinitionKind; key: string; patch: unknown }[]>;
  savePatch(tx: Tx, kind: DefinitionKind, key: string, patch: unknown, actorId: string): Promise<void>;

  /** 
amedRecipientsSetting is the organisation setting that holds the named fixed recipients (NAMED_RECIPIENTS_SETTING). */
  referenceFacts(tx: Tx, namedRecipientsSetting: string): Promise<ReferenceFacts>;
  /** The connectors part of referenceFacts alone, for record saves; null outside an organisation. */
  connectorFacts(tx: Tx): Promise<ConnectorFact[] | null>;

  modules(tx: Tx): Promise<ModuleState[]>;
  moduleEnabled(tx: Tx, moduleKey: string | null): Promise<boolean>;
  /** Adds the module's setup accounts, receipt series and roles (keeping customised roles) and turns the module on at its version. */
  installModule(tx: Tx, manifest: Pick<ModuleManifest, 'key' | 'version' | 'setup'>): Promise<void>;
  /** The organisation's published definitions of the module. */
  moduleDefinitions(tx: Tx, moduleKey: string): Promise<{ kind: DefinitionKind; key: string; base_version: number | null }[]>;
  /** Supersedes the module's published definitions and turns it off; returns what was unpublished. */
  turnOffModule(tx: Tx, moduleKey: string): Promise<{ kind: DefinitionKind; key: string }[]>;
}
