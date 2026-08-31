/**
 * Idle eviction, service half: which workers are eligible, the commit-point
 * re-check when a countdown elapses, and the delivery invariant that makes an
 * evicted worker indistinguishable from a live one to every caller.
 *
 * Separate from embedded-agent-worker-service.test.ts because these tests need
 * a spawn fake that produces a FRESH incarnation per spawn -- eviction is the
 * first path in this service where one worker legitimately spawns twice within
 * a single test, and the sibling file's single-subprocess fake cannot express
 * that.
 */
import { describe, it, expect, mock } from 'bun:test';
import type { EmbeddedAgentDefinition, ExitReason } from '@agent-console/shared';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../privilege-elevation.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import {
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';
import {
  EmbeddedAgentWorkerService,
  EmbeddedAgentActivationError,
  GENERIC_EMBEDDED_ACTIVATION_FAILURE_MESSAGE,
} from '../embedded-agent-worker-service.js';

const MCP_BASE_URL = 'http://localhost:3457/mcp';
const ENTRY_PATH = '/install/embedded-agent/src/main.ts';
const USERNAME = 'alice';

const SDK_DEFINITION: EmbeddedAgentDefinition = {
  id: 'def-sdk',
  name: 'Claude',
  engine: 'claude-sdk',
  provider: { model: 'claude-sonnet-5' },
  isBuiltIn: true,
  createdBy: 'system',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const OPENAI_DEFINITION: EmbeddedAgentDefinition = {
  id: 'def-openai',
  name: 'Ollama qwen',
  engine: 'openai-api',
  provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
  isBuiltIn: false,
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/** One spawned subprocess, with the hooks a test needs to drive it. */
interface Incarnation {
  stdinWrites: string[];
  killSignals: number[];
  pushStdout: (s: string) => void;
  simulateExit: (code: number) => void;
  hasExited: () => boolean;
}

interface SpawnFactory {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  incarnations: Incarnation[];
  latest: () => Incarnation;
}

/**
 * A spawn fake that mints a NEW subprocess (own streams, own `exited`) on every
 * call, so a worker can be evicted and woken inside one test.
 *
 * `exitOnShutdown` mirrors a well-behaved loop: it exits when told to, which is
 * what lets `deactivate` resolve inside its grace window instead of escalating.
 * Turning it off is how a test holds an eviction open long enough to race a
 * message against it.
 */
function makeSpawnFactory(opts?: { exitOnShutdown?: boolean }): SpawnFactory {
  const exitOnShutdown = opts?.exitOnShutdown ?? true;
  const captured: SpawnAsUserOpts[] = [];
  const incarnations: Incarnation[] = [];

  const fn: SpawnAsUserFn = (spawnOpts) => {
    captured.push(spawnOpts);

    const stdinWrites: string[] = [];
    const killSignals: number[] = [];
    let exited = false;

    let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtrl = c;
      },
    });
    let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtrl = c;
      },
    });
    const enc = new TextEncoder();

    let resolveExited!: (code: number) => void;
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });

    const simulateExit = (code: number): void => {
      if (exited) return;
      exited = true;
      resolveExited(code);
      stdoutCtrl.close();
      stderrCtrl.close();
    };

    const stdin: FakeFileSink = {
      write: (chunk) => {
        const s = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        stdinWrites.push(s);
        if (exitOnShutdown && s.includes('"type":"shutdown"')) {
          simulateExit(0);
        }
        return 0;
      },
      end: () => {},
      flush: () => 0,
    };

    const subprocess = {
      pid: 4000 + incarnations.length,
      exited: exitedPromise,
      stdin,
      stdout,
      stderr,
      kill: (signal?: number) => {
        killSignals.push(signal ?? 15);
        simulateExit(137);
      },
    };

    incarnations.push({
      stdinWrites,
      killSignals,
      pushStdout: (s: string) => {
        if (!exited) stdoutCtrl.enqueue(enc.encode(s));
      },
      simulateExit,
      hasExited: () => exited,
    });

    const result: Pick<SpawnAsUserResult, 'elevated'> & {
      subprocess: typeof subprocess;
      stdin: FakeFileSink;
    } = { subprocess, stdin, elevated: false };
    return result as unknown as SpawnAsUserResult;
  };

  return {
    fn,
    captured,
    incarnations,
    latest: () => incarnations[incarnations.length - 1],
  };
}

