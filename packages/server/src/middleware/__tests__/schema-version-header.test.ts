import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { SCHEMA_VERSION } from '@agent-console/shared';
import { schemaVersionHeaderMiddleware, SCHEMA_VERSION_HEADER } from '../schema-version-header.js';

describe('schemaVersionHeaderMiddleware', () => {
  it('sets X-Schema-Version on API responses', async () => {
    const app = new Hono();
    app.use('*', schemaVersionHeaderMiddleware);
    app.get('/api/thing', (c) => c.json({ ok: true }));

    const res = await app.request('/api/thing');

    expect(res.status).toBe(200);
    expect(res.headers.get(SCHEMA_VERSION_HEADER)).toBe(SCHEMA_VERSION);
  });

  it('sets the header even on 401 responses (runs before auth)', async () => {
    const app = new Hono();
    app.use('*', schemaVersionHeaderMiddleware);
    // Simulate an auth guard that rejects after the header middleware ran.
    app.use('/api/secret', async (c) => c.json({ error: 'Unauthorized' }, 401));
    app.get('/api/secret', (c) => c.json({ ok: true }));

    const res = await app.request('/api/secret');

    expect(res.status).toBe(401);
    expect(res.headers.get(SCHEMA_VERSION_HEADER)).toBe(SCHEMA_VERSION);
  });

  it('skips WebSocket upgrade paths', async () => {
    const app = new Hono();
    app.use('*', schemaVersionHeaderMiddleware);
    app.get('/ws/app', (c) => c.text('ok'));

    const res = await app.request('/ws/app');

    expect(res.headers.get(SCHEMA_VERSION_HEADER)).toBeNull();
  });
});
