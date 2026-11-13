import { Component, computed, input, output } from '@angular/core';
import { Icon, opensInPlace } from '@onengo/web-kit';
import { t } from '../core/i18n/i18n';
import type { RowView } from '../core/rows';
import { chartGeometry, type Bucket } from '../core/ui-logic/chart';
import { InfiniteListRow } from './card-rows';
import { withDefaults } from './labels';
import { RowMenu } from './row-menu';

export interface WidgetLink {
  label: string;
  to: string;
}

export interface WidgetGroup {
  key: string;
  label: string;
  items: (WidgetLink & { hint?: string; create?: WidgetLink })[];
}

/** What one page widget shows, already loaded and labelled by the screen. */
export type WidgetModel =
  | { kind: 'stat'; label: string; value: string; hint?: string; link?: string }
  | { kind: 'chart'; label: string; chart: 'bar' | 'line'; buckets: Bucket[] }
  | { kind: 'list'; label: string; rows: RowView[]; link?: string }
  | { kind: 'links'; label: string; items: WidgetLink[] }
  | { kind: 'groups'; groups: WidgetGroup[] };

const LABELS = () => ({
  loading: t('ui.common.loading'),
  error: t('ui.common.loadFailed'),
  retry: t('ui.common.retry'),
  empty: t('ui.common.nothingYet'),
  more: t('ui.common.seeAll'),
});
const BOX = { width: 320, height: 150, left: 40, bottom: 22 };

/**
 * One page widget: a number, a bar or line chart (drawn inline), a short
 * list, a set of links, or the record groups. Links are followed by whoever
 * owns the router.
 */
@Component({
  selector: 'app-widget',
  imports: [InfiniteListRow, Icon, RowMenu],
  styleUrl: './styles/widget.css',
  template: `
    @let w = widget();
    @if (w.kind === 'groups') {
      <div class="widget-groups">
        @for (g of w.groups; track g.key) {
          <section class="widget">
            <h2 class="widget__title">{{ g.label }}</h2>
            <ul class="widget__links">
              @for (i of g.items; track i.to) {
                <li class="widget__link-row">
                  <a class="widget__link" [attr.href]="i.to" (click)="follow($event, i.to)">
                    <span class="widget__link-label">{{ i.label }}</span>
                    @if (i.hint) {
                      <span class="widget__hint">{{ i.hint }}</span>
                    }
                  </a>
                  @if (i.create) {
                    <a class="widget__create" [attr.href]="i.create.to" (click)="follow($event, i.create.to)">
                      <app-icon name="add" />
                      <span>{{ i.create.label }}</span>
                    </a>
                  }
                </li>
              }
            </ul>
          </section>
        }
      </div>
    } @else {
      <section [class]="'widget widget--' + w.kind" [attr.aria-busy]="loading()">
        <div class="widget__head">
          <h2 class="widget__title">{{ w.label }}</h2>
          @if (tag()) {
            <span class="widget__tag">{{ tag() }}</span>
          }
          <span class="widget__spacer"></span>
          @if ((w.kind === 'list' || w.kind === 'stat') && w.link) {
            <a class="widget__more" [attr.href]="w.link" (click)="follow($event, w.link)">
              <span>{{ labels().more }}</span>
              <app-icon name="next" />
            </a>
          }
          @if (menu().length) {
            <app-row-menu [actions]="menu()" (choose)="menuChoose.emit($event)" />
          }
        </div>
        @if (loading()) {
          <p class="widget__state" role="status">{{ labels().loading }}</p>
        } @else if (error()) {
          <div class="widget__state widget__state--error" role="alert">
            <span>{{ labels().error }}</span>
            <button type="button" class="widget__retry" (click)="retry.emit()">{{ labels().retry }}</button>
          </div>
        } @else {
          @switch (w.kind) {
            @case ('stat') {
              <p class="widget__value">{{ w.value }}</p>
              @if (w.hint) {
                <p class="widget__hint">{{ w.hint }}</p>
              }
            }
            @case ('chart') {
              @if (w.buckets.length) {
                @let g = geometry();
                <svg class="widget__chart" [attr.viewBox]="'0 0 ' + box.width + ' ' + box.height" role="img" [attr.aria-label]="w.label">
                  @for (t of g.ticks; track t.value) {
                    <line class="widget__grid" [attr.x1]="box.left" [attr.x2]="box.width" [attr.y1]="t.y + 0.5" [attr.y2]="t.y + 0.5" />
                    <text class="widget__axis" [attr.x]="box.left - 6" [attr.y]="t.y + 3" text-anchor="end">{{ format()(t.value) }}</text>
                  }
                  @if (w.chart === 'bar') {
                    @for (b of g.bars; track b.key) {
                      <rect class="widget__bar" [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.width" [attr.height]="b.height" rx="3">
                        <title>{{ b.label }}: {{ format()(b.value) }}</title>
                      </rect>
                    }
                  } @else {
                    <path class="widget__line" [attr.d]="g.line" />
                    @for (b of g.bars; track b.key) {
                      <circle class="widget__dot" [attr.cx]="b.cx" [attr.cy]="b.y" r="3">
                        <title>{{ b.label }}: {{ format()(b.value) }}</title>
                      </circle>
                    }
                  }
                  @for (b of g.bars; track b.key) {
                    <text class="widget__axis" [attr.x]="b.cx" [attr.y]="box.height - 6" text-anchor="middle">{{ b.label }}</text>
                  }
                </svg>
                <table class="widget__hidden">
                  <caption>{{ w.label }}</caption>
                  <tbody>
                    @for (b of w.buckets; track b.key) {
                      <tr>
                        <th scope="row">{{ b.label }}</th>
                        <td>{{ format()(b.value) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="widget__state">{{ labels().empty }}</p>
              }
            }
            @case ('list') {
              @for (r of w.rows; track r.id) {
                <button type="button" class="widget__row" (click)="rowClick.emit(r)">
                  <app-infinite-list-row [item]="r"></app-infinite-list-row>
                </button>
              } @empty {
                <p class="widget__state">{{ labels().empty }}</p>
              }
            }
            @case ('links') {
              <ul class="widget__links">
                @for (i of w.items; track i.to) {
                  <li class="widget__link-row">
                    <a class="widget__link" [attr.href]="i.to" (click)="follow($event, i.to)">
                      <span class="widget__link-label">{{ i.label }}</span>
                      <app-icon name="next" />
                    </a>
                  </li>
                }
              </ul>
            }
          }
        }
      </section>
    }
  `,
})
export class Widget {
  readonly widget = input.required<WidgetModel>();
  readonly loading = input(false);
  readonly error = input(false);
  /** How numbers are written on the chart axis and in its text alternative. */
  readonly format = input<(n: number) => string>((n) => n.toLocaleString());
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  /** A small badge after the title, such as "Your pin". */
  readonly tag = input<string>('');
  /** Entries of the widget's own ⋮ menu; none draws no menu. */
  readonly menu = input<{ id: string; label: string; divider?: boolean }[]>([]);
  readonly menuChoose = output<string>();
  readonly navigate = output<string>();
  readonly rowClick = output<RowView>();
  readonly retry = output<void>();

  readonly box = BOX;
  readonly geometry = computed(() => {
    const w = this.widget();
    return chartGeometry(w.kind === 'chart' ? w.buckets : [], BOX);
  });

  follow(e: MouseEvent, link: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.navigate.emit(link);
  }
}
