import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { catalogueParams, nextSort, parseCatalogueAddress, type CatalogueAddress, type DefinitionState, type Origin } from '../core/builder/address';
import {
  BUILDER_SECTIONS,
  KIND_SEARCH_AT,
  catalogueRow,
  duplicateBody,
  filterCatalogue,
  kindChips,
  newDefinitionBody,
  rowId,
  type CatalogueAction,
} from '../core/builder/catalogue';
import { httpBuilder } from '../core/builder/http-builder';
import { toKey } from '../core/fields/fields';
import { t } from '../core/i18n/i18n';
import type { CatalogueItem, DefinitionKind } from '../core/models';
import type { RowView } from '../core/rows';
import { kindName } from '../core/starters';
import { Api } from '../services/api';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';

/** A definition being created: from a kind's starter, a ready-made record type, or a copy of another definition. */
export interface NewDefinition {
  kind: DefinitionKind;
  starter?: string;
  copyOf?: CatalogueItem;
}

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

/**
 * The Builder catalogue. The home is a directory of kinds; a kind's address
 * lists that kind, with search once the list is long. The only place the
 * catalogue reaches the router.
 */
@Injectable()
export class CatalogueStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly gateway = httpBuilder(inject(Api));
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  readonly narrow = inject(Viewport).narrow;
  readonly items = signal<CatalogueItem[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly address = signal<CatalogueAddress>({ q: '', from: [], state: [] });
  /** `all`, or one of BUILDER_SECTIONS. Kept in `?section=`. */
  readonly section = signal('all');
  /** Search text as typed; the address follows 300 ms after typing stops. */
  readonly searchText = signal('');
  readonly filtersOpen = signal(false);
  readonly creating = signal<NewDefinition | null>(null);
  readonly createError = signal('');
  readonly busy = signal(false);

  readonly canPublish = computed(() => !!this.session.me()?.capabilities.publish);
  readonly scoped = computed(() => {
    const section = BUILDER_SECTIONS.find((s) => s.id === this.section());
    const items = this.items();
    return section ? items.filter((i) => section.kinds.includes(i.kind)) : items;
  });
  readonly visible = computed(() => filterCatalogue(this.scoped(), this.address()));
  readonly rows = computed(() => this.visible().map((i) => catalogueRow(i, this.canPublish())));
  readonly showKindSearch = computed(() => {
    const kind = this.address().kind;
    if (!kind) return false;
    return this.items().filter((item) => item.kind === kind).length > KIND_SEARCH_AT;
  });
  /** Kind chips for the open section. All shows the whole list, so it has no chip row. */
  readonly chips = computed(() => {
    const section = BUILDER_SECTIONS.find((s) => s.id === this.section());
    if (!section) return [];
    const kinds = new Set<string>(section.kinds);
    return kindChips(this.scoped()).filter((chip) => chip.id === 'all' || kinds.has(chip.id));
  });
  readonly sectionCounts = computed(() => {
    const items = this.items();
    const count = (kinds: readonly string[]) => items.filter((i) => kinds.includes(i.kind)).length;
    return {
      all: items.length,
      ...Object.fromEntries(BUILDER_SECTIONS.map((s) => [s.id, count(s.kinds)])),
    } as Record<string, number>;
  });
  readonly recordTypes = computed(() => this.items().filter((i) => i.kind === 'recordType' && i.publishedVersion));
  readonly pills = computed(() => {
    const a = this.address();
    return [
      ...a.from.map((o) => ({ id: `from:${o}`, label: t(`ui.builder.catalogue.origin.${o}`) })),
      ...a.state.map((s) => ({ id: `state:${s}`, label: t(`ui.builder.catalogue.stateFilter.${s}`) })),
    ];
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const a = parseCatalogueAddress((n) => p.get(n));
      this.address.set(a);
      const section = p.get('section') ?? '';
      this.section.set(BUILDER_SECTIONS.some((s) => s.id === section) ? section : 'all');
      if (this.searchTimer === undefined) this.searchText.set(a.q);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.items.set(await this.gateway.catalogue());
      this.consumeCopy();
    } catch (e) {
      this.error.set(messageOf(e, t('ui.builder.loadFailed')));
    } finally {
      this.loading.set(false);
    }
  }

  selectKind(id: string): void {
    this.replace({ kind: id === 'all' ? undefined : (id as DefinitionKind) });
  }

  selectSection(id: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...catalogueParams({ kind: undefined }), section: id === 'all' ? null : id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  search(text: string): void {
    this.searchText.set(text);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.replace({ q: text });
    }, 300);
  }

  toggleSort(field: string): void {
    this.replace({ sort: nextSort(this.address().sort, field) });
  }

  applyFilters(values: Record<string, unknown>): void {
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    this.filtersOpen.set(false);
    this.replace({ from: list(values['from']) as Origin[], state: list(values['state']) as DefinitionState[] });
  }

  removeFilter(id: string): void {
    const [group, value] = id.split(':');
    const a = this.address();
    if (group === 'from') this.replace({ from: a.from.filter((o) => o !== value) });
    else this.replace({ state: a.state.filter((s) => s !== value) });
  }

  clearFilters(): void {
    this.filtersOpen.set(false);
    this.replace({ from: [], state: [] });
  }

  goTo(href: string): void {
    void this.router.navigateByUrl(href);
  }

  open(row: { id: string }, tab?: string): void {
    const item = this.items().find((i) => rowId(i) === row.id);
    if (item) void this.router.navigate(['/builder', item.kind, item.key], tab ? { queryParams: { tab } } : {});
  }

  /** The row menu. Reverting and deleting a draft are confirmed by the screen first. */
  async runRowAction(row: RowView, action: CatalogueAction): Promise<void> {
    const item = this.items().find((i) => rowId(i) === row.id);
    if (!item) return;
    if (action === 'open') return this.open(row);
    if (action === 'history') return this.open(row, 'history');
    if (action === 'duplicate') return this.startNew({ kind: item.kind, copyOf: item });
    await this.act(async () => {
      if (action === 'deleteDraft') await this.gateway.discard(item.kind, item.key);
      if (action === 'revert') {
        const patch = (await this.gateway.detail(item.kind, item.key)).shipped?.patch;
        if (patch && JSON.stringify(patch) !== '{}') await this.gateway.savePatch(item.kind, item.key, {});
      }
    });
  }

  startNew(next: NewDefinition): void {
    this.createError.set('');
    this.creating.set(next);
  }

  cancelNew(): void {
    this.creating.set(null);
  }

  /** Saves the first draft of the new definition, then opens it. */
  async create(name: string, recordType: string): Promise<void> {
    const next = this.creating();
    const key = toKey(name);
    if (!next || !key) return this.createError.set(t('ui.builder.catalogue.nameRequired'));
    if (this.items().some((i) => i.kind === next.kind && i.key === key)) {
      return this.createError.set(t('ui.builder.exists', { kind: kindName(next.kind).toLowerCase(), key }));
    }
    this.busy.set(true);
    this.createError.set('');
    try {
      const body = next.copyOf
        ? duplicateBody(next.kind, await this.sourceBody(next.copyOf), key, name)
        : newDefinitionBody(next.kind, key, name, { recordType, ...(next.starter && { starter: next.starter }) });
      await this.gateway.saveDraft(next.kind, key, body);
      this.creating.set(null);
      await this.router.navigate(['/builder', next.kind, key]);
    } catch (e) {
      this.createError.set(messageOf(e, t('ui.common.somethingWentWrong')));
    } finally {
      this.busy.set(false);
    }
  }

  private async sourceBody(item: CatalogueItem): Promise<Record<string, unknown>> {
    const d = await this.gateway.detail(item.kind, item.key);
    return d.draft?.body ?? d.published?.body ?? {};
  }

  private async act(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      await this.load();
      await this.session.reload();
    } catch (e) {
      this.error.set(messageOf(e, t('ui.common.somethingWentWrong')));
    } finally {
      this.busy.set(false);
    }
  }

  /** `?copy=` opens the existing create sheet for that definition, then leaves the address. */
  private consumeCopy(): void {
    const copy = this.route.snapshot.queryParamMap.get('copy');
    const kind = this.address().kind;
    if (!copy || !kind || !this.canPublish() || this.narrow()) return;
    const item = this.items().find((i) => i.kind === kind && i.key === copy);
    if (!item) return;
    this.startNew({ kind, copyOf: item });
    void this.router.navigate([], { relativeTo: this.route, queryParams: { copy: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  private replace(change: Partial<CatalogueAddress>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: catalogueParams(change), queryParamsHandling: 'merge', replaceUrl: true });
  }
}
