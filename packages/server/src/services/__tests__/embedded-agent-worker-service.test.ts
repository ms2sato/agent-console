import { describe, it, expect, mock, setSystemTime, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as shared from '@agent-console/shared';
import { EMBEDDED_AGENT_SLASH_COMMANDS, type EmbeddedAgentDefinition, type SdkResumeFailureReason } from '@agent-console/shared';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../privilege-elevation.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { resolveUploadDir } from '../../lib/message-upload-dir.js';
import { buildPtyNotificationText, buildReplyInstructions, type PtyNotificationParams } from '../../lib/pty-notification.js';
import {
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';
import {
  EmbeddedAgentWorkerService,
  EmbeddedAgentActivationError,
  EmbeddedMessageDeliveryError,
  resolveEmbeddedAgentEntryPath,
  hasUndeliveredInitialPrompt,
  fatalLeavesHarnessAlive,
  isEvictableEngine,
  resolveConsoleSlashCommandOverride,
  CONSOLE_SLASH_COMMAND_HANDLERS,
} from '../embedded-agent-worker-service.js';
import {
  ProviderKeyStoreError,
  PROVIDER_KEY_STORE_UI_MESSAGES,
  type ProviderKeyStoreErrorKind,
} from '../provider-key-store.js';

const MCP_BASE_URL = 'http://localhost:3457/mcp';
const ENTRY_PATH = '/install/embedded-agent/src/main.ts';
const TOKEN = 'mcp-token-abcdef';
const API_KEY = 'sk-provider-secret';
const NEW_EPOCH = 4242;
const USERNAME = 'alice';
/**
 * R1 (#1447 stage 4): the epoch/offset `appendRestoreFailureMarker` reports
 * back on the PRIMARY preserve-and-declare path -- distinct sentinel values
 * from `NEW_EPOCH` (the FALLBACK reset path's epoch) so a test asserting
 * `worker.epoch` pins WHICH path ran, not just that some epoch was set.
 */
const MARKER_EPOCH = 7777;
const MARKER_OFFSET = 5555;

function buildDefinition(
  overrides?: Partial<Extract<EmbeddedAgentDefinition, { engine: 'openai-api' }>>
): EmbeddedAgentDefinition {
  return {
    id: 'def-1',
    name: 'Ollama qwen',
    engine: 'openai-api',
    provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b', apiKeyRef: 'openai' },
    isBuiltIn: false,
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
  /** Issue #1230: number of times the fake stdin sink's `end()` was called. */
  endCount: () => number;
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
  /** Resolve `exited` AND close both streams so the exit observer can complete. */
  simulateExit: (code: number) => void;
  /** Optional hook fired on kill(signal); tests use it to escalate to exit. */
  setOnKill: (fn: (signal: number) => void) => void;
  /** Hook fired at the moment stdin.write is called (for call-time ordering). */
  setOnStdinWrite: (fn: (chunk: string) => void) => void;
}

/**
 * Issue #1230: options controlling the fake stdin sink's `end()` behavior, so
 * teardown tests can assert `endStdinSafely` was invoked (via `endCount`) and
 * that a throwing `end()` (simulating an already-exited child / broken pipe)
 * does not propagate out of the teardown path.
 */
function makeFakeSpawn(opts?: { endThrows?: boolean }): FakeSpawn {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const killSignals: number[] = [];
  let flushes = 0;
  let ends = 0;
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
    end: () => {
      ends += 1;
      if (opts?.endThrows) {
        throw new Error('EPIPE: stdin already closed');
      }
    },
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
    endCount: () => ends,
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
  readHistoryForRestore: ReturnType<typeof mock>;
  appendRestoreFailureMarker: ReturnType<typeof mock>;
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
  /** Issue #1230: make the fake stdin sink's `end()` throw (simulates an already-exited child / broken pipe at teardown). */
  spawnEndThrows?: boolean;
  /** Transcript Restore, R1: a `sdkSessionId` already persisted on the worker, as a re-activation would find. */
  sdkSessionId?: string;
  /**
   * R1 (#1447 stage 4): make `appendRestoreFailureMarker` reject, forcing
   * the FALLBACK reset+sidecar path instead of the PRIMARY preserve-and-
   * declare path. Defaults to false -- every restore-failure test that does
   * not opt in exercises the new PRIMARY path.
   */
  appendRestoreFailureMarkerThrows?: boolean;
  /**
   * R4 (#1447 stage 4): whether the FALLBACK path's sidecar rename succeeds,
   * surfaced via `resetWorkerOutput`'s `onSidecarResult` callback. Defaults
   * to true (the common case). Only observable when the fallback path runs
   * (`appendRestoreFailureMarkerThrows: true`).
   */
  sidecarRenameSucceeds?: boolean;
}): Harness {
  const definition = 'definition' in (opts ?? {}) ? opts!.definition : buildDefinition();
  const createdBy = opts && 'createdBy' in opts ? opts.createdBy : 'user-1';

  const worker = buildInternalEmbeddedAgentWorker({
    id: 'w-emb',
    embeddedAgentId: 'def-1',
    deliverInitialPromptOnActivation: opts?.deliverInitialPromptOnActivation ?? false,
  });
  if (opts?.sdkSessionId !== undefined) worker.sdkSessionId = opts.sdkSessionId;
  if (opts?.staleEpoch !== undefined) worker.epoch = opts.staleEpoch;
  if (opts?.staleOutputOffset !== undefined) worker.outputOffset = opts.staleOutputOffset;
  const session = buildInternalWorktreeSession([worker], {
    createdBy,
    initialPrompt: opts?.initialPrompt,
    initialPromptDelivered: opts?.initialPromptDelivered,
  });
  const fake = makeFakeSpawn({ endThrows: opts?.spawnEndThrows });

  const mint = mock(() => TOKEN);
  const revokeByWorker = mock(() => {});
  const resetWorkerOutput = mock(
    async (
      _sessionId: string,
      _workerId: string,
      _resolver: unknown,
      resetOpts?: { onSidecarResult?: (succeeded: boolean) => void; persistentMarkerLine?: string },
    ) => {
      resetOpts?.onSidecarResult?.(opts?.sidecarRenameSucceeds ?? true);
      return NEW_EPOCH;
    },
  );
  // R1 (#1447 stage 4): the PRIMARY preserve-and-declare path's write.
  // Succeeds by default -- every restore-failure test that does not opt
  // into `appendRestoreFailureMarkerThrows` exercises the new primary path.
  const appendRestoreFailureMarker = mock(async () => {
    if (opts?.appendRestoreFailureMarkerThrows) {
      throw new Error('restore-failure marker append boom');
    }
    return { epoch: MARKER_EPOCH, offset: MARKER_OFFSET };
  });
  const bufferOutput = mock(() => {});
  const hasEverBeenActivated = mock(async () => opts?.everActivated ?? false);
  // Mirrors `readHistoryWithOffset`'s fixture so restore's input is the same
  // text either way: these tests are about what restore DOES with a stream,
  // not about where the walk-back found it.
  const readHistoryForRestore = mock(async () => {
    if (opts?.readHistoryWithOffsetThrows) {
      throw new Error('persisted stream read boom');
    }
    return {
      data: opts?.readHistoryWithOffsetResult?.data ?? '',
      stoppedAt: 'true-start' as const,
      epoch: opts?.readHistoryWithOffsetResult?.epoch ?? 0,
    };
  });
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
    onData: recorder.onData,
    onExit: recorder.onExit,
    onActivityChange: recorder.onActivityChange,
    onRestoreInfo: recorder.onRestoreInfo,
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
      readHistoryForRestore: readHistoryForRestore as never,
      appendRestoreFailureMarker: appendRestoreFailureMarker as never,
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
    readHistoryForRestore,
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
    appendRestoreFailureMarker,
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

/**
 * #1449 widened `RestoreInfo` to a two-branch union (success / failure).
 * Narrows a `getRestoreInfo()` result into the success branch -- an
 * assertion, not a cast, so a test that expected success but got the
 * failure form fails loudly here instead of silently widening every
 * `.completed` / `.restoredMessageCount` access at the call site.
 */
function expectRestoreSuccess<T extends { failed?: boolean }>(info: T | null | undefined): Exclude<T, { failed: true }> {
  if (info == null) throw new Error('expected a non-null restore-info value');
  if (info.failed === true) throw new Error('expected the restore-info SUCCESS form, got the #1449 failure form');
  return info as Exclude<T, { failed: true }>;
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
    expect(first.engine).toBe('openai-api');
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
      attachmentRoots: [resolveUploadDir()],
    });
    expect(first.maxToolIterations).toBe(25);
  });

  it('writes a claude-sdk init command whose provider carries only model (no apiKey field, structural absence)', async () => {
    const h = setup({
      definition: {
        id: 'def-sdk',
        name: 'Claude',
        engine: 'claude-sdk',
        provider: { model: 'claude-sonnet-5' },
        isBuiltIn: true,
        createdBy: 'system',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.engine).toBe('claude-sdk');
    expect(first.provider).toEqual({ model: 'claude-sonnet-5' });
    expect('apiKey' in first.provider).toBe(false);
    expect('baseUrl' in first.provider).toBe(false);
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

  describe('ProviderKeyStoreError reclassification (Issue #1259)', () => {
    const ALL_KINDS = Object.keys(PROVIDER_KEY_STORE_UI_MESSAGES) as ProviderKeyStoreErrorKind[];
    const REF = 'missing';
    // Sentinels standing in for content that must never leak into the UI-facing
    // EmbeddedAgentActivationError message -- the real absolute path (or, for
    // `unreadable`, the underlying fs error text) that ProviderKeyStoreError's
    // OWN `message` carries for server logs.
    const SENTINEL_PATH = '/test/config/provider-keys.json#sentinel-real-path';
    const SENTINEL_FS_MESSAGE = 'ENOENT: sentinel-fs-error-text';

    for (const kind of ALL_KINDS) {
      it(`wraps a ProviderKeyStoreError(kind='${kind}') into EmbeddedAgentActivationError with the matching UI template`, async () => {
        const logFacingMessage =
          kind === 'unreadable'
            ? `Failed to read provider key store at ${SENTINEL_PATH}: ${SENTINEL_FS_MESSAGE}`
            : `some log-facing message naming ${SENTINEL_PATH} for kind ${kind}`;
        const storeError = new ProviderKeyStoreError(logFacingMessage, kind, REF);
        const throwingLoader = mock(async () => {
          throw storeError;
        });
        const h = setup({
          definition: buildDefinition({ provider: { baseUrl: 'http://x/v1', model: 'm', apiKeyRef: REF } }),
          loadProviderKeyFn: throwingLoader,
        });

        let caught: unknown;
        try {
          await h.service.activate(h.sessionId, h.workerId);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(EmbeddedAgentActivationError);
        const activationError = caught as EmbeddedAgentActivationError;
        expect(activationError.message).toBe(PROVIDER_KEY_STORE_UI_MESSAGES[kind](REF));
        expect(activationError.message).not.toContain(SENTINEL_PATH);
        expect(activationError.message).not.toContain(SENTINEL_FS_MESSAGE);
        // `cause` preserves the original marker for server-side logging --
        // asserted with `toBe` (same instance), not just `toBeInstanceOf`.
        expect(activationError.cause).toBe(storeError);
        expect(h.fake.captured.length).toBe(0);
      });
    }

    // Note: the "UI message never contains the key VALUE" lock lives in
    // provider-key-store.test.ts's PROVIDER_KEY_STORE_UI_MESSAGES suite --
    // this seam only ever throws (never returns a resolved key), so there is
    // no key value to assert against here.

    // Allowlist-widening polarity lock (ii) (see .../__tests__/routes-embedded-agent.test.ts
    // for the WS-layer classification half of this lock): a bare
    // ProviderKeyStoreError reaching runActivation from OUTSIDE step 2's own
    // try/catch (e.g. thrown by a step-5 spawn seam, standing in for any
    // non-step-2 source) must NOT be reclassified into
    // EmbeddedAgentActivationError. This pins Ruling 1's mechanism choice: the
    // reclassification is a call-site wrap local to step 2, not a second
    // allowlisted class the WS/MCP/REST layer would need to know about.
    it('does NOT reclassify a bare ProviderKeyStoreError thrown from outside step 2 (e.g. the spawn step)', async () => {
      const storeError = new ProviderKeyStoreError(
        `Provider key store not found at ${SENTINEL_PATH}; cannot resolve apiKeyRef '${REF}'`,
        'not-found',
        REF,
      );
      const throwingSpawn = () => {
        throw storeError;
      };
      const h = setup({ spawnAsUserFnOverride: throwingSpawn });

      let caught: unknown;
      try {
        await h.service.activate(h.sessionId, h.workerId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ProviderKeyStoreError);
      expect(caught).not.toBeInstanceOf(EmbeddedAgentActivationError);
    });
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

/**
 * A persisted stream that fails reconstruction.
 *
 * The malformed line is deliberately the SECOND one, and NOT because the
 * first position stopped failing under this harness -- it did not.
 *
 * These tests are about what the SERVICE does when restore fails: reset with
 * sidecar, null restore-info, no `onRestoreInfo` push. The head tolerance
 * (#1445) is gated on `truncated`, which this harness pins to false
 * (`startOffset: 0`), so a lone `{not valid json` still throws here on the
 * corruption path. The original single-line fixture would still work.
 *
 * The fixture is position-independent anyway, because position became
 * load-bearing elsewhere: for a caller that does pass `truncated: true`, the
 * first record is the one the parser may drop. A test whose subject is the
 * service's failure handling should not quietly depend on which line is
 * malformed -- so this one states its own opening record rather than
 * inheriting a guarantee from a flag it never sets.
 */
const RESTORE_FAILING_STREAM = `${JSON.stringify({ v: 1, type: 'user-message', id: 'm0', text: 'opens the window' })}\n{not valid json`;

describe('EmbeddedAgentWorkerService — Transcript Restore (#1123)', () => {
  // The trailing `state: 'idle'` is what a real completed turn always
  // carries -- both engines emit it at the turn boundary. It was absent here
  // while nothing read it; R1's interrupted-turn detector does read it, and
  // without it this fixture describes a turn that was cut off rather than one
  // that finished, which would (correctly) get a `turn-interrupted` marker
  // appended and shift the offsets these tests assert on. Fixed here rather
  // than by loosening the detector: the fixture was under-specified, the rule
  // is not.
  const VALID_RESTORABLE_STREAM = [
    JSON.stringify({ v: 1, type: 'user-message', id: 'm1', text: 'hi there' }),
    JSON.stringify({ v: 1, type: 'assistant-message', turnId: 't1', text: 'hello back' }),
    JSON.stringify({ v: 1, type: 'state', state: 'idle' }),
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

  it('R1 PRIMARY path: preserves the output stream in place (no reset), appends the restore-failure boundary marker, and omits restoredConversation when restore fails', async () => {
    const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM } });

    await h.service.activate(h.sessionId, h.workerId);

    // R1 inversion: preserve-and-declare is PRIMARY -- reset must NOT run.
    expect(h.resetWorkerOutput).not.toHaveBeenCalled();
    expect(h.appendRestoreFailureMarker).toHaveBeenCalledWith(
      h.sessionId,
      h.workerId,
      expect.anything(),
      JSON.stringify({ v: 1, type: 'restore-failure-boundary' }),
    );
    // R3: no epoch bump on the preserved path -- worker.epoch/outputOffset
    // sync to the marker append's own manifest read, mirroring the success
    // path's currentEpoch/currentOffset sync.
    expect(h.worker.epoch).toBe(MARKER_EPOCH);
    expect(h.worker.outputOffset).toBe(MARKER_OFFSET);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('restoredConversation' in first).toBe(false);
  });

  it('R1 FALLBACK path: falls back to resetWorkerOutput with preserveToSidecar when the marker append itself fails', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
      appendRestoreFailureMarkerThrows: true,
    });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.appendRestoreFailureMarker).toHaveBeenCalled();
    expect(h.resetWorkerOutput).toHaveBeenCalledTimes(1);
    const [callSessionId, callWorkerId, , resetOpts] = h.resetWorkerOutput.mock.calls[0] as [
      string,
      string,
      unknown,
      { preserveToSidecar?: boolean; onSidecarResult?: unknown; persistentMarkerLine?: string },
    ];
    expect(callSessionId).toBe(h.sessionId);
    expect(callWorkerId).toBe(h.workerId);
    expect(resetOpts.preserveToSidecar).toBe(true);
    expect(typeof resetOpts.onSidecarResult).toBe('function');
    // openai-api has no sdkSessionId concept, so R6's persistent divergence
    // declaration must never be requested on this engine.
    expect(resetOpts.persistentMarkerLine).toBeUndefined();
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

  it('routes a persistent I/O error on an EXISTING worker through the R1 catch block, NOT the destructive first-activation shortcut (CodeRabbit CRITICAL)', async () => {
    // hasEverBeenActivated's real implementation is conservative on a
    // non-ENOENT stat failure: it reports `true` (assume activated) rather
    // than throwing, so this DI mock returns `true` too -- exercising the
    // caller-side contract that the injected hasEverBeenActivated never
    // throws. The restore attempt then hits the SAME underlying persistent
    // I/O failure via readHistoryWithOffset and correctly falls into the
    // R1 catch block instead of the destructive "nothing to restore"
    // shortcut -- by default (marker append succeeds) that means the
    // PRIMARY preserve-and-declare path, not the reset.
    const h = setup({ everActivated: true, readHistoryWithOffsetThrows: true });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.appendRestoreFailureMarker).toHaveBeenCalled();
    expect(h.resetWorkerOutput).not.toHaveBeenCalled();
    expect(h.worker.epoch).toBe(MARKER_EPOCH);
    expect(h.worker.outputOffset).toBe(MARKER_OFFSET);
  });

  it('routes a persistent I/O error through to the FALLBACK sidecar reset when the marker append also fails, still NOT the destructive first-activation shortcut', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetThrows: true,
      appendRestoreFailureMarkerThrows: true,
    });

    await h.service.activate(h.sessionId, h.workerId);

    expect(h.resetWorkerOutput).toHaveBeenCalledWith(
      h.sessionId,
      h.workerId,
      expect.anything(),
      expect.objectContaining({ preserveToSidecar: true }),
    );
    expect(h.worker.epoch).toBe(NEW_EPOCH);
    expect(h.worker.outputOffset).toBe(0);
  });

  describe('getRestoreInfo', () => {
    it('returns the current epoch + restore result after a successful restore', async () => {
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM } });
      await h.service.activate(h.sessionId, h.workerId);

      const info = expectRestoreSuccess(h.service.getRestoreInfo(h.workerId));
      expect(info.epoch).toBe(h.worker.epoch);
      // user + assistant. The synthetic system prompt is NOT restored content
      // and is excluded from the count.
      expect(info.restoredMessageCount).toBe(2);
      expect(info.repairedToolCallIds).toEqual([]);
      expect(info.completed).toBe(false);
    });

    it('#1449: declares a restore failure rather than returning null (openai-api, no sdkResumed)', async () => {
      // BUG-POLARITY PIN: against unmodified code (the #1449 assignment
      // commented out), `restoreInfo` stays null on this path and this
      // assertion fails with `null` !== the failure record. Verified by
      // commenting out `runActivation`'s catch-block `restoreInfo = {failed:
      // true, ...}` assignment (leaving everything else intact) and
      // confirming the test fails; restored, it passes. See
      // testing.md "Demonstrating polarity without breaking the build".
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM } });
      await h.service.activate(h.sessionId, h.workerId);

      // openai-api has no sdkResumed concept -- the failure record must omit
      // the field entirely, not carry it as `undefined`. R4: the default
      // (marker append succeeds) is the PRIMARY preserve-and-declare path,
      // so `preservation` reads `'in-band'` and `epoch` is the marker
      // append's own (unchanged) epoch, not a fresh one.
      const info = h.service.getRestoreInfo(h.workerId);
      expect(info).toEqual({ epoch: MARKER_EPOCH, failed: true, preservation: 'in-band' });
      expect('sdkResumed' in (info as object)).toBe(false);
    });

    it('reports restoredMessageCount 0 for a worker that was activated but never spoken to', async () => {
      // The count the client gates its "your conversation may not have
      // carried over" notice on. It has to be able to reach 0, or that
      // notice fires on a worker with no conversation at all -- a false
      // warning that teaches the user to ignore the real one.
      //
      // An activated worker's persisted stream is never literally empty (the
      // service treats an empty read as an I/O failure), so the reachable
      // production shape is a stream of lifecycle rows carrying no
      // conversation.
      const noiseOnlyStream = [
        JSON.stringify({ v: 1, type: 'ready' }),
        JSON.stringify({ v: 1, type: 'state', state: 'idle' }),
        JSON.stringify({ v: 1, type: 'exited', code: 0 }),
      ].join('\n');
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: noiseOnlyStream } });
      await h.service.activate(h.sessionId, h.workerId);

      // Restore SUCCEEDED -- this is not the failure-record path above.
      const info = expectRestoreSuccess(h.service.getRestoreInfo(h.workerId));
      expect(info.restoredMessageCount).toBe(0);
    });

    it('PRESENCE CONTROL: the same path reports non-zero once the stream carries real messages', async () => {
      // Pairs with the 0 assertion directly above. On its own, "the count
      // was 0" cannot tell "nothing was restored" apart from "this service
      // stopped reporting a count at all"; this control is what makes the
      // 0 meaningful.
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: VALID_RESTORABLE_STREAM } });
      await h.service.activate(h.sessionId, h.workerId);

      expect(expectRestoreSuccess(h.service.getRestoreInfo(h.workerId)).restoredMessageCount).toBe(2);
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
        restoredMessageCount: 2,
        repairedToolCallIds: [],
        completed: false,
      });
    });

    it('#1449: invokes onRestoreInfo with the failure form when restore fails', async () => {
      // BUG-POLARITY PIN, same mutation as the getRestoreInfo test above:
      // against unmodified code (the catch-block assignment commented out)
      // `restoreInfo` stays null, the `restoreInfo !== null` guard around the
      // fast-path push is never entered, and `onRestoreInfo` is never called
      // -- this assertion fails. Restored, it passes.
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM } });

      await h.service.activate(h.sessionId, h.workerId);

      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(1);
      // R4: default (marker append succeeds) is the PRIMARY path.
      expect(h.recorder.onRestoreInfo).toHaveBeenCalledWith({ failed: true, preservation: 'in-band' });
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
      expect(expectRestoreSuccess(h.service.getRestoreInfo(h.workerId)).completed).toBe(false);
      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(1);

      // (b) once the loop's `ready` event is processed, completed flips true
      // and the connection is poked again.
      h.fake.pushStdout('{"v":1,"type":"ready"}\n');
      await waitFor(() => expectRestoreSuccess(h.service.getRestoreInfo(h.workerId)).completed === true);

      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(2);
      expect(h.recorder.onRestoreInfo).toHaveBeenNthCalledWith(2, {
        restoredMessageCount: 2,
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

    it('#1449: does NOT touch or re-push restoreInfo on ready after a FAILED restore', async () => {
      // MUTATION MEASURED, two shapes:
      //   (1) Deleting ONLY the `failed !== true` clause (leaving `!== null`
      //       and `completed === false`) does NOT reproduce a runtime bug:
      //       `undefined === false` is `false` in JS, so the block still
      //       never executes for a failure record -- `tsc` rejects this
      //       mutation at COMPILE time instead (TS2339 on `.completed`,
      //       TS2322 on the spread assignment). This test cannot catch that
      //       shape at runtime; the type checker is the layer that does.
      //   (2) Flipping the comparison sense too (so an absent `completed`
      //       reads as "not yet completed" instead of relying on the
      //       `failed !== true` guard, e.g. `.completed !== true` in place
      //       of `failed !== true && completed === false`, bypassing `tsc`
      //       via a cast) DOES reproduce at runtime and this test catches
      //       it: the block executes, spreads `completed: true` onto the
      //       failure record, and the final `toEqual` fails on the extra
      //       field. This is the mutation that confirms the test's runtime
      //       reach; shape (1) confirms the type system's reach on the same
      //       guard.
      const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM } });
      await h.service.activate(h.sessionId, h.workerId);

      // R4: default (marker append succeeds) is the PRIMARY path.
      expect(h.service.getRestoreInfo(h.workerId)).toEqual({
        epoch: MARKER_EPOCH,
        failed: true,
        preservation: 'in-band',
      });
      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(1);

      h.fake.pushStdout('{"v":1,"type":"ready"}\n');
      await waitFor(() => appendedLines(h.bufferOutput).includes('{"v":1,"type":"ready"}'));

      // Unchanged: still exactly the failure record, no `completed` field
      // ever appears, and no second push happened.
      expect(h.service.getRestoreInfo(h.workerId)).toEqual({
        epoch: MARKER_EPOCH,
        failed: true,
        preservation: 'in-band',
      });
      expect(h.recorder.onRestoreInfo).toHaveBeenCalledTimes(1);
    });
  });
});

