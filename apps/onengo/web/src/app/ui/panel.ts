import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal, type OnDestroy } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { FormColumns } from '../core/models';
import type { FormValues } from '../core/records/record/forms';
import type { DetailSection, FieldDisplay } from '../core/records/record/present';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from './cf-form';
import type { CfFieldDef } from './cf-types';
import { AttachedFiles } from './file-field/file-list';
import { DialogFocus } from './dialog';
import { lockWhileOpen } from './form-panel';
import { FormProblems } from '@onengo/web-kit';
import { RichTextView } from './rich-text-field/rich-text-view';
import { SignatureView } from './signature-field/signature-view';

@Component({
  selector: 'app-list-detail-sections',
  imports: [NgTemplateOutlet, TranslatePipe, AttachedFiles, RichTextView, SignatureView],
  styleUrl: './styles/app-list-detail-sections.css',
  styles: `
    .list-detail-sections__pills {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .list-detail-sections__pill {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.72rem;
      background: var(--primary-100, #e0e7ff);
      color: var(--primary-700, #3730a3);
    }
    .list-detail-sections__stack {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .list-detail-sections__stack a {
      color: var(--primary-700, #1d4ed8);
    }
    .list-detail-sections__low {
      color: #b45309;
    }
    .list-detail-sections__rich :is(h3, h4) {
      margin: 0.4em 0 0.2em;
    }
    .list-detail-sections__rich :is(p, ul, ol, blockquote) {
      margin: 0 0 0.5em;
    }
    .list-detail-sections__rich blockquote {
      padding-left: 10px;
      border-left: 3px solid #cbd5e1;
      color: #475569;
    }
    .list-detail-sections__item--selectable {
      width: 100%;
      font: inherit;
      color: inherit;
      text-align: start;
      cursor: pointer;
    }
    .list-detail-sections__item--selectable:focus-visible {
      outline: 2px solid var(--primary-500);
      outline-offset: 2px;
    }
  `,
  template: `
    @for (section of sections(); track section.id) {
      <section class="list-detail-sections__section">
        <button type="button" class="list-detail-sections__section-header" (click)="toggle(section.id)">
          <span class="list-detail-sections__section-title">{{ section.title }}</span>
          <svg
            class="list-detail-sections__chevron"
            [class.list-detail-sections__chevron--collapsed]="collapsed().has(section.id)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </button>

        @if (!collapsed().has(section.id)) {
          @if (section.kind === 'fields') {
            <div class="list-detail-sections__kv-grid">
              @for (field of section.fields; track field.label) {
                <div class="list-detail-sections__kv-row">
                  <div class="list-detail-sections__kv-label">{{ field.label }}</div>
                  <div class="list-detail-sections__kv-value">
                    @if (!field.display) {
                      {{ field.value }}
                    }
                    @if (shown(field.display, 'pills'); as d) {
                      <span class="list-detail-sections__pills">
                        @for (p of d.items; track $index) {
                          <span class="list-detail-sections__pill">{{ p }}</span>
                        }
                      </span>
                    }
                    @if (shown(field.display, 'location'); as d) {
                      <span class="list-detail-sections__stack">
                        @if (d.label) {
                          <span>{{ d.label }}</span>
                        }
                        <span>
                          {{ d.coordinates }}
                          @if (d.accuracy) {
                            · <span [class.list-detail-sections__low]="d.low">{{ d.accuracy }}</span>
                          }
                        </span>
                        <a [href]="d.maps" target="_blank" rel="noopener noreferrer">{{ 'ui.fields.location.openInMaps' | t }} ↗</a>
                      </span>
                    }
                    @if (shown(field.display, 'richText'); as d) {
                      <div class="list-detail-sections__rich" [appRichText]="d.html"></div>
                    }
                    @if (shown(field.display, 'files'); as d) {
                      <app-file-list [ids]="d.ids" />
                    }
                    @if (shown(field.display, 'signature'); as d) {
                      <app-signature-view [file]="d.file" [line]="d.line" />
                    }
                  </div>
                </div>
              }
            </div>
          } @else {
            <div class="list-detail-sections__item-list">
              @if (section.note) {
                <p class="list-detail-sections__empty" role="alert">{{ section.note }}</p>
              } @else if (!section.items.length) {
                <p class="list-detail-sections__empty">
                  {{ 'ui.common.noItems' | t }}
                </p>
              }
              @for (item of section.items; track item.id) {
                <ng-template #itemContent>
                  <div class="list-detail-sections__item-main">
                    <div class="list-detail-sections__item-title">{{ item.title }}</div>
                    @if (item.subtitle) {
                      <div class="list-detail-sections__item-subtitle">{{ item.subtitle }}</div>
                    }
                  </div>
                  @if (item.badge) {
                    <span class="list-detail-sections__item-badge" [attr.data-tone]="item.badge.tone || 'neutral'">
                      {{ item.badge.label }}
                    </span>
                  }
                </ng-template>
                @if (section.selectable) {
                  <button type="button" class="list-detail-sections__item list-detail-sections__item--selectable" (click)="itemSelect.emit({ section: section.id, item: item.id })">
                    <ng-container [ngTemplateOutlet]="itemContent" />
                  </button>
                } @else {
                  <article class="list-detail-sections__item">
                    <ng-container [ngTemplateOutlet]="itemContent" />
                  </article>
                }
              }
            </div>
          }
        }
      </section>
    }
  `,
})
export class ListDetailSections {
  readonly sections = input.required<DetailSection[]>();
  readonly itemSelect = output<{ section: string; item: string }>();
  readonly collapsed = signal(new Set<string>());
  /** The value's display when it is of the given kind. */
  shown<K extends FieldDisplay['kind']>(d: FieldDisplay | undefined, kind: K): Extract<FieldDisplay, { kind: K }> | null {
    return d?.kind === kind ? (d as Extract<FieldDisplay, { kind: K }>) : null;
  }

