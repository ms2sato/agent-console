/**
 * Integration test utilities
 *
 * Provides helpers for testing client-server boundaries.
 */
import type { Hono } from 'hono';

/**
 * Captured HTTP request for inspection
 */
export interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Creates a fetch bridge that captures requests AND forwards them to the Hono app.
 *
 * This is the core of the "Server Bridge Pattern" - it allows testing that:
 * 1. Client sends correct data (via capturedRequests inspection)
 * 2. Server processes it correctly (via actual Hono handler execution)
 *
 * @example
 * ```typescript
 * let bridge: ReturnType<typeof createFetchBridge>;
 *
 * beforeEach(async () => {
 *   app = await createTestApp();
 *   bridge = createFetchBridge(app);
 * });
 *
 * afterEach(() => {
 *   bridge.restore();
 * });
 *
 * it('should send correct data', async () => {
 *   await fetch('/api/foo', { method: 'POST', body: JSON.stringify({ x: 1 }) });
 *   expect(bridge.capturedRequests[0].body).toEqual({ x: 1 });
 * });
 * ```
 */
export function createFetchBridge(app: Hono) {
  const capturedRequests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    capturedRequests.push({
      url,
      method: init?.method || 'GET',
      body,
    });

    // Forward to actual server handler
    return app.request(url, {
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    });
  };

  return {
    /** All captured requests */
    capturedRequests,
    /** Restore original fetch - call in afterEach */
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * Find a captured request by method and URL pattern
 */
export function findRequest(
  requests: CapturedRequest[],
  method: string,
  urlPattern: string | RegExp
): CapturedRequest | undefined {
  return requests.find((r) => {
    const methodMatch = r.method === method;
    const urlMatch =
      typeof urlPattern === 'string' ? r.url.includes(urlPattern) : urlPattern.test(r.url);
    return methodMatch && urlMatch;
  });
}
