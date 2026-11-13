import type { LogFields, Logger, Severity } from '../ports/index.js';

export class JsonLogger implements Logger {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly project = process.env.GOOGLE_CLOUD_PROJECT,
  ) {}
  log(severity: Severity, message: string, fields: LogFields = {}, error?: unknown): void {
    const { trace, ...rest } = fields;
    const entry: Record<string, unknown> = { severity, message, time: new Date().toISOString(), ...rest };
    if (trace) entry[this.project ? 'logging.googleapis.com/trace' : 'trace'] = this.project ? `projects/${this.project}/traces/${trace}` : trace;
    if (error instanceof Error) {
      entry.error = error.message.slice(0, 2000);
      entry.stack = error.stack?.split('\n').slice(0, 15).join('\n');
    } else if (error !== undefined) entry.error = String(error).slice(0, 2000);
    this.write(JSON.stringify(entry));
  }
}
export class MemoryLogger implements Logger {
  readonly entries: { severity: Severity; message: string; fields: LogFields; error?: string }[] = [];
  log(severity: Severity, message: string, fields: LogFields = {}, error?: unknown): void {
    this.entries.push({ severity, message, fields, error: error === undefined ? undefined : String((error as Error)?.message ?? error) });
  }
}
export const silentLogger: Logger = { log: () => undefined };
export const ALERT = {
  outboxFailedPermanently: 'outbox.failed_permanently',
  jobFailed: 'job.failed',
  httpUnhandledError: 'http.unhandled_error',
  memoryHigh: 'memory.high',
} as const;
export type AlertName = (typeof ALERT)[keyof typeof ALERT];
export const DEFAULT_MEMORY_ALERT_MB = 300;
export function checkMemory(logger: Logger, thresholdMb = DEFAULT_MEMORY_ALERT_MB, rss: () => number = () => process.memoryUsage.rss()) {
  const rssMb = Math.round(rss() / (1024 * 1024));
  const high = rssMb > thresholdMb;
  if (high) logger.log('WARNING', 'Memory use is high', { alert: ALERT.memoryHigh, rssMb, thresholdMb });
  return { rssMb, high };
}
