import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { FileDownload } from '../core/http/http';
import { t } from '../core/i18n/i18n';
import { asGatewayError } from '../core/records/gateway/gateway';
import { exportList, exportSelected } from '../core/records/list/export';
import { httpImportExportGateway } from '../core/records/gateway/http-gateway';
import { ImportSession, canImportQuietly, listImportNavigator, sampleCsv, type ExportOutcome, type ImportSnapshot } from '../core/records/import/import-session';
import { FileApi } from '../services/file-api';
import { Session } from '../services/session';
import { ListStore } from './list-store';
import type { Notice } from './notice';

/** Hands a file to the browser as a download. */
function saveFile(file: FileDownload): void {
  const url = URL.createObjectURL(file.body);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Angular wrapper around the import session of the open list, and the list's
 * export. It follows the list's address, exposes the session as a signal, and
 * reloads the list when an import finishes.
 */
@Injectable()
export class ImportStore {
  private readonly list = inject(ListStore);
  private readonly session = inject(Session);
  private readonly gateway = httpImportExportGateway(inject(FileApi));
  private readonly current = signal<ImportSession | null>(null);
  private detach: () => void = () => undefined;
  readonly snapshot = signal<ImportSnapshot | null>(null);
  /** The outcome of the last export or download, for the list's notice. */
  readonly notice = signal<Notice | null>(null);
  readonly canQuiet = computed(() => {
    const spec = this.list.spec();
    return !!spec && canImportQuietly(this.session.me()?.permissions ?? [], spec.type.key);
  });

  constructor() {
    effect(() => {
      const spec = this.list.spec();
      untracked(() => {
        this.detach();
        this.current()?.dispose();
        if (!spec) return this.current.set(null);
        const session = new ImportSession(this.gateway, spec.type, listImportNavigator(() => this.list.intents), {
          finished: () => void this.list.intents.controller.reload(),
        });
        this.detach = session.subscribe((s) => this.snapshot.set(s));
        this.current.set(session);
      });
    });
    effect(() => {
      const state = this.list.state();
      const session = this.current();
      if (state && session) untracked(() => void session.follow(state.import, state.importStep));
    });
    this.list.exportList = () => void this.exportList();
    inject(DestroyRef).onDestroy(() => {
      this.detach();
      this.current()?.dispose();
    });
  }

  /** The import session; every step of the import panel goes through it. */
  get imports(): ImportSession {
    return this.current()!;
  }

  async exportList(): Promise<void> {
    const spec = this.list.spec();
    const state = this.list.state();
    if (!spec || !state) return;
    await this.exported(() => exportList(this.gateway, spec, state), this.list.rows().total);
  }

  /** Exports chosen rows only; for the bulk bar. */
  async exportSelected(ids: readonly string[]): Promise<void> {
    const spec = this.list.spec();
    if (spec && ids.length) await this.exported(() => exportSelected(this.gateway, spec.type.key, ids), ids.length);
  }

  async downloadFailed(): Promise<void> {
    try {
      saveFile(await this.imports.failedRows());
    } catch (e) {
      this.notice.set({ level: 'error', message: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
    }
  }

  downloadSample(): void {
    const spec = this.list.spec();
    if (!spec) return;
    const { fileName, text } = sampleCsv(spec.type);
    saveFile({ fileName, body: new Blob([text], { type: 'text/csv' }) });
  }

  private async exported(run: () => Promise<ExportOutcome>, count: number): Promise<void> {
    try {
      const out = await run();
      if (out.kind === 'file') {
        saveFile(out.file);
        this.notice.set({ level: 'success', message: t('ui.imports.exported', { count, file: out.file.fileName }) });
      } else this.notice.set({ level: 'info', message: t('ui.imports.exportQueued') });
    } catch (e) {
      this.notice.set({ level: 'error', message: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
    }
  }
}