describe('EmbeddedAgentWorkerService.isEvicting', () => {
  // The commit-point re-check's fuller reach (the actual mid-eviction window
  // where `evicting === true` while `subprocess !== null`) is pinned in
  // embedded-agent-idle-eviction-service.test.ts, which already has the
  // exit-suppressed spawn fake needed to hold that window open. These are
  // the two boundary cases reachable from this file's plain single-subprocess
  // fixture.
  it('returns false for a worker id with no runtime at all (never activated)', () => {
    const h = setup();
    expect(h.service.isEvicting('no-such-worker')).toBe(false);
  });

  it('returns false for a genuinely active, non-evicting worker', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.service.isEvicting(h.workerId)).toBe(false);
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

  it('resolves via the bundle-sibling branch when embedded-agent.js sits next to baseDir', async () => {
    // Simulates a bundled production deploy: `dist/embedded-agent.js` next to
    // the running server bundle, with no workspace-package edge installed.
    //
    // Uses a manually-constructed unique path + `mkdir(..., { recursive: true })`
    // instead of `mkdtemp(tmpdir())`: when this file runs after another test
    // file that loaded `mock-fs-helper.ts` (mock.module poisons `node:fs`/
    // `node:fs/promises` process-wide -- see
    // `workers-upload-dir-real-fs.test.ts`'s header comment), `tmpdir()`'s
    // ancestors may not exist inside the active memfs volume, and `mkdtemp`
    // fails with ENOENT. `recursive: true` creates the missing `/tmp`
    // ancestor under memfs while being a no-op under the real fs, so the
    // fixture lands in the same filesystem the production `existsSync` call
    // observes in both regimes.
    const tmpDir = join(tmpdir(), `embedded-agent-bundle-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const bundlePath = join(tmpDir, 'embedded-agent.js');
      await writeFile(bundlePath, '// stub bundle\n');

      const result = resolveEmbeddedAgentEntryPath(tmpDir);
      expect(result.source).toBe('bundle');
      expect(result.path).toBe(bundlePath);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not take the bundle branch when embedded-agent.js is absent from baseDir', async () => {
    // A bare tmpdir has neither embedded-agent.js nor a resolvable
    // @agent-console/embedded-agent package edge, so resolution falls through
    // to the source-tree-relative fallback branch.
    //
    // See the `mkdtemp` -> `mkdir(..., { recursive: true })` note in the
    // preceding test for why a manual unique path is used here.
    const tmpDir = join(tmpdir(), `embedded-agent-no-bundle-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = resolveEmbeddedAgentEntryPath(tmpDir);
      expect(result.source).toBe('fallback');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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

describe('EmbeddedAgentWorkerService sdk-session-id event handling (SDK Engine Phase 1)', () => {
  it('updates worker.sdkSessionId and persists the session', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.persistSession.mockClear();

    expect(h.worker.sdkSessionId).toBeNull();

    h.fake.pushStdout('{"v":1,"type":"sdk-session-id","sdkSessionId":"sdk-sess-abc"}\n');
    await waitFor(() => h.worker.sdkSessionId === 'sdk-sess-abc');

    expect(h.worker.sdkSessionId).toBe('sdk-sess-abc');
    expect(h.persistSession).toHaveBeenCalledWith(h.session);
  });

  it('last-write-wins on a second sdk-session-id event (session-replacement reseed)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    h.fake.pushStdout('{"v":1,"type":"sdk-session-id","sdkSessionId":"sdk-sess-first"}\n');
    await waitFor(() => h.worker.sdkSessionId === 'sdk-sess-first');

    h.persistSession.mockClear();
    h.fake.pushStdout('{"v":1,"type":"sdk-session-id","sdkSessionId":"sdk-sess-second"}\n');
    await waitFor(() => h.worker.sdkSessionId === 'sdk-sess-second');

    expect(h.worker.sdkSessionId).toBe('sdk-sess-second');
    expect(h.persistSession).toHaveBeenCalledWith(h.session);
  });
});

// Scoped to the embedded-agent path only -- the PTY-backed agent-worker
// path computes the identical rule separately via resolveStartupIntent's
// `obligated` check in startup-intent.ts. See both functions' JSDoc for
// why the two are kept as family-scoped single writers rather than merged.
describe('hasUndeliveredInitialPrompt (Issue #1264)', () => {
  it('is true when all three conditions hold', () => {
    const worker = buildInternalEmbeddedAgentWorker({ deliverInitialPromptOnActivation: true });
    const session = buildInternalWorktreeSession([worker], {
      initialPrompt: 'Please summarize the repo',
      initialPromptDelivered: false,
    });

    expect(hasUndeliveredInitialPrompt(worker, session)).toBe(true);
  });

  it('is false when deliverInitialPromptOnActivation is false', () => {
    const worker = buildInternalEmbeddedAgentWorker({ deliverInitialPromptOnActivation: false });
    const session = buildInternalWorktreeSession([worker], {
      initialPrompt: 'Please summarize the repo',
      initialPromptDelivered: false,
    });

    expect(hasUndeliveredInitialPrompt(worker, session)).toBe(false);
  });

  it('is false when initialPromptDelivered is already true', () => {
    const worker = buildInternalEmbeddedAgentWorker({ deliverInitialPromptOnActivation: true });
    const session = buildInternalWorktreeSession([worker], {
      initialPrompt: 'Please summarize the repo',
      initialPromptDelivered: true,
    });

    expect(hasUndeliveredInitialPrompt(worker, session)).toBe(false);
  });

  it('is false when initialPrompt is undefined', () => {
    const worker = buildInternalEmbeddedAgentWorker({ deliverInitialPromptOnActivation: true });
    const session = buildInternalWorktreeSession([worker], {
      initialPromptDelivered: false,
    });

    expect(hasUndeliveredInitialPrompt(worker, session)).toBe(false);
  });

  it('is false when initialPrompt is whitespace-only', () => {
    const worker = buildInternalEmbeddedAgentWorker({ deliverInitialPromptOnActivation: true });
    const session = buildInternalWorktreeSession([worker], {
      initialPrompt: '   \n\t  ',
      initialPromptDelivered: false,
    });

    expect(hasUndeliveredInitialPrompt(worker, session)).toBe(false);
  });
});

describe('EmbeddedAgentWorkerService exit handling', () => {
  it('appends an exited event, revokes the token, clears the handle, and reports unexpected on crash', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    h.fake.simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    expect(appendedLines(h.bufferOutput)).toContain('{"v":1,"type":"exited","code":1,"reason":"unexpected"}');
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
    expect(appendedLines(h.bufferOutput).some((l) => l.includes('"type":"exited"'))).toBe(false);
    expect(h.globalExit).not.toHaveBeenCalled();
  });
});

/** Pull the single `exited` row out of a test's appended lines, parsed. */
function findExitedRow(bufferOutput: ReturnType<typeof mock>): Record<string, unknown> {
  const line = appendedLines(bufferOutput).find((l) => l.includes('"type":"exited"'));
  if (line === undefined) throw new Error('expected an "exited" row to have been appended');
  return JSON.parse(line) as Record<string, unknown>;
}

describe('EmbeddedAgentWorkerService exit handling — stderr tail (Issue #1454)', () => {
  it('carries the stderr tail on an unexpected exit', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    h.fake.pushStderr('stderr line one\n');
    h.fake.pushStderr('stderr line two\n');
    h.fake.simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    const row = findExitedRow(h.bufferOutput);
    expect(row.reason).toBe('unexpected');
    expect(row.stderrTail).toBe('stderr line one\nstderr line two\n');
  });

  it('retains only the LAST STDERR_TAIL_CAP characters', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const startMarker = 'START_MARKER_XYZ';
    const endMarker = 'END_MARKER_ABC';
    const filler = 'x'.repeat(2000);
    // Total pushed length (~6000 chars) comfortably exceeds the 2048
    // UTF-16 code-unit cap, so the start marker is guaranteed to fall
    // outside the retained window regardless of exactly where the cap
    // boundary lands.
    h.fake.pushStderr(startMarker + filler);
    h.fake.pushStderr(filler);
    h.fake.pushStderr(filler + endMarker);
    h.fake.simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    const row = findExitedRow(h.bufferOutput);
    const tail = row.stderrTail as string;
    expect(tail.length).toBeLessThanOrEqual(2048);
    expect(tail).toContain(endMarker);
    expect(tail).not.toContain(startMarker);
  });

  it('a managed exit (deactivate) carries no stderrTail even when stderr was written', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    h.fake.pushStderr('some warning output that must not leak into a managed exit row');
    const dp = h.service.deactivate(h.sessionId, h.workerId);
    h.fake.simulateExit(0);
    await dp;

    const row = findExitedRow(h.bufferOutput);
    expect(row.reason).toBe('managed');
    expect(Object.hasOwn(row, 'stderrTail')).toBe(false);
  });

  it('an unexpected exit with empty stderr has no stderrTail key', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    h.fake.simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    const row = findExitedRow(h.bufferOutput);
    expect(row.reason).toBe('unexpected');
    expect(Object.hasOwn(row, 'stderrTail')).toBe(false);
  });

  it('the tail is per-incarnation: a fresh incarnation starts with an empty buffer', async () => {
    const multi = makeMultiChildFakeSpawn();
    const h = setup({ spawnAsUserFnOverride: multi.fn });

    // Incarnation 1: writes stderr, then exits unexpectedly.
    await h.service.activate(h.sessionId, h.workerId);
    multi.children[0].pushStderr('leaked from incarnation 1, must not survive into incarnation 2');
    multi.children[0].simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    // Incarnation 2: a fresh activation on the same worker, no stderr written.
    await h.service.activate(h.sessionId, h.workerId);
    multi.children[1].simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    const rows = appendedLines(h.bufferOutput)
      .filter((l) => l.includes('"type":"exited"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.stderrTail).toBe('leaked from incarnation 1, must not survive into incarnation 2');
    expect(Object.hasOwn(rows[1] ?? {}, 'stderrTail')).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Issue #1230: feeding spawnAsUser consumers must close the stdin sink at
// teardown so the OS pipe fd is released deterministically instead of being
// left for incidental GC (same unsound pattern Issue #1196 flagged for PTY
// master fds). Two teardown sites: the exit observer (handleExit) and the
// activation-failure catch in runActivation (for a failure occurring after
// spawn but before the exit observer is registered).
// -----------------------------------------------------------------------
describe('EmbeddedAgentWorkerService stdin sink teardown (Issue #1230)', () => {
  it('closes the stdin sink exactly once when the subprocess exits (handleExit)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    h.fake.simulateExit(0);
    await waitFor(() => h.worker.subprocess === null);

    expect(h.fake.endCount()).toBe(1);
  });

  it('completes exit cleanup without throwing when the stdin sink throws on end() (broken pipe)', async () => {
    const h = setup({ spawnEndThrows: true });
    await h.service.activate(h.sessionId, h.workerId);
    h.recorder.onExit.mockClear();

    h.fake.simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    // Cleanup ran to completion (revoke, null fields, fire onExit) despite
    // the sink throwing on end() -- `endStdinSafely` swallows it internally.
    expect(h.worker.subprocess).toBeNull();
    expect(h.worker.stdin).toBeNull();
    expect(h.revokeByWorker).toHaveBeenCalledWith(h.workerId);
    expect(h.recorder.onExit).toHaveBeenCalledWith(1, null, 'unexpected');
    expect(h.fake.endCount()).toBe(1);
  });

  it('closes the spawned stdin sink when a post-spawn step fails before the exit observer is registered', async () => {
    // The init command write (runActivation Step 6) is the only step between
    // assigning the spawned stdin handle and registering the exit observer
    // (Step 7). Forcing it to throw exercises the activation-failure catch's
    // teardown path with a live (never-observed) stdin sink.
    const h = setup();
    h.fake.setOnStdinWrite(() => {
      throw new Error('EPIPE: broken pipe during init write');
    });

    await expect(h.service.activate(h.sessionId, h.workerId)).rejects.toThrow('EPIPE');

    expect(h.worker.subprocess).toBeNull();
    expect(h.worker.stdin).toBeNull();
    expect(h.revokeByWorker).toHaveBeenCalledWith(h.workerId);
    expect(h.fake.endCount()).toBe(1);
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
    if (res.ok && 'id' in res) expect(forwarded.id).toBe(res.id);

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

  it('wakes a worker with no live subprocess instead of rejecting (the delivery invariant)', async () => {
    // Idle eviction made delivery responsible for waking: the choke point
    // checks for a live subprocess, deliberately NOT for an evicted marker, so
    // "never activated" and "evicted" take the same path. A silent drop is not
    // representable here -- delivery either wakes the worker or fails loudly
    // (see embedded-agent-idle-eviction-service.test.ts for the failure half).
    const h = setup();
    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hi');

    expect(res.ok).toBe(true);
    expect(h.fake.captured.length).toBe(1);
    expect(h.fake.stdinWrites.some((w) => w.includes('"text":"hi"'))).toBe(true);
  });

  it('a plain sendUserMessage call never sets a notification marker on the appended event (Issue #1351 invariant)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, 'hello');
    expect(res.ok).toBe(true);

    const userMessageLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    expect(userMessageLine).toBeDefined();
    const appended = JSON.parse(userMessageLine!);
    expect('notification' in appended).toBe(false);
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

describe('EmbeddedAgentWorkerService — slash-command interception (#1572)', () => {
  it('a /compact sent to an openai-api worker is intercepted: the command WRITTEN to stdin is {v:1,type:"compact"}, never user-message', async () => {
    // Required pin 1. Polarity: with the interception removed from
    // sendUserMessage (route straight to deliverUserTurn with no
    // commandOverride), this test fails -- the written command would be
    // `{v:1, type:'user-message', ...}` instead.
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const initWrites = h.fake.stdinWrites.length;

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, '/compact');
    expect(res.ok).toBe(true);

    const forwarded = JSON.parse(h.fake.stdinWrites[initWrites]);
    expect(forwarded).toEqual({ v: 1, type: 'compact' });
  });

  it('the persisted transcript still gets a normal user-message event with text "/compact"', async () => {
    // Required pin 2: the interception changes only the WIRE command, never
    // the PERSISTED event -- the user sees exactly what they typed.
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, '/compact');
    expect(res.ok).toBe(true);

    const userMessageLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    expect(userMessageLine).toBeDefined();
    const appended = JSON.parse(userMessageLine!);
    expect(appended.text).toBe('/compact');
    if (res.ok && 'id' in res) expect(appended.id).toBe(res.id);
  });

  it('a /compact sent to a claude-sdk worker is NOT intercepted: writes user-message as before', async () => {
    // Required pin 3: the per-engine boundary. claude-sdk's own table entry
    // for `/compact` is `engine`-handled, so this worker must see the
    // ordinary forwarding path, guarding against a copy-paste bug that
    // accidentally intercepts the wrong engine.
    const h = setup({ definition: buildSdkDefinition() });
    await h.service.activate(h.sessionId, h.workerId);
    const initWrites = h.fake.stdinWrites.length;

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, '/compact');
    expect(res.ok).toBe(true);

    const forwarded = JSON.parse(h.fake.stdinWrites[initWrites]);
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toBe('/compact');
  });

  it('a context-compacted event reported by the subprocess after a compact command was written reaches the persisted stream (round trip)', async () => {
    // Required pin 4: the outbound interception plus the INBOUND round
    // trip -- a `context-compacted` boundary the subprocess reports back is
    // not itself special-cased, but this pins that the ordinary NDJSON
    // stdout pipeline still carries it through after a `compact` command
    // (as opposed to a `user-message`) was the one written.
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    const res = await h.service.sendUserMessage(h.sessionId, h.workerId, '/compact');
    expect(res.ok).toBe(true);

    h.fake.pushStdout('{"v":1,"type":"context-compacted","source":"manual"}\n');
    await waitFor(() =>
      appendedLines(h.bufferOutput).some((line) => JSON.parse(line).type === 'context-compacted'),
    );

    const compactedLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'context-compacted',
    );
    expect(JSON.parse(compactedLine!)).toMatchObject({ v: 1, type: 'context-compacted', source: 'manual' });
  });

  it('CONSOLE_SLASH_COMMAND_HANDLERS keys exactly equal the flattened set of console-handled command names in EMBEDDED_AGENT_SLASH_COMMANDS', () => {
    // Required pin 5 (mechanical containment): fails if a new `console`
    // entry is added to the shared table with no matching handler here, and
    // fails if a handler exists with no matching table entry.
    const consoleHandledNames = new Set<string>();
    for (const commands of Object.values(EMBEDDED_AGENT_SLASH_COMMANDS)) {
      for (const command of commands) {
        if (command.handledBy === 'console') consoleHandledNames.add(command.name);
      }
    }
    expect(new Set(Object.keys(CONSOLE_SLASH_COMMAND_HANDLERS))).toEqual(consoleHandledNames);
  });

  it('resolveConsoleSlashCommandOverride returns null for a claude-sdk engine even though the same text is console-handled on openai-api', () => {
    expect(resolveConsoleSlashCommandOverride('claude-sdk', '/compact')).toBeNull();
    expect(resolveConsoleSlashCommandOverride('openai-api', '/compact')).toEqual({ v: 1, type: 'compact' });
  });

  it('resolveConsoleSlashCommandOverride trims whitespace and returns null for a non-matching string', () => {
    expect(resolveConsoleSlashCommandOverride('openai-api', '  /compact  ')).toEqual({ v: 1, type: 'compact' });
    expect(resolveConsoleSlashCommandOverride('openai-api', 'please /compact this')).toBeNull();
  });

  it('resolveConsoleSlashCommandOverride matches by first token: trailing arguments are ignored (Architect ruling, #1584)', () => {
    expect(resolveConsoleSlashCommandOverride('openai-api', '/compact extra args')).toEqual({ v: 1, type: 'compact' });
  });

  it('resolveConsoleSlashCommandOverride does NOT match a different word that merely shares a prefix', () => {
    expect(resolveConsoleSlashCommandOverride('openai-api', '/compactx')).toBeNull();
  });

  it('resolveConsoleSlashCommandOverride delegates to the shared matchSlashCommand rather than reimplementing the match rule', () => {
    // Delegation pin (#1572): spies on the shared package's live binding of
    // matchSlashCommand and forces it to return null. If this function
    // reimplemented the match locally (instead of calling through the
    // shared function), the spy would have no effect and the assertion
    // below would fail on the wrong side (the real match would still fire).
    const spy = spyOn(shared, 'matchSlashCommand').mockReturnValue(null);
    try {
      expect(resolveConsoleSlashCommandOverride('openai-api', '/compact')).toBeNull();
    } finally {
      spy.mockRestore();
    }
    // Sanity: with the spy restored, the real (non-null) behavior returns.
    expect(resolveConsoleSlashCommandOverride('openai-api', '/compact')).toEqual({ v: 1, type: 'compact' });
  });
});

describe('EmbeddedAgentWorkerService.sendSystemNotification (Issue #1351)', () => {
  const NOTIFICATION_PARAMS: PtyNotificationParams = {
    kind: 'internal-message',
    tag: 'internal:message',
    fields: {
      source: 'session',
      from: 'sender-session-id',
      summary: 'Message from session sender-title',
      path: '/data/messages/m1.json',
    },
    intent: 'triage',
  };

  const TIMER_PARAMS: PtyNotificationParams = {
    kind: 'internal-timer',
    tag: 'internal:timer',
    fields: {
      timerId: 't1',
      action: 'wake up and check the build',
      fireCount: '1',
    },
    intent: 'inform',
  };

  it('delivers text to stdin and persists text IDENTICAL to buildPtyNotificationText(params) when no replyToSessionId is given', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const initWrites = h.fake.stdinWrites.length;
    h.bufferOutput.mockClear();

    // buildPtyNotificationText independently calls `new Date().toISOString()`
    // for the timestamp field both inside the production call and in this
    // test's own `expectedText` computation below. Without a frozen clock,
    // the two calls can straddle a millisecond boundary on a loaded CI
    // runner, producing two different timestamps and failing the
    // exact-equality assertion for a reason unrelated to whether the two
    // call paths actually agree (see pty-notification.test.ts, Issue #1321,
    // for the identical pattern this mirrors).
    setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let res: Awaited<ReturnType<typeof h.service.sendSystemNotification>>;
    let expectedText: string;
    try {
      res = await h.service.sendSystemNotification(h.sessionId, h.workerId, NOTIFICATION_PARAMS);
      expectedText = buildPtyNotificationText(NOTIFICATION_PARAMS);
    } finally {
      setSystemTime();
    }
    expect(res.ok).toBe(true);

    const forwarded = JSON.parse(h.fake.stdinWrites[initWrites]);
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toBe(expectedText);

    const userMessageLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    expect(userMessageLine).toBeDefined();
    const appended = JSON.parse(userMessageLine!);
    expect(appended.text).toBe(expectedText);
  });

  it('appends buildReplyInstructions(id) as a suffix when replyToSessionId is set, without changing notification.kind/summary', async () => {
    const hNoReply = setup();
    await hNoReply.service.activate(hNoReply.sessionId, hNoReply.workerId);
    hNoReply.bufferOutput.mockClear();

    const hReply = setup();
    await hReply.service.activate(hReply.sessionId, hReply.workerId);
    hReply.bufferOutput.mockClear();

    // This test compares the persisted TEXT of two independent
    // sendSystemNotification calls byte-for-byte (modulo the reply-
    // instructions suffix). Each call independently stamps a
    // `new Date().toISOString()` timestamp via buildPtyNotificationText, so
    // without a frozen clock the two calls could straddle a millisecond
    // boundary and produce two different timestamps, failing the equality
    // assertion below for a reason unrelated to what's under test (same
    // pattern as pty-notification.test.ts, Issue #1321).
    setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let resNoReply: Awaited<ReturnType<typeof hNoReply.service.sendSystemNotification>>;
    let resReply: Awaited<ReturnType<typeof hReply.service.sendSystemNotification>>;
    try {
      resNoReply = await hNoReply.service.sendSystemNotification(
        hNoReply.sessionId,
        hNoReply.workerId,
        NOTIFICATION_PARAMS,
      );
      resReply = await hReply.service.sendSystemNotification(
        hReply.sessionId,
        hReply.workerId,
        NOTIFICATION_PARAMS,
        { replyToSessionId: 'sender-session-id' },
      );
    } finally {
      setSystemTime();
    }
    expect(resNoReply.ok).toBe(true);
    expect(resReply.ok).toBe(true);

    const lineNoReply = appendedLines(hNoReply.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    const appendedNoReply = JSON.parse(lineNoReply!);
    const lineReply = appendedLines(hReply.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    const appendedReply = JSON.parse(lineReply!);

    // Persisted text ends with the exact reply-instructions suffix.
    expect(appendedReply.text.endsWith(buildReplyInstructions('sender-session-id'))).toBe(true);
    // The base text (without the suffix) is unchanged from the no-reply case.
    expect(appendedReply.text).toBe(appendedNoReply.text + buildReplyInstructions('sender-session-id'));

    // notification.kind/summary are byte-identical between the two cases --
    // the reply-instructions suffix must never leak into the collapsed-row
    // fields (architect ruling).
    expect(appendedReply.notification).toEqual(appendedNoReply.notification);
  });

  it('sets notification.summary from fields.summary for a kind whose fields carry one (internal-message)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    await h.service.sendSystemNotification(h.sessionId, h.workerId, NOTIFICATION_PARAMS);

    const userMessageLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    const appended = JSON.parse(userMessageLine!);
    expect(appended.notification).toEqual({
      kind: 'internal-message',
      summary: 'Message from session sender-title',
    });
  });

  it('omits the summary key entirely (not merely undefined) for a kind whose fields carry no summary (internal-timer)', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();

    await h.service.sendSystemNotification(h.sessionId, h.workerId, TIMER_PARAMS);

    const userMessageLine = appendedLines(h.bufferOutput).find(
      (line) => JSON.parse(line).type === 'user-message',
    );
    const appended = JSON.parse(userMessageLine!);
    expect(appended.notification).toEqual({ kind: 'internal-timer' });
    expect('summary' in appended.notification).toBe(false);
  });
});

describe('EmbeddedAgentWorkerService — mid-turn notification queue (R3, Issue #1574)', () => {
  const TIMER_PARAMS: PtyNotificationParams = {
    kind: 'internal-timer',
    tag: 'internal:timer',
    fields: {
      timerId: 't1',
      action: 'check the build',
      fireCount: '1',
    },
    intent: 'inform',
  };

  function withTimerId(timerId: string): PtyNotificationParams {
    return { ...TIMER_PARAMS, fields: { ...TIMER_PARAMS.fields, timerId } };
  }

  it('q1: a system notification that arrives mid-turn is queued ({ ok: true, queued: true }), not written to stdin until state:idle, then delivered as the next turn', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const first = await h.service.sendUserMessage(h.sessionId, h.workerId, 'busy');
    expect(first.ok).toBe(true);
    const stdinWritesBeforeQueue = h.fake.stdinWrites.length;

    const res = await h.service.sendSystemNotification(h.sessionId, h.workerId, TIMER_PARAMS);
    expect(res).toEqual({ ok: true, queued: true });
    // Not delivered yet -- still mid the first turn.
    expect(h.fake.stdinWrites.length).toBe(stdinWritesBeforeQueue);

    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.fake.stdinWrites.length > stdinWritesBeforeQueue);

    const forwarded = JSON.parse(h.fake.stdinWrites[stdinWritesBeforeQueue]);
    expect(forwarded.type).toBe('user-message');
    expect(forwarded.text).toContain('[internal:timer]');

    const userMessageLine = appendedLines(h.bufferOutput)
      .map((line) => JSON.parse(line) as { type: string; notification?: { kind: string } })
      .find((event) => event.type === 'user-message' && event.notification !== undefined);
    expect(userMessageLine?.notification).toEqual({ kind: 'internal-timer' });
  });

  it('q2: two queued notifications are delivered in order, one per state:idle event', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    await h.service.sendUserMessage(h.sessionId, h.workerId, 'busy');
    const stdinWritesBeforeQueue = h.fake.stdinWrites.length;

    expect(await h.service.sendSystemNotification(h.sessionId, h.workerId, withTimerId('q-1'))).toEqual({ ok: true, queued: true });
    expect(await h.service.sendSystemNotification(h.sessionId, h.workerId, withTimerId('q-2'))).toEqual({ ok: true, queued: true });
    expect(h.fake.stdinWrites.length).toBe(stdinWritesBeforeQueue);

    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.fake.stdinWrites.length === stdinWritesBeforeQueue + 1);
    expect(JSON.parse(h.fake.stdinWrites[stdinWritesBeforeQueue]).text).toContain('timerId=q-1');

    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.fake.stdinWrites.length === stdinWritesBeforeQueue + 2);
    expect(JSON.parse(h.fake.stdinWrites[stdinWritesBeforeQueue + 1]).text).toContain('timerId=q-2');
  });

  it('q3: the 33rd enqueue drops the oldest entry (FIFO overflow at MAX_PENDING_NOTIFICATIONS=32), keeping the 32 most recent', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    await h.service.sendUserMessage(h.sessionId, h.workerId, 'busy');

    // Enqueue 33 -- timerId 'o-1' (oldest) through 'o-33' (newest).
    for (let i = 1; i <= 33; i++) {
      expect(await h.service.sendSystemNotification(h.sessionId, h.workerId, withTimerId(`o-${i}`))).toEqual({
        ok: true,
        queued: true,
      });
    }

    // Flush all remaining entries: 32 idle events (each completes the
    // previously-flushed turn and starts the next queued one).
    const deliveredTimerIds: string[] = [];
    for (let i = 0; i < 32; i++) {
      const before = h.fake.stdinWrites.length;
      h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
      await waitFor(() => h.fake.stdinWrites.length > before);
      const forwarded = JSON.parse(h.fake.stdinWrites[before]) as { text: string };
      const match = forwarded.text.match(/timerId=(o-\d+)/);
      deliveredTimerIds.push(match ? match[1] : 'NO_MATCH');
    }

    // 'o-1' (the oldest, dropped on the 33rd enqueue) never appears; the 32
    // survivors are delivered oldest-remaining-first ('o-2'..'o-33').
    expect(deliveredTimerIds).toHaveLength(32);
    expect(deliveredTimerIds).not.toContain('o-1');
    expect(deliveredTimerIds[0]).toBe('o-2');
    expect(deliveredTimerIds[31]).toBe('o-33');
    // No 34th delivery -- the queue is empty after 32 flushes.
    const stdinWritesAfterAllFlushes = h.fake.stdinWrites.length;
    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fake.stdinWrites.length).toBe(stdinWritesAfterAllFlushes);
  });

  it('q4: a queued notification does not survive the worker exiting and being reactivated (no stranded phantom turn on a later incarnation)', async () => {
    // Two real incarnations are needed here (one fake subprocess cannot be
    // exited and then reactivated -- its streams are permanently closed),
    // so this uses makeMultiChildFakeSpawn (defined below in this file,
    // hoisted) rather than the single-child `setup()` default.
    const multi = makeMultiChildFakeSpawn();
    const h = setup({ spawnAsUserFnOverride: multi.fn });

    await h.service.activate(h.sessionId, h.workerId);
    await h.service.sendUserMessage(h.sessionId, h.workerId, 'busy');
    expect(await h.service.sendSystemNotification(h.sessionId, h.workerId, withTimerId('stranded'))).toEqual({
      ok: true,
      queued: true,
    });

    // Kill incarnation 1 WITHOUT ever letting the busy turn go idle -- the
    // queued notification was never delivered to this incarnation.
    multi.children[0].simulateExit(1);
    await waitFor(() => h.worker.subprocess === null);

    // Reactivate incarnation 2 (a brand-new Runtime) and drive it to idle --
    // if the queue had somehow survived onto the new runtime, this idle
    // would deliver the stranded notification as a phantom turn.
    await h.service.activate(h.sessionId, h.workerId);
    h.bufferOutput.mockClear();
    multi.children[1].pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.bufferOutput.mock.calls.length > 0);
    // Let any (incorrect) continuation of the same handleLoopLine call
    // complete before checking for its absence -- deliverUserTurn/
    // ensureDeliverable resolve via microtasks only for an already-live
    // subprocess, well within this margin.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(multi.children[1].stdinWrites.some((w) => w.includes('timerId=stranded'))).toBe(false);
  });

  it('R4: sendSystemNotification on a dormant (never-activated) worker activates it, and the resulting persisted user-message row carries the notification marker', async () => {
    // Idle eviction made delivery responsible for waking a worker with no
    // live subprocess -- see EmbeddedAgentWorkerService.sendUserMessage's
    // "wakes a worker with no live subprocess instead of rejecting" test
    // above for the sendUserMessage half; this is the sendSystemNotification
    // half (Issue #1574 R4, the seam's activation-on-delivery for a timer/
    // conditional-wakeup target that has been idle-evicted or never activated).
    const h = setup();
    expect(h.fake.captured.length).toBe(0);

    const res = await h.service.sendSystemNotification(h.sessionId, h.workerId, withTimerId('wake-me'));
    expect(res.ok).toBe(true);
    expect(h.fake.captured.length).toBe(1);

    const userMessageLine = appendedLines(h.bufferOutput)
      .map((line) => JSON.parse(line) as { type: string; notification?: { kind: string } })
      .find((event) => event.type === 'user-message' && event.notification !== undefined);
    expect(userMessageLine?.notification).toEqual({ kind: 'internal-timer' });
    expect(h.fake.stdinWrites.some((w) => w.includes('timerId=wake-me'))).toBe(true);
  });

  it('q5 (negative control): human sendUserMessage mid-turn still rejects with TURN_IN_PROGRESS -- it is never queued', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const first = await h.service.sendUserMessage(h.sessionId, h.workerId, 'busy');
    expect(first.ok).toBe(true);

    const second = await h.service.sendUserMessage(h.sessionId, h.workerId, 'also busy');
    expect(second).toEqual({ ok: false, code: 'TURN_IN_PROGRESS', error: 'turn in progress' });

    // Confirm idle doesn't deliver a phantom second turn -- there was
    // nothing queued.
    const stdinWritesBeforeIdle = h.fake.stdinWrites.length;
    h.fake.pushStdout('{"v":1,"type":"state","state":"idle"}\n');
    await waitFor(() => h.worker.activityState === 'idle');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fake.stdinWrites.length).toBe(stdinWritesBeforeIdle);
  });
});

