import type { ApiKey, AuditEntry, ConnectorSummary, Delivery, JobRow, RoleSummary } from '../core/admin/admin';
import { deliveryLabel, kindLabel, summaryState } from '../core/admin/connectors';
import { currentTranslator, formatDate, formatNumber, t } from '../core/i18n/i18n';
import { noticeTime } from '../core/inbox/rows';
import type { PersonItem, RoleOption } from '../core/people/people';
import { joinedText, roleNames, statusLabel } from '../core/people/rows';
import type { RowView, Tone } from '../core/rows';

/** Every Administration list on RowView: the card shows the same values as the table's cells. */
export interface AdminColumn {
  key: string;
  label: string;
  sortable?: boolean;
}

const cell = (key: string, label: string, value: string) => ({ key, label, value });
const col = (key: string, label: string): AdminColumn => ({ key, label });

// ---------------------------------------------------------------- roles

export const roleColumns = (): AdminColumn[] => [
  col('role', t('ui.admin.roles.col.role')),
  col('members', t('ui.admin.roles.col.members')),
  col('twoStep', t('ui.people.col.twoStep')),
];

export function roleRow(r: RoleSummary): RowView {
  const members = t('ui.admin.roles.members', { count: r.members });
  const twoStep = r.requireTwoStep ? t('ui.admin.roles.required') : '—';
  return {
    id: r.key,
    title: r.label,
    subtitle: members,
    ...(r.requireTwoStep && { lines: [twoStep] }),
    cells: [cell('role', t('ui.admin.roles.col.role'), r.label), cell('members', t('ui.admin.roles.col.members'), formatNumber(r.members)), cell('twoStep', t('ui.people.col.twoStep'), twoStep)],
    actions: [],
  };
}

export const memberColumns = (): AdminColumn[] => [
  col('person', t('ui.people.col.person')),
  col('status', t('ui.people.col.status')),
  col('otherRoles', t('ui.admin.roles.otherRoles')),
  col('joined', t('ui.people.col.joined')),
];

const STATUS_TONE: Record<string, Tone> = { active: 'success', invited: 'primary', suspended: 'warning' };

/** A role's member, with Remove. */
export function memberRow(p: PersonItem, role: string, roles: RoleOption[]): RowView {
  const status = p.status ?? 'active';
  const others = roleNames(
    p.roles.filter((r) => r !== role),
    roles,
  );
  return {
    id: p.userId,
    title: p.displayName,
    subtitle: p.email,
    lines: [`${t('ui.admin.roles.otherRoles')}: ${others}`],
    meta: joinedText(p),
    badge: { label: statusLabel(status), tone: STATUS_TONE[status] ?? 'neutral' },
    cells: [
      cell('person', t('ui.people.col.person'), p.displayName),
      cell('status', t('ui.people.col.status'), statusLabel(status)),
      cell('otherRoles', t('ui.admin.roles.otherRoles'), others),
      cell('joined', t('ui.people.col.joined'), joinedText(p)),
    ],
    actions: [{ id: 'remove', label: t('ui.common.remove') }],
  };
}

// ----------------------------------------------------------- connectors

export const connectorColumns = (): AdminColumn[] => [
  col('connector', t('ui.crumbs.admin.connectors')),
  col('kind', t('ui.admin.connectors.col.kind')),
  col('usedBy', t('ui.admin.connectors.col.usedBy')),
  col('last', t('ui.admin.connectors.col.last')),
  col('state', t('ui.admin.connectors.col.state')),
];

export function connectorRow(c: ConnectorSummary, now: Date): RowView {
  const used = c.usedBy.join(', ') || t('ui.admin.connectors.notUsed');
  const last = c.lastDelivery ? `${noticeTime(c.lastDelivery.at, now)} · ${deliveryLabel(c.lastDelivery.status)}` : '—';
  const state = summaryState(c);
  const tone: Tone = c.lastDelivery?.status === 'failed' ? 'danger' : c.enabled && c.configured ? 'success' : 'neutral';
  return {
    id: c.key,
    title: c.key,
    subtitle: kindLabel(c.kind),
    lines: [used],
    meta: last,
    badge: { label: state, tone },
    cells: [
      cell('connector', t('ui.crumbs.admin.connectors'), c.key),
      cell('kind', t('ui.admin.connectors.col.kind'), kindLabel(c.kind)),
      cell('usedBy', t('ui.admin.connectors.col.usedBy'), used),
      cell('last', t('ui.admin.connectors.col.last'), last),
      cell('state', t('ui.admin.connectors.col.state'), state),
    ],
    actions: [],
  };
}

