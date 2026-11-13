import { PublishedPaymentTerms } from '../application/payments/payment-terms.js';
import { MoneyAccountService } from '../domain/accounts/money-account-service.js';
import { PaymentService } from '../domain/payments/payment-service.js';
import { paymentSecrets } from '../infrastructure/crypto/payment-secrets.js';
import { CashfreeProvider, RazorpayProvider } from '../infrastructure/payments/providers.js';
import { pgMoneyAccountStore } from '../infrastructure/postgres/stores/money-account-store.js';
import { pgPaymentStore } from '../infrastructure/postgres/stores/payment-store.js';
import type { Definitions } from './definitions.js';
import type { Base, Cryptography } from './infrastructure.js';
import type { Finance, Records } from './records.js';

/** Money accounts and online payments through the configured gateways. */
export function wirePayments(base: Base, { definitions }: Definitions, { secretKeys }: Cryptography, { records }: Records, { ledger }: Finance) {
  const { tm, owner, options } = base;
  return {
    moneyAccounts: new MoneyAccountService(tm, pgMoneyAccountStore, ledger),
    payments: new PaymentService(tm, pgPaymentStore, owner.tenants, records, new PublishedPaymentTerms(definitions), paymentSecrets(secretKeys), options.paymentProviders ?? [new RazorpayProvider(), new CashfreeProvider()]),
  };
}
export type Payments = ReturnType<typeof wirePayments>;