interface Harness {
  service: EmbeddedAgentWorkerService;
  sessionId: string;
  workerId: string;
  worker: ReturnType<typeof buildInternalEmbeddedAgentWorker>;
  session: ReturnType<typeof buildInternalWorktreeSession>;
  spawn: SpawnFactory;
  bufferOutput: ReturnType<typeof mock>;
  globalExit: ReturnType<typeof mock>;
  onExit: ReturnType<typeof mock>;
}

function setup(opts?: {
  definition?: EmbeddedAgentDefinition;
  idleEvictionMs?: number;
  shutdownGraceMs?: number;
  sigtermTimeoutMs?: number;
  exitOnShutdown?: boolean;
  initialPrompt?: string;
  deliverInitialPromptOnActivation?: boolean;
  /** Throw from the spawn seam from the Nth spawn onwards (0-based) to fail a wake. */
  failSpawnFrom?: number;
  failSpawnWith?: Error;
  /**
   * Simulate a real worker output file spanning incarnations: appended lines
   * accumulate, `hasEverBeenActivated` flips true once anything has been
   * written, and `readHistoryWithOffset` replays it. Off by default so the
   * other tests keep taking the cheap first-ever-activation branch on every
   * spawn; on for tests where the WAKE must exercise the restore/resume path.
   */
  persistAcrossIncarnations?: boolean;
}): Harness {
  const worker = buildInternalEmbeddedAgentWorker({
    id: 'w-emb',
    embeddedAgentId: 'def-1',
    deliverInitialPromptOnActivation: opts?.deliverInitialPromptOnActivation ?? false,
  });
  const session = buildInternalWorktreeSession([worker], {
    createdBy: 'user-1',
    initialPrompt: opts?.initialPrompt,
  });
  const spawn = makeSpawnFactory({ exitOnShutdown: opts?.exitOnShutdown });

  // Stands in for the worker's on-disk output file when
  // `persistAcrossIncarnations` is set.
  const persisted: string[] = [];
  const bufferOutput = mock((_sessionId: string, _workerId: string, data: string) => {
    if (opts?.persistAcrossIncarnations) persisted.push(data);
  });
  const globalExit = mock(() => {});
  const onExit = mock(() => {});
  worker.connectionCallbacks.set('conn-1', {
    onData: (() => {}) as unknown as (data: string, offset: number, epoch: number) => void,
    onExit: onExit as unknown as (code: number, sig: string | null, reason?: ExitReason) => void,
  });

  let spawnCount = 0;
  const spawnFn: SpawnAsUserFn = (spawnOpts) => {
    if (opts?.failSpawnFrom !== undefined && spawnCount >= opts.failSpawnFrom) {
      spawnCount += 1;
      throw opts.failSpawnWith ?? new Error('spawn boom');
    }
    spawnCount += 1;
    return spawn.fn(spawnOpts);
  };

  const service = new EmbeddedAgentWorkerService({
    getSession: (id) => (id === session.id ? session : undefined),
    persistSession: (async () => {}) as never,
    getPathResolver: () => new SessionDataPathResolver('/test/config/repositories/test-repo'),
    getEmbeddedAgent: () => opts?.definition ?? SDK_DEFINITION,
    resolveSpawnUsername: async () => USERNAME,
    mcpTokenRegistry: { mint: (() => 'mcp-token') as never, revokeByWorker: (() => {}) as never },
    workerOutputFileManager: {
      resetWorkerOutput: (async () => {
        persisted.length = 0; // a reset truncates the live file
        return 4242;
      }) as never,
      bufferOutput: bufferOutput as never,
      hasEverBeenActivated: (async () =>
        opts?.persistAcrossIncarnations === true && persisted.length > 0) as never,
      readHistoryWithOffset: (async () => {
        const data = persisted.join('');
        return { data, offset: Buffer.byteLength(data, 'utf-8'), startOffset: 0, epoch: 4242 };
      }) as never,
      readHistoryForRestore: (async () => {
        const data = persisted.join('');
        return { data, stoppedAt: 'true-start' as const, epoch: 4242 };
      }) as never,
      // Not exercised by this harness's fixtures (they always reconstruct
      // successfully) -- present only to satisfy the DI seam's type.
      appendRestoreFailureMarker: (async () => {
        throw new Error('appendRestoreFailureMarker unexpectedly called in idle-eviction test harness');
      }) as never,
    },
    getMcpBaseUrl: () => MCP_BASE_URL,
    loadProviderKeyFn: (async () => 'sk-test') as never,
    spawnAsUserFn: spawnFn,
    entryPath: ENTRY_PATH,
    getGlobalActivityCallback: () => undefined,
    getGlobalWorkerExitCallback: () => globalExit as never,
    shutdownGraceMs: opts?.shutdownGraceMs ?? 50,
    sigtermTimeoutMs: opts?.sigtermTimeoutMs ?? 50,
    idleEvictionMs: opts?.idleEvictionMs,
  });

  return {
    service,
    sessionId: session.id,
    workerId: worker.id,
    worker,
    session,
    spawn,
    bufferOutput,
    globalExit,
    onExit,
  };
}

