import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { mayOpen } from '../../core/admin/areas';
import {
  MigrationSession,
  booksBalance,
  httpMigrationGateway,
  importableFields,
  isMigrationStep,
  refChoice,
  refOf,
  setField,
  setRef,
  suggestTarget,
  type BooksInput,
  type BooksLine,
  type MigrationColumn,
  type MigrationSnapshot,
  type MigrationStep,
  type MigrationTarget,
} from '../../core/admin/migration';
import type { FileDownload } from '../../core/http/http';
import { t } from '../../core/i18n/i18n';
import type { FieldDef, RuntimeRecordType } from '../../core/models';
import { FileApi } from '../../services/file-api';
import { AdminBase } from '../admin-store';

/** Hands a file to the browser as a download. */
function saveFile(file: FileDownload): void {
  const url = URL.createObjectURL(file.body);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One field of a target as the Map step draws it: the column that fills it, or how a reference finds its record. */
export interface FieldChoice {
  field: FieldDef;
  /** A reference field is filled by old id; other fields by a column. */
  reference: boolean;
  value: string;
}

/**
 * Data migration (`/admin/migration`, `/admin/migration/:id/:step`): the profiles, then one
 * profile's files, their mapping onto record types, the load order, the books, the check and
 * the run. Every change goes through the migration session; the mapping being edited is a draft
 * here until it is saved.
 */
@Injectable()
export class MigrationStore extends AdminBase {
  private readonly migration = new MigrationSession(httpMigrationGateway(inject(FileApi)));
  readonly snap = signal<MigrationSnapshot>(this.migration.state.value);
  readonly step = signal<MigrationStep>('files');
  readonly allowed = computed(() => mayOpen('migration', this.session.me()?.capabilities));
  readonly booksAllowed = computed(() => !!this.session.me()?.capabilities.migrationBooks);
  readonly name = signal('');

  /** Record types a file can fill. */
  readonly types = computed<RuntimeRecordType[]>(() => [...(this.session.defs()?.recordTypes ?? [])].sort((a, b) => a.label.localeCompare(b.label)));

  readonly selected = signal<string | null>(null);
  readonly draft = signal<MigrationTarget[]>([]);
  readonly source = computed(() => this.snap().profile?.sources.find((s) => s.id === this.selected()) ?? null);
  readonly columns = computed(() => this.source()?.columns.map((c) => c.name) ?? []);
  readonly running = computed(() => this.snap().profile?.status === 'running');
  readonly percent = computed(() => {
    const job = this.snap().job;
    return job?.total ? Math.min(100, Math.round((job.progress / job.total) * 100)) : 0;
  });

  readonly books = signal<BooksInput>({});
  readonly balance = computed(() => booksBalance(this.books().lines ?? []));

  constructor() {
    super();
    let shown = '';
    this.migration.state.subscribe((s) => {
      this.snap.set(s);
      if (s.message && s.message !== shown) this.show({ level: 'success', message: s.message });
      shown = s.message;
    });
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const id = p.get('id');
      const step = p.get('step');
      this.step.set(isMigrationStep(step) ? step : 'files');
      if (!this.allowed()) return;
      if (!id) void this.migration.loadList();
      else if (this.snap().profile?.id !== id) void this.migration.open(id);
    });
    effect(() => {
      const p = this.snap().profile;
      untracked(() => {
        this.meta.crumbLabels.set(p ? { migration: p.name } : {});
        if (!p) return;
        if (!this.selected() || !p.sources.some((s) => s.id === this.selected())) this.pick(p.sources.find((s) => !s.mapping)?.id ?? p.sources[0]?.id ?? null);
        this.books.set(structuredClone(p.books ?? {}));
      });
    });
    inject(DestroyRef).onDestroy(() => this.migration.dispose());
  }

  // ------------------------------------------------------------- navigation

  open(id: string, step: MigrationStep = 'files'): void {
    void this.router.navigate(['/admin/migration', id, step]);
  }

  goStep(step: MigrationStep): void {
    const id = this.snap().profile?.id;
    if (id) this.open(id, step);
  }

  async create(): Promise<void> {
    const name = this.name().trim();
    if (!name) return this.show({ level: 'error', message: t('ui.records.required', { field: t('ui.admin.migration.name') }) });
    const id = await this.migration.create(name);
    if (id) {
      this.name.set('');
      this.open(id);
    }
  }

  // ------------------------------------------------------------------ files

  addFiles(list: FileList | null): void {
    const files = Array.from(list ?? [], (f) => ({ body: f as Blob, name: f.name }));
    if (files.length) void this.migration.addFiles(files);
  }

  removeSource(id: string): void {
    void this.migration.removeSource(id);
  }

  // -------------------------------------------------------------------- map

  pick(sourceId: string | null): void {
    this.selected.set(sourceId);
    const s = this.snap().profile?.sources.find((x) => x.id === sourceId);
    this.draft.set(structuredClone(s?.mapping?.targets ?? []));
  }

  typeOf(key: string): RuntimeRecordType | undefined {
    return this.types().find((x) => x.key === key);
  }

  addTarget(typeKey: string): void {
    const type = this.typeOf(typeKey);
    if (!type) return;
    this.draft.update((d) => [...d, suggestTarget(type, this.columns(), d)]);
  }

  removeTarget(i: number): void {
    this.draft.update((d) => d.filter((_, n) => n !== i));
  }

  setOldId(i: number, column: string): void {
    this.patch(i, (x) => ({ ...x, oldId: column }));
  }

  setRequired(i: number, required: boolean): void {
    this.patch(i, (x) => ({ ...x, required }));
  }

  choose(i: number, choice: FieldChoice, value: string): void {
    this.patch(i, (x) => (choice.reference ? setRef(x, choice.field.key, refOf(value)) : setField(x, choice.field.key, value)));
  }

  /** The fields of a target with what fills each, in the record type's order. */
  choices(x: MigrationTarget): FieldChoice[] {
    const type = this.typeOf(x.type);
    if (!type) return [];
    return importableFields(type).map((f) =>
      f.type === 'reference' ? { field: f, reference: true, value: refChoice(x.refs[f.key]) } : { field: f, reference: false, value: x.fields[f.key] ?? '' },
    );
  }

  /** A column as a choice: its name and the first value in the file. */
  columnLabel(col: MigrationColumn): string {
    return col.samples.length ? `${col.name} · ${col.samples[0]}` : col.name;
  }

  /** The record types a file fills, by label. */
  typesOf(targets: readonly MigrationTarget[]): string {
    return targets.map((x) => this.typeOf(x.type)?.label ?? x.type).join(', ');
  }

  /** Earlier targets of the same row a reference field may point at. */
  earlier(i: number, field: FieldDef): MigrationTarget[] {
    return this.draft()
      .slice(0, i)
      .filter((x) => x.type === field.referenceType);
  }

  saveMapping(): void {
    const id = this.selected();
    if (id) void this.migration.saveMapping(id, { targets: this.draft() });
  }

  /** The server's issue for a path of the draft, if any. */
  issue(path: string): string {
    return this.snap().issues.find((x) => x.path === path)?.message ?? '';
  }

  private patch(i: number, fn: (x: MigrationTarget) => MigrationTarget): void {
    this.draft.update((d) => d.map((x, n) => (n === i ? fn(x) : x)));
  }

  // ------------------------------------------------------------------ order

  move(sourceId: string, by: -1 | 1): void {
    void this.migration.move(sourceId, by);
  }

  // ------------------------------------------------------------------ books

  setCutover(date: string): void {
    this.books.update((b) => ({ ...b, cutoverDate: date }));
  }

  addLine(): void {
    this.books.update((b) => ({ ...b, lines: [...(b.lines ?? []), { accountCode: '' }] }));
  }

  setLine(i: number, key: keyof BooksLine, value: string): void {
    this.books.update((b) => ({
      ...b,
      lines: (b.lines ?? []).map((l, n) => {
        if (n !== i) return l;
        const next: BooksLine = { ...l, [key]: value };
        if (key === 'debit' && value) delete next.credit;
        if (key === 'credit' && value) delete next.debit;
        return next;
      }),
    }));
  }

  removeLine(i: number): void {
    this.books.update((b) => ({ ...b, lines: (b.lines ?? []).filter((_, n) => n !== i) }));
  }

  addReceipt(): void {
    this.books.update((b) => ({ ...b, receipts: [...(b.receipts ?? []), { series: '', next: 1 }] }));
  }

  setReceipt(i: number, key: 'series' | 'next', value: string): void {
    this.books.update((b) => ({
      ...b,
      receipts: (b.receipts ?? []).map((r, n) => (n === i ? { ...r, [key]: key === 'next' ? Number(value) : value } : r)),
    }));
  }

  removeReceipt(i: number): void {
    this.books.update((b) => ({ ...b, receipts: (b.receipts ?? []).filter((_, n) => n !== i) }));
  }

  saveBooks(): void {
    const b = this.books();
    void this.migration.saveBooks({
      ...(b.cutoverDate ? { cutoverDate: b.cutoverDate } : {}),
      lines: (b.lines ?? []).filter((l) => l.accountCode || l.debit || l.credit),
      receipts: (b.receipts ?? []).filter((r) => r.series),
    });
  }

  applyBooks(): void {
    void this.migration.applyBooks();
  }

  // ------------------------------------------------------------ check, run

  async check(): Promise<void> {
    await this.migration.check();
  }

  async run(): Promise<void> {
    await this.migration.run();
    if (this.snap().profile?.status === 'running') this.goStep('run');
  }

  cancel(): void {
    void this.migration.cancel();
  }

  async downloadFailed(sourceId: string): Promise<void> {
    try {
      saveFile(await this.migration.failedRows(sourceId));
    } catch {
      this.show({ level: 'error', message: t('ui.common.somethingWentWrong') });
    }
  }

  fileName(sourceId: string): string {
    return this.snap().profile?.sources.find((s) => s.id === sourceId)?.fileName ?? '';
  }
}
