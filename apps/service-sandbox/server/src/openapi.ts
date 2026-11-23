import { CASHFREE, CONNECTOR, GOOGLE, MAIL, OPERATOR, RAZORPAY, STORAGE_TOKEN } from './constants.js';

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const jsonBody = (schema: unknown, example?: unknown): Json => ({
  required: true,
  content: { 'application/json': { schema, ...(example === undefined ? {} : { example }) } },
});

const formBody = (schema: unknown): Json => ({
  required: true,
  content: { 'application/x-www-form-urlencoded': { schema } },
});

const json = (description: string, schema: unknown): Json => ({
  description,
  content: { 'application/json': { schema } },
});

const text = (description: string, contentType = 'text/plain'): Json => ({
  description,
  content: { [contentType]: { schema: { type: 'string' } } },
});

/** OpenAPI document for this fixture. `origin` is the sandbox the caller is using, so Try it out hits that port. */
export function openApiDocument(origin: string): Json {
  return {
    openapi: '3.0.3',
    info: {
      title: 'one-ngo service sandbox',
      version: '0.1.0',
      description: [
        'Local stand-ins for the outside services one-ngo calls. Test use only. Nothing here talks to Razorpay, Cashfree, Google, Cloud Storage, or Have I Been Pwned.',
        '',
        'Accept the certificate warning once in the browser before using Try it out. Demo credentials:',
        '',
        `- Razorpay basic auth: \`${RAZORPAY.keyId}\` / \`${RAZORPAY.keySecret}\`. Webhook secret \`${RAZORPAY.webhookSecret}\`.`,
        `- Cashfree: \`${CASHFREE.clientId}\` / \`${CASHFREE.clientSecret}\`, plus any \`x-api-version\`.`,
        `- Google sign-in: \`${GOOGLE.clientId}\` / \`${GOOGLE.clientSecret}\`.`,
        `- Operator sign-in: \`${OPERATOR.clientId}\` / \`${OPERATOR.clientSecret}\`. ID tokens include \`amr\` of \`pwd\` and \`mfa\`.`,
        `- Gmail send: bearer \`${MAIL.token}\`. From address \`${MAIL.from}\`.`,
        `- SMS: bearer \`${CONNECTOR.smsApiKey}\`.`,
        `- WhatsApp: bearer \`${CONNECTOR.whatsappToken}\`, phone number id \`${CONNECTOR.whatsappPhoneNumberId}\`.`,
        `- Webhook signing secret: \`${CONNECTOR.webhookSigningSecret}\`. Header \`x-ngo-signature\` is \`sha256=\` plus the hex HMAC-SHA256 of the raw body.`,
        `- Connector OAuth: \`${CONNECTOR.oauthClientId}\` / \`${CONNECTOR.oauthClientSecret}\`.`,
        `- Cloud Storage bearer: \`${STORAGE_TOKEN}\` (also what \`GET /token\` returns).`,
        '- Breached passwords: only the word `password` is reported as breached.',
      ].join('\n'),
    },
    servers: [{ url: origin, description: 'This sandbox' }],
    tags: [
      { name: 'Fixture', description: 'Index, log, and this document.' },
      { name: 'Sign-in', description: 'OpenID Connect stand-in for Google and for the operator console.' },
      { name: 'Payments', description: 'Razorpay and Cashfree order creation, and Capture or Fail webhooks.' },
      { name: 'Mail', description: 'Gmail-style send, plus the JSON inbox of what was accepted.' },
      { name: 'Files', description: 'Cloud Storage JSON API and the metadata token endpoint.' },
      { name: 'Connectors', description: 'SMS, WhatsApp, webhook, PIN code lookup, and connector OAuth.' },
      { name: 'Security', description: 'Have I Been Pwned range API.' },
    ],
    paths: {
      '/': {
        get: {
          tags: ['Fixture'],
          operationId: 'index',
          summary: 'Sandbox index',
          description: 'Links to Swagger UI and this OpenAPI document.',
          responses: { '200': json('Links to the API documents.', ref('Index')) },
        },
      },
      '/api/log': {
        get: {
          tags: ['Fixture'],
          operationId: 'log',
          summary: 'Log, orders, and messages',
          description: 'Log, stored orders, and message headers. Message bodies are left out; `GET /inbox/{id}` returns one message and `GET /mail/{id}` returns the raw source.',
          responses: { '200': json('Current log, orders, and message headers.', ref('LogResponse')) },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Fixture'],
          operationId: 'openApi',
          summary: 'This document',
          responses: { '200': json('OpenAPI document.', { type: 'object', additionalProperties: true }) },
        },
      },
      '/swagger': {
        get: {
          tags: ['Fixture'],
          operationId: 'swaggerUi',
          summary: 'Swagger UI',
          description: 'Interactive page for this document. The UI script is loaded from unpkg.',
          responses: { '200': text('Swagger UI page.', 'text/html') },
        },
      },
      '/.well-known/openid-configuration': {
        get: {
          tags: ['Sign-in'],
          operationId: 'oidcDiscovery',
          summary: 'OpenID Connect discovery',
          responses: { '200': json('Discovery document for this origin.', ref('Discovery')) },
        },
      },
      '/oauth2/jwks': {
        get: {
          tags: ['Sign-in'],
          operationId: 'oidcJwks',
          summary: 'Signing keys',
          description: 'The public key for ID tokens issued by this process. A new key is generated at startup.',
          responses: { '200': json('JSON Web Key set.', ref('Jwks')) },
        },
      },
      '/oauth2/authorize': {
        get: {
          tags: ['Sign-in'],
          operationId: 'oidcAuthorizePage',
          summary: 'Sign-in page',
          description: `Asks for an email. \`client_id\` is \`${GOOGLE.clientId}\` or \`${OPERATOR.clientId}\`. PKCE S256 is required. The sandbox does not create a member or an operator.`,
          parameters: [
            { name: 'client_id', in: 'query', required: true, schema: { type: 'string', enum: [GOOGLE.clientId, OPERATOR.clientId] } },
            { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code'] } },
            { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string', format: 'uri' } },
            { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'code_challenge', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'code_challenge_method', in: 'query', required: true, schema: { type: 'string', enum: ['S256'] } },
            { name: 'scope', in: 'query', required: false, schema: { type: 'string' }, example: 'openid email profile' },
            { name: 'nonce', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': text('Sign-in form.', 'text/html'),
            '400': text('The query is missing a required value or names an unknown client.', 'text/html'),
          },
        },
        post: {
          tags: ['Sign-in'],
          operationId: 'oidcAuthorizeSubmit',
          summary: 'Finish sign-in',
          description: 'Allow issues a code that lasts 5 minutes and redirects to `redirect_uri` with `code` and `state`. Cancel redirects with `error=access_denied`.',
          requestBody: formBody({
            type: 'object',
            required: ['client_id', 'response_type', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'decision'],
            properties: {
              client_id: { type: 'string', enum: [GOOGLE.clientId, OPERATOR.clientId] },
              response_type: { type: 'string', enum: ['code'] },
              redirect_uri: { type: 'string', format: 'uri' },
              state: { type: 'string' },
              code_challenge: { type: 'string' },
              code_challenge_method: { type: 'string', enum: ['S256'] },
              scope: { type: 'string' },
              nonce: { type: 'string' },
              email: { type: 'string', format: 'email' },
              decision: { type: 'string', enum: ['allow', 'deny'] },
            },
          }),
          responses: {
            '302': { description: 'Redirect back to `redirect_uri`.', headers: { location: { schema: { type: 'string' } } } },
            '400': text('The form is invalid, or Allow was sent without an email.', 'text/html'),
          },
        },
      },
      '/oauth2/token': {
        post: {
          tags: ['Sign-in'],
          operationId: 'oidcToken',
          summary: 'Exchange the code',
          description:
            'Grant type `authorization_code`. Send the client id and secret as HTTP Basic, or as `client_id` and `client_secret` in the form. The code is single use. `code_verifier` must match the S256 challenge. The ID token lasts 1 hour, says `email_verified: true`, and its subject is `demo-` plus the first 20 hex characters of the SHA-256 of the lower-cased email. Operator tokens also include `amr`.',
          security: [{}, { oidcClientBasic: [] }],
          requestBody: formBody({
            type: 'object',
            required: ['grant_type', 'code', 'redirect_uri', 'code_verifier'],
            properties: {
              grant_type: { type: 'string', enum: ['authorization_code'] },
              code: { type: 'string' },
              redirect_uri: { type: 'string' },
              code_verifier: { type: 'string' },
              client_id: { type: 'string', enum: [GOOGLE.clientId, OPERATOR.clientId] },
              client_secret: { type: 'string' },
            },
          }),
          responses: {
            '200': json('Access token and ID token.', ref('OidcToken')),
            '400': json('The grant, code, or PKCE verifier was refused.', ref('OAuthError')),
            '401': json('Unknown client or wrong secret.', ref('OAuthError')),
          },
        },
      },
      '/v1/orders': {
        post: {
          tags: ['Payments'],
          operationId: 'razorpayCreateOrder',
          summary: 'Create a Razorpay order',
          description: `Stands in for \`POST https://api.razorpay.com/v1/orders\`. Amount is in paise and must be at least 100. Currency must be INR. The order is kept in memory until this process stops. Capture or fail it with \`POST /orders/razorpay/{orderId}/capture\` or \`/fail\`.`,
          security: [{ razorpayBasic: [] }],
          requestBody: jsonBody(ref('RazorpayOrderRequest'), { amount: 50000, currency: 'INR', receipt: 'demo-receipt' }),
          responses: {
            '200': json('Order created.', ref('RazorpayOrder')),
            '400': json('Amount or currency was refused.', ref('RazorpayError')),
            '401': json('Key id or secret was wrong.', ref('RazorpayError')),
          },
        },
      },
      '/pg/orders': {
        post: {
          tags: ['Payments'],
          operationId: 'cashfreeCreateOrder',
          summary: 'Create a Cashfree order',
          description:
            'Stands in for Cashfree `POST /pg/orders`. `order_amount` is in rupees and must be at least 1. Currency must be INR. `order_id` is chosen by the caller and cannot be reused. The order is kept in memory until this process stops.',
          parameters: [
            { name: 'x-client-id', in: 'header', required: true, schema: { type: 'string' }, example: CASHFREE.clientId },
            { name: 'x-client-secret', in: 'header', required: true, schema: { type: 'string' }, example: CASHFREE.clientSecret },
            { name: 'x-api-version', in: 'header', required: true, schema: { type: 'string' }, example: '2023-08-01' },
          ],
          requestBody: jsonBody(ref('CashfreeOrderRequest'), { order_id: 'order_demo_1', order_amount: 500, order_currency: 'INR' }),
          responses: {
            '200': json('Order created.', ref('CashfreeOrder')),
            '400': json('A required header or field was missing or invalid.', ref('CashfreeError')),
            '401': json('Client id or secret was wrong.', ref('CashfreeError')),
            '409': json('An order with this id already exists.', ref('CashfreeError')),
          },
        },
      },
      '/orders/{provider}/{orderId}/{action}': {
        post: {
          tags: ['Payments'],
          operationId: 'settleOrder',
          summary: 'Capture or fail an order',
          description:
            'Posts a signed webhook to `{one-ngo}/webhooks/payments/{provider}/{org}`. Capture sends Razorpay `payment.captured` or Cashfree `PAYMENT_SUCCESS_WEBHOOK`. Fail sends `payment.failed` or `PAYMENT_FAILED_WEBHOOK`. The stored status changes only when one-ngo answers with a success status. The response includes that status and the webhook answer, or a connection error.',
          parameters: [
            { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['razorpay', 'cashfree'] } },
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['capture', 'fail'] } },
          ],
          requestBody: jsonBody(
            { type: 'object', required: ['org'], properties: { org: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } } },
            { org: 'demo' },
          ),
          responses: {
            '200': json('Webhook attempted. `status` changes only when one-ngo answers with a success status.', ref('SettleResult')),
            '400': json('Organisation code was missing or not a short token.', ref('ErrorMessage')),
            '404': json('No stored order for that provider and id.', ref('ErrorMessage')),
          },
        },
      },
      '/gmail/v1/users/{userId}/messages/send': {
        post: {
          tags: ['Mail'],
          operationId: 'gmailSend',
          summary: 'Send mail',
          description: `Stands in for Gmail \`users.messages.send\`. Any \`userId\` is accepted; the connector uses \`me\`. \`raw\` is a base64 or base64url RFC 822 message. Accepted messages are kept in memory, up to 200, and listed at \`GET /inbox\`. Restarting clears them.`,
          security: [{ gmailBearer: [] }],
          parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' }, example: 'me' }],
          requestBody: jsonBody(ref('GmailSendRequest')),
          responses: {
            '200': json('Message accepted.', ref('GmailSendResponse')),
            '400': json("`raw` was missing or not a message.", ref('GmailError')),
            '401': json('Bearer token was missing or wrong.', ref('GmailError')),
          },
        },
      },
      '/inbox': {
        get: {
          tags: ['Mail'],
          operationId: 'inbox',
          summary: 'Inbox',
          description: 'Newest message first. Bodies are left out; `GET /inbox/{id}` returns one message.',
          responses: { '200': json('Message headers.', ref('Inbox')) },
        },
      },
      '/inbox/{id}': {
        get: {
          tags: ['Mail'],
          operationId: 'inboxMessage',
          summary: 'One message',
          description: 'The accepted message, including plain text and HTML. The raw source is `GET /mail/{id}`.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: {
            '200': json('That message.', ref('MailMessage')),
            '404': json('That message is not in the inbox.', ref('ErrorMessage')),
          },
        },
      },
      '/mail/{id}': {
        get: {
          tags: ['Mail'],
          operationId: 'mailSource',
          summary: 'Raw message source',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: {
            '200': text('The RFC 822 message that was accepted.'),
            '404': json('No such message.', ref('ErrorMessage')),
          },
        },
      },
      '/token': {
        get: {
          tags: ['Files'],
          operationId: 'metadataToken',
          summary: 'Metadata access token',
          description: 'Stands in for the Compute Engine metadata token endpoint. Requires `Metadata-Flavor: Google`.',
          parameters: [{ name: 'Metadata-Flavor', in: 'header', required: true, schema: { type: 'string', enum: ['Google'] } }],
          responses: {
            '200': json('Bearer token the storage routes accept.', ref('MetadataToken')),
            '403': json('The metadata header was missing.', ref('ErrorMessage')),
          },
        },
      },
      '/upload/storage/v1/b/{bucket}/o': {
        post: {
          tags: ['Files'],
          operationId: 'storageUpload',
          summary: 'Upload an object',
          description:
            'Stands in for a Cloud Storage media upload. `uploadType` must be `media`. `name` is the object name. A name may contain `/`. Each segment must match `[A-Za-z0-9_.-]+` and must not be `.`, `..`, or end in `.part`. The bytes are written under the sandbox files directory and survive a restart.',
          security: [{ storageBearer: [] }],
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' } },
            { name: 'uploadType', in: 'query', required: true, schema: { type: 'string', enum: ['media'] } },
            { name: 'name', in: 'query', required: true, schema: { type: 'string' }, example: 'demo.txt' },
          ],
          requestBody: {
            required: true,
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          responses: {
            '200': json('Object stored.', ref('StorageObject')),
            '400': json('The upload was not a media upload, or the name was refused.', ref('GoogleError')),
            '401': json('Bearer token was missing or wrong.', ref('GoogleError')),
          },
        },
      },
      '/storage/v1/b/{bucket}/o/{object}': {
        get: {
          tags: ['Files'],
          operationId: 'storageGet',
          summary: 'Read an object',
          description: 'Without `alt=media`, returns object metadata. With `alt=media`, returns the bytes. `{object}` is one path segment, so this route does not read names that contain `/`.',
          security: [{ storageBearer: [] }],
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'object', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'alt', in: 'query', required: false, schema: { type: 'string', enum: ['media'] } },
          ],
          responses: {
            '200': {
              description: 'Metadata, or the object bytes when `alt=media`.',
              content: {
                'application/json': { schema: ref('StorageObject') },
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '400': json('The object name was refused.', ref('GoogleError')),
            '401': json('Bearer token was missing or wrong.', ref('GoogleError')),
            '404': json('No such object.', ref('GoogleError')),
          },
        },
        delete: {
          tags: ['Files'],
          operationId: 'storageDelete',
          summary: 'Delete an object',
          security: [{ storageBearer: [] }],
          parameters: [
            { name: 'bucket', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'object', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '204': { description: 'Object deleted.' },
            '400': json('The object name was refused.', ref('GoogleError')),
            '401': json('Bearer token was missing or wrong.', ref('GoogleError')),
            '404': json('No such object.', ref('GoogleError')),
          },
        },
      },
      '/range/{prefix}': {
        get: {
          tags: ['Security'],
          operationId: 'pwnedRange',
          summary: 'Breached-password range',
          description:
            'Stands in for `GET https://api.pwnedpasswords.com/range/{prefix}`. The body is `SUFFIX:COUNT` lines. Only the SHA-1 of `password` is reported with a real count. `Add-Padding: true` adds extra lines with count 0.',
          parameters: [
            { name: 'prefix', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9A-Fa-f]{5}$' }, example: '5BAA6' },
            { name: 'Add-Padding', in: 'header', required: false, schema: { type: 'string', enum: ['true'] } },
          ],
          responses: {
            '200': text('Hash suffixes and counts, separated by CRLF.'),
            '400': text('The prefix was not five hex characters.'),
          },
        },
      },
      '/sms': {
        post: {
          tags: ['Connectors'],
          operationId: 'sendSms',
          summary: 'Accept an SMS',
          description: 'Records the body and returns a queued id. The body is not validated; the connector sends JSON with `to` and `message`.',
          security: [{ smsBearer: [] }],
          requestBody: jsonBody(ref('SmsRequest'), { to: '+919800000000', message: 'Hello from the sandbox' }),
          responses: {
            '200': json('Accepted.', ref('SmsResponse')),
            '401': json('API key was missing or wrong.', ref('ErrorMessage')),
          },
        },
      },
      '/whatsapp/{phoneNumberId}/messages': {
        post: {
          tags: ['Connectors'],
          operationId: 'sendWhatsApp',
          summary: 'Accept a WhatsApp message',
          description: `Stands in for a Cloud API send. The phone number id is 5 to 30 digits. The connector uses \`${CONNECTOR.whatsappPhoneNumberId}\`. The body must be JSON.`,
          security: [{ whatsappBearer: [] }],
          parameters: [{ name: 'phoneNumberId', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9]{5,30}$' }, example: CONNECTOR.whatsappPhoneNumberId }],
          requestBody: jsonBody(
            {
              type: 'object',
              additionalProperties: true,
              properties: {
                messaging_product: { type: 'string' },
                to: { type: 'string' },
                type: { type: 'string' },
                text: { type: 'object', additionalProperties: true },
              },
            },
            { messaging_product: 'whatsapp', to: '919800000000', type: 'text', text: { body: 'Hello from the sandbox' } },
          ),
          responses: {
            '200': json('Accepted.', ref('WhatsAppResponse')),
            '400': json('The body was not JSON.', ref('WhatsAppError')),
            '401': json('Access token was missing or wrong.', ref('WhatsAppError')),
          },
        },
      },
      '/hooks/in': {
        post: {
          tags: ['Connectors'],
          operationId: 'receiveWebhook',
          summary: 'Receive a signed webhook',
          description: `Checks \`x-ngo-signature\` against HMAC-SHA256 of the raw body using \`${CONNECTOR.webhookSigningSecret}\`. The value must be \`sha256=\` plus the hex digest. \`x-ngo-event\` is recorded and not checked.`,
          parameters: [
            { name: 'x-ngo-signature', in: 'header', required: true, schema: { type: 'string' }, example: 'sha256=' },
            { name: 'x-ngo-event', in: 'header', required: false, schema: { type: 'string' }, example: 'demo.event' },
          ],
          requestBody: jsonBody({ type: 'object', additionalProperties: true }, { hello: 'sandbox' }),
          responses: {
            '200': json('Signature matches.', ref('WebhookAck')),
            '401': json('Signature does not match.', ref('WebhookAck')),
          },
        },
      },
      '/lookup/{pincode}': {
        get: {
          tags: ['Connectors'],
          operationId: 'lookupPincode',
          summary: 'PIN code lookup',
          description: 'Known codes: 110001 Connaught Place, 400001 Fort, 560001 Bengaluru GPO, 700001 BBD Bagh. Any other code is not found.',
          parameters: [{ name: 'pincode', in: 'path', required: true, schema: { type: 'string' }, example: '560001' }],
          responses: {
            '200': json('Area, district, and state.', ref('PincodeHit')),
            '404': json('That PIN code is not in the sandbox list.', ref('ErrorMessage')),
          },
        },
      },
      '/connector-oauth/authorize': {
        get: {
          tags: ['Connectors'],
          operationId: 'connectorAuthorizePage',
          summary: 'Connector consent page',
          parameters: [
            { name: 'client_id', in: 'query', required: true, schema: { type: 'string', enum: [CONNECTOR.oauthClientId] } },
            { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code'] } },
            { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string', format: 'uri' } },
            { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'scope', in: 'query', required: false, schema: { type: 'string' }, example: 'demo.read' },
            { name: 'code_challenge', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': text('Consent form.', 'text/html'),
            '400': text('Unknown client, or redirect_uri or state is missing.', 'text/html'),
          },
        },
        post: {
          tags: ['Connectors'],
          operationId: 'connectorAuthorizeSubmit',
          summary: 'Finish connector consent',
          description: 'Allow issues a code that lasts 5 minutes. Deny redirects with `error=access_denied`. PKCE is checked later only when a challenge was sent.',
          requestBody: formBody({
            type: 'object',
            required: ['redirect_uri', 'state', 'decision'],
            properties: {
              client_id: { type: 'string' },
              response_type: { type: 'string' },
              redirect_uri: { type: 'string', format: 'uri' },
              state: { type: 'string' },
              scope: { type: 'string' },
              code_challenge: { type: 'string' },
              decision: { type: 'string', enum: ['allow', 'deny'] },
            },
          }),
          responses: {
            '302': { description: 'Redirect back to `redirect_uri`.', headers: { location: { schema: { type: 'string' } } } },
            '400': text('`redirect_uri` is not an address.', 'text/html'),
          },
        },
      },
      '/connector-oauth/token': {
        post: {
          tags: ['Connectors'],
          operationId: 'connectorToken',
          summary: 'Connector access token',
          description:
            '`authorization_code` exchanges a code and returns a refresh token. `refresh_token` returns a new access token. Send the client id and secret as HTTP Basic, or in the form.',
          security: [{}, { connectorOauthBasic: [] }],
          requestBody: formBody({
            type: 'object',
            required: ['grant_type'],
            properties: {
              grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token'] },
              code: { type: 'string' },
              redirect_uri: { type: 'string' },
              code_verifier: { type: 'string' },
              refresh_token: { type: 'string' },
              client_id: { type: 'string' },
              client_secret: { type: 'string' },
            },
          }),
          responses: {
            '200': json('Access token. `refresh_token` is present only for an authorization-code grant.', ref('ConnectorToken')),
            '400': json('The grant, code, or refresh token was refused.', ref('OAuthError')),
            '401': json('Unknown client or wrong secret.', ref('OAuthError')),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        razorpayBasic: { type: 'http', scheme: 'basic', description: `Key id ${RAZORPAY.keyId}, key secret ${RAZORPAY.keySecret}.` },
        oidcClientBasic: {
          type: 'http',
          scheme: 'basic',
          description: `Google: ${GOOGLE.clientId} / ${GOOGLE.clientSecret}. Operator: ${OPERATOR.clientId} / ${OPERATOR.clientSecret}. The form body may carry the same pair instead.`,
        },
        gmailBearer: { type: 'http', scheme: 'bearer', description: `Access token ${MAIL.token}.` },
        storageBearer: { type: 'http', scheme: 'bearer', description: `Access token ${STORAGE_TOKEN}, the same value GET /token returns.` },
        smsBearer: { type: 'http', scheme: 'bearer', description: `API key ${CONNECTOR.smsApiKey}.` },
        whatsappBearer: { type: 'http', scheme: 'bearer', description: `Access token ${CONNECTOR.whatsappToken}.` },
        connectorOauthBasic: {
          type: 'http',
          scheme: 'basic',
          description: `Client id ${CONNECTOR.oauthClientId}, secret ${CONNECTOR.oauthClientSecret}. The form body may carry the same pair instead.`,
        },
      },
      schemas: {
        ErrorMessage: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
        RazorpayError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'description'],
              properties: { code: { type: 'string', example: 'BAD_REQUEST_ERROR' }, description: { type: 'string' } },
            },
          },
        },
        CashfreeError: {
          type: 'object',
          required: ['message', 'code', 'type'],
          properties: {
            message: { type: 'string' },
            code: { type: 'string' },
            type: { type: 'string' },
          },
        },
        GmailError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'status'],
              properties: {
                code: { type: 'integer', enum: [400, 401] },
                message: { type: 'string' },
                status: { type: 'string', enum: ['INVALID_ARGUMENT', 'UNAUTHENTICATED'] },
              },
            },
          },
        },
        GoogleError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: { code: { type: 'integer' }, message: { type: 'string' } },
            },
          },
        },
        OAuthError: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' }, error_description: { type: 'string' } },
        },
        WhatsAppError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['message', 'code'],
              properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'integer' } },
            },
          },
        },
        Index: {
          type: 'object',
          required: ['swagger', 'openapi'],
          properties: {
            swagger: { type: 'string', format: 'uri' },
            openapi: { type: 'string', format: 'uri' },
          },
        },
        SettleResult: {
          type: 'object',
          required: ['orderId', 'provider', 'status', 'webhook'],
          properties: {
            orderId: { type: 'string' },
            provider: { type: 'string', enum: ['razorpay', 'cashfree'] },
            status: { type: 'string', enum: ['created', 'captured', 'failed'] },
            webhook: {
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string' },
                status: { type: 'integer', description: 'HTTP status from one-ngo, when the webhook was posted.' },
                body: { type: 'string', description: 'Start of the one-ngo response, when the webhook was posted.' },
                error: { type: 'string', description: 'Present when the webhook could not be posted.' },
              },
            },
          },
        },
        LogEntry: {
          type: 'object',
          required: ['id', 'at', 'area', 'summary'],
          properties: {
            id: { type: 'integer' },
            at: { type: 'string', format: 'date-time' },
            area: { type: 'string', enum: ['oidc', 'payments', 'storage', 'mail', 'connectors', 'pwned', 'fixture'] },
            summary: { type: 'string' },
            detail: { description: 'Present when the event has structured detail.' },
          },
        },
        StoredOrder: {
          type: 'object',
          required: ['provider', 'orderId', 'amountPaise', 'reference', 'createdAt', 'status'],
          properties: {
            provider: { type: 'string', enum: ['razorpay', 'cashfree'] },
            orderId: { type: 'string' },
            amountPaise: { type: 'integer' },
            reference: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['created', 'captured', 'failed'] },
          },
        },
        Inbox: {
          type: 'object',
          required: ['messages'],
          properties: { messages: { type: 'array', items: ref('MailSummary') } },
        },
        MailMessage: {
          type: 'object',
          required: ['id', 'threadId', 'at', 'from', 'fromName', 'to', 'cc', 'subject', 'text', 'html'],
          properties: {
            id: { type: 'integer' },
            threadId: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
            from: { type: 'string' },
            fromName: { type: 'string' },
            to: { type: 'array', items: { type: 'string' } },
            cc: { type: 'array', items: { type: 'string' } },
            subject: { type: 'string' },
            text: { type: 'string' },
            html: { type: 'string' },
          },
        },
        MailSummary: {
          type: 'object',
          required: ['id', 'threadId', 'at', 'from', 'fromName', 'to', 'cc', 'subject'],
          properties: {
            id: { type: 'integer' },
            threadId: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
            from: { type: 'string' },
            fromName: { type: 'string' },
            to: { type: 'array', items: { type: 'string' } },
            cc: { type: 'array', items: { type: 'string' } },
            subject: { type: 'string' },
          },
        },
        LogResponse: {
          type: 'object',
          required: ['entries', 'orders', 'messages'],
          properties: {
            entries: { type: 'array', items: ref('LogEntry') },
            orders: { type: 'array', items: ref('StoredOrder') },
            messages: { type: 'array', items: ref('MailSummary') },
          },
        },
        Discovery: {
          type: 'object',
          required: ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'],
          properties: {
            issuer: { type: 'string' },
            authorization_endpoint: { type: 'string' },
            token_endpoint: { type: 'string' },
            jwks_uri: { type: 'string' },
            response_types_supported: { type: 'array', items: { type: 'string' } },
            subject_types_supported: { type: 'array', items: { type: 'string' } },
            id_token_signing_alg_values_supported: { type: 'array', items: { type: 'string' } },
            scopes_supported: { type: 'array', items: { type: 'string' } },
            token_endpoint_auth_methods_supported: { type: 'array', items: { type: 'string' } },
            code_challenge_methods_supported: { type: 'array', items: { type: 'string' } },
            claims_supported: { type: 'array', items: { type: 'string' } },
          },
        },
        Jwks: {
          type: 'object',
          required: ['keys'],
          properties: { keys: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        },
        OidcToken: {
          type: 'object',
          required: ['access_token', 'token_type', 'expires_in', 'scope', 'id_token'],
          properties: {
            access_token: { type: 'string' },
            token_type: { type: 'string', enum: ['Bearer'] },
            expires_in: { type: 'integer', example: 3600 },
            scope: { type: 'string', example: 'openid email profile' },
            id_token: { type: 'string', description: 'RS256 JWT. email_verified is true. Operator tokens include amr.' },
          },
        },
        RazorpayOrderRequest: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'integer', minimum: 100, description: 'Paise.' },
            currency: { type: 'string', enum: ['INR'] },
            receipt: { type: 'string' },
          },
        },
        RazorpayOrder: {
          type: 'object',
          required: ['id', 'entity', 'amount', 'currency', 'status'],
          properties: {
            id: { type: 'string' },
            entity: { type: 'string', enum: ['order'] },
            amount: { type: 'integer' },
            amount_paid: { type: 'integer' },
            amount_due: { type: 'integer' },
            currency: { type: 'string', enum: ['INR'] },
            receipt: { type: 'string' },
            status: { type: 'string', enum: ['created'] },
            attempts: { type: 'integer' },
            created_at: { type: 'integer', description: 'Unix seconds.' },
          },
        },
        CashfreeOrderRequest: {
          type: 'object',
          required: ['order_id', 'order_amount', 'order_currency'],
          properties: {
            order_id: { type: 'string' },
            order_amount: { type: 'number', minimum: 1, description: 'Rupees.' },
            order_currency: { type: 'string', enum: ['INR'] },
          },
        },
        CashfreeOrder: {
          type: 'object',
          required: ['cf_order_id', 'order_id', 'order_status', 'payment_session_id'],
          properties: {
            cf_order_id: { type: 'string' },
            order_id: { type: 'string' },
            entity: { type: 'string', enum: ['order'] },
            order_amount: { type: 'number' },
            order_currency: { type: 'string', enum: ['INR'] },
            order_status: { type: 'string', enum: ['ACTIVE'] },
            payment_session_id: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        GmailSendRequest: {
          type: 'object',
          required: ['raw'],
          properties: { raw: { type: 'string', description: 'Base64 or base64url RFC 822 message.' } },
        },
        GmailSendResponse: {
          type: 'object',
          required: ['id', 'threadId', 'labelIds'],
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string' },
            labelIds: { type: 'array', items: { type: 'string', enum: ['SENT'] } },
          },
        },
        MetadataToken: {
          type: 'object',
          required: ['access_token', 'expires_in', 'token_type'],
          properties: {
            access_token: { type: 'string', example: STORAGE_TOKEN },
            expires_in: { type: 'integer', example: 3599 },
            token_type: { type: 'string', enum: ['Bearer'] },
          },
        },
        StorageObject: {
          type: 'object',
          required: ['kind', 'bucket', 'name', 'size'],
          properties: {
            kind: { type: 'string', enum: ['storage#object'] },
            bucket: { type: 'string' },
            name: { type: 'string' },
            size: { type: 'string' },
            contentType: { type: 'string' },
          },
        },
        SmsRequest: {
          type: 'object',
          properties: { to: { type: 'string' }, message: { type: 'string' } },
        },
        SmsResponse: {
          type: 'object',
          required: ['id', 'status'],
          properties: { id: { type: 'string' }, status: { type: 'string', enum: ['queued'] } },
        },
        WhatsAppResponse: {
          type: 'object',
          required: ['messaging_product', 'contacts', 'messages'],
          properties: {
            messaging_product: { type: 'string', enum: ['whatsapp'] },
            contacts: { type: 'array', items: { type: 'object', required: ['input', 'wa_id'], properties: { input: { type: 'string' }, wa_id: { type: 'string' } } } },
            messages: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
          },
        },
        WebhookAck: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
        },
        PincodeHit: {
          type: 'object',
          required: ['data'],
          properties: {
            data: {
              type: 'object',
              required: ['code', 'name', 'district', 'state'],
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                district: { type: 'string' },
                state: { type: 'string' },
              },
            },
          },
        },
        ConnectorToken: {
          type: 'object',
          required: ['access_token', 'token_type', 'expires_in'],
          properties: {
            access_token: { type: 'string' },
            refresh_token: { type: 'string', description: 'Returned for an authorization-code grant.' },
            token_type: { type: 'string', enum: ['Bearer'] },
            expires_in: { type: 'integer', example: 3600 },
          },
        },
      },
    },
  };
}

/** Swagger UI for `/openapi.json`. The UI script is loaded from unpkg; the document itself is on this sandbox. */
export function swaggerPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Service sandbox API</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui.css">
<style>body{margin:0} #spec-fallback{font:15px system-ui,sans-serif;margin:1.5rem}</style>
</head><body>
<div id="swagger-ui"></div>
<p id="spec-fallback">Swagger UI did not load. The document is at <a href="/openapi.json">/openapi.json</a>.</p>
<script src="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"></script>
<script>
if (window.SwaggerUIBundle) {
  document.getElementById('spec-fallback').remove();
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    docExpansion: 'list',
  });
}
</script>
</body></html>`;
}