const READY = '{"v":1,"type":"ready"}\n';
const IDLE = '{"v":1,"type":"state","state":"idle"}\n';
const ACTIVE = '{"v":1,"type":"state","state":"active"}\n';

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Activate and drive the incarnation to `ready`, which is what arms the countdown. */
async function activateAndReady(h: Harness): Promise<void> {
  await h.service.activate(h.sessionId, h.workerId);
  h.spawn.latest().pushStdout(READY);
  // The reader handles `ready` asynchronously; wait until it has been consumed.
  await sleep(20);
}

function appendedLines(bufferOutput: ReturnType<typeof mock>): string[] {
  return (bufferOutput.mock.calls as unknown as unknown[][]).map((c) =>
    (c[2] as string).replace(/\n$/, ''),
  );
}

function exitedRows(bufferOutput: ReturnType<typeof mock>): Array<Record<string, unknown>> {
  return appendedLines(bufferOutput)
    .filter((l) => l.includes('"type":"exited"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('idle eviction — the countdown and its commit point', () => {
  it('evicts an idle claude-sdk worker and records the exit as `evicted`', async () => {
    const h = setup({ idleEvictionMs: 15 });
    await activateAndReady(h);

    await waitFor(() => h.worker.subprocess === null, 2000);

    // The subprocess is gone but the worker is not: nothing deleted it, and
    // the runtime that tracked the dropped incarnation is cleaned up.
    expect(h.worker.subprocess).toBeNull();
    expect(h.service.getRestoreInfo(h.workerId)).toBeNull();
    expect(exitedRows(h.bufferOutput)).toEqual([
      expect.objectContaining({ type: 'exited', reason: 'evicted' }),
    ]);
  });

  it('evicts an idle openai-api worker and records the exit as `evicted`', async () => {
    const h = setup({ definition: OPENAI_DEFINITION, idleEvictionMs: 15 });
    await activateAndReady(h);

    await waitFor(() => h.worker.subprocess === null, 2000);

    expect(h.worker.subprocess).toBeNull();
    expect(h.service.getRestoreInfo(h.workerId)).toBeNull();
    expect(exitedRows(h.bufferOutput)).toEqual([
      expect.objectContaining({ type: 'exited', reason: 'evicted' }),
    ]);
  });

  it('never evicts mid-turn, and evicts once the turn completes', async () => {
    const h = setup({ idleEvictionMs: 60 });
    await activateAndReady(h);

    const sent = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello');
    expect(sent.ok).toBe(true);

    // The countdown elapses several times over while the turn is open.
    await sleep(220);
    expect(h.worker.subprocess).not.toBeNull();
    expect(exitedRows(h.bufferOutput)).toEqual([]);

    // The turn completes; only now may the worker be dropped.
    h.spawn.latest().pushStdout(IDLE);
    await waitFor(() => h.worker.subprocess === null, 2000);
    expect(exitedRows(h.bufferOutput)).toEqual([
      expect.objectContaining({ type: 'exited', reason: 'evicted' }),
    ]);
  });

  it('refuses to start a second eviction while one is already in flight', async () => {
    // The countdown can legitimately be re-armed while an eviction is tearing
    // the subprocess down -- the dying incarnation is still emitting events.
    // Without the `evicting` half of the commit-point re-check, that re-arm
    // starts a SECOND teardown of the same incarnation.
    const h = setup({
      idleEvictionMs: 25,
      exitOnShutdown: false,
      shutdownGraceMs: 600,
      sigtermTimeoutMs: 600,
    });
    await activateAndReady(h);

    const first = h.spawn.incarnations[0];
    const shutdowns = (): number =>
      first.stdinWrites.filter((w) => w.includes('"type":"shutdown"')).length;
    await waitFor(() => shutdowns() === 1, 2000);

    // The dying incarnation reports a state, which re-arms the countdown.
    first.pushStdout(ACTIVE);
    await sleep(150); // several thresholds' worth of re-arms

    expect(shutdowns()).toBe(1);

    // Let the held-open eviction finish so nothing outlives the test.
    first.simulateExit(0);
    await waitFor(() => h.worker.subprocess === null, 2000);
  });

  it('is the commit-point re-check, not the arm, that prevents a mid-turn kill', async () => {
    // The turn starts AFTER the countdown was armed, so the arm-side decision
    // was already made on a worker that looked idle. Only the re-check at fire
    // time can still get this right.
    const h = setup({ idleEvictionMs: 80 });
    await activateAndReady(h);

    await sleep(20); // countdown armed and running, nothing has touched it
    const sent = await h.service.sendUserMessage(h.sessionId, h.workerId, 'mid-flight');
    expect(sent.ok).toBe(true);
    h.spawn.latest().pushStdout(ACTIVE);

    // Long enough for the countdown to elapse (and be refused) twice over.
    await sleep(260);

    expect(h.worker.subprocess).not.toBeNull();
    expect(exitedRows(h.bufferOutput)).toEqual([]);
  });

  it('evicts a worker that never ran a turn, and wakes it into a fresh SDK session', async () => {
    // The boundary where idle eviction meets the resume machinery: a worker
    // that was activated, never spoke, and idled out. It has no persisted
    // `sdkSessionId` -- that id does not arrive until the first turn -- so the
    // wake has nothing to resume and must not pretend otherwise.
    //
    // `persistAcrossIncarnations` is what makes this test non-vacuous: without
    // it the wake would take the trivial first-ever-activation branch, where
    // `resume` is absent for a reason that has nothing to do with the null id.
    const h = setup({ idleEvictionMs: 15, persistAcrossIncarnations: true });
    await activateAndReady(h);
    expect(h.worker.sdkSessionId).toBeNull();

    // A null `sdkSessionId` must not exempt the worker from eviction. Nothing
    // in the eviction policy reads that field, and this is what proves it.
    await waitFor(() => h.worker.subprocess === null, 2000);
    expect(exitedRows(h.bufferOutput)).toEqual([
      expect.objectContaining({ type: 'exited', reason: 'evicted' }),
    ]);

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'first thing I ever said');
    expect(res.ok).toBe(true);

    const init = JSON.parse(h.spawn.latest().stdinWrites[0]) as Record<string, unknown>;
    expect(init.type).toBe('init');
    expect(init.engine).toBe('claude-sdk');
    // The wake did take the restore path rather than the first-ever-activation
    // branch -- this is what makes the absence below load-bearing.
    expect(Array.isArray(init.restoredConversation)).toBe(true);
    // Structural ABSENCE, not undefined and not null: `resume` is composed
    // conditionally from a persisted id, and the engine never invents one. An
    // explicitly-null `resume` on the wire would be a different, wrong thing.
    expect('resume' in init).toBe(false);
  });
});

