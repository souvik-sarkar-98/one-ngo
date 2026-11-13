import { notFound } from '@onengo/kernel/errors';
import type { Database } from '@onengo/platform/operator';
import { OPERATOR_ACTIONS, type OperatorAccountContract, type OperatorActionContract, type OperatorActivityContract, type OperatorActivityEntryContract, type OperatorListContract, type OperatorOrganisationListContract, type OperatorOrganisationSummary } from '@onengo/platform/contracts';
import type { SqlExecutor } from '@onengo/kernel/db';

export interface OperatorActor {
  operatorId: string;
  display: string;
  issuer: string;
  subject: string;
  sessionId: string;
  authTime: string;
  amr: string[];
  acr?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A change the signed-in operator must not make to their own account. `undefined` means the change may proceed. */
export function refusedOwnChange(actorId: string, targetId: string, kind: 'disable' | 'relink' | 'grants', actions: readonly string[] = []): string | undefined {
  if (actorId !== targetId) return undefined;
  if (kind === 'disable') return 'Disabling your own account is refused.';
  if (kind === 'relink') return 'Changing your own login is refused.';
  if (!actions.includes('operators')) return 'Removing your own Manage operators action is refused.';
  return undefined;
}

const text = (value: unknown, label: string, max: number): string => {
  const clean = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!clean) throw new Error(`A ${label} is required.`);
  if (clean.length > max) throw new Error(`A ${label} is at most ${max} characters.`);
  return clean;
};

function subjectOf(value: unknown): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean) throw new Error('A subject ID is required.');
  if (clean.length > 200) throw new Error('A subject ID is at most 200 characters.');
  return clean;
}

export function operatorActions(value: unknown): OperatorActionContract[] {
  if (!Array.isArray(value)) throw new Error('The actions are required.');
  const seen = new Set<string>();
  for (const action of value) {
    if (typeof action !== 'string' || !(OPERATOR_ACTIONS as readonly string[]).includes(action)) throw new Error('An operator action is not recognised.');
    seen.add(action);
  }
  return [...seen] as OperatorActionContract[];
}

const operatorId = (value: string): string => {
  const id = value.trim().toLowerCase();
  if (!UUID.test(id)) throw new Error('The operator id is not a UUID.');
  return id;
};

