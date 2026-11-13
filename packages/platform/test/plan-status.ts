import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './layer-graph.js';

/**
 * Allowlist expiry. Entries of test/layer-allowlist.json and test/package-allowlist.json name a block of
 * section 5.1 of docs/architecture/ngo-backend-enhancement-plan.md, and an entry fails once that block is
 * Merged or Done. Both files are empty and stay empty. The plan lives in this repository so a clone of
 * one-ngo alone can run the architecture guards.
 */
export const PLAN_FILE = join(ROOT, '..', '..', 'docs', 'architecture', 'ngo-backend-enhancement-plan.md');

/** Blocks an allowlist entry may name: none, because no exception is approved. */
export const OPEN_BLOCKS = { allowlist: [] as readonly string[] };

export interface Entry {
  reason: string;
  owner: string;
  removeAfterBlock: string;
}

/** Section 5.1 of the plan: block ID -> status text. Splits on unescaped pipes; the first column names the block. */
export function parseBlockStatus(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s+5\.1\b/.test(l));
  if (start < 0) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1).map((c) => c.trim());
    const id = (cells[0] ?? '').replace(/[`*]/g, '');
    if (!id || id === 'Block' || /^-+$/.test(id)) continue;
    if (!out.has(id)) out.set(id, cells[1] ?? '');
  }
  return out;
}

/** A block is closed when section 5.1 says Merged or Done (so "Merged into D11" and "Done (server)" count). */
export const isClosed = (status: string | undefined) => /^(merged|done)\b/i.test((status ?? '').trim());

export const readPlanStatus = () => parseBlockStatus(readFileSync(PLAN_FILE, 'utf8'));

/** Entries that must fail: no block, a block that is not a row of section 5.1, a closed block, or a block the owner has not approved as open. */
export function expiryProblems(entries: Record<string, Entry>, status: Map<string, string>, open: readonly string[]): string[] {
  const out: string[] = [];
  for (const [key, e] of Object.entries(entries)) {
    const block = e.removeAfterBlock;
    if (!block) out.push(`${key}: names no removeAfterBlock`);
    else if (!status.has(block)) out.push(`${key}: block ${block} is not a row of section 5.1 of the plan`);
    else if (isClosed(status.get(block))) out.push(`${key}: block ${block} is "${status.get(block)}" in section 5.1, so this entry expired; fix the violation and remove it`);
    else if (!open.includes(block)) out.push(`${key}: block ${block} is not an owner-approved open block (${open.join(', ') || 'none'})`);
  }
  return out;
}
