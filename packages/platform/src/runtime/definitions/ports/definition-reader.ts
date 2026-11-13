import type { DefinitionKind, PublishedDefinition } from '../types.js';
import type { ConnectorFact } from './definition-store.js';

/** The reads record, notification, workflow, automation and action work needs. */
export interface DefinitionReader {
  get<K extends DefinitionKind>(tenantId: string, kind: K, key: string): Promise<PublishedDefinition<K> | undefined>;
  list<K extends DefinitionKind>(tenantId: string, kind: K): Promise<PublishedDefinition<K>[]>;
  /** The record type's first primary workflow. */
  workflowFor(tenantId: string, recordType: string): Promise<PublishedDefinition<'workflow'> | undefined>;
  /** Every workflow of the record type, primary ones first. */
  workflowsFor(tenantId: string, recordType: string): Promise<PublishedDefinition<'workflow'>[]>;
  /** The organisation's webhook and http connectors by key. Readers without it send script connector calls as webhooks. */
  connectors?(tenantId: string): Promise<ReadonlyMap<string, ConnectorFact>>;
}

/** The reads plus an earlier published version of one definition. */
export interface DefinitionVersionReader extends DefinitionReader {
  getVersion<K extends DefinitionKind>(tenantId: string, kind: K, key: string, version: number): Promise<PublishedDefinition<K> | undefined>;
}
