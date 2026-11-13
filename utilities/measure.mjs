/**
 * Local measurements. Run through npm.
 *
 *   npm run measure                              # web, db, footprint, bundle
 *   npm run measure -- web db                    # one or more of those names
 *   npm run measure -- db --schema ngo --top 30
 *
 * web builds both web apps, then checks gzip size. The main web app fails above 90 kB gzip.
 * db is a read-only size, bloat, and unused-index report for DATABASE_URL.
 * footprint and bundle time startup, memory, and save latency. Database memory
 * is in PostgreSQL, not in those figures.
 * SAVES (default 200) applies to footprint and bundle.
 * RUNS (default 3) and CONCURRENT_SAVES (default 50) apply to bundle.
 *
 * Index scan counts start at zero after a statistics reset or a restore and
 * only mean something after real traffic. Treat "unused" as a lead to check,
 * not as a list to drop: an index may back a constraint or a rare report.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

let pg;
let databaseUrl;
let prepareDeployment;
let buildServer;
let createPlatform;
let PATHS;
let asTx;
let loadModulePackage;
let PgDatabase;
let provisionTenant;
let SchemaRegistry;
let dropDatabase;
let prepareDatabase;
let testDatabaseUrl;
let withClient;

async function loadDb() {
  pg ??= (await import('pg')).default;
  ({ databaseUrl } = await import('@onengo/platform/testing'));
}

async function loadFootprint() {
  await loadDb();
  ({ prepareDeployment } = await import('@onengo/platform/deployment'));
  ({ buildServer } = await import('@onengo/server/http/server.js'));
  ({ createPlatform } = await import('@onengo/platform/main'));
  ({ asTx, PgDatabase, provisionTenant } = await import('@onengo/platform/testing'));
}

async function loadBundle() {
  ({ createPlatform, PATHS } = await import('@onengo/platform/main'));
  ({ asTx, loadModulePackage, PgDatabase, provisionTenant, SchemaRegistry } = await import('@onengo/platform/testing'));
  ({ dropDatabase, prepareDatabase, testDatabaseUrl, withClient } = await import('../packages/platform/test/test-database.js'));
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ROOT = join(ROOT, 'apps', 'onengo', 'server');
const TASKS = ['web', 'db', 'footprint', 'bundle'];
const MAIN_LIMIT = 90 * 1024;
const RUNS = Number(process.env.RUNS ?? 3);
const SAVES = Number(process.env.SAVES ?? 200);
const CONCURRENT_SAVES = Number(process.env.CONCURRENT_SAVES ?? 50);
const TENANT = 'measure';
const EMAIL = 'admin@measure.local';

const HELP = `Local measurements. Run through npm.

  npm run measure                              web, then db, footprint, and bundle
  npm run measure -- web db                    one or more of: ${TASKS.join(', ')}
  npm run measure -- db --schema ngo --top 30

web builds both web apps, then checks gzip size. The main web app fails above 90 kB gzip.
db is a read-only size, bloat, and unused-index report for DATABASE_URL.
footprint and bundle time startup, memory, and save latency on a throwaway database.
SAVES (default 200) applies to footprint and bundle.
RUNS (default 3) and CONCURRENT_SAVES (default 50) apply to bundle.
`;

/** Answers 'rss' over the IPC channel; unref'd so it never keeps the server alive. */
const RSS_PRELOAD = `data:text/javascript,${encodeURIComponent(
  "if (process.send) { process.on('message', (m) => { if (m === 'rss') process.send({ rss: process.memoryUsage.rss() }); }); process.channel?.unref(); }",
)}`;

