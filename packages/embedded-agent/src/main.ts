/**
 * Embedded-agent subprocess entry point.
 *
 * Reads NDJSON commands on stdin (the first MUST be a valid `init`), emits
 * NDJSON events on stdout, and routes all diagnostics to stderr. The
 * command-dispatch core is the exported `runLoop`, with injectable factories so
 * it is testable without a real MCP server, provider, or filesystem; a thin
 * `import.meta.main` bootstrap wires the production implementations.
 */

import { NdjsonLineSplitter, type EmbeddedAgentEvent } from '@agent-console/shared';
import * as v from 'valibot';
import { EmbeddedAgentCommandSchema } from '@agent-console/shared';
import { AgentLoop } from './agent-loop.js';
import { COMPACT_TOOL_NAME } from './compact-tool.js';
import type { Engine } from './engine-types.js';
import { loadCompactionPrompt } from './compaction-prompt.js';
import { McpToolClient, type ToolExecutor } from './mcp.js';
import { OpenAIChatAdapter } from './providers/openai-chat-adapter.js';
import type { ProviderAdapter, ToolDefinition } from './providers/types.js';
import { SdkEngine, type SdkEngineDeps } from './sdk-engine.js';
import { probeSdkSession, type SdkSessionProbe } from './sdk-session-preflight.js';
import {
  assembleSystemPrompt,
  composeSdkSystemPromptAppend,
  loadInstructions,
  type LoadInstructionsParams,
  type LoadInstructionsResult,
} from './system-prompt.js';
import { resolveEnabledBuiltinTools } from './tools/index.js';
import { CompositeToolExecutor } from './tools/composite-executor.js';

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_PROTOCOL = 2;
const KNOWN_COMMAND_TYPES = new Set([
  'init',
  'user-message',
  'cancel',
  'set-auto-compaction',
  'shutdown',
]);
// 500ms buffer over Bash's process-group KILL_GRACE_MS so the SIGTERM ->
// SIGKILL escalation on a stuck Bash child has time to complete before the
// shutdown drain gives up.
const TURN_DRAIN_TIMEOUT_MS = 2500;

/**
 * Upper bound on the restore-boundary compaction's provider round-trip, after
 * which the compaction is abandoned and `ready` is reported anyway.
 *
 * It is needed because `runLoop`'s serial `for await` holds `cancel` and
 * `shutdown` behind the same await that holds `ready`: an unbounded
 * compaction would not merely delay activation, it would make the worker
 * unstoppable while it waited. Unbounded, the exposure is roughly thirty
 * minutes -- the adapter's per-attempt total timeout, retried three times,
 * reachable by a stream that keeps emitting without ever ending.
 *
 * **The 60 s figure is the coincidence of two INDEPENDENT arguments, not one
 * derived from the other:** (a) it is the silence the adapter itself already
 * calls dead (its default idle timeout happens to be the same number), and
 * (b) it is a judgement about how long a user may be made to wait at
 * activation for a distillation they did not ask for. Neither implies the
 * other. If the adapter's idle timeout ever changes, that is not by itself a
 * reason for this constant to follow -- do NOT import one from the other to
 * "keep them in sync".
 *
 * **Named premise -- what this budget does NOT bound.** It bounds the
 * **provider round-trip**, and nothing else. `compact()` also awaits
 * `loadCompactionPrompt()` before that round-trip and
 * `reassembleSystemPrompt()` after it; neither takes a signal, so neither is
 * interrupted here. Both are local filesystem reads and are **assumed
 * prompt** -- the same assumption every other activation-time filesystem read
 * already makes. Threading a signal into only compaction's two reads would be
 * asymmetric theater: if the filesystem hangs, activation has already hung
 * elsewhere for the same reason. The exposure this budget was built against
 * is specific to a provider stream that keeps emitting without ending, which
 * has no filesystem analogue.
 *
 * The claim and the implementation are made to match by narrowing the claim,
 * not by widening the code -- so the guarantee is "one bounded compaction
 * operation", not "activation completes within 60 s no matter what".
 */
