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
 *
 * Staying open for the process lifetime is not staying open forever: at
 * teardown the stdin sink must still be closed explicitly, or the OS pipe fd
 * is left for incidental GC -- the same unsound pattern previously flagged
 * as unacceptable for the PTY master-fd handle. `endStdinSafely` (a private
 * method on this class) is called from both teardown points -- the exit
 * observer (`handleExit`) and the activation-failure catch in
 * `runActivation` -- so every path that stops owning a live stdin sink
 * closes it deterministically. See `.claude/rules/elevation-helpers.md`'s
 * "feeding-consumer teardown obligation".
 */
import type { Subprocess, FileSink } from 'bun';
import * as v from 'valibot';
import {
  NdjsonLineSplitter,
  EmbeddedAgentEventSchema,
  type EmbeddedAgentDefinition,
  type EmbeddedAgentCommand,
  type EmbeddedAgentServerEvent,
  type EmbeddedAgentServerNotification,
  type EmbeddedAgentRestoredMessage,
  type AgentActivityState,
  type ExitReason,
} from '@agent-console/shared';
import { loadInstructions, assembleSystemPrompt } from '@agent-console/embedded-agent/src/system-prompt.js';
import { reconstructConversation, RestoreReconstructionError } from '@agent-console/embedded-agent/src/restore.js';
import type { InternalSession } from './internal-types.js';
import type { InternalEmbeddedAgentWorker } from './worker-types.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import type { McpTokenRegistry } from '../mcp/mcp-auth.js';
import type { WorkerOutputFileManager } from '../lib/worker-output-file.js';
import { spawnAsUser, shellEscape, type SpawnAsUserFn } from './privilege-elevation.js';
import { loadProviderKey, ProviderKeyStoreError, PROVIDER_KEY_STORE_UI_MESSAGES } from './provider-key-store.js';
import {
  buildPtyNotificationText,
  buildReplyInstructions,
  extractNotificationSummary,
  type PtyNotificationParams,
} from '../lib/pty-notification.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

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
  source: 'bundle' | 'package' | 'fallback';
}

/**
 * Resolve the absolute path to the embedded-agent subprocess entry.
 *
 * `@agent-console/embedded-agent` is a private workspace package (see its
 * `package.json`), so it is never installed by `bun install --production`
 * into a bundled deploy's `dist/` tree — package-manager resolution is only
 * possible in a dev workspace checkout. Three-tier resolution, tried in
 * order:
 *
 * 1. **Bundle sibling** (production-deploy-correct): `packages/server/build.ts`
 *    bundles the embedded-agent loop to `dist/embedded-agent.js`, a sibling
 *    of `dist/server.js`. Under a bundled deploy (`bun dist/index.js`),
 *    `baseDir` (default `import.meta.dir`) points into that same `dist/`
 *    directory, so `embedded-agent.js` sits right next to the running server.
 *    Checked via `existsSync` rather than assumed, since `baseDir` is also
 *    `import.meta.dir` in the dev/test case below, where no such file exists.
 * 2. **Workspace-package resolution** (dev-checkout-correct): the package
 *    manager's view, `Bun.resolveSync('@agent-console/embedded-agent/package.json',
 *    baseDir)` then join `src/main.ts`. `package.json` is the reliable
 *    subpath (Bun resolves it even without an `exports` map, unlike
 *    arbitrary `src/*` subpaths). This is what a dev workspace checkout
 *    (`bun install` wires the workspace edge) and CI both exercise.
 * 3. **Source-tree-relative fallback**: used only when neither of the above
 *    apply (e.g. local pre-`bun install` state).
 *
 * `baseDir` defaults to `import.meta.dir` but is overridable as a test seam
 * so unit tests can point it at a fixture directory without touching the
 * real dev checkout or a real dist build.
 *
 * Extracted as a standalone exported function (rather than kept as a private
 * static method on {@link EmbeddedAgentWorkerService}) so the real-machine
 * smoke test can call it independently of constructing the service, and
 * compare its result against the entry path the service will use by default.
 */
