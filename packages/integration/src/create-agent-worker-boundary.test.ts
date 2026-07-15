/**
 * Client-Server Boundary Test: `type: 'agent'` worker creation (Issue #1023,
 * CLAUDE.md Q10)
 *
 * Regression guard for the wire boundary of the widened
 * `CreateWorkerRequestSchema` (`packages/shared/src/schemas/worker.ts`).
 * Until Issue #1023, `type: 'agent'` was only ever constructed internally
 * (session-creation path) -- the public REST schema strictly rejected it,
 * which is why the unified agent-selection picker (`AddAgentWorkerMenu.tsx`)
 * disabled terminal-agent items rather than wiring them to a call that would
 * always 400.
 *
 * Neither the shared-package schema unit test (exercises `v.safeParse`
 * directly, never touches an HTTP request) nor the server route unit test
 * (constructs its own minimal `SessionManager` test double) proves that a
 * REAL end-to-end HTTP request -- the same shape the client's `createWorker`
 * API call sends -- reaches the real `vValidator(CreateWorkerRequestSchema)`
 * middleware, the real route handler, and the real
 * `WorkerLifecycleManager.createWorker` 'agent' branch. This boundary test
 * exercises that full chain:
 *
 *   real HTTP POST /api/sessions/:id/workers { type: 'agent', agentId }
 *     -> real vValidator(CreateWorkerRequestSchema) parse
 *     -> real route handler (packages/server/src/routes/workers.ts)
 *     -> real SessionManager.createWorker -> WorkerLifecycleManager
 *     -> real 'agent' branch (PTY spawn mocked at the lowest level only)
 *     -> JSON response
 *
 * Removing `CreateAgentWorkerParamsSchema` from the `CreateWorkerRequestSchema`
 * union causes this test's first assertion (201, not 400) to fail.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';

describe('Client-Server Boundary: type:"agent" worker creation (Issue #1023)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('creates a terminal-agent-backed worker on a running session via the real HTTP route', async () => {
    // 1. Seed a user so createSession satisfies the created_by FK.
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    // 2. Create a session through the real manager (initial worker is also
    //    type 'agent' -- this test asserts a SECOND, independently-addable
    //    agent worker can be created mid-session).
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );

    // 3. Mount the real Hono app (real routes, real vValidator middleware,
    //    real error handler) against this real AppContext.
    const app = await createTestApp(ctx);

    // 4. Send the exact request shape the client's createWorker() API call
    //    sends (see useTabManagement.ts addAgentTab -> AddAgentWorkerMenu.tsx).
    const res = await app.request(`/api/sessions/${created.id}/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'agent', agentId: CLAUDE_CODE_AGENT_ID }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { worker: { id: string; type: string; agentId: string } };
    expect(body.worker.type).toBe('agent');
    expect(body.worker.agentId).toBe(CLAUDE_CODE_AGENT_ID);

    // 5. Re-read the session: it now carries TWO independent agent workers
    //    (the session's fixed initial worker, plus the one just added).
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) {
      throw new Error('session not found after worker creation');
    }
    const agentWorkers = session.workers.filter((w) => w.type === 'agent');
    expect(agentWorkers).toHaveLength(2);
    expect(agentWorkers.some((w) => w.id === body.worker.id)).toBe(true);
  });

  it('rejects an agent worker request missing agentId at the real HTTP boundary (400, not a 500 crash)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const app = await createTestApp(ctx);

    const res = await app.request(`/api/sessions/${created.id}/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'agent' }),
    });

    expect(res.status).toBe(400);
  });
});
