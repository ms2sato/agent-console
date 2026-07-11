/**
 * Client-Server Boundary Test: EmbeddedAgentWorker (Issue #1007, CLAUDE.md Q10)
 *
 * Regression guard for the wire boundary of the new `embedded-agent` worker
 * type. A worker created with `{ type: 'embedded-agent', embeddedAgentId }`
 * must survive the server -> JSON wire -> `AppServerMessageSchema.safeParse`
 * round-trip with its discriminant (`type`), its `embeddedAgentId`, and its
 * `activated` flag intact. valibot's default object parse silently strips
 * unknown fields, so a `WorkerSchema` union that omits `EmbeddedAgentWorkerSchema`
 * would drop the worker (or its fields) with no compile / runtime error until
 * manual QA notices the gap. Neither server unit tests (which never cross the
 * schema boundary) nor frontend mock-factory tests (which inject pre-built
 * worker objects) can catch that.
 *
 * This boundary test exercises the real chain:
 *   ctx.embeddedAgentManager.createEmbeddedAgent
 *     -> ctx.sessionManager.createSession
 *     -> ctx.sessionManager.createWorker({ type: 'embedded-agent', ... })
 *     -> re-read the public session (toPublicWorker sets activated: false)
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser the client uses)
 *   assert the embedded-agent worker survives end-to-end.
 *
 * Removing `EmbeddedAgentWorkerSchema` from the `WorkerSchema` union in
 * packages/shared/src/schemas/app-server-message.ts causes this test to fail
 * (the worker is stripped or the safeParse rejects the sessions-sync payload).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';

import { AppServerMessageSchema } from '@agent-console/shared';

describe('Client-Server Boundary: EmbeddedAgentWorker', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('survives the server -> JSON wire -> AppServerMessageSchema.safeParse round-trip', async () => {
    // 1. Seed a user so createSession satisfies the created_by FK.
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    // 2. Create an embedded-agent definition through the real manager.
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      },
      owner.id,
    );

    // 3. Create a session and attach a (deactivated) embedded-agent worker.
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );

    const worker = await ctx.sessionManager.createWorker(created.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    expect(worker).not.toBeNull();

    // 4. Re-read the public session so it carries the worker as toPublicWorker
    //    serializes it (activated derived from subprocess === null).
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) {
      throw new Error('session not found after worker creation');
    }
    const embeddedWorkerBefore = session.workers.find((w) => w.type === 'embedded-agent');
    expect(embeddedWorkerBefore).toBeDefined();
    expect(embeddedWorkerBefore?.type === 'embedded-agent' && embeddedWorkerBefore.activated).toBe(
      false,
    );

    // 5. Build the sessions-sync payload and simulate wire transmission.
    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'sessions-sync',
        sessions: [session],
        activityStates: [],
      }),
    );

    // 6. Apply the SAME parser the client uses in app-websocket.ts.
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'sessions-sync') {
      throw new Error(`Expected sessions-sync, got: ${parsed.output.type}`);
    }

    const parsedSession = parsed.output.sessions.find((s) => s.id === created.id);
    if (!parsedSession) {
      throw new Error('session missing from parsed sessions-sync payload');
    }

    // 7. The crucial assertions: the embedded-agent worker survived the parser
    //    with its discriminant and derived fields intact.
    const parsedWorker = parsedSession.workers.find((w) => w.type === 'embedded-agent');
    expect(parsedWorker).toBeDefined();
    if (!parsedWorker || parsedWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker stripped by the schema parser');
    }
    expect(parsedWorker.embeddedAgentId).toBe(def.id);
    expect(parsedWorker.activated).toBe(false);
  });
});
