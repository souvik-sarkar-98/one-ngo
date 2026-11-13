import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { t } from '../core/i18n/i18n';
import type { FieldDef } from '../core/models';
import { httpPeople } from '../core/people/http-people';
import { peopleSource } from '../core/people/people';
import { BulkSession, type BulkSnapshot } from '../core/records/bulk/bulk-session';
import { exportQuery } from '../core/records/list/export';
import type { FieldModel, FormValues } from '../core/records/record/forms';
import { httpBulkGateway } from '../core/records/gateway/http-gateway';
import { recordTitle } from '../core/records/record/present';
import {
  allMatchingOffer,
  bulkOperations,
  bulkTarget,
  canSelect,
  isTicked,
  NO_SELECTION,
  selectAllMatching,
  selectedCount,
  selectedRecords,
  startSelecting,
  toggled,
  toggledPage,
  type BulkOperation,
  type Selection,
} from '../core/records/bulk/selection';
import { Api } from '../services/api';
import { Session } from '../services/session';
import { cfField, type CfFieldDef } from '../ui/cf-types';
import { ImportStore } from './import-store';
import { ListStore } from './list-store';

const model = (f: FieldDef): FieldModel => ({
  key: f.key,
  label: f.label,
  kind: f.type,
  required: !!f.required,
  readOnly: false,
  calculated: false,
  options: f.choices ?? [],
  help: f.help,
  min: f.min,
  max: f.max,
  maxLength: f.maxLength,
  referenceType: f.referenceType,
});

/**
 * The open list's selection and bulk operations: which rows are ticked,
 * what can be done to all of them, and the bulk panel's session. The
 * selection is not in the address and clears when the list changes; a
 * job's result opens from its notification (`?bulk=<job>`).
 */
@Injectable()
export class BulkStore {
  private readonly list = inject(ListStore);
  private readonly transfers = inject(ImportStore);
  private readonly app = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly gateway = httpBulkGateway(inject(Api));
  private readonly people = peopleSource(httpPeople(inject(Api)));
  private readonly current = signal<BulkSession | null>(null);
  private readonly jobParam = signal<string | null>(null);
  private detach: () => void = () => undefined;

  readonly selection = signal<Selection>(NO_SELECTION);
  readonly snapshot = signal<BulkSnapshot | null>(null);

  private readonly permissions = computed(() => this.app.me()?.permissions ?? []);
  private readonly loaded = computed(() => this.list.rows().items.map((r) => r.id));
  readonly enabled = computed(() => {
    const spec = this.list.spec();
    return !!spec && canSelect(this.permissions(), spec.type.key);
  });
  /** The ticked rows as both layouts draw them; null when the person cannot select. */
  readonly checked = computed<ReadonlySet<string> | null>(() => {
    if (!this.enabled()) return null;
    const s = this.selection();
    return new Set(s.all ? this.loaded() : s.ids);
  });
  /** Selection mode, the same in cards and tables: tick boxes show only after Select. */
  readonly selecting = computed(() => this.enabled() && this.selection().selecting);
  readonly count = computed(() => selectedCount(this.selection(), this.list.rows().total));
  /** The bulk bar shows while rows are ticked, and while selecting. */
  readonly showBar = computed(() => this.enabled() && (this.count() > 0 || this.selecting()));
  readonly offer = computed(() => allMatchingOffer(this.selection(), this.loaded(), this.list.rows().total));
  readonly total = computed(() => this.list.rows().total);
  readonly operations = computed<BulkOperation[]>(() => {
    const spec = this.list.spec();
    if (!spec) return [];
    return bulkOperations(spec, selectedRecords(this.selection(), this.list.rows().items), this.permissions(), this.list.viewer(), this.list.state()?.chip);
  });
  /** The list ⋮ entries: Select, then Select all while selecting. */
  readonly menu = computed(() => {
    if (!this.enabled()) return [];
    const disabled = this.list.rows().total === 0;
    return this.selecting()
      ? [{ id: 'selectAll', label: t('ui.bulk.selectAll'), disabled }]
      : [{ id: 'select', label: t('ui.bulk.select'), disabled }];
  });
  readonly open = computed(() => {
    const s = this.snapshot();
    return !!s && (!!s.op || !!s.job || !!s.summary || !!s.error);
  });
  readonly formFields = computed<CfFieldDef[]>(() => {
    const s = this.snapshot();
    const session = this.current();
    if (!s?.op || !session) return [];
    return session.fields().map((f) => {
      const cf = cfField(model(f));
      if (f.type !== 'person') return cf;
      const v = s.values[f.key];
      const text = typeof v === 'string' && v ? (s.titles[v] ?? '') : '';
      return { ...cf, picker: { source: this.people, text, choose: (o) => session.choose(f.key, o), clear: () => session.choose(f.key, null) } };
    });
  });

