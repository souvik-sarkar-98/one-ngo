/**
 * Starts the local PostgreSQL server when nothing is listening on the DATABASE_URL port.
 * Used by `npm run dev` and `npm run dev:setup`. It never stops PostgreSQL.
 *
 * Settings come from the environment, then .env:
 *   PG_BIN   folder with pg_ctl   (default %LOCALAPPDATA%\postgres\pgsql\bin)
 *   PGDATA   data folder          (default %LOCALAPPDATA%\postgres\data)
 *
 * Only local databases are started: DATABASE_URL must point at localhost, 127.0.0.1 or ::1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const exe = process.platform === 'win32' ? '.exe' : '';

function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    let value = trimmed.slice(index + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values[trimmed.slice(0, index).trim()] = value;
  }
  return values;
}

function setting(name, fileValues) {
  return process.env[name]?.trim() || fileValues[name]?.trim() || '';
}

function isListening(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(2000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function defaultPostgresFolder() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'postgres');
}

/**
 * Throws when PostgreSQL is needed but cannot be started. Returns once the
 * database port answers, or straight away when the database is not local.
 */
export async function ensureLocalPostgres({ root, log = console.log }) {
  const fileValues = readEnvFile(join(root, '.env'));
  const url = setting('DATABASE_URL', fileValues);
  if (!url) return;
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) return;
  if (!url.includes('localhost') && !url.includes('127.0.0.1')) return; // Not a local database.

  let target;
  try {
    target = new URL(url);
  } catch {
    return; // The caller reports an invalid DATABASE_URL with its own message.
  }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || 5432);
  if (!localHosts.has(host)) return;
  if (await isListening(host, port)) return;

  const base = defaultPostgresFolder();
  const bin = setting('PG_BIN', fileValues) || join(base, 'pgsql', 'bin');
  const data = setting('PGDATA', fileValues) || join(base, 'data');
  const pgCtl = join(bin, `pg_ctl${exe}`);
  const logFile = join(dirname(data), 'logfile');

  if (!existsSync(pgCtl)) {
    throw new Error(
      `PostgreSQL is not listening on ${host}:${port}, and pg_ctl was not found at ${pgCtl}. ` +
        'Start PostgreSQL yourself, or set PG_BIN in .env to the folder that contains pg_ctl.',
    );
  }
  if (!existsSync(data)) {
    throw new Error(`PostgreSQL data folder not found at ${data}. Set PGDATA in .env to the cluster folder.`);
  }

  log(`PostgreSQL is not listening on ${host}:${port}. Starting it from ${bin}`);
  // Output goes to the log file, not the terminal, so the shell does not wait on the server.
  spawnSync(pgCtl, ['start', '-w', '-t', '60', '-D', data, '-l', logFile], {
    stdio: 'ignore',
    windowsHide: true,
  });

  if (!(await isListening(host, port))) {
    throw new Error(`PostgreSQL did not start on ${host}:${port}. See ${logFile}.`);
  }
  log(`PostgreSQL is listening on ${host}:${port}.`);
}
