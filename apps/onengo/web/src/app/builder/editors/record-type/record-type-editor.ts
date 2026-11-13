import { Component, computed, inject } from '@angular/core';
import type { RecordTypeDef } from '../../../core/builder/ops/record-type';
import { defaultNumbering, moveField, numberFormatProblem, publicDisplayField, publicEntryField, ruleBadges, setGeneral, setNumbering, setPublic, typeSummary } from '../../../core/builder/ops/record-type';
import { t } from '../../../core/i18n/i18n';
import type { RowView } from '../../../core/rows';
import { TranslatePipe } from '../../../services/i18n';
import { ChipFilterBar } from '../../../ui/chip-bar';
import { EditableTable } from '../../../ui/editable-table';
import type { TableColumn } from '../../../ui/table-rows';
import { WorkflowSetStore } from '../workflow/workflow-set-store';
import { WorkflowsList } from '../workflow/workflows-list';
import { FieldPanel } from './field-panel';
import { LookupsTab } from './lookups-tab';
import { RecordTypeStore, type RecordTypePage } from './record-type-store';
import { RulesTab } from './rules-tab';
import { UsedByTab } from './used-by-tab';

/** The Visual tab of a record type: general settings and numbering, the fields table with its field panel, rules, lookups, its workflows, and what uses it. */
@Component({
  selector: 'app-record-type-editor',
  imports: [TranslatePipe, ChipFilterBar, EditableTable, FieldPanel, RulesTab, LookupsTab, UsedByTab, WorkflowsList],
  providers: [RecordTypeStore, WorkflowSetStore],
  styleUrl: './record-type.css',
  template: `
    @if (store.body(); as b) {
      <app-chip-filter-bar [chips]="pages()" [activeId]="store.page()" (chipSelect)="openPage($event)" />
      @switch (store.page()) {
        @case ('rules') { <app-record-type-rules /> }
        @case ('lookups') { <app-record-type-lookups /> }
        @case ('usedBy') { <app-record-type-used-by /> }
        @case ('workflows') { <app-workflows-list [recordType]="b.key" /> }
        @default {
          <div class="rt-layout">
            <div class="rt-general">
              <h3 class="rt-heading">{{ 'ui.builder.generic.general' | t }}</h3>
              <div class="rt-box">
                <div class="field">
                  <label for="rt-label">{{ 'ui.builder.name' | t }}</label>
                  <input id="rt-label" required [value]="b.label" (input)="general({ label: text($event) })" />
                </div>
                <div class="field">
                  <label for="rt-plural">{{ 'ui.builder.recordType.plural' | t }}</label>
                  <input id="rt-plural" [value]="b.pluralLabel ?? ''" (input)="general({ pluralLabel: text($event) })" />
                </div>
                <div class="field">
                  <label for="rt-desc">{{ 'ui.builder.recordType.description' | t }}</label>
                  <input id="rt-desc" [value]="b.description ?? ''" (input)="general({ description: text($event) })" />
                </div>
                <div class="field">
                  <label for="rt-title">{{ 'ui.builder.recordType.titleField' | t }}</label>
                  <select id="rt-title" (change)="general({ titleField: text($event) })">
                    <option value="" [selected]="!b.titleField">—</option>
                    @for (f of store.fields(); track f.key) { <option [value]="f.key" [selected]="f.key === b.titleField">{{ f.label || f.key }}</option> }
                  </select>
                  <div class="help">{{ 'ui.builder.recordType.titleHint' | t }}</div>
                </div>
                <div class="field">
                  <label for="rt-visibility">{{ 'ui.builder.recordType.visibility' | t }}</label>
                  <select id="rt-visibility" (change)="general({ visibility: $any(text($event)) })">
                    <option value="organisation" [selected]="b.visibility !== 'restricted'">{{ 'ui.builder.schema.enum.organisation' | t }}</option>
                    <option value="restricted" [selected]="b.visibility === 'restricted'">{{ 'ui.builder.recordType.restricted' | t }}</option>
                  </select>
                </div>
              </div>

              <h3 class="rt-heading">{{ 'ui.builder.recordType.public' | t }}</h3>
              <div class="rt-box">
                <p class="help">{{ 'ui.builder.recordType.publicHint' | t }}</p>
                @for (op of publicOps; track op) {
                  <label class="rt-switch"><input type="checkbox" role="switch" [checked]="!!flag(op)" (change)="publicFlag(op, checked($event))" /> {{ ('ui.builder.recordType.public' + opLabel(op)) | t }}</label>
                }
                @for (f of entryFields(); track f.key) {
                  <label class="rt-switch"><input type="checkbox" [checked]="publicOf().fields?.includes(f.key)" (change)="togglePublicField(f.key, checked($event))" /> {{ f.label || f.key }}</label>
                }
                <div class="field">
                  <label for="rt-thanks">{{ 'ui.builder.recordType.publicThanks' | t }}</label>
                  <input id="rt-thanks" [value]="publicOf().thanks ?? ''" (input)="publicThanks(text($event))" />
                </div>
                <label class="rt-switch"><input type="checkbox" role="switch" [checked]="!!publicOf().catalogue" (change)="toggleCatalogue(checked($event))" /> {{ 'ui.builder.recordType.publicCatalogue' | t }}</label>
                @if (publicOf().catalogue; as catalogue) {
                  @for (f of displayFields(); track f.key) {
                    <label class="rt-switch"><input type="checkbox" [checked]="catalogue.fields.includes(f.key)" (change)="toggleCatalogueField(f.key, checked($event))" /> {{ f.label || f.key }}</label>
                  }
                  <div class="field">
                    <label for="rt-status">{{ 'ui.builder.recordType.publicStatus' | t }}</label>
                    <input id="rt-status" [value]="catalogue.statusIn.join(', ')" (input)="catalogueStatus(text($event))" />
                    <div class="help">{{ 'ui.builder.recordType.publicStatusHint' | t }}</div>
                  </div>
                  <div class="field">
                    <label for="rt-request-type">{{ 'ui.builder.recordType.publicRequest' | t }}</label>
                    <input id="rt-request-type" [value]="catalogue.request?.recordType ?? ''" (input)="catalogueRequestType(text($event))" />
                    <input id="rt-request-field" [value]="catalogue.request?.field ?? ''" (input)="catalogueRequestField(text($event))" [attr.aria-label]="'ui.builder.recordType.publicRequestField' | t" />
                  </div>
                }
              </div>

              @if (store.allows().numbering) {
                <h3 class="rt-heading">{{ 'ui.builder.schema.prop.numbering' | t }}</h3>
                <div class="rt-box">
                  <label class="rt-switch"><input type="checkbox" role="switch" [checked]="!!b.numbering" (change)="toggleNumbering(checked($event))" /> {{ 'ui.builder.recordType.numbering' | t }}</label>
                  @if (b.numbering; as n) {
                    <div class="field">
                      <label for="rt-format">{{ 'ui.builder.recordType.numberFormat' | t }}</label>
                      <input id="rt-format" class="rt-code" [value]="n.format" [attr.aria-invalid]="!!formatProblem()" (input)="numbering({ format: text($event) })" />
                      @if (formatProblem(); as p) {
                        <div class="error" role="alert">{{ p }}</div>
                      } @else if (store.nextNumber(); as next) {
                        <div class="rt-ok">{{ 'ui.builder.recordType.nextNumber' | t: { number: next } }}</div>
                      }
                      <div class="help">{{ 'ui.builder.recordType.numberTokens' | t }}</div>
                    </div>
                    <div class="field">
                      <label for="rt-reset">{{ 'ui.builder.schema.prop.reset' | t }}</label>
                      <select id="rt-reset" (change)="numbering({ reset: $any(text($event)) })">
                        <option value="fiscal_year" [selected]="n.reset !== 'never'">{{ 'ui.builder.schema.enum.fiscal_year' | t }}</option>
                        <option value="never" [selected]="n.reset === 'never'">{{ 'ui.builder.schema.enum.never' | t }}</option>
                      </select>
                    </div>
                  }
                </div>
              }
            </div>

            <div class="rt-fields">
              <h3 class="rt-heading">{{ 'ui.builder.recordType.fieldsCount' | t: { count: store.fields().length } }}</h3>
              @if (store.notice(); as n) { <div class="notice error" role="alert">{{ n }}</div> }
              <app-editable-table
                [rows]="rows()"
                [columns]="columns()"
                [selectedId]="store.selected()?.key ?? null"
                [labels]="{ add: ('ui.builder.recordType.addField' | t) }"
                (rowSelect)="store.select($event)"
                (moved)="move($event.from, $event.to)"
                (add)="store.addField()"
                (remove)="store.remove($event)">
                <div rowPanel><app-field-panel /></div>
              </app-editable-table>
              <p class="help">{{ 'ui.builder.recordType.fieldsHint' | t }}</p>
            </div>
          </div>
        }
      }
    }
  `,
})
export class RecordTypeEditor {
  readonly store = inject(RecordTypeStore);
  readonly publicOps = ['create', 'view', 'edit', 'delete'] as const;
  readonly entryFields = computed(() => (this.store.body()?.fields ?? []).filter(publicEntryField));
  readonly displayFields = computed(() => (this.store.body()?.fields ?? []).filter(publicDisplayField));

