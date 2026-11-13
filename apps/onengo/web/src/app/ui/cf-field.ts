import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { FormValue, FormValues } from '../core/records/record/forms';
import { TranslatePipe } from '../services/i18n';
import type { CfFieldDef, CfFieldType } from './cf-types';
import { FileField } from './file-field/file-field';
import { LocationField } from './location-field/location-field';
import { RecordPicker } from './record-picker';
import { RichTextField } from './rich-text-field/rich-text-field';
import { SignatureField } from './signature-field/signature-field';

const CONTROLS = new Set<CfFieldType>(['file', 'location', 'signature', 'richText']);

function toDate(v: FormValue | undefined): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y!, m! - 1, d);
}

function fromDate(d: Date | null): string {
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One form field, drawn with the same Material controls and markup the list toolkit used. */
@Component({
  selector: 'cf-field',
  imports: [
    FormsModule,
    MatCheckboxModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    RecordPicker,
    TranslatePipe,
    FileField,
    LocationField,
    SignatureField,
    RichTextField,
  ],
  styleUrl: './styles/cf-field.css',
  styles: `
    .cf-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .cf-pill {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.75rem;
      background: var(--primary-100, #e0e7ff);
      color: var(--primary-700, #3730a3);
    }
  `,
  template: `
    @let f = field();
    @switch (layout()) {
      @case ('boolean') {
        <div class="cf-boolean-field" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <mat-checkbox [id]="fieldId()" [attr.aria-invalid]="error() ? 'true' : null" [attr.aria-describedby]="error() ? errorId() : null" [ngModel]="boolValue()" [disabled]="f.readOnly" (ngModelChange)="emit($event)">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </mat-checkbox>
          @if (f.hint) {
            <div class="cf-field-hint">{{ f.hint }}</div>
          }
          @if (error()) {
            <div class="mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @case ('textarea') {
        <div class="cf-field-block" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <label [for]="fieldId()" class="cf-field-label">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </label>
          <mat-form-field appearance="outline" class="cf-field" subscriptSizing="dynamic" [class.cf-field--invalid]="!!error()">
            <textarea
              matInput
              [id]="fieldId()"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? errorId() : null"
              [name]="f.key"
              rows="4"
              [placeholder]="f.placeholder ?? ''"
              [ngModel]="textValue()"
              [readonly]="f.readOnly"
              (ngModelChange)="emit($event)"
            ></textarea>
            @if (f.hint) {
              <mat-hint>{{ f.hint }}</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @case ('select') {
        <div class="cf-field-block" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <label [for]="fieldId()" class="cf-field-label">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </label>
          <mat-form-field appearance="outline" class="cf-field" subscriptSizing="dynamic" [class.cf-field--invalid]="!!error()">
            <mat-select [id]="fieldId()" [aria-label]="f.label" [attr.aria-invalid]="error() ? 'true' : null" [attr.aria-describedby]="error() ? errorId() : null" [ngModel]="textValue()" [disabled]="f.readOnly" [placeholder]="f.placeholder ?? ''" (ngModelChange)="emit($event)">
              @for (opt of f.options; track opt.key) {
                <mat-option [value]="opt.key">{{ opt.label }}</mat-option>
              }
            </mat-select>
            @if (f.hint) {
              <mat-hint>{{ f.hint }}</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @case ('multiselect') {
        <div class="cf-field-block" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <label [for]="fieldId()" class="cf-field-label">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </label>
          <mat-form-field appearance="outline" class="cf-field" subscriptSizing="dynamic" [class.cf-field--invalid]="!!error()">
            <mat-select multiple [id]="fieldId()" [aria-label]="f.label" [attr.aria-invalid]="error() ? 'true' : null" [attr.aria-describedby]="error() ? errorId() : null" [ngModel]="multiValue()" [disabled]="f.readOnly" (ngModelChange)="emit($event)">
              <mat-select-trigger>
                <span class="cf-pills">
                  @for (p of pills(); track p.key) {
                    <span class="cf-pill">{{ p.label }}</span>
                  }
                </span>
              </mat-select-trigger>
              @for (opt of f.options; track opt.key) {
                <mat-option [value]="opt.key">{{ opt.label }}</mat-option>
              }
            </mat-select>
            @if (f.hint) {
              <mat-hint>{{ f.hint }}</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @case ('date') {
        <div class="cf-field-block" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <label [for]="fieldId()" class="cf-field-label">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </label>
          <mat-form-field appearance="outline" class="cf-field cf-date-field" subscriptSizing="dynamic" [class.cf-field--invalid]="!!error()">
            <input
              matInput
              [id]="fieldId()"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? errorId() : null"
              [name]="f.key"
              [matDatepicker]="datePicker"
              [placeholder]="f.placeholder ?? ''"
              [ngModel]="dateModel()"
              [disabled]="f.readOnly"
              (dateChange)="emit(toText($event.value))"
              readonly
              (click)="datePicker.open()"
            />
            <mat-datepicker-toggle matIconSuffix [for]="datePicker" />
            <mat-datepicker #datePicker />
            @if (f.hint) {
              <mat-hint>{{ f.hint }}</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @case ('picker') {
        <app-record-picker [field]="f" [value]="textValue()" [error]="error()" />
      }
      @case ('date_range') {
        <div class="cf-field-block" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <span class="cf-field-label">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </span>
          <mat-form-field appearance="outline" class="cf-field cf-date-range-field" subscriptSizing="dynamic" [class.cf-field--invalid]="!!error()">
            <mat-date-range-input [rangePicker]="dateRangePicker">
              <input matStartDate [attr.aria-invalid]="error() ? 'true' : null" [attr.aria-describedby]="error() ? errorId() : null" [placeholder]="'ui.common.startDate' | t" [ngModel]="rangeStart()" (dateChange)="emitKey(f.key + 'From', toText($event.value))" />
              <input matEndDate [placeholder]="'ui.common.endDate' | t" [ngModel]="rangeEnd()" (dateChange)="emitKey(f.key + 'To', toText($event.value))" />
            </mat-date-range-input>
            <mat-datepicker-toggle matIconSuffix [for]="dateRangePicker" />
            <mat-date-range-picker #dateRangePicker />
            @if (f.hint) {
              <mat-hint>{{ f.hint }}</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @case ('control') {
        <div class="cf-field-block" role="group" [attr.aria-labelledby]="fieldId() + '-label'" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <span class="cf-field-label" [id]="fieldId() + '-label'">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </span>
          @switch (f.type) {
            @case ('file') {
              <app-file-field [field]="f" [fieldId]="fieldId()" [value]="raw()" [invalid]="!!error()" (valueChange)="emit($event)" />
            }
            @case ('location') {
              <app-location-field [field]="f" [fieldId]="fieldId()" [value]="raw()" [invalid]="!!error()" (valueChange)="emit($event)" />
            }
            @case ('signature') {
              <app-signature-field [field]="f" [fieldId]="fieldId()" [value]="raw()" [invalid]="!!error()" (valueChange)="emit($event)" />
            }
            @case ('richText') {
              <app-rich-text-field [field]="f" [fieldId]="fieldId()" [value]="raw()" [invalid]="!!error()" (valueChange)="emit($event)" />
            }
          }
          @if (f.hint) {
            <div class="cf-field-hint">{{ f.hint }}</div>
          }
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
      @default {
        <div class="cf-field-block" [attr.data-cf-field]="f.key" [attr.data-cf-type]="f.type">
          <label [for]="fieldId()" class="cf-field-label">
            {{ f.label }}
            @if (f.required) {
              <span class="cf-required-mark" aria-hidden="true"> *</span>
            }
          </label>
          <mat-form-field appearance="outline" class="cf-field" subscriptSizing="dynamic" [class.cf-field--invalid]="!!error()">
            <input
              matInput
              [id]="fieldId()"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? errorId() : null"
              [name]="f.key"
              [type]="f.type"
              [placeholder]="f.placeholder ?? ''"
              [ngModel]="textValue()"
              [readonly]="f.readOnly"
              (ngModelChange)="emit($event)"
            />
            @if (f.hint) {
              <mat-hint>{{ f.hint }}</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <div class="cf-field-error mat-mdc-form-field-error" role="alert" [id]="errorId()">{{ error() }}</div>
          }
        </div>
      }
    }
  `,
})
export class CfField {
  readonly field = input.required<CfFieldDef>();
  readonly fieldId = input.required<string>();
  readonly values = input.required<FormValues>();
  readonly error = input<string | undefined>();
  readonly valueChange = output<{ key: string; value: FormValue }>();

  /** Files, location, signature and rich text share one frame around their own control. */
  readonly layout = computed(() => (CONTROLS.has(this.field().type) ? 'control' : this.field().type));
  readonly raw = computed(() => this.values()[this.field().key] ?? null);
  readonly pills = computed(() => this.field().options.filter((o) => this.multiValue().includes(o.key)));
  readonly textValue = computed(() => {
    const v = this.raw();
    return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  });
  readonly boolValue = computed(() => this.raw() === true);
  readonly multiValue = computed(() => (Array.isArray(this.raw()) ? (this.raw() as string[]) : []));
  readonly dateModel = computed(() => toDate(this.raw()));
  readonly rangeStart = computed(() => toDate(this.values()[`${this.field().key}From`]));
  readonly rangeEnd = computed(() => toDate(this.values()[`${this.field().key}To`]));

  toText(d: Date | null): string {
    return fromDate(d);
  }

  errorId(): string {
    return `${this.fieldId()}-error`;
  }

  emit(value: unknown): void {
    this.emitKey(this.field().key, value);
  }

  emitKey(key: string, value: unknown): void {
    const v: FormValue =
      typeof value === 'boolean' || Array.isArray(value)
        ? value
        : value === null && CONTROLS.has(this.field().type)
          ? null
          : typeof value === 'object' && value !== null
            ? (value as FormValue)
            : value === null || value === undefined
              ? ''
              : String(value);
    this.valueChange.emit({ key, value: v });
  }
}
