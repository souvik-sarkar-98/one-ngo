import { Component, computed, inject, input, signal } from '@angular/core';
import type { PostingTry } from '../../../core/builder/http-previews';
import { formatMoney } from '../../../core/i18n/i18n';
import type { GatewayError } from '../../../core/records/gateway/gateway';
import { TranslatePipe } from '../../../services/i18n';
import { PreviewRecord, type ChosenRecord } from './preview-record';
import { PreviewStore } from './preview-store';

type Body = Record<string, unknown>;

/** The balance check: the journal lines the draft rule would post for a chosen record, worked out without posting. */
@Component({
  selector: 'app-posting-preview',
  imports: [TranslatePipe, PreviewRecord],
  styleUrl: './preview.css',
  template: `
    <section class="pv" aria-labelledby="posting-try-title">
      <h3 class="pv__title" id="posting-try-title">{{ 'ui.builder.posting.title' | t }}</h3>
      @if (recordType()) {
        <app-preview-record [fixedType]="recordType()" (changed)="chosen.set($event)" />
      }
      <div class="pv__row">
        <button type="button" class="small" [disabled]="running() || !recordType()" (click)="run()">{{ 'ui.builder.posting.check' | t }}</button>
      </div>
      @if (error(); as e) {
        <div class="pv__bad" role="alert">
          {{ e.message }}
          @if (e.issues?.length) { <ul class="pv__list">@for (i of e.issues; track $index) { <li>{{ i.path }}: {{ i.message }}</li> }</ul> }
        </div>
      }
      @if (result(); as r) {
        <div role="status">
          @if (!r.applies) { <p class="pv__note">{{ 'ui.builder.posting.notApplies' | t }}</p> }
          <table class="pv__table">
            <thead>
              <tr>
                <th scope="col">{{ 'ui.builder.schema.prop.side' | t }}</th>
                <th scope="col">{{ 'ui.builder.schema.prop.account' | t }}</th>
                <th scope="col" class="pv__num">{{ 'ui.builder.schema.prop.amount' | t }}</th>
              </tr>
            </thead>
            <tbody>
              @for (l of r.lines; track $index) {
                <tr>
                  <td>{{ 'ui.builder.schema.enum.' + l.side | t }}</td>
                  <td class="pv__mono">{{ l.account ?? '—' }}</td>
                  <td class="pv__num">{{ money(l.amount) }}</td>
                </tr>
              }
            </tbody>
          </table>
          @if (r.balanced && !r.errors.length) {
            <div class="pv__ok">{{ 'ui.builder.posting.balanced' | t: { debit: money(r.debit), credit: money(r.credit) } }}</div>
          } @else if (!r.balanced) {
            <div class="pv__bad">{{ 'ui.builder.posting.unbalanced' | t: { debit: money(r.debit), credit: money(r.credit) } }}</div>
          }
          @if (r.errors.length) {
            <ul class="pv__list pv__bad">@for (i of r.errors; track $index) { <li>{{ i.path }}: {{ i.message }}</li> }</ul>
          }
        </div>
      }
    </section>
  `,
})
export class PostingPreview {
  private readonly previews = inject(PreviewStore);
  readonly value = input<unknown>();
  readonly body = input<Body | null>(null);
  readonly chosen = signal<ChosenRecord | null>(null);
  readonly running = signal(false);
  readonly result = signal<PostingTry | null>(null);
  readonly error = signal<GatewayError | null>(null);
  readonly recordType = computed(() => (typeof this.body()?.['recordType'] === 'string' ? (this.body()!['recordType'] as string) : ''));

  money(v: unknown): string {
    return typeof v === 'number' && Number.isFinite(v) ? formatMoney(v) : '—';
  }

  async run(): Promise<void> {
    this.running.set(true);
    const r = await this.previews.tryPostingRule({ rule: this.body(), ...(this.chosen()?.recordId ? { recordId: this.chosen()!.recordId } : {}) });
    this.running.set(false);
    this.result.set(r.ok ? r.value : null);
    this.error.set(r.ok ? null : r.error);
  }
}
