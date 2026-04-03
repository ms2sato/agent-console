import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { vValidator } from '../validation.js';
import { onApiError } from '../../lib/error-handler.js';

const TestSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  user: v.optional(v.object({
    email: v.pipe(v.string(), v.email()),
  })),
});

function createApp() {
  const app = new Hono();
  app.post('/test', vValidator(TestSchema), (c) => {
    return c.json({ success: true });
  });
  app.onError(onApiError);
  return app;
}

function postJson(app: Hono, body: unknown) {
  return app.request('/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('vValidator middleware', () => {
  it('should return 200 for valid input', async () => {
    const app = createApp();
    const res = await postJson(app, { name: 'test' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('should return 400 with field path for top-level field error', async () => {
    const app = createApp();
    const res = await postJson(app, { name: '' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('name');
  });

  it('should return 400 with dotted path for nested field error', async () => {
    const app = createApp();
    const res = await postJson(app, { name: 'valid', user: { email: 'not-email' } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('user.email');
  });

  it('should return 400 for missing required field', async () => {
    const app = createApp();
    const res = await postJson(app, {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('should return 200 for valid input with optional nested object present', async () => {
    const app = createApp();
    const res = await postJson(app, { name: 'test', user: { email: 'user@example.com' } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
