import { t } from '../i18n/i18n';
import type { DefinitionKind, Issue } from '../models';
import { DraftSession, type DraftOptions, type SaveState } from './draft-session';
import type { AccessMapElement } from './http-access';
import type { BuilderGateway } from './http-builder';

type Body = Record<string, unknown>;

/** One change to a definition body at a JSON pointer. */
export type DraftOp = { op: 'set'; path: string; value: unknown } | { op: 'remove'; path: string };

/** Identifies an element of the access map across reloads. */
export const elementId = (e: Pick<AccessMapElement, 'element' | 'access' | 'definition' | 'label'>): string =>
  `${e.element}:${e.access}:${e.definition ? `${e.definition.kind}/${e.definition.key}${e.definition.path}` : e.label}`;

const segments = (path: string) => path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

/** The object holding the property a pointer names, or null when the path no longer leads anywhere. */
function holderOf(body: unknown, path: string): { holder: Body; prop: string } | null {
  const parts = segments(path);
  const prop = parts.pop();
  if (prop === undefined) return null;
  let at: unknown = body;
  for (const p of parts) {
    if (!at || typeof at !== 'object') return null;
    at = (at as Body)[p];
  }
  return at && typeof at === 'object' && !Array.isArray(at) ? { holder: at as Body, prop } : null;
}

/** The permission an element requires when its definition sets none. */
export function defaultPermission(e: AccessMapElement, body: Body): string | null {
  const item = e.definition ? holderOf(body, e.definition.path)?.holder : undefined;
  const type = e.recordType;
  switch (e.element) {
    case 'field':
      return e.access === 'see' ? `record:${type}:${item?.['sensitive'] === true ? 'sensitive' : 'read'}` : `record:${type}:update`;
    case 'chip':
      return `record:${type}:read`;
    case 'section': {
      const related = item?.['related'] as { recordType?: unknown } | undefined;
      return `record:${typeof related?.recordType === 'string' ? related.recordType : type}:read`;
    }
    case 'step':
      return `record:${type}:transition:${String(item?.['key'] ?? '')}`;
    case 'action':
      return `record:${type}:action:${e.definition?.key ?? ''}`;
    case 'widget':
      return type ? `record:${type}:read` : null;
    default:
      return null;
  }
}

/**
 * The draft operations that make an element require `value`; an empty value
 * or the default removes the setting. A sensitive field given another read
 * permission stops being sensitive, since the two may not disagree. Null when
 * the element is not overridable or its definition no longer has it.
 */
export function permissionOps(e: AccessMapElement, value: string, body: Body): DraftOp[] | null {
  if (!e.overridable || !e.definition) return null;
  const path = e.definition.path;
  const at = holderOf(body, path);
  if (!at) return null;
  const v = value.trim();
  const remove: DraftOp = { op: 'remove', path };
  if (e.element === 'field' && e.access === 'see') {
    const sensitive = at.holder['sensitive'] === true;
    if (!v || v === `record:${e.recordType}:${sensitive ? 'sensitive' : 'read'}`) return [remove];
    const set: DraftOp = { op: 'set', path, value: v };
    return sensitive ? [{ op: 'remove', path: path.replace(/\/readPermission$/, '/sensitive') }, set] : [set];
  }
  if (!v || v === defaultPermission(e, body)) return [remove];
  return [{ op: 'set', path, value: v }];
}

/** A copy of the body with the operations applied. */
export function applyOps(body: Body, ops: DraftOp[]): Body {
  const out = structuredClone(body);
  for (const o of ops) {
    const at = holderOf(out, o.path);
    if (!at) continue;
    if (o.op === 'set') at.holder[at.prop] = o.value;
    else delete at.holder[at.prop];
  }
  return out;
}

/** An inline change waiting to be published: what was typed and the permission the element will then require. */
export interface PendingChange {
  id: string;
  element: AccessMapElement;
  value: string;
  permission: string | null;
}

export interface DraftRef {
  kind: DefinitionKind;
  key: string;
  hasDraft: boolean;
  save: SaveState;
}

export interface AccessDraftsSnapshot {
  pending: PendingChange[];
  /** The definitions the changes belong to, each with its own draft. */
  drafts: DraftRef[];
  busy: boolean;
  error: string;
  issues: Issue[];
  message: string;
}

