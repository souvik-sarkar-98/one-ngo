import type { JSONSchemaType } from 'ajv';

/**
 * A JSON Schema checked against its interface, for interfaces without null.
 * JSONSchemaType makes every optional property declare `nullable: true`; that
 * is removed here, so null is refused like any other wrong type.
 */
export function schemaOf<T>(schema: JSONSchemaType<T>): JSONSchemaType<T> {
  return withoutNullable(schema) as JSONSchemaType<T>;
}

function withoutNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutNullable);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k, v]) => !(k === 'nullable' && v === true))
      .map(([k, v]) => [k, withoutNullable(v)]),
  );
}
