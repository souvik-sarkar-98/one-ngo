import type { BooksInput, MigrationGateway, MigrationJob, MigrationProfile, SourceMapping } from '../admin/migration';

/** A data migration server in memory: files keep their header row, and a run finishes on the second read of its job. */
export function memoryMigrations(): MigrationGateway & { calls: string[]; jobReads: number } {
  const profiles = new Map<string, MigrationProfile>();
  let n = 0;
  let job: MigrationJob | null = null;
  const out = {
    calls: [] as string[],
    jobReads: 0,
    async list() {
      out.calls.push('list');
      return { items: [...profiles.values()].map((p) => ({ id: p.id, name: p.name, status: p.status, files: p.sources.length, createdAt: p.createdAt, updatedAt: p.updatedAt })) };
    },
    async create(name: string) {
      out.calls.push(`create ${name}`);
      const p: MigrationProfile = { id: `m${++n}`, name, status: 'draft', sources: [], books: {}, booksAppliedAt: null, booksResult: null, check: null, jobId: null, createdAt: '2026-11-06', updatedAt: '2026-11-06' };
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
      out.calls.push(`map ${sourceId} ${mapping.targets.map((t) => t.type).join('+')}`);
      const p = profiles.get(id)!;
      p.sources.find((s) => s.id === sourceId)!.mapping = structuredClone(mapping);
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
      p.check = { rows, ready: rows, invalid: 0, creates: rows, updates: 0, sources: [], problems: [], checkedAt: '2026-11-06' };
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
  };
  return out;
}