describe('EmbeddedAgentWorkerService — the init command\'s compaction config', () => {
  it('carries the WORKER\'s toggle plus the definition\'s window and threshold', async () => {
    const h = setup({
      definition: buildDefinition({
        contextWindowTokens: 128000,
        compaction: { threshold: 0.7 },
      }),
    });
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.compaction).toEqual({
      auto: true,
      contextWindowTokens: 128000,
      threshold: 0.7,
    });
  });

  it('omits contextWindowTokens and threshold when the definition configures neither', async () => {
    // Absent, not null or 0: the loop reads an absent window as "auto
    // compaction can never fire", which is a different state from any number
    // we could have substituted.
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.compaction).toEqual({ auto: true });
  });

  it('includes contextWindowTokens: 0 (a declared, not merely falsy, value) -- resolveEffectiveContextWindow checks `!== undefined`, not truthiness (#1556)', async () => {
    const h = setup({ definition: buildDefinition({ contextWindowTokens: 0 }) });
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.compaction).toEqual({ auto: true, contextWindowTokens: 0 });
  });

  it('reflects a worker whose toggle is OFF', async () => {
    const h = setup();
    h.worker.autoCompaction = false;
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.compaction.auto).toBe(false);
  });
});

function buildSdkDefinition(): EmbeddedAgentDefinition {
  return {
    id: 'def-sdk',
    name: 'Claude',
    engine: 'claude-sdk',
    provider: { model: 'claude-sonnet-5' },
    isBuiltIn: true,
    createdBy: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('EmbeddedAgentWorkerService — model/reasoningEffort override composition (agent-surface.md Ruling 3, #1554)', () => {
  it('threads a worker-level model override into the openai-api init command, beating the definition default', async () => {
    const h = setup();
    h.worker.model = 'gpt-4o-mini';
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.provider.model).toBe('gpt-4o-mini');
  });

  it('threads a worker-level reasoningEffort override into the openai-api init command as `reasoningEffort`', async () => {
    const h = setup();
    h.worker.reasoningEffort = 'medium';
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.provider.reasoningEffort).toBe('medium');
  });

  it('omits `reasoningEffort` entirely on the openai-api arm when no worker override is set', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('reasoningEffort' in first.provider).toBe(false);
  });

  it('threads a worker-level model override into the claude-sdk init command, beating the definition default', async () => {
    const h = setup({ definition: buildSdkDefinition() });
    h.worker.model = 'claude-opus-5';
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.provider.model).toBe('claude-opus-5');
  });

  it('threads a worker-level reasoningEffort override into the claude-sdk init command as `effort` (different wire key than the openai-api arm)', async () => {
    const h = setup({ definition: buildSdkDefinition() });
    h.worker.reasoningEffort = 'high';
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.provider.effort).toBe('high');
    expect('reasoningEffort' in first.provider).toBe(false);
  });

  it('omits `effort` entirely on the claude-sdk arm when the override value is outside the accepted domain -- a defensive narrow, not a second validation layer (the LOUD reject happens upstream at creation time, #1554 Wave 2b)', async () => {
    const h = setup({ definition: buildSdkDefinition() });
    h.worker.reasoningEffort = 'not-a-real-level';
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect('effort' in first.provider).toBe(false);
  });

  it('live-reads the definition default when no worker override is set -- a definition edit AFTER worker creation is reflected at activation (no copy-at-creation, unlike the context-window override)', async () => {
    const definition = buildDefinition();
    const h = setup({ definition });
    // No worker-level override -- `worker.model` stays `null` (setup's default).
    // Mutate the DEFINITION after the worker was created, before activation.
    if (definition.engine === 'openai-api') {
      definition.provider.model = 'qwen3:72b';
    }
    await h.service.activate(h.sessionId, h.workerId);

    const first = JSON.parse(h.fake.stdinWrites[0]);
    expect(first.provider.model).toBe('qwen3:72b');
  });
});

