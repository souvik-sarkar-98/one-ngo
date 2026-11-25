import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { mayOpen } from '../../core/admin/areas';
import { shownRecordTypes } from '../../core/hidden';
import {
  MIGRATION_STEPS,
  ATTACHMENT_LIMIT,
  MigrationSession,
  booksBalance,
  byteText,
  fileFields,
  setFile,
  httpMigrationGateway,
  checkByKind,
  emptyPeople,
  groupWarnings,
  importableFields,
  isMigrationStep,
  isPeopleMapping,
  kindOptions,
  legacyRoleValues,
  peopleDraftOf,
  peopleSpecOf,
  refChoice,
  refOf,
  roleRows,
  setField,
  setPerson,
  setRef,
  suggestTarget,
  targetsOf,
  type BooksInput,
  type BooksLine,
  type MigrationColumn,
  type MigrationSnapshot,
  type MigrationSource,
  type MigrationStep,
  type MigrationTarget,
  type PeopleDraft,
  type RoleChoice,
  type RoleRow,
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
  /** A person field also takes a column of legacy user ids. */
  person: boolean;
  legacyColumn: string;
  onMissing: 'blank' | 'fail';
}

/** A file field of a target as the Map step draws it: the column of attachment paths, and what happens to a name nothing matches. */
export interface FileChoice {
  field: FieldDef;
  column: string;
  separator: ';' | ',';
  onMissing: 'fail' | 'skip';
}

