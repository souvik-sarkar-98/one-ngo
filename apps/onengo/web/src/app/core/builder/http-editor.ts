import type { HttpLike } from '../http/http';
import type { JsonSchema } from './schema-form';

/** A permission offered while typing one, with where it is used and how many roles hold it. */
export interface PermissionSuggestion {
  permission: string;
  label: string;
  source: 'generated' | 'used';
  usedIn: { label: string; kind: string; key: string; path: string }[];
  roles: number;
}

/** Fields of a record type whose index is still being built, and fields over the index cap (they work, unindexed). */
export interface IndexWarnings {
  pending: string[];
  notIndexed: string[];
}

/** What the visual editor needs besides the definition: its kind's schema and the names it suggests. */
export interface EditorGateway {
  schema(kind: string): Promise<JsonSchema>;
  permissionSuggestions(q: string): Promise<PermissionSuggestion[]>;
  roles(): Promise<{ key: string; label: string }[]>;
  indexWarnings(recordType: string): Promise<IndexWarnings>;
  /** The organisation's connectors, for steps and lookups that name one. */
  connectors(): Promise<{ key: string; kind: string }[]>;
}

export function httpEditor(http: HttpLike): EditorGateway {
  return {
    schema: (kind) => http.get<JsonSchema>(`/api/builder/schemas/${encodeURIComponent(kind)}`),
    permissionSuggestions: (q) => http.get<PermissionSuggestion[]>(`/api/admin/permission-suggestions?q=${encodeURIComponent(q)}`),
    roles: () => http.get<{ key: string; label: string }[]>('/api/admin/roles'),
    indexWarnings: (recordType) => http.get<IndexWarnings>(`/api/builder/index-warnings/${encodeURIComponent(recordType)}`),
    connectors: () => http.get<{ key: string; kind: string }[]>('/api/admin/connectors'),
  };
}
