import { describe, it, expect, mock } from 'bun:test';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../privilege-elevation.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import {
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';
import {
  EmbeddedAgentWorkerService,
  EmbeddedAgentActivationError,
  resolveEmbeddedAgentEntryPath,
} from '../embedded-agent-worker-service.js';

const MCP_BASE_URL = 'http://localhost:3457/mcp';
const ENTRY_PATH = '/install/embedded-agent/src/main.ts';
const TOKEN = 'mcp-token-abcdef';
const API_KEY = 'sk-provider-secret';
const NEW_EPOCH = 4242;
const USERNAME = 'alice';

function buildDefinition(overrides?: Partial<EmbeddedAgentDefinition>): EmbeddedAgentDefinition {
  return {
    id: 'def-1',
    name: 'Ollama qwen',
    provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b', apiKeyRef: 'openai' },
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Subset of Bun's FileSink consumed by the service (write + flush). */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

interface FakeSubprocess {
  pid: number;
  exited: Promise<number>;
  stdin: FakeFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: (signal?: number) => void;
}

interface ControllableStream {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
  close: () => void;
}

function makeControllableStream(): ControllableStream {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  let closed = false;
  return {
    stream,
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    close: () => {
      if (!closed) {
        closed = true;
        ctrl.close();
      }
    },
  };
}

interface FakeSpawn {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
  flushCount: () => number;
  killSignals: number[];
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
  /** Resolve `exited` AND close both streams so the exit observer can complete. */
  simulateExit: (code: number) => void;
  /** Optional hook fired on kill(signal); tests use it to escalate to exit. */
  setOnKill: (fn: (signal: number) => void) => void;
  /** Hook fired at the moment stdin.write is called (for call-time ordering). */
  setOnStdinWrite: (fn: (chunk: string) => void) => void;
}

function makeFakeSpawn(): FakeSpawn {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const killSignals: number[] = [];
  let flushes = 0;
  let onKill: ((signal: number) => void) | undefined;
  // Fired at the exact moment stdin.write is called (Finding 3: lets the
  // append-before-forward test record ordering at call-time, not after await).
  let onStdinWrite: ((chunk: string) => void) | undefined;

  const stdout = makeControllableStream();
  const stderr = makeControllableStream();

  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const stdin: FakeFileSink = {
    write: (chunk) => {
      const s = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      stdinWrites.push(s);
      onStdinWrite?.(s);
      return 0;
    },
    end: () => {},
    flush: () => {
      flushes += 1;
      return 0;
    },
  };

  const subprocess: FakeSubprocess = {
    pid: 4321,
    exited,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    kill: (signal) => {
      killSignals.push(signal ?? 15);
      onKill?.(signal ?? 15);
    },
  };

  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    const result: Pick<SpawnAsUserResult, 'elevated'> & {
      subprocess: FakeSubprocess;
      stdin: FakeFileSink;
    } = { subprocess, stdin, elevated: false };
    return result as SpawnAsUserResult;
  };

  return {
    fn,
    captured,
    stdinWrites,
    flushCount: () => flushes,
    killSignals,
    pushStdout: stdout.push,
    pushStderr: stderr.push,
    simulateExit: (code: number) => {
      resolveExited(code);
      stdout.close();
      stderr.close();
    },
    setOnKill: (f) => {
      onKill = f;
    },
    setOnStdinWrite: (f: (chunk: string) => void) => {
      onStdinWrite = f;
    },
  };
}

interface Recorder {
  onData: ReturnType<typeof mock>;
  onExit: ReturnType<typeof mock>;
  onActivityChange: ReturnType<typeof mock>;
  onRestoreInfo: ReturnType<typeof mock>;
}

interface Harness {
  service: EmbeddedAgentWorkerService;
  sessionId: string;
  workerId: string;
  worker: ReturnType<typeof buildInternalEmbeddedAgentWorker>;
  session: ReturnType<typeof buildInternalWorktreeSession>;
  fake: FakeSpawn;
  mint: ReturnType<typeof mock>;
  revokeByWorker: ReturnType<typeof mock>;
  resetWorkerOutput: ReturnType<typeof mock>;
  bufferOutput: ReturnType<typeof mock>;
  hasEverBeenActivated: ReturnType<typeof mock>;
  readHistoryWithOffset: ReturnType<typeof mock>;
  loadProviderKeyFn: ReturnType<typeof mock>;
  persistSession: ReturnType<typeof mock>;
  globalActivity: ReturnType<typeof mock>;
  globalExit: ReturnType<typeof mock>;
  recorder: Recorder;
}

function setup(opts?: {
  definition?: EmbeddedAgentDefinition | undefined;
  createdBy?: string | undefined;
  loadProviderKeyFn?: ReturnType<typeof mock>;
  spawnAsUserFnOverride?: SpawnAsUserFn;
  shutdownGraceMs?: number;
  sigtermTimeoutMs?: number;
  /** Omit the entryPath override so the service resolves its real default. */
  omitEntryPath?: boolean;
  /** Issue #1221: test seam override for the configured bun binary path. */
  embeddedAgentBunPathOverride?: string;
  /** Issue #1068: session.initialPrompt, undefined by default (no delivery). */
  initialPrompt?: string;
  /** Issue #1068: session.initialPromptDelivered, undefined by default. */
  initialPromptDelivered?: boolean;
  /** Issue #1068: worker.deliverInitialPromptOnActivation, false by default. */
  deliverInitialPromptOnActivation?: boolean;
  /**
   * Transcript Restore (#1123): whether the worker has ever been activated
   * BEFORE this activation. Defaults to false, i.e. every EXISTING test
   * (written before restore existed) takes the "first-ever activation"
   * branch and continues to exercise the byte-identical v1 reset path.
   */
  everActivated?: boolean;
  /** Transcript Restore (#1123): the persisted stream `readHistoryWithOffset` returns when everActivated is true. */
  readHistoryWithOffsetResult?: { data: string; offset?: number; epoch?: number };
  /** CodeRabbit re-review Finding 1: stale pre-activation in-memory epoch/outputOffset to seed the worker with, so a restore-success test can assert they get replaced. */
  staleEpoch?: number;
  staleOutputOffset?: number;
  /** Transcript Restore (#1123): readHistoryWithOffset rejects instead of resolving (simulates a persistent I/O error on an existing worker). */
  readHistoryWithOffsetThrows?: boolean;
}): Harness {
  const definition = 'definition' in (opts ?? {}) ? opts!.definition : buildDefinition();
  const createdBy = opts && 'createdBy' in opts ? opts.createdBy : 'user-1';

  const worker = buildInternalEmbeddedAgentWorker({
    id: 'w-emb',
    embeddedAgentId: 'def-1',
    deliverInitialPromptOnActivation: opts?.deliverInitialPromptOnActivation ?? false,
  });
  if (opts?.staleEpoch !== undefined) worker.epoch = opts.staleEpoch;
  if (opts?.staleOutputOffset !== undefined) worker.outputOffset = opts.staleOutputOffset;
  const session = buildInternalWorktreeSession([worker], {
    createdBy,
    initialPrompt: opts?.initialPrompt,
    initialPromptDelivered: opts?.initialPromptDelivered,
  });
  const fake = makeFakeSpawn();

  const mint = mock(() => TOKEN);
  const revokeByWorker = mock(() => {});
  const resetWorkerOutput = mock(async () => NEW_EPOCH);
  const bufferOutput = mock(() => {});
  const hasEverBeenActivated = mock(async () => opts?.everActivated ?? false);
  const readHistoryWithOffset = mock(async () => {
    if (opts?.readHistoryWithOffsetThrows) {
      throw new Error('persisted stream read boom');
    }
    return {
      data: opts?.readHistoryWithOffsetResult?.data ?? '',
      offset: opts?.readHistoryWithOffsetResult?.offset ?? 0,
      startOffset: 0,
      epoch: opts?.readHistoryWithOffsetResult?.epoch ?? 0,
    };
  });
  const loadProviderKeyFn =
    opts?.loadProviderKeyFn ?? mock(async () => API_KEY);
  const persistSession = mock(async () => {});
  const globalActivity = mock(() => {});
  const globalExit = mock(() => {});

  const recorder: Recorder = {
    onData: mock(() => {}),
    onExit: mock(() => {}),
    onActivityChange: mock(() => {}),
    onRestoreInfo: mock(() => {}),
  };
  worker.connectionCallbacks.set('conn-1', {
    onData: recorder.onData as unknown as (data: string, offset: number, epoch: number) => void,
    onExit: recorder.onExit as unknown as (code: number, sig: string | null, reason?: 'managed' | 'unexpected') => void,
    onActivityChange: recorder.onActivityChange as unknown as (state: 'active' | 'idle' | 'asking' | 'unknown') => void,
    onRestoreInfo: recorder.onRestoreInfo as unknown as (info: { messageCount: number; repairedToolCallIds: string[]; completed: boolean }) => void,
  });

  const service = new EmbeddedAgentWorkerService({
    getSession: (id) => (id === session.id ? session : undefined),
    persistSession: persistSession as never,
    getPathResolver: () => new SessionDataPathResolver('/test/config/repositories/test-repo'),
    getEmbeddedAgent: () => definition,
    resolveSpawnUsername: async () => USERNAME,
    mcpTokenRegistry: { mint: mint as never, revokeByWorker: revokeByWorker as never },
    workerOutputFileManager: {
      resetWorkerOutput: resetWorkerOutput as never,
      bufferOutput: bufferOutput as never,
      hasEverBeenActivated: hasEverBeenActivated as never,
      readHistoryWithOffset: readHistoryWithOffset as never,
    },
    getMcpBaseUrl: () => MCP_BASE_URL,
    loadProviderKeyFn: loadProviderKeyFn as never,
    spawnAsUserFn: opts?.spawnAsUserFnOverride ?? fake.fn,
    ...(opts?.omitEntryPath ? {} : { entryPath: ENTRY_PATH }),
    embeddedAgentBunPath: opts?.embeddedAgentBunPathOverride,
    getGlobalActivityCallback: () => globalActivity as never,
    getGlobalWorkerExitCallback: () => globalExit as never,
    shutdownGraceMs: opts?.shutdownGraceMs,
    sigtermTimeoutMs: opts?.sigtermTimeoutMs,
  });

  return {
    service,
    sessionId: session.id,
    workerId: worker.id,
    worker,
    session,
    fake,
    mint,
    revokeByWorker,
    resetWorkerOutput,
    bufferOutput,
    hasEverBeenActivated,
    readHistoryWithOffset,
    loadProviderKeyFn,
    persistSession,
    globalActivity,
    globalExit,
    recorder,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Extract appended NDJSON lines (drop trailing newline) from bufferOutput calls. */
function appendedLines(bufferOutput: ReturnType<typeof mock>): string[] {
  return (bufferOutput.mock.calls as unknown as unknown[][]).map((c) => (c[2] as string).replace(/\n$/, ''));
}

describe('EmbeddedAgentWorkerService.activate', () => {
  it('spawns once with a secret-free argv, no env, correct cwd and username', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.fake.captured.length).toBe(1);
    const opts = h.fake.captured[0];
    expect(opts.command).toBe(`'bun' '${ENTRY_PATH}'`);
    // Negative assertions: no secrets in the command line.
    expect(opts.command).not.toContain(TOKEN);
    expect(opts.command).not.toContain(API_KEY);
    // No env channel at all (secrets travel only over stdin).
    expect('env' in opts).toBe(false);
    expect(opts.env).toBeUndefined();
    expect(opts.cwd).toBe('/test/worktree');
    expect(opts.username).toBe(USERNAME);
  });

  it('pins a configured EMBEDDED_AGENT_BUN_PATH override into the elevated argv verbatim (Issue #1221)', async () => {
    const h = setup({ embeddedAgentBunPathOverride: '/usr/local/bin/bun' });
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.fake.captured.length).toBe(1);
    const opts = h.fake.captured[0];
    expect(opts.command).toBe(`'/usr/local/bin/bun' '${ENTRY_PATH}'`);
  });

  it('writes a valid init command as the first stdin line carrying secrets + context', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.fake.stdinWrites.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.v).toBe(1);
    expect(first.type).toBe('init');
    expect(first.mcp).toEqual({ baseUrl: MCP_BASE_URL, token: TOKEN });
    expect(first.provider).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:32b',
      apiKey: API_KEY,
    });
    expect(first.context).toEqual({
      sessionId: h.sessionId,
      workerId: h.workerId,
      repositoryId: 'repo-1',
      cwd: '/test/worktree',
    });
    expect(first.maxToolIterations).toBe(25);
  });

  it('uses the definition maxToolIterations when set', async () => {
    const h = setup({ definition: buildDefinition({ maxToolIterations: 7 }) });
    await h.service.activate(h.sessionId, h.workerId);
    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.maxToolIterations).toBe(7);
  });

  it('includes enabledTools in the init command when the definition sets it', async () => {
    const h = setup({ definition: buildDefinition({ enabledTools: ['Read'] }) });
    await h.service.activate(h.sessionId, h.workerId);
    const first = h.fake.stdinWrites[0];
    expect(first).toContain('"enabledTools":["Read"]');
    expect(JSON.parse(first).enabledTools).toEqual(['Read']);
  });

  it('omits enabledTools entirely from the init command when the definition has no enabledTools', async () => {
    const h = setup({ definition: buildDefinition() });
    await h.service.activate(h.sessionId, h.workerId);
    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('enabledTools' in first).toBe(false);
  });

  it('includes instructions in the init command when the definition sets it', async () => {
    const h = setup({ definition: buildDefinition({ instructions: ['docs/local-note.md'] }) });
    await h.service.activate(h.sessionId, h.workerId);
    const first = h.fake.stdinWrites[0];
    expect(first).toContain('"instructions":["docs/local-note.md"]');
    expect(JSON.parse(first).instructions).toEqual(['docs/local-note.md']);
  });

  it('omits instructions entirely from the init command when the definition has no instructions', async () => {
    const h = setup({ definition: buildDefinition() });
    await h.service.activate(h.sessionId, h.workerId);
    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('instructions' in first).toBe(false);
  });

  it('rejects a dangling definition without spawning or minting', async () => {
    const h = setup({ definition: undefined });
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('not found');
    expect(h.fake.captured.length).toBe(0);
    expect(h.mint).not.toHaveBeenCalled();
    // Enumerable, developer-authored reason -- must be allowlisted so
    // routes.ts forwards the message verbatim to the client.
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toBeInstanceOf(
      EmbeddedAgentActivationError,
    );
  });

  it('rejects activation for a session id with no matching session', async () => {
    const h = setup();
    await expect(h.service.activate('no-such-session', h.workerId)).rejects.toThrow('not found');
    await expect(h.service.activate('no-such-session', h.workerId)).rejects.toBeInstanceOf(
      EmbeddedAgentActivationError,
    );
    expect(h.fake.captured.length).toBe(0);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('rejects activation for a worker id that is not an embedded-agent worker', async () => {
    const h = setup();
    await expect(h.service.activate(h.sessionId, 'no-such-worker')).rejects.toThrow(
      'not an embedded-agent worker',
    );
    await expect(h.service.activate(h.sessionId, 'no-such-worker')).rejects.toBeInstanceOf(
      EmbeddedAgentActivationError,
    );
    expect(h.fake.captured.length).toBe(0);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('rejects a dangling apiKeyRef without spawning', async () => {
    const throwingLoader = mock(async () => {
      throw new Error("Provider key ref 'missing' is not present");
    });
    const h = setup({
      definition: buildDefinition({ provider: { baseUrl: 'http://x/v1', model: 'm', apiKeyRef: 'missing' } }),
      loadProviderKeyFn: throwingLoader,
    });
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('not present');
    expect(h.fake.captured.length).toBe(0);
    // Downstream/unbounded reason -- must NOT be allowlisted, so routes.ts
    // replaces it with the generic client-facing fallback.
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.not.toBeInstanceOf(
      EmbeddedAgentActivationError,
    );
  });

  it('rejects a session without createdBy without minting or spawning', async () => {
    const h = setup({ createdBy: undefined });
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('createdBy');
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.fake.captured.length).toBe(0);
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toBeInstanceOf(
      EmbeddedAgentActivationError,
    );
  });

  it('resets output epoch and offset (restart semantics)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.resetWorkerOutput).toHaveBeenCalled();
    expect(h.worker.epoch).toBe(NEW_EPOCH);
    expect(h.worker.outputOffset).toBe(0);
  });

  it('is an idempotent no-op when already activated', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const spawnsAfterFirst = h.fake.captured.length;
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.fake.captured.length).toBe(spawnsAfterFirst);
  });

  it('revokes the minted token and clears the handle when a post-mint step throws', async () => {
    const throwingSpawn: SpawnAsUserFn = () => {
      throw new Error('spawn boom');
    };
    const h = setup({ spawnAsUserFnOverride: throwingSpawn });

    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('spawn boom');
    // The token was minted (step 3) but the spawn failed (step 5), so the
    // catch must revoke it rather than leak it in the registry.
    expect(h.mint).toHaveBeenCalled();
    expect(h.revokeByWorker).toHaveBeenCalledWith(h.workerId);
    expect(h.worker.subprocess).toBeNull();
    expect(h.worker.stdin).toBeNull();
    // Polarity guard: a downstream/unbounded failure (process spawn here)
    // must propagate as whatever it originally was, NOT get wrapped in
    // EmbeddedAgentActivationError -- that would widen the client-safe
    // allowlist to a step whose error content is not enumerable.
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.not.toBeInstanceOf(
      EmbeddedAgentActivationError,
    );
  });

  it('does NOT revoke the token on a successful activation', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.revokeByWorker).not.toHaveBeenCalled();
  });

  it('serializes two concurrent activate() calls into a single spawn', async () => {
    const h = setup();
    // Two concurrent callers (e.g. two WS clients hitting onOpen) — no await
    // between the calls, mirroring simultaneous entry.
    const p1 = h.service.activate(h.sessionId, h.workerId);
    const p2 = h.service.activate(h.sessionId, h.workerId);

    // The second caller must receive the SAME in-flight promise, not a second
    // independent activation.
    expect(p2).toBe(p1);

    await Promise.all([p1, p2]);

    // Exactly one spawn and one mint — not two orphaned subprocesses/tokens.
    expect(h.fake.captured.length).toBe(1);
    expect(h.mint).toHaveBeenCalledTimes(1);
  });

  it('resolves the default entry path to an existing packages/embedded-agent/src/main.ts', async () => {
    // Exercises the REAL default resolution (no entryPath override). The bug was
    // a resolution-mechanism defect, so this asserts the resolved path exists on
    // disk via the native Bun.file check (memfs-immune) rather than trusting types.
    const h = setup({ omitEntryPath: true });
    await h.service.activate(h.sessionId, h.workerId);

    const command = h.fake.captured[0].command;
    const match = /^'bun' '(.+)'$/.exec(command);
    expect(match).not.toBeNull();
    const resolvedEntry = match![1];
    expect(resolvedEntry.endsWith('packages/embedded-agent/src/main.ts')).toBe(true);
    expect(await Bun.file(resolvedEntry).exists()).toBe(true);
  });
});