describe('EmbeddedAgentWorkerService.forwardAutoCompaction', () => {
  it('forwards a set-auto-compaction command to a running subprocess', async () => {
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    const before = h.fake.stdinWrites.length;

    expect(h.service.forwardAutoCompaction(h.workerId, false)).toBe(true);

    expect(JSON.parse(h.fake.stdinWrites[before])).toEqual({
      v: 1,
      type: 'set-auto-compaction',
      enabled: false,
    });
  });

  it('forwards even while a turn is in flight', async () => {
    // Deliberately not gated on turnActive: the loop reads the flag at the
    // turn boundary, so recording it mid-turn is safe -- and gating would
    // silently drop the change for the length of a long turn, which is
    // exactly when a user reaches for the toggle.
    const h = setup();
    await h.service.activate(h.sessionId, h.workerId);
    await h.service.sendUserMessage(h.sessionId, h.workerId, 'a long turn');
    const before = h.fake.stdinWrites.length;

    expect(h.service.forwardAutoCompaction(h.workerId, true)).toBe(true);

    expect(JSON.parse(h.fake.stdinWrites[before])).toEqual({
      v: 1,
      type: 'set-auto-compaction',
      enabled: true,
    });
  });

  it('returns false, without throwing, when there is no running subprocess', async () => {
    // The ordinary pre-activation / post-restart case. The caller has already
    // persisted the durable value and must not surface this as an error.
    const h = setup();
    expect(h.service.forwardAutoCompaction(h.workerId, false)).toBe(false);
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

describe('EmbeddedMessageDeliveryError (Issue #1260 PR-2)', () => {
  it('sets name, message, and code passthrough', () => {
    const err = new EmbeddedMessageDeliveryError('turn in progress', 'TURN_IN_PROGRESS');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmbeddedMessageDeliveryError');
    expect(err.message).toBe('turn in progress');
    expect(err.code).toBe('TURN_IN_PROGRESS');
  });

  it('carries each SendUserMessageResult failure code', () => {
    expect(new EmbeddedMessageDeliveryError('not activated', 'NOT_ACTIVATED').code).toBe('NOT_ACTIVATED');
    expect(new EmbeddedMessageDeliveryError('failed to write to subprocess stdin', 'WRITE_FAILED').code).toBe(
      'WRITE_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// Transcript Restore, R1 (#1410)
// ---------------------------------------------------------------------------

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

/** A persisted stream describing one completed turn -- nothing interrupted. */
const COMPLETED_TURN_STREAM = [
  JSON.stringify({ v: 1, type: 'user-message', id: 'm1', text: 'hi there' }),
  JSON.stringify({ v: 1, type: 'assistant-message', turnId: 'm1', text: 'hello back' }),
  JSON.stringify({ v: 1, type: 'state', state: 'idle' }),
].join('\n');

describe('EmbeddedAgentWorkerService — sending `resume` in the init command (R1)', () => {
  it('sends the persisted sdkSessionId on a re-activation of a claude-sdk worker', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect(init.resume).toEqual({ sdkSessionId: 'sess-prev' });
  });

  it('sends no resume on a first-ever activation, even if an id is somehow present', async () => {
    // `everActivated: false` is the structural gate. Reading a stale id on a
    // first-ever activation would be a bug wearing a recovery's clothes.
    const h = setup({ definition: SDK_DEFINITION, everActivated: false, sdkSessionId: 'sess-stale' });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect('resume' in init).toBe(false);
  });

  it('sends no resume when the worker has no persisted sdkSessionId', async () => {
    // A LEGITIMATE state, not a fault: `sdk-session-id` does not arrive until
    // the first turn, so a worker activated but never spoken to has none.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect('resume' in init).toBe(false);
  });

  it('never sends a resume on an openai-api worker, even with an id persisted', async () => {
    // R2 owns that engine's restore path; this one must not touch it.
    const h = setup({
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect(init.engine).toBe('openai-api');
    expect('resume' in init).toBe(false);
  });
});

/**
 * Issue #1419: the seed the server extracts from the persisted log and sends
 * on the `init` command, so the subprocess's restore-boundary compaction
 * check is decided by a MEASUREMENT rather than by re-estimating the
 * reconstructed text.
 *
 * MEASURED REACH (mutation, run -- not predicted):
 *
 *   m12  drop `restoredUsage = outcome.usageSeed;` in the restore branch
 *        -> 2 fail: the two cases that expect a seed on the wire. All three
 *           absence cases correctly survive -- never assigning is exactly
 *           what they assert -- including the claude-sdk one, whose
 *           containment is measured by m13 instead.
 *   m13  move `...(restoredUsage !== undefined ? { restoredUsage } : {})`
 *        from the openai-api arm up into `initCommandShared`
 *        -> 1 fails: 'never sends a seed on a claude-sdk worker'. That is
 *           the only test that sees the arm containment, and without it the
 *           field would silently reach an engine that has no use for it.
 */
describe('EmbeddedAgentWorkerService — sending `restoredUsage` in the init command (#1419)', () => {
  const streamWith = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');
  const COMPLETED_TURN = [
    { v: 1, type: 'user-message', id: 'm1', text: 'hi there' },
    { v: 1, type: 'assistant-message', turnId: 't1', text: 'hello back' },
    { v: 1, type: 'state', state: 'idle' },
  ];

  it('sends the last real context-usage from the log', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: {
        data: streamWith(...COMPLETED_TURN, { v: 1, type: 'context-usage', promptTokens: 6722, estimated: false }),
      },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect(init.restoredUsage).toEqual({ promptTokens: 6722, estimated: false });
  });

  it('never sends a reading from before the last compaction boundary', async () => {
    // The pre-boundary 90000 measures a conversation that compaction then
    // discarded. Sending it would tell the subprocess the restored
    // conversation is 33x its real size and fire a compaction on nothing.
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: {
        data: streamWith(
          ...COMPLETED_TURN,
          { v: 1, type: 'context-usage', promptTokens: 90000, estimated: false },
          { v: 1, type: 'context-compacted', source: 'auto', summary: 'earlier work', postTokens: 2700 },
        ),
      },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect(init.restoredUsage).toEqual({ promptTokens: 2700, estimated: true });
  });

  it('sends no seed when the log holds no reading at all', async () => {
    // A worker killed before completing any turn. The subprocess falls back
    // to the estimator, and this is the boundary the AC requires to keep
    // working.
    const h = setup({ everActivated: true, readHistoryWithOffsetResult: { data: streamWith(...COMPLETED_TURN) } });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect('restoredUsage' in init).toBe(false);
  });

  it('sends no seed on a first-ever activation, which has nothing to restore', async () => {
    const h = setup({ everActivated: false });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect('restoredUsage' in init).toBe(false);
  });

  it('never sends a seed on a claude-sdk worker, even with a reading in the log', async () => {
    // That engine carries its own context state through the SDK resume and
    // computes no ratio of its own, so the field is not representable on its
    // arm -- and a server that sent one anyway would be rejected by the
    // subprocess's own schema at init, killing the worker.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: {
        data: streamWith(...COMPLETED_TURN, { v: 1, type: 'context-usage', promptTokens: 6722, estimated: false }),
      },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const init = JSON.parse(h.fake.stdinWrites[0]);
    expect(init.engine).toBe('claude-sdk');
    expect('restoredUsage' in init).toBe(false);
  });
});

describe('EmbeddedAgentWorkerService — restore-info.sdkResumed (R1)', () => {
  it('reports sdkResumed true for a claude-sdk re-activation that asked to resume', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(true);
  });

  it('reports sdkResumed false for a claude-sdk re-activation with no id to resume', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(false);
  });

  it('OMITS sdkResumed entirely for an openai-api worker', async () => {
    // The three-valued contract's whole point: absent means "this engine has
    // no such concept", and `false` would read as a failure that never
    // happened -- putting a permanent divergence notice on every worker of
    // the other engine.
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const info = h.service.getRestoreInfo(h.workerId);
    expect(info).not.toBeNull();
    expect('sdkResumed' in (info as object)).toBe(false);
  });
});

describe('EmbeddedAgentWorkerService — restore-info FAILURE form sdkResumed (#1449)', () => {
  it('reports sdkResumed true (optimistic) on a claude-sdk restore failure with a persisted session id', async () => {
    // MUTATION MEASURED: dropping the
    // `...(definition.engine === 'claude-sdk' ? { sdkResumed: resumeId !== null } : {})`
    // spread from the catch-block failure assignment makes this assertion
    // fail with `undefined` !== `true`.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    // R4: default (marker append succeeds) is the PRIMARY path -- R6's
    // persistent declaration is a FALLBACK-only write (see the dedicated
    // R6 describe block below), so it does not fire here even though
    // sdkSessionId survives.
    expect(h.service.getRestoreInfo(h.workerId)).toEqual({
      epoch: MARKER_EPOCH,
      failed: true,
      sdkResumed: true,
      preservation: 'in-band',
    });
  });

  it('reports sdkResumed false on a claude-sdk restore failure with no id to resume', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.service.getRestoreInfo(h.workerId)).toEqual({
      epoch: MARKER_EPOCH,
      failed: true,
      sdkResumed: false,
      preservation: 'in-band',
    });
  });
});

describe('EmbeddedAgentWorkerService — R4/R6 preservation state and persistent divergence declaration (#1447 stage 4)', () => {
  it('R4: reports preservation "sidecar" on the FALLBACK path when the sidecar rename succeeds', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
      appendRestoreFailureMarkerThrows: true,
    });
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.service.getRestoreInfo(h.workerId)).toEqual({
      epoch: NEW_EPOCH,
      failed: true,
      preservation: 'sidecar',
    });
  });

  it('R4: reports preservation "lost" on the FALLBACK path when the sidecar rename ALSO fails', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
      appendRestoreFailureMarkerThrows: true,
      sidecarRenameSucceeds: false,
    });
    await h.service.activate(h.sessionId, h.workerId);

    expect(h.service.getRestoreInfo(h.workerId)).toEqual({
      epoch: NEW_EPOCH,
      failed: true,
      preservation: 'lost',
    });
  });

  it('R6: writes the persistent restore-failure-declaration line for a claude-sdk worker whose sdkSessionId survives the fallback reset', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
      appendRestoreFailureMarkerThrows: true,
    });
    await h.service.activate(h.sessionId, h.workerId);

    const declarationLine = JSON.stringify({ v: 1, type: 'restore-failure-declaration' });
    const [, , , resetOpts] = h.resetWorkerOutput.mock.calls[0] as [
      string,
      string,
      unknown,
      { persistentMarkerLine?: string },
    ];
    expect(resetOpts.persistentMarkerLine).toBe(declarationLine);
    // The fresh live file's sole content is the declaration line, so the
    // worker's post-reset offset must reflect its byte length, not 0 --
    // otherwise the next `output`/`history` message would misreport the
    // stream's true length.
    expect(h.worker.outputOffset).toBe(Buffer.byteLength(`${declarationLine}\n`, 'utf-8'));
  });

  it('R6: writes NO persistent declaration when the claude-sdk worker has no persisted sdkSessionId (nothing survives to declare)', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
      appendRestoreFailureMarkerThrows: true,
    });
    await h.service.activate(h.sessionId, h.workerId);

    const [, , , resetOpts] = h.resetWorkerOutput.mock.calls[0] as [
      string,
      string,
      unknown,
      { persistentMarkerLine?: string },
    ];
    expect(resetOpts.persistentMarkerLine).toBeUndefined();
    expect(h.worker.outputOffset).toBe(0);
  });

  it('R6: writes NO persistent declaration for an openai-api worker even with a leftover sdkSessionId field (engine-gated, not field-gated)', async () => {
    // openai-api never legitimately carries a persisted sdkSessionId, but
    // the gate is written as an explicit engine check (not merely "field is
    // non-null") precisely so this can never accidentally fire for the
    // wrong engine.
    const h = setup({
      everActivated: true,
      sdkSessionId: 'stray-value',
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
      appendRestoreFailureMarkerThrows: true,
    });
    await h.service.activate(h.sessionId, h.workerId);

    const [, , , resetOpts] = h.resetWorkerOutput.mock.calls[0] as [
      string,
      string,
      unknown,
      { persistentMarkerLine?: string },
    ];
    expect(resetOpts.persistentMarkerLine).toBeUndefined();
    expect(h.worker.outputOffset).toBe(0);
  });
});

