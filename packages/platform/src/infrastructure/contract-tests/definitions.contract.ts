import { beforeAll, describe, expect, it } from 'vitest';
import { ACTOR, expectRefused, type World } from './support.js';

/** `DefinitionStore`: read published snapshot, draft, publish, version, patch. */
export function defineDefinitionContract(world: World): void {
  describe('DefinitionStore', () => {
    let t: string;
    let other: string;
    const body = (label: string) => ({ key: 'contractType', label, fields: [] });

    beforeAll(async () => {
      t = await world().newTenant();
      other = await world().newTenant();
    });

    it('keeps a draft apart from the published snapshot until it is published', async () => {
      const { definitions } = world().stores;
      await world().transactions.withTenant(t, async (tx) => {
        const v = await definitions.nextVersion(tx, 'recordType', 'contractType');
        await definitions.addDraft(tx, 'recordType', 'contractType', v, body('First'), 'c1', ACTOR);
        expect((await definitions.draft(tx, 'recordType', 'contractType'))?.body).toEqual(body('First'));
        expect((await definitions.published(tx)).filter((d) => d.key === 'contractType')).toEqual([]);
        await definitions.publishDraft(tx, 'recordType', 'contractType', v, ACTOR);
        const [published] = (await definitions.published(tx)).filter((d) => d.key === 'contractType');
        expect(published).toMatchObject({ kind: 'recordType', version: v, status: 'published', checksum: 'c1', body: body('First') });
        expect(await definitions.draft(tx, 'recordType', 'contractType')).toBeUndefined();
      });
    });

    it('allows one open draft per definition', async () => {
      const { definitions } = world().stores;
      await world().transactions.withTenant(t, async (tx) => {
        const v = await definitions.nextVersion(tx, 'recordType', 'contractType');
        await definitions.addDraft(tx, 'recordType', 'contractType', v, body('Second'), 'c2', ACTOR);
      });
      await expectRefused(
        world(),
        world().transactions.withTenant(t, async (tx) => {
          const v = await world().stores.definitions.nextVersion(tx, 'recordType', 'contractType');
          await world().stores.definitions.addDraft(tx, 'recordType', 'contractType', v, body('Third'), 'c3', ACTOR);
        }),
        'duplicate',
      );
    });

    it('supersedes the published version on publishing the next, keeping every version readable', async () => {
      const { definitions } = world().stores;
      await world().transactions.withTenant(t, async (tx) => {
        const draft = (await definitions.draftVersion(tx, 'recordType', 'contractType'))!.version;
        await definitions.supersede(tx, 'recordType', 'contractType');
        await definitions.publishDraft(tx, 'recordType', 'contractType', draft, ACTOR);
        const history = await definitions.history(tx, 'recordType', 'contractType');
        expect(history.map((h) => [h.version, h.status])).toEqual(
          expect.arrayContaining([
            [draft - 1, 'superseded'],
            [draft, 'published'],
          ]),
        );
        expect((await definitions.version(tx, 'recordType', 'contractType', draft - 1))?.body).toEqual(body('First'));
        expect((await definitions.published(tx)).filter((d) => d.key === 'contractType').map((d) => d.version)).toEqual([draft]);
      });
    });

    it('allows one published version per definition', async () => {
      await expectRefused(
        world(),
        world().transactions.withTenant(t, async (tx) => {
          const { definitions } = world().stores;
          const v = await definitions.nextVersion(tx, 'recordType', 'contractType');
          await definitions.addPublished(tx, { actorId: ACTOR, kind: 'recordType', key: 'contractType', version: v, baseVersion: null, moduleKey: null, body: body('Rogue'), checksum: 'c9' });
        }),
        'duplicate',
      );
    });

    it('keeps an extension patch and bumps the configuration version', async () => {
      const { definitions } = world().stores;
      await world().transactions.withTenant(t, async (tx) => {
        const before = (await definitions.configVersion(tx))!;
        await definitions.savePatch(tx, 'recordType', 'contractType', { add: ['x'] }, ACTOR);
        await definitions.savePatch(tx, 'recordType', 'contractType', { add: ['y'] }, ACTOR);
        await definitions.bumpConfigVersion(tx);
        expect(await definitions.patch(tx, 'recordType', 'contractType')).toEqual({ patch: { add: ['y'] } });
        expect(await definitions.configVersion(tx)).toBe(before + 1);
      });
    });

    it('never shows one organisation’s definitions to another', async () => {
      const { definitions } = world().stores;
      await world().transactions.withTenant(other, async (tx) => {
        expect((await definitions.published(tx)).filter((d) => d.key === 'contractType')).toEqual([]);
        expect(await definitions.history(tx, 'recordType', 'contractType')).toEqual([]);
        expect(await definitions.patch(tx, 'recordType', 'contractType')).toBeUndefined();
      });
    });
  });
}
