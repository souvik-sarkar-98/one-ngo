import { Component, computed, input, output, signal } from '@angular/core';
import type { Crumb } from '../core/shell/breadcrumbs';
import { t } from '../core/i18n/i18n';
import { opensInPlace } from '@onengo/web-kit';
import { withDefaults } from './labels';

const LABELS = () => ({ nav: t('ui.crumbs.nav'), showTrail: t('ui.crumbs.showTrail') });

type Shown = Crumb & { more?: true };

/**
 * The one breadcrumb line under the app bar. Wide screens show the whole
 * trail; narrow ones the first item, "…" (a menu with the full trail) and the
 * last. Links are followed by whoever owns the router.
 */
@Component({
  selector: 'app-breadcrumb',
  styleUrl: './styles/breadcrumb.css',
  template: `
    @if (crumbs().length) {
      <nav class="crumbs" [class.crumbs--compact]="compact()" [attr.aria-label]="labels().nav">
        <ol class="crumbs__list">
          @for (c of shown(); track $index; let last = $last) {
            <li class="crumbs__item" [class.crumbs__item--last]="last" [attr.aria-current]="last ? 'page' : null">
              @if (c.more) {
                <button type="button" class="crumbs__more" [attr.aria-label]="labels().showTrail" [attr.aria-expanded]="menuOpen()" (click)="menuOpen.set(!menuOpen())">…</button>
              } @else if (!last && c.href) {
                <a class="crumbs__link" [attr.href]="c.href" (click)="follow($event, c.href)">{{ c.label }}</a>
              } @else {
                <span class="crumbs__text" [attr.title]="last ? c.label : null">{{ c.label }}</span>
              }
            </li>
          }
        </ol>
        @if (menuOpen() && compact()) {
          <ul class="crumbs__menu">
            @for (c of crumbs().slice(0, -1); track $index) {
              <li>
                @if (c.href) {
                  <a class="crumbs__link" [attr.href]="c.href" (click)="follow($event, c.href)">{{ c.label }}</a>
                } @else {
                  <span>{{ c.label }}</span>
                }
              </li>
            }
          </ul>
        }
      </nav>
    }
  `,
})
export class Breadcrumb {
  readonly crumbs = input.required<Crumb[]>();
  /** Phone width: first · "…" · last. */
  readonly narrow = input(false);
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly navigate = output<string>();
  readonly menuOpen = signal(false);

  readonly compact = computed(() => this.narrow() && this.crumbs().length > 2);
  readonly shown = computed<Shown[]>(() => {
    const all = this.crumbs();
    return this.compact() ? [all[0]!, { label: '', more: true }, all[all.length - 1]!] : all;
  });

  follow(e: MouseEvent, href: string): void {
    this.menuOpen.set(false);
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.navigate.emit(href);
  }
}
