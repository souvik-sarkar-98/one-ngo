import { Component, computed, input, output, signal } from '@angular/core';
import { t } from '../../core/i18n/i18n';
import {
  EMPTY_LOCATION,
  accuracyText,
  asLocation,
  coordinates,
  fromPosition,
  isLowAccuracy,
  locationProblems,
  mapsUrl,
  type LocationDraft,
  type LocationValue,
} from '../../core/fields/location';
import type { FormValue } from '../../core/records/record/forms';
import { TranslatePipe } from '../../services/i18n';
import type { CfFieldDef } from '../cf-types';

/**
 * A location field: "Use my location" (the browser's Geolocation, with its
 * accuracy) or, unless the field turns them off, typed coordinates, an
 * optional label, and an "Open in maps" link the person may follow. No map is drawn and nothing is loaded from a
 * map service.
 */
@Component({
  selector: 'app-location-field',
  imports: [TranslatePipe],
  styles: `
    :host {
      display: block;
    }
    .location-field__box {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
    }
    .location-field__box[data-invalid='true'] {
      border-color: #ba1a1a;
    }
    .location-field__row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 0.78rem;
    }
    .location-field__spacer {
      flex: 1;
    }
    .location-field__coords {
      font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
      font-size: 0.85rem;
    }
    .location-field__badge {
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 0.68rem;
      font-weight: 700;
      background: #dcfce7;
      color: #15803d;
    }
    .location-field__badge[data-low='true'] {
      background: #fef3c7;
      color: #b45309;
    }
    .location-field__link {
      border: 0;
      padding: 0;
      background: none;
      font: inherit;
      color: var(--primary-700, #1d4ed8);
      text-decoration: underline;
      cursor: pointer;
    }
    .location-field__muted {
      color: #64748b;
      font-size: 0.75rem;
    }
    .location-field__problem {
      color: #b91c1c;
      font-size: 0.75rem;
    }
    .location-field__inputs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .location-field__input {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.75rem;
      color: #374151;
    }
    .location-field__input input {
      height: 40px;
      padding: 0 10px;
      border: 1px solid #79747e;
      border-radius: 4px;
      font: inherit;
      font-size: 0.875rem;
    }
    .location-field__input input[aria-invalid='true'] {
      border-color: #ba1a1a;
    }
  `,
  template: `
    @let f = field();
    @let d = draft();
    <div class="location-field__box" [attr.data-invalid]="invalid()">
      @if (shown(); as l) {
        <div class="location-field__row">
          <span class="location-field__coords">{{ coords(l) }}</span>
          <span class="location-field__spacer"></span>
          @if (accuracyOf(l); as acc) {
            <span class="location-field__badge" [attr.data-low]="low(l.accuracy)">{{ acc }}</span>
            @if (low(l.accuracy)) {
              <div class="location-field__problem" role="status" style="flex-basis: 100%">{{ 'ui.fields.location.lowAccuracy' | t: { accuracy: acc } }}</div>
            }
          }
        </div>
        <div class="location-field__row">
          <a class="location-field__link" [href]="maps(l)" target="_blank" rel="noopener noreferrer">{{ 'ui.fields.location.openInMaps' | t }} ↗</a>
          <span class="location-field__spacer"></span>
          @if (!f.readOnly) {
            <button type="button" class="location-field__link" [disabled]="locating()" (click)="locate()">{{ 'ui.fields.location.useMine' | t }}</button>
            @if (canType()) {
              <button type="button" class="location-field__link" (click)="typing.set(true)">{{ 'ui.fields.location.typeCoordinates' | t }}</button>
            }
            <button type="button" class="location-field__link" (click)="clear()">{{ 'ui.common.clear' | t }}</button>
          }
        </div>
      } @else if (f.readOnly) {
        <span class="location-field__muted">—</span>
      } @else if (typing() && canType()) {
        <div class="location-field__inputs">
          <label class="location-field__input">
            {{ 'ui.fields.location.latitude' | t }}
            <input [id]="fieldId()" inputmode="decimal" [value]="d.lat" [attr.aria-invalid]="!!problems().lat" (input)="set({ lat: text($event), accuracy: '' })" />
            @if (problems().lat) {
              <span class="location-field__problem">{{ problems().lat }}</span>
            }
          </label>
          <label class="location-field__input">
            {{ 'ui.fields.location.longitude' | t }}
            <input inputmode="decimal" [value]="d.lng" [attr.aria-invalid]="!!problems().lng" (input)="set({ lng: text($event), accuracy: '' })" />
            @if (problems().lng) {
              <span class="location-field__problem">{{ problems().lng }}</span>
            }
          </label>
        </div>
        <div class="location-field__row">
          <button type="button" class="location-field__link" [disabled]="locating()" (click)="locate()">{{ 'ui.fields.location.useMine' | t }}</button>
          @if (located()) {
            <span class="location-field__spacer"></span>
            <button type="button" class="location-field__link" (click)="typing.set(false)">{{ 'ui.common.close' | t }}</button>
          }
        </div>
      } @else {
        <button type="button" class="app-btn" [id]="fieldId()" [disabled]="locating()" (click)="locate()" style="align-self: flex-start">
          ◎ {{ 'ui.fields.location.useMine' | t }}
        </button>
        @if (canType()) {
          <button type="button" class="location-field__link" style="align-self: flex-start" (click)="typing.set(true)">{{ 'ui.fields.location.typeCoordinates' | t }}</button>
        }
      }
      @if (problem()) {
        <div class="location-field__problem" role="alert">{{ problem() }}</div>
      }
    </div>
    @if (!f.readOnly) {
      <label class="location-field__input" style="margin-top: 8px">
        {{ 'ui.fields.location.label' | t }}
        <input [value]="d.label" (input)="set({ label: text($event) })" />
      </label>
    } @else if (located()?.label; as label) {
      <div class="location-field__muted">{{ label }}</div>
    }
  `,
})
export class LocationField {
  readonly field = input.required<CfFieldDef>();
  readonly fieldId = input.required<string>();
  readonly value = input<FormValue>(null);
  readonly invalid = input(false);
  readonly valueChange = output<LocationDraft>();

