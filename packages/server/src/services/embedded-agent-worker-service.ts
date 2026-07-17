/**
 * EmbeddedAgentWorkerService — server-side lifecycle for embedded-agent workers.
 *
 * Combines InteractiveProcessManager's subprocess mechanics (spawnAsUser, a
 * long-lived stdin the caller feeds, concurrent stdout/stderr reads, exit
 * observation ordered AFTER stream completion) with the AgentWorker
 * persistence/output model (epoch/offset append-only stream reused for NDJSON
 * event lines).
 *
 * Spec: docs/design/embedded-agent-worker.md Part II §"Server-side management".
 *
 * This service is a FEEDING spawnAsUser consumer: stdin stays open for the
 * process lifetime (init / user-message / cancel / shutdown commands are fed
 * over time), so the fire-and-forget `stdin.end()` obligation does NOT apply.
 * The drain obligation is satisfied by the stdout / stderr readers, whose
 * completion is tracked via `streamsDone` (never fire-and-forget).
 */
import type { Subprocess, FileSink } from 'bun';
import * as v from 'valibot';
import {
  NdjsonLineSplitter,
  EmbeddedAgentEventSchema,
  type EmbeddedAgentDefinition,
  type EmbeddedAgentCommand,
  type EmbeddedAgentServerEvent,
  type AgentActivityState,
  type ExitReason,
} from '@agent-console/shared';
import type { InternalSession } from './internal-types.js';
import type { InternalEmbeddedAgentWorker } from './worker-types.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import type { McpTokenRegistry } from '../mcp/mcp-auth.js';
import type { WorkerOutputFileManager } from '../lib/worker-output-file.js';
import { spawnAsUser, shellEscape, type SpawnAsUserFn } from './privilege-elevation.js';
import { loadProviderKey } from './provider-key-store.js';
import { createLogger } from '../lib/logger.js';
import * as path from 'node:path';

const logger = createLogger('embedded-agent-worker-service');

/**
 * Resolution result of {@link resolveEmbeddedAgentEntryPath}. `source` reveals
 * which branch was taken so callers (and the real-machine smoke test,
 * `scripts/smoke/check-embedded-agent-elevation.ts`) can assert the
 * deployment-correct branch was actually exercised rather than the dev-only
 * fallback silently "working" because both paths happen to resolve on a dev
 * checkout.
 */
export interface EmbeddedAgentEntryResolution {
  path: string;
  source: 'package' | 'fallback';
}

/**
 * Resolve the absolute path to the embedded-agent subprocess entry.
 *
 * Primary: workspace-package resolution via the package manager's view
 * (`@agent-console/embedded-agent/package.json`, then join `src/main.ts`).
 * This is the deployment-correct mechanism: under a bundled production deploy
 * (`bun dist/index.js`) `import.meta.dir` points into the bundle output, so a
 * relative source-tree path resolves to a nonexistent file — package
 * resolution instead follows the installed dependency edge. `package.json` is
 * the reliable subpath (Bun resolves it even without an `exports` map, unlike
 * arbitrary `src/*` subpaths).
 *
 * Fallback: a source-tree-relative path, used only when the package edge is
 * not yet installed (dev / test before `bun install` wires
 * `@agent-console/embedded-agent` into the server package). CI runs
 * `bun install`, so the primary path is what executes there and in prod.
 *
 * Extracted as a standalone exported function (rather than kept as a private
 * static method on {@link EmbeddedAgentWorkerService}) so the real-machine
 * smoke test can call it independently of constructing the service, and
 * compare its result against the entry path the service will use by default.
 */
export function resolveEmbeddedAgentEntryPath(): EmbeddedAgentEntryResolution {
  try {
    const pkgJson = Bun.resolveSync('@agent-console/embedded-agent/package.json', import.meta.dir);
    return { path: path.join(path.dirname(pkgJson), 'src/main.ts'), source: 'package' };
  } catch {
    return {
      path: path.resolve(import.meta.dir, '../../../embedded-agent/src/main.ts'),
      source: 'fallback',
    };
  }
}

