/**
 * Starts the API on port 8080 against the sandbox at https://127.0.0.1:8095.
 * Pass --port, --fixture-port, or --smtp-port to use another port.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillAdministrativeUrls, runtimeConnectionString } from '../../../../utilities/sandbox/local-database.mjs';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(serverDir, '..', '..', '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadEnv(path) {
  if (!existsSync(path)) fail('Copy .env.example to .env and set TOKEN_SECRET and ENCRYPTION_KEY.');
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== '') process.env[key] = value;
  }
}

function portValue(raw, flag) {
  if (!raw || !/^\d+$/.test(raw)) fail(`Use ${flag} <port>.`);
  const port = Number(raw);
  if (port < 1 || port > 65535) fail(`${flag} must be a port from 1 to 65535.`);
  return port;
}

function takePort(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const port = portValue(argv[index + 1], flag);
  argv.splice(index, 2);
  return port;
}

function fill(name, value) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const argv = process.argv.slice(2);
const port = takePort(argv, '--port');
const fixturePort = takePort(argv, '--fixture-port');
const smtpPort = takePort(argv, '--smtp-port');
if (argv.length) fail(`Unknown option ${argv[0]}. Use --port, --fixture-port, and --smtp-port.`);

loadEnv(join(root, '.env'));
const adminUrl = fillAdministrativeUrls();
if (!process.env.DATABASE_RUNTIME_URL?.trim()) {
  process.env.DATABASE_RUNTIME_URL = await runtimeConnectionString(adminUrl, 'ngo_main_runtime_local', 'ngo_main_runtime');
}
process.env.PORT = String(port ?? process.env.PORT ?? 8080);
if (port || !process.env.PUBLIC_BASE_URL?.trim()) process.env.PUBLIC_BASE_URL = `http://localhost:${process.env.PORT}`;

const origin = `https://127.0.0.1:${fixturePort ?? 8095}`;
if (fixturePort || !process.env.INTEGRATION_FIXTURE_ORIGIN?.trim()) process.env.INTEGRATION_FIXTURE_ORIGIN = origin;
if (fixturePort || !process.env.OIDC_ISSUER?.trim()) process.env.OIDC_ISSUER = process.env.INTEGRATION_FIXTURE_ORIGIN;
fill('OIDC_CLIENT_ID', 'demo-google');
fill('OIDC_CLIENT_SECRET', 'demo-google-secret');
fill('OIDC_PROVIDER_ID', 'google');
fill('OIDC_PROVIDER_LABEL', 'Google');
if (fixturePort || !process.env.RAZORPAY_API_BASE?.trim()) process.env.RAZORPAY_API_BASE = process.env.INTEGRATION_FIXTURE_ORIGIN;
if (fixturePort || !process.env.CASHFREE_API_BASE?.trim()) process.env.CASHFREE_API_BASE = process.env.INTEGRATION_FIXTURE_ORIGIN;
fill('SMTP_HOST', '127.0.0.1');
if (smtpPort || !process.env.SMTP_PORT?.trim()) process.env.SMTP_PORT = String(smtpPort ?? 2525);
fill('SMTP_SECURE', '0');
fill('SMTP_USER', 'demo');
fill('SMTP_PASSWORD', 'demo');
fill('SMTP_FROM', 'demo@localhost');
const allowed = (process.env.CONNECTOR_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean);
if (!allowed.includes('127.0.0.1')) allowed.push('127.0.0.1');
process.env.CONNECTOR_ALLOWED_HOSTS = allowed.join(',');
const ca = join(root, '.data', 'service-sandbox', 'tls', 'ca.crt');
if (existsSync(ca)) process.env.NODE_EXTRA_CA_CERTS = ca;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: serverDir,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