describe('EmbeddedAgentWorkerService — sdk-resume-failed handling (R1)', () => {
  function sdkResumeFailed(reason: SdkResumeFailureReason, id = 'sess-prev'): string {
    return `${JSON.stringify({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: id, reason })}\n`;
  }

  it('clears the persisted sdkSessionId on `refused`, so a REFUSED id is never retried', async () => {
    // The surviving half of an invariant that used to read "there is never a
    // second resume attempt, on any path". Its justification was always a
    // property of refusal specifically -- offering the id again repeats the
    // damage, because a refused resume costs the turn in flight and kills the
    // query. That reasoning never covered `not-found`, so the invariant
    // narrowed, and this is the case where it still binds.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.setOnKill(() => h.fake.simulateExit(137));

    h.fake.pushStdout(sdkResumeFailed('refused'));
    await waitFor(() => h.worker.sdkSessionId === null);

    expect(h.worker.sdkSessionId).toBeNull();
  });

  it('KEEPS the persisted sdkSessionId on `not-found`, so a transient absence is recoverable', async () => {
    // The production-reachable half of this change, and the one that fixes
    // the reported symptom. Every filesystem fault measured against the real
    // SDK -- EACCES on the session file, on its project directory, or on
    // `~/.claude`; EISDIR; ENOTDIR; malformed JSON; a missing or unset HOME
    // -- arrives HERE as `not-found`, because the SDK's store swallows read
    // errors and reports "no session". Clearing on that turned a transient
    // filesystem state into a permanently discarded conversation.
    //
    // Polarity measured by mutation: restoring the unconditional clear fails
    // this with `null !== 'sess-prev'`.
    //
    // The `waitFor` is keyed on `sdkResumed`, which `handleResumeFailed`
    // flips BEFORE it would reach the clear -- so the id is read only after
    // the handler has demonstrably run past that point. A fixed sleep would
    // let a slow handler pass without ever getting there.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.persistSession.mockClear();

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);

    expect(h.worker.sdkSessionId).toBe('sess-prev');
    // Nothing durable changed, so nothing is written back.
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  it('corrects restore-info to sdkResumed false', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(true);

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);

    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(false);
  });

  it('does NOT clobber a fresh session id that already replaced the failed one', async () => {
    // Retargeted from `not-found` to `refused` when the clear narrowed: this
    // guard only has a subject on the branch that actually clears, and after
    // the narrowing that is `refused` alone. Left on `not-found` it would
    // have kept passing while pinning nothing, since nothing clears there any
    // more -- an assertion true for a reason unrelated to its own name.
    //
    // Belt for a future SDK rather than a path production reaches today: a
    // refused resume produces no `system:init`, so no `sdk-session-id`
    // arrives before the refusal. If one ever did, clearing unconditionally
    // would throw away a live session and guarantee the NEXT activation is
    // fresh too.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.setOnKill(() => h.fake.simulateExit(137));

    h.fake.pushStdout('{"v":1,"type":"sdk-session-id","sdkSessionId":"sess-fresh"}\n');
    await waitFor(() => h.worker.sdkSessionId === 'sess-fresh');
    h.fake.pushStdout(sdkResumeFailed('refused'));
    await new Promise((r) => setTimeout(r, 60));

    expect(h.worker.sdkSessionId).toBe('sess-fresh');
  });

  it('lets the fresh session SUPERSEDE a kept id at its first sdk-session-id', async () => {
    // What clears a kept id now that no branch does it eagerly, and the
    // accepted residual stated as an executable fact: if the user speaks
    // before the worker recovers, the fresh session reports its own id, that
    // id wins last-write-wins, and the original session is gone for good.
    //
    // Pinned rather than merely tolerated, because keeping the id is only
    // safe if this still happens -- without supersession a worker would
    // re-offer a stale id forever while a live session it never recorded
    // accumulated the real conversation.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);
    expect(h.worker.sdkSessionId).toBe('sess-prev');

    h.fake.pushStdout('{"v":1,"type":"sdk-session-id","sdkSessionId":"sess-fresh"}\n');
    await waitFor(() => h.worker.sdkSessionId === 'sess-fresh');

    expect(h.worker.sdkSessionId).toBe('sess-fresh');
    expect(h.persistSession).toHaveBeenCalled();
  });

  it('does NOT replace the incarnation on `not-found` (nothing is broken)', async () => {
    // The pre-flight caught it before a resume was attempted, so the
    // subprocess is healthy and mid-activation. Replacing it would throw away
    // a working incarnation.
    //
    // The kill handler and the short escalation windows are load-bearing, and
    // were added after MEASURING that this test had no reach without them.
    // As originally written -- default windows, no `setOnKill`, a 40 ms wait
    // -- deleting `handleResumeFailed`'s entire `not-found` early return left
    // the whole suite green: a replacement WAS started, but `deactivate`
    // stalls on a fake child that never exits, so the re-spawn lands well
    // after the assertion. The assertion was satisfied by the stall, not by
    // the branch it names.
    //
    // The `refused` test below is the positive control for the window: with
    // these identical seams it observes its replacement spawn.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.setOnKill(() => h.fake.simulateExit(137));
    const spawnsBefore = h.fake.captured.length;

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);
    await new Promise((r) => setTimeout(r, 300));

    expect(h.fake.captured.length).toBe(spawnsBefore);
  });

  it('replaces the incarnation on `refused`, because the SDK query is dead but the harness is not', async () => {
    // This is #1414's exact shape: a dead query inside a live harness
    // produces no exit the server can observe, so the worker would be
    // permanently wedged. The replacement goes through `deactivate`, a path
    // the exit observer covers.
    // Short grace/SIGTERM windows: the fake child never exits on its own, so
    // `deactivate` walks its full escalation before the re-activation runs.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    // The fake child only exits when told to; deactivate escalates to a
    // signal, so that is where it exits.
    h.fake.setOnKill(() => h.fake.simulateExit(137));
    const spawnsBefore = h.fake.captured.length;

    h.fake.pushStdout(sdkResumeFailed('refused'));
    await waitFor(() => h.fake.captured.length > spawnsBefore, 3000);

    expect(h.fake.captured.length).toBe(spawnsBefore + 1);
    // The replacement must not carry the id that just failed.
    const reinit = JSON.parse(h.fake.stdinWrites[h.fake.stdinWrites.length - 1]);
    expect('resume' in reinit).toBe(false);
  });

  it('runs the recovery once even when the refusal is reported twice', async () => {
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.setOnKill(() => h.fake.simulateExit(137));
    const spawnsBefore = h.fake.captured.length;

    h.fake.pushStdout(sdkResumeFailed('refused'));
    h.fake.pushStdout(sdkResumeFailed('refused'));
    await waitFor(() => h.fake.captured.length > spawnsBefore, 3000);
    await new Promise((r) => setTimeout(r, 60));

    // A second recovery would deactivate the replacement this one just made.
    expect(h.fake.captured.length).toBe(spawnsBefore + 1);
  });

  it('KEEPS the persisted sdkSessionId on `lookup-failed`, because nothing was learned about the session', async () => {
    // The same branch as `not-found`, pinned separately because the reason
    // is what the server is handed and a future change could split them
    // again. Measured note for the next reader: this reason is currently
    // UNREACHABLE in production -- SDK 0.3.238 reports every store-level
    // fault as `undefined`, never a throw (see PS7's table in
    // docs/design/embedded-agent-sdk-engine.md). It is pinned as the shape
    // for a version that does propagate the error, not as live traffic.
    //
    // Polarity measured by mutation: narrowing `handleResumeFailed`'s guard
    // from `reason !== 'refused'` back to `reason === 'refused'`-only-clears
    // -- i.e. restoring the unconditional clear -- fails this with
    // `null !== 'sess-prev'`. Verified by running the mutation, not by
    // reading the code.
    //
    // The assertion is NOT satisfiable by a mechanism other than the branch:
    // `waitFor` below is keyed on `sdkResumed` flipping to false, which the
    // shared prologue of `handleResumeFailed` does BEFORE the branch runs.
    // So by the time the id is read, the handler has demonstrably executed
    // past the point where the old code would have nulled it. Sequencing the
    // wait on a timeout instead would let a slow handler pass this test
    // without ever reaching the branch.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.persistSession.mockClear();

    h.fake.pushStdout(sdkResumeFailed('lookup-failed'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);

    expect(h.worker.sdkSessionId).toBe('sess-prev');
    // No durable state changed, so nothing is written back. A persist here
    // would be harmless but would record, in the store's own history, a
    // decision this route deliberately does not make.
    expect(h.persistSession).not.toHaveBeenCalled();
  });

  it('still reports sdkResumed false on `lookup-failed` -- this incarnation did not resume', async () => {
    // §4.3's widened definition: `false` means "this incarnation's SDK
    // session did not resume", not "a resume was attempted and refused".
    // Keeping the id does not make the transcript agree with the model NOW,
    // so the notice is correct here and suppressing it would be the lie.
    //
    // Polarity measured by mutation: moving the keep-the-id early return
    // ABOVE `markResumeNotResumed` fails this test. It also fails the other
    // three `lookup-failed` tests, which all key their `waitFor` on the same
    // flag -- so the ordering is pinned by the group, not by this test alone.
    // Recorded because the first draft of this comment claimed exclusivity
    // and the measurement said otherwise; the reach a pin actually has is
    // what the next reader inherits.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(true);

    h.fake.pushStdout(sdkResumeFailed('lookup-failed'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);

    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(false);
  });

  it('does NOT replace the incarnation on `lookup-failed` (nothing died)', async () => {
    // Same reasoning as `not-found`: the subprocess decided before attempting
    // a resume, so the harness and its query are both healthy. Only `refused`
    // leaves a dead query inside a live harness.
    //
    // The kill handler and the short escalation windows are what give this
    // pin its reach, and they were added AFTER measuring that it had none.
    // First draft: default windows, no `setOnKill`, a 40 ms wait -- and it
    // passed with the keep-the-id branch deleted, because a replacement
    // WOULD have been started but `deactivate` stalls on a fake child that
    // never exits, so no re-spawn lands inside 40 ms. The assertion was true
    // for a reason unrelated to the branch it names.
    //
    // With this setup the same mutation fails it. The positive control that
    // the window is long enough lives in this same describe: the `refused`
    // test uses the identical seams and observes its replacement spawn.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    h.fake.setOnKill(() => h.fake.simulateExit(137));
    const spawnsBefore = h.fake.captured.length;

    h.fake.pushStdout(sdkResumeFailed('lookup-failed'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);
    await new Promise((r) => setTimeout(r, 300));

    expect(h.fake.captured.length).toBe(spawnsBefore);
  });

  it('recovers: after `not-found` the NEXT activation re-offers the same id and asks for a resume', async () => {
    // The recovery path itself, end to end at this layer -- not merely "the
    // id was not cleared", which is also true of a worker that never had one.
    // This drives the whole loop: a real activation carrying the id, a
    // `not-found`, a teardown, and a second real activation whose init is
    // read for what it actually asks the subprocess to do.
    //
    // The half this layer cannot own is the pre-flight's verdict on the
    // retry -- that runs in the subprocess, and `main.test.ts`'s "forwards
    // the resume id to the engine when the pre-flight finds the session"
    // pins it. Together they are the transient-failure recovery: the store
    // becomes readable again, the same id is offered again, and it resumes.
    //
    // Polarity measured by mutation: restoring the unconditional clear makes
    // the second init carry no `resume` key at all, failing both assertions
    // below. `lookup-failed` takes the identical branch and is pinned for
    // id-retention separately; it is not re-driven here, because the branch
    // being exercised is the same one.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    const firstInit = JSON.parse(h.fake.stdinWrites[0]);
    expect(firstInit.resume).toEqual({ sdkSessionId: 'sess-prev' });

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);

    h.fake.setOnKill(() => h.fake.simulateExit(137));
    await h.service.deactivate(h.sessionId, h.workerId);
    const writesBefore = h.fake.stdinWrites.length;
    await h.service.activate(h.sessionId, h.workerId);
    await waitFor(() => h.fake.stdinWrites.length > writesBefore);

    const reinit = JSON.parse(h.fake.stdinWrites[writesBefore]);
    expect(reinit.type).toBe('init');
    expect(reinit.resume).toEqual({ sdkSessionId: 'sess-prev' });
    // The server's own claim about the retry, which is what drives the UI:
    // it is asking for a resume again, so the notice is not pre-emptively
    // shown. It would be corrected downward again if this attempt also fails.
    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(true);
  });

  it('#1449: corrects a FAILED restore-info to sdkResumed false (D2 -> Loss correction reaches the failure form too)', async () => {
    // Reuses `markResumeNotResumed`'s SAME existing recovery path -- no new
    // logic was added for the failure case. `resume` is still sent on init
    // (gated on `resumeId !== null`, independent of restore success/failure),
    // so a real `sdk-resume-failed` can arrive on top of a failed restore.
    //
    // MUTATION MEASURED: adding a `runtime.restoreInfo.failed === true`
    // early-return to `markResumeNotResumed` (simulating "the correction was
    // accidentally special-cased to success only") makes the `waitFor` below
    // time out -- confirming this test actually exercises the correction
    // reaching a FAILED restore-info, not just a success one.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);
    // R4: default (marker append succeeds) is the PRIMARY path.
    expect(h.service.getRestoreInfo(h.workerId)).toEqual({
      epoch: MARKER_EPOCH,
      failed: true,
      sdkResumed: true,
      preservation: 'in-band',
    });

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);

    const correctionPush = h.recorder.onRestoreInfo.mock.calls.at(-1)?.[0];
    expect(correctionPush).toEqual({ failed: true, sdkResumed: false, preservation: 'in-band' });
    expect(h.service.getRestoreInfo(h.workerId)).toEqual({
      epoch: MARKER_EPOCH,
      failed: true,
      sdkResumed: false,
      preservation: 'in-band',
    });
  });

  it('#1449 monotonicity: sdkResumed on a FAILED restore-info never moves back from false, across a second AND third correction attempt', async () => {
    // Architect ruling (post-brief addendum): a `claude-sdk` restore failure
    // where the SDK resume ALSO fails collapses to Loss, not D2. This is
    // what makes that collapse durable client-side -- once the server has
    // corrected `sdkResumed` to `false`, nothing may write it back to `true`
    // (or to any other value) within the same incarnation. Structural
    // confirmation (read, not assumed): the only two `sdkResumed` writers in
    // `embedded-agent-worker-service.ts` are (a) construction, `sdkResumed:
    // resumeId !== null`, in BOTH the success and failure branches of
    // `runActivation`'s restore attempt, and (b) `markResumeNotResumed`'s
    // `{ ...runtime.restoreInfo, sdkResumed: false }` spread, itself guarded
    // by `runtime.restoreInfo.sdkResumed === false` short-circuiting to a
    // no-op. No third site assigns the field.
    //
    // MUTATION MEASURED: temporarily adding a hypothetical reverse-write
    // path -- `runtime.restoreInfo = { ...runtime.restoreInfo, sdkResumed:
    // true }` immediately after the `markResumeNotResumed` correction inside
    // this same test file, simulating a stray future write -- makes the
    // second/third-call assertions below fail (`sdkResumed` observed `true`
    // instead of the required `false`). Reverting the stray write restores
    // green. This confirms the assertions below actually exercise the
    // monotonicity property rather than a coincidentally-stable value.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: RESTORE_FAILING_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);
    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(true);

    h.fake.pushStdout(sdkResumeFailed('not-found'));
    await waitFor(() => h.service.getRestoreInfo(h.workerId)?.sdkResumed === false);
    const pushesAfterFirstCorrection = h.recorder.onRestoreInfo.mock.calls.length;

    // A second `sdk-resume-failed` (any reason) is a no-op at the
    // `resumeRecoveryStarted` guard in `handleResumeFailed` -- it never even
    // reaches `markResumeNotResumed` a second time. What matters for THIS
    // pin is the observable outcome, not which specific guard produced it:
    // no further push, and the value stays exactly `false`, never reverting
    // toward the construction-time optimistic value.
    h.fake.pushStdout(sdkResumeFailed('not-found', 'sess-prev'));
    await new Promise((r) => setTimeout(r, 60));
    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(false);
    expect(h.recorder.onRestoreInfo.mock.calls.length).toBe(pushesAfterFirstCorrection);

    // A third, distinct reason -- still no reverting write, still false.
    h.fake.pushStdout(sdkResumeFailed('lookup-failed', 'sess-prev'));
    await new Promise((r) => setTimeout(r, 60));
    expect(h.service.getRestoreInfo(h.workerId)?.sdkResumed).toBe(false);
    expect(h.recorder.onRestoreInfo.mock.calls.length).toBe(pushesAfterFirstCorrection);
  });
});

