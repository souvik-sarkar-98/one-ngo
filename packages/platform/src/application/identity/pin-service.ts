import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { can } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { PinRow, PinStore } from '../../domain/identity/ports/pin-store.js';

export interface Pin {
  id: string;
  label: string;
  listView: string;
  address: string;
  position: number;
}

export interface PinInput {
  label?: unknown;
  listView?: unknown;
  address?: unknown;
}

const MAX_PINS = 20;
const MAX_LABEL = 80;
const MAX_ADDRESS = 2000;
/** A record list inside the app; the query string keeps the list's chip, search, filters and sort. */
const LIST_ADDRESS = /^\/records\/([A-Za-z][\w-]{0,63})(\?[^#\s]*)?$/;
const KEY = /^[A-Za-z][\w-]{0,63}$/;

const toPin = (r: PinRow): Pin => ({ id: r.id, label: r.label, listView: r.list_view, address: r.address, position: r.position });

/**
 * Lists a person has pinned to their own Home. Each pin is the address of a
 * record list the person may read; the list itself is queried as usual, so
 * a pin never shows more than the list would.
 */
export class PinService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: PinStore,
  ) {}

  async list(ctx: TenantContext): Promise<Pin[]> {
    const rows = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.list(tx, ctx.actor.id));
    return rows.map(toPin);
  }

  async add(ctx: TenantContext, input: PinInput): Promise<Pin> {
    const issues: FieldIssue[] = [];
    const label = this.label(input.label, issues);
    const listView = typeof input.listView === 'string' && KEY.test(input.listView) ? input.listView : '';
    if (!listView) issues.push({ path: '/listView', message: 'Name the list view.' });
    const address = typeof input.address === 'string' ? input.address : '';
    const type = address.length <= MAX_ADDRESS ? LIST_ADDRESS.exec(address)?.[1] : undefined;
    if (!type) issues.push({ path: '/address', message: 'Only record lists of this app can be pinned.' });
    if (issues.length) throw validationFailed('The pin is not valid.', issues);
    if (!can(ctx.actor, `record:${type}:read`)) throw forbidden('You cannot see this list.');
    const row = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if ((await this.store.count(tx, ctx.actor.id)) >= MAX_PINS) throw validationFailed(`You can pin up to ${MAX_PINS} lists. Unpin one first.`);
      return this.store.add(tx, ctx.actor.id, { label, listView, address });
    });
    if (!row) throw forbidden('Only members of the organisation can pin lists.');
    return toPin(row);
  }

  async rename(ctx: TenantContext, id: string, label: unknown): Promise<Pin> {
    const issues: FieldIssue[] = [];
    const name = this.label(label, issues);
    if (issues.length) throw validationFailed('The pin is not valid.', issues);
    const row = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.rename(tx, ctx.actor.id, id, name));
    if (!row) throw notFound('Pin not found.');
    return toPin(row);
  }

  /** Puts the person's pins in the order given; pins left out keep their place after the ones named. */
  async reorder(ctx: TenantContext, ids: unknown): Promise<Pin[]> {
    if (!Array.isArray(ids) || ids.length > MAX_PINS * 2 || ids.some((x) => typeof x !== 'string')) {
      throw validationFailed('Send the pins in their new order.', [{ path: '/ids', message: 'must be a list of pin ids' }]);
    }
    const mine = await this.list(ctx);
    const order = [...new Set(ids as string[])].filter((id) => mine.some((p) => p.id === id));
    const next = [...order, ...mine.map((p) => p.id).filter((id) => !order.includes(id))];
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      for (const [position, id] of next.entries()) await this.store.move(tx, ctx.actor.id, id, position);
    });
    return this.list(ctx);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const gone = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.remove(tx, ctx.actor.id, id));
    if (!gone) throw notFound('Pin not found.');
  }

  private label(value: unknown, issues: FieldIssue[]): string {
    const label = typeof value === 'string' ? value.trim() : '';
    if (!label) issues.push({ path: '/label', message: 'Give the pin a name.' });
    else if (label.length > MAX_LABEL) issues.push({ path: '/label', message: `Use at most ${MAX_LABEL} characters.` });
    return label;
  }
}
