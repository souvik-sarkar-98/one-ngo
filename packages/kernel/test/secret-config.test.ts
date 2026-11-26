import { describe, expect, it } from 'vitest';
import { applySecretConfig, bootstrapSecrets, loadSecretConfig, parseSecretConfig } from '../src/secrets/index.js';

const SECRET_VALUE = 'postgres://owner:s3cret-value@db.example/ngo';
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const accessResponse = (text: string) => new Response(JSON.stringify({ name: 'x', payload: { data: encode(text) } }), { status: 200 });
const token = async () => 'test-token';

describe('parseSecretConfig', () => {
  it('returns the settings of a JSON object', () => {
    expect(parseSecretConfig('{"TOKEN_SECRET":"abc","ENCRYPTION_KEY":"def"}', 'ngo-prod-config')).toEqual({ TOKEN_SECRET: 'abc', ENCRYPTION_KEY: 'def' });
  });

  it('refuses a value that is not a JSON object', () => {
    expect(() => parseSecretConfig('["a"]', 'ngo-prod-config')).toThrow('must be a JSON object');
    expect(() => parseSecretConfig('"text"', 'ngo-prod-config')).toThrow('must be a JSON object');
  });

  it('refuses a setting name that is not an environment name', () => {
    expect(() => parseSecretConfig('{"token-secret":"abc"}', 'ngo-prod-config')).toThrow('invalid setting name: token-secret');
  });

  it('refuses an empty or non-text value and names only the setting', () => {
    expect(() => parseSecretConfig('{"TOKEN_SECRET":"  "}', 'ngo-prod-config')).toThrow('empty or non-text value for TOKEN_SECRET');
    expect(() => parseSecretConfig('{"TOKEN_SECRET":42}', 'ngo-prod-config')).toThrow('empty or non-text value for TOKEN_SECRET');
  });

  it('never repeats the content of invalid JSON, because the parser can quote part of it', () => {
    const broken = `{"DATABASE_SYSTEM_URL": "${SECRET_VALUE}" `;
    try {
      parseSecretConfig(broken, 'ngo-prod-config');
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as Error).message).toBe('Secret ngo-prod-config is not valid JSON.');
      expect((error as Error).message).not.toContain('s3cret-value');
    }
  });
});

describe('loadSecretConfig', () => {
  it('reads the latest version with the bearer token and decodes the payload', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
      return accessResponse('{"TOKEN_SECRET":"abc"}');
    }) as typeof fetch;

    const values = await loadSecretConfig({ project: 'ngo-prod', secretId: 'ngo-prod-config', accessToken: token, fetch: fetchFn });

    expect(values).toEqual({ TOKEN_SECRET: 'abc' });
    expect(calls).toEqual([{
      url: 'https://secretmanager.googleapis.com/v1/projects/ngo-prod/secrets/ngo-prod-config/versions/latest:access',
      authorization: 'Bearer test-token',
    }]);
  });

  it('reports the status without the response body when the read is refused', async () => {
    const fetchFn = (async () => new Response(`denied ${SECRET_VALUE}`, { status: 403 })) as typeof fetch;
    const error = await loadSecretConfig({ project: 'ngo-prod', secretId: 'ngo-prod-config', accessToken: token, fetch: fetchFn }).catch((e: Error) => e);
    expect((error as Error).message).toBe('Secret Manager refused ngo-prod-config with status 403.');
  });

  it('refuses a response with no payload', async () => {
    const fetchFn = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await expect(loadSecretConfig({ project: 'ngo-prod', secretId: 'ngo-prod-config', accessToken: token, fetch: fetchFn })).rejects.toThrow('has no payload');
  });
});

describe('applySecretConfig', () => {
  it('puts every value in the environment', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    expect(applySecretConfig(env, { TOKEN_SECRET: 'abc', ENCRYPTION_KEY: 'def' })).toEqual(['TOKEN_SECRET', 'ENCRYPTION_KEY']);
    expect(env.TOKEN_SECRET).toBe('abc');
    expect(env.ENCRYPTION_KEY).toBe('def');
  });

  it('refuses a setting that app.yaml still sets, so a leftover plaintext copy fails the start-up', () => {
    const env: NodeJS.ProcessEnv = { TOKEN_SECRET: 'old-in-yaml' };
    expect(() => applySecretConfig(env, { TOKEN_SECRET: 'abc', ENCRYPTION_KEY: 'def' })).toThrow('Remove these from app.yaml; they now come from Secret Manager: TOKEN_SECRET.');
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });
});

describe('bootstrapSecrets', () => {
  it('needs the project and the secret id', async () => {
    await expect(bootstrapSecrets({})).rejects.toThrow('GOOGLE_CLOUD_PROJECT and SECRET_CONFIG_ID must be set.');
  });

  it('loads the settings named by the environment', async () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_CLOUD_PROJECT: 'ngo-prod', SECRET_CONFIG_ID: 'ngo-prod-config', NODE_ENV: 'production' };
    const fetchFn = (async () => accessResponse(`{"DATABASE_SYSTEM_URL":"${SECRET_VALUE}"}`)) as typeof fetch;

    await expect(bootstrapSecrets(env, { fetch: fetchFn, accessToken: token })).resolves.toBe(1);
    expect(env.DATABASE_SYSTEM_URL).toBe(SECRET_VALUE);
  });
});
