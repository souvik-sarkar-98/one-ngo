import type { MoneyAccountService } from '../../domain/accounts/money-account-service.js';
import type { PaymentService } from '../../domain/payments/payment-service.js';
import type { ConfirmPaymentManually, HandlePaymentWebhook, RequestPayment } from './confirm-payment.js';

/** Money accounts, transfers, payments and payment gateway set-up. */
export interface PaymentsApi {
  moneyAccounts: Pick<MoneyAccountService, 'list' | 'open' | 'transfer'>;
  payments: Pick<PaymentService, 'get' | 'matchStatement' | 'gateways' | 'saveGatewayCredentials'>;
  requestPayment: RequestPayment;
  confirmPayment: ConfirmPaymentManually;
}

/** Provider webhooks: public, checked by the provider's signature over the raw body the webhook route keeps. */
export interface WebhooksApi {
  paymentWebhook: HandlePaymentWebhook;
}
