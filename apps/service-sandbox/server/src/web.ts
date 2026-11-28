import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendHtml, type Handler } from './http.js';

/** Where `ng build` puts the inbox app: `apps/service-sandbox/web/dist/inbox/browser`. */
export const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist', 'inbox', 'browser');

/** The path the built app is served under; it matches the `<base href>` in the app's index.html. */
export const APP_BASE = '/inbox-app/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** A browser asks for HTML first; API clients send a wildcard or `application/json`. */
function wantsPage(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  const html = value.indexOf('text/html');
  if (html === -1) return false;
  const json = value.indexOf('application/json');
  return json === -1 || html < json;
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Sandbox inbox</title>
<body style="font:15px system-ui,sans-serif;margin:2rem;max-width:40rem">
<h1>The inbox page is not built</h1>
<p>Run <code>npm run build --workspace @onengo/service-sandbox-web</code> from the repository root, then reload.
The JSON inbox is available now: request <code>/inbox</code> with <code>Accept: application/json</code>.</p></body>`;

async function read(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * The inbox page, an Angular app built into `web/dist`. `GET /inbox` answers with the page for a
 * browser and keeps answering JSON for API clients, so the page reads the same endpoint it is served
 * from. `GET /inbox/ui` always returns the page; the app's files are under `/inbox-app/`.
 */
export function webRoutes(dir: string = WEB_DIR): Handler {
  return async (req, res) => {
    if (req.method !== 'GET') return false;
    const path = req.url.pathname;
    const isPage = path === '/inbox/ui' || path === APP_BASE || (path === '/inbox' && wantsPage(req.headers.accept));
    if (isPage) {
      const index = await read(join(dir, 'index.html'));
      return index ? sendHtml(res, 200, index.toString('utf8')) : sendHtml(res, 503, NOT_BUILT);
    }
    if (!path.startsWith(APP_BASE)) return false;

    let name: string;
    try {
      name = normalize(decodeURIComponent(path.slice(APP_BASE.length)));
    } catch {
      return false;
    }
    if (!name || name.startsWith('..') || name.includes(`..${sep}`) || name.includes('\0')) return false;
    const file = await read(join(dir, name));
    if (!file) return false;
    res.writeHead(200, { 'content-type': TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream', 'content-length': file.length, 'cache-control': 'no-store' });
    res.end(file);
    return true;
  };
}
