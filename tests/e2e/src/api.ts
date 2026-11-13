import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { apiBase, org, password } from './accounts.js';

/** An API client signed in as one member, the way the app signs in: password, bearer access token. */
export async function memberApi(email: string, tenant = org): Promise<APIRequestContext> {
  const anonymous = await playwrightRequest.newContext({ baseURL: apiBase });
  const login = await anonymous.post('/api/auth/login', { data: { tenant, email, password } });
  expect(login.status(), `sign-in as ${email}`).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  await anonymous.dispose();
  return playwrightRequest.newContext({
    baseURL: apiBase,
    extraHTTPHeaders: { authorization: `Bearer ${accessToken}` },
  });
}

/** An API client that acts through an organisation API key, as an external system would. */
export function keyApi(keyId: string, secret: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: apiBase,
    extraHTTPHeaders: { authorization: `ApiKey ${keyId}.${secret}` },
  });
}

/** An API client with no credentials, for public links and refused calls. */
export function anonymousApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: apiBase });
}

/** A value that is unique to this run, for names, request ids, and references. */
export function runTag(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}
