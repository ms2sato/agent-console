import { describe, it, expect, spyOn, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../error-handler.js';
import { ValidationError, NotFoundError, ConflictError, InternalError } from '../errors.js';

describe('Error Handler', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.onError(onApiError);
  });

  describe('onApiError', () => {
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
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      app.get('/test', () => {
        throw new Error('Unexpected error');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Unexpected error');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle TypeError', async () => {
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      app.get('/test', () => {
        throw new TypeError('Type error occurred');
      });

      const res = await app.request('/test');

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Type error occurred');

      consoleSpy.mockRestore();
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
});
