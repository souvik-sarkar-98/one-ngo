import { currentTranslator, t } from '../i18n/i18n';
import type { RowView } from '../rows';
import { humanise } from './summary';

type Body = Record<string, unknown>;
export type Path = (string | number)[];

/** The parts of JSON Schema the definition schemas use, plus the Builder's editor annotations. */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  /** An expression on a record type, named by a JSON pointer: absolute (`/recordType`) or relative (`0/recordType`). */
  'x-expression'?: { recordType?: string };
  /** What the value names: a definition kind, `field`, `role`, `connector`, `locale` or `permission`. */
  'x-ref'?: string;
  'x-order'?: number;
  'x-group'?: string;
  'x-preview'?: string;
  /** A text control for a special kind of string: `code` (monospace, Tab indents), `html` (email layout), or `colour` (`#rrggbb` with a picker). */
  'x-control'?: 'code' | 'html' | 'colour';
}

export type LeafControl = 'text' | 'textarea' | 'code' | 'html' | 'colour' | 'number' | 'switch' | 'select' | 'expression' | 'ref' | 'permission' | 'choices' | 'pills' | 'json' | 'fixed';
export type Control = LeafControl | 'object' | 'variant' | 'table' | 'map';

export interface Option {
  value: string;
  label: string;
}

interface NodeBase {
  /** Safe for element ids. */
  id: string;
  path: Path;
  name: string;
  label: string;
  hint: string;
  required: boolean;
  value: unknown;
  schema: JsonSchema;
  group?: string;
  preview?: string;
  /** The value does not fit the schema's control, so it is edited as JSON. */
  misfit?: boolean;
}

export interface LeafNode extends NodeBase {
  control: LeafControl;
  options?: Option[];
  ref?: string;
  integer?: boolean;
  readOnly?: boolean;
  /** The record type an expression is written for. */
  recordType?: string;
}

export interface ObjectNode extends NodeBase {
  control: 'object';
  children: FormNode[];
}

export interface VariantNode extends NodeBase {
  control: 'variant';
  variants: Option[];
  active: number;
  children: FormNode[];
}

export interface TableNode extends NodeBase {
  control: 'table';
  items: FormNode[];
  columns: Option[];
  itemSchema: JsonSchema;
}

export interface MapNode extends NodeBase {
  control: 'map';
  entries: LeafNode[];
  valueSchema: JsonSchema;
}

export type FormNode = LeafNode | ObjectNode | VariantNode | TableNode | MapNode;

/** A visual section of the editor: ungrouped settings, one `x-group`, or one table or object. */
export interface FormSection {
  id: string;
  label: string;
  hint: string;
  nodes: FormNode[];
}

const isObject = (v: unknown): v is Body => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const has = (key: string) => currentTranslator().has(key);
const firstKey = (keys: (string | false | undefined)[]) => keys.find((k): k is string => !!k && has(k));
const domId = (path: Path) => `gen-${path.map((p) => String(p).replace(/[^A-Za-z0-9_-]/g, '_')).join('-') || 'root'}`;
const variantProps = (s: JsonSchema) => !!s.oneOf?.some((v) => v.properties || v.$ref);
const isScalar = (c: Control) => ['text', 'colour', 'number', 'switch', 'select', 'expression', 'ref', 'permission'].includes(c);

export function propertyLabel(name: string, parent = '', schema: JsonSchema = {}): string {
  const key = firstKey([parent && `ui.builder.schema.prop.${parent}.${name}`, `ui.builder.schema.prop.${name}`]);
  return key ? t(key) : (schema.title ?? humanise(name));
}

export function enumLabel(value: unknown): string {
  const key = firstKey([`ui.builder.schema.enum.${String(value)}`, `ui.builder.fieldTypes.${String(value)}`]);
  return key ? t(key) : humanise(String(value));
}

