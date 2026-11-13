import { sql } from 'kysely';
import type { Database } from '../../db.js';
import { typed } from '../../kysely.js';
import type { DefinitionBase } from '../../../../runtime/definitions/ports/definition-base.js';

/** The owner-level definitionBase capability. */
export function pgDefinitionBase(db: Database): DefinitionBase {
  return {
    publish(kind, key, moduleKey, body, checksum) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        const current = await k
          .selectFrom('definition')
          .select(['version', 'checksum'])
          .where('tenant_id', 'is', null)
          .where('kind', '=', kind)
          .where('key', '=', key)
          .where('status', '=', 'published')
          .executeTakeFirst();
        if (current?.checksum === checksum) return current.version;
        const { next } = await k
          .selectFrom('definition')
          .select(sql<number>`coalesce(max(version), 0) + 1`.as('next'))
          .where('tenant_id', 'is', null)
          .where('kind', '=', kind)
          .where('key', '=', key)
          .executeTakeFirstOrThrow();
        await k
          .updateTable('definition')
          .set({ status: 'superseded' })
          .where('tenant_id', 'is', null)
          .where('kind', '=', kind)
          .where('key', '=', key)
          .where('status', '=', 'published')
          .execute();
        await k
          .insertInto('definition')
          .values({
            tenant_id: null,
            module_key: moduleKey,
            kind,
            key,
            version: next,
            status: 'published',
            body: JSON.stringify(body),
            checksum,
            created_by: 'system',
            published_by: 'system',
            published_at: sql<Date>`now()`,
          })
          .execute();
        return next;
      });
    },
    publishedChecksums(moduleKey) {
      return db.asSystem((tx) =>
        tx.query<{ kind: string; key: string; checksum: string }>(
          'select kind, key, checksum from app_published_definition_checksums($1)',
          [moduleKey],
        ),
      );
    },
    organisationsBehind(moduleKey) {
      return db.asSystem((tx) =>
        typed(tx)
          .selectFrom('definition as t')
          .innerJoin('definition as b', (j) =>
            j
              .on('b.tenant_id', 'is', null)
              .onRef('b.module_key', '=', 't.module_key')
              .onRef('b.kind', '=', 't.kind')
              .onRef('b.key', '=', 't.key')
              .on('b.status', '=', 'published'),
          )
          .select(['t.tenant_id', 't.kind', 't.key'])
          .where('t.tenant_id', 'is not', null)
          .where('t.module_key', '=', moduleKey)
          .where('t.status', '=', 'published')
          .whereRef('t.base_version', '<', 'b.version')
          .$castTo<{ tenant_id: string; kind: string; key: string }>()
          .execute(),
      );
    },
  };
}
