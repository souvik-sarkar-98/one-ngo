export type LogArea = 'oidc' | 'payments' | 'storage' | 'smtp' | 'connectors' | 'pwned' | 'fixture';

export interface LogEntry {
  id: number;
  at: string;
  area: LogArea;
  summary: string;
  detail?: unknown;
}

const LIMIT = 500;

/** Every call the fixture answered, newest last, kept in memory only. */
export class FixtureLog {
  private readonly items: LogEntry[] = [];
  private next = 1;

  add(area: LogArea, summary: string, detail?: unknown): LogEntry {
    const entry: LogEntry = { id: this.next++, at: new Date().toISOString(), area, summary, ...(detail === undefined ? {} : { detail }) };
    this.items.push(entry);
    if (this.items.length > LIMIT) this.items.splice(0, this.items.length - LIMIT);
    return entry;
  }

  list(): readonly LogEntry[] {
    return this.items;
  }
}
