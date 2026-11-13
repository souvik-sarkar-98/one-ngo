import { Injectable, computed, effect, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { readFlag, writeFlag } from '../../core/admin/address';
import type { ConnectorKind } from '../../core/admin/admin';
import { CONNECTOR_KINDS, ConnectorSession, ConnectorsList, deliveryLabel, kindLabel, type ConnectorSnapshot, type ConnectorsSnapshot } from '../../core/admin/connectors';
import { t } from '../../core/i18n/i18n';
import type { FormValues } from '../../core/records/record/forms';
import type { CfFieldDef } from '../../ui/cf-types';
import { AdminBase } from '../admin-store';
import { connectorColumns, connectorRow, deliveryColumns, deliveryRow } from '../rows';

const KEY = /^[a-z][a-zA-Z0-9_-]{0,62}$/;

/** Administration › Connectors: the list, and the panel that names a new one. */
@Injectable()
export class ConnectorsStore extends AdminBase {
  private readonly list = new ConnectorsList(this.gateway);
  readonly state = signal<ConnectorsSnapshot>(this.list.state.value);
  readonly creating = signal(false);
  readonly newValues = signal<FormValues>({ key: '' });
  readonly newErrors = signal<Record<string, string>>({});
  readonly columns = computed(() => {
    this.i18n.locale();
    return connectorColumns();
  });
  readonly rows = computed(() => {
    this.i18n.locale();
    const now = new Date();
    return this.state()
      .items.filter((c) => this.matches(c.key, kindLabel(c.kind), ...c.usedBy))
      .map((c) => connectorRow(c, now));
  });
  readonly newFields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    return [{ key: 'key', label: t('ui.admin.connectors.key'), type: 'text', required: true, readOnly: false, options: [] }];
  });

  constructor() {
    super();
    this.list.state.subscribe((s) => this.state.set(s));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const open = readFlag((n) => p.get(n), 'create');
      if (open && !this.creating()) {
        this.newValues.set({ key: '' });
        this.newErrors.set({});
      }
      this.creating.set(open);
    });
    void this.list.load();
  }

  retry(): void {
    void this.list.load();
  }

  open(key: string): void {
    this.go(`/admin/connectors/${encodeURIComponent(key)}`);
  }

  openCreate(): void {
    this.newValues.set({ key: '' });
    this.newErrors.set({});
    this.nav.navigate(writeFlag('create', true), false);
  }

  closeCreate(): void {
    this.nav.navigate(writeFlag('create', false), true);
  }

  create(): void {
    const v = this.newValues();
    const key = String(v['key'] ?? '').trim();
    if (!KEY.test(key)) return this.newErrors.set({ key: t('ui.records.required', { field: t('ui.admin.connectors.key') }) });
    this.creating.set(false);
    this.go(`/admin/connectors/${encodeURIComponent(key)}`);
  }
}

/** One connector (`/admin/connectors/:key?result=`): settings, Test, and the delivery log with Retry now. */
@Injectable()
export class ConnectorStore extends AdminBase {
  readonly key = this.route.snapshot.paramMap.get('key') ?? '';
  readonly connector = new ConnectorSession(this.gateway, this.key, this.nav);
  readonly state = signal<ConnectorSnapshot>(this.connector.state.value);
  readonly result = signal<string | null>(null);
  readonly fields = computed(() => {
    this.state();
    this.i18n.locale();
    return this.connector.fields() as CfFieldDef[];
  });
  readonly testMode = computed(() => {
    this.state();
    return this.connector.testMode();
  });
  readonly lookupInputs = computed(() => {
    this.state();
    return this.connector.lookupInputs();
  });
  readonly oauthState = computed(() => {
    this.state();
    this.i18n.locale();
    return this.connector.oauthState();
  });
  readonly redirectUrl = `${window.location.origin}/api/connectors/oauth/callback`;
  readonly chips = computed(() => {
    this.i18n.locale();
    const d = this.state().deliveries;
    const count = (s?: string) => d.filter((x) => !s || x.status === s).length;
    return [
      { id: 'all', label: t('ui.people.chip', { label: t('ui.people.status.all'), count: count() }) },
      { id: 'failed', label: t('ui.people.chip', { label: deliveryLabel('failed'), count: count('failed') }) },
      { id: 'pending', label: t('ui.people.chip', { label: deliveryLabel('pending'), count: count('pending') }) },
    ];
  });
  readonly columns = computed(() => {
    this.i18n.locale();
    return deliveryColumns();
  });
  readonly rows = computed(() => {
    this.state();
    this.i18n.locale();
    const now = new Date();
    return this.connector.shownDeliveries().map((d) => deliveryRow(d, now));
  });
  readonly openDelivery = computed(() => this.state().deliveries.find((d) => d.id === this.result()) ?? null);
  readonly kindName = computed(() => {
    this.i18n.locale();
    const s = this.state();
    if (s.isNew && !s.kindChosen) return '';
    const mode = s.kind === 'http' ? s.view?.config['mode'] : undefined;
    return mode === 'send' || mode === 'lookup' ? t(`ui.admin.connectors.httpMode.${mode}`) : kindLabel(s.kind);
  });
  readonly kinds = CONNECTOR_KINDS.map((k) => ({ key: k, label: kindLabel(k) }));

  constructor() {
    super();
    this.connector.state.subscribe((s) => this.state.set(s));
    const kind = this.route.snapshot.queryParamMap.get('kind');
    void this.connector.load(CONNECTOR_KINDS.includes(kind as ConnectorKind) ? (kind as ConnectorKind) : undefined);
    this.returnedFromProvider();
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => this.result.set(p.get('result')));
    effect(() => {
      this.result();
      untracked(() => this.meta.crumbLabels.set({ connector: this.key }));
    });
  }

  chooseKind(kind: string): void {
    this.connector.chooseKind(CONNECTOR_KINDS.includes(kind as ConnectorKind) ? (kind as ConnectorKind) : '');
  }

  async save(): Promise<void> {
    this.show(await this.connector.save());
  }

  async test(): Promise<void> {
    await this.connector.test();
  }

  /** Connect or Reconnect: the provider's sign-in page, which comes back here with ?connected=1 or ?error=. */
  async connect(): Promise<void> {
    const out = await this.connector.connect();
    if ('url' in out) window.location.href = out.url;
    else this.show(out);
  }

  /** The provider sent the browser back: say how it went once, then drop the marker from the address. */
  private returnedFromProvider(): void {
    const q = this.route.snapshot.queryParamMap;
    const error = q.get('error');
    if (q.get('connected') === '1') this.show({ level: 'success', message: t('ui.admin.connectors.connectedNotice') });
    else if (error === 'denied' || error === 'failed') this.show({ level: 'error', message: t(`ui.admin.connectors.connectError.${error}`) });
    else return;
    this.nav.navigate({ connected: null, error: null }, true);
  }

  async retry(id: string): Promise<void> {
    this.show(await this.connector.retry(id));
  }

  reload(): void {
    void this.connector.load();
  }
}
