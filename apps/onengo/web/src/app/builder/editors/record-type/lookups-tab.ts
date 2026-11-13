import { Component, computed, inject } from '@angular/core';
import { addLookupValue, moveLookup, removeLookupValue, setLookup, setLookupValue, toggleLookupInput, type Lookup } from '../../../core/builder/ops/record-type';
import { t } from '../../../core/i18n/i18n';
import type { RowView } from '../../../core/rows';
import { TranslatePipe } from '../../../services/i18n';
import { EditableTable } from '../../../ui/editable-table';
import type { TableColumn } from '../../../ui/table-rows';
import { RecordTypeStore } from './record-type-store';

/** Values read from an http lookup connector while a record saves: the fields sent to it and the fields its answer fills. */
@Component({
  selector: 'app-record-type-lookups',
  imports: [TranslatePipe, EditableTable],
  styleUrl: './record-type.css',
  template: `
    <h3 class="rt-heading">{{ 'ui.builder.recordType.lookupsCount' | t: { count: rows().length } }}</h3>
    <p class="help">{{ 'ui.builder.recordType.lookupsHint' | t }}</p>
    <app-editable-table
      [rows]="rows()"
      [columns]="columns()"
      [selectedId]="selected()?.key ?? null"
      [labels]="{ add: ('ui.builder.recordType.addLookup' | t) }"
      (rowSelect)="store.selectedLookup.set($event)"
      (moved)="move($event.from, $event.to)"
      (add)="store.addLookup()"
      (remove)="store.removeLookup($event)">
      <div rowPanel>
        @if (selected(); as l) {
          <div class="field">
            <label for="lookup-key">{{ 'ui.builder.key' | t }}</label>
            <input id="lookup-key" class="rt-code" [value]="l.key" (change)="store.renameLookup(l.key, text($event))" />
          </div>
          <div class="field">
            <label for="lookup-connector">{{ 'ui.builder.recordType.lookupConnector' | t }}</label>
            @if (connectorOptions().length) {
              <select id="lookup-connector" (change)="set(l.key, { connector: text($event) })">
                <option value="" [selected]="!l.connector">—</option>
                @for (c of connectorOptions(); track c) {
                  <option [value]="c" [selected]="c === l.connector">{{ c }}</option>
                }
              </select>
            } @else {
              <input id="lookup-connector" class="rt-code" required [value]="l.connector" (input)="set(l.key, { connector: text($event) })" />
            }
            <div class="help">{{ 'ui.builder.recordType.lookupConnectorHint' | t }}</div>
          </div>
          <section class="rt-sec">
            <h4 class="rt-sec__title">{{ 'ui.builder.recordType.lookupInputs' | t }}</h4>
            @for (f of store.fields(); track f.key) {
              <label class="rt-switch"><input type="checkbox" [checked]="l.inputs.includes(f.key)" [disabled]="f.key in l.map" (change)="store.edit(input(l.key, f.key, checked($event)))" /> {{ f.label || f.key }}</label>
            }
            <div class="help">{{ 'ui.builder.recordType.lookupInputsHint' | t }}</div>
          </section>
          <section class="rt-sec">
            <h4 class="rt-sec__title">{{ 'ui.builder.recordType.lookupFills' | t }}</h4>
            @for (m of mapRows(l); track m.field) {
              <div class="rt-choice">
                <select [attr.aria-label]="'ui.builder.recordType.lookupField' | t" (change)="setValue(l.key, m.field, { field: text($event), value: m.value })">
                  @for (f of store.fields(); track f.key) {
                    @if (f.key === m.field || !(f.key in l.map || l.inputs.includes(f.key))) {
                      <option [value]="f.key" [selected]="f.key === m.field">{{ f.label || f.key }}</option>
                    }
                  }
                </select>
                <input class="rt-code" [attr.aria-label]="'ui.builder.recordType.lookupValue' | t" [value]="m.value" (input)="setValue(l.key, m.field, { field: m.field, value: text($event) })" />
                <button type="button" class="small danger" [attr.aria-label]="'ui.common.remove' | t" (click)="store.edit(removeValue(l.key, m.field))">✕</button>
              </div>
            }
            <button type="button" class="small" (click)="store.edit(addValue(l.key))">{{ 'ui.builder.recordType.addLookupValue' | t }}</button>
            <div class="help">{{ 'ui.builder.recordType.lookupFillsHint' | t }}</div>
          </section>
          <div class="rt-actions">
            <button type="button" class="danger" (click)="store.removeLookup(l.key)">{{ 'ui.builder.recordType.removeLookup' | t }}</button>
          </div>
        }
      </div>
    </app-editable-table>
  `,
})
export class LookupsTab {
  readonly store = inject(RecordTypeStore);
  readonly lookups = computed(() => this.store.body()?.lookups ?? []);
  readonly selected = computed(() => this.lookups().find((l) => l.key === this.store.selectedLookup()) ?? null);
  /** The http connectors, and the one this lookup names when it is not among them. */
  readonly connectorOptions = computed(() => {
    const known = this.store.httpConnectors();
    const current = this.selected()?.connector;
    return known.length && current && !known.includes(current) ? [...known, current] : known;
  });
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.key') },
    { key: 'connector', label: t('ui.builder.recordType.lookupConnector') },
    { key: 'inputs', label: t('ui.builder.recordType.lookupInputs') },
    { key: 'fills', label: t('ui.builder.recordType.lookupFills') },
  ]);
  readonly rows = computed<RowView[]>(() =>
    this.lookups().map((l) => ({
      id: l.key,
      title: l.key,
      cells: [
        { key: 'connector', label: t('ui.builder.recordType.lookupConnector'), value: l.connector || '—' },
        { key: 'inputs', label: t('ui.builder.recordType.lookupInputs'), value: l.inputs.join(', ') || '—' },
        { key: 'fills', label: t('ui.builder.recordType.lookupFills'), value: Object.keys(l.map).join(', ') || '—' },
      ],
      actions: [],
    })),
  );

  mapRows(l: Lookup): { field: string; value: string }[] {
    return Object.entries(l.map).map(([field, value]) => ({ field, value }));
  }

  text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  set(key: string, patch: Partial<Lookup>): void {
    this.store.edit((b) => setLookup(b, key, patch));
  }

  setValue(key: string, field: string, next: { field: string; value: string }): void {
    this.store.edit((b) => setLookupValue(b, key, field, next));
  }

  input(key: string, field: string, on: boolean) {
    return (b: Parameters<typeof toggleLookupInput>[0]) => toggleLookupInput(b, key, field, on);
  }

  addValue(key: string) {
    return (b: Parameters<typeof addLookupValue>[0]) => addLookupValue(b, key);
  }

  removeValue(key: string, field: string) {
    return (b: Parameters<typeof removeLookupValue>[0]) => removeLookupValue(b, key, field);
  }

  move(from: number, to: number): void {
    this.store.edit((b) => moveLookup(b, from, to));
  }
}
