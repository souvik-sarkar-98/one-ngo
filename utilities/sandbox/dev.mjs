/**
 * Starts the sandbox, then the API, web app, user guide, and operator console, with one command.
 *
 *   npm run dev
 *   npm run dev -- --no-sandbox
 *   npm run dev -- --no-web
 *   npm run dev -- --no-guide
 *   npm run dev -- --no-console
 *
 * Starts the local PostgreSQL server first when it is not running. Run `npm run dev:setup`
 * once before the first start. Ctrl+C stops the apps; PostgreSQL keeps running.
 * If one process exits, the others are stopped. Ports are the defaults; to change one,
 * run that app's own command with its flag (each app has a scripts/dev.mjs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalPostgres } from './local-postgres.mjs';

// ------------------- Variables -------------------
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
const known = new Set(['--no-console', '--no-sandbox', '--app-port', '--app-web-port', '--app-web-guide-port', '--console-port', '--console-web-port', '--sandbox-port']);
const unknown = args.find((arg) => !known.has(arg));
if (unknown) {
  console.error(`Unknown option ${unknown}. Use --no-sandbox, --no-web, --no-guide, or --no-console.`);
  process.exit(1);
}
const noConsole = args.includes('--no-console');
const noSandbox = args.includes('--no-sandbox');

export const appPort = args.includes('--app-port') ? args[args.indexOf('--app-port') + 1] : 8080;
const appWebPort = args.includes('--app-web-port') ? args[args.indexOf('--app-web-port') + 1] : 4200;
const appWebGuidePort = args.includes('--app-web-guide-port') ? args[args.indexOf('--app-web-guide-port') + 1] : 4300;
const consolePort = args.includes('--console-port') ? args[args.indexOf('--console-port') + 1] : 9090;
const consoleWebPort = args.includes('--console-web-port') ? args[args.indexOf('--console-web-port') + 1] : 4400;
const sandboxPort = args.includes('--sandbox-port') ? args[args.indexOf('--sandbox-port') + 1] : 8095;
console.log(`[dev] Starting with app port ${appPort}, console port ${consolePort}, sandbox port ${sandboxPort}.`);

const children = [];
let stopping = false;

// ------------------- Functions -------------------
function pipe(stream, name) {
  createInterface({ input: stream }).on('line', (line) => console.log(`[${name}] ${line}`));
}

function run(name, cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd: join(root, cwd),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipe(child.stdout, name);
  pipe(child.stderr, name);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`[${name}] exited with code ${code}. Stopping the others.`);
    stopAll();
    process.exit(code || 1);
  });
  children.push({ name, child });
  return child;
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
        console.log(`[dev] Stopping ${child}.`);
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
}

function waitForPort(port, timeoutMs, gaveUp) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (gaveUp()) return resolve(false);
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function shutdown() {
  stopAll();
  process.exit(0);
}

function bootApp(appName, cwd, args, port, timeout = 60_000, stopAllOnFail = true) {
  const child = run(appName, cwd, args);
  waitForPort(port, timeout, () => child.exitCode !== null || stopping).then((ready) => {
    if (!ready) {
      if (!stopping) console.error(`[dev] ${appName} did not listen on ${port}. Stopping.`);
      if (stopAllOnFail) {
        stopAll();
      }
      process.exit(1);
    } else {
      console.log(`[dev] ${appName} is listening on http://localhost:${port}/`);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ------------------- Main -------------------
// ------------------- Ensure local PostgreSQL is running if needed. ------------------
try {
  await ensureLocalPostgres({ root, log: (message) => console.log(`[dev] ${message}`) });
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// ------------------- Start the sandbox if enabled. -------------------

if (!noSandbox) {
  bootApp('one-ngo-sandbox', 'apps/service-sandbox/server', ['--import', 'tsx', 'src/main.ts', '--port', String(sandboxPort)], sandboxPort);
}

//-------------------- Start the app, web app and guide. -------------------
bootApp('one-ngo', 'apps/onengo/server', ['scripts/dev.mjs', '--port', String(appPort)], appPort);
bootApp('one-ngo-web', 'apps/onengo/web', ['scripts/dev.mjs', '--port', String(appWebPort),'--api-port', String(appPort)], appWebPort, 60_000, false);
bootApp('one-ngo-guide', 'apps/onengo-guide/web', ['scripts/dev.mjs', '--port', String(appWebGuidePort)], appWebGuidePort, 60_000, false);

if (!noConsole) {
  bootApp('one-ngo-console', 'apps/onengo-console/server', ['scripts/dev.mjs', '--port', String(consolePort)], consolePort);
}

