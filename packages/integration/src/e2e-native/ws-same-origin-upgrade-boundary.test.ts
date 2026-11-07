/**
 * Shipping-path Boundary Test: the WebSocket upgrade is refused before the handshake for a cross-origin request.
 *
 * Real: a Hono app with the real `setupWebSocketRoutes` (including the same-origin upgrade guard), a real
 * `Bun.serve` with Hono's Bun `upgradeWebSocket`, real native `WebSocket` clients, the real connection registry.
 * Recorded proxy: the PTY provider is the mock one; the filesystem layer is memfs.
 *
 * Header used for the refused / accepted halves: `Origin`. Bun's native WebSocket client accepts a custom
 * `headers` option, so no `Sec-Fetch-Site` fallback is needed.
 *
 * Each route's single `it` carries both polarities: a mismatching Origin never opens and leaves the registry at
 * baseline; a matching Origin opens; a client with no Origin (non-browser control) opens.
 *
 * This file lives in e2e-native/ because a real `Bun.serve` needs pristine native `Response` / `Headers`.
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';

import { setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { setupWebSocketRoutes } from '@agent-console/server/src/websocket/routes';
import { WebSocketConnectionRegistry } from '@agent-console/server/src/websocket/connection-registry';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(c: () => boolean, what: string, t = 5000) {
  const d = Date.now() + t;
  while (!c()) {
    if (Date.now() > d) throw new Error('timeout waiting for ' + what);
    await delay(5);
  }
}

type Outcome = 'opened' | 'refused';

/** Connect with the given headers; resolve once the handshake either opened or failed. Always leaves the socket closed. */
async function connect(url: string, headers: Record<string, string>, whileOpen?: () => void): Promise<Outcome> {
  // Bun's WebSocket constructor accepts a `headers` option (not part of the DOM typings).
  const client = new WebSocket(url, { headers } as unknown as string[]);
  const outcome = await new Promise<Outcome>((resolve) => {
    client.addEventListener('open', () => resolve('opened'));
    client.addEventListener('error', () => resolve('refused'));
    client.addEventListener('close', () => resolve('refused'));
  });
  if (outcome === 'opened') {
    whileOpen?.();
    const closed = new Promise<void>((r) => client.addEventListener('close', () => r()));
    client.close();
    await closed;
  }
  return outcome;
}

describe('Shipping path: same-origin guard on the WebSocket upgrade', () => {
  let ctx: AppContext;
  let registry: WebSocketConnectionRegistry;
  let server: ReturnType<typeof Bun.serve>;
  let sessionId = '';
  let workerId = '';

  beforeAll(async () => {
    await setupTestEnvironment();
    setupMemfs({ '/test/config/.keep': '', '/test/repo/.keep': '' });
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    registry = new WebSocketConnectionRegistry();
    const app = new Hono();
    await setupWebSocketRoutes(app, upgradeWebSocket, ctx, registry);
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket });
    const session = await ctx.sessionManager.createSession({ type: 'quick', locationPath: '/test/repo', agentId: 'claude-code' });
    sessionId = session.id;
    workerId = session.workers.find((w) => w.type === 'agent')!.id;
  });

  afterAll(async () => {
    await server?.stop(true);
    if (ctx) await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  const sameOrigin = () => ({ Origin: `http://127.0.0.1:${server.port}` });
  const crossOrigin = { Origin: 'https://evil.example' };

  it('/ws/app: a mismatching Origin never opens; a matching Origin and no Origin both open', async () => {
    const url = () => `ws://127.0.0.1:${server.port}/ws/app`;
    const baseline = registry.appClientCount;

    expect(await connect(url(), crossOrigin)).toBe('refused');
    await delay(200);
    expect(registry.appClientCount).toBe(baseline);

    expect(await connect(url(), sameOrigin())).toBe('opened');
    expect(await connect(url(), {})).toBe('opened');
    await waitFor(() => registry.appClientCount === baseline, 'the app clients to be released');
  });

  it('/ws/session/:sessionId/worker/:workerId: a mismatching Origin never opens; a matching Origin and no Origin both open', async () => {
    const url = () => `ws://127.0.0.1:${server.port}/ws/session/${sessionId}/worker/${workerId}`;
    const count = () => registry.getWorkerConnections(sessionId, workerId)?.size ?? 0;
    const baseline = count();

    expect(await connect(url(), crossOrigin)).toBe('refused');
    await delay(200);
    expect(count()).toBe(baseline);

    expect(await connect(url(), sameOrigin())).toBe('opened');
    expect(await connect(url(), {})).toBe('opened');
    await waitFor(() => count() === baseline, 'the worker connections to be released');
  });
});