export function groupLabel(id: string): string {
  const key = firstKey([`ui.builder.schema.group.${id}`]);
  return key ? t(key) : humanise(id);
}

/** Follows `#/definitions/…`; keywords beside the `$ref` win over the referenced schema. */
export function resolve(schema: JsonSchema | undefined, root: JsonSchema): JsonSchema {
  if (!schema) return {};
  if (!schema.$ref) return schema;
  const name = /^#\/definitions\/(.+)$/.exec(schema.$ref)?.[1];
  const target = name ? root.definitions?.[name] : undefined;
  const { $ref: _, ...rest } = schema;
  return { ...resolve(target, root), ...rest };
}

function variantsOf(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
  return (schema.oneOf ?? []).map((v) => {
    const r = resolve(v, root);
    return { ...r, properties: { ...schema.properties, ...r.properties }, required: [...(schema.required ?? []), ...(r.required ?? [])] };
  });
}

function variantLabel(variants: JsonSchema[], index: number, root: JsonSchema): string {
  const v = variants[index]!;
  const tag = resolve(v.properties?.['type'], root).const;
  if (tag !== undefined) {
    const key = firstKey([`ui.builder.schema.variant.${String(tag)}`]);
    return key ? t(key) : humanise(String(tag));
  }
  const own = (v.required ?? []).find((r) => variants.every((o, i) => i === index || !(o.required ?? []).includes(r)));
  return own ? propertyLabel(own) : (v.title ?? `#${index + 1}`);
}

/** The variant a value is: the `type` constant first, then the variant whose required properties it has and that knows all its properties. */
function matchVariant(variants: JsonSchema[], value: unknown, root: JsonSchema): number {
  if (!isObject(value)) return -1;
  const tagged = variants.findIndex((v) => {
    const c = resolve(v.properties?.['type'], root).const;
    return c !== undefined && c === value['type'];
  });
  if (tagged >= 0) return tagged;
  return variants.findIndex((v) => (v.required ?? []).every((r) => r in value) && Object.keys(value).every((k) => k in (v.properties ?? {})));
}

/** A starting value: required properties filled in, the first choice of an enum, a constant as it is. */
export function defaultValue(schema: JsonSchema, root: JsonSchema): unknown {
  const s = resolve(schema, root);
  if (variantProps(s)) return defaultValue(variantsOf(s, root)[0]!, root);
  if (s.const !== undefined) return clone(s.const);
  if (s.default !== undefined) return clone(s.default);
  if (s.enum) return clone(s.enum[0]);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'object' || s.properties) {
    const out: Body = {};
    for (const name of s.required ?? []) {
      const v = defaultValue(s.properties?.[name] ?? {}, root);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }
  if (type === 'array') return [];
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return s.minimum ?? 0;
  if (type === 'boolean') return false;
  return undefined;
}

interface Context {
  root: JsonSchema;
  body: Body;
}

function base(s: JsonSchema, value: unknown, path: Path, name: string, required: boolean, parent: string): NodeBase {
  return {
    id: domId(path),
    path,
    name,
    label: propertyLabel(name, parent, s),
    hint: s.description ?? '',
    required,
    value,
    schema: s,
    ...(s['x-group'] ? { group: s['x-group'] } : {}),
    ...(s['x-preview'] ? { preview: s['x-preview'] } : {}),
  };
}

function pointer(body: Body, path: Path, ptr: string): unknown {
  const m = /^(\d+)(\/.*)?$/.exec(ptr);
  const start: Path = m ? path.slice(0, Math.max(0, path.length - 1 - Number(m[1]))) : [];
  const rest = (m ? (m[2] ?? '') : ptr).split('/').filter(Boolean);
  let v: unknown = body;
  for (const p of [...start, ...rest]) v = isObject(v) || Array.isArray(v) ? (v as Body)[p as string] : undefined;
  return v;
}

function json(b: NodeBase, misfit: boolean): LeafNode {
  return { ...b, control: 'json', ...(misfit ? { misfit: true } : {}) };
}

