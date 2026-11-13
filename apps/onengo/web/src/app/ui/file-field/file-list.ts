import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { fileBadge, formatSize, isImage, isPdf, type FileInfo } from '../../core/fields/files';
import { t } from '../../core/i18n/i18n';
import { Files } from '../../services/files';
import { TranslatePipe } from '../../services/i18n';

type Loaded = { state: 'loading' } | { state: 'ready'; info: FileInfo } | { state: 'failed'; message: string };

/**
 * Stored files: thumbnails for images and PDFs, then one row per file with
 * its name and size, and Download (or Remove while editing). Tapping a
 * thumbnail or a name previews it in place; Back returns to the list.
 */
@Component({
  selector: 'app-file-list',
  imports: [TranslatePipe],
  styles: `
    :host {
      display: block;
    }
    .file-list__thumbs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 4px 0 8px;
    }
    .file-list__thumb {
      width: 64px;
      height: 64px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 0;
      overflow: hidden;
      display: grid;
      place-items: center;
      font: 700 0.7rem/1 inherit;
      color: #b91c1c;
      background: #fef2f2;
      cursor: pointer;
    }
    .file-list__thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .file-list__row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    }
    .file-list__badge {
      flex: 0 0 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      font-size: 0.58rem;
      font-weight: 700;
      background: #f1f5f9;
      color: #475569;
      overflow: hidden;
    }
    .file-list__badge img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .file-list__main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .file-list__name {
      border: 0;
      padding: 0;
      background: none;
      text-align: start;
      font: 600 0.8rem/1.3 inherit;
      color: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-list__name[data-previewable='true'] {
      cursor: pointer;
      color: var(--primary-700, #1d4ed8);
    }
    .file-list__meta {
      font-size: 0.72rem;
      color: #64748b;
    }
    .file-list__meta[data-error='true'] {
      color: #b91c1c;
    }
    .file-list__preview img {
      display: block;
      width: 100%;
      max-height: 60vh;
      object-fit: contain;
      border-radius: 10px;
      background: #f8fafc;
      touch-action: pinch-zoom;
    }
    .file-list__card {
      text-align: center;
      padding: 22px 12px;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
    }
    .file-list__card .file-list__badge {
      margin: 0 auto 10px;
      width: 48px;
      height: 48px;
      color: #b91c1c;
      background: #fef2f2;
    }
    .file-list__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
  `,
  template: `
    @if (previewing(); as p) {
      <div class="file-list__preview" role="region" [attr.aria-label]="p.name">
        @if (isImage(p)) {
          @if (images()[p.id]; as src) {
            <img [src]="src" [alt]="p.name" />
          } @else {
            <div class="file-list__meta">{{ 'ui.common.loading' | t }}</div>
          }
        } @else {
          <div class="file-list__card">
            <div class="file-list__badge">{{ badge(p) }}</div>
            <b>{{ p.name }}</b>
            <div class="file-list__meta">{{ size(p.size) }}</div>
          </div>
        }
        @if (problem()) {
          <div class="file-list__meta" data-error="true" role="alert">{{ problem() }}</div>
        }
        <div class="file-list__actions">
          <button type="button" class="app-btn app-btn--ghost" (click)="closePreview()">{{ 'ui.common.back' | t }}</button>
          @if (isPdf(p)) {
            <button type="button" class="app-btn" [disabled]="!pdfUrl()" (click)="openPdf()">{{ 'ui.fields.files.open' | t }}</button>
          }
          <button type="button" class="app-btn app-btn--primary" (click)="download(p.id)">{{ 'ui.fields.files.download' | t }}</button>
        </div>
      </div>
    } @else {
      @if (previewable().length) {
        <div class="file-list__thumbs">
          @for (f of previewable(); track f.id) {
            <button type="button" class="file-list__thumb" [attr.aria-label]="f.name" (click)="preview(f)">
              @if (images()[f.id]; as src) {
                <img [src]="src" alt="" />
              } @else {
                {{ badge(f) }}
              }
            </button>
          }
        </div>
      }
      @for (id of ids(); track id) {
        @let info = infoOf(id);
        <div class="file-list__row">
          <span class="file-list__badge" aria-hidden="true">
            @if (images()[id]; as src) {
              <img [src]="src" alt="" />
            } @else if (info) {
              {{ badge(info) }}
            }
          </span>
          <div class="file-list__main">
            @if (info) {
              <button type="button" class="file-list__name" [attr.data-previewable]="canPreview(info)" [disabled]="!canPreview(info)" (click)="preview(info)">
                {{ info.name }}
              </button>
              <span class="file-list__meta">{{ size(info.size) }}</span>
            } @else if (failureOf(id); as failure) {
              <span class="file-list__meta" data-error="true">{{ failure }}</span>
            } @else {
              <span class="file-list__meta">{{ 'ui.common.loading' | t }}</span>
            }
          </div>
          @if (removable()) {
            <button type="button" class="app-btn app-btn--ghost" [attr.aria-label]="'ui.common.remove' | t" (click)="remove.emit(id)">✕</button>
          } @else if (info) {
            <button type="button" class="app-btn app-btn--ghost" (click)="download(id)">{{ 'ui.fields.files.download' | t }}</button>
          }
        </div>
      }
    }
  `,
})
export class AttachedFiles {
  private readonly files = inject(Files);
  readonly ids = input.required<string[]>();
  /** In a form: rows offer Remove instead of Download. */
  readonly removable = input(false);
  readonly remove = output<string>();

