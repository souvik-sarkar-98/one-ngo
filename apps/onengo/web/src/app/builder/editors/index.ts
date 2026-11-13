import type { Type } from '@angular/core';
import type { DefinitionKind } from '../../core/models';
import { GenericEditor } from './generic/generic-editor';
import { ListViewEditor } from './list-view/list-view-editor';
import { PageEditor } from './page/page-editor';
import { RecordTypeEditor } from './record-type/record-type-editor';
import { TranslationsEditor } from './translations/translations-editor';
import { WorkflowEditor } from './workflow/workflow-editor';

/** The Visual tab's hand-built editors; every other kind gets the editor generated from its schema. */
const EDITORS: Partial<Record<DefinitionKind, Type<unknown>>> = {
  recordType: RecordTypeEditor,
  workflow: WorkflowEditor,
  listView: ListViewEditor,
  page: PageEditor,
  translation: TranslationsEditor,
};

export const visualEditor = (kind: DefinitionKind): Type<unknown> => EDITORS[kind] ?? GenericEditor;
