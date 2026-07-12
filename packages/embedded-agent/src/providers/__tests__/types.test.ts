import { describe, it, expect } from 'bun:test';
import { ProviderError } from '../types.js';

describe('ProviderError', () => {
  it('is an Error subclass with the ProviderError name', () => {
    const err = new ProviderError('boom', { retryable: true });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe('ProviderError');
    expect(err.message).toBe('boom');
  });

  it('carries the retryable flag and leaves optional fields undefined', () => {
    const err = new ProviderError('transient', { retryable: true });
    expect(err.retryable).toBe(true);
    expect(err.status).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('records status and retryAfterMs when provided', () => {
    const err = new ProviderError('rate limited', {
      retryable: true,
      status: 429,
      retryAfterMs: 2000,
    });
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
  });

  it('supports a non-retryable classification', () => {
    const err = new ProviderError('bad request', { retryable: false, status: 400 });
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
  });
});
