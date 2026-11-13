import { formatDate, t } from '../i18n/i18n';
import type { DetailSection, FilterPill } from '../records/record/present';
import type { ChipSpec } from '../records/spec';
import type { RowView, Tone } from '../rows';
import { DIRECTORY_SORTS, MANAGEMENT_SORTS, STATUS_CHIPS, type PeopleAddress, type PeopleVariant } from './address';
import type { MemberStatus, PeoplePage, PersonItem, RoleOption, TwoStepState } from './people';

const STATUS_TONE: Record<MemberStatus, Tone> = { active: 'success', invited: 'primary', suspended: 'warning' };

export const statusLabel = (s: MemberStatus) => t(`ui.people.status.${s}`);

export function twoStepLabel(s: TwoStepState | undefined): string {
  if (s === 'on') return t('ui.more.on');
  if (s === 'off') return t('ui.more.off');
  return s ? t('ui.people.twoStepRequired') : '—';
}

export function roleNames(roles: readonly string[], options: readonly RoleOption[]): string {
  return roles.map((r) => options.find((o) => o.key === r)?.label ?? r).join(', ') || '—';
}

/** When they joined, or when they were invited if they never signed in. */
export function joinedText(p: PersonItem): string {
  if (p.status === 'invited') return p.invitedAt ? t('ui.people.invitedOn', { date: formatDate(p.invitedAt) }) : statusLabel('invited');
  return p.joinedAt ? formatDate(p.joinedAt) : '—';
}

export interface PeopleColumn {
  key: string;
  label: string;
  sortable: boolean;
}

/** The table's columns: name, email and roles; or person, roles, two-step, status and joined. */
export function peopleColumns(variant: PeopleVariant): PeopleColumn[] {
  if (variant === 'directory') {
    return [
      { key: 'name', label: t('ui.people.col.name'), sortable: true },
      { key: 'email', label: t('ui.people.col.email'), sortable: false },
      { key: 'roles', label: t('ui.people.col.roles'), sortable: false },
    ];
  }
  return [
    { key: 'name', label: t('ui.people.col.person'), sortable: true },
    { key: 'roles', label: t('ui.people.col.roles'), sortable: false },
    { key: 'twoStep', label: t('ui.people.col.twoStep'), sortable: false },
    { key: 'status', label: t('ui.people.col.status'), sortable: true },
    { key: 'joined', label: t('ui.people.col.joined'), sortable: true },
  ];
}

export function peopleSortOptions(variant: PeopleVariant): { key: string; label: string }[] {
  const label: Record<string, string> = { name: 'ui.people.col.name', joined: 'ui.people.col.joined', status: 'ui.people.col.status' };
  return (variant === 'directory' ? DIRECTORY_SORTS : MANAGEMENT_SORTS).map((key) => ({ key, label: t(label[key]!) }));
}

/** The row ⋮ for administrators: Change roles, Resend invitation, Suspend or Reactivate. */
export function personActions(p: PersonItem): RowView['actions'] {
  if (p.status === 'suspended') return [{ id: 'reactivate', label: t('ui.people.reactivate') }];
  return [
    { id: 'roles', label: t('ui.people.changeRoles') },
    { id: 'resend', label: t('ui.people.resend') },
    { id: 'suspend', label: t('ui.people.suspend'), divider: true, tone: 'danger' },
  ];
}

/**
 * One person as both layouts draw it. The directory shows no status, two-step
 * state, dates or actions; the card shows the same values as the table's cells.
 */
export function personRow(p: PersonItem, variant: PeopleVariant, page: Pick<PeoplePage, 'roles'>): RowView {
  const roles = roleNames(p.roles, page.roles);
  const cell = (key: string, label: string, value: string) => ({ key, label, value });
  if (variant === 'directory') {
    return {
      id: p.userId,
      title: p.displayName,
      subtitle: p.email,
      meta: roles,
      cells: [cell('name', t('ui.people.col.name'), p.displayName), cell('email', t('ui.people.col.email'), p.email), cell('roles', t('ui.people.col.roles'), roles)],
      actions: [],
    };
  }
  const status = p.status ?? 'active';
  const twoStep = twoStepLabel(p.twoStep);
  return {
    id: p.userId,
    title: p.displayName,
    subtitle: p.email,
    lines: [roles],
    meta: `${t('ui.people.col.twoStep')}: ${twoStep} · ${joinedText(p)}`,
    badge: { label: statusLabel(status), tone: STATUS_TONE[status] },
    cells: [
      cell('name', t('ui.people.col.person'), p.displayName),
      cell('roles', t('ui.people.col.roles'), roles),
      cell('twoStep', t('ui.people.col.twoStep'), twoStep),
      cell('status', t('ui.people.col.status'), statusLabel(status)),
      cell('joined', t('ui.people.col.joined'), joinedText(p)),
    ],
    actions: personActions(p),
  };
}

/** Status chips with their counts: Active, Invited, Suspended, All. */
export function statusChips(counts: PeoplePage['counts'] | undefined): ChipSpec[] {
  return STATUS_CHIPS.map((s) => {
    const label = t(`ui.people.status.${s}`);
    return { id: s, label: counts ? t('ui.people.chip', { label, count: counts[s] }) : label };
  });
}

export interface PeopleFilterSpec {
  key: string;
  label: string;
  options: { key: string; label: string }[];
}

/** The Role filter. */
export function peopleFilters(_variant: PeopleVariant, page: Pick<PeoplePage, 'roles'>): PeopleFilterSpec[] {
  return [{ key: 'role', label: t('ui.people.col.roles'), options: page.roles.map((r) => ({ key: r.key, label: r.label })) }];
}

/** One removable pill per applied role filter. */
export function peoplePills(a: PeopleAddress, filters: PeopleFilterSpec[]): FilterPill[] {
  if (!a.role.length) return [];
  const f = filters.find((x) => x.key === 'role');
  const names = a.role.map((v) => f?.options.find((o) => o.key === v)?.label ?? v);
  return [{ id: 'role', label: `${f?.label ?? t('ui.people.col.roles')}: ${names.join(', ')}` }];
}

/** The read-only person panel of the directory: contact and roles. */
export function directorySections(p: PersonItem, page: Pick<PeoplePage, 'roles'>): DetailSection[] {
  return [
    { kind: 'fields', id: 'contact', title: t('ui.people.contact'), fields: [{ label: t('ui.people.col.email'), value: p.email }] },
    { kind: 'fields', id: 'roles', title: t('ui.people.col.roles'), fields: [{ label: t('ui.people.col.roles'), value: roleNames(p.roles, page.roles) }] },
  ];
}