const RESTORE_BOUNDARY_COMPACTION_BUDGET_MS = 60_000;

/** IO seam so the loop can be driven by a test harness or the real process. */
export interface LoopIO {
  readCommands(): AsyncIterable<string>;
  writeEvent(event: EmbeddedAgentEvent): void;
  logError(message: string): void;
}

/** MCP client surface: connection plus the executor the loop consumes. */
export interface McpClientLike extends ToolExecutor {
  connect(baseUrl: string, token: string): Promise<void>;
}

/** Injectable construction of the loop's external dependencies. */
export interface LoopFactories {
  createMcpClient(): McpClientLike;
  createAdapter(opts: { baseUrl: string; apiKey?: string }): ProviderAdapter;
  /** Both engines' single instruction-loading seam as of Phase A (#1343)
   * (R1) -- the claude-sdk engine no longer has a separate opt-in-only
   * factory; `loadOptInInstructions` is no longer a member of this interface,
   * which makes the old SDK-arm call path structurally uncallable rather than
   * merely untested (see main.test.ts's polarity pin). */
  loadInstructions(params: LoadInstructionsParams): Promise<LoadInstructionsResult>;
  loadCompactionPrompt: typeof loadCompactionPrompt;
  /** DI seam for tests: the claude-sdk engine's construction (which
   * synchronously calls the real SDK's `query()`), so a test can inject a
   * factory that throws without needing to reach through to `SdkEngine`'s
   * own `queryFn` seam. Defaults to `(deps) => new SdkEngine(deps)`. */
  createSdkEngine(deps: SdkEngineDeps): Engine;
  /** DI seam for the R1 resume pre-flight, which otherwise reads the real
   * `~/.claude` of whoever is running. Defaults to `probeSdkSession`. */
  probeSdkSession(sdkSessionId: string, cwd: string): Promise<SdkSessionProbe>;
  /** Documented test seam: overrides
   * {@link RESTORE_BOUNDARY_COMPACTION_BUDGET_MS} so a test can drive the
   * budget-exceeded path without waiting a real minute. Production never sets
   * it. Same class of seam as `AgentLoopDeps`'s `retryDelaysMs` / `sleep`. */
  restoreBoundaryCompactionBudgetMs?: number;
}

type InitCommand = Extract<v.InferOutput<typeof EmbeddedAgentCommandSchema>, { type: 'init' }>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the embedded-agent command loop. Returns the process exit code.
 * Never throws: fatal conditions emit a `fatal` event (best-effort) and resolve
 * with exit code 1.
 */
