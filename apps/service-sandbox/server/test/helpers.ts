import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fixtureUrl, INTEGRATION_FIXTURE_ORIGIN } from '../../../onengo/server/src/fixture-hosts.js';
import { startFixture, type Fixture, type FixtureOptions } from '../src/server.js';

export interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
  json<T = unknown>(): T;
}

/** One HTTPS call that trusts the fixture's CA. */
export function call(fixture: Fixture, path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Answer> {
  const url = new URL(path, fixture.origin);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers, ca: fixture.tls.ca }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

/**
 * A `fetch` that trusts the fixture's CA and applies one-ngo's own host rewrite, then moves the fixed fixture
 * origin to this test fixture's port. Lets the product's clients, which name the real hosts, talk to a test fixture.
 */
export function fixtureFetch(fixture: Fixture): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const original = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rewritten = new URL(fixtureUrl(original));
    if (rewritten.origin !== INTEGRATION_FIXTURE_ORIGIN) throw new Error(`one-ngo would not send ${original} to the fixture.`);
    const target = new URL(`${rewritten.pathname}${rewritten.search}`, fixture.origin);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body;
    return new Promise<Response>((resolve, reject) => {
      const req = request(target, { method: init.method ?? 'GET', headers, ca: fixture.tls.ca }, (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') responseHeaders.set(k, v);
        const nullBody = status === 204 || status === 304 || init.method === 'HEAD';
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: responseHeaders }));
      });
      req.on('error', reject);
      if (body instanceof ReadableStream) Readable.fromWeb(body as never).pipe(req);
      else req.end(body as string | undefined);
    });
  }) as typeof fetch;
}

/** A fixture on free ports with its data in a temporary folder. */
export async function tempFixture(options: FixtureOptions = {}): Promise<{ fixture: Fixture; dataDir: string; cleanup(): Promise<void> }> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'service-sandbox-')));
  const fixture = await startFixture({ httpsPort: 0, smtpPort: 0, ...options, dataDir });
  return {
    fixture,
    dataDir,
    async cleanup() {
      await fixture.close();
      if (!options.dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}
