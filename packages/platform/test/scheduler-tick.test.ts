import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer, type ServerOptions } from '@onengo/server/http/server.js';
import { createWorld, type TestWorld } from './helpers.js';

const SECRET = 'tick-secret-value';
const CRON = { 'x-appengine-cron': 'true' };
const BEARER = { authorization: `Bearer ${SECRET}` };

let w: TestWorld;
const apps: ReturnType<typeof buildServer>[] = [];
beforeAll(async () => {
  w = await createWorld();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await w.close();
});

function server(options: ServerOptions) {
  const app = buildServer(w.platform, options);
  apps.push(app);
  return app;
}

describe('GET /internal/tick for App Engine cron', () => {
  it('runs the tick when the cron header is trusted', async () => {
    const tick = vi.spyOn(w.platform, 'tick');
    const res = await server({ trustAppEngineCron: true, tickSecret: SECRET }).inject({ method: 'GET', url: '/internal/tick', headers: CRON });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('dispatch');
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('refuses a request without the cron header, or with it when not on App Engine', async () => {
    const tick = vi.spyOn(w.platform, 'tick');
    const onAppEngine = server({ trustAppEngineCron: true, tickSecret: SECRET });
    const elsewhere = server({ tickSecret: SECRET });
    for (const [app, headers] of [
      [onAppEngine, {}],
      [onAppEngine, { 'x-appengine-cron': 'false' }],
      [elsewhere, CRON],
    ] as const) {
      const res = await app.inject({ method: 'GET', url: '/internal/tick', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'forbidden', message: 'Not allowed.' });
    }
    expect(tick).not.toHaveBeenCalled();
  });

  it('never accepts the bearer secret over GET', async () => {
    const tick = vi.spyOn(w.platform, 'tick');
    for (const app of [server({ tickSecret: SECRET }), server({ trustAppEngineCron: true, tickSecret: SECRET })]) {
      expect((await app.inject({ method: 'GET', url: '/internal/tick', headers: BEARER })).statusCode).toBe(403);
    }
    expect(tick).not.toHaveBeenCalled();
  });

  it('answers no HEAD request, so nothing but GET and POST can start a tick', async () => {
    const tick = vi.spyOn(w.platform, 'tick');
    const res = await server({ trustAppEngineCron: true }).inject({ method: 'HEAD', url: '/internal/tick', headers: CRON });
    expect(res.statusCode).toBe(404);
    expect(tick).not.toHaveBeenCalled();
  });

  it('keeps POST accepting the cron header and the bearer secret', async () => {
    const app = server({ trustAppEngineCron: true, tickSecret: SECRET });
    for (const headers of [CRON, BEARER]) expect((await app.inject({ method: 'POST', url: '/internal/tick', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/internal/tick', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(403);
  });
});
