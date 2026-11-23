import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './layer-graph.js';

/**
 * These files record the layout before the move into packages and apps, so they
 * name paths that no longer exist. Everything under `docs/archive/` is kept for
 * history only. Current docs and READMEs must cite paths that are on disk.
 */
const HISTORY = new Set(['docs/plans/ngo-backend-enhancement-plan.md']);
const HISTORY_DIRS = ['docs/archive/'];

const PATH_IN_BACKTICKS = /`((?:apps|packages|src|product|docs|test|web|scripts)\/[^`\n]+)`/g;

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    // `.data` is gitignored app and scratch space that holds worktrees of other branches; only tracked docs are checked.
    if (name === 'node_modules' || name === 'dist' || name === '.data' || name === '.git') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...markdownFiles(abs));
    else if (name.endsWith('.md')) out.push(abs);
  }
  return out;
}

/** Repo-relative paths a markdown file claims exist, ignoring globs and prose. */
export function citedPaths(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(PATH_IN_BACKTICKS)) {
    let path = match[1] ?? '';
    path = path.replace(/[),.;]+$/, '').split('#')[0] ?? '';
    const line = path.match(/^(.*\.[A-Za-z0-9]+):\d+$/);
    if (line) path = line[1] ?? path;
    if (!path || /[\s*<>]/.test(path)) continue;
    out.push(path);
  }
  return out;
}

/** Backtick paths in repo markdown that are not on disk. Relocation history is excluded. */
export function missingDocPaths(root = join(ROOT, '..', '..')): string[] {
  const missing: string[] = [];
  for (const abs of markdownFiles(root)) {
    const rel = abs.slice(root.length + 1).replaceAll('\\', '/');
    if (HISTORY.has(rel) || HISTORY_DIRS.some((dir) => rel.startsWith(dir))) continue;
    const markdown = readFileSync(abs, 'utf8');
    for (const path of citedPaths(markdown)) {
      if (!existsSync(join(root, path))) missing.push(`${rel}: ${path}`);
    }
  }
  return [...new Set(missing)].sort();
}
