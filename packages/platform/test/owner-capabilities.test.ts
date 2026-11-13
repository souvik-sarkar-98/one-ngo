import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const ALLOWLIST_FILE = join(root, 'test/owner-capabilities-allowlist.json');

/** Owner transactions and owner statements; only infrastructure opens them, and hands services named capabilities instead. */
const OWNER_CALL = /\.asSystem\s*\(|\bdb\.exec\s*\(/g;

interface Source {
  path: string;
  src: string;
}

interface Entry {
  /** Most owner calls the file may still make. */
  calls: number;
  reason: string;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : f.endsWith('.ts') ? [p] : [];
  });
}

const sources = (): Source[] => files(join(root, 'src')).map((p) => ({ path: relative(root, p).split(sep).join('/'), src: readFileSync(p, 'utf8') }));

/** Owner calls per file outside src/infrastructure/. */
function ownerCalls(all: Source[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of all) {
    if (f.path.startsWith('src/infrastructure/')) continue;
    const n = f.src.match(OWNER_CALL)?.length ?? 0;
    if (n) counts[f.path] = n;
  }
  return counts;
}

const readAllowlist = (): Record<string, Entry> => JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) as Record<string, Entry>;

describe('owner capabilities', () => {
  it('opens owner transactions only in src/infrastructure/, except the shrinking test/owner-capabilities-allowlist.json', () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(80);
    const allowlist = readAllowlist();
    const found = ownerCalls(all);

    const rose = Object.entries(found)
      .filter(([file, n]) => n > (allowlist[file]?.calls ?? 0))
      .map(([file, n]) => `${file}: ${allowlist[file]?.calls ?? 0} -> ${n}`);
    expect(rose, 'Use a capability from ownerCapabilities (src/infrastructure/postgres/tenant-directory.ts), or add a narrow store under src/infrastructure/postgres/stores/owner.').toEqual([]);

    const fell = Object.entries(allowlist)
      .filter(([file, e]) => (found[file] ?? 0) < e.calls)
      .map(([file, e]) => `${file}: ${e.calls} -> ${found[file] ?? 0}`);
    expect(fell, 'Fewer owner calls: lower or remove these in test/owner-capabilities-allowlist.json.').toEqual([]);

    expect(Object.entries(allowlist).filter(([, e]) => e.reason.trim().length < 20).map(([file]) => file), 'Every allowlist entry needs a reason.').toEqual([]);
  });

  it('flags owner calls outside infrastructure only', () => {
    const fake = (path: string, src: string): Source => ({ path, src });
    expect(
      ownerCalls([
        fake('src/application/x/x.ts', 'await this.db.asSystem((tx) => tx);\nawait db.asSystem (async (tx) => tx);'),
        fake('src/runtime/definitions/x.ts', 'await this.db.exec(`drop index x`);'),
        fake('src/infrastructure/postgres/x.ts', 'await db.asSystem((tx) => tx); await db.exec(sql);'),
        fake('src/http/x.ts', 'await this.db.withTenant(id, (tx) => tx); /regex/.exec(s);'),
      ]),
    ).toEqual({ 'src/application/x/x.ts': 2, 'src/runtime/definitions/x.ts': 1 });
  });
});
