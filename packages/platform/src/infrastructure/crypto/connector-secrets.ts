import type { ConnectorSecretBox } from '../../application/connectors/ports/connector-runtime.js';
import { decryptSecret, encryptSecret, hmacSha256, type SecretKey } from '@onengo/kernel/crypto';

/** Connector credentials encrypted under the installation's key, and the HMAC that signs webhooks. */
export function connectorSecretBox(key: SecretKey): ConnectorSecretBox {
  return {
    encrypt: (plaintext) => encryptSecret(plaintext, key),
    decrypt: (stored) => decryptSecret(stored, key),
    sign: (secret, data) => hmacSha256(secret, data),
  };
}