describe('EmbeddedAgentWorkerService — Transcript Restore (#1123)', () => {
  const VALID_RESTORABLE_STREAM = [
    JSON.stringify({ v: 1, type: 'user-message', id: 'm1', text: 'hi there' }),
    JSON.stringify({ v: 1, type: 'assistant-message', turnId: 't1', text: 'hello back' }),
  ].join('\n');

  it('does NOT reset the output stream and forwards a matching restoredConversation when restore succeeds', async () => {
    const epochBefore = 1_700_000_000_000;
    const offsetBefore = 999;
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM, offset: offsetBefore, epoch: epochBefore },
      staleEpoch: epochBefore,
      staleOutputOffset: offsetBefore,
    });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.resetWorkerOutput).not.toHaveBeenCalled();
    // The manifest's current coordinates already agree with the pre-activation
    // in-memory worker here (the common case: no server restart occurred), so
    // the post-restore sync (Finding 1) leaves epoch/outputOffset unchanged --
    // this test still proves "no reset" without conflating it with the sync
    // behavior, which the next test isolates.
    expect(h.worker.epoch).toBe(epochBefore);
    expect(h.worker.outputOffset).toBe(offsetBefore);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(Array.isArray(first.restoredConversation)).toBe(true);
    expect(first.restoredConversation[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(first.restoredConversation).toContainEqual({ role: 'user', content: 'hi there' });
    expect(first.restoredConversation).toContainEqual({ role: 'assistant', content: 'hello back' });
  });

  it('syncs worker.epoch/outputOffset to the manifest current coordinates on restore success, replacing stale in-memory values (CodeRabbit re-review Finding 1)', async () => {
    // Simulates a freshly-reconstructed in-memory worker (e.g. after a server
    // restart -- WorkerManager.initializeEmbeddedAgentWorker is a pure
    // in-memory factory with no filesystem I/O, so it cannot know the real
    // on-disk manifest's current epoch/offset) that is STALE relative to the
    // manifest's actual current generation.
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM, offset: 12345, epoch: 5 },
      staleEpoch: 1,
      staleOutputOffset: 0,
    });
    expect(h.worker.epoch).toBe(1);
    expect(h.worker.outputOffset).toBe(0);

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.resetWorkerOutput).not.toHaveBeenCalled();
    // The stale pre-activation values must be REPLACED by the manifest's
    // actual current coordinates, not left stale.
    expect(h.worker.epoch).toBe(5);
    expect(h.worker.outputOffset).toBe(12345);
  });

  it('resets the output stream with preserveToSidecar and omits restoredConversation when restore fails', async () => {
    const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: '{not valid json' } });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.resetWorkerOutput).toHaveBeenCalledWith(
      h.sessionId,
      h.workerId,
      expect.anything(),
      { preserveToSidecar: true },
    );
    expect(h.worker.epoch).toBe(NEW_EPOCH);
    expect(h.worker.outputOffset).toBe(0);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('restoredConversation' in first).toBe(false);
  });

  it('performs the byte-identical v1 reset (no restore attempt) on a first-ever activation (hasEverBeenActivated=false)', async () => {
    const h = setup({ everActivated: false });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.readHistoryWithOffset).not.toHaveBeenCalled();
    expect(h.resetWorkerOutput).toHaveBeenCalledWith(h.sessionId, h.workerId, expect.anything());
    expect(h.resetWorkerOutput.mock.calls[0]!.length).toBe(3); // no opts argument at all
    expect(h.worker.epoch).toBe(NEW_EPOCH);
    expect(h.worker.outputOffset).toBe(0);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('restoredConversation' in first).toBe(false);
  });

  it('routes a persistent I/O error on an EXISTING worker through the failure-with-sidecar path, NOT the destructive first-activation shortcut (CodeRabbit CRITICAL)', async () => {
    // hasEverBeenActivated's real implementation is conservative on a
    // non-ENOENT stat failure: it reports `true` (assume activated) rather
    // than throwing, so this DI mock returns `true` too -- exercising the
    // caller-side contract that the injected hasEverBeenActivated never
    // throws. The restore attempt then hits the SAME underlying persistent
    // I/O failure via readHistoryWithOffset and correctly falls into the
    // sidecar-preserving reset branch instead of the destructive
    // "nothing to restore" shortcut.
    const h = setup({ everActivated: true, readHistoryWithOffsetThrows: true });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.resetWorkerOutput).toHaveBeenCalledWith(
      h.sessionId,
      h.workerId,
      expect.anything(),
      { preserveToSidecar: true },
    );
    expect(h.worker.epoch).toBe(NEW_EPOCH);
    expect(h.worker.outputOffset).toBe(0);
  });

  describe('getRestoreInfo', () => {
    it('returns the current epoch + restore result after a successful restore', async () => {
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM } });
      await h.service.activate(h.sessionId, h.workerId);

      const info = h.service.getRestoreInfo(h.workerId);
      expect(info).not.toBeNull();
      expect(info!.epoch).toBe(h.worker.epoch);
      expect(info!.messageCount).toBe(3); // system + user + assistant
      expect(info!.repairedToolCallIds).toEqual([]);
      expect(info!.completed).toBe(false);
    });

    it('returns null after a restore failure', async () => {
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: '{not valid json' } });
      await h.service.activate(h.sessionId, h.workerId);

      expect(h.service.getRestoreInfo(h.workerId)).toBeNull();
    });

    it('returns null after a first-ever activation (nothing to restore)', async () => {
      const h = setup({ everActivated: false });
      await h.service.activate(h.sessionId, h.workerId);

      expect(h.service.getRestoreInfo(h.workerId)).toBeNull();
    });

    it('returns null for a worker that was never activated', () => {
      const h = setup();
      expect(h.service.getRestoreInfo(h.workerId)).toBeNull();
    });
  });

  describe('fast-path push (onRestoreInfo)', () => {
    it('invokes onRestoreInfo on already-attached connections when restore succeeds, with completed: false (Issue #1205)', async () => {
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM } });

      await h.service.activate(h.sessionId, h.workerId);

      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(1);
      expect(h.recorder.onRestoreInfo).toHaveBeenCalledWith({
        messageCount: 3,
        repairedToolCallIds: [],
        completed: false,
      });
    });

    it('does NOT invoke onRestoreInfo when restore fails', async () => {
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: '{not valid json' } });

      await h.service.activate(h.sessionId, h.workerId);

      expect(h.recorder.onRestoreInfo).not.toHaveBeenCalled();
    });

    it('does NOT invoke onRestoreInfo on a first-ever activation', async () => {
      const h = setup({ everActivated: false });

      await h.service.activate(h.sessionId, h.workerId);

      expect(h.recorder.onRestoreInfo).not.toHaveBeenCalled();
    });
  });

  describe('restore completion on ready (Issue #1205)', () => {
    it('flips getRestoreInfo().completed to true and re-pushes onRestoreInfo exactly once when the loop reports ready', async () => {
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM } });
      await h.service.activate(h.sessionId, h.workerId);

      // (a) immediately after a successful restore, completed is false.
      expect(h.service.getRestoreInfo(h.workerId)?.completed).toBe(false);
      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(1);

      // (b) once the loop's `ready` event is processed, completed flips true
      // and the connection is poked again.
      h.fake.pushStdout('{"v":1,"type":"ready"}\n');
      await waitFor(() => h.service.getRestoreInfo(h.workerId)?.completed === true);

      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(2);
      expect(h.recorder.onRestoreInfo).toHaveBeenNthCalledWith(2, {
        messageCount: 3,
        repairedToolCallIds: [],
        completed: true,
      });

      // (c) a duplicate `ready` is a safe no-op -- no further push.
      h.fake.pushStdout('{"v":1,"type":"ready"}\n');
      await waitFor(() => appendedLines(h.bufferOutput).filter((l) => l === '{"v":1,"type":"ready"}').length === 2);

      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(2);
    });

    it('does NOT invoke onRestoreInfo on ready when there was nothing to restore (first-ever activation)', async () => {
      const h = setup({ everActivated: false });
      await h.service.activate(h.sessionId, h.workerId);

      h.fake.pushStdout('{"v":1,"type":"ready"}\n');
      await waitFor(() => appendedLines(h.bufferOutput).includes('{"v":1,"type":"ready"}'));

      expect(h.recorder.onRestoreInfo).not.toHaveBeenCalled();
      expect(h.service.getRestoreInfo(h.workerId)).toBeNull();
    });
  });
});