/** Protocol-violation guard: a single NDJSON line larger than this is a crash. */
const MAX_LINE_BYTES = 1024 * 1024;
/** Consecutive parse failures tolerated before the loop is treated as corrupt. */
const MAX_CONSECUTIVE_PARSE_FAILURES = 5;
/** Default per-user-turn tool iteration cap when the definition omits it. */
const DEFAULT_MAX_TOOL_ITERATIONS = 25;
/** Grace after `shutdown` before escalating to SIGTERM. */
const DEFAULT_SHUTDOWN_GRACE_MS = 3000;
/** Grace after SIGTERM before escalating to SIGKILL. */
const DEFAULT_SIGTERM_TIMEOUT_MS = 5000;
/**
 * The event `type` literals this server build recognizes (the loop-authored
 * `EmbeddedAgentEvent` union). A parseable line whose `type` is NOT in this set
 * is treated as a forward-compat version-skew event (skip + log, no strike),
 * distinct from a recognized type that fails its own schema shape (genuine
 * corruption → counts toward the strike counter). Kept in sync with
 * `EmbeddedAgentEvent` in packages/shared.
 */
const KNOWN_EVENT_TYPES = new Set<string>([
  'ready',
  'state',
  'assistant-delta',
  'assistant-thinking-delta',
  'assistant-message',
  'tool-call',
  'tool-result',
  'turn-error',
  'fatal',
]);
/** Cap on the per-chunk stderr text forwarded to the debug logger. */
const STDERR_LOG_CAP = 2048;

/**
 * Marks the small, enumerable set of `runActivation` failure reasons whose
 * `message` is safe to forward to the client verbatim (session/worker/
 * definition lookup failures, missing `createdBy`). Every other failure in
 * `runActivation` (provider key loading, spawn username resolution, process
 * spawn, output reset, persistence) throws a plain `Error` and must NOT be
 * wrapped in this class -- callers use `instanceof` to decide whether
 * `err.message` is client-safe or must be replaced with a generic fallback.
 */
export class EmbeddedAgentActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddedAgentActivationError';
  }
}

/**
 * Result of {@link EmbeddedAgentWorkerService.sendUserMessage}. `code` is the
 * machine-checkable discriminant callers should switch on; `error` is the
 * human-readable string for logging only (its exact wording is NOT a
 * contract -- callers must not string-match it).
 */
export type SendUserMessageResult =
  | { ok: true; id: string }
  | { ok: false; code: 'NOT_ACTIVATED' | 'TURN_IN_PROGRESS' | 'WRITE_FAILED'; error: string };

export interface EmbeddedAgentWorkerServiceDeps {
  getSession: (sessionId: string) => InternalSession | undefined;
  persistSession: (session: InternalSession) => Promise<void>;
  getPathResolver: (session: InternalSession) => SessionDataPathResolver;
  getEmbeddedAgent: (id: string) => EmbeddedAgentDefinition | undefined;
  resolveSpawnUsername: (createdBy?: string) => Promise<string>;
  mcpTokenRegistry: Pick<McpTokenRegistry, 'mint' | 'revokeByWorker'>;
  workerOutputFileManager: Pick<WorkerOutputFileManager, 'resetWorkerOutput' | 'bufferOutput'>;
  /** MCP Streamable-HTTP base URL delivered to the loop in the init message. */
  getMcpBaseUrl: () => string;
  /** Test seam for the provider-key loader. */
  loadProviderKeyFn?: typeof loadProviderKey;
  /** Test seam for the elevated spawn helper. */
  spawnAsUserFn?: SpawnAsUserFn;
  /** Absolute path to the embedded-agent subprocess entry (resolved from the server install root). */
  entryPath?: string;
  getGlobalActivityCallback: () => ((sessionId: string, workerId: string, state: AgentActivityState) => void) | undefined;
  getGlobalWorkerExitCallback: () => ((sessionId: string, workerId: string, exitCode: number, reason: ExitReason) => void) | undefined;
  shutdownGraceMs?: number;
  sigtermTimeoutMs?: number;
}