const mb = (bytes) => Math.round((Number(bytes) / 1024 / 1024) * 10) / 10;
const kb = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const selected = [];
  let schema = 'public';
  let top = 15;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--schema' || arg === '--top') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      i += 1;
      if (arg === '--schema') schema = value;
      else top = Math.max(1, Number(value) || 15);
      continue;
    }
    const name = arg.startsWith('--') ? arg.slice(2) : arg;
    if (TASKS.includes(name)) {
      if (!selected.includes(name)) selected.push(name);
      continue;
    }
    throw new Error(`Unknown argument '${arg}'. Tasks: ${TASKS.join(', ')}.`);
  }
  return { tasks: selected.length ? selected : [...TASKS], schema, top };
}

function runNpm(script) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run measure through npm (npm run measure).');
  execFileSync(process.execPath, [npmCli, 'run', script], { cwd: ROOT, stdio: 'inherit' });
}

function assetsFromIndex(directory) {
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+\.(?:js|css))"[^>]*>/g)].map((match) =>
    match[1].replace(/^\.?\//, ''),
  );
  return { html, references: [...new Set(references)] };
}

function measureWebApp(name, directory) {
  const { html, references } = assetsFromIndex(directory);
  const files = references.map((reference) => {
    const bytes = readFileSync(join(directory, reference));
    return { file: basename(reference), kind: reference.endsWith('.css') ? 'css' : 'js', raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  });
  const total = (kind, field) => files.filter((file) => file.kind === kind).reduce((sum, file) => sum + file[field], 0);
  const result = {
    name,
    js: { raw: total('js', 'raw'), gzip: total('js', 'gzip') },
    css: { raw: total('css', 'raw'), gzip: total('css', 'gzip') },
    html: { raw: Buffer.byteLength(html), gzip: gzipSync(html, { level: 9 }).length },
    files,
  };
  result.initial = { raw: result.js.raw + result.css.raw, gzip: result.js.gzip + result.css.gzip };
  return result;
}

function measureWeb() {
  runNpm('web:build');
  runNpm('operator:web:build');
  const results = [
    measureWebApp('main-web', join(ROOT, 'apps/onengo/web/dist/web/browser')),
    measureWebApp('operator-web', join(ROOT, 'apps/onengo-console/web/dist/operator/browser')),
  ];
  for (const result of results) {
    console.log(`${result.name}: initial ${kb(result.initial.gzip)} gzip (${kb(result.js.gzip)} JS, ${kb(result.css.gzip)} CSS); raw ${kb(result.initial.raw)}.`);
    for (const file of result.files) console.log(`  ${file.kind.toUpperCase()} ${file.file}: ${kb(file.gzip)} gzip / ${kb(file.raw)} raw`);
  }
  if (results[0].initial.gzip > MAIN_LIMIT) {
    throw new Error(`main-web initial JS/CSS is ${kb(results[0].initial.gzip)} gzip; approved limit is ${kb(MAIN_LIMIT)}.`);
  }
  console.log(`main-web budget: PASS (${kb(results[0].initial.gzip)} / ${kb(MAIN_LIMIT)} gzip). Operator-web is reported separately.`);
}

// Tables that hold short-lived or fast-growing rows: the first places to look for pruning.
const WATCH = [
  'audit_event', 'outbox_event', 'idempotency_key', 'rate_limit', 'auth_throttle', 'email_code', 'oidc_login',
  'refresh_token', 'password_token', 'job_item', 'script_run', 'connector_delivery', 'payment_event',
  'operator_login_state', 'operator_session', 'platform_audit',
];

async function measureDb(schema, top) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid schema name '${schema}'.`);
  await loadDb();
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query('set default_transaction_read_only = on');
    const q = async (text, values = []) => (await client.query(text, values)).rows;
    const [db] = await q(`select pg_database_size(current_database())::text as size, current_setting('server_version') as version`);
    console.log(`\nDatabase ${new URL(databaseUrl()).pathname.slice(1)} (PostgreSQL ${db.version}), schema "${schema}": ${mb(db.size)} MB in total\n`);

    const tables = await q(
      `select c.relname as name,
              pg_total_relation_size(c.oid)::text as total,
              pg_relation_size(c.oid)::text as heap,
              pg_indexes_size(c.oid)::text as indexes,
              coalesce(pg_total_relation_size(c.reltoastrelid), 0)::text as toast,
              coalesce(s.n_live_tup, 0)::text as live,
              coalesce(s.n_dead_tup, 0)::text as dead,
              coalesce(s.last_autovacuum, s.last_vacuum)::text as vacuumed
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_stat_user_tables s on s.relid = c.oid
        where n.nspname = $1 and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc`,
      [schema],
    );
    if (tables.length === 0) {
      console.log(`No tables found in schema "${schema}". Pass --schema <name> if the application runs in another schema.`);
      return;
    }
    const sum = (pick) => tables.reduce((n, table) => n + Number(pick(table)), 0);
    console.log(
      `Tables ${tables.length}: heap ${mb(sum((table) => table.heap))} MB, indexes ${mb(sum((table) => table.indexes))} MB, ` +
        `out-of-line (TOAST) ${mb(sum((table) => table.toast))} MB (included in the table totals)\n`,
    );

    console.log('Largest tables (MB; index share shows write cost; dead % shows bloat risk)');
    console.table(
      tables.slice(0, top).map((table) => ({
        table: table.name,
        totalMB: mb(table.total),
        heapMB: mb(table.heap),
        indexMB: mb(table.indexes),
        toastMB: mb(table.toast),
        rows: Number(table.live),
        deadPct: Number(table.live) + Number(table.dead) === 0 ? 0 : Math.round((Number(table.dead) / (Number(table.live) + Number(table.dead))) * 100),
        lastVacuum: table.vacuumed ? table.vacuumed.slice(0, 16) : 'never',
      })),
    );

    const byName = new Map(tables.map((table) => [table.name, table]));
    console.log('Short-lived and fast-growing tables (candidates for scheduled pruning)');
    console.table(
      WATCH.filter((name) => byName.has(name)).map((name) => {
        const table = byName.get(name);
        return { table: name, totalMB: mb(table.total), rows: Number(table.live), deadRows: Number(table.dead) };
      }),
    );

    const indexes = await q(
      `select s.relname as table, s.indexrelname as index,
              pg_relation_size(s.indexrelid)::text as size,
              s.idx_scan::text as scans,
              case when i.indisprimary then 'primary key'
                   when i.indisunique then 'unique'
                   when exists (select 1 from pg_constraint k where k.conindid = s.indexrelid) then 'constraint'
                   else 'plain' end as kind,
              pg_get_indexdef(s.indexrelid) as definition
         from pg_stat_user_indexes s
         join pg_index i on i.indexrelid = s.indexrelid
        where s.schemaname = $1
        order by pg_relation_size(s.indexrelid) desc`,
      [schema],
    );
    console.log('Largest indexes');
    console.table(indexes.slice(0, top).map((index) => ({ table: index.table, index: index.index, sizeMB: mb(index.size), scans: Number(index.scans), kind: index.kind })));

    const unused = indexes.filter((index) => Number(index.scans) === 0 && index.kind === 'plain');
    console.log(
      `Plain indexes never scanned since the last statistics reset: ${unused.length}, ${mb(unused.reduce((n, index) => n + Number(index.size), 0))} MB ` +
        '(unique and constraint-backed indexes are excluded)',
    );
    console.table(
      unused.slice(0, top).map((index) => ({
        table: index.table,
        index: index.index,
        sizeMB: mb(index.size),
        definition: index.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, ''),
      })),
    );

    const [stats] = await q(`select stats_reset::text as since from pg_stat_database where datname = current_database()`);
    console.log(`Statistics counted since: ${stats?.since ? stats.since.slice(0, 16) : 'the server started (never reset)'}.`);
    console.log('Short observation windows make "unused" misleading; re-run after a full business cycle (month end, receipts, reports).\n');
  } finally {
    await client.end();
  }
}

async function measureFootprint() {
  await loadFootprint();
  const url = databaseUrl();
  const schema = `footprint_${randomBytes(4).toString('hex')}`;
  const owner = new pg.Client({ connectionString: url });
  await owner.connect();
  let db;
  let app;
  try {
    await owner.query(`create schema ${schema}`);
    db = await PgDatabase.connect({ connectionString: url, schema });
    const [pkg] = (await prepareDeployment(db, { shippedModules: ['donations'] })).modules;
    const started = performance.now();
    const platform = await createPlatform(db, { tokenSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32) });
    const tenantId = await provisionTenant(db, { key: 'spike', name: 'Spike NGO' });
    const admin = { id: 'admin', roles: ['admin'], permissions: ['*'] };
    await platform.definitions.enableModule({ tenantId, actor: admin }, pkg.manifest);
    const today = new Date().toISOString().slice(0, 10);
    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4));
    const fyStart = month >= 4 ? year : year - 1;
    await db.withTenant(tenantId, (tx) => platform.ledger.openFiscalYear(asTx(tx), admin, `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`));
    await platform.definitions.saveDraft({ tenantId, actor: admin }, 'script', {
      key: 'tidy',
      recordType: 'donation',
      hook: 'beforeSave',
      code: 'ctx.record.donorName = ctx.record.donorName.trim();',
    });
    await platform.definitions.publish({ tenantId, actor: admin }, 'script', 'tidy');
    await platform.identity.upsertRole({ tenantId, actor: admin }, { key: 'admin', label: 'Administrator', permissions: ['*'] });
    const email = 'admin@spike.local';
    const password = randomBytes(18).toString('base64url');
    const userId = await platform.identity.addMember({ tenantId, actor: admin }, { email, displayName: 'Spike Admin', roles: ['admin'] });
    await platform.identity.setPassword(userId, password);

    // Each save is two API calls; the per-minute API limit would otherwise stop the burst.
    app = buildServer(platform, { rateLimits: { api: 2 * SAVES + 100 } });
    await app.ready();
    const startupMs = Math.round(performance.now() - started);
    const afterStart = process.memoryUsage();

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'spike', email, password } });
    if (login.statusCode !== 200) throw new Error(`sign-in failed: ${login.body}`);
    const { accessToken } = login.json();
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
    const latencies = [];
    for (let i = 0; i < SAVES; i++) {
      const saveStarted = performance.now();
      const created = await app.inject({
        method: 'POST',
        url: '/api/records/donation',
        headers,
        payload: { donorName: ` Donor ${i} `, amount: 100 + i },
      });
      if (created.statusCode !== 201) throw new Error(`create failed: ${created.body}`);
      const { record } = created.json();
      const paid = await app.inject({
        method: 'POST',
        url: `/api/records/donation/${record.id}/transitions/markPaid`,
        headers,
        payload: { expectedVersion: 1, data: { method: 'cash', paidOn: today } },
      });
      if (paid.statusCode !== 200) throw new Error(`markPaid failed: ${paid.body}`);
      latencies.push(performance.now() - saveStarted);
    }
    latencies.sort((a, b) => a - b);
    const afterLoad = process.memoryUsage();
    console.log(
      JSON.stringify(
        {
          startupMs,
          rssAfterStartMb: mb(afterStart.rss),
          rssAfterLoadMb: mb(afterLoad.rss),
          heapUsedAfterLoadMb: mb(afterLoad.heapUsed),
          saves: SAVES,
          createPlusPayP50Ms: Math.round(latencies[Math.floor(SAVES * 0.5)]),
          createPlusPayP95Ms: Math.round(latencies[Math.floor(SAVES * 0.95)]),
          note: 'Server process only; PostgreSQL memory is not included.',
        },
        null,
        2,
      ),
    );
    // Requests start background dispatch and index builds; let them finish before the pool closes.
    await platform.dispatcher.runOnce();
    await platform.jobs.runOnce();
  } finally {
    await app?.close().catch(() => undefined);
    await db?.close().catch(() => undefined);
    await owner.query(`drop schema if exists ${schema} cascade`).catch((error) => console.error(error));
    await owner.end().catch(() => undefined);
  }
}

/**
 * HTTP client that moves to the next loopback source address (127.0.0.2, .3, …)
 * every 250 API requests: the server allows 300 API requests per minute per
 * client address, and a save burst needs more.
 */
class Client {
  constructor(port) {
    this.port = port;
    this.agent = new Agent({ keepAlive: true, maxSockets: 8 });
    this.address = 1;
    this.used = 0;
    this.token = '';
  }

  call(method, path, body) {
    if (++this.used > 250) {
      this.address += 1;
      this.used = 1;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: this.port, method, path, headers, agent: this.agent, localAddress: `127.0.0.${this.address + 1}` },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const ms = performance.now() - started;
            const text = Buffer.concat(chunks).toString();
            let json = text;
            try {
              json = JSON.parse(text);
            } catch {
              // not JSON; keep the text for error messages
            }
            resolve({ status: res.statusCode ?? 0, json, ms });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  close() {
    this.agent.destroy();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
      .once('error', reject)
      .listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
  });
}

function localDatabaseUrl() {
  const url = new URL(testDatabaseUrl());
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`bundle runs against local PostgreSQL only (got host ${url.hostname}).`);
  }
  url.pathname = `${url.pathname}_measure_${randomBytes(4).toString('hex')}`;
  return url;
}

function sampleRss(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error('The server did not report its memory within 10 s.'));
    }, 10_000);
    const onMessage = (message) => {
      if (typeof message?.rss !== 'number') return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message.rss);
    };
    child.on('message', onMessage);
    child.send('rss');
  });
}

/** Samples the child's resident memory every 20 ms until stopped; returns the peak. */
function rssSampler(child) {
  let running = true;
  let peak = 0;
  const loop = (async () => {
    while (running) {
      peak = Math.max(peak, await sampleRss(child));
      await sleep(20);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return peak;
    },
  };
}

/** Organisation, admin with a password, donations enabled, an open fiscal year and a published before-save script. */
async function seed(url, keys, password) {
  const db = await PgDatabase.connect({ connectionString: url, maxConnections: 2 });
  try {
    const platform = await createPlatform(db, keys);
    const tenantId = await provisionTenant(db, { key: TENANT, name: 'Measure NGO' });
    const admin = { id: 'admin', roles: ['admin'], permissions: ['*'] };
    const pkg = await loadModulePackage(join(PATHS.modules, 'donations'), new SchemaRegistry(PATHS.schemas));
    await platform.definitions.enableModule({ tenantId, actor: admin }, pkg.manifest);
    const today = new Date().toISOString().slice(0, 10);
    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4));
    const fyStart = month >= 4 ? year : year - 1;
    await db.withTenant(tenantId, (tx) => platform.ledger.openFiscalYear(asTx(tx), admin, `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`));
    await platform.definitions.saveDraft({ tenantId, actor: admin }, 'script', {
      key: 'tidy',
      recordType: 'donation',
      hook: 'beforeSave',
      code: 'ctx.record.donorName = ctx.record.donorName.trim();',
    });
    await platform.definitions.publish({ tenantId, actor: admin }, 'script', 'tidy');
    await platform.identity.upsertRole({ tenantId, actor: admin }, { key: 'admin', label: 'Administrator', permissions: ['*'] });
    const userId = await platform.identity.addMember({ tenantId, actor: admin }, { email: EMAIL, displayName: 'Measure Admin', roles: ['admin'] });
    await platform.identity.setPassword(userId, password);
    await platform.dispatcher.runOnce();
    await platform.jobs.runOnce();
  } finally {
    await db.close();
  }
}

async function createAndPay(client, i, today) {
  const created = await client.call('POST', '/api/records/donation', { donorName: ` Donor ${i} `, amount: 100 + i });
  if (created.status !== 201) throw new Error(`create failed (${created.status}): ${JSON.stringify(created.json)}`);
  const id = created.json.record.id;
  const paid = await client.call('POST', `/api/records/donation/${id}/transitions/markPaid`, {
    expectedVersion: 1,
    data: { method: 'cash', paidOn: today },
  });
  if (paid.status !== 200) throw new Error(`markPaid failed (${paid.status}): ${JSON.stringify(paid.json)}`);
  return { create: created.ms, pay: paid.ms };
}

let live = {};

async function cleanup() {
  const { child, databaseUrl: url, roles, work, client } = live;
  live = {};
  client?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, sleep(10_000)]);
  }
  if (url && roles?.length) {
    await withClient(url, async (db) => {
      for (const role of roles) await db.query(`drop role if exists ${role}`);
    }).catch(() => undefined);
  }
  if (url) await dropDatabase(url);
  if (work) rmSync(work, { recursive: true, force: true });
}

async function measureOnce(run) {
  const url = localDatabaseUrl().toString();
  live.databaseUrl = url;
  await prepareDatabase(url);
  const work = mkdtempSync(join(tmpdir(), 'ngo-measure-'));
  live.work = work;
  const port = await freePort();
  const keys = { tokenSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32) };
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const env = {
    ...inherited,
    DATABASE_OWNER_URL: url,
    SHIPPED_MODULES: 'donations',
    TOKEN_SECRET: keys.tokenSecret,
    ENCRYPTION_KEY: keys.encryptionKey.toString('base64'),
    PORT: String(port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    WEB_ROOT: work,
    FILE_STORE_DIR: join(work, 'files'),
    BREACHED_PASSWORD_CHECK: 'off',
  };

  const deployStarted = performance.now();
  const deploy = spawnSync(process.execPath, ['--enable-source-maps', join('dist', 'deploy.js')], { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 120_000 });
  if (deploy.status !== 0) throw new Error(`The deploy step failed:\n${deploy.stdout}${deploy.stderr}`);
  const deployMs = performance.now() - deployStarted;
  const suffix = randomBytes(4).toString('hex');
  const systemRole = `measure_system_${suffix}`;
  const runtimeRole = `measure_runtime_${suffix}`;
  const rolePassword = randomBytes(24).toString('hex');
  await withClient(url, async (db) => {
    await db.query(`create role ${systemRole} login password '${rolePassword}'`);
    await db.query(`create role ${runtimeRole} login password '${rolePassword}'`);
    await db.query(`grant ngo_main_system to ${systemRole}`);
    await db.query(`grant ngo_main_runtime to ${runtimeRole}`);
  });
  live.roles = [systemRole, runtimeRole];
  const roleUrl = (role) => {
    const value = new URL(url);
    value.username = role;
    value.password = rolePassword;
    return value.toString();
  };
  env.DATABASE_SYSTEM_URL = roleUrl(systemRole);
  env.DATABASE_RUNTIME_URL = roleUrl(runtimeRole);
  const password = randomBytes(18).toString('base64url');
  await seed(url, keys, password);

  let output = '';
  const spawned = performance.now();
  const child = spawn(process.execPath, ['--enable-source-maps', `--import=${RSS_PRELOAD}`, join('dist', 'server.js')], {
    cwd: SERVER_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  live.child = child;
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The bundle exited with code ${child.exitCode}:\n${output}`);
    if (Date.now() > deadline) throw new Error(`The bundle did not answer within 60 s:\n${output}`);
    if (await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false)) break;
    await sleep(10);
  }
  const healthMs = performance.now() - spawned;
  const client = new Client(port);
  live.client = client;
  const login = await client.call('POST', '/api/auth/login', { tenant: TENANT, email: EMAIL, password });
  if (login.status !== 200) throw new Error(`sign-in failed (${login.status}): ${JSON.stringify(login.json)}\n${output}`);
  client.token = login.json.accessToken;
  const me = await client.call('GET', '/api/people/me');
  if (me.status !== 200) throw new Error(`/api/people/me failed (${me.status}): ${JSON.stringify(me.json)}`);
  const firstApiMs = performance.now() - spawned;

  await sleep(2_000);
  const rssIdle = await sampleRss(child);
  const overall = rssSampler(child);
  const today = new Date().toISOString().slice(0, 10);

  const creates = [];
  const pays = [];
  for (let i = 0; i < SAVES; i++) {
    const timings = await createAndPay(client, i, today);
    creates.push(timings.create);
    pays.push(timings.pay);
  }

  const concurrent = rssSampler(child);
  await Promise.all(
    [0, 1].map(async (stream) => {
      for (let i = 0; i < CONCURRENT_SAVES; i++) await createAndPay(client, SAVES + stream * CONCURRENT_SAVES + i, today);
    }),
  );
  const rssConcurrentPeak = await concurrent.stop();
  const rssPeak = Math.max(await overall.stop(), rssConcurrentPeak);

  creates.sort((a, b) => a - b);
  pays.sort((a, b) => a - b);
  const result = {
    deployMs: Math.round(deployMs),
    healthMs: Math.round(healthMs),
    firstApiMs: Math.round(firstApiMs),
    rssIdleMb: mb(rssIdle),
    rssConcurrentPeakMb: mb(rssConcurrentPeak),
    rssPeakMb: mb(rssPeak),
    createP50Ms: Math.round(percentile(creates, 0.5)),
    createP95Ms: Math.round(percentile(creates, 0.95)),
    payP50Ms: Math.round(percentile(pays, 0.5)),
    payP95Ms: Math.round(percentile(pays, 0.95)),
  };
  console.log(`run ${run}: ${JSON.stringify(result)}`);
  return result;
}

