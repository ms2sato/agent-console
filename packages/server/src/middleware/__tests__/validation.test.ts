import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { vOptionalJsonValidator, vValidator } from '../validation.js';
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

describe('vOptionalJsonValidator middleware', () => {
  const OptionalSchema = v.strictObject({ name: v.optional(v.pipe(v.string(), v.minLength(2))) });

  function createOptionalApp() {
    const app = new Hono();
    app.post('/opt', vOptionalJsonValidator(OptionalSchema), (c) => c.json({ valid: c.req.valid('json') }));
    app.onError(onApiError);
    return app;
  }

  async function post(init: RequestInit) {
    const res = await createOptionalApp().request('/opt', { method: 'POST', ...init });
    return { status: res.status, body: (await res.json()) as { valid?: { name?: string }; error?: string } };
  }

  const JSON_HEADERS = { 'Content-Type': 'application/json' };

  it('accepts no body and no content type as an empty object', async () => {
    expect(await post({})).toEqual({ status: 200, body: { valid: {} } });
  });

  it('accepts no body with a JSON content type (where validator("json") answers 400)', async () => {
    expect(await post({ headers: JSON_HEADERS })).toEqual({ status: 200, body: { valid: {} } });
  });

  it('accepts a blank body with a JSON content type', async () => {
    expect(await post({ headers: JSON_HEADERS, body: '  ' })).toEqual({ status: 200, body: { valid: {} } });
  });

  it('accepts {} and a valid body', async () => {
    expect(await post({ headers: JSON_HEADERS, body: '{}' })).toEqual({ status: 200, body: { valid: {} } });
    expect(await post({ headers: JSON_HEADERS, body: '{"name":"ab"}' })).toEqual({ status: 200, body: { valid: { name: 'ab' } } });
  });

  it('answers 400 for an invalid body, with the field path', async () => {
    const result = await post({ headers: JSON_HEADERS, body: '{"name":"a"}' });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('name');
  });

  it('answers 400 for malformed JSON and for an unknown key', async () => {
    expect((await post({ headers: JSON_HEADERS, body: '{not json' })).status).toBe(400);
    expect((await post({ headers: JSON_HEADERS, body: '{"other":1}' })).status).toBe(400);
  });
});
