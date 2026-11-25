import { isPeopleMapping, targetsOf, type AttachmentQuery, type BooksInput, type MigrationAttachment, type MigrationGateway, type MigrationJob, type MigrationProfile, type SourceMapping } from '../admin/migration';

/** A data migration server in memory: files keep their header row, and a run finishes on the second read of its job. */
export function memoryMigrations(): MigrationGateway & { calls: string[]; jobReads: number } {
  const profiles = new Map<string, MigrationProfile>();
  let n = 0;
  let job: MigrationJob | null = null;
  const files = new Map<string, MigrationAttachment[]>();
  const held = (id: string) => files.get(id) ?? [];
  /** Totals and draft status after attachments change, as the server does (a change sends the profile back to draft). */
  const settleFiles = (id: string) => {
    const p = profiles.get(id)!;
    p.attachments = { count: held(id).length, bytes: held(id).reduce((k, a) => k + a.size, 0) };
    p.status = 'draft';
    p.check = null;
  };
  const out = {
    calls: [] as string[],
    jobReads: 0,
    async list() {
      out.calls.push('list');
      return { items: [...profiles.values()].map((p) => ({ id: p.id, name: p.name, status: p.status, files: p.sources.length, createdAt: p.createdAt, updatedAt: p.updatedAt })) };
    },
    async create(name: string) {
      out.calls.push(`create ${name}`);
      const p: MigrationProfile = { id: `m${++n}`, name, status: 'draft', sources: [], books: {}, booksAppliedAt: null, booksResult: null, check: null, jobId: null, attachments: { count: 0, bytes: 0 }, purgedAt: null, createdAt: '2026-11-06', updatedAt: '2026-11-06' };
      profiles.set(p.id, p);
      return structuredClone(p);
    },
    async get(id: string) {
      const p = profiles.get(id);
      if (!p) throw Object.assign(new Error('Migration not found.'), { code: 'not_found' });
      return structuredClone(p);
    },
    async addSource(id: string, file: Blob, fileName: string) {
      out.calls.push(`add ${fileName}`);
      if (!fileName.endsWith('.csv')) throw Object.assign(new Error('Choose a CSV file (.csv).'), { code: 'validation_failed' });
      const p = profiles.get(id)!;
      const [head = '', ...rows] = (await file.text()).split('\n').filter(Boolean);
      p.sources.push({
        id: `s${++n}`,
        kind: 'records',
        fileName,
        columns: head.split(',').map((name, i) => ({ name, samples: rows.slice(0, 3).map((r) => r.split(',')[i] ?? '') })),
        rowCount: rows.length,
        position: p.sources.length,
        mapping: null,
        counts: null,
      });
      p.status = 'draft';
      return structuredClone(p);
    },
    async removeSource(id: string, sourceId: string) {
      const p = profiles.get(id)!;
      p.sources = p.sources.filter((s) => s.id !== sourceId);
      return structuredClone(p);
    },
    async setMapping(id: string, sourceId: string, mapping: SourceMapping) {
      out.calls.push(`map ${sourceId} ${isPeopleMapping(mapping) ? 'people' : targetsOf(mapping).map((t) => t.type).join('+')}`);
      const p = profiles.get(id)!;
      const source = p.sources.find((s) => s.id === sourceId)!;
      source.mapping = structuredClone(mapping);
      source.kind = isPeopleMapping(mapping) ? 'people' : 'records';
      // People load first, as the server orders them.
      p.sources.sort((a, b) => Number(b.kind === 'people') - Number(a.kind === 'people'));
      p.sources.forEach((s, position) => (s.position = position));
      p.status = 'draft';
      return structuredClone(p);
    },
    async setOrder(id: string, sourceIds: string[]) {
      out.calls.push(`order ${sourceIds.join(',')}`);
      const p = profiles.get(id)!;
      p.sources = sourceIds.map((sid, position) => ({ ...p.sources.find((s) => s.id === sid)!, position }));
      return structuredClone(p);
    },
    async setBooks(id: string, books: BooksInput) {
      const p = profiles.get(id)!;
      p.books = structuredClone(books);
      return structuredClone(p);
    },
    async applyBooks(id: string) {
      const p = profiles.get(id)!;
      p.booksAppliedAt = '2026-11-06T00:00:00.000Z';
      return structuredClone(p);
    },
    async check(id: string) {
      const p = profiles.get(id)!;
      const rows = p.sources.reduce((k, s) => k + s.rowCount, 0);
      p.check = { rows, ready: rows, invalid: 0, creates: rows, updates: 0, sources: [], problems: [], warnings: [], checkedAt: '2026-11-06' };
      p.status = 'checked';
      return structuredClone(p);
    },
    async run(id: string) {
      const p = profiles.get(id)!;
      p.status = 'running';
      p.jobId = 'job1';
      job = { id: 'job1', status: 'running', progress: 0, total: p.check?.rows ?? 0, error: null, cancelRequested: false };
      return structuredClone(p);
    },
    async cancel(id: string) {
      if (job) job.cancelRequested = true;
      return structuredClone(profiles.get(id)!);
    },
    async job() {
      out.jobReads++;
      if (!job) throw new Error('no job');
      if (out.jobReads >= 2) {
        job.status = 'done';
        job.progress = job.total ?? 0;
        for (const p of profiles.values()) if (p.jobId === job.id) p.status = 'done';
      }
      return { ...job };
    },
    async failedRows() {
      return { fileName: 'Failed rows.csv', body: new Blob(['a\n']) };
    },
    async addAttachment(id: string, file: Blob, path: string) {
      out.calls.push(`attach ${path}`);
      if (profiles.get(id)?.status === 'running') throw Object.assign(new Error('The migration is running.'), { code: 'conflict' });
      const list = held(id);
      if (list.some((a) => a.path.toLowerCase() === path.toLowerCase())) throw Object.assign(new Error(`The attachment ${path} is already there.`), { code: 'conflict' });
      list.push({ id: `a${++n}`, path, size: file.size, mime: file.type || 'application/octet-stream', usedBy: 0 });
      files.set(id, list);
      settleFiles(id);
      return { ...profiles.get(id)!.attachments! };
    },
    async attachments(id: string, query: AttachmentQuery = {}) {
      const q = (query.q ?? '').toLowerCase();
      const all = held(id).filter((a) => a.path.toLowerCase().includes(q));
      return { items: structuredClone(all.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50))), total: all.length };
    },
    async removeAttachment(id: string, attachmentId: string) {
      out.calls.push(`unattach ${attachmentId}`);
      files.set(id, held(id).filter((a) => a.id !== attachmentId));
      settleFiles(id);
    },
    async clearAttachments(id: string) {
      out.calls.push('clear attachments');
      files.set(id, []);
      settleFiles(id);
    },
    async purge(id: string) {
      out.calls.push('purge');
      const p = profiles.get(id)!;
      if (p.status === 'running') throw Object.assign(new Error('The migration is running.'), { code: 'conflict' });
      files.set(id, []);
      p.attachments = { count: 0, bytes: 0 };
      p.purgedAt = '2026-11-25T00:00:00.000Z';
      for (const s of p.sources) {
        s.purgedAt = p.purgedAt;
        s.columns = s.columns.map((c) => ({ name: c.name, samples: [] }));
      }
      return structuredClone(p);
    },
  };
  return out;
}
