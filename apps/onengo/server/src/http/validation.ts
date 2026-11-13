import { Ajv, type ErrorObject } from 'ajv';
import type { FastifySchemaCompiler } from 'fastify';
import type { FieldIssue } from '@onengo/platform/contracts';

/**
 * Bodies are checked as sent: no type coercion, no defaults, and unknown fields are refused rather than dropped.
 * Strict, except that a field may accept several types, such as an amount as a number or a decimal string.
 */
const bodies = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, allowUnionTypes: true, discriminator: true });
const others = new Ajv({ coerceTypes: 'array', useDefaults: true });

export const validatorCompiler: FastifySchemaCompiler<unknown> = ({ schema, httpPart }) =>
  (httpPart === 'body' ? bodies : others).compile(schema as object);

/** Each schema failure as a field issue: `/roles` "is required", `/extra` "is not allowed", `/operation/type` "is not a known kind", `/amount` "must be number,string". */
export function shapeIssues(errors: ErrorObject[]): FieldIssue[] {
  return errors.map((e) => {
    const p = e.params as { missingProperty?: string; additionalProperty?: string; error?: string; tag?: string };
    if (e.keyword === 'required') return { path: `${e.instancePath}/${p.missingProperty}`, message: 'is required' };
    if (e.keyword === 'additionalProperties') return { path: `${e.instancePath}/${p.additionalProperty}`, message: 'is not allowed' };
    if (e.keyword === 'discriminator') return { path: `${e.instancePath}/${p.tag}`, message: p.error === 'mapping' ? 'is not a known kind' : 'must be string' };
    return { path: e.instancePath || '/', message: e.message ?? 'is not valid' };
  });
}
