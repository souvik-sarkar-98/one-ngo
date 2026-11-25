import { applyExtensionPatch, makePatch } from './merge.js';
import type { DefinitionKind } from './types.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Module options were retired for `hidden` on each definition. These are the shapes an organisation
 * saved while they existed (setting `modules.options`), kept only to move those choices over once.
 */
export interface LegacyOptionHide {
  kind: DefinitionKind;
  key: string;
  path?: string;
  value?: string | number | boolean;
  where?: Record<string, string | number | boolean>;
}

export interface LegacyOption {
  key: string;
  label: string;
  hides?: LegacyOptionHide[];
  revokes?: { role?: string; permission: string }[];
}

export interface LegacyOptionState {
  options: LegacyOption[];
  off: string[];
}

/** What the options an organisation turned off become. */
export interface LegacyOptionPlan {
  /** Record types an off option took out of a record group: now `hidden`. */
  hiddenTypes: Set<string>;
  /** Definitions an off option took out whole: now turned off, as `kind|key`. */
  disabled: Set<string>;
  /** Other parts an off option took out of a definition, by `kind|key`. */
  partHides: Map<string, LegacyOptionHide[]>;
  /** Setup roles an off option took permissions from, by module. */
  revokedRoles: Map<string, { role?: string }[]>;
}

/** Sorts the off options of every module into what replaces them. */
export function planLegacyOptions(states: Record<string, LegacyOptionState>): LegacyOptionPlan {
  const plan: LegacyOptionPlan = { hiddenTypes: new Set(), disabled: new Set(), partHides: new Map(), revokedRoles: new Map() };
  for (const [moduleKey, state] of Object.entries(states)) {
    for (const option of (state.options ?? []).filter((o) => state.off?.includes(o.key))) {
      for (const h of option.hides ?? []) {
        if (h.path === undefined) plan.disabled.add(`${h.kind}|${h.key}`);
        else if (h.kind === 'recordGroup' && h.path === '/recordTypes' && typeof h.value === 'string') plan.hiddenTypes.add(h.value);
        else {
          const id = `${h.kind}|${h.key}`;
          plan.partHides.set(id, [...(plan.partHides.get(id) ?? []), h]);
        }
      }
      if (option.revokes?.length) plan.revokedRoles.set(moduleKey, [...(plan.revokedRoles.get(moduleKey) ?? []), ...option.revokes.map((r) => ({ role: r.role }))]);
    }
  }
  return plan;
}

function matches(item: unknown, hide: LegacyOptionHide): boolean {
  if (hide.where) return isObject(item) && Object.entries(hide.where).every(([k, v]) => item[k] === v);
  return item === hide.value;
}

/** The array a path points at, or undefined when the path leads nowhere. A segment `name=value` picks an array item. */
function arrayAt(root: Json, path: string): Json[] | undefined {
  let at: Json | undefined = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (Array.isArray(at)) {
      const eq = segment.indexOf('=');
      if (eq <= 0) return undefined;
      const name = segment.slice(0, eq);
      const value = segment.slice(eq + 1);
      at = at.find((i) => isObject(i) && String(i[name]) === value);
    } else if (isObject(at)) at = at[segment];
    else return undefined;
    if (at === undefined) return undefined;
  }
  return Array.isArray(at) ? at : undefined;
}

/** `body` without what the hides took out. The input is not changed. */
export function withoutParts<T>(body: T, hides: LegacyOptionHide[]): T {
  const out = structuredClone(body) as Json;
  for (const hide of hides) {
    const list = hide.path === undefined ? undefined : arrayAt(out, hide.path);
    if (!list) continue;
    for (let i = list.length - 1; i >= 0; i--) if (matches(list[i], hide)) list.splice(i, 1);
  }
  return out as T;
}

/**
 * The organisation's patch that keeps what it saw while the options were off: the parts the options took
 * out, applied to the shipped definition with its own patch, as one patch on the shipped definition.
 */
export function patchKeepingParts(base: unknown, patch: unknown, hides: LegacyOptionHide[], hidden: boolean): unknown {
  const seen = applyExtensionPatch(withoutParts(base, hides), patch ?? {}) as Record<string, unknown>;
  return makePatch(base, hidden ? { ...seen, hidden: true } : seen) ?? {};
}
