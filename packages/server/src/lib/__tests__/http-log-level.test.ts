import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { pinoLogger } from 'hono-pino';
import pino from 'pino';
import { resolveHttpResLevel } from '../http-log-level.js';
import { onApiError } from '../error-handler.js';

class ForeignHttpException extends Error {
  readonly status: number;
  readonly #body: unknown;
  constructor(status: number, body: unknown, message = 'foreign') {
    super(message);
    this.status = status;
    this.#body = body;
  }
  getResponse(): Response {
    return Response.json(this.#body, { status: this.status });
  }
}

describe('resolveHttpResLevel', () => {
  it.each([
    [200, 'info'],
    [204, 'info'],
    [301, 'info'],
    [399, 'info'],
    [400, 'warn'],
    [404, 'warn'],
    [409, 'warn'],
    [499, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ] as const)('status %i -> %s', (status, level) => {
    expect(resolveHttpResLevel(status)).toBe(level);
  });
});

// index.ts has no sibling test and wires this function into pinoLogger in one
// line, so the wiring's polarity is measured here: with onResLevel the 404 is
// logged at warn; with hono-pino's default (main's wiring) it is logged at error.
interface AccessLogRecord {
  level: number;
  res: { status: number };
}

function isAccessLogRecord(record: unknown): record is AccessLogRecord {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as { level?: unknown; res?: unknown };
  return (
    typeof r.level === 'number' &&
    typeof r.res === 'object' &&
    r.res !== null &&
    typeof (r.res as { status?: unknown }).status === 'number'
  );
}

describe('access log level through hono-pino', () => {
  async function run(withResLevel: boolean) {
    const records: unknown[] = [];
    const captureStream = { write(line: string) { records.push(JSON.parse(line)); } };
    const app = new Hono();
    app.onError(onApiError);
    app.use(
      '*',
      pinoLogger({
        pino: pino({ level: 'info' }, captureStream),
        ...(withResLevel ? { http: { onResLevel: (c) => resolveHttpResLevel(c.res.status) } } : {}),
      })
    );
    app.all('/mcp', () => {
      throw new ForeignHttpException(404, { jsonrpc: '2.0', error: { message: 'Session not found' }, id: null });
    });
    await app.request('/mcp');
    return records.find(isAccessLogRecord);
  }

  it('logs a 404 at warn when onResLevel is wired', async () => {
    const rec = await run(true);
    expect(rec?.res.status).toBe(404);
    expect(rec?.level).toBe(40);
  });

  it('logs the same 404 at error without onResLevel', async () => {
    const rec = await run(false);
    expect(rec?.res.status).toBe(404);
    expect(rec?.level).toBe(50);
  });
});
