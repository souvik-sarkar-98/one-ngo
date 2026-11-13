/**
 * Starts the operator console on port 9090.
 * Pass --port or --fixture-port to use another port. .env PORT stays the API port.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConnectionString } from '../../../../utilities/sandbox/local-database.mjs';

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
const port = takePort(argv, '--port') ?? 9090;
const fixturePortArg = takePort(argv, '--fixture-port');
const fixturePort = fixturePortArg ?? 8095;
if (argv.length) fail(`Unknown option ${argv[0]}. Use --port and --fixture-port.`);

loadEnv(join(root, '.env'));
const adminUrl = process.env.DATABASE_URL?.trim();
if (!process.env.OPERATOR_DATABASE_URL?.trim()) {
  if (!adminUrl) fail('Set DATABASE_URL or OPERATOR_DATABASE_URL in .env.');
  process.env.OPERATOR_DATABASE_URL = adminUrl;
}
if (!process.env.OPERATOR_RUNTIME_URL?.trim()) {
  const database = decodeURIComponent(new URL(process.env.OPERATOR_DATABASE_URL).pathname.replace(/^\//, '')) || 'ngo';
  const login = `ngo_op_rt_${database}`.slice(0, 63);
  process.env.OPERATOR_RUNTIME_URL = await runtimeConnectionString(process.env.OPERATOR_DATABASE_URL, login, 'ngo_operator_runtime');
}
process.env.PORT = String(port);
process.env.OPERATOR_PUBLIC_BASE_URL = `http://localhost:${port}`;
process.env.OPERATOR_LOCAL_WITHOUT_IAP = '1';
if (fixturePortArg || !process.env.OPERATOR_OIDC_ISSUER?.trim()) {
  process.env.OPERATOR_OIDC_ISSUER = `https://127.0.0.1:${fixturePort}`;
}
fill('OPERATOR_OIDC_CLIENT_ID', 'demo-operator');
fill('OPERATOR_OIDC_CLIENT_SECRET', 'demo-operator-secret');
fill('OPERATOR_OIDC_AUDIENCE', process.env.OPERATOR_OIDC_CLIENT_ID);
process.env.OPERATOR_WEB_ROOT = join(root, 'apps', 'onengo-console', 'web', 'dist', 'operator', 'browser');
const ca = join(root, '.data', 'service-sandbox', 'tls', 'ca.crt');
if (existsSync(ca)) process.env.NODE_EXTRA_CA_CERTS = ca;
delete process.env.OPERATOR_OIDC_MFA_ACR;
delete process.env.OPERATOR_IAP_AUDIENCE;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: serverDir,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
