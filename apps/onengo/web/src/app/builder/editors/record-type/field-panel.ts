import { Component, computed, inject } from '@angular/core';
import {
  FIELD_TYPES,
  FILE_KINDS,
  canBeUnique,
  canChangePermission,
  copyCandidates,
  hasMaxLength,
  hasPattern,
  hasRange,
  panelSections,
  readPermissionOf,
  referenceFields,
  setCalculated,
  setCopyFrom,
  setField,
  setFieldType,
  setRollup,
  setSensitive,
  canHavePlaceholder,
  toggleAccept,
  typeLabel,
  type FieldDef,
  type FieldType,
  type FileKind,
  type RollupDef,
} from '../../../core/builder/ops/record-type';
import { kindName } from '../../../core/starters';
import { TranslatePipe } from '../../../services/i18n';
import { Autocomplete } from '../../../ui/autocomplete';
import { ExpressionField } from '../../../ui/expression-field';
import { PermissionField } from '../../../ui/permission-field';
import { RecordTypeStore } from './record-type-store';

/** Everything about the selected field, in the sections that apply to its type. */
@Component({
  selector: 'app-field-panel',
  imports: [TranslatePipe, Autocomplete, ExpressionField, PermissionField],
  styleUrl: './record-type.css',
  template: `
    @if (field(); as f) {
      @let b = store.body()!;
      @for (s of sections(); track s) {
        @switch (s) {
          @case ('basics') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.basics' | t }}</h4>
              <div class="field">
                <label for="fp-label">{{ 'ui.builder.label' | t }}</label>
                <input id="fp-label" required [value]="f.label" (input)="store.setLabel(f.key, text($event))" (change)="keepLabel($event, f.label)" />
              </div>
              <div class="field">
                <label for="fp-key">{{ 'ui.builder.key' | t }}</label>
                <input id="fp-key" class="rt-code" [value]="f.key" [readOnly]="fixed()" (change)="store.setKey(f.key, text($event))" />
                <div class="help">{{ 'ui.builder.recordType.keyFixed' | t }}</div>
              </div>
              <div class="field">
                <label for="fp-type">{{ 'ui.builder.recordType.type' | t }}</label>
                <select id="fp-type" (change)="setType(text($event))">
                  @for (type of types; track type) { <option [value]="type" [selected]="type === f.type">{{ typeName(type) }}</option> }
                </select>
              </div>
              <div class="field">
                <label for="fp-help">{{ 'ui.builder.schema.prop.help' | t }}</label>
                <input id="fp-help" [value]="f.help ?? ''" (input)="set({ help: text($event) })" />
              </div>
              @if (canHavePlaceholder(f.type)) {
                <div class="field">
                  <label for="fp-placeholder">{{ 'ui.builder.schema.prop.placeholder' | t }}</label>
                  <input id="fp-placeholder" [value]="f.placeholder ?? ''" (input)="set({ placeholder: text($event) || undefined })" />
                </div>
              }
            </section>
          }
          @case ('rules') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.rules' | t }}</h4>
              @if (!derived()) {
                <label class="rt-switch"><input type="checkbox" [checked]="!!f.required" (change)="set({ required: checked($event) || undefined })" /> {{ 'ui.builder.recordType.required' | t }}</label>
              }
              <label class="rt-switch"><input type="checkbox" [checked]="!!f.searchable" (change)="set({ searchable: checked($event) || undefined })" /> {{ 'ui.builder.schema.prop.searchable' | t }}</label>
              @if (canBeUnique(f)) {
                <label class="rt-switch"><input type="checkbox" [checked]="!!f.unique" (change)="set({ unique: checked($event) || undefined })" /> {{ 'ui.builder.schema.prop.unique' | t }}</label>
              }
              @if (hasRange(f)) {
                <div class="rt-pair">
                  <div class="field">
                    <label for="fp-min">{{ 'ui.builder.schema.prop.min' | t }}</label>
                    <input id="fp-min" type="number" [value]="f.min ?? ''" (change)="set({ min: num($event) })" />
                  </div>
                  <div class="field">
                    <label for="fp-max">{{ 'ui.builder.schema.prop.max' | t }}</label>
                    <input id="fp-max" type="number" [value]="f.max ?? ''" (change)="set({ max: num($event) })" />
                  </div>
                </div>
              }
              @if (hasMaxLength(f)) {
                <div class="field">
                  <label for="fp-maxlength">{{ 'ui.builder.schema.prop.maxLength' | t }}</label>
                  <input id="fp-maxlength" type="number" min="1" step="1" [value]="f.maxLength ?? ''" (change)="set({ maxLength: num($event) })" />
                </div>
              }
              @if (hasPattern(f)) {
                <div class="field">
                  <label for="fp-pattern">{{ 'ui.builder.schema.prop.pattern' | t }}</label>
                  <input id="fp-pattern" class="rt-code" [value]="f.pattern ?? ''" (change)="set({ pattern: text($event), patternMessage: text($event) ? f.patternMessage : undefined })" />
                </div>
                @if (f.pattern) {
                  <div class="field">
                    <label for="fp-pattern-msg">{{ 'ui.builder.schema.prop.patternMessage' | t }}</label>
                    <input id="fp-pattern-msg" [value]="f.patternMessage ?? ''" (input)="set({ patternMessage: text($event) })" />
                  </div>
                }
              }
            </section>
          }
          @case ('choices') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.schema.prop.choices' | t }}</h4>
              @for (c of f.choices ?? []; track $index; let i = $index; let first = $first; let last = $last) {
                <div class="rt-choice">
                  <input class="rt-code" [attr.aria-label]="'ui.builder.schema.prop.value' | t" [value]="c.value" (change)="setChoice(i, { value: text($event) })" />
                  <input [attr.aria-label]="'ui.builder.label' | t" [value]="c.label" (input)="setChoice(i, { label: text($event) })" />
                  <button type="button" class="small" [attr.aria-label]="'ui.builder.moveUp' | t" [disabled]="first" (click)="moveChoice(i, -1)">↑</button>
                  <button type="button" class="small" [attr.aria-label]="'ui.builder.moveDown' | t" [disabled]="last" (click)="moveChoice(i, 1)">↓</button>
                  <button type="button" class="small danger" [attr.aria-label]="'ui.common.remove' | t" [disabled]="(f.choices?.length ?? 0) < 2" (click)="removeChoice(i)">✕</button>
                </div>
              }
              <button type="button" class="small" (click)="addChoice()">{{ 'ui.builder.recordType.addChoice' | t }}</button>
            </section>
          }
          @case ('reference') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.linkedType' | t }}</h4>
              <app-autocomplete [label]="'ui.builder.schema.prop.referenceType' | t" [text]="f.referenceType ?? ''" [source]="store.recordTypeSource" (typed)="set({ referenceType: $event })" (chosen)="set({ referenceType: $event.id })" />
            </section>
          }
          @case ('copyFrom') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.copyFrom' | t }}</h4>
              <div class="field">
                <label for="fp-copy-ref">{{ 'ui.builder.schema.prop.reference' | t }}</label>
                <select id="fp-copy-ref" (change)="copyThrough(text($event))">
                  <option value="" [selected]="!f.copyFrom">—</option>
                  @for (r of references(); track r.key) { <option [value]="r.key" [selected]="r.key === f.copyFrom?.reference">{{ r.label || r.key }}</option> }
                </select>
              </div>
              @if (f.copyFrom; as c) {
                <div class="field">
                  <label for="fp-copy-field">{{ 'ui.builder.recordType.copyField' | t: { type: copyType() } }}</label>
                  <select id="fp-copy-field" (change)="copy({ reference: c.reference, field: text($event) })">
                    <option value="" [selected]="!c.field">—</option>
                    @for (s of copySources(); track s.key) { <option [value]="s.key" [selected]="s.key === c.field">{{ s.label || s.key }}</option> }
                  </select>
                  <div class="help">{{ 'ui.builder.recordType.copyHint' | t }}</div>
                </div>
              }
            </section>
          }
          @case ('conditions') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.conditions' | t }}</h4>
              <app-expression-field
                [assist]="store.expressions"
                [recordType]="b.key"
                [label]="'ui.builder.schema.prop.visibleWhen' | t"
                [placeholder]="'ui.builder.recordType.alwaysShown' | t"
                [value]="f.visibleWhen ?? ''"
                (valueChange)="set({ visibleWhen: $event })" />
              @if (!f.rollup) {
                <app-expression-field
                  [assist]="store.expressions"
                  [recordType]="b.key"
                  [label]="'ui.builder.schema.prop.editableWhen' | t"
                  [placeholder]="'ui.builder.recordType.alwaysEditable' | t"
                  [value]="f.editableWhen ?? ''"
                  (valueChange)="set({ editableWhen: $event })" />
              }
            </section>
          }
          @case ('calculated') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.schema.prop.calculated' | t }}</h4>
              <app-expression-field
                [assist]="store.expressions"
                [recordType]="b.key"
                [ariaLabel]="'ui.builder.schema.prop.calculated' | t"
                [panelTitle]="('ui.builder.schema.prop.calculated' | t) + ' ' + f.label"
                [placeholder]="'ui.builder.recordType.calculatedPlaceholder' | t"
                [value]="f.calculated ?? ''"
                (valueChange)="store.edit(calc(f.key, $event))" />
            </section>
          }
          @case ('rollup') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.schema.prop.rollup' | t }}</h4>
              <label class="rt-switch"><input type="checkbox" role="switch" [checked]="!!f.rollup" (change)="rollup(checked($event) ? { recordType: '', reference: '', measure: 'count' } : undefined)" /> {{ 'ui.builder.recordType.rollupOn' | t }}</label>
              @if (f.rollup; as r) {
                <app-autocomplete [label]="'ui.builder.schema.prop.recordType' | t" [text]="r.recordType" [source]="store.recordTypeSource" (typed)="rollup({ recordType: $event, reference: '' })" (chosen)="rollup({ recordType: $event.id, reference: '' })" />
                <div class="field">
                  <label for="fp-roll-ref">{{ 'ui.builder.schema.prop.rollup.reference' | t }}</label>
                  <select id="fp-roll-ref" (change)="rollup({ reference: text($event) })">
                    <option value="" [selected]="!r.reference">—</option>
                    @for (x of rollupReferences(); track x.key) { <option [value]="x.key" [selected]="x.key === r.reference">{{ x.label || x.key }}</option> }
                  </select>
                </div>
                <div class="field">
                  <label for="fp-roll-measure">{{ 'ui.builder.schema.prop.measure' | t }}</label>
                  <select id="fp-roll-measure" (change)="rollup({ measure: $any(text($event)) })">
                    <option value="count" [selected]="r.measure === 'count'">{{ 'ui.builder.schema.enum.count' | t }}</option>
                    <option value="sum" [selected]="r.measure === 'sum'">{{ 'ui.builder.schema.enum.sum' | t }}</option>
                  </select>
                </div>
                @if (r.measure === 'sum') {
                  <div class="field">
                    <label for="fp-roll-field">{{ 'ui.builder.schema.prop.rollup.field' | t }}</label>
                    <select id="fp-roll-field" (change)="rollup({ field: text($event) })">
                      <option value="" [selected]="!r.field">—</option>
                      @for (x of rollupNumbers(); track x.key) { <option [value]="x.key" [selected]="x.key === r.field">{{ x.label || x.key }}</option> }
                    </select>
                  </div>
                }
                <app-expression-field
                  [assist]="store.expressions"
                  [recordType]="r.recordType || null"
                  [label]="'ui.builder.schema.prop.where' | t"
                  [value]="r.where ?? ''"
                  (valueChange)="rollup({ where: $event })" />
              }
            </section>
          }
          @case ('file') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.fileOptions' | t }}</h4>
              <label class="rt-switch"><input type="checkbox" [checked]="!!f.multiple" (change)="set({ multiple: checked($event) || undefined })" /> {{ 'ui.builder.schema.prop.multiple' | t }}</label>
              <span class="rt-label" id="fp-accept">{{ 'ui.builder.schema.prop.accept' | t }}</span>
              <div class="rt-pills" role="group" aria-labelledby="fp-accept">
                @for (k of fileKinds; track k) {
                  <button type="button" class="rt-pill" [class.rt-pill--on]="!!f.accept?.includes(k)" [attr.aria-pressed]="!!f.accept?.includes(k)" (click)="accept(k)">{{ ('ui.builder.schema.enum.' + k) | t }}</button>
                }
              </div>
              <div class="field">
                <label for="fp-size">{{ 'ui.builder.schema.prop.maxSizeMb' | t }}</label>
                <input id="fp-size" type="number" min="0.1" max="25" step="0.1" [value]="f.maxSizeMb ?? ''" (change)="set({ maxSizeMb: num($event) })" />
              </div>
            </section>
          }
          @case ('location') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.locationOptions' | t }}</h4>
              <label class="rt-switch"><input type="checkbox" role="switch" [checked]="f.typedCoordinates !== false" (change)="set({ typedCoordinates: checked($event) ? undefined : false })" /> {{ 'ui.builder.schema.prop.typedCoordinates' | t }}</label>
            </section>
          }
          @case ('signature') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.signatureOptions' | t }}</h4>
              <label class="rt-switch"><input type="checkbox" role="switch" [checked]="!!f.typedName" (change)="set({ typedName: checked($event) || undefined })" /> {{ 'ui.builder.schema.prop.typedName' | t }}</label>
            </section>
          }
          @case ('access') {
            <section class="rt-sec">
              <h4 class="rt-sec__title">{{ 'ui.builder.recordType.access' | t }}</h4>
              <label class="rt-switch"><input type="checkbox" [checked]="!!f.sensitive" (change)="store.edit(sensitive(f.key, checked($event)))" /> {{ 'ui.builder.recordType.sensitive' | t }}</label>
              <div class="field">
                <app-permission-field
                  [label]="'ui.builder.schema.prop.readPermission' | t"
                  [hint]="(f.sensitive ? 'ui.builder.recordType.readHintSensitive' : 'ui.builder.recordType.readHint') | t"
                  [value]="readPermission()"
                  [disabled]="!!f.sensitive"
                  [source]="store.permissionSource"
                  (valueChange)="set({ readPermission: $event.trim() })" />
              </div>
              @if (canChangePermission(f)) {
                <div class="field">
                  <app-permission-field
                    [label]="'ui.builder.schema.prop.editPermission' | t"
                    [hint]="'ui.builder.recordType.editHint' | t"
                    [value]="f.editPermission ?? ''"
                    [source]="store.permissionSource"
                    (valueChange)="set({ editPermission: $event.trim() })" />
                </div>
              }
            </section>
          }
        }
      }

      <section class="rt-sec">
        <h4 class="rt-sec__title">{{ 'ui.builder.tabs.usedBy' | t }}</h4>
        @let used = store.fieldUsages().usages;
        @if (used === null) {
          <p class="muted">{{ 'ui.common.loading' | t }}</p>
        } @else if (used.length) {
          <ul class="rt-uses">
            @for (u of used; track $index) { <li><button type="button" class="link" (click)="store.open(u)">{{ u.label || u.key }}</button> <span class="muted">· {{ kind(u.kind) }} · {{ u.what }}</span></li> }
          </ul>
        } @else {
          <p class="muted">{{ 'ui.builder.recordType.notUsed' | t }}</p>
        }
        <div class="rt-actions">
          <button type="button" (click)="store.duplicate(f.key)">{{ 'ui.builder.catalogue.duplicate' | t }}</button>
          <button type="button" class="danger" [disabled]="!!used?.length" (click)="store.remove(f.key)">{{ 'ui.builder.recordType.removeField' | t }}</button>
        </div>
      </section>
    }
  `,
})
export class FieldPanel {
  readonly store = inject(RecordTypeStore);
  readonly types = FIELD_TYPES;
  readonly canHavePlaceholder = canHavePlaceholder;
  readonly fileKinds = FILE_KINDS;
  readonly canBeUnique = canBeUnique;
  readonly hasRange = hasRange;
  readonly hasMaxLength = hasMaxLength;
  readonly hasPattern = hasPattern;
  readonly canChangePermission = canChangePermission;

