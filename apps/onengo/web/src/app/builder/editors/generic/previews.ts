import type { Type } from '@angular/core';
import { CronPreview } from './cron-preview';
import { GroupPreview } from './group-preview';
import { PostingPreview } from './posting-preview';
import { ScriptPreview } from './script-preview';
import { TemplatePreview } from './template-preview';
import { ThemePreview } from './theme-preview';

/**
 * Previews named by `x-preview` in a schema (`template`, `theme`, `page`,
 * `recordGroup`…). Each gets the inputs `value` (the annotated value) and
 * `body` (the whole draft). Annotations without a registered preview show none.
 */
export const PREVIEWS: Partial<Record<string, Type<unknown>>> = {
  template: TemplatePreview,
  theme: ThemePreview,
  script: ScriptPreview,
  postingRule: PostingPreview,
  recordGroup: GroupPreview,
  cron: CronPreview,
};
