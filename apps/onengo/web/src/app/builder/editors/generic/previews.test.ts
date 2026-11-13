import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describe as formOf, formBody, formSections, type FormNode, type JsonSchema } from '../../../core/builder/schema-form';
import { DEFINITION_KINDS, type DefinitionKind } from '../../../core/models';
import { starterBody } from '../../../core/starters';

type Body = Record<string, unknown>;

const repo = join(import.meta.dirname, '../../../../../../../..', 'packages/product');
const schemaOf = (kind: string) => JSON.parse(readFileSync(join(repo, 'schemas', `${kind}.schema.json`), 'utf8')) as JsonSchema;
const shipped = readdirSync(join(repo, 'modules/donations'))
  .filter((f) => f !== 'module.json' && f.endsWith('.json'))
  .map((f) => ({ kind: /\.(\w+)\.json$/.exec(f)![1] as DefinitionKind, body: JSON.parse(readFileSync(join(repo, 'modules/donations', f), 'utf8')) as Body }));
const registry = readFileSync(join(import.meta.dirname, 'previews.ts'), 'utf8');
const registered = new Set([...registry.matchAll(/^\s+(\w+): \w+Preview,$/gm)].map((m) => m[1]!));

const all = (n: FormNode): FormNode[] => [
  n,
  ...(n.control === 'object' || n.control === 'variant' ? n.children : n.control === 'table' ? n.items : n.control === 'map' ? n.entries : []).flatMap(all),
];
const at = (n: FormNode, path: string) => all(n).find((x) => x.path.join('/') === path);

/** The generic editors of B42: a body of each kind, from the shipped module where there is one. */
const KINDS = ['recordGroup', 'template', 'automation', 'postingRule', 'receiptRule', 'script', 'theme', 'action'] as const;
const bodyOf = (kind: DefinitionKind): Body => shipped.find((d) => d.kind === kind)?.body ?? starterBody(kind, 'sample', 'donation');

describe('generic editors with previews', () => {
  it('registers a preview for every x-preview in the schemas, except the page editor', () => {
    const named = new Set<string>();
    const walk = (s: unknown) => {
      if (!s || typeof s !== 'object') return;
      if (Array.isArray(s)) return s.forEach(walk);
      const o = s as Record<string, unknown>;
      if (typeof o['x-preview'] === 'string') named.add(o['x-preview']);
      Object.values(o).forEach(walk);
    };
    for (const kind of DEFINITION_KINDS) walk(schemaOf(kind));
    expect([...named].filter((n) => n !== 'page' && !registered.has(n))).toEqual([]);
    expect([...registered].sort()).toEqual(['cron', 'postingRule', 'recordGroup', 'script', 'template', 'theme']);
  });

  it.each(KINDS)('renders %s with sections, its controls and its preview', (kind) => {
    const body = bodyOf(kind);
    const form = formOf(schemaOf(kind), body);
    expect(formBody(form)).toEqual(body);
    const sections = formSections(form);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.label && s.nodes.length)).toBe(true);
    expect(all(form).filter((n) => n.control === 'json' && n.misfit)).toEqual([]);
    const previews = all(form).flatMap((n) => (n.preview ? [n.preview] : []));
    const expected: Partial<Record<(typeof KINDS)[number], string[]>> = {
      recordGroup: ['recordGroup'],
      template: ['template'],
      postingRule: ['postingRule'],
      script: ['script'],
      theme: ['theme'],
    };
    expect(previews).toEqual(expect.arrayContaining(expected[kind] ?? []));
    for (const p of previews) expect(registered.has(p) || p === 'page', p).toBe(true);
  });

  it('gives the script a code area, theme colours a colour picker, and the schedule its reading', () => {
    expect(at(formOf(schemaOf('script'), bodyOf('script')), 'code')).toMatchObject({ control: 'code' });
    const theme = formOf(schemaOf('theme'), bodyOf('theme'));
    for (const k of ['brand', 'brandForeground', 'background', 'surface', 'text']) expect(at(theme, k), k).toMatchObject({ control: 'colour' });
    expect(at(theme, 'radius')).toMatchObject({ control: 'text' });
    const automation = formOf(schemaOf('automation'), { key: 'a', recordType: 'donation', trigger: { event: 'schedule', cron: '0 9 * * 1' }, actions: [{ type: 'webhook', connector: 'crm' }] });
    expect(at(automation, 'trigger/cron')).toMatchObject({ control: 'text', preview: 'cron', value: '0 9 * * 1' });
    expect(at(automation, 'actions/0/connector')).toMatchObject({ control: 'ref', ref: 'connector' });
    expect(at(automation, 'actions/0/channels')).toMatchObject({ control: 'choices' });
  });

  it('gives actions their form fields and steps as tables, a permission field and connector choices', () => {
    const action = formOf(schemaOf('action'), {
      key: 'push',
      recordType: 'donation',
      label: 'Push',
      placement: ['panel'],
      form: { fields: [{ key: 'note', label: 'Note', type: 'text' }] },
      steps: [{ type: 'webhook', connector: 'crm' }],
    });
    expect(at(action, 'form/fields')).toMatchObject({ control: 'table' });
    expect(at(action, 'steps')).toMatchObject({ control: 'table' });
    expect(at(action, 'permission')).toMatchObject({ control: 'permission' });
    expect(at(action, 'steps/0/connector')).toMatchObject({ control: 'ref', ref: 'connector' });
  });
});