  readonly pages = computed(() => [
    { id: 'fields', label: t('ui.builder.recordType.fields') },
    { id: 'rules', label: t('ui.builder.tabs.rules') },
    { id: 'lookups', label: t('ui.builder.tabs.lookups') },
    ...(this.store.allows().workflows ? [{ id: 'workflows', label: t('ui.builder.kinds.workflow') }] : []),
    { id: 'usedBy', label: t('ui.builder.tabs.usedBy') },
  ]);
  readonly formatProblem = computed(() => {
    const n = this.store.body()?.numbering;
    return n ? numberFormatProblem(n.format) : null;
  });
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.label') },
    { key: 'key', label: t('ui.builder.key') },
    { key: 'type', label: t('ui.builder.recordType.type') },
    { key: 'required', label: t('ui.builder.recordType.required') },
    { key: 'rules', label: t('ui.builder.recordType.rules') },
  ]);
  readonly rows = computed<RowView[]>(() => {
    const b = this.store.body();
    if (!b) return [];
    return this.store.fields().map((f) => ({
      id: f.key,
      title: f.label || f.key,
      cells: [
        { key: 'key', label: t('ui.builder.key'), value: f.key },
        { key: 'type', label: t('ui.builder.recordType.type'), value: typeSummary(f) },
        { key: 'required', label: t('ui.builder.recordType.required'), value: f.required ? '✓' : '' },
      ],
      cellBadges: { rules: ruleBadges(b, f) },
      actions: [],
    }));
  });

  openPage(id: string): void {
    this.store.openPage(id as RecordTypePage);
  }

  text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  general(patch: Parameters<typeof setGeneral>[1]): void {
    this.store.edit((b) => setGeneral(b, patch));
  }

  toggleNumbering(on: boolean): void {
    this.store.edit((b) => setNumbering(b, on ? (b.numbering ?? defaultNumbering(b)) : undefined));
  }

  numbering(patch: { format?: string; reset?: 'fiscal_year' | 'never' }): void {
    this.store.edit((b) => setNumbering(b, b.numbering && { ...b.numbering, ...patch }));
  }

  publicOf(): NonNullable<RecordTypeDef['public']> {
    return this.store.body()?.public ?? {};
  }

  flag(op: 'create' | 'view' | 'edit' | 'delete'): boolean {
    return !!this.publicOf()[op];
  }

  opLabel(op: string): string {
    return op.charAt(0).toUpperCase() + op.slice(1);
  }

  publicFlag(op: 'create' | 'view' | 'edit' | 'delete', on: boolean): void {
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), [op]: on || undefined }));
  }

  togglePublicField(key: string, on: boolean): void {
    const fields = new Set(this.publicOf().fields ?? []);
    if (on) fields.add(key);
    else fields.delete(key);
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), fields: [...fields] }));
  }

  publicThanks(thanks: string): void {
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), thanks: thanks || undefined }));
  }

  toggleCatalogue(on: boolean): void {
    const first = this.displayFields()[0];
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), catalogue: on && first ? { fields: [first.key], statusIn: [] } : undefined }));
  }

  toggleCatalogueField(key: string, on: boolean): void {
    const catalogue = this.publicOf().catalogue;
    if (!catalogue) return;
    const fields = new Set(catalogue.fields);
    if (on) fields.add(key);
    else fields.delete(key);
    const next = [...fields];
    if (!next.length) return;
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), catalogue: { ...catalogue, fields: next, search: catalogue.search?.filter((k) => next.includes(k)) } }));
  }

  catalogueStatus(text: string): void {
    const catalogue = this.publicOf().catalogue;
    if (!catalogue) return;
    const statusIn = text.split(',').map((s) => s.trim()).filter(Boolean);
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), catalogue: { ...catalogue, statusIn } }));
  }

  catalogueRequestType(recordType: string): void {
    this.catalogueRequest(recordType, this.publicOf().catalogue?.request?.field ?? '');
  }

  catalogueRequestField(field: string): void {
    this.catalogueRequest(this.publicOf().catalogue?.request?.recordType ?? '', field);
  }

  private catalogueRequest(recordType: string, field: string): void {
    const catalogue = this.publicOf().catalogue;
    if (!catalogue) return;
    const request = recordType && field ? { recordType, field } : undefined;
    this.store.edit((b) => setPublic(b, { ...this.publicOf(), catalogue: { ...catalogue, request } }));
  }

  move(from: number, to: number): void {
    this.store.edit((b) => moveField(b, from, to));
  }
}
