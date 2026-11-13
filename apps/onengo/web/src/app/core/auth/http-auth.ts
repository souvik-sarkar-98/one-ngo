import {
  contracted,
  type EmailCodeVerifyRequest,
  type EmailRequest,
  type LoginRequest,
  type PasswordResetCompleteRequest,
  type PasswordTokenCheckRequest,
  type PasswordTokenCheckResponse,
  type TokenResponse,
  type TwoStepCompleteRequest,
} from '../contracts';
import type { HttpLike } from '../http/http';
import type { Messages } from '../i18n/i18n';
import type { Me, RuntimeDefinitions } from '../models';

/** The refresh cookie is sent only to this address; the HTTP client calls it directly when the access token runs out. */
export const REFRESH_URL = '/api/auth/refresh';

/** Sign-in addresses carry no access token and are never retried after a refresh. */
export const isAuthUrl = (url: string): boolean => url.startsWith('/api/auth/');

export type SignInResult = TokenResponse;

/** Signing in and out, and what the app loads for the signed-in person. */
export interface AuthGateway {
  me(): Promise<Me>;
  definitions(): Promise<RuntimeDefinitions>;
  login(input: LoginRequest): Promise<SignInResult>;
  requestCode(tenant: string, email: string): Promise<void>;
  verifyCode(input: EmailCodeVerifyRequest): Promise<SignInResult>;
  completeTwoStep(ticket: string, totpCode: string): Promise<SignInResult>;
  logout(): Promise<void>;
  providers(tenant: string): Promise<{ id: string; label: string }[]>;
  requestPasswordReset(tenant: string, email: string): Promise<void>;
  /** Whether a reset or invitation link still works. Asking does not use it up. */
  passwordTokenUsable(token: string): Promise<boolean>;
  completePasswordReset(token: string, password: string): Promise<void>;
  /** Screen text for the person's language (or `locale`): the shipped catalogue with the organisation's overrides. */
  messages(locale?: string): Promise<{ locale: string; messages: Messages }>;
  /** Saves the person's language. */
  setLocale(locale: string): Promise<{ locale: string }>;
}

/** Where the browser goes to sign in with an identity provider; it is a page address, not a call. */
export function providerStartUrl(id: string, tenant: string, next: string): string {
  return `/api/auth/oidc/${encodeURIComponent(id)}/start?${new URLSearchParams({ tenant, next })}`;
}

/** The sign-in routes with fixed contracts. */
export interface AuthRoutes {
  'POST /api/auth/login': { body: LoginRequest; answer: TokenResponse };
  'POST /api/auth/email-code/request': { body: EmailRequest; answer: void };
  'POST /api/auth/email-code/verify': { body: EmailCodeVerifyRequest; answer: TokenResponse };
  'POST /api/auth/two-step/complete': { body: TwoStepCompleteRequest; answer: TokenResponse };
  'POST /api/auth/refresh': { answer: TokenResponse };
  'POST /api/auth/password-reset/request': { body: EmailRequest; answer: void };
  'POST /api/auth/password-reset/check': { body: PasswordTokenCheckRequest; answer: PasswordTokenCheckResponse };
  'POST /api/auth/password-reset/complete': { body: PasswordResetCompleteRequest; answer: void };
}

export function httpAuth(http: HttpLike): AuthGateway {
  const send = contracted<AuthRoutes>(http);
  return {
    me: () => http.get<Me>('/api/people/me'),
    definitions: () => http.get<RuntimeDefinitions>('/api/runtime/definitions'),
    login: (input) => send('POST /api/auth/login', input),
    requestCode: (tenant, email) => send('POST /api/auth/email-code/request', { tenant, email }),
    verifyCode: (input) => send('POST /api/auth/email-code/verify', input),
    completeTwoStep: (ticket, totpCode) => send('POST /api/auth/two-step/complete', { ticket, totpCode }),
    logout: () => http.post('/api/auth/logout'),
    providers: (tenant) => http.get<{ id: string; label: string }[]>(`/api/auth/providers?tenant=${encodeURIComponent(tenant)}`),
    requestPasswordReset: (tenant, email) => send('POST /api/auth/password-reset/request', { tenant, email }),
    passwordTokenUsable: async (token) => (await send('POST /api/auth/password-reset/check', { token })).usable,
    completePasswordReset: (token, password) => send('POST /api/auth/password-reset/complete', { token, password }),
    messages: (locale) =>
      http.get<{ locale: string; messages: Messages }>(locale ? `/api/runtime/messages?locale=${encodeURIComponent(locale)}` : '/api/runtime/messages'),
    setLocale: (locale) => http.put<{ locale: string }>('/api/me/locale', { locale }),
  };
}
