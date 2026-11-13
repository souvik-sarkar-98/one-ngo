import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { version } from '../../../package.json';
import { t } from '../core/i18n/i18n';
import { LANGUAGES, languageName } from '../core/i18n/languages';
import { organisationCode } from '../core/organisation/sign-in';
import { moreModel } from '../core/shell/shell';
import { ApiError } from '../services/api';
import { I18n } from '../services/i18n';
import { Session } from '../services/session';

export type MorePanel = 'language' | 'about';

/** The Settings screen's state and its Language and About panels, kept in `?panel=`. */
@Injectable()
export class MoreStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  readonly panel = signal<MorePanel | null>(null);
  readonly model = computed(() => {
    this.i18n.locale();
    return moreModel(this.session.me());
  });
  /** Profile details come from the signed-in session; an administrator changes them. */
  readonly email = computed(() => this.session.me()?.email ?? '');
  readonly organisation = computed(() => this.session.me()?.tenant.name ?? '');
  /** The signed-in organisation can be installed when its code is a sign-in code. */
  readonly canInstall = computed(() => !!organisationCode(this.session.me()?.tenant.key));
  readonly roles = computed(() => this.session.me()?.roles ?? []);
  /** Role names for the profile; a role the server did not name falls back to its key. */
  readonly roleNames = computed(() => {
    const me = this.session.me();
    return (me?.roles ?? []).map((key, i) => me?.roleNames?.[i] || key);
  });
  readonly languages = LANGUAGES;
  readonly locale = this.i18n.locale;
  readonly languageName = computed(() => languageName(this.i18n.locale()));
  readonly changingLanguage = signal(false);
  readonly languageError = signal('');
  readonly about = { version, server: location.host };

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const panel = p.get('panel');
      this.panel.set(panel === 'language' || panel === 'about' ? panel : null);
    });
  }

  open(link: string): void {
    void this.router.navigateByUrl(link);
  }

  openPanel(panel: MorePanel): void {
    this.languageError.set('');
    void this.router.navigate([], { relativeTo: this.route, queryParams: { panel } });
  }

  closePanel(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { panel: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Saves the language to the person's membership and redraws the app in it, without a reload. */
  async chooseLanguage(code: string): Promise<void> {
    if (code === this.locale()) return this.closePanel();
    this.changingLanguage.set(true);
    this.languageError.set('');
    try {
      await this.session.changeLanguage(code);
      this.closePanel();
    } catch (e) {
      this.languageError.set(e instanceof ApiError ? e.message : t('ui.more.languageFailed'));
    } finally {
      this.changingLanguage.set(false);
    }
  }
}
