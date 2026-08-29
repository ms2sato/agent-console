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
import { sdkSessionExists } from './sdk-session-preflight.js';
import {
  assembleSystemPrompt,
  composeSdkSystemPromptAppend,
  loadInstructions,
  loadOptInInstructions,
  type InstructionSegment,
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
  loadInstructions(params: LoadInstructionsParams): Promise<LoadInstructionsResult>;
  /** DI seam for the claude-sdk engine's opt-in `instructions[]` layer only
   * (no AGENTS.md/CLAUDE.md auto-discovery -- see system-prompt.ts's
   * `loadOptInInstructions` doc comment). Defaults to `loadOptInInstructions`. */
  loadOptInInstructions(
    cwd: string,
    instructionsList: string[] | undefined,
  ): Promise<InstructionSegment[]>;
  loadCompactionPrompt: typeof loadCompactionPrompt;
  /** DI seam for tests: the claude-sdk engine's construction (which
   * synchronously calls the real SDK's `query()`), so a test can inject a
   * factory that throws without needing to reach through to `SdkEngine`'s
   * own `queryFn` seam. Defaults to `(deps) => new SdkEngine(deps)`. */
  createSdkEngine(deps: SdkEngineDeps): Engine;
  /** DI seam for the R1 resume pre-flight, which otherwise reads the real
   * `~/.claude` of whoever is running. Defaults to `sdkSessionExists`. */
  sdkSessionExists(sdkSessionId: string, cwd: string): Promise<boolean>;
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
      tools,
      executor,
      emit: (event) => io.writeEvent(event),
      systemPrompt,
      maxToolIterations: init.maxToolIterations,
      restoredConversation,
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
  // Instruction loader (§4's compatibility matrix, corrected): the SDK's own
  // AGENTS.md/CLAUDE.md auto-discovery is deliberately disabled (never runs
  // for this engine -- see the design doc's corrected row). Only the
  // definition's explicit opt-in `instructions[]` list is honored, loaded
  // here (this function is already async, same shape as the openai-api
  // branch's own `loadInstructions` call above) and composed into the SDK's
  // `systemPrompt.append` alongside the definition system prompt, BEFORE
  // `SdkEngine` is constructed -- `SdkEngine`'s constructor stays fully
  // synchronous (it calls the SDK's own `query()` immediately), so the
  // already-loaded content is passed in as a plain string rather than a file
  // list for the engine to read itself.
  try {
    const optInSegments = await factories.loadOptInInstructions(init.context.cwd, init.instructions);
    const systemPromptAppend = composeSdkSystemPromptAppend(optInSegments, init.systemPrompt);

    // Transcript Restore, R1: pre-flight the resume id before constructing.
    // A resume the SDK will refuse does not fail at construction -- it fails
    // once a turn is in flight, and takes the user's first message with it.
    // Checking here turns that into a filesystem read (see
    // sdk-session-preflight.ts for why this runs in the subprocess rather
    // than on the server). A miss starts fresh and says so; the resume is
    // never retried.
    let resume: string | undefined;
    if (init.resume !== undefined) {
      const requested = init.resume.sdkSessionId;
      if (await factories.sdkSessionExists(requested, init.context.cwd)) {
        resume = requested;
      } else {
        io.writeEvent({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: requested, reason: 'not-found' });
        io.logError(`SDK session ${requested} not found at activation; starting a fresh session`);
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
      // above could not find.
      ...(resume !== undefined ? { resume } : {}),
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

async function* readStdinLines(): AsyncIterable<string> {
  const splitter = new NdjsonLineSplitter();
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const { lines } = splitter.push(decoder.decode(chunk, { stream: true }));
    for (const line of lines) yield line;
  }
  const tail = splitter.carry;
  if (tail.length > 0) yield tail;
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
    loadOptInInstructions,
    loadCompactionPrompt,
    createSdkEngine: (deps) => new SdkEngine(deps),
    sdkSessionExists,
  };
  runLoop(io, factories)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_FATAL);
    });
}
