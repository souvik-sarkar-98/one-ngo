import { compileExpression } from '../../runtime/expressions/expression.js';
import type { Actor, TenantContext } from '../../domain/ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import type { OutboxEvent } from './ports/outbox-event.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import { canReadField, isReadProtected, MASK } from '../../runtime/definitions/field-permissions.js';
import { renderEmailHtml, renderTemplate } from '../../runtime/definitions/template.js';
import type { FieldDef, NotifyChannel, RecipientDef } from '../../runtime/definitions/types.js';
import type { SensitiveFields } from '../../runtime/records/sensitive.js';
import type { NewNotification, NotificationStore } from './ports/notification-store.js';
import type { EmailTransport } from '@onengo/kernel/ports';
import { normalisePhone } from '../shared/phone.js';

/** Delivery attempts an outbox event gets before it is final; the outbox dispatcher in infrastructure uses the same number. */
const MAX_ATTEMPTS = 5;

export interface NotifyInput {
  template: string;
  to: RecipientDef;
  channels?: NotifyChannel[];
  scope: Record<string, unknown>;
  recordId?: string;
  creatorId?: string | null;
  /** The record type of `scope.record`; its fields are masked for recipients who may not see them. */
  recordType?: string;
}

export type PhoneChannel = 'sms' | 'whatsapp';

export interface PhoneMessage {
  to: string;
  text: string;
  /** Approved WhatsApp template with its evaluated parameters; WhatsApp only. */
  whatsapp?: { name: string; language: string; parameters: string[] };
  recordId: string | null;
}

/**
 * Sends through the organisation's enabled connector for the channel.
 * Resolves false, without calling anything, when there is none.
 */
export type PhoneSender = (
  tenantId: string,
  channel: PhoneChannel,
  message: PhoneMessage,
  delivery: { eventId: string; final: boolean },
) => Promise<boolean>;

export { normalisePhone };

export interface InboxItem {
  id: string;
  subject: string;
  body: string;
  recordId: string | null;
  /** In-app address to open instead of the record, for example a finished import. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface InboxOptions {
  unreadOnly?: boolean;
  limit?: number;
  /** Id of the last notification of the previous page. */
  before?: string;
}

const UUID = /^[0-9a-f-]{36}$/i;

export type TransportResolver = (tenantId: string) => Promise<EmailTransport | undefined>;

export class NotificationService {
  constructor(
    private readonly tm: TransactionManager,
    private readonly store: NotificationStore,
    private readonly defs: DefinitionReader,
    private readonly sensitive: SensitiveFields,
    private readonly transportFor: TransportResolver,
    private readonly audit: AuditTrail,
    private readonly phoneSender?: PhoneSender,
  ) {}

  /** The same service working through other transactions, such as one the caller already holds (`joinTx`). */
  within(tm: TransactionManager): NotificationService {
    return new NotificationService(tm, this.store, this.defs, this.sensitive, this.transportFor, this.audit, this.phoneSender);
  }

