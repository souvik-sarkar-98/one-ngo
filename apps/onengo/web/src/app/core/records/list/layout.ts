import type { ListLayout } from '../../models';

const LAYOUT_KEY = 'ngo.listLayout';

/** The wide-screen layout this person last chose for a record type, else the list view's default, else the table. */
export function preferredLayout(tenantKey: string, typeKey: string, fallback: ListLayout | undefined, store: Pick<Storage, 'getItem'> = localStorage): ListLayout {
  const saved = store.getItem(`${LAYOUT_KEY}.${tenantKey}.${typeKey}`);
  if (saved === 'cards' || saved === 'table') return saved;
  return fallback === 'cards' ? 'cards' : 'table';
}

/** Phones always get cards; wider screens use the address bar's choice, then the person's, then the list view's. */
export function listLayout(narrow: boolean, chosen: ListLayout | undefined, preferred: () => ListLayout): ListLayout {
  return narrow ? 'cards' : (chosen ?? preferred());
}

export function rememberLayout(tenantKey: string, typeKey: string, layout: ListLayout, store: Pick<Storage, 'setItem'> = localStorage): void {
  store.setItem(`${LAYOUT_KEY}.${tenantKey}.${typeKey}`, layout);
}
