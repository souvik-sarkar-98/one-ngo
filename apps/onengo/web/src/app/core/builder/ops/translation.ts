export interface TranslationBody {
  key: string;
  locale: string;
  entries: Record<string, string>;
}

/** Sets the organisation's wording for a path; clearing it removes the entry, so the app's translation or English shows. */
export function setEntry(body: TranslationBody, path: string, value: string): TranslationBody {
  const entries = { ...body.entries };
  if (value.trim()) entries[path] = value;
  else delete entries[path];
  return { ...body, entries };
}

/** Removes entries, e.g. those whose path names nothing any more. */
export function removeEntries(body: TranslationBody, paths: readonly string[]): TranslationBody {
  const entries = { ...body.entries };
  for (const p of paths) delete entries[p];
  return { ...body, entries };
}
