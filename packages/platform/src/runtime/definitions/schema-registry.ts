import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { FieldIssue } from '@onengo/kernel/errors';
import { DEFINITION_KINDS, type DefinitionKind } from './types.js';

/** Schema annotations that steer the Builder's generic editor; they never affect validation. */
export const EDITOR_ANNOTATIONS = ['x-expression', 'x-ref', 'x-order', 'x-group', 'x-preview', 'x-control'] as const;

export function toIssues(errors: ErrorObject[] | null | undefined): FieldIssue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'is invalid',
  }));
}

export class SchemaRegistry {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(schemaDir: string) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    for (const keyword of EDITOR_ANNOTATIONS) ajv.addKeyword({ keyword });
    for (const kind of [...DEFINITION_KINDS, 'module'] as const) {
      const schema = JSON.parse(readFileSync(join(schemaDir, `${kind}.schema.json`), 'utf8'));
      this.validators.set(kind, ajv.compile(schema));
    }
  }

  validate(kind: DefinitionKind | 'module', body: unknown): FieldIssue[] {
    const fn = this.validators.get(kind);
    if (!fn) return [{ path: '/', message: `unknown definition kind '${kind}'` }];
    return fn(body) ? [] : toIssues(fn.errors);
  }
}
