/**
 * Starts the API on port 8080. Integration hosts come from .env.
 * Pass --port to use another port. Mail is an organisation connector, not SMTP.
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

const argv = process.argv.slice(2);
const port = takePort(argv, '--port');
if (argv.includes('--smtp-port')) fail('The sandbox no longer accepts SMTP. Save the gmail connector instead of passing --smtp-port.');
if (argv.length) fail(`Unknown option ${argv[0]}. Use --port.`);

loadEnv(join(root, '.env'));
const adminUrl = fillAdministrativeUrls();
if (!process.env.DATABASE_RUNTIME_URL?.trim()) {
  process.env.DATABASE_RUNTIME_URL = await runtimeConnectionString(adminUrl, 'ngo_main_runtime_local', 'ngo_main_runtime');
}
process.env.PORT = String(port ?? process.env.PORT ?? 8080);
if (port || !process.env.PUBLIC_BASE_URL?.trim()) process.env.PUBLIC_BASE_URL = `http://localhost:${process.env.PORT}`;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: serverDir,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
