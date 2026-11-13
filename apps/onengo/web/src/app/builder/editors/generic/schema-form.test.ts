import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addEntry,
  addItem,
  defaultValue,
  describe as formOf,
  display,
  formBody,
  formSections,
  leaves,
  moveItem,
  parse,
  removeItem,
  renameEntry,
  resolve,
  setIn,
  switchVariant,
  tableRows,
  type FormNode,
  type JsonSchema,
  type ObjectNode,
  type LeafNode,
  type MapNode,
  type TableNode,
  type VariantNode,
} from '../../../core/builder/schema-form';
import { ENGLISH } from '../../../core/i18n/i18n';
import { DEFINITION_KINDS, type DefinitionKind } from '../../../core/models';
import { starterBody } from '../../../core/starters';

type Body = Record<string, unknown>;

const repo = join(import.meta.dirname, '../../../../../../../..', 'packages/product');
const schemaOf = (kind: string) => JSON.parse(readFileSync(join(repo, 'schemas', `${kind}.schema.json`), 'utf8')) as JsonSchema;
const moduleDefinitions = readdirSync(join(repo, 'modules/donations'))
  .filter((f) => f !== 'module.json' && f.endsWith('.json'))
  .map((f) => ({ file: f, kind: /\.(\w+)\.json$/.exec(f)![1] as DefinitionKind, body: JSON.parse(readFileSync(join(repo, 'modules/donations', f), 'utf8')) as Body }));

const find = (n: FormNode, ...names: (string | number)[]): FormNode => {
  let at: FormNode = n;
  for (const name of names) {
    const kids: FormNode[] = at.control === 'object' || at.control === 'variant' ? at.children : at.control === 'table' ? at.items : at.control === 'map' ? at.entries : [];
    const next = kids.find((k) => k.name === String(name));
    if (!next) throw new Error(`no ${String(name)} under ${at.path.join('/')}`);
    at = next;
  }
  return at;
};

/** Optional settings left empty or at their default read back as absent, which means the same. */
const atDefault = (l: LeafNode) =>
  !l.required && (l.value === '' || (Array.isArray(l.value) && !l.value.length) || (l.control === 'switch' && l.value === (l.schema.default === true)));

function expectLossless(kind: string, body: Body): ObjectNode {
  const form = formOf(schemaOf(kind), body);
  expect(formBody(form), kind).toEqual(body);
  expect(leaves(form).filter((l) => l.misfit).map((l) => l.path.join('/')), kind).toEqual([]);
  for (const l of leaves(form)) {
    if (l.control === 'fixed') continue;
    const back = parse({ ...l, value: undefined }, display(l));
    expect(back.ok, l.path.join('/')).toBe(true);
    if (back.ok && !atDefault(l)) expect(back.value, `${kind} ${l.path.join('/')}`).toEqual(l.value);
  }
  return form;
}

describe('generic schema editor: body → form → body', () => {
  it('is lossless for every definition of the shipped module', () => {
    expect(moduleDefinitions.length).toBeGreaterThanOrEqual(14);
    expect(new Set(moduleDefinitions.map((d) => d.kind))).toEqual(
      new Set(['recordType', 'workflow', 'listView', 'recordGroup', 'template', 'automation', 'postingRule', 'receiptRule', 'action', 'report', 'reportGroup']),
    );
    for (const d of moduleDefinitions) expectLossless(d.kind, d.body);
  });

  it('renders every kind from its schema, starting from the starter body', () => {
    for (const kind of DEFINITION_KINDS) {
      const form = expectLossless(kind, starterBody(kind, 'sample', 'donation'));
      const sections = formSections(form);
      expect(sections.length, kind).toBeGreaterThan(0);
      expect(sections.every((s) => s.label && s.nodes.length), kind).toBe(true);
      expect(find(form, 'key')).toMatchObject({ control: 'text', readOnly: true });
    }
  });

  it('gives a message template a plain message and an email HTML box', () => {
    const form = formOf(schemaOf('template'), { key: 'thanks', subject: 'Hello', body: 'Plain', html: '<p>Hi</p>' });
    const sections = formSections(form).map((s) => s.label);
    expect(sections).toEqual(['General', 'Message', 'Email', 'WhatsApp template']);
    expect(find(form, 'body')).toMatchObject({ control: 'textarea', group: 'message' });
    expect(find(form, 'html')).toMatchObject({ control: 'html', group: 'email' });
  });

  it('keeps settings the schema does not know, as JSON', () => {
    const body = { key: 'k', subject: 'S', body: 'B', legacy: { a: 1 } };
    const form = formOf(schemaOf('template'), body);
    expect(find(form, 'legacy')).toMatchObject({ control: 'json', misfit: true });
    expect(formBody(form)).toEqual(body);
  });
});

