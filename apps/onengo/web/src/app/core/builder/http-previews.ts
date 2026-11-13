import type { HttpLike } from '../http/http';

/** The record a preview is filled from: a real one (read permission needed), or none for empty values. */
export interface PreviewRecord {
  recordType?: string;
  recordId?: string;
}

export interface TemplatePreview {
  subject: string;
  body: string;
  /** Filled, sanitised email HTML. Absent when the template has none. */
  html?: string;
  /** Filled WhatsApp template. Absent when the template does not name one. */
  whatsapp?: { name: string; language: string; parameters: string[] };
}

type TemplateRequest = { subject: string; body: string; html?: string; kind?: 'message' | 'document'; whatsapp?: unknown } & PreviewRecord;

export interface ScriptTry {
  ok: boolean;
  changed?: { field: string; before: unknown; after: unknown }[];
  logs?: string[];
  durationMs?: number;
  code?: string;
  error?: string;
}

export interface PostingTry {
  applies: boolean;
  date: unknown;
  memo: unknown;
  lines: { side: 'debit' | 'credit'; account: unknown; amount: unknown; fund: unknown }[];
  debit: number;
  credit: number;
  balanced: boolean;
  errors: { path: string; message: string }[];
}

/** Template preview and test send, script and posting rule tries: nothing here saves anything except the test email. */
export interface PreviewGateway {
  previewTemplate(template: TemplateRequest): Promise<TemplatePreview>;
  testTemplate(template: TemplateRequest): Promise<TemplatePreview & { sentTo: string }>;
  tryScript(request: { code: string; recordType: string; recordId?: string; timeoutMs?: number; memoryMb?: number }): Promise<ScriptTry>;
  tryPostingRule(request: { rule: unknown; recordId?: string }): Promise<PostingTry>;
}

export function httpPreviews(http: HttpLike): PreviewGateway {
  return {
    previewTemplate: (template) => http.post<TemplatePreview>('/api/builder/templates/preview', template),
    testTemplate: (template) => http.post<TemplatePreview & { sentTo: string }>('/api/builder/templates/test', template),
    tryScript: (request) => http.post<ScriptTry>('/api/builder/scripts/try', request),
    tryPostingRule: (request) => http.post<PostingTry>('/api/builder/posting-rules/try', request),
  };
}
