import type { ParamReader, Params, Sort } from '../address';
import { t } from '../i18n/i18n';
import { PagedController, type PagedSnapshot } from '../paging/paged-controller';
import { asGatewayError } from '../records/gateway/gateway';
import { NO_SELECTION, pageTicked, startSelecting, toggled, toggledPage, type Selection } from '../records/bulk/selection';
import {
  PAGE_SIZE,
  parsePeopleAddress,
  patchPeople,
  peopleKey,
  peopleParams,
  peoplePushes,
  type PeopleAddress,
  type PeopleChange,
  type PeopleVariant,
  type StatusChip,
} from './address';
import type { AddPersonInput, MemberStatus, PeopleListGateway, PeoplePage, PeopleQuery, PersonItem } from './people';

export type PeopleSnapshot = PagedSnapshot<PersonItem>;
export type PeopleMeta = Omit<PeoplePage, 'items' | 'total'>;

export interface PeopleNavigator {
  /** Writes the People parameters to the address bar; `replace` keeps the current history entry. */
  navigate(params: Params, replace: boolean): void;
}

export interface PeopleResult {
  ok: boolean;
  message: string;
}

export type BulkPeopleOperation = 'addRole' | 'removeRole' | 'resend' | 'suspend';

const STATUS_FILTER: Record<StatusChip, MemberStatus[] | undefined> = { active: ['active'], invited: ['invited'], suspended: ['suspended'], all: undefined };

/** The query for one page of the list. */
export function peopleQuery(a: PeopleAddress, variant: PeopleVariant, offset: number, limit: number): PeopleQuery {
  return {
    ...(a.q && { q: a.q }),
    ...(a.role.length && { role: a.role }),
    ...(variant === 'management' && STATUS_FILTER[a.status] && { status: STATUS_FILTER[a.status] }),
    ...(a.sort && { sort: a.sort.field, dir: a.sort.dir }),
    offset,
    limit,
  };
}

/**
 * The People screen, independent of how it is drawn, in one of two variants
 * chosen by the route: the read-only directory (`people:read`) or management
 * (`members:manage`). State is read from the address bar and every intent
 * becomes an address change. Only management has status chips, selection and
 * changes to people; the directory refuses them without asking the server.
 */
export class PeopleSession {
  readonly controller: PagedController<PersonItem, PeopleAddress>;
  private current: PeopleAddress;
  private info: PeopleMeta = { roles: [] };
  private chosen: Selection = NO_SELECTION;
  private readonly listeners = new Set<(a: PeopleAddress) => void>();
  private readonly metaListeners = new Set<(m: PeopleMeta) => void>();
  private readonly selectionListeners = new Set<(s: Selection) => void>();

  constructor(
    readonly variant: PeopleVariant,
    private readonly gateway: PeopleListGateway,
    private readonly nav: PeopleNavigator,
  ) {
    this.current = parsePeopleAddress(() => null, variant);
    this.controller = new PagedController({
      key: (a) => peopleKey(a, variant),
      show: (a) => a.show,
      load: async (a, offset, limit) => this.use(await this.fetch(peopleQuery(a, variant, offset, limit))),
      id: (p) => p.userId,
      get failure() {
        return t('ui.people.loadFailed');
      },
    });
  }

  get state(): PeopleAddress {
    return this.current;
  }

  get rows(): PeopleSnapshot {
    return this.controller.snapshot;
  }

  get meta(): PeopleMeta {
    return this.info;
  }

  get selection(): Selection {
    return this.chosen;
  }

  get manages(): boolean {
    return this.variant === 'management';
  }

  onState(fn: (a: PeopleAddress) => void): () => void {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  }

  onMeta(fn: (m: PeopleMeta) => void): () => void {
    this.metaListeners.add(fn);
    fn(this.info);
    return () => this.metaListeners.delete(fn);
  }