describe('generic schema editor: controls from the schema', () => {
  const action = moduleDefinitions.find((d) => d.file === 'send-reminder.action.json')!.body;
  const form = formOf(schemaOf('action'), action);

  it('turns objects, tables, choices, enums and annotations into controls', () => {
    expect(find(form, 'placement')).toMatchObject({ control: 'choices', label: 'Shown in' });
    expect(find(form, 'recordType')).toMatchObject({ control: 'ref', ref: 'recordType' });
    expect(find(form, 'permission')).toMatchObject({ control: 'permission' });
    expect(find(form, 'when')).toMatchObject({ control: 'expression', recordType: 'donation' });
    expect(find(form, 'steps')).toMatchObject({ control: 'table' });
    expect(find(form, 'steps', 0, 'type')).toMatchObject({ control: 'select' });
    expect(find(form, 'steps', 0, 'template')).toMatchObject({ control: 'ref', ref: 'template' });
    expect(find(form, 'steps', 0, 'to')).toMatchObject({ control: 'object', label: 'Send to' });
    expect(find(form, 'steps', 0, 'to', 'roles').control).toBe('pills');
  });

  it('orders by x-order and groups by x-group, ungrouped settings first', () => {
    expect(formSections(form).map((s) => s.label)).toEqual(['General', 'Shown when', 'Confirm', 'Form fields', 'Steps']);
    expect(formSections(form)[0]!.nodes.map((n) => n.name)).toEqual(['key', 'recordType', 'label', 'placement', 'permission']);
  });

  it('describes each table row with its title and columns', () => {
    const steps = find(form, 'steps') as TableNode;
    expect(steps.columns.map((c) => c.value)).toEqual(['type', 'transition', 'recordType', 'template']);
    const rows = tableRows(steps);
    expect(rows).toHaveLength((action['steps'] as unknown[]).length);
    expect(rows[0]!.cells.find((c) => c.key === 'type')!.value).toBe('Notify people');
  });

  it('gives every permission in the schemas a permission field', () => {
    const missing: string[] = [];
    for (const kind of [...DEFINITION_KINDS, 'module']) {
      const root = schemaOf(kind);
      const walk = (s: JsonSchema | undefined, at: string) => {
        if (!s || typeof s !== 'object') return;
        for (const [name, p] of Object.entries(s.properties ?? {})) {
          const r = resolve(p, root);
          if (/^(permission|readPermission|editPermission|permissions)$/.test(name) && r['x-ref'] !== 'permission') missing.push(`${kind} ${at}/${name}`);
          walk(r, `${at}/${name}`);
        }
        if (s.items) walk(resolve(s.items, root), `${at}[]`);
        for (const v of s.oneOf ?? []) walk(resolve(v, root), at);
        if (typeof s.additionalProperties === 'object') walk(resolve(s.additionalProperties, root), `${at}{}`);
      };
      walk(root, '');
      for (const d of Object.values(root.definitions ?? {})) walk(d, '#');
    }
    expect(missing).toEqual([]);
  });

  it('names every property, choice, group and variant in the English catalogue', () => {
    const missing = new Set<string>();
    for (const kind of DEFINITION_KINDS) {
      const walk = (s: unknown) => {
        if (!s || typeof s !== 'object') return;
        if (Array.isArray(s)) return s.forEach(walk);
        const o = s as JsonSchema & Record<string, unknown>;
        for (const name of Object.keys(o.properties ?? {})) if (!(`ui.builder.schema.prop.${name}` in ENGLISH)) missing.add(`prop.${name}`);
        for (const e of o.enum ?? []) if (!(`ui.builder.schema.enum.${String(e)}` in ENGLISH) && !(`ui.builder.fieldTypes.${String(e)}` in ENGLISH)) missing.add(`enum.${String(e)}`);
        if (o['x-group'] && !(`ui.builder.schema.group.${o['x-group']}` in ENGLISH)) missing.add(`group.${o['x-group']}`);
        if (o.const !== undefined && !(`ui.builder.schema.variant.${String(o.const)}` in ENGLISH)) missing.add(`variant.${String(o.const)}`);
        for (const [k, v] of Object.entries(o)) if (k !== 'enum' && k !== 'const') walk(v);
      };
      walk(schemaOf(kind));
    }
    expect([...missing]).toEqual([]);
  });

  it('reads the record type of an expression from a relative pointer', () => {
    const body = {
      key: 'donor',
      label: 'Donor',
      fields: [{ key: 'given', label: 'Given', type: 'number', rollup: { recordType: 'donation', reference: 'donor', measure: 'sum', field: 'amount', where: "status == 'paid'" } }],
    };
    const f = formOf(schemaOf('recordType'), body);
    expect(find(f, 'fields', 0, 'rollup', 'where')).toMatchObject({ control: 'expression', recordType: 'donation' });
    expect(find(f, 'fields', 0, 'visibleWhen')).toMatchObject({ control: 'expression', recordType: 'donor' });
  });

  it('draws page widgets as variants and their filters as JSON', () => {
    const page = {
      key: 'home',
      label: 'Home',
      widgets: [
        { type: 'stat', label: 'Raised', recordType: 'donation', measure: 'sum', field: 'amount', view: { filters: { status: { in: ['paid'] } } } },
        { type: 'links', label: 'Go', items: [{ label: 'Donations', to: '/records/donation', permission: 'record:donation:read' }] },
        { type: 'groups' },
      ],
    };
    const f = expectLossless('page', page);
    const stat = find(f, 'widgets', 0) as VariantNode;
    expect(stat.variants[stat.active]!.label).toBe('Number');
    expect(find(f, 'widgets', 0, 'view', 'filters')).toMatchObject({ control: 'json' });
    expect(find(f, 'widgets', 1, 'items', 0, 'to').label).toBe('Address');
    expect(find(f, 'widgets', 1, 'items', 0, 'permission')).toMatchObject({ control: 'permission', label: 'Shown to people with' });
    expect(tableRows(find(f, 'widgets') as TableNode).map((r) => r.title)).toEqual(['Raised', 'Go', 'Record groups']);
  });
});

