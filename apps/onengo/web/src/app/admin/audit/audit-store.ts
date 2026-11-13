import { Injectable, computed, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AuditEntry } from '../../core/admin/admin';
import type { AuditAddress } from '../../core/admin/address';
import { AuditSession } from '../../core/admin/audit';
import { t } from '../../core/i18n/i18n';
import type { PagedSnapshot } from '../../core/paging/paged-controller';
import type { FormValues } from '../../core/records/record/forms';
import { plural } from '../../core/shell/shell';
import type { CfFieldDef } from '../../ui/cf-types';
import { AdminBase } from '../admin-store';
import { auditColumns, auditRow } from '../rows';

const EMPTY: PagedSnapshot<AuditEntry> = { items: [], total: 0, loading: true, loadingMore: false, hasMore: false, error: '' };

/** The audit log (`/admin/audit` plus filter parameters): read-only; a row with a record opens it. */
@Injectable()
export class AuditStore extends AdminBase {
  readonly audit = new AuditSession(this.gateway, this.nav);
  readonly state = signal<AuditAddress>(this.audit.state);
  readonly rows = signal<PagedSnapshot<AuditEntry>>(EMPTY);
  readonly filtersOpen = signal(false);
  private readonly types = computed(() => (this.session.defs()?.recordTypes ?? []).map((x) => ({ key: x.key, label: plural(x) })));
  readonly columns = computed(() => {
    this.i18n.locale();
    return auditColumns();
  });
  readonly rowViews = computed(() => {
    this.i18n.locale();
    const now = new Date();
    const label = (key: string) => this.types().find((x) => x.key === key)?.label ?? key;
    return this.rows()
      .items.map((e) => auditRow(e, label, now))
      .filter((r) => this.matches(r.title, r.subtitle));
  });
  readonly pills = computed(() => {
    this.state();
    this.rows();
    this.i18n.locale();
    return this.audit.pills(this.types());
  });
  readonly filterFields = computed<CfFieldDef[]>(() => {
    this.rows();
    this.i18n.locale();
    const o = this.audit.options(this.types());
    const select = (key: string, label: string, options: { key: string; label: string }[]): CfFieldDef => ({ key, label, type: 'select', required: false, readOnly: false, options });
    return [
      select('person', t('ui.admin.audit.person'), o.person),
      select('area', t('ui.admin.audit.col.area'), o.area),
      select('recordType', t('ui.admin.audit.recordType'), o.recordType),
      { key: 'date', label: t('ui.admin.audit.date'), type: 'date_range', required: false, readOnly: false, options: [] },
    ];
  });
  readonly filterValues = computed<FormValues>(() => {
    this.state();
    const v = this.audit.filterValues();
    return { person: v.person ?? '', area: v.area ?? '', recordType: v.recordType ?? '', dateFrom: v.dateFrom ?? '', dateTo: v.dateTo ?? '' };
  });

  constructor() {
    super();
    this.audit.onState((s) => this.state.set(s));
    this.audit.controller.subscribe((s) => this.rows.set(s));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => void this.audit.fromUrl((n) => p.get(n)));
  }

  applyFilters(v: FormValues): void {
    this.filtersOpen.set(false);
    const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
    this.audit.applyFilters({ person: s('person'), area: s('area'), recordType: s('recordType'), dateFrom: s('dateFrom'), dateTo: s('dateTo') });
  }

  clearFilters(): void {
    this.filtersOpen.set(false);
    this.audit.clearFilters();
  }

  /** A row about a record opens it in its list. */
  open(id: string): void {
    const e = this.rows().items.find((x) => String(x.id) === id);
    if (e?.recordType && e.entityId && this.session.recordType(e.recordType)) {
      this.go(`/records/${encodeURIComponent(e.recordType)}?id=${encodeURIComponent(e.entityId)}`);
    }
  }
}
