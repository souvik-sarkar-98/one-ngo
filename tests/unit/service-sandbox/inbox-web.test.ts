import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fixture } from '../../../apps/service-sandbox/server/src/server.js';
import { call, tempFixture } from '../../support/service-sandbox/helpers.js';

let fixture: Fixture;
let missing: Fixture;
let cleanup: () => Promise<void>;
let cleanupMissing: () => Promise<void>;
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'inbox-web-'));
  await mkdir(join(webDir, 'media'));
  await writeFile(join(webDir, 'index.html'), '<inbox-root></inbox-root>');
  await writeFile(join(webDir, 'main-ABC.js'), 'console.log(1)');
  await writeFile(join(webDir, 'media', 'font.woff2'), 'font');
  ({ fixture, cleanup } = await tempFixture({ webDir }));
  ({ fixture: missing, cleanup: cleanupMissing } = await tempFixture({ webDir: join(webDir, 'not-built') }));
});
afterAll(async () => {
  await cleanup();
  await cleanupMissing();
  await rm(webDir, { recursive: true, force: true });
});

const BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

describe('inbox web page', () => {
  it('serves the page to a browser and JSON to API clients on the same path', async () => {
    const page = await call(fixture, '/inbox', { headers: BROWSER });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('<inbox-root>');

    const api = await call(fixture, '/inbox');
    expect(api.headers['content-type']).toContain('application/json');
    expect(api.json<{ messages: unknown[] }>().messages).toEqual([]);

    const json = await call(fixture, '/inbox', { headers: { accept: 'application/json, text/html' } });
    expect(json.headers['content-type']).toContain('application/json');
  });

  it('always serves the page at /inbox/ui and the app base, and the built files under the app base', async () => {
    expect((await call(fixture, '/inbox/ui')).text).toContain('<inbox-root>');
    expect((await call(fixture, '/inbox-app/')).text).toContain('<inbox-root>');
    const js = await call(fixture, '/inbox-app/main-ABC.js');
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.text).toBe('console.log(1)');
    expect((await call(fixture, '/inbox-app/media/font.woff2')).headers['content-type']).toBe('font/woff2');
    expect((await call(fixture, '/inbox-app/missing.js')).status).toBe(404);
  });

  it('does not serve files outside the build folder', async () => {
    for (const path of ['/inbox-app/..%2f..%2fpackage.json', '/inbox-app/%2e%2e/%2e%2e/package.json', '/inbox-app/..%5cpackage.json']) {
      expect((await call(fixture, path)).status, path).toBe(404);
    }
  });

  it('says how to build the page when it is missing, and keeps the JSON inbox working', async () => {
    const page = await call(missing, '/inbox', { headers: BROWSER });
    expect(page.status).toBe(503);
    expect(page.text).toContain('is not built');
    expect((await call(missing, '/inbox')).status).toBe(200);
  });
});