/** Immutable references shared by the readers, the exit observer, and the command writers. */
interface StreamContext {
  sessionId: string;
  workerId: string;
  worker: InternalEmbeddedAgentWorker;
  resolver: SessionDataPathResolver;
}

/** Per-worker runtime state kept OFF the worker object (subprocess-lifecycle-scoped). */
interface Runtime {
  ctx: StreamContext;
  /** True from user-message admission until the loop reports `state: idle` (or exit). */
  turnActive: boolean;
  /** Set by deactivate() so the exit observer can classify a managed shutdown. */
  shutdownRequested: boolean;
  consecutiveParseFailures: number;
  /** Resolves when both stdout and stderr readers have fully drained. */
  streamsDone: Promise<void>;
  /** Resolves after the exit observer finished all cleanup (append/revoke/persist/fire). */
  exitSettled: Promise<void>;
}

type PipedSubprocess = Subprocess<'pipe', 'pipe', 'pipe'>;

export class EmbeddedAgentWorkerService {
  private readonly runtimes = new Map<string, Runtime>();
  /**
   * In-flight activations keyed by workerId. Guards against two concurrent
   * `activate()` calls for the same worker (e.g. two WS clients hitting
   * `onOpen` simultaneously) both passing the null-subprocess check and each
   * spawning a subprocess + minting a token. The second concurrent call awaits
   * the SAME promise as the first instead of proceeding independently.
   */
  private readonly activations = new Map<string, Promise<void>>();
  private readonly spawnAsUserFn: SpawnAsUserFn;
  private readonly loadProviderKeyFn: typeof loadProviderKey;
  private readonly entryPath: string;
  private readonly shutdownGraceMs: number;
  private readonly sigtermTimeoutMs: number;

  constructor(private readonly deps: EmbeddedAgentWorkerServiceDeps) {
    this.spawnAsUserFn = deps.spawnAsUserFn ?? spawnAsUser;
    this.loadProviderKeyFn = deps.loadProviderKeyFn ?? loadProviderKey;
    this.entryPath = deps.entryPath ?? resolveEmbeddedAgentEntryPath().path;
    this.shutdownGraceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.sigtermTimeoutMs = deps.sigtermTimeoutMs ?? DEFAULT_SIGTERM_TIMEOUT_MS;
  }

  /**
   * Activate the embedded-agent worker. Serializes concurrent calls for the
   * same worker through the {@link activations} in-flight map so a second
   * concurrent caller awaits the first's outcome rather than double-spawning.
   * Non-async on purpose: it returns the SAME promise object to concurrent
   * callers (so `activate() === activate()` while in flight).
   */
  activate(sessionId: string, workerId: string): Promise<void> {
    const inFlight = this.activations.get(workerId);
    if (inFlight) {
      return inFlight;
    }
    const p = this.runActivation(sessionId, workerId).finally(() => {
      // Only clear the slot if it still holds THIS activation (a later
      // activation may have replaced it).
      if (this.activations.get(workerId) === p) {
        this.activations.delete(workerId);
      }
    });
    this.activations.set(workerId, p);
    return p;
  }