  readonly loaded = signal<Record<string, Loaded>>({});
  readonly images = signal<Record<string, string>>({});
  readonly previewing = signal<FileInfo | null>(null);
  readonly pdfUrl = signal<string | null>(null);
  readonly problem = signal('');
  readonly previewable = computed(() =>
    this.ids()
      .map((id) => this.loaded()[id])
      .flatMap((l) => (l?.state === 'ready' && this.canPreview(l.info) ? [l.info] : [])),
  );
  readonly isImage = isImage;
  readonly isPdf = isPdf;
  readonly badge = fileBadge;
  readonly size = formatSize;

  constructor() {
    effect(() => {
      const ids = this.ids();
      untracked(() => ids.forEach((id) => this.load(id)));
    });
    inject(DestroyRef).onDestroy(() => this.releasePdf());
  }

  infoOf(id: string): FileInfo | null {
    const l = this.loaded()[id];
    return l?.state === 'ready' ? l.info : null;
  }

  failureOf(id: string): string | null {
    const l = this.loaded()[id];
    return l?.state === 'failed' ? l.message : null;
  }

  canPreview(f: FileInfo): boolean {
    return isImage(f) || isPdf(f);
  }

  preview(f: FileInfo): void {
    this.problem.set('');
    this.previewing.set(f);
    if (isPdf(f)) {
      this.files.objectUrl(f.id).then(
        (url) => (this.previewing()?.id === f.id ? this.pdfUrl.set(url) : this.files.release(url)),
        (e: unknown) => this.problem.set(message(e)),
      );
    }
  }

  closePreview(): void {
    this.releasePdf();
    this.previewing.set(null);
  }

  openPdf(): void {
    const url = this.pdfUrl();
    if (url) this.files.open(url);
  }

  download(id: string): void {
    this.problem.set('');
    this.files.download(id).catch((e: unknown) => this.problem.set(message(e)));
  }

  private releasePdf(): void {
    const url = this.pdfUrl();
    if (url) this.files.release(url);
    this.pdfUrl.set(null);
  }

  private load(id: string): void {
    if (this.loaded()[id]) return;
    this.loaded.update((m) => ({ ...m, [id]: { state: 'loading' } }));
    this.files.info(id).then(
      (info) => {
        this.loaded.update((m) => ({ ...m, [id]: { state: 'ready', info } }));
        if (isImage(info)) this.files.image(id).then((src) => this.images.update((m) => ({ ...m, [id]: src })), () => undefined);
      },
      (e: unknown) => this.loaded.update((m) => ({ ...m, [id]: { state: 'failed', message: message(e) } })),
    );
  }
}

function message(e: unknown): string {
  return e instanceof Error && e.message ? e.message : t('ui.common.somethingWentWrong');
}
