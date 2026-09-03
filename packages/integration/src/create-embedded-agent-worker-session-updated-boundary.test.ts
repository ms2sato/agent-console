/**
 * Client-Server Boundary Test: `session-updated` broadcast shape for a
 * mid-session embedded-agent worker creation (Issue #1586, CLAUDE.md Q10)
 *
 * Regression guard for the wire boundary of the `onSessionUpdated` broadcast
 * that `WorkerLifecycleManager.createWorker` now fires (for every worker
 * type, including `embedded-agent`) right after persisting a newly created
 * worker. Neither the server unit tests for `WorkerLifecycleManager` (which
 * assert the callback is invoked with an in-memory `PublicSession` object,
 * never touching JSON or the schema boundary) nor client unit tests (which
 * inject pre-built mock sessions) prove that a REAL public session --
 * carrying a REAL freshly created `embedded-agent` worker, with its
 * `embeddedAgentId` -- survives the `{ type: 'session-updated', session }`
 * wire payload through `AppServerMessageSchema.safeParse`, the same parser
 * `packages/client/src/lib/app-websocket.ts`'s `parseMessage` uses.
 *
 * This boundary test exercises the real chain:
 *   real HTTP POST /api/sessions/:id/workers
 *     { type: 'embedded-agent', embeddedAgentId }
 *     -> real vValidator(CreateWorkerRequestSchema) parse
 *     -> real route handler (packages/server/src/routes/workers.ts)
 *     -> real SessionManager.createWorker -> WorkerLifecycleManager
 *     -> real 'embedded-agent' branch (subprocess spawn mocked at the lowest
 *        level only, same as embedded-agent-worker-boundary.test.ts)
 *   re-read the public session (the same shape `onSessionUpdated` broadcasts)
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse
 *   assert the newly created worker, with its `embeddedAgentId`, survives
 *   end-to-end inside the `session-updated` payload's `session.workers`.
 *
 * Removing `embeddedAgentId` from `EmbeddedAgentWorkerSchema` (or removing
 * `EmbeddedAgentWorkerSchema` from the `WorkerSchema` union) in
 * packages/shared/src/schemas/app-server-message.ts causes this test's final
 * assertions to fail (the field, or the whole worker, is stripped by
 * safeParse).
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
import { CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';

import { AppServerMessageSchema } from '@agent-console/shared';

describe('Client-Server Boundary: session-updated broadcast for embedded-agent worker creation (Issue #1586)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('survives the server -> JSON wire -> AppServerMessageSchema.safeParse round-trip with embeddedAgentId intact', async () => {
    // 1. Seed a user so createSession satisfies the created_by FK.
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    // 2. Create an embedded-agent definition through the real manager, so
    //    the worker we create below references a real, resolvable id.
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      },
      owner.id,
    );

    // 3. Create a running session through the real manager (initial worker
    //    is a terminal-agent worker; this test adds a SECOND, independently
    //    addable embedded-agent worker mid-session -- the exact scenario
    //    from Issue #1586 where the session-updated broadcast was missing).
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );

    // 4. Mount the real Hono app (real routes, real vValidator middleware,
    //    real error handler) against this real AppContext.
    const app = await createTestApp(ctx);

    // 5. Send the exact request shape the client's addAgentTab sends for an
    //    embedded-agent pick (useTabManagement.ts -> AddAgentWorkerMenu.tsx).
    const res = await app.request(`/api/sessions/${created.id}/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'embedded-agent', embeddedAgentId: def.id }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      worker: { id: string; type: string; embeddedAgentId: string };
    };
    expect(body.worker.type).toBe('embedded-agent');
    expect(body.worker.embeddedAgentId).toBe(def.id);

    // 6. Re-read the session: this is the same public-session shape the
    //    just-landed R1 fix passes to `onSessionUpdated` right after
    //    persisting the new worker.
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) {
      throw new Error('session not found after worker creation');
    }
    const embeddedWorker = session.workers.find((w) => w.id === body.worker.id);
    expect(embeddedWorker).toBeDefined();
    expect(embeddedWorker?.type).toBe('embedded-agent');
    if (!embeddedWorker || embeddedWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker missing from re-read session');
    }
    expect(embeddedWorker.embeddedAgentId).toBe(def.id);

    // 7. Construct the actual session-updated WebSocket payload shape
    //    (mirrors the server's broadcastToApp({ type: 'session-updated',
    //    session }) in packages/server/src/websocket/routes.ts) and simulate
    //    wire transmission via JSON serialize / parse.
    const wirePayload = JSON.parse(JSON.stringify({ type: 'session-updated', session }));

    // 8. Apply the SAME parser the client uses in app-websocket.ts. If a
    //    wire schema strips or rejects embeddedAgentId, safeParse either
    //    fails outright (v.strictObject) or the field is stripped silently.
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'session-updated') {
      throw new Error(`Expected session-updated, got: ${parsed.output.type}`);
    }

    // 9. The crucial assertions: the newly created embedded-agent worker
    //    survived the parser inside the session-updated payload, with the
    //    embeddedAgentId field the client's resolveActiveEmbeddedAgentId
    //    (SessionPage.tsx) actually keys off.
    const parsedWorker = parsed.output.session.workers.find((w) => w.id === body.worker.id);
    expect(parsedWorker).toBeDefined();
    if (!parsedWorker || parsedWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker stripped by the schema parser');
    }
    expect(parsedWorker.embeddedAgentId).toBe(def.id);
  });
});
