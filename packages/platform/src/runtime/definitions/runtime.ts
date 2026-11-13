import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, validationFailed } from '@onengo/kernel/errors';
import { can } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { LAYOUT_SETTING, readLayout, type SettingReader } from './appearance.js';
import { actionPermission } from './action-permissions.js';
import type { DefinitionService } from './definition-service.js';
import { canEditField, canReadField } from './field-permissions.js';
import { LOCALE_PATTERN, SHIPPED_LOCALES, type MessageCatalogue } from './messages.js';
import type { LocaleStore } from './ports/locale-store.js';
import { resolveRecordGroups } from './record-groups.js';
import { translateBody } from './translate.js';
import type { ActionDef, ListViewDef, PageDef, Widget, WorkflowDef } from './types.js';
import { isPrimary, workflowsOf } from './workflows.js';

const OTHER_GROUP = 'ui.records.otherGroup';
const SHARED_CHIP = 'shared';
const SHARED_LABEL = 'ui.records.sharedWithMe';

/**
 * What the app needs to draw menus, lists, forms and pages for the signed-in
 * person, in their language. The server still enforces every rule; this only
 * leaves out what the person cannot use.
 */
export class RuntimeService {
  constructor(
    private readonly tm: TransactionManager,
    private readonly locales: LocaleStore,
    private readonly defs: DefinitionService,
    private readonly catalogue: MessageCatalogue,
    private readonly settings: SettingReader,
  ) {}

  /** The requested language, else the person's choice, else the organisation's default. */
  async localeFor(ctx: TenantContext, requested?: string): Promise<string> {
    if (requested && LOCALE_PATTERN.test(requested)) return requested;
    return (await this.tm.withTenant(ctx.tenantId, (tx) => this.locales.locale(tx, ctx.actor.id))) ?? 'en';
  }

  /** A member's own language, else the organisation's default, for work with no signed-in person such as an emailed link. */
  async localeOfMember(tenantId: string, userId: string): Promise<string> {
    return (await this.tm.withTenant(tenantId, (tx) => this.locales.locale(tx, userId))) ?? 'en';
  }

  async setLocale(ctx: TenantContext, locale: string): Promise<{ locale: string }> {
    if (!LOCALE_PATTERN.test(locale)) throw validationFailed('Choose a language.');
    const known = (SHIPPED_LOCALES as readonly string[]).includes(locale) || (await this.defs.list(ctx.tenantId, 'translation')).some((t) => t.body.locale === locale);
    if (!known) throw validationFailed(`'${locale}' is not a language this organisation offers.`);
    const updated = await this.tm.withTenant(ctx.tenantId, (tx) => this.locales.setLocale(tx, ctx.actor.id, locale));
    if (!updated) throw notFound('You are not a member of this organisation.');
    return { locale };
  }

  /** The organisation's translations for a language, merged. */
  async entries(tenantId: string, locale: string): Promise<Record<string, string>> {
    const mine = (await this.defs.list(tenantId, 'translation')).filter((t) => t.body.locale === locale);
    return Object.assign({}, ...mine.map((t) => t.body.entries));
  }

  /** Shipped screen text in the language (English where missing), then the organisation's own `ui.*` wording. */
  async messages(ctx: TenantContext, requested?: string): Promise<{ locale: string; messages: Record<string, string> }> {
    const locale = await this.localeFor(ctx, requested);
    return { locale, messages: await this.text(ctx.tenantId, locale) };
  }

  /** The same screen text for work with no signed-in person, such as an emailed link. */
  async text(tenantId: string, locale: string): Promise<Record<string, string>> {
    const own = Object.entries(await this.entries(tenantId, locale)).filter(([k]) => k.startsWith('ui.'));
    return { ...this.catalogue.messages(locale), ...Object.fromEntries(own) };
  }

