/**
 * Client-Server Boundary Test: cross-type worker restart, agent ->
 * embedded-agent (Issue #1171).
 *
 * Exercises the real chain a PTY `agent` worker converted in-place to an
 * embedded-agent worker depends on:
 *   real HTTP POST /:sessionId/workers/:workerId/restart { embeddedAgentId }
 *     -> real vValidator(RestartWorkerRequestSchema) union member dispatch
 *     -> real route handler (packages/server/src/routes/workers.ts)
 *     -> real SessionManager.restartAgentWorkerAsEmbedded
 *     -> real WorkerLifecycleManager.restartAgentWorkerAsEmbedded
 *     -> real persisted row (type flips to 'embedded-agent')
 *     -> real onSessionUpdated / onWorkerRestarted lifecycle callbacks
 *        (wired the same way websocket/routes.ts's setupWebSocketRoutes does
 *        in production -- createTestContext() alone does not register this,
 *        same caveat as session-memo-boundary.test.ts)
 *     -> JSON serialize/parse (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser the client uses).
 *
 * Also documents the out-of-scope reverse direction (R8): a SECOND restart
 * with the terminal member against the now-embedded worker must not silently
 * succeed or corrupt state.
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
import { toPersistedWorker } from '@agent-console/server/src/database/mappers';
import type { PersistedWorker } from '@agent-console/server/src/services/persistence-service';
import type {
  SpawnAsUserFn,
  SpawnAsUserOpts,
  SpawnAsUserResult,
} from '@agent-console/server/src/services/privilege-elevation';

import { AppServerMessageSchema, type AppServerMessage } from '@agent-console/shared';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService (write/end/flush). */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/**
 * Fake spawnAsUser for the embedded-agent loop subprocess, so activation
 * (step 10 of restartAgentWorkerAsEmbedded's call order) succeeds without a
 * real provider call. Mirrors `makeFakeEmbeddedSpawn` in
 * `routes/__tests__/workers.test.ts`.
 */
function makeFakeEmbeddedSpawn(): { fn: SpawnAsUserFn; captured: SpawnAsUserOpts[] } {
  const captured: SpawnAsUserOpts[] = [];

  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { stdoutCtrl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { stderrCtrl = c; } });
  const exited = new Promise<number>(() => {});
  void stdoutCtrl;
  void stderrCtrl;

  const stdin: FakeFileSink = {
    write: () => 0,
    end: () => {},
    flush: () => 0,
  };

  const subprocess = { pid: 9876, exited, stdin, stdout, stderr, kill: () => {} };

  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };

  return { fn, captured };
}