describe('EmbeddedAgentWorkerService — turn-interrupted marker (R1, local half of #1273)', () => {
  const INTERRUPTED_STREAM = [
    JSON.stringify({ v: 1, type: 'user-message', id: 'm1', text: 'hi there' }),
    JSON.stringify({ v: 1, type: 'assistant-message', turnId: 'm1', text: 'hello back' }),
    JSON.stringify({ v: 1, type: 'state', state: 'idle' }),
    JSON.stringify({ v: 1, type: 'user-message', id: 'm2', text: 'and this one died' }),
    JSON.stringify({ v: 1, type: 'state', state: 'active' }),
  ].join('\n');

  it('appends a turn-interrupted row for the turn the previous incarnation never answered', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: INTERRUPTED_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const appended = h.bufferOutput.mock.calls.map((c) => String(c[2]));
    const marker = appended.find((line) => line.includes('"turn-interrupted"'));
    expect(marker).toBeDefined();
    expect(JSON.parse(marker as string)).toEqual({ v: 1, type: 'turn-interrupted', turnId: 'm2' });
  });

  it('appends nothing when the last turn completed', async () => {
    const h = setup({
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const appended = h.bufferOutput.mock.calls.map((c) => String(c[2]));
    expect(appended.some((line) => line.includes('"turn-interrupted"'))).toBe(false);
  });

  it('appends nothing on a first-ever activation', async () => {
    // Vacuous by construction: there is no prior stream to have been
    // interrupted, and the restore branch that detects it never runs.
    const h = setup({ everActivated: false });
    await h.service.activate(h.sessionId, h.workerId);

    const appended = h.bufferOutput.mock.calls.map((c) => String(c[2]));
    expect(appended.some((line) => line.includes('"turn-interrupted"'))).toBe(false);
  });

  it('fires for both engines', async () => {
    // Detection reads the persisted stream, so it is engine-independent by
    // construction -- asserted rather than assumed, since the rest of R1 is
    // claude-sdk-only and a reader could reasonably expect this to be too.
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: INTERRUPTED_STREAM },
    });
    await h.service.activate(h.sessionId, h.workerId);

    const appended = h.bufferOutput.mock.calls.map((c) => String(c[2]));
    expect(appended.some((line) => line.includes('"turn-interrupted"'))).toBe(true);
  });
});

