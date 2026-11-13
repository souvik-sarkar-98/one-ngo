import { Component, computed, inject } from '@angular/core';
import { moveRule, setRule } from '../../../core/builder/ops/record-type';
import { t } from '../../../core/i18n/i18n';
import type { RowView } from '../../../core/rows';
import { TranslatePipe } from '../../../services/i18n';
import { EditableTable } from '../../../ui/editable-table';
import { ExpressionField } from '../../../ui/expression-field';
import type { TableColumn } from '../../../ui/table-rows';
import { RecordTypeStore } from './record-type-store';

/** Checks a record must pass to be saved, each with the message people see. */
@Component({
  selector: 'app-record-type-rules',
  imports: [TranslatePipe, EditableTable, ExpressionField],
  styleUrl: './record-type.css',
  template: `
    <h3 class="rt-heading">{{ 'ui.builder.recordType.rulesCount' | t: { count: rows().length } }}</h3>
    <p class="help">{{ 'ui.builder.recordType.rulesHint' | t }} <code>(record.fee ?? 0) &lt;= record.amount</code></p>
    <app-editable-table
      [rows]="rows()"
      [columns]="columns()"
      [selectedId]="selected()?.key ?? null"
      [labels]="{ add: ('ui.builder.recordType.addRule' | t) }"
      (rowSelect)="store.selectedRule.set($event)"
      (moved)="move($event.from, $event.to)"
      (add)="store.addRule()"
      (remove)="store.removeRule($event)">
      <div rowPanel>
        @if (selected(); as r) {
          <div class="field">
            <label for="rule-key">{{ 'ui.builder.key' | t }}</label>
            <input id="rule-key" class="rt-code" [value]="r.key" (change)="store.renameRule(r.key, text($event))" />
          </div>
          <app-expression-field [assist]="store.expressions" [recordType]="store.key()" [label]="'ui.builder.onlyWhen' | t" [placeholder]="'ui.builder.recordType.always' | t" [value]="r.when ?? ''" (valueChange)="set(r.key, { when: $event })" />
          <app-expression-field [assist]="store.expressions" [recordType]="store.key()" [label]="'ui.builder.recordType.mustBeTrue' | t" [value]="r.expression" (valueChange)="set(r.key, { expression: $event })" />
          <div class="field">
            <label for="rule-message">{{ 'ui.builder.recordType.messageIfNot' | t }}</label>
            <input id="rule-message" required [value]="r.message" (input)="set(r.key, { message: text($event) })" />
          </div>
          <div class="rt-actions">
            <button type="button" class="danger" (click)="store.removeRule(r.key)">{{ 'ui.builder.recordType.removeRule' | t }}</button>
          </div>
        }
      </div>
    </app-editable-table>
  `,
})
export class RulesTab {
  readonly store = inject(RecordTypeStore);
  readonly rules = computed(() => this.store.body()?.rules ?? []);
  readonly selected = computed(() => this.rules().find((r) => r.key === this.store.selectedRule()) ?? null);
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.key') },
    { key: 'when', label: t('ui.builder.schema.prop.when') },
    { key: 'expression', label: t('ui.builder.recordType.mustBeTrue') },
    { key: 'message', label: t('ui.builder.recordType.messageIfNot') },
  ]);
  readonly rows = computed<RowView[]>(() =>
    this.rules().map((r) => ({
      id: r.key,
      title: r.key,
      cells: [
        { key: 'when', label: t('ui.builder.schema.prop.when'), value: r.when || t('ui.builder.recordType.always') },
        { key: 'expression', label: t('ui.builder.recordType.mustBeTrue'), value: r.expression },
        { key: 'message', label: t('ui.builder.recordType.messageIfNot'), value: r.message },
      ],
      actions: [],
    })),
  );

  text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  set(key: string, patch: Parameters<typeof setRule>[2]): void {
    this.store.edit((b) => setRule(b, key, patch));
  }

  move(from: number, to: number): void {
    this.store.edit((b) => moveRule(b, from, to));
  }
}
