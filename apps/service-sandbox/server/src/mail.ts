import { timingSafeEqual } from 'node:crypto';
import { MAIL, PATHS } from './constants.js';
import { bearer, readJson, sendJson, sendText, type Handler } from './http.js';
import type { FixtureLog } from './log.js';

/** One message accepted by the Gmail-style send endpoint. `to` holds bare addresses. */
export interface MailMessage {
  id: number;
  threadId: string;
  at: string;
  /** Bare From address, or the decoded header when it has no address. */
  from: string;
  /** Display name when the From header has one, otherwise the address. */
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string;
  raw: string;
}

const MAX_MESSAGES = 200;
const GMAIL_SEND = /^\/gmail\/v1\/users\/[^/]+\/messages\/send$/;

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const gmailError = (code: 400 | 401, status: string, message: string) => ({ error: { code, message, status } });

function decodeWords(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, enc: string, text: string) =>
    enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64').toString('utf8') : decodeURIComponent(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1')),
  );
}

function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"' && !angle) quote = !quote;
    else if (ch === '<' && !quote) angle = true;
    else if (ch === '>' && !quote) angle = false;
    if (ch === ',' && !quote && !angle) {
      if (current.trim()) parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const addressOf = (part: string) => (/<([^<>]+)>/.exec(part)?.[1] ?? part).trim();

function recipients(header: string | undefined): string[] {
  return splitAddresses(decodeWords(header ?? ''))
    .map(addressOf)
    .filter((address) => address.includes('@'));
}

function sender(header: string | undefined): { name: string; address: string } {
  const decoded = decodeWords(header ?? '').trim();
  const address = recipients(header)[0] ?? '';
  const named = /^(.*?)\s*<[^<>]*>\s*$/.exec(decoded);
  const name = named?.[1]?.replace(/^"(.*)"$/, '$1').trim();
  return { name: name || address || decoded, address: address || decoded };
}

function headerMap(head: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

function splitMessage(raw: string): { headers: Map<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  return { headers: headerMap(match ? raw.slice(0, match.index) : raw), body: match ? raw.slice(match.index + match[0].length) : '' };
}

function contentType(header: string | undefined): { type: string; boundary?: string; charset?: string } {
  if (!header) return { type: 'text/plain' };
  const [type = 'text/plain', ...params] = header.split(';').map((part) => part.trim());
  const param = (name: string) => {
    const hit = params.find((part) => part.toLowerCase().startsWith(`${name}=`));
    return hit?.slice(name.length + 1).trim().replace(/^"(.*)"$/, '$1');
  };
  const boundary = param('boundary');
  const charset = param('charset');
  return { type: type.toLowerCase(), ...(boundary ? { boundary } : {}), ...(charset ? { charset } : {}) };
}

function quotedPrintable(body: string): Buffer {
  const stripped = body.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const hex = stripped.slice(i + 1, i + 3);
    if (stripped[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (stripped.charCodeAt(i) <= 0xff) bytes.push(stripped.charCodeAt(i));
  }
  return Buffer.from(bytes);
}

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const name = (charset ?? 'utf-8').toLowerCase();
  if (name === 'iso-8859-1' || name === 'latin1' || name === 'us-ascii') return bytes.toString('latin1');
  return bytes.toString('utf8');
}

function decodeBody(body: string, encoding: string | undefined, charset: string | undefined): string {
  const enc = (encoding ?? '7bit').split(';')[0]!.trim().toLowerCase();
  const text = enc === 'base64' ? decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset) : enc === 'quoted-printable' ? decodeBytes(quotedPrintable(body), charset) : body;
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function parts(body: string, boundary: string): string[] {
  const out: string[] = [];
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    const trimmed = chunk.replace(/^\r?\n/, '');
    if (!trimmed.startsWith('--')) out.push(trimmed.replace(/\r?\n$/, ''));
  }
  return out;
}

/** Plain text and HTML from an RFC 822 message, including one multipart/alternative. */
function extract(raw: string): { text: string; html: string } {
  const { headers, body } = splitMessage(raw);
  const type = contentType(headers.get('content-type'));
  if (type.type.startsWith('multipart/') && type.boundary) {
    let text = '';
    let html = '';
    for (const part of parts(body, type.boundary)) {
      const inner = extract(part);
      if (!text && inner.text) text = inner.text;
      if (!html && inner.html) html = inner.html;
    }
    return { text, html };
  }
  const decoded = decodeBody(body, headers.get('content-transfer-encoding'), type.charset);
  return type.type === 'text/html' ? { text: '', html: decoded } : { text: decoded, html: '' };
}

/** The RFC 822 text inside a Gmail `raw` value, or undefined when it is not a message. */
function decodeRaw(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return undefined;
  const encoding = compact.includes('+') || compact.includes('/') ? 'base64' : 'base64url';
  const text = Buffer.from(compact, encoding).toString('utf8');
  const head = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
  return /^[A-Za-z-]{1,64}:/m.test(head) ? text : undefined;
}

/** Messages the send endpoint accepted, newest first, kept in memory only. */
export class Mailbox {
  readonly messages: MailMessage[] = [];
  private next = 1;

  add(raw: string): MailMessage {
    const { headers } = splitMessage(raw);
    const from = sender(headers.get('from'));
    const body = extract(raw);
    const message: MailMessage = {
      id: this.next++,
      threadId: '',
      at: new Date().toISOString(),
      from: from.address,
      fromName: from.name,
      to: recipients(headers.get('to')),
      cc: recipients(headers.get('cc')),
      subject: decodeWords(headers.get('subject') ?? ''),
      text: body.text,
      html: body.html,
      raw,
    };
    message.threadId = String(message.id);
    this.messages.unshift(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.pop();
    return message;
  }

  find(id: number): MailMessage | undefined {
    return this.messages.find((message) => message.id === id);
  }
}

/** Headers only. The raw source is `GET /mail/{id}`. */
export function mailSummary(message: MailMessage): Omit<MailMessage, 'raw' | 'text' | 'html'> {
  const { raw: _raw, text: _text, html: _html, ...summary } = message;
  return summary;
}

/** One message, without the raw source. */
export function mailView(message: MailMessage): Omit<MailMessage, 'raw'> {
  const { raw: _raw, ...view } = message;
  return view;
}

/**
 * Gmail's `users.messages.send`: `POST /gmail/v1/users/me/messages/send` with
 * `Authorization: Bearer <token>` and `{ "raw": "<base64url RFC 822>" }`.
 * The inbox and `GET /mail/:id` read what this accepted.
 */
export function mailRoutes(mailbox: Mailbox, log: FixtureLog): Handler {
  return async (req, res) => {
    const path = req.url.pathname;
    if (req.method === 'POST' && (path === PATHS.gmailSend || GMAIL_SEND.test(path))) {
      if (!sameText(bearer(req) ?? '', MAIL.token)) {
        log.add('mail', 'Send refused: wrong access token');
        return sendJson(res, 401, gmailError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'));
      }
      const body = await readJson(req);
      const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as { raw?: unknown }).raw : undefined;
      const mime = typeof raw === 'string' ? decodeRaw(raw) : undefined;
      if (!mime) {
        log.add('mail', "Send refused: missing or invalid 'raw'");
        return sendJson(res, 400, gmailError(400, 'INVALID_ARGUMENT', "Invalid value for 'raw'."));
      }
      const message = mailbox.add(mime);
      log.add('mail', `Message ${message.id} to ${message.to.join(', ') || '(no recipient)'}: ${message.subject || '(no subject)'}`, { id: message.id });
      return sendJson(res, 200, { id: String(message.id), threadId: message.threadId, labelIds: ['SENT'] });
    }

    if (req.method === 'GET' && path === '/inbox') {
      return sendJson(res, 200, { messages: mailbox.messages.map(mailSummary) });
    }
    const view = /^\/inbox\/(\d+)$/.exec(path);
    if (req.method === 'GET' && view) {
      const message = mailbox.find(Number(view[1]));
      return message ? sendJson(res, 200, mailView(message)) : sendJson(res, 404, { error: 'No such message.' });
    }
    const source = /^\/mail\/(\d+)$/.exec(path);
    if (req.method === 'GET' && source) {
      const message = mailbox.find(Number(source[1]));
      return message ? sendText(res, 200, message.raw) : sendJson(res, 404, { error: 'No such message.' });
    }
    return false;
  };
}