  toggle(id: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
}

@Component({
  selector: 'app-list-detail-sheet',
  imports: [ListDetailSections, CfForm, FormProblems, TranslatePipe, DialogFocus],
  styleUrl: './styles/app-list-detail-sheet.css',
  template: `
    @if (open()) {
      <div class="list-detail-sheet__backdrop" data-dialog-shade aria-hidden="true"></div>

      <div class="list-detail-sheet" appDialog role="dialog" [attr.aria-label]="sheetTitle()" (escape)="dismiss()">
        <div class="list-detail-sheet__handle" aria-hidden="true"></div>

        <div class="list-detail-sheet__title-row">
          <h2 class="list-detail-sheet__title">{{ sheetTitle() }}</h2>
          <div class="list-detail-sheet__title-actions">
            <ng-content select="[detailHeaderActions]"></ng-content>
            <button
              type="button"
              class="list-detail-sheet__close"
              (click)="dismiss()"
              [attr.aria-label]="(mode() === 'edit' ? 'ui.records.cancelEdit' : 'ui.common.close') | t">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        @if (mode() === 'edit') {
          <app-form-problems [message]="editError()" [problems]="editProblems()" />
        } @else if (viewError()) {
          <app-form-problems [message]="viewError()" />
        } @else if (notice()) {
          <app-form-problems [message]="notice()" tone="ok" />
        }

        <div class="list-detail-sheet__body">
          @if (loading() && !sections().length) {
            <div class="list-detail-sheet__state">
              <span class="list-detail-sheet__spinner" aria-hidden="true"></span>
              <span>{{ 'ui.records.loadingDetails' | t }}</span>
            </div>
          }

          @if (mode() === 'view') {
            <div class="list-detail-sheet__hero-slot"><ng-content select="[detailHero]"></ng-content></div>
          }

          @if (sections().length && mode() === 'view') {
            <app-list-detail-sections [sections]="sections()" (itemSelect)="itemSelect.emit($event)"></app-list-detail-sections>
          }

          @if (mode() === 'view') {
            <div class="list-detail-sheet__view-extras"><ng-content select="[detailViewExtras]"></ng-content></div>
          }

          @if (mode() === 'edit') {
            @if (editSummary().length) {
              <div class="list-detail-sheet__summary">
                @for (field of editSummary(); track field.label) {
                  <div class="list-detail-sheet__summary-row">
                    <span class="list-detail-sheet__summary-label">{{ field.label }}</span>
                    <span class="list-detail-sheet__summary-value">
                      {{ field.value }}
                    </span>
                  </div>
                }
              </div>
            }

            <cf-form
              class="list-detail-sheet__form"
              [fields]="editFields()"
              [values]="editValues()"
              [errors]="editErrors()"
              idPrefix="detail-edit"
              [columns]="editColumns()"
              [fullWidth]="editFullWidth()"
              (valuesChange)="editValuesChange.emit($event)">
            </cf-form>
          }
        </div>

        @if (mode() === 'view' && (primaryActionLabel() || hasFooterActions())) {
          <div class="list-detail-sheet__actions list-detail-sheet__actions--stacked">
            <ng-content select="[detailFooterActions]"></ng-content>
            @if (primaryActionLabel()) {
              <button type="button" class="app-btn app-btn--primary app-btn--block" (click)="primaryAction.emit()">
                {{ primaryActionLabel() }}
              </button>
            }
          </div>
        }

        @if (mode() === 'edit') {
          <div class="list-detail-sheet__actions app-btn-group">
            <button type="button" class="app-btn app-btn--ghost" (click)="editCancel.emit()" [disabled]="saving()">
              {{ 'ui.common.cancel' | t }}
            </button>
            <button type="button" class="app-btn app-btn--primary" (click)="editSave.emit()" [disabled]="saving()">
              {{ (saving() ? 'ui.common.saving' : 'ui.common.save') | t }}
            </button>
          </div>
        }
      </div>
    }
  `,
})
export class ListDetailSheet implements OnDestroy {
  readonly open = input(false);
  readonly mode = input<'view' | 'edit'>('view');
  readonly title = input(t('ui.common.details'));
  readonly sections = input<DetailSection[]>([]);
  readonly loading = input(false);
  readonly saving = input(false);
  readonly primaryActionLabel = input<string | undefined>();
  readonly hasFooterActions = input(false);
  readonly editSummary = input<{ label: string; value: string }[]>([]);
  readonly editFields = input<CfFieldDef[]>([]);
  readonly editColumns = input<FormColumns>(1);
  readonly editFullWidth = input<readonly string[]>([]);
  readonly editValues = input<FormValues>({});
  readonly editErrors = input<Record<string, string>>({});
  /** What went wrong with the last save of the edit form, shown inside the sheet. */
  readonly editError = input('');
  readonly editProblems = input<string[]>([]);
  /** What just happened to the record in view mode (such as "saved"), and what went wrong, shown inside the sheet. */
  readonly notice = input('');
  readonly viewError = input('');
  readonly closed = output<void>();
  readonly primaryAction = output<void>();
  readonly editSave = output<void>();
  readonly editCancel = output<void>();
  readonly editValuesChange = output<FormValues>();
  readonly itemSelect = output<{ section: string; item: string }>();
  readonly sheetTitle = computed(() => (this.mode() === 'edit' ? t('ui.records.editTitle', { title: this.title() }) : this.title()));
  private readonly unlock = lockWhileOpen(() => this.open());

  dismiss(): void {
    if (this.mode() === 'edit') this.editCancel.emit();
    else this.closed.emit();
  }

  ngOnDestroy(): void {
    this.unlock();
  }
}
