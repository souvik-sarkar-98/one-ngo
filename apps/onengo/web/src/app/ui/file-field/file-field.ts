import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { UPLOADING, acceptAttribute, fileHint, fileIds, fileProblem, formatSize, isUploading, kindsOf } from '../../core/fields/files';
import { t } from '../../core/i18n/i18n';
import type { FormValue } from '../../core/records/record/forms';
import { Files } from '../../services/files';
import { TranslatePipe } from '../../services/i18n';
import type { CfFieldDef } from '../cf-types';
import { AttachedFiles } from './file-list';

interface Upload {
  local: string;
  name: string;
  size: number;
  progress: number;
  error?: string;
  abort?: AbortController;
}

let next = 0;

/**
 * A file field: choose files, drag them in, or take a photo on a phone (the
 * file picker's camera, not the camera API). Each file uploads at once with
 * its own progress and can be cancelled; the form value holds a placeholder
 * per upload so saving waits for them. Kinds and size come from the field.
 */
@Component({
  selector: 'app-file-field',
  imports: [AttachedFiles, TranslatePipe],
  styles: `
    :host {
      display: block;
    }
    .file-field__drop {
      border: 1.5px dashed #94a3b8;
      border-radius: 12px;
      padding: 18px 12px;
      text-align: center;
      font-size: 0.8rem;
      color: #475569;
      background: #f8fafc;
    }
    .file-field__drop[data-over='true'] {
      border-color: var(--primary-500, #3b82f6);
      background: var(--primary-50, #eff6ff);
    }
    .file-field__drop[data-invalid='true'] {
      border-color: #ba1a1a;
    }
    .file-field__link {
      border: 0;
      padding: 0;
      background: none;
      font: inherit;
      color: var(--primary-700, #1d4ed8);
      text-decoration: underline;
      cursor: pointer;
    }
    .file-field__buttons {
      display: none;
      gap: 8px;
    }
    .file-field__buttons .app-btn {
      flex: 1;
    }
    @media (pointer: coarse) {
      .file-field__drop {
        display: none;
      }
      .file-field__buttons {
        display: flex;
      }
    }
    .file-field__hint {
      margin: 6px 0 4px;
      font-size: 0.72rem;
      color: #64748b;
    }
    .file-field__row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    }
    .file-field__main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 0.8rem;
    }
    .file-field__name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-field__meta {
      font-size: 0.72rem;
      color: #64748b;
    }
    .file-field__meta[data-error='true'] {
      color: #b91c1c;
    }
    .file-field__progress {
      height: 4px;
      border-radius: 2px;
      background: #e2e8f0;
      overflow: hidden;
    }
    .file-field__progress i {
      display: block;
      height: 100%;
      background: var(--primary-500, #3b82f6);
    }
    input[type='file'] {
      display: none;
    }
  `,
  template: `
    @let f = field();
    @if (!f.readOnly) {
      <div
        class="file-field__drop"
        [attr.data-over]="over()"
        [attr.data-invalid]="invalid()"
        (dragover)="dragOver($event)"
        (dragleave)="over.set(false)"
        (drop)="dropped($event)">
        {{ 'ui.fields.files.dropHere' | t }}
        <button type="button" class="file-field__link" [id]="fieldId()" (click)="picker.click()">{{ 'ui.fields.files.chooseFiles' | t }}</button>
      </div>
      <div class="file-field__buttons">
        <button type="button" class="app-btn" (click)="picker.click()">{{ 'ui.fields.files.chooseFiles' | t }}</button>
        @if (takesPhotos()) {
          <button type="button" class="app-btn" (click)="camera.click()">{{ 'ui.fields.files.takePhoto' | t }}</button>
        }
      </div>
      <input #picker type="file" [accept]="accept()" [multiple]="!!f.multiple" (change)="chosen(picker)" />
      <input #camera type="file" accept="image/*" capture="environment" (change)="chosen(camera)" />
      <div class="file-field__hint">{{ hint() }}</div>
    }
    @if (saved().length) {
      <app-file-list [ids]="saved()" [removable]="!f.readOnly" (remove)="removeFile($event)" />
    } @else if (f.readOnly && !uploads().length) {
      <div class="file-field__meta">—</div>
    }
    @for (u of uploads(); track u.local) {
      <div class="file-field__row">
        <div class="file-field__main">
          <span class="file-field__name">{{ u.name }}</span>
          @if (!u.error) {
            <div class="file-field__progress" role="progressbar" [attr.aria-valuenow]="percent(u)" aria-valuemin="0" aria-valuemax="100"><i [style.width.%]="percent(u)"></i></div>
          }
          <span class="file-field__meta" [attr.data-error]="!!u.error" [attr.role]="u.error ? 'alert' : null">
            {{ u.error ?? (size(u.size) + ' · ' + percent(u) + '%') }}
          </span>
        </div>
        <button type="button" class="app-btn app-btn--ghost" [attr.aria-label]="'ui.common.remove' | t" (click)="cancel(u)">
          ✕
        </button>
      </div>
    }
  `,
})
export class FileField {
  private readonly files = inject(Files);
  readonly field = input.required<CfFieldDef>();
  readonly fieldId = input.required<string>();
  readonly value = input<FormValue>(null);
  readonly invalid = input(false);
  readonly valueChange = output<string[]>();