export const deliveryColumns = (): AdminColumn[] => [
  col('sent', t('ui.admin.connectors.del.sent')),
  col('record', t('ui.admin.connectors.del.record')),
  col('tries', t('ui.admin.connectors.del.tries')),
  col('result', t('ui.admin.connectors.del.result')),
];

const DELIVERY_TONE: Record<Delivery['status'], Tone> = { sent: 'success', failed: 'danger', pending: 'primary' };

export function deliveryRow(d: Delivery, now: Date): RowView {
  const sent = `${noticeTime(d.createdAt, now)} · ${d.event}`;
  const tries = [t('ui.admin.connectors.tries', { count: d.attempts }), d.error ?? ''].filter(Boolean).join(' · ');
  return {
    id: d.id,
    title: sent,
    subtitle: d.recordId ?? '—',
    lines: [tries],
    badge: { label: deliveryLabel(d.status), tone: DELIVERY_TONE[d.status] },
    cells: [
      cell('sent', t('ui.admin.connectors.del.sent'), sent),
      cell('record', t('ui.admin.connectors.del.record'), d.recordId ?? '—'),
      cell('tries', t('ui.admin.connectors.del.tries'), tries),
      cell('result', t('ui.admin.connectors.del.result'), deliveryLabel(d.status)),
    ],
    actions: [],
  };
}

// ------------------------------------------------------------- API keys

export const apiKeyColumns = (): AdminColumn[] => [
  col('name', t('ui.admin.keys.col.name')),
  col('actsAs', t('ui.admin.keys.col.actsAs')),
  col('created', t('ui.admin.keys.col.created')),
  col('lastUsed', t('ui.admin.keys.col.lastUsed')),
  col('state', t('ui.admin.keys.col.state')),
];

export function apiKeyRow(k: ApiKey, subjectLabel: string, now: Date): RowView {
  const subtitle = k.feed ? t('ui.admin.keys.readsFeed', { feed: subjectLabel }) : t('ui.admin.keys.actsAs', { role: subjectLabel });
  const created = formatDate(k.createdAt);
  const used = k.lastUsedAt ? noticeTime(k.lastUsedAt, now) : t('ui.admin.keys.never');
  const state = k.revokedAt ? t('ui.admin.keys.revoked') : t('ui.admin.keys.active');
  return {
    id: k.id,
    title: k.name,
    subtitle,
    lines: [created],
    meta: used,
    badge: { label: state, tone: k.revokedAt ? 'neutral' : 'success' },
    ...(k.revokedAt && { muted: true }),
    cells: [
      cell('name', t('ui.admin.keys.col.name'), k.name),
      cell('actsAs', t('ui.admin.keys.col.actsAs'), subjectLabel),
      cell('created', t('ui.admin.keys.col.created'), created),
      cell('lastUsed', t('ui.admin.keys.col.lastUsed'), used),
      cell('state', t('ui.admin.keys.col.state'), state),
    ],
    actions: k.revokedAt ? [] : [{ id: 'revoke', label: t('ui.admin.keys.revoke'), tone: 'danger' }],
  };
}

// ----------------------------------------------------------------- jobs

export const jobColumns = (): AdminColumn[] => [
  col('job', t('ui.admin.jobs.col.job')),
  col('started', t('ui.admin.jobs.col.started')),
  col('progress', t('ui.admin.jobs.col.progress')),
  col('state', t('ui.admin.jobs.col.state')),
];

const JOB_TONE: Record<JobRow['status'], Tone> = { queued: 'neutral', running: 'primary', done: 'success', failed: 'danger', cancelled: 'warning' };

