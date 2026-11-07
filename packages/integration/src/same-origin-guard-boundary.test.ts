/**
 * Client-Server Boundary Test: same-origin guard
 *
 * Issues one state-changing request through the client's real `fetch` path
 * (`createMessageTemplate` -> hono client -> global fetch -> server app) with
 * the headers a same-origin browser adds, and asserts it is accepted; the same
 * request marked cross-site is refused (polarity inside the same test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import type { AppBindings } from '@agent-console/server/src/app-context';
import { SqliteMessageTemplateRepository } from '@agent-console/server/src/repositories/sqlite-message-template-repository';
import { initializeDatabase } from '@agent-console/server/src/database/connection';

import { createMessageTemplate } from '@agent-console/client/src/lib/api';

import { createFetchBridge } from './test-utils';

const SERVER_HOST = 'console.test';

describe('Client-Server Boundary: same-origin guard', () => {
  let app: Hono<AppBindings>;
  let bridge: ReturnType<typeof createFetchBridge>;
  let bridgeFetch: typeof fetch;

  beforeEach(async () => {
    await setupTestEnvironment();
    const db = await initializeDatabase(':memory:');
    app = await createTestApp({ messageTemplateRepository: new SqliteMessageTemplateRepository(db) });
    bridge = createFetchBridge(app);
    bridgeFetch = globalThis.fetch;
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  /** Wraps the bridged fetch so every request carries the given browser-added headers. */
  function withBrowserHeaders(extra: Record<string, string>): void {
    const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries({ Host: SERVER_HOST, ...extra })) headers.set(k, v);
      return bridgeFetch(input, { ...init, headers });
    };
    globalThis.fetch = Object.assign(wrapped, { preconnect: () => {} }) as typeof fetch;
  }

  it('accepts a same-origin browser request and refuses the same request marked cross-site', async () => {
    withBrowserHeaders({ Origin: `http://${SERVER_HOST}`, 'Sec-Fetch-Site': 'same-origin' });
    const created = await createMessageTemplate('Greeting', 'Hello');
    expect(created.template.title).toBe('Greeting');

    withBrowserHeaders({ Origin: `http://${SERVER_HOST}`, 'Sec-Fetch-Site': 'cross-site' });
    await expect(createMessageTemplate('Other', 'Blocked')).rejects.toThrow();

    // Raw response for the refusal: 403 with the guard's JSON body.
    const res = await globalThis.fetch('/api/message-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Other', content: 'Blocked' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cross-site request refused' });
  });
});
