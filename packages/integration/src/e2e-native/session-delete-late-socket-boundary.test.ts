/**
 * Shipping-path Boundary Test: a worker socket that opens while a session
 * deletion is in its awaited cleanup (Issue #2238).
 *
 * Real: a Hono app with the real `setupWebSocketRoutes`, served by a real
 * `Bun.serve` with Hono's Bun `upgradeWebSocket`; a real `WebSocket` client;
 * the real `SessionManager` -> `SessionDeletionService` deletion sequence
 * (`notifySessionDeleted`, kill loop, memory removal) and the real connection
 * registry.
 *
 * Recorded proxy (pre-pr-completeness Q13): the worker teardown is slow because
 * the worker manager's `killWorker` is replaced by a gate the test releases. The
 * deletion window is a few milliseconds in production and cannot be hit by hand;
 * the gate sits upstream of the socket path under test (it only decides WHEN the
 * deletion's awaited cleanup finishes) and changes nothing about how the socket
 * is accepted. The PTY provider is the mock one (no real agent is spawned).
 *
 * This file lives in e2e-native/ because a real `Bun.serve` needs pristine
 * native `Response` / `Headers` (see setup-native.ts).
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';

import { setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { setupWebSocketRoutes } from '@agent-console/server/src/websocket/routes';
import { WebSocketConnectionRegistry } from '@agent-console/server/src/websocket/connection-registry';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

interface ObservedSocket {
  frames: unknown[];
  closes: { code: number; reason: string }[];
  opened: boolean;
}

describe('Shipping path: worker socket opened during a session deletion (#2238)', () => {
  let ctx: AppContext;
  let registry: WebSocketConnectionRegistry;
  let server: ReturnType<typeof Bun.serve>;
  let releaseKill: () => void;
  let killStarted: boolean;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({ '/test/config/.keep': '', '/test/path/.keep': '' });
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });

    registry = new WebSocketConnectionRegistry();
    const app = new Hono();
    await setupWebSocketRoutes(app, upgradeWebSocket, ctx, registry);
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket });

    // Slow worker teardown: the kill resolves only after the test releases it.
    killStarted = false;
    const gate = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    const workerManager = ctx.sessionManager['workerManager'];
    workerManager.killWorker = async () => {
      killStarted = true;
      await gate;
    };
  });

  afterEach(async () => {
    releaseKill();
    for (const client of clients.splice(0)) client.close();
    await server.stop(true);
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  function connect(sessionId: string, workerId: string): ObservedSocket {
    const observed: ObservedSocket = { frames: [], closes: [], opened: false };
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws/session/${sessionId}/worker/${workerId}`);
    clients.push(client);
    client.addEventListener('open', () => {
      observed.opened = true;
    });
    client.addEventListener('message', (event) => {
      observed.frames.push(JSON.parse(String(event.data)));
    });
    client.addEventListener('close', (event) => {
      observed.closes.push({ code: event.code, reason: event.reason });
    });
    return observed;
  }

  async function createSessionWithAgentWorker() {
    const session = await ctx.sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const worker = session.workers.find((w) => w.type === 'agent');
    if (!worker) throw new Error('expected the session to start with an agent worker');
    return { sessionId: session.id, workerId: worker.id };
  }

  const variants = [
    { name: 'deleteSession', run: (id: string) => ctx.sessionManager.deleteSession(id) },
    { name: 'forceDeleteSession', run: (id: string) => ctx.sessionManager.forceDeleteSession(id) },
  ];

  for (const variant of variants) {
    it(`${variant.name}: a socket opened during the awaited cleanup gets SESSION_DELETED and a 1000 close`, async () => {
      const { sessionId, workerId } = await createSessionWithAgentWorker();

      const deletion = variant.run(sessionId);
      await waitFor(() => killStarted, 'the deletion to reach the worker teardown');

      // The session is still in memory here: the deletion is parked inside its awaited cleanup.
      const socket = connect(sessionId, workerId);
      await waitFor(() => socket.opened, 'the late socket to open');
      // Give the server time to answer: it either refuses and closes, or (unfixed) attaches and stays open.
      await waitFor(() => socket.closes.length > 0 || socket.frames.length > 0, 'any frame or close', 1500).catch(
        () => undefined,
      );
      await delay(300);

      const observation = { frames: socket.frames, closes: socket.closes };
      releaseKill();
      await deletion;

      // The refusal is the existing sendErrorAndClose shape: error frame, exit frame, then a 1000 close.
      expect(observation).toEqual({
        frames: [
          { type: 'error', message: 'Session has been deleted', code: 'SESSION_DELETED' },
          { type: 'exit', exitCode: 1, signal: null },
        ],
        closes: [{ code: 1000, reason: 'Session has been deleted' }],
      });

      expect(ctx.sessionManager.getSession(sessionId)).toBeUndefined();
      // The refused socket is registered first (onOpen's first line) and leaves the registry through its own
      // onClose once the close handshake completes, so wait for that rather than reading it at an arbitrary instant.
      await waitFor(
        () => (registry.getWorkerConnectionsBySession(sessionId)?.size ?? 0) === 0,
        'the refused socket to leave the registry',
      );
    });
  }
});