/**
 * #1414: an engine `fatal` that leaves the harness process alive.
 *
 * The shared `makeFakeSpawn` above hands out ONE child for every spawn, which
 * is enough for the refused-resume tests (they only count spawns) but not for
 * these: the crash-loop bound is about the REPLACEMENT incarnation fataling
 * too, so each spawn needs its own stdout to push a second `fatal` into. This
 * local fake is that, and nothing else -- same shapes, one child per spawn.
 */
interface FakeChild {
  stdinWrites: string[];
  killSignals: number[];
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
  simulateExit: (code: number) => void;
  setOnKill: (fn: (signal: number) => void) => void;
}

interface MultiChildFakeSpawn {
  fn: SpawnAsUserFn;
  children: FakeChild[];
}

function makeMultiChildFakeSpawn(): MultiChildFakeSpawn {
  const children: FakeChild[] = [];
  const fn: SpawnAsUserFn = () => {
    const stdout = makeControllableStream();
    const stderr = makeControllableStream();
    const stdinWrites: string[] = [];
    const killSignals: number[] = [];
    let onKill: ((signal: number) => void) | undefined;
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
      flush: () => 0,
    };
    const subprocess: FakeSubprocess = {
      pid: 5000 + children.length,
      exited,
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      kill: (signal) => {
        killSignals.push(signal ?? 15);
        onKill?.(signal ?? 15);
      },
    };
    children.push({
      stdinWrites,
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
    });
    const result: Pick<SpawnAsUserResult, 'elevated'> & { subprocess: FakeSubprocess; stdin: FakeFileSink } = {
      subprocess,
      stdin,
      elevated: false,
    };
    return result as SpawnAsUserResult;
  };
  return { fn, children };
}

