import type { DefinitionBodies, DefinitionKind } from './types.js';

export const TRANSLATABLE_KINDS = ['recordType', 'workflow', 'listView', 'recordGroup', 'page', 'action', 'template'] as const;

type Find = <K extends DefinitionKind>(kind: K, key: string) => DefinitionBodies[K] | undefined;

/**
 * Whether a translation path such as `recordType.donation.fields.amount.label`
 * still names text in a published definition. Array items are found by their
 * `key`, `id` or `value`, or by position for items without one (page
 * widgets). Screen text (`ui.*`) is checked against the shipped
 * catalogue elsewhere, so it always counts as present here.
 */
export function translationTargetExists(path: string, find: Find): boolean {
  const [kind, key, ...rest] = path.split('.');
  if (kind === 'ui') return true;
  if (!kind || !key || !(TRANSLATABLE_KINDS as readonly string[]).includes(kind)) return false;
  let node: unknown = find(kind as DefinitionKind, key);
  for (const seg of rest) {
    if (Array.isArray(node)) {
      node = /^\d+$/.test(seg)
        ? node[Number(seg)]
        : node.find((x) => x && typeof x === 'object' && [x.key, x.id, x.value].includes(seg));
    } else if (node && typeof node === 'object') {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return false;
    }
  }
  return typeof node === 'string';
}
