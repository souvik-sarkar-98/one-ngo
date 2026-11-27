import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../apps/onengo/server/src/http/server.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

describe('GET /api/product', () => {
  let w: TestWorld;
  let app: FastifyInstance;
  let configured: FastifyInstance;

  beforeAll(async () => {
    w = await createWorld();
    app = buildServer(w.platform, {});
    configured = buildServer(w.platform, { productName: '  Helping Hands Hub  ' });
  });
  afterAll(async () => {
    await app.close();
    await configured.close();
    await w.close();
  });

  it('is public and defaults to OneNGO when no name is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/product' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'OneNGO' });
  });

  it('returns the configured name as given', async () => {
    const res = await configured.inject({ method: 'GET', url: '/api/product' });
    expect(res.json()).toEqual({ name: '  Helping Hands Hub  ' });
  });

  it('shows a configured space as a space, not the default', async () => {
    const spaced = buildServer(w.platform, { productName: ' ' });
    try {
      const res = await spaced.inject({ method: 'GET', url: '/api/product' });
      expect(res.json()).toEqual({ name: ' ' });
    } finally {
      await spaced.close();
    }
  });

  it('treats an empty configured name as the default', async () => {
    const empty = buildServer(w.platform, { productName: '' });
    try {
      const res = await empty.inject({ method: 'GET', url: '/api/product' });
      expect(res.json()).toEqual({ name: 'OneNGO' });
    } finally {
      await empty.close();
    }
  });
});
