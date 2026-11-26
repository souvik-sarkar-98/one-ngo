import { metadataServerToken } from '../files/index.js';

/**
 * Start-up settings for App Engine. The entry point reads one JSON secret from Google Secret Manager and puts
 * its values in the process environment before the server loads. No secret value is written to app.yaml or
 * to the App Engine version config.
 *
 * Error messages name the secret and the setting, never its value. A JSON parse error is replaced with a
 * fixed message, because the parser can quote part of its input.
 */

const SECRET_MANAGER_API = 'https://secretmanager.googleapis.com';
const SETTING_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface SecretConfigOptions {
  project: string;
  secretId: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Reads the latest version of the secret and returns its settings. */
export async function loadSecretConfig(options: SecretConfigOptions): Promise<Record<string, string>> {
  const call = options.fetch ?? fetch;
  const url = `${SECRET_MANAGER_API}/v1/projects/${encodeURIComponent(options.project)}/secrets/${encodeURIComponent(options.secretId)}/versions/latest:access`;
  const response = await call(url, {
    headers: { authorization: `Bearer ${await options.accessToken()}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`Secret Manager refused ${options.secretId} with status ${response.status}.`);
  const body = (await response.json().catch(() => undefined)) as { payload?: { data?: unknown } } | undefined;
  const data = body?.payload?.data;
  if (typeof data !== 'string' || !data) throw new Error(`Secret ${options.secretId} has no payload.`);
  return parseSecretConfig(Buffer.from(data, 'base64').toString('utf8'), options.secretId);
}

/** A JSON object whose keys are environment setting names and whose values are non-empty text. */
export function parseSecretConfig(text: string, secretId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Secret ${secretId} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Secret ${secretId} must be a JSON object.`);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!SETTING_NAME.test(name)) throw new Error(`Secret ${secretId} has an invalid setting name: ${name}.`);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Secret ${secretId} has an empty or non-text value for ${name}.`);
    values[name] = value;
  }
  return values;
}

/**
 * Puts the values in the environment. A setting that app.yaml already sets is refused, so a secret can never be
 * silently overridden, and so a leftover plaintext copy in app.yaml fails the start-up instead of winning.
 */
export function applySecretConfig(env: NodeJS.ProcessEnv, values: Record<string, string>): string[] {
  const clash = Object.keys(values).filter((name) => env[name] !== undefined);
  if (clash.length) throw new Error(`Remove these from app.yaml; they now come from Secret Manager: ${clash.join(', ')}.`);
  Object.assign(env, values);
  return Object.keys(values);
}

/**
 * The start-up step for App Engine. `GOOGLE_CLOUD_PROJECT` is set by App Engine; `SECRET_CONFIG_ID` is set in app.yaml.
 * Returns how many settings were loaded.
 */
export async function bootstrapSecrets(
  env: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; accessToken?: () => Promise<string> } = {},
): Promise<number> {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim();
  const secretId = env.SECRET_CONFIG_ID?.trim();
  if (!project || !secretId) throw new Error('GOOGLE_CLOUD_PROJECT and SECRET_CONFIG_ID must be set.');
  const values = await loadSecretConfig({
    project,
    secretId,
    accessToken: options.accessToken ?? metadataServerToken(options.fetch),
    fetch: options.fetch,
  });
  return applySecretConfig(env, values).length;
}
