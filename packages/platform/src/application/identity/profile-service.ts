import type { PersonOption } from './people-service.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { likePattern } from '../../runtime/definitions/list-params.js';
import { can, demand } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { ProfileStore } from './ports/profile-store.js';

const PICK_MAX = 50;

/** Active members for a person field's picker, for anyone who can edit a person field somewhere. */
export class ProfileService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: ProfileStore,
    private readonly defs: DefinitionService,
  ) {}

  async pick(ctx: TenantContext, query: { q?: unknown; limit?: unknown }): Promise<{ items: PersonOption[] }> {
    const types = (await this.defs.list(ctx.tenantId, 'recordType')).map((t) => t.body);
    const allowed = types.some(
      (t) => t.fields.some((f) => f.type === 'person') && (can(ctx.actor, `record:${t.key}:create`) || can(ctx.actor, `record:${t.key}:update`)),
    );
    if (!allowed && !can(ctx.actor, 'members:manage')) demand(ctx.actor, 'people:read');
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 20, 1), PICK_MAX);
    const pattern = likePattern(q);
    const rows = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.pickable(tx, { q, pattern, limit }));
    return { items: rows };
  }
}
