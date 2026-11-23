import { Component, Injectable, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { failure } from '../../../core/admin/roles';
import { t } from '../../../core/i18n/i18n';
import type { DocumentSignatories } from '../../../core/organisation/organisation';
import { movedSignatory, notInSet, withSignatory, withoutSignatory } from '../../../core/organisation/signatory-sets';
import { TranslatePipe } from '../../../services/i18n';
import { Organisation } from '../../../services/organisation';
import { Btn } from '@onengo/web-kit';

type Person = DocumentSignatories['signatories'][number];

/** One document's ordered signatories, read from and saved to the organisation. */
@Injectable()
export class SignatoriesPanelStore {
  private readonly org = inject(Organisation).gateway;
  readonly documentKey = signal('');
  readonly roster = signal<Person[]>([]);
  readonly ids = signal<string[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');

  private readonly byId = computed(() => new Map(this.roster().map((person) => [person.id, person])));
  private label(person: Person): string {
    return `${person.name}, ${person.designation}`;
  }
  /** The chosen signatories, in print order. */
  readonly named = computed(() => this.ids().flatMap((id) => (this.byId().get(id) ? [{ id, label: this.label(this.byId().get(id)!) }] : [])));
  /** People not already chosen, for the add box. */
  readonly available = computed(() => notInSet(this.roster(), this.ids()).map((person) => ({ id: person.id, label: this.label(person) })));

  async load(documentKey: string): Promise<void> {
    this.documentKey.set(documentKey);
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      this.apply(await this.org.documentSignatories());
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.loading.set(false);
    }
  }

  add(id: string): void {
    this.ids.set(withSignatory(this.ids(), id));
  }

  remove(index: number): void {
    this.ids.set(withoutSignatory(this.ids(), index));
  }

  move(index: number, delta: number): void {
    this.ids.set(movedSignatory(this.ids(), index, delta));
  }

  async save(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      this.apply(await this.org.saveDocumentSignatories(this.documentKey(), this.ids()));
      this.notice.set(t('ui.builder.signatories.saved'));
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.busy.set(false);
    }
  }

  private apply(result: DocumentSignatories): void {
    this.roster.set(result.signatories);
    this.ids.set(result.sets[this.documentKey()] ?? []);
  }
}

/**
 * The signatories a report or a receipt rule prints, chosen under its Visual
 * tab. A report with none prints no signature; a receipt rule with none cannot
 * issue a receipt.
 */
@Component({
  selector: 'app-signatories-panel',
  imports: [Btn, RouterLink, TranslatePipe],
  providers: [SignatoriesPanelStore],
  styles: `
    .sigs {
      display: grid;
      gap: 8px;
      margin-top: 16px;
    }
    .sigs h2 {
      margin: 0;
      font-size: 1rem;
    }
    .sigs__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .sigs__row > span {
      flex: 1;
      min-width: 0;
    }
  `,
  template: `
    <section class="sigs" aria-labelledby="builder-signatories-title">
      <h2 id="builder-signatories-title">{{ 'ui.builder.signatories.title' | t }}</h2>
      <p class="muted">{{ (receipts() ? 'ui.builder.signatories.receiptHelp' : 'ui.builder.signatories.reportHelp') | t }}</p>
      @if (store.error()) {
        <div class="notice error" role="alert">{{ store.error() }}</div>
      }
      @if (store.notice()) {
        <div class="notice ok" role="status">{{ store.notice() }}</div>
      }
      @if (store.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (!store.roster().length) {
        <p class="muted">
          {{ 'ui.builder.signatories.noPeople' | t }}
          <a routerLink="/admin/organisation/signatories">{{ 'ui.builder.signatories.openScreen' | t }}</a>
        </p>
      } @else {
        @if (store.named().length) {
          <ol>
            @for (item of store.named(); track item.id; let i = $index) {
              <li class="sigs__row">
                <span>{{ item.label }}</span>
                <button appBtn size="sm" type="button" [disabled]="store.busy() || i === 0" (click)="store.move(i, -1)">{{ 'ui.builder.signatories.earlier' | t }}</button>
                <button appBtn size="sm" type="button" [disabled]="store.busy() || i === store.named().length - 1" (click)="store.move(i, 1)">{{ 'ui.builder.signatories.later' | t }}</button>
                <button appBtn size="sm" type="button" [disabled]="store.busy()" (click)="store.remove(i)">{{ 'ui.builder.signatories.remove' | t }}</button>
              </li>
            }
          </ol>
        } @else {
          <p class="muted">{{ (receipts() ? 'ui.builder.signatories.noneReceipt' : 'ui.builder.signatories.none') | t }}</p>
        }
        <label>
          <span class="muted">{{ 'ui.builder.signatories.add' | t }}</span>
          <select [disabled]="store.busy() || store.named().length >= 4" (change)="addFrom($event)">
            <option value=""></option>
            @for (choice of store.available(); track choice.id) {
              <option [value]="choice.id">{{ choice.label }}</option>
            }
          </select>
        </label>
        <div class="sigs__row">
          <span class="muted">{{ 'ui.builder.signatories.limit' | t }}</span>
          <button appBtn="primary" type="button" [disabled]="store.busy()" (click)="store.save()">
            {{ (store.busy() ? 'ui.common.saving' : 'ui.builder.signatories.save') | t }}
          </button>
        </div>
      }
    </section>
  `,
})
export class SignatoriesPanel {
  readonly store = inject(SignatoriesPanelStore);
  /** `receipt:<rule>` or `report:<report>`. */
  readonly documentKey = input.required<string>();
  /** True for a receipt rule, which cannot issue a receipt until it has a signatory. */
  readonly receipts = input(false);

  constructor() {
    effect(() => {
      const key = this.documentKey();
      untracked(() => void this.store.load(key));
    });
  }

  addFrom(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.store.add(select.value);
    select.value = '';
  }
}
