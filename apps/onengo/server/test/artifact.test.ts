import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SERVER_SCHEMA_MINIMUMS } from '../../../../packages/platform/src/infrastructure/postgres/schema-compatibility.js';
import { dropDatabase, prepareDatabase, withClient } from '../../../../packages/platform/test/test-database.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHELL_HTML = '<!doctype html><title>bundle smoke test</title>';

/** Builds the deployable with workspace packages bundled and third-party packages external. */
function buildBundle(): void {
  if (!process.env.npm_execpath) throw new Error('Run artifact tests through npm.');
  execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build', '--workspace', '@onengo/server'], {
    cwd: join(ROOT, '../../..'),
    stdio: 'pipe',
  });
}

function artifactDigest(directory = join(ROOT, 'dist'), base = directory): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) hash.update(artifactDigest(path, base));
    else {
      const bytes = name === 'ngsw.json'
        ? Buffer.from(JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), timestamp: 0 }))
        : readFileSync(path);
      hash.update(`${path.slice(base.length)}\0`).update(bytes);
    }
  }
  return hash.digest('hex');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
      .once('error', reject)
      .listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
  });
}

/** Runs a bundle to completion with plain node, as `npm run deploy:prepare` does. */
function runToExit(file: string, env: NodeJS.ProcessEnv, args: string[] = []): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ['--enable-source-maps', join('dist', file), ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Runs the production bundles with plain node, as `npm run deploy:prepare` and
 * `npm start` do, against their own throwaway database: the deploy step migrates
 * `public` and publishes the platform and shipped modules, which must not land
 * in the shared test database whose test schemas fall back to `public` on their
 * search path.
 */
describe('production server bundle', () => {
  const databaseUrl = new URL(inject('testDatabaseUrl' as never) as string);
  databaseUrl.pathname = `${databaseUrl.pathname}_bundle_${randomBytes(4).toString('hex')}`;
  let work = '';
  let child: ChildProcess | undefined;
  let output = '';
  let base = '';
  let unprepared = { status: null as number | null, output: '' };
  let deploys: { status: number | null; output: string }[] = [];
  let env: NodeJS.ProcessEnv = {};
  let cleanBuildDigests: string[] = [];
  const roleSuffix = randomBytes(4).toString('hex');
  const systemRole = `bundle_system_${roleSuffix}`;
  const runtimeRole = `bundle_runtime_${roleSuffix}`;
  const rolePassword = randomBytes(24).toString('hex');

  beforeAll(async () => {
    buildBundle();
    cleanBuildDigests = [artifactDigest()];
    buildBundle();
    cleanBuildDigests.push(artifactDigest());
    await prepareDatabase(databaseUrl.toString());
    work = mkdtempSync(join(tmpdir(), 'ngo-bundle-'));
    writeFileSync(join(work, 'index.html'), SHELL_HTML);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    env = {
      ...inherited,
      DATABASE_OWNER_URL: databaseUrl.toString(),
      TOKEN_SECRET: randomBytes(32).toString('hex'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      PORT: String(port),
      PUBLIC_BASE_URL: base,
      WEB_ROOT: work,
      FILE_STORE_DIR: join(work, 'files'),
      BREACHED_PASSWORD_CHECK: 'off',
    };
    const roleUrl = (role: string) => {
      const value = new URL(databaseUrl);
      value.username = role;
      value.password = rolePassword;
      return value.toString();
    };
    await withClient(databaseUrl.toString(), async (client) => {
      await client.query(`create role ${runtimeRole} login password '${rolePassword}'`);
      await client.query(`grant app_runtime to ${runtimeRole}`);
    });
    unprepared = runToExit('server.js', { ...env, DATABASE_SYSTEM_URL: databaseUrl.toString(), DATABASE_RUNTIME_URL: roleUrl(runtimeRole) });
    deploys = [runToExit('deploy.js', env), runToExit('deploy.js', env)];
    if (deploys.some((d) => d.status !== 0)) throw new Error(`The deploy step failed:\n${deploys.map((d) => d.output).join('\n')}`);
    await withClient(databaseUrl.toString(), async (client) => {
      await client.query(`create role ${systemRole} login password '${rolePassword}'`);
      await client.query(`grant ngo_main_system to ${systemRole}`);
      await client.query(`grant ngo_main_runtime to ${runtimeRole}`);
    });
    env.DATABASE_SYSTEM_URL = roleUrl(systemRole);
    env.DATABASE_RUNTIME_URL = roleUrl(runtimeRole);

    child = spawn(process.execPath, ['--enable-source-maps', join('dist', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20_000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);

    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`The bundle exited with code ${child.exitCode}:\n${output}`);
      if (Date.now() > deadline) throw new Error(`The bundle did not answer within 60 s:\n${output}`);
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 360_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await withClient(databaseUrl.toString(), async (client) => {
      await client.query(`drop role if exists ${systemRole}`);
      await client.query(`drop role if exists ${runtimeRole}`);
    }).catch(() => undefined);
    await dropDatabase(databaseUrl.toString());
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('refuses to start on a database the deploy step has not prepared', () => {
    expect(unprepared.status).toBe(1);
    expect(unprepared.output).toMatch(/"message":"Start-up failed"/);
    expect(unprepared.output).toMatch(new RegExp(`schema level 0 is below the minimum ${SERVER_SCHEMA_MINIMUMS.main} .*Run the deploy step`));
    expect(unprepared.output).not.toMatch(/"message":"listening"/);
  });

  it('creates the same complete artifact from two clean builds', () => {
    expect(cleanBuildDigests[1]).toBe(cleanBuildDigests[0]);
    expect(readFileSync(join(ROOT, 'dist/web/index.html'), 'utf8')).toMatch(/<app-root/);
    expect(JSON.parse(readFileSync(join(ROOT, 'dist/package.json'), 'utf8')).name).toBe('@onengo/server-artifact');
  });

  it('refuses an unsupported database in the server and the deploy step, printing only the scheme', () => {
    const mysql = runToExit('deploy.js', { ...env, DATABASE_OWNER_URL: 'mysql://root:hunter2@127.0.0.1/ngo', INSTALLATION_MODE: 'shared' });
    expect(mysql.status).toBe(1);
    expect(mysql.output).toMatch(/"message":"Start-up failed","[^\n]*"scheme":"mysql"/);
    expect(mysql.output).toContain('Unsupported combination: MySQL supports one-NGO installations only. Use PostgreSQL 15 or later for INSTALLATION_MODE=shared.');
    const other = runToExit('server.js', { ...env, DATABASE_SYSTEM_URL: 'mariadb://root:hunter2@127.0.0.1/ngo' });
    expect(other.status).toBe(1);
    expect(other.output).toContain('Unsupported database: DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://).');
    for (const run of [mysql, other]) expect(run.output).not.toMatch(/hunter2|127\.0\.0\.1/);
  });

  it('runs the deploy step, and a second run finds nothing to do', () => {
    expect(deploys[0]!.output).toMatch(/"message":"deployment prepared","[^\n]*"migrations":"001_core\.sql, /);
    expect(deploys[0]!.output).toMatch(/"modules":"donations@/);
    expect(deploys[1]!.output).toMatch(/"message":"deployment prepared","[^\n]*"migrations":"none"/);
  });

  it('starts, says it is listening, and reports healthy', async () => {
    expect(output).toMatch(/"message":"listening"/);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('refuses an unsigned request to the API', async () => {
    const res = await fetch(`${base}/api/people/me`);
    expect(res.status).toBe(403);
  });

  it('serves the web app shell from WEB_ROOT', async () => {
    const res = await fetch(`${base}/sign-in`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SHELL_HTML);
  });

  it('queues the sensitive field re-encryption only with the deploy step option, printing counts only', () => {
    const run = runToExit('deploy.js', env, ['--reencrypt-sensitive-fields']);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/"message":"sensitive field re-encryption queued","[^\n]*"organisations":0,"recordTypes":0/);
    expect(run.output).not.toContain(env.ENCRYPTION_KEY!);
    expect(deploys.map((d) => d.output).join('\n')).not.toMatch(/re-encryption queued/);
    const typo = runToExit('deploy.js', env, ['--reencrypt']);
    expect(typo.status).toBe(1);
    expect(typo.output).toContain('Unknown deploy step option: --reencrypt.');
  }, 120_000);

  it('loads the script sandbox WebAssembly under plain node from the package root', () => {
    const script = `const { getQuickJS } = await import('quickjs-emscripten'); process.stdout.write(String((await getQuickJS()).evalCode('6 * 7')));`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' })).toBe('42');
  });

  it('bundles the script worker beside the server and runs a script in it under plain node', () => {
    const script = [
      `import { pathToFileURL } from 'node:url';`,
      `import { Worker } from 'node:worker_threads';`,
      `const w = new Worker(pathToFileURL('dist/sandbox-worker.js'), { execArgv: [], workerData: { harness: 'String(6 * 7)', maxOutputBytes: 100 } });`,
      `w.on('message', (m) => { if (m.ready) w.postMessage({ id: 1, payload: '{}', code: '', timeoutMs: 100, memoryMb: 4 }); else { process.stdout.write(m.raw); void w.terminate(); } });`,
    ].join('\n');
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' })).toBe('42');
  });
});