export function resolveEmbeddedAgentEntryPath(
  baseDir: string = import.meta.dir
): EmbeddedAgentEntryResolution {
  const bundlePath = path.join(baseDir, 'embedded-agent.js');
  if (existsSync(bundlePath)) {
    return { path: bundlePath, source: 'bundle' };
  }
  try {
    const pkgJson = Bun.resolveSync('@agent-console/embedded-agent/package.json', baseDir);
    return { path: path.join(path.dirname(pkgJson), 'src/main.ts'), source: 'package' };
  } catch {
    return {
      path: path.resolve(baseDir, '../../../embedded-agent/src/main.ts'),
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
  'context-usage',
  'context-compacted',
  // LEGACY: no engine emits this any more, but a persisted stream written
  // before the compaction swap replays through this same gate. Removing it
  // would make every historical row fail the unknown-type check.
  'context-handoff',
  'sdk-session-id',
]);
/** Cap on the per-chunk stderr text forwarded to the debug logger. */
const STDERR_LOG_CAP = 2048;

/**
 * Marks the small, enumerable set of `runActivation` failure reasons whose
 * `message` is safe to forward to the client verbatim (session/worker/
 * definition lookup failures, missing `createdBy`, and provider-key-store
 * failures, whose {@link ProviderKeyStoreError} `kind` is mapped to a fixed
 * UI template in step 2 below). Every other failure in `runActivation`
 * (spawn username resolution, process spawn, output reset, persistence)
 * throws a plain `Error` and must NOT be wrapped in this class -- callers
 * use `instanceof` to decide whether `err.message` is client-safe or must be
 * replaced with a generic fallback.
 */
export class EmbeddedAgentActivationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmbeddedAgentActivationError';
  }
}

/**
 * Client-visible fallback for an embedded-agent activation failure whose
 * message is NOT from the {@link EmbeddedAgentActivationError} allowlist
 * (e.g. spawn username resolution, process spawn, filesystem, DB errors).
 * Those errors can carry unbounded/unstructured content, so their real
 * message stays server-side-only (see each call site's `logger.warn`
 * alongside this constant's use) and only this fixed string reaches the
 * client. Single shared export consumed by every classification site
 * (`websocket/routes.ts`, `mcp/mcp-server.ts`, `routes/workers.ts`) so the
 * wording cannot drift between copies.
 */
export const GENERIC_EMBEDDED_ACTIVATION_FAILURE_MESSAGE =
  'Embedded-agent activation failed. Contact an administrator if this persists.';

/**
 * Marker error wrapping a {@link SendUserMessageResult}'s `{ ok: false }`
 * case. Thrown by `SessionManager.sendMessage`'s embedded-agent branch so
 * REST/MCP callers can distinguish "safe, curated delivery-result message,
 * forward verbatim" (this class) from "unclassified activation error, needs
 * generic fallback" (a plain `Error`, e.g. from
 * `EmbeddedAgentWorkerService.activate` failing for a non-
 * `EmbeddedAgentActivationError` reason) -- both would otherwise be
 * indistinguishable plain `Error` instances at the caller.
 */
