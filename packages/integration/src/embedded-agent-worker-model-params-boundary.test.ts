/**
 * Client-Server Boundary Test: embedded-agent model/reasoningEffort/
 * contextWindowTokens worker override, wire schema through the choke point
 * (Issue #1554)
 *
 * `CreateEmbeddedAgentWorkerParamsSchema` (`packages/shared/src/schemas/worker.ts`)
 * gained optional `model` / `reasoningEffort` / `contextWindowTokens` fields.
 * Per pre-pr-completeness.md Q10, a shared-type field crossing the
 * server/client wire needs an integration test exercising the REAL chain end
 * to end, not just a schema unit test (which never touches the wire
 * boundary) or a route/service unit test (which mocks collaborators and
 * never reaches a real HTTP request).
 *
 * This test drives the real chain:
 *
 *   real HTTP POST /api/sessions/:id/workers
 *     { type: 'embedded-agent', embeddedAgentId, model, reasoningEffort,
 *       contextWindowTokens }
 *     -> real vValidator(CreateWorkerRequestSchema) parse (a schema omission
 *        would 400 synchronously, before the route handler ever runs --
 *        v.strictObject rejects unknown keys)
 *     -> real route handler (packages/server/src/routes/workers.ts)
 *     -> real SessionManager.createWorker -> WorkerLifecycleManager
 *        .createWorker's embedded-agent capability validation (the single
 *        choke point, agent-surface.md Ruling 1/4)
 *     -> real WorkerManager.initializeEmbeddedAgentWorker
 *     -> real persistSession (mappers.ts toPersistedWorker)
 *
 * The response body never exposes model/reasoningEffort/contextWindowTokens
 * (not part of the public Worker wire shape -- mirrors how
 * agent-parameter-worktree-boundary.test.ts reads the PERSISTED row rather
 * than the HTTP response for the terminal-agent sibling of this same Issue).
 * This test reads the real, persisted worker ROW directly from the
 * disposable instance's own SQLite file.
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

describe('Client-Server Boundary: embedded-agent model/reasoningEffort/contextWindowTokens worker creation (Issue #1554)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('a real HTTP request with model/reasoningEffort/contextWindowTokens passes wire validation and reaches the persisted worker row', async () => {
    // 1. Seed a user so createSession satisfies the created_by FK.
    const owner = await ctx.userRepository.upsertByOsUid(64321, 'owner-1554-a', '/home/owner-1554-a');

    // 2. Persist a real embedded-agent definition (engine: 'openai-api',
    //    which the production capability table declares capable:true for
    //    both model and reasoningEffort, acceptedValues: null pass-through).
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Boundary Test Embedded Agent',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      },
      owner.id,
    );

    // 3. Create a session through the real manager (initial worker is a
    //    terminal agent -- this test asserts an INDEPENDENTLY-addable
    //    embedded-agent worker can be created mid-session with overrides).
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );

    // 4. Mount the real Hono app (real routes, real vValidator middleware,
    //    real error handler) against this real AppContext.
    const app = await createTestApp(ctx);

    // 5. Send the exact request shape the client's createWorker() API call
    //    would send for an embedded-agent worker with overrides.
    const res = await app.request(`/api/sessions/${created.id}/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'embedded-agent',
        embeddedAgentId: def.id,
        model: 'qwen3:14b',
        reasoningEffort: 'high',
        contextWindowTokens: 32000,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { worker: { id: string; type: string; embeddedAgentId: string } };
    expect(body.worker.type).toBe('embedded-agent');
    expect(body.worker.embeddedAgentId).toBe(def.id);

    // 6. The real, persisted worker ROW carries the overrides -- read
    //    directly from the disposable instance's own SQLite file (the wire
    //    response never exposes model/reasoningEffort/contextWindowTokens
    //    back to the caller).
    const workerRow = await ctx.db
      .selectFrom('workers')
      .where('id', '=', body.worker.id)
      .select(['model', 'reasoning_effort', 'context_window_tokens'])
      .executeTakeFirstOrThrow();
    expect(workerRow.model).toBe('qwen3:14b');
    expect(workerRow.reasoning_effort).toBe('high');
    expect(workerRow.context_window_tokens).toBe(32000);
  });

  it('rejects contextWindowTokens without an accompanying model override at the real HTTP boundary (400, not silently dropped, agent-surface.md Ruling 4)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(64322, 'owner-1554-b', '/home/owner-1554-b');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Boundary Test Embedded Agent 2',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      },
      owner.id,
    );

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );

    const app = await createTestApp(ctx);

    const res = await app.request(`/api/sessions/${created.id}/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'embedded-agent',
        embeddedAgentId: def.id,
        contextWindowTokens: 32000,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('contextWindowTokens');

    // No second (embedded-agent) worker was persisted for the rejected
    // request -- only the session's own initial terminal-agent worker
    // remains.
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) {
      throw new Error('session not found after rejected worker creation');
    }
    expect(session.workers.some((w) => w.type === 'embedded-agent')).toBe(false);
  });
});