describe('resolveEmbeddedAgentEntryPath', () => {
  it('resolves via the package-resolution branch on this dev checkout and returns an existing path', async () => {
    // This dev checkout has `bun install` wiring @agent-console/embedded-agent
    // into the server package, so the package-resolution branch (not the
    // source-tree fallback) is what should execute here -- the same
    // deployment-correct branch a real install exercises. The real-machine
    // smoke test (scripts/smoke/check-embedded-agent-elevation.ts) asserts the
    // same `.source === 'package'` invariant against a real deploy layout.
    const result = resolveEmbeddedAgentEntryPath();
    expect(result.source).toBe('package');
    expect(result.path.endsWith('packages/embedded-agent/src/main.ts')).toBe(true);
    expect(await Bun.file(result.path).exists()).toBe(true);
  });
});

describe('EmbeddedAgentWorkerService stdout stream', () => {
  it('reassembles a line split across two chunks into exactly one append + fan-out', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();
    h.recorder.onData.mockClear();

    const line = '{"v":1,"type":"ready"}';
    h.fake.pushStdout('{"v":1,"type":');
    h.fake.pushStdout('"ready"}\n');

    await waitFor(() => h.bufferOutput.mock.calls.length === 1);

    const data = `${line}\n`;
    const expectedOffset = Buffer.byteLength(data, 'utf-8');
    expect(h.bufferOutput.mock.calls[0][2]).toBe(data);
    expect(h.recorder.onData).toHaveBeenCalledTimes(1);
    expect(h.recorder.onData).toHaveBeenCalledWith(data, expectedOffset, NEW_EPOCH);
    expect(h.worker.outputOffset).toBe(expectedOffset);
  });

  it('routes state events into activity broadcasts', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.globalActivity.mockClear();
    h.recorder.onActivityChange.mockClear();

    h.fake.pushStdout('{"v":1,"type":"state","state":"active"}\n');
    await waitFor(() => h.worker.activityState === 'active');

    expect(h.recorder.onActivityChange).toHaveBeenCalledWith('active');
    expect(h.globalActivity).toHaveBeenCalledWith(h.sessionId, h.workerId, 'active');
  });

  it('kills the subprocess after 5 consecutive malformed lines, and a valid line resets the counter', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    // 4 malformed then 1 valid resets → no kill.
    for (let i = 0; i < 4; i++) h.fake.pushStdout('garbage\n');
    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    for (let i = 0; i < 4; i++) h.fake.pushStdout('garbage\n');
    await waitFor(() => appendedLines(h.bufferOutput).includes('{"v":1,"type":"ready"}'));
    expect(h.fake.killSignals).toEqual([]);

    // Now 5 consecutive malformed → kill.
    for (let i = 0; i < 5; i++) h.fake.pushStdout('garbage\n');
    await waitFor(() => h.fake.killSignals.length > 0);
    expect(h.fake.killSignals).toContain(9);
  });

  it('appends and forwards a recognized assistant-thinking-delta event like assistant-delta', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    const line = '{"v":1,"type":"assistant-thinking-delta","turnId":"t1","text":"hmm"}';
    h.fake.pushStdout(`${line}\n`);
    await waitFor(() => appendedLines(h.bufferOutput).includes(line));

    expect(h.fake.killSignals).toEqual([]);
    expect(appendedLines(h.bufferOutput)).toContain(line);
  });

  it('skips a parseable event with an unrecognized type WITHOUT incrementing the strike counter', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    // 5 forward-compat (unrecognized-type) lines in a row must NOT kill.
    for (let i = 0; i < 5; i++) {
      h.fake.pushStdout('{"v":1,"type":"future-event","foo":"bar"}\n');
    }
    // A recognized event after them still processes (proves the reader is live
    // and the unrecognized lines did not corrupt the stream / trip the counter).
    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    await waitFor(() => appendedLines(h.bufferOutput).includes('{"v":1,"type":"ready"}'));

    expect(h.fake.killSignals).toEqual([]);
    // The unrecognized lines are skipped (not appended to the transcript).
    expect(appendedLines(h.bufferOutput)).not.toContain('{"v":1,"type":"future-event","foo":"bar"}');
  });

  it('counts a KNOWN type that fails its schema shape toward the strike counter', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    // `tool-call` is a recognized type but this line is missing its required
    // fields (turnId/callId/name/args) → genuine corruption → 5 in a row kills.
    for (let i = 0; i < 5; i++) h.fake.pushStdout('{"v":1,"type":"tool-call"}\n');
    await waitFor(() => h.fake.killSignals.length > 0);
    expect(h.fake.killSignals).toContain(9);
  });

  it('kills the subprocess on an oversized single line (> 1 MiB)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.pushStdout('x'.repeat(1024 * 1024 + 10));
    await waitFor(() => h.fake.killSignals.length > 0);
    expect(h.fake.killSignals).toContain(9);
  });
});