  /**
   * Renders a template in each recipient's language (the organisation's
   * translation of the subject and message, else the published English) and
   * creates notifications for every recipient. In-app messages are stored
   * immediately; emails, SMS and WhatsApp messages are queued for the
   * dispatcher. SMS and WhatsApp go only to the `phone` recipient.
   * Fields a recipient may not see are masked for them; addresses outside the
   * organisation see every protected field masked.
   */
  async notify(tenantId: string, input: NotifyInput): Promise<number> {
    const template = await this.defs.get(tenantId, 'template', input.template);
    if (!template) throw ruleViolation(`Template '${input.template}' is not published.`);
    const translations = (await this.defs.list(tenantId, 'translation')).map((t) => t.body);
    const type = input.recordType ? (await this.defs.get(tenantId, 'recordType', input.recordType))?.body : undefined;
    const protectedFields = type ? type.fields.filter((f) => isReadProtected(type, f)) : [];
    const hiddenFor = (actor: Actor | null) => (actor ? protectedFields.filter((f) => !canReadField(actor, type!, f)) : protectedFields);
    const scopeWithout = (hidden: FieldDef[]) => {
      if (!hidden.length) return input.scope;
      const mask = (v: unknown) => {
        if (!v || typeof v !== 'object') return v;
        const out = { ...(v as Record<string, unknown>) };
        for (const f of hidden) if (out[f.key] !== undefined) out[f.key] = MASK;
        return out;
      };
      return { ...input.scope, record: mask(input.scope.record), previous: mask(input.scope.previous) };
    };
    const rendered = new Map<string, { subject: string; body: string; html?: string }>();
    const inLocale = (locale: string, hidden: FieldDef[] = []) => {
      const cacheKey = JSON.stringify([locale, hidden.map((f) => f.key)]);
      let r = rendered.get(cacheKey);
      if (!r) {
        const entries = Object.assign({}, ...translations.filter((t) => t.locale === locale).map((t) => t.entries)) as Record<string, string>;
        const path = `template.${template.key}`;
        const scope = scopeWithout(hidden);
        const htmlSource = entries[`${path}.html`] ?? template.body.html;
        const html = htmlSource?.trim() ? renderEmailHtml(htmlSource, scope) : '';
        r = {
          subject: renderTemplate(entries[`${path}.subject`] ?? template.body.subject, scope).slice(0, 200),
          body: renderTemplate(entries[`${path}.body`] ?? template.body.body, scope),
          ...(html ? { html } : {}),
        };
        rendered.set(cacheKey, r);
      }
      return r;
    };
    const channels: NotifyChannel[] = input.channels?.length ? input.channels : ['inApp', 'email'];
    const extraEmail = input.to.email ? compileExpression(input.to.email).evaluate(input.scope) : null;
    const wantsPhone = channels.some((c) => c === 'sms' || c === 'whatsapp');
    const expressionPhone = input.to.phone && wantsPhone ? normalisePhone(compileExpression(input.to.phone).evaluate(input.scope)) : null;
    const wa = template.body.whatsapp;
    const whatsapp = wa
      ? {
          name: wa.name,
          language: wa.language ?? 'en',
          parameters: (wa.parameters ?? []).map((p) => String(compileExpression(p).evaluate(scopeWithout(hiddenFor(null))) ?? '')),
        }
      : undefined;

    const chosen = input.to.field ? (input.scope.record as Record<string, unknown> | undefined)?.[input.to.field] : undefined;
    const fieldPerson = typeof chosen === 'string' && UUID.test(chosen) ? chosen : null;

    return this.tm.withTenant(tenantId, async (tx) => {
      const users = await this.resolveUsers(tx, input.to, input.creatorId ?? null, fieldPerson);
      const actors = protectedFields.length ? await this.actorsOf(tx, users.map((u) => u.id)) : new Map<string, Actor>();
      const phone = expressionPhone;
      let created = 0;
      for (const u of users) {
        const { subject, body, html } = inLocale(u.locale, protectedFields.length ? hiddenFor(actors.get(u.id) ?? null) : []);
        if (channels.includes('inApp')) {
          await this.insert(tx, { userId: u.id, channel: 'inApp', to: null, subject, body, recordId: input.recordId, status: 'sent' });
          created++;
        }
        if (channels.includes('email') && u.email) {
          const id = await this.insert(tx, { userId: u.id, channel: 'email', to: u.email, subject, body, ...(html ? { html } : {}), recordId: input.recordId, status: 'pending' });
          await this.audit.event(tx, 'notification.email', { notificationId: id });
          created++;
        }
      }
      const defaultLocale = async () => (await this.store.defaultLocale(tx)) ?? 'en';
      if (typeof extraEmail === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(extraEmail) && channels.includes('email')) {
        const { subject, body, html } = inLocale(await defaultLocale(), hiddenFor(null));
        const id = await this.insert(tx, { userId: null, channel: 'email', to: extraEmail, subject, body, ...(html ? { html } : {}), recordId: input.recordId, status: 'pending' });
        await this.audit.event(tx, 'notification.email', { notificationId: id });
        created++;
      }
      if (phone) {
        const { subject, body } = inLocale(await defaultLocale(), hiddenFor(null));
        for (const channel of ['sms', 'whatsapp'] as const) {
          if (!channels.includes(channel)) continue;
          const id = await this.insert(tx, { userId: null, channel, to: phone, subject, body, recordId: input.recordId, status: 'pending' });
          await this.audit.event(tx, `notification.${channel}`, channel === 'whatsapp' && whatsapp ? { notificationId: id, whatsapp } : { notificationId: id });
          created++;
        }
      }
      return created;
    });
  }

  /** Built-in in-app message (approvals and similar), not driven by a template. */
  async notifyText(
    tenantId: string,
    input: { to: RecipientDef; subject: string; body: string; recordId?: string; link?: string; exclude?: string[] },
  ): Promise<number> {
    return this.tm.withTenant(tenantId, async (tx) => {
      const users = (await this.resolveUsers(tx, input.to, null)).filter((u) => !input.exclude?.includes(u.id));
      for (const u of users) {
        await this.insert(tx, {
          userId: u.id,
          channel: 'inApp',
          to: null,
          subject: input.subject.slice(0, 200),
          body: input.body,
          recordId: input.recordId,
          link: input.link,
          status: 'sent',
        });
      }
      return users.length;
    });
  }

  /** Sends now (for sign-in codes); falls back to the queue if sending fails. */
  async sendImmediateEmail(tenantId: string, to: string, subject: string, body: string, html?: string): Promise<void> {
    const id = await this.tm.withTenant(tenantId, (tx) =>
      this.insert(tx, { userId: null, channel: 'email', to, subject, body, ...(html ? { html } : {}), status: 'pending' }),
    );
    try {
      await this.deliverEmail(tenantId, id);
    } catch {
      await this.tm.withTenant(tenantId, (tx) => this.audit.event(tx, 'notification.email', { notificationId: id }));
    }
  }

