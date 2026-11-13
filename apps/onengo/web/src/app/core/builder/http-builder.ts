import { contracted, type DraftRequest, type ExtensionPatchRequest, type RollbackRequest } from '../contracts';
import type { HttpLike } from '../http/http';
import type { BuilderDetail, CatalogueItem, DefinitionKind, Issue, RecordTypeBody } from '../models';
import type { ExpressionCheck, ExpressionContext, ExpressionSample, ValueType } from './expression-catalogue';

/** Problems found in a definition: errors stop publishing, warnings do not. */
export interface CheckResult {
  errors: Issue[];
  warnings: Issue[];
}

/** `published`: the draft against the published version; `module`: the published version against the module's. */
export type ChangesAgainst = 'published' | 'module';

/** What changes for people, one plain sentence per line, with what it affects. */
export interface ChangesResult {
  against: ChangesAgainst;
  from: { version: number; module: boolean } | null;
  to: { version: number | null; draft: boolean };
  lines: string[];
  warnings: Issue[];
}

export interface ExpressionCheckRequest {
  source: string;
  /** A published record type; its fields and workflows are checked. */
  recordType?: string;
  context?: ExpressionContext;
  /** The action form's field keys, readable as `input.<key>`. */
  input?: string[];
}

/** On a real record (read permission needed; sensitive values masked) or on sample values. */
export interface ExpressionTryRequest {
  source: string;
  recordType?: string;
  recordId?: string;
  sample?: ExpressionSample;
}

export interface ExpressionTry {
  ok: boolean;
  value?: unknown;
  resultType?: ValueType;
  error?: string;
  position?: number;
}

/** A published definition that uses a definition or one of its fields, with what the use is in a few words. */
export interface Usage {
  kind: DefinitionKind;
  key: string;
  label: string | null;
  path: string;
  what: string;
}

/** The counter value the next record of a sequence gets, and the periods it is formatted with. */
export interface NextNumber {
  next: number;
  fy: string;
  period: string;
}

/** Drafts, publishing and history of definitions. */
export interface BuilderGateway {
  catalogue(): Promise<CatalogueItem[]>;
  detail(kind: string, key: string): Promise<BuilderDetail>;
  /** The body is the whole definition; its `key` must be the address's. */
  saveDraft(kind: string, key: string, body: object): Promise<void>;
  publish(kind: string, key: string): Promise<void>;
  discard(kind: string, key: string): Promise<void>;
  rollback(kind: string, key: string, version: number): Promise<void>;
  savePatch(kind: string, key: string, patch: ExtensionPatchRequest['patch']): Promise<void>;
  /** Checks the body sent (a whole body or `{ patch }`), or the saved draft when none is sent. */
  check(kind: string, key: string, body?: unknown): Promise<CheckResult>;
  changes(kind: string, key: string, against: ChangesAgainst): Promise<ChangesResult>;
  publishedRecordType(key: string): Promise<{ body: RecordTypeBody }>;
  checkExpression(request: ExpressionCheckRequest): Promise<ExpressionCheck>;
  tryExpression(request: ExpressionTryRequest): Promise<ExpressionTry>;
  usages(kind: string, key: string, field?: string): Promise<Usage[]>;
  nextNumber(sequence: string, reset: 'fiscal_year' | 'never'): Promise<NextNumber>;
}

const definition = (kind: string, key: string) => `/api/builder/definitions/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;

/** The definition routes with fixed contracts; a draft's contents are checked against its kind's schema. */
export interface DefinitionRoutes {
  'PUT /api/builder/definitions/:kind/:key/draft': { body: DraftRequest; answer: { version: number } };
  'POST /api/builder/definitions/:kind/:key/rollback': { body: RollbackRequest; answer: void };
  'PUT /api/builder/definitions/:kind/:key/patch': { body: ExtensionPatchRequest; answer: void };
}

export function httpBuilder(http: HttpLike): BuilderGateway {
  const send = contracted<DefinitionRoutes>(http);
  return {
    catalogue: () => http.get<CatalogueItem[]>('/api/builder/catalogue'),
    detail: (kind, key) => http.get<BuilderDetail>(definition(kind, key)),
    saveDraft: async (kind, key, body) => {
      await send('PUT /api/builder/definitions/:kind/:key/draft', { kind, key }, { ...body, key: 'key' in body ? String(body.key) : '' });
    },
    publish: (kind, key) => http.post(`${definition(kind, key)}/publish`),
    discard: (kind, key) => http.post(`${definition(kind, key)}/discard`),
    rollback: (kind, key, version) => send('POST /api/builder/definitions/:kind/:key/rollback', { kind, key }, { version }),
    savePatch: (kind, key, patch) => send('PUT /api/builder/definitions/:kind/:key/patch', { kind, key }, { patch }),
    check: (kind, key, body) => http.post<CheckResult>(`${definition(kind, key)}/check`, body ?? {}),
    changes: (kind, key, against) => http.get<ChangesResult>(`${definition(kind, key)}/changes?against=${against}`),
    publishedRecordType: (key) => http.get<{ body: RecordTypeBody }>(`/api/definitions/recordType/${encodeURIComponent(key)}`),
    checkExpression: (request) => http.post<ExpressionCheck>('/api/builder/expressions/check', request),
    tryExpression: (request) => http.post<ExpressionTry>('/api/builder/expressions/try', request),
    usages: async (kind, key, field) =>
      (await http.get<{ usages: Usage[] }>(`/api/builder/usages/${encodeURIComponent(kind)}/${encodeURIComponent(key)}${field ? `?field=${encodeURIComponent(field)}` : ''}`)).usages,
    nextNumber: (sequence, reset) => http.get<NextNumber>(`/api/builder/sequences/${encodeURIComponent(sequence)}/next?reset=${reset}`),
  };
}