describe('Client-Server Boundary: cross-type worker restart (agent -> embedded-agent, Issue #1171)', () => {
  let ctx: AppContext;
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let capturedBroadcasts: AppServerMessage[];
  let fakeEmbeddedSpawn: ReturnType<typeof makeFakeEmbeddedSpawn>;

  beforeEach(async () => {
    await setupTestEnvironment();

    capturedBroadcasts = [];
    fakeEmbeddedSpawn = makeFakeEmbeddedSpawn();
    ctx = await createTestContext({
      broadcastToApp: (msg) => {
        capturedBroadcasts.push(msg);
      },
      spawnAsUserFn: fakeEmbeddedSpawn.fn,
    });

    // Mirrors websocket/routes.ts's production onSessionUpdated /
    // onWorkerRestarted -> broadcastToApp wiring (setupWebSocketRoutes),
    // which createTestContext() alone does not register.
    ctx.sessionManager.setSessionLifecycleCallbacks({
      onSessionUpdated: (session) => {
        ctx.broadcastToApp({ type: 'session-updated', session });
      },
      onWorkerRestarted: (sessionId, workerId, activityState) => {
        ctx.broadcastToApp({ type: 'worker-restarted', sessionId, workerId, activityState });
      },
    });

    app = await createTestApp(ctx);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  function simulateWireTransmission(payload: unknown): unknown {
    return JSON.parse(JSON.stringify(payload));
  }

  it('converts a PTY agent worker to an embedded-agent worker via real HTTP restart; persisted row and broadcast frames survive the wire', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(87001, 'owner', '/home/owner');
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Ollama qwen3', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) throw new Error('session not found after creation');
    const ptyWorker = session.workers.find((w) => w.type === 'agent');
    if (!ptyWorker) throw new Error('expected an initial PTY agent worker');

    // createSession's own initial worker creation now also broadcasts
    // session-updated (Issue #1586, WorkerLifecycleManager.createWorker fires
    // onSessionUpdated for every newly created worker). This test's assertion
    // is about the RESTART's broadcast frames specifically, so clear the
    // setup-time frames before triggering the restart under test.
    capturedBroadcasts.length = 0;

    const res = await app.request(`/api/sessions/${created.id}/workers/${ptyWorker.id}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeddedAgentId: def.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { worker: { id: string; type: string; embeddedAgentId?: string } };
    expect(body.worker.id).toBe(ptyWorker.id);
    expect(body.worker.type).toBe('embedded-agent');
    expect(body.worker.embeddedAgentId).toBe(def.id);

    // Persisted row: type flips to 'embedded-agent' (real DB read through the
    // real production mapper, same pattern as
    // initial-prompt-eligibility-restart-boundary.test.ts).
    const rows = await ctx.db.selectFrom('workers').where('session_id', '=', created.id).selectAll().execute();
    const persistedWorkers: PersistedWorker[] = rows.map((r) => toPersistedWorker(r));
    const persisted = persistedWorkers.find((w) => w.id === ptyWorker.id);
    if (!persisted) throw new Error('persisted worker not found after conversion');
    expect(persisted.type).toBe('embedded-agent');

    // session-updated and worker-restarted broadcast frames parse through the
    // ACTUAL client-side schemas -- the whole point of this test.
    const sessionUpdatedFrames = capturedBroadcasts.filter((m) => m.type === 'session-updated');
    expect(sessionUpdatedFrames).toHaveLength(1);
    const parsedSessionUpdated = v.safeParse(
      AppServerMessageSchema,
      simulateWireTransmission(sessionUpdatedFrames[0]),
    );
    expect(parsedSessionUpdated.success).toBe(true);
    if (parsedSessionUpdated.success && parsedSessionUpdated.output.type === 'session-updated') {
      const parsedWorker = parsedSessionUpdated.output.session.workers.find((w) => w.id === ptyWorker.id);
      expect(parsedWorker?.type).toBe('embedded-agent');
    }

    const workerRestartedFrames = capturedBroadcasts.filter((m) => m.type === 'worker-restarted');
    expect(workerRestartedFrames).toHaveLength(1);
    const parsedWorkerRestarted = v.safeParse(
      AppServerMessageSchema,
      simulateWireTransmission(workerRestartedFrames[0]),
    );
    expect(parsedWorkerRestarted.success).toBe(true);
    if (parsedWorkerRestarted.success && parsedWorkerRestarted.output.type === 'worker-restarted') {
      expect(parsedWorkerRestarted.output.workerId).toBe(ptyWorker.id);
      expect(parsedWorkerRestarted.output.sessionId).toBe(created.id);
    }
  });

  it('rejects a reverse-direction (terminal-member) restart against an already-embedded worker (R8: out of scope, must not silently succeed)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(87002, 'owner2', '/home/owner2');
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Ollama qwen3', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) throw new Error('session not found after creation');
    const ptyWorker = session.workers.find((w) => w.type === 'agent');
    if (!ptyWorker) throw new Error('expected an initial PTY agent worker');

    // First restart: convert agent -> embedded-agent (same real HTTP path as
    // the test above).
    const firstRes = await app.request(`/api/sessions/${created.id}/workers/${ptyWorker.id}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeddedAgentId: def.id }),
    });
    expect(firstRes.status).toBe(200);

    // Second restart: the TERMINAL member (empty body -- today's ordinary
    // PTY restart shape) against the now-embedded worker. restartAgentWorker's
    // own existing guard (worker.type !== 'agent' -> null) makes this a 404,
    // not a silent success or a reverted/corrupted worker.
    const secondRes = await app.request(`/api/sessions/${created.id}/workers/${ptyWorker.id}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(secondRes.status).toBe(404);

    // The worker must still be the embedded-agent worker the first restart
    // produced -- not reverted, not duplicated. (createSession also creates
    // an automatic git-diff worker alongside the initial worker, so the
    // session has two persisted rows total.)
    const rows = await ctx.db.selectFrom('workers').where('session_id', '=', created.id).selectAll().execute();
    const persistedWorkers: PersistedWorker[] = rows.map((r) => toPersistedWorker(r));
    expect(persistedWorkers).toHaveLength(2);
    const persistedConverted = persistedWorkers.find((w) => w.id === ptyWorker.id);
    expect(persistedConverted?.type).toBe('embedded-agent');
  });
});
