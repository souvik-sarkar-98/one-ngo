/** Settings the console refuses to start without. The operator identity provider is one of them. */
export const REQUIRED_SETTINGS = [
  'OPERATOR_PUBLIC_BASE_URL',
  'OPERATOR_DATABASE_URL',
  'OPERATOR_RUNTIME_URL',
  'OPERATOR_ENCRYPTION_KEY',
  'ENCRYPTION_KEY',
  'OPERATOR_INTERNAL_TOKEN_SECRET',
  'OPERATOR_OIDC_ISSUER',
  'OPERATOR_OIDC_CLIENT_ID',
  'OPERATOR_OIDC_AUDIENCE',
] as const;

/** Names every missing required setting in one error, so a deploy is fixed in one pass. */
export function assertConsoleSettings(env: NodeJS.ProcessEnv): void {
  const missing = REQUIRED_SETTINGS.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Set ${missing.join(', ')}.`);
}

/** `OPERATOR_IAP_AUDIENCE` is required outside local mode, and never used with `OPERATOR_LOCAL_WITHOUT_IAP`. */
export function iapAudience(env: NodeJS.ProcessEnv, local: boolean): string | undefined {
  const audience = env.OPERATOR_IAP_AUDIENCE?.trim();
  if (local) {
    if (audience) throw new Error('OPERATOR_IAP_AUDIENCE cannot be used with OPERATOR_LOCAL_WITHOUT_IAP.');
    return undefined;
  }
  if (!audience) throw new Error('Set OPERATOR_IAP_AUDIENCE.');
  return audience;
}
