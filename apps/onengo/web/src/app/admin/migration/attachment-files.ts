/** A file with the relative path it is uploaded under. */
export interface PickedFile {
  body: Blob;
  name: string;
}

/** Files from a file input; a picked folder (`webkitdirectory`) keeps its folders in `webkitRelativePath`. */
export function pickedFiles(list: FileList | null): PickedFile[] {
  return Array.from(list ?? [], (f) => ({ body: f as Blob, name: f.webkitRelativePath || f.name }));
}

const fileOf = (e: FileSystemFileEntry) => new Promise<File>((ok, no) => e.file(ok, no));

/** Every entry of a directory; `readEntries` answers in chunks until it answers none. */
async function entriesOf(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const chunk = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
    if (!chunk.length) return all;
    all.push(...chunk);
  }
}

async function walk(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    try {
      out.push({ body: await fileOf(entry as FileSystemFileEntry), name: entry.fullPath.replace(/^\/+/, '') });
    } catch {
      // A file that cannot be read is left out, like one the browser did not hand over.
    }
  } else if (entry.isDirectory) {
    for (const child of await entriesOf(entry as FileSystemDirectoryEntry)) await walk(child, out);
  }
}

/**
 * The files of a drop, folders included, each under its path from the dropped folder down. Where the
 * directory API is missing the plain files are used, under their names.
 */
export async function droppedFiles(dt: DataTransfer | null): Promise<PickedFile[]> {
  if (!dt) return [];
  // Entries must be taken during the event: the items are gone once it returns.
  const entries = Array.from(dt.items ?? [], (i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() ?? null : null));
  if (!entries.some((e) => e)) return pickedFiles(dt.files);
  const out: PickedFile[] = [];
  for (const e of entries) if (e) await walk(e, out);
  return out;
}
