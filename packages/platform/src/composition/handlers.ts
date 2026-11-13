import { AfterPublish } from '../application/definitions/after-publish.js';
import { OutboxNotifications } from '../application/notifications/outbox-notifications.js';
import type { OutboxEvent } from '../application/notifications/ports/outbox-event.js';
import type { Tx } from '../domain/ports/transaction.js';
import { namedRecipientsSetting } from '../infrastructure/postgres/stores/delivery-settings.js';
import type { HandlerRun } from '../infrastructure/outbox/outbox-dispatcher.js';
import { executorOf } from '../infrastructure/postgres/tx.js';
import { NAMED_RECIPIENTS_SETTING, type NamedRecipient } from '../runtime/definitions/settings.js';
import { rebuildsAfterPublish } from '../runtime/records/rebuild-jobs.js';
import type { Definitions } from './definitions.js';
import type { Base } from './infrastructure.js';
import type { Jobs } from './jobs.js';
import type { Messaging } from './messaging.js';
import type { Operations } from './operations.js';
import type { Records } from './records.js';

/** The dispatcher's completion record, as the application's handlers see it: a transaction handle in, not a database executor. */
const done = (run: HandlerRun) => ({ complete: (tx: Tx) => run.complete(executorOf(tx)) });

/** What each queued event does when the dispatcher delivers it. */
export function registerOutboxHandlers(base: Base, { definitions }: Definitions, { records, follow }: Records, { connectors, notifications }: Messaging, { dispatcher, jobs }: Jobs, ops: Operations): void {
  const { tm } = base;
  const { automations, confirmPayment } = ops;
  // Handlers that only write to the database record themselves in their own
  // transaction (run.complete), so a replayed event never repeats their writes.
  const afterPublish = new AfterPublish(
    tm,
    (tenantId, key, version) => rebuildsAfterPublish(definitions, records, tenantId, key, version),
    { insert: (tx, ctx, kind, input, options) => jobs.insert(executorOf(tx), ctx, kind, input, options), started: () => jobs.started() },
  );
  const outbox = new OutboxNotifications(
    tm,
    notifications,
    definitions,
    async (tx) => ((await namedRecipientsSetting(executorOf(tx), NAMED_RECIPIENTS_SETTING)) ?? {}) as Record<string, NamedRecipient>,
  );
  dispatcher.on('definition.published', 'jobs', (e: OutboxEvent, run) => afterPublish.run(e, done(run)));
  for (const type of ['record.created', 'record.updated', 'record.transitioned']) {
    dispatcher.on(type, 'automations', (e) => automations.onRecordEvent(e));
    dispatcher.on(type, 'follow', (e) => follow.onRecord(e));
  }
  dispatcher.on('user.updated', 'follow', (e) => follow.onUser(e));
  dispatcher.on('notification.email', 'deliver', (e) => notifications.deliverEmail(e.tenantId, String(e.payload.notificationId)));
  dispatcher.on('notification.sms', 'deliver', (e) => notifications.deliverPhone(e));
  dispatcher.on('notification.whatsapp', 'deliver', (e) => notifications.deliverPhone(e));
  dispatcher.on('connector.webhook', 'deliver', (e) => connectors.deliverWebhook(e));
  dispatcher.on('connector.http', 'deliver', (e) => connectors.deliverHttp(e));
  dispatcher.on('payment.confirmed', 'paidStep', (e, run) => confirmPayment.onPaymentConfirmed(e, done(run)));
  dispatcher.on('action.notify', 'notify', (e, run) => outbox.actionNotify(e, done(run)));
  dispatcher.on('script.notify', 'notify', (e, run) => outbox.scriptNotify(e, done(run)));
  dispatcher.on('script.published.finance', 'notifyAdministrators', (e, run) => outbox.financeScriptPublished(e, done(run)));
  dispatcher.on('approval.requested', 'notifyApprovers', (e, run) => outbox.approvalRequested(e, done(run)));
  dispatcher.on('approval.decided', 'notifyRequester', (e, run) => outbox.approvalDecided(e, done(run)));
}
