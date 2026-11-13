import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import { definitionKindOf, notFound, validationFailed, type RequestContext } from '../shared/http-api.js';

/** Everything the builder knows about one definition: published, draft, history and what the product ships. */
export class InspectDefinition {
  constructor(private readonly definitions: Pick<DefinitionService, 'get' | 'getDraft' | 'history' | 'baseAndPatch'>) {}

  async run(ctx: RequestContext, kindName: string, key: string) {
    const kind = definitionKindOf(kindName);
    const [published, draft, history, shipped] = [
      await this.definitions.get(ctx.tenantId, kind, key),
      await this.definitions.getDraft(ctx, kind, key),
      await this.definitions.history(ctx.tenantId, kind, key),
      await this.definitions.baseAndPatch(ctx, kind, key),
    ];
    if (!published && !draft && !shipped) throw notFound('Definition not found.');
    return { kind, key, published: published ?? null, draft: draft ?? null, history, shipped: shipped ?? null };
  }
}

/** Saves the builder's draft; the key in the body must be the one in the address. */
export class SaveDefinitionDraft {
  constructor(private readonly definitions: Pick<DefinitionService, 'saveDraft'>) {}

  async run(ctx: RequestContext, kindName: string, key: string, body: { key: string }) {
    if (body.key !== key) throw validationFailed('The key in the body must match the address.');
    const version = await this.definitions.saveDraft(ctx, definitionKindOf(kindName), body as never);
    return { version };
  }
}

/** Makes the draft the published definition. */
export class PublishDefinition {
  constructor(private readonly definitions: Pick<DefinitionService, 'publish'>) {}

  run(ctx: RequestContext, kindName: string, key: string) {
    return this.definitions.publish(ctx, definitionKindOf(kindName), key);
  }
}

/** Publishes an earlier version of a definition again. */
export class RollbackDefinition {
  constructor(private readonly definitions: Pick<DefinitionService, 'rollback'>) {}

  run(ctx: RequestContext, kindName: string, key: string, version: number) {
    return this.definitions.rollback(ctx, definitionKindOf(kindName), key, version);
  }
}

/** The definition kinds the builder works with, also naming the script-effects schema. */
export class BuilderDefinitions {
  constructor(private readonly definitions: Pick<DefinitionService, 'catalogue' | 'discardDraft' | 'setExtensionPatch'>) {}

  catalogue(ctx: RequestContext) {
    return this.definitions.catalogue(ctx);
  }

  discard(ctx: RequestContext, kindName: string, key: string) {
    return this.definitions.discardDraft(ctx, definitionKindOf(kindName), key);
  }

  setPatch(ctx: RequestContext, kindName: string, key: string, patch: Parameters<DefinitionService['setExtensionPatch']>[3]) {
    return this.definitions.setExtensionPatch(ctx, definitionKindOf(kindName), key, patch);
  }
}
