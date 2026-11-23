/** Most signatories one document prints. */
export const SIGNATORIES_PER_DOCUMENT = 4;

/** The set with `id` added at the end; unchanged when it is blank, already there, or the set is full. */
export function withSignatory(ids: readonly string[], id: string): string[] {
  if (!id || ids.includes(id) || ids.length >= SIGNATORIES_PER_DOCUMENT) return [...ids];
  return [...ids, id];
}

/** The set without the signatory at `index`. */
export function withoutSignatory(ids: readonly string[], index: number): string[] {
  return ids.filter((_, at) => at !== index);
}

/** The set with the signatory at `index` moved by `delta` places; unchanged when that goes past either end. */
export function movedSignatory(ids: readonly string[], index: number, delta: number): string[] {
  const to = index + delta;
  if (to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

/** The people not already in the set, for an add box. */
export function notInSet<T extends { id: string }>(people: readonly T[], ids: readonly string[]): T[] {
  return people.filter((person) => !ids.includes(person.id));
}
