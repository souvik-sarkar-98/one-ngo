import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HTTPS_PORT, SMTP_PORT } from './constants.js';
import { envBlock } from './home.js';
import { DEFAULT_DATA_DIR, startFixture } from './server.js';

function portNumber(raw: string | undefined, label: string, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${label} must be a port number.`);
  return port;
}

function portFromEnv(name: string, fallback: number): number {
  return portNumber(process.env[name], name, fallback);
}

/** `--https-port` and `--smtp-port` override the environment. Unset keeps 8095 and 2525. */
function portFromArg(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const raw = process.argv[index + 1];
  if (!raw || raw.startsWith('-')) throw new Error(`Use ${flag} <port>.`);
  const port = portNumber(raw, flag, -1);
  if (port < 1) throw new Error(`${flag} must be a port from 1 to 65535.`);
  return port;
}

/** Reads `KEY=value` lines from the repository's .env without changing this process's environment. */
function dotEnv(): Record<string, string> {
  const path = join(DEFAULT_DATA_DIR, '..', '..', '.env');
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^"(.*)"$/, '$1');
  }
  return values;
}

const file = dotEnv();
const setting = (name: string): string | undefined => process.env[name] ?? file[name] ?? undefined;
const nonEmpty = (value: string | undefined) => (value ? value : undefined);

const fixture = await startFixture({
  httpsPort: portFromArg('--https-port') ?? portFromEnv('FIXTURE_HTTPS_PORT', HTTPS_PORT),
  smtpPort: portFromArg('--smtp-port') ?? portFromEnv('FIXTURE_SMTP_PORT', SMTP_PORT),
  ...(process.env.FIXTURE_DATA_DIR ? { dataDir: process.env.FIXTURE_DATA_DIR } : {}),
  oneNgoBaseUrl: nonEmpty(process.env.ONENGO_BASE_URL) ?? nonEmpty(setting('PUBLIC_BASE_URL')) ?? `http://localhost:${nonEmpty(setting('PORT')) ?? '8080'}`,
  fileStoreBucket: nonEmpty(setting('FILE_STORE_BUCKET')),
  fileStorePrefix: setting('FILE_STORE_PREFIX'),
  defaultOrg: nonEmpty(process.env.DEMO_ORG) ?? 'demo',
}).catch((error: unknown) => {
  console.error(`The integration fixture could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

// Paste into one-ngo's .env and restart one-ngo:
// ${envBlock({ origin: fixture.origin, smtpHost: '127.0.0.1', smtpPort: fixture.smtpPort, caPath: fixture.tls.caPath, fileStoreBucket: nonEmpty(setting('FILE_STORE_BUCKET')), fileStorePrefix: setting('FILE_STORE_PREFIX') })}
console.log(`one-ngo integration fixture (test use only)
  Log page: ${fixture.origin}/
  SMTP:     127.0.0.1:${fixture.smtpPort}
  Files:    ${fixture.filesDir}
Refer to the README.html for instructions on how to use this fixture.
Your browser will warn about the certificate once on the sign-in page; accepting it is enough for that session.
Press Ctrl+C to stop.`);

const stop = async () => {
  await fixture.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
