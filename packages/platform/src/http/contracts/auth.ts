import type { JSONSchemaType } from 'ajv';
import { schemaOf } from './schema.js';

type AssuranceLevel = 'aal1' | 'aal2' | 'aal3';

const text = { type: 'string' } as const;
const optionalText = { type: 'string', nullable: true } as const;

export interface LoginRequest {
  tenant: string;
  email: string;
  password: string;
  totpCode?: string;
}

export const loginRequest = schemaOf<LoginRequest>({
  type: 'object',
  required: ['tenant', 'email', 'password'],
  additionalProperties: false,
  properties: { tenant: text, email: text, password: text, totpCode: optionalText },
});

/** Asking for a sign-in code or a password reset link. */
export interface EmailRequest {
  tenant: string;
  email: string;
}

export const emailRequest = schemaOf<EmailRequest>({
  type: 'object',
  required: ['tenant', 'email'],
  additionalProperties: false,
  properties: { tenant: text, email: text },
});

export interface EmailCodeVerifyRequest {
  tenant: string;
  email: string;
  code: string;
  totpCode?: string;
}

export const emailCodeVerifyRequest = schemaOf<EmailCodeVerifyRequest>({
  type: 'object',
  required: ['tenant', 'email', 'code'],
  additionalProperties: false,
  properties: { tenant: text, email: text, code: text, totpCode: optionalText },
});

/** Asking whether a reset or invitation link still works, before its page offers the form. */
export interface PasswordTokenCheckRequest {
  token: string;
}

export const passwordTokenCheckRequest = schemaOf<PasswordTokenCheckRequest>({
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: { token: text },
});

export interface PasswordTokenCheckResponse {
  usable: boolean;
}

export const passwordTokenCheckResponse: JSONSchemaType<PasswordTokenCheckResponse> = {
  type: 'object',
  required: ['usable'],
  additionalProperties: false,
  properties: { usable: { type: 'boolean' } },
};

export interface PasswordResetCompleteRequest {
  token: string;
  password: string;
}

export const passwordResetCompleteRequest = schemaOf<PasswordResetCompleteRequest>({
  type: 'object',
  required: ['token', 'password'],
  additionalProperties: false,
  properties: { token: text, password: text },
});

export interface TwoStepCompleteRequest {
  ticket: string;
  totpCode: string;
}

export const twoStepCompleteRequest = schemaOf<TwoStepCompleteRequest>({
  type: 'object',
  required: ['ticket', 'totpCode'],
  additionalProperties: false,
  properties: { ticket: text, totpCode: text },
});

/** Starting two-step setup. While two-step is on, the current password and a current code are both needed. */
export interface TwoStepBeginRequest {
  password?: string;
  totpCode?: string;
}

export const twoStepBeginRequest = schemaOf<TwoStepBeginRequest>({
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: { password: optionalText, totpCode: optionalText },
});

/** The first code from a newly set up authenticator app. */
export interface TwoStepConfirmRequest {
  code: string;
}

export const twoStepConfirmRequest = schemaOf<TwoStepConfirmRequest>({
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: text },
});

export interface AuthPolicyRequest {
  passwordEnabled: boolean;
  emailCodeEnabled: boolean;
  passkeyEnabled: boolean;
  minimumAssurance: AssuranceLevel;
}

export const authPolicyRequest = schemaOf<AuthPolicyRequest>({
  type: 'object',
  required: ['passwordEnabled', 'emailCodeEnabled', 'passkeyEnabled', 'minimumAssurance'],
  additionalProperties: false,
  properties: {
    passwordEnabled: { type: 'boolean' },
    emailCodeEnabled: { type: 'boolean' },
    passkeyEnabled: { type: 'boolean' },
    minimumAssurance: { type: 'string', enum: ['aal1', 'aal2', 'aal3'] },
  },
});

/** Passkey sign-in, usernameless: the organisation's code, then the one-time ceremony id and the browser's response. */
export interface PasskeyOptionsRequest {
  tenant: string;
}

export const passkeyOptionsRequest = schemaOf<PasskeyOptionsRequest>({
  type: 'object',
  required: ['tenant'],
  additionalProperties: false,
  properties: { tenant: text },
});

export interface PasskeySignInRequest {
  tenant: string;
  challengeId: string;
  response: Record<string, unknown>;
}

export const passkeySignInRequest = schemaOf<PasskeySignInRequest>({
  type: 'object',
  required: ['tenant', 'challengeId', 'response'],
  additionalProperties: false,
  properties: { tenant: text, challengeId: text, response: { type: 'object' } },
});

/** Adding a passkey: the ceremony id, the browser's answer, and a name the person gave it. */
export interface PasskeyRegisterRequest {
  challengeId: string;
  response: Record<string, unknown>;
  name?: string;
}

export const passkeyRegisterRequest = schemaOf<PasskeyRegisterRequest>({
  type: 'object',
  required: ['challengeId', 'response'],
  additionalProperties: false,
  properties: { challengeId: text, response: { type: 'object' }, name: { type: 'string', nullable: true, maxLength: 120 } },
});

export interface PasskeyNameRequest {
  name: string;
}

export const passkeyNameRequest = schemaOf<PasskeyNameRequest>({
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
});

/** Re-proof before adding or removing a passkey once two-step is on. */
export interface PasskeyReauthRequest {
  password?: string;
  totpCode?: string;
}

export const passkeyReauthRequest = schemaOf<PasskeyReauthRequest>({
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: { password: optionalText, totpCode: optionalText },
});

export interface ProviderPolicyRequest {
  enabled: boolean;
  assurance: AssuranceLevel;
}

export const providerPolicyRequest = schemaOf<ProviderPolicyRequest>({
  type: 'object',
  required: ['enabled', 'assurance'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    assurance: { type: 'string', enum: ['aal1', 'aal2', 'aal3'] },
  },
});

/** A signed-in answer. The refresh token travels only in the HttpOnly cookie, never in a body. */
export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

export const tokenResponse: JSONSchemaType<TokenResponse> = {
  type: 'object',
  required: ['accessToken', 'expiresIn'],
  additionalProperties: false,
  properties: { accessToken: text, expiresIn: { type: 'integer' } },
};
