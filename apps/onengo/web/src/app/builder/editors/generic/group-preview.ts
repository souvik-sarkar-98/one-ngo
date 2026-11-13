import { Component, computed, inject, input, signal } from '@angular/core';
import { previewRecordGroups, type GroupBody } from '../../../core/builder/record-groups';
import { t } from '../../../core/i18n/i18n';
import type { RowView } from '../../../core/rows';
import { TranslatePipe } from '../../../services/i18n';
import { EditableTable } from '../../../ui/editable-table';
import { GenericEditorStore } from './generic-store';
import { PreviewStore } from './preview-store';

type Body = Record<string, unknown>;

/** The group's record types in order (drag to reorder), and the Records screen with every group and "Other". */
@Component({
  selector: 'app-group-preview',
  imports: [TranslatePipe, EditableTable],
  styleUrl: './preview.css',
  styles: `
    .gp__group { margin: 0 0 .5rem; }
    .gp__head { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
    .gp__group--current .gp__head { color: var(--brand); }
    .gp__types { margin: .1rem 0 0; padding: 0; list-style: none; }
  `,
  template: `
    <div class="pv">
      <h4 class="pv__title">{{ 'ui.builder.groups.order' | t }}</h4>
      <app-editable-table
        [rows]="rows()"
        [columns]="columns()"
        [addable]="false"
        (moved)="move($event.from, $event.to)"
        (remove)="remove(+$event)" />
      @for (e of current()?.shownElsewhere ?? []; track e.key) {
        <p class="pv__note">{{ 'ui.builder.groups.elsewhere' | t: { type: e.label, group: e.group } }}</p>
      }
    </div>
    <section class="pv" aria-labelledby="groups-preview-title">
      <h3 class="pv__title" id="groups-preview-title">{{ 'ui.builder.groups.preview' | t }}</h3>
      @if (failed()) {
        <p class="pv__bad" role="alert">{{ 'ui.builder.preview.failed' | t }}</p>
      }
      @for (g of groups(); track g.key) {
        <div class="gp__group" [class.gp__group--current]="g.current">
          <div class="gp__head">{{ g.label }}@if (g.current) { · {{ 'ui.builder.groups.thisGroup' | t }} }</div>
          <ul class="gp__types">@for (x of g.recordTypes; track x.key) { <li>{{ x.label }}</li> }</ul>
        </div>
      }
      <p class="pv__note">{{ 'ui.builder.groups.otherHint' | t }}</p>
    </section>
  `,
})
export class GroupPreview {
  private readonly previews = inject(PreviewStore);
  private readonly editor = inject(GenericEditorStore);
  readonly value = input<unknown>();
  readonly body = input<Body | null>(null);
  readonly failed = signal(false);
  private readonly published = signal<{ groups: GroupBody[]; types: { key: string; label: string }[] }>({ groups: [], types: [] });
  private readonly list = computed(() => (Array.isArray(this.value()) ? (this.value() as unknown[]).filter((x): x is string => typeof x === 'string') : []));
  readonly groups = computed(() => previewRecordGroups(this.published().groups, this.body() ?? {}, this.published().types));
  readonly current = computed(() => this.groups().find((g) => g.current) ?? null);
  readonly columns = computed(() => [{ key: 'title', label: t('ui.builder.schema.prop.recordType') }]);
  readonly rows = computed<RowView[]>(() => {
    const label = new Map(this.published().types.map((x) => [x.key, x.label]));
    return this.list().map((k, i) => ({ id: String(i), title: label.get(k) ?? k, subtitle: k, cells: [], actions: [] }));
  });

  constructor() {
    this.previews
      .recordGroups()
      .then((p) => this.published.set(p))
      .catch(() => this.failed.set(true));
  }

  move(from: number, to: number): void {
    const next = [...this.list()];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    this.editor.set(['recordTypes'], next);
  }

  remove(index: number): void {
    this.editor.set(['recordTypes'], this.list().filter((_, i) => i !== index));
  }
}
