import { createHash } from 'node:crypto';

/** The fixture's fixed addresses and demo credentials. one-ngo's fixture-hosts.ts names the same origin. */
export const HOST = '127.0.0.1';
export const HTTPS_PORT = 8095;
export const SMTP_PORT = 2525;
export const ORIGIN = `https://${HOST}:${HTTPS_PORT}`;

export const RAZORPAY = { keyId: 'rzp_test_demo', keySecret: 'demo-key-secret', webhookSecret: 'demo-webhook-secret' } as const;
export const CASHFREE = { clientId: 'cf_demo', clientSecret: 'demo-cf-secret', environment: 'sandbox' } as const;
export const GOOGLE = { clientId: 'demo-google', clientSecret: 'demo-google-secret' } as const;
/** The operator console's client. Its ID tokens report multi-factor sign-in, which the console requires. */
export const OPERATOR = { clientId: 'demo-operator', clientSecret: 'demo-operator-secret' } as const;

/** The `sub` the fixture puts in an ID token for an email; operator identities link to it. */
export function demoSubject(email: string): string {
  return `demo-${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 20)}`;
}
export const SMTP = { user: 'demo', password: 'demo', from: 'demo@localhost' } as const;

/** Connector targets. */
export const CONNECTOR = {
  smsApiKey: 'demo-sms-key',
  whatsappToken: 'demo-whatsapp-token',
  whatsappPhoneNumberId: '1234567890',
  webhookSigningSecret: 'demo-signing-secret',
  oauthClientId: 'demo-connector',
  oauthClientSecret: 'demo-connector-secret',
} as const;

/** The access token the metadata stand-in hands out and the storage stand-in accepts. */
export const STORAGE_TOKEN = 'demo-gcs-token';

/** The one password the breached-password stand-in reports as breached. */
export const BREACHED_PASSWORD = 'password';

/** Paths the fixture answers. */
export const PATHS = {
  discovery: '/.well-known/openid-configuration',
  authorize: '/oauth2/authorize',
  token: '/oauth2/token',
  jwks: '/oauth2/jwks',
  razorpayOrders: '/v1/orders',
  cashfreeOrders: '/pg/orders',
  metadataToken: '/token',
  pwnedRange: '/range/',
  sms: '/sms',
  whatsapp: '/whatsapp',
  hooksIn: '/hooks/in',
  lookup: '/lookup/',
  connectorAuthorize: '/connector-oauth/authorize',
  connectorToken: '/connector-oauth/token',
} as const;
