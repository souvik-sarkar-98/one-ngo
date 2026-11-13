import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, ruleViolation, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { likePattern } from '../definitions/list-params.js';
import { can, permissionMatches } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../definitions/ports/definition-reader.js';
import { isReadProtected } from '../definitions/field-permissions.js';
import type { RecordTypeDef } from '../definitions/types.js';
import type { PrincipalKind, ShareAccess, ShareRow, ShareStore } from './ports/share-store.js';
import type { RecordService, RecordView } from './record-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 3600 * 1000;
const CANDIDATE_MAX = 8;

export type { PrincipalKind, ShareAccess };

export interface ShareView {
  id: string;
  principalKind: PrincipalKind;
  /** A person's user id or a role key. */
  principal: string;
  /** The person's name or the role's label. */
  name: string;
  access: ShareAccess;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
}

/** Someone a record can be shared with. */
export interface ShareCandidate {
  principalKind: PrincipalKind;
  principal: string;
  name: string;
  /** People only. */
  email?: string;
  /** Whether their roles let them see records of this type at all; a share with anyone else gives no access. */
  canSee: boolean;
  /** Whether their roles let them edit records of this type, which an edit share still needs. */
  canEdit: boolean;
}

export interface ShareInput {
  principalKind?: unknown;
  principal?: unknown;
  access?: unknown;
  /** An ISO date-time, or a date meaning until the end of that day (UTC); empty for no end. */
  expiresAt?: unknown;
}

/** What a new share tells the person it was shared with. */
export interface ShareNotice {
  type: RecordTypeDef;
  record: RecordView;
  principalKind: PrincipalKind;
  principal: string;
  access: ShareAccess;
  expiresAt: Date | null;
}

export interface AppliedShare {
  shareId: string;
  notice: ShareNotice | null;
}

/** An in-app message to a person or a role. */
export interface ShareMessage {
  to: { users: string[] } | { roles: string[] };
  subject: string;
  body: string;
  recordId: string;
  exclude: string[];
}

const iso = (v: string | Date) => new Date(v).toISOString();
const toView = (r: ShareRow): ShareView => ({
  id: r.id,
  principalKind: r.principal_kind,
  principal: r.principal,
  name: r.name,
  access: r.access,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  expiresAt: r.expires_at ? iso(r.expires_at) : null,
});

