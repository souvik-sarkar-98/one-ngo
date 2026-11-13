/** Product-shipped definitions, which belong to no organisation. */
export interface DefinitionBase {
  /** Publishes the body as the next base version unless the published one has this checksum; returns the base version. */
  publish(kind: string, key: string, moduleKey: string, body: unknown, checksum: string): Promise<number>;
  publishedChecksums(moduleKey: string): Promise<{ kind: string; key: string; checksum: string }[]>;
  /** Organisations whose published copy of a module definition is older than its base. */
  organisationsBehind(moduleKey: string): Promise<{ tenant_id: string; kind: string; key: string }[]>;
}
