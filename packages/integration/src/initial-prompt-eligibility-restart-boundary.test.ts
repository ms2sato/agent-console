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
import type {
  SpawnAsUserFn,
  SpawnAsUserOpts,
  SpawnAsUserResult,
  RunAsUserOpts,
  RunAsUserResult,
} from '@agent-console/server/src/services/privilege-elevation';

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

/**
 * Cross-type restart initial-prompt delivery: an eligible PTY `agent`
 * worker's carried-over `deliverInitialPromptOnActivation` flag must
 * actually cause delivery once the CONVERTED embedded-agent worker's real
 * activation reports `ready` -- not merely survive as a boolean on the
 * worker object (that half is pinned separately at the
 * WorkerLifecycleManager unit-test layer).
 *
 * Both polarities were verified manually for the "delivers" test: it FAILS
 * (no `user-message` stdin write; timeout) if
 * `WorkerLifecycleManager.restartAgentWorkerAsEmbedded`'s
 * `deliverInitialPromptOnActivation: existingWorker.deliverInitialPromptOnActivation`
 * carry-over is replaced with a hardcoded `false`, and PASSES with the real
 * carry-over in place.
 */
describe('Cross-type restart: initial-prompt delivery on the converted embedded-agent worker', () => {
  let ctx: AppContext;

  /** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
  interface FakeFileSink {
    write: (chunk: string | Uint8Array) => number;
    end: () => void;
    flush: () => number;
  }

  function makeFakeEmbeddedSpawn(): {
    fn: SpawnAsUserFn;
    stdinWrites: string[];
    pushStdout: (s: string) => void;
  } {
    const stdinWrites: string[] = [];
    const stdin: FakeFileSink = {
      write: (chunk) => {
        stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return 0;
      },
      end: () => {},
      flush: () => 0,
    };

    let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { stdoutCtrl = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { stderrCtrl = c; } });
    void stderrCtrl;
    const enc = new TextEncoder();
    const pushStdout = (s: string) => stdoutCtrl.enqueue(enc.encode(s));

    const exited = new Promise<number>(() => {});
    const subprocess = { pid: 4200, exited, stdin, stdout, stderr, kill: () => {} };

    const fn: SpawnAsUserFn = (_opts: SpawnAsUserOpts) =>
      ({ subprocess, stdin, elevated: false }) as unknown as SpawnAsUserResult;

    return { fn, stdinWrites, pushStdout };
  }

  async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitFor timed out');
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  beforeEach(async () => {
    await setupTestEnvironment();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('delivers the carried-over initial prompt as the converted worker\'s first message once ready fires', async () => {
    const spawn = makeFakeEmbeddedSpawn();
    // The initial PTY worker below is created WITH a non-empty
    // initialPrompt, which triggers a real elevated `cat >` prompt-file
    // write unconditionally (not gated on auth mode) -- stub it to always
    // succeed so worker creation doesn't hit the real OS.
    const stubRunAsUser = async (_opts: RunAsUserOpts): Promise<RunAsUserResult> => ({
      stdout: '', stderr: '', exitCode: 0, timedOut: false,
    });
    ctx = await createTestContext({ spawnAsUserFn: spawn.fn, runAsUserImpl: stubRunAsUser });

    const owner = await ctx.userRepository.upsertByOsUid(55001, 'owner', '/home/owner');
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Ollama qwen3', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );

    // The initial PTY agent worker, created WITH an initialPrompt (the only
    // path that sets deliverInitialPromptOnActivation: true).
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code', initialPrompt: 'Do the thing' },
      { createdBy: owner.id },
    );
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) throw new Error('session not found after creation');
    const ptyWorker = session.workers.find((w) => w.type === 'agent');
    if (!ptyWorker) throw new Error('expected an initial PTY agent worker');

    const converted = await ctx.sessionManager.restartAgentWorkerAsEmbedded(
      created.id, ptyWorker.id, def.id,
    );
    expect(converted).not.toBeNull();

    spawn.pushStdout('{"v":1,"type":"ready"}\n');
    await waitFor(() => spawn.stdinWrites.some((w) => w.includes('"type":"user-message"')));

    const delivered = spawn.stdinWrites.find((w) => w.includes('"type":"user-message"'));
    expect(delivered).toBeDefined();
    const parsed = JSON.parse(delivered!);
    expect(parsed.text).toBe('Do the thing');
  });

  it('does NOT re-deliver when the session\'s initial prompt was already delivered before conversion', async () => {
    const spawn = makeFakeEmbeddedSpawn();
    // The initial PTY worker below is created WITH a non-empty
    // initialPrompt, which triggers a real elevated `cat >` prompt-file
    // write unconditionally (not gated on auth mode) -- stub it to always
    // succeed so worker creation doesn't hit the real OS.
    const stubRunAsUser = async (_opts: RunAsUserOpts): Promise<RunAsUserResult> => ({
      stdout: '', stderr: '', exitCode: 0, timedOut: false,
    });
    ctx = await createTestContext({ spawnAsUserFn: spawn.fn, runAsUserImpl: stubRunAsUser });

    const owner = await ctx.userRepository.upsertByOsUid(55002, 'owner2', '/home/owner2');
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Ollama qwen3', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code', initialPrompt: 'Do the thing' },
      { createdBy: owner.id },
    );
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) throw new Error('session not found after creation');
    const ptyWorker = session.workers.find((w) => w.type === 'agent');
    if (!ptyWorker) throw new Error('expected an initial PTY agent worker');

    // Simulate the prompt already having been delivered by a prior PTY
    // activation. Production only flips this flag via a real PTY
    // login-shell-ready sentinel (session-manager.ts's callback wired in its
    // constructor), which this harness's real PTY provider does not
    // reliably emit inside a test process -- and SessionManager.getSession()
    // / getAllSessions() both return a fresh toPublicSession() projection
    // (session-converter-service.ts builds a new plain object every call),
    // decoupled from the live internal session, so mutating either return
    // value has no effect on what restartAgentWorkerAsEmbedded reads. This
    // is the SAME limitation initial-prompt-delivered-boundary.test.ts's
    // header comment documents for the wire-schema half of this exact flag.
    // Use the narrow test-only accessor to set up this precondition on the
    // live internal session directly (see its own JSDoc for why).
    ctx.sessionManager.setInitialPromptDeliveredForTest(created.id, true);

    const converted = await ctx.sessionManager.restartAgentWorkerAsEmbedded(
      created.id, ptyWorker.id, def.id,
    );
    expect(converted).not.toBeNull();

    spawn.pushStdout('{"v":1,"type":"ready"}\n');
    // Bounded wait for the async delivery-check to settle; no user-message
    // write should follow.
    await new Promise((r) => setTimeout(r, 100));

    expect(spawn.stdinWrites.some((w) => w.includes('"type":"user-message"'))).toBe(false);
  });
});