describe('EmbeddedAgentWorkerService initial-prompt delivery (Issue #1068)', () => {
  it('delivers session.initialPrompt as the first user message once, and persists the delivered flag', async () => {
    const h = setup({
      deliverInitialPromptOnActivation: true,
      initialPrompt: 'Please summarize the repo',
    });
    await h.service.activate(h.sessionId, h.workerId);
    const writesBeforeReady = h.fake.stdinWrites.length;
    h.persistSession.mockClear();

    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    await waitFor(() => h.fake.stdinWrites.length > writesBeforeReady);

    const forwarded = JSON.parse(h.fake.stdinWrites[writesBeforeReady]);
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toBe('Please summarize the repo');

    await waitFor(() => h.session.initialPromptDelivered === true);
    expect(h.persistSession).toHaveBeenCalledWith(h.session);
  });

  it('does NOT deliver a second time once initialPromptDelivered is already true', async () => {
    const h = setup({
      deliverInitialPromptOnActivation: true,
      initialPrompt: 'Please summarize the repo',
      initialPromptDelivered: true,
    });
    await h.service.activate(h.sessionId, h.workerId);
    const writesBeforeReady = h.fake.stdinWrites.length;
    h.persistSession.mockClear();

    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    // Give the async handler a chance to run; no user-message write should follow.
    await new Promise((r) => setTimeout(r, 40));

    expect(h.fake.stdinWrites.length).toBe(writesBeforeReady);
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  it('does NOT deliver when the worker is not eligible (added later via the generic add-worker route)', async () => {
    const h = setup({
      deliverInitialPromptOnActivation: false,
      initialPrompt: 'Please summarize the repo',
    });
    await h.service.activate(h.sessionId, h.workerId);
    const writesBeforeReady = h.fake.stdinWrites.length;
    h.persistSession.mockClear();

    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    await new Promise((r) => setTimeout(r, 40));

    expect(h.fake.stdinWrites.length).toBe(writesBeforeReady);
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  it('does NOT deliver when session.initialPrompt is empty/undefined', async () => {
    const h = setup({ deliverInitialPromptOnActivation: true });
    await h.service.activate(h.sessionId, h.workerId);
    const writesBeforeReady = h.fake.stdinWrites.length;
    h.persistSession.mockClear();

    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    await new Promise((r) => setTimeout(r, 40));

    expect(h.fake.stdinWrites.length).toBe(writesBeforeReady);
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  it('leaves initialPromptDelivered unset on send failure, so a later activation can retry', async () => {
    const h = setup({
      deliverInitialPromptOnActivation: true,
      initialPrompt: 'Please summarize the repo',
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.persistSession.mockClear();

    // Force the stdin write to throw (mirrors sendUserMessage's WRITE_FAILED path).
    h.worker.stdin!.write = () => {
      throw new Error('EPIPE');
    };

    h.fake.pushStdout('{"v":1,"type":"ready"}\n');
    // Bounded wait for the async delivery attempt to settle.
    await new Promise((r) => setTimeout(r, 40));

    expect(h.session.initialPromptDelivered).toBeUndefined();
    expect(h.persistSession).not.toHaveBeenCalled();
  });
});

describe('EmbeddedAgentWorkerService exit handling', () => {
  it('appends an exited event, revokes the token, clears the handle, and reports unexpected on crash', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    h.fake.simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    expect(appendedLines(h.bufferOutput)).toContain('{"v":1,"type":"exited","code":1}');
    expect(h.revokeByWorker).toHaveBeenCalledWith(h.workerId);
    expect(h.worker.subprocess).toBeNull();
    expect(h.worker.stdin).toBeNull();
    expect(h.recorder.onExit).toHaveBeenCalledWith(1, null, 'unexpected');
    expect(h.globalExit).toHaveBeenCalledWith(h.sessionId, h.workerId, 1, 'unexpected');
  });

  it('reports a managed reason when the exit follows deactivate', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    const dp = h.service.deactivate(h.sessionId, h.workerId);
    h.fake.simulateExit(0);
    await dp;

    expect(h.recorder.onExit).toHaveBeenCalledWith(0, null, 'managed');
    expect(h.fake.killSignals).toEqual([]);
  });

  it('ignores a stale exit from a superseded subprocess (does not touch the current handle/token)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    // Simulate a newer activation having already replaced the live subprocess
    // handle (distinct object from the original fake's subprocess).
    const newer = makeFakeSpawn();
    const replacement = newer.fn({ username: 'x', command: 'c' });
    h.worker.subprocess = replacement.subprocess;
    h.worker.stdin = replacement.stdin;

    h.revokeByWorker.mockClear();
    h.bufferOutput.mockClear();
    h.globalExit.mockClear();

    // Fire the ORIGINAL (now superseded) subprocess's exit.
    h.fake.simulateExit(1);
    // Bounded wait: the stale exit's observer chain (exited -> streamsDone ->
    // handleExit) completes within microtasks; if the guard were absent it
    // would null worker.subprocess and revoke the token within this window.
    await new Promise((r) => setTimeout(r, 40));

    // The CURRENT (replacement) handle and the token must be untouched.
    expect(h.worker.subprocess).toBe(replacement.subprocess);
    expect(h.worker.stdin).toBe(replacement.stdin);
    expect(h.revokeByWorker).not.toHaveBeenCalled();
    expect(appendedLines(h.bufferOutput)).not.toContain('{"v":1,"type":"exited","code":1}');
    expect(h.globalExit).not.toHaveBeenCalled();
  });
});

describe('EmbeddedAgentWorkerService.sendUserMessage', () => {
  it('rejects a second concurrent message synchronously (turn in progress)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const p1 = h.service.sendUserMessage(h.sessionId, h.workerId, 'first');
    const p2 = h.service.sendUserMessage(h.sessionId, h.workerId, 'second');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, code: 'TURN_IN_PROGRESS', error: 'turn in progress' });
  });

  it('forwards the user-message command to stdin BEFORE appending the persisted event', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const initWrites = h.fake.stdinWrites.length;
    h.bufferOutput.mockClear();

    // Record ordering at CALL-TIME on both sides: 'append' when bufferOutput
    // fires, 'forward' at the moment stdin.write happens (not after the async
    // call resolves — that would make the ordering assertion vacuous). Hooks
    // are installed AFTER activate so the init write is not recorded.
    const order: string[] = [];
    h.bufferOutput.mockImplementation(() => {
      order.push('append');
    });
    h.fake.setOnStdinWrite(() => {
      order.push('forward');
    });

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello');
    expect(res.ok).toBe(true);

    // Both were recorded at call-time; forward must strictly precede append,
    // so a WRITE_FAILED (stdin throws) never leaves a persisted/broadcast
    // echo for a message the loop never actually received. Since neither
    // call is async, this ordering doesn't affect replay stability.
    expect(order).toEqual(['forward', 'append']);

    // The forwarded command shape matches the user-message.
    const forwarded = JSON.parse(h.fake.stdinWrites[initWrites]);
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toBe('hello');
    if (res.ok) expect(forwarded.id).toBe(res.id);

    // clientMessageId was omitted by the caller: the key must be entirely
    // absent (not present with an `undefined` value) on the appended event.
    const appended = JSON.parse(appendedLines(h.bufferOutput)[0]);
    expect('clientMessageId' in appended).toBe(false);
  });

  it('threads clientMessageId into the appended/broadcast event but NOT into the stdin command (loop protocol unchanged)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const initWrites = h.fake.stdinWrites.length;
    h.bufferOutput.mockClear();

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello', 'test-client-msg-id');
    expect(res.ok).toBe(true);

    const userMessageLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    expect(userMessageLine).toBeDefined();
    const appended = JSON.parse(userMessageLine!);
    expect(appended.clientMessageId).toBe('test-client-msg-id');

    // Loop protocol is correlation-agnostic: the stdin-forwarded command
    // must never carry clientMessageId, even when the caller supplied one.
    const forwarded = JSON.parse(h.fake.stdinWrites[initWrites]);
    expect(forwarded.type).toBe('user-message');
    expect('clientMessageId' in forwarded).toBe(false);
  });

  it('rejects with not activated when the subprocess is null', async () => {
    const h = setup();
    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hi');
    expect(res).toEqual({ ok: false, code: 'NOT_ACTIVATED', error: 'not activated' });
  });

  it('rejects with code WRITE_FAILED when the stdin write throws, without persisting/broadcasting a phantom echo', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.worker.stdin).not.toBeNull();
    h.bufferOutput.mockClear();

    // Lowest-level mock: make the fake FileSink's write throw, mirroring a
    // real EPIPE/write failure on the underlying stdin stream.
    h.worker.stdin!.write = () => {
      throw new Error('EPIPE');
    };

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello');
    expect(res).toEqual({ ok: false, code: 'WRITE_FAILED', error: 'failed to write to subprocess stdin' });

    // The loop never received the message, so no user-message event may be
    // persisted/broadcast for it -- a phantom echo would falsely resolve the
    // sending client's pending promise despite the WRITE_FAILED response.
    expect(h.bufferOutput).not.toHaveBeenCalled();
  });

  it('re-admits a message after the loop reports idle', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const first = await h.service.sendUserMessage(h.sessionId, h.workerId, 'one');
    expect(first.ok).toBe(true);
    // A second message is rejected while the turn is active.
    expect((await h.service.sendUserMessage(h.sessionId, h.workerId, 'two')).ok).toBe(false);

    // Loop reports idle → turn clears.
    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.worker.activityState === 'idle');

    const third = await h.service.sendUserMessage(h.sessionId, h.workerId, 'three');
    expect(third.ok).toBe(true);
  });
});