  /** Dispatcher handler for queued emails. Throws so the dispatcher retries. */
  async deliverEmail(tenantId: string, notificationId: string): Promise<void> {
    const n = await this.tm.withTenant(tenantId, (tx) => this.store.outgoing(tx, notificationId));
    if (!n || n.status === 'sent') return;
    const transport = await this.transportFor(tenantId);
    if (!transport) {
      await this.mark(tenantId, notificationId, 'skipped', 'Email is not configured for this organisation.');
      return;
    }
    try {
      await transport.send({ to: n.to_address, subject: n.subject, text: n.body, ...(n.html ? { html: n.html } : {}) });
      await this.mark(tenantId, notificationId, 'sent', null);
    } catch (error) {
      await this.mark(tenantId, notificationId, 'pending', (error as Error).message.slice(0, 500));
      throw error;
    }
  }

  /** Dispatcher handler for queued SMS and WhatsApp messages. Throws so the dispatcher retries. */
  async deliverPhone(event: OutboxEvent): Promise<void> {
    const channel: PhoneChannel = event.type === 'notification.whatsapp' ? 'whatsapp' : 'sms';
    const notificationId = String(event.payload.notificationId);
    const n = await this.tm.withTenant(event.tenantId, (tx) => this.store.outgoing(tx, notificationId));
    if (!n || n.status === 'sent') return;
    const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
    const final = event.attempts >= MAX_ATTEMPTS;
    try {
      const sent = this.phoneSender
        ? await this.phoneSender(
            event.tenantId,
            channel,
            { to: n.to_address, text: n.body, whatsapp: event.payload.whatsapp as PhoneMessage['whatsapp'], recordId: n.record_id },
            { eventId: event.id, final },
          )
        : false;
      if (sent) await this.mark(event.tenantId, notificationId, 'sent', null);
      else await this.mark(event.tenantId, notificationId, 'skipped', `${label} is not configured for this organisation.`);
    } catch (error) {
      await this.mark(event.tenantId, notificationId, final ? 'failed' : 'pending', (error as Error).message.slice(0, 500));
      throw error;
    }
  }

  async inbox(ctx: TenantContext, options: InboxOptions = {}): Promise<InboxItem[]> {
    return (await this.inboxPage(ctx, options)).items;
  }

  /** Newest first. `next` is the id to pass as `before` for the following page; null on the last page. */
  async inboxPage(ctx: TenantContext, options: InboxOptions = {}): Promise<{ items: InboxItem[]; next: string | null }> {
    if (options.before !== undefined && !UUID.test(options.before)) throw validationFailed('The paging cursor is not valid.');
    if (!UUID.test(ctx.actor.id)) return { items: [], next: null };
    const limit = Math.min(Math.max(Math.trunc(Number(options.limit)) || 50, 1), 200);
    const rows = await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.store.inbox(tx, ctx.actor.id, { unreadOnly: !!options.unreadOnly, before: options.before, limit: limit + 1 }),
    );
    const iso = (v: Date | string) => new Date(v).toISOString();
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      subject: r.subject,
      body: r.body,
      recordId: r.record_id,
      link: r.link,
      readAt: r.read_at ? iso(r.read_at) : null,
      createdAt: iso(r.created_at),
    }));
    return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
  }

  /** Marks every unread in-app notification of the person read; returns how many changed. */
  async markAllRead(ctx: TenantContext): Promise<number> {
    if (!UUID.test(ctx.actor.id)) return 0;
    return this.tm.withTenant(ctx.tenantId, (tx) => this.store.markAllRead(tx, ctx.actor.id));
  }

  async markRead(ctx: TenantContext, id: string): Promise<void> {
    const marked = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.markRead(tx, ctx.actor.id, id));
    if (!marked) throw notFound('Notification not found.');
  }

  private async resolveUsers(
    tx: Tx,
    to: RecipientDef,
    creatorId: string | null,
    fieldPerson: string | null = null,
  ): Promise<{ id: string; email: string | null; locale: string }[]> {
    const ids = new Set<string>(to.users ?? []);
    if (to.creator && creatorId && UUID.test(creatorId)) ids.add(creatorId);
    if (fieldPerson) ids.add(fieldPerson);
    if (to.roles?.length) {
      for (const userId of await this.store.roleMembers(tx, to.roles)) ids.add(userId);
    }
    const valid = [...ids].filter((i) => UUID.test(i));
    if (!valid.length) return [];
    return this.store.activeMembers(tx, valid);
  }

  /** The permissions each person holds here through their roles. */
  private async actorsOf(tx: Tx, userIds: string[]): Promise<Map<string, Actor>> {
    const out = new Map<string, Actor>();
    if (!userIds.length) return out;
    for (const r of await this.store.roleGrants(tx, userIds)) {
      const actor = out.get(r.user_id) ?? { id: r.user_id, roles: [], permissions: [] };
      actor.roles.push(r.role_key);
      actor.permissions.push(...r.permissions);
      out.set(r.user_id, actor);
    }
    return out;
  }

  private insert(tx: Tx, n: NewNotification): Promise<string> {
    return this.store.add(tx, n);
  }

  private async mark(tenantId: string, id: string, status: string, error: string | null): Promise<void> {
    await this.tm.withTenant(tenantId, (tx) => this.store.mark(tx, id, status, error));
  }
}