  async definitions(ctx: TenantContext, requested?: string) {
    const locale = await this.localeFor(ctx, requested);
    const entries = await this.entries(ctx.tenantId, locale);
    const ui = { ...this.catalogue.messages(locale), ...entries };
    const types = (await this.defs.list(ctx.tenantId, 'recordType')).filter((t) => can(ctx.actor, `record:${t.key}:read`));
    const readable = new Set(types.map((t) => t.key));
    const allWorkflows = await this.defs.list(ctx.tenantId, 'workflow');

    const themes = await this.defs.list(ctx.tenantId, 'theme');
    const theme = (themes.find((t) => t.key === 'organisation') ?? themes[0])?.body ?? null;
    const layout = readLayout(await this.tm.withTenant(ctx.tenantId, (tx) => this.settings.setting(tx, LAYOUT_SETTING)));

    const allowed = (permission: string | undefined) => !permission || can(ctx.actor, permission);
    const restricted = new Set(types.filter((t) => t.body.visibility === 'restricted').map((t) => t.key));
    const listViews: Record<string, ListViewDef> = {};
    for (const v of (await this.defs.list(ctx.tenantId, 'listView')).sort((a, b) => a.key.localeCompare(b.key))) {
      if (!readable.has(v.body.recordType) || listViews[v.body.recordType]) continue;
      const view = translateBody('listView', v.body, entries);
      // Chips the person cannot use are dropped here; the query API still enforces read access.
      const chips = view.chips?.filter((c) => !c.permission || can(ctx.actor, c.permission)) ?? [];
      if (restricted.has(v.body.recordType) && !chips.some((c) => c.shared || c.id === SHARED_CHIP)) {
        chips.push({ id: SHARED_CHIP, label: ui[SHARED_LABEL] ?? 'Shared with me', shared: true });
      }
      const detail = view.detail && { ...view.detail, sections: view.detail.sections.filter((s) => allowed(s.permission)) };
      listViews[v.body.recordType] = { ...view, chips: chips.length || view.chips ? chips : undefined, ...(detail ? { detail } : {}) };
    }

    const withAllowed = (w: WorkflowDef) => {
      const t = translateBody('workflow', w, entries);
      return { ...t, transitions: t.transitions.map((tr) => ({ ...tr, allowed: can(ctx.actor, tr.permission ?? `record:${w.recordType}:transition:${tr.key}`) })) };
    };
    const workflowSets = Object.fromEntries(types.map((t) => [t.key, workflowsOf(allWorkflows, t.key, (w) => w.body).map((w) => withAllowed(w.body))]));
    const workflows = Object.fromEntries(
      Object.entries(workflowSets)
        .map(([k, set]) => [k, set.find((w) => isPrimary(w))] as const)
        .filter(([, w]) => !!w),
    );

    const groups = (await this.defs.list(ctx.tenantId, 'recordGroup')).map((g) => translateBody('recordGroup', g.body, entries));
    const listed = types.map((t) => t.key);
    const recordGroups = resolveRecordGroups(groups, listed).map((g) =>
      g.key === 'other' && !groups.some((x) => x.key === 'other') ? { ...g, label: ui[OTHER_GROUP] ?? g.label } : g,
    );

    const actions: Record<string, (Omit<ActionDef, 'steps'> & { steps: { type: string }[]; allowed: boolean })[]> = {};
    for (const a of (await this.defs.list(ctx.tenantId, 'action')).sort((x, y) => x.key.localeCompare(y.key))) {
      if (!readable.has(a.body.recordType)) continue;
      const t = translateBody('action', a.body, entries);
      // Step settings (connectors, accounts) stay on the server; the app only needs to know what kind each step is.
      (actions[a.body.recordType] ??= []).push({
        ...t,
        steps: t.steps.map((s) => ({ type: s.type })),
        allowed: can(ctx.actor, actionPermission(a.body)),
      });
    }

    const pages: PageDef[] = [];
    const listTypes = new Map((await this.defs.list(ctx.tenantId, 'listView')).map((v) => [v.key, v.body.recordType]));
    for (const p of await this.defs.list(ctx.tenantId, 'page')) {
      if (!inAudience(ctx, p.body)) continue;
      const t = translateBody('page', p.body, entries);
      pages.push({
        ...t,
        // `index` is the widget's place in the published page, which names it when asking for its counts.
        widgets: t.widgets
          .map((w, index) => ({ ...w, index }))
          .filter((w) => widgetVisible(ctx, w, readable, listTypes))
          .map((w) => (w.type === 'links' ? { ...w, items: w.items.filter((i) => allowed(i.permission)) } : w))
          .filter((w) => w.type !== 'links' || w.items.length > 0),
      });
    }

    return {
      locale,
      theme,
      ...(layout
        ? {
            navigation: { items: layout.items, ...(layout.icons ? { icons: layout.icons } : {}) },
            listLayout: layout.listLayout,
          }
        : {}),
      listViews,
      recordGroups,
      recordTypes: types.map((t) => {
        const body = translateBody('recordType', t.body, entries);
        return {
          ...body,
          fields: body.fields.map((f) => ({
            ...f,
            ...(canReadField(ctx.actor, t.body, f) ? {} : { masked: true }),
            ...(canEditField(ctx.actor, f) ? {} : { readOnly: true }),
          })),
          version: t.version,
          canCreate: can(ctx.actor, `record:${t.key}:create`),
          canUpdate: can(ctx.actor, `record:${t.key}:update`),
        };
      }),
      workflows,
      workflowSets,
      actions,
      pages: pages.sort((a, b) => (a.key === 'home' ? -1 : b.key === 'home' ? 1 : a.label.localeCompare(b.label))),
    };
  }

  /**
   * Refuses counts and totals asked for a page widget the person cannot see:
   * outside the page audience, or without the widget's permission.
   */
  async assertWidgetVisible(ctx: TenantContext, pageKey: string, index: number): Promise<void> {
    const page = await this.defs.get(ctx.tenantId, 'page', pageKey);
    const widget = page?.body.widgets[index];
    if (!page || !widget) throw notFound('Widget not found.');
    const readable = new Set((await this.defs.list(ctx.tenantId, 'recordType')).filter((t) => can(ctx.actor, `record:${t.key}:read`)).map((t) => t.key));
    const listTypes = new Map((await this.defs.list(ctx.tenantId, 'listView')).map((v) => [v.key, v.body.recordType]));
    if (!inAudience(ctx, page.body) || !widgetVisible(ctx, widget, readable, listTypes)) throw forbidden('You cannot see this widget.');
  }
}

function inAudience(ctx: TenantContext, page: PageDef): boolean {
  return !page.audience?.length || page.audience.some((r) => ctx.actor.roles.includes(r));
}

function widgetVisible(ctx: TenantContext, w: Widget, readable: ReadonlySet<string>, listTypes: ReadonlyMap<string, string>): boolean {
  if (w.permission && !can(ctx.actor, w.permission)) return false;
  if (w.type === 'stat' || w.type === 'chart') return readable.has(w.recordType);
  if (w.type === 'list') return readable.has(listTypes.get(w.listView) ?? '');
  return true;
}
