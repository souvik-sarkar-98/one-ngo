import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MigrationTarget, ProviderUnderTest } from './provider.js';

/**
 * `MigrationRunner`: applies provider migrations under logical ids, and
 * ADR-13 criterion 4: a failed migration leaves nothing half-applied, is seen
 * as pending (so start-up refuses), and applies once fixed.
 */
export function defineMigrationContract(provider: ProviderUnderTest): void {
  describe('MigrationRunner', () => {
    const open: (MigrationTarget | string)[] = [];

    afterEach(async () => {
      for (const item of open.splice(0)) {
        if (typeof item === 'string') await rm(item, { recursive: true, force: true });
        else await item.close();
      }
    });

    async function folder(steps: Record<string, { creates: string; fails?: boolean }>): Promise<{ dir: string; put: (id: string, step: { creates: string; fails?: boolean }) => Promise<void> }> {
      const dir = await mkdtemp(join(tmpdir(), 'ngo-contract-'));
      open.push(dir);
      const put = async (id: string, step: { creates: string; fails?: boolean }) => {
        const f = provider.migrations.file(id, step);
        await writeFile(join(dir, f.name), f.text);
      };
      for (const [id, step] of Object.entries(steps)) await put(id, step);
      return { dir, put };
    }

    async function target(): Promise<MigrationTarget> {
      const t = await provider.migrations.open();
      open.push(t);
      return t;
    }

    it('applies each logical step once, in order, and records it under its id', async () => {
      const { dir } = await folder({ '001_alpha': { creates: 'contract_alpha' }, '002_beta': { creates: 'contract_beta' } });
      const db = await target();
      expect(await db.status(dir)).toEqual({ pending: ['001_alpha', '002_beta'], unknown: [] });
      expect(await db.apply(dir)).toEqual(['001_alpha', '002_beta']);
      expect(await db.apply(dir)).toEqual([]);
      expect(await db.status(dir)).toEqual({ pending: [], unknown: [] });
    });

    it('leaves nothing of a failed step, reports it pending, and applies it once fixed', async () => {
      const { dir, put } = await folder({ '001_alpha': { creates: 'contract_alpha' }, '002_beta': { creates: 'contract_beta', fails: true } });
      const db = await target();
      await expect(db.apply(dir)).rejects.toThrow();
      expect(await db.status(dir)).toEqual({ pending: ['002_beta'], unknown: [] });
      await put('002_beta', { creates: 'contract_beta' });
      // Creating contract_beta again would fail had the failed run left it behind.
      expect(await db.apply(dir)).toEqual(['002_beta']);
      expect(await db.status(dir)).toEqual({ pending: [], unknown: [] });
    });

    it('reports a step the database has but the release does not, so start-up refuses it', async () => {
      const first = await folder({ '001_alpha': { creates: 'contract_alpha' } });
      const older = await folder({});
      const db = await target();
      await db.apply(first.dir);
      expect(await db.status(older.dir)).toEqual({ pending: [], unknown: ['001_alpha'] });
    });

    it('refuses a step that sorts before one already applied', async () => {
      const { dir, put } = await folder({ '001_alpha': { creates: 'contract_alpha' }, '003_gamma': { creates: 'contract_gamma' } });
      const db = await target();
      await db.apply(dir);
      await put('002_beta', { creates: 'contract_beta' });
      await expect(db.apply(dir)).rejects.toThrow();
    });

    it('applies each step exactly once when two runners start together', async () => {
      const { dir } = await folder({
        '001_alpha': { creates: 'contract_alpha' },
        '002_beta': { creates: 'contract_beta' },
        '003_gamma': { creates: 'contract_gamma' },
      });
      const db = await target();
      // The database exists before its first release runs, as in a deployment.
      expect(await db.apply((await folder({})).dir)).toEqual([]);
      const peer = await db.peer();
      open.push(peer);
      const [a, b] = await Promise.all([db.apply(dir), peer.apply(dir)]);
      expect([...a, ...b].sort()).toEqual(['001_alpha', '002_beta', '003_gamma']);
      expect(await db.status(dir)).toEqual({ pending: [], unknown: [] });
    });
  });
}