  /**
   * Spawn the loop subprocess, deliver the init handshake over stdin, and start
   * streaming its NDJSON events. Every failure path throws with a clear message
   * surfaced to the client. Idempotent when the subprocess is already live.
   * Callers go through {@link activate} for concurrency serialization.
   */
  private async runActivation(sessionId: string, workerId: string): Promise<void> {
    const session = this.deps.getSession(sessionId);
    if (!session) {
      throw new EmbeddedAgentActivationError(
        `Cannot activate embedded-agent worker: session ${sessionId} not found`,
      );
    }
    const worker = session.workers.get(workerId);
    if (!worker || worker.type !== 'embedded-agent') {
      throw new EmbeddedAgentActivationError(
        `Cannot activate embedded-agent worker: worker ${workerId} is not an embedded-agent worker`,
      );
    }

    // Step 0: idempotent no-op when already activated.
    if (worker.subprocess !== null) {
      logger.debug({ sessionId, workerId }, 'Embedded-agent worker already activated; no-op');
      return;
    }

    // Step 1: resolve the definition. No built-in fallback (unlike terminal agents).
    const definition = this.deps.getEmbeddedAgent(worker.embeddedAgentId);
    if (!definition) {
      throw new EmbeddedAgentActivationError(
        `Embedded agent definition not found (deleted): ${worker.embeddedAgentId}. The worker stays deactivated.`,
      );
    }

    // Step 2: resolve the provider key if referenced (dangling ref fails activation).
    let apiKey: string | undefined;
    if (definition.provider.apiKeyRef) {
      apiKey = await this.loadProviderKeyFn(definition.provider.apiKeyRef);
    }

    // Step 3: mint the MCP token. Requires a session owner so the minted identity
    // is comparable to session ownership (checkCallerOwnsSession strictly rejects
    // ownerless sessions, so a token minted from one would false-reject every call).
    if (!session.createdBy) {
      throw new EmbeddedAgentActivationError(
        `Cannot activate embedded-agent worker: session ${sessionId} has no createdBy, so an MCP caller identity cannot be minted`,
      );
    }
    const token = this.deps.mcpTokenRegistry.mint({
      sessionId,
      workerId,
      userId: session.createdBy,
    });

    // Everything after the mint is wrapped so a failure (output reset, spawn,
    // stdin write, persist) revokes the just-minted token and tears down any
    // spawned subprocess before rethrowing. Without this the token would linger
    // in the registry forever — the exit observer (its only other revoker)
    // never runs when the subprocess failed to spawn or was never observed.
    let spawned: PipedSubprocess | null = null;
    try {
      // Step 4: reset the output stream (every activation is restart-semantics in v1).
      const resolver = this.deps.getPathResolver(session);
      const newEpoch = await this.deps.workerOutputFileManager.resetWorkerOutput(
        sessionId,
        workerId,
        resolver,
      );
      worker.epoch = newEpoch;
      worker.outputOffset = 0;

      // Step 5: spawn as the requesting OS user. The command carries NO secrets
      // (token / provider key travel only in the stdin init line) and NO env.
      const username = await this.deps.resolveSpawnUsername(session.createdBy);
      const { subprocess, stdin } = this.spawnAsUserFn({
        username,
        command: `bun ${shellEscape(this.entryPath)}`,
        cwd: session.locationPath,
      });
      spawned = subprocess;
      worker.subprocess = subprocess;
      worker.stdin = stdin;

      const ctx: StreamContext = { sessionId, workerId, worker, resolver };

      // Step 6: write the init command as the FIRST stdin line.
      const initCommand: EmbeddedAgentCommand = {
        v: 1,
        type: 'init',
        mcp: { baseUrl: this.deps.getMcpBaseUrl(), token },
        provider: {
          baseUrl: definition.provider.baseUrl,
          model: definition.provider.model,
          ...(apiKey !== undefined ? { apiKey } : {}),
        },
        context: {
          sessionId,
          workerId,
          ...(session.type === 'worktree' ? { repositoryId: session.repositoryId } : {}),
          cwd: session.locationPath,
        },
        ...(definition.systemPrompt !== undefined ? { systemPrompt: definition.systemPrompt } : {}),
        ...(definition.enabledTools !== undefined ? { enabledTools: definition.enabledTools } : {}),
        ...(definition.instructions !== undefined ? { instructions: definition.instructions } : {}),
        maxToolIterations: definition.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS,
      };
      this.writeCommand(stdin, initCommand);

      // Step 7: start readers, register the exit observer, and mark idle.
      const runtime: Runtime = {
        ctx,
        turnActive: false,
        shutdownRequested: false,
        consecutiveParseFailures: 0,
        streamsDone: Promise.resolve(),
        exitSettled: Promise.resolve(),
      };
      this.runtimes.set(workerId, runtime);

      runtime.streamsDone = Promise.all([
        this.readStdout(runtime, subprocess).catch((err) => {
          logger.warn({ sessionId, workerId, err }, 'Embedded-agent stdout reader error');
        }),
        this.readStderr(ctx, subprocess).catch((err) => {
          logger.warn({ sessionId, workerId, err }, 'Embedded-agent stderr reader error');
        }),
      ]).then(() => {});

      runtime.exitSettled = subprocess.exited
        .then(async (code) => {
          // Exit handling is ordered AFTER stream completion so the final events
          // flush before the server-authored `exited` row (mirrors
          // interactive-process-manager.ts exit observation). The exiting
          // subprocess is passed so handleExit can detect a superseded incarnation.
          await runtime.streamsDone;
          await this.handleExit(runtime, subprocess, code);
        })
        .catch((err) => {
          logger.error({ sessionId, workerId, err }, 'Embedded-agent exit handler error');
        });

      worker.activityState = 'idle';
      this.broadcastActivity(ctx, 'idle');

      await this.deps.persistSession(session);

      logger.info({ sessionId, workerId, pid: subprocess.pid }, 'Embedded-agent worker activated');
    } catch (err) {
      // Revoke the minted token and tear down any spawned subprocess so the
      // failed activation leaves no orphaned token or process.
      this.deps.mcpTokenRegistry.revokeByWorker(workerId);
      if (spawned) {
        this.safeKill(spawned, 9);
      }
      worker.subprocess = null;
      worker.stdin = null;
      // Safe to delete unconditionally: the in-flight activation guard prevents
      // a concurrent activation from having installed a different runtime here.
      this.runtimes.delete(workerId);
      logger.warn({ sessionId, workerId, err }, 'Embedded-agent activation failed; revoked token and cleaned up');
      throw err;
    }
  }