export async function runLoop(io: LoopIO, factories: LoopFactories): Promise<number> {
  let loop: Engine | null = null;
  let currentTurn: Promise<void> | null = null;
  let turnActive = false;

  for await (const raw of io.readCommands()) {
    const line = raw.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      io.logError('Malformed JSON on stdin; exiting');
      return EXIT_PROTOCOL;
    }

    const type = (parsed as { type?: unknown }).type;

    // The first accepted command MUST be a valid init.
    if (loop === null) {
      const result = v.safeParse(EmbeddedAgentCommandSchema, parsed);
      if (!result.success || result.output.type !== 'init') {
        io.logError('First stdin message must be a valid init command; exiting');
        return EXIT_PROTOCOL;
      }
      const init = await initializeLoop(io, factories, result.output);
      if (init === null) {
        return EXIT_FATAL;
      }
      loop = init;
      continue;
    }

    // Forward-compat: ignore unknown command types after init.
    if (typeof type !== 'string' || !KNOWN_COMMAND_TYPES.has(type)) {
      io.logError(`Ignoring stdin message with unknown type: ${String(type)}`);
      continue;
    }

    const result = v.safeParse(EmbeddedAgentCommandSchema, parsed);
    if (!result.success) {
      io.logError(`Known command failed schema validation (${type}); exiting`);
      return EXIT_PROTOCOL;
    }
    const command = result.output;

    switch (command.type) {
      case 'init':
        io.logError('Ignoring duplicate init command');
        break;
      case 'user-message': {
        if (turnActive) {
          io.logError('Ignoring user-message received while a turn is active');
          break;
        }
        turnActive = true;
        currentTurn = loop
          .runTurn(command.id, command.text)
          .catch((err) => {
            io.logError(`Turn failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            turnActive = false;
          });
        break;
      }
      case 'set-auto-compaction':
        // Deliberately NOT gated on `turnActive`: the flag is only read at
        // the turn boundary, so recording it mid-turn is safe and means the
        // very next boundary already honours it.
        loop.setAutoCompaction(command.enabled);
        break;
      case 'cancel':
        loop.cancel();
        break;
      case 'shutdown':
        return await gracefulExit(loop, currentTurn);
    }
  }

  // stdin EOF: same as shutdown.
  return await gracefulExit(loop, currentTurn);
}

async function initializeLoop(
  io: LoopIO,
  factories: LoopFactories,
  init: InitCommand,
): Promise<Engine | null> {
  if (init.engine === 'openai-api') {
    const instructions = await factories.loadInstructions({
      cwd: init.context.cwd,
      instructionsList: init.instructions,
    });
    const systemPrompt = assembleSystemPrompt({
      context: init.context,
      instructions,
      definitionSystemPrompt: init.systemPrompt,
    });

    const mcp = factories.createMcpClient();
    let tools: ToolDefinition[];
    let executor: ToolExecutor;
    try {
      await mcp.connect(init.mcp.baseUrl, init.mcp.token);
      const builtins = resolveEnabledBuiltinTools(init.enabledTools);
      const composite = new CompositeToolExecutor({
        mcp,
        builtins,
        ctx: { locationPath: init.context.cwd },
        onNameCollision: (name) =>
          io.logError(`Builtin tool "${name}" collides with an MCP tool of the same name; builtin wins`),
      });
      tools = await composite.listTools();
      // The loop reserves the compaction tool's name for itself and
      // intercepts it by name before dispatch, so an MCP tool published under
      // that name would be permanently unreachable -- and the provider would
      // receive two definitions with one name, which a strict
      // OpenAI-compatible provider can reject. Filtered here, next to the
      // builtin-vs-MCP collision above, because this is where the merged list
      // is produced; the name itself is owned by `AgentLoop` (see
      // compact-tool.ts, which explains why the tool sits outside
      // `enabledTools`).
      tools = tools.filter((t) => {
        if (t.name !== COMPACT_TOOL_NAME) return true;
        io.logError(
          `MCP tool "${COMPACT_TOOL_NAME}" collides with the loop's reserved compaction tool; the reserved tool wins`,
        );
        return false;
      });
      executor = composite;
    } catch (err) {
      const message = `MCP connection failed: ${err instanceof Error ? err.message : String(err)}`;
      io.writeEvent({ v: 1, type: 'fatal', message });
      io.logError(message);
      return null;
    }

    const adapter = factories.createAdapter({
      baseUrl: init.provider.baseUrl,
      apiKey: init.provider.apiKey,
    });

    let restoredConversation = init.restoredConversation;
    if (restoredConversation && restoredConversation.length > 0) {
      const [first, ...rest] = restoredConversation;
      if (first.role === 'system') {
        // The server-side restore reconstruction reads AGENTS.md/instructions
        // AS THE SERVER PROCESS'S OWN OS USER, which silently degrades in
        // multi-user mode (worktree not readable by that user). The loop runs
        // as the REQUESTING user and already computed a
        // correctly-permissioned `systemPrompt` above -- use it instead of the
        // server's placeholder, for both restore shapes (fresh system-prompt
        // seed and the compaction seed pair both start with a system
        // message at index 0).
        restoredConversation = [{ ...first, content: systemPrompt }, ...rest];
      }
    }

    const loop = new AgentLoop({
      adapter,
      model: init.provider.model,
      // agent-surface.md Ruling 3 (#1554): the resolved worker-override,
      // or absent when no override is set for this worker. Pass-through --
      // no local value validation, the provider is the authority.
      ...(init.provider.reasoningEffort !== undefined ? { reasoningEffort: init.provider.reasoningEffort } : {}),
      tools,
      executor,
      emit: (event) => io.writeEvent(event),
      systemPrompt,
      maxToolIterations: init.maxToolIterations,
      restoredConversation,
      // The restore-boundary seed: openai-api arm only, so `init` is narrowed
      // to it by the engine check that already gates this whole branch. Absent when the
      // restored log held no reading -- the loop's estimator fallback stands.
      ...(init.engine === 'openai-api' && init.restoredUsage !== undefined
        ? { restoredUsage: init.restoredUsage }
        : {}),
      compaction: {
        auto: init.compaction.auto,
        contextWindowTokens: init.compaction.contextWindowTokens,
        threshold: init.compaction.threshold,
      },
      reassembleSystemPrompt: async () => {
        const reloadedInstructions = await factories.loadInstructions({
          cwd: init.context.cwd,
          instructionsList: init.instructions,
        });
        return assembleSystemPrompt({
          context: init.context,
          instructions: reloadedInstructions,
          definitionSystemPrompt: init.systemPrompt,
        });
      },
      loadCompactionPrompt: async () => {
        const { content } = await factories.loadCompactionPrompt({ cwd: init.context.cwd });
        return content;
      },
    });

    // Compaction at the restore boundary (#1411): evaluated here, awaited
    // BEFORE `ready`. See docs/design/embedded-agent-worker.md "Compaction at
    // the restore boundary" -- awaiting inside init is by itself what keeps a
    // `user-message` from interleaving, since this function runs inside
    // `runLoop`'s serial `for await` over stdin; and the server hangs both
    // initial-prompt delivery and the restore-info completion flip off
    // `ready`, so gating it makes both fire against the post-compaction
    // conversation.
    //
    // "Before `ready`" means before the compaction FINISHES, never before it
    // SUCCEEDS: `ready` is emitted unconditionally below. A provider that is
    // down at activation must not be able to wedge the worker -- the
    // preserve-on-failure path leaves the conversation intact and the first
    // user turn simply overflows, which is the accepted behaviour when no
    // context window is configured either. The catch enforces that invariant
    // for the residual class `compact()` does not already swallow.
    //
    // The await is BOUNDED rather than raced: `loop.cancel()` aborts the
    // in-flight distillation, which `compact()` already handles through its
    // existing canceled branch (turn-error, conversation untouched), and the
    // await then returns promptly. Racing instead would let `ready` fire
    // while the compaction was mid-splice, reintroducing exactly the
    // interleaving this ordering exists to prevent. A timer that fires in the
    // gap between completion and `clearTimeout` is harmless: `cancel()` is a
    // no-op once no turn is in flight.
    const budgetMs =
      factories.restoreBoundaryCompactionBudgetMs ?? RESTORE_BOUNDARY_COMPACTION_BUDGET_MS;
    const budgetTimer = setTimeout(() => loop.cancel(), budgetMs);
    try {
      await loop.compactAtRestoreBoundaryIfNeeded();
    } catch (err) {
      io.logError(
        `Restore-boundary compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(budgetTimer);
    }

    io.writeEvent({ v: 1, type: 'ready' });
    return loop;
  }

  // SDK Engine Phase 1 (docs/design/embedded-agent-sdk-engine.md §4): the
  // claude-sdk engine talks to MCP and builtin tools entirely differently
  // from the native loop -- it does NOT go through McpToolClient /
  // resolveEnabledBuiltinTools / restore-conversation reconstruction.
  // Transcript Restore reaches this engine as `init.resume` (R1), NOT as
  // `restoredConversation`: the SDK resumes its own session state rather
  // than being handed a reconstruction. `init.restoredConversation`, if
  // present on a claude-sdk init command, is still intentionally
  // ignored/unused here -- the server computes it for the UI's restore-info
  // on both engines, and feeding it to the SDK as well would make two
  // writers of one conversation.
  // SdkEngine's own constructor emits `ready` (via the injected `emit`
  // callback below) synchronously, immediately after starting its
  // background stream consumer -- NEVER gated on the SDK's own system:init
  // handshake. See SdkEngine's constructor comment and
  // docs/design/embedded-agent-sdk-engine.md Appendix A.2's `ready` row for
  // the live-probed finding this decouples from. Unlike the openai-api
  // branch above, this function does not emit `ready` itself for this arm.
  //
  // Instruction loader (Phase A, R1 -- supersedes the §4
  // compatibility matrix's original "opt-in instructions[] only" row): the
  // SDK's own NATIVE settings-derived discovery stays disabled
  // (`settingSources: []`, unchanged by this PR -- see sdk-engine.ts's
  // `buildOptions`), but this engine now calls the SAME `loadInstructions`
  // the openai-api branch above does -- global layer, chain (git-root-to-cwd
  // AGENTS.md/CLAUDE.md), opt-in `instructions[]`, and the `.claude/rules`
  // layer -- loaded here (this function is already async, same shape as the
  // openai-api branch's own `loadInstructions` call above) and composed into
  // the SDK's `systemPrompt.append` alongside the definition system prompt,
  // BEFORE `SdkEngine` is constructed -- `SdkEngine`'s constructor stays
  // fully synchronous (it calls the SDK's own `query()` immediately), so the
  // already-loaded content is passed in as a plain string rather than a file
  // list for the engine to read itself.
  try {
    const instructions = await factories.loadInstructions({
      cwd: init.context.cwd,
      instructionsList: init.instructions,
    });
    const systemPromptAppend = composeSdkSystemPromptAppend(instructions, init.systemPrompt);

    // Transcript Restore, R1: pre-flight the resume id before constructing.
    // A resume the SDK will refuse does not fail at construction -- it fails
    // once a turn is in flight, and takes the user's first message with it.
    // Checking here turns that into a filesystem read (see
    // sdk-session-preflight.ts for why this runs in the subprocess rather
    // than on the server).
    //
    // The probe's `not-found` and `error` both start this session fresh, and
    // the server today keeps the persisted id on both -- only a `refused`
    // resume clears it. They are still reported as DIFFERENT reasons rather
    // than as one "the pre-flight said no", because they assert different
    // things: `not-found` is the SDK saying it could not find the session,
    // `error` is the lookup not running at all. That difference is what the
    // persisted transcript row records, and it is what a future SDK -- one
    // whose store propagates read errors instead of swallowing them -- would
    // need in order to act on the two differently. Flattening them here
    // would make that unrecoverable downstream.
    let resume: string | undefined;
    if (init.resume !== undefined) {
      const requested = init.resume.sdkSessionId;
      const probe = await factories.probeSdkSession(requested, init.context.cwd);
      switch (probe) {
        case 'found':
          resume = requested;
          break;
        case 'not-found':
          io.writeEvent({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: requested, reason: 'not-found' });
          io.logError(`SDK session ${requested} not found at activation; starting a fresh session`);
          break;
        case 'error':
          io.writeEvent({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: requested, reason: 'lookup-failed' });
          io.logError(
            `SDK session ${requested} could not be looked up at activation; starting a fresh session and keeping the id for the next activation`,
          );
          break;
        default: {
          const _exhaustive: never = probe;
          void _exhaustive;
        }
      }
    }

    return factories.createSdkEngine({
      cwd: init.context.cwd,
      model: init.provider.model,
      systemPromptAppend,
      enabledTools: init.enabledTools,
      mcp: init.mcp,
      emit: (event) => io.writeEvent(event),
      autoCompaction: init.compaction.auto,
      // Transcript Restore, R1: the ONLY path by which a resume id reaches
      // the engine. Absent means a fresh session -- a first-ever
      // activation, a worker with no persisted id, or an id the pre-flight
      // above could not find or could not look up.
      ...(resume !== undefined ? { resume } : {}),
      // agent-surface.md Ruling 3 (#1554): the resolved worker-override,
      // or absent when no override is set for this worker.
      ...(init.provider.effort !== undefined ? { effort: init.provider.effort } : {}),
    });
  } catch (err) {
    const message = `SDK engine construction failed: ${err instanceof Error ? err.message : String(err)}`;
    io.writeEvent({ v: 1, type: 'fatal', message });
    io.logError(message);
    return null;
  }
}

async function gracefulExit(
  loop: Engine | null,
  currentTurn: Promise<void> | null,
): Promise<number> {
  if (loop !== null && currentTurn !== null) {
    loop.cancel();
    await Promise.race([currentTurn, delay(TURN_DRAIN_TIMEOUT_MS)]);
  }
  // Releases any resources the engine holds outside process memory (e.g. the
  // SDK engine's Query/child claude process). A no-op for the native engine
  // (dispose is optional on Engine; AgentLoop does not implement it).
  loop?.dispose?.();
  return EXIT_OK;
}

/**
 * The one method this module needs from a stream reader. Deliberately NOT
 * `ReadableStreamDefaultReader<Uint8Array>`: that global type is declared
 * differently by `@types/node`'s `stream/web` augmentation (used implicitly
 * once `"node"` is in a tsconfig's `types`) than by `bun-types`' own
 * augmentation (which adds a `readMany()` member `Bun.stdin.stream()`'s real
 * reader has but a synthetic test `ReadableStream`'s does not) -- pinning
 * this function's parameter to either concrete type makes it reject a
 * reader built from the other. A minimal structural interface accepts both.
 */
interface AsyncByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Reader-loop form, not `for await (... of someStream)`: the same pattern
 * embedded-agent-worker-service.ts's `readStdout` uses for its own
 * `ReadableStream<Uint8Array>`. Avoids depending on `ReadableStream`'s
 * async-iterator typing at all, which packages/integration's DOM-lib
 * tsconfig doesn't declare the same way Bun's lib does -- a `for await`
 * form here stopped typechecking once this file became reachable from a
 * packages/integration test (Phase A's subprocess-boundary integration
 * case), even though nothing about runtime behavior changed. Takes the
 * reader (not the stream) so a test can drive it with a synthetic
 * `ReadableStream` instead of the real `Bun.stdin.stream()`.
 */
export async function* readLinesFromReader(reader: AsyncByteReader): AsyncIterable<string> {
  const splitter = new NdjsonLineSplitter();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const { lines } = splitter.push(decoder.decode(value, { stream: true }));
    for (const line of lines) yield line;
  }
  const tail = splitter.carry;
  if (tail.length > 0) yield tail;
}

function readStdinLines(): AsyncIterable<string> {
  return readLinesFromReader(Bun.stdin.stream().getReader());
}

function writeEvent(event: EmbeddedAgentEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (import.meta.main) {
  const io: LoopIO = {
    readCommands: readStdinLines,
    writeEvent,
    logError: (message) => console.error(message),
  };
  const factories: LoopFactories = {
    createMcpClient: () => new McpToolClient(),
    createAdapter: (opts) => new OpenAIChatAdapter(opts),
    loadInstructions,
    loadCompactionPrompt,
    createSdkEngine: (deps) => new SdkEngine(deps),
    probeSdkSession,
  };
  runLoop(io, factories)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_FATAL);
    });
}
