import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { rootLogger } from '../logger.js';
import { onApiError } from '../error-handler.js';
import { ValidationError, NotFoundError, ConflictError, InternalError } from '../errors.js';

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

describe('Error Handler', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.onError(onApiError);
  });

  describe('onApiError', () => {
    let errorSpy: ReturnType<typeof spyOn>;
    beforeEach(() => { errorSpy = spyOn(rootLogger, 'error'); });
    afterEach(() => { errorSpy.mockRestore(); });

    it('should pass through successful responses', async () => {
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true });
    });

    it('should handle ValidationError with 400 status', async () => {
      app.get('/test', () => {
        throw new ValidationError('Invalid input');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid input');
    });

    it('should handle NotFoundError with 404 status', async () => {
      app.get('/test', () => {
        throw new NotFoundError('Session');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Session not found');
    });

    it('should handle ConflictError with 409 status', async () => {
      app.get('/test', () => {
        throw new ConflictError('Resource already exists');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Resource already exists');
    });

    it('should handle InternalError with 500 status', async () => {
      app.get('/test', () => {
        throw new InternalError('Database connection failed');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Database connection failed');
    });

    it('should handle non-ApiError with 500 status', async () => {
      app.get('/test', () => {
        throw new Error('Unexpected error');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Unexpected error');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle TypeError', async () => {
      app.get('/test', () => {
        throw new TypeError('Type error occurred');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Type error occurred');
      // Error is logged via Pino logger (not console.error)
    });
  });

  describe('error response format', () => {
    it('should return JSON with error field', async () => {
      app.get('/test', () => {
        throw new ValidationError('Test error');
      });

      const res = await app.request('/test');
      const contentType = res.headers.get('content-type');

      expect(contentType).toContain('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('error');
    });

    it('should include error message in response', async () => {
      app.get('/test', () => {
        throw new NotFoundError('User');
      });

      const res = await app.request('/test');
      const body = await res.json() as { error: string };

      expect(body.error).toBe('User not found');
    });
  });

  describe('ApiError status codes', () => {
    it('should respect custom status code from ApiError subclass', async () => {
      app.get('/400', () => { throw new ValidationError('bad'); });
      app.get('/404', () => { throw new NotFoundError('item'); });
      app.get('/409', () => { throw new ConflictError('conflict'); });
      app.get('/500', () => { throw new InternalError(); });

      expect((await app.request('/400')).status).toBe(400);
      expect((await app.request('/404')).status).toBe(404);
      expect((await app.request('/409')).status).toBe(409);
      expect((await app.request('/500')).status).toBe(500);
    });
  });

  // POLARITY (measured): with the isHttpExceptionLike branch removed, (a)(b)(c)(d) fail
  //   (500 with a rebuilt { error } body and logger.error), (e) passes (control). 11 pass / 4 fail.
  // POLARITY (measured): with the predicate replaced by `error instanceof HTTPException` (hono/http-exception),
  //   (a)(b)(c) fail (foreign class is not an instance) and (d) passes (real hono copy). 12 pass / 3 fail.
  //   That gap is what ForeignHttpException buys. (c) fails in both because the thrown body is not preserved.
  describe('HTTP-exception-like errors (duck-typed)', () => {
    let warnSpy: ReturnType<typeof spyOn>;
    let errorSpy: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warnSpy = spyOn(rootLogger, 'warn');
      errorSpy = spyOn(rootLogger, 'error');
    });
    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    const sessionNotFound = { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null };

    it('(a) preserves a foreign 404 response and logs at warn', async () => {
      app.get('/test', () => { throw new ForeignHttpException(404, sessionNotFound, 'Session not found'); });
      const res = await app.request('/test');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(sessionNotFound);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatchObject({ status: 404 });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('(b) preserves a foreign 409 response and logs at warn', async () => {
      const body = { jsonrpc: '2.0', error: { code: -32000, message: 'Conflict: Only one SSE stream is allowed per session' }, id: null };
      app.get('/test', () => { throw new ForeignHttpException(409, body, 'Conflict: Only one SSE stream is allowed per session'); });
      const res = await app.request('/test');
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(body);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatchObject({ status: 409 });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('(c) preserves a foreign 500 response and logs at error', async () => {
      const body = { jsonrpc: '2.0', error: { code: -32603, message: 'Internal' }, id: null };
      app.get('/test', () => { throw new ForeignHttpException(500, body, 'Internal'); });
      const res = await app.request('/test');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(body);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatchObject({ status: 500 });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('(d) handles the real hono HTTPException the same way as (a)', async () => {
      app.get('/test', () => {
        throw new HTTPException(404, {
          res: Response.json(sessionNotFound, { status: 404 }),
        });
      });
      const res = await app.request('/test');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(sessionNotFound);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatchObject({ status: 404 });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('(e) negative control: a plain Error is still a 500 logged at error', async () => {
      app.get('/test', () => { throw new Error('boom'); });
      const res = await app.request('/test');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'boom' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