  /**
   * Forward a user message to the loop. Admission is a SYNCHRONOUS check-and-set
   * (before any await) so two concurrent WS callers cannot double-admit.
   *
   * Returns a machine-checkable `code` alongside the human-readable `error`
   * string on failure so callers (routes.ts) can switch on `code` instead of
   * string-matching `error` -- a future wording tweak to one of the messages
   * below must not silently change which WorkerErrorCode a caller derives.
   */
  async sendUserMessage(
    sessionId: string,
    workerId: string,
    text: string,
    clientMessageId?: string,
  ): Promise<SendUserMessageResult> {
    const session = this.deps.getSession(sessionId);
    const worker = session?.workers.get(workerId);
    const runtime = this.runtimes.get(workerId);

    // --- synchronous admission (no await before turnActive is set) ---
    if (
      !session ||
      !worker ||
      worker.type !== 'embedded-agent' ||
      worker.subprocess === null ||
      !worker.stdin ||
      !runtime
    ) {
      return { ok: false, code: 'NOT_ACTIVATED', error: 'not activated' };
    }
    const stdin = worker.stdin;
    if (runtime.turnActive) {
      return { ok: false, code: 'TURN_IN_PROGRESS', error: 'turn in progress' };
    }
    runtime.turnActive = true;
    // --- end synchronous admission ---

    const id = crypto.randomUUID();
    // Two separate objects: `command` (stdin, loop protocol -- unchanged
    // shape) and `event` (persisted stream, may carry `clientMessageId`).
    // The loop protocol is correlation-agnostic; only the persisted/broadcast
    // event carries the client's correlation id. Do NOT reuse one object for
    // both -- see docs/design/embedded-agent-worker.md.
    const command: EmbeddedAgentCommand = { v: 1, type: 'user-message', id, text };
    const event: EmbeddedAgentServerEvent = {
      v: 1,
      type: 'user-message',
      id,
      text,
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
    };
    // Forward BEFORE appending: both calls are synchronous (no await between
    // them, nothing else can interleave), so ordering doesn't affect replay
    // stability either way -- but writing first means a WRITE_FAILED never
    // leaves a persisted/broadcast echo for a message the loop never
    // actually received (which would falsely resolve the client's pending
    // send despite the error response).
    try {
      this.writeCommand(stdin, command);
    } catch (err) {
      runtime.turnActive = false;
      logger.warn({ sessionId, workerId, err }, 'Failed to forward user message to embedded-agent stdin');
      return { ok: false, code: 'WRITE_FAILED', error: 'failed to write to subprocess stdin' };
    }
    this.appendEvent(runtime.ctx, event);

    return { ok: true, id };
  }