describe('generic schema editor: edits', () => {
  const schema = schemaOf('action');
  const body: Body = { key: 'remind', recordType: 'donation', label: 'Remind', placement: ['panel'], steps: [{ type: 'notify', template: 't' }] };

  it('replaces one value and removes optional settings left empty, keeping the order of the rest', () => {
    const form = formOf(schema, body);
    const label = find(form, 'label') as LeafNode;
    const next = setIn(body, label.path, (parse(label, 'Send a reminder') as { value: unknown }).value);
    expect(Object.keys(next)).toEqual(Object.keys(body));
    expect(next['label']).toBe('Send a reminder');
    const confirm = find(form, 'confirm') as LeafNode;
    expect(parse(confirm, '')).toEqual({ ok: true, value: undefined });
    expect(setIn({ ...body, confirm: 'Sure?' }, ['confirm'], undefined)).toEqual(body);
    expect(parse(find(form, 'placement') as LeafNode, ['bulk', 'panel'])).toEqual({ ok: true, value: ['panel', 'bulk'] });
  });

  it('checks numbers and JSON, and leaves switches at their default out', () => {
    const automation = formOf(schemaOf('automation'), { key: 'a', recordType: 'donation', trigger: { event: 'created' }, actions: [{ type: 'notify' }] });
    const enabled = find(automation, 'enabled') as LeafNode;
    expect(display(enabled)).toBe(true);
    expect(parse(enabled, false)).toEqual({ ok: true, value: false });
    expect(parse(enabled, true)).toEqual({ ok: true, value: undefined });
    const group = formOf(schemaOf('recordGroup'), { key: 'g', label: 'G', recordTypes: ['donation'] });
    const order = find(group, 'order') as LeafNode;
    expect(parse(order, '2.5')).toMatchObject({ ok: false });
    expect(parse(order, 'abc')).toMatchObject({ ok: false });
    expect(parse(order, '3')).toEqual({ ok: true, value: 3 });
    expect(parse({ ...order, control: 'json' }, '{')).toMatchObject({ ok: false });
  });

  it('adds, moves and removes table rows with their required settings', () => {
    const steps = find(formOf(schema, body), 'steps') as TableNode;
    const added = addItem(body, steps, schema);
    expect(added['steps']).toEqual([{ type: 'notify', template: 't' }, { type: 'setFields' }]);
    const moved = moveItem(added, find(formOf(schema, added), 'steps') as TableNode, 1, 0);
    expect((moved['steps'] as Body[]).map((s) => s['type'])).toEqual(['setFields', 'notify']);
    const removed = removeItem(moved, find(formOf(schema, moved), 'steps') as TableNode, 0);
    expect(removed['steps']).toEqual([{ type: 'notify', template: 't' }]);
    expect(removeItem(removed, find(formOf(schema, removed), 'steps') as TableNode, 0)['steps']).toEqual([]);
  });

  it('switches a widget to another kind, keeping what both kinds have', () => {
    const page = schemaOf('page');
    const p: Body = { key: 'home', label: 'Home', widgets: [{ type: 'stat', label: 'Raised', permission: 'p', recordType: 'donation', measure: 'count' }] };
    const widget = find(formOf(page, p), 'widgets', 0) as VariantNode;
    const links = widget.variants.findIndex((v) => v.label === 'Links');
    expect(switchVariant(p, widget, links, page)['widgets']).toEqual([{ type: 'links', label: 'Raised', permission: 'p', items: [] }]);
    expect(defaultValue(page.properties!['widgets']!.items!, page)).toEqual({ type: 'groups' });
  });

  it('adds and renames name–value entries', () => {
    const b: Body = { ...body, steps: [{ type: 'setFields', values: { paidOn: 'today()' } }] };
    const values = find(formOf(schema, b), 'steps', 0, 'values') as MapNode;
    expect(values.entries[0]).toMatchObject({ control: 'expression', recordType: 'donation' });
    const added = addEntry(b, values);
    expect((added['steps'] as Body[])[0]!['values']).toEqual({ paidOn: 'today()', value2: '' });
    const renamed = renameEntry(added, find(formOf(schema, added), 'steps', 0, 'values') as MapNode, 'value2', 'note');
    expect(Object.keys((renamed['steps'] as Body[])[0]!['values'] as Body)).toEqual(['paidOn', 'note']);
    expect(renameEntry(renamed, find(formOf(schema, renamed), 'steps', 0, 'values') as MapNode, 'note', 'paidOn')).toBe(renamed);
  });
});