const FATAL_LINE = `${JSON.stringify({
  v: 1,
  type: 'fatal',
  message: 'SDK transport error: Claude Code process terminated by signal SIGKILL',
})}\n`;

const IDLE_LINE = `${JSON.stringify({ v: 1, type: 'state', state: 'idle' })}\n`;

describe('EmbeddedAgentWorkerService — fatalLeavesHarnessAlive (#1414)', () => {
  it('routes claude-sdk, because its engine dies inside a harness that keeps running', () => {
    expect(fatalLeavesHarnessAlive('claude-sdk')).toBe(true);
  });

  it('does NOT route openai-api, whose every fatal takes the harness down with it', () => {
    expect(fatalLeavesHarnessAlive('openai-api')).toBe(false);
  });
});

describe('EmbeddedAgentWorkerService — isEvictableEngine (#1502)', () => {
  it('is evictable for claude-sdk', () => {
    expect(isEvictableEngine('claude-sdk')).toBe(true);
  });

  it('is evictable for openai-api', () => {
    expect(isEvictableEngine('openai-api')).toBe(true);
  });
});

describe('EmbeddedAgentWorkerService — fatal incarnation replacement (#1414)', () => {
  /**
   * The whole fix in one arrangement: a live claude-sdk worker whose child
   * only exits when signalled, so `deactivate` has to walk its escalation --
   * which is also what would deadlock if the replacement were awaited from
   * inside the stdout reader.
   */
  function setupFatal(opts?: { sdkSessionId?: string }) {
    const fake = makeMultiChildFakeSpawn();
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      spawnAsUserFnOverride: fake.fn,
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
      ...(opts?.sdkSessionId !== undefined ? { sdkSessionId: opts.sdkSessionId } : {}),
    });
    return { h, fake };
  }

  it('replaces the incarnation, so a worker whose engine died alone comes back', async () => {
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    fake.children[0].pushStdout(FATAL_LINE);
    await waitFor(() => fake.children.length === 2, 3000);

    expect(fake.children.length).toBe(2);
    expect(h.worker.subprocess).not.toBeNull();
  });

  it('clears turnActive THROUGH the exit observer, so the next message is admitted', async () => {
    // The Issue's symptom, stated as a test: with a turn admitted and the
    // engine dead, every later message was refused with TURN_IN_PROGRESS
    // forever. Nothing here clears `turnActive` directly -- the replacement
    // reaches the observer, which is the existing writer.
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    const admitted = await h.service.sendUserMessage(h.sessionId, h.workerId, 'first message after the SDK died');
    expect(admitted.ok).toBe(true);

    fake.children[0].pushStdout(FATAL_LINE);
    await waitFor(() => fake.children.length === 2, 3000);

    const afterRecovery = await h.service.sendUserMessage(h.sessionId, h.workerId, 'second message after the SDK died');
    expect(afterRecovery.ok).toBe(true);
  });

  it('revokes the MCP token, the other obligation the unobserved exit stranded', async () => {
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));
    expect(h.revokeByWorker).not.toHaveBeenCalled();

    fake.children[0].pushStdout(FATAL_LINE);
    await waitFor(() => fake.children.length === 2, 3000);

    expect(h.revokeByWorker).toHaveBeenCalled();
  });

  it('appends the server-authored exited row the unobserved death never produced', async () => {
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    fake.children[0].pushStdout(FATAL_LINE);
    await waitFor(() => fake.children.length === 2, 3000);

    const appended = appendedLines(h.bufferOutput);
    expect(appended.some((line) => line.includes('"exited"'))).toBe(true);
  });

  it('does NOT synthesize a turn-error, which would close the turn turn-interrupted describes', async () => {
    // findInterruptedTurnId's terminal set includes `turn-error`, so a
    // server-authored one here would make the marker structurally unreachable
    // for the very turn it is about. R1 made the same call for the same reason.
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    fake.children[0].pushStdout(FATAL_LINE);
    await waitFor(() => fake.children.length === 2, 3000);

    const appended = appendedLines(h.bufferOutput);
    expect(appended.some((line) => line.includes('"turn-error"'))).toBe(false);
  });

  it('runs one replacement even when the engine reports the death twice', async () => {
    // The engine reports it from the transport throw, and again from every
    // later `runTurn`. A second replacement would deactivate the incarnation
    // the first one just started.
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    fake.children[0].pushStdout(FATAL_LINE);
    fake.children[0].pushStdout(FATAL_LINE);
    await waitFor(() => fake.children.length === 2, 3000);
    await new Promise((r) => setTimeout(r, 80));

    expect(fake.children.length).toBe(2);
  });
});

describe('EmbeddedAgentWorkerService — fatal crash-loop bound (#1414)', () => {
  function setupFatal() {
    const fake = makeMultiChildFakeSpawn();
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      spawnAsUserFnOverride: fake.fn,
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    return { h, fake };
  }

  /** Drive a fatal on the newest child and wait for the chain to settle. */
  async function fatalOn(fake: MultiChildFakeSpawn, index: number, expectSpawns: number | null): Promise<void> {
    fake.children[index].setOnKill(() => fake.children[index].simulateExit(137));
    fake.children[index].pushStdout(FATAL_LINE);
    if (expectSpawns !== null) {
      await waitFor(() => fake.children.length === expectSpawns, 3000);
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  it('stops after ONE replacement when the cause is persistent', async () => {
    // An infinite respawn is worse than the brick. The second fatal in a
    // chain gets the teardown but not the replacement.
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);

    await fatalOn(fake, 0, 2);
    expect(fake.children.length).toBe(2);

    await fatalOn(fake, 1, null);

    expect(fake.children.length).toBe(2);
  });

  it('leaves the worker VISIBLY exited once the bound is reached', async () => {
    // "Stop replacing" must not mean "stop collecting". Skipping the teardown
    // at the bound would leave the worker in this Issue's own
    // dead-but-unobserved state, permanently.
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);

    await fatalOn(fake, 0, 2);
    await fatalOn(fake, 1, null);

    expect(h.worker.subprocess).toBeNull();
    expect(h.worker.activityState).toBe('idle');
    expect(h.globalExit).toHaveBeenCalled();
  });

  it('resets the chain on a completed turn, so a later unrelated fatal is replaced again', async () => {
    const { h, fake } = setupFatal();
    await h.service.activate(h.sessionId, h.workerId);

    await fatalOn(fake, 0, 2);
    expect(fake.children.length).toBe(2);

    // The replacement round-trips a turn: the chain is over.
    fake.children[1].pushStdout(IDLE_LINE);
    await new Promise((r) => setTimeout(r, 40));

    await fatalOn(fake, 1, 3);

    expect(fake.children.length).toBe(3);
  });
});

describe('EmbeddedAgentWorkerService — fatal routing leaves openai-api alone (#1414)', () => {
  it('does not replace an openai-api incarnation on fatal', async () => {
    // Every openai-api fatal is a construction failure that exits(1) on its
    // own, and "activation failed, stay exited" is the behaviour that engine
    // must keep. The routing is never entered for it -- not merely idempotent.
    const fake = makeMultiChildFakeSpawn();
    const h = setup({ spawnAsUserFnOverride: fake.fn, shutdownGraceMs: 10, sigtermTimeoutMs: 10 });
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    fake.children[0].pushStdout(FATAL_LINE);
    await new Promise((r) => setTimeout(r, 80));

    expect(fake.children.length).toBe(1);
    expect(fake.children[0].killSignals.length).toBe(0);
  });

  it('still lets the exit observer collect the openai-api fatal alone', async () => {
    const fake = makeMultiChildFakeSpawn();
    const h = setup({ spawnAsUserFnOverride: fake.fn, shutdownGraceMs: 10, sigtermTimeoutMs: 10 });
    await h.service.activate(h.sessionId, h.workerId);

    fake.children[0].pushStdout(FATAL_LINE);
    fake.children[0].simulateExit(1);
    await waitFor(() => h.worker.subprocess === null, 3000);

    expect(h.revokeByWorker).toHaveBeenCalledTimes(1);
    expect(h.globalExit).toHaveBeenCalledTimes(1);
    expect(fake.children.length).toBe(1);
  });
});

describe('EmbeddedAgentWorkerService — fatal racing a natural exit (#1414 Hazard 2)', () => {
  it('collects exactly once when a claude-sdk construction fatal takes the harness down too', async () => {
    // The one remaining case where the harness exits on its own AND the
    // routing fires: `main.ts`'s SDK-engine construction failure emits `fatal`
    // and then returns null, so the process exits underneath the replacement's
    // `deactivate`. The observer must still run once -- no double revoke, no
    // double exit callback -- and the bound still allows the single retry.
    const fake = makeMultiChildFakeSpawn();
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      spawnAsUserFnOverride: fake.fn,
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);

    // fatal and the natural exit arrive together, as construction failure does.
    fake.children[0].pushStdout(FATAL_LINE);
    fake.children[0].simulateExit(1);
    await waitFor(() => fake.children.length === 2, 3000);
    await new Promise((r) => setTimeout(r, 80));

    expect(fake.children.length).toBe(2);
    // One collection for the dead incarnation; the replacement is still live.
    expect(h.revokeByWorker).toHaveBeenCalledTimes(1);
    expect(h.globalExit).toHaveBeenCalledTimes(1);
    expect(fake.children[0].killSignals.length).toBe(0);
  });
});

describe('EmbeddedAgentWorkerService — fatal during a requested shutdown (#1414)', () => {
  it('does NOT revive a worker somebody deliberately deactivated', async () => {
    // `deactivate`'s escalation can kill the SDK's child before the harness
    // itself goes, and the transport throw beats the exit. Replacing on that
    // fatal would bring back a worker the user (or an eviction policy) just
    // took down. `shutdownRequested` is set synchronously by `deactivate`,
    // so the fatal always lands after it rather than racing it.
    const fake = makeMultiChildFakeSpawn();
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      spawnAsUserFnOverride: fake.fn,
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    // The child emits a fatal on its way out, then exits -- the shape a
    // signalled teardown of a live SDK session produces.
    fake.children[0].setOnKill(() => {
      fake.children[0].pushStdout(FATAL_LINE);
      setTimeout(() => fake.children[0].simulateExit(143), 5);
    });

    await h.service.deactivate(h.sessionId, h.workerId);
    await new Promise((r) => setTimeout(r, 120));

    expect(fake.children.length).toBe(1);
    expect(h.worker.subprocess).toBeNull();
  });
});

describe('EmbeddedAgentWorkerService — a refused resume and a fatal from the same transport error', () => {
  it('replaces the incarnation ONCE when both events arrive together', async () => {
    // `sdk-engine`'s transport-error path calls `reportRefusedResume()` and
    // then `handleFatal()` in sequence, so one dead transport emits BOTH a
    // `sdk-resume-failed` row and a `fatal` row. The two recoveries have
    // independent guards (`resumeRecoveryStarted`, `fatalReplacementStarted`)
    // that know nothing about each other, so what actually prevents a second
    // teardown is `deactivate`'s synchronous prefix setting
    // `shutdownRequested` before the reader reaches the `fatal` line.
    //
    // That protection is a property of statement ordering, and this test is
    // its pin. Its reach was MEASURED rather than assumed, because the first
    // two assertions that looked like they pinned it did not:
    //
    // - Spawn count alone is masked. Remove the guard and the fatal path does
    //   start a second teardown, but `activate`'s in-flight map collapses the
    //   two re-activations back into one spawn, so the count stays 2.
    // - A single `await Promise.resolve()` inserted before the `deactivate`
    //   call does NOT break the contract. Its continuation is queued before
    //   the reader's own, so the guard is still set by the time the `fatal`
    //   line is handled. The ordering tolerates one microtask.
    // - A deferral that outlasts the reader's next line (a timer, or any real
    //   I/O await) DOES break it, and this test fails on it.
    //
    // So the observable that is not masked is the teardown itself: each
    // `deactivate` writes one `shutdown` command, and a second one means the
    // fatal was not absorbed.
    const fake = makeMultiChildFakeSpawn();
    const h = setup({
      definition: SDK_DEFINITION,
      everActivated: true,
      sdkSessionId: 'sess-prev',
      readHistoryWithOffsetResult: { data: COMPLETED_TURN_STREAM },
      spawnAsUserFnOverride: fake.fn,
      shutdownGraceMs: 10,
      sigtermTimeoutMs: 10,
    });
    await h.service.activate(h.sessionId, h.workerId);
    fake.children[0].setOnKill(() => fake.children[0].simulateExit(137));

    // Both rows, in the order the engine emits them.
    fake.children[0].pushStdout(
      `${JSON.stringify({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: 'sess-prev', reason: 'refused' })}\n`,
    );
    fake.children[0].pushStdout(FATAL_LINE);

    await waitFor(() => fake.children.length >= 2, 3000);
    await new Promise((r) => setTimeout(r, 150));

    expect(fake.children.length).toBe(2);
    expect(h.worker.subprocess).not.toBeNull();
    // The spawn count alone does NOT pin the ordering property: with the
    // guard removed the fatal path still starts a second teardown, and
    // `activate`'s in-flight map quietly collapses the two re-activations
    // back into one spawn. The teardown itself is the observable that does
    // not get masked -- each `deactivate` writes one `shutdown` command, so
    // a second one means the fatal was not absorbed.
    const shutdowns = fake.children[0].stdinWrites.filter((w) => w.includes('"shutdown"')).length;
    expect(shutdowns).toBe(1);
  });
});