describe('EmbeddedAgentWorkerService.triggerHandoff', () => {
  it('forwards a handoff command to stdin and admits synchronously', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const before = h.fake.stdinWrites.length;

    const res = await h.service.triggerHandoff(h.sessionId, h.workerId);

    expect(res).toEqual({ ok: true });
    const forwarded = JSON.parse(h.fake.stdinWrites[before]);
    expect(forwarded).toEqual({ v: 1, type: 'handoff' });
  });

  it('does not append any persisted/broadcast event for the handoff trigger itself', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    const res = await h.service.triggerHandoff(h.sessionId, h.workerId);

    expect(res.ok).toBe(true);
    expect(h.bufferOutput).not.toHaveBeenCalled();
  });

  it('rejects with NOT_ACTIVATED when the subprocess is null', async () => {
    const h = setup();
    const res = await h.service.triggerHandoff(h.sessionId, h.workerId);
    expect(res).toEqual({ ok: false, code: 'NOT_ACTIVATED', error: 'not activated' });
  });

  it('rejects a second concurrent trigger synchronously (turn in progress)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const p1 = h.service.triggerHandoff(h.sessionId, h.workerId);
    const p2 = h.service.triggerHandoff(h.sessionId, h.workerId);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, code: 'TURN_IN_PROGRESS', error: 'turn in progress' });
  });

  it('rejects a handoff while a sendUserMessage turn is already active (shared admission gate)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const sendResult = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello');
    expect(sendResult.ok).toBe(true);

    const handoffResult = await h.service.triggerHandoff(h.sessionId, h.workerId);
    expect(handoffResult).toEqual({ ok: false, code: 'TURN_IN_PROGRESS', error: 'turn in progress' });
  });

  it('rejects with code WRITE_FAILED when the stdin write throws, and clears turnActive so a retry is possible', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    h.worker.stdin!.write = () => {
      throw new Error('EPIPE');
    };

    const res = await h.service.triggerHandoff(h.sessionId, h.workerId);
    expect(res).toEqual({ ok: false, code: 'WRITE_FAILED', error: 'failed to write to subprocess stdin' });

    // turnActive was cleared on failure: a subsequent send is admitted.
    h.worker.stdin!.write = () => 0;
    const retry = await h.service.sendUserMessage(h.sessionId, h.workerId, 'retry');
    expect(retry.ok).toBe(true);
  });

  it('re-admits a handoff after the loop reports idle', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const first = await h.service.triggerHandoff(h.sessionId, h.workerId);
    expect(first.ok).toBe(true);
    expect((await h.service.triggerHandoff(h.sessionId, h.workerId)).ok).toBe(false);

    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.worker.activityState === 'idle');

    const third = await h.service.triggerHandoff(h.sessionId, h.workerId);
    expect(third.ok).toBe(true);
  });
});

