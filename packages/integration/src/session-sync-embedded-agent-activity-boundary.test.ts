/**
 * Client-Server Boundary Test: sessions-sync embedded-agent activity state (Issue #1028)
 *
 * `buildSessionsSyncMessage()` (packages/server/src/websocket/app-handler.ts)
 * collects per-worker `activityState` for the `sessions-sync` payload that the
 * client's `handleSessionsSync` uses to FULLY REPLACE its local
 * `workerActivityStates` map on every WebSocket (re)connect. If this
 * collection loop skips `embedded-agent` workers, an in-progress embedded-agent
 * turn's 'active' state is silently dropped from the client on every reload
 * or reconnect -- even though the live `worker-activity` broadcast sets it
 * correctly in between syncs. The End/Pause session dialogs' "active worker"
 * warning (Issue #1028) reads directly from this same client-side map, so a
 * regression here makes that warning unreliable without any unit test
 * (server-side or client-side) noticing, since both sides only ever exercise
 * their own mocked half of the wire.
 *
 * This test exercises the real chain:
 *   ctx.sessionManager.createWorker({ type: 'embedded-agent', ... })
 *     -> directly flip the internal worker's activityState to 'active'
 *        (simulating an in-flight turn, the same field
 *        EmbeddedAgentWorkerService.broadcastActivity writes)
 *     -> buildSessionsSyncMessage({ getAllSessions, getAllPausedSessions,
 *        getWorkerActivityState } wired to the real sessionManager)
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser the client uses)
 *   assert the embedded-agent worker's 'active' state survives end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { buildSessionsSyncMessage } from '@agent-console/server/src/websocket/app-handler';

import { AppServerMessageSchema } from '@agent-console/shared';

describe('Client-Server Boundary: sessions-sync embedded-agent activity state', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('includes an in-progress embedded-agent turn in the sessions-sync payload', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      },
      owner.id,
    );

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );

    const worker = await ctx.sessionManager.createWorker(created.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    expect(worker).not.toBeNull();
    if (!worker) throw new Error('worker creation returned null');

    // Simulate an in-flight turn: this is the exact field
    // EmbeddedAgentWorkerService.broadcastActivity writes when the loop is
    // calling the LLM / executing a tool.
    const internalWorker = ctx.sessionManager.getWorker(created.id, worker.id);
    if (!internalWorker || internalWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker not found internally after creation');
    }
    internalWorker.activityState = 'active';

    const syncMsg = await buildSessionsSyncMessage({
      getAllSessions: () => ctx.sessionManager.getAllSessions(),
      getAllPausedSessions: () => ctx.sessionManager.getAllPausedSessions(),
      getWorkerActivityState: (sessionId, workerId) =>
        ctx.sessionManager.getWorkerActivityState(sessionId, workerId),
    });

    expect(syncMsg.activityStates).toContainEqual({
      sessionId: created.id,
      workerId: worker.id,
      activityState: 'active',
    });

    // Round-trip through the wire + the same parser the client uses.
    const wirePayload = JSON.parse(JSON.stringify(syncMsg));
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

    expect(parsed.output.activityStates).toContainEqual({
      sessionId: created.id,
      workerId: worker.id,
      activityState: 'active',
    });
  });
});
