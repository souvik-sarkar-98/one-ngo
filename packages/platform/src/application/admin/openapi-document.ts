import type { OrganisationName } from '../../domain/ports/organisation-name.js';
import { actionPermission } from '../../runtime/definitions/action-permissions.js';
import type { ActionDef, FieldDef, RecordTypeDef, WorkflowDef } from '../../runtime/definitions/types.js';
import { isPrimary } from '../../runtime/definitions/workflows.js';
import { fieldSchema } from '../../runtime/records/validator.js';
import { can, type RequestContext } from '../shared/http-api.js';
import type { PublishedDefinitions } from './ports/admin-ports.js';

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errors = Object.fromEntries(
  [
    ['400', 'The body has the wrong shape: a field is missing, has the wrong type or is not part of the request.'],
    ['403', 'Not signed in, or not allowed.'],
    ['404', 'Not found.'],
    ['409', 'The record changed since it was read, or a conflicting request is running.'],
    ['422', 'The data breaks a field check or a rule.'],
    ['429', 'Too many requests.'],
  ].map(([code, description]) => [code, { description, content: { 'application/json': { schema: ref('Error') } } }]),
);
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const idempotencyParam = { $ref: '#/components/parameters/IdempotencyKey' };

function property(f: FieldDef): Json {
  return {
    ...fieldSchema(f),
    title: f.label,
    ...(f.help ? { description: f.help } : {}),
    ...(f.calculated || f.rollup ? { readOnly: true } : {}),
    ...(f.referenceType ? { 'x-reference-type': f.referenceType } : {}),
    ...(f.sensitive ? { 'x-sensitive': true } : {}),
  };
}

function dataSchema(fields: FieldDef[], withRequired: boolean): Json {
  const required = withRequired ? fields.filter((f) => f.required && !f.visibleWhen && !f.calculated && !f.rollup).map((f) => f.key) : [];
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(fields.map((f) => [f.key, property(f)])),
    ...(required.length ? { required } : {}),
  };
}

