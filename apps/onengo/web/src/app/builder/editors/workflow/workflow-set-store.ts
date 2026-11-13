import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { newDefinitionBody } from '../../../core/builder/catalogue';
import { appliesTo, newWorkflow, workflowSetChecks, type WorkflowRole } from '../../../core/builder/ops/workflow';
import { workflowSetRows } from '../../../core/builder/workflow-view';
import { toKey } from '../../../core/fields/fields';
import { t } from '../../../core/i18n/i18n';
import type { CatalogueItem, WorkflowBody } from '../../../core/models';
import { kindName } from '../../../core/starters';
import { I18n } from '../../../services/i18n';
import { BuilderStore } from '../../builder-store';

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

/**
 * Every workflow of one record type (drafts where there are any), with the
 * rules across them and the "Applies to" summary. The workflow being edited
 * is taken from its live draft. Adding a workflow saves its first draft and
 * opens it. Provided by the screen that shows the workflows list.
 */
@Injectable()
export class WorkflowSetStore {
  private readonly builder = inject(BuilderStore);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);
  private readonly saved = signal<WorkflowBody[]>([]);
  private catalogue: CatalogueItem[] = [];

  readonly recordType = signal('');
  /** The workflow open in the editor, if any. */
  readonly current = signal<WorkflowBody | null>(null);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly adding = signal(false);
  readonly addError = signal('');
  readonly busy = signal(false);

  readonly set = computed(() => {
    const cur = this.current();
    const others = this.saved().filter((w) => w.key !== cur?.key);
    return cur && cur.recordType === this.recordType() ? [...others, cur] : others;
  });
  readonly rows = computed(() => (this.i18n.locale(), workflowSetRows(this.set())));
  readonly checks = computed(() => (this.i18n.locale(), workflowSetChecks(this.set())));
  readonly summary = computed(() => (this.i18n.locale(), appliesTo(this.set())));

  constructor() {
    effect(() => {
      const recordType = this.recordType();
      untracked(() => {
        if (recordType) void this.load(recordType);
        else this.saved.set([]);
      });
    });
  }

  async load(recordType: string): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      this.catalogue = await this.builder.gateway.catalogue();
      const details = await Promise.all(
        this.catalogue.filter((i) => i.kind === 'workflow').map((i) => this.builder.gateway.detail('workflow', i.key).catch(() => null)),
      );
      const bodies = details.map((d) => (d?.draft?.body ?? d?.published?.body ?? d?.shipped?.base) as WorkflowBody | undefined);
      if (this.recordType() === recordType) this.saved.set(bodies.filter((b): b is WorkflowBody => b?.recordType === recordType));
    } catch {
      if (this.recordType() === recordType) this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  open(key: string): void {
    if (key === this.current()?.key) return;
    this.builder.flush();
    void this.router.navigate(['/builder', 'workflow', key]);
  }

  startAdding(): void {
    this.addError.set('');
    this.adding.set(true);
  }

  cancelAdding(): void {
    this.adding.set(false);
  }

  /** Saves the first draft of a new workflow for the record type, then opens it. */
  async add(name: string, role: WorkflowRole): Promise<void> {
    const key = toKey(name);
    if (!key) return this.addError.set(t('ui.builder.catalogue.nameRequired'));
    if (this.catalogue.some((i) => i.kind === 'workflow' && i.key === key)) {
      return this.addError.set(t('ui.builder.exists', { kind: kindName('workflow').toLowerCase(), key }));
    }
    this.busy.set(true);
    this.addError.set('');
    try {
      const starter = newDefinitionBody('workflow', key, name, { recordType: this.recordType() }) as unknown as WorkflowBody;
      await this.builder.gateway.saveDraft('workflow', key, newWorkflow(starter, this.set(), role));
      this.adding.set(false);
      this.builder.flush();
      await this.router.navigate(['/builder', 'workflow', key]);
      await this.load(this.recordType());
    } catch (e) {
      this.addError.set(messageOf(e, t('ui.common.somethingWentWrong')));
    } finally {
      this.busy.set(false);
    }
  }
}
