import type { BuilderSupport } from '../definitions/builder-support.js';
import type { BuilderDefinitions, InspectDefinition, PublishDefinition, RollbackDefinition, SaveDefinitionDraft } from '../definitions/definition-use-cases.js';

/** Drafting, checking and publishing definitions, and the builder's helpers. */
export interface BuilderApi {
  definitions: BuilderDefinitions;
  inspect: InspectDefinition;
  saveDraft: SaveDefinitionDraft;
  publish: PublishDefinition;
  rollback: RollbackDefinition;
  support: Pick<
    BuilderSupport,
    | 'check'
    | 'changes'
    | 'usages'
    | 'nextNumber'
    | 'indexWarnings'
    | 'checkExpression'
    | 'tryExpression'
    | 'previewTemplate'
    | 'testTemplate'
    | 'tryScript'
    | 'tryPostingRule'
    | 'modules'
    | 'enableModule'
    | 'disableModule'
    | 'updateReview'
  >;
}