  readonly uploads = signal<Upload[]>([]);
  readonly over = signal(false);
  private last: { from: FormValue; ids: string[] } | null = null;
  private readonly ids = computed(() => fileIds(this.value()));
  readonly saved = computed(() => this.ids().filter((id) => !isUploading(id)));
  readonly accept = computed(() => acceptAttribute(this.field()));
  readonly hint = computed(() => fileHint(this.field()));
  readonly takesPhotos = computed(() => kindsOf(this.field()).includes('image'));
  readonly size = formatSize;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.uploads().forEach((u) => u.abort?.abort()));
  }

  percent(u: Upload): number {
    return Math.round(u.progress * 100);
  }

  dragOver(e: DragEvent): void {
    e.preventDefault();
    this.over.set(true);
  }

  dropped(e: DragEvent): void {
    e.preventDefault();
    this.over.set(false);
    this.add(Array.from(e.dataTransfer?.files ?? []));
  }

  chosen(el: HTMLInputElement): void {
    this.add(Array.from(el.files ?? []));
    el.value = '';
  }

  removeFile(id: string): void {
    this.emit(this.current().filter((x) => x !== id));
  }

  cancel(u: Upload): void {
    u.abort?.abort();
    this.forget(u.local);
  }

  private add(chosen: File[]): void {
    const f = this.field();
    if (f.readOnly || !chosen.length) return;
    const batch = f.multiple ? chosen : chosen.slice(0, 1);
    if (!f.multiple) {
      this.uploads().forEach((u) => u.abort?.abort());
      this.uploads.set([]);
    }
    let ids = this.current();
    const started: [File, Upload][] = [];
    for (const file of batch) {
      const local = `${++next}`;
      const error = fileProblem(f, file) ?? undefined;
      const upload: Upload = { local, name: file.name, size: file.size, progress: 0, error, abort: error ? undefined : new AbortController() };
      this.uploads.update((list) => [...list, upload]);
      if (error) continue;
      ids = f.multiple ? [...ids, UPLOADING + local] : [UPLOADING + local];
      started.push([file, upload]);
    }
    if (!started.length) return;
    this.emit(ids);
    for (const [file, upload] of started) void this.send(file, upload);
  }

  /** The ids as last emitted, until the form hands the value back, so uploads finishing together do not undo each other. */
  private current(): string[] {
    return this.last && this.last.from === this.value() ? this.last.ids : this.ids();
  }

  private emit(ids: string[]): void {
    this.last = { from: this.value(), ids };
    this.valueChange.emit(ids);
  }

  private async send(file: File, u: Upload): Promise<void> {
    try {
      const info = await this.files.upload(file, file.name, this.field().upload, (p) => this.patch(u.local, { progress: p }), u.abort!.signal);
      this.forget(u.local, info.id);
    } catch (e) {
      if (u.abort?.signal.aborted) return;
      this.replaceToken(u.local, null);
      this.patch(u.local, { error: e instanceof Error && e.message ? e.message : t('ui.common.somethingWentWrong'), abort: undefined });
    }
  }

  private patch(local: string, change: Partial<Upload>): void {
    this.uploads.update((list) => list.map((u) => (u.local === local ? { ...u, ...change } : u)));
  }

  /** Drops the upload row; its placeholder becomes the stored file's id, or goes. */
  private forget(local: string, id: string | null = null): void {
    this.uploads.update((list) => list.filter((u) => u.local !== local));
    this.replaceToken(local, id);
  }

  private replaceToken(local: string, id: string | null): void {
    const token = UPLOADING + local;
    const ids = this.current();
    if (ids.includes(token)) this.emit(ids.flatMap((x) => (x === token ? (id ? [id] : []) : [x])));
  }
}
