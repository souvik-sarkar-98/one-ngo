import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const BASELINE_FILE = join(root, 'test/raw-sql-baseline.json');

interface Baseline {
  /** Files whose hand-written SQL stays raw by design, and why; their counts still only go down. */
  raw: Record<string, string>;
  /** Most SQL `.query(` calls each file may make; a file not listed may make none. */
  counts: Record<string, number>;
}

function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

const rel = (p: string) => relative(root, p).split(sep).join('/');
const source = (dir: string, ext = /\.(ts|mts|mjs|js)$/) => files(join(root, dir), ext).map((p) => ({ path: rel(p), src: readFileSync(p, 'utf8') }));

/** Service methods named `query` take a request context first (records.query(ctx, …), approvals.query(contextOf(req), …)); they run no SQL. */
const SERVICE_QUERY = /\b(?:this|records|approvals)\.query\s*\(\s*(?:ctx\b|contextOf\s*\()/g;

function rawQueryCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of source('src', /\.ts$/)) {
    const all = f.src.match(/\.query\s*(<[^()]*>)?\s*\(/g)?.length ?? 0;
    const n = all - (f.src.match(SERVICE_QUERY)?.length ?? 0);
    if (n) counts[f.path] = n;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const readBaseline = (): Baseline => JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline;

describe('Kysely boundaries', () => {
  it('constructs Kysely only in the transaction-bound dialect and the migrator', () => {
    const all = [...source('src'), ...source('test'), ...source('../../scripts'), ...source('../../apps/onengo/server/src'), ...source('../../apps/onengo/web/src')];
    expect(all.length).toBeGreaterThan(100);
    const allowed = new Set(['src/infrastructure/postgres/kysely.ts', 'src/infrastructure/postgres/migrate.ts', 'test/kysely-architecture.test.ts']);
    const bad = all.filter((f) => /new\s+Kysely\b/.test(f.src) && !allowed.has(f.path));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  it('calls queryWithRowCount only from the Kysely dialect, so raw SQL cannot bypass the ratchet', () => {
    const all = [...source('src'), ...source('test'), ...source('../../scripts'), ...source('../../apps/onengo/server/src')];
    // kysely-plans.test.ts forwards Kysely's statements while recording them.
    const allowed = new Set(['src/infrastructure/postgres/kysely.ts', 'test/kysely-plans.test.ts']);
    const bad = all.filter((f) => /\.queryWithRowCount\s*(<[^()]*>)?\s*\(/.test(f.src) && !allowed.has(f.path));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  it('keeps Kysely and the database types out of the web app', () => {
    const web = [
      ...source('../../apps/onengo/web/src'),
      ...source('../../apps/onengo/web', /^[\w.-]+\.(json|ts|mjs|js)$/).filter((f) => !f.path.slice('../../apps/onengo/web/'.length).includes('/')),
    ];
    expect(web.length).toBeGreaterThan(50);
    const bad = web.filter((f) => /['"]kysely(\/[^'"]*)?['"]|infrastructure\/postgres\/(kysely|db-types)/.test(f.src));
    expect(bad.map((f) => f.path)).toEqual([]);
  });
});

describe('raw SQL ratchet', () => {
  it('never adds hand-written .query( calls beyond test/raw-sql-baseline.json', () => {
    const actual = rawQueryCounts();
    const update = process.env.UPDATE_RAW_SQL_BASELINE === '1';
    const bootstrap = update && !existsSync(BASELINE_FILE);
    const baseline: Baseline = bootstrap ? { raw: {}, counts: {} } : readBaseline();

    const rose = Object.entries(actual)
      .filter(([file, n]) => !bootstrap && n > (baseline.counts[file] ?? 0))
      .map(([file, n]) => `${file}: ${baseline.counts[file] ?? 0} -> ${n}`);
    expect(rose, 'New raw SQL on fixed tables goes through typed(tx) (src/infrastructure/postgres/kysely.ts); dynamic SQL needs a reason in "raw".').toEqual([]);

    for (const file of Object.keys(baseline.raw)) expect(existsSync(join(root, file)), `"raw" lists a missing file: ${file}`).toBe(true);
    const unexplained = Object.keys(actual).filter((file) => !baseline.raw[file]);
    expect(unexplained, 'Every file that keeps raw SQL needs a reason in "raw".').toEqual([]);

    const next: Baseline = { raw: baseline.raw, counts: actual };
    if (JSON.stringify(next.counts) !== JSON.stringify(baseline.counts)) {
      if (update) {
        writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
      } else {
        const lowered = Object.entries(baseline.counts)
          .filter(([file, n]) => (actual[file] ?? 0) < n)
          .map(([file, n]) => `${file}: ${n} -> ${actual[file] ?? 0}`);
        expect.fail(
          `Raw SQL went down (${lowered.join(', ')}). Lock it in: set UPDATE_RAW_SQL_BASELINE=1 and run npx vitest run test/kysely-architecture.test.ts, then commit test/raw-sql-baseline.json.`,
        );
      }
    }
  });
});