/** `2026-11-30` runs to the end of that day; a date-time is taken as given. Undefined when not a valid date. */
export function parseExpiry(raw: unknown): Date | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const day = new Date(`${raw}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(raw) ? new Date(day.getTime() + DAY_MS) : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Shares of restricted records with a person or a role, for reading or
 * editing (editing still needs the update permission). Managed by people
 * with record:<type>:share and by the record's creator, who must be able to
 * see the record.
 */
export class ShareService {
  private readonly store: ShareStore;

  constructor(
    private readonly db: TransactionManager,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
  ) {
    this.store = records.stores.shares;
  }

  async list(ctx: TenantContext, typeKey: string, recordId: string): Promise<ShareView[]> {
    const { record } = await this.managed(ctx, typeKey, recordId);
    const rows: ShareRow[] = await this.db.withTenant(ctx.tenantId, (tx) => this.store.list(tx, record.id));
    return rows.map(toView);
  }

  /**
   * Adds a share, or changes the access and end of an existing one for the same person or role. Returns what the
   * caller needs to tell the person it was shared with (null when the share already stood); telling them is the caller's step.
   */
  async apply(ctx: TenantContext, typeKey: string, recordId: string, input: ShareInput): Promise<AppliedShare> {
    const { record, type } = await this.managed(ctx, typeKey, recordId);
    if (type.visibility !== 'restricted') {
      throw ruleViolation(`${type.label} records are visible to everyone who may see them, so they are not shared.`);
    }
    const issues: FieldIssue[] = [];
    const kind = input.principalKind;
    if (kind !== 'user' && kind !== 'role') issues.push({ path: '/principalKind', message: 'must be user or role' });
    const principal = typeof input.principal === 'string' ? input.principal.trim() : '';
    if (!principal || principal.length > 200) issues.push({ path: '/principal', message: 'must name a person or a role' });
    const access = input.access;
    if (access !== 'read' && access !== 'edit') issues.push({ path: '/access', message: 'must be read or edit' });
    const expiresAt = parseExpiry(input.expiresAt);
    if (expiresAt === undefined) issues.push({ path: '/expiresAt', message: 'must be a date or a date and time' });
    else if (expiresAt && expiresAt.getTime() <= Date.now()) issues.push({ path: '/expiresAt', message: 'must be in the future' });
    if (issues.length) throw validationFailed('The share is not valid.', issues);
    const principalKind = kind as PrincipalKind;

    const { row, notify } = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const known = principalKind === 'user' ? UUID.test(principal) && (await this.store.isActiveMember(tx, principal)) : await this.store.isRole(tx, principal);
      if (!known) {
        throw validationFailed('The share is not valid.', [
          { path: '/principal', message: principalKind === 'user' ? 'is not a member of this organisation' : 'is not a role of this organisation' },
        ]);
      }
      const existing = await this.store.lockShare(tx, record.id, principalKind, principal);
      const expires = expiresAt ? expiresAt.toISOString() : null;
      const saved = existing
        ? await this.store.changeShare(tx, existing.id, access as ShareAccess, expires)
        : await this.store.addShare(tx, {
            recordId: record.id,
            principalKind,
            principal,
            access: access as ShareAccess,
            createdBy: ctx.actor.id,
            expiresAt: expires,
          });
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'record.shared',
        entity: `record:${typeKey}`,
        entityId: record.id,
        after: { principalKind, principal, access, expiresAt: expires },
      });
      return { row: saved!, notify: !existing || !existing.live };
    });

    return { shareId: row, notice: notify ? { type, record, principalKind, principal, access: access as ShareAccess, expiresAt: expiresAt ?? null } : null };
  }

  /** The share as it is listed now. */
  async viewOf(ctx: TenantContext, typeKey: string, recordId: string, shareId: string): Promise<ShareView> {
    return (await this.list(ctx, typeKey, recordId)).find((s) => s.id === shareId)!;
  }

  /**
   * People (active members) and roles matching the text by name, email or
   * key, for whoever may manage the record's shares; the people picker and
   * the roles list need other permissions. Each one carries what their roles
   * let them do with this record type, so the panel can say when a share
   * would give them nothing.
   */
  async candidates(ctx: TenantContext, typeKey: string, recordId: string, query: { q?: unknown }): Promise<{ items: ShareCandidate[] }> {
    await this.managed(ctx, typeKey, recordId);
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
    const like = likePattern(q);
    const { people, roles } = await this.db.withTenant(ctx.tenantId, (tx) => this.store.candidates(tx, { q, like, exceptUserId: ctx.actor.id, max: CANDIDATE_MAX }));
    const holds = (permissions: string[] | null, permission: string) => (permissions ?? []).some((p) => permissionMatches(p, permission));
    const allows = (permissions: string[] | null) => ({
      canSee: holds(permissions, `record:${typeKey}:read`),
      canEdit: holds(permissions, `record:${typeKey}:update`),
    });
    return {
      items: [
        ...people.map((p): ShareCandidate => ({ principalKind: 'user', principal: p.id, name: p.name, email: p.email, ...allows(p.permissions) })),
        ...roles.map((r): ShareCandidate => ({ principalKind: 'role', principal: r.key, name: r.label, ...allows(r.permissions) })),
      ],
    };
  }

  async remove(ctx: TenantContext, typeKey: string, recordId: string, shareId: string): Promise<void> {
    const { record } = await this.managed(ctx, typeKey, recordId);
    if (!UUID.test(shareId)) throw notFound('Share not found.');
    await this.db.withTenant(ctx.tenantId, async (tx) => {
      const gone = await this.store.removeShare(tx, record.id, shareId);
      if (!gone) throw notFound('Share not found.');
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'record.unshared',
        entity: `record:${typeKey}`,
        entityId: record.id,
        before: { principalKind: gone.principal_kind, principal: gone.principal, access: gone.access },
      });
    });
  }

  /** The record, when the person can see it and may manage its shares. */
  private async managed(ctx: TenantContext, typeKey: string, recordId: string): Promise<{ record: RecordView; type: RecordTypeDef }> {
    const { record, createdBy } = await this.records.stored(ctx, recordId, 'read');
    if (record.type !== typeKey) throw notFound('Record not found.');
    if (createdBy !== ctx.actor.id && !can(ctx.actor, `record:${typeKey}:share`)) throw forbidden('Only its creator or people allowed to share can share this record.');
    const type = await this.defs.get(ctx.tenantId, 'recordType', typeKey);
    if (!type) throw notFound(`Unknown record type '${typeKey}'.`);
    return { record, type: type.body };
  }

  /** The message that tells the person or role about a new share. */
  async message(ctx: TenantContext, notice: ShareNotice): Promise<ShareMessage> {
    const { type, record, principalKind, principal, access, expiresAt } = notice;
    const me = await this.db.withTenant(ctx.tenantId, (tx) => this.store.userName(tx, ctx.actor.id));
    const titleField = type.fields.find((f) => f.key === type.titleField && !isReadProtected(type, f));
    const title = titleField ? record.data[titleField.key] : undefined;
    const name = record.number ?? (typeof title === 'string' || typeof title === 'number' ? String(title) : '');
    const until = expiresAt ? ` until ${new Date(expiresAt.getTime() - 1).toISOString().slice(0, 10)}` : '';
    return {
      to: principalKind === 'user' ? { users: [principal] } : { roles: [principal] },
      subject: `${me ?? 'Someone'} shared ${type.label}${name ? ` ${name}` : ''} with you`,
      body: `You can ${access === 'edit' ? 'see and edit' : 'see'} it${until}.`,
      recordId: record.id,
      exclude: [ctx.actor.id],
    };
  }
}