function node(schema: JsonSchema, value: unknown, path: Path, name: string, required: boolean, parent: string, ctx: Context): FormNode {
  const s = resolve(schema, ctx.root);
  const b = base(s, value, path, name, required, parent);
  const type = Array.isArray(s.type) ? (s.type.length === 1 ? s.type[0] : 'union') : s.type;
  const context = typeof path[path.length - 1] === 'number' ? parent : name;

  if (variantProps(s)) {
    const variants = variantsOf(s, ctx.root);
    const active = value === undefined ? 0 : matchVariant(variants, value, ctx.root);
    if (active < 0) return json(b, true);
    return {
      ...b,
      control: 'variant',
      variants: variants.map((_, i) => ({ value: String(i), label: variantLabel(variants, i, ctx.root) })),
      active,
      children: value === undefined ? [] : children(variants[active]!, value as Body, path, context, ctx),
    };
  }
  if (s.const !== undefined) return value === undefined || value === s.const ? { ...b, control: 'fixed' } : json(b, true);
  if (s.enum) {
    if (value !== undefined && !s.enum.includes(value)) return json(b, true);
    return { ...b, control: 'select', options: s.enum.map((e) => ({ value: String(e), label: enumLabel(e) })) };
  }
  if (type === 'string') {
    if (value !== undefined && typeof value !== 'string') return json(b, true);
    const ref = s['x-ref'];
    if (ref === 'permission') return { ...b, control: 'permission' };
    const expr = s['x-expression'];
    if (expr) {
      const rt = expr.recordType ? pointer(ctx.body, path, expr.recordType) : undefined;
      return { ...b, control: 'expression', ...(typeof rt === 'string' && rt ? { recordType: rt } : {}) };
    }
    if (ref) return { ...b, control: 'ref', ref };
    if (s['x-control']) return { ...b, control: s['x-control'] };
    return { ...b, control: (s.maxLength ?? 0) >= 1000 ? 'textarea' : 'text', ...(path.length === 1 && name === 'key' ? { readOnly: true } : {}) };
  }
  if (type === 'number' || type === 'integer') {
    if (value !== undefined && typeof value !== 'number') return json(b, true);
    return { ...b, control: 'number', ...(type === 'integer' ? { integer: true } : {}) };
  }
  if (type === 'boolean') return value === undefined || typeof value === 'boolean' ? { ...b, control: 'switch' } : json(b, true);
  if (type === 'array') {
    if (value !== undefined && !Array.isArray(value)) return json(b, true);
    const list = (value ?? []) as unknown[];
    const items = resolve(s.items, ctx.root);
    if (items.enum) {
      if (!list.every((v) => items.enum!.includes(v))) return json(b, true);
      return { ...b, control: 'choices', options: items.enum.map((e) => ({ value: String(e), label: enumLabel(e) })) };
    }
    if (items.type === 'string' && !items['x-expression']) {
      if (!list.every((v) => typeof v === 'string')) return json(b, true);
      const ref = s['x-ref'] ?? items['x-ref'];
      return { ...b, control: 'pills', ...(ref ? { ref } : {}) };
    }
    if (items.properties || variantProps(items)) {
      const rows = list.map((v, i) => node(items, v, [...path, i], String(i), true, name, ctx));
      return { ...b, control: 'table', items: rows, columns: columns(items, ctx.root), itemSchema: items };
    }
    return json(b, false);
  }
  if (type === 'object' || s.properties || s.additionalProperties) {
    if (value !== undefined && !isObject(value)) return json(b, true);
    if (s.properties) return { ...b, control: 'object', children: value === undefined ? [] : children(s, value as Body, path, context, ctx) };
    const extra = isObject(s.additionalProperties) ? resolve(s.additionalProperties, ctx.root) : undefined;
    if (extra?.type === 'string' && !extra.enum) {
      const valueSchema: JsonSchema = { ...extra, ...(s['x-expression'] ? { 'x-expression': s['x-expression'] } : {}) };
      const entries = Object.entries((value ?? {}) as Body).map(([k, v]) => node(valueSchema, v, [...path, k], k, true, name, ctx));
      if (!entries.every((e) => e.control === 'text' || e.control === 'textarea' || e.control === 'expression')) return json(b, true);
      return { ...b, control: 'map', entries: entries.map((e) => ({ ...e, label: e.name })) as LeafNode[], valueSchema };
    }
  }
  return json(b, false);
}

