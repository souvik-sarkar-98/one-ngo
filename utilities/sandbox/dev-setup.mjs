/**
 * Prepares the local database: create it when missing, run migrations, then load seed data.
 * Starts the local PostgreSQL server first when it is not running. This script does not choose ports or start the apps.
 *
 *   npm run dev:setup
 *   npm run dev:setup -- --org demo --org harbour
 *   npm run dev:setup -- --fixture-port 8096
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureLocalPostgres } from './local-postgres.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const seedOrder = ['demo', 'harbour', 'riverbank', 'operator'];
const operatorEmail = 'operator.full@onengo.local';
const cloudVars = ['GAE_SERVICE', 'K_SERVICE', 'GOOGLE_CLOUD_PROJECT', 'FUNCTION_TARGET', 'WEBSITE_SITE_NAME'];
const dbName = /^[a-z_][a-z0-9_]{0,62}$/;
const orgKey = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

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

function parseArgs(argv) {
  const orgs = [];
  let fixturePort = 8095;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--org') {
      const key = argv[++i];
      if (!key || key.startsWith('-')) fail('Use --org <key>.');
      if (!orgKey.test(key) || !seedOrder.includes(key)) fail(`No organisation '${key}' in utilities/seed.`);
      if (!orgs.includes(key)) orgs.push(key);
      continue;
    }
    if (arg === '--fixture-port') {
      fixturePort = portValue(argv[++i], '--fixture-port');
      continue;
    }
    fail(`Unknown option ${arg}. Use --org <key> or --fixture-port <port>.`);
  }
  return { orgs, fixturePort };
}

function databaseTarget(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail('DATABASE_URL in .env is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') fail('DATABASE_URL must be a PostgreSQL connection string.');
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName.test(name)) fail(`The database in DATABASE_URL must be lowercase letters, digits and _ (got '${name}').`);
  if (name === 'postgres') fail('Choose an application database in DATABASE_URL. postgres is the maintenance database.');
  const host = url.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const cloud = cloudVars.filter((name) => process.env[name]);
  if (!local || cloud.length > 0) {
    const where = cloud.length ? ` ${cloud.join(', ')} is set.` : ` The database host is ${host}.`;
    fail(`Seed data is loaded only for local development.${where}`);
  }
  return { name, host, port: url.port || '5432' };
}

function quoteIdent(name) {
  if (!dbName.test(name)) fail(`Unexpected database name '${name}'.`);
  return `"${name}"`;
}

async function ensureDatabase(connectionString, name) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.end();
    return;
  } catch (error) {
    await client.end().catch(() => undefined);
    if (error?.code !== '3D000') {
      const reason = error instanceof Error ? error.message : String(error);
      fail(`Cannot reach PostgreSQL (${reason}). Start PostgreSQL, then run npm run dev:setup again.`);
    }
  }
  const admin = new URL(connectionString);
  admin.pathname = '/postgres';
  const adminClient = new pg.Client({ connectionString: admin.toString() });
  try {
    await adminClient.connect();
    await adminClient.query(`create database ${quoteIdent(name)}`);
  } finally {
    await adminClient.end().catch(() => undefined);
  }
  console.log(`    created database ${name}`);
}

function runMigrations() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'deploy:prepare:dev'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function runSql(connectionString, sql) {
  const client = new pg.Client({ connectionString });
  client.on('notice', (notice) => {
    const text = notice.message?.trim();
    if (text) console.log(`    ${text}`);
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function seedSql(key) {
  const path = join(root, 'utilities', 'seed', `${key}.sql`);
  if (!existsSync(path)) fail(`Missing seed file ${path}.`);
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  if (!/^-- @password\s+\S+\s*$/m.test(source)) fail(`${path} must contain a line '-- @password <password>'.`);
  const label = /^-- @organisation\s+(\S+)\s*$/m.exec(source);
  if (label?.[1] !== key) fail(`${path} must contain '-- @organisation ${key}'.`);
  return source;
}

function operatorSubject(email) {
  return `demo-${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 20)}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnv(join(root, '.env'));
  if (!process.env.DATABASE_URL) fail('Set DATABASE_URL in .env, e.g. DATABASE_URL=postgres://postgres@localhost:5432/ngo');
  try {
    await ensureLocalPostgres({ root, log: (message) => console.log(`==> ${message}`) });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!process.env.DATABASE_OWNER_URL) process.env.DATABASE_OWNER_URL = process.env.DATABASE_URL;
  if (!process.env.DATABASE_SYSTEM_URL) process.env.DATABASE_SYSTEM_URL = process.env.DATABASE_URL;
  const target = databaseTarget(process.env.DATABASE_URL);
  console.log(`==> Checking PostgreSQL at ${target.host}:${target.port}, database ${target.name}`);
  await ensureDatabase(process.env.DATABASE_URL, target.name);
  console.log('==> Preparing the database (migrations, platform package, shipped modules)');
  runMigrations();
  const keys = options.orgs.length ? options.orgs : seedOrder;
  console.log(`==> Onboarding ${keys.join(', ')}`);
  for (const key of keys) await runSql(process.env.DATABASE_URL, seedSql(key));
  const issuer = `https://127.0.0.1:${options.fixturePort}`;
  const subject = operatorSubject(operatorEmail);
  const consoleSeed = readFileSync(join(root, 'utilities', 'seed', 'console-operator.sql'), 'utf8')
    .replaceAll('__ISSUER__', issuer.replaceAll("'", "''"))
    .replaceAll('__SUBJECT__', subject.replaceAll("'", "''"));
  console.log(`==> Linking operator ${operatorEmail}`);
  await runSql(process.env.DATABASE_URL, consoleSeed);
  console.log('');
  console.log('Database is ready.');
  console.log('Start each app in its own terminal:');
  console.log('  npm run dev --workspace @onengo/service-sandbox');
  console.log('  npm run dev --workspace @onengo/server');
  console.log('  npm run dev --workspace @onengo/web');
  console.log('  npm run dev --workspace @onengo-console/server');
  console.log('Defaults: web 4200, API 8080, console 9090, fixture 8095, SMTP 2525.');
  console.log('Pass --port to the API, web app, or console when you need another port.');
  console.log('The sandbox takes --https-port and --smtp-port. Pass the same fixture port to the API and console as --fixture-port.');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