  /**
   * Deliver the session's initialPrompt as this embedded worker's first user
   * message, exactly once, right after the loop reports readiness. Reuses
   * the normal sendUserMessage path (turn admission, transcript append, WS
   * broadcast) so the client renders it as an ordinary user message with no
   * client-side changes. See docs/design/embedded-agent-worker.md "Initial
   * prompt delivery".
   */
  private async maybeDeliverInitialPrompt(ctx: StreamContext): Promise<void> {
    if (!ctx.worker.deliverInitialPromptOnActivation) return;
    const session = this.deps.getSession(ctx.sessionId);
    if (!session) return;
    const prompt = session.initialPrompt?.trim();
    if (!prompt) return;
    if (session.initialPromptDelivered) return;
    const result = await this.sendUserMessage(ctx.sessionId, ctx.workerId, prompt);
    if (!result.ok) {
      logger.warn(
        { sessionId: ctx.sessionId, workerId: ctx.workerId, code: result.code },
        'Failed to deliver initial prompt to embedded-agent worker; will retry on next activation',
      );
      return;
    }
    session.initialPromptDelivered = true;
    await this.deps.persistSession(session);
  }

  /**
   * Forward a cancel command (the loop no-ops it while idle). Returns whether it
   * was forwarded.
   */
  cancel(sessionId: string, workerId: string): boolean {
    const session = this.deps.getSession(sessionId);
    const worker = session?.workers.get(workerId);
    if (!worker || worker.type !== 'embedded-agent' || worker.subprocess === null || !worker.stdin) {
      return false;
    }
    try {
      this.writeCommand(worker.stdin, { v: 1, type: 'cancel' });
      return true;
    } catch (err) {
      logger.warn({ sessionId, workerId, err }, 'Failed to forward cancel to embedded-agent stdin');
      return false;
    }
  }

  /**
   * Gracefully deactivate: request shutdown, then escalate SIGTERM -> SIGKILL on
   * the configured timeouts. Resolves only after the exit observer's cleanup
   * (exited event append, token revocation) has run.
   */
  async deactivate(sessionId: string, workerId: string): Promise<void> {
    const session = this.deps.getSession(sessionId);
    const worker = session?.workers.get(workerId);
    if (!worker || worker.type !== 'embedded-agent' || worker.subprocess === null) {
      return; // not activated — no-op
    }
    const runtime = this.runtimes.get(workerId);
    const subprocess = worker.subprocess;

    if (runtime) {
      runtime.shutdownRequested = true;
    }

    if (worker.stdin) {
      try {
        this.writeCommand(worker.stdin, { v: 1, type: 'shutdown' });
      } catch (err) {
        logger.debug({ sessionId, workerId, err }, 'Shutdown command write failed (subprocess may be exiting)');
      }
    }

    let alive = !(await this.raceExit(subprocess, this.shutdownGraceMs));
    if (alive) {
      logger.info({ sessionId, workerId }, 'Embedded-agent did not exit on shutdown; sending SIGTERM');
      this.safeKill(subprocess, 15);
      alive = !(await this.raceExit(subprocess, this.sigtermTimeoutMs));
      if (alive) {
        logger.warn({ sessionId, workerId }, 'Embedded-agent did not exit on SIGTERM; sending SIGKILL');
        this.safeKill(subprocess, 9);
      }
    }

    if (runtime) {
      // Ensure the exit observer's cleanup (exited event, token revoke, persist)
      // completed before returning so downstream output cleanup runs after.
      await runtime.exitSettled;
    }
  }

  // ========== Internals ==========

