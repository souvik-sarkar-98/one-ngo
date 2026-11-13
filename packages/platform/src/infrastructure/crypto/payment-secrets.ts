import type { PaymentSecrets } from '../../domain/payments/ports/payment-provider.js';
import { decryptSecret, encryptSecret, randomToken, type SecretKey } from '@onengo/kernel/crypto';

/** Gateway secrets sealed with the installation's secret key. */
export function paymentSecrets(key: SecretKey): PaymentSecrets {
  return {
    seal: (plaintext) => encryptSecret(plaintext, key),
    open: (sealed) => decryptSecret(sealed, key),
    randomToken: (bytes) => randomToken(bytes),
  };
}