/** Attachments shown per page of the list. */
const ATTACHMENT_PAGE = 50;

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
  readonly types = computed<RuntimeRecordType[]>(() => [...shownRecordTypes(this.session.defs())].sort((a, b) => a.label.localeCompare(b.label)));

  readonly selected = signal<string | null>(null);
  readonly draft = signal<MigrationTarget[]>([]);
  readonly source = computed(() => this.snap().profile?.sources.find((s) => s.id === this.selected()) ?? null);
  readonly columns = computed(() => this.source()?.columns.map((c) => c.name) ?? []);
  readonly running = computed(() => this.snap().profile?.status === 'running');

  /** What the open file holds; null until it is chosen (a mapped file already knows). */
  readonly kind = signal<'records' | 'people' | null>(null);
  /** Whether this person may map and run people files (`data:migrate:people` and `members:manage`). */
  readonly peopleAllowed = computed(() => !!this.session.me()?.capabilities.migrationPeople);
  readonly kindOptions = computed(() => kindOptions(this.peopleAllowed()));
  readonly people = signal<PeopleDraft>(emptyPeople([]));
  /** Roles a legacy role may become; empty when the list could not be read. */
  readonly roles = signal<RoleChoice[]>([]);
  readonly rolesFailed = signal(false);
  private rolesLoaded = false;
  /** Legacy role values typed by hand, besides the ones the sample shows. */
  readonly addedRoleValue = signal('');
  readonly roleValues = computed(() => {
    const d = this.people();
    const col = this.source()?.columns.find((c) => c.name === d.rolesColumn);
    return col ? legacyRoleValues(col.samples, d.separator) : [];
  });
  readonly roleTable = computed<RoleRow[]>(() => (this.people().rolesColumn ? roleRows(this.roleValues(), this.people().roleMap, this.roles()) : []));
  readonly kinds = computed(() => {
    const p = this.snap().profile;
    return p?.check ? checkByKind(p.check, p.sources) : [];
  });
  readonly warningGroups = computed(() => groupWarnings(this.snap().profile?.check?.warnings ?? []));

  /** Attachments: the search text, the page, and the two confirmations (clear all, delete source data). */
  readonly attachQuery = signal('');
  readonly attachOffset = signal(0);
  readonly confirmClear = signal(false);
  readonly confirmPurge = signal(false);
  readonly attachLimit = ATTACHMENT_LIMIT;
  readonly attachPage = ATTACHMENT_PAGE;
  readonly purged = computed(() => !!this.snap().profile?.purgedAt);

  /** Steps whose work is in place: files added, every file mapped (which also settles the order), books saved, checked, run to the end. */
  readonly done = computed<ReadonlySet<MigrationStep>>(() => {
    const p = this.snap().profile;
    const out = new Set<MigrationStep>();
    if (!p) return out;
    const mapped = p.sources.length > 0 && p.sources.every((s) => s.mapping);
    const b = p.books ?? {};
    if (p.sources.length) out.add('files');
    if (mapped) out.add('map').add('order');
    if (p.booksAppliedAt || b.cutoverDate || b.lines?.length || b.receipts?.length) out.add('books');
    if (p.check) out.add('check');
    if (p.status === 'done') out.add('run');
    return out;
  });
  /**
   * Steps that can be opened: Map needs a file; Order, Books and Check need a mapped file (a file
   * left unmapped is simply left out of the run); Run needs a check, or a run that has started.
   */
  readonly enabled = computed<ReadonlySet<MigrationStep>>(() => {
    const p = this.snap().profile;
    const out = new Set<MigrationStep>(['files']);
    if (!p) return out;
    if (p.sources.length) out.add('map');
    if (p.sources.some((s) => s.mapping)) out.add('order').add('books').add('check');
    if (p.check || p.jobId || p.status !== 'draft') out.add('run');
    return out;
  });
  readonly prevStep = computed<MigrationStep | null>(() => MIGRATION_STEPS[MIGRATION_STEPS.indexOf(this.step()) - 1] ?? null);
  readonly nextStep = computed<MigrationStep | null>(() => MIGRATION_STEPS[MIGRATION_STEPS.indexOf(this.step()) + 1] ?? null);
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
    effect(() => {
      const id = this.snap().profile?.id;
      const onFiles = this.step() === 'files';
      untracked(() => {
        if (id && onFiles && this.allowed() && !this.snap().attachmentList) void this.loadAttachments();
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
    if (id && this.enabled().has(step)) this.open(id, step);
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

  // ------------------------------------------------------------ attachments

  /** Adds attachments, each under its relative path (a picked folder keeps its folders). */
  async addAttachments(files: readonly { body: Blob; name: string }[]): Promise<void> {
    this.attachQuery.set('');
    this.attachOffset.set(0);
    await this.migration.addAttachments(files);
  }

  loadAttachments(): Promise<void> {
    return this.migration.loadAttachments({ q: this.attachQuery().trim(), limit: ATTACHMENT_PAGE, offset: this.attachOffset() });
  }

  searchAttachments(q: string): void {
    this.attachQuery.set(q);
    this.attachOffset.set(0);
    void this.loadAttachments();
  }

  pageAttachments(by: -1 | 1): void {
    this.attachOffset.update((o) => Math.max(0, o + by * ATTACHMENT_PAGE));
    void this.loadAttachments();
  }

  async removeAttachment(id: string): Promise<void> {
    await this.migration.removeAttachment(id);
    // A page that is now empty steps back.
    const list = this.snap().attachmentList;
    if (list && !list.items.length && this.attachOffset() > 0) this.pageAttachments(-1);
  }

  async clearAttachments(): Promise<void> {
    this.confirmClear.set(false);
    this.attachOffset.set(0);
    await this.migration.clearAttachments();
  }

  async purge(): Promise<void> {
    this.confirmPurge.set(false);
    await this.migration.purge();
  }

  /** The count and bytes of the attachments held, for the panel's summary. */
  attachTotals(): { count: number; size: string } {
    const a = this.snap().profile?.attachments;
    return { count: a?.count ?? 0, size: byteText(a?.bytes ?? 0) };
  }

  size(bytes: number): string {
    return byteText(bytes);
  }

  // -------------------------------------------------------------------- map

  pick(sourceId: string | null): void {
    this.selected.set(sourceId);
    const s = this.snap().profile?.sources.find((x) => x.id === sourceId);
    this.draft.set(structuredClone(targetsOf(s?.mapping)));
    const m = s?.mapping;
    this.kind.set(isPeopleMapping(m) ? 'people' : m ? 'records' : null);
    this.people.set(isPeopleMapping(m) ? peopleDraftOf(m.people) : emptyPeople(s?.columns.map((c) => c.name) ?? []));
    this.addedRoleValue.set('');
    if (isPeopleMapping(m)) void this.loadRoles();
  }

  /** The answer to "What is in this file?". People needs both permissions. */
  chooseKind(kind: 'records' | 'people'): void {
    if (kind === 'people' && !this.peopleAllowed()) return;
    this.kind.set(kind);
    if (kind === 'people') void this.loadRoles();
  }

  /** Reads the roles once, for the role table; two-step roles come marked so they can be shown disabled. */
  async loadRoles(): Promise<void> {
    if (this.rolesLoaded) return;
    this.rolesLoaded = true;
    try {
      this.roles.set((await this.gateway.roles()).map((r) => ({ key: r.key, label: r.label, requireTwoStep: r.requireTwoStep })));
      this.rolesFailed.set(false);
    } catch {
      this.rolesLoaded = false;
      this.rolesFailed.set(true);
    }
  }

  setPeople<K extends keyof PeopleDraft>(key: K, value: PeopleDraft[K]): void {
    this.people.update((d) => ({ ...d, [key]: value }));
  }

  /** Chooses the role a legacy value becomes; empty ignores it. Every row of the table is kept, so the guesses are saved as shown. */
  setRole(value: string, role: string): void {
    const rows = this.roleTable();
    this.people.update((d) => ({ ...d, roleMap: { ...Object.fromEntries(rows.map((r) => [r.value, r.role])), [value]: role } }));
  }

  addRoleValue(): void {
    const v = this.addedRoleValue().trim();
    if (!v) return;
    const rows = this.roleTable();
    if (!rows.some((r) => r.value.toLowerCase() === v.toLowerCase())) this.people.update((d) => ({ ...d, roleMap: { ...Object.fromEntries(rows.map((r) => [r.value, r.role])), [v]: '' } }));
    this.addedRoleValue.set('');
  }

  /** Whether a role cannot be given by a migration: it requires two-step sign-in. */
  twoStep(key: string): boolean {
    return !!this.roles().find((r) => r.key === key)?.requireTwoStep;
  }

  roleLabel(key: string): string {
    return this.roles().find((r) => r.key === key)?.label ?? key;
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
    return importableFields(type).map((f) => {
      const p = x.persons?.[f.key];
      const person = { person: f.type === 'person', legacyColumn: p?.column ?? '', onMissing: p?.onMissing ?? ('blank' as const) };
      return f.type === 'reference'
        ? { field: f, reference: true, value: refChoice(x.refs[f.key]), ...person }
        : { field: f, reference: false, value: x.fields[f.key] ?? '', ...person };
    });
  }

  /** Fills a person field from a column of legacy user ids (empty clears it). */
  choosePerson(i: number, choice: FieldChoice, column: string): void {
    this.patch(i, (x) => setPerson(x, choice.field.key, column, x.persons?.[choice.field.key]?.onMissing));
  }

  setOnMissing(i: number, choice: FieldChoice, onMissing: 'blank' | 'fail'): void {
    this.patch(i, (x) => setPerson(x, choice.field.key, choice.legacyColumn, onMissing));
  }

  /** The file fields of a target with the column of attachment paths that fills each. */
  fileChoices(x: MigrationTarget): FileChoice[] {
    const type = this.typeOf(x.type);
    return (type ? fileFields(type) : []).map((f) => {
      const m = x.files?.[f.key];
      return { field: f, column: m?.column ?? '', separator: m?.separator ?? ';', onMissing: m?.onMissing ?? 'fail' };
    });
  }

  /** Fills a file field from a column of attachment paths (empty clears it); the other options stay as they were. */
  chooseFile(i: number, choice: FileChoice, column: string): void {
    this.patch(i, (x) => setFile(x, choice.field, column, { separator: choice.separator, onMissing: choice.onMissing }));
  }

  setFileOption(i: number, choice: FileChoice, key: 'separator' | 'onMissing', value: string): void {
    this.patch(i, (x) => setFile(x, choice.field, choice.column, { separator: choice.separator, onMissing: choice.onMissing, [key]: value }));
  }

  /** How many of a target's fields a column or old id fills, of how many it could. */
  filled(x: MigrationTarget): { count: number; total: number } {
    const all = this.choices(x);
    const files = this.fileChoices(x);
    return { count: all.filter((c) => c.value || c.legacyColumn).length + files.filter((c) => c.column).length, total: all.length + files.length };
  }

  /** A column as a choice: its name and the first value in the file. */
  columnLabel(col: MigrationColumn): string {
    return col.samples.length ? `${col.name} · ${col.samples[0]}` : col.name;
  }

  /** The record types a file fills, by label. */
  typesOf(targets: readonly MigrationTarget[]): string {
    return targets.map((x) => this.typeOf(x.type)?.label ?? x.type).join(', ');
  }

  /** What a mapped file holds, for lists: "People" or the record types. */
  contents(mapping: MigrationSource['mapping']): string {
    return isPeopleMapping(mapping) ? t('ui.admin.migration.kindPeople') : this.typesOf(targetsOf(mapping));
  }

  /** Earlier targets of the same row a reference field may point at. */
  earlier(i: number, field: FieldDef): MigrationTarget[] {
    return this.draft()
      .slice(0, i)
      .filter((x) => x.type === field.referenceType);
  }

  saveMapping(): void {
    const id = this.selected();
    if (!id) return;
    if (this.kind() === 'people') void this.migration.saveMapping(id, { kind: 'people', people: peopleSpecOf(this.people(), this.roleTable()) });
    else void this.migration.saveMapping(id, { targets: this.draft() });
  }

  /** Whether the mapping can be saved: people need the three columns, records need a target. */
  readonly canSave = computed(() => {
    if (this.kind() === 'people') {
      const d = this.people();
      return !!(d.oldId && d.email && d.name);
    }
    return this.kind() === 'records' && this.draft().length > 0;
  });

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
