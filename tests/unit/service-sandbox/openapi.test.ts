import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATHS } from '../../../apps/service-sandbox/server/src/constants.js';
import type { Fixture } from '../../../apps/service-sandbox/server/src/server.js';
import { call, tempFixture } from '../../support/service-sandbox/helpers.js';

let fixture: Fixture;
let cleanup: () => Promise<void>;
beforeAll(async () => ({ fixture, cleanup } = await tempFixture()));
afterAll(() => cleanup());

const PATHS_IN_DOCUMENT: Record<keyof typeof PATHS, string> = {
  discovery: PATHS.discovery,
  authorize: PATHS.authorize,
  token: PATHS.token,
  jwks: PATHS.jwks,
  razorpayOrders: PATHS.razorpayOrders,
  cashfreeOrders: PATHS.cashfreeOrders,
  metadataToken: PATHS.metadataToken,
  pwnedRange: '/range/{prefix}',
  gmailSend: '/gmail/v1/users/{userId}/messages/send',
  sms: PATHS.sms,
  whatsapp: '/whatsapp/{phoneNumberId}/messages',
  hooksIn: PATHS.hooksIn,
  lookup: '/lookup/{pincode}',
  connectorAuthorize: PATHS.connectorAuthorize,
  connectorToken: PATHS.connectorToken,
};

describe('OpenAPI document', () => {
  it('serves the document and Swagger UI', async () => {
    const spec = await call(fixture, '/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.headers['content-type']).toContain('application/json');
    const doc = spec.json<{ openapi: string; servers: { url: string }[]; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers[0]?.url).toBe(fixture.origin);
    for (const path of Object.values(PATHS_IN_DOCUMENT)) expect(doc.paths, path).toHaveProperty(path);
    expect(doc.paths).toHaveProperty('/orders/{provider}/{orderId}/{action}');
    expect(doc.paths).toHaveProperty('/upload/storage/v1/b/{bucket}/o');
    expect(doc.paths).toHaveProperty('/storage/v1/b/{bucket}/o/{object}');

    const ui = await call(fixture, '/swagger');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    expect(ui.text).toContain('/openapi.json');
    expect(ui.text).toContain('SwaggerUIBundle');
  });
});
