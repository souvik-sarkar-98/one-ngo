/** A message as `GET /inbox` lists it. */
export interface MailSummary {
  id: number;
  threadId: string;
  at: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
}

/** One message as `GET /inbox/{id}` returns it. */
export interface MailView extends MailSummary {
  text: string;
  html: string;
}

/** The three ways to read a message. */
export type MailPane = 'html' | 'text' | 'raw';

/** True when the sender, a recipient or the subject contains the query, ignoring case. An empty query matches all. */
export function matchesQuery(message: MailSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [message.fromName, message.from, message.subject, ...message.to, ...message.cc].join('\n').toLowerCase().includes(needle);
}

/** "Name <address>" when the sender has a display name, otherwise the address. */
export function senderLine(message: Pick<MailSummary, 'from' | 'fromName'>): string {
  return message.fromName && message.fromName !== message.from ? `${message.fromName} <${message.from}>` : message.from;
}

/** The list's short sender label. */
export function senderName(message: Pick<MailSummary, 'from' | 'fromName'>): string {
  return message.fromName || message.from || '(unknown sender)';
}

/** The message id in a `#<id>` address fragment, or null. */
export function idFromHash(hash: string): number | null {
  const match = /^#(\d+)$/.exec(hash);
  return match ? Number(match[1]) : null;
}

/**
 * A complete document for the HTML pane. The pane's iframe is sandboxed without scripts, and this
 * policy also blocks every request except inline styles and data images, so a message cannot call out.
 */
export function htmlDocument(html: string): string {
  return (
    '<!doctype html><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    '<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:16px}</style>' +
    html
  );
}