export class EmbeddedMessageDeliveryError extends Error {
  constructor(
    message: string,
    public readonly code: 'TURN_IN_PROGRESS' | 'NOT_ACTIVATED' | 'WRITE_FAILED',
  ) {
    super(message);
    this.name = 'EmbeddedMessageDeliveryError';
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

/**
 * Result of {@link EmbeddedAgentWorkerService.triggerHandoff}. Deliberately
 * NOT `SendUserMessageResult` -- the success case there carries an `id` that
 * has no meaning for a handoff trigger (there is no `EmbeddedAgentServerEvent`
 * appended for this command; the loop's own `context-handoff` event IS the
 * persisted marker once it succeeds). See docs/design/embedded-agent-worker.md
 * "Context Handoff (Phase A)".
 */
export type TriggerHandoffResult =
  | { ok: true }
  | { ok: false; code: 'NOT_ACTIVATED' | 'TURN_IN_PROGRESS' | 'WRITE_FAILED'; error: string };

export interface EmbeddedAgentWorkerServiceDeps {
  getSession: (sessionId: string) => InternalSession | undefined;
  persistSession: (session: InternalSession) => Promise<void>;
  getPathResolver: (session: InternalSession) => SessionDataPathResolver;
  getEmbeddedAgent: (id: string) => EmbeddedAgentDefinition | undefined;
  resolveSpawnUsername: (createdBy?: string) => Promise<string>;
  mcpTokenRegistry: Pick<McpTokenRegistry, 'mint' | 'revokeByWorker'>;
  workerOutputFileManager: Pick<
    WorkerOutputFileManager,
    'resetWorkerOutput' | 'bufferOutput' | 'readHistoryWithOffset' | 'hasEverBeenActivated'
  >;
  /** MCP Streamable-HTTP base URL delivered to the loop in the init message. */
  getMcpBaseUrl: () => string;
  /** Test seam for the provider-key loader. */
  loadProviderKeyFn?: typeof loadProviderKey;
  /** Test seam for the elevated spawn helper. */
  spawnAsUserFn?: SpawnAsUserFn;
  /** Absolute path to the embedded-agent subprocess entry (resolved from the server install root). */
  entryPath?: string;
  /** Test seam for the configured bun binary path (defaults to serverConfig.EMBEDDED_AGENT_BUN_PATH). */
  embeddedAgentBunPath?: string;
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
  /** Transcript Restore (#1123): this incarnation's restore result, retained for bootstrap re-delivery to every new connection for the incarnation's lifetime. null when restore did not fire (first-ever activation or restore failure). `completed` starts false (restore succeeded but the new incarnation hasn't reported `ready` yet) and flips true once the loop's `ready` event fires (#1205) -- this is what lets the client distinguish "still restoring" from "restore delivered, incarnation ready" across an epoch-stable restore. */
  restoreInfo: { messageCount: number; repairedToolCallIds: string[]; completed: boolean } | null;
}

type PipedSubprocess = Subprocess<'pipe', 'pipe', 'pipe'>;

/**
 * Whether `worker` has an undelivered initial-prompt obligation: it was
 * created with `deliverInitialPromptOnActivation: true`, `session`'s
 * `initialPrompt` is non-empty after trimming, and it has not already been
 * delivered. Single writer (I-2) for the EMBEDDED PATH's eligibility check
 * -- see Issue
 * #1264. Consumed by both `maybeDeliverInitialPrompt` (below, the normal
 * lazy-activation delivery path) and the revival hook in
 * `session-pause-resume-service.ts` (auto-activates workers with this
 * obligation on server-restart / manual resume so a prompt that was never
 * delivered before the server died is not stranded forever).
 *
 * The PTY-backed agent-worker path has the identical rule -- same three
 * persisted fields, same truth table -- computed separately by
 * `resolveStartupIntent`'s `obligated` check in `startup-intent.ts`. Kept
 * as two family-scoped single writers rather than merged into one shared
 * predicate: this function takes typed internal worker/session; the
 * PTY-path resolver takes a plain input shape and additionally folds in a
 * caller preference this path has no concept of. A third family wanting
 * this exact conjunct is the trigger to extract the bare predicate, not
 * before.
 */
export function hasUndeliveredInitialPrompt(
  worker: InternalEmbeddedAgentWorker,
  session: InternalSession,
): boolean {
  if (!worker.deliverInitialPromptOnActivation) return false;
  if (session.initialPromptDelivered) return false;
  return !!session.initialPrompt?.trim();
}

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
  private readonly bunPath: string;
  private readonly shutdownGraceMs: number;
  private readonly sigtermTimeoutMs: number;

  constructor(private readonly deps: EmbeddedAgentWorkerServiceDeps) {
    this.spawnAsUserFn = deps.spawnAsUserFn ?? spawnAsUser;
    this.loadProviderKeyFn = deps.loadProviderKeyFn ?? loadProviderKey;
    this.entryPath = deps.entryPath ?? resolveEmbeddedAgentEntryPath().path;
    this.bunPath = deps.embeddedAgentBunPath ?? serverConfig.EMBEDDED_AGENT_BUN_PATH;
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
   * Transcript Restore (#1123) bootstrap re-delivery: the current
   * incarnation's restore result (if any), combined with the worker's
   * current epoch (unchanged since restore success never mints a new one).
   * Called by routes.ts for EVERY new WS connection during the incarnation,
   * not just the one that triggered activation -- see
   * docs/design/embedded-agent-worker.md "Transcript Restore" § UI.
   */
  getRestoreInfo(
    workerId: string,
  ): { epoch: number; messageCount: number; repairedToolCallIds: string[]; completed: boolean } | null {
    const runtime = this.runtimes.get(workerId);
    if (!runtime || runtime.restoreInfo === null) return null;
    return { epoch: runtime.ctx.worker.epoch, ...runtime.restoreInfo };
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
    // ProviderKeyStoreError (developer-authored, enumerable by `kind`) is
    // reclassified to EmbeddedAgentActivationError via the fixed UI template
    // table -- this is the ONLY place a ProviderKeyStoreError is caught and
    // converted. Any other error from this seam (including a misbehaving
    // injected loadProviderKeyFn) propagates unwrapped.
    let apiKey: string | undefined;
    if (definition.engine === 'openai-api' && definition.provider.apiKeyRef) {
      try {
        apiKey = await this.loadProviderKeyFn(definition.provider.apiKeyRef);
      } catch (err) {
        if (err instanceof ProviderKeyStoreError) {
          throw new EmbeddedAgentActivationError(
            PROVIDER_KEY_STORE_UI_MESSAGES[err.kind](err.ref),
            { cause: err },
          );
        }
        throw err;
      }
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
    let spawnedStdin: FileSink | null = null;
    try {
      // Step 4: attempt restore before resetting (Transcript Restore, #1123),
      // unless this is the worker's first-ever activation (nothing to
      // restore). `hasEverBeenActivated` (not getCurrentOffset) is the
      // first-ever-activation check because getCurrentOffset conflates
      // "manifest never created" (genuinely nothing to restore) with "manifest
      // read failed for some other reason" (both return 0) -- a transient I/O
      // error on an EXISTING worker with real transcript history would
      // otherwise take the destructive first-activation branch below WITHOUT
      // sidecar preservation. hasEverBeenActivated distinguishes ENOENT
      // (genuinely first-ever) from any other stat failure (conservatively
      // routed through the restore-attempt branch, which re-hits the same
      // underlying error and correctly falls into the failure-with-sidecar
      // path instead).
      const resolver = this.deps.getPathResolver(session);
      let restoredConversation: EmbeddedAgentRestoredMessage[] | undefined;
      let restoreInfo: { messageCount: number; repairedToolCallIds: string[]; completed: boolean } | null = null;
      const restoreContext = {
        sessionId,
        workerId,
        ...(session.type === 'worktree' ? { repositoryId: session.repositoryId } : {}),
        cwd: session.locationPath,
      };
      const everActivated = await this.deps.workerOutputFileManager.hasEverBeenActivated(sessionId, workerId, resolver);
      if (!everActivated) {
        // First-ever activation: nothing to restore, proceed with today's v1 reset unconditionally.
        const newEpoch = await this.deps.workerOutputFileManager.resetWorkerOutput(sessionId, workerId, resolver);
        worker.epoch = newEpoch;
        worker.outputOffset = 0;
      } else {
        try {
          const {
            data: streamText,
            offset: currentOffset,
            epoch: currentEpoch,
          } = await this.deps.workerOutputFileManager.readHistoryWithOffset(sessionId, workerId, resolver);
          if (streamText.trim() === '') {
            throw new Error('Persisted stream read returned empty despite a non-zero current offset (read failure)');
          }
          const instructions = await loadInstructions({ cwd: session.locationPath, instructionsList: definition.instructions });
          const systemPrompt = assembleSystemPrompt({
            context: restoreContext,
            instructions,
            definitionSystemPrompt: definition.systemPrompt,
          });
          const outcome = reconstructConversation(streamText, systemPrompt);
          restoredConversation = outcome.conversation as EmbeddedAgentRestoredMessage[];
          // `completed: false` -- the new incarnation's `ready` event hasn't
          // fired yet at this point in runActivation; handleLoopLine flips it
          // to true (and re-pushes) once `ready` arrives (#1205).
          restoreInfo = {
            messageCount: outcome.conversation.length,
            repairedToolCallIds: outcome.repairedToolCallIds,
            completed: false,
          };
          // 4e: success -- skip resetWorkerOutput entirely. No new epoch, no
          // truncate. But the in-memory worker object may be stale relative to
          // the on-disk manifest (e.g. freshly reconstructed by WorkerManager
          // after a server restart, with default epoch/outputOffset values
          // independent of the manifest's actual current generation), so it
          // must be explicitly synced to the manifest's real current
          // coordinates here rather than assumed already correct.
          worker.epoch = currentEpoch;
          worker.outputOffset = currentOffset;
        } catch (err) {
          const isKnownRestoreFailure = err instanceof RestoreReconstructionError;
          logger.warn(
            { sessionId, workerId, err, knownRestoreFailure: isKnownRestoreFailure },
            'Transcript restore failed; falling back to v1 reset (preserving pre-reset log to sidecar)',
          );
          const newEpoch = await this.deps.workerOutputFileManager.resetWorkerOutput(sessionId, workerId, resolver, {
            preserveToSidecar: true,
          });
          worker.epoch = newEpoch;
          worker.outputOffset = 0;
        }
      }

      // Transcript Restore (#1123) fast-path push: broadcast to any
      // currently-attached connections BEFORE the subprocess spawns. This
      // reaches zero listeners in the common case (the triggering
      // connection's own callbacks aren't attached until after activate()
      // resolves) -- bootstrap re-delivery (getRestoreInfo, consumed by
      // routes.ts) is the authoritative path; this is a best-effort UX win
      // for OTHER already-open tabs watching this worker.
      if (restoreInfo !== null) {
        this.pushRestoreInfoToConnections(worker, restoreInfo);
      }

      // Step 5: spawn as the requesting OS user. The command carries NO secrets
      // (token / provider key travel only in the stdin init line) and NO env.
      const username = await this.deps.resolveSpawnUsername(session.createdBy);
      const { subprocess, stdin } = this.spawnAsUserFn({
        username,
        command: `${shellEscape(this.bunPath)} ${shellEscape(this.entryPath)}`,
        cwd: session.locationPath,
      });
      spawned = subprocess;
      spawnedStdin = stdin;
      worker.subprocess = subprocess;
      worker.stdin = stdin;

      const ctx: StreamContext = { sessionId, workerId, worker, resolver };

      // Step 6: write the init command as the FIRST stdin line. Branched on
      // `definition.engine` (SDK Engine Phase 1) so each arm's `provider`
      // shape matches the discriminated `EmbeddedAgentCommand` union --
      // claude-sdk carries no `apiKey` (absent by construction, never merely
      // undefined; see docs/design/embedded-agent-sdk-engine.md §3.2).
      const initCommandShared = {
        v: 1 as const,
        type: 'init' as const,
        mcp: { baseUrl: this.deps.getMcpBaseUrl(), token },
        context: restoreContext,
        ...(definition.systemPrompt !== undefined ? { systemPrompt: definition.systemPrompt } : {}),
        ...(definition.enabledTools !== undefined ? { enabledTools: definition.enabledTools } : {}),
        ...(definition.instructions !== undefined ? { instructions: definition.instructions } : {}),
        maxToolIterations: definition.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS,
        ...(restoredConversation !== undefined ? { restoredConversation } : {}),
        // Compaction: `auto` comes from the WORKER (its own toggle), the
        // other two from the definition. Composed here rather than read
        // separately by each engine so there is one place that decides what
        // the subprocess is told about compaction.
        compaction: {
          auto: ctx.worker.autoCompaction,
          ...(definition.contextWindowTokens !== undefined
            ? { contextWindowTokens: definition.contextWindowTokens }
            : {}),
          ...(definition.compaction?.threshold !== undefined
            ? { threshold: definition.compaction.threshold }
            : {}),
        },
      };
      const initCommand: EmbeddedAgentCommand =
        definition.engine === 'openai-api'
          ? {
              ...initCommandShared,
              engine: 'openai-api',
              provider: {
                baseUrl: definition.provider.baseUrl,
                model: definition.provider.model,
                ...(apiKey !== undefined ? { apiKey } : {}),
              },
            }
          : {
              ...initCommandShared,
              engine: 'claude-sdk',
              provider: { model: definition.provider.model },
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
        restoreInfo,
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
      this.endStdinSafely(spawnedStdin);
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
    return this.deliverUserTurn(sessionId, workerId, text, { clientMessageId });
  }

  /**
   * Deliver a system-originated internal notification to the loop as an
   * ordinary user turn, but persist it with a `notification` marker so the
   * client can render it distinctly from a real
   * human/API-caller message. `params` is the structured PTY-notification
   * params type -- composition (buildPtyNotificationText, and
   * buildReplyInstructions when `opts.replyToSessionId` is set) happens
   * internally; callers never hand over a pre-composed string. See
   * SessionManager.sendEmbeddedAgentSystemNotification.
   */
  async sendSystemNotification(
    sessionId: string,
    workerId: string,
    params: PtyNotificationParams,
    opts: { replyToSessionId?: string } = {},
  ): Promise<SendUserMessageResult> {
    const text =
      buildPtyNotificationText(params) +
      (opts.replyToSessionId !== undefined ? buildReplyInstructions(opts.replyToSessionId) : '');
    const summary = extractNotificationSummary(params);
    return this.deliverUserTurn(sessionId, workerId, text, {
      notification: { kind: params.kind, ...(summary !== undefined ? { summary } : {}) },
    });
  }

  /**
   * Shared admission/write/append logic for both `sendUserMessage` and
   * `sendSystemNotification` (a pure extraction -- no behavior change to the
   * pre-existing sendUserMessage path). Admission is
   * a SYNCHRONOUS check-and-set (before any await) so two concurrent callers
   * cannot double-admit.
   */
  private async deliverUserTurn(
    sessionId: string,
    workerId: string,
    text: string,
    opts: { clientMessageId?: string; notification?: EmbeddedAgentServerNotification } = {},
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
    // shape) and `event` (persisted stream, may carry `clientMessageId` /
    // `notification`). The loop protocol is correlation-agnostic; only the
    // persisted/broadcast event carries the client's correlation id or the
    // notification marker. Do NOT reuse one object for both -- see
    // docs/design/embedded-agent-worker.md.
    const command: EmbeddedAgentCommand = { v: 1, type: 'user-message', id, text };
    const event: EmbeddedAgentServerEvent = {
      v: 1,
      type: 'user-message',
      id,
      text,
      ...(opts.clientMessageId !== undefined ? { clientMessageId: opts.clientMessageId } : {}),
      ...(opts.notification !== undefined ? { notification: opts.notification } : {}),
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
   * Compaction: forward a change to the worker's auto-compaction toggle to a
   * RUNNING subprocess, so the change applies without waiting for the next
   * activation.
   *
   * Deliberately NOT gated on `turnActive`, unlike every other command this
   * service forwards: the loop only reads the flag at the turn boundary, so
   * recording it mid-turn is safe and means the very next boundary already
   * honours it. Gating would silently drop the change for the duration of a
   * long turn -- exactly when a user is most likely to reach for the toggle.
   *
   * Returns `false` when there is no live subprocess to tell. That is not a
   * failure: the durable value is already persisted by the caller and will be
   * read at the next activation. The caller must not surface it as an error.
   */
  forwardAutoCompaction(workerId: string, enabled: boolean): boolean {
    const runtime = this.runtimes.get(workerId);
    const stdin = runtime?.ctx.worker.stdin;
    if (!runtime || !stdin) return false;
    try {
      this.writeCommand(stdin, { v: 1, type: 'set-auto-compaction', enabled });
      return true;
    } catch (err) {
      logger.warn(
        { workerId, err },
        'Failed to forward auto-compaction toggle to embedded-agent stdin',
      );
      return false;
    }
  }

  /**
   * Forward a manual Context Handoff (Phase A) trigger to the loop. Admission
   * mirrors {@link sendUserMessage} exactly (the same synchronous
   * check-and-set gate, reused for a second command type) -- see
   * docs/design/embedded-agent-worker.md "Context Handoff (Phase A)"
   * § `AgentLoop.handoff()` Admission.
   *
   * Unlike `sendUserMessage`, there is no `EmbeddedAgentServerEvent` to
   * append to the persisted stream here: the loop's own `context-handoff`
   * event IS the persisted marker once the handoff succeeds, so this method
   * does not call `appendEvent`.
   */
  async triggerHandoff(sessionId: string, workerId: string): Promise<TriggerHandoffResult> {
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

    try {
      this.writeCommand(stdin, { v: 1, type: 'handoff' });
    } catch (err) {
      runtime.turnActive = false;
      logger.warn({ sessionId, workerId, err }, 'Failed to forward handoff to embedded-agent stdin');
      return { ok: false, code: 'WRITE_FAILED', error: 'failed to write to subprocess stdin' };
    }

    return { ok: true };
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
    const session = this.deps.getSession(ctx.sessionId);
    if (!session) return;
    if (!hasUndeliveredInitialPrompt(ctx.worker, session)) return;
    const prompt = session.initialPrompt!.trim();
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

  /**
   * Transcript Restore (#1123 / #1205): poke every currently-attached
   * connection's `onRestoreInfo` callback. Shared by the fast-path push
   * (right after a successful restore, before the subprocess spawns) and the
   * completion push (once the new incarnation's `ready` event fires) --
   * `cb.onRestoreInfo` re-derives its payload from `getRestoreInfo()` at send
   * time (see routes.ts), so the argument passed here only needs to satisfy
   * the callback's declared parameter type.
   */
  private pushRestoreInfoToConnections(
    worker: InternalEmbeddedAgentWorker,
    info: { messageCount: number; repairedToolCallIds: string[]; completed: boolean },
  ): void {
    const snapshot = Array.from(worker.connectionCallbacks.values());
    for (const cb of snapshot) {
      cb.onRestoreInfo?.(info);
    }
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

      // Transcript Restore completion (#1205): a successful restore leaves
      // the epoch unchanged, so the client can't tell "still restoring" from
      // "restore delivered, new incarnation ready" from epoch alone. Flip
      // `completed` and re-push once this incarnation is actually ready.
      // Guarded on `completed === false` so a duplicate `ready` (should never
      // happen, but the guard makes it a safe no-op) doesn't double-push.
      if (runtime.restoreInfo !== null && runtime.restoreInfo.completed === false) {
        runtime.restoreInfo = { ...runtime.restoreInfo, completed: true };
        this.pushRestoreInfoToConnections(ctx.worker, runtime.restoreInfo);
      }
    }

    // (e): SDK engine only -- persist the worker's CURRENT SDK session id.
    // Emitted on activation and on every future SDK-session replacement
    // (e.g. Phase 2's context-handoff reseed); last-write-wins. Persisted
    // immediately per-event rather than batched: this event fires rarely
    // (activation, and later occasional reseed), unlike a chatty streaming
    // event, so inline persistence (mirroring maybeDeliverInitialPrompt's
    // fetch-and-persist shape) is the right-sized choice for Phase 1. See
    // docs/design/embedded-agent-sdk-engine.md §4 "Process lifetime" row.
    if (event.type === 'sdk-session-id') {
      ctx.worker.sdkSessionId = event.sdkSessionId;
      const session = this.deps.getSession(ctx.sessionId);
      if (session) {
        await this.deps.persistSession(session);
      }
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

    this.endStdinSafely(worker.stdin);
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

  /**
   * Close a subprocess's stdin sink at teardown so the OS pipe fd is
   * released deterministically rather than left for incidental GC -- see
   * the class-level JSDoc's "feeding-consumer teardown obligation" note.
   * Tolerates: no sink, an already-exited child (broken pipe on `end()`),
   * and being invoked more than once for the same sink.
   */
  private endStdinSafely(stdin: FileSink | null): void {
    if (!stdin) return;
    try {
      stdin.end();
    } catch (err) {
      logger.warn({ err }, 'Failed to close subprocess stdin sink at teardown');
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
