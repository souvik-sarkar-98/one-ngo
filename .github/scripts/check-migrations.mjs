// Fails when a migration writes data at top level. Migrations may change schema.
// The only writes they may make are the bookkeeping rows listed in ALLOWED below.
// Anything else (demo or seed rows, backfills, copies) belongs in a separate,
// explicitly run script, not in the deploy path.
//
// This is a guardrail, not an SQL parser. It strips comments, dollar-quoted bodies
// (function and DO blocks) and string literals, then checks each remaining
// statement's first keyword.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(root, 'packages', 'platform', 'migrations');

const WRITE = /^(insert|update|delete|truncate|copy|merge|upsert)\b/i;

/** Allowed top-level writes: [file, statement prefix]. */
const ALLOWED = [
  ['*', /^insert\s+into\s+schema_compatibility\b/i], // migration bookkeeping, one row per file
  ['001_core.sql', /^insert\s+into\s+tenant_seal_key\b/i], // the one-time seal secret, first migration only
  ['008_retire_bank_accounts_module.sql', /^delete\s+from\s+tenant_module\b/i], // clean up disabled module toggle
  ['012_overdraft_default_off.sql', /^update\s+money_account\b/i], // default existing non-negative bank accounts to no overdraft
];

function strip(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, ' $$body$$ ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function statements(sql) {
  return strip(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowed(file, statement) {
  return ALLOWED.some(([f, pattern]) => (f === '*' || f === file) && pattern.test(statement));
}

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const violations = [];
for (const file of files) {
  const text = await readFile(join(migrationsDir, file), 'utf8');
  for (const statement of statements(text)) {
    if (WRITE.test(statement) && !isAllowed(file, statement)) {
      violations.push(`${file}: ${statement.split('\n')[0].slice(0, 120)}`);
    }
  }
}

if (violations.length) {
  console.error('Migrations may not write data at top level (only schema and the allowed bookkeeping rows):');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`Checked ${files.length} migration files: no disallowed data writes.`);
