// Rewrites test/layer-allowlist.json (the exact set of edges that break the layer table) from the current
// source. Reasons already written by hand are kept. The allowlist is empty and stays empty.
//   npx tsx packages/platform/test/layer-baseline.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOf, removeAfterBlock, ROOT, sources, violations } from './layer-graph.js';

const FILE = join(ROOT, 'test/layer-allowlist.json');
const previous: Record<string, { reason: string; owner: string; removeAfterBlock: string }> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};

const found = violations(sources());
const entries = [...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
const out: Record<string, { reason: string; owner: string; removeAfterBlock: string }> = {};
for (const [key, { edge, why }] of entries) {
  out[key] = previous[key] ?? { reason: `${why}${edge.typeOnly ? ' (type-only import)' : ''}`, owner: ownerOf(edge.from), removeAfterBlock: removeAfterBlock(edge) };
}
writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${entries.length} edges`);