describe('idle eviction — the delivery invariant', () => {
  it('sendUserMessage wakes an evicted worker and delivers the message', async () => {
    const h = setup({ idleEvictionMs: 15 });
    await activateAndReady(h);
    await waitFor(() => h.worker.subprocess === null, 2000);
    const spawnsBefore = h.spawn.incarnations.length;

    const result = await h.service.sendUserMessage(h.sessionId, h.workerId, 'are you there');

    expect(result.ok).toBe(true);
    expect(h.spawn.incarnations.length).toBe(spawnsBefore + 1);
    expect(h.worker.subprocess).not.toBeNull();
    // Delivered to the FRESH incarnation's stdin, not merely accepted.
    expect(h.spawn.latest().stdinWrites.some((w) => w.includes('are you there'))).toBe(true);
  });

  it('sendSystemNotification wakes an evicted worker and delivers the notification', async () => {
    const h = setup({ idleEvictionMs: 15 });
    await activateAndReady(h);
    await waitFor(() => h.worker.subprocess === null, 2000);
    const spawnsBefore = h.spawn.incarnations.length;

    const result = await h.service.sendSystemNotification(h.sessionId, h.workerId, {
      kind: 'internal-message',
      tag: 'internal:message',
      fields: {
        source: 'session',
        from: 'sender-session-id',
        summary: 'a system notification body',
        path: '/data/messages/m1.json',
      },
      intent: 'triage',
    });

    expect(result.ok).toBe(true);
    expect(h.spawn.incarnations.length).toBe(spawnsBefore + 1);
    expect(h.worker.subprocess).not.toBeNull();
    expect(
      h.spawn.latest().stdinWrites.some((w) => w.includes('a system notification body')),
    ).toBe(true);
  });

  it('fails loudly with the classified message when the wake fails', async () => {
    // A curated activation error is client-safe and forwarded verbatim.
    const h = setup({
      idleEvictionMs: 15,
      failSpawnFrom: 1,
      failSpawnWith: new EmbeddedAgentActivationError('curated activation failure'),
    });
    await activateAndReady(h);
    await waitFor(() => h.worker.subprocess === null, 2000);

    const result = await h.service.sendUserMessage(h.sessionId, h.workerId, 'wake up');

    expect(result).toEqual({
      ok: false,
      code: 'NOT_ACTIVATED',
      error: 'curated activation failure',
    });
  });

  it('replaces an unclassified wake failure with the generic message', async () => {
    const h = setup({
      idleEvictionMs: 15,
      failSpawnFrom: 1,
      failSpawnWith: new Error('spawn EACCES /usr/local/bin/bun'),
    });
    await activateAndReady(h);
    await waitFor(() => h.worker.subprocess === null, 2000);

    const result = await h.service.sendUserMessage(h.sessionId, h.workerId, 'wake up');

    expect(result.ok).toBe(false);
    expect(result).toEqual({
      ok: false,
      code: 'NOT_ACTIVATED',
      error: GENERIC_EMBEDDED_ACTIVATION_FAILURE_MESSAGE,
    });
  });

  it('waits out an in-flight eviction instead of writing into the dying subprocess', async () => {
    // The eviction is held open: the fake child ignores `shutdown` and only
    // dies on the SIGTERM that follows the grace window.
    const h = setup({
      idleEvictionMs: 15,
      exitOnShutdown: false,
      shutdownGraceMs: 120,
      sigtermTimeoutMs: 50,
    });
    await activateAndReady(h);

    const first = h.spawn.incarnations[0];
    // `evicting` is set in the same synchronous section that writes `shutdown`,
    // so observing the write means the eviction has committed.
    await waitFor(() => first.stdinWrites.some((w) => w.includes('"type":"shutdown"')), 2000);
    expect(h.worker.subprocess).not.toBeNull(); // still dying, not yet gone

    const result = await h.service.sendUserMessage(h.sessionId, h.workerId, 'raced message');

    expect(result.ok).toBe(true);
    // The dying incarnation never saw it; the fresh one did.
    expect(first.stdinWrites.some((w) => w.includes('raced message'))).toBe(false);
    expect(h.spawn.incarnations.length).toBe(2);
    expect(h.spawn.latest().stdinWrites.some((w) => w.includes('raced message'))).toBe(true);
  });

  it('admits exactly one of two concurrent messages, from exactly one activation', async () => {
    const h = setup({ idleEvictionMs: 15 });
    await activateAndReady(h);
    await waitFor(() => h.worker.subprocess === null, 2000);
    const spawnsBefore = h.spawn.incarnations.length;

    const [a, b] = await Promise.all([
      h.service.sendUserMessage(h.sessionId, h.workerId, 'first'),
      h.service.sendUserMessage(h.sessionId, h.workerId, 'second'),
    ]);

    // One admitted turn: the synchronous re-check after the await serialises.
    const results = [a, b];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.code === 'TURN_IN_PROGRESS').length).toBe(1);
    // One activation: the loser rode `activate`'s in-flight map, not a second spawn.
    expect(h.spawn.incarnations.length).toBe(spawnsBefore + 1);
  });

  it(
    'delivers an initial prompt under a millisecond-scale threshold without deadlocking',
    async () => {
      // The initial prompt is delivered from INSIDE the stdout reader, and the
      // delivery choke point awaits any in-flight eviction -- which in turn
      // awaits that same reader. Arming the countdown only after `ready` is
      // what makes that window unreachable, including when the engine reports
      // a state before it reports readiness.
      const h = setup({
        idleEvictionMs: 5,
        shutdownGraceMs: 3000,
        sigtermTimeoutMs: 3000,
        initialPrompt: 'the initial prompt',
        deliverInitialPromptOnActivation: true,
      });
      await h.service.activate(h.sessionId, h.workerId);

      const first = h.spawn.incarnations[0];
      first.pushStdout(IDLE);
      await sleep(40); // an unguarded arm would have fired an eviction by now
      first.pushStdout(READY);

      await waitFor(() => first.stdinWrites.some((w) => w.includes('the initial prompt')), 1500);
      expect(first.stdinWrites.some((w) => w.includes('the initial prompt'))).toBe(true);
    },
    5000,
  );
});

