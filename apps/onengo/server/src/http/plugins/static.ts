import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from '../server.js';

/** Files the browser and the service worker must revalidate on every load, so a new version is seen at once. */
const APP_SHELL_FILES = new Set(['index.html', 'ngsw-worker.js', 'ngsw.json', 'manifest.webmanifest']);
/** Build output named by its content hash (`main-L35VTJRS.js`, `media/material-icons-LEZCGFVT.woff2`). */
const HASHED_ASSET = /-[A-Z0-9]{8}\.(?:js|css|woff2?|ttf)$/;

/** The built web app at /, with the separate user guide at `/guide-app/` when that build is present. */
export async function webAppRoutes(app: FastifyInstance, { webRoot, guideRoot }: Pick<ServerOptions, 'webRoot' | 'guideRoot'>): Promise<void> {
  if (guideRoot && existsSync(join(guideRoot, 'index.html'))) {
    const guideIndex = readFileSync(join(guideRoot, 'index.html'), 'utf8');
    await app.register(async (scope) => {
      await scope.register(fastifyStatic, {
        root: guideRoot,
        prefix: '/',
        wildcard: false,
        index: ['index.html'],
        decorateReply: false,
        maxAge: '1h',
        setHeaders: (reply, path) => {
          if (APP_SHELL_FILES.has(basename(path))) reply.header('cache-control', 'no-cache');
          else if (HASHED_ASSET.test(path)) reply.header('cache-control', 'public, max-age=31536000, immutable');
        },
      });
      scope.setNotFoundHandler((req, reply) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return reply.callNotFound();
        return reply.type('text/html').header('cache-control', 'no-cache').send(guideIndex);
      });
    }, { prefix: '/guide-app' });
  }
  if (!webRoot || !existsSync(join(webRoot, 'index.html'))) return;
  app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
    index: ['index.html'],
    maxAge: '1h',
    setHeaders: (reply, path) => {
      if (APP_SHELL_FILES.has(basename(path))) reply.header('cache-control', 'no-cache');
      else if (HASHED_ASSET.test(path)) reply.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
  // Without a prefix this replaces the whole app's not-found handler, not only this plugin's.
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (req.method !== 'GET' || path.startsWith('/api/') || path.startsWith('/webhooks/') || path.startsWith('/internal/') || /\.[a-z0-9]+$/i.test(path)) {
      return reply.status(404).send({ code: 'not_found', message: 'Not found.' });
    }
    return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
  });
}
