import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PATHS, STORAGE_TOKEN } from './constants.js';
import { bearer, header, sendJson, type Handler, type Request } from './http.js';
import type { FixtureLog } from './log.js';

/**
 * Stands in for https://storage.googleapis.com (the JSON API paths one-ngo's file client calls) and the
 * metadata server's token endpoint. Objects are written under `filesDir/<bucket>/<object>`, so they outlast a restart.
 */
export function storageRoutes(filesDir: string, log: FixtureLog): Handler {
  const SEGMENT = /^[A-Za-z0-9_.-]+$/;
  const objectPath = (bucket: string, object: string): string | undefined => {
    const parts = object.split('/');
    if (!SEGMENT.test(bucket) || bucket.startsWith('.') || !parts.length) return undefined;
    if (parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..' || p.endsWith('.part'))) return undefined;
    return join(filesDir, bucket, ...parts);
  };
  const decode = (value: string): string | undefined => {
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  };
  const authorised = (req: Request) => bearer(req) === STORAGE_TOKEN;

  return async (req, res) => {
    if (req.method === 'GET' && req.url.pathname === PATHS.metadataToken) {
      if (header(req, 'metadata-flavor') !== 'Google') return sendJson(res, 403, { error: 'Missing Metadata-Flavor: Google header.' });
      log.add('storage', 'Metadata token issued');
      return sendJson(res, 200, { access_token: STORAGE_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    }

    const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(req.rawPath);
    if (upload && req.method === 'POST') {
      if (!authorised(req)) return sendJson(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      const bucket = decode(upload[1]!);
      const name = req.url.searchParams.get('name') ?? '';
      const path = bucket && req.url.searchParams.get('uploadType') === 'media' ? objectPath(bucket, name) : undefined;
      if (!bucket || !path) return sendJson(res, 400, { error: { code: 400, message: 'Unsupported upload.' } });
      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.part`;
      try {
        await pipeline(req.message, createWriteStream(partial));
        await rename(partial, path);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
      const { size } = await stat(path);
      const contentType = header(req, 'content-type') ?? 'application/octet-stream';
      log.add('storage', `Stored ${bucket}/${name} (${size} bytes)`, { bucket, name, size, contentType, path });
      return sendJson(res, 200, { kind: 'storage#object', bucket, name, size: String(size), contentType });
    }

    const object = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/.exec(req.rawPath);
    if (object && (req.method === 'GET' || req.method === 'DELETE')) {
      if (!authorised(req)) return sendJson(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      const bucket = decode(object[1]!);
      const name = decode(object[2]!);
      const path = bucket && name ? objectPath(bucket, name) : undefined;
      if (!path) return sendJson(res, 400, { error: { code: 400, message: 'Invalid object name.' } });
      const found = await stat(path).then((s) => (s.isFile() ? s : undefined), () => undefined);
      if (!found) {
        log.add('storage', `${req.method} ${bucket}/${name}: not found`);
        return sendJson(res, 404, { error: { code: 404, message: 'No such object.' } });
      }
      if (req.method === 'DELETE') {
        await rm(path, { force: true });
        log.add('storage', `Deleted ${bucket}/${name}`);
        res.writeHead(204).end();
        return true;
      }
      if (req.url.searchParams.get('alt') !== 'media') return sendJson(res, 200, { kind: 'storage#object', bucket, name, size: String(found.size) });
      log.add('storage', `Served ${bucket}/${name} (${found.size} bytes)`);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': found.size });
      await pipeline(createReadStream(path), res);
      return true;
    }
    return false;
  };
}
