import { Injectable, computed, inject, signal } from '@angular/core';
import { httpAccess, type ModuleReview, type ModuleRow } from '../../core/builder/http-access';
import { holds } from '../../core/builder/permission-grid';
import { t } from '../../core/i18n/i18n';
import { Api } from '../../services/api';
import { Session } from '../../services/session';
import { Viewport } from '../../ui/viewport';

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

/** Builder › Modules: turn ready-made modules on or off and review their updates. */
@Injectable()
export class ModulesStore {
  private readonly session = inject(Session);
  private readonly gateway = httpAccess(inject(Api));

  readonly narrow = inject(Viewport).narrow;
  readonly modules = signal<ModuleRow[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly review = signal<ModuleReview | null>(null);
  readonly canChange = computed(() => holds(this.session.me()?.permissions ?? [], 'config:modules') && !this.narrow());

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.modules.set(await this.gateway.modules());
    } catch (e) {
      this.error.set(messageOf(e, t('ui.common.loadFailed')));
    } finally {
      this.loading.set(false);
    }
  }

  async turnOn(m: ModuleRow): Promise<void> {
    await this.act(() => this.gateway.enableModule(m.key), t('ui.builder.modules.turnedOn', { name: m.label }));
  }

  async turnOff(m: ModuleRow): Promise<void> {
    await this.act(() => this.gateway.disableModule(m.key), t('ui.builder.modules.turnedOff', { name: m.label }));
  }

  async openReview(m: ModuleRow): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      this.review.set(await this.gateway.moduleUpdate(m.key));
    } catch (e) {
      this.error.set(messageOf(e, t('ui.common.loadFailed')));
    } finally {
      this.busy.set(false);
    }
  }

  closeReview(): void {
    this.review.set(null);
  }

  async update(): Promise<void> {
    const r = this.review();
    if (!r?.canUpdate) return;
    if (await this.act(() => this.gateway.enableModule(r.key), t('ui.builder.modules.updated', { name: r.label, version: r.version }))) this.review.set(null);
  }

  private async act(action: () => Promise<void>, done: string): Promise<boolean> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await action();
      this.message.set(done);
      await this.load();
      await this.session.reload();
      return true;
    } catch (e) {
      this.error.set(messageOf(e, t('ui.common.somethingWentWrong')));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
