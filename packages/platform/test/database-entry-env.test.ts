import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDeployDatabase, openOperatorDatabase, openServerDatabase } from '../src/composition/entry.js';

const legacyOnly = { DATABASE_URL: 'postgres://owner:secret@localhost/ngo' };
const root = join(import.meta.dirname, '../../..');

describe('process database credential cutover', () => {
  it('does not let the owner or legacy URL satisfy the main serving process', () => {
    expect(() => openServerDatabase(legacyOnly)).toThrow('Set DATABASE_SYSTEM_URL');
    expect(() => openServerDatabase({ ...legacyOnly, DATABASE_SYSTEM_URL: legacyOnly.DATABASE_URL })).toThrow('Set DATABASE_RUNTIME_URL');
  });

  it('requires the owner URL only for the deploy process', async () => {
    await expect(openDeployDatabase(legacyOnly)).rejects.toThrow('Set DATABASE_OWNER_URL');
  });

  it('does not let the owner or legacy URL satisfy the operator serving process', () => {
    expect(() => openOperatorDatabase(legacyOnly)).toThrow('Set OPERATOR_DATABASE_URL');
    expect(() => openOperatorDatabase({ ...legacyOnly, OPERATOR_DATABASE_URL: legacyOnly.DATABASE_URL })).toThrow('Set OPERATOR_RUNTIME_URL');
  });

  it('keeps owner credentials and migration entry points out of serving artifacts', () => {
    for (const app of ['onengo', 'onengo-console']) {
      const manifest = readFileSync(join(root, 'apps', app, 'server/app.yaml'), 'utf8');
      const main = readFileSync(join(root, 'apps', app, 'server/src/main.ts'), 'utf8');
      expect(manifest).not.toContain('DATABASE_OWNER_URL');
      expect(main).not.toMatch(/openDeployDatabase|prepareDeployment|migrat|withMigratorClient/);
    }
    const roles = readFileSync(join(root, 'packages/platform/migrations/001_core.sql'), 'utf8');
    expect(roles).toContain('nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls');
    expect(roles).not.toMatch(/grant\s+(create|all).*ngo_(?:main|operator)/i);
  });
});