function children(s: JsonSchema, value: Body, path: Path, parent: string, ctx: Context): FormNode[] {
  const props = Object.entries(s.properties ?? {})
    .map(([name, p], i) => ({ name, p, i, order: resolve(p, ctx.root)['x-order'] ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const required = new Set(s.required ?? []);
  const out = props.map(({ name, p }) => node(p, value[name], [...path, name], name, required.has(name), parent, ctx));
  for (const [name, v] of Object.entries(value)) {
    if (!(name in (s.properties ?? {}))) out.push(json(base({}, v, [...path, name], name, false, parent), true));
  }
  return out;
}

function columns(items: JsonSchema, root: JsonSchema): Option[] {
  if (variantProps(items)) {
    return [
      { value: 'kind', label: t('ui.builder.generic.kind') },
      { value: 'summary', label: t('ui.builder.generic.settings') },
    ];
  }
  const required = new Set(items.required ?? []);
  const scalars = Object.entries(items.properties ?? {}).filter(([, p]) => {
    const r = resolve(p, root);
    const type = Array.isArray(r.type) ? undefined : r.type;
    return (r.enum || type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') && (r.maxLength ?? 0) < 1000 && r.const === undefined;
  });
  const ordered = [...scalars.filter(([n]) => required.has(n)), ...scalars.filter(([n]) => !required.has(n))].slice(0, 4);
  return ordered.map(([n, p]) => ({ value: n, label: propertyLabel(n, '', resolve(p, root)) }));
}

/** The form for a definition body: one object node whose children follow the schema (`x-order`), plus any properties it does not know. */
export function describe(schema: JsonSchema, body: Body): ObjectNode {
  const ctx: Context = { root: schema, body };
  return {
    ...base(schema, body, [], '', true, ''),
    label: schema.title ?? '',
    control: 'object',
    children: children(schema, body, [], '', ctx),
  };
}

/** The body the form shows, read back from its nodes. */
export function formBody(n: FormNode): unknown {
  switch (n.control) {
    case 'object':
    case 'variant': {
      if (n.value === undefined) return undefined;
      const out: Body = {};
      for (const c of n.children) {
        const v = formBody(c);
        if (v !== undefined) out[c.name] = v;
      }
      return out;
    }
    case 'table':
      return n.value === undefined ? undefined : n.items.map(formBody);
    case 'map':
      return n.value === undefined ? undefined : Object.fromEntries(n.entries.map((e) => [e.name, formBody(e)]));
    default:
      return n.value;
  }
}

/** Ungrouped settings first, then each `x-group`, table, map and object in schema order. */
export function formSections(root: ObjectNode): FormSection[] {
  const out: FormSection[] = [];
  const general: FormSection = { id: 'general', label: t('ui.builder.generic.general'), hint: '', nodes: [] };
  const groups = new Map<string, FormSection>();
  for (const c of root.children) {
    if (c.control === 'fixed') continue;
    if (c.group) {
      let g = groups.get(c.group);
      if (!g) {
        g = { id: `group-${c.group}`, label: groupLabel(c.group), hint: '', nodes: [] };
        groups.set(c.group, g);
        out.push(g);
      }
      g.nodes.push(c);
    } else if (c.control === 'object' || c.control === 'variant' || c.control === 'table' || c.control === 'map') {
      out.push({ id: c.id, label: c.label, hint: c.hint, nodes: [c] });
    } else {
      if (!general.nodes.length) out.unshift(general);
      general.nodes.push(c);
    }
  }
  return out;
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** What a leaf's control shows for its value. */
export function display(n: LeafNode): string | boolean | string[] {
  const v = n.value;
  switch (n.control) {
    case 'switch':
      return typeof v === 'boolean' ? v : n.schema.default === true;
    case 'number':
      return typeof v === 'number' ? String(v) : '';
    case 'select':
      return v === undefined ? '' : String(v);
    case 'choices':
    case 'pills':
      return Array.isArray(v) ? v.map(String) : [];
    case 'json':
      return v === undefined ? '' : JSON.stringify(v, null, 2);
    default:
      return typeof v === 'string' ? v : '';
  }
}

/**
 * The value for what was entered in a leaf's control. Optional settings left
 * empty, or a switch left at its default, are removed rather than stored.
 */
export function parse(n: LeafNode, input: string | boolean | string[]): Parsed {
  const empty = !n.required;
  switch (n.control) {
    case 'switch': {
      const on = input === true;
      return { ok: true, value: empty && on === (n.schema.default === true) ? undefined : on };
    }
    case 'number': {
      const text = String(input).trim();
      if (!text) return { ok: true, value: empty ? undefined : n.value };
      const num = Number(text);
      if (!Number.isFinite(num)) return { ok: false, error: t('ui.builder.generic.notNumber') };
      if (n.integer && !Number.isInteger(num)) return { ok: false, error: t('ui.builder.generic.notWholeNumber') };
      return { ok: true, value: num };
    }
    case 'select': {
      if (input === '') return { ok: true, value: empty ? undefined : n.value };
      return { ok: true, value: n.schema.enum?.find((e) => String(e) === input) ?? input };
    }
    case 'choices': {
      const list = (input as string[]).slice();
      const order = n.options?.map((o) => o.value) ?? [];
      const values = order.filter((o) => list.includes(o)).map((o) => n.schema.items?.enum?.find((e) => String(e) === o) ?? o);
      return { ok: true, value: values.length || !empty ? values : undefined };
    }
    case 'pills': {
      const list = input as string[];
      return { ok: true, value: list.length || !empty ? list : undefined };
    }
    case 'json': {
      const text = String(input).trim();
      if (!text) return { ok: true, value: empty ? undefined : n.value };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: t('ui.builder.generic.notJson') };
      }
    }
    default: {
      const text = String(input);
      return { ok: true, value: text === '' && empty ? undefined : text };
    }
  }
}

function update(v: unknown, path: Path, fn: (old: unknown) => unknown): unknown {
  if (!path.length) return fn(v);
  const [head, ...rest] = path;
  if (Array.isArray(v) && typeof head === 'number') return v.map((x, i) => (i === head ? update(x, rest, fn) : x));
  const obj: Body = isObject(v) ? v : {};
  const next = update(obj[head as string], rest, fn);
  if (next === undefined) {
    if (!(head! in obj)) return obj;
    const { [head as string]: _, ...others } = obj;
    return others;
  }
  return head! in obj ? Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, k === head ? next : x])) : { ...obj, [head as string]: next };
}

