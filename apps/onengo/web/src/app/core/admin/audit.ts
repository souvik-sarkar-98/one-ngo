import type { ParamReader } from '../address';
import { t } from '../i18n/i18n';
import { PagedController } from '../paging/paged-controller';
import type { FilterPill } from '../records/record/present';
import type { AdminGateway, AuditEntry } from './admin';
import { ADMIN_PAGE, AUDIT_AREAS, auditKey, auditParams, parseAuditAddress, type AuditAddress } from './address';
import type { Navigate } from './roles';

export interface AuditFilterValues {
  person?: string;
  area?: string;
  recordType?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * The audit log (`/admin/audit` plus filter parameters): read-only, newest
 * first, filtered by person (including API keys), area, record type and date.
 * People seen so far are offered in the person filter.
 */
export class AuditSession {
  readonly controller: PagedController<AuditEntry, AuditAddress>;
  /** Who acted in the entries seen so far, by actor id. */
  readonly actors = new Map<string, string>();
  private current: AuditAddress = parseAuditAddress(() => null);
  private readonly listeners = new Set<(a: AuditAddress) => void>();

  constructor(
    gateway: AdminGateway,
    private readonly nav: Navigate,
  ) {
    this.controller = new PagedController({
      key: auditKey,
      show: (a) => a.show,
      load: (a, offset, limit) =>
        gateway.audit({ person: a.person, area: a.area, recordType: a.recordType, from: a.date?.from, to: a.date?.to, offset, limit }),
      id: (e) => String(e.id),
      get failure() {
        return t('ui.common.loadFailed');
      },
    });
    this.controller.subscribe((s) => {
      for (const e of s.items) if (e.actorId) this.actors.set(e.actorId, e.actorName ?? e.actorId);
    });
  }

  get state(): AuditAddress {
    return this.current;
  }

  onState(fn: (a: AuditAddress) => void): () => void {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  }

  async fromUrl(get: ParamReader): Promise<void> {
    this.current = parseAuditAddress(get);
    for (const fn of this.listeners) fn(this.current);
    await this.controller.sync(this.current);
  }

  private go(next: AuditAddress): void {
    this.nav.navigate(auditParams(next), true);
  }

  applyFilters(v: AuditFilterValues): void {
    const date = v.dateFrom || v.dateTo ? { ...(v.dateFrom && { from: v.dateFrom }), ...(v.dateTo && { to: v.dateTo }) } : undefined;
    this.go({ person: v.person || undefined, area: v.area || undefined, recordType: v.recordType || undefined, date, show: ADMIN_PAGE });
  }

  removeFilter(key: string): void {
    this.go({ ...this.current, [key]: undefined, show: ADMIN_PAGE });
  }

  clearFilters(): void {
    this.applyFilters({});
  }

  loadMore(): void {
    const r = this.controller.snapshot;
    if (r.hasMore && !r.loading && !r.loadingMore && !r.error) this.go({ ...this.current, show: Math.max(this.current.show, r.items.length) + ADMIN_PAGE });
  }

  filterValues(): AuditFilterValues {
    const a = this.current;
    return { person: a.person, area: a.area, recordType: a.recordType, dateFrom: a.date?.from, dateTo: a.date?.to };
  }

  /** The filter choices: people seen so far (and the chosen one), areas, and the record types given. */
  options(recordTypes: { key: string; label: string }[]) {
    const people = new Map(this.actors);
    if (this.current.person && !people.has(this.current.person)) people.set(this.current.person, this.current.person);
    return {
      person: [...people].map(([key, label]) => ({ key, label })),
      area: AUDIT_AREAS.map((key) => ({ key, label: t(`ui.admin.audit.area.${key}`) })),
      recordType: recordTypes,
    };
  }

  pills(recordTypes: { key: string; label: string }[]): FilterPill[] {
    const o = this.options(recordTypes);
    const a = this.current;
    const name = (list: { key: string; label: string }[], v: string) => list.find((x) => x.key === v)?.label ?? v;
    const out: FilterPill[] = [];
    if (a.person) out.push({ id: 'person', label: `${t('ui.admin.audit.person')}: ${name(o.person, a.person)}` });
    if (a.area) out.push({ id: 'area', label: `${t('ui.admin.audit.col.area')}: ${name(o.area, a.area)}` });
    if (a.recordType) out.push({ id: 'recordType', label: `${t('ui.admin.audit.recordType')}: ${name(o.recordType, a.recordType)}` });
    if (a.date) out.push({ id: 'date', label: `${t('ui.admin.audit.date')}: ${[a.date.from ?? '…', a.date.to ?? '…'].join(' – ')}` });
    return out;
  }
}
