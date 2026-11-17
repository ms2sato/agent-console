import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import pino from 'pino';
import { createHttpLogger, redactHeaders } from '../http-logger.js';

function setup() {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  const app = new Hono();
  app.use('*', createHttpLogger(logger) as any);
  app.get('/login', (c) => {
    c.header('Set-Cookie', 'auth_token=SENTINEL3; HttpOnly');
    c.header('Content-Type', 'text/plain');
    return c.text('ok');
  });
  const parsed = () => lines.map((l) => JSON.parse(l));
  return { app, lines, parsed };
}

describe('createHttpLogger credential redaction', () => {
  it('redacts credential headers in request and response logs', async () => {
    const { app, lines, parsed } = setup();
    await app.request('/login', {
      headers: {
        Cookie: 'auth_token=SENTINEL1',
        Authorization: 'Bearer SENTINEL2',
        'User-Agent': 'test-agent',
      },
    });

    const raw = lines.join('');
    expect(raw).not.toContain('SENTINEL');

    const entry = parsed().find((e) => e.req && e.res);
    expect(entry.req.headers.cookie).toBe('[REDACTED]');
    expect(entry.req.headers.authorization).toBe('[REDACTED]');
    expect(entry.res.headers['set-cookie']).toBe('[REDACTED]');
  });

  it('keeps non-sensitive headers and request/response metadata', async () => {
    const { app, parsed } = setup();
    await app.request('/login', { headers: { 'User-Agent': 'test-agent' } });

    const entry = parsed().find((e) => e.req && e.res);
    expect(entry.req.headers['user-agent']).toBe('test-agent');
    expect(entry.req.url).toBe('/login');
    expect(entry.req.method).toBe('GET');
    expect(entry.res.status).toBe(200);
    expect(entry.res.headers['content-type']).toContain('text/plain');
  });

  it('redacts proxy-authorization and upper-case request header names through a real request', async () => {
    const { app, lines, parsed } = setup();
    await app.request('/login', {
      headers: {
        COOKIE: 'a=SENTINEL1',
        AUTHORIZATION: 'Bearer SENTINEL2',
        'Proxy-Authorization': 'Basic SENTINEL4',
      },
    });

    expect(lines.join('')).not.toContain('SENTINEL');
    const entry = parsed().find((e) => e.req && e.res);
    expect(entry.req.headers.cookie).toBe('[REDACTED]');
    expect(entry.req.headers.authorization).toBe('[REDACTED]');
    expect(entry.req.headers['proxy-authorization']).toBe('[REDACTED]');
  });

  it('does not log the query string', async () => {
    const { app, lines, parsed } = setup();
    await app.request('/login?x=SENTINEL5');

    expect(lines.join('')).not.toContain('SENTINEL5');
    const entry = parsed().find((e) => e.req && e.res);
    expect(entry.req.url).toBe('/login');
  });
});

describe('redactHeaders', () => {
  it('matches header names case-insensitively on a plain object and keeps keys unchanged', () => {
    expect(
      redactHeaders({
        Cookie: 'a',
        'SET-COOKIE': 'b',
        'Proxy-Authorization': 'c',
        AUTHORIZATION: 'd',
        'X-Other': 'keep',
      }),
    ).toEqual({
      Cookie: '[REDACTED]',
      'SET-COOKIE': '[REDACTED]',
      'Proxy-Authorization': '[REDACTED]',
      AUTHORIZATION: '[REDACTED]',
      'X-Other': 'keep',
    });
  });
});