/** The body with the value at `path` replaced; `undefined` removes the property. Other properties keep their order. */
export function setIn(body: Body, path: Path, value: unknown): Body {
  return update(body, path, () => value) as Body;
}

export function getIn(body: unknown, path: Path): unknown {
  return path.reduce<unknown>((v, p) => (isObject(v) || Array.isArray(v) ? (v as Body)[p as string] : undefined), body);
}

export function addItem(body: Body, table: TableNode, root: JsonSchema): Body {
  const list = Array.isArray(table.value) ? table.value : [];
  return setIn(body, table.path, [...list, defaultValue(table.itemSchema, root)]);
}

export function removeItem(body: Body, table: TableNode, index: number): Body {
  const list = (Array.isArray(table.value) ? table.value : []).filter((_, i) => i !== index);
  return setIn(body, table.path, list.length || table.required ? list : undefined);
}

export function moveItem(body: Body, table: TableNode, from: number, to: number): Body {
  const list = [...(Array.isArray(table.value) ? table.value : [])];
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return setIn(body, table.path, list);
}

/** Switches an item to another variant, keeping the settings both variants have. */
export function switchVariant(body: Body, n: VariantNode, index: number, root: JsonSchema): Body {
  const variant = variantsOf(n.schema, root)[index];
  if (!variant) return body;
  const next = defaultValue(variant, root) as Body;
  const old = isObject(n.value) ? n.value : {};
  for (const [k, v] of Object.entries(old)) {
    if (k in (variant.properties ?? {}) && resolve(variant.properties![k], root).const === undefined) next[k] = v;
  }
  return setIn(body, n.path, next);
}