  constructor() {
    const listKey = computed(() => {
      const s = this.list.state();
      return JSON.stringify([this.list.spec()?.type.key, s?.chip, s?.q, s?.criteria, s?.sort]);
    });
    effect(() => {
      listKey();
      untracked(() => this.selection.set(NO_SELECTION));
    });
    effect(() => {
      const spec = this.list.spec();
      untracked(() => {
        this.detach();
        this.current()?.dispose();
        if (!spec) return this.current.set(null);
        const name = (id: string) => {
          const r = this.list.rows().items.find((x) => x.id === id);
          return r ? (r.number ?? recordTitle(spec, r)) : id;
        };
        const session = new BulkSession(this.gateway, spec, name, {
          finished: () => {
            this.selection.set(NO_SELECTION);
            void this.list.intents.controller.reload();
          },
        });
        this.detach = session.subscribe((s) => this.snapshot.set(s));
        this.current.set(session);
      });
    });
    effect(() => {
      const job = this.jobParam();
      const session = this.current();
      if (job && session) untracked(() => void session.follow(job));
    });
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => this.jobParam.set(p.get('bulk')));
    inject(DestroyRef).onDestroy(() => {
      this.detach();
      this.current()?.dispose();
    });
  }

  /** A list ⋮ entry; false when it is not one of the bulk entries. */
  chooseMenu(entry: string): boolean {
    if (entry === 'select') this.selection.update(startSelecting);
    else if (entry === 'selectAll') this.checkPage();
    else return false;
    return true;
  }

  check(id: string): void {
    this.selection.update((s) => toggled(s, id, this.loaded()));
  }

  /** A long-press on a card starts selecting with that row ticked. */
  press(id: string): void {
    this.selection.update((s) => (isTicked(s, id) ? startSelecting(s) : toggled(s, id, this.loaded())));
  }

  checkPage(): void {
    this.selection.update((s) => toggledPage(s, this.loaded()));
  }

  selectAllMatching(): void {
    this.selection.update((s) => selectAllMatching(s, this.loaded(), this.total()));
  }

  clear(): void {
    this.selection.set(NO_SELECTION);
  }

  /** Export runs at once; every other operation asks in the panel first. */
  run(op: BulkOperation): void {
    const s = this.selection();
    if (op.kind === 'export') void (s.all ? this.transfers.exportList() : this.transfers.exportSelected(s.ids));
    else this.current()?.open(op, this.count());
  }

  setValues(values: FormValues): void {
    this.current()?.setValues(values);
  }

  submit(): void {
    const spec = this.list.spec();
    const state = this.list.state();
    if (spec && state) void this.current()?.submit(bulkTarget(this.selection(), exportQuery(spec, state)));
  }

  stop(): void {
    void this.current()?.stop();
  }

  close(): void {
    this.current()?.close();
    if (this.jobParam()) void this.router.navigate([], { relativeTo: this.route, queryParams: { bulk: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