describe('EmbeddedAgentWorkerService.cancel', () => {
  it('forwards a cancel command', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const before = h.fake.stdinWrites.length;

    const forwarded = h.service.cancel(h.sessionId, h.workerId);
    expect(forwarded).toBe(true);
    const cmd = JSON.parse(h.fake.stdinWrites[before]);
    expect(cmd).toEqual({ v: 1, type: 'cancel' });
  });

  it('returns false when not activated', () => {
    const h = setup();
    expect(h.service.cancel(h.sessionId, h.workerId)).toBe(false);
  });
});

describe('EmbeddedAgentWorkerService.deactivate escalation', () => {
  it('sends no kill signals when the loop exits within the grace period', async () => {
    const h = setup({ shutdownGraceMs: 50, sigtermTimeoutMs: 50 });
    await h.service.activate(h.sessionId, h.workerId);
    const dp = h.service.deactivate(h.sessionId, h.workerId);
    h.fake.simulateExit(0);
    await dp;
    expect(h.fake.killSignals).toEqual([]);
  });

  it('escalates to SIGTERM when the loop ignores shutdown', async () => {
    const h = setup({ shutdownGraceMs: 10, sigtermTimeoutMs: 200 });
    await h.service.activate(h.sessionId, h.workerId);
    // Exit only once SIGTERM (15) is delivered.
    h.fake.setOnKill((signal) => {
      if (signal === 15) h.fake.simulateExit(143);
    });
    await h.service.deactivate(h.sessionId, h.workerId);
    expect(h.fake.killSignals).toEqual([15]);
  });

  it('escalates to SIGKILL when the loop ignores SIGTERM', async () => {
    const h = setup({ shutdownGraceMs: 10, sigtermTimeoutMs: 10 });
    await h.service.activate(h.sessionId, h.workerId);
    // Exit only on SIGKILL (9).
    h.fake.setOnKill((signal) => {
      if (signal === 9) h.fake.simulateExit(137);
    });
    await h.service.deactivate(h.sessionId, h.workerId);
    expect(h.fake.killSignals).toEqual([15, 9]);
  });

  it('resolves only after exit cleanup ran (token revoked)', async () => {
    const h = setup({ shutdownGraceMs: 50, sigtermTimeoutMs: 50 });
    await h.service.activate(h.sessionId, h.workerId);
    const dp = h.service.deactivate(h.sessionId, h.workerId);
    h.fake.simulateExit(0);
    await dp;
    // After deactivate resolves, the exit observer's cleanup has run.
    expect(h.revokeByWorker).toHaveBeenCalledWith(h.workerId);
    expect(h.worker.subprocess).toBeNull();
  });
});