const like = (value: string | undefined): string | null => {
  const clean = value?.trim();
  if (!clean) return null;
  if (clean.length > 200) throw new Error('The search is at most 200 characters.');
  return `%${clean.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
};

const moment = (value: string | undefined, label: string): string | null => {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`The ${label} date is not a calendar date.`);
  return parsed.toISOString();
};

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);

const identitiesOf = (value: unknown): OperatorAccountContract['identities'] => {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const issuer = (row as { issuer?: unknown }).issuer;
    const subject = (row as { subject?: unknown }).subject;
    return typeof issuer === 'string' && typeof subject === 'string' ? [{ issuer, subject }] : [];
  });
};

const duplicate = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && (current as { code?: string }).code === '23505') return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
};

interface ActivityQuery {
  q?: string;
  action?: string;
  from?: string;
  to?: string;
  limit: number;
}

const ORGANISATION_STATUSES = ['provisioning', 'active', 'provisioning_failed', 'suspended', 'closed'] as const;

export class OperatorDirectory {
  constructor(private readonly db: Database) {}
  private tx<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> { return this.db.asSystem(fn); }

  async listOrganisations(query: { q?: string; status?: string }): Promise<OperatorOrganisationListContract> {
    const status = query.status?.trim() || null;
    if (status && !(ORGANISATION_STATUSES as readonly string[]).includes(status)) throw new Error('The status filter is not recognised.');
    const rows = await this.tx((tx) => tx.query<{
      key: string; name: string; legal_name: string | null; status: string; region: string | null; created_at: Date;
    }>(
      `select key, name, legal_name, status, region, created_at
         from tenant
        where ($1::text is null or key ilike $1 escape '\\' or name ilike $1 escape '\\' or legal_name ilike $1 escape '\\')
          and ($2::text is null or status = $2)
        order by lower(name), key
        limit 200`,
      [like(query.q), status],
    ));
    const organisations: OperatorOrganisationSummary[] = rows.map((row) => ({
      code: row.key, displayName: row.name, legalName: row.legal_name, status: row.status, region: row.region, createdAt: iso(row.created_at)!,
    }));
    return { organisations };
  }

  async list(query: { q?: string; status?: string }): Promise<OperatorListContract> {
    const status = query.status?.trim() || null;
    if (status && status !== 'active' && status !== 'disabled') throw new Error('The status filter is not recognised.');
    const rows = await this.tx((tx) => tx.query<{
      id: string; display_name: string; status: 'active' | 'disabled'; created_at: Date; disabled_at: Date | null;
      disabled_reason: string | null; identities: unknown; actions: string[] | null;
    }>(
      `select a.id, a.display_name, a.status, a.created_at, a.disabled_at, a.disabled_reason,
              coalesce(json_agg(distinct jsonb_build_object('issuer', i.issuer, 'subject', i.subject))
                filter (where i.operator_id is not null), '[]') as identities,
              coalesce(array_agg(distinct g.action) filter (where g.action is not null), '{}') as actions
         from operator_account a
         left join operator_identity i on i.operator_id = a.id
         left join operator_grant g on g.operator_id = a.id and g.revoked_at is null
        where ($1::text is null or a.status = $1)
          and ($2::text is null or a.display_name ilike $2 escape '\\' or i.subject ilike $2 escape '\\')
        group by a.id
        order by a.display_name
        limit 200`,
      [status, like(query.q)],
    ));
    return { operators: rows.map((row) => this.account(row)) };
  }

  async get(id: string): Promise<OperatorAccountContract> {
    return this.tx((tx) => this.load(tx, operatorId(id)));
  }

  async create(actor: OperatorActor, input: { displayName: unknown; subject: unknown; actions: unknown }, issuer: string, stepUpId: string): Promise<OperatorAccountContract> {
    const displayName = text(input.displayName, 'display name', 200);
    const subject = subjectOf(input.subject);
    const actions = operatorActions(input.actions);
    try {
      return await this.tx(async (tx) => {
        const created = (await tx.query<{ id: string }>(
          'insert into operator_account(display_name, created_by) values($1,$2) returning id',
          [displayName, actor.operatorId],
        ))[0];
        if (!created) throw new Error('The operator account was not stored.');
        await tx.query(
          'insert into operator_identity(operator_id, issuer, subject, linked_by) values($1,$2,$3,$4)',
          [created.id, issuer, subject, actor.operatorId],
        );
        await this.replaceGrants(tx, created.id, actions, actor.operatorId);
        await this.audit(tx, actor, 'operator.created', stepUpId, { operatorId: created.id, displayName, issuer, subject, actions });
        return this.load(tx, created.id);
      });
    } catch (error) {
      if (duplicate(error)) throw new Error('That login is already linked to an operator.');
      throw error;
    }
  }

  async saveGrants(actor: OperatorActor, id: string, actions: unknown, stepUpId: string): Promise<OperatorAccountContract> {
    const target = operatorId(id);
    const next = operatorActions(actions);
    const refused = refusedOwnChange(actor.operatorId, target, 'grants', next);
    if (refused) throw new Error(refused);
    return this.tx(async (tx) => {
      await this.load(tx, target);
      await this.replaceGrants(tx, target, next, actor.operatorId);
      await this.audit(tx, actor, 'operator.grants', stepUpId, { operatorId: target, actions: next });
      return this.load(tx, target);
    });
  }

  async relink(actor: OperatorActor, id: string, subject: unknown, issuer: string, stepUpId: string): Promise<OperatorAccountContract> {
    const target = operatorId(id);
    const next = subjectOf(subject);
    const refused = refusedOwnChange(actor.operatorId, target, 'relink');
    if (refused) throw new Error(refused);
    try {
      return await this.tx(async (tx) => {
        await this.load(tx, target);
        await tx.query('delete from operator_identity where operator_id=$1 and issuer=$2', [target, issuer]);
        await tx.query(
          'insert into operator_identity(operator_id, issuer, subject, linked_by) values($1,$2,$3,$4)',
          [target, issuer, next, actor.operatorId],
        );
        await tx.query('update operator_session set revoked_at=coalesce(revoked_at,now()) where operator_id=$1 and issuer=$2', [target, issuer]);
        await this.audit(tx, actor, 'operator.relink', stepUpId, { operatorId: target, issuer, subject: next });
        return this.load(tx, target);
      });
    } catch (error) {
      if (duplicate(error)) throw new Error('That login is already linked to an operator.');
      throw error;
    }
  }

  async disable(actor: OperatorActor, id: string, reason: unknown, stepUpId: string): Promise<OperatorAccountContract> {
    const target = operatorId(id);
    const why = text(reason, 'reason', 500);
    const refused = refusedOwnChange(actor.operatorId, target, 'disable');
    if (refused) throw new Error(refused);
    return this.tx(async (tx) => {
      const current = await this.load(tx, target);
      if (current.status === 'disabled') throw new Error('This operator is already disabled.');
      await tx.query(
        `update operator_account set status='disabled', disabled_at=now(), disabled_by=$2, disabled_reason=$3 where id=$1 and status='active'`,
        [target, actor.operatorId, why],
      );
      await tx.query('update operator_session set revoked_at=coalesce(revoked_at,now()) where operator_id=$1', [target]);
      await this.audit(tx, actor, 'operator.disabled', stepUpId, { operatorId: target, reason: why });
      return this.load(tx, target);
    });
  }

  async activity(query: ActivityQuery): Promise<OperatorActivityContract> {
    const rows = await this.tx((tx) => this.activityRows(tx, query));
    return { entries: rows };
  }

  async activityCsv(query: ActivityQuery): Promise<string> {
    const rows = await this.tx((tx) => this.activityRows(tx, { ...query, limit: Math.min(query.limit, 5000) }));
    const header = ['at', 'operator', 'action', 'permission', 'requestId', 'issuer', 'subject', 'detail'];
    const lines = rows.map((row) => [row.at, row.operator, row.action, row.permission ?? '', row.requestId ?? '', row.issuer ?? '', row.subject ?? '', JSON.stringify(row.detail ?? null)].map(csvCell).join(','));
    return [header.join(','), ...lines].join('\n');
  }

  private async activityRows(tx: SqlExecutor, query: ActivityQuery): Promise<OperatorActivityEntryContract[]> {
    const action = query.action?.trim() || null;
    if (action && action.length > 120) throw new Error('The action filter is at most 120 characters.');
    const limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 5000) : 50;
    const rows = await tx.query<{
      id: string; at: Date; operator: string; action: string; permission: string | null; request_id: string | null;
      issuer: string | null; subject: string | null; detail: unknown;
    }>(
      `select id::text, at, operator, action, permission, request_id, issuer, subject, detail
         from platform_audit
        where ($1::text is null or action = $1 or permission = $1)
          and ($2::text is null or operator ilike $2 escape '\\' or action ilike $2 escape '\\' or coalesce(display_snapshot, '') ilike $2 escape '\\')
          and ($3::timestamptz is null or at >= $3)
          and ($4::timestamptz is null or at < $4)
        order by at desc, id desc
        limit $5`,
      [action, like(query.q), moment(query.from, 'from'), moment(query.to, 'to'), limit],
    );
    return rows.map((row) => ({
      id: row.id, at: iso(row.at)!, operator: row.operator, action: row.action, permission: row.permission,
      requestId: row.request_id, issuer: row.issuer, subject: row.subject, detail: row.detail,
    }));
  }

  private async replaceGrants(tx: SqlExecutor, id: string, actions: readonly OperatorActionContract[], actorId: string): Promise<void> {
    await tx.query(
      `update operator_grant set revoked_at=now(), revoked_by=$3
        where operator_id=$1 and revoked_at is null and not (action = any($2::text[]))`,
      [id, actions, actorId],
    );
    for (const action of actions) {
      await tx.query(
        `insert into operator_grant(operator_id, action, granted_by) values($1,$2,$3)
         on conflict(operator_id, action) do update set granted_at=now(), granted_by=$3, revoked_at=null, revoked_by=null`,
        [id, action, actorId],
      );
    }
  }

  private async load(tx: SqlExecutor, id: string): Promise<OperatorAccountContract> {
    const row = (await tx.query<{
      id: string; display_name: string; status: 'active' | 'disabled'; created_at: Date; disabled_at: Date | null;
      disabled_reason: string | null; identities: unknown; actions: string[] | null;
    }>(
      `select a.id, a.display_name, a.status, a.created_at, a.disabled_at, a.disabled_reason,
              coalesce(json_agg(distinct jsonb_build_object('issuer', i.issuer, 'subject', i.subject))
                filter (where i.operator_id is not null), '[]') as identities,
              coalesce(array_agg(distinct g.action) filter (where g.action is not null), '{}') as actions
         from operator_account a
         left join operator_identity i on i.operator_id = a.id
         left join operator_grant g on g.operator_id = a.id and g.revoked_at is null
        where a.id=$1
        group by a.id`,
      [id],
    ))[0];
    if (!row) throw notFound('There is no such operator.');
    return this.account(row);
  }

  private account(row: {
    id: string; display_name: string; status: 'active' | 'disabled'; created_at: Date; disabled_at: Date | null;
    disabled_reason: string | null; identities: unknown; actions: string[] | null;
  }): OperatorAccountContract {
    const actions = (row.actions ?? []).filter((action): action is OperatorActionContract => (OPERATOR_ACTIONS as readonly string[]).includes(action));
    return {
      id: row.id, displayName: row.display_name, status: row.status, createdAt: iso(row.created_at)!,
      disabledAt: iso(row.disabled_at), disabledReason: row.disabled_reason, identities: identitiesOf(row.identities), actions,
    };
  }

  private async audit(tx: SqlExecutor, actor: OperatorActor, action: string, stepUpId: string, detail: unknown): Promise<void> {
    await tx.query(
      `insert into platform_audit(operator, operator_account_id, display_snapshot, action, detail, issuer, subject, permission, auth_time, assurance, amr, acr, operator_session_id, step_up_id)
       values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::timestamptz,'mfa',$10,$11,$12,$13)`,
      [actor.display, actor.operatorId, actor.display, action, JSON.stringify(detail), actor.issuer, actor.subject, 'operators', actor.authTime, actor.amr, actor.acr ?? null, actor.sessionId, stepUpId],
    );
  }
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
