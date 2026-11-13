/**
 * Starts the Angular app on port 4200 and proxies /api to the API on port 8080.
 * Pass --port or --api-port to use another port.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(webDir, '..', '..', '..');

function fail(message) {
  console.error(message);
  process.exit(1);
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
const port = takePort(argv, '--port') ?? 4200;
const apiPort = takePort(argv, '--api-port') ?? 8080;
if (argv.length) fail(`Unknown option ${argv[0]}. Use --port and --api-port.`);

let proxy = join(webDir, 'proxy.conf.json');
if (apiPort !== 8080) {
  const dir = join(root, '.data', 'dev');
  mkdirSync(dir, { recursive: true });
  proxy = join(dir, `proxy-${apiPort}.json`);
  writeFileSync(proxy, `${JSON.stringify({
    '/api': { target: `http://localhost:${apiPort}`, secure: false },
    '/webhooks': { target: `http://localhost:${apiPort}`, secure: false },
    '/guide-app': { target: 'http://127.0.0.1:4300', secure: false, ws: true },
  }, null, 2)}\n`);
}

let ng;
try {
  ng = createRequire(import.meta.url).resolve('@angular/cli/bin/ng.js');
} catch {
  fail('Install dependencies at the repository root (npm install).');
}
const child = spawn(process.execPath, [ng, 'serve', '--port', String(port), '--host', '127.0.0.1', '--proxy-config', proxy], {
  cwd: webDir,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
