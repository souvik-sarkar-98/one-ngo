import { NgClass } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type { RowView, Tone } from '../core/rows';

@Component({
  selector: 'app-list-row-card',
  imports: [NgClass],
  styleUrl: './styles/app-list-row-card.css',
  template: `
    <div class="list-row">
      <div class="list-row__icon" [ngClass]="iconToneClass()">
        <ng-content select="[listRowIcon]"></ng-content>
      </div>

      <div class="list-row__content">
        <div class="list-row__title">
          <ng-content select="[listRowTitle]"></ng-content>
        </div>
        <div class="list-row__subtitle">
          <ng-content select="[listRowSubtitle]"></ng-content>
        </div>
        <ng-content select="[listRowLines]"></ng-content>
        <div class="list-row__meta">
          <span><ng-content select="[listRowMetaLeft]"></ng-content></span>
        </div>
      </div>

      <div class="list-row__aside">
        <span class="list-row__badge" [ngClass]="badgeToneClass()">
          <ng-content select="[listRowBadge]"></ng-content>
        </span>
        <span class="list-row__date">
          <ng-content select="[listRowMetaRight]"></ng-content>
        </span>
      </div>
    </div>
  `,
})
export class ListRowCard {
  readonly iconTone = input('orange');
  readonly badgeTone = input<Tone>('neutral');
  readonly iconToneClass = computed(() => `list-row__icon--${this.iconTone()}`);
  readonly badgeToneClass = computed(() => `list-row__badge--${this.badgeTone()}`);
}

/** One card row, drawn exactly as the list toolkit drew it. */
@Component({
  selector: 'app-infinite-list-row',
  imports: [ListRowCard],
  styleUrl: './styles/app-infinite-list-row.css',
  styles: `
    .list-row__line {
      margin-top: 3px;
      font-size: 0.68rem;
      color: var(--secondary-600);
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
  `,
  template: `
    <app-list-row-card iconTone="orange" [badgeTone]="item().badge?.tone ?? 'neutral'">
      <svg
        listRowIcon
        class="list-row__icon-svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true">
        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
      </svg>

      <span listRowTitle>{{ item().title }}</span>
      @if (item().subtitle) {
        <span listRowSubtitle>{{ item().subtitle }}</span>
      }
      @for (line of item().lines ?? []; track $index) {
        <div listRowLines class="list-row__line">{{ line }}</div>
      }
      @if (item().meta) {
        <span listRowMetaLeft>{{ item().meta }}</span>
      }
      @if (item().badge) {
        <span listRowBadge>{{ item().badge!.label }}</span>
      }
    </app-list-row-card>
  `,
})
export class InfiniteListRow {
  readonly item = input.required<RowView>();
}
