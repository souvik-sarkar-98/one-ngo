import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { formatDate, t } from '../../core/i18n/i18n';
import { isDay, kindLabel, todayLocal } from '../../core/money/money';
import {
  addOutcomes,
  balanceText,
  bankRow,
  bookLabel,
  candidatesFor,
  comparisonRows,
  figuresIssue,
  importSummary,
  lastSignedText,
  otherSideChoices,
  reconUrls,
  signOffBlocker,
  signOffRow,
  type BankLine,
  type BookLine,
  type ImportOutcome,
  type LedgerAccount,
  type LineStatus,
  type ReconAccountInfo,
  type Report,
  type SignOff,
} from '../../core/money/reconcile';
import {
  chunks,
  initialSetup,
  parseCsv,
  readLines,
  readSetup,
  setupProblem,
  setupStorageKey,
  usableLines,
  writeSetup,
  type ColumnRole,
  type DateOrder,
  type ImportSetup,
  type AmountStyle,
} from '../../core/money/statement-import';
import { Api } from '../../services/api';
import { I18n } from '../../services/i18n';
import { ScreenMeta } from '../../services/screen-meta';
import { Session } from '../../services/session';
import { failureText } from '../money-store';

export type Step = 'import' | 'review' | 'reconcile';
export type Action = 'match' | 'book' | 'ignore';

/** Reconciling one account (`/accounts/:key/reconcile`): bring in the bank's statement, settle each line, compare, sign off. */
@Injectable()
export class ReconcileStore {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly meta = inject(ScreenMeta);

  /** The account key from the address. */
  readonly key = signal('');
  readonly account = signal<ReconAccountInfo | null>(null);
  readonly step = signal<Step>('import');
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');

  readonly lines = signal<BankLine[]>([]);
  readonly books = signal<BookLine[]>([]);
  readonly ledger = signal<LedgerAccount[]>([]);
  readonly signOffs = signal<SignOff[]>([]);

  constructor() {
    effect(() => {
      const key = this.key();
      if (key) untracked(() => void this.load());
    });
  }

  readonly accountName = computed(() => this.account()?.name ?? this.key());
  readonly subtitle = computed(() => {
    this.i18n.locale();
    const a = this.account();
    return a ? `${kindLabel(a.kind)} · ${lastSignedText(this.signOffs()[0])}` : '';
  });