  readonly typing = signal(false);
  readonly canType = computed(() => this.field().typedCoordinates !== false);
  readonly locating = signal(false);
  readonly problem = signal('');
  readonly draft = computed<LocationDraft>(() => {
    const v = this.value();
    return v && typeof v === 'object' && !Array.isArray(v) && 'lat' in v ? { ...EMPTY_LOCATION, ...(v as Partial<LocationDraft>) } : { ...EMPTY_LOCATION };
  });
  readonly located = computed(() => asLocation(this.draft()));
  /** The position as found or typed, unless coordinates are being typed. */
  readonly shown = computed(() => (this.typing() ? null : this.located()));
  readonly problems = computed(() => locationProblems(this.draft()));
  readonly coords = coordinates;
  readonly low = isLowAccuracy;
  readonly maps = mapsUrl;

  accuracyOf(l: LocationValue): string | null {
    return l.accuracy === undefined ? null : accuracyText(l.accuracy);
  }

  text(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  set(change: Partial<LocationDraft>): void {
    this.valueChange.emit({ ...this.draft(), ...change });
  }

  clear(): void {
    this.problem.set('');
    this.typing.set(false);
    this.valueChange.emit({ ...EMPTY_LOCATION, label: this.draft().label });
  }

  locate(): void {
    this.problem.set('');
    if (!('geolocation' in navigator)) {
      this.problem.set(t('ui.fields.location.unavailable'));
      this.typing.set(true);
      return;
    }
    this.locating.set(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.locating.set(false);
        this.typing.set(false);
        this.valueChange.emit(fromPosition(pos.coords, this.draft().label));
      },
      (err) => {
        this.locating.set(false);
        this.problem.set(t(err.code === err.PERMISSION_DENIED ? 'ui.fields.location.denied' : 'ui.fields.location.unavailable'));
        this.typing.set(true);
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }
}