function summarise(results) {
  const rows = [
    ['Deploy step (ms)', 'deployMs', '-'],
    ['Spawn to first /health (ms)', 'healthMs', '-'],
    ['Spawn to first signed-in API response (ms)', 'firstApiMs', '< 4000'],
    ['RSS idle (MB)', 'rssIdleMb', '-'],
    ['RSS peak, 2 concurrent script saves (MB)', 'rssConcurrentPeakMb', '< 250'],
    ['RSS peak, whole run (MB)', 'rssPeakMb', '-'],
    ['Create save p50 (ms)', 'createP50Ms', '-'],
    ['Create save p95 (ms)', 'createP95Ms', '< 500'],
    ['Pay transition p50 (ms)', 'payP50Ms', '-'],
    ['Pay transition p95 (ms)', 'payP95Ms', '< 500'],
  ];
  const lines = [
    `| Metric | Budget | Median | Min-max (${results.length} runs) |`,
    '| --- | --- | --- | --- |',
    ...rows.map(([label, key, budget]) => {
      const values = results.map((result) => result[key]).sort((a, b) => a - b);
      const median = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
      return `| ${label} | ${budget} | ${median} | ${values[0]}-${values[values.length - 1]} |`;
    }),
  ];
  console.log(`\nBundled build, local PostgreSQL, ${SAVES} sequential create-and-pay saves, 2 x ${CONCURRENT_SAVES} concurrent; server process only.\n`);
  console.log(lines.join('\n'));
}

async function measureBundle() {
  await loadBundle();
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  try {
    runNpm('build:server');
    const results = [];
    for (let run = 1; run <= RUNS; run++) {
      try {
        results.push(await measureOnce(run));
      } finally {
        await cleanup();
      }
    }
    summarise(results);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const runners = {
  web: () => measureWeb(),
  db: (schema, top) => measureDb(schema, top),
  footprint: () => measureFootprint(),
  bundle: () => measureBundle(),
};

try {
  const { tasks, schema, top } = parseArgs(process.argv);
  for (const task of tasks) {
    if (tasks.length > 1) console.log(`\n--- ${task} ---\n`);
    await runners[task](schema, top);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
