import { DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { httpAdmin } from '../core/admin/http-admin';
import type { AdminResult, Navigate } from '../core/admin/roles';
import type { Notice } from '../records/notice';
import { Api } from '../services/api';
import { I18n } from '../services/i18n';
import { ScreenMeta } from '../services/screen-meta';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';

/** What every Administration store shares: the gateway, the address bar, the notice and the layout. Only stores reach the router. */
export abstract class AdminBase {
  protected readonly router = inject(Router);
  protected readonly route = inject(ActivatedRoute);
  protected readonly session = inject(Session);
  protected readonly i18n = inject(I18n);
  protected readonly meta = inject(ScreenMeta);
  protected readonly gateway = httpAdmin(inject(Api));
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  readonly notice = signal<Notice | null>(null);
  readonly narrow = inject(Viewport).narrow;
  /** Cards on phones, a table on wider screens. */
  readonly layout = computed(() => (this.narrow() ? 'cards' : 'table'));
  /** Search text typed in the toolbar; these lists are short and filter what is loaded. */
  readonly filterText = signal('');

  protected readonly nav: Navigate = {
    navigate: (queryParams, replaceUrl) => void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl }),
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.noticeTimer);
      this.meta.clear();
    });
  }

  go(link: string): void {
    void this.router.navigateByUrl(link);
  }

  show(out: AdminResult | Notice): void {
    const n: Notice = 'level' in out ? out : { level: out.ok ? 'success' : 'error', message: out.message };
    if (!n.message) return;
    this.notice.set(n);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), n.level === 'error' ? 8000 : 4000);
  }

  /** Whether a row's text contains what was typed. */
  protected matches(...texts: (string | undefined)[]): boolean {
    const q = this.filterText().trim().toLocaleLowerCase();
    return !q || texts.some((x) => x?.toLocaleLowerCase().includes(q));
  }
}