  readonly field = this.store.selected;
  readonly fixed = computed(() => this.store.fixedKeys().has(this.field()?.key ?? ''));
  readonly derived = computed(() => !!(this.field()?.calculated || this.field()?.rollup));
  readonly sections = computed(() => {
    const b = this.store.body();
    const f = this.field();
    return b && f ? panelSections(b, f) : [];
  });
  readonly references = computed(() => {
    const b = this.store.body();
    return b ? referenceFields(b, this.field()?.key) : [];
  });
  private readonly copyRef = computed(() => this.references().find((r) => r.key === this.field()?.copyFrom?.reference));
  readonly copyType = computed(() => {
    const type = this.copyRef()?.referenceType ?? '';
    return this.store.recordTypes().find((r) => r.key === type)?.label ?? type;
  });
  readonly copySources = computed(() => {
    const f = this.field();
    return f ? copyCandidates(f, this.store.fieldsOf(this.copyRef()?.referenceType)) : [];
  });
  private readonly rollupFields = computed(() => this.store.fieldsOf(this.field()?.rollup?.recordType || undefined));
  readonly rollupReferences = computed(() => this.rollupFields().filter((x) => x.type === 'reference' && x.referenceType === this.store.key()));
  readonly rollupNumbers = computed(() => this.rollupFields().filter((x) => x.type === 'number' || x.type === 'money'));
  readonly readPermission = computed(() => {
    const b = this.store.body();
    const f = this.field();
    return b && f ? (readPermissionOf(b, f) ?? '') : '';
  });
  text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  /** Leaving the name box empty puts the field's current name back. */
  keepLabel(e: Event, current: string | undefined): void {
    const box = e.target as HTMLInputElement;
    if (!box.value.trim()) box.value = current ?? '';
  }

  checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  num(e: Event): number | undefined {
    const raw = (e.target as HTMLInputElement).value.trim();
    const n = Number(raw);
    return raw && Number.isFinite(n) ? n : undefined;
  }

  typeName(type: FieldType): string {
    return typeLabel(type);
  }

  kind(kind: string): string {
    return kindName(kind as Parameters<typeof kindName>[0]);
  }

  private key(): string {
    return this.field()?.key ?? '';
  }

  set(patch: Partial<FieldDef>): void {
    const key = this.key();
    if (key) this.store.edit((b) => setField(b, key, patch));
  }

  setType(type: string): void {
    const key = this.key();
    this.store.edit((b) => setFieldType(b, key, type as FieldType));
  }

  calc(key: string, expression: string) {
    return (b: Parameters<typeof setCalculated>[0]) => setCalculated(b, key, expression);
  }

  sensitive(key: string, on: boolean) {
    return (b: Parameters<typeof setSensitive>[0]) => setSensitive(b, key, on);
  }

  copyThrough(reference: string): void {
    this.copy(reference ? { reference, field: '' } : undefined);
  }

  copy(copyFrom: FieldDef['copyFrom']): void {
    const key = this.key();
    this.store.edit((b) => setCopyFrom(b, key, copyFrom));
  }

  rollup(patch: Partial<RollupDef> | undefined): void {
    const key = this.key();
    const current = this.field()?.rollup;
    const next = patch && ({ ...(current ?? { recordType: '', reference: '', measure: 'count' }), ...patch } as RollupDef);
    this.store.edit((b) => setRollup(b, key, next));
  }

  accept(kind: FileKind): void {
    const key = this.key();
    this.store.edit((b) => toggleAccept(b, key, kind));
  }

  setChoice(i: number, patch: Partial<{ value: string; label: string }>): void {
    const choices = (this.field()?.choices ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c));
    this.set({ choices });
  }

  addChoice(): void {
    const choices = this.field()?.choices ?? [];
    let n = choices.length + 1;
    while (choices.some((c) => c.value === `option${n}`)) n++;
    this.set({ choices: [...choices, { value: `option${n}`, label: '' }] });
  }

  moveChoice(i: number, delta: number): void {
    const choices = [...(this.field()?.choices ?? [])];
    const [c] = choices.splice(i, 1);
    choices.splice(i + delta, 0, c!);
    this.set({ choices });
  }

  removeChoice(i: number): void {
    this.set({ choices: (this.field()?.choices ?? []).filter((_, j) => j !== i) });
  }
}
