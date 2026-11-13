import type { RuntimeService } from '../../runtime/definitions/runtime.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { RecordAggregates } from '../../runtime/records/aggregates.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { ApprovalService, ApprovalSortField } from '../../runtime/workflows/approval-service.js';
import { definitionKindOf, demand, notFound, type RequestContext } from '../shared/http-api.js';
import { recordQueryOf } from './record-query.js';

/** Creates a record of a type from what the person entered. */
export class CreateRecord {
  constructor(private readonly records: Pick<RecordService, 'create'>) {}

  run(ctx: RequestContext, type: string, input: Parameters<RecordService['create']>[2]) {
    return this.records.create(ctx, type, input);
  }
}

/** Changes a record's data; the person must have read the version they change. */
export class UpdateRecord {
  constructor(private readonly records: Pick<RecordService, 'update'>) {}

  run(ctx: RequestContext, id: string, input: Parameters<RecordService['update']>[2]) {
    return this.records.update(ctx, id, input);
  }
}

/** Moves a record along one step of its workflow. */
export class TransitionRecord {
  constructor(private readonly records: Pick<RecordService, 'transition'>) {}

  run(ctx: RequestContext, id: string, transition: string, input: { data?: Record<string, unknown>; expectedVersion: number }) {
    return this.records.transition(ctx, id, transition, input);
  }
}

/** One record the person is allowed to read. */
export class GetRecord {
  constructor(private readonly records: Pick<RecordService, 'get'>) {}

  run(ctx: RequestContext, id: string) {
    return this.records.get(ctx, id);
  }
}

/** The plain list of one record type: status and search text, paged. Counts arrive as text from the address. */
export class ListRecords {
  constructor(private readonly records: Pick<RecordService, 'list'>) {}

  run(ctx: RequestContext, type: string, q: { status?: string; q?: string; limit?: string; offset?: string }) {
    return this.records.list(ctx, type, {
      status: q.status,
      search: q.q,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  }
}

/** The filtered list with a total: only the known parts of the person's query are kept, each bounded. */
export class QueryRecords {
  constructor(private readonly records: Pick<RecordService, 'query'>) {}

  run(ctx: RequestContext, type: string, body: unknown) {
    return this.records.query(ctx, type, recordQueryOf(body));
  }
}

/** What a page widget asks to count or total. */
export type AggregateInput = Omit<Parameters<RecordAggregates['aggregate']>[2], 'sharedWithMe'> & {
  /** Only a true value narrows to the person's shares. */
  sharedWithMe?: boolean;
  /** The page widget asking; refused when the person cannot see it. */
  widget?: { page: string; index: number };
};

/** Counts and totals for pages, after checking the person may see the widget that asks. */
export class AggregateRecords {
  constructor(
    private readonly runtime: Pick<RuntimeService, 'assertWidgetVisible'>,
    private readonly aggregates: Pick<RecordAggregates, 'aggregate'>,
  ) {}

  async run(ctx: RequestContext, type: string, b: AggregateInput) {
    if (b.widget) await this.runtime.assertWidgetVisible(ctx, b.widget.page, b.widget.index);
    return this.aggregates.aggregate(ctx, type, {
      statusIn: b.statusIn?.slice(0, 50),
      owner: b.owner,
      sharedWithMe: b.sharedWithMe || undefined,
      filters: b.filters,
      states: b.states,
      measure: b.measure,
      field: b.field,
      groupBy: b.groupBy,
    });
  }
}

/** The approval a record is waiting on, once the person is known to be allowed to read the record. */
export class RecordApproval {
  constructor(
    private readonly records: Pick<RecordService, 'get'>,
    private readonly approvals: Pick<ApprovalService, 'pendingForRecord'>,
  ) {}

  async pending(ctx: RequestContext, recordId: string) {
    const record = await this.records.get(ctx, recordId);
    return { pending: await this.approvals.pendingForRecord(ctx, record.id) };
  }
}

/** A published definition of a kind named in an address, for someone who may read configuration; an unknown kind or key is a not-found answer. */
export class GetDefinition {
  constructor(private readonly definitions: Pick<DefinitionService, 'get'>) {}

  async run(ctx: RequestContext, kind: string, key: string) {
    demand(ctx.actor, 'config:read');
    const def = await this.definitions.get(ctx.tenantId, definitionKindOf(kind), key);
    if (!def) throw notFound('Definition not found.');
    return def;
  }
}

/** The approvals inbox search a person types: each list is bounded and the sort name is checked by the approvals themselves. */
export class QueryApprovals {
  constructor(private readonly approvals: Pick<ApprovalService, 'query'>) {}

  run(
    ctx: RequestContext,
    b: {
      search?: string;
      filters?: { type?: string[]; step?: string[]; requestedBy?: string[] };
      sort?: { field: string; dir?: 'asc' | 'desc' };
      limit?: number;
      offset?: number;
    },
  ) {
    const list = (v: string[] | undefined) => v?.slice(0, 50);
    const f = b.filters;
    return this.approvals.query(ctx, {
      search: b.search?.slice(0, 200),
      filters: f ? { type: list(f.type), step: list(f.step), requestedBy: list(f.requestedBy) } : undefined,
      sort: b.sort ? { field: b.sort.field as ApprovalSortField, dir: b.sort.dir ?? 'desc' } : undefined,
      limit: b.limit || undefined,
      offset: b.offset || undefined,
    });
  }
}
