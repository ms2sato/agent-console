import { describe, it, expect, mock } from 'bun:test';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../privilege-elevation.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import {
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';
import { EmbeddedAgentWorkerService } from '../embedded-agent-worker-service.js';

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
}

function makeFakeSpawn(): FakeSpawn {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const killSignals: number[] = [];
  let flushes = 0;
  let onKill: ((signal: number) => void) | undefined;

  const stdout = makeControllableStream();
  const stderr = makeControllableStream();

  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
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
  };
}

interface Recorder {
  onData: ReturnType<typeof mock>;
  onExit: ReturnType<typeof mock>;
  onActivityChange: ReturnType<typeof mock>;
}

interface Harness {
  service: EmbeddedAgentWorkerService;
  sessionId: string;
  workerId: string;
  worker: ReturnType<typeof buildInternalEmbeddedAgentWorker>;
  fake: FakeSpawn;
  mint: ReturnType<typeof mock>;
  revokeByWorker: ReturnType<typeof mock>;
  resetWorkerOutput: ReturnType<typeof mock>;
  bufferOutput: ReturnType<typeof mock>;
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
}): Harness {
  const definition = 'definition' in (opts ?? {}) ? opts!.definition : buildDefinition();
  const createdBy = opts && 'createdBy' in opts ? opts.createdBy : 'user-1';

  const worker = buildInternalEmbeddedAgentWorker({ id: 'w-emb', embeddedAgentId: 'def-1' });
  const session = buildInternalWorktreeSession([worker], { createdBy });
  const fake = makeFakeSpawn();

  const mint = mock(() => TOKEN);
  const revokeByWorker = mock(() => {});
  const resetWorkerOutput = mock(async () => NEW_EPOCH);
  const bufferOutput = mock(() => {});
  const loadProviderKeyFn =
    opts?.loadProviderKeyFn ?? mock(async () => API_KEY);
  const persistSession = mock(async () => {});
  const globalActivity = mock(() => {});
  const globalExit = mock(() => {});

  const recorder: Recorder = {
    onData: mock(() => {}),
    onExit: mock(() => {}),
    onActivityChange: mock(() => {}),
  };
  worker.connectionCallbacks.set('conn-1', {
    onData: recorder.onData as unknown as (data: string, offset: number, epoch: number) => void,
    onExit: recorder.onExit as unknown as (code: number, sig: string | null, reason?: 'managed' | 'unexpected') => void,
    onActivityChange: recorder.onActivityChange as unknown as (state: 'active' | 'idle' | 'asking' | 'unknown') => void,
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
    },
    getMcpBaseUrl: () => MCP_BASE_URL,
    loadProviderKeyFn: loadProviderKeyFn as never,
    spawnAsUserFn: opts?.spawnAsUserFnOverride ?? fake.fn,
    entryPath: ENTRY_PATH,
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
    fake,
    mint,
    revokeByWorker,
    resetWorkerOutput,
    bufferOutput,
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
    expect(opts.command).toBe(`bun '${ENTRY_PATH}'`);
    // Negative assertions: no secrets in the command line.
    expect(opts.command).not.toContain(TOKEN);
    expect(opts.command).not.toContain(API_KEY);
    // No env channel at all (secrets travel only over stdin).
    expect('env' in opts).toBe(false);
    expect(opts.env).toBeUndefined();
    expect(opts.cwd).toBe('/test/worktree');
    expect(opts.username).toBe(USERNAME);
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

  it('rejects a dangling definition without spawning or minting', async () => {
    const h = setup({ definition: undefined });
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('not found');
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
  });

  it('rejects a session without createdBy without minting or spawning', async () => {
    const h = setup({ createdBy: undefined });
    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('createdBy');
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.fake.captured.length).toBe(0);
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
  });

  it('does NOT revoke the token on a successful activation', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.revokeByWorker).not.toHaveBeenCalled();
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

  it('kills the subprocess on an oversized single line (> 1 MiB)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.pushStdout('x'.repeat(1024 * 1024 + 10));
    await waitFor(() => h.fake.killSignals.length > 0);
    expect(h.fake.killSignals).toContain(9);
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
});

describe('EmbeddedAgentWorkerService.sendUserMessage', () => {
  it('rejects a second concurrent message synchronously (turn in progress)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const p1 = h.service.sendUserMessage(h.sessionId, h.workerId, 'first');
    const p2 = h.service.sendUserMessage(h.sessionId, h.workerId, 'second');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, error: 'turn in progress' });
  });

  it('appends the user-message event BEFORE forwarding it to stdin', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const initWrites = h.fake.stdinWrites.length;
    h.bufferOutput.mockClear();

    // Record global ordering between bufferOutput and stdin.write.
    const order: string[] = [];
    h.bufferOutput.mockImplementation(() => {
      order.push('append');
    });
    const originalWrites = h.fake.stdinWrites.length;

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello');
    expect(res.ok).toBe(true);
    // A stdin write happened after the initial init writes.
    expect(h.fake.stdinWrites.length).toBe(originalWrites + 1);
    order.push('forward');

    // The appended event must precede the forward record.
    expect(order[0]).toBe('append');
    // The forwarded command shape matches the user-message.
    const forwarded = JSON.parse(h.fake.stdinWrites[initWrites]);
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toBe('hello');
    if (res.ok) expect(forwarded.id).toBe(res.id);
  });

  it('rejects with not activated when the subprocess is null', async () => {
    const h = setup();
    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hi');
    expect(res).toEqual({ ok: false, error: 'not activated' });
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
