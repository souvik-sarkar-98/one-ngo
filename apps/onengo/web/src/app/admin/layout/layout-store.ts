import { Injectable, computed, signal } from '@angular/core';
import { mayPublishLook } from '../../core/admin/areas';
import { addRecordItem, removeRecordItem, reorderItems, setItemIcon, startingLayout, toPublished, type LayoutDraft } from '../../core/admin/layout-draft';
import { failure } from '../../core/admin/roles';
import { t } from '../../core/i18n/i18n';
import { ICON_NAMES } from '@onengo/platform/icons';
import { navIcon } from '../../core/shell/shell';
import { AdminBase } from '../admin-store';

const NAMES: Record<string, string> = {
  home: 'ui.nav.home',
  records: 'ui.nav.records',
  inbox: 'ui.nav.inbox',
  reports: 'ui.nav.reports',
  admin: 'ui.crumbs.administration',
  builder: 'ui.nav.builder',
  guide: 'ui.nav.guide',
  settings: 'ui.nav.settings',
  signout: 'ui.shell.signOut',
};

/** The organisation's navigation order, icons and starting wide-screen list layout. */
@Injectable()
export class LayoutStore extends AdminBase {
  readonly iconChoices = ICON_NAMES;
  readonly draft = signal<LayoutDraft>(startingLayout(null, null));
  readonly saving = signal(false);
  readonly error = signal('');
  /** Publishing, discarding and removing need `config:publish` or `admin:settings`, as on the server. */
  readonly mayPublish = computed(() => mayPublishLook(this.session.me()?.capabilities));
  readonly canPublish = computed(() => this.mayPublish() && !this.saving());
  readonly recordChoices = computed(() => {
    this.i18n.locale();
    const placed = new Set(this.draft().items);
    return (this.session.defs()?.recordTypes ?? [])
      .filter((type) => !placed.has(`record:${type.key}`))
      .map((type) => ({ key: `record:${type.key}`, label: type.pluralLabel || type.label }));
  });

  constructor() {
    super();
    this.discard();
  }

  label(key: string): string {
    this.i18n.locale();
    const defs = this.session.defs();
    if (key.startsWith('record:')) {
      const type = defs?.recordTypes.find((item) => item.key === key.slice(7));
      return type ? type.pluralLabel || type.label : key;
    }
    if (key.startsWith('page:')) return defs?.pages?.find((page) => page.key === key.slice(5))?.label ?? key;
    return NAMES[key] ? t(NAMES[key]) : key;
  }

  icon(key: string): string {
    return navIcon(key, this.draft().icons);
  }

  removable(key: string): boolean {
    return key.startsWith('record:');
  }

  reorder(from: number, to: number): void {
    this.draft.update((draft) => reorderItems(draft, from, to));
  }

  addRecord(key: string): void {
    this.draft.update((draft) => addRecordItem(draft, key));
  }

  remove(key: string): void {
    this.draft.update((draft) => removeRecordItem(draft, key));
  }

  setIcon(key: string, icon: string): void {
    this.draft.update((draft) => setItemIcon(draft, key, icon));
  }

  listLayout(layout: 'cards' | 'table'): void {
    this.draft.update((draft) => ({ ...draft, listLayout: layout }));
  }

  discard(): void {
    this.draft.set(startingLayout(this.session.me(), this.session.defs()));
    this.error.set('');
  }

  async publish(): Promise<void> {
    if (!this.canPublish()) return;
    const draft = this.draft();
    this.saving.set(true);
    this.error.set('');
    try {
      await this.gateway.saveLayout(toPublished(draft));
      await this.session.reload();
      this.discard();
      this.show({ level: 'success', message: t('ui.admin.layout.published') });
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.saving.set(false);
    }
  }
}
