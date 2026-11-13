import { Component, computed, inject, input, signal } from '@angular/core';
import type { ScriptTry } from '../../../core/builder/http-previews';
import { TranslatePipe } from '../../../services/i18n';
import { PreviewRecord, type ChosenRecord } from './preview-record';
import { PreviewStore } from './preview-store';

type Body = Record<string, unknown>;

const shown = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v));

/** "Try it": runs the draft code in the server's sandbox on a chosen record, without saving, and shows what it changed. */
@Component({
  selector: 'app-script-preview',
  imports: [TranslatePipe, PreviewRecord],
  styleUrl: './preview.css',
  template: `
    <section class="pv" aria-labelledby="script-try-title">
      <h3 class="pv__title" id="script-try-title">{{ 'ui.builder.script.tryTitle' | t }}</h3>
      @if (recordType()) {
        <app-preview-record [fixedType]="recordType()" (changed)="chosen.set($event)" />
      } @else {
        <p class="pv__note">{{ 'ui.builder.script.needsType' | t }}</p>
      }
      <div class="pv__row">
        <button type="button" class="small" [disabled]="running() || !recordType() || !code()" (click)="run()">{{ 'ui.builder.script.try' | t }}</button>
      </div>
      @if (failed(); as f) { <div class="pv__bad" role="alert">{{ f }}</div> }
      @if (result(); as r) {
        <div role="status">
          @if (r.ok) {
            <div class="pv__ok">{{ 'ui.builder.script.ran' | t: { ms: r.durationMs ?? 0 } }}</div>
            @if (r.changed?.length) {
              <ul class="pv__list pv__mono">
                @for (c of r.changed; track c.field) { <li>{{ c.field }}: {{ show(c.before) }} → {{ show(c.after) }}</li> }
              </ul>
            } @else {
              <p class="pv__note">{{ 'ui.builder.script.noChanges' | t }}</p>
            }
          } @else {
            <div class="pv__bad">{{ r.error }}</div>
          }
          @if (r.logs?.length) {
            <h4 class="pv__title">{{ 'ui.builder.script.logs' | t }}</h4>
            <ul class="pv__list pv__mono">@for (l of r.logs; track $index) { <li>{{ l }}</li> }</ul>
          }
        </div>
      }
      <p class="pv__note">{{ 'ui.builder.script.sandbox' | t }}</p>
    </section>
  `,
})
export class ScriptPreview {
  private readonly previews = inject(PreviewStore);
  readonly value = input<unknown>();
  readonly body = input<Body | null>(null);
  readonly chosen = signal<ChosenRecord | null>(null);
  readonly running = signal(false);
  readonly result = signal<ScriptTry | null>(null);
  readonly failed = signal('');
  readonly recordType = computed(() => (typeof this.body()?.['recordType'] === 'string' ? (this.body()!['recordType'] as string) : ''));
  readonly code = computed(() => (typeof this.body()?.['code'] === 'string' ? (this.body()!['code'] as string) : ''));
  readonly show = shown;

  async run(): Promise<void> {
    const b = this.body() ?? {};
    const limit = (k: string) => (typeof b[k] === 'number' ? { [k]: b[k] as number } : {});
    this.running.set(true);
    this.failed.set('');
    const r = await this.previews.tryScript({
      code: this.code(),
      recordType: this.recordType(),
      ...(this.chosen()?.recordId ? { recordId: this.chosen()!.recordId } : {}),
      ...limit('timeoutMs'),
      ...limit('memoryMb'),
    });
    this.running.set(false);
    this.result.set(r.ok ? r.value : null);
    this.failed.set(r.ok ? '' : r.error.message);
  }
}