  // ---------------------------------------------------------------- loading

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const key = this.key();
      const [accounts, lines, books, ledger, signOffs] = await Promise.all([
        this.api.get<ReconAccountInfo[]>('/api/money/accounts'),
        this.api.get<BankLine[]>(reconUrls.lines(key)),
        this.api.get<BookLine[]>(reconUrls.bookLines(key)),
        this.api.get<LedgerAccount[]>('/api/ledger/accounts'),
        this.api.get<SignOff[]>(reconUrls.signOffs(key)),
      ]);
      const account = accounts.find((a) => a.key === key) ?? null;
      this.account.set(account);
      this.meta.crumbLabels.set({ account: account?.name ?? key });
      this.lines.set(lines);
      this.books.set(books);
      this.ledger.set(ledger);
      this.signOffs.set([...signOffs].sort((a, b) => b.asOf.localeCompare(a.asOf)));
      if (!lines.length) this.step.set('import');
      else if (this.step() === 'import' && !this.file()) this.step.set('review');
    } catch (e) {
      this.error.set(failureText(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Reloads the lines and the books' open entries after a change. */
  private async refresh(): Promise<void> {
    const key = this.key();
    const [lines, books] = await Promise.all([this.api.get<BankLine[]>(reconUrls.lines(key)), this.api.get<BookLine[]>(reconUrls.bookLines(key))]);
    this.lines.set(lines);
    this.books.set(books);
    this.report.set(null);
  }

  /** The steps that can be opened: the review and the comparison both work on imported lines, so they wait for a statement. */
  readonly enabled = computed<ReadonlySet<Step>>(() => new Set<Step>(this.lines().length ? ['import', 'review', 'reconcile'] : ['import']));

  goTo(step: Step): void {
    if (!this.enabled().has(step)) return;
    this.message.set('');
    this.step.set(step);
  }

  // ---------------------------------------------------------------- step 1: the file

  readonly file = signal<{ name: string; size: number } | null>(null);
  readonly headers = signal<string[]>([]);
  readonly dataRows = signal<string[][]>([]);
  readonly setup = signal<ImportSetup>({ roles: {}, dateOrder: 'dmy', amountStyle: 'single' });
  readonly remember = signal(true);
  readonly importOutcome = signal<{ outcome: ImportOutcome; need: number } | null>(null);

  private storageKey(): string {
    return setupStorageKey(this.session.me()?.tenant.key ?? '', this.key());
  }

  /** Reads the chosen file in the browser. Nothing is sent yet. */
  async chooseFile(file: File | undefined | null): Promise<void> {
    if (!file) return;
    this.error.set('');
    this.importOutcome.set(null);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) {
        this.file.set(null);
        this.headers.set([]);
        this.dataRows.set([]);
        this.error.set(t('ui.money.reconcile.emptyFile'));
        return;
      }
      const [headers, ...data] = rows as [string[], ...string[][]];
      this.file.set({ name: file.name, size: file.size });
      this.headers.set(headers);
      this.dataRows.set(data);
      this.setup.set(initialSetup(headers, data, readSetup(localStorage, this.storageKey())));
    } catch {
      this.error.set(t('ui.money.reconcile.unreadable'));
    }
  }

  setRole(header: string, role: ColumnRole): void {
    this.setup.update((s) => ({ ...s, roles: { ...s.roles, [header]: role } }));
  }
  setDateOrder(order: DateOrder): void {
    this.setup.update((s) => ({ ...s, dateOrder: order }));
  }
  setAmountStyle(style: AmountStyle): void {
    this.setup.update((s) => ({ ...s, amountStyle: style }));
  }

  /** Every row of the file read with the setup, with the reason for each one that cannot be used. */
  readonly parsed = computed(() => (this.file() && !this.setupIssue() ? readLines(this.headers(), this.dataRows(), this.setup()) : []));
  readonly setupIssue = computed(() => {
    this.i18n.locale();
    const p = setupProblem(this.setup(), this.headers());
    return p ? t(`ui.money.reconcile.setup.${p}`) : '';
  });
  readonly usable = computed(() => usableLines(this.parsed()));
  readonly problemRows = computed(() => this.parsed().filter((r) => r.problem));
  /** The first few rows, shown so the person can check the reading before importing. */
  readonly preview = computed(() => this.parsed().slice(0, 6));

  /** Sends the usable lines, in pieces of at most 1,000, and adds up what the server says. */
  async importNow(): Promise<void> {
    const lines = this.usable();
    if (!lines.length || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const outcomes: ImportOutcome[] = [];
      for (const piece of chunks(lines)) outcomes.push(await this.api.post<ImportOutcome>(reconUrls.importLines(this.key()), { lines: piece }));
      if (this.remember()) writeSetup(localStorage, this.storageKey(), this.setup());
      await this.refresh();
      const outcome = addOutcomes(outcomes);
      this.importOutcome.set({ outcome, need: this.unmatched().length });
      this.file.set(null);
      this.headers.set([]);
      this.dataRows.set([]);
    } catch (e) {
      this.error.set(failureText(e));
      // Part of a long file may already have gone in; showing the lines keeps what happened visible.
      await this.refresh().catch(() => undefined);
    } finally {
      this.busy.set(false);
    }
  }

  cancelFile(): void {
    this.file.set(null);
    this.headers.set([]);
    this.dataRows.set([]);
    this.error.set('');
  }

  readonly importText = computed(() => {
    this.i18n.locale();
    const o = this.importOutcome();
    return o ? importSummary(o.outcome, o.need) : '';
  });

  // ---------------------------------------------------------------- step 2: the lines

  readonly tab = signal<LineStatus>('unmatched');
  readonly unmatched = computed(() => this.lines().filter((l) => l.status === 'unmatched'));
  readonly counts = computed(() => ({
    unmatched: this.unmatched().length,
    matched: this.lines().filter((l) => l.status === 'matched').length,
    ignored: this.lines().filter((l) => l.status === 'ignored').length,
  }));
  readonly rows = computed(() => {
    this.i18n.locale();
    const books = this.books();
    return this.lines()
      .filter((l) => l.status === this.tab())
      .map((l) => bankRow(l, books));
  });

  // The line whose Match, Book or Ignore panel is open.
  readonly open = signal<{ id: string; action: Action } | null>(null);
  readonly pick = signal('');
  readonly otherSide = signal('');
  readonly memo = signal('');
  readonly note = signal('');
  readonly panelError = signal('');

  readonly openLine = computed(() => {
    const o = this.open();
    return o ? (this.lines().find((l) => l.id === o.id) ?? null) : null;
  });
  readonly candidates = computed(() => {
    this.i18n.locale();
    const l = this.openLine();
    return l ? candidatesFor(l, this.books()).map((b) => ({ id: b.id, label: bookLabel(b), amount: bankRow({ ...l, amount: b.amount }, []).amount })) : [];
  });
  readonly otherSides = computed(() => {
    this.i18n.locale();
    const l = this.openLine();
    return l ? otherSideChoices(this.ledger(), l) : [];
  });

  setTab(tab: LineStatus): void {
    this.tab.set(tab);
    this.closePanel();
  }

  openPanel(id: string, action: Action): void {
    this.panelError.set('');
    this.message.set('');
    this.pick.set('');
    this.otherSide.set('');
    this.memo.set('');
    this.note.set('');
    this.open.set({ id, action });
    if (action === 'match') this.pick.set(this.candidates()[0]?.id ?? '');
  }

  closePanel(): void {
    this.open.set(null);
    this.panelError.set('');
  }

  /** Runs the open panel's action on its line. */
  async confirm(): Promise<void> {
    const o = this.open();
    if (!o || this.busy()) return;
    const key = this.key();
    let body: unknown;
    if (o.action === 'match') {
      if (!this.pick()) return void this.panelError.set(t('ui.money.reconcile.pickEntry'));
      body = { journalLineId: this.pick() };
    } else if (o.action === 'book') {
      if (!this.otherSide()) return void this.panelError.set(t('ui.money.reconcile.pickAccount'));
      body = { accountCode: this.otherSide(), ...(this.memo().trim() && { memo: this.memo().trim() }) };
    } else {
      if (!this.note().trim()) return void this.panelError.set(t('ui.money.reconcile.needNote'));
      body = { note: this.note().trim() };
    }
    await this.run(() => this.api.post(reconUrls.act(key, o.id, o.action), body), true);
  }

  async reopen(id: string): Promise<void> {
    if (this.busy()) return;
    await this.run(() => this.api.post(reconUrls.act(this.key(), id, 'reopen'), {}), false);
  }

  /** Pairs every line that has an entry of the same amount within a few days. */
  async autoMatch(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ matched: number }>(reconUrls.autoMatch(this.key()), {});
      await this.refresh();
      this.message.set(t('ui.money.reconcile.autoMatched', { count: r.matched }));
    } catch (e) {
      this.error.set(failureText(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async run(call: () => Promise<unknown>, panel: boolean): Promise<void> {
    this.busy.set(true);
    this.panelError.set('');
    this.error.set('');
    try {
      await call();
      await this.refresh();
      this.open.set(null);
    } catch (e) {
      if (panel) this.panelError.set(failureText(e));
      else this.error.set(failureText(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---------------------------------------------------------------- step 3: compare and sign off

  readonly asOf = signal(todayLocal());
  readonly balance = signal('');
  readonly signNote = signal('');
  readonly figuresError = signal('');
  readonly report = signal<Report | null>(null);

  readonly comparison = computed(() => {
    this.i18n.locale();
    const r = this.report();
    return r ? comparisonRows(r) : [];
  });
  readonly blocker = computed(() => {
    this.i18n.locale();
    return signOffBlocker(this.report());
  });
  readonly pastSignOffs = computed(() => {
    this.i18n.locale();
    return this.signOffs().map(signOffRow);
  });

  async compare(): Promise<void> {
    const issue = figuresIssue(this.asOf(), this.balance());
    this.figuresError.set(issue ?? '');
    if (issue || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.report.set(await this.api.get<Report>(reconUrls.report(this.key(), this.asOf(), balanceText(this.balance()))));
    } catch (e) {
      this.report.set(null);
      this.error.set(failureText(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Records that the statement and the books agree on the day. */
  async signOff(): Promise<void> {
    const r = this.report();
    if (!r || this.blocker() || this.busy() || !isDay(this.asOf())) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post(reconUrls.signOffs(this.key()), { asOf: r.asOf, statementBalance: r.statementBalance, ...(this.signNote().trim() && { note: this.signNote().trim() }) });
      this.signNote.set('');
      this.signOffs.set((await this.api.get<SignOff[]>(reconUrls.signOffs(this.key()))).sort((a, b) => b.asOf.localeCompare(a.asOf)));
      await this.compare();
      this.message.set(t('ui.money.reconcile.signedOff', { date: formatDate(r.asOf) }));
    } catch (e) {
      this.error.set(failureText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
