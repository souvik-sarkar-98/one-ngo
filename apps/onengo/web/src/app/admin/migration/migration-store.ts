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
  checkHasErrors,
  draftReady,
  emptyPeople,
  fieldCoverage,
  fileDraftOf,
  groupWarnings,
  importableFields,
  inGroup,
  isMigrationStep,
  isPeopleMapping,
  kindOptions,
  legacyRoleValues,
  linkGroup,
  linkRefusal,
  mapGroups,
  mappingOf,
  PEOPLE_GROUP,
  refChoice,
  refOf,
  roleRows,
  setField,
  setPerson,
  setRef,
  targetsOf,
  unlinkGroup,
  type BooksInput,
  type BooksLine,
  type FieldCoverage,
  type FileDraft,
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

  /** Each file's mapping as edited here, by file id; a file in `dirty` has changes not saved yet. */
  readonly drafts = signal<Readonly<Record<string, FileDraft>>>({});
  readonly dirty = signal<ReadonlySet<string>>(new Set());
  /** Groups added on the Map step that no file is linked to yet. */
  readonly addedGroups = signal<string[]>([]);
  /** The open group: a record type's key, or People. */
  readonly group = signal<string | null>(null);
  readonly groups = computed(() => mapGroups(this.snap().profile?.sources ?? [], this.drafts(), this.addedGroups()));
  readonly openGroup = computed(() => this.groups().find((g) => g.key === this.group()) ?? null);
  /** Record types a group can still be added for; People can be added while there is no People group. */
  readonly groupChoices = computed(() => this.types().filter((x) => !this.groups().some((g) => g.key === x.key)));
  readonly hasPeopleGroup = computed(() => this.groups().some((g) => g.key === PEOPLE_GROUP));
  /** Files no group holds: they are left out of the run. */
  readonly ungrouped = computed(() => (this.snap().profile?.sources ?? []).filter((s) => !(this.drafts()[s.id] ?? fileDraftOf(s)).kind));
  /** The open file of the group: its editor shows below the group's file tabs. */
  readonly selected = signal<string | null>(null);
  readonly draft = computed<MigrationTarget[]>(() => this.drafts()[this.selected() ?? '']?.targets ?? []);
  readonly source = computed(() => this.snap().profile?.sources.find((s) => s.id === this.selected()) ?? null);
  readonly columns = computed(() => this.source()?.columns.map((c) => c.name) ?? []);
  /** Where each field of the open record type comes from, across the group's files. */
  readonly coverage = computed<FieldCoverage[]>(() => {
    const g = this.openGroup();
    const type = g && g.key !== PEOPLE_GROUP ? this.typeOf(g.key) : undefined;
    if (!g || !type) return [];
    const sources = this.snap().profile?.sources ?? [];
    return fieldCoverage(
      type,
      g.files.flatMap((id) => {
        const source = sources.find((s) => s.id === id);
        const draft = this.drafts()[id];
        return source && draft ? [{ source, draft }] : [];
      }),
    );
  });
  readonly running = computed(() => this.snap().profile?.status === 'running');
  /** The run has finished: nothing on the profile can be changed any more, only read. */
  readonly finished = computed(() => this.snap().profile?.status === 'done');
  /** A check is running in the background: the result is not there yet, and the profile cannot be changed until it ends. */
  readonly checking = computed(() => !!this.snap().profile?.checkJobId);

  /** What the open file holds; null while no group holds it. */
  readonly kind = computed(() => this.drafts()[this.selected() ?? '']?.kind ?? null);
  /** Whether this person may map and run people files (`data:migrate:people` and `members:manage`). */
  readonly peopleAllowed = computed(() => !!this.session.me()?.capabilities.migrationPeople);
  readonly people = computed<PeopleDraft>(() => this.drafts()[this.selected() ?? '']?.people ?? emptyPeople([]));
  /** People as a group to add: its label, and the line under it that says what it is or why it is disabled. */
  readonly peopleOption = computed(() => kindOptions(this.peopleAllowed()).find((o) => o.kind === 'people')!);
  readonly peopleGroup = PEOPLE_GROUP;
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
  /** The check found errors: the run stays off until they are fixed and the files checked again. */
  readonly checkErrors = computed(() => {
    const c = this.snap().profile?.check;
    return !!c && checkHasErrors(c);
  });

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
        this.syncDrafts(p.sources);
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

  /**
   * Takes the saved mappings in: each file without unsaved changes shows what is saved. Another
   * profile starts afresh. Then a group and one of its files are open, when there are any.
   */
  private syncDrafts(sources: readonly MigrationSource[]): void {
    const profileId = this.snap().profile?.id ?? null;
    if (profileId !== this.draftsOf) {
      this.draftsOf = profileId;
      this.dirty.set(new Set());
      this.addedGroups.set([]);
      this.group.set(null);
      this.selected.set(null);
    }
    const current = this.drafts();
    this.drafts.set(Object.fromEntries(sources.map((s) => [s.id, this.dirty().has(s.id) && current[s.id] ? current[s.id]! : fileDraftOf(s)])));
    this.settleGroup();
  }
  private draftsOf: string | null = null;

  /** Keeps the open group one that exists and the open file one of its files. */
  private settleGroup(): void {
    const groups = this.groups();
    if (!groups.some((g) => g.key === this.group())) this.group.set(groups[0]?.key ?? null);
    const files = this.openGroup()?.files ?? [];
    if (!files.includes(this.selected() ?? '')) this.selected.set(files[0] ?? null);
    this.addedRoleValue.set('');
    if (this.group() === PEOPLE_GROUP) void this.loadRoles();
  }

  /** Opens a group of the Map step. */
  openGroupOf(key: string): void {
    this.group.set(key);
    this.settleGroup();
  }

  /** Adds a group for a record type or People (when this person may migrate people) and opens it. */
  addGroup(key: string): void {
    if (!key || (key === PEOPLE_GROUP && !this.peopleAllowed())) return;
    if (!this.groups().some((g) => g.key === key)) this.addedGroups.update((a) => [...a, key]);
    this.openGroupOf(key);
  }

  /** Removes a group no file is linked to. */
  dropGroup(key: string): void {
    this.addedGroups.update((a) => a.filter((k) => k !== key));
    this.settleGroup();
  }

  pick(sourceId: string | null): void {
    this.selected.set(sourceId);
    this.addedRoleValue.set('');
  }

  groupLabel(key: string): string {
    return key === PEOPLE_GROUP ? t('ui.admin.migration.kindPeople') : (this.typeOf(key)?.label ?? key);
  }

  /** The record type a target of a file fills, by label: what a reference "from this row's" target names. */
  targetLabel(sourceId: string, key: string): string {
    const type = this.drafts()[sourceId]?.targets.find((x) => x.key === key)?.type ?? key;
    return this.typeOf(type)?.label ?? type;
  }

  /** Whether a file's mapping is saved as shown: it has one and no unsaved change. */
  saved(sourceId: string): boolean {
    return !this.dirty().has(sourceId) && !!this.snap().profile?.sources.find((s) => s.id === sourceId)?.mapping;
  }

  /** Whether a file is linked to the open group, and why it cannot be when it cannot: a catalogue key. */
  linkOf(s: MigrationSource): { linked: boolean; refusal: string } {
    const key = this.group();
    const d = this.drafts()[s.id] ?? fileDraftOf(s);
    if (!key) return { linked: false, refusal: '' };
    const linked = inGroup(d, key);
    // A saved file keeps at least one group: a mapping cannot be taken back, only replaced (or the file removed).
    const last = linked && !!s.mapping && unlinkGroup(d, key).kind === null;
    return { linked, refusal: linked ? (last ? 'ui.admin.migration.group.lastGroup' : '') : linkRefusal(d, key) };
  }

  /** Links a file to the open group, or takes it out. */
  setLinked(s: MigrationSource, linked: boolean): void {
    const key = this.group();
    if (!key || this.linkOf(s).refusal) return;
    const d = this.drafts()[s.id] ?? fileDraftOf(s);
    this.edit(s.id, () => (linked ? linkGroup(d, key, this.typeOf(key), s.columns.map((c) => c.name)) : unlinkGroup(d, key)));
    if (linked) {
      this.addedGroups.update((a) => a.filter((k) => k !== key));
      this.selected.set(s.id);
    }
    this.settleGroup();
  }

  /** Changes one file's draft and marks it unsaved. */
  private edit(sourceId: string, fn: (d: FileDraft) => FileDraft): void {
    const d = this.drafts()[sourceId];
    if (!d) return;
    this.drafts.update((all) => ({ ...all, [sourceId]: fn(d) }));
    this.dirty.update((set) => new Set(set).add(sourceId));
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
    this.editPeople((d) => ({ ...d, [key]: value }));
  }

  /** Chooses the role a legacy value becomes; empty ignores it. Every row of the table is kept, so the guesses are saved as shown. */
  setRole(value: string, role: string): void {
    const rows = this.roleTable();
    this.editPeople((d) => ({ ...d, roleMap: { ...Object.fromEntries(rows.map((r) => [r.value, r.role])), [value]: role } }));
  }

  addRoleValue(): void {
    const v = this.addedRoleValue().trim();
    if (!v) return;
    const rows = this.roleTable();
    if (!rows.some((r) => r.value.toLowerCase() === v.toLowerCase())) this.editPeople((d) => ({ ...d, roleMap: { ...Object.fromEntries(rows.map((r) => [r.value, r.role])), [v]: '' } }));
    this.addedRoleValue.set('');
  }

  private editPeople(fn: (d: PeopleDraft) => PeopleDraft): void {
    const id = this.selected();
    if (id) this.edit(id, (d) => ({ ...d, people: fn(d.people) }));
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

  /** The files with changes to save that a group holds; a file taken out of every group has nothing to save. */
  readonly unsaved = computed(() => (this.snap().profile?.sources ?? []).filter((s) => this.dirty().has(s.id) && this.drafts()[s.id]?.kind));

  /**
   * Saves every file with unsaved changes, one after another (one mapping each). The first one the
   * server refuses stops the rest and opens, in its group, with the server's issues on its fields.
   */
  async saveMapping(): Promise<void> {
    for (const s of this.unsaved()) {
      const d = this.drafts()[s.id]!;
      const col = s.columns.find((c) => c.name === d.people.rolesColumn);
      const rows = d.kind === 'people' && d.people.rolesColumn ? roleRows(col ? legacyRoleValues(col.samples, d.people.separator) : [], d.people.roleMap, this.roles()) : [];
      const profile = await this.migration.saveMapping(s.id, mappingOf(d, rows));
      if (!profile) {
        this.group.set(d.kind === 'people' ? PEOPLE_GROUP : (d.targets[0]?.type ?? this.group()));
        this.selected.set(s.id);
        return;
      }
      const saved = profile.sources.find((x) => x.id === s.id);
      this.dirty.update((set) => {
        const next = new Set(set);
        next.delete(s.id);
        return next;
      });
      if (saved) this.drafts.update((all) => ({ ...all, [s.id]: fileDraftOf(saved) }));
    }
    // Files taken out of every group without having been saved have nothing to keep.
    this.dirty.set(new Set([...this.dirty()].filter((id) => this.drafts()[id]?.kind)));
    this.settleGroup();
  }

  /** Whether the changes can be saved: there are some, and each file's draft is complete (people need three columns, records a target). */
  readonly canSave = computed(() => this.unsaved().length > 0 && this.unsaved().every((s) => draftReady(this.drafts()[s.id]!)));

  /** The server's issue for a path of the draft, if any. */
  issue(path: string): string {
    return this.snap().issues.find((x) => x.path === path)?.message ?? '';
  }

  private patch(i: number, fn: (x: MigrationTarget) => MigrationTarget): void {
    const id = this.selected();
    if (id) this.edit(id, (d) => ({ ...d, targets: d.targets.map((x, n) => (n === i ? fn(x) : x)) }));
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
