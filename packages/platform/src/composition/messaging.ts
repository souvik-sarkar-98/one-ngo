import { ConnectorService } from '../application/connectors/connector-service.js';
import { OAuthCredentials } from '../application/connectors/oauth-credentials.js';
import { NotificationService } from '../application/notifications/notification-service.js';
import { CONNECTOR_SETTINGS } from '../domain/connectors/connector-settings.js';
import { fetchConnectorHttp } from '../infrastructure/connectors/http.js';
import { connectorSecretBox } from '../infrastructure/crypto/connector-secrets.js';
import { openStorageStore } from '../infrastructure/files/storage-connector.js';
import type { EmailTransport } from '@onengo/kernel/ports';
import { MAX_ATTEMPTS } from '../infrastructure/outbox/outbox-dispatcher.js';
import { PgConnectorStore } from '../infrastructure/postgres/stores/connector-store.js';
import { pgConnectorOauthState } from '../infrastructure/postgres/stores/owner/connector-oauth-state.js';
import { PgNotificationStore } from '../infrastructure/postgres/stores/notification-store.js';
import type { Definitions } from './definitions.js';
import type { Base, Cryptography } from './infrastructure.js';

/** Connectors and notifications: email only through the organisation's email connector, plus SMS, WhatsApp and webhooks. There is no SMTP fallback. */
export function wireMessaging(base: Base, { definitions }: Definitions, { secretKeys, sensitive }: Cryptography) {
  const { db, tm, owner, logger, options } = base;
  const connectorStore = new PgConnectorStore(CONNECTOR_SETTINGS);
  const transportFor = async (tenantId: string): Promise<EmailTransport | undefined> => {
    const sender = await connectors.emailTransport(tenantId);
    if (sender) return sender;
    // Tests inject a capture transport. The OneNGO servers do not, so a missing email connector sends nothing.
    return options.defaultEmailTransport;
  };
  const secretBox = connectorSecretBox(secretKeys);
  const connectorHttp = options.connectorHttp ?? fetchConnectorHttp();
  const oauthCredentials = new OAuthCredentials(pgConnectorOauthState(db), tm, connectorStore, secretBox, connectorHttp, base.audit, options.publicBaseUrl ?? '');
  const connectors = new ConnectorService(
    tm,
    connectorStore,
    owner.outbox,
    secretBox,
    connectorHttp,
    { maxAttempts: MAX_ATTEMPTS },
    base.audit,
    oauthCredentials,
    openStorageStore,
    logger,
  );
  const notificationStore = new PgNotificationStore();
  const notifications = new NotificationService(tm, notificationStore, definitions, sensitive, transportFor, base.audit, (tenantId, channel, message, delivery) =>
    connectors.sendMessage(tenantId, channel, message, delivery),
  );
  return { connectors, oauthCredentials, notifications };
}
export type Messaging = ReturnType<typeof wireMessaging>;
