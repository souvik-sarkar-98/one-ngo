import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function digest(directory = join(ROOT, 'dist'), base = directory): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) hash.update(digest(path, base));
    else hash.update(`${path.slice(base.length)}\0`).update(readFileSync(path));
  }
  return hash.digest('hex');
}

describe('operator production artifact', () => {
  it('is complete and deterministic from a clean output folder', () => {
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      if (!process.env.npm_execpath) throw new Error('Run artifact tests through npm.');
      execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build', '--workspace', '@onengo-console/server'], {
        cwd: join(ROOT, '../../..'),
        stdio: 'pipe',
      });
      hashes.push(digest());
    }
    expect(hashes[1]).toBe(hashes[0]);
    expect(readFileSync(join(ROOT, 'dist/web/index.html'), 'utf8')).toMatch(/<op-root/);
    const artifact = JSON.parse(readFileSync(join(ROOT, 'dist/package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
    expect(artifact.name).toBe('@onengo-console/server-artifact');
    expect(Object.keys(artifact.dependencies).filter((name) => name.startsWith('@onengo/'))).toEqual([]);
  }, 180_000);
});