  onSelection(fn: (s: Selection) => void): () => void {
    this.selectionListeners.add(fn);
    fn(this.chosen);
    return () => this.selectionListeners.delete(fn);
  }

  /** Reads the address. `names` are the parameters present. */
  async fromUrl(get: ParamReader, _names: readonly string[] = []): Promise<void> {
    this.current = parsePeopleAddress(get, this.variant);
    for (const fn of this.listeners) fn(this.current);
    await this.controller.sync(this.current);
  }

  /** Applies a change through the address bar. */
  go(change: PeopleChange, replace = false): void {
    const next = patchPeople(this.current, change);
    this.nav.navigate(peopleParams(next, this.variant), replace || !peoplePushes(this.current, next));
  }

  // ------------------------------------------------------------- intents

  selectChip(status: string): void {
    if (!this.manages || status === this.current.status) return;
    this.clearSelection();
    this.go({ status: status as StatusChip });
  }

  search(q: string): void {
    if (q.trim() !== this.current.q) this.go({ q: q.trim() });
  }

  /** The Role filter. */
  applyFilters(values: Record<string, string[]>): void {
    this.go({ role: values['role'] ?? [] });
  }

  removeFilter(key: string): void {
    if (key === 'role') this.go({ role: [] });
  }

  clearFilters(): void {
    this.go({ role: [] });
  }

  setSort(sort: Sort | undefined): void {
    this.go({ sort });
  }

  /** Ascending, then descending, then the default. */
  toggleSort(field: string): void {
    const s = this.current.sort;
    this.setSort(s?.field !== field ? { field, dir: 'asc' } : s.dir === 'asc' ? { field, dir: 'desc' } : undefined);
  }

  loadMore(): void {
    const r = this.rows;
    if (!r.hasMore || r.loading || r.loadingMore || r.error) return;
    this.go({ show: Math.max(this.current.show, r.items.length) + PAGE_SIZE });
  }

  retry(): Promise<void> {
    return this.controller.retry();
  }

  open(userId: string): void {
    if (this.chosen.selecting && this.manages) return this.check(userId);
    this.go({ person: userId, add: false });
  }

  close(): void {
    this.go({ person: undefined, add: false });
  }

  openAdd(): void {
    if (this.manages) this.go({ add: true, person: undefined });
  }

  /** A person as loaded in the list; administrators get them from the server when the list does not have them. */
  async person(userId: string): Promise<PersonItem | undefined> {
    const row = this.rows.items.find((p) => p.userId === userId);
    if (row || !this.manages) return row;
    return this.gateway.member(userId);
  }

  // ------------------------------------------------------------ selection

  check(userId: string): void {
    if (this.manages) this.select(toggled(this.chosen, userId, this.loadedIds()));
  }

  checkPage(): void {
    if (this.manages) this.select(toggledPage(this.chosen, this.loadedIds()));
  }

  /** A long press on a card starts selecting with that person ticked. */
  press(userId: string): void {
    if (!this.manages) return;
    this.select(startSelecting(this.chosen));
    if (!this.chosen.ids.includes(userId)) this.check(userId);
  }

  startSelecting(): void {
    if (this.manages) this.select(startSelecting(this.chosen));
  }

  clearSelection(): void {
    this.select(NO_SELECTION);
  }

  pageTicked(): 'none' | 'some' | 'all' {
    return pageTicked(this.chosen, this.loadedIds());
  }

  // -------------------------------------------------------------- changes

  /** Adds a person; the list then shows the Invited chip with them at the top. */
  async add(input: AddPersonInput): Promise<PeopleResult & { userId?: string; issues?: { path: string; message: string }[] }> {
    if (!this.manages) return this.refused();
    try {
      const { userId } = await this.gateway.add(input);
      this.go({ add: false, status: 'invited' });
      const message = t(input.invite ? 'ui.people.addedInvited' : 'ui.people.added', { name: input.displayName || input.email });
      return { ok: true, message, userId };
    } catch (e) {
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      return { ok: false, message: err.message, issues: err.issues };
    }
  }

