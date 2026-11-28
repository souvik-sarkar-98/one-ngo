import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorRoutes } from './connectors.js';
import { HOST, HTTPS_PORT } from './constants.js';
import { sendJson, sendHtml, type Handler, type Request } from './http.js';
import { FixtureLog } from './log.js';
import { Mailbox, mailRoutes, mailSummary } from './mail.js';
import { oidc, type Oidc } from './oidc.js';
import { openApiDocument, swaggerPage } from './openapi.js';
import { payments, type Payments, type WebhookPost } from './payments.js';
import { pwnedRoutes } from './pwned.js';
import { storageRoutes } from './storage.js';
import { fixtureTls, type FixtureTls } from './tls.js';
import { webRoutes } from './web.js';

/** `.data/service-sandbox` at the repository root. */
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.data', 'service-sandbox');

export interface FixtureOptions {
  dataDir?: string;
  host?: string;
  /** 0 picks a free port (tests). */
  httpsPort?: number;
  /** one-ngo's PUBLIC_BASE_URL; payment webhooks are posted there. */
  oneNgoBaseUrl?: string;
  webhookPost?: WebhookPost;
  /** The built inbox app. Defaults to `apps/service-sandbox/web/dist/inbox/browser`. */
  webDir?: string;
}

export interface Fixture {
  origin: string;
  filesDir: string;
  tls: FixtureTls;
  log: FixtureLog;
  mailbox: Mailbox;
  oidc: Oidc;
  payments: Payments;
  close(): Promise<void>;
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const host = options.host ?? HOST;
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const filesDir = join(dataDir, 'files');
  await mkdir(filesDir, { recursive: true });
  const tls = await fixtureTls(join(dataDir, 'tls'), host);
  const log = new FixtureLog();
  const oneNgoBaseUrl = options.oneNgoBaseUrl ?? 'http://localhost:8080';

  let handlers: Handler[] = [];
  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (message, res) => {
    const rawPath = (message.url ?? '/').split('?')[0]!;
    const req: Request = { method: message.method ?? 'GET', url: new URL(message.url ?? '/', 'https://fixture'), rawPath, headers: message.headers, message };
    void (async () => {
      try {
        for (const handle of handlers) if (await handle(req, res)) return;
        sendJson(res, 404, { error: `The fixture does not answer ${req.method} ${req.url.pathname}.` });
      } catch (error) {
        log.add('fixture', `${req.method} ${req.url.pathname} failed`, { error: String(error) });
        if (!res.headersSent) sendJson(res, 500, { error: 'The fixture failed to answer.' });
        else res.destroy();
      }
    })();
  });
  const httpsPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.httpsPort ?? HTTPS_PORT, host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : HTTPS_PORT);
    });
  });
  const origin = `https://${host}:${httpsPort}`;

  const mailbox = new Mailbox();
  const provider = await oidc(origin, log);
  const pay = payments(log, { oneNgoBaseUrl, ...(options.webhookPost ? { post: options.webhookPost } : {}) });

  const home: Handler = async (req, res) => {
    if (req.method === 'GET' && req.url.pathname === '/') {
      return sendJson(res, 200, { swagger: `${origin}/swagger`, openapi: `${origin}/openapi.json` });
    }
    if (req.method === 'GET' && req.url.pathname === '/api/log') {
      return sendJson(res, 200, {
        entries: log.list(),
        orders: pay.orders(),
        messages: mailbox.messages.map(mailSummary),
      });
    }
    if (req.method === 'GET' && req.url.pathname === '/openapi.json') return sendJson(res, 200, openApiDocument(origin));
    if (req.method === 'GET' && req.url.pathname === '/swagger') return sendHtml(res, 200, swaggerPage());
    if (req.method === 'GET' && req.url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return true;
    }
    return false;
  };

  handlers = [home, webRoutes(options.webDir), mailRoutes(mailbox, log), provider.routes, pay.routes, storageRoutes(filesDir, log), pwnedRoutes(log), connectorRoutes(log)];
  log.add('fixture', `Started on ${origin}`);

  return {
    origin,
    filesDir,
    tls,
    log,
    mailbox,
    oidc: provider,
    payments: pay,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
