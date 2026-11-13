import type { IncomingMessage, ServerResponse } from 'node:http';

/** One request as the route handlers see it. `rawPath` keeps percent-encoding, which storage object names rely on. */
export interface Request {
  method: string;
  url: URL;
  rawPath: string;
  headers: IncomingMessage['headers'];
  message: IncomingMessage;
}

/** Answers the request and returns true, or returns false to let the next handler try. */
export type Handler = (req: Request, res: ServerResponse) => Promise<boolean>;

const BODY_LIMIT = 10 * 1024 * 1024;

export async function readBody(req: Request, limit = BODY_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.message) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readText(req: Request): Promise<string> {
  return (await readBody(req)).toString('utf8');
}

export async function readForm(req: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(req));
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await readText(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown): true {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): true {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
  return true;
}

export function sendHtml(res: ServerResponse, status: number, html: string): true {
  return sendText(res, status, html, 'text/html; charset=utf-8');
}

export function redirect(res: ServerResponse, location: string, status = 302): true {
  res.writeHead(status, { location, 'cache-control': 'no-store' });
  res.end();
  return true;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The bearer token of the request, if any. */
export function bearer(req: Request): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

/** HTTP Basic credentials of the request, if any. */
export function basic(req: Request): { user: string; password: string } | undefined {
  const value = req.headers.authorization;
  if (!value?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? undefined : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
