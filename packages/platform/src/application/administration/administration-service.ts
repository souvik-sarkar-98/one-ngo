import type { TenantDirectory } from '../../domain/organisations/ports/organisation-directory.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { NAMED_RECIPIENTS_SETTING, type NamedRecipient } from '../../runtime/definitions/settings.js';
import { dateOf, oneOf, pageOf } from '../../runtime/definitions/list-params.js';
import { demand } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { FY_START_SETTING } from '../../domain/ledger/fiscal-year.js';
import { API_ACTOR_PREFIX, API_CORS_SETTING, API_RATE_SETTING, corsOriginsOf, requireCorsOrigins } from '../../domain/identity/api-key-policy.js';
import { QUOTA_SETTING } from '../shared/platform-settings.js';
import { LAYOUT_SETTING, layoutOf, readLayout, themeOf, type AppearanceLayout } from '../../runtime/definitions/appearance.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { ThemeDef } from '../../runtime/definitions/types.js';
import { LOCALE_PATTERN, SHIPPED_LOCALES } from '../../runtime/definitions/messages.js';
import type { AdministrationStore } from './ports/administration-store.js';

/** Audit areas for the filter, by the audited entity. */
export const AUDIT_AREAS = {
  records: { entities: [], prefixes: ['record:'] },
  people: { entities: ['member'], prefixes: [] },
  roles: { entities: ['role'], prefixes: [] },
  setup: { entities: ['module'], prefixes: ['definition:'] },
  connectors: { entities: ['connector'], prefixes: [] },
  apiKeys: { entities: ['api_key'], prefixes: [] },
  money: { entities: ['money_account', 'transfer', 'fiscal_period', 'journal_entry', 'payment_intent', 'receipt'], prefixes: [] },
  files: { entities: ['file'], prefixes: [] },
  organisation: { entities: ['tenant'], prefixes: [] },
} as const satisfies Record<string, { entities: readonly string[]; prefixes: readonly string[] }>;
export type AuditArea = keyof typeof AUDIT_AREAS;
const AREA_KEYS = Object.keys(AUDIT_AREAS) as AuditArea[];

export interface AuditQuery {
  person?: unknown;
  area?: unknown;
  recordType?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface AuditEntry {
  id: number;
  at: string;
  /** A user id, `api:<key name>` or `system:<part>`. */
  actorId: string | null;
  /** The person's name, or the key name for API keys. */
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  area: AuditArea | null;
  recordType: string | null;
  before: unknown;
  after: unknown;
}

export interface OrganisationSettings {
  /** Read-only: the organisation code in sign-in links, set when the organisation was onboarded. */
  code: string;
  /** The display name. */
  name: string;
  legalName: string | null;
  defaultLanguage: string;
  languages: string[];
  storage: { usedBytes: number; quotaBytes: number };
  apiRequestsPerMinute: number;
  /** Exact browser origins allowed to read this organisation's data feeds. Empty means a server with the key may call, and a browser on another site may not. */
  corsOrigins: string[];
  /** 1 (January) to 12; 4 (April) unless changed. */
  financialYearStartMonth: number;
  /** True once a financial year is open or a receipt issued: the start month can no longer change. */
  financialYearFixed: boolean;
  /** Fixed recipients scripts may notify by name; a script can never supply an address itself. */
  namedRecipients: Record<string, NamedRecipient>;
}

export interface SettingsInput {
  name?: unknown;
  legalName?: unknown;
  defaultLanguage?: unknown;
  storageQuotaBytes?: unknown;
  apiRequestsPerMinute?: unknown;
  /** Replaces the organisation's browser origins for its data feeds. */
  corsOrigins?: unknown;
  financialYearStartMonth?: unknown;
  namedRecipients?: unknown;
}

const RECIPIENT_NAME = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[1-9]\d{6,14}$/;

/** The named recipients as sent, checked: a key-like name, and an email and/or phone each. */
function namedRecipientsOf(value: unknown): Record<string, NamedRecipient> {
  const issues: FieldIssue[] = [];
  const out: Record<string, NamedRecipient> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationFailed('Named recipients must be an object.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw validationFailed('Keep at most 20 named recipients.', [{ path: 'namedRecipients', message: 'At most 20.' }]);
  for (const [name, raw] of entries) {
    const path = `namedRecipients/${name}`;
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!RECIPIENT_NAME.test(name)) issues.push({ path, message: 'Use a short name of letters and digits starting with a lower-case letter, such as auditor.' });
    const email = typeof r.email === 'string' ? r.email.trim() : '';
    const phone = typeof r.phone === 'string' ? r.phone.replace(/[\s\-().]/g, '') : '';
    if (!email && !phone) issues.push({ path, message: 'Give an email address, a phone number, or both.' });
    if (email && !EMAIL.test(email)) issues.push({ path: `${path}/email`, message: 'Not an email address.' });
    if (phone && !PHONE.test(phone)) issues.push({ path: `${path}/phone`, message: 'Not a phone number.' });
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 120) : '';
    out[name] = { ...(label ? { label } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
  }
  if (issues.length) throw validationFailed('Some named recipients are not valid.', issues);
  return out;
}

const MAX_QUOTA_BYTES = 10 * 1024 ** 4;
const MAX_API_RATE = 100_000;

function areaOf(entity: string): AuditArea | null {
  return AREA_KEYS.find((k) => (AUDIT_AREAS[k].entities as readonly string[]).includes(entity) || AUDIT_AREAS[k].prefixes.some((p) => entity.startsWith(p))) ?? null;
}

const FY_FIXED_MESSAGE =
  'The financial year start month cannot change once a financial year has been opened or a receipt issued: closed years and receipt numbers must stay as they are.';

function wholeNumber(value: unknown, min: number, max: number, path: string, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw validationFailed(message, [{ path, message }]);
  return value;
}

/** Administration's read-only audit log and the organisation's own settings. */
export class AdministrationService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: AdministrationStore,
    private readonly tenants: TenantDirectory,
    private readonly definitions: DefinitionService,
    private readonly storageOf: (tenantId: string) => Promise<{ used: number; quota: number }>,
    private readonly defaultApiRate: number,
  ) {}