  resend(userId: string): Promise<PeopleResult> {
    return this.change(userId, async () => {
      await this.gateway.invite(userId);
      return null;
    }, 'ui.people.resent');
  }

  suspend(userId: string): Promise<PeopleResult> {
    return this.change(userId, () => this.gateway.suspend(userId), 'ui.people.suspended');
  }

  reactivate(userId: string): Promise<PeopleResult> {
    return this.change(userId, () => this.gateway.reactivate(userId), 'ui.people.reactivated');
  }

  /** Replaces a person's roles; the server refuses a change that would leave nobody able to manage roles. */
  setRoles(userId: string, roles: string[]): Promise<PeopleResult> {
    return this.change(userId, () => this.gateway.setRoles(userId, roles), 'ui.people.rolesSaved');
  }

  /** Runs an operation for every ticked person, one at a time; the result counts those done and names the first refusal. */
  async bulk(op: BulkPeopleOperation, role?: string): Promise<PeopleResult> {
    if (!this.manages) return this.refused();
    const ids = [...this.selectedIds()];
    if (!ids.length || ((op === 'addRole' || op === 'removeRole') && !role)) return { ok: false, message: t('ui.people.chooseRole') };
    let done = 0;
    const problems: string[] = [];
    if (op === 'addRole') {
      try {
        await this.gateway.addToRole(role!, ids);
        done = ids.length;
      } catch (e) {
        problems.push(asGatewayError(e, t('ui.common.somethingWentWrong')).message);
      }
    } else {
      for (const id of ids) {
        const p = this.rows.items.find((x) => x.userId === id);
        try {
          if (op === 'removeRole') {
            if (!p?.roles.includes(role!)) continue;
            await this.gateway.removeFromRole(role!, id);
          } else if (op === 'resend') await this.gateway.invite(id);
          else await this.gateway.suspend(id);
          done++;
        } catch (e) {
          problems.push(`${p?.displayName ?? id}: ${asGatewayError(e, t('ui.common.somethingWentWrong')).message}`);
        }
      }
    }
    this.clearSelection();
    await this.controller.reload();
    const summary = t('ui.bulk.done', { count: done });
    return problems.length ? { ok: false, message: [summary, t('ui.bulk.failed', { count: problems.length }), problems[0]].join(' · ') } : { ok: true, message: summary };
  }

  selectedIds(): string[] {
    return this.chosen.all ? this.loadedIds() : [...this.chosen.ids];
  }

  // ------------------------------------------------------------ internals

  private async change(userId: string, run: () => Promise<PersonItem | null>, done: string): Promise<PeopleResult> {
    if (!this.manages) return this.refused();
    const before = this.rows.items.find((p) => p.userId === userId);
    try {
      const after = await run();
      if (after) this.controller.replaceRow(after);
      void this.controller.reload();
      return { ok: true, message: t(done, { name: after?.displayName ?? before?.displayName ?? '' }) };
    } catch (e) {
      return { ok: false, message: asGatewayError(e, t('ui.common.somethingWentWrong')).message };
    }
  }

  private refused(): PeopleResult {
    return { ok: false, message: t('ui.people.readOnly') };
  }

  private fetch(q: PeopleQuery): Promise<PeoplePage> {
    return this.variant === 'directory' ? this.gateway.directory(q) : this.gateway.members(q);
  }

  private use(page: PeoplePage): PeoplePage {
    const { items: _items, total: _total, ...meta } = page;
    this.info = { roles: meta.roles ?? [], ...(this.manages && meta.counts ? { counts: meta.counts } : {}) };
    for (const fn of this.metaListeners) fn(this.info);
    return page;
  }

  private loadedIds(): string[] {
    return this.rows.items.map((p) => p.userId);
  }

  private select(s: Selection): void {
    this.chosen = s;
    for (const fn of this.selectionListeners) fn(s);
  }
}