/**
 * Inline permission changes from the access map, kept as drafts of each
 * owning definition (one draft session per definition) and published
 * together. The server checks and publishes each definition as usual.
 */
export class AccessDrafts {
  private readonly sessions = new Map<string, DraftSession>();
  private readonly pending = new Map<string, PendingChange>();
  private readonly listeners = new Set<(s: AccessDraftsSnapshot) => void>();
  private snap: AccessDraftsSnapshot = { pending: [], drafts: [], busy: false, error: '', issues: [], message: '' };

  constructor(
    private readonly gateway: BuilderGateway,
    private readonly opts: DraftOptions = {},
  ) {}

  get snapshot(): AccessDraftsSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: AccessDraftsSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Makes the element require `value` in a draft of its definition. */
  async change(e: AccessMapElement, value: string): Promise<boolean> {
    if (!e.definition || !e.overridable) return false;
    this.set({ error: '', issues: [], message: '' });
    const session = await this.session(e.definition.kind, e.definition.key);
    const body = session.snapshot.body;
    if (!body) return this.fail(session.snapshot.error || t('ui.builder.access.gone'));
    const ops = permissionOps(e, value, body);
    if (!ops) return this.fail(t('ui.builder.access.gone'));
    const next = applyOps(body, ops);
    session.edit(next);
    const id = elementId(e);
    this.pending.set(id, { id, element: e, value: value.trim(), permission: value.trim() || defaultPermission(e, next) });
    this.emit();
    return true;
  }

  /** Publishes every definition changed here, one after the other; stops at the first the server refuses. */
  async publishAll(): Promise<boolean> {
    this.set({ busy: true, error: '', issues: [], message: '' });
    for (const s of this.sessions.values()) {
      await s.flush();
      if (!s.snapshot.hasDraft) continue;
      if (!(await s.publish())) {
        this.set({ busy: false, error: `${s.kind} ${s.key}: ${s.snapshot.error}`, issues: s.snapshot.saveIssues });
        return false;
      }
    }
    this.pending.clear();
    this.set({ busy: false, message: t('ui.builder.access.published') });
    this.emit();
    return true;
  }

  /** Drops the drafts of every definition changed here. */
  async discardAll(): Promise<void> {
    this.set({ busy: true, error: '', issues: [], message: '' });
    for (const s of this.sessions.values()) if (s.snapshot.hasDraft || s.snapshot.save !== 'saved') await s.discard();
    this.pending.clear();
    this.set({ busy: false, message: t('ui.builder.draftDiscarded') });
    this.emit();
  }

  /** Checks every changed definition; problems carry the definition in their path. */
  async checkAll(): Promise<{ errors: Issue[]; warnings: Issue[] }> {
    this.set({ busy: true, error: '', issues: [], message: '' });
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    for (const s of this.sessions.values()) {
      if (!s.snapshot.hasDraft && s.snapshot.save === 'saved') continue;
      const c = await s.check();
      const at = (i: Issue) => ({ path: `${s.kind}:${s.key}${i.path}`, message: i.message });
      errors.push(...(c?.errors ?? []).map(at));
      warnings.push(...(c?.warnings ?? []).map(at));
    }
    this.set({ busy: false, issues: [...errors, ...warnings], message: errors.length || warnings.length ? '' : t('ui.builder.checkOk') });
    return { errors, warnings };
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) await s.dispose();
    this.listeners.clear();
  }

  private async session(kind: DefinitionKind, key: string): Promise<DraftSession> {
    const id = `${kind}/${key}`;
    let s = this.sessions.get(id);
    if (!s) {
      s = new DraftSession(this.gateway, kind, key, this.opts);
      this.sessions.set(id, s);
      s.subscribe(() => this.emit());
      await s.load();
    }
    return s;
  }

  private fail(error: string): false {
    this.set({ error });
    return false;
  }

  private emit(): void {
    this.set({
      pending: [...this.pending.values()],
      drafts: [...this.sessions.values()]
        .filter((s) => s.snapshot.hasDraft || s.snapshot.save !== 'saved')
        .map((s) => ({ kind: s.kind, key: s.key, hasDraft: s.snapshot.hasDraft, save: s.snapshot.save })),
    });
  }

  private set(change: Partial<AccessDraftsSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}
