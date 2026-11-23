import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PATHS, STORAGE_TOKEN } from './constants.js';
import { bearer, header, readBody, sendJson, type Handler, type Request } from './http.js';
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

    const authz = header(req, 'authorization') ?? '';
    if (authz.startsWith('AWS4-HMAC-SHA256 ')) {
      const parts = req.url.pathname.split('/').filter(Boolean).map((p) => decode(p));
      const bucket = parts[0];
      const name = parts.slice(1).join('/');
      const path = bucket && name ? objectPath(`s3-${bucket}`, name) : undefined;
      if (!path || (req.method !== 'PUT' && req.method !== 'GET' && req.method !== 'DELETE')) {
        return sendJson(res, 400, { message: 'Unsupported S3 request.' });
      }
      if (req.method === 'PUT') {
        await mkdir(dirname(path), { recursive: true });
        const partial = `${path}.part`;
        try {
          await pipeline(req.message, createWriteStream(partial));
          await rename(partial, path);
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
        log.add('storage', `S3 stored ${bucket}/${name}`);
        res.writeHead(200).end();
        return true;
      }
      const found = await stat(path).then((s) => (s.isFile() ? s : undefined), () => undefined);
      if (!found) {
        res.writeHead(404).end();
        return true;
      }
      if (req.method === 'DELETE') {
        await rm(path, { force: true });
        log.add('storage', `S3 deleted ${bucket}/${name}`);
        res.writeHead(204).end();
        return true;
      }
      log.add('storage', `S3 served ${bucket}/${name}`);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': found.size });
      await pipeline(createReadStream(path), res);
      return true;
    }

    if (req.url.pathname.startsWith('/upload/drive/v3/files') || req.url.pathname.startsWith('/drive/v3/files')) {
      if (!bearer(req)) return sendJson(res, 401, { error: { message: 'Invalid Credentials' } });
      const driveFile = /^\/drive\/v3\/files\/([^/]+)$/.exec(req.url.pathname);
      const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(req.url.pathname);
      if ((req.method === 'POST' || req.method === 'PATCH') && upload) {
        const raw = await readBody(req);
        const meta = /\{[\s\S]*?"onengoKey"[\s\S]*?\}/.exec(raw.toString('utf8'));
        const parsed = meta ? (JSON.parse(meta[0]) as { appProperties?: { onengoKey?: string }; parents?: string[] }) : undefined;
        const key = parsed?.appProperties?.onengoKey;
        const folder = parsed?.parents?.[0];
        if (!key || !folder) return sendJson(res, 400, { error: { message: 'Missing file metadata.' } });
        const id = upload[1] ?? `drv-${Buffer.from(key).toString('hex').slice(0, 24)}`;
        const path = objectPath('drive', id);
        if (!path) return sendJson(res, 400, { error: { message: 'Invalid file id.' } });
        await mkdir(dirname(path), { recursive: true });
        const boundary = /boundary=([^;\s]+)/.exec(header(req, 'content-type') ?? '')?.[1];
        const marker = boundary ? Buffer.from(`\r\n--${boundary}`) : undefined;
        const start = marker ? raw.indexOf(marker, raw.indexOf(marker) + 1) : -1;
        const headerEnd = start >= 0 ? raw.indexOf('\r\n\r\n', start) : -1;
        const end = marker && headerEnd >= 0 ? raw.lastIndexOf(marker) : -1;
        const bytes = headerEnd >= 0 && end > headerEnd ? raw.subarray(headerEnd + 4, end) : raw;
        await writeFile(path, bytes);
        await writeFile(`${path}.meta.json`, JSON.stringify({ key, folder }));
        log.add('storage', `Drive stored ${key} as ${id}`);
        return sendJson(res, 200, { id });
      }
      if (req.method === 'GET' && req.url.pathname === '/drive/v3/files') {
        const q = req.url.searchParams.get('q') ?? '';
        const key = /value='([^']*)'/.exec(q)?.[1];
        const folder = /'([^']+)' in parents/.exec(q)?.[1];
        const dir = join(filesDir, 'drive');
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names.filter((n) => n.endsWith('.meta.json'))) {
          const meta = JSON.parse(await readFile(join(dir, name), 'utf8')) as { key: string; folder: string };
          if (meta.key === key && meta.folder === folder) return sendJson(res, 200, { files: [{ id: name.slice(0, -'.meta.json'.length) }] });
        }
        return sendJson(res, 200, { files: [] });
      }
      if (driveFile && (req.method === 'GET' || req.method === 'DELETE')) {
        const path = objectPath('drive', driveFile[1]!);
        if (!path) return sendJson(res, 400, { error: { message: 'Invalid file id.' } });
        const found = await stat(path).then((s) => (s.isFile() ? s : undefined), () => undefined);
        if (!found) return sendJson(res, 404, { error: { message: 'Not found.' } });
        if (req.method === 'DELETE') {
          await rm(path, { force: true });
          await rm(`${path}.meta.json`, { force: true });
          res.writeHead(204).end();
          return true;
        }
        if (req.url.searchParams.get('alt') !== 'media') return sendJson(res, 200, { id: driveFile[1] });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': found.size });
        await pipeline(createReadStream(path), res);
        return true;
      }
    }
    return false;
  };
}