function recordSchema(type: RecordTypeDef, primary: WorkflowDef | undefined): Json {
  return {
    type: 'object',
    required: ['id', 'type', 'version', 'data', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      type: { const: type.key },
      number: { type: ['string', 'null'] },
      status: primary ? { enum: [...primary.states.map((s) => s.key), null] } : { type: ['string', 'null'] },
      version: { type: 'integer' },
      schemaVersion: { type: 'integer' },
      data: ref(type.key),
      workflow: { type: ['string', 'null'] },
      states: { type: 'object', additionalProperties: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function actionInput(def: ActionDef): Json {
  return dataSchema((def.form?.fields ?? []) as FieldDef[], true);
}

/** What the OpenAPI document is generated from: the organisation's name and published definitions, and the helpers that read them. */
export interface OpenApiKit {
  organisationName: OrganisationName;
  definitions: PublishedDefinitions;
  /** A short fingerprint of the definition versions the document describes. */
  sha256(text: string): string;
  /** The JSON Schema of the error body every operation can answer with. */
  errorSchema: unknown;
}

/**
 * OpenAPI 3.1 description of the organisation's records API as configured
 * now: the record types the caller may read, with the steps and actions it
 * may use.
 */
export class OpenApiDocument {
  constructor(private readonly kit: OpenApiKit) {}

  build(ctx: RequestContext): Promise<Json> {
    return openApiDocument(this.kit, ctx);
  }
}

async function openApiDocument(kit: OpenApiKit, ctx: RequestContext): Promise<Json> {
  const defs = kit.definitions;
  const errorResponse = kit.errorSchema;
  const name = await kit.organisationName(ctx.tenantId);
  const types = (await defs.list(ctx.tenantId, 'recordType'))
    .filter((t) => can(ctx.actor, `record:${t.key}:read`))
    .sort((a, b) => a.key.localeCompare(b.key));
  const workflows = await defs.list(ctx.tenantId, 'workflow');
  const actions = (await defs.list(ctx.tenantId, 'action')).sort((a, b) => a.key.localeCompare(b.key));

  const schemas: Json = { Error: errorResponse };
  const paths: Record<string, Json> = {};
  const versions: string[] = [];

  for (const t of types) {
    const key = t.key;
    const label = t.body.label;
    const own = workflows.filter((w) => w.body.recordType === key).sort((a, b) => Number(isPrimary(b.body)) - Number(isPrimary(a.body)) || a.key.localeCompare(b.key));
    const mine = actions.filter((a) => a.body.recordType === key);
    versions.push(`${key}@${t.version}`, ...own.map((w) => `workflow:${w.key}@${w.version}`), ...mine.map((a) => `action:${a.key}@${a.version}`));

    schemas[key] = { ...dataSchema(t.body.fields, true), title: label, ...(t.body.description ? { description: t.body.description } : {}) };
    schemas[`${key}.changes`] = { ...dataSchema(t.body.fields, false), title: `${label} changes` };
    schemas[`${key}.record`] = { ...recordSchema(t.body, own.find((w) => isPrimary(w.body))?.body), title: `${label} record` };
    schemas[`${key}.saved`] = {
      type: 'object',
      required: ['record'],
      properties: {
        record: ref(`${key}.record`),
        receipts: { type: 'array', items: { type: 'object' } },
        journalEntryIds: { type: 'array', items: { type: 'string' } },
        approvalRequestId: { type: 'string', description: 'Set when the step waits for approval; the record is unchanged until then.' },
      },
    };
    const tags = [key];
    const base = `/api/records/${key}`;

    paths[base] = {
      get: {
        operationId: `${key}_list`,
        summary: `List ${t.body.pluralLabel ?? label}`,
        tags,
        'x-permission': `record:${key}:read`,
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search text.' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: { '200': json({ type: 'array', items: ref(`${key}.record`) }), ...errors },
      },
      ...(can(ctx.actor, `record:${key}:create`)
        ? {
            post: {
              operationId: `${key}_create`,
              summary: `Create a ${label}`,
              tags,
              'x-permission': `record:${key}:create`,
              parameters: [idempotencyParam],
              requestBody: body(ref(key)),
              responses: { '201': json(ref(`${key}.saved`), 'Created'), ...errors },
            },
          }
        : {}),
    };
    paths[`${base}/query`] = {
      post: {
        operationId: `${key}_query`,
        summary: `Find ${t.body.pluralLabel ?? label} with filters and a total`,
        tags,
        'x-permission': `record:${key}:read`,
        requestBody: body({ $ref: '#/components/schemas/RecordQuery' }),
        responses: {
          '200': json({
            type: 'object',
            required: ['items', 'total'],
            properties: { items: { type: 'array', items: ref(`${key}.record`) }, total: { type: 'integer' }, sums: { type: 'object' } },
          }),
          ...errors,
        },
      },
    };
    paths[`${base}/{id}`] = {
      parameters: [idParam],
      get: {
        operationId: `${key}_get`,
        summary: `Read a ${label}`,
        tags,
        'x-permission': `record:${key}:read`,
        responses: { '200': json(ref(`${key}.record`)), ...errors },
      },
      ...(can(ctx.actor, `record:${key}:update`)
        ? {
            patch: {
              operationId: `${key}_update`,
              summary: `Change a ${label}`,
              tags,
              'x-permission': `record:${key}:update`,
              parameters: [idempotencyParam],
              requestBody: body({
                type: 'object',
                required: ['data', 'expectedVersion'],
                properties: { data: ref(`${key}.changes`), expectedVersion: { type: 'integer' } },
              }),
              responses: { '200': json(ref(`${key}.saved`)), ...errors },
            },
          }
        : {}),
    };

    for (const w of own) {
      for (const tr of w.body.transitions) {
        const permission = tr.permission ?? `record:${key}:transition:${tr.key}`;
        if (!can(ctx.actor, permission)) continue;
        paths[`${base}/{id}/transitions/${tr.key}`] = {
          parameters: [idParam],
          post: {
            operationId: `${key}_step_${tr.key}`,
            summary: tr.label,
            description: `Workflow ${w.key}: from ${tr.from.join(', ')} to ${tr.to}.${tr.requiredFields?.length ? ` Needs ${tr.requiredFields.join(', ')}.` : ''}`,
            tags,
            'x-permission': permission,
            'x-workflow': w.key,
            ...(tr.approval ? { 'x-approval': true } : {}),
            parameters: [idempotencyParam],
            requestBody: body({
              type: 'object',
              required: ['expectedVersion'],
              properties: { data: ref(`${key}.changes`), expectedVersion: { type: 'integer' } },
            }),
            responses: { '200': json(ref(`${key}.saved`)), ...errors },
          },
        };
      }
    }

    for (const a of mine) {
      const permission = actionPermission(a.body);
      if (!can(ctx.actor, permission)) continue;
      paths[`${base}/{id}/actions/${a.key}`] = {
        parameters: [idParam],
        post: {
          operationId: `${key}_action_${a.key}`,
          summary: a.body.label,
          ...(a.body.confirm ? { description: a.body.confirm } : {}),
          tags,
          'x-permission': permission,
          requestBody: body({
            type: 'object',
            properties: { input: actionInput(a.body), expectedVersion: { type: 'integer' } },
          }),
          responses: {
            '200': json({
              type: 'object',
              required: ['record'],
              properties: {
                record: ref(`${key}.record`),
                message: { type: ['string', 'null'] },
                open: { type: 'string', description: 'Where the app goes next: an in-app route such as the print view, or a payment link.' },
              },
            }),
            ...errors,
          },
        },
      };
    }
  }

  schemas.RecordQuery = {
    type: 'object',
    properties: {
      statusIn: { type: 'array', items: { type: 'string' } },
      owner: { const: 'me' },
      sharedWithMe: { type: 'boolean' },
      search: { type: 'string', maxLength: 200 },
      filters: { type: 'object', additionalProperties: { type: 'object' } },
      states: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
      sort: { type: 'object', properties: { field: { type: 'string' }, dir: { enum: ['asc', 'desc'] } } },
      sum: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: `${name ?? 'Organisation'} API`,
      version: kit.sha256(versions.join('\n')).slice(0, 12),
      description: "Generated from the organisation's published record types, workflows and actions.",
    },
    security: [{ apiKey: [] }, { bearer: [] }],
    tags: types.map((t) => ({ name: t.key, description: t.body.label })),
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Send `ApiKey <id>.<secret>`.' },
        bearer: { type: 'http', scheme: 'bearer' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', minLength: 1, maxLength: 255 },
          description: 'Repeating a request with the same key within 24 hours returns the first response without running it again.',
        },
      },
      schemas,
    },
  };
}