/** Renames a map entry in place; an empty or taken name changes nothing. */
export function renameEntry(body: Body, map: MapNode, from: string, to: string): Body {
  const entries = isObject(map.value) ? map.value : {};
  if (!to || to === from || to in entries) return body;
  return setIn(body, map.path, Object.fromEntries(Object.entries(entries).map(([k, v]) => [k === from ? to : k, v])));
}

export function addEntry(body: Body, map: MapNode): Body {
  const entries = isObject(map.value) ? map.value : {};
  let n = Object.keys(entries).length + 1;
  while (`value${n}` in entries) n++;
  return setIn(body, map.path, { ...entries, [`value${n}`]: '' });
}

function cell(n: FormNode | undefined): string {
  if (!n || n.value === undefined) return '';
  if (n.control === 'switch') return n.value === true ? '✓' : '';
  if (n.control === 'select') return enumLabel(n.value);
  if (n.control === 'choices') return (n.value as unknown[]).map(enumLabel).join(', ');
  if (n.control === 'pills') return (n.value as string[]).join(', ');
  if (isScalar(n.control) || n.control === 'textarea') return String(n.value);
  return '…';
}

function itemTitle(n: FormNode, index: number): string {
  const v = isObject(n.value) ? n.value : {};
  for (const k of ['label', 'key', 'id', 'name']) if (typeof v[k] === 'string' && v[k]) return v[k] as string;
  if (n.control === 'variant') return n.variants[n.active]?.label ?? '';
  if (typeof v['type'] === 'string') return enumLabel(v['type']);
  return t('ui.builder.generic.item', { number: index + 1 });
}

/** The rows of a table of definition parts, for the editable table. */
export function tableRows(table: TableNode): RowView[] {
  return table.items.map((item, i) => {
    const kids = item.control === 'object' || item.control === 'variant' ? item.children : [];
    const find = (name: string) => kids.find((k) => k.name === name);
    const cells = table.columns.map((c) => {
      if (item.control === 'variant' && c.value === 'kind') return { key: c.value, label: c.label, value: item.variants[item.active]?.label ?? '' };
      if (c.value === 'summary') {
        const parts = kids.filter((k) => isScalar(k.control) && k.name !== 'type' && k.value !== undefined && k.value !== '').map(cell);
        return { key: c.value, label: c.label, value: parts.slice(0, 3).join(' · ') };
      }
      return { key: c.value, label: c.label, value: cell(find(c.value)) };
    });
    return { id: String(i), title: itemTitle(item, i), cells, actions: [] };
  });
}

/** Every leaf of a form, depth first. */
export function leaves(n: FormNode): LeafNode[] {
  switch (n.control) {
    case 'object':
    case 'variant':
      return n.children.flatMap(leaves);
    case 'table':
      return n.items.flatMap(leaves);
    case 'map':
      return n.entries;
    default:
      return [n];
  }
}
