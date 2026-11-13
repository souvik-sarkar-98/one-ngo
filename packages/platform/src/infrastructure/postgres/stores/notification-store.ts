import { sql } from 'kysely';
import type { InboxRow, NewNotification, NotificationStore, OutgoingNotification } from '../../../application/notifications/ports/notification-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

const APP_TENANT = sql<string>`app_tenant()`;
const NOW = sql<Date>`now()`;

export class PgNotificationStore implements NotificationStore {
  async roleMembers(tx: Tx, roles: string[]): Promise<string[]> {
    const rows = await pg(tx)
      .selectFrom('role_assignment as ra')
      .innerJoin('tenant_member as m', (j) => j.onRef('m.tenant_id', '=', 'ra.tenant_id').onRef('m.user_id', '=', 'ra.user_id').on('m.status', '=', 'active'))
      .select('ra.user_id')
      .distinct()
      .where('ra.tenant_id', '=', APP_TENANT)
      .where('ra.role_key', '=', sql<string>`any(${roles})`)
      .execute();
    return rows.map((r) => r.user_id);
  }

  activeMembers(tx: Tx, userIds: string[]) {
    return pg(tx)
      .selectFrom('app_user as u')
      .innerJoin('tenant_member as m', (j) => j.onRef('m.user_id', '=', 'u.id').on('m.tenant_id', '=', APP_TENANT).on('m.status', '=', 'active'))
      .innerJoin('tenant as t', (j) => j.on('t.id', '=', APP_TENANT))
      .select((eb) => ['u.id', 'u.email', eb.fn.coalesce('m.locale', 't.default_locale').as('locale')])
      .where('u.id', '=', sql<string>`any(${userIds}::uuid[])`)
      .where('u.status', '=', 'active')
      .execute();
  }

  roleGrants(tx: Tx, userIds: string[]) {
    return pg(tx)
      .selectFrom('role_assignment as ra')
      .innerJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 'ra.tenant_id').onRef('r.key', '=', 'ra.role_key'))
      .select(['ra.user_id', 'ra.role_key', 'r.permissions'])
      .where('ra.tenant_id', '=', APP_TENANT)
      .where('ra.user_id', '=', sql<string>`any(${userIds}::uuid[])`)
      .execute();
  }

  async defaultLocale(tx: Tx): Promise<string | null> {
    const tenant = await pg(tx).selectFrom('tenant').select('default_locale').where('id', '=', APP_TENANT).executeTakeFirst();
    return tenant?.default_locale ?? null;
  }

  async add(tx: Tx, n: NewNotification): Promise<string> {
    const row = await pg(tx)
      .insertInto('notification')
      .values({
        tenant_id: APP_TENANT,
        user_id: n.userId,
        channel: n.channel,
        to_address: n.to,
        subject: n.subject,
        body: n.body,
        html: n.html ?? null,
        record_id: n.recordId ?? null,
        link: n.link ?? null,
        status: n.status,
        sent_at: n.status === 'sent' ? NOW : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  outgoing(tx: Tx, id: string): Promise<OutgoingNotification | undefined> {
    return pg(tx)
      .selectFrom('notification')
      .select(['to_address', 'subject', 'body', 'html', 'record_id', 'status'])
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .$narrowType<{ to_address: string }>()
      .executeTakeFirst();
  }

  async mark(tx: Tx, id: string, status: string, error: string | null): Promise<void> {
    await pg(tx)
      .updateTable('notification')
      .set((eb) => ({ status, error, sent_at: status === 'sent' ? NOW : eb.ref('sent_at') }))
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .execute();
  }

  inbox(tx: Tx, userId: string, options: { unreadOnly: boolean; before?: string; limit: number }): Promise<InboxRow[]> {
    const before = options.before;
    return pg(tx)
      .selectFrom('notification')
      .select(['id', 'subject', 'body', 'record_id', 'link', 'read_at', 'created_at'])
      .where('tenant_id', '=', APP_TENANT)
      .where('channel', '=', 'inApp')
      .where('user_id', '=', userId)
      .$if(options.unreadOnly, (qb) => qb.where('read_at', 'is', null))
      .$if(!!before, (qb) =>
        qb.where(
          sql<boolean>`(created_at, id) < (select c.created_at, c.id from notification c where c.tenant_id = app_tenant() and c.id = ${before} and c.user_id = ${userId})`,
        ),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit)
      .execute();
  }

  async markAllRead(tx: Tx, userId: string): Promise<number> {
    const rows = await pg(tx)
      .updateTable('notification')
      .set({ read_at: NOW })
      .where('tenant_id', '=', APP_TENANT)
      .where('user_id', '=', userId)
      .where('channel', '=', 'inApp')
      .where('read_at', 'is', null)
      .returning('id')
      .execute();
    return rows.length;
  }

  async markRead(tx: Tx, userId: string, id: string): Promise<boolean> {
    const rows = await pg(tx)
      .updateTable('notification')
      .set((eb) => ({ read_at: eb.fn.coalesce('read_at', NOW) }))
      .where('tenant_id', '=', APP_TENANT)
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('channel', '=', 'inApp')
      .returning('id')
      .execute();
    return rows.length > 0;
  }
}
