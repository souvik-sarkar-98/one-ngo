import type { GroupCard } from './groups';
import type { PlannedWidget } from './pages';

/** One task on Home: a link to a form or screen, under the area (the heading of its links widget) it belongs to. */
export interface TaskCard {
  label: string;
  to: string;
  area: string;
}

const norm = (s: string) => s.trim().toLocaleLowerCase();
const has = (text: string | undefined, q: string) => !!text && text.toLocaleLowerCase().includes(q);

/** The tasks of a page: every link of its task-card (wizards) widgets, the widget's label being the area. */
export function taskCards(widgets: readonly PlannedWidget[]): TaskCard[] {
  return widgets.flatMap((w) => (w.kind === 'wizards' ? w.items.map((i) => ({ label: i.label, to: i.to, area: w.label })) : []));
}

/** The areas of the tasks, in the order the page lists them. */
export function taskAreas(cards: readonly TaskCard[]): string[] {
  return [...new Set(cards.map((c) => c.area))];
}

/** The tasks in the chosen area (all when none) whose name or area contains the search. */
export function filterTasks(cards: readonly TaskCard[], area: string | null, query: string): TaskCard[] {
  const q = norm(query);
  return cards.filter((c) => (area === null || c.area === area) && (!q || has(c.label, q) || has(c.area, q)));
}

/** The record groups left after a search: a group whose name matches keeps all its records, else only the records that match. */
export function filterGroups(groups: readonly GroupCard[], query: string): GroupCard[] {
  const q = norm(query);
  if (!q) return [...groups];
  return groups.flatMap((g) => {
    const items = has(g.label, q) ? g.items : g.items.filter((i) => has(i.label, q));
    return items.length ? [{ ...g, items }] : [];
  });
}
