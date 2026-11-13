/**
 * Starts the user guide on port 4300, served at /guide-app/.
 * Pass --port to use another port. The web app proxies /guide-app/ here.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const port = index === -1 ? 4300 : portValue(argv[index + 1], '--port');
if (index !== -1) argv.splice(index, 2);
if (argv.length) fail(`Unknown option ${argv[0]}. Use --port.`);

let ng;
try {
  ng = createRequire(import.meta.url).resolve('@angular/cli/bin/ng.js');
} catch {
  fail('Install dependencies at the repository root (npm install).');
}

const child = spawn(process.execPath, [ng, 'serve', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: webDir,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