  /** Serialize a command as a single NDJSON line and flush it to stdin. */
  private writeCommand(stdin: FileSink, command: EmbeddedAgentCommand): void {
    stdin.write(`${JSON.stringify(command)}\n`);
    stdin.flush();
  }

  /**
   * Append an already-serialized NDJSON line to the worker output stream and fan
   * it out to every attached connection ((a)+(b) in the spec).
   */
  private appendLine(ctx: StreamContext, line: string): void {
    const { worker, sessionId, workerId, resolver } = ctx;
    const data = `${line}\n`;
    worker.outputOffset += Buffer.byteLength(data, 'utf-8');
    this.deps.workerOutputFileManager.bufferOutput(sessionId, workerId, data, resolver, worker.epoch);
    const snapshot = Array.from(worker.connectionCallbacks.values());
    for (const cb of snapshot) {
      cb.onData(data, worker.outputOffset, worker.epoch);
    }
  }

  /** Append a server-authored event object to the persisted stream. */
  private appendEvent(ctx: StreamContext, event: EmbeddedAgentServerEvent): void {
    this.appendLine(ctx, JSON.stringify(event));
  }

  /** Fire activity-change side channels (per-connection + global). */
  private broadcastActivity(ctx: StreamContext, state: AgentActivityState): void {
    const snapshot = Array.from(ctx.worker.connectionCallbacks.values());
    for (const cb of snapshot) {
      cb.onActivityChange?.(state);
    }
    this.deps.getGlobalActivityCallback()?.(ctx.sessionId, ctx.workerId, state);
  }

