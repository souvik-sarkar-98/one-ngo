import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { definitionKindOf, type BuilderApi } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import {
  draftRequest,
  extensionPatchRequest,
  rollbackRequest,
  type DraftRequest,
  type ExtensionPatchRequest,
  type RollbackRequest,
} from '@onengo/platform/contracts';
import type { ServerOptions } from '../server.js';

/** Drafting, checking and publishing definitions, and the builder's helpers. Signed-in scope only. */
export async function builderRoutes(api: FastifyInstance, { deps, schemaDir }: { deps: BuilderApi } & Pick<ServerOptions, 'schemaDir'>): Promise<void> {
  api.get('/api/builder/catalogue', async (req) => deps.definitions.catalogue(contextOf(req)));

  api.get<{ Params: { kind: string; key: string } }>('/api/builder/definitions/:kind/:key', async (req) =>
    deps.inspect.run(contextOf(req), req.params.kind, req.params.key),
  );

  api.put<{ Params: { kind: string; key: string }; Body: DraftRequest }>(
    '/api/builder/definitions/:kind/:key/draft',
    { schema: { body: draftRequest } },
    async (req) => deps.saveDraft.run(contextOf(req), req.params.kind, req.params.key, req.body),
  );

  api.post<{ Params: { kind: string; key: string } }>('/api/builder/definitions/:kind/:key/publish', async (req) =>
    deps.publish.run(contextOf(req), req.params.kind, req.params.key),
  );

  api.post<{ Params: { kind: string; key: string } }>('/api/builder/definitions/:kind/:key/discard', async (req, reply) => {
    await deps.definitions.discard(contextOf(req), req.params.kind, req.params.key);
    return reply.status(204).send();
  });

  api.post<{ Params: { kind: string; key: string }; Body: RollbackRequest }>(
    '/api/builder/definitions/:kind/:key/rollback',
    { schema: { body: rollbackRequest } },
    async (req) => deps.rollback.run(contextOf(req), req.params.kind, req.params.key, req.body.version),
  );

  api.put<{ Params: { kind: string; key: string }; Body: ExtensionPatchRequest }>(
    '/api/builder/definitions/:kind/:key/patch',
    { schema: { body: extensionPatchRequest } },
    async (req) => deps.definitions.setPatch(contextOf(req), req.params.kind, req.params.key, req.body.patch),
  );

  const builder = deps.support;
  type DefParams = { Params: { kind: string; key: string } };
  api.post<DefParams>('/api/builder/definitions/:kind/:key/check', async (req) =>
    builder.check(contextOf(req), definitionKindOf(req.params.kind), req.params.key, req.body),
  );
  api.get<DefParams & { Querystring: { against?: string } }>('/api/builder/definitions/:kind/:key/changes', async (req) =>
    builder.changes(contextOf(req), definitionKindOf(req.params.kind), req.params.key, req.query.against),
  );
  api.get<DefParams & { Querystring: { field?: string } }>('/api/builder/usages/:kind/:key', async (req) =>
    builder.usages(contextOf(req), definitionKindOf(req.params.kind), req.params.key, req.query.field || undefined),
  );
  api.get<{ Params: { sequence: string }; Querystring: { reset?: string } }>('/api/builder/sequences/:sequence/next', async (req) =>
    builder.nextNumber(contextOf(req), req.params.sequence, req.query.reset === 'never' ? 'never' : 'fiscal_year'),
  );
  api.get<{ Params: { recordType: string } }>('/api/builder/index-warnings/:recordType', async (req) =>
    builder.indexWarnings(contextOf(req), req.params.recordType),
  );
  api.post('/api/builder/expressions/check', async (req) => builder.checkExpression(contextOf(req), req.body));
  api.post('/api/builder/expressions/try', async (req) => builder.tryExpression(contextOf(req), req.body));
  api.post('/api/builder/templates/preview', async (req) => builder.previewTemplate(contextOf(req), req.body));
  api.post('/api/builder/templates/test', async (req) => builder.testTemplate(contextOf(req), req.body));
  api.post('/api/builder/scripts/try', async (req) => builder.tryScript(contextOf(req), req.body));
  api.post('/api/builder/posting-rules/try', async (req) => builder.tryPostingRule(contextOf(req), req.body));
  api.get('/api/builder/modules', async (req) => builder.modules(contextOf(req)));
  api.post<{ Params: { key: string } }>('/api/builder/modules/:key/enable', async (req) => builder.enableModule(contextOf(req), req.params.key));
  api.post<{ Params: { key: string } }>('/api/builder/modules/:key/disable', async (req) => builder.disableModule(contextOf(req), req.params.key));
  api.get<{ Params: { key: string } }>('/api/builder/modules/:key/update', async (req) => builder.updateReview(contextOf(req), req.params.key));

  if (schemaDir) {
    api.get<{ Params: { kind: string } }>('/api/builder/schemas/:kind', async (req, reply) => {
      const kind = req.params.kind === 'scriptEffects' ? 'scriptEffects' : definitionKindOf(req.params.kind);
      return reply.type('application/json').send(readFileSync(join(schemaDir, `${kind}.schema.json`), 'utf8'));
    });
  }
}
