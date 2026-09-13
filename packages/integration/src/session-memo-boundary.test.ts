/**
 * Client-Server Boundary Test: PUT/GET /api/sessions/:id/memo (Issue #1569).
 *
 * Exercises the real chain the memo panel depends on:
 *   real HTTP PUT /api/sessions/:id/memo -> real vValidator(UpdateSessionMemoRequestSchema)
 *   middleware -> real route handler (packages/server/src/routes/sessions.ts)
 *   -> real SessionManager.writeMemo / .deleteMemo -> the real onMemoUpdated
 *   lifecycle callback -> real broadcastToApp (captured by a spy, not a
 *   hand-built object) -> JSON serialize/parse (wire transmission
 *   simulation, same pattern as `created-by-username-boundary.test.ts`) ->
 *   `AppServerMessageSchema.safeParse` (the same parser
 *   `packages/client/src/lib/app-websocket.ts` uses) -> real
 *   GET /api/sessions/:id/memo for the delete-on-empty round trip.
 *
 * Per `.claude/rules/pre-pr-completeness.md` Q10: neither the server's route
 * unit test (which asserts the raw object passed to a mock `broadcastToApp`)
 * nor the shared package's schema unit tests (which parse hand-built
 * literals) exercise "the real route-produced shape survives the real wire
 * schema" end-to-end. This file closes that gap.
 *
 * `createTestContext()` does NOT wire `SessionManager.setSessionLifecycleCallbacks`
 * (that happens in `websocket/routes.ts`'s `setupWebSocketRoutes`, a
 * production-only initialization step) -- this test wires the same
 * `onMemoUpdated -> broadcastToApp({ type: 'memo-updated', ... })` mapping
 * `setupWebSocketRoutes` uses in production, so the real
 * `SessionManager.writeMemo` / `.deleteMemo` -> callback -> broadcast chain
 * is exercised end-to-end rather than bypassed.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';

import { AppServerMessageSchema, type AppServerMessage } from '@agent-console/shared';

describe('Client-Server Boundary: PUT/GET /api/sessions/:id/memo (Issue #1569)', () => {
  let ctx: AppContext;
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let capturedBroadcasts: AppServerMessage[];

  beforeEach(async () => {
    await setupTestEnvironment();

    capturedBroadcasts = [];
    ctx = await createTestContext({
      broadcastToApp: (msg) => {
        capturedBroadcasts.push(msg);
      },
    });

    // Mirrors websocket/routes.ts's production onMemoUpdated -> broadcastToApp
    // wiring (setupWebSocketRoutes), which createTestContext() alone does not
    // register.
    ctx.sessionManager.setSessionLifecycleCallbacks({
      onMemoUpdated: (sessionId, content) => {
        ctx.broadcastToApp({ type: 'memo-updated', sessionId, content });
      },
    });

    app = await createTestApp(ctx);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  /** Simulate wire transmission (matches created-by-username-boundary.test.ts's pattern). */
  function simulateWireTransmission(payload: unknown): unknown {
    return JSON.parse(JSON.stringify(payload));
  }

  /**
   * Creates a session directly via the real SessionManager (same pattern as
   * create-agent-worker-boundary.test.ts), with `createdBy` set to the real
   * authenticated user's id (SingleUserMode's cached server-process user) so
   * the memo route's ownership check passes. Going through the real
   * POST /api/sessions HTTP route would additionally require memfs-backed
   * path validation for `locationPath`, which is orthogonal to what this
   * boundary test verifies -- the memo PUT/GET routes below are still
   * exercised as real HTTP requests.
   */
  async function createSession(): Promise<string> {
    const authUser = ctx.userMode.authenticate(() => undefined);
    if (!authUser) {
      throw new Error('expected SingleUserMode.authenticate() to always return a user');
    }
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: authUser.id },
    );
    return session.id;
  }

  it('PUT with real content -> real broadcastToApp -> wire -> AppServerMessageSchema.safeParse', async () => {
    const sessionId = await createSession();

    const res = await app.request(`/api/sessions/${sessionId}/memo`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello memo' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: 'hello memo' });

    const memoBroadcasts = capturedBroadcasts.filter((m) => m.type === 'memo-updated');
    expect(memoBroadcasts).toHaveLength(1);

    const wirePayload = simulateWireTransmission(memoBroadcasts[0]);
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues.map((i) => i.message)));
    if (parsed.output.type !== 'memo-updated') throw new Error(`Expected memo-updated, got: ${parsed.output.type}`);
    expect(parsed.output.sessionId).toBe(sessionId);
    expect(parsed.output.content).toBe('hello memo');
  });

  it(
    'PUT with an empty/whitespace body deletes the memo -- broadcast carries content: "" ' +
      '(the wire deletion signal, never null) and a subsequent GET returns { content: null }',
    async () => {
      const sessionId = await createSession();

      // Write something first so there is something for the empty PUT to delete.
      const writeRes = await app.request(`/api/sessions/${sessionId}/memo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'to be deleted' }),
      });
      expect(writeRes.status).toBe(200);
      capturedBroadcasts.length = 0; // Only interested in the delete trigger below.

      const res = await app.request(`/api/sessions/${sessionId}/memo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ content: null });

      const memoBroadcasts = capturedBroadcasts.filter((m) => m.type === 'memo-updated');
      expect(memoBroadcasts).toHaveLength(1);

      const wirePayload = simulateWireTransmission(memoBroadcasts[0]);
      const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.issues.map((i) => i.message)));
      if (parsed.output.type !== 'memo-updated') throw new Error(`Expected memo-updated, got: ${parsed.output.type}`);
      expect(parsed.output.sessionId).toBe(sessionId);
      expect(parsed.output.content).toBe('');

      const getRes = await app.request(`/api/sessions/${sessionId}/memo`);
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({ content: null });
    },
  );
});