describe('idle eviction — exit reason reported to the global exit callback', () => {
  it('reports `evicted` for an idle eviction', async () => {
    const h = setup({ idleEvictionMs: 15 });
    await activateAndReady(h);

    await waitFor(() => h.globalExit.mock.calls.length > 0, 2000);

    expect(h.globalExit).toHaveBeenCalledWith(h.sessionId, h.workerId, 0, 'evicted');
    expect(h.onExit).toHaveBeenCalledWith(0, null, 'evicted');
  });

  it('reports `managed` for an explicit deactivate', async () => {
    const h = setup();
    await activateAndReady(h);

    await h.service.deactivate(h.sessionId, h.workerId);

    expect(h.globalExit).toHaveBeenCalledWith(h.sessionId, h.workerId, 0, 'managed');
    expect(exitedRows(h.bufferOutput)).toEqual([
      expect.objectContaining({ type: 'exited', reason: 'managed' }),
    ]);
  });

  it('reports `unexpected` for a subprocess that dies on its own', async () => {
    const h = setup();
    await activateAndReady(h);

    h.spawn.incarnations[0].simulateExit(1);
    await waitFor(() => h.worker.subprocess === null, 2000);

    expect(h.globalExit).toHaveBeenCalledWith(h.sessionId, h.workerId, 1, 'unexpected');
    expect(exitedRows(h.bufferOutput)).toEqual([
      expect.objectContaining({ type: 'exited', reason: 'unexpected' }),
    ]);
  });
});

