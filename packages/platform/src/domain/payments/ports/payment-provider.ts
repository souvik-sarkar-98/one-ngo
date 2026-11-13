export interface ProviderCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Cashfree: 'sandbox' or 'production'. */
  environment?: 'sandbox' | 'production';
}

export interface CreateOrderInput {
  reference: string;
  amountPaise: number;
  customer?: { name?: string; email?: string; phone?: string };
}

export interface CreatedOrder {
  orderId: string;
  /** Data the browser checkout widget needs. Contains no secrets. */
  checkout: Record<string, unknown>;
}

export interface PaymentWebhookEvent {
  eventId: string;
  kind: 'paid' | 'failed' | 'ignored';
  orderId: string | null;
  paymentId: string | null;
  amountPaise: number | null;
}

/** A payment gateway; the Razorpay and Cashfree adapters live in infrastructure/payments. */
export interface PaymentProvider {
  readonly name: 'razorpay' | 'cashfree';
  createOrder(input: CreateOrderInput, creds: ProviderCredentials): Promise<CreatedOrder>;
  /** Verifies the signature on the raw body and normalises the event. Returns null if the signature is wrong. */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>, creds: ProviderCredentials): PaymentWebhookEvent | null;
}

/** Seals gateway secrets at rest and makes the short random part of a payment reference. */
export interface PaymentSecrets {
  seal(plaintext: string): string;
  open(sealed: string): string;
  randomToken(bytes: number): string;
}

/** Finds an active organisation by its key. */
export interface PaymentTenants {
  activeIdByKey(key: string): Promise<string | undefined | null>;
}