  /** Newest first. `person` is a user id or `api:<key name>`; dates are inclusive calendar days. */
  async audit(ctx: TenantContext, query: AuditQuery = {}): Promise<{ items: AuditEntry[]; total: number; limit: number; offset: number }> {
    demand(ctx.actor, 'admin:audit');
    const area = oneOf(query.area, AREA_KEYS, 'area');
    const recordType = typeof query.recordType === 'string' && query.recordType ? query.recordType.slice(0, 100) : null;
    const person = typeof query.person === 'string' && query.person ? query.person.slice(0, 200) : null;
    const from = dateOf(query.from, 'from') ?? null;
    const to = dateOf(query.to, 'to') ?? null;
    const page = pageOf(query.limit, query.offset);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const { rows, total } = await this.store.auditPage(
        tx,
        { person, area: area !== undefined ? AUDIT_AREAS[area] : null, entity: recordType !== null ? `record:${recordType}` : null, from, to },
        page,
      );
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          at: new Date(r.at).toISOString(),
          actorId: r.actor_id,
          actorName: r.actor_name ?? (r.actor_id?.startsWith(API_ACTOR_PREFIX) ? r.actor_id.slice(API_ACTOR_PREFIX.length) : null),
          action: r.action,
          entity: r.entity,
          entityId: r.entity_id,
          area: areaOf(r.entity),
          recordType: r.entity.startsWith('record:') ? r.entity.slice('record:'.length) : null,
          before: r.before,
          after: r.after,
        })),
        total,
        ...page,
      };
    });
  }

  async settings(ctx: TenantContext): Promise<OrganisationSettings> {
    demand(ctx.actor, 'admin:settings');
    const { row, startMonth, fixed, named, cors } = await this.transactions.withTenant(ctx.tenantId, async (tx) => ({
      row: await this.store.settings(tx, API_RATE_SETTING),
      startMonth: await this.store.fiscalYearStartMonth(tx),
      fixed: await this.store.financialYearFixed(tx),
      named: await this.store.setting(tx, NAMED_RECIPIENTS_SETTING),
      cors: await this.store.setting(tx, API_CORS_SETTING),
    }));
    if (!row) throw notFound('Unknown organisation.');
    const storage = await this.storageOf(ctx.tenantId);
    const rate = Math.trunc(Number(row.rate));
    return {
      code: row.key,
      name: row.name,
      legalName: row.legal_name,
      defaultLanguage: row.default_locale,
      languages: await this.languages(ctx.tenantId),
      storage: { usedBytes: storage.used, quotaBytes: storage.quota },
      apiRequestsPerMinute: row.rate !== null && Number.isFinite(rate) && rate >= 1 ? Math.min(rate, MAX_API_RATE) : this.defaultApiRate,
      corsOrigins: corsOriginsOf(cors),
      financialYearStartMonth: startMonth,
      financialYearFixed: fixed,
      namedRecipients: named && typeof named === 'object' && !Array.isArray(named) ? (named as Record<string, NamedRecipient>) : {},
    };
  }

  /** Changes only the settings sent; every change is audited with what it was before. */
  async saveSettings(ctx: TenantContext, input: SettingsInput): Promise<OrganisationSettings> {
    demand(ctx.actor, 'admin:settings');
    const current = await this.settings(ctx);
    const next: Partial<{
      name: string;
      legalName: string;
      defaultLanguage: string;
      storageQuotaBytes: number;
      apiRequestsPerMinute: number;
      corsOrigins: string[];
      financialYearStartMonth: number;
      namedRecipients: Record<string, NamedRecipient>;
    }> = {};
    if (input.namedRecipients !== undefined) next.namedRecipients = namedRecipientsOf(input.namedRecipients);
    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 120) throw validationFailed('Give the organisation a name of at most 120 characters.', [{ path: 'name', message: 'Required, at most 120 characters.' }]);
      next.name = name;
    }
    if (input.legalName !== undefined) {
      const legalName = typeof input.legalName === 'string' ? input.legalName.trim().replace(/\s+/g, ' ') : '';
      if (!legalName || legalName.length > 200) {
        throw validationFailed('Give the legal name of at most 200 characters, as it appears on the registration documents.', [
          { path: 'legalName', message: 'Required, at most 200 characters.' },
        ]);
      }
      next.legalName = legalName;
    }
    if (input.defaultLanguage !== undefined) {
      const lang = input.defaultLanguage;
      if (typeof lang !== 'string' || !LOCALE_PATTERN.test(lang) || !current.languages.includes(lang)) {
        throw validationFailed('Choose one of the languages this organisation offers.', [{ path: 'defaultLanguage', message: `One of ${current.languages.join(', ')}.` }]);
      }
      next.defaultLanguage = lang;
    }
    if (input.storageQuotaBytes !== undefined) {
      next.storageQuotaBytes = wholeNumber(input.storageQuotaBytes, 0, MAX_QUOTA_BYTES, 'storageQuotaBytes', 'The storage quota is a whole number of bytes, at most 10 TB.');
    }
    if (input.apiRequestsPerMinute !== undefined) {
      next.apiRequestsPerMinute = wholeNumber(input.apiRequestsPerMinute, 1, MAX_API_RATE, 'apiRequestsPerMinute', `API requests per minute is a whole number from 1 to ${MAX_API_RATE}.`);
    }
    if (input.corsOrigins !== undefined) next.corsOrigins = requireCorsOrigins(input.corsOrigins);
    if (input.financialYearStartMonth !== undefined) {
      next.financialYearStartMonth = wholeNumber(input.financialYearStartMonth, 1, 12, 'financialYearStartMonth', 'The financial year start month is a whole number from 1 (January) to 12 (December).');
    }
    const was = {
      name: current.name,
      legalName: current.legalName,
      defaultLanguage: current.defaultLanguage,
      storageQuotaBytes: current.storage.quotaBytes,
      apiRequestsPerMinute: current.apiRequestsPerMinute,
      corsOrigins: current.corsOrigins,
      financialYearStartMonth: current.financialYearStartMonth,
      namedRecipients: current.namedRecipients,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(was[k]));
    if (!changed.length) return current;
    const startMonthChanged = changed.includes('financialYearStartMonth');
    if (startMonthChanged && current.financialYearFixed) throw ruleViolation(FY_FIXED_MESSAGE);
    if (next.name !== undefined || next.legalName !== undefined || next.defaultLanguage !== undefined) {
      await this.tenants.updateIdentity(ctx.tenantId, { name: next.name, legalName: next.legalName, defaultLanguage: next.defaultLanguage });
    }
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const put = (key: string, value: unknown) => this.store.putSetting(tx, key, value, ctx.actor.id);
      if (changed.includes('namedRecipients')) await put(NAMED_RECIPIENTS_SETTING, next.namedRecipients!);
      if (changed.includes('storageQuotaBytes')) await put(QUOTA_SETTING, next.storageQuotaBytes!);
      if (changed.includes('apiRequestsPerMinute')) await put(API_RATE_SETTING, next.apiRequestsPerMinute!);
      if (changed.includes('corsOrigins')) await put(API_CORS_SETTING, next.corsOrigins!);
      if (startMonthChanged) {
        await this.store.holdFiscalYearStart(tx);
        if (await this.store.financialYearFixed(tx)) throw ruleViolation(FY_FIXED_MESSAGE);
        await put(FY_START_SETTING, next.financialYearStartMonth!);
      }
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'settings.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: Object.fromEntries(changed.map((k) => [k, next[k]])),
      });
    });
    return this.settings(ctx);
  }

  /** Publishes the organisation theme. An open draft of that theme is discarded. */
  async saveTheme(ctx: TenantContext, body: unknown): Promise<ThemeDef> {
    demand(ctx.actor, 'admin:settings');
    const published = await this.definitions.publishTheme(ctx, themeOf(body));
    return published.body;
  }

  /** The published navigation order and starting list layout. Null lists mean the app's own arrangement. */
  async layout(ctx: TenantContext): Promise<{ items: string[] | null; listLayout: 'cards' | 'table'; icons: Record<string, string> | null }> {
    demand(ctx.actor, 'admin:settings');
    const stored = readLayout(await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.setting(tx, LAYOUT_SETTING)));
    return stored ? { items: stored.items, listLayout: stored.listLayout, icons: stored.icons ?? null } : { items: null, listLayout: 'table', icons: null };
  }

  /** Publishes the navigation order, icons and starting list layout. Everyone sees it on the next screen load. */
  async saveLayout(ctx: TenantContext, body: unknown): Promise<AppearanceLayout> {
    demand(ctx.actor, 'admin:settings');
    const next = layoutOf(body);
    const before = readLayout(await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.setting(tx, LAYOUT_SETTING)));
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      await this.store.putSetting(tx, LAYOUT_SETTING, next, ctx.actor.id);
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'settings.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        before: before ? { layout: before } : {},
        after: { layout: next },
      });
    });
    return next;
  }

  private async languages(tenantId: string): Promise<string[]> {
    const own = (await this.definitions.list(tenantId, 'translation')).map((t) => t.body.locale);
    return [...new Set([...SHIPPED_LOCALES, ...own])];
  }
}
