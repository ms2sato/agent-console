/**
 * Persistence Boundary Test: embedded-agent initial-prompt eligibility
 * survives a server restart (Issue #1074, follow-up to PR #1073's architect
 * audit finding F1).
 *
 * `InternalEmbeddedAgentWorker.deliverInitialPromptOnActivation` gates
 * whether `EmbeddedAgentWorkerService.maybeDeliverInitialPrompt` delivers the
 * session's `initialPrompt` as the worker's first user message once the loop
 * reports `ready`. Before this fix, `WorkerManager.restoreWorkersFromPersistence`
 * hard-coded this marker to `false` on restore because it was never part of
 * `PersistedWorker` -- so a server restart before the initial worker's first
 * activation permanently and silently dropped the initial-prompt delivery.
 *
 * Scope note: a full "second server process" restart cannot be cleanly
 * simulated in this harness. `createTestContext()` always builds a fresh
 * in-memory DB, and `SessionManager.resumeSession` short-circuits and returns
 * the already-loaded in-memory session when called against the same live
 * `ctx.sessionManager` right after creation -- it does NOT exercise the
 * restore path. So this test exercises the exact restore mechanics directly:
 * a real SQLite DB (`ctx.db`), the real production mapper (`toPersistedWorker`
 * from `../../server/src/database/mappers.js`), and a FRESHLY CONSTRUCTED
 * `WorkerManager` instance (simulating the clean in-memory state a genuinely
 * restarted process would have) calling the real
 * `restoreWorkersFromPersistence`. This is not a second server process; it is
 * the narrowest real-chain reproduction of the restart boundary available in
 * this harness (mirrors the scope-limit documentation pattern used by the
 * sibling `initial-prompt-delivered-boundary.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { WorkerManager } from '@agent-console/server/src/services/worker-manager';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { toPersistedWorker } from '@agent-console/server/src/database/mappers';
import type { PersistedWorker } from '@agent-console/server/src/services/persistence-service';

describe('Persistence boundary: embedded-agent initial-prompt eligibility survives restart (Issue #1074)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('persists deliverInitialPromptOnActivation=true for the initial embedded-agent worker and restores it after simulated restart', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Ollama qwen3', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );

    // Create session with the embedded-agent worker as the INITIAL worker
    // (embeddedAgentId + initialPrompt at session-creation time) -- this is
    // the only path that sets deliverInitialPromptOnActivation: true.
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', embeddedAgentId: def.id, initialPrompt: 'Do the thing' },
      { createdBy: owner.id },
    );

    // Sanity: in-memory worker is eligible right after creation.
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) throw new Error('session not found after creation');
    const embeddedWorkerId = session.workers.find((w) => w.type === 'embedded-agent')?.id;
    if (!embeddedWorkerId) throw new Error('embedded-agent worker not found');

    // Read the real persisted row back from SQLite through the production mapper.
    const rows = await ctx.db.selectFrom('workers').where('session_id', '=', created.id).selectAll().execute();
    const persistedWorkers: PersistedWorker[] = rows.map((r) => toPersistedWorker(r));
    const persistedEmbedded = persistedWorkers.find((w) => w.type === 'embedded-agent');
    if (!persistedEmbedded || persistedEmbedded.type !== 'embedded-agent') {
      throw new Error('persisted embedded-agent worker not found');
    }
    // This is the create-path assertion: the marker made it into the DB row.
    expect(persistedEmbedded.deliverInitialPromptOnActivation).toBe(true);

    // Simulate "server restart before activation": a FRESH WorkerManager
    // instance (mirroring a new process's clean in-memory state) restoring
    // from the persisted rows just read above.
    const freshWorkerManager = new WorkerManager(
      ctx.userMode,
      ctx.agentManager,
      new WorkerOutputFileManager(),
      ctx.mcpTokenRegistry,
    );
    const restored = freshWorkerManager.restoreWorkersFromPersistence(persistedWorkers);
    const restoredEmbedded = restored.get(embeddedWorkerId);
    if (!restoredEmbedded || restoredEmbedded.type !== 'embedded-agent') {
      throw new Error('restored embedded-agent worker not found');
    }
    // The core regression-guard: restore path reads the persisted value
    // instead of hard-coding false (pre-#1074 behavior).
    expect(restoredEmbedded.deliverInitialPromptOnActivation).toBe(true);
    expect(restoredEmbedded.subprocess).toBeNull();
  });

  it('does not mark a later add-on embedded-agent worker as eligible, and that survives restore too', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Ollama qwen3', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );

    // Session created WITHOUT embeddedAgentId/initialPrompt as the initial worker...
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path2', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    // ...then an embedded-agent worker is added via the generic add-worker route.
    const addedWorker = await ctx.sessionManager.createWorker(created.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    if (!addedWorker) throw new Error('failed to create add-on embedded-agent worker');

    const rows = await ctx.db.selectFrom('workers').where('session_id', '=', created.id).selectAll().execute();
    const persistedWorkers: PersistedWorker[] = rows.map((r) => toPersistedWorker(r));
    const persistedEmbedded = persistedWorkers.find((w) => w.type === 'embedded-agent');
    if (!persistedEmbedded || persistedEmbedded.type !== 'embedded-agent') {
      throw new Error('persisted embedded-agent worker not found');
    }
    expect(persistedEmbedded.deliverInitialPromptOnActivation).toBe(false);

    const freshWorkerManager = new WorkerManager(
      ctx.userMode,
      ctx.agentManager,
      new WorkerOutputFileManager(),
      ctx.mcpTokenRegistry,
    );
    const restored = freshWorkerManager.restoreWorkersFromPersistence(persistedWorkers);
    const restoredEmbedded = restored.get(addedWorker.id);
    if (!restoredEmbedded || restoredEmbedded.type !== 'embedded-agent') {
      throw new Error('restored embedded-agent worker not found');
    }
    expect(restoredEmbedded.deliverInitialPromptOnActivation).toBe(false);
  });
});