  private async readStdout(runtime: Runtime, subprocess: PipedSubprocess): Promise<void> {
    const { ctx } = runtime;
    const splitter = new NdjsonLineSplitter({ maxLineBytes: MAX_LINE_BYTES });
    const decoder = new TextDecoder();
    const reader = subprocess.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        const result = splitter.push(text);
        if (result.oversized) {
          logger.warn(
            { sessionId: ctx.sessionId, workerId: ctx.workerId },
            'Oversized NDJSON line from embedded-agent loop; killing subprocess (protocol violation)',
          );
          this.safeKill(subprocess, 9);
          return;
        }
        for (const line of result.lines) {
          if (line.length === 0) continue;
          await this.handleLoopLine(runtime, subprocess, line);
        }
      }
    } catch (err) {
      logger.debug({ sessionId: ctx.sessionId, workerId: ctx.workerId, err }, 'Embedded-agent stdout stream ended');
    }
  }

  private async readStderr(ctx: StreamContext, subprocess: PipedSubprocess): Promise<void> {
    const decoder = new TextDecoder();
    const reader = subprocess.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        logger.debug(
          { sessionId: ctx.sessionId, workerId: ctx.workerId, stderr: text.slice(0, STDERR_LOG_CAP) },
          'Embedded-agent stderr',
        );
      }
    } catch (err) {
      logger.debug({ sessionId: ctx.sessionId, workerId: ctx.workerId, err }, 'Embedded-agent stderr stream ended');
    }
  }

  private async handleLoopLine(runtime: Runtime, subprocess: PipedSubprocess, line: string): Promise<void> {
    const { ctx } = runtime;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Unparseable line: genuine protocol corruption → counts toward the strike counter.
      this.handleParseFailure(runtime, subprocess);
      return;
    }

    // Forward-compat: a parseable object whose `type` this build does not
    // recognize is a version-skew event (newer/older loop). Skip + log WITHOUT
    // incrementing the strike counter — it is not corruption. A recognized type
    // that then fails its own schema shape IS corruption (handled below).
    const parsedType =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { type?: unknown }).type
        : undefined;
    if (typeof parsedType !== 'string' || !KNOWN_EVENT_TYPES.has(parsedType)) {
      logger.debug(
        { sessionId: ctx.sessionId, workerId: ctx.workerId, type: parsedType },
        'Skipping embedded-agent event with unrecognized type (forward-compat)',
      );
      return;
    }

    const result = v.safeParse(EmbeddedAgentEventSchema, parsed);
    if (!result.success) {
      // Recognized type but shape-invalid: genuine corruption (same-deployment
      // version parity) → counts toward the strike counter.
      this.handleParseFailure(runtime, subprocess);
      return;
    }
    runtime.consecutiveParseFailures = 0;
    const event = result.output;

    // (a)+(b): append the raw line and fan out.
    this.appendLine(ctx, line);

    // (c): side-channel activity state.
    if (event.type === 'state') {
      ctx.worker.activityState = event.state;
      this.broadcastActivity(ctx, event.state);
      if (event.state === 'idle') {
        runtime.turnActive = false;
      }
    }

    // (d): deliver the session's initialPrompt as this worker's first user
    // message, exactly once, right after the loop reports readiness.
    if (event.type === 'ready') {
      await this.maybeDeliverInitialPrompt(ctx);
    }
  }

  private handleParseFailure(runtime: Runtime, subprocess: PipedSubprocess): void {
    runtime.consecutiveParseFailures += 1;
    logger.warn(
      {
        sessionId: runtime.ctx.sessionId,
        workerId: runtime.ctx.workerId,
        consecutive: runtime.consecutiveParseFailures,
      },
      'Malformed NDJSON line from embedded-agent loop; skipping',
    );
    if (runtime.consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
      logger.error(
        { sessionId: runtime.ctx.sessionId, workerId: runtime.ctx.workerId },
        'Too many consecutive parse failures; killing subprocess (protocol integrity lost)',
      );
      this.safeKill(subprocess, 9);
    }
  }

  private async handleExit(
    runtime: Runtime,
    subprocess: PipedSubprocess,
    code: number | null,
  ): Promise<void> {
    const { ctx } = runtime;
    const { worker, sessionId, workerId } = ctx;

    // Stale-exit guard: if a newer activation has already replaced the live
    // subprocess handle, this is a superseded incarnation's exit. Touching the
    // worker fields / revoking the token here would corrupt the CURRENT live
    // subprocess's state (null its handle, revoke its token). Skip entirely.
    if (worker.subprocess !== subprocess) {
      logger.warn(
        { sessionId, workerId },
        'Ignoring stale embedded-agent exit (subprocess superseded by a newer activation)',
      );
      return;
    }

    // Append the server-authored exited row so the on-disk log is complete.
    this.appendEvent(ctx, { v: 1, type: 'exited', code: code ?? null });

    worker.subprocess = null;
    worker.stdin = null;
    this.deps.mcpTokenRegistry.revokeByWorker(workerId);
    runtime.turnActive = false;
    worker.activityState = 'idle';
    this.broadcastActivity(ctx, 'idle');

    // Persist so the (now-null) pid is durable. Re-resolve the session: it may
    // have been deleted during the async gap — skip persistence if so.
    const session = this.deps.getSession(sessionId);
    if (session) {
      await this.deps.persistSession(session);
    }

    const reason: ExitReason = runtime.shutdownRequested ? 'managed' : 'unexpected';
    const snapshot = Array.from(worker.connectionCallbacks.values());
    for (const cb of snapshot) {
      cb.onExit(code ?? 0, null, reason);
    }
    this.deps.getGlobalWorkerExitCallback()?.(sessionId, workerId, code ?? 0, reason);

    // Only clear the runtime slot if it still holds THIS activation's runtime.
    if (this.runtimes.get(workerId) === runtime) {
      this.runtimes.delete(workerId);
    }
    logger.info({ sessionId, workerId, code, reason }, 'Embedded-agent worker exited');
  }

  private safeKill(subprocess: PipedSubprocess, signal: number): void {
    try {
      subprocess.kill(signal);
    } catch {
      // Process may have already exited.
    }
  }

  /** Resolve true if the subprocess exited within `timeoutMs`, false on timeout. */
  private async raceExit(subprocess: PipedSubprocess, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      subprocess.exited.then(() => 'exited' as const),
      timeout,
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return outcome === 'exited';
  }
}