export function jobProgress(j: JobRow): string {
  return j.total ? t('ui.admin.jobs.progress', { done: formatNumber(j.progress), total: formatNumber(j.total) }) : t('ui.bulk.done', { count: formatNumber(j.progress) });
}

export function jobRow(j: JobRow, now: Date): RowView {
  const by = j.createdBy.startsWith('system') ? t('ui.admin.jobs.system') : (j.createdByName ?? j.createdBy);
  const started = `${by} · ${noticeTime(j.createdAt, now)}`;
  const progress = jobProgress(j);
  const state = t(`ui.admin.jobs.status.${j.status}`);
  const running = j.status === 'queued' || j.status === 'running';
  return {
    id: j.id,
    title: j.label ?? j.kind,
    subtitle: started,
    lines: [progress],
    badge: { label: state, tone: JOB_TONE[j.status] },
    cells: [
      cell('job', t('ui.admin.jobs.col.job'), j.label ?? j.kind),
      cell('started', t('ui.admin.jobs.col.started'), started),
      cell('progress', t('ui.admin.jobs.col.progress'), progress),
      cell('state', t('ui.admin.jobs.col.state'), state),
    ],
    actions: running ? [{ id: 'cancel', label: t('ui.admin.jobs.cancel'), tone: 'danger' }] : [],
  };
}

// ---------------------------------------------------------------- audit

export const auditColumns = (): AdminColumn[] => [
  col('when', t('ui.admin.audit.col.when')),
  col('who', t('ui.admin.audit.col.who')),
  col('what', t('ui.admin.audit.col.what')),
  col('area', t('ui.admin.audit.col.area')),
];

const AUDIT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function auditWho(e: AuditEntry): string {
  if (e.actorName) return e.actorName;
  if (e.actorId?.startsWith('system')) return t('ui.admin.jobs.system');
  return t('ui.admin.audit.someone');
}

function auditWords(value: string | null | undefined): string {
  return (value ?? '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}

function auditOpening(words: string): string {
  return words ? words[0]!.toUpperCase() + words.slice(1) : words;
}

/** What an event happened to, in the words people use: `tenant` is the organisation. */
function auditThing(entity: string | null | undefined): string {
  const key = `ui.admin.audit.thing.${entity ?? ''}`;
  return currentTranslator().has(key) ? t(key) : auditWords(entity);
}

/** A sentence for the audit row. Who it was is the Who column, so the name is not repeated here, and UUIDs stay off this line. */
export function auditSentence(e: AuditEntry, typeLabel: (key: string) => string): string {
  if (e.action === 'signed_in') return t('ui.admin.audit.signedIn');
  if (e.action === 'definition.published') {
    const what = e.entity === 'definition:theme' && e.entityId === 'organisation' ? t('ui.admin.audit.organisationTheme') : auditWords((e.entity ?? '').replace(/^definition:/, ''));
    return t('ui.admin.audit.published', { what });
  }
  if (e.action === 'settings.changed') return t('ui.admin.audit.settingsChanged');
  const action = auditOpening(auditWords(e.action));
  const target = e.recordType ? typeLabel(e.recordType) : auditThing(e.entity);
  const id = e.entityId && !AUDIT_UUID.test(e.entityId) ? e.entityId : '';
  const detail = [target, id].filter(Boolean).join(' ');
  return detail ? t('ui.admin.audit.did', { action, detail }) : t('ui.admin.audit.didBare', { action });
}

export function auditRow(e: AuditEntry, typeLabel: (key: string) => string, now: Date): RowView {
  const when = noticeTime(e.at, now);
  const who = auditWho(e);
  const what = auditSentence(e, typeLabel);
  const area = e.area ? t(`ui.admin.audit.area.${e.area}`) : '—';
  return {
    id: String(e.id),
    title: what,
    subtitle: `${when} · ${who}`,
    badge: { label: area, tone: 'primary' },
    cells: [cell('when', t('ui.admin.audit.col.when'), when), cell('who', t('ui.admin.audit.col.who'), who), cell('what', t('ui.admin.audit.col.what'), what), cell('area', t('ui.admin.audit.col.area'), area)],
    actions: [],
  };
}